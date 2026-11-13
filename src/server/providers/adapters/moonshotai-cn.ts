/**
 * Moonshot AI (China). platform.moonshot.cn redirects to platform.kimi.com,
 * whose OpenAPI document names api.moonshot.cn as its server. Model ids
 * come from the pricing page, which no longer states a context window
 * (issue #484); activity, reasoning and modalities from the spec's
 * per-model chat request schemas. No output limit is published.
 * Prices on the pricing page are yuan per 1M tokens, stored as CNY cards.
 * `GET /v1/models` needs a CN key, which is region-bound.
 */
import {
  applyReplay,
  KIMI_CN_THINKING_URL,
  loadReplayDoc,
  parseKimiReplay,
} from '../provider-replay.ts'
import { compileTokenCard } from '@modelschemas/rate-card'

import { classifyOpenAiCompat } from '../openai-compat.ts'
import { parseKimiDocTables } from '../kimi-doc-tables.ts'
import type { KimiDocTable } from '../kimi-doc-tables.ts'
import { cachedDocs } from '../model-facts.ts'
import { compatGenerationEndpointId } from '../model-meta.ts'
import { REASONING_SOURCE_SILENT } from '../reasoning-config.ts'
import {
  fetchResponse,
  fetchText,
  sha256Text,
  timeoutSignal,
} from '../types.ts'
import type {
  FactSource,
  ListModelsResult,
  ModelFactSources,
  ModelInfo,
  ModelReasoning,
  OpenApiDocument,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

/** The HTML page: its `.md` export renders the price tables empty. */
export const MOONSHOT_CN_PRICING_URL =
  'https://platform.kimi.com/docs/pricing/chat'
export const MOONSHOT_CN_OPENAPI_URL =
  'https://platform.kimi.com/docs/openapi.json'

/** One Moonshot region: its docs host publishes its own copy of the spec. */
export interface MoonshotHost {
  /** Provider id that prefixes an error. */
  label: string
  /** The API server the spec must name, or it is another region's. */
  server: string
  specUrl: string
}

const CN_HOST: MoonshotHost = {
  label: 'moonshotai-cn',
  server: 'https://api.moonshot.cn',
  specUrl: MOONSHOT_CN_OPENAPI_URL,
}
const CHAT_PATH = '/v1/chat/completions'
const FETCH_TIMEOUT_MS = 20_000

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseMoonshotCnModels(
  tables: Array<KimiDocTable>,
): Array<ModelInfo> {
  const models: Array<ModelInfo> = []
  const seen = new Set<string>()
  for (const [rawId, ...cells] of tables.flatMap((table) => table.rows)) {
    if (!rawId || !/^(?:kimi|moonshot)-/.test(rawId) || seen.has(rawId)) {
      continue
    }
    seen.add(rawId)
    const windows = cells.flatMap((cell) => {
      const match = cell?.match(/^([0-9,]+) tokens$/)
      return match?.[1] ? [match[1]] : []
    })
    const last = windows.at(-1)
    const contextWindow = last ? Number(last.replace(/,/g, '')) : null
    models.push({
      rawId,
      contextWindow:
        contextWindow !== null && Number.isFinite(contextWindow)
          ? contextWindow
          : null,
      pricing: null,
    })
  }
  if (models.length === 0) {
    throw new Error('moonshotai-cn: pricing page listed no ids')
  }
  return models
}

/**
 * Price column title → the usage lever it prices. A cache write is billed
 * by its TTL, but Chat Completions reports one `cache_write_tokens` count
 * whatever the TTL: a caller on the 1h TTL passes that count as
 * `cache_write_1h_tokens`.
 */
const PRICE_COLUMNS: Record<string, string> = {
  输入: 'input_tokens',
  输出: 'output_tokens',
  缓存命中: 'cache_read_tokens',
  '缓存写入（5min）': 'cache_write_tokens',
  '缓存写入（1h）': 'cache_write_1h_tokens',
}
const OTHER_COLUMNS = new Set(['模型'])

/**
 * Model id → yuan per token, by lever, from the `### … 系列模型` tables
 * of `## 模型定价` (`parseKimiDocTables`). Columns are read by title. A
 * row is priced only when every price cell is a bare `¥12.50 / MTok` (the
 * page states 1 MTok = 1,000,000 tokens). Any other row naming the model
 * leaves it unpriced: another unit, a cell that is not text (a struck
 * price), a range, a cell count that differs from the column count, a
 * table with a title this does not know, a table under another `###` of `## 模型定价` (a batch
 * price), or a second row for the same id. Tables outside `## 模型定价` are
 * ignored. Throws when a row there has no readable id, or when no row is
 * priced.
 */
export function parseMoonshotCnPricing(
  tables: Array<KimiDocTable>,
): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>()
  const refused = new Set<string>()
  for (const { section, subsection, titles, rows } of tables) {
    if (section !== '模型定价') continue
    const known =
      (subsection ?? '').endsWith('系列模型') &&
      titles.every(
        (t) => t !== null && (t in PRICE_COLUMNS || OTHER_COLUMNS.has(t)),
      )
    for (const cells of rows) {
      const id = cells[0]
      // An unreadable id could be a second row for a priced one.
      if (id === null)
        throw new Error('moonshotai-cn: a price row has no readable id')
      if (!id) continue
      const rates: Record<string, number> = {}
      titles.forEach((title, index) => {
        const lever = title === null ? undefined : PRICE_COLUMNS[title]
        const amount = cells[index]?.match(/^¥(\d+(?:\.\d+)?) \/ MTok$/)?.[1]
        if (lever && amount !== undefined) rates[lever] = Number(amount) / 1e6
      })
      const priceColumns = titles.filter(
        (title) => title !== null && title in PRICE_COLUMNS,
      )
      if (
        !known ||
        out.has(id) ||
        cells.length !== titles.length ||
        Object.keys(rates).length !== priceColumns.length ||
        rates.input_tokens === undefined ||
        rates.output_tokens === undefined
      ) {
        refused.add(id)
        continue
      }
      out.set(id, rates)
    }
  }
  for (const id of refused) out.delete(id)
  if (out.size === 0) {
    throw new Error('moonshotai-cn: pricing page priced no ids')
  }
  return out
}

