import type { ProviderConfig } from '#/server/providers/types.ts'

import type { providers } from './schema.ts'

export type ProviderSeed = typeof providers.$inferInsert

/**
 * Seed row for any registered provider: the hand-written row for the
 * original 8, `seedFromAdapter` for auto-registered adapters. Lets the
 * sync/poll engines upsert provider rows so a fresh adapter appears without
 * a manual `pnpm run seed` against prod. Null when no seed can be derived
 * (a config without specSourceUrl, e.g. a test stub) — callers skip the
 * upsert and rely on the row already existing.
 */
export function seedForProvider(provider: ProviderConfig): ProviderSeed | null {
  const listed = providerSeeds.find((seed) => seed.id === provider.id)
  if (listed) return listed
  return provider.specSourceUrl ? seedFromAdapter(provider) : null
}

/** Map an auto-registered adapter onto a seed row. */
export function seedFromAdapter(provider: ProviderConfig): ProviderSeed {
  const specSourceUrl = provider.specSourceUrl
  if (!specSourceUrl) {
    throw new Error(`adapter ${provider.id} is missing specSourceUrl`)
  }
  return {
    id: provider.id,
    displayName: provider.displayName,
    specSourceUrl,
    modelsEndpoint: provider.modelsEndpoint,
    authEnvVar: provider.authEnvVar ?? null,
  }
}

/**
 * Spec-source config for the 8 monitored providers, ported from TanStack AI
 * PR #622 (`packages/ai-schemas/scripts/providers/*`):
 *
 * - OpenAI's seeded URL is openai-node's Castiron `openapi.transformed.yml`,
 *   which leads the public openai-openapi export.
 * - Anthropic's spec is the gzipped OpenAPI JSON bundled in the Stainless
 *   TypeScript SDK (`scripts/mock-spec.json.gz`), gunzipped at sync time.
 * - Gemini publishes a Google Discovery document, converted to OpenAPI during
 *   sync.
 * - FAL lists per-model OpenAPI specs from its models API via the
 *   `expand=openapi-3.0` query param; output schemas use the PR's
 *   `sibling-get` strategy rather than `post-200`.
 * - OpenRouter also exposes `/api/v1/videos/models` for synthesized
 *   per-model video endpoints.
 * - BytePlus publishes no machine-readable spec; specs and the model catalog
 *   are embedded in `src/server/providers/byteplus{,-spec}.ts` (ported from
 *   `@tanstack/ai-byteplus`), so the seeded URLs are provenance/config
 *   metadata, not fetch targets.
 */
export const providerSeeds: Array<ProviderSeed> = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    specSourceUrl:
      'https://raw.githubusercontent.com/openai/openai-node/main/api_reference/openapi.transformed.yml',
    modelsEndpoint: 'https://api.openai.com/v1/models',
    authEnvVar: 'OPENAI_API_KEY',
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    // Stainless-bundled spec; gunzipped at sync time.
    specSourceUrl:
      'https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/scripts/mock-spec.json.gz',
    modelsEndpoint: 'https://api.anthropic.com/v1/models',
    authEnvVar: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'gemini',
    displayName: 'Google Gemini',
    // Discovery document; converted to OpenAPI at sync time.
    specSourceUrl:
      'https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta',
    modelsEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    authEnvVar: 'GEMINI_API_KEY',
  },
  {
    id: 'grok',
    displayName: 'xAI Grok',
    specSourceUrl: 'https://docs.x.ai/openapi.json',
    modelsEndpoint: 'https://api.x.ai/v1/models',
    authEnvVar: 'XAI_API_KEY',
  },
  {
    id: 'elevenlabs',
    displayName: 'ElevenLabs',
    specSourceUrl: 'https://api.elevenlabs.io/openapi.json',
    modelsEndpoint: 'https://api.elevenlabs.io/v1/models',
    authEnvVar: 'ELEVENLABS_API_KEY',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    specSourceUrl: 'https://openrouter.ai/openapi.json',
    // No key required — OpenRouter is the keyless smoke-test provider.
    modelsEndpoint: 'https://openrouter.ai/api/v1/models',
    authEnvVar: null,
  },
  {
    id: 'fal',
    displayName: 'FAL',
    // Per-model specs via expand=openapi-3.0; paginated.
    specSourceUrl: 'https://api.fal.ai/v1/models?expand=openapi-3.0',
    modelsEndpoint: 'https://api.fal.ai/v1/models',
    authEnvVar: 'FAL_KEY',
  },
  {
    id: 'byteplus',
    displayName: 'BytePlus',
    // Human docs the embedded spec was derived from — nothing is fetched.
    specSourceUrl: 'https://docs.byteplus.com/en/docs/ModelArk',
    // Polled live when ARK_API_KEY is set; the embedded catalog fills the
    // gaps (Seed Speech, ids Ark serves but does not enumerate) and stands in
    // entirely when it is not.
    modelsEndpoint: 'https://ark.ap-southeast.bytepluses.com/api/v3/models',
    authEnvVar: 'ARK_API_KEY',
  },
]
