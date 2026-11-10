/**
 * Bedrock Runtime as OpenAPI (issues #153, #619). AWS publishes no OpenAPI
 * document, so the spec is generated at sync time from the service model the
 * AWS SDK for Python ships (botocore `service-2.json`): every shape becomes a
 * component schema. The generation paths are Converse, ConverseStream,
 * InvokeModel, and InvokeModelWithResponseStream.
 *
 * An event stream (`eventstream`) is one event per message: the response
 * media type is `application/vnd.amazon.eventstream` and the schema allows
 * exactly one member. InvokeModel's HTTP payload is a blob, which on the
 * wire is the model's own JSON document, not a base64 structure member.
 */
import { BEDROCK_CONVERSE_PATH } from './bedrock-cards.ts'
import { PROVENANCE_MARKER } from './types.ts'
import type { OpenApiDocument } from './types.ts'

/** Paths `GET /v1/openapi/amazon-bedrock` must publish. */
export const BEDROCK_RUNTIME_PATHS = [
  BEDROCK_CONVERSE_PATH,
  '/model/{modelId}/converse-stream',
  '/model/{modelId}/invoke',
  '/model/{modelId}/invoke-with-response-stream',
] as const

const EVENT_STREAM = 'application/vnd.amazon.eventstream'

export const BEDROCK_SDK_MODEL_URL =
  'https://raw.githubusercontent.com/boto/botocore/develop/botocore/data/bedrock-runtime/2023-09-30/service-2.json'

const REF = '#/components/schemas/'

interface Member {
  shape: string
  documentation?: string
  /** `uri` / `header` / `querystring`: not part of the JSON body. */
  location?: string
  /** Wire name when it differs from the member name. */
  locationName?: string
}

interface Shape {
  type: string
  members?: Record<string, Member>
  required?: Array<string>
  member?: Member
  value?: Member
  enum?: Array<string>
  min?: number
  max?: number
  documentation?: string
  /** Tagged union: exactly one member is set. */
  union?: boolean
  /** Event stream: each message sets exactly one member. */
  eventstream?: boolean
  /** HTTP body is this member, not the structure. */
  payload?: string
  /** Free-form JSON value. */
  document?: boolean
  exception?: boolean
}

export interface BedrockServiceModel {
  operations: Record<
    string,
    {
      http: { method: string; requestUri: string }
      input?: { shape: string }
      output?: { shape: string }
      documentation?: string
    }
  >
  shapes: Record<string, Shape>
}

type Schema = Record<string, unknown>

function prose(html: string | undefined): string | undefined {
  const text = html
    ?.replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text === '' ? undefined : text
}

function described(schema: Schema, html: string | undefined): Schema {
  const description = prose(html)
  return description ? { ...schema, description } : schema
}

const ref = (member: Member): Schema =>
  described({ $ref: REF + member.shape }, member.documentation)

function range(shape: Shape, min: string, max: string): Schema {
  return {
    ...(shape.min !== undefined ? { [min]: shape.min } : {}),
    ...(shape.max !== undefined ? { [max]: shape.max } : {}),
  }
}

function shapeSchema(shape: Shape): Schema {
  switch (shape.type) {
    case 'structure': {
      if (shape.document) return {}
      const body = Object.entries(shape.members ?? {}).filter(
        ([, member]) => member.location === undefined,
      )
      const required = (shape.required ?? []).filter((name) =>
        body.some(([key]) => key === name),
      )
      return {
        type: 'object',
        properties: Object.fromEntries(
          body.map(([name, member]) => [name, ref(member)]),
        ),
        ...(required.length > 0 ? { required } : {}),
        ...(shape.union || shape.eventstream
          ? { minProperties: 1, maxProperties: 1 }
          : {}),
      }
    }
    case 'list':
      return {
        type: 'array',
        ...(shape.member ? { items: ref(shape.member) } : {}),
        ...range(shape, 'minItems', 'maxItems'),
      }
    case 'map':
      return {
        type: 'object',
        ...(shape.value ? { additionalProperties: ref(shape.value) } : {}),
      }
    case 'string':
      // `pattern` is dropped: the SDK's regexes are not all ECMAScript.
      return {
        type: 'string',
        ...(shape.enum ? { enum: shape.enum } : {}),
        ...range(shape, 'minLength', 'maxLength'),
      }
    case 'blob':
      return { type: 'string', contentEncoding: 'base64' }
    case 'integer':
    case 'long':
      return { type: 'integer', ...range(shape, 'minimum', 'maximum') }
    case 'float':
    case 'double':
      return { type: 'number', ...range(shape, 'minimum', 'maximum') }
    case 'boolean':
      return { type: 'boolean' }
    case 'timestamp':
      return { type: 'string', format: 'date-time' }
    default:
      throw new Error(`amazon-bedrock SDK model: shape type "${shape.type}"`)
  }
}

