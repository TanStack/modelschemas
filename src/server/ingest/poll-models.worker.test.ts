import { describe, expect, it } from 'vitest'
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'
import { FIXTURE_CARDS } from '../../../packages/rate-card/src/fixtures/index.ts'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'

import { getDb } from '../../db/index.ts'
import {
  cacheMeta,
  changes,
  endpoints,
  models,
  providers,
  schemaVersions,
} from '../../db/schema.ts'
import { parseHuggingFaceModels } from '../providers/adapters/huggingface.ts'
import {
  cachedDocs,
  docsReport,
  docsRun,
  tryDocs,
  unavailable,
} from '../providers/model-facts.ts'
import type {
  ModelInfo,
  ModelFactSources,
  ProviderConfig,
} from '../providers/types.ts'
import {
  readDocsFailing,
  readIngestRecords,
  recordDocsFailing,
} from './docs-failing.ts'
import { runIngestScope, takeIngestEvents } from './ingest-signals.ts'
import {
  D1_WINDOW_WAIT_MS,
  LAST_SEEN_CHUNK,
  d1WindowExhausted,
  modelDbId,
  pollAllProviders,
  pollProviderModels,
} from './poll-models.ts'
import {
  MODELS_DEV_API_URL,
  MODELS_DEV_CARD_CHUNK,
} from './retire-models-dev.ts'
import type { SyncDeps } from './sync.ts'

import {
  openrouterProvider,
  openrouterCapabilities,
} from '../providers/openrouter.ts'
import nativeRouterModels from '../providers/fixtures/openrouter-native-catalog-flags.json'

