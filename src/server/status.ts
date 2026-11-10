import { and, count, eq, isNull, sql } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import {
  cacheMeta,
  endpoints,
  models,
  providers,
  schemaVersions,
} from '#/db/schema.ts'
import { FACT_KEYS, buildReport, scoredFacts } from '#/lib/completeness.ts'
import type { FactKey, Ledger, ModelRow } from '#/lib/completeness.ts'
import { errorMessage } from '#/server/errors.ts'
import { readIngestRecords } from '#/server/ingest/docs-failing.ts'
import type {
  DocsFailing,
  PriceClearsRefused,
  UpdateStorm,
} from '#/server/ingest/docs-failing.ts'
import { providerRegistry } from '#/server/providers/index.ts'
import { servePricing } from '#/server/rate-card.ts'
import { resolveSchemaEndpointId } from '#/server/schema-binding.ts'
import { staleProbeCount } from '#/server/providers/probes/index.ts'
import { sourceSilentLedger } from '#/server/source-silent.ts'

/**
 * The gap-report score (`#/lib/completeness.ts`) over the provider's live
 * chat models: `filled / needed`, the same number `bun run gap:report`
 * prints.
 */
export interface Completeness {
  /**
   * 0 to 1. Null when the provider has no live chat models, and when
   * there is no current score: none computed yet, or the provider's chat
   * models changed since the last poll scored them. The CLI prints n/a
   * for a provider that does not serve chat, and 0 when classification
   * produced no chat rows.
   */
  score: number | null
  /** Live chat models scored. */
  chat: number
  /** Facts carried, summed over those models; `silent` facts left out. */
  filled: number
  /** Facts that apply, summed over those models; `silent` facts left out. */
  needed: number
  /** Facts the provider does not publish (`docs/source-silent`). */
  silent: Array<FactKey>
}

export interface ProviderStatus {
  id: string
  displayName: string
  /** `pending` = registered in code but not yet synced into the DB. */
  status: 'active' | 'degraded' | 'disabled' | 'pending'
  lastPolledAt: number | null
  lastSyncedAt: number | null
  /**
   * Present while the provider's docs pages fail to load: polls go on and
   * rows keep their stored docs-derived facts. Does not change `status`.
   */
  docsFailing?: DocsFailing
  /**
   * Present while polls refuse a mass price clear: the stored prices stay.
   * Does not change `status`.
   */
  priceClearsRefused?: PriceClearsRefused
  /**
   * Probe records older than 90 days. The facts stay served. Present only
   * when the count is above zero. Does not change `status`.
   */
  staleProbes?: number
  /**
   * Present while the latest poll wrote `model.updated` for more than half
   * of the live rows, and at least 20. The updates are written; this only
   * marks a catalog-wide rewrite. Does not change `status`.
   */
  updateStorm?: UpdateStorm
  completeness: Completeness
  /** Model tallies count live rows: what `GET /v1/models` lists by default. */
  counts: {
    models: number
    /** Models with a stored rate card. */
    priced: number
    /** Models with stored reasoning metadata. */
    reasoning: number
    /** Models whose activity is `chat`. */
    chat: number
    /** Models no longer listed upstream; in none of the tallies above. */
    deprecated: number
    endpoints: number
    schemas: number
  }
}

export interface ServiceStatus {
  service: 'modelschemas'
  time: number
  /**
   * Epoch seconds the `completeness` scores were computed (the last models
   * poll), or null when there is no record and every score is null.
   */
  completenessComputedAt: number | null
  providers: Array<ProviderStatus>
}

/** A tally of live rows, optionally only those matching `where`. */
const live = (where = sql`1`) =>
  sql<number>`count(case when ${models.deprecatedAt} is null and ${where} then 1 end)`

/**
 * The `cache_meta` row holding every provider's score: `fetched_at` is when
 * it was computed, `last_error` the JSON. Scoring reads every live chat
 * row's JSON facts (about 2 MB on the full catalog), so the 15-minute poll
 * computes it once (`recordCompleteness`) and requests only read the row.
 * Bump the version when the scorer or the `Completeness` shape changes: the
 * old row then reads as no record, and scores are null until the next poll.
 */
const COMPLETENESS_KEY = 'status:completeness:v2'

/**
 * Completeness of every provider with live chat rows. One query, only the
 * columns the score reads, each row shaped as `GET /v1/models?pricing=1`
 * serves it (`toApiModel`) so this and the CLI score the same thing.
 */
