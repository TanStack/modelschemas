import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { changeTypes } from '#/db/schema.ts'
import type { ChangeType } from '#/db/schema.ts'
import { jsonError } from '#/server/admin.ts'
import { listChanges } from '#/server/changes-api.ts'
import { parseWaitSeconds, waitForNewChange } from '#/server/wait.ts'

export const Route = createFileRoute('/v1/changes')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const sinceParam = url.searchParams.get('since')
        const since = sinceParam === null ? undefined : Number(sinceParam)
        if (since !== undefined && !Number.isInteger(since)) {
          return jsonError(
            400,
            'invalid_since',
            "Parameter 'since' must be unix epoch seconds.",
          )
        }
        const type = url.searchParams.get('type')
        if (
          type !== null &&
          !(changeTypes as ReadonlyArray<string>).includes(type)
        ) {
          return jsonError(
            400,
            'invalid_type',
            `Unknown change type '${type}'. Valid types: ${changeTypes.join(', ')}.`,
          )
        }
        const limitParam = url.searchParams.get('limit')
        const limit = limitParam === null ? undefined : Number(limitParam)
        if (limit !== undefined && !Number.isInteger(limit)) {
          return jsonError(
            400,
            'invalid_limit',
            "Parameter 'limit' must be an integer.",
          )
        }

        // Primary, not a replica. Cursors and ?wait= must see the latest
        // write; a lagging replica would skip or repeat a page.
        const db = getDb(env)
        const waitSeconds = parseWaitSeconds(url)
        if (waitSeconds > 0) await waitForNewChange(db, waitSeconds)

        const outcome = await listChanges(db, {
          since,
          provider: url.searchParams.get('provider') ?? undefined,
          type: (type as ChangeType | null) ?? undefined,
          cursor: url.searchParams.get('cursor') ?? undefined,
          limit,
        })
        if (!outcome.ok) {
          return jsonError(outcome.status, outcome.code, outcome.message)
        }
        return Response.json(outcome.result)
      },
    },
  },
})
