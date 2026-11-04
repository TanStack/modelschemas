import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  MISTRAL_WEBSEARCH_GUIDE,
  mistralModelPage,
  tip,
} from '../fixtures/mistral-model-page.ts'
import { provider } from './mistral.ts'
import { MISTRAL_DEPRECATIONS_URL } from '../deprecations.ts'

const MODELS_PAGE = readFileSync(
  new URL('../fixtures/mistral-models.md.txt', import.meta.url),
  'utf8',
)

describe('mistral classify', () => {
  it('maps generation paths to the claimed activities', () => {
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/fim/completions', {})).toBe('chat')
    expect(provider.classify('/v1/agents/completions', {})).toBe('chat')
    expect(provider.classify('/v1/embeddings', {})).toBe('embeddings')
    expect(provider.classify('/v1/moderations', {})).toBe('moderation')
    expect(provider.classify('/v1/chat/moderations', {})).toBe('moderation')
    expect(provider.classify('/v1/audio/transcriptions', {})).toBe('audio')
    expect(provider.classify('/v1/audio/transcriptions#stream', {})).toBe(
      'audio',
    )
    expect(provider.classify('/v1/audio/speech', {})).toBe('audio')
  })

  it('drops platform, admin, files, fine-tune, batch, and classifiers that are not moderation', () => {
    expect(provider.classify('/v1/files', {})).toBeNull()
    expect(
      provider.classify('/v1/fine_tuning/models/{model_id}', {}),
    ).toBeNull()
    expect(provider.classify('/v1/batch/jobs', {})).toBeNull()
    expect(provider.classify('/v1/admin/users', {})).toBeNull()
    expect(provider.classify('/v1/agents', {})).toBeNull()
    expect(provider.classify('/v1/conversations', {})).toBeNull()
    expect(provider.classify('/v1/ocr', {})).toBeNull()
    expect(provider.classify('/v1/classifications', {})).toBeNull()
    expect(provider.classify('/v1/chat/classifications', {})).toBeNull()
    expect(provider.classify('/v1/models', {})).toBeNull()
  })
})

