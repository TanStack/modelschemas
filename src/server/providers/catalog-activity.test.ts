import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { price } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { provider as cerebras } from './adapters/cerebras.ts'
import { provider as deepseek } from './adapters/deepseek.ts'
import { dashscopeListedModel } from './adapters/dashscope.ts'
import { provider as fireworks } from './adapters/fireworks.ts'
import { provider as hyperbolic } from './adapters/hyperbolic.ts'
import { provider as jina } from './adapters/jina.ts'
import { provider as moonshot } from './adapters/moonshot.ts'
import { provider as novita } from './adapters/novita.ts'
import { provider as perplexity } from './adapters/perplexity.ts'
import { provider as sambanova } from './adapters/sambanova.ts'
import { parseDeepseekPricing } from './deepseek-pricing.ts'
import { parseFireworksPricing } from './fireworks-pricing.ts'
import { parseKimiDocTables } from './kimi-doc-tables.ts'
import { parseMoonshotPricing } from './moonshot-pricing.ts'
import { DEEPSEEK_THINKING_URL, KIMI_THINKING_URL } from './provider-replay.ts'
import {
  DEEPSEEK_REPLAY_FIXTURE,
  KIMI_REPLAY_FIXTURE,
} from './fixtures/provider-replay.ts'
import {
  cerebrasCatalogRows,
  parseCerebrasModelPage,
} from './cerebras-pricing.ts'

const DEEPSEEK_HTML = `
<table>
<tr><td>MODEL</td><td>deepseek-flash</td><td>deepseek-v4-pro</td></tr>
<tr><td>PRICING</td></tr>
<tr><td>OFF-PEAK</td><td>$0.003</td><td>$0.022</td></tr>
<tr><td>PEAK</td><td>$0.006</td><td>$0.044</td></tr>
<tr><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr>
<tr><td>PEAK</td><td>$0.3</td><td>$1.32</td></tr>
<tr><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>
<tr><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr>
<tr><td>Concurrency Limit</td><td>2500</td><td>500</td></tr>
</table>`

const FIREWORKS_MD = `
| Model | Standard | Priority |
| - | - | - |
| [DeepSeek V4.1 Flash](https://app.fireworks.ai/models/fireworks/deepseek-v4p1-flash) | $0.30 / $0.006 / $1.20 | $0.375 / $0.0075 / $1.50 |
| [DeepSeek V4.1 Flash (US)](https://app.fireworks.ai/models/fireworks/deepseek-v4p1-flash) | $0.45 / $0.009 / $1.80 | $0.56 / $0.01 / $2.25 |
| [Kimi K3 Fast](https://app.fireworks.ai/models/fireworks/kimi-k3) | $4.50 / $0.45 / $22.50 | — |
| Less than 4B parameters | $0.10 |
`

// The compiled MDX body of platform.kimi.ai/docs/pricing/chat (2026-10-23).
const MOONSHOT_PAGE = readFileSync(
  new URL('./fixtures/platform.kimi.ai-pricing-chat.html.txt', import.meta.url),
  'utf8',
)

const CEREBRAS_CATALOG = `
| [OpenAI GPT OSS](/models/openai-oss) | \`gpt-oss-120b\` | 120 billion |
`

// The MDX-source <ModelInfo> JSX (the .md export before issue #381).
const CEREBRAS_PAGE = `
<ModelInfo
  modelId="gpt-oss-120b"
  pricing={{
    inputPrice: "$0.35 / M tokens",
    outputPrice: "$0.75 / M tokens"
  }}
  inputOutput={{
    inputFormats: ["text"],
    outputFormats: ["text"]
  }}
  features={[
    "Reasoning",
    "Tool Calling"
  ]}
  contextLength={{
    paidTiers: "131k tokens"
  }}
  maxOutput={{
    freeTier: "32k tokens",
    paidTiers: "40k tokens"
  }}
/>
`

