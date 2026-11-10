import type { Activity } from '#/db/schema.ts'
/**
 * Model poller (PLAN.md task 2.4) — the fast 15-minute tier: per provider,
 * list currently served models, diff against D1, write
 * model.added/removed/updated changes, bump lastSeenAt. Listings compile to
 * RateCards (or null) before insert/update.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import {
  changes,
  endpoints,
  models,
  providers,
  schemaVersions,
} from '#/db/schema.ts'
import { isCapabilityMap } from '#/lib/capabilities.ts'
import type { CapabilityMap } from '#/lib/capabilities.ts'
import { errorMessage } from '#/server/errors.ts'
import { changedFactPaths, modelUpdatedPayload } from './change-facts.ts'
import { resolveSpecGrain } from '#/server/providers/connect.ts'
import {
  emptySources,
  mergeListingAndSchema,
  modelBranchSchemas,
  requestSchemaPropertyNames,
  schemaRung,
  walkRequestSchema,
} from '#/server/providers/fact-sources.ts'
import type { SchemaWalk } from '#/server/providers/fact-sources.ts'
import { keepValidReasoning } from '#/server/providers/reasoning-config.ts'
import { KNOWLEDGE_CUTOFF } from '#/server/providers/types.ts'
import { chatRequestMap } from '#/server/providers/request-map.ts'
import {
  parseStoredRateCard,
  reconcilePricingSource,
  storeListedPricing,
} from '#/server/rate-card.ts'
import type { RateCardRefuse } from '#/server/rate-card.ts'
import type {
  DocsFailures,
  ModelFact,
  FactSource,
  ModelFactSources,
  ModelDeprecation,
  ModelInfo,
  ProviderConfig,
} from '#/server/providers/types.ts'
import { applyDeprecations, rowDeprecation } from './deprecations.ts'
import { providerRegistry } from '#/server/providers/index.ts'
import { storedAliases } from '#/server/providers/provider-aliases.ts'
import { resolveSchemaEndpointId } from '#/server/schema-binding.ts'
import { preserveAsyncApiFlag } from './asyncapi.ts'
import {
  recordDocsFailing,
  recordPriceClearsRefused,
  recordUpdateStorm,
  updateStormOf,
} from './docs-failing.ts'
import type { DocsFailing } from './docs-failing.ts'
import {
  captureIngestEvents,
  runIngestScope,
  ingestFailedEvent,
  noteIngest,
  observePricingWrite,
} from './ingest-signals.ts'
import {
  deprecateFrozenModelsDevCatalog,
  dropModelsDevSchemaVersions,
  isModelsDevRateCard,
  markModelsDevCatalogSettled,
  nullModelsDevRateCards,
  storedCardIsPrior,
} from './retire-models-dev.ts'
import { ensureProviderRow } from './sync.ts'
import type { SyncDeps } from './sync.ts'
import {
  persistUpstreamIdentities,
  reconcileSameAs,
  sameEvidence,
} from './model-identity.ts'
import type { UpstreamIdentityWrite } from './model-identity.ts'

export interface PollOutcome {
  providerId: string
  modelsSeen: number
  added: number
  removed: number
  updated: number
  /** Rows whose firstSeenAt moved back to the upstream release date. */
  backdated: number
  /**
   * Per-row pricing misses and write-gate refusals. A thrown poll is 1
   * here as well as `error` — not only the whole-provider failure.
   */
  failures: number
  /** Docs sources that failed this poll; their rows kept stored facts. */
  docsFailures?: DocsFailures
  /** The provider's `docs-failing` record after this poll, while it fails. */
  docsFailing?: DocsFailing
  /** Price clears not applied: too many for one poll (`refusesPriceClears`). */
  priceClearsRefused?: number
  skipped?: string
  error?: string
}

/**
 * Unchanged rows per `last_seen_at … IN (…)` statement: under D1's
 * 100-parameter cap. Not smaller: each statement is a subrequest against
 * the poll invocation's 1,000 budget, shared by every provider's fetches,
 * and ~7,700 rows at 20 per statement would spend ~390 of it.
 */
export const LAST_SEEN_CHUNK = 90

