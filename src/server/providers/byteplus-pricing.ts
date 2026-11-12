/**
 * BytePlus chat prices from the ModelArk pricing page (issue #73). The page
 * is a Lark document: `window._ROUTER_DATA` embeds `curDoc.Content`, and
 * each table is an `aceTable` of a row zone plus a column zone. Cell text
 * lives in a zone id `x{rowId}x{colId}`. Since 2026-10-23 (#462) most
 * tables sit in Standard/Flex/Batch or "Input without/with video" tabs, and
 * merged cells are listed by `mergeCellID` on their rows and columns. The
 * folded "Retiring models" section was removed on 2026-11-12 (#646); a
 * folded section is still read if one returns.
 *
 * A catalog id the page names nowhere is `cleared`: BytePlus publishes no
 * price for it, so a stored card is nulled rather than served as current.
 * An id the page names but no table prices (a row this parser cannot read)
 * keeps its stored card and logs `pricing_lost`.
 *
 * Only Standard-tab tables are read: the chat tables (the ones that quote
 * cache storage per hour) and the Audio input tables, whose audio rates
 * join the same model's chat brackets. Flex and Batch are about half of
 * Standard and are not levers. Cache storage itself is per token-hour, not per
 * request, so that column is ignored. A model quoted at off-peak and
 * peak rates gets a card whose required `pricing_period` lever picks one
 * (#411); the page states the windows, not the request. A dated catalog id uses an
 * undated page row only when exactly one page id is its prefix
 * (`dola-seed-2-1-turbo` → `dola-seed-2-1-turbo-260628`).
 *
 * Video (Seedance) and image (Seedream) tables are read too (issue #99):
 * see `parseByteplusVideo` and `parseByteplusImages`. A page missing chat,
 * video, or image rows throws. The model list's "also supports" note copies
 * a published image, video, or pixel-tier price onto that alias when the
 * pair is unambiguous (issue #117). This page has no speech table, so Seed
 * Speech stays unpriced. Seedance estimates also read frame rate and
 * output sizes from the video generation tutorial; if that page fails, the
 * cards publish without an estimate rather than failing the lookup.
 */
import { compileTokenCard, compileUnitCard } from '@modelschemas/rate-card'
import type {
  Expr,
  RateCard,
  RateCardEstimate,
  TokenRateTier,
} from '@modelschemas/rate-card'

import { errorMessage } from '#/server/errors.ts'