async function scoreCompleteness(
  db: Db,
  ledger: Ledger,
): Promise<Record<string, Completeness>> {
  const rows = await db
    .select({
      providerId: models.providerId,
      rawId: models.rawId,
      activity: models.activity,
      contextWindow: models.contextWindow,
      maxOutput: models.maxOutput,
      modalities: models.modalities,
      pricing: models.pricing,
      capabilities: models.capabilities,
      reasoning: models.reasoning,
      requestMap: models.requestMap,
      schemaEndpointId: models.schemaEndpointId,
      factSources: models.factSources,
    })
    .from(models)
    .where(and(eq(models.activity, 'chat'), isNull(models.deprecatedAt)))
  const report = buildReport(
    rows.map((row): ModelRow => ({
      provider: row.providerId,
      rawId: row.rawId,
      activity: row.activity,
      contextWindow: row.contextWindow,
      maxOutput: row.maxOutput,
      // JSON columns: the scorer checks what it reads of each.
      modalities: row.modalities as ModelRow['modalities'],
      pricing: servePricing(row.pricing, 'full') as ModelRow['pricing'],
      capabilities: row.capabilities,
      reasoning: row.reasoning as ModelRow['reasoning'],
      requestMap: row.requestMap,
      schemaEndpointId: resolveSchemaEndpointId(row),
      factSources: row.factSources as ModelRow['factSources'],
    })),
    ledger,
  )
  return Object.fromEntries(
    report.providers.map((provider) => {
      const { have, need } = scoredFacts(provider)
      return [
        provider.provider,
        {
          score: provider.score,
          chat: provider.chat,
          filled: have,
          needed: need,
          silent: provider.silent,
        },
      ]
    }),
  )
}

const logCompleteness = (error: unknown) => {
  console.error(
    JSON.stringify({ job: 'completeness', error: errorMessage(error) }),
  )
}

/** A stored entry is served only if it is wholly a `Completeness`. */
function isCompleteness(value: unknown): value is Completeness {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<Record<keyof Completeness, unknown>>
  return (
    (entry.score === null || typeof entry.score === 'number') &&
    typeof entry.chat === 'number' &&
    typeof entry.filled === 'number' &&
    typeof entry.needed === 'number' &&
    Array.isArray(entry.silent) &&
    entry.silent.every((fact) => typeof fact === 'string')
  )
}

/**
 * Score every provider and store the result, after the models poll. Never
 * throws: a failure is logged and the previous record stays. Returns
 * whether a new record was written.
 */
export async function recordCompleteness(
  db: Db,
  now = Math.floor(Date.now() / 1000),
  ledger: Ledger = sourceSilentLedger,
): Promise<boolean> {
  try {
    const lastError = JSON.stringify(await scoreCompleteness(db, ledger))
    await db
      .insert(cacheMeta)
      .values({
        key: COMPLETENESS_KEY,
        fetchedAt: now,
        staleTime: 0,
        lastError,
      })
      .onConflictDoUpdate({
        target: cacheMeta.key,
        set: { fetchedAt: now, lastError },
      })
    return true
  } catch (error) {
    logCompleteness(error)
    return false
  }
}

/**
 * The stored scores. A missing, unreadable or misshapen record is no
 * record: every score is then null and the request goes on.
 */
async function readCompleteness(db: Db): Promise<{
  computedAt: number | null
  scores: Partial<Record<string, Completeness>>
}> {
  try {
    const row = await db.query.cacheMeta.findFirst({
      where: eq(cacheMeta.key, COMPLETENESS_KEY),
    })
    if (row?.lastError) {
      const stored: unknown = JSON.parse(row.lastError)
      if (typeof stored === 'object' && stored !== null) {
        const entries = Object.entries(stored)
        const valid = entries.filter(([, entry]) => isCompleteness(entry))
        // Entries and none of them usable is no record either.
        if (
          !Array.isArray(stored) &&
          (valid.length > 0 || entries.length === 0)
        ) {
          return {
            computedAt: row.fetchedAt,
            scores: Object.fromEntries(valid),
          }
        }
      }
    }
  } catch (error) {
    logCompleteness(error)
  }
  return { computedAt: null, scores: {} }
}

/**
 * Public per-provider sync status + row counts (GET /v1/status).
 *
 * The provider REGISTRY (code) is the source of truth for which providers
 * exist; the DB carries runtime state. Registered providers whose first
 * sync hasn't landed yet still appear — as `pending` with zero counts — so
 * the listing is always the full roster, for humans and agents alike.
 */
