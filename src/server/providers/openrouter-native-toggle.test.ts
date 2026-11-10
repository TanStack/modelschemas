import { requestUrl } from '#/lib/text.ts'
import { afterEach, expect, it, vi } from 'vitest'
import {
  openRouterGatewayEffortWire,
  openRouterGatewayToggle,
  openRouterReasoningContentReplay,
} from './openrouter-reasoning.ts'
import { openRouterReasoning } from './reasoning-config.ts'
import docs from './fixtures/openrouter-native-toggle.json'
import { openrouterProvider } from './openrouter.ts'
import { sha256Text } from './types.ts'

it('reads the API-wide reasoning_content replay statement', () => {
  expect(openRouterReasoningContentReplay(docs.markdown)).toBe(true)
  expect(() =>
    openRouterReasoningContentReplay(
      docs.markdown.replace('`reasoning_content` as an alias', 'a field'),
    ),
  ).toThrow(/alias missing/)
})
it('uses host normalized toggle only with explicit native nonmandatory metadata', () => {
  const toggle = openRouterGatewayToggle(docs.markdown)
  expect(
    openRouterReasoning(
      { reasoning: { mandatory: false } },
      undefined,
      !!toggle,
    ),
  ).toEqual({ mode: 'toggle', mandatory: false })
  expect(
    openRouterReasoning(
      { reasoning: { mandatory: true } },
      undefined,
      !!toggle,
    ),
  ).toBeNull()
  expect(openRouterReasoning({ reasoning: {} }, undefined, !!toggle)).toBeNull()
  expect(openRouterReasoning({}, undefined, !!toggle)).toBeNull()
  expect(openRouterReasoning({ reasoning: { mandatory: false } })).toBeNull()
  expect(
    openRouterReasoning(
      { reasoning: { mandatory: false, supports_max_tokens: true } },
      undefined,
      !!toggle,
    ),
  ).toEqual({ mode: 'budget', mandatory: false })
  expect(
    openRouterReasoning(
      { reasoning: { mandatory: false, supported_efforts: ['low'] } },
      undefined,
      !!toggle,
    ),
  ).toEqual({ mode: 'effort', mandatory: false, efforts: ['low'] })
})
it('rejects fenced, restricted or negated native declarations', () => {
  expect(() =>
    openRouterGatewayToggle('```\n' + docs.markdown + '\n```'),
  ).toThrow()
  expect(() =>
    openRouterGatewayToggle(
      docs.markdown.replace(
        'so they work on every reasoning model, not only Claude',
        'so they work only on Claude',
      ),
    ),
  ).toThrow()
  expect(() =>
    openRouterGatewayToggle(
      docs.markdown.replace(
        '`thinking: { type: "disabled" }` disables reasoning even when',
        'Do not assume `thinking: { type: "disabled" }` disables reasoning even when',
      ),
    ),
  ).toThrow()
  expect(() =>
    openRouterGatewayToggle(
      docs.markdown.replace('enabled: false', 'enabled: true'),
    ),
  ).toThrow()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('lists actual native nonmandatory toggle with exact guide provenance, preserving mandatory unknown mode', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input)
      if (url === 'https://openrouter.ai/api/v1/models')
        return Response.json(docs.nativeModels)
      if (url === docs.sourceUrl) return new Response(docs.markdown)
      throw new Error('unexpected source URL ' + url)
    }),
  )
  const listed = await openrouterProvider.listModels({})
  expect(listed.models[0]?.reasoning).toEqual({
    mode: 'toggle',
    mandatory: false,
  })
  expect(listed.models[0]?.factSources?.reasoning).toMatchObject({
    derivation: 'docs-derived',
    sourceUrl: docs.sourceUrl,
    sourceHash: await sha256Text(docs.markdown),
  })
  expect(listed.models[0]?.requestMap?.thinking).toEqual({
    on: { reasoning: { enabled: true } },
    off: { reasoning: { enabled: false } },
    levels: null,
  })
  expect(listed.models[0]?.requestMap?.strictTools).toBeNull()
  expect(
    listed.models[0]?.factSources?.requestMapFields?.thinking,
  ).toMatchObject({
    sourceUrl: docs.sourceUrl,
    sourceHash: await sha256Text(docs.markdown),
  })
  expect(listed.models[1]?.reasoning).toBeNull()
})

