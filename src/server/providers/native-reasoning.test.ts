import { requestUrl } from '#/lib/text.ts'
import { afterEach, expect, it } from 'vitest'
import nativeDocs from './fixtures/native-reasoning-docs.json'
import { parseReasoningEffort } from './openai-model-docs.ts'
import {
  parseMistralReasoning,
  openRouterReasoning,
} from './reasoning-config.ts'
import { geminiModelFeatures, parsePageThinking } from './gemini-features.ts'
import { openrouterProvider, openrouterCapabilities } from './openrouter.ts'
import { geminiCapabilities } from './gemini.ts'
import {
  applyDashscopeThinking,
  parseDashscopeThinking,
  DASHSCOPE_THINKING_URL,
} from './dashscope-thinking.ts'
import {
  applyTogetherNativeThinking,
  parseTogetherNativeThinking,
  togetherNativeThinking,
  TOGETHER_GLM_URL,
  TOGETHER_DEEPSEEK_URL,
} from './together-native-thinking.ts'

import openRouterGuide from './fixtures/openrouter-native-toggle.json'

const docs = nativeDocs as Record<string, string>
const originalFetch = globalThis.fetch
function serve() {
  globalThis.fetch = async (input) => {
    const url = requestUrl(input)
    const body =
      url === openRouterGuide.sourceUrl ? openRouterGuide.markdown : docs[url]
    if (body === undefined) throw new Error(`unexpected native source ${url}`)
    return new Response(body)
  }
}
afterEach(() => {
  globalThis.fetch = originalFetch
})
it('reads actual OpenAI multiline, Codex and GPT-OSS effort lists without negative prose or sample leakage', () => {
  const parse = (id: string) =>
    parseReasoningEffort(
      docs[`https://developers.openai.com/api/docs/models/${id}.md`] ?? '',
    )
  expect(parse('gpt-6.1-sol')?.efforts).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
  expect(parse('gpt-5.2-codex')?.efforts).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
  ])
  expect(parse('gpt-oss-120b')?.efforts).toEqual(['low', 'medium', 'high'])
  expect(parse('gpt-6-luna')?.mandatory).toBe(false)
  expect(parse('gpt-5.2-codex')?.mandatory).toBeNull()
  expect(parse('gpt-oss-120b')?.mandatory).toBeNull()
  expect(
    parseReasoningEffort(
      'Reasoning.effort supports: low, high. Thinking cannot be disabled.',
    )?.mandatory,
  ).toBe(true)
  expect(parseReasoningEffort('Reasoning tokens are supported.')).toBeNull()
  expect(
    parseReasoningEffort('```\nReasoning.effort supports: high.\n```'),
  ).toBeNull()
})
it('reads Mistral normative scoped control values and the model-specific override', () => {
  const facts = parseMistralReasoning(
    docs['https://docs.mistral.ai/studio/conversations/reasoning.md'] ?? '',
  )
  expect(facts.get('mistral-large-4-0')).toEqual({
    mode: 'effort',
    mandatory: false,
    efforts: ['high', 'none'],
  })
  expect(facts.get('zai-glm-5-3')?.efforts).toEqual(['low', 'high', 'max'])
  expect(facts.get('zai-glm-5-3')?.mandatory).toBe(true)
  expect(facts.has('magistral-medium-latest')).toBe(false)
  const withExample = (
    docs['https://docs.mistral.ai/studio/conversations/reasoning.md'] ?? ''
  ).replace(
    'The `reasoning_effort` parameter controls',
    '```text\n- `reasoning_effort = "invented"`: only an example\n```\nThe `reasoning_effort` parameter controls',
  )
  expect(
    parseMistralReasoning(withExample).get('mistral-large-4-0')?.efforts,
  ).toEqual(['high', 'none'])
  const changed = (
    docs['https://docs.mistral.ai/studio/conversations/reasoning.md'] ?? ''
  )
    .replace(
      /the model thinks minimally and the thinking chunk is omitted/gi,
      'the response format varies',
    )
    .replace(/`zai-glm-5-3` supports[^\n]+/g, '')
  const silentMandatory = parseMistralReasoning(changed)
  expect(silentMandatory.get('mistral-large-4-0')?.mandatory).toBeNull()
  expect(silentMandatory.get('zai-glm-5-3')?.mandatory).toBeNull()
})
it('binds own OpenRouter gateway toggle when native effort metadata is absent', async () => {
  serve()
  const { models } = await openrouterProvider.listModels({})
  expect(models).toHaveLength(3)
  for (const model of models) expect(model.capabilities).toContain('reasoning')
  expect(models.find((m) => m.rawId === 'qwen/qwen3-max')?.reasoning).toEqual({
    mode: 'toggle',
    mandatory: false,
  })
  expect(openRouterReasoning({ reasoning: { mandatory: false } })).toBeNull()
  expect(() => openrouterCapabilities({ reasoning: [] })).toThrow(
    'unreadable native reasoning',
  )
  expect(() =>
    openrouterCapabilities({ supported_parameters: 'reasoning' }),
  ).toThrow('unreadable supported_parameters')
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }))
  await expect(openrouterProvider.listModels({})).rejects.toThrow(
    'empty native model catalog',
  )
})
it('uses native Gemini model thinking evidence without a listing flag and binds only sourced aliases', async () => {
  serve()
  const { features } = await geminiModelFeatures([
    'gemini-3.8-flash',
    'gemini-flash-latest',
    'gemma-4-31b-it',
  ])
  expect(features('gemini-3.8-flash', undefined)).toMatchObject({
    capabilities: ['reasoning'],
    reasoning: { mode: 'effort', efforts: ['low', 'medium', 'high'] },
  })
  expect(
    parsePageThinking(
      docs['https://aistudio.google.com/docs/models/gemini-3.8-flash.md'] ?? '',
    )?.efforts,
  ).toEqual(['low', 'medium', 'high'])
  expect(features('gemini-3.8-flash', false)).toMatchObject({
    reasoning: null,
    budget: null,
  })
  expect(features('gemini-3.8-flash', false).capabilities).toBeUndefined()
  expect(features('gemini-flash-latest', false).reasoning).toBeNull()
  expect(features('gemma-4-31b-it', false).reasoning).toBeNull()
  for (const id of ['gemini-flash-latest', 'gemma-4-31b-it']) {
    const record = JSON.parse(
      docs['https://generativelanguage.googleapis.com/v1beta/models/' + id] ??
        '{}',
    ) as { thinking?: boolean }
    expect(geminiCapabilities(record)).toContain('reasoning')
  }
})
it('scopes Dashscope hybrid capability and replay to published IDs, excluding samples and sibling guesses', () => {
  const parsed = parseDashscopeThinking(docs[DASHSCOPE_THINKING_URL] ?? '')
  const evidence = { ...parsed, hash: 'native-fixture' }
  expect(parsed.models['qwen3.7-max']?.hybrid).toBe(true)
  expect(parsed.models['qwq-plus']?.hybrid).toBe(false)
  expect(parsed.models['qwen3.5-flash']?.hybrid).toBe(true)
  expect(parsed.models['model-studio']).toBeUndefined()
  expect(parsed.models['qwen-omni']).toBeUndefined()
  const known = applyDashscopeThinking(
    {
      rawId: 'qwen3.7-max',
      activity: 'chat',
      requestMap: {
        thinking: null,
        maxTokensField: null,
        developerRole: null,
        replayReasoningContent: null,
        store: null,
        strictTools: null,
        sessionAffinity: null,
        cacheControl: null,
        toolStream: null,
        reasoningEffort: null,
      },
    },
    evidence,
  )
  expect(known.reasoning).toEqual({ mode: 'toggle', mandatory: false })
  expect(known.requestMap?.replayReasoningContent).toBe(true)
  expect(known.requestMap?.thinking).toBeNull()
  expect(
    applyDashscopeThinking({ rawId: 'qwq-plus', activity: 'chat' }, evidence),
  ).toMatchObject({ capabilities: ['reasoning'] })
  expect(
    applyDashscopeThinking(
      { rawId: 'unpublished-model', activity: 'chat' },
      evidence,
    ).capabilities,
  ).toBeUndefined()
  expect(() => parseDashscopeThinking('malformed source')).toThrow(
    'missing native modes',
  )
})
it('uses Together own preserved-thinking wire and keeps undocumented sibling controls unknown', async () => {
  serve()
  const evidence = await togetherNativeThinking()
  const glm = parseTogetherNativeThinking(nativeDocs[TOGETHER_GLM_URL])
  expect(glm.ids).toEqual(['zai-org/GLM-5.3', 'zai-org/GLM-5.3-Flash'])
  expect(glm.replay).toEqual(['zai-org/GLM-5.3'])
  const deep = parseTogetherNativeThinking(nativeDocs[TOGETHER_DEEPSEEK_URL])
  expect(deep.replay).toEqual(['deepseek-ai/DeepSeek-V4-Pro-0813'])
  const model = applyTogetherNativeThinking(
    { rawId: 'deepseek-ai/DeepSeek-V4-Pro-0813', activity: 'chat' },
    evidence,
  )
  expect(model.requestMap?.replayReasoningContent).toBe(true)
  expect(model.requestMap?.thinking).toBeNull()
  expect(model.requestMap?.reasoningEffort).toBeNull()
  expect(
    applyTogetherNativeThinking(
      { rawId: 'deepseek-ai/DeepSeek-V4.1-Flash', activity: 'chat' },
      evidence,
    ).requestMap,
  ).toBeUndefined()
  const flash = applyTogetherNativeThinking(
    { rawId: 'zai-org/GLM-5.3-Flash', activity: 'chat' },
    evidence,
  )
  expect(flash.capabilities).toContain('reasoning')
  expect(flash.requestMap).toBeNull()
})

