/**
 * Assemble a generation-only OpenAPI 3.1 document for one provider from
 * stored endpoints + current schema versions + the provider's connect
 * profile. Reuses `schema_versions` rows (no second derivation); overlays
 * the live or pinned `model` enum, and moves output onto the sibling GET
 * when `connect.siblingGet` is set.
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { activities, endpoints, models, schemaVersions } from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import {
  getModelDetail,
  knownProviderIds,
  listModelsCatalog,
} from '#/server/catalog.ts'
import { contentHash } from '#/server/kv.ts'
import { getProvider } from '#/server/providers/index.ts'
import {
  MAX_QUEUE_SPEC_PATHS,
  requiredHeaderParameters,
  resolveSpecGrain,
} from '#/server/providers/connect.ts'
import type {
  ProviderConfig,
  ProviderConnect,
  RequiredHeader,
} from '#/server/providers/types.ts'
import { hasAsyncApiFlag } from '#/server/ingest/asyncapi.ts'
import { providerExists, publicEndpointId } from '#/server/schemas-api.ts'

export interface AssembleOpenApiQuery {
  model?: string
  activity?: string
}

export type AssembleOpenApiResult =
  | { ok: true; document: Record<string, unknown>; etag: string }
  | { ok: false; status: 400 | 404 | 500; code: string; message: string }

interface LoadedEndpoint {
  id: string
  path: string
  activity: Activity
  description: string | null
  method: string
  input?: unknown
  output?: unknown
  /** SSE event schema when `output` is the JSON success body. */
  streamSchema?: unknown
  /** Null means `application/json` (the column stays unset for that default). */
  requestContentType: string | null
  /**
   * Null means a JSON success body. A stream stays in the list beside
   * JSON. Audio and octet-stream stay in the list.
   */
  responseContentTypes: Array<string> | null
  specRevision: string | null
  /** Set when the endpoint was selected for a queue document. */
  modelRawId?: string
}

const QUEUE_PATH = '/{endpoint_id}'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `{name}` path segments → required path parameters. */
export function pathParamsFromPath(
  path: string,
): Array<Record<string, unknown>> {
  const names = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
  return names
    .filter((name): name is string => typeof name === 'string' && name !== '')
    .map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }))
}

export function headerParams(
  headers: Array<RequiredHeader> | undefined,
): Array<Record<string, unknown>> {
  return requiredHeaderParameters(headers)
}

/** Pin `properties.model` to a live enum (or a single id). */
export function applyModelEnum(
  schema: unknown,
  modelIds: Array<string>,
): unknown {
  if (!isObject(schema) || modelIds.length === 0) return schema
  const props = schema.properties
  if (!isObject(props) || !isObject(props.model)) return schema
  return {
    ...schema,
    properties: {
      ...props,
      model: { ...props.model, enum: modelIds },
    },
  }
}

/** Pin common model path params (Gemini `modelsId`). */
function pinPathParams(
  parameters: Array<Record<string, unknown>>,
  modelId: string,
): Array<Record<string, unknown>> {
  return parameters.map((parameter) => {
    const name = parameter.name
    if (parameter.in !== 'path') return parameter
    if (name !== 'model' && name !== 'modelsId' && name !== 'model_id') {
      return parameter
    }
    return { ...parameter, schema: { type: 'string', enum: [modelId] } }
  })
}

function isFileLikeType(mediaType: string): boolean {
  return (
    mediaType === 'application/octet-stream' ||
    mediaType.startsWith('audio/') ||
    mediaType.startsWith('image/') ||
    mediaType.startsWith('video/')
  )
}

const BINARY_SCHEMA = { type: 'string', format: 'binary' } as const

/**
 * Request body for the generation document. A missing type is JSON, which
 * is how rows synced before content types were recorded are assembled.
 */
export function requestMedia(
  schema: unknown,
  contentType: string | null | undefined,
): { content: Record<string, { schema: unknown }> } | undefined {
  if (schema === undefined) return undefined
  const mediaType = contentType || 'application/json'
  return { content: { [mediaType]: { schema } } }
}

function mediaTypeBase(value: string): string {
  return value.split(';')[0]?.trim().toLowerCase() ?? ''
}

function isJsonMedia(mediaType: string): boolean {
  const base = mediaTypeBase(mediaType)
  return base === 'application/json' || base.endsWith('+json')
}

/** SSE, or Ollama's newline-delimited JSON. Both carry `streamSchema`. */
function isStreamMedia(mediaType: string): boolean {
  const base = mediaTypeBase(mediaType)
  return (
    base === 'text/event-stream' ||
    base.endsWith('/event-stream') ||
    base === 'application/x-ndjson'
  )
}

/**
 * Success response body. File-like types are binary. `text/plain` is a
 * string. `text/event-stream` and `application/x-ndjson` use `streamSchema` when the list also
 * contains JSON, and never the JSON schema and never a made-up string.
 */
export function responseMedia(
  schema: unknown,
  contentTypes: Array<string> | null | undefined,
  streamSchema?: unknown,
): { content: Record<string, { schema: unknown }> } | undefined {
  const types =
    contentTypes && contentTypes.length > 0
      ? contentTypes
      : schema === undefined
        ? []
        : ['application/json']
  if (types.length === 0) return undefined
  const listedJson = types.some(isJsonMedia)
  const content: Record<string, { schema: unknown }> = {}
  for (const mediaType of types) {
    if (isFileLikeType(mediaType)) {
      content[mediaType] = { schema: BINARY_SCHEMA }
      continue
    }
    if (isStreamMedia(mediaType)) {
      const body =
        streamSchema !== undefined
          ? streamSchema
          : listedJson
            ? undefined
            : schema
      if (body === undefined) continue
      content[mediaType] = { schema: body }
      continue
    }
    if (isJsonMedia(mediaType)) {
      if (schema === undefined) continue
      content[mediaType] = { schema }
      continue
    }
    if (mediaTypeBase(mediaType).startsWith('text/')) {
      content[mediaType] = { schema: { type: 'string' } }
      continue
    }
    if (schema === undefined) continue
    content[mediaType] = { schema }
  }
  return Object.keys(content).length > 0 ? { content } : undefined
}