/**
 * The pricing page. platform.kimi.ai publishes the same path in USD, so a
 * redirect off the CN host would hand this provider the other's prices.
 *
 * This page is the model list: it is fetched on every poll and is not a
 * cached doc, so a timeout fails the poll instead of going through `tryDocs`.
 */
async function fetchPricingPage(): Promise<string> {
  const response = await fetchResponse(MOONSHOT_CN_PRICING_URL, {
    signal: timeoutSignal(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(
      `fetch failed: ${MOONSHOT_CN_PRICING_URL} → ${String(response.status)} ${response.statusText}`,
    )
  }
  const host = new URL(response.url || MOONSHOT_CN_PRICING_URL).host
  if (host !== new URL(MOONSHOT_CN_PRICING_URL).host) {
    throw new Error(`moonshotai-cn: pricing page was answered by ${host}`)
  }
  return response.text()
}

function deref(spec: OpenApiDocument, node: unknown, depth = 0): unknown {
  if (depth > 8 || !isRecord(node) || typeof node.$ref !== 'string') return node
  const name = node.$ref.replace('#/components/schemas/', '')
  return deref(spec, spec.components?.schemas?.[name], depth + 1)
}

/** Own and `allOf` properties. `oneOf` branches are alternatives, not merged. */
function propertiesOf(spec: OpenApiDocument, node: unknown): Json {
  const resolved = deref(spec, node)
  if (!isRecord(resolved)) return {}
  const out: Json = {}
  if (Array.isArray(resolved.allOf)) {
    for (const part of resolved.allOf) {
      Object.assign(out, propertiesOf(spec, part))
    }
  }
  return {
    ...out,
    ...(isRecord(resolved.properties) ? resolved.properties : {}),
  }
}

function stringEnum(node: unknown): Array<string> {
  if (!isRecord(node) || !Array.isArray(node.enum)) return []
  return node.enum.filter((item): item is string => typeof item === 'string')
}

const PART_MODALITY: Record<string, string> = {
  text: 'text',
  image_url: 'image',
  video_url: 'video',
}

/** Content part names (`image_url`, …) anywhere under a messages schema. */
function partModalities(
  spec: OpenApiDocument,
  node: unknown,
  into: Set<string>,
  depth = 0,
): void {
  const resolved = deref(spec, node)
  if (depth > 12 || typeof resolved !== 'object' || resolved === null) return
  for (const [key, value] of Object.entries(resolved)) {
    const modality = PART_MODALITY[key]
    if (modality) into.add(modality)
    partModalities(spec, value, into, depth + 1)
  }
}

export type MoonshotChatFacts = Pick<
  ModelInfo,
  'activity' | 'reasoning' | 'capabilities' | 'modalities'
> & { factSources: ModelFactSources }

/**
 * A `thinking` description that says the model cannot stop thinking, in the
 * international and the China spec's words.
 */
const ALWAYS_THINKS = /Thinking is always on for this model|该模型始终开启思考/

/**
 * A model's own `thinking.type` switch with nothing else beside it. The
 * statement wins over the enum; `disabled` in the model's own enum says it
 * can be turned off. An enum that only lists `enabled` states nothing by
 * itself, and a third value is not an on/off switch: both give null.
 */
export function moonshotThinkingToggle(
  types: Array<string>,
  description: unknown,
): ModelReasoning | null {
  const values = [...types].sort().join()
  if (values !== 'enabled' && values !== 'disabled,enabled') return null
  if (typeof description === 'string' && ALWAYS_THINKS.test(description)) {
    return { mode: 'toggle', mandatory: true }
  }
  return values === 'enabled' ? null : { mode: 'toggle', mandatory: false }
}

/**
 * Per-model facts from the chat request union, keyed by the ids in its
 * `model` discriminator. Throws when the document is not this host's chat
 * spec.
 */
export function moonshotChatFacts(
  spec: OpenApiDocument,
  hash: string,
  host: MoonshotHost,
): Record<string, MoonshotChatFacts> {
  if (spec.servers?.[0]?.url !== host.server) {
    throw new Error(`${host.label}: spec server is not ${host.server}`)
  }
  const post = spec.paths?.[CHAT_PATH]?.post
  const body = isRecord(post?.requestBody) ? post.requestBody : {}
  const content = isRecord(body.content) ? body.content : {}
  const media = content['application/json']
  const schema = isRecord(media) && isRecord(media.schema) ? media.schema : {}
  const discriminator = isRecord(schema.discriminator)
    ? schema.discriminator
    : {}
  const mapping = isRecord(discriminator.mapping) ? discriminator.mapping : {}
  if (discriminator.propertyName !== 'model') {
    throw new Error(`${host.label}: chat request is not a per-model union`)
  }

  const out: Record<string, MoonshotChatFacts> = {}
  for (const [rawId, ref] of Object.entries(mapping)) {
    if (typeof ref !== 'string') continue
    const name = ref.replace('#/components/schemas/', '')
    const props = propertiesOf(spec, { $ref: ref })
    if (!stringEnum(props.model).includes(rawId)) continue
    const source = (path: string): FactSource => ({
      derivation: 'upstream-spec',
      sourceUrl: host.specUrl,
      sourceHash: hash,
      path,
    })
    const facts: MoonshotChatFacts = { activity: 'chat', factSources: {} }

    const efforts = stringEnum(props.reasoning_effort)
    const thinking = stringEnum(propertiesOf(spec, props.thinking).type)
    if (efforts.length > 0) {
      const reasoning: ModelReasoning = {
        mode: 'effort',
        mandatory: !efforts.includes('none') && !thinking.includes('disabled'),
        efforts,
      }
      const effortSource = source(
        `/components/schemas/${name}/properties/reasoning_effort`,
      )
      facts.reasoning = reasoning
      facts.factSources.reasoning = effortSource
      // The schema walk flags `reasoning` only for a `thinking` property.
      facts.capabilities = ['reasoning']
      facts.factSources.capabilities = { reasoning: effortSource }
    } else if (thinking.length > 0) {
      const described = deref(spec, props.thinking)
      const toggle = moonshotThinkingToggle(
        thinking,
        isRecord(described) ? described.description : undefined,
      )
      if (toggle) facts.reasoning = toggle
      // A switch whose off position is not stated is not stored.
      facts.factSources.reasoning = source(
        toggle ? 'thinking.type' : REASONING_SOURCE_SILENT,
      )
    }

    const input = new Set<string>()
    partModalities(spec, props.messages, input)
    if (input.size > 0) {
      facts.modalities = { input: [...input], output: ['text'] }
      facts.factSources.modalities = source(
        `/components/schemas/${name}/properties/messages`,
      )
    }
    out[rawId] = facts
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`${host.label}: chat spec mapped no model ids`)
  }
  return out
}

export function moonshotCnChatFacts(
  spec: OpenApiDocument,
  hash: string,
): Record<string, MoonshotChatFacts> {
  return moonshotChatFacts(spec, hash, CN_HOST)
}

async function fetchCnSpec(): Promise<{ spec: OpenApiDocument; hash: string }> {
  const text = await fetchText(MOONSHOT_CN_OPENAPI_URL, {
    signal: timeoutSignal(FETCH_TIMEOUT_MS),
  })
  // An unknown docs path answers 200 with another page; JSON.parse throws on it.
  const spec = JSON.parse(text) as OpenApiDocument
  return { spec, hash: await sha256Text(text) }
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const tables = parseKimiDocTables(await fetchPricingPage())
  // The tables, not the page: its HTML changes with every docs deploy.
  const pricingHash = await sha256Text(JSON.stringify(tables))
  const prices = parseMoonshotCnPricing(tables)
  const extractedAt = new Date().toISOString()
  const chat = await cachedDocs(kv, MOONSHOT_CN_OPENAPI_URL, async () => {
    const { spec, hash } = await fetchCnSpec()
    return moonshotCnChatFacts(spec, hash)
  })
  const replay = await loadReplayDoc(KIMI_CN_THINKING_URL, kv)
  const replayIds = new Set(parseKimiReplay(replay.text))
  const models = parseMoonshotCnModels(tables).map((model): ModelInfo => {
    const facts = chat[model.rawId]
    const factSources: ModelFactSources = { ...facts?.factSources }
    if (model.contextWindow != null) {
      factSources.contextWindow = {
        derivation: 'docs-derived',
        sourceUrl: MOONSHOT_CN_PRICING_URL,
        sourceHash: pricingHash,
        path: 'contextWindow',
      }
    }
    const rates = prices.get(model.rawId)
    const pricing = rates
      ? compileTokenCard(
          rates,
          [],
          { url: MOONSHOT_CN_PRICING_URL, hash: pricingHash, extractedAt },
          { currency: 'CNY' },
        )
      : null
    if (pricing) {
      factSources.pricing = {
        derivation: 'docs-derived',
        sourceUrl: MOONSHOT_CN_PRICING_URL,
        sourceHash: pricingHash,
        path: 'Pricing',
      }
    }
    const enriched = { ...model, ...facts, pricing, factSources }
    return replayIds.has(model.rawId) && enriched.activity === 'chat'
      ? applyReplay(enriched, replay.source)
      : enriched
  })
  return { models }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchCnSpec()
  moonshotCnChatFacts(spec, hash)
  return {
    specs: [spec],
    sources: [{ url: MOONSHOT_CN_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

export const provider: ProviderConfig = {
  id: 'moonshotai-cn',
  displayName: 'Moonshot AI (China)',
  specSourceUrl: MOONSHOT_CN_OPENAPI_URL,
  modelsEndpoint: MOONSHOT_CN_PRICING_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify: classifyOpenAiCompat,
  generationEndpointId: ({ activity }) =>
    compatGenerationEndpointId(activity, 'v1/'),
}
