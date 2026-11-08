import type { BrowserRunContentOptions } from '@cloudflare/workers-types'
import { Validator } from '@cfworker/json-schema'
import { afterEach, expect, it } from 'vitest'
import { cardCurrency, price } from '@modelschemas/rate-card'
import { classifyAndBundle } from '../../ingest/sync.ts'
import fixtures from '../fixtures/ant-ling-docs.json'
import sourceFailure from '../fixtures/ant-ling-native-source-failure.json'
import seriesThinking from '../fixtures/ant-ling-openai-series-thinking.json'
import reasoningEffort from '../fixtures/ant-ling-openai-reasoning-effort.json'
import noEffort from '../fixtures/ant-ling-openai-no-effort.json'
import {
  ANT_OPENAI,
  ANT_PRICE,
  nativePrices,
  nativeRequest,
} from '../ant-ling-docs.ts'
import { provider } from './ant-ling.ts'
import { sha256Text } from '../types.ts'
import type { ProviderEnvironment } from '../types.ts'

const native = fixtures as Record<string, string>
const originalFetch = globalThis.fetch
let nativeEnv: ProviderEnvironment = {}
function serve(overrides: Record<string, string> = {}) {
  const urls: Array<string> = []
  nativeEnv = {
    BROWSER: {
      quickAction: async (action: string, options: { url?: string }) => {
        if (action !== 'content' || !options.url)
          throw new Error('unexpected browser action')
        const url = options.url
        urls.push(url)
        const body = overrides[url] ?? native[url]
        if (body === undefined) throw new Error(`unexpected source ${url}`)
        return Response.json({
          success: true,
          result: body,
          meta: { status: 200, finalUrl: url, title: 'native fixture' },
        })
      },
    } as unknown as Pick<BrowserRun, 'quickAction'>,
  }
  return urls
}
afterEach(() => {
  globalThis.fetch = originalFetch
})
it('refreshes direct IDs, CNY sale/free rates and hosted contexts without a key', async () => {
  const urls = serve()
  const fetched = await provider.listModels(nativeEnv)
  expect(fetched.skipped).toBeUndefined()
  expect(fetched.models).toHaveLength(8)
  const flagship = fetched.models.find((m) => m.rawId === 'Ling-2.6-1T')
  expect(flagship?.contextWindow).toBe(256000)
  expect(flagship?.pricing).toMatchObject({
    tables: {
      rate: {
        base: {
          input_tokens: 4.5 / 1e6,
          output_tokens: 18 / 1e6,
          cache_read_tokens: 0.9 / 1e6,
        },
      },
    },
  })
  const flash = fetched.models.find((m) => m.rawId === 'Ling-3.0-flash')
  expect(
    cardCurrency(flash?.pricing as Parameters<typeof cardCurrency>[0]),
  ).toBe('CNY')
  expect(flash?.pricing).toMatchObject({
    tables: {
      rate: {
        base: {
          input_tokens: 0.125 / 1e6,
          output_tokens: 0.375 / 1e6,
          cache_read_tokens: 0.025 / 1e6,
        },
      },
    },
  })
  const free = fetched.models.find((m) => m.rawId === 'Ling-3.1-flash')
  expect(price(free?.pricing as Parameters<typeof price>[0], {})).toBe(0)
  expect(
    fetched.models.find((m) => m.rawId === 'AntAngelMed')?.pricing,
  ).toBeNull()
  expect(
    fetched.models.find((m) => m.rawId === 'Ling-3.0-tiny')?.contextWindow,
  ).toBeNull()
  expect(fetched.models.every((m) => m.maxOutput === null)).toBe(true)
  expect(
    urls.every((url) =>
      url.startsWith('https://developer.ant-ling.com/en/docs/'),
    ),
  ).toBe(true)
})
it('keeps scoped native reasoning bodies and unknown max_tokens null', async () => {
  serve()
  const { models } = await provider.listModels(nativeEnv)
  const ring = models.find((m) => m.rawId === 'Ring-2.6-1T')
  expect(ring).toMatchObject({
    reasoning: { mode: 'effort', mandatory: null, efforts: ['high', 'xhigh'] },
    requestMap: {
      thinking: {
        on: { reasoning: { effort: 'high' } },
        off: null,
        levels: { high: 'high', xhigh: 'xhigh', medium: null },
      },
      maxTokensField: null,
    },
  })
  const flash = models.find((m) => m.rawId === 'Ling-3.0-flash')
  expect(flash?.requestMap?.thinking).toMatchObject({
    on: { thinking: { type: 'enabled' } },
    off: { thinking: { type: 'disabled' } },
  })
  expect(
    models.find((m) => m.rawId === 'Ling-2.6-1T')?.requestMap?.thinking,
  ).toBeNull()
  expect(
    models.find((m) => m.rawId === 'Ling-3.0-flash-VL')?.modalities,
  ).toEqual({ input: ['text', 'image', 'video'], output: ['text'] })
})
it('binds the thinking toggle to every id in the series the page names', async () => {
  serve({ [ANT_OPENAI]: seriesThinking.html })
  const { models } = await provider.listModels(nativeEnv)
  const toggle = {
    on: { thinking: { type: 'enabled' } },
    off: { thinking: { type: 'disabled' } },
    levels: null,
  }
  for (const id of [
    'Ling-3.1-flash',
    'Ling-3.0-flash-VL',
    'Ling-3.0-flash',
    'Ling-3.0-tiny',
  ]) {
    const row = models.find((m) => m.rawId === id)
    expect(row?.reasoning).toEqual({ mode: 'toggle', mandatory: false })
    expect(row?.requestMap?.thinking).toEqual(toggle)
  }
  for (const id of ['Ling-2.6-1T', 'Ling-2.6-flash', 'AntAngelMed']) {
    const row = models.find((m) => m.rawId === id)
    expect(row?.reasoning).toBeNull()
    expect(row?.requestMap?.thinking).toBeNull()
  }
  expect(models.find((m) => m.rawId === 'Ring-2.6-1T')?.reasoning).toEqual({
    mode: 'effort',
    mandatory: null,
    efforts: ['high', 'xhigh'],
  })
})
it('reads the top-level reasoning_effort string the page replaced reasoning.effort with', async () => {
  serve({ [ANT_OPENAI]: reasoningEffort.html })
  const { models } = await provider.listModels(nativeEnv)
  const ring = models.find((m) => m.rawId === 'Ring-2.6-1T')
  expect(ring?.reasoning).toEqual({
    mode: 'effort',
    mandatory: null,
    efforts: ['high', 'xhigh'],
  })
  expect(ring?.requestMap?.thinking).toMatchObject({
    off: null,
    levels: { high: 'high', xhigh: 'xhigh', medium: null },
  })
  expect(ring?.requestMap?.thinking?.on).toEqual({ reasoning_effort: 'high' })
  for (const id of ['Ling-3.0-flash', 'Ling-3.1-flash'])
    expect(models.find((m) => m.rawId === id)?.reasoning).toEqual({
      mode: 'toggle',
      mandatory: false,
    })
  expect(models.find((m) => m.rawId === 'Ling-2.6-1T')?.reasoning).toBeNull()
  const input = nativeRequest(reasoningEffort.html)
  expect(
    (input.properties as Record<string, unknown>).reasoning_effort,
  ).toMatchObject({ type: 'string', enum: ['high', 'xhigh'], default: 'high' })
  const bundled = classifyAndBundle(
    provider,
    await provider.fetchSpec(nativeEnv),
  )
  expect(bundled.endpoints).toHaveLength(1)
})
it('reads a reference that dropped reasoning_effort with Ring as no effort model', async () => {
  serve({ [ANT_OPENAI]: noEffort.html })
  const { models } = await provider.listModels(nativeEnv)
  for (const id of [
    'Ling-3.1-flash',
    'Ling-3.0-flash-VL',
    'Ling-3.0-flash',
    'Ling-3.0-tiny',
  ]) {
    const row = models.find((m) => m.rawId === id)
    expect(row?.reasoning).toEqual({ mode: 'toggle', mandatory: false })
    expect(row?.requestMap?.thinking).toEqual({
      on: { thinking: { type: 'enabled' } },
      off: { thinking: { type: 'disabled' } },
      levels: null,
    })
  }
  expect(models.some((m) => m.reasoning?.mode === 'effort')).toBe(false)
  expect(models.find((m) => m.rawId === 'Ring-2.6-1T')?.requestMap).toBeNull()
  expect(
    models.find((m) => m.rawId === 'Ming-3.0-audio-flash')?.modalities,
  ).toEqual({ input: ['text', 'audio'], output: ['text'] })
  expect(
    models.find((m) => m.rawId === 'Ling-3.0-flash-VL')?.modalities,
  ).toEqual({ input: ['text', 'image', 'video'], output: ['text'] })
  expect(models.find((m) => m.rawId === 'Ling-3.0-flash')?.modalities).toEqual({
    input: ['text'],
    output: ['text'],
  })
})
it('reads a "natively accepts ... with native multimodal understanding" statement', async () => {
  const html = noEffort.html.replace(
    'the request accepts text, images, and videos.',
    'the request natively accepts text, images, and videos with native multimodal understanding.',
  )
  expect(html).not.toBe(noEffort.html)
  serve({ [ANT_OPENAI]: html })
  const { models } = await provider.listModels(nativeEnv)
  expect(
    models.find((m) => m.rawId === 'Ling-3.0-flash-VL')?.modalities,
  ).toEqual({ input: ['text', 'image', 'video'], output: ['text'] })
})
it('fails an input-modality statement it cannot read', async () => {
  for (const html of [
    noEffort.html.replace('accepts text and audio', 'accepts text and smell'),
    noEffort.html.replace(
      'the request accepts text, images, and videos',
      'the request also accepts text, images, and videos',
    ),
  ]) {
    expect(html).not.toBe(noEffort.html)
    serve({ [ANT_OPENAI]: html })
    await expect(provider.listModels(nativeEnv)).rejects.toThrow(
      /unreadable native input modality smell|missing native multimodal applicability/,
    )
  }
})
it('fails a reasoning_effort it cannot scope or whose default is no option', async () => {
  const detailDefault =
    'default <code class="nextra-code" dir="ltr">high</code>'
  const overviewDefault =
    /(<td[^>]*>\s*)<code class="nextra-code" dir="ltr">high<\/code>/
  const description =
    'Controls how much reasoning depth Ring-2.6-1T applies when responding.'
  const cases: Array<[string, RegExp]> = [
    [
      reasoningEffort.html.replace('(Ring-2.6-1T only)', ''),
      /unreadable reasoning_effort applicability/,
    ],
    [
      reasoningEffort.html.replace(
        description,
        'Only takes effect for Ring-3.0-1T.',
      ),
      /conflicting reasoning_effort applicability/,
    ],
    [
      reasoningEffort.html.replace(
        description,
        'Controls reasoning depth. Supported by 2.6 series models.',
      ),
      /conflicting reasoning_effort applicability/,
    ],
    [
      reasoningEffort.html.replace(
        description,
        'Controls how much reasoning depth Ring-3.0-1T applies when responding.',
      ),
      /conflicting reasoning_effort applicability/,
    ],
    [
      reasoningEffort.html.replace(
        detailDefault,
        'default <code class="nextra-code" dir="ltr">max</code>',
      ),
      /reasoning_effort defaults disagree/,
    ],
    [
      reasoningEffort.html.replace(detailDefault, ''),
      /reasoning_effort default unstated/,
    ],
    [
      reasoningEffort.html.replace(
        description,
        'Controls how much reasoning depth Ring-2.6-1T-mini applies when responding.',
      ),
      /conflicting reasoning_effort applicability/,
    ],
    [
      reasoningEffort.html.replace(
        overviewDefault,
        '$1<code class="nextra-code" dir="ltr">xhigh</code>',
      ),
      /reasoning_effort defaults disagree/,
    ],
    [
      reasoningEffort.html
        .replace(
          detailDefault,
          'default <code class="nextra-code" dir="ltr">max</code>',
        )
        .replace(
          overviewDefault,
          '$1<code class="nextra-code" dir="ltr">max</code>',
        ),
      /unknown parameter default/,
    ],
    [
      reasoningEffort.html.replace(
        '<h3 id="thinking"',
        '<h3 id="reasoning">reasoning</h3><ul><li><strong>Description</strong>: Only takes effect for Ring-2.6-1T.</li></ul><h4 id="reasoningeffort">reasoning.effort</h4><ul><li><strong>Type</strong>: <code>string</code></li></ul><h3 id="thinking"',
      ),
      /two native effort fields/,
    ],
  ]
  const search = reasoningEffort.html
    .replace(
      /(<code class="nextra-code" dir="ltr">enable_search<\/code><\/td>(?:<td[^>]*>[\s\S]*?<\/td>){2}<td[^>]*>)<code class="nextra-code" dir="ltr">false<\/code>/,
      '$1<code class="nextra-code" dir="ltr">auto</code>',
    )
    .replace(
      'Whether to allow the model to use web search.</li>',
      'Whether to allow the model to use web search.</li><li><strong>Options</strong>:<ul><li><code>auto</code></li></ul></li>',
    )
  expect(search).not.toBe(reasoningEffort.html)
  expect(() => nativeRequest(search)).toThrow('unknown parameter default')
  for (const [html, error] of cases) {
    expect(html).not.toBe(reasoningEffort.html)
    serve({ [ANT_OPENAI]: html })
    await expect(provider.listModels(nativeEnv)).rejects.toThrow(error)
  }
})
it('fails thinking scopes it cannot read as stated support', async () => {
  const sentence = 'Supported by 3.0 series models and 3.1 series models.'
  const cases: Array<[string, RegExp]> = [
    [
      seriesThinking.html.replace(
        sentence,
        'Supported by 3.0 series models and 4.0 series models.',
      ),
      /no native model in the 4\.0 series/,
    ],
    [
      seriesThinking.html.replace(sentence, `Not s${sentence.slice(1)}`),
      /unreadable thinking applicability/,
    ],
    [
      seriesThinking.html.replace(
        sentence,
        `${sentence} Not supported by Ling-3.0-tiny.`,
      ),
      /unreadable thinking applicability/,
    ],
    [
      seriesThinking.html.replace(
        '3.0 series models and 3.1 series models enable reasoning',
        '3.0 series models enable reasoning',
      ),
      /thinking\.type names other models than thinking/,
    ],
    [
      seriesThinking.html.replaceAll(
        '3.0 series models and 3.1 series models',
        '2.6 series models',
      ),
      /a model has both native reasoning controls/,
    ],
  ]
  for (const [html, error] of cases) {
    serve({ [ANT_OPENAI]: html })
    await expect(provider.listModels(nativeEnv)).rejects.toThrow(error)
  }
})
it('derives native parameter tables and nested constraints without borrowing a schema', async () => {
  serve()
  const fetched = await provider.fetchSpec(nativeEnv)
  const bundled = classifyAndBundle(provider, fetched)
  expect(bundled.endpoints).toHaveLength(1)
  expect(bundled.endpoints[0]?.input).toBeTruthy()
  expect(bundled.endpoints[0]?.output).toBeUndefined()
  const input = nativeRequest(native[ANT_OPENAI] ?? '')
  expect(
    (input.properties as Record<string, Record<string, unknown>>).model?.[
      'x-source-options'
    ],
  ).toContain('Ring-2.6-1T')
  expect(input).toMatchObject({
    required: ['model', 'messages'],
    properties: {
      temperature: { type: 'number', minimum: 0, maximum: 1 },
      top_p: { exclusiveMinimum: 0, maximum: 1 },
      messages: {
        items: {
          required: ['role', 'content'],
          properties: { role: { enum: ['system', 'user', 'assistant'] } },
        },
      },
    },
  })
  expect(
    (input.properties as Record<string, { enum?: unknown }>).model?.enum,
  ).toBeUndefined()
  expect(
    (input.properties as Record<string, unknown>).max_tokens,
  ).toBeUndefined()
})
it('ignores all reseller USD rows, including conflicting later rates', () => {
  const prices = nativePrices(native[ANT_PRICE] ?? '')
  expect(prices.get('Ling-2.6-1T')?.rates.input_tokens).toBe(4.5 / 1e6)
  expect(
    nativePrices((native[ANT_PRICE] ?? '').replace('$0.30', '$999999')).get(
      'Ling-2.6-1T',
    ),
  ).toEqual(prices.get('Ling-2.6-1T'))
})
it('fails missing sale amounts, missing price sections and changed field types', () => {
  const source = native[ANT_PRICE] ?? ''
  expect(() =>
    nativePrices(
      source.replace('<span>¥0.14</span>', '<span>unreadable</span>'),
    ),
  ).toThrow('unreadable current CNY price')
  expect(() =>
    nativePrices(source.replace('id="model-pricing"', 'id="changed-pricing"')),
  ).toThrow('missing model-pricing')
  expect(() =>
    nativeRequest(
      (native[ANT_OPENAI] ?? '').replace(
        '<code>double</code>',
        '<code>unknown-unit</code>',
      ),
    ),
  ).toThrow('unknown native field type')
})
it('reads each price unit from its own column and lists per-image rows without a token card', async () => {
  const source = native[ANT_PRICE] ?? ''
  const image =
    '<tr><td><strong>Ming-Image-0.1-Design</strong></td><td>Design image generation</td><td>—</td><td>—</td><td><del>¥0.10</del> <span>¥0.03</span></td><td>image</td><td>—</td><td>—</td></tr>'
  const withImage = source.replace('</tbody>', `${image}</tbody>`)
  serve({ [ANT_PRICE]: withImage })
  const { models } = await provider.listModels(nativeEnv)
  const ming = models.find((m) => m.rawId === 'Ming-Image-0.1-Design')
  expect(ming?.pricing).toBeNull()
  expect(ming?.absent).toBeUndefined()
  expect(models.find((m) => m.rawId === 'Ling-2.6-1T')?.pricing).not.toBeNull()
  expect(() =>
    nativePrices(withImage.replace('<td>image</td>', '<td>1K characters</td>')),
  ).toThrow('unreadable direct price units for Ming-Image-0.1-Design')
  expect(() =>
    nativePrices(
      withImage.replace(
        '<td>—</td><td>—</td><td><del>',
        '<td>¥0.01</td><td>—</td><td><del>',
      ),
    ),
  ).toThrow('unreadable direct price units for Ming-Image-0.1-Design')
  expect(() =>
    nativePrices(withImage.replace('<span>¥0.03</span>', '<span>free</span>')),
  ).toThrow('unreadable current CNY price')
  expect(() =>
    nativePrices(source.replace('<td>1M tokens</td>', '<td>1K tokens</td>')),
  ).toThrow('unreadable direct price units')
  expect(() =>
    nativePrices(
      source.replace(
        '<th>Input Price</th><th>Unit</th>',
        '<th>Input (per 1M tokens)</th>',
      ),
    ),
  ).toThrow('direct pricing headers changed')
})
it('fails an empty native catalog instead of silently retiring stored rows', async () => {
  serve({
    [ANT_OPENAI]: '<article><h2 id="request-body">Request Body</h2></article>',
  })
  await expect(provider.listModels(nativeEnv)).rejects.toThrow('missing native')
})

