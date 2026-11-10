/**
 * models.dev is not a catalog source (issue #197). Stored cards and schema
 * versions that name its API are dropped. A skipping adapter is not an empty
 * list: an empty list would also deprecate a later first-party row the next
 * time a key is missing. The frozen models.dev snapshot is retired once.
 * After a real list settles the provider, a skip leaves those rows alone.
 */
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import {
  cacheMeta,
  changes,
  endpoints,
  models,
  schemaVersions,
} from '#/db/schema.ts'
import { parseStoredRateCard } from '#/server/rate-card.ts'

export const MODELS_DEV_API_URL = 'https://models.dev/api.json'

/**
 * OpenCode publishes its own catalog at models.dev. Issue #197 drops that
 * URL for every other provider; for OpenCode it still supplies routes and
 * schema versions. Prices are not exempt: Zen reads its console page (#314).
 */
export function modelsDevIsFirstParty(providerId: string): boolean {
  return providerId === 'opencode' || providerId === 'opencode-go'
}

const SETTLED_PREFIX = 'models-dev-settled:'

function settledKey(providerId: string): string {
  return `${SETTLED_PREFIX}${providerId}`
}

export function isModelsDevRateCard(pricing: unknown): boolean {
  return parseStoredRateCard(pricing)?.source.url === MODELS_DEV_API_URL
}

/** A models.dev card is not a price to keep across a null incoming list. */
export function storedCardIsPrior(pricing: unknown): boolean {
  return parseStoredRateCard(pricing) !== null && !isModelsDevRateCard(pricing)
}

function collectSourceUrls(value: unknown, urls: Array<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSourceUrls(item, urls)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'sourceUrl' && typeof child === 'string' && child.length > 0) {
      urls.push(child)
    } else {
      collectSourceUrls(child, urls)
    }
  }
}

function hasFirstPartyProvenance(row: {
  pricing: unknown
  factSources: unknown
}): boolean {
  const urls: Array<string> = []
  const card = parseStoredRateCard(row.pricing)
  if (card?.source.url) urls.push(card.source.url)
  collectSourceUrls(row.factSources, urls)
  return urls.some((url) => url !== MODELS_DEV_API_URL)
}

/** Delete schema versions derived from the models.dev document. */
export async function dropModelsDevSchemaVersions(
  db: Db,
  providerId: string,
): Promise<void> {
  if (modelsDevIsFirstParty(providerId)) return
  const rows = await db
    .select({ id: schemaVersions.id })
    .from(schemaVersions)
    .innerJoin(endpoints, eq(schemaVersions.endpointId, endpoints.id))
    .where(
      and(
        eq(endpoints.providerId, providerId),
        eq(schemaVersions.sourceUrl, MODELS_DEV_API_URL),
      ),
    )
  for (let i = 0; i < rows.length; i += 90) {
    const ids = rows.slice(i, i + 90).map((row) => row.id)
    await db.delete(schemaVersions).where(inArray(schemaVersions.id, ids))
  }
}

/**
 * Rows per models.dev card clear. One `UPDATE … SET pricing, fact_sources =
 * CASE` over a provider's whole catalog (OpenRouter) spends D1's 10-second
 * resource window by itself (issue #625). Twenty stays under the
 * 100-parameter cap and rewrites one page of rows per statement.
 */
export const MODELS_DEV_CARD_CHUNK = 20

/**
 * Null every stored card whose source is models.dev, and drop the pricing
 * fact that pointed at it. Docs cards use a different source URL and stay.
 * Matching ids are read in keyset pages and cleared by primary key, so a
 * provider with many cards never rewrites them in one statement.
 */
export async function nullModelsDevRateCards(
  db: Db,
  providerId: string,
): Promise<void> {
  let after: string | undefined
  for (;;) {
    const rows = await db
      .select({ id: models.id })
      .from(models)
      .where(
        and(
          eq(models.providerId, providerId),
          sql`json_extract(${models.pricing}, '$.source.url') = ${MODELS_DEV_API_URL}`,
          after === undefined ? undefined : gt(models.id, after),
        ),
      )
      .orderBy(asc(models.id))
      .limit(MODELS_DEV_CARD_CHUNK)
    const last = rows.at(-1)
    if (!last) return
    await db
      .update(models)
      .set({
        pricing: null,
        factSources: sql`CASE
          WHEN json_remove(${models.factSources}, '$.pricing') = '{}' THEN NULL
          ELSE json_remove(${models.factSources}, '$.pricing')
        END`,
      })
      .where(
        inArray(
          models.id,
          rows.map((row) => row.id),
        ),
      )
    if (rows.length < MODELS_DEV_CARD_CHUNK) return
    after = last.id
  }
}

async function catalogSettled(db: Db, providerId: string): Promise<boolean> {
  const row = await db.query.cacheMeta.findFirst({
    where: eq(cacheMeta.key, settledKey(providerId)),
  })
  return row !== undefined
}

/** Remember that this provider's catalog is no longer the models.dev snapshot. */
export async function markModelsDevCatalogSettled(
  db: Db,
  providerId: string,
  now: number,
): Promise<void> {
  if (await catalogSettled(db, providerId)) return
  await db
    .insert(cacheMeta)
    .values({
      key: settledKey(providerId),
      fetchedAt: now,
      staleTime: 0,
    })
    .onConflictDoNothing()
}

/**
 * Deprecate active rows when this provider has never published a first-party
 * list. Returns how many rows were deprecated. A later real list clears
 * `deprecatedAt` for ids it returns; a later skip does not run this again.
 */
export async function deprecateFrozenModelsDevCatalog(
  db: Db,
  providerId: string,
  now: number,
): Promise<number> {
  if (await catalogSettled(db, providerId)) return 0
  const rows = await db
    .select()
    .from(models)
    .where(eq(models.providerId, providerId))
  if (rows.some(hasFirstPartyProvenance)) {
    await markModelsDevCatalogSettled(db, providerId, now)
    return 0
  }
  let removed = 0
  for (const row of rows) {
    if (row.deprecatedAt !== null) continue
    await db
      .update(models)
      .set({ deprecatedAt: now })
      .where(eq(models.id, row.id))
    await db.insert(changes).values({
      id: crypto.randomUUID(),
      type: 'model.removed',
      providerId,
      subjectId: row.id,
      summary: `Model ${row.rawId} no longer listed`,
      createdAt: now,
    })
    removed++
  }
  await markModelsDevCatalogSettled(db, providerId, now)
  return removed
}
