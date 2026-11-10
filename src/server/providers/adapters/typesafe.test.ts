import { Validator } from '@cfworker/json-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { classifyAndBundle } from '../../ingest/sync.ts'
import type { OpenApiDocument } from '../types.ts'
import { jsonSystemOne, provider } from './typesafe.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const SPEC: OpenApiDocument = {
  openapi: '3.1.0',
  paths: {
    '/v1/models': {
      get: {
        responses: {
          '200': {
            description: 'Models',
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
        },
      },
    },
    '/v1/systemone': {
      post: {
        summary: 'System One',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SystemOneRequest' },
            },
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['request'],
                properties: {
                  request: {
                    contentMediaType: 'application/json',
                    contentSchema: {
                      $ref: '#/components/schemas/SystemOneRequest',
                    },
                  },
                },
                additionalProperties: {
                  type: 'string',
                  contentMediaType: 'image/*',
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Answers',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SystemOneResponse' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      SystemOneRequest: {
        type: 'object',
        required: ['model', 'state', 'questions'],
        properties: {
          model: { type: 'string' },
          state: { type: 'string' },
          questions: {
            type: 'object',
            minProperties: 1,
            additionalProperties: {
              type: 'object',
              properties: { type: { type: 'string', const: 'noul' } },
              required: ['type'],
            },
          },
        },
      },
      SystemOneResponse: {
        type: 'object',
        required: ['model', 'answers', 'usage'],
        properties: {
          model: { type: 'string' },
          answers: { type: 'object', minProperties: 1 },
          usage: {
            type: 'object',
            required: ['input_tokens', 'output_tokens'],
            properties: {
              input_tokens: { type: 'integer' },
              output_tokens: { type: 'integer' },
            },
          },
        },
      },
    },
  },
}

describe('typesafe', () => {
  it('keeps POST /v1/systemone and drops the model list', () => {
    expect(provider.classify('/v1/systemone', {})).toBe('decision')
    expect(provider.classify('/v1/models', {})).toBeNull()
    expect(provider.openModelNames).toBe(true)
    expect(provider.authEnvVar).toBe('TYPESAFE_API_KEY')
  })

  it('bundles the JSON body, not the multipart form', () => {
    const bundled = classifyAndBundle(provider, {
      specs: [jsonSystemOne(SPEC)],
      sources: [{ url: 'https://api.typesafe.ai/openapi.json', hash: 'ab' }],
      outputStrategy: 'post-200',
    })
    expect(bundled.endpoints).toHaveLength(1)
    const endpoint = bundled.endpoints[0]
    expect(endpoint?.path).toBe('/v1/systemone')
    expect(endpoint?.activity).toBe('decision')
    expect(endpoint?.input).not.toHaveProperty('properties.request')

    const input = new Validator(endpoint?.input as object, '2020-12', false)
    expect(
      input.validate({
        model: 'jev-latest',
        state: 'Charged twice.',
        questions: { billing: { type: 'noul' } },
      }).valid,
    ).toBe(true)
    expect(
      input.validate({ model: 'jev-latest', state: 'x', questions: {} }).valid,
    ).toBe(false)

    const output = new Validator(endpoint?.output as object, '2020-12', false)
    expect(
      output.validate({
        model: 'jev-1.14.0',
        answers: { billing: { type: 'noul', noul: 0.98 } },
        usage: { input_tokens: 120, output_tokens: 12 },
      }).valid,
    ).toBe(true)
  })
})