function operationId(providerId: string, method: string, path: string): string {
  const slug = `${providerId}-${method}-${path}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : `${providerId}-${method}`
}

export function endpointMatchesModel(
  endpointId: string,
  path: string,
  rawId: string,
): boolean {
  return endpointId === rawId || path === rawId || path === `/${rawId}`
}

function siblingRequestPath(path: string): string {
  return `${path}/requests/{request_id}`
}

function refuseModelGrained(
  providerId: string,
  count: number,
): AssembleOpenApiResult {
  const example = `GET /v1/openapi/${providerId}?model=`
  const modelList = `GET /v1/providers/${providerId}/models`
  return {
    ok: false,
    status: 400,
    code: 'spec_requires_selector',
    message: `Provider '${providerId}' is model-grained (${String(count)} endpoints) — there is no combined OpenAPI document. Pass ?model={rawId}, e.g. ${example}<rawId>. List models: ${modelList}.`,
  }
}

function applyConnectProfile(
  config: ProviderConfig | undefined,
  selected: Array<LoadedEndpoint>,
): { connect: ProviderConnect | null; selected: Array<LoadedEndpoint> } {
  if (!config?.connect) return { connect: null, selected }
  const overrides = config.connectByActivity
  if (!overrides) return { connect: config.connect, selected }

  const present = new Set(selected.map((endpoint) => endpoint.activity))
  if (present.size === 1) {
    const only = selected[0]?.activity
    const override = only !== undefined ? overrides[only] : undefined
    return { connect: override ?? config.connect, selected }
  }
  return {
    connect: config.connect,
    selected: selected.filter(
      (endpoint) => overrides[endpoint.activity] === undefined,
    ),
  }
}

/**
 * `bodies: false` fetches presence only: a stored schema arrives as `{}`,
 * so `input !== undefined` still holds without shipping and parsing every
 * body. The lean queue document emits none of them.
 */
async function loadEndpoints(
  db: Db,
  providerId: string,
  activity: Activity | undefined,
  bodies = true,
): Promise<Array<LoadedEndpoint>> {
  const rows = await db
    .select({
      id: endpoints.id,
      path: endpoints.path,
      activity: endpoints.activity,
      description: endpoints.description,
      method: endpoints.method,
      requestContentType: endpoints.requestContentType,
      responseContentTypes: endpoints.responseContentTypes,
      kind: schemaVersions.kind,
      schema: bodies
        ? schemaVersions.schema
        : sql<
            string | null
          >`CASE WHEN ${schemaVersions.schema} IS NULL THEN NULL ELSE '{}' END`,
      specRevision: schemaVersions.specRevision,
    })
    .from(endpoints)
    .leftJoin(
      schemaVersions,
      and(
        eq(schemaVersions.endpointId, endpoints.id),
        isNull(schemaVersions.supersededAt),
      ),
    )
    .where(
      activity
        ? and(
            eq(endpoints.providerId, providerId),
            eq(endpoints.activity, activity),
          )
        : eq(endpoints.providerId, providerId),
    )
    .orderBy(endpoints.id)

  const byId = new Map<string, LoadedEndpoint>()
  for (const row of rows) {
    const existing = byId.get(row.id)
    const parsed =
      row.schema !== null ? (JSON.parse(row.schema) as unknown) : undefined
    if (!existing) {
      byId.set(row.id, {
        id: publicEndpointId(row.id, providerId),
        path: row.path,
        activity: row.activity,
        description: row.description,
        method: row.method,
        requestContentType: row.requestContentType,
        responseContentTypes: row.responseContentTypes,
        specRevision: row.specRevision,
        ...(row.kind === 'input' ? { input: parsed } : {}),
        ...(row.kind === 'output' ? { output: parsed } : {}),
        ...(row.kind === 'stream' ? { streamSchema: parsed } : {}),
      })
      continue
    }
    if (row.kind === 'input') existing.input = parsed
    if (row.kind === 'output') existing.output = parsed
    if (row.kind === 'stream') existing.streamSchema = parsed
    if (existing.specRevision === null) existing.specRevision = row.specRevision
  }
  return [...byId.values()]
}

function contentTypesFor(
  endpoint: LoadedEndpoint,
  part: 'all' | 'body',
): Array<string> | null {
  const types = endpoint.responseContentTypes
  if (!types) return null
  const dropStream =
    part === 'body' ||
    (types.some(isJsonMedia) && endpoint.streamSchema === undefined)
  if (!dropStream) return types
  const rest = types.filter((type) => !isStreamMedia(type))
  return rest.length > 0 ? rest : null
}

function buildOperation(
  providerId: string,
  endpoint: LoadedEndpoint,
  connect: ProviderConnect,
  modelIds: Array<string>,
  pinnedModel: string | undefined,
): Record<string, unknown> {
  const input = applyModelEnum(endpoint.input, modelIds)
  const parameters = [
    ...pathParamsFromPath(endpoint.path),
    ...headerParams(connect.requiredHeaders),
    ...(connect.modelHeader && modelIds.length > 0
      ? [
          {
            name: connect.modelHeader,
            in: 'header',
            required: false,
            schema: { type: 'string', enum: modelIds },
          },
        ]
      : []),
  ]
  const pinned = pinnedModel
    ? pinPathParams(parameters, pinnedModel)
    : parameters
  const body = requestMedia(input, endpoint.requestContentType)
  const media = connect.siblingGet
    ? undefined
    : responseMedia(
        endpoint.output,
        contentTypesFor(endpoint, 'all'),
        endpoint.streamSchema,
      )
  return {
    operationId: operationId(providerId, 'post', endpoint.path),
    summary: endpoint.description ?? undefined,
    'x-modelschemas-activity': endpoint.activity,
    ...(pinned.length > 0 ? { parameters: pinned } : {}),
    ...(body ? { requestBody: { required: true, ...body } } : {}),
    responses: {
      '200': {
        description: 'Success',
        ...media,
      },
    },
  }
}

function buildSiblingGet(
  providerId: string,
  endpoint: LoadedEndpoint,
): Record<string, unknown> {
  const requestPath = siblingRequestPath(endpoint.path)
  return {
    operationId: operationId(providerId, 'get', requestPath),
    summary: 'Fetch a queued request result',
    'x-modelschemas-activity': endpoint.activity,
    parameters: [
      ...pathParamsFromPath(endpoint.path),
      {
        name: 'request_id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': {
        description: 'Queued result',
        ...responseMedia(endpoint.output, contentTypesFor(endpoint, 'body')),
      },
    },
  }
}

interface QueueModel {
  rawId: string
  capabilities: unknown
}

/**
 * Rows for a queue document. `?activity=` includes deprecated models in
 * that activity: the schema index still lists their endpoints, and a
 * generated client needs those bodies. The bare document stays live-only.
 */
async function loadQueueModels(
  db: Db,
  providerId: string,
  activity: Activity | undefined,
): Promise<Array<QueueModel>> {
  const conditions: Array<SQL> = [eq(models.providerId, providerId)]
  if (activity) conditions.push(eq(models.activity, activity))
  else conditions.push(isNull(models.deprecatedAt))
  return db
    .select({
      rawId: models.rawId,
      capabilities: models.capabilities,
    })
    .from(models)
    .where(and(...conditions))
    .orderBy(models.rawId)
}

/**
 * One endpoint per queue model. The raw id is the queue path value
 * (`https://queue.fal.run/{rawId}`), which is not the same string as the
 * stored path (`/{rawId}`). A model with no stored endpoint is left out.
 */
function selectQueueEndpoints(
  loaded: Array<LoadedEndpoint>,
  rawIds: Array<string>,
): Array<LoadedEndpoint> {
  // Every key endpointMatchesModel accepts, so the match is one lookup.
  const byKey = new Map<string, string>()
  for (const rawId of rawIds) {
    byKey.set(rawId, rawId)
    byKey.set(`/${rawId}`, rawId)
  }
  const pending = new Set(rawIds)
  const selected: Array<LoadedEndpoint> = []
  for (const endpoint of loaded) {
    const matched = byKey.get(endpoint.id) ?? byKey.get(endpoint.path)
    if (matched === undefined || !pending.has(matched)) continue
    pending.delete(matched)
    selected.push({ ...endpoint, modelRawId: matched })
  }
  selected.sort((a, b) =>
    (a.modelRawId ?? '').localeCompare(b.modelRawId ?? ''),
  )
  return selected
}

/** Component key. OpenAPI names are letters, digits, `.`, `_`, and `-`. */
function schemaComponentKey(
  kind: 'input' | 'output',
  rawId: string,
  used: Set<string>,
): string {
  const slug = rawId.replace(/[^A-Za-z0-9._-]+/g, '_')
  let key = `${kind}_${slug}`
  if (!/^[A-Za-z_]/.test(key)) key = `m_${key}`
  key = key.slice(0, 240)
  let unique = key
  let n = 2
  while (used.has(unique)) {
    unique = `${key.slice(0, 220)}_${String(n)}`
    n += 1
  }
  used.add(unique)
  return unique
}

function withModelAnnotation(schema: unknown, rawId: string): unknown {
  if (isObject(schema)) return { ...schema, 'x-modelschemas-model': rawId }
  return { 'x-modelschemas-model': rawId, allOf: [schema] }
}

function schemaUnion(
  refs: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (refs.length === 1) return refs[0]
  // anyOf: FAL inputs overlap (prompt, image_url, …), so a valid body for
  // one model often satisfies several schemas. oneOf would reject it.
  if (refs.length > 1) return { anyOf: refs }
  return undefined
}

/**
 * OpenAPI path templating matches one segment and percent-encodes
 * reserved characters. FAL ids contain slashes, so generators must append
 * the raw id. `x-modelschemas-encode: raw` is that contract.
 */
function queueEndpointParameter(
  rawIds: Array<string>,
): Record<string, unknown> {
  return {
    name: 'endpoint_id',
    in: 'path',
    required: true,
    'x-modelschemas-encode': 'raw',
    description:
      'Model raw id. Slashes are path segments: fal-ai/flux/dev is https://queue.fal.run/fal-ai/flux/dev, not fal-ai%2Fflux%2Fdev. x-modelschemas-encode is raw — do not percent-encode this value.',
    schema: { type: 'string', enum: rawIds },
  }
}

/**
 * The model that owns each endpoint: the longest raw id that is the path
 * or a path prefix (`/reactor/helios/events/set_prompt` → `reactor/helios`).
 * Undefined when an endpoint has no owner or two endpoints share a path,
 * since neither can be one document.
 */
async function endpointOwners(
  db: Db,
  providerId: string,
  selected: Array<LoadedEndpoint>,
): Promise<Map<string, string> | undefined> {
  const rows = await db
    .select({ rawId: models.rawId })
    .from(models)
    .where(eq(models.providerId, providerId))
  const rawIds = rows
    .map((row) => row.rawId)
    .sort((a, b) => b.length - a.length)
  const owners = new Map<string, string>()
  const paths = new Set<string>()
  for (const endpoint of selected) {
    if (paths.has(endpoint.path)) return undefined
    paths.add(endpoint.path)
    const owner = rawIds.find(
      (rawId) =>
        endpointMatchesModel(endpoint.id, endpoint.path, rawId) ||
        endpoint.path.startsWith(`/${rawId}/`),
    )
    if (owner === undefined) return undefined
    owners.set(endpoint.id, owner)
  }
  return owners
}

/** Each endpoint's bodies as `$ref`s to `input_`/`output_` components. */
function buildModelComponents(
  selected: Array<LoadedEndpoint>,
  owners: Map<string, string>,
): { endpoints: Array<LoadedEndpoint>; schemas: Record<string, unknown> } {
  const used = new Set<string>()
  const schemas: Record<string, unknown> = {}
  const component = (
    kind: 'input' | 'output',
    endpoint: LoadedEndpoint,
    schema: unknown,
    owner: string,
  ) => {
    if (schema === undefined) return undefined
    const name = schemaComponentKey(kind, endpoint.id, used)
    schemas[name] = withModelAnnotation(schema, owner)
    return { $ref: `#/components/schemas/${name}` }
  }
  const typed = selected.map((endpoint) => {
    const owner = owners.get(endpoint.id)
    if (owner === undefined) {
      throw new Error(`openapi: endpoint ${endpoint.id} has no owning model`)
    }
    return {
      ...endpoint,
      input: component(
        'input',
        endpoint,
        applyModelEnum(endpoint.input, [owner]),
        owner,
      ),
      output: component('output', endpoint, endpoint.output, owner),
    }
  })
  return { endpoints: typed, schemas }
}

/**
 * One queue client: `POST /{endpoint_id}` and
 * `GET /{endpoint_id}/requests/{request_id}`. A model is in `endpoint_id`
 * only when it has an input schema. The request `anyOf` is those schemas,
 * in enum order. The result schema is included only when every included
 * model has an output schema, in the same order. A partial set is omitted
 * rather than filled with another model's schema.
 *
 * `lean` (no `?activity=`: every live model) keeps the enum and leaves the
 * bodies untyped — a thousand inlined schemas is not a client. Each
 * model's own schema stays at `GET /v1/schemas/{provider}/...`.
 */
function buildQueueDocument(
  providerId: string,
  selected: Array<LoadedEndpoint>,
  connect: ProviderConnect,
  lean: boolean,
):
  | {
      paths: Record<string, Record<string, unknown>>
      schemas: Record<string, unknown>
    }
  | { empty: true } {
  const typed = selected.filter(
    (
      endpoint,
    ): endpoint is LoadedEndpoint & { modelRawId: string; input: unknown } =>
      endpoint.modelRawId !== undefined && endpoint.input !== undefined,
  )
  if (typed.length === 0) return { empty: true }
  const used = new Set<string>()
  const schemas: Record<string, unknown> = {}
  const inputRefs: Array<Record<string, unknown>> = []
  const outputRefs: Array<Record<string, unknown>> = []
  const rawIds = typed.map((endpoint) => endpoint.modelRawId)
  const outputsComplete = typed.every(
    (endpoint) => endpoint.output !== undefined,
  )
  for (const endpoint of typed) {
    if (lean) break
    const rawId = endpoint.modelRawId
    const inputName = schemaComponentKey('input', rawId, used)
    schemas[inputName] = withModelAnnotation(endpoint.input, rawId)
    inputRefs.push({ $ref: `#/components/schemas/${inputName}` })
    if (!outputsComplete || endpoint.output === undefined) continue
    const outputName = schemaComponentKey('output', rawId, used)
    schemas[outputName] = withModelAnnotation(endpoint.output, rawId)
    outputRefs.push({ $ref: `#/components/schemas/${outputName}` })
  }
  const activitiesPresent = new Set(typed.map((endpoint) => endpoint.activity))
  const onlyActivity =
    activitiesPresent.size === 1 ? typed[0]?.activity : undefined
  const endpointParam = queueEndpointParameter(rawIds)
  const input = lean
    ? {
        type: 'object',
        description: `The model's own input schema: GET /v1/schemas/${providerId}/{activity}/{endpoint_id}?kind=input. Pass ?activity= on this document to inline them.`,
      }
    : schemaUnion(inputRefs)
  const output = !lean && outputsComplete ? schemaUnion(outputRefs) : undefined
  const post: Record<string, unknown> = {
    operationId: operationId(providerId, 'post', QUEUE_PATH),
    summary: onlyActivity
      ? `Queue a ${onlyActivity} generation`
      : 'Queue a generation',
    ...(onlyActivity ? { 'x-modelschemas-activity': onlyActivity } : {}),
    parameters: [endpointParam, ...headerParams(connect.requiredHeaders)],
    ...(input
      ? { requestBody: { required: true, ...requestMedia(input, null) } }
      : {}),
    responses: {
      '200': {
        description: 'Success',
        ...(connect.siblingGet ? {} : (responseMedia(output, null) ?? {})),
      },
    },
  }
  const paths: Record<string, Record<string, unknown>> = {
    [QUEUE_PATH]: { post },
  }
  if (connect.siblingGet) {
    const requestPath = siblingRequestPath(QUEUE_PATH)
    paths[requestPath] = {
      get: {
        operationId: operationId(providerId, 'get', requestPath),
        summary: 'Fetch a queued request result',
        ...(onlyActivity ? { 'x-modelschemas-activity': onlyActivity } : {}),
        parameters: [
          endpointParam,
          {
            name: 'request_id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description:
              lean || outputsComplete
                ? 'Queued result'
                : `Queued result. Untyped: ${String(typed.filter((endpoint) => endpoint.output === undefined).length)} of ${String(typed.length)} models have no stored output schema, so no result union is published. GET /v1/schemas/${providerId}/{activity}/{endpoint_id}?kind=output for one model.`,
            ...(output ? responseMedia(output, null) : {}),
          },
        },
      },
    }
  }
  return { paths, schemas }
}

/**
 * Union two media maps. A type only one side lists is kept. A type both
 * list with different schemas becomes `anyOf` (`union`) or an error.
 */
function mergeContent(
  base: unknown,
  extra: unknown,
  union: boolean,
  where: string,
): Record<string, unknown> | undefined {
  if (!isObject(extra)) return isObject(base) ? base : undefined
  const out: Record<string, unknown> = isObject(base) ? { ...base } : {}
  for (const [type, media] of Object.entries(extra)) {
    const have = out[type]
    if (!isObject(have) || !isObject(media)) {
      out[type] = media
      continue
    }
    if (JSON.stringify(have.schema) === JSON.stringify(media.schema)) continue
    if (!union) {
      throw new Error(
        `${where} lists ${type} on both the base path and its #stream twin with different schemas`,
      )
    }
    out[type] = { ...have, schema: { anyOf: [have.schema, media.schema] } }
  }
  return out
}

/**
 * One operation for an upstream `#stream` twin and its base path (Mistral
 * transcriptions: the base requires `stream: false`, the twin
 * `stream: true`). Both request bodies are accepted (`anyOf`), and the
 * 200 lists both sides' media types.
 */
function mergeTwin(
  base: Record<string, unknown>,
  twin: Record<string, unknown>,
  where: string,
): Record<string, unknown> {
  const body = (operation: Record<string, unknown>) =>
    isObject(operation.requestBody) ? operation.requestBody : undefined
  const success = (operation: Record<string, unknown>) => {
    const responses = operation.responses
    const ok = isObject(responses) ? responses['200'] : undefined
    return isObject(ok) ? ok : undefined
  }
  const baseBody = body(base)
  const twinBody = body(twin)
  const requestContent = mergeContent(
    baseBody?.content,
    twinBody?.content,
    true,
    where,
  )
  const baseOk = success(base)
  const okContent = mergeContent(
    baseOk?.content,
    success(twin)?.content,
    false,
    where,
  )
  return {
    ...base,
    ...(requestContent
      ? { requestBody: { ...baseBody, ...twinBody, content: requestContent } }
      : {}),
    responses: {
      ...(isObject(base.responses) ? base.responses : {}),
      '200': {
        description: 'Success',
        ...baseOk,
        ...(okContent ? { content: okContent } : {}),
      },
    },
  }
}

const DEFS_REF = '#/$defs/'
const COMPONENT_REF = '#/components/schemas/'

/** FNV-1a, 8 hex chars: a stable name suffix, not a security hash. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Component keys allow letters, digits, `.`, `_`, and `-`. */
function componentName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_') || '_'
}

function decodePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

function hasRootRef(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasRootRef)
  if (!isObject(node)) return false
  return Object.entries(node).some(([key, value]) =>
    key === '$ref' ? value === '#' : hasRootRef(value),
  )
}

/** `#/$defs/X…` → `#/components/schemas/<names[X]>…`, or undefined. */
function mapDefRef(
  value: string,
  names: Map<string, string>,
): string | undefined {
  // Discriminator mappings keep upstream's `#/components/schemas/X` form.
  const prefix = [DEFS_REF, COMPONENT_REF].find((p) => value.startsWith(p))
  if (prefix === undefined) return undefined
  const rest = value.slice(prefix.length)
  const slash = rest.indexOf('/')
  const token = slash === -1 ? rest : rest.slice(0, slash)
  const mapped = names.get(decodePointerToken(token))
  if (mapped === undefined) return undefined
  return COMPONENT_REF + mapped + (slash === -1 ? '' : rest.slice(slash))
}

/**
 * Point `$ref`s and discriminator mappings at the hoisted components;
 * `$ref: '#'` → `self`.
 */
function rewriteDefRefs(
  node: unknown,
  names: Map<string, string>,
  self: string | undefined,
): unknown {
  if (Array.isArray(node)) {
    return node.map((value) => rewriteDefRefs(value, names, self))
  }
  if (!isObject(node)) return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') {
      if (value === '#' && self !== undefined) {
        out[key] = COMPONENT_REF + self
        continue
      }
      if (value.startsWith(DEFS_REF)) {
        const mapped = mapDefRef(value, names)
        if (mapped !== undefined) {
          out[key] = mapped
          continue
        }
      }
    }
    if (key === 'discriminator' && isObject(value) && isObject(value.mapping)) {
      const mapping: Record<string, unknown> = {}
      for (const [tag, target] of Object.entries(value.mapping)) {
        mapping[tag] =
          typeof target === 'string'
            ? (mapDefRef(target, names) ?? target)
            : target
      }
      out[key] = { ...value, mapping }
      continue
    }
    out[key] = rewriteDefRefs(value, names, self)
  }
  return out
}

