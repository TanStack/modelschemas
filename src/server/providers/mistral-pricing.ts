/**
 * Mistral prices from the docs pricing page (issue #73, unit rows #116).
 * Sections marked "Prices /M Tokens" are standard per-million rates (input,
 * cached input, output). Batch and priority live in other tabs and are not
 * in that table. A cell with a unit ("$4 /1000 Pages", "$0.003 /Min",
 * "$16 /M Chars") is a unit rate, not a token rate. A section marked with
 * another unit ("Prices /1000 Pages") gives that unit to its bare "$4"
 * cells. A row is one unit card when every priced cell names that same
 * unit. Several positive prices of that unit (input and cached pages) are
 * separate usage meters. A zero amount is not a meter. Mixed units, an
 * unknown unit, or "Free" is no card.
 *
 * The table keys docs slugs (`mistral-large-3-25-12`). The model page names
 * the API ids that slug serves (`mistral-large-2512`, `mistral-large-latest`).
 * An API id named by two slugs at different rates gets no card.
 *
 * A cell that strikes through a price (`<del>`) is a promotion. The standard
 * tier is the struck-through amount. The `<ins>` sale price is not stored.
 *
 * The same model page states modalities (one tooltip per medium), a "Max
 * output" stat when Mistral publishes one, and a pricing widget for models
 * the token table does not list. `k` and `M` on that stat are 1024, the same
 * scale the listing uses (262144 shown as 256k).
 *
 * A model Mistral drops from the pricing table keeps its page. The HTML
 * widget is often gone; the page's markdown twin still states `Pricing:`.
 * That line is the card (#543). The models overview pairs the API name
 * with the page slug, including deprecated rows the index-slug rules miss
 * (`mistral-medium-3-5` → `mistral-medium-3-5-26-04`).
 */
import {
  cardPrice,
  compileTokenCard,
  compileUnitCard,
} from '@modelschemas/rate-card'
import type { Expr, RateCard } from '@modelschemas/rate-card'

import { MISTRAL_DEPRECATIONS_URL } from './deprecations.ts'
import { tagDocsFacts } from './fact-sources.ts'
import { assertParsed, cachedDocs, mapConcurrent } from './model-facts.ts'
import { parseMistralPageTools } from './server-tools.ts'
import { fetchText, sha256Text } from './types.ts'
import type { FactSource, ModelInfo } from './types.ts'

export const MISTRAL_PRICING_URL = 'https://docs.mistral.ai/inference/pricing'
export const MISTRAL_CHANGELOG_URL =
  'https://docs.mistral.ai/resources/changelogs'
const MISTRAL_MODEL_PAGE = (slug: string) =>
  `https://docs.mistral.ai/models/${slug}`

/** A docs twin that Mistral does not publish. Any other status still throws. */
function isMissingDocsPage(error: unknown): boolean {
  return error instanceof Error && /→ 404\b/.test(error.message)
}

export interface MistralTokenRates {
  kind: 'tokens'
  rates: Record<string, number>
}

/** One billed quantity. Cached meters default to 0; the primary does not. */
export interface MistralUnitMeter {
  param: string
  /** USD per one unit (one page, one minute, one character). */
  rate: number
  default?: number
}

export interface MistralUnitRates {
  kind: 'unit'
  meters: Array<MistralUnitMeter>
}

export type MistralListedPrice = MistralTokenRates | MistralUnitRates

const UNIT_PARAMS = {
  pages: ['pages', 'cached_pages', 'output_pages'],
  audio_minutes: [
    'audio_minutes',
    'cached_audio_minutes',
    'output_audio_minutes',
  ],
  characters: ['characters', 'cached_characters', 'output_characters'],
} as const

type MistralUnit = keyof typeof UNIT_PARAMS

/** `$4 /1000 Pages`, `$0.003 /Min`, `$16 /M Chars`. `undefined` is `—`. */
function unitCell(
  cell: string,
): { unit: MistralUnit; rate: number } | null | undefined {
  if (cell === '—' || cell === '–' || cell === '-' || cell === '') {
    return undefined
  }
  const match = cell.match(
    /^\$([\d,]+(?:\.\d+)?)\s*\/\s*(?:(\d[\d,]*)\s+)?(.+)$/,
  )
  if (!match?.[1] || !match[3]) return null
  const amount = Number(match[1].replace(/,/g, ''))
  const count = match[2] ? Number(match[2].replace(/,/g, '')) : 1
  const label = match[3].trim().toLowerCase()
  const unit: MistralUnit | null =
    label === 'page' || label === 'pages'
      ? 'pages'
      : label === 'min' ||
          label === 'mins' ||
          label === 'minute' ||
          label === 'minutes'
        ? 'audio_minutes'
        : label === 'm char' || label === 'm chars' || label === 'm characters'
          ? 'characters'
          : null
  if (
    !unit ||
    !Number.isFinite(amount) ||
    !Number.isFinite(count) ||
    count <= 0
  ) {
    return null
  }
  const rate = unit === 'characters' ? amount / 1e6 / count : amount / count
  return { unit, rate }
}

function cellText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Current billed amount. A crossed-out quote cannot substitute for a sale. */
function currentCell(raw: string): string {
  const sale = [...raw.matchAll(/<ins\b[^>]*>([\s\S]*?)<\/ins>/gi)]
  if (!/<(?:del|ins)\b/i.test(raw)) return cellText(raw)
  if (sale.length !== 1) {
    throw new Error('mistral pricing: missing or repeated current sale price')
  }
  const text = cellText(sale[0]?.[1] ?? '').replace(/^Sale price:\s*/i, '')
  if (!/^\$[\d,]+(?:\.\d+)?(?:\s*\/.+)?$/.test(text)) {
    throw new Error('mistral pricing: unreadable current sale price')
  }
  return text
}

/** `$0.5` per million tokens. `undefined` is an absent lever (`—`). */
function perMillion(cell: string): number | null | undefined {
  if (cell === '—' || cell === '–' || cell === '-' || cell === '') {
    return undefined
  }
  const amount = cell.match(/^\$([\d,]+(?:\.\d+)?)$/)?.[1]
  if (amount === undefined) return null
  return Number(amount.replace(/,/g, '')) / 1e6
}

