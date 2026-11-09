/**
 * FAL — one OpenAPI spec per model from the FAL models API
 * (`expand=openapi-3.0`; NB the param is plain `expand`, not `expand[]` —
 * the bracketed form is silently ignored). Requires FAL_KEY; skipped with a
 * recorded warning when absent. Output schemas use the `sibling-get`
 * strategy (the POST returns a queue ack).
 *
 * Activity comes from the model's `<source>-to-<target>` category, not the
 * path, so fetchSpec annotates every operation with FAL_ACTIVITY_MARKER and
 * classify reads it back.
 *
 * Listed models with a classifiable activity but no OpenAPI POST are probed
 * for a WMA AsyncAPI contract (llms.txt `AsyncAPI Contract` link, then
 * `/api/apps/{app}/asyncapi.json`). Misses do not fail the sync. Classic
 * realtime apps that reuse HTTP OpenAPI over WebSocket are not AsyncAPI.
 */
import type { Activity } from '#/db/schema.ts'
import { activities } from '#/db/schema.ts'
import { extractAsyncApiSchemas } from '#/server/ingest/asyncapi.ts'
import { compileFalTokenCard } from '#/server/ingest/fal-token-rate.ts'
import { contentHash } from '#/server/kv.ts'
import { falChatFacts } from './fal-chat-facts.ts'
import {
  docsReport,
  docsRun,
  mapConcurrent,
  markdownSection,
  tryDocs,
  unavailable,
} from './model-facts.ts'
import { isoToEpochSeconds } from './release-dates.ts'
import { sha256Text, skippedResult } from './types.ts'
import type {
  BundledEndpoint,
  FactSource,
  ListModelsResult,
  ModelFactSources,
  ModelInfo,
  OpenApiDocument,
  OpenApiOperation,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
  SpecSource,
} from './types.ts'

const FAL_MODELS_URL = 'https://api.fal.ai/v1/models'

export const FAL_ACTIVITY_MARKER = 'x-modelschemas-fal-activity'

interface FalApiModel {
  endpoint_id: string
  openapi?: OpenApiDocument
  /**
   * Null on rows the active search omits. Category then lives on the
   * embedded OpenAPI document (`info['x-fal-metadata'].category`), which
   * arrives only when the request sets `expand=openapi-3.0`.
   */
  metadata: {
    display_name?: string
    category?: string
    description?: string
    status?: 'active' | 'inactive' | 'deprecated'
    /** Listing/release date, ISO 8601. */
    date?: string
    [key: string]: unknown
  } | null
  retires_at?: string | null
}

/**
 * Ids the active models search never pages, while `endpoint_id` lookup
 * still serves queue OpenAPI. `fal-ai/whisper` is the default transcription
 * model in TanStack AI. One id per request: a missing id 404s the batch.
 */
const FAL_UNLISTED_ENDPOINT_IDS = ['fal-ai/whisper']

function openApiCategory(model: FalApiModel): string | null {
  const meta = model.openapi?.info?.['x-fal-metadata']
  if (typeof meta !== 'object' || meta === null || !('category' in meta)) {
    return null
  }
  const category = meta.category
  return typeof category === 'string' && category.length > 0 ? category : null
}

/** Listing category, else the category stamped on the embedded OpenAPI. */
function modelCategory(model: FalApiModel): string | null {
  const listed = model.metadata?.category
  if (typeof listed === 'string' && listed.length > 0) return listed
  return openApiCategory(model)
}

/**
 * A listing says `deprecated` in metadata. An unlisted row has no metadata;
 * a `retires_at` already in the past is the only deprecation signal left.
 */
function modelDeprecated(model: FalApiModel): boolean {
  if (model.metadata?.status === 'deprecated') return true
  if (model.metadata != null) return false
  if (typeof model.retires_at !== 'string') return false
  const at = Date.parse(model.retires_at)
  return Number.isFinite(at) && at <= Date.now()
}

interface FalApiResponse {
  models: Array<FalApiModel>
  has_more: boolean
  next_cursor: string | null
}

/**
 * Full-category overrides, applied before the target-modality mapping.
 * Transcription belongs in `audio` regardless of its `text` target;
 * `training` is fine-tuning (platform — dropped), `workflow`/`unknown` are
 * not generation endpoints.
 */
