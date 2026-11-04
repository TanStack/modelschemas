import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db/index.ts'
import { providers } from '#/db/schema.ts'

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
})
