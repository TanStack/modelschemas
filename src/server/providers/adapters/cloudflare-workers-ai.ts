/**
 * Cloudflare Workers AI — model cards from the public models page.
 * `data-model-id` is the caller id. A per-1M-token price is stored only
 * when that card names both input and output. Other units stay null.
 *
 * Each text-generation page is built from one catalog file in Cloudflare's
 * docs repository. That file states the model's properties (function
 * calling, vision, reasoning efforts) and its own request and response
 * schema; both are read from it. The schemas share a template, so a field
 * in one is not proof the model honours it: capability flags come from the
 * properties only, never from the schema walk. `enable_thinking` is not
 * template: only reasoning models' schemas carry it, each with its own
 * enum, so with no effort list it is read as the model's on/off switch.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'

import {
  docsReport,
  docsRun,
  mapConcurrent,
  tryDocs,
  unavailable,
} from '../model-facts.ts'
import { REASONING_SOURCE_SILENT } from '../reasoning-config.ts'
import { SHARED_EFFORT_LEVELS } from '../request-map.ts'
import type {
  ChatRequestMap,
  EffortLevelMap,
  ThinkingRequest,
} from '../request-map.ts'
import { fetchText, sha256Text } from '../types.ts'
import { bearerConnect } from '../connect.ts'
import type {
  FactSource,
  ListModelsResult,
  ModelFact,
  ModelInfo,
  ModelReasoning,
  OpenApiDocument,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
  SpecSource,
} from '../types.ts'

export const WORKERS_AI_MODELS_URL =
  'https://developers.cloudflare.com/workers-ai/models/'

/** One `<page slug>.json` per model: the source of its docs page. */
export const WORKERS_AI_CATALOG_URL =
  'https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/workers-ai-models/'

const FETCH_TIMEOUT_MS = 20_000
const CATALOG_CONCURRENCY = 8