/** Input, cached input, then output. A zero amount publishes no meter. */
function unitMeters(cells: Array<string>): Array<MistralUnitMeter> | null {
  const priced: Array<MistralUnitMeter & { unit: MistralUnit }> = []
  for (const [index, column] of [1, 2, 3].entries()) {
    const parsed = unitCell(cells[column] ?? '')
    if (parsed === null) return null
    if (!parsed || parsed.rate === 0) continue
    const param = UNIT_PARAMS[parsed.unit][index]
    if (!param) return null
    priced.push({ unit: parsed.unit, param, rate: parsed.rate })
  }
  if (priced.length === 0) return null
  const unit = priced[0]?.unit
  if (!unit || priced.some((meter) => meter.unit !== unit)) return null
  return priced.map((meter, index) => ({
    param: meter.param,
    rate: meter.rate,
    ...(index > 0 ? { default: 0 } : {}),
  }))
}

/**
 * Docs slug → token or unit rates. Token sections skip a row that is not a
 * plain per-million amount. Other sections accept one unit only.
 */
export function parseMistralPricing(
  html: string,
): Map<string, MistralListedPrice> {
  const out = new Map<string, MistralListedPrice>()
  for (const section of html.split(/<h2\b[^>]*>/i).slice(1)) {
    const tokens = /Prices\s*\/\s*M Tokens/i.test(section)
    // `Prices /1000 Pages` states the unit once for bare `$4` cells.
    const unit = tokens
      ? undefined
      : section.match(/Prices\s*\/\s*([^<]+?)\s*</i)?.[1]
    const table = section.match(/<table\b[\s\S]*?<\/table>/i)?.[0] ?? ''
    for (const row of table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
      const slug = row[0].match(/href="\/models\/([^"]+)"/)?.[1]
      if (!slug || out.has(slug)) continue
      const cells = [...row[0].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
        ([, cell = '']) => currentCell(cell),
      )
      const text = cells
      if (text.some((cell) => /^free$/i.test(cell))) continue
      if (tokens) {
        const input = perMillion(text[1] ?? '')
        const cached = perMillion(text[2] ?? '')
        const output = perMillion(text[3] ?? '')
        if (input === null || cached === null || output === null) continue
        if (input === undefined) continue
        const rates: Record<string, number> = { input_tokens: input }
        if (cached !== undefined) rates.cache_read_tokens = cached
        if (output !== undefined) rates.output_tokens = output
        out.set(slug, { kind: 'tokens', rates })
        continue
      }
      const meters = unitMeters(
        unit
          ? text.map((cell) =>
              /^\$[\d,]+(?:\.\d+)?$/.test(cell) ? `${cell} /${unit}` : cell,
            )
          : text,
      )
      if (!meters) continue
      out.set(slug, { kind: 'unit', meters })
    }
  }
  return out
}

/** The card's price, to compose into a larger USD one. */
export function usdExpr(card: RateCard): Expr {
  const { currency, expr } = cardPrice(card)
  if (currency !== 'USD') {
    // Composing would drop the wrapper and read the amount as dollars.
    throw new Error(`mistral pricing: cannot extend a ${currency} card`)
  }
  return expr
}

/** The card `mistralModelPricing` stores. `null` when the row prices nothing. */
export function mistralRateCard(
  row: MistralListedPrice,
  source: RateCard['source'],
): RateCard | null {
  if (row.kind === 'tokens') return compileTokenCard(row.rates, [], source)
  const [first, ...rest] = row.meters
  if (!first || first.rate <= 0) return null
  const card = compileUnitCard(
    {
      quantity: {
        param: first.param,
        bound: 'usage',
        ...(first.default !== undefined ? { default: first.default } : {}),
      },
      rates: first.rate,
    },
    source,
  )
  if (!card || rest.length === 0) return card
  return {
    ...card,
    inputs: {
      ...card.inputs,
      ...Object.fromEntries(
        rest.map((meter) => [
          meter.param,
          {
            param: meter.param,
            bound: 'usage' as const,
            kind: 'number' as const,
            ...(meter.default !== undefined ? { default: meter.default } : {}),
          },
        ]),
      ),
    },
    price: {
      '+': [
        usdExpr(card),
        ...rest.map((meter) => ({ '*': [{ var: meter.param }, meter.rate] })),
      ],
    },
  }
}

/**
 * API ids a model page says the slug serves. The payload carries
 * `"names":["mistral-large-2512","mistral-large-latest"]`. When several
 * arrays match, the one sharing the most slug tokens wins; a tie that
 * shares nothing is no mapping.
 */
export function parseMistralApiIds(html: string, slug: string): Array<string> {
  // The page embeds the array as JSON (`"names":["id"]`) and, in the RSC
  // payload, with escaped quotes (`names\":["id"]`).
  const blocks = [
    ...html.matchAll(/"names":\[([^\]]*)\]/g),
    ...html.matchAll(/names\\":\[([^\]]*)\]/g),
  ].flatMap((match) => {
    const body = match[1] ?? ''
    const ids = [
      ...body.matchAll(/"([^"\\]+)"/g),
      ...body.matchAll(/\\"([^"\\]+)\\"/g),
    ].map(([, id = '']) => id)
    return ids.length > 0 &&
      ids.every((id) => /^[a-z0-9][a-z0-9._/-]*$/.test(id))
      ? [ids]
      : []
  })
  if (blocks.length === 0) return []
  const tokens = slug.split('-').filter((token) => token.length > 1)
  const score = (ids: Array<string>) =>
    ids.reduce(
      (total, id) =>
        total + tokens.filter((token) => id.includes(token)).length,
      0,
    )
  const ranked = [...blocks].sort((a, b) => score(b) - score(a))
  const best = ranked[0] ?? []
  const bestScore = score(best)
  if (bestScore === 0 && blocks.length > 1) return []
  return best
}

export interface MistralModalities {
  input: Array<string>
  output: Array<string>
}

/** Tooltip word → medium, in stored order. */
const MISTRAL_MEDIA: Record<string, string> = {
  text: 'text',
  image: 'image',
  audio: 'audio',
  video: 'video',
  document: 'file',
}

type Json = string | number | boolean | null | Array<Json> | JsonObject
interface JsonObject {
  [key: string]: Json
}

/** Props of an RSC element `["$", tag, key, props]`, else null. */
function rscProps(node: Json): JsonObject | null {
  if (!Array.isArray(node) || node[0] !== '$') return null
  const props = node[3]
  return typeof props === 'object' && props !== null && !Array.isArray(props)
    ? props
    : null
}