/**
 * Lift one stored schema's `$defs` into `components` and point its refs
 * there: inside an OpenAPI document `#` is the document root, so a bare
 * `#/$defs/X` never resolves. Identical definitions share one component.
 * A name already taken by different content gets a suffix hashed from
 * this schema's `$defs` and which of them were renamed, so each schema
 * keeps its own definition.
 * `self` names the component this schema itself becomes (for `$ref: '#'`).
 */
function hoistRoot(
  schema: unknown,
  components: Record<string, unknown>,
  seen: Map<string, string>,
  self?: string,
): unknown {
  if (!isObject(schema)) return schema
  const defs = isObject(schema.$defs) ? schema.$defs : {}
  const selfRef = hasRootRef(schema)
  if (Object.keys(defs).length === 0 && !selfRef) return schema
  const { $defs: _defs, ...root } = schema
  const defsText = JSON.stringify(defs)
  const rootName =
    self ??
    (selfRef ? `Schema_${shortHash(JSON.stringify(schema))}` : undefined)
  const encoded = (name: string): string => {
    const cached = seen.get(name)
    if (cached !== undefined) return cached
    const text = JSON.stringify(components[name])
    seen.set(name, text)
    return text
  }
  const renamed = new Set<string>()
  for (;;) {
    // The suffix covers everything the renamed content depends on, so the
    // same name always means the same content.
    const base = JSON.stringify([defsText, [...renamed].sort(), rootName])
    const names = new Map(
      Object.keys(defs).map((key) => [
        key,
        renamed.has(key)
          ? `${componentName(key)}_${shortHash(`${key}\0${base}`)}`
          : componentName(key),
      ]),
    )
    const placed = new Map<string, { text: string; value: unknown }>()
    const clashes: Array<string> = []
    for (const [key, def] of Object.entries(defs)) {
      const name = names.get(key) ?? componentName(key)
      const value = rewriteDefRefs(def, names, rootName)
      const text = JSON.stringify(value)
      const local = placed.get(name)
      const taken =
        local !== undefined
          ? local.text
          : components[name] !== undefined
            ? encoded(name)
            : undefined
      if (taken !== undefined && taken !== text) {
        if (renamed.has(key)) {
          throw new Error(
            `component schema '${name}' is defined twice with different content`,
          )
        }
        clashes.push(key)
        continue
      }
      placed.set(name, { text, value })
    }
    if (clashes.length > 0) {
      for (const key of clashes) renamed.add(key)
      continue
    }
    for (const [name, entry] of placed) {
      if (components[name] === undefined) {
        components[name] = entry.value
        seen.set(name, entry.text)
      }
    }
    const body = rewriteDefRefs(root, names, rootName)
    if (rootName === undefined || self !== undefined) return body
    components[rootName] = body
    return { $ref: COMPONENT_REF + rootName }
  }
}

