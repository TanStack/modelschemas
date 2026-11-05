import { describe, expect, it } from 'vitest'

import {
  applyModelEnum,
  endpointMatchesModel,
  headerParams,
  operationsFor,
  pathParamsFromPath,
  requestMedia,
  hoistSchemaDefs,
  responseMedia,
  unresolvedRefs,
} from './provider-openapi.ts'
import { falProvider } from './providers/fal.ts'
import { anthropicProvider } from './providers/anthropic.ts'
import { getProvider } from './providers/index.ts'
import {
  MAX_QUEUE_SPEC_PATHS,
  resolveConnect,
  resolveSpecGrain,
} from './providers/connect.ts'

describe('path + header helpers', () => {
  it('extracts braced path params', () => {
    expect(pathParamsFromPath('/v1/text-to-speech/{voice_id}')).toEqual([
      {
        name: 'voice_id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
    ])
    expect(pathParamsFromPath('/v1/messages')).toEqual([])
  })

  it('emits a constant header as const and a client-supplied header as a rule', () => {
    expect(
      headerParams([
        { name: 'anthropic-version', value: '2023-06-01' },
        {
          name: 'x-opencode-session',
          description: 'A stable session id the client chooses.',
        },
      ]),
    ).toEqual([
      {
        name: 'anthropic-version',
        in: 'header',
        required: true,
        schema: { type: 'string', const: '2023-06-01' },
      },
      {
        name: 'x-opencode-session',
        in: 'header',
        required: true,
        description: 'A stable session id the client chooses.',
        schema: { type: 'string' },
      },
    ])
  })
})

describe('applyModelEnum', () => {
  it('pins properties.model and leaves other schemas alone', () => {
    const schema = {
      type: 'object',
      properties: {
        model: { type: 'string' },
        max_tokens: { type: 'integer' },
      },
    }
    expect(applyModelEnum(schema, ['claude-sonnet-4-5'])).toEqual({
      type: 'object',
      properties: {
        model: { type: 'string', enum: ['claude-sonnet-4-5'] },
        max_tokens: { type: 'integer' },
      },
    })
    expect(applyModelEnum({ type: 'string' }, ['x'])).toEqual({
      type: 'string',
    })
  })
})

describe('generation media types', () => {
  const schema = { type: 'object', properties: { id: { type: 'string' } } }

  it('defaults a recorded-before-content-types schema to JSON', () => {
    expect(requestMedia(schema, null)).toEqual({
      content: { 'application/json': { schema } },
    })
    expect(responseMedia(schema, null)).toEqual({
      content: { 'application/json': { schema } },
    })
    expect(requestMedia(undefined, 'multipart/form-data')).toBeUndefined()
    expect(responseMedia(undefined, null)).toBeUndefined()
  })

  it('sends a file upload as multipart and a stream as event-stream', () => {
    expect(requestMedia(schema, 'multipart/form-data')).toEqual({
      content: { 'multipart/form-data': { schema } },
    })
    expect(responseMedia(schema, ['text/event-stream'])).toEqual({
      content: { 'text/event-stream': { schema } },
    })
    expect(responseMedia(undefined, ['text/event-stream'])).toBeUndefined()
  })

  it('keeps JSON and uses the stream schema for the event stream', () => {
    const chunk = { type: 'object', properties: { delta: { type: 'string' } } }
    expect(
      responseMedia(schema, ['application/json', 'text/event-stream'], chunk),
    ).toEqual({
      content: {
        'application/json': { schema },
        'text/event-stream': { schema: chunk },
      },
    })
    expect(
      responseMedia(schema, ['application/json', 'text/event-stream']),
    ).toEqual({
      content: { 'application/json': { schema } },
    })
    expect(responseMedia(schema, ['application/json', 'text/plain'])).toEqual({
      content: {
        'application/json': { schema },
        'text/plain': { schema: { type: 'string' } },
      },
    })
  })

  it('keeps JSON and SSE on one post, as the official OpenAI spec does', () => {
    const chunk = { type: 'object', properties: { delta: { type: 'string' } } }
    const ops = operationsFor(
      'openai',
      {
        id: 'chat',
        path: '/chat/completions',
        activity: 'chat',
        description: 'Create a completion',
        method: 'POST',
        input: schema,
        output: schema,
        streamSchema: chunk,
        requestContentType: null,
        responseContentTypes: ['application/json', 'text/event-stream'],
        specRevision: null,
      },
      {
        servers: [{ url: 'https://api.openai.com/v1' }],
        securitySchemes: {},
        security: [],
      },
      [],
      undefined,
    )
    expect(ops.map((op) => [op.method, op.path])).toEqual([
      ['post', '/chat/completions'],
    ])
    const responses = ops[0]?.operation.responses as {
      '200': { content: Record<string, { schema: unknown }> }
    }
    expect(responses['200'].content).toEqual({
      'application/json': { schema },
      'text/event-stream': { schema: chunk },
    })
  })

  it('describes audio responses as binary and keeps a stream schema beside them', () => {
    expect(
      responseMedia(schema, [
        'application/octet-stream',
        'audio/mpeg',
        'text/event-stream',
      ]),
    ).toEqual({
      content: {
        'application/octet-stream': {
          schema: { type: 'string', format: 'binary' },
        },
        'audio/mpeg': { schema: { type: 'string', format: 'binary' } },
        'text/event-stream': { schema },
      },
    })
  })
})

describe('endpointMatchesModel', () => {
  it('matches exact aggregator paths, not prefixes', () => {
    expect(
      endpointMatchesModel(
        'fal-ai/flux/dev',
        '/fal-ai/flux/dev',
        'fal-ai/flux/dev',
      ),
    ).toBe(true)
    expect(
      endpointMatchesModel(
        'fal-ai/flux/dev/redux',
        '/fal-ai/flux/dev/redux',
        'fal-ai/flux/dev',
      ),
    ).toBe(false)
    expect(
      endpointMatchesModel('v1/messages', '/v1/messages', 'claude-sonnet-4-5'),
    ).toBe(false)
  })
})

describe('connect profiles', () => {
  it('declares FAL as model-grained and Anthropic as provider-grained', () => {
    expect(resolveSpecGrain(falProvider)).toBe('model')
    expect(resolveSpecGrain(anthropicProvider)).toBe('provider')
    expect(MAX_QUEUE_SPEC_PATHS).toBe(1024)
  })

  it('carries Anthropic version + x-api-key and FAL sibling GET', () => {
    const anthropic = resolveConnect(anthropicProvider)
    expect(anthropic?.servers[0]?.url).toBe('https://api.anthropic.com')
    expect(anthropic?.requiredHeaders).toEqual([
      { name: 'anthropic-version', value: '2023-06-01' },
    ])
    expect(
      anthropic?.securitySchemes.apiKey &&
        anthropic.securitySchemes.apiKey.type === 'apiKey'
        ? anthropic.securitySchemes.apiKey.name
        : undefined,
    ).toBe('x-api-key')
    const fal = resolveConnect(falProvider)
    expect(fal?.siblingGet).toBe(true)
    expect(
      fal?.securitySchemes.apiKey &&
        fal.securitySchemes.apiKey.type === 'apiKey'
        ? fal.securitySchemes.apiKey.name
        : undefined,
    ).toBe('Authorization')
  })

  it('does not guess a connect profile from modelsEndpoint', () => {
    expect(resolveConnect(getProvider('voyage'))).toBeNull()
  })
})

describe('hoistSchemaDefs', () => {
  const body = (schema: unknown) => ({
    post: {
      requestBody: { content: { 'application/json': { schema } } },
      responses: { '200': { content: { 'application/json': { schema } } } },
    },
  })

  it('moves $defs into components, dedupes, and renames a clash by content', () => {
    const a = {
      type: 'object',
      properties: {
        x: { $ref: '#/$defs/Shared' },
        y: { $ref: '#/$defs/Item' },
      },
      $defs: {
        Shared: { type: 'string' },
        Item: { type: 'object', properties: { s: { $ref: '#/$defs/Shared' } } },
      },
    }
    const b = {
      type: 'object',
      properties: {
        x: { $ref: '#/$defs/Shared' },
        y: { $ref: '#/$defs/Item' },
      },
      $defs: { Shared: { type: 'string' }, Item: { type: 'integer' } },
      discriminator: {
        propertyName: 'kind',
        mapping: { item: '#/components/schemas/Item' },
      },
    }
    const paths: Record<string, Record<string, unknown>> = {
      '/a': body(a),
      '/b': body(b),
    }
    const schemas = hoistSchemaDefs(Object.values(paths), {})
    const document = { paths, components: { schemas } }
    expect(unresolvedRefs(document)).toEqual([])
    expect(JSON.stringify(document)).not.toContain('$defs')
    const names = Object.keys(schemas).sort()
    expect(names).toHaveLength(3)
    expect(names).toContain('Shared')
    expect(names).toContain('Item')
    expect(schemas.Item).toEqual({
      type: 'object',
      properties: { s: { $ref: '#/components/schemas/Shared' } },
    })
    const renamed = names.find((name) => name.startsWith('Item_'))
    expect(renamed && schemas[renamed]).toEqual({ type: 'integer' })
    const bBody = (
      paths['/b']!.post as {
        requestBody: {
          content: Record<
            string,
            { schema: { discriminator: { mapping: Record<string, string> } } }
          >
        }
      }
    ).requestBody.content['application/json']?.schema
    expect(bBody?.discriminator.mapping.item).toBe(
      `#/components/schemas/${renamed ?? ''}`,
    )
  })

  it('turns a root self-reference into a component', () => {
    const tree = {
      type: 'object',
      properties: { children: { type: 'array', items: { $ref: '#' } } },
    }
    const paths: Record<string, Record<string, unknown>> = { '/t': body(tree) }
    const schemas = hoistSchemaDefs(Object.values(paths), { named: tree })
    expect(unresolvedRefs({ paths, components: { schemas } })).toEqual([])
    expect(schemas.named).toEqual({
      type: 'object',
      properties: {
        children: {
          type: 'array',
          items: { $ref: '#/components/schemas/named' },
        },
      },
    })
  })
})
