// CLI-only entry for `pnpm exec @better-auth/cli generate --config` — gives the
// CLI an auth instance to introspect for schema generation without importing
// `cloudflare:workers` (which only exists inside workerd). The db is never
// queried during generation, so a stub is fine.
import type { Db } from '../src/db/index.ts'
import { createAuth } from '../src/lib/auth.ts'

export const auth = createAuth({} as unknown as Db, {
  secret: 'better-auth-cli-schema-generation-only',
})
