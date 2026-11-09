import { requestUrl } from '#/lib/text.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import directorAsyncApi from '../ingest/fixtures/fal-minimax-h3-max-director.asyncapi.json'
import {
  FAL_ACTIVITY_MARKER,
  falAppSlug,
  falAsyncApiUrl,
  falLlmsTxtUrl,
  falProvider,
  fetchPageWithRetry,
  parseAsyncApiContractUrl,
} from './fal.ts'

const PAGE = { models: [], has_more: false, next_cursor: null }

function jsonResponse(): Response {
  return new Response(JSON.stringify(PAGE), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response('nope', { status, headers })
}

/** Resolve the retry loop's backoff sleeps as they are scheduled. */
async function withTimersFlushed<T>(promise: Promise<T>): Promise<T> {
  // Mark handled before the flush: a rejection landing mid-flush would
  // otherwise trip the unhandled-rejection detector.
  void promise.catch(() => undefined)
  await vi.runAllTimersAsync()
  return promise
}

describe('fetchPageWithRetry', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('returns the parsed page on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse())
    await expect(fetchPageWithRetry('https://x', 'key')).resolves.toEqual(PAGE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries 429 (with Retry-After) and 5xx before succeeding', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(429, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(jsonResponse())
    await expect(
      withTimersFlushed(fetchPageWithRetry('https://x', 'key')),
    ).resolves.toEqual(PAGE)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries network-level failures', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(jsonResponse())
    await expect(
      withTimersFlushed(fetchPageWithRetry('https://x', 'key')),
    ).resolves.toEqual(PAGE)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails fast on non-retryable statuses like 401', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(401))
    await expect(fetchPageWithRetry('https://x', 'key')).rejects.toThrow(
      'fal models fetch failed: 401',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after the attempt budget with the last failure in the message', async () => {
    fetchMock.mockResolvedValue(errorResponse(429))
    await expect(
      withTimersFlushed(fetchPageWithRetry('https://x', 'key', 3)),
    ).rejects.toThrow('fal models fetch failed after 3 attempts: 429')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

const DIRECTOR_LLMS = [
  '# H3 Max Director',
  '- [OpenAPI Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max/director)',
  '- [AsyncAPI Contract](https://fal.ai/api/apps/fal-ai/minimax-h3-max-director/asyncapi.json)',
].join('\n')

const FLUX_OPENAPI = {
  openapi: '3.0.0',
  paths: {
    '/fal-ai/flux/dev': {
      post: {
        requestBody: {
          content: {
            'application/json': { schema: { type: 'object' } },
          },
        },
        responses: { '200': { content: {} } },
      },
    },
  },
}

function jsonBody(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('fal AsyncAPI discovery', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps raw ids to the apps asyncapi.json URL', () => {
    expect(falAppSlug('minimax/h3-max/director')).toBe(
      'fal-ai/minimax-h3-max-director',
    )
    expect(falAsyncApiUrl('minimax/h3-max/director')).toBe(
      'https://fal.ai/api/apps/fal-ai/minimax-h3-max-director/asyncapi.json',
    )
    expect(falLlmsTxtUrl('minimax/h3-max/director')).toBe(
      'https://fal.ai/models/minimax/h3-max/director/llms.txt',
    )
    expect(parseAsyncApiContractUrl(DIRECTOR_LLMS)).toBe(
      'https://fal.ai/api/apps/fal-ai/minimax-h3-max-director/asyncapi.json',
    )
    expect(parseAsyncApiContractUrl('# no contract')).toBeNull()
  })

  it('probes AsyncAPI only for listed models with no OpenAPI POST', async () => {
    fetchMock.mockImplementation((input) => {
      const url = requestUrl(input)
      if (url.startsWith('https://api.fal.ai/v1/models')) {
        if (new URL(url).searchParams.get('endpoint_id') === 'fal-ai/whisper') {
          return Promise.resolve(new Response('missing', { status: 404 }))
        }
        return Promise.resolve(
          jsonBody({
            models: [
              {
                endpoint_id: 'fal-ai/flux/dev',
                openapi: FLUX_OPENAPI,
                metadata: { category: 'text-to-image', display_name: 'Flux' },
              },
              {
                endpoint_id: 'minimax/h3-max/director',
                metadata: {
                  category: 'text-to-video',
                  display_name: 'H3 Max Director',
                },
              },
              {
                endpoint_id: 'ghost/no-spec',
                metadata: { category: 'text-to-image' },
              },
              {
                endpoint_id: 'fal-ai/trainer',
                metadata: { category: 'training' },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
        )
      }
      if (url === falLlmsTxtUrl('minimax/h3-max/director')) {
        return Promise.resolve(new Response(DIRECTOR_LLMS))
      }
      if (url === falAsyncApiUrl('minimax/h3-max/director')) {
        return Promise.resolve(jsonBody(directorAsyncApi))
      }
      return Promise.resolve(new Response('nope', { status: 404 }))
    })

    const fetched = await falProvider.fetchSpec({ FAL_KEY: 'test-key' })
    expect(fetched.skipped).toBeUndefined()
    expect(fetched.specs).toHaveLength(1)
    expect(fetched.specs[0]?.info?.['x-fal-endpoint-id']).toBe(
      'fal-ai/flux/dev',
    )
    expect(fetched.asyncApiRawIds).toEqual(['minimax/h3-max/director'])
    expect(fetched.bundledEndpoints).toHaveLength(1)
    expect(fetched.bundledEndpoints?.[0]).toMatchObject({
      path: '/minimax/h3-max/director',
      activity: 'video',
      asyncapi: true,
      derivation: 'upstream-spec',
      source: {
        url: 'https://fal.ai/api/apps/fal-ai/minimax-h3-max-director/asyncapi.json',
      },
    })
    const inputOneOf = fetched.bundledEndpoints?.[0]?.input?.oneOf
    expect(Array.isArray(inputOneOf)).toBe(true)
    if (Array.isArray(inputOneOf)) {
      expect(inputOneOf.length).toBeGreaterThan(0)
    }

    const urls = fetchMock.mock.calls.map((call) => requestUrl(call[0]))
    expect(
      urls.some((u) => u.includes('fal-ai/flux/dev') && u.includes('llms')),
    ).toBe(false)
    expect(urls.some((u) => u.includes('fal-ai-flux-dev'))).toBe(false)
    expect(urls).toContain(falLlmsTxtUrl('minimax/h3-max/director'))
    expect(urls).toContain(falLlmsTxtUrl('ghost/no-spec'))
    expect(urls).not.toContain(falLlmsTxtUrl('fal-ai/trainer'))
  })

  it('falls back to the constructed asyncapi.json URL when llms.txt has no link', async () => {
    fetchMock.mockImplementation((input) => {
      const url = requestUrl(input)
      if (url.startsWith('https://api.fal.ai/v1/models')) {
        if (new URL(url).searchParams.get('endpoint_id') === 'fal-ai/whisper') {
          return Promise.resolve(new Response('missing', { status: 404 }))
        }
        return Promise.resolve(
          jsonBody({
            models: [
              {
                endpoint_id: 'minimax/h3-max/director',
                metadata: { category: 'text-to-video' },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
        )
      }
      if (url === falLlmsTxtUrl('minimax/h3-max/director')) {
        return Promise.resolve(new Response('# no contract here'))
      }
      if (url === falAsyncApiUrl('minimax/h3-max/director')) {
        return Promise.resolve(jsonBody(directorAsyncApi))
      }
      return Promise.resolve(new Response('nope', { status: 404 }))
    })

    const fetched = await falProvider.fetchSpec({ FAL_KEY: 'test-key' })
    expect(fetched.asyncApiRawIds).toEqual(['minimax/h3-max/director'])
    expect(fetched.bundledEndpoints?.[0]?.source.url).toBe(
      falAsyncApiUrl('minimax/h3-max/director'),
    )
  })

  it('does not fail the fetch when AsyncAPI is missing', async () => {
    fetchMock.mockImplementation((input) => {
      const url = requestUrl(input)
      if (url.startsWith('https://api.fal.ai/v1/models')) {
        if (new URL(url).searchParams.get('endpoint_id') === 'fal-ai/whisper') {
          return Promise.resolve(new Response('missing', { status: 404 }))
        }
        return Promise.resolve(
          jsonBody({
            models: [
              {
                endpoint_id: 'ghost/no-spec',
                metadata: { category: 'text-to-image' },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
        )
      }
      return Promise.resolve(new Response('nope', { status: 404 }))
    })

    const fetched = await falProvider.fetchSpec({ FAL_KEY: 'test-key' })
    expect(fetched.skipped).toBeUndefined()
    expect(fetched.specs).toEqual([])
    expect(fetched.bundledEndpoints).toEqual([])
    expect(fetched.asyncApiRawIds).toEqual([])
  })

  it('ingests fal-ai/whisper from a direct lookup when metadata is null', async () => {
    const whisperOpenApi = {
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
    }
    fetchMock.mockImplementation((input) => {
      const url = requestUrl(input)
      if (url.startsWith('https://api.fal.ai/v1/models')) {
        const parsed = new URL(url)
        if (parsed.searchParams.get('endpoint_id') === 'fal-ai/whisper') {
          return Promise.resolve(
            jsonBody({
              models: [
                {
                  endpoint_id: 'fal-ai/whisper',
                  metadata: null,
                  openapi: whisperOpenApi,
                },
              ],
              has_more: false,
              next_cursor: null,
            }),
          )
        }
        return Promise.resolve(
          jsonBody({
            models: [
              {
                endpoint_id: 'fal-ai/flux/dev',
                openapi: FLUX_OPENAPI,
                metadata: { category: 'text-to-image' },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
        )
      }
      return Promise.resolve(new Response('nope', { status: 404 }))
    })

    const fetched = await falProvider.fetchSpec({ FAL_KEY: 'test-key' })
    const whisper = fetched.specs.find(
      (spec) => spec.info?.['x-fal-endpoint-id'] === 'fal-ai/whisper',
    )
    expect(whisper).toBeDefined()
    const post = whisper?.paths?.['/']?.post
    expect(post?.[FAL_ACTIVITY_MARKER]).toBe('audio')
    expect(fetched.specs).toHaveLength(2)
    expect(fetched.asyncApiRawIds).toEqual([])
  })

  it('throws when the unlisted lookup fails with anything but 404', async () => {
    fetchMock.mockImplementation((input) => {
      const url = requestUrl(input)
      if (url.startsWith('https://api.fal.ai/v1/models')) {
        if (new URL(url).searchParams.get('endpoint_id') === 'fal-ai/whisper') {
          return Promise.resolve(new Response('forbidden', { status: 403 }))
        }
        return Promise.resolve(
          jsonBody({
            models: [
              {
                endpoint_id: 'fal-ai/flux/dev',
                openapi: FLUX_OPENAPI,
                metadata: { category: 'text-to-image' },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
        )
      }
      return Promise.resolve(new Response('nope', { status: 404 }))
    })
    await expect(
      falProvider.fetchSpec({ FAL_KEY: 'test-key' }),
    ).rejects.toThrow('403')
  })

  it('throws when the unlisted lookup returns a page without that id', async () => {
    fetchMock.mockImplementation((input) => {
      const url = requestUrl(input)
      if (url.startsWith('https://api.fal.ai/v1/models')) {
        if (new URL(url).searchParams.get('endpoint_id') === 'fal-ai/whisper') {
          return Promise.resolve(
            jsonBody({ models: [], has_more: false, next_cursor: null }),
          )
        }
        return Promise.resolve(
          jsonBody({
            models: [
              {
                endpoint_id: 'fal-ai/flux/dev',
                openapi: FLUX_OPENAPI,
                metadata: { category: 'text-to-image' },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
        )
      }
      return Promise.resolve(new Response('nope', { status: 404 }))
    })
    await expect(
      falProvider.fetchSpec({ FAL_KEY: 'test-key' }),
    ).rejects.toThrow('no row for the endpoint_id lookup')
  })
})
