import { bodyText, requestUrl } from '#/lib/text.ts'
import { describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'

import type { RateCard } from '@modelschemas/rate-card'

import { getDb } from '../../db/index.ts'
import {
  cacheMeta,
  changes,
  endpoints,
  models,
  providers,
  schemaVersions,
} from '../../db/schema.ts'
import { falLlmsTxtUrl } from '../providers/fal.ts'
import { modelDbId } from './poll-models.ts'
import { POSTHOG_CAPTURE_URL } from './ingest-signals.ts'
import type { PostHogBatch } from './ingest-signals.ts'
import {
  extractFalPricing,
  FAL_PRICING_FETCH_CONCURRENCY,
  FAL_PRICING_FETCH_FAIL_ABORT,
  falPricingExtractCursorKey,
  pricingSection,
  pricingSectionHash,
} from './extract-fal-pricing.ts'
import type { ExtractCardArgs, ExtractedCard } from './extract-fal-pricing.ts'

const NOW = 1_781_150_000

/** Real nano-banana-2 text: extras beyond the base rate, so the unit-rate
 * parser refuses it and the extract model is asked. */
const NANO_LLMS = `# Nano Banana 2

## Pricing

Your request will cost **$0.08** per image. For **$1.00**, you can run this model **12** times. If web search is used, an additional $0.015 will be charged.

## API Information
`

/** The shape the unit-rate parser compiles without any model call. */
const UNIT_LLMS = `# Unit

## Pricing

- **Price**: $0.04 per megapixels

## API Information
`

function llmsWithRate(rate: string): string {
  return NANO_LLMS.replace('**$0.08**', `**$${rate}**`)
}

const STUB_LLMS = `# Stub

## Pricing

For more details, see [fal.ai pricing](https://fal.ai/pricing).

## API Information
`

function dummySource(url: string): RateCard['source'] {
  return {
    url,
    hash: 'a'.repeat(64),
    extractedAt: '2026-01-01T00:00:00.000Z',
  }
}

function perImageCard(url: string): RateCard {
  return {
    inputs: {
      num_images: { param: 'num_images', kind: 'number', default: 1 },
    },
    tables: {},
    price: { '*': [{ var: 'num_images' }, 0.08] },
    examples: [
      {
        params: {},
        usd: 0.08,
        quote: 'Your request will cost $0.08 per image',
      },
    ],
    source: dummySource(url),
  }
}

async function seedProvider(providerId: string): Promise<void> {
  const db = getDb(env)
  await db.insert(providers).values({
    id: providerId,
    displayName: 'FAL',
    specSourceUrl: 'https://api.fal.ai/v1/models',
  })
}

async function seedCandidate(args: {
  providerId: string
  rawId: string
  properties: Record<string, unknown>
  deprecated?: boolean
  activity?: 'image' | null
  pricing?: unknown
  factSources?: unknown
}): Promise<string> {
  const db = getDb(env)
  const id = modelDbId(args.providerId, args.rawId)
  const endpointId = `${args.providerId}/${args.rawId}`
  await db.insert(endpoints).values({
    id: endpointId,
    providerId: args.providerId,
    activity: args.activity === null ? 'image' : (args.activity ?? 'image'),
    method: 'POST',
    path: `/${args.rawId}`,
  })
  await db.insert(schemaVersions).values({
    id: `${endpointId}:input`,
    endpointId,
    kind: 'input',
    contentHash: 'b'.repeat(64),
    schema: JSON.stringify({ properties: args.properties }),
    derivation: 'upstream-spec',
    createdAt: NOW,
  })
  await db.insert(models).values({
    id,
    providerId: args.providerId,
    rawId: args.rawId,
    activity: args.activity === undefined ? 'image' : args.activity,
    pricing: args.pricing ?? null,
    factSources: args.factSources ?? null,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    deprecatedAt: args.deprecated ? NOW : null,
  })
  return id
}

describe('extractFalPricing', () => {
  it('extracts a verified card, hash-skips night two, and rotates the cursor', async () => {
    const providerId = 'extract-main'
    await seedProvider(providerId)
    await seedCandidate({
      providerId,
      rawId: 'fal-ai/nano-banana-2',
      properties: {
        num_images: { type: 'integer' },
        prompt: { type: 'string' },
      },
    })
    await seedCandidate({
      providerId,
      rawId: 'fal-ai/other',
      properties: { num_images: { type: 'integer' } },
    })

    const files = new Map<string, string>([
      [falLlmsTxtUrl('fal-ai/nano-banana-2'), NANO_LLMS],
      [falLlmsTxtUrl('fal-ai/other'), NANO_LLMS],
    ])
    const extractedRawIds: Array<string> = []
    const extractCard = async (
      args: ExtractCardArgs,
    ): Promise<ExtractedCard> => {
      extractedRawIds.push(args.sourceUrl)
      return perImageCard(args.sourceUrl)
    }

    const db = getDb(env)
    const deps = {
      db,
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchCap: 10,
      extractCap: 10,
      fetchText: (url: string) => Promise.resolve(files.get(url) ?? null),
      extractCard,
    }

    const first = await extractFalPricing(deps)
    expect(first).toMatchObject({
      candidates: 2,
      fetched: 2,
      // Both rows share the Pricing section, so one call serves both.
      extracted: 1,
      deduped: 0,
      written: 2,
      hashSkipped: 0,
    })
    expect(extractedRawIds).toHaveLength(1)
    const nano = await db.query.models.findFirst({
      where: eq(models.id, modelDbId(providerId, 'fal-ai/nano-banana-2')),
    })
    const card = nano?.pricing as RateCard | null
    expect(card?.inputs.num_images).toMatchObject({ param: 'num_images' })
    expect(card?.source.hash).toBe(
      await pricingSectionHash(pricingSection(NANO_LLMS)),
    )
    expect(card?.source.url).toBe(falLlmsTxtUrl('fal-ai/nano-banana-2'))
    const sources = nano?.factSources as {
      pricing?: { derivation: string; sourceHash: string }
    }
    expect(sources.pricing?.derivation).toBe('docs-extracted')
    expect(
      await db.select().from(changes).where(eq(changes.providerId, providerId)),
    ).toHaveLength(2)

    extractedRawIds.length = 0
    const second = await extractFalPricing(deps)
    expect(second).toMatchObject({
      fetched: 2,
      extracted: 0,
      written: 0,
      hashSkipped: 2,
    })
    expect(extractedRawIds).toEqual([])
    expect(
      await db.select().from(changes).where(eq(changes.providerId, providerId)),
    ).toHaveLength(2)
  })

  it('caps fetches and resumes after the cursor', async () => {
    const providerId = 'extract-cursor'
    await seedProvider(providerId)
    const rawIds = ['fal-ai/a', 'fal-ai/b', 'fal-ai/c']
    for (const rawId of rawIds) {
      await seedCandidate({
        providerId,
        rawId,
        properties: { num_images: { type: 'integer' } },
      })
    }
    const seen: Array<string> = []
    const deps = {
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchCap: 2,
      extractCap: 20,
      fetchText: (url: string) => {
        seen.push(url)
        return Promise.resolve(NANO_LLMS)
      },
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> =>
        perImageCard(args.sourceUrl),
    }
    const first = await extractFalPricing(deps)
    expect(first.fetched).toBe(2)
    expect(first.cursor).toBe('fal-ai/b')
    expect(
      seen.map((url) =>
        url.replace(/.*\/models\//, '').replace(/\/llms.txt$/, ''),
      ),
    ).toEqual(['fal-ai/a', 'fal-ai/b'])
    const cursorRow = await getDb(env).query.cacheMeta.findFirst({
      where: eq(cacheMeta.key, falPricingExtractCursorKey(providerId)),
    })
    expect(cursorRow?.lastError).toBe('fal-ai/b')

    seen.length = 0
    const second = await extractFalPricing(deps)
    expect(second.fetched).toBe(2)
    expect(
      seen.map((url) =>
        url.replace(/.*\/models\//, '').replace(/\/llms.txt$/, ''),
      ),
    ).toEqual(['fal-ai/c', 'fal-ai/a'])
  })

  it('writes null for a stub Pricing section and keeps a previous card on unverified', async () => {
    const providerId = 'extract-stub'
    await seedProvider(providerId)
    const stubId = await seedCandidate({
      providerId,
      rawId: 'fal-ai/stub',
      properties: { prompt: { type: 'string' } },
    })
    const keptId = await seedCandidate({
      providerId,
      rawId: 'fal-ai/kept',
      properties: { num_images: { type: 'integer' } },
      pricing: perImageCard(falLlmsTxtUrl('fal-ai/kept')),
    })
    const files = new Map<string, string>([
      [falLlmsTxtUrl('fal-ai/stub'), STUB_LLMS],
      [falLlmsTxtUrl('fal-ai/kept'), NANO_LLMS],
    ])
    await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: (url: string) => Promise.resolve(files.get(url) ?? null),
      extractCard: async () => 'unverified',
    })
    const stub = await getDb(env).query.models.findFirst({
      where: eq(models.id, stubId),
    })
    const kept = await getDb(env).query.models.findFirst({
      where: eq(models.id, keptId),
    })
    expect(stub?.pricing).toBeNull()
    expect(kept?.pricing).toMatchObject({
      inputs: { num_images: { param: 'num_images' } },
    })
    expect(
      (kept!.factSources as { pricing?: { derivation: string } }).pricing
        ?.derivation,
    ).toBe('docs-extracted')
  })

  it('refuses invented request params and expired hash-skips re-extract', async () => {
    const providerId = 'extract-refuse'
    await seedProvider(providerId)
    const inventedId = await seedCandidate({
      providerId,
      rawId: 'fal-ai/invented',
      properties: { prompt: { type: 'string' } },
    })
    const expiredId = await seedCandidate({
      providerId,
      rawId: 'fal-ai/expired',
      properties: { num_images: { type: 'integer' } },
      pricing: {
        ...perImageCard(falLlmsTxtUrl('fal-ai/expired')),
        source: {
          ...dummySource(falLlmsTxtUrl('fal-ai/expired')),
          hash: await pricingSectionHash(pricingSection(NANO_LLMS)),
          expiresAt: '2020-01-01T00:00:00.000Z',
        },
      },
    })
    let extracts = 0
    const files = new Map<string, string>([
      [falLlmsTxtUrl('fal-ai/invented'), llmsWithRate('0.09')],
      [falLlmsTxtUrl('fal-ai/expired'), NANO_LLMS],
    ])
    await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: (url: string) => Promise.resolve(files.get(url) ?? null),
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> => {
        extracts++
        if (args.sourceUrl.includes('invented')) {
          return {
            inputs: {
              quality: { param: 'quality', kind: 'enum', values: ['hd'] },
            },
            tables: {},
            price: 0.08,
            examples: [
              { params: {}, usd: 0.08, quote: 'Your request will cost $0.08' },
            ],
            source: dummySource(args.sourceUrl),
          }
        }
        return perImageCard(args.sourceUrl)
      },
    })
    expect(extracts).toBe(2)
    const invented = await getDb(env).query.models.findFirst({
      where: eq(models.id, inventedId),
    })
    expect(invented?.pricing).toBeNull()
    const expired = await getDb(env).query.models.findFirst({
      where: eq(models.id, expiredId),
    })
    expect(
      (expired?.pricing as RateCard | null)?.source.expiresAt,
    ).toBeUndefined()
  })

  it('prices a unit-rate section with no activity and no input schema (#114)', async () => {
    const providerId = 'extract-named'
    await seedProvider(providerId)
    await getDb(env)
      .insert(models)
      .values({
        id: modelDbId(providerId, 'bria/ad-delayer'),
        providerId,
        rawId: 'bria/ad-delayer',
        activity: null,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      })
    await getDb(env)
      .insert(models)
      .values({
        id: modelDbId(providerId, 'fal-ai/aura-flow'),
        providerId,
        rawId: 'fal-ai/aura-flow',
        activity: null,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      })
    const files = new Map<string, string>([
      [
        falLlmsTxtUrl('bria/ad-delayer'),
        `# Delayer\n\n## Pricing\n\n- **Price**: $0.3 per requests\n\n## API Information\n`,
      ],
      [falLlmsTxtUrl('fal-ai/aura-flow'), STUB_LLMS],
    ])
    let extracted = 0
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: (url: string) => Promise.resolve(files.get(url) ?? null),
      extractCard: async (args: ExtractCardArgs) => {
        extracted++
        return perImageCard(args.sourceUrl)
      },
    })
    expect(outcome).toMatchObject({
      candidates: 2,
      compiled: 1,
      written: 1,
      refused: 1,
      extracted: 0,
    })
    expect(extracted).toBe(0)
    const db = getDb(env)
    const priced = await db.query.models.findFirst({
      where: eq(models.id, modelDbId(providerId, 'bria/ad-delayer')),
    })
    const card = priced?.pricing as RateCard | null
    expect(card?.examples[0]).toMatchObject({
      params: { requests: 1 },
      usd: 0.3,
    })
    const stub = await db.query.models.findFirst({
      where: eq(models.id, modelDbId(providerId, 'fal-ai/aura-flow')),
    })
    expect(stub?.pricing).toBeNull()
  })

  it('skips deprecated rows and still fetches rows with no input schema', async () => {
    const providerId = 'extract-skip'
    await seedProvider(providerId)
    await seedCandidate({
      providerId,
      rawId: 'fal-ai/live',
      properties: { num_images: { type: 'integer' } },
    })
    await seedCandidate({
      providerId,
      rawId: 'fal-ai/old',
      properties: { num_images: { type: 'integer' } },
      deprecated: true,
    })
    await getDb(env)
      .insert(models)
      .values({
        id: modelDbId(providerId, 'fal-ai/no-schema'),
        providerId,
        rawId: 'fal-ai/no-schema',
        activity: 'image',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      })
    const fetched: Array<string> = []
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: (url: string) => {
        fetched.push(url)
        return Promise.resolve(NANO_LLMS)
      },
      extractCard: async (args: ExtractCardArgs) =>
        perImageCard(args.sourceUrl),
    })
    expect(outcome.candidates).toBe(2)
    expect([...fetched].sort()).toEqual(
      [falLlmsTxtUrl('fal-ai/live'), falLlmsTxtUrl('fal-ai/no-schema')].sort(),
    )
  })

  it('stops extracting at the extract cap and retries the leftover next run', async () => {
    const providerId = 'extract-cap'
    await seedProvider(providerId)
    const rates = new Map([
      ['fal-ai/a', '0.08'],
      ['fal-ai/b', '0.09'],
      ['fal-ai/c', '0.10'],
    ])
    for (const rawId of rates.keys()) {
      await seedCandidate({
        providerId,
        rawId,
        properties: { num_images: { type: 'integer' } },
      })
    }
    let extracts = 0
    const deps = {
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchCap: 200,
      extractCap: 1,
      fetchText: (url: string) => {
        const rawId = url.replace(/.*\/models\//, '').replace(/\/llms.txt$/, '')
        return Promise.resolve(llmsWithRate(rates.get(rawId) ?? '0.08'))
      },
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> => {
        extracts++
        return perImageCard(args.sourceUrl)
      },
    }
    const first = await extractFalPricing(deps)
    expect(first.extracted).toBe(1)
    expect(first.written).toBe(1)
    expect(extracts).toBe(1)
    extracts = 0
    const second = await extractFalPricing(deps)
    expect(second.extracted).toBe(1)
    expect(extracts).toBe(1)
  })

  it('still compiles unit rates without the AI binding and skips only leftovers', async () => {
    const providerId = 'extract-nokey'
    await seedProvider(providerId)
    const unitId = await seedCandidate({
      providerId,
      rawId: 'fal-ai/aunit',
      properties: { num_images: { type: 'integer' } },
    })
    await seedCandidate({
      providerId,
      rawId: 'fal-ai/bleftover',
      properties: { num_images: { type: 'integer' } },
    })
    const files = new Map<string, string>([
      [falLlmsTxtUrl('fal-ai/aunit'), UNIT_LLMS],
      [falLlmsTxtUrl('fal-ai/bleftover'), NANO_LLMS],
    ])
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: (url: string) => Promise.resolve(files.get(url) ?? null),
    })
    expect(outcome.skipped).toContain('AI_GATEWAY_ID')
    expect(outcome).toMatchObject({ compiled: 1, written: 1, extracted: 0 })
    const unit = await getDb(env).query.models.findFirst({
      where: eq(models.id, unitId),
    })
    expect((unit?.pricing as RateCard | null)?.examples[0]).toMatchObject({
      params: { megapixels: 1 },
      usd: 0.04,
    })
  })

  it('does not advance the cursor on retryable llms.txt failures', async () => {
    const providerId = 'extract-fetchfail'
    await seedProvider(providerId)
    for (const rawId of ['fal-ai/a', 'fal-ai/b', 'fal-ai/c']) {
      await seedCandidate({
        providerId,
        rawId,
        properties: { num_images: { type: 'integer' } },
      })
    }
    const seen: Array<string> = []
    const deps = {
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: (url: string) => {
        seen.push(url)
        if (url.includes('/fal-ai/a/')) return Promise.resolve(NANO_LLMS)
        return Promise.resolve({ status: 503 })
      },
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> =>
        perImageCard(args.sourceUrl),
    }
    const first = await extractFalPricing(deps)
    expect(first.cursor).toBe('fal-ai/a')
    expect(first.fetchFailed).toBe(2)
    expect(first.written).toBe(1)
    seen.length = 0
    const second = await extractFalPricing(deps)
    expect(
      seen.map((url) =>
        url.replace(/.*\/models\//, '').replace(/\/llms.txt$/, ''),
      )[0],
    ).toBe('fal-ai/b')
    expect(second.cursor).toBe('fal-ai/a')
  })

  it('does not leapfrog a retryable hole when a later extract succeeds', async () => {
    const providerId = 'extract-fetchhole'
    await seedProvider(providerId)
    for (const rawId of ['fal-ai/a', 'fal-ai/b', 'fal-ai/c']) {
      await seedCandidate({
        providerId,
        rawId,
        properties: { num_images: { type: 'integer' } },
      })
    }
    const seen: Array<string> = []
    const first = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: (url: string) => {
        seen.push(url)
        if (url.includes('/fal-ai/b/')) return Promise.resolve({ status: 503 })
        return Promise.resolve(NANO_LLMS)
      },
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> =>
        perImageCard(args.sourceUrl),
    })
    expect(first.cursor).toBe('fal-ai/a')
    expect(first.written).toBe(2)
    expect(first.fetchFailed).toBe(1)
    seen.length = 0
    const second = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchCap: 1,
      fetchText: (url: string) => {
        seen.push(url)
        return Promise.resolve(NANO_LLMS)
      },
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> =>
        perImageCard(args.sourceUrl),
    })
    expect(
      seen.map((url) =>
        url.replace(/.*\/models\//, '').replace(/\/llms.txt$/, ''),
      ),
    ).toEqual(['fal-ai/b'])
    expect(second.cursor).toBe('fal-ai/b')
    expect(second.written).toBe(1)
  })

  it('aborts after consecutive retryable fetches without saving a cursor', async () => {
    const providerId = 'extract-fetchabort'
    await seedProvider(providerId)
    const rawIds = Array.from(
      { length: FAL_PRICING_FETCH_FAIL_ABORT + 2 },
      (_, i) => `fal-ai/${String(i).padStart(2, '0')}`,
    )
    for (const rawId of rawIds) {
      await seedCandidate({
        providerId,
        rawId,
        properties: { num_images: { type: 'integer' } },
      })
    }
    const seen: Array<string> = []
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: (url: string) => {
        seen.push(url)
        return Promise.resolve({ status: 503 })
      },
      extractCard: async () => {
        throw new Error('extract should not run')
      },
    })
    expect(outcome.fetched).toBe(FAL_PRICING_FETCH_FAIL_ABORT)
    expect(outcome.fetchFailed).toBe(FAL_PRICING_FETCH_FAIL_ABORT)
    expect(outcome.cursor).toBeNull()
    // Fetches run a window ahead, so a few more may be in flight than the
    // abort consumes — never more than the window.
    expect(seen.length).toBeGreaterThanOrEqual(FAL_PRICING_FETCH_FAIL_ABORT)
    expect(seen.length).toBeLessThanOrEqual(FAL_PRICING_FETCH_CONCURRENCY)
    expect(
      await getDb(env).query.cacheMeta.findFirst({
        where: eq(cacheMeta.key, falPricingExtractCursorKey(providerId)),
      }),
    ).toBeUndefined()
  })

  it('keeps a previous card and stamps the hash when examples are empty', async () => {
    const providerId = 'extract-empty-ex'
    await seedProvider(providerId)
    const rawId = 'fal-ai/kept'
    const previous = perImageCard(falLlmsTxtUrl(rawId))
    const id = await seedCandidate({
      providerId,
      rawId,
      properties: { num_images: { type: 'integer' } },
      pricing: previous,
      factSources: {
        pricing: {
          derivation: 'docs-extracted',
          sourceUrl: falLlmsTxtUrl(rawId),
          sourceHash: previous.source.hash,
          fetchedAt: NOW,
        },
      },
    })
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: () => Promise.resolve(NANO_LLMS),
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> => ({
        ...perImageCard(args.sourceUrl),
        examples: [],
      }),
    })
    expect(outcome.unverified).toBe(1)
    expect(outcome.written).toBe(0)
    const row = await getDb(env).query.models.findFirst({
      where: eq(models.id, id),
    })
    expect(row?.pricing).toMatchObject({
      inputs: { num_images: { param: 'num_images' } },
    })
    const sectionHash = await pricingSectionHash(pricingSection(NANO_LLMS))
    expect(
      (row!.factSources as { pricing?: { sourceHash: string } }).pricing
        ?.sourceHash,
    ).toBe(sectionHash)
  })

  it('keeps a previous card and does not stamp the hash when verifyExamples fails', async () => {
    const providerId = 'extract-verifyfail'
    await seedProvider(providerId)
    const rawId = 'fal-ai/kept'
    const previousHash = 'a'.repeat(64)
    const previous = perImageCard(falLlmsTxtUrl(rawId))
    const id = await seedCandidate({
      providerId,
      rawId,
      properties: { num_images: { type: 'integer' } },
      pricing: previous,
      factSources: {
        pricing: {
          derivation: 'docs-extracted',
          sourceUrl: falLlmsTxtUrl(rawId),
          sourceHash: previousHash,
          fetchedAt: NOW,
        },
      },
    })
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: () => Promise.resolve(NANO_LLMS),
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> => ({
        ...perImageCard(args.sourceUrl),
        examples: [
          {
            params: {},
            usd: 999,
            quote: 'Your request will cost $0.08 per image',
          },
        ],
      }),
    })
    expect(outcome.refused).toBe(1)
    expect(outcome.written).toBe(0)
    const row = await getDb(env).query.models.findFirst({
      where: eq(models.id, id),
    })
    expect((row?.pricing as RateCard | null)?.examples[0]?.usd).toBe(0.08)
    expect(
      (row!.factSources as { pricing?: { sourceHash: string } }).pricing
        ?.sourceHash,
    ).toBe(previousHash)
  })

  it('writes null over a previous card when Pricing is a stub', async () => {
    const providerId = 'extract-stub-overwrite'
    await seedProvider(providerId)
    const rawId = 'fal-ai/stub'
    const id = await seedCandidate({
      providerId,
      rawId,
      properties: { prompt: { type: 'string' } },
      pricing: perImageCard(falLlmsTxtUrl(rawId)),
      factSources: {
        pricing: {
          derivation: 'docs-extracted',
          sourceUrl: falLlmsTxtUrl(rawId),
          sourceHash: 'a'.repeat(64),
          fetchedAt: NOW,
        },
      },
    })
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: () => Promise.resolve(STUB_LLMS),
      extractCard: async () => {
        throw new Error('extract should not run on a stub')
      },
    })
    expect(outcome.refused).toBe(1)
    expect(outcome.written).toBe(1)
    const row = await getDb(env).query.models.findFirst({
      where: eq(models.id, id),
    })
    expect(row?.pricing).toBeNull()
    const sources = row?.factSources as {
      pricing?: { derivation: string; sourceHash: string }
    }
    expect(sources.pricing?.derivation).toBe('docs-extracted')
    expect(sources.pricing?.sourceHash).toBe(
      await pricingSectionHash(pricingSection(STUB_LLMS)),
    )
  })
  it('compiles unit-rate sections without calling the model', async () => {
    const providerId = 'extract-unit'
    await seedProvider(providerId)
    const id = await seedCandidate({
      providerId,
      rawId: 'fal-ai/unit',
      properties: { num_images: { type: 'integer' } },
    })
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: () => Promise.resolve(UNIT_LLMS),
      extractCard: () => {
        throw new Error('the parser should have handled this section')
      },
    })
    expect(outcome).toMatchObject({
      compiled: 1,
      extracted: 0,
      written: 1,
      refused: 0,
    })
    const row = await getDb(env).query.models.findFirst({
      where: eq(models.id, id),
    })
    const card = row?.pricing as RateCard | null
    expect(card?.examples[0]).toMatchObject({
      params: { megapixels: 1 },
      usd: 0.04,
    })
    expect(card?.source.hash).toBe(
      await pricingSectionHash(pricingSection(UNIT_LLMS)),
    )
    expect(card?.source.url).toBe(falLlmsTxtUrl('fal-ai/unit'))
  })

  it('copies one extract onto every row sharing a Pricing hash', async () => {
    const providerId = 'extract-dedup'
    await seedProvider(providerId)
    const rawIds = [
      'fal-ai/happy-horse/a',
      'fal-ai/happy-horse/b',
      'fal-ai/happy-horse/c',
    ]
    for (const rawId of rawIds) {
      await seedCandidate({
        providerId,
        rawId,
        properties: { num_images: { type: 'integer' } },
      })
    }
    let extracts = 0
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: () => Promise.resolve(NANO_LLMS),
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> => {
        extracts++
        return perImageCard(args.sourceUrl)
      },
    })
    expect(extracts).toBe(1)
    expect(outcome).toMatchObject({ extracted: 1, written: 3 })
    const hash = await pricingSectionHash(pricingSection(NANO_LLMS))
    for (const rawId of rawIds) {
      const row = await getDb(env).query.models.findFirst({
        where: eq(models.id, modelDbId(providerId, rawId)),
      })
      const card = row?.pricing as RateCard | null
      expect(card?.price).toEqual({ '*': [{ var: 'num_images' }, 0.08] })
      expect(card?.source.hash).toBe(hash)
      expect(card?.source.url).toBe(falLlmsTxtUrl(rawId))
    }
  })

  it('reuses a card another row already stores for the same hash', async () => {
    const providerId = 'extract-dedup-stored'
    await seedProvider(providerId)
    const hash = await pricingSectionHash(pricingSection(NANO_LLMS))
    await seedCandidate({
      providerId,
      rawId: 'fal-ai/apriced',
      properties: { num_images: { type: 'integer' } },
      pricing: {
        ...perImageCard(falLlmsTxtUrl('fal-ai/apriced')),
        source: { ...dummySource(falLlmsTxtUrl('fal-ai/apriced')), hash },
      },
    })
    const freshId = await seedCandidate({
      providerId,
      rawId: 'fal-ai/bfresh',
      properties: { num_images: { type: 'integer' } },
    })
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: () => Promise.resolve(NANO_LLMS),
      extractCard: () => {
        throw new Error('a stored card for this hash should have been reused')
      },
    })
    expect(outcome).toMatchObject({
      extracted: 0,
      deduped: 1,
      hashSkipped: 1,
      written: 1,
    })
    const fresh = await getDb(env).query.models.findFirst({
      where: eq(models.id, freshId),
    })
    expect((fresh?.pricing as RateCard | null)?.source).toMatchObject({
      hash,
      url: falLlmsTxtUrl('fal-ai/bfresh'),
    })
  })

  // #304: grok-imagine-video edit-video and extend-video share one Pricing
  // section, but only edit-video has `resolution`. Copying its card onto
  // extend-video was refused as invented_param on every lap.
  it('extracts its own card when the shared-hash card binds a param the row lacks', async () => {
    const providerId = 'extract-dedup-schema'
    await seedProvider(providerId)
    const hash = await pricingSectionHash(pricingSection(NANO_LLMS))
    await seedCandidate({
      providerId,
      rawId: 'fal-ai/apriced',
      properties: { num_images: { type: 'integer' } },
      pricing: {
        ...perImageCard(falLlmsTxtUrl('fal-ai/apriced')),
        source: { ...dummySource(falLlmsTxtUrl('fal-ai/apriced')), hash },
      },
    })
    const ids = []
    for (const rawId of ['fal-ai/bfresh', 'fal-ai/cfresh']) {
      ids.push(
        await seedCandidate({
          providerId,
          rawId,
          properties: { prompt: { type: 'string' } },
        }),
      )
    }
    const asked: Array<Array<string>> = []
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: () => Promise.resolve(NANO_LLMS),
      extractCard: (args: ExtractCardArgs): Promise<ExtractedCard> => {
        asked.push([...args.requestProperties].sort())
        const card = perImageCard(args.sourceUrl)
        return Promise.resolve({
          ...card,
          inputs: {
            num_images: { param: 'num_images', kind: 'number', bound: 'usage' },
          },
          examples: [{ ...card.examples[0]!, params: { num_images: 1 } }],
        })
      },
    })
    expect(asked).toEqual([['prompt']])
    expect(outcome).toMatchObject({ extracted: 1, refused: 0, written: 2 })
    for (const id of ids) {
      const row = await getDb(env).query.models.findFirst({
        where: eq(models.id, id),
      })
      expect((row?.pricing as RateCard | null)?.inputs.num_images).toEqual({
        param: 'num_images',
        kind: 'number',
        bound: 'usage',
      })
    }
  })

  it('prefers the fitting card that reads the most from the request', async () => {
    const providerId = 'extract-dedup-prefer'
    await seedProvider(providerId)
    const hash = await pricingSectionHash(pricingSection(NANO_LLMS))
    const usage = perImageCard(falLlmsTxtUrl('fal-ai/a-usage'))
    await seedCandidate({
      providerId,
      rawId: 'fal-ai/a-usage',
      properties: { prompt: { type: 'string' } },
      pricing: {
        ...usage,
        inputs: {
          num_images: { param: 'num_images', kind: 'number', bound: 'usage' },
        },
        examples: [{ ...usage.examples[0]!, params: { num_images: 1 } }],
        source: { ...usage.source, hash },
      },
    })
    await seedCandidate({
      providerId,
      rawId: 'fal-ai/b-request',
      properties: { num_images: { type: 'integer' } },
      pricing: {
        ...perImageCard(falLlmsTxtUrl('fal-ai/b-request')),
        source: { ...dummySource(falLlmsTxtUrl('fal-ai/b-request')), hash },
      },
    })
    const freshId = await seedCandidate({
      providerId,
      rawId: 'fal-ai/c-fresh',
      properties: { num_images: { type: 'integer' } },
    })
    await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: () => Promise.resolve(NANO_LLMS),
    })
    const fresh = await getDb(env).query.models.findFirst({
      where: eq(models.id, freshId),
    })
    expect((fresh?.pricing as RateCard | null)?.inputs.num_images).toEqual({
      param: 'num_images',
      kind: 'number',
      default: 1,
    })
  })

  it('re-extracts next run for a group row the shared card does not fit', async () => {
    const providerId = 'extract-group-schema'
    await seedProvider(providerId)
    await seedCandidate({
      providerId,
      rawId: 'fal-ai/a',
      properties: { num_images: { type: 'integer' } },
    })
    const bId = await seedCandidate({
      providerId,
      rawId: 'fal-ai/b',
      properties: { prompt: { type: 'string' } },
    })
    const asked: Array<Array<string>> = []
    const deps = {
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: () => Promise.resolve(NANO_LLMS),
      extractCard: (args: ExtractCardArgs): Promise<ExtractedCard> => {
        const allowed = [...args.requestProperties].sort()
        asked.push(allowed)
        const card = perImageCard(args.sourceUrl)
        if (allowed.includes('num_images')) return Promise.resolve(card)
        return Promise.resolve({
          ...card,
          inputs: {
            num_images: { param: 'num_images', kind: 'number', bound: 'usage' },
          },
          examples: [{ ...card.examples[0]!, params: { num_images: 1 } }],
        })
      },
    }
    // One group per section: written for a's schema, refused for b, and b
    // is held for a retry.
    expect(await extractFalPricing(deps)).toMatchObject({
      extracted: 1,
      refused: 1,
    })
    // The retry skips a's card (it binds num_images, which b lacks) and
    // asks for b's own.
    expect(await extractFalPricing(deps)).toMatchObject({
      extracted: 1,
      refused: 0,
      deduped: 0,
    })
    expect(asked).toEqual([['num_images'], ['prompt']])
    const b = await getDb(env).query.models.findFirst({
      where: eq(models.id, bId),
    })
    expect((b?.pricing as RateCard | null)?.inputs.num_images).toMatchObject({
      bound: 'usage',
    })
  })
})