it('preserves native map provenance, capability negatives and explicit replay rejections', async () => {
  serve()
  const evidence = await togetherNativeThinking()
  const oldSource = {
    derivation: 'docs-derived' as const,
    sourceUrl: 'https://native.test/request',
    sourceHash: 'old',
    path: 'request',
  }
  const oldMap = {
    thinking: null,
    maxTokensField: 'max_tokens' as const,
    developerRole: false,
    replayReasoningContent: null,
    store: null,
    strictTools: null,
    sessionAffinity: null,
    cacheControl: null,
    toolStream: null,
    reasoningEffort: null,
  }
  const together = applyTogetherNativeThinking(
    {
      rawId: 'zai-org/GLM-5.3',
      activity: 'chat',
      capabilities: { tools: true, vision: false },
      requestMap: oldMap,
      factSources: { requestMap: oldSource },
    },
    evidence,
  )
  expect(together.capabilities).toEqual({
    tools: true,
    vision: false,
    reasoning: true,
  })
  expect(together.requestMap?.maxTokensField).toBe('max_tokens')
  expect(together.requestMap?.developerRole).toBe(false)
  expect(together.factSources?.requestMap).toEqual(oldSource)
  expect(
    together.factSources?.requestMapFields?.replayReasoningContent?.sourceUrl,
  ).toBe(TOGETHER_GLM_URL)
  const qwenEvidence = {
    ...parseDashscopeThinking(docs[DASHSCOPE_THINKING_URL] ?? ''),
    hash: 'fixture',
  }
  const qwen = applyDashscopeThinking(
    {
      rawId: 'qwen3.7-max',
      activity: 'chat',
      capabilities: { tools: true, vision: false },
      requestMap: oldMap,
      factSources: { requestMap: oldSource },
    },
    qwenEvidence,
  )
  expect(qwen.capabilities).toEqual({
    tools: true,
    vision: false,
    reasoning: true,
  })
  expect(qwen.factSources?.requestMap).toEqual(oldSource)
  expect(
    qwen.factSources?.requestMapFields?.replayReasoningContent?.sourceUrl,
  ).toBe(DASHSCOPE_THINKING_URL)
  expect(() =>
    applyTogetherNativeThinking(
      {
        rawId: 'zai-org/GLM-5.3',
        activity: 'chat',
        capabilities: { reasoning: false },
      },
      evidence,
    ),
  ).toThrow('explicit rejection')
  expect(() =>
    applyDashscopeThinking(
      {
        rawId: 'qwen3.7-max',
        activity: 'chat',
        capabilities: { reasoning: false },
      },
      qwenEvidence,
    ),
  ).toThrow('explicit rejection')
  expect(() =>
    applyTogetherNativeThinking(
      {
        rawId: 'zai-org/GLM-5.3',
        activity: 'chat',
        requestMap: { ...oldMap, replayReasoningContent: false },
      },
      evidence,
    ),
  ).toThrow('explicit rejection')
  expect(() =>
    applyDashscopeThinking(
      {
        rawId: 'qwen3.7-max',
        activity: 'chat',
        requestMap: { ...oldMap, replayReasoningContent: false },
      },
      qwenEvidence,
    ),
  ).toThrow('explicit rejection')
})

it('does not read explicitly negated always-on prose as mandatory reasoning', () => {
  expect(
    parseReasoningEffort(
      'Reasoning.effort supports: low, high. Thinking is not always on.',
    )?.mandatory,
  ).toBeNull()
  expect(
    parseReasoningEffort(
      'Reasoning.effort supports: low, high. Thinking is always on.',
    )?.mandatory,
  ).toBe(true)
  const mistral = (
    docs['https://docs.mistral.ai/studio/conversations/reasoning.md'] ?? ''
  ).replace('is always returned', 'is not always returned')
  expect(
    parseMistralReasoning(mistral).get('zai-glm-5-3')?.mandatory,
  ).toBeNull()
})