/**
 * Every schema slot in `items` (path items: request and response bodies)
 * and every given component, with `$defs` hoisted into the returned
 * `components.schemas`. Mutates the path items in place.
 */
export function hoistSchemaDefs(
  items: Iterable<Record<string, unknown>>,
  initial: Record<string, unknown>,
): Record<string, unknown> {
  const components: Record<string, unknown> = { ...initial }
  const seen = new Map<string, string>()
  for (const [name, schema] of Object.entries(initial)) {
    components[name] = hoistRoot(schema, components, seen, name)
    seen.delete(name)
  }
  const hoistContent = (holder: unknown) => {
    if (!isObject(holder) || !isObject(holder.content)) return
    for (const media of Object.values(holder.content)) {
      if (isObject(media) && 'schema' in media) {
        media.schema = hoistRoot(media.schema, components, seen)
      }
    }
  }
  for (const item of items) {
    for (const operation of Object.values(item)) {
      if (!isObject(operation)) continue
      hoistContent(operation.requestBody)
      if (!isObject(operation.responses)) continue
      for (const response of Object.values(operation.responses)) {
        hoistContent(response)
      }
    }
  }
  return components
}

/** Resolve a local `$ref` as a JSON pointer against the document root. */
function resolvePointer(document: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined
  let node: unknown = document
  for (const raw of ref.slice(2).split('/')) {
    if (!isObject(node) && !Array.isArray(node)) return undefined
    node = (node as Record<string, unknown>)[decodePointerToken(raw)]
  }
  return node
}

