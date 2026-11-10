import { describe, expect, it } from 'vitest'

import { buildReport, parseLedger } from './completeness.ts'
import type { ModelRow } from './completeness.ts'

const chat: ModelRow = {
  provider: 'host',
  rawId: 'm',
  activity: 'chat',
  contextWindow: 8,
  maxOutput: 8,
  modalities: { input: ['text'] },
  pricing: {
    tables: {
      rate: {
        base: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 0.1 },
      },
    },
  },
  capabilities: { reasoning: true },
  reasoning: { mode: 'effort', mandatory: true, efforts: ['low'] },
  requestMap: { replayReasoningContent: false },
  schemaEndpointId: 'chat/completions',
}

describe('applicable facts', () => {
  it('scores replayReasoningContent only on chat/completions routes', () => {
    const report = buildReport([
      chat,
      {
        ...chat,
        rawId: 'messages',
        schemaEndpointId: 'v1/messages',
        requestMap: null,
      },
      {
        ...chat,
        rawId: 'converse',
        schemaEndpointId: 'model/x/converse',
        requestMap: null,
      },
      {
        ...chat,
        rawId: 'responses',
        schemaEndpointId: 'responses',
        requestMap: null,
      },
      {
        ...chat,
        rawId: 'gemini',
        schemaEndpointId: 'v1beta/models/{modelsId}:generateContent',
        requestMap: { maxTokensField: 'max_tokens' },
      },
    ])
    const host = report.providers[0]
    expect(host?.facts.replayReasoningContent).toEqual({ have: 1, need: 1 })
    expect(host?.facts.requestMap).toEqual({ have: 1, need: 2 })
  })

  it('does not score requestMap on a native route', () => {
    const report = buildReport([
      {
        ...chat,
        schemaEndpointId: 'v1/messages',
        requestMap: null,
        reasoning: null,
        capabilities: { tools: true },
      },
    ])
    expect(report.providers[0]?.facts.requestMap).toEqual({ have: 0, need: 0 })
    expect(report.providers[0]?.facts.replayReasoningContent).toEqual({
      have: 0,
      need: 0,
    })
  })

  it('counts a stated cache absence and not a made-up price', () => {
    const report = buildReport([
      {
        ...chat,
        pricing: {
          tables: { rate: { base: { input_tokens: 1, output_tokens: 2 } } },
        },
        factSources: { cacheRead: { path: 'not-offered' } },
      },
    ])
    expect(report.providers[0]?.facts.cacheRead).toEqual({ have: 1, need: 1 })
  })

  it('scores n/a when every row is a non-chat activity, and 0 when one is unclassified', () => {
    const speech = buildReport([
      { provider: 'speech', activity: 'audio' },
      { provider: 'speech', activity: 'audio' },
    ])
    expect(speech.providers[0]?.score).toBeNull()
    const missed = buildReport([
      { provider: 'images', activity: 'image' },
      { provider: 'images', activity: null },
    ])
    expect(missed.providers[0]?.score).toBe(0)
  })

  it('leaves a native replay row out of a model-scoped ledger denominator', () => {
    const report = buildReport(
      [{ ...chat, schemaEndpointId: 'v1/messages', requestMap: null }],
      parseLedger('- host/m: replayReasoningContent — native route'),
    )
    expect(report.providers[0]?.facts.replayReasoningContent.need).toBe(0)
    expect(
      report.providers[0]?.modelSilent?.replayReasoningContent,
    ).toBeUndefined()
  })
})
