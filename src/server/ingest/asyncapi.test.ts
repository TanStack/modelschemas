import { describe, expect, it } from 'vitest'

import type { ProviderConfig } from '#/server/providers/types.ts'
import directorAsyncApi from './fixtures/fal-minimax-h3-max-director.asyncapi.json'
import {
  asyncApiMessageTypes,
  extractAsyncApiSchemas,
  hasAsyncApiFlag,
  preserveAsyncApiFlag,
  withAsyncApiFlag,
} from './asyncapi.ts'
import { EXTRACTOR_VERSION, findDanglingRefs } from './bundle.ts'
import { classifyAndBundle } from './sync.ts'

describe('extractAsyncApiSchemas', () => {
  it('bundles Director client/server messages as type-discriminated oneOf', () => {
    const extracted = extractAsyncApiSchemas(directorAsyncApi)
    expect(extracted.warnings).toEqual([])
    expect(extracted.input).toBeDefined()
    expect(extracted.output).toBeDefined()
    expect(findDanglingRefs(extracted.input ?? {})).toEqual([])
    expect(findDanglingRefs(extracted.output ?? {})).toEqual([])
    expect(asyncApiMessageTypes(extracted.input)).toEqual(
      expect.arrayContaining(['configure', 'prompt']),
    )
    expect(asyncApiMessageTypes(extracted.output)).toEqual(
      expect.arrayContaining(['session_info', 'chunk', 'error']),
    )
    expect(extracted.output?.$defs).toMatchObject({
      MiniMaxH3MaxDirectorServerDispatchAccounting: {
        type: 'object',
      },
    })
  })

  it('falls back to components.messages when operations are absent', () => {
    const extracted = extractAsyncApiSchemas({
      asyncapi: '3.1.0',
      components: {
        messages: {
          'client.configure': {
            payload: {
              type: 'object',
              properties: { type: { const: 'configure' } },
            },
          },
          'server.error': {
            payload: {
              type: 'object',
              properties: { type: { const: 'error' } },
            },
          },
        },
      },
    })
    expect(asyncApiMessageTypes(extracted.input)).toEqual(['configure'])
    expect(asyncApiMessageTypes(extracted.output)).toEqual(['error'])
  })

  it('does not bump the OpenAPI extractor version', () => {
    expect(EXTRACTOR_VERSION).toBe('2')
  })
})

describe('asyncapi catalog flag helpers', () => {
  it('adds, detects, drops, and preserves asyncapi: true', () => {
    const listed = { tools: true }
    const flagged = withAsyncApiFlag(listed, true)
    expect(flagged).toEqual({ tools: true, asyncapi: true })
    expect(hasAsyncApiFlag(flagged)).toBe(true)
    expect(hasAsyncApiFlag(listed)).toBe(false)
    expect(withAsyncApiFlag(flagged, false)).toEqual({ tools: true })
    expect(preserveAsyncApiFlag(flagged, listed)).toEqual({
      tools: true,
      asyncapi: true,
    })
    expect(preserveAsyncApiFlag(listed, listed)).toEqual(listed)
    // A row with no flags of its own: the flag is the whole map, or none.
    expect(withAsyncApiFlag(null, true)).toEqual({ asyncapi: true })
    expect(withAsyncApiFlag({ asyncapi: true }, false)).toBeNull()
    expect(preserveAsyncApiFlag({ asyncapi: true }, null)).toEqual({
      asyncapi: true,
    })
  })
})

describe('classifyAndBundle bundledEndpoints', () => {
  it('appends AsyncAPI endpoints next to OpenAPI paths', () => {
    const extracted = extractAsyncApiSchemas(directorAsyncApi)
    const provider: ProviderConfig = {
      id: 'fal',
      displayName: 'FAL',
      defaultDerivation: 'upstream-spec',
      fetchSpec: () =>
        Promise.resolve({
          specs: [],
          sources: [],
          outputStrategy: 'sibling-get',
        }),
      listModels: () => Promise.resolve({ models: [] }),
      classify: (path) => (path === '/fal-ai/flux/dev' ? 'image' : null),
    }
    const { endpoints } = classifyAndBundle(provider, {
      specs: [
        {
          paths: {
            '/fal-ai/flux/dev': {
              post: {
                summary: 'Flux',
                requestBody: {
                  content: {
                    'application/json': {
                      schema: { type: 'object' },
                    },
                  },
                },
              },
            },
          },
        },
      ],
      sources: [{ url: 'https://example.com/openapi.json', hash: 'abc' }],
      outputStrategy: 'post-200',
      bundledEndpoints: [
        {
          path: '/minimax/h3-max/director',
          activity: 'video',
          description: 'Director',
          source: {
            url: 'https://fal.ai/api/apps/fal-ai/minimax-h3-max-director/asyncapi.json',
            hash: 'def',
          },
          derivation: 'upstream-spec',
          input: extracted.input,
          output: extracted.output,
          asyncapi: true,
        },
      ],
    })
    expect(endpoints.map((e) => e.dbId)).toEqual([
      'fal/fal-ai/flux/dev',
      'fal/minimax/h3-max/director',
    ])
    expect(endpoints[1]).toMatchObject({
      dbId: 'fal/minimax/h3-max/director',
      path: '/minimax/h3-max/director',
      activity: 'video',
      asyncapi: true,
      derivation: 'upstream-spec',
    })
  })
})
