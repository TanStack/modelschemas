/**
 * LLM Gateway (llmgateway.io) — OpenAI-compatible router with a public
 * OpenAPI document and a public model listing.
 *
 * Each listed model has `providers[]`: the routes it can be served by, each
 * with its own price. A bare id (`gpt-oss-120b`) is routed by a live score
 * (docs.llmgateway.io/features/routing), so its billed price is only known
 * when every route quotes the same one; otherwise it carries a
 * `pricingRange` over its routes' cards. `provider/model` pins one route
 * ("prefix the model name with the provider name followed by a slash"), so
 * each route is also listed as its own row with that route's price. The
 * listing's top-level `pricing` is undocumented and is not used.
 *
 * Upstream links come from the route's own `providerId` + `externalId`,
 * never from `family`. A bare id with several routes has no single upstream.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard, TokenRateTier } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'
import { pricingRange } from '#/server/rate-card.ts'

import { bearerConnect } from '../connect.ts'
import { classifyOpenAiCompat } from '../openai-compat.ts'
import { SHARED_EFFORT_LEVELS } from '../request-map.ts'
import type { ChatRequestMap, EffortLevelMap } from '../request-map.ts'
import { fetchJson, fetchOpenApi, sha256Text } from '../types.ts'
import type {
  FactSource,
  ListModelsResult,
  ModelInfo,
  ModelReasoning,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const LLMGATEWAY_MODELS_URL = 'https://api.llmgateway.io/v1/models'
export const LLMGATEWAY_SPEC_URL = 'https://api.llmgateway.io/openapi.json'

/** Route `providerId` of the gateway's own virtual models (auto, custom). */
const SELF = 'llmgateway'

/** Listing `supported_parameters` names that are catalog flags. */
const PARAMETER_FLAGS: Record<string, string> = {
  tools: 'tools',
  tool_choice: 'tool_choice',
  max_tokens: 'max_tokens',
  max_completion_tokens: 'max_tokens',
  temperature: 'temperature',
  top_p: 'top_p',
  stop: 'stop',
  seed: 'seed',
  frequency_penalty: 'frequency_penalty',
  presence_penalty: 'presence_penalty',
  response_format: 'response_format',
  reasoning: 'reasoning',
  reasoning_effort: 'reasoning_effort',
}

/**
 * Route price key → the usage lever it prices. Counts are disjoint, as in
 * the gateway's own cost code (`packages/actions/src/costs.ts`):
 * `input_cache_read_explicit` replaces the cache read rate when the request
 * used `cache_control`, `content_filter` is xAI's flat fee per blocked
 * request. A route quoting any other key (`image`, audio, `per_second`,
 * `peak`, `discount`) gets no card rather than a guessed one.
 */
const LEVERS: Record<string, string> = {
  prompt: 'input_tokens',
  completion: 'output_tokens',
  input_cache_read: 'cache_read_tokens',
  input_cache_read_explicit: 'explicit_cache_read_tokens',
  input_cache_write: 'cache_write_tokens',
  input_cache_write_1h: 'cache_write_1h_tokens',
  web_search: 'web_searches',
  content_filter: 'content_filtered_requests',
  request: 'requests',
}

/** Levers the gateway counts in the prompt size that picks a tier. */
const EXTRA_PROMPT_LEVERS = ['explicit_cache_read_tokens']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

function strings(value: unknown): Array<string> | null {
  if (!Array.isArray(value)) return null
  return value.every((item) => typeof item === 'string') ? value : null
}

/** Activity from the listed output modalities; search/rerank/ocr are none. */
function activityOf(output: Array<string>): Activity | null {
  if (output.includes('text')) return 'chat'
  if (output.includes('embedding')) return 'embeddings'
  if (output.includes('video')) return 'video'
  if (output.includes('image')) return 'image'
  if (output.includes('audio') || output.includes('transcription')) {
    return 'audio'
  }
  return null
}

