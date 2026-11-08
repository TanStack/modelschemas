import { price } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'
import { describe, expect, it } from 'vitest'

import { parseLlmGatewayModels, provider } from './llmgateway.ts'

const SOURCE = { url: 'u', hash: 'h', extractedAt: 'x' }
const ZERO = { image: '0', request: '0', input_cache_write: '0' }

/** Excerpt of https://api.llmgateway.io/v1/models (2026-10-22). */
const FIXTURE = {
  data: [
    {
      id: 'auto',
      name: 'Auto Route',
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      providers: [{ providerId: 'llmgateway', externalId: 'auto' }],
      context_length: 0,
      supported_parameters: ['temperature'],
    },
    {
      id: 'gpt-oss-120b',
      name: 'GPT OSS 120B',
      created: 1754352000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      providers: [
        {
          providerId: 'groq',
          externalId: 'openai/gpt-oss-120b',
          pricing: { prompt: '0.15e-6', completion: '0.75e-6', ...ZERO },
          reasoning: true,
          reasoning_efforts: ['low', 'medium', 'high'],
          max_output: 32766,
        },
        {
          providerId: 'cerebras',
          externalId: 'gpt-oss-120b',
          pricing: { prompt: '0.35e-6', completion: '0.75e-6', ...ZERO },
          reasoning: true,
          max_output: 32768,
          tools: false,
        },
      ],
      // Undocumented cheapest-route price: never stored.
      pricing: { prompt: '0.032e-6', completion: '0.14e-6' },
      context_length: 131072,
      max_output: 32000,
      supported_parameters: ['max_tokens', 'tools', 'tool_choice', 'reasoning'],
    },
    {
      id: 'claude-sonnet-4-5',
      name: 'Claude Sonnet 4.5',
      architecture: {
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
      },
      providers: ['anthropic', 'aws-bedrock'].map((providerId) => ({
        providerId,
        externalId: 'claude-sonnet-4-5',
        pricing: {
          prompt: '3.0e-6',
          completion: '15.0e-6',
          input_cache_read: '0.3e-6',
          image: '0',
        },
        reasoning: true,
        reasoning_efforts: ['none', 'low', 'high'],
      })),
      context_length: 200000,
      supported_parameters: ['max_tokens'],
      aliases: ['claude-sonnet-4.5'],
    },
    {
      id: 'gpt-4o',
      name: 'GPT-4o',
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      providers: [
        {
          providerId: 'openai',
          externalId: 'gpt-4o',
          // A nonzero key whose unit is unstated: no card.
          pricing: { prompt: '2.5e-6', completion: '10e-6', image: '0.00553' },
        },
      ],
      context_length: 128000,
      supported_parameters: [],
      deactivated_at: '2020-01-01T00:00:00.000Z',
    },
  ],
}

const rows = parseLlmGatewayModels(FIXTURE, SOURCE, Date.UTC(2026, 9, 22))
const row = (rawId: string) => rows.find((r) => r.rawId === rawId)

describe('parseLlmGatewayModels', () => {
  it('lists bare ids plus one pinned row per upstream route', () => {
    expect(rows.map((r) => r.rawId)).toEqual([
      'auto',
      'gpt-oss-120b',
      'groq/gpt-oss-120b',
      'cerebras/gpt-oss-120b',
      'claude-sonnet-4-5',
      'anthropic/claude-sonnet-4-5',
      'aws-bedrock/claude-sonnet-4-5',
      'gpt-4o',
      'openai/gpt-4o',
    ])
    expect(row('auto')?.upstream).toBeNull()
  })

  it('leaves a routed bare id unpriced and unlinked when routes differ', () => {
    const bare = row('gpt-oss-120b')
    expect(bare?.pricing).toBeNull()
    expect(bare?.reasoning).toBeNull()
    expect(bare?.upstream).toBeNull()
    expect(bare?.contextWindow).toBe(131072)
    expect(bare?.maxOutput).toBe(32000)
  })

  it('gives a bare id whose routes differ a range over them, not a price (#406)', () => {
    const bare = row('gpt-oss-120b')
    expect(bare?.absent).toEqual({ pricing: 'cleared' })
    expect(bare?.pricingRange).toEqual({
      currency: 'USD',
      routes: [
        {
          model: 'groq/gpt-oss-120b',
          pricing: {
            currency: 'USD',
            per: 'token',
            inputPerMillion: 0.15,
            outputPerMillion: 0.75,
          },
        },
        {
          model: 'cerebras/gpt-oss-120b',
          pricing: {
            currency: 'USD',
            per: 'token',
            inputPerMillion: 0.35,
            outputPerMillion: 0.75,
          },
        },
      ],
      inputPerMillion: { min: 0.15, max: 0.35 },
      outputPerMillion: { min: 0.75, max: 0.75 },
    })
    expect(bare?.factSources?.pricingRange?.path).toBe(
      'data[].providers[].pricing',
    )
    // One price on every route, or a single route: no range.
    expect(row('claude-sonnet-4-5')?.pricingRange).toBeNull()
    expect(row('claude-sonnet-4-5')?.absent).toBeUndefined()
    expect(row('gpt-4o')?.pricingRange).toBeNull()
  })

  it('gives no range when a route has no readable card', () => {
    const [bare] = parseLlmGatewayModels(
      {
        data: [
          {
            id: 'm',
            architecture: { output_modalities: ['text'] },
            providers: [
              {
                providerId: 'a',
                externalId: 'm',
                pricing: { prompt: '1e-6', completion: '2e-6' },
              },
              {
                providerId: 'b',
                externalId: 'm',
                pricing: { prompt: '1e-6', image: '0.01' },
              },
            ],
          },
        ],
      },
      SOURCE,
    )
    expect(bare?.pricing).toBeNull()
    expect(bare?.pricingRange).toBeNull()
    // Unreadable is not "no single price": a plain omission.
    expect(bare?.absent).toBeUndefined()
  })

  it("gives a pinned row its route's price, limits and upstream", () => {
    const groq = row('groq/gpt-oss-120b')
    expect(
      price(
        groq?.pricing as RateCard,
        {},
        {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
        },
      ),
    ).toBeCloseTo(0.9)
    expect(groq?.maxOutput).toBe(32766)
    expect(groq?.contextWindow).toBeNull()
    expect(groq?.reasoning).toEqual({
      mode: 'effort',
      mandatory: null,
      efforts: ['low', 'medium', 'high'],
    })
    expect(groq?.upstream).toMatchObject({
      providerNamespace: 'groq',
      rawId: 'openai/gpt-oss-120b',
    })
    expect(row('cerebras/gpt-oss-120b')?.capabilities).toEqual([
      'max_tokens',
      'reasoning',
    ])
  })

  it('prices a bare id whose routes all quote the same price', () => {
    const bare = row('claude-sonnet-4-5')
    expect(
      price(
        bare?.pricing as RateCard,
        {},
        {
          input_tokens: 1_000_000,
          output_tokens: 0,
          cache_read_tokens: 1_000_000,
        },
      ),
    ).toBeCloseTo(3.3)
    expect(bare?.reasoning).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['none', 'low', 'high'],
    })
    expect(bare?.requestMap?.thinking?.off).toEqual({
      reasoning_effort: 'none',
    })
    expect(bare?.aliases).toEqual(['claude-sonnet-4.5'])
  })

  it('links a single-route bare id and refuses unreadable price keys', () => {
    const bare = row('gpt-4o')
    expect(bare?.upstream).toMatchObject({
      providerNamespace: 'openai',
      rawId: 'gpt-4o',
    })
    expect(bare?.pricing).toBeNull()
    expect(row('openai/gpt-4o')?.pricing).toBeNull()
    expect(bare?.deprecated).toBe(true)
  })
})

