/**
 * Cohere — official OpenAPI YAML from cohere-ai/cohere-developer-experience
 * (public). Models list requires COHERE_API_KEY.
 */
import type { Activity } from '#/db/schema.ts'
import { cohereModelDocFacts } from '../cohere-model-docs.ts'
import { cohereCommandPageFacts } from '../cohere-model-pages.ts'
import { cohereModelPricing } from '../cohere-pricing.ts'
import { openAiCompatModelFacts } from '../openai-compat.ts'
import {
  cohereModelReasoning,
  listsReasoning,
  overlayModelFacts,
} from '../reasoning-config.ts'
import { fetchJson, fetchOpenApi, skippedResult } from '../types.ts'
import { bearerConnect } from '../connect.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const COHERE_OPENAPI_URL =
  'https://raw.githubusercontent.com/cohere-ai/cohere-developer-experience/main/cohere-openapi.yaml'
const COHERE_MODELS_URL = 'https://api.cohere.com/v1/models'
/** Public id of the synced `POST /v2/chat` schema. */
const COHERE_CHAT_ENDPOINT = 'v2/chat'

/**
 * Chat (v1/v2 + legacy generate/summarize) and embed. Audio transcriptions
 * are generation; rerank/classify/datasets/finetune/batches/admin drop.
 */
function classify(path: string): Activity | null {
  const bare = path.split('?')[0] ?? path
  if (
    bare === '/v1/chat' ||
    bare === '/v2/chat' ||
    bare === '/chat' ||
    bare === '/v1/generate' ||
    bare === '/v1/summarize'
  ) {
    return 'chat'
  }
  if (bare === '/v1/embed' || bare === '/v2/embed') return 'embeddings'
  if (bare === '/v2/audio/transcriptions') return 'audio'
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(COHERE_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: COHERE_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

export interface CohereModel {
  name?: string
  is_deprecated?: boolean
  endpoints?: Array<string>
  context_length?: number
  features?: Array<string> | null
}

interface CohereModelList {
  models?: Array<CohereModel>
  next_page_token?: string
}

function activityFromEndpoints(
  endpoints: Array<string> | undefined,
): Activity | null {
  if (!endpoints?.length) return null
  if (
    endpoints.includes('chat') ||
    endpoints.includes('generate') ||
    endpoints.includes('summarize')
  ) {
    return 'chat'
  }
  if (endpoints.includes('embed')) return 'embeddings'
  return null
}

/**
 * Facts one listing row states. For a chat row `features` is the model's
 * own list, so its flags are exact: every chat row binds the one `/v2/chat`
 * body, and walking that would stamp `thinking` and `tools` on models that
 * reject them. A row with no `features` states no flags and no modalities.
 */
export function listedFacts(m: CohereModel, rawId: string): ModelInfo {
  const activity = activityFromEndpoints(m.endpoints)
  const facts = openAiCompatModelFacts({
    id: rawId,
    context_length: m.context_length,
    features: m.features ?? undefined,
  })
  const base: ModelInfo = {
    rawId,
    activity,
    deprecated: m.is_deprecated ?? false,
    ...facts,
  }
  if (activity !== 'chat') return base
  const chat: ModelInfo = {
    ...base,
    exactCapabilities: true,
    schemaEndpointId: m.endpoints?.includes('chat')
      ? COHERE_CHAT_ENDPOINT
      : null,
  }
  if (!m.features) return chat
  const listed: Array<unknown> = Array.isArray(facts.capabilities)
    ? facts.capabilities
    : []
  const flags = m.features.includes('logprobs')
    ? [...listed, 'logprobs']
    : listed
  return {
    ...chat,
    ...(flags.length > 0 ? { capabilities: flags } : {}),
    modalities: {
      input: m.features.includes('vision') ? ['text', 'image'] : ['text'],
      output: ['text'],
    },
  }
}

async function listModels(
  env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const key = env.COHERE_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('cohere', 'COHERE_API_KEY') }
  }
  const [docs, pricing, pages, reasoning] = await Promise.all([
    cohereModelDocFacts(kv),
    cohereModelPricing(kv),
    cohereCommandPageFacts(kv),
    cohereModelReasoning(kv),
  ])
  const models: ListModelsResult['models'] = []
  let pageToken: string | undefined
  do {
    const url = new URL(COHERE_MODELS_URL)
    url.searchParams.set('page_size', '1000')
    if (pageToken) url.searchParams.set('page_token', pageToken)
    const body = (await fetchJson(url.toString(), {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    })) as CohereModelList
    for (const m of body.models ?? []) {
      if (typeof m.name !== 'string' || m.name.length === 0) continue
      const listed = listedFacts(m, m.name)
      const priced = pricing(m.name)
      const page = pages(m.name)
      // A pricing-page card stays sourced there. The model page fills a
      // price only when that page is the one that states it.
      const { pricing: pageCard, factSources: pageSources, ...pageRest } = page
      const pagePatch =
        priced.pricing || !pageCard
          ? {
              ...pageRest,
              ...(pageSources?.knowledgeCutoff
                ? {
                    factSources: {
                      knowledgeCutoff: pageSources.knowledgeCutoff,
                    },
                  }
                : {}),
            }
          : page
      models.push(
        overlayModelFacts(
          listed,
          docs(m.name),
          priced,
          pagePatch,
          reasoning(m.name, listsReasoning(listed.capabilities)),
        ),
      )
    }
    const next = body.next_page_token
    pageToken = next && next !== pageToken ? next : undefined
  } while (pageToken)
  return { models }
}

export const provider: ProviderConfig = {
  id: 'cohere',
  displayName: 'Cohere',
  authEnvVar: 'COHERE_API_KEY',
  specSourceUrl: COHERE_OPENAPI_URL,
  modelsEndpoint: COHERE_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  connect: bearerConnect('https://api.cohere.com'),
  fetchSpec,
  listModels,
  classify,
}
