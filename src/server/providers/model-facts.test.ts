import { describe, expect, it, vi } from 'vitest'

import { anthropicCapabilities } from './anthropic.ts'
import {
  anthropicModelPricing,
  parseAnthropicPricing,
} from './anthropic-pricing.ts'
import { ANTHROPIC_PRICING_PAGE } from './fixtures/anthropic-pricing.ts'
import { GEMINI_DEPRECATIONS_URL } from './gemini-bindings.ts'
import {
  GEMINI_PRICING_URL,
  geminiModelPricing,
  geminiNamedIds,
  parseGeminiPricing,
} from './gemini-pricing.ts'
import { geminiCapabilities } from './gemini.ts'
import {
  grokImageCard,
  grokRateCard,
  grokVideoCard,
  parseGrokContextWindows,
  parseGrokMaxOutput,
  grokReasons,
  parseGrokVideoPrices,
  withGrokImageQuality,
} from './grok.ts'
import {
  docsReport,
  docsRun,
  llmsFullPage,
  markdocTables,
  markdownTableRows,
  tokenCount,
  undatedId,
} from './model-facts.ts'
import { price } from '@modelschemas/rate-card'
import { evaluateCard } from '@modelschemas/rate-card/evaluator'
import { parseStoredRateCard } from '../rate-card.ts'
import { openAiCompatModelFacts } from './openai-compat.ts'
import {
  pageSlugFor,
  parseModelIndex,
  parseModelPage,
  parseModelPricing,
  parseOpenAiSearchPricing,
  parseReasoningEffort,
} from './openai-model-docs.ts'

describe('model-facts helpers', () => {
  it('parses token counts with separators and k/M suffixes', () => {
    expect(tokenCount('1,048,576')).toBe(1_048_576)
    expect(tokenCount('500k')).toBe(500_000)
    expect(tokenCount('1M')).toBe(1_000_000)
  })

  it('rewrites Markdoc tables as pipe rows (#568)', () => {
    const doc = [
      'Before.',
      '  {% table %}',
      '  * Feature',
      '  * Paid',
      '',
      '  ---',
      '',
      '  * Input price{% sup %}*{% /sup %}',
      '  * $2.00 through November 30, 2026.   ',
      '  $4.00 starting December 1, 2026. \\\\',
      '  Implicit caching only.',
      '',
      '  ---',
      '',
      '  *     [**Thinking**](/docs/thinking)',
      '',
      '    {% badge label=Supported (low, high) type="supported" /%}',
      '  *     Read more.',
      '    *   Stable: `m-1`',
      '  {% /table %}',
      'After.',
    ].join('\n')
    expect(markdocTables(doc)).toBe(
      [
        'Before.',
        '| Feature | Paid |',
        '| Input price | $2.00 through November 30, 2026.<br>$4.00 starting December 1, 2026.<br>Implicit caching only. |',
        '| **[Thinking](/docs/thinking)** Supported (low, high) | Read more. * Stable: `m-1` |',
        'After.',
      ].join('\n'),
    )
  })

  it('strips snapshot dates', () => {
    expect(undatedId('gpt-5-2025-08-07')).toBe('gpt-5')
    expect(undatedId('claude-opus-4-5-20251101')).toBe('claude-opus-4-5')
    expect(undatedId('grok-4.20-0309-reasoning')).toBe(
      'grok-4.20-0309-reasoning',
    )
  })

  it('splits markdown table rows and drops separators', () => {
    expect(
      markdownTableRows('| a | b |\n| --- | ---: |\n| 1 | 2 |\ntext'),
    ).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('cuts one page out of llms-full.txt by its Source line', () => {
    const full = [
      '# A',
      'Source: https://docs.example/a',
      'a body',
      '# B',
      'Source: https://docs.example/b',
      '# not a page: no Source line follows',
      'b body',
      '# C',
      'Source: https://docs.example/c',
      'c body',
    ].join('\n')
    expect(llmsFullPage(full, 'https://docs.example/b')).toBe(
      [
        '# B',
        'Source: https://docs.example/b',
        '# not a page: no Source line follows',
        'b body',
      ].join('\n'),
    )
    expect(llmsFullPage(full, 'https://docs.example/c')).toBe(
      '# C\nSource: https://docs.example/c\nc body',
    )
    expect(() => llmsFullPage(full, 'https://docs.example/d')).toThrow(
      'llms-full.txt names https://docs.example/d 0 times, not once',
    )
    expect(() =>
      llmsFullPage(`${full}\n${full}`, 'https://docs.example/a'),
    ).toThrow('2 times')
  })
})

describe('anthropic models api', () => {
  it('derives request features only from the capability tree', () => {
    expect(
      anthropicCapabilities({
        id: 'claude-fable-5-1',
        capabilities: {
          thinking: { supported: true },
          effort: { supported: true },
          structured_outputs: { supported: true },
        },
      }),
    ).toEqual([
      'reasoning',
      'reasoning_effort',
      'structured_outputs',
      'response_format',
    ])
    expect(
      anthropicCapabilities({ id: 'claude-x', capabilities: {} }),
    ).toBeNull()
  })
})

describe('gemini models api', () => {
  it('derives request features only from row fields', () => {
    expect(
      geminiCapabilities({ thinking: true, temperature: 1, topP: 0.95 }),
    ).toEqual(['reasoning', 'temperature', 'top_p'])
    expect(geminiCapabilities({})).toBeNull()
  })
})

describe('xai model docs', () => {
  it('reads context windows and ignores the per-image table', () => {
    const md = `
| Model | Context | Input / 1M tokens | Cached input / 1M tokens | Output / 1M tokens |
| --- | --- | --- | --- | --- |
| grok-4.6 (< 200k prompt tokens) | 500k | $2.00 | $0.50 | $6.00 |
| grok-4.6 (≥ 200k prompt tokens) | 500k | $4.00 | $1.00 | $12.00 |
| grok-4.3 (< 200k prompt tokens) | 1M | $1.25 | $0.20 | $2.50 |

| Model | Cost |
| --- | --- |
| grok-imagine-image | $0.02 / image |
`
    expect([...parseGrokContextWindows(md)]).toEqual([
      ['grok-4.6', 500_000],
      ['grok-4.3', 1_000_000],
    ])
  })
})

describe('xai per-model docs', () => {
  it('reads the Reasoning capability bullet', () => {
    const page = (value: string) =>
      `# Grok\n\n## Capabilities\n\n- **Function calling:** Yes\n- **Reasoning:** ${value}\n- **Reasoning efforts (supported):** \`low\`\n`
    expect(grokReasons(page('Yes'))).toBe(true)
    expect(grokReasons(page('No'))).toBe(false)
    expect(grokReasons('# Grok\n\n## Capabilities\n')).toBe(false)
  })
})

describe('openai model docs', () => {
  const page = `# GPT-5

Model ID: \`gpt-5\`

Reasoning.effort supports: minimal, low, medium, and high.

## Model details

- Default snapshot: \`gpt-5-2025-08-07\`
- Input modalities: text, image
- Output modalities: text
- 400,000 context window
- Maximum input tokens: 272,000
- 128,000 max output tokens
- Reasoning token support

## Supported features

- streaming
- structured_outputs
- function_calling

## Supported tools

- function_calling
- web_search
- hosted_shell
- skills
- computer_use

## Snapshots

- \`gpt-5-2025-08-07\`
- \`gpt-5-2025-09-01\`

## Rate limits
`
  it('parses details, features, snapshots', () => {
    const parsed = parseModelPage(page)
    expect(parsed?.ids).toEqual([
      'gpt-5',
      'gpt-5-2025-08-07',
      'gpt-5-2025-09-01',
    ])
    expect(parsed?.pricedIds).toEqual(['gpt-5', 'gpt-5-2025-08-07'])
    expect(parsed?.facts).toEqual({
      contextWindow: 400_000,
      maxOutput: 128_000,
      modalities: { input: ['text', 'image'], output: ['text'] },
      capabilities: [
        'tools',
        'reasoning',
        'structured_outputs',
        'response_format',
      ],
      reasoning: {
        mode: 'effort',
        mandatory: true,
        efforts: ['minimal', 'low', 'medium', 'high'],
      },
      // Docs names map to Responses tool types; client-side ones drop.
      serverTools: ['web_search', 'shell', 'computer'],
    })
  })

  it('adds file input when the page lists file_uploads', () => {
    const withFiles = page.replace(
      '- function_calling\n\n## Supported tools',
      '- function_calling\n- file_uploads\n\n## Supported tools',
    )
    expect(parseModelPage(withFiles)?.facts.modalities).toEqual({
      input: ['text', 'image', 'file'],
      output: ['text'],
    })
    const noModalities = withFiles.replace(
      /^- (In|Out)put modalities.*\n/gm,
      '',
    )
    expect(parseModelPage(noModalities)?.facts.modalities).toBeNull()
  })

  it('leaves serverTools null when the page names no tool ids', () => {
    const bare = page.replace(
      /## Supported tools[\s\S]*?## Snapshots/,
      '## Snapshots',
    )
    expect(parseModelPage(bare)?.facts.serverTools).toBeNull()
  })

  it('reads every effort phrasing; none makes reasoning optional', () => {
    expect(
      parseReasoningEffort(
        'Reasoning.effort supports: none (default), low, medium, and high.',
      ),
    ).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['none', 'low', 'medium', 'high'],
    })
    expect(
      parseReasoningEffort(
        'GPT-5.2 Pro supports reasoning.effort: medium, high, xhigh.',
      ),
    ).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['medium', 'high', 'xhigh'],
    })
    expect(
      parseReasoningEffort(
        'GPT-5 Pro defaults to (and only supports) `reasoning.effort: high`.',
      ),
    ).toEqual({ mode: 'effort', mandatory: true, efforts: ['high'] })
    expect(parseReasoningEffort('No effort prose.')).toBeNull()
  })

  it('resolves listed ids to index slugs, dated snapshots via the alias', () => {
    const slugs = parseModelIndex(
      '- [GPT-5](/api/docs/models/gpt-5.md): x\n- [Whisper](/api/docs/models/whisper-1.md): y',
    )
    expect(pageSlugFor('gpt-5-2025-08-07', slugs)).toBe('gpt-5')
    expect(pageSlugFor('whisper-1', slugs)).toBe('whisper-1')
    expect(pageSlugFor('gpt-5-search-api', slugs)).toBeNull()
    // The models index dropped Sora after the Videos API shutdown. The
    // pages still publish per-second rates, so the slug is fetched anyway.
    expect(pageSlugFor('sora-2', slugs)).toBe('sora-2')
    expect(pageSlugFor('sora-2-pro', slugs)).toBe('sora-2-pro')
    expect(pageSlugFor('sora-2-2025-10-06', slugs)).toBe('sora-2')
    expect(pageSlugFor('sora-2-pro-2025-10-06', slugs)).toBe('sora-2-pro')
    // Dated TTS snapshots have no page of their own and are not the
    // family's default snapshot, so they do not inherit tts-1's price.
    expect(pageSlugFor('tts-1-1106', slugs)).toBeNull()
    expect(pageSlugFor('tts-1-hd-1106', slugs)).toBeNull()
  })
})

