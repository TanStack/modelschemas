import { afterEach, expect, it } from 'vitest'
import docs from './fixtures/gemini-native-audio-thinking.json'
import {
  geminiNativeAudioThinking,
  parseGeminiNativeAudioThinking,
} from './gemini-live-thinking.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
it('binds the Model comparison thinkingBudget column to its linked native audio id', () => {
  // The guide no longer says thinking can be disabled: mandatory is unstated.
  expect(parseGeminiNativeAudioThinking(docs.markdown)).toEqual({
    rawId: 'gemini-2.5-flash-native-audio-preview-12-2025',
    reasoning: { mode: 'budget', mandatory: null },
  })
  expect(() =>
    parseGeminiNativeAudioThinking('```\n' + docs.markdown + '\n```'),
  ).toThrow()
})
it('throws when the thinkingBudget column is not exactly one native audio model', () => {
  // A second column that also uses thinkingBudget is ambiguous.
  expect(() =>
    parseGeminiNativeAudioThinking(
      docs.markdown.replace(
        'Uses `thinkingLevel` (`minimal`',
        'Uses `thinkingBudget` (`minimal`',
      ),
    ),
  ).toThrow('unreadable')
  // The column's name must link a native audio model page.
  expect(() =>
    parseGeminiNativeAudioThinking(
      docs.markdown.replace(
        '/docs/models/gemini-2.5-flash-native-audio-preview-12-2025',
        '/docs/models/gemini-2.5-flash',
      ),
    ),
  ).toThrow('unreadable')
})
it('uses model names only to select own guide; exact binding excludes latest aliases', async () => {
  globalThis.fetch = async () => new Response(docs.markdown)
  const parsed = await geminiNativeAudioThinking([
    'gemini-2.5-flash-native-audio-latest',
  ])
  expect(parsed?.rawId).toBe('gemini-2.5-flash-native-audio-preview-12-2025')
  expect(parsed?.rawId).not.toBe('gemini-2.5-flash-native-audio-latest')
})
it('fails clearly when the native source cannot be read', async () => {
  globalThis.fetch = async () => new Response('unavailable', { status: 503 })
  await expect(
    geminiNativeAudioThinking([
      'gemini-2.5-flash-native-audio-preview-12-2025',
    ]),
  ).rejects.toThrow('503')
})
