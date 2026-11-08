import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { cachedJson, catalogCache } from '#/server/http-cache.ts'
import { getSystemSchemaIndex } from '#/server/schemas-api.ts'

export const Route = createFileRoute('/v1/schemas/')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const db = getDb(env, { replica: true })
        const value = await getSystemSchemaIndex(db)
        return cachedJson(request, value, catalogCache())
      },
    },
  },
})
