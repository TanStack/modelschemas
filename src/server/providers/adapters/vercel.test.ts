import { price } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'
import { afterEach, describe, expect, it } from 'vitest'

import { OPENAI_SPEC_URL } from '../openai.ts'

import {
  parseVercelModels,
  provider,
  VERCEL_MODELS_URL,
  VERCEL_SERVER_URL,
  vercelReasoning,
} from './vercel.ts'

/**
 * Excerpt of https://ai-gateway.vercel.sh/v1/models (2026-10-08).
 * `pricing` values are the gateway's USD-per-token strings.
 */
const FIXTURE = {
  object: 'list',
  data: [
    {
      id: 'alibaba/qwen-3-14b',
      name: 'Qwen3-14B',
      type: 'language',
      context_window: 40960,
      max_tokens: 16384,
      modalities: { input: ['text'], output: ['text'] },
      reasoning_options: [{ type: 'toggle' }],
      supported_parameters: [
        'max_tokens',
        'temperature',
        'tools',
        'reasoning',
        'not_a_flag',
      ],
      pricing: {
        input: '0.00000012',
        output: '0.00000024',
        input_cache_read: '0.00000006',
        input_cache_write: '0.00000015',
        fast: { input: '0.000009', output: '0.000009' },
        service_tiers: {
          flex: { input: '0.00000001', output: '0.00000001' },
        },
      },
      released: 1745798400,
    },
    {
      id: 'alibaba/qwen-3-235b',
      name: 'Qwen3-235B',
      type: 'language',
      modalities: { input: ['text'], output: ['text'] },
      reasoning_options: [
        { type: 'toggle' },
        { type: 'effort', values: ['none', 'low', 'medium', 'high'] },
      ],
      supported_parameters: ['max_tokens', 'stop'],
      pricing: { input: '0.00000018' },
    },
    {
      id: 'google/imagen',
      type: 'image',
      modalities: { input: ['text'], output: ['image'] },
    },
    {
      id: 'inclusionai/ling-3.1-flash',
      type: 'language',
      supported_parameters: ['max_tokens'],
      pricing: { input: '0', output: '0' },
    },
  ],
}

/** OpenAI's document, trimmed: Vercel's compat routes are generated from it. */
const OPENAI_SPEC = {
  openapi: '3.1.0',
  info: { title: 'OpenAI' },
  paths: {
    '/chat/completions': { post: { summary: 'chat' } },
    '/embeddings': { post: { summary: 'embed' } },
    '/batches': { post: { summary: 'batch' } },
  },
}