/** Every `$ref` in `document` that does not resolve, with where it sits. */
export function unresolvedRefs(
  document: unknown,
): Array<{ ref: string; at: string }> {
  const misses: Array<{ ref: string; at: string }> = []
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      node.forEach((value, i) => walk(value, `${at}/${String(i)}`))
      return
    }
    if (!isObject(node)) return
    for (const [key, value] of Object.entries(node)) {
      const token = key.replace(/~/g, '~0').replace(/\//g, '~1')
      if (key === '$ref' && typeof value === 'string') {
        if (resolvePointer(document, value) === undefined) {
          misses.push({ ref: value, at })
        }
      } else walk(value, `${at}/${token}`)
    }
  }
  walk(document, '#')
  return misses
}

export function operationsFor(
  providerId: string,
  endpoint: LoadedEndpoint,
  connect: ProviderConnect,
  modelIds: Array<string>,
  pinnedModel: string | undefined,
): Array<{
  path: string
  method: 'post' | 'get'
  operation: Record<string, unknown>
}> {
  const operations: Array<{
    path: string
    method: 'post' | 'get'
    operation: Record<string, unknown>
  }> = [
    {
      path: endpoint.path,
      method: 'post',
      operation: buildOperation(
        providerId,
        endpoint,
        connect,
        modelIds,
        pinnedModel,
      ),
    },
  ]
  if (connect.siblingGet) {
    operations.push({
      path: siblingRequestPath(endpoint.path),
      method: 'get',
      operation: buildSiblingGet(providerId, endpoint),
    })
  }
  return operations
}

/**
 * Assemble GET /v1/openapi/{provider}. Refuses combined documents for
 * model-grained providers; a provider-grained document is never capped by
 * path count — client generation needs the whole generation surface (#560).
 * A model-grained queue provider (FAL) with no `?model=` is one queue
 * document: `endpoint_id` enumerates every model with an input schema.
 * The bare document is live models only. `?activity=` includes deprecated
 * models in that activity and inlines each model's own body schema
 * (up to {@link MAX_QUEUE_SPEC_PATHS}). AsyncAPI rows stay out.
 */
