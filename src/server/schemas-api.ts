/**
 * Schema read queries (PLAN.md task 4.3). Endpoint ids exposed publicly are
 * the PR #622 path-derived ids (`v1/messages`, `chat/completions`, …) — the
 * db id minus the `${providerId}/` prefix. Stored schema text is parsed and
 * re-serialised verbatim (JSON.stringify preserves insertion order), so the
 * served bytes match what the sync engine wrote to D1.
 */
import { and, eq, isNull } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { endpoints, providers, schemaVersions } from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import { halGet } from '#/server/hal.ts'
import { pinModelField, resolveEndpointAlias } from '#/server/schema-binding.ts'

export function publicEndpointId(dbId: string, providerId: string): string {
  return dbId.startsWith(`${providerId}/`)
    ? dbId.slice(providerId.length + 1)
    : dbId
}

export async function providerExists(
  db: Db,
  providerId: string,
): Promise<boolean> {
  const row = await db.query.providers.findFirst({
    where: eq(providers.id, providerId),
    columns: { id: true },
  })
  return row !== undefined
}

export interface ProviderSchemaGroup {
  provider: string
  count: number
  activities: Partial<Record<Activity, Array<string>>>
}

/**
 * GET /v1/schemas — the system-wide schema index: every provider that has
 * extracted schemas, with its activities and endpoint ids. The one URL an
 * agent (or the /schemas page) needs to discover every schema on the system.
 */
export async function getSystemSchemaIndex(db: Db) {
  const rows = await db
    .select({
      id: endpoints.id,
      providerId: endpoints.providerId,
      activity: endpoints.activity,
    })
    .from(endpoints)
    .orderBy(endpoints.id)

  const byProvider = new Map<string, ProviderSchemaGroup>()
  for (const row of rows) {
    let group = byProvider.get(row.providerId)
    if (!group) {
      group = { provider: row.providerId, count: 0, activities: {} }
      byProvider.set(row.providerId, group)
    }
    group.count++
    ;(group.activities[row.activity] ??= []).push(
      publicEndpointId(row.id, row.providerId),
    )
  }

  const providerGroups = [...byProvider.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider),
  )
  return {
    count: rows.length,
    providers: providerGroups,
    _links: {
      self: halGet('/v1/schemas'),
      provider: halGet('/v1/schemas/{provider}'),
      activity: halGet('/v1/schemas/{provider}/{activity}'),
      schema: halGet(
        '/v1/schemas/{provider}/{activity}/{endpointId}{?kind,version}',
      ),
    },
  }
}

/** GET /v1/schemas/{provider} — activities + endpoint ids. */
export async function getProviderSchemaIndex(db: Db, providerId: string) {
  const rows = await db
    .select({ id: endpoints.id, activity: endpoints.activity })
    .from(endpoints)
    .where(eq(endpoints.providerId, providerId))
    .orderBy(endpoints.id)

  const activities: Partial<Record<Activity, Array<string>>> = {}
  for (const row of rows) {
    ;(activities[row.activity] ??= []).push(
      publicEndpointId(row.id, providerId),
    )
  }
  return {
    provider: providerId,
    count: rows.length,
    activities,
    _links: {
      self: halGet(`/v1/schemas/${providerId}`),
      activity: halGet(`/v1/schemas/${providerId}/{activity}`),
      schema: halGet(
        `/v1/schemas/${providerId}/{activity}/{endpointId}{?kind,version}`,
      ),
    },
  }
}

interface SchemaPair {
  input?: unknown
  output?: unknown
}

/**
 * GET /v1/schemas/{provider}/{activity} — endpoint-id-keyed map of current
 * input/output schemas (the PR's `endpoint-schema-map` shape).
 */
export async function getActivitySchemaMap(
  db: Db,
  providerId: string,
  activity: Activity,
) {
  const rows = await db
    .select({
      endpointId: endpoints.id,
      kind: schemaVersions.kind,
      schema: schemaVersions.schema,
    })
    .from(endpoints)
    .leftJoin(
      schemaVersions,
      and(
        eq(schemaVersions.endpointId, endpoints.id),
        isNull(schemaVersions.supersededAt),
      ),
    )
    .where(
      and(
        eq(endpoints.providerId, providerId),
        eq(endpoints.activity, activity),
      ),
    )
    .orderBy(endpoints.id)

  const map: Record<string, SchemaPair> = {}
  for (const row of rows) {
    const id = publicEndpointId(row.endpointId, providerId)
    if (row.kind === 'stream') continue
    if (row.kind === null || row.schema === null) {
      map[id] = { input: null, output: null }
    } else {
      ;(map[id] ??= {})[row.kind] = JSON.parse(row.schema) as unknown
    }
  }
  return {
    provider: providerId,
    activity,
    count: Object.keys(map).length,
    endpoints: map,
    _links: {
      self: halGet(`/v1/schemas/${providerId}/${activity}`),
      schema: halGet(
        `/v1/schemas/${providerId}/${activity}/{endpointId}{?kind,version}`,
      ),
    },
  }
}

