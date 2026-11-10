import { requestUrl } from '#/lib/text.ts'
import { afterEach, expect, it } from 'vitest'
import docs from './fixtures/openai-gpt5-guides.json'
import realtimeDocs from './fixtures/openai-native-realtime-reasoning.json'
import {
  OPENAI_GPT51_GUIDE_URL,
  OPENAI_GPT52_GUIDE_URL,
  OPENAI_GPT5_GUIDE_URL,
  parseGpt51NoneGuide,
  parseGpt52SamplingGuide,
  parseGpt5FamilyGuide,
} from './openai-gpt5-guides.ts'
import {
  OPENAI_MODELS_INDEX_URL,
  OPENAI_PRICING_URL,
  openaiModelFacts,
} from './openai-model-docs.ts'
import { docsCacheKey, docsRun } from './model-facts.ts'
import { OPENAI_REALTIME_EFFORT_URL } from './openai-realtime-efforts.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const pricing = `Specialized models

Prices per 1M tokens.

Standard

### Grouped Pricing Table data

| Category | Model | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| Search | gpt-5-search-api | $1.25 | $0.125 | $10.00 |
`

const proPage = `Model ID: \`gpt-5-pro\`

GPT-5 Pro defaults to (and only supports) \`reasoning.effort: high\`.

## Model details

- Reasoning token support
`

function serve(
  guides: Partial<Record<string, string>>,
  pages: Record<string, string> = {},
) {
  globalThis.fetch = (input) => {
    const url = requestUrl(input)
    if (url === OPENAI_MODELS_INDEX_URL) {
      const links = [
        '[Mini](/api/docs/models/gpt-5-mini.md)',
        ...Object.keys(pages).map(
          (slug) => `[Model](/api/docs/models/${slug}.md)`,
        ),
      ]
      return Promise.resolve(new Response(links.join('\n')))
    }
    if (url === OPENAI_PRICING_URL)
      return Promise.resolve(new Response(pricing))
    if (url.endsWith('/models/gpt-5-mini.md'))
      return Promise.resolve(new Response(docs['gpt-5-mini-page.md']))
    const slug = url.match(/\/models\/([^/]+)\.md$/)?.[1]
    if (slug && pages[slug] !== undefined)
      return Promise.resolve(new Response(pages[slug]))
    const guide = guides[url]
    if (guide !== undefined) return Promise.resolve(new Response(guide))
    return Promise.resolve(new Response('outage', { status: 503 }))
  }
}

const allGuides = {
  [OPENAI_GPT5_GUIDE_URL]: docs['gpt-5.md'],
  [OPENAI_GPT51_GUIDE_URL]: docs['gpt-5.1.md'],
  [OPENAI_GPT52_GUIDE_URL]: docs['gpt-5.2.md'],
}

it('reads the family, its efforts, the none statement and the sampling refusal', () => {
  expect(parseGpt5FamilyGuide(docs['gpt-5.md'])).toEqual({
    rawIds: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano'],
    efforts: ['minimal', 'low', 'medium', 'high'],
  })
  expect(parseGpt51NoneGuide(docs['gpt-5.1.md'])).toBe('minimal')
  expect(parseGpt52SamplingGuide(docs['gpt-5.2.md'])).toEqual({
    rawIds: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano'],
    flags: ['temperature', 'top_p'],
  })
})

it('throws when a guide sentence is gone or reworded', () => {
  expect(() =>
    parseGpt5FamilyGuide(
      docs['gpt-5.md'].replace('`high`.', '`high`, and more.'),
    ),
  ).toThrow('family or effort list')
  expect(() =>
    parseGpt5FamilyGuide('```\n' + docs['gpt-5.md'] + '\n```'),
  ).toThrow()
  expect(() =>
    parseGpt51NoneGuide(
      docs['gpt-5.1.md'].replace('never use reasoning', 'use fewer reasoning'),
    ),
  ).toThrow('none statement')
  expect(() =>
    parseGpt52SamplingGuide(
      docs['gpt-5.2.md'].replace('- `temperature`\n', ''),
    ),
  ).toThrow('parameter compatibility')
})

it('fills gpt-5-mini reasoning and sampling noes from the guides, with sources', async () => {
  serve(allGuides)
  const facts = await openaiModelFacts(['gpt-5-mini', 'gpt-5-mini-2025-08-07'])
  for (const id of ['gpt-5-mini', 'gpt-5-mini-2025-08-07']) {
    const row = facts(id)
    expect(row.reasoning).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['minimal', 'low', 'medium', 'high'],
    })
    expect(row.factSources?.reasoning?.sourceUrl).toBe(OPENAI_GPT51_GUIDE_URL)
    expect(row.unsupportedCapabilities).toEqual(['temperature', 'top_p'])
    expect(row.factSources?.capabilities?.temperature?.sourceUrl).toBe(
      OPENAI_GPT52_GUIDE_URL,
    )
    expect(row.absent).toBeUndefined()
  }
})

it('keeps efforts unstated as mandatory null when the none guide fails', async () => {
  serve({
    [OPENAI_GPT5_GUIDE_URL]: docs['gpt-5.md'],
    [OPENAI_GPT52_GUIDE_URL]: docs['gpt-5.2.md'],
  })
  const run = docsRun()
  const row = (await openaiModelFacts(['gpt-5-mini'], undefined, run))(
    'gpt-5-mini',
  )
  expect(row.reasoning).toEqual({
    mode: 'effort',
    mandatory: null,
    efforts: ['minimal', 'low', 'medium', 'high'],
  })
  expect(row.factSources?.reasoning?.sourceUrl).toBe(OPENAI_GPT5_GUIDE_URL)
  expect(row.absent).toBeUndefined()
  expect(run.failed).toBe(1)
})

