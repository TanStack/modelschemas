import { describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'

import { getDb } from '../db/index.ts'
import {
  cacheMeta,
  endpoints,
  models,
  providers,
  schemaVersions,
} from '../db/schema.ts'
import { FACT_KEYS, buildReport } from '../lib/completeness.ts'
import type { Ledger, ModelRow } from '../lib/completeness.ts'
import { providerRegistry } from '../server/providers/index.ts'
import { listModelsCatalog } from './catalog.ts'
import { getServiceStatus, recordCompleteness } from './status.ts'

const NOW = 1_781_150_000

describe('getServiceStatus', () => {
  it('reports per-provider sync state and counts', async () => {
    const db = getDb(env)
    await db.insert(providers).values([
      {
        id: 'status-a',
        displayName: 'Status A',
        specSourceUrl: 'https://example.com/a.json',
        lastPolledAt: NOW,
        lastSyncedAt: NOW - 100,
      },
      {
        id: 'status-b',
        displayName: 'Status B',
        specSourceUrl: 'https://example.com/b.json',
        status: 'degraded',
      },
    ])
    await db.insert(models).values([
      {
        id: 'status-a-model',
        providerId: 'status-a',
        rawId: 'model',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        // A stored card counts as priced; a null column does not.
        id: 'status-a-priced',
        providerId: 'status-a',
        rawId: 'priced',
        pricing: { inputs: {}, tables: {}, price: 1, examples: [] },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        // Chat without reasoning metadata: denominator only.
        id: 'status-a-chat',
        providerId: 'status-a',
        rawId: 'chat',
        activity: 'chat',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: 'status-a-reasoner',
        providerId: 'status-a',
        rawId: 'reasoner',
        activity: 'chat',
        reasoning: { mode: 'effort', mandatory: false },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ])
    await db.insert(endpoints).values({
      id: 'status-a/v1/things',
      providerId: 'status-a',
      activity: 'chat',
      method: 'POST',
      path: '/v1/things',
    })
    await db.insert(schemaVersions).values([
      {
        id: 'status-a/v1/things:input:current',
        endpointId: 'status-a/v1/things',
        kind: 'input',
        contentHash: 'c'.repeat(64),
        schema: '{}',
        createdAt: NOW,
      },
      {
        // Superseded version must not count.
        id: 'status-a/v1/things:input:old',
        endpointId: 'status-a/v1/things',
        kind: 'input',
        contentHash: 'd'.repeat(64),
        schema: '{}',
        createdAt: NOW - 10,
        supersededAt: NOW,
      },
    ])

    const status = await getServiceStatus(db, NOW)
    expect(status.service).toBe('modelschemas')
    const a = status.providers.find((p) => p.id === 'status-a')
    const b = status.providers.find((p) => p.id === 'status-b')
    expect(a).toMatchObject({
      status: 'active',
      lastPolledAt: NOW,
      lastSyncedAt: NOW - 100,
      counts: {
        models: 4,
        priced: 1,
        reasoning: 1,
        chat: 2,
        endpoints: 1,
        schemas: 1,
      },
    })
    expect(b).toMatchObject({
      status: 'degraded',
      lastPolledAt: null,
      counts: {
        models: 0,
        priced: 0,
        reasoning: 0,
        chat: 0,
        endpoints: 0,
        schemas: 0,
      },
    })
  })

  it('lists every registered provider even before its first sync', async () => {
    const db = getDb(env)
    const status = await getServiceStatus(db, NOW)
    // Nothing is seeded in the test DB, so every registry provider must
    // surface as pending — the full roster is always visible.
    for (const config of providerRegistry) {
      const listed = status.providers.find((p) => p.id === config.id)
      expect(listed).toMatchObject({
        displayName: config.displayName,
        status: 'pending',
        counts: {
          models: 0,
          priced: 0,
          reasoning: 0,
          chat: 0,
          endpoints: 0,
          schemas: 0,
        },
      })
    }
  })

  it('carries docs-failing and refused-clears records, and only those', async () => {
    const db = getDb(env)
    const ids = [
      'rec-none',
      'rec-docs',
      'rec-corrupt',
      'rec-clears',
      'rec-storm',
    ]
    await db.insert(providers).values(
      ids.map((id) => ({
        id,
        displayName: id,
        specSourceUrl: 'https://example.com/spec.json',
      })),
    )
    const docsFailing = {
      since: NOW - 1800,
      polls: 3,
      lastAt: NOW,
      failed: 2,
      skipped: 1,
      sources: ['https://example.com/docs/a', 'https://example.com/docs/b'],
      error: 'page changed shape',
    }
    const priceClearsRefused = {
      since: NOW - 900,
      polls: 2,
      lastAt: NOW,
      refused: 6,
      priced: 8,
    }
    const updateStorm = {
      since: NOW - 60,
      polls: 1,
      lastAt: NOW,
      updated: 21,
      live: 30,
    }
    const row = (key: string, lastError: string | null) => ({
      key,
      fetchedAt: NOW,
      staleTime: 0,
      lastError,
    })
    await db.insert(cacheMeta).values([
      row('docs-failing:rec-docs', JSON.stringify(docsFailing)),
      row(
        'price-clears-refused:rec-clears',
        JSON.stringify(priceClearsRefused),
      ),
      row('update-storm:rec-storm', JSON.stringify(updateStorm)),
      // Not JSON, JSON of the wrong shape, and no body at all.
      row('docs-failing:rec-corrupt', '{not json'),
      row('price-clears-refused:rec-corrupt', '"a string"'),
      row('docs-failing:rec-none', null),
      // Another cache_meta row is not a record.
      row('schema:rec-none', JSON.stringify(docsFailing)),
    ])

    const status = await getServiceStatus(db, NOW)
    const [none, docs, corrupt, clears, storm] = ids.map((id) =>
      status.providers.find((p) => p.id === id),
    )
    expect(docs?.docsFailing).toEqual(docsFailing)
    expect(docs).not.toHaveProperty('priceClearsRefused')
    expect(docs).not.toHaveProperty('updateStorm')
    expect(clears?.priceClearsRefused).toEqual(priceClearsRefused)
    expect(clears).not.toHaveProperty('docsFailing')
    expect(storm?.updateStorm).toEqual(updateStorm)
    expect(storm).not.toHaveProperty('docsFailing')
    for (const healthy of [none, corrupt]) {
      expect(healthy).toMatchObject({ status: 'active' })
      expect(healthy).not.toHaveProperty('docsFailing')
      expect(healthy).not.toHaveProperty('priceClearsRefused')
      expect(healthy).not.toHaveProperty('updateStorm')
    }
    // Neither record moves `status`.
    expect(docs?.status).toBe('active')
    expect(clears?.status).toBe('active')
  })

  const provider = (id: string) => ({
    id,
    displayName: id,
    specSourceUrl: 'https://example.com/spec.json',
  })
  const model = (
    providerId: string,
    rawId: string,
    facts: Partial<typeof models.$inferInsert> = {},
  ) => ({
    id: `${providerId}-${rawId}`,
    providerId,
    rawId,
    activity: 'chat' as const,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    ...facts,
  })
  const card = {
    inputs: {},
    tables: { rate: { base: { input_tokens: 1e-6, output_tokens: 2e-6 } } },
    price: 1,
    examples: [],
    source: {
      url: 'https://docs.example.com/pricing',
      hash: 'a'.repeat(64),
      extractedAt: '2026-01-01T00:00:00.000Z',
    },
  }

  it('counts live rows only, and deprecated rows apart', async () => {
    const db = getDb(env)
    await db.insert(providers).values([provider('gone'), provider('part')])
    const retired = { deprecatedAt: NOW - 10, pricing: card }
    await db
      .insert(models)
      .values([
        model('gone', 'a', retired),
        model('gone', 'b', { ...retired, reasoning: { mode: 'toggle' } }),
        model('part', 'old', retired),
        model('part', 'live', { pricing: card }),
        model('part', 'image', { activity: 'image' }),
      ])

    await recordCompleteness(db, NOW)
    const status = await getServiceStatus(db, NOW)
    const gone = status.providers.find((p) => p.id === 'gone')
    const part = status.providers.find((p) => p.id === 'part')
    // Every row retired: what `/v1/models?provider=gone` lists is nothing.
    expect(gone?.counts).toMatchObject({
      models: 0,
      priced: 0,
      reasoning: 0,
      chat: 0,
      deprecated: 2,
    })
    expect(gone?.completeness).toMatchObject({ score: null, chat: 0 })
    expect(part?.counts).toMatchObject({
      models: 2,
      priced: 1,
      reasoning: 0,
      chat: 1,
      deprecated: 1,
    })
    expect(part?.completeness.chat).toBe(1)
    expect((await listModelsCatalog(db, { provider: 'part' })).count).toBe(
      part?.counts.models,
    )
  })

  it('scores completeness as the gap report does', async () => {
    const db = getDb(env)
    const ids = ['no-chat', 'all-silent', 'mixed']
    await db.insert(providers).values(ids.map(provider))
    await db.insert(models).values([
      model('no-chat', 'image', { activity: 'image', pricing: card }),
      model('all-silent', 'bare'),
      model('mixed', 'full', {
        contextWindow: 200_000,
        maxOutput: 64_000,
        modalities: { input: ['text'], output: ['text'] },
        pricing: card,
        capabilities: { reasoning: true, tools: true },
        reasoning: { mode: 'effort', efforts: ['low', 'high'] },
        requestMap: {
          maxTokensField: 'max_tokens',
          replayReasoningContent: false,
        },
        schemaEndpointId: 'v1/chat/completions',
      }),
      // Claims reasoning and stores none; a card that does not parse is
      // served as null, so it is no price here either.
      model('mixed', 'thin', {
        contextWindow: 8000,
        capabilities: { reasoning: true },
        pricing: { tables: card.tables },
      }),
      // A models.dev price does not count.
      model('mixed', 'borrowed', {
        pricing: {
          ...card,
          source: { ...card.source, url: 'https://models.dev/api.json' },
        },
      }),
      // Retired and of another activity: neither is scored.
      model('mixed', 'retired', { deprecatedAt: NOW, contextWindow: 1 }),
      model('mixed', 'image', { activity: 'image' }),
    ])
    const ledger: Ledger = new Map([
      ['all-silent', new Set(FACT_KEYS)],
      ['mixed', new Set(['cacheRead'] as const)],
    ])

    // Nothing scored yet (no record, whatever an earlier test stored): no
    // score anywhere, and the request still answers.
    await db.delete(cacheMeta)
    const before = await getServiceStatus(db, NOW)
    expect(before.completenessComputedAt).toBeNull()
    expect(before.providers.every((p) => p.completeness.score === null)).toBe(
      true,
    )

    expect(await recordCompleteness(db, NOW - 60, ledger)).toBe(true)
    const status = await getServiceStatus(db, NOW)
    expect(status.completenessComputedAt).toBe(NOW - 60)
    const [noChat, allSilent, mixed] = ids.map(
      (id) => status.providers.find((p) => p.id === id)?.completeness,
    )
    // Nothing to score is not a score of zero.
    expect(noChat).toEqual({
      score: null,
      chat: 0,
      filled: 0,
      needed: 0,
      silent: [],
    })
    // Chat rows with every fact on the ledger have nothing left to fill.
    expect(allSilent).toEqual({
      score: 1,
      chat: 1,
      filled: 0,
      needed: 0,
      silent: [...FACT_KEYS],
    })
    // full: 10 of 10. thin: contextWindow and capabilities of 7 (no
    // OpenAI-compat route, so requestMap and replay are not scored).
    // borrowed: 0 of 6.
    expect(mixed).toEqual({
      score: 12 / 23,
      chat: 3,
      filled: 12,
      needed: 23,
      silent: ['cacheRead'],
    })

    // The same rows as `bun run gap:report` reads them, off the API.
    const served = await listModelsCatalog(db, { pricing: true })
    const report = buildReport(served.models as Array<ModelRow>, ledger)
    for (const id of ['all-silent', 'mixed']) {
      const scored = report.providers.find((p) => p.provider === id)
      const listed = status.providers.find((p) => p.id === id)
      expect(listed?.completeness.score).toBe(scored?.score)
      expect(listed?.completeness.chat).toBe(scored?.chat)
    }
  })

  const KEY = 'status:completeness:v2'
  const scoreOf = async (db: ReturnType<typeof getDb>, id: string) => {
    const status = await getServiceStatus(db, NOW)
    return {
      computedAt: status.completenessComputedAt,
      ...status.providers.find((p) => p.id === id)?.completeness,
    }
  }

  it('serves the stored score only while it matches the live chat rows', async () => {
    const db = getDb(env)
    await db.insert(providers).values(provider('stored'))
    await db.insert(models).values(model('stored', 'a'))
    await recordCompleteness(db, NOW)
    expect(await scoreOf(db, 'stored')).toMatchObject({
      computedAt: NOW,
      score: 0,
      chat: 1,
      needed: 7,
    })

    // A chat row the record never scored: no number over a different set.
    await db.insert(models).values(model('stored', 'b'))
    expect(await scoreOf(db, 'stored')).toMatchObject({
      computedAt: NOW,
      score: null,
      chat: 0,
    })
    // The next poll's record scores both, and says when.
    await recordCompleteness(db, NOW + 900)
    expect(await scoreOf(db, 'stored')).toMatchObject({
      computedAt: NOW + 900,
      score: 0,
      chat: 2,
    })
    // No live chat row left: null at once, before any rescore.
    await db.update(models).set({ deprecatedAt: NOW })
    expect(await scoreOf(db, 'stored')).toMatchObject({ score: null, chat: 0 })
  })

  it('answers with null scores when the record cannot be used', async () => {
    const db = getDb(env)
    await db.insert(providers).values(provider('broken'))
    await db.insert(models).values(model('broken', 'a'))
    await recordCompleteness(db, NOW)
    expect(await scoreOf(db, 'broken')).toMatchObject({ score: 0 })
    const none = { computedAt: null, score: null, chat: 0 }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Corrupt JSON, JSON of the wrong shape, an entry of the wrong shape.
    for (const lastError of ['{not json', '"a string"', 'null']) {
      await db
        .update(cacheMeta)
        .set({ lastError })
        .where(eq(cacheMeta.key, KEY))
      expect(await scoreOf(db, 'broken')).toMatchObject(none)
    }
    // Entries that are not a whole `Completeness`, though the chat count
    // matches the live one: never served, and no usable record at all.
    for (const entry of [
      7,
      { chat: 1 },
      { score: 'high', chat: 1, filled: 0, needed: 8, silent: 'x' },
      { score: 0, chat: 1, filled: 0, needed: 8, silent: [1] },
    ]) {
      await db
        .update(cacheMeta)
        .set({ lastError: JSON.stringify({ broken: entry }) })
        .where(eq(cacheMeta.key, KEY))
      expect(await scoreOf(db, 'broken')).toEqual({
        computedAt: null,
        score: null,
        chat: 0,
        filled: 0,
        needed: 0,
        silent: [],
      })
    }
    // An array is not a record. One bad entry does not cost the good ones.
    await db
      .update(cacheMeta)
      .set({ lastError: '[{"chat":1}]' })
      .where(eq(cacheMeta.key, KEY))
    expect(await scoreOf(db, 'broken')).toMatchObject(none)
    const good = { score: 0.5, chat: 1, filled: 4, needed: 8, silent: [] }
    await db
      .update(cacheMeta)
      .set({ lastError: JSON.stringify({ broken: good, other: { chat: 1 } }) })
      .where(eq(cacheMeta.key, KEY))
    expect(await scoreOf(db, 'broken')).toEqual({ computedAt: NOW, ...good })

    // Deleted.
    await db.delete(cacheMeta).where(eq(cacheMeta.key, KEY))
    expect(await scoreOf(db, 'broken')).toMatchObject(none)

    // The read itself throws: the rest of the status is still served.
    await recordCompleteness(db, NOW)
    vi.spyOn(db.query.cacheMeta, 'findFirst').mockImplementation(() => {
      throw new Error('D1 down')
    })
    const status = await getServiceStatus(db, NOW)
    expect(status.completenessComputedAt).toBeNull()
    expect(status.providers.find((p) => p.id === 'broken')).toMatchObject({
      counts: { models: 1, chat: 1 },
      completeness: { score: null },
    })
    expect(errors).toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('keeps the previous record when scoring fails', async () => {
    const db = getDb(env)
    await db.insert(providers).values(provider('kept'))
    await db.insert(models).values(model('kept', 'a'))
    await recordCompleteness(db, NOW)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const throwing = {
      get: () => {
        throw new Error('scorer broke')
      },
    } as unknown as Ledger
    // Never throws: the cron that calls it goes on to its next step.
    expect(await recordCompleteness(db, NOW + 900, throwing)).toBe(false)
    expect(errors).toHaveBeenCalledWith(
      JSON.stringify({ job: 'completeness', error: 'scorer broke' }),
    )
    vi.restoreAllMocks()
    expect(await scoreOf(db, 'kept')).toMatchObject({
      computedAt: NOW,
      score: 0,
      chat: 1,
    })
  })
})

it('scores only the exact raw model covered by a scoped silence entry', async () => {
  const db = getDb(env)
  await db.insert(providers).values({
    id: 'scoped-status',
    displayName: 'Scoped status',
    specSourceUrl: 'https://example.com/docs',
  })
  await db.insert(models).values([
    {
      id: 'scoped-status-exact',
      providerId: 'scoped-status',
      rawId: 'maker/model:variant',
      activity: 'chat',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    },
    {
      id: 'scoped-status-sibling',
      providerId: 'scoped-status',
      rawId: 'maker/model:variant-snapshot',
      activity: 'chat',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    },
  ])
  const ledger: Ledger = new Map([
    ['scoped-status/maker/model:variant', new Set(['maxOutput'])],
  ])
  await recordCompleteness(db, NOW, ledger)
  const result = (await getServiceStatus(db, NOW)).providers.find(
    (entry) => entry.id === 'scoped-status',
  )?.completeness
  expect(result?.filled).toBe(0)
  expect(result?.needed).toBe(13)
  const served = await listModelsCatalog(db, {
    provider: 'scoped-status',
    pricing: true,
  })
  const report = buildReport(served.models as Array<ModelRow>, ledger)
    .providers[0]!
  expect(report.modelSilent).toEqual({ maxOutput: 1 })
  expect(result?.score).toBe(report.score)
})
