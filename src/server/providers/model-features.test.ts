import { describe, expect, it } from 'vitest'

import {
  anthropicReasoning,
  anthropicSampling,
  anthropicServerTools,
  parseThinkingTable,
} from './anthropic-features.ts'
import {
  GEMINI_MODELS_INDEX_URL,
  GEMINI_THINKING_URL,
  familyOf,
  geminiModelFeatures,
  parseModelIndexDocs,
  parsePageModalities,
  parsePageSections,
  parsePageThinking,
  parsePageTools,
  parseThinkingBudgets,
  parseThinkingPage,
} from './gemini-features.ts'
import { grokReasoningGap, parseGrokReasoning } from './grok.ts'

describe('anthropic features (issue #77)', () => {
  const table = `| Model                 | Thinking types                   | Default   | Rejected with 400          |
| --------------------- | -------------------------------- | --------- | -------------------------- |
| Claude Fable 5.1      | Adaptive only                    | Always on | \`"enabled"\`, \`"disabled"\`  |
| Claude Opus 5         | Adaptive only                    | On        | \`"enabled"\`, \`"disabled"\`2 |
| Claude Sonnet 4.5     | Extended only                    | Off       | \`"adaptive"\`               |`

  it('reads "Always on" as thinking that cannot be turned off', () => {
    expect([...parseThinkingTable(table)]).toEqual([
      ['claude fable 5.1', true],
      ['claude opus 5', false],
      ['claude sonnet 4.5', false],
    ])
  })

  it('prefers adaptive, falls back to budget, lists supported efforts', () => {
    const effort = {
      supported: true,
      low: { supported: true },
      max: { supported: false },
    }
    expect(
      anthropicReasoning(
        {
          thinking: {
            supported: true,
            types: {
              enabled: { supported: true },
              adaptive: { supported: true },
            },
          },
          effort,
        },
        true,
      ),
    ).toEqual({ mode: 'adaptive', mandatory: true, efforts: ['low'] })
    expect(
      anthropicReasoning(
        {
          thinking: {
            supported: true,
            types: {
              enabled: { supported: true },
              adaptive: { supported: false },
            },
          },
        },
        false,
      ),
    ).toEqual({ mode: 'budget', mandatory: false })
    expect(anthropicReasoning({ thinking: { supported: false } }, false)).toBe(
      null,
    )
  })

  it('gives every model the unrestricted tools, listed models the rest', () => {
    const opus = anthropicServerTools('claude-opus-5-5')
    expect(opus.serverTools).toContain('web_search_20250305')
    expect(opus.serverTools).toContain('computer_toolset_20260801')
    expect(opus.serverTools).not.toContain('computer_20251124')
    expect(opus.sources.web_search_20250305?.sourceUrl).toMatch(
      /web-search-tool$/,
    )
    const unknown = anthropicServerTools('claude-new-model')
    expect(unknown.serverTools).toContain('bash_20250124')
    expect(unknown.serverTools).not.toContain('code_execution_20250825')
  })

  it('states sampling support for the ids the migration guides name', () => {
    for (const id of [
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-fable-5-1',
    ]) {
      expect(anthropicSampling(id).unsupported).toContain('temperature')
      expect(anthropicSampling(id).supported).toEqual([])
    }
    for (const id of [
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
    ]) {
      expect(anthropicSampling(id).supported).toEqual([
        'temperature',
        'top_p',
        'top_k',
      ])
    }
    expect(
      anthropicSampling('claude-haiku-4-5-20251001').sources.temperature
        ?.sourceUrl,
    ).toMatch(/haiku-5-5\/migration-guide$/)
    const none = anthropicSampling('claude-new-model')
    expect([none.supported, none.unsupported, none.sources]).toEqual([
      [],
      [],
      {},
    ])
  })
})