const SOURCE: RateCard['source'] = {
  url: VERCEL_MODELS_URL,
  hash: 'abc',
  extractedAt: '2026-10-08T00:00:00.000Z',
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('vercel', () => {
  it('lists gateway models from the Vercel payload and generates the compat spec', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      if (String(url) === VERCEL_MODELS_URL) {
        return Promise.resolve(new Response(JSON.stringify(FIXTURE)))
      }
      if (String(url) === OPENAI_SPEC_URL) {
        return Promise.resolve(new Response(JSON.stringify(OPENAI_SPEC)))
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    expect(listed.skipped).toBeUndefined()
    expect(listed.models.map((model) => model.rawId)).toEqual([
      'alibaba/qwen-3-14b',
      'alibaba/qwen-3-235b',
      'google/imagen',
      'inclusionai/ling-3.1-flash',
    ])
    expect(listed.models[0]).toMatchObject({
      displayName: 'Qwen3-14B',
      activity: 'chat',
      contextWindow: 40960,
      maxOutput: 16384,
      modalities: { input: ['text'], output: ['text'] },
      capabilities: ['max_tokens', 'temperature', 'tools', 'reasoning'],
      exactCapabilities: true,
      // A toggle and nothing else: "an on/off control".
      reasoning: { mode: 'toggle', mandatory: false },
      requestMap: {
        thinking: {
          on: { reasoning: { enabled: true } },
          off: { reasoning: { enabled: false } },
          levels: null,
        },
        maxTokensField: 'max_tokens',
        developerRole: null,
        reasoningEffort: null,
      },
      factSources: {
        pricing: {
          derivation: 'listing',
          sourceUrl: VERCEL_MODELS_URL,
          path: 'pricing',
        },
        capabilities: {
          tools: {
            derivation: 'listing',
            sourceUrl: VERCEL_MODELS_URL,
            path: 'supported_parameters.tools',
          },
        },
        reasoning: {
          derivation: 'listing',
          sourceUrl: VERCEL_MODELS_URL,
          sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
          path: 'reasoning.enabled',
        },
      },
      releasedAt: 1745798400,
    })
    expect(listed.models[0]?.pricing).toMatchObject({
      tables: {
        rate: {
          base: {
            input_tokens: 0.00000012,
            output_tokens: 0.00000024,
            cache_read_tokens: 0.00000006,
            cache_write_tokens: 0.00000015,
          },
        },
      },
    })
    // fast and flex are not the standard rate.
    const base = (
      listed.models[0]!.pricing as {
        tables: { rate: { base: Record<string, number> } }
      }
    ).tables.rate.base
    expect(base.input_tokens).toBe(0.00000012)
    // An effort row's thinking body is the level list, not a control path.
    expect(listed.models[1]?.factSources).not.toHaveProperty('reasoning')
    expect(listed.models[1]).toMatchObject({
      pricing: null,
      capabilities: ['max_tokens', 'stop'],
      exactCapabilities: true,
      reasoning: {
        mode: 'effort',
        mandatory: false,
        efforts: ['none', 'low', 'medium', 'high'],
      },
      requestMap: {
        maxTokensField: 'max_tokens',
        thinking: {
          on: { reasoning: { effort: 'high' } },
          off: { reasoning: { effort: 'none' } },
          levels: {
            off: 'none',
            minimal: null,
            low: 'low',
            medium: 'medium',
            high: 'high',
            xhigh: null,
            max: null,
          },
        },
      },
    })
    expect(listed.models[2]).toMatchObject({
      activity: 'image',
      pricing: null,
    })
    expect(listed.models[2]).not.toHaveProperty('factSources')
    expect(listed.models[2]).not.toHaveProperty('requestMap')
    expect(listed.models[2]).not.toHaveProperty('capabilities')
    // A published zero is free, not a card.
    expect(listed.models[3]?.pricing).toBeNull()
    expect(listed.models[3]?.requestMap).toMatchObject({
      maxTokensField: 'max_tokens',
      thinking: null,
    })
    expect(spec.skipped).toBeUndefined()
    expect(Object.keys(spec.specs[0]?.paths ?? {})).toEqual([
      '/chat/completions',
      '/embeddings',
    ])
    expect(spec.specs[0]?.servers).toEqual([{ url: VERCEL_SERVER_URL }])
    expect(urls).toEqual([VERCEL_MODELS_URL, OPENAI_SPEC_URL])
  })

  it('re-quotes the standard schedule above an inclusive context min', () => {
    const [model] = parseVercelModels(
      {
        data: [
          {
            id: 'alibaba/qwen-3.6-max-preview',
            type: 'language',
            pricing: {
              input: '0.000001',
              output: '0.000002',
              input_cache_read: '0.0000001',
              input_tiers: [
                { cost: '0.000001', min: 0, max: 128000 },
                { cost: '0.000002', min: 128000 },
              ],
              output_tiers: [
                { cost: '0.000002', max: 128000 },
                { cost: '0.000004', min: 128000 },
              ],
              input_cache_read_tiers: [
                { cost: '0.0000001', min: 0, max: 128000 },
                { cost: '0.0000002', min: 128000 },
              ],
              regional: { eu: { input: '0.000009', output: '0.000009' } },
            },
          },
        ],
      },
      SOURCE,
    )
    const card = model?.pricing as RateCard
    expect(
      price(card, {}, { input_tokens: 127999, output_tokens: 0 }),
    ).toBeCloseTo(127999 * 0.000001)
    expect(
      price(card, {}, { input_tokens: 128000, output_tokens: 0 }),
    ).toBeCloseTo(128000 * 0.000002)
    expect(
      price(
        card,
        {},
        { input_tokens: 0, output_tokens: 0, cache_read_tokens: 128000 },
      ),
    ).toBeCloseTo(128000 * 0.0000002)
  })

  it('keeps the base cache rate below a tier that omits min 0', () => {
    const [model] = parseVercelModels(
      {
        data: [
          {
            id: 'spacexai/grok-4.20-non-reasoning-beta',
            type: 'language',
            pricing: {
              input: '0.000002',
              output: '0.000006',
              input_cache_read: '0.0000002',
              input_cache_read_tiers: [{ cost: '0.0000004', min: 200001 }],
            },
          },
        ],
      },
      SOURCE,
    )
    const card = model?.pricing as RateCard
    const usage = (cache_read_tokens: number) => ({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens,
    })
    expect(price(card, {}, usage(200000))).toBeCloseTo(200000 * 0.0000002)
    expect(price(card, {}, usage(200001))).toBeCloseTo(200001 * 0.0000004)
  })

  it('uses the toggle when an effort list has no high', () => {
    const [model] = parseVercelModels(
      {
        data: [
          {
            id: 'alibaba/qwen3.8-max',
            type: 'language',
            supported_parameters: ['max_completion_tokens'],
            reasoning_options: [
              { type: 'toggle' },
              { type: 'effort', values: ['low', 'medium', 'xhigh'] },
            ],
          },
        ],
      },
      SOURCE,
    )
    expect(model?.reasoning).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['low', 'medium', 'xhigh'],
    })
    expect(model?.requestMap).toMatchObject({
      maxTokensField: 'max_completion_tokens',
      thinking: {
        on: { reasoning: { enabled: true } },
        off: { reasoning: { enabled: false } },
        levels: null,
      },
    })
  })

  it('stores no thinking body for a budget with no high token count', () => {
    const [model] = parseVercelModels(
      {
        data: [
          {
            id: 'alibaba/qwen3-235b-a22b-thinking',
            type: 'language',
            supported_parameters: ['max_tokens'],
            reasoning_options: [{ type: 'budget_tokens', min: 1, max: 81920 }],
          },
        ],
      },
      SOURCE,
    )
    expect(model?.reasoning).toEqual({ mode: 'budget', mandatory: null })
    expect(model?.requestMap).toMatchObject({
      maxTokensField: 'max_tokens',
      thinking: null,
    })
    expect(model?.factSources?.reasoning).toMatchObject({
      path: 'reasoning.max_tokens',
      sourceUrl: VERCEL_MODELS_URL,
    })
  })

  it('throws when a tier schedule cannot be read', () => {
    const row = (pricing: unknown) => ({
      data: [{ id: 'openai/gpt-6-astra', type: 'language', pricing }],
    })
    expect(() =>
      parseVercelModels(row({ input: '0.00001', input_tiers: 'nope' }), SOURCE),
    ).toThrow(/input_tiers is not an array/)
    expect(() =>
      parseVercelModels(
        row({
          input: '0.00001',
          output: '0.00002',
          input_tiers: [{ cost: '0.00002', min: 0 }],
        }),
        SOURCE,
      ),
    ).toThrow(/disagrees with its first tier/)
    expect(() =>
      parseVercelModels(
        row({
          input: '0.00001',
          output: '0.00002',
          input_tiers: [
            { cost: '0.00001', min: 0, max: 100 },
            { cost: '0.00002', min: 200 },
          ],
        }),
        SOURCE,
      ),
    ).toThrow(/ranges do not meet/)
    expect(() =>
      parseVercelModels(
        {
          data: [
            {
              id: 'openai/gpt-6-astra',
              type: 'language',
              supported_parameters: 'max_tokens',
            },
          ],
        },
        SOURCE,
      ),
    ).toThrow(/supported_parameters is not a string array/)
  })

  it('reads each control the row lists, and nothing it does not know', () => {
    const options = (...reasoning_options: Array<unknown>) =>
      vercelReasoning({ reasoning_options })
    // anthropic/claude-sonnet-4.5: a switch and a budget.
    expect(
      options({ type: 'toggle' }, { type: 'budget_tokens', min: 1024 }),
    ).toEqual({ mode: 'budget', mandatory: false })
    // minimax/minimax-m3: a budget alone says nothing about turning it off.
    expect(options({ type: 'budget_tokens' })).toEqual({
      mode: 'budget',
      mandatory: null,
    })
    // An effort entry keeps its reading whatever sits beside it.
    expect(
      options(
        { type: 'toggle' },
        { type: 'effort', values: ['low', 'medium', 'xhigh'] },
        { type: 'budget_tokens' },
      ),
    ).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['low', 'medium', 'xhigh'],
    })
    // A control type this does not know, an effort entry without values,
    // or no controls: nothing is stored.
    expect(options({ type: 'toggle' }, { type: 'auto' })).toBeNull()
    expect(options({ type: 'switch' })).toBeNull()
    expect(options({ type: 'toggle' }, { type: 'effort' })).toBeNull()
    expect(
      options({ type: 'toggle' }, { type: 'effort', values: [] }),
    ).toBeNull()
    expect(options()).toBeNull()
    expect(vercelReasoning({})).toBeNull()
    expect(vercelReasoning({ reasoning_options: 'toggle' })).toBeNull()
  })

  it('clears the price of a row whose price varies by route (#346)', () => {
    // ai-gateway.vercel.sh/v1/models, 2026-10-22: the top-level price is
    // one route's (beam: the free `reflection` route; qwen-3-235b: vertex,
    // not the cheaper deepinfra), and the gateway picks the route.
    const [beam, qwen, plain] = parseVercelModels(
      {
        data: [
          {
            id: 'reflection/beam',
            type: 'language',
            pricing: {
              input: '0',
              output: '0',
              input_cache_read: '0',
              varies_by_provider: true,
            },
          },
          {
            id: 'alibaba/qwen-3-235b',
            type: 'language',
            pricing: {
              input: '0.00000022',
              output: '0.00000088',
              varies_by_provider: true,
            },
          },
          {
            id: 'alibaba/qwen-3-14b',
            type: 'language',
            pricing: { input: '0.00000012', output: '0.00000024' },
          },
        ],
      },
      SOURCE,
    )
    for (const row of [beam, qwen]) {
      expect(row?.pricing).toBeNull()
      expect(row?.absent).toEqual({ pricing: 'cleared' })
      expect(row?.factSources?.pricing).toBeUndefined()
    }
    expect(plain?.pricing).not.toBeNull()
    expect(plain?.absent).toBeUndefined()
  })
})
