/**
 * Mistral — public OpenAPI 3.1 at docs.mistral.ai/openapi.yaml.
 * Models listing requires MISTRAL_API_KEY.
 */
import type { Activity } from '#/db/schema.ts'
import { listOpenAiCompatibleModels } from '../openai-compat.ts'
import {
  MISTRAL_DEPRECATIONS_URL,
  loadDeprecations,
  parseMistralDeprecations,
} from '../deprecations.ts'
import { docsReport, docsRun, tryDocs, unavailable } from '../model-facts.ts'
import {
  mistralGenerationEndpointId,
  mistralModelActivity,
} from '../model-meta.ts'
import {
  MISTRAL_PRICING_URL,
  copyMistralAliasFacts,
  mistralModelPricing,
} from '../mistral-pricing.ts'
import {
  MISTRAL_OPENAPI_URL,
  mistralChatWire,
  mistralRequestMap,
} from '../mistral-request.ts'
import {
  MISTRAL_REASONING_URL,
  listsReasoning,
  mistralModelReasoning,
  overlayModelFacts,
} from '../reasoning-config.ts'
import { fetchOpenApi } from '../types.ts'
import { bearerConnect } from '../connect.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const MISTRAL_MODELS_URL = 'https://api.mistral.ai/v1/models'

/**
 * Generation surface only. Chat/fim/agents-completions are chat;
 * classifiers that are not moderation, OCR, conversations CRUD, files,
 * fine-tune, batch, and admin classify to null.
 */
function classify(path: string): Activity | null {
  const bare = path.includes('#') ? path.slice(0, path.indexOf('#')) : path
  if (
    bare === '/v1/chat/completions' ||
    bare === '/v1/fim/completions' ||
    bare === '/v1/agents/completions'
  ) {
    return 'chat'
  }
  if (bare === '/v1/embeddings') return 'embeddings'
  if (bare === '/v1/moderations' || bare === '/v1/chat/moderations') {
    return 'moderation'
  }
  if (bare === '/v1/audio/speech' || bare === '/v1/audio/transcriptions') {
    return 'audio'
  }
  return null
}

/**
 * A page we read that names no price clears a stored card. Mutual aliases
 * of that page clear too, unless one of them has a price.
 */
function clearUnpriced(
  models: Array<ModelInfo>,
  seen: ReadonlySet<string>,
  aliases: ReadonlyMap<string, ReadonlyArray<string>>,
): void {
  const byId = new Map(models.map((model) => [model.rawId, model]))
  const clear = (model: ModelInfo | undefined) => {
    if (!model || model.pricing != null) return
    model.absent = { ...model.absent, pricing: 'cleared' }
  }
  for (const model of models) {
    if (seen.has(model.rawId)) clear(model)
  }
  for (const [id, names] of aliases) {
    const clique = [id, ...names].filter(
      (other) =>
        byId.has(other) && (other === id || aliases.get(other)?.includes(id)),
    )
    if (!clique.some((other) => seen.has(other))) continue
    if (clique.some((other) => byId.get(other)?.pricing != null)) continue
    for (const other of clique) clear(byId.get(other))
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(MISTRAL_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: MISTRAL_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

export const provider: ProviderConfig = {
  id: 'mistral',
  displayName: 'Mistral',
  authEnvVar: 'MISTRAL_API_KEY',
  specSourceUrl: MISTRAL_OPENAPI_URL,
  modelsEndpoint: MISTRAL_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  connect: bearerConnect('https://api.mistral.ai'),
  fetchSpec,
  listModels: async (env, kv): Promise<ListModelsResult> => {
    const aliases = new Map<string, Array<string>>()
    const listed = await listOpenAiCompatibleModels({
      providerId: 'mistral',
      url: MISTRAL_MODELS_URL,
      env,
      envVar: 'MISTRAL_API_KEY',
      activity: mistralModelActivity,
      extend: (row) => {
        const names = row.aliases?.filter(
          (id) => typeof id === 'string' && id.length > 0,
        )
        if (names && names.length > 0) aliases.set(row.id, names)
        return Promise.resolve({})
      },
    })
    if (listed.models.length === 0) return listed
    const chat = listed.models.some((model) => model.activity === 'chat')
    const docs = docsRun()
    const deprecations = await loadDeprecations(
      docs,
      kv,
      MISTRAL_DEPRECATIONS_URL,
      parseMistralDeprecations,
    )
    // The pricing load reads the pricing table, changelog, models index,
    // model pages and web search guide; a failing docs page keeps the
    // stored facts instead of failing the poll.
    const [pricing, reasoning, wire] = await Promise.all([
      tryDocs(docs, MISTRAL_PRICING_URL, (cached) =>
        mistralModelPricing(
          kv,
          listed.models.map((model) => model.rawId),
          cached,
        ),
      ),
      tryDocs(docs, MISTRAL_REASONING_URL, (cached) =>
        mistralModelReasoning(kv, cached),
      ),
      chat ? mistralChatWire(kv) : Promise.resolve(null),
    ])
    const models = listed.models.map((model) =>
      overlayModelFacts(
        model,
        pricing
          ? pricing(model.rawId)
          : unavailable('pricing', 'serverTools', 'modalities', 'maxOutput'),
        reasoning
          ? reasoning(model.rawId, listsReasoning(model.capabilities))
          : unavailable('reasoning'),
      ),
    )
    copyMistralAliasFacts(models, aliases)
    if (wire) {
      for (const model of models) {
        if (model.activity !== 'chat') continue
        // The thinking request comes from the reasoning facts; keep the
        // stored map whole rather than write one built without them.
        if (!reasoning) {
          model.absent = { ...model.absent, requestMap: 'unavailable' }
          continue
        }
        model.requestMap = mistralRequestMap(wire, model.reasoning)
        model.factSources = {
          ...model.factSources,
          requestMap: {
            derivation: 'docs-derived',
            sourceUrl: MISTRAL_OPENAPI_URL,
            sourceHash: wire.hash,
            path: '/components/schemas/ChatCompletionRequest',
          },
        }
      }
    }
    if (pricing) clearUnpriced(models, pricing.seen, aliases)
    return {
      ...listed,
      models,
      ...(deprecations ? { deprecations } : {}),
      docsFailures: docsReport(docs),
    }
  },
  classify,
  generationEndpointId: ({ rawId, activity }) =>
    mistralGenerationEndpointId(rawId, activity),
}