describe('extractFalPricing retries (#84)', () => {
  it('re-extracts a null card stamped by an unverified leftover', async () => {
    const providerId = 'extract-retry-null'
    await seedProvider(providerId)
    const rawId = 'fal-ai/nano-banana-2'
    const id = await seedCandidate({
      providerId,
      rawId,
      properties: { num_images: { type: 'integer' } },
    })
    let extracts = 0
    const deps = {
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: () => Promise.resolve(NANO_LLMS),
      extractCard: async (): Promise<ExtractedCard> => {
        extracts++
        return 'unverified'
      },
    }
    const first = await extractFalPricing(deps)
    expect(first.unverified).toBe(1)
    const stamped = await getDb(env).query.models.findFirst({
      where: eq(models.id, id),
    })
    expect(stamped?.pricing).toBeNull()
    expect(
      (stamped!.factSources as { pricing?: { sourceHash?: string } }).pricing
        ?.sourceHash,
    ).toBe(await pricingSectionHash(pricingSection(NANO_LLMS)))

    const second = await extractFalPricing({
      ...deps,
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> => {
        extracts++
        return perImageCard(args.sourceUrl)
      },
    })
    expect(second).toMatchObject({ hashSkipped: 0, extracted: 1, written: 1 })
    expect(extracts).toBe(2)

    // Unchanged hash and a non-null card: no model call.
    const third = await extractFalPricing({
      ...deps,
      extractCard: () => {
        throw new Error('unchanged hash with a card must not re-extract')
      },
    })
    expect(third).toMatchObject({ hashSkipped: 1, extracted: 0 })
  })

  it('hash-skips a stub section that already stored null', async () => {
    const providerId = 'extract-stub-skip'
    await seedProvider(providerId)
    await seedCandidate({
      providerId,
      rawId: 'fal-ai/stub',
      properties: { prompt: { type: 'string' } },
    })
    const deps = {
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: () => Promise.resolve(STUB_LLMS),
      extractCard: () => {
        throw new Error('stubs never reach the model')
      },
    }
    const first = await extractFalPricing(deps)
    expect(first).toMatchObject({ refused: 1, hashSkipped: 0 })
    const second = await extractFalPricing(deps)
    expect(second).toMatchObject({ refused: 0, hashSkipped: 1 })
  })

  it('keeps compiling past the leftover cap and resumes on the first dropped row', async () => {
    const providerId = 'extract-cap-walk'
    await seedProvider(providerId)
    const files = new Map<string, string>([
      ['fal-ai/a', llmsWithRate('0.08')],
      ['fal-ai/b', llmsWithRate('0.09')],
      ['fal-ai/c', UNIT_LLMS],
    ])
    const ids = new Map<string, string>()
    for (const rawId of files.keys()) {
      ids.set(
        rawId,
        await seedCandidate({
          providerId,
          rawId,
          properties: { num_images: { type: 'integer' } },
        }),
      )
    }
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      extractCap: 1,
      fetchText: (url: string) => {
        const rawId = url.replace(/.*\/models\//, '').replace(/\/llms.txt$/, '')
        return Promise.resolve(files.get(rawId) ?? null)
      },
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> =>
        perImageCard(args.sourceUrl),
    })
    expect(outcome).toMatchObject({
      fetched: 3,
      extracted: 1,
      compiled: 1,
      cursor: 'fal-ai/a',
    })
    const c = await getDb(env).query.models.findFirst({
      where: eq(models.id, ids.get('fal-ai/c') ?? ''),
    })
    expect(c?.pricing).not.toBeNull()
  })
})