/** The page's RSC rows by id. Rows that are not JSON (text, imports) are skipped. */
function rscRows(html: string): RscRows {
  const stream = [
    ...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g),
  ]
    .map((match) => JSON.parse(match[1] ?? '""') as string)
    .join('')
  const rows = new Map<string, Json>()
  for (const line of stream.split('\n')) {
    const row = line.match(/^([0-9a-f]+):(.*)$/)
    if (!row?.[1]) continue
    try {
      rows.set(row[1], JSON.parse(row[2] ?? '') as Json)
    } catch {
      // Not a JSON row.
    }
  }
  return rows
}

/** Every node that directly follows a "Modalities" heading element. */
function modalityBlocks(node: Json, out: Array<Json> = []): Array<Json> {
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      const children = rscProps(item)?.children
      const label = Array.isArray(children) ? children.at(-1) : children
      const next = node[index + 1]
      if (label === 'Modalities' && next !== undefined) out.push(next)
      modalityBlocks(item, out)
    })
  } else if (typeof node === 'object' && node !== null) {
    for (const value of Object.values(node)) modalityBlocks(value, out)
  }
  return out
}

type RscRows = Map<string, Json>

/** A `$L<id>` reference to a row of the page, followed; anything else as is. */
function deref(rows: RscRows, node: Json): Json {
  const id = typeof node === 'string' ? node.match(/^\$L(.+)$/)?.[1] : null
  return id ? (rows.get(id) ?? node) : node
}

const isSvg = (node: Json): boolean =>
  Array.isArray(node) && node[0] === '$' && node[1] === 'svg'

/**
 * The label of every leaf of a Modalities block, references followed. The
 * block is `div`s around tooltips, plus a `div` of arrow icons. A tooltip
 * is a component with two children, an `asChild` trigger then the label
 * component. Every other leaf (a reference with no row, another component,
 * a tooltip of another shape, text, a lone icon, a node under a prop other
 * than `children`) reads as `null`, which no caller can map: a tooltip
 * this walk cannot reach must not be dropped while the rest are kept.
 */
function tooltipLabels(
  rows: RscRows,
  ref: Json,
  out: Array<string | null> = [],
): Array<string | null> {
  const node = deref(rows, ref)
  if (node === null) return out
  const props = rscProps(node)
  if (!Array.isArray(node) || (!props && node[0] === '$')) {
    out.push(null)
    return out
  }
  if (!props) {
    for (const item of node) tooltipLabels(rows, item, out)
    return out
  }
  const tag = node[1]
  const { children } = props
  if (typeof tag !== 'string' || tag.startsWith('$')) {
    const parts = Array.isArray(children)
      ? children.map((child) => deref(rows, child))
      : []
    const label =
      parts.length === 2 && rscProps(parts[0] ?? null)?.asChild === true
        ? rscProps(parts[1] ?? null)?.children
        : null
    out.push(typeof label === 'string' ? label : null)
    return out
  }
  const list =
    children === undefined
      ? []
      : Array.isArray(children) && children[0] !== '$'
        ? children
        : [children]
  // The arrows between the input and output tooltips.
  if (tag !== 'svg' && list.length > 0 && list.every(isSvg)) return out
  const nested = Object.entries(props).some(
    ([name, value]) =>
      name !== 'children' && typeof value === 'object' && value !== null,
  )
  if (tag === 'svg' || nested) {
    out.push(null)
    return out
  }
  for (const item of list) tooltipLabels(rows, item, out)
  return out
}

function blockModalities(rows: RscRows, block: Json): MistralModalities | null {
  const found = { input: new Set<string>(), output: new Set<string>() }
  for (const label of tooltipLabels(rows, block)) {
    const match = label?.match(/^(.+) (input|output)$/i)
    if (!match) return null
    const word = (match[1] ?? '').toLowerCase()
    const side = (match[2] ?? '').toLowerCase() === 'input' ? 'input' : 'output'
    // A reasoning model's marker, not a medium.
    if (word === 'reasoning' && side === 'output') continue
    const medium = MISTRAL_MEDIA[word]
    if (!medium) return null
    found[side].add(medium)
  }
  if (found.input.size === 0 || found.output.size === 0) return null
  const ordered = (have: Set<string>) =>
    Object.values(MISTRAL_MEDIA).filter((medium) => have.has(medium))
  return { input: ordered(found.input), output: ordered(found.output) }
}

/**
 * Modalities a model page states: the tooltips ("Text input", "Image
 * input", "Text output") of the block beside its "Modalities" heading, read
 * from the RSC payload. Null unless every tooltip in the block is a known
 * medium on a known side, both sides are stated, and every such block on
 * the page (it renders one per layout) says the same. A partial list would
 * read as the whole answer.
 */
export function parseMistralPageModalities(
  html: string,
): MistralModalities | null {
  const rows = rscRows(html)
  const blocks = [...rows.values()]
    .flatMap((row) => modalityBlocks(row))
    .map((block) => blockModalities(rows, block))
  const [first] = blocks
  if (!first) return null
  return blocks.every(
    (block) => JSON.stringify(block) === JSON.stringify(first),
  )
    ? first
    : null
}

/** The feature ids of a grid that follows a "Features" heading. */
function featureGrids(
  rows: RscRows,
  node: Json,
  out: Array<Array<string> | null> = [],
): Array<Array<string> | null> {
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      const heading = rscProps(rscProps(item)?.children ?? null)?.children
      const grid = rscProps(node[index + 1] ?? null)?.children
      if (heading === 'Features' && Array.isArray(grid)) {
        // Each feature is a `div` keyed by its id. Any other child, or one
        // marked disabled, makes the grid unreadable rather than shorter.
        const ids = grid.map((ref) => {
          const child = deref(rows, ref)
          const key = Array.isArray(child) ? child[2] : null
          const props = rscProps(child)
          return typeof key === 'string' &&
            props?.['aria-disabled'] === '$undefined'
            ? key
            : null
        })
        out.push(ids.every((id) => id !== null) ? ids : null)
      }
      featureGrids(rows, item, out)
    })
  } else if (typeof node === 'object' && node !== null) {
    for (const value of Object.values(node)) featureGrids(rows, value, out)
  }
  return out
}

/**
 * Feature ids a model page lists under its "Features" heading
 * (`document-qna`, `function-calling`, …), read from the RSC payload. Null
 * when the page has no such grid. A grid it cannot fully read, or grids
 * that disagree, throw: a shorter list would drop `file` from the row.
 */