it('marks named family rows unavailable when a guide does not parse', async () => {
  serve(
    {
      ...allGuides,
      [OPENAI_GPT52_GUIDE_URL]: '# Using GPT-5.2\n',
    },
    { 'gpt-5-pro': proPage },
  )
  const run = docsRun()
  const facts = await openaiModelFacts(
    ['gpt-5-mini', 'gpt-5-pro'],
    undefined,
    run,
  )
  expect(facts('gpt-5-mini').unsupportedCapabilities).toBeUndefined()
  expect(facts('gpt-5-mini').absent).toEqual({ capabilities: 'unavailable' })
  expect(facts('gpt-5-pro').reasoning).toEqual({
    mode: 'effort',
    mandatory: true,
    efforts: ['high'],
  })
  expect(facts('gpt-5-pro').absent).toBeUndefined()
  expect(facts('gpt-5-pro').unsupportedCapabilities).toBeUndefined()
  expect(run.first[0]?.source).toBe(OPENAI_GPT52_GUIDE_URL)
})

it('does not copy the family list or sampling noes onto gpt-5-pro', async () => {
  serve(allGuides, { 'gpt-5-pro': proPage })
  const facts = await openaiModelFacts(['gpt-5-mini', 'gpt-5-pro'])
  expect(facts('gpt-5-pro').reasoning).toEqual({
    mode: 'effort',
    mandatory: true,
    efforts: ['high'],
  })
  expect(facts('gpt-5-pro').unsupportedCapabilities).toBeUndefined()
  expect(facts('gpt-5-mini').reasoning?.mandatory).toBe(true)
})

it('does not fetch the guides when no GPT-5 id is listed', async () => {
  serve({})
  const run = docsRun()
  await openaiModelFacts(['gpt-5.1'], undefined, run)
  expect(run.failed).toBe(0)
})

it('keeps the listing when the docs host forbids the index or a page (#371)', async () => {
  const forbidden = () =>
    Promise.resolve(new Response('Forbidden', { status: 403 }))
  globalThis.fetch = forbidden
  const run = docsRun()
  const row = (await openaiModelFacts(['gpt-4o'], undefined, run))('gpt-4o')
  expect(row.pricing).toBeNull()
  expect(row.absent).toMatchObject({
    contextWindow: 'unavailable',
    pricing: 'unavailable',
    capabilities: 'unavailable',
    reasoning: 'unavailable',
  })
  expect(run.first.map((failure) => failure.source)).toEqual([
    OPENAI_MODELS_INDEX_URL,
    OPENAI_PRICING_URL,
  ])

  serve(allGuides, { 'gpt-5-pro': proPage })
  const served = globalThis.fetch
  globalThis.fetch = (input, init) =>
    requestUrl(input).endsWith('/models/gpt-5-mini.md')
      ? forbidden()
      : served(input, init)
  const pageRun = docsRun()
  const facts = await openaiModelFacts(
    ['gpt-5-mini', 'gpt-5-pro', 'gpt-5-search-api'],
    undefined,
    pageRun,
  )
  expect(facts('gpt-5-mini').absent?.capabilities).toBe('unavailable')
  expect(facts('gpt-5-mini').pricing).toBeNull()
  // The failed page may be the alias page that seeds an unindexed id.
  expect(facts('gpt-5-search-api').absent?.pricing).toBe('unavailable')
  expect(facts('gpt-5-pro').reasoning?.mode).toBe('effort')
  expect(facts('gpt-5-pro').absent).toBeUndefined()
  expect(pageRun.failed).toBe(1)
})

it('ignores a search pricing cache written before cacheReadNotOffered', async () => {
  serve(allGuides, { 'gpt-5-pro': proPage })
  const store = new Map<string, string>([
    [
      docsCacheKey(OPENAI_PRICING_URL),
      JSON.stringify({ rates: {}, hash: 'old', extractedAt: 'old' }),
    ],
  ])
  const kv = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => {
      store.set(key, value)
      return Promise.resolve()
    },
  } as unknown as KVNamespace
  const facts = await openaiModelFacts(['gpt-5-search-api'], kv, docsRun())
  expect(facts('gpt-5-search-api').pricing).not.toBeNull()
})

it('marks only unpriced rows when the pricing page alone fails (#371)', async () => {
  serve(allGuides, { 'gpt-5-pro': proPage })
  const served = globalThis.fetch
  globalThis.fetch = (input, init) =>
    requestUrl(input) === OPENAI_PRICING_URL
      ? Promise.resolve(new Response('Forbidden', { status: 403 }))
      : served(input, init)
  const run = docsRun()
  const facts = await openaiModelFacts(
    ['gpt-5-mini', 'gpt-5-search-api'],
    undefined,
    run,
  )
  expect(facts('gpt-5-search-api').absent?.pricing).toBe('unavailable')
  expect(facts('gpt-5-mini').contextWindow).not.toBeNull()
  expect(facts('gpt-5-mini').absent?.contextWindow).toBeUndefined()
  expect(run.first.map((failure) => failure.source)).toEqual([
    OPENAI_PRICING_URL,
  ])
})

it('marks realtime reasoning unavailable when the realtime guide fails (#371)', async () => {
  serve({}, { 'gpt-realtime-2': realtimeDocs['gpt-realtime-2'] })
  const run = docsRun()
  const row = (await openaiModelFacts(['gpt-realtime-2'], undefined, run))(
    'gpt-realtime-2',
  )
  expect(row.reasoning).toEqual({ mode: 'effort', mandatory: null })
  expect(row.absent?.reasoning).toBe('unavailable')
  expect(run.first.map((failure) => failure.source)).toEqual([
    OPENAI_REALTIME_EFFORT_URL,
  ])
})
