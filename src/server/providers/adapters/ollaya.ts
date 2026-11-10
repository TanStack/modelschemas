/**
 * Ollaya — a local server for open decision models (laya, decima, …). It
 * publishes no OpenAPI document; its normative contract is `docs/api.md` in
 * ollaya-dev/ollaya. `POST /v1/systemone` is hand-written from §5 and §8.1
 * there (TypeSafe's wire format, plus Ollaya's array `criteria` and
 * `ordinal` extensions; no TypeSafe `box` questions or `assets`). The
 * server runs on the caller's machine, so the server URL is a variable.
 *
 * Models come from the public registry: the repo tree names every
 * `<family>/manifests/<tag>`, and each manifest on ollaya.dev points at a
 * config blob with the description, context length and release date. No
 * key; nothing is priced (the models run locally).
 */
import { githubRequestInit } from '../github.ts'
import { cachedDocs, mapConcurrent } from '../model-facts.ts'
import { fetchJson, fetchText, sha256Text } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  OpenApiDocument,
  ProviderConfig,
  ProviderConnect,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const OLLAYA_DOCS_URL =
  'https://github.com/ollaya-dev/ollaya/blob/main/docs/api.md'
export const OLLAYA_TREE_URL =
  'https://api.github.com/repos/ollaya-dev/ollaya/git/trees/main:registry/v2/library?recursive=1'
export const OLLAYA_CONTRACT_URL =
  'https://raw.githubusercontent.com/ollaya-dev/ollaya/main/docs/api.md'
const OLLAYA_REGISTRY = 'https://ollaya.dev/v2/library'

export const OLLAYA_CONNECT: ProviderConnect = {
  servers: [
    {
      url: '{baseUrl}',
      description: 'Your Ollaya server (OLLAYA_HOST).',
      variables: {
        baseUrl: {
          default: 'http://127.0.0.1:11435',
          description:
            'Origin of the Ollaya server. It runs locally on 127.0.0.1:11435 unless OLLAYA_HOST says otherwise.',
        },
      },
    },
  ],
  securitySchemes: {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      description:
        'Only checked when the server sets OLLAYA_API_KEY: `Authorization: Bearer <key>`.',
    },
  },
  // Either no auth (the default) or the bearer key.
  security: [{}, { bearerAuth: [] }],
}

type Schema = Record<string, unknown>

/** string | object | array, as TypeSafe's `x-accepts` spells it. */
const textLike = (description: string): Schema => ({
  description,
  anyOf: [
    { type: 'string' },
    { type: 'object', additionalProperties: true },
    { type: 'array', items: {} },
  ],
})
const optionalTextLike = (description: string): Schema => ({
  description,
  anyOf: [
    { type: 'string' },
    { type: 'object', additionalProperties: true },
    { type: 'array', items: {} },
    { type: 'null' },
  ],
})

const instructions = optionalTextLike(
  'What the model should decide. Absent or null: the question id is read in its place.',
)

const choiceQuestion: Schema = {
  type: 'object',
  required: ['type', 'criteria'],
  properties: {
    type: { type: 'string', const: 'choice' },
    instructions,
    criteria: {
      description:
        'Labels, 2–255: an object label → description, or (Ollaya extension) an array of label strings.',
      anyOf: [
        {
          type: 'object',
          minProperties: 2,
          maxProperties: 255,
          additionalProperties: optionalTextLike('When this label applies.'),
        },
        {
          type: 'array',
          minItems: 2,
          maxItems: 255,
          items: { type: 'string' },
        },
      ],
    },
    ordinal: {
      type: ['boolean', 'null'],
      description:
        'Labels are in order (Ollaya extension, 2–10 labels). Only models with an ordinal head (Decima) accept true; others return 422.',
    },
  },
}

const scoreQuestion: Schema = {
  type: 'object',
  required: ['type', 'criteria'],
  properties: {
    type: { type: 'string', const: 'score' },
    instructions,
    criteria: {
      type: 'array',
      minItems: 2,
      maxItems: 10,
      description: 'Level descriptions, level 0 first.',
      items: textLike('One level.'),
    },
  },
}

const noulQuestion: Schema = {
  type: 'object',
  required: ['type'],
  properties: {
    type: { type: 'string', const: 'noul' },
    instructions,
    criteria: {
      description:
        'Optional descriptions of when the statement is true or false.',
      anyOf: [
        {
          type: 'object',
          properties: {
            true: optionalTextLike('When the statement holds.'),
            false: optionalTextLike('When it does not.'),
          },
        },
        { type: 'null' },
      ],
    },
  },
}

const question: Schema = {
  oneOf: [
    { $ref: '#/components/schemas/ChoiceQuestion' },
    { $ref: '#/components/schemas/ScoreQuestion' },
    { $ref: '#/components/schemas/NoulQuestion' },
  ],
  discriminator: {
    propertyName: 'type',
    mapping: {
      choice: '#/components/schemas/ChoiceQuestion',
      score: '#/components/schemas/ScoreQuestion',
      noul: '#/components/schemas/NoulQuestion',
    },
  },
}