function staleProbeField(
  providerId: string,
  nowSeconds: number,
): { staleProbes?: number } {
  const stale = staleProbeCount(providerId, new Date(nowSeconds * 1000))
  return stale > 0 ? { staleProbes: stale } : {}
}

export async function getServiceStatus(
  db: Db,
  now = Math.floor(Date.now() / 1000),
): Promise<ServiceStatus> {
  const [
    providerRows,
    records,
    { computedAt, scores },
    modelCounts,
    endpointCounts,
    schemaCounts,
  ] = await Promise.all([
    db.select().from(providers),
    // One statement for every provider's docs-failing, refused-clears, and update-storm row.
    readIngestRecords(db),
    readCompleteness(db),
    // One pass yields every model tally. Deprecated rows are counted apart:
    // the catalog hides them, and a provider's count must match its list.
    db
      .select({
        providerId: models.providerId,
        models: live(),
        priced: live(sql`${models.pricing} is not null`),
        reasoning: live(sql`${models.reasoning} is not null`),
        chat: live(sql`${models.activity} = 'chat'`),
        deprecated: count(models.deprecatedAt),
      })
      .from(models)
      .groupBy(models.providerId),
    db
      .select({ providerId: endpoints.providerId, n: count() })
      .from(endpoints)
      .groupBy(endpoints.providerId),
    // Current (non-superseded) schema versions per provider.
    db
      .select({ providerId: endpoints.providerId, n: count() })
      .from(schemaVersions)
      .innerJoin(endpoints, eq(schemaVersions.endpointId, endpoints.id))
      .where(isNull(schemaVersions.supersededAt))
      .groupBy(endpoints.providerId),
  ])

  const toMap = (rows: Array<{ providerId: string; n: number }>) =>
    new Map(rows.map((r) => [r.providerId, r.n]))
  const modelsBy = new Map(modelCounts.map((r) => [r.providerId, r]))
  const endpointsBy = toMap(endpointCounts)
  const schemasBy = toMap(schemaCounts)
  // The record is as old as the last poll. It is served only for a provider
  // whose live chat count still equals the count it scored, so a score never
  // sits over a different row set; that also makes no chat rows a null, not
  // a zero.
  const completeness = (providerId: string): Completeness => {
    const scored = scores[providerId]
    const chat = modelsBy.get(providerId)?.chat ?? 0
    if (chat > 0 && scored?.chat === chat) return scored
    return {
      score: null,
      chat: 0,
      filled: 0,
      needed: 0,
      silent: FACT_KEYS.filter((key) =>
        sourceSilentLedger.get(providerId)?.has(key),
      ),
    }
  }

  const byId = new Map<string, ProviderStatus>()
  for (const p of providerRows) {
    byId.set(p.id, {
      id: p.id,
      displayName: p.displayName,
      status: p.status,
      lastPolledAt: p.lastPolledAt,
      lastSyncedAt: p.lastSyncedAt,
      ...records.get(p.id),
      ...staleProbeField(p.id, now),
      completeness: completeness(p.id),
      counts: {
        models: modelsBy.get(p.id)?.models ?? 0,
        priced: modelsBy.get(p.id)?.priced ?? 0,
        reasoning: modelsBy.get(p.id)?.reasoning ?? 0,
        chat: modelsBy.get(p.id)?.chat ?? 0,
        deprecated: modelsBy.get(p.id)?.deprecated ?? 0,
        endpoints: endpointsBy.get(p.id) ?? 0,
        schemas: schemasBy.get(p.id) ?? 0,
      },
    })
  }
  // Registered but not yet in the DB (fresh adapter, seed not run).
  for (const config of providerRegistry) {
    if (byId.has(config.id)) continue
    byId.set(config.id, {
      id: config.id,
      displayName: config.displayName,
      status: 'pending',
      lastPolledAt: null,
      lastSyncedAt: null,
      ...staleProbeField(config.id, now),
      completeness: completeness(config.id),
      counts: {
        models: 0,
        priced: 0,
        reasoning: 0,
        chat: 0,
        deprecated: 0,
        endpoints: 0,
        schemas: 0,
      },
    })
  }

  return {
    service: 'modelschemas',
    time: now,
    completenessComputedAt: computedAt,
    providers: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
  }
}
