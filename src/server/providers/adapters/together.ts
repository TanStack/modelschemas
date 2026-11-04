/**
 * Together AI — public OpenAPI 3.1 at docs.together.ai/openapi.yaml.
 * Generation: chat/completions, embeddings, images, video, audio.
 * Platform/admin (files, fine-tunes, endpoints, batches, rerank) classify
 * null. listModels requires TOGETHER_API_KEY; Together returns a bare array.
 */
import {
  togetherNativeThinking,
  applyTogetherNativeThinking,
} from '../together-native-thinking.ts'
import { compileTokenCard } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'
import { docsReport, docsRun, tryDocs } from '../model-facts.ts'
import {
  TOGETHER_REASONING_QUICKSTARTS,
  TOGETHER_REASONING_URL,
  applyTogetherDocs,
  loadTogetherQuickstart,
  loadTogetherReasoningPage,
  togetherGptOssFamilyMatches,
  togetherNamedHybridMatches,
  loadTogetherServerlessChat,
  reasoningHit,
  supportedFactSources,
} from '../together-facts.ts'
import { togetherMediaPricing } from '../together-pricing.ts'
import { fetchJson, fetchOpenApi, sha256Text, skippedResult } from '../types.ts'
import { bearerConnect } from '../connect.ts'
import type { RateCard } from '@modelschemas/rate-card'
import type {
  FactSource,
  ListModelsResult,
  ModelFactSources,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const TOGETHER_OPENAPI_URL = 'https://docs.together.ai/openapi.yaml'
const TOGETHER_MODELS_URL = 'https://api.together.xyz/v1/models'
const TOGETHER_SUPPORTED_URL = 'https://api.together.ai/v2/supported-models'

const MODEL_TYPE_ACTIVITY: Record<string, Activity> = {
  chat: 'chat',
  language: 'chat',
  code: 'chat',
  image: 'image',
  video: 'video',
  audio: 'audio',
  embedding: 'embeddings',
  embeddings: 'embeddings',
  moderation: 'moderation',
}

function barePath(path: string): string {
  return path.replace(/^\/v\d+/, '')
}

const TOGETHER_MODALITY: Record<string, string> = {
  MODALITY_TEXT: 'text',
  MODALITY_IMAGE: 'image',
  MODALITY_AUDIO: 'audio',
  MODALITY_VIDEO: 'video',
}

const TOGETHER_FEATURES: Record<string, Array<string>> = {
  FEATURE_TOOL_CALLING: ['tools'],
  FEATURE_STRUCTURED_OUTPUT: ['structured_outputs', 'response_format'],
  FEATURE_REASONING: ['reasoning'],
}

function togetherModalities(values: Array<string> | undefined): Array<string> {
  return (values ?? []).flatMap((value) =>
    TOGETHER_MODALITY[value] ? [TOGETHER_MODALITY[value]] : [],
  )
}

interface TogetherSupportedModel {
  name?: string
  inputModalities?: Array<string>
  outputModalities?: Array<string>
  features?: Array<string>
}

/** Page through v2 supported-models. `name` matches a v1 catalog id. */
async function togetherSupportedFacts(
  key: string,
): Promise<
  Map<string, Pick<ModelInfo, 'modalities' | 'capabilities' | 'factSources'>>
> {
  const facts = new Map<
    string,
    Pick<ModelInfo, 'modalities' | 'capabilities' | 'factSources'>
  >()
  let after: string | undefined
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(TOGETHER_SUPPORTED_URL)
    url.searchParams.set('limit', '100')
    if (after) url.searchParams.set('after', after)
    const body = (await fetchJson(url.toString(), {
      headers: { Authorization: `Bearer ${key}` },
    })) as { data?: Array<TogetherSupportedModel>; next_cursor?: string | null }
    for (const row of body.data ?? []) {
      if (!row.name) continue
      const input = togetherModalities(row.inputModalities)
      const output = togetherModalities(row.outputModalities)
      const capabilities = (row.features ?? []).flatMap(
        (feature) => TOGETHER_FEATURES[feature] ?? [],
      )
      const modalities =
        input.length > 0 || output.length > 0 ? { input, output } : null
      facts.set(row.name, {
        ...(modalities ? { modalities } : {}),
        ...(capabilities.length > 0 ? { capabilities } : {}),
        factSources: supportedFactSources({
          ...(modalities ? { modalities } : {}),
          ...(capabilities.length > 0 ? { capabilities } : {}),
        }),
      })
    }
    if (!body.next_cursor) break
    after = body.next_cursor
  }
  return facts
}

