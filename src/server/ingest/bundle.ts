/**
 * Schema extraction + bundling (PLAN.md task 2.2) — ported from PR #622's
 * generate-endpoint-maps.ts, minus codegen: pure JSON manipulation, so it
 * runs on Workers.
 *
 * Given an OpenAPI document and an endpoint path, extract the input schema
 * (request body) and output schema, then inline the `$ref` closure under
 * `$defs` so every schema is fully self-contained.
 */
import type { OpenApiDocument } from '#/server/providers/types.ts'

/**
 * Version of the extraction pipeline (classification + bundling), recorded
 * on every schema_versions row. Bump whenever a change here or in a
 * provider's classify/fetchSpec could alter derived schemas — it tells
 * verifiers which extractor produced a stored hash.
 */
export const EXTRACTOR_VERSION = '2'

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | Array<JsonValue>

const COMPONENT_REF_PREFIX = '#/components/schemas/'
const DEFS_REF_PREFIX = '#/$defs/'

export type OutputStrategy = 'post-200' | 'sibling-get'

export interface BundleResult {
  schema: Record<string, JsonValue>
  warnings: Array<string>
}

export interface ExtractedEndpointSchemas {
  /** Bundled, self-contained input schema; absent when the endpoint has no JSON/multipart body. */
  input?: Record<string, JsonValue>
  /**
   * Media type the input schema was taken from. `multipart/form-data` when
   * the call uploads a file. Absent when there is no body.
   */
  inputContentType?: string
  /** Bundled output schema; absent for binary-media endpoints (TTS audio, …). */
  output?: Record<string, JsonValue>
  /**
   * Bundled SSE (or NDJSON) event schema, set only when the success body also has a
   * JSON schema. The JSON schema stays `output`. Absent when the only
   * stored body is already the stream schema (speech).
   */
  streamOutput?: Record<string, JsonValue>
  /**
   * Success-response media types to publish. JSON and `text/event-stream`
   * are both kept, on one operation in the generation document. Audio and
   * other non-JSON types stay.
   */
  outputContentTypes?: Array<string>
  warnings: Array<string>
}

function isObject(node: unknown): node is Record<string, JsonValue> {
  return typeof node === 'object' && node !== null && !Array.isArray(node)
}

function collectComponentRefs(node: unknown, into: Set<string>): void {
  if (typeof node !== 'object' || node === null) return
  if (Array.isArray(node)) {
    for (const value of node) collectComponentRefs(value, into)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (
      key === '$ref' &&
      typeof value === 'string' &&
      value.startsWith(COMPONENT_REF_PREFIX)
    ) {
      into.add(value.slice(COMPONENT_REF_PREFIX.length))
    } else {
      collectComponentRefs(value, into)
    }
  }
}

/**
 * Rewrite component refs to their bundled location: refs to `rootName`
 * become `#` (the schema itself — the PR let these dangle in $defs), all
 * others move under `#/$defs/`.
 */
function rewriteRefs(node: JsonValue, rootName: string | null): JsonValue {
  if (typeof node !== 'object' || node === null) return node
  if (Array.isArray(node)) return node.map((v) => rewriteRefs(v, rootName))
  const out: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(node)) {
    if (
      key === '$ref' &&
      typeof value === 'string' &&
      value.startsWith(COMPONENT_REF_PREFIX)
    ) {
      const refName = value.slice(COMPONENT_REF_PREFIX.length)
      out[key] =
        rootName !== null && refName === rootName
          ? '#'
          : DEFS_REF_PREFIX + refName
    } else {
      out[key] = rewriteRefs(value, rootName)
    }
  }
  return out
}

/**
 * Bundle a schema with its full `$ref` closure under `$defs`.
 *
 * `rootName` is the components key the root schema lives under (null for
 * inline schemas); refs back to it are rewritten to `#`.
 *
 * Dedup-rename lesson from PR #622: when colliding schemas are renamed with
 * a `-2` suffix, refs may say `Name-2` while the components key was
 * sanitised to `Name_2` — resolve through the underscore alias so those
 * defs don't dangle.
 */
