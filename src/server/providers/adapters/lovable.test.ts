import { describe, expect, it } from 'vitest'

import { parseLovableModels, provider } from './lovable.ts'

const row = (over: Record<string, unknown>) => ({
  id: 'openai/gpt-5.5',
  name: 'GPT-5.5',
  created: 1_776_000_000,
  released: 1_775_000_000,
  deprecated: false,
  context_window: 1_000_000,
  max_tokens: 128_000,
  knowledge: '2026-06',
  modalities: { input: ['text', 'image'], output: ['text'] },
  supported_surfaces: ['chat-completions', 'responses'],
  pricing: { cost_currency: 'credits' },
  ...over,
})

describe('lovable listing', () => {
  it('reads the facts the listing states and binds the first routed surface', () => {
    const [model] = parseLovableModels({ data: [row({})] })
    expect(model).toMatchObject({
      rawId: 'openai/gpt-5.5',
      activity: 'chat',
      schemaEndpointId: 'chat/completions',
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      knowledgeCutoff: '2026-06',
      releasedAt: 1_775_000_000,
      deprecated: false,
    })
    expect(model?.pricing).toBeUndefined()
  })

  it('leaves a messages-only or live-only model unbound', () => {
    const models = parseLovableModels({
      data: [
        row({
          id: 'anthropic/claude-opus-5',
          supported_surfaces: ['messages'],
        }),
        row({ id: 'openai/gpt-live-1', supported_surfaces: ['live'] }),
        row({ id: 'google/veo-3.1', supported_surfaces: ['videos'] }),
      ],
    })
    expect(models.map((m) => [m.activity, m.schemaEndpointId])).toEqual([
      ['chat', null],
      ['audio', null],
      ['video', 'videos'],
    ])
  })

  it('refuses an unreadable payload or an unknown surface', () => {
    expect(() => parseLovableModels({})).toThrow('no data array')
    expect(() => parseLovableModels({ data: [{ name: 'x' }] })).toThrow('no id')
    expect(() =>
      parseLovableModels({ data: [row({ supported_surfaces: ['realtime'] })] }),
    ).toThrow('unknown surface realtime')
    const [decision] = parseLovableModels({
      data: [
        row({ id: 'typesafe/jev-1.13', supported_surfaces: ['systemone'] }),
      ],
    })
    expect(decision).toMatchObject({ activity: null, schemaEndpointId: null })
    const [unreleased] = parseLovableModels({ data: [row({ released: null })] })
    expect(unreleased?.releasedAt).toBeNull()
  })

  it('states the maker from the id', () => {
    expect(provider.upstreamModelIdentity?.('openai/gpt-5.5')).toMatchObject({
      providerNamespace: 'openai',
      rawId: 'gpt-5.5',
    })
    expect(provider.classify('/images/edits', {})).toBe('image')
  })
})
