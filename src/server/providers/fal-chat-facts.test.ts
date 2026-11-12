import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  falChatFacts,
  falDescriptionContextWindow,
  falEndpointSpecUrl,
} from './fal-chat-facts.ts'
import { falProvider } from './fal.ts'
import chatModels from './fixtures/fal-chat-models.json'
import type { OpenApiDocument } from './types.ts'

const LISTING = 'https://api.fal.ai/v1/models'

interface Fixture {
  endpoint_id: string
  metadata: { category: string; description: string }
  openapi: OpenApiDocument
}

const fixtures = chatModels as unknown as Array<Fixture>

function fixture(rawId: string): Fixture {
  const found = fixtures.find((m) => m.endpoint_id === rawId)
  if (!found) throw new Error(`no fixture for ${rawId}`)
  return structuredClone(found)
}

function facts(model: Fixture) {
  return falChatFacts(
    {
      endpoint_id: model.endpoint_id,
      description: model.metadata.description,
      openapi: model.openapi,
    },
    LISTING,
  )
}

/** The request schema's properties, for mutating a fixture. */
function inputProperties(
  model: Fixture,
): Record<string, Record<string, unknown>> {
  const schemas = model.openapi.components?.schemas ?? {}
  const name = Object.keys(schemas).find((key) => key.endsWith('Input'))
  const schema = schemas[name ?? ''] as {
    properties: Record<string, Record<string, unknown>>
  }
  return schema.properties
}

