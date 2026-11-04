import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { activities } from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import { jsonError } from '#/server/admin.ts'
import { knownProviderIds } from '#/server/catalog.ts'
import { cachedJson, catalogCache } from '#/server/http-cache.ts'
import { getActivitySchemaMap, providerExists } from '#/server/schemas-api.ts'

export const Route = createFileRoute('/v1/schemas/$provider/$activity/')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const db = getDb(env, { replica: true })
        if (!(activities as ReadonlyArray<string>).includes(params.activity)) {
          return jsonError(
            404,
            'unknown_activity',
            `Unknown activity '${params.activity}'. Valid activities: ${activities.join(', ')}.`,
          )
        }
        if (!(await providerExists(db, params.provider))) {
          const valid = (await knownProviderIds(db)).join(', ')
          return jsonError(
            404,
            'unknown_provider',
            `Unknown provider '${params.provider}'. Valid providers: ${valid}.`,
          )
        }
        const activity = params.activity as Activity
        const value = await getActivitySchemaMap(db, params.provider, activity)
        return cachedJson(request, value, catalogCache())
      },
    },
  },
})