function endpointFor(
  activity: Activity | null,
  output: Array<string>,
): string | null {
  switch (activity) {
    case 'chat':
      return 'v1/chat/completions'
    case 'embeddings':
      return 'v1/embeddings'
    case 'image':
      return 'v1/images/generations'
    case 'video':
      return 'v1/videos'
    case 'audio':
      return output.includes('transcription')
        ? 'v1/audio/transcriptions'
        : 'v1/audio/speech'
    default:
      return null
  }
}

interface RoutePrices {
  base: Record<string, number>
  tiers: Array<TokenRateTier>
}

/**
 * Lever rates of one price object, or null when it quotes a key this does
 * not read. `skip` keys are read by the caller. The base drops zeros (an
 * unpriced lever); a band keeps them, since a band's 0 overrides the base.
 */
function leverRates(
  pricing: Record<string, unknown>,
  skip: ReadonlySet<string>,
  dropZeros: boolean,
): Record<string, number> | null {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(pricing)) {
    if (skip.has(key)) continue
    const n = typeof value === 'string' ? Number(value) : NaN
    if (!Number.isFinite(n) || n < 0) return null
    if (n === 0 && dropZeros) continue
    const lever = LEVERS[key]
    if (!lever) return null
    out[lever] = n
  }
  return out
}

const TIER_META = new Set(['name', 'up_to_tokens'])

/**
 * The route's token prices, or null when the route quotes nothing or a key
 * this does not read. `tiers` are context-length bands: the gateway bills
 * a request at the first band whose `up_to_tokens` is at or above its
 * prompt tokens (`costs.ts`), so band N applies above band N-1's bound. A
 * band leaves out a rate it keeps from the base.
 */
function routePrices(pricing: unknown): RoutePrices | null {
  if (!isRecord(pricing)) return null
  const base = leverRates(pricing, new Set(['tiers']), true)
  if (!base || !('input_tokens' in base || 'output_tokens' in base)) {
    return null
  }
  const bands = pricing.tiers ?? []
  if (!Array.isArray(bands)) return null
  const tiers: Array<TokenRateTier> = []
  for (const [i, band] of bands.entries()) {
    if (!isRecord(band)) return null
    const rates = leverRates(band, TIER_META, false)
    if (!rates) return null
    const last = i === bands.length - 1
    const bound = band.up_to_tokens
    if (last ? bound !== null : typeof bound !== 'number') return null
    if (i === 0) continue
    const below: unknown = (bands[i - 1] as Record<string, unknown>)
      .up_to_tokens
    if (typeof below !== 'number') return null
    tiers.push({ minPromptTokens: below, rates })
  }
  return { base, tiers }
}

function samePrices(a: RoutePrices, b: RoutePrices): boolean {
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
}

function sorted(prices: RoutePrices): unknown {
  const keys = (rates: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(rates).sort(([x], [y]) => x.localeCompare(y)),
    )
  return {
    base: keys(prices.base),
    tiers: prices.tiers.map((t) => [t.minPromptTokens, keys(t.rates)]),
  }
}

/**
 * The route's own effort list. `none` disables reasoning (openapi.json,
 * `reasoning_effort`), so a list with it states thinking can be turned
 * off; a list without it states nothing.
 */
function routeReasoning(route: Record<string, unknown>): ModelReasoning | null {
  if (route.reasoning !== true) return null
  const efforts = strings(route.reasoning_efforts)
  if (!efforts || efforts.length === 0) return null
  return {
    mode: 'effort',
    mandatory: efforts.includes('none') ? false : null,
    efforts,
  }
}