describe('openai-compatible model rows', () => {
  it('maps the extension fields groq/jina/fireworks/moonshot/mistral publish', () => {
    expect(
      openAiCompatModelFacts({
        id: 'openai/gpt-oss-120b',
        context_window: 131072,
        max_completion_tokens: 65536,
        input_modalities: ['text'],
        output_modalities: ['text'],
        supported_sampling_parameters: ['temperature', 'top_p', 'stop'],
        supported_features: [
          'tools',
          'json_mode',
          'structured_outputs',
          'reasoning',
        ],
      }),
    ).toEqual({
      contextWindow: 131072,
      maxOutput: 65536,
      modalities: { input: ['text'], output: ['text'] },
      capabilities: [
        'tools',
        'reasoning',
        'temperature',
        'top_p',
        'structured_outputs',
        'response_format',
      ],
    })
    expect(
      openAiCompatModelFacts({
        id: 'kimi-k2.6',
        context_length: 262144,
        supports_reasoning: true,
      }),
    ).toEqual({ contextWindow: 262144, capabilities: ['reasoning'] })
    expect(
      openAiCompatModelFacts({
        id: 'mistral-large-latest',
        max_context_length: 262144,
        capabilities: {
          function_calling: true,
          vision: true,
          reasoning: false,
        },
      }),
    ).toEqual({ contextWindow: 262144, capabilities: ['tools'] })
    expect(openAiCompatModelFacts({ id: 'x', max_output_length: 0 })).toEqual(
      {},
    )
  })
})

describe('openai-compatible model rows (novita / cohere vocab)', () => {
  it('normalises hyphenated features and cohere feature names', () => {
    expect(
      openAiCompatModelFacts({
        id: 'zai-org/glm-5.3-flash',
        context_size: 1_048_576,
        max_output_tokens: 131_072,
        input_modalities: ['text', 'image', 'video'],
        output_modalities: ['text'],
        features: ['function-calling', 'structured-outputs', 'reasoning'],
      }),
    ).toEqual({
      contextWindow: 1_048_576,
      maxOutput: 131_072,
      modalities: { input: ['text', 'image', 'video'], output: ['text'] },
      capabilities: [
        'tools',
        'reasoning',
        'structured_outputs',
        'response_format',
      ],
    })
    expect(
      openAiCompatModelFacts({
        id: 'command-a-03-2025',
        context_length: 288_000,
        features: ['json_mode', 'json_schema', 'tools', 'tool_choice'],
      }),
    ).toEqual({
      contextWindow: 288_000,
      capabilities: [
        'tools',
        'tool_choice',
        'structured_outputs',
        'response_format',
      ],
    })
  })
})

