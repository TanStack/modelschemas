/**
 * Nightly FAL rate-card extract (issue #68): page candidate catalog rows,
 * fetch each endpoint's llms.txt, hash-skip the Pricing section, and ask
 * one model to write a RateCard. Own cron / admin route — not FAL's
 * spec-sync shard. Chat token sections compile in `compileFalTokenCard`
 * and the model poll stores those; this job still owns every other section.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { createAnthropicChat } from '@tanstack/ai-anthropic'
import { cloudflareBindingFetch } from '@tanstack/ai-cloudflare'
import { chat } from '@tanstack/ai'
import { z } from 'zod'

import { cardParams, verifyExamples } from '@modelschemas/rate-card'
import { rateCardSchema } from '@modelschemas/rate-card/schema'
import type { RateCard } from '@modelschemas/rate-card'

import { cacheMeta, changes, models, schemaVersions } from '#/db/schema.ts'
import { errorMessage } from '#/server/errors.ts'
import { falLlmsTxtUrl } from '#/server/providers/fal.ts'
import { priceFalNamedSection, usdAmounts } from './fal-unit-rate.ts'
import { markdownSection } from '#/server/providers/model-facts.ts'
import { requestSchemaPropertyNames } from '#/server/providers/fact-sources.ts'
import type { ModelFactSources } from '#/server/providers/types.ts'
import { sha256Text } from '#/server/providers/types.ts'
import {
  cardRequestParamsOk,
  parseStoredRateCard,
  storeListedPricing,
} from '#/server/rate-card.ts'
import type { RateCardRefuse } from '#/server/rate-card.ts'
import { changedFactPaths, modelUpdatedPayload } from './change-facts.ts'
import {
  captureIngestEvents,
  ingestFailedEvent,
  noteIngest,
  runIngestScope,
} from './ingest-signals.ts'
import type { SyncDeps } from './sync.ts'

/**
 * Own invocations, after the 05:00–05:30 spec-sync shards. Six hourly
 * firings so the whole FAL roster fits in one calendar day within the
 * per-invocation subrequest budget. Keep in lockstep with `wrangler.jsonc`
 * `triggers.crons` (unit-tested).
 */
export const FAL_PRICING_EXTRACT_CRONS = [
  '0 6 * * *',
  '0 7 * * *',
  '0 8 * * *',
  '0 9 * * *',
  '0 10 * * *',
  '0 11 * * *',
] as const

/** ~250 llms.txt fetches + leftovers stays well under the 1000 limit. */
export const FAL_PRICING_FETCH_CAP = 250
export const FAL_PRICING_EXTRACT_CAP = 40
/** llms.txt fetches in flight at once. */
export const FAL_PRICING_FETCH_CONCURRENCY = 20
/** Extract calls in flight at once. */
export const FAL_PRICING_EXTRACT_CONCURRENCY = 5
/** Consecutive 408/429/5xx/network failures before the run stops walking. */
export const FAL_PRICING_FETCH_FAIL_ABORT = 8

export const FAL_PRICING_EXTRACT_CURSOR_KEY = 'fal-pricing-extract-cursor'

export function falPricingExtractCursorKey(providerId = 'fal'): string {
  return `${FAL_PRICING_EXTRACT_CURSOR_KEY}:${providerId}`
}

/**
 * Single extract model — fail-closed; never a second guess. Picked by
 * `scripts/compare-fal-extract-models.ts` (#550). Anthropic's id: the
 * binding fetch prefixes `anthropic/` for the gateway.
 */
export const FAL_PRICING_EXTRACT_MODEL = 'claude-sonnet-5-5'

const extractedBodySchema = rateCardSchema.omit({ source: true }).extend({
  expiresAt: z.iso.datetime().optional(),
})

const extractedResponseSchema = z.union([
  z.object({ unverified: z.literal(true) }),
  extractedBodySchema,
])

export type FalPricingExtractRefuse = RateCardRefuse | 'unverified' | 'stub'

export interface FalPricingExtractOutcome {
  providerId: string
  candidates: number
  fetched: number
  /** Cards built by the unit-rate parser, no model call. */
  compiled: number
  /** Rows filled by copying a card already known for that section hash. */
  deduped: number
  extracted: number
  written: number
  hashSkipped: number
  refused: number
  unverified: number
  fetchFailed: number
  cursor: string | null
  skipped?: string
  error?: string
}

/** `{ error }` = no card this run, and why (gateway error or empty reply, a throw, or two rejections). */
export type ExtractedCard = RateCard | 'unverified' | { error: string }

export interface ExtractCardArgs {
  pricingText: string
  requestProperties: ReadonlySet<string>
  sourceUrl: string
  sourceHash: string
  now: number
}