// The HTML page's compiled MDX (issue #381), trimmed from
// inference-docs.cerebras.ai/models/qwen-3.8-27b on 2026-10-20.
const CEREBRAS_HTML = `<script>self.__next_f.push([1,"_jsx(_components.p,{children:['Model ID: ',_jsx(_components.code,{children:\`qwen-3.8-27b\`}),\`. Context window: 64K tokens (65,536) for Free Trial and 128K tokens (131,072) for paid tiers and trial customers. Maximum output: 32K tokens (32,768) for Free Trial and 40K tokens (40,960) for paid tiers and trial customers. Pricing: \`]}),_jsx(_MdxComponentBoundary,{name:\`ModelInfo\`,children:_jsx(ModelInfo,{modelId:\`qwen-3.8-27b\`,playgroundUrl:\`https://cloud.cerebras.ai\`,contextLength:{freeTier:\`64k tokens\`,paidTiers:\`128k tokens\`},maxOutput:{freeTier:\`32k tokens\`,paidTiers:\`40k tokens\`},speed:{value:\`~1850\`,unit:\`tokens/sec\`},pricing:{inputPrice:\`$0.99 / M tokens\`,outputPrice:\`$1.49 / M tokens\`},rateLimits:[{tier:\`Free Trial\`,requestsPerMin:\`5\`}],endpoints:[\`Chat Completions\`],features:[\`Image Inputs\`,\`Reasoning\`,\`Tool Calling\`],inputOutput:{inputFormats:[\`text\`,\`image\`],outputFormats:[\`text\`]},knownLimitations:[_jsxs(_components.span,{children:[\`Reasoning is enabled by default at \`,_jsx(_components.code,{children:\`high\`}),\`.\`]})]})})"])</script>`

// A minimal compiled ModelInfo for the listModels test (hand-built).
const CEREBRAS_OSS_HTML = `<script>self.__next_f.push([1,"_jsx(ModelInfo,{modelId:\`gpt-oss-120b\`,contextLength:{freeTier:\`65k tokens\`,paidTiers:\`131k tokens\`},maxOutput:{freeTier:\`32k tokens\`,paidTiers:\`40k tokens\`},pricing:{inputPrice:\`$0.35 / M tokens\`,outputPrice:\`$0.75 / M tokens\`},features:[\`Reasoning\`,\`Tool Calling\`],inputOutput:{inputFormats:[\`text\`],outputFormats:[\`text\`]}})"])</script>`

function inputUsd(card: unknown): number {
  return price(card as RateCard, {}, { input_tokens: 1e6, output_tokens: 0 })
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function withFetch(
  handler: (url: string) => Response,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string) =>
    Promise.resolve(handler(String(url)))) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

describe('deepseek pricing page', () => {
  it('keeps both periods and drops a model the table does not name', () => {
    const parsed = parseDeepseekPricing(DEEPSEEK_HTML)
    expect(parsed.get('deepseek-flash')).toEqual({
      off_peak: { cacheRead: 0.003, input: 0.15, output: 0.6 },
      peak: { cacheRead: 0.006, input: 0.3, output: 1.2 },
    })
    expect(parsed.get('deepseek-v4-pro')?.off_peak.input).toBe(0.66)
    expect(parsed.get('deepseek-v4-pro')?.peak.input).toBe(1.32)
    expect(parsed.has('deepseek-chat')).toBe(false)
  })

  it('throws when a named model lacks a peak set', () => {
    const offPeakOnly = [
      'MODEL',
      'deepseek-flash',
      'PRICING',
      '$0.003',
      '$0.15',
      '$0.6',
      'Concurrency',
    ].join('\n')
    expect(() => parseDeepseekPricing(offPeakOnly)).toThrow(/expected 6 prices/)
  })
})

describe('fireworks pricing page', () => {
  it('maps standard cells, skips US and size bands, and splits fast routers', () => {
    const parsed = parseFireworksPricing(FIREWORKS_MD)
    expect(parsed.get('accounts/fireworks/models/deepseek-v4p1-flash')).toEqual(
      { input: 0.3, cacheRead: 0.006, output: 1.2 },
    )
    expect(parsed.get('accounts/fireworks/routers/kimi-k3-fast')?.input).toBe(
      4.5,
    )
    expect(parsed.size).toBe(2)
  })
})