export function bundleSchema(
  root: JsonValue,
  components: Record<string, JsonValue>,
  rootName: string | null,
  context: string,
): BundleResult {
  const warnings: Array<string> = []
  const resolveSchema = (refName: string): JsonValue | undefined =>
    components[refName] ?? components[refName.replace(/-/g, '_')]

  const closure = new Set<string>()
  const queue: Array<string> = []
  const seedRefs = new Set<string>()
  collectComponentRefs(root, seedRefs)
  for (const ref of seedRefs) {
    if (ref !== rootName) queue.push(ref)
  }
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || closure.has(current)) continue
    closure.add(current)
    const target = resolveSchema(current)
    if (target === undefined) {
      warnings.push(
        `${context}: ref target '${current}' not found (transitively referenced)`,
      )
      continue
    }
    const subRefs = new Set<string>()
    collectComponentRefs(target, subRefs)
    for (const ref of subRefs) {
      if (ref !== rootName && !closure.has(ref)) queue.push(ref)
    }
  }

  const rewrittenRoot = rewriteRefs(root, rootName)
  const schema = isObject(rewrittenRoot) ? rewrittenRoot : {}
  if (!isObject(rewrittenRoot)) {
    warnings.push(`${context}: root schema is not an object`)
    return { schema, warnings }
  }
  if (closure.size === 0) return { schema, warnings }

  // An inline schema can carry its own `$defs` (Mistral's speech stream):
  // keep them beside the component closure.
  const defs: Record<string, JsonValue> = isObject(schema.$defs)
    ? { ...schema.$defs }
    : {}
  for (const refName of [...closure].sort()) {
    const target = resolveSchema(refName)
    if (target === undefined) continue
    const rewritten = rewriteRefs(target, rootName)
    const local = defs[refName]
    if (
      local !== undefined &&
      JSON.stringify(local) !== JSON.stringify(rewritten)
    ) {
      warnings.push(
        `${context}: local $defs '${refName}' differs from the component of the same name; kept the local one`,
      )
      continue
    }
    defs[refName] = rewritten
  }
  return { schema: { ...schema, $defs: defs }, warnings }
}

interface MediaContent {
  schema?: JsonValue
}

interface OperationShape {
  requestBody?: { content?: Record<string, MediaContent> }
  responses?: Record<string, { content?: Record<string, MediaContent> }>
  parameters?: Array<{
    name?: string
    in?: string
    required?: boolean
    description?: string
    schema?: JsonValue
  }>
}

