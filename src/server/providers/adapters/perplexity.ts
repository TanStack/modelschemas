/**
 * Perplexity — public OpenAPI 3.1 spec at docs.perplexity.ai/openapi.json.
 * Generation is Sonar (`/v1/sonar`) and the Agent API (`/v1/agent`), plus
 * embeddings. Search, async jobs, files/cancel, and analytics are platform.
 */
import type { Activity } from '#/db/schema.ts'
import { perplexityListingCard } from '../catalog-prices.ts'
import {
  cachedDocs,
  docsReport,
  docsRun,
  markdownTableRows,
  tokenCount,
  tryDocs,
  unavailable,
} from '../model-facts.ts'
import {
  fetchJson,
  fetchOpenApi,
  fetchText,
  sha256Text,
  skippedResult,
} from '../types.ts'
import { bearerConnect } from '../connect.ts'
import type {
  FactSource,
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'
import { namespacedUpstreamIdentity } from '../upstream-model.ts'

const PERPLEXITY_OPENAPI_URL = 'https://docs.perplexity.ai/openapi.json'
const PERPLEXITY_MODELS_URL = 'https://api.perplexity.ai/v1/models'
const PERPLEXITY_MODELS_DOC_URL =
  'https://docs.perplexity.ai/docs/agent-api/models.md'
const PERPLEXITY_EFFORT_DOC_URL =
  'https://docs.perplexity.ai/docs/agent-api/effort.md'
const FETCH_TIMEOUT_MS = 20_000

function classify(path: string): Activity | null {
  if (path === '/v1/sonar' || path === '/v1/agent') return 'chat'
  if (path === '/v1/embeddings' || path === '/v1/contextualizedembeddings') {
    return 'embeddings'
  }
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(PERPLEXITY_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: PERPLEXITY_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

/** Model id → the capability flags one docs page states for it. */
type StatedFlags = Map<string, Array<string>>

/** A reasoning card's "N-token context window and up to N output tokens". */
interface StatedLimits {
  contextWindow: number
  maxOutput: number | null
}

function addFlags(out: StatedFlags, id: string, flags: Array<string>): void {
  out.set(id, [...new Set([...(out.get(id) ?? []), ...flags])])
}

/**
 * The markdown export renders cards, callouts and accordions as `>`
 * blockquotes; unquoted, their sentences and bullets start the line.
 */
function unquote(text: string): string {
  return text.replace(/^> ?/gm, '')
}

/**
 * Flags the Agent API models page states, per model id. Under "Available
 * Models" each provider tab is one `> [tab] Title` blockquote (the
 * markdown export's shape since 2026-10-30) holding a `> [card] Title`
 * card, a model table and, for some, `> [!NOTE]`/`> [!WARNING]` callouts.
 * A tab with no card, a second card, any other blockquote in a tab, a
 * table or card outside a tab, or any block between or after the tabs
 * throws.
 *
 * - "Kimi K3 accepts `minimal`, … and `max` reasoning effort." gives
 *   `reasoning` and `reasoning_effort` to the row whose link text is the
 *   name, and its list is the row's `efforts`. A list that holds `none`
 *   or `off` says reasoning can be turned off; any other list leaves
 *   `mandatory` null.
 * - A card sentence that ends "… reasoning model(s)." or "… reasoning model
 *   with a N-token context window[ and up to N output tokens]." gives
 *   `reasoning` to every row of its tab, and only when it names as many
 *   models as the tab lists. Its context window and output tokens, when
 *   stated, are those rows' `contextWindow` and `maxOutput` (#408). The
 *   card's other sentences are not read, so
 *   one speaking of reasoning or thinking throws.
 *
 * Any other wording of either statement throws, as does an effort sentence
 * outside the tabs or a second one for the same model. So does tab prose
 * that speaks of turning reasoning off ("cannot be disabled", "always on"):
 * no such sentence is on the page today, and one must be read, not dropped.
 */
export function parsePerplexityModelsPage(markdown: string): {
  flags: StatedFlags
  efforts: Map<string, Array<string>>
  limits: Map<string, StatedLimits>
} {
  const stated: StatedFlags = new Map()
  const levels = new Map<string, Array<string>>()
  const limits = new Map<string, StatedLimits>()
  const unread = (what: string) =>
    new Error(`perplexity: models page states ${what} in an unread shape`)
  let rows = 0
  let sentences = 0
  const section = /^## Available Models\n([^]*?)(?=^## |(?![^]))/m.exec(
    markdown,
  )?.[1]
  let tabs = 0
  for (const block of (section ?? '').trim().split(/\n\n+/)) {
    const [, title, quotedTab] =
      /^> \[tab\] ([^\n]+)\n>\n((?:>.*(?:\n|$))+)$/.exec(block) ?? []
    if (title === undefined || quotedTab === undefined) {
      // Prose and callouts before the first tab are the section's intro.
      // Anything between or after tabs would be unread tab content.
      if (tabs > 0 || /^(?:> ?)*(?:\||\[(?:tab|card)\])/m.test(block)) {
        throw unread('a tab with no title')
      }
      continue
    }
    tabs += 1
    // The tab's body with its own quote level removed; its card and
    // callouts are still quoted.
    const chunk = unquote(quotedTab)
    const tab = unquote(chunk)
    const table = markdownTableRows(tab).filter((row) =>
      /^`[^`]+`$/.test(row[0] ?? ''),
    )
    const ids = table.map((row) => (row[0] ?? '').slice(1, -1))
    rows += ids.length

    // Blank-line-separated blocks: the one card, then only callouts quote.
    const quotes = chunk.split(/\n\n+/).filter((b) => b.startsWith('>'))
    const cards = quotes.filter((b) => !b.startsWith('> [!'))
    const quoted = /^> \[card\] ([^\n]+)\n>\n((?:>.*(?:\n|$))+)$/.exec(
      cards[0] ?? '',
    )
    if (cards.length !== 1 || !quoted) throw unread('a card')
    if (quoted[1] !== title) throw unread('a card for another tab')
    const card = unquote(quoted[2] ?? '').trim()
    if (/reasoning models?\b/i.test(card)) {
      const parts = card.split(/(?<=\.)\s+/)
      const said = parts.filter((s) => /reasoning models?\b/i.test(s))
      const rest = parts.filter((s) => !said.includes(s))
      const sentence =
        said.length === 1 && !rest.some((s) => /reason|think/i.test(s))
          ? /^(.+?) (?:—|is) .*\breasoning models?(?: with an? ([\d,]+)-token context window(?: and up to ([\d,]+) output tokens)?)?\.$/.exec(
              said[0] ?? '',
            )
          : null
      const subject = sentence?.[1] ?? ''
      const names = subject.split(/, and |, | and /)
      if (
        subject === '' ||
        names.length !== ids.length ||
        /\b(?:not|no|non)\b/i.test(card)
      ) {
        throw unread('a reasoning model')
      }
      const contextWindow = tokenCount(sentence?.[2])
      const maxOutput = tokenCount(sentence?.[3])
      for (const id of ids) {
        addFlags(stated, id, ['reasoning'])
        // The sentence's limits belong to the models it names: every row
        // of this tab, as checked above.
        if (contextWindow !== null) limits.set(id, { contextWindow, maxOutput })
      }
    }

    const efforts = [
      ...tab.matchAll(
        /^(\S.*?) accepts ((?:`[a-z]+`(?:, and |, | and )?)+) reasoning effort\./gm,
      ),
    ]
    sentences += efforts.length
    const prose = tab.split('\n').filter((line) => !line.startsWith('|'))
    if (
      prose.some(
        (line) =>
          /reasoning|thinking/i.test(line) &&
          /disabl|always[- ]on|(?:turn|switch)\w* off|cannot be|can['’]t be/i.test(
            line,
          ),
      )
    ) {
      throw unread('whether reasoning can be turned off')
    }
    const seen = new Set<string>()
    for (const [, name, list] of efforts) {
      const named = table.filter((cells) =>
        cells.at(-1)?.startsWith(`[${name ?? ''}](`),
      )
      const id = named.length === 1 ? named[0]?.[0]?.slice(1, -1) : undefined
      if (!id || seen.has(id)) throw unread('reasoning effort')
      seen.add(id)
      addFlags(stated, id, ['reasoning', 'reasoning_effort'])
      levels.set(id, (list ?? '').match(/(?<=`)[a-z]+(?=`)/g) ?? [])
    }
  }
  if (rows === 0) throw new Error('perplexity: models page lists no models')
  if (sentences !== (markdown.match(/reasoning effort/gi) ?? []).length) {
    throw unread('reasoning effort')
  }
  return { flags: stated, efforts: levels, limits }
}

/**
 * Flags the effort page (named "presets" before 2026-10-22) states in its
 * "current effort level values" accordions: each effort level names its
 * model, the `reasoning.effort` it sends, and its tools, except a level
 * that says it has no frozen configuration, which states no Model bullet. The title
 * separator is an em dash, or a colon (`ultra` since 2026-10-29). A model a
 * level runs with an effort takes `reasoning.effort`; one it runs with
 * tools takes `tools`. The page says nothing of `tool_choice`. A level's
 * fallback model gets no flags: the frozen request sends it the level's
 * settings, but the page never says the fallback accepts them.
 */
export function parsePerplexityEffortLevels(markdown: string): StatedFlags {
  const stated: StatedFlags = new Map()
  // Each accordion is one `> [accordion] name — current effort level values`
  // blockquote (the markdown export's shape since 2026-10-30). `ultra`
  // titles the same block with a colon and no space before it. They run
  // back to back up to the next unquoted `## ` heading (the prompts' own
  // `## ` headings stay inside the quote). Any other block in that run, or
  // a blank line splitting an accordion, throws.
  const start = markdown.search(
    /^> \[accordion\] [^\n]*current effort level values/m,
  )
  const run = start < 0 ? '' : (markdown.slice(start).split(/^## /m)[0] ?? '')
  for (const block of run === '' ? [] : run.trim().split(/\n\n+/)) {
    const [, level, quoted] =
      /^> \[accordion\] ([^\s:—]+)(?: — |: )current effort level values\n((?:>.*(?:\n|$))*)$/.exec(
        block,
      ) ?? []
    if (level === undefined || quoted === undefined) {
      throw new Error(
        'perplexity: effort level accordion is in an unread shape',
      )
    }
    const body = unquote(quoted)
    const bullet = (label: string): string | null => {
      const lines = [
        ...body.matchAll(new RegExp(`^\\* \\*\\*${label}:\\*\\* (.*)$`, 'gm')),
      ]
      if (lines.length > 1) {
        throw new Error(`perplexity: effort level states ${label} twice`)
      }
      return lines[0]?.[1] ?? null
    }
    const effort = bullet('Reasoning effort')
    const tools = bullet('Tools')
    const single = bullet('Model')
    const several = bullet('Models')
    // `Models:` names the level's model, then the fallback the request
    // carries. Only the first is the model the level is stated to run on.
    const model =
      single !== null && several !== null
        ? undefined
        : single !== null
          ? /^`([^`\s]+)`$/.exec(single)?.[1]
          : /^`([^`\s]+)`, with `[^`\s]+` as the \[fallback model\]\([^)\s]+\)$/.exec(
              several ?? '',
            )?.[1]
    if (!model) {
      // A level that says it has no frozen configuration (`ultra-preview`)
      // names no model. Any bullet on it is a setting this does not read.
      if (
        !/^\* \*\*/m.test(body) &&
        body.includes(`\`${level}\` has no frozen configuration.`)
      ) {
        continue
      }
      throw new Error('perplexity: effort level names no model')
    }
    if (effort !== null) {
      if (!/^`[a-z]+`$/.test(effort)) {
        throw new Error(
          "perplexity: effort level's reasoning effort is in an unread shape",
        )
      }
      addFlags(stated, model, ['reasoning', 'reasoning_effort'])
    }
    if (tools !== null) {
      if (!/^`[a-z_]+`/.test(tools)) {
        throw new Error('perplexity: effort level tools are in an unread shape')
      }
      addFlags(stated, model, ['tools'])
    }
  }
  if (stated.size === 0) {
    throw new Error('perplexity: effort page lists no effort levels')
  }
  return stated
}

interface StatedDoc {
  hash: string
  flags: Array<[string, Array<string>]>
  /** Absent on the effort page, and on an entry cached before efforts were kept. */
  efforts?: Array<[string, Array<string>]>
  /** Absent on the effort page, and on an entry cached before limits were kept. */
  limits?: Array<[string, StatedLimits]>
}

function statedDoc(
  kv: KVNamespace | undefined,
  url: string,
  parse: (markdown: string) => {
    flags: StatedFlags
    efforts?: Map<string, Array<string>>
    limits?: Map<string, StatedLimits>
  },
): Promise<StatedDoc> {
  return cachedDocs(kv, url, async () => {
    const text = await fetchText(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const { flags, efforts, limits } = parse(text)
    return {
      hash: await sha256Text(text),
      flags: [...flags],
      ...(efforts ? { efforts: [...efforts] } : {}),
      ...(limits ? { limits: [...limits] } : {}),
    }
  })
}

/**
 * The flags both pages state for one model, each with its page, and the
 * effort list the models page states for it.
 */
function statedFacts(
  id: string,
  docs: Array<{ url: string; doc: StatedDoc }>,
): Pick<
  ModelInfo,
  'capabilities' | 'reasoning' | 'contextWindow' | 'maxOutput' | 'factSources'
> {
  const sources: Record<string, FactSource> = {}
  let reasoning: Pick<ModelInfo, 'reasoning' | 'factSources'> = {}
  for (const { url, doc } of docs) {
    const efforts = new Map(doc.efforts).get(id)
    if (efforts) {
      reasoning = {
        reasoning: {
          mode: 'effort',
          // The sentence is this model's own list: an off value in it is a
          // statement. Without one the page does not say.
          mandatory: efforts.some((e) => e === 'none' || e === 'off')
            ? false
            : null,
          efforts,
        },
        factSources: {
          reasoning: {
            derivation: 'docs-derived',
            sourceUrl: url,
            sourceHash: doc.hash,
            path: 'reasoning_effort',
          },
        },
      }
    }
    for (const flag of new Map(doc.flags).get(id) ?? []) {
      sources[flag] ??= {
        derivation: 'docs-derived',
        sourceUrl: url,
        sourceHash: doc.hash,
        path: flag,
      }
    }
  }
  const limited = docs.flatMap(({ url, doc }) => {
    const stated = new Map(doc.limits).get(id)
    return stated ? [{ url, hash: doc.hash, ...stated }] : []
  })[0]
  const limitSource = (path: string): FactSource => ({
    derivation: 'docs-derived',
    sourceUrl: limited?.url,
    sourceHash: limited?.hash,
    path,
  })
  const limits: Pick<ModelInfo, 'contextWindow' | 'maxOutput' | 'factSources'> =
    limited
      ? {
          contextWindow: limited.contextWindow,
          maxOutput: limited.maxOutput,
          factSources: {
            contextWindow: limitSource('contextWindow'),
            ...(limited.maxOutput !== null
              ? { maxOutput: limitSource('maxOutput') }
              : {}),
          },
        }
      : {}
  const capabilities = Object.keys(sources)
  if (capabilities.length === 0) return limits
  return {
    capabilities,
    ...reasoning,
    ...limits,
    factSources: {
      ...reasoning.factSources,
      ...limits.factSources,
      capabilities: sources,
    },
  }
}

type StatedFact = Exclude<keyof ReturnType<typeof statedFacts>, 'factSources'>

/**
 * Every fact `statedFacts` supplies; all are withheld when a page fails.
 * Keyed by its return type, so a fact added there fails to compile here
 * instead of going null on a docs failure.
 */
const STATED_FACTS: Record<StatedFact, true> = {
  capabilities: true,
  reasoning: true,
  contextWindow: true,
  maxOutput: true,
}

interface PerplexityModelList {
  data?: Array<{ id: string; created?: number; pricing?: unknown }>
}

async function listModels(
  env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const key = env.PERPLEXITY_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('perplexity', 'PERPLEXITY_API_KEY') }
  }
  const run = docsRun()
  const [body, modelsPage, effortPage] = await Promise.all([
    fetchJson(PERPLEXITY_MODELS_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }) as Promise<PerplexityModelList>,
    tryDocs(run, PERPLEXITY_MODELS_DOC_URL, () =>
      statedDoc(kv, PERPLEXITY_MODELS_DOC_URL, parsePerplexityModelsPage),
    ),
    tryDocs(run, PERPLEXITY_EFFORT_DOC_URL, () =>
      statedDoc(kv, PERPLEXITY_EFFORT_DOC_URL, (text) => ({
        flags: parsePerplexityEffortLevels(text),
      })),
    ),
  ])
  // Both pages or neither: one page's flags alone would drop the other's.
  const docs =
    modelsPage && effortPage
      ? [
          { url: PERPLEXITY_MODELS_DOC_URL, doc: modelsPage },
          { url: PERPLEXITY_EFFORT_DOC_URL, doc: effortPage },
        ]
      : null
  const models: Array<ModelInfo> = []
  for (const m of body.data ?? []) {
    const pricing = await perplexityListingCard(
      m.pricing,
      PERPLEXITY_MODELS_URL,
    )
    models.push({
      rawId: m.id,
      releasedAt: m.created ?? null,
      activity: 'chat' as const,
      ...(pricing ? { pricing } : {}),
      ...(docs
        ? statedFacts(m.id, docs)
        : unavailable(...(Object.keys(STATED_FACTS) as Array<StatedFact>))),
    })
  }
  return { models, docsFailures: docsReport(run) }
}

