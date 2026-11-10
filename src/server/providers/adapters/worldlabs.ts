/**
 * World Labs Marble. The public OpenAPI document is the Mintlify spec at
 * docs.worldlabs.ai (the API host's /openapi.json 404s). TanStack AI
 * generates its client from GET /v1/openapi/worldlabs.
 *
 * The model list is the public models page, not a keyed endpoint, so
 * listModels does not skip when WORLDLABS_API_KEY is absent. The key is
 * the data-plane `WLT-Api-Key` header.
 */
import type { Activity } from '#/db/schema.ts'
import { headerApiKeyConnect } from '../connect.ts'
import {
  docsReport,
  docsRun,
  tryDocs,
  unavailable,
  assertParsed,
  markdownTableRows,
} from '../model-facts.ts'
import { tagDocsFacts } from '../fact-sources.ts'
import { overlayModelFacts } from '../reasoning-config.ts'
import { fetchOpenApi, fetchText } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'
import {
  WORLDLABS_PRICING_URL,
  worldlabsModelPricing,
} from '../worldlabs-pricing.ts'

export const WORLDLABS_OPENAPI_URL =
  'https://docs.worldlabs.ai/api/reference/openapi.yaml'
export const WORLDLABS_MODELS_URL = 'https://docs.worldlabs.ai/api/models.md'
const GENERATE_DOCS_URL =
  'https://docs.worldlabs.ai/api/reference/worlds/generate'
export const WORLDLABS_API_BASE = 'https://api.worldlabs.ai'
const GENERATE_PATH = '/marble/v1/worlds:generate'

const WORLD_PATHS = new Set([
  GENERATE_PATH,
  '/marble/v1/worlds/{world_id}',
  '/marble/v1/worlds/{world_id}:export',
  '/marble/v1/worlds:list',
  '/marble/v1/operations/{operation_id}',
  '/marble/v1/media-assets:prepare_upload',
  '/marble/v1/media-assets/{media_asset_id}',
  '/marble/v1/pano:depth_to_rgb',
  '/marble/v1/credits',
])

const API_ID = /^marble-\d+\.\d+(?:-[a-z0-9]+)?$/

const MODALITIES = {
  input: ['text', 'image', 'video'],
  output: null,
}

function unquote(cell: string): string {
  return cell.replace(/`/g, '').trim()
}

export interface WorldlabsModelRow {
  rawId: string
  displayName: string
  aliases: Array<string>
}

/** Models page mapping table, plus the legacy `model` values it names. */
export function parseWorldlabsModels(
  page: string,
): Map<string, WorldlabsModelRow> {
  const models = new Map<string, WorldlabsModelRow>()
  const aliases = new Map<string, Array<string>>()
  for (const row of markdownTableRows(page)) {
    const left = unquote(row[0] ?? '')
    const right = unquote(row[1] ?? '')
    if (API_ID.test(right) && left.length > 0 && !API_ID.test(left)) {
      models.set(right, { rawId: right, displayName: left, aliases: [] })
    } else if (API_ID.test(left) && right.length > 0 && !API_ID.test(right)) {
      const prior = aliases.get(left) ?? []
      prior.push(right)
      aliases.set(left, prior)
    }
  }
  if (models.size === 0) return models
  for (const [rawId, names] of aliases) {
    const model = models.get(rawId)
    if (!model) {
      throw new Error(
        `worldlabs models: legacy alias for ${rawId}, which the mapping table omits`,
      )
    }
    model.aliases = names
  }
  for (const id of [
    'marble-1.1-plus',
    'marble-1.1',
    'marble-1.0',
    'marble-1.0-draft',
  ]) {
    if (!models.has(id)) throw new Error(`worldlabs models: page omits ${id}`)
  }
  return models
}

function classify(path: string): Activity | null {
  const bare = path.split('?')[0] ?? path
  return WORLD_PATHS.has(bare) ? 'world' : null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(WORLDLABS_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: WORLDLABS_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const text = await fetchText(WORLDLABS_MODELS_URL)
  const parsed = parseWorldlabsModels(text)
  assertParsed(parsed, 'worldlabs models page')
  const docs = docsRun()
  const pricing = await tryDocs(docs, WORLDLABS_PRICING_URL, (cached) =>
    worldlabsModelPricing(kv, cached),
  )
  const modalitySources = tagDocsFacts(
    { modalities: MODALITIES },
    GENERATE_DOCS_URL,
  )
  const models: Array<ModelInfo> = [...parsed.values()].map((model) =>
    overlayModelFacts(
      {
        rawId: model.rawId,
        displayName: model.displayName,
        activity: 'world',
        aliases: model.aliases.length > 0 ? model.aliases : null,
        modalities: MODALITIES,
        factSources: modalitySources,
      },
      pricing?.(model.rawId) ?? unavailable('pricing'),
    ),
  )
  return { models, docsFailures: docsReport(docs) }
}

export const provider: ProviderConfig = {
  id: 'worldlabs',
  displayName: 'World Labs',
  authEnvVar: 'WORLDLABS_API_KEY',
  specSourceUrl: WORLDLABS_OPENAPI_URL,
  modelsEndpoint: WORLDLABS_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  connect: headerApiKeyConnect(WORLDLABS_API_BASE, 'WLT-Api-Key'),
  fetchSpec,
  listModels,
  classify,
  classifyGets: true,
  generationEndpointId: ({ activity }) =>
    activity === 'world' ? GENERATE_PATH.slice(1) : null,
}
