import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from '../db/index.ts'
import type { Db } from '../db/index.ts'
import { endpoints, models, providers, schemaVersions } from '../db/schema.ts'
import { serviceIndex } from '../routes/v1/index.ts'
import { listChanges } from './changes-api.ts'
import {
  getModelDetail,
  getProviderCatalog,
  listModelsCatalog,
  listProvidersCatalog,
} from './catalog.ts'
import type { HalLink } from './hal.ts'
import {
  getActivitySchemaMap,
  getEndpointSchema,
  getProviderSchemaIndex,
  getSystemSchemaIndex,
} from './schemas-api.ts'
import { getServiceStatus } from './status.ts'
import { assembleProviderOpenApi } from './provider-openapi.ts'
import { estimateCost } from './estimate.ts'
import type { EstimateRequestBody } from './estimate.ts'
import { validatePayload } from './validate.ts'
import type { ValidateRequestBody } from './validate.ts'
import { GPT_4O } from '../../packages/rate-card/src/fixtures/gpt-4o.ts'

let db: Db

const SCHEMA = JSON.stringify({
  type: 'object',
  required: ['model', 'max_tokens'],
  properties: {
    model: { type: 'string' },
    max_tokens: { type: 'integer' },
  },
})

beforeAll(async () => {
  db = getDb(env)
  // Seed the data the serviceIndex examples reference, so walking the
  // examples proves they are live URLs.
  await db.insert(providers).values({
    id: 'anthropic',
    displayName: 'Anthropic',
    specSourceUrl: 'https://example.com/spec.json',
  })
  const NOW = 1_781_150_000
  await db.insert(models).values({
    id: 'anthropic-claude-sonnet-4-5',
    providerId: 'anthropic',
    rawId: 'claude-sonnet-4-5',
    activity: 'chat',
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  })
  await db.insert(endpoints).values({
    id: 'anthropic/v1/messages',
    providerId: 'anthropic',
    path: '/v1/messages',
    method: 'POST',
    activity: 'chat',
  })
  await db.insert(schemaVersions).values({
    id: 'sv-hal-input',
    endpointId: 'anthropic/v1/messages',
    kind: 'input',
    contentHash: 'hash-hal-input',
    schema: SCHEMA,
    createdAt: NOW,
  })
  await db.insert(providers).values({
    id: 'openai',
    displayName: 'OpenAI',
    specSourceUrl: 'https://example.com/openai.json',
  })
  await db.insert(models).values({
    id: 'openai-gpt-4o',
    providerId: 'openai',
    rawId: 'gpt-4o',
    activity: 'chat',
    pricing: GPT_4O,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  })
})

/** Resolves a link the way the HTTP router would; throws on unknown paths
 * so a new link without a dispatcher entry fails the walk. */
async function resolve(target: string | Record<string, unknown>) {
  if (typeof target !== 'string') {
    if ('endpointId' in target) {
      const outcome = await validatePayload(
        db,
        target as unknown as ValidateRequestBody,
      )
      expect(outcome.ok).toBe(true)
      return
    }
    const outcome = await estimateCost(
      db,
      target as unknown as EstimateRequestBody,
    )
    expect(outcome.ok).toBe(true)
    return
  }
  if (!target.startsWith('/v1')) return // .well-known etc. — out of scope
  const url = new URL(target, 'https://walk.test')
  const segments = url.pathname.split('/').filter(Boolean).slice(1)
  const [head, ...rest] = segments
  switch (head) {
    case undefined:
      return // /v1 — the document under test
    case 'status':
      expect((await getServiceStatus(db)).providers.length).toBeGreaterThan(0)
      return
    case 'providers': {
      if (rest.length === 0) {
        expect(
          (await listProvidersCatalog(db)).providers.length,
        ).toBeGreaterThan(0)
        return
      }
      const [provider] = rest
      expect(await getProviderCatalog(db, provider ?? '')).not.toBeNull()
      return
    }
    case 'models': {
      if (rest.length === 0) {
        const activity = url.searchParams.get('activity')
        const result = await listModelsCatalog(db, {
          activity: activity === 'chat' ? 'chat' : undefined,
          q: url.searchParams.get('q') ?? undefined,
        })
        expect(result.count).toBeGreaterThan(0)
        return
      }
      const [provider, modelId] = rest
      expect(
        await getModelDetail(db, provider ?? '', modelId ?? ''),
      ).not.toBeNull()
      return
    }
    case 'schemas': {
      const [provider, activity, ...endpointParts] = rest
      if (!provider) {
        // /v1/schemas — the system-wide index.
        expect((await getSystemSchemaIndex(db)).count).toBeGreaterThan(0)
        return
      }
      if (!activity) {
        expect(
          (await getProviderSchemaIndex(db, provider)).count,
        ).toBeGreaterThan(0)
        return
      }
      if (endpointParts.length === 0) {
        expect(activity).toBe('chat')
        expect(
          (await getActivitySchemaMap(db, provider, 'chat')).count,
        ).toBeGreaterThan(0)
        return
      }
      const endpointId = decodeURIComponent(endpointParts.join('/'))
      const kind =
        url.searchParams.get('kind') === 'output' ? 'output' : 'input'
      expect(activity).toBe('chat')
      expect(
        await getEndpointSchema(db, provider, 'chat', endpointId, kind),
      ).not.toBeNull()
      return
    }
    case 'changes': {
      const outcome = await listChanges(db, {})
      expect(outcome.ok).toBe(true)
      return
    }
    case 'openapi': {
      const [provider] = rest
      const assembled = await assembleProviderOpenApi(db, provider ?? '', {
        model: url.searchParams.get('model') ?? undefined,
        activity: url.searchParams.get('activity') ?? undefined,
      })
      expect(assembled.ok).toBe(true)
      return
    }
    default:
      throw new Error(`no dispatcher for link target ${target}`)
  }
}

function assertHalShape(name: string, link: HalLink) {
  expect(link.href, name).toBeTruthy()
  expect(['GET', 'POST', 'DELETE'], name).toContain(link.method)
  expect(link.contentType, name).toBeTruthy()
  if (link.href.includes('{')) {
    expect(link.templated, `${name} must mark templated`).toBe(true)
    expect(link.example, `${name} template needs an example`).toBeDefined()
  }
}

describe('HAL self-description (task 11.1)', () => {
  it('walks every GET /v1 link to a live resource', async () => {
    for (const [name, link] of Object.entries(serviceIndex._links)) {
      assertHalShape(name, link)
      await resolve(link.example ?? link.href)
    }
  })

  it('walks every GET /v1/models link', async () => {
    const result = await listModelsCatalog(db, {})
    for (const [name, link] of Object.entries(result._links)) {
      assertHalShape(name, link)
      await resolve(link.example ?? link.href)
    }
    // Model rows carry HAL links too.
    const model = result.models[0]
    for (const [name, link] of Object.entries(model?._links ?? {})) {
      assertHalShape(name, link)
      await resolve(link.href)
    }
  })
})
