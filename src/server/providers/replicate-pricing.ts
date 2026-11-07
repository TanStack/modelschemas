/**
 * Replicate prediction prices (issue #120). Official model pages embed a
 * `billingConfig` for the price of one prediction. Hardware-timed community
 * models publish no such config and stay null. `equals` tiers become a
 * rate lookup keyed by each criterion; a tier quoting several metrics is
 * billed for their sum. A criterion we cannot name, tiers that disagree on
 * their criteria, a missing combination, or a price unit this does not
 * know is not a card. Token prices that step up above a prompt length
 * are the one range tier read.
 */
import { compileTokenCard, compileUnitCard } from '@modelschemas/rate-card'
import type {
  Expr,
  RateCard,
  Table,
  TokenRateTier,
  UnitKey,
} from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import type { ModelInfo } from './types.ts'

interface ReplicateCriterion {
  title?: string
  type?: string
  subtype?: string
  /** A string for `equals`, `[from, to]` for `range`. */
  value?: unknown
}

interface ReplicatePrice {
  metric?: string
  price?: string
  title?: string
  type?: string
}

interface ReplicateTier {
  criteria?: Array<ReplicateCriterion>
  prices?: Array<ReplicatePrice>
}

export interface ReplicateBilling {
  current_tiers?: Array<ReplicateTier>
}

const METRIC_PARAM: Record<string, string> = {
  image_output_count: 'output_images',
  image_input_megapixel_count: 'input_megapixels',
  token_input_count: 'input_tokens',
  token_output_count: 'output_tokens',
  video_output_duration_seconds: 'video_seconds',
  audio_output_duration_seconds: 'audio_seconds',
}

/** `$3` / `$0.03` → dollars. Anything else is not a price we can store. */
export function replicateDollars(price: string | undefined): number | null {
  const match = price?.trim().match(/^\$(\d+(?:\.\d+)?)$/)
  if (!match?.[1]) return null
  const dollars = Number(match[1])
  return Number.isFinite(dollars) && dollars > 0 ? dollars : null
}

/** `per thousand …` → how many billed units one quoted price covers. */
export function replicatePriceScale(title: string | undefined): number | null {
  const text = title?.trim().toLowerCase() ?? ''
  if (text.startsWith('per thousand')) return 1000
  if (text.startsWith('per million')) return 1_000_000
  if (text.startsWith('per second')) return 1
  if (
    text.startsWith('per output image') ||
    text.startsWith('per image') ||
    text.startsWith('per input image megapixel')
  ) {
    return 1
  }
  if (text.startsWith('per minute')) return 60
  if (text.startsWith('per hour')) return 3600
  return null
}

function criterionParam(title: string | undefined): string | null {
  const slug = title
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
  if (!slug || slug.length > 40) return null
  return slug
}

interface Leaf {
  param: string
  /** USD per one unit of `param`. */
  rate: number
  /** Request fields this tier is keyed by, in criterion order. */
  keys: Array<{ param: string; value: string }>
}

function leaf(price: ReplicatePrice, keys: Leaf['keys']): Leaf | null {
  if (price.type !== undefined && price.type !== 'per-unit') return null
  const param = price.metric ? METRIC_PARAM[price.metric] : undefined
  const dollars = replicateDollars(price.price)
  const scale = replicatePriceScale(price.title)
  if (!param || dollars === null || scale === null) return null
  // Duration titles ("per minute") quote several seconds; token and image
  // titles ("per thousand") quote that many billed units. Both are USD / scale.
  // toPrecision: `$0.015` per thousand is 0.000015, not 0.0000149999….
  const rate = Number((dollars / scale).toPrecision(12))
  if (!(rate > 0)) return null
  return { param, rate, keys }
}

function tokenRates(
  prices: Array<ReplicatePrice>,
): Record<string, number> | null {
  const rates: Record<string, number> = {}
  for (const price of prices) {
    const row = leaf(price, [])
    if (!row || !row.param.endsWith('_tokens') || row.param in rates) {
      return null
    }
    rates[row.param] = row.rate
  }
  return 'input_tokens' in rates && 'output_tokens' in rates ? rates : null
}

/**
 * Token prices by prompt length: one `≤ N` tier (the base) and one `> N`
 * tier that re-quotes above it. Any other range shape is not a card.
 */
function compilePromptTiers(
  tiers: Array<ReplicateTier>,
  source: RateCard['source'],
): RateCard | null {
  let base: { rates: Record<string, number>; upTo: number } | null = null
  let above: TokenRateTier | null = null
  for (const tier of tiers) {
    const [criterion, ...more] = tier.criteria ?? []
    const rates = tokenRates(tier.prices ?? [])
    const range = criterion?.value
    if (
      !criterion ||
      more.length > 0 ||
      !rates ||
      criterion.type !== 'range' ||
      criterion.title !== 'input token' ||
      !Array.isArray(range) ||
      range.length !== 2
    ) {
      return null
    }
    const bounds: Array<unknown> = range
    const [from, to] = bounds
    if (
      from === null &&
      typeof to === 'number' &&
      criterion.subtype === 'open-closed' &&
      !base
    ) {
      base = { rates, upTo: to }
    } else if (
      typeof from === 'number' &&
      to === null &&
      criterion.subtype === 'open' &&
      !above
    ) {
      above = { minPromptTokens: from, rates }
    } else {
      return null
    }
  }
  if (!base || !above || base.upTo !== above.minPromptTokens) return null
  return compileTokenCard(base.rates, [above], source)
}

