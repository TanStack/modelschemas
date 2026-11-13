import { requestUrl } from '#/lib/text.ts'
import { readFileSync } from 'node:fs'
import { Validator } from '@cfworker/json-schema'
import { price } from '@modelschemas/rate-card'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  htmlTables,
  nativeSchemas,
  xiaomiSpec,
  XIAOMI_SCHEMA_URLS,
  XIAOMI_MODELS,
  XIAOMI_PRICING,
  XIAOMI_THINKING,
} from '../xiaomi-docs.ts'
import { parseXiaomiModels, parseXiaomiPricing, provider } from './xiaomi.ts'

const fixture = (name: string) =>
  readFileSync(
    new URL(`../fixtures/xiaomi/${name}.txt`, import.meta.url),
    'utf8',
  )
const catalog = fixture('model.md')
const pricing = fixture('pay-as-you-go.md')
const pricingSource = {
  url: XIAOMI_PRICING,
  hash: 'fixture',
  extractedAt: '2026-10-09T00:00:00Z',
}
afterEach(() => vi.unstubAllGlobals())
function mockDocs(failedUrl?: string, modelDocument = catalog, status = 503) {
  const requested: Array<string> = []
  vi.stubGlobal('fetch', (input: string | URL | Request) => {
    const url = requestUrl(input)
    requested.push(url)
    if (!url.startsWith('https://mimo.mi.com/static/docs/'))
      throw new Error(`unexpected source ${url}`)
    return Promise.resolve(
      url === failedUrl
        ? new Response('unavailable', {
            status,
            ...(status === 404 ? { statusText: 'Not Found' } : {}),
          })
        : new Response(
            url === XIAOMI_MODELS
              ? modelDocument
              : fixture(url.split('/').at(-1) ?? ''),
          ),
    )
  })
  return requested
}

