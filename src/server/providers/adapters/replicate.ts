/**
 * Replicate — public OpenAPI at api.replicate.com/openapi.json.
 * Generation is POST /predictions (and official model run paths).
 * listModels walks the paginated public catalog; requires REPLICATE_API_TOKEN.
 *
 * Every listed model carries its own request schema
 * (`latest_version.openapi_schema`). A language model is read off that
 * schema, never off its name, and its chat facts come from the same place.
 * Official language models also get their run route synced with that schema
 * as the `input` object.
 */
import type { Activity } from '#/db/schema.ts'
import { contentHash } from '#/server/kv.ts'
import { walkRequestSchema } from '../fact-sources.ts'
import { cachedDocs, mapConcurrent } from '../model-facts.ts'
import { isoToEpochSeconds } from '../release-dates.ts'
import {
  fetchJson,
  fetchOpenApi,
  fetchText,
  sha256Text,
  skippedResult,
} from '../types.ts'
import {
  BILLING_MARKER,
  compileReplicateBilling,
  replicateBillingFromHtml,
} from '../replicate-pricing.ts'
import { replicateReadmeFacts } from '../replicate-readme.ts'
import type { ReplicateBilling } from '../replicate-pricing.ts'
import type {
  FactSource,
  ListModelsResult,
  ModelFactSources,
  ModelInfo,
  ModelReasoning,
  OpenApiDocument,
  OpenApiOperation,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const REPLICATE_OPENAPI_URL = 'https://api.replicate.com/openapi.json'
const REPLICATE_MODELS_URL = 'https://api.replicate.com/v1/models'

/** Public catalog is huge; stay inside the Worker subrequest budget. */
const MAX_MODEL_PAGES = 20
const FETCH_TIMEOUT_MS = 20_000

/** The run route the spec documents for official models. */
const OFFICIAL_RUN_PATH = '/models/{model_owner}/{model_name}/predictions'
/** Set on the per-model routes fetchSpec adds; classify reads it back. */
const ACTIVITY_MARKER = 'x-modelschemas-replicate-activity'
const INPUT_POINTER = '/latest_version/openapi_schema/components/schemas/Input'
const SCHEMA_REF = '#/components/schemas/'

const PROMPT_FIELDS = ['prompt', 'messages', 'message']
const MAX_TOKENS_FIELD = /^max_(?:new_|completion_|output_)?tokens$/

function stripV1(path: string): string {
  return path.startsWith('/v1/') ? path.slice(3) : path
}

/**
 * Official-model slugs refine the activity. Generic prediction creates
 * (`/predictions`, templated `/models/{owner}/{name}/predictions`) default
 * to image — Replicate's core generation surface.
 */
function activityFromHaystack(
  haystack: string,
  allowChat = true,
): Activity | null {
  const hay = haystack.toLowerCase()
  if (
    /text-to-video|image-to-video|video-to-video|stable-video|hunyuan-video|wan-video|ltx-video|cogvideo|animate-?diff|hailuo|kling|pixverse|runway|mochi-1|luma\/|\/veo|veo-\d|video-01|\/video-/.test(
      hay,
    )
  ) {
    return 'video'
  }
  if (
    /whisper|musicgen|audiogen|riffusion|text-to-speech|speech-to-text|text-to-audio|xtts|zonos|kokoro|chatterbox|\bbark\b|styletts|stable-audio|audio-ldm|mmaudio|ace-step|orpheus|\btts\b|voice-clone/.test(
      hay,
    )
  ) {
    return 'audio'
  }
  if (
    allowChat &&
    /llama|mistral|mixtral|qwen|gemma|deepseek|gpt-oss|phi-[34]|dbrx|nemotron|granite|arctic|\byi-|vicuna|wizardlm|zephyr|command-r|\bllm\b|instruct|\bchat\b/.test(
      hay,
    )
  ) {
    return 'chat'
  }
  if (
    /flux|sdxl|stable-diffusion|\bsd3\b|imagen|ideogram|recraft|playground|auraflow|hidream|seedream|esrgan|upscale|controlnet|pulid|text-to-image|image-to-image/.test(
      hay,
    )
  ) {
    return 'image'
  }
  return null
}

/** POST /predictions and POST /models/{owner}/{name}/predictions only. */
function isGenerationCreate(path: string): boolean {
  const bare = stripV1(path)
  if (bare === '/predictions') return true
  return /^\/models\/[^/]+\/[^/]+\/predictions$/.test(bare)
}

function classify(path: string, op: OpenApiOperation): Activity | null {
  if (op[ACTIVITY_MARKER] === 'chat') return 'chat'
  if (!isGenerationCreate(path)) return null
  return activityFromHaystack(path) ?? 'image'
}

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface ReplicateModel {
  owner?: string
  name?: string
  description?: string | null
  visibility?: string
  created_at?: string
  is_official?: boolean
  latest_version?: {
    created_at?: string
    /** The model's own request and response schema (Cog). */
    openapi_schema?: { components?: { schemas?: unknown } }
  }
  /** Present when the models API includes the prediction price. */
  billing_config?: ReplicateBilling | null
  billingConfig?: ReplicateBilling | null
}

interface ReplicateModelPage {
  next?: string | null
  results?: Array<ReplicateModel>
}

function isSafeModelsUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'api.replicate.com' &&
      parsed.pathname.startsWith('/v1/models')
    )
  } catch {
    return false
  }
}