/** Deterministic model row id: `${providerId}-${slugified rawId}`. */
export function modelDbId(providerId: string, rawId: string): string {
  const slug = rawId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${providerId}-${slug}`
}

/**
 * Reject obviously bogus upstream release timestamps (0, negative, or
 * pre-2015 — years before any monitored provider existed).
 */
const RELEASED_AT_FLOOR = 1_420_070_400 // 2015-01-01T00:00:00Z

/**
 * Upstream release time usable for firstSeenAt: sane, and never later than
 * the reference time (we backdate, never forward-date).
 */
function usableReleasedAt(info: ModelInfo, before: number): number | null {
  const releasedAt = info.releasedAt ?? null
  if (releasedAt === null) return null
  if (releasedAt < RELEASED_AT_FLOOR || releasedAt >= before) return null
  return releasedAt
}

/** Stable reasoning provenance. A silent docs read must be stored, not dropped. */
function reasoningSourcePath(sources: unknown): string | null {
  if (typeof sources !== 'object' || sources === null) return null
  const path = (sources as ModelFactSources).reasoning?.path
  return typeof path === 'string' ? path : null
}

/**
 * A map the listing read from the model's own request schema wins; else the
 * provider-wide table.
 */
function requestMapFor(providerId: string, info: ModelInfo) {
  return info.requestMap !== undefined
    ? info.requestMap
    : chatRequestMap(providerId, info.rawId, info.activity ?? null)
}

/**
 * A range only beside no card: a kept prior card (refused clear, docs
 * extract) is the row's one price, and a range next to it would say
 * there is none.
 */
function storedRange(info: ModelInfo) {
  return info.pricing ? null : (info.pricingRange ?? null)
}

/** The fields whose changes constitute a `model.updated` event. */
function comparable(
  providerId: string,
  info: ModelInfo,
): Record<string, unknown> {
  return {
    displayName: info.displayName ?? null,
    activity: info.activity ?? null,
    contextWindow: info.contextWindow ?? null,
    maxOutput: info.maxOutput ?? null,
    modalities: info.modalities ?? null,
    pricing: info.pricing ?? null,
    capabilities: info.capabilities ?? null,
    reasoning: info.reasoning ?? null,
    reasoningSource: reasoningSourcePath(info.factSources),
    serverTools: info.serverTools ?? null,
    requestMap: requestMapFor(providerId, info),
    aliases: storedAliases(info.aliases),
    schemaEndpointId: info.schemaEndpointId ?? null,
    deprecated: info.deprecated ?? false,
    releasedAt: info.releasedAt ?? null,
    knowledgeCutoff: info.knowledgeCutoff ?? null,
    openWeights: info.openWeights ?? null,
    weightsUrl: info.weightsUrl ?? null,
    trainsOnRequestData: info.trainsOnRequestData ?? null,
    providerMetadata: info.providerMetadata ?? null,
    pricingRange: storedRange(info),
  }
}

function isStringArray(value: unknown): value is Array<string> {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * The provider's own flag vocabulary, for the `false` entries of its
 * `exactCapabilities` rows: every flag some exact row of this poll lists.
 * Read from what the adapter emitted, never from a global list, so a flag
 * the provider has no word for is never a "no".
 * ponytail: the vocabulary is this poll's rows. When the last model that
 * lists a flag goes, the others' `false` for it turns to unknown. Give an
 * adapter a declared vocabulary if that ever churns.
 */
function exactVocabulary(listed: Array<ModelInfo>): Array<string> {
  const flags = new Set<string>()
  for (const info of listed) {
    if (info.exactCapabilities !== true) continue
    if (!isStringArray(info.capabilities)) continue
    for (const flag of info.capabilities) flags.add(flag)
  }
  return [...flags].sort()
}

/**
 * The write gate for `capabilities`: the one place a listing's flags become
 * the stored map. Listed flags are `true`, `unsupportedCapabilities` are
 * `false`, and an `exactCapabilities` row adds `false` for every flag of
 * the provider's vocabulary its list leaves out. A map with no entries is
 * null. A row that is not a flag list, or that names a flag as both
 * supported and unsupported, is not stored: the row keeps the map and
 * sources it had (null on a new row) and an `ingest_failed` event says why.
 */
function settleCapabilities(
  provider: ProviderConfig,
  info: ModelInfo,
  existing: typeof models.$inferSelect | undefined,
  vocabulary: Array<string>,
): { capabilities: CapabilityMap | null; factSources?: ModelFactSources } {
  const refuse = (why: string) => {
    noteIngest(
      ingestFailedEvent(
        'models-poll',
        provider.id,
        `${info.rawId}: capabilities not stored: ${why}`,
      ),
    )
    const { capabilities: _refused, ...sources } = info.factSources ?? {}
    const prior = (existing?.factSources as ModelFactSources | null)
      ?.capabilities
    const factSources = prior ? { ...sources, capabilities: prior } : sources
    return {
      capabilities: existing?.capabilities ?? null,
      factSources: emptySources(factSources) ? undefined : factSources,
    }
  }
  const listed = info.capabilities ?? null
  // A stored map kept as `unavailable` goes back as it is.
  if (isCapabilityMap(listed)) {
    return {
      capabilities: Object.keys(listed).length > 0 ? listed : null,
      factSources: info.factSources,
    }
  }
  if (listed !== null && !isStringArray(listed)) {
    return refuse('not a flag list')
  }
  const yes = listed ?? []
  // `absent.capabilities` speaks for the whole map, its noes included.
  const stated = info.absent?.capabilities
    ? []
    : (info.unsupportedCapabilities ?? [])
  const both = stated.filter((flag) => yes.includes(flag))
  if (both.length > 0) {
    return refuse(`${both.join(', ')} listed as both supported and unsupported`)
  }
  const sources = { ...info.factSources?.capabilities }
  const no = [...stated]
  if (info.exactCapabilities === true && listed) {
    // The list is the model's whole one: what it leaves out is a no, and
    // the document that states the list is the source of each.
    const source = Object.values(sources).at(0) ?? {
      derivation: 'listing' as const,
      sourceUrl: listingSourceUrl(provider),
    }
    for (const flag of vocabulary) {
      if (yes.includes(flag) || no.includes(flag)) continue
      no.push(flag)
      sources[flag] = { ...source, path: 'unlisted' }
    }
  }
  const map: CapabilityMap = {}
  for (const flag of yes) map[flag] = true
  for (const flag of no) map[flag] = false
  const factSources: ModelFactSources = { ...info.factSources }
  if (Object.keys(sources).length > 0) factSources.capabilities = sources
  return {
    capabilities: Object.keys(map).length > 0 ? map : null,
    factSources: emptySources(factSources) ? undefined : factSources,
  }
}

/**
 * The last word on the stated facts before the write (see the table under
 * `FactAbsence`): the flag map, the release date a row keeps, a cutoff in
 * the stored format or not at all, and a weights link only beside a stated
 * yes.
 */
function settleStatedFacts(
  provider: ProviderConfig,
  info: ModelInfo,
  existing: typeof models.$inferSelect | undefined,
  vocabulary: Array<string>,
  now: number,
): ModelInfo & { capabilities: CapabilityMap | null } {
  const releasedAt =
    info.absent?.releasedAt === 'cleared'
      ? null
      : (usableReleasedAt(info, now) ?? existing?.releasedAt ?? null)

  let knowledgeCutoff = info.knowledgeCutoff ?? null
  if (knowledgeCutoff !== null && !KNOWLEDGE_CUTOFF.test(knowledgeCutoff)) {
    noteIngest(
      ingestFailedEvent(
        'models-poll',
        provider.id,
        `${info.rawId}: knowledgeCutoff not stored: ${JSON.stringify(knowledgeCutoff)} is not YYYY-MM or YYYY-MM-DD`,
      ),
    )
    knowledgeCutoff = existing?.knowledgeCutoff ?? null
  }

  const openWeights = info.openWeights ?? null
  const weightsUrl = openWeights === true ? (info.weightsUrl ?? null) : null
  const trainsOnRequestData = info.trainsOnRequestData ?? null

  return {
    ...info,
    ...settleCapabilities(provider, info, existing, vocabulary),
    releasedAt,
    knowledgeCutoff,
    openWeights,
    weightsUrl,
    trainsOnRequestData,
  }
}

type InputWalks = {
  walks: Map<string, SchemaWalk>
  properties: Map<string, Set<string>>
  storedRoutes: Map<string, Activity>
}

/** Key for the walk of one model's branch of a `model`-discriminated body. */
function modelWalkKey(endpointId: string, rawId: string): string {
  return `${endpointId}\n${rawId}`
}

async function loadInputWalks(
  db: SyncDeps['db'],
  provider: ProviderConfig,
  listed: Array<ModelInfo>,
): Promise<InputWalks> {
  const walks = new Map<string, SchemaWalk>()
  const properties = new Map<string, Set<string>>()
  const storedRoutes = new Map<string, Activity>()
  if (provider.bindStoredRoutesWithoutSchemas === true) {
    const routes = await db
      .select({ id: endpoints.id, activity: endpoints.activity })
      .from(endpoints)
      .where(eq(endpoints.providerId, provider.id))
    for (const route of routes)
      storedRoutes.set(route.id.slice(provider.id.length + 1), route.activity)
  }
  const skipFactWalk =
    resolveSpecGrain(provider) === 'model' ||
    provider.defaultDerivation === 'generated'
  // Grain=model / generated listings skip the capability walk (thousands of
  // FAL endpoints; OpenAI-borrowed specs must not stamp flags). Still load
  // request property names when a listing already carries a RateCard so
  // invented request-bound params refuse the write.
  const needsRequestCheck = listed.some(
    (info) => parseStoredRateCard(info.pricing) !== null,
  )
  if (skipFactWalk && !needsRequestCheck) {
    return { walks, properties, storedRoutes }
  }
  const bound = new Set<string>()
  for (const info of listed) {
    const id = resolveSchemaEndpointId({
      providerId: provider.id,
      rawId: info.rawId,
      activity: info.activity ?? null,
      capabilities: info.capabilities,
      schemaEndpointId: info.schemaEndpointId,
    })
    if (id) bound.add(id)
  }
  if (bound.size === 0) return { walks, properties, storedRoutes }
  const dbIds = [...bound].map((id) => `${provider.id}/${id}`)
  const chunks: Array<Array<string>> = []
  for (let i = 0; i < dbIds.length; i += 90) {
    chunks.push(dbIds.slice(i, i + 90))
  }
  const rows = (
    await Promise.all(
      chunks.map((chunk) =>
        db
          .select({
            endpointId: schemaVersions.endpointId,
            schema: schemaVersions.schema,
            derivation: schemaVersions.derivation,
            sourceUrl: schemaVersions.sourceUrl,
            sourceHash: schemaVersions.sourceHash,
            createdAt: schemaVersions.createdAt,
          })
          .from(schemaVersions)
          .innerJoin(endpoints, eq(schemaVersions.endpointId, endpoints.id))
          .where(
            and(
              inArray(schemaVersions.endpointId, chunk),
              eq(schemaVersions.kind, 'input'),
              isNull(schemaVersions.supersededAt),
            ),
          ),
      ),
    )
  ).flat()
  const prefix = `${provider.id}/`
  for (const row of rows) {
    const publicId = row.endpointId.startsWith(prefix)
      ? row.endpointId.slice(prefix.length)
      : row.endpointId
    const parsed: unknown = JSON.parse(row.schema)
    properties.set(publicId, requestSchemaPropertyNames(parsed))
    if (skipFactWalk) continue
    const rung = schemaRung(row.derivation)
    if (rung === null) continue
    const meta = {
      derivation: rung,
      endpointId: publicId,
      sourceUrl: row.sourceUrl,
      sourceHash: row.sourceHash,
      fetchedAt: row.createdAt,
    }
    const walk = walkRequestSchema(parsed, meta)
    if (walk) walks.set(publicId, walk)
    for (const [rawId, branch] of modelBranchSchemas(parsed)) {
      const own = walkRequestSchema(branch, meta)
      if (own) walks.set(modelWalkKey(publicId, rawId), own)
    }
  }
  const perModel = new Set(provider.perModelSchemaFlags)
  if (perModel.size > 0) {
    for (const [id, walk] of walks) {
      walks.set(id, {
        ...walk,
        flags: walk.flags.filter((flag) => !perModel.has(flag)),
      })
    }
  }
  return { walks, properties, storedRoutes }
}

function logRefusedCard(
  providerId: string,
  rawId: string,
  refused: RateCardRefuse,
  hadStoredCard: boolean,
): void {
  // Uncompilable zeros/blobs are the common listing case; only log when we
  // drop a card that was already stored, or when a RateCard fails the write
  // gate (invented param / examples).
  if (refused === 'uncompilable' && !hadStoredCard) return
  console.error(
    JSON.stringify({
      job: 'models-poll',
      providerId,
      rawId,
      error: 'rate_card_refused',
      reason: refused,
    }),
  )
}

function pricingDerivation(sources: unknown): string | null {
  if (typeof sources !== 'object' || sources === null) return null
  const pricing = (sources as ModelFactSources).pricing
  return pricing?.derivation ?? null
}

function restorePriorPricing(
  next: ModelFactSources | null,
  previous: unknown,
): ModelFactSources | null {
  if (typeof previous !== 'object' || previous === null) return next
  const prior = (previous as ModelFactSources).pricing
  if (!prior) return next
  return { ...next, pricing: prior }
}

function listingSourceUrl(provider: ProviderConfig): string {
  return (
    provider.modelsEndpoint ??
    provider.specSourceUrl ??
    `https://modelschemas.com/v1/providers/${provider.id}`
  )
}

