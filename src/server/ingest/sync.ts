/**
 * Sync engine (PLAN.md task 2.3): per provider — fetch spec → classify
 * endpoints → bundle schemas → diff content hashes against
 * `schema_versions` → insert new versions (reviving superseded rows when
 * upstream reverts to previously seen content), mark superseded, upsert
 * `endpoints`, write `changes` rows, warm KV with new blobs. Idempotent.
 */
import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import {
  changes,
  endpoints,
  models,
  providers,
  providerModelNamespaces,
  schemaVersions,
} from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import { seedForProvider } from '#/db/seed-providers.ts'
import { errorMessage } from '#/server/errors.ts'
import { contentHash } from '#/server/kv.ts'
import {
  isMissingSecretSkip,
  PROVENANCE_MARKER,
} from '#/server/providers/types.ts'
import type {
  BundledEndpoint,
  Derivation,
  EndpointProvenance,
  OpenApiOperation,
  ProviderConfig,
  ProviderEnvironment,
  SpecFetchResult,
  SpecSource,
} from '#/server/providers/types.ts'
import { hasAsyncApiFlag, withAsyncApiFlag } from './asyncapi.ts'
import {
  captureIngestEvents,
  ingestFailedEvent,
  noteIngest,
  runIngestScope,
} from './ingest-signals.ts'
import { providerRegistry } from '#/server/providers/index.ts'
import {
  EXTRACTOR_VERSION,
  endpointIdFromPath,
  extractEndpointSchemas,
  findDanglingRefs,
} from './bundle.ts'
import type { JsonValue } from './bundle.ts'
import { dropModelsDevSchemaVersions } from './retire-models-dev.ts'

export interface SyncDeps {
  db: Db
  kv: KVNamespace
  secrets: ProviderEnvironment
  /** Injectable clock (unix epoch seconds) for deterministic tests. */
  now?: () => number
}

export interface SyncOutcome {
  providerId: string
  endpointsSeen: number
  versionsAdded: number
  changesWritten: number
  skipped?: string
  error?: string
  warnings: Array<string>
}

export interface ClassifiedEndpoint {
  /** Globally unique db id: `${providerId}/${pathId}`. */
  dbId: string
  path: string
  /** HTTP method. GET is the BytePlus video-task retrieve call. */
  method: 'POST' | 'GET'
  activity: Activity
  description: string | null
  /** Provenance of the spec document this endpoint came from. */
  source: SpecSource | null
  /** How this endpoint's schemas were arrived at (the trust ladder). */
  derivation: Derivation
  /** `YYYY-MM-DD` a `probe-verified` claim was last confirmed. */
  verifiedAt: string | null
  input?: Record<string, JsonValue>
  output?: Record<string, JsonValue>
  /** Set only when the body is not `application/json`. */
  requestContentType: string | null
  /** Set only when the success body is not a single JSON media type. */
  responseContentTypes: Array<string> | null
  /** WMA AsyncAPI — catalog flag; skip HTTP OpenAPI assembly. */
  asyncapi?: boolean
}

function newChangeId(): string {
  return crypto.randomUUID()
}

const DERIVATIONS: ReadonlyArray<Derivation> = [
  'upstream-spec',
  'generated',
  'probe-verified',
  'docs-derived',
]

/**
 * Per-operation provenance annotation, falling back to the provider's
 * default. A malformed marker falls back too rather than throwing — a bad
 * annotation should not sink a sync.
 */
function readProvenance(
  op: OpenApiOperation,
  provider: ProviderConfig,
): { derivation: Derivation; verifiedAt: string | null } {
  const marker = op[PROVENANCE_MARKER]
  if (marker !== null && typeof marker === 'object') {
    const { derivation, verifiedAt } = marker as Partial<EndpointProvenance>
    if (typeof derivation === 'string' && DERIVATIONS.includes(derivation)) {
      return {
        derivation: derivation,
        verifiedAt: typeof verifiedAt === 'string' ? verifiedAt : null,
      }
    }
  }
  return { derivation: provider.defaultDerivation, verifiedAt: null }
}

/**
 * Classify + bundle every generation endpoint across a provider's fetched
 * specs. Pure (no storage) — shared by the sync engine and the offline
 * re-derivation script (`scripts/rederive.ts`), so both always derive
 * identical content hashes from the same upstream documents.
 */