function modelSchemas(model: ReplicateModel): Json | null {
  const schemas = model.latest_version?.openapi_schema?.components?.schemas
  return isRecord(schemas) ? schemas : null
}

/** Cog writes an enum field as `allOf: [{ $ref }]`. */
function deref(schemas: Json, node: unknown): Json | null {
  if (!isRecord(node)) return null
  const only =
    Array.isArray(node.allOf) && node.allOf.length === 1
      ? (node.allOf[0] as unknown)
      : node
  if (!isRecord(only)) return null
  if (typeof only.$ref !== 'string') return only
  const target = schemas[only.$ref.replace(SCHEMA_REF, '')]
  return isRecord(target) ? target : null
}

function isText(node: unknown): boolean {
  return isRecord(node) && node.type === 'string' && node.format === undefined
}

/**
 * Input properties of a language model, null for anything else. The model's
 * schema decides: it returns text, takes a prompt, and caps output tokens.
 * A name like `qwen-image` says nothing about what a model returns.
 */
function chatInputProperties(model: ReplicateModel): Json | null {
  const schemas = modelSchemas(model)
  const output = schemas?.Output
  const input = schemas?.Input
  if (!isRecord(output) || !isRecord(input) || !isRecord(input.properties)) {
    return null
  }
  if (!isText(output) && !(output.type === 'array' && isText(output.items))) {
    return null
  }
  const names = Object.keys(input.properties)
  if (!PROMPT_FIELDS.some((name) => names.includes(name))) return null
  if (!names.some((name) => MAX_TOKENS_FIELD.test(name))) return null
  return input.properties
}

/** A number or a switch (`video_fps`, `max_image_resolution`) carries no media. */
function isScalarSetting(node: unknown): boolean {
  return (
    isRecord(node) &&
    ['integer', 'number', 'boolean'].includes(String(node.type))
  )
}

const MEDIA_NOUN = { image: 'images?', audio: 'audio', video: 'videos?' }

/**
 * A string the schema names for a medium and describes as that medium
 * (`image_input`: "List of images to send"). No `format: uri`, but
 * text-only would be a wrong claim and the description states the medium.
 */
