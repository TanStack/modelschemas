import {
  OPENAI_REALTIME_EFFORT_URL,
  openaiRealtimeEfforts,
  openaiRealtimeSelects,
} from './openai-realtime-efforts.ts'
/**
 * OpenAI model facts from OpenAI's own docs. `GET /v1/models` is `id` +
 * `created` only; developers.openai.com serves every model page as
 * markdown (`/api/docs/models/{slug}.md`) with a fixed "Model details"
 * bullet list, a "Supported features" list, and the page's snapshot ids. The index (`/api/docs/models/all.md`) is the
 * slug list: `/api/docs/models.md` lists only current models since
 * 2026-11-03 (#570), and older listed ids lost their pages (and prices). Only pages the listed ids resolve to are fetched (~65 of the
 * ~130 listed ids share a page), bounded-concurrency, memoised six hours.
 */
import { compileTokenCard, compileUnitCard } from '@modelschemas/rate-card'
import type { TokenRateTier, UnitCardSpec } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import {
  NO_FACTS,
  assertParsed,
  docsRun,
  mapConcurrent,
  markdownSection,
  markdownTableRows,
  parseDay,
  tokenCount,
  tryDocs,
  unavailable,
  undatedId,
} from './model-facts.ts'
import type { DocsRun, ModelFacts } from './model-facts.ts'
import {
  OPENAI_GPT51_GUIDE_URL,
  OPENAI_GPT52_GUIDE_URL,
  OPENAI_GPT5_GUIDE_URL,
  loadGuide,
  parseGpt51NoneGuide,
  parseGpt52SamplingGuide,
  parseGpt5FamilyGuide,
} from './openai-gpt5-guides.ts'
import { fetchText, sha256Text } from './types.ts'
import type { FactSource, ModelInfo, ModelReasoning } from './types.ts'
import type { Fetcher } from './us-egress.ts'

export const OPENAI_MODELS_INDEX_URL =
  'https://developers.openai.com/api/docs/models/all.md'
export const OPENAI_PRICING_URL =
  'https://developers.openai.com/api/docs/pricing.md'
export const OPENAI_MODEL_PAGE = (slug: string) =>
  `https://developers.openai.com/api/docs/models/${slug}.md`

/** Page slugs linked from the models index. */
export function parseModelIndex(markdown: string): Set<string> {
  return new Set(
    [
      ...markdown.matchAll(/\]\(\/api\/docs\/models\/([^)\s]+?)\.md\)/g),
    ].flatMap((m) => (m[1] ? [m[1]] : [])),
  )
}

export interface OpenAiModelPage {
  /** Every id the page speaks for: `Model ID`, default snapshot, snapshots. */
  ids: Array<string>
  /**
   * Ids the page's price belongs to: the model id and its default snapshot.
   * An older dated snapshot keeps the page's other facts but not this price.
   */
  pricedIds: Array<string>
  facts: ModelFacts
  /** Token rates and tiers, or null when the page prices otherwise. */
  pricing: DocsPricing | null
}

/**
 * Pricing subsection → the lever each `Metric` row prices. Every other
 * subsection (image/video generation, audio duration, a per-call tool fee)
 * refuses the whole model: a card quoting only its token rows would
 * understate the bill. Unknown means null, never a partial card.
 */
const PRICING_LEVERS: Record<string, Record<string, string>> = {
  'Text tokens': {
    Input: 'input_tokens',
    'Cached input': 'cache_read_tokens',
    'Cache writes': 'cache_write_tokens',
    Output: 'output_tokens',
  },
  'Audio tokens': {
    Input: 'audio_tokens',
    'Cached input': 'audio_cache_tokens',
    Output: 'audio_output_tokens',
  },
  'Image tokens': {
    Input: 'image_tokens',
    'Cached input': 'image_cache_tokens',
    Output: 'image_output_tokens',
  },
  Embeddings: { Cost: 'input_tokens' },
}

/**
 * Sections priced per unit rather than per token. `Pricing` is the legacy
 * tts/whisper table, whose `Cost` row carries the unit.
 */
const UNIT_SECTIONS = new Set([
  'Realtime audio duration',
  'Transcription audio duration',
  'Live session duration',
  'Video generation',
  'Pricing',
])

