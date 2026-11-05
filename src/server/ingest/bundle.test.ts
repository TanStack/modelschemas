import { describe, expect, it } from 'vitest'

import type { OpenApiDocument } from '#/server/providers/types.ts'
import {
  bundleSchema,
  endpointIdFromPath,
  extractEndpointSchemas,
  findDanglingRefs,
} from './bundle.ts'
import type { JsonValue } from './bundle.ts'

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })

function fixtureSpec(): OpenApiDocument {
  return {
    openapi: '3.1.0',
    paths: {
      '/v1/messages': {
        post: {
          requestBody: {
            content: { 'application/json': { schema: ref('CreateMessage') } },
          },
          responses: {
            '200': {
              content: { 'application/json': { schema: ref('Message') } },
            },
          },
        },
      },
      '/v1/audio/transcriptions': {
        post: {
          requestBody: {
            content: {
              'multipart/form-data': { schema: ref('TranscriptionRequest') },
            },
          },
          responses: {
            '201': {
              content: { 'application/json': { schema: ref('Transcription') } },
            },
          },
        },
      },
      '/v1/audio/speech': {
        post: {
          requestBody: {
            content: { 'application/json': { schema: ref('SpeechRequest') } },
          },
          responses: {
            '200': { content: { 'audio/mpeg': {} } },
          },
        },
      },
      '/fal-ai/veo': {
        post: {
          requestBody: {
            content: { 'application/json': { schema: ref('VeoInput') } },
          },
          responses: {
            '200': {
              content: { 'application/json': { schema: ref('QueueStatus') } },
            },
          },
        },
      },
      '/fal-ai/veo/requests/{request_id}': {
        get: {
          responses: {
            '200': {
              content: { 'application/json': { schema: ref('VeoOutput') } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        CreateMessage: {
          type: 'object',
          properties: {
            content: { type: 'array', items: ref('ContentBlock') },
            tool: ref('Tool'),
          },
        },
        ContentBlock: {
          type: 'object',
          properties: { nested: ref('Tool') },
        },
        Tool: { type: 'object', properties: { name: { type: 'string' } } },
        Message: {
          type: 'object',
          properties: { blocks: { type: 'array', items: ref('ContentBlock') } },
        },
        TranscriptionRequest: {
          type: 'object',
          properties: { file: { type: 'string', format: 'binary' } },
        },
        Transcription: { type: 'object' },
        SpeechRequest: { type: 'object' },
        VeoInput: { type: 'object' },
        QueueStatus: { type: 'object' },
        VeoOutput: {
          type: 'object',
          properties: { video: ref('VideoFile') },
        },
        VideoFile: { type: 'object' },
      },
    },
  }
}

describe('extractEndpointSchemas', () => {
  it('bundles json input + post-200 output with the full $ref closure', () => {
    const result = extractEndpointSchemas(fixtureSpec(), '/v1/messages')
    expect(result.warnings).toEqual([])
    expect(result.input?.type).toBe('object')
    const defs = result.input?.$defs as Record<string, unknown>
    expect(Object.keys(defs).sort()).toEqual(['ContentBlock', 'Tool'])
    expect(findDanglingRefs(result.input ?? {})).toEqual([])
    expect(findDanglingRefs(result.output ?? {})).toEqual([])
  })

  it('handles multipart/form-data bodies and 201 success responses', () => {
    const result = extractEndpointSchemas(
      fixtureSpec(),
      '/v1/audio/transcriptions',
    )
    expect(result.input).toBeDefined()
    expect(result.inputContentType).toBe('multipart/form-data')
    expect(
      (result.input!.properties as Record<string, Record<string, unknown>>).file
        ?.format,
    ).toBe('binary')
    expect(result.output).toBeDefined()
    expect(result.outputContentTypes).toEqual(['application/json'])
  })

  it('omits output for binary-media endpoints and keeps the audio type', () => {
    const result = extractEndpointSchemas(fixtureSpec(), '/v1/audio/speech')
    expect(result.input).toBeDefined()
    expect(result.inputContentType).toBe('application/json')
    expect(result.output).toBeUndefined()
    expect(result.outputContentTypes).toEqual(['audio/mpeg'])
  })

  it('keeps JSON and stores the event-stream schema separately', () => {
    const spec = structuredClone(fixtureSpec())
    const post = spec.paths?.['/v1/messages']?.post as
      | {
          responses?: Record<string, { content?: Record<string, unknown> }>
        }
      | undefined
    const ok = post?.responses?.['200']
    const schemas = spec.components?.schemas
    if (!ok?.content || !schemas)
      throw new Error('fixture missing /v1/messages')
    schemas.Chunk = {
      type: 'object',
      properties: { delta: { type: 'string' } },
    }
    ok.content['text/event-stream'] = {
      schema: { $ref: '#/components/schemas/Chunk' },
    }
    const result = extractEndpointSchemas(spec, '/v1/messages')
    expect(result.inputContentType).toBe('application/json')
    expect(result.outputContentTypes).toEqual([
      'application/json',
      'text/event-stream',
    ])
    expect(result.output?.$defs).toBeDefined()
    expect(result.streamOutput).toMatchObject({
      type: 'object',
      properties: { delta: { type: 'string' } },
    })
    expect(result.streamOutput?.$defs).toBeUndefined()
  })

  it('does not treat a boolean stream field as an event stream', () => {
    const spec = structuredClone(fixtureSpec())
    const create = spec.components?.schemas?.CreateMessage as
      | { properties?: Record<string, unknown> }
      | undefined
    if (!create?.properties) throw new Error('fixture missing CreateMessage')
    create.properties.stream = {
      type: 'boolean',
      description: 'Whether to stream the response using server-sent events.',
    }
    const result = extractEndpointSchemas(spec, '/v1/messages')
    expect(result.outputContentTypes).toEqual(['application/json'])
    expect(result.streamOutput).toBeUndefined()
  })

  it('keeps audio types beside an event stream when the success body is not JSON', () => {
    const spec = structuredClone(fixtureSpec())
    const post = spec.paths?.['/v1/audio/speech']?.post as
      | {
          responses?: Record<string, { content?: Record<string, unknown> }>
        }
      | undefined
    const ok = post?.responses?.['200']
    if (!ok) throw new Error('fixture missing speech')
    ok.content = {
      'application/octet-stream': { schema: { type: 'string' } },
      'audio/mpeg': { schema: { type: 'string' } },
      'text/event-stream': {
        schema: { $ref: '#/components/schemas/Message' },
      },
    }
    const result = extractEndpointSchemas(spec, '/v1/audio/speech')
    expect(result.outputContentTypes).toEqual([
      'application/octet-stream',
      'audio/mpeg',
      'text/event-stream',
    ])
    expect(result.output?.type).toBe('object')
  })

  it('uses the sibling GET for the sibling-get strategy', () => {
    const result = extractEndpointSchemas(
      fixtureSpec(),
      '/fal-ai/veo',
      'sibling-get',
    )
    const defs = result.output?.$defs as Record<string, unknown>
    expect(Object.keys(defs)).toEqual(['VideoFile'])
    expect(findDanglingRefs(result.output ?? {})).toEqual([])
  })

  it('returns nothing for unknown paths', () => {
    expect(extractEndpointSchemas(fixtureSpec(), '/nope')).toEqual({
      warnings: [],
    })
  })
})

describe('bundleSchema', () => {
  const components: Record<string, JsonValue> = {
    Root: {
      type: 'object',
      properties: {
        child: { $ref: '#/components/schemas/Child' },
        self: { $ref: '#/components/schemas/Root' },
      },
    },
    Child: {
      type: 'object',
      properties: { parent: { $ref: '#/components/schemas/Root' } },
    },
  }

  it('rewrites self-references to # instead of leaving dangling defs', () => {
    const { schema, warnings } = bundleSchema(
      components.Root ?? null,
      components,
      'Root',
      'test',
    )
    expect(warnings).toEqual([])
    const props = schema.properties as Record<string, Record<string, unknown>>
    expect(props.self?.$ref).toBe('#')
    expect(props.child?.$ref).toBe('#/$defs/Child')
    const defs = schema.$defs as Record<string, Record<string, unknown>>
    expect(Object.keys(defs)).toEqual(['Child'])
    expect(
      (defs.Child!.properties as Record<string, Record<string, unknown>>).parent
        ?.$ref,
    ).toBe('#')
    expect(findDanglingRefs(schema)).toEqual([])
  })

  it('resolves dedup-renamed refs through the underscore alias (PR #622 lesson)', () => {
    const merged: Record<string, JsonValue> = {
      Input: {
        type: 'object',
        properties: { shared: { $ref: '#/components/schemas/Shared-2' } },
      },
      // The merge step sanitised the components key to an underscore...
      Shared_2: { type: 'object', properties: { ok: { type: 'boolean' } } },
    }
    const { schema, warnings } = bundleSchema(
      merged.Input ?? null,
      merged,
      'Input',
      'test',
    )
    expect(warnings).toEqual([])
    // ...so the bundled $defs carries the ref's spelling, resolved via alias.
    const defs = schema.$defs as Record<string, unknown>
    expect(defs['Shared-2']).toBeDefined()
    expect(findDanglingRefs(schema)).toEqual([])
  })

  it("keeps an inline schema's own $defs beside the component closure (Mistral speech stream)", () => {
    const { schema, warnings } = bundleSchema(
      {
        type: 'object',
        properties: {
          event: { $ref: '#/$defs/EventTypes' },
          data: { $ref: '#/components/schemas/Delta' },
        },
        $defs: { EventTypes: { type: 'string', enum: ['delta'] } },
      },
      { Delta: { type: 'object' } },
      null,
      'test',
    )
    expect(warnings).toEqual([])
    expect(Object.keys(schema.$defs as object).sort()).toEqual([
      'Delta',
      'EventTypes',
    ])
    expect(findDanglingRefs(schema)).toEqual([])
  })

  it('records warnings for dangling refs instead of throwing', () => {
    const { schema, warnings } = bundleSchema(
      {
        type: 'object',
        properties: { x: { $ref: '#/components/schemas/Missing' } },
      },
      {},
      null,
      'ctx',
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("'Missing' not found")
    expect(findDanglingRefs(schema)).toEqual(['#/$defs/Missing'])
  })
})

describe('endpointIdFromPath / findDanglingRefs', () => {
  it('derives endpoint ids by stripping the leading slash', () => {
    expect(endpointIdFromPath('/v1/messages')).toBe('v1/messages')
    expect(endpointIdFromPath('/fal-ai/veo')).toBe('fal-ai/veo')
  })

  it('flags refs that escape the bundle', () => {
    expect(
      findDanglingRefs({
        $ref: '#/components/schemas/Escaped',
      }),
    ).toEqual(['#/components/schemas/Escaped'])
  })
})