describe('mistral listModels', () => {
  it('skips with an empty catalog when MISTRAL_API_KEY is absent', async () => {
    const { models, skipped } = await provider.listModels({})
    expect(models).toEqual([])
    expect(skipped).toBe('mistral: MISTRAL_API_KEY not set — skipped')
  })

  it('maps live rows and sends the bearer key', async () => {
    const original = globalThis.fetch
    const calls: Array<{ url: string; auth: string | null }> = []
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const href = String(url)
      calls.push({
        url: href,
        auth: new Headers(init?.headers).get('authorization'),
      })
      if (href === MISTRAL_DEPRECATIONS_URL) {
        return Promise.resolve(new Response(MODELS_PAGE))
      }
      // Docs stay off the network. A live pricing table plus one page
      // per slug blows the 5s test limit once missing ids pull markdown.
      if (!href.startsWith('https://api.mistral.ai/')) {
        return Promise.resolve(new Response('not found', { status: 404 }))
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'mistral-small-latest', created: 1_700_000_000 },
              { id: 'mistral-embed' },
            ],
          }),
        ),
      )
    }) as typeof fetch
    try {
      const { models, skipped, deprecations } = await provider.listModels({
        MISTRAL_API_KEY: 'mistral-test',
      })
      expect(skipped).toBeUndefined()
      expect(
        deprecations?.find((entry) => entry.rawId === 'pixtral-12b-2409')
          ?.replacedBy,
      ).toEqual(['ministral-14b-2512'])
      expect(calls[0]?.url).toBe('https://api.mistral.ai/v1/models')
      expect(calls[0]?.auth).toBe('Bearer mistral-test')
      expect(
        models.map(
          ({
            pricing: _pricing,
            factSources: _sources,
            reasoning: _reasoning,
            modalities: _modalities,
            serverTools: _tools,
            maxOutput: _maxOutput,
            requestMap: _requestMap,
            absent: _absent,
            ...rest
          }) => rest,
        ),
      ).toEqual([
        {
          rawId: 'mistral-small-latest',
          releasedAt: 1_700_000_000,
          activity: null,
        },
        { rawId: 'mistral-embed', releasedAt: null, activity: 'embeddings' },
      ])
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('mistral listModels modalities', () => {
  it('puts the modalities a model page states on the rows it names', async () => {
    const pages: Record<string, string> = {
      'https://api.mistral.ai/v1/models': JSON.stringify({
        data: [
          {
            id: 'mistral-small-latest',
            capabilities: { completion_chat: true },
            aliases: ['mistral-vibe-cli-fast'],
          },
          {
            id: 'mistral-vibe-cli-fast',
            capabilities: { completion_chat: true },
            aliases: ['mistral-small-latest'],
          },
          { id: 'mistral-unpriced', capabilities: { completion_chat: true } },
        ],
      }),
      'https://docs.mistral.ai/inference/pricing': `<h2>Flagship models</h2>
<p>Prices /M Tokens</p>
<table>
<tr><td><a href="/models/mistral-small-4-0-26-03">Small</a></td><td>$0.1</td><td>—</td><td>$0.3</td></tr>
</table>`,
      'https://docs.mistral.ai/resources/changelogs': '',
      'https://docs.mistral.ai/studio/agents/agent-tools/websearch.md':
        MISTRAL_WEBSEARCH_GUIDE,
      'https://docs.mistral.ai/models/mistral-small-4-0-26-03':
        mistralModelPage(
          ['mistral-small-2603', 'mistral-small-latest'],
          [
            [
              tip('Text input'),
              tip('Image input'),
              tip('Reasoning output'),
              tip('Text output'),
            ],
          ],
        ),
      'https://docs.mistral.ai/studio/conversations/reasoning.md':
        '- `mistral-small-latest`: Supports adjustable reasoning via the `reasoning_effort` parameter.',
      'https://docs.mistral.ai/models':
        '<a href="/models/not-a-listed-id">x</a>',
      'https://docs.mistral.ai/models.md':
        '| [Nope](/models/not-a-listed-id) | `not-a-listed-id` | GA |',
      'https://docs.mistral.ai/openapi.yaml': `components:
  schemas:
    ChatCompletionRequest:
      additionalProperties: false
      properties:
        max_tokens: { type: integer }
        reasoning_effort: { type: string }
        messages:
          items:
            discriminator:
              propertyName: role
              mapping:
                system: '#/components/schemas/SystemMessage'
                user: '#/components/schemas/UserMessage'
                assistant: '#/components/schemas/AssistantMessage'
                tool: '#/components/schemas/ToolMessage'
`,
    }
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      const body = pages[String(url)]
      return Promise.resolve(
        body === undefined
          ? new Response('not found', { status: 404 })
          : new Response(body),
      )
    }) as typeof fetch
    try {
      const { models } = await provider.listModels({ MISTRAL_API_KEY: 'k' })
      const [small, vibe, unpriced] = models
      expect(small?.modalities).toEqual({
        input: ['text', 'image'],
        output: ['text'],
      })
      expect(small?.factSources?.modalities).toMatchObject({
        derivation: 'docs-derived',
        sourceUrl: 'https://docs.mistral.ai/models/mistral-small-4-0-26-03',
        path: 'modalities',
      })
      expect(small?.pricing).toBeTruthy()
      expect(small?.requestMap).toMatchObject({
        maxTokensField: 'max_tokens',
        developerRole: false,
        reasoningEffort: true,
        thinking: { on: { reasoning_effort: 'high' }, off: null, levels: null },
      })
      expect(small?.factSources?.requestMap).toMatchObject({
        derivation: 'docs-derived',
        sourceUrl: 'https://docs.mistral.ai/openapi.yaml',
      })
      // The page names only small-latest. The listing says vibe is that model.
      expect(vibe?.modalities).toEqual(small?.modalities)
      expect(vibe?.pricing).toEqual(small?.pricing)
      expect(vibe?.factSources?.modalities?.sourceUrl).toBe(
        'https://docs.mistral.ai/models/mistral-small-4-0-26-03',
      )
      // No page names this id: unknown, not a guess, and not a cleared price.
      expect(unpriced?.modalities).toBeUndefined()
      expect(unpriced?.factSources?.modalities).toBeUndefined()
      expect(unpriced?.absent).toBeUndefined()
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('mistral listModels docs failures', () => {
  it('keeps stored facts and reports the pages when the docs 404', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      const href = String(url)
      if (href === 'https://api.mistral.ai/v1/models') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'mistral-small-latest',
                  capabilities: { completion_chat: true },
                },
              ],
            }),
          ),
        )
      }
      if (href === 'https://docs.mistral.ai/openapi.yaml') {
        return Promise.resolve(
          new Response(`components:
  schemas:
    ChatCompletionRequest:
      properties:
        max_tokens: { type: integer }
`),
        )
      }
      return Promise.resolve(new Response('not found', { status: 404 }))
    }) as typeof fetch
    try {
      const { models, docsFailures } = await provider.listModels({
        MISTRAL_API_KEY: 'k',
      })
      expect(models.map((model) => model.rawId)).toEqual([
        'mistral-small-latest',
      ])
      expect(models[0]?.absent).toMatchObject({
        pricing: 'unavailable',
        serverTools: 'unavailable',
        modalities: 'unavailable',
        maxOutput: 'unavailable',
        reasoning: 'unavailable',
        requestMap: 'unavailable',
      })
      expect(models[0]?.requestMap).toBeUndefined()
      expect(docsFailures?.first.map((failure) => failure.source)).toEqual(
        expect.arrayContaining([
          'https://docs.mistral.ai/inference/pricing',
          'https://docs.mistral.ai/studio/conversations/reasoning.md',
        ]),
      )
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('mistral fetchSpec', () => {
  it('loads the public OpenAPI document without a key', async () => {
    const fixture = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Mistral AI API', version: '1.0.0' },
      paths: {
        '/v1/chat/completions': { post: { summary: 'Chat Completion' } },
      },
    })
    const original = globalThis.fetch
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      return Promise.resolve(new Response(fixture))
    }) as typeof fetch
    try {
      const fetched = await provider.fetchSpec({})
      expect(urls).toEqual(['https://docs.mistral.ai/openapi.yaml'])
      expect(fetched.outputStrategy).toBe('post-200')
      expect(fetched.specs).toHaveLength(1)
      expect(fetched.specs[0]?.info?.title).toBe('Mistral AI API')
      expect(fetched.sources[0]?.url).toBe(
        'https://docs.mistral.ai/openapi.yaml',
      )
      expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('mistral provider metadata', () => {
  it('exports the seed fields required for auto-registration', () => {
    expect(provider.id).toBe('mistral')
    expect(provider.displayName).toBe('Mistral')
    expect(provider.authEnvVar).toBe('MISTRAL_API_KEY')
    expect(provider.defaultDerivation).toBe('upstream-spec')
    expect(provider.specSourceUrl).toBe('https://docs.mistral.ai/openapi.yaml')
    expect(provider.modelsEndpoint).toBe('https://api.mistral.ai/v1/models')
  })
})