/**
 * Sections that restate a token price per unit rather than adding a cost.
 * OpenAI's image models bill by tokens ("Prices per 1M tokens" on the
 * pricing page); the per-image table is the equivalent cost of one image at
 * a quality and size, already covered by the Image tokens rows.
 */
const DERIVED_SECTIONS = new Set(['Image generation'])

const DAY_MS = 86_400_000

/** `$1.25` → 1.25; null for anything that is not a plain dollar amount. */
function usd(cell: string | undefined): number | null {
  const amount = cell?.match(/^\$([\d,]+(?:\.\d+)?)$/)?.[1]
  return amount === undefined ? null : Number(amount.replace(/,/g, ''))
}

/**
 * Prose under the tables that changes the price. A bullet naming a
 * non-default service tier, an opt-in endpoint or nothing billable is
 * prose; anything else that quotes a multiplier or an amount refuses the
 * model, so a new kind of surcharge cannot slip past as prose.
 */
const PROSE_BULLETS =
  /\bbatch\b|\bflex\b|fast mode|priority|regional processing|data residency|calculator|does not offer|not billed|rather than text tokens|token rates match/i

/** Levers a "…x input and cache rates" multiplier re-quotes. */
const INPUT_LEVERS = [
  'input_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'image_tokens',
  'image_cache_tokens',
  'audio_tokens',
  'audio_cache_tokens',
]
const OUTPUT_LEVERS = [
  'output_tokens',
  'image_output_tokens',
  'audio_output_tokens',
]

export interface DocsPricing {
  rates: Record<string, number>
  tiers: Array<TokenRateTier>
  /** Promo end the page names, as an ISO instant. */
  expiresAt?: string
  /** Set instead of `rates` when the model is billed per unit. */
  unit?: UnitCardSpec
}

/** Unit a price is quoted in → the lever it bills, and units per quote. */
const UNITS: Record<string, { param: string; per: number }> = {
  minute: { param: 'audio_seconds', per: 60 },
  second: { param: 'seconds', per: 1 },
  '1M characters': { param: 'characters', per: 1e6 },
}

/**
 * A per-unit section: one rate, or one per output size. The metric cell of
 * a video row names the sizes the rate covers ("Portrait: 720x1280
 * Landscape: 1280x720"), which are `size` values on the request.
 */
function parseUnitSection(block: string): UnitCardSpec | null {
  const rates: Record<string, number> = {}
  let flat: number | null = null
  let unit: { param: string; per: number } | undefined
  for (const [metric = '', price, cell] of markdownTableRows(block)) {
    if (metric === 'Metric') continue
    const rate = usd(price)
    const found = cell === undefined ? undefined : UNITS[cell]
    // "Use case | Speech generation | 1M tokens" labels the table, and a
    // row this parser cannot price at all refuses the model.
    if (rate === null) {
      if (metric === 'Use case' || metric === 'Quality') continue
      return null
    }
    if (!found) return null
    if (unit && unit.param !== found.param) return null
    unit = found
    const sizes = [...metric.matchAll(/(\d{3,4}x\d{3,4})/g)].map(
      ([size]) => size,
    )
    if (sizes.length === 0) {
      if (flat !== null) return null
      flat = rate / found.per
      continue
    }
    for (const size of sizes) rates[size] = rate / found.per
  }
  if (!unit) return null
  const sized = Object.keys(rates).length > 0
  if (sized && flat !== null) return null
  if (!sized && flat === null) return null
  // Duration and characters are measured after the call; a video's length
  // and size are fields of the request that asked for it.
  const bound = unit.param === 'seconds' ? 'request' : 'usage'
  return {
    quantity: { param: unit.param, bound },
    ...(sized && {
      keys: [{ param: 'size', values: Object.keys(rates) }],
    }),
    rates: sized ? rates : (flat ?? 0),
  }
}

/**
 * Search rows on the pricing page's Specialized models Standard table
 * (issue #111). `gpt-5-search-api` has no model page. Embeddings,
 * moderation, and other categories are not read here. The Fast table
 * further down is a different tier, so it is not part of this card.
 * A dash cached-input cell is an unpublished lever, not $0.
 */