describe('extractFalPricing failed leftovers (#88)', () => {
  it('stamps a failed leftover and rewinds the cursor onto it once', async () => {
    const providerId = 'extract-hold'
    await seedProvider(providerId)
    const files = new Map<string, string>([
      ['fal-ai/a', UNIT_LLMS],
      ['fal-ai/b', NANO_LLMS],
      ['fal-ai/c', UNIT_LLMS],
    ])
    const ids = new Map<string, string>()
    for (const rawId of files.keys()) {
      ids.set(
        rawId,
        await seedCandidate({
          providerId,
          rawId,
          properties: { num_images: { type: 'integer' } },
        }),
      )
    }
    const seen: Array<string> = []
    let extracts = 0
    const deps = {
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchCap: 2,
      fetchText: (url: string) => {
        const rawId = url.replace(/.*\/models\//, '').replace(/\/llms.txt$/, '')
        seen.push(rawId)
        return Promise.resolve(files.get(rawId) ?? null)
      },
      extractCard: async (): Promise<ExtractedCard> => {
        extracts++
        return { error: 'xai 503: unavailable' }
      },
    }

    // a compiles, b fails: b is stamped, and the cursor stays on a.
    const first = await extractFalPricing(deps)
    expect(first).toMatchObject({
      extracted: 1,
      refused: 1,
      cursor: 'fal-ai/a',
    })
    const b = await getDb(env).query.models.findFirst({
      where: eq(models.id, ids.get('fal-ai/b') ?? ''),
    })
    expect(b?.pricing).toBeNull()
    expect(
      (b!.factSources as { pricing?: { sourceHash?: string } }).pricing
        ?.sourceHash,
    ).toBe(await pricingSectionHash(pricingSection(NANO_LLMS)))

    // The next shard starts on b and retries it; failing again while held
    // moves the walk on instead of stalling there.
    seen.length = 0
    const second = await extractFalPricing(deps)
    expect(seen.slice(0, 2)).toEqual(['fal-ai/b', 'fal-ai/c'])
    expect(second).toMatchObject({ extracted: 1, cursor: 'fal-ai/c' })
    expect(extracts).toBe(2)

    // Once held, a success clears the way as usual.
    seen.length = 0
    const third = await extractFalPricing({
      ...deps,
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> =>
        perImageCard(args.sourceUrl),
    })
    expect(seen.slice(0, 2)).toEqual(['fal-ai/a', 'fal-ai/b'])
    expect(third).toMatchObject({ written: 1, cursor: 'fal-ai/b' })
  })

  it('holds the cursor when an extracted card is refused for a row', async () => {
    const providerId = 'extract-hold-refused'
    await seedProvider(providerId)
    for (const rawId of ['fal-ai/a', 'fal-ai/b']) {
      await seedCandidate({
        providerId,
        rawId,
        properties: { num_images: { type: 'integer' } },
      })
    }
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: (url: string) =>
        Promise.resolve(url.includes('/fal-ai/a/') ? UNIT_LLMS : NANO_LLMS),
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> => ({
        ...perImageCard(args.sourceUrl),
        inputs: {
          num_images: { param: 'image_count', kind: 'number', default: 1 },
        },
      }),
    })
    expect(outcome).toMatchObject({ refused: 1, cursor: 'fal-ai/a' })
  })
})

