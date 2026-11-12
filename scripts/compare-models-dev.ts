/**
 * COMPARE-ONLY. models.dev is never a source for this catalog (issue #197).
 * This script reads models.dev to answer one question — "do we have as much
 * as models.dev for the chat models we support?" — and prints the answer.
 * Nothing it reads may be written to the DB, an adapter, an ingest fixture
 * or the source-silent ledger, and nothing under `src/server/ingest/` or
 * `src/server/providers/` may import this file (nor this file them).
 *
 *   pnpm run compare:models-dev                         # per-provider table
 *   pnpm run compare:models-dev -- --json               # everything, per model
 *   pnpm run compare:models-dev -- --provider grok      # where we are behind / disagree
 *   pnpm run compare:models-dev -- --ours a.json --theirs b.json   # saved inputs
 *   pnpm run compare:models-dev -- --check --min 0.9    # exit 1 below 90% parity
 *
 * Two requests per run: `GET /v1/models` (anonymous prod is 60 requests an
 * hour, shared) and `GET https://models.dev/api.json`.
 *
 * models.dev is not ground truth. "Only they have it" means a value exists
 * there, not that a correct value exists there.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { cardCurrency } from '@modelschemas/rate-card'

import { readLedger } from './gap-report.ts'
import { isCapabilityMap } from '../src/lib/capabilities.ts'
import type { FactKey as LedgerKey, Ledger } from '../src/lib/completeness.ts'

const THEIRS_URL = 'https://models.dev/api.json'

/**
 * Our provider id → models.dev provider id(s), where the two differ. Any
 * provider not listed maps to the same id; one with no counterpart is
 * reported as "not in models.dev". Each pair was checked by reading both
 * sides' model ids and API hosts (2026-10-07).
 */
export const PROVIDER_MAP: Record<string, Array<string>> = {
  // Google's Gemini API (ai.google.dev); 25 of our ids are theirs verbatim.
  gemini: ['google'],
  // xAI; all 8 of our chat ids are theirs verbatim.
  grok: ['xai'],
  // Same `Org/Model` ids on api.together.xyz.
  together: ['togetherai'],
  // Same `accounts/fireworks/models/…` ids.
  fireworks: ['fireworks-ai'],
  // Same `org/model` ids on api.novita.ai.
  novita: ['novita-ai'],
  // Ours is the international platform (api.moonshot.ai); the China one is
  // `moonshotai-cn` on both sides.
  moonshot: ['moonshotai'],
  // Our prices come from dashscope-intl.aliyuncs.com, which is their
  // `alibaba`; `alibaba-cn` is the mainland endpoint with CNY prices.
  dashscope: ['alibaba'],
  // They split Perplexity in two: `perplexity-agent` holds the Agent API's
  // `vendor/model` ids our chat rows use, `perplexity` the bare Sonar ids.
  perplexity: ['perplexity-agent', 'perplexity'],
  // Deliberately absent: `byteplus`. Their `volcengine` is the mainland Ark
  // (ark.cn-beijing.volces.com, CNY) — a different platform that happens to
  // share some model ids.
}

export type OurRow = {
  provider: string
  rawId: string
  activity?: string | null
  contextWindow?: number | null
  maxOutput?: number | null
  modalities?: {
    input?: Array<string> | null
    output?: Array<string> | null
  } | null
  pricing?: {
    price?: unknown
    tables?: { rate?: { base?: Record<string, unknown> } }
    source?: { url?: string }
  } | null
  capabilities?: unknown
  reasoning?: { mode?: string; efforts?: Array<string> | null } | null
  aliases?: Array<string> | null
  releasedAt?: number | null
  knowledgeCutoff?: string | null
  openWeights?: boolean | null
}

export type TheirModel = {
  id: string
  family?: string
  reasoning?: boolean
  tool_call?: boolean
  temperature?: boolean
  structured_output?: boolean
  reasoning_options?: Array<{ type: string; values?: Array<string> }>
  modalities?: { input?: Array<string>; output?: Array<string> }
  limit?: { context?: number; output?: number; input?: number }
  cost?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
  }
  release_date?: string
  knowledge?: string
  open_weights?: boolean
}

export type TheirCatalog = Record<
  string,
  { models: Record<string, TheirModel> }
>

/** models.dev provider ids for one of ours; empty when it has none. */
export function counterparts(
  provider: string,
  theirs: TheirCatalog,
): Array<string> {
  return (PROVIDER_MAP[provider] ?? [provider]).filter((id) => id in theirs)
}

