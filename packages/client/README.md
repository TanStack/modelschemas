# @modelschemas/client

Typed fetch client for [modelschemas](https://modelschemas.com) — live
per-endpoint request/response JSON Schemas and model metadata for AI
providers (OpenAI, Anthropic, Gemini, xAI Grok, ElevenLabs, OpenRouter,
FAL), generated from the service's OpenAPI spec.

> Ships built ESM (`.js` + `.d.ts`). Node loads it with no TypeScript loader.

```bash
bun add @modelschemas/client
```

```ts
import {
  createModelschemasClient,
  listModels,
  getSchema,
  validatePayload,
} from '@modelschemas/client'

const client = createModelschemasClient({
  baseUrl: 'https://modelschemas.com',
})

const models = await listModels({ client, query: { activity: 'chat' } })
const schema = await getSchema({
  client,
  path: { provider: 'anthropic', activity: 'chat', endpointId: 'v1/messages' },
  query: { kind: 'input' },
})
```

Schema responses are content-addressed (`contentHash` = ETag =
`?version=` pin) and carry `provenance` (upstream `sourceUrl`,
`sourceHash`, `fetchedAt`, `extractorVersion`) so every derivation is
independently verifiable.

Docs: [modelschemas.com/docs](https://modelschemas.com/docs) · API spec:
[/openapi.json](https://modelschemas.com/openapi.json) · Source:
[github.com/TanStack/modelschemas](https://github.com/TanStack/modelschemas)
