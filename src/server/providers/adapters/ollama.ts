/**
 * Ollama — the REST API a local (or self-hosted) Ollama server serves.
 * The spec is Ollama's own OpenAPI document (`docs/openapi.yaml` in
 * ollama/ollama, the source of docs.ollama.com/api). `/api/chat` and
 * `/api/generate` stream NDJSON (`application/x-ndjson`), kept beside the
 * JSON body.
 *
 * No model catalog: a server runs whatever was pulled into it, so the
 * listing is empty and `model` stays a free string in the assembled
 * document. The server URL is a variable, default `http://localhost:11434`.
 * Local servers take no key; ollama.com takes a bearer key.
 */
import type { Activity } from '#/db/schema.ts'

import { fetchOpenApi } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderConnect,
  SpecFetchResult,
} from '../types.ts'

export const OLLAMA_OPENAPI_URL =
  'https://raw.githubusercontent.com/ollama/ollama/main/docs/openapi.yaml'
const OLLAMA_DOCS_URL = 'https://docs.ollama.com/api'

const ROUTES: Record<string, Activity> = {
  '/api/chat': 'chat',
  '/api/generate': 'chat',
  '/api/embed': 'embeddings',
}

export const OLLAMA_CONNECT: ProviderConnect = {
  servers: [
    {
      url: '{baseUrl}',
      description: 'Your Ollama server.',
      variables: {
        baseUrl: {
          default: 'http://localhost:11434',
          description:
            'Ollama server URL: `http://localhost:11434` locally, `https://ollama.com` for Ollama cloud.',
        },
      },
    },
  ],
  securitySchemes: {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      description:
        'Ollama API key as `Authorization: Bearer <key>`; only ollama.com needs it.',
    },
  },
  // `{}`: a local server takes no auth.
  security: [{}, { bearerAuth: [] }],
}

async function fetchSpec(): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(OLLAMA_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: OLLAMA_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

function listModels(): Promise<ListModelsResult> {
  return Promise.resolve({ models: [] })
}

export const provider: ProviderConfig = {
  id: 'ollama',
  displayName: 'Ollama',
  specSourceUrl: OLLAMA_DOCS_URL,
  defaultDerivation: 'upstream-spec',
  connect: OLLAMA_CONNECT,
  fetchSpec,
  listModels,
  classify: (path) => ROUTES[path] ?? null,
}