// ── matching ────────────────────────────────────────────────────────────

export type MatchRule = 'exact' | 'alias' | 'normalised'

export type Match = {
  row: OurRow
  theirs: TheirModel
  theirProvider: string
  how: MatchRule
}

/** Case and dots-vs-hyphens only: `GPT-4.1` ≡ `gpt-4-1`. Never siblings. */
export function normaliseId(id: string): string {
  return id.toLowerCase().replaceAll('.', '-')
}

/** A Bedrock-style regional inference-profile prefix: `us.vendor.model`. */
const REGION_PREFIX = /^(?:us|us-gov|eu|au|apac|global|in|jp|ca)\./

/**
 * A row's stored aliases in the order the alias pass tries them: the model
 * itself before a regional profile of it. A regional alias (`au.vendor.x`)
 * also names the model it routes to (`vendor.x`), so that id is a candidate
 * too, ahead of any regional one — otherwise the row would be compared with
 * one region's limits and prices.
 */
export function aliasCandidates(row: OurRow): Array<string> {
  const aliases = row.aliases ?? []
  const regional = aliases.filter((alias) => REGION_PREFIX.test(alias))
  return [
    ...new Set([
      ...aliases.filter((alias) => !REGION_PREFIX.test(alias)),
      ...regional.map((alias) => alias.replace(REGION_PREFIX, '')),
      ...regional,
    ]),
  ]
}

/**
 * Exact raw id, then our stored aliases, then {@link normaliseId} — each
 * pass over what the earlier ones left, and each of their models claimed at
 * most once. A normalised key shared by two ids on either side matches
 * nothing: ambiguity is reported as unmatched, not guessed.
 */
export function matchModels(
  rows: Array<OurRow>,
  theirs: Map<string, { provider: string; model: TheirModel }>,
): { matches: Array<Match>; unmatched: Array<OurRow> } {
  const matches: Array<Match> = []
  const claimed = new Set<string>()
  let left = rows

  const pass = (how: MatchRule, find: (row: OurRow) => string | undefined) => {
    const next: Array<OurRow> = []
    for (const row of left) {
      const id = find(row)
      const hit = id === undefined ? undefined : theirs.get(id)
      if (id === undefined || !hit || claimed.has(id)) {
        next.push(row)
        continue
      }
      claimed.add(id)
      matches.push({ row, theirs: hit.model, theirProvider: hit.provider, how })
    }
    left = next
  }

  pass('exact', (row) => row.rawId)
  pass('alias', (row) =>
    aliasCandidates(row).find((id) => theirs.has(id) && !claimed.has(id)),
  )

  const group = (ids: Array<string>) => {
    const byKey = new Map<string, Array<string>>()
    for (const id of ids) {
      const key = normaliseId(id)
      byKey.set(key, [...(byKey.get(key) ?? []), id])
    }
    return byKey
  }
  const theirKeys = group([...theirs.keys()].filter((id) => !claimed.has(id)))
  const ourKeys = group(left.map((row) => row.rawId))
  pass('normalised', (row) => {
    const key = normaliseId(row.rawId)
    const candidates = theirKeys.get(key)
    return ourKeys.get(key)?.length === 1 && candidates?.length === 1
      ? candidates[0]
      : undefined
  })

  return { matches, unmatched: left }
}

// ── facts ───────────────────────────────────────────────────────────────

/** A fact in canonical, directly comparable form. */
export type Value = number | boolean | string

export const STATUSES = [
  'agree',
  'agreeRounding',
  'disagree',
  'nonUsd',
  'nonToken',
  'onlyOurs',
  'onlyTheirs',
  'neither',
] as const

export type Status = (typeof STATUSES)[number]

/**
 * Two token limits within 5% of each other are one published label rounded
 * two ways (128,000 vs 131,072 is 2.3%; 1,000,000 vs 1,048,576 is 4.6%) and
 * count as `agreeRounding`, apart from exact agreement and from a real
 * disagreement such as 400,000 vs 272,000.
 */
export const ROUNDING_TOLERANCE = 0.05

/** Our `priced` value for a card with no input and output token rate. */
export const NON_TOKEN = 'non-token card'

