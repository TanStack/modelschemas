import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { findDanglingRefs } from '#/server/ingest/bundle.ts'
import { classifyAndBundle } from '#/server/ingest/sync.ts'
import { cardRequestParamsOk } from '#/server/rate-card.ts'
import {
  arkChatCapabilities,
  arkTaskActivity,
  byteplusProvider,
} from './byteplus.ts'
import {
  BYTEPLUS_MODEL_LIST_URL,
  BYTEPLUS_PRICING_URL,
  BYTEPLUS_VIDEO_GUIDE_URL,
  compileSeedreamProCard,
} from './byteplus-pricing.ts'
import { BYTEPLUS_REASONING_URL } from './reasoning-config.ts'
import { pricingDoc, routerHtml } from './fixtures/byteplus-pricing-doc.ts'
import type { PricingTable } from './fixtures/byteplus-pricing-doc.ts'
import { docFixtureHtml } from './fixtures/byteplus-doc.ts'

/**
 * One chat, video, and image row, enough for listModels to attach cards
 * without fetching the live pricing page (that fetch races other tests'
 * fetch stubs).
 */
function pricingFixtureHtml(): string {
  return routerHtml(pricingDoc(PRICING_TABLES))
}

/** The tutorial's model and pixel tables, one Seedance 1.0 row each. */
function guideFixtureHtml(): string {
  return docFixtureHtml([
    [
      ['Model name', '', 'Seedance 1.0 Pro'],
      ['Model ID', '', 'seedance-1-0-pro-250528'],
      ['', 'Frame rate', '24 fps'],
    ],
    [
      ['Resolution', 'Aspect ratio', 'Seedance 1.0 series'],
      ['1080p', '16:9', '1920×1088'],
    ],
  ])
}

/** The thinking page: one effort list and one supported-models row. */
function reasoningFixtureHtml(): string {
  return docFixtureHtml([
    '## Adjust chain-of-thought length',
    'minimal',
    'high',
    [
      ['Supported models', 'Default value'],
      ['* seed-2-0-lite-260428', 'high'],
    ],
    '## Pass thinking content back',
  ])
}

/** Model list alias for the lite Seedream row the pricing fixture names. */
function modelListFixtureHtml(): string {
  const data = {
    '0': {
      ops: [
        {
          insert:
            'seedream-5-0-260128\n(also supports: seedream-5-0-lite-260128)\n',
        },
      ],
    },
  }
  const router = {
    loaderData: { page: { curDoc: { Content: JSON.stringify({ data }) } } },
  }
  return `<script>window._ROUTER_DATA = ${JSON.stringify(router)}</script>`
}

/** Pages the provider fetches besides the Ark listing, by URL. */
const DOC_FIXTURES: Record<string, () => string> = {
  [BYTEPLUS_PRICING_URL]: pricingFixtureHtml,
  [BYTEPLUS_VIDEO_GUIDE_URL]: guideFixtureHtml,
  [BYTEPLUS_REASONING_URL]: reasoningFixtureHtml,
  [BYTEPLUS_MODEL_LIST_URL]: modelListFixtureHtml,
}

const PRICING_TABLES: Array<PricingTable> = [
  {
    tab: 'Standard',
    rows: [
      [
        'Provider',
        'Model ID',
        'Prompt length',
        'Input',
        'Cached input',
        'Cache storage',
        'Output',
      ],
      [
        'ByteDance',
        'seed-2-0-pro-260328',
        'Not applicable',
        '$0.50',
        '$0.10',
        '$0.0083',
        '$3.00',
      ],
    ],
  },
  {
    tab: 'Input without video',
    rows: [
      ['Model', 'Online inference', '', '', 'Offline inference'],
      ['', '480p and 720p', '1080p', '4K', ''],
      ['seedance-1-0-pro-250528', '$2.5', '', '', '$1.25'],
    ],
    merges: [
      [[0], [1, 2, 3]],
      [[2], [1, 2, 3]],
    ],
  },
  {
    rows: [
      ['Model ID', 'Input image', 'Output image'],
      ['seedream-5-0-lite-260128', 'Free', '$0.035'],
      ['seedream-4-5-251128', 'Free', '$0.04'],
      ['seedream-4-0-250828', 'Free', '$0.03'],
    ],
  },
]

