// Loaded with `node --import ./scripts/register-hash-imports.mjs` before a
// repo script. Two resolution gaps between this TypeScript and Node:
//
// - `#/…` is the app alias (`package.json` imports + tsconfig paths). Node
//   rejects any specifier that starts with `#/`.
// - Workspace packages use nodenext `.js` specifiers for files that exist
//   as `.ts` until `tsc` emits `dist/`. Node does not rewrite those.
//
// Also loads `.env` then `.env.local`, which Bun did for `bun scripts/…`.
// A variable already in the environment wins. `.env.local` wins over `.env`.
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { config as loadEnv } from 'dotenv'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')

const prior = { ...process.env }
loadEnv({ path: join(root, '.env'), override: false, quiet: true })
loadEnv({ path: join(root, '.env.local'), override: true, quiet: true })
for (const [key, value] of Object.entries(prior)) {
  if (value !== undefined) process.env[key] = value
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('#/')) {
      return {
        url: pathToFileURL(join(root, 'src', specifier.slice(2))).href,
        shortCircuit: true,
      }
    }
    if (specifier.endsWith('.js')) {
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        if (!isNotFound(error)) throw error
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
    }
    return nextResolve(specifier, context)
  },
})

/** @param {unknown} error */
function isNotFound(error) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ERR_MODULE_NOT_FOUND'
  )
}
