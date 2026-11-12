/**
 * Completeness: the share of the chat facts `@tanstack/ai-models` needs that
 * a provider's rows carry. The one definition behind `pnpm run gap:report`
 * (`scripts/gap-report.ts`) and `completeness` on `GET /v1/status`, so the
 * CLI and the site cannot disagree. No Node or Workers dependencies.
 *
 * `docs/source-silent/<provider>.md` lists facts a provider does not publish;
 * those are left out of that provider's score and listed under `silent`.
 */
import { isCapabilityMap, supportedFlags } from './capabilities.ts'
import { modelLedgerScope, parseLedgerEntry } from './source-silence-ledger.ts'

export const FACT_KEYS = [
  'contextWindow',
  'maxOutput',
  'modalities',
  'priced',
  'cacheRead',
  'capabilities',
  'reasoning',
  'efforts',
  'requestMap',
  'endpoint',
  'replayReasoningContent',
] as const

export type FactKey = (typeof FACT_KEYS)[number]

/**
 * Row shapes `@tanstack/ai-models` cannot read correctly, counted apart from
 * the score (issue #323). The score counts a fact as filled; a flag says the
 * stored value still leaves the catalog to guess.
 */
export const FLAG_KEYS = [
  'mandatoryUnknown',
  'reasoningUnknown',
  'outputModalitiesEmpty',
  'mandatoryWithNone',
] as const

export type FlagKey = (typeof FLAG_KEYS)[number]

/** The fields of a `/v1/models` row the report reads. */
export type ModelRow = {
  provider: string
  /** Exact native model id, never the slugged catalog id. */
  rawId?: string
  activity?: string | null
  contextWindow?: number | null
  maxOutput?: number | null
  modalities?: { input?: unknown; output?: unknown } | null
  pricing?: {
    tables?: { rate?: Record<string, unknown> }
    source?: { url?: string }
  } | null
  capabilities?: unknown
  reasoning?: {
    mode?: string
    mandatory?: boolean | null
    efforts?: Array<string>
  } | null
  requestMap?: unknown
  schemaEndpointId?: string | null
  /**
   * `cacheRead.path === 'not-offered'` is a stated absence: the provider's
   * pricing table shows a cached-input cell that is "-" or blank. That
   * fills the fact. It is not a price.
   */
  factSources?: {
    cacheRead?: { path?: string } | null
  } | null
}

export type ProviderReport = {
  provider: string
  rows: number
  chat: number
  noActivity: number
  fromModelsDev: number
  facts: Record<FactKey, { have: number; need: number }>
  silent: Array<FactKey>
  /** Applicable missing rows excluded by exact model-scoped evidence. */
  modelSilent?: Partial<Record<FactKey, number>>
  /**
   * 0 to 1. Null when the provider does not serve chat: every row has a
   * non-chat activity. 0 when it serves chat but classification produced
   * no chat rows (an activity is null).
   */
  score: number | null
  /** Raw ids of the chat rows each flag matches. */
  flags: Record<FlagKey, Array<string>>
}

export type GapReport = {
  generatedAt: string
  providers: Array<ProviderReport>
}

/** Provider id or provider/exact-raw-id → facts its sources do not publish. */
export type Ledger = Map<string, Set<FactKey>>

function isFactKey(value: string): value is FactKey {
  return (FACT_KEYS as ReadonlyArray<string>).includes(value)
}

/** Ledger entries are list lines: `- <provider>: <fact> — <why>`. */
export function parseLedger(markdown: string): Ledger {
  const ledger: Ledger = new Map()
  for (const line of markdown.split('\n')) {
    const entry = parseLedgerEntry(line)
    if (!entry) continue
    const { scope, fact } = entry
    if (!isFactKey(fact)) {
      throw new Error(
        `source-silent ledger: unknown fact "${fact}" in: ${line}`,
      )
    }
    const facts = ledger.get(scope) ?? new Set<FactKey>()
    facts.add(fact)
    ledger.set(scope, facts)
  }
  return ledger
}

/**
 * Public endpoint id, query and leading slash stripped. The route's wire
 * is this path. There is no provider list.
 */
function endpointPath(endpointId: string | null | undefined): string {
  if (!endpointId) return ''
  return endpointId.split('?')[0]?.replace(/^\/+/, '') ?? ''
}

/**
 * OpenAI-compatible chat wire: `chat/completions`, `completions`, or
 * `responses`. `ChatRequestMap` describes that wire.
 */