/**
 * Minimal stand-ins for the four `service/arkruntime/model` files fetchSpec
 * pulls — enough Go to define every endpoint root and its closure.
 */
const GO_FIXTURES: Record<string, string> = {
  'chat_completion.go': `
type ThinkingType string
const (
	ThinkingTypeEnabled  ThinkingType = "enabled"
	ThinkingTypeDisabled ThinkingType = "disabled"
)
type Thinking struct {
	Type ThinkingType \`json:"type"\`
}
type ChatCompletionMessage struct {
	Role    string \`json:"role"\`
	Content string \`json:"content,omitempty"\`
}
type CreateChatCompletionRequest struct {
	Model       string                   \`json:"model"\`
	Messages    []*ChatCompletionMessage \`json:"messages"\`
	MaxTokens   *int                     \`json:"max_tokens,omitempty"\`
	Thinking    *Thinking                \`json:"thinking,omitempty"\`
	ServiceTier *string                  \`json:"service_tier,omitempty"\`
}
type ChatCompletionResponse struct {
	ID    string \`json:"id"\`
	Model string \`json:"model"\`
	Usage Usage  \`json:"usage"\`
}
`,
  'images.go': `
type GenerateImagesRequest struct {
	Model     string      \`json:"model"\`
	Prompt    string      \`json:"prompt"\`
	Image     interface{} \`json:"image,omitempty"\`
	Size      *string     \`json:"size,omitempty"\`
	Watermark *bool       \`json:"watermark,omitempty"\`
}
type ImagesResponse struct {
	Model string \`json:"model"\`
}
`,
  'content_generation.go': `
type CreateContentGenerationContentItem struct {
	Type string  \`json:"type"\`
	Text *string \`json:"text,omitempty"\`
}
type ExtraBody map[string]interface{}
type CreateContentGenerationTaskRequest struct {
	Model      string                                \`json:"model"\`
	Content    []*CreateContentGenerationContentItem \`json:"content"\`
	Resolution *string                               \`json:"resolution,omitempty"\`
	ExtraBody  \`json:"-"\`
}
type CreateContentGenerationTaskResponse struct {
	ID string \`json:"id"\`
}
type GetContentGenerationTaskResponse struct {
	ID      string  \`json:"id"\`
	Status  string  \`json:"status"\`
	Content Content \`json:"content"\`
}
type Content struct {
	VideoURL string \`json:"video_url"\`
}
`,
  'common.go': `
type Usage struct {
	PromptTokens int \`json:"prompt_tokens"\`
	TotalTokens  int \`json:"total_tokens"\`
}
`,
}

/** Serve the Go fixtures (or fail them) for the duration of `run`. */
async function withGoSdk<T>(
  mode: 'ok' | 'unreachable',
  run: () => Promise<T>,
): Promise<{
  result: T
  urls: Array<string>
  authorizations: Array<string | null>
}> {
  const original = globalThis.fetch
  const urls: Array<string> = []
  const authorizations: Array<string | null> = []
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const href = String(url)
    urls.push(href)
    authorizations.push(new Headers(init?.headers).get('Authorization'))
    if (mode === 'unreachable') return Promise.reject(new Error('network down'))
    const file = Object.keys(GO_FIXTURES).find((f) => href.endsWith(f))
    return Promise.resolve(
      file
        ? new Response(GO_FIXTURES[file])
        : new Response('not found', { status: 404 }),
    )
  }) as typeof fetch
  try {
    return { result: await run(), urls, authorizations }
  } finally {
    globalThis.fetch = original
  }
}

