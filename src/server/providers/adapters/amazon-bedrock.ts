/**
 * Amazon Bedrock — first-party only (issue #153). Models come from the user
 * guide's model cards; the runtime schema (Converse, ConverseStream,
 * InvokeModel, InvokeModelWithResponseStream) is generated from the AWS
 * SDK's Bedrock Runtime service model. Neither needs AWS credentials
 * (ListFoundationModels does), and no aggregator is read.
 */
import type { Activity } from '#/db/schema.ts'

import { BEDROCK_CARDS_URL, bedrockCardListing } from '../bedrock-cards.ts'
import {
  BEDROCK_RUNTIME_PATHS,
  BEDROCK_SDK_MODEL_URL,
  bedrockConverseSpec,
} from '../bedrock-sdk-spec.ts'
import type { BedrockServiceModel } from '../bedrock-sdk-spec.ts'
import { loadBedrockConverseWireMaps } from '../bedrock-converse-facts.ts'
import { loadBedrockThinkingGuides } from '../bedrock-thinking-guides.ts'
import { docsRun, docsReport } from '../model-facts.ts'
import { fetchText, sha256Text } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const text = await fetchText(BEDROCK_SDK_MODEL_URL)
  const hash = await sha256Text(text)
  return {
    specs: [bedrockConverseSpec(JSON.parse(text) as BedrockServiceModel)],
    sources: [{ url: BEDROCK_SDK_MODEL_URL, hash }],
    outputStrategy: 'post-200',
    specRevision: hash,
  }
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const catalog = await bedrockCardListing(kv)
  const run = docsRun()
  const thinking = await loadBedrockThinkingGuides(
    catalog.models,
    catalog.groups,
    run,
    kv,
  )
  const models = await loadBedrockConverseWireMaps(thinking, run, kv)
  return { models, docsFailures: docsReport(run) }
}

export const provider: ProviderConfig = {
  id: 'amazon-bedrock',
  // LLM Gateway route name (providers[].providerId).
  modelNamespaces: ['aws-bedrock'],
  displayName: 'Amazon Bedrock',
  specSourceUrl: BEDROCK_SDK_MODEL_URL,
  modelsEndpoint: BEDROCK_CARDS_URL,
  defaultDerivation: 'generated',
  // Converse is an AWS API: requests are SigV4-signed (service `bedrock`).
  // A Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`) is the stated alternative.
  connect: {
    servers: [
      {
        url: 'https://bedrock-runtime.{region}.amazonaws.com',
        variables: {
          region: {
            default: 'us-east-1',
            description: 'The AWS Region you call.',
          },
        },
      },
    ],
    securitySchemes: {
      sigv4: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        'x-amazon-apigateway-authtype': 'awsSigv4',
        description:
          'AWS Signature Version 4 with service `bedrock` and the Region in the URL; a generated HTTP client cannot sign this itself, so route through an AWS SDK or a SigV4 signer.',
      },
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'A Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`) as `Authorization: Bearer <key>`.',
      },
    },
    security: [{ sigv4: [] }, { bearerAuth: [] }],
  },
  fetchSpec,
  listModels,
  classify: (path): Activity | null =>
    (BEDROCK_RUNTIME_PATHS as ReadonlyArray<string>).includes(path)
      ? 'chat'
      : null,
}