describe('openai pricing tables', () => {
  const pricing = (body: string) =>
    `# Model\n\nModel ID: \`m\`\n\n## Pricing\n\n${body}\n## Endpoints\n`

  it('reads every token lever off the per-million tables', () => {
    expect(
      parseModelPricing(
        pricing(`### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $1.25 | 1M tokens |
| Cached input | $0.125 | 1M tokens |
| Output | $10 | 1M tokens |

### Audio tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $32 | 1M tokens |
| Output | $64 | 1M tokens |
`),
      ),
    ).toEqual({
      rates: {
        input_tokens: 1.25e-6,
        cache_read_tokens: 0.125e-6,
        output_tokens: 10e-6,
        audio_tokens: 32e-6,
        audio_output_tokens: 64e-6,
      },
      tiers: [],
    })
  })

  it('uses the first Text tokens table when the heading is repeated', () => {
    // o3.md publishes standard rates, then the same heading again at half
    // price for batch/flex, with no label on the second table.
    expect(
      parseModelPricing(
        pricing(`### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $2 | 1M tokens |
| Cached input | $0.5 | 1M tokens |
| Output | $8 | 1M tokens |

### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $1 | 1M tokens |
| Cached input | $0.25 | 1M tokens |
| Output | $4 | 1M tokens |
`),
      ),
    ).toEqual({
      rates: {
        input_tokens: 0.000002,
        cache_read_tokens: 5e-7,
        output_tokens: 0.000008,
      },
      tiers: [],
    })
  })

  it('prices the alias and default snapshot, not an older dated snapshot', () => {
    const parsed = parseModelPage(`# GPT-4o

Model ID: \`gpt-4o\`

## Model details

- Default snapshot: \`gpt-4o-2024-08-06\`

## Pricing

### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $2.50 | 1M tokens |
| Cached input | $1.25 | 1M tokens |
| Output | $10 | 1M tokens |

## Snapshots

- \`gpt-4o-2024-08-06\`
- \`gpt-4o-2024-11-20\`
- \`gpt-4o-2024-05-13\`
`)
    expect(parsed?.pricedIds).toEqual(['gpt-4o', 'gpt-4o-2024-08-06'])
    expect(parsed?.ids).toContain('gpt-4o-2024-05-13')
    expect(parsed?.pricing?.rates).toEqual({
      input_tokens: 2.5e-6,
      cache_read_tokens: 1.25e-6,
      output_tokens: 10e-6,
    })
  })

  it('reads an embeddings page', () => {
    expect(
      parseModelPricing(
        pricing(`### Embeddings

| Metric | Price | Unit |
| --- | ---: | --- |
| Cost | $0.02 | 1M tokens |
`),
      ),
    ).toEqual({ rates: { input_tokens: 0.02e-6 }, tiers: [] })
  })

  it('treats the per-image table as a restatement of the token price', () => {
    // OpenAI bills image models per token; the per-image table is the
    // equivalent cost of one image at a size and quality.
    expect(
      parseModelPricing(
        pricing(`### Image tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $10 | 1M tokens |
| Output | $40 | 1M tokens |

### Image generation

| Metric | Price | Unit |
| --- | ---: | --- |
| Quality | Low | image |
| 1024x1024 | $0.011 | image |
`),
      ),
    ).toEqual({
      rates: { image_tokens: 10e-6, image_output_tokens: 40e-6 },
      tiers: [],
    })
  })

  it('refuses a section priced in a unit it has no lever for', () => {
    expect(
      parseModelPricing(
        pricing(`### Pricing

| Metric | Price | Unit |
| --- | ---: | --- |
| Cost | $0.10 | GB-hour |
`),
      ),
    ).toBeNull()
  })

  it('reads the long-prompt re-quote and cache-write multiplier', () => {
    const page = pricing(`### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $10 | 1M tokens |
| Cached input | $1 | 1M tokens |
| Output | $50 | 1M tokens |

- Prompts with more than 272K input tokens are priced at 2x input and cache rates and 1.5x output for the full request.
- Cache writes are billed at 1.25x the uncached input token rate.
- Batch and Flex are priced at 50% of Standard rates.
`)
    expect(parseModelPricing(page)).toEqual({
      rates: {
        input_tokens: 10e-6,
        cache_read_tokens: 1e-6,
        cache_write_tokens: 12.5e-6,
        output_tokens: 50e-6,
      },
      tiers: [
        {
          minPromptTokens: 272_000,
          rates: {
            input_tokens: 20e-6,
            cache_read_tokens: 2e-6,
            cache_write_tokens: 25e-6,
            output_tokens: (50 / 1e6) * 1.5,
          },
        },
      ],
    })
  })

  it('stamps a promo end so the card is re-read after it', () => {
    const page = pricing(`### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $4 | 1M tokens |
| Output | $20 | 1M tokens |

- GPT-5.6 Sol costs $4 per million input tokens and $20 per million output tokens, a 20% reduction in input pricing. GPT-5.6 Sol’s promotional pricing is available at least through November 21, 2026.
`)
    expect(parseModelPricing(page)?.expiresAt).toBe('2026-11-22T00:00:00.000Z')
  })

  it('prices a per-minute model by the duration the caller measures', () => {
    expect(
      parseModelPricing(
        pricing(`### Transcription audio duration

| Metric | Price | Unit |
| --- | ---: | --- |
| Price | $0.0045 | minute |
`),
      ),
    ).toEqual({
      rates: {},
      tiers: [],
      unit: {
        quantity: { param: 'audio_seconds', bound: 'usage' },
        rates: 0.0045 / 60,
      },
    })
  })

  it('prices sora-2 and sora-2-pro from their own video tables', () => {
    expect(
      parseModelPricing(
        pricing(`### Video generation

| Metric | Price | Unit |
| --- | ---: | --- |
| Portrait: 720x1280
Landscape: 1280x720 | $0.1 | second |
`),
      )?.unit,
    ).toEqual({
      quantity: { param: 'seconds', bound: 'request' },
      keys: [{ param: 'size', values: ['720x1280', '1280x720'] }],
      rates: { '720x1280': 0.1, '1280x720': 0.1 },
    })
    expect(
      parseModelPricing(
        pricing(`### Video generation

| Metric | Price | Unit |
| --- | ---: | --- |
| Portrait: 720x1280
Landscape: 1280x720 | $0.3 | second |
| Portrait: 1024x1792
Landscape: 1792x1024 | $0.5 | second |
| Portrait: 1080x1920
Landscape: 1920x1080 | $0.7 | second |
`),
      )?.unit?.rates,
    ).toEqual({
      '720x1280': 0.3,
      '1280x720': 0.3,
      '1024x1792': 0.5,
      '1792x1024': 0.5,
      '1080x1920': 0.7,
      '1920x1080': 0.7,
    })
  })

  it('leaves image-2, moderation, and dated TTS snapshots unpriced', () => {
    const image = parseModelPage(`# GPT-Image-2

Model ID: \`gpt-image-2\`

GPT Image 2 points at the [pricing page](/api/docs/pricing#image-generation) but this page lists no amount.

## Model details

- Default snapshot: \`gpt-image-2-2026-04-21\`

## Snapshots

- \`gpt-image-2-2026-04-21\`
`)
    expect(image?.pricing).toBeNull()
    expect(image?.pricedIds).toEqual(['gpt-image-2', 'gpt-image-2-2026-04-21'])

    const moderation = parseModelPage(`# omni-moderation

Model ID: \`omni-moderation-latest\`

Moderation models are free models designed to detect harmful content.

## Model details

- Default snapshot: \`omni-moderation-2024-09-26\`

## Snapshots

- \`omni-moderation-2024-09-26\`
`)
    expect(moderation?.pricing).toBeNull()

    const tts = parseModelPage(`# TTS-1

Model ID: \`tts-1\`

## Model details

- Default snapshot: \`tts-1\`

## Pricing

### Pricing

| Metric | Price | Unit |
| --- | ---: | --- |
| Use case | Speech generation | 1M tokens |
| Cost | $15 | 1M characters |

## Snapshots

- \`tts-1\`
`)
    expect(tts?.pricedIds).toEqual(['tts-1'])
    expect(tts?.ids).not.toContain('tts-1-1106')
    expect(tts?.pricing?.unit?.rates).toBe(15 / 1e6)
  })

  it('prices speech by character and video by size and second', () => {
    expect(
      parseModelPricing(
        pricing(`### Pricing

| Metric | Price | Unit |
| --- | ---: | --- |
| Use case | Speech generation | 1M tokens |
| Cost | $15 | 1M characters |
`),
      )?.unit,
    ).toEqual({
      quantity: { param: 'characters', bound: 'usage' },
      rates: 15 / 1e6,
    })
    // A video row names both orientations of one size in its metric cell,
    // and the cell's newline splits the row across two lines.
    expect(
      parseModelPricing(
        pricing(`### Video generation

| Metric | Price | Unit |
| --- | ---: | --- |
| Portrait: 720x1280
Landscape: 1280x720 | $0.3 | second |
| Portrait: 1080x1920
Landscape: 1920x1080 | $0.7 | second |
`),
      )?.unit,
    ).toEqual({
      quantity: { param: 'seconds', bound: 'request' },
      keys: [
        {
          param: 'size',
          values: ['720x1280', '1280x720', '1080x1920', '1920x1080'],
        },
      ],
      rates: {
        '720x1280': 0.3,
        '1280x720': 0.3,
        '1080x1920': 0.7,
        '1920x1080': 0.7,
      },
    })
  })

  it('refuses a page that mixes a token table with a per-unit one', () => {
    expect(
      parseModelPricing(
        pricing(`### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $5 | 1M tokens |

### Live session duration

| Metric | Price | Unit |
| --- | ---: | --- |
| Per minute | $0.05 | minute |
`),
      ),
    ).toBeNull()
  })

  it('accepts a cached-input bullet that restates the table', () => {
    const page = pricing(`### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $0.1 | 1M tokens |
| Cached input | $0.01 | 1M tokens |
| Cache writes | $0.125 | 1M tokens |
| Output | $0.5 | 1M tokens |

- Cached input tokens are priced at 10% of the uncached input token rate.
- Cache writes are billed at 1.25x the uncached input token rate.
- Regional processing adds a 10% premium where available.
`)
    expect(parseModelPricing(page)?.rates).toEqual({
      input_tokens: 0.1 / 1e6,
      cache_read_tokens: 0.01 / 1e6,
      cache_write_tokens: 0.125 / 1e6,
      output_tokens: 0.5 / 1e6,
    })
  })

  it('refuses a cached-input bullet that disagrees with the table', () => {
    const page = pricing(`### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $1 | 1M tokens |
| Cached input | $0.5 | 1M tokens |
| Output | $2 | 1M tokens |

- Cached input tokens are priced at 10% of the uncached input token rate.
`)
    expect(parseModelPricing(page)).toBeNull()
  })

  it('refuses an unrecognised bullet that quotes a surcharge', () => {
    const page = pricing(`### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $10 | 1M tokens |
| Output | $50 | 1M tokens |

- Requests using the widget tool are charged a 3x multiplier.
`)
    expect(parseModelPricing(page)).toBeNull()
  })

  it('refuses an unpriced row and a page with no pricing', () => {
    expect(
      parseModelPricing(
        pricing(`### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | Free | 1M tokens |
`),
      ),
    ).toBeNull()
    expect(parseModelPricing('# Model\n\nModel ID: `m`\n')).toBeNull()
  })

  it('prices gpt-5-search-api from the specialized table and not a dated twin', () => {
    const page = `Specialized models

Prices per 1M tokens.

Standard

### Grouped Pricing Table data

| Category | Model | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| Search | gpt-5-search-api | $1.25 | $0.125 | $10.00 |
| Embedding | text-embedding-3-small | $0.02 | - | - |
| Moderation | omni-moderation-latest | Free | - | - |

Fast

### Grouped Pricing Table data

| Category | Model | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| Search | gpt-5-search-api | $9.99 | $9.99 | $9.99 |
`
    const rates = parseOpenAiSearchPricing(page)
    expect(rates.get('gpt-5-search-api')).toEqual({
      input_tokens: 1.25 / 1e6,
      cache_read_tokens: 0.125 / 1e6,
      output_tokens: 10 / 1e6,
    })
    expect(rates.has('text-embedding-3-small')).toBe(false)
    expect(rates.has('omni-moderation-latest')).toBe(false)
    expect(rates.has('gpt-5-search-api-2025-10-14')).toBe(false)
    expect(rates.has('gpt-3.5-turbo-16k')).toBe(false)
  })
})