function stubProvider(id: string, list: Array<ModelInfo>): ProviderConfig {
  return {
    id,
    displayName: 'Stub',
    defaultDerivation: 'upstream-spec',
    fetchSpec: () =>
      Promise.resolve({
        specs: [],
        sources: [],
        outputStrategy: 'post-200' as const,
      }),
    listModels: () => Promise.resolve({ models: list }),
    classify: () => null,
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

const fable: ModelInfo = {
  rawId: 'claude-fable-5',
  displayName: 'Claude Fable 5',
  activity: 'chat',
  contextWindow: 200_000,
}
const haiku: ModelInfo = {
  rawId: 'claude-haiku-4-5',
  displayName: 'Claude Haiku 4.5',
  activity: 'chat',
}

describe('pollProviderModels', () => {
  it('clears a stored heuristic map when the native listing explicitly reports unknown', async () => {
    const id = 'openai'
    const deps = await freshDeps(id)
    const rawId = 'native-map-unverified'
    await pollProviderModels(
      deps,
      stubProvider(id, [{ rawId, activity: 'chat' }]),
    )
    const before = await deps.db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(id, rawId)))
    expect(before[0]?.requestMap).toMatchObject({
      thinking: { on: { reasoning_effort: 'high' } },
    })
    await pollProviderModels(
      deps,
      stubProvider(id, [{ rawId, activity: 'chat', requestMap: null }]),
    )
    const after = await deps.db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(id, rawId)))
    expect(after[0]?.requestMap).toBeNull()
  })
  it('never refills unknown OpenRouter or Together caller controls with static host recipes', async () => {
    for (const id of ['openrouter', 'together']) {
      const deps = await freshDeps(id)
      const rawId = 'native-unknown-controls'
      await pollProviderModels(
        deps,
        stubProvider(id, [
          {
            rawId,
            activity: 'chat',
            capabilities: ['reasoning'],
            reasoning: null,
            requestMap: null,
          },
        ]),
      )
      await pollProviderModels(
        deps,
        stubProvider(id, [
          {
            rawId,
            activity: 'chat',
            capabilities: ['reasoning'],
            reasoning: null,
          },
        ]),
      )
      const rows = await deps.db
        .select()
        .from(models)
        .where(eq(models.id, modelDbId(id, rawId)))
      expect(rows[0]?.requestMap).toBeNull()
    }
  })

  it('clears legacy NVIDIA static request fields when native wire evidence is unknown or unavailable', async () => {
    const deps = await freshDeps('nvidia')
    const rawId = 'native-wire-unknown'
    await pollProviderModels(
      deps,
      stubProvider('nvidia', [
        {
          rawId,
          activity: 'chat',
          requestMap: {
            thinking: null,
            maxTokensField: 'max_tokens',
            developerRole: false,
            replayReasoningContent: null,
            store: null,
            strictTools: null,
            sessionAffinity: null,
            cacheControl: null,
            toolStream: null,
            reasoningEffort: null,
          },
        },
      ]),
    )
    const legacy = await deps.db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId('nvidia', rawId)))
    expect(legacy[0]?.requestMap).toMatchObject({
      maxTokensField: 'max_tokens',
      developerRole: false,
    })
    await pollProviderModels(
      deps,
      stubProvider('nvidia', [
        {
          rawId,
          activity: 'chat',
          requestMap: null,
          absent: { reasoning: 'unavailable', schemaEndpointId: 'unavailable' },
        },
      ]),
    )
    const unknown = await deps.db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId('nvidia', rawId)))
    expect(unknown[0]?.requestMap).toBeNull()
    await pollProviderModels(
      deps,
      stubProvider('nvidia', [{ rawId, activity: 'chat' }]),
    )
    const unbound = await deps.db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId('nvidia', rawId)))
    expect(unbound[0]?.requestMap).toBeNull()
  })

  it('covers add / no-change / update / remove cycles', async () => {
    const id = 'poll-main'
    const deps = await freshDeps(id)
    const db = deps.db

    // Add: both models inserted with model.added changes.
    const first = await pollProviderModels(
      deps,
      stubProvider(id, [fable, haiku]),
    )
    expect(first).toMatchObject({ added: 2, removed: 0, updated: 0 })
    const rows = await db.select().from(models).where(eq(models.providerId, id))
    expect(rows).toHaveLength(2)
    expect(rows.map((m) => m.id).sort()).toEqual([
      modelDbId(id, 'claude-fable-5'),
      modelDbId(id, 'claude-haiku-4-5'),
    ])

    // No-change: lastSeenAt bumps, zero changes written.
    const second = await pollProviderModels(
      deps,
      stubProvider(id, [fable, haiku]),
    )
    expect(second).toMatchObject({ added: 0, removed: 0, updated: 0 })
    const afterSecond = await db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(id, 'claude-fable-5')))
    expect(afterSecond[0]?.lastSeenAt).toBeGreaterThan(
      afterSecond[0]?.firstSeenAt ?? 0,
    )
    expect(
      await db.select().from(changes).where(eq(changes.providerId, id)),
    ).toHaveLength(2)

    // Update: context window grows → one model.updated with before/after.
    const third = await pollProviderModels(
      deps,
      stubProvider(id, [{ ...fable, contextWindow: 500_000 }, haiku]),
    )
    expect(third).toMatchObject({ added: 0, removed: 0, updated: 1 })
    const updatedChange = (
      await db.select().from(changes).where(eq(changes.providerId, id))
    ).find((c) => c.type === 'model.updated')
    const payload = updatedChange?.payload as {
      before: { contextWindow: number }
      after: { contextWindow: number }
      changed: Array<string>
    }
    expect(payload.before.contextWindow).toBe(200_000)
    expect(payload.after.contextWindow).toBe(500_000)
    expect(payload.changed).toEqual(['contextWindow'])

    // Remove: haiku vanishes → deprecatedAt set + model.removed, once.
    const fourth = await pollProviderModels(
      deps,
      stubProvider(id, [{ ...fable, contextWindow: 500_000 }]),
    )
    expect(fourth).toMatchObject({ added: 0, removed: 1, updated: 0 })
    const fifth = await pollProviderModels(
      deps,
      stubProvider(id, [{ ...fable, contextWindow: 500_000 }]),
    )
    expect(fifth.removed).toBe(0) // already deprecated — no duplicate change
    const haikuRow = await db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(id, 'claude-haiku-4-5')))
    expect(haikuRow[0]?.deprecatedAt).not.toBeNull()

    // Reappearance clears deprecation via model.updated.
    const sixth = await pollProviderModels(
      deps,
      stubProvider(id, [{ ...fable, contextWindow: 500_000 }, haiku]),
    )
    expect(sixth.updated).toBe(1)
    const haikuBack = await db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(id, 'claude-haiku-4-5')))
    expect(haikuBack[0]?.deprecatedAt).toBeNull()

    // lastPolledAt recorded on the provider.
    const providerRow = await db.query.providers.findFirst({
      where: eq(providers.id, id),
    })
    expect(providerRow?.lastPolledAt).not.toBeNull()
  })

  it('preserves capabilities.asyncapi when the listing omits it', async () => {
    const id = 'poll-asyncapi'
    const deps = await freshDeps(id)
    const rawId = 'minimax/h3-max/director'
    await pollProviderModels(
      deps,
      stubProvider(id, [
        {
          rawId,
          activity: 'video',
          providerMetadata: { category: 'text-to-video' },
        },
      ]),
    )
    // Sync, not the listing, writes the flag.
    await deps.db
      .update(models)
      .set({ capabilities: { asyncapi: true } })
      .where(eq(models.id, modelDbId(id, rawId)))
    const again = await pollProviderModels(
      deps,
      stubProvider(id, [
        {
          rawId,
          activity: 'video',
          providerMetadata: { category: 'text-to-video' },
        },
      ]),
    )
    expect(again).toMatchObject({ added: 0, removed: 0, updated: 0 })
    const row = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, rawId)),
    })
    expect(row?.capabilities).toEqual({ asyncapi: true })
    expect(row?.providerMetadata).toEqual({ category: 'text-to-video' })
  })

  it('bulk-bumps lastSeenAt across chunk boundaries for unchanged models', async () => {
    const id = 'poll-bulk'
    const deps = await freshDeps(id)
    // 200 models spans ten 20-id UPDATE chunks.
    const herd: Array<ModelInfo> = Array.from({ length: 200 }, (_, i) => ({
      rawId: `model-${String(i)}`,
      displayName: `Model ${String(i)}`,
      activity: 'chat',
    }))

    const first = await pollProviderModels(deps, stubProvider(id, herd))
    expect(first).toMatchObject({ added: 200, removed: 0, updated: 0 })

    const second = await pollProviderModels(deps, stubProvider(id, herd))
    expect(second).toMatchObject({ added: 0, removed: 0, updated: 0 })
    const rows = await deps.db
      .select()
      .from(models)
      .where(eq(models.providerId, id))
    expect(rows).toHaveLength(200)
    for (const row of rows) {
      expect(row.lastSeenAt).toBeGreaterThan(row.firstSeenAt)
    }

    // Fleet-wide backdate (the first-pass-after-deploy shape) spans seven
    // 30-row CASE chunks; each row gets its own date.
    const BASE = 1_700_000_000
    const dated = herd.map((m, i) => ({ ...m, releasedAt: BASE + i }))
    const third = await pollProviderModels(deps, stubProvider(id, dated))
    expect(third).toMatchObject({ added: 0, updated: 0, backdated: 200 })
    const backdatedRows = await deps.db
      .select()
      .from(models)
      .where(eq(models.providerId, id))
    for (const row of backdatedRows) {
      const i = Number(row.rawId.replace('model-', ''))
      expect(row.firstSeenAt).toBe(BASE + i)
      expect(row.lastSeenAt).toBeGreaterThan(row.firstSeenAt)
    }

    // Converged: the same dates no longer count as backdates.
    const fourth = await pollProviderModels(deps, stubProvider(id, dated))
    expect(fourth).toMatchObject({ backdated: 0 })
  }, 15_000)

  it('backdates firstSeenAt to the upstream release date (issue #1)', async () => {
    const id = 'poll-backdate'
    const deps = await freshDeps(id)
    const db = deps.db
    const RELEASE = 1_700_000_000 // well before the test clock's 1_781_150_000

    // Insert: a reported release date becomes firstSeenAt directly.
    const first = await pollProviderModels(
      deps,
      stubProvider(id, [{ ...fable, releasedAt: RELEASE }]),
    )
    expect(first).toMatchObject({ added: 1 })
    const fableId = modelDbId(id, 'claude-fable-5')
    let row = await db.select().from(models).where(eq(models.id, fableId))
    expect(row[0]?.firstSeenAt).toBe(RELEASE)
    expect(row[0]?.lastSeenAt).toBeGreaterThan(RELEASE)

    // Insert without a date: poll-time firstSeenAt, as before.
    await pollProviderModels(deps, stubProvider(id, [fable, haiku]))
    const haikuId = modelDbId(id, 'claude-haiku-4-5')
    let haikuRow = await db.select().from(models).where(eq(models.id, haikuId))
    expect(haikuRow[0]?.firstSeenAt).toBeGreaterThan(RELEASE)
    const observedFirstSeen = haikuRow[0]?.firstSeenAt ?? 0
    const changeCount = (
      await db.select().from(changes).where(eq(changes.providerId, id))
    ).length

    // Existing otherwise-unchanged row gains a date → backdated silently
    // (no model.updated event), lastSeenAt still bumped.
    const backfill = await pollProviderModels(
      deps,
      stubProvider(id, [fable, { ...haiku, releasedAt: RELEASE + 1 }]),
    )
    expect(backfill).toMatchObject({ updated: 0, backdated: 1 })
    haikuRow = await db.select().from(models).where(eq(models.id, haikuId))
    expect(haikuRow[0]?.firstSeenAt).toBe(RELEASE + 1)
    expect(haikuRow[0]?.lastSeenAt).toBeGreaterThan(observedFirstSeen)
    expect(
      await db.select().from(changes).where(eq(changes.providerId, id)),
    ).toHaveLength(changeCount)

    // Never forward-dates: a later/bogus releasedAt leaves firstSeenAt alone.
    const noop = await pollProviderModels(
      deps,
      stubProvider(id, [
        { ...fable, releasedAt: RELEASE + 999_999_999 }, // future
        { ...haiku, releasedAt: 0 }, // bogus
      ]),
    )
    expect(noop.backdated).toBe(0)
    row = await db.select().from(models).where(eq(models.id, fableId))
    haikuRow = await db.select().from(models).where(eq(models.id, haikuId))
    expect(row[0]?.firstSeenAt).toBe(RELEASE)
    expect(haikuRow[0]?.firstSeenAt).toBe(RELEASE + 1)

    // Backdate composes with a real update: firstSeenAt and the mutable
    // field change land together, and the update event still fires.
    const combo = await pollProviderModels(
      deps,
      stubProvider(id, [
        { ...fable, contextWindow: 500_000, releasedAt: RELEASE - 50 },
        { ...haiku, releasedAt: RELEASE + 1 },
      ]),
    )
    expect(combo).toMatchObject({ updated: 1, backdated: 1 })
    row = await db.select().from(models).where(eq(models.id, fableId))
    expect(row[0]?.firstSeenAt).toBe(RELEASE - 50)
    expect(row[0]?.contextWindow).toBe(500_000)
  })

  it('stores the provider date as releasedAt, filling stored rows silently', async () => {
    const id = 'poll-released'
    const deps = await freshDeps(id)
    const RELEASE = 1_700_000_000
    const row = async (rawId: string) =>
      (
        await deps.db
          .select()
          .from(models)
          .where(eq(models.id, modelDbId(id, rawId)))
      )[0]
    const updates = async () =>
      (await deps.db.select().from(changes).where(eq(changes.providerId, id)))
        .filter((change) => change.type === 'model.updated')
        .map((change) => change.payload)

    // New rows: the stated date, or null. firstSeenAt is as before.
    await pollProviderModels(
      deps,
      stubProvider(id, [{ ...fable, releasedAt: RELEASE }, haiku]),
    )
    expect(await row('claude-fable-5')).toMatchObject({
      releasedAt: RELEASE,
      firstSeenAt: RELEASE,
    })
    expect((await row('claude-haiku-4-5'))?.releasedAt).toBeNull()

    // A stored row's first date (the post-deploy backfill): no model.updated.
    const fill = await pollProviderModels(
      deps,
      stubProvider(id, [
        { ...fable, releasedAt: RELEASE },
        { ...haiku, releasedAt: RELEASE + 1 },
      ]),
    )
    expect(fill).toMatchObject({ updated: 0 })
    expect((await row('claude-haiku-4-5'))?.releasedAt).toBe(RELEASE + 1)
    // The fable row was in the same bulk write and kept both dates.
    expect(await row('claude-fable-5')).toMatchObject({
      releasedAt: RELEASE,
      firstSeenAt: RELEASE,
    })
    expect(await updates()).toHaveLength(0)

    // Unchanged, and a listing that stops stating the date: nothing moves.
    const again = await pollProviderModels(
      deps,
      stubProvider(id, [fable, { ...haiku, releasedAt: RELEASE + 1 }]),
    )
    expect(again).toMatchObject({ updated: 0, backdated: 0 })
    expect((await row('claude-fable-5'))?.releasedAt).toBe(RELEASE)

    // A date that moves is a change, and so is one the adapter clears.
    const moved = await pollProviderModels(
      deps,
      stubProvider(id, [
        { ...fable, absent: { releasedAt: 'cleared' } },
        { ...haiku, releasedAt: RELEASE + 2 },
      ]),
    )
    expect(moved).toMatchObject({ updated: 2 })
    expect((await row('claude-fable-5'))?.releasedAt).toBeNull()
    expect(JSON.stringify(await updates())).toContain(
      `"releasedAt":${String(RELEASE + 2)}`,
    )
  })

  it('stores stated noes, and derives them for a whole flag list', async () => {
    const id = 'poll-unsupported'
    const deps = await freshDeps(id)
    const exact = (rawId: string, capabilities: Array<string>): ModelInfo => ({
      rawId,
      activity: 'chat',
      capabilities,
      exactCapabilities: true,
      factSources: {
        capabilities: Object.fromEntries(
          capabilities.map((flag) => [
            flag,
            { derivation: 'listing', sourceUrl: 'https://acme.example/m' },
          ]),
        ),
      },
    })
    const listed = [
      exact('both', ['tools', 'reasoning']),
      exact('tools-only', ['tools']),
      exact('none', []),
      // Not exact: a missing flag is unknown, whatever its siblings list.
      { rawId: 'open', activity: 'chat' as const, capabilities: ['tools'] },
      // Stated outright, with no list of yeses at all.
      {
        rawId: 'stated',
        activity: 'chat' as const,
        capabilities: ['tools'],
        unsupportedCapabilities: ['vision'],
      },
      { rawId: 'only-no', unsupportedCapabilities: ['tools'] },
      { rawId: 'empty', capabilities: [] },
    ]
    await pollProviderModels(deps, stubProvider(id, listed))
    const rows = await deps.db
      .select()
      .from(models)
      .where(eq(models.providerId, id))
    const of = (rawId: string) => rows.find((row) => row.rawId === rawId)
    expect(of('both')?.capabilities).toEqual({ tools: true, reasoning: true })
    expect(of('tools-only')?.capabilities).toEqual({
      tools: true,
      reasoning: false,
    })
    expect(of('tools-only')?.factSources).toMatchObject({
      capabilities: {
        tools: { sourceUrl: 'https://acme.example/m' },
        reasoning: { sourceUrl: 'https://acme.example/m', path: 'unlisted' },
      },
    })
    // The vocabulary is what the exact rows list: no global flag list.
    expect(of('none')?.capabilities).toEqual({ tools: false, reasoning: false })
    expect(of('open')?.capabilities).toEqual({ tools: true })
    expect(of('stated')?.capabilities).toEqual({ tools: true, vision: false })
    expect(of('stated')?.factSources).toMatchObject({
      capabilities: { vision: { derivation: 'listing' } },
    })
    expect(of('only-no')?.capabilities).toEqual({ tools: false })
    // A list that states nothing is nothing known, not an empty map.
    expect(of('empty')?.capabilities).toBeNull()

    // The same listing again changes nothing.
    const again = await pollProviderModels(deps, stubProvider(id, listed))
    expect(again).toMatchObject({ added: 0, updated: 0 })
  })

  it('refuses flags that are both yes and no, or not a flag list', async () => {
    const id = 'poll-flag-gate'
    const deps = await freshDeps(id)
    const poll = (list: Array<ModelInfo>) =>
      runIngestScope(async () => {
        const outcome = await pollProviderModels(deps, stubProvider(id, list))
        return { outcome, events: JSON.stringify(takeIngestEvents()) }
      })
    const stored = async (rawId: string) =>
      (
        await deps.db
          .select()
          .from(models)
          .where(eq(models.id, modelDbId(id, rawId)))
      )[0]?.capabilities
    await poll([
      { rawId: 'a', capabilities: ['tools'] },
      { rawId: 'b', capabilities: ['tools'] },
    ])

    const bad = await poll([
      {
        rawId: 'a',
        capabilities: ['tools', 'seed'],
        unsupportedCapabilities: ['tools'],
      },
      // A provider's native object belongs in `providerMetadata`.
      { rawId: 'b', capabilities: { category: 'text-to-image' } },
      { rawId: 'new', capabilities: { category: 'llm' } },
    ])
    expect(bad.events).toContain(
      'a: capabilities not stored: tools listed as both supported and unsupported',
    )
    expect(bad.events).toContain('b: capabilities not stored: not a flag list')
    // Fail closed: each row keeps what it had, and nothing reads as changed.
    expect(bad.outcome).toMatchObject({ added: 1, updated: 0 })
    expect(await stored('a')).toEqual({ tools: true })
    expect(await stored('b')).toEqual({ tools: true })
    expect(await stored('new')).toBeNull()
  })

  it('stores the listing object as providerMetadata, the first one silently', async () => {
    const id = 'poll-metadata'
    const deps = await freshDeps(id)
    const flux: ModelInfo = { rawId: 'flux', activity: 'image' }
    const row = async () =>
      (
        await deps.db
          .select()
          .from(models)
          .where(eq(models.id, modelDbId(id, 'flux')))
      )[0]
    await pollProviderModels(deps, stubProvider(id, [flux]))
    expect((await row())?.providerMetadata).toBeNull()

    // A stored row's first object (the column is new): no model.updated.
    const withMetadata = { ...flux, providerMetadata: { category: 'a' } }
    const first = await pollProviderModels(
      deps,
      stubProvider(id, [withMetadata]),
    )
    expect(first).toMatchObject({ updated: 0 })
    expect(await row()).toMatchObject({
      providerMetadata: { category: 'a' },
      capabilities: null,
    })
    expect(
      await pollProviderModels(deps, stubProvider(id, [withMetadata])),
    ).toMatchObject({ updated: 0 })

    // After that it is a fact like any other.
    const moved = await pollProviderModels(
      deps,
      stubProvider(id, [{ ...flux, providerMetadata: { category: 'b' } }]),
    )
    expect(moved).toMatchObject({ updated: 1 })
    expect((await row())?.providerMetadata).toEqual({ category: 'b' })
  })

  it('stores a cutoff only in its format and a weights link only beside a yes', async () => {
    const id = 'poll-stated-facts'
    const deps = await freshDeps(id)
    const poll = (list: Array<ModelInfo>) =>
      runIngestScope(async () => {
        const outcome = await pollProviderModels(deps, stubProvider(id, list))
        return { outcome, events: takeIngestEvents() }
      })
    const row = async (rawId: string) =>
      (
        await deps.db
          .select()
          .from(models)
          .where(eq(models.id, modelDbId(id, rawId)))
      )[0]

    await poll([
      {
        ...fable,
        knowledgeCutoff: '2025-06',
        openWeights: true,
        weightsUrl: 'https://acme.example/weights',
      },
      {
        ...haiku,
        knowledgeCutoff: '2025-06-30',
        openWeights: false,
        weightsUrl: 'https://acme.example/nope',
      },
    ])
    expect(await row('claude-fable-5')).toMatchObject({
      knowledgeCutoff: '2025-06',
      openWeights: true,
      weightsUrl: 'https://acme.example/weights',
      factSources: {
        knowledgeCutoff: { derivation: 'listing' },
        openWeights: { derivation: 'listing' },
      },
    })
    expect(await row('claude-haiku-4-5')).toMatchObject({
      knowledgeCutoff: '2025-06-30',
      openWeights: false,
      weightsUrl: null,
    })

    // A cutoff in another shape is refused; the stored one stays.
    const bad = await poll([
      { ...fable, knowledgeCutoff: 'June 2025', openWeights: true },
      // `unavailable` keeps the pair; a bare omission would null it.
      { ...haiku, absent: { knowledgeCutoff: 'unavailable' } },
    ])
    expect(JSON.stringify(bad.events)).toContain('knowledgeCutoff not stored')
    expect(await row('claude-fable-5')).toMatchObject({
      knowledgeCutoff: '2025-06',
      weightsUrl: null,
    })
    expect(await row('claude-haiku-4-5')).toMatchObject({
      knowledgeCutoff: '2025-06-30',
      openWeights: null,
    })
  })

  it('reports skipped providers without touching the database', async () => {
    const id = 'poll-skipped'
    const deps = await freshDeps(id)
    const skippy: ProviderConfig = {
      ...stubProvider(id, [fable]),
      listModels: () =>
        Promise.resolve({
          models: [],
          skipped: 'stub: STUB_KEY not set — skipped',
        }),
    }
    const outcome = await pollProviderModels(deps, skippy)
    expect(outcome.skipped).toContain('STUB_KEY')
    expect(
      await deps.db.select().from(models).where(eq(models.providerId, id)),
    ).toHaveLength(0)
    const providerRow = await deps.db.query.providers.findFirst({
      where: eq(providers.id, id),
    })
    expect(providerRow?.lastPolledAt).toBeNull()
  })

  it('slugifies raw ids with slashes and dots', () => {
    expect(modelDbId('fal', 'fal-ai/flux/dev')).toBe('fal-fal-ai-flux-dev')
    expect(modelDbId('openrouter', 'openai/gpt-4.1')).toBe(
      'openrouter-openai-gpt-4-1',
    )
  })

  it('fills request-feature flags from the bound input schema', async () => {
    const id = 'poll-schema'
    const deps = await freshDeps(id)
    const db = deps.db
    await db.insert(endpoints).values({
      id: `${id}/v1/messages`,
      providerId: id,
      activity: 'chat',
      method: 'POST',
      path: '/v1/messages',
    })
    await db.insert(schemaVersions).values({
      id: `${id}/v1/messages:input`,
      endpointId: `${id}/v1/messages`,
      kind: 'input',
      contentHash: 'a'.repeat(64),
      schema: JSON.stringify({
        properties: {
          tools: { type: 'array' },
          temperature: { type: 'number' },
        },
      }),
      derivation: 'upstream-spec',
      sourceUrl: 'https://example.com/openapi.json',
      createdAt: 1_781_150_000,
    })
    const outcome = await pollProviderModels(deps, {
      ...stubProvider(id, [
        {
          rawId: 'claude-sonnet-4-5',
          activity: 'chat',
          contextWindow: 200_000,
          schemaEndpointId: 'v1/messages',
        },
      ]),
    })
    expect(outcome.added).toBe(1)
    const row = await db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(id, 'claude-sonnet-4-5')))
    expect(row[0]?.capabilities).toEqual({ tools: true, temperature: true })
    const sources = row[0]?.factSources as {
      contextWindow?: { derivation: string }
      capabilities?: Record<string, { derivation: string; endpointId?: string }>
    }
    expect(sources.contextWindow?.derivation).toBe('listing')
    expect(sources.capabilities?.tools).toMatchObject({
      derivation: 'upstream-spec',
      endpointId: 'v1/messages',
    })
  })

  it('binds a listed route only once its input schema is synced', async () => {
    const id = 'poll-synced-routes'
    const deps = await freshDeps(id)
    const provider = {
      ...stubProvider(id, [
        {
          rawId: 'acme/llm',
          activity: 'chat',
          schemaEndpointId: 'models/acme/llm/predictions',
        },
      ]),
      bindSyncedRoutesOnly: true,
    }
    const stored = async () =>
      (
        await deps.db
          .select()
          .from(models)
          .where(eq(models.id, modelDbId(id, 'acme/llm')))
      )[0]?.schemaEndpointId

    // Poll before the sync has created the route: no link to a 404.
    await pollProviderModels(deps, provider)
    expect(await stored()).toBeNull()

    await deps.db.insert(endpoints).values({
      id: `${id}/models/acme/llm/predictions`,
      providerId: id,
      activity: 'chat',
      method: 'POST',
      path: '/models/acme/llm/predictions',
    })
    await deps.db.insert(schemaVersions).values({
      id: `${id}/models/acme/llm/predictions:input`,
      endpointId: `${id}/models/acme/llm/predictions`,
      kind: 'input',
      contentHash: 'b'.repeat(64),
      schema: JSON.stringify({ properties: { input: { type: 'object' } } }),
      derivation: 'upstream-spec',
      createdAt: 1_781_150_000,
    })
    await pollProviderModels(deps, provider)
    expect(await stored()).toBe('models/acme/llm/predictions')

    // Without the flag a listed route is stored as listed.
    const plain = 'poll-listed-routes'
    const plainDeps = await freshDeps(plain)
    await pollProviderModels(
      plainDeps,
      stubProvider(plain, [
        {
          rawId: 'acme/llm',
          activity: 'chat',
          schemaEndpointId: 'v1/unsynced',
        },
      ]),
    )
    const row = await plainDeps.db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(plain, 'acme/llm')))
    expect(row[0]?.schemaEndpointId).toBe('v1/unsynced')
  })

  it('does not walk generated specs onto catalog rows', async () => {
    const id = 'poll-generated'
    const deps = await freshDeps(id)
    await deps.db.insert(endpoints).values({
      id: `${id}/v1/messages`,
      providerId: id,
      activity: 'chat',
      method: 'POST',
      path: '/v1/messages',
    })
    await deps.db.insert(schemaVersions).values({
      id: `${id}/v1/messages:input`,
      endpointId: `${id}/v1/messages`,
      kind: 'input',
      contentHash: 'a'.repeat(64),
      schema: JSON.stringify({
        properties: { tools: { type: 'array' } },
      }),
      derivation: 'upstream-spec',
      createdAt: 1_781_150_000,
    })
    await pollProviderModels(deps, {
      ...stubProvider(id, [
        {
          rawId: 'deepseek-chat',
          activity: 'chat',
          schemaEndpointId: 'v1/messages',
        },
      ]),
      defaultDerivation: 'generated',
    })
    const row = await deps.db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(id, 'deepseek-chat')))
    expect(row[0]?.capabilities).toBeNull()
  })

  it('does not emit model.updated when only schema provenance metadata changes', async () => {
    const id = 'poll-sources'
    const deps = await freshDeps(id)
    await deps.db.insert(endpoints).values({
      id: `${id}/v1/messages`,
      providerId: id,
      activity: 'chat',
      method: 'POST',
      path: '/v1/messages',
    })
    await deps.db.insert(schemaVersions).values({
      id: `${id}/v1/messages:input`,
      endpointId: `${id}/v1/messages`,
      kind: 'input',
      contentHash: 'a'.repeat(64),
      schema: JSON.stringify({
        properties: { tools: { type: 'array' } },
      }),
      derivation: 'upstream-spec',
      sourceHash: 'a'.repeat(64),
      createdAt: 1_781_150_000,
    })
    const listed = stubProvider(id, [
      {
        rawId: 'claude-sonnet-4-5',
        activity: 'chat',
        schemaEndpointId: 'v1/messages',
      },
    ])
    expect(await pollProviderModels(deps, listed)).toMatchObject({
      added: 1,
      updated: 0,
    })
    await deps.db
      .update(schemaVersions)
      .set({ sourceHash: 'b'.repeat(64), createdAt: 1_781_150_100 })
      .where(eq(schemaVersions.id, `${id}/v1/messages:input`))
    expect(await pollProviderModels(deps, listed)).toMatchObject({
      added: 0,
      updated: 0,
    })
  })

  it('stores OpenRouter listings as rate cards and Together zeros as null', async () => {
    const id = 'poll-pricing'
    const deps = await freshDeps(id)
    const listing = { prompt: '0.0000025', completion: '0.00001' }
    const first = await pollProviderModels(
      deps,
      stubProvider(id, [
        { rawId: 'gpt-4o', activity: 'chat', pricing: listing },
        {
          rawId: 'free-model',
          activity: 'chat',
          pricing: { prompt: '0', completion: '0' },
        },
      ]),
    )
    expect(first).toMatchObject({ added: 2, updated: 0 })
    const gpt = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'gpt-4o')),
    })
    const free = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'free-model')),
    })
    const card = gpt?.pricing as { inputs?: { input_tokens?: unknown } } | null
    expect(card?.inputs?.input_tokens).toMatchObject({
      param: 'input_tokens',
      bound: 'usage',
    })
    expect(free?.pricing).toBeNull()
    expect(
      (gpt?.factSources as { pricing?: { derivation: string } } | null)?.pricing
        ?.derivation,
    ).toBe('listing')
    expect(
      (free?.factSources as { pricing?: unknown } | null)?.pricing,
    ).toBeUndefined()

    const second = await pollProviderModels(
      deps,
      stubProvider(id, [
        { rawId: 'gpt-4o', activity: 'chat', pricing: listing },
        {
          rawId: 'free-model',
          activity: 'chat',
          pricing: { prompt: '0', completion: '0' },
        },
      ]),
    )
    expect(second).toMatchObject({ added: 0, updated: 0 })
  })

  it('emits model.updated when OpenRouter listing rates change', async () => {
    const id = 'poll-price-change'
    const deps = await freshDeps(id)
    await pollProviderModels(
      deps,
      stubProvider(id, [
        {
          rawId: 'gpt-4o',
          activity: 'chat',
          pricing: { prompt: '0.0000025', completion: '0.00001' },
        },
      ]),
    )
    const first = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'gpt-4o')),
    })
    const firstHash = (first?.pricing as { source?: { hash: string } } | null)
      ?.source?.hash
    const raised = await pollProviderModels(
      deps,
      stubProvider(id, [
        {
          rawId: 'gpt-4o',
          activity: 'chat',
          pricing: { prompt: '0.000005', completion: '0.00002' },
        },
      ]),
    )
    expect(raised).toMatchObject({ added: 0, updated: 1 })
    const later = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'gpt-4o')),
    })
    const laterHash = (later?.pricing as { source?: { hash: string } } | null)
      ?.source?.hash
    expect(firstHash).toBeTruthy()
    expect(laterHash).toBeTruthy()
    expect(laterHash).not.toBe(firstHash)
  })

  it('drops a stored card when the listing becomes all-zero', async () => {
    const id = 'poll-price-drop'
    const deps = await freshDeps(id)
    await pollProviderModels(
      deps,
      stubProvider(id, [
        {
          rawId: 'gpt-4o',
          activity: 'chat',
          pricing: { prompt: '0.0000025', completion: '0.00001' },
        },
      ]),
    )
    const errors: Array<string> = []
    const original = console.error
    console.error = (message?: unknown) => {
      errors.push(String(message))
    }
    try {
      const dropped = await pollProviderModels(
        deps,
        stubProvider(id, [
          {
            rawId: 'gpt-4o',
            activity: 'chat',
            pricing: { prompt: '0', completion: '0' },
          },
        ]),
      )
      expect(dropped).toMatchObject({ added: 0, updated: 1 })
    } finally {
      console.error = original
    }
    const row = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'gpt-4o')),
    })
    expect(row?.pricing).toBeNull()
    expect(
      (row?.factSources as { pricing?: unknown } | null)?.pricing,
    ).toBeUndefined()
    expect(errors.some((line) => line.includes('uncompilable'))).toBe(true)
  })

  it('refuses a request-bound param that is not on the bound input schema', async () => {
    const id = 'poll-invented'
    const deps = await freshDeps(id)
    await deps.db.insert(endpoints).values({
      id: `${id}/v1/messages`,
      providerId: id,
      activity: 'chat',
      method: 'POST',
      path: '/v1/messages',
    })
    await deps.db.insert(schemaVersions).values({
      id: `${id}/v1/messages:input`,
      endpointId: `${id}/v1/messages`,
      kind: 'input',
      contentHash: 'a'.repeat(64),
      schema: JSON.stringify({
        properties: { model: { type: 'string' }, messages: { type: 'array' } },
      }),
      derivation: 'upstream-spec',
      createdAt: 1_781_150_000,
    })
    await pollProviderModels(
      deps,
      stubProvider(id, [
        {
          rawId: 'claude-fable-5',
          activity: 'chat',
          schemaEndpointId: 'v1/messages',
          pricing: {
            inputs: {
              quality: { param: 'quality', kind: 'enum', values: ['high'] },
            },
            tables: {},
            price: { lookup: { table: 'rate', keys: ['quality'] } },
            examples: [],
            source: {
              url: 'https://example.com/llms.txt',
              hash: 'a'.repeat(64),
              extractedAt: '2026-09-15T00:00:00Z',
            },
          },
        },
      ]),
    )
    const row = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'claude-fable-5')),
    })
    expect(row?.pricing).toBeNull()
  })

  it('refuses invented request params on grain=model when a RateCard is listed', async () => {
    const id = 'poll-fal-invented'
    const deps = await freshDeps(id)
    await deps.db.insert(endpoints).values({
      id: `${id}/fal-ai/nano`,
      providerId: id,
      activity: 'image',
      method: 'POST',
      path: '/fal-ai/nano',
    })
    await deps.db.insert(schemaVersions).values({
      id: `${id}/fal-ai/nano:input`,
      endpointId: `${id}/fal-ai/nano`,
      kind: 'input',
      contentHash: 'a'.repeat(64),
      schema: JSON.stringify({
        properties: { prompt: { type: 'string' } },
      }),
      derivation: 'upstream-spec',
      createdAt: 1_781_150_000,
    })
    const provider = stubProvider(id, [
      {
        rawId: 'fal-ai/nano',
        activity: 'image',
        schemaEndpointId: 'fal-ai/nano',
        pricing: {
          inputs: {
            quality: { param: 'quality', kind: 'enum', values: ['high'] },
          },
          tables: {},
          price: { lookup: { table: 'rate', keys: ['quality'] } },
          examples: [],
          source: {
            url: 'https://example.com/llms.txt',
            hash: 'a'.repeat(64),
            extractedAt: '2026-09-15T00:00:00Z',
          },
        },
      },
    ])
    provider.specGrain = 'model'
    await pollProviderModels(deps, provider)
    const row = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'fal-ai/nano')),
    })
    expect(row?.pricing).toBeNull()
  })

  it('keeps a docs-extracted card when the listing is silent', async () => {
    const id = 'poll-keep-extract'
    const deps = await freshDeps(id)
    const card = {
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
      source: {
        url: 'https://fal.ai/models/fal-ai/nano/llms.txt',
        hash: 'a'.repeat(64),
        extractedAt: '2026-09-15T00:00:00.000Z',
      },
    }
    const listed = stubProvider(id, [
      { rawId: 'fal-ai/nano', activity: 'image' },
    ])
    listed.specGrain = 'model'
    await pollProviderModels(deps, listed)
    await deps.db
      .update(models)
      .set({
        pricing: card,
        factSources: {
          pricing: {
            derivation: 'docs-extracted',
            sourceUrl: card.source.url,
            sourceHash: card.source.hash,
          },
        },
      })
      .where(eq(models.id, modelDbId(id, 'fal-ai/nano')))
    expect(await pollProviderModels(deps, listed)).toMatchObject({
      added: 0,
      updated: 0,
    })
    const kept = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'fal-ai/nano')),
    })
    expect(kept?.pricing).toMatchObject({
      inputs: { num_images: { param: 'num_images' } },
    })
    expect(
      (kept!.factSources as { pricing?: { derivation: string } }).pricing
        ?.derivation,
    ).toBe('docs-extracted')

    const replaced = await pollProviderModels(
      deps,
      stubProvider(id, [
        {
          rawId: 'fal-ai/nano',
          activity: 'image',
          pricing: { prompt: '0.0000025', completion: '0.00001' },
        },
      ]),
    )
    expect(replaced).toMatchObject({ added: 0, updated: 1 })
    const after = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'fal-ai/nano')),
    })
    expect(
      (after!.factSources as { pricing?: { derivation: string } }).pricing
        ?.derivation,
    ).toBe('listing')
  })

  it('drops a models.dev card and keeps a provider card', async () => {
    const id = 'poll-models-dev-card'
    const deps = await freshDeps(id)
    const listed = stubProvider(id, [
      { rawId: 'codex-mini' },
      { rawId: 'gpt-4o' },
    ])
    await pollProviderModels(deps, listed)
    const devCard = {
      inputs: {
        num_images: { param: 'num_images', kind: 'number', default: 1 },
      },
      tables: {},
      price: { '*': [{ var: 'num_images' }, 0.08] },
      examples: [],
      source: {
        url: MODELS_DEV_API_URL,
        hash: 'b'.repeat(64),
        extractedAt: '2026-10-04T09:33:23.902Z',
      },
    }
    const openaiCard = {
      ...devCard,
      source: {
        ...devCard.source,
        url: 'https://developers.openai.com/api/docs/pricing',
      },
    }
    await deps.db
      .update(models)
      .set({
        pricing: devCard,
        factSources: {
          contextWindow: { derivation: 'listing' },
          pricing: { derivation: 'listing' },
        },
      })
      .where(eq(models.id, modelDbId(id, 'codex-mini')))
    await deps.db
      .update(models)
      .set({
        pricing: openaiCard,
        factSources: {
          pricing: {
            derivation: 'listing',
            sourceUrl: openaiCard.source.url,
          },
        },
      })
      .where(eq(models.id, modelDbId(id, 'gpt-4o')))

    expect(await pollProviderModels(deps, listed)).toMatchObject({
      added: 0,
      removed: 0,
    })
    const dropped = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'codex-mini')),
    })
    expect(dropped?.pricing).toBeNull()
    expect(dropped?.deprecatedAt).toBeNull()
    expect(dropped?.factSources).toEqual({
      contextWindow: { derivation: 'listing' },
    })
    const kept = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'gpt-4o')),
    })
    expect(kept?.pricing).toMatchObject({
      source: { url: 'https://developers.openai.com/api/docs/pricing' },
    })
  })

  it('nulls models.dev cards past one write chunk', async () => {
    const id = 'poll-models-dev-chunks'
    const deps = await freshDeps(id)
    const list = Array.from({ length: MODELS_DEV_CARD_CHUNK + 1 }, (_, i) => ({
      rawId: `m-${String(i)}`,
    }))
    await pollProviderModels(deps, stubProvider(id, list))
    const devCard = {
      inputs: {
        num_images: { param: 'num_images', kind: 'number', default: 1 },
      },
      tables: {},
      price: { '*': [{ var: 'num_images' }, 0.08] },
      examples: [],
      source: {
        url: MODELS_DEV_API_URL,
        hash: 'b'.repeat(64),
        extractedAt: '2026-10-04T09:33:23.902Z',
      },
    }
    for (const info of list) {
      await deps.db
        .update(models)
        .set({
          pricing: devCard,
          factSources: {
            contextWindow: { derivation: 'listing' },
            pricing: { derivation: 'listing' },
          },
        })
        .where(eq(models.id, modelDbId(id, info.rawId)))
    }
    await pollProviderModels(deps, stubProvider(id, list))
    const rows = await deps.db
      .select()
      .from(models)
      .where(eq(models.providerId, id))
    expect(rows).toHaveLength(list.length)
    for (const row of rows) {
      expect(row.pricing).toBeNull()
      expect(row.factSources).toEqual({
        contextWindow: { derivation: 'listing' },
      })
    }
  })

  it('drops an OpenCode models.dev card: Zen prices come from its console page (#314)', async () => {
    const id = 'opencode'
    const deps = await freshDeps(id)
    const fixture = FIXTURE_CARDS['openai/gpt-4o']!
    const card = {
      ...fixture,
      source: { ...fixture.source, url: MODELS_DEV_API_URL },
    }
    const listed = stubProvider(id, [
      {
        rawId: 'opus',
        pricing: card,
        factSources: {
          pricing: {
            derivation: 'listing',
            sourceUrl: MODELS_DEV_API_URL,
            path: 'opencode.models.opus.cost',
          },
        },
      },
    ])
    expect(await pollProviderModels(deps, listed)).toMatchObject({ added: 1 })
    const row = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'opus')),
    })
    expect(row?.pricing).toBeNull()
  })
})