it('refreshes newly published model IDs and changes free rows to paid from source', async () => {
  serve({
    [ANT_OPENAI]: (native[ANT_OPENAI] ?? '').replaceAll(
      'AntAngelMed',
      'Native-New-ID',
    ),
  })
  const { models } = await provider.listModels(nativeEnv)
  expect(models.some((m) => m.rawId === 'Native-New-ID')).toBe(true)
  expect(models.some((m) => m.rawId === 'AntAngelMed')).toBe(false)
  const quotes = nativePrices(
    (native[ANT_PRICE] ?? '').replaceAll('¥0.00', '¥1.00'),
  )
  expect(quotes.get('Ling-3.1-flash')).toEqual({
    free: false,
    rates: {
      input_tokens: 1 / 1e6,
      output_tokens: 1 / 1e6,
      cache_read_tokens: 1 / 1e6,
    },
  })
})

it('keeps conflicting content shape unknown without fabricating block schemas', () => {
  const schema = nativeRequest(native[ANT_OPENAI] ?? '')
  const props = schema.properties as Record<string, Record<string, unknown>>
  const message = props.messages!.items as Record<string, unknown>
  const content = (
    message.properties as Record<string, Record<string, unknown>>
  ).content!
  expect(content.type).toBeUndefined()
  expect(content['x-source-type']).toBeNull()
  expect(content['x-source-declared-type']).toBe('string')
  expect(content['x-source-conflicting-statement']).toContain(
    'the request accepts text, images, and videos',
  )
  expect(content.items).toBeUndefined()
  const result = new Validator(schema).validate({
    model: 'Ling-3.0-flash-VL',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,example' },
          },
          { type: 'text', text: 'Describe' },
        ],
      },
    ],
  })
  expect(result.valid).toBe(true)
})
it('clears missing native prices and binds only API-documented models', async () => {
  serve()
  const models = (await provider.listModels(nativeEnv)).models
  expect(models).toHaveLength(8)
  for (const id of ['AntAngelMed', 'Ling-3.0-tiny']) {
    const m = models.find((candidate) => candidate.rawId === id)
    expect(m?.pricing).toBeNull()
    expect(m?.absent?.pricing).toBe('cleared')
  }
  const newlyPriced = models.find((m) => m.rawId === 'Ling-3.1-flash')
  expect(newlyPriced?.pricing).not.toBeNull()
  expect(newlyPriced?.activity).toBeNull()
  expect(newlyPriced?.schemaEndpointId).toBeNull()
  expect(newlyPriced?.requestMap).toBeNull()
  expect(newlyPriced?.factSources?.schemaEndpointId).toBeUndefined()
  const published = models.find((m) => m.rawId === 'Ling-3.0-flash-VL')
  expect(published?.schemaEndpointId).toBe('v1/chat/completions')
  expect(published?.factSources?.schemaEndpointId).toMatchObject({
    sourceUrl: ANT_OPENAI,
    path: 'Request Address + model.Options',
  })
  expect(provider.generationEndpointId).toBeUndefined()
  expect(provider.bindSyncedRoutesOnly).toBe(true)
})

