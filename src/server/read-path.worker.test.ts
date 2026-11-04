import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db/index.ts'
import { cacheMeta, endpoints, providers, schemaVersions } from '#/db/schema.ts'
import { putJson } from '#/server/kv.ts'

const PROVIDER = 'read-path-bench'
const ENDPOINT = `${PROVIDER}/v1/messages`
const NOW = 1_781_150_000

function percentile(samples: Array<number>, p: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  )
  return sorted[index] ?? 0
}

async function time(
  run: () => Promise<unknown>,
  n: number,
): Promise<{
  p50: number
  p95: number
}> {
  const samples: Array<number> = []
  for (let i = 0; i < n; i++) {
    const start = performance.now()
    await run()
    samples.push(performance.now() - start)
  }
  // Drop the warmup. The first calls pay for statement setup.
  const steady = samples.slice(5)
  return { p50: percentile(steady, 50), p95: percentile(steady, 95) }
}

describe('read path', () => {
  it('a replica session reads a row written on the primary', async () => {
    const primary = getDb(env)
    await primary
      .insert(providers)
      .values({
        id: 'read-path-replica',
        displayName: 'Replica',
        specSourceUrl: 'https://example.com/spec',
      })
      .onConflictDoNothing()
    const replica = getDb(env, { replica: true })
    const row = await replica.query.providers.findFirst({
      where: eq(providers.id, 'read-path-replica'),
    })
    expect(row?.displayName).toBe('Replica')
  })

  it('a direct schema read is in the same band as the old KV-plus-cache_meta hit', async () => {
    const schema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 80 }, (_, i) => [
          `field_${String(i)}`,
          { type: 'string', description: 'x'.repeat(40) },
        ]),
      ),
    }
    const schemaText = JSON.stringify(schema)
    const db = getDb(env)
    await db
      .insert(providers)
      .values({
        id: PROVIDER,
        displayName: 'Bench',
        specSourceUrl: 'https://example.com/spec',
      })
      .onConflictDoNothing()
    await db
      .insert(endpoints)
      .values({
        id: ENDPOINT,
        providerId: PROVIDER,
        activity: 'chat',
        method: 'POST',
        path: '/v1/messages',
      })
      .onConflictDoNothing()
    await db
      .insert(schemaVersions)
      .values({
        id: `${ENDPOINT}:input:bench`,
        endpointId: ENDPOINT,
        kind: 'input',
        contentHash: 'bench-hash',
        schema: schemaText,
        createdAt: NOW,
      })
      .onConflictDoNothing()
    await db
      .insert(cacheMeta)
      .values({
        key: 'bench-schema',
        fetchedAt: NOW,
        staleTime: 300,
      })
      .onConflictDoUpdate({
        target: cacheMeta.key,
        set: { fetchedAt: NOW, staleTime: 300, refreshing: false },
      })
    await putJson(env.SCHEMA_CACHE, 'swr:bench-schema', schema)

    const swrHit = () =>
      Promise.all([
        env.SCHEMA_CACHE.get('swr:bench-schema', 'text'),
        db.query.cacheMeta.findFirst({
          where: eq(cacheMeta.key, 'bench-schema'),
        }),
      ])
    const direct = async () => {
      const row = await db.query.schemaVersions.findFirst({
        where: eq(schemaVersions.id, `${ENDPOINT}:input:bench`),
      })
      return JSON.parse(row?.schema ?? 'null') as unknown
    }

    await swrHit()
    await direct()
    const swr = await time(swrHit, 40)
    const replica = await time(direct, 40)
    // In-process workerd: both are local. Production adds a primary
    // round trip to the KV hit (cache_meta) and serves the direct read
    // from a replica, then skips origin entirely on an edge hit.
    // The direct read may parse a larger row. It should not be a
    // different order of magnitude.
    expect(
      replica.p95,
      `kv+meta p50=${swr.p50.toFixed(2)} p95=${swr.p95.toFixed(2)}; direct p50=${replica.p50.toFixed(2)} p95=${replica.p95.toFixed(2)}`,
    ).toBeLessThan(Math.max(swr.p95 * 8, 50))
  })
})
