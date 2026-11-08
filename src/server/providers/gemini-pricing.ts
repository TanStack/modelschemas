/**
 * Gemini prices from Google's own pricing page (issues #61, #568). Google
 * publishes no pricing API, so this parses the page's Markdoc mirror: one
 * `## ` section per price, every model id linked in backticks above the
 * section's first `{% hr /%}` (siblings share the table), and the paid-tier
 * column of the section's "Standard" tab, or of its only table.
 *
 * Fail-closed: only the token rows (input / output / context caching) are
 * levers, and any priced row, qualifier or unit the parser does not
 * recognise (per-image, per-minute, per-song, date-conditional, Batch or
 * Flex tables) refuses that model rather than quoting part of its bill.
 * A page that yields no model at all throws inside `tryDocs`. The listing
 * still writes, and every row keeps its stored card (`unavailable`) until
 * the parser is taught the new page.
 */
import { compileTokenCard, compileUnitCard } from '@modelschemas/rate-card'
import type {
  RateCard,
  TokenRateTier,
  UnitCardSpec,
} from '@modelschemas/rate-card'

import {
  GEMINI_DEPRECATIONS_URL,
  geminiAutomaticRoutes,
} from './gemini-bindings.ts'
import { tagDocsFacts } from './fact-sources.ts'
import {
  assertParsed,
  docsRun,
  markdocTables,
  markdownTableRows,
  parseDay,
  tokenCount,
  tryDocs,
  unavailable,
} from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { DocsRun } from './model-facts.ts'
import type { ModelInfo } from './types.ts'

export const GEMINI_PRICING_URL = 'https://aistudio.google.com/docs/pricing.md'

/**
 * A row's lever per modality. `default` takes any price the row quotes for
 * text (Gemini sums text, image and video into one prompt-token count, so
 * one rate covering them all is the default lever); a modality named on its
 * own is priced differently and gets its own lever.
 */
interface RowLevers {
  default: string
  audio?: string
  image?: string
  video?: string
}

/** Row label → its levers. */
const ROW_LEVERS: Array<[RegExp, RowLevers]> = [
  // A trailing parenthetical names the modalities the row covers ("Input
  // price (text, image, video)"); a leading modality is a different row
  // ("Audio input price"), which this must not match.
  [
    /^input price( \([^)]*\))?$/,
    {
      default: 'input_tokens',
      audio: 'audio_tokens',
      image: 'image_tokens',
      video: 'video_tokens',
    },
  ],
  [/^text input price$/, { default: 'input_tokens' }],
  [/^image input price$/, { default: 'image_tokens' }],
  [/^audio input price$/, { default: 'audio_tokens' }],
  [/^video input price$/, { default: 'video_tokens' }],
  [
    /^output price( \([^)]*\))?$/,
    {
      default: 'output_tokens',
      audio: 'audio_output_tokens',
      image: 'image_output_tokens',
      video: 'video_output_tokens',
    },
  ],
  [
    /^context caching price$/,
    {
      default: 'cache_read_tokens',
      audio: 'audio_cache_tokens',
      image: 'image_cache_tokens',
    },
  ],
]

/** Modality words a qualifier may name, singular or plural. */
const MODALITIES: Record<string, keyof RowLevers> = {
  text: 'default',
  texts: 'default',
  thinking: 'default',
  image: 'image',
  images: 'image',
  video: 'video',
  videos: 'video',
  audio: 'audio',
}

/** Rows that are not a per-token cost of one request. */
const IGNORED_ROWS =
  /^(grounding with |used to improve|context caching \(storage\)|tuning price|live api)/

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  nbsp: ' ',
}

function plain(html: string): string {
  return (
    html
      // Footnote markers are not part of a price.
      .replace(/<sup>[\s\S]*?<\/sup>/g, '')
      // `[No](/docs/terms)` → `No`.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|`/g, '')
      // A real tag only; a bare `<=` in a qualifier must survive.
      .replace(/<\/?[a-zA-Z][^>]*>/g, '')
      .replace(/&([a-z]+|#\d+);/gi, (match, name: string) => {
        return ENTITIES[name.toLowerCase()] ?? match
      })
      .replace(/\s+/g, ' ')
      .trim()
  )
}

const DAY_MS = 86_400_000

type Fragment = {
  levers: Array<string>
  rate: number
  tier: number | null
  /** Instant this rate stops applying, for a dated price change. */
  expiresAt: number | null
}

