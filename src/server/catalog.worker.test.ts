import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { Validator } from '@cfworker/json-schema'

import type { Schema } from '@cfworker/json-schema'
import { getDb } from './../db/index.ts'
import type { Db } from './../db/index.ts'
import { models, providers } from '../db/schema.ts'
import { GPT_4O } from '../../packages/rate-card/src/fixtures/gpt-4o.ts'
import { NANO_BANANA_2 } from '../../packages/rate-card/src/fixtures/nano-banana-2.ts'
import {
  getModelDetail,
  getProviderCatalog,
  listModelsCatalog,
  listProviderModels,
  listProvidersCatalog,
} from './catalog.ts'
import { openApiDocument } from './openapi.ts'
import { sourceSilentEvidenceLedger } from './source-silent.ts'
import { parseSourceSilentEvidence } from './source-silent-facts.ts'

const NOW = 1_781_150_000
let db: Db

beforeAll(async () => {
  db = getDb(env)
  await db.insert(providers).values([
    {
      id: 'cat-alpha',
      displayName: 'Catalog Alpha',
      specSourceUrl: 'https://example.com/a.json',
    },
    {
      id: 'cat-beta',
      displayName: 'Catalog Beta',
      specSourceUrl: 'https://example.com/b.json',
    },
  ])
  await db.insert(models).values([
    {
      id: 'cat-alpha-chatty',
      providerId: 'cat-alpha',
      rawId: 'chatty-1',
      activity: 'chat',
      displayName: 'Chatty One',
      contextWindow: 100_000,
      factSources: {
        contextWindow: {
          derivation: 'listing',
          sourceUrl: 'https://example.com/catalog.json',
          sourceHash: 'a'.repeat(64),
        },
      },
      capabilities: { tools: true, vision: true, seed: false },
      reasoning: { mode: 'toggle', mandatory: false },
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    },
    {
      id: 'cat-alpha-paint',
      providerId: 'cat-alpha',
      rawId: 'painter-xl',
      activity: 'image',
      displayName: 'Painter XL',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    },
    {
      id: 'cat-beta-chatter',
      providerId: 'cat-beta',
      rawId: 'beta/chatter',
      activity: 'chat',
      displayName: 'Beta Chatter',
      capabilities: { tools: true },
      reasoning: { mode: 'effort', mandatory: null, efforts: ['low', 'max'] },
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    },
    {
      id: 'cat-beta-oldie',
      providerId: 'cat-beta',
      rawId: 'oldie',
      activity: 'chat',
      displayName: 'Oldie',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      deprecatedAt: NOW,
    },
  ])
})

const catalogIds = async (filters: Parameters<typeof listModelsCatalog>[1]) =>
  (await listModelsCatalog(db, filters)).models
    .map((m) => m.id)
    .filter((id) => id.startsWith('cat-'))

