/**
 * Groq — official OpenAPI spec bundled in Groq's Stainless-generated Python
 * SDK: `scripts/mock` embeds it as base64+gzip `EMBEDDED_SPEC` (refreshed on
 * every SDK codegen). `.stats.yml` stopped carrying `openapi_spec_url` on
 * 2026-08-11. The hinted console URL is docs, not a spec.
 */
import type { Activity } from '#/db/schema.ts'
import {
  classifyOpenAiCompat,
  listOpenAiCompatibleModels,
} from '../openai-compat.ts'
import { GROQ_PRICING_URL, groqModelPricing } from '../groq-pricing.ts'
import { docsReport, docsRun, tryDocs, unavailable } from '../model-facts.ts'
import {
  GROQ_DEPRECATIONS_URL,
  loadDeprecations,
  parseGroqDeprecations,
} from '../deprecations.ts'
import {
  groqModelReasoning,
  listsReasoning,
  overlayModelFacts,
} from '../reasoning-config.ts'
import { groqModelServerTools } from '../server-tools.ts'
import { groqGenerationEndpointId, groqModelActivity } from '../model-meta.ts'
import { fetchText, parseGzippedOpenApi } from '../types.ts'
import { bearerConnect } from '../connect.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const GROQ_MOCK_URL =
  'https://raw.githubusercontent.com/groq/groq-python/main/scripts/mock'
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models'

/**
 * Stainless paths are `/openai/v1/...` (server is `https://api.groq.com`).
 * Strip that prefix and reuse the OpenAI-compat path map. Batches, files,
 * fine-tunes, models, and rerank classify null.
 */
function classify(path: string): Activity | null {
  const withoutOpenAi = path.startsWith('/openai/')
    ? path.slice('/openai'.length)
    : path
  return classifyOpenAiCompat(withoutOpenAi)
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const script = await fetchText(GROQ_MOCK_URL)
  const blob = script.match(/EMBEDDED_SPEC="([A-Za-z0-9+/=\s]+)"/)?.[1]
  if (!blob) {
    throw new Error(`groq: no EMBEDDED_SPEC in ${GROQ_MOCK_URL}`)
  }
  const bytes = Uint8Array.from(atob(blob.replace(/\s/g, '')), (c) =>
    c.charCodeAt(0),
  )
  return parseGzippedOpenApi(bytes, 'groq', GROQ_MOCK_URL)
}

async function listModels(
  env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const listed = await listOpenAiCompatibleModels({
    providerId: 'groq',
    url: GROQ_MODELS_URL,
    env,
    envVar: 'GROQ_API_KEY',
    activity: groqModelActivity,
  })
  if (listed.models.length === 0) return listed
  const docs = docsRun()
  // Pricing reads several docs pages; one failing keeps the stored cards.
  const [pricing, reasoning, tools] = await Promise.all([
    tryDocs(docs, GROQ_PRICING_URL, (cached) => groqModelPricing(kv, cached)),
    groqModelReasoning(
      kv,
      docs,
      listed.models.map((model) => model.rawId),
    ),
    groqModelServerTools(kv),
  ])
  const deprecations = await loadDeprecations(
    docs,
    kv,
    GROQ_DEPRECATIONS_URL,
    parseGroqDeprecations,
  )
  return {
    ...listed,
    models: listed.models.map((model) =>
      overlayModelFacts(
        model,
        pricing ? pricing(model.rawId) : unavailable('pricing'),
        reasoning(model.rawId, listsReasoning(model.capabilities)),
        tools(model.rawId),
      ),
    ),
    ...(deprecations ? { deprecations } : {}),
    docsFailures: docsReport(docs),
  }
}

export const provider: ProviderConfig = {
  id: 'groq',
  displayName: 'Groq',
  authEnvVar: 'GROQ_API_KEY',
  specSourceUrl: GROQ_MOCK_URL,
  modelsEndpoint: GROQ_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  connect: bearerConnect('https://api.groq.com'),
  fetchSpec,
  listModels,
  classify,
  generationEndpointId: ({ rawId, activity }) =>
    groqGenerationEndpointId(rawId, activity),
}
