/**
 * TypeSafe — Jev, the System One decision model. The public OpenAPI
 * document is https://api.typesafe.ai/openapi.json. `POST /v1/systemone`
 * also accepts multipart (a JSON part plus image parts). The extractor
 * would keep that form and drop the JSON body, which is the request
 * TanStack AI sends, so the multipart alternative is removed before
 * classify. Images still go in the JSON body as `assets`.
 *
 * The catalog is the public models page, not `GET /v1/models` (that list
 * needs a key and currently names aliases only). Versioned ids are
 * accepted whether or not the account list shows them, so `model` stays
 * an open string.
 */
import type { Activity } from '#/db/schema.ts'
import { bearerConnect } from '../connect.ts'
import { fetchOpenApi, fetchText } from '../types.ts'
import type {
  OpenApiDocument,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'
import { TYPESAFE_MODELS_URL, typesafeModelInfos } from '../typesafe-models.ts'

export const TYPESAFE_OPENAPI_URL = 'https://api.typesafe.ai/openapi.json'
export const TYPESAFE_API_BASE = 'https://api.typesafe.ai'

/** Keep the JSON body. Multipart is the same request plus image parts. */
export function jsonSystemOne(spec: OpenApiDocument): OpenApiDocument {
  const paths = spec.paths
  const path = paths?.['/v1/systemone']
  const post = path?.post
  const requestBody = post?.requestBody
  if (
    requestBody === null ||
    typeof requestBody !== 'object' ||
    Array.isArray(requestBody)
  ) {
    throw new Error('typesafe: POST /v1/systemone has no request body')
  }
  const content = (requestBody as { content?: Record<string, unknown> }).content
  if (!content?.['application/json']) {
    throw new Error('typesafe: POST /v1/systemone has no JSON body')
  }
  if (!content['multipart/form-data']) return spec
  const next = { ...content }
  delete next['multipart/form-data']
  return {
    ...spec,
    paths: {
      ...paths,
      '/v1/systemone': {
        ...path,
        post: {
          ...post,
          requestBody: { ...requestBody, content: next },
        },
      },
    },
  }
}

function classify(path: string): Activity | null {
  return path === '/v1/systemone' ? 'decision' : null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(TYPESAFE_OPENAPI_URL)
  return {
    specs: [jsonSystemOne(spec)],
    sources: [{ url: TYPESAFE_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

export const provider: ProviderConfig = {
  id: 'typesafe',
  displayName: 'TypeSafe',
  authEnvVar: 'TYPESAFE_API_KEY',
  specSourceUrl: TYPESAFE_OPENAPI_URL,
  modelsEndpoint: TYPESAFE_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  connect: bearerConnect(TYPESAFE_API_BASE),
  openModelNames: true,
  fetchSpec,
  listModels: async () => ({
    models: await typesafeModelInfos(await fetchText(TYPESAFE_MODELS_URL)),
  }),
  classify,
  generationEndpointId: ({ activity }) =>
    activity === 'decision' ? 'v1/systemone' : null,
}