function classify(path: string): Activity | null {
  const bare = barePath(path)
  if (bare === '/chat/completions' || bare === '/completions') return 'chat'
  if (bare === '/embeddings') return 'embeddings'
  if (bare === '/images/generations') return 'image'
  if (bare === '/videos') return 'video'
  if (
    bare === '/audio/speech' ||
    bare === '/audio/transcriptions' ||
    bare === '/audio/translations'
  ) {
    return 'audio'
  }
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(TOGETHER_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: TOGETHER_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asModels(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) {
    return body.filter((item): item is Record<string, unknown> =>
      isRecord(item),
    )
  }
  if (isRecord(body) && Array.isArray(body.data)) {
    return body.data.filter((item): item is Record<string, unknown> =>
      isRecord(item),
    )
  }
  return []
}

/**
 * Together prices per million tokens on the listing (`{ input: 0.88,
 * output: 0.88, cached_input: 0.2, hourly: 0, base: 0, finetune: 0 }`).
 * An all-zero object is a model it does not quote per token (dedicated
 * endpoints, or no published serverless rate) — unknown, not free, so it
 * compiles to null rather than a $0 card. `hourly`/`base`/`finetune` are
 * dedicated-endpoint and training rates, not per-request levers. A zero
 * `cached_input` is unpublished, not a free cache read. Image, video, and
 * audio prices come from the serverless catalog, not this token object.
 */
export async function togetherRateCard(
  pricing: unknown,
): Promise<RateCard | null> {
  if (!isRecord(pricing)) return null
  const perToken = (key: string): number | null =>
    typeof pricing[key] === 'number' ? pricing[key] / 1e6 : null
  const rates: Record<string, number> = {}
  const input = perToken('input')
  const output = perToken('output')
  const cached = perToken('cached_input')
  if (input !== null) rates.input_tokens = input
  if (output !== null) rates.output_tokens = output
  if (cached !== null && cached > 0) rates.cache_read_tokens = cached
  return compileTokenCard(rates, [], {
    url: TOGETHER_MODELS_URL,
    hash: await sha256Text(JSON.stringify(pricing)),
    extractedAt: new Date().toISOString(),
  })
}

const MEDIA_ACTIVITIES = new Set(['image', 'video', 'audio'])

function listingFact(path: string): FactSource {
  return { derivation: 'listing', sourceUrl: TOGETHER_MODELS_URL, path }
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

function mergeSources(
  base: ModelFactSources | undefined,
  extra: ModelFactSources | undefined,
): ModelFactSources | undefined {
  if (!extra) return base
  const capabilities =
    base?.capabilities || extra.capabilities
      ? { ...base?.capabilities, ...extra.capabilities }
      : undefined
  const merged: ModelFactSources = { ...base, ...extra }
  if (capabilities) merged.capabilities = capabilities
  else delete merged.capabilities
  return merged
}

async function listModels(
  env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const key = env.TOGETHER_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('together', 'TOGETHER_API_KEY') }
  }
  const body = await fetchJson(TOGETHER_MODELS_URL, {
    headers: { Authorization: `Bearer ${key}` },
  })
  const rows = asModels(body).flatMap((item) => {
    if (typeof item.id !== 'string' || item.id.length === 0) return []
    const type = item.type
    const activity =
      typeof type === 'string' ? (MODEL_TYPE_ACTIVITY[type] ?? null) : null
    return [{ item, activity }]
  })
  const media = rows.some((row) =>
    row.activity ? MEDIA_ACTIVITIES.has(row.activity) : false,
  )
    ? await togetherMediaPricing(kv)
    : null
  const models: Array<ModelInfo> = []
  for (const { item, activity } of rows) {
    const contextWindow = positiveNumber(item.context_length)
    const config = isRecord(item.config) ? item.config : null
    const maxOutput = positiveNumber(config?.max_output_length)
    const factSources: ModelFactSources = {}
    if (contextWindow != null) {
      factSources.contextWindow = listingFact('context_length')
    }
    if (maxOutput != null)
      factSources.maxOutput = listingFact('config.max_output_length')
    const model: ModelInfo = {
      rawId: item.id as string,
      requestMap: null,
      displayName:
        typeof item.display_name === 'string' ? item.display_name : null,
      activity,
      contextWindow,
      maxOutput,
      releasedAt: typeof item.created === 'number' ? item.created : null,
      ...(Object.keys(factSources).length > 0 ? { factSources } : {}),
    }
    if (media && activity && MEDIA_ACTIVITIES.has(activity)) {
      const priced = media(item.id as string, activity)
      Object.assign(model, priced)
      // The catalog was read and rates no price for this row, so a card
      // stored from the listing's token object is stale (issue #258).
      if (!priced.pricing) model.absent = { pricing: 'cleared' }
    } else {
      const card = await togetherRateCard(item.pricing)
      if (card) {
        model.pricing = card
        model.factSources = {
          ...model.factSources,
          pricing: listingFact('pricing'),
        }
      }
    }
    models.push(model)
  }
  const nativeThinking = models.some((model) => model.activity === 'chat')
    ? await togetherNativeThinking(kv)
    : []
  const supported = await togetherSupportedFacts(key)
  const docs = docsRun()
  const [chatDocs, reasoningPage, quickstarts] = await Promise.all([
    tryDocs(
      docs,
      'https://docs.together.ai/docs/serverless/models.md',
      (cached) => loadTogetherServerlessChat(kv, cached),
    ),
    tryDocs(docs, TOGETHER_REASONING_URL, (cached) =>
      loadTogetherReasoningPage(kv, cached),
    ),
    Promise.all(
      TOGETHER_REASONING_QUICKSTARTS.map((url) =>
        tryDocs(docs, url, (cached) => loadTogetherQuickstart(kv, cached, url)),
      ),
    ),
  ])
  const reasoning = new Map<string, ReturnType<typeof reasoningHit>>()
  if (reasoningPage) {
    for (const [id, mode] of Object.entries(reasoningPage.byId)) {
      reasoning.set(
        id,
        reasoningHit(mode, TOGETHER_REASONING_URL, reasoningPage.hash),
      )
    }
    if (reasoningPage.gptOssFamily) {
      for (const model of models) {
        if (
          model.activity !== 'chat' ||
          !togetherGptOssFamilyMatches(model.displayName ?? null) ||
          reasoning.has(model.rawId)
        )
          continue
        reasoning.set(
          model.rawId,
          reasoningHit(
            reasoningPage.gptOssFamily,
            TOGETHER_REASONING_URL,
            reasoningPage.hash,
            reasoningPage.familyThinking.effort,
          ),
        )
      }
    }
    if (reasoningPage.namedHybrid) {
      for (const model of models) {
        if (
          model.activity !== 'chat' ||
          !togetherNamedHybridMatches(
            model.rawId,
            reasoningPage.namedHybrid.nativeBasename,
          ) ||
          reasoning.has(model.rawId)
        )
          continue
        reasoning.set(
          model.rawId,
          reasoningHit(
            reasoningPage.namedHybrid.reasoning,
            TOGETHER_REASONING_URL,
            reasoningPage.hash,
            reasoningPage.familyThinking.hybrid,
          ),
        )
      }
    }
  }
  TOGETHER_REASONING_QUICKSTARTS.forEach((url, index) => {
    const page = quickstarts[index]
    if (!page) return
    for (const [id, mode] of Object.entries(page.byId)) {
      reasoning.set(id, reasoningHit(mode, url, page.hash))
    }
  })
  const pageMeta = reasoningPage
    ? { loaded: true, hash: reasoningPage.hash }
    : { loaded: false, hash: '' }
  return {
    models: models.map((model) => {
      const extra = supported.get(model.rawId)
      const withSupported: ModelInfo = {
        ...model,
        ...(extra?.modalities ? { modalities: extra.modalities } : {}),
        ...(extra?.capabilities ? { capabilities: extra.capabilities } : {}),
      }
      const merged = mergeSources(model.factSources, extra?.factSources)
      if (merged) withSupported.factSources = merged
      return applyTogetherNativeThinking(
        applyTogetherDocs(
          withSupported,
          chatDocs,
          reasoning,
          pageMeta.loaded ? pageMeta : null,
        ),
        nativeThinking,
      )
    }),
    docsFailures: docsReport(docs),
  }
}

export const provider: ProviderConfig = {
  id: 'together',
  // LLM Gateway route name (providers[].providerId).
  modelNamespaces: ['together-ai'],
  displayName: 'Together AI',
  authEnvVar: 'TOGETHER_API_KEY',
  specSourceUrl: TOGETHER_OPENAPI_URL,
  modelsEndpoint: TOGETHER_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  connect: bearerConnect('https://api.together.ai'),
  fetchSpec,
  listModels,
  classify,
  // The shared chat body publishes `reasoning` and `reasoning_effort` for
  // every model on the route. Together only states those per model.
  perModelSchemaFlags: ['reasoning', 'reasoning_effort'],
  generationEndpointId: ({ activity }) => {
    switch (activity) {
      case 'chat':
        return 'chat/completions'
      case 'embeddings':
        return 'embeddings'
      case 'image':
        return 'images/generations'
      case 'video':
        return 'videos'
      case 'audio':
        return 'audio/speech'
      default:
        return null
    }
  },
}
