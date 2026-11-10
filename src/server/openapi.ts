/**
 * The service's own OpenAPI 3.1 document (PLAN.md task 4.1), hand-maintained.
 * Single source of truth for three consumer surfaces: the generated TS client
 * (task 7.4), the CLI (7.5), and the agent-auth capability list (5.1) — every
 * operation MUST carry a unique operationId.
 */

import { z } from 'zod'

import '#/server/api-schemas.ts'

/**
 * Every schema with a `.meta` id (RateCard and its parts, CompactPricing,
 * PricingRange, ModelReasoning, ChatRequestMap) as a component, written from
 * the zod schemas the server and the evaluator validate with, so the spec
 * and the types cannot drift.
 */
const { schemas: zodComponents } = z.toJSONSchema(z.globalRegistry, {
  io: 'output',
  unrepresentable: 'any',
  target: 'draft-2020-12',
  uri: (id) => `#/components/schemas/${id}`,
})
// Each component is not its own document.
for (const schema of Object.values(zodComponents)) {
  delete schema.$schema
  delete schema.$id
}
const rateCard = zodComponents.RateCard
if (!rateCard?.properties?.currency) {
  throw new Error('RateCard component lost its `currency` property')
}
// `currency: never` is how the zod schema refuses a top-level currency; as
// JSON Schema it is `{ not: {} }`, which generates `unknown`. The root's
// additionalProperties: false refuses it just the same.
delete rateCard.properties.currency

const activityEnum = [
  'chat',
  'image',
  'video',
  'audio',
  'embeddings',
  'moderation',
  'world',
]

const changeTypeEnum = [
  'model.added',
  'model.removed',
  'model.updated',
  'catalog.shape_changed',
  'model.deprecated',
  'schema.added',
  'schema.updated',
  'endpoint.added',
  'endpoint.removed',
]

const errorResponse = {
  description: 'Error',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
    },
  },
}

const providerParam = {
  name: 'provider',
  in: 'path',
  required: true,
  description: 'Provider slug (see GET /v1/providers).',
  schema: { type: 'string' },
}

const activityParam = {
  name: 'activity',
  in: 'path',
  required: true,
  description: 'Activity group.',
  schema: { type: 'string', enum: activityEnum },
}

/**
 * One catalog row's fields, shared by Model and ExportModel. Changing a
 * field's shape here changes MODEL_ROW_SHAPE (src/server/row-shape.ts).
 */