export function parseMistralPageFeatures(html: string): Array<string> | null {
  const rows = rscRows(html)
  const grids = [...rows.values()].flatMap((row) => featureGrids(rows, row))
  if (grids.length === 0) return null
  const [first] = grids
  if (
    !first ||
    grids.some((grid) => JSON.stringify(grid) !== JSON.stringify(first))
  ) {
    throw new Error('mistral model page: Features grid in an unread shape')
  }
  return first
}

/**
 * A page's modalities with `file` input when it lists `document-qna`: the
 * Document QnA guide sends PDFs to such a model as `document_url` chat
 * content (#407). Without stated modalities nothing is added.
 */
export function withDocumentInput(
  modalities: MistralModalities | null,
  features: Array<string> | null,
): MistralModalities | null {
  if (!modalities || !features?.includes('document-qna')) return modalities
  if (modalities.input.includes('file')) return modalities
  return { ...modalities, input: [...modalities.input, 'file'] }
}

/** `128k` → 131072, `1M` → 1048576. Any other spelling is unreadable. */
function suffixTokens(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(k|M)$/.exec(value)
  if (!match?.[1] || !match[2]) return null
  const tokens = Number(match[1]) * (match[2] === 'M' ? 1024 * 1024 : 1024)
  return Number.isInteger(tokens) ? tokens : null
}

function statLabel(node: Json): string | null {
  const props = rscProps(node)
  const className = props?.className
  if (typeof className !== 'string' || !className.includes('uppercase')) {
    return null
  }
  const leaves: Array<string> = []
  const walk = (value: Json) => {
    if (typeof value === 'string') leaves.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(walk)
    }
  }
  walk(props?.children ?? null)
  return leaves.includes('Max output') ? 'Max output' : null
}

function statValue(node: Json): string | null {
  const props = rscProps(node)
  const className = props?.className
  if (
    typeof className !== 'string' ||
    !className.includes('text-lg font-bold font-mono text-primary-soft')
  ) {
    return null
  }
  return typeof props?.children === 'string' ? props.children : null
}

/**
 * Tokens from the "Max output" stat. Null when the page has no such stat
 * or two layouts disagree. The context stat uses the same value style and
 * is not a max-output cap.
 */
export function parseMistralPageMaxOutput(html: string): number | null {
  const values = new Set<number>()
  // A closure write does not widen `let flag = false` (stays the literal
  // `false`), so the unreadable mark lives on an object.
  const mark = { unreadable: false }
  const visit = (node: Json) => {
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length - 1; index++) {
        const current = node[index]
        const next = node[index + 1]
        if (current === undefined || next === undefined) continue
        if (statLabel(current) !== 'Max output') continue
        const raw = statValue(next)
        const tokens = raw === null ? null : suffixTokens(raw)
        if (tokens === null) mark.unreadable = true
        else values.add(tokens)
      }
      node.forEach(visit)
      return
    }
    if (typeof node === 'object' && node !== null) {
      Object.values(node).forEach(visit)
    }
  }
  for (const row of rscRows(html).values()) visit(row)
  if (mark.unreadable || values.size !== 1) return null
  return [...values][0] ?? null
}

interface WidgetMeter {
  price?: number
  originalPrice?: number
  denominator?: string
  label?: string
}

function isJsonRecord(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pricingWidgets(html: string): Array<JsonObject> {
  const found: Array<JsonObject> = []
  const visit = (node: Json) => {
    if (isJsonRecord(node)) {
      const custom =
        node.type === 'custom' &&
        typeof node.free === 'boolean' &&
        Array.isArray(node.input) &&
        Array.isArray(node.output)
      const flat =
        node.type === 'flat' &&
        typeof node.free === 'boolean' &&
        typeof node.denominator === 'string'
      if (custom || flat) found.push(node)
    }
    if (Array.isArray(node)) node.forEach(visit)
    else if (isJsonRecord(node)) Object.values(node).forEach(visit)
  }
  for (const row of rscRows(html).values()) visit(row)
  return found
}

function meterAmount(meter: WidgetMeter): number {
  const amount = meter.price
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error('mistral model page pricing: unreadable amount')
  }
  return amount
}

function priceFamily(
  denominator: string,
): 'tokens' | 'audio_minutes' | 'pages' | 'characters' | null {
  switch (denominator.trim().toLowerCase()) {
    case '/m tokens':
    case '/mtokens':
      return 'tokens'
    case '/min':
    case '/minute':
    case '/minutes':
      return 'audio_minutes'
    case '/1000 pages':
    case '/1000 page':
    case '/1000 annotated pages':
    case '/1000 annotated page':
      return 'pages'
    case '/m chars':
    case '/m char':
    case '/m characters':
      return 'characters'
    default:
      return null
  }
}

function tokenLever(
  side: 'input' | 'output',
  label: string | undefined,
): string {
  const name = (label ?? '').trim().toLowerCase()
  if (side === 'output') {
    if (name === '' || name === 'output') return 'output_tokens'
  } else if (name === 'cached input' || name === 'cached') {
    return 'cache_read_tokens'
  } else if (name === '' || name === 'input') return 'input_tokens'
  throw new Error(
    `mistral model page pricing: unknown ${side} label ${label ?? ''}`,
  )
}

function unitParam(
  unit: MistralUnit,
  side: 'input' | 'output',
  label: string | undefined,
): string {
  const cached = (label ?? '').toLowerCase().includes('cached')
  const names = UNIT_PARAMS[unit]
  // Each unit tuple is [input, cached, output], so the index is present.
  return side === 'output' ? names[2] : cached ? names[1] : names[0]
}

function widgetMeters(widget: JsonObject): Array<{
  side: 'input' | 'output'
  label?: string
  denominator: string
  amount: number
}> {
  if (widget.type === 'flat') {
    if (widget.free === true) {
      const amount =
        typeof widget.price === 'number' && Number.isFinite(widget.price)
          ? widget.price
          : 0
      if (amount > 0) {
        throw new Error(
          'mistral model page pricing: free widget has a positive price',
        )
      }
      return []
    }
    const denominator = widget.denominator
    if (typeof denominator !== 'string') {
      throw new Error('mistral model page pricing: meter has no denominator')
    }
    const amount = meterAmount(widget)
    return amount === 0 ? [] : [{ side: 'input', denominator, amount }]
  }
  const meters: Array<{
    side: 'input' | 'output'
    label?: string
    denominator: string
    amount: number
  }> = []
  for (const side of ['input', 'output'] as const) {
    const list = widget[side]
    if (!Array.isArray(list)) {
      throw new Error('mistral model page pricing: meters are not a list')
    }
    for (const item of list) {
      if (!isJsonRecord(item) || typeof item.denominator !== 'string') {
        throw new Error('mistral model page pricing: meter has no denominator')
      }
      const amount = meterAmount(item)
      if (amount < 0) {
        throw new Error('mistral model page pricing: negative amount')
      }
      if (amount === 0) continue
      meters.push({
        side,
        ...(typeof item.label === 'string' ? { label: item.label } : {}),
        denominator: item.denominator,
        amount,
      })
    }
  }
  if (widget.free === true) {
    if (meters.length > 0) {
      throw new Error(
        'mistral model page pricing: free widget has a positive price',
      )
    }
    return []
  }
  return meters
}