function openAiCompatRoute(row: ModelRow): boolean {
  return /(?:^|\/)(?:chat\/completions|responses|completions)$/.test(
    endpointPath(row.schemaEndpointId),
  )
}

/**
 * `reasoning_content` is the chat-completions field. Anthropic thinking
 * blocks, Gemini thought signatures, Responses reasoning items, and
 * Converse replay on other paths, so those routes are not scored.
 */
function reasoningContentRoute(row: ModelRow): boolean {
  return /(?:^|\/)chat\/completions$/.test(endpointPath(row.schemaEndpointId))
}

function reasons(row: ModelRow): boolean {
  return (
    row.reasoning != null ||
    supportedFlags(row.capabilities).includes('reasoning')
  )
}

/** A null activity is an unclassified chat candidate, not a speech or image API. */
function servesChat(group: Array<ModelRow>): boolean {
  return group.some((row) => row.activity === 'chat' || row.activity == null)
}

function isModelsDev(row: ModelRow): boolean {
  const url = row.pricing?.source?.url
  if (!url) return false
  try {
    const { hostname } = new URL(url)
    return hostname === 'models.dev' || hostname.endsWith('.models.dev')
  } catch {
    return false
  }
}

/**
 * The rate rows a lever must appear in: the base row, or, for a card with
 * no base (BytePlus off-peak/peak, picked by a required lever), every row.
 * Empty when absent or a models.dev price.
 */
function rateRows(row: ModelRow): Array<Record<string, unknown>> {
  if (isModelsDev(row)) return []
  const rate = row.pricing?.tables?.rate
  if (!rate) return []
  const rows = 'base' in rate ? [rate.base] : Object.values(rate)
  return rows.every((r) => typeof r === 'object' && r !== null)
    ? (rows as Array<Record<string, unknown>>)
    : []
}

// Listing-compiled cards use OpenRouter's key names, parsed cards ours.
function hasRate(row: ModelRow, ...keys: Array<string>): boolean {
  const rows = rateRows(row)
  return (
    rows.length > 0 &&
    rows.every((r) => keys.some((key) => typeof r[key] === 'number'))
  )
}

/** `need`: the fact applies to this row. `have`: the row carries it. */
const FACTS: Record<
  FactKey,
  { need?: (row: ModelRow) => boolean; have: (row: ModelRow) => boolean }
> = {
  contextWindow: { have: (row) => row.contextWindow != null },
  maxOutput: { have: (row) => row.maxOutput != null },
  modalities: {
    have: (row) => {
      const input = row.modalities?.input
      return Array.isArray(input) && input.length > 0
    },
  },
  priced: {
    have: (row) =>
      hasRate(row, 'input_tokens', 'prompt') &&
      hasRate(row, 'output_tokens', 'completion'),
  },
  cacheRead: {
    have: (row) =>
      hasRate(row, 'cache_read_tokens', 'input_cache_read') ||
      row.factSources?.cacheRead?.path === 'not-offered',
  },
  capabilities: { have: (row) => isCapabilityMap(row.capabilities) },
  // Filled by any stored object, whatever its `mandatory`: null there means
  // the source is silent on turning thinking off, which is a stored fact.
  reasoning: {
    need: (row) =>
      row.reasoning != null ||
      supportedFlags(row.capabilities).includes('reasoning'),
    have: (row) => row.reasoning != null,
  },
  // Only `effort` and `adaptive` rows need effort names; a `toggle` or
  // `budget` row needs none. `mandatory` plays no part: efforts with
  // `mandatory: null` is filled, and the `mandatoryUnknown` flag counts it.
  efforts: {
    need: (row) =>
      row.reasoning?.mode === 'effort' || row.reasoning?.mode === 'adaptive',
    have: (row) => (row.reasoning?.efforts?.length ?? 0) > 0,
  },
  requestMap: {
    need: openAiCompatRoute,
    have: (row) => row.requestMap != null,
  },
  endpoint: { have: (row) => row.schemaEndpointId != null },
  replayReasoningContent: {
    need: (row) => reasoningContentRoute(row) && reasons(row),
    have: (row) =>
      typeof row.requestMap === 'object' &&
      row.requestMap !== null &&
      !Array.isArray(row.requestMap) &&
      typeof (row.requestMap as Record<string, unknown>)
        .replayReasoningContent === 'boolean',
  },
}

