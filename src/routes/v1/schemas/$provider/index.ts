import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { jsonError } from '#/server/admin.ts'
import { knownProviderIds } from '#/server/catalog.ts'
import { cachedJson, catalogCache } from '#/server/http-cache.ts'
import { getProviderSchemaIndex, providerExists } from '#/server/schemas-api.ts'

export const Route = createFileRoute('/v1/schemas/$provider/')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const db = getDb(env, { replica: true })
        if (!(await providerExists(db, params.provider))) {
          const valid = (await knownProviderIds(db)).join(', ')
          return jsonError(
            404,
            'unknown_provider',
            `Unknown provider '${params.provider}'. Valid providers: ${valid}.`,
          )
        }
        const value = await getProviderSchemaIndex(db, params.provider)
        return cachedJson(request, value, catalogCache())
      },
    },
  },
})