function listedFromMeters(
  meters: ReturnType<typeof widgetMeters>,
): MistralListedPrice | null {
  if (meters.length === 0) return null
  const tokenRates: Record<string, number> = {}
  const units: Array<{ unit: MistralUnit; param: string; rate: number }> = []
  for (const meter of meters) {
    const family = priceFamily(meter.denominator)
    if (!family) {
      throw new Error(
        `mistral model page pricing: unknown denominator ${meter.denominator}`,
      )
    }
    if (family === 'tokens') {
      const lever = tokenLever(meter.side, meter.label)
      if (tokenRates[lever] !== undefined) {
        throw new Error(`mistral model page pricing: repeated ${lever}`)
      }
      tokenRates[lever] = meter.amount / 1e6
      continue
    }
    // The native OCR widget publishes annotated pages as a distinct billed
    // quantity, not an ordinary-page rate or a surcharge on all pages.
    const annotated = /^\/1000 annotated pages?$/i.test(
      meter.denominator.trim(),
    )
    const param = annotated
      ? meter.side === 'input'
        ? 'annotated_pages'
        : 'output_annotated_pages'
      : unitParam(family, meter.side, meter.label)
    if (units.some((unit) => unit.param === param)) {
      throw new Error(`mistral model page pricing: repeated ${param}`)
    }
    const rate =
      family === 'pages'
        ? meter.amount / 1000
        : family === 'characters'
          ? meter.amount / 1e6
          : meter.amount
    units.push({ unit: family, param, rate })
  }
  if (Object.keys(tokenRates).length > 0 && units.length > 0) {
    if (units.some((unit) => unit.unit !== 'audio_minutes')) {
      throw new Error('mistral model page pricing: mixed units')
    }
    for (const unit of units) {
      if (tokenRates[unit.param] !== undefined) {
        throw new Error(`mistral model page pricing: repeated ${unit.param}`)
      }
      tokenRates[unit.param] = unit.rate
    }
    return { kind: 'tokens', rates: tokenRates }
  }
  if (Object.keys(tokenRates).length > 0) {
    return { kind: 'tokens', rates: tokenRates }
  }
  const unit = units[0]?.unit
  if (!unit || units.some((meter) => meter.unit !== unit)) {
    throw new Error('mistral model page pricing: mixed units')
  }
  return {
    kind: 'unit',
    meters: units.map((meter, index) => ({
      param: meter.param,
      rate: meter.rate,
      ...(index > 0 ? { default: 0 } : {}),
    })),
  }
}

/**
 * The model page's pricing widget. `price` is the current billed amount;
 * `originalPrice` is historical and never fills a missing price. `free` or
 * an all-zero widget is no card. Unreadable or conflicting widgets throw.
 */
export function parseMistralPagePrice(html: string): MistralListedPrice | null {
  const widgets = [
    ...new Map(
      pricingWidgets(html).map((widget) => [JSON.stringify(widget), widget]),
    ).values(),
  ]
  if (widgets.length === 0) return null
  const priced = widgets.flatMap((widget) => {
    const value = listedFromMeters(widgetMeters(widget))
    return value ? [value] : []
  })
  if (priced.length === 0) return null
  const first = JSON.stringify(priced[0])
  if (priced.some((row) => JSON.stringify(row) !== first)) {
    throw new Error('mistral model page pricing: widgets disagree')
  }
  return priced[0] ?? null
}

/**
 * The model page markdown's `Pricing:` line. One line, meters separated by
 * `;`. `Free` or an all-zero line is no card. A line that is present and
 * unreadable throws. No line is null: the HTML page was the price source.
 */
export function parseMistralMarkdownPrice(
  markdown: string,
): MistralListedPrice | null {
  const lines = [...markdown.matchAll(/^- Pricing: (.+)$/gm)].map(
    (match) => match[1]?.trim() ?? '',
  )
  if (lines.length === 0) return null
  if (lines.length > 1) {
    throw new Error('mistral model page pricing: multiple Pricing lines')
  }
  const parts = (lines[0] ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length === 0) {
    throw new Error('mistral model page pricing: empty Pricing line')
  }
  let free = false
  const meters: Array<{
    side: 'input' | 'output'
    label?: string
    denominator: string
    amount: number
  }> = []
  for (const part of parts) {
    if (/^free$/i.test(part)) {
      free = true
      continue
    }
    const match =
      /^(input|output|cached input)\s+\$([\d,]+(?:\.\d+)?)\s+(\/\S+(?:\s+\S+)*)$/i.exec(
        part,
      )
    if (!match?.[1] || !match[2] || !match[3]) {
      throw new Error(
        `mistral model page pricing: unreadable markdown meter ${JSON.stringify(part)}`,
      )
    }
    const label = match[1].toLowerCase()
    const amount = Number(match[2].replace(/,/g, ''))
    if (!Number.isFinite(amount)) {
      throw new Error(
        `mistral model page pricing: unreadable markdown meter ${JSON.stringify(part)}`,
      )
    }
    meters.push({
      side: label === 'output' ? 'output' : 'input',
      ...(label === 'cached input' ? { label: 'Cached input' } : {}),
      denominator: match[3],
      amount,
    })
  }
  if (free && meters.some((meter) => meter.amount > 0)) {
    throw new Error(
      'mistral model page pricing: free markdown line has a positive price',
    )
  }
  if (free) return null
  return listedFromMeters(meters)
}

/**
 * API name → docs slug from the models overview, current and deprecated
 * tables. A name two rows send to different slugs is omitted. An overview
 * that pairs nothing throws: the tables moved.
 */
