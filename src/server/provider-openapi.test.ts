import { describe, expect, it } from 'vitest'

import {
  applyModelEnum,
  endpointMatchesModel,
  headerParams,
  pathParamsFromPath,
} from './provider-openapi.ts'
import { falProvider } from './providers/fal.ts'
import { anthropicProvider } from './providers/anthropic.ts'
import { getProvider } from './providers/index.ts'
import { resolveConnect, resolveSpecGrain } from './providers/connect.ts'

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