export const provider: ProviderConfig = {
  id: 'perplexity',
  // The listing names the maker in the id's namespace, and `owned_by`
  // repeats it on every row. A `perplexity/…` id is hosted by Perplexity
  // and the listing names no maker for it. The models page does, as the
  // title of the tab the row sits in (`Z.AI`, `Moonshot AI`, `NVIDIA`):
  // that is not readable from an id, so those rows carry no evidence.
  upstreamModelIdentity: (rawId) =>
    rawId.startsWith('perplexity/')
      ? null
      : namespacedUpstreamIdentity(rawId, {
          derivation: 'listing',
          sourceUrl: PERPLEXITY_MODELS_URL,
          path: 'data[].id',
        }),
  displayName: 'Perplexity',
  authEnvVar: 'PERPLEXITY_API_KEY',
  specSourceUrl: PERPLEXITY_OPENAPI_URL,
  modelsEndpoint: PERPLEXITY_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  connect: bearerConnect('https://api.perplexity.ai'),
  fetchSpec,
  listModels,
  classify,
  // /v1/models lists Agent API ids; /v1/sonar answers 400 "Invalid model"
  // to `perplexity/sonar` and its spec enum holds only the bare Sonar ids.
  generationEndpointId: () => 'v1/agent',
  // "Not all third-party models support all features (e.g., reasoning,
  // tools)" — docs.perplexity.ai/docs/agent-api/models. These four are the
  // flags that sentence names; a row gets one back only from a docs page
  // that states it. Of the flags the walk keeps, only `max_tokens` is
  // stated as shared ("a shared Agent API parameter"). `temperature`,
  // `top_p`, `response_format` and `structured_outputs` are kept on
  // judgement: the sentence's "e.g." is open-ended and does not name them.
  perModelSchemaFlags: [
    'reasoning',
    'reasoning_effort',
    'tools',
    'tool_choice',
  ],
}