describe('byteplus spec generated from the Go SDK', () => {
  it('classifies and bundles the generation endpoints without warnings', async () => {
    const {
      result: fetched,
      urls,
      authorizations,
    } = await withGoSdk('ok', () => byteplusProvider.fetchSpec({}))
    // All four model files come from the SDK's default branch.
    expect(urls).toHaveLength(4)
    for (const url of urls) {
      expect(url).toMatch(
        /^https:\/\/raw\.githubusercontent\.com\/byteplus-sdk\/byteplus-go-sdk-v2\/main\/service\/arkruntime\/model\/\w+\.go$/,
      )
    }
    expect(fetched.warnings ?? []).toEqual([])
    expect(fetched.specs).toHaveLength(2)
    // Ark is provenanced to the SDK; Seed Speech stays on the docs URL.
    expect(fetched.sources[0]?.url).toBe(
      'https://github.com/byteplus-sdk/byteplus-go-sdk-v2/tree/main/service/arkruntime/model',
    )
    expect(fetched.sources[1]?.url).toMatch(/^https:\/\/docs\.byteplus\.com\//)
    expect(authorizations).toEqual([null, null, null, null])
    for (const source of fetched.sources) {
      expect(source.hash).toMatch(/^[0-9a-f]{64}$/)
    }

    const { endpoints, warnings } = classifyAndBundle(byteplusProvider, fetched)
    expect(warnings).toEqual([])
    expect(
      endpoints
        .map((e): [string, string] => [e.dbId, e.activity])
        .sort(([aId, aAct], [bId, bAct]) =>
          aId < bId
            ? -1
            : aId > bId
              ? 1
              : aAct < bAct
                ? -1
                : aAct > bAct
                  ? 1
                  : 0,
        ),
    ).toEqual([
      ['byteplus/auc/bigmodel/recognize/flash', 'audio'],
      ['byteplus/chat/completions', 'chat'],
      ['byteplus/contents/generations/tasks', 'video'],
      ['byteplus/contents/generations/tasks/{id}', 'video'],
      ['byteplus/images/generations', 'image'],
      ['byteplus/tts/create', 'audio'],
    ])

    for (const endpoint of endpoints) {
      expect(endpoint.input, endpoint.dbId).toBeDefined()
      expect(endpoint.output, endpoint.dbId).toBeDefined()
      if (endpoint.input) expect(findDanglingRefs(endpoint.input)).toEqual([])
      if (endpoint.output) expect(findDanglingRefs(endpoint.output)).toEqual([])
    }

    const chat = endpoints.find((e) => e.dbId === 'byteplus/chat/completions')
    expect(chat?.input?.required).toEqual(['model', 'messages'])
    const video = endpoints.find(
      (e) => e.dbId === 'byteplus/contents/generations/tasks',
    )
    expect(video?.input?.required).toEqual(['model', 'content'])
    const task = endpoints.find(
      (e) => e.dbId === 'byteplus/contents/generations/tasks/{id}',
    )
    expect(task?.method).toBe('GET')
    expect(task?.input?.required).toEqual(['id'])
    const defs = task?.output?.$defs as
      | Record<string, { properties?: Record<string, unknown> }>
      | undefined
    expect(defs?.Content?.properties?.video_url).toMatchObject({
      type: 'string',
    })
  })

  it('re-applies curated fields and descriptions the SDK omits', async () => {
    const { result: fetched } = await withGoSdk('ok', () =>
      byteplusProvider.fetchSpec({}),
    )
    const { endpoints } = classifyAndBundle(byteplusProvider, fetched)
    const chat = endpoints.find((e) => e.dbId === 'byteplus/chat/completions')
    const props = chat?.input?.properties as Record<
      string,
      Record<string, unknown>
    >
    // Present in the fixture, so straight from the SDK.
    expect(props.thinking).toBeDefined()
    // Absent from the SDK entirely — restored from the curated list.
    expect(props.reasoning_effort).toMatchObject({ type: 'string' })
    expect(props.top_k).toMatchObject({ type: 'integer' })
    expect(props.seed).toMatchObject({ type: 'integer' })
    // Curated prose beats the (here absent) Go doc comment.
    expect(String(props.model?.description)).toContain('Ark model id')

    const image = endpoints.find(
      (e) => e.dbId === 'byteplus/images/generations',
    )
    const imageProps = image?.input?.properties as Record<
      string,
      Record<string, unknown>
    >
    expect(String(imageProps.watermark?.description)).toContain(
      'DEFAULTS TO TRUE',
    )
  })

  it('falls back to the embedded document when the SDK is unreachable', async () => {
    const { result: fetched } = await withGoSdk('unreachable', () =>
      byteplusProvider.fetchSpec({}),
    )
    expect(fetched.specs).toHaveLength(2)
    expect(fetched.sources[0]?.url).toMatch(/^https:\/\/docs\.byteplus\.com\//)
    expect(fetched.warnings?.[0]).toContain('served the embedded Ark document')

    // Degraded freshness, not a degraded service: all five endpoints survive.
    const { endpoints, warnings } = classifyAndBundle(byteplusProvider, fetched)
    expect(warnings).toEqual([])
    expect(endpoints).toHaveLength(6)
  })

  it.each(['ok', 'unreachable'] as const)(
    'images schema (%s SDK) carries every request field the Seedream 5.0 pro card reads',
    async (mode) => {
      const { result: fetched } = await withGoSdk(mode, () =>
        byteplusProvider.fetchSpec({}),
      )
      const image = classifyAndBundle(byteplusProvider, fetched).endpoints.find(
        (e) => e.dbId === 'byteplus/images/generations',
      )
      const props = Object.keys(image?.input?.properties ?? {})
      const card = compileSeedreamProCard(
        {
          extraInput: 0.003,
          maxLowPixels: 2.61e6,
          lowLevel: '1.5K',
          low: 0.045,
          high: 0.09,
        },
        {
          url: BYTEPLUS_PRICING_URL,
          hash: 'a'.repeat(64),
          extractedAt: '2026-10-02T00:00:00Z',
        },
      )
      // The write gate refuses a card whose request param the schema lacks.
      expect(card && cardRequestParamsOk(card, new Set(props))).toBe(true)
    },
  )

  it('derives identical content hashes on every build (sync idempotence)', async () => {
    const { result: a } = await withGoSdk('ok', () =>
      byteplusProvider.fetchSpec({}),
    )
    const { result: b } = await withGoSdk('ok', () =>
      byteplusProvider.fetchSpec({}),
    )
    expect(a.sources.map((s) => s.hash)).toEqual(b.sources.map((s) => s.hash))
  })

  it('does not send GITHUB_TOKEN to raw.githubusercontent.com', async () => {
    const { urls, authorizations } = await withGoSdk('ok', () =>
      byteplusProvider.fetchSpec({ GITHUB_TOKEN: 'ghp_test' }),
    )
    expect(urls).toHaveLength(4)
    for (const url of urls) {
      expect(url.startsWith('https://raw.githubusercontent.com/')).toBe(true)
    }
    expect(authorizations).toEqual([null, null, null, null])
  })
})

/** Keyless listModels with each fixture page swapped by URL (`null`: 503). */
async function listWith(pages: Record<string, (() => string) | null>) {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string) => {
    const href = String(url)
    if (href in pages) {
      const page = pages[href]
      return Promise.resolve(
        page ? new Response(page()) : new Response('down', { status: 503 }),
      )
    }
    const doc = DOC_FIXTURES[href]
    if (doc) return Promise.resolve(new Response(doc()))
    throw new Error(`Unmocked native source in listWith: ${href}`)
  }) as typeof fetch
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    return await byteplusProvider.listModels({})
  } finally {
    globalThis.fetch = original
    warn.mockRestore()
  }
}

