import { describe, expect, it } from 'vitest'

import { sourceSilentLedger } from '../src/server/source-silent.ts'
import {
  buildReport,
  failing,
  parseLedger,
  readLedger,
  formatTable,
} from './gap-report.ts'
import type { ModelRow } from './gap-report.ts'

const complete: ModelRow = {
  provider: 'full',
  activity: 'chat',
  contextWindow: 200000,
  maxOutput: 64000,
  modalities: { input: ['text'] },
  pricing: {
    tables: {
      rate: {
        base: {
          input_tokens: 1e-6,
          output_tokens: 2e-6,
          cache_read_tokens: 1e-7,
        },
      },
    },
    source: { url: 'https://docs.example.com/pricing' },
  },
  capabilities: { reasoning: true, tools: true },
  reasoning: { mode: 'effort', efforts: ['low', 'high'] },
  requestMap: { maxTokensField: 'max_tokens', replayReasoningContent: false },
  schemaEndpointId: 'full/chat/completions',
}

// Listing-compiled cards carry OpenRouter's key names.
const listingTables = {
  rate: { base: { prompt: 1e-6, completion: 2e-6, input_cache_read: 1e-7 } },
}

const rows: Array<ModelRow> = [
  complete,
  {
    ...complete,
    provider: 'borrowed',
    pricing: {
      tables: listingTables,
      source: { url: 'https://models.dev/api.json' },
    },
  },
  { ...complete, provider: 'quiet', maxOutput: null },
  { provider: 'images', activity: 'image' },
  { provider: 'images', activity: null },
]

const ledger = parseLedger(
  '# Ledger\n\n- quiet: maxOutput — not published (#75)\n',
)
const report = buildReport(rows, ledger, new Date(0))
const provider = (id: string, from = report) => {
  const found = from.providers.find((p) => p.provider === id)
  if (!found) throw new Error(`no provider ${id}`)
  return found
}