/** string body, `null` = 404, `{ status }` for HTTP/network (`0` = network). */
export type FalLlmsFetchResult = string | null | { status: number }

export interface FalPricingExtractDeps extends SyncDeps {
  fetchText?: (url: string) => Promise<FalLlmsFetchResult>
  extractCard?: (args: ExtractCardArgs) => Promise<ExtractedCard>
  /** Workers AI binding + AI Gateway id; both unset = leftovers skipped. */
  ai?: Ai
  gatewayId?: string
  fetchCap?: number
  extractCap?: number
  providerId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function pricingSection(llmsTxt: string): string {
  return markdownSection(llmsTxt, 'Pricing').trim()
}

/**
 * No positive dollar amount — empty, boilerplate, or zeros. Bold and
 * suffix-`$` spellings (`$**0.04**`, `**0.17** $`) are real prices, not
 * stubs (issue #70).
 */
export function isStubPricingSection(section: string): boolean {
  return usdAmounts(section).length === 0
}

export async function pricingSectionHash(section: string): Promise<string> {
  return sha256Text(section)
}

/**
 * Index to resume from after `cursor` (the last processed rawId). Wraps
 * when the cursor is the tail or no longer in the roster.
 */
export function resumeIndex(
  rawIds: ReadonlyArray<string>,
  cursor: string | null,
): number {
  if (rawIds.length === 0 || cursor === null) return 0
  const exact = rawIds.indexOf(cursor)
  if (exact >= 0) return (exact + 1) % rawIds.length
  const next = rawIds.findIndex((id) => id > cursor)
  return next < 0 ? 0 : next
}

/**
 * Unchanged Pricing hash skips extract unless a promo `expiresAt` is
 * already in the past, or the stored card is still null (an unverified
 * leftover) and the section is not a stub — those retry every lap (#84).
 */
export function shouldSkipExtract(args: {
  storedHash: string | null
  sectionHash: string
  hasCard: boolean
  stub: boolean
  expiresAt: string | undefined
  now: number
}): boolean {
  if (args.storedHash !== args.sectionHash) return false
  if (!args.hasCard && !args.stub) return false
  if (args.expiresAt === undefined) return true
  return Date.parse(args.expiresAt) > args.now * 1000
}

function factSourcesOf(value: unknown): ModelFactSources | null {
  if (!isRecord(value)) return null
  return value
}

function storedPricingHash(
  card: RateCard | null,
  sources: ModelFactSources | null,
): string | null {
  return sources?.pricing?.sourceHash ?? card?.source.hash ?? null
}

export function isRetryableLlmsStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500
}

function llmsFetchOutcome(
  result: FalLlmsFetchResult,
): { text: string } | { status: number } {
  if (typeof result === 'string') return { text: result }
  if (result === null) return { status: 404 }
  return { status: result.status }
}

async function fetchLlmsTxt(url: string): Promise<FalLlmsFetchResult> {
  try {
    const response = await fetch(url)
    if (!response.ok) return { status: response.status }
    return await response.text()
  } catch {
    return { status: 0 }
  }
}

function logFetchFailure(
  providerId: string,
  rawId: string,
  status: number,
): void {
  console.error(
    JSON.stringify({
      job: 'fal-pricing-extract',
      providerId,
      rawId,
      error: 'llms_txt_fetch_failed',
      status,
    }),
  )
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const body = fenced?.[1] ?? trimmed
  return JSON.parse(body) as unknown
}

