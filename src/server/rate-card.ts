/**
 * Rate cards on the catalog (issue #60): store only values that parse as
 * RateCard, compile OpenRouter listings at write, and project a compact
 * token formula on list rows.
 */
import {
  cardParams,
  cardCurrency,
  compileOpenRouterPricing,
  price,
  RateCardError,
  verifyExamples,
} from '@modelschemas/rate-card'
import { rateCardSchema } from '@modelschemas/rate-card/schema'
import type { RateCard } from '@modelschemas/rate-card'

import type { CompactPricing, PricingRange } from '#/server/api-schemas.ts'
import { contentHash, stableStringify } from '#/server/kv.ts'
import { emptySources } from '#/server/providers/fact-sources.ts'
import type { ModelFactSources } from '#/server/providers/types.ts'

/**
 * Request-bound param names allowed even when they are not properties of
 * the bound input schema (`input_tokens` is the type specimen). Usage-bound
 * params skip this check.
 */
const CARD_LEVEL_LEVERS = new Set([
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cache_write_1h_tokens',
  'reasoning_tokens',
  'image_tokens',
  'image_output_tokens',
  'audio_tokens',
  'audio_output_tokens',
  'audio_cache_tokens',
  'web_searches',
  'requests',
  // Seedance reference-video seconds. Not a generation-schema property;
  // refusing it nulled the whole stored card.
  'input_video_duration',
  // World Labs prices one total per published input type. The generate
  // schema's world_prompt is an object, so the label is not a property.
  'world_prompt_kind',
])

export type { CompactPricing }