describe('anthropic pricing page', () => {
  it('reads HTML-footnoted cache rates from the upstream table', () => {
    const rows = parseAnthropicPricing(ANTHROPIC_PRICING_PAGE)
    expect(rows.size).toBe(18)
    expect(rows.get('claude opus 5.5')?.rates.cache_read_tokens).toBeCloseTo(
      0.2e-6,
      15,
    )
    expect(rows.get('claude fable 5.1')?.rates.cache_read_tokens).toBe(0.25e-6)
    expect(rows.get('claude sonnet 5')?.rates.input_tokens).toBe(2e-6)
    expect(rows.get('claude sonnet 5')?.rates.output_tokens).toBe(10e-6)
    for (const [name, row] of rows) {
      expect(row.tiers, name).toEqual([])
      const rates = row.rates
      if ('cache_write_tokens' in rates || 'cache_write_1h_tokens' in rates) {
        expect(
          rates.cache_read_tokens,
          `${name} must price cache reads`,
        ).toBeGreaterThan(0)
      }
    }
  })

  const page = `# Pricing

## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok1 | $50 / MTok |
| Claude Opus 4 ([retired](https://example.com/deprecations)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |

## Batch pricing

| Model | Batch input | Batch output |
| --- | --- | --- |
| Claude Fable 5.1 | $5 / MTok | $25 / MTok |
`

  it('keys rows by display name and reads every lever column', () => {
    const rows = parseAnthropicPricing(page)
    expect(rows.get('claude fable 5.1')).toEqual({
      rates: {
        input_tokens: 10e-6,
        cache_write_tokens: 12.5e-6,
        cache_write_1h_tokens: 20e-6,
        cache_read_tokens: 0.25e-6,
        output_tokens: 50e-6,
      },
      tiers: [],
    })
    // The name cell's retirement link is not part of the key.
    expect(rows.get('claude opus 4')?.rates.input_tokens).toBe(15e-6)
    // Batch rates live in another section and are not levers.
    expect(rows.size).toBe(2)
  })

  it('parses nothing when the section is gone', () => {
    expect(parseAnthropicPricing('# Pricing\n\n## Something else\n').size).toBe(
      0,
    )
  })

  const haiku = `# Pricing

## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |

## Batch pricing

| Model | Batch input | Batch output |
| --- | --- | --- |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.25 / MTok | $1.25 / MTok |
`

  it('prices Haiku 5.5 over 100k prompt tokens, counting cache with input', async () => {
    const rows = parseAnthropicPricing(haiku)
    expect(rows.get('claude haiku 5.5')?.tiers).toEqual([
      {
        minPromptTokens: 100_000,
        rates: {
          input_tokens: 0.5 / 1e6,
          cache_write_tokens: 0.625 / 1e6,
          cache_write_1h_tokens: 1 / 1e6,
          cache_read_tokens: 0.05 / 1e6,
          output_tokens: 2.5 / 1e6,
        },
      },
    ])
    const pricingFor = await anthropicModelPricing(
      undefined,
      async (_kv, _url, load) => load(),
      async () => new Response(haiku),
    )
    const card = parseStoredRateCard(pricingFor('Claude Haiku 5.5').pricing)
    if (!card) throw new Error('did not compile')
    const at = (usage: Record<string, number>) => price(card, {}, usage)
    // 150k input at the short rate is a fifth of the long rate.
    expect(at({ input_tokens: 150_000, output_tokens: 0 })).toBeCloseTo(0.075)
    expect(at({ input_tokens: 100_000, output_tokens: 0 })).toBeCloseTo(0.01)
    expect(at({ input_tokens: 100_001, output_tokens: 0 })).toBeCloseTo(
      0.0500005,
    )
    // Output length is not prompt length.
    expect(at({ input_tokens: 1, output_tokens: 200_000 })).toBeCloseTo(
      0.1000001,
    )
    // The 1-hour cache write is what crosses 100k.
    expect(
      at({
        input_tokens: 40_000,
        cache_read_tokens: 30_000,
        cache_write_tokens: 20_000,
        cache_write_1h_tokens: 10_001,
        output_tokens: 0,
      }),
    ).toBeCloseTo(0.044001)
    expect(rows.get('claude haiku 4.5')?.tiers).toEqual([])
  })

  it('refuses a prompt-length row that has no pair', () => {
    const alone = haiku.replace(
      '| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |\n',
      '',
    )
    expect(() => parseAnthropicPricing(alone)).toThrow(
      /claude haiku 5\.5 prompt-length rows do not pair/,
    )
    expect(() =>
      parseAnthropicPricing(
        haiku.replace('over 100,000 tokens', 'over 200,000 tokens'),
      ),
    ).toThrow(/prompt-length rows do not pair/)
    expect(() =>
      parseAnthropicPricing(
        haiku.replace(
          'for prompts over 100,000 tokens',
          'for prompts above 100k tokens',
        ),
      ),
    ).toThrow(/unreadable prompt-length row/)
  })
})

