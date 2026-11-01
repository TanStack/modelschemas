/* eslint-disable @typescript-eslint/consistent-type-imports --
   global declaration file: a top-level import would turn it into a module */
// Companion to the wrangler-generated worker-configuration.d.ts (env-only
// mode — `bun run types`). Full runtime-type generation clashes with lib.dom
// in this single-tsconfig SSR app, so binding types are aliased from
// @cloudflare/workers-types as type-only imports (no fetch/Response globals),
// and the cloudflare:workers module is declared against the generated
// Cloudflare.Env so bindings/vars/secrets stay auto-generated.
type KVNamespace = import('@cloudflare/workers-types').KVNamespace
type D1Database = import('@cloudflare/workers-types').D1Database
type ExecutionContext = import('@cloudflare/workers-types').ExecutionContext
type SendEmail = import('@cloudflare/workers-types').SendEmail
type ScheduledController =
  import('@cloudflare/workers-types').ScheduledController

declare module 'cloudflare:workers' {
  export const env: Cloudflare.Env

  /** Extends the current request's lifetime past the response (workerd-native). */
  export function waitUntil(promise: Promise<unknown>): void

  /** Durable Object base class (US_EGRESS, `src/server/us-egress-object.ts`). */
  export const DurableObject: typeof import('@cloudflare/workers-types').CloudflareWorkersModule.DurableObject
}

type DurableObjectNamespace<
  T extends
    | import('@cloudflare/workers-types').Rpc.DurableObjectBranded
    | undefined = undefined,
> = import('@cloudflare/workers-types').DurableObjectNamespace<T>

/** Cloudflare Browser Rendering binding; keep runtime globals scoped. */
type BrowserRun = import('@cloudflare/workers-types').BrowserRun

/** Workers AI binding; the FAL extract calls AI Gateway through it. */
type Ai = import('@cloudflare/workers-types').Ai
