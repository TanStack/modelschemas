import { afterEach, describe, expect, it } from 'vitest'

import { bedrockCardRuntimeIds } from './bedrock-cards.ts'
import native from './fixtures/bedrock-native-thinking-guides.json'
import {
  applyBedrockThinkingGuides,
  BEDROCK_ADAPTIVE_THINKING_URL,
  BEDROCK_EXTENDED_THINKING_URL,
  BEDROCK_NOVA_THINKING_URL,
  loadBedrockThinkingGuides,
  parseBedrockAdaptiveThinking,
  parseBedrockExtendedThinking,
  parseBedrockNovaThinking,
} from './bedrock-thinking-guides.ts'
import { docsReport, docsRun } from './model-facts.ts'
import type { ModelInfo, ModelReasoning } from './types.ts'

const extended = native[BEDROCK_EXTENDED_THINKING_URL as keyof typeof native]
const adaptive = native[BEDROCK_ADAPTIVE_THINKING_URL as keyof typeof native]
const row = (rawId: string): ModelInfo => ({
  rawId,
  activity: 'chat',
  reasoning: null,
})
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('AWS native thinking guides', () => {
  it('parses the exact hosted Nova name and normative effort/disabled declarations without using examples', () => {
    const nova = native[BEDROCK_NOVA_THINKING_URL as keyof typeof native]
    expect(parseBedrockNovaThinking(nova)).toEqual({
      modelName: 'Nova 2 Lite',
      reasoning: {
        mode: 'effort',
        mandatory: false,
        efforts: ['low', 'medium', 'high'],
      },
    })
    expect(
      parseBedrockNovaThinking(
        nova +
          '\n```\nFuture Nova supports extended thinking for complex problem-solving. Enable reasoning with `reasoningConfig`.\n```',
      ),
    ).toEqual(parseBedrockNovaThinking(nova))
    expect(() =>
      parseBedrockNovaThinking(
        nova.replace('+ `type`: `enabled` or `disabled`', '+ `type`: unknown'),
      ),
    ).toThrow('type or effort')
  })
  it('joins Nova only by its exact native card title and retains only explicitly declared profile rows', async () => {
    globalThis.fetch = ((input: string) =>
      Promise.resolve(
        new Response(native[String(input) as keyof typeof native]),
      )) as typeof fetch
    const run = docsRun()
    const id = 'amazon.nova-2-lite-v1:0'
    const models = await loadBedrockThinkingGuides(
      [
        row(id),
        row(`eu.${id}`),
        row(`us.${id}`),
        row('amazon.nova-2-sonic-v1:0'),
      ],
      [
        {
          modelName: 'Nova 2 Lite',
          baseIds: [id],
          rowIds: [id, `eu.${id}`],
          runtimeRowIds: [id, `eu.${id}`],
        },
      ],
      run,
    )
    expect(models[0]?.reasoning).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['low', 'medium', 'high'],
    })
    expect(models[0]?.capabilities).toEqual(['reasoning'])
    expect(models[0]?.factSources?.capabilities?.reasoning?.sourceUrl).toBe(
      BEDROCK_NOVA_THINKING_URL,
    )
    expect(models[1]?.reasoning).toEqual(models[0]?.reasoning)
    expect(models[2]?.reasoning).toBeNull()
    expect(models[3]?.reasoning).toBeNull()
    expect(models[0]?.factSources?.reasoning?.sourceUrl).toBe(
      BEDROCK_NOVA_THINKING_URL,
    )
    expect(docsReport(run).failed).toBe(0)
  })
  it('derives Haiku runtime ownership from its actual native table and rejects malformed protocol bindings', () => {
    const card =
      native[
        'https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.md'
      ]
    const ids = bedrockCardRuntimeIds(card)
    expect(ids).toHaveLength(6)
    expect(ids).toContain('eu.anthropic.claude-haiku-4-5-20251001-v1:0')
    expect(ids).not.toContain('anthropic.claude-haiku-4-5')
    expect(() =>
      bedrockCardRuntimeIds(
        card.replace(
          '| bedrock-runtime | N/A | N/A |',
          '| bedrock-runtime | N/A |',
        ),
      ),
    ).toThrow('runtime access table')
  })
  it('binds a guide model title only to explicitly declared runtime profiles, never mantle-only base IDs', async () => {
    globalThis.fetch = ((input: string) =>
      Promise.resolve(
        new Response(native[String(input) as keyof typeof native]),
      )) as typeof fetch
    const base = 'anthropic.claude-haiku-4-5'
    const profile = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0'
    const group = {
      modelName: 'Claude Haiku 4.5',
      baseIds: [base],
      rowIds: [base, profile],
      runtimeRowIds: [profile],
    }
    const run = docsRun()
    const result = await loadBedrockThinkingGuides(
      [
        row(base),
        row(profile),
        row('us.anthropic.claude-haiku-4-5-20251001-v1:0'),
      ],
      [group],
      run,
    )
    expect(result[0]?.reasoning).toBeNull()
    expect(result[1]?.reasoning).toEqual({ mode: 'budget', mandatory: null })
    expect(result[1]?.factSources?.reasoning?.sourceUrl).toBe(
      BEDROCK_EXTENDED_THINKING_URL,
    )
    expect(result[2]?.reasoning).toBeNull()
    expect(docsReport(run).failed).toBe(0)
  })
  it('rejects an incomplete cached runtime binding and ambiguous duplicate card titles', () => {
    const id = 'amazon.nova-2-lite-v1:0'
    const guide = {
      controls: {},
      namedControls: {
        'Nova 2 Lite': parseBedrockNovaThinking(
          native[BEDROCK_NOVA_THINKING_URL as keyof typeof native],
        ).reasoning,
      },
      url: BEDROCK_NOVA_THINKING_URL,
      hash: 'nova',
    }
    const group = { modelName: 'Nova 2 Lite', baseIds: [id], rowIds: [id] }
    expect(() =>
      applyBedrockThinkingGuides([row(id)], [group], [guide]),
    ).toThrow('runtime card binding')
    const valid = { ...group, runtimeRowIds: [id] }
    expect(() =>
      applyBedrockThinkingGuides([row(id)], [valid, valid], [guide]),
    ).toThrow('ambiguous native card title')
  })
  it('derives eight exact extended model IDs and budget from normative own text', () => {
    const controls = parseBedrockExtendedThinking(extended)
    expect(Object.keys(controls)).toHaveLength(8)
    expect(controls['anthropic.claude-opus-4-5-20251101-v1:0']).toEqual({
      mode: 'budget',
      mandatory: null,
    })
    expect(
      controls['us.anthropic.claude-opus-4-5-20251101-v1:0'],
    ).toBeUndefined()
    expect(controls['anthropic.claude-fable-5']).toBeUndefined()
  })
  it('reads all thirteen linked adaptive rows and scopes max/xhigh to their Supported-on lists', () => {
    const controls = parseBedrockAdaptiveThinking(adaptive)
    expect(Object.keys(controls)).toHaveLength(13)
    expect(controls['anthropic.claude-opus-5']).toEqual({
      mode: 'adaptive',
      mandatory: false,
      efforts: ['max', 'xhigh', 'high', 'medium', 'low'],
    })
    expect(controls['anthropic.claude-sonnet-4-6']).toEqual({
      mode: 'adaptive',
      mandatory: false,
      efforts: ['max', 'high', 'medium', 'low'],
    })
    expect(controls['anthropic.claude-opus-4-6-v1']?.efforts).not.toContain(
      'xhigh',
    )
  })
  it('reads mandatory from the thinking configuration table only', () => {
    const controls = parseBedrockAdaptiveThinking(adaptive)
    // "disabled" and "between_tools" both 400.
    expect(controls['anthropic.claude-opus-5-5']?.mandatory).toBe(true)
    expect(controls['anthropic.claude-fable-5']?.mandatory).toBe(true)
    // "Thinking off", with or without an effort limit.
    expect(controls['anthropic.claude-haiku-5-5']?.mandatory).toBe(false)
    expect(controls['anthropic.claude-opus-4-7']?.mandatory).toBe(false)
    // between_tools drops only up-front thinking: stated neither way.
    expect(controls['anthropic.claude-sonnet-5-5']?.mandatory).toBeNull()
    const prose =
      adaptive + '\nClaude Opus 5.5 supports adaptive and disabled thinking.\n'
    expect(parseBedrockAdaptiveThinking(prose)).toEqual(controls)
    const fenced =
      adaptive +
      '\n```\n| Claude Opus 5.5 | Adaptive | Adaptive | 400 error | 400 error | Thinking off |\n```\n'
    expect(parseBedrockAdaptiveThinking(fenced)).toEqual(controls)
  })
  it('rejects missing tables, malformed native rows and unreadable restricted model scopes', () => {
    const maxRow = /^\| max \| .*$/m
    expect(() =>
      parseBedrockAdaptiveThinking(
        adaptive.replace('| Model | Model ID |', '| Changed | Model ID |'),
      ),
    ).toThrow('model table')
    expect(() =>
      parseBedrockAdaptiveThinking(
        adaptive.replace('`anthropic.claude-opus-5-5`', '`unknown`'),
      ),
    ).toThrow('model row')
    expect(() =>
      parseBedrockAdaptiveThinking(
        adaptive.replace(
          '(model-card-anthropic-claude-haiku-5-5.md)',
          '(model-card-anthropic-claude-haiku-5-5.md "card")',
        ),
      ),
    ).toThrow('unsupported named scope')
    expect(() =>
      parseBedrockAdaptiveThinking(
        adaptive.replace(
          maxRow,
          '| max | Deepest. Supported on Claude Opus 5 and Claude Future 9. |',
        ),
      ),
    ).toThrow('unsupported named scope')
    expect(() =>
      parseBedrockAdaptiveThinking(
        adaptive.replace(
          maxRow,
          '| max | Deepest. Supported on selected future models. |',
        ),
      ),
    ).toThrow('model scope')
    expect(() =>
      parseBedrockAdaptiveThinking(
        adaptive.replace('| low |', '| low |\n| low |'),
      ),
    ).toThrow('effort row')
    expect(() =>
      parseBedrockExtendedThinking(
        extended.replace(
          'The `budget_tokens` parameter determines',
          'The undocumented parameter determines',
        ),
      ),
    ).toThrow('budget declaration')
  })
  it('rejects a missing or unreadable thinking configuration table', () => {
    expect(() =>
      parseBedrockAdaptiveThinking(
        adaptive.replace('## Thinking configuration by model', '## Renamed'),
      ),
    ).toThrow('missing thinking configuration table')
    expect(() =>
      parseBedrockAdaptiveThinking(
        adaptive.replace(
          /^(\| Claude Sonnet 5 \|.*\| )Thinking off( \|\s*)$/m,
          '$1Thinking reduced$2',
        ),
      ),
    ).toThrow('unreadable thinking configuration row')
    expect(() =>
      parseBedrockAdaptiveThinking(
        adaptive.replace('| Claude Sonnet 5 |', '| Claude Sonnet 9 |'),
      ),
    ).toThrow('unsupported named scope')
    expect(() =>
      parseBedrockAdaptiveThinking(
        adaptive.replace('| Claude Sonnet 5 |', '| Claude Opus 5 |'),
      ),
    ).toThrow('duplicate thinking configuration')
  })
  it('rejects an embedded or negated mode declaration', () => {
    expect(() =>
      parseBedrockExtendedThinking(
        extended.replace(
          'To turn on extended thinking, add',
          'Do not assume To turn on extended thinking, add',
        ),
      ),
    ).toThrow('budget declaration')
    expect(() =>
      parseBedrockAdaptiveThinking(
        adaptive.replace(
          'Set `thinking.type` to',
          'Do not assume Set `thinking.type` to',
        ),
      ),
    ).toThrow('mode or effort table')
  })
  it('joins only the card-owned IDs, preserving existing controls and the source for every filled object', () => {
    const base = 'anthropic.claude-opus-5'
    const catalog = [
      row(base),
      row(`eu.${base}`),
      row(`us.${base}`),
      row(`${base}-future`),
    ]
    const models = applyBedrockThinkingGuides(
      catalog,
      [{ modelName: null, baseIds: [base], rowIds: [base, `eu.${base}`] }],
      [
        {
          controls: parseBedrockAdaptiveThinking(adaptive),
          url: BEDROCK_ADAPTIVE_THINKING_URL,
          hash: 'own-guide-hash',
        },
      ],
    )
    expect(models[0]?.reasoning?.mode).toBe('adaptive')
    expect(models[1]?.reasoning).toEqual(models[0]?.reasoning)
    expect(models[2]?.reasoning).toBeNull()
    expect(models[3]?.reasoning).toBeNull()
    expect(models[0]?.factSources?.reasoning?.sourceUrl).toBe(
      BEDROCK_ADAPTIVE_THINKING_URL,
    )
    expect(models[1]?.factSources?.reasoning?.sourceHash).toBe('own-guide-hash')
    expect(catalog[0]?.reasoning).toBeNull()
  })
  it('fills missing card effort values only when the own guide supports retained values completely', () => {
    const own = {
      ...row('anthropic.claude-sonnet-5'),
      reasoning: { mode: 'adaptive', mandatory: false } as const,
      factSources: {
        reasoning: {
          derivation: 'docs-derived',
          sourceUrl: 'https://docs.aws.amazon.com/card.md',
        } as const,
      },
    }
    const incompatible = {
      ...row('anthropic.claude-opus-4-6-v1'),
      reasoning: { mode: 'budget', mandatory: null } as const,
    }
    const full = {
      ...row('anthropic.claude-sonnet-5-5'),
      reasoning: {
        mode: 'adaptive',
        mandatory: null,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      } as ModelReasoning,
    }
    const guide = {
      controls: parseBedrockAdaptiveThinking(adaptive),
      url: BEDROCK_ADAPTIVE_THINKING_URL,
      hash: 'guide',
    }
    const result = applyBedrockThinkingGuides(
      [own, incompatible, full],
      [own, incompatible, full].map((model) => ({
        modelName: null,
        baseIds: [model.rawId],
        rowIds: [model.rawId],
      })),
      [guide],
    )
    expect(result[0]?.reasoning?.efforts).toEqual([
      'max',
      'xhigh',
      'high',
      'medium',
      'low',
    ])
    expect(result[0]?.factSources?.reasoning?.sourceUrl).toBe(
      BEDROCK_ADAPTIVE_THINKING_URL,
    )
    expect(result[1]).toBe(incompatible)
    expect(result[2]).toBe(full)
  })
  it('preserves capability maps and their sources, and exposes explicit native contradictions', async () => {
    const id = 'anthropic.claude-opus-5'
    const guide = {
      controls: parseBedrockAdaptiveThinking(adaptive),
      url: BEDROCK_ADAPTIVE_THINKING_URL,
      hash: 'adaptive',
    }
    const previous = {
      derivation: 'docs-derived' as const,
      sourceUrl: 'https://docs.aws.amazon.com/card.md',
    }
    const model = {
      ...row(id),
      capabilities: { tools: false },
      factSources: { capabilities: { tools: previous } },
    }
    const result = applyBedrockThinkingGuides(
      [model],
      [{ modelName: null, baseIds: [id], rowIds: [id] }],
      [guide],
    )
    expect(result[0]?.capabilities).toEqual({ tools: false, reasoning: true })
    expect(result[0]?.factSources?.capabilities?.tools).toEqual(previous)
    globalThis.fetch = ((input: string) =>
      Promise.resolve(
        new Response(native[String(input) as keyof typeof native]),
      )) as typeof fetch
    const run = docsRun()
    const negative = {
      ...model,
      capabilities: { reasoning: false, tools: false },
    }
    const guarded = await loadBedrockThinkingGuides(
      [negative],
      [{ modelName: null, baseIds: [id], rowIds: [id] }],
      run,
    )
    expect(guarded[0]?.capabilities).toEqual({ reasoning: false, tools: false })
    expect(guarded[0]?.reasoning).toBeNull()
    expect(guarded[0]?.absent?.reasoning).toBe('unavailable')
    expect(docsReport(run).failed).toBe(1)
    expect(docsReport(run).first[0]?.source).toBe(BEDROCK_ADAPTIVE_THINKING_URL)
    expect(docsReport(run).first[0]?.error).toContain(
      'contradicts explicit negative',
    )
    const fable = {
      ...row('anthropic.claude-fable-5'),
      reasoning: { mode: 'adaptive', mandatory: false } as const,
    }
    expect(() =>
      applyBedrockThinkingGuides(
        [fable],
        [{ modelName: null, baseIds: [fable.rawId], rowIds: [fable.rawId] }],
        [guide],
      ),
    ).toThrow('contradicts card mandatory')
  })
  it('retains card enum order while filling a natively supported mandatory leaf', () => {
    const id = 'anthropic.claude-opus-4-7'
    const model = {
      ...row(id),
      reasoning: {
        mode: 'adaptive',
        mandatory: null,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      } as ModelReasoning,
    }
    const result = applyBedrockThinkingGuides(
      [model],
      [{ modelName: null, baseIds: [id], rowIds: [id] }],
      [
        {
          controls: parseBedrockAdaptiveThinking(adaptive),
          url: BEDROCK_ADAPTIVE_THINKING_URL,
          hash: 'adaptive',
        },
      ],
    )
    expect(result[0]?.reasoning).toEqual({
      mode: 'adaptive',
      mandatory: false,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
    expect(result[0]?.factSources?.reasoning?.sourceUrl).toBe(
      BEDROCK_ADAPTIVE_THINKING_URL,
    )
  })
  it('prefers native adaptive controls over deprecated budget when both guides list the exact ID', () => {
    const id = 'anthropic.claude-opus-4-6-v1'
    const result = applyBedrockThinkingGuides(
      [row(id)],
      [{ modelName: null, baseIds: [id], rowIds: [id] }],
      [
        {
          controls: parseBedrockExtendedThinking(extended),
          url: BEDROCK_EXTENDED_THINKING_URL,
          hash: 'extended',
        },
        {
          controls: parseBedrockAdaptiveThinking(adaptive),
          url: BEDROCK_ADAPTIVE_THINKING_URL,
          hash: 'adaptive',
        },
      ],
    )
    expect(result[0]?.reasoning?.mode).toBe('adaptive')
  })
  it('reports malformed guide sources visibly and protects unknown controls without masking valid native facts', async () => {
    globalThis.fetch = () =>
      Promise.resolve(new Response('Changed source markup'))
    const run = docsRun()
    const id = 'anthropic.claude-sonnet-4-6'
    const model = {
      ...row(id),
      maxOutput: 123,
      absent: { pricing: 'cleared' } as const,
    }
    const other = row('amazon.nova-2-sonic-v1:0')
    const result = await loadBedrockThinkingGuides(
      [model, other],
      [{ modelName: null, baseIds: [id], rowIds: [id] }],
      run,
    )
    expect(docsReport(run).failed).toBe(3)
    expect(docsReport(run).first.map((failure) => failure.source)).toEqual([
      BEDROCK_EXTENDED_THINKING_URL,
      BEDROCK_ADAPTIVE_THINKING_URL,
      BEDROCK_NOVA_THINKING_URL,
    ])
    expect(result[0]?.absent).toEqual({
      pricing: 'cleared',
      reasoning: 'unavailable',
    })
    expect(result[0]?.maxOutput).toBe(123)
    expect(result[1]).toBe(other)
  })
})
