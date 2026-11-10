import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { afterEach, expect, it, vi } from 'vitest'
import ledgerMarkdown from '../../../docs/source-silent/ant-ling.md?raw'
import { buildReport, parseLedger } from '../../lib/completeness.ts'
import type { ModelRow } from '../../lib/completeness.ts'
import { getDb } from '../../db/index.ts'
import { models } from '../../db/schema.ts'
import { provider } from '../providers/adapters/ant-ling.ts'
import type { ModelFactSources } from '../providers/types.ts'
import fixtures from '../providers/fixtures/ant-ling-docs.json'
import { pollProviderModels } from './poll-models.ts'
import { syncProvider } from './sync.ts'

afterEach(() => vi.unstubAllGlobals())

it('syncs native Ant Ling schema without spreading model-specific reasoning across its rows', async () => {
  const BROWSER = {
    quickAction: async (action: string, options: { url?: string }) => {
      if (action !== 'content' || !options.url)
        throw new Error('unexpected browser action')
      const url = options.url
      const body = (fixtures as Record<string, string>)[url]
      if (body === undefined) throw new Error(`unexpected native source ${url}`)
      return Response.json({
        success: true,
        result: body,
        meta: { status: 200, finalUrl: url, title: 'native fixture' },
      })
    },
  } as unknown as Pick<BrowserRun, 'quickAction'>
  vi.stubGlobal('fetch', async () => {
    throw new Error('native browser reader must not use direct fetch')
  })
  const db = getDb(env)
  const deps = { db, kv: env.SCHEMA_CACHE, secrets: { BROWSER } }
  const synced = await syncProvider(deps, provider)
  expect(synced.endpointsSeen).toBeGreaterThan(0)
  const outcome = await pollProviderModels(deps, provider)
  expect(outcome.modelsSeen).toBe(8)
  expect(outcome.added).toBe(8)
  expect(outcome.failures).toBe(0)
  const rows = await db
    .select()
    .from(models)
    .where(eq(models.providerId, provider.id))
  for (const rawId of ['Ling-2.6-1T', 'Ling-2.6-flash', 'Ring-2.6-1T']) {
    const row = rows.find((model) => model.rawId === rawId)
    expect(row?.activity).toBe('chat')
    expect(row?.pricing).not.toBeNull()
    expect(row?.maxOutput).toBeNull()
  }
  const reasoningIds = ['Ling-3.0-flash', 'Ring-2.6-1T']
  for (const row of rows.filter((item) => item.activity === 'chat')) {
    expect(row.capabilities?.reasoning, row.rawId).toBe(
      reasoningIds.includes(row.rawId) ? true : undefined,
    )
  }
  expect(rows.find((row) => row.rawId === 'Ling-3.0-flash')?.reasoning).toEqual(
    { mode: 'toggle', mandatory: false },
  )
  expect(rows.find((row) => row.rawId === 'Ring-2.6-1T')?.reasoning).toEqual({
    mode: 'effort',
    mandatory: null,
    efforts: ['high', 'xhigh'],
  })
  for (const row of rows.filter((item) => item.activity === 'chat')) {
    if (!reasoningIds.includes(row.rawId)) expect(row.reasoning).toBeNull()
    else
      expect(
        (row.factSources as ModelFactSources | null)?.capabilities?.reasoning,
      ).toMatchObject({
        derivation: 'docs-derived',
        sourceUrl:
          'https://developer.ant-ling.com/en/docs/api-reference/chat/openai/',
      })
  }
  const report = buildReport(
    rows.map((row) => ({
      ...row,
      provider: provider.id,
      modalities: row.modalities as ModelRow['modalities'],
      pricing: row.pricing as ModelRow['pricing'],
      reasoning: row.reasoning as ModelRow['reasoning'],
      factSources: row.factSources as ModelRow['factSources'],
    })),
    parseLedger(ledgerMarkdown),
  ).providers[0]!
  expect(report.chat).toBe(7)
  expect(report.score).toBe(1)
  const plain = rows.find(
    (row) => row.activity === 'chat' && !reasoningIds.includes(row.rawId),
  )!
  await db
    .update(models)
    .set({ capabilities: { ...plain.capabilities, reasoning: true } })
    .where(eq(models.id, plain.id))
  const again = await pollProviderModels(deps, provider)
  expect(again.failures).toBe(0)
  const refreshed = await db
    .select()
    .from(models)
    .where(eq(models.providerId, provider.id))
  for (const row of refreshed.filter((item) => item.activity === 'chat')) {
    expect(row.capabilities?.reasoning, row.rawId).toBe(
      reasoningIds.includes(row.rawId) ? true : undefined,
    )
  }
})
