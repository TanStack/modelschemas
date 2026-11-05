import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { jsonError } from '#/server/admin.ts'
import { getProviderCatalog, knownProviderIds } from '#/server/catalog.ts'
import { cachedJson, catalogCache } from '#/server/http-cache.ts'

export const Route = createFileRoute('/v1/providers/$provider')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const db = getDb(env, { replica: true })
        const body = await getProviderCatalog(db, params.provider)
        if (!body) {
          const valid = (await knownProviderIds(db)).join(', ')
          return jsonError(
            404,
            'unknown_provider',
            `Unknown provider '${params.provider}'. Valid providers: ${valid}.`,
          )
        }
        return cachedJson(request, body, catalogCache())
      },
    },
  },
})
