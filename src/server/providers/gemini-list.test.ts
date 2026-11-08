import { afterEach, describe, expect, it, vi } from 'vitest'

import { GEMINI_PRICING_URL } from './gemini-pricing.ts'
import { GEMINI_DISCOVERY_URL } from './gemini-request.ts'
import { geminiProvider } from './gemini.ts'

const KEY = 'test-gemini-key-123'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('gemini listModels', () => {
  it('sends the key as a header so a failed fetch never quotes it', async () => {
    const seen: Array<{ url: string; key: string | null }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init?: RequestInit) => {
        if (
          !input.startsWith(
            'https://generativelanguage.googleapis.com/v1beta/models?',
          )
        ) {
          // Docs loads run alongside the listing; leave them pending.
          return new Promise<Response>(() => {})
        }
        seen.push({
          url: input,
          key: new Headers(init?.headers).get('x-goog-api-key'),
        })
        return Promise.resolve(
          new Response('bad', { status: 400, statusText: 'Bad Request' }),
        )
      }),
    )

    const error = await geminiProvider.listModels({ GEMINI_API_KEY: KEY }).then(
      () => null,
      (err: unknown) => err,
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('400 Bad Request')
    expect((error as Error).message).not.toContain(KEY)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).not.toContain(KEY)
    expect(seen[0]?.key).toBe(KEY)
  })

  it('writes the listing when the pricing page parses nothing (#567)', async () => {
    vi.stubGlobal('fetch', (input: string) => {
      const url = String(input)
      if (
        url.startsWith(
          'https://generativelanguage.googleapis.com/v1beta/models',
        )
      ) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              models: [
                {
                  name: 'models/gemini-2.5-flash',
                  displayName: 'Gemini 2.5 Flash',
                  supportedGenerationMethods: ['generateContent'],
                  inputTokenLimit: 1048576,
                  outputTokenLimit: 65536,
                },
              ],
            }),
          ),
        )
      }
      if (url === GEMINI_DISCOVERY_URL) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              schemas: {
                ThinkingConfig: {
                  properties: { thinkingBudget: { description: 'budget' } },
                },
                Content: {
                  properties: {
                    role: {
                      description: "The role must be either 'user' or 'model'.",
                    },
                  },
                },
              },
            }),
          ),
        )
      }
      if (url === GEMINI_PRICING_URL) {
        return Promise.resolve(new Response('<html><body>moved</body></html>'))
      }
      return Promise.resolve(new Response('moved', { status: 404 }))
    })

    const result = await geminiProvider.listModels({ GEMINI_API_KEY: KEY })

    expect(result.models).toEqual([
      expect.objectContaining({
        rawId: 'gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        activity: 'chat',
        contextWindow: 1048576,
        maxOutput: 65536,
        absent: {
          pricing: 'unavailable',
          modalities: 'unavailable',
          serverTools: 'unavailable',
          reasoning: 'unavailable',
          requestMap: 'unavailable',
        },
      }),
    ])
    expect(result.docsFailures?.first).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: GEMINI_PRICING_URL,
          error: 'gemini pricing page: parsed 0 model rows',
        }),
      ]),
    )
    expect(result.skipped).toBeUndefined()
  })
})