describe('byteplus pricing pages failing', () => {
  it('publishes billed-only Seedance cards when the tutorial is down', async () => {
    const { models } = await listWith({
      [BYTEPLUS_PRICING_URL]: pricingFixtureHtml,
      [BYTEPLUS_VIDEO_GUIDE_URL]: null,
      [BYTEPLUS_MODEL_LIST_URL]: modelListFixtureHtml,
    })
    const seedance = models.find((m) => m.rawId === 'seedance-1-0-pro-250528')
    expect(seedance?.pricing).toMatchObject({
      inputs: { completion_tokens: { bound: 'usage' } },
    })
    expect(seedance?.pricing).not.toMatchObject({
      inputs: { completion_tokens: { estimate: expect.anything() as object } },
    })
    expect(
      models.find((m) => m.rawId === 'seed-2-0-pro-260328')?.pricing,
    ).toBeTruthy()
  })

  it('throws when the pricing page loses a table, keeping stored cards', async () => {
    const withoutVideo = () =>
      routerHtml(
        pricingDoc(
          PRICING_TABLES.filter((table) => table.rows[0]?.[0] !== 'Model'),
        ),
      )
    await expect(
      listWith({
        [BYTEPLUS_PRICING_URL]: withoutVideo,
        [BYTEPLUS_VIDEO_GUIDE_URL]: guideFixtureHtml,
        [BYTEPLUS_MODEL_LIST_URL]: modelListFixtureHtml,
      }),
    ).rejects.toThrow(/video\): parsed 0/)
  })
})

