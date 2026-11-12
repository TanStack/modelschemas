# @modelschemas/codegen

Pull core for [modelschemas](https://modelschemas.com) build-time schema
and type generation: selection grammar
(`provider[/endpointGlob][#request|#response]`), conditional fetch
(ETag/304), the `.manifest.json` lockfile, atomic file writes, offline
build verification, and content-hash integrity checks.

> Ships built ESM (`.js` + `.d.ts`). Node loads it with no TypeScript loader.
> Used by `@modelschemas/vite` and the `modelschemas` CLI.

```bash
pnpm add @modelschemas/codegen
```

```ts
import { pull, verify, verifyIntegrity, checkUpdates } from '@modelschemas/codegen'

await pull({
  outDir: 'src/modelschemas',
  selections: ['anthropic/v1/messages#request', 'openai/chat/*'],
})

// offline (production builds): files match the manifest
const files = await verify({ outDir: 'src/modelschemas', selections: [...] })

// online: re-fetch each pinned ?version=<contentHash>, re-hash locally
const integrity = await verifyIntegrity({ outDir: 'src/modelschemas', selections: [] })
```

Docs: [modelschemas.com/docs](https://modelschemas.com/docs) · Source:
[github.com/TanStack/modelschemas](https://github.com/TanStack/modelschemas)