/**
 * `reasoningUnknown` is the `reasoning` gap, so a `reasoning` ledger entry
 * for the provider or the exact model clears it. No ledger entry clears
 * the other flags: each is a stored value in the wrong shape.
 */
const FLAGS: Record<
  FlagKey,
  { silencedBy?: FactKey; match: (row: ModelRow) => boolean }
> = {
  // The catalog cannot tell if it can offer an off level.
  mandatoryUnknown: {
    match: (row) =>
      row.reasoning?.mode === 'effort' && row.reasoning.mandatory === null,
  },
  // The catalog has to guess the mode and the levels.
  reasoningUnknown: {
    silencedBy: 'reasoning',
    match: (row) =>
      FACTS.reasoning.need?.(row) === true && !FACTS.reasoning.have(row),
  },
  // The catalog reads `[]` as unknown; an unknown list is stored as null.
  outputModalitiesEmpty: {
    match: (row) => {
      const output = row.modalities?.output
      return Array.isArray(output) && output.length === 0
    },
  },
  // Thinking cannot be turned off, yet `none` turns it off.
  mandatoryWithNone: {
    match: (row) =>
      row.reasoning?.mandatory === true &&
      (row.reasoning.efforts?.includes('none') ?? false),
  },
}

/** Facts filled and facts needed across a provider, ledgered ones left out. */
export function scoredFacts(
  report: Pick<ProviderReport, 'facts' | 'silent' | 'modelSilent'>,
): {
  have: number
  need: number
} {
  let have = 0
  let need = 0
  for (const key of FACT_KEYS) {
    if (report.silent.includes(key)) continue
    have += report.facts[key].have
    need += report.facts[key].need - (report.modelSilent?.[key] ?? 0)
  }
  return { have, need }
}

export function buildReport(
  rows: Array<ModelRow>,
  ledger: Ledger = new Map(),
  now: Date = new Date(),
): GapReport {
  const byProvider = new Map<string, Array<ModelRow>>()
  for (const row of rows) {
    const group = byProvider.get(row.provider)
    if (group) group.push(row)
    else byProvider.set(row.provider, [row])
  }

  const providers = [...byProvider].map(([provider, group]): ProviderReport => {
    const chat = group.filter((row) => row.activity === 'chat')
    const silent = FACT_KEYS.filter((key) => ledger.get(provider)?.has(key))
    const modelSilent: Partial<Record<FactKey, number>> = {}
    const modelLedgered = (row: ModelRow, key: FactKey) =>
      row.rawId !== undefined &&
      ledger.get(modelLedgerScope(provider, row.rawId))?.has(key)
    const facts = Object.fromEntries(
      FACT_KEYS.map((key) => {
        const { need, have } = FACTS[key]
        const needed = need ? chat.filter(need) : chat
        const scoped = silent.includes(key)
          ? 0
          : needed.filter((row) => !have(row) && modelLedgered(row, key)).length
        if (scoped > 0) modelSilent[key] = scoped
        return [key, { have: needed.filter(have).length, need: needed.length }]
      }),
    ) as ProviderReport['facts']
    const { have, need } = scoredFacts({ facts, silent, modelSilent })
    const flags = Object.fromEntries(
      FLAG_KEYS.map((key) => {
        const { silencedBy, match } = FLAGS[key]
        const isSilent = (row: ModelRow) =>
          silencedBy !== undefined &&
          (silent.includes(silencedBy) || modelLedgered(row, silencedBy))
        return [
          key,
          chat
            .filter((row) => match(row) && !isSilent(row))
            .map((row) => row.rawId ?? ''),
        ]
      }),
    ) as ProviderReport['flags']

    return {
      provider,
      rows: group.length,
      chat: chat.length,
      noActivity: group.filter((row) => row.activity == null).length,
      fromModelsDev: group.filter(isModelsDev).length,
      facts,
      silent,
      modelSilent,
      // No classified chat rows on a provider that serves chat is a gap.
      // A provider whose every row is image, audio, or video has nothing
      // to score. Chat rows with every needed fact on the ledger score 1.
      score:
        need === 0
          ? chat.length > 0
            ? 1
            : servesChat(group)
              ? 0
              : null
          : have / need,
      flags,
    }
  })

  const rank = (score: number | null) => score ?? Number.POSITIVE_INFINITY
  providers.sort(
    (a, b) =>
      rank(a.score) - rank(b.score) || a.provider.localeCompare(b.provider),
  )
  return { generatedAt: now.toISOString(), providers }
}
