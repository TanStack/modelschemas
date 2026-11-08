import { describe, expect, it } from 'vitest'

import { parseNeonModels, provider } from './neon.ts'

const source = {
  url: 'https://neon.com/models.json',
  hash: 'h',
  extractedAt: 't',
}

const chat = {
  id: 'claude-opus-5-5',
  name: 'Claude Opus 5.5',
  lab: 'anthropic',
  released: true,
  reasoning: true,
  reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
  tool_call: true,
  temperature: false,
  structured_output: true,
  open_weights: false,
  knowledge: '2026-01-31',
  release_date: '2026-09-01',
  modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
  limit: { context: 1_000_000, output: 128_000 },
  cost: { input: 4, output: 20, cache_read: 0.4, cache_write: 5 },
}

describe('neon catalog', () => {
  it('reads a chat row with a USD-per-million card', () => {
    const [model] = parseNeonModels({ neon: { models: { x: chat } } }, source)
    expect(model).toMatchObject({
      rawId: 'claude-opus-5-5',
      activity: 'chat',
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      capabilities: ['tools', 'structured_outputs'],
      unsupportedCapabilities: ['temperature'],
      reasoning: {
        mode: 'effort',
        mandatory: null,
        efforts: ['low', 'high', 'max'],
      },
      knowledgeCutoff: '2026-01-31',
      openWeights: false,
      releasedAt: Math.floor(Date.parse('2026-09-01') / 1000),
    })
    const card = model?.pricing as {
      tables: { rate: { base: Record<string, number> } }
    }
    expect(card.tables.rate.base).toMatchObject({
      input_tokens: 4 / 1e6,
      output_tokens: 20 / 1e6,
      cache_read_tokens: 0.4 / 1e6,
    })
  })

  it('maps embeddings, drops decisions and unreleased rows, and reads none as switchable', () => {
    const models = parseNeonModels(
      {
        neon: {
          models: {
            a: {
              id: 'bge-large-en',
              released: true,
              type: 'embedding',
              cost: { input: 0.1 },
            },
            b: {
              id: 'jev',
              released: true,
              type: 'decision',
              cost: { input: 0.04 },
            },
            c: { ...chat, id: 'soon', released: false },
            d: {
              ...chat,
              id: 'gpt-5-5',
              reasoning_options: [{ type: 'effort', values: ['none', 'low'] }],
            },
            e: {
              ...chat,
              id: 'budget',
              reasoning_options: [{ type: 'budget_tokens' }],
            },
          },
        },
      },
      source,
    )
    expect(models.map((m) => [m.rawId, m.activity])).toEqual([
      ['bge-large-en', 'embeddings'],
      ['gpt-5-5', 'chat'],
      ['budget', 'chat'],
    ])
    expect(models[1]?.reasoning).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['none', 'low'],
    })
    expect(models[2]?.reasoning).toEqual({ mode: 'budget', mandatory: null })
  })

  it('refuses a cost that is not a price', () => {
    expect(() =>
      parseNeonModels(
        { neon: { models: { a: { ...chat, cost: { input: 'free' } } } } },
        source,
      ),
    ).toThrow('cost.input')
  })

  it('binds /v1 routes on the branch host', () => {
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/embeddings', {})).toBe('embeddings')
    expect(
      provider.generationEndpointId?.({ rawId: 'x', activity: 'chat' }),
    ).toBe('v1/chat/completions')
  })
})
