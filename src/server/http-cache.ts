/**
 * HTTP cache semantics for read endpoints: `ETag` (content hash),
 * `Last-Modified`, `Cache-Control`, `X-Fetched-At` / `X-Stale-At` (unix
 * epoch seconds), and `If-None-Match` → 304.
 *
 * Workers Cache (the `CachedReads` entrypoint in `src/worker.ts`) stores a
 * GET before the worker runs when the response is `public` with a
 * `max-age`. That lifetime matches the 15-minute models poll for catalog
 * and current schema reads; a `?version=<hash>` schema never changes, so
 * it is cached for a year. No `s-maxage`: Cloudflare disables
 * stale-while-revalidate and stale-if-error when it is present, and the
 * shared and browser lifetimes are the same here anyway.
 */
import { contentHash } from '#/server/kv.ts'

/** Model lists move on the 15-minute poll. Spec sync is daily, so this is the tighter cron. */
export const CATALOG_CACHE_SECONDS = 15 * 60

/** Content-addressed schema versions do not change. */
export const VERSIONED_SCHEMA_CACHE_SECONDS = 365 * 24 * 60 * 60

export interface CacheHeaderOptions {
  /** Content hash to use as the ETag; computed from the body when omitted. */
  etag?: string
  /** Unix epoch seconds the value was fetched/produced. */
  fetchedAt: number
  /** Unix epoch seconds the value goes stale. */
  staleAt: number
  /** Cache-Control max-age (seconds), edge and browser. Defaults to the poll cadence. */
  maxAge?: number
  /** Cache-Control stale-while-revalidate window (seconds). Omitted when immutable. */
  staleWhileRevalidate?: number
  /** Content-addressed body. Caches may keep it for `maxAge` without revalidating. */
  immutable?: boolean
  /** Defaults to application/json. */
  contentType?: string
}

/** Cache window for a catalog or current-schema read. */
export function catalogCache(
  now = Math.floor(Date.now() / 1000),
): Pick<CacheHeaderOptions, 'fetchedAt' | 'staleAt' | 'maxAge'> {
  return {
    fetchedAt: now,
    staleAt: now + CATALOG_CACHE_SECONDS,
    maxAge: CATALOG_CACHE_SECONDS,
  }
}

/** Cache window for a schema read pinned to a content hash. */
export function versionedSchemaCache(
  createdAt: number,
): Pick<CacheHeaderOptions, 'fetchedAt' | 'staleAt' | 'maxAge' | 'immutable'> {
  return {
    fetchedAt: createdAt,
    staleAt: createdAt + VERSIONED_SCHEMA_CACHE_SECONDS,
    maxAge: VERSIONED_SCHEMA_CACHE_SECONDS,
    immutable: true,
  }
}

function cacheControl(options: CacheHeaderOptions): string {
  const parts = [
    'public',
    `max-age=${String(options.maxAge ?? CATALOG_CACHE_SECONDS)}`,
  ]
  if (options.immutable) {
    parts.push('immutable')
  } else {
    parts.push(
      `stale-while-revalidate=${String(options.staleWhileRevalidate ?? 600)}`,
    )
  }
  return parts.join(', ')
}

function buildHeaders(
  etag: string,
  options: CacheHeaderOptions,
  contentType: string,
): Headers {
  return new Headers({
    'Content-Type': contentType,
    ETag: `"${etag}"`,
    'Last-Modified': new Date(options.fetchedAt * 1000).toUTCString(),
    'Cache-Control': cacheControl(options),
    'X-Fetched-At': String(options.fetchedAt),
    'X-Stale-At': String(options.staleAt),
  })
}

/** RFC 9110 If-None-Match: comma-separated entity tags, `W/` prefixes
 * compare weakly, `*` matches anything. */
export function ifNoneMatchSatisfied(
  header: string | null,
  etag: string,
): boolean {
  if (!header) return false
  if (header.trim() === '*') return true
  return header
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .includes(`"${etag}"`)
}

/**
 * JSON response with full cache semantics; returns 304 (no body, same
 * headers) when the request's If-None-Match matches the ETag.
 */
export async function cachedJson(
  request: Request,
  value: unknown,
  options: CacheHeaderOptions,
): Promise<Response> {
  const etag = options.etag ?? (await contentHash(value))
  return respond(
    request,
    JSON.stringify(value),
    etag,
    options,
    options.contentType ?? 'application/json',
  )
}

/** Same cache semantics for a non-JSON text body (e.g. `?format=types`). */
export function cachedText(
  request: Request,
  body: string,
  contentType: string,
  options: CacheHeaderOptions & { etag: string },
): Response {
  return respond(request, body, options.etag, options, contentType)
}

function respond(
  request: Request,
  body: string,
  etag: string,
  options: CacheHeaderOptions,
  contentType: string,
): Response {
  const headers = buildHeaders(etag, options, contentType)
  if (ifNoneMatchSatisfied(request.headers.get('if-none-match'), etag)) {
    headers.delete('Content-Type')
    // A 304 is not the representation. Workers Cache must not store it
    // under the URL in place of the body.
    headers.set('Cache-Control', 'private, no-store')
    return new Response(null, { status: 304, headers })
  }
  return new Response(body, { status: 200, headers })
}
