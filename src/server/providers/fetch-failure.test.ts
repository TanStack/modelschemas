import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchJson, fetchText, timeoutSignal } from './types.ts'

const LISTING_URL = 'https://api.example.com/v1/models'

afterEach(() => {
  vi.unstubAllGlobals()
})

function respondWith(body: string, status: number, statusText: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(body, { status, statusText }))),
  )
}

describe('fetch failure message', () => {
  it("quotes the provider's stated reason after the status", async () => {
    // Illustrative Gemini error shape, not a recorded response.
    respondWith(
      JSON.stringify({
        error: {
          code: 400,
          message: 'User location is not supported for the API use.',
          status: 'FAILED_PRECONDITION',
        },
      }),
      400,
      'Bad Request',
    )

    await expect(fetchJson(LISTING_URL)).rejects.toThrow(
      `fetch failed: ${LISTING_URL} → 400 Bad Request: {"error":{"code":400,"message":"User location is not supported for the API use."`,
    )
  })

  it('collapses whitespace and cuts a long body at 200 characters', async () => {
    respondWith(`<html>\n  <body>${'x'.repeat(500)}</body>`, 503, 'Unavailable')

    const message = await fetchText(LISTING_URL).then(
      () => '',
      (err: unknown) => (err as Error).message,
    )

    const snippet = message.split('→ 503 Unavailable: ')[1] ?? ''
    expect(snippet.startsWith('<html> <body>xxx')).toBe(true)
    expect(snippet).toHaveLength(201)
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('ends at the status when the body is empty', async () => {
    respondWith('', 403, 'Forbidden')

    await expect(fetchJson(LISTING_URL)).rejects.toThrow(
      new Error(`fetch failed: ${LISTING_URL} → 403 Forbidden`),
    )
  })

  it('throws with what arrived when the error body stalls', async () => {
    vi.useFakeTimers()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('upstream stalled'))
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(body, { status: 502, statusText: 'Bad Gateway' }),
        ),
      ),
    )

    const failed = fetchJson(LISTING_URL).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(2000)
    vi.useRealTimers()

    expect(await failed).toEqual(
      new Error(
        `fetch failed: ${LISTING_URL} → 502 Bad Gateway: upstream stalled`,
      ),
    )
  })

  it('names the url and the timeout budget when the fetch aborts', async () => {
    const timeout = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    )
    const fetcher = () => Promise.reject(timeout)

    await expect(
      fetchText(LISTING_URL, { signal: timeoutSignal(20_000) }, fetcher),
    ).rejects.toThrow(`fetch failed: ${LISTING_URL} → timeout after 20000ms`)
    await expect(fetchJson(LISTING_URL, undefined, fetcher)).rejects.toThrow(
      `fetch failed: ${LISTING_URL} → timeout`,
    )
  })

  it('leaves a non-timeout rejection unchanged', async () => {
    const fetcher = () => Promise.reject(new TypeError('getaddrinfo ENOTFOUND'))

    await expect(fetchText(LISTING_URL, undefined, fetcher)).rejects.toThrow(
      'getaddrinfo ENOTFOUND',
    )
  })
})
