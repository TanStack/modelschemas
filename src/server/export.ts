/**
 * Catalog export (issue #343): the whole catalog in one response, for the
 * public git mirror. Fields that change on every poll are left out and
 * object keys are sorted, so a mirror commit holds only real changes.
 *
 * The full catalog is tens of MB; built as one string, plus its encoded
 * copy, it risks the 128 MB isolate limit. The body is streamed one
 * provider at a time; a failure part way errors the stream, so the client
 * gets no valid JSON and commits nothing.
 */
import { and, desc, eq, isNull } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import {
  changes,
  endpoints,
  providerModelNamespaces,
  providers,
  schemaVersions,
} from '#/db/schema.ts'
import { listModelsCatalog } from '#/server/catalog.ts'
import type { ApiModel } from '#/server/catalog.ts'
import { errorMessage } from '#/server/errors.ts'
import { publicEndpointId, schemaProvenance } from '#/server/schemas-api.ts'
import type { SchemaProvenance } from '#/server/schemas-api.ts'

/** Stored JSON text, written to the body as it is. */
class RawJson {
  constructor(readonly text: string) {}
}

/**
 * JSON with every object's keys sorted. A schema is the exception: it is
 * written as its stored text. That text is fixed for a content hash (the
 * hash is over sorted keys), so its key order is the one first stored.
 */
export function stableJson(value: unknown): string {
  if (value instanceof RawJson) return value.text
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item ?? null)).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const members = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    return `{${members.join(',')}}`
  }
  const text = JSON.stringify(value) as string | undefined
  if (text === undefined) throw new Error(`export: ${typeof value} is not JSON`)
  return text
}

/** `lastSeenAt` moves on every poll; `_links` are API navigation. */
function exportModel({ lastSeenAt: _lastSeenAt, _links, ...model }: ApiModel) {
  return model
}

interface SchemaVersionEntry {
  contentHash: string
  specRevision: string | null
  provenance: SchemaProvenance
  schema: RawJson
}

interface SchemaEntry {
  provider: string
  endpointId: string
  activity: string
  method: string
  path: string
  description: string | null
  input: SchemaVersionEntry | null
  output: SchemaVersionEntry | null
  /** SSE event schema when `output` is the JSON success body. */
  stream?: SchemaVersionEntry
}

/** Every endpoint of one provider with its current input and output. */
async function exportProviderSchemas(db: Db, providerId: string) {
  const rows = await db
    .select({ endpoint: endpoints, version: schemaVersions })
    .from(endpoints)
    .leftJoin(
      schemaVersions,
      and(
        eq(schemaVersions.endpointId, endpoints.id),
        isNull(schemaVersions.supersededAt),
      ),
    )
    .where(eq(endpoints.providerId, providerId))
    .orderBy(endpoints.id, schemaVersions.kind, schemaVersions.id)

  const byEndpoint = new Map<string, SchemaEntry>()
  for (const { endpoint, version } of rows) {
    let entry = byEndpoint.get(endpoint.id)
    if (!entry) {
      entry = {
        provider: providerId,
        endpointId: publicEndpointId(endpoint.id, providerId),
        activity: endpoint.activity,
        method: endpoint.method,
        path: endpoint.path,
        description: endpoint.description,
        input: null,
        output: null,
      }
      byEndpoint.set(endpoint.id, entry)
    }
    if (version) {
      // An interrupted sync can leave two current rows; picking one would
      // make the mirror flip between them, so the export refuses.
      if (version.kind === 'stream' ? entry.stream : entry[version.kind]) {
        throw new Error(
          `${endpoint.id} has more than one current ${version.kind} version`,
        )
      }
      // Written raw, so a broken text would break the body with no clue.
      if (!/^\s*\{[\s\S]*\}\s*$/.test(version.schema)) {
        throw new Error(`schema version ${version.id} is not a JSON object`)
      }
      const recorded = {
        contentHash: version.contentHash,
        specRevision: version.specRevision,
        provenance: schemaProvenance(version),
        schema: new RawJson(version.schema),
      }
      if (version.kind === 'stream') entry.stream = recorded
      else entry[version.kind] = recorded
    }
  }
  return [...byEndpoint.values()]
}

/** Each provider's rows as JSON, comma-joined across providers. */
async function* perProvider(
  section: string,
  providerIds: Array<string>,
  load: (providerId: string) => Promise<Array<unknown>>,
): AsyncGenerator<string> {
  let separator = ''
  for (const providerId of providerIds) {
    const rows = await load(providerId).catch((error: unknown) => {
      throw new Error(`${section} of ${providerId}: ${errorMessage(error)}`, {
        cause: error,
      })
    })
    if (rows.length === 0) continue
    yield separator + rows.map(stableJson).join(',')
    separator = ','
  }
}

/**
 * The body in order: `latestChange`, then `models`, `providers`, and
 * `schemas`. `providers` is ordered by id; `models` and `schemas` by
 * provider id, then their own id.
 */
async function* exportChunks(db: Db): AsyncGenerator<string> {
  // Read first: every change it covers is already in the rows below. The
  // export is not one snapshot, so those rows may also hold later changes.
  const [latestChange] = await db
    .select({ id: changes.id, createdAt: changes.createdAt })
    .from(changes)
    .orderBy(desc(changes.createdAt), desc(changes.id))
    .limit(1)
  const providerRows = await db.select().from(providers).orderBy(providers.id)
  const namespaceRows = await db
    .select()
    .from(providerModelNamespaces)
    .orderBy(providerModelNamespaces.namespace)

  const providerIds = providerRows.map((provider) => provider.id)

  yield `{"latestChange":${stableJson(latestChange ?? null)},"models":[`
  yield* perProvider('models', providerIds, async (provider) => {
    const catalog = await listModelsCatalog(db, {
      provider,
      includeDeprecated: true,
      pricing: true,
    })
    return catalog.models.map(exportModel)
  })

  const exportedProviders = providerRows.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    specSourceUrl: provider.specSourceUrl,
    modelsEndpoint: provider.modelsEndpoint,
    authEnvVar: provider.authEnvVar,
    status: provider.status,
    modelNamespaces: namespaceRows
      .filter((row) => row.providerId === provider.id)
      .map((row) => row.namespace),
  }))
  yield `],"providers":${stableJson(exportedProviders)},"schemas":[`

  yield* perProvider('schemas', providerIds, (provider) =>
    exportProviderSchemas(db, provider),
  )
  yield ']}'
}

/** GET /v1/admin/export — the response body. */
export function exportCatalogStream(db: Db): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const chunks = exportChunks(db)
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await chunks.next()
        if (next.done) controller.close()
        else controller.enqueue(encoder.encode(next.value))
      } catch (error) {
        console.error(
          JSON.stringify({
            job: 'catalog-export',
            error: errorMessage(error),
            stack: error instanceof Error ? error.stack : undefined,
          }),
        )
        controller.error(error)
      }
    },
    async cancel() {
      await chunks.return(undefined)
    },
  })
}
