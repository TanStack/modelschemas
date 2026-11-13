/**
 * Reactor (reactor.inc) — real-time world/video models.
 *
 * There is no `api.reactor.inc/openapi.json`. The runtime compiles each
 * model's command surface to OpenAPI 3.1 (`POST /events/<name>`, webhooks,
 * `x-reactor.tracks`). The open-source JS SDK (`@reactor-team/js-sdk`)
 * fetches that document over the session control channel via
 * `requestSchema()` once connect() reaches `"ready"` — it is not an HTTP
 * GET, and it costs a GPU session.
 *
 * The same OpenAPI is embedded in the public model API pages
 * (`https://reactor.inc/models/{slug}/api`, Next.js RSC payload). fetchSpec
 * pulls those pages, extracts the document, and namespaces paths under the
 * connect slug so models do not collide. Catalog is public GET /pricing.
 *
 * Auth for live sessions is `Reactor-API-Key` (`rk_...`). The only HTTP
 * call is POST /tokens, which mints the session JWT. Command paths in the
 * extracted documents (`POST /events/<name>`) are `sendCommand` messages
 * on the session channel: fetchSpec still stores their schemas, and the
 * assembled document publishes them as components tagged
 * `x-modelschemas-transport: realtime`, not as paths on api.reactor.inc.
 * Sync/poll stay keyless.
 */
import type { Activity } from '#/db/schema.ts'
import { contentHash } from '#/server/kv.ts'
import { fetchText, sha256Text } from '../types.ts'
import { reactorPricingFacts } from '../reactor-pricing.ts'
import type { ReactorRate } from '../reactor-pricing.ts'
import type {
  ListModelsResult,
  ModelInfo,
  OpenApiDocument,
  OpenApiOperation,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
  SpecSource,
} from '../types.ts'

export const REACTOR_DOCS_URL = 'https://docs.reactor.inc'
export const REACTOR_SITE = 'https://reactor.inc'
export const REACTOR_API_BASE = 'https://api.reactor.inc'
export const REACTOR_PRICING_URL = `${REACTOR_API_BASE}/pricing`

type Schema = Record<string, unknown>

interface ReactorModel {
  /** Pricing catalog `name` and `/models/{slug}/api` page slug. */
  pricingName: string
  /** Connect slug (`modelName`). */
  rawId: string
  displayName: string
  /** Override when the marketing page slug differs from pricingName. */
  pageSlug?: string
}

/** Billing parent row — not a connect slug. */
const SKIP_PRICING_NAMES = new Set(['happy-oyster'])

const REACTOR_MODELS: Array<ReactorModel> = [
  {
    pricingName: 'fast-h3',
    rawId: 'reactor/fast-h3',
    displayName: 'FastH3',
  },
  {
    pricingName: 'helios',
    rawId: 'reactor/helios',
    displayName: 'Helios',
  },
  {
    pricingName: 'lingbot',
    rawId: 'reactor/lingbot',
    displayName: 'LingBot',
  },
  {
    pricingName: 'lingbot-world-2',
    rawId: 'reactor/lingbot-world-2',
    displayName: 'LingBot World 2',
  },
  {
    pricingName: 'longlive-v2',
    rawId: 'reactor/longlive-v2',
    displayName: 'LongLive-2.0',
  },
  {
    pricingName: 'ltx2',
    rawId: 'reactor/ltx2',
    displayName: 'LTX',
    pageSlug: 'ltx',
  },
  {
    pricingName: 'sana-streaming',
    rawId: 'reactor/sana-streaming',
    displayName: 'SANA-Streaming',
  },
  {
    pricingName: 'visko-orbis-stable',
    rawId: 'reactor/visko-orbis-stable',
    displayName: 'Visko Orbis Stable',
  },
  {
    pricingName: 'visko-orbis-dynamic',
    rawId: 'reactor/visko-orbis-dynamic',
    displayName: 'Visko Orbis Dynamic',
  },
  { pricingName: 'x2', rawId: 'x2', displayName: 'X2' },
  {
    pricingName: 'happy-oyster-adventure',
    rawId: 'reactor/happy-oyster-adventure',
    displayName: 'HappyOyster Adventure',
    pageSlug: 'happy-oyster',
  },
  {
    pricingName: 'happy-oyster-director',
    rawId: 'reactor/happy-oyster-director',
    displayName: 'HappyOyster Directing',
    pageSlug: 'happy-oyster',
  },
]