function enrichListed(
  provider: ProviderConfig,
  info: ModelInfo,
  walks: Map<string, SchemaWalk>,
): ModelInfo {
  const bound = resolveSchemaEndpointId({
    providerId: provider.id,
    rawId: info.rawId,
    activity: info.activity ?? null,
    capabilities: info.capabilities,
    schemaEndpointId: info.schemaEndpointId,
  })
  const walk = bound
    ? (walks.get(modelWalkKey(bound, info.rawId)) ?? walks.get(bound) ?? null)
    : null
  const merged = mergeListingAndSchema(info, walk)
  return {
    ...info,
    contextWindow: merged.contextWindow,
    maxOutput: merged.maxOutput,
    modalities: merged.modalities,
    pricing: merged.pricing,
    capabilities: merged.capabilities,
    factSources: merged.factSources ?? undefined,
  }
}

type StoredFact = Exclude<ModelFact, 'pricing'>

/** A stored row's facts in listing shape. With no row, every fact is empty. */
function storedFacts(
  row: typeof models.$inferSelect | undefined,
): Record<StoredFact, unknown> {
  return {
    displayName: row?.displayName ?? null,
    activity: row?.activity ?? null,
    contextWindow: row?.contextWindow ?? null,
    maxOutput: row?.maxOutput ?? null,
    modalities: row?.modalities ?? null,
    capabilities: row?.capabilities ?? null,
    reasoning: row?.reasoning ?? null,
    serverTools: row?.serverTools ?? null,
    requestMap: row?.requestMap ?? null,
    aliases: row?.aliases ?? null,
    schemaEndpointId: row?.schemaEndpointId ?? null,
    releasedAt: row?.releasedAt ?? null,
    knowledgeCutoff: row?.knowledgeCutoff ?? null,
    openWeights: row?.openWeights ?? null,
    trainsOnRequestData: row?.trainsOnRequestData ?? null,
    providerMetadata: row?.providerMetadata ?? null,
  }
}

