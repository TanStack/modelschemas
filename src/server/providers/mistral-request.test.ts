import { describe, expect, it } from 'vitest'

import {
  mistralRequestMap,
  mistralThinking,
  parseMistralChatWire,
} from './mistral-request.ts'

const SPEC = `
components:
  schemas:
    ChatCompletionRequest:
      additionalProperties: false
      properties:
        max_tokens:
          description: The token count of your prompt plus max_tokens cannot exceed the model's context length.
        reasoning_effort:
          anyOf:
            - $ref: '#/components/schemas/ReasoningEffort'
            - type: 'null'
        messages:
          items:
            oneOf:
              - $ref: '#/components/schemas/SystemMessage'
              - $ref: '#/components/schemas/UserMessage'
              - $ref: '#/components/schemas/AssistantMessage'
              - $ref: '#/components/schemas/ToolMessage'
            discriminator:
              propertyName: role
              mapping:
                assistant: '#/components/schemas/AssistantMessage'
                system: '#/components/schemas/SystemMessage'
                tool: '#/components/schemas/ToolMessage'
                user: '#/components/schemas/UserMessage'
        tools:
          items:
            discriminator:
              propertyName: type
              mapping:
                function: '#/components/schemas/Tool'
                web_search: '#/components/schemas/WebSearchTool'
    ReasoningEffort:
      enum: [none, minimal, low, medium, high, xhigh]
`

describe('parseMistralChatWire', () => {
  it('reads a closed assistant schema with no reasoning_content as false', () => {
    const closed = `${SPEC}
    AssistantMessage:
      additionalProperties: false
      properties:
        role:
          const: assistant
        content:
          type: string
`
    expect(parseMistralChatWire(closed).replayReasoningContent).toBe(false)
    const open = closed.replace(
      'AssistantMessage:\n      additionalProperties: false',
      'AssistantMessage:\n      additionalProperties: true',
    )
    expect(parseMistralChatWire(open).replayReasoningContent).toBeNull()
    const present = closed.replace(
      'content:\n          type: string',
      'content:\n          type: string\n        reasoning_content:\n          type: string',
    )
    expect(parseMistralChatWire(present).replayReasoningContent).toBeNull()
  })

  it('reads max_tokens, no developer role, and reasoning_effort', () => {
    expect(parseMistralChatWire(SPEC)).toEqual({
      maxTokensField: 'max_tokens',
      developerRole: false,
      reasoningEffort: true,
      replayReasoningContent: null,
    })
    expect(() => parseMistralChatWire('components: {}')).toThrow(
      /ChatCompletionRequest missing/,
    )
  })

  it('builds thinking from the model reasoning object, not the shared enum', () => {
    const wire = parseMistralChatWire(SPEC)
    expect(
      mistralRequestMap(wire, { mode: 'effort', mandatory: false }),
    ).toMatchObject({
      maxTokensField: 'max_tokens',
      developerRole: false,
      reasoningEffort: true,
      thinking: {
        on: { reasoning_effort: 'high' },
        off: { reasoning_effort: 'none' },
        levels: null,
      },
      replayReasoningContent: null,
      store: null,
    })
    expect(
      mistralThinking({
        mode: 'effort',
        mandatory: true,
        efforts: ['low', 'high', 'max'],
      }),
    ).toEqual({
      on: { reasoning_effort: 'high' },
      off: null,
      levels: {
        off: null,
        minimal: null,
        low: 'low',
        medium: null,
        high: 'high',
        xhigh: null,
        max: 'max',
      },
    })
    expect(mistralThinking(null)).toBeNull()
    expect(mistralThinking({ mode: 'effort', mandatory: true })).toMatchObject({
      off: null,
      levels: null,
    })
  })
})
