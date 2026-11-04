import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from '#/db/index.ts'
import type { Db } from '#/db/index.ts'
import { endpoints, models, providers, schemaVersions } from '#/db/schema.ts'
import { assembleProviderOpenApi } from './provider-openapi.ts'

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

  it('refuses a combined FAL spec and serves one model with sibling GET', async () => {
    const bare = await assembleProviderOpenApi(db, 'fal')
    expect(bare).toMatchObject({
      ok: false,
      status: 400,
      code: 'spec_requires_selector',
    })

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

    expect(
      await assembleProviderOpenApi(db, 'fal', { activity: 'image' }),
    ).toMatchObject({
      ok: false,
      status: 400,
      code: 'spec_requires_selector',
    })
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
    const result = await assembleProviderOpenApi(db, 'openai')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.document.paths as object)).toHaveLength(41)
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