export function parseOpenAiSearchPricing(
  markdown: string,
): Map<string, Record<string, number>> {
  const start = markdown.indexOf('Specialized models')
  const out = new Map<string, Record<string, number>>()
  if (start < 0) return out
  const rest = markdown.slice(start)
  const fastAt = rest.search(/\nFast\b/)
  const standard = fastAt < 0 ? rest : rest.slice(0, fastAt)
  for (const [
    category = '',
    model = '',
    input,
    cached,
    output,
  ] of markdownTableRows(standard)) {
    if (category !== 'Search' || model === '' || out.has(model)) continue
    const inputUsd = usd(input)
    const outputUsd = usd(output)
    if (inputUsd === null || outputUsd === null) continue
    const rates: Record<string, number> = {
      input_tokens: inputUsd / 1e6,
      output_tokens: outputUsd / 1e6,
    }
    if (cached !== undefined && cached !== '-' && cached !== '') {
      const cachedUsd = usd(cached)
      if (cachedUsd === null) continue
      rates.cache_read_tokens = cachedUsd / 1e6
    }
    out.set(model, rates)
  }
  return out
}

/**
 * Per-token rates, long-prompt tiers and promo end from a model page's
 * `## Pricing` section.
 */
export function parseModelPricing(markdown: string): DocsPricing | null {
  const pricing = markdownSection(markdown, 'Pricing')
  const rates: Record<string, number> = {}
  const blocks = pricing.split('\n### ').slice(1)
  // o3.md repeats `### Text tokens`: the first table is standard, the second
  // is the half-price batch/flex table with no heading of its own. A later
  // copy of a heading already priced is not the base rate, so it is dropped
  // rather than overwriting it. Prompt-length tiers stay a separate shape.
  const pricedHeadings = new Set<string>()
  for (const block of blocks) {
    const heading = block.split('\n')[0]?.trim() ?? ''
    if (DERIVED_SECTIONS.has(heading)) continue
    if (pricedHeadings.has(heading)) continue
    pricedHeadings.add(heading)
    if (UNIT_SECTIONS.has(heading)) {
      // A model is billed one way: a page mixing token tables with a
      // per-unit one is a shape this parser does not know.
      if (blocks.length !== 1) return null
      const unit = parseUnitSection(block)
      return unit ? { rates: {}, tiers: [], unit } : null
    }
    const levers = PRICING_LEVERS[heading]
    if (!levers) return null
    for (const [metric = '', price, unit] of markdownTableRows(block)) {
      if (metric === 'Metric') continue
      const lever = levers[metric]
      const rate = usd(price)
      if (!lever || rate === null || unit !== '1M tokens') return null
      rates[lever] = rate / 1e6
    }
  }
  if (Object.keys(rates).length === 0) return null

  const bullets = [...pricing.matchAll(/^- (.+)$/gm)].map(
    ([, bullet = '']) => bullet,
  )
  const out: DocsPricing = { rates, tiers: [] }

  // Rate-adding bullets first: a tier re-quotes whatever levers exist.
  for (const bullet of bullets) {
    // "Cache writes are billed at 1.25x the uncached input token rate."
    const cacheWrite = bullet.match(
      /cache writes are billed at ([\d.]+)x the uncached input token rate/i,
    )
    const input = rates.input_tokens
    if (
      cacheWrite?.[1] &&
      input !== undefined &&
      !('cache_write_tokens' in rates)
    ) {
      rates.cache_write_tokens = input * Number(cacheWrite[1])
    }
    // "…promotional pricing is available at least through November 21, 2026."
    const promo = bullet.match(
      /promotional pricing[^.]*through ([a-z]+ \d{1,2}, \d{4})/i,
    )
    if (promo?.[1]) {
      const day = parseDay(promo[1])
      if (day === null) return null
      out.expiresAt = new Date(day + DAY_MS).toISOString()
    }
  }

  for (const bullet of bullets) {
    if (/cache writes are billed at|promotional pricing/i.test(bullet)) continue
    // "Cached input tokens are priced at 10% of the uncached input token
    // rate." GPT-6 Luna and Sol restate the Cached input row. A percentage
    // that does not match that row is a different price, so the page refuses.
    const cacheRead = bullet.match(
      /cached input tokens are priced at ([\d.]+)% of the uncached input token rate/i,
    )
    if (cacheRead?.[1]) {
      const input = rates.input_tokens
      const factor = Number(cacheRead[1]) / 100
      if (input === undefined || !Number.isFinite(factor)) return null
      const expected = input * factor
      const cached = rates.cache_read_tokens
      if (cached === undefined) {
        rates.cache_read_tokens = expected
      } else if (Math.abs(cached - expected) > Math.abs(expected) * 1e-9) {
        return null
      }
      continue
    }
    // "Prompts with >272K input tokens are priced at 2x input and 1.5x
    // output for the full request" — a whole-request re-quote of every
    // rate, which is exactly a tier.
    const long = bullet.match(
      /prompts with (?:more than |>)([\d,.]+\s*[km]?) input tokens are priced at ([\d.]+)x input(?: and cache rates)? and ([\d.]+)x output/i,
    )
    if (long) {
      const threshold = tokenCount(long[1])
      if (threshold === null) return null
      const tier: Record<string, number> = {}
      for (const [lever, rate] of Object.entries(rates)) {
        const factor = INPUT_LEVERS.includes(lever)
          ? Number(long[2])
          : OUTPUT_LEVERS.includes(lever)
            ? Number(long[3])
            : null
        // A lever the sentence does not cover would be quoted at the base
        // rate inside the tier, which is a guess.
        if (factor === null) return null
        tier[lever] = rate * factor
      }
      out.tiers.push({ minPromptTokens: threshold, rates: tier })
      continue
    }
    if (PROSE_BULLETS.test(bullet)) continue
    // An unrecognised bullet that quotes money, a multiplier or a
    // percentage may be a surcharge this card would drop.
    if (/\$|\b\d+(\.\d+)?x\b|%/.test(bullet)) return null
  }
  return out
}

