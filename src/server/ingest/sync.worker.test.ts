import { providerRegistry } from '../providers/index.ts'
import { assembleProviderOpenApi } from '../provider-openapi.ts'
import { pollProviderModels } from './poll-models.ts'
import { provider as gatewayProvider } from '../providers/adapters/cloudflare-ai-gateway.ts'
import { getActivitySchemaMap, getEndpointSchema } from '../schemas-api.ts'
import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'

import { getDb } from '../../db/index.ts'
import {
  changes,
  endpoints,
  providers,
  schemaVersions,
} from '../../db/schema.ts'

import type { OpenApiDocument, ProviderConfig } from '../providers/types.ts'
import { EXTRACTOR_VERSION } from './bundle.ts'
import { MODELS_DEV_API_URL } from './retire-models-dev.ts'
import { syncProvider } from './sync.ts'
import type { SyncDeps } from './sync.ts'

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })

function fixtureSpec(maxTokens: boolean): OpenApiDocument {
  return {
    openapi: '3.1.0',
    paths: {
      '/v1/messages': {
        post: {
          summary: 'Create a message',
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
      '/v1/admin/keys': {
        post: { requestBody: { content: {} }, responses: {} },
      },
    },
    components: {
      schemas: {
        CreateMessage: {
          type: 'object',
          properties: {
            model: { type: 'string' },
            ...(maxTokens ? { max_tokens: { type: 'integer' } } : {}),
          },
        },
        Message: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
  }
}

// D1 state persists across tests in the same isolate, so each test gets its
// own provider id and filters its queries by it.
const STUB_SOURCE = {
  url: 'https://example.com/spec.json',
  hash: 'stub-source-hash',
}

it('withdraws only explicitly rejected current sources after a successful native fetch', async () => {
  const id = 'sync-withdraw-borrowed'
  const deps = await freshDeps(id)
  const provider = stubProvider(id, fixtureSpec(false))
  await syncProvider(deps, provider)
  await expect(
    syncProvider(deps, {
      ...provider,
      fetchSpec: async () => {
        throw new Error('native docs failed')
      },
    }),
  ).rejects.toThrow('native docs failed')
  expect(
    await getEndpointSchema(deps.db, id, 'chat', 'v1/messages', 'input'),
  ).not.toBeNull()
  const otherId = 'sync-withdraw-other-provider'
  const otherDeps = await freshDeps(otherId)
  await syncProvider(otherDeps, stubProvider(otherId, fixtureSpec(false)))
  const result = await syncProvider(deps, {
    ...provider,
    fetchSpec: async () => ({
      specs: [],
      sources: [],
      outputStrategy: 'post-200',
      withdrawnSchemaSources: [STUB_SOURCE.url],
      skipped: 'own docs publish no schema',
    }),
  })
  expect(result.warnings).toContain(
    'Withdrew 2 schema versions from rejected former sources',
  )
  expect(
    await getEndpointSchema(deps.db, id, 'chat', 'v1/messages', 'input'),
  ).toBeNull()
  expect(
    await getEndpointSchema(deps.db, id, 'chat', 'v1/messages', 'output'),
  ).toBeNull()
  expect(
    await getEndpointSchema(deps.db, otherId, 'chat', 'v1/messages', 'input'),
  ).not.toBeNull()
  const history = await deps.db
    .select()
    .from(schemaVersions)
    .innerJoin(endpoints, eq(schemaVersions.endpointId, endpoints.id))
    .where(eq(endpoints.providerId, id))
  expect(history).toHaveLength(2)
  expect(
    history.every((row) => row.schema_versions.supersededAt !== null),
  ).toBe(true)
})

function stubProvider(id: string, spec: OpenApiDocument): ProviderConfig {
  return {
    id,
    displayName: 'Stub',
    defaultDerivation: 'upstream-spec',
    fetchSpec: () =>
      Promise.resolve({
        specs: [spec],
        sources: [STUB_SOURCE],
        outputStrategy: 'post-200' as const,
      }),
    listModels: () => Promise.resolve({ models: [] }),
    classify: (path) => (path === '/v1/messages' ? 'chat' : null),
  }
}

async function freshDeps(providerId: string): Promise<SyncDeps> {
  const db = getDb(env)
  await db.insert(providers).values({
    id: providerId,
    displayName: 'Stub',
    specSourceUrl: 'https://example.com/spec.json',
  })
  let tick = 1_781_150_000
  return { db, kv: env.SCHEMA_CACHE, secrets: {}, now: () => tick++ }
}

const providerChanges = (db: SyncDeps['db'], id: string) =>
  db.select().from(changes).where(eq(changes.providerId, id))
const providerEndpoints = (db: SyncDeps['db'], id: string) =>
  db.select().from(endpoints).where(eq(endpoints.providerId, id))

describe('syncProvider', () => {
  it('inserts on first run, no-ops on second, one schema.updated on mutation', async () => {
    const id = 'stub-main'
    const deps = await freshDeps(id)
    const db = deps.db

    // First run: endpoint + input/output versions inserted.
    const first = await syncProvider(deps, stubProvider(id, fixtureSpec(false)))
    expect(first.error).toBeUndefined()
    expect(first.endpointsSeen).toBe(1) // admin endpoint classified to null
    expect(first.versionsAdded).toBe(2)

    const endpointRows = await providerEndpoints(db, id)
    expect(endpointRows).toHaveLength(1)
    expect(endpointRows[0]?.id).toBe(`${id}/v1/messages`)
    expect(endpointRows[0]?.activity).toBe('chat')

    const firstChanges = await providerChanges(db, id)
    expect(firstChanges.map((c) => c.type).sort()).toEqual([
      'endpoint.added',
      'schema.added',
      'schema.added',
    ])

    const versions = await db
      .select()
      .from(schemaVersions)
      .where(eq(schemaVersions.endpointId, `${id}/v1/messages`))
    expect(versions).toHaveLength(2)
    const inputVersion = versions.find((v) => v.kind === 'input')
    expect(JSON.parse(inputVersion?.schema ?? 'null')).toEqual({
      type: 'object',
      properties: { model: { type: 'string' } },
    })
    // Provenance is recorded on every version.
    expect(inputVersion?.sourceUrl).toBe(STUB_SOURCE.url)
    expect(inputVersion?.sourceHash).toBe(STUB_SOURCE.hash)
    expect(inputVersion?.extractorVersion).toBe(EXTRACTOR_VERSION)
    // Derivation falls back to the provider default when an operation
    // carries no marker of its own.
    expect(inputVersion?.derivation).toBe('upstream-spec')
    expect(inputVersion?.verifiedAt).toBeNull()

    const providerRow = await db.query.providers.findFirst({
      where: eq(providers.id, id),
    })
    expect(providerRow?.lastSyncedAt).not.toBeNull()
    expect(providerRow?.status).toBe('active')

    // Second run with the identical spec: fully idempotent.
    const second = await syncProvider(
      deps,
      stubProvider(id, fixtureSpec(false)),
    )
    expect(second.versionsAdded).toBe(0)
    expect(second.changesWritten).toBe(0)
    expect(await providerChanges(db, id)).toHaveLength(3)

    // Mutated input schema: exactly one schema.updated change, old version
    // superseded, new one current.
    const third = await syncProvider(deps, stubProvider(id, fixtureSpec(true)))
    expect(third.versionsAdded).toBe(1)
    expect(third.changesWritten).toBe(1)

    const updated = (await providerChanges(db, id)).filter(
      (c) => c.type === 'schema.updated',
    )
    expect(updated).toHaveLength(1)
    expect(updated[0]?.subjectId).toBe(`${id}/v1/messages`)

    const inputVersions = (
      await db
        .select()
        .from(schemaVersions)
        .where(eq(schemaVersions.endpointId, `${id}/v1/messages`))
    ).filter((v) => v.kind === 'input')
    expect(inputVersions).toHaveLength(2)
    expect(inputVersions.filter((v) => v.supersededAt === null)).toHaveLength(1)
    const payload = updated[0]?.payload as { previousHash: string }
    expect(payload.previousHash).toBe(inputVersion?.contentHash)
  })

  it.each([
    ['endpoint.added', false],
    ['schema.added', false],
    ['schema.updated', true],
  ] as const)(
    'rolls back the write whose %s change failed, so the next run records it',
    async (type, mutate) => {
      const id = `stub-atomic-${type.replace('.', '-')}`
      const trigger = `fail_${id.replaceAll('-', '_')}`
      const deps = await freshDeps(id)
      const db = deps.db
      if (mutate) await syncProvider(deps, stubProvider(id, fixtureSpec(false)))

      // Fails only this change insert, as the D1 error on the grok sync did.
      await env.DB.prepare(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON changes
         WHEN NEW.provider_id = '${id}' AND NEW.type = '${type}'
         BEGIN SELECT RAISE(ABORT, 'injected'); END`,
      ).run()
      try {
        await expect(
          syncProvider(deps, stubProvider(id, fixtureSpec(mutate))),
        ).rejects.toThrow('injected')
      } finally {
        await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run()
      }

      // The next run still sees the change, so it is written exactly once.
      await syncProvider(deps, stubProvider(id, fixtureSpec(mutate)))
      const written = (await providerChanges(db, id)).filter(
        (c) => c.type === type,
      )
      expect(written).toHaveLength(type === 'schema.added' ? 2 : 1)
    },
  )

  it('revives the superseded version when upstream reverts to prior content', async () => {
    const id = 'stub-revert'
    const deps = await freshDeps(id)
    const db = deps.db

    // A → B → A: the third run re-derives version A's deterministic id.
    await syncProvider(deps, stubProvider(id, fixtureSpec(false)))
    const versionA = await db.query.schemaVersions.findFirst({
      where: and(
        eq(schemaVersions.endpointId, `${id}/v1/messages`),
        eq(schemaVersions.kind, 'input'),
      ),
    })
    await syncProvider(deps, stubProvider(id, fixtureSpec(true)))
    const revert = await syncProvider(
      deps,
      stubProvider(id, fixtureSpec(false)),
    )
    expect(revert.error).toBeUndefined()
    expect(revert.versionsAdded).toBe(1)
    expect(revert.changesWritten).toBe(1)

    const inputVersions = (
      await db
        .select()
        .from(schemaVersions)
        .where(eq(schemaVersions.endpointId, `${id}/v1/messages`))
    ).filter((v) => v.kind === 'input')
    // Still two distinct versions — A was revived, not duplicated.
    expect(inputVersions).toHaveLength(2)
    const current = inputVersions.filter((v) => v.supersededAt === null)
    expect(current).toHaveLength(1)
    expect(current[0]?.id).toBe(versionA?.id)
    expect(current[0]?.contentHash).toBe(versionA?.contentHash)

    // The revert is recorded as a regular schema.updated change.
    const updated = (await providerChanges(db, id)).filter(
      (c) => c.type === 'schema.updated',
    )
    expect(updated).toHaveLength(2)

    const providerRow = await db.query.providers.findFirst({
      where: eq(providers.id, id),
    })
    expect(providerRow?.status).toBe('active')
  })

  it('records endpoint.removed once when an endpoint vanishes from the spec', async () => {
    const id = 'stub-removal'
    const deps = await freshDeps(id)
    await syncProvider(deps, stubProvider(id, fixtureSpec(false)))

    const emptySpec: OpenApiDocument = {
      paths: {},
      components: { schemas: {} },
    }
    await syncProvider(deps, stubProvider(id, emptySpec))
    await syncProvider(deps, stubProvider(id, emptySpec)) // no duplicate change

    const removed = (await providerChanges(deps.db, id)).filter(
      (c) => c.type === 'endpoint.removed',
    )
    expect(removed).toHaveLength(1)
    // History rows survive removal.
    expect(await providerEndpoints(deps.db, id)).toHaveLength(1)
    expect(
      await deps.db
        .select()
        .from(schemaVersions)
        .where(eq(schemaVersions.endpointId, `${id}/v1/messages`)),
    ).toHaveLength(2)
  })

  it('reports skipped providers without touching the database', async () => {
    const id = 'stub-skipped'
    const deps = await freshDeps(id)
    const skippy: ProviderConfig = {
      ...stubProvider(id, fixtureSpec(false)),
      fetchSpec: () =>
        Promise.resolve({
          specs: [],
          sources: [],
          outputStrategy: 'post-200' as const,
          skipped: 'stub: STUB_KEY not set — skipped',
        }),
    }
    const outcome = await syncProvider(deps, skippy)
    expect(outcome.skipped).toContain('STUB_KEY')
    expect(await providerEndpoints(deps.db, id)).toHaveLength(0)
    const providerRow = await deps.db.query.providers.findFirst({
      where: eq(providers.id, id),
    })
    expect(providerRow?.lastSyncedAt).toBeNull()
  })

  it('restores active after a by-design skip and leaves a missing-key skip degraded', async () => {
    const id = 'stub-skip-recovers'
    const deps = await freshDeps(id)
    const syncedAt = 1_700_000_000
    await deps.db
      .update(providers)
      .set({ status: 'degraded', lastSyncedAt: syncedAt })
      .where(eq(providers.id, id))
    const skip = (skipped: string): ProviderConfig => ({
      ...stubProvider(id, fixtureSpec(false)),
      fetchSpec: () =>
        Promise.resolve({
          specs: [],
          sources: [STUB_SOURCE],
          outputStrategy: 'post-200' as const,
          skipped,
        }),
    })

    const recovered = await syncProvider(
      deps,
      skip('stub: docs publish no request schema — skipped'),
    )
    expect(recovered.skipped).toContain('no request schema')
    const restored = await deps.db.query.providers.findFirst({
      where: eq(providers.id, id),
    })
    expect(restored?.status).toBe('active')
    expect(restored?.lastSyncedAt).toBe(syncedAt)

    await deps.db
      .update(providers)
      .set({ status: 'degraded' })
      .where(eq(providers.id, id))
    const missed = await syncProvider(
      deps,
      skip('stub: STUB_KEY not set — skipped'),
    )
    expect(missed.skipped).toContain('STUB_KEY')
    const stillDegraded = await deps.db.query.providers.findFirst({
      where: eq(providers.id, id),
    })
    expect(stillDegraded?.status).toBe('degraded')
    expect(stillDegraded?.lastSyncedAt).toBe(syncedAt)
  })

  it('drops schema versions sourced from models.dev on a skipped sync', async () => {
    const id = 'stub-models-dev-schema'
    const deps = await freshDeps(id)
    await deps.db.insert(endpoints).values({
      id: `${id}/chat/completions`,
      providerId: id,
      activity: 'chat',
      method: 'POST',
      path: '/chat/completions',
    })
    await deps.db.insert(schemaVersions).values([
      {
        id: `${id}/chat/completions:dev`,
        endpointId: `${id}/chat/completions`,
        kind: 'input',
        contentHash: 'a'.repeat(64),
        schema: JSON.stringify({ type: 'object' }),
        sourceUrl: MODELS_DEV_API_URL,
        createdAt: 1,
      },
      {
        id: `${id}/chat/completions:docs`,
        endpointId: `${id}/chat/completions`,
        kind: 'output',
        contentHash: 'b'.repeat(64),
        schema: JSON.stringify({ type: 'object' }),
        sourceUrl: 'https://example.com/openapi.json',
        createdAt: 1,
      },
    ])
    const outcome = await syncProvider(deps, {
      ...stubProvider(id, fixtureSpec(false)),
      fetchSpec: () =>
        Promise.resolve({
          specs: [],
          sources: [],
          outputStrategy: 'post-200' as const,
          skipped: 'stub: no first-party spec — skipped',
        }),
    })
    expect(outcome.skipped).toContain('no first-party spec')
    const versions = await deps.db
      .select()
      .from(schemaVersions)
      .where(eq(schemaVersions.endpointId, `${id}/chat/completions`))
    expect(versions.map((row) => row.id)).toEqual([
      `${id}/chat/completions:docs`,
    ])
    expect(await providerEndpoints(deps.db, id)).toHaveLength(1)
  })
})

it('stores a verified schema-less route without manufacturing schema versions', async () => {
  const id = 'sync-native-route-only'
  const deps = await freshDeps(id)
  const provider = stubProvider(id, {
    paths: {
      '/v1/messages': {
        post: { 'x-modelschemas-route-only': true, responses: {} },
      },
    },
  })
  const outcome = await syncProvider(deps, provider)
  expect(outcome).toMatchObject({ endpointsSeen: 1, versionsAdded: 0 })
  expect(
    (await getActivitySchemaMap(deps.db, id, 'chat')).endpoints['v1/messages'],
  ).toEqual({ input: null, output: null })
  expect(await getEndpointSchema(deps.db, id, 'chat', 'v1/messages')).toBeNull()
  expect(
    await deps.db.select().from(endpoints).where(eq(endpoints.providerId, id)),
  ).toMatchObject([{ path: '/v1/messages', method: 'POST', activity: 'chat' }])
  expect(
    await deps.db
      .select()
      .from(schemaVersions)
      .where(eq(schemaVersions.endpointId, `${id}/v1/messages`)),
  ).toEqual([])
})

it('keeps per-model logical schema identities on one real multi-activity HTTP path', async () => {
  const id = 'sync-shared-native-run'
  const deps = await freshDeps(id)
  const path = '/accounts/{account_id}/ai/run'
  const provider: ProviderConfig = {
    ...stubProvider(id, {}),
    fetchSpec: async () => ({
      specs: [],
      sources: [],
      outputStrategy: 'post-200',
      bundledEndpoints: [
        {
          publicId: 'author/chat',
          path,
          activity: 'chat',
          description: null,
          source: STUB_SOURCE,
          derivation: 'generated',
          input: {
            type: 'object',
            properties: { model: { const: 'author/chat' } },
          },
        },
        {
          publicId: 'author/image',
          path,
          activity: 'image',
          description: null,
          source: STUB_SOURCE,
          derivation: 'generated',
          input: {
            type: 'object',
            properties: { model: { const: 'author/image' } },
          },
        },
      ],
    }),
  }
  const outcome = await syncProvider(deps, provider)
  expect(outcome).toMatchObject({ endpointsSeen: 2, versionsAdded: 2 })
  const rows = await deps.db
    .select()
    .from(endpoints)
    .where(eq(endpoints.providerId, id))
  expect(rows.map((row) => row.path)).toEqual([path, path])
  expect(rows.map((row) => row.id).sort()).toEqual([
    `${id}/author/chat`,
    `${id}/author/image`,
  ])
  expect(
    await getEndpointSchema(deps.db, id, 'chat', 'author/chat', 'output'),
  ).toBeNull()
  const configured = {
    ...provider,
    specGrain: gatewayProvider.specGrain,
    connect: gatewayProvider.connect,
    listModels: async () => ({
      models: [
        { rawId: 'author/chat', activity: 'chat' as const },
        { rawId: 'author/image', activity: 'image' as const },
      ],
    }),
  }
  providerRegistry.push(configured)
  try {
    await pollProviderModels(deps, configured)
    const assembled = await assembleProviderOpenApi(deps.db, id, {
      model: 'author/chat',
    })
    expect(assembled.ok).toBe(true)
    if (!assembled.ok) throw new Error(assembled.message)
    expect(
      Object.keys(assembled.document.paths as Record<string, unknown>),
    ).toEqual([path])
    expect(assembled.document.servers).toEqual([
      { url: 'https://api.cloudflare.com/client/v4' },
    ])
    expect(assembled.document.paths).toMatchObject({
      [path]: {
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: { properties: { model: { enum: ['author/chat'] } } },
              },
            },
          },
        },
      },
    })
  } finally {
    providerRegistry.splice(providerRegistry.indexOf(configured), 1)
  }
})
