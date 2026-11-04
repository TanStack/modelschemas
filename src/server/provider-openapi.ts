/**
 * Assemble a generation-only OpenAPI 3.1 document for one provider from
 * stored endpoints + current schema versions + the provider's connect
 * profile. Reuses `schema_versions` rows (no second derivation); overlays
 * the live or pinned `model` enum, and moves output onto the sibling GET
 * when `connect.siblingGet` is set.
 */
import { and, eq, isNull } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { activities, endpoints, schemaVersions } from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import {
  getModelDetail,
  knownProviderIds,
  listModelsCatalog,
} from '#/server/catalog.ts'
import { contentHash } from '#/server/kv.ts'
import { getProvider } from '#/server/providers/index.ts'
import {
  MAX_SPEC_PATHS,
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
  /** Null means `application/json` (the column stays unset for that default). */
  requestContentType: string | null
  /**
   * Null means a JSON success body. A stream is `text/event-stream` with
   * no JSON sibling. Audio and octet-stream stay in the list.
   */
  responseContentTypes: Array<string> | null
  specRevision: string | null
}

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

/**
 * Success response body. File-like types are binary even when the stored
 * schema is the JSON or SSE body. A stream list has no `application/json`
 * entry: hey-api prefers JSON and then parses the SSE body as one value.
 */
export function responseMedia(
  schema: unknown,
  contentTypes: Array<string> | null | undefined,
): { content: Record<string, { schema: unknown }> } | undefined {
  const types =
    contentTypes && contentTypes.length > 0
      ? contentTypes
      : schema === undefined
        ? []
        : ['application/json']
  if (types.length === 0) return undefined
  const content: Record<string, { schema: unknown }> = {}
  for (const mediaType of types) {
    if (isFileLikeType(mediaType)) {
      content[mediaType] = { schema: BINARY_SCHEMA }
      continue
    }
    content[mediaType] = {
      schema: schema === undefined ? { type: 'string' } : schema,
    }
  }
  return { content }
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

function refuseSelector(
  providerId: string,
  grain: 'provider' | 'model',
  count: number,
  reason: string,
): AssembleOpenApiResult {
  const example = `GET /v1/openapi/${providerId}?model=`
  const schemas = `GET /v1/schemas/${providerId}`
  const models = `GET /v1/providers/${providerId}/models`
  return {
    ok: false,
    status: 400,
    code: 'spec_requires_selector',
    message:
      grain === 'model'
        ? `Provider '${providerId}' is model-grained (${String(count)} endpoints) — there is no combined OpenAPI document. Pass ?model={rawId}, e.g. ${example}<rawId>. List models: ${models}.`
        : `${reason} ?model= pins the live model enum; it does not drop endpoints on provider-grained specs. Narrow with ?activity= (${activities.join(', ')}). List endpoints: ${schemas}. List models: ${models}.`,
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

async function loadEndpoints(
  db: Db,
  providerId: string,
  activity: Activity | undefined,
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
      schema: schemaVersions.schema,
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
      })
      continue
    }
    if (row.kind === 'input') existing.input = parsed
    if (row.kind === 'output') existing.output = parsed
    if (existing.specRevision === null) existing.specRevision = row.specRevision
  }
  return [...byId.values()]
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
  ]
  const pinned = pinnedModel
    ? pinPathParams(parameters, pinnedModel)
    : parameters
  const body = requestMedia(input, endpoint.requestContentType)
  return {
    operationId: operationId(providerId, 'post', endpoint.path),
    summary: endpoint.description ?? undefined,
    'x-modelschemas-activity': endpoint.activity,
    ...(pinned.length > 0 ? { parameters: pinned } : {}),
    ...(body ? { requestBody: { required: true, ...body } } : {}),
    responses: {
      '200': {
        description: 'Success',
        ...(connect.siblingGet
          ? {}
          : (responseMedia(endpoint.output, endpoint.responseContentTypes) ??
            {})),
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
        ...responseMedia(endpoint.output, endpoint.responseContentTypes),
      },
    },
  }
}

/**
 * Assemble GET /v1/openapi/{provider}. Refuses combined documents for
 * model-grained providers and for selections over {@link MAX_SPEC_PATHS}.
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

  const loaded = await loadEndpoints(db, providerId, activity)
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
  }

  if (grain === 'model' && pinnedModel === undefined) {
    return refuseSelector(
      providerId,
      'model',
      loaded.length,
      `Provider '${providerId}' is model-grained.`,
    )
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

  if (selected.length > MAX_SPEC_PATHS) {
    return refuseSelector(
      providerId,
      grain,
      selected.length,
      `Selection matches ${String(selected.length)} endpoints (cap ${String(MAX_SPEC_PATHS)}).`,
    )
  }

  if (!connect || connect.servers.length === 0) {
    return {
      ok: false,
      status: 500,
      code: 'missing_connect',
      message: `Provider '${providerId}' has no declared connect profile (servers/auth). GET /v1/openapi/${providerId} is not assembled until ProviderConfig.connect is set. Use GET /v1/schemas/${providerId} and the provider's own docs.`,
    }
  }

  const modelIds = pinnedModel
    ? [pinnedModel]
    : (
        await listModelsCatalog(db, {
          provider: providerId,
          activity,
        })
      ).models.map((m) => m.rawId)
  const paths: Record<string, Record<string, unknown>> = {}
  for (const endpoint of selected) {
    const item = paths[endpoint.path] ?? {}
    item.post = buildOperation(
      providerId,
      endpoint,
      connect,
      modelIds,
      pinnedModel,
    )
    if (connect.siblingGet) {
      const siblingPath = siblingRequestPath(endpoint.path)
      paths[siblingPath] = { get: buildSiblingGet(providerId, endpoint) }
    }
    paths[endpoint.path] = item
  }

  const revision =
    selected.find((e) => e.specRevision)?.specRevision ?? 'current'
  const document: Record<string, unknown> = {
    openapi: '3.1.0',
    info: {
      title: `${config?.displayName ?? providerId} (modelschemas)`,
      version: revision,
      description: `Generation-only OpenAPI assembled by modelschemas from live endpoint schemas. Call this provider directly with your own key — this is not a proxy.`,
    },
    servers: connect.servers,
    ...(Object.keys(connect.securitySchemes).length > 0
      ? {
          security: connect.security,
          components: { securitySchemes: connect.securitySchemes },
        }
      : {}),
    paths,
  }

  return {
    ok: true,
    document,
    etag: await contentHash(document),
  }
}
