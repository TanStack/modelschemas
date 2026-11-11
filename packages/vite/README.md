# @modelschemas/vite

Vite plugin for [modelschemas](https://modelschemas.com): pull selected
provider JSON Schemas + generated TypeScript into your repo at dev time,
verify offline at build time — production builds touch zero network.
The package ships built ESM (`.js` + `.d.ts`). Node loads it with no TypeScript loader.

```bash
pnpm add -D @modelschemas/vite
```

```ts
// vite.config.ts
import { modelschemas } from '@modelschemas/vite'

export default defineConfig({
  plugins: [
    modelschemas({
      selections: ['anthropic/v1/messages#request', 'openai/chat/*'],
      outDir: 'src/modelschemas', // default; commit it
      apiKey: process.env.MODELSCHEMAS_API_KEY, // optional — lifts rate limits
    }),
  ],
})
```

```ts
import {
  anthropicV1MessagesRequestSchema,
  type AnthropicV1MessagesRequest,
} from './modelschemas/anthropic/v1-messages.request.ts'
```

The dev server pulls whatever is missing and _reports_ upstream schema
drift (it never rewrites existing files); `modelschemas update` is the
explicit refresh and the git diff is the review. `vite build` only
verifies files match the `.manifest.json` lockfile. Run
`modelschemas verify` to re-hash pulls against their pinned content
addresses and provenance.

Docs: [modelschemas.com/docs](https://modelschemas.com/docs) · Source:
[github.com/TanStack/modelschemas](https://github.com/TanStack/modelschemas)