export function parseMistralApiSlugs(markdown: string): Map<string, string> {
  const out = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const match of markdown.matchAll(
    /\|\s*\[[^\]]*\]\((\/models\/([a-z0-9-]+))\)\s*\|\s*`([^`]+)`\s*\|/g,
  )) {
    const slug = match[2]
    const id = match[3]
    if (!slug || !id) continue
    const prior = out.get(id)
    if (prior && prior !== slug) {
      ambiguous.add(id)
      continue
    }
    out.set(id, slug)
  }
  for (const id of ambiguous) out.delete(id)
  if (out.size === 0) {
    throw new Error('mistral models overview: parsed 0 API slugs')
  }
  return out
}

export interface MistralModelPage {
  slug: string
  ids: Array<string>
  hash: string
  serverTools?: Array<string>
  modalities?: MistralModalities | null
  maxOutput?: number | null
  pagePrice?: MistralListedPrice | null
  /** Set when `pagePrice` was read from the markdown twin, not the HTML widget. */
  priceUrl?: string
  priceHash?: string
  features?: Array<string> | null
  extractedAt?: string
}

/**
 * API id → rates. A priced slug with no ids throws: caching a partial map
 * would drop those models' stored cards for the cache TTL.
 */
export function indexMistralApiIds(
  bySlug: Map<string, MistralListedPrice>,
  pages: Array<MistralModelPage>,
): Map<string, MistralListedPrice> {
  const bySlugPage = new Map(pages.map((page) => [page.slug, page]))
  const missing = [...bySlug.keys()].filter(
    (slug) => (bySlugPage.get(slug)?.ids.length ?? 0) === 0,
  )
  if (missing.length > 0) {
    throw new Error(`mistral model pages: no API ids for ${missing.join(', ')}`)
  }
  const byId = new Map<string, MistralListedPrice>()
  const conflicts = new Set<string>()
  for (const page of pages) {
    const rates = bySlug.get(page.slug)
    if (!rates) continue
    const serialized = JSON.stringify(rates)
    for (const id of page.ids) {
      const prior = byId.get(id)
      if (!prior) {
        byId.set(id, rates)
        continue
      }
      if (JSON.stringify(prior) !== serialized) conflicts.add(id)
    }
  }
  for (const id of conflicts) byId.delete(id)
  return byId
}

type PricedFacts = Pick<
  ModelInfo,
  'pricing' | 'factSources' | 'serverTools' | 'modalities'
>

interface MistralStatedModalities {
  modalities: MistralModalities
  url: string
  hash: string
}

/**
 * API id → modalities its model page states. An id two pages state
 * differently gets none, like a price.
 *
 * Pages the pricing table does not link are fetched when a listed id is
 * an API name on the models overview, else when it matches one index
 * slug: the slug itself, a trailing `-MMDD` unfolded to `-MM-DD`, or the
 * id with a `labs-` prefix removed. Zero or several index matches fetch
 * nothing.
 */
export function indexMistralModalities(
  pages: Array<MistralModelPage>,
): Map<string, MistralStatedModalities> {
  const out = new Map<string, MistralStatedModalities>()
  const conflicts = new Set<string>()
  for (const page of pages) {
    if (!page.modalities) continue
    const stated = {
      modalities: page.modalities,
      url: MISTRAL_MODEL_PAGE(page.slug),
      hash: page.hash,
    }
    for (const id of page.ids) {
      const prior = out.get(id)
      if (!prior) out.set(id, stated)
      else if (
        JSON.stringify(prior.modalities) !== JSON.stringify(page.modalities)
      ) {
        conflicts.add(id)
      }
    }
  }
  for (const id of conflicts) out.delete(id)
  return out
}

interface MistralHostedTools {
  tools: Array<string>
  url: string
  hash: string
}

/** API id → tool ids named on a model page. Pages that name none are absent. */
export function indexMistralServerTools(
  pages: Array<MistralModelPage>,
): Map<string, MistralHostedTools> {
  const out = new Map<string, MistralHostedTools>()
  for (const page of pages) {
    const named = page.serverTools ?? []
    if (named.length === 0) continue
    const url = MISTRAL_MODEL_PAGE(page.slug)
    for (const id of page.ids) {
      const prior = out.get(id)
      const tools = [...new Set([...(prior?.tools ?? []), ...named])].sort()
      out.set(id, { tools, url, hash: page.hash })
    }
  }
  return out
}

/**
 * Deprecated id → successor, when the changelog says the successor is the
 * same price. OCR and Voxtral stay out of this map (issue #116).
 */
export function parseMistralSamePrice(html: string): Map<string, string> {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
  const out = new Map<string, string>()
  const pattern =
    /\(\s*([a-z0-9-]+)\s*\)\s+is deprecated[\s\S]{0,300}?Use[\s\S]{0,200}?\(\s*([a-z0-9-]+)\s*\)\s+instead, at the same price/gi
  for (const match of text.matchAll(pattern)) {
    const from = match[1]
    const to = match[2]
    if (!from || !to || from === to) continue
    if (/ocr|voxtral|embed/.test(from) || /ocr|voxtral|embed/.test(to)) {
      continue
    }
    out.set(from, to)
  }
  return out
}

export const MISTRAL_MODELS_INDEX = 'https://docs.mistral.ai/models'

const INDEX_SKIP = new Set(['overview', 'model-cards', 'model-selection-guide'])

/** Docs slugs linked from the models index. An empty parse throws. */
export function parseMistralModelIndex(html: string): Array<string> {
  const slugs = new Set<string>()
  for (const match of html.matchAll(/\/models\/([a-z0-9-]+)/g)) {
    const slug = match[1]
    if (!slug || INDEX_SKIP.has(slug) || slug.startsWith('page-')) continue
    slugs.add(slug)
  }
  return [...slugs]
}

/**
 * The one index slug a listed id is. Null when none or more than one of
 * the exact slug, the unfolded date, and the `labs-`-stripped id match.
 */
export function mistralIndexSlugFor(
  id: string,
  slugs: ReadonlySet<string>,
): string | null {
  const unfolded = id.replace(/-(\d{2})(\d{2})$/, '-$1-$2')
  const stripped = id.startsWith('labs-') ? id.slice('labs-'.length) : id
  const hits = [...new Set([id, unfolded, stripped])].filter((name) =>
    slugs.has(name),
  )
  return hits.length === 1 ? (hits[0] ?? null) : null
}

interface PageSourced<T> {
  value: T
  url: string
  hash: string
}

function indexPageField<T>(
  pages: Array<MistralModelPage>,
  read: (page: MistralModelPage) => T | null | undefined,
  source: (page: MistralModelPage) => { url: string; hash: string } = (
    page,
  ) => ({
    url: MISTRAL_MODEL_PAGE(page.slug),
    hash: page.hash,
  }),
): Map<string, PageSourced<T>> {
  const out = new Map<string, PageSourced<T>>()
  const conflicts = new Set<string>()
  for (const page of pages) {
    const value = read(page)
    if (value == null) continue
    const stated = {
      value,
      ...source(page),
    }
    const serialized = JSON.stringify(value)
    for (const id of page.ids) {
      const prior = out.get(id)
      if (!prior) out.set(id, stated)
      else if (JSON.stringify(prior.value) !== serialized) conflicts.add(id)
    }
  }
  for (const id of conflicts) out.delete(id)
  return out
}

/** Card lookup by API model id. `seen` is every id a fetched page names. */
export interface MistralPricingLookup {
  (rawId: string): PricedFacts
  seen: ReadonlySet<string>
}

export const MISTRAL_WEBSEARCH_URL =
  'https://docs.mistral.ai/studio/agents/agent-tools/websearch.md'

/**
 * The web search guide's tool ids (#409). It states the tool "allows any
 * of our models to access the web" and that it works with the
 * Conversations API (`/v1/conversations`), not Chat Completions; the ids
 * are the bullets under "There are two versions:". Without the any-model
 * sentence, the Conversations scope, or an id, it throws. Mistral's other
 * built-in tools (code interpreter, image generation, libraries) make no
 * any-model statement, so they are not read.
 */
export function parseMistralWebSearchTools(markdown: string): Array<string> {
  if (!/allows any of our models to access the web/.test(markdown)) {
    throw new Error('mistral websearch guide: no any-model statement')
  }
  if (!/work with the \[Conversations API\]/.test(markdown)) {
    throw new Error('mistral websearch guide: no Conversations API scope')
  }
  const versions = markdown.split(/^There are two versions:$/m)[1] ?? ''
  const ids = [...versions.matchAll(/^- `([a-z][a-z0-9_]*)`:/gm)].map(
    (match) => match[1] ?? '',
  )
  if (ids.length === 0) {
    throw new Error('mistral websearch guide: names no tool id')
  }
  return ids
}

/** The guide's tools for a page that lists `agents-conversations`. */
export function mistralConversationTools(
  features: Array<string> | null | undefined,
  webSearch: ReadonlyArray<string>,
): Array<string> {
  return features?.includes('agents-conversations') ? [...webSearch] : []
}

/** Card lookup by API model id. */
export async function mistralModelPricing(
  kv?: KVNamespace,
  listedIds: ReadonlyArray<string> = [],
  cached: typeof cachedDocs = cachedDocs,
): Promise<MistralPricingLookup> {
  const table = await cached(kv, MISTRAL_PRICING_URL, async () => {
    const [html, changelog] = await Promise.all([
      fetchText(MISTRAL_PRICING_URL),
      fetchText(MISTRAL_CHANGELOG_URL),
    ])
    const bySlug = parseMistralPricing(html)
    assertParsed(bySlug, 'mistral pricing page')
    return {
      bySlug: Object.fromEntries(bySlug),
      samePrice: Object.fromEntries(parseMistralSamePrice(changelog)),
      hash: await sha256Text(html),
      extractedAt: new Date().toISOString(),
    }
  })
  const bySlug = new Map(Object.entries(table.bySlug))
  const loadPage = async (slug: string): Promise<MistralModelPage> => {
    const url = MISTRAL_MODEL_PAGE(slug)
    const page = await cached(kv, url, async () => {
      const body = await fetchText(url)
      const ids = parseMistralApiIds(body, slug)
      const features = parseMistralPageFeatures(body)
      if (ids.length === 0) {
        throw new Error(`mistral model page ${slug}: parsed 0 API ids`)
      }
      let pagePrice = parseMistralPagePrice(body)
      let priceUrl: string | undefined
      let priceHash: string | undefined
      // The pricing table already priced this slug. Its page's markdown
      // is a second statement of the same card, not a replacement.
      if (!pagePrice && !bySlug.has(slug)) {
        const mdUrl = `${url}.md`
        let markdown: string | null = null
        try {
          markdown = await fetchText(mdUrl)
        } catch (error) {
          if (!isMissingDocsPage(error)) throw error
        }
        const stated = markdown ? parseMistralMarkdownPrice(markdown) : null
        if (stated && markdown) {
          pagePrice = stated
          priceUrl = mdUrl
          priceHash = await sha256Text(markdown)
        }
      }
      return {
        ids,
        hash: await sha256Text(body),
        serverTools: parseMistralPageTools(body),
        modalities: withDocumentInput(
          parseMistralPageModalities(body),
          features,
        ),
        features,
        maxOutput: parseMistralPageMaxOutput(body),
        pagePrice,
        ...(priceUrl && priceHash ? { priceUrl, priceHash } : {}),
        extractedAt: new Date().toISOString(),
      }
    })
    return { slug, ...page }
  }
  const tablePages = await mapConcurrent([...bySlug.keys()], 6, loadPage)
  const covered = new Set(tablePages.flatMap((page) => page.ids))
  const missing = listedIds.filter((id) => !covered.has(id))
  let extraSlugs: Array<string> = []
  if (missing.length > 0) {
    const overview = await cached(
      kv,
      `${MISTRAL_DEPRECATIONS_URL}#api-slugs`,
      async () => {
        const markdown = await fetchText(MISTRAL_DEPRECATIONS_URL)
        return Object.fromEntries(parseMistralApiSlugs(markdown))
      },
    )
    const apiSlugs = new Map(Object.entries(overview))
    const fromOverview = missing.flatMap((id) => {
      const slug = apiSlugs.get(id)
      return slug && !bySlug.has(slug) ? [slug] : []
    })
    const stillMissing = missing.filter((id) => {
      const slug = apiSlugs.get(id)
      return !(slug && !bySlug.has(slug))
    })
    let fromIndex: Array<string> = []
    if (stillMissing.length > 0) {
      const slugs = await cached(kv, MISTRAL_MODELS_INDEX, async () => {
        const html = await fetchText(MISTRAL_MODELS_INDEX)
        const parsed = parseMistralModelIndex(html)
        if (parsed.length === 0) {
          throw new Error('mistral models index: parsed 0 slugs')
        }
        return parsed
      })
      const index = new Set(slugs)
      fromIndex = stillMissing.flatMap((id) => {
        const slug = mistralIndexSlugFor(id, index)
        return slug && !bySlug.has(slug) ? [slug] : []
      })
    }
    extraSlugs = [...new Set([...fromOverview, ...fromIndex])]
  }
  const extraPages = await mapConcurrent(extraSlugs, 6, loadPage)
  const pages = [...tablePages, ...extraPages]
  const byId = indexMistralApiIds(bySlug, pages)
  for (const [from, to] of Object.entries(table.samePrice)) {
    const rates = byId.get(to)
    if (!rates || byId.has(from)) continue
    byId.set(from, rates)
  }
  assertParsed(byId, 'mistral model pages')
  const tools = indexMistralServerTools(pages)
  // Every page read and none states modalities is a reshaped site, not
  // a catalog without media. Throwing keeps the stored column.
  if (!pages.some((page) => page.modalities)) {
    throw new Error(
      `mistral model pages: 0 of ${String(pages.length)} state modalities`,
    )
  }
  const modalities = indexMistralModalities(pages)
  const maxOutput = indexPageField(pages, (page) => page.maxOutput)
  const pageRates = indexPageField(
    pages,
    (page) => page.pagePrice,
    (page) => ({
      url: page.priceUrl ?? MISTRAL_MODEL_PAGE(page.slug),
      hash: page.priceHash ?? page.hash,
    }),
  )
  const featured = indexPageField(pages, (page) => page.features)
  const webSearch = await cached(kv, MISTRAL_WEBSEARCH_URL, async () => {
    const markdown = await fetchText(MISTRAL_WEBSEARCH_URL)
    return {
      tools: parseMistralWebSearchTools(markdown),
      hash: await sha256Text(markdown),
    }
  })
  const seen = new Set(pages.flatMap((page) => page.ids))
  const lookup = (rawId: string): PricedFacts => {
    const tableRow = byId.get(rawId)
    const pageRow = pageRates.get(rawId)
    const row = tableRow ?? pageRow?.value
    const pricing = row
      ? mistralRateCard(
          row,
          tableRow
            ? {
                url: MISTRAL_PRICING_URL,
                hash: table.hash,
                extractedAt: table.extractedAt,
              }
            : {
                url: pageRow?.url ?? MISTRAL_PRICING_URL,
                hash: pageRow?.hash ?? table.hash,
                extractedAt:
                  pages.find((page) => page.ids.includes(rawId))?.extractedAt ??
                  table.extractedAt,
              },
        )
      : null
    const hosted = tools.get(rawId)
    const pricingFacts = pricing
      ? tagDocsFacts(
          { pricing },
          tableRow
            ? MISTRAL_PRICING_URL
            : (pageRow?.url ?? MISTRAL_PRICING_URL),
          tableRow ? table.hash : pageRow?.hash,
        )
      : {}
    const features = featured.get(rawId)
    const builtIn = mistralConversationTools(features?.value, webSearch.tools)
    const serverTools = [
      ...new Set([...(hosted?.tools ?? []), ...builtIn]),
    ].sort()
    const toolSources: Record<string, FactSource> = {}
    for (const tool of builtIn) {
      toolSources[tool] = {
        derivation: 'docs-derived',
        sourceUrl: features?.url,
        sourceHash: features?.hash,
        path: `Features.agents-conversations; ${MISTRAL_WEBSEARCH_URL} (any model, Conversations API /v1/conversations only)`,
      }
    }
    for (const tool of hosted?.tools ?? []) {
      toolSources[tool] = {
        derivation: 'docs-derived',
        sourceUrl: hosted?.url,
        sourceHash: hosted?.hash,
        path: `serverTools.${tool}`,
      }
    }
    const toolFacts = serverTools.length > 0 ? { serverTools: toolSources } : {}
    const stated = modalities.get(rawId)
    const modalityFacts = stated
      ? tagDocsFacts({ modalities: stated.modalities }, stated.url, stated.hash)
      : {}
    const cap = maxOutput.get(rawId)
    const maxFacts = cap
      ? tagDocsFacts({ maxOutput: cap.value }, cap.url, cap.hash)
      : {}
    const factSources = {
      ...pricingFacts,
      ...toolFacts,
      ...modalityFacts,
      ...maxFacts,
    }
    if (!pricing && serverTools.length === 0 && !stated && !cap) {
      return {}
    }
    return {
      ...(pricing ? { pricing } : {}),
      ...(serverTools.length > 0 ? { serverTools } : {}),
      ...(stated ? { modalities: stated.modalities } : {}),
      ...(cap ? { maxOutput: cap.value } : {}),
      ...(Object.keys(factSources).length > 0 ? { factSources } : {}),
    }
  }
  lookup.seen = seen
  return lookup
}

