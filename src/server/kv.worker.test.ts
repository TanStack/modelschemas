import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { contentHash, getJson, putJson, stableStringify } from './kv.ts'

describe('stableStringify', () => {
  it('is independent of object key order, including nested objects', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } })).toBe(
      stableStringify({ a: { c: [{ e: 4, f: 3 }], d: 2 }, b: 1 }),
    )
  })

  it('preserves array order', () => {
    expect(stableStringify([2, 1])).toBe('[2,1]')
  })
})

describe('contentHash', () => {
  it('produces a stable sha-256 hex digest for equivalent values', async () => {
    const a = await contentHash({ x: 1, y: 2 })
    const b = await contentHash({ y: 2, x: 1 })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('differs for different values', async () => {
    expect(await contentHash({ x: 1 })).not.toBe(await contentHash({ x: 2 }))
  })
})

describe('kv json helpers (real KV binding)', () => {
  it('round-trips a JSON value', async () => {
    const value = { schema: { type: 'object' }, b: 2, a: [1, 2, 3] }
    await putJson(env.SCHEMA_CACHE, 'test:round-trip', value)
    expect(await getJson(env.SCHEMA_CACHE, 'test:round-trip')).toEqual(value)
  })

  it('returns null for a missing key', async () => {
    expect(await getJson(env.SCHEMA_CACHE, 'test:missing')).toBeNull()
  })
})
