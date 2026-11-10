import { describe, expect, it } from 'vitest'

import { classifyAndBundle } from '#/server/ingest/sync.ts'
import listing from '../fixtures/replicate-models.json'
import openapi from '../fixtures/replicate-openapi.json'
import type { OpenApiDocument } from '../types.ts'
import {
  provider,
  replicateChatFacts,
  replicateModelSpec,
} from './replicate.ts'
import type { ReplicateModel } from './replicate.ts'

// Rows of GET https://api.replicate.com/v1/models, trimmed to the fields read.
const MODELS: Array<ReplicateModel> = listing
const SPEC: OpenApiDocument = openapi

function model(rawId: string): ReplicateModel {
  const found = MODELS.find((row) => `${row.owner}/${row.name}` === rawId)
  if (!found) throw new Error(`fixture has no ${rawId}`)
  return structuredClone(found)
}

function inputProperties(row: ReplicateModel): Record<string, unknown> {
  const schemas = row.latest_version?.openapi_schema?.components?.schemas as {
    Input: { properties: Record<string, unknown> }
  }
  return schemas.Input.properties
}

const INPUT = '/latest_version/openapi_schema/components/schemas/Input'

describe('replicate classify', () => {
  it('maps generation creates onto chat, image, video, and audio', () => {
    expect(
      provider.classify(
        '/models/meta/meta-llama-3-70b-instruct/predictions',
        {},
      ),
    ).toBe('chat')
    expect(
      provider.classify(
        '/v1/models/meta/llama-3.1-405b-instruct/predictions',
        {},
      ),
    ).toBe('chat')
    expect(provider.classify('/predictions', {})).toBe('image')
    expect(provider.classify('/v1/predictions', {})).toBe('image')
    expect(
      provider.classify(
        '/models/black-forest-labs/flux-schnell/predictions',
        {},
      ),
    ).toBe('image')
    expect(provider.classify('/models/minimax/video-01/predictions', {})).toBe(
      'video',
    )
    expect(provider.classify('/models/openai/whisper/predictions', {})).toBe(
      'audio',
    )
  })

  it('drops account, collections, hardware, trainings, and cancel', () => {
    expect(provider.classify('/account', {})).toBeNull()
    expect(provider.classify('/collections', {})).toBeNull()
    expect(provider.classify('/hardware', {})).toBeNull()
    expect(provider.classify('/models', {})).toBeNull()
    expect(
      provider.classify(
        '/models/{model_owner}/{model_name}/versions/{version_id}/trainings',
        {},
      ),
    ).toBeNull()
    expect(
      provider.classify('/predictions/{prediction_id}/cancel', {}),
    ).toBeNull()
    expect(
      provider.classify(
        '/deployments/{deployment_owner}/{deployment_name}/predictions',
        {},
      ),
    ).toBeNull()
  })
})