function describedMedium(
  node: unknown,
  kind: keyof typeof MEDIA_NOUN,
): boolean {
  if (!isRecord(node)) return false
  const items = isRecord(node.items) ? node.items.type : undefined
  const textual =
    node.type === 'string' || (node.type === 'array' && items === 'string')
  if (!textual || typeof node.description !== 'string') return false
  const noun = MEDIA_NOUN[kind]
  return (
    new RegExp(`\\b${noun}\\b`, 'i').test(node.description) &&
    /\b(send|input|include|upload)\b/i.test(node.description)
  )
}

/**
 * `text` plus one modality per file input. The whole fact is unstated when
 * a file input's name does not say what it carries, or when an input named
 * for a medium is neither a file nor described as that medium.
 */
function inputModalities(properties: Json): Array<string> | null {
  const media = ['image', 'audio', 'video'] as const
  const found = new Set<string>()
  for (const [name, node] of Object.entries(properties)) {
    const file = JSON.stringify(node).includes('"format":"uri"')
    const kind = media.find((word) => name.includes(word))
    if (!file && (!kind || isScalarSetting(node))) continue
    if (file && kind) {
      found.add(kind)
      continue
    }
    if (kind && describedMedium(node, kind)) {
      found.add(kind)
      continue
    }
    return null
  }
  // Fixed order: a reordered schema must not read as a changed model.
  return ['text', ...media.filter((kind) => found.has(kind))]
}

/**
 * The stated maximum of the output-token field. Null when the schema states
 * none, or when two such fields disagree. The maximum is that field's cap,
 * including one above 128k (Llama 4 states 131072 on `max_tokens`).
 */
function maxOutputField(
  properties: Json,
): { name: string; maximum: number } | null {
  const fields = Object.keys(properties).filter((name) =>
    MAX_TOKENS_FIELD.test(name),
  )
  const maxima = new Set(
    fields.map((name) => {
      const node = properties[name]
      return isRecord(node) ? node.maximum : undefined
    }),
  )
  const [name] = fields
  const [maximum] = [...maxima]
  if (!name || maxima.size !== 1) return null
  if (typeof maximum !== 'number' || !Number.isInteger(maximum)) return null
  return maximum > 0 ? { name, maximum } : null
}

/** The names Replicate models give a level field. A model has at most one. */
const EFFORT_FIELDS = [
  'reasoning_effort',
  'thinking_level',
  'effort',
  'thinking',
]

/** Values of a field named `thinking` that make it a switch, not a level. */
const SWITCH_VALUES = ['enabled', 'disabled', 'true', 'false', 'on', 'off']