export function classify(
  ours: Value | undefined,
  theirs: Value | undefined,
  options: { rounding?: boolean; currency?: string; prefix?: boolean } = {},
): Status {
  if (ours === undefined) return theirs === undefined ? 'neither' : 'onlyTheirs'
  if (theirs === undefined) return 'onlyOurs'
  // A month and a day in that month are one date at two precisions.
  if (
    options.prefix &&
    typeof ours === 'string' &&
    typeof theirs === 'string' &&
    (ours.startsWith(theirs) || theirs.startsWith(ours))
  ) {
    return 'agree'
  }
  // Their prices are USD. Ours in another currency is a value we hold, but
  // it is never converted, so the two are not compared.
  if (options.currency !== undefined && options.currency !== 'USD') {
    return 'nonUsd'
  }
  // Likewise a card that bills per request or per audio token: we hold a
  // price, but there is no per-text-token rate to set beside theirs.
  if (ours === NON_TOKEN) return 'nonToken'
  if (ours === theirs) return 'agree'
  if (
    options.rounding &&
    typeof ours === 'number' &&
    typeof theirs === 'number' &&
    Math.abs(ours - theirs) / Math.max(ours, theirs) <= ROUNDING_TOLERANCE
  ) {
    return 'agreeRounding'
  }
  return 'disagree'
}

const positive = (value: number | null | undefined): number | undefined =>
  typeof value === 'number' && value > 0 ? value : undefined

/** Sorted and de-duplicated; their `pdf` and ours are both read as `file`. */
function modalitySet(
  list: Array<string> | null | undefined,
): string | undefined {
  if (!list?.length) return undefined
  const names = list.map((name) => (name === 'pdf' ? 'file' : name))
  return [...new Set(names)].sort().join(',')
}

function isModelsDev(row: OurRow): boolean {
  try {
    const { hostname } = new URL(row.pricing?.source?.url ?? '')
    return hostname === 'models.dev' || hostname.endsWith('.models.dev')
  } catch {
    return false
  }
}

/** Per-1M-token rate, 6 significant digits so float noise cannot disagree. */
const perMillion = (perToken: number): number =>
  Number((perToken * 1e6).toPrecision(6))

// Listing-compiled cards use OpenRouter's key names, parsed cards ours. A
// price that itself came from models.dev would be compared with itself, so
// it counts as no price (as in the gap report).
function rate(row: OurRow, ...keys: Array<string>): number | undefined {
  if (isModelsDev(row)) return undefined
  const base = row.pricing?.tables?.rate?.base
  for (const key of keys) {
    const value = base?.[key]
    if (typeof value === 'number') return perMillion(value)
  }
  return undefined
}

/** The card's currency; `unknown` for a card the evaluator cannot read. */
function currency(row: OurRow): string | undefined {
  if (!row.pricing) return undefined
  try {
    return cardCurrency(row.pricing as Parameters<typeof cardCurrency>[0])
  } catch {
    return 'unknown'
  }
}

/**
 * A capability flag, read from the row's map: `true` and `false` are what
 * the provider states, and a missing key (or no map) is unknown, never a
 * held `false`.
 */
function flag(row: OurRow, name: string): boolean | undefined {
  const map = row.capabilities
  return isCapabilityMap(map) ? map[name] : undefined
}

function ourPrice(row: OurRow): Value | undefined {
  const tokens = pair(
    rate(row, 'input_tokens', 'prompt'),
    rate(row, 'output_tokens', 'completion'),
  )
  if (tokens !== undefined) return tokens
  return row.pricing && !isModelsDev(row) ? NON_TOKEN : undefined
}

function ourReasoningOptions(row: OurRow): string | undefined {
  const mode = row.reasoning?.mode
  if (!mode) return undefined
  // `adaptive` is effort-driven; they have no separate word for it.
  if (mode !== 'effort' && mode !== 'adaptive') return mode
  // An effort mode with no effort names states no options.
  const efforts = row.reasoning?.efforts ?? []
  return efforts.length > 0
    ? `effort:${[...efforts].sort().join(',')}`
    : undefined
}

function theirReasoningOptions(model: TheirModel): string | undefined {
  if (!model.reasoning_options?.length) return undefined
  return model.reasoning_options
    .map((option) =>
      option.type === 'effort'
        ? `effort:${[...(option.values ?? [])].sort().join(',')}`
        : option.type === 'budget_tokens'
          ? 'budget'
          : option.type,
    )
    .sort()
    .join('+')
}

type Fact = {
  label: string
  /** The gap-report key whose ledger entry covers this fact, if any. */
  ledger?: LedgerKey
  rounding?: boolean
  price?: boolean
  /** Dates: equal when one is the other at a coarser precision. */
  prefix?: boolean
  ours: (row: OurRow) => Value | undefined
  theirs: (model: TheirModel) => Value | undefined
}

