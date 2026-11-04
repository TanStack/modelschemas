import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { sitemapXml } from '#/server/seo.ts'

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: async () =>
        new Response(
          await sitemapXml(getDb(env, { replica: true }), env.BETTER_AUTH_URL),
          {
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
          },
        ),
    },
  },
})
