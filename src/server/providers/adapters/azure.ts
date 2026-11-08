/**
 * Azure OpenAI. Models and their facts come from two Microsoft Learn
 * articles, prices from the Azure Retail Prices API, and schemas from the
 * v1 OpenAPI document in Azure's REST API specs repo. All four are public.
 * Deployment lists on a resource need a key and are not called.
 */
import {
  AZURE_MODELS_URL,
  AZURE_REASONING_URL,
  azureChatMaxTokensField,
  azureModelInfo,
  parseAzureEffortRules,
  parseAzureFeatureMatrix,
  parseAzureModels,
} from '../azure-models.ts'
import {
  AZURE_PRICES_URL,
  azureMetered,
  azureModelPricing,
  fetchAzurePrices,
} from '../azure-pricing.ts'
import { assertParsed, cachedDocs } from '../model-facts.ts'
import { classifyOpenAiCompat } from '../openai-compat.ts'
import { fetchOpenApi, fetchText, sha256Text } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const AZURE_SPEC_URL =
  'https://raw.githubusercontent.com/Azure/azure-rest-api-specs/main/specification/ai/data-plane/OpenAI.v1/azure-v1-v1-generated.json'

/** A Learn article as markdown, parsed, with the hash of what was read. */
function learnDoc<T>(
  kv: KVNamespace | undefined,
  url: string,
  parse: (markdown: string) => Map<string, T>,
): Promise<{ rows: Record<string, T>; hash: string }> {
  return cachedDocs(kv, url, async () => {
    const markdown = await fetchText(url, {
      headers: { Accept: 'text/markdown' },
    })
    const rows = parse(markdown)
    assertParsed(rows, `azure ${url}`)
    return { rows: Object.fromEntries(rows), hash: await sha256Text(markdown) }
  })
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const [models, reasoning, prices, chatTokens] = await Promise.all([
    learnDoc(kv, AZURE_MODELS_URL, parseAzureModels),
    cachedDocs(kv, AZURE_REASONING_URL, async () => {
      const markdown = await fetchText(AZURE_REASONING_URL, {
        headers: { Accept: 'text/markdown' },
      })
      const matrix = parseAzureFeatureMatrix(markdown)
      assertParsed(matrix, `azure ${AZURE_REASONING_URL}`)
      return {
        rows: Object.fromEntries(matrix),
        rules: parseAzureEffortRules(markdown),
        columnIds: [...matrix.keys()],
        hash: await sha256Text(markdown),
      }
    }),
    cachedDocs(kv, AZURE_PRICES_URL, fetchAzurePrices),
    cachedDocs(kv, AZURE_SPEC_URL, async () => {
      const { spec, hash } = await fetchOpenApi(AZURE_SPEC_URL)
      return { maxTokensField: azureChatMaxTokensField(spec), hash }
    }),
  ])
  const hashes = { models: models.hash, reasoning: reasoning.hash }
  const columnIds = new Set(reasoning.columnIds)
  const tabulated = Object.values(models.rows)
    .filter((row) => row.tabulated)
    .map((row) => row.rawId)
  return {
    models: Object.values(models.rows)
      .filter(
        (row) =>
          row.tabulated || azureMetered(prices.meters, row.rawId, tabulated),
      )
      .map((row) => {
        const info = azureModelInfo(row, reasoning.rows[row.rawId], hashes, {
          rules: reasoning.rules,
          columnIds,
          chatMaxTokens: chatTokens.maxTokensField,
        })
        if (row.activity !== 'chat') return info
        const priced = azureModelPricing(prices, row.rawId, row.version)
        return {
          ...info,
          ...priced,
          factSources: { ...info.factSources, ...priced.factSources },
        }
      }),
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(AZURE_SPEC_URL)
  return {
    specs: [spec],
    sources: [{ url: AZURE_SPEC_URL, hash }],
    outputStrategy: 'post-200',
    // Floating `main` URL: the document hash is the revision id.
    specRevision: hash,
  }
}

export const provider: ProviderConfig = {
  id: 'azure',
  // Azure OpenAI serves OpenAI models under OpenAI's ids; an id with no
  // OpenAI row simply stays unlinked.
  upstreamModelIdentity: (rawId) => ({
    providerNamespace: 'openai',
    rawId,
    source: {
      derivation: 'docs-derived',
      sourceUrl: AZURE_MODELS_URL,
      path: 'model id',
    },
  }),
  displayName: 'Azure OpenAI',
  specSourceUrl: AZURE_SPEC_URL,
  modelsEndpoint: AZURE_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  // Azure's v1 data plane: https://{resource}.openai.azure.com/openai/v1.
  // Either an `api-key` header or a Microsoft Entra bearer token.
  connect: {
    servers: [
      {
        url: 'https://{resource}.openai.azure.com/openai/v1',
        variables: {
          resource: {
            default: 'my-resource',
            description: 'The Azure OpenAI resource name.',
          },
        },
      },
    ],
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'api-key',
        description: 'An Azure OpenAI resource key.',
      },
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'A Microsoft Entra token for https://cognitiveservices.azure.com/.default as `Authorization: Bearer <token>`.',
      },
    },
    security: [{ apiKey: [] }, { bearerAuth: [] }],
  },
  fetchSpec,
  listModels,
  classify: classifyOpenAiCompat,
}
