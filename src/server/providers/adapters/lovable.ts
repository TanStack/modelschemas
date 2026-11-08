/**
 * Lovable AI Gateway — the keyless `GET /v1/models` listing is the catalog:
 * ids, limits, modalities, knowledge cutoff, release and deprecation, and
 * the API surfaces each model serves. Prices there are in Lovable credits
 * with no stated USD rate, so no rate card is stored
 * (docs/source-silent/lovable.md). The routes are OpenAI-compatible under
 * https://ai.gateway.lovable.dev/v1; their schemas are generated from
 * OpenAI's document.
 */
import type { Activity } from '#/db/schema.ts'

import { bearerConnect } from '../connect.ts'
import {
  classifyOpenAiCompat,
  fetchOpenAiCompatibleSpec,
} from '../openai-compat.ts'
import { fetchJson } from '../types.ts'
import { namespacedUpstreamIdentity } from '../upstream-model.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const LOVABLE_MODELS_URL = 'https://ai.gateway.lovable.dev/v1/models'
export const LOVABLE_SERVER_URL = 'https://ai.gateway.lovable.dev/v1'
const LOVABLE_DOCS_URL = 'https://docs.lovable.dev/features/ai'

/**
 * Listing `supported_surfaces` → the route under /v1. `messages`
 * (Anthropic), `live`, `music`, and `systemone` have no OpenAI-compatible
 * route here, so a model with only those binds no schema.
 */
const SURFACE_ROUTES: Record<string, string> = {
  'chat-completions': 'chat/completions',
  responses: 'responses',
  embeddings: 'embeddings',
  'image-generation': 'images/generations',
  'image-edit': 'images/edits',
  speech: 'audio/speech',
  transcription: 'audio/transcriptions',
  videos: 'videos',
}

/** Every surface the listing names; `systemone` (decisions) is no generation activity. */
const SURFACE_ACTIVITIES: Record<string, Activity | null> = {
  systemone: null,
  'chat-completions': 'chat',
  responses: 'chat',
  messages: 'chat',
  embeddings: 'embeddings',
  'image-generation': 'image',
  'image-edit': 'image',
  speech: 'audio',
  transcription: 'audio',
  live: 'audio',
  music: 'audio',
  videos: 'video',
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

function modalities(value: unknown): ModelInfo['modalities'] {
  if (!isRecord(value)) return null
  const input = stringList(value.input)
  const output = stringList(value.output)
  return input && output && input.length > 0 ? { input, output } : null
}

export function parseLovableModels(payload: unknown): Array<ModelInfo> {
  const data = isRecord(payload) ? payload.data : undefined
  if (!Array.isArray(data)) {
    throw new Error('lovable: models payload has no data array')
  }
  const models: Array<ModelInfo> = []
  for (const row of data) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id === '') {
      throw new Error('lovable: models row has no id')
    }
    const surfaces = stringList(row.supported_surfaces) ?? []
    const unknown = surfaces.find((s) => !(s in SURFACE_ACTIVITIES))
    if (unknown !== undefined) {
      throw new Error(`lovable: ${row.id} lists unknown surface ${unknown}`)
    }
    const activity =
      surfaces.map((s) => SURFACE_ACTIVITIES[s]).find((a) => a) ?? null
    const route = surfaces.map((s) => SURFACE_ROUTES[s]).find((r) => r) ?? null
    const knowledge =
      typeof row.knowledge === 'string' &&
      /^\d{4}-\d{2}(?:-\d{2})?$/.test(row.knowledge)
        ? row.knowledge
        : null
    models.push({
      rawId: row.id,
      displayName: typeof row.name === 'string' ? row.name : null,
      activity,
      schemaEndpointId: route,
      contextWindow: positive(row.context_window),
      maxOutput: positive(row.max_tokens),
      modalities: modalities(row.modalities),
      knowledgeCutoff: knowledge,
      releasedAt: positive(row.released),
      deprecated: row.deprecated === true,
    })
  }
  if (models.length === 0)
    throw new Error('lovable: models payload listed no ids')
  return models
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  return { models: parseLovableModels(await fetchJson(LOVABLE_MODELS_URL)) }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, url, hash } = await fetchOpenAiCompatibleSpec({
    title: 'Lovable AI Gateway',
    serverUrl: LOVABLE_SERVER_URL,
    include: [
      '/chat/completions',
      '/responses',
      '/embeddings',
      '/images/generations',
      '/images/edits',
      '/audio/speech',
      '/audio/transcriptions',
      '/videos',
    ],
  })
  return { specs: [spec], sources: [{ url, hash }], outputStrategy: 'post-200' }
}

export const provider: ProviderConfig = {
  id: 'lovable',
  displayName: 'Lovable AI Gateway',
  specSourceUrl: LOVABLE_DOCS_URL,
  modelsEndpoint: LOVABLE_MODELS_URL,
  defaultDerivation: 'generated',
  // `openai/gpt-5.5`: the listing names the maker in the id and `owned_by`.
  upstreamModelIdentity: (rawId) =>
    namespacedUpstreamIdentity(rawId, {
      derivation: 'listing',
      sourceUrl: LOVABLE_MODELS_URL,
      path: 'data[].id',
    }),
  bindSyncedRoutesOnly: true,
  connect: bearerConnect(LOVABLE_SERVER_URL, 'Lovable AI Gateway'),
  fetchSpec,
  listModels,
  classify: classifyOpenAiCompat,
}
