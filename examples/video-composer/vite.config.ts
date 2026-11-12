import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

// Standalone by default (`pnpm run deploy` → your own workers.dev, app at
// "/"); the modelschemas Cloudflare environment mounts this example at
// modelschemas.com/examples/video-composer/ via a zone route — see
// wrangler.jsonc. Router basepath and server-fn base derive from `base`.
const hosted = process.env.CLOUDFLARE_ENV === 'modelschemas'

export default defineConfig({
  base: hosted ? '/examples/video-composer/' : '/',
  server: { port: 3203 },
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})