/**
 * Dollar prediction price → rate card.
 * `null` when the config has no usable published price.
 *
 * Tiers keyed by request fields (`equals` criteria) become a lookup nested
 * in criterion order. Every tier must use the same criteria in the same
 * order, quote the same metrics, and together cover every combination. A
 * tier that quotes more than one metric (an output image plus each input
 * megapixel) is billed for all of them, so the card sums one
 * `quantity × rate` term per metric.
 */
export function compileReplicateBilling(
  billing: ReplicateBilling | null | undefined,
  source: RateCard['source'],
): RateCard | null {
  const tiers = billing?.current_tiers
  if (!tiers || tiers.length === 0) return null
  if (tiers.some((tier) => tier.criteria?.some((c) => c.type === 'range'))) {
    return compilePromptTiers(tiers, source)
  }

  const leaves: Array<Leaf> = []
  let keyParams: Array<string> | null = null
  for (const tier of tiers) {
    const prices = tier.prices ?? []
    if (prices.length === 0) return null
    const keys: Leaf['keys'] = []
    for (const criterion of tier.criteria ?? []) {
      const param = criterionParam(criterion.title)
      if (
        criterion.type !== 'equals' ||
        !param ||
        typeof criterion.value !== 'string' ||
        criterion.value === ''
      ) {
        return null
      }
      keys.push({ param, value: criterion.value })
    }
    const tierParams = keys.map((key) => key.param)
    if (new Set(tierParams).size !== tierParams.length) return null
    if (keyParams === null) keyParams = tierParams
    else if (tierParams.join('\0') !== keyParams.join('\0')) return null
    const tierLeaves: Array<Leaf> = []
    for (const price of prices) {
      const row = leaf(price, keys)
      if (!row || tierLeaves.some((other) => other.param === row.param)) {
        return null
      }
      tierLeaves.push(row)
    }
    leaves.push(...tierLeaves)
  }
  if (!keyParams) return null
  // Unkeyed tiers name no field to choose between them.
  if (keyParams.length === 0 && tiers.length !== 1) return null

  const params = [...new Set(leaves.map((row) => row.param))]
  const tokenParams = params.filter((param) => param.endsWith('_tokens'))
  if (tokenParams.length > 0) {
    if (tokenParams.length !== params.length || keyParams.length > 0) {
      return null
    }
    if (params.length !== leaves.length) return null
    return compileTokenCard(
      Object.fromEntries(leaves.map((row) => [row.param, row.rate])),
      [],
      source,
    )
  }

  const combos = tiers.length
  if (leaves.length !== combos * params.length) return null
  // A criterion and a metric sharing a name would be one input of two kinds.
  if (keyParams.some((param) => params.includes(param))) return null
  const keys: Array<UnitKey> = keyParams.map((param, index) => ({
    param,
    values: [...new Set(leaves.flatMap((row) => row.keys[index]?.value ?? []))],
    bound: 'usage',
  }))
  const terms: Array<{ param: string; card: RateCard; rates: number | Table }> =
    []
  for (const param of params) {
    const rows = leaves.filter((row) => row.param === param)
    if (rows.length !== combos) return null
    let rates: number | Table
    if (keys.length === 0) {
      const [row] = rows
      if (!row || rows.length !== 1) return null
      rates = row.rate
    } else {
      const table: Table = {}
      for (const row of rows) {
        let node = table
        for (const [index, key] of row.keys.entries()) {
          if (index === row.keys.length - 1) {
            if (Object.hasOwn(node, key.value)) return null
            node[key.value] = row.rate
          } else {
            const next: number | Table =
              (Object.hasOwn(node, key.value) && node[key.value]) || {}
            if (typeof next === 'number') return null
            node[key.value] = next
            node = next
          }
        }
      }
      rates = table
    }
    const card = compileUnitCard(
      { quantity: { param, bound: 'usage' }, keys, rates },
      source,
    )
    if (!card) return null
    terms.push({ param, card, rates })
  }
  const [only] = terms
  if (terms.length === 1 && only) return only.card

  // A keyed metric gets a rate table named for it, a flat one is inlined;
  // the price adds the per-metric terms.
  const lookupKeys = keys.map((key) => ({ var: key.param }))
  return {
    inputs: Object.fromEntries(
      terms.flatMap(({ card }) => Object.entries(card.inputs)),
    ),
    tables: Object.fromEntries(
      terms.flatMap(({ param, rates }) =>
        typeof rates === 'number' ? [] : [[param, rates]],
      ),
    ),
    price: {
      '+': terms.map(({ param, rates }): Expr => ({
        '*': [
          { var: param },
          typeof rates === 'number'
            ? rates
            : { lookup: { table: param, keys: lookupKeys } },
        ],
      })),
    },
    examples: [],
    source,
  }
}

/** Opens the JSON every official model page embeds. */
export const BILLING_MARKER = '{"billingConfig":'

/** `billingConfig` JSON embedded in a public model page, if the page has one. */
export function replicateBillingFromHtml(
  html: string,
): ReplicateBilling | null {
  const start = html.indexOf(BILLING_MARKER)
  if (start < 0) return null
  const parsed = parseJsonObject(html, start)
  if (!parsed || typeof parsed !== 'object') return null
  const billing = (parsed as { billingConfig?: unknown }).billingConfig
  if (!billing || typeof billing !== 'object') return null
  return billing
}

function parseJsonObject(text: string, start: number): unknown {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as unknown
        } catch {
          return null
        }
      }
    }
  }
  return null
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

/** Card for one official model page. No billing section → no card. */
export function replicatePagePricing(
  html: string,
  source: RateCard['source'],
): PricedFacts {
  const pricing = compileReplicateBilling(
    replicateBillingFromHtml(html),
    source,
  )
  if (!pricing) return {}
  return {
    pricing,
    factSources: tagDocsFacts({ pricing }, source.url, source.hash),
  }
}
