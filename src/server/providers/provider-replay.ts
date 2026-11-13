/** Replay facts parsed from each host's own published documentation. */
import { cachedDocs } from './model-facts.ts'
import type { ChatRequestMap } from './request-map.ts'
import { fetchText, sha256Text, timeoutSignal } from './types.ts'
import type { FactSource, ModelInfo, ModelReasoning } from './types.ts'

export const DEEPSEEK_THINKING_URL =
  'https://api-docs.deepseek.com/guides/thinking_mode/'
export const ZAI_THINKING_MODE_URL =
  'https://docs.z.ai/guides/capabilities/thinking-mode.md'
export const ZHIPU_THINKING_MODE_URL =
  'https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode.md'
export const KIMI_THINKING_URL =
  'https://platform.kimi.ai/docs/guide/use-thinking-models.md'
export const KIMI_CN_THINKING_URL =
  'https://platform.kimi.com/docs/guide/use-thinking-models.md'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A native model-specific effort list is a control, not evidence it is mandatory. */
export function deepseekEffortFacts(
  effort: unknown,
): { reasoning: ModelReasoning; source: FactSource } | null {
  if (effort == null) return null
  if (!record(effort)) throw new Error('deepseek: unreadable effort metadata')
  const levels = effort.supported_levels
  if (levels === undefined) return null
  if (
    !Array.isArray(levels) ||
    levels.length === 0 ||
    !levels.every((level) => typeof level === 'string' && level.length > 0)
  )
    throw new Error('deepseek: unreadable supported_levels')
  const efforts = levels as Array<string>
  return {
    reasoning: {
      mode: 'effort',
      mandatory: null,
      efforts,
    },
    source: {
      derivation: 'listing',
      sourceUrl: 'https://api.deepseek.com/models',
      path: 'data[].effort.supported_levels',
    },
  }
}

export function replayRequestMap(
  existing?: ChatRequestMap | null,
): ChatRequestMap {
  const base: ChatRequestMap = {
    thinking: null,
    maxTokensField: null,
    developerRole: null,
    replayReasoningContent: true,
    store: null,
    strictTools: null,
    sessionAffinity: null,
    cacheControl: null,
    toolStream: null,
    reasoningEffort: null,
  }
  return { ...base, ...existing, replayReasoningContent: true }
}

function plain(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\_/g, '_')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
}

/** The native guide requires replay with tools; without tools it says it is ignored. */
export function parseDeepseekReplay(text: string): true {
  const prose = plain(text)
  if (
    !/request carries the tools parameter.{0,240}reasoning_content.{0,160}passed back/i.test(
      prose,
    ) ||
    !/does not carry the tools parameter.{0,200}reasoning_content.{0,240}ignored/i.test(
      prose,
    )
  )
    throw new Error(
      'deepseek: thinking guide has no verified tool replay contract',
    )
  return true
}

/**
 * Models the thinking guide gives a non-thinking mode of their own: the
 * `top_p` bullet that names the model says what happens "in non-thinking
 * mode". The toggle table is shared by every model, so it binds none.
 */
export function parseDeepseekNonThinking(text: string): Array<string> {
  const ids = [
    ...plain(text).matchAll(
      /\b(deepseek-[a-z0-9.-]*[a-z0-9])\s*:[^:]*?\bin non-thinking mode\b/gi,
    ),
  ].map((match) => (match[1] ?? '').toLowerCase())
  return [...new Set(ids)]
}

/** Only explicitly named models are bound; no inferred model-family membership. */
export function parseGlmReplay(text: string): Array<string> {
  const prose = plain(text)
  const instruction =
    /thinking blocks.{0,150}preserv.{0,150}return.{0,150}tool results/i.test(
      prose,
    ) || /必须显式保留.{0,80}Reasoning content.{0,80}返回工具结果/i.test(prose)
  if (!instruction || !prose.includes('reasoning_content'))
    throw new Error(
      'glm: thinking-mode guide has no verified replay instruction',
    )
  const section = text
    .split(/^## /m)
    .find((part) =>
      /^(?:\*\*)?Default Thinking Behaviour|^默认思考行为/.test(part),
    )
  const ids = [
    ...new Set(
      (section?.match(/\bGLM-\d+(?:\.\d+)?(?:-FLASH)?\b/g) ?? []).map((id) =>
        id.toLowerCase(),
      ),
    ),
  ]
  const interleaved = text
    .split(/^## /m)
    .find((part) => part.startsWith('**Interleaved thinking'))
  // The native guide names the first supported model explicitly. It does
  // not enumerate variants; only that exact id gets this tool-turn rule.
  const since = interleaved?.match(
    /supported since (GLM-\d+(?:\.\d+)?(?:-[A-Za-z0-9]+)*)(?![\w-]|\.\d)/,
  )?.[1]
  if (
    since &&
    /thinking blocks should be explicitly preserved/i.test(plain(interleaved))
  )
    ids.push(since.toLowerCase())
  if (ids.length === 0)
    throw new Error('glm: thinking-mode guide names no supported model ids')
  return [...new Set(ids)]
}

export function parseKimiReplay(text: string): Array<string> {
  const prose = plain(text)
  if (
    !prose.includes('reasoning_content') ||
    !(
      /complete assistant message.{0,180}(?:back|including)/i.test(prose) ||
      /完整 assistant message.{0,80}(?:回传|reasoning_content)/i.test(prose)
    )
  )
    throw new Error('kimi: thinking guide has no verified replay instruction')
  const preamble = text.split(/^## (?:Basic calls|基本调用)/m)[0] ?? ''
  const ids = [...new Set(preamble.match(/\bkimi-[a-z0-9][a-z0-9.-]*/g) ?? [])]
  if (ids.length === 0)
    throw new Error('kimi: thinking guide names no supported model ids')
  return ids
}

export function explicitCardReplay(text: string): boolean {
  return /must pass back the complete assistant message.{0,180}reasoning_content/i.test(
    plain(text),
  )
}

/**
 * `verify` runs before the body is cached, so a page it rejects is
 * refetched next poll instead of being served from KV for six hours.
 */
export async function loadReplayDoc(
  url: string,
  kv?: KVNamespace,
  cached: typeof cachedDocs = cachedDocs,
  verify?: (text: string) => unknown,
): Promise<{ text: string; source: FactSource }> {
  const doc = await cached(kv, url, async () => {
    const text = await fetchText(url, { signal: timeoutSignal(30_000) })
    if (
      /^\s*<(?:!doctype|html)/i.test(text) &&
      !url.includes('api-docs.deepseek.com')
    )
      throw new Error(`replay docs: ${url} returned HTML`)
    verify?.(text)
    return { text, hash: await sha256Text(text) }
  })
  return {
    text: doc.text,
    source: {
      derivation: 'docs-derived',
      sourceUrl: url,
      sourceHash: doc.hash,
      path: 'reasoning_content',
    },
  }
}

export function applyReplay(model: ModelInfo, source: FactSource): ModelInfo {
  return {
    ...model,
    requestMap: replayRequestMap(model.requestMap),
    factSources: {
      ...model.factSources,
      requestMap: model.factSources?.requestMap ?? source,
      requestMapFields: {
        ...model.factSources?.requestMapFields,
        replayReasoningContent: source,
      },
    },
  }
}
