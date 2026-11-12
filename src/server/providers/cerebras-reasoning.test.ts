import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  cerebrasRequestMap,
  cerebrasThinking,
  parseCerebrasChatSpec,
  parseCerebrasReasoning,
} from './cerebras-reasoning.ts'

/** https://inference-docs.cerebras.ai/capabilities/reasoning.md on 2026-11-13. */
const REASONING = readFileSync(
  new URL('./fixtures/cerebras-reasoning.md.txt', import.meta.url),
  'utf8',
)

/** One model whose section never says whether reasoning can be turned off. */
const UNSTATED = `
| Model | Default effort | Availability |
| - | - | - |
| [GPT OSS 120B](#gpt-oss-120b) | \`medium\` | Shared |

## Model behavior

### GPT OSS 120B

[\`gpt-oss-120b\`](/models/openai-oss) supports reasoning.

| Value | Behavior |
| - | - |
| \`low\` | Selects low reasoning effort |
| \`medium\` (default) | Selects medium reasoning effort |
| \`high\` | Selects high reasoning effort |
`

/** The chat-spec sentences the request map is allowed to trust. */
const SPEC = `
        max_completion_tokens:
          type: integer
          nullable: true
          description: >
            The maximum number of tokens that can be generated in the
            completion, including reasoning tokens.
        max_tokens:
          type: integer
          nullable: true
          description: >
            An alias for \`max_completion_tokens\`. Do not send both parameters
            in the same request.
      description: >
        A message in the conversation. Developer messages are supported only by \`gpt-oss-120b\`.
`

describe('cerebras reasoning page', () => {
  const parsed = parseCerebrasReasoning(REASONING)

  it('reads each model section for efforts and whether reasoning can be disabled', () => {
    expect(parsed.configured.get('qwen-3.8-27b')).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['none', 'low', 'medium', 'high'],
    })
    expect(parsed.configured.get('kimi-k3')).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['low', 'high', 'max'],
    })
    expect(parsed.configured.get('kimi-k3.1-pro')).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['low', 'medium', 'high', 'max'],
    })
    expect(parsed.configured.get('zai-glm-5.3-flash')).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['low', 'high', 'max'],
    })
    expect(parsed.configured.get('gpt-oss-120b')).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['low', 'medium', 'high'],
    })
    expect(parsed.configured.get('gemma-4-31b')).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['none', 'low', 'medium', 'high'],
    })
    expect(parsed.ignored).toEqual(['kimi-k2.7-code'])
    expect([...parsed.configured.keys()]).toEqual([
      'qwen-3.8-27b',
      'kimi-k3',
      'kimi-k3.1-pro',
      'zai-glm-5.3-flash',
      'gpt-oss-120b',
      'gemma-4-31b',
    ])
  })

  it('throws when a behavior cell is not accept, disable, or unsupported', () => {
    expect(() =>
      parseCerebrasReasoning(
        REASONING.replace(
          '| `medium` (default) | Selects medium reasoning effort |',
          '| `medium` (default) | Sometimes |',
        ),
      ),
    ).toThrow(/gpt-oss-120b unread behavior/)
  })

  it('throws when the section never says whether reasoning can be disabled', () => {
    expect(() => parseCerebrasReasoning(UNSTATED)).toThrow(
      /does not state whether reasoning can be disabled/,
    )
  })

  it('throws when the page has no model behavior section', () => {
    expect(() =>
      parseCerebrasReasoning(
        REASONING.replace('## Model behavior', '## Notes'),
      ),
    ).toThrow(/no model behavior section/)
  })
})

describe('cerebras chat spec', () => {
  const spec = parseCerebrasChatSpec(SPEC)

  it('keeps max_completion_tokens and the developer-role ids', () => {
    expect(spec).toEqual({
      maxTokensField: 'max_completion_tokens',
      developerIds: ['gpt-oss-120b'],
    })
  })

  it('throws when max_tokens stops being the alias', () => {
    expect(() =>
      parseCerebrasChatSpec(SPEC.replace('An alias for', 'Previously')),
    ).toThrow(/not an alias/)
  })

  it('maps qwen off to none and leaves gpt-oss with no off body', () => {
    const reasoning = parseCerebrasReasoning(REASONING)
    expect(cerebrasThinking(['none', 'low', 'medium', 'high'])).toEqual({
      on: { reasoning_effort: 'high' },
      off: { reasoning_effort: 'none' },
      levels: {
        off: 'none',
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: null,
        max: null,
      },
    })
    const qwen = cerebrasRequestMap(
      'qwen-3.8-27b',
      spec,
      reasoning.configured.get('qwen-3.8-27b'),
      false,
    )
    const oss = cerebrasRequestMap(
      'gpt-oss-120b',
      spec,
      reasoning.configured.get('gpt-oss-120b'),
      false,
    )
    expect(qwen.developerRole).toBe(false)
    expect(qwen.thinking?.off).toEqual({ reasoning_effort: 'none' })
    expect(qwen.reasoningEffort).toBe(true)
    expect(oss.developerRole).toBe(true)
    expect(oss.thinking?.off).toBeNull()
    expect(oss.maxTokensField).toBe('max_completion_tokens')
    expect(oss.replayReasoningContent).toBeNull()
    expect(oss.toolStream).toBeNull()
  })
})