/** Path parameters as an object schema, for GETs that have no body. */
function pathParameterSchema(
  operation: OperationShape,
): Record<string, JsonValue> | undefined {
  const params = (operation.parameters ?? []).filter(
    (param) => param.in === 'path' && typeof param.name === 'string',
  )
  if (params.length === 0) return undefined
  const properties: Record<string, JsonValue> = {}
  const required: Array<string> = []
  for (const param of params) {
    const name = param.name
    if (typeof name !== 'string') continue
    const schema: Record<string, JsonValue> = isObject(param.schema)
      ? { ...param.schema }
      : { type: 'string' }
    if (typeof param.description === 'string') {
      schema.description = param.description
    }
    properties[name] = schema
    if (param.required === true) required.push(name)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

function schemaComponents(spec: OpenApiDocument): Record<string, JsonValue> {
  return (spec.components?.schemas ?? {}) as Record<string, JsonValue>
}

/**
 * Resolve a content node to (root schema, rootName). A `$ref` schema
 * resolves through components; an inline schema is used as-is.
 */
function resolveContentSchema(
  content: MediaContent | undefined,
  components: Record<string, JsonValue>,
  context: string,
  warnings: Array<string>,
): { root: JsonValue; rootName: string | null } | undefined {
  const schema = content?.schema
  if (schema === undefined) return undefined
  if (isObject(schema) && typeof schema.$ref === 'string') {
    if (!schema.$ref.startsWith(COMPONENT_REF_PREFIX)) {
      warnings.push(`${context}: unsupported ref '${schema.$ref}'`)
      return undefined
    }
    const rootName = schema.$ref.slice(COMPONENT_REF_PREFIX.length)
    const root = components[rootName] ?? components[rootName.replace(/-/g, '_')]
    if (root === undefined) {
      warnings.push(`${context}: root ref '${rootName}' not found`)
      return undefined
    }
    return { root, rootName }
  }
  return { root: schema, rootName: null }
}

/** Media type without parameters, lowercased. */
function mediaTypeBase(value: string): string {
  return value.split(';')[0]?.trim().toLowerCase() ?? ''
}

function isJsonType(value: string): boolean {
  const base = mediaTypeBase(value)
  return base === 'application/json' || base.endsWith('+json')
}

function isEventStream(value: string): boolean {
  const base = mediaTypeBase(value)
  return base === 'text/event-stream' || base.endsWith('/event-stream')
}

/** SSE, or Ollama's newline-delimited JSON (`application/x-ndjson`). */
function isStreamType(value: string): boolean {
  return isEventStream(value) || mediaTypeBase(value) === 'application/x-ndjson'
}

/** AWS binary event stream. Not SSE, so it is not rewritten to `text/event-stream`. */
function isAwsEventStream(value: string): boolean {
  return mediaTypeBase(value) === 'application/vnd.amazon.eventstream'
}

function isMultipart(value: string): boolean {
  return mediaTypeBase(value) === 'multipart/form-data'
}

/**
 * Type stored and published. Stream types collapse to `text/event-stream`
 * so hey-api's exact media-type check selects the SSE client.
 */
function canonicalMediaType(value: string): string {
  if (isEventStream(value)) return 'text/event-stream'
  if (isMultipart(value)) return 'multipart/form-data'
  if (isJsonType(value)) return 'application/json'
  return mediaTypeBase(value)
}

function schemaHasBinary(node: JsonValue, depth = 0): boolean {
  if (depth > 8 || typeof node !== 'object' || node === null) return false
  if (Array.isArray(node)) {
    return node.some((item) => schemaHasBinary(item, depth + 1))
  }
  if (node.format === 'binary' || typeof node.contentMediaType === 'string') {
    return true
  }
  return Object.values(node).some((value) => schemaHasBinary(value, depth + 1))
}

/**
 * Content types to put on the generation document's success response.
 * See `ExtractedEndpointSchemas.outputContentTypes`. A boolean `stream`
 * field is not a media type: SSE is published only when the success
 * body lists an event-stream type.
 */
export function responseContentTypesFor(
  content: Record<string, MediaContent> | undefined,
): Array<string> | undefined {
  if (!content) return undefined
  const types: Array<string> = []
  for (const raw of Object.keys(content)) {
    const type = canonicalMediaType(raw)
    if (type !== '' && !types.includes(type)) types.push(type)
  }
  return types.length > 0 ? types : undefined
}

/**
 * Extract + bundle the input/output schemas for one endpoint.
 *
 * Input: request body. A file upload (`multipart/form-data`, or a multipart
 * schema that contains a binary field) wins over `application/json` —
 * declaring both makes `@hey-api/openapi-ts` send the file as JSON.
 *
 * Output schema stays the JSON success body when one exists (200/201/202,
 * or the sibling GET for FAL). When that body also lists an event-stream
 * schema, `streamOutput` is that schema. A boolean `stream` property does
 * not invent a stream response.
 */
export function extractEndpointSchemas(
  spec: OpenApiDocument,
  pathKey: string,
  strategy: OutputStrategy = 'post-200',
  method: 'post' | 'get' = 'post',
): ExtractedEndpointSchemas {
  const warnings: Array<string> = []
  const components = schemaComponents(spec)
  const operation = spec.paths?.[pathKey]?.[method] as
    | OperationShape
    | undefined
  if (!operation) return { warnings }
  const post = operation

  let input: Record<string, JsonValue> | undefined
  let inputContentType: string | undefined
  const chosenRequest = chooseRequestContent(post.requestBody?.content)
  if (chosenRequest) {
    const probe: Array<string> = []
    const probed = resolveContentSchema(
      chosenRequest.media,
      components,
      `${pathKey} input`,
      probe,
    )
    const multipartLosesToJson =
      chosenRequest.contentType === 'multipart/form-data' &&
      probed !== undefined &&
      !schemaHasBinary(probed.root) &&
      hasJsonBody(post.requestBody?.content)
    const requestMedia = multipartLosesToJson
      ? jsonBody(post.requestBody?.content)
      : chosenRequest
    if (requestMedia) {
      inputContentType = requestMedia.contentType
      const resolved =
        requestMedia === chosenRequest
          ? probed
          : resolveContentSchema(
              requestMedia.media,
              components,
              `${pathKey} input`,
              warnings,
            )
      if (requestMedia === chosenRequest) warnings.push(...probe)
      if (resolved) {
        const bundled = bundleSchema(
          resolved.root,
          components,
          resolved.rootName,
          `${pathKey} input`,
        )
        input = bundled.schema
        warnings.push(...bundled.warnings)
      }
    }
  } else if (method === 'get') {
    input = pathParameterSchema(operation)
  }

  const responses =
    strategy === 'sibling-get'
      ? (
          spec.paths?.[`${pathKey}/requests/{request_id}`]?.get as
            | OperationShape
            | undefined
        )?.responses
      : post.responses
  const bound = bindSuccessContent(responses)
  const outputMedia =
    bound?.json ??
    (bound?.stream?.schema !== undefined ? bound.stream : undefined)

  let output: Record<string, JsonValue> | undefined
  const outputResolved = resolveContentSchema(
    outputMedia,
    components,
    `${pathKey} output`,
    warnings,
  )
  if (outputResolved) {
    const bundled = bundleSchema(
      outputResolved.root,
      components,
      outputResolved.rootName,
      `${pathKey} output`,
    )
    output = bundled.schema
    warnings.push(...bundled.warnings)
  }

  let streamOutput: Record<string, JsonValue> | undefined
  if (bound?.json && bound.stream?.schema !== undefined) {
    const streamResolved = resolveContentSchema(
      bound.stream,
      components,
      `${pathKey} stream`,
      warnings,
    )
    if (streamResolved) {
      const bundled = bundleSchema(
        streamResolved.root,
        components,
        streamResolved.rootName,
        `${pathKey} stream`,
      )
      streamOutput = bundled.schema
      warnings.push(...bundled.warnings)
    }
  }

  const outputContentTypes = responseContentTypesFor(bound?.content)

  return {
    ...(input ? { input } : {}),
    ...(inputContentType ? { inputContentType } : {}),
    ...(output ? { output } : {}),
    ...(streamOutput ? { streamOutput } : {}),
    ...(outputContentTypes ? { outputContentTypes } : {}),
    warnings,
  }
}

interface ChosenContent {
  media: MediaContent
  contentType: string
}

function chooseRequestContent(
  content: Record<string, MediaContent> | undefined,
): ChosenContent | undefined {
  if (!content) return undefined
  const entries = Object.entries(content).filter(
    (entry): entry is [string, MediaContent] => entry[1].schema !== undefined,
  )
  const multipart = entries.find(([type]) => isMultipart(type))
  if (multipart) {
    return {
      media: multipart[1],
      contentType: canonicalMediaType(multipart[0]),
    }
  }
  const json = entries.find(([type]) => isJsonType(type))
  const chosen = json ?? entries[0]
  if (!chosen) return undefined
  return { media: chosen[1], contentType: canonicalMediaType(chosen[0]) }
}

function hasJsonBody(
  content: Record<string, MediaContent> | undefined,
): boolean {
  return jsonBody(content) !== undefined
}

function jsonBody(
  content: Record<string, MediaContent> | undefined,
): ChosenContent | undefined {
  if (!content) return undefined
  const json = Object.entries(content).find(
    ([type, media]) => isJsonType(type) && media.schema !== undefined,
  )
  if (!json) return undefined
  return { media: json[1], contentType: 'application/json' }
}

interface BoundSuccess {
  content: Record<string, MediaContent>
  json?: MediaContent
  stream?: MediaContent
}

/**
 * First success status that carries a JSON schema, otherwise the first
 * success status that carries any content. The JSON schema is what we
 * store; `content` is the map whose media types are published.
 */
function bindSuccessContent(
  responses: OperationShape['responses'],
): BoundSuccess | undefined {
  if (!responses) return undefined
  let first: Record<string, MediaContent> | undefined
  for (const status of ['200', '201', '202']) {
    const content = responses[status]?.content
    if (!content || Object.keys(content).length === 0) continue
    if (!first) first = content
    const json = Object.entries(content).find(
      ([type, media]) => isJsonType(type) && media.schema !== undefined,
    )
    if (json) {
      const stream = Object.entries(content).find(([type]) =>
        isStreamType(type),
      )
      return {
        content,
        json: json[1],
        ...(stream ? { stream: stream[1] } : {}),
      }
    }
  }
  if (!first) return undefined
  const stream = Object.entries(first).find(
    ([type, media]) =>
      (isStreamType(type) || isAwsEventStream(type)) &&
      media.schema !== undefined,
  )
  return { content: first, ...(stream ? { stream: stream[1] } : {}) }
}

/** Endpoint id convention from the PR: the path minus its leading slash. */
export function endpointIdFromPath(pathKey: string): string {
  return pathKey.replace(/^\//, '')
}

/**
 * Verify a bundled schema is self-contained: every `$ref` is either `#` or
 * `#/$defs/<name>` with `<name>` present in the top-level `$defs`. Returns
 * the list of violations (empty = self-contained). Exported for tests and
 * sync-time sanity checks.
 */
export function findDanglingRefs(
  schema: Record<string, JsonValue>,
): Array<string> {
  const defs = isObject(schema.$defs) ? schema.$defs : {}
  const violations: Array<string> = []
  const walk = (node: JsonValue): void => {
    if (typeof node !== 'object' || node === null) return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        if (value === '#') continue
        if (value.startsWith(DEFS_REF_PREFIX)) {
          const name = value.slice(DEFS_REF_PREFIX.length)
          if (!(name in defs)) violations.push(value)
          continue
        }
        violations.push(value)
      } else {
        walk(value)
      }
    }
  }
  walk(schema)
  return violations
}
