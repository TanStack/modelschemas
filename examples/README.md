# Examples

Three small [TanStack Start](https://tanstack.com/start) apps showing the
modelschemas packages in real use. Each links to the workspace packages by
`workspace:*` reference — run `pnpm install` at the repo root first.

| Example                                | Shows                                                                                                                                   | Port |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| [schema-studio](./schema-studio)       | `@modelschemas/vite` — schemas pulled at dev time, committed, verified offline at build; rendered as generative UI (schema-driven form) | 3201 |
| [image-dimensions](./image-dimensions) | `@modelschemas/client` — live discovery of image models; supported dimensions extracted from each input schema and drawn to scale       | 3202 |
| [video-composer](./video-composer)     | `@modelschemas/client` — video request builder whose model/aspect-ratio/duration pickers only offer values the schema allows            | 3203 |

```bash
pnpm install                      # repo root — links workspace packages
cd examples/schema-studio        # or image-dimensions / video-composer
pnpm run dev
```

All three fetch from the live service at `https://modelschemas.com` by
default. Point them at another deployment (e.g. a local dev server with
freshly synced providers) with:

```bash
MODELSCHEMAS_URL=http://localhost:3100 pnpm run dev
```

API calls happen server-side (TanStack Start server functions, or the
`@modelschemas/vite` plugin at dev/build time), so no CORS setup is needed.

## Deploying

Every example ships with a Cloudflare Workers setup: `pnpm run deploy` inside
an example builds it and deploys it to your own account, running at the root
of your workers.dev subdomain (reading from the live modelschemas API by
default). The `modelschemas` Wrangler environment
(`CLOUDFLARE_ENV=modelschemas pnpm run deploy`) is the canonical deployment,
which mounts each app at `modelschemas.com/examples/<name>/` via a zone
route — only deployable by maintainers, since it targets the
modelschemas.com zone.
