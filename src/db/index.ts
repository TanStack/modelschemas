import { drizzle } from 'drizzle-orm/d1'

import * as schema from './schema.ts'

export interface DbEnv {
  DB: D1Database
}

export interface GetDbOptions {
  /**
   * Public read. Opens a D1 session with `first-unconstrained`, so the
   * query can run on a read replica once read replication is enabled.
   * Sessions are safe before that: every query still goes to the primary.
   * Enable replication on the database only after #554, so replicas copy
   * the US primary (`read_replication.mode: auto` in the dashboard or API).
   * There is no wrangler.jsonc switch for it.
   *
   * Leave this off for auth, admin, subscriptions, crons, webhooks, and
   * the changes feed. Those need the latest write.
   *
   * Agent JWT `jti`s are not rows in D1. `@better-auth/agent-auth` stores
   * them in an in-process has-then-add cache (this service sets no
   * `secondaryStorage`), so a lagging replica cannot accept one twice.
   * Auth still uses the primary because its other writes must read what
   * they just wrote.
   */
  replica?: boolean
}

// Workers have no module-scope env: the D1 binding only exists on the env
// object passed to fetch/scheduled handlers, so the db client is built per
// request rather than exported as a singleton.
export function getDb(env: DbEnv, options?: GetDbOptions) {
  // Drizzle's D1 driver only calls prepare() and batch(), which a session
  // has. The session type omits exec()/dump(), so it is not assignable.
  const client = options?.replica
    ? (env.DB.withSession('first-unconstrained') as unknown as D1Database)
    : env.DB
  return drizzle(client, { schema })
}

export type Db = ReturnType<typeof getDb>
