import { KIMI_CN_THINKING_URL } from '../provider-replay.ts'
import { KIMI_REPLAY_FIXTURE } from '../fixtures/provider-replay.ts'
import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it } from 'vitest'

import { modelBranchSchemas, walkRequestSchema } from '../fact-sources.ts'
import specFixture from '../fixtures/moonshotai-cn-openapi.json' with { type: 'json' }
import { parseKimiDocTables } from '../kimi-doc-tables.ts'
import type { OpenApiDocument } from '../types.ts'
import {
  MOONSHOT_CN_OPENAPI_URL,
  MOONSHOT_CN_PRICING_URL,
  moonshotCnChatFacts,
  moonshotThinkingToggle,
  parseMoonshotCnPricing,
  provider,
} from './moonshotai-cn.ts'

/**
 * The compiled MDX body of platform.kimi.com/docs/pricing/chat (2026-10-23),
 * plus a priced id the chat spec does not map. Prices are yuan.
 */
const PRICING = readFileSync(
  new URL(
    '../fixtures/platform.kimi.com-pricing-chat.html.txt',
    import.meta.url,
  ),
  'utf8',
).replace(
  '`¥6.50 / MTok`,`¥27.00 / MTok`,`¥1.10 / MTok`]',
  '`¥6.50 / MTok`,`¥27.00 / MTok`,`¥1.10 / MTok`],[`kimi-unmapped`,`¥2.00 / MTok`,`¥3.00 / MTok`,`¥1.00 / MTok`]',
)

const K3_IDS = ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3']

const prices = (page: string) =>
  parseMoonshotCnPricing(parseKimiDocTables(page))

/** Chat path and its schema closure from platform.kimi.com/docs/openapi.json (2026-10-06). */
const SPEC = specFixture as OpenApiDocument

function mutated(edit: (spec: OpenApiDocument) => void): OpenApiDocument {
  const copy = structuredClone(SPEC)
  edit(copy)
  return copy
}

const originalFetch = globalThis.fetch