const FAL_CATEGORY_OVERRIDES: Record<string, Activity | null> = {
  'speech-to-text': 'audio',
  'audio-to-text': 'audio',
  training: null,
  workflow: null,
  unknown: null,
}

/**
 * Target modality (from `<source>-to-<target>` category names) → activity.
 * Speech and music land in `audio`; image/video/audio-to-text (captioning,
 * visual QA) land in `chat` like other text generation. Target modalities
 * outside the shared taxonomy (`3d`, `json`, `vision`, …) have no activity
 * in our six-value enum and classify to null (PR #622 kept them as their own
 * sub-groups; our catalog drops them until the taxonomy grows).
 */
const FAL_MODALITY_ACTIVITIES: Record<string, Activity> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  speech: 'audio',
  music: 'audio',
  text: 'chat',
  llm: 'chat',
}

export function falCategoryActivity(category: string): Activity | null {
  const override = FAL_CATEGORY_OVERRIDES[category]
  if (override !== undefined) return override
  const modality = category.replace(/^.+-to-/, '')
  return FAL_MODALITY_ACTIVITIES[modality] ?? null
}

function classify(_path: string, op: OpenApiOperation): Activity | null {
  const marker = op[FAL_ACTIVITY_MARKER]
  if (
    typeof marker === 'string' &&
    (activities as ReadonlyArray<string>).includes(marker)
  ) {
    return marker as Activity
  }
  return null
}

/**
 * Statuses worth retrying: rate limiting and transient upstream/gateway
 * failures. Anything else (401, 403, 404, …) is a real config problem and
 * fails fast.
 */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

const MAX_BACKOFF_MS = 15_000

/** A page that has not answered by now is retried like a dropped connection. */
const FETCH_TIMEOUT_MS = 60_000

/** Most `endpoint_id` filters the models API takes in one request. */
const ENDPOINT_FILTER_MAX = 50

/** Non-retryable upstream failure — thrown through the retry loop as-is. */
class FalFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/**
 * The paginated crawl is ~30 requests per pass and runs from both cron
 * tiers, so transient 429s/5xxs and dropped connections are routine — each
 * page gets exponential backoff (honoring `Retry-After` when sent) rather
 * than one throw sinking the whole sync and flagging the provider degraded.
 */
export async function fetchPageWithRetry(
  url: string,
  apiKey: string,
  attempts = 5,
): Promise<FalApiResponse> {
  let lastFailure = 'unknown failure'
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let retryAfterMs: number | null = null
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Key ${apiKey}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (response.ok) return (await response.json()) as FalApiResponse
      lastFailure = `${String(response.status)} ${response.statusText}`
      if (!RETRYABLE_STATUSES.has(response.status)) {
        throw new FalFetchError(
          `fal models fetch failed: ${lastFailure}`,
          response.status,
        )
      }
      const retryAfter = Number(response.headers.get('retry-after'))
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        retryAfterMs = retryAfter * 1000
      }
    } catch (error) {
      if (error instanceof FalFetchError) throw error
      // Network-level failure (or a truncated body mid-json()) — retryable.
      lastFailure = error instanceof Error ? error.message : String(error)
    }
    if (attempt < attempts) {
      const backoff = Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS)
      const waitMs = Math.min(retryAfterMs ?? backoff, MAX_BACKOFF_MS)
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }
  throw new Error(
    `fal models fetch failed after ${String(attempts)} attempts: ${lastFailure}`,
  )
}

async function fetchFalModels(
  apiKey: string,
  expandOpenApi: boolean,
  endpointIds: Array<string> = [],
): Promise<Array<FalApiModel>> {
  const allModels: Array<FalApiModel> = []
  let cursor: string | null = null
  do {
    const params = new URLSearchParams({ status: 'active' })
    if (expandOpenApi) params.set('expand', 'openapi-3.0')
    for (const id of endpointIds) params.append('endpoint_id', id)
    if (cursor) params.set('cursor', cursor)
    const data = await fetchPageWithRetry(
      `${FAL_MODELS_URL}?${params.toString()}`,
      apiKey,
    )
    allModels.push(...data.models)
    cursor = data.has_more ? data.next_cursor : null
  } while (cursor)
  return allModels
}