describe('route price shapes (2026-11-04 listing, #580)', () => {
  /** Excerpt of https://api.llmgateway.io/v1/models (2026-11-08). */
  const [qwen] = parseLlmGatewayModels(
    {
      data: [
        {
          id: 'qwen-plus',
          architecture: {
            input_modalities: ['text'],
            output_modalities: ['text'],
          },
          providers: [
            {
              providerId: 'alibaba',
              externalId: 'qwen-plus',
              pricing: {
                prompt: '0.4e-6',
                completion: '1.2e-6',
                image: '0',
                request: '0',
                input_cache_read: '0.08e-6',
                input_cache_read_explicit: '0.04e-6',
                input_cache_write: '0.5e-6',
                input_cache_write_1h: '0',
                web_search: '0.01',
                content_filter: '0.05',
                tiers: [
                  {
                    name: 'Up to 256K',
                    up_to_tokens: 256000,
                    prompt: '0.4e-6',
                    completion: '1.2e-6',
                  },
                  {
                    name: 'Over 256K',
                    up_to_tokens: null,
                    prompt: '1.2e-6',
                    completion: '3.6e-6',
                    input_cache_read_explicit: '0.12e-6',
                  },
                ],
              },
            },
          ],
          supported_parameters: [],
        },
      ],
    },
    SOURCE,
  )
  const card = qwen?.pricing as RateCard

  it('bills web search, content filter and explicit cache reads', () => {
    expect(
      price(
        card,
        {},
        {
          input_tokens: 0,
          output_tokens: 0,
          web_searches: 2,
          content_filtered_requests: 1,
          explicit_cache_read_tokens: 100_000,
        },
      ),
    ).toBeCloseTo(0.02 + 0.05 + 0.004)
  })

  it('picks the band whose up_to_tokens covers the prompt', () => {
    const at = (input_tokens: number, explicit = 0) =>
      price(
        card,
        {},
        {
          input_tokens,
          output_tokens: 1_000_000,
          explicit_cache_read_tokens: explicit,
        },
      )
    expect(at(256_000)).toBeCloseTo(0.1024 + 1.2)
    expect(at(256_001)).toBeCloseTo(256_001 * 1.2e-6 + 3.6)
    // Explicit cache reads count toward the prompt size, as in costs.ts.
    expect(at(1, 256_000)).toBeCloseTo(1.2e-6 + 3.6 + 256_000 * 0.12e-6)
  })

  it('refuses a band list it cannot read', () => {
    const [bad] = parseLlmGatewayModels(
      {
        data: [
          {
            id: 'x',
            architecture: {
              input_modalities: ['text'],
              output_modalities: ['text'],
            },
            providers: [
              {
                providerId: 'p',
                externalId: 'x',
                pricing: {
                  prompt: '1e-6',
                  completion: '1e-6',
                  tiers: [{ up_to_tokens: 1000, prompt: '1e-6' }],
                },
              },
            ],
          },
        ],
      },
      SOURCE,
    )
    expect(bad?.pricing).toBeNull()
  })
})

describe('provider', () => {
  it('classifies the gateway routes from openapi.json', () => {
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/audio/transcriptions', {})).toBe('audio')
    expect(provider.classify('/v1/messages', {})).toBeNull()
  })
})
