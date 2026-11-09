import { requestUrl } from '#/lib/text.ts'
import { evaluateCard } from '@modelschemas/rate-card'
import { afterEach, describe, expect, it } from 'vitest'
import fixtures from '../fixtures/meta-docs.json'
import { provider } from './meta.ts'
import { classifyAndBundle } from '../../ingest/sync.ts'
import {
  META_MODELS,
  META_PRICING,
  META_REFERENCE,
  parseMetaModels,
  parseMetaPricing,
  parseMetaSchemas,
} from '../meta-docs.ts'

const originalFetch = globalThis.fetch
const docs = fixtures as Record<string, string>
const SPARK = 'https://dev.meta.ai/docs/muse-spark'
const WONDER = 'https://dev.meta.ai/docs/muse-wonder'
const pages = {
  'muse-spark': docs[SPARK] ?? '',
  'muse-wonder': docs[WONDER] ?? '',
}
function serve(overrides: Record<string, string> = {}) {
  const urls: Array<string> = []
  globalThis.fetch = async (input) => {
    const url = requestUrl(input)
    urls.push(url)
    const body = overrides[url] ?? docs[url]
    if (body === undefined) throw new Error(`unexpected source ${url}`)
    return new Response(body)
  }
  return urls
}
afterEach(() => {
  globalThis.fetch = originalFetch
})
describe('Meta native docs', () => {
  it('refreshes all nine hosted IDs and their own modes without a key', async () => {
    const urls = serve()
    const { models, skipped } = await provider.listModels({})
    expect(skipped).toBeUndefined()
    expect(models.map((m) => m.rawId)).toEqual([
      'muse-wonder-1.0',
      'muse-spark-1.3',
      'muse-spark-1.3-contributor',
      'muse-spark-1.2',
      'muse-spark-1.2-contributor',
      'muse-spark-1.1',
      'muse-image-1.0',
      'muse-voice-transcribe-1.0',
      'sam-3.1',
    ])
    const spark = models.find((m) => m.rawId === 'muse-spark-1.3')
    const contributor = models.find(
      (m) => m.rawId === 'muse-spark-1.3-contributor',
    )
    const wonder = models.find((m) => m.rawId === 'muse-wonder-1.0')
    expect(spark).toMatchObject({
      displayName: 'Muse Spark 1.3',
      activity: 'chat',
      modalities: {
        input: ['text', 'image', 'video', 'audio', 'pdf'],
        output: ['text'],
      },
      contextWindow: 1048576,
      maxOutput: null,
      capabilities: ['reasoning', 'tools', 'structured_outputs'],
      providerMetadata: { family: 'Muse Spark', tier: 'Standard' },
      reasoning: {
        mandatory: true,
        efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      },
    })
    expect(contributor?.providerMetadata).toEqual({
      family: 'Muse Spark',
      tier: 'Contributor',
    })
    expect(contributor?.reasoning?.efforts).not.toContain('max')
    expect(
      models.find((m) => m.rawId === 'muse-spark-1.2')?.reasoning?.efforts,
    ).not.toContain('max')
    expect(wonder).toMatchObject({
      displayName: 'Muse Wonder',
      activity: 'chat',
      contextWindow: 1048576,
      providerMetadata: { family: 'Muse Wonder', tier: 'Standard' },
      reasoning: {
        mode: 'effort',
        mandatory: true,
        efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      },
    })
    expect(wonder?.pricing).toMatchObject({
      tables: {
        rate: {
          base: {
            input_tokens: 4 / 1e6,
            output_tokens: 20 / 1e6,
            cache_read_tokens: 0.2 / 1e6,
          },
        },
      },
    })
    expect(spark?.pricing).toMatchObject({
      tables: {
        rate: {
          base: {
            input_tokens: 1.25 / 1e6,
            output_tokens: 4.25 / 1e6,
            cache_read_tokens: 0.15 / 1e6,
          },
        },
      },
    })
    expect(contributor?.pricing).toMatchObject({
      tables: {
        rate: {
          base: {
            input_tokens: 0.1 / 1e6,
            output_tokens: 0.2 / 1e6,
            cache_read_tokens: 0.002 / 1e6,
          },
        },
      },
    })
    expect(models.find((m) => m.rawId === 'muse-spark-1.1')?.pricing).toEqual(
      spark?.pricing,
    )
    expect(
      models
        .filter((m) => m.activity !== 'chat')
        .map((m) => [m.rawId, m.displayName]),
    ).toEqual([
      ['muse-image-1.0', 'Muse Image'],
      ['muse-voice-transcribe-1.0', 'Muse Voice Transcribe'],
      ['sam-3.1', 'Segment Anything Model'],
    ])
    expect(
      models.find((m) => m.rawId === 'muse-image-1.0')?.pricing,
    ).toMatchObject({ tables: { rate: { base: { generated_images: 0.01 } } } })
    expect(
      models.find((m) => m.rawId === 'muse-voice-transcribe-1.0')?.pricing,
    ).toMatchObject({
      tables: { rate: { base: { audio_seconds: 0.18 / 3600 } } },
    })
    expect(models.find((m) => m.rawId === 'sam-3.1')?.pricing).toMatchObject({
      tables: {
        rate: {
          base: { segmented_images: 2.5 / 1000, video_frames: 0.2 / 1000 },
        },
      },
    })
    expect(
      urls.every((url) => url.startsWith('https://dev.meta.ai/docs/')),
    ).toBe(true)
  })
  it('reads native chat, image and ASR schema resources and POST references', async () => {
    const urls = serve()
    const fetched = await provider.fetchSpec({})
    expect(fetched.skipped).toBeUndefined()
    expect(fetched.specs).toHaveLength(6)
    expect(fetched.sources).toHaveLength(6)
    const bundled = classifyAndBundle(provider, fetched)
    expect(bundled.warnings).toEqual([])
    expect(bundled.endpoints).toHaveLength(6)
    expect(
      bundled.endpoints.every((endpoint) => endpoint.input && endpoint.output),
    ).toBe(true)
    expect(fetched.specs.map((s) => Object.keys(s.paths ?? {}))).toEqual([
      ['/v1/chat/completions'],
      ['/v1/responses'],
      ['/v1/messages'],
      ['/v1/images/generations'],
      ['/v1/images/edits'],
      ['/v1/asr/transcribe'],
    ])
    expect(
      urls.every((url) => url.startsWith('https://dev.meta.ai/docs/')),
    ).toBe(true)
  })
  it('preserves nested array fields, explicit required markers, enums and constraints', () => {
    const schemas = parseMetaSchemas(
      docs[`${META_REFERENCE}chat-completions/schemas`] ?? '',
    )
    expect(schemas['create-chat-completion-request']).toMatchObject({
      required: ['messages', 'model'],
      properties: {
        messages: { type: 'array', minItems: 1 },
        top_logprobs: { minimum: 0, maximum: 20 },
      },
    })
    expect(schemas['create-chat-completion-response']).toMatchObject({
      properties: {
        choices: {
          items: {
            properties: {
              finish_reason: {
                enum: [
                  'stop',
                  'length',
                  'tool_calls',
                  'content_filter',
                  'function_call',
                ],
              },
            },
          },
        },
      },
    })
    const response = parseMetaSchemas(
      docs[`${META_REFERENCE}responses/schemas`] ?? '',
    )
    expect(
      Object.values(response).some((schema) =>
        JSON.stringify(schema).includes('"x-source-type":null'),
      ),
    ).toBe(true)
  })
  it('preserves native multipart content and marks ASR unpublished fields unknown', async () => {
    serve()
    const fetched = await provider.fetchSpec({})
    const edits = fetched.specs[4]?.paths?.['/v1/images/edits']?.post
    expect(edits?.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/edit-image-body-json-param' },
        },
        'multipart/form-data': {
          schema: { $ref: '#/components/schemas/create-image-edit-request' },
        },
      },
    })
    const asr = fetched.specs[5]?.paths?.['/v1/asr/transcribe']?.post
    expect(asr?.requestBody).toMatchObject({
      content: {
        'multipart/form-data': {
          schema: { type: 'object', 'x-source-fields': null },
        },
      },
    })
    expect(
      provider.generationEndpointId?.({
        activity: 'audio',
        rawId: 'muse-voice-transcribe-1.0',
      }),
    ).toBe('v1/asr/transcribe')
  })

  it('fails an empty source instead of removing stored rows', async () => {
    serve({ [META_MODELS]: '<h1>Models</h1>' })
    await expect(provider.listModels({})).rejects.toThrow(
      'model table listed no models',
    )
  })
  it('leaves pricing null when the provider publishes no quote for a newly listed model', () => {
    const models = parseMetaModels(docs[META_MODELS] ?? '', pages)
    models.push({
      rawId: 'synthetic-unsourced',
      providerMetadata: { family: 'Synthetic' },
    })
    const prices = parseMetaPricing(docs[META_PRICING] ?? '', models, {
      url: META_PRICING,
      hash: 'fixture',
      extractedAt: '2026-10-09',
    })
    expect(prices.has('synthetic-unsourced')).toBe(false)
  })
  it('fails unknown types and structurally missing schema cells', () => {
    const source = docs[`${META_REFERENCE}chat-completions/schemas`] ?? ''
    expect(() =>
      parseMetaSchemas(
        source.replace('integer (unixtime)', 'undocumented-primitive'),
      ),
    ).toThrow('unknown schema type')
    expect(() =>
      parseMetaSchemas(source.replace(/<td\b[^>]*>[\s\S]*?<\/td>/, '')),
    ).toThrow('schema field row changed')
  })
  it('rejects malformed published quotes rather than filling old amounts', () => {
    const models = parseMetaModels(docs[META_MODELS] ?? '', pages)
    expect(() =>
      parseMetaPricing(
        (docs[META_PRICING] ?? '').replace('$1.25', '$unknown'),
        models,
        { url: META_PRICING, hash: 'fixture', extractedAt: '2026-10-09' },
      ),
    ).toThrow('unreadable token price')
    expect(() =>
      parseMetaPricing(
        (docs[META_PRICING] ?? '').replace('$0.01 per image', '$0.01'),
        models,
        { url: META_PRICING, hash: 'fixture', extractedAt: '2026-10-12' },
      ),
    ).toThrow('unreadable image price')
  })
  it('fails a models page whose chat tables it cannot read instead of dropping them', async () => {
    const models = docs[META_MODELS] ?? ''
    const spark = docs[SPARK] ?? ''
    for (const [overrides, error] of [
      [
        {
          [SPARK]: spark.replace(
            '<th>Version</th><th>Model API (pay-as-you-go)</th>',
            '<th>Version</th><th>Model API</th>',
          ),
        },
        'model availability headers changed',
      ],
      [
        { [SPARK]: spark.replace('<th>Version</th>', '<th>Edition</th>') },
        'missing model availability table',
      ],
      [
        {
          [META_MODELS]: models.replace(
            '<code>muse-spark-1.1</code>',
            '<code>muse-spark-1.0</code>',
          ),
        },
        'Muse Spark page disagrees with the model table',
      ],
      [
        {
          [META_MODELS]: models
            .replaceAll('<th>Context window</th>', '')
            .replaceAll('<td>1,048,576 tokens</td>', '')
            .replace(
              ', <code>muse-spark-1.2</code>, <code>muse-spark-1.1</code>',
              '',
            ),
        },
        'model page listed no chat models',
      ],
      [
        {
          [SPARK]: spark.replace(
            '<td><strong>Input</strong></td>',
            '<td><strong>Inputs</strong></td>',
          ),
        },
        'missing model modalities',
      ],
      [
        { [SPARK]: spark.replace('1,048,576 tokens', 'about a million') },
        'unreadable model context',
      ],
      [
        {
          [SPARK]: spark.replace(
            '<td>Contributor mode</td>',
            '<td>Discounted mode</td>',
          ),
        },
        'unreadable model availability',
      ],
    ] as const) {
      serve(overrides)
      await expect(provider.listModels({})).rejects.toThrow(error)
    }
  })
  it('reads every output modality the line page states', () => {
    const models = parseMetaModels(docs[META_MODELS] ?? '', {
      ...pages,
      'muse-wonder': pages['muse-wonder'].replace(
        '<td><strong>Output</strong></td><td>Text</td>',
        '<td><strong>Output</strong></td><td>Text and images</td>',
      ),
    })
    expect(
      models.find((m) => m.rawId === 'muse-wonder-1.0')?.modalities,
    ).toEqual({
      input: ['text', 'image', 'video', 'audio', 'pdf'],
      output: ['text', 'images'],
    })
  })
  it('fails token prices whose mode is unstated, ambiguous or contradicts the model tier', () => {
    const models = parseMetaModels(docs[META_MODELS] ?? '', pages)
    const page = docs[META_PRICING] ?? ''
    for (const [html, error] of [
      [
        page.replace(' in Contributor mode', ' as variants'),
        'token price mode unstated',
      ],
      [
        page.replace(
          ' in Contributor mode',
          ' in Contributor mode or in Standard mode',
        ),
        'ambiguous token price mode',
      ],
      [
        page.replace(' in Contributor mode', ' in Standard mode'),
        'token price mode disagrees with model tier',
      ],
      [
        page.replace(
          'and <code>muse-spark-1.1</code> in Standard mode',
          'and <code>muse-spark-1.1</code> in Standard mode; <code>muse-spark-1.1</code> in Standard mode',
        ),
        'duplicate model price',
      ],
      [page.replace('$0.10', 'Not available'), 'incomplete token pricing'],
    ] as const)
      expect(() =>
        parseMetaPricing(html, models, {
          url: META_PRICING,
          hash: 'fixture',
          extractedAt: '2026-10-12',
        }),
      ).toThrow(error)
  })
  it('fails a family price table it does not recognise instead of clearing the price', () => {
    const models = parseMetaModels(docs[META_MODELS] ?? '', pages)
    const page = docs[META_PRICING] ?? ''
    const wonder = page.indexOf('<p>Model: <code>muse-wonder-1.0</code>')
    expect(() =>
      parseMetaPricing(
        page.slice(0, wonder) +
          page
            .slice(wonder)
            .replace(
              '<th>Standard mode (per 1M tokens)</th>',
              '<th>Standard (per 1M tokens)</th>',
            ),
        models,
        { url: META_PRICING, hash: 'fixture', extractedAt: '2026-10-12' },
      ),
    ).toThrow('unknown pricing table in Muse Wonder')
  })
  it('reads token prices when Contributor is the first column', () => {
    // Trimmed from https://dev.meta.ai/docs/pricing-rate-limits on 2026-11-10.
    // Decorative attributes removed; cell text is the live table.
    const html = `<h1 id="pricing">Pricing</h1>
<h3 id="muse-wonder-pricing">Muse Wonder</h3>
<p>Model: <code>muse-wonder-1.0</code>.</p>
<table><thead><tr><th>Usage</th><th>Contributor mode (per 1M tokens)</th><th>Standard mode (per 1M tokens)</th></tr></thead><tbody>
<tr><td>Cached input</td><td>Not available</td><td>$0.20</td></tr>
<tr><td>Input</td><td>Not available</td><td>$4.00</td></tr>
<tr><td>Output</td><td>Not available</td><td>$20.00</td></tr>
</tbody></table>
<h3 id="muse-spark-pricing">Muse Spark</h3>
<p>Models: <code>muse-spark-1.3</code>, <code>muse-spark-1.2</code>, and <code>muse-spark-1.1</code> in Standard mode; <code>muse-spark-1.3-contributor</code> and <code>muse-spark-1.2-contributor</code> in Contributor mode. Muse Spark 1.1 is Standard mode only.</p>
<table><thead><tr><th>Usage</th><th>Contributor mode (per 1M tokens)</th><th>Standard mode (per 1M tokens)</th></tr></thead><tbody>
<tr><td>Cached input</td><td>$0.002</td><td>$0.15</td></tr>
<tr><td>Input</td><td>$0.10</td><td>$1.25</td></tr>
<tr><td>Output</td><td>$0.20</td><td>$4.25</td></tr>
</tbody></table>`
    const models = parseMetaModels(docs[META_MODELS] ?? '', pages)
    const cards = parseMetaPricing(html, models, {
      url: META_PRICING,
      hash: 'live-2026-11-10',
      extractedAt: '2026-11-10',
    })
    expect(cards.get('muse-wonder-1.0')).toMatchObject({
      tables: {
        rate: {
          base: {
            input_tokens: 4 / 1e6,
            output_tokens: 20 / 1e6,
            cache_read_tokens: 0.2 / 1e6,
          },
        },
      },
    })
    expect(cards.get('muse-spark-1.3')).toMatchObject({
      tables: {
        rate: {
          base: {
            input_tokens: 1.25 / 1e6,
            output_tokens: 4.25 / 1e6,
            cache_read_tokens: 0.15 / 1e6,
          },
        },
      },
    })
    expect(cards.get('muse-spark-1.3-contributor')).toMatchObject({
      tables: {
        rate: {
          base: {
            input_tokens: 0.1 / 1e6,
            output_tokens: 0.2 / 1e6,
            cache_read_tokens: 0.002 / 1e6,
          },
        },
      },
    })
    expect(cards.get('muse-spark-1.1')).toEqual(cards.get('muse-spark-1.3'))
    expect(cards.get('muse-spark-1.2-contributor')).toEqual(
      cards.get('muse-spark-1.3-contributor'),
    )
  })
  // Trimmed from https://dev.meta.ai/docs/pricing-rate-limits on 2026-11-10.
  // Decorative attributes removed; the prose and cell text are the live page.
  const museEmberPricing = `<h1 id="pricing">Pricing</h1>
<h3 id="muse-ember-pricing">Muse Ember</h3>
<p>Model: <code>muse-ember-1.0</code>, in Standard mode only.</p>
<p>Muse Ember has two price tiers, and the input tokens in your API request set the tier, cached tokens included. When a request continues a stored conversation with <code>previous_response_id</code>, its input includes that conversation. A request with up to 200K input tokens is billed at the rates in the first column. A request with more is billed at the long-context rates in full, not only for the tokens past 200K. Your invoice and usage dashboard list the two tiers separately.</p>
<table><thead><tr><th>Usage</th><th>Up to 200K input tokens (per 1M tokens)</th><th>Over 200K input tokens (per 1M tokens)</th></tr></thead><tbody>
<tr><td>Cached input</td><td>$0.004</td><td>$0.012</td></tr>
<tr><td>Input</td><td>$0.10</td><td>$0.30</td></tr>
<tr><td>Output</td><td>$0.50</td><td>$1.50</td></tr>
</tbody></table>`
  const emberModel = (tier: string) => ({
    rawId: 'muse-ember-1.0',
    providerMetadata: { family: 'Muse Ember', tier },
  })
  const emberSource = {
    url: META_PRICING,
    hash: 'live-2026-11-10',
    extractedAt: '2026-11-10',
  }
  it('reads Muse Ember as one card with a 200K prompt-size tier', () => {
    const cards = parseMetaPricing(
      museEmberPricing,
      [emberModel('Standard')],
      emberSource,
    )
    const card = cards.get('muse-ember-1.0')
    expect(card).toMatchObject({
      tables: {
        rate: {
          base: {
            cache_read_tokens: 0.004 / 1e6,
            input_tokens: 0.1 / 1e6,
            output_tokens: 0.5 / 1e6,
          },
          '200000': {
            cache_read_tokens: 0.012 / 1e6,
            input_tokens: 0.3 / 1e6,
            output_tokens: 1.5 / 1e6,
          },
        },
      },
    })
    if (!card) throw new Error('missing muse-ember-1.0 card')
    // 200K exactly stays on the first column. One token over bills the
    // whole request at the long-context column. Cached input counts
    // toward the threshold and is priced on its own lever.
    expect(
      evaluateCard(card, {
        usage: { input_tokens: 200_000, output_tokens: 100 },
      }).amount,
    ).toBeCloseTo(200_000 * (0.1 / 1e6) + 100 * (0.5 / 1e6), 10)
    expect(
      evaluateCard(card, {
        usage: { input_tokens: 200_001, output_tokens: 100 },
      }).amount,
    ).toBeCloseTo(200_001 * (0.3 / 1e6) + 100 * (1.5 / 1e6), 10)
    expect(
      evaluateCard(card, {
        usage: {
          input_tokens: 199_000,
          cache_read_tokens: 1_000,
          output_tokens: 0,
        },
      }).amount,
    ).toBeCloseTo(199_000 * (0.1 / 1e6) + 1_000 * (0.004 / 1e6), 10)
    expect(
      evaluateCard(card, {
        usage: {
          input_tokens: 199_000,
          cache_read_tokens: 2_000,
          output_tokens: 0,
        },
      }).amount,
    ).toBeCloseTo(199_000 * (0.3 / 1e6) + 2_000 * (0.012 / 1e6), 10)
    expect(() =>
      parseMetaPricing(
        museEmberPricing,
        [emberModel('Contributor')],
        emberSource,
      ),
    ).toThrow('token price mode disagrees with model tier')
  })
  it('fails when the two prompt-size thresholds disagree', () => {
    expect(() =>
      parseMetaPricing(
        museEmberPricing.replace(
          'Over 200K input tokens',
          'Over 128K input tokens',
        ),
        [emberModel('Standard')],
        emberSource,
      ),
    ).toThrow('prompt-size thresholds disagree')
  })
  it('fails when a prompt-size header does not parse', () => {
    expect(() =>
      parseMetaPricing(
        museEmberPricing.replace(
          'Over 200K input tokens (per 1M tokens)',
          'Over 200 thousand input tokens (per 1M tokens)',
        ),
        [emberModel('Standard')],
        emberSource,
      ),
    ).toThrow('unreadable prompt-size threshold')
  })
  it('fails when a pay-as-you-go chat ID gets no token price', () => {
    const models = parseMetaModels(docs[META_MODELS] ?? '', pages)
    expect(() =>
      parseMetaPricing(
        (docs[META_PRICING] ?? '').replace(
          /(<p>Model: <code>muse-wonder-1\.0<\/code>[\s\S]*?)<th>Usage<\/th>/,
          '$1<th>Meter</th>',
        ),
        models,
        { url: META_PRICING, hash: 'fixture', extractedAt: '2026-10-12' },
      ),
    ).toThrow('token-priced model has no price')
  })
  it('fails a reasoning effort restriction it cannot read', async () => {
    const page = docs['https://dev.meta.ai/docs/reasoning'] ?? ''
    for (const cell of [
      'Standard mode only.',
      'Supported by Muse Wonder and Muse Spark 1.3.',
      'Requires <code>muse-wonder-1.0</code>.',
      'Supported by <code>muse-wonder-1.0</code>; not available with Contributor-mode variants.',
    ]) {
      serve({
        'https://dev.meta.ai/docs/reasoning': page.replace(
          /Supported by <code>[\s\S]*?<\/td>/,
          `${cell}</td>`,
        ),
      })
      await expect(provider.listModels({})).rejects.toThrow(
        'unreadable reasoning effort restriction',
      )
    }
  })
  it('leaves reasoning unset for a chat family the page does not say always reasons', async () => {
    serve({
      'https://dev.meta.ai/docs/reasoning': (
        docs['https://dev.meta.ai/docs/reasoning'] ?? ''
      ).replace(
        'which Muse Wonder and Muse Spark do not support',
        'which Muse Spark does not support',
      ),
    })
    const { models } = await provider.listModels({})
    expect(
      models.find((m) => m.rawId === 'muse-wonder-1.0')?.reasoning,
    ).toBeNull()
    expect(
      models.find((m) => m.rawId === 'muse-spark-1.1')?.reasoning,
    ).toMatchObject({ mode: 'effort', mandatory: true })
  })
})
