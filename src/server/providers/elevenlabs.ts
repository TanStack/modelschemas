/**
 * ElevenLabs — public OpenAPI spec at api.elevenlabs.io/openapi.json.
 * Models endpoint requires ELEVENLABS_API_KEY.
 */
import type { Activity } from '#/db/schema.ts'
import { ELEVENLABS_RELEASE_DATES, curatedReleasedAt } from './release-dates.ts'
import { headerApiKeyConnect } from './connect.ts'
import { elevenLabsSpeechPricing } from './elevenlabs-pricing.ts'
import { cachedDocs } from './model-facts.ts'
import { fetchJson, fetchText, sha256Text, skippedResult } from './types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  OpenApiDocument,
  OpenApiOperation,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from './types.ts'

const ELEVENLABS_OPENAPI_URL = 'https://api.elevenlabs.io/openapi.json'
const ELEVENLABS_MODELS_URL = 'https://api.elevenlabs.io/v1/models'

/**
 * ElevenLabs' entire generation surface is audio, so every generation tag
 * maps to the single `audio` group (voices included — valid voice IDs and
 * voice settings are exactly the constraint surface this service exposes).
 * Studio, workspace, Agents Platform, pronunciation dictionaries, music
 * finetunes, and the other management surfaces classify to null.
 */
const ELEVENLABS_AUDIO_TAGS = new Set([
  'text-to-speech',
  'text-to-dialogue',
  'speech-to-speech',
  'speech-to-text',
  'sound-generation',
  'audio-isolation',
  'text-to-voice',
  'voices',
  'forced-alignment',
  'video-to-music',
  'dubbing',
  'music-generation',
  'music',
])

function classify(_path: string, op: OpenApiOperation): Activity | null {
  const tags = Array.isArray(op.tags) ? (op.tags as Array<string>) : []
  return tags.some((tag) => ELEVENLABS_AUDIO_TAGS.has(tag)) ? 'audio' : null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const text = await fetchText(ELEVENLABS_OPENAPI_URL)
  const spec = JSON.parse(text) as OpenApiDocument
  return {
    specs: [spec],
    sources: [{ url: ELEVENLABS_OPENAPI_URL, hash: await sha256Text(text) }],
    outputStrategy: 'post-200',
  }
}

interface ElevenLabsModel {
  model_id: string
  name?: string
  can_do_text_to_speech?: boolean
  can_do_voice_conversion?: boolean
  languages?: Array<{ language_id: string; name: string }>
}

/**
 * Routes whose request `model_id` enum names models `GET /v1/models`
 * omits (music, voice design, sound effects).
 */
const ELEVENLABS_ENUM_MODEL_ROUTES = [
  'v1/music',
  'v1/text-to-voice/design',
  'v1/sound-generation',
]

interface EnumModel {
  rawId: string
  schemaEndpointId: string
  deprecated: boolean
}

function deref(spec: OpenApiDocument, node: unknown): Record<string, unknown> {
  const obj = (node ?? {}) as Record<string, unknown>
  const ref = obj.$ref
  if (typeof ref !== 'string') return obj
  const name = ref.replace('#/components/schemas/', '')
  const components = spec.components as
    | { schemas?: Record<string, unknown> }
    | undefined
  return (components?.schemas?.[name] ?? {}) as Record<string, unknown>
}

/**
 * The `model_id` enum values on each enum route's JSON request body. Throws
 * when a route yields none — the enum moving would otherwise silently
 * remove those catalog rows.
 */
export function elevenlabsEnumModels(spec: OpenApiDocument): Array<EnumModel> {
  return ELEVENLABS_ENUM_MODEL_ROUTES.flatMap((endpointId) => {
    const op = spec.paths?.[`/${endpointId}`]?.post as
      | { requestBody?: { content?: Record<string, { schema?: unknown }> } }
      | undefined
    const body = deref(
      spec,
      op?.requestBody?.content?.['application/json']?.schema,
    )
    const properties = (body.properties ?? {}) as Record<string, unknown>
    const modelId = deref(spec, properties.model_id)
    const values = Array.isArray(modelId.enum) ? modelId.enum : []
    const ids = values.filter((v): v is string => typeof v === 'string')
    if (ids.length === 0) {
      throw new Error(`elevenlabs spec: no model_id enum on ${endpointId}`)
    }
    const meta = (modelId['x-fern-enum'] ?? {}) as Record<
      string,
      { deprecated?: boolean } | undefined
    >
    return ids.map((rawId) => ({
      rawId,
      schemaEndpointId: endpointId,
      deprecated: meta[rawId]?.deprecated === true,
    }))
  })
}

async function listModels(
  env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const key = env.ELEVENLABS_API_KEY
  if (!key) {
    return {
      models: [],
      ...skippedResult('elevenlabs', 'ELEVENLABS_API_KEY'),
    }
  }
  const body = (await fetchJson(ELEVENLABS_MODELS_URL, {
    headers: { 'xi-api-key': key },
  })) as Array<ElevenLabsModel>
  const enumModels = await cachedDocs(kv, ELEVENLABS_OPENAPI_URL, async () =>
    elevenlabsEnumModels(
      JSON.parse(await fetchText(ELEVENLABS_OPENAPI_URL)) as OpenApiDocument,
    ),
  )
  const speechIds = new Set(body.map((m) => m.model_id))
  const speechPrice = await elevenLabsSpeechPricing(kv)
  const speech: Array<ModelInfo> = body.map((m) => ({
    rawId: m.model_id,
    displayName: m.name ?? null,
    activity: 'audio',
    // ElevenLabs' API has no release timestamp — curated dates only.
    releasedAt: curatedReleasedAt(ELEVENLABS_RELEASE_DATES, m.model_id),
    providerMetadata: {
      canDoTextToSpeech: m.can_do_text_to_speech,
      canDoVoiceConversion: m.can_do_voice_conversion,
      languages: m.languages?.map((l) => l.language_id),
    },
    // Speech-to-speech-only rows are not the Text to Speech product.
    ...(m.can_do_text_to_speech === false ? {} : speechPrice(m.model_id)),
  }))
  // A speech id that also sits in an enum keeps its speech row.
  const extra: Array<ModelInfo> = enumModels
    .filter((m) => !speechIds.has(m.rawId))
    .map((m) => ({
      rawId: m.rawId,
      displayName: null,
      activity: 'audio',
      releasedAt: curatedReleasedAt(ELEVENLABS_RELEASE_DATES, m.rawId),
      schemaEndpointId: m.schemaEndpointId,
      deprecated: m.deprecated,
    }))
  return { models: [...speech, ...extra] }
}

export const elevenlabsProvider: ProviderConfig = {
  id: 'elevenlabs',
  displayName: 'ElevenLabs',
  authEnvVar: 'ELEVENLABS_API_KEY',
  defaultDerivation: 'upstream-spec',
  specGrain: 'provider',
  connect: headerApiKeyConnect('https://api.elevenlabs.io', 'xi-api-key'),
  fetchSpec,
  listModels,
  classify,
  generationEndpointId: () => 'v1/text-to-speech/{voice_id}',
}