describe('gap report scoring', () => {
  it('scores a complete row 1', () => {
    const full = provider('full')
    expect(full.score).toBe(1)
    expect(full.facts.priced).toEqual({ have: 1, need: 1 })
    expect(full.facts.efforts).toEqual({ have: 1, need: 1 })
    expect(report.generatedAt).toBe('1970-01-01T00:00:00.000Z')
  })

  it('does not count a models.dev price as filled', () => {
    const borrowed = provider('borrowed')
    expect(borrowed.fromModelsDev).toBe(1)
    expect(borrowed.facts.priced).toEqual({ have: 0, need: 1 })
    expect(borrowed.facts.cacheRead).toEqual({ have: 0, need: 1 })
    expect(borrowed.score).toBeCloseTo(9 / 11)
  })

  it('reads both rate key spellings', () => {
    const own = buildReport([
      { ...complete, pricing: { tables: listingTables } },
    ])
    expect(provider('full', own).score).toBe(1)
  })

  it('counts a card with no base row only when every row prices the lever', () => {
    const rate = {
      off_peak: {
        input_tokens: 1e-7,
        output_tokens: 4e-7,
        cache_read_tokens: 1e-9,
      },
      peak: { input_tokens: 2e-7, output_tokens: 8e-7 },
    }
    const periods = provider(
      'full',
      buildReport([{ ...complete, pricing: { tables: { rate } } }]),
    )
    expect(periods.facts.priced).toEqual({ have: 1, need: 1 })
    expect(periods.facts.cacheRead).toEqual({ have: 0, need: 1 })
    const both = {
      off_peak: rate.off_peak,
      peak: { ...rate.peak, cache_read_tokens: 2e-9 },
    }
    const fullPeriods = provider(
      'full',
      buildReport([{ ...complete, pricing: { tables: { rate: both } } }]),
    )
    expect(fullPeriods.facts.priced).toEqual({ have: 1, need: 1 })
    expect(fullPeriods.facts.cacheRead).toEqual({ have: 1, need: 1 })
  })

  it('counts a card in another currency as priced', () => {
    const yuan = buildReport([
      {
        ...complete,
        pricing: {
          ...complete.pricing,
          price: { currency: ['CNY', 0] },
        } as ModelRow['pricing'],
      },
    ])
    expect(provider('full', yuan).facts.priced).toEqual({ have: 1, need: 1 })
    expect(provider('full', yuan).facts.cacheRead).toEqual({ have: 1, need: 1 })
  })

  it('leaves a ledger fact out of the score', () => {
    const quiet = provider('quiet')
    expect(quiet.silent).toEqual(['maxOutput'])
    expect(quiet.facts.maxOutput).toEqual({ have: 0, need: 1 })
    expect(quiet.score).toBe(1)
  })

  it('scores chat rows 1 when every needed fact is on the ledger', () => {
    const all = parseLedger(
      [
        'contextWindow',
        'maxOutput',
        'modalities',
        'priced',
        'cacheRead',
        'capabilities',
        'requestMap',
        'endpoint',
      ]
        .map((fact) => `- bare: ${fact} — not published`)
        .join('\n'),
    )
    const bare = buildReport(
      [{ provider: 'bare', activity: 'chat' }],
      all,
      new Date(0),
    )
    expect(bare.providers[0]).toMatchObject({ chat: 1, score: 1 })
  })

  it('treats unclassified rows with no chat rows as a gap', () => {
    const images = provider('images')
    expect(images).toMatchObject({ rows: 2, chat: 0, noActivity: 1, score: 0 })
    expect(report.providers[0]?.provider).toBe('images')
  })

  it('prints n/a when the provider does not serve chat', () => {
    const speech = buildReport(
      [{ provider: 'speech', activity: 'audio' }],
      new Map(),
      new Date(0),
    )
    expect(speech.providers[0]?.score).toBeNull()
    expect(formatTable(speech)).toContain('n/a')
    expect(failing(speech, 1, ['speech', 'absent'])).toEqual(['absent'])
  })

  it('needs reasoning only where a row claims it', () => {
    const plain = provider(
      'full',
      buildReport([
        {
          ...complete,
          capabilities: { tools: true, reasoning: false },
          reasoning: null,
        },
        { ...complete, reasoning: null },
      ]),
    )
    expect(plain.facts.reasoning).toEqual({ have: 0, need: 1 })
    expect(plain.facts.efforts).toEqual({ have: 0, need: 0 })
  })

  it('asks a toggle row for reasoning and for no efforts', () => {
    const toggles = provider(
      'full',
      buildReport([
        { ...complete, reasoning: { mode: 'toggle', mandatory: false } },
        { ...complete, reasoning: { mode: 'toggle', mandatory: true } },
      ]),
    )
    expect(toggles.facts.reasoning).toEqual({ have: 2, need: 2 })
    expect(toggles.facts.efforts).toEqual({ have: 0, need: 0 })
    expect(toggles.score).toBe(1)
  })

  it('counts efforts with an unstated mandatory as filled', () => {
    const unstated = provider(
      'full',
      buildReport([
        {
          ...complete,
          reasoning: { mode: 'effort', mandatory: null, efforts: ['low'] },
        },
      ]),
    )
    expect(unstated.facts.reasoning).toEqual({ have: 1, need: 1 })
    expect(unstated.facts.efforts).toEqual({ have: 1, need: 1 })
    expect(unstated.score).toBe(1)
  })

  it('flags no shape on a complete row', () => {
    expect(provider('full').flags).toEqual({
      mandatoryUnknown: [],
      reasoningUnknown: [],
      outputModalitiesEmpty: [],
      mandatoryWithNone: [],
    })
  })

  it('flags the shapes the catalog cannot read, apart from the score', () => {
    const flagged = provider(
      'full',
      buildReport([
        {
          ...complete,
          rawId: 'unstated',
          reasoning: { mode: 'effort', mandatory: null, efforts: ['low'] },
        },
        {
          ...complete,
          rawId: 'adaptive-unstated',
          reasoning: { mode: 'adaptive', mandatory: null },
        },
        { ...complete, rawId: 'no-mode', reasoning: null },
        {
          ...complete,
          rawId: 'not-reasoning',
          capabilities: { reasoning: false },
          reasoning: null,
        },
        {
          ...complete,
          rawId: 'no-output',
          modalities: { input: ['text'], output: [] },
        },
        {
          ...complete,
          rawId: 'unknown-output',
          modalities: { input: ['text'], output: null },
        },
        {
          ...complete,
          rawId: 'forced-none',
          reasoning: {
            mode: 'effort',
            mandatory: true,
            efforts: ['none', 'high'],
          },
        },
        {
          ...complete,
          rawId: 'image',
          activity: 'image',
          modalities: { output: [] },
        },
      ]),
    )
    expect(flagged.flags).toEqual({
      mandatoryUnknown: ['unstated'],
      reasoningUnknown: ['no-mode'],
      outputModalitiesEmpty: ['no-output'],
      mandatoryWithNone: ['forced-none'],
    })
    expect(flagged.facts.efforts).toEqual({ have: 4, need: 5 })
    expect(formatTable({ generatedAt: '', providers: [flagged] })).toContain(
      'mandatoryWithNone',
    )
  })

  it('clears reasoningUnknown only for a reasoning ledger entry', () => {
    const hostRows: Array<ModelRow> = [
      { ...complete, provider: 'host', rawId: 'a', reasoning: null },
      {
        ...complete,
        provider: 'host',
        rawId: 'b',
        reasoning: null,
        modalities: { input: ['text'], output: [] },
      },
      { ...complete, provider: 'host', rawId: 'c', reasoning: null },
    ]
    const scoped = provider(
      'host',
      buildReport(
        hostRows,
        parseLedger(
          '- host/a: reasoning — own docs silent\n- host/b: modalities — own docs silent',
        ),
      ),
    )
    expect(scoped.flags.reasoningUnknown).toEqual(['b', 'c'])
    expect(scoped.flags.outputModalitiesEmpty).toEqual(['b'])
    const wide = provider(
      'host',
      buildReport(hostRows, parseLedger('- host: reasoning — not published')),
    )
    expect(wide.flags.reasoningUnknown).toEqual([])
  })

  it('picks the providers below target', () => {
    expect(failing(report, 1)).toEqual(['borrowed'])
    expect(failing(report, 1, ['full', 'images', 'absent'])).toEqual([
      'images',
      'absent',
    ])
    expect(failing(report, 0.8)).toEqual([])
  })

  it('rejects an unknown ledger fact', () => {
    expect(() => parseLedger('- grok: maxOutputs — typo')).toThrow(
      /unknown fact/,
    )
  })
})