describe('byteplus ids the pricing page no longer names (#646)', () => {
  // 2026-11-12: the page dropped its "Retiring models" tables. Eight listed
  // ids (seed-1-8-251228, glm-4-7-251222, …) are named nowhere on it.
  it('clears the price of an id the page does not name', async () => {
    const { models } = await listWith({})
    const row = (rawId: string) => models.find((m) => m.rawId === rawId)
    expect(row('seed-1-8-251228')?.pricing).toBeFalsy()
    expect(row('seed-1-8-251228')?.absent?.pricing).toBe('cleared')
    expect(row('glm-4-7-251222')?.absent?.pricing).toBe('cleared')
    // A priced row carries no reason.
    expect(row('seed-2-0-pro-260328')?.absent?.pricing).toBeUndefined()
  })

  it('keeps the stored card of an id the page names but no table prices', async () => {
    const unread = () =>
      routerHtml(
        pricingDoc([
          ...PRICING_TABLES,
          {
            tab: 'Standard',
            rows: [
              PRICING_TABLES[0]?.rows[0] ?? [],
              // A bracket this parser refuses, and an undated id.
              ['', 'seed-1-8-251228', 'Peak', '$1', '$1', '$1', '$1'],
              ['', 'glm-4-7', 'About 128', '$1', '$1', '$1', '$1'],
            ],
          },
        ]),
      )
    const { models } = await listWith({ [BYTEPLUS_PRICING_URL]: unread })
    for (const rawId of ['seed-1-8-251228', 'glm-4-7-251222']) {
      const row = models.find((m) => m.rawId === rawId)
      expect(row?.pricing).toBeFalsy()
      expect(row?.absent?.pricing).toBeUndefined()
    }
  })
})

/** The doc center's client-render shell on the first fetch, then `page`. */
function shellThen(page: () => string): () => string {
  const shell = readFileSync(
    new URL('./fixtures/byteplus-doc-shell.html.txt', import.meta.url),
    'utf8',
  )
  let served = false
  return () => {
    if (served) return page()
    served = true
    return shell
  }
}

describe('byteplus doc center shell', () => {
  it('refetches each pricing doc that first comes back as the shell', async () => {
    const { models } = await listWith({
      [BYTEPLUS_PRICING_URL]: shellThen(pricingFixtureHtml),
      [BYTEPLUS_VIDEO_GUIDE_URL]: shellThen(guideFixtureHtml),
      [BYTEPLUS_MODEL_LIST_URL]: shellThen(modelListFixtureHtml),
    })
    const priced = (rawId: string) =>
      models.find((m) => m.rawId === rawId)?.pricing
    expect(priced('seed-2-0-pro-260328')).toBeTruthy()
    expect(priced('seedance-1-0-pro-250528')).toMatchObject({
      inputs: {
        completion_tokens: {
          estimate: { source: { url: BYTEPLUS_VIDEO_GUIDE_URL } },
        },
      },
    })
    expect(priced('seedream-5-0-260128')).toMatchObject({
      inputs: { generated_images: { bound: 'usage' } },
    })
  })
})