/**
 * Append {@link FAL_UNLISTED_ENDPOINT_IDS} that the active crawl did not
 * return. Only a 404 (the id is gone) is skipped, so the row is marked
 * removed. Any other failure throws: skipping it would also drop the row,
 * and the poller would emit a false `model.removed`.
 */
async function appendUnlistedFalModels(
  apiKey: string,
  models: Array<FalApiModel>,
  expandOpenApi: boolean,
): Promise<Array<FalApiModel>> {
  const seen = new Set(models.map((model) => model.endpoint_id))
  const extra: Array<FalApiModel> = []
  for (const id of FAL_UNLISTED_ENDPOINT_IDS) {
    if (seen.has(id)) continue
    let page: Array<FalApiModel>
    try {
      page = await fetchFalModels(apiKey, expandOpenApi, [id])
    } catch (error) {
      if (error instanceof FalFetchError && error.status === 404) continue
      throw error
    }
    const match = page.find((model) => model.endpoint_id === id)
    if (!match || seen.has(match.endpoint_id)) continue
    seen.add(match.endpoint_id)
    extra.push(match)
  }
  return extra.length === 0 ? models : [...models, ...extra]
}

function annotateOperations(spec: OpenApiDocument, activity: Activity): void {
  for (const operations of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(operations)) {
      op[FAL_ACTIVITY_MARKER] = activity
    }
  }
}

function hasPostOperation(spec: OpenApiDocument): boolean {
  for (const operations of Object.values(spec.paths ?? {})) {
    if (operations.post) return true
  }
  return false
}

/** `minimax/h3-max/director` → `fal-ai/minimax-h3-max-director`. */
export function falAppSlug(rawId: string): string {
  return `fal-ai/${rawId.replaceAll('/', '-')}`
}

export function falAsyncApiUrl(rawId: string): string {
  return `https://fal.ai/api/apps/${falAppSlug(rawId)}/asyncapi.json`
}

export function falLlmsTxtUrl(rawId: string): string {
  return `https://fal.ai/models/${rawId}/llms.txt`
}

const ASYNCAPI_CONTRACT_LINK = /\[AsyncAPI Contract\]\((https?:\/\/[^)\s]+)\)/i

export function parseAsyncApiContractUrl(llmsTxt: string): string | null {
  const match = ASYNCAPI_CONTRACT_LINK.exec(llmsTxt)
  return match?.[1] ?? null
}

async function fetchTextOrNull(url: string): Promise<string | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    return await response.text()
  } catch {
    return null
  }
}

async function discoverAsyncApiDocument(
  rawId: string,
): Promise<{ url: string; text: string } | null> {
  const llms = await fetchTextOrNull(falLlmsTxtUrl(rawId))
  const fromLlms = llms ? parseAsyncApiContractUrl(llms) : null
  const candidates = [...new Set([fromLlms, falAsyncApiUrl(rawId)])].filter(
    (url): url is string => typeof url === 'string' && url.length > 0,
  )
  for (const url of candidates) {
    const text = await fetchTextOrNull(url)
    if (text === null) continue
    try {
      const parsed: unknown = JSON.parse(text)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'asyncapi' in parsed &&
        typeof parsed.asyncapi === 'string'
      ) {
        return { url, text }
      }
    } catch {
      continue
    }
  }
  return null
}

function asyncApiDescription(document: unknown, rawId: string): string | null {
  if (typeof document !== 'object' || document === null) {
    return `AsyncAPI ${rawId}`
  }
  const info =
    'info' in document &&
    typeof document.info === 'object' &&
    document.info !== null
      ? document.info
      : null
  if (info && 'title' in info && typeof info.title === 'string') {
    return info.title
  }
  if (info && 'description' in info && typeof info.description === 'string') {
    return info.description
  }
  return `AsyncAPI ${rawId}`
}