describe('falChatFacts', () => {
  it('reads a model endpoint from its request schema and description', () => {
    const rawId = 'fal-ai/bytedance/seed/v2/mini'
    const got = facts(fixture(rawId))
    expect(got.contextWindow).toBe(256_000)
    expect(got.maxOutput).toBe(65_536)
    expect(got.modalities).toEqual({
      input: ['text', 'image', 'video'],
      output: ['text'],
    })
    expect(got.reasoning).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['minimal', 'low', 'medium', 'high'],
    })
    expect(got.capabilities).toEqual(
      expect.arrayContaining([
        'reasoning',
        'reasoning_effort',
        'max_tokens',
        'temperature',
        'top_p',
      ]),
    )
    expect(got.factSources?.contextWindow).toEqual({
      derivation: 'listing',
      sourceUrl: LISTING,
      path: 'metadata.description',
    })
    expect(got.factSources?.maxOutput).toEqual({
      derivation: 'upstream-spec',
      sourceUrl: falEndpointSpecUrl(LISTING, rawId),
      endpointId: rawId,
      path: '/properties/max_completion_tokens/maximum',
    })
    expect(got.factSources?.reasoning?.path).toBe(
      '/properties/reasoning_effort',
    )
    expect(got.factSources?.capabilities?.temperature?.sourceUrl).toBe(
      falEndpointSpecUrl(LISTING, rawId),
    )
    expect(got.requestMap).toEqual({
      thinking: {
        on: { thinking: 'enabled', reasoning_effort: 'high' },
        off: { thinking: 'disabled' },
        levels: {
          off: null,
          minimal: 'minimal',
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: null,
          max: null,
        },
      },
      maxTokensField: 'max_completion_tokens',
      developerRole: null,
      replayReasoningContent: null,
      store: null,
      strictTools: null,
      sessionAffinity: null,
      cacheControl: null,
      toolStream: null,
      reasoningEffort: true,
    })
    expect(got.factSources?.requestMap).toEqual({
      derivation: 'upstream-spec',
      sourceUrl: falEndpointSpecUrl(LISTING, rawId),
      endpointId: rawId,
      path: '/properties/max_completion_tokens',
    })
  })

  it('reads `max_tokens` and a single media field', () => {
    const got = facts(fixture('nvidia/nemotron-3-nano-omni/vision'))
    expect(got.maxOutput).toBe(20_000)
    expect(got.modalities).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    })
    // `reasoning_mode` is the endpoint's own think/no_think switch. The
    // schema walk knows no such field, so the flag list is unchanged.
    expect(got.reasoning).toEqual({ mode: 'toggle', mandatory: false })
    expect(got.factSources?.reasoning).toMatchObject({
      derivation: 'upstream-spec',
      endpointId: 'nvidia/nemotron-3-nano-omni/vision',
      path: '/properties/reasoning_mode',
    })
    expect(got.capabilities).toEqual(
      expect.arrayContaining(['max_tokens', 'temperature', 'top_p']),
    )
    expect(got.capabilities).not.toContain('reasoning')
    expect(got.contextWindow).toBeUndefined()
    expect(got.requestMap).toMatchObject({
      thinking: {
        on: { reasoning_mode: 'think' },
        off: { reasoning_mode: 'no_think' },
        levels: null,
      },
      maxTokensField: 'max_tokens',
      reasoningEffort: null,
    })
    expect(got.factSources?.requestMap?.path).toBe('/properties/max_tokens')
  })

  it('reads a spec whose path uses the app alias, not the endpoint id', () => {
    const model = fixture('nvidia/nemotron-3-nano-omni/vision')
    const aliased = Object.fromEntries(
      Object.entries(model.openapi.paths ?? {}).map(([path, operations]) => [
        path.replace('/nvidia/', '/fal-ai/'),
        operations,
      ]),
    )
    model.openapi.paths = aliased
    expect(facts(model).maxOutput).toBe(20_000)
    // Two POST paths: which one is the endpoint is not stated.
    model.openapi.paths = { ...aliased, '/other': { post: {} } }
    expect(facts(model)).toEqual({})
  })

  it('states no window, cap, or reasoning for a router', () => {
    const got = facts(fixture('openrouter/router/video'))
    expect(got.contextWindow).toBeUndefined()
    // `max_tokens` has no maximum: the cap is the routed model's.
    expect(got.maxOutput).toBeUndefined()
    expect(got.reasoning).toBeUndefined()
    expect(got.capabilities).not.toContain('reasoning')
    expect(got.capabilities).toEqual(
      expect.arrayContaining(['max_tokens', 'temperature']),
    )
    expect(got.modalities).toEqual({
      input: ['text', 'video'],
      output: ['text'],
    })
    // `reasoning: boolean` asks for the trace. It is not the thinking body.
    expect(got.requestMap).toMatchObject({
      thinking: null,
      maxTokensField: 'max_tokens',
      reasoningEffort: null,
    })
  })

  it('names no text input without a `prompt` field', () => {
    const got = facts(fixture('openrouter/router/decisions'))
    expect(got.modalities).toBeUndefined()
    expect(got.capabilities).toEqual([])
    expect(got.requestMap).toBeUndefined()
  })

  it('leaves an endpoint with an empty request schema untouched', () => {
    expect(
      facts(fixture('openrouter/router/openai/v1/chat/completions')),
    ).toEqual({})
    const model = fixture('fal-ai/bytedance/seed/v2/mini')
    expect(falChatFacts({ endpoint_id: model.endpoint_id }, LISTING)).toEqual(
      {},
    )
  })

  it('stores nothing when the schema is reworded', () => {
    const model = fixture('fal-ai/bytedance/seed/v2/mini')
    const properties = inputProperties(model)
    // The cap moves into prose, the toggle changes vocabulary.
    delete properties.max_completion_tokens?.maximum
    properties.thinking!.enum = ['on', 'off']
    model.metadata.description = 'Up to 256,000 tokens of context.'
    const got = facts(model)
    expect(got.maxOutput).toBeUndefined()
    expect(got.reasoning).toBeUndefined()
    expect(got.capabilities).not.toContain('reasoning')
    expect(got.contextWindow).toBeUndefined()
  })

  it('stores no toggle for a `reasoning_mode` it does not know', () => {
    for (const values of [
      ['think'],
      ['think', 'no_think', 'auto'],
      ['on', 'off'],
      [],
    ]) {
      const model = fixture('nvidia/nemotron-3-nano-omni/vision')
      inputProperties(model).reasoning_mode!.enum = values
      expect(facts(model).reasoning).toBeUndefined()
      expect(facts(model).factSources?.reasoning).toBeUndefined()
    }
    // A free-text field of that name is not a switch.
    const text = fixture('nvidia/nemotron-3-nano-omni/vision')
    delete inputProperties(text).reasoning_mode!.enum
    expect(facts(text).reasoning).toBeUndefined()
  })

  it('does not read a non-integer or unbounded cap', () => {
    const model = fixture('nvidia/nemotron-3-nano-omni/vision')
    inputProperties(model).max_tokens!.type = 'string'
    expect(facts(model).maxOutput).toBeUndefined()
    const other = fixture('nvidia/nemotron-3-nano-omni/vision')
    inputProperties(other).max_tokens!.maximum = '20000'
    expect(facts(other).maxOutput).toBeUndefined()
  })

  it('marks reasoning mandatory when it cannot be disabled', () => {
    const model = fixture('fal-ai/bytedance/seed/v2/mini')
    inputProperties(model).thinking!.enum = ['enabled', 'auto']
    expect(facts(model).reasoning?.mandatory).toBe(true)
  })
})

