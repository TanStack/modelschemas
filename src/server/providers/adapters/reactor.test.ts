import { describe, expect, it } from 'vitest'

import { findDanglingRefs } from '#/server/ingest/bundle.ts'
import { classifyAndBundle } from '#/server/ingest/sync.ts'

import {
  REACTOR_PRICING_URL,
  extractOpenApiFromHtml,
  modelApiPageUrl,
  provider,
  reactorPlatformOperations,
  sessionTokenRequestSchema,
} from './reactor.ts'

const MINI_SPEC = {
  openapi: '3.1.0',
  info: { title: 'helios', version: 'v1.0.1' },
  paths: {
    '/events/set_prompt': {
      post: {
        operationId: 'set_prompt',
        summary: 'Set the prompt',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['prompt'],
                properties: { prompt: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { prompt: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    '/events/start': {
      post: {
        operationId: 'start',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', properties: {} },
            },
          },
        },
        responses: { '202': { description: 'accepted' } },
      },
    },
  },
  components: { schemas: {} },
}

function htmlWithSpec(spec: unknown): string {
  const chunk = JSON.stringify(JSON.stringify(spec))
  return `<!doctype html><script>self.__next_f.push([1,${chunk}])</script>`
}

describe('extractOpenApiFromHtml', () => {
  it('reads the OpenAPI document out of a Next.js RSC string chunk', () => {
    const extracted = extractOpenApiFromHtml(htmlWithSpec(MINI_SPEC))
    expect(extracted?.info?.title).toBe('helios')
    expect(extracted?.paths?.['/events/set_prompt']?.post).toBeDefined()
  })

  it('returns null when the page has no spec chunk', () => {
    expect(extractOpenApiFromHtml('<html>nope</html>')).toBeNull()
  })
})

describe('reactor classify', () => {
  it('maps namespaced model command paths and drops platform', () => {
    expect(provider.classify('/reactor/helios', {})).toBe('video')
    expect(provider.classify('/reactor/helios/events/set_prompt', {})).toBe(
      'video',
    )
    expect(provider.classify('/x2/events/set_prompt', {})).toBe('video')
    expect(
      provider.classify('/reactor/happy-oyster-adventure/create_world', {}),
    ).toBe('video')
    expect(provider.classify('/tokens', {})).toBeNull()
    expect(provider.classify('/sessions', {})).toBeNull()
    expect(provider.classify('/pricing', {})).toBeNull()
  })
})

describe('reactor listModels', () => {
  it('does not skip when REACTOR_API_KEY is absent (GET /pricing is public)', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      expect(String(url)).toBe(REACTOR_PRICING_URL)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            models: [
              {
                id: 'helios-id',
                name: 'helios',
                rate: { amount_per_sec: 17, unit: 'credits' },
              },
              {
                name: 'x2',
                rate: {
                  amount_per_sec: 17,
                  amount_per_sec_usd: '0.0017',
                  currency_code: 'USD',
                  unit: 'credits',
                },
              },
              { name: 'happy-oyster' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
    }) as typeof fetch
    try {
      const result = await provider.listModels({})
      expect(result.skipped).toBeUndefined()
      const ids = result.models.map((m) => m.rawId)
      expect(ids).toContain('reactor/helios')
      expect(ids).toContain('x2')
      expect(ids).not.toContain('reactor/happy-oyster')
      expect(ids).toContain('reactor/happy-oyster-adventure')
      expect(new Set(ids).size).toBe(ids.length)
      expect(result.models.every((m) => m.activity === 'video')).toBe(true)
      expect(
        result.models.find((m) => m.rawId === 'reactor/helios')?.pricing,
      ).toBeUndefined()
      expect(
        result.models.find((m) => m.rawId === 'x2')?.pricing,
      ).toMatchObject({
        price: { '*': [{ var: 'video_seconds' }, 0.0017] },
      })
    } finally {
      globalThis.fetch = original
    }
  })

  it('falls back to the curated catalog when /pricing fails', async () => {
    const original = globalThis.fetch
    globalThis.fetch = () =>
      Promise.resolve(new Response('nope', { status: 500 }))
    try {
      const result = await provider.listModels({})
      expect(result.skipped).toBeUndefined()
      expect(result.models.map((m) => m.rawId)).toEqual(
        expect.arrayContaining([
          'reactor/helios',
          'reactor/fast-h3',
          'x2',
          'reactor/happy-oyster-director',
        ]),
      )
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('reactor fetchSpec', () => {
  it('extracts upstream OpenAPI from model API pages and namespaces paths', async () => {
    const original = globalThis.fetch
    const calls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      const href = String(url)
      calls.push(href)
      if (href === modelApiPageUrl('helios')) {
        return Promise.resolve(
          new Response(htmlWithSpec(MINI_SPEC), {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
        )
      }
      return Promise.resolve(new Response('not found', { status: 404 }))
    }) as typeof fetch
    try {
      const fetched = await provider.fetchSpec({})
      expect(calls).toContain(modelApiPageUrl('helios'))
      expect(calls).toContain(modelApiPageUrl('ltx'))
      expect(fetched.outputStrategy).toBe('post-200')
      expect(fetched.warnings?.length).toBeGreaterThan(0)

      const heliosSource = fetched.sources.find((s) =>
        s.url.includes('helios/api#reactor/helios'),
      )
      expect(heliosSource?.hash).toMatch(/^[0-9a-f]{64}$/)

      const { endpoints, warnings } = classifyAndBundle(provider, fetched)
      expect(warnings).toEqual([])
      const byId = new Map(endpoints.map((e) => [e.dbId, e]))
      expect(byId.get('reactor/reactor/helios')?.activity).toBe('video')
      expect(
        byId.get('reactor/reactor/helios/events/set_prompt')?.activity,
      ).toBe('video')
      expect(byId.get('reactor/reactor/helios/events/start')?.activity).toBe(
        'video',
      )
      expect(endpoints.every((e) => e.derivation === 'upstream-spec')).toBe(
        true,
      )

      for (const endpoint of endpoints) {
        expect(endpoint.input ?? endpoint.output, endpoint.dbId).toBeDefined()
        if (endpoint.input) expect(findDanglingRefs(endpoint.input)).toEqual([])
        if (endpoint.output) {
          expect(findDanglingRefs(endpoint.output)).toEqual([])
        }
      }

      const setPrompt = byId.get('reactor/reactor/helios/events/set_prompt')
      expect(setPrompt?.input?.required).toEqual(['prompt'])

      const envelope = byId.get('reactor/reactor/helios')
      expect(Array.isArray(envelope?.input?.oneOf)).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })

  it('hashes the extracted OpenAPI, not the surrounding HTML', async () => {
    const original = globalThis.fetch
    let n = 0
    globalThis.fetch = ((url: string) => {
      if (String(url) !== modelApiPageUrl('helios')) {
        return Promise.resolve(new Response('not found', { status: 404 }))
      }
      n += 1
      const html = htmlWithSpec(MINI_SPEC) + `<!-- ${String(n)} -->`
      return Promise.resolve(new Response(html, { status: 200 }))
    }) as typeof fetch
    try {
      const a = await provider.fetchSpec({})
      const b = await provider.fetchSpec({})
      const hashA = a.sources.find((s) => s.url.includes('helios'))?.hash
      const hashB = b.sources.find((s) => s.url.includes('helios'))?.hash
      expect(hashA).toBe(hashB)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('reactor POST /tokens', () => {
  it('documents the session JWT call and leaves command paths out of it', () => {
    expect(provider.realtimeCommands).toBe(true)
    const post = reactorPlatformOperations(undefined)['/tokens']?.post
    if (!post) throw new Error('missing POST /tokens')
    expect(post.parameters).toEqual([
      expect.objectContaining({
        name: 'Reactor-API-Key',
        in: 'header',
        required: true,
      }),
    ])
    const body = sessionTokenRequestSchema()
    expect(body.required).toEqual(['authorization_details'])
    const details = (
      body.properties as {
        authorization_details: { items: { required: Array<string> } }
      }
    ).authorization_details
    expect(details.items.required).toEqual(['type', 'resources'])
    const response = (
      post.responses as {
        '200': {
          content: {
            'application/json': { schema: { required: Array<string> } }
          }
        }
      }
    )['200']
    expect(response.content['application/json'].schema.required).toEqual([
      'jwt',
      'expires_at',
    ])
    const pinned = reactorPlatformOperations('reactor/helios')['/tokens']?.post
    expect(JSON.stringify(pinned)).toContain('"enum":["reactor/helios"]')
  })
})

describe('reactor seed metadata', () => {
  it('exports the isolation-required fields', () => {
    expect(provider.id).toBe('reactor')
    expect(provider.displayName).toBe('Reactor')
    expect(provider.authEnvVar).toBe('REACTOR_API_KEY')
    expect(provider.defaultDerivation).toBe('upstream-spec')
    expect(provider.specGrain).toBe('model')
    expect(provider.specSourceUrl).toMatch(/^https:\/\//)
    expect(provider.modelsEndpoint).toBe(REACTOR_PRICING_URL)
  })
})