export const EXTRACT_SYSTEM = `You write a modelschemas RateCard — a price calculator — from a FAL model's llms.txt Pricing section.
Return JSON only: {"inputs": {...}, "tables": {...}, "price": <JSONLogic>, "examples": [...]}, optionally "expiresAt" (ISO datetime) when the text names a promo end. Do not include a source object.

inputs: name → {"param": <field>, "kind": "number"|"enum"|"boolean"|"count", "bound": "request"|"usage", "default"?: ..., "values"?: [...] (enum only)}.
- A request-bound param MUST be one of the allowed request properties (or a dotted child of one). Give it a default when the request may omit it.
- A quantity the request cannot state (seconds of output, megapixels, characters, tokens) is "bound": "usage" — never invent a request field.
- So is a priced choice no allowed property sets (an output resolution the request has no field for): a "bound": "usage" enum the caller states, with no default.
- "count" prices the items of a list param (image_urls, reference_image_urls): {"var": x} is the list's length. An example's params give the list itself ({"image_urls": ["https://example.com/a.png", "https://example.com/b.png"]}), never a number, and there is no ".length". A count input has no default: omit the param for zero items. Per output item (num_images) and any quantity the request does not send as a list (characters, seconds) is "number".
tables: name → nested {key: number}, read with {"lookup": {"table": name, "keys": [{"var": input}]}}.
price: JSONLogic over var, +, -, *, /, max, min, if, ==, !=, <, <=, >, >=, and, or, ceil, floor, lookup. {"var": x} reads the input named x. "==" is strict: compare enum inputs to strings.
examples: [{"params": {param: value}, "usd": number, "quote": text copied verbatim from the section}]. The card is rejected unless evaluating price on each example's params reproduces usd within 1%.

Rules:
- If the section names ANY positive dollar amount you MUST write a card. Several prices, multipliers, add-ons and per-resolution / per-duration tables are what this format is for: combine them with *, +, if and lookup.
- Quoted rates ARE worked numbers: synthesize one example per stated rate. "$0.08 per image" → params {"num_images": 1}, usd 0.08. "per 1000 characters" → 1000 units at the quoted price. "2K at 1.5 times" → params {"resolution": "2K"}, usd 0.12. "an additional $0.015 if web search is used" → params {"enable_web_search": true}, usd 0.095.
- Prefer the page's own worked total when it states one ("a 5 second video costs $0.70").
- Return {"unverified": true} ONLY when the section names no positive price (empty, zeros, or "see pricing page" boilerplate).

Example. Section: "Your request will cost $0.08 per image. 2K outputs are charged at 1.5 times the standard rate. If web search is used, an additional $0.015 will be charged." Allowed: num_images, resolution, enable_web_search.
{"inputs":{"num_images":{"param":"num_images","kind":"number","bound":"request","default":1},"resolution":{"param":"resolution","kind":"enum","bound":"request","values":["1K","2K"],"default":"1K"},"enable_web_search":{"param":"enable_web_search","kind":"boolean","bound":"request","default":false}},"tables":{"multiplier":{"1K":1,"2K":1.5}},"price":{"+":[{"*":[{"var":"num_images"},0.08,{"lookup":{"table":"multiplier","keys":[{"var":"resolution"}]}}]},{"if":[{"var":"enable_web_search"},0.015,0]}]},"examples":[{"params":{"num_images":1},"usd":0.08,"quote":"Your request will cost $0.08 per image"},{"params":{"resolution":"2K"},"usd":0.12,"quote":"2K outputs are charged at 1.5 times the standard rate"},{"params":{"enable_web_search":true},"usd":0.095,"quote":"If web search is used, an additional $0.015 will be charged"}]}

Example. Section: "Each edit costs $0.10, plus $0.02 per reference image." Allowed: prompt, reference_image_urls.
{"inputs":{"reference_images":{"param":"reference_image_urls","kind":"count","bound":"request"}},"tables":{},"price":{"+":[0.1,{"*":[{"var":"reference_images"},0.02]}]},"examples":[{"params":{},"usd":0.1,"quote":"Each edit costs $0.10"},{"params":{"reference_image_urls":["https://example.com/a.png","https://example.com/b.png"]},"usd":0.14,"quote":"plus $0.02 per reference image"}]}`

function extractUserPrompt(
  pricingText: string,
  requestProperties: ReadonlySet<string>,
): string {
  const allowed = [...requestProperties].sort().join(', ')
  return `Allowed request properties: ${allowed || '(none)'}

Pricing section:
${pricingText}`
}

