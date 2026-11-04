/**
 * Google Gemini — pulls the Generative Language API Discovery doc and
 * converts it to OpenAPI 3.0. The converter is intentionally minimal
 * (ported from PR #622): it covers the Discovery subset Google's gen-AI API
 * actually uses, not general-purpose conversion.
 */
import type { Activity } from '#/db/schema.ts'
import { supportedFlags } from '#/lib/capabilities.ts'
import {
  attachGeminiPublishedFacts,
  geminiPublishedBindings,
} from './gemini-bindings.ts'
import { geminiModelFeatures } from './gemini-features.ts'
import { geminiModelPricing } from './gemini-pricing.ts'
import {
  GEMINI_DISCOVERY_URL,
  geminiRequestMap,
  geminiWire,
} from './gemini-request.ts'
import { docsReport, docsRun } from './model-facts.ts'
import { geminiGenerationEndpointId } from './model-meta.ts'
import {
  GEMINI_RELEASE_DATES,
  curatedReleasedAt,
  geminiIdSuffixDate,
} from './release-dates.ts'
import { fetchJson, fetchText, sha256Text, skippedResult } from './types.ts'
import { usEgressFetch } from './us-egress.ts'
import type {
  ListModelsResult,
  OpenApiDocument,
  ProviderConfig,
  ProviderEnvironment,
  ProviderSecrets,
  SpecFetchResult,
} from './types.ts'

const GEMINI_MODELS_URL =
  'https://generativelanguage.googleapis.com/v1beta/models'

interface DiscoverySchema {
  id?: string
  type?: string
  format?: string
  description?: string
  properties?: Record<string, DiscoverySchema>
  items?: DiscoverySchema
  $ref?: string
  enum?: Array<string>
  required?: Array<string>
  additionalProperties?: DiscoverySchema | boolean
}

interface DiscoveryParameter {
  type?: string
  description?: string
  location?: 'query' | 'path' | 'header'
  required?: boolean
  enum?: Array<string>
}

interface DiscoveryMethod {
  id: string
  path?: string
  flatPath?: string
  httpMethod?: string
  description?: string
  parameters?: Record<string, DiscoveryParameter>
  request?: { $ref?: string }
  response?: { $ref?: string }
}

interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>
  resources?: Record<string, DiscoveryResource>
}

export interface DiscoveryDoc {
  rootUrl?: string
  servicePath?: string
  baseUrl?: string
  schemas?: Record<string, DiscoverySchema>
  resources?: Record<string, DiscoveryResource>
  title?: string
  version?: string
}

type JsonSchema = Record<string, unknown>

function convertSchema(schema: DiscoverySchema): JsonSchema {
  if (schema.$ref) {
    return { $ref: `#/components/schemas/${schema.$ref}` }
  }
  const out: JsonSchema = {}
  if (schema.type) out.type = schema.type
  if (schema.format) out.format = schema.format
  if (schema.description) out.description = schema.description
  if (schema.enum) out.enum = schema.enum
  if (schema.required) out.required = schema.required
  if (schema.items) out.items = convertSchema(schema.items)
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, value]) => [
        name,
        convertSchema(value),
      ]),
    )
  }
  if (schema.additionalProperties !== undefined) {
    out.additionalProperties =
      typeof schema.additionalProperties === 'boolean'
        ? schema.additionalProperties
        : convertSchema(schema.additionalProperties)
  }
  return out
}

function collectMethods(
  resources: Record<string, DiscoveryResource> | undefined,
  acc: Array<DiscoveryMethod>,
): void {
  if (!resources) return
  for (const resource of Object.values(resources)) {
    if (resource.methods) {
      for (const method of Object.values(resource.methods)) {
        acc.push(method)
      }
    }
    collectMethods(resource.resources, acc)
  }
}