/**
 * One `$x (qualifier)` fragment of a paid-tier cell. `null` refuses the
 * model; `[]` is a fragment that prices nothing here (storage, "not
 * available").
 */
function fragment(
  raw: string,
  levers: RowLevers,
  now: number,
  first: boolean,
): Array<Fragment> | null {
  const cell = plain(raw)
    // "$6.50 ($0.00016 per second)" / "$3.00 or $0.005/min (audio)": the
    // column is per 1M tokens, so a second amount in another unit restates
    // the token rate rather than adding to it.
    .replace(/\s*\(\s*\$[^)]*\)/g, '')
    .replace(/\s+or \$[\d.,]+\s*\/\s*\w+/gi, '')
    .trim()
  if (cell === '' || /^(not available|free of charge)$/i.test(cell)) return []
  // Cache storage is quoted per token-hour, not per request.
  if (/per hour|storage price/i.test(cell)) return []
  // "Implicit caching only (explicit caching is not supported)." scopes the
  // caching rate above it and quotes no amount.
  if (!first && /^implicit caching only\b[^$]*$/i.test(cell)) return []
  // A price in a unit other than the column's tokens: after the first
  // fragment it restates the token rate ("Equivalent to $0.134 per 1K/2K
  // image", "and $0.24 per 4K image"); as the first, it *is* the price and
  // this card has no lever for it.
  if (/equivalent|\bper \d|\bper [a-z]+\b/i.test(cell)) {
    return first ? null : []
  }
  const match = cell.match(/^\$([\d,]+(?:\.\d+)?)\s*(.*)$/)
  if (!match?.[1]) return null
  const rate = Number(match[1].replace(/,/g, '')) / 1e6
  let qualifier = (match[2] ?? '')
    .trim()
    .toLowerCase()
    // A qualifier follows the price as a parenthetical or after a comma.
    .replace(/^,\s*/, '')
    .replace(/\.$/, '')
    .trim()

  // A dated price change ("$0.75 through December 31, 2026" / "$1.50
  // starting January 1, 2027"): the rate in effect now wins and stamps the
  // card's `expiresAt`, so it is re-extracted once the change lands.
  let expiresAt: number | null = null
  const dated = qualifier.match(
    /^(.*?)\s*(through|starting) ([a-z]+ \d{1,2}, \d{4})$/,
  )
  if (dated?.[3]) {
    const day = parseDay(dated[3])
    if (day === null) return null
    const ends = dated[2] === 'through' ? day + DAY_MS : day
    if (dated[2] === 'through' ? now >= ends : now < ends) return []
    if (dated[2] === 'through') expiresAt = ends
    qualifier = (dated[1] ?? '').trim()
  }
  qualifier = qualifier.replace(/^\((.*)\)$/, '$1').trim()

  if (qualifier === '') {
    return [{ levers: [levers.default], rate, tier: null, expiresAt }]
  }
  const threshold = qualifier.match(
    /^prompts?\s*(<=|>)\s*([\d,.]+\s*[km]?)\s*(tokens?)?$/,
  )
  if (threshold) {
    const tokens = tokenCount(threshold[2])
    if (tokens === null) return null
    return [
      {
        levers: [levers.default],
        rate,
        tier: threshold[1] === '>' ? tokens : null,
        expiresAt,
      },
    ]
  }
  // "(text / image / video)", "(audio)", "(text and thinking)": every word
  // must be a modality this row prices, or the model is refused.
  const named = new Set<keyof RowLevers>()
  for (const word of qualifier.replace(/[().]/g, ' ').split(/[,/+\s]+/)) {
    const part = word.trim()
    if (part === '' || part === 'and') continue
    const modality = MODALITIES[part]
    if (!modality) return null
    named.add(modality)
  }
  if (named.size === 0) return null
  // A rate quoted for text covers the prompt-token count as a whole.
  const targets = named.has('default')
    ? ['default' as const, ...[...named].filter((m) => m === 'audio')]
    : [...named]
  const filled: Array<string> = []
  for (const modality of targets) {
    const lever = levers[modality]
    // A modality this row does not price separately (an image rate on the
    // caching row, say) would have to be guessed.
    if (!lever) return null
    filled.push(lever)
  }
  return [{ levers: filled, rate, tier: null, expiresAt }]
}