describe('grok model prices', () => {
  const model = {
    id: 'grok-4.20-0309-reasoning',
    prompt_text_token_price: 12_500,
    cached_prompt_text_token_price: 2_000,
    completion_text_token_price: 25_000,
    prompt_text_token_price_long_context: 25_000,
    cached_prompt_text_token_price_long_context: 4_000,
    completion_text_token_price_long_context: 50_000,
    long_context_threshold: 200_000,
  }

  it('reads xAI’s 1e-10 USD units as per-token rates', async () => {
    const card = await grokRateCard(model)
    if (!card) throw new Error('did not compile')
    expect(
      price(card, {}, { input_tokens: 1e5, output_tokens: 0 }),
    ).toBeCloseTo(0.125, 9)
    expect(
      price(card, {}, { input_tokens: 0, output_tokens: 1e5 }),
    ).toBeCloseTo(0.25, 9)
  })

  it('bills the long-context rate at the threshold, not above it', async () => {
    const card = await grokRateCard(model)
    if (!card) throw new Error('did not compile')
    const perMillion = (tokens: number) =>
      (price(card, {}, { input_tokens: tokens, output_tokens: 0 }) / tokens) *
      1e6
    expect(perMillion(199_999)).toBeCloseTo(1.25, 6)
    expect(perMillion(200_000)).toBeCloseTo(2.5, 6)
  })

  it('has no card for a model xAI does not price', async () => {
    expect(await grokRateCard({ id: 'grok-imagine-video' })).toBeNull()
  })

  it('prices images per image, by the (quality, resolution) matrix when there is one', async () => {
    const card = await grokImageCard({
      id: 'grok-imagine-image',
      image_price: 200_000_000,
    })
    if (!card) throw new Error('did not compile')
    expect(price(card, {}, {})).toBeCloseTo(0.02, 9)
    expect(price(card, { n: 4 }, {})).toBeCloseTo(0.08, 9)
    // Live 2026-10-04: grok-imagine-image-2.0 prices by quality and
    // resolution. `quality` is a request field (the guide and xai-sdk-ts;
    // the OpenAPI document omits it) and defaults to `auto`, which serves
    // `low` for generation. The pricing page's $0.04 is the low/1k cell.
    const matrix = await grokImageCard({
      id: 'grok-imagine-image-2.0',
      image_price: 600_000_000,
      pricing: [
        { quality: 'low', resolution: '1k', price_per_image: 4e8 },
        { quality: 'low', resolution: '2k', price_per_image: 6e8 },
        { quality: 'medium', resolution: '1k', price_per_image: 6e8 },
        { quality: 'medium', resolution: '2k', price_per_image: 8e8 },
      ],
    })
    if (!matrix) throw new Error('did not compile')
    expect(price(matrix, {}, {})).toBeCloseTo(0.04, 9)
    expect(price(matrix, { quality: 'auto' }, {})).toBeCloseTo(0.04, 9)
    expect(
      price(matrix, { quality: 'medium', resolution: '2k' }, {}),
    ).toBeCloseTo(0.08, 9)
    expect(
      price(matrix, { quality: 'low', resolution: '2k', n: 2 }, {}),
    ).toBeCloseTo(0.12, 9)
    expect(matrix.inputs.quality).toMatchObject({
      bound: 'request',
      default: 'auto',
    })
    // A dimension the request cannot state has no card, flat price or not.
    expect(
      await grokImageCard({
        id: 'grok-imagine-image',
        image_price: 200_000_000,
        pricing: [{ tier: 'pro', price_per_image: 7e8 }],
      }),
    ).toBeNull()
  })

  it('adds the documented quality field the OpenAPI document omits', () => {
    const spec = withGrokImageQuality({
      components: {
        schemas: {
          GenerateImageRequest: { properties: { prompt: { type: 'string' } } },
          EditImageRequest: { properties: { prompt: { type: 'string' } } },
          GenerateVideoRequest: { properties: { prompt: { type: 'string' } } },
        },
      },
    })
    const schemas = spec.components?.schemas as Record<
      string,
      { properties: Record<string, unknown> }
    >
    expect(schemas.GenerateImageRequest?.properties.quality).toMatchObject({
      enum: ['low', 'medium', 'auto'],
    })
    expect(schemas.EditImageRequest?.properties.quality).toBeDefined()
    expect(schemas.GenerateVideoRequest?.properties.quality).toBeUndefined()
  })

  it('reads a stated output cap and ignores "no limit" and price rows', () => {
    const page = `# Grok 3

## At a glance

- **Context window:** 131,072 tokens
- **Output limit:** 8,192 tokens
`
    expect(parseGrokMaxOutput(page)).toBe(8_192)
    expect(
      parseGrokMaxOutput(
        '| Property | Value |\n| --- | --- |\n| Output limit | No text output limit |\n',
      ),
    ).toBeNull()
    expect(
      parseGrokMaxOutput(
        '| Type | Price |\n| --- | --- |\n| Output | $6.00 |\n',
      ),
    ).toBeNull()
  })

  it('prices video per second off the docs table', async () => {
    const rates = parseGrokVideoPrices(`### Imagine Pricing

| Model | Cost |
| --- | --- |
| grok-imagine-image | $0.02 / image |
| grok-imagine-video | $0.050 / sec |
| grok-imagine-video-1.5 | $0.080 / sec |
`)
    expect([...rates]).toEqual([
      ['grok-imagine-video', 0.05],
      ['grok-imagine-video-1.5', 0.08],
    ])
    const card = await grokVideoCard(rates.get('grok-imagine-video'))
    if (!card) throw new Error('did not compile')
    expect(price(card, { duration: 6 }, {})).toBeCloseTo(0.3, 9)
    expect(await grokVideoCard(undefined)).toBeNull()
  })
})

