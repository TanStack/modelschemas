import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { listProvidersCatalog } from '#/server/catalog.ts'
import { cachedJson, catalogCache } from '#/server/http-cache.ts'

export const Route = createFileRoute('/v1/providers/')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const body = await listProvidersCatalog(getDb(env, { replica: true }))
        return cachedJson(request, body, catalogCache())
      },
    },
  },
})