async function fetchSpec(env: ProviderSecrets): Promise<SpecFetchResult> {
  const apiKey = env.FAL_KEY
  if (!apiKey) {
    return {
      specs: [],
      sources: [],
      outputStrategy: 'sibling-get',
      ...skippedResult('fal', 'FAL_KEY'),
    }
  }
  const models = await appendUnlistedFalModels(
    apiKey,
    await fetchFalModels(apiKey, true),
    true,
  )
  const specs: Array<OpenApiDocument> = []
  const sources: Array<SpecSource> = []
  const openApiPosted = new Set<string>()
  for (const model of models) {
    if (!model.openapi) continue
    const category = modelCategory(model)
    const activity = category === null ? null : falCategoryActivity(category)
    if (activity === null) continue
    const spec = model.openapi
    if (hasPostOperation(spec)) openApiPosted.add(model.endpoint_id)
    // FAL specs arrive embedded in the models API response (no standalone
    // file URL), so provenance hashes the embedded document as delivered —
    // before our annotations below.
    sources.push({
      url: `${FAL_MODELS_URL}?expand=openapi-3.0#${model.endpoint_id}`,
      hash: await contentHash(spec),
    })
    // Stash endpointId on info for the merge step (per-endpoint schema
    // dedup-renaming), mirroring the PR's x-fal-metadata trick.
    spec.info ??= {}
    spec.info['x-fal-endpoint-id'] = model.endpoint_id
    annotateOperations(spec, activity)
    specs.push(spec)
  }

  const bundledEndpoints: Array<BundledEndpoint> = []
  const asyncApiRawIds: Array<string> = []
  const warnings: Array<string> = []
  for (const model of models) {
    if (openApiPosted.has(model.endpoint_id)) continue
    const category = modelCategory(model)
    const activity = category === null ? null : falCategoryActivity(category)
    if (activity === null) continue
    try {
      const discovered = await discoverAsyncApiDocument(model.endpoint_id)
      if (!discovered) continue
      const document: unknown = JSON.parse(discovered.text)
      const extracted = extractAsyncApiSchemas(document)
      warnings.push(...extracted.warnings)
      if (!extracted.input && !extracted.output) continue
      bundledEndpoints.push({
        path: `/${model.endpoint_id}`,
        activity,
        description: asyncApiDescription(document, model.endpoint_id),
        source: {
          url: discovered.url,
          hash: await sha256Text(discovered.text),
        },
        derivation: 'upstream-spec',
        input: extracted.input,
        output: extracted.output,
        asyncapi: true,
      })
      asyncApiRawIds.push(model.endpoint_id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warnings.push(
        `fal ${model.endpoint_id}: asyncapi ingest failed: ${message}`,
      )
    }
  }

  return {
    specs,
    sources,
    outputStrategy: 'sibling-get',
    bundledEndpoints,
    asyncApiRawIds,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

interface ChatTokenPrice {
  card: NonNullable<ModelInfo['pricing']>
  source: FactSource
}

/**
 * Token cards for chat endpoints, from each endpoint's own llms.txt.
 * The hourly extract still owns the other ~1500 endpoints and any Pricing
 * section this parser will not stand behind. A missing Pricing heading is
 * a failed fetch (not cached); a heading with no token price is a real
 * page and stores nothing.
 */
async function loadChatTokenPrices(
  rawIds: Array<string>,
  docs: ReturnType<typeof docsRun>,
  kv: KVNamespace | undefined,
): Promise<Map<string, ChatTokenPrice | 'unavailable'>> {
  const out = new Map<string, ChatTokenPrice | 'unavailable'>()
  if (rawIds.length === 0) return out
  const loaded = await mapConcurrent(rawIds, 4, async (rawId) => {
    const url = falLlmsTxtUrl(rawId)
    const result = await tryDocs(docs, url, async (cached) => {
      const text = await cached(kv, url, async () => {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        if (!response.ok) {
          throw new Error(
            `fal ${rawId} llms.txt: ${String(response.status)} ${response.statusText}`,
          )
        }
        return await response.text()
      })
      const section = markdownSection(text, 'Pricing').trim()
      if (section.length === 0) {
        throw new Error(`fal ${rawId} llms.txt: no Pricing section`)
      }
      const hash = await sha256Text(section)
      const card = compileFalTokenCard(section, {
        url,
        hash,
        extractedAt: new Date().toISOString(),
      })
      const source: FactSource = {
        derivation: 'docs-extracted',
        sourceUrl: url,
        sourceHash: hash,
        path: 'Pricing',
      }
      return card === null ? { card: null, source } : { card, source }
    })
    return { rawId, result }
  })
  for (const item of loaded) {
    if (item.result === null) out.set(item.rawId, 'unavailable')
    else if (item.result.card !== null) {
      out.set(item.rawId, {
        card: item.result.card,
        source: item.result.source,
      })
    }
  }
  return out
}

async function listModels(
  env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const apiKey = env.FAL_KEY
  if (!apiKey) {
    return { models: [], ...skippedResult('fal', 'FAL_KEY') }
  }
  const listedModels = await fetchFalModels(apiKey, false)
  // The poll lists without specs (1,500 documents). Chat facts come from
  // the request schema, so fetch the few chat endpoints' specs by id. A
  // failed fetch is the chat rows' alone: they keep their stored chat
  // facts, and the other 1,500 rows still poll.
  const chat = listedModels.filter((m) => {
    const category = modelCategory(m)
    return category !== null && falCategoryActivity(category) === 'chat'
  })
  const chatIds = chat.map((m) => m.endpoint_id)
  const docs = docsRun()
  const chatFacts = await tryDocs(
    docs,
    `${FAL_MODELS_URL}?expand=openapi-3.0 (chat endpoints)`,
    async () => {
      const chatSpecs = new Map<string, OpenApiDocument | undefined>()
      for (let i = 0; i < chatIds.length; i += ENDPOINT_FILTER_MAX) {
        const page = await fetchFalModels(
          apiKey,
          true,
          chatIds.slice(i, i + ENDPOINT_FILTER_MAX),
        )
        for (const m of page) chatSpecs.set(m.endpoint_id, m.openapi)
      }
      const unanswered = chatIds.filter((id) => !chatSpecs.has(id))
      if (unanswered.length > 0) {
        throw new Error(
          `fal chat specs: models API left out ${unanswered.join(', ')}`,
        )
      }
      return new Map(
        chat.map((m) => [
          m.endpoint_id,
          falChatFacts(
            {
              endpoint_id: m.endpoint_id,
              description: m.metadata?.description,
              openapi: chatSpecs.get(m.endpoint_id),
            },
            FAL_MODELS_URL,
          ),
        ]),
      )
    },
  )
  const chatUnavailable = unavailable(
    'contextWindow',
    'maxOutput',
    'modalities',
    'capabilities',
    'reasoning',
    'requestMap',
  )
  const tokenPrices = await loadChatTokenPrices(chatIds, docs, kv)
  // After the chat spec request, so that request stays the second models
  // call. The lookup expands OpenAPI: unlisted rows carry no metadata, and
  // the category is on the document.
  const falModels = await appendUnlistedFalModels(apiKey, listedModels, true)
  const models: Array<ModelInfo> = falModels.map((m) => {
    const facts = chatFacts?.get(m.endpoint_id)
    const price = tokenPrices.get(m.endpoint_id)
    const card = price && price !== 'unavailable' ? price : null
    const absent = {
      ...(facts || !chatIds.includes(m.endpoint_id)
        ? {}
        : (chatUnavailable.absent ?? {})),
      ...(price === 'unavailable' ? { pricing: 'unavailable' as const } : {}),
    }
    const factSources: ModelFactSources = {
      ...facts?.factSources,
      ...(card ? { pricing: card.source } : {}),
    }
    const { factSources: _listedSources, ...rest } = facts ?? {}
    const category = modelCategory(m)
    return {
      rawId: m.endpoint_id,
      displayName: m.metadata?.display_name ?? null,
      activity: category === null ? null : falCategoryActivity(category),
      deprecated: modelDeprecated(m),
      releasedAt: isoToEpochSeconds(m.metadata?.date),
      ...(category ? { providerMetadata: { category } } : {}),
      // A chat row with a request schema also carries the flag list every
      // other provider's chat rows do.
      ...rest,
      ...(card ? { pricing: card.card } : {}),
      ...(Object.keys(factSources).length > 0 ? { factSources } : {}),
      ...(Object.keys(absent).length > 0 ? { absent } : {}),
    }
  })
  return { models, docsFailures: docsReport(docs) }
}

export const falProvider: ProviderConfig = {
  id: 'fal',
  displayName: 'FAL',
  authEnvVar: 'FAL_KEY',
  defaultDerivation: 'upstream-spec',
  specGrain: 'model',
  connect: {
    servers: [{ url: 'https://queue.fal.run' }],
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        description:
          'Send `Key <FAL_KEY>` (literal prefix "Key ", then the token).',
      },
    },
    security: [{ apiKey: [] }],
    siblingGet: true,
  },
  fetchSpec,
  listModels,
  classify,
}
