/**
 * One FAL rate-card extract through the REAL `AI` binding and AI Gateway —
 * the route `scripts/compare-fal-extract-models.ts` stands in for, which
 * #551 and #556 shipped without exercising (#552). Prints the Pricing
 * section, then the card or the rejection. Billed to Unified Billing.
 *
 *   CLOUDFLARE_ACCOUNT_ID=… bunx tsx scripts/fal-extract-smoke.ts [fal model id]
 *
 * Node, not bun: wrangler's remote bindings cannot run under bun
 * (oven-sh/bun#39247). Needs `wrangler login`, and `FAL_KEY` (env or
 * Doppler dev) for the endpoint's request properties.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPlatformProxy } from 'wrangler'

import {
  extractRateCard,
  gatewayChat,
  pricingSection,
  pricingSectionHash,
} from '../src/server/ingest/extract-fal-pricing.ts'
import { falLlmsTxtUrl } from '../src/server/providers/fal.ts'
import { requestPropertiesOf } from './fal-models.ts'

const rawId = process.argv[2] ?? 'heygen/heygen-voice'

// Only the AI binding: the repo config would also boot D1, KV and DOs.
const configPath = join(
  await mkdtemp(join(tmpdir(), 'fal-extract-smoke-')),
  'wrangler.json',
)
await writeFile(
  configPath,
  JSON.stringify({
    name: 'fal-extract-smoke',
    compatibility_date: '2025-09-02',
    ai: { binding: 'AI', remote: true },
  }),
)
const { env, dispose } = await getPlatformProxy<{ AI: Ai }>({ configPath })
try {
  const sourceUrl = falLlmsTxtUrl(rawId)
  const section = pricingSection(await (await fetch(sourceUrl)).text())
  console.log(section)
  const started = performance.now()
  const requestProperties = await requestPropertiesOf(rawId)
  console.log(`request properties: ${[...requestProperties].sort().join(', ')}`)
  const result = await extractRateCard({
    pricingText: section,
    requestProperties,
    sourceUrl,
    sourceHash: await pricingSectionHash(section),
    now: Math.floor(Date.now() / 1000),
    chat: gatewayChat(env.AI, 'modelschemas'),
  })
  console.log(`${Math.round(performance.now() - started)}ms`)
  console.log(JSON.stringify(result, null, 1))
} finally {
  await dispose()
}