function withSource(
  body: z.infer<typeof extractedBodySchema>,
  args: ExtractCardArgs,
): RateCard {
  const { expiresAt, ...rest } = body
  return {
    ...rest,
    source: {
      url: args.sourceUrl,
      hash: args.sourceHash,
      extractedAt: new Date(args.now * 1000).toISOString(),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
  }
}

/**
 * The model's reply as a card, `'unverified'`, or why it was rejected.
 * `{unverified: true}` and an example-less card are only legal for a
 * section that names no price (#88) — a priced section must become a card.
 */
export function checkExtractedCard(
  content: string,
  args: ExtractCardArgs,
): RateCard | 'unverified' | { error: string } {
  let json: unknown
  try {
    json = parseJsonObject(content)
  } catch {
    return { error: 'reply is not JSON' }
  }
  const parsed = extractedResponseSchema.safeParse(json)
  if (!parsed.success) {
    return { error: `not a RateCard: ${z.prettifyError(parsed.error)}` }
  }
  const priced = !isStubPricingSection(args.pricingText)
  if ('unverified' in parsed.data || parsed.data.examples.length === 0) {
    return priced
      ? {
          error: `the section names ${usdAmounts(args.pricingText)
            .map((usd) => `$${usd}`)
            .join(', ')}; write the card with one example per quoted rate`,
        }
      : 'unverified'
  }
  const card = withSource(parsed.data, args)
  if (!cardRequestParamsOk(card, args.requestProperties)) {
    return {
      error:
        'a request-bound input param is not an allowed request property; bind it to an allowed property or make it "bound": "usage"',
    }
  }
  // A usage-bound choice (output resolution) is the caller's to state; a
  // default would price a guess (#304). Number defaults (an add-on's 0)
  // stay legal, as on compiled token cards.
  const usageDefaults = Object.entries(card.inputs)
    .filter(
      ([, input]) =>
        input.bound === 'usage' && input.kind === 'enum' && 'default' in input,
    )
    .map(([name]) => name)
  if (usageDefaults.length > 0) {
    return {
      error: `usage-bound enums have a default (${usageDefaults.join(', ')}); the caller states them — remove the default`,
    }
  }
  const failed = verifyExamples(card).filter((result) => !result.ok)
  if (failed.length > 0) {
    return {
      error: `verifyExamples failed: ${failed
        .map((r) => `${JSON.stringify(r.example.params)} → ${r.error}`)
        .join('; ')}`,
    }
  }
  return card
}

export type ChatTurn = { role: 'user' | 'assistant'; content: string }

/** The model's reply to these turns after `EXTRACT_SYSTEM`; throws on error. */
export type ExtractChat = (turns: Array<ChatTurn>) => Promise<string>

/**
 * The extract model through Cloudflare AI Gateway on Unified Billing: the
 * TanStack AI Anthropic adapter, its requests sent over the `env.AI`
 * binding (which authenticates, so no provider key). No temperature: Claude 5
 * models 400 on it (`anthropic-features.ts`). A gateway or provider error
 * throws.
 */
export function gatewayChat(
  ai: Ai,
  gatewayId: string,
  model:
    | typeof FAL_PRICING_EXTRACT_MODEL
    | 'claude-haiku-5-5' = FAL_PRICING_EXTRACT_MODEL,
): ExtractChat {
  const bindingFetch = cloudflareBindingFetch({
    binding: ai,
    vendor: 'anthropic',
    gateway: { id: gatewayId },
  })
  // The Anthropic SDK reports a thrown fetch as a bare "Connection error."
  // and drops the binding's error, so keep it and rethrow it as the cause.
  let bindingError: unknown
  const adapter = createAnthropicChat(model, 'cloudflare-binding', {
    fetch: async (...args: Parameters<typeof bindingFetch>) => {
      try {
        const response = await bindingFetch(...args)
        // A retry got through: an earlier throw is not this call's cause.
        bindingError = undefined
        return response
      } catch (error) {
        bindingError = error
        throw error
      }
    },
  })
  const threadId = crypto.randomUUID()
  return async (turns) => {
    bindingError = undefined
    try {
      const { text } = await chat({
        adapter,
        threadId,
        stream: false,
        systemPrompts: [EXTRACT_SYSTEM],
        messages: turns,
      })
      return text
    } catch (error) {
      if (bindingError === undefined) throw error
      throw new Error(errorMessage(error), { cause: bindingError })
    }
  }
}

/**
 * One model, at most two turns: a rejected card goes back once with the
 * reason (same model — not a fallback). `{ error }` = no card this run; the
 * caller holds the cursor so the next shard retries it, and reports why.
 */
export async function extractRateCard(
  args: ExtractCardArgs & { chat: ExtractChat },
): Promise<ExtractedCard> {
  const turns: Array<ChatTurn> = [
    {
      role: 'user',
      content: extractUserPrompt(args.pricingText, args.requestProperties),
    },
  ]
  try {
    let rejected = ''
    for (let turn = 0; turn < 2; turn++) {
      const content = await args.chat(turns)
      const checked = checkExtractedCard(content, args)
      if (checked === 'unverified' || !('error' in checked)) return checked
      rejected = checked.error
      turns.push(
        { role: 'assistant', content },
        {
          role: 'user',
          content: `Rejected: ${checked.error}. Return the corrected full JSON.`,
        },
      )
    }
    return { error: `rejected twice: ${rejected.slice(0, 200)}` }
  } catch (error) {
    return { error: errorMessage(error) }
  }
}

function logRefusal(
  providerId: string,
  rawId: string,
  reason: FalPricingExtractRefuse,
): void {
  console.error(
    JSON.stringify({
      job: 'fal-pricing-extract',
      providerId,
      rawId,
      error: 'rate_card_refused',
      reason,
    }),
  )
  noteIngest({
    event: 'rate_card_refused',
    properties: { providerId, rawId, reason },
  })
}

/** Cursor and held rawId live in `cache_meta.lastError` under their own keys. */
async function loadCursor(
  db: SyncDeps['db'],
  key: string,
): Promise<string | null> {
  const row = await db.query.cacheMeta.findFirst({
    where: eq(cacheMeta.key, key),
  })
  const cursor = row?.lastError
  return cursor && cursor.length > 0 ? cursor : null
}

async function saveCursor(
  db: SyncDeps['db'],
  key: string,
  cursor: string,
  now: number,
): Promise<void> {
  await db
    .insert(cacheMeta)
    .values({
      key,
      fetchedAt: now,
      staleTime: 0,
      lastError: cursor,
    })
    .onConflictDoUpdate({
      target: cacheMeta.key,
      set: { fetchedAt: now, lastError: cursor },
    })
}

interface Candidate {
  id: string
  rawId: string
  pricing: unknown
  factSources: unknown
  schemaEndpointId: string | null
  boundId: string
}

async function loadCandidates(
  db: SyncDeps['db'],
  providerId: string,
): Promise<Array<Candidate>> {
  const rows = await db
    .select({
      id: models.id,
      rawId: models.rawId,
      pricing: models.pricing,
      factSources: models.factSources,
      schemaEndpointId: models.schemaEndpointId,
    })
    .from(models)
    .where(and(eq(models.providerId, providerId), isNull(models.deprecatedAt)))
  const candidates: Array<Candidate> = []
  for (const row of rows) {
    const boundId = row.schemaEndpointId ?? row.rawId
    candidates.push({ ...row, boundId })
  }
  candidates.sort((a, b) =>
    a.rawId < b.rawId ? -1 : a.rawId > b.rawId ? 1 : 0,
  )
  return candidates
}

async function loadRequestProperties(
  db: SyncDeps['db'],
  providerId: string,
  boundIds: ReadonlyArray<string>,
): Promise<Map<string, Set<string>>> {
  const properties = new Map<string, Set<string>>()
  const dbIds = [...new Set(boundIds)].map((id) => `${providerId}/${id}`)
  for (let i = 0; i < dbIds.length; i += 90) {
    const chunk = dbIds.slice(i, i + 90)
    const versions = await db
      .select({
        endpointId: schemaVersions.endpointId,
        schema: schemaVersions.schema,
      })
      .from(schemaVersions)
      .where(
        and(
          inArray(schemaVersions.endpointId, chunk),
          eq(schemaVersions.kind, 'input'),
          isNull(schemaVersions.supersededAt),
        ),
      )
    const prefix = `${providerId}/`
    for (const version of versions) {
      const publicId = version.endpointId.startsWith(prefix)
        ? version.endpointId.slice(prefix.length)
        : version.endpointId
      const parsed: unknown = JSON.parse(version.schema)
      properties.set(publicId, requestSchemaPropertyNames(parsed))
    }
  }
  return properties
}

function docsExtractedSource(sources: ModelFactSources | null): {
  derivation: 'docs-extracted'
  sourceUrl?: string
  sourceHash?: string
  fetchedAt?: number
} {
  return {
    derivation: 'docs-extracted',
    ...(sources?.pricing?.sourceUrl
      ? { sourceUrl: sources.pricing.sourceUrl }
      : {}),
    ...(sources?.pricing?.sourceHash
      ? { sourceHash: sources.pricing.sourceHash }
      : {}),
    ...(sources?.pricing?.fetchedAt !== undefined
      ? { fetchedAt: sources.pricing.fetchedAt }
      : {}),
  }
}

async function writePricing(args: {
  db: SyncDeps['db']
  providerId: string
  candidate: Candidate
  card: RateCard | null
  sourceUrl: string
  sourceHash: string
  now: number
}): Promise<boolean> {
  const prior = factSourcesOf(args.candidate.factSources)
  const nextSources: ModelFactSources = {
    ...prior,
    pricing: {
      derivation: 'docs-extracted',
      sourceUrl: args.sourceUrl,
      sourceHash: args.sourceHash,
      fetchedAt: args.now,
    },
  }
  const before = { pricing: args.candidate.pricing }
  const after = { pricing: args.card }
  const changed = changedFactPaths(before, after)
  await args.db
    .update(models)
    .set({
      // A stamp or an operand reorder is not a new card. The stored source
      // stays the read on which the price last changed.
      ...(changed.length > 0 ? { pricing: args.card } : {}),
      factSources: nextSources,
    })
    .where(eq(models.id, args.candidate.id))
  if (changed.length === 0) return false
  await args.db.insert(changes).values({
    id: crypto.randomUUID(),
    type: 'model.updated',
    providerId: args.providerId,
    subjectId: args.candidate.id,
    summary: `Model ${args.candidate.rawId} updated`,
    payload: modelUpdatedPayload(before, after, changed),
    createdAt: args.now,
  })
  return true
}

async function stampPricingHash(args: {
  db: SyncDeps['db']
  candidate: Candidate
  sourceUrl: string
  sourceHash: string
  now: number
}): Promise<void> {
  const prior = factSourcesOf(args.candidate.factSources)
  await args.db
    .update(models)
    .set({
      factSources: {
        ...prior,
        pricing: {
          ...docsExtractedSource(prior),
          derivation: 'docs-extracted',
          sourceUrl: args.sourceUrl,
          sourceHash: args.sourceHash,
          fetchedAt: args.now,
        },
      },
    })
    .where(eq(models.id, args.candidate.id))
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, TResult>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T) => Promise<TResult>,
): Promise<Array<TResult>> {
  const out: Array<TResult> = Array.from({ length: items.length })
  let next = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (let i = next++; i < items.length; i = next++) {
        out[i] = await fn(items[i] as T)
      }
    },
  )
  await Promise.all(workers)
  return out
}