describe('moonshot pricing page', () => {
  it('reads K2 cache columns and K3 cache-write columns by title', () => {
    const parsed = parseMoonshotPricing(parseKimiDocTables(MOONSHOT_PAGE))
    expect(parsed.get('kimi-k2.6')).toEqual({
      cacheRead: 0.16,
      input: 0.95,
      output: 4,
    })
    expect(parsed.get('kimi-k3')).toEqual({
      cacheWrite: 3,
      cacheWrite1h: 6,
      cacheRead: 0.3,
      input: 3,
      output: 15,
    })
  })

  it('leaves a row unpriced when a price cell is not plain text', () => {
    // Struck cache-hit and cache-miss cells must not shift the K3 output
    // and cache writes into the input levers.
    const struck = (amount: string) =>
      `_jsx(_components.del,{children:\`$${amount}\`})`
    const page = MOONSHOT_PAGE.replace(
      '`$3.00 / MTok`,`$15.00 / MTok`,`$0.30 / MTok`',
      () =>
        `${struck('3.00 / MTok')},${struck('15.00 / MTok')},\`$0.30 / MTok\``,
    )
    expect(page).not.toBe(MOONSHOT_PAGE)
    const parsed = parseMoonshotPricing(parseKimiDocTables(page))
    expect(parsed.has('kimi-k3')).toBe(false)
    expect(parsed.has('kimi-k2.6')).toBe(true)
  })

  it.each([
    ['a unit suffix', '`$0.16 / MTok (promo)`'],
    ['another unit', '`$0.16 / KTok`'],
    ['a yuan price', '`¥0.16 / MTok`'],
    ['no cache-hit price', '`—`'],
  ])('leaves a row with %s unpriced', (_name, to) => {
    const page = MOONSHOT_PAGE.replace('`$0.16 / MTok`', to)
    expect(page).not.toBe(MOONSHOT_PAGE)
    const parsed = parseMoonshotPricing(parseKimiDocTables(page))
    expect(parsed.has('kimi-k2.6')).toBe(false)
    expect(parsed.has('kimi-k3')).toBe(true)
  })

  it('prices no row of a table with a title it does not know', () => {
    const page = MOONSHOT_PAGE.replace(
      '{title:`Output`,width:`22%`}',
      '{title:`Batch output`,width:`22%`}',
    )
    expect(page).not.toBe(MOONSHOT_PAGE)
    const parsed = parseMoonshotPricing(parseKimiDocTables(page))
    expect(parsed.has('kimi-k2.6')).toBe(false)
    expect(parsed.has('kimi-k3')).toBe(true)
  })
})