export function discoveryToOpenApi(doc: DiscoveryDoc): OpenApiDocument {
  const schemas = Object.fromEntries(
    Object.entries(doc.schemas ?? {}).map(([name, schema]) => [
      name,
      convertSchema(schema),
    ]),
  )

  const paths: NonNullable<OpenApiDocument['paths']> = {}
  const methods: Array<DiscoveryMethod> = []
  collectMethods(doc.resources, methods)

  for (const method of methods) {
    const path = `/${(method.flatPath ?? method.path ?? '').replace(/^\/+/, '')}`
    const httpMethod = (method.httpMethod ?? 'GET').toLowerCase()
    paths[path] ??= {}

    const operation: Record<string, unknown> = {
      operationId: method.id,
      description: method.description,
      parameters: Object.entries(method.parameters ?? {}).map(
        ([name, param]) => ({
          name,
          in: param.location ?? 'query',
          required: param.required ?? (param.location ?? 'query') === 'path',
          schema: { type: param.type, enum: param.enum },
          description: param.description,
        }),
      ),
      responses: {
        '200': {
          description: 'Success',
          content: method.response?.$ref
            ? {
                'application/json': {
                  schema: {
                    $ref: `#/components/schemas/${method.response.$ref}`,
                  },
                },
              }
            : undefined,
        },
      },
    }
    if (method.request?.$ref) {
      operation.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${method.request.$ref}` },
          },
        },
      }
    }
    paths[path][httpMethod] = operation
  }

  const serverUrl =
    doc.baseUrl ??
    (doc.rootUrl && doc.servicePath
      ? `${doc.rootUrl.replace(/\/$/, '')}/${doc.servicePath.replace(/^\//, '')}`
      : 'https://generativelanguage.googleapis.com/')

  return {
    openapi: '3.0.4',
    info: {
      title: doc.title ?? 'Google Generative Language API',
      version: doc.version ?? 'v1beta',
    },
    servers: [{ url: serverUrl.replace(/\/$/, '') }],
    paths,
    components: { schemas },
  }
}

/**
 * Gemini paths encode the operation as a `:method` suffix
 * (`v1beta/models/{modelsId}:generateContent`); classify by that verb.
 * Imagen runs through `:predict`, Veo through `:predictLongRunning`.
 * Tuning management, cached contents, corpora, files, and batch job
 * submission are platform endpoints.
 */
const GEMINI_VERB_ACTIVITIES: Record<string, Activity> = {
  generateContent: 'chat',
  streamGenerateContent: 'chat',
  generateAnswer: 'chat',
  generateMessage: 'chat',
  generateText: 'chat',
  countTokens: 'chat',
  countMessageTokens: 'chat',
  countTextTokens: 'chat',
  embedContent: 'embeddings',
  batchEmbedContents: 'embeddings',
  embedText: 'embeddings',
  batchEmbedText: 'embeddings',
  predict: 'image',
  predictLongRunning: 'video',
}

function classify(path: string): Activity | null {
  const verb = path.match(/:([A-Za-z]+)$/)?.[1]
  if (!verb) return null
  return GEMINI_VERB_ACTIVITIES[verb] ?? null
}

/**
 * Model-level activity. Google's models API doesn't label modality, so
 * derive it from the signals it does carry: `predict`, `predictLongRunning`,
 * and `embedContent` uniquely identify Imagen, Veo, and embedding models.
 * The generateContent surface serves chat, image (Nano Banana), and TTS
 * models alike, so it splits on the id's `-image`/`-tts` segments. The
 * live/native-audio bidiGenerateContent models group with chat, matching
 * the OpenAI Realtime → chat mapping.
 */
export function geminiModelActivity(
  rawId: string,
  methods: Array<string>,
): Activity | null {
  if (methods.includes('predict')) return 'image'
  if (methods.includes('predictLongRunning')) return 'video'
  if (methods.includes('embedContent') || methods.includes('embedText')) {
    return 'embeddings'
  }
  const generates =
    methods.includes('generateContent') ||
    methods.includes('bidiGenerateContent') ||
    methods.includes('generateAnswer')
  if (!generates) return null
  if (/(^|-)image(-|$)/.test(rawId)) return 'image'
  if (/(^|-)tts(-|$)/.test(rawId)) return 'audio'
  return 'chat'
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const text = await fetchText(GEMINI_DISCOVERY_URL)
  const discovery = JSON.parse(text) as DiscoveryDoc
  return {
    specs: [discoveryToOpenApi(discovery)],
    sources: [{ url: GEMINI_DISCOVERY_URL, hash: await sha256Text(text) }],
    outputStrategy: 'post-200',
  }
}

interface GeminiModel {
  name: string
  displayName?: string
  inputTokenLimit?: number
  outputTokenLimit?: number
  supportedGenerationMethods?: Array<string>
  temperature?: number
  topP?: number
  topK?: number
  thinking?: boolean
}

interface GeminiModelList {
  models?: Array<GeminiModel>
  nextPageToken?: string
}

/**
 * Request features the Models API row states: `thinking`, and a sampling
 * default present ⇒ that param is accepted. Tool use and structured output
 * are not on the row and stay unset. Modalities are not on the row either:
 * they come from the model's docs page (`gemini-features.ts`).
 */
export function geminiCapabilities(
  m: Pick<GeminiModel, 'temperature' | 'topP' | 'topK' | 'thinking'>,
): Array<string> | null {
  const out: Array<string> = []
  if (m.thinking) out.push('reasoning')
  if (m.temperature !== undefined) out.push('temperature')
  if (m.topP !== undefined) out.push('top_p')
  if (m.topK !== undefined) out.push('top_k')
  return out.length > 0 ? out : null
}

async function listModels(
  env: ProviderEnvironment,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const key = env.GEMINI_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('gemini', 'GEMINI_API_KEY') }
  }
  // A docs miss is `unavailable` on the rows plus `docsFailures` on the
  // result. It must not throw away the listing (#567).
  const docs = docsRun()
  const pricingPromise = geminiModelPricing(kv, docs)
  const wirePromise = geminiWire(kv)
  const bindingsPromise = geminiPublishedBindings(kv)
  const listed: Array<GeminiModel> = []
  let pageToken: string | undefined
  do {
    const url = new URL(GEMINI_MODELS_URL)
    url.searchParams.set('pageSize', '1000')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    // Header, not `?key=`: fetchJson errors quote the URL into telemetry.
    const body = (await fetchJson(
      url.toString(),
      { headers: { 'x-goog-api-key': key } },
      usEgressFetch(env),
    )) as GeminiModelList
    listed.push(...(body.models ?? []))
    pageToken = body.nextPageToken
  } while (pageToken)
  const rawIdOf = (m: GeminiModel) => m.name.replace(/^models\//, '')
  const [pricing, wire, { features, docsFailures, thinkingLoaded }, bindings] =
    await Promise.all([
      pricingPromise,
      wirePromise,
      geminiModelFeatures(listed.map(rawIdOf), kv),
      bindingsPromise,
    ])
  const models = listed.map((m) => {
    const rawId = rawIdOf(m)
    const methods = m.supportedGenerationMethods ?? []
    const activity = geminiModelActivity(rawId, methods)
    const priced = pricing(rawId)
    const feat = features(rawId, m.thinking)
    const capabilities = [
      ...new Set([
        ...(geminiCapabilities(m) ?? []),
        ...(feat.capabilities ?? []),
      ]),
    ]
    const usesConfig =
      methods.includes('generateContent') ||
      methods.includes('bidiGenerateContent')
    // The thinking page supplies budget numbers the map's thinking body
    // needs. While it is unread, keep the stored map.
    const requestMap =
      activity === 'chat' && usesConfig && thinkingLoaded
        ? geminiRequestMap(wire.fields, feat.reasoning, feat.budget)
        : null
    const absent = {
      ...priced.absent,
      ...feat.absent,
      ...(thinkingLoaded || activity !== 'chat' || !usesConfig
        ? {}
        : { requestMap: 'unavailable' as const }),
    }
    return {
      rawId,
      displayName: m.displayName ?? null,
      activity,
      schemaEndpointId:
        activity === null
          ? null
          : geminiGenerationEndpointId(activity, methods),
      contextWindow: m.inputTokenLimit ?? null,
      maxOutput: m.outputTokenLimit ?? null,
      modalities: feat.modalities,
      capabilities: capabilities.length ? capabilities : null,
      ...(m.thinking === false
        ? { unsupportedCapabilities: ['reasoning'] }
        : {}),
      // Gemini's API has no release timestamp: curated dates first, then
      // the MM-YYYY month embedded in preview ids.
      releasedAt:
        curatedReleasedAt(GEMINI_RELEASE_DATES, rawId) ??
        geminiIdSuffixDate(rawId),
      pricing: priced.pricing,
      reasoning: feat.reasoning,
      serverTools: feat.serverTools,
      ...(requestMap ? { requestMap } : {}),
      factSources: {
        ...priced.factSources,
        ...feat.factSources,
        ...(requestMap ? { requestMap: wire.source } : {}),
      },
      ...(Object.keys(absent).length > 0 ? { absent } : {}),
    }
  })
  const pricingDocs = docsReport(docs)
  return {
    docsFailures: {
      failed:
        pricingDocs.failed + docsFailures.failed + bindings.docsFailures.failed,
      skipped:
        pricingDocs.skipped +
        docsFailures.skipped +
        bindings.docsFailures.skipped,
      first: [
        ...pricingDocs.first,
        ...docsFailures.first,
        ...bindings.docsFailures.first,
      ].slice(0, 5),
    },
    models: attachGeminiPublishedFacts(models, bindings),
  }
}

export const geminiProvider: ProviderConfig = {
  id: 'gemini',
  modelNamespaces: ['google', 'google-ai-studio'],
  displayName: 'Google Gemini',
  authEnvVar: 'GEMINI_API_KEY',
  defaultDerivation: 'upstream-spec',
  specGrain: 'provider',
  connect: {
    servers: [{ url: 'https://generativelanguage.googleapis.com' }],
    securitySchemes: {
      apiKey: { type: 'apiKey', in: 'query', name: 'key' },
    },
    security: [{ apiKey: [] }],
  },
  fetchSpec,
  listModels,
  classify,
  // Un-repolled rows still have supportedGenerationMethods in capabilities.
  // After poll, resolveSchemaEndpointId prefers schemaEndpointId, so the
  // new request-feature flags never drive the route.
  generationEndpointId: ({ activity, capabilities }) =>
    geminiGenerationEndpointId(
      activity,
      // A listing's list at poll time, a stored row's map at read time.
      Array.isArray(capabilities)
        ? capabilities.filter(
            (value): value is string => typeof value === 'string',
          )
        : supportedFlags(capabilities),
    ),
}