describe('gemini pricing page', () => {
  /**
   * `<tr><td>…</td></tr>` rows as the page's Markdoc table: `---` between
   * rows, one `* ` per cell, `<br>` as a hard line break.
   */
  const table = (unit: string, rows: string) => `  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per ${unit} in USD

  ---

${[...rows.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
  .map(([, row = '']) =>
    [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)]
      .map(([, cell = '']) => `  * ${cell.split('<br>').join('   \n  ')}`)
      .join('\n'),
  )
  .join('\n\n  ---\n\n')}
  {% /table %}`

  /** One `## ` section: a Standard tab, then a Batch tab it must ignore. */
  const section = (
    id: string,
    rows: string,
    extraIds: Array<string> = [],
  ) => `## Name  {% id="${id}" %}

*${[id, ...extraIds].map((each) => `[\`${each}\`](/docs/models/${each})`).join(' and\n')}*

{% hr /%}

{% tabs %}
  {% tab title="Standard" %}
${table('1M tokens', rows)}
  {% /tab %}

  {% tab title="Batch" %}
${table('1M tokens', '<tr><td>Input price</td><td>Not available</td><td>$0.15</td></tr>')}
  {% /tab %}
{% /tabs %}
`

  /** A section with no tabs, priced per `unit`. */
  const untabbed = (ids: Array<string>, unit: string, rows: string) =>
    `## Name  {% id="${ids[0] ?? ''}" %}

*${ids.map((each) => `[\`${each}\`](/a)`).join(',\n')}*

{% hr /%}

${table(unit, rows)}
`

  const NOW = Date.UTC(2026, 8, 16)

  it('reads text and audio rates off the Standard table', () => {
    const rows = parseGeminiPricing(
      section(
        'gemini-2.5-flash',
        `<tr><td>Input price</td><td>Free of charge</td><td>$0.30 (text / image / video)<br>$1.00 (audio)</td></tr>
         <tr><td>Output price (including thinking tokens)</td><td>Free of charge</td><td>$2.50</td></tr>
         <tr><td>Context caching price</td><td>Not available</td><td>$0.03 (text / image / video)<br>$0.1 (audio)<br>$1.00 / 1,000,000 tokens per hour (storage price)</td></tr>
         <tr><td>Grounding with Google Search</td><td>Free</td><td>1,500 RPD (free), then $35 / 1,000 grounded prompts</td></tr>`,
      ),
      NOW,
    )
    expect(rows.get('gemini-2.5-flash')?.base).toEqual({
      input_tokens: 0.3e-6,
      audio_tokens: 1e-6,
      output_tokens: 2.5e-6,
      cache_read_tokens: 0.03e-6,
      audio_cache_tokens: 0.1 / 1e6,
    })
    // Batch is a separate tab, and cache storage is a per-hour rate.
    expect(rows.get('gemini-2.5-flash')?.tiers).toEqual([])
  })

  it('copies one Standard table onto every id the heading names', () => {
    const rows = parseGeminiPricing(
      section(
        'gemini-3.1-pro-preview',
        `<tr><td>Input price</td><td>Not available</td><td>$2.00</td></tr>
         <tr><td>Output price (including thinking tokens)</td><td>Not available</td><td>$12.00</td></tr>`,
        ['gemini-3.1-pro-preview-customtools'],
      ),
      NOW,
    )
    expect(rows.get('gemini-3.1-pro-preview')?.base).toEqual({
      input_tokens: 2e-6,
      output_tokens: 12e-6,
    })
    expect(rows.get('gemini-3.1-pro-preview-customtools')?.base).toEqual(
      rows.get('gemini-3.1-pro-preview')?.base,
    )
  })

  it('does not price models the heading does not name', () => {
    const rows = parseGeminiPricing(
      section(
        'gemini-2.5-flash',
        `<tr><td>Input price</td><td>Free of charge</td><td>$0.30</td></tr>
         <tr><td>Output price (including thinking tokens)</td><td>Free of charge</td><td>$2.50</td></tr>`,
      ),
      NOW,
    )
    expect(rows.has('gemini-2.5-flash')).toBe(true)
    expect(rows.has('aqa')).toBe(false)
    expect(rows.has('antigravity-preview-09-2026')).toBe(false)
    expect(rows.has('gemini-flash-latest')).toBe(false)
  })

  it('throws on a section that links ids but has no {% hr /%}', () => {
    const rows = `<tr><td>Input price</td><td>Free of charge</td><td>$0.30</td></tr>`
    const broken = section('gemini-2.5-flash', rows).replace('{% hr /%}', '')
    expect(() => geminiNamedIds(broken)).toThrow(/no \{% hr \/%\}/)
    expect(() => parseGeminiPricing(broken, NOW)).toThrow(/no \{% hr \/%\}/)
    // A tools section links no ids and has no rule: skipped, not thrown.
    const tools = `## Pricing for tools  {% id="pricing-for-tools" %}\n\n${table('1M tokens', rows)}\n`
    expect(geminiNamedIds(tools)).toEqual([])
  })

  it('skips a table whose last column is not the paid tier', () => {
    const rows = parseGeminiPricing(
      section(
        'gemini-2.5-flash',
        `<tr><td>Input price</td><td>Free of charge</td><td>$0.30</td></tr>`,
      ).replace(/Paid Tier, per 1M tokens in USD/g, 'Enterprise'),
      NOW,
    )
    expect(rows.has('gemini-2.5-flash')).toBe(false)
  })

  it('compiles the long-prompt re-quote as a tier', () => {
    const rows = parseGeminiPricing(
      section(
        'gemini-2.5-pro',
        `<tr><td>Input price</td><td>Free of charge</td><td>$1.25, prompts <= 200k tokens<br>$2.50, prompts > 200k tokens</td></tr>
         <tr><td>Output price (including thinking tokens)</td><td>Free of charge</td><td>$10.00, prompts <= 200k<br>$15.00, prompts > 200k</td></tr>`,
      ),
      NOW,
    )
    expect(rows.get('gemini-2.5-pro')?.base).toEqual({
      input_tokens: 1.25e-6,
      output_tokens: 10e-6,
    })
    expect(rows.get('gemini-2.5-pro')?.tiers).toEqual([
      {
        minPromptTokens: 200_000,
        rates: { input_tokens: 2.5e-6, output_tokens: 15e-6 },
      },
    ])
  })

  it('takes the dated price in effect and stamps its expiry', () => {
    const page = section(
      'gemini-3.8-flash',
      `<tr><td>Input price</td><td>Not available</td><td>$0.75 through December 31, 2026.<br>$1.50 starting January 1, 2027.</td></tr>
       <tr><td>Output price (including thinking tokens)</td><td>Not available</td><td>$3.75 through December 31, 2026.<br>$7.50 starting January 1, 2027.</td></tr>`,
    )
    expect(parseGeminiPricing(page, NOW).get('gemini-3.8-flash')).toEqual({
      base: { input_tokens: 0.75e-6, output_tokens: 3.75e-6 },
      tiers: [],
      expiresAt: '2027-01-01T00:00:00.000Z',
    })
    expect(
      parseGeminiPricing(page, Date.UTC(2027, 5, 1)).get('gemini-3.8-flash'),
    ).toEqual({
      base: { input_tokens: 1.5e-6, output_tokens: 7.5e-6 },
      tiers: [],
    })
  })

  it('reads a caching rate scoped to implicit caching', () => {
    // gemini-4-argon, 2026-10-22: the note after the dated pair quotes no
    // amount and must not refuse the model.
    const page = section(
      'gemini-4-argon',
      `<tr><td>Input price</td><td>Not available</td><td>$2.00 through November 30, 2026.<br>$4.00 starting December 1, 2026.</td></tr>
       <tr><td>Output price (including thinking tokens)</td><td>Not available</td><td>$10.00 through November 30, 2026.<br>$20.00 starting December 1, 2026.</td></tr>
       <tr><td>Context caching price</td><td>Not available</td><td>$0.10 through November 30, 2026.<br>$0.20 starting December 1, 2026.<br>Implicit caching only (explicit caching is not supported).</td></tr>`,
    )
    expect(parseGeminiPricing(page, NOW).get('gemini-4-argon')).toEqual({
      base: {
        input_tokens: 2e-6,
        output_tokens: 10e-6,
        cache_read_tokens: 0.1 / 1e6,
      },
      tiers: [],
      expiresAt: '2026-12-01T00:00:00.000Z',
    })
    // Any other unpriced note on that row still refuses the model.
    const other = page.replace('Implicit caching only', 'Billed separately')
    expect(parseGeminiPricing(other, NOW).has('gemini-4-argon')).toBe(false)
  })

  it('gives a separately priced modality its own lever', () => {
    // Gemini sums text, image and video into one prompt-token count, so a
    // rate covering them all is the input lever; audio is priced apart.
    const rows = parseGeminiPricing(
      section(
        'gemini-3-pro-image',
        `<tr><td>Input price</td><td>Not available</td><td>$2.00 (text/image),<br>equivalent to $0.0011 per image</td></tr>
         <tr><td>Output price</td><td>Not available</td><td>$12.00 (text and thinking)<br>$120.00 (images)<br>Equivalent to $0.134 per 1K/2K image<br>and $0.24 per 4K image</td></tr>`,
      ),
      NOW,
    )
    // The per-image lines restate the token rate; they are not extra cost.
    expect(rows.get('gemini-3-pro-image')?.base).toEqual({
      input_tokens: 2e-6,
      output_tokens: 12e-6,
      image_output_tokens: 120e-6,
    })
  })

  it('reads a per-modality row and an audio-only rate', () => {
    const rows = parseGeminiPricing(
      section(
        'gemini-embedding-2',
        `<tr><td>Text input price</td><td>Not available</td><td>$0.20</td></tr>
         <tr><td>Image input price</td><td>Not available</td><td>$0.45 ($0.00012 per image)</td></tr>
         <tr><td>Audio input price</td><td>Not available</td><td>$6.50 ($0.00016 per second)</td></tr>`,
      ),
      NOW,
    )
    expect(rows.get('gemini-embedding-2')?.base).toEqual({
      input_tokens: 0.2 / 1e6,
      image_tokens: 0.45 / 1e6,
      audio_tokens: 6.5 / 1e6,
    })
  })

  it('cards a per-second section, one row per model id', () => {
    const page = untabbed(
      [
        'veo-3.1-generate-preview',
        'veo-3.1-fast-generate-preview',
        'veo-3.1-lite-generate-preview',
      ],
      'second',
      `<tr><td>Veo 3.1 Standard video with audio price (default)</td><td>Not available</td><td>$0.40 (720p and 1080p)<br>$0.60 (4k)</td></tr>
  <tr><td>Veo 3.1 Fast video with audio price (default)</td><td>Not available</td><td>$0.10 (720p)<br>$0.30 (4k)</td></tr>
  <tr><td>Veo 3.1 Lite video with audio price (default)</td><td>Not available</td><td>$0.05 (720p)<br>(4k output not supported)</td></tr>
  <tr><td>Used to improve our products</td><td>Yes</td><td>No</td></tr>`,
    )
    const rows = parseGeminiPricing(page, Date.UTC(2026, 8, 16))
    expect(rows.get('veo-3.1-generate-preview')?.unit).toEqual({
      // Duration and size sit under the request's untyped `parameters`.
      quantity: { param: 'video_seconds', bound: 'usage' },
      keys: [
        {
          param: 'resolution',
          bound: 'usage',
          values: ['720p', '1080p', '4k'],
        },
      ],
      rates: { '720p': 0.4, '1080p': 0.4, '4k': 0.6 },
    })
    expect(rows.get('veo-3.1-fast-generate-preview')?.unit?.rates).toEqual({
      '720p': 0.1,
      '4k': 0.3,
    })
    // A size the model cannot output is not a rate.
    expect(rows.get('veo-3.1-lite-generate-preview')?.unit?.rates).toEqual({
      '720p': 0.05,
    })
  })

  it('cards a per-request section flat', () => {
    const page = untabbed(
      ['lyria-3-clip-preview', 'lyria-3-pro-preview'],
      'request',
      `<tr><td>Lyria 3 Clip Preview (30s)</td><td>Not available</td><td>$0.04 per song</td></tr>
  <tr><td>Lyria 3 Pro Preview (Full Song)</td><td>Not available</td><td>$0.08 per song</td></tr>`,
    )
    const rows = parseGeminiPricing(page, Date.UTC(2026, 8, 16))
    expect(rows.get('lyria-3-clip-preview')?.unit).toEqual({ rates: 0.04 })
    expect(rows.get('lyria-3-pro-preview')?.unit).toEqual({ rates: 0.08 })
  })

  it('refuses a model whose bill is not only tokens', () => {
    // A row priced per image (not a restatement of a token rate), a
    // modality the row has no lever for, and a priced row with no lever.
    const perImage = `<tr><td>Input price</td><td>Not available</td><td>$0.30 (text / image)</td></tr>
       <tr><td>Output price</td><td>Not available</td><td>$0.039 per image</td></tr>`
    const perSong = `<tr><td>Lyria 3.5 (Full Song)</td><td>Not available</td><td>$0.08 per song</td></tr>`
    const unknownModality = `<tr><td>Input price</td><td>Not available</td><td>$1.00 (hologram)</td></tr>`
    for (const rows of [perImage, perSong, unknownModality]) {
      expect(parseGeminiPricing(section('m', rows), NOW).size).toBe(0)
    }
  })

  it('clears the price of an id no section names, and only that', async () => {
    const tokens = `<tr><td>Input price</td><td>Free</td><td>$0.75</td></tr>
       <tr><td>Output price</td><td>Free</td><td>$3.75</td></tr>`
    const perSong = `<tr><td>Lyria 3.5 (Full Song)</td><td>Not available</td><td>$0.08 per song</td></tr>`
    const page =
      section('gemini-3.6-flash', tokens) + section('lyria-3.5', perSong)
    const deprecations =
      'This page lists the known deprecation schedules.\n\n' +
      '| `gemini-2.0-flash` | February 5, 2025 | June 1, 2026 | `gemini-3.6-flash` |\n'
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        new Response(
          String(url).includes('deprecations') ? deprecations : page,
        ),
      ),
    )
    try {
      const pricing = await geminiModelPricing()
      expect(pricing('gemini-3.6-flash').pricing).toBeTruthy()
      expect(pricing('gemini-3.6-flash').absent).toBeUndefined()
      // Deprecated and routed to 3.6: the page has no section for it.
      expect(pricing('gemini-3.5-flash')).toEqual({
        absent: { pricing: 'cleared' },
      })
      // Named but refused by the parser: the stored card is kept.
      expect(pricing('lyria-3.5')).toEqual({})
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('prices an automatically routed id at the successor standard rate', async () => {
    const tokens = (input: string, output: string) =>
      `<tr><td>Input price</td><td>Free</td><td>${input}</td></tr>
       <tr><td>Output price</td><td>Free</td><td>${output}</td></tr>`
    const page =
      section('gemini-3.8-flash', tokens('$0.75', '$3.75')) +
      section('gemini-3.6-flash', tokens('$0.50', '$3.00')) +
      section('gemini-omni-1.1-flash', tokens('$1.00', '$2.00')) +
      section(
        'lyria-3.5',
        `<tr><td>Lyria 3.5 (Full Song)</td><td>Not available</td><td>$0.08 per song</td></tr>`,
      )
    const deprecations = [
      'This page lists the known deprecation schedules.',
      '| `gemini-3.7-flash` | August 13, 2026 | N/A | `gemini-3.8-flash` (the endpoint is not shutting down and automatically routes API requests to `gemini-3.8-flash`) |',
      '| `gemini-3.5-flash` | May 19, 2026 | N/A | `gemini-3.6-flash` (automatically routes API requests to `gemini-3.6-flash`) |',
      '| `gemini-omni-flash-preview` | June 30, 2026 | October 22, 2026 | `gemini-omni-1.1-flash` |',
      '| `lyria-routed` | June 1, 2026 | N/A | `lyria-3.5` (automatically routes API requests to `lyria-3.5`) |',
    ].join('\n')
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        new Response(
          String(url).includes('deprecations') ? deprecations : page,
        ),
      ),
    )
    try {
      const pricing = await geminiModelPricing()
      const quote = (rawId: string) => {
        const card = parseStoredRateCard(pricing(rawId).pricing)
        if (!card) throw new Error(`${rawId} has no card`)
        return evaluateCard(card, {
          usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        })
      }
      expect(quote('gemini-3.7-flash')).toMatchObject({
        amount: 4.5,
        currency: 'USD',
        estimated: [],
      })
      expect(pricing('gemini-3.7-flash').factSources?.pricing?.path).toBe(
        'routed to gemini-3.8-flash',
      )
      expect(quote('gemini-3.5-flash')).toMatchObject({
        amount: 3.5,
        currency: 'USD',
        estimated: [],
      })
      expect(pricing('gemini-3.5-flash').factSources?.pricing?.path).toBe(
        'routed to gemini-3.6-flash',
      )
      expect(pricing('gemini-3.8-flash').factSources?.pricing?.path).toBe(
        'Pricing',
      )
      // A replacement that is not automatic routing is not a rate.
      expect(pricing('gemini-omni-flash-preview')).toEqual({
        absent: { pricing: 'cleared' },
      })
      // The successor is named and the parser refused its card: keep stored.
      expect(pricing('lyria-routed')).toEqual({})
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps parsed prices when the deprecations body is not the page', async () => {
    const page = section(
      'gemini-3.6-flash',
      `<tr><td>Input price</td><td>Free</td><td>$0.75</td></tr>
       <tr><td>Output price</td><td>Free</td><td>$3.75</td></tr>`,
    )
    const run = docsRun()
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(page)))
    try {
      const pricing = await geminiModelPricing(undefined, run)
      expect(pricing('gemini-3.6-flash').pricing).toBeTruthy()
      // Unpriced, and the routes page was unreadable: keep the stored card.
      expect(pricing('gemini-2.0-flash')).toEqual({
        absent: { pricing: 'unavailable' },
      })
      expect(docsReport(run).first[0]?.source).toBe(GEMINI_DEPRECATIONS_URL)
      expect(docsReport(run).first[0]?.error).toMatch(
        /not the Gemini API deprecations page/,
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps stored cards when the pricing page parses nothing (#567)', async () => {
    const run = docsRun()
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        new Response(
          String(url).includes('deprecations')
            ? 'This page lists the known deprecation schedules.\n'
            : '<html></html>',
        ),
      ),
    )
    try {
      const pricing = await geminiModelPricing(undefined, run)
      expect(pricing('gemini-2.5-flash')).toEqual({
        absent: { pricing: 'unavailable' },
      })
      expect(docsReport(run)).toMatchObject({
        failed: 1,
        first: [
          {
            source: GEMINI_PRICING_URL,
            error: 'gemini pricing page: parsed 0 model rows',
          },
        ],
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
