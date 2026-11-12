import { defineConfig } from '@hey-api/openapi-ts'

// Generation input is the emitted spec at the repo root (`pnpm run
// openapi:emit`). Output is committed; CI fails when it drifts from the spec
// (pnpm run check:client).
export default defineConfig({
  input: '../../openapi.json',
  output: {
    path: 'src/generated',
    postProcess: ['oxfmt'],
    // `.js` is what nodenext loads. The generator would infer this from a
    // nodenext tsconfig, but it finds the repo root config, which is bundler.
    module: { extension: '.js' },
  },
  plugins: ['@hey-api/client-fetch', '@hey-api/typescript', '@hey-api/sdk'],
})
