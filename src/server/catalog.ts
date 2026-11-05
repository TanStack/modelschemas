/**
 * Catalog queries (PLAN.md task 4.2): providers, cross-provider model
 * catalog with filters, and single-model detail. Route handlers stay thin —
 * these functions are exercised directly by worker tests.
 */
import { and, eq, inArray, isNull, like, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'

import type { Db } from '#/db/index.ts'
import { models, providers } from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import { halGet } from '#/server/hal.ts'
import { getProvider } from '#/server/providers/index.ts'
import { resolveSpecGrain } from '#/server/providers/connect.ts'
import type {
  FactSource,
  ModelFactSources,
  SpecGrain,
} from '#/server/providers/types.ts'
import {
  factDiscrepancies,
  openRouterJoinIds,
} from '#/server/providers/fact-sources.ts'
import {
  resolveAlias,
  storedAliases,
} from '#/server/providers/provider-aliases.ts'
import { servePricing } from '#/server/rate-card.ts'
import { openCodeGoFacts } from '#/server/providers/opencode-go-facts.ts'
import { resolveSchemaEndpointId } from '#/server/schema-binding.ts'
import { getServiceStatus } from '#/server/status.ts'
import { sourceSilentEvidenceLedger } from './source-silent.ts'
import { withSourceSilentEvidence } from './source-silent-facts.ts'

export interface ModelFilters {
  activity?: Activity
  provider?: string
  /** A flag the model's capability map states as `true`. */
  capability?: string
  /** Free-text match against id, raw id, and display name. */
  q?: string
  /** Deprecated models are excluded unless set. */
  includeDeprecated?: boolean
  /** Include per-field `factSources` by default; false explicitly omits them. */
  provenance?: boolean
  /** Include the full rate card on list rows (default: compact projection). */
  pricing?: boolean
}

const OPENAPI_CONTENT_TYPE = 'application/openapi+json'

function modelLinks(providerId: string) {
  const openapi = openApiLink(providerId)
  return {
    provider: halGet(`/v1/providers/${providerId}/models`),
    schemas: halGet(`/v1/schemas/${providerId}`),
    ...(openapi ? { openapi } : {}),
  }
}

function openApiLink(providerId: string) {
  const config = getProvider(providerId)
  if (!config?.connect) return undefined
  const grain = resolveSpecGrain(config)
  if (grain === 'model') {
    return halGet(`/v1/openapi/${providerId}{?model,activity}`, {
      contentType: OPENAPI_CONTENT_TYPE,
      example: `/v1/openapi/${providerId}?model=fal-ai/flux/dev`,
    })
  }
  return halGet(`/v1/openapi/${providerId}`, {
    contentType: OPENAPI_CONTENT_TYPE,
  })
}

function specDescriptor(
  providerId: string,
  endpointCount: number,
): { grain: SpecGrain; endpointCount: number } {
  return {
    grain: resolveSpecGrain(getProvider(providerId)),
    endpointCount,
  }
}

type ModelRow = typeof models.$inferSelect

const upstreamModel = alias(models, 'upstream_model')
const catalogSelection = {
  row: models,
  upstream: {
    provider: upstreamModel.providerId,
    rawId: upstreamModel.rawId,
    aliases: upstreamModel.aliases,
  },
}
interface UpstreamRow {
  provider: string
  rawId: string
  aliases: Array<string> | null
}

// The stored link is only as fresh as the last reconcile, so it is served
// only while the row's current evidence still names that target. The
// evidence is its provenance: a link with no source, or a source with no
// link, would each read as a claim nobody made.
function linkMatch(
  row: ModelRow,
  upstream: UpstreamRow | null | undefined,
): 'published' | 'normalized' | null {
  const stated = row.upstreamRawId
  if (!upstream || stated === null || !row.upstreamSource) return null
  const ids = [upstream.rawId, ...(upstream.aliases ?? [])]
  if (ids.includes(stated)) return 'published'
  return ids.includes(stated.replaceAll('.', '-')) ? 'normalized' : null
}

function modelFactSources(
  row: ModelRow,
  match: ReturnType<typeof linkMatch>,
): ModelFactSources | null {
  const stored = (row.factSources as ModelFactSources | null) ?? null
  const go = openCodeGoFacts(row.providerId, row.rawId).factSources
  const withGo = Object.keys(go).length === 0 ? stored : { ...stored, ...go }
  // A privacy-table yes is stored on the row and wins over the probe.
  // A probe still fills an id the table does not name.
  const trainingSource =
    row.trainsOnRequestData === true && stored?.trainsOnRequestData
      ? stored.trainsOnRequestData
      : withGo?.trainsOnRequestData
  const merged =
    trainingSource && withGo
      ? { ...withGo, trainsOnRequestData: trainingSource }
      : withGo
  if (match === null) return merged
  const source = row.upstreamSource as FactSource
  return {
    ...merged,
    sameAs: match === 'published' ? source : { ...source, normalized: true },
  }
}

function encodeEndpointId(endpointId: string): string {
  return endpointId.split('/').map(encodeURIComponent).join('/')
}

function toApiModel(
  row: ModelRow,
  opts: {
    includeFactSources?: boolean
    pricing?: 'compact' | 'full'
    upstream?: UpstreamRow | null
  } = {},
) {
  const schemaEndpointId = resolveSchemaEndpointId({
    providerId: row.providerId,
    rawId: row.rawId,
    activity: row.activity,
    capabilities: row.capabilities,
    schemaEndpointId: row.schemaEndpointId,
  })
  const schemaPath =
    schemaEndpointId !== null && row.activity !== null
      ? `/v1/schemas/${row.providerId}/${row.activity}/${encodeEndpointId(schemaEndpointId)}`
      : null
  const schemaLink =
    schemaPath === null
      ? undefined
      : halGet(schemaPath, { example: `${schemaPath}?kind=input` })
  const match = linkMatch(row, opts.upstream)
  const go = openCodeGoFacts(row.providerId, row.rawId)
  return {
    id: row.id,
    provider: row.providerId,
    rawId: row.rawId,
    sameAs:
      match && opts.upstream
        ? { provider: opts.upstream.provider, rawId: opts.upstream.rawId }
        : null,
    activity: row.activity,
    displayName: row.displayName,
    schemaEndpointId,
    contextWindow: row.contextWindow,
    maxOutput: row.maxOutput,
    modalities: row.modalities,
    pricing: servePricing(row.pricing, opts.pricing ?? 'compact'),
    pricingRange: row.pricingRange ?? null,
    capabilities: row.capabilities,
    providerMetadata: row.providerMetadata,
    reasoning: row.reasoning,
    serverTools: row.serverTools,
    requestMap: row.requestMap,
    requiredRequestHeaders: go.requiredRequestHeaders,
    trainsOnRequestData:
      row.trainsOnRequestData === true ? true : go.trainsOnRequestData,
    aliases: storedAliases(row.aliases),
    releasedAt: row.releasedAt,
    knowledgeCutoff: row.knowledgeCutoff,
    openWeights: row.openWeights,
    weightsUrl: row.weightsUrl,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    deprecatedAt: row.deprecatedAt,
    deprecation: row.deprecation,
    ...(opts.includeFactSources !== false
      ? {
          factSources: withSourceSilentEvidence(
            row,
            schemaEndpointId,
            modelFactSources(row, match),
            sourceSilentEvidenceLedger,
          ),
        }
      : {}),
    _links: {
      ...modelLinks(row.providerId),
      ...(schemaLink ? { schema: schemaLink } : {}),
    },
  }
}

export type ApiModel = ReturnType<typeof toApiModel>

function providerLinks(providerId: string) {
  const openapi = openApiLink(providerId)
  return {
    self: halGet(`/v1/providers/${providerId}`),
    models: halGet(`/v1/providers/${providerId}/models`),
    schemas: halGet(`/v1/schemas/${providerId}`),
    ...(openapi ? { openapi } : {}),
  }
}

/** GET /v1/providers — status, counts, spec grain, and links. */
export async function listProvidersCatalog(db: Db) {
  const status = await getServiceStatus(db)
  return {
    providers: status.providers.map((p) => ({
      ...p,
      spec: specDescriptor(p.id, p.counts.endpoints),
      _links: providerLinks(p.id),
    })),
    _links: { self: halGet('/v1/providers'), catalog: halGet('/v1/models') },
  }
}

/**
 * GET /v1/providers/{provider} — one provider's status row plus live model
 * counts per activity: the `?activity=` values `GET /v1/openapi/{provider}`
 * and `GET /v1/models` accept. Null for an unknown provider.
 */
export async function getProviderCatalog(db: Db, providerId: string) {
  const status = await getServiceStatus(db)
  const provider = status.providers.find((p) => p.id === providerId)
  if (!provider) return null
  const rows = await db
    .select({ activity: models.activity, count: sql<number>`count(*)` })
    .from(models)
    .where(and(eq(models.providerId, providerId), isNull(models.deprecatedAt)))
    .groupBy(models.activity)
  const activities: Partial<Record<Activity, number>> = {}
  for (const row of rows) {
    if (row.activity) activities[row.activity] = row.count
  }
  return {
    ...provider,
    spec: specDescriptor(providerId, provider.counts.endpoints),
    activities,
    _links: providerLinks(providerId),
  }
}

/** GET /v1/models — the cross-provider, filterable catalog. */
export async function listModelsCatalog(db: Db, filters: ModelFilters = {}) {
  const conditions: Array<SQL> = []
  if (!filters.includeDeprecated) conditions.push(isNull(models.deprecatedAt))
  if (filters.activity) conditions.push(eq(models.activity, filters.activity))
  if (filters.provider) conditions.push(eq(models.providerId, filters.provider))
  if (filters.capability) {
    // The flag is a bound value, quoted as one JSON path key.
    conditions.push(
      sql`json_extract(${models.capabilities}, ${`$.${JSON.stringify(filters.capability)}`}) = 1`,
    )
  }
  if (filters.q) {
    const needle = `%${filters.q.toLowerCase()}%`
    const textMatch = or(
      like(models.id, needle),
      like(models.rawId, needle),
      like(sql`lower(coalesce(${models.displayName}, ''))`, needle),
    )
    if (textMatch) conditions.push(textMatch)
  }

  const rows = await db
    .select(catalogSelection)
    .from(models)
    .leftJoin(upstreamModel, eq(models.sameAsModelId, upstreamModel.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(models.id)
  return {
    count: rows.length,
    models: rows.map(({ row, upstream }) =>
      toApiModel(row, {
        includeFactSources: filters.provenance !== false,
        pricing: filters.pricing === true ? 'full' : 'compact',
        upstream,
      }),
    ),
    _links: {
      self: halGet(
        '/v1/models{?activity,provider,capability,q,provenance,pricing}',
        {
          example: '/v1/models?activity=chat&q=claude',
        },
      ),
      providers: halGet('/v1/providers'),
    },
  }
}

/** GET /v1/providers/{provider}/models. Returns null for unknown providers. */
export async function listProviderModels(
  db: Db,
  providerId: string,
  provenance = true,
) {
  const provider = await db.query.providers.findFirst({
    where: eq(providers.id, providerId),
  })
  if (!provider) return null
  const rows = await db
    .select(catalogSelection)
    .from(models)
    .leftJoin(upstreamModel, eq(models.sameAsModelId, upstreamModel.id))
    .where(eq(models.providerId, providerId))
    .orderBy(models.id)
  return {
    provider: provider.id,
    count: rows.length,
    models: rows.map(({ row, upstream }) =>
      toApiModel(row, {
        pricing: 'compact',
        upstream,
        includeFactSources: provenance,
      }),
    ),
    _links: modelLinks(provider.id),
  }
}

/**
 * GET /v1/models/{provider}/{modelId} — accepts the model slug or the raw
 * provider id. Returns null when not found.
 */
export async function getModelDetail(
  db: Db,
  providerId: string,
  modelId: string,
) {
  const direct = await db.query.models.findFirst({
    where: and(
      eq(models.providerId, providerId),
      or(eq(models.id, modelId), eq(models.rawId, modelId)),
    ),
  })
  const aliasHits = direct
    ? []
    : await db
        .select()
        .from(models)
        .where(
          and(
            eq(models.providerId, providerId),
            sql`exists (select 1 from json_each(${models.aliases}) where json_each.value = ${modelId})`,
          ),
        )
  const row = direct ?? resolveAlias(modelId, aliasHits)
  if (!row) return null
  const [upstream] = row.sameAsModelId
    ? await db
        .select({
          provider: models.providerId,
          rawId: models.rawId,
          aliases: models.aliases,
        })
        .from(models)
        .where(eq(models.id, row.sameAsModelId))
    : []
  const body = toApiModel(row, {
    includeFactSources: true,
    pricing: 'full',
    upstream,
  })
  const joinIds = openRouterJoinIds(providerId, row.rawId)
  if (joinIds.length === 0) return { ...body, discrepancies: [] }
  const matches = await db
    .select()
    .from(models)
    .where(
      and(eq(models.providerId, 'openrouter'), inArray(models.rawId, joinIds)),
    )
  const byRaw = new Map(matches.map((match) => [match.rawId, match]))
  const openrouter = joinIds
    .map((id) => byRaw.get(id))
    .find((match) => match !== undefined)
  const discrepancies = openrouter
    ? factDiscrepancies(
        {
          contextWindow: row.contextWindow,
          maxOutput: row.maxOutput,
          modalities: row.modalities,
          capabilities: row.capabilities,
          factSources: (row.factSources as ModelFactSources | null) ?? null,
        },
        {
          rawId: openrouter.rawId,
          contextWindow: openrouter.contextWindow,
          maxOutput: openrouter.maxOutput,
          modalities: openrouter.modalities,
          capabilities: openrouter.capabilities,
        },
      )
    : []
  return { ...body, discrepancies }
}

/** Valid provider ids, for 404 remediation messages. */
export async function knownProviderIds(db: Db): Promise<Array<string>> {
  const rows = await db.select({ id: providers.id }).from(providers)
  return rows.map((r) => r.id).sort()
}
