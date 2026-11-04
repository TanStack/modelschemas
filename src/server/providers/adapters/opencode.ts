/** OpenCode Zen: live ids, routes from OpenCode's models.dev catalog, prices from its console models page. */
import { openCodeRouteSpec, classifyOpenCodeRoute } from '../opencode-routes.ts'
import {
  loadOpenCodeCatalog,
  OPENCODE_CATALOG_URL,
  parseOpenCodeCatalog,
} from '../opencode-catalog.ts'
import { docsReport, docsRun, tryDocs } from '../model-facts.ts'
import {
  loadOpenCodePricing,
  OPENCODE_PRICING_URL,
} from '../opencode-pricing.ts'
import { fetchJson } from '../types.ts'
import { bearerConnect } from '../connect.ts'
import type { RateCard } from '@modelschemas/rate-card'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const OPENCODE_MODELS_URL = 'https://opencode.ai/inference/v1/models'

const FETCH_TIMEOUT_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseOpencodeModels(
  payload: unknown,
  tag = 'opencode',
): Array<ModelInfo> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error(`${tag}: models payload has no data array`)
  }
  const models: Array<ModelInfo> = []
  for (const row of payload.data) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) {
      continue
    }
    models.push({
      rawId: row.id,
      releasedAt: null,
      pricing: null,
    })
  }
  if (models.length === 0) {
    throw new Error(`${tag}: models payload listed no ids`)
  }
  return models
}

function withSources(
  listed: Array<ModelInfo>,
  catalog: Record<string, ModelInfo>,
  prices: Map<string, RateCard> | null,
): Array<ModelInfo> {
  return listed.map((model): ModelInfo => {
    const facts = catalog[model.rawId]
    const absent: NonNullable<ModelInfo['absent']> = {}
    if (facts?.releasedAt == null) absent.releasedAt = 'cleared'
    const out: ModelInfo = { ...model, ...facts }
    const card = prices?.get(model.rawId)
    if (!prices) absent.pricing = 'unavailable'
    // The console page is the only price source: an id it does not price
    // states no price, so a stored card is cleared.
    else if (!card) absent.pricing = 'cleared'
    else {
      out.pricing = card
      out.factSources = {
        ...facts?.factSources,
        pricing: {
          derivation: 'docs-derived',
          sourceUrl: OPENCODE_PRICING_URL,
          sourceHash: card.source.hash,
        },
      }
    }
    return Object.keys(absent).length ? { ...out, absent } : out
  })
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const docs = docsRun()
  const [payload, loaded, prices] = await Promise.all([
    fetchJson(OPENCODE_MODELS_URL, { signal }),
    loadOpenCodeCatalog(kv),
    tryDocs(docs, OPENCODE_PRICING_URL, (cached) =>
      loadOpenCodePricing(kv, cached),
    ),
  ])
  const catalog = parseOpenCodeCatalog(loaded.payload, 'opencode', loaded.hash)
  return {
    models: withSources(parseOpencodeModels(payload), catalog, prices),
    docsFailures: docsReport(docs),
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const loaded = await loadOpenCodeCatalog()
  const catalog = parseOpenCodeCatalog(loaded.payload, 'opencode', loaded.hash)
  return openCodeRouteSpec(
    Object.values(catalog),
    { url: OPENCODE_CATALOG_URL, hash: loaded.hash },
    false,
  )
}

// No `upstreamModelIdentity`, here or for OpenCode Go: OpenCode names no
// maker. `owned_by` is `opencode` on every row, and the catalog's AI SDK
// package names the wire protocol: `@ai-sdk/anthropic` also serves the Qwen
// rows, `@ai-sdk/openai` the Grok and Muse Spark rows.
export const provider: ProviderConfig = {
  id: 'opencode',
  displayName: 'OpenCode Zen',
  specSourceUrl: OPENCODE_CATALOG_URL,
  modelsEndpoint: OPENCODE_MODELS_URL,
  defaultDerivation: 'docs-derived',
  connect: bearerConnect('https://opencode.ai', 'OpenCode Zen'),
  bindSyncedRoutesOnly: true,
  bindStoredRoutesWithoutSchemas: true,
  fetchSpec,
  listModels,
  classify: classifyOpenCodeRoute,
}