describe('models.dev residue on skip (issue #197)', () => {
  function skipping(id: string): ProviderConfig {
    return {
      ...stubProvider(id, []),
      listModels: () =>
        Promise.resolve({
          models: [],
          skipped: `${id}: no first-party source yet — skipped`,
        }),
    }
  }

  it('deprecates a frozen models.dev catalog once, then leaves a later row', async () => {
    const id = 'poll-models-dev-skip'
    const deps = await freshDeps(id)
    const devCard = {
      inputs: {
        num_images: { param: 'num_images', kind: 'number', default: 1 },
      },
      tables: {},
      price: { '*': [{ var: 'num_images' }, 0.08] },
      examples: [],
      source: {
        url: MODELS_DEV_API_URL,
        hash: 'c'.repeat(64),
        extractedAt: '2026-10-04T09:38:05.665Z',
      },
    }
    await deps.db.insert(models).values([
      {
        id: modelDbId(id, 'muse-spark-1.1'),
        providerId: id,
        rawId: 'muse-spark-1.1',
        activity: 'chat',
        displayName: 'Muse Spark 1.1',
        pricing: devCard,
        factSources: { pricing: { derivation: 'listing' } },
        firstSeenAt: 1,
        lastSeenAt: 1,
      },
      {
        id: modelDbId(id, 'muse-unpriced'),
        providerId: id,
        rawId: 'muse-unpriced',
        activity: 'chat',
        firstSeenAt: 1,
        lastSeenAt: 1,
      },
    ])
    await deps.db.insert(endpoints).values({
      id: `${id}/responses`,
      providerId: id,
      activity: 'chat',
      method: 'POST',
      path: '/responses',
    })
    await deps.db.insert(schemaVersions).values([
      {
        id: `${id}/responses:dev`,
        endpointId: `${id}/responses`,
        kind: 'input',
        contentHash: 'd'.repeat(64),
        schema: JSON.stringify({ type: 'object' }),
        sourceUrl: MODELS_DEV_API_URL,
        createdAt: 1,
      },
      {
        id: `${id}/responses:docs`,
        endpointId: `${id}/responses`,
        kind: 'output',
        contentHash: 'e'.repeat(64),
        schema: JSON.stringify({ type: 'object' }),
        sourceUrl: 'https://example.com/docs',
        createdAt: 1,
      },
    ])

    const first = await pollProviderModels(deps, skipping(id))
    expect(first.skipped).toContain(id)
    expect(first.removed).toBe(2)
    const priced = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'muse-spark-1.1')),
    })
    expect(priced?.pricing).toBeNull()
    expect(priced?.deprecatedAt).not.toBeNull()
    const unpriced = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'muse-unpriced')),
    })
    expect(unpriced?.deprecatedAt).not.toBeNull()
    const versions = await deps.db
      .select()
      .from(schemaVersions)
      .where(eq(schemaVersions.endpointId, `${id}/responses`))
    expect(versions.map((row) => row.sourceUrl)).toEqual([
      'https://example.com/docs',
    ])

    await deps.db.insert(models).values({
      id: modelDbId(id, 'later-first-party'),
      providerId: id,
      rawId: 'later-first-party',
      firstSeenAt: 2,
      lastSeenAt: 2,
    })
    const second = await pollProviderModels(deps, skipping(id))
    expect(second.removed).toBe(0)
    const later = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'later-first-party')),
    })
    expect(later?.deprecatedAt).toBeNull()
  })
})