function sameReasoning(
  a: ModelReasoning | null,
  b: ModelReasoning | null,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Chat Completions body for the effort values the row lists. */
function chatRequest(
  params: Array<string>,
  reasoning: ModelReasoning | null,
): ChatRequestMap | null {
  const maxTokensField = params.includes('max_tokens') ? 'max_tokens' : null
  const efforts = reasoning?.efforts ?? []
  const thinking = efforts.includes('high')
    ? {
        on: { reasoning_effort: 'high' },
        off: efforts.includes('none') ? { reasoning_effort: 'none' } : null,
        levels: Object.fromEntries(
          SHARED_EFFORT_LEVELS.map((level) => {
            const value = level === 'off' ? 'none' : level
            return [level, efforts.includes(value) ? value : null]
          }),
        ) as EffortLevelMap,
      }
    : null
  if (maxTokensField === null && thinking === null) return null
  return {
    thinking,
    maxTokensField,
    developerRole: null,
    replayReasoningContent: null,
    store: null,
    strictTools: null,
    sessionAffinity: null,
    cacheControl: null,
    toolStream: null,
    reasoningEffort: null,
  }
}

function capabilityFlags(params: Array<string>): Array<string> {
  return [...new Set(params.flatMap((name) => PARAMETER_FLAGS[name] ?? []))]
}

function deprecated(row: Record<string, unknown>, now: number): boolean {
  return [row.deprecated_at, row.deactivated_at].some(
    (at) => typeof at === 'string' && Date.parse(at) <= now,
  )
}

function listed(source: RateCard['source'], path: string): FactSource {
  return {
    derivation: 'listing',
    sourceUrl: source.url,
    sourceHash: source.hash,
    path,
  }
}

interface Route {
  providerId: string
  externalId: string
  row: Record<string, unknown>
}

function routesOf(row: Record<string, unknown>): Array<Route> {
  if (!Array.isArray(row.providers)) return []
  return row.providers.flatMap((route) =>
    isRecord(route) &&
    typeof route.providerId === 'string' &&
    route.providerId.length > 0 &&
    typeof route.externalId === 'string' &&
    route.externalId.length > 0
      ? [
          {
            providerId: route.providerId,
            externalId: route.externalId,
            row: route,
          },
        ]
      : [],
  )
}

export function parseLlmGatewayModels(
  payload: unknown,
  source: RateCard['source'],
  now: number = Date.now(),
): Array<ModelInfo> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('llmgateway: models payload has no data array')
  }
  const models: Array<ModelInfo> = []
  for (const row of payload.data) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) {
      continue
    }
    const id = row.id
    const arch = isRecord(row.architecture) ? row.architecture : {}
    const input = strings(arch.input_modalities)
    const output = strings(arch.output_modalities) ?? []
    const activity = activityOf(output)
    const routes = routesOf(row)
    const params = strings(row.supported_parameters) ?? []
    const flags = capabilityFlags(params)
    const realtime = routes.some((route) => route.row.realtime === true)
    const shared: ModelInfo = {
      rawId: id,
      activity,
      modalities:
        input && input.length > 0 && output.length > 0
          ? { input, output }
          : null,
      releasedAt: positive(row.created),
      deprecated: deprecated(row, now),
      // Realtime models are served over a socket, not the listed routes.
      schemaEndpointId: realtime ? null : endpointFor(activity, output),
    }
    const name = typeof row.name === 'string' ? row.name : null

    const routeFacts = routes.map((route) => {
      const prices = routePrices(route.row.pricing)
      const card = prices
        ? compileTokenCard(prices.base, prices.tiers, source, {
            extraPromptLevers: EXTRA_PROMPT_LEVERS,
          })
        : null
      return { route, prices, card, reasoning: routeReasoning(route.row) }
    })

    // Bare id: a fact only when every route agrees on it.
    const [first, ...rest] = routeFacts
    const prices = first?.prices ?? null
    const bareCard =
      first?.card &&
      prices &&
      rest.every((r) => r.prices && samePrices(r.prices, prices))
        ? first.card
        : null
    const bareReasoning =
      first && rest.every((r) => sameReasoning(r.reasoning, first.reasoning))
        ? first.reasoning
        : null
    const single = routes.length === 1 ? routes[0] : undefined
    // Routes that disagree: no single billed price, so a range over the
    // pinned rows' cards. The gateway's own route has no pinned row, so
    // it leaves the range unknown.
    const range =
      bareCard || routes.length < 2
        ? null
        : pricingRange(
            routeFacts.map(({ route, card }) => ({
              model: `${route.providerId}/${id}`,
              card: route.providerId === SELF ? null : card,
            })),
          )
    models.push(
      rowInfo({
        ...shared,
        displayName: name,
        contextWindow: positive(row.context_length),
        maxOutput: activity === 'chat' ? positive(row.max_output) : null,
        pricing: bareCard,
        pricingRange: range,
        // Every route priced and they differ: the listing states there is
        // no one price. A route this cannot read leaves it a plain omission.
        ...(routes.length > 1 &&
        !bareCard &&
        routeFacts.every((r) => r.card !== null)
          ? { absent: { pricing: 'cleared' as const } }
          : {}),
        reasoning: bareReasoning,
        aliases: strings(row.aliases),
        upstream: single ? upstreamOf(single, source) : null,
        pricePath: 'data[].providers[].pricing',
        flags,
        params,
        source,
      }),
    )

    // Pinned `provider/model` rows: one per route, that route's facts.
    for (const { route, card, reasoning } of routeFacts) {
      if (route.providerId === SELF) continue
      const routeFlags =
        route.row.tools === false
          ? flags.filter((flag) => flag !== 'tools' && flag !== 'tool_choice')
          : flags
      models.push(
        rowInfo({
          ...shared,
          rawId: `${route.providerId}/${id}`,
          displayName: name ? `${name} (${route.providerId})` : null,
          // The listed context is the model's largest; a pinned route
          // may be a smaller deployment.
          contextWindow: single ? positive(row.context_length) : null,
          maxOutput:
            activity === 'chat' ? positive(route.row.max_output) : null,
          pricing: card,
          reasoning,
          upstream: upstreamOf(route, source),
          pricePath: `data[].providers[providerId=${route.providerId}].pricing`,
          flags: routeFlags,
          params,
          source,
        }),
      )
    }
  }
  if (models.length === 0) {
    throw new Error('llmgateway: models payload listed no ids')
  }
  return models
}