function listValues(block: string, label: string): Array<string> {
  const match = block.match(new RegExp(`^- ${label}: (.+)$`, 'm'))
  return match?.[1]
    ? match[1].split(',').map((s) => s.trim().toLowerCase())
    : []
}

/** Parse one model page's details, features and snapshot ids. */
export function parseModelPage(markdown: string): OpenAiModelPage | null {
  const modelId = markdown.match(/^Model ID: `([^`]+)`/m)?.[1]
  if (!modelId) return null
  const details = markdownSection(markdown, 'Model details')
  const ids = new Set<string>([modelId])
  const pricedIds = new Set<string>([modelId])
  const snapshot = details.match(/^- Default snapshot: `([^`]+)`/m)?.[1]
  if (snapshot) {
    ids.add(snapshot)
    pricedIds.add(snapshot)
  }
  for (const m of markdownSection(markdown, 'Snapshots').matchAll(
    /^- `([^`]+)`/gm,
  )) {
    if (m[1]) ids.add(m[1])
  }

  const input = listValues(details, 'Input modalities')
  const output = listValues(details, 'Output modalities')
  const contextWindow = tokenCount(
    details.match(/^- ([\d,]+) context window/m)?.[1],
  )
  const maxOutput = tokenCount(
    details.match(/^- ([\d,]+) max output tokens/m)?.[1],
  )

  const features = new Set(
    [
      ...markdownSection(markdown, 'Supported features').matchAll(/^- (\S+)/gm),
    ].map((m) => m[1] ?? ''),
  )
  // `file_uploads` is the page's per-model statement that the model takes
  // `input_file` / `file` parts (the file-inputs guide: PDFs on every such
  // model, other documents as extracted text). Absent, nothing is said; a
  // page that states no input modalities gets none from this alone.
  if (
    features.has('file_uploads') &&
    input.length > 0 &&
    !input.includes('file')
  ) {
    input.push('file')
  }
  const reasoning = /^- Reasoning token support/m.test(details)
  const capabilities: Array<string> = []
  if (features.has('function_calling')) capabilities.push('tools')
  if (reasoning) capabilities.push('reasoning')
  // Effort levels and sampling-param support appear only in prose on the
  // page; neither is a field, so neither is asserted here.
  if (features.has('structured_outputs')) {
    capabilities.push('structured_outputs', 'response_format')
  }

  const serverTools = [
    ...markdownSection(markdown, 'Supported tools').matchAll(/^- (\S+)/gm),
  ].flatMap((m) => {
    const type = RESPONSES_TOOL_TYPES[m[1] ?? '']
    return type ? [type] : []
  })

  return {
    ids: [...ids],
    pricedIds: [...pricedIds],
    pricing: parseModelPricing(markdown),
    facts: {
      contextWindow,
      maxOutput,
      modalities:
        input.length > 0 || output.length > 0 ? { input, output } : null,
      capabilities: capabilities.length > 0 ? capabilities : null,
      reasoning: reasoning ? parseReasoningEffort(markdown) : null,
      serverTools: serverTools.length > 0 ? serverTools : null,
    },
  }
}

/**
 * "Supported tools" names → Responses API `tools[].type`. `function_calling`
 * is a client tool and `skills` rides on `shell`; neither is a type.
 */
const RESPONSES_TOOL_TYPES: Record<string, string> = {
  web_search: 'web_search',
  file_search: 'file_search',
  tool_search: 'tool_search',
  image_generation: 'image_generation',
  code_interpreter: 'code_interpreter',
  hosted_shell: 'shell',
  apply_patch: 'apply_patch',
  computer_use: 'computer',
  mcp: 'mcp',
}

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Effort levels from the page's prose: "Reasoning.effort supports: none
 * (default), low, …" or "defaults to (and only supports) `reasoning.effort:
 * high`". Reasoning is optional only when `none` is accepted; "only
 * supports" one other level states it cannot be turned off. Without a
 * native control declaration, its mode stays unknown; capability is separate.
 */
export function parseReasoningEffort(markdown: string): ModelReasoning | null {
  const prose = markdown.replace(/```[\s\S]*?```/g, '')
  const only = prose.match(
    /only supports\)?\s*`reasoning\.effort:\s*([a-z]+)`/i,
  )?.[1]
  const list =
    prose.match(
      /(?:reasoning\.effort`?\s+supports:?|supports\s+`?reasoning\.effort`?:?)\s*([^.!]+?)(?=\.(?:\s|$)|\n\s*\n|$)/i,
    ) ??
    prose.match(
      /supports\s+((?:`[a-z]+`[^.!]*?)+)\s+reasoning effort settings/i,
    ) ??
    prose.match(/Configurable reasoning effort:[^\n]*?\(([^)]+)\)/i)
  const words = only
    ? [only.toLowerCase()]
    : (list?.[1]?.toLowerCase().match(/[a-z]+/g) ?? [])
  const efforts = EFFORTS.filter((level) => words.includes(level))
  if (!efforts.length) {
    const explicitControl = prose.split('\n').some((line) => {
      const declaration = line.match(
        /^(.*?)\bsupports configurable reasoning effort\b/i,
      )
      return (
        declaration !== null &&
        !/\b(?:not|never|cannot|no)\b|doesn't/i.test(declaration[1] ?? '')
      )
    })
    return explicitControl ? { mode: 'effort', mandatory: null } : null
  }
  return {
    mode: 'effort',
    mandatory: efforts.includes('none')
      ? false
      : only !== undefined ||
          /(?:reasoning|thinking)\s+(?:is\s+)?(?:cannot be disabled|always on|cannot be turned off)/i.test(
            prose,
          )
        ? true
        : null,
    ...(efforts.length > 0 ? { efforts } : {}),
  }
}