describe('falDescriptionContextWindow', () => {
  it('reads one stated size', () => {
    expect(falDescriptionContextWindow('video input with 256K context')).toBe(
      256_000,
    )
    expect(falDescriptionContextWindow('a 1M context model')).toBe(1_000_000)
  })

  it('refuses anything else', () => {
    for (const text of [
      undefined,
      '',
      'long-context reasoning model',
      'provide context to the model',
      'from 128K context to 256K context',
      '256K tokens',
      '256 context',
      'renders 4K video',
    ]) {
      expect(falDescriptionContextWindow(text), String(text)).toBeNull()
    }
  })
})

/** A Pricing section that names no dollar amount. Not a failed fetch. */
const NO_TOKEN_PRICE = `# Model

## Pricing

You will be charged based on the number of input and output tokens.

## API
`

const SEED_LLMS = `# Seed

## Pricing

Your request will cost **$0.0001** per 1000 units. For inputs under 128k tokens, the units per input token is 1. For inputs of over 128k tokens, 2 units will be charged per token. Similarly, each output token costs 4 units, provided the total output length (reasoning + output) is under 128k tokens, and 8 units per token otherwise.

For more details, see [fal.ai pricing](https://fal.ai/pricing).

## API
`

describe('fal listModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const image = {
    endpoint_id: 'fal-ai/flux/dev',
    metadata: { category: 'text-to-image' },
  }
  const listed = fixtures.map(({ endpoint_id, metadata }) => ({
    endpoint_id,
    metadata,
  }))

  function page(models: Array<unknown>): Response {
    return new Response(
      JSON.stringify({ models, has_more: false, next_cursor: null }),
    )
  }

  function endpointNotFound(): Response {
    return new Response(
      JSON.stringify({
        error: { type: 'not_found', message: 'Endpoint(s) not found' },
      }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    )
  }

  function respond(
    input: string,
    llms: (pathname: string) => string,
  ): Response {
    const url = new URL(input)
    if (url.hostname === 'fal.ai') return new Response(llms(url.pathname))
    return url.searchParams.has('endpoint_id')
      ? page(fixtures)
      : page([image, ...listed])
  }

  it('fills chat rows from one spec request by endpoint id', async () => {
    const urls: Array<URL> = []
    vi.stubGlobal('fetch', (input: string) => {
      const url = new URL(input)
      urls.push(url)
      return Promise.resolve(respond(input, () => NO_TOKEN_PRICE))
    })
    const { models } = await falProvider.listModels({ FAL_KEY: 'k' })
    // Listing, the chat spec page, one llms.txt per chat endpoint, then
    // the unlisted fal-ai/whisper lookup. The mock page has no whisper row.
    expect(urls).toHaveLength(3 + listed.length)
    expect(urls[0]?.searchParams.has('expand')).toBe(false)
    expect(urls[1]?.searchParams.get('expand')).toBe('openapi-3.0')
    expect(urls[1]?.searchParams.getAll('endpoint_id').sort()).toEqual(
      fixtures.map((m) => m.endpoint_id).sort(),
    )
    const whisperLookup = urls.find(
      (url) => url.searchParams.get('endpoint_id') === 'fal-ai/whisper',
    )
    expect(whisperLookup?.searchParams.get('expand')).toBe('openapi-3.0')
    expect(models.some((model) => model.rawId === 'fal-ai/whisper')).toBe(false)
    const byId = new Map(models.map((m) => [m.rawId, m]))
    expect(byId.get('fal-ai/flux/dev')).toMatchObject({
      activity: 'image',
      providerMetadata: { category: 'text-to-image' },
    })
    expect(byId.get('fal-ai/flux/dev')?.factSources).toBeUndefined()
    expect(byId.get('fal-ai/bytedance/seed/v2/mini')).toMatchObject({
      activity: 'chat',
      contextWindow: 256_000,
      maxOutput: 65_536,
    })
    expect(byId.get('fal-ai/bytedance/seed/v2/mini')?.pricing).toBeUndefined()
    expect(byId.get('openrouter/router/video')?.requestMap).toMatchObject({
      maxTokensField: 'max_tokens',
      thinking: null,
    })
    // No request schema: no flags. FAL's category is metadata on every row.
    const router = byId.get('openrouter/router/openai/v1/chat/completions')
    expect(router?.capabilities).toBeUndefined()
    expect(router?.providerMetadata).toEqual({ category: 'llm' })
  })

  it('stores a chat token card from that endpoint llms.txt', async () => {
    vi.stubGlobal('fetch', (input: string) =>
      Promise.resolve(
        respond(input, (pathname) =>
          pathname.includes('bytedance/seed/v2/mini')
            ? SEED_LLMS
            : NO_TOKEN_PRICE,
        ),
      ),
    )
    const { models } = await falProvider.listModels({ FAL_KEY: 'k' })
    const seed = models.find((m) => m.rawId === 'fal-ai/bytedance/seed/v2/mini')
    const rate = (
      seed!.pricing as {
        tables?: { rate?: { base?: Record<string, number> } }
      }
    ).tables?.rate?.base
    expect(rate).toEqual({
      input_tokens: 0.0001 / 1000,
      output_tokens: (0.0001 / 1000) * 4,
    })
    expect(seed?.factSources?.pricing).toMatchObject({
      derivation: 'docs-extracted',
      sourceUrl: 'https://fal.ai/models/fal-ai/bytedance/seed/v2/mini/llms.txt',
      path: 'Pricing',
    })
    expect(
      models.find((m) => m.rawId === 'openrouter/router/video')?.pricing,
    ).toBeUndefined()
  })

  it('lists every row and withholds chat facts when a chat spec is missing', async () => {
    vi.stubGlobal('fetch', (input: string) => {
      const url = new URL(input)
      if (url.hostname === 'fal.ai')
        return Promise.resolve(new Response(NO_TOKEN_PRICE))
      return Promise.resolve(
        url.searchParams.has('endpoint_id')
          ? page(fixtures.slice(1))
          : page([image, ...listed]),
      )
    })
    const result = await falProvider.listModels({ FAL_KEY: 'k' })
    expect(result.docsFailures?.first).toMatchObject([
      {
        source:
          'https://api.fal.ai/v1/models?expand=openapi-3.0 (chat endpoints)',
        error: expect.stringContaining(
          'fal chat specs: models API left out',
        ) as string,
      },
    ])
    expect(result.models).toHaveLength(listed.length + 1)
    for (const model of result.models) {
      if (model.activity === 'chat') {
        expect(model.absent).toEqual({
          contextWindow: 'unavailable',
          maxOutput: 'unavailable',
          modalities: 'unavailable',
          capabilities: 'unavailable',
          reasoning: 'unavailable',
          requestMap: 'unavailable',
        })
      } else {
        expect(model.absent).toBeUndefined()
      }
    }
  })

  it('indexes fal-ai/whisper from a direct lookup when the active search omits it', async () => {
    const whisper = {
      endpoint_id: 'fal-ai/whisper',
      metadata: null,
      retires_at: null,
      openapi: {
        openapi: '3.0.4',
        info: {
          title: 'Whisper',
          'x-fal-metadata': {
            category: 'speech-to-text',
            endpointId: 'fal-ai/whisper',
          },
        },
        paths: {
          '/': {
            post: {
              operationId: 'whisper',
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      },
    }
    vi.stubGlobal('fetch', (input: string) => {
      const url = new URL(input)
      if (url.hostname === 'fal.ai')
        return Promise.resolve(new Response(NO_TOKEN_PRICE))
      if (url.searchParams.get('endpoint_id') === 'fal-ai/whisper') {
        return Promise.resolve(page([whisper]))
      }
      return Promise.resolve(
        url.searchParams.has('endpoint_id')
          ? page(fixtures)
          : page([image, ...listed]),
      )
    })
    const { models } = await falProvider.listModels({ FAL_KEY: 'k' })
    expect(
      models.find((model) => model.rawId === 'fal-ai/whisper'),
    ).toMatchObject({
      activity: 'audio',
      deprecated: false,
      displayName: null,
      providerMetadata: { category: 'speech-to-text' },
    })
    expect(
      models.filter((model) => model.rawId === 'fal-ai/whisper'),
    ).toHaveLength(1)
  })

  it('skips fal-ai/whisper when the direct lookup 404s', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', (input: string) => {
      const url = new URL(input)
      if (url.hostname === 'fal.ai')
        return Promise.resolve(new Response(NO_TOKEN_PRICE))
      if (url.searchParams.get('endpoint_id') === 'fal-ai/whisper') {
        return Promise.resolve(endpointNotFound())
      }
      return Promise.resolve(
        url.searchParams.has('endpoint_id')
          ? page(fixtures)
          : page([image, ...listed]),
      )
    })
    const { models } = await falProvider.listModels({ FAL_KEY: 'k' })
    expect(models.some((model) => model.rawId === 'fal-ai/whisper')).toBe(false)
    expect(models).toHaveLength(listed.length + 1)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        'fal-ai/whisper: no longer served at https://api.fal.ai/v1/models?',
      ) as string,
    )
    const line = String(error.mock.calls[0]?.[0])
    expect(line).toContain('endpoint_id=fal-ai%2Fwhisper')
    expect(line).toContain('404 Endpoint(s) not found')
    error.mockRestore()
  })

  it('fails the poll when an unlisted lookup 404s for another reason', async () => {
    vi.stubGlobal('fetch', (input: string) => {
      const url = new URL(input)
      if (url.hostname === 'fal.ai')
        return Promise.resolve(new Response(NO_TOKEN_PRICE))
      if (url.searchParams.get('endpoint_id') === 'fal-ai/whisper') {
        return Promise.resolve(new Response('missing', { status: 404 }))
      }
      return Promise.resolve(
        url.searchParams.has('endpoint_id')
          ? page(fixtures)
          : page([image, ...listed]),
      )
    })
    await expect(falProvider.listModels({ FAL_KEY: 'k' })).rejects.toThrow(
      'fal models fetch failed: 404',
    )
  })

  it('omits a listed chat endpoint whose endpoint_id filter 404s', async () => {
    const goneId = 'fal-ai/video-prompt-generator'
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', (input: string) => {
      const url = new URL(input)
      if (url.hostname === 'fal.ai')
        return Promise.resolve(new Response(NO_TOKEN_PRICE))
      const ids = url.searchParams.getAll('endpoint_id')
      if (ids.includes(goneId)) return Promise.resolve(endpointNotFound())
      if (ids.length === 0) {
        return Promise.resolve(
          page([
            image,
            ...listed,
            { endpoint_id: goneId, metadata: { category: 'llm' } },
          ]),
        )
      }
      if (ids.length === 1 && ids[0] === 'fal-ai/whisper') {
        return Promise.resolve(page([]))
      }
      const wanted = new Set(ids)
      return Promise.resolve(
        page(fixtures.filter((model) => wanted.has(model.endpoint_id))),
      )
    })
    const result = await falProvider.listModels({ FAL_KEY: 'k' })
    expect(result.models.some((model) => model.rawId === goneId)).toBe(false)
    expect(result.models).toHaveLength(listed.length + 1)
    expect(result.docsFailures?.failed).toBe(0)
    expect(
      result.models.find(
        (model) => model.rawId === 'fal-ai/bytedance/seed/v2/mini',
      ),
    ).toMatchObject({ activity: 'chat', contextWindow: 256_000 })
    const line = error.mock.calls.map((call) => String(call[0])).join('\n')
    expect(line).toContain(
      `${goneId}: no longer served at https://api.fal.ai/v1/models?`,
    )
    expect(line).toContain('endpoint_id=fal-ai%2Fvideo-prompt-generator')
    expect(line).toContain('expand=openapi-3.0')
    expect(line).not.toContain('fal-ai/whisper')
    error.mockRestore()
  })

  it('keeps the rows when a filtered 404 is not Endpoint(s) not found', async () => {
    const goneId = 'fal-ai/video-prompt-generator'
    vi.stubGlobal('fetch', (input: string) => {
      const url = new URL(input)
      if (url.hostname === 'fal.ai')
        return Promise.resolve(new Response(NO_TOKEN_PRICE))
      const ids = url.searchParams.getAll('endpoint_id')
      if (ids.includes(goneId)) {
        return Promise.resolve(new Response('nope', { status: 404 }))
      }
      if (ids.length === 1 && ids[0] === 'fal-ai/whisper') {
        return Promise.resolve(page([]))
      }
      return Promise.resolve(
        ids.length === 0
          ? page([
              image,
              ...listed,
              { endpoint_id: goneId, metadata: { category: 'llm' } },
            ])
          : page(fixtures),
      )
    })
    const result = await falProvider.listModels({ FAL_KEY: 'k' })
    expect(result.models.some((model) => model.rawId === goneId)).toBe(true)
    expect(result.docsFailures?.first[0]?.error).toContain(
      'fal models fetch failed: 404',
    )
    expect(result.models).toHaveLength(listed.length + 2)
  })

  it('marks an unlisted endpoint deprecated once retires_at is past', async () => {
    vi.stubGlobal('fetch', (input: string) => {
      const url = new URL(input)
      if (url.hostname === 'fal.ai')
        return Promise.resolve(new Response(NO_TOKEN_PRICE))
      if (url.searchParams.get('endpoint_id') === 'fal-ai/whisper') {
        return Promise.resolve(
          page([
            {
              endpoint_id: 'fal-ai/whisper',
              metadata: null,
              retires_at: '2020-01-01T00:00:00.000Z',
              openapi: {
                info: { 'x-fal-metadata': { category: 'speech-to-text' } },
                paths: {
                  '/': {
                    post: {
                      responses: { '200': { description: 'ok' } },
                    },
                  },
                },
              },
            },
          ]),
        )
      }
      return Promise.resolve(
        url.searchParams.has('endpoint_id')
          ? page(fixtures)
          : page([image, ...listed]),
      )
    })
    const { models } = await falProvider.listModels({ FAL_KEY: 'k' })
    expect(
      models.find((model) => model.rawId === 'fal-ai/whisper'),
    ).toMatchObject({ activity: 'audio', deprecated: true })
  })

  it('fails the poll when the listing itself fails', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('denied', { status: 401 })),
    )
    await expect(falProvider.listModels({ FAL_KEY: 'k' })).rejects.toThrow()
  })
})
