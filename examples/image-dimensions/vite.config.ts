import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

// Standalone by default: clone the repo, `pnpm run build && wrangler deploy`,
// and the app runs at the root of your own workers.dev subdomain. The
// `modelschemas` Cloudflare environment (CLOUDFLARE_ENV=modelschemas, see
// wrangler.jsonc) is how the canonical deployment mounts this example at
// modelschemas.com/examples/image-dimensions/ — a zone route more specific
// than the main site's custom domain sends those requests here. The router
// basepath and server-fn base both derive from vite `base`.
const hosted = process.env.CLOUDFLARE_ENV === 'modelschemas'

export default defineConfig({
  base: hosted ? '/examples/image-dimensions/' : '/',
  server: { port: 3202 },
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})
