import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { jsonError } from '#/server/admin.ts'
import { knownProviderIds, listProviderModels } from '#/server/catalog.ts'
import { cachedJson, catalogCache } from '#/server/http-cache.ts'

export const Route = createFileRoute('/v1/providers/$provider/models')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const provenance = new URL(request.url).searchParams.get('provenance')
        if (provenance !== null && provenance !== '0' && provenance !== '1') {
          return jsonError(
            400,
            'invalid_provenance',
            'provenance must be 0 or 1.',
          )
        }
        const db = getDb(env, { replica: true })
        const body = await listProviderModels(
          db,
          params.provider,
          provenance !== '0',
        )
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