/**
 * Model pages the models index no longer links, which still publish a price.
 * Dated snapshots resolve to that page; `pricedIds` decides whether the
 * price applies. A family page is never used for an id that is not that
 * page's model id or its dated form (`tts-1-1106` is not `tts-1`).
 */
const UNINDEXED_MODEL_PAGES = new Set(['sora-2', 'sora-2-pro'])

/** Page slug a listed id resolves to, or null when the docs have no page. */
export function pageSlugFor(rawId: string, slugs: Set<string>): string | null {
  if (slugs.has(rawId)) return rawId
  const undated = undatedId(rawId)
  if (slugs.has(undated)) return undated
  if (UNINDEXED_MODEL_PAGES.has(rawId)) return rawId
  if (UNINDEXED_MODEL_PAGES.has(undated)) return undated
  return null
}

/**
 * Ids whose listing should load the GPT-5 guides. Wider than the sentences:
 * a parsed guide applies only to the ids it names.
 */
function gpt5GuideSelects(rawId: string): boolean {
  return /^gpt-5(?:-[a-z][a-z0-9-]*)?$/.test(undatedId(rawId))
}

/**
 * Ids a failed family or sampling guide may hold. The parsed family sentence
 * wins; without it, only the three ids those guides are written for.
 */
const GPT5_GUIDE_FAMILY = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano']

function guideNames(rawId: string, ids: Array<string>): boolean {
  return ids.includes(rawId) || ids.includes(undatedId(rawId))
}

