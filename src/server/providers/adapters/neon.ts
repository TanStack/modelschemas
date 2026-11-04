/**
 * Neon AI Gateway — `neon.com/models.json` is the catalog Neon calls its
 * machine-readable source of truth (docs/ai-gateway/models). Prices there
 * are USD per million tokens, passed through at the provider's rate with
 * no markup. Decision models (`/typesafe/v1/systemone`) are not a
 * generation activity here and are left out, as are rows the catalog
 * marks unreleased. The data plane is a per-branch host
 * (`NEON_AI_GATEWAY_BASE_URL`); the documented chat-completions and
 * embeddings routes are generated from OpenAI's document.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { compatGenerationEndpointId } from '../model-meta.ts'
import {
  classifyOpenAiCompat,
  fetchOpenAiCompatibleSpec,
} from '../openai-compat.ts'
import { fetchJson, sha256Text } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ModelReasoning,
  ProviderConfig,
  ProviderConnect,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const NEON_CATALOG_URL = 'https://neon.com/models.json'
const NEON_DOCS_URL = 'https://neon.com/docs/ai-gateway/models'
/** A placeholder in the shape of a branch host; every branch has its own. */
const NEON_HOST_PLACEHOLDER = 'br-example-api.ai.c-2.us-east-2.aws.neon.tech'

export const NEON_CONNECT: ProviderConnect = {
  servers: [
    {
      url: 'https://{host}',
      description: 'Your branch gateway host (NEON_AI_GATEWAY_BASE_URL).',
      variables: {
        host: {
          default: NEON_HOST_PLACEHOLDER,
          description:
            'The bare AI Gateway host of your Neon branch, from `neon env pull`.',
        },
      },
    },
  ],
  securitySchemes: {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      description:
        'The branch gateway token (NEON_AI_GATEWAY_TOKEN) as `Authorization: Bearer <token>`.',
    },
  },
  security: [{ bearerAuth: [] }],
}

/** `cost` keys (USD per million tokens) → token-card levers. */
const COST_LEVERS: Record<string, string> = {
  input: 'input_tokens',
  output: 'output_tokens',
  cache_read: 'cache_read_tokens',
  cache_write: 'cache_write_tokens',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

function stringList(value: unknown): Array<string> | null {
  if (!Array.isArray(value)) return null
  return value.every((item): item is string => typeof item === 'string')
    ? value
    : null
}

function neonCard(
  rawId: string,
  cost: unknown,
  source: RateCard['source'],
): RateCard | null {
  if (cost === undefined) return null
  if (!isRecord(cost)) throw new Error(`neon: ${rawId} cost is not an object`)
  const base: Record<string, number> = {}
  for (const [key, lever] of Object.entries(COST_LEVERS)) {
    const value = cost[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`neon: ${rawId} cost.${key} is not a price`)
    }
    base[lever] = value / 1_000_000
  }
  return compileTokenCard(base, [], source)
}

/**
 * `reasoning_options` states the control: an effort list, a token budget,
 * or a switch. `mandatory` is unstated everywhere but a list with `none`,
 * which states thinking can be turned off. A toggle is stored only when
 * the list says that.
 */
function neonReasoning(options: unknown): ModelReasoning | null {
  if (!Array.isArray(options)) return null
  for (const option of options) {
    if (!isRecord(option)) continue
    const values = stringList(option.values) ?? []
    if (option.type === 'effort' && values.length > 0) {
      return {
        mode: 'effort',
        mandatory: values.includes('none') ? false : null,
        efforts: values,
      }
    }
    if (option.type === 'budget_tokens') {
      return { mode: 'budget', mandatory: null }
    }
  }
  return null
}

export function parseNeonModels(
  payload: unknown,
  source: RateCard['source'],
): Array<ModelInfo> {
  const neon = isRecord(payload) ? payload.neon : undefined
  const rows = isRecord(neon) ? neon.models : undefined
  if (!isRecord(rows)) throw new Error('neon: catalog has no neon.models')
  const models: Array<ModelInfo> = []
  for (const row of Object.values(rows)) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id === '') {
      throw new Error('neon: catalog row has no id')
    }
    if (row.released !== true || row.type === 'decision') continue
    const activity = row.type === 'embedding' ? 'embeddings' : 'chat'
    const limit = isRecord(row.limit) ? row.limit : {}
    const input = isRecord(row.modalities)
      ? stringList(row.modalities.input)
      : null
    const output = isRecord(row.modalities)
      ? stringList(row.modalities.output)
      : null
    const modalities = input && output ? { input, output } : null
    const capabilities: Array<string> = []
    const unsupported: Array<string> = []
    const flags: Array<[string, string]> = [
      ['tool_call', 'tools'],
      ['structured_output', 'structured_outputs'],
      ['temperature', 'temperature'],
    ]
    for (const [key, flag] of flags) {
      if (row[key] === true) capabilities.push(flag)
      else if (row[key] === false) unsupported.push(flag)
    }
    const knowledge =
      typeof row.knowledge === 'string' &&
      /^\d{4}-\d{2}(?:-\d{2})?$/.test(row.knowledge)
        ? row.knowledge
        : null
    const released =
      typeof row.release_date === 'string'
        ? Date.parse(row.release_date)
        : Number.NaN
    models.push({
      rawId: row.id,
      displayName: typeof row.name === 'string' ? row.name : null,
      activity,
      contextWindow: positive(limit.context),
      maxOutput: positive(limit.output),
      modalities,
      pricing: neonCard(row.id, row.cost, source),
      ...(capabilities.length > 0 ? { capabilities } : {}),
      ...(unsupported.length > 0
        ? { unsupportedCapabilities: unsupported }
        : {}),
      reasoning: neonReasoning(row.reasoning_options),
      knowledgeCutoff: knowledge,
      openWeights:
        typeof row.open_weights === 'boolean' ? row.open_weights : null,
      releasedAt: Number.isFinite(released)
        ? Math.floor(released / 1000)
        : null,
    })
  }
  if (models.length === 0) throw new Error('neon: catalog listed no models')
  return models
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const payload = await fetchJson(NEON_CATALOG_URL)
  return {
    models: parseNeonModels(payload, {
      url: NEON_CATALOG_URL,
      hash: await sha256Text(JSON.stringify(payload)),
      extractedAt: new Date().toISOString(),
    }),
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, url, hash } = await fetchOpenAiCompatibleSpec({
    title: 'Neon AI Gateway',
    serverUrl: 'https://{host}/v1',
    include: ['/chat/completions', '/embeddings'],
  })
  // Neon serves these at /v1/... on the bare branch host.
  const paths = Object.fromEntries(
    Object.entries(spec.paths ?? {}).map(([path, ops]) => [`/v1${path}`, ops]),
  )
  return {
    specs: [{ ...spec, paths }],
    sources: [{ url, hash }],
    outputStrategy: 'post-200',
  }
}

export const provider: ProviderConfig = {
  id: 'neon',
  displayName: 'Neon AI Gateway',
  specSourceUrl: NEON_DOCS_URL,
  modelsEndpoint: NEON_CATALOG_URL,
  defaultDerivation: 'generated',
  connect: NEON_CONNECT,
  fetchSpec,
  listModels,
  classify: classifyOpenAiCompat,
  generationEndpointId: ({ activity }) =>
    compatGenerationEndpointId(activity, 'v1/'),
}