const TASK_ACTIVITY: Record<string, Activity> = {
  'Text Generation': 'chat',
  'Text-to-Image': 'image',
  'Text Embeddings': 'embeddings',
  'Text-to-Speech': 'audio',
  'Automatic Speech Recognition': 'audio',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fetchPage(url: string): Promise<string> {
  return fetchText(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
}

function attr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`))
  return match?.[1] ? match[1] : null
}

function dollarsPerMillion(text: string, label: string): number | null {
  const match = text.match(
    new RegExp(`${label} \\(per 1M tokens\\): \\$([0-9]+(?:\\.[0-9]+)?)`),
  )
  if (!match?.[1]) return null
  const dollars = Number(match[1])
  return Number.isFinite(dollars) && dollars > 0 ? dollars / 1_000_000 : null
}

/** The catalog file behind a card's `/workers-ai/models/<slug>/` page. */
function catalogUrl(tag: string): string | null {
  const slug = attr(tag, 'data-model-href')?.match(
    /^\/workers-ai\/models\/([A-Za-z0-9][A-Za-z0-9._-]*)\/$/,
  )?.[1]
  return slug ? `${WORKERS_AI_CATALOG_URL}${slug}.json` : null
}

interface ListedModel {
  model: ModelInfo
  catalogUrl: string | null
}

export function parseWorkersAiModels(
  html: string,
  source: RateCard['source'],
): Array<ListedModel> {
  const models: Array<ListedModel> = []
  const seen = new Set<string>()
  for (const match of html.matchAll(
    /<[^>]*?\bdata-model-id="([^"]+)"([\s\S]*?)>/g,
  )) {
    const rawId = match[1] ?? ''
    const tag = match[0]
    if (rawId.length === 0 || seen.has(rawId)) continue
    seen.add(rawId)
    const task = attr(tag, 'data-model-task')
    const context = attr(tag, 'data-model-context')
    const pricingText = attr(tag, 'data-model-pricing') ?? ''
    const input = dollarsPerMillion(pricingText, 'Input')
    const output = dollarsPerMillion(pricingText, 'Output')
    const cache = dollarsPerMillion(pricingText, 'Cached input')
    const rates =
      input !== null && output !== null
        ? {
            input_tokens: input,
            output_tokens: output,
            ...(cache !== null ? { cache_read_tokens: cache } : {}),
          }
        : null
    const contextWindow =
      context !== null && /^[0-9]+$/.test(context) ? Number(context) : null
    models.push({
      model: {
        rawId,
        displayName: attr(tag, 'data-model-label'),
        activity: task ? (TASK_ACTIVITY[task] ?? null) : null,
        contextWindow,
        pricing: rates ? compileTokenCard(rates, [], source) : null,
      },
      catalogUrl: catalogUrl(tag),
    })
  }
  if (models.length === 0) {
    throw new Error('cloudflare-workers-ai: models page listed no ids')
  }
  return models
}

async function fetchListing(): Promise<Array<ListedModel>> {
  const html = await fetchPage(WORKERS_AI_MODELS_URL)
  return parseWorkersAiModels(html, {
    url: WORKERS_AI_MODELS_URL,
    hash: await sha256Text(html),
    extractedAt: new Date().toISOString(),
  })
}

export interface CatalogModel {
  /** `property_id` → value, as published. */
  properties: Record<string, unknown>
  input: Record<string, unknown> | null
  output: Record<string, unknown> | null
}

/**
 * One catalog file. Throws unless it is JSON for exactly `rawId` — an HTML
 * error page or another model's file is never read as this model's facts.
 */
export function parseCatalogModel(
  text: string,
  rawId: string,
  url: string,
): CatalogModel {
  const fail = (why: string) =>
    new Error(`cloudflare-workers-ai: ${url} ${why}`)
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw fail('is not JSON')
  }
  if (!isRecord(doc) || doc.name !== rawId) {
    throw fail(`is not the catalog file for ${rawId}`)
  }
  if (!Array.isArray(doc.properties)) throw fail('has no properties list')
  const properties: Record<string, unknown> = {}
  for (const entry of doc.properties as Array<unknown>) {
    if (
      !isRecord(entry) ||
      typeof entry.property_id !== 'string' ||
      !('value' in entry)
    ) {
      throw fail('has a malformed property')
    }
    properties[entry.property_id] = entry.value
  }
  const schema = isRecord(doc.schema) ? doc.schema : {}
  return {
    properties,
    input: isRecord(schema.input) ? schema.input : null,
    output: isRecord(schema.output) ? schema.output : null,
  }
}

/**
 * Field names of the request bodies that take `messages`. The same file
 * also describes prompt, batch, and Responses bodies; their fields are not
 * chat fields.
 */
export function chatBodyFields(schema: unknown): Array<string> {
  const fields = new Set<string>()
  const visit = (node: unknown) => {
    if (!isRecord(node)) return
    if (isRecord(node.properties) && 'messages' in node.properties) {
      for (const name of Object.keys(node.properties)) fields.add(name)
    }
    for (const variants of [node.oneOf, node.anyOf]) {
      if (Array.isArray(variants)) variants.forEach(visit)
    }
  }
  visit(schema)
  return [...fields]
}

export type ThinkingSwitch = 'on-off' | 'on-only'

/**
 * `chat_template_kwargs.enable_thinking` of the request bodies that take
 * `messages`: `on-off` for a plain boolean, `on-only` when its enum is
 * `[true]`. Null when no body has it, when the bodies disagree, or when it
 * has another shape.
 */
export function thinkingSwitch(schema: unknown): ThinkingSwitch | null {
  const found = new Set<ThinkingSwitch | null>()
  const visit = (node: unknown) => {
    if (!isRecord(node)) return
    const kwargs =
      isRecord(node.properties) && 'messages' in node.properties
        ? node.properties.chat_template_kwargs
        : undefined
    const field =
      isRecord(kwargs) && isRecord(kwargs.properties)
        ? kwargs.properties.enable_thinking
        : undefined
    if (field !== undefined) {
      const boolean = isRecord(field) && field.type === 'boolean'
      found.add(
        !boolean
          ? null
          : field.enum === undefined
            ? 'on-off'
            : JSON.stringify(field.enum) === '[true]'
              ? 'on-only'
              : null,
      )
    }
    for (const variants of [node.oneOf, node.anyOf]) {
      if (Array.isArray(variants)) variants.forEach(visit)
    }
  }
  visit(schema)
  const [only = null] = [...found]
  return found.size === 1 ? only : null
}

/** What `listModels` keeps of a catalog file (six hours in KV). */
export interface CatalogDoc {
  properties: Record<string, unknown>
  chatFields: Array<string>
  /** Absent on an entry cached before this was read: no switch is claimed. */
  thinkingSwitch?: ThinkingSwitch | null
  hasRequestSchema: boolean
  hash: string
}

function runPath(rawId: string): string {
  return `/accounts/{account_id}/ai/run/${rawId}`
}

function thinkingRequest(efforts: Array<string>): ThinkingRequest | null {
  // `on` means "effort high"; a model without that level has no such body.
  if (!efforts.includes('high')) return null
  const off = efforts.includes('none') ? 'none' : null
  const levels = Object.fromEntries(
    SHARED_EFFORT_LEVELS.map((level) => [
      level,
      level === 'off' ? off : efforts.includes(level) ? level : null,
    ]),
  ) as EffortLevelMap
  return {
    on: { reasoning_effort: 'high' },
    off: off ? { reasoning_effort: off } : null,
    levels,
  }
}

function requestMap(
  fields: Array<string>,
  efforts: Array<string> | null,
): ChatRequestMap | null {
  const maxTokensField = fields.includes('max_completion_tokens')
    ? 'max_completion_tokens'
    : fields.includes('max_tokens')
      ? 'max_tokens'
      : null
  const takesEffort = fields.includes('reasoning_effort')
  if (maxTokensField === null && !takesEffort) return null
  return {
    thinking: takesEffort && efforts ? thinkingRequest(efforts) : null,
    maxTokensField,
    developerRole: null,
    replayReasoningContent: null,
    store: null,
    strictTools: null,
    sessionAffinity: null,
    cacheControl: null,
    toolStream: null,
    reasoningEffort: takesEffort ? true : null,
  }
}

/**
 * Chat facts from one catalog file. A property whose shape changed throws:
 * nothing is stored from a file this cannot read.
 */
export function catalogFacts(
  doc: CatalogDoc,
  rawId: string,
  url: string,
): Partial<ModelInfo> {
  const fail = (id: string) =>
    new Error(`cloudflare-workers-ai: ${url} property ${id} changed shape`)
  const flag = (id: string): boolean => {
    const value = doc.properties[id]
    if (value === undefined || value === 'false') return false
    if (value === 'true') return true
    throw fail(id)
  }
  const source = (path: string): FactSource => ({
    derivation: 'listing',
    sourceUrl: url,
    sourceHash: doc.hash,
    path,
  })

  const tools = flag('function_calling')
  const reasons = flag('reasoning')
  const vision = flag('vision')

  // `supported_efforts` is an effort mode. Without it the property only
  // says whether reasoning can be turned off (`mandatory`).
  let efforts: Array<string> | null = null
  let mandatory = false
  const effort = doc.properties.reasoning_effort
  if (effort !== undefined) {
    if (!isRecord(effort)) throw fail('reasoning_effort')
    const listed = effort.supported_efforts
    if (listed != null) {
      if (
        !Array.isArray(listed) ||
        listed.length === 0 ||
        !listed.every((item) => typeof item === 'string') ||
        typeof effort.mandatory !== 'boolean'
      ) {
        throw fail('reasoning_effort')
      }
      efforts = listed
      mandatory = effort.mandatory
    }
  }

  // No effort list: `enable_thinking` in the model's own request schema is
  // the whole control. The catalog's `mandatory` is the statement, and wins
  // over the schema. With none, a plain boolean field offers "off"; a field
  // that only takes `true` states nothing by itself. A `reasoning` flag
  // with no request field stores no object.
  let toggle: ModelReasoning | null = null
  if (efforts === null && reasons && doc.thinkingSwitch) {
    const stated = isRecord(effort) ? effort.mandatory : undefined
    if (stated !== undefined && typeof stated !== 'boolean') {
      throw fail('reasoning_effort')
    }
    if (stated === true) toggle = { mode: 'toggle', mandatory: true }
    else if (doc.thinkingSwitch === 'on-off') {
      toggle = { mode: 'toggle', mandatory: false }
    }
  }

  const map = requestMap(doc.chatFields, efforts)
  return {
    modalities: {
      input: vision ? ['text', 'image'] : ['text'],
      output: ['text'],
    },
    capabilities: [
      ...(tools ? ['tools'] : []),
      ...(reasons ? ['reasoning'] : []),
    ],
    exactCapabilities: true,
    ...(efforts
      ? { reasoning: { mode: 'effort', mandatory, efforts } }
      : toggle
        ? { reasoning: toggle }
        : {}),
    ...(map ? { requestMap: map } : {}),
    ...(doc.hasRequestSchema
      ? { schemaEndpointId: runPath(rawId).slice(1) }
      : {}),
    factSources: {
      modalities: source('properties.vision'),
      capabilities: {
        ...(tools ? { tools: source('properties.function_calling') } : {}),
        ...(reasons ? { reasoning: source('properties.reasoning') } : {}),
      },
      ...(efforts
        ? { reasoning: source('properties.reasoning_effort') }
        : toggle
          ? { reasoning: source('chat_template_kwargs.enable_thinking') }
          : reasons
            ? { reasoning: source(REASONING_SOURCE_SILENT) }
            : {}),
    },
  }
}

/** Every stored fact `catalogFacts` supplies. */
const CATALOG_FACTS: Array<ModelFact> = [
  'modalities',
  'capabilities',
  'reasoning',
  'requestMap',
  'schemaEndpointId',
]

/** A chat card must link its page: the catalog file is named after it. */
function requireCatalogUrl(listed: ListedModel): string {
  if (listed.catalogUrl) return listed.catalogUrl
  throw new Error(
    `cloudflare-workers-ai: ${listed.model.rawId} links no model page`,
  )
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const listed = await fetchListing()
  // One unreadable file is that model's alone: its row keeps the stored
  // catalog facts and the next poll retries. The page's prices still land.
  const docs = docsRun()
  const models = await mapConcurrent(
    listed,
    CATALOG_CONCURRENCY,
    async (card): Promise<ModelInfo> => {
      const { model } = card
      if (model.activity !== 'chat') return model
      const url = requireCatalogUrl(card)
      const facts = await tryDocs(docs, url, async (cached) => {
        const doc = await cached(kv, url, async (): Promise<CatalogDoc> => {
          const text = await fetchPage(url)
          const parsed = parseCatalogModel(text, model.rawId, url)
          return {
            properties: parsed.properties,
            chatFields: chatBodyFields(parsed.input),
            thinkingSwitch: thinkingSwitch(parsed.input),
            hasRequestSchema: parsed.input !== null,
            hash: await sha256Text(text),
          }
        })
        return catalogFacts(doc, model.rawId, url)
      })
      return { ...model, ...(facts ?? unavailable(...CATALOG_FACTS)) }
    },
  )
  return { models, docsFailures: docsReport(docs) }
}

/** One document per text-generation model that publishes a request schema. */
async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const chat = (await fetchListing()).filter(
    (card) => card.model.activity === 'chat',
  )
  const specs: Array<OpenApiDocument> = []
  const sources: Array<SpecSource> = []
  const fetched = await mapConcurrent(
    chat,
    CATALOG_CONCURRENCY,
    async (card) => {
      const { model } = card
      const url = requireCatalogUrl(card)
      const text = await fetchPage(url)
      return {
        model,
        url,
        hash: await sha256Text(text),
        ...parseCatalogModel(text, model.rawId, url),
      }
    },
  )
  for (const { model, url, hash, input, output } of fetched) {
    if (input === null) continue
    specs.push({
      openapi: '3.1.0',
      info: { title: model.rawId, version: hash },
      paths: {
        [runPath(model.rawId)]: {
          post: {
            summary: `Run ${model.rawId}`,
            requestBody: { content: { 'application/json': { schema: input } } },
            responses: output
              ? {
                  '200': {
                    content: { 'application/json': { schema: output } },
                  },
                }
              : {},
          },
        },
      },
    })
    sources.push({ url, hash })
  }
  if (specs.length === 0) {
    throw new Error(
      'cloudflare-workers-ai: no text-generation model published a request schema',
    )
  }
  return { specs, sources, outputStrategy: 'post-200' }
}

export const provider: ProviderConfig = {
  id: 'cloudflare-workers-ai',
  modelNamespaces: ['workers-ai'],
  displayName: 'Cloudflare Workers AI',
  specSourceUrl: WORKERS_AI_MODELS_URL,
  modelsEndpoint: WORKERS_AI_MODELS_URL,
  // The per-model schemas are Cloudflare's own, re-fetched every sync.
  defaultDerivation: 'upstream-spec',
  connect: bearerConnect(
    'https://api.cloudflare.com/client/v4',
    'Account-scoped: {account_id} is a path parameter on every route.',
  ),
  // A model listed today has no synced schema until the next daily sync.
  bindSyncedRoutesOnly: true,
  fetchSpec,
  listModels,
  classify: (path) =>
    path.startsWith('/accounts/{account_id}/ai/run/') ? 'chat' : null,
}