describe('replicate listModels', () => {
  it('skips when REPLICATE_API_TOKEN is absent', async () => {
    const result = await provider.listModels({})
    expect(result.skipped).toBe(
      'replicate: REPLICATE_API_TOKEN not set — skipped',
    )
    expect(result.models).toEqual([])
  })

  it('pages GET /v1/models and maps owner/name', async () => {
    const pages: Record<string, unknown> = {
      'https://api.replicate.com/v1/models': {
        next: 'https://api.replicate.com/v1/models?cursor=p2',
        results: [
          {
            owner: 'black-forest-labs',
            name: 'flux-schnell',
            description: 'Fast text-to-image',
            visibility: 'public',
            run_count: 26026,
            created_at: '2024-08-01T00:00:00Z',
            is_official: true,
          },
        ],
      },
      'https://api.replicate.com/v1/models?cursor=p2': {
        next: null,
        results: [
          {
            owner: 'openai',
            name: 'whisper',
            description: 'Speech-to-text',
            latest_version: { created_at: '2023-01-02T00:00:00Z' },
          },
        ],
      },
    }
    const original = globalThis.fetch
    const calls: Array<{ url: string; auth: string | null }> = []
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const href = String(url)
      calls.push({
        url: href,
        auth: new Headers(init?.headers).get('authorization'),
      })
      const body = pages[href]
      return Promise.resolve(
        body
          ? new Response(JSON.stringify(body))
          : new Response('not found', { status: 404 }),
      )
    }) as typeof fetch
    try {
      const result = await provider.listModels({
        REPLICATE_API_TOKEN: 'tok-test',
      })
      expect(calls.map((c) => c.url)).toEqual([
        'https://api.replicate.com/v1/models',
        'https://api.replicate.com/v1/models?cursor=p2',
        'https://replicate.com/black-forest-labs/flux-schnell',
      ])
      expect(calls[0]?.auth).toBe('Bearer tok-test')
      expect(result.skipped).toBeUndefined()
      expect(result.models.map((m) => [m.rawId, m.activity])).toEqual([
        ['black-forest-labs/flux-schnell', 'image'],
        ['openai/whisper', 'audio'],
      ])
      // run_count is usage telemetry; storing it made every poll a model.updated (#92).
      expect(result.models[0]?.providerMetadata).toEqual({
        visibility: 'public',
        official: true,
      })
      expect(result.models[0]?.releasedAt).toBe(
        Date.parse('2024-08-01T00:00:00Z') / 1000,
      )
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('replicate fetchSpec', () => {
  it('loads the public OpenAPI document', async () => {
    const spec: OpenApiDocument = {
      openapi: '3.1.0',
      paths: {
        '/predictions': {
          post: {
            summary: 'Create a prediction',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      version: { type: 'string' },
                      input: { type: 'object' },
                    },
                  },
                },
              },
            },
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { id: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
        '/account': { get: { summary: 'Get the current account' } },
      },
    }
    const original = globalThis.fetch
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      const body = String(url).endsWith('/openapi.json') ? spec : {}
      return Promise.resolve(new Response(JSON.stringify(body)))
    }) as typeof fetch
    try {
      // No token: skipped whole, never a sync with the model routes missing.
      const keyless = await provider.fetchSpec({})
      expect(keyless.skipped).toBe(
        'replicate: REPLICATE_API_TOKEN not set — skipped',
      )
      expect(urls).toEqual([])

      const fetched = await provider.fetchSpec({ REPLICATE_API_TOKEN: 'tok' })
      expect(urls).toEqual([
        'https://api.replicate.com/openapi.json',
        'https://api.replicate.com/v1/models',
      ])
      expect(fetched.outputStrategy).toBe('post-200')
      expect(fetched.skipped).toBeUndefined()
      expect(fetched.sources[0]?.url).toBe(
        'https://api.replicate.com/openapi.json',
      )
      expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)

      const { endpoints, warnings } = classifyAndBundle(provider, fetched)
      expect(warnings).toEqual([])
      expect(endpoints.map((e) => [e.dbId, e.activity])).toEqual([
        ['replicate/predictions', 'image'],
      ])
      expect(endpoints[0]?.derivation).toBe('upstream-spec')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('replicate seed metadata', () => {
  it('exports the adapter contract', () => {
    expect(provider.id).toBe('replicate')
    expect(provider.displayName).toBe('Replicate')
    expect(provider.authEnvVar).toBe('REPLICATE_API_TOKEN')
    expect(provider.defaultDerivation).toBe('upstream-spec')
    expect(provider.specSourceUrl).toBe(
      'https://api.replicate.com/openapi.json',
    )
    expect(provider.modelsEndpoint).toBe('https://api.replicate.com/v1/models')
  })
})

describe('replicate chat facts from a model schema', () => {
  it('reads a language model off its schema, not its name', () => {
    const chat = MODELS.filter((row) => replicateChatFacts(row) !== null)
    expect(chat.map((row) => `${row.owner}/${row.name}`).sort()).toEqual([
      'anthropic/claude-sonnet-5',
      'deepseek-ai/deepseek-v3.1',
      'google/gemini-3-flash',
      'ibm-granite/granite-4.1-8b',
      'meta/llama-4-maverick-instruct',
      'meta/llama-guard-4-12b',
      'openai/gpt-5.4',
      'prunaai/gpt-oss-120b-fast',
    ])
    // Returns an image URL, an embedding, and a trainer's text: not chat.
    expect(replicateChatFacts(model('alibaba/qwen-image-3'))).toBeNull()
    expect(
      replicateChatFacts(
        model('ibm-granite/granite-embedding-small-english-r2'),
      ),
    ).toBeNull()
    expect(replicateChatFacts(model('replicate/fast-flux-trainer'))).toBeNull()
  })

  it('fills flags, modalities, and the output cap with their source', () => {
    const facts = replicateChatFacts(model('meta/llama-4-maverick-instruct'))
    expect(facts?.capabilities).toEqual([
      'frequency_penalty',
      'max_tokens',
      'presence_penalty',
      'temperature',
      'top_k',
      'top_p',
    ])
    expect(facts?.modalities).toEqual({ input: ['text'], output: ['text'] })
    expect(facts?.reasoning).toBeUndefined()
    expect(facts?.schemaEndpointId).toBe(
      'models/meta/llama-4-maverick-instruct/predictions',
    )
    const sourceUrl =
      'https://api.replicate.com/v1/models/meta/llama-4-maverick-instruct'
    const guard = replicateChatFacts(model('meta/llama-guard-4-12b'))
    expect(guard?.maxOutput).toBe(1024)
    expect(guard?.factSources?.maxOutput).toEqual({
      derivation: 'listing',
      sourceUrl: 'https://api.replicate.com/v1/models/meta/llama-guard-4-12b',
      path: `${INPUT}/properties/max_completion_tokens/maximum`,
    })
    expect(facts?.factSources?.capabilities?.top_p).toEqual({
      derivation: 'listing',
      sourceUrl,
      path: `${INPUT}/properties/top_p`,
    })
    expect(facts?.factSources?.modalities?.sourceUrl).toBe(sourceUrl)
  })

  it('names one modality per file input', () => {
    expect(
      replicateChatFacts(model('google/gemini-3-flash'))?.modalities,
    ).toEqual({
      input: ['text', 'image', 'audio', 'video'],
      output: ['text'],
    })
    expect(replicateChatFacts(model('openai/gpt-5.4'))?.modalities).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    })
  })

  it('states no modalities when a file input does not say what it is', () => {
    const row = model('openai/gpt-5.4')
    const properties = inputProperties(row)
    properties.attachment = properties.image_input
    delete properties.image_input
    const facts = replicateChatFacts(row)
    expect(facts?.modalities).toBeUndefined()
    expect(facts?.factSources?.modalities).toBeUndefined()
  })

  it('reads an image input the description names, even without format uri', () => {
    // llama-guard `image_input: string[]`: "List of images to send".
    const guard = replicateChatFacts(model('meta/llama-guard-4-12b'))
    expect(guard?.modalities).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    })
    const undescribed = model('meta/llama-guard-4-12b')
    ;(
      inputProperties(undescribed).image_input as { description: string }
    ).description = 'Optional attachment'
    expect(replicateChatFacts(undescribed)?.modalities).toBeUndefined()
    // `max_image_resolution` (integer) and `video_fps` (number) are settings.
    expect(
      replicateChatFacts(model('anthropic/claude-sonnet-5'))?.modalities,
    ).toEqual({ input: ['text', 'image'], output: ['text'] })
  })

  it('reads the output cap the schema states, including one above 128k', () => {
    // Llama 4 states max_tokens.maximum 131072 as the output cap.
    const llama = replicateChatFacts(model('meta/llama-4-maverick-instruct'))
    expect(llama?.maxOutput).toBe(131072)
    expect(llama?.factSources?.maxOutput?.path).toBe(
      `${INPUT}/properties/max_tokens/maximum`,
    )
  })

  it('states no output cap without one stated maximum', () => {
    // gpt-5.4 caps nothing; granite has two token fields and no maximum.
    expect(replicateChatFacts(model('openai/gpt-5.4'))?.maxOutput).toBe(
      undefined,
    )
    expect(
      replicateChatFacts(model('ibm-granite/granite-4.1-8b'))?.maxOutput,
    ).toBeUndefined()

    const disagree = model('anthropic/claude-sonnet-5')
    inputProperties(disagree).max_completion_tokens = {
      type: 'integer',
      maximum: 4096,
    }
    expect(replicateChatFacts(disagree)?.maxOutput).toBeUndefined()

    const fractional = model('anthropic/claude-sonnet-5')
    inputProperties(fractional).max_tokens = { type: 'integer', maximum: 0.5 }
    expect(replicateChatFacts(fractional)?.maxOutput).toBeUndefined()
  })

  it('reads reasoning from an effort enum that accepts none', () => {
    const gpt = replicateChatFacts(model('openai/gpt-5.4'))
    expect(gpt?.reasoning).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    })
    expect(gpt?.factSources?.reasoning?.path).toBe(
      `${INPUT}/properties/reasoning_effort`,
    )
  })

  it('leaves mandatory unstated where none means unset, not off', () => {
    // `thinking_level` ["none","low","high"], default "none": "Thinking
    // level for reasoning (low or high)". The default is not a level.
    const gemini = replicateChatFacts(model('google/gemini-3-flash'))
    expect(gemini?.reasoning).toEqual({
      mode: 'effort',
      mandatory: null,
      efforts: ['low', 'high'],
    })
    expect(gemini?.factSources?.reasoning?.path).toBe(
      `${INPUT}/properties/thinking_level`,
    )
    // `thinking` ["medium","None"]: "leave as None for default behavior".
    const deepseek = replicateChatFacts(model('deepseek-ai/deepseek-v3.1'))
    expect(deepseek?.capabilities).toContain('reasoning')
    expect(deepseek?.reasoning).toEqual({
      mode: 'effort',
      mandatory: null,
      efforts: ['medium'],
    })
    expect(deepseek?.factSources?.reasoning?.path).toBe(
      `${INPUT}/properties/thinking`,
    )

    // A `none` that is not the default is a published value, still unstated.
    const explicit = model('google/gemini-3-flash')
    ;(inputProperties(explicit).thinking_level as { default: string }).default =
      'low'
    expect(replicateChatFacts(explicit)?.reasoning).toEqual({
      mode: 'effort',
      mandatory: null,
      efforts: ['none', 'low', 'high'],
    })
  })

  it('reads off from the description, and an own list with no off as mandatory', () => {
    // `effort` low…max: "'low' disables thinking for the fastest, cheapest
    // responses."
    const claude = replicateChatFacts(model('anthropic/claude-sonnet-5'))
    expect(claude?.capabilities).toContain('reasoning_effort')
    expect(claude?.reasoning).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
    expect(claude?.factSources?.reasoning?.path).toBe(
      `${INPUT}/properties/effort`,
    )

    const effort = (description: string) => {
      const row = model('anthropic/claude-sonnet-5')
      ;(inputProperties(row).effort as { description: string }).description =
        description
      return replicateChatFacts(row)?.reasoning
    }
    // Reworded, or naming a level the enum does not list: the own list has
    // no off value, so thinking cannot be turned off.
    expect(effort('How much thinking Claude does.')?.mandatory).toBe(true)
    expect(effort("'low' keeps thinking short.")?.mandatory).toBe(true)
    expect(effort("'none' disables thinking.")?.mandatory).toBe(true)
    expect(effort("Use 'low' to disable.")?.mandatory).toBe(false)

    // `reasoning_effort` without `none`: this model's only control.
    const gpt = model('openai/gpt-5.4')
    const schemas = gpt.latest_version?.openapi_schema?.components
      ?.schemas as Record<string, { enum?: Array<string> }>
    schemas.reasoning_effort!.enum = ['low', 'medium', 'high']
    expect(replicateChatFacts(gpt)?.reasoning).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['low', 'medium', 'high'],
    })

    const dangling = model('openai/gpt-5.4')
    delete (
      dangling.latest_version!.openapi_schema!.components!.schemas as Record<
        string,
        unknown
      >
    ).reasoning_effort
    expect(replicateChatFacts(dangling)?.reasoning).toBeUndefined()
  })

  it('reads a budget and a boolean switch from the model’s own fields', () => {
    const withFields = (fields: Record<string, unknown>) => {
      const row = model('meta/llama-4-maverick-instruct')
      Object.assign(inputProperties(row), fields)
      return replicateChatFacts(row)
    }
    // google/gemini-2.5-flash (2026-10-07).
    const BUDGET = {
      type: 'integer',
      title: 'Thinking Budget',
      maximum: 24576,
      minimum: 0,
      nullable: true,
      description:
        'Thinking budget for reasoning (0 to disable thinking, higher values allow more reasoning)',
    }
    const budget = withFields({ thinking_budget: BUDGET })
    expect(budget?.reasoning).toEqual({ mode: 'budget', mandatory: false })
    expect(budget?.factSources?.reasoning?.path).toBe(
      `${INPUT}/properties/thinking_budget`,
    )
    expect(
      withFields({
        thinking_budget: { ...BUDGET, description: 'Thinking budget.' },
      })?.reasoning,
    ).toEqual({ mode: 'budget', mandatory: null })
    expect(
      withFields({ thinking_budget: { ...BUDGET, type: 'string' } })?.reasoning,
    ).toBeUndefined()

    // prunaai/gemma-4-26b-a4b-fast (2026-10-07).
    const SWITCH = {
      type: 'boolean',
      title: 'Enable Thinking',
      default: false,
      description:
        'Enable thinking mode (model reasons internally before answering)',
    }
    const toggle = withFields({ enable_thinking: SWITCH })
    expect(toggle?.reasoning).toEqual({ mode: 'toggle', mandatory: false })
    expect(toggle?.factSources?.reasoning?.path).toBe(
      `${INPUT}/properties/enable_thinking`,
    )
    // Not a two-position switch: nothing is stored.
    for (const field of [
      { ...SWITCH, type: 'string' },
      { ...SWITCH, enum: [true] },
    ]) {
      const got = withFields({ enable_thinking: field })
      expect(got?.reasoning).toBeUndefined()
      expect(got?.factSources?.reasoning).toBeUndefined()
    }
    // Two level fields, or a `thinking` enum that is a switch: not read.
    const two = model('anthropic/claude-sonnet-5')
    inputProperties(two).thinking_level = inputProperties(two).effort
    expect(replicateChatFacts(two)?.reasoning).toBeUndefined()
    const switched = model('deepseek-ai/deepseek-v3.1')
    ;(
      switched.latest_version!.openapi_schema!.components!.schemas as Record<
        string,
        { enum?: Array<string> }
      >
    ).thinking!.enum = ['enabled', 'disabled']
    expect(replicateChatFacts(switched)?.reasoning).toBeUndefined()
  })

  it('binds a run route only for an official model', () => {
    const facts = replicateChatFacts(model('prunaai/gpt-oss-120b-fast'))
    expect(facts?.capabilities).toContain('max_tokens')
    expect(facts?.schemaEndpointId).toBeUndefined()
  })
})