export async function assembleProviderOpenApi(
  db: Db,
  providerId: string,
  query: AssembleOpenApiQuery = {},
): Promise<AssembleOpenApiResult> {
  if (!(await providerExists(db, providerId))) {
    const valid = (await knownProviderIds(db)).join(', ')
    return {
      ok: false,
      status: 404,
      code: 'unknown_provider',
      message: `Unknown provider '${providerId}'. Valid providers: ${valid}.`,
    }
  }

  let activity: Activity | undefined
  if (query.activity !== undefined) {
    if (!(activities as ReadonlyArray<string>).includes(query.activity)) {
      return {
        ok: false,
        status: 404,
        code: 'unknown_activity',
        message: `Unknown activity '${query.activity}'. Valid activities: ${activities.join(', ')}.`,
      }
    }
    activity = query.activity as Activity
  }

  const config = getProvider(providerId)
  const grain = resolveSpecGrain(config)

  let pinnedModel: string | undefined
  if (query.model !== undefined) {
    const model = await getModelDetail(db, providerId, query.model)
    if (!model) {
      return {
        ok: false,
        status: 404,
        code: 'unknown_model',
        message: `Unknown model '${query.model}' for provider '${providerId}'. Try GET /v1/providers/${providerId}/models for valid ids.`,
      }
    }
    pinnedModel = model.rawId
    if (activity === undefined && model.activity) {
      activity = model.activity
    }
    if (hasAsyncApiFlag(model.capabilities)) {
      const schemaHint = model.activity
        ? `GET /v1/schemas/${providerId}/${model.activity}/${pinnedModel}`
        : `GET /v1/schemas/${providerId}`
      return {
        ok: false,
        status: 404,
        code: 'unknown_model',
        message: `Model '${pinnedModel}' is listed for '${providerId}' but publishes an AsyncAPI contract, not HTTP OpenAPI. Use ${schemaHint} (kind=input|output). Catalog: GET /v1/models/${providerId}/${pinnedModel}.`,
      }
    }
  }

  // A model-grained provider whose POST answers with a queue ack is one
  // queue document when no model is pinned; ?activity= narrows it.
  const queue =
    grain === 'model' &&
    pinnedModel === undefined &&
    config?.connect?.siblingGet === true
  const lean = queue && activity === undefined
  let queueRawIds: Array<string> | undefined
  if (queue) {
    const listed = await loadQueueModels(db, providerId, activity)
    const httpModels = listed.filter(
      (model) => !hasAsyncApiFlag(model.capabilities),
    )
    if (listed.length > 0 && httpModels.length === 0) {
      return {
        ok: false,
        status: 400,
        code: 'spec_requires_selector',
        message: `Activity '${activity ?? ''}' on '${providerId}' has no HTTP OpenAPI models (the listed rows publish AsyncAPI). Use GET /v1/schemas/${providerId}.`,
      }
    }
    queueRawIds = httpModels.map((model) => model.rawId)
  }

  const loaded = await loadEndpoints(db, providerId, activity, !lean)
  let selected = loaded
  if (pinnedModel !== undefined) {
    const matching = loaded.filter((e) =>
      endpointMatchesModel(e.id, e.path, pinnedModel),
    )
    if (matching.length > 0) selected = matching
    else if (grain === 'model') {
      return {
        ok: false,
        status: 404,
        code: 'unknown_model',
        message: `Model '${pinnedModel}' is listed for '${providerId}' but has no classified generation endpoint (no path matching that raw id). List endpoints: GET /v1/schemas/${providerId}. If the model is new, wait for spec sync or POST /v1/admin/sync/${providerId}. Catalog: GET /v1/providers/${providerId}/models.`,
      }
    }
  } else if (queueRawIds !== undefined) {
    selected = selectQueueEndpoints(loaded, queueRawIds)
  }

  // A model-grained provider without a queue (Reactor) keeps one path per
  // endpoint; each body becomes an `input_`/`output_` component tagged with
  // the model that owns the path.
  let owners: Map<string, string> | undefined
  if (grain === 'model' && pinnedModel === undefined && !queue) {
    owners = await endpointOwners(db, providerId, selected)
    if (!owners) return refuseModelGrained(providerId, loaded.length)
  }

  const profile = applyConnectProfile(config, selected)
  const connect = profile.connect
  selected = profile.selected

  if (selected.length === 0) {
    const filtered = activity !== undefined || pinnedModel !== undefined
    return {
      ok: false,
      status: filtered ? 400 : 404,
      code: filtered ? 'spec_requires_selector' : 'no_endpoints',
      message: filtered
        ? `No generation endpoints for provider '${providerId}'${activity ? ` activity '${activity}'` : ''}${pinnedModel ? ` model '${pinnedModel}'` : ''}. List endpoints: GET /v1/schemas/${providerId}. Valid activities: ${activities.join(', ')}.`
        : `Provider '${providerId}' has no synced generation endpoints yet. Check GET /v1/status or POST /v1/admin/sync/${providerId}. Index: GET /v1/schemas/${providerId}.`,
    }
  }

  if (queue && !lean && selected.length > MAX_QUEUE_SPEC_PATHS) {
    return {
      ok: false,
      status: 400,
      code: 'spec_requires_selector',
      message: `Activity '${activity ?? ''}' matches ${String(selected.length)} endpoints (cap ${String(MAX_QUEUE_SPEC_PATHS)}). Pin ?model={rawId}, or drop ?activity= for the whole-catalog document with untyped bodies. Counts per activity: GET /v1/providers/${providerId}.`,
    }
  }

  if (!connect || connect.servers.length === 0) {
    return {
      ok: false,
      status: 500,
      code: 'missing_connect',
      message: `Provider '${providerId}' has no declared connect profile (servers/auth). GET /v1/openapi/${providerId} is not assembled until ProviderConfig.connect is set. Use GET /v1/schemas/${providerId} and the provider's own docs.`,
    }
  }

  let queueSchemas: Record<string, unknown> | undefined
  const paths: Record<string, Record<string, unknown>> = {}
  const twinPaths: Record<string, Record<string, unknown>> = {}
  if (queue) {
    const built = buildQueueDocument(providerId, selected, connect, lean)
    if ('empty' in built) {
      return {
        ok: false,
        status: 400,
        code: 'spec_requires_selector',
        message: `No input schemas to publish for '${providerId}'${activity ? ` activity '${activity}'` : ''}. List endpoints: GET /v1/schemas/${providerId}.`,
      }
    }
    Object.assign(paths, built.paths)
    queueSchemas = built.schemas
  } else {
    const built = owners ? buildModelComponents(selected, owners) : undefined
    if (built) queueSchemas = built.schemas
    const catalog =
      owners !== undefined ||
      (pinnedModel && !connect.modelHeader) ||
      config?.openModelNames
        ? []
        : (
            await listModelsCatalog(db, {
              provider: providerId,
              activity,
            })
          ).models
    const modelIds = pinnedModel ? [pinnedModel] : catalog.map((m) => m.rawId)
    // A header-selected model (Fish Audio) differs per route: TTS and ASR
    // take different ids, so each operation lists the ids bound to it or
    // to a parent route (`v1/tts` for `v1/tts/stream/with-timestamp`). A
    // route with none (voice-model create) gets no model header; a pinned
    // model only heads the routes it binds to.
    const idsFor = (endpointId: string) =>
      connect.modelHeader
        ? catalog
            .filter(
              (m) =>
                (!pinnedModel || m.rawId === pinnedModel) &&
                m.schemaEndpointId !== null &&
                (endpointId === m.schemaEndpointId ||
                  endpointId.startsWith(`${m.schemaEndpointId}/`)),
            )
            .map((m) => m.rawId)
        : modelIds
    // An upstream `#stream` path key (Mistral) is the same URL. Twins are
    // built aside and merged into the base once their schemas are hoisted.
    for (const endpoint of built?.endpoints ?? selected) {
      const path = endpoint.path.split('#')[0] ?? endpoint.path
      const target = path === endpoint.path ? paths : twinPaths
      const owner = owners?.get(endpoint.id)
      for (const op of operationsFor(
        providerId,
        { ...endpoint, path },
        connect,
        owner !== undefined ? [owner] : idsFor(endpoint.id),
        pinnedModel,
      )) {
        const item = target[op.path] ?? {}
        item[op.method] = op.operation
        target[op.path] = item
      }
    }
  }

  const revision =
    selected.find((e) => e.specRevision)?.specRevision ?? 'current'
  const components: Record<string, unknown> = {}
  if (Object.keys(connect.securitySchemes).length > 0) {
    components.securitySchemes = connect.securitySchemes
  }
  let schemas: Record<string, unknown>
  try {
    schemas = hoistSchemaDefs(
      [...Object.values(paths), ...Object.values(twinPaths)],
      queueSchemas ?? {},
    )
    for (const [path, twinItem] of Object.entries(twinPaths)) {
      const item = paths[path] ?? {}
      for (const [method, twin] of Object.entries(twinItem)) {
        const base = item[method]
        if (!isObject(twin)) continue
        item[method] = isObject(base)
          ? mergeTwin(base, twin, `${method.toUpperCase()} ${path}`)
          : twin
      }
      paths[path] = item
    }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      code: 'schema_conflict',
      message: `Could not assemble '${providerId}': ${error instanceof Error ? error.message : String(error)}. Use GET /v1/schemas/${providerId} for each endpoint's own schema.`,
    }
  }
  if (Object.keys(schemas).length > 0) components.schemas = schemas
  const document: Record<string, unknown> = {
    openapi: '3.1.0',
    info: {
      title: `${config?.displayName ?? providerId} (modelschemas)`,
      version: revision,
      description: owners
        ? `Generation-only OpenAPI assembled by modelschemas from stored endpoint schemas. Call this provider directly with your own key — this is not a proxy. One path per endpoint; each body is a component schema (input_/output_) tagged with its model (x-modelschemas-model).`
        : queue
          ? `Generation-only OpenAPI assembled by modelschemas from stored endpoint schemas. Call this provider directly with your own key — this is not a proxy. One queue client: endpoint_id is the model raw id${lean ? "; bodies are untyped here, pass ?activity= to inline each model's own schema" : ", and each component schema is that model's own body (x-modelschemas-model)"}.`
          : `Generation-only OpenAPI assembled by modelschemas from live endpoint schemas. Call this provider directly with your own key — this is not a proxy.`,
    },
    servers: connect.servers,
    ...(Object.keys(connect.securitySchemes).length > 0
      ? { security: connect.security }
      : {}),
    ...(Object.keys(components).length > 0 ? { components } : {}),
    paths,
  }

  // A stored schema whose `$ref` points at a def it does not carry would
  // publish a document no generator can read. Name it instead.
  const dangling = unresolvedRefs(document)
  if (dangling.length > 0) {
    const sample = dangling
      .slice(0, 3)
      .map((miss) => `${miss.ref} at ${miss.at}`)
      .join('; ')
    return {
      ok: false,
      status: 500,
      code: 'unresolved_refs',
      message: `Could not assemble '${providerId}': ${String(dangling.length)} $ref(s) do not resolve in the stored schemas (${sample}). Re-sync with POST /v1/admin/sync/${providerId}; each endpoint's own schema is at GET /v1/schemas/${providerId}.`,
    }
  }

  return {
    ok: true,
    document,
    etag: await contentHash(document),
  }
}