describe('perModelSchemaFlags', () => {
  it('clears generic OpenRouter reasoning flags while preserving exact native support and unknowns', async () => {
    const id = 'poll-openrouter-native-scope'
    const deps = await freshDeps(id)
    const endpointId = 'chat/completions'
    await deps.db.insert(endpoints).values({
      id: `${id}/${endpointId}`,
      providerId: id,
      activity: 'chat',
      method: 'POST',
      path: '/chat/completions',
    })
    await deps.db.insert(schemaVersions).values({
      id: `${id}/${endpointId}:input`,
      endpointId: `${id}/${endpointId}`,
      kind: 'input',
      contentHash: 'e'.repeat(64),
      schema: JSON.stringify({
        type: 'object',
        properties: {
          reasoning: { type: 'object' },
          temperature: { type: 'number' },
        },
      }),
      derivation: 'upstream-spec',
      sourceUrl: 'https://openrouter.ai/openapi.json',
      createdAt: 1_781_150_000,
    })
    const listed = [nativeRouterModels.reasoner, nativeRouterModels.plain].map(
      (row) => ({
        rawId: row.id,
        activity: 'chat' as const,
        schemaEndpointId: endpointId,
        capabilities: openrouterCapabilities(row),
        requestMap: null,
      }),
    )
    const provider = {
      ...stubProvider(id, listed),
      perModelSchemaFlags: openrouterProvider.perModelSchemaFlags,
    }
    // Reproduce the previously stored shared-schema enrichment, then refresh native scope.
    await pollProviderModels(deps, { ...provider, perModelSchemaFlags: [] })
    const oldPlain = await deps.db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(id, nativeRouterModels.plain.id)))
    expect(oldPlain[0]?.capabilities).toMatchObject({ reasoning: true })
    await pollProviderModels(deps, provider)
    const refreshed = await deps.db
      .select()
      .from(models)
      .where(eq(models.providerId, id))
    const reasoner = refreshed.find(
      (row) => row.rawId === nativeRouterModels.reasoner.id,
    )
    const plain = refreshed.find(
      (row) => row.rawId === nativeRouterModels.plain.id,
    )
    expect(reasoner?.capabilities).toMatchObject({ reasoning: true })
    expect(plain?.capabilities).not.toHaveProperty('reasoning')
    expect(plain?.requestMap).toBeNull()
    expect(
      Object.hasOwn(
        (plain?.factSources as ModelFactSources | null)?.capabilities ?? {},
        'reasoning',
      ),
    ).toBe(false)
  })

  it('keeps the named schema flags off unless the listing states them', async () => {
    const id = 'poll-per-model-flags'
    const deps = await freshDeps(id)
    const db = deps.db
    await db.insert(endpoints).values({
      id: `${id}/v1/agent`,
      providerId: id,
      activity: 'chat',
      method: 'POST',
      path: '/v1/agent',
    })
    await db.insert(schemaVersions).values({
      id: `${id}/v1/agent:input`,
      endpointId: `${id}/v1/agent`,
      kind: 'input',
      contentHash: 'b'.repeat(64),
      schema: JSON.stringify({
        properties: {
          tools: { type: 'array' },
          temperature: { type: 'number' },
          reasoning: { type: 'object' },
        },
      }),
      derivation: 'upstream-spec',
      sourceUrl: 'https://example.com/openapi.json',
      createdAt: 1_781_150_000,
    })
    await pollProviderModels(deps, {
      ...stubProvider(id, [
        { rawId: 'plain', activity: 'chat', schemaEndpointId: 'v1/agent' },
        {
          rawId: 'thinker',
          activity: 'chat',
          schemaEndpointId: 'v1/agent',
          capabilities: ['reasoning'],
        },
      ]),
      perModelSchemaFlags: ['reasoning', 'tools'],
    })
    const plain = await db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(id, 'plain')))
    expect(plain[0]?.capabilities).toEqual({ temperature: true })
    expect(
      Object.keys(
        (plain[0]!.factSources as { capabilities: object }).capabilities,
      ),
    ).toEqual(['temperature'])
    const thinker = await db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(id, 'thinker')))
    expect(thinker[0]?.capabilities).toEqual({
      reasoning: true,
      temperature: true,
    })
  })
})

