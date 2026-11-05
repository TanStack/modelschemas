/**
 * Connect-profile helpers + defaults for assembled provider OpenAPI docs.
 */
import type {
  ProviderConfig,
  ProviderConnect,
  RequiredHeader,
  SpecGrain,
} from './types.ts'

/**
 * Queue documents narrowed with `?activity=`: FAL `video` was 653 models
 * and `image` 638 (2026-11-04), each inlined as its own schema. The
 * unnarrowed queue document is uncapped because it inlines none.
 */
export const MAX_QUEUE_SPEC_PATHS = 1024

export function bearerConnect(
  serverUrl: string,
  description?: string,
): ProviderConnect {
  return {
    servers: [{ url: serverUrl, ...(description ? { description } : {}) }],
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Provider API key as `Authorization: Bearer <key>`.',
      },
    },
    security: [{ bearerAuth: [] }],
  }
}

export function headerApiKeyConnect(
  serverUrl: string,
  headerName: string,
  extra?: Pick<ProviderConnect, 'requiredHeaders' | 'siblingGet'>,
): ProviderConnect {
  return {
    servers: [{ url: serverUrl }],
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: headerName,
      },
    },
    security: [{ apiKey: [] }],
    ...extra,
  }
}

/** OpenAPI header parameters. A constant becomes `schema.const`; a client-supplied header does not. */
export function requiredHeaderParameters(
  headers: Array<RequiredHeader> | undefined,
): Array<Record<string, unknown>> {
  if (!headers) return []
  return headers.map((header) =>
    'value' in header
      ? {
          name: header.name,
          in: 'header',
          required: true,
          schema: { type: 'string', const: header.value },
        }
      : {
          name: header.name,
          in: 'header',
          required: true,
          description: header.description,
          schema: { type: 'string' },
        },
  )
}

export function resolveSpecGrain(
  provider: ProviderConfig | undefined,
): SpecGrain {
  return provider?.specGrain ?? 'provider'
}

/**
 * Declared connect profile only. Adapters without `connect` are not
 * guessed from `modelsEndpoint` (that URL is often not the data plane).
 */
export function resolveConnect(
  provider: ProviderConfig | undefined,
): ProviderConnect | null {
  return provider?.connect ?? null
}
