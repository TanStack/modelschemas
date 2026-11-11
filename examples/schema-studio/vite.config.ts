import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { modelschemas } from '@modelschemas/vite'

// Standalone by default (`pnpm run deploy` → your own workers.dev, app at
// "/"); the modelschemas Cloudflare environment mounts this example at
// modelschemas.com/examples/schema-studio/ via a zone route — see
// wrangler.jsonc. Router basepath and server-fn base derive from `base`.
const hosted = process.env.CLOUDFLARE_ENV === 'modelschemas'

// Schemas are pulled into src/modelschemas at dev time and committed;
// `vite build` only verifies the files against .manifest.json (offline).
export default defineConfig({
  base: hosted ? '/examples/schema-studio/' : '/',
  server: { port: 3201 },
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    modelschemas({
      baseUrl: process.env.MODELSCHEMAS_URL ?? 'https://modelschemas.com',
      selections: [
        'anthropic/v1/messages#request',
        'openrouter/chat/completions#request',
        'openrouter/videos/google/veo-3.1#request',
        'openrouter/audio/speech#request',
      ],
      // The generative-UI renderer consumes the schema JSON itself, so pull
      // schema-const modules rather than generated TypeScript types.
      types: false,
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})