function pair(a: number | undefined, b: number | undefined) {
  return a === undefined || b === undefined ? undefined : `${a}/${b}`
}

export const FACTS = {
  contextWindow: {
    label: 'ctx',
    ledger: 'contextWindow',
    rounding: true,
    ours: (row) => positive(row.contextWindow),
    theirs: (model) => positive(model.limit?.context),
  },
  maxOutput: {
    label: 'out',
    ledger: 'maxOutput',
    rounding: true,
    ours: (row) => positive(row.maxOutput),
    theirs: (model) => positive(model.limit?.output),
  },
  inputModalities: {
    label: 'modIn',
    ledger: 'modalities',
    ours: (row) => modalitySet(row.modalities?.input),
    theirs: (model) => modalitySet(model.modalities?.input),
  },
  outputModalities: {
    label: 'modOut',
    ledger: 'modalities',
    ours: (row) => modalitySet(row.modalities?.output),
    theirs: (model) => modalitySet(model.modalities?.output),
  },
  // "input/output", USD per 1M tokens.
  priced: {
    label: 'price',
    ledger: 'priced',
    price: true,
    ours: ourPrice,
    theirs: (model) => pair(model.cost?.input, model.cost?.output),
  },
  cacheRead: {
    label: 'cRead',
    ledger: 'cacheRead',
    price: true,
    ours: (row) => rate(row, 'cache_read_tokens', 'input_cache_read'),
    theirs: (model) => model.cost?.cache_read,
  },
  cacheWrite: {
    label: 'cWrite',
    price: true,
    ours: (row) => rate(row, 'cache_write_tokens', 'input_cache_write'),
    theirs: (model) => model.cost?.cache_write,
  },
  tools: {
    label: 'tools',
    ledger: 'capabilities',
    ours: (row) => flag(row, 'tools'),
    theirs: (model) => model.tool_call,
  },
  structuredOutput: {
    label: 'struct',
    ledger: 'capabilities',
    ours: (row) => flag(row, 'structured_outputs'),
    theirs: (model) => model.structured_output,
  },
  reasoning: {
    label: 'reason',
    ledger: 'reasoning',
    ours: (row) => (row.reasoning ? true : flag(row, 'reasoning')),
    theirs: (model) => model.reasoning,
  },
  reasoningOptions: {
    label: 'opts',
    ledger: 'efforts',
    ours: ourReasoningOptions,
    theirs: theirReasoningOptions,
  },
  temperature: {
    label: 'temp',
    ledger: 'capabilities',
    ours: (row) => flag(row, 'temperature'),
    theirs: (model) => model.temperature,
  },
  // The provider's own date as a UTC day, beside their `YYYY-MM-DD`.
  releasedAt: {
    label: 'rel',
    prefix: true,
    ours: (row) =>
      typeof row.releasedAt === 'number'
        ? new Date(row.releasedAt * 1000).toISOString().slice(0, 10)
        : undefined,
    theirs: (model) => model.release_date || undefined,
  },
  knowledgeCutoff: {
    label: 'know',
    prefix: true,
    ours: (row) => row.knowledgeCutoff ?? undefined,
    theirs: (model) => model.knowledge || undefined,
  },
  openWeights: {
    label: 'open',
    ours: (row) => row.openWeights ?? undefined,
    theirs: (model) => model.open_weights,
  },
} satisfies Record<string, Fact>

export type FactKey = keyof typeof FACTS
export const FACT_KEYS = Object.keys(FACTS) as Array<FactKey>

/** Fields models.dev carries that our rows have no column for. */
export const NO_FIELD = {
  'limit.input': (model: TheirModel) => positive(model.limit?.input),
  family: (model: TheirModel) => model.family,
}
export type NoFieldKey = keyof typeof NO_FIELD
const NO_FIELD_KEYS = Object.keys(NO_FIELD) as Array<NoFieldKey>

// ── report ──────────────────────────────────────────────────────────────

export type Cell = {
  status: Status
  ours?: Value
  theirs?: Value
  /** We are behind, and the ledger says the provider does not publish it. */
  ledgered?: true
}

export type FactCounts = Record<Status, number> & { ledgered: number }