export function classifyAndBundle(
  provider: ProviderConfig,
  fetched: SpecFetchResult,
): { endpoints: Array<ClassifiedEndpoint>; warnings: Array<string> } {
  const classified: Array<ClassifiedEndpoint> = []
  const warnings: Array<string> = []
  for (const [specIndex, spec] of fetched.specs.entries()) {
    const source = fetched.sources[specIndex] ?? null
    for (const [pathKey, operations] of Object.entries(spec.paths ?? {})) {
      const methods = ['post', 'get'] as const
      for (const method of methods) {
        const operation = operations[method]
        if (!operation) continue
        if (method === 'get' && provider.classifyGets !== true) continue
        const activity = provider.classify(pathKey, operation)
        if (activity === null) continue

        const extracted = extractEndpointSchemas(
          spec,
          pathKey,
          fetched.outputStrategy,
          method,
        )
        warnings.push(...extracted.warnings)
        for (const [kind, schema] of [
          ['input', extracted.input],
          ['output', extracted.output],
        ] as const) {
          if (schema && findDanglingRefs(schema).length > 0) {
            warnings.push(
              `${provider.id}${pathKey}: bundled ${kind} schema has dangling refs`,
            )
          }
        }
        if (
          !extracted.input &&
          !extracted.output &&
          operation['x-modelschemas-route-only'] !== true
        )
          continue

        const description =
          typeof operation.summary === 'string'
            ? operation.summary
            : typeof operation.description === 'string'
              ? operation.description
              : null
        const { derivation, verifiedAt } = readProvenance(operation, provider)
        classified.push({
          dbId: `${provider.id}/${endpointIdFromPath(pathKey)}`,
          path: pathKey,
          method: method === 'get' ? 'GET' : 'POST',
          activity,
          description,
          source,
          derivation,
          verifiedAt,
          input: extracted.input,
          output: extracted.output,
          requestContentType: storedRequestContentType(
            extracted.inputContentType,
          ),
          responseContentTypes: storedResponseContentTypes(
            extracted.outputContentTypes,
          ),
        })
      }
    }
  }
  for (const extra of fetched.bundledEndpoints ?? []) {
    if (!extra.input && !extra.output) continue
    classified.push(classifiedFromBundled(provider.id, extra, warnings))
  }
  return { endpoints: classified, warnings }
}

function asBundledSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, JsonValue> | undefined {
  return schema as Record<string, JsonValue> | undefined
}

function classifiedFromBundled(
  providerId: string,
  extra: BundledEndpoint,
  warnings: Array<string>,
): ClassifiedEndpoint {
  const input = asBundledSchema(extra.input)
  const output = asBundledSchema(extra.output)
  const pathKey = extra.path
  for (const [kind, schema] of [
    ['input', input],
    ['output', output],
  ] as const) {
    if (schema && findDanglingRefs(schema).length > 0) {
      warnings.push(
        `${providerId}${pathKey}: bundled ${kind} schema has dangling refs`,
      )
    }
  }
  return {
    dbId: `${providerId}/${extra.publicId ?? endpointIdFromPath(pathKey)}`,
    path: pathKey,
    method: 'POST',
    activity: extra.activity,
    description: extra.description,
    source: extra.source,
    derivation: extra.derivation,
    verifiedAt: extra.verifiedAt ?? null,
    input,
    output,
    requestContentType: null,
    responseContentTypes: null,
    asyncapi: extra.asyncapi,
  }
}

/** JSON is the column default, stored as null so a sync does not rewrite every row. */
function storedRequestContentType(type: string | undefined): string | null {
  if (!type || type === 'application/json') return null
  return type
}

function storedResponseContentTypes(
  types: Array<string> | undefined,
): Array<string> | null {
  if (!types || types.length === 0) return null
  if (types.length === 1 && types[0] === 'application/json') return null
  return types
}

function sameContentTypes(
  left: Array<string> | null | undefined,
  right: Array<string> | null,
): boolean {
  const a = left ?? null
  if (a === null || right === null) return a === right
  return (
    a.length === right.length && a.every((type, index) => type === right[index])
  )
}

async function applyAsyncApiCatalogFlags(
  db: Db,
  providerId: string,
  asyncApiRawIds: Array<string>,
): Promise<void> {
  const flagged = new Set(asyncApiRawIds)
  const rows = await db
    .select()
    .from(models)
    .where(eq(models.providerId, providerId))
  for (const row of rows) {
    const want = flagged.has(row.rawId)
    const has = hasAsyncApiFlag(row.capabilities)
    if (want === has) continue
    await db
      .update(models)
      .set({ capabilities: withAsyncApiFlag(row.capabilities, want) })
      .where(eq(models.id, row.id))
  }
}

