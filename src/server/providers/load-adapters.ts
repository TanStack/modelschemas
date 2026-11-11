/**
 * Auto-discover provider adapters so each new provider is a single new
 * file under `./adapters/` (plus its test). Adding a provider must not
 * edit this file, `index.ts`, or `seed-providers.ts` — otherwise parallel
 * adapter branches collide.
 *
 * Convention: `src/server/providers/adapters/<id>.ts` exports
 * `export const provider: ProviderConfig` with `id`, `specSourceUrl`,
 * and `modelsEndpoint` set. `*.test.ts` files are ignored.
 *
 * Vite/vitest transform `import.meta.glob`. Do not import this module
 * from Node scripts (`scripts/seed.ts` scans the adapters directory
 * itself).
 */
import type { ProviderConfig } from './types.ts'

const CORE_PROVIDER_IDS = new Set([
  'openai',
  'anthropic',
  'gemini',
  'grok',
  'elevenlabs',
  'openrouter',
  'fal',
  'byteplus',
])

// Exclude `*.test.ts` in the glob itself. `{ eager: true }` on `*.ts`
// would also load the tests, and a test that imports classifyAndBundle
// (→ sync → this registry) then deadlocks: adapterProviders is still
// undefined and `...adapterProviders` throws "not iterable".
const modules = import.meta.glob<{ provider?: ProviderConfig }>(
  ['./adapters/*.ts', '!./adapters/*.test.ts'],
  { eager: true },
)

function isProvider(value: unknown): value is ProviderConfig {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.displayName === 'string' &&
    typeof record.fetchSpec === 'function' &&
    typeof record.listModels === 'function' &&
    typeof record.classify === 'function'
  )
}

function loadAdapters(): Array<ProviderConfig> {
  const loaded: Array<ProviderConfig> = []
  const seen = new Set<string>()
  for (const [path, mod] of Object.entries(modules)) {
    const candidate = mod.provider
    if (!isProvider(candidate)) {
      throw new Error(
        `adapter ${path} must export const provider: ProviderConfig`,
      )
    }
    if (CORE_PROVIDER_IDS.has(candidate.id)) {
      throw new Error(
        `adapter ${path} reuses core provider id "${candidate.id}"`,
      )
    }
    if (seen.has(candidate.id)) {
      throw new Error(`duplicate adapter id "${candidate.id}" (${path})`)
    }
    if (!candidate.specSourceUrl) {
      throw new Error(`adapter ${candidate.id} is missing specSourceUrl`)
    }
    seen.add(candidate.id)
    loaded.push(candidate)
  }
  loaded.sort((a, b) => a.id.localeCompare(b.id))
  return loaded
}

export const adapterProviders: Array<ProviderConfig> = loadAdapters()