export type ProviderComparison = {
  provider: string
  /** models.dev provider ids; empty when it is not in models.dev. */
  theirs: Array<string>
  chat: number
  matched: number
  matchedBy: Record<MatchRule, number>
  unmatchedOurs: Array<string>
  /** Their chat-like models we have no row for at all. */
  notListed: Array<string>
  /** Their chat-like models we list, but not as a chat row. */
  listedNotChat: Array<string>
  /** Their unmatched ids that one of our chat rows already names as an alias. */
  aliasOfChatRow: Array<string>
  /** Our chat rows whose input modalities do not include `text`. */
  inputWithoutText: number
  /** Facts the source-silent ledger covers for this provider. */
  silent: Array<FactKey>
  facts: Record<FactKey, FactCounts>
  noField: Record<NoFieldKey, number>
  models: Array<{
    ours: string
    theirs: string
    how: MatchRule
    facts: Record<FactKey, Cell>
  }>
}

export type Parity = { have: number; of: number; ratio: number }

export type Headline = {
  matched: number
  /** Of the fact-values models.dev has, how many we have too. */
  oursOfTheirs: Parity
  /** Of the fact-values we have, how many models.dev has too. */
  theirsOfOurs: Parity
}

export type Comparison = {
  generatedAt: string
  note: string
  headline: Headline
  headlineExcludingLedgered: Headline
  headlineExcludingZeroRates: Headline
  /** Matched pairs where models.dev's rate is zero; each counts as a value. */
  zeroRates: Record<PriceFactKey, number>
  /** Our chat rows, matched or not, whose input modalities lack `text`. */
  inputWithoutText: { total: number; byProvider: Record<string, number> }
  noField: Record<NoFieldKey, number>
  notInModelsDev: Array<string>
  providers: Array<ProviderComparison>
}

export const NOTE =
  'Compare-only: models.dev is never a source for this catalog. Its values ' +
  'are not ground truth — "only they have it" (behind) means a value exists ' +
  'there, not that a correct one does.'

const PRICE_FACTS = ['priced', 'cacheRead', 'cacheWrite'] as const
type PriceFactKey = (typeof PRICE_FACTS)[number]

/** A models.dev rate of zero: often "plan-included" or "unknown", not free. */
const isZeroRate = (key: FactKey, cell: Cell): boolean =>
  (PRICE_FACTS as ReadonlyArray<string>).includes(key) &&
  (cell.theirs === 0 || cell.theirs === '0/0')

// ponytail: "chat-like" is text out, minus embedding/rerank names; models.dev
// has no activity field. Read the lists, not just the counts.
function chatLike(model: TheirModel): boolean {
  return (
    (model.modalities?.output ?? []).includes('text') &&
    !/embed|rerank/i.test(`${model.id} ${model.family ?? ''}`)
  )
}

const BOTH: Array<Status> = [
  'agree',
  'agreeRounding',
  'disagree',
  'nonUsd',
  'nonToken',
]

/**
 * Parity both ways over matched pairs. `ledgered` drops the facts a
 * provider's ledger covers; `zeroRates` drops the cells where models.dev's
 * rate is zero.
 */
export function headline(
  providers: Array<ProviderComparison>,
  exclude: { ledgered?: boolean; zeroRates?: boolean } = {},
): Headline {
  let both = 0
  let onlyOurs = 0
  let onlyTheirs = 0
  for (const provider of providers) {
    for (const key of FACT_KEYS) {
      if (exclude.ledgered && provider.silent.includes(key)) continue
      for (const model of provider.models) {
        const cell = model.facts[key]
        if (exclude.zeroRates && isZeroRate(key, cell)) continue
        if (BOTH.includes(cell.status)) both += 1
        else if (cell.status === 'onlyOurs') onlyOurs += 1
        else if (cell.status === 'onlyTheirs') onlyTheirs += 1
      }
    }
  }
  const parity = (have: number, of: number): Parity => ({
    have,
    of,
    ratio: of === 0 ? 1 : have / of,
  })
  return {
    matched: providers.reduce((sum, provider) => sum + provider.matched, 0),
    oursOfTheirs: parity(both, both + onlyTheirs),
    theirsOfOurs: parity(both, both + onlyOurs),
  }
}

export const behind = (provider: ProviderComparison): number =>
  FACT_KEYS.reduce((sum, key) => sum + provider.facts[key].onlyTheirs, 0)