interface LeftoverGroup {
  section: string
  sourceUrl: string
  rows: Array<Candidate>
}

export async function extractFalPricing(
  deps: FalPricingExtractDeps,
): Promise<FalPricingExtractOutcome> {
  return runIngestScope(() => extractFalPricingScoped(deps))
}

async function extractFalPricingScoped(
  deps: FalPricingExtractDeps,
): Promise<FalPricingExtractOutcome> {
  const providerId = deps.providerId ?? 'fal'
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000)
  const fetchCap = deps.fetchCap ?? FAL_PRICING_FETCH_CAP
  const extractCap = deps.extractCap ?? FAL_PRICING_EXTRACT_CAP
  const outcome: FalPricingExtractOutcome = {
    providerId,
    candidates: 0,
    fetched: 0,
    compiled: 0,
    deduped: 0,
    extracted: 0,
    written: 0,
    hashSkipped: 0,
    refused: 0,
    unverified: 0,
    fetchFailed: 0,
    cursor: null,
  }

  const { ai, gatewayId } = deps
  const extract =
    deps.extractCard ??
    (ai && gatewayId
      ? (args: ExtractCardArgs) =>
          extractRateCard({ ...args, chat: gatewayChat(ai, gatewayId) })
      : null)

  try {
    const all = await loadCandidates(deps.db, providerId)
    const properties = await loadRequestProperties(
      deps.db,
      providerId,
      all.map((row) => row.boundId),
    )
    // A missing input schema still gets a usage-bound unit card. Rows with
    // no activity (3d, vision, json) are catalog models too (#114).
    const candidates = all
    outcome.candidates = candidates.length
    if (candidates.length === 0) return outcome

    // Cards already stored against a Pricing-section hash — reused across
    // rows in this run and across nights, so the model is never asked
    // twice for the same text. Several per hash: endpoints sharing one
    // section can have different request schemas (#304), and a card is only
    // copied onto a row whose schema has every request param it binds.
    const byHash = new Map<string, Array<RateCard>>()
    const remember = (hash: string, card: RateCard): void => {
      const cards = byHash.get(hash)
      if (cards) cards.push(card)
      else byHash.set(hash, [card])
    }
    for (const row of candidates) {
      const card = parseStoredRateCard(row.pricing)
      // A promo card past its expiresAt must be re-read, not copied on.
      if (!card) continue
      const expiresAt = card.source.expiresAt
      if (expiresAt !== undefined && Date.parse(expiresAt) <= now * 1000) {
        continue
      }
      remember(card.source.hash, card)
    }

    const requestPropertiesOf = (candidate: Candidate): ReadonlySet<string> =>
      properties.get(candidate.boundId) ?? new Set<string>()

    const applyCard = async (
      candidate: Candidate,
      card: RateCard,
      sourceUrl: string,
      sectionHash: string,
    ): Promise<boolean> => {
      const stamped: RateCard = {
        ...card,
        source: {
          ...card.source,
          url: sourceUrl,
          hash: sectionHash,
          extractedAt: new Date(now * 1000).toISOString(),
        },
      }
      const stored = await storeListedPricing(stamped, {
        existing: candidate.pricing,
        requestProperties: requestPropertiesOf(candidate),
        sourceUrl,
        now,
      })
      if (stored.refused || stored.card === null) {
        outcome.refused++
        logRefusal(
          providerId,
          candidate.rawId,
          stored.refused ?? 'uncompilable',
        )
        return false
      }
      if (
        await writePricing({
          db: deps.db,
          providerId,
          candidate,
          card: stored.card,
          sourceUrl,
          sourceHash: sectionHash,
          now,
        })
      ) {
        outcome.written++
      }
      return true
    }

    const rawIds = candidates.map((row) => row.rawId)
    const cursorKey = falPricingExtractCursorKey(providerId)
    const heldKey = `${cursorKey}:held`
    const cursor = await loadCursor(deps.db, cursorKey)
    const start = resumeIndex(rawIds, cursor)
    const order = [...candidates.slice(start), ...candidates.slice(0, start)]

    // Held in an object: `mark` assigns it from a closure, where TS's
    // control-flow analysis would otherwise keep narrowing it to null.
    const walked: { last: string | null } = { last: null }
    let consecutiveFetchFails = 0
    let cursorFrozen = false
    const fetchLlms = deps.fetchText ?? fetchLlmsTxt
    const leftovers = new Map<string, LeftoverGroup>()
    // Each queued leftover row → the cursor just before it, in walk order,
    // so a failed extract can rewind the cursor onto it.
    const cursorBefore = new Map<string, string | null>()

    // llms.txt is pure I/O — fetch a window ahead so a shard is not 250
    // sequential round trips. Order of processing is unchanged.
    const buffer = new Map<number, FalLlmsFetchResult>()
    const fetchAt = async (i: number): Promise<FalLlmsFetchResult> => {
      const cached = buffer.get(i)
      if (cached !== undefined) return cached
      const width = Math.max(
        1,
        Math.min(FAL_PRICING_FETCH_CONCURRENCY, fetchCap - i, order.length - i),
      )
      const results = await Promise.all(
        order
          .slice(i, i + width)
          .map((row) => fetchLlms(falLlmsTxtUrl(row.rawId))),
      )
      results.forEach((result, k) => buffer.set(i + k, result))
      return results[0] as FalLlmsFetchResult
    }

    for (let i = 0; i < order.length && outcome.fetched < fetchCap; i++) {
      const candidate = order[i] as Candidate
      const mark = (): void => {
        if (!cursorFrozen) walked.last = candidate.rawId
      }

      const sourceUrl = falLlmsTxtUrl(candidate.rawId)
      const fetched = llmsFetchOutcome(await fetchAt(i))
      outcome.fetched++

      if ('status' in fetched) {
        logFetchFailure(providerId, candidate.rawId, fetched.status)
        outcome.fetchFailed++
        if (isRetryableLlmsStatus(fetched.status)) {
          consecutiveFetchFails++
          cursorFrozen = true
          if (consecutiveFetchFails >= FAL_PRICING_FETCH_FAIL_ABORT) break
          continue
        }
        consecutiveFetchFails = 0
        mark()
        continue
      }

      consecutiveFetchFails = 0
      const section = pricingSection(fetched.text)
      const sectionHash = await pricingSectionHash(section)
      const existingCard = parseStoredRateCard(candidate.pricing)
      const sources = factSourcesOf(candidate.factSources)
      const stub = isStubPricingSection(section)
      if (
        shouldSkipExtract({
          storedHash: storedPricingHash(existingCard, sources),
          sectionHash,
          hasCard: existingCard !== null,
          stub,
          expiresAt: existingCard?.source.expiresAt,
          now,
        })
      ) {
        outcome.hashSkipped++
        mark()
        continue
      }

      if (stub) {
        logRefusal(providerId, candidate.rawId, 'stub')
        outcome.refused++
        if (
          await writePricing({
            db: deps.db,
            providerId,
            candidate,
            card: null,
            sourceUrl,
            sourceHash: sectionHash,
            now,
          })
        ) {
          outcome.written++
        }
        mark()
        continue
      }

      // Of the cards that fit, the one reading the most from the request:
      // a sibling's usage-bound `resolution` must not shadow this row's
      // request field.
      const known = (byHash.get(sectionHash) ?? [])
        .filter((card) =>
          cardRequestParamsOk(card, requestPropertiesOf(candidate)),
        )
        .sort(
          (a, b) => cardParams(b).request.length - cardParams(a).request.length,
        )[0]
      if (known) {
        outcome.deduped++
        await applyCard(candidate, known, sourceUrl, sectionHash)
        mark()
        continue
      }

      const compiled = priceFalNamedSection(
        section,
        requestPropertiesOf(candidate),
        {
          url: sourceUrl,
          hash: sectionHash,
          extractedAt: new Date(now * 1000).toISOString(),
        },
      )
      if (compiled) {
        outcome.compiled++
        remember(sectionHash, compiled)
        await applyCard(candidate, compiled, sourceUrl, sectionHash)
        mark()
        continue
      }

      const group = leftovers.get(sectionHash)
      if (group) {
        group.rows.push(candidate)
        cursorBefore.set(candidate.rawId, walked.last)
        mark()
        continue
      }
      // The cap counts distinct sections, not rows — a row joining a
      // section already queued is free. Past the cap, keep walking so the
      // rest of the fetch window still compiles/dedups/stamps, but freeze
      // the cursor so the next shard resumes on this row (#84).
      if (leftovers.size >= extractCap) {
        cursorFrozen = true
        continue
      }
      leftovers.set(sectionHash, { section, sourceUrl, rows: [candidate] })
      cursorBefore.set(candidate.rawId, walked.last)
      mark()
    }

    // Everything the parser could not stand behind: one extract call per
    // distinct Pricing section, then copied onto every row sharing it.
    const failed = new Set<string>()
    const reasons = new Set<string>()
    if (leftovers.size > 0 && extract === null) {
      outcome.skipped =
        'AI binding or AI_GATEWAY_ID not set — leftovers skipped'
    } else if (leftovers.size > 0 && extract !== null) {
      const groups = [...leftovers.entries()]
      const results = await mapLimit(
        groups,
        FAL_PRICING_EXTRACT_CONCURRENCY,
        async ([hash, group]) => {
          outcome.extracted++
          return await extract({
            pricingText: group.section,
            requestProperties: requestPropertiesOf(group.rows[0] as Candidate),
            sourceUrl: group.sourceUrl,
            sourceHash: hash,
            now,
          })
        },
      )

      for (const [index, [hash, group]] of groups.entries()) {
        const result = results[index]
        if (
          result === 'unverified' ||
          (result !== undefined &&
            !('error' in result) &&
            result.examples.length === 0)
        ) {
          for (const row of group.rows) {
            outcome.unverified++
            logRefusal(providerId, row.rawId, 'unverified')
            await stampPricingHash({
              db: deps.db,
              candidate: row,
              sourceUrl: falLlmsTxtUrl(row.rawId),
              sourceHash: hash,
              now,
            })
          }
          continue
        }
        const card = result === undefined || 'error' in result ? null : result
        if (result !== undefined && 'error' in result) reasons.add(result.error)
        if (card) remember(hash, card)
        for (const row of group.rows) {
          const sourceUrl = falLlmsTxtUrl(row.rawId)
          if (card && (await applyCard(row, card, sourceUrl, hash))) {
            continue
          }
          if (card) {
            reasons.add(
              `card extracted for ${(group.rows[0] as Candidate).rawId} refused for ${row.rawId}`,
            )
          }
          if (!card) {
            outcome.refused++
            logRefusal(providerId, row.rawId, 'uncompilable')
          }
          failed.add(row.rawId)
          // Stamp so the row is not left unwritten; a card it already
          // has is kept, and its old hash keeps it due for a retry.
          if (parseStoredRateCard(row.pricing) === null) {
            await stampPricingHash({
              db: deps.db,
              candidate: row,
              sourceUrl,
              sourceHash: hash,
              now,
            })
          }
        }
      }
    }

    // A leftover with no card this run rewinds the cursor onto itself so
    // the next shard retries it (#88). Only once: a row that fails again
    // while already held moves on and waits for the next lap, so one bad
    // page cannot stall the walk.
    let last = walked.last
    if (failed.size > 0) {
      noteIngest(
        ingestFailedEvent(
          'fal-pricing-extract',
          providerId,
          [
            `leftover retry: ${failed.size}`,
            ...[...reasons].slice(0, 3),
            ...(reasons.size > 3 ? [`+${reasons.size - 3} more`] : []),
          ].join(' | '),
        ),
      )
      const held = await loadCursor(deps.db, heldKey)
      const retry = [...cursorBefore.keys()].find(
        (rawId) => failed.has(rawId) && rawId !== held,
      )
      if (retry !== undefined) {
        // null: nothing was walked before it — the stored cursor already
        // sits just before it.
        last = cursorBefore.get(retry) ?? null
        await saveCursor(deps.db, heldKey, retry, now)
      }
    }
    if (last !== null) {
      await saveCursor(deps.db, cursorKey, last, now)
      outcome.cursor = last
    } else {
      outcome.cursor = cursor
    }
    return outcome
  } catch (error) {
    outcome.error = errorMessage(error)
    console.error(
      JSON.stringify({
        job: 'fal-pricing-extract',
        providerId,
        error: outcome.error,
      }),
    )
    noteIngest(
      ingestFailedEvent('fal-pricing-extract', providerId, outcome.error),
    )
    return outcome
  } finally {
    await captureIngestEvents(deps.secrets.POSTHOG_PROJECT_KEY)
  }
}
