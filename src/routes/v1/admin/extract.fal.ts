import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { isAdminRequest, jsonError } from '#/server/admin.ts'
import { extractFalPricing } from '#/server/ingest/extract-fal-pricing.ts'

export const Route = createFileRoute('/v1/admin/extract/fal')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAdminRequest(request, env.ADMIN_KEY)) {
          return jsonError(
            401,
            'unauthorized',
            'Provide the admin key via X-Admin-Key or Authorization: Bearer.',
          )
        }
        const outcome = await extractFalPricing({
          db: getDb(env),
          kv: env.SCHEMA_CACHE,
          secrets: env,
          ai: env.AI,
          gatewayId: env.AI_GATEWAY_ID,
        })
        if (outcome.error) {
          return jsonError(502, 'extract_failed', outcome.error)
        }
        if (outcome.skipped) {
          return jsonError(503, 'extract_skipped', outcome.skipped)
        }
        return Response.json({ outcome })
      },
    },
  },
})