describe('listModelsCatalog filters', () => {
  it('excludes deprecated models by default, includes them on request', async () => {
    expect(await catalogIds({ provider: 'cat-beta' })).toEqual([
      'cat-beta-chatter',
    ])
    expect(
      await catalogIds({ provider: 'cat-beta', includeDeprecated: true }),
    ).toEqual(['cat-beta-chatter', 'cat-beta-oldie'])
  })

  it('filters by activity and provider', async () => {
    expect(await catalogIds({ activity: 'chat' })).toEqual([
      'cat-alpha-chatty',
      'cat-beta-chatter',
    ])
    expect(await catalogIds({ activity: 'image' })).toEqual(['cat-alpha-paint'])
    expect(await catalogIds({ provider: 'cat-alpha' })).toEqual([
      'cat-alpha-chatty',
      'cat-alpha-paint',
    ])
  })

  it('filters by a capability flag stated true, and by free text', async () => {
    // A stated false, a prefix of a flag, and a quote are not matches.
    expect(await catalogIds({ capability: 'seed' })).toEqual([])
    expect(await catalogIds({ capability: 'tool' })).toEqual([])
    expect(await catalogIds({ capability: 'x"y' })).toEqual([])
    expect(await catalogIds({ capability: 'vision' })).toEqual([
      'cat-alpha-chatty',
    ])
    expect(await catalogIds({ capability: 'tools' })).toEqual([
      'cat-alpha-chatty',
      'cat-beta-chatter',
    ])
    expect(await catalogIds({ q: 'painter' })).toEqual(['cat-alpha-paint'])
    expect(await catalogIds({ q: 'CHATT' })).toEqual([
      'cat-alpha-chatty',
      'cat-beta-chatter',
    ])
  })

  it('combines filters and attaches _links', async () => {
    const result = await listModelsCatalog(db, {
      activity: 'chat',
      provider: 'cat-alpha',
    })
    expect(result.models.map((m) => m.id)).toEqual(['cat-alpha-chatty'])
    expect(result.models[0]?._links).toEqual({
      provider: {
        href: '/v1/providers/cat-alpha/models',
        method: 'GET',
        contentType: 'application/json',
      },
      schemas: {
        href: '/v1/schemas/cat-alpha',
        method: 'GET',
        contentType: 'application/json',
      },
    })
    expect(result.models[0]?._links).not.toHaveProperty('openapi')
  })

  it('advertises spec grain and OpenAPI links for registered providers', async () => {
    await db
      .insert(providers)
      .values({
        id: 'fal',
        displayName: 'FAL',
        specSourceUrl: 'https://example.com/f.json',
      })
      .onConflictDoNothing()
    const fal = (await listProvidersCatalog(db)).providers.find(
      (p) => p.id === 'fal',
    )
    expect(fal?.spec.grain).toBe('model')
    expect(fal?._links.openapi).toMatchObject({
      href: '/v1/openapi/fal{?model,activity}',
      contentType: 'application/openapi+json',
      templated: true,
    })
  })
})