/** Sync one provider. Throws only on programmer error — upstream/storage
 * failures surface in the outcome's `error` via syncAllProviders. */
/**
 * Upsert the provider's row from its registry config: refreshes the seeded
 * config columns, preserves runtime state (lastPolledAt/lastSyncedAt/status).
 * Same provider row as `scripts/seed.ts`, plus the provider's namespaces
 * (which only this writes), run automatically so a newly
 * registered provider self-heals into the DB on its first sync/poll instead
 * of waiting on a manual seed against prod.
 */
export async function ensureProviderRow(
  db: Db,
  provider: ProviderConfig,
): Promise<void> {
  const seed = seedForProvider(provider)
  if (seed === null) return
  const namespaces = provider.modelNamespaces ?? []
  // One batch: the namespace table mirrors config (a dropped name stops
  // resolving) without a second round trip on every poll.
  await db.batch([
    db
      .insert(providers)
      .values(seed)
      .onConflictDoUpdate({
        target: providers.id,
        set: {
          displayName: seed.displayName,
          specSourceUrl: seed.specSourceUrl,
          modelsEndpoint: seed.modelsEndpoint ?? null,
          authEnvVar: seed.authEnvVar ?? null,
        },
      }),
    db
      .delete(providerModelNamespaces)
      .where(
        and(
          eq(providerModelNamespaces.providerId, seed.id),
          notInArray(providerModelNamespaces.namespace, namespaces),
        ),
      ),
    ...(namespaces.length
      ? [
          db
            .insert(providerModelNamespaces)
            .values(
              namespaces.map((namespace) => ({
                namespace,
                providerId: seed.id,
              })),
            )
            .onConflictDoNothing(),
        ]
      : []),
  ])
}

/** Composite map key for an endpoint's current version of one kind. */
function versionKey(endpointId: string, kind: 'input' | 'output'): string {
  return `${endpointId}\u0000${kind}`
}