it('separates old shapes and effort-only warm cache from a newly toggle-capable catalog', async () => {
  const cache = new Map<string, string>()
  const kv = {
    get: async (key: string) =>
      key.endsWith(docs.sourceUrl)
        ? JSON.stringify({ efforts: ['old'], hash: 'old' })
        : (cache.get(key) ?? null),
    put: async (key: string, value: string) => {
      cache.set(key, value)
    },
  } as unknown as KVNamespace
  let phase = 0,
    guideFetches = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input)
      if (url === 'https://openrouter.ai/api/v1/models')
        return Response.json(
          phase === 0
            ? {
                data: [
                  {
                    ...docs.nativeModels.data[0],
                    reasoning: { mandatory: true, supported_efforts: null },
                  },
                ],
              }
            : docs.nativeModels,
        )
      if (url === docs.sourceUrl) {
        guideFetches++
        return new Response(docs.markdown)
      }
      throw new Error('unexpected source ' + url)
    }),
  )
  const before = await openrouterProvider.listModels({}, kv)
  expect(before.models[0]?.reasoning?.efforts).not.toContain('old')
  phase = 1
  const after = await openrouterProvider.listModels({}, kv)
  expect(after.models[0]?.reasoning).toEqual({
    mode: 'toggle',
    mandatory: false,
  })
  const warm = await openrouterProvider.listModels({}, kv)
  expect(warm.models[0]?.requestMap?.thinking?.on).toEqual({
    reasoning: { enabled: true },
  })
  expect(guideFetches).toBe(2)
})

it('rejects present malformed native metadata while null and absent facts stay unknown', () => {
  expect(() =>
    openRouterReasoning({ reasoning: { mandatory: 'false' } }),
  ).toThrow('malformed native mandatory')
  expect(() =>
    openRouterReasoning({
      reasoning: { mandatory: false, supports_max_tokens: 'true' },
    }),
  ).toThrow('malformed native supports_max_tokens')
  expect(() =>
    openRouterReasoning({
      reasoning: { mandatory: false, supported_efforts: [42] },
    } as never),
  ).toThrow('malformed native supported_efforts')
  expect(() =>
    openRouterReasoning({
      reasoning: { mandatory: false, supported_efforts: 'high' },
    } as never),
  ).toThrow('malformed native supported_efforts')
  expect(openRouterReasoning({ reasoning: { mandatory: null } })).toBeNull()
  expect(openRouterReasoning({ reasoning: {} })).toBeNull()
})

it('sources high only from an actual accepted native enum and leaves another native model wire unknown', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input)
      if (url === 'https://openrouter.ai/api/v1/models')
        return Response.json(docs.nativeEffortModels)
      if (url === docs.sourceUrl) return new Response(docs.markdown)
      throw new Error('unexpected URL ' + url)
    }),
  )
  const listed = await openrouterProvider.listModels({})
  expect(listed.models[0]?.requestMap?.thinking?.on).toEqual({
    reasoning: { effort: 'high' },
  })
  expect(listed.models[0]?.requestMap?.thinking?.off).toBeNull()
  expect(
    listed.models[0]?.factSources?.requestMapFields?.thinking,
  ).toMatchObject({
    sourceUrl: docs.sourceUrl,
    sourceHash: await sha256Text(docs.markdown),
  })
  expect(listed.models[1]?.reasoning?.efforts).toEqual(['xhigh', 'medium'])
  expect(listed.models[1]?.requestMap).toMatchObject({
    thinking: null,
    replayReasoningContent: true,
  })
  const replay =
    listed.models[1]?.factSources?.requestMapFields?.replayReasoningContent
  expect(replay?.sourceUrl).toBe(docs.sourceUrl)
  expect(replay?.path).toContain('reasoning_content')
  expect(() =>
    openRouterGatewayEffortWire('```\n' + docs.markdown + '\n```'),
  ).toThrow()
  expect(() =>
    openRouterGatewayEffortWire(
      docs.markdown.replace(
        'so they work on every reasoning model, not only Claude',
        'Do not assume so they work on every reasoning model, not only Claude',
      ),
    ),
  ).toThrow()
})