describe('byteplus curated models (no ARK_API_KEY)', () => {
  it('lists the ported @tanstack/ai-byteplus catalog with metadata', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const doc = DOC_FIXTURES[String(url)]
      if (doc) return Promise.resolve(new Response(doc()))
      return original(url, init)
    }) as typeof fetch
    const { models, skipped, docsFailures } = await byteplusProvider
      .listModels({})
      .finally(() => {
        globalThis.fetch = original
      })
    // Keyless is a supported mode, not a skip: the embedded catalog stands
    // in, and the poll records the fallback so it is not a healthy poll.
    expect(skipped).toBeUndefined()
    // First, so a docs-page failure in the same poll does not hide it.
    // `failed` may be higher when a docs source also fails.
    expect(docsFailures?.failed).toBeGreaterThanOrEqual(1)
    expect(docsFailures?.first[0]).toEqual({
      source: 'https://ark.ap-southeast.bytepluses.com/api/v3/models',
      error: 'ARK_API_KEY is unset; serving the embedded catalog',
      elapsedMs: 0,
    })
    // 18 chat + 7 video + 5 image + 2 speech.
    expect(models).toHaveLength(32)
    expect(new Set(models.map((m) => m.rawId)).size).toBe(32)

    const byActivity = new Map<string, number>()
    for (const m of models) {
      expect(m.activity, m.rawId).toBeTruthy()
      byActivity.set(
        m.activity ?? '',
        (byActivity.get(m.activity ?? '') ?? 0) + 1,
      )
    }
    expect(byActivity.get('chat')).toBe(18)
    expect(byActivity.get('video')).toBe(7)
    expect(byActivity.get('image')).toBe(5)
    expect(byActivity.get('audio')).toBe(2)

    const seedance = models.find((m) => m.rawId === 'seedance-1-5-pro-251215')
    expect(seedance?.releasedAt).toBe(Date.parse('2025-12-15') / 1000)
    // Video and image rows from the pricing page become cards.
    const priced = (rawId: string) =>
      models.find((m) => m.rawId === rawId)?.pricing
    expect(priced('seedance-1-0-pro-250528')).toMatchObject({
      inputs: {
        completion_tokens: {
          bound: 'usage',
          estimate: { source: { url: BYTEPLUS_VIDEO_GUIDE_URL } },
        },
      },
    })
    expect(priced('seedream-4-5-251128')).toMatchObject({
      inputs: { generated_images: { bound: 'usage' } },
    })
    // Model list: seedream-5-0-260128 also supports the priced lite row.
    expect(priced('seedream-5-0-260128')).toMatchObject({
      inputs: { generated_images: { bound: 'usage' } },
    })
    // No speech table on the ModelArk pricing page.
    expect(priced('seed-asr')).toBeUndefined()
    expect(priced('seed-audio-1.0')).toBeUndefined()
    // Undated Seed Speech ids keep their poll-time firstSeenAt.
    const asr = models.find((m) => m.rawId === 'seed-asr')
    expect(asr?.releasedAt).toBeNull()

    const glm = models.find((m) => m.rawId === 'glm-5-2-260617')
    expect(glm?.contextWindow).toBe(1_024_000)
    expect(glm?.maxOutput).toBe(128_000)
  })
})

describe('ark task_type → activity', () => {
  it('prefers generation task types over the modality-input ones', () => {
    // Chat models that accept audio input carry SpeechToText alongside
    // TextGeneration; they are chat endpoints, not transcription ones.
    expect(
      arkTaskActivity([
        'TextGeneration',
        'VisualQuestionAnswering',
        'SpeechToText',
      ]),
    ).toBe('chat')
    expect(arkTaskActivity(['ImageToVideo', 'TextToVideo'])).toBe('video')
    expect(arkTaskActivity(['MultimodalToVideo', 'VideoEditing'])).toBe('video')
    expect(arkTaskActivity(['ImageToImage', 'TextToImage'])).toBe('image')
    expect(
      arkTaskActivity([
        'ImageEmbedding',
        'MultimodalEmbedding',
        'TextEmbedding',
      ]),
    ).toBe('embeddings')
    expect(arkTaskActivity(['SpeechToText'])).toBe('audio')
    // 3D-generation models report no task_type at all.
    expect(arkTaskActivity([])).toBeNull()
    expect(arkTaskActivity(undefined)).toBeNull()
    expect(arkTaskActivity(['SomethingNew'])).toBeNull()
  })
})