const MODEL_BY_PRICING = new Map(
  REACTOR_MODELS.map((model) => [model.pricingName, model]),
)
const MODEL_BY_RAW_ID = new Map(
  REACTOR_MODELS.map((model) => [model.rawId, model]),
)
const RAW_IDS_LONGEST_FIRST = [...MODEL_BY_RAW_ID.keys()].sort(
  (a, b) => b.length - a.length,
)

export function modelApiPageUrl(pageSlug: string): string {
  return `${REACTOR_SITE}/models/${pageSlug}/api`
}

function pageSlugFor(model: ReactorModel): string {
  return model.pageSlug ?? model.pricingName
}

function connectSlugFor(pricingName: string): string {
  const known = MODEL_BY_PRICING.get(pricingName)
  if (known) return known.rawId
  if (pricingName.includes('/')) return pricingName
  return `reactor/${pricingName}`
}

function modelForPricingName(pricingName: string): ReactorModel {
  return (
    MODEL_BY_PRICING.get(pricingName) ?? {
      pricingName,
      rawId: connectSlugFor(pricingName),
      displayName: pricingName,
    }
  )
}

const JS_STRING_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  '"': '"',
  '\\': '\\',
  '/': '/',
  "'": "'",
}

/**
 * Read a JS string literal starting at `start` (the first character after
 * the opening quote). Returns the unescaped value and the index after the
 * closing quote.
 */