export async function syncProvider(
  deps: SyncDeps,
  provider: ProviderConfig,
): Promise<SyncOutcome> {
  const { db, secrets } = deps
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000)
  const outcome: SyncOutcome = {
    providerId: provider.id,
    endpointsSeen: 0,
    versionsAdded: 0,
    changesWritten: 0,
    warnings: [],
  }
  await ensureProviderRow(db, provider)
  await dropModelsDevSchemaVersions(db, provider.id)

  const fetched = await provider.fetchSpec(secrets)
  if (fetched.withdrawnSchemaSources?.length) {
    const withdrawn = await db
      .select({ id: schemaVersions.id })
      .from(schemaVersions)
      .innerJoin(endpoints, eq(schemaVersions.endpointId, endpoints.id))
      .where(
        and(
          eq(endpoints.providerId, provider.id),
          isNull(schemaVersions.supersededAt),
          inArray(schemaVersions.sourceUrl, fetched.withdrawnSchemaSources),
        ),
      )
    for (let i = 0; i < withdrawn.length; i += 90) {
      await db
        .update(schemaVersions)
        .set({ supersededAt: now })
        .where(
          inArray(
            schemaVersions.id,
            withdrawn.slice(i, i + 90).map((row) => row.id),
          ),
        )
    }
    if (withdrawn.length)
      outcome.warnings.push(
        `Withdrew ${withdrawn.length} schema versions from rejected former sources`,
      )
  }
  if (fetched.warnings) outcome.warnings.push(...fetched.warnings)
  if (fetched.skipped) {
    outcome.skipped = fetched.skipped
    outcome.warnings.push(fetched.skipped)
    // Any skip other than the missing-secret suffix is by design, so the
    // provider is active again. `lastSyncedAt` is written only on the
    // non-skip path below.
    if (!isMissingSecretSkip(fetched.skipped)) {
      await db
        .update(providers)
        .set({ status: 'active' })
        .where(eq(providers.id, provider.id))
    }
    return outcome
  }

  const { endpoints: classified, warnings } = classifyAndBundle(
    provider,
    fetched,
  )
  outcome.warnings.push(...warnings)
  outcome.endpointsSeen = classified.length

  const existingEndpoints = await db
    .select()
    .from(endpoints)
    .where(eq(endpoints.providerId, provider.id))
  const existingById = new Map(existingEndpoints.map((e) => [e.id, e]))

  // Current (non-superseded) versions for the whole provider in one query.
  // Per-endpoint lookups here are 2 D1 round trips per endpoint — FAL alone
  // has ~1,400 endpoints, which blows the invocation's 1,000-subrequest
  // budget (and its wall clock) before the sync can complete, leaving the
  // provider stuck degraded. Same batching treatment as poll-models.
  const currentVersionRows = await db
    .select({
      id: schemaVersions.id,
      endpointId: schemaVersions.endpointId,
      kind: schemaVersions.kind,
      contentHash: schemaVersions.contentHash,
    })
    .from(schemaVersions)
    .innerJoin(endpoints, eq(schemaVersions.endpointId, endpoints.id))
    .where(
      and(
        eq(endpoints.providerId, provider.id),
        isNull(schemaVersions.supersededAt),
      ),
    )
  const currentByEndpointKind = new Map(
    currentVersionRows.map((v) => [versionKey(v.endpointId, v.kind), v]),
  )

  for (const endpoint of classified) {
    const existing = existingById.get(endpoint.dbId)
    if (!existing) {
      // The row and its change in one batch: a run that dies between them
      // would otherwise leave an endpoint whose `endpoint.added` is never
      // written, since later runs find the row and skip it.
      await db.batch([
        db.insert(endpoints).values({
          id: endpoint.dbId,
          providerId: provider.id,
          activity: endpoint.activity,
          method: endpoint.method,
          path: endpoint.path,
          description: endpoint.description,
          requestContentType: endpoint.requestContentType,
          responseContentTypes: endpoint.responseContentTypes,
        }),
        db.insert(changes).values({
          id: newChangeId(),
          type: 'endpoint.added',
          providerId: provider.id,
          subjectId: endpoint.dbId,
          summary: `Endpoint ${endpoint.path} added (${endpoint.activity})`,
          createdAt: now,
        }),
      ])
      outcome.changesWritten++
    } else if (
      existing.activity !== endpoint.activity ||
      existing.description !== endpoint.description ||
      existing.requestContentType !== endpoint.requestContentType ||
      !sameContentTypes(
        existing.responseContentTypes,
        endpoint.responseContentTypes,
      )
    ) {
      await db
        .update(endpoints)
        .set({
          activity: endpoint.activity,
          description: endpoint.description,
          requestContentType: endpoint.requestContentType,
          responseContentTypes: endpoint.responseContentTypes,
        })
        .where(eq(endpoints.id, endpoint.dbId))
    }

    for (const [kind, schema] of [
      ['input', endpoint.input],
      ['output', endpoint.output],
    ] as const) {
      if (!schema) continue
      const hash = await contentHash(schema)
      const current = currentByEndpointKind.get(versionKey(endpoint.dbId, kind))
      if (current?.contentHash === hash) continue

      // The id is deterministic on content, so when upstream reverts to a
      // previously served schema (A → B → A) the row already exists as a
      // superseded version — revive it instead of colliding on the insert.
      const insert = db
        .insert(schemaVersions)
        .values({
          id: `${endpoint.dbId}:${kind}:${hash.slice(0, 16)}`,
          endpointId: endpoint.dbId,
          kind,
          contentHash: hash,
          schema: JSON.stringify(schema),
          specRevision: fetched.specRevision ?? null,
          sourceUrl: endpoint.source?.url ?? null,
          sourceHash: endpoint.source?.hash ?? null,
          extractorVersion: EXTRACTOR_VERSION,
          derivation: endpoint.derivation,
          verifiedAt: endpoint.verifiedAt,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: schemaVersions.id,
          set: {
            supersededAt: null,
            specRevision: fetched.specRevision ?? null,
            sourceUrl: endpoint.source?.url ?? null,
            sourceHash: endpoint.source?.hash ?? null,
            extractorVersion: EXTRACTOR_VERSION,
            derivation: endpoint.derivation,
            verifiedAt: endpoint.verifiedAt,
            createdAt: now,
          },
        })
      const change = db.insert(changes).values({
        id: newChangeId(),
        type: current ? 'schema.updated' : 'schema.added',
        providerId: provider.id,
        subjectId: endpoint.dbId,
        summary: `${current ? 'Updated' : 'Added'} ${kind} schema for ${endpoint.path}`,
        payload: {
          kind,
          contentHash: hash,
          previousHash: current?.contentHash ?? null,
        },
        createdAt: now,
      })
      // One batch, so a run that dies here never leaves two current rows,
      // nor a current row with no change, which no later run would write:
      // the next run finds the hash current and skips it.
      if (current) {
        await db.batch([
          db
            .update(schemaVersions)
            .set({ supersededAt: now })
            .where(eq(schemaVersions.id, current.id)),
          insert,
          change,
        ])
      } else {
        await db.batch([insert, change])
      }
      outcome.versionsAdded++
      outcome.changesWritten++
    }
  }

  // Endpoints in D1 that vanished from the spec: record the removal but keep
  // the rows — schema version history stays queryable. The already-recorded
  // set loads in one query: vanished endpoints accumulate for good (rows are
  // kept), so per-endpoint lookups would cost one subrequest each, forever.
  const seenIds = new Set(classified.map((e) => e.dbId))
  const removalRows = await db
    .select({ subjectId: changes.subjectId })
    .from(changes)
    .where(
      and(
        eq(changes.type, 'endpoint.removed'),
        eq(changes.providerId, provider.id),
      ),
    )
  const alreadyRemovedIds = new Set(removalRows.map((r) => r.subjectId))
  for (const existing of existingEndpoints) {
    if (seenIds.has(existing.id)) continue
    if (alreadyRemovedIds.has(existing.id)) continue
    await db.insert(changes).values({
      id: newChangeId(),
      type: 'endpoint.removed',
      providerId: provider.id,
      subjectId: existing.id,
      summary: `Endpoint ${existing.path} removed from the ${provider.id} spec`,
      createdAt: now,
    })
    outcome.changesWritten++
  }

  if (fetched.asyncApiRawIds !== undefined) {
    await applyAsyncApiCatalogFlags(db, provider.id, fetched.asyncApiRawIds)
  }

  await db
    .update(providers)
    .set({ lastSyncedAt: now, status: 'active' })
    .where(eq(providers.id, provider.id))

  return outcome
}

