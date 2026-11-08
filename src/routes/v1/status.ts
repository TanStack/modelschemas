import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { halGet } from '#/server/hal.ts'
import { getServiceStatus } from '#/server/status.ts'
import { parseWaitSeconds, waitForStatusChange } from '#/server/wait.ts'

export const Route = createFileRoute('/v1/status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // ?wait=Ns long-poll (task 11.3): hold until a poll/sync lands.
        const waitSeconds = parseWaitSeconds(new URL(request.url))
        // A long-poll is waiting for a write that just landed, so it stays
        // on the primary. A plain read can use a replica.
        const db = getDb(env, { replica: waitSeconds === 0 })
        if (waitSeconds > 0) {
          await waitForStatusChange(db, waitSeconds)
        }
        return Response.json({
          ...(await getServiceStatus(db)),
          _links: {
            self: halGet('/v1/status'),
            index: halGet('/v1'),
            providers: halGet('/v1/providers'),
          },
        })
      },
    },
  },
})