describe('reasoning and server tools (issue #77)', () => {
  it('stores both with provenance and emits model.updated on change', async () => {
    const id = 'poll-features'
    const deps = await freshDeps(id)
    const docs = 'https://example.com/tools'
    const listed: ModelInfo = {
      ...fable,
      reasoning: { mode: 'adaptive', mandatory: true, efforts: ['low'] },
      serverTools: ['web_search_20250305', 'bash_20250124'],
      factSources: {
        serverTools: {
          web_search_20250305: { derivation: 'docs-derived', sourceUrl: docs },
        },
      },
    }
    await pollProviderModels(deps, stubProvider(id, [listed]))
    const row = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, fable.rawId)),
    })
    expect(row?.reasoning).toEqual(listed.reasoning)
    expect(row?.serverTools).toEqual(listed.serverTools)
    // Docs-tagged tools keep their source; untagged ones default to listing.
    expect(row?.factSources).toMatchObject({
      reasoning: { derivation: 'listing' },
      serverTools: {
        web_search_20250305: { derivation: 'docs-derived', sourceUrl: docs },
        bash_20250124: { derivation: 'listing' },
      },
    })

    const outcome = await pollProviderModels(
      deps,
      stubProvider(id, [{ ...listed, serverTools: ['bash_20250124'] }]),
    )
    expect(outcome.updated).toBe(1)
  })
})

describe('reasoning write gate', () => {
  it('keeps the stored value when a later poll lists a malformed one', async () => {
    const id = 'poll-reasoning-gate'
    const deps = await freshDeps(id)
    const good = { mode: 'effort', mandatory: null, efforts: ['low', 'max'] }
    const row = () =>
      deps.db.query.models.findFirst({
        where: eq(models.id, modelDbId(id, fable.rawId)),
      })
    await pollProviderModels(
      deps,
      stubProvider(id, [{ ...fable, reasoning: good } as ModelInfo]),
    )
    expect((await row())?.reasoning).toEqual(good)

    // A toggle with an unstated mandatory is not a fact: nothing is written.
    const outcome = await pollProviderModels(
      deps,
      stubProvider(id, [
        { ...fable, reasoning: { mode: 'toggle', mandatory: null } },
      ]),
    )
    expect(outcome.updated).toBe(0)
    expect((await row())?.reasoning).toEqual(good)

    // On a row with nothing stored it stays null, and the row still lands.
    const fresh = 'poll-reasoning-gate-new'
    const freshDepsRow = await freshDeps(fresh)
    await pollProviderModels(
      freshDepsRow,
      stubProvider(fresh, [
        { ...fable, reasoning: { mode: 'switch', mandatory: false } as never },
      ]),
    )
    const stored = await freshDepsRow.db.query.models.findFirst({
      where: eq(models.id, modelDbId(fresh, fable.rawId)),
    })
    expect(stored?.rawId).toBe(fable.rawId)
    expect(stored?.reasoning).toBeNull()
    expect(stored?.factSources).not.toHaveProperty('reasoning')
  })
})

describe('listed request map', () => {
  it('keeps a map the listing read from the model schema', async () => {
    const id = 'poll-listed-request-map'
    const deps = await freshDeps(id)
    const requestMap = {
      thinking: null,
      maxTokensField: 'max_completion_tokens' as const,
      developerRole: null,
      replayReasoningContent: null,
      store: null,
      strictTools: null,
      sessionAffinity: null,
      cacheControl: null,
      toolStream: null,
      reasoningEffort: true,
    }
    const provider = stubProvider(id, [{ ...fable, requestMap }, haiku])
    await pollProviderModels(deps, provider)
    const stored = async (rawId: string) =>
      (
        await deps.db.query.models.findFirst({
          where: eq(models.id, modelDbId(id, rawId)),
        })
      )?.requestMap
    expect(await stored(fable.rawId)).toEqual(requestMap)
    // No listed map and no provider-wide case: still null.
    expect(await stored(haiku.rawId)).toBeNull()
    expect((await pollProviderModels(deps, provider)).updated).toBe(0)
  })
})

/** One poll in its own scope, with the ingest events it noted. */
async function pollWithEvents(deps: SyncDeps, provider: ProviderConfig) {
  return runIngestScope(async () => {
    const outcome = await pollProviderModels(deps, provider)
    return { outcome, events: takeIngestEvents() }
  })
}

async function storedRow(deps: SyncDeps, providerId: string, rawId: string) {
  const row = await deps.db.query.models.findFirst({
    where: eq(models.id, modelDbId(providerId, rawId)),
  })
  if (!row) throw new Error(`no row for ${rawId}`)
  return row
}

async function changesFor(deps: SyncDeps, providerId: string) {
  const rows = await deps.db
    .select()
    .from(changes)
    .where(eq(changes.providerId, providerId))
  return rows.length
}