/**
 * Spec-sync shard schedule: each cron fires its own Worker invocation with
 * a fresh subrequest/CPU/memory budget, so one provider's blowup can't
 * starve the providers behind it (production data: FAL's oversized sync
 * killed the shared 05:00 run mid-flight daily, leaving every provider
 * after it in the registry permanently unsynced). Shard 0 is FAL alone —
 * by far the largest (~1,400 per-model specs); the rest of the registry
 * round-robins across the remaining shards, which also spreads the other
 * big-spec providers (they're adjacent in the registry). Keep this array
 * in lockstep with `triggers.crons` in wrangler.jsonc.
 */
export const SPEC_SYNC_SHARD_CRONS = [
  '0 5 * * *',
  '10 5 * * *',
  '20 5 * * *',
  '30 5 * * *',
] as const

export function specSyncShard(shardIndex: number): Array<ProviderConfig> {
  const rest = providerRegistry.filter((p) => p.id !== 'fal')
  if (shardIndex === 0) return providerRegistry.filter((p) => p.id === 'fal')
  const restShards = SPEC_SYNC_SHARD_CRONS.length - 1
  return rest.filter((_, i) => i % restShards === shardIndex - 1)
}

/**
 * Sync the given providers (default: the full registry), sequentially
 * (subrequest limits), with per-provider isolation: one provider's outage
 * doesn't sink the run.
 */
export async function syncAllProviders(
  deps: SyncDeps,
  providersToSync: Array<ProviderConfig> = providerRegistry,
): Promise<Array<SyncOutcome>> {
  const outcomes: Array<SyncOutcome> = []
  for (const provider of providersToSync) {
    await runIngestScope(async () => {
      try {
        outcomes.push(await syncProvider(deps, provider))
      } catch (error) {
        const message = errorMessage(error)
        // Own log line per failure: the aggregate outcomes blob can exceed
        // what Workers Logs stores, which silently loses these errors.
        console.error(
          JSON.stringify({
            job: 'spec-sync',
            providerId: provider.id,
            error: message,
          }),
        )
        noteIngest(ingestFailedEvent('spec-sync', provider.id, message))
        outcomes.push({
          providerId: provider.id,
          endpointsSeen: 0,
          versionsAdded: 0,
          changesWritten: 0,
          error: message,
          warnings: [],
        })
        try {
          await deps.db
            .update(providers)
            .set({ status: 'degraded' })
            .where(eq(providers.id, provider.id))
        } catch (statusError) {
          // Best-effort: if the failure was resource exhaustion (subrequest
          // budget), this write fails too — don't let it sink the run.
          console.error(
            JSON.stringify({
              job: 'spec-sync',
              providerId: provider.id,
              error: `degraded-status write failed: ${errorMessage(statusError)}`,
            }),
          )
          noteIngest(
            ingestFailedEvent(
              'spec-sync',
              provider.id,
              `degraded-status write failed: ${errorMessage(statusError)}`,
            ),
          )
        }
      } finally {
        await captureIngestEvents(deps.secrets.POSTHOG_PROJECT_KEY)
      }
    })
  }
  return outcomes
}