function upstreamOf(
  route: Route,
  source: RateCard['source'],
): ModelInfo['upstream'] {
  if (route.providerId === SELF) return null
  return {
    providerNamespace: route.providerId,
    rawId: route.externalId,
    source: listed(source, 'data[].providers[].externalId'),
  }
}

function rowInfo(
  info: ModelInfo & {
    pricePath: string
    flags: Array<string>
    params: Array<string>
    source: RateCard['source']
  },
): ModelInfo {
  const { pricePath, flags, params, source, ...model } = info
  const factSources: NonNullable<ModelInfo['factSources']> = {}
  if (model.pricing) factSources.pricing = listed(source, pricePath)
  if (model.pricingRange) {
    factSources.pricingRange = listed(source, 'data[].providers[].pricing')
  }
  const requestMap =
    model.activity === 'chat'
      ? chatRequest(params, model.reasoning ?? null)
      : null
  return {
    ...model,
    ...(flags.length > 0
      ? { capabilities: flags, exactCapabilities: true }
      : {}),
    ...(requestMap ? { requestMap } : {}),
    ...(Object.keys(factSources).length > 0 ? { factSources } : {}),
  }
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const payload = await fetchJson(LLMGATEWAY_MODELS_URL)
  return {
    models: parseLlmGatewayModels(payload, {
      url: LLMGATEWAY_MODELS_URL,
      hash: await sha256Text(JSON.stringify(payload)),
      extractedAt: new Date().toISOString(),
    }),
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(LLMGATEWAY_SPEC_URL)
  return {
    specs: [spec],
    sources: [{ url: LLMGATEWAY_SPEC_URL, hash }],
    outputStrategy: 'post-200',
    // Unversioned URL: the document hash is the revision id.
    specRevision: hash,
  }
}

export const provider: ProviderConfig = {
  id: 'llmgateway',
  displayName: 'LLM Gateway',
  specSourceUrl: LLMGATEWAY_SPEC_URL,
  modelsEndpoint: LLMGATEWAY_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  specGrain: 'provider',
  connect: bearerConnect('https://api.llmgateway.io'),
  fetchSpec,
  listModels,
  classify: classifyOpenAiCompat,
}