describe('replicate per-model run routes', () => {
  function stubFetch(spec: OpenApiDocument): () => void {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      const body = String(url).endsWith('/openapi.json')
        ? spec
        : { next: null, results: MODELS }
      return Promise.resolve(new Response(JSON.stringify(body)))
    }) as typeof fetch
    return () => {
      globalThis.fetch = original
    }
  }

  it('syncs each official language model with its own input schema', async () => {
    const restore = stubFetch(SPEC)
    try {
      const fetched = await provider.fetchSpec({ REPLICATE_API_TOKEN: 'tok' })
      const { endpoints, warnings } = classifyAndBundle(provider, fetched)
      expect(warnings).toEqual([])
      expect(endpoints.map((e) => [e.dbId, e.activity])).toEqual([
        ['replicate/models/{model_owner}/{model_name}/predictions', 'image'],
        ['replicate/models/meta/llama-4-maverick-instruct/predictions', 'chat'],
        ['replicate/models/meta/llama-guard-4-12b/predictions', 'chat'],
        ['replicate/models/deepseek-ai/deepseek-v3.1/predictions', 'chat'],
        ['replicate/models/google/gemini-3-flash/predictions', 'chat'],
        ['replicate/models/openai/gpt-5.4/predictions', 'chat'],
        ['replicate/models/anthropic/claude-sonnet-5/predictions', 'chat'],
        ['replicate/models/ibm-granite/granite-4.1-8b/predictions', 'chat'],
      ])
      // Every route a chat row binds is synced.
      const synced = new Set(endpoints.map((e) => e.dbId))
      for (const row of MODELS) {
        const bound = replicateChatFacts(row)?.schemaEndpointId
        if (bound) expect(synced.has(`replicate/${bound}`)).toBe(true)
      }

      const gpt = endpoints.find((e) => e.dbId.includes('gpt-5.4'))
      expect(gpt?.source?.url).toBe(
        'https://api.replicate.com/v1/models/openai/gpt-5.4',
      )
      const input = gpt?.input as {
        required: Array<string>
        properties: Record<string, unknown>
        $defs: Record<string, { properties?: Record<string, unknown> }>
      }
      expect(input.required).toEqual(['input'])
      expect(Object.keys(input.properties)).toContain('webhook')
      expect(input.properties.input).toEqual({ $ref: '#/$defs/Input' })
      expect(Object.keys(input.$defs.Input?.properties ?? {})).toContain(
        'max_completion_tokens',
      )
      // gpt-5.4's schema is its own: no llama field leaks in.
      expect(input.$defs.Input?.properties).not.toHaveProperty('top_k')
      const output = gpt?.output as {
        properties: Record<string, unknown>
        $defs: Record<string, unknown>
      }
      expect(output.properties.output).toEqual({ $ref: '#/$defs/Output' })
      expect(output.$defs.Output).toMatchObject({ type: 'array' })
    } finally {
      restore()
    }
  })

  it('adds no route when the spec has no official run operation', async () => {
    const reworded = structuredClone(SPEC)
    const request = reworded.components?.schemas
      ?.schemas_prediction_request as {
      properties: Record<string, unknown>
    }
    delete request.properties.input
    expect(replicateModelSpec(reworded, model('openai/gpt-5.4'))).toBeNull()
    expect(replicateModelSpec({ paths: {} }, model('openai/gpt-5.4'))).toBe(
      null,
    )

    const restore = stubFetch(reworded)
    try {
      const fetched = await provider.fetchSpec({ REPLICATE_API_TOKEN: 'tok' })
      expect(fetched.specs).toHaveLength(1)
      expect(fetched.warnings).toContain(
        'replicate openai/gpt-5.4: no official run route in the spec',
      )
    } finally {
      restore()
    }
  })
})