describe('extractFalPricing failure reasons (#394)', () => {
  it('puts why the extract failed on the leftover retry event', async () => {
    const providerId = 'extract-fail-reason'
    await seedProvider(providerId)
    await seedCandidate({
      providerId,
      rawId: 'fal-ai/a',
      properties: { num_images: { type: 'integer' } },
    })
    const batches: Array<PostHogBatch> = []
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        if (requestUrl(input) === POSTHOG_CAPTURE_URL) {
          batches.push(JSON.parse(bodyText(init?.body)) as PostHogBatch)
        }
        return new Response('', { status: 200 })
      }),
    )
    try {
      await extractFalPricing({
        db: getDb(env),
        kv: env.SCHEMA_CACHE,
        secrets: { POSTHOG_PROJECT_KEY: 'phc_test' },
        now: () => NOW,
        providerId,
        fetchText: () => Promise.resolve(NANO_LLMS),
        extractCard: async (): Promise<ExtractedCard> => ({
          error: 'xai 429: rate limited',
        }),
      })
    } finally {
      vi.unstubAllGlobals()
    }
    const failed = batches
      .flatMap((batch) => batch.batch)
      .filter((event) => event.event === 'ingest_failed')
    expect(failed.map((event) => event.properties)).toEqual([
      expect.objectContaining({
        job: 'fal-pricing-extract',
        providerId,
        error: 'leftover retry: 1 | xai 429: rate limited',
      }),
    ])
  })
})
