/**
 * @modelschemas/client — typed fetch client for the modelschemas service.
 *
 * Everything under ./generated is produced by @hey-api/openapi-ts from the
 * service's own openapi.json (pnpm run generate:client); this file is the
 * hand-written entry adding pluggable auth and branded model ids.
 */
import { createClient, createConfig } from './generated/client/index.js'

import type { ClientOptions } from './generated/types.gen.js'

export {
  getActivitySchemas,
  getProviderOpenApi,
  getSchema,
  getServiceIndex,
  getStatus,
  listAllSchemas,
  listChanges,
  listProviders,
  listProviderSchemas,
  estimateCost,
  exportCatalog,
  extractFalPricing,
  syncProvider,
  validatePayload,
} from './generated/index.js'
export type * from './generated/index.js'
export { createClient, createConfig }
export {
  asListedModelId,
  getModel,
  listModels,
  listProviderModels,
  type ListedModel,
  type ListedModelList,
  type ListedModelId,
} from './listed-model.js'

export interface ModelschemasClientOptions {
  /** Service origin, e.g. https://modelschemas.example.com */
  baseUrl: string
  /** API key (POST /v1/agents/register-key) sent as Authorization: Bearer. */
  apiKey?: string
  /** Pre-signed agent JWT (agent-auth protocol) — alternative to apiKey. */
  agentJwt?: string
  fetch?: typeof globalThis.fetch
}

/**
 * Create a configured client instance to pass to any SDK call via the
 * `client` option:
 *
 * ```ts
 * const client = createModelschemasClient({ baseUrl, apiKey })
 * const { data } = await listProviders({ client })
 * ```
 */
export function createModelschemasClient(options: ModelschemasClientOptions) {
  const credential = options.apiKey ?? options.agentJwt
  return createClient(
    createConfig<ClientOptions>({
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      headers: credential
        ? { Authorization: `Bearer ${credential}` }
        : undefined,
    }),
  )
}