function compareProvider(
  provider: string,
  rows: Array<OurRow>,
  theirs: TheirCatalog,
  ledger: Ledger,
): ProviderComparison {
  const theirIds = counterparts(provider, theirs)
  // First listed provider wins an id both carry.
  const theirModels = new Map<string, { provider: string; model: TheirModel }>()
  for (const id of theirIds) {
    for (const [modelId, model] of Object.entries(theirs[id]?.models ?? {})) {
      if (!theirModels.has(modelId))
        theirModels.set(modelId, { provider: id, model })
    }
  }

  const chat = rows.filter((row) => row.activity === 'chat')
  const { matches, unmatched } = matchModels(chat, theirModels)
  const silent = FACT_KEYS.filter((key) => {
    const ledgerKey = (FACTS[key] as Fact).ledger
    return ledgerKey !== undefined && ledger.get(provider)?.has(ledgerKey)
  })

  const facts = Object.fromEntries(
    FACT_KEYS.map((key) => [
      key,
      { ...Object.fromEntries(STATUSES.map((s) => [s, 0])), ledgered: 0 },
    ]),
  ) as Record<FactKey, FactCounts>
  const noField = Object.fromEntries(
    NO_FIELD_KEYS.map((key) => [key, 0]),
  ) as Record<NoFieldKey, number>

  const models = matches.map((match) => {
    const cells = {} as Record<FactKey, Cell>
    for (const key of FACT_KEYS) {
      const fact: Fact = FACTS[key]
      const ours = fact.ours(match.row)
      const their = fact.theirs(match.theirs)
      const status = classify(ours, their, {
        rounding: fact.rounding,
        prefix: fact.prefix,
        currency: fact.price ? currency(match.row) : undefined,
      })
      const ledgered = status === 'onlyTheirs' && silent.includes(key)
      cells[key] = {
        status,
        ...(ours !== undefined && { ours }),
        ...(their !== undefined && { theirs: their }),
        ...(ledgered && { ledgered }),
      }
      facts[key][status] += 1
      if (ledgered) facts[key].ledgered += 1
    }
    for (const key of NO_FIELD_KEYS) {
      if (NO_FIELD[key](match.theirs) !== undefined) noField[key] += 1
    }
    return {
      ours: match.row.rawId,
      theirs: `${match.theirProvider}/${match.theirs.id}`,
      how: match.how,
      facts: cells,
    }
  })

  // Every id we list under this provider, chat or not, aliases included.
  const listed = new Set(
    rows.flatMap((row) => [row.rawId, ...(row.aliases ?? [])]).map(normaliseId),
  )
  // Their id for a model one of our chat rows already names: not a model we
  // list as something other than chat, and not one we lack.
  const chatAliases = new Set(chat.flatMap(aliasCandidates))
  const claimed = new Set(matches.map((match) => match.theirs.id))
  const unclaimed = [...theirModels]
    .filter(([id, entry]) => !claimed.has(id) && chatLike(entry.model))
    .map(([id]) => id)
    .sort()
  const extra = unclaimed.filter((id) => !chatAliases.has(id))

  return {
    provider,
    theirs: theirIds,
    chat: chat.length,
    matched: matches.length,
    matchedBy: {
      exact: matches.filter((match) => match.how === 'exact').length,
      alias: matches.filter((match) => match.how === 'alias').length,
      normalised: matches.filter((match) => match.how === 'normalised').length,
    },
    unmatchedOurs: unmatched.map((row) => row.rawId).sort(),
    notListed: extra.filter((id) => !listed.has(normaliseId(id))),
    listedNotChat: extra.filter((id) => listed.has(normaliseId(id))),
    aliasOfChatRow: unclaimed.filter((id) => chatAliases.has(id)),
    inputWithoutText: chat.filter(
      (row) =>
        row.modalities?.input?.length && !row.modalities.input.includes('text'),
    ).length,
    silent,
    facts,
    noField,
    models,
  }
}