interface HttpBody {
  schema: Schema
  mediaType: string
  required: boolean
}

function mustShape(model: BedrockServiceModel, name: string): Shape {
  const shape = model.shapes[name]
  if (!shape)
    throw new Error(`amazon-bedrock SDK model: missing shape "${name}"`)
  return shape
}

/**
 * Shapes to publish. Exception shapes stay out unless an emitted shape
 * points at them (event-stream errors). A missing target throws.
 */
function publishedShapes(model: BedrockServiceModel): Set<string> {
  const seen = new Set<string>()
  const visit = (name: string) => {
    if (seen.has(name)) return
    const shape = mustShape(model, name)
    seen.add(name)
    for (const member of Object.values(shape.members ?? {})) visit(member.shape)
    if (shape.member) visit(shape.member.shape)
    if (shape.value) visit(shape.value.shape)
  }
  for (const [name, shape] of Object.entries(model.shapes)) {
    if (!shape.exception) visit(name)
  }
  return seen
}

/** Path and header members. The JSON body schema already omits them. */
function parameters(shape: Shape): Array<Schema> {
  const params: Array<Schema> = []
  for (const [name, member] of Object.entries(shape.members ?? {})) {
    if (member.location !== 'uri' && member.location !== 'header') continue
    params.push(
      described(
        {
          name: member.locationName ?? name,
          in: member.location === 'uri' ? 'path' : 'header',
          required:
            member.location === 'uri' || (shape.required ?? []).includes(name),
          schema:
            member.location === 'uri'
              ? { type: 'string' }
              : { $ref: REF + member.shape },
        },
        member.location === 'header' ? member.documentation : undefined,
      ),
    )
  }
  return params
}

/**
 * HTTP body for one input or output structure. `@httpPayload` replaces the
 * structure. A payload blob is the raw JSON document; a payload event
 * stream is the event union, not `{ stream: ... }`.
 */
function httpBody(model: BedrockServiceModel, shapeName: string): HttpBody {
  const shape = mustShape(model, shapeName)
  if (shape.type !== 'structure') {
    throw new Error(
      `amazon-bedrock SDK model: "${shapeName}" is not a structure`,
    )
  }
  const payloadName = shape.payload
  if (!payloadName) {
    const required = (shape.required ?? []).some(
      (name) => shape.members?.[name]?.location === undefined,
    )
    return {
      schema: { $ref: REF + shapeName },
      mediaType: 'application/json',
      required,
    }
  }
  const member = shape.members?.[payloadName]
  if (!member) {
    throw new Error(
      `amazon-bedrock SDK model: "${shapeName}" payload "${payloadName}" is missing`,
    )
  }
  const target = mustShape(model, member.shape)
  const required = (shape.required ?? []).includes(payloadName)
  if (target.eventstream) {
    return {
      schema: { $ref: REF + member.shape },
      mediaType: EVENT_STREAM,
      required,
    }
  }
  if (target.type === 'blob') {
    return {
      schema: described({}, member.documentation),
      mediaType: 'application/json',
      required,
    }
  }
  return { schema: ref(member), mediaType: 'application/json', required }
}

/** The SDK service model → an OpenAPI document for the runtime paths. */
export function bedrockConverseSpec(
  model: BedrockServiceModel,
): OpenApiDocument {
  const published = publishedShapes(model)
  const paths: NonNullable<OpenApiDocument['paths']> = {}
  for (const uri of BEDROCK_RUNTIME_PATHS) {
    const found = Object.entries(model.operations).filter(
      ([, op]) => op.http.requestUri === uri,
    )
    const entry = found[0]
    if (found.length !== 1 || !entry) {
      throw new Error(`amazon-bedrock SDK model: no ${uri} operation`)
    }
    const [operationId, operation] = entry
    if (
      operation.http.method !== 'POST' ||
      !operation.input ||
      !operation.output
    ) {
      throw new Error(
        `amazon-bedrock SDK model: ${uri} is not a POST with a body`,
      )
    }
    const inputShape = mustShape(model, operation.input.shape)
    const input = httpBody(model, operation.input.shape)
    const output = httpBody(model, operation.output.shape)
    paths[uri] = {
      post: {
        operationId,
        ...described({}, operation.documentation),
        [PROVENANCE_MARKER]: { derivation: 'generated' },
        parameters: parameters(inputShape),
        requestBody: {
          required: input.required,
          content: { [input.mediaType]: { schema: input.schema } },
        },
        responses: {
          '200': {
            description: 'OK',
            content: { [output.mediaType]: { schema: output.schema } },
          },
        },
      },
    }
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Amazon Bedrock Runtime', version: '2023-09-30' },
    paths,
    components: {
      schemas: Object.fromEntries(
        Object.entries(model.shapes)
          .filter(([name]) => published.has(name))
          .map(([name, shape]) => [
            name,
            described(shapeSchema(shape), shape.documentation),
          ]),
      ),
    },
  }
}