describe('provider-scoped queries', () => {
  it('lists one provider, including deprecated models', async () => {
    const result = await listProviderModels(db, 'cat-beta')
    expect(result?.count).toBe(2)
    expect(await listProviderModels(db, 'nope')).toBeNull()
  })

  it('resolves model detail by slug and by raw id', async () => {
    const bySlug = await getModelDetail(db, 'cat-beta', 'cat-beta-chatter')
    const byRaw = await getModelDetail(db, 'cat-beta', 'beta/chatter')
    expect(bySlug?.id).toBe('cat-beta-chatter')
    expect(byRaw?.id).toBe('cat-beta-chatter')
    expect(byRaw?._links.schemas.href).toBe('/v1/schemas/cat-beta')
    expect(byRaw?.schemaEndpointId).toBeNull()
    expect(byRaw?.factSources).toBeNull()
    expect(byRaw?.discrepancies).toEqual([])
    expect(await getModelDetail(db, 'cat-beta', 'missing')).toBeNull()
  })

  it('serves a toggle and an unstated mandatory as stored, on list and detail', async () => {
    const toggle = { mode: 'toggle', mandatory: false }
    // null is "the source does not say": it must not come back as false.
    const unstated = {
      mode: 'effort',
      mandatory: null,
      efforts: ['low', 'max'],
    }
    const listed = async (provider: string, id: string) =>
      (await listModelsCatalog(db, { provider })).models.find(
        (model) => model.id === id,
      )?.reasoning
    const rows = [
      await listed('cat-alpha', 'cat-alpha-chatty'),
      (await getModelDetail(db, 'cat-alpha', 'chatty-1'))?.reasoning,
      await listed('cat-beta', 'cat-beta-chatter'),
      (await getModelDetail(db, 'cat-beta', 'beta/chatter'))?.reasoning,
    ]
    expect(rows).toEqual([toggle, toggle, unstated, unstated])

    const schema = (
      openApiDocument.components.schemas as Record<string, unknown>
    ).ModelReasoning
    const validator = new Validator(schema as Schema, '2020-12', false)
    for (const row of rows) expect(validator.validate(row).errors).toEqual([])
    expect(validator.validate({ mode: 'switch', mandatory: false }).valid).toBe(
      false,
    )
    expect(validator.validate({ mode: 'toggle' }).valid).toBe(false)
  })

  it('surfaces recorded sources by default without inventing missing provenance', async () => {
    const listed = await listModelsCatalog(db, { provider: 'cat-alpha' })
    const recorded = {
      derivation: 'listing',
      sourceUrl: 'https://example.com/catalog.json',
      sourceHash: 'a'.repeat(64),
    }
    expect(
      listed.models.find((row) => row.rawId === 'chatty-1')?.factSources
        ?.contextWindow,
    ).toEqual(recorded)
    expect(
      listed.models.find((row) => row.rawId === 'painter-xl')?.factSources,
    ).toBeNull()
    const providerList = await listProviderModels(db, 'cat-alpha')
    expect(
      providerList?.models.find((row) => row.rawId === 'chatty-1')?.factSources
        ?.contextWindow,
    ).toEqual(recorded)
    const compact = await listModelsCatalog(db, {
      provider: 'cat-alpha',
      provenance: false,
    })
    expect(compact.models.every((row) => !('factSources' in row))).toBe(true)
  })

  it('binds grain=provider models to a generation route and FAL to its raw id', async () => {
    await db
      .insert(providers)
      .values([
        {
          id: 'grok',
          displayName: 'xAI Grok',
          specSourceUrl: 'https://example.com/g.json',
        },
        {
          id: 'fal',
          displayName: 'FAL',
          specSourceUrl: 'https://example.com/f.json',
        },
      ])
      .onConflictDoNothing()
    await db.insert(models).values([
      {
        id: 'grok-grok-imagine-image-2-0',
        providerId: 'grok',
        rawId: 'grok-imagine-image-2.0',
        activity: 'image',
        displayName: 'Grok Imagine Image 2.0',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: 'fal-xai-grok-imagine',
        providerId: 'fal',
        rawId: 'xai/grok-imagine-image/v2.0/text-to-image',
        activity: 'image',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ])

    const grok = await getModelDetail(db, 'grok', 'grok-imagine-image-2.0')
    expect(grok?.schemaEndpointId).toBe('v1/images/generations')
    expect(grok?._links.schema).toMatchObject({
      href: '/v1/schemas/grok/image/v1/images/generations',
      method: 'GET',
    })
    expect(
      (await listModelsCatalog(db, { provider: 'grok', activity: 'image' }))
        .models,
    ).toHaveLength(1)

    const fal = await getModelDetail(
      db,
      'fal',
      'xai/grok-imagine-image/v2.0/text-to-image',
    )
    expect(fal?.schemaEndpointId).toBe(
      'xai/grok-imagine-image/v2.0/text-to-image',
    )
  })

  it('lists providers with status and links', async () => {
    const result = await listProvidersCatalog(db)
    const alpha = result.providers.find((p) => p.id === 'cat-alpha')
    expect(alpha?._links.models.href).toBe('/v1/providers/cat-alpha/models')
    expect(alpha?._links.self.href).toBe('/v1/providers/cat-alpha')
    expect(alpha?.counts.models).toBe(2)
    expect(alpha).not.toHaveProperty('activities')
  })

  it('serves one provider with live model counts per activity', async () => {
    const alpha = await getProviderCatalog(db, 'cat-alpha')
    expect(alpha?.counts.models).toBe(2)
    expect(alpha?.activities).toEqual({ chat: 1, image: 1 })
    expect(alpha?._links.self.href).toBe('/v1/providers/cat-alpha')
    expect(await getProviderCatalog(db, 'nope')).toBeNull()
  })
})

describe('catalog rate cards', () => {
  beforeAll(async () => {
    await db.insert(providers).values({
      id: 'cat-price',
      displayName: 'Catalog Price',
      specSourceUrl: 'https://example.com/p.json',
    })
    await db.insert(models).values([
      {
        id: 'cat-price-gpt-4o',
        providerId: 'cat-price',
        rawId: 'gpt-4o',
        activity: 'chat',
        displayName: 'GPT-4o',
        pricing: GPT_4O,
        factSources: { pricing: { derivation: 'listing' } },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: 'cat-price-nano',
        providerId: 'cat-price',
        rawId: 'nano-banana-2',
        activity: 'image',
        displayName: 'Nano Banana 2',
        pricing: NANO_BANANA_2,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: 'cat-price-blob',
        providerId: 'cat-price',
        rawId: 'blob',
        activity: 'chat',
        pricing: { prompt: '0.0000025', completion: '0.00001' },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ])
  })

  it('summarises every stored card on the list; null means no card', async () => {
    const listed = await listModelsCatalog(db, { provider: 'cat-price' })
    const byId = Object.fromEntries(listed.models.map((m) => [m.id, m]))
    expect(byId['cat-price-gpt-4o']?.pricing).toEqual({
      currency: 'USD',
      per: 'token',
      inputPerMillion: 2.5,
      outputPerMillion: 10,
    })
    expect(byId['cat-price-nano']?.pricing).toEqual({
      currency: 'USD',
      per: 'image',
    })
    expect(byId['cat-price-blob']?.pricing).toBeNull()
    expect(listed._links.self.href).toContain('pricing')
  })

  it('includes the full card on list rows when pricing=1', async () => {
    const listed = await listModelsCatalog(db, {
      provider: 'cat-price',
      pricing: true,
    })
    const gpt = listed.models.find((m) => m.id === 'cat-price-gpt-4o')
    const nano = listed.models.find((m) => m.id === 'cat-price-nano')
    expect(gpt?.pricing).toEqual(GPT_4O)
    expect(nano?.pricing).toEqual(NANO_BANANA_2)
  })

  it('always includes the full card (or null) on detail', async () => {
    const gpt = await getModelDetail(db, 'cat-price', 'gpt-4o')
    const nano = await getModelDetail(db, 'cat-price', 'nano-banana-2')
    const blob = await getModelDetail(db, 'cat-price', 'blob')
    expect(gpt?.pricing).toEqual(GPT_4O)
    expect(gpt?.factSources).toEqual({ pricing: { derivation: 'listing' } })
    expect(nano?.pricing).toEqual(NANO_BANANA_2)
    expect(blob?.pricing).toBeNull()
  })
})

describe('stored sameAs relationships', () => {
  beforeAll(async () => {
    await db.insert(providers).values([
      {
        id: 'cat-maker',
        displayName: 'Maker',
        specSourceUrl: 'https://example.com/maker',
      },
      {
        id: 'cat-reseller',
        displayName: 'Reseller',
        specSourceUrl: 'https://example.com/reseller',
      },
    ])
    await db.insert(models).values({
      id: 'sameas-maker',
      providerId: 'cat-maker',
      rawId: 'native-1',
      pricing: GPT_4O,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    })
    await db.insert(models).values([
      {
        id: 'sameas-linked',
        providerId: 'cat-reseller',
        rawId: 'dealer-id',
        sameAsModelId: 'sameas-maker',
        contextWindow: 1234,
        upstreamProvider: 'cat-maker',
        upstreamRawId: 'native-1',
        upstreamSource: {
          derivation: 'docs-derived',
          sourceUrl: 'https://example.com/reseller/model',
        },
        factSources: { contextWindow: { derivation: 'listing' } },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: 'sameas-no-link',
        providerId: 'cat-reseller',
        rawId: 'cat-maker/native-1',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: 'sameas-unresolved',
        providerId: 'cat-reseller',
        rawId: 'unresolved',
        upstreamProvider: 'cat-maker',
        upstreamRawId: 'missing',
        upstreamSource: { derivation: 'listing' },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        // A link reconcile has not caught up with: the evidence is gone.
        id: 'sameas-stale',
        providerId: 'cat-reseller',
        rawId: 'stale',
        sameAsModelId: 'sameas-maker',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: 'sameas-normalized',
        providerId: 'cat-reseller',
        rawId: 'dotted',
        sameAsModelId: 'sameas-maker',
        upstreamProvider: 'cat-maker',
        upstreamRawId: 'native.1',
        upstreamSource: { derivation: 'listing' },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ])
  })

  it('serves the stored link, with its evidence as provenance only when resolved', async () => {
    const linked = await getModelDetail(db, 'cat-reseller', 'dealer-id')
    expect(linked?.sameAs).toEqual({
      provider: 'cat-maker',
      rawId: 'native-1',
    })
    expect(linked?.factSources).toEqual({
      contextWindow: { derivation: 'listing' },
      sameAs: {
        derivation: 'docs-derived',
        sourceUrl: 'https://example.com/reseller/model',
      },
    })
    expect(linked?.contextWindow).toBe(1234)
    expect(linked?.pricing).toBeNull()
    for (const rawId of ['cat-maker/native-1', 'unresolved', 'stale']) {
      const unlinked = await getModelDetail(db, 'cat-reseller', rawId)
      expect(unlinked?.sameAs).toBeNull()
      expect(unlinked?.factSources).toBeNull()
    }
    const dotted = await getModelDetail(db, 'cat-reseller', 'dotted')
    expect(dotted?.factSources?.sameAs).toEqual({
      derivation: 'listing',
      normalized: true,
    })
  })

  it('joins the stored target on catalog and provider lists', async () => {
    const listed = await listModelsCatalog(db, {
      provider: 'cat-reseller',
      provenance: true,
    })
    const linked = listed.models.find((row) => row.id === 'sameas-linked')
    expect(linked?.sameAs).toEqual({
      provider: 'cat-maker',
      rawId: 'native-1',
    })
    expect(linked?.factSources?.sameAs?.derivation).toBe('docs-derived')
    const provider = await listProviderModels(db, 'cat-reseller')
    expect(
      provider?.models.find((row) => row.id === 'sameas-linked')?.sameAs,
    ).toEqual({ provider: 'cat-maker', rawId: 'native-1' })
    expect(provider?.models[0]?.factSources?.sameAs?.sourceUrl).toBe(
      'https://example.com/reseller/model',
    )
    const compact = await listProviderModels(db, 'cat-reseller', false)
    expect(compact?.models[0]).not.toHaveProperty('factSources')
  })
})

describe('source-silent catalog provenance', () => {
  it('serves verified ledger evidence on detail and default lists', async () => {
    await db
      .insert(providers)
      .values({
        id: 'grok',
        displayName: 'Grok',
        specSourceUrl: 'https://docs.x.ai/openapi.json',
      })
      .onConflictDoNothing()
    await db.insert(models).values({
      id: 'silent-grok-test',
      providerId: 'grok',
      rawId: 'silent-grok-test',
      activity: 'chat',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    })
    const detail = await getModelDetail(db, 'grok', 'silent-grok-test')
    const expected = {
      derivation: 'source-silent',
      sourceUrl: 'https://docs.x.ai/openapi.json',
      checkedAt: '2026-10-22',
    }
    expect(detail?.maxOutput).toBeNull()
    expect(detail?.factSources?.maxOutput).toEqual(expected)
    expect(detail?.factSources).not.toHaveProperty('contextWindow')
    const listed = await listModelsCatalog(db, {
      provider: 'grok',
      provenance: true,
    })
    expect(
      listed.models.find((model) => model.id === 'silent-grok-test')
        ?.factSources?.maxOutput,
    ).toEqual(expected)
    const compact = await listModelsCatalog(db, {
      provider: 'grok',
      provenance: false,
    })
    expect(
      compact.models.find((model) => model.id === 'silent-grok-test'),
    ).not.toHaveProperty('factSources')
  })

  it('retains sourced output caps despite a provider ledger entry', async () => {
    await db
      .insert(providers)
      .values({
        id: 'grok',
        displayName: 'Grok',
        specSourceUrl: 'https://docs.x.ai/openapi.json',
      })
      .onConflictDoNothing()
    const source = {
      derivation: 'listing',
      sourceUrl: 'https://api.x.ai/v1/language-models',
    }
    await db.insert(models).values({
      id: 'sourced-grok-test',
      providerId: 'grok',
      rawId: 'sourced-grok-test',
      activity: 'chat',
      maxOutput: 2048,
      factSources: { maxOutput: source },
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    })
    const detail = await getModelDetail(db, 'grok', 'sourced-grok-test')
    expect(detail?.maxOutput).toBe(2048)
    expect(detail?.factSources?.maxOutput).toEqual(source)
  })
})

it('serves exact-model replay leaf silence on detail and default lists', async () => {
  const scope = 'scoped-catalog/maker/model:variant'
  const evidence = parseSourceSilentEvidence(
    `- ${scope}: replayReasoningContent — absent, https://example.com/exact-model, checked 2026-10-09`,
  ).get(scope)!
  sourceSilentEvidenceLedger.set(scope, evidence)
  try {
    await db.insert(providers).values({
      id: 'scoped-catalog',
      displayName: 'Scoped catalog',
      specSourceUrl: 'https://example.com/docs',
    })
    await db.insert(models).values([
      {
        id: 'scoped-catalog-exact',
        providerId: 'scoped-catalog',
        rawId: 'maker/model:variant',
        activity: 'chat',
        requestMap: { replayReasoningContent: null },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: 'scoped-catalog-sibling',
        providerId: 'scoped-catalog',
        rawId: 'maker/model:variant-snapshot',
        activity: 'chat',
        requestMap: { replayReasoningContent: null },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ])
    const detail = await getModelDetail(
      db,
      'scoped-catalog',
      'maker/model:variant',
    )
    expect(detail?.requestMap).toEqual({ replayReasoningContent: null })
    expect(
      detail?.factSources?.requestMapFields?.replayReasoningContent,
    ).toEqual(evidence.get('replayReasoningContent'))
    expect(detail?.factSources).not.toHaveProperty('requestMap')
    const listed = await listModelsCatalog(db, {
      provider: 'scoped-catalog',
      provenance: true,
    })
    expect(
      listed.models.find((row) => row.rawId === 'maker/model:variant')
        ?.factSources?.requestMapFields?.replayReasoningContent,
    ).toEqual(evidence.get('replayReasoningContent'))
    expect(
      listed.models.find((row) => row.rawId === 'maker/model:variant-snapshot')
        ?.factSources?.requestMapFields,
    ).toBeUndefined()
    const compact = await listModelsCatalog(db, {
      provider: 'scoped-catalog',
      provenance: false,
    })
    expect(compact.models.every((row) => !('factSources' in row))).toBe(true)
  } finally {
    sourceSilentEvidenceLedger.delete(scope)
  }
})

describe('served rows match the published row schema', () => {
  const validatorFor = (name: string) =>
    new Validator(
      {
        $ref: `#/components/schemas/${name}`,
        components: openApiDocument.components,
      },
      '2020-12',
      false,
    )

  it('validates list, provider-list and detail responses', async () => {
    const list = await listModelsCatalog(db, { includeDeprecated: true })
    expect(validatorFor('ModelList').validate(list).errors).toEqual([])
    const { capabilities: _dropped, ...missingField } = list.models[0] ?? {}
    expect(
      validatorFor('ModelList').validate({ ...list, models: [missingField] })
        .valid,
    ).toBe(false)
    const full = await listModelsCatalog(db, { pricing: true })
    expect(validatorFor('ModelList').validate(full).errors).toEqual([])
    const bare = await listModelsCatalog(db, { provenance: false })
    expect(validatorFor('ModelList').validate(bare).errors).toEqual([])
    const byProvider = await listProviderModels(db, 'cat-alpha')
    expect(
      validatorFor('ProviderModelList').validate(byProvider).errors,
    ).toEqual([])
    const detail = validatorFor('ModelDetail')
    for (const row of list.models) {
      const body = await getModelDetail(db, row.provider, row.id)
      expect(detail.validate(body).errors).toEqual([])
    }
  })
})