describe('replicate catalog walk', () => {
  it('fails on a next link that leaves the models API', async () => {
    const original = globalThis.fetch
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            next: 'https://example.com/v1/models',
            results: [],
          }),
        ),
      )
    try {
      await expect(
        provider.listModels({ REPLICATE_API_TOKEN: 'tok' }),
      ).rejects.toThrow('unexpected catalog page url')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('replicate listModels chat rows', () => {
  it('classifies by schema and keeps the price source beside the facts', async () => {
    const page = `<script>{"billingConfig": {"current_tiers": [{"criteria": [], "prices": [{"metric": "token_input_count", "price": "$2.50", "title": "per million input tokens", "type": "per-unit"}, {"metric": "token_output_count", "price": "$0.015", "title": "per thousand output tokens", "type": "per-unit"}]}]}, "modelName": "x"}</script>`
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      const href = String(url)
      if (href.startsWith('https://api.replicate.com/')) {
        return Promise.resolve(
          new Response(JSON.stringify({ next: null, results: MODELS })),
        )
      }
      // One official page answers 200 with an error page.
      return Promise.resolve(
        new Response(
          href.endsWith('/claude-sonnet-5')
            ? '<html>Just a moment</html>'
            : page,
        ),
      )
    }) as typeof fetch
    try {
      const { models } = await provider.listModels({
        REPLICATE_API_TOKEN: 'tok',
      })
      const byId = new Map(models.map((m) => [m.rawId, m]))
      expect(byId.get('alibaba/qwen-image-3')?.activity).not.toBe('chat')
      expect(byId.get('alibaba/qwen-image-3')?.providerMetadata).toEqual({
        visibility: 'public',
        official: true,
      })
      const gpt = byId.get('openai/gpt-5.4')
      expect(gpt?.activity).toBe('chat')
      expect(gpt?.capabilities).toEqual(['max_tokens', 'reasoning_effort'])
      expect(gpt?.pricing).toMatchObject({
        tables: {
          rate: { base: { input_tokens: 2.5e-6, output_tokens: 1.5e-5 } },
        },
      })
      expect(gpt?.factSources?.pricing?.sourceUrl).toBe(
        'https://replicate.com/openai/gpt-5.4',
      )
      expect(gpt?.factSources?.reasoning?.derivation).toBe('listing')

      const errored = byId.get('anthropic/claude-sonnet-5')
      expect(errored?.activity).toBe('chat')
      expect(errored?.pricing).toBeUndefined()
      expect(errored?.maxOutput).toBe(64000)
      // Hardware-billed community model: no page fetch, no price.
      expect(byId.get('prunaai/gpt-oss-120b-fast')?.pricing).toBeUndefined()
    } finally {
      globalThis.fetch = original
    }
  })

  it('reads a context window and a missing output cap from the README', async () => {
    const readme = [
      '## Specs',
      '',
      '| | |',
      '|---|---|',
      '| **Context window** | 1,050,000 tokens |',
      '| **Max output tokens** | 128,000 |',
    ].join('\n')
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      const href = String(url)
      if (href.endsWith('/readme')) {
        return Promise.resolve(new Response(readme))
      }
      if (href.startsWith('https://api.replicate.com/')) {
        return Promise.resolve(
          new Response(JSON.stringify({ next: null, results: MODELS })),
        )
      }
      return Promise.resolve(new Response('<html>no billing</html>'))
    }) as typeof fetch
    try {
      const { models } = await provider.listModels({
        REPLICATE_API_TOKEN: 'tok',
      })
      const gpt = models.find((row) => row.rawId === 'openai/gpt-5.4')
      expect(gpt?.contextWindow).toBe(1_050_000)
      expect(gpt?.maxOutput).toBe(128_000)
      expect(gpt?.factSources?.contextWindow).toMatchObject({
        derivation: 'docs-derived',
        sourceUrl: 'https://api.replicate.com/v1/models/openai/gpt-5.4/readme',
        path: 'context window',
      })
      expect(gpt?.factSources?.maxOutput?.path).toBe('max output tokens')
      // The schema already states 64000. The README must not replace it.
      const claude = models.find(
        (row) => row.rawId === 'anthropic/claude-sonnet-5',
      )
      expect(claude?.maxOutput).toBe(64000)
      expect(claude?.factSources?.maxOutput?.derivation).toBe('listing')
    } finally {
      globalThis.fetch = original
    }
  })
})