describe('Xiaomi native documentation', () => {
  it('expands model table spans without copying a neighboring model fact', () => {
    const models = parseXiaomiModels(catalog)
    expect(models).toHaveLength(9)
    expect(
      models.find((model) => model.rawId === 'mimo-v2.6-pro-ultraspeed'),
    ).toMatchObject({
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      capabilities: ['reasoning', 'streaming', 'tools', 'structured_outputs'],
    })
    expect(
      models.find((model) => model.rawId === 'mimo-v2.5-tts-voicedesign'),
    ).toMatchObject({ contextWindow: 8000, maxOutput: 8000, activity: 'audio' })
    expect(() =>
      htmlTables('<table><tr><td rowspan="3">one</td></tr></table>'),
    ).toThrow(/rowspan/)
  })

  it('uses USD real-time rates without domestic prices or batch discounts', () => {
    const cards = parseXiaomiPricing(pricing, pricingSource)
    const pro = cards.get('mimo-v2.6-pro')
    const asr = cards.get('mimo-v2.5-asr')
    expect(pro).toBeDefined()
    expect(asr).toBeDefined()
    if (!pro || !asr) throw new Error('fixture omitted prices')
    expect(
      price(pro, {}, { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    ).toBeCloseTo(1.305)
    expect(price(asr, {}, { audio_seconds: 3600 })).toBeCloseTo(0.074)
    expect(cards.has('mimo-v2.5-tts')).toBe(false)
    expect(() =>
      parseXiaomiPricing(pricing.replace('$0.435', 'unknown'), pricingSource),
    ).toThrow(/unreadable/)
    expect(() =>
      parseXiaomiPricing(
        pricing.split('### Overseas Pricing')[0] ?? '',
        pricingSource,
      ),
    ).toThrow(/overseas/)
    expect(() =>
      parseXiaomiPricing(
        pricing.replaceAll('Input (Cache Hit)', 'Wrong column'),
        pricingSource,
      ),
    ).toThrow(/headers/)
  })

  it('extracts only first-party model facts and keeps unsourced prices null', async () => {
    const urls = mockDocs()
    const listed = await provider.listModels({})
    expect(new Set(urls)).toEqual(
      new Set([
        XIAOMI_MODELS,
        XIAOMI_PRICING,
        XIAOMI_THINKING,
        XIAOMI_SCHEMA_URLS[0],
      ]),
    )
    expect(
      listed.models.find((model) => model.rawId === 'mimo-v2.6-pro'),
    ).toMatchObject({
      reasoning: { mode: 'toggle', mandatory: false },
      modalities: {
        input: ['text', 'image', 'audio', 'video'],
        output: ['text'],
      },
    })
    expect(
      listed.models.find((model) => model.rawId === 'mimo-v2.5-tts'),
    ).toMatchObject({
      pricing: null,
      reasoning: null,
      absent: { pricing: 'cleared' },
    })
    expect(
      listed.models.find((model) => model.rawId === 'mimo-v2.5-pro')
        ?.modalities,
    ).toBeNull()
    expect(listed.docsFailures).toEqual({ failed: 0, skipped: 0, first: [] })
  })

  it('keeps every model when the chat docs page 404s', async () => {
    const chatUrl = XIAOMI_SCHEMA_URLS[0]
    if (!chatUrl) throw new Error('missing chat schema source URL')
    mockDocs(chatUrl, catalog, 404)
    const listed = await provider.listModels({})
    expect(listed.models).toHaveLength(9)
    for (const model of listed.models)
      expect(model.absent?.modalities).toBe('unavailable')
    expect(listed.docsFailures?.failed).toBe(1)
    expect(listed.docsFailures?.first[0]?.source).toBe(chatUrl)
    expect(listed.docsFailures?.first[0]?.error).toContain(chatUrl)
    expect(listed.docsFailures?.first[0]?.error).toContain('404')
    expect(
      listed.models.find((model) => model.rawId === 'mimo-v2.6-pro'),
    ).toMatchObject({
      reasoning: { mode: 'toggle', mandatory: false },
    })
    expect(
      listed.models.find((model) => model.rawId === 'mimo-v2.5-tts')?.absent
        ?.pricing,
    ).toBe('cleared')
  })

  it('does not clear prices when the pricing page 404s', async () => {
    mockDocs(XIAOMI_PRICING, catalog, 404)
    const listed = await provider.listModels({})
    expect(listed.models).toHaveLength(9)
    for (const model of listed.models)
      expect(model.absent?.pricing).toBe('unavailable')
    expect(
      listed.models.find((model) => model.rawId === 'mimo-v2.5-tts')?.absent
        ?.pricing,
    ).toBe('unavailable')
    expect(listed.docsFailures?.first[0]?.source).toBe(XIAOMI_PRICING)
    expect(
      listed.models.find((model) => model.rawId === 'mimo-v2.6-pro'),
    ).toMatchObject({
      reasoning: { mode: 'toggle', mandatory: false },
      modalities: {
        input: ['text', 'image', 'audio', 'video'],
        output: ['text'],
      },
    })
  })

  it('keeps stored reasoning when the thinking page 404s', async () => {
    mockDocs(XIAOMI_THINKING, catalog, 404)
    const listed = await provider.listModels({})
    expect(listed.models).toHaveLength(9)
    for (const model of listed.models)
      expect(model.absent?.reasoning).toBe('unavailable')
    expect(listed.docsFailures?.first[0]?.source).toBe(XIAOMI_THINKING)
  })

  it('fails a fetch or malformed source rather than returning a successful empty listing', async () => {
    mockDocs(XIAOMI_MODELS)
    await expect(provider.listModels({})).rejects.toThrow(/503/)
    expect(() => parseXiaomiModels('<html>login</html>')).toThrow()
    expect(() =>
      parseXiaomiModels(catalog.replaceAll('Context Window:', 'Unrecognized:')),
    ).toThrow(/limits/)
    expect(() =>
      parseXiaomiModels(
        catalog.replaceAll('Context Window: 1M', 'Context Window: 0'),
      ),
    ).toThrow(/invalid token/)
  })

  it('keeps a newly listed model with an unsourced price null', async () => {
    const added = catalog.replace(
      '`mimo-v2.6-pro`</span>',
      '`mimo-v2.6-pro` `mimo-unpriced-test`</span>',
    )
    mockDocs(undefined, added)
    const listed = await provider.listModels({})
    const addedModel = listed.models.find(
      (model) => model.rawId === 'mimo-unpriced-test',
    )
    expect(addedModel).toMatchObject({ pricing: null })
    expect(addedModel?.absent?.pricing).toBeUndefined()
  })

  it('converts native schema variants and real shared paths, including audio branches', async () => {
    mockDocs()
    const result = await provider.fetchSpec({})
    const spec = result.specs[0]
    expect(Object.keys(spec?.paths ?? {})).toEqual([
      '/v1/chat/completions',
      '/v1/responses',
      '/anthropic/v1/messages',
    ])
    expect(result.sources.map((source) => source.url)).toEqual(
      XIAOMI_SCHEMA_URLS,
    )
    const request = spec?.paths?.['/v1/chat/completions']?.post
      ?.requestBody as { content: { 'application/json': { schema: object } } }
    const validator = new Validator(request.content['application/json'].schema)
    expect(
      validator.validate({
        model: 'mimo-v2.6-pro',
        messages: [{ role: 'user', content: 'Hello' }],
      }).valid,
    ).toBe(true)
    expect(
      validator.validate({
        model: 'invented',
        messages: [{ role: 'user', content: 'Hello' }],
      }).valid,
    ).toBe(false)
    expect(
      validator.validate({
        model: 'mimo-v2.6-pro',
        messages: [{ role: 'invented', content: 'Hello' }],
      }).valid,
    ).toBe(false)
    expect(
      validator.validate({
        model: 'mimo-v2.5-asr',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'input_audio',
                input_audio: { data: 'base64', format: 'wav' },
              },
            ],
          },
        ],
      }).valid,
    ).toBe(true)
    expect(
      provider.generationEndpointId?.({
        rawId: 'mimo-v2.5-asr',
        activity: 'audio',
      }),
    ).toBeNull()
  })

  it('rejects malformed native trees and unknown types without generic schema fallbacks', () => {
    expect(() => nativeSchemas('<InlineSchemaV2 schema={`broken`} />')).toThrow(
      /JSON/,
    )
    expect(() =>
      nativeSchemas(
        '<InlineSchemaV2 schema={`[{"name":"x","type":"invented","isBold":true}]`} />',
      ),
    ).toThrow(/unsupported/)
    expect(() =>
      xiaomiSpec([
        {
          text: fixture('openai-api.md').replace(
            '## Request Address',
            '## Missing',
          ),
          url: 'test',
        },
      ]),
    ).toThrow(/address/)
  })
})