const ALIAS_FACTS = [
  'pricing',
  'modalities',
  'maxOutput',
  'reasoning',
  'serverTools',
] as const

/**
 * Copy a fact onto mutual listing aliases when every member that has it
 * agrees. A conflict copies nothing. The copy keeps the donor's docs URL.
 */
export function copyMistralAliasFacts(
  models: Array<ModelInfo>,
  aliases: ReadonlyMap<string, ReadonlyArray<string>>,
): void {
  const byId = new Map(models.map((model) => [model.rawId, model]))
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    const root = parent.get(id) ?? id
    if (root === id) return id
    const found = find(root)
    parent.set(id, found)
    return found
  }
  const union = (left: string, right: string) => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent.set(a, b)
  }
  const grouped = new Set<string>()
  for (const [id, names] of aliases) {
    if (!byId.has(id)) continue
    for (const other of names) {
      if (other === id || !byId.has(other)) continue
      if (!aliases.get(other)?.includes(id)) continue
      union(id, other)
      grouped.add(id)
      grouped.add(other)
    }
  }
  const groups = new Map<string, Array<string>>()
  for (const id of grouped) {
    const root = find(id)
    const group = groups.get(root) ?? []
    group.push(id)
    groups.set(root, group)
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    for (const fact of ALIAS_FACTS) {
      const donors = group.flatMap((id) => {
        const model = byId.get(id)
        return model && model[fact] != null ? [model] : []
      })
      if (donors.length === 0) continue
      const first = donors[0]
      if (!first) continue
      const serialized = JSON.stringify(first[fact])
      if (donors.some((donor) => JSON.stringify(donor[fact]) !== serialized)) {
        continue
      }
      for (const id of group) {
        const target = byId.get(id)
        if (!target || target[fact] != null) continue
        Object.assign(target, { [fact]: first[fact] })
        const source = first.factSources?.[fact]
        if (!source) continue
        target.factSources = { ...target.factSources, [fact]: source }
      }
    }
  }
}