export function readJsString(
  source: string,
  start: number,
): { value: string; end: number } | null {
  let i = start
  let value = ''
  while (i < source.length) {
    const char = source[i]
    if (char === '\\') {
      const next = source[i + 1]
      if (next === undefined) return null
      if (next === 'u' && i + 5 < source.length) {
        const hex = source.slice(i + 2, i + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null
        value += String.fromCharCode(Number.parseInt(hex, 16))
        i += 6
        continue
      }
      value += JS_STRING_ESCAPES[next] ?? next
      i += 2
      continue
    }
    if (char === '"') return { value, end: i + 1 }
    value += char
    i += 1
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isOpenApiDocument(value: unknown): value is OpenApiDocument {
  if (!isRecord(value)) return false
  if (!isRecord(value.paths)) return false
  const openapi = value.openapi
  return typeof openapi === 'string' && openapi.startsWith('3.')
}

const NEXT_F_STRING_CHUNK = 'self.__next_f.push([1,"'

/**
 * Pull the model's OpenAPI 3.1 document out of a Next.js RSC payload on
 * `https://reactor.inc/models/{slug}/api`. The runtime/SDK document is not
 * published as `openapi.json`; the marketing page embeds it as a string
 * chunk. Same shape as `Reactor.getSchema()` / `requestSchema()`.
 */
export function extractOpenApiFromHtml(html: string): OpenApiDocument | null {
  let from = 0
  while (from < html.length) {
    const start = html.indexOf(NEXT_F_STRING_CHUNK, from)
    if (start < 0) return null
    const parsed = readJsString(html, start + NEXT_F_STRING_CHUNK.length)
    if (parsed === null) return null
    from = parsed.end
    if (
      !parsed.value.includes('"paths"') ||
      !parsed.value.includes('openapi')
    ) {
      continue
    }
    try {
      const doc: unknown = JSON.parse(parsed.value)
      if (isOpenApiDocument(doc)) return doc
    } catch {
      continue
    }
  }
  return null
}

function commandNameFromPath(path: string): string {
  const events = /\/events\/([^/]+)$/.exec(path)
  if (events?.[1]) return events[1]
  return path.replace(/^\//, '').replaceAll('/', '_')
}

function requestSchemaFromPost(post: OpenApiOperation): Schema {
  const body = post.requestBody
  if (!isRecord(body)) return { type: 'object' }
  const content = body.content
  if (!isRecord(content)) return { type: 'object' }
  const json = content['application/json']
  if (!isRecord(json)) return { type: 'object' }
  const schema = json.schema
  return isRecord(schema) ? schema : { type: 'object' }
}

function canonicalEnvelope(
  spec: OpenApiDocument,
  rawId: string,
): OpenApiOperation {
  const oneOf: Array<Schema> = []
  for (const [path, operations] of Object.entries(spec.paths ?? {})) {
    const post = operations.post
    if (!post) continue
    const name = commandNameFromPath(path)
    oneOf.push({
      type: 'object',
      required: ['command', 'data'],
      additionalProperties: false,
      properties: {
        command: { type: 'string', const: name },
        data: requestSchemaFromPost(post),
      },
    })
  }
  return {
    operationId: `sendCommand_${rawId.replaceAll(/[^a-zA-Z0-9]+/g, '_')}`,
    summary: `sendCommand envelope for ${rawId}`,
    description:
      'WebRTC sendCommand `{ command, data }` after POST /sessions. Individual commands are also listed under /{slug}/events/* (or the model’s own paths). Same OpenAPI the JS SDK loads via requestSchema() on ready.',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema:
            oneOf.length > 0
              ? { oneOf }
              : { type: 'object', additionalProperties: true },
        },
      },
    },
    responses: {
      '200': {
        description: 'Command reply',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                data: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
    },
  }
}

function namespaceSpec(spec: OpenApiDocument, rawId: string): OpenApiDocument {
  const clone = structuredClone(spec)
  const namespaced: NonNullable<OpenApiDocument['paths']> = {}
  for (const [path, operations] of Object.entries(clone.paths ?? {})) {
    namespaced[`/${rawId}${path}`] = operations
  }
  namespaced[`/${rawId}`] = { post: canonicalEnvelope(spec, rawId) }
  clone.paths = namespaced
  clone.info ??= {}
  clone.info['x-reactor-model'] = rawId
  clone.servers = [
    { url: REACTOR_API_BASE, description: 'Reactor Platform API' },
  ]
  return clone
}

function classify(path: string): Activity | null {
  const bare = (path.split('?')[0] ?? path).replace(/^\//, '')
  for (const rawId of RAW_IDS_LONGEST_FIRST) {
    if (bare === rawId || bare.startsWith(`${rawId}/`)) return 'video'
  }
  if (bare.includes('/events/')) return 'video'
  return null
}

async function fetchPageSpec(
  pageSlug: string,
): Promise<
  { spec: OpenApiDocument; url: string } | { error: string; url: string }
> {
  const url = modelApiPageUrl(pageSlug)
  try {
    const html = await fetchText(url)
    const spec = extractOpenApiFromHtml(html)
    if (!spec) {
      return { error: `reactor: no OpenAPI in ${url}`, url }
    }
    return { spec, url }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { error: `reactor: fetch ${url} failed: ${message}`, url }
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const warnings: Array<string> = []
  const pageCache = new Map<
    string,
    { spec: OpenApiDocument; url: string } | { error: string }
  >()
  const specs: Array<OpenApiDocument> = []
  const sources: Array<SpecSource> = []

  for (const model of REACTOR_MODELS) {
    const slug = pageSlugFor(model)
    let page = pageCache.get(slug)
    if (!page) {
      const fetched = await fetchPageSpec(slug)
      pageCache.set(slug, fetched)
      page = fetched
    }
    if ('error' in page) {
      if (!warnings.includes(page.error)) warnings.push(page.error)
      continue
    }
    sources.push({
      url: `${page.url}#${model.rawId}`,
      hash: await contentHash(page.spec),
    })
    specs.push(namespaceSpec(page.spec, model.rawId))
  }

  if (specs.length === 0) {
    warnings.push('reactor: every model OpenAPI page failed to extract')
  }

  return {
    specs,
    sources,
    outputStrategy: 'post-200',
    warnings: warnings.length > 0 ? warnings : undefined,
  }
}

type PricingRate = ReactorRate

interface RateSource {
  url: string
  hash: string
  extractedAt: string
}

interface PricingModel {
  id?: string
  name?: string
  rate?: PricingRate
}

function parsePricing(body: unknown): Array<PricingModel> {
  if (!isRecord(body)) return []
  const models = body.models
  if (!Array.isArray(models)) return []
  return models.filter((row): row is PricingModel => isRecord(row))
}

function modelInfo(
  model: ReactorModel,
  extras?: {
    rate?: ReactorRate | null
    upstreamId?: string
    source?: RateSource
  },
): ModelInfo {
  const facts =
    extras?.source && extras.rate
      ? reactorPricingFacts(extras.rate, extras.source)
      : {}
  return {
    rawId: model.rawId,
    displayName: model.displayName,
    activity: 'video',
    ...facts,
    providerMetadata: {
      pricingName: model.pricingName,
      ...(extras?.upstreamId ? { upstreamId: extras.upstreamId } : {}),
    },
  }
}

function curatedCatalog(): Array<ModelInfo> {
  return REACTOR_MODELS.map((model) => modelInfo(model))
}

function catalogFromPricing(
  rows: Array<PricingModel>,
  source: RateSource,
): Array<ModelInfo> {
  const seen = new Set<string>()
  const models: Array<ModelInfo> = []
  for (const row of rows) {
    const name = row.name
    if (typeof name !== 'string' || name.length === 0) continue
    if (SKIP_PRICING_NAMES.has(name)) continue
    const model = modelForPricingName(name)
    if (seen.has(model.rawId)) continue
    seen.add(model.rawId)
    models.push(
      modelInfo(model, {
        rate: row.rate ?? null,
        source,
        upstreamId: typeof row.id === 'string' ? row.id : undefined,
      }),
    )
  }
  for (const model of REACTOR_MODELS) {
    if (seen.has(model.rawId)) continue
    seen.add(model.rawId)
    models.push(modelInfo(model))
  }
  return models
}

function matchItem(pinnedModel: string | undefined): Schema {
  return pinnedModel === undefined
    ? {
        type: 'string',
        description:
          'Connect slug (`reactor/helios`). No wildcard; list every model the token may start.',
      }
    : { type: 'string', enum: [pinnedModel] }
}

/** Request body for `POST /tokens`. Optional fields are the documented ones. */
export function sessionTokenRequestSchema(pinnedModel?: string): Schema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['authorization_details'],
    properties: {
      expires_after: {
        type: 'integer',
        minimum: 1,
        description:
          'Token lifetime in seconds. Session-scoped tokens default to 1 hour. Values at or above 21600 (6 hours) are clamped, and the response is still 200, so read expires_at.',
      },
      authorization_details: {
        type: 'array',
        minItems: 1,
        description:
          'Scope the token. Omitting this mints an unscoped token; the assembled operation requires it.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'resources'],
          properties: {
            type: {
              type: 'string',
              const: 'session',
              description:
                'The token can create sessions and do what those sessions need, and nothing else.',
            },
            resources: {
              type: 'object',
              additionalProperties: false,
              required: ['models'],
              properties: {
                models: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['match'],
                  properties: {
                    match: {
                      type: 'array',
                      minItems: 1,
                      items: matchItem(pinnedModel),
                      description:
                        'Models the token may start sessions for. Every id must be visible to the API key.',
                    },
                  },
                },
                sessions: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['bind'],
                  properties: {
                    bind: {
                      type: 'array',
                      minItems: 1,
                      items: { type: 'string' },
                      description:
                        'Open session ids, owned by this account, that this token did not create and may still act on.',
                    },
                  },
                },
              },
            },
            constraints: {
              type: 'object',
              additionalProperties: false,
              properties: {
                max_sessions: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 500,
                  description:
                    'Sessions this token may create in total. Defaults to 5. Closing a session does not restore capacity.',
                },
                max_session_duration_seconds: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 86400,
                  description:
                    'Cap every session this token creates, in seconds (24 hours). Omit for no token cap; an account maximum still applies.',
                },
              },
            },
          },
        },
      },
    },
  }
}