interface ParsedRates {
  base: Record<string, number>
  tiers: Record<number, Record<string, number>>
  expiresAt: number | null
}

function parseTable(
  table: Array<Array<string>>,
  now: number,
): ParsedRates | null {
  const out: ParsedRates = { base: {}, tiers: {}, expiresAt: null }
  for (const cells of table) {
    if (cells.length < 2) continue
    const label = plain(cells[0] ?? '').toLowerCase()
    if (IGNORED_ROWS.test(label)) continue
    const levers = ROW_LEVERS.find(([match]) => match.test(label))?.[1]
    if (!levers) {
      // An unrecognised row that quotes a price is a cost this card would
      // silently drop.
      if (/price|cost|\$/.test(label)) return null
      continue
    }
    const paid = cells[cells.length - 1] ?? ''
    const parts = paid.split(/<br\s*\/?>/)
    for (const [index, part = ''] of parts.entries()) {
      const parsed = fragment(part, levers, now, index === 0)
      if (!parsed) return null
      for (const { levers: filled, rate, tier, expiresAt } of parsed) {
        const target = tier === null ? out.base : (out.tiers[tier] ??= {})
        for (const lever of filled) target[lever] = rate
        if (expiresAt !== null) {
          out.expiresAt = Math.min(out.expiresAt ?? expiresAt, expiresAt)
        }
      }
    }
  }
  return out
}

/**
 * The paid-tier column states the unit every price in it is quoted in
 * ("Paid Tier, per second in USD"). Anything but tokens is a per-unit card.
 */
const UNIT_QUANTITY: Record<string, string | undefined> = {
  second: 'video_seconds',
  // "per request" rows quote the whole call ("$0.08 per song").
  request: undefined,
}

/** `720p`, `1080p`, `4k` — an output size a per-unit rate is keyed by. */
const RESOLUTION = /^\d{1,4}[pk]$/

interface UnitRow {
  label: string
  /** A flat rate, or one per resolution. */
  rates: number | Record<string, number>
}

/**
 * Rows of a per-unit table. `null` refuses the model: a price this parser
 * cannot key is worse than no card.
 */
function parseUnitRows(table: Array<Array<string>>): Array<UnitRow> | null {
  const rows: Array<UnitRow> = []
  for (const cells of table) {
    if (cells.length < 2) continue
    const label = plain(cells[0] ?? '')
    if (IGNORED_ROWS.test(label.toLowerCase())) continue
    let flat: number | null = null
    const rates: Record<string, number> = {}
    for (const part of (cells[cells.length - 1] ?? '').split(/<br\s*\/?>/)) {
      const cell = plain(part)
      if (
        cell === '' ||
        /not available|not supported|free of charge/i.test(cell)
      ) {
        continue
      }
      const match = cell.match(/^\$([\d,]+(?:\.\d+)?)\s*(.*)$/)
      if (!match?.[1]) return null
      const rate = Number(match[1].replace(/,/g, ''))
      const qualifier = (match[2] ?? '')
        .toLowerCase()
        .replace(/^\((.*)\)$/, '$1')
        .replace(/\.$/, '')
        .trim()
      // "$0.08 per song" restates the column's own unit.
      if (qualifier === '' || qualifier.startsWith('per ')) {
        if (flat !== null) return null
        flat = rate
        continue
      }
      const sizes = qualifier
        .replace(/\(|\)/g, '')
        .split(/\s+and\s+|[,/]/)
        .map((size) => size.trim())
        .filter((size) => size !== '' && !/output|supported/.test(size))
      if (sizes.length === 0 || !sizes.every((size) => RESOLUTION.test(size))) {
        return null
      }
      for (const size of sizes) rates[size] = rate
    }
    const keyed = Object.keys(rates).length > 0
    if (keyed && flat !== null) return null
    if (!keyed && flat === null) continue
    rows.push({ label, rates: keyed ? rates : (flat ?? 0) })
  }
  return rows.length > 0 ? rows : null
}

/**
 * The row that speaks for `id` when a section prices several models: the
 * one naming every token that tells this id apart from its siblings, or
 * the "standard" row for an id with no such token. An ambiguous match is
 * no card.
 */
