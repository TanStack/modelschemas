import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from '#/db/index.ts'
import type { Db } from '#/db/index.ts'
import { eq } from 'drizzle-orm'

import { endpoints, models, providers, schemaVersions } from '#/db/schema.ts'
import { assembleProviderOpenApi, unresolvedRefs } from './provider-openapi.ts'

const NOW = 1_781_150_000
const INPUT = {
  type: 'object',
  required: ['model'],
  properties: { model: { type: 'string' }, max_tokens: { type: 'integer' } },
}
const OUTPUT = { type: 'object', properties: { id: { type: 'string' } } }

let db: Db

beforeAll(async () => {
  db = getDb(env)
  await db
    .insert(providers)
    .values([
      {
        id: 'anthropic',
        displayName: 'Anthropic',
        specSourceUrl: 'https://example.com/a.json',
      },
      {
        id: 'fal',
        displayName: 'FAL',
        specSourceUrl: 'https://example.com/f.json',
      },
    ])
    .onConflictDoNothing()
  await db
    .insert(endpoints)
    .values([
      {
        id: 'anthropic/v1/messages',
        providerId: 'anthropic',
        activity: 'chat',
        method: 'POST',
        path: '/v1/messages',
        description: 'Create a message',
      },
      {
        id: 'fal/fal-ai/flux/dev',
        providerId: 'fal',
        activity: 'image',
        method: 'POST',
        path: '/fal-ai/flux/dev',
      },
      {
        id: 'fal/fal-ai/other',
        providerId: 'fal',
        activity: 'image',
        method: 'POST',
        path: '/fal-ai/other',
      },
      {
        id: 'fal/fal-ai/retired',
        providerId: 'fal',
        activity: 'image',
        method: 'POST',
        path: '/fal-ai/retired',
      },
    ])
    .onConflictDoNothing()
  await db
    .insert(schemaVersions)
    .values([
      {
        id: 'anthropic/v1/messages:input',
        endpointId: 'anthropic/v1/messages',
        kind: 'input',
        contentHash: 'a'.repeat(64),
        schema: JSON.stringify(INPUT),
        createdAt: NOW,
      },
      {
        id: 'anthropic/v1/messages:output',
        endpointId: 'anthropic/v1/messages',
        kind: 'output',
        contentHash: 'b'.repeat(64),
        schema: JSON.stringify(OUTPUT),
        createdAt: NOW,
      },
      {
        id: 'fal/fal-ai/flux/dev:input',
        endpointId: 'fal/fal-ai/flux/dev',
        kind: 'input',
        contentHash: 'c'.repeat(64),
        schema: JSON.stringify({
          type: 'object',
          properties: { prompt: { type: 'string' } },
        }),
        createdAt: NOW,
      },
      {
        id: 'fal/fal-ai/flux/dev:output',
        endpointId: 'fal/fal-ai/flux/dev',
        kind: 'output',
        contentHash: 'd'.repeat(64),
        schema: JSON.stringify(OUTPUT),
        createdAt: NOW,
      },
      {
        id: 'fal/fal-ai/other:input',
        endpointId: 'fal/fal-ai/other',
        kind: 'input',
        contentHash: 'e'.repeat(64),
        schema: JSON.stringify({ type: 'object' }),
        createdAt: NOW,
      },
    ])
    .onConflictDoNothing()
  await db
    .insert(models)
    .values([
      {
        id: 'fal-fal-ai-flux-dev',
        providerId: 'fal',
        rawId: 'fal-ai/flux/dev',
        activity: 'image',
        providerMetadata: { category: 'text-to-image' },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: 'fal-fal-ai-other',
        providerId: 'fal',
        rawId: 'fal-ai/other',
        activity: 'image',
        providerMetadata: { category: 'text-to-image' },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: 'fal-retired',
        providerId: 'fal',
        rawId: 'fal-ai/retired',
        activity: 'image',
        providerMetadata: { category: 'text-to-image' },
        deprecatedAt: NOW,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: 'anthropic-claude-sonnet-4-5',
        providerId: 'anthropic',
        rawId: 'claude-sonnet-4-5',
        activity: 'chat',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ])
    .onConflictDoNothing()
})

describe('assembleProviderOpenApi', () => {
  it('assembles a connectable Anthropic document', async () => {
    const result = await assembleProviderOpenApi(db, 'anthropic')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.openapi).toBe('3.1.0')
    const paths = result.document.paths as Record<
      string,
      { post?: { parameters?: Array<{ name: string }>; requestBody?: unknown } }
    >
    expect(paths['/v1/messages']?.post?.requestBody).toBeDefined()
    const headers = paths['/v1/messages']?.post?.parameters ?? []
    expect(headers.some((p) => p.name === 'anthropic-version')).toBe(true)
    expect((result.document.servers as Array<{ url: string }>)[0]?.url).toBe(
      'https://api.anthropic.com',
    )
    const body = paths['/v1/messages']?.post?.requestBody as
      | {
          content: {
            'application/json': {
              schema: { properties?: { model?: { enum?: Array<string> } } }
            }
          }
        }
      | undefined
    expect(
      body?.content['application/json'].schema.properties?.model?.enum,
    ).toEqual(['claude-sonnet-4-5'])
  })

  it('pins the model enum when ?model= is passed', async () => {
    const result = await assembleProviderOpenApi(db, 'anthropic', {
      model: 'claude-sonnet-4-5',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const paths = result.document.paths as Record<
      string,
      {
        post?: {
          requestBody?: {
            content: {
              'application/json': {
                schema: { properties?: { model?: { enum?: Array<string> } } }
              }
            }
          }
        }
      }
    >
    expect(
      paths['/v1/messages']?.post?.requestBody?.content['application/json']
        .schema.properties?.model?.enum,
    ).toEqual(['claude-sonnet-4-5'])
  })

  it('serves FAL with no selector as one untyped queue document', async () => {
    const bare = await assembleProviderOpenApi(db, 'fal')
    expect(bare.ok).toBe(true)
    if (!bare.ok) return
    const barePaths = bare.document.paths as Record<
      string,
      {
        post: {
          parameters: Array<{ name: string; schema?: { enum?: Array<string> } }>
          requestBody: {
            content: { 'application/json': { schema: Record<string, unknown> } }
          }
        }
      }
    >
    expect(Object.keys(barePaths).sort()).toEqual([
      '/{endpoint_id}',
      '/{endpoint_id}/requests/{request_id}',
    ])
    const bareEnum = barePaths['/{endpoint_id}']?.post.parameters.find(
      (parameter) => parameter.name === 'endpoint_id',
    )?.schema?.enum
    expect(bareEnum).toContain('fal-ai/flux/dev')
    expect(bareEnum).not.toContain('fal-ai/retired')
    expect(
      barePaths['/{endpoint_id}']?.post.requestBody.content['application/json']
        .schema,
    ).toMatchObject({ type: 'object' })
    expect(
      (bare.document.components as { schemas?: unknown }).schemas,
    ).toBeUndefined()
  })

  it('serves one model with sibling GET', async () => {
    const pinned = await assembleProviderOpenApi(db, 'fal', {
      model: 'fal-ai/flux/dev',
    })
    expect(pinned.ok).toBe(true)
    if (!pinned.ok) return
    const paths = pinned.document.paths as Record<
      string,
      {
        post?: {
          responses?: { '200'?: { content?: unknown } }
        }
        get?: {
          parameters?: Array<{ name: string }>
          responses?: {
            '200'?: {
              content?: {
                'application/json': {
                  schema: { properties?: { id?: unknown } }
                }
              }
            }
          }
        }
      }
    >
    expect(paths['/fal-ai/flux/dev']?.post).toBeDefined()
    expect(
      paths['/fal-ai/flux/dev']?.post?.responses?.['200']?.content,
    ).toBeUndefined()
    const sibling = paths['/fal-ai/flux/dev/requests/{request_id}']?.get
    expect(sibling).toBeDefined()
    expect(sibling?.parameters?.some((p) => p.name === 'request_id')).toBe(true)
    expect(
      sibling?.responses?.['200']?.content?.['application/json'].schema
        .properties?.id,
    ).toBeDefined()
    expect(paths['/fal-ai/other']).toBeUndefined()

    const pinnedActivity = await assembleProviderOpenApi(db, 'fal', {
      model: 'fal-ai/flux/dev',
      activity: 'image',
    })
    expect(pinnedActivity.ok).toBe(true)
    if (!pinnedActivity.ok) return
    expect(pinnedActivity.document.paths).toHaveProperty('/fal-ai/flux/dev')
    expect(pinnedActivity.document.paths).not.toHaveProperty('/{endpoint_id}')
  })

  it('serves one FAL queue document for an activity', async () => {
    const empty = await assembleProviderOpenApi(db, 'fal', {
      activity: 'chat',
    })
    expect(empty).toMatchObject({
      ok: false,
      status: 400,
      code: 'spec_requires_selector',
    })

    const result = await assembleProviderOpenApi(db, 'fal', {
      activity: 'image',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const paths = result.document.paths as Record<
      string,
      {
        post?: {
          parameters?: Array<{
            name: string
            schema?: { enum?: Array<string> }
          }>
          requestBody?: {
            content: {
              'application/json': {
                schema: { anyOf?: Array<{ $ref: string }> }
              }
            }
          }
        }
        get?: {
          responses?: {
            '200'?: {
              content?: {
                'application/json': { schema: { $ref?: string } }
              }
            }
          }
        }
      }
    >
    expect(Object.keys(paths).sort()).toEqual([
      '/{endpoint_id}',
      '/{endpoint_id}/requests/{request_id}',
    ])
    const endpointParam = paths['/{endpoint_id}']?.post?.parameters?.find(
      (parameter) => parameter.name === 'endpoint_id',
    )
    expect(endpointParam).toMatchObject({ 'x-modelschemas-encode': 'raw' })
    expect(endpointParam?.schema?.enum).toEqual([
      'fal-ai/flux/dev',
      'fal-ai/other',
    ])
    const body = paths['/{endpoint_id}']?.post?.requestBody
    expect(body?.content['application/json'].schema.anyOf).toEqual([
      { $ref: '#/components/schemas/input_fal-ai_flux_dev' },
      { $ref: '#/components/schemas/input_fal-ai_other' },
    ])
    // fal-ai/other has no output schema, so the result stays untyped and
    // the response says why.
    const queued = (
      paths['/{endpoint_id}/requests/{request_id}'] as {
        get?: { responses?: { '200'?: { description?: string } } }
      }
    ).get?.responses?.['200']
    expect(queued?.description).toContain('1 of 2 models')
    expect(queued).not.toHaveProperty('content')
    const schemas = (
      result.document.components as {
        schemas: Record<
          string,
          { 'x-modelschemas-model'?: string; properties?: unknown }
        >
      }
    ).schemas
    const fluxInput = schemas['input_fal-ai_flux_dev']
    const otherInput = schemas['input_fal-ai_other']
    expect(fluxInput?.['x-modelschemas-model']).toBe('fal-ai/flux/dev')
    expect(fluxInput?.properties).toEqual({ prompt: { type: 'string' } })
    expect(otherInput?.['x-modelschemas-model']).toBe('fal-ai/other')
    // fal-ai/other has no output schema, so the result body is omitted
    // rather than described as Flux's output.
    expect(
      paths['/{endpoint_id}/requests/{request_id}']?.get?.responses?.['200']
        ?.content,
    ).toBeUndefined()
    expect(schemas['output_fal-ai_flux_dev']).toBeUndefined()
    expect(schemas['input_fal-ai_retired']).toBeUndefined()
    const info = result.document.info as { description?: string }
    expect(info.description).toContain('x-modelschemas-model')
  })

  it('includes a deprecated model with stored schemas in its activity document', async () => {
    await db
      .insert(endpoints)
      .values({
        id: 'fal/fal-ai/veo3.1',
        providerId: 'fal',
        activity: 'video',
        method: 'POST',
        path: '/fal-ai/veo3.1',
      })
      .onConflictDoNothing()
    await db
      .insert(models)
      .values({
        id: 'fal-fal-ai-veo3-1',
        providerId: 'fal',
        rawId: 'fal-ai/veo3.1',
        activity: 'video',
        providerMetadata: { category: 'text-to-video' },
        deprecatedAt: NOW,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      })
      .onConflictDoNothing()
    await db
      .insert(schemaVersions)
      .values([
        {
          id: 'fal/fal-ai/veo3.1:input',
          endpointId: 'fal/fal-ai/veo3.1',
          kind: 'input',
          contentHash: '1'.repeat(64),
          schema: JSON.stringify({
            type: 'object',
            properties: { prompt: { type: 'string' } },
          }),
          createdAt: NOW,
        },
        {
          id: 'fal/fal-ai/veo3.1:output',
          endpointId: 'fal/fal-ai/veo3.1',
          kind: 'output',
          contentHash: '2'.repeat(64),
          schema: JSON.stringify({
            type: 'object',
            properties: { video: { type: 'object' } },
          }),
          createdAt: NOW,
        },
      ])
      .onConflictDoNothing()

    const bare = await assembleProviderOpenApi(db, 'fal')
    expect(bare.ok).toBe(true)
    if (!bare.ok) return
    const bareEnum = (
      bare.document.paths as Record<
        string,
        {
          post: {
            parameters: Array<{
              name: string
              schema?: { enum?: Array<string> }
            }>
          }
        }
      >
    )['/{endpoint_id}']?.post.parameters.find(
      (parameter) => parameter.name === 'endpoint_id',
    )?.schema?.enum
    expect(bareEnum).not.toContain('fal-ai/veo3.1')

    const video = await assembleProviderOpenApi(db, 'fal', {
      activity: 'video',
    })
    expect(video.ok).toBe(true)
    if (!video.ok) return
    const post = (
      video.document.paths as Record<
        string,
        {
          post?: {
            parameters?: Array<{ schema?: { enum?: Array<string> } }>
            requestBody?: {
              content: {
                'application/json': { schema: { $ref?: string } }
              }
            }
          }
        }
      >
    )['/{endpoint_id}']?.post
    expect(post?.parameters?.[0]?.schema?.enum).toEqual(['fal-ai/veo3.1'])
    expect(post?.requestBody?.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/input_fal-ai_veo3.1',
    )
    const schemas = (
      video.document.components as {
        schemas: Record<
          string,
          { 'x-modelschemas-model'?: string; properties?: unknown }
        >
      }
    ).schemas
    expect(schemas['input_fal-ai_veo3.1']).toMatchObject({
      'x-modelschemas-model': 'fal-ai/veo3.1',
      properties: { prompt: { type: 'string' } },
    })
    expect(schemas['output_fal-ai_veo3.1']).toMatchObject({
      'x-modelschemas-model': 'fal-ai/veo3.1',
      properties: { video: { type: 'object' } },
    })
  })

  it('leaves a model with no generation endpoint out of the enum', async () => {
    await db
      .insert(models)
      .values({
        id: 'fal-orphan',
        providerId: 'fal',
        rawId: 'fal-ai/orphan',
        activity: 'image',
        providerMetadata: { category: 'text-to-image' },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      })
      .onConflictDoNothing()
    const result = await assembleProviderOpenApi(db, 'fal', {
      activity: 'image',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const post = (
      result.document.paths as Record<
        string,
        { post: { parameters: Array<{ schema?: { enum?: Array<string> } }> } }
      >
    )['/{endpoint_id}']?.post
    expect(post?.parameters[0]?.schema?.enum).not.toContain('fal-ai/orphan')
    await db.delete(models).where(eq(models.id, 'fal-orphan'))
  })

  it('pairs each result schema with the same endpoint id', async () => {
    await db
      .insert(endpoints)
      .values([
        {
          id: 'fal/fal-ai/pair/a',
          providerId: 'fal',
          activity: 'chat',
          method: 'POST',
          path: '/fal-ai/pair/a',
        },
        {
          id: 'fal/fal-ai/pair/b',
          providerId: 'fal',
          activity: 'chat',
          method: 'POST',
          path: '/fal-ai/pair/b',
        },
        {
          id: 'fal/fal-ai/pair/no-input',
          providerId: 'fal',
          activity: 'chat',
          method: 'POST',
          path: '/fal-ai/pair/no-input',
        },
      ])
      .onConflictDoNothing()
    await db
      .insert(models)
      .values([
        {
          id: 'fal-pair-a',
          providerId: 'fal',
          rawId: 'fal-ai/pair/a',
          activity: 'chat',
          providerMetadata: { category: 'paired-image' },
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
        {
          id: 'fal-pair-b',
          providerId: 'fal',
          rawId: 'fal-ai/pair/b',
          activity: 'chat',
          providerMetadata: { category: 'paired-image' },
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
        {
          id: 'fal-pair-no-input',
          providerId: 'fal',
          rawId: 'fal-ai/pair/no-input',
          activity: 'chat',
          providerMetadata: { category: 'paired-image' },
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
      ])
      .onConflictDoNothing()
    await db
      .insert(schemaVersions)
      .values([
        {
          id: 'fal/fal-ai/pair/a:input',
          endpointId: 'fal/fal-ai/pair/a',
          kind: 'input',
          contentHash: `a1${'1'.repeat(62)}`,
          schema: JSON.stringify({
            type: 'object',
            properties: { prompt: { const: 'a' } },
          }),
          createdAt: NOW,
        },
        {
          id: 'fal/fal-ai/pair/a:output',
          endpointId: 'fal/fal-ai/pair/a',
          kind: 'output',
          contentHash: `a2${'2'.repeat(62)}`,
          schema: JSON.stringify({
            type: 'object',
            properties: { image: { const: 'a' } },
          }),
          createdAt: NOW,
        },
        {
          id: 'fal/fal-ai/pair/b:input',
          endpointId: 'fal/fal-ai/pair/b',
          kind: 'input',
          contentHash: `b1${'3'.repeat(62)}`,
          schema: JSON.stringify({
            type: 'object',
            properties: { prompt: { const: 'b' } },
          }),
          createdAt: NOW,
        },
        {
          id: 'fal/fal-ai/pair/b:output',
          endpointId: 'fal/fal-ai/pair/b',
          kind: 'output',
          contentHash: `b2${'4'.repeat(62)}`,
          schema: JSON.stringify({
            type: 'object',
            properties: { image: { const: 'b' } },
          }),
          createdAt: NOW,
        },
      ])
      .onConflictDoNothing()

    const result = await assembleProviderOpenApi(db, 'fal', {
      activity: 'chat',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const post = (
      result.document.paths as Record<
        string,
        {
          post?: {
            parameters?: Array<{ schema?: { enum?: Array<string> } }>
            requestBody?: {
              content: {
                'application/json': {
                  schema: { anyOf?: Array<{ $ref: string }> }
                }
              }
            }
          }
          get?: {
            responses?: {
              '200'?: {
                content?: {
                  'application/json': {
                    schema: { anyOf?: Array<{ $ref: string }> }
                  }
                }
              }
            }
          }
        }
      >
    )['/{endpoint_id}']?.post
    const get = (
      result.document.paths as Record<
        string,
        {
          get?: {
            parameters?: Array<{ schema?: { enum?: Array<string> } }>
            responses?: {
              '200'?: {
                content?: {
                  'application/json': {
                    schema: { anyOf?: Array<{ $ref: string }> }
                  }
                }
              }
            }
          }
        }
      >
    )['/{endpoint_id}/requests/{request_id}']?.get
    expect(post?.parameters?.[0]?.schema?.enum).toEqual([
      'fal-ai/pair/a',
      'fal-ai/pair/b',
    ])
    expect(get?.parameters?.[0]?.schema?.enum).toEqual([
      'fal-ai/pair/a',
      'fal-ai/pair/b',
    ])
    expect(post?.requestBody?.content['application/json'].schema.anyOf).toEqual(
      [
        { $ref: '#/components/schemas/input_fal-ai_pair_a' },
        { $ref: '#/components/schemas/input_fal-ai_pair_b' },
      ],
    )
    expect(
      get?.responses?.['200']?.content?.['application/json'].schema.anyOf,
    ).toEqual([
      { $ref: '#/components/schemas/output_fal-ai_pair_a' },
      { $ref: '#/components/schemas/output_fal-ai_pair_b' },
    ])
    const schemas = (
      result.document.components as {
        schemas: Record<string, { 'x-modelschemas-model'?: string }>
      }
    ).schemas
    expect(schemas['input_fal-ai_pair_a']?.['x-modelschemas-model']).toBe(
      'fal-ai/pair/a',
    )
    expect(schemas['output_fal-ai_pair_b']?.['x-modelschemas-model']).toBe(
      'fal-ai/pair/b',
    )
    expect(schemas['input_fal-ai_pair_no-input']).toBeUndefined()
  })

  it('serves an activity larger than the 40-endpoint cap as one queue document', async () => {
    const count = 41
    const endpointRows = Array.from({ length: count }, (_, i) => ({
      id: `fal/bulk/m${String(i)}`,
      providerId: 'fal',
      activity: 'audio' as const,
      method: 'POST',
      path: `/bulk/m${String(i)}`,
    }))
    const modelRows = Array.from({ length: count }, (_, i) => ({
      id: `fal-bulk-m${String(i)}`,
      providerId: 'fal',
      rawId: `bulk/m${String(i)}`,
      activity: 'audio' as const,
      providerMetadata: { category: 'bulk-image' },
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    }))
    const schemaRows = Array.from({ length: count }, (_, i) => ({
      id: `fal/bulk/m${String(i)}:input`,
      endpointId: `fal/bulk/m${String(i)}`,
      kind: 'input' as const,
      contentHash: `${String(i).padStart(2, '0')}${'f'.repeat(62)}`,
      schema: JSON.stringify({
        type: 'object',
        properties: { n: { const: i } },
      }),
      createdAt: NOW,
    }))
    for (let i = 0; i < count; i += 10) {
      await db
        .insert(endpoints)
        .values(endpointRows.slice(i, i + 10))
        .onConflictDoNothing()
      await db
        .insert(models)
        .values(modelRows.slice(i, i + 10))
        .onConflictDoNothing()
      await db
        .insert(schemaVersions)
        .values(schemaRows.slice(i, i + 10))
        .onConflictDoNothing()
    }
    const result = await assembleProviderOpenApi(db, 'fal', {
      activity: 'audio',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const paths = result.document.paths as Record<string, unknown>
    expect(Object.keys(paths).sort()).toEqual([
      '/{endpoint_id}',
      '/{endpoint_id}/requests/{request_id}',
    ])
    const post = (
      paths['/{endpoint_id}'] as {
        post: {
          parameters: Array<{ schema?: { enum?: Array<string> } }>
          requestBody: {
            content: {
              'application/json': { schema: { anyOf: Array<unknown> } }
            }
          }
        }
      }
    ).post
    expect(post.parameters[0]?.schema?.enum).toHaveLength(count)
    expect(
      post.requestBody.content['application/json'].schema.anyOf,
    ).toHaveLength(count)
  })

  it('refuses empty paths instead of returning 200', async () => {
    expect(
      await assembleProviderOpenApi(db, 'anthropic', { activity: 'video' }),
    ).toMatchObject({
      ok: false,
      status: 400,
      code: 'spec_requires_selector',
    })

    await db
      .insert(providers)
      .values({
        id: 'grok',
        displayName: 'xAI Grok',
        specSourceUrl: 'https://example.com/g.json',
      })
      .onConflictDoNothing()
    expect(await assembleProviderOpenApi(db, 'grok')).toMatchObject({
      ok: false,
      status: 404,
      code: 'no_endpoints',
    })
  })

  it('does not assemble adapters that have no declared connect profile', async () => {
    await db
      .insert(providers)
      .values({
        id: 'voyage',
        displayName: 'Voyage',
        specSourceUrl: 'https://example.com/v.json',
      })
      .onConflictDoNothing()
    await db
      .insert(endpoints)
      .values({
        id: 'voyage/embeddings',
        providerId: 'voyage',
        activity: 'embeddings',
        method: 'POST',
        path: '/embeddings',
      })
      .onConflictDoNothing()
    expect(await assembleProviderOpenApi(db, 'voyage')).toMatchObject({
      ok: false,
      status: 500,
      code: 'missing_connect',
    })
  })

  it('splits BytePlus Ark and Seed Speech onto their own connect profiles', async () => {
    await db
      .insert(providers)
      .values({
        id: 'byteplus',
        displayName: 'BytePlus',
        specSourceUrl: 'https://example.com/b.json',
      })
      .onConflictDoNothing()
    await db
      .insert(endpoints)
      .values([
        {
          id: 'byteplus/chat/completions',
          providerId: 'byteplus',
          activity: 'chat',
          method: 'POST',
          path: '/chat/completions',
        },
        {
          id: 'byteplus/tts/create',
          providerId: 'byteplus',
          activity: 'audio',
          method: 'POST',
          path: '/tts/create',
        },
      ])
      .onConflictDoNothing()
    const combined = await assembleProviderOpenApi(db, 'byteplus')
    expect(combined.ok).toBe(true)
    if (!combined.ok) return
    const combinedPaths = combined.document.paths as Record<string, unknown>
    expect(combinedPaths['/chat/completions']).toBeDefined()
    expect(combinedPaths['/tts/create']).toBeUndefined()
    expect((combined.document.servers as Array<{ url: string }>)[0]?.url).toBe(
      'https://ark.ap-southeast.bytepluses.com/api/v3',
    )

    const audio = await assembleProviderOpenApi(db, 'byteplus', {
      activity: 'audio',
    })
    expect(audio.ok).toBe(true)
    if (!audio.ok) return
    const audioPaths = audio.document.paths as Record<string, unknown>
    expect(audioPaths['/tts/create']).toBeDefined()
    expect(audioPaths['/chat/completions']).toBeUndefined()
    expect((audio.document.servers as Array<{ url: string }>)[0]?.url).toBe(
      'https://voice.ap-southeast-1.bytepluses.com/api/v3',
    )
  })

  it('assembles a provider-grained document past 40 paths (#560)', async () => {
    await db
      .insert(providers)
      .values({
        id: 'openai',
        displayName: 'OpenAI',
        specSourceUrl: 'https://example.com/o.json',
      })
      .onConflictDoNothing()
    const rows = Array.from({ length: 41 }, (_, i) => ({
      id: `openai/e${String(i)}`,
      providerId: 'openai',
      activity: 'chat' as const,
      method: 'POST',
      path: `/e${String(i)}`,
    }))
    for (let i = 0; i < rows.length; i += 10) {
      await db
        .insert(endpoints)
        .values(rows.slice(i, i + 10))
        .onConflictDoNothing()
    }
    const result = await assembleProviderOpenApi(db, 'openai', {
      activity: 'chat',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.document.paths as object)).toHaveLength(41)
  })

  it('serves JSON and SSE on one operation and every $ref resolves (#578)', async () => {
    await db
      .insert(providers)
      .values({
        id: 'openai',
        displayName: 'OpenAI',
        specSourceUrl: 'https://example.com/o.json',
      })
      .onConflictDoNothing()
    const both = ['application/json', 'text/event-stream']
    await db
      .insert(endpoints)
      .values([
        {
          id: 'openai/images/generations',
          providerId: 'openai',
          activity: 'image',
          method: 'POST',
          path: '/images/generations',
          responseContentTypes: both,
        },
        {
          id: 'openai/images/edits',
          providerId: 'openai',
          activity: 'image',
          method: 'POST',
          path: '/images/edits',
          requestContentType: 'multipart/form-data',
          responseContentTypes: both,
        },
      ])
      .onConflictDoNothing()
    const withDefs = (defs: Record<string, unknown>) =>
      JSON.stringify({
        type: 'object',
        properties: {
          size: { $ref: '#/$defs/ImageSize' },
          usage: { $ref: '#/$defs/Usage' },
        },
        $defs: defs,
      })
    const usage = {
      type: 'object',
      properties: { tokens: { $ref: '#/$defs/Count' } },
    }
    const version = (
      id: string,
      kind: 'input' | 'output' | 'stream',
      schema: string,
    ) => ({
      id: `${id}:${kind}`,
      endpointId: id,
      kind,
      contentHash: `${id}:${kind}`.padEnd(64, '0'),
      schema,
      createdAt: NOW,
    })
    await db
      .insert(schemaVersions)
      .values([
        version(
          'openai/images/generations',
          'input',
          withDefs({
            ImageSize: { enum: ['1024x1024'] },
            Usage: usage,
            Count: { type: 'integer' },
          }),
        ),
        version(
          'openai/images/generations',
          'output',
          withDefs({
            ImageSize: { enum: ['1024x1024'] },
            Usage: usage,
            Count: { type: 'integer' },
          }),
        ),
        version(
          'openai/images/generations',
          'stream',
          JSON.stringify({
            oneOf: [{ $ref: '#/$defs/PartialImage' }],
            $defs: { PartialImage: { type: 'object' } },
          }),
        ),
        // Same names, different content: must not silently share one.
        version(
          'openai/images/edits',
          'input',
          withDefs({
            ImageSize: { enum: ['256x256'] },
            Usage: usage,
            Count: { type: 'number' },
          }),
        ),
        version(
          'openai/images/edits',
          'output',
          withDefs({
            ImageSize: { enum: ['1024x1024'] },
            Usage: usage,
            Count: { type: 'integer' },
          }),
        ),
      ])
      .onConflictDoNothing()

    const result = await assembleProviderOpenApi(db, 'openai', {
      activity: 'image',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const document = result.document
    const paths = document.paths as Record<string, Record<string, unknown>>
    expect(Object.keys(paths).sort()).toEqual([
      '/images/edits',
      '/images/generations',
    ])
    expect(unresolvedRefs(document)).toEqual([])
    expect(JSON.stringify(document)).not.toContain('$defs')

    const ok = (path: string) =>
      (
        paths[path]!.post as {
          responses: { '200': { content: Record<string, { schema: unknown }> } }
        }
      ).responses['200'].content
    expect(Object.keys(ok('/images/generations'))).toEqual(both)
    expect(ok('/images/generations')['text/event-stream']?.schema).toEqual({
      oneOf: [{ $ref: '#/components/schemas/PartialImage' }],
    })
    const schemas = (
      document.components as { schemas: Record<string, unknown> }
    ).schemas
    const sizeOf = (path: string, media: string) => {
      const post = paths[path]!.post as {
        requestBody: {
          content: Record<
            string,
            { schema: { properties: Record<string, { $ref: string }> } }
          >
        }
      }
      const ref = post.requestBody.content[media]?.schema.properties.size?.$ref
      return schemas[ref?.split('/').pop() ?? '']
    }
    // Same def name, different content: each operation keeps its own.
    expect(sizeOf('/images/edits', 'multipart/form-data')).toEqual({
      enum: ['256x256'],
    })
    expect(sizeOf('/images/generations', 'application/json')).toEqual({
      enum: ['1024x1024'],
    })
    // Identical defs share one component: two ImageSize, two Count, one Usage
    // per distinct Count, one PartialImage.
    expect(Object.keys(schemas).sort()).toHaveLength(7)
  })

  it('merges an upstream #stream path key into its base operation', async () => {
    // Mistral's own spec: the base requires stream: false, the twin true.
    const transcriptionRequest = (stream: boolean) =>
      JSON.stringify({
        type: 'object',
        required: ['file'],
        properties: {
          file: { $ref: '#/$defs/File' },
          stream: { type: 'boolean', const: stream, default: stream },
        },
        $defs: { File: { type: 'string', format: 'binary' } },
      })
    await db
      .insert(providers)
      .values({
        id: 'mistral',
        displayName: 'Mistral',
        specSourceUrl: 'https://example.com/m.json',
      })
      .onConflictDoNothing()
    await db
      .insert(endpoints)
      .values([
        {
          id: 'mistral/v1/audio/transcriptions',
          providerId: 'mistral',
          activity: 'audio',
          method: 'POST',
          path: '/v1/audio/transcriptions',
          requestContentType: 'multipart/form-data',
        },
        {
          id: 'mistral/v1/audio/transcriptions#stream',
          providerId: 'mistral',
          activity: 'audio',
          method: 'POST',
          path: '/v1/audio/transcriptions#stream',
          requestContentType: 'multipart/form-data',
          responseContentTypes: ['text/event-stream'],
        },
      ])
      .onConflictDoNothing()
    await db
      .insert(schemaVersions)
      .values([
        {
          id: 'mistral/v1/audio/transcriptions:input',
          endpointId: 'mistral/v1/audio/transcriptions',
          kind: 'input',
          contentHash: 'o'.repeat(64),
          schema: transcriptionRequest(false),
          createdAt: NOW,
        },
        {
          id: 'mistral/v1/audio/transcriptions#stream:input',
          endpointId: 'mistral/v1/audio/transcriptions#stream',
          kind: 'input',
          contentHash: 'p'.repeat(64),
          schema: transcriptionRequest(true),
          createdAt: NOW,
        },
        {
          id: 'mistral/v1/audio/transcriptions:output',
          endpointId: 'mistral/v1/audio/transcriptions',
          kind: 'output',
          contentHash: 'm'.repeat(64),
          schema: JSON.stringify(OUTPUT),
          createdAt: NOW,
        },
        {
          id: 'mistral/v1/audio/transcriptions#stream:output',
          endpointId: 'mistral/v1/audio/transcriptions#stream',
          kind: 'output',
          contentHash: 'n'.repeat(64),
          schema: JSON.stringify({
            type: 'object',
            properties: { delta: { type: 'string' } },
          }),
          createdAt: NOW,
        },
      ])
      .onConflictDoNothing()
    const result = await assembleProviderOpenApi(db, 'mistral')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const paths = result.document.paths as Record<
      string,
      Record<string, unknown>
    >
    expect(Object.keys(paths)).toEqual(['/v1/audio/transcriptions'])
    const content = (
      paths['/v1/audio/transcriptions']!.post as {
        responses: { '200': { content: Record<string, unknown> } }
      }
    ).responses['200'].content
    expect(Object.keys(content).sort()).toEqual([
      'application/json',
      'text/event-stream',
    ])
    expect(unresolvedRefs(result.document)).toEqual([])
    const request = (
      paths['/v1/audio/transcriptions']!.post as {
        requestBody: { content: Record<string, { schema: unknown }> }
      }
    ).requestBody.content['multipart/form-data']?.schema
    const file = { $ref: '#/components/schemas/File' }
    const variant = (stream: boolean) => ({
      type: 'object',
      required: ['file'],
      properties: {
        file,
        stream: { type: 'boolean', const: stream, default: stream },
      },
    })
    expect(request).toEqual({ anyOf: [variant(false), variant(true)] })
  })

  it('refuses twins that list one media type with different schemas', async () => {
    await db
      .insert(providers)
      .values({
        id: 'perplexity',
        displayName: 'Perplexity',
        specSourceUrl: 'https://example.com/p.json',
      })
      .onConflictDoNothing()
    const both = ['application/json']
    await db
      .insert(endpoints)
      .values([
        {
          id: 'perplexity/v1/agent',
          providerId: 'perplexity',
          activity: 'chat',
          method: 'POST',
          path: '/v1/agent',
          responseContentTypes: both,
        },
        {
          id: 'perplexity/v1/agent#stream',
          providerId: 'perplexity',
          activity: 'chat',
          method: 'POST',
          path: '/v1/agent#stream',
          responseContentTypes: both,
        },
      ])
      .onConflictDoNothing()
    await db
      .insert(schemaVersions)
      .values([
        {
          id: 'perplexity/v1/agent:output',
          endpointId: 'perplexity/v1/agent',
          kind: 'output',
          contentHash: 'q'.repeat(64),
          schema: JSON.stringify({ type: 'object' }),
          createdAt: NOW,
        },
        {
          id: 'perplexity/v1/agent#stream:output',
          endpointId: 'perplexity/v1/agent#stream',
          kind: 'output',
          contentHash: 'r'.repeat(64),
          schema: JSON.stringify({ type: 'string' }),
          createdAt: NOW,
        },
      ])
      .onConflictDoNothing()
    const result = await assembleProviderOpenApi(db, 'perplexity')
    expect(result).toMatchObject({
      ok: false,
      status: 500,
      code: 'schema_conflict',
    })
    if (!result.ok) expect(result.message).toContain('POST /v1/agent')
  })

  it('refuses a document whose stored schema has a dangling $ref', async () => {
    await db
      .insert(providers)
      .values({
        id: 'together',
        displayName: 'Together',
        specSourceUrl: 'https://example.com/t.json',
      })
      .onConflictDoNothing()
    await db
      .insert(endpoints)
      .values({
        id: 'together/v1/completions',
        providerId: 'together',
        activity: 'chat',
        method: 'POST',
        path: '/v1/completions',
      })
      .onConflictDoNothing()
    await db
      .insert(schemaVersions)
      .values({
        id: 'together/v1/completions:input',
        endpointId: 'together/v1/completions',
        kind: 'input',
        contentHash: 's'.repeat(64),
        schema: JSON.stringify({
          type: 'object',
          properties: { event: { $ref: '#/$defs/Missing' } },
          $defs: { Other: { type: 'string' } },
        }),
        createdAt: NOW,
      })
      .onConflictDoNothing()
    const result = await assembleProviderOpenApi(db, 'together')
    expect(result).toMatchObject({
      ok: false,
      status: 500,
      code: 'unresolved_refs',
    })
    if (!result.ok) {
      expect(result.message).toContain(
        '#/$defs/Missing at #/paths/~1v1~1completions/post',
      )
    }
  })

  it('refuses OpenAPI assembly for AsyncAPI-flagged FAL models', async () => {
    await db
      .insert(models)
      .values({
        id: 'fal-minimax-h3-max-director',
        providerId: 'fal',
        rawId: 'minimax/h3-max/director',
        activity: 'video',
        capabilities: { asyncapi: true },
        providerMetadata: { category: 'text-to-video' },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      })
      .onConflictDoNothing()
    await db
      .insert(endpoints)
      .values({
        id: 'fal/minimax/h3-max/director',
        providerId: 'fal',
        activity: 'video',
        method: 'POST',
        path: '/minimax/h3-max/director',
      })
      .onConflictDoNothing()
    await db
      .insert(schemaVersions)
      .values({
        id: 'fal/minimax/h3-max/director:input',
        endpointId: 'fal/minimax/h3-max/director',
        kind: 'input',
        contentHash: 'aa'.repeat(32),
        schema: JSON.stringify({
          oneOf: [
            { type: 'object', properties: { type: { const: 'configure' } } },
          ],
        }),
        createdAt: NOW,
      })
      .onConflictDoNothing()

    const result = await assembleProviderOpenApi(db, 'fal', {
      model: 'minimax/h3-max/director',
    })
    expect(result).toMatchObject({
      ok: false,
      status: 404,
      code: 'unknown_model',
    })
    if (!result.ok) expect(result.message).toContain('AsyncAPI')

    const byActivity = await assembleProviderOpenApi(db, 'fal', {
      activity: 'video',
    })
    expect(byActivity.ok).toBe(true)
    if (!byActivity.ok) return
    const videoEnum = (
      byActivity.document.paths as Record<
        string,
        {
          post?: {
            parameters?: Array<{ schema?: { enum?: Array<string> } }>
          }
        }
      >
    )['/{endpoint_id}']?.post?.parameters?.[0]?.schema?.enum
    expect(videoEnum).toEqual(['fal-ai/veo3.1'])
    expect(videoEnum).not.toContain('minimax/h3-max/director')

    await db
      .insert(models)
      .values({
        id: 'fal-async-only',
        providerId: 'fal',
        rawId: 'fal-ai/async-only',
        activity: 'moderation',
        capabilities: { asyncapi: true },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      })
      .onConflictDoNothing()
    const onlyAsync = await assembleProviderOpenApi(db, 'fal', {
      activity: 'moderation',
    })
    expect(onlyAsync).toMatchObject({
      ok: false,
      status: 400,
      code: 'spec_requires_selector',
    })
    if (!onlyAsync.ok) expect(onlyAsync.message).toContain('AsyncAPI')
  })

  it('serves Reactor per activity with one component pair per endpoint (#618)', async () => {
    await db
      .insert(providers)
      .values({
        id: 'reactor',
        displayName: 'Reactor',
        specSourceUrl: 'https://example.com/r',
      })
      .onConflictDoNothing()
    await db
      .insert(models)
      .values(
        ['reactor/helios', 'reactor/lingbot', 'reactor/lingbot-world-2'].map(
          (rawId) => ({
            id: rawId.replace('/', '-'),
            providerId: 'reactor',
            rawId,
            activity: 'video' as const,
            firstSeenAt: NOW,
            lastSeenAt: NOW,
          }),
        ),
      )
      .onConflictDoNothing()
    const paths = [
      '/reactor/helios',
      '/reactor/helios/events/set_prompt',
      '/reactor/lingbot-world-2/events/pause',
    ]
    await db
      .insert(endpoints)
      .values(
        paths.map((path) => ({
          id: `reactor${path}`,
          providerId: 'reactor',
          activity: 'video' as const,
          method: 'POST',
          path,
        })),
      )
      .onConflictDoNothing()
    await db
      .insert(schemaVersions)
      .values(
        paths.flatMap((path, i) =>
          (['input', 'output'] as const).map((kind, k) => ({
            id: `reactor${path}:${kind}`,
            endpointId: `reactor${path}`,
            kind,
            contentHash: String(i * 2 + k).repeat(64),
            schema: JSON.stringify({
              type: 'object',
              properties: { [kind]: { type: 'string' } },
            }),
            createdAt: NOW,
          })),
        ),
      )
      .onConflictDoNothing()

    for (const query of [{ activity: 'video' }, {}]) {
      const result = await assembleProviderOpenApi(db, 'reactor', query)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const doc = result.document as {
        paths: Record<string, unknown>
        components: { schemas: Record<string, Record<string, unknown>> }
      }
      expect(Object.keys(doc.paths)).toEqual(['/tokens'])
      for (const path of paths) expect(doc.paths[path]).toBeUndefined()
      const tokens = doc.paths['/tokens'] as {
        post?: {
          operationId?: string
          parameters?: Array<{ name?: string; in?: string; required?: boolean }>
          requestBody?: {
            content?: {
              'application/json'?: {
                schema?: { required?: Array<string> }
              }
            }
          }
          responses?: {
            '200'?: {
              content?: {
                'application/json'?: {
                  schema?: { required?: Array<string> }
                }
              }
            }
          }
        }
      }
      expect(tokens.post?.operationId).toBe('createSessionToken')
      expect(tokens.post?.parameters).toEqual([
        expect.objectContaining({
          name: 'Reactor-API-Key',
          in: 'header',
          required: true,
        }),
      ])
      expect(
        tokens.post?.requestBody?.content?.['application/json']?.schema
          ?.required,
      ).toEqual(['authorization_details'])
      expect(
        tokens.post?.responses?.['200']?.content?.['application/json']?.schema
          ?.required,
      ).toEqual(['jwt', 'expires_at'])
      const schemas = doc.components.schemas
      expect(schemas['input_reactor_helios_events_set_prompt']).toMatchObject({
        'x-modelschemas-model': 'reactor/helios',
        'x-modelschemas-transport': 'realtime',
      })
      expect(
        schemas['output_reactor_lingbot-world-2_events_pause'],
      ).toMatchObject({
        'x-modelschemas-model': 'reactor/lingbot-world-2',
        'x-modelschemas-transport': 'realtime',
      })
      expect(
        Object.keys(schemas).filter((key) => /^(input|output)_/.test(key)),
      ).toHaveLength(paths.length * 2)
      expect(
        (result.document as { info?: { description?: string } }).info
          ?.description,
      ).toContain('x-modelschemas-transport: realtime')
      expect(unresolvedRefs(result.document)).toEqual([])
    }

    const pinned = await assembleProviderOpenApi(db, 'reactor', {
      model: 'reactor/helios',
    })
    expect(pinned.ok).toBe(true)
    if (!pinned.ok) return
    const pinnedDoc = pinned.document as {
      paths: Record<string, { post?: { requestBody?: unknown } }>
      components: { schemas: Record<string, unknown> }
    }
    expect(Object.keys(pinnedDoc.paths)).toEqual(['/tokens'])
    expect(JSON.stringify(pinnedDoc.paths['/tokens'])).toContain(
      '"enum":["reactor/helios"]',
    )
    expect(
      pinnedDoc.components.schemas['input_reactor_helios_events_set_prompt'],
    ).toBeDefined()
    expect(
      pinnedDoc.components.schemas[
        'input_reactor_lingbot-world-2_events_pause'
      ],
    ).toBeUndefined()

    await db
      .insert(endpoints)
      .values({
        id: 'reactor/orphan',
        providerId: 'reactor',
        activity: 'video',
        method: 'POST',
        path: '/orphan',
      })
      .onConflictDoNothing()
    expect(
      await assembleProviderOpenApi(db, 'reactor', { activity: 'video' }),
    ).toMatchObject({ ok: false, code: 'spec_requires_selector' })
  })

  it('404s unknown provider and unknown model', async () => {
    expect(await assembleProviderOpenApi(db, 'nope')).toMatchObject({
      ok: false,
      status: 404,
      code: 'unknown_provider',
    })
    expect(
      await assembleProviderOpenApi(db, 'fal', { model: 'missing' }),
    ).toMatchObject({ ok: false, status: 404, code: 'unknown_model' })
  })
})

describe('openModelNames', () => {
  it('leaves Ollaya model an open string although laya rows are listed', async () => {
    await db
      .insert(providers)
      .values({
        id: 'ollaya',
        displayName: 'Ollaya',
        specSourceUrl: 'https://example.com/o.md',
      })
      .onConflictDoNothing()
    await db
      .insert(endpoints)
      .values({
        id: 'ollaya/v1/systemone',
        providerId: 'ollaya',
        activity: 'decision',
        method: 'POST',
        path: '/v1/systemone',
      })
      .onConflictDoNothing()
    await db
      .insert(schemaVersions)
      .values({
        id: 'ollaya/v1/systemone:input',
        endpointId: 'ollaya/v1/systemone',
        kind: 'input',
        contentHash: 'c'.repeat(64),
        schema: JSON.stringify(INPUT),
        createdAt: NOW,
      })
      .onConflictDoNothing()
    await db
      .insert(models)
      .values({
        id: 'ollaya-laya-en',
        providerId: 'ollaya',
        rawId: 'laya:en',
        activity: 'decision',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      })
      .onConflictDoNothing()
    const result = await assembleProviderOpenApi(db, 'ollaya')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const paths = result.document.paths as Record<
      string,
      {
        post?: {
          requestBody?: {
            content: {
              'application/json': {
                schema: { properties?: { model?: { enum?: unknown } } }
              }
            }
          }
        }
      }
    >
    const schema =
      paths['/v1/systemone']?.post?.requestBody?.content['application/json']
        .schema
    expect(schema?.properties?.model).toBeDefined()
    expect(schema?.properties?.model?.enum).toBeUndefined()
  })

  it('serves TypeSafe POST /v1/systemone with model left open', async () => {
    await db
      .insert(providers)
      .values({
        id: 'typesafe',
        displayName: 'TypeSafe',
        specSourceUrl: 'https://api.typesafe.ai/openapi.json',
      })
      .onConflictDoNothing()
    await db
      .insert(endpoints)
      .values({
        id: 'typesafe/v1/systemone',
        providerId: 'typesafe',
        activity: 'decision',
        method: 'POST',
        path: '/v1/systemone',
      })
      .onConflictDoNothing()
    await db
      .insert(schemaVersions)
      .values([
        {
          id: 'typesafe/v1/systemone:input',
          endpointId: 'typesafe/v1/systemone',
          kind: 'input',
          contentHash: 'd'.repeat(64),
          schema: JSON.stringify(INPUT),
          createdAt: NOW,
        },
        {
          id: 'typesafe/v1/systemone:output',
          endpointId: 'typesafe/v1/systemone',
          kind: 'output',
          contentHash: 'e'.repeat(64),
          schema: JSON.stringify(OUTPUT),
          createdAt: NOW,
        },
      ])
      .onConflictDoNothing()
    await db
      .insert(models)
      .values({
        id: 'typesafe-jev-1-14-0',
        providerId: 'typesafe',
        rawId: 'jev-1.14.0',
        activity: 'decision',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      })
      .onConflictDoNothing()
    const result = await assembleProviderOpenApi(db, 'typesafe')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const paths = result.document.paths as Record<
      string,
      {
        post?: {
          requestBody?: {
            content: {
              'application/json': {
                schema: { properties?: { model?: { enum?: unknown } } }
              }
            }
          }
        }
      }
    >
    const post = paths['/v1/systemone']?.post
    expect(post).toBeDefined()
    expect(
      post?.requestBody?.content['application/json'].schema?.properties?.model
        ?.enum,
    ).toBeUndefined()
  })
})

describe('modelHeader', () => {
  it('heads each Fish Audio route with the ids bound to it or its parent', async () => {
    await db
      .insert(providers)
      .values({
        id: 'fish-audio',
        displayName: 'Fish Audio',
        specSourceUrl: 'https://example.com/fish.json',
      })
      .onConflictDoNothing()
    const paths = [
      '/v1/tts',
      '/v1/tts/stream/with-timestamp',
      '/v1/asr',
      '/model',
    ]
    await db
      .insert(endpoints)
      .values(
        paths.map((path) => ({
          id: `fish-audio${path}`,
          providerId: 'fish-audio',
          activity: 'audio' as const,
          method: 'POST',
          path,
        })),
      )
      .onConflictDoNothing()
    await db
      .insert(schemaVersions)
      .values(
        paths.map((path) => ({
          id: `fish-audio${path}:input`,
          endpointId: `fish-audio${path}`,
          kind: 'input' as const,
          contentHash: 'f'.repeat(64),
          schema: JSON.stringify(INPUT),
          createdAt: NOW,
        })),
      )
      .onConflictDoNothing()
    await db
      .insert(models)
      .values(
        [
          ['s2.1-pro', 'v1/tts'],
          ['drama-3', 'v1/tts'],
          ['transcribe-1-pro', 'v1/asr'],
          ['transcribe-stream-1', null],
        ].map(([rawId, route]) => ({
          id: `fish-audio-${rawId}`,
          providerId: 'fish-audio',
          rawId: rawId ?? '',
          activity: 'audio' as const,
          schemaEndpointId: route,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        })),
      )
      .onConflictDoNothing()

    const headers = async (model?: string) => {
      const result = await assembleProviderOpenApi(
        db,
        'fish-audio',
        model ? { model } : {},
      )
      if (!result.ok) throw new Error(result.message)
      const docPaths = result.document.paths as Record<
        string,
        { post?: { parameters?: Array<{ schema: { enum?: unknown } }> } }
      >
      return Object.fromEntries(
        paths.map((path) => [
          path,
          docPaths[path]?.post?.parameters?.map((p) => p.schema.enum) ?? [],
        ]),
      )
    }

    const tts = ['drama-3', 's2.1-pro']
    expect(await headers()).toEqual({
      '/v1/tts': [tts],
      '/v1/tts/stream/with-timestamp': [tts],
      '/v1/asr': [['transcribe-1-pro']],
      '/model': [],
    })
    expect(await headers('s2.1-pro')).toEqual({
      '/v1/tts': [['s2.1-pro']],
      '/v1/tts/stream/with-timestamp': [['s2.1-pro']],
      '/v1/asr': [],
      '/model': [],
    })
  })
})