const SOURCED_FACTS = [
  'contextWindow',
  'maxOutput',
  'modalities',
  'capabilities',
  'reasoning',
  'serverTools',
  'requestMap',
  'knowledgeCutoff',
  'openWeights',
  'trainsOnRequestData',
] as const

/** The facts `enrichListed` fills from the bound request schema. */
const WALKED_FACTS = ['capabilities'] as const

/**
 * Apply `info.absent` (see `FactAbsence`) to every fact but pricing, which
 * the card path owns: `unavailable` takes the stored value and its source,
 * `cleared` takes none. It runs twice. Before the schema walks, so a row
 * whose docs failed binds, and is checked, against its stored endpoint.
 * Then for `WALKED_FACTS` alone after the walk, which would otherwise
 * refill a kept or cleared fact.
 */
function resolveAbsent(
  info: ModelInfo,
  existing: typeof models.$inferSelect | undefined,
  only?: ReadonlyArray<StoredFact>,
): ModelInfo {
  const absent = info.absent
  if (!absent) return info
  const stored = storedFacts(existing)
  const none = storedFacts(undefined)
  const next: ModelInfo = { ...info }
  for (const fact of only ?? (Object.keys(none) as Array<StoredFact>)) {
    const why = absent[fact]
    if (!why) continue
    Object.assign(next, {
      [fact]: (why === 'unavailable' ? stored : none)[fact],
    })
    // The link is part of the open-weights fact.
    if (fact === 'openWeights') {
      next.weightsUrl =
        why === 'unavailable' ? (existing?.weightsUrl ?? null) : null
    }
  }
  const sources: ModelFactSources = { ...info.factSources }
  const prior = (existing?.factSources ?? {}) as ModelFactSources
  for (const fact of SOURCED_FACTS) {
    const why = absent[fact]
    if (!why || (only && !only.includes(fact))) continue
    delete sources[fact]
    if (why === 'unavailable' && prior[fact]) {
      Object.assign(sources, { [fact]: prior[fact] })
    }
  }
  next.factSources = emptySources(sources) ? undefined : sources
  return next
}

/**
 * One poll may not clear most of a provider's prices. `cleared` is an
 * adapter's word that a price is gone, and an adapter that misreads a
 * reshaped listing would say it for every row at once. When a poll would
 * clear at least `PRICE_CLEARS_MIN` stored cards and more than
 * `PRICE_CLEARS_SHARE` of the priced rows it lists, none of its clears is
 * applied: the cards stay and the poll logs one failure. Fewer than the
 * minimum always passes, so a small provider can still lose every price.
 * The refusal repeats every poll until the adapter or this bound changes,
 * or the stale cards are nulled by hand in D1.
 */