describe('absent facts (FactAbsence)', () => {
  const listing = { prompt: '0.0000025', completion: '0.00001' }

  it('keeps a card the listing omits and drops one it clears', async () => {
    const id = 'poll-absent-cleared'
    const deps = await freshDeps(id)
    const row: ModelInfo = { rawId: 'm', activity: 'chat', contextWindow: 8192 }
    await pollProviderModels(
      deps,
      stubProvider(id, [{ ...row, pricing: listing }]),
    )
    const before = await changesFor(deps, id)

    // Omitted: could be a parser miss, so the card stays and it is logged.
    const omitted = await pollWithEvents(deps, stubProvider(id, [row]))
    expect(omitted.outcome).toMatchObject({ updated: 0, failures: 1 })
    expect(omitted.events).toEqual([
      {
        event: 'pricing_lost',
        properties: { providerId: id, rawId: 'm', reason: 'parser_miss' },
      },
    ])
    expect((await storedRow(deps, id, 'm')).pricing).not.toBeNull()
    expect(await changesFor(deps, id)).toBe(before)

    // Cleared: the source says there is no price. One change, no failure.
    const cleared = stubProvider(id, [
      { ...row, absent: { pricing: 'cleared' } },
    ])
    const first = await pollWithEvents(deps, cleared)
    expect(first.outcome).toMatchObject({ updated: 1, failures: 0 })
    expect(first.events).toEqual([])
    const after = await storedRow(deps, id, 'm')
    expect(after.pricing).toBeNull()
    expect(after.contextWindow).toBe(8192)
    expect(after.factSources).toEqual({
      contextWindow: { derivation: 'listing' },
    })
    expect(await changesFor(deps, id)).toBe(before + 1)

    const again = await pollWithEvents(deps, cleared)
    expect(again.outcome).toMatchObject({ updated: 0, failures: 0 })
    expect(again.events).toEqual([])
  })

  it('writes null for any other fact, omitted or cleared alike', async () => {
    const id = 'poll-absent-other'
    const deps = await freshDeps(id)
    const full: ModelInfo = {
      rawId: 'm',
      activity: 'chat',
      contextWindow: 8192,
      maxOutput: 4096,
    }
    await pollProviderModels(deps, stubProvider(id, [full]))
    const { outcome, events } = await pollWithEvents(
      deps,
      stubProvider(id, [
        { rawId: 'm', activity: 'chat', absent: { maxOutput: 'cleared' } },
      ]),
    )
    expect(outcome).toMatchObject({ updated: 1, failures: 0 })
    expect(events).toEqual([])
    expect(await storedRow(deps, id, 'm')).toMatchObject({
      contextWindow: null,
      maxOutput: null,
      factSources: null,
    })
  })

  it('lets a reason win over a value the listing also carries', async () => {
    const id = 'poll-absent-with-value'
    const deps = await freshDeps(id)
    const stored: ModelInfo = {
      rawId: 'm',
      activity: 'chat',
      contextWindow: 8192,
      maxOutput: 4096,
      pricing: listing,
    }
    await pollProviderModels(deps, stubProvider(id, [stored]))
    const before = await storedRow(deps, id, 'm')
    const { outcome } = await pollWithEvents(
      deps,
      stubProvider(id, [
        {
          ...stored,
          contextWindow: 1,
          maxOutput: 2,
          pricing: { prompt: '0.5', completion: '0.5' },
          absent: {
            contextWindow: 'unavailable',
            pricing: 'unavailable',
            maxOutput: 'cleared',
          },
        },
      ]),
    )
    expect(outcome).toMatchObject({ updated: 1, failures: 0 })
    const after = await storedRow(deps, id, 'm')
    expect(after).toMatchObject({ contextWindow: 8192, maxOutput: null })
    expect(after.pricing).toEqual(before.pricing)
  })

  it('keeps a stored reasoning through the write gate when it is unavailable', async () => {
    const id = 'poll-absent-reasoning'
    const deps = await freshDeps(id)
    const source = {
      derivation: 'docs-derived' as const,
      sourceUrl: 'https://docs.example.com/models.md',
      sourceHash: 'h1',
      path: 'reasoning_effort',
    }
    const row: ModelInfo = {
      rawId: 'kimi-k3',
      activity: 'chat',
      capabilities: ['reasoning', 'reasoning_effort'],
      reasoning: { mode: 'effort', mandatory: null, efforts: ['low', 'max'] },
      factSources: { reasoning: source },
    }
    await pollProviderModels(deps, stubProvider(id, [row]))
    const good = await storedRow(deps, id, 'kimi-k3')
    expect(good.reasoning).toEqual(row.reasoning)

    // The docs are down. A value the listing still carries, even one the
    // gate would refuse, is not what gets judged: the stored one is kept.
    for (const reasoning of [undefined, { mode: 'nonsense' }]) {
      const { outcome, events } = await pollWithEvents(
        deps,
        stubProvider(id, [
          {
            rawId: 'kimi-k3',
            activity: 'chat',
            ...(reasoning ? { reasoning: reasoning as never } : {}),
            ...unavailable('capabilities', 'reasoning'),
          },
        ]),
      )
      expect(outcome).toMatchObject({ updated: 0, failures: 0 })
      expect(events).toEqual([])
      const kept = await storedRow(deps, id, 'kimi-k3')
      expect(kept.reasoning).toEqual(good.reasoning)
      expect(kept.capabilities).toEqual(good.capabilities)
      expect(kept.factSources).toEqual(good.factSources)
    }
  })

  it('inserts a new row with nothing for an unavailable fact', async () => {
    const id = 'poll-absent-new-row'
    const deps = await freshDeps(id)
    const { outcome } = await pollWithEvents(
      deps,
      stubProvider(id, [
        {
          rawId: 'm',
          activity: 'chat',
          contextWindow: 8192,
          capabilities: ['tools'],
          ...unavailable('contextWindow', 'capabilities', 'pricing'),
        },
      ]),
    )
    expect(outcome).toMatchObject({ added: 1, failures: 0 })
    expect(await storedRow(deps, id, 'm')).toMatchObject({
      activity: 'chat',
      contextWindow: null,
      capabilities: null,
      pricing: null,
      factSources: null,
    })
  })

  it('checks a card against the stored endpoint when the endpoint is unavailable', async () => {
    const id = 'poll-absent-endpoint'
    const deps = await freshDeps(id)
    await deps.db.insert(endpoints).values({
      id: `${id}/v1/images`,
      providerId: id,
      activity: 'image',
      method: 'POST',
      path: '/v1/images',
    })
    await deps.db.insert(schemaVersions).values({
      id: `${id}/v1/images:input`,
      endpointId: `${id}/v1/images`,
      kind: 'input',
      contentHash: 'a'.repeat(64),
      schema: JSON.stringify({ properties: { quality: { type: 'string' } } }),
      derivation: 'upstream-spec',
      createdAt: 1_781_150_000,
    })
    const card = {
      inputs: { quality: { param: 'quality', kind: 'enum', values: ['high'] } },
      tables: { rate: { high: 0.04 } },
      price: { lookup: { table: 'rate', keys: ['quality'] } },
      examples: [],
      source: {
        url: 'https://example.com/pricing',
        hash: 'a'.repeat(64),
        extractedAt: '2026-09-15T00:00:00Z',
      },
    }
    const row: ModelInfo = { rawId: 'm', activity: 'image', pricing: card }
    const provider = (info: ModelInfo): ProviderConfig => ({
      ...stubProvider(id, [info]),
      bindSyncedRoutesOnly: true,
    })
    await pollProviderModels(
      deps,
      provider({ ...row, schemaEndpointId: 'v1/images' }),
    )
    const good = await storedRow(deps, id, 'm')
    expect(good.pricing).not.toBeNull()
    expect(good.schemaEndpointId).toBe('v1/images')

    // The docs that named the endpoint are down; the listing still prices.
    const { outcome, events } = await pollWithEvents(
      deps,
      provider({ ...row, ...unavailable('schemaEndpointId') }),
    )
    expect(events).toEqual([])
    expect(outcome).toMatchObject({ updated: 0, failures: 0 })
    const kept = await storedRow(deps, id, 'm')
    expect(kept.pricing).toEqual(good.pricing)
    expect(kept.schemaEndpointId).toBe('v1/images')
  })

  it('refuses a poll that would clear most of a provider’s prices', async () => {
    const id = 'poll-clear-breaker'
    const deps = await freshDeps(id)
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const rows = (cleared: Array<string>): Array<ModelInfo> =>
      ids.map((rawId) => ({
        rawId,
        activity: 'chat',
        ...(cleared.includes(rawId)
          ? { absent: { pricing: 'cleared' } }
          : { pricing: listing }),
      }))
    await pollProviderModels(deps, stubProvider(id, rows([])))
    const before = await changesFor(deps, id)
    const priced = async () =>
      (
        await deps.db.select().from(models).where(eq(models.providerId, id))
      ).filter((row) => row.pricing !== null).length

    // Every card at once: none is cleared, and it is one loud failure.
    for (let poll = 0; poll < 2; poll++) {
      const all = await pollWithEvents(deps, stubProvider(id, rows(ids)))
      expect(all.outcome).toMatchObject({
        updated: 0,
        failures: 1,
        priceClearsRefused: 6,
      })
      expect(all.events).toEqual([
        {
          event: 'ingest_failed',
          properties: {
            job: 'models-poll',
            providerId: id,
            error: 'refused to clear 6 of 6 stored prices in one poll',
          },
        },
      ])
      // The durable record: written by the first refusal, extended by the next.
      const record = (await readIngestRecords(deps.db)).get(id)
      expect(record?.priceClearsRefused).toMatchObject({
        polls: poll + 1,
        refused: 6,
        priced: 6,
      })
      const refusal = record?.priceClearsRefused
      expect((refusal?.lastAt ?? 0) - (refusal?.since ?? 0)).toBe(poll)
    }
    expect(await priced()).toBe(6)
    expect(await changesFor(deps, id)).toBe(before)

    // Under the minimum: an ordinary clear.
    const some = await pollWithEvents(
      deps,
      stubProvider(id, rows(['a', 'b', 'c', 'd'])),
    )
    expect(some.outcome).toMatchObject({ updated: 4, failures: 0 })
    expect(some.outcome.priceClearsRefused).toBeUndefined()
    expect(await priced()).toBe(2)
    // The first poll that refuses nothing deletes the record.
    expect((await readIngestRecords(deps.db)).has(id)).toBe(false)
  })

  it('does not count delisted rows toward the priced rows', async () => {
    const id = 'poll-clear-delisted'
    const deps = await freshDeps(id)
    const live = ['a', 'b', 'c', 'd', 'e', 'f']
    const gone = ['g', 'h', 'i', 'j', 'k', 'l', 'm', 'n']
    const priced = (rawId: string): ModelInfo => ({
      rawId,
      activity: 'chat',
      pricing: listing,
    })
    await pollProviderModels(
      deps,
      stubProvider(id, [...live, ...gone].map(priced)),
    )
    // Eight rows leave the listing and keep their cards as deprecated rows.
    await pollProviderModels(deps, stubProvider(id, live.map(priced)))
    const { outcome } = await pollWithEvents(
      deps,
      stubProvider(
        id,
        live.map((rawId) => ({
          rawId,
          activity: 'chat',
          absent: { pricing: 'cleared' },
        })),
      ),
    )
    expect(outcome).toMatchObject({
      updated: 0,
      failures: 1,
      priceClearsRefused: 6,
    })
    expect((await storedRow(deps, id, 'a')).pricing).not.toBeNull()
  })

  it('applies clears of exactly half the priced rows', async () => {
    const id = 'poll-clear-half'
    const deps = await freshDeps(id)
    const ids = Array.from({ length: 10 }, (_, i) => `m${String(i)}`)
    await pollProviderModels(
      deps,
      stubProvider(
        id,
        ids.map((rawId) => ({ rawId, activity: 'chat', pricing: listing })),
      ),
    )
    const { outcome } = await pollWithEvents(
      deps,
      stubProvider(
        id,
        ids.map((rawId, i) => ({
          rawId,
          activity: 'chat',
          ...(i < 5
            ? { absent: { pricing: 'cleared' } }
            : { pricing: listing }),
        })),
      ),
    )
    expect(outcome).toMatchObject({ updated: 5, failures: 0 })
  })

  it('stores a price range beside no card, never beside a kept one (#406)', async () => {
    const id = 'poll-range'
    const deps = await freshDeps(id)
    const range = (max: number) => ({
      currency: 'USD',
      routes: [
        { model: 'a/m', pricing: { currency: 'USD', per: 'token' as const } },
        { model: 'b/m', pricing: { currency: 'USD', per: 'token' as const } },
      ],
      inputPerMillion: { min: 1, max },
    })
    const bare = (extra: Partial<ModelInfo>): ModelInfo => ({
      rawId: 'm',
      activity: 'chat',
      ...extra,
    })
    await pollProviderModels(
      deps,
      stubProvider(id, [
        bare({ pricingRange: range(2), absent: { pricing: 'cleared' } }),
      ]),
    )
    expect(await storedRow(deps, id, 'm')).toMatchObject({
      pricing: null,
      pricingRange: range(2),
    })
    // A moved bound is a change to the model.
    const before = await changesFor(deps, id)
    const moved = await pollWithEvents(
      deps,
      stubProvider(id, [
        bare({ pricingRange: range(3), absent: { pricing: 'cleared' } }),
      ]),
    )
    expect(moved.outcome).toMatchObject({ updated: 1 })
    expect(await changesFor(deps, id)).toBe(before + 1)
    expect((await storedRow(deps, id, 'm')).pricingRange).toEqual(range(3))

    // A card kept from before (here: the listing omits the price) is the
    // row's one price, so no range is stored beside it.
    await pollProviderModels(
      deps,
      stubProvider(id, [bare({ pricing: listing })]),
    )
    await pollProviderModels(
      deps,
      stubProvider(id, [bare({ pricingRange: range(2) })]),
    )
    const kept = await storedRow(deps, id, 'm')
    expect(kept.pricing).not.toBeNull()
    expect(kept.pricingRange).toBeNull()
  })

  it('keeps a range the listing did not fetch while the row still varies (#451)', async () => {
    const id = 'poll-keep-range'
    const deps = await freshDeps(id)
    const range = {
      currency: 'USD',
      routes: [
        {
          model: 'deepinfra',
          provider: 'deepinfra',
          pricing: {
            currency: 'USD',
            per: 'token' as const,
            inputPerMillion: 0.09,
          },
        },
        {
          model: 'vertex',
          provider: 'vertex',
          pricing: {
            currency: 'USD',
            per: 'token' as const,
            inputPerMillion: 0.22,
          },
        },
      ],
      inputPerMillion: { min: 0.09, max: 0.22 },
    }
    const source = {
      derivation: 'listing' as const,
      sourceUrl: 'https://ai-gateway.vercel.sh/v1/models/m/endpoints',
      path: 'data.endpoints[status=0].pricing',
    }
    await pollProviderModels(
      deps,
      stubProvider(id, [
        {
          rawId: 'm',
          activity: 'chat',
          pricingRange: range,
          absent: { pricing: 'cleared' },
          factSources: { pricingRange: source },
        },
      ]),
    )
    const before = await changesFor(deps, id)
    const again = await pollWithEvents(
      deps,
      stubProvider(id, [
        {
          rawId: 'm',
          activity: 'chat',
          absent: { pricing: 'cleared' },
        },
      ]),
    )
    expect(again.outcome).toMatchObject({ updated: 0 })
    expect(await changesFor(deps, id)).toBe(before)
    const kept = await storedRow(deps, id, 'm')
    expect(kept.pricingRange).toEqual(range)
    expect(kept.factSources).toMatchObject({ pricingRange: source })

    await pollProviderModels(
      deps,
      stubProvider(id, [{ rawId: 'm', activity: 'chat', pricing: listing }]),
    )
    const cleared = await storedRow(deps, id, 'm')
    expect(cleared.pricing).not.toBeNull()
    expect(cleared.pricingRange).toBeNull()
  })
})