describe('byteplus live models (ARK_API_KEY set)', () => {
  // Verbatim rows from Ark's GET /models, captured 2026-08-12.
  const ARK_PAGE = {
    data: [
      {
        id: 'seed-2-0-lite-260428',
        name: 'seed-2-0-lite',
        created: 1_778_162_292,
        domain: 'VLM',
        task_type: [
          'TextGeneration',
          'VisualQuestionAnswering',
          'SpeechToText',
        ],
        modalities: {
          input_modalities: ['text', 'image', 'video', 'audio'],
          output_modalities: ['text'],
        },
        token_limits: {
          context_window: 262_144,
          max_output_token_length: 131_072,
          max_reasoning_token_length: 131_072,
        },
        features: {
          structured_outputs: { json_object: true, json_schema: true },
          tools: { function_calling: true },
        },
      },
      {
        id: 'kimi-k2-250905',
        name: 'kimi-k2',
        created: 1_757_927_317,
        status: 'Shutdown',
        domain: 'LLM',
        task_type: ['TextGeneration'],
        modalities: { input_modalities: ['text'], output_modalities: ['text'] },
        token_limits: {
          context_window: 262_144,
          max_output_token_length: 32_768,
        },
        features: {},
      },
      {
        id: 'hitem3d-2-0-251223',
        name: 'hitem3d-2-0',
        created: 1_774_855_941,
        domain: '3DGeneration',
        modalities: {},
        token_limits: {},
        features: {},
      },
    ],
  }

  function withStubbedFetch<T>(body: unknown, run: () => Promise<T>) {
    const original = globalThis.fetch
    const calls: Array<{ url: string; auth: string | null }> = []
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const href = String(url)
      calls.push({
        url: href,
        auth: new Headers(init?.headers).get('authorization'),
      })
      const doc = DOC_FIXTURES[href]
      if (doc) return Promise.resolve(new Response(doc()))
      if (!href.includes('/api/v3/models')) return original(url, init)
      return Promise.resolve(new Response(JSON.stringify(body)))
    }) as typeof fetch
    return run()
      .then((result) => ({ result, calls }))
      .finally(() => {
        globalThis.fetch = original
      })
  }

  it('maps live rows and sends the bearer key', async () => {
    const { result, calls } = await withStubbedFetch(ARK_PAGE, () =>
      byteplusProvider.listModels({ ARK_API_KEY: 'ark-test' }),
    )
    const ark = calls.find((call) => call.url.includes('/api/v3/models'))
    expect(ark?.url).toBe(
      'https://ark.ap-southeast.bytepluses.com/api/v3/models',
    )
    expect(ark?.auth).toBe('Bearer ark-test')

    const seed = result.models.find((m) => m.rawId === 'seed-2-0-lite-260428')
    expect(seed?.activity).toBe('chat')
    expect(seed?.displayName).toBe('seed-2-0-lite')
    expect(seed?.contextWindow).toBe(262_144)
    expect(seed?.maxOutput).toBe(131_072)
    // Upstream `created` beats the id-suffix fallback.
    expect(seed?.releasedAt).toBe(1_778_162_292)
    expect(seed?.modalities).toEqual({
      input: ['text', 'image', 'video', 'audio'],
      output: ['text'],
    })
    expect(seed?.deprecated).toBe(false)

    // Shutdown and Retiring both read as deprecated.
    expect(
      result.models.find((m) => m.rawId === 'kimi-k2-250905')?.deprecated,
    ).toBe(true)
    // 3D generation is outside our taxonomy.
    expect(
      result.models.find((m) => m.rawId === 'hitem3d-2-0-251223')?.activity,
    ).toBeNull()
  })

  it('projects chat features onto the shared string[] vocabulary', async () => {
    const { result } = await withStubbedFetch(ARK_PAGE, () =>
      byteplusProvider.listModels({ ARK_API_KEY: 'ark-test' }),
    )
    // Ark advertises json_schema here, but a real request 400s: the probe
    // verdict wins, so response_format stays and structured_outputs goes.
    expect(
      result.models.find((m) => m.rawId === 'seed-2-0-lite-260428')
        ?.capabilities,
    ).toEqual(['tools', 'tool_choice', 'reasoning', 'response_format'])
    // Every chat row, curated gap-fillers included, is a string[].
    for (const m of result.models.filter((row) => row.activity === 'chat')) {
      expect(Array.isArray(m.capabilities)).toBe(true)
    }
  })

  it('keeps json_object-only models off structured_outputs', () => {
    expect(
      arkChatCapabilities({
        id: 'glm-5-3-flash-260828',
        token_limits: { max_reasoning_token_length: 131_072 },
        features: {
          structured_outputs: { json_object: true, json_schema: false },
          tools: { function_calling: true },
          cache: { prefix_cache: true, session_cache: true },
        },
      }),
    ).toEqual(['tools', 'tool_choice', 'reasoning', 'response_format'])
  })

  it.each([
    ['an empty data array', { data: [] }],
    ['no data field', {}],
    ['a null body', null],
    ['data that is not an array', { data: { id: 'seed-2-0-lite-260428' } }],
  ])(
    'throws when Ark returns %s, so the poll keeps the stored rows',
    async (_label, body) => {
      await expect(
        withStubbedFetch(body, () =>
          byteplusProvider.listModels({ ARK_API_KEY: 'ark-test' }),
        ),
      ).rejects.toThrow(/returned no models; refusing the embedded catalog/)
    },
  )

  it('fills the gaps the listing omits from the curated catalog', async () => {
    const { result } = await withStubbedFetch(ARK_PAGE, () =>
      byteplusProvider.listModels({ ARK_API_KEY: 'ark-test' }),
    )
    const ids = result.models.map((m) => m.rawId)
    expect(new Set(ids).size).toBe(ids.length)
    // Seed Speech lives on another host and is in no Ark listing.
    expect(ids).toContain('seed-audio-1.0')
    expect(ids).toContain('seed-asr')
    // Served by Ark but absent from its own listing.
    expect(ids).toContain('seedream-5-0-lite-260128')
    // A live row must not be duplicated by its curated twin.
    expect(ids.filter((id) => id === 'seed-2-0-lite-260428')).toHaveLength(1)
  })
})

