import type { ProviderEnvironment } from './types.ts'

/**
 * What `fetchJson`, `fetchText` and `fetchOptional` call; the global
 * `fetch` is one.
 */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

/**
 * A fetch that leaves Cloudflare from eastern North America (issue #356).
 *
 * Anthropic and Gemini refuse callers in regions they do not serve
 * (`403 forbidden` / `400 User location is not supported`). Cron
 * invocations run wherever Cloudflare has spare capacity, and `placement`
 * only moves fetch handlers, so the models poll has no fixed location.
 * A Durable Object is created near its `locationHint` on the first `get()`
 * and does not move afterwards, so routing the keyed listing calls through
 * one fixes where they egress. Docs loads go the same way: Anthropic's
 * docs host serves pages with no tables to the regions its API refuses
 * (#482), and OpenAI's docs host answers 403 from hkg1 (#505). (The `us`
 * jurisdiction would be a hard guarantee, but workerd does not implement
 * it, so `pnpm run dev` would throw.)
 *
 * Outside the Workers runtime (Node scripts and unit tests) there is no
 * binding and the global fetch runs from the caller's own machine. Inside
 * it, a missing binding is a config error and throws.
 */
export function usEgressFetch(env: ProviderEnvironment): Fetcher {
  const ns = env.US_EGRESS
  if (!ns) {
    if (navigator.userAgent === 'Cloudflare-Workers')
      throw new Error('US_EGRESS binding missing (wrangler.jsonc, issue #356)')
    return fetch
  }
  const stub = ns.get(ns.idFromName('provider-egress'), {
    locationHint: 'enam',
  })
  // workers-types' Request/Response and the DOM ones this file is typed
  // with are the same runtime classes.
  return async (url, init) =>
    (await stub.fetch(url, init as never)) as unknown as Response
}