const systemOneRequest: Schema = {
  type: 'object',
  required: ['model', 'state', 'questions'],
  properties: {
    model: {
      type: 'string',
      minLength: 1,
      description:
        'Model name, `[namespace/]model[:tag]`, e.g. `laya` (= `laya:latest`) or `laya:en`. Must be pulled on the server.',
    },
    state: textLike(
      'The content every question is about. At most 65,536 tokens; a state that does not fit the model context is 422 STATE_TRUNCATED.',
    ),
    questions: {
      type: 'object',
      minProperties: 1,
      maxProperties: 256,
      description: 'Question id → question, answered in this order.',
      additionalProperties: { $ref: '#/components/schemas/Question' },
    },
  },
}

const probabilities: Schema = {
  type: 'object',
  additionalProperties: { type: 'number' },
}

const choiceAnswer: Schema = {
  type: 'object',
  required: ['type', 'choice', 'confidence', 'probabilities'],
  properties: {
    type: { type: 'string', const: 'choice' },
    choice: { type: 'string', description: 'The most probable label.' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    probabilities: { ...probabilities, description: 'Label → probability.' },
  },
}

const scoreAnswer: Schema = {
  type: 'object',
  required: ['type', 'score', 'confidence', 'legend', 'probabilities'],
  properties: {
    type: { type: 'string', const: 'score' },
    score: {
      type: 'number',
      description: 'Expected level Σ i·pᵢ; can fall between levels.',
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    legend: {
      type: 'object',
      description: 'Level ("0", "1", …) → its description, verbatim.',
      additionalProperties: {},
    },
    probabilities: { ...probabilities, description: 'Level → probability.' },
  },
}

const noulAnswer: Schema = {
  type: 'object',
  required: ['type', 'noul'],
  properties: {
    type: { type: 'string', const: 'noul' },
    noul: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Probability that the statement holds.',
    },
  },
}

const systemOneResponse: Schema = {
  type: 'object',
  required: ['model', 'answers', 'usage'],
  properties: {
    model: {
      type: 'string',
      description:
        'Canonical name of the model that answered (a router reports its target, e.g. `laya:en`).',
    },
    answers: {
      type: 'object',
      description: 'Question id → answer, in question order.',
      additionalProperties: {
        oneOf: [
          { $ref: '#/components/schemas/ChoiceAnswer' },
          { $ref: '#/components/schemas/ScoreAnswer' },
          { $ref: '#/components/schemas/NoulAnswer' },
        ],
        discriminator: {
          propertyName: 'type',
          mapping: {
            choice: '#/components/schemas/ChoiceAnswer',
            score: '#/components/schemas/ScoreAnswer',
            noul: '#/components/schemas/NoulAnswer',
          },
        },
      },
    },
    usage: {
      type: 'object',
      required: ['input_tokens', 'output_tokens'],
      properties: {
        input_tokens: { type: 'integer', minimum: 0 },
        output_tokens: { type: 'integer', const: 0 },
      },
    },
  },
}

const errorBody: Schema = {
  type: 'object',
  required: ['error', 'code'],
  properties: {
    error: { type: 'string', description: 'Human-readable; do not parse.' },
    code: {
      type: 'string',
      description:
        'UPPER_SNAKE_CASE, e.g. MODEL_NOT_FOUND, INVALID_REQUEST, STATE_TRUNCATED. The set is open.',
    },
    detail: {
      type: 'array',
      description:
        'Validation issues (422 only), in TypeSafe `ValidationError` shape.',
      items: {
        type: 'object',
        required: ['loc', 'msg', 'type'],
        properties: {
          loc: {
            type: 'array',
            items: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
          },
          msg: { type: 'string' },
          type: { type: 'string' },
          ctx: { type: 'object', additionalProperties: true },
        },
      },
    },
  },
}

const errorResponse = (description: string) => ({
  description,
  content: {
    'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } },
  },
})

export function ollayaSpec(): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: { title: 'Ollaya', version: 'docs/api.md' },
    paths: {
      '/v1/systemone': {
        post: {
          operationId: 'systemone',
          summary: 'Answer typed questions about a state',
          description:
            'TypeSafe System One, wire-identical. Choice, score and noul questions; no implicit model pull.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SystemOneRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'One answer per question.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SystemOneResponse' },
                },
              },
            },
            '400': errorResponse('Body is not a JSON object (INVALID_JSON).'),
            '401': errorResponse(
              'OLLAYA_API_KEY is set and the key is missing.',
            ),
            '404': errorResponse(
              'Model not pulled on this server (MODEL_NOT_FOUND).',
            ),
            '422': errorResponse(
              'Validation failed; `detail` lists every issue.',
            ),
            '503': errorResponse(
              'Queue full (QUEUE_FULL); retry after Retry-After.',
            ),
          },
        },
      },
    },
    components: {
      schemas: {
        SystemOneRequest: systemOneRequest,
        Question: question,
        ChoiceQuestion: choiceQuestion,
        ScoreQuestion: scoreQuestion,
        NoulQuestion: noulQuestion,
        SystemOneResponse: systemOneResponse,
        ChoiceAnswer: choiceAnswer,
        ScoreAnswer: scoreAnswer,
        NoulAnswer: noulAnswer,
        ErrorBody: errorBody,
      },
    },
  }
}