/** A description naming the level that turns thinking off, in group 1 or 2. */
const STATED_OFF = /'([^']+)' disables thinking|\b[Uu]se '([^']+)' to disable\b/

/**
 * The model's own thinking control, read off its Input schema; null when it
 * has none this can read. Every schema here is one model's own.
 *
 * - A level enum is `effort`. `mandatory` is false when the description
 *   says a level turns thinking off ("'low' disables thinking", "Use 'none'
 *   to disable"), or when `reasoning_effort` accepts `none`. On any other
 *   field a `none` that is the default is "unset", not a level ("leave as
 *   None for default behavior"): it is left out, and `mandatory` stays
 *   unstated. Otherwise the enum is this model's own exhaustive list and
 *   its only control, so `mandatory` is true. Another control
 *   (`thinking_budget`, `enable_thinking`) leaves it unstated.
 * - An integer `thinking_budget` is `budget`; "0 to disable thinking" in its
 *   description says it can be turned off.
 * - A boolean `enable_thinking` and nothing else is a `toggle` with an off
 *   position.
 */
function reasoningField(
  schemas: Json,
  properties: Json,
): { name: string; reasoning: ModelReasoning } | null {
  const names = EFFORT_FIELDS.filter((field) => field in properties)
  const [name] = names
  if (names.length > 1) return null
  if (name !== undefined) {
    const field = properties[name]
    const values = deref(schemas, field)?.enum
    if (!Array.isArray(values)) return null
    const listed = values.filter((value) => typeof value === 'string')
    if (listed.length !== values.length) return null
    if (listed.some((value) => SWITCH_VALUES.includes(value))) return null
    const described = isRecord(field) ? field.description : undefined
    const description = typeof described === 'string' ? described : ''
    const stated = description.match(STATED_OFF)
    const off = listed.includes(stated?.[1] ?? stated?.[2] ?? '')
    if (off || (name === 'reasoning_effort' && listed.includes('none'))) {
      return {
        name,
        reasoning: { mode: 'effort', mandatory: false, efforts: listed },
      }
    }
    const unset = isRecord(field) ? field.default : undefined
    const efforts = listed.filter(
      (value) => !(value === unset && value.toLowerCase() === 'none'),
    )
    if (efforts.length === 0) return null
    const droppedUnset = efforts.length !== listed.length
    const otherControl =
      'thinking_budget' in properties || 'enable_thinking' in properties
    const listsOff = efforts.some((value) =>
      ['none', 'disabled', 'off', 'no_think'].includes(value.toLowerCase()),
    )
    return {
      name,
      reasoning: {
        mode: 'effort',
        // An off value still in the list, or a `none` read as unset, is
        // not "no off value". Another control on the same schema is not
        // this list's statement either.
        mandatory: droppedUnset || otherControl || listsOff ? null : true,
        efforts,
      },
    }
  }

  const budget = properties.thinking_budget
  if (isRecord(budget)) {
    if (budget.type !== 'integer') return null
    const stated =
      typeof budget.description === 'string' &&
      /\b0 to disable thinking\b/.test(budget.description)
    return {
      name: 'thinking_budget',
      reasoning: { mode: 'budget', mandatory: stated ? false : null },
    }
  }

  const toggle = properties.enable_thinking
  if (isRecord(toggle) && toggle.type === 'boolean' && !('enum' in toggle)) {
    return {
      name: 'enable_thinking',
      reasoning: { mode: 'toggle', mandatory: false },
    }
  }
  return null
}

function runPath(owner: string, name: string): string {
  return `/models/${owner}/${name}/predictions`
}

type ChatFacts = Pick<
  ModelInfo,
  | 'capabilities'
  | 'modalities'
  | 'maxOutput'
  | 'reasoning'
  | 'schemaEndpointId'
  | 'factSources'
>

/**
 * Chat facts read from one model's own Input schema; null when the model is
 * not a language model. Schemas are never merged across models.
 */
export function replicateChatFacts(model: ReplicateModel): ChatFacts | null {
  const schemas = modelSchemas(model)
  const properties = chatInputProperties(model)
  if (!schemas || !properties || !model.owner || !model.name) return null
  const sourceUrl = `${REPLICATE_MODELS_URL}/${model.owner}/${model.name}`
  const source = (pointer: string): FactSource => ({
    derivation: 'listing',
    sourceUrl,
    path: `${INPUT_POINTER}${pointer}`,
  })
  const facts: ChatFacts = {}
  const factSources: ModelFactSources = {}

  const flags =
    walkRequestSchema(schemas.Input, { derivation: 'listing', endpointId: '' })
      ?.sources.capabilities ?? {}
  // Sorted: a reordered schema must not read as a changed model.
  facts.capabilities =
    Object.keys(flags).length > 0 ? Object.keys(flags).sort() : null
  if (facts.capabilities) {
    factSources.capabilities = Object.fromEntries(
      Object.entries(flags).map(([flag, at]) => [flag, source(at.path ?? '')]),
    )
  }

  const input = inputModalities(properties)
  if (input) {
    facts.modalities = { input, output: ['text'] }
    factSources.modalities = source('/properties')
  }

  const cap = maxOutputField(properties)
  if (cap) {
    facts.maxOutput = cap.maximum
    factSources.maxOutput = source(`/properties/${cap.name}/maximum`)
  }

  const control = reasoningField(schemas, properties)
  if (control) {
    facts.reasoning = control.reasoning
    factSources.reasoning = source(`/properties/${control.name}`)
  }

  // Only official models have a run route of their own. The poller drops
  // this until the route is synced (`bindSyncedRoutesOnly`).
  if (model.is_official === true) {
    facts.schemaEndpointId = runPath(model.owner, model.name).slice(1)
  }
  return { ...facts, factSources }
}

function refName(node: unknown): string | null {
  if (!isRecord(node) || typeof node.$ref !== 'string') return null
  return node.$ref.startsWith(SCHEMA_REF)
    ? node.$ref.slice(SCHEMA_REF.length)
    : null
}

function jsonBody(node: unknown): unknown {
  if (!isRecord(node) || !isRecord(node.content)) return undefined
  const media = node.content['application/json']
  return isRecord(media) ? media.schema : undefined
}

/**
 * One official language model's run route: the spec's official-model
 * operation with `input` (and the response's `output`) narrowed to the
 * model's own schemas. Null when the spec no longer has that shape.
 */
export function replicateModelSpec(
  spec: OpenApiDocument,
  model: ReplicateModel,
): OpenApiDocument | null {
  const operation = spec.paths?.[OFFICIAL_RUN_PATH]?.post
  const shared = spec.components?.schemas
  const own = modelSchemas(model)
  if (!operation || !shared || !own || !model.owner || !model.name) return null
  const requestName = refName(jsonBody(operation.requestBody))
  const request = requestName ? shared[requestName] : null
  if (!requestName || !isRecord(request) || !isRecord(request.properties)) {
    return null
  }
  if (!('input' in request.properties)) return null

  const schemas: Json = {
    ...shared,
    ...own,
    [requestName]: {
      ...request,
      properties: {
        ...request.properties,
        input: { $ref: `${SCHEMA_REF}Input` },
      },
    },
  }
  const responses = isRecord(operation.responses) ? operation.responses : {}
  const responseName = refName(
    Object.values(responses).map(jsonBody).find(Boolean),
  )
  const response = responseName ? shared[responseName] : null
  if (responseName && isRecord(response) && isRecord(response.properties)) {
    schemas[responseName] = {
      ...response,
      properties: {
        ...response.properties,
        output: { $ref: `${SCHEMA_REF}Output` },
      },
    }
  }
  return {
    openapi: spec.openapi,
    paths: {
      [runPath(model.owner, model.name)]: {
        post: { ...operation, [ACTIVITY_MARKER]: 'chat' },
      },
    },
    components: { schemas },
  }
}

/** The first pages of the public catalog, one entry per `owner/name`. */
async function listCatalog(key: string): Promise<Array<ReplicateModel>> {
  const headers = { Authorization: `Bearer ${key}` }
  const listed = new Map<string, ReplicateModel>()
  let url: string | null = REPLICATE_MODELS_URL
  for (let page = 0; url && page < MAX_MODEL_PAGES; page++) {
    // A short walk would read as routes removed: fail instead.
    if (!isSafeModelsUrl(url)) {
      throw new Error(`replicate: unexpected catalog page url ${url}`)
    }
    const body = (await fetchJson(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })) as ReplicateModelPage
    for (const row of body.results ?? []) {
      if (!row.owner || !row.name) continue
      const rawId = `${row.owner}/${row.name}`
      if (!listed.has(rawId)) listed.set(rawId, row)
    }
    url =
      typeof body.next === 'string' && body.next.length > 0 ? body.next : null
  }
  return [...listed.values()]
}

/**
 * The public spec, plus one route per official language model in the
 * catalog. A missing token skips the sync and a failed catalog read fails
 * it: stale routes are better than half of them.
 */
async function fetchSpec(env: ProviderSecrets): Promise<SpecFetchResult> {
  const key = env.REPLICATE_API_TOKEN
  if (!key) {
    return {
      specs: [],
      sources: [],
      outputStrategy: 'post-200',
      ...skippedResult('replicate', 'REPLICATE_API_TOKEN'),
    }
  }
  const { spec, hash } = await fetchOpenApi(REPLICATE_OPENAPI_URL)
  const result: SpecFetchResult = {
    specs: [spec],
    sources: [{ url: REPLICATE_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
  const warnings: Array<string> = []
  for (const model of await listCatalog(key)) {
    if (!replicateChatFacts(model)?.schemaEndpointId) continue
    const rawId = `${model.owner}/${model.name}`
    const document = replicateModelSpec(spec, model)
    if (!document) {
      warnings.push(`replicate ${rawId}: no official run route in the spec`)
      continue
    }
    result.specs.push(document)
    result.sources.push({
      url: `${REPLICATE_MODELS_URL}/${rawId}`,
      hash: await contentHash(model.latest_version?.openapi_schema),
    })
  }
  return warnings.length > 0 ? { ...result, warnings } : result
}

function modelPageUrl(owner: string, name: string): string {
  return `https://replicate.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

function readmeUrl(owner: string, name: string): string {
  return `${REPLICATE_MODELS_URL}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/readme`
}

function inlineBilling(model: ReplicateModel): ReplicateBilling | null {
  const raw = model.billing_config ?? model.billingConfig
  if (!raw || typeof raw !== 'object') return null
  return raw
}

/**
 * Official models publish a prediction price on the model page (the models
 * list often omits it). A page with no billing config, or a fetch failure,
 * leaves the row unpriced. Community models are not fetched.
 */
async function withPredictionPrice(
  model: ReplicateModel,
  info: ModelInfo,
  kv?: KVNamespace,
): Promise<ModelInfo> {
  const owner = model.owner
  const name = model.name
  if (!owner || !name) return info
  const pageUrl = modelPageUrl(owner, name)
  const inline = inlineBilling(model)
  if (inline) {
    const extractedAt = new Date().toISOString()
    const source = {
      url: pageUrl,
      hash: await sha256Text(JSON.stringify(inline)),
      extractedAt,
    }
    const pricing = compileReplicateBilling(inline, source)
    if (!pricing) return info
    return {
      ...info,
      pricing,
      factSources: {
        ...info.factSources,
        pricing: {
          derivation: 'docs-derived',
          sourceUrl: pageUrl,
          sourceHash: source.hash,
          path: 'billing_config',
        },
      },
    }
  }
  if (model.is_official !== true) return info
  try {
    const doc = await cachedDocs(kv, pageUrl, async () => {
      const html = await fetchText(pageUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      // Every official model page embeds this. A 200 without it is an error
      // or challenge page: throw, so it is neither priced nor cached.
      if (!html.includes(BILLING_MARKER)) {
        throw new Error(`replicate: ${pageUrl} has no billing config`)
      }
      return {
        billing: replicateBillingFromHtml(html),
        hash: await sha256Text(html),
        extractedAt: new Date().toISOString(),
      }
    })
    const source = {
      url: pageUrl,
      hash: doc.hash,
      extractedAt: doc.extractedAt,
    }
    const pricing = compileReplicateBilling(doc.billing, source)
    if (!pricing) return info
    return {
      ...info,
      pricing,
      factSources: {
        ...info.factSources,
        pricing: {
          derivation: 'docs-derived',
          sourceUrl: pageUrl,
          sourceHash: doc.hash,
          path: 'billingConfig',
        },
      },
    }
  } catch {
    return info
  }
}

/**
 * Context window, and an output cap the schema leaves unset, from the
 * model's README and listing description. A fetch failure leaves both
 * null. The schema's own maximum is kept when the README also states one.
 */
async function withReadmeFacts(
  model: ReplicateModel,
  info: ModelInfo,
  key: string,
  kv?: KVNamespace,
): Promise<ModelInfo> {
  const owner = model.owner
  const name = model.name
  if (info.activity !== 'chat' || !owner || !name) return info
  const page = readmeUrl(owner, name)
  let markdown = ''
  let hash: string | undefined
  try {
    const doc = await cachedDocs(kv, page, async () => {
      const response = await fetch(page, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      // No README is a fact, not a failed fetch.
      if (response.status === 404) {
        return { markdown: '', hash: await sha256Text('') }
      }
      if (!response.ok) {
        throw new Error(
          `replicate: ${page} → ${String(response.status)} ${response.statusText}`,
        )
      }
      const body = await response.text()
      const trimmed = body.trimStart()
      // An error document or the models list is not a README.
      if (trimmed.startsWith('{') || trimmed.startsWith('<!')) {
        throw new Error(`replicate: ${page} is not a README`)
      }
      return { markdown: body, hash: await sha256Text(body) }
    })
    markdown = doc.markdown
    hash = doc.hash
  } catch {
    return info
  }
  const facts = replicateReadmeFacts(markdown, model.description ?? '')
  const factSources = { ...info.factSources }
  const listing = `${REPLICATE_MODELS_URL}/${owner}/${name}`
  let changed = false
  if (
    info.contextWindow == null &&
    facts.contextWindow != null &&
    facts.context
  ) {
    info = { ...info, contextWindow: facts.contextWindow }
    factSources.contextWindow =
      facts.context.from === 'description'
        ? { derivation: 'listing', sourceUrl: listing, path: 'description' }
        : {
            derivation: 'docs-derived',
            sourceUrl: page,
            ...(hash ? { sourceHash: hash } : {}),
            path: facts.context.path,
          }
    changed = true
  }
  if (info.maxOutput == null && facts.maxOutput != null && facts.max) {
    info = { ...info, maxOutput: facts.maxOutput }
    factSources.maxOutput = {
      derivation: 'docs-derived',
      sourceUrl: page,
      ...(hash ? { sourceHash: hash } : {}),
      path: facts.max.path,
    }
    changed = true
  }
  return changed ? { ...info, factSources } : info
}

function toModelInfo(model: ReplicateModel): ModelInfo | null {
  if (typeof model.owner !== 'string' || typeof model.name !== 'string') {
    return null
  }
  if (model.owner.length === 0 || model.name.length === 0) return null
  const rawId = `${model.owner}/${model.name}`
  const chat = replicateChatFacts(model)
  return {
    rawId,
    displayName: model.name,
    activity: chat
      ? 'chat'
      : activityFromHaystack(`${rawId} ${model.description ?? ''}`, false),
    releasedAt:
      isoToEpochSeconds(model.created_at) ??
      isoToEpochSeconds(model.latest_version?.created_at),
    providerMetadata: {
      visibility: model.visibility,
      official: model.is_official,
    },
    // A chat row carries request flags as well.
    ...chat,
  }
}

async function listModels(
  env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const key = env.REPLICATE_API_TOKEN
  if (!key) {
    return { models: [], ...skippedResult('replicate', 'REPLICATE_API_TOKEN') }
  }
  const listed = (await listCatalog(key)).flatMap((model) => {
    const info = toModelInfo(model)
    return info ? [{ info, model }] : []
  })
  return {
    models: await mapConcurrent(listed, 8, async ({ info, model }) =>
      withReadmeFacts(
        model,
        await withPredictionPrice(model, info, kv),
        key,
        kv,
      ),
    ),
  }
}

export const provider: ProviderConfig = {
  id: 'replicate',
  displayName: 'Replicate',
  authEnvVar: 'REPLICATE_API_TOKEN',
  specSourceUrl: REPLICATE_OPENAPI_URL,
  modelsEndpoint: REPLICATE_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  bindSyncedRoutesOnly: true,
  fetchSpec,
  listModels,
  classify,
}