function sessionTokenResponseSchema(): Schema {
  return {
    type: 'object',
    required: ['jwt', 'expires_at'],
    properties: {
      jwt: {
        type: 'string',
        description:
          'Session JWT. Pass it to the JS SDK. Do not send the API key to the browser.',
      },
      expires_at: {
        type: 'integer',
        description:
          'Unix epoch seconds when the JWT expires. The server clamps expires_after, so read this value.',
      },
    },
  }
}

/**
 * The one HTTP operation on `api.reactor.inc` that a Reactor integration
 * calls. Command schemas stay out of `paths` (see `realtimeCommands`).
 */
export function reactorPlatformOperations(
  pinnedModel: string | undefined,
): Record<string, Record<string, OpenApiOperation>> {
  return {
    '/tokens': {
      post: {
        operationId: 'createSessionToken',
        summary: 'Mint a session-scoped JWT',
        description:
          'Exchange a Reactor-API-Key for a short-lived session JWT. Send this from the server. Model commands are not HTTP on this host: their schemas are components tagged x-modelschemas-transport: realtime, and the JS SDK sends them on the session channel after connect() is ready. A missing key returns 401.',
        parameters: [
          {
            name: 'Reactor-API-Key',
            in: 'header',
            required: true,
            description: 'API key starting with `rk_`. Server-side only.',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: sessionTokenRequestSchema(pinnedModel),
            },
          },
        },
        responses: {
          '200': {
            description: 'Session JWT.',
            content: {
              'application/json': { schema: sessionTokenResponseSchema() },
            },
          },
          '401': {
            description: 'Missing or invalid Reactor-API-Key.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['error'],
                  properties: { error: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  }
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  try {
    const text = await fetchText(REACTOR_PRICING_URL)
    const rows = parsePricing(JSON.parse(text) as unknown)
    if (rows.length === 0) return { models: curatedCatalog() }
    const source = {
      url: REACTOR_PRICING_URL,
      hash: await sha256Text(text),
      extractedAt: new Date().toISOString(),
    }
    return { models: catalogFromPricing(rows, source) }
  } catch {
    return { models: curatedCatalog() }
  }
}

export const provider: ProviderConfig = {
  id: 'reactor',
  displayName: 'Reactor',
  authEnvVar: 'REACTOR_API_KEY',
  specSourceUrl: `${REACTOR_SITE}/models`,
  modelsEndpoint: REACTOR_PRICING_URL,
  defaultDerivation: 'upstream-spec',
  specGrain: 'model',
  connect: {
    servers: [{ url: REACTOR_API_BASE, description: 'Reactor Platform API' }],
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'Reactor-API-Key',
        description:
          'API key starting with `rk_`. Browser clients exchange it for a session-scoped JWT via POST /tokens. The JS SDK then loads each model’s OpenAPI via requestSchema() after connect() reaches ready.',
      },
    },
    security: [{ apiKey: [] }],
  },
  realtimeCommands: true,
  platformOperations: reactorPlatformOperations,
  fetchSpec,
  listModels,
  classify,
}
