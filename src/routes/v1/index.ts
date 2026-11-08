import { createFileRoute } from '@tanstack/react-router'

import { halGet, halPost } from '#/server/hal.ts'

export const serviceIndex = {
  service: 'modelschemas',
  description:
    'Live AI model schemas: per-endpoint request/response JSON Schemas and model metadata for monitored providers, auto-refreshed.',
  documentation: {
    openapi: '/openapi.json',
    agents: '/llms.txt',
  },
  _links: {
    self: halGet('/v1'),
    status: halGet('/v1/status'),
    providers: halGet('/v1/providers'),
    provider: halGet('/v1/providers/{provider}', {
      example: '/v1/providers/anthropic',
    }),
    models: halGet(
      '/v1/models{?activity,provider,capability,q,provenance,pricing}',
      {
        example: '/v1/models?activity=chat&q=claude',
      },
    ),
    model: halGet('/v1/models/{provider}/{modelId}', {
      example: '/v1/models/anthropic/claude-sonnet-4-5',
    }),
    schemaIndex: halGet('/v1/schemas', {
      example: '/v1/schemas',
    }),
    schemas: halGet('/v1/schemas/{provider}', {
      example: '/v1/schemas/anthropic',
    }),
    activitySchemas: halGet('/v1/schemas/{provider}/{activity}', {
      example: '/v1/schemas/anthropic/chat',
    }),
    schema: halGet(
      '/v1/schemas/{provider}/{activity}/{endpointId}{?kind,version}',
      {
        example: '/v1/schemas/anthropic/chat/v1%2Fmessages?kind=input',
      },
    ),
    providerOpenapi: halGet('/v1/openapi/{provider}{?model,activity}', {
      example: '/v1/openapi/anthropic',
    }),
    validate: halPost('/v1/validate', {
      example: {
        provider: 'anthropic',
        endpointId: 'v1/messages',
        kind: 'input',
        payload: { model: 'claude-sonnet-4-5', max_tokens: 1024 },
      },
    }),
    estimate: halPost('/v1/estimate', {
      example: {
        provider: 'openai',
        model: 'gpt-4o',
        usage: { input_tokens: 1200, output_tokens: 400 },
      },
    }),
    changes: halGet('/v1/changes{?since,provider,type,cursor,limit,wait}', {
      example: '/v1/changes?limit=20',
    }),
    agentDiscovery: halGet('/.well-known/agent-configuration'),
  },
}

export const Route = createFileRoute('/v1/')({
  server: {
    handlers: {
      GET: () => Response.json(serviceIndex),
    },
  },
})