import { tagDocsFacts } from './fact-sources.ts'
import { parseByteplusServerTools } from './server-tools.ts'
import {
  assertParsed,
  cachedDocs,
  tryDocs,
  unavailable,
} from './model-facts.ts'
import type { DocsRun } from './model-facts.ts'
import { fetchByteplusDoc } from './byteplus-docs.ts'
import { sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const BYTEPLUS_PRICING_URL =
  'https://docs.byteplus.com/en/docs/ModelArk/1544106'

/** Seedance output sizes and frame rates (the token formula's inputs). */
export const BYTEPLUS_VIDEO_GUIDE_URL =
  'https://docs.byteplus.com/en/docs/modelark/video-generation-tutorial'

/**
 * Undated page id → its own model page. The pricing page has no row for
 * these; each page's price table quotes the one model it documents.
 * seed-translation never had a row (#411); gpt-oss-120b's was removed on
 * 2026-10-23 while its model page kept the price (#479).
 */
export const BYTEPLUS_MODEL_PAGES: Record<string, string> = {
  'seed-translation':
    'https://docs.byteplus.com/en/docs/ModelArk/recommended-models-seed-translation',
  'gpt-oss-120b':
    'https://docs.byteplus.com/en/docs/ModelArk/recommended-models-gpt-oss-120b',
}

/** "also supports" aliases. Not a price source. */
export const BYTEPLUS_MODEL_LIST_URL =
  'https://docs.byteplus.com/en/docs/ModelArk/1330310'

/** Chat-table header → request lever. Cache storage is not one. */
const LEVERS: Record<string, string> = {
  input: 'input_tokens',
  'cached input': 'cache_read_tokens',
  output: 'output_tokens',
}

/** The "Audio input" tables quote the same two headers for audio tokens. */
const AUDIO_LEVERS: Record<string, string> = {
  input: 'audio_tokens',
  'cached input': 'audio_cache_tokens',
}

interface DocOp {
  insert: string | { id?: string }
  attributes?: {
    aceTable?: string
    /** Comma-separated merged regions this row or column is part of. */
    mergeCellID?: string
    /** A tab strip: its zone lists one `tabContent` op per tab. */
    tabsZoneId?: string
    tabContent?: string
    title?: string
    /** A tab's or a folded section's own zone. */
    zoneId?: string
    [key: string]: unknown
  }
}

interface DocZone {
  ops?: Array<DocOp>
  zoneType?: string
  zoneId?: string
}

export interface ByteplusDoc {
  data: Record<string, DocZone>
}

export interface ByteplusChatRates {
  base: Record<string, number>
  tiers: Array<TokenRateTier>
}

/**
 * A model quoted at off-peak and peak rates (DeepSeek V4.1 Flash, #411).
 * The page names the peak windows in UTC+8; the card takes the period as a
 * required `pricing_period` lever, so neither rate is presented as the price.
 */
export interface ByteplusPeriodRates {
  periods: { off_peak: Record<string, number>; peak: Record<string, number> }
}

export type ByteplusTokenRates = ByteplusChatRates | ByteplusPeriodRates

const PERIOD_LABELS: Record<string, keyof ByteplusPeriodRates['periods']> = {
  'off-peak hours': 'off_peak',
  'peak hours': 'peak',
}

function zoneText(zone: DocZone | undefined): string {
  return (zone?.ops ?? [])
    .map((op) => (typeof op.insert === 'string' ? op.insert : ''))
    .join('')
    .split('\n')
    .map((line) => line.replace(/^\*\s?/, '').trim())
    .filter((line) => line !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function headerKey(cell: string): string {
  return (
    cell
      .toLowerCase()
      // Drop a trailing parenthetical unit ("(USD/M tokens)").
      .replace(/\s*\([^)]*\)\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/**
 * `[0, 128]` is the base. `(128, 256]` starts above 128K tokens. `Not
 * applicable` is an untiered base row. Anything else (peak hours) refuses.
 */
function promptFloorK(label: string): number | null {
  if (/^not applicable$/i.test(label)) return 0
  if (/^\[0,\s*[\d.]+\]$/.test(label)) return 0
  const next = label.match(/^\(([\d.]+),\s*[\d.]+\]$/)
  if (next?.[1]) return Number(next[1])
  return null
}

/**
 * USD per million tokens (the page's stated token unit), written `$0.25`
 * (the `$` is optional).
 * `undefined` is a lever the cell does not price.
 */
function usdPerMillion(cell: string): number | null | undefined {
  if (cell === '-' || cell === '') return undefined
  const usd = /^\$?(\d+(?:\.\d+)?)$/.exec(cell)?.[1]
  return usd === undefined ? null : Number(usd) / 1e6
}

interface GridCell {
  text: string
  /** The merged region this cell is part of; its text is in the first cell. */
  merge?: string
}

/**
 * A table's cells, header row first. A merged region lists its id on every
 * row and column it covers (`mergeCellID`), so a cell is in it when both
 * its row and its column carry that id.
 */
function tableGrid(
  doc: ByteplusDoc,
  spec: string,
): Array<Array<GridCell>> | null {
  const [rowId, colId] = spec.split(' ')
  const row = rowId ? doc.data[rowId] : undefined
  const col = colId ? doc.data[colId] : undefined
  if (!row || !col) return null
  const lines = (zone: DocZone) =>
    (zone.ops ?? []).flatMap((op) =>
      typeof op.insert === 'object' && op.insert.id
        ? [
            {
              id: op.insert.id,
              merges: (op.attributes?.mergeCellID ?? '')
                .split(',')
                .filter((id) => id !== ''),
            },
          ]
        : [],
    )
  const cols = lines(col)
  return lines(row).map((line) =>
    cols.map((column) => {
      const merge = line.merges.find((id) => column.merges.includes(id))
      const text = zoneText(doc.data[`x${line.id}x${column.id}`])
      return merge ? { text, merge } : { text }
    }),
  )
}

export function tableRows(
  doc: ByteplusDoc,
  spec: string,
): Array<Array<string>> | null {
  return (
    tableGrid(doc, spec)?.map((row) => row.map((cell) => cell.text)) ?? null
  )
}

interface RateColumns {
  tier: number
  /** Lever → column. */
  levers: Record<string, number>
  /** Levers a row must price to count. */
  required: Array<string>
}

/** One row's lever rates; null when a cell is unreadable or a required lever is missing. */
function rowRates(
  row: Array<string>,
  columns: RateColumns,
): Record<string, number> | null {
  const rates: Record<string, number> = {}
  for (const [lever, at] of Object.entries(columns.levers)) {
    const value = usdPerMillion(row[at] ?? '')
    if (value === null) return null
    if (value !== undefined) rates[lever] = value
  }
  return columns.required.every((lever) => rates[lever] !== undefined)
    ? rates
    : null
}

/** Exactly one off-peak and one peak row, or null. */
function periodsFromGroup(
  rows: Array<Array<string>>,
  columns: RateColumns,
): ByteplusPeriodRates | null {
  if (rows.length !== 2) return null
  const periods: Partial<ByteplusPeriodRates['periods']> = {}
  for (const row of rows) {
    const period = PERIOD_LABELS[(row[columns.tier] ?? '').toLowerCase()]
    const rates = rowRates(row, columns)
    if (!period || !rates || periods[period]) return null
    periods[period] = rates
  }
  const { off_peak, peak } = periods
  return off_peak && peak ? { periods: { off_peak, peak } } : null
}

function ratesFromGroup(
  rows: Array<Array<string>>,
  columns: RateColumns,
): ByteplusTokenRates | null {
  if (
    rows.some((row) => (row[columns.tier] ?? '').toLowerCase() in PERIOD_LABELS)
  ) {
    return periodsFromGroup(rows, columns)
  }
  const base: Record<string, number> = {}
  const tiers: Array<TokenRateTier> = []
  for (const [index, row] of rows.entries()) {
    const floor = promptFloorK(row[columns.tier] ?? '')
    if (floor === null) return null
    const rates = rowRates(row, columns)
    if (!rates) return null
    if (index === 0) {
      if (floor !== 0) return null
      Object.assign(base, rates)
      continue
    }
    if (floor <= 0) return null
    // Prompt length is the request's input. Audio is quoted per bracket
    // too, so it counts toward it when the card is compiled.
    tiers.push({ minPromptTokens: floor * 1000, rates })
  }
  return Object.keys(base).length > 0 ? { base, tiers } : null
}

interface DocTable {
  spec: string
  /** Title of the innermost tab around the table, or null outside tabs. */
  tab: string | null
}

/**
 * Tables in document order. A tab strip (`tabsZoneId`) lists one
 * `tabContent` zone per tab; a folded section ("Retiring models") is a
 * `zoneId` op. Both are read in place.
 */
function docTables(
  doc: ByteplusDoc,
  zoneId = '0',
  tab: string | null = null,
  seen = new Set<string>(),
): Array<DocTable> {
  if (seen.has(zoneId)) return []
  seen.add(zoneId)
  return (doc.data[zoneId]?.ops ?? []).flatMap((op): Array<DocTable> => {
    const attributes = op.attributes ?? {}
    if (attributes.aceTable) return [{ spec: attributes.aceTable, tab }]
    if (attributes.tabsZoneId) {
      return docTables(doc, attributes.tabsZoneId, tab, seen)
    }
    if (attributes.zoneId) {
      const title = attributes.tabContent ? (attributes.title ?? null) : tab
      return docTables(doc, attributes.zoneId, title, seen)
    }
    return []
  })
}

interface FoundTable {
  keys: Array<string>
  rows: Array<Array<string>>
  tab: string | null
}

/** Every table whose header (units stripped) names all of `required`. */
export function tablesWith(
  doc: ByteplusDoc,
  required: Array<string>,
): Array<FoundTable> {
  return docTables(doc).flatMap(({ spec, tab }) => {
    const rows = tableRows(doc, spec)
    const keys = rows?.[0]?.map(headerKey)
    if (!rows || !keys || !required.every((key) => keys.includes(key))) {
      return []
    }
    return [{ keys, rows: rows.slice(1), tab }]
  })
}

/**
 * Model id → rates, one group per id (later tier rows leave it blank).
 * `null` is a group with a cell or bracket this parser cannot read.
 */
function tableRates(
  { keys, rows }: FoundTable,
  names: Record<string, string>,
  required: Array<string>,
): Map<string, ByteplusTokenRates | null> {
  const out = new Map<string, ByteplusTokenRates | null>()
  const idAt = keys.indexOf('model id')
  const columns: RateColumns = {
    tier: keys.indexOf('prompt length'),
    levers: {},
    required,
  }
  for (const [key, lever] of Object.entries(names)) {
    const at = keys.indexOf(key)
    if (at >= 0) columns.levers[lever] = at
  }
  let current: { id: string; rows: Array<Array<string>> } | null = null
  const groups: Array<{ id: string; rows: Array<Array<string>> }> = []
  for (const row of rows) {
    const id = row[idAt] ?? ''
    if (id !== '') {
      if (current) groups.push(current)
      current = { id, rows: [row] }
    } else if (current) {
      current.rows.push(row)
    }
  }
  if (current) groups.push(current)
  for (const group of groups) {
    if (out.has(group.id)) continue
    out.set(
      group.id,
      /\s/.test(group.id) ? null : ratesFromGroup(group.rows, columns),
    )
  }
  return out
}

/** Audio rates folded into the same prompt-length brackets, or null. */
function withAudio(
  chat: ByteplusTokenRates,
  audio: ByteplusTokenRates,
): ByteplusChatRates | null {
  if ('periods' in chat || 'periods' in audio) return null
  const floors = (rates: ByteplusChatRates) =>
    rates.tiers.map((tier) => tier.minPromptTokens).join()
  if (floors(chat) !== floors(audio)) return null
  return {
    base: { ...chat.base, ...audio.base },
    tiers: chat.tiers.map((tier, index) => ({
      ...tier,
      rates: { ...tier.rates, ...audio.tiers[index]?.rates },
    })),
  }
}

/**
 * Page model id → standard online-inference rates: every Standard-tab
 * table with the chat header (Model ID, Prompt length, Input, Cached
 * input, Cache storage, Output), the folded "Retiring models" ones
 * included, plus the Audio input Standard tab's audio rates, which must
 * use the same prompt-length brackets. Flex and Batch are not levers.
 */
export function parseByteplusPricing(
  doc: ByteplusDoc,
): Map<string, ByteplusTokenRates> {
  const out = new Map<string, ByteplusTokenRates>()
  const standard = (required: Array<string>) =>
    tablesWith(doc, required).filter((table) => table.tab === 'Standard')
  const chat = standard([
    'model id',
    'prompt length',
    'input',
    'cached input',
    'cache storage',
    'output',
  ])
  for (const table of chat) {
    for (const [id, rates] of tableRates(table, LEVERS, [
      'input_tokens',
      'output_tokens',
    ])) {
      if (out.has(id)) continue
      if (rates) out.set(id, rates)
      else warnUnread('chat', id, [])
    }
  }
  const audio = standard(['model id', 'prompt length', 'input']).filter(
    (table) => !table.keys.includes('output'),
  )
  for (const table of audio) {
    for (const [id, rates] of tableRates(table, AUDIO_LEVERS, [
      'audio_tokens',
    ])) {
      const text = out.get(id)
      const merged = text && rates && withAudio(text, rates)
      if (merged) {
        out.set(id, merged)
      } else {
        // Unreadable audio, no chat row, or other brackets: no card, so
        // audio input is never left unpriced on a text-only card.
        out.delete(id)
        warnUnread('audio', id, [])
      }
    }
  }
  return out
}

/**
 * Token card priced by the caller-stated `pricing_period` (no default: the
 * request carries no clock, so the card refuses rather than pick one).
 */
export function compilePeriodCard(
  { periods }: ByteplusPeriodRates,
  source: RateCard['source'],
): RateCard {
  const levers = [
    ...new Set([
      ...Object.keys(periods.off_peak),
      ...Object.keys(periods.peak),
    ]),
  ]
  return {
    inputs: {
      pricing_period: {
        param: 'pricing_period',
        bound: 'usage',
        kind: 'enum',
        values: ['off_peak', 'peak'],
      },
      ...Object.fromEntries(
        levers.map((lever) => [
          lever,
          {
            param: lever,
            bound: 'usage',
            kind: 'number',
            ...(lever !== 'input_tokens' &&
              lever !== 'output_tokens' && { default: 0 }),
          },
        ]),
      ),
    },
    tables: { rate: periods },
    price: {
      '+': levers.map((lever): Expr => ({
        if: [
          { '>': [{ var: lever }, 0] },
          {
            '*': [
              { var: lever },
              {
                lookup: {
                  table: 'rate',
                  keys: [{ var: 'pricing_period' }, lever],
                },
              },
            ],
          },
          0,
        ],
      })),
    },
    examples: [],
    source,
  }
}

/**
 * Model-page price headers (units kept: the cells have no parentheses).
 * Where a lever lists two spellings, seed-translation writes the first and
 * gpt-oss-120b the second. "[Batch]" columns are other headers, so they
 * are never read; cache storage is per token-hour and not a lever.
 */
const MODEL_PAGE_LEVERS: Record<string, Array<string>> = {
  input_tokens: ['input usd/m tokens', 'input unit price usd/m tokens'],
  cache_read_tokens: [
    'input hits cache usd/m tokens',
    'input cache hits usd/m tokens',
  ],
  output_tokens: ['output unit price usd/m tokens'],
}

/** Lever → column; input and output required, cached input optional. */
function modelPageColumns(keys: Array<string>): Record<string, number> | null {
  const columns: Record<string, number> = {}
  for (const [lever, headers] of Object.entries(MODEL_PAGE_LEVERS)) {
    const at = keys.flatMap((key, index) =>
      headers.includes(key) ? [index] : [],
    )
    if (at.length > 1) return null
    if (at[0] !== undefined) columns[lever] = at[0]
  }
  return columns.input_tokens !== undefined &&
    columns.output_tokens !== undefined
    ? columns
    : null
}

/**
 * The single price row of a one-model doc page. Throws unless exactly one
 * table, with one row, has one input and one output column (cached input
 * optional; a lever matching two columns disqualifies the table).
 */
export function parseByteplusModelPage(
  doc: ByteplusDoc,
): Record<string, number> {
  const tables = tablesWith(doc, []).flatMap((table) => {
    const columns = modelPageColumns(table.keys)
    return columns ? [{ ...table, columns }] : []
  })
  const row = tables.length === 1 ? tables[0] : undefined
  if (!row || row.rows.length !== 1) {
    throw new Error(
      `byteplus model page: expected one price table row, found ${String(tables.length)} tables`,
    )
  }
  const rates: Record<string, number> = {}
  for (const [lever, at] of Object.entries(row.columns)) {
    const key = row.keys[at] ?? lever
    const cell = row.rows[0]?.[at] ?? ''
    const value = usdPerMillion(cell)
    if (value === null) {
      throw new Error(`byteplus model page: unreadable ${key} "${cell}"`)
    }
    if (value !== undefined) rates[lever] = value
  }
  if (rates.input_tokens === undefined || rates.output_tokens === undefined) {
    throw new Error('byteplus model page: no input or output price')
  }
  return rates
}

/**
 * Catalog id → page row. Exact id wins. Otherwise the undated page id the
 * catalog id extends with a `-YYMMDD` date — never another suffix, so
 * `seedance-1-0-pro-fast-…` cannot take an undated `seedance-1-0-pro` row.
 */
export function byteplusRatesFor<T>(
  rawId: string,
  rates: Map<string, T>,
): T | undefined {
  const exact = rates.get(rawId)
  if (exact) return exact
  const dated = rawId.match(/^(.+)-\d{6}$/)?.[1]
  return dated === undefined ? undefined : rates.get(dated)
}

/**
 * `id (also supports: alias)`, or (#468) the cell's next line `Also
 * supports alias` (seen 2026-10-23), which `zoneText` joins with one space. Cells are joined with `\n`, so that form's literal space never
 * pairs ids across cells. Capital `Also` only: prose "also supports" is
 * not a note. The alias must end at a non-id character, never mid-word.
 */
const ALSO_SUPPORTS =
  /\b([a-z0-9]+(?:-[a-z0-9]+)+)(?:\s*\(also supports:\s*([a-z0-9]+(?:-[a-z0-9]+)+)\s*\)| Also supports ([a-z0-9]+(?:-[a-z0-9]+)+)(?![\w-]))/g

/**
 * Model-list "also supports" pairs. One id named with two different
 * partners is dropped; the other pairs stay. Not a price.
 */
export function parseByteplusAliases(doc: ByteplusDoc): Map<string, string> {
  const pairs = new Map<string, string>()
  const dropped = new Set<string>()
  const text = Object.values(doc.data).map(zoneText).join('\n')
  for (const match of text.matchAll(ALSO_SUPPORTS)) {
    const primary = match[1] ?? ''
    const alias = match[2] ?? match[3] ?? ''
    if (primary === '' || primary === alias) continue
    const previous = pairs.get(primary)
    if (previous !== undefined && previous !== alias) {
      dropped.add(primary)
      continue
    }
    const claimed = [...pairs.entries()].some(
      ([other, taken]) => other !== primary && taken === alias,
    )
    if (claimed) {
      dropped.add(primary)
      continue
    }
    pairs.set(primary, alias)
  }
  for (const id of dropped) pairs.delete(id)
  return pairs
}

/**
 * Copy a price onto the unpriced side of an alias pair. Both sides priced,
 * or neither, stays as parsed. Chat rates are not passed here.
 */
export function sharePublishedAliases<T>(
  rates: Map<string, T>,
  aliases: Map<string, string>,
): void {
  for (const [primary, alias] of aliases) {
    const left = rates.get(primary)
    const right = rates.get(alias)
    if (left !== undefined && right === undefined) rates.set(alias, left)
    else if (right !== undefined && left === undefined)
      rates.set(primary, right)
  }
}

/**
 * Seedance rates, USD per million tokens: service tier (`default` online,
 * `flex` offline) → resolution (`*` when the row names none) → variant. A
 * variant is `no_video`/`video` (does the input carry a video),
 * `silent`/`audio` (`generate_audio`), or `all` when the model has one
 * rate.
 */
export type ByteplusVideoRates = Record<
  string,
  Record<string, Record<string, number>>
>

/** Video header group → service tier. */
const VIDEO_TIERS: Record<string, string> = {
  'online inference': 'default',
  'offline inference': 'flex',
}

/** Video tab title or sub-header → variant. */
const VIDEO_VARIANTS: Record<string, string> = {
  'input without video': 'no_video',
  'input with video': 'video',
  'video without audio': 'silent',
  'video with audio': 'audio',
}

/** A plain positive decimal, or `null`. */
function decimal(text: string): number | null {
  const value = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN
  return Number.isFinite(value) && value > 0 ? value : null
}

/** `$6.40` → 6.4, or `null`. */
function dollars(text: string): number | null {
  return decimal(text.replace(/^\$/, ''))
}

/** A cell's text; a merged cell takes its region's first cell in the row. */
function spanText(row: Array<GridCell>, at: number): string {
  const cell = row[at]
  if (!cell?.merge) return cell?.text ?? ''
  return row.find((other) => other.merge === cell.merge)?.text ?? ''
}

/**
 * One model row → tier → resolution → variant, or null for a cell this
 * parser cannot read. A price merged over every column of its tier is the
 * rate whatever the resolution (`*`), as is a column with no sub-header.
 */
function videoRow(
  row: Array<GridCell>,
  sub: Array<GridCell>,
  tiers: Array<string | undefined>,
  tabVariant: string | undefined,
): ByteplusVideoRates | null {
  const out: ByteplusVideoRates = {}
  for (const tier of new Set(tiers)) {
    if (!tier) continue
    const columns = tiers.flatMap((t, at) => (t === tier ? [at] : []))
    const [first = 0] = columns
    const merge = row[first]?.merge
    const whole =
      merge !== undefined && columns.every((at) => row[at]?.merge === merge)
    const priced: Record<string, Record<string, number>> = {}
    for (const at of whole ? [first] : columns) {
      const text = spanText(row, at)
      if (/^not supported/i.test(text)) continue
      const rate = dollars(text)
      if (rate === null) return null
      const label = whole ? '' : spanText(sub, at).toLowerCase()
      // A column with no sub-header names no resolution only when it is
      // its tier's one column; beside named ones it is unreadable.
      if (label === '' && !whole && columns.length > 1) return null
      const subVariant = VIDEO_VARIANTS[label]
      const resolutions =
        subVariant || label === '' ? ['*'] : (label.match(/\d+p|4k/g) ?? [])
      if (resolutions.length === 0) return null
      for (const resolution of resolutions) {
        ;(priced[resolution] ??= {})[subVariant ?? tabVariant ?? 'all'] = rate
      }
    }
    if (Object.keys(priced).length > 0) out[tier] = priced
  }
  return out
}

/**
 * Video tables: a `Model ‖ Online inference ‖ Offline inference` header
 * whose tier cells are merged over a second header row of resolutions
 * ("480p and 720p", "1080p", "4K") or of audio variants. The tab ("Input
 * without video" / "Input with video") names the video variant. One price
 * per cell, USD per million tokens; "Not supported" leaves that column
 * out. A model with any other unreadable cell, or two different prices
 * for one slot, gets no rates (and a warning). A model priced only for
 * input without video has one rate (`all`); one priced only with video
 * refuses.
 */
export function parseByteplusVideo(
  doc: ByteplusDoc,
): Map<string, ByteplusVideoRates> {
  const out = new Map<string, ByteplusVideoRates>()
  const dropped = new Set<string>()
  // Ids with an "Input with video" row, priced or "Not supported".
  const withVideoRows = new Set<string>()
  for (const { spec, tab } of docTables(doc)) {
    const grid = tableGrid(doc, spec) ?? []
    const [head = []] = grid
    if (headerKey(head[0]?.text ?? '') !== 'model') continue
    const tiers = head.map(
      (_, at) => VIDEO_TIERS[headerKey(spanText(head, at))],
    )
    if (!tiers.some(Boolean)) continue
    const hasSub = (grid[1]?.[0]?.text ?? '') === ''
    const sub = hasSub ? (grid[1] ?? []) : []
    const tabVariant = VIDEO_VARIANTS[(tab ?? '').toLowerCase()]
    for (const row of grid.slice(hasSub ? 2 : 1)) {
      const cell = row[0]?.text ?? ''
      const id = cell.split(' ')[0] ?? ''
      if (!/^[a-z0-9-]+$/.test(id)) {
        if (cell !== '') warnUnread('video', cell, [])
        continue
      }
      if (tabVariant === 'video') withVideoRows.add(id)
      const rates = videoRow(row, sub, tiers, tabVariant)
      const held = out.get(id) ?? {}
      let readable = rates !== null
      for (const [tier, byResolution] of Object.entries(rates ?? {})) {
        for (const [resolution, byVariant] of Object.entries(byResolution)) {
          for (const [variant, rate] of Object.entries(byVariant)) {
            const slot = ((held[tier] ??= {})[resolution] ??= {})
            if (slot[variant] !== undefined && slot[variant] !== rate) {
              readable = false
            }
            slot[variant] = rate
          }
        }
      }
      out.set(id, held)
      if (!readable) {
        dropped.add(id)
        warnUnread(
          'video',
          id,
          row.map((each) => each.text),
        )
      }
    }
  }
  for (const [id, rates] of out) {
    const slots = Object.values(rates).flatMap((byResolution) =>
      Object.values(byResolution),
    )
    const variants = new Set(
      slots.flatMap((byVariant) => Object.keys(byVariant)),
    )
    if (slots.length === 0) out.delete(id)
    // Video-only rates, or a with-video row that prices nothing: one rate
    // for every input would misprice video requests.
    const videoUnpriced = withVideoRows.has(id) && !variants.has('video')
    if ((variants.has('video') && !variants.has('no_video')) || videoUnpriced) {
      dropped.add(id)
      warnUnread('video', id, [])
    }
    if (variants.size !== 1 || !variants.has('no_video')) continue
    for (const byVariant of slots) {
      for (const [variant, rate] of Object.entries(byVariant)) {
        byVariant.all = rate
        delete byVariant[variant]
      }
    }
  }
  for (const id of dropped) out.delete(id)
  return out
}

interface ImageRow {
  id: string
  input: string
  output: string
  cells: Array<string>
}

/**
 * Image table rows: `Model ID ‖ Input image ‖ Output image`. Since
 * 2026-11-12 (#640) the output header carries a note line ("P is the total
 * pixel count of a single output image."), so that column is the one header
 * starting "Output image". Only the first matching table is read.
 */
function imageRows(doc: ByteplusDoc): Array<ImageRow> {
  for (const { keys, rows } of tablesWith(doc, ['model id', 'input image'])) {
    const outputs = keys.flatMap((key, at) =>
      /^output image\b/.test(key) ? [at] : [],
    )
    const [output] = outputs
    if (output === undefined || outputs.length > 1) continue
    return rows.map((cells) => ({
      id: (cells[keys.indexOf('model id')] ?? '').split(' ')[0] ?? '',
      input: (cells[keys.indexOf('input image')] ?? '').trim(),
      output: (cells[output] ?? '').trim(),
      cells,
    }))
  }
  return []
}

/**
 * Flat image rows, USD per output image (`$0.035`) with free input images.
 * Seedream 5.0 pro's pixel-tiered row is `parseByteplusPixelTiers`; any
 * other row (Seedream 5.5's paid inputs and bounded pixel tiers) is
 * unpriced and warned.
 */
export function parseByteplusImages(doc: ByteplusDoc): Map<string, number> {
  const out = new Map<string, number>()
  for (const { id, input, output, cells } of imageRows(doc)) {
    if (!/^[a-z0-9-]+$/.test(id)) continue
    const rate = dollars(output)
    if (!/^free$/i.test(input) || rate === null) {
      if (!pixelTierRates(input, output)) warnUnread('image', id, cells)
      continue
    }
    out.set(id, rate)
  }
  return out
}

/**
 * Every model-id-shaped word in the page text: hyphenated lowercase with a
 * digit. `byteplusRatesFor` over this set says whether the page still names
 * a catalog id, whatever table, note, or unreadable row it sits in.
 */
export function byteplusNamedIds(doc: ByteplusDoc): Set<string> {
  const text = Object.values(doc.data).map(zoneText).join('\n')
  return new Set(
    (text.match(/[a-z0-9]+(?:-[a-z0-9]+)+/g) ?? []).filter((id) =>
      /\d/.test(id),
    ),
  )
}

/** A priced row this parser could not read: logged so drift is visible. */
function warnUnread(table: string, id: string, row: Array<string>): void {
  console.warn(
    JSON.stringify({
      job: 'byteplus-pricing',
      skipped: id,
      table,
      cells: row,
    }),
  )
}

/**
 * Output frame rate and pixel size per Seedance model, from the video
 * generation tutorial. The page's token formula is
 * `(input s + output s) × width × height × fps / 1024`; cards apply it to
 * output seconds only, since a request with input video refuses the
 * estimate (see `compileSeedanceCard`).
 */
export interface SeedanceGeometry {
  fps: number
  /** resolution → ratio → output pixels */
  dims: Record<string, Record<string, { w: number; h: number }>>
}

/**
 * A resolution cell's note, for one display name: `true` serves it,
 * `false` does not, `null` is a note this parser cannot read. Known
 * shapes: "X and Y do not support 1080p", "Only X supports 4K".
 */
function noteServes(note: string, name: string): boolean | null {
  if (note === '') return true
  const names = (list: string) =>
    list.split(/,\s*|\s+and\s+/i).map((part) => part.trim().toLowerCase())
  const excluded = note.match(/^(.+?) (?:do|does) not support\b/i)?.[1]
  if (excluded) return !names(excluded).includes(name)
  const only = note.match(/^Only (.+?) supports?\b/i)?.[1]
  if (only) return names(only).includes(name)
  return null
}

/**
 * Two tables on the tutorial: the model table (`Model name` header row of
 * display names, a `Model ID` row, a `Frame rate` row) and the pixel table
 * (`Resolution ‖ Aspect ratio ‖ <model or "… series">…`). A pixel column
 * names one display name, or a series every display name it prefixes; a
 * model's own column beats its series. A resolution note ("… do not support
 * 1080p") limits who gets that row, and a note it cannot read drops the row.
 * Two columns of the same rank disagreeing on a size drops the model, as
 * does a repeated display name. Models missing a fact get no geometry.
 */
export function parseSeedanceGeometry(
  doc: ByteplusDoc,
): Map<string, SeedanceGeometry> {
  const out = new Map<string, SeedanceGeometry>()
  const [models] = tablesWith(doc, ['model name'])
  const [pixels] = tablesWith(doc, ['resolution', 'aspect ratio'])
  if (!models || !pixels) return out
  const row = (label: string) =>
    models.rows.find((r) => r.some((c) => c.toLowerCase() === label))
  const ids = row('model id')
  const fpsRow = row('frame rate')
  if (!ids || !fpsRow) return out

  // Display name (lowercase) → model id and fps.
  const byName = new Map<string, { id: string; fps: number }>()
  const repeated = new Set<string>()
  models.keys.forEach((name, column) => {
    const id = ids[column] ?? ''
    const fps = fpsRow[column]?.match(/^(\d+) fps$/i)?.[1]
    if (!/^[a-z0-9-]+$/.test(id) || !fps) return
    if (byName.has(name)) repeated.add(name)
    byName.set(name, { id, fps: Number(fps) })
  })
  for (const name of repeated) byName.delete(name)

  const at = (key: string) => pixels.keys.indexOf(key)
  // id|resolution|ratio → rank of the column that set it (2 own, 1 series).
  const rank = new Map<string, number>()
  const conflicted = new Set<string>()
  let resolution = ''
  let note = ''
  for (const cells of pixels.rows) {
    const label = (cells[at('resolution')] ?? '').trim()
    if (label) {
      const [first = '', ...rest] = label.split(' ')
      resolution = first.toLowerCase()
      note = rest.join(' ')
    }
    const ratio = cells[at('aspect ratio')] ?? ''
    if (!/^(\d+p|4k)$/.test(resolution) || !/^\d+:\d+$/.test(ratio)) continue
    pixels.keys.forEach((column, index) => {
      const size = cells[index]?.match(/^(\d+)×(\d+)$/)
      if (!size) return
      const series = column.replace(/ series$/, '')
      for (const [name, model] of byName) {
        const own = name === column
        const inSeries =
          series !== column &&
          (name === series || name.startsWith(`${series} `))
        if (!own && !inSeries) continue
        if (noteServes(note, name) !== true) continue
        const key = `${model.id}|${resolution}|${ratio}`
        const level = own ? 2 : 1
        const geometry = out.get(model.id) ?? { fps: model.fps, dims: {} }
        const byRatio = (geometry.dims[resolution] ??= {})
        const size2 = { w: Number(size[1]), h: Number(size[2]) }
        const prior = rank.get(key) ?? 0
        if (prior > level) continue
        const held = byRatio[ratio]
        if (
          prior === level &&
          held &&
          (held.w !== size2.w || held.h !== size2.h)
        ) {
          conflicted.add(model.id)
        }
        byRatio[ratio] = size2
        rank.set(key, level)
        out.set(model.id, geometry)
      }
    })
  }
  for (const id of conflicted) out.delete(id)
  return out
}

/** Seedream 5.0 pro: per-image output rates split at a pixel count. */
export interface ByteplusPixelTiers {
  /** USD per input image after the first (the first is free). */
  extraInput: number
  /** Tier boundary in pixels; at or below it is `low`. */
  maxLowPixels: number
  /** The largest `size` level the page puts in the low tier (`1.5K`). */
  lowLevel: string
  low: number
  high: number
}

const PIXEL_TIER_INPUT =
  /^First image: Free From the second image: \$([\d.]+)(?: Pricing varies by image generation scenario\.)?$/i
// Layer decomposition is not read: the page says one request's layers can
// land in different tiers, so the card refuses that mode.
const PIXEL_TIER_OUTPUT =
  /^Single-image generation: P ≤ ([\d.]+) million \(([\d.]+)K or lower\): \$([\d.]+) P > \1 million \(higher than \2K\): \$([\d.]+) Layer decomposition: /i

/** One image-table row as pixel tiers, or null for any other wording. */
function pixelTierRates(
  input: string,
  output: string,
): ByteplusPixelTiers | null {
  const inMatch = PIXEL_TIER_INPUT.exec(input)
  const outMatch = PIXEL_TIER_OUTPUT.exec(output)
  if (!inMatch || !outMatch) return null
  const extraInput = decimal(inMatch[1] ?? '')
  const millions = decimal(outMatch[1] ?? '')
  const low = decimal(outMatch[3] ?? '')
  const high = decimal(outMatch[4] ?? '')
  if (extraInput === null || millions === null || low === null) return null
  if (high === null) return null
  const lowLevel = `${outMatch[2]}K`
  return { extraInput, maxLowPixels: millions * 1e6, lowLevel, low, high }
}

/** The image table's pixel-tiered rows; only the first table is read. */
export function parseByteplusPixelTiers(
  doc: ByteplusDoc,
): Map<string, ByteplusPixelTiers> {
  const out = new Map<string, ByteplusPixelTiers>()
  for (const { id, input, output } of imageRows(doc)) {
    const rates = pixelTierRates(input, output)
    if (/^[a-z0-9-]+$/.test(id) && rates) out.set(id, rates)
  }
  return out
}

/**
 * Ark's `size` levels for Seedream 5.0 pro image generation (Image
 * generation API, docs.byteplus.com/en/docs/ModelArk/1541523; default
 * `2K`). The model picks the pixels, but every size that API doc lists for
 * a level sits on one side of 2.61 MP, as the pricing page's "(1.5K or
 * lower)" says. `4K` and `auto` are not image-generation sizes.
 */
const SEEDREAM_PRO_LEVELS = ['1K', '1.5K', '2K']

/**
 * `usage.generated_images × tier rate + max(0, usage.input_images − 1) ×
 * input fee`.
 * `size` is a level (tier from the page's "(1.5K or lower)") or `WxH`
 * (tier from its pixel count). `layer_decomposition: true` refuses: its
 * layers are billed per layer at each one's own tier, which no request
 * field fixes.
 */
export function compileSeedreamProCard(
  rates: ByteplusPixelTiers,
  source: RateCard['source'],
): RateCard | null {
  const levelNumber = (level: string) => Number(level.replace(/K$/, ''))
  const boundary = levelNumber(rates.lowLevel)
  if (!SEEDREAM_PRO_LEVELS.includes(rates.lowLevel)) return null
  const levelTier: Array<Expr> = SEEDREAM_PRO_LEVELS.flatMap((level) => [
    { '==': [{ var: 'size.level' }, level] },
    levelNumber(level) <= boundary ? 'low' : 'high',
  ])
  const pixels = { '*': [{ var: 'size.width' }, { var: 'size.height' }] }
  const tier: Expr = {
    if: [
      { missing: 'size.level' },
      { if: [{ '<=': [pixels, rates.maxLowPixels] }, 'low', 'high'] },
      { if: levelTier },
    ],
  }
  const mode: Expr = {
    if: [{ var: 'layer_decomposition' }, 'layer_decomposition', 'generation'],
  }
  return {
    inputs: {
      size: {
        param: 'size',
        kind: 'dimensions',
        levels: SEEDREAM_PRO_LEVELS,
        default: '2K',
      },
      layer_decomposition: {
        param: 'layer_decomposition',
        kind: 'boolean',
        default: false,
      },
      // Ark's own count of the request's images: `image` is a string or a
      // list, and the bill counts what Ark received. Live 2026-10-02: no
      // image → 0, a string → 1, a list of 3 → 3.
      input_images: { param: 'input_images', bound: 'usage', kind: 'number' },
      generated_images: {
        param: 'generated_images',
        bound: 'usage',
        kind: 'number',
      },
    },
    tables: { output: { generation: { low: rates.low, high: rates.high } } },
    price: {
      '+': [
        {
          '*': [
            { var: 'generated_images' },
            { lookup: { table: 'output', keys: [mode, tier] } },
          ],
        },
        {
          '*': [
            { max: [0, { '-': [{ var: 'input_images' }, 1] }] },
            rates.extraInput,
          ],
        },
      ],
    },
    examples: [],
    source,
  }
}

/**
 * `rate × usage.completion_tokens / 1e6`. The page bills "Token unit price ×
 * Token consumption" and says consumption is what `usage.completion_tokens`
 * returns, so that is the price as billed.
 *
 * With `geometry`, an omitted `completion_tokens` is estimated by the
 * page's own formula over the tutorial's published sizes, and the estimate
 * endpoint labels it as such. The estimate refuses where the published
 * method does not hold: draft renders, `ratio: adaptive`, and any
 * resolution × ratio the tutorial does not list.
 *
 * When `videoMinimums` is set, an input video uses
 * `max(input seconds, minimum input for that output length) + output`.
 * The minimum input seconds are the Lark table's (output 4–15 for 2.0,
 * 4–30 for 2.5): `output - floor((output - 3) / 3) - 1`. Every pasted
 * minimum-token cell equals that length times the row's width, height,
 * and 24 fps, divided by 1024 and rounded. The cron still cannot read
 * the Lark base, so a duration the table does not list refuses.
 *
 * Draft refuses outright on resolution-priced models: the page bills a draft
 * at a different resolution than the request names. Video input is not a
 * request field Ark exposes as one value (it rides in `content`), so the
 * caller states it as `usage.input_video`. Only models whose rates split on
 * video input take it.
 */
/**
 * Minimum input seconds for one output duration, from the Seedance 2.0 and
 * 2.5 Lark tables. Same series on both: 3s in for 4s out, 4s in for 5s out,
 * 20s in for 30s out.
 */
export function seedanceMinInputSeconds(output: number): number {
  return output - Math.floor((output - 3) / 3) - 1
}

export function compileSeedanceCard(
  rates: ByteplusVideoRates,
  source: RateCard['source'],
  geometry?: {
    model: SeedanceGeometry
    url: string
    hash: string
    /** Last output duration the Lark minimum-token table publishes. */
    videoMinimumsThrough?: number
  },
): RateCard | null {
  const online = rates.default
  if (!online) return null
  const resolutions = Object.keys(online)
  const variants = Object.keys(online[resolutions[0] ?? ''] ?? {})
  // Every tier prices the same resolutions, each with the same variants.
  const shape = (tier: Record<string, Record<string, number>>) =>
    Object.keys(tier).sort().join() === [...resolutions].sort().join() &&
    Object.values(tier).every(
      (v) => Object.keys(v).sort().join() === [...variants].sort().join(),
    )
  if (!Object.values(rates).every(shape)) return null

  const inputs: RateCard['inputs'] = {
    // Ark's own defaults: omitted means online inference, not a draft.
    service_tier: {
      param: 'service_tier',
      kind: 'enum',
      values: Object.keys(rates),
      default: 'default',
    },
    draft: { param: 'draft', kind: 'boolean', default: false },
    completion_tokens: {
      param: 'completion_tokens',
      bound: 'usage',
      kind: 'number',
    },
  }
  let resolution: Expr = '*'
  if (!resolutions.includes('*')) {
    inputs.resolution = {
      param: 'resolution',
      kind: 'enum',
      values: resolutions,
    }
    resolution = { if: [{ var: 'draft' }, 'draft', { var: 'resolution' }] }
  }
  let variant: Expr = 'all'
  let inputVideo: Expr = 'no_input_video'
  if (variants.includes('video')) {
    inputs.input_video = {
      param: 'input_video',
      bound: 'usage',
      kind: 'boolean',
    }
    variant = { if: [{ var: 'input_video' }, 'video', 'no_video'] }
    inputVideo = {
      if: [{ var: 'input_video' }, 'input_video', 'no_input_video'],
    }
  } else if (variants.includes('audio')) {
    inputs.generate_audio = { param: 'generate_audio', kind: 'boolean' }
    variant = { if: [{ var: 'generate_audio' }, 'audio', 'silent'] }
  }

  const tables: RateCard['tables'] = { rate: rates }
  if (geometry && inputs.completion_tokens?.kind === 'number') {
    // A series column also lists resolutions a member does not serve
    // ("2.0 Fast and Mini do not support 1080p"); the rate table is the
    // model's own list.
    const dims = inputs.resolution
      ? Object.fromEntries(
          Object.entries(geometry.model.dims).filter(([r]) =>
            resolutions.includes(r),
          ),
        )
      : geometry.model.dims
    const ratios = [...new Set(Object.values(dims).flatMap(Object.keys))]
    const through = geometry.videoMinimumsThrough
    const minInput =
      through === undefined || !variants.includes('video')
        ? undefined
        : Object.fromEntries(
            Array.from({ length: through - 3 }, (_, i) => {
              const output = i + 4
              return [String(output), seedanceMinInputSeconds(output)]
            }),
          )
    const estimateInputs: RateCardEstimate['inputs'] = {
      ratio: { param: 'ratio', kind: 'enum', values: ratios },
      duration: { param: 'duration', kind: 'number' },
    }
    if (minInput) {
      estimateInputs.input_video_duration = {
        param: 'input_video_duration',
        kind: 'number',
        default: 0,
      }
    }
    if (!inputs.resolution) {
      estimateInputs.resolution = {
        param: 'resolution',
        kind: 'enum',
        values: Object.keys(dims),
      }
    }
    const side = (key: 'w' | 'h'): Expr => ({
      lookup: {
        table: 'pixels',
        keys: [{ var: 'resolution' }, { var: 'ratio' }, key],
      },
    })
    tables.pixels = dims
    if (minInput) tables.min_input_seconds = minInput
    // Shapes the published method covers; any other key refuses.
    tables.estimate_supported = minInput
      ? { no_input_video: { not_draft: 1 }, input_video: { not_draft: 1 } }
      : { no_input_video: { not_draft: 1 } }
    const seconds: Expr = minInput
      ? {
          if: [
            { var: 'input_video' },
            {
              '+': [
                {
                  max: [
                    { var: 'input_video_duration' },
                    {
                      lookup: {
                        table: 'min_input_seconds',
                        keys: [{ var: 'duration' }],
                      },
                    },
                  ],
                },
                { var: 'duration' },
              ],
            },
            { var: 'duration' },
          ],
        }
      : { var: 'duration' }
    inputs.completion_tokens.estimate = {
      inputs: estimateInputs,
      value: {
        '*': [
          {
            lookup: {
              table: 'estimate_supported',
              keys: [
                inputVideo,
                { if: [{ var: 'draft' }, 'draft', 'not_draft'] },
              ],
            },
          },
          {
            '/': [
              {
                '*': [seconds, side('w'), side('h'), geometry.model.fps],
              },
              1024,
            ],
          },
        ],
      },
      source: { url: geometry.url, hash: geometry.hash },
    }
  }
  return {
    inputs,
    tables,
    price: {
      '/': [
        {
          '*': [
            {
              lookup: {
                table: 'rate',
                keys: [{ var: 'service_tier' }, resolution, variant],
              },
            },
            { var: 'completion_tokens' },
          ],
        },
        1_000_000,
      ],
    },
    examples: [],
    source,
  }
}

/** Standard-table rates from the pricing page HTML. */
export function parseByteplusPricingPage(
  html: string,
): Map<string, ByteplusTokenRates> {
  return parseByteplusPricing(JSON.parse(pricingContent(html)) as ByteplusDoc)
}

/**
 * `curDoc.Content` only. The page shell around it reshuffles between
 * fetches, so hashing the HTML would mark unchanged prices as new.
 */
export function pricingContent(
  html: string,
  label = 'byteplus pricing page',
): string {
  const at = html.indexOf('window._ROUTER_DATA')
  const start = html.indexOf('{', at)
  const end = html.indexOf('</script>', start)
  if (at < 0 || start < 0 || end < 0) {
    throw new Error(`${label}: no _ROUTER_DATA`)
  }
  const router = JSON.parse(html.slice(start, end)) as {
    loaderData?: Record<string, { curDoc?: { Content?: string } } | null>
  }
  const content = Object.values(router.loaderData ?? {}).find(
    (entry) => typeof entry?.curDoc?.Content === 'string',
  )?.curDoc?.Content
  if (!content) throw new Error(`${label}: no curDoc.Content`)
  return content
}

type PricedFacts = Pick<
  ModelInfo,
  'pricing' | 'factSources' | 'serverTools' | 'absent'
>

interface CachedModelPage {
  rates: Record<string, number>
  hash: string
  extractedAt: string
}

/** One model page, or null (counted in `run`) when it fails. */
function modelPage(
  run: DocsRun,
  url: string,
  kv?: KVNamespace,
): Promise<CachedModelPage | null> {
  return tryDocs(run, url, (cached) =>
    cached<CachedModelPage>(kv, url, async () => {
      const content = pricingContent(
        await fetchByteplusDoc(url),
        `byteplus model page ${url}`,
      )
      return {
        rates: parseByteplusModelPage(JSON.parse(content) as ByteplusDoc),
        hash: await sha256Text(content),
        extractedAt: new Date().toISOString(),
      }
    }),
  )
}

interface CachedPricing {
  rates: Record<string, ByteplusTokenRates>
  video: Record<string, ByteplusVideoRates>
  images: Record<string, number>
  // Absent on entries cached before #102.
  pixelTiers?: Record<string, ByteplusPixelTiers>
  serverTools?: Record<string, Array<string>>
  /** Ids the page text names (`byteplusNamedIds`). */
  named: Array<string>
  hash: string
  extractedAt: string
}

interface CachedGuide {
  geometry: Record<string, SeedanceGeometry>
  hash: string
}

/**
 * Tutorial geometry, or none: it only feeds the labelled estimate, so a
 * failed fetch or parse publishes billed-only cards rather than failing
 * every BytePlus price with it.
 */
async function seedanceGuide(kv?: KVNamespace): Promise<CachedGuide | null> {
  const label = 'byteplus video generation tutorial'
  try {
    return await cachedDocs<CachedGuide>(
      kv,
      BYTEPLUS_VIDEO_GUIDE_URL,
      async () => {
        const content = pricingContent(
          await fetchByteplusDoc(BYTEPLUS_VIDEO_GUIDE_URL),
          label,
        )
        const parsed = parseSeedanceGeometry(JSON.parse(content) as ByteplusDoc)
        assertParsed(parsed, label)
        return {
          geometry: Object.fromEntries(parsed),
          hash: await sha256Text(content),
        }
      },
    )
  } catch (error) {
    console.warn(
      JSON.stringify({
        job: 'byteplus-pricing',
        skipped: 'seedance estimates',
        error: errorMessage(error),
      }),
    )
    return null
  }
}

/**
 * Model-list document, or none. It only names aliases for prices the
 * pricing page already published, so a failed fetch still prices those rows.
 */
async function modelListContent(): Promise<string | null> {
  const label = 'byteplus model list'
  try {
    return pricingContent(
      await fetchByteplusDoc(BYTEPLUS_MODEL_LIST_URL),
      label,
    )
  } catch (error) {
    console.warn(
      JSON.stringify({
        job: 'byteplus-pricing',
        skipped: 'model list aliases',
        error: errorMessage(error),
      }),
    )
    return null
  }
}

/**
 * Card lookup by catalog id. An id the page does not name is `cleared`; an
 * id it names but no table prices gets nothing (stored card kept,
 * `pricing_lost`). The page failing to load or parse throws before either.
 */
export async function byteplusModelPricing(
  run: DocsRun,
  kv?: KVNamespace,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cachedDocs<CachedPricing>(
    kv,
    BYTEPLUS_PRICING_URL,
    async () => {
      const html = await fetchByteplusDoc(BYTEPLUS_PRICING_URL)
      const content = pricingContent(html)
      const page = JSON.parse(content) as ByteplusDoc
      const parsed = parseByteplusPricing(page)
      const video = parseByteplusVideo(page)
      const images = parseByteplusImages(page)
      const pixelTiers = parseByteplusPixelTiers(page)
      assertParsed(parsed, 'byteplus pricing page')
      assertParsed(video, 'byteplus pricing page (video)')
      assertParsed(images, 'byteplus pricing page (images)')
      const listContent = await modelListContent()
      const aliases = listContent
        ? parseByteplusAliases(JSON.parse(listContent) as ByteplusDoc)
        : new Map<string, string>()
      // Alias notes are not chat prices. A dated snapshot with no row stays
      // unpriced; only the published "also supports" pair is copied.
      sharePublishedAliases(video, aliases)
      sharePublishedAliases(images, aliases)
      sharePublishedAliases(pixelTiers, aliases)
      return {
        rates: Object.fromEntries(parsed),
        video: Object.fromEntries(video),
        images: Object.fromEntries(images),
        pixelTiers: Object.fromEntries(pixelTiers),
        serverTools: Object.fromEntries(parseByteplusServerTools(html)),
        named: [...byteplusNamedIds(page)],
        hash: await sha256Text(listContent ? content + listContent : content),
        extractedAt: new Date().toISOString(),
      }
    },
  )
  const guide = await seedanceGuide(kv)
  const pages = new Map(
    await Promise.all(
      Object.entries(BYTEPLUS_MODEL_PAGES).map(
        async ([id, url]) =>
          [id, { url, page: await modelPage(run, url, kv) }] as const,
      ),
    ),
  )
  const geometry = new Map(Object.entries(guide?.geometry ?? {}))
  const rates = new Map(Object.entries(doc.rates))
  const video = new Map(Object.entries(doc.video))
  const images = new Map(Object.entries(doc.images))
  const pixelTiers = new Map(Object.entries(doc.pixelTiers ?? {}))
  const named = new Map(doc.named.map((id) => [id, true]))
  const source = {
    url: BYTEPLUS_PRICING_URL,
    hash: doc.hash,
    extractedAt: doc.extractedAt,
  }
  const card = (rawId: string): RateCard | null => {
    const chat = byteplusRatesFor(rawId, rates)
    if (chat && 'periods' in chat) return compilePeriodCard(chat, source)
    if (chat) {
      return compileTokenCard(chat.base, chat.tiers, source, {
        extraPromptLevers: ['audio_tokens', 'audio_cache_tokens'],
      })
    }
    const seedance = byteplusRatesFor(rawId, video)
    if (seedance) {
      const model = byteplusRatesFor(rawId, geometry)
      return compileSeedanceCard(
        seedance,
        source,
        model && guide
          ? {
              model,
              url: BYTEPLUS_VIDEO_GUIDE_URL,
              hash: guide.hash,
              // Lark minimum-token table: 2.5 publishes outputs 4–30,
              // 2.0 publishes 4–15. Other video models have no table.
              videoMinimumsThrough: rawId.includes('seedance-2-5')
                ? 30
                : rawId.includes('seedance-2-0')
                  ? 15
                  : undefined,
            }
          : undefined,
      )
    }
    const tiered = byteplusRatesFor(rawId, pixelTiers)
    if (tiered) return compileSeedreamProCard(tiered, source)
    const perImage = byteplusRatesFor(rawId, images)
    if (perImage === undefined) return null
    // Billed per image returned (usage.generated_images); group-image mode
    // returns a variable count, so the caller supplies it.
    return compileUnitCard(
      {
        quantity: { param: 'generated_images', bound: 'usage' },
        rates: perImage,
      },
      source,
    )
  }
  return (rawId) => {
    const tools = doc.serverTools?.[rawId]
    const own = byteplusRatesFor(rawId, pages)
    const page = own?.page ?? null
    // A model with its own page is priced from it alone, never the pricing page.
    const pricing = !own
      ? card(rawId)
      : page
        ? compileTokenCard(page.rates, [], {
            url: own.url,
            hash: page.hash,
            extractedAt: page.extractedAt,
          })
        : null
    const pricingFacts = !pricing
      ? {}
      : own && page
        ? tagDocsFacts({ pricing }, own.url, page.hash)
        : tagDocsFacts({ pricing }, BYTEPLUS_PRICING_URL, doc.hash)
    const toolFacts =
      tools && tools.length > 0
        ? tagDocsFacts({ serverTools: tools }, BYTEPLUS_PRICING_URL, doc.hash)
        : {}
    const factSources = { ...pricingFacts, ...toolFacts }
    const lost: PricedFacts = own
      ? // Page failed this poll: keep the stored card (`tryDocs` counted it).
        page
        ? {}
        : unavailable('pricing')
      : pricing || byteplusRatesFor(rawId, named)
        ? {}
        : { absent: { pricing: 'cleared' } }
    if (!pricing && !tools) return lost
    return {
      ...lost,
      ...(pricing ? { pricing } : {}),
      ...(tools && tools.length > 0 ? { serverTools: tools } : {}),
      ...(Object.keys(factSources).length > 0 ? { factSources } : {}),
    }
  }
}