/**
 * The source hash is the contract's own text, so an edit to docs/api.md
 * shows as a new source revision even though the schemas are hand-written.
 */
async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const contract = await fetchText(OLLAYA_CONTRACT_URL)
  return {
    specs: [ollayaSpec()],
    sources: [{ url: OLLAYA_DOCS_URL, hash: await sha256Text(contract) }],
    outputStrategy: 'post-200',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const PRECISION_PIN = /-fp(16|32)$/

/**
 * `family:tag` names from the registry tree. Digest copies (`sha256-…`) are
 * not tags, and a precision pin (`en-fp32`) is its base tag's weights with
 * one graph, so it is listed only when the base tag is missing.
 */
export function registryTags(tree: unknown): Array<string> {
  const entries = isRecord(tree) ? tree.tree : undefined
  if (!Array.isArray(entries))
    throw new Error('ollaya: registry tree has no entries')
  if (isRecord(tree) && tree.truncated === true) {
    throw new Error('ollaya: registry tree is truncated')
  }
  const names = new Set<string>()
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== 'blob') continue
    const match = /^([^/]+)\/manifests\/([^/]+)$/.exec(String(entry.path))
    if (!match?.[1] || !match[2] || match[2].startsWith('sha256-')) continue
    names.add(`${match[1]}:${match[2]}`)
  }
  const tags = [...names].filter((name) => {
    const base = name.replace(PRECISION_PIN, '')
    return base === name || !names.has(base)
  })
  if (tags.length === 0) throw new Error('ollaya: registry tree lists no tags')
  return tags.sort()
}

/** One registry config blob → a catalog row. */
export function parseOllayaConfig(rawId: string, config: unknown): ModelInfo {
  if (!isRecord(config))
    throw new Error(`ollaya: ${rawId} config is not an object`)
  const bad = (field: string) =>
    new Error(`ollaya: ${rawId} config.${field} is unreadable`)
  // Absent is unstated; a router states 0 (no context of its own).
  const context = config.context_length ?? 0
  if (
    typeof context !== 'number' ||
    !Number.isInteger(context) ||
    context < 0
  ) {
    throw bad('context_length')
  }
  let releasedAt: number | null = null
  if (config.release_date != null) {
    const released =
      typeof config.release_date === 'string'
        ? Date.parse(config.release_date)
        : Number.NaN
    if (!Number.isFinite(released)) throw bad('release_date')
    releasedAt = Math.floor(released / 1000)
  }
  const source = config.source ?? ''
  if (typeof source !== 'string') throw bad('source')
  const hf = /^huggingface\.co\/([^/@]+\/[^/@]+)/.exec(source)
  return {
    rawId,
    displayName: null,
    activity: 'decision',
    contextWindow: context > 0 ? context : null,
    releasedAt,
    openWeights: hf ? true : null,
    weightsUrl: hf ? `https://huggingface.co/${hf[1]}` : null,
    providerMetadata: config,
  }
}

async function loadRegistry(env: ProviderSecrets): Promise<Array<ModelInfo>> {
  const tags = registryTags(
    await fetchJson(OLLAYA_TREE_URL, githubRequestInit(OLLAYA_TREE_URL, env)),
  )
  const configs = new Map<string, Promise<unknown>>()
  // ponytail: one manifest fetch per tag (~120) plus one per distinct
  // config, on a cache miss only. A registry index endpoint would make it one.
  return mapConcurrent(tags, 6, async (rawId) => {
    const [family, tag] = rawId.split(':')
    const manifest = await fetchJson(
      `${OLLAYA_REGISTRY}/${family}/manifests/${tag}`,
    )
    const config = isRecord(manifest) ? manifest.config : undefined
    const urls: unknown = isRecord(config) ? config.urls : undefined
    const url: unknown = Array.isArray(urls) ? urls[0] : undefined
    if (typeof url !== 'string') {
      throw new Error(`ollaya: ${rawId} manifest has no config url`)
    }
    let blob = configs.get(url)
    if (!blob) {
      blob = fetchJson(url)
      configs.set(url, blob)
    }
    return parseOllayaConfig(rawId, await blob)
  })
}

async function listModels(
  env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  return {
    models: await cachedDocs(kv, OLLAYA_TREE_URL, () => loadRegistry(env)),
  }
}

export const provider: ProviderConfig = {
  id: 'ollaya',
  displayName: 'Ollaya',
  specSourceUrl: OLLAYA_DOCS_URL,
  modelsEndpoint: OLLAYA_TREE_URL,
  defaultDerivation: 'docs-derived',
  connect: OLLAYA_CONNECT,
  openModelNames: true,
  fetchSpec,
  listModels,
  classify: (path) => (path === '/v1/systemone' ? 'decision' : null),
  generationEndpointId: ({ activity }) =>
    activity === 'decision' ? 'v1/systemone' : null,
}
