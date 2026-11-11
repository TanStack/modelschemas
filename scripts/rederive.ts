// Re-derive a provider's schema content hashes from its upstream spec —
// no service, no database: the exact fetchSpec → classify → bundle → hash
// pipeline the sync engine runs (shared via `classifyAndBundle`), executed
// locally. Compare the printed `contentHash` values against what
// `GET /v1/schemas/{provider}/{activity}/{endpointId}` reports to verify
// the service's stored schemas are honestly derived from their sources.
//
//   pnpm run rederive -- <provider>
//
// `scripts/register-hash-imports.mjs` loads `.env.local`, so keyed
// providers (FAL) pick up their secret; the upstream spec may also have moved since the service last
// synced — `provenance.sourceHash` tells you which document a stored
// version came from.
import { EXTRACTOR_VERSION } from '../src/server/ingest/bundle.ts'
import { classifyAndBundle } from '../src/server/ingest/sync.ts'
import { contentHash } from '../src/server/kv.ts'
import { getProvider, providerRegistry } from '../src/server/providers/index.ts'

const providerId = process.argv[2]
const provider = providerId ? getProvider(providerId) : undefined
if (!provider) {
  console.error(
    `usage: pnpm run rederive -- <provider>\n` +
      `providers: ${providerRegistry.map((p) => p.id).join(', ')}`,
  )
  process.exit(1)
}

const fetched = await provider.fetchSpec(process.env)
if (fetched.skipped) {
  console.error(`skipped: ${fetched.skipped}`)
  process.exit(1)
}

const { endpoints, warnings } = classifyAndBundle(provider, fetched)
const rows: Array<{
  endpointId: string
  activity: string
  kind: 'input' | 'output'
  contentHash: string
  sourceUrl: string | null
  sourceHash: string | null
}> = []
for (const endpoint of endpoints) {
  const endpointId = endpoint.dbId.slice(provider.id.length + 1)
  for (const [kind, schema] of [
    ['input', endpoint.input],
    ['output', endpoint.output],
  ] as const) {
    if (!schema) continue
    rows.push({
      endpointId,
      activity: endpoint.activity,
      kind,
      contentHash: await contentHash(schema),
      sourceUrl: endpoint.source?.url ?? null,
      sourceHash: endpoint.source?.hash ?? null,
    })
  }
}

console.log(
  JSON.stringify(
    {
      provider: provider.id,
      extractorVersion: EXTRACTOR_VERSION,
      specRevision: fetched.specRevision ?? null,
      schemas: rows,
      warnings,
    },
    null,
    2,
  ),
)