export interface SchemaProvenance {
  /** Upstream document the schema was derived from. */
  sourceUrl: string | null
  /** SHA-256 of that document as fetched (see SpecSource.hash). */
  sourceHash: string | null
  /** When this version was derived (the row's createdAt). */
  fetchedAt: number
  /** Extraction-pipeline version that produced contentHash. */
  extractorVersion: string | null
  /**
   * How the content was arrived at — a trust ladder, strongest first:
   * `upstream-spec` (extracted from a spec the provider publishes and we
   * re-fetch every sync), `generated` (derived each sync from a
   * provider-published artifact that is not a spec, e.g. SDK sources),
   * `probe-verified` (hand-written but confirmed against live API calls on
   * `verifiedAt`), `docs-derived` (hand-written from prose docs and NOT
   * confirmed). The first two self-heal; the last two are point-in-time
   * claims that can go stale. Null on versions synced before this was
   * recorded.
   */
  derivation:
    | 'upstream-spec'
    | 'generated'
    | 'probe-verified'
    | 'docs-derived'
    | null
  /**
   * `YYYY-MM-DD` the claim was last confirmed against the live API. Set for
   * `probe-verified`; null for the self-healing derivations, whose freshness
   * is `fetchedAt`.
   */
  verifiedAt: string | null
}

export function schemaProvenance(
  row: typeof schemaVersions.$inferSelect,
): SchemaProvenance {
  return {
    sourceUrl: row.sourceUrl,
    sourceHash: row.sourceHash,
    fetchedAt: row.createdAt,
    extractorVersion: row.extractorVersion,
    derivation: row.derivation,
    verifiedAt: row.verifiedAt,
  }
}

export interface EndpointSchemaResult {
  provider: string
  activity: Activity
  endpointId: string
  kind: 'input' | 'output'
  contentHash: string
  specRevision: string | null
  provenance: SchemaProvenance
  createdAt: number
  supersededAt: number | null
  schema: unknown
  /**
   * Set when `{endpointId}` was a listed model rawId/slug aliased onto
   * the canonical generation route. The served `endpointId` is that route.
   */
  aliasedFrom?: string
}

/**
 * GET /v1/schemas/{provider}/{activity}/{endpointId}?kind=&version= —
 * a single self-contained JSON Schema; current version unless a content
 * hash is passed. Returns null when the endpoint/kind/version is unknown.
 */
export async function getEndpointSchema(
  db: Db,
  providerId: string,
  activity: Activity,
  endpointId: string,
  kind: 'input' | 'output' = 'input',
  version?: string,
): Promise<EndpointSchemaResult | null> {
  const resolved = await resolveEndpointAlias(
    db,
    providerId,
    endpointId,
    activity,
  )
  if (!resolved) return null

  const row = await db.query.schemaVersions.findFirst({
    where: and(
      eq(schemaVersions.endpointId, resolved.dbId),
      eq(schemaVersions.kind, kind),
      version !== undefined
        ? eq(schemaVersions.contentHash, version)
        : isNull(schemaVersions.supersededAt),
    ),
  })
  if (!row) return null

  const schema = JSON.parse(row.schema) as unknown
  const pinned =
    resolved.pinRawId !== null && kind === 'input'
      ? pinModelField(schema, resolved.pinRawId)
      : schema

  return {
    provider: providerId,
    activity,
    endpointId: resolved.publicId,
    kind,
    contentHash: row.contentHash,
    specRevision: row.specRevision,
    provenance: schemaProvenance(row),
    createdAt: row.createdAt,
    supersededAt: row.supersededAt,
    schema: pinned,
    ...(resolved.pinRawId !== null ? { aliasedFrom: resolved.pinRawId } : {}),
  }
}

/** Endpoint-id hints for 404 remediation (capped). */
export async function knownEndpointIds(
  db: Db,
  providerId: string,
  activity?: Activity,
  limit = 25,
): Promise<Array<string>> {
  const rows = await db
    .select({ id: endpoints.id })
    .from(endpoints)
    .where(
      activity
        ? and(
            eq(endpoints.providerId, providerId),
            eq(endpoints.activity, activity),
          )
        : eq(endpoints.providerId, providerId),
    )
    .orderBy(endpoints.id)
    .limit(limit)
  return rows.map((r) => publicEndpointId(r.id, providerId))
}