describe('docs failures (tryDocs)', () => {
  const DOC = 'https://docs.example.com/models.md'
  const docsSource = (path: string) => ({
    derivation: 'docs-derived' as const,
    sourceUrl: DOC,
    sourceHash: 'h1',
    path,
  })
  const docsFacts: Partial<ModelInfo> = {
    contextWindow: 200_000,
    capabilities: ['tools', 'reasoning'],
    reasoning: { mode: 'effort', mandatory: false, efforts: ['low', 'high'] },
    schemaEndpointId: 'v1/chat',
    factSources: {
      contextWindow: docsSource('contextWindow'),
      capabilities: {
        tools: docsSource('capabilities.tools'),
        reasoning: docsSource('capabilities.reasoning'),
      },
      reasoning: docsSource('reasoning'),
    },
  }
  type State = { price: string; docs: 'ok' | 'down'; listing: 'ok' | 'down' }

  /** An adapter shaped like the converted ones: listing, then one docs page. */
  function docsProvider(id: string, state: State): ProviderConfig {
    return {
      ...stubProvider(id, []),
      listModels: async () => {
        if (state.listing === 'down') throw new Error('listing 503')
        const run = docsRun()
        const facts = await tryDocs(run, DOC, () =>
          state.docs === 'ok'
            ? Promise.resolve(docsFacts)
            : Promise.reject(new Error('page changed shape')),
        )
        return {
          models: ['a', 'b'].map((rawId) => ({
            rawId,
            activity: 'chat' as const,
            pricing: { prompt: state.price, completion: '0.00001' },
            ...(facts ??
              unavailable(
                'contextWindow',
                'capabilities',
                'reasoning',
                'schemaEndpointId',
              )),
          })),
          docsFailures: docsReport(run),
        }
      },
    }
  }

  it('keeps stored docs facts, lets a price update through, and stays visible', async () => {
    const id = 'poll-docs-down'
    const deps = await freshDeps(id)
    const state: State = { price: '0.000001', docs: 'ok', listing: 'ok' }
    const provider = docsProvider(id, state)
    expect(await pollProviderModels(deps, provider)).toMatchObject({
      added: 2,
      failures: 0,
    })
    const good = await storedRow(deps, id, 'a')
    expect(good).toMatchObject({
      contextWindow: 200_000,
      capabilities: { tools: true, reasoning: true },
      schemaEndpointId: 'v1/chat',
    })
    const facts = (row: typeof good) => ({
      contextWindow: row.contextWindow,
      capabilities: row.capabilities,
      reasoning: row.reasoning,
      requestMap: row.requestMap,
      schemaEndpointId: row.schemaEndpointId,
      factSources: {
        ...(row.factSources as Record<string, unknown>),
        pricing: null,
      },
    })

    // Docs down, nothing else moved: no row is written, no change fans out.
    state.docs = 'down'
    const before = await changesFor(deps, id)
    const quiet = await pollWithEvents(deps, provider)
    expect(quiet.outcome).toMatchObject({
      updated: 0,
      failures: 1,
      docsFailures: {
        failed: 1,
        skipped: 0,
        first: [{ source: DOC, error: 'page changed shape' }],
      },
    })
    // The durable record: written by the first failing poll.
    const began = await readDocsFailing(deps.db, id)
    expect(began).toEqual({
      since: expect.any(Number) as number,
      polls: 1,
      lastAt: began?.since,
      failed: 1,
      skipped: 0,
      sources: [DOC],
      error: 'page changed shape',
    })
    expect(quiet.outcome.docsFailing).toEqual(began)
    expect(quiet.events).toEqual([
      {
        event: 'ingest_failed',
        properties: {
          job: 'models-poll',
          providerId: id,
          source: DOC,
          error: 'page changed shape',
        },
      },
    ])
    expect(await changesFor(deps, id)).toBe(before)
    expect(facts(await storedRow(deps, id, 'a'))).toEqual(facts(good))

    // Docs still down and the listing reprices: the price lands, the docs
    // facts and their provenance stay exactly as stored.
    state.price = '0.000002'
    const repriced = await pollWithEvents(deps, provider)
    expect(repriced.outcome).toMatchObject({ updated: 2, failures: 1 })
    expect(repriced.events).toHaveLength(1)
    // The second failing poll extends the record; it began when it began.
    const lasting = await readDocsFailing(deps.db, id)
    expect(lasting).toMatchObject({ since: began?.since, polls: 2 })
    expect(lasting?.lastAt).toBeGreaterThan(began?.since ?? 0)
    const kept = await storedRow(deps, id, 'a')
    expect(facts(kept)).toEqual(facts(good))
    expect(kept.pricing).not.toEqual(good.pricing)
    expect(kept.pricing).toMatchObject({
      tables: { rate: { base: { input_tokens: 0.000002 } } },
    })

    // Docs back: nothing to repair, and the failure is gone.
    state.docs = 'ok'
    const back = await pollWithEvents(deps, provider)
    expect(back.outcome).toMatchObject({ updated: 0, failures: 0 })
    expect(back.outcome.docsFailures).toBeUndefined()
    expect(back.outcome.docsFailing).toBeUndefined()
    expect(back.events).toEqual([])
    expect(await readDocsFailing(deps.db, id)).toBeNull()
  })

  it('keeps a docs-sourced price too, without calling it lost', async () => {
    const id = 'poll-docs-down-price'
    const deps = await freshDeps(id)
    const priced = stubProvider(id, [
      {
        rawId: 'm',
        activity: 'chat',
        pricing: { prompt: '0.000001', completion: '0.00001' },
      },
    ])
    await pollProviderModels(deps, priced)
    const good = await storedRow(deps, id, 'm')
    const { outcome, events } = await pollWithEvents(deps, {
      ...priced,
      listModels: () =>
        Promise.resolve({
          models: [{ rawId: 'm', activity: 'chat', ...unavailable('pricing') }],
          docsFailures: {
            failed: 1,
            skipped: 0,
            first: [{ source: DOC, error: '404', elapsedMs: 3 }],
          },
        }),
    })
    expect(outcome).toMatchObject({ updated: 0, failures: 1 })
    expect(events.map((event) => event.event)).toEqual(['ingest_failed'])
    const kept = await storedRow(deps, id, 'm')
    expect(kept.pricing).toEqual(good.pricing)
    expect(kept.factSources).toEqual(good.factSources)
  })

  it('still fails the whole poll when the listing fails', async () => {
    const id = 'poll-listing-down'
    const deps = await freshDeps(id)
    const state: State = { price: '0.000001', docs: 'ok', listing: 'ok' }
    const provider = docsProvider(id, state)
    await pollProviderModels(deps, provider)
    const before = await storedRow(deps, id, 'a')

    state.listing = 'down'
    state.price = '0.000009'
    await expect(pollProviderModels(deps, provider)).rejects.toThrow(
      'listing 503',
    )
    const [outcome] = await pollAllProviders(deps, [provider])
    expect(outcome).toMatchObject({
      providerId: id,
      error: 'listing 503',
      failures: 1,
      updated: 0,
    })
    expect(await storedRow(deps, id, 'a')).toEqual(before)
  })

  it('polls on when the docs-failing record cannot be written or read', async () => {
    const id = 'poll-docs-record-broken'
    const deps = await freshDeps(id)
    const state: State = { price: '0.000001', docs: 'ok', listing: 'ok' }
    const provider = docsProvider(id, state)
    // A stored row that is not a record: overwritten, never fatal.
    await deps.db.insert(cacheMeta).values({
      key: `docs-failing:${id}`,
      fetchedAt: 5,
      staleTime: 0,
      lastError: '<html>not json',
    })
    expect(await readDocsFailing(deps.db, id)).toBeNull()
    state.docs = 'down'
    expect(await pollProviderModels(deps, provider)).toMatchObject({
      added: 2,
      failures: 1,
      docsFailing: { polls: 1 },
    })
    const record = await readDocsFailing(deps.db, id)
    expect(record).toMatchObject({ polls: 1 })
    expect(record?.since).toBeGreaterThan(5)

    // The table itself failing: the poll still lands, without the record.
    const broken: SyncDeps = {
      ...deps,
      db: new Proxy(deps.db, {
        get(target, prop, receiver) {
          if (prop === 'insert' || prop === 'delete') {
            return (table: unknown) => {
              if (table === cacheMeta) throw new Error('D1 write refused')
              return (
                Reflect.get(target, prop, receiver) as (t: unknown) => unknown
              ).call(target, table)
            }
          }
          return Reflect.get(target, prop, receiver) as unknown
        },
      }),
    }
    state.price = '0.000003'
    const outcome = await pollProviderModels(broken, provider)
    expect(outcome).toMatchObject({ updated: 2, failures: 1 })
    expect(outcome.docsFailing).toBeUndefined()
    // The rows were added without docs facts; the docs coming back fills them.
    state.docs = 'ok'
    expect(await pollProviderModels(broken, provider)).toMatchObject({
      updated: 2,
      failures: 0,
    })
  })

  it('truncates a long error in the docs-failing record', async () => {
    const id = 'poll-docs-long-error'
    const deps = await freshDeps(id)
    const record = await recordDocsFailing(
      deps.db,
      id,
      {
        failed: 1,
        skipped: 0,
        first: [{ source: DOC, error: 'x'.repeat(5000), elapsedMs: 1 }],
      },
      10,
    )
    expect(record?.error).toHaveLength(500)
  })

  it('reports a whole docs host down as a few events and a count', async () => {
    const id = 'poll-docs-capped'
    const deps = await freshDeps(id)
    const first = Array.from({ length: 5 }, (_, i) => ({
      source: `${DOC}?${String(i)}`,
      error: '503',
      elapsedMs: 2500,
    }))
    const { outcome, events } = await pollWithEvents(deps, {
      ...stubProvider(id, []),
      listModels: () =>
        Promise.resolve({
          models: [{ rawId: 'm', activity: 'chat' }],
          docsFailures: { failed: 48, skipped: 32, first },
        }),
    })
    expect(outcome.failures).toBe(80)
    expect(events).toHaveLength(6)
    expect(events[5]).toMatchObject({
      event: 'ingest_failed',
      properties: {
        error:
          'docs: 43 more failed, 32 not attempted after the failure budget',
      },
    })
    expect(await readDocsFailing(deps.db, id)).toMatchObject({
      polls: 1,
      failed: 48,
      skipped: 32,
      sources: first.map((failure) => failure.source),
    })
  })

  it('counts every failure, keeps the first five, and charges overlapping loads once', async () => {
    const run = docsRun()
    const slow = () =>
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('down'))
        }, 40)
      })
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        tryDocs(run, `${DOC}?${String(i)}`, slow),
      ),
    )
    expect(docsReport(run)).toMatchObject({ failed: 8, skipped: 0 })
    expect(run.first).toHaveLength(5)
    // Eight concurrent 40 ms failures cost about 40 ms of wall clock, not 320.
    expect(run.lostMs).toBeGreaterThanOrEqual(30)
    expect(run.lostMs).toBeLessThan(160)
  })

  it('serves cached docs and skips the rest once failures have cost the budget', async () => {
    const kv = env.SCHEMA_CACHE
    const cachedUrl = `${DOC}?cached`
    await cachedDocs(kv, cachedUrl, () => Promise.resolve({ rows: 3 }))
    // One load that hung to its timeout.
    const run = { ...docsRun(), failed: 1, lostMs: 60_000 }
    let fetches = 0
    const fetchDoc = () => {
      fetches++
      return Promise.resolve({ rows: 9 })
    }
    expect(
      await tryDocs(run, cachedUrl, (cached) =>
        cached(kv, cachedUrl, fetchDoc),
      ),
    ).toEqual({ rows: 3 })
    const missUrl = `${DOC}?miss`
    expect(
      await tryDocs(run, missUrl, (cached) => cached(kv, missUrl, fetchDoc)),
    ).toBeNull()
    expect(fetches).toBe(0)
    expect(docsReport(run)).toEqual({ failed: 1, skipped: 1, first: [] })
  })
})

describe('Hugging Face prices follow provider agreement', () => {
  const route = (name: string, input: number) => ({
    provider: name,
    status: 'live',
    context_length: 8192,
    pricing: { input, output: 0.2 },
    supports_tools: true,
    supports_structured_output: false,
  })
  const payload = (list: Array<unknown>) => ({
    data: [
      {
        id: 'org/model',
        created: 1_785_918_179,
        architecture: {
          input_modalities: ['text'],
          output_modalities: ['text'],
        },
        providers: list,
      },
    ],
  })

  it('settled → unsettled → settled: card, cleared, card', async () => {
    const id = 'poll-hf-flip'
    const deps = await freshDeps(id)
    let hosts: Array<unknown> = [route('nscale', 0.07)]
    const provider: ProviderConfig = {
      ...stubProvider(id, []),
      listModels: () => parseHuggingFaceModels(payload(hosts)),
    }
    const inputRate = async () => {
      const card = (await storedRow(deps, id, 'org/model')).pricing as {
        tables: { rate: { base: { input_tokens: number } } }
      } | null
      return card?.tables.rate.base.input_tokens ?? null
    }

    expect((await pollWithEvents(deps, provider)).outcome).toMatchObject({
      added: 1,
      failures: 0,
    })
    expect(await inputRate()).toBe(0.07 / 1e6)

    // A second host joins at another price: no single price holds.
    hosts = [route('nscale', 0.07), route('novita', 0.09)]
    const unsettled = await pollWithEvents(deps, provider)
    expect(unsettled.outcome).toMatchObject({ updated: 1, failures: 0 })
    expect(unsettled.events).toEqual([])
    const row = await storedRow(deps, id, 'org/model')
    expect(row.pricing).toBeNull()
    expect(row.contextWindow).toBe(8192)
    expect(row.factSources).not.toHaveProperty('pricing')
    const quiet = await pollWithEvents(deps, provider)
    expect(quiet.outcome).toMatchObject({ updated: 0, failures: 0 })

    // They agree again, at the new price.
    hosts = [route('nscale', 0.09), route('novita', 0.09)]
    const settled = await pollWithEvents(deps, provider)
    expect(settled.outcome).toMatchObject({ updated: 1, failures: 0 })
    expect(await inputRate()).toBe(0.09 / 1e6)
    expect((await pollWithEvents(deps, provider)).outcome).toMatchObject({
      updated: 0,
      failures: 0,
    })
  })
})

describe('raw ids that slug to one row', () => {
  it('keeps the first spelling and skips the second before any check', async () => {
    const id = 'poll-duplicate-slug'
    const deps = await freshDeps(id)
    // Mistral lists both spellings; only one carries the price.
    const provider = stubProvider(id, [
      {
        rawId: 'medium-3-5',
        activity: 'chat',
        pricing: { prompt: '0.0000025', completion: '0.00001' },
      },
      { rawId: 'medium-3.5', activity: 'chat' },
    ])
    expect(modelDbId(id, 'medium-3-5')).toBe(modelDbId(id, 'medium-3.5'))

    const first = await pollWithEvents(deps, provider)
    expect(first.outcome).toMatchObject({ modelsSeen: 2, added: 1 })
    // The second poll is the one that used to see the stored card.
    const second = await pollWithEvents(deps, provider)
    for (const { outcome, events } of [first, second]) {
      expect(outcome.failures).toBe(0)
      expect(events).toEqual([])
    }
    expect(second.outcome).toMatchObject({ added: 0, updated: 0, removed: 0 })

    const rows = await deps.db
      .select()
      .from(models)
      .where(eq(models.providerId, id))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.rawId).toBe('medium-3-5')
    expect(rows[0]?.pricing).not.toBeNull()
  })
})