const PRICE_CLEARS_MIN = 5
const PRICE_CLEARS_SHARE = 0.5

/** Stored cards this poll asks to clear, when that is too many to believe. */
function refusesPriceClears(
  listed: Array<ModelInfo>,
  existingById: Map<string, typeof models.$inferSelect>,
  providerId: string,
): { clears: number; priced: number } | null {
  const clears = listed.filter(
    (info) =>
      info.absent?.pricing === 'cleared' &&
      storedCardIsPrior(
        existingById.get(modelDbId(providerId, info.rawId))?.pricing,
      ),
  ).length
  if (clears < PRICE_CLEARS_MIN) return null
  // Of the rows this poll lists: a delisted row that still holds a card
  // must not make room for clearing every live one.
  const priced = listed.filter((info) =>
    storedCardIsPrior(
      existingById.get(modelDbId(providerId, info.rawId))?.pricing,
    ),
  ).length
  return clears > priced * PRICE_CLEARS_SHARE ? { clears, priced } : null
}

export async function pollProviderModels(
  deps: SyncDeps,
  provider: ProviderConfig,
): Promise<PollOutcome> {
  const { db, secrets } = deps
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000)
  const outcome: PollOutcome = {
    providerId: provider.id,
    modelsSeen: 0,
    added: 0,
    removed: 0,
    updated: 0,
    backdated: 0,
    failures: 0,
  }
  await ensureProviderRow(db, provider)
  await dropModelsDevSchemaVersions(db, provider.id)
  await nullModelsDevRateCards(db, provider.id)

  const listed = await provider.listModels(secrets, deps.kv)
  if (listed.skipped) {
    // Not an empty list. An empty list would also drop a later first-party
    // row the next time this adapter skips.
    outcome.skipped = listed.skipped
    outcome.removed = await deprecateFrozenModelsDevCatalog(
      db,
      provider.id,
      now,
    )
    return outcome
  }
  outcome.modelsSeen = listed.models.length
  // A docs source that failed does not fail the poll: its rows carry
  // `absent: unavailable` and keep what is stored. Every failing poll says
  // so again, here and in the outcome, so an outage never goes quiet.
  const docs = listed.docsFailures
  if (docs) {
    // Kept across polls (`docs-failing.ts`): when it began, how long.
    // The record describes the poll; it must never be what fails it.
    try {
      const failing = await recordDocsFailing(db, provider.id, docs, now)
      if (failing) outcome.docsFailing = failing
    } catch (error) {
      console.error(
        JSON.stringify({
          job: 'models-poll',
          providerId: provider.id,
          error: `docs-failing record not written: ${errorMessage(error)}`,
        }),
      )
    }
  }
  if (docs && docs.failed + docs.skipped > 0) {
    outcome.docsFailures = docs
    outcome.failures += docs.failed + docs.skipped
    const report = (error: string, source?: string) => {
      console.error(
        JSON.stringify({
          job: 'models-poll',
          providerId: provider.id,
          ...(source ? { docs: source } : {}),
          error,
        }),
      )
      noteIngest(ingestFailedEvent('models-poll', provider.id, error, source))
    }
    for (const { source, error } of docs.first) report(error, source)
    // The rest are a count: a whole docs host down is one line, not eighty.
    const more = docs.failed - docs.first.length
    if (more + docs.skipped > 0) {
      report(
        `docs: ${String(more)} more failed, ${String(docs.skipped)} not attempted after the failure budget`,
      )
    }
  }

  const existingRows = await db
    .select()
    .from(models)
    .where(eq(models.providerId, provider.id))
  const existingById = new Map(existingRows.map((m) => [m.id, m]))
  // Row id → deprecations page entry; the first spelling of an id wins.
  let deprecationIndex: Map<string, ModelDeprecation> | null = null
  if (listed.deprecations) {
    deprecationIndex = new Map()
    for (const entry of listed.deprecations) {
      const id = modelDbId(provider.id, entry.rawId)
      if (!deprecationIndex.has(id)) deprecationIndex.set(id, entry)
    }
  }
  const listedModels = listed.models.map((info) =>
    resolveAbsent(info, existingById.get(modelDbId(provider.id, info.rawId))),
  )
  const { walks, properties, storedRoutes } = await loadInputWalks(
    db,
    provider,
    listedModels,
  )
  const refused = refusesPriceClears(listedModels, existingById, provider.id)
  // Kept across polls like the docs record; it cannot fail the poll.
  await recordPriceClearsRefused(db, provider.id, refused, now)
  if (refused) {
    const error = `refused to clear ${String(refused.clears)} of ${String(refused.priced)} stored prices in one poll`
    console.error(
      JSON.stringify({ job: 'models-poll', providerId: provider.id, error }),
    )
    noteIngest(ingestFailedEvent('models-poll', provider.id, error))
    outcome.priceClearsRefused = refused.clears
    outcome.failures++
  }
  const seenIds = new Set<string>()
  const identities: Array<UpstreamIdentityWrite> = []
  // Unchanged rows only need their lastSeenAt bumped; collect them and write
  // in chunked bulk UPDATEs. One-per-row writes here previously cost ~2,000
  // sequential D1 round trips per poll (~10 min wall), starving the crons.
  const cleanIds: Array<string> = []
  // Otherwise-unchanged rows that need firstSeenAt backdated. Written in
  // chunked bulk UPDATEs like cleanIds: each D1 query is a subrequest
  // against the invocation's 1,000 budget, and the first pass after deploy
  // backdates nearly every row (~1,900 across providers) — one-per-row
  // writes would exhaust the budget mid-poll.
  // The same list carries a row's first `releasedAt` (stored null, now
  // stated): after the deploy that adds the column that is every dated row.
  const backdates: Array<{
    id: string
    firstSeenAt: number
    releasedAt: number | null
  }> = []
  const vocabulary = exactVocabulary(listedModels)

  for (const listedModel of listedModels) {
    const raw =
      provider.bindSyncedRoutesOnly === true &&
      listedModel.schemaEndpointId &&
      !properties.has(listedModel.schemaEndpointId) &&
      !(
        provider.bindStoredRoutesWithoutSchemas === true &&
        storedRoutes.get(listedModel.schemaEndpointId) === listedModel.activity
      )
        ? { ...listedModel, schemaEndpointId: null }
        : listedModel
    const id = modelDbId(provider.id, raw.rawId)
    // Two raw ids can slug to one row (Mistral lists `mistral-medium-3-5`
    // and `mistral-medium-3.5`). The first spelling is the row; a later one
    // is skipped before any check, so it cannot count against the row.
    if (seenIds.has(id)) continue
    seenIds.add(id)
    const existing = existingById.get(id)
    const enriched = resolveAbsent(
      enrichListed(provider, raw, walks),
      existing,
      WALKED_FACTS,
    )
    const bound = resolveSchemaEndpointId({
      providerId: provider.id,
      rawId: enriched.rawId,
      activity: enriched.activity ?? null,
      capabilities: enriched.capabilities,
      schemaEndpointId: enriched.schemaEndpointId,
    })
    const existingPricing = existing?.pricing
    // A models.dev card is not a prior. A docs-extracted card, and any
    // other provider source, still is.
    const hadStoredCard = storedCardIsPrior(existingPricing)
    const keepExtracted =
      raw.pricing == null &&
      pricingDerivation(existing?.factSources) === 'docs-extracted' &&
      !isModelsDevRateCard(existingPricing)
    // A refused clear is treated as a source that could not be read.
    const absentPricing =
      refused && raw.absent?.pricing === 'cleared'
        ? 'unavailable'
        : raw.absent?.pricing
    // A models.dev card is foreign everywhere, OpenCode included (#314).
    const incomingPricing =
      absentPricing || isModelsDevRateCard(enriched.pricing)
        ? null
        : enriched.pricing
    const incomingNull = incomingPricing == null
    const stored =
      absentPricing === 'unavailable' ||
      (absentPricing !== 'cleared' &&
        (keepExtracted || (incomingNull && hadStoredCard)))
        ? { card: parseStoredRateCard(existingPricing) }
        : await storeListedPricing(incomingPricing, {
            existing: existingPricing,
            requestProperties: bound
              ? (properties.get(bound) ?? new Set())
              : undefined,
            sourceUrl: listingSourceUrl(provider),
            now,
          })
    const decision = observePricingWrite({
      providerId: provider.id,
      rawId: enriched.rawId,
      incomingNull,
      hadStoredCard,
      keepExtracted,
      absent: absentPricing,
      refused: stored.refused,
    })
    for (const event of decision.events) noteIngest(event)
    outcome.failures += decision.failure
    if (!keepExtracted && stored.refused) {
      logRefusedCard(provider.id, enriched.rawId, stored.refused, hadStoredCard)
    }
    const card = decision.keepPrior
      ? parseStoredRateCard(existingPricing)
      : stored.card
    let factSources = reconcilePricingSource(enriched.factSources, card)
    if (decision.keepPrior) {
      factSources = restorePriorPricing(factSources, existing?.factSources)
    }
    const info = settleStatedFacts(
      provider,
      keepValidReasoning(
        provider.id,
        { ...enriched, pricing: card, factSources: factSources ?? undefined },
        existing,
      ),
      existing,
      vocabulary,
      now,
    )
    // A listing that says there is no single price, and does not itself
    // fetch the per-route prices, keeps a range a separate job stored
    // (Vercel /endpoints, issue #451). A card on the listing clears it.
    if (
      existing &&
      info.pricingRange === undefined &&
      info.absent?.pricing === 'cleared'
    ) {
      info.pricingRange = existing.pricingRange
      const priorFacts = existing.factSources
      const priorRange =
        priorFacts &&
        typeof priorFacts === 'object' &&
        'pricingRange' in priorFacts &&
        priorFacts.pricingRange &&
        typeof priorFacts.pricingRange === 'object' &&
        'derivation' in priorFacts.pricingRange
          ? (priorFacts.pricingRange as FactSource)
          : undefined
      if (priorRange && info.pricingRange) {
        info.factSources = {
          ...info.factSources,
          pricingRange: priorRange,
        }
      }
    }
    // On the provider's deprecations page → deprecated (issue #410).
    if (rowDeprecation(deprecationIndex, id, existing?.deprecation)) {
      info.deprecated = true
    }
    const identity =
      info.upstream !== undefined
        ? info.upstream
        : (provider.upstreamModelIdentity?.(info.rawId) ?? null)
    // Only changed evidence is written: most rows restate it every poll.
    if (!sameEvidence(existing, identity)) identities.push({ id, identity })

    if (!existing) {
      await db.insert(models).values({
        id,
        providerId: provider.id,
        rawId: info.rawId,
        activity: info.activity ?? null,
        displayName: info.displayName ?? null,
        contextWindow: info.contextWindow ?? null,
        maxOutput: info.maxOutput ?? null,
        modalities: info.modalities ?? null,
        pricing: info.pricing ?? null,
        pricingRange: storedRange(info),
        capabilities: info.capabilities ?? null,
        providerMetadata: info.providerMetadata ?? null,
        reasoning: info.reasoning ?? null,
        serverTools: info.serverTools ?? null,
        requestMap: requestMapFor(provider.id, info),
        aliases: storedAliases(info.aliases),
        factSources: info.factSources ?? null,
        schemaEndpointId: info.schemaEndpointId ?? null,
        releasedAt: info.releasedAt ?? null,
        knowledgeCutoff: info.knowledgeCutoff ?? null,
        openWeights: info.openWeights ?? null,
        weightsUrl: info.weightsUrl ?? null,
        trainsOnRequestData: info.trainsOnRequestData ?? null,
        // Providers that report a release date get it as firstSeenAt, so
        // models predating our monitoring carry their historical date.
        firstSeenAt: usableReleasedAt(info, now) ?? now,
        lastSeenAt: now,
        deprecatedAt: info.deprecated ? now : null,
      })
      await db.insert(changes).values({
        id: crypto.randomUUID(),
        type: 'model.added',
        providerId: provider.id,
        subjectId: id,
        summary: `Model ${info.rawId} added`,
        createdAt: now,
      })
      outcome.added++
      continue
    }

    const before = {
      displayName: existing.displayName,
      activity: existing.activity,
      contextWindow: existing.contextWindow,
      maxOutput: existing.maxOutput,
      modalities: existing.modalities,
      pricing: existing.pricing,
      capabilities: existing.capabilities,
      reasoning: existing.reasoning,
      reasoningSource: reasoningSourcePath(existing.factSources),
      serverTools: existing.serverTools,
      requestMap: existing.requestMap,
      aliases: storedAliases(existing.aliases),
      schemaEndpointId: existing.schemaEndpointId,
      deprecated: existing.deprecatedAt !== null,
      releasedAt: existing.releasedAt,
      knowledgeCutoff: existing.knowledgeCutoff,
      openWeights: existing.openWeights,
      weightsUrl: existing.weightsUrl,
      trainsOnRequestData: existing.trainsOnRequestData,
      providerMetadata: existing.providerMetadata,
      pricingRange: existing.pricingRange,
    }
    const capabilities = preserveAsyncApiFlag(
      existing.capabilities,
      info.capabilities,
    )
    const after = comparable(provider.id, { ...info, capabilities })
    // A first `releasedAt` on a stored row is not a change to the model: we
    // learned a date it always had. It is written with the backdates, with
    // no `model.updated`. A date that moves or goes still emits one.
    const firstRelease = existing.releasedAt === null && info.releasedAt != null
    // Likewise the listing object a row gains the first time: rows written
    // before the column existed had nowhere to keep it.
    const firstMetadata =
      existing.providerMetadata === null && info.providerMetadata != null
    // Facts, not bytes: a source hash, an extract time, `+` operand order,
    // and an input's `values` order are not a change. A first release date
    // or listing object is written below with no event.
    const changed = changedFactPaths(
      {
        ...before,
        ...(firstRelease ? { releasedAt: info.releasedAt } : {}),
        ...(firstMetadata ? { providerMetadata: info.providerMetadata } : {}),
      },
      after,
    )
    const dirty = changed.length > 0

    // Upstream reports a release date earlier than our observed firstSeenAt
    // → backdate in place. A silent correction (no model.updated event):
    // it converges once per row, and the fleet-wide first pass would
    // otherwise flood the changes feed and webhook fan-out.
    const backdatedFirstSeen = usableReleasedAt(info, existing.firstSeenAt)
    if (backdatedFirstSeen !== null) outcome.backdated++

    if (!dirty) {
      if (firstMetadata) {
        // One write per row: few rows gain one (a provider's chat rows).
        await db
          .update(models)
          .set({
            providerMetadata: info.providerMetadata ?? null,
            releasedAt: info.releasedAt ?? null,
            firstSeenAt: backdatedFirstSeen ?? existing.firstSeenAt,
            lastSeenAt: now,
          })
          .where(eq(models.id, id))
      } else if (backdatedFirstSeen === null && !firstRelease) cleanIds.push(id)
      else {
        backdates.push({
          id,
          firstSeenAt: backdatedFirstSeen ?? existing.firstSeenAt,
          releasedAt: info.releasedAt ?? null,
        })
      }
      continue
    }

    await db
      .update(models)
      .set({
        lastSeenAt: now,
        ...(backdatedFirstSeen !== null
          ? { firstSeenAt: backdatedFirstSeen }
          : {}),
        displayName: info.displayName ?? null,
        activity: info.activity ?? null,
        contextWindow: info.contextWindow ?? null,
        maxOutput: info.maxOutput ?? null,
        modalities: info.modalities ?? null,
        pricing: info.pricing ?? null,
        pricingRange: storedRange(info),
        capabilities,
        providerMetadata: info.providerMetadata ?? null,
        reasoning: info.reasoning ?? null,
        serverTools: info.serverTools ?? null,
        requestMap: requestMapFor(provider.id, info),
        aliases: storedAliases(info.aliases),
        factSources: info.factSources ?? null,
        schemaEndpointId: info.schemaEndpointId ?? null,
        releasedAt: info.releasedAt ?? null,
        knowledgeCutoff: info.knowledgeCutoff ?? null,
        openWeights: info.openWeights ?? null,
        weightsUrl: info.weightsUrl ?? null,
        trainsOnRequestData: info.trainsOnRequestData ?? null,
        // A model that reappears (or upstream re-activates) clears
        // its deprecation; an upstream-deprecated one gains it.
        deprecatedAt:
          (info.deprecated ?? false) ? (existing.deprecatedAt ?? now) : null,
      })
      .where(eq(models.id, id))

    await db.insert(changes).values({
      id: crypto.randomUUID(),
      type: 'model.updated',
      providerId: provider.id,
      subjectId: id,
      summary: `Model ${info.rawId} updated`,
      payload: modelUpdatedPayload(before, after, changed),
      createdAt: now,
    })
    outcome.updated++
  }

  // Bump lastSeenAt for the unchanged majority, in small IN-lists.
  for (let i = 0; i < cleanIds.length; i += LAST_SEEN_CHUNK) {
    await db
      .update(models)
      .set({ lastSeenAt: now })
      .where(inArray(models.id, cleanIds.slice(i, i + LAST_SEEN_CHUNK)))
  }

  // Backdates carry per-row values, so bulk-update via CASE. Five bound
  // params per row (two CASE arms + IN member) + one for lastSeenAt → 19
  // rows stays under the 100-param limit.
  for (let i = 0; i < backdates.length; i += 19) {
    const chunk = backdates.slice(i, i + 19)
    const arms = (value: (b: (typeof chunk)[number]) => number | null) =>
      sql.join(
        chunk.map((b) => sql`WHEN ${b.id} THEN ${value(b)}`),
        sql` `,
      )
    await db
      .update(models)
      .set({
        firstSeenAt: sql`CASE ${models.id} ${arms((b) => b.firstSeenAt)} END`,
        releasedAt: sql`CASE ${models.id} ${arms((b) => b.releasedAt)} END`,
        lastSeenAt: now,
      })
      .where(
        inArray(
          models.id,
          chunk.map((b) => b.id),
        ),
      )
  }

  // Models in D1 the provider no longer lists → mark deprecated once.
  for (const existing of existingRows) {
    if (seenIds.has(existing.id) || existing.deprecatedAt !== null) continue
    await db
      .update(models)
      .set({ deprecatedAt: now })
      .where(eq(models.id, existing.id))
    await db.insert(changes).values({
      id: crypto.randomUUID(),
      type: 'model.removed',
      providerId: provider.id,
      subjectId: existing.id,
      summary: `Model ${existing.rawId} no longer listed`,
      createdAt: now,
    })
    outcome.removed++
  }
  if (deprecationIndex) {
    await applyDeprecations(db, provider.id, deprecationIndex, now)
  }

  const live = existingRows.filter((row) => row.deprecatedAt === null).length
  const storm = updateStormOf(outcome.updated, live)
  await recordUpdateStorm(db, provider.id, storm, now)
  if (storm) {
    const error = `update storm: ${String(storm.updated)} of ${String(storm.live)} live rows`
    console.error(
      JSON.stringify({ job: 'models-poll', providerId: provider.id, error }),
    )
    noteIngest({
      event: 'update_storm',
      properties: {
        providerId: provider.id,
        updated: storm.updated,
        live: storm.live,
      },
    })
  }

  await db
    .update(providers)
    .set({ lastPolledAt: now })
    .where(eq(providers.id, provider.id))
  await markModelsDevCatalogSettled(db, provider.id, now)
  await persistUpstreamIdentities(db, identities)

  return outcome
}

