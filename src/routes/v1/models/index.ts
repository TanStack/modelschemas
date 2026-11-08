import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { activities } from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import { jsonError } from '#/server/admin.ts'
import { listModelsCatalog } from '#/server/catalog.ts'
import { cachedJson, catalogCache } from '#/server/http-cache.ts'

export const Route = createFileRoute('/v1/models/')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const activity = url.searchParams.get('activity')
        if (
          activity !== null &&
          !(activities as ReadonlyArray<string>).includes(activity)
        ) {
          return jsonError(
            400,
            'invalid_activity',
            `Unknown activity '${activity}'. Valid activities: ${activities.join(', ')}.`,
          )
        }
        const provenance = url.searchParams.get('provenance')
        if (provenance !== null && provenance !== '0' && provenance !== '1') {
          return jsonError(
            400,
            'invalid_provenance',
            'provenance must be 0 or 1.',
          )
        }
        const body = await listModelsCatalog(getDb(env, { replica: true }), {
          activity: (activity as Activity | null) ?? undefined,
          provider: url.searchParams.get('provider') ?? undefined,
          capability: url.searchParams.get('capability') ?? undefined,
          q: url.searchParams.get('q') ?? undefined,
          includeDeprecated: url.searchParams.get('deprecated') === 'true',
          provenance: provenance !== '0',
          pricing: url.searchParams.get('pricing') === '1',
        })
        return cachedJson(request, body, catalogCache())
      },
    },
  },
})