describe('byteplus schema provenance', () => {
  it('grades each endpoint by how its schema was arrived at', async () => {
    const { result: fetched } = await withGoSdk('ok', () =>
      byteplusProvider.fetchSpec({}),
    )
    const { endpoints } = classifyAndBundle(byteplusProvider, fetched)
    const by = new Map(
      endpoints.map((e) => [e.dbId, [e.derivation, e.verifiedAt] as const]),
    )
    // Ark is re-derived from the Go SDK every sync, so it self-heals and
    // carries no point-in-time claim.
    expect(by.get('byteplus/chat/completions')).toEqual(['generated', null])
    expect(by.get('byteplus/images/generations')).toEqual(['generated', null])
    expect(by.get('byteplus/contents/generations/tasks')).toEqual([
      'generated',
      null,
    ])
    // Seed Speech is hand-written: TTS was exercised live, ASR never was.
    expect(by.get('byteplus/tts/create')).toEqual([
      'probe-verified',
      '2026-08-12',
    ])
    expect(by.get('byteplus/auc/bigmodel/recognize/flash')).toEqual([
      'docs-derived',
      null,
    ])
  })

  it('downgrades Ark to a dated claim when it falls back to the embedded doc', async () => {
    const { result: fetched } = await withGoSdk('unreachable', () =>
      byteplusProvider.fetchSpec({}),
    )
    const { endpoints } = classifyAndBundle(byteplusProvider, fetched)
    const chat = endpoints.find((e) => e.dbId === 'byteplus/chat/completions')
    // No longer self-healing, and it says so.
    expect(chat?.derivation).toBe('probe-verified')
    expect(chat?.verifiedAt).toBe('2026-07-31')
  })
})