type OpenAiDocsFacts = ModelFacts &
  Pick<ModelInfo, 'unsupportedCapabilities' | 'absent'>

/** Facts a model page (via the index that names it) feeds. */
const PAGE_FACTS = [
  'contextWindow',
  'maxOutput',
  'modalities',
  'capabilities',
  'pricing',
  'reasoning',
  'serverTools',
] as const

/**
 * Facts for the listed ids. Pages are fetched once per slug and memoised;
 * a page's snapshot list also seeds ids the index alone couldn't resolve.
 * Every docs load goes through `tryDocs`, so a failed one leaves the facts
 * it feeds `unavailable` on the rows it speaks for and the listing still
 * polls: the index or a model page (every page fact; a failed page may be
 * the alias page that seeds an id, so unresolved ids too), the pricing
 * page (an unpriced row's pricing), the realtime guide (reasoning on a
 * realtime id whose effort-mode page lists no efforts).
 * A failed family or sampling guide marks `absent` on the ids it speaks for.
 * A failed GPT-5.1 guide does not: the family list stays, with mandatory null.
 * Every load goes through `fetcher`; the poll passes the US egress, since
 * the docs host answered 403 to loads from hkg1 (#505).
 */
export async function openaiModelFacts(
  rawIds: Array<string>,
  kv?: KVNamespace,
  run: DocsRun = docsRun(),
  fetcher: Fetcher = fetch,
): Promise<(rawId: string) => OpenAiDocsFacts> {
  const indexed = await tryDocs(run, OPENAI_MODELS_INDEX_URL, (cached) =>
    cached(kv, OPENAI_MODELS_INDEX_URL, async () => {
      const parsed = [
        ...parseModelIndex(
          await fetchText(OPENAI_MODELS_INDEX_URL, undefined, fetcher),
        ),
      ]
      if (parsed.length === 0) {
        throw new Error('openai models index: parsed 0 page slugs')
      }
      return parsed
    }),
  )
  const slugs = new Set(indexed)
  const needed = [
    ...new Set(
      rawIds
        .map((id) => pageSlugFor(id, slugs))
        .filter((slug): slug is string => slug !== null),
    ),
  ]
  const searchDoc = await tryDocs(run, OPENAI_PRICING_URL, (cached) =>
    cached(kv, OPENAI_PRICING_URL, async () => {
      const markdown = await fetchText(OPENAI_PRICING_URL, undefined, fetcher)
      const parsed = parseOpenAiSearchPricing(markdown)
      assertParsed(parsed, 'openai pricing page search rows')
      return {
        rates: Object.fromEntries(parsed),
        hash: await sha256Text(markdown),
        extractedAt: new Date().toISOString(),
      }
    }),
  )
  const pageLoads = await mapConcurrent(needed, 8, async (slug) => {
    const page = await tryDocs(run, OPENAI_MODEL_PAGE(slug), (cached) =>
      cached(kv, OPENAI_MODEL_PAGE(slug), async () => {
        const markdown = await fetchText(
          OPENAI_MODEL_PAGE(slug),
          undefined,
          fetcher,
        )
        const parsed = parseModelPage(markdown)
        if (!parsed) {
          throw new Error(`openai model page ${slug}: no Model ID`)
        }
        // The card's provenance hashes the page as served, so an unchanged
        // page keeps the stored card (and its `extractedAt`) on re-parse.
        return {
          ...parsed,
          hash: await sha256Text(markdown),
          extractedAt: new Date().toISOString(),
        }
      }),
    )
    return page ? { slug, page } : null
  })
  const pages = pageLoads.filter((page) => page !== null)
  const failedSlugs = new Set(
    needed.filter((_, index) => pageLoads[index] === null),
  )
  // A model's own page takes precedence over another alias page that names
  // it as a default snapshot. Listing order must not erase native controls.
  const primaryIds = new Set(pages.map((loaded) => loaded.page.ids[0]))
  const byId = new Map<string, OpenAiDocsFacts>()
  for (const loaded of pages) {
    const url = OPENAI_MODEL_PAGE(loaded.slug)
    const withPricing: ModelFacts = {
      ...loaded.page.facts,
      pricing: loaded.page.pricing?.unit
        ? compileUnitCard(loaded.page.pricing.unit, {
            url,
            hash: loaded.page.hash,
            extractedAt: loaded.page.extractedAt,
          })
        : loaded.page.pricing
          ? compileTokenCard(
              loaded.page.pricing.rates,
              loaded.page.pricing.tiers,
              {
                url,
                hash: loaded.page.hash,
                extractedAt: loaded.page.extractedAt,
                ...(loaded.page.pricing.expiresAt && {
                  expiresAt: loaded.page.pricing.expiresAt,
                }),
              },
            )
          : null,
    }
    const facts: ModelFacts = {
      ...withPricing,
      factSources: tagDocsFacts(withPricing, url, loaded.page.hash),
    }
    const priced = new Set(loaded.page.pricedIds)
    for (const id of loaded.page.ids) {
      if (id !== loaded.page.ids[0] && primaryIds.has(id)) continue
      if (priced.has(id)) {
        byId.set(id, facts)
        continue
      }
      // The family page prices the alias and the default snapshot only.
      // An older snapshot (gpt-4o-2024-05-13) is not that price.
      const sources = { ...facts.factSources }
      delete sources.pricing
      byId.set(id, { ...facts, pricing: null, factSources: sources })
    }
  }
  const realtimeListed = rawIds.some(openaiRealtimeSelects)
  const realtime = realtimeListed
    ? await tryDocs(run, OPENAI_REALTIME_EFFORT_URL, (cached) =>
        openaiRealtimeEfforts(rawIds, kv, cached, fetcher),
      )
    : null
  if (realtime) {
    const own = byId.get(realtime.rawId)
    if (own?.reasoning?.mode === 'effort' && !own.reasoning.efforts?.length) {
      byId.set(realtime.rawId, {
        ...own,
        reasoning: { ...own.reasoning, efforts: realtime.efforts },
        factSources: {
          ...own.factSources,
          reasoning: {
            derivation: 'docs-derived',
            sourceUrl: OPENAI_REALTIME_EFFORT_URL,
            sourceHash: realtime.hash,
            path: 'Set reasoning effort',
          },
        },
      })
    }
  }
  const guides = rawIds.some(gpt5GuideSelects)
    ? await Promise.all([
        tryDocs(run, OPENAI_GPT5_GUIDE_URL, (cached) =>
          loadGuide(
            cached,
            kv,
            OPENAI_GPT5_GUIDE_URL,
            parseGpt5FamilyGuide,
            fetcher,
          ),
        ),
        tryDocs(run, OPENAI_GPT51_GUIDE_URL, (cached) =>
          loadGuide(
            cached,
            kv,
            OPENAI_GPT51_GUIDE_URL,
            parseGpt51NoneGuide,
            fetcher,
          ),
        ),
        tryDocs(run, OPENAI_GPT52_GUIDE_URL, (cached) =>
          loadGuide(
            cached,
            kv,
            OPENAI_GPT52_GUIDE_URL,
            parseGpt52SamplingGuide,
            fetcher,
          ),
        ),
      ])
    : null
  if (guides) {
    const [family, none, sampling] = guides
    const guideSource = (url: string, hash: string, path: string) =>
      ({
        derivation: 'docs-derived',
        sourceUrl: url,
        sourceHash: hash,
        path,
      }) satisfies FactSource
    for (const [id, own] of byId) {
      const flags: unknown = own.capabilities
      if (!Array.isArray(flags) || !flags.includes('reasoning')) continue
      const named = (ids: Array<string>) =>
        ids.includes(id) || ids.includes(undatedId(id))
      let facts: OpenAiDocsFacts = own
      if (family && named(family.parsed.rawIds) && !own.reasoning?.efforts) {
        facts = {
          ...facts,
          reasoning: {
            mode: 'effort',
            mandatory: null,
            efforts: family.parsed.efforts,
          },
          factSources: {
            ...facts.factSources,
            reasoning: guideSource(
              OPENAI_GPT5_GUIDE_URL,
              family.hash,
              'Model, API, and feature updates',
            ),
          },
        }
      }
      const reasoning = facts.reasoning
      if (
        family &&
        none &&
        named(family.parsed.rawIds) &&
        !family.parsed.efforts.includes('none') &&
        reasoning?.mandatory === null &&
        reasoning.efforts?.join() === family.parsed.efforts.join() &&
        reasoning.efforts[0] === none.parsed
      ) {
        facts = {
          ...facts,
          reasoning: { ...reasoning, mandatory: true },
          factSources: {
            ...facts.factSources,
            reasoning: guideSource(
              OPENAI_GPT51_GUIDE_URL,
              none.hash,
              'Using the "none" reasoning mode for improved efficiency',
            ),
          },
        }
      }
      if (sampling && named(sampling.parsed.rawIds)) {
        const source = guideSource(
          OPENAI_GPT52_GUIDE_URL,
          sampling.hash,
          'GPT-5.2 parameter compatibility',
        )
        facts = {
          ...facts,
          unsupportedCapabilities: sampling.parsed.flags,
          factSources: {
            ...facts.factSources,
            capabilities: {
              ...facts.factSources?.capabilities,
              ...Object.fromEntries(
                sampling.parsed.flags.map((flag) => [flag, source]),
              ),
            },
          },
        }
      }
      byId.set(id, facts)
    }
  }
  if (pages.length > 0) assertParsed(byId, 'openai model pages')
  const familyIds = guides?.[0]?.parsed.rawIds ?? GPT5_GUIDE_FAMILY
  const guideGaps: OpenAiDocsFacts['absent'] = {}
  // The 5.1 sentence only upgrades mandatory. Its failure leaves the family
  // list in place with mandatory null, which is the unstated value.
  if (guides && !guides[0]) guideGaps.reasoning = 'unavailable'
  if (guides && !guides[2]) guideGaps.capabilities = 'unavailable'
  return (rawId) => {
    const facts = sourcedFacts(rawId)
    if (!guides || !guideNames(rawId, familyIds)) return facts
    const absent = { ...facts.absent }
    if (guideGaps.reasoning) absent.reasoning = 'unavailable'
    if (guideGaps.capabilities) absent.capabilities = 'unavailable'
    return guideGaps.reasoning || guideGaps.capabilities
      ? { ...facts, absent }
      : facts
  }
  /** `docsFacts`, with the facts a failed docs load feeds left unavailable. */
  function sourcedFacts(rawId: string): OpenAiDocsFacts {
    const slug = indexed ? pageSlugFor(rawId, slugs) : null
    // A failed page may also have been the alias page that seeds this id.
    const pageLost =
      !indexed ||
      (slug !== null && failedSlugs.has(slug)) ||
      (failedSlugs.size > 0 && !byId.has(rawId) && !byId.has(undatedId(rawId)))
    if (pageLost) return { ...NO_FACTS, ...unavailable(...PAGE_FACTS) }
    const facts = docsFacts(rawId)
    const gaps: OpenAiDocsFacts['absent'] = { ...facts.absent }
    if (!searchDoc && !facts.pricing) gaps.pricing = 'unavailable'
    // The guide only fills efforts an effort-mode page left unlisted.
    const effortsUnlisted =
      facts.reasoning?.mode === 'effort' && !facts.reasoning.efforts?.length
    if (
      realtimeListed &&
      !realtime &&
      openaiRealtimeSelects(rawId) &&
      effortsUnlisted
    ) {
      gaps.reasoning = 'unavailable'
    }
    return Object.keys(gaps).length > 0 ? { ...facts, absent: gaps } : facts
  }
  function docsFacts(rawId: string): OpenAiDocsFacts {
    const exact = byId.get(rawId)
    let facts: OpenAiDocsFacts
    if (exact) {
      facts = exact
    } else {
      const familyId = undatedId(rawId)
      const family = byId.get(familyId)
      if (!family || familyId === rawId) {
        facts = family ?? NO_FACTS
      } else {
        // The family page prices the alias and the default snapshot only.
        const sources = { ...family.factSources }
        delete sources.pricing
        facts = { ...family, pricing: null, factSources: sources }
      }
    }
    if (facts.pricing) return facts
    if (!searchDoc) return facts
    // Exact id only. A dated snapshot is not the undated search row.
    const rates = searchDoc.rates[rawId]
    if (!rates) return facts
    const pricing = compileTokenCard(rates, [], {
      url: OPENAI_PRICING_URL,
      hash: searchDoc.hash,
      extractedAt: searchDoc.extractedAt,
    })
    if (!pricing) return facts
    return {
      ...facts,
      pricing,
      factSources: {
        ...facts.factSources,
        ...tagDocsFacts({ pricing }, OPENAI_PRICING_URL, searchDoc.hash),
      },
    }
  }
}
