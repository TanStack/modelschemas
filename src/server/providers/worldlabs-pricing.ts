/**
 * World Labs API prices from https://docs.worldlabs.ai/api/pricing
 * (issue #617). Credits convert at the page's stated rate ($1.00 per
 * 1,250 credits). Draft and standard models have one total per published
 * input type. Marble 1.1 Plus totals are ranges (variable world size),
 * so that id stays unpriced. A page that prices none of the fixed models
 * throws.
 */
import { compileUnitCard } from '@modelschemas/rate-card'
import type { UnitCardSpec } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import { assertParsed, markdownTableRows } from './model-facts.ts'
import type { cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const WORLDLABS_PRICING_URL = 'https://docs.worldlabs.ai/api/pricing.md'

/**
 * Pricing-page input type (`Image (pano)`, `Text`, …). The generate body's
 * `world_prompt` is an object, and pano vs non-pano is nested `is_pano`,
 * so the evaluator cannot read this off a real request. Callers pass
 * `world_prompt_kind` on the estimate body. Omitted, `POST /v1/estimate`
 * returns `byInput`. `CARD_LEVEL_LEVERS` allows the name so the poller
 * does not refuse the card once the generate schema is bound.
 */
export const WORLDLABS_PROMPT_INPUT = 'world_prompt_kind'

const INPUTS = [
  'Image (pano)',
  'Text',
  'Image (non-pano)',
  'Multi-image',
  'Video',
] as const

const FIXED_MODELS = ['marble-1.0-draft', 'marble-1.0', 'marble-1.1'] as const

const CREDIT_RATE = /\\?\$1\.00 USD per ([\d,]+) credits/

type Total = number | 'range'

function uncomma(cell: string): string {
  return cell.replace(/,/g, '').trim()
}

function parseTotal(cell: string | undefined): Total | null {
  if (cell === undefined) return null
  const text = uncomma(cell)
  if (/^\d+$/.test(text)) return Number(text)
  if (/^\d+-\d+$/.test(text)) return 'range'
  return null
}

function section(
  page: string,
  title: string,
): { ids: Array<string>; body: string } | null {
  const marker = `#### ${title}`
  const start = page.indexOf(marker)
  if (start < 0) return null
  const after = page.slice(start)
  const next = after.indexOf('\n#### ', marker.length)
  const block = next < 0 ? after : after.slice(0, next)
  const heading = block.slice(0, block.indexOf('\n'))
  const ids = [...heading.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '')
  return { ids: ids.filter((id) => id.length > 0), body: block }
}

/** Input label → credits. Missing or unreadable cells throw. */
function inputTotals(body: string, heading: string): Map<string, Total> {
  const found = new Map<string, Total>()
  for (const row of markdownTableRows(body)) {
    const label = row[0]
    if (!label || !(INPUTS as ReadonlyArray<string>).includes(label)) continue
    const total = parseTotal(row[row.length - 1])
    if (total === null) {
      throw new Error(`worldlabs pricing: ${heading} ${label} has no total`)
    }
    found.set(label, total)
  }
  for (const label of INPUTS) {
    if (!found.has(label)) {
      throw new Error(`worldlabs pricing: ${heading} omits ${label}`)
    }
  }
  return found
}

function creditsPerDollar(page: string): number {
  const match = page.match(CREDIT_RATE)?.[1]?.replace(/,/g, '')
  const credits = match === undefined ? Number.NaN : Number(match)
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new Error('worldlabs pricing: no $1.00 credit rate')
  }
  return credits
}

function sheet(
  totals: Map<string, Total>,
  perDollar: number,
): UnitCardSpec | 'range' {
  const values = INPUTS.map((label) => totals.get(label))
  if (values.every((value) => value === 'range')) return 'range'
  if (values.some((value) => value === 'range' || typeof value !== 'number')) {
    throw new Error('worldlabs pricing: a model mixes fixed totals and ranges')
  }
  const rates: Record<string, number> = {}
  for (const label of INPUTS) {
    const credits = totals.get(label)
    if (typeof credits !== 'number') {
      throw new Error(`worldlabs pricing: ${label} is not a credit total`)
    }
    rates[label] = credits / perDollar
  }
  return {
    keys: [{ param: WORLDLABS_PROMPT_INPUT, values: [...INPUTS] }],
    rates,
  }
}

/**
 * Catalog id → unit sheet. Marble 1.1 Plus is absent while its totals are
 * ranges. Throws when the credit rate or a fixed model's table is missing.
 */
export function parseWorldlabsPricing(page: string): Map<string, UnitCardSpec> {
  const perDollar = creditsPerDollar(page)
  const sections = [
    section(page, 'Draft model totals'),
    section(page, 'Standard model totals'),
    section(page, 'Marble 1.1 Plus totals'),
  ]
  const out = new Map<string, UnitCardSpec>()
  for (const block of sections) {
    if (!block || block.ids.length === 0) {
      throw new Error('worldlabs pricing: a model totals table is missing')
    }
    const totals = inputTotals(block.body, block.ids.join(', '))
    const spec = sheet(totals, perDollar)
    for (const id of block.ids) {
      if (spec === 'range') continue
      if (out.has(id))
        throw new Error(`worldlabs pricing: ${id} is priced twice`)
      out.set(id, spec)
    }
  }
  for (const id of FIXED_MODELS) {
    if (!out.has(id)) throw new Error(`worldlabs pricing: ${id} has no card`)
  }
  return out
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

export async function worldlabsModelPricing(
  kv: KVNamespace | undefined,
  cached: typeof cachedDocs,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cached(kv, WORLDLABS_PRICING_URL, async () => {
    const source = await fetchText(WORLDLABS_PRICING_URL)
    const parsed = parseWorldlabsPricing(source)
    assertParsed(parsed, 'worldlabs pricing page')
    return {
      cards: Object.fromEntries(parsed),
      hash: await sha256Text(source),
      extractedAt: new Date().toISOString(),
    }
  })
  return (rawId) => {
    const spec = doc.cards[rawId]
    if (!spec) return {}
    const pricing = compileUnitCard(spec, {
      url: WORLDLABS_PRICING_URL,
      hash: doc.hash,
      extractedAt: doc.extractedAt,
    })
    if (!pricing) return {}
    return {
      pricing,
      factSources: tagDocsFacts({ pricing }, WORLDLABS_PRICING_URL, doc.hash),
    }
  }
}