export function parseStoredRateCard(value: unknown): RateCard | null {
  const parsed = rateCardSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function requestParamAllowed(
  param: string,
  requestProperties: ReadonlySet<string> | undefined,
): boolean {
  if (requestProperties === undefined) return true
  if (CARD_LEVEL_LEVERS.has(param)) return true
  if (requestProperties.has(param)) return true
  const root = param.split('.')[0]
  return root !== undefined && requestProperties.has(root)
}

export function cardRequestParamsOk(
  card: RateCard,
  requestProperties: ReadonlySet<string> | undefined,
): boolean {
  return cardParams(card).request.every((param) =>
    requestParamAllowed(param, requestProperties),
  )
}

function examplesOk(card: RateCard): boolean {
  return !verifyExamples(card).some((result) => !result.ok)
}

export interface StoreRateCardOptions {
  /** Previously stored `models.pricing`, used to keep `source.extractedAt`. */
  existing?: unknown
  /**
   * Top-level properties of the bound input schema. `undefined` skips the
   * invented-field check (no bound schema). An empty set still refuses
   * unknown request-bound params.
   */
  requestProperties?: ReadonlySet<string>
  sourceUrl: string
  /** Poll time, epoch seconds. */
  now: number
}

export type RateCardRefuse = 'invented_param' | 'examples' | 'uncompilable'

export type StoredPricing = {
  card: RateCard | null
  refused?: RateCardRefuse
}

/**
 * Value to write to `models.pricing`. Null means unknown — never a vendor
 * blob, never an all-zero OpenRouter-shaped listing.
 */
/** Every source text a card was read from: its own plus each estimate's. */
function sourceHashes(card: RateCard): string {
  return [
    card.source.hash,
    ...Object.values(card.inputs).flatMap((input) =>
      input.kind === 'number' && input.estimate
        ? [input.estimate.source.hash]
        : [],
    ),
  ].join()
}

/**
 * A stored card stands in for a fresh one while all its source text is
 * unchanged — except past `expiresAt`, the instant the source said the
 * price changes, where the re-read wins.
 */
function reusable(
  prior: RateCard | null,
  hashes: string,
  now: number,
): prior is RateCard {
  if (!prior || sourceHashes(prior) !== hashes) return false
  const expiresAt = prior.source.expiresAt
  return expiresAt === undefined || Date.parse(expiresAt) > now * 1000
}

/** Card contents with `extractedAt` removed, so a poll clock is not a rate change. */
function rateBody(card: RateCard): string {
  const { extractedAt: _extractedAt, ...source } = card.source
  return stableStringify({ ...card, source })
}

export async function storeListedPricing(
  pricing: unknown,
  options: StoreRateCardOptions,
): Promise<StoredPricing> {
  if (pricing == null) return { card: null }

  const parsed = parseStoredRateCard(pricing)
  if (parsed) {
    if (!cardRequestParamsOk(parsed, options.requestProperties)) {
      return { card: null, refused: 'invented_param' }
    }
    if (!examplesOk(parsed)) return { card: null, refused: 'examples' }
    // Same source text and the same rates: keep the stored card so a fresh
    // `extractedAt` alone is not a price change on every poll. A parser that
    // reads different levers from that text replaces the stored card.
    const prior = parseStoredRateCard(options.existing)
    const sameRates =
      reusable(prior, sourceHashes(parsed), options.now) &&
      rateBody(prior) === rateBody(parsed)
    return { card: sameRates ? prior : parsed }
  }

  const existing = parseStoredRateCard(options.existing)
  const listingHash = await contentHash(pricing)
  if (reusable(existing, listingHash, options.now)) {
    if (!cardRequestParamsOk(existing, options.requestProperties)) {
      return { card: null, refused: 'invented_param' }
    }
    return { card: existing }
  }

  const compiled = compileOpenRouterPricing(pricing, {
    url: options.sourceUrl,
    hash: listingHash,
    extractedAt: new Date(options.now * 1000).toISOString(),
  })
  if (!compiled) return { card: null, refused: 'uncompilable' }
  if (!cardRequestParamsOk(compiled, options.requestProperties)) {
    return { card: null, refused: 'invented_param' }
  }
  return { card: compiled }
}

export async function toStoredRateCard(
  pricing: unknown,
  options: StoreRateCardOptions,
): Promise<RateCard | null> {
  return (await storeListedPricing(pricing, options)).card
}

/**
 * Drop `factSources.pricing` when the stored card is null. If a card is
 * stored and pricing provenance is missing, stamp `{ derivation: listing }`.
 */
export function reconcilePricingSource(
  sources: ModelFactSources | null | undefined,
  card: RateCard | null,
): ModelFactSources | null {
  const next: ModelFactSources = { ...sources }
  if (card === null) delete next.pricing
  else if (next.pricing === undefined) next.pricing = { derivation: 'listing' }
  return emptySources(next) ? null : next
}

function isTokenCard(card: RateCard): boolean {
  let hasInput = false
  for (const input of Object.values(card.inputs)) {
    if (input.bound !== 'usage' || input.kind !== 'number') return false
    if (input.param === 'input_tokens') hasInput = true
  }
  return hasInput
}

function tryPrice(
  card: RateCard,
  usage: Record<string, number>,
): number | null {
  try {
    return price(card, {}, usage)
  } catch (error) {
    if (error instanceof RateCardError) return null
    throw error
  }
}

const LINEAR_REL_TOL = 1e-6

function linear(unitRate: number, count: number, total: number): boolean {
  return (
    Math.abs(unitRate * count - total) <=
    Math.max(1e-9, Math.abs(total) * LINEAR_REL_TOL)
  )
}

/**
 * Per-million rate of one lever, probed below any prompt-size tier
 * (1 and 1,000 tokens), plus whether a million tokens still price
 * linearly. Null when a per-request fee or the like breaks linearity.
 */
function perMillion(
  card: RateCard,
  lever: string,
  zeros: Record<string, number>,
): { rate: number; tiered: boolean } | null {
  const at1 = tryPrice(card, { ...zeros, [lever]: 1 })
  const at1k = tryPrice(card, { ...zeros, [lever]: 1_000 })
  const at1m = tryPrice(card, { ...zeros, [lever]: 1_000_000 })
  if (at1 === null || at1k === null || at1m === null) return null
  if (!linear(at1, 1_000, at1k)) return null
  return {
    // 2e-7 * 1e6 is 0.19999999999999998: drop the float noise, which sits
    // past any digit a price is published to.
    rate: Number((at1 * 1_000_000).toPrecision(12)),
    tiered: !linear(at1, 1_000_000, at1m),
  }
}

/** The unit a non-token card's quantity lever counts. */
const UNIT_OF_LEVER: Record<string, CompactPricing['per']> = {
  seconds: 'second',
  audio_seconds: 'second',
  session_seconds: 'second',
  video_seconds: 'second',
  duration: 'second',
  characters: 'character',
  n: 'image',
  num_images: 'image',
  images: 'image',
}

/**
 * List-row summary of a card. A token card gets `inputPerMillion` (and
 * `outputPerMillion` when it prices output) at the base rate, `tiered`
 * when a long prompt re-quotes the request; a token card whose price is
 * not linear in either (a per-request fee) gets `per: 'token'` alone.
 * Other cards name what they bill by, or `unit` when that is not obvious.
 */
export function projectTokenPricing(card: RateCard): CompactPricing {
  const currency = cardCurrency(card)
  if (!isTokenCard(card)) {
    const quantity = Object.values(card.inputs).find(
      (input) => input.kind === 'number',
    )
    return {
      currency,
      per: quantity ? (UNIT_OF_LEVER[quantity.param] ?? 'unit') : 'request',
    }
  }
  const hasOutput = Object.values(card.inputs).some(
    (input) => input.param === 'output_tokens',
  )
  const zeros: Record<string, number> = hasOutput
    ? { input_tokens: 0, output_tokens: 0 }
    : {}
  const input = perMillion(card, 'input_tokens', zeros)
  const output = hasOutput ? perMillion(card, 'output_tokens', zeros) : null
  if (input === null || (hasOutput && output === null)) {
    return { currency, per: 'token' }
  }
  return {
    currency,
    per: 'token',
    inputPerMillion: input.rate,
    ...(output && { outputPerMillion: output.rate }),
    ...((input.tiered || output?.tiered) && { tiered: true as const }),
  }
}

export function servePricing(
  value: unknown,
  mode: 'compact' | 'full',
): RateCard | CompactPricing | null {
  const card = parseStoredRateCard(value)
  if (!card) return null
  if (mode === 'full') return card
  return projectTokenPricing(card)
}

export type { PricingRange }

export function pricingRange(
  routes: Array<{
    model: string
    card: RateCard | null
    /** Set when the card is stored on the range, not on a catalog row. */
    provider?: string
  }>,
): PricingRange | null {
  if (routes.length < 2) return null
  const priced: PricingRange['routes'] = []
  for (const { model, card, provider } of routes) {
    if (!card) return null
    const pricing = projectTokenPricing(card)
    if (pricing.inputPerMillion === undefined || pricing.tiered) return null
    const inline = provider
      ? { provider, card: { ...card, examples: [] as [] } }
      : {}
    priced.push({
      model,
      pricing,
      ...inline,
    })
  }
  const currency = priced[0]?.pricing.currency
  if (!currency || priced.some((r) => r.pricing.currency !== currency)) {
    return null
  }
  const inputs = priced.map((r) => r.pricing.inputPerMillion ?? 0)
  const outputs = priced.flatMap((r) =>
    r.pricing.outputPerMillion === undefined
      ? []
      : [r.pricing.outputPerMillion],
  )
  // Every route prices output, or none does.
  if (outputs.length !== 0 && outputs.length !== priced.length) return null
  return {
    currency,
    routes: priced,
    inputPerMillion: { min: Math.min(...inputs), max: Math.max(...inputs) },
    ...(outputs.length > 0 && {
      outputPerMillion: {
        min: Math.min(...outputs),
        max: Math.max(...outputs),
      },
    }),
  }
}