function rowForId(
  id: string,
  ids: Array<string>,
  rows: Array<UnitRow>,
): UnitRow | undefined {
  if (rows.length === 1) return rows[0]
  const tokens = (value: string) =>
    value
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .filter(Boolean)
  const shared = new Set(
    tokens(ids[0] ?? '').filter((token) =>
      ids.every((other) => tokens(other).includes(token)),
    ),
  )
  const distinguishing = tokens(id).filter((token) => !shared.has(token))
  const wanted = distinguishing.length > 0 ? distinguishing : ['standard']
  const matched = rows.filter((row) =>
    wanted.every((token) => tokens(row.label).includes(token)),
  )
  return matched.length === 1 ? matched[0] : undefined
}

export interface GeminiRates {
  base: Record<string, number>
  tiers: Array<TokenRateTier>
  /** ISO instant a dated price change takes effect, when the page names one. */
  expiresAt?: string
  /** Set instead of `base` when the model is billed per second or request. */
  unit?: UnitCardSpec
}

/** The page's `## ` sections, tables rewritten as `| a | b |` rows. */
function sections(markdown: string): Array<string> {
  return markdocTables(markdown)
    .split(/^(?=## )/m)
    .filter((chunk) => chunk.startsWith('## '))
}

/** Ids linked in backticks above the section's first `{% hr /%}`. */
function headingIds(section: string): Array<string> {
  const end = section.indexOf('{% hr /%}')
  if (end < 0) return []
  return [
    ...section.slice(0, end).matchAll(/\[`([a-z0-9][a-z0-9.-]+)`\]\(/g),
  ].map(([, value = '']) => value)
}

/**
 * The section's first table, when it is the Standard rates: Batch, Flex
 * and Priority are later `{% tab %}`s, and a section with no tabs has one
 * table.
 */
function standardTable(section: string): Array<Array<string>> | null {
  const lines = section.split('\n')
  const start = lines.findIndex((line) => line.startsWith('|'))
  if (start < 0) return null
  let end = start
  while (lines[end]?.startsWith('|')) end++
  const tab = [
    ...lines
      .slice(0, start)
      .join('\n')
      .matchAll(/\{%\s*tab\b[^%]*title="([^"]*)"/g),
  ].at(-1)
  if (tab && tab[1] !== 'Standard') return null
  return markdownTableRows(lines.slice(start, end).join('\n'))
}

/**
 * Every id a section heading names, including sections `parseGeminiPricing`
 * refuses. A listed id missing from this is one the page no longer prices.
 * `geminiModelPricing` still copies a successor's Standard card when the
 * deprecations page says API requests are automatically routed to that id
 * (issue #497). A recommended replacement is not a rate (issue #300).
 */
export function geminiNamedIds(markdown: string): Array<string> {
  return [...new Set(sections(markdown).flatMap(headingIds))]
}

/** Model id → per-token rates parsed from its Standard table. */
export function parseGeminiPricing(
  markdown: string,
  now: number = Date.now(),
): Map<string, GeminiRates> {
  const out = new Map<string, GeminiRates>()
  for (const section of sections(markdown)) {
    const ids = headingIds(section)
    // One Standard table covers every id named in the heading
    // (`gemini-3.1-pro-preview` and `gemini-3.1-pro-preview-customtools`).
    if (ids.length === 0) continue
    if (ids.every((each) => out.has(each))) continue
    const table = standardTable(section)
    if (!table) continue
    const [header = [], ...body] = table
    const unit = header
      .at(-1)
      ?.match(/^Paid Tier, per (.+?) in USD$/)?.[1]
      ?.trim()
    if (unit !== undefined && unit !== '1M tokens') {
      if (!(unit in UNIT_QUANTITY)) continue
      const rows = parseUnitRows(body)
      if (!rows) continue
      const quantity = UNIT_QUANTITY[unit]
      for (const each of ids) {
        const row = rowForId(each, ids, rows)
        if (!row || out.has(each)) continue
        const keyed = typeof row.rates !== 'number'
        out.set(each, {
          base: {},
          tiers: [],
          unit: {
            // Duration and output size are nested under the request's
            // untyped `parameters`, so the caller states them.
            ...(quantity && {
              quantity: { param: quantity, bound: 'usage' as const },
            }),
            ...(keyed && {
              keys: [
                {
                  param: 'resolution',
                  bound: 'usage' as const,
                  values: Object.keys(row.rates),
                },
              ],
            }),
            rates: row.rates,
          },
        })
      }
      continue
    }
    const parsed = parseTable(body, now)
    if (!parsed || Object.keys(parsed.base).length === 0) continue
    const rates: GeminiRates = {
      base: parsed.base,
      tiers: Object.entries(parsed.tiers).map(([min, tierRates]) => ({
        minPromptTokens: Number(min),
        rates: { ...parsed.base, ...tierRates },
      })),
      ...(parsed.expiresAt !== null && {
        expiresAt: new Date(parsed.expiresAt).toISOString(),
      }),
    }
    for (const each of ids) {
      if (!out.has(each)) out.set(each, rates)
    }
  }
  return out
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources' | 'absent'>

/**
 * Card lookup by model id. An id no section names is `cleared`: the page
 * visibly does not price it. An id a section names but the parser refuses
 * gets nothing, so its stored card is kept and `pricing_lost` is logged.
 * A failed pricing or deprecations load is recorded on `run` and does not
 * throw: every row is `unavailable` when the price page itself failed, and
 * an id with no card of its own is `unavailable` when the routes page
 * failed, so a blip cannot clear a card that page might have routed.
 */
export async function geminiModelPricing(
  kv?: KVNamespace,
  run: DocsRun = docsRun(),
): Promise<(rawId: string) => PricedFacts> {
  const [doc, routes] = await Promise.all([
    tryDocs(run, GEMINI_PRICING_URL, (cached) =>
      cached(kv, GEMINI_PRICING_URL, async () => {
        const markdown = await fetchText(GEMINI_PRICING_URL)
        const parsed = parseGeminiPricing(markdown)
        assertParsed(parsed, 'gemini pricing page')
        return {
          rates: Object.fromEntries(parsed),
          named: geminiNamedIds(markdown),
          hash: await sha256Text(markdown),
          extractedAt: new Date().toISOString(),
        }
      }),
    ),
    // A failed fetch, or a body that is not the deprecations page, is a
    // docs failure. A real page that names no automatic route is Google
    // stating no automatic routing.
    tryDocs(run, GEMINI_DEPRECATIONS_URL, (cached) =>
      geminiAutomaticRoutes(kv, cached),
    ),
  ])
  if (!doc) return () => unavailable('pricing')
  const routeTo = new Map(Object.entries(routes ?? {}))
  const card = (rawId: string): RateCard | null => {
    const rates = doc.rates[rawId]
    if (!rates) return null
    const source = {
      url: GEMINI_PRICING_URL,
      hash: doc.hash,
      extractedAt: doc.extractedAt,
      ...(rates.expiresAt && { expiresAt: rates.expiresAt }),
    }
    return rates.unit
      ? compileUnitCard(rates.unit, source)
      : compileTokenCard(rates.base, rates.tiers, source)
  }
  const familyOf = (rawId: string) => rawId.replace(/-preview.*$/, '')
  const named = (rawId: string | undefined) =>
    rawId !== undefined && doc.named.includes(rawId)
  const priced = (pricing: RateCard, path?: string): PricedFacts => {
    const factSources = tagDocsFacts({ pricing }, GEMINI_PRICING_URL, doc.hash)
    if (path && factSources.pricing) {
      factSources.pricing = { ...factSources.pricing, path }
    }
    return { pricing, factSources }
  }
  return (rawId) => {
    // `gemini-2.5-flash-preview-09-2025` is priced by its family row.
    const family = familyOf(rawId)
    const own = card(rawId) ?? (family === rawId ? null : card(family))
    if (own) return priced(own)
    // One hop, and only when the deprecations page says requests are
    // automatically routed. The successor's own family card counts; its
    // replacement does not.
    const target = routeTo.get(rawId)
    const targetFamily = target === undefined ? undefined : familyOf(target)
    const pricedId =
      target !== undefined && card(target)
        ? target
        : targetFamily !== undefined &&
            targetFamily !== target &&
            card(targetFamily)
          ? targetFamily
          : null
    if (pricedId) {
      const pricing = card(pricedId)
      return pricing ? priced(pricing, `routed to ${pricedId}`) : {}
    }
    // Routes unread: an id with no card of its own might still be routed.
    // Keep the stored card. A page that loaded and does not name it is a clear.
    return named(rawId) || named(family) || named(target) || named(targetFamily)
      ? {}
      : routes
        ? { absent: { pricing: 'cleared' } }
        : unavailable('pricing')
  }
}