describe('cerebras model pages', () => {
  it('reads the catalog link and the ModelInfo price', () => {
    expect(cerebrasCatalogRows(CEREBRAS_CATALOG)).toEqual([
      { slug: 'openai-oss', id: 'gpt-oss-120b' },
    ])
    // As of 2026-10-22 the catalog links the .md export (issue #437).
    expect(
      cerebrasCatalogRows(
        '| [Qwen 3.8 27B](/models/qwen-3.8-27b.md) | `qwen-3.8-27b` | 27 billion |',
      ),
    ).toEqual([{ slug: 'qwen-3.8-27b', id: 'qwen-3.8-27b' }])
    // As of 2026-10-23 the links carry the docs origin (issue #486).
    expect(
      cerebrasCatalogRows(
        '| [OpenAI GPT OSS](https://inference-docs.cerebras.ai/models/openai-oss.md) | `gpt-oss-120b` | 120 billion |',
      ),
    ).toEqual([{ slug: 'openai-oss', id: 'gpt-oss-120b' }])
    const facts = parseCerebrasModelPage(CEREBRAS_PAGE)
    expect(facts?.inputPerMillion).toBe(0.35)
    expect(facts?.outputPerMillion).toBe(0.75)
    expect(facts?.modalities).toEqual({ input: ['text'], output: ['text'] })
    expect(facts?.capabilities).toEqual(['reasoning', 'tools'])
    expect(facts?.maxOutput).toBe(40_000)
    expect(facts?.contextWindow).toBe(131_000)
  })

  it('reads the compiled ModelInfo props from the HTML page', () => {
    expect(parseCerebrasModelPage(CEREBRAS_HTML)).toEqual({
      inputPerMillion: 0.99,
      outputPerMillion: 1.49,
      modalities: { input: ['text', 'image'], output: ['text'] },
      capabilities: ['reasoning', 'tools'],
      contextWindow: 131_072,
      maxOutput: 40_960,
    })
  })

  it('reads the compiled copy with pricing when an unpriced copy comes first', () => {
    const unpriced =
      '_jsx(ModelInfo,{modelId:`gpt-oss-120b`,features:[`Reasoning`]})'
    expect(
      parseCerebrasModelPage(`${unpriced}${CEREBRAS_OSS_HTML}`),
    ).toMatchObject({ inputPerMillion: 0.35, maxOutput: 40_000 })
  })

  it('throws when two priced compiled copies disagree', () => {
    const other = CEREBRAS_OSS_HTML.replace('$0.35', '$0.40')
    expect(() =>
      parseCerebrasModelPage(`${CEREBRAS_OSS_HTML}${other}`),
    ).toThrow('ModelInfo copies disagree')
  })

  it('keeps the context sentence out of the max output sentence', () => {
    const facts = parseCerebrasModelPage(
      `\`. Context window: 65k tokens (free tier), 131k tokens (paid). Max output: 32K tokens (32,768) for Free Trial and 40K tokens (40,960) for paid tiers.\`${CEREBRAS_OSS_HTML}`,
    )
    expect(facts?.contextWindow).toBe(131_000)
    expect(facts?.maxOutput).toBe(40_960)
  })

  it('prefers the paid parenthetical context window over 128k', () => {
    const facts = parseCerebrasModelPage(`
Context window: 64K tokens (65,536) for Free Trial and 128K tokens (131,072) for paid tiers and trial customers.
<ModelInfo
  contextLength={{
    paidTiers: "128k tokens"
  }}
/>
`)
    expect(facts?.contextWindow).toBe(131_072)
  })

  it('prefers the paid parenthetical output cap over 40k', () => {
    const facts = parseCerebrasModelPage(`
Maximum output: 32K tokens (32,768) for Free Trial and 40K tokens (40,960) for paid tiers.
<ModelInfo
  maxOutput={{
    freeTier: "32k tokens",
    paidTiers: "40k tokens"
  }}
/>
`)
    expect(facts?.maxOutput).toBe(40_960)
  })
})

