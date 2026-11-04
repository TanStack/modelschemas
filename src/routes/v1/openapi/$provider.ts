import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { jsonError } from '#/server/admin.ts'
import { cachedJson, catalogCache } from '#/server/http-cache.ts'
import { assembleProviderOpenApi } from '#/server/provider-openapi.ts'

export const Route = createFileRoute('/v1/openapi/$provider')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const url = new URL(request.url)
        const model = url.searchParams.get('model') ?? undefined
        const activity = url.searchParams.get('activity') ?? undefined
        const db = getDb(env, { replica: true })
        const result = await assembleProviderOpenApi(db, params.provider, {
          model,
          activity,
        })
        if (!result.ok) {
          return jsonError(result.status, result.code, result.message)
        }
        return cachedJson(request, result.document, {
          etag: result.etag,
          ...catalogCache(),
          contentType: 'application/openapi+json',
        })
      },
    },
  },
})
