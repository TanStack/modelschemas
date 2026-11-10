/**
 * Chat request map from Mistral's OpenAPI `ChatCompletionRequest`.
 * One body for every chat model. Thinking on/off is filled only for a model
 * whose own reasoning object names an effort control.
 */
import { parse } from 'yaml'

import { cachedDocs } from './model-facts.ts'
import { SHARED_EFFORT_LEVELS } from './request-map.ts'
import type {
  ChatRequestMap,
  EffortLevelMap,
  ThinkingRequest,
} from './request-map.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelReasoning } from './types.ts'

export const MISTRAL_OPENAPI_URL = 'https://docs.mistral.ai/openapi.yaml'

export interface MistralChatWire {
  maxTokensField: 'max_completion_tokens' | 'max_tokens' | null
  developerRole: boolean | null
  reasoningEffort: boolean | null
  /**
   * False when the assistant message schema omits `reasoning_content` and
   * sets `additionalProperties: false`. Null when that schema is absent or
   * open.
   */
  replayReasoningContent: boolean | null
  hash: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function roleNames(messages: unknown): Array<string> {
  const names: Array<string> = []
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (!isRecord(node)) return
    const discriminator = node.discriminator
    if (isRecord(discriminator) && discriminator.propertyName === 'role') {
      const mapping = discriminator.mapping
      if (isRecord(mapping)) names.push(...Object.keys(mapping))
    }
    for (const value of Object.values(node)) visit(value)
  }
  visit(messages)
  return names
}

/** Fields the shared chat body publishes. Throws when that schema is absent. */
export function parseMistralChatWire(
  text: string,
): Omit<MistralChatWire, 'hash'> {
  const spec = parse(text) as unknown
  const schemas =
    isRecord(spec) && isRecord(spec.components)
      ? spec.components.schemas
      : undefined
  const chat =
    isRecord(schemas) && isRecord(schemas.ChatCompletionRequest)
      ? schemas.ChatCompletionRequest
      : null
  const properties = chat && isRecord(chat.properties) ? chat.properties : null
  if (!properties) {
    throw new Error('mistral openapi: ChatCompletionRequest missing')
  }
  const has = (name: string) =>
    Object.prototype.hasOwnProperty.call(properties, name)
  let maxTokensField: MistralChatWire['maxTokensField'] = null
  if (has('max_tokens') && !has('max_completion_tokens')) {
    maxTokensField = 'max_tokens'
  } else if (has('max_completion_tokens') && !has('max_tokens')) {
    maxTokensField = 'max_completion_tokens'
  }
  const roles = roleNames(properties.messages)
  const developerRole = roles.length === 0 ? null : roles.includes('developer')
  const reasoningEffort = has('reasoning_effort')
    ? true
    : chat?.additionalProperties === false
      ? false
      : null
  const assistant = isRecord(schemas) ? schemas.AssistantMessage : undefined
  const assistantProperties =
    isRecord(assistant) && isRecord(assistant.properties)
      ? assistant.properties
      : null
  const closedAssistant =
    isRecord(assistant) && assistant.additionalProperties === false
  const replayReasoningContent =
    assistantProperties && closedAssistant
      ? 'reasoning_content' in assistantProperties
        ? null
        : false
      : null
  return {
    maxTokensField,
    developerRole,
    reasoningEffort,
    replayReasoningContent,
  }
}

export async function mistralChatWire(
  kv?: KVNamespace,
): Promise<MistralChatWire> {
  return cachedDocs(kv, MISTRAL_OPENAPI_URL, async () => {
    const text = await fetchText(MISTRAL_OPENAPI_URL)
    return { ...parseMistralChatWire(text), hash: await sha256Text(text) }
  })
}

function effortLevels(efforts: Array<string>): EffortLevelMap {
  const levels = Object.fromEntries(
    SHARED_EFFORT_LEVELS.map((level) => [level, null]),
  ) as EffortLevelMap
  for (const effort of efforts) {
    if (effort === 'none') levels.off = 'none'
    else if ((SHARED_EFFORT_LEVELS as ReadonlyArray<string>).includes(effort)) {
      levels[effort as keyof EffortLevelMap] = effort
    }
  }
  return levels
}

/**
 * `on` uses `high` when this model allows it. `off` is `none` when the
 * model's own list includes it, or when the guide says `none` omits the
 * chunk and publishes no list. Levels come only from that list.
 */
export function mistralThinking(
  reasoning: ModelReasoning | null | undefined,
): ThinkingRequest | null {
  if (!reasoning || reasoning.mode !== 'effort') return null
  const efforts = reasoning.efforts
  const allowsHigh = !efforts || efforts.includes('high')
  if (!allowsHigh) return null
  const off = efforts
    ? efforts.includes('none')
      ? { reasoning_effort: 'none' }
      : null
    : reasoning.mandatory === false
      ? { reasoning_effort: 'none' }
      : null
  return {
    on: { reasoning_effort: 'high' },
    off,
    levels: efforts ? effortLevels(efforts) : null,
  }
}

export function mistralRequestMap(
  wire: Omit<MistralChatWire, 'hash'>,
  reasoning: ModelReasoning | null | undefined,
): ChatRequestMap {
  return {
    thinking: mistralThinking(reasoning),
    maxTokensField: wire.maxTokensField,
    developerRole: wire.developerRole,
    replayReasoningContent: wire.replayReasoningContent,
    store: null,
    strictTools: null,
    sessionAffinity: null,
    cacheControl: null,
    toolStream: null,
    reasoningEffort: wire.reasoningEffort,
  }
}