it('binds an opted-in native route with no schemas and derives no model facts', async () => {
  const id = 'poll-native-route-only'
  const deps = await freshDeps(id)
  const provider: ProviderConfig = {
    ...stubProvider(id, [
      {
        rawId: 'claude-example',
        activity: 'chat',
        schemaEndpointId: 'v1/messages',
      },
    ]),
    bindSyncedRoutesOnly: true,
    bindStoredRoutesWithoutSchemas: true,
  }
  await pollProviderModels(deps, provider)
  expect(
    (await storedRow(deps, id, 'claude-example')).schemaEndpointId,
  ).toBeNull()
  await deps.db.insert(endpoints).values({
    id: `${id}/v1/messages`,
    providerId: id,
    activity: 'chat',
    method: 'POST',
    path: '/v1/messages',
  })
  await pollProviderModels(deps, provider)
  const row = await storedRow(deps, id, 'claude-example')
  expect(row.schemaEndpointId).toBe('v1/messages')
  expect(row.reasoning).toBeNull()
  expect(row.requestMap).toBeNull()
  expect(row.capabilities).toBeNull()
})

const STAMP = {
  url: 'https://example.com/pricing',
  hash: 'a'.repeat(64),
  extractedAt: '2026-01-01T00:00:00.000Z',
}

function tokenCard(
  rates: Record<string, number>,
  stamp: RateCard['source'] = STAMP,
): RateCard {
  const card = compileTokenCard(rates, [], stamp)
  if (!card) throw new Error('token card did not compile')
  return card
}

/** Clock, hash, key order, `+` operands, and `values`, all moved. */
function noisePricing(pricing: unknown): unknown {
  const copy: unknown = structuredClone(pricing)
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const record = node as Record<string, unknown>
    if (Array.isArray(record['+'])) record['+'].reverse()
    if (Array.isArray(record.values)) record.values.reverse()
    if (typeof record.source === 'object' && record.source !== null) {
      const source = record.source as Record<string, unknown>
      if (typeof source.hash === 'string') source.hash = 'b'.repeat(64)
      if (typeof source.extractedAt === 'string') {
        source.extractedAt = '2026-10-13T12:00:00.000Z'
      }
    }
    for (const child of Object.values(record)) walk(child)
  }
  walk(copy)
  const shuffle = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(shuffle)
    if (typeof value !== 'object' || value === null) return value
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    ).reverse()) {
      out[key] = shuffle(child)
    }
    return out
  }
  return shuffle(copy)
}

describe('model.updated facts', () => {
  it('writes nothing when only stamps and representation move', async () => {
    const id = 'poll-fact-noise'
    const deps = await freshDeps(id)
    const pricing = tokenCard({
      input_tokens: 3,
      cache_read_tokens: 0.3,
      output_tokens: 15,
    })
    pricing.inputs.resolution = {
      param: 'resolution',
      kind: 'enum',
      values: ['720p', '1080p', '480p'],
      default: '720p',
    }
    const ratio = {
      param: 'ratio',
      kind: 'enum' as const,
      values: ['16:9', '1:1'],
      default: '16:9',
    }
    const output = pricing.inputs.output_tokens
    if (output?.kind === 'number') {
      output.estimate = {
        inputs: { ratio },
        value: { var: 'ratio' },
        source: {
          url: 'https://example.com/estimate',
          hash: 'c'.repeat(64),
        },
      }
    }
    const listed = {
      rawId: 'priced',
      displayName: 'Priced',
      activity: 'chat' as const,
      contextWindow: 8000,
      pricing,
    }
    await pollProviderModels(deps, stubProvider(id, [listed]))
    const stored = await storedRow(deps, id, 'priced')
    const again = await pollProviderModels(
      deps,
      stubProvider(id, [{ ...listed, pricing: noisePricing(pricing) }]),
    )
    expect(again).toMatchObject({ added: 0, updated: 0, removed: 0 })
    const row = await storedRow(deps, id, 'priced')
    expect(row.pricing).toEqual(stored.pricing)
    expect(row.lastSeenAt).toBeGreaterThan(stored.lastSeenAt)
    const updates = await deps.db
      .select()
      .from(changes)
      .where(eq(changes.providerId, id))
    expect(updates.filter((change) => change.type === 'model.updated')).toEqual(
      [],
    )
  })

  it('still writes a rate, a term, and expiresAt', async () => {
    const id = 'poll-fact-real'
    const deps = await freshDeps(id)
    const pricing = tokenCard({ input_tokens: 3, output_tokens: 15 })
    const listed = {
      rawId: 'priced',
      activity: 'chat' as const,
      pricing,
    }
    await pollProviderModels(deps, stubProvider(id, [listed]))

    const raised = tokenCard(
      { input_tokens: 9, output_tokens: 15 },
      { ...STAMP, hash: 'd'.repeat(64) },
    )
    const rate = await pollProviderModels(
      deps,
      stubProvider(id, [{ ...listed, pricing: raised }]),
    )
    expect(rate.updated).toBe(1)
    const written = async () =>
      (
        await deps.db.select().from(changes).where(eq(changes.providerId, id))
      ).filter((change) => change.type === 'model.updated')
    const rateChange = (await written()).at(-1)
    const changed = (rateChange!.payload as { changed?: Array<string> }).changed
    expect(changed?.length).toBeGreaterThan(0)
    expect(changed).toContain('pricing.tables.rate.base.input_tokens')

    const dated = structuredClone(raised)
    dated.source = { ...dated.source, expiresAt: '2026-12-01T00:00:00.000Z' }
    const expiry = await pollProviderModels(
      deps,
      stubProvider(id, [{ ...listed, pricing: dated }]),
    )
    expect(expiry.updated).toBe(1)
    const expiryChange = (await written()).at(-1)
    expect(
      (expiryChange!.payload as { changed: Array<string> }).changed,
    ).toEqual(['pricing.source.expiresAt'])

    const extra = tokenCard(
      { input_tokens: 9, output_tokens: 15, cache_read_tokens: 1 },
      { ...dated.source, hash: 'e'.repeat(64) },
    )
    extra.source = { ...extra.source, expiresAt: dated.source.expiresAt }
    const added = await pollProviderModels(
      deps,
      stubProvider(id, [{ ...listed, pricing: extra }]),
    )
    expect(added.updated).toBe(1)
    const addedChange = (await written()).at(-1)
    expect(
      (addedChange!.payload as { changed: Array<string> }).changed.some(
        (path) => path.includes('cache_read_tokens'),
      ),
    ).toBe(true)

    const dropped = await pollProviderModels(
      deps,
      stubProvider(id, [{ ...listed, pricing: dated }]),
    )
    expect(dropped.updated).toBe(1)
    const droppedChange = (await written()).at(-1)
    expect(
      (droppedChange!.payload as { changed: Array<string> }).changed.some(
        (path) => path.includes('cache_read_tokens'),
      ),
    ).toBe(true)
  })

  it('treats every rate-card fixture as unchanged after the same noise', async () => {
    const id = 'poll-fact-fixtures'
    const deps = await freshDeps(id)
    const list = Object.entries(FIXTURE_CARDS).map(([rawId, pricing]) => ({
      rawId,
      activity: 'video' as const,
      pricing,
    }))
    const slugs = new Set(list.map((row) => modelDbId(id, row.rawId)))
    expect(slugs.size).toBe(list.length)
    await pollProviderModels(deps, stubProvider(id, list))
    const before = await deps.db
      .select({ id: models.id, pricing: models.pricing })
      .from(models)
      .where(eq(models.providerId, id))
    const noised = list.map((row) => ({
      ...row,
      pricing: noisePricing(row.pricing) as RateCard,
    }))
    const second = await pollProviderModels(deps, stubProvider(id, noised))
    expect(second).toMatchObject({ added: 0, updated: 0, removed: 0 })
    const after = await deps.db
      .select({ id: models.id, pricing: models.pricing })
      .from(models)
      .where(eq(models.providerId, id))
    expect(after).toEqual(before)
  })

  it('marks an update storm and clears it on the next quiet poll', async () => {
    const id = 'poll-update-storm'
    const deps = await freshDeps(id)
    const list = Array.from({ length: 21 }, (_, index) => ({
      rawId: `row-${String(index)}`,
      displayName: `Row ${String(index)}`,
      activity: 'chat' as const,
    }))
    await pollProviderModels(deps, stubProvider(id, list))
    const storm = await pollWithEvents(
      deps,
      stubProvider(
        id,
        list.map((row) => ({ ...row, displayName: `${row.displayName} next` })),
      ),
    )
    expect(storm.outcome.updated).toBe(21)
    expect(storm.events).toContainEqual({
      event: 'update_storm',
      properties: { providerId: id, updated: 21, live: 21 },
    })
    const marked = await deps.db.query.cacheMeta.findFirst({
      where: eq(cacheMeta.key, `update-storm:${id}`),
    })
    expect(JSON.parse(marked?.lastError ?? '')).toMatchObject({
      polls: 1,
      updated: 21,
      live: 21,
    })
    const quiet = await pollProviderModels(
      deps,
      stubProvider(
        id,
        list.map((row) => ({ ...row, displayName: `${row.displayName} next` })),
      ),
    )
    expect(quiet.updated).toBe(0)
    const cleared = await deps.db.query.cacheMeta.findFirst({
      where: eq(cacheMeta.key, `update-storm:${id}`),
    })
    expect(cleared).toBeUndefined()
  })
})

describe('D1 overload window (issue #625)', () => {
  it('keeps lastSeenAt chunks under the parameter cap', () => {
    expect(LAST_SEEN_CHUNK).toBeLessThan(100)
    expect(d1WindowExhausted('listing 503')).toBe(false)
    expect(
      d1WindowExhausted(
        'Failed query: update models set last_seen_at = ? where id in (?) ← caused by: D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window',
      ),
    ).toBe(true)
    expect(
      d1WindowExhausted(
        'D1_ERROR: Internal error in D1 DB storage caused object to be reset.',
      ),
    ).toBe(true)
  })

  async function twoProviders(
    thrown: string,
    suffix: string,
  ): Promise<{
    waits: Array<number>
    calls: number
    outcomes: Awaited<ReturnType<typeof pollAllProviders>>
  }> {
    const waits: Array<number> = []
    let calls = 0
    const failingId = `overload-a-${suffix}`
    const nextId = `overload-b-${suffix}`
    const failing = stubProvider(failingId, [{ rawId: 'a' }])
    failing.listModels = () => {
      calls++
      return Promise.reject(new Error(thrown))
    }
    const next = stubProvider(nextId, [{ rawId: 'b' }])
    const deps = await freshDeps(failingId)
    await deps.db.insert(providers).values({
      id: nextId,
      displayName: 'Stub',
      specSourceUrl: 'https://example.com/spec.json',
    })
    const outcomes = await pollAllProviders(deps, [failing, next], (ms) => {
      waits.push(ms)
      return Promise.resolve()
    })
    const row = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(nextId, 'b')),
    })
    expect(row?.rawId).toBe('b')
    return { waits, calls, outcomes }
  }

  it('reports the overload and still polls the next provider', async () => {
    const { waits, calls, outcomes } = await twoProviders(
      'D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window',
      'spent',
    )
    expect(calls).toBe(1)
    expect(waits).toEqual([D1_WINDOW_WAIT_MS])
    expect(D1_WINDOW_WAIT_MS).toBe(10_000)
    expect(outcomes[0]).toMatchObject({
      providerId: 'overload-a-spent',
      failures: 1,
      modelsSeen: 0,
      error: expect.stringContaining('D1 DB is overloaded') as string,
    })
    expect(outcomes[1]).toMatchObject({
      providerId: 'overload-b-spent',
      failures: 0,
      added: 1,
    })
  })

  it('waits out an internal error and does not wait out any other failure', async () => {
    const internal = await twoProviders(
      'D1_ERROR: Internal error in D1 DB storage caused object to be reset.',
      'reset',
    )
    expect(internal.waits).toEqual([D1_WINDOW_WAIT_MS])
    expect(internal.outcomes[1]?.added).toBe(1)

    const other = await twoProviders('listing 503', 'other')
    expect(other.calls).toBe(1)
    expect(other.waits).toEqual([])
    expect(other.outcomes[0]?.error).toContain('listing 503')
    expect(other.outcomes[1]).toMatchObject({ added: 1, failures: 0 })
  })
})
