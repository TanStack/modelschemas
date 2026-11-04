import { describe, expect, it } from 'vitest'

import { contentHash } from './kv.ts'
import {
  CATALOG_CACHE_SECONDS,
  cachedJson,
  cachedText,
  ifNoneMatchSatisfied,
  versionedSchemaCache,
} from './http-cache.ts'

const FETCHED = 1_781_150_000
const STALE = FETCHED + 600

const request = (headers: Record<string, string> = {}) =>
  new Request('https://example.com/v1/schemas/anthropic', { headers })

describe('cachedJson', () => {
  it('serves 200 with ETag, Last-Modified, Cache-Control, and X- headers', async () => {
    const value = { hello: 'world' }
    const response = await cachedJson(request(), value, {
      fetchedAt: FETCHED,
      staleAt: STALE,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(value)

    const expectedTag = await contentHash(value)
    expect(response.headers.get('etag')).toBe(`"${expectedTag}"`)
    expect(response.headers.get('last-modified')).toBe(
      new Date(FETCHED * 1000).toUTCString(),
    )
    expect(response.headers.get('cache-control')).toBe(
      `public, max-age=${String(CATALOG_CACHE_SECONDS)}, stale-while-revalidate=600`,
    )
    expect(response.headers.get('x-fetched-at')).toBe(String(FETCHED))
    expect(response.headers.get('x-stale-at')).toBe(String(STALE))
  })

  it('returns 304 with no body on a matching If-None-Match', async () => {
    const value = { hello: 'world' }
    const etag = await contentHash(value)
    const response = await cachedJson(
      request({ 'if-none-match': `"${etag}"` }),
      value,
      { fetchedAt: FETCHED, staleAt: STALE },
    )
    expect(response.status).toBe(304)
    expect(await response.text()).toBe('')
    expect(response.headers.get('etag')).toBe(`"${etag}"`)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-stale-at')).toBe(String(STALE))
  })

  it('returns 200 on a mismatched If-None-Match', async () => {
    const response = await cachedJson(
      request({ 'if-none-match': '"deadbeef"' }),
      { hello: 'world' },
      { fetchedAt: FETCHED, staleAt: STALE },
    )
    expect(response.status).toBe(200)
  })

  it('uses a provided etag (e.g. the stored schema content hash) verbatim', async () => {
    const response = await cachedJson(
      request(),
      { any: 'body' },
      { etag: 'a'.repeat(64), fetchedAt: FETCHED, staleAt: STALE },
    )
    expect(response.headers.get('etag')).toBe(`"${'a'.repeat(64)}"`)
  })

  it('honours custom max-age and stale-while-revalidate', async () => {
    const response = await cachedJson(
      request(),
      {},
      {
        fetchedAt: FETCHED,
        staleAt: STALE,
        maxAge: 5,
        staleWhileRevalidate: 30,
      },
    )
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=5, stale-while-revalidate=30',
    )
  })

  it('caches a content-addressed read for a year and marks it immutable', async () => {
    const response = await cachedJson(
      request(),
      {},
      { etag: 'abc', ...versionedSchemaCache(FETCHED) },
    )
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(response.headers.get('last-modified')).toBe(
      new Date(FETCHED * 1000).toUTCString(),
    )
  })
})

describe('cachedText', () => {
  it('serves a non-JSON body with the given content type and full cache headers', () => {
    const response = cachedText(
      request(),
      'export type X = string\n',
      'text/typescript; charset=utf-8',
      { etag: 'hash-types-v1-exact', fetchedAt: FETCHED, staleAt: STALE },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'text/typescript; charset=utf-8',
    )
    expect(response.headers.get('etag')).toBe('"hash-types-v1-exact"')
    expect(response.headers.get('x-stale-at')).toBe(String(STALE))
  })

  it('returns 304 with no body on a matching If-None-Match', async () => {
    const response = cachedText(
      request({ 'if-none-match': '"hash-types-v1-exact"' }),
      'export type X = string\n',
      'text/typescript; charset=utf-8',
      { etag: 'hash-types-v1-exact', fetchedAt: FETCHED, staleAt: STALE },
    )
    expect(response.status).toBe(304)
    expect(await response.text()).toBe('')
  })
})

describe('ifNoneMatchSatisfied', () => {
  it('handles lists, weak validators, and the wildcard', () => {
    expect(ifNoneMatchSatisfied('"abc", "def"', 'def')).toBe(true)
    expect(ifNoneMatchSatisfied('W/"abc"', 'abc')).toBe(true)
    expect(ifNoneMatchSatisfied('*', 'anything')).toBe(true)
    expect(ifNoneMatchSatisfied('"abc"', 'def')).toBe(false)
    expect(ifNoneMatchSatisfied(null, 'abc')).toBe(false)
  })
})