describe('issue #109 listModels', () => {
  it('sets deepseek activity and a period card, and leaves an unpriced id null', async () => {
    await withFetch(
      (url) => {
        if (url.includes('api.deepseek.com/models')) {
          return json({
            data: [
              {
                id: 'deepseek-flash',
                output_modalities: ['text'],
                input_modalities: ['text', 'image'],
                effort: { supported_levels: ['high'] },
              },
              { id: 'deepseek-other' },
            ],
          })
        }
        if (url.includes('quick_start/pricing')) {
          return new Response(DEEPSEEK_HTML, { status: 200 })
        }
        if (url === DEEPSEEK_THINKING_URL)
          return new Response(DEEPSEEK_REPLAY_FIXTURE)
        return new Response('missing', { status: 404 })
      },
      async () => {
        const { models } = await deepseek.listModels({
          DEEPSEEK_API_KEY: 'test',
        })
        const flash = models.find((model) => model.rawId === 'deepseek-flash')
        const other = models.find((model) => model.rawId === 'deepseek-other')
        expect(flash?.activity).toBe('chat')
        expect(flash?.modalities).toEqual({
          input: ['text', 'image'],
          output: ['text'],
        })
        expect(flash?.pricing).toBeTruthy()
        const card = flash?.pricing as RateCard
        expect(card.inputs.pricing_period).toMatchObject({
          bound: 'usage',
          values: ['off_peak', 'peak'],
        })
        expect(card.inputs.pricing_period).not.toHaveProperty('default')
        expect(
          price(
            card,
            {},
            {
              input_tokens: 1e6,
              output_tokens: 0,
              pricing_period: 'off_peak',
            },
          ),
        ).toBeCloseTo(0.15, 9)
        expect(
          price(
            card,
            {},
            {
              input_tokens: 1e6,
              output_tokens: 0,
              pricing_period: 'peak',
            },
          ),
        ).toBeCloseTo(0.3, 9)
        expect(other?.activity).toBeNull()
        expect(other?.pricing ?? null).toBeNull()
      },
    )
  })

  it('prices a cerebras chat row from its model page and leaves an unlisted id null', async () => {
    await withFetch(
      (url) => {
        if (url.includes('api.cerebras.ai')) {
          return json({
            data: [{ id: 'gpt-oss-120b' }, { id: 'not-on-the-page' }],
          })
        }
        if (url.endsWith('/models/overview.md')) {
          return new Response(CEREBRAS_CATALOG, { status: 200 })
        }
        if (url.endsWith('/models/openai-oss')) {
          return new Response(CEREBRAS_OSS_HTML, { status: 200 })
        }
        if (url.endsWith('/capabilities/reasoning.md')) {
          return new Response(
            `
| Model | Default effort | Availability |
| - | - | - |
| [GPT OSS 120B](#gpt-oss-120b) | \`medium\` | Shared and Dedicated Inference |

## Model behavior

### GPT OSS 120B

[\`gpt-oss-120b\`](/models/openai-oss) always enables reasoning. Use \`reasoning_effort\` to select one of the following levels.

| Value | Behavior |
| - | - |
| \`low\` | Selects low reasoning effort |
| \`medium\` (default) | Selects medium reasoning effort |
| \`high\` | Selects high reasoning effort |
| \`none\` | Not supported |
`,
            { status: 200 },
          )
        }
        if (url.endsWith('/openapi.yaml')) {
          return new Response(
            `
        max_completion_tokens:
          type: integer
          description: The maximum number of tokens that can be generated.
        max_tokens:
          type: integer
          description: >
            An alias for \`max_completion_tokens\`. Do not send both parameters
            in the same request.
        Developer messages are supported only by \`gpt-oss-120b\`.
`,
            { status: 200 },
          )
        }
        return new Response('missing', { status: 404 })
      },
      async () => {
        const { models } = await cerebras.listModels({
          CEREBRAS_API_KEY: 'test',
        })
        const priced = models.find((model) => model.rawId === 'gpt-oss-120b')
        const bare = models.find((model) => model.rawId === 'not-on-the-page')
        expect(priced?.activity).toBe('chat')
        expect(priced?.modalities).toEqual({
          input: ['text'],
          output: ['text'],
        })
        expect(inputUsd(priced?.pricing)).toBeCloseTo(0.35, 9)
        expect(priced?.maxOutput).toBe(40_000)
        expect(priced?.contextWindow).toBe(131_000)
        expect(priced?.reasoning).toEqual({
          mode: 'effort',
          mandatory: true,
          efforts: ['low', 'medium', 'high'],
        })
        expect(priced?.requestMap).toMatchObject({
          maxTokensField: 'max_completion_tokens',
          developerRole: true,
          reasoningEffort: true,
          thinking: {
            on: { reasoning_effort: 'high' },
            off: null,
          },
        })
        expect(priced?.factSources?.maxOutput?.sourceUrl).toBe(
          'https://inference-docs.cerebras.ai/models/openai-oss',
        )
        expect(priced?.factSources?.reasoning?.sourceUrl).toBe(
          'https://inference-docs.cerebras.ai/capabilities/reasoning.md',
        )
        expect(bare?.activity).toBe('chat')
        expect(bare?.pricing ?? null).toBeNull()
        expect(bare?.maxOutput ?? null).toBeNull()
        expect(bare?.reasoning ?? null).toBeNull()
        expect(bare?.requestMap?.developerRole).toBe(false)
        expect(bare?.requestMap?.maxTokensField).toBe('max_completion_tokens')
      },
    )
  })

  it('prices moonshot from the docs table and keeps a zero quote null', async () => {
    await withFetch(
      (url) => {
        if (url.includes('api.moonshot.ai')) {
          return json({
            data: [
              {
                id: 'kimi-k2.6',
                supports_image_in: true,
                supports_video_in: false,
                supports_reasoning: true,
                context_length: 262144,
              },
              { id: 'kimi-free' },
            ],
          })
        }
        if (url.includes('pricing/chat')) {
          return new Response(MOONSHOT_PAGE, { status: 200 })
        }
        if (url === KIMI_THINKING_URL) return new Response(KIMI_REPLAY_FIXTURE)
        return new Response('missing', { status: 404 })
      },
      async () => {
        const { models } = await moonshot.listModels({
          MOONSHOT_API_KEY: 'test',
        })
        const kimi = models.find((model) => model.rawId === 'kimi-k2.6')
        const free = models.find((model) => model.rawId === 'kimi-free')
        expect(kimi?.activity).toBe('chat')
        expect(kimi?.modalities).toEqual({
          input: ['text', 'image'],
          output: ['text'],
        })
        expect(kimi?.capabilities).toEqual(['reasoning'])
        expect(inputUsd(kimi?.pricing)).toBeCloseTo(0.95, 9)
        expect(free?.activity).toBe('chat')
        expect(free?.pricing ?? null).toBeNull()
      },
    )
  })

  it('prices a fireworks chat row and leaves a reranker and a missing price null', async () => {
    await withFetch(
      (url) => {
        // This pricing-only synthetic case states no reasoning evidence.
        // Distinguish model metadata from the inference listing response.
        for (const id of ['deepseek-v4p1-flash', 'unpriced']) {
          const name = 'accounts/fireworks/models/' + id
          if (url === 'https://api.fireworks.ai/v1/' + name)
            return json({ name, description: '' })
        }
        if (url.includes('api.fireworks.ai')) {
          return json({
            data: [
              {
                id: 'accounts/fireworks/models/deepseek-v4p1-flash',
                kind: 'HF_BASE_MODEL',
                supports_chat: true,
                supports_image_input: true,
                supports_tools: true,
              },
              {
                id: 'accounts/fireworks/models/qwen3-reranker-8b',
                kind: 'HF_BASE_MODEL',
                supports_chat: true,
              },
              {
                id: 'accounts/fireworks/models/unpriced',
                kind: 'HF_BASE_MODEL',
                supports_chat: true,
                supports_image_input: false,
              },
            ],
          })
        }
        if (url.includes('serverless/pricing.md')) {
          return new Response(FIREWORKS_MD, { status: 200 })
        }
        return new Response('missing', { status: 404 })
      },
      async () => {
        const { models } = await fireworks.listModels({
          FIREWORKS_API_KEY: 'test',
        })
        const chat = models.find((model) => model.rawId.includes('deepseek'))
        const rerank = models.find((model) => model.rawId.includes('reranker'))
        const bare = models.find((model) => model.rawId.includes('unpriced'))
        expect(chat?.activity).toBe('chat')
        expect(chat?.modalities).toEqual({
          input: ['text', 'image'],
          output: ['text'],
        })
        expect(chat?.capabilities).toEqual(['tools'])
        expect(inputUsd(chat?.pricing)).toBeCloseTo(0.3, 9)
        expect(rerank?.activity).toBeNull()
        expect(rerank?.pricing ?? null).toBeNull()
        expect(bare?.activity).toBe('chat')
        expect(bare?.pricing ?? null).toBeNull()
      },
    )
  })

  it('compiles a novita decimal and leaves a tiered row null', async () => {
    await withFetch(
      () =>
        json({
          data: [
            {
              id: 'zai-org/glm',
              model_type: 'chat',
              input_modalities: ['text'],
              output_modalities: ['text'],
              features: ['function-calling'],
              pricing: {
                prompt: { price_per_m_decimal: '0.15' },
                completion: { price_per_m_decimal: '0.5' },
              },
            },
            {
              id: 'tiered',
              model_type: 'chat',
              is_tiered_billing: true,
              pricing: {
                prompt: { price_per_m_decimal: '1' },
                completion: { price_per_m_decimal: '2' },
              },
            },
          ],
        }),
      async () => {
        const { models } = await novita.listModels({ NOVITA_API_KEY: 'test' })
        const chat = models.find((model) => model.rawId === 'zai-org/glm')
        const tiered = models.find((model) => model.rawId === 'tiered')
        expect(chat?.activity).toBe('chat')
        expect(chat?.capabilities).toContain('tools')
        expect(inputUsd(chat?.pricing)).toBeCloseTo(0.15, 9)
        expect(tiered?.activity).toBe('chat')
        expect(tiered?.pricing ?? null).toBeNull()
      },
    )
  })

  it('compiles perplexity per-million quotes and rejects an untagged unit', async () => {
    await withFetch(
      (url) =>
        url.endsWith('/models.md')
          ? new Response('<Tab title="x">\n| `perplexity/sonar` | — |\n</Tab>')
          : url.endsWith('/effort.md')
            ? new Response(
                '<Accordion title="x — current effort level values">\n* **Model:** `a/b`\n* **Tools:** `web_search`\n</Accordion>',
              )
            : json({
                data: [
                  {
                    id: 'perplexity/sonar',
                    pricing: { input: 1, output: 1, unit: 'usd_per_1m_tokens' },
                  },
                  {
                    id: 'mystery',
                    pricing: { input: 1, output: 1, unit: 'credits' },
                  },
                ],
              }),
      async () => {
        const { models } = await perplexity.listModels({
          PERPLEXITY_API_KEY: 'test',
        })
        const sonar = models.find((model) => model.rawId === 'perplexity/sonar')
        const mystery = models.find((model) => model.rawId === 'mystery')
        expect(sonar?.activity).toBe('chat')
        expect(inputUsd(sonar?.pricing)).toBeCloseTo(1, 9)
        expect(
          perplexity.generationEndpointId?.({
            rawId: 'perplexity/sonar',
            activity: 'chat',
          }),
        ).toBe('v1/agent')
        expect(mystery?.pricing ?? null).toBeNull()
      },
    )
  })

  it('sets jina activity from output modalities and skips an all-zero price', async () => {
    const chatSpec = {
      openapi: '3.1.0',
      components: {
        schemas: {
          ChatCompletionRequest: {
            type: 'object',
            properties: {
              messages: {
                type: 'array',
                items: { $ref: '#/components/schemas/ChatMessage' },
              },
              model: { type: 'string', const: 'jina-ocr-v1' },
              max_completion_tokens: { type: 'integer', minimum: 1 },
            },
            required: ['messages', 'model'],
          },
          ChatMessage: {
            type: 'object',
            properties: {
              role: {
                type: 'string',
                enum: ['system', 'developer', 'user', 'assistant'],
              },
            },
          },
        },
      },
    }
    await withFetch(
      (url) =>
        url.endsWith('/openapi.json')
          ? json(chatSpec)
          : json({
              data: [
                {
                  id: 'jina-embeddings-v3',
                  output_modalities: ['embeddings'],
                  input_modalities: ['text'],
                  pricing: { prompt: '0.00000005', completion: '0' },
                },
                {
                  id: 'jina-reranker-v3',
                  output_modalities: ['text'],
                  input_modalities: ['text'],
                  pricing: { prompt: '0', completion: '0' },
                },
              ],
            }),
      async () => {
        const { models } = await jina.listModels({ JINA_API_KEY: 'test' })
        const embed = models.find((model) => model.rawId.includes('embeddings'))
        const rerank = models.find((model) => model.rawId.includes('reranker'))
        expect(embed?.activity).toBe('embeddings')
        expect(inputUsd(embed?.pricing)).toBeCloseTo(0.05, 9)
        expect(rerank?.activity).toBeNull()
        expect(rerank?.pricing ?? null).toBeNull()
      },
    )
  })

  it('prices sambanova per token and leaves a zero quote null', async () => {
    await withFetch(
      () =>
        json({
          data: [
            {
              id: 'DeepSeek-V3.2',
              context_length: 32768,
              pricing: { prompt: '0.00000300', completion: '0.00000450' },
            },
            {
              id: 'free',
              pricing: { prompt: '0', completion: '0' },
            },
          ],
        }),
      async () => {
        const { models } = await sambanova.listModels({
          SAMBANOVA_API_KEY: 'test',
        })
        const chat = models.find((model) => model.rawId === 'DeepSeek-V3.2')
        const free = models.find((model) => model.rawId === 'free')
        expect(chat?.activity).toBe('chat')
        expect(chat?.contextWindow).toBe(32768)
        expect(inputUsd(chat?.pricing)).toBeCloseTo(3, 9)
        expect(free?.pricing ?? null).toBeNull()
      },
    )
  })

  it('prices hyperbolic per million tokens from the listing', async () => {
    await withFetch(
      () =>
        json({
          data: [
            {
              id: 'deepseek-ai/DeepSeek-R1',
              supports_chat: true,
              supports_image_input: false,
              supports_tools: false,
              input_price: 2,
              output_price: 2,
            },
            {
              id: 'no-price',
              supports_chat: true,
              supports_image_input: false,
            },
          ],
        }),
      async () => {
        const { models } = await hyperbolic.listModels({
          HYPERBOLIC_API_KEY: 'test',
        })
        const chat = models.find((model) => model.rawId.includes('DeepSeek'))
        const bare = models.find((model) => model.rawId === 'no-price')
        expect(chat?.activity).toBe('chat')
        expect(chat?.modalities).toEqual({
          input: ['text'],
          output: ['text'],
        })
        expect(chat?.capabilities).toEqual([])
        expect(chat?.exactCapabilities).toBe(true)
        expect(inputUsd(chat?.pricing)).toBeCloseTo(2, 9)
        expect(bare?.activity).toBe('chat')
        expect(bare?.capabilities).toBeUndefined()
        expect(bare?.pricing ?? null).toBeNull()
      },
    )
  })

  it('maps a dashscope chat row to a card and leaves a zero quote null', async () => {
    const priced = await dashscopeListedModel({
      model: 'qwen3-max',
      name: 'Qwen3-Max',
      capabilities: ['TG'],
      features: ['function-calling'],
      inference_metadata: {
        request_modality: ['Text'],
        response_modality: ['Text'],
      },
      prices: [
        {
          range_name: 'Default',
          prices: [
            {
              type: 'input_token',
              price: '2',
              price_unit: 'per million tokens',
            },
            {
              type: 'output_token',
              price: '6',
              price_unit: 'per million tokens',
            },
          ],
        },
      ],
    })
    const free = await dashscopeListedModel({
      model: 'decision-model-preview',
      capabilities: ['TG'],
      inference_metadata: {
        request_modality: ['Text'],
        response_modality: ['Text'],
      },
      prices: [
        {
          range_name: 'Default',
          prices: [
            { type: 'input_token', price: '0', price_unit: 'Per 1M tokens' },
          ],
        },
      ],
    })
    expect(priced?.activity).toBe('chat')
    expect(priced?.modalities).toEqual({ input: ['text'], output: ['text'] })
    expect(priced?.capabilities).toEqual(['tools'])
    expect(inputUsd(priced?.pricing)).toBeCloseTo(2, 9)
    expect(free?.activity).toBe('chat')
    expect(free?.pricing ?? null).toBeNull()
  })

  it('binds schema ids that the generated OpenAI-compat spec actually stores', () => {
    expect(
      hyperbolic.generationEndpointId?.({ rawId: 'x', activity: 'chat' }),
    ).toBe('chat/completions')
    expect(
      sambanova.generationEndpointId?.({ rawId: 'x', activity: 'chat' }),
    ).toBe('chat/completions')
    expect(
      novita.generationEndpointId?.({ rawId: 'x', activity: 'chat' }),
    ).toBe('chat/completions')
    expect(
      novita.generationEndpointId?.({ rawId: 'x', activity: 'image' }),
    ).toBe('images/generations')
    expect(
      novita.generationEndpointId?.({ rawId: 'x', activity: 'video' }),
    ).toBeNull()
    expect(
      novita.generationEndpointId?.({ rawId: 'x', activity: 'audio' }),
    ).toBeNull()
    expect(
      novita.generationEndpointId?.({ rawId: 'x', activity: 'embeddings' }),
    ).toBeNull()
  })
})