/** Every provider of ours with chat rows, most "behind" first. */
export function compare(
  rows: Array<OurRow>,
  theirs: TheirCatalog,
  ledger: Ledger = new Map(),
  now: Date = new Date(),
): Comparison {
  const byProvider = new Map<string, Array<OurRow>>()
  for (const row of rows) {
    byProvider.set(row.provider, [...(byProvider.get(row.provider) ?? []), row])
  }
  const providers = [...byProvider]
    .filter(([, group]) => group.some((row) => row.activity === 'chat'))
    .map(([provider, group]) =>
      compareProvider(provider, group, theirs, ledger),
    )
    .sort(
      (a, b) => behind(b) - behind(a) || a.provider.localeCompare(b.provider),
    )

  const zeroRates = Object.fromEntries(
    PRICE_FACTS.map((key) => [
      key,
      providers
        .flatMap((provider) => provider.models)
        .filter((model) => isZeroRate(key, model.facts[key])).length,
    ]),
  ) as Record<PriceFactKey, number>
  const withoutText = providers.filter((p) => p.inputWithoutText > 0)

  return {
    generatedAt: now.toISOString(),
    note: `${NOTE} A models.dev rate of zero counts as a value: price 0/0 on ${zeroRates.priced} matched models, cache_read 0 on ${zeroRates.cacheRead}, cache_write 0 on ${zeroRates.cacheWrite}.`,
    headline: headline(providers),
    headlineExcludingLedgered: headline(providers, { ledgered: true }),
    headlineExcludingZeroRates: headline(providers, { zeroRates: true }),
    zeroRates,
    inputWithoutText: {
      total: withoutText.reduce((sum, p) => sum + p.inputWithoutText, 0),
      byProvider: Object.fromEntries(
        withoutText.map((p) => [p.provider, p.inputWithoutText]),
      ),
    },
    noField: Object.fromEntries(
      NO_FIELD_KEYS.map((key) => [
        key,
        providers.reduce((sum, provider) => sum + provider.noField[key], 0),
      ]),
    ) as Record<NoFieldKey, number>,
    notInModelsDev: providers
      .filter((provider) => provider.theirs.length === 0)
      .map((provider) => provider.provider)
      .sort(),
    providers,
  }
}

// ── output ──────────────────────────────────────────────────────────────

const percent = (parity: Parity) =>
  `${parity.have} of ${parity.of} (${(parity.ratio * 100).toFixed(1)}%)`

function headlineLines(report: Comparison): Array<string> {
  const { headline: all, headlineExcludingLedgered: scored } = report
  const nonZero = report.headlineExcludingZeroRates
  const { total, byProvider } = report.inputWithoutText
  return [
    `Across ${all.matched} matched chat models and ${FACT_KEYS.length} comparable facts:`,
    `  we have ${percent(all.oursOfTheirs)} of the fact-values models.dev has`,
    `  models.dev has ${percent(all.theirsOfOurs)} of the fact-values we have`,
    `  excluding ledgered facts: we have ${percent(scored.oursOfTheirs)}; models.dev has ${percent(scored.theirsOfOurs)}`,
    `  excluding models.dev zero rates: we have ${percent(nonZero.oursOfTheirs)}; models.dev has ${percent(nonZero.theirsOfOurs)}`,
    `They have, we have no field: ${NO_FIELD_KEYS.map((key) => `${key} ${report.noField[key]}`).join(', ')}`,
    `Not in models.dev: ${report.notInModelsDev.join(', ') || 'none'}`,
    `Our chat rows whose input modalities lack "text": ${total}${
      total
        ? ` (${Object.entries(byProvider)
            .map(([provider, count]) => `${provider} ${count}`)
            .join(', ')})`
        : ''
    } — a catalog bug, compared as stored`,
    report.note,
  ]
}

const they = (counts: FactCounts) =>
  counts.onlyTheirs + BOTH.reduce((sum, status) => sum + counts[status], 0)

/** One row per provider; a fact cell is `behind/they have`, `*` = ledgered. */
export function formatTable(report: Comparison): string {
  const header = [
    'provider',
    'models.dev',
    'chat',
    'match',
    'noMatch',
    'theyOnly',
    ...FACT_KEYS.map((key) => FACTS[key].label),
  ]
  const factCells = (rows: Array<ProviderComparison>, silent: Array<FactKey>) =>
    FACT_KEYS.map((key) => {
      const sum = (pick: (counts: FactCounts) => number) =>
        rows.reduce((total, row) => total + pick(row.facts[key]), 0)
      return `${sum((c) => c.onlyTheirs)}/${sum(they)}${silent.includes(key) ? '*' : ''}`
    })
  const total = (pick: (provider: ProviderComparison) => number) =>
    String(report.providers.reduce((sum, provider) => sum + pick(provider), 0))
  const body = [
    ...report.providers.map((p) =>
      p.theirs.length === 0
        ? [p.provider, 'not in models.dev', String(p.chat)]
        : [
            p.provider,
            p.theirs.join('+'),
            String(p.chat),
            String(p.matched),
            String(p.unmatchedOurs.length),
            String(p.notListed.length),
            ...factCells([p], p.silent),
          ],
    ),
    [
      'OVERALL',
      '',
      total((p) => p.chat),
      total((p) => p.matched),
      total((p) => (p.theirs.length ? p.unmatchedOurs.length : 0)),
      total((p) => p.notListed.length),
      ...factCells(report.providers, []),
    ],
  ]
  const width = (i: number) =>
    Math.max(...[header, ...body].map((line) => line[i]?.length ?? 0))
  const table = [header, ...body].map((line) =>
    line
      .map((cell, i) =>
        i < 2 ? cell.padEnd(width(i)) : cell.padStart(width(i)),
      )
      .join('  ')
      .trimEnd(),
  )
  return [
    ...table,
    '',
    'fact cells: behind/they have — matched pairs where only models.dev has a value, over those where it has one; * = ledgered (provider publishes nothing).',
    'noMatch: our chat rows with no models.dev model; theyOnly: their chat-like models we do not list at all.',
    ...headlineLines(report),
  ].join('\n')
}

