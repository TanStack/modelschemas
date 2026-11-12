// Smoke test for @modelschemas/client against a running dev server (task
// 7.4 acceptance): lists providers and fetches one schema, fully typed.
//
//   pnpm run client-smoke [baseUrl]
import {
  createModelschemasClient,
  getSchema,
  listProviders,
} from '@modelschemas/client'

const client = createModelschemasClient({
  baseUrl: process.argv[2] ?? 'http://localhost:3100',
})

const providers = await listProviders({ client })
if (providers.error || !providers.data) {
  console.error('listProviders failed:', providers.error)
  process.exit(1)
}
// `providers.data` is typed from the spec; runtime shape comes from the API.
const providerList = (
  providers.data as {
    providers: Array<{ id: string; counts: { schemas: number } }>
  }
).providers
console.log(
  `providers ok (${String(providerList.length)}): ${providerList
    .map((p) => p.id)
    .join(', ')}`,
)

// The schema read below names a route only openai and anthropic share, so
// pick one of them rather than whichever synced provider sorts first.
const withSchemas = providerList.find(
  (p) => (p.id === 'openai' || p.id === 'anthropic') && p.counts.schemas > 0,
)
if (!withSchemas) {
  console.error('no provider with synced schemas — run an admin sync first')
  process.exit(1)
}

const schema = await getSchema({
  client,
  path: {
    provider: withSchemas.id,
    activity: 'chat',
    endpointId:
      withSchemas.id === 'anthropic' ? 'v1/messages' : 'chat/completions',
  },
  query: { kind: 'input' },
})
if (schema.error !== undefined) {
  console.error('getSchema failed:', schema.error)
  process.exit(1)
}
const result = schema.data as { contentHash: string }
console.log(`getSchema ok (contentHash ${result.contentHash.slice(0, 12)}…)`)