const modelFields = {
  id: { type: 'string' },
  provider: { type: 'string' },
  rawId: { type: 'string' },
  sameAs: {
    description:
      "The catalog row this provider's own listing or docs identify as the same upstream model. It does not change this row's facts. null when no upstream is stated, or the stated one matches no row or more than one. When set, factSources.sameAs records the source, with normalized: true when the id matched only after reading dots as hyphens.",
    oneOf: [
      {
        type: 'object',
        required: ['provider', 'rawId'],
        properties: {
          provider: { type: 'string' },
          rawId: { type: 'string' },
        },
      },
      { type: 'null' },
    ],
  },
  activity: { type: ['string', 'null'], enum: [...activityEnum, null] },
  displayName: { type: ['string', 'null'] },
  schemaEndpointId: { type: ['string', 'null'] },
  contextWindow: { type: ['integer', 'null'] },
  maxOutput: { type: ['integer', 'null'] },
  modalities: {
    description:
      'Input and output modalities as the source states them, or null when unknown. A side the source leaves unstated is absent or null.',
    type: ['object', 'null'],
    properties: {
      input: { type: ['array', 'null'], items: { type: 'string' } },
      output: { type: ['array', 'null'], items: { type: 'string' } },
    },
  },
  pricing: {
    description:
      'Full RateCard on detail and on list rows with ?pricing=1; a CompactPricing summary on list rows otherwise. null only when no card is stored.',
    oneOf: [
      { $ref: '#/components/schemas/RateCard' },
      { $ref: '#/components/schemas/CompactPricing' },
      { type: 'null' },
    ],
  },
  pricingRange: {
    description:
      'Set on a routed id whose routes bill different prices (pricing is then null): a bound over the routes, not a price. factSources.pricingRange is where the route prices were read. null otherwise.',
    oneOf: [{ $ref: '#/components/schemas/PricingRange' }, { type: 'null' }],
  },
  capabilities: {
    description:
      "Capability flags as a map. true: the provider states the model supports the flag. false: the provider states it does not. Key absent: unknown; never read a missing key as false. null: nothing is known. Test capabilities?.tools === true to offer a feature and === false to rule it out. factSources.capabilities holds one source per key, for a true and a false alike; a false whose source has path 'unlisted' comes from the provider publishing the model's whole flag list without that flag.",
    type: ['object', 'null'],
    additionalProperties: { type: 'boolean' },
  },
  providerMetadata: {
    description:
      "The provider's own listing object for the model, as published: not normalised, and different for every provider (fal category, BytePlus Ark features and task type, ElevenLabs languages, Replicate visibility). null when the provider lists none. Nothing in it is a capability flag; read capabilities for those.",
    type: ['object', 'null'],
    additionalProperties: true,
  },
  reasoning: {
    description:
      'How thinking is configured, or null when the model does not reason or its source names no request field for it. Rows from some providers still carry a mandatory true inferred from a level list with no off value; the README release notes list them.',
    oneOf: [{ $ref: '#/components/schemas/ModelReasoning' }, { type: 'null' }],
  },
  serverTools: {
    description:
      "Provider-hosted tool type ids the model accepts in the request's tools array (web_search_20250305, google_search, x_search, …), or null when unknown. factSources.serverTools holds one source per id.",
    type: ['array', 'null'],
    items: { type: 'string' },
  },
  requestMap: {
    description:
      "How to build this chat model's request: thinking on/off and shared effort levels (null omits the field), max-token field name, developer vs system role, reasoning_content replay, and related flags. Null until verified. reasoning stays the readable fact (mode, mandatory, efforts).",
    oneOf: [{ $ref: '#/components/schemas/ChatRequestMap' }, { type: 'null' }],
  },
  requiredRequestHeaders: {
    description:
      'Client-supplied entries of the provider connect profile requiredHeaders (name plus the rule for the value). Constant headers, such as anthropic-version, stay on GET /v1/openapi/{provider} as schema.const and are not repeated here. null when the provider publishes none. factSources.requiredRequestHeaders is the source. OpenCode Go: x-opencode-session and User-Agent, https://opencode.ai/docs/console/go/ "Where can I use it?".',
    oneOf: [
      {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'description'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
      { type: 'null' },
    ],
  },
  trainsOnRequestData: {
    description:
      "true when this model's own source states it trains on request data and the workspace must opt in. OpenCode Go reads the Privacy table on https://opencode.ai/docs/console/go/ (Yes). An id that table does not name can still be true from that id's probe record. null when the table says Not used, or no source states it for this id. Never inferred from an id suffix. factSources.trainsOnRequestData is the source.",
    type: ['boolean', 'null'],
  },
  aliases: {
    description:
      'Caller ids that resolve to this row (for example claude-opus-4-5 → the dated snapshot). null when the provider documents none. GET /v1/models/{provider}/{id} accepts an alias and returns this row, whose rawId is the dated id.',
    type: ['array', 'null'],
    items: { type: 'string' },
  },
  factSources: {
    $ref: '#/components/schemas/ModelFactSources',
    description:
      'Per-field provenance, included by default on detail and list responses (provenance=0 explicitly omits it on lists). A ledgered null chat fact carries derivation source-silent, with sourceUrl and checkedAt only when recorded. capabilities and serverTools normally contain per-item source maps; whole-field silence is a source-silent object. Missing cacheRead and efforts subfacts have separate provenance keys; endpoint silence is schemaEndpointId. Populated facts keep their existing provenance. Nulls without ledger evidence gain no entry.',
  },
  releasedAt: {
    description:
      "The provider's own stated release or creation date, epoch seconds. null when the provider reports none. Unlike firstSeenAt it is never our observation.",
    type: ['integer', 'null'],
  },
  knowledgeCutoff: {
    description:
      'Knowledge (training data) cutoff as the provider states it: YYYY-MM, or YYYY-MM-DD when the provider gives a day. Never padded to a day. null when unknown. factSources.knowledgeCutoff is its source.',
    type: ['string', 'null'],
    pattern: '^\\d{4}-\\d{2}(-\\d{2})?$',
  },
  openWeights: {
    description:
      'true when the provider itself states the weights can be openly downloaded, false when it states they cannot, null when it states neither. Never inferred from a model name. factSources.openWeights is its source.',
    type: ['boolean', 'null'],
  },
  weightsUrl: {
    description:
      'Where the provider says the weights are. Set only when openWeights is true.',
    type: ['string', 'null'],
  },
  firstSeenAt: {
    description:
      'The release date the provider reports when it reports one (the same date as releasedAt), otherwise when this service first observed the model. Read releasedAt to tell the two apart.',
    type: 'integer',
  },
  deprecatedAt: {
    description:
      'When the model was deprecated, epoch seconds: the date its provider states (deprecation.deprecatedAt) when stated, otherwise when this service first saw it deprecated or gone from the listing (for a retired model never listed, when its deprecations page entry was first read; that can fall after deprecation.retiresAt). null on a live model.',
    type: ['integer', 'null'],
  },
  deprecation: {
    description:
      "The provider's deprecations page entry for this model, exactly as stated: deprecatedAt and retiresAt (shutdown) are epoch seconds at 00:00 UTC of the stated day, null when the page gives none; replacedBy lists the ids the provider recommends instead, null when it names none. null when the provider's page does not list the model or this service reads no such page for the provider. A retired model stays in the catalog (GET /v1/models?deprecated=true); one that was never in a listing has only these facts, and its firstSeenAt and lastSeenAt are when this service first read the entry. Every change to this entry is a model.deprecated change.",
    oneOf: [
      {
        type: 'object',
        required: [
          'rawId',
          'deprecatedAt',
          'retiresAt',
          'replacedBy',
          'sourceUrl',
        ],
        properties: {
          rawId: { type: 'string' },
          deprecatedAt: { type: ['integer', 'null'] },
          retiresAt: { type: ['integer', 'null'] },
          replacedBy: {
            type: ['array', 'null'],
            items: { type: 'string' },
          },
          sourceUrl: { type: 'string' },
        },
      },
      { type: 'null' },
    ],
  },
} as const

/** On every row; factSources is omitted when provenance=0. */
const modelRequired = [
  'id',
  'provider',
  'rawId',
  'sameAs',
  'activity',
  'displayName',
  'schemaEndpointId',
  'contextWindow',
  'maxOutput',
  'modalities',
  'pricing',
  'pricingRange',
  'capabilities',
  'providerMetadata',
  'reasoning',
  'serverTools',
  'requestMap',
  'requiredRequestHeaders',
  'trainsOnRequestData',
  'aliases',
  'releasedAt',
  'knowledgeCutoff',
  'openWeights',
  'weightsUrl',
  'firstSeenAt',
  'deprecatedAt',
  'deprecation',
] as const

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'modelschemas',
    version: '0.1.0',
    description:
      'Live AI model schema service: per-endpoint request/response JSON ' +
      'Schemas and model metadata for monitored providers, with ' +
      'stale-while-revalidate caching and a change feed. Anonymous reads ' +
      'are allowed at a low rate limit; register (agent-auth or API key) ' +
      'for higher limits and webhook subscriptions.',
  },
  servers: [{ url: '/' }],
  paths: {
    '/v1': {
      get: {
        operationId: 'getServiceIndex',
        summary: 'Service description and endpoint index',
        responses: {
          '200': {
            description: 'Service index with _links to every surface.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/v1/status': {
      get: {
        operationId: 'getStatus',
        summary: 'Per-provider sync status and row counts',
        parameters: [
          {
            name: 'wait',
            in: 'query',
            description:
              'Long-poll: hold up to N seconds (cap 60; "30s" form accepted) until new data exists, then return current data.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Service status.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ServiceStatus' },
              },
            },
          },
        },
      },
    },
    '/v1/providers': {
      get: {
        operationId: 'listProviders',
        summary: 'List monitored providers with sync status',
        responses: {
          '200': {
            description: 'Providers.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/v1/providers/{provider}': {
      get: {
        operationId: 'getProvider',
        summary: 'One provider: status, counts, live models per activity',
        description:
          'The same row as GET /v1/providers plus activities: live model counts keyed by activity, the values GET /v1/openapi/{provider}?activity= and GET /v1/models?activity= accept.',
        parameters: [providerParam],
        responses: {
          '200': {
            description: 'Provider detail.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Provider' },
              },
            },
          },
          '404': errorResponse,
        },
      },
    },
    '/v1/providers/{provider}/models': {
      get: {
        operationId: 'listProviderModels',
        summary: 'List models for one provider',
        parameters: [
          providerParam,
          {
            name: 'provenance',
            in: 'query',
            description:
              'Include recorded per-field sources by default; 0 omits them.',
            schema: { type: 'string', enum: ['0', '1'], default: '1' },
          },
        ],
        responses: {
          '400': errorResponse,
          '200': {
            description: 'Models for the provider.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ProviderModelList' },
              },
            },
          },
          '404': errorResponse,
        },
      },
    },
    '/v1/models': {
      get: {
        operationId: 'listModels',
        summary: 'Cross-provider model catalog',
        description:
          'The headline "what can I use right now" endpoint. Filterable.',
        parameters: [
          {
            name: 'activity',
            in: 'query',
            schema: { type: 'string', enum: activityEnum },
          },
          { name: 'provider', in: 'query', schema: { type: 'string' } },
          {
            name: 'capability',
            in: 'query',
            description:
              'A capability flag the model is stated to support: matches rows whose capabilities map has this key set to true (capability=tools). Exact flag name, not a substring.',
            schema: { type: 'string' },
          },
          {
            name: 'q',
            in: 'query',
            description: 'Free-text match against id and display name.',
            schema: { type: 'string' },
          },
          {
            name: 'provenance',
            in: 'query',
            description:
              'Per-field factSources are included by default. Set to 0 to omit them on list rows; 1 explicitly includes them. Model detail always includes factSources and OpenRouter discrepancies.',
            schema: { type: 'string', enum: ['0', '1'], default: '1' },
          },
          {
            name: 'pricing',
            in: 'query',
            description:
              'Set to 1 to include the full rate card on each list row. Default is a compact summary: per-million base rates for token cards, otherwise the unit the card bills by.',
            schema: { type: 'string', enum: ['1'] },
          },
        ],
        responses: {
          '200': {
            description:
              'Matching models. pricing is a compact token projection, a full RateCard when ?pricing=1, or null. OpenRouter-shaped vendor blobs are not served.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ModelList' },
              },
            },
          },
        },
      },
    },
    '/v1/models/{provider}/{modelId}': {
      get: {
        operationId: 'getModel',
        summary: 'Full metadata for one model',
        parameters: [
          providerParam,
          {
            name: 'modelId',
            in: 'path',
            required: true,
            description: 'Model slug or raw provider id.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description:
              'Model metadata with activity, schemaEndpointId (canonical generation route on grain=provider catalogs), a RateCard or null for pricing, factSources (per-field provenance), OpenRouter discrepancies, and _links.schema when bound.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ModelDetail' },
              },
            },
          },
          '404': errorResponse,
        },
      },
    },
    '/v1/schemas': {
      get: {
        operationId: 'listAllSchemas',
        summary: 'System-wide schema index',
        description:
          'Every provider with extracted schemas, each with its activities and endpoint ids — the discovery entry point for all schemas on the system.',
        responses: {
          '200': {
            description: 'Provider → activity → endpoint-id index.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/v1/schemas/{provider}': {
      get: {
        operationId: 'listProviderSchemas',
        summary: 'Activities and endpoint ids for a provider',
        parameters: [providerParam],
        responses: {
          '200': {
            description: 'Activity → endpoint-id index.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '404': errorResponse,
        },
      },
    },
    '/v1/schemas/{provider}/{activity}': {
      get: {
        operationId: 'getActivitySchemas',
        summary: 'Endpoint-id-keyed schema map for one activity',
        parameters: [providerParam, activityParam],
        responses: {
          '200': {
            description:
              'Map of endpoint id → { input, output } self-contained JSON Schemas (current versions).',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '404': errorResponse,
        },
      },
    },
    '/v1/schemas/{provider}/{activity}/{endpointId}': {
      get: {
        operationId: 'getSchema',
        summary: 'One self-contained JSON Schema',
        parameters: [
          providerParam,
          activityParam,
          {
            name: 'endpointId',
            in: 'path',
            required: true,
            description:
              "Path-derived endpoint id (URL-encode slashes), or a listed model rawId/slug which aliases onto that activity's generation route and pins the request `model` field.",
            schema: { type: 'string' },
          },
          {
            name: 'kind',
            in: 'query',
            description: 'Defaults to input.',
            schema: { type: 'string', enum: ['input', 'output'] },
          },
          {
            name: 'version',
            in: 'query',
            description: 'Content hash of a historical version.',
            schema: { type: 'string' },
          },
          {
            name: 'format',
            in: 'query',
            description:
              'json (default) or types — a self-contained TypeScript module (schema const + generated types, tree-shakeable, zero imports). format=types on an input schema with a model property overlays the live catalog union plus ListedModelId; the schema const and content hash stay the bundled schema.',
            schema: { type: 'string', enum: ['json', 'types'] },
          },
          {
            name: 'optional',
            in: 'query',
            description:
              'format=types only: optional-property style. exact (default) emits `foo?: T`; undefined emits `foo?: T | undefined`.',
            schema: { type: 'string', enum: ['exact', 'undefined'] },
          },
        ],
        responses: {
          '200': {
            description:
              'Self-contained JSON Schema ($defs-bundled) — or, with format=types, a TypeScript module — served with ETag. ' +
              'JSON responses carry `provenance` (upstream sourceUrl, sourceHash, fetchedAt, extractorVersion) so derivations are independently verifiable. ' +
              '`provenance.derivation` grades how the content was arrived at — `upstream-spec` and `generated` are re-derived every sync and self-heal. `probe-verified` is a live API call recorded in `src/server/providers/probes/<provider>.ts` on `provenance.verifiedAt` (`YYYY-MM-DD`). Re-run it with `bun scripts/probe.ts <provider> [--write]`. A record older than 90 days is still served; `GET /v1/status` counts those on `staleProbes`. `docs-derived` was never confirmed against the API. Both are point-in-time claims that can go stale.',
            content: {
              'application/json': { schema: { type: 'object' } },
              'text/typescript': { schema: { type: 'string' } },
            },
          },
          '404': errorResponse,
        },
      },
    },
    '/v1/openapi/{provider}': {
      get: {
        operationId: 'getProviderOpenApi',
        summary: 'Generation-only OpenAPI document for one provider',
        description:
          'Assembled from classified endpoints plus the provider connect profile (servers, auth, required headers). ' +
          'Not a raw upstream-spec mirror. FAL (model-grained, queue) is one document: POST /{endpoint_id} and GET /{endpoint_id}/requests/{request_id}. endpoint_id is the model raw id (x-modelschemas-encode raw: do not percent-encode slashes). ' +
          "With no selector the bodies are untyped; ?activity= narrows the enum and inlines each model's own body schema (x-modelschemas-model), up to 1024 models; ?model= is that one model's paths. " +
          'A filter that matches no endpoint returns 400 spec_requires_selector; there is no cap on the number of paths in a provider-grained document. ' +
          'An unsynced provider returns 404 no_endpoints. ?model= pins the live model enum on provider-grained specs; it does not drop endpoints.',
        parameters: [
          providerParam,
          {
            name: 'model',
            in: 'query',
            description: 'Pin to one model (raw id or slug).',
            schema: { type: 'string' },
          },
          {
            name: 'activity',
            in: 'query',
            description: 'Restrict to one activity group.',
            schema: { type: 'string', enum: activityEnum },
          },
        ],
        responses: {
          '200': {
            description: 'OpenAPI 3.1 document.',
            content: {
              'application/openapi+json': { schema: { type: 'object' } },
              'application/json': { schema: { type: 'object' } },
            },
          },
          '400': errorResponse,
          '404': errorResponse,
          '500': errorResponse,
        },
      },
    },
    '/v1/validate': {
      post: {
        operationId: 'validatePayload',
        summary: 'Validate a payload against a provider endpoint schema',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ValidateRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Validation result.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ValidateResult' },
              },
            },
          },
          '400': errorResponse,
          '404': errorResponse,
        },
      },
    },
    '/v1/estimate': {
      post: {
        operationId: 'estimateCost',
        summary: 'Evaluate a stored rate card against request and usage',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/EstimateRequest' },
            },
          },
        },
        responses: {
          '200': {
            description:
              'The amount for this call and its currency, the card source, which inputs (if any) were estimated or took a default, and which request keys the card ignored. For a routed model with a pricingRange: min and max over its routes, each naming its route. When the call omits exactly one required choice input: byInput, one estimate per allowed value.',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { $ref: '#/components/schemas/EstimateResult' },
                    { $ref: '#/components/schemas/EstimateRangeResult' },
                    { $ref: '#/components/schemas/EstimateByInputResult' },
                  ],
                },
              },
            },
          },
          '400': errorResponse,
          '404': errorResponse,
          '422': errorResponse,
        },
      },
    },
    '/v1/changes': {
      get: {
        operationId: 'listChanges',
        summary: 'Changelog feed (cursor-paginated)',
        description: 'The polling-friendly alternative to webhooks.',
        parameters: [
          {
            name: 'since',
            in: 'query',
            description: 'Unix epoch seconds lower bound.',
            schema: { type: 'integer' },
          },
          { name: 'provider', in: 'query', schema: { type: 'string' } },
          {
            name: 'type',
            in: 'query',
            schema: { type: 'string', enum: changeTypeEnum },
          },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          {
            name: 'wait',
            in: 'query',
            description:
              'Long-poll: hold up to N seconds (cap 60; "30s" form accepted) until new data exists, then return current data.',
            schema: { type: 'string' },
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 200 },
          },
        ],
        responses: {
          '200': {
            description: 'Changes page with next cursor.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChangesPage' },
              },
            },
          },
        },
      },
    },
    '/v1/admin/sync/{provider}': {
      post: {
        operationId: 'syncProvider',
        summary: 'Manually trigger a provider spec sync (admin only)',
        parameters: [providerParam],
        security: [{ adminKey: [] }],
        responses: {
          '200': {
            description: 'Sync outcome.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '401': errorResponse,
          '404': errorResponse,
          '502': errorResponse,
        },
      },
    },
    '/v1/admin/extract/fal': {
      post: {
        operationId: 'extractFalPricing',
        summary:
          'Manually trigger the FAL llms.txt rate-card extract (admin only). Spec sync stays on POST /v1/admin/sync/fal.',
        security: [{ adminKey: [] }],
        responses: {
          '200': {
            description: 'Extract outcome.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '401': errorResponse,
          '502': errorResponse,
        },
      },
    },
    '/v1/admin/export': {
      get: {
        operationId: 'exportCatalog',
        summary:
          'The whole catalog in one streamed response, for the public git mirror (admin only)',
        description:
          'Returns `latestChange` (the newest change id and createdAt, or null), ' +
          'then `models` (live and deprecated, full rate card), `providers`, and ' +
          '`schemas` (each endpoint with its current input and output versions). ' +
          'Object keys are sorted, and fields that change on every poll ' +
          '(`lastSeenAt`, `lastPolledAt`, `lastSyncedAt`, `_links`) are left out; ' +
          'provenance timestamps such as `factSources.*.fetchedAt` are kept and ' +
          'can move without a value changing. The export is not one snapshot: ' +
          'rows read after `latestChange` may already hold newer changes. To ' +
          'catch up from an earlier export, read every page of ' +
          'GET /v1/changes?since=<its latestChange.createdAt> and skip only its ' +
          'latestChange.id (change ids are random, so do not stop at it). A ' +
          'failure part way breaks the stream, so the body is not valid JSON.',
        security: [{ adminKey: [] }],
        responses: {
          '200': {
            description:
              'Catalog export. `models[]` items are the Model shape without `lastSeenAt` and `_links`.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['latestChange', 'models', 'providers', 'schemas'],
                  properties: {
                    latestChange: {
                      type: ['object', 'null'],
                      required: ['id', 'createdAt'],
                      properties: {
                        id: { type: 'string' },
                        createdAt: { type: 'integer' },
                      },
                    },
                    models: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/ExportModel' },
                    },
                    providers: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: [
                          'id',
                          'displayName',
                          'status',
                          'modelNamespaces',
                        ],
                        properties: {
                          id: { type: 'string' },
                          displayName: { type: 'string' },
                          specSourceUrl: { type: ['string', 'null'] },
                          modelsEndpoint: { type: ['string', 'null'] },
                          authEnvVar: { type: ['string', 'null'] },
                          status: { type: 'string' },
                          modelNamespaces: {
                            type: 'array',
                            items: { type: 'string' },
                          },
                        },
                      },
                    },
                    schemas: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: [
                          'provider',
                          'endpointId',
                          'activity',
                          'method',
                          'path',
                          'input',
                          'output',
                        ],
                        properties: {
                          provider: { type: 'string' },
                          endpointId: { type: 'string' },
                          activity: { type: 'string' },
                          method: { type: 'string' },
                          path: { type: 'string' },
                          description: { type: ['string', 'null'] },
                          input: {
                            $ref: '#/components/schemas/ExportSchemaVersion',
                          },
                          output: {
                            $ref: '#/components/schemas/ExportSchemaVersion',
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '401': errorResponse,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      adminKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Admin-Key',
      },
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Agent JWT (agent-auth) or API key.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
      ServiceStatus: {
        type: 'object',
        required: ['service', 'time', 'providers'],
        properties: {
          service: { type: 'string', const: 'modelschemas' },
          time: { type: 'integer' },
          completenessComputedAt: {
            type: ['integer', 'null'],
            description:
              'Epoch seconds the completeness scores were computed, at the last models poll (every 15 minutes). null when none is stored yet, as after a deploy that changes the scorer; every score is then null.',
          },
          providers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                displayName: { type: 'string' },
                status: {
                  type: 'string',
                  enum: ['active', 'degraded', 'disabled', 'pending'],
                },
                lastPolledAt: { type: ['integer', 'null'] },
                lastSyncedAt: { type: ['integer', 'null'] },
                docsFailing: {
                  type: 'object',
                  description:
                    'Present only while the provider docs pages fail to load. Polls go on and models keep their stored docs-derived facts, which may be stale. Does not change status.',
                  required: [
                    'since',
                    'polls',
                    'lastAt',
                    'failed',
                    'skipped',
                    'sources',
                    'error',
                  ],
                  properties: {
                    since: {
                      type: 'integer',
                      description: 'Epoch seconds of the first failing poll.',
                    },
                    polls: {
                      type: 'integer',
                      description: 'Consecutive failing polls.',
                    },
                    lastAt: {
                      type: 'integer',
                      description: 'Epoch seconds of the latest failing poll.',
                    },
                    failed: {
                      type: 'integer',
                      description: 'Documents that failed in the latest poll.',
                    },
                    skipped: {
                      type: 'integer',
                      description:
                        'Documents not attempted after the failure budget.',
                    },
                    sources: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'The first few failing documents.',
                    },
                    error: {
                      type: 'string',
                      description:
                        'First error of the latest poll, at most 500 characters.',
                    },
                  },
                },
                updateStorm: {
                  type: 'object',
                  description:
                    'Present only while the latest poll wrote model.updated for more than half of the live rows, and at least 20. The updates are written; this only marks a catalog-wide rewrite. Does not change status. The next poll under that line clears it.',
                  required: ['since', 'polls', 'lastAt', 'updated', 'live'],
                  properties: {
                    since: {
                      type: 'integer',
                      description: 'Epoch seconds of the first storming poll.',
                    },
                    polls: {
                      type: 'integer',
                      description: 'Consecutive storming polls.',
                    },
                    lastAt: {
                      type: 'integer',
                      description: 'Epoch seconds of the latest storming poll.',
                    },
                    updated: {
                      type: 'integer',
                      description:
                        'model.updated rows written by the latest poll.',
                    },
                    live: {
                      type: 'integer',
                      description:
                        'Live rows, not deprecated, at the start of that poll.',
                    },
                  },
                },
                staleProbes: {
                  type: 'integer',
                  description:
                    'Present only when this provider has probe records older than 90 days. The probed facts stay served. Does not change status. Re-run with `bun scripts/probe.ts <provider> --write`.',
                },
                priceClearsRefused: {
                  type: 'object',
                  description:
                    'Present only while polls refuse to clear most of the stored prices of the provider at once. The stored prices stay and may be stale. Does not change status.',
                  required: ['since', 'polls', 'lastAt', 'refused', 'priced'],
                  properties: {
                    since: {
                      type: 'integer',
                      description: 'Epoch seconds of the first refusing poll.',
                    },
                    polls: {
                      type: 'integer',
                      description: 'Consecutive refusing polls.',
                    },
                    lastAt: {
                      type: 'integer',
                      description: 'Epoch seconds of the latest refusing poll.',
                    },
                    refused: {
                      type: 'integer',
                      description:
                        'Stored prices the latest poll asked to clear; none was cleared.',
                    },
                    priced: {
                      type: 'integer',
                      description:
                        'Listed models holding a stored price at that poll.',
                    },
                  },
                },
                completeness: {
                  type: 'object',
                  description:
                    'The gap-report score over the live chat models of the provider: the share filled of the eleven chat facts (contextWindow, maxOutput, modalities, priced, cacheRead, capabilities, reasoning, efforts, requestMap, endpoint, replayReasoningContent). Summed per model, each fact counted only where it applies. requestMap applies on chat/completions, completions, and responses routes. replayReasoningContent applies on chat/completions routes whose rows reason. A stated cached-input absence (factSources.cacheRead path not-offered) fills cacheRead. Provider-wide and exact-model source-silent exceptions are excluded. Computed at the models poll (completenessComputedAt), not per request.',
                  required: ['score', 'chat', 'filled', 'needed', 'silent'],
                  properties: {
                    score: {
                      type: ['number', 'null'],
                      description:
                        'filled / needed, 0 to 1. 1 when every fact that applies is in silent. null when the provider has no live chat models (nothing to score, not a score of zero), when no score is stored yet, and when the chat models changed since the stored score.',
                    },
                    chat: {
                      type: 'integer',
                      description: 'Live chat models scored.',
                    },
                    filled: {
                      type: 'integer',
                      description:
                        'Facts carried, summed over those models; silent facts left out.',
                    },
                    needed: {
                      type: 'integer',
                      description:
                        'Facts that apply, summed over those models; silent facts left out.',
                    },
                    silent: {
                      type: 'array',
                      items: { type: 'string' },
                      description:
                        'Facts the provider does not publish, left out of the score.',
                    },
                  },
                },
                counts: {
                  type: 'object',
                  description:
                    'Model tallies count live models only: what GET /v1/models lists by default. Deprecated models are in deprecated and nowhere else.',
                  properties: {
                    models: { type: 'integer' },
                    deprecated: {
                      type: 'integer',
                      description:
                        'Models deprecated by their provider or no longer listed upstream (GET /v1/models?deprecated=true).',
                    },
                    priced: {
                      type: 'integer',
                      description:
                        'Models with a stored rate card. priced / models is the price score.',
                    },
                    reasoning: {
                      type: 'integer',
                      description:
                        'Models with stored reasoning metadata. reasoning / chat is the reasoning score.',
                    },
                    chat: {
                      type: 'integer',
                      description: 'Models whose activity is chat.',
                    },
                    endpoints: { type: 'integer' },
                    schemas: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
      Change: {
        type: 'object',
        required: [
          'id',
          'type',
          'providerId',
          'subjectId',
          'summary',
          'createdAt',
        ],
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: changeTypeEnum },
          providerId: { type: 'string' },
          subjectId: { type: 'string' },
          summary: { type: 'string' },
          payload: {
            type: 'object',
            description:
              'model.updated carries before, after, and changed. changed is the fact paths that differ and is never empty. A source hash, an extract time, the operand order of +, and the order of an input values list are not facts, so they do not appear here and do not produce an event. Schema events carry kind, contentHash, and previousHash instead. catalog.shape_changed means the served model row changed shape: one row per provider, subjectId model-row, carrying version, contentHash (the row-shape hash), previousHash, and notes. Re-read openapi.json and upgrade @modelschemas/client.',
            properties: {
              before: {},
              after: {},
              changed: {
                type: 'array',
                minItems: 1,
                items: { type: 'string' },
                description:
                  'Fact paths that differ, present on model.updated. For example contextWindow or pricing.tables.rate.base.input_tokens.',
              },
              kind: { type: 'string', enum: ['input', 'output'] },
              contentHash: { type: 'string' },
              previousHash: { type: ['string', 'null'] },
              version: {
                type: 'integer',
                description: 'catalog.shape_changed: the row shape version.',
              },
              notes: {
                type: 'string',
                description: 'catalog.shape_changed: what changed in the row.',
              },
            },
          },
          createdAt: {
            type: 'integer',
            description: 'Unix epoch seconds.',
          },
        },
      },
      ChangesPage: {
        type: 'object',
        required: ['count', 'changes', 'nextCursor'],
        properties: {
          count: { type: 'integer' },
          changes: {
            type: 'array',
            items: { $ref: '#/components/schemas/Change' },
          },
          nextCursor: { type: ['string', 'null'] },
          _links: { type: 'object' },
        },
      },
      ExportSchemaVersion: {
        description: 'A current schema version, or null when there is none.',
        type: ['object', 'null'],
        required: ['contentHash', 'specRevision', 'provenance', 'schema'],
        properties: {
          contentHash: { type: 'string' },
          specRevision: { type: ['string', 'null'] },
          provenance: {
            type: 'object',
            properties: {
              sourceUrl: { type: ['string', 'null'] },
              sourceHash: { type: ['string', 'null'] },
              fetchedAt: { type: 'integer' },
              extractorVersion: { type: ['string', 'null'] },
              derivation: { type: ['string', 'null'] },
              verifiedAt: { type: ['string', 'null'] },
            },
          },
          schema: { type: 'object' },
        },
      },
      ValidateRequest: {
        type: 'object',
        required: ['provider', 'endpointId', 'payload'],
        properties: {
          provider: { type: 'string' },
          endpointId: { type: 'string' },
          kind: { type: 'string', enum: ['input', 'output'] },
          payload: {},
        },
      },
      ValidateResult: {
        type: 'object',
        required: ['valid', 'errors'],
        properties: {
          valid: { type: 'boolean' },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                message: { type: 'string' },
                keyword: { type: 'string' },
              },
            },
          },
        },
      },
      ...zodComponents,
      HalLink: {
        type: 'object',
        required: ['href', 'method', 'contentType'],
        properties: {
          href: {
            type: 'string',
            description:
              'A path, or an RFC 6570 template when templated is true.',
          },
          method: { type: 'string', enum: ['GET', 'POST', 'DELETE'] },
          contentType: { type: 'string' },
          templated: { type: 'boolean', enum: [true] },
          example: {
            description:
              'A concrete URL for a GET, or a request body for a POST.',
            oneOf: [
              { type: 'string' },
              { type: 'object', additionalProperties: true },
            ],
          },
        },
      },
      Provider: {
        type: 'object',
        required: [
          'id',
          'displayName',
          'status',
          'counts',
          'spec',
          'activities',
          '_links',
        ],
        description:
          'One row of GET /v1/providers plus activities. Model counts are live rows; counts.deprecated holds the rest.',
        properties: {
          id: { type: 'string' },
          displayName: { type: 'string' },
          status: { type: 'string' },
          lastPolledAt: { type: ['integer', 'null'] },
          lastSyncedAt: { type: ['integer', 'null'] },
          counts: { type: 'object', additionalProperties: { type: 'integer' } },
          spec: {
            type: 'object',
            required: ['grain', 'endpointCount'],
            properties: {
              grain: { type: 'string', enum: ['provider', 'model'] },
              endpointCount: { type: 'integer' },
            },
          },
          activities: {
            type: 'object',
            description:
              'Live model count per activity. A key is present only when the provider has a live model with that activity.',
            propertyNames: { enum: activityEnum },
            additionalProperties: { type: 'integer' },
          },
          _links: {
            type: 'object',
            required: ['self', 'models', 'schemas'],
            properties: {
              self: { $ref: '#/components/schemas/HalLink' },
              models: { $ref: '#/components/schemas/HalLink' },
              schemas: { $ref: '#/components/schemas/HalLink' },
              openapi: { $ref: '#/components/schemas/HalLink' },
            },
          },
        },
      },
      ModelLinks: {
        type: 'object',
        required: ['provider', 'schemas'],
        properties: {
          provider: { $ref: '#/components/schemas/HalLink' },
          schemas: { $ref: '#/components/schemas/HalLink' },
          openapi: { $ref: '#/components/schemas/HalLink' },
          schema: {
            description:
              'The bound generation schema. Only on model rows whose schemaEndpointId and activity are set.',
            $ref: '#/components/schemas/HalLink',
          },
        },
      },
      FactSource: {
        type: 'object',
        required: ['derivation'],
        properties: {
          derivation: {
            type: 'string',
            enum: [
              'listing',
              'docs-extracted',
              'upstream-spec',
              'generated',
              'probe-verified',
              'docs-derived',
              'source-silent',
            ],
            description:
              'How the fact was arrived at. source-silent: the provider publishes no value for it (docs/source-silent ledger).',
          },
          sourceUrl: { type: 'string' },
          sourceHash: { type: 'string' },
          fetchedAt: { type: 'integer', description: 'Epoch seconds.' },
          endpointId: {
            type: 'string',
            description:
              'Bound generation route, when the fact came from its schema.',
          },
          path: {
            type: 'string',
            description: 'JSON pointer or field name in the source document.',
          },
          checkedAt: {
            type: 'string',
            description:
              'source-silent only: the date the ledger author checked the source (YYYY-MM-DD).',
          },
          verifiedAt: {
            type: 'string',
            description:
              'probe-verified only: the date the live call last matched the recorded result (YYYY-MM-DD). A date older than 90 days is still served and counted on GET /v1/status staleProbes.',
          },
          normalized: {
            type: 'boolean',
            enum: [true],
            description:
              'sameAs only: the id matched after dots were read as hyphens.',
          },
        },
      },
      FactSourceMap: {
        description:
          'One source per key (a capability flag or a server tool id), or one source-silent entry for the whole field.',
        oneOf: [
          {
            type: 'object',
            additionalProperties: { $ref: '#/components/schemas/FactSource' },
          },
          { $ref: '#/components/schemas/FactSource' },
        ],
      },
      ModelFactSources: {
        type: ['object', 'null'],
        properties: {
          schemaEndpointId: { $ref: '#/components/schemas/FactSource' },
          sameAs: { $ref: '#/components/schemas/FactSource' },
          contextWindow: { $ref: '#/components/schemas/FactSource' },
          maxOutput: { $ref: '#/components/schemas/FactSource' },
          modalities: { $ref: '#/components/schemas/FactSource' },
          pricing: { $ref: '#/components/schemas/FactSource' },
          pricingRange: { $ref: '#/components/schemas/FactSource' },
          capabilities: { $ref: '#/components/schemas/FactSourceMap' },
          knowledgeCutoff: { $ref: '#/components/schemas/FactSource' },
          openWeights: {
            description: 'Covers openWeights and weightsUrl.',
            $ref: '#/components/schemas/FactSource',
          },
          reasoning: { $ref: '#/components/schemas/FactSource' },
          requestMap: { $ref: '#/components/schemas/FactSource' },
          requiredRequestHeaders: { $ref: '#/components/schemas/FactSource' },
          trainsOnRequestData: { $ref: '#/components/schemas/FactSource' },
          requestMapFields: {
            type: 'object',
            description:
              'Per-field evidence when a request map combines sources, keyed by ChatRequestMap field.',
            additionalProperties: { $ref: '#/components/schemas/FactSource' },
          },
          serverTools: { $ref: '#/components/schemas/FactSourceMap' },
          cacheRead: { $ref: '#/components/schemas/FactSource' },
          efforts: { $ref: '#/components/schemas/FactSource' },
        },
      },
      FactDiscrepancy: {
        type: 'object',
        required: [
          'field',
          'ours',
          'openrouter',
          'oursDerivation',
          'openrouterId',
        ],
        properties: {
          field: { type: 'string' },
          ours: { description: "This row's value." },
          openrouter: {
            description: "OpenRouter's value for the same model.",
          },
          oursDerivation: { type: ['string', 'null'] },
          openrouterId: { type: 'string' },
        },
      },
      Model: {
        type: 'object',
        required: [...modelRequired, 'lastSeenAt', '_links'],
        properties: {
          ...modelFields,
          lastSeenAt: { type: 'integer' },
          _links: { $ref: '#/components/schemas/ModelLinks' },
        },
      },
      ExportModel: {
        type: 'object',
        description:
          'A model row in GET /v1/admin/export: the Model shape without lastSeenAt and _links.',
        required: modelRequired,
        properties: modelFields,
      },
      ModelDetail: {
        description:
          'GET /v1/models/{provider}/{modelId}: a Model with its full RateCard and OpenRouter discrepancies.',
        allOf: [
          { $ref: '#/components/schemas/Model' },
          {
            type: 'object',
            required: ['discrepancies'],
            properties: {
              discrepancies: {
                type: 'array',
                items: { $ref: '#/components/schemas/FactDiscrepancy' },
              },
            },
          },
        ],
      },
      ModelList: {
        type: 'object',
        required: ['count', 'models', '_links'],
        properties: {
          count: { type: 'integer' },
          models: {
            type: 'array',
            items: { $ref: '#/components/schemas/Model' },
          },
          _links: {
            type: 'object',
            required: ['self', 'providers'],
            properties: {
              self: { $ref: '#/components/schemas/HalLink' },
              providers: { $ref: '#/components/schemas/HalLink' },
            },
          },
        },
      },
      ProviderModelList: {
        type: 'object',
        required: ['provider', 'count', 'models', '_links'],
        properties: {
          provider: { type: 'string' },
          count: { type: 'integer' },
          models: {
            type: 'array',
            items: { $ref: '#/components/schemas/Model' },
          },
          _links: { $ref: '#/components/schemas/ModelLinks' },
        },
      },
      EstimateRequest: {
        type: 'object',
        required: ['provider', 'model'],
        properties: {
          provider: { type: 'string' },
          model: { type: 'string' },
          request: {
            type: 'object',
            description:
              'The provider request body. Request-bound levers read it; result.ignored names the keys the card does not read.',
          },
          usage: {
            type: 'object',
            description:
              "The provider's own usage object as returned (OpenAI Responses or Chat Completions usage, Anthropic usage, Gemini usageMetadata), or card levers. Native usage is mapped to card levers: OpenAI cached_tokens and cache_write_tokens move from the prompt total to cache_read_tokens and cache_write_tokens, and Gemini cachedContentTokenCount moves to cache_read_tokens; Anthropic cache_read_input_tokens and cache_creation_input_tokens become cache_read_tokens and cache_write_tokens (1-hour writes: cache_write_1h_tokens). Card lever counts do not overlap: input_tokens excludes the cache levers, and a count in reasoning_tokens, audio_tokens or image_tokens is not also in input_tokens or output_tokens. The model's pricing.inputs lists the levers its card reads. A payload that mixes native fields and card levers gets 422 mixed_usage. A zero card lever the card does not read is dropped. Any other usage key the card does not read gets 422 unknown_usage_key.",
          },
        },
      },
      EstimateResult: {
        type: 'object',
        required: [
          'amount',
          'currency',
          'cardSource',
          'estimated',
          'defaulted',
          'ignored',
        ],
        properties: {
          amount: {
            type: 'number',
            description: 'The price, in currency. Never converted.',
          },
          currency: {
            type: 'string',
            pattern: '^[A-Z]{3}$',
            description: "ISO-4217 code of the card's currency.",
          },
          usd: {
            type: 'number',
            deprecated: true,
            description:
              'Deprecated: read amount and currency. Repeats amount when currency is USD; absent for any other currency.',
          },
          cardSource: { $ref: '#/components/schemas/RateCardSource' },
          estimated: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Params the caller omitted that the card estimated by its published method. Empty: amount is the price as billed for the supplied request and usage.',
          },
          defaulted: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Params the caller omitted that took the card's default (an omitted list counts as empty). Supply them when the default does not match the call, such as cache_read_tokens on a call that read the cache.",
          },
          ignored: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Request keys the card does not read. They do not change amount. A non-zero usage key the card does not read is a 422 unknown_usage_key instead, because a dropped usage count gives a wrong price. A zero card lever the card does not read is dropped.',
          },
        },
      },
      EstimateRouteResult: {
        allOf: [
          { $ref: '#/components/schemas/EstimateResult' },
          {
            type: 'object',
            required: ['model'],
            properties: {
              model: {
                type: 'string',
                description:
                  'The route this amount was priced on: a catalog rawId, or a gateway provider name when the card is inline on the range.',
              },
            },
          },
        ],
      },
      EstimateByInputResult: {
        type: 'object',
        description:
          'The card has one required choice input (enum or boolean, no default) the call did not supply, and every other required input was supplied: the call priced once per allowed value. The bill is the amount for the value the call uses; nothing is picked. Two or more missing choice inputs, or any missing quantity, is a 422 unbound_input naming each one. If any value cannot be priced, the whole estimate refuses.',
        required: ['currency', 'byInput'],
        properties: {
          currency: { type: 'string', pattern: '^[A-Z]{3}$' },
          byInput: {
            type: 'object',
            required: ['input', 'values'],
            properties: {
              input: {
                type: 'string',
                description:
                  "The param the call omitted. The model's pricing.inputs says whether it goes on request or usage.",
              },
              values: {
                type: 'object',
                description:
                  "Each allowed value (from the card's enum values, or true/false) to the estimate with that value.",
                additionalProperties: {
                  $ref: '#/components/schemas/EstimateResult',
                },
              },
            },
          },
        },
      },
      EstimateRangeResult: {
        type: 'object',
        description:
          "A model with a pricingRange and no single card: the call priced on every route's card. The bill is one route's amount; min and max bound it and neither is the billed price. Any route that cannot be priced refuses the whole estimate.",
        required: ['currency', 'min', 'max', 'routes'],
        properties: {
          currency: { type: 'string', pattern: '^[A-Z]{3}$' },
          min: { $ref: '#/components/schemas/EstimateRouteResult' },
          max: { $ref: '#/components/schemas/EstimateRouteResult' },
          routes: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Every route priced. A catalog rawId, or a gateway provider name when that route's card is inline.",
          },
        },
      },
    },
  },
} as const