/** Per fact: where we are behind, and where the two disagree. */
export function formatProvider(provider: ProviderComparison): string {
  if (provider.theirs.length === 0) {
    return `${provider.provider}: not in models.dev (${provider.chat} chat rows)`
  }
  const { exact, alias, normalised } = provider.matchedBy
  const lines = [
    `${provider.provider} ↔ ${provider.theirs.join('+')}: ${provider.chat} chat rows, ${provider.matched} matched (exact ${exact}, alias ${alias}, normalised ${normalised})`,
  ]
  for (const key of FACT_KEYS) {
    const of = (status: Status) =>
      provider.models.filter((model) => model.facts[key].status === status)
    const behindRows = of('onlyTheirs')
    const disagree = of('disagree')
    const counts = provider.facts[key]
    lines.push(
      '',
      `${key}${provider.silent.includes(key) ? ' (ledgered)' : ''}: agree ${counts.agree}, rounding ${counts.agreeRounding}, disagree ${counts.disagree}, non-USD ${counts.nonUsd}, non-token ${counts.nonToken}, only ours ${counts.onlyOurs}, only theirs ${counts.onlyTheirs}, neither ${counts.neither}`,
      ...behindRows.map(
        (model) =>
          `  behind    ${model.ours}: theirs ${model.facts[key].theirs}`,
      ),
      ...disagree.map(
        (model) =>
          `  disagree  ${model.ours}: ours ${model.facts[key].ours} · theirs ${model.facts[key].theirs}`,
      ),
    )
  }
  const list = (title: string, ids: Array<string>) =>
    lines.push('', `${title} (${ids.length}): ${ids.join(', ') || 'none'}`)
  list('our chat rows with no models.dev model', provider.unmatchedOurs)
  list('their chat-like models we do not list', provider.notListed)
  list('their chat-like models we list as non-chat', provider.listedNotChat)
  list('their ids that alias one of our chat rows', provider.aliasOfChatRow)
  return lines.join('\n')
}

async function load<T>(file: string | undefined, url: string): Promise<T> {
  if (file) return JSON.parse(readFileSync(file, 'utf8')) as T
  const response = await fetch(url)
  if (response.status === 429) {
    throw new Error(
      `GET ${url} → 429: rate limited. Stopping; rerun later, or pass a saved copy with --ours / --theirs.`,
    )
  }
  if (!response.ok) throw new Error(`GET ${url} → ${response.status}`)
  return (await response.json()) as T
}

export async function main(
  argv: Array<string> = process.argv.slice(2),
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: 'string', default: 'https://modelschemas.com' },
      ours: { type: 'string' },
      theirs: { type: 'string' },
      table: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      provider: { type: 'string' },
      check: { type: 'boolean', default: false },
      min: { type: 'string', default: '1' },
    },
  })
  const min = Number(values.min)
  if (!(min >= 0 && min <= 1)) {
    throw new Error(`--min must be between 0 and 1, got "${values.min}"`)
  }

  const { models } = await load<{ models: Array<OurRow> }>(
    values.ours,
    new URL('/v1/models?pricing=1&limit=20000', values.base).href,
  )
  const theirs = await load<TheirCatalog>(values.theirs, THEIRS_URL)
  const report = compare(models, theirs, readLedger())

  if (values.json) {
    console.log(JSON.stringify(report, null, 2))
  } else if (values.provider) {
    const provider = report.providers.find(
      (p) => p.provider === values.provider,
    )
    if (!provider) throw new Error(`no chat rows for "${values.provider}"`)
    console.log(formatProvider(provider))
  } else {
    console.log(formatTable(report))
  }

  const { ratio } = report.headline.oursOfTheirs
  if (values.check && ratio < min) {
    console.error(`parity ${ratio.toFixed(3)} is below --min ${min}`)
    return 1
  }
  return 0
}

if (import.meta.main) {
  process.exit(await main())
}