function stubFetch(spec: string): Array<string> {
  const urls: Array<string> = []
  globalThis.fetch = ((url: string) => {
    urls.push(String(url))
    if (String(url) === KIMI_CN_THINKING_URL)
      return Promise.resolve(new Response(KIMI_REPLAY_FIXTURE))
    if (String(url) === MOONSHOT_CN_PRICING_URL) {
      return Promise.resolve(new Response(PRICING))
    }
    if (String(url) === MOONSHOT_CN_OPENAPI_URL) {
      return Promise.resolve(new Response(spec))
    }
    return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
  }) as typeof fetch
  return urls
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('moonshotCnChatFacts', () => {
  it('reads each model from its own branch of the chat union', () => {
    const facts = moonshotCnChatFacts(SPEC, 'h')
    expect(Object.keys(facts)).toEqual([
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
    ])
    expect(facts['kimi-k3']).toMatchObject({
      activity: 'chat',
      reasoning: {
        mode: 'effort',
        mandatory: true,
        efforts: ['low', 'high', 'max'],
      },
      // `reasoning_effort` alone says the model reasons; it has no `thinking`.
      capabilities: ['reasoning'],
      modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    })
    const effortSource = {
      derivation: 'upstream-spec',
      sourceUrl: MOONSHOT_CN_OPENAPI_URL,
      sourceHash: 'h',
      path: '/components/schemas/KimiK3ChatRequest/properties/reasoning_effort',
    }
    expect(facts['kimi-k3']?.factSources.reasoning).toEqual(effortSource)
    expect(facts['kimi-k3']?.factSources.capabilities).toEqual({
      reasoning: effortSource,
    })
    // The K2 schemas take an on/off `thinking`; the walk flags that itself.
    // kimi-k2.6 lists `disabled` in its own enum. kimi-k2.7-code lists only
    // `enabled`, and its description says "该模型始终开启思考".
    expect(facts['kimi-k2.6']?.reasoning).toEqual({
      mode: 'toggle',
      mandatory: false,
    })
    for (const id of ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed']) {
      expect(facts[id]?.reasoning).toEqual({ mode: 'toggle', mandatory: true })
    }
    for (const id of ['kimi-k2.7-code', 'kimi-k2.6']) {
      expect(facts[id]?.capabilities).toBeUndefined()
      expect(facts[id]?.factSources.reasoning).toEqual({
        derivation: 'upstream-spec',
        sourceUrl: MOONSHOT_CN_OPENAPI_URL,
        sourceHash: 'h',
        path: 'thinking.type',
      })
      expect(facts[id]?.modalities).toEqual({
        input: ['text', 'image', 'video'],
        output: ['text'],
      })
    }
    // "最大可设置为 1048576" is the context bound, not an output cap.
    for (const model of Object.values(facts)) {
      expect(model).not.toHaveProperty('maxOutput')
    }
  })

  it('stores no toggle when the switch does not state its off position', () => {
    type Thinking = {
      description: string
      properties: { type: { enum: Array<string> } }
    }
    const thinkingOf = (spec: OpenApiDocument, name: string) =>
      (
        spec.components!.schemas![name] as {
          allOf: Array<{ properties?: { thinking?: Thinking } }>
        }
      ).allOf[1]?.properties?.thinking as Thinking
    const k27 = (edit: (thinking: Thinking) => void) =>
      moonshotCnChatFacts(
        mutated((spec) => edit(thinkingOf(spec, 'KimiK27CodeChatRequest'))),
        'h',
      )['kimi-k2.7-code']
    // Reworded: "always on" is gone, and `[enabled]` alone is not a statement.
    const reworded = k27((thinking) => {
      thinking.description = thinking.description.replace(
        '该模型始终开启思考',
        '该模型默认开启思考',
      )
    })
    expect(reworded?.reasoning).toBeUndefined()
    expect(reworded?.factSources.reasoning?.path).toBe('silent')
    // A third position is not an on/off switch.
    const auto = k27((thinking) => {
      thinking.properties.type.enum = ['enabled', 'disabled', 'auto']
    })
    expect(auto?.reasoning).toBeUndefined()
    expect(auto?.factSources.reasoning?.path).toBe('silent')
    // The statement wins over a `disabled` the enum still lists.
    expect(
      k27((thinking) => {
        thinking.properties.type.enum = ['enabled', 'disabled']
      })?.reasoning,
    ).toEqual({ mode: 'toggle', mandatory: true })
    // kimi-k2.6 without `disabled` and without a statement: nothing.
    const k26 = moonshotCnChatFacts(
      mutated((spec) => {
        thinkingOf(spec, 'KimiK26ChatRequest').properties.type.enum = [
          'enabled',
        ]
      }),
      'h',
    )['kimi-k2.6']
    expect(k26?.reasoning).toBeUndefined()
    expect(k26?.factSources.reasoning?.path).toBe('silent')
  })

  it('reads the statement in both hosts’ words', () => {
    // platform.kimi.ai/docs/openapi.json, KimiK27CodeChatRequest (2026-10-07).
    const english =
      '- `type` only accepts `"enabled"`. Unlike kimi-k2.6, `"disabled"` is NOT supported — passing it returns an error. Thinking is always on for this model.'
    expect(moonshotThinkingToggle(['enabled'], english)).toEqual({
      mode: 'toggle',
      mandatory: true,
    })
    expect(
      moonshotThinkingToggle(
        ['enabled'],
        '- `type` 仅支持 `"enabled"`。与 kimi-k2.6 不同，不支持 `"disabled"` — 传入会报错。该模型始终开启思考。',
      ),
    ).toEqual({ mode: 'toggle', mandatory: true })
    expect(
      moonshotThinkingToggle(['enabled'], 'Thinking is on by default.'),
    ).toBeNull()
    expect(moonshotThinkingToggle(['enabled'], undefined)).toBeNull()
    expect(
      moonshotThinkingToggle(['enabled', 'disabled'], 'Enable or disable.'),
    ).toEqual({ mode: 'toggle', mandatory: false })
    expect(moonshotThinkingToggle(['disabled'], undefined)).toBeNull()
    expect(moonshotThinkingToggle([], undefined)).toBeNull()
  })

  it('claims no reasoning when the branch drops reasoning_effort', () => {
    const bare = mutated((spec) => {
      const k3 = spec.components?.schemas?.KimiK3ChatRequest as {
        allOf: Array<{ properties?: Record<string, unknown> }>
      }
      delete k3.allOf[1]?.properties?.reasoning_effort
    })
    const k3 = moonshotCnChatFacts(bare, 'h')['kimi-k3']
    expect(k3?.reasoning).toBeUndefined()
    expect(k3?.capabilities).toBeUndefined()
    expect(k3?.factSources.reasoning).toBeUndefined()
  })

  it('throws on another host’s spec or a chat body that is not a model union', () => {
    expect(() =>
      moonshotCnChatFacts(
        mutated((spec) => {
          spec.servers = [{ url: 'https://api.moonshot.ai' }]
        }),
        'h',
      ),
    ).toThrow(/spec server/)
    expect(() =>
      moonshotCnChatFacts(
        mutated((spec) => {
          const post = spec.paths?.['/v1/chat/completions']?.post as {
            requestBody: { content: Record<string, { schema: unknown }> }
          }
          post.requestBody.content['application/json'] = {
            schema: { $ref: '#/components/schemas/ChatRequestBase' },
          }
        }),
        'h',
      ),
    ).toThrow(/per-model union/)
  })
})

describe('moonshotai-cn', () => {
  it('lists chat rows with spec facts and prices them in yuan', async () => {
    const urls = stubFetch(JSON.stringify(SPEC))
    const { models } = await provider.listModels({})

    expect(urls).toEqual([
      MOONSHOT_CN_PRICING_URL,
      MOONSHOT_CN_OPENAPI_URL,
      KIMI_CN_THINKING_URL,
    ])
    expect(models.map((model) => model.rawId)).toEqual([
      'kimi-k3.1-pro',
      'kimi-k3.1-pro-highspeed',
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
      'kimi-unmapped',
    ])
    expect(models[2]).toMatchObject({
      rawId: 'kimi-k3',
      activity: 'chat',
      // The table no longer states a context window (issue #484).
      contextWindow: null,
      capabilities: ['reasoning'],
      // ¥20 in, ¥100 out, ¥2 cache hit, ¥20 / ¥40 cache write per 1M.
      pricing: {
        price: { currency: ['CNY', expect.anything() as unknown] },
        tables: {
          rate: {
            base: {
              input_tokens: 20 / 1e6,
              output_tokens: 100 / 1e6,
              cache_read_tokens: 2 / 1e6,
              cache_write_tokens: 20 / 1e6,
              cache_write_1h_tokens: 40 / 1e6,
            },
          },
        },
        source: { url: MOONSHOT_CN_PRICING_URL },
      },
    })
    expect(models[2]?.factSources?.pricing).toMatchObject({
      derivation: 'docs-derived',
      sourceUrl: MOONSHOT_CN_PRICING_URL,
      sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    })
    expect(models[2]?.maxOutput).toBeUndefined()
    expect(models[2]?.factSources?.contextWindow).toBeUndefined()
    for (const model of models) {
      expect(model.pricing).toMatchObject({
        price: { currency: ['CNY', expect.anything() as unknown] },
      })
    }
    // A priced id the chat spec does not map stays unclassified.
    expect(models[6]?.activity).toBeUndefined()
  })

  it('syncs the published spec and binds chat rows to its chat route', async () => {
    stubFetch(JSON.stringify(SPEC))
    const spec = await provider.fetchSpec({})
    expect(spec.skipped).toBeUndefined()
    expect(spec.sources[0]?.url).toBe(MOONSHOT_CN_OPENAPI_URL)
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/files', {})).toBeNull()
    expect(
      provider.generationEndpointId?.({ rawId: 'kimi-k3', activity: 'chat' }),
    ).toBe('v1/chat/completions')
  })

  it('rejects a 200 that is a docs page, not the spec', async () => {
    stubFetch('<!doctype html><html><body>快速开始</body></html>')
    await expect(provider.fetchSpec({})).rejects.toThrow()
    await expect(provider.listModels({})).rejects.toThrow()
  })
})

describe('parseMoonshotCnPricing', () => {
  it('reads each column by its title', () => {
    const parsed = prices(PRICING)
    expect([...parsed.keys()]).toEqual([
      'kimi-k3.1-pro',
      'kimi-k3.1-pro-highspeed',
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
      'kimi-unmapped',
    ])
    expect(parsed.get('kimi-k2.6')).toEqual({
      cache_read_tokens: 1.1 / 1e6,
      input_tokens: 6.5 / 1e6,
      output_tokens: 27 / 1e6,
    })
  })

  it.each([
    ['a unit suffix', '`¥1.10 / MTok`', '`¥1.10 / MTok（限时）`'],
    ['two prices in one cell', '`¥1.10 / MTok`', '`¥2.20 ¥1.10 / MTok`'],
    ['a dollar price', '`¥1.10 / MTok`', '`$1.10 / MTok`'],
    [
      'a cell that is not text',
      '`¥1.10 / MTok`',
      '_jsx(_components.del,{children:`¥1.10 / MTok`})',
    ],
    ['another unit', '`¥1.10 / MTok`', '`¥1.10 / KTok`'],
  ])('leaves a row with %s unpriced', (_name, from, to) => {
    const page = PRICING.replace(from, to)
    expect(page).not.toBe(PRICING)
    const parsed = prices(page)
    expect(parsed.has('kimi-k2.6')).toBe(false)
    expect(parsed.has('kimi-k3')).toBe(true)
  })

  it('prices no row of a table with a column it does not know', () => {
    const page = PRICING.replace(
      '{title:`输出`,width:`22%`}',
      '{title:`输出（批量）`,width:`22%`}',
    )
    expect(page).not.toBe(PRICING)
    expect([...prices(page).keys()]).toEqual(K3_IDS)
  })

  it('never stores a batch table as the standard price', () => {
    const batch = PRICING.replace(
      '_jsx(Heading,{level:`2`,id:`计费基本概念`',
      '_jsx(Heading,{level:`3`,id:`批量价格`,children:`批量价格`}),' +
        '_jsx(DocTable,{columns:[{title:`模型`},{title:`输入`},' +
        '{title:`输出`},{title:`缓存命中`}],' +
        'rows:[[`kimi-k2.6`,`¥3.25 / MTok`,`¥13.50 / MTok`,`¥0.55 / MTok`]]}),' +
        '_jsx(Heading,{level:`2`,id:`计费基本概念`',
    )
    expect(batch).not.toBe(PRICING)
    // Beside the standard row, and with the standard table retitled.
    expect(prices(batch).has('kimi-k2.6')).toBe(false)
    const retitled = batch.replace(
      '{title:`输出`,width:`22%`}',
      '{title:`输出（标准）`,width:`22%`}',
    )
    expect([...prices(retitled).keys()]).toEqual(K3_IDS)
    // The same tables outside `## 模型定价` are not prices at all.
    expect(() =>
      prices(PRICING.replace('children:`模型定价`', 'children:`批量定价`')),
    ).toThrow('priced no ids')
  })

  it('refuses an id two rows price', () => {
    const page = PRICING.replace('`kimi-unmapped`', '`kimi-k3`')
    expect(prices(page).has('kimi-k3')).toBe(false)
  })

  it('throws on a price row whose id is not plain text', () => {
    const page = PRICING.replace(
      '[`kimi-unmapped`',
      '[_jsx(_components.code,{children:`kimi-k3`})',
    )
    expect(page).not.toBe(PRICING)
    expect(() => prices(page)).toThrow('a price row has no readable id')
  })

  it('throws when nothing is priced', () => {
    expect(() => prices(PRICING.replaceAll('¥', '$'))).toThrow(
      'moonshotai-cn: pricing page priced no ids',
    )
  })
})

describe('moonshotai-cn pricing page fetch', () => {
  it('names the pricing url and budget when the listing times out', async () => {
    globalThis.fetch = () =>
      Promise.reject(
        new DOMException(
          'The operation was aborted due to timeout',
          'TimeoutError',
        ),
      )
    await expect(provider.listModels({})).rejects.toThrow(
      `fetch failed: ${MOONSHOT_CN_PRICING_URL} → timeout after 20000ms`,
    )
  })

  it('refuses a page answered by another host', async () => {
    const response = new Response(PRICING)
    Object.defineProperty(response, 'url', {
      value: 'https://platform.kimi.ai/docs/pricing/chat',
    })
    globalThis.fetch = () => Promise.resolve(response)
    await expect(provider.listModels({})).rejects.toThrow(
      'answered by platform.kimi.ai',
    )
  })
})

describe('modelBranchSchemas', () => {
  it('walks one model’s branch, not the whole union', () => {
    const schemas = SPEC.components?.schemas ?? {}
    const body = SPEC.paths?.['/v1/chat/completions']?.post?.requestBody as {
      content: Record<string, { schema: Record<string, unknown> }>
    }
    // The stored shape: refs under `$defs`, the mapping left as published.
    const bundled: unknown = JSON.parse(
      JSON.stringify({
        ...body.content['application/json']?.schema,
        $defs: schemas,
      }).replaceAll('"$ref":"#/components/schemas/', '"$ref":"#/$defs/'),
    )
    const meta = { derivation: 'upstream-spec', endpointId: 'x' } as const
    const flags = Object.fromEntries(
      modelBranchSchemas(bundled).map(([rawId, branch]) => [
        rawId,
        walkRequestSchema(branch, meta)?.flags ?? [],
      ]),
    )
    expect(flags['kimi-k3']).toContain('reasoning_effort')
    expect(flags['kimi-k3']).not.toContain('reasoning')
    expect(flags['kimi-k2.6']).toContain('reasoning')
    expect(flags['kimi-k2.6']).not.toContain('reasoning_effort')
    expect(flags['kimi-k2.6']).toEqual(
      expect.arrayContaining(['tools', 'tool_choice', 'structured_outputs']),
    )
    expect(walkRequestSchema(bundled, meta)?.flags).toEqual(
      expect.arrayContaining(['reasoning', 'reasoning_effort']),
    )
    expect(modelBranchSchemas({ properties: { model: {} } })).toEqual([])
  })

  it('keeps the fields the union shares beside its branches', () => {
    const schema = {
      properties: { tools: {}, temperature: {} },
      allOf: [{ properties: { top_p: {} } }],
      oneOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/B' }],
      discriminator: {
        propertyName: 'model',
        mapping: { a: '#/components/schemas/A', b: '#/components/schemas/B' },
      },
      $defs: {
        A: { properties: { reasoning_effort: {} } },
        B: { properties: { thinking: {} } },
      },
    }
    const meta = { derivation: 'upstream-spec', endpointId: 'x' } as const
    const flags = Object.fromEntries(
      modelBranchSchemas(schema).map(([rawId, branch]) => [
        rawId,
        [...(walkRequestSchema(branch, meta)?.flags ?? [])].sort(),
      ]),
    )
    expect(flags).toEqual({
      a: ['reasoning_effort', 'temperature', 'tools', 'top_p'],
      b: ['reasoning', 'temperature', 'tools', 'top_p'],
    })
  })
})

it('binds replay only to named native Kimi models', async () => {
  stubFetch(JSON.stringify(SPEC))
  const models = (await provider.listModels({})).models
  const kimi = models.find((model) => model.rawId === 'kimi-k2.6')
  expect(kimi?.requestMap?.replayReasoningContent).toBe(true)
  expect(kimi?.factSources?.requestMap?.sourceUrl).toBe(KIMI_CN_THINKING_URL)
  expect(
    models.find((model) => model.rawId === 'kimi-unmapped')?.requestMap,
  ).toBeUndefined()
})