describe('source-silent ledger', () => {
  it('is the same bundled into the Worker as read from disk', () => {
    const onDisk = readLedger()
    expect(onDisk?.size).toBeGreaterThan(0)
    expect(sourceSilentLedger).toEqual(onDisk)
  })
})

describe('model-scoped source silence', () => {
  it('matches exact native ids with embedded slashes and keeps published facts counted', () => {
    const scoped = parseLedger(
      '- host/maker/model: maxOutput — own docs silent\n- host/maker/filled: maxOutput — no longer silent',
    )
    const result = provider(
      'host',
      buildReport(
        [
          {
            ...complete,
            provider: 'host',
            rawId: 'maker/model',
            maxOutput: null,
          },
          {
            ...complete,
            provider: 'host',
            rawId: 'maker/model-snapshot',
            maxOutput: null,
          },
          { ...complete, provider: 'host', rawId: 'maker/filled' },
        ],
        scoped,
      ),
    )
    expect(result.silent).toEqual([])
    expect(result.facts.maxOutput).toEqual({ have: 1, need: 3 })
    expect(result.modelSilent).toEqual({ maxOutput: 1 })
    expect(result.score).toBeCloseTo(31 / 32)
    expect(formatTable({ generatedAt: '', providers: [result] })).toContain(
      '1/3 (1 model-silent)',
    )
  })
  it('counts both explicit replay booleans, not null or missing fields', () => {
    const replay = provider(
      'host',
      buildReport(
        [
          {
            ...complete,
            provider: 'host',
            rawId: 'a',
            requestMap: { replayReasoningContent: true },
          },
          {
            ...complete,
            provider: 'host',
            rawId: 'b',
            requestMap: { replayReasoningContent: false },
          },
          {
            ...complete,
            provider: 'host',
            rawId: 'c',
            requestMap: { replayReasoningContent: null },
          },
          { ...complete, provider: 'host', rawId: 'd', requestMap: null },
          {
            ...complete,
            provider: 'host',
            rawId: 'e',
            reasoning: null,
            capabilities: { reasoning: false },
          },
        ],
        parseLedger('- host/c: replayReasoningContent — checked own source'),
      ),
    )
    expect(replay.facts.replayReasoningContent).toEqual({ have: 2, need: 4 })
    expect(replay.modelSilent).toEqual({ replayReasoningContent: 1 })
  })
  it('does not turn a model-scoped entry into a provider exemption or guess missing raw ids', () => {
    const scoped = parseLedger('- host/maker/model: maxOutput — absent')
    const result = provider(
      'host',
      buildReport([{ ...complete, provider: 'host', maxOutput: null }], scoped),
    )
    expect(result.modelSilent).toEqual({})
    expect(result.score).toBeLessThan(1)
  })
  it('preserves provider-wide grammar and avoids double exclusions', () => {
    const scoped = parseLedger(
      '- host: maxOutput — absent\n- `host/@cf/a/model:variant`: maxOutput — absent',
    )
    expect(scoped.get('host/@cf/a/model:variant')).toEqual(
      new Set(['maxOutput']),
    )
    const result = provider(
      'host',
      buildReport(
        [
          {
            ...complete,
            provider: 'host',
            rawId: '@cf/a/model:variant',
            maxOutput: null,
          },
        ],
        scoped,
      ),
    )
    expect(result.silent).toEqual(['maxOutput'])
    expect(result.modelSilent).toEqual({})
    expect(result.score).toBe(1)
    expect(() => parseLedger('- host/: maxOutput — missing model')).toThrow(
      'invalid scope',
    )
    expect(() => parseLedger('- host/model: ')).toThrow('malformed entry')
    expect(() => parseLedger('- host/model: `maxOutput')).toThrow(
      'malformed entry',
    )
    expect(() =>
      parseLedger(
        '- host/id: requestMap.replayReasoningContent — unsupported spelling',
      ),
    ).toThrow('unknown fact')
  })
})