function docsKv(initial: Record<string, string> = {}) {
  const stored = new Map(Object.entries(initial))
  const writes: Array<string> = []
  const kv = {
    get: async (key: string) => stored.get(key) ?? null,
    put: async (key: string, value: string) => {
      writes.push(key)
      stored.set(key, value)
    },
  } as unknown as KVNamespace
  return { kv, stored, writes }
}
it('rejects the actual production captcha before caching and retries native docs', async () => {
  const { kv, writes } = docsKv()
  serve(
    Object.fromEntries(
      Object.keys(native).map((url) => [url, sourceFailure.html]),
    ),
  )
  await expect(provider.listModels(nativeEnv, kv)).rejects.toThrow(
    `ant-ling: native source ${ANT_OPENAI}: native documentation blocked by Alipay WAF/captcha`,
  )
  expect(writes).toEqual([])
  serve()
  expect((await provider.listModels(nativeEnv, kv)).models).toHaveLength(8)
  expect(writes).toHaveLength(5)
  expect(
    writes.every((key) => key.includes('#cloudflare-browser-content-v1')),
  ).toBe(true)
})
it('validates cached articles and never serves a cached blocked document', async () => {
  const writes: Array<string> = []
  const reads: Array<string> = []
  const kv = {
    get: async (key: string) => {
      reads.push(key)
      return JSON.stringify({
        html: sourceFailure.html,
        hash: 'cached-source-hash',
      })
    },
    put: async (key: string) => {
      writes.push(key)
    },
  } as unknown as KVNamespace
  serve(
    Object.fromEntries(
      Object.keys(native).map((url) => [url, sourceFailure.html]),
    ),
  )
  await expect(provider.listModels(nativeEnv, kv)).rejects.toThrow(
    `ant-ling: native source ${ANT_OPENAI}: native documentation blocked by Alipay WAF/captcha`,
  )
  expect(writes).toEqual([])
  expect(reads).toHaveLength(1)
  expect(
    reads.every((key) => key.endsWith('#cloudflare-browser-content-v1')),
  ).toBe(true)
})
it('reports malformed native HTML with its URL before it can enter the cache', async () => {
  const { kv, writes } = docsKv()
  serve(
    Object.fromEntries(
      Object.keys(native).map((url) => [
        url,
        '<html><body>upstream unavailable</body></html>',
      ]),
    ),
  )
  await expect(provider.listModels(nativeEnv, kv)).rejects.toThrow(
    `ant-ling: native source ${ANT_OPENAI}: ant-ling: missing native article`,
  )
  expect(writes).toEqual([])
})

