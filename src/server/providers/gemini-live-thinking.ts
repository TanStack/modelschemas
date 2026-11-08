import { cachedDocs, markdocTables, markdownTableRows } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelReasoning } from './types.ts'

export const GEMINI_LIVE_GUIDE_URL =
  'https://aistudio.google.com/docs/live-api/capabilities.md'

/**
 * The Live API guide's Model comparison table. The one column whose
 * Thinking cell says "Uses `thinkingBudget`" is the native audio model;
 * its id is the `/docs/models/{id}` link the guide gives that column's
 * name. The guide no longer says thinking can be disabled for it, so
 * `mandatory` is unstated.
 */
export function parseGeminiNativeAudioThinking(markdown: string): {
  rawId: string
  reasoning: ModelReasoning
} {
  const text = markdocTables(markdown.replace(/```[\s\S]*?```/g, ''))
  const rows = markdownTableRows(text)
  const header = rows.find((row) => row[0] === 'Feature')
  const thinking = rows.find((row) =>
    (row[0] ?? '').startsWith('**[Thinking]('),
  )
  const budgetColumns = (header ?? []).filter(
    (_name, column) =>
      column > 0 &&
      (thinking?.[column] ?? '').startsWith('Uses `thinkingBudget`'),
  )
  const name = budgetColumns.length === 1 ? budgetColumns[0] : undefined
  const rawId = name
    ? [...text.matchAll(/\[([^\]]+)\]\(\/docs\/models\/([a-z0-9.-]+)\)/g)].find(
        (link) => link[1] === name,
      )?.[2]
    : undefined
  if (!rawId?.includes('native-audio')) {
    throw new Error(
      'gemini live guide: native audio thinkingBudget column unreadable',
    )
  }
  return { rawId, reasoning: { mode: 'budget', mandatory: null } }
}

export async function geminiNativeAudioThinking(
  rawIds: ReadonlyArray<string>,
  kv?: KVNamespace,
  cached: typeof cachedDocs = cachedDocs,
) {
  // Names select which own guide to check; only its literal model ID binds facts.
  if (!rawIds.some((id) => id.includes('native-audio'))) return null
  return cached(kv, GEMINI_LIVE_GUIDE_URL, async () => {
    const markdown = await fetchText(GEMINI_LIVE_GUIDE_URL, {
      signal: AbortSignal.timeout(20_000),
    })
    return {
      ...parseGeminiNativeAudioThinking(markdown),
      hash: await sha256Text(markdown),
    }
  })
}