/**
 * How long to wait after D1 says its 10-second resource window is spent,
 * before the next provider (or the same-as reconcile) touches the primary.
 */
export const D1_WINDOW_WAIT_MS = 10_000

/**
 * D1 overload, and the internal-error sibling that resets the same primary.
 * Either one means the next statement in the next few seconds fails too.
 */
export function d1WindowExhausted(message: string): boolean {
  const text = message.toLowerCase()
  if (!text.includes('d1')) return false
  return text.includes('overloaded') || text.includes('internal error')
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/** Poll every registered provider with per-provider failure isolation. */
export async function pollAllProviders(
  deps: SyncDeps,
  registry: ReadonlyArray<ProviderConfig> = providerRegistry,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<Array<PollOutcome>> {
  const outcomes: Array<PollOutcome> = []
  for (const provider of registry) {
    const exhausted = await runIngestScope(async () => {
      try {
        outcomes.push(await pollProviderModels(deps, provider))
        return false
      } catch (error) {
        const message = errorMessage(error)
        // Own log line per failure: the aggregate outcomes blob can exceed
        // what Workers Logs stores, which silently loses these errors.
        console.error(
          JSON.stringify({
            job: 'models-poll',
            providerId: provider.id,
            error: message,
          }),
        )
        noteIngest(ingestFailedEvent('models-poll', provider.id, message))
        outcomes.push({
          providerId: provider.id,
          modelsSeen: 0,
          added: 0,
          removed: 0,
          updated: 0,
          backdated: 0,
          failures: 1,
          error: message,
        })
        // Not a retry of this provider. The next one would fail inside the
        // same window, so let the window close first.
        return d1WindowExhausted(message)
      } finally {
        await captureIngestEvents(deps.secrets.POSTHOG_PROJECT_KEY)
      }
    })
    if (exhausted) await wait(D1_WINDOW_WAIT_MS)
  }
  // Links span providers, so resolve them once per run, outside any one
  // provider's outcome: a failure here must not read as every poll failing.
  await runIngestScope(async () => {
    try {
      await reconcileSameAs(
        deps.db,
        deps.now?.() ?? Math.floor(Date.now() / 1000),
      )
    } catch (error) {
      const message = errorMessage(error)
      console.error(
        JSON.stringify({ job: 'same-as-reconcile', error: message }),
      )
      noteIngest(ingestFailedEvent('same-as-reconcile', '*', message))
    } finally {
      await captureIngestEvents(deps.secrets.POSTHOG_PROJECT_KEY)
    }
  })
  return outcomes
}