describe('gemini features (issue #77)', () => {
  const thinking = `You cannot disable thinking for Gemini 3.1 Pro. Gemini 3 Flash and Flash-Lite also do not support full thinking-off.

| Thinking Level | Gemini 3.8 \\& 3.7 Flash | Gemini 3.1 Pro | Description |
|---|---|---|---|
| **\`minimal\`** | Not supported (error) | Not supported | x |
| **\`low\`** | Supported | Supported | x |
| **\`high\`** | Supported (Dynamic) | Supported (Default, Dynamic) | x |

| Model | Default setting (Thinking budget is not set) | Range | Disable thinking | Turn on dynamic thinking |
|---|---|---|---|---|
| **2.5 Pro** | Dynamic thinking | \`128\` to \`32768\` | N/A: Cannot disable thinking | \`thinkingBudget = -1\` (Default) |
| **2.5 Flash** | Dynamic thinking | \`0\` to \`24576\` | \`thinkingBudget = 0\` | \`thinkingBudget = -1\` (Default) |
| **Robotics-ER 1.6 Preview** | Dynamic thinking | \`0\` to \`24576\` | \`thinkingBudget = 0\` | \`thinkingBudget = -1\` (Default) |
| **2.5 Flash Live Native Audio Preview (09-2025)** | Dynamic thinking | \`0\` to \`24576\` | \`thinkingBudget = 0\` | \`thinkingBudget = -1\` (Default) |`

  it('keys levels by family column and budgets by family row', () => {
    const parsed = parseThinkingPage(thinking)
    expect(parsed.get('gemini-3.7-flash')).toEqual({
      mode: 'effort',
      mandatory: null,
      efforts: ['low', 'high'],
    })
    expect(parsed.get('gemini-3.8-flash')).toEqual({
      mode: 'effort',
      mandatory: null,
      efforts: ['low', 'high'],
    })
    expect(parsed.get('gemini-3.1-pro')).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['low', 'high'],
    })
    expect(parsed.get('gemini-2.5-pro')).toEqual({
      mode: 'budget',
      mandatory: true,
    })
    expect(parsed.get('gemini-2.5-flash')).toEqual({
      mode: 'budget',
      mandatory: false,
    })
    expect(parsed.get('gemini-2.5-flash-native-audio-preview-09-2025')).toEqual(
      { mode: 'budget', mandatory: false },
    )
    expect(parsed.get('gemini-2.5-flash-native-audio-latest')).toBeUndefined()
    expect(
      parsed.get('gemini-2.5-flash-live-native-audio-preview'),
    ).toBeUndefined()
    expect(parsed.get('gemini-robotics-er-1.6-preview')).toBeUndefined()
    expect(
      parseThinkingBudgets(thinking).get(
        'gemini-2.5-flash-native-audio-preview-09-2025',
      ),
    ).toEqual({ on: -1, off: 0 })
    expect(parseThinkingBudgets(thinking).get('gemini-2.5-pro')).toEqual({
      on: -1,
      off: null,
    })
    expect(parseThinkingBudgets(thinking).get('gemini-2.5-flash')).toEqual({
      on: -1,
      off: 0,
    })
  })

  it('sets mandatory only for families the prose says cannot turn thinking off', () => {
    const page = `You cannot disable thinking for Gemini 3.1 Pro. Gemini 3 Flash and Flash-Lite also do not support full thinking-off.

| Thinking Level | Gemini 3 Flash | Gemini 3.1 Flash-Lite | Gemini 3.6 \\& 3.5 Flash | Gemini Robotics ER 2 | Description |
|---|---|---|---|---|---|
| **\`minimal\`** | Supported | Supported | Supported | Supported | x |
| **\`low\`** | Supported | Supported | Supported | Supported | x |
| **\`medium\`** | Supported | Supported | Supported | Supported | x |
| **\`high\`** | Supported | Supported | Supported | Supported | x |`
    const parsed = parseThinkingPage(page)
    const efforts = ['minimal', 'low', 'medium', 'high']
    expect(parsed.get('gemini-3-flash')).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts,
    })
    expect(parsed.get('gemini-3.1-flash-lite')).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts,
    })
    for (const id of [
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-robotics-er-2',
    ]) {
      expect(parsed.get(id)).toEqual({
        mode: 'effort',
        mandatory: null,
        efforts,
      })
    }
  })

  it('resolves ids to the longest family they version, never a sibling', () => {
    const families = ['gemini-2.5-flash', 'gemini-2.5-flash-lite']
    expect(familyOf('gemini-2.5-flash-lite-preview-09-2025', families)).toBe(
      'gemini-2.5-flash-lite',
    )
    expect(familyOf('gemini-2.5-flash-001', families)).toBe('gemini-2.5-flash')
    expect(familyOf('gemini-2.5-flash-image', families)).toBeNull()
  })

  it('does not invent a mode when the thinking tables omit the id', () => {
    const parsed = parseThinkingPage(thinking)
    expect(
      familyOf('gemini-2.5-computer-use-preview-10-2025', parsed.keys()),
    ).toBeNull()
    expect(familyOf('deep-research-preview-04-2026', parsed.keys())).toBeNull()
  })

  it('reads the Supported data types row, or nothing', () => {
    const row = (cells: string) => `x\n| Supported data types | ${cells} |\n`
    expect(
      parsePageModalities(
        row('**Inputs** Audio, images, video, text, and PDF **Output** Text'),
      ),
    ).toEqual({
      input: ['text', 'image', 'audio', 'video', 'file'],
      output: ['text'],
    })
    expect(
      parsePageModalities(
        row(
          '**Inputs** Audio (speech) **Output** Audio (translated speech) and Text (transcript)',
        ),
      ),
    ).toEqual({ input: ['audio'], output: ['text', 'audio'] })
    // A word that is not a medium leaves the whole fact unknown.
    expect(
      parsePageModalities(row('**Input** Text **Output** Text embeddings')),
    ).toBeNull()
    expect(
      parsePageModalities(
        row('**Input** Text, Image **Output** Video with audio'),
      ),
    ).toBeNull()
    expect(parsePageModalities('| Capabilities | x |')).toBeNull()
    // A parenthetical is dropped as a qualifier unless it names a medium.
    expect(
      parsePageModalities(
        row(
          '**Input** Text, Image, Video (up to 10s for editing) **Output** Audio (MP3), Text (Lyrics)',
        ),
      ),
    ).toEqual({ input: ['text', 'image', 'video'], output: ['text', 'audio'] })
    expect(
      parsePageModalities(
        row('**Inputs** Text (and Image, Audio) **Output** Text'),
      ),
    ).toBeNull()
    expect(
      parsePageModalities(row('**Inputs** Text **Output** Text (or images)')),
    ).toBeNull()
    expect(
      parsePageModalities(
        row('**Inputs** Text (short videos) **Output** Text'),
      ),
    ).toBeNull()
    // Timestamp metadata is not a medium. The other words still count.
    expect(
      parsePageModalities(
        row(
          '**Inputs** Audio (up to 1 hour) **Output** Text, Word annotations',
        ),
      ),
    ).toEqual({ input: ['audio'], output: ['text'] })
    expect(
      parsePageModalities(row('**Inputs** Audio **Output** Word annotations')),
    ).toBeNull()
  })

  describe('model pages', () => {
    const INDEX = 'https://ai.google.dev/gemini-api/docs/models'
    const page = (types: string) =>
      `| Supported data types | ${types} |\n| Capabilities | **[Search grounding](u)** Supported |\n`
    const withPages = async <T>(
      pages: Record<string, string | null>,
      run: () => Promise<T>,
      options?: {
        index?: string
        thinking?: string
        extras?: Record<string, string | null | 404>
      },
    ): Promise<T> => {
      const original = globalThis.fetch
      const indexBody =
        options?.index ??
        Object.keys(pages)
          .map((name) => `${INDEX}/${name}`)
          .join('\n')
      const thinkingBody = options?.thinking ?? thinking
      const extras = options?.extras ?? {}
      globalThis.fetch = ((url: string) => {
        const href = String(url)
        const slug = href.match(/\/models\/([^/]+)\.md\.txt$/)?.[1]
        const extra = Object.keys(extras).find((key) => href.endsWith(key))
        const body = href.endsWith('/thinking.md.txt')
          ? thinkingBody
          : slug && Object.hasOwn(pages, slug)
            ? pages[slug]
            : extra
              ? extras[extra]
              : indexBody
        return Promise.resolve(
          typeof body === 'string'
            ? new Response(body)
            : body === 404
              ? new Response('not found', { status: 404 })
              : new Response('upstream down', { status: 503 }),
        )
      }) as typeof fetch
      try {
        return await run()
      } finally {
        globalThis.fetch = original
      }
    }

    it('keeps stored facts, and records the failure, when a page fails to load', async () => {
      const { features, docsFailures } = await withPages(
        {
          'gemini-2.5-flash': page('**Inputs** Text, images **Output** Text'),
          'gemini-2.5-flash-lite': null,
        },
        () =>
          geminiModelFeatures([
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
            'gemma-4-31b-it',
          ]),
      )
      expect(features('gemini-2.5-flash', false)).toMatchObject({
        modalities: { input: ['text', 'image'], output: ['text'] },
        serverTools: ['googleSearch'],
        factSources: {
          modalities: {
            derivation: 'docs-derived',
            sourceUrl: `${INDEX}/gemini-2.5-flash.md.txt`,
            path: 'Supported data types',
          },
        },
      })
      expect(features('gemini-2.5-flash', false).absent).toBeUndefined()
      // The page that failed: the poll keeps what is stored, and the row is
      // not handed to the `gemini-2.5-flash` page that did load.
      expect(features('gemini-2.5-flash-lite', false)).toMatchObject({
        modalities: null,
        serverTools: null,
        absent: { modalities: 'unavailable', serverTools: 'unavailable' },
      })
      expect(docsFailures.failed).toBe(1)
      expect(docsFailures.first[0]?.source).toBe(
        `${INDEX}/gemini-2.5-flash-lite.md.txt`,
      )
      // No page at all is a plain unknown.
      expect(features('gemma-4-31b-it', false).absent).toBeUndefined()
    })

    it('keeps stored page facts when the models index parses no slugs (#567)', async () => {
      const { features, docsFailures } = await withPages(
        { 'gemini-2.5-flash': page('**Inputs** Text **Output** Text') },
        () => geminiModelFeatures(['gemini-2.5-flash']),
        { index: 'The docs moved.' },
      )
      expect(features('gemini-2.5-flash', true)).toMatchObject({
        modalities: null,
        serverTools: null,
        absent: { modalities: 'unavailable', serverTools: 'unavailable' },
      })
      expect(
        features('gemini-2.5-flash', true).absent?.reasoning,
      ).toBeUndefined()
      expect(docsFailures.first).toEqual([
        expect.objectContaining({
          source: GEMINI_MODELS_INDEX_URL,
          error: 'gemini models index: 0 slugs',
        }),
      ])
    })

    it('keeps stored reasoning when the thinking page parses nothing (#567)', async () => {
      const { features, docsFailures, thinkingLoaded } = await withPages(
        { 'gemini-2.5-flash': page('**Inputs** Text **Output** Text') },
        () => geminiModelFeatures(['gemini-2.5-flash']),
        { thinking: '' },
      )
      expect(thinkingLoaded).toBe(false)
      expect(features('gemini-2.5-flash', true)).toMatchObject({
        modalities: { input: ['text'], output: ['text'] },
        serverTools: ['googleSearch'],
        reasoning: null,
        absent: { reasoning: 'unavailable' },
      })
      expect(features('gemini-2.5-flash', false).absent).toBeUndefined()
      expect(docsFailures.first).toEqual([
        expect.objectContaining({
          source: GEMINI_THINKING_URL,
          error: 'gemini thinking page: parsed 0 model rows',
        }),
      ])
    })

    it('refuses a poll in which no page that loaded states modalities', async () => {
      await expect(
        withPages(
          {
            'gemini-2.5-flash': '| Supported modalities | Text |',
            'gemini-2.5-pro': '| Supported modalities | Text |',
          },
          () => geminiModelFeatures(['gemini-2.5-flash', 'gemini-2.5-pro']),
        ),
      ).rejects.toThrow('gemini model pages: 0 of 2 state modalities')
    })

    it('reads a model page the index does not link, by its own id (#409)', async () => {
      const own = (code: string) =>
        `## ${code}\n\n| Model code | \`${code}\` |\n${page('**Inputs** Text **Output** Text')}`
      const { features, docsFailures } = await withPages(
        { 'gemini-2.5-flash': page('**Inputs** Text **Output** Text') },
        () =>
          geminiModelFeatures([
            'gemini-2.5-flash',
            'gemini-3.5-flash',
            'gemini-3.7-flash',
            'gemini-flash-latest',
          ]),
        {
          extras: {
            '/models/gemini-3.5-flash.md.txt': own('gemini-3.5-flash'),
            // A page that names another model binds nothing to this id.
            '/models/gemini-3.7-flash.md.txt': own('gemini-9-flash'),
            '/models/gemini-flash-latest.md.txt': 404,
          },
        },
      )
      expect(features('gemini-3.5-flash', false)).toMatchObject({
        serverTools: ['googleSearch'],
        factSources: {
          serverTools: {
            googleSearch: {
              sourceUrl: `${INDEX}/gemini-3.5-flash.md.txt`,
              path: 'Capabilities',
            },
          },
        },
      })
      expect(features('gemini-3.7-flash', false).serverTools).toBeNull()
      expect(features('gemini-flash-latest', false)).toMatchObject({
        serverTools: null,
        modalities: null,
      })
      expect(docsFailures.failed).toBe(0)
    })

    it('maps Supported capabilities to generateContent tool fields', () => {
      const row =
        '| Capabilities | **[Code execution](u)** Supported **[Computer use](u)** Supported (Preview) **[File search](u)** Not supported **[Search grounding](u)** Supported **[Thinking](u)** Supported |'
      expect(parsePageTools(`x\n${row}\n`)).toEqual([
        'codeExecution',
        'computerUse',
        'googleSearch',
      ])
    })

    it('leaves tools empty when the page marks none supported', () => {
      const row =
        '| Capabilities | **[Code execution](u)** Not supported **[Search grounding](u)** Not supported |'
      expect(parsePageTools(`x\n${row}\n`)).toEqual([])
    })

    it('reads backtick thinking levels and drops a level the same paragraph rejects', () => {
      expect(
        parsePageThinking(
          'Configurable Thinking levels (`minimal`, `medium` default, and `high`).',
        ),
      ).toEqual({
        mode: 'effort',
        mandatory: null,
        efforts: ['minimal', 'medium', 'high'],
      })
      expect(
        parsePageThinking(
          'Configure background reasoning using `thinking_config` (`thinking_level`: `low`, `medium`, or `high`). Note that `MINIMAL` is not supported.',
        ),
      ).toEqual({
        mode: 'effort',
        mandatory: null,
        efforts: ['low', 'medium', 'high'],
      })
      expect(
        parsePageThinking(
          'Thinking levels (`low`, `high`). You cannot disable thinking for this model.',
        )?.mandatory,
      ).toBe(true)
      expect(
        parsePageThinking('generation_config.thinking_level: "high"'),
      ).toBeNull()
      expect(
        parsePageThinking(
          'Thinking levels (`low`).\n\nThinking levels (`high`).',
        ),
      ).toBeNull()
    })

    it('binds endpoint ids on the models index and version ids on the page', () => {
      const index = [
        '| [Gemini Omni Flash](https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash) | ``` gemini-omni-1.1-flash ``` |',
        '| [Gemini 3.1 Pro](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview) | ``` gemini-3.1-pro-preview ``` |',
        '| [Gemini Robotics ER 2](https://ai.google.dev/gemini-api/docs/robotics-overview) | ``` gemini-robotics-er-2-preview ``` |',
        'https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash',
      ].join('\n')
      const docs = parseModelIndexDocs(index)
      expect(docs).toEqual([
        {
          url: 'https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash',
          ids: ['gemini-omni-1.1-flash'],
        },
        {
          url: 'https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview',
          ids: ['gemini-3.1-pro-preview'],
        },
        {
          url: 'https://ai.google.dev/gemini-api/docs/robotics-overview',
          ids: ['gemini-robotics-er-2-preview'],
        },
        {
          url: 'https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash',
          ids: [],
        },
      ])
      const omni = `## gemini-omni-1.1-flash\n| Model code | **Gemini API** \`gemini-omni-1.1-flash\` |\n| Supported data types | **Input** Text, Image, Video (up to 10s for editing and extension) **Output** Video |\n| Versions | - Stable: \`gemini-omni-1.1-flash\` - Preview: \`gemini-omni-flash-preview\` |`
      const pro = `## gemini-3.1-pro-preview\n| Model code | \`gemini-3.1-pro-preview\` |\n| Supported data types | **Inputs** Text **Output** Text |\n| Versions | - Preview: \`gemini-3.1-pro-preview\` - Preview: \`gemini-3.1-pro-preview-customtools\` |`
      const overview = [
        '### Gemini Robotics ER 2 Preview',
        '| Model code | `gemini-robotics-er-2-preview` |',
        '| Supported data types | **Inputs** Text, images, video, audio **Output** Text |',
        'generation_config={"thinking_level": "high"}',
        '### Gemini Robotics ER 2 Streaming Preview',
        '| Model code | `gemini-robotics-er-2-streaming-preview` |',
        '| Supported data types | **Inputs** Audio **Output** Text |',
      ].join('\n')
      const sections = parsePageSections(overview)
      expect(sections.map((section) => section.ids)).toEqual([
        ['gemini-robotics-er-2-preview'],
        ['gemini-robotics-er-2-streaming-preview'],
      ])
      expect(parsePageThinking(overview)).toBeNull()
      return withPages(
        {
          'gemini-omni-flash': omni,
          'gemini-3.1-pro-preview': pro,
          'gemini-2.5-flash':
            '| Supported data types | **Inputs** Text **Output** Text |',
        },
        async () => {
          const { features } = await geminiModelFeatures([
            'gemini-omni-1.1-flash',
            'gemini-omni-flash-preview',
            'gemini-3.1-pro-preview',
            'gemini-3.1-pro-preview-customtools',
            'gemini-robotics-er-2-preview',
            'gemini-robotics-er-2-streaming-preview',
          ])
          expect(features('gemini-omni-1.1-flash', false).modalities).toEqual({
            input: ['text', 'image', 'video'],
            output: ['video'],
          })
          expect(
            features('gemini-omni-flash-preview', false).modalities?.output,
          ).toEqual(['video'])
          expect(
            features('gemini-3.1-pro-preview-customtools', false).modalities,
          ).toEqual({ input: ['text'], output: ['text'] })
          expect(
            features('gemini-robotics-er-2-preview', false).modalities?.input,
          ).toEqual(['text', 'image', 'audio', 'video'])
          expect(
            features('gemini-robotics-er-2-streaming-preview', false)
              .modalities,
          ).toEqual({ input: ['audio'], output: ['text'] })
          expect(
            features('gemini-robotics-er-2-streaming-preview', true).reasoning,
          ).toBeNull()
        },
        {
          index,
          extras: { '/robotics-overview.md.txt': overview },
        },
      )
    })

    it('uses native page thinking levels even when listing omits its flag', () => {
      const body = [
        '- Configurable Thinking levels (`minimal`, `medium` default, and `high`).',
        '## gemini-nano-banana-2.1',
        '| Model code | `gemini-nano-banana-2.1` |',
        '| Supported data types | **Inputs** Text, Image **Output** Image and Text |',
      ].join('\n')
      return withPages({ 'gemini-nano-banana-2.1': body }, async () => {
        const { features } = await geminiModelFeatures([
          'gemini-nano-banana-2.1',
        ])
        expect(features('gemini-nano-banana-2.1', true)).toMatchObject({
          reasoning: {
            mode: 'effort',
            mandatory: null,
            efforts: ['minimal', 'medium', 'high'],
          },
          factSources: {
            reasoning: {
              path: 'thinking level',
              sourceUrl: `${INDEX}/gemini-nano-banana-2.1.md.txt`,
            },
          },
        })
        expect(features('gemini-nano-banana-2.1', undefined).reasoning).toEqual(
          features('gemini-nano-banana-2.1', true).reasoning,
        )
      })
    })

    it('keeps the dedicated model-code page when a versions row repeats the id', async () => {
      const index = [
        '| [Gemini 3.5 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash) | ``` gemini-3.5-flash ``` |',
        '| [Gemini 3 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3-flash-preview) | ``` gemini-3-flash-preview ``` |',
      ].join('\n')
      const flash35 = [
        '## gemini-3.5-flash',
        '| Model code | `gemini-3.5-flash` |',
        '| Versions | - Stable: `gemini-3.5-flash` - Preview: `gemini-3-flash-preview` |',
        '| Supported data types | **Inputs** Audio **Output** Text |',
      ].join('\n')
      const flash3 = [
        '## gemini-3-flash-preview',
        '| Model code | `gemini-3-flash-preview` |',
        '| Supported data types | **Inputs** Text **Output** Text |',
      ].join('\n')
      const { features } = await withPages(
        {
          'gemini-3.5-flash': flash35,
          'gemini-3-flash-preview': flash3,
        },
        () =>
          geminiModelFeatures(['gemini-3.5-flash', 'gemini-3-flash-preview']),
        { index },
      )
      expect(features('gemini-3-flash-preview', false).modalities).toEqual({
        input: ['text'],
        output: ['text'],
      })
      expect(features('gemini-3.5-flash', false).modalities).toEqual({
        input: ['audio'],
        output: ['text'],
      })
    })

    it('lets a looked-up page repeat a sibling another page states', async () => {
      const index = [
        '| [Gemini Robotics ER 2](https://ai.google.dev/gemini-api/docs/robotics-overview) | ``` gemini-robotics-er-2-preview ``` |',
        `${INDEX}/gemini-2.5-flash`,
      ].join('\n')
      const section = (id: string, types: string) =>
        `### ${id}\n| Model code | \`${id}\` |\n| Supported data types | ${types} |\n`
      const overview = section(
        'gemini-robotics-er-2-preview',
        '**Inputs** Text, images **Output** Text',
      )
      // Google's family page repeats the sibling's table above its own.
      const streaming = [
        section(
          'gemini-robotics-er-2-preview',
          '**Inputs** Text, images **Output** Text',
        ),
        section(
          'gemini-robotics-er-2-streaming-preview',
          '**Inputs** Audio **Output** Text',
        ),
        section(
          'gemini-robotics-er-1.6-preview',
          '**Inputs** Video **Output** Text',
        ),
      ].join('\n')
      const { features } = await withPages(
        {},
        () =>
          geminiModelFeatures([
            'gemini-robotics-er-2-preview',
            'gemini-robotics-er-2-streaming-preview',
            'gemini-robotics-er-1.6-preview',
          ]),
        {
          index,
          extras: {
            '/robotics-overview.md.txt': overview,
            '/models/gemini-robotics-er-2-streaming-preview.md.txt': streaming,
            '/models/gemini-robotics-er-1.6-preview.md.txt': 404,
          },
        },
      )
      expect(features('gemini-robotics-er-2-preview', false)).toMatchObject({
        modalities: { input: ['text', 'image'], output: ['text'] },
        factSources: {
          modalities: {
            sourceUrl:
              'https://ai.google.dev/gemini-api/docs/robotics-overview.md.txt',
          },
        },
      })
      expect(
        features('gemini-robotics-er-2-streaming-preview', false).modalities,
      ).toEqual({ input: ['audio'], output: ['text'] })
      // A sibling no other page states still binds from the repeat.
      expect(
        features('gemini-robotics-er-1.6-preview', false).modalities,
      ).toEqual({ input: ['video'], output: ['text'] })
    })

    it('refuses a model id that two pages both document', async () => {
      const documented = (id: string) =>
        `## ${id}\n| Model code | \`${id}\` |\n| Supported data types | **Inputs** Text **Output** Text |\n`
      await expect(
        withPages(
          {
            'gemini-a': documented('shared-id'),
            'gemini-b': documented('shared-id'),
          },
          () => geminiModelFeatures(['gemini-a', 'gemini-b']),
        ),
      ).rejects.toThrow('gemini model pages: shared-id is documented twice')
    })
  })
})

describe('grok reasoning (issue #77)', () => {
  const page = (lines: string) =>
    `# Grok\n\n## Capabilities\n\n${lines}\n\n## Pricing\n`
  it('reads efforts; none means reasoning can be turned off', () => {
    expect(
      parseGrokReasoning(
        page(
          '- **Reasoning:** Yes\n- **Reasoning efforts (supported):** `low`, `high`',
        ),
      ),
    ).toEqual({ mode: 'effort', mandatory: true, efforts: ['low', 'high'] })
    expect(
      parseGrokReasoning(
        page(
          '- **Reasoning:** Yes\n- **Reasoning efforts (supported):** `none`, `low`',
        ),
      )?.mandatory,
    ).toBe(false)
  })

  it('stays null without a documented knob or without reasoning', () => {
    const yes = page('- **Reasoning:** Yes')
    expect(parseGrokReasoning(yes)).toBeNull()
    expect(grokReasoningGap(yes)).toBe('silent')
    const no = page('- **Reasoning:** No')
    expect(parseGrokReasoning(no)).toBeNull()
    expect(grokReasoningGap(no)).toBeNull()
  })
})
