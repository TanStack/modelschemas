import { describe, expect, it } from 'vitest'

import { extractEndpointSchemas } from '#/server/ingest/bundle.ts'
import { responseMedia } from '#/server/provider-openapi.ts'
import type { OpenApiDocument } from '../types.ts'
import { provider } from './ollama.ts'

/** The shape of `/api/chat` in ollama/ollama docs/openapi.yaml. */
const spec = {
  openapi: '3.1.0',
  paths: {
    '/api/chat': {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ChatRequest' },
            },
          },
        },
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChatResponse' },
              },
              'application/x-ndjson': {
                schema: { $ref: '#/components/schemas/ChatStreamEvent' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      ChatRequest: {
        type: 'object',
        properties: { model: { type: 'string' }, stream: { type: 'boolean' } },
      },
      ChatResponse: { type: 'object', properties: { done: { const: true } } },
      ChatStreamEvent: {
        type: 'object',
        properties: { done: { type: 'boolean' } },
      },
    },
  },
} as unknown as OpenApiDocument

describe('ollama', () => {
  it('classifies the generation routes and drops management ones', () => {
    expect(provider.classify('/api/chat', {})).toBe('chat')
    expect(provider.classify('/api/generate', {})).toBe('chat')
    expect(provider.classify('/api/embed', {})).toBe('embeddings')
    expect(provider.classify('/api/tags', {})).toBeNull()
    expect(provider.classify('/api/pull', {})).toBeNull()
  })

  it('takes a configurable server, keyless locally', () => {
    const server = provider.connect?.servers[0]
    expect(server?.url).toBe('{baseUrl}')
    expect(server?.variables?.baseUrl?.default).toBe('http://localhost:11434')
    expect(provider.connect?.security).toEqual([{}, { bearerAuth: [] }])
  })

  it('keeps the NDJSON stream beside the JSON body', () => {
    const extracted = extractEndpointSchemas(spec, '/api/chat')
    expect(extracted.outputContentTypes).toEqual([
      'application/json',
      'application/x-ndjson',
    ])
    expect(extracted.output?.properties).toEqual({ done: { const: true } })
    expect(extracted.streamOutput?.properties).toEqual({
      done: { type: 'boolean' },
    })
    expect(
      responseMedia(
        extracted.output,
        extracted.outputContentTypes,
        extracted.streamOutput,
      )?.content,
    ).toEqual({
      'application/json': { schema: extracted.output },
      'application/x-ndjson': { schema: extracted.streamOutput },
    })
  })
})