it('requires the browser binding even if documents are cached', async () => {
  const { kv, writes } = docsKv()
  await expect(provider.listModels({}, kv)).rejects.toThrow(
    `ant-ling: native source ${ANT_OPENAI}: Cloudflare Browser Rendering BROWSER binding is required`,
  )
  await expect(provider.fetchSpec({})).rejects.toThrow(
    'BROWSER binding is required',
  )
  expect(writes).toEqual([])
})
it.each([
  [
    'service failure',
    () => new Response('unavailable', { status: 503 }),
    'request failed: HTTP 503',
  ],
  [
    'invalid JSON',
    () => new Response('<html>bad wrapper</html>'),
    'native source',
  ],
  [
    'unsuccessful result',
    () => Response.json({ success: false, errors: [] }),
    'unreadable',
  ],
  [
    'array result',
    () =>
      Response.json({
        success: true,
        result: [],
        meta: { status: 200, finalUrl: ANT_OPENAI },
      }),
    'unreadable',
  ],
  [
    'missing meta',
    () => Response.json({ success: true, result: native[ANT_OPENAI] }),
    'unreadable',
  ],
  [
    'native HTTP error',
    () =>
      Response.json({
        success: true,
        result: native[ANT_OPENAI],
        meta: { status: 403, finalUrl: ANT_OPENAI },
      }),
    'native page failed',
  ],
  [
    'unreadable native status',
    () =>
      Response.json({
        success: true,
        result: native[ANT_OPENAI],
        meta: { status: '200', finalUrl: ANT_OPENAI },
      }),
    'native page failed',
  ],
  [
    'wrong native host',
    () =>
      Response.json({
        success: true,
        result: native[ANT_OPENAI],
        meta: {
          status: 200,
          finalUrl: 'https://other.example/en/docs/api-reference/openai/',
        },
      }),
    'URL mismatch',
  ],
  [
    'wrong native page',
    () =>
      Response.json({
        success: true,
        result: native[ANT_OPENAI],
        meta: { status: 200, finalUrl: ANT_PRICE },
      }),
    'URL mismatch',
  ],
  [
    'missing final URL',
    () =>
      Response.json({
        success: true,
        result: native[ANT_OPENAI],
        meta: { status: 200 },
      }),
    'URL mismatch',
  ],
] as const)(
  'rejects browser %s without direct-fetch recovery or caching',
  async (_name, response, error) => {
    let directFetches = 0
    globalThis.fetch = async () => {
      directFetches++
      throw new Error('direct fetch must not recover browser errors')
    }
    const browser = { quickAction: async () => response() } as unknown as Pick<
      BrowserRun,
      'quickAction'
    >
    const { kv, writes } = docsKv()
    await expect(provider.listModels({ BROWSER: browser }, kv)).rejects.toThrow(
      error,
    )
    expect(writes).toEqual([])
    expect(directFetches).toBe(0)
  },
)
it('hashes the rendered native HTML and bounds browser source reads sequentially', async () => {
  const urls = serve()
  let active = 0
  let peak = 0
  const browser = nativeEnv.BROWSER!
  const originalAction = browser.quickAction.bind(browser)
  browser.quickAction = (async (action: string, options: { url?: string }) => {
    active++
    peak = Math.max(peak, active)
    try {
      await Promise.resolve()
      return await originalAction(
        action as 'content',
        options as BrowserRunContentOptions,
      )
    } finally {
      active--
    }
  }) as typeof browser.quickAction
  const { models } = await provider.listModels(nativeEnv)
  expect(models).toHaveLength(8)
  expect(urls).toHaveLength(5)
  expect(peak).toBe(1)
  const spec = await provider.fetchSpec(nativeEnv)
  expect(spec.sources).toEqual([
    { url: ANT_OPENAI, hash: await sha256Text(native[ANT_OPENAI]!) },
  ])
})
