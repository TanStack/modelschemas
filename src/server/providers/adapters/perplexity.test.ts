import { afterEach, describe, expect, it } from 'vitest'

import {
  parsePerplexityModelsPage,
  parsePerplexityEffortLevels,
  provider,
} from './perplexity.ts'

const MODELS_URL = 'https://api.perplexity.ai/v1/models'
const DOC_URL = 'https://docs.perplexity.ai/docs/agent-api/models.md'
const EFFORT_URL = 'https://docs.perplexity.ai/docs/agent-api/effort.md'

const HEADER = [
  '| Model | Input (\\$/1M) | Output (\\$/1M) | Cache read (\\$/1M) | Service tiers | Docs |',
  '| - | - | - | - | - | - |',
]

// One quote level more: how a `> [tab]` blockquote holds its card, table
// and callouts.
const quote = (lines: Array<string>): Array<string> =>
  lines.map((line) => (line === '' ? '>' : `> ${line}`))

// Five tabs of the Agent API models page, as served on 2026-10-07, in the
// markdown export's shape since 2026-10-30: each tab is one `> [tab] Title`
// blockquote holding the card as a `> [card] Title` blockquote, the table,
// and the effort note as a `> [!NOTE]` callout.
const MODELS_DOC = [
  '## Available Models',
  '',
  '> [tab] xAI',
  ...quote([
    '',
    '> [card] xAI',
    '>',
    '> Grok 4.7, 4.6, 4.5, 4.3, and 4.20 variants: flagship, reasoning, non-reasoning, and multi-agent.',
    '',
    ...HEADER,
    '| `xai/grok-4.20-non-reasoning` | 1.25 (\\<200k)<br />2.50 (≥200k) | 2.50 (\\<200k)<br />5.00 (≥200k) | 0.20 | — | [Grok 4.20 Non Reasoning](https://docs.x.ai/developers/models) |',
  ]),
  '',
  '> [tab] Z.AI',
  ...quote([
    '',
    '> [card] Z.AI',
    '>',
    '> GLM 5.3 and GLM 5.3 Flash — Z.AI reasoning models.',
    '',
    ...HEADER,
    '| `perplexity/glm-5.3` | 1.40 | 4.40 | 0.26 | — | [GLM](https://docs.z.ai) |',
    '| `perplexity/glm-5.3-flash` | 0.15 | 0.50 | 0.03 | — | [GLM-5.3 Flash](https://huggingface.co/zai-org/GLM-5.3-Flash) |',
  ]),
  '',
  '> [tab] Moonshot AI',
  ...quote([
    '',
    '> [card] Moonshot AI',
    '>',
    "> Kimi K3 — Moonshot AI's flagship reasoning model.",
    '',
    ...HEADER,
    '| `perplexity/kimi-k3` | 3.00 | 15.00 | 0.30 | — | [Kimi K3](https://huggingface.co/moonshotai/Kimi-K3) |',
    '',
    '> [!NOTE]',
    '>',
    '> Kimi K3 accepts `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` reasoning effort. `minimal` uses low effort, while `xhigh` and `max` use maximum effort. Reasoning tokens are billed at the output-token rate.',
  ]),
  '',
  '> [tab] NVIDIA',
  ...quote([
    '',
    '> [card] NVIDIA',
    '>',
    '> Nemotron 3 Ultra is an open-weight reasoning model.',
    '',
    ...HEADER,
    '| `perplexity/nemotron-3-ultra-550b-a55b` | 0.25 | 2.50 | 0.25 | — | [Nemotron 3 Ultra](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16) |',
  ]),
  '',
  '> [tab] Perplexity',
  ...quote([
    '',
    '> [card] Perplexity',
    '>',
    "> Perplexity's grounded search model.",
    '',
    ...HEADER,
    '| `perplexity/sonar` | 0.25 | 2.50 | 0.0625 | — | — |',
  ]),
  '',
  '## Service tiers',
  '',
  '> [!WARNING]',
  '>',
  '> Not all third-party models support all features (e.g., reasoning, tools). Check model documentation for specific capabilities.',
].join('\n')

const KIMI_SENTENCE =
  'Kimi K3 accepts `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` reasoning effort.'

describe('parsePerplexityModelsPage', () => {
  it('reads the effort sentence and the reasoning-model cards', () => {
    const page = parsePerplexityModelsPage(MODELS_DOC)
    expect([...page.flags]).toEqual([
      ['perplexity/glm-5.3', ['reasoning']],
      ['perplexity/glm-5.3-flash', ['reasoning']],
      ['perplexity/kimi-k3', ['reasoning', 'reasoning_effort']],
      ['perplexity/nemotron-3-ultra-550b-a55b', ['reasoning']],
    ])
    expect([...page.efforts]).toEqual([
      [
        'perplexity/kimi-k3',
        ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      ],
    ])
  })

  it('reads a reasoning-model card that goes on to state other facts', () => {
    // The NVIDIA tab as served on 2026-10-15.
    const nvidia = MODELS_DOC.replace(
      /^> > Nemotron 3 Ultra[^]*?(?=> \[tab\] Perplexity)/m,
      [
        ...quote([
          '> Nemotron 3.5 Super is a reasoning model with a 1,048,576-token context window and up to 131,072 output tokens. It accepts text input only.',
          '',
          ...HEADER,
          '| `perplexity/nemotron-3.5-super-120b-a12b` | 0.20 | 0.50 | 0.04 | — | — |',
        ]),
        '',
        '',
      ].join('\n'),
    )
    expect(nvidia).not.toBe(MODELS_DOC)
    const page = parsePerplexityModelsPage(nvidia)
    expect(page.flags.get('perplexity/nemotron-3.5-super-120b-a12b')).toEqual([
      'reasoning',
    ])
    expect(page.flags.has('perplexity/nemotron-3-ultra-550b-a55b')).toBe(false)
    // The same sentence's limits are that model's, and no other row's.
    expect([...page.limits]).toEqual([
      [
        'perplexity/nemotron-3.5-super-120b-a12b',
        { contextWindow: 1_048_576, maxOutput: 131_072 },
      ],
    ])
  })

  it('leaves the effort flag off when no tab states an effort', () => {
    const silent = MODELS_DOC.replace(
      /^>\n> > \[!NOTE\]\n> >\n> > Kimi K3[^\n]*\n/m,
      '',
    )
    const page = parsePerplexityModelsPage(silent)
    expect(page.flags.get('perplexity/kimi-k3')).toEqual(['reasoning'])
    expect(page.efforts.size).toBe(0)
  })

  it.each([
    ['a reworded sentence', 'Kimi K3 accepts', 'Kimi K3 supports'],
    [
      'a list with prose in it',
      '`xhigh`, and `max`',
      '`xhigh`, and up to `max`',
    ],
    ['a name no row carries', 'Kimi K3 accepts', 'Kimi K4 accepts'],
    [
      'a second, unread mention',
      'output-token rate.',
      'output-token rate.\n> >\n> > GLM takes any reasoning effort.',
    ],
    [
      'a second sentence for the same model',
      'output-token rate.',
      'output-token rate.\n> >\n> > Kimi K3 accepts `low` and `high` reasoning effort.',
    ],
    [
      'the sentence moved outside the tabs',
      /^>\n> > \[!NOTE\]\n> >\n> > Kimi K3 accepts[^\n]*\n([^]*?## Service tiers\n)/m,
      `$1\n${KIMI_SENTENCE}\n`,
    ],
    [
      'a statement that reasoning cannot be disabled',
      'reasoning effort. `minimal`',
      'reasoning effort. Reasoning cannot be disabled. `minimal`',
    ],
    [
      'a statement that the model always thinks',
      "Kimi K3 — Moonshot AI's flagship reasoning model.",
      "Kimi K3 — Moonshot AI's flagship always-on reasoning model.",
    ],
    [
      'a card naming fewer models than its tab lists',
      'GLM 5.3 and GLM 5.3 Flash — Z.AI',
      'GLM 5.3 — Z.AI',
    ],
    [
      'a card that denies it',
      'is an open-weight reasoning model',
      'is not a reasoning model',
    ],
    [
      'a reworded card',
      'is an open-weight reasoning model.',
      'ranks among open reasoning models, in our tests.',
    ],
    [
      'a card with a second sentence on reasoning models',
      'is an open-weight reasoning model.',
      'is an open-weight reasoning model. It replaces our older reasoning models.',
    ],
    [
      'a second card sentence on thinking',
      'is an open-weight reasoning model.',
      'is an open-weight reasoning model. You cannot turn its thinking off.',
    ],
    [
      'a "with" clause on reasoning',
      'is an open-weight reasoning model.',
      'is an open-weight reasoning model with reasoning off by default.',
    ],
    [
      'a "with" clause on whether thinking can be skipped',
      'is an open-weight reasoning model.',
      'is an open-weight reasoning model with a mandatory chain-of-thought.',
    ],
    [
      'a "with" clause in another shape',
      'is an open-weight reasoning model.',
      'is an open-weight reasoning model with a chain-of-thought you cannot skip.',
    ],
    [
      'a card titled for another tab',
      '> > [card] NVIDIA',
      '> > [card] Nemotron',
    ],
    [
      'a card with no spacer line',
      '> > [card] Z.AI\n> >\n',
      '> > [card] Z.AI\n',
    ],
    ['a tab title in another shape', '> [tab] Z.AI\n', '> [tabs] Z.AI\n'],
    ['a tab with no spacer line', '> [tab] Z.AI\n>\n', '> [tab] Z.AI\n'],
    [
      'a card split by a blank line',
      '> > Nemotron 3 Ultra is',
      '> > NVIDIA Nemotron.\n>\n> > Nemotron 3 Ultra is',
    ],
    ['a card and table outside any tab', '> [tab] xAI\n>\n', ''],
    [
      'a callout split from its tab by a blank line',
      '\n\n> [tab] NVIDIA',
      '\n\n> > [!NOTE]\n> >\n> > Reasoning cannot be disabled on GLM 5.3.\n\n> [tab] NVIDIA',
    ],
    [
      'prose between tabs',
      '\n\n> [tab] NVIDIA',
      '\n\nThinking is always on for Z.AI models.\n\n> [tab] NVIDIA',
    ],
    [
      'a bold tab title and card, as the export wrote them before 2026-10-30',
      '> [tab] Z.AI\n>\n> > [card] Z.AI',
      '**Z.AI**\n\n> **Z.AI**',
    ],
    [
      'a card that goes on with a clause other than "with"',
      'is an open-weight reasoning model.',
      'is an open-weight reasoning model for agents.',
    ],
  ])('throws on %s', (_case, from, to) => {
    const mutated = MODELS_DOC.replace(from, to)
    expect(mutated).not.toBe(MODELS_DOC)
    expect(() => parsePerplexityModelsPage(mutated)).toThrow('unread shape')
  })

  it('reads only the Available Models section', () => {
    const later = [
      MODELS_DOC,
      '',
      '> [tab] Extra',
      ...quote([
        '',
        '> [card] Extra',
        '>',
        '> Extra is a reasoning model.',
        '',
        ...HEADER,
        '| `perplexity/extra` | 1 | 1 | 1 | — | — |',
      ]),
    ].join('\n')
    expect(parsePerplexityModelsPage(later).flags.has('perplexity/extra')).toBe(
      false,
    )
  })

  it('throws on a page with no model table, such as an HTML error page', () => {
    expect(() => parsePerplexityModelsPage('<html>Not found</html>')).toThrow(
      'lists no models',
    )
  })
})

// Three of the five effort levels as served on 2026-10-22, when the
// presets page became the effort page, in the markdown export's shape since
// 2026-10-30: each accordion is one `> [accordion] title` blockquote.
// Bullets are trimmed, and only `fast` keeps its prompt block, cut to one
// `## ` heading; the real blocks also hold SDK code samples.
const EFFORT_DOC = [
  '## Current effort level values',
  '',
  '> [accordion] fast — current effort level values',
  '>',
  '> Quick factual lookups with minimal latency and inline citations for search-backed claims.',
  '>',
  '> * **Model:** `openai/gpt-6-luna`',
  '> * **Prompt cache key:** `fast`',
  '> * **Max steps:** 1',
  '> * **Reasoning effort:** `none`',
  '> * **Service tier:** `priority`',
  '> * **Max output tokens:** 8192',
  '> * **Tools:** `web_search`',
  '> * **System prompt:** included inline below',
  '>',
  '> ```text',
  '> ## Role',
  '> ```',
  '',
  '> [accordion] low — current effort level values',
  '>',
  '> * **Model:** `openai/gpt-6-luna`',
  '> * **Reasoning effort:** `minimal`',
  '> * **Tools:** `web_search`, `fetch_url` (`max_urls: 1`)',
  '',
  '> [accordion] xhigh — current effort level values',
  '>',
  '> * **Model:** `anthropic/claude-opus-5-5`',
  '> * **Max steps:** 100',
  '> * **Reasoning effort:** `high`',
  '> * **Tools:** `web_search`, `finance_search`, `sandbox`',
  '',
  '## Next Steps',
  '',
  '> **[Agent API Models](/docs/agent-api/models)**',
].join('\n')

describe('parsePerplexityEffortLevels', () => {
  it('reads each effort level model with the effort and tools it runs with', () => {
    expect([...parsePerplexityEffortLevels(EFFORT_DOC)]).toEqual([
      ['openai/gpt-6-luna', ['reasoning', 'reasoning_effort', 'tools']],
      ['anthropic/claude-opus-5-5', ['reasoning', 'reasoning_effort', 'tools']],
    ])
  })

  // The change served on 2026-10-29, trimmed like EFFORT_DOC: `fast` and
  // `xhigh` name a fallback model, and `ultra-preview` names no model (its
  // code samples are cut).
  const FALLBACK_DOC = EFFORT_DOC.replace(
    '> * **Model:** `openai/gpt-6-luna`\n> * **Prompt cache key:** `fast`',
    '> * **Models:** `openai/gpt-6-luna`, with `openai/gpt-5.6-luna` as the [fallback model](https://docs.perplexity.ai/docs/agent-api/model-fallback.md)\n> * **Prompt cache key:** `fast`',
  )
    .replace(
      '> * **Model:** `anthropic/claude-opus-5-5`',
      '> * **Models:** `anthropic/claude-opus-5-5`, with `openai/gpt-6.1-sol` as the [fallback model](https://docs.perplexity.ai/docs/agent-api/model-fallback.md)',
    )
    .replace(
      '\n## Next Steps',
      [
        '',
        '> [accordion] ultra-preview — current effort level values',
        '>',
        '> Broad research and data-gathering tasks where coverage matters most.',
        '>',
        '> `ultra-preview` has no frozen configuration. Its settings are not all part of the documented request schema, so call it by name.',
        '',
        '## Next Steps',
      ].join('\n'),
    )

  // Served by 2026-11-08: `ultra` titles the accordion with a colon, and
  // names the model it runs on in the no-frozen-configuration sentence.
  const COLON_DOC = [
    '## Current effort level values',
    '',
    '> [accordion] fast — current effort level values',
    '>',
    '> * **Models:** `openai/gpt-6-luna`, with `openai/gpt-5.6-luna` as the [fallback model](https://docs.perplexity.ai/docs/agent-api/model-fallback.md)',
    '> * **Reasoning effort:** `none`',
    '> * **Tools:** `web_search`',
    '',
    '> [accordion] ultra: current effort level values',
    '>',
    '> `ultra` has no frozen configuration. It runs on `anthropic/claude-opus-5-5`, and its settings are not all part of the documented request schema, so call it by name.',
    '',
    '## Next Steps',
  ].join('\n')

  it('reads a colon-titled accordion and skips a level that names a model only in its no-frozen-configuration sentence', () => {
    expect([...parsePerplexityEffortLevels(COLON_DOC)]).toEqual([
      ['openai/gpt-6-luna', ['reasoning', 'reasoning_effort', 'tools']],
    ])
  })

  it("reads the first of a level's models, and skips a level with no frozen configuration", () => {
    expect(FALLBACK_DOC.match(/\*\*Models:\*\*/g)).toHaveLength(2)
    expect(FALLBACK_DOC).toContain('ultra-preview')
    expect([...parsePerplexityEffortLevels(FALLBACK_DOC)]).toEqual([
      ['openai/gpt-6-luna', ['reasoning', 'reasoning_effort', 'tools']],
      ['anthropic/claude-opus-5-5', ['reasoning', 'reasoning_effort', 'tools']],
    ])
  })

  it.each([
    [
      'a fallback clause in another shape',
      'as the [fallback model]',
      'as backup',
    ],
    [
      'a model-less level that states a setting',
      '> `ultra-preview` has no',
      '> * **Max steps:** 300\n>\n> `ultra-preview` has no',
    ],
    [
      'a model-less level that does not say it has no frozen configuration',
      'has no frozen configuration.',
      'is in preview.',
    ],
    [
      "a model-less level quoting another level's frozen configuration",
      '> `ultra-preview` has no',
      '> `fast` has no',
    ],
    [
      'both a Model and a Models bullet',
      '> * **Prompt cache key:** `fast`',
      '> * **Model:** `openai/gpt-6-luna`\n> * **Prompt cache key:** `fast`',
    ],
  ])('throws on %s', (_case, from, to) => {
    const mutated = FALLBACK_DOC.replace(from, to)
    expect(mutated).not.toBe(FALLBACK_DOC)
    expect(() => parsePerplexityEffortLevels(mutated)).toThrow(
      'perplexity: effort level names no model',
    )
  })

  it('gives a level with no tools or effort bullet neither flag', () => {
    const bare = EFFORT_DOC.replace(
      '> * **Reasoning effort:** `high`\n> * **Tools:** `web_search`, `finance_search`, `sandbox`\n',
      '',
    )
    expect(
      parsePerplexityEffortLevels(bare).has('anthropic/claude-opus-5-5'),
    ).toBe(false)
  })

  it.each([
    [
      'a level with no model bullet',
      '* **Model:** `openai',
      '* **LLM:** `openai',
    ],
    ['a model that is prose', '`anthropic/claude-opus-5-5`', 'Claude Opus 5.5'],
    ['an effort that is prose', '`high`', 'high, or lower on retries'],
    [
      'tools that are prose',
      '`web_search`, `finance_search`, `sandbox`',
      'none',
    ],
    [
      'a bullet stated twice',
      '> * **Max steps:** 100',
      '> * **Model:** `openai/gpt-6-sol`',
    ],
    [
      'a page with no effort level accordions',
      / — current effort level values/g,
      '',
    ],
    [
      'the accordion title the presets page used before 2026-10-22',
      / — current effort level values/g,
      ' — current preset values',
    ],
    [
      'an accordion split by a blank line',
      '> * **Reasoning effort:** `high`\n',
      '> * **Reasoning effort:** `high`\n\n',
    ],
    [
      'an accordion title in another shape',
      '> [accordion] xhigh — current effort level values',
      '> [accordion] xhigh — current effort level values (beta)',
    ],
  ])('throws on %s', (_case, from, to) => {
    const mutated = EFFORT_DOC.replace(from, to)
    expect(mutated).not.toBe(EFFORT_DOC)
    expect(() => parsePerplexityEffortLevels(mutated)).toThrow(
      'perplexity: effort',
    )
  })
})

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('perplexity provider', () => {
  it('exports seed metadata for the isolation loader', () => {
    expect(provider.id).toBe('perplexity')
    expect(provider.displayName).toBe('Perplexity')
    expect(provider.authEnvVar).toBe('PERPLEXITY_API_KEY')
    expect(provider.defaultDerivation).toBe('upstream-spec')
    expect(provider.specSourceUrl).toBe(
      'https://docs.perplexity.ai/openapi.json',
    )
    expect(provider.modelsEndpoint).toBe('https://api.perplexity.ai/v1/models')
  })

  it('names the maker the id is namespaced under, and none for hosted ids', () => {
    expect(
      provider.upstreamModelIdentity?.('xai/grok-4.20-non-reasoning'),
    ).toMatchObject({
      providerNamespace: 'xai',
      rawId: 'grok-4.20-non-reasoning',
      source: { derivation: 'listing', path: 'data[].id' },
    })
    expect(provider.upstreamModelIdentity?.('perplexity/kimi-k3')).toBeNull()
    expect(provider.upstreamModelIdentity?.('sonar')).toBeNull()
  })
})

describe('perplexity classify', () => {
  it('maps generation paths and drops search, async, and platform', () => {
    expect(provider.classify('/v1/sonar', {})).toBe('chat')
    expect(provider.classify('/v1/agent', {})).toBe('chat')
    expect(provider.classify('/v1/embeddings', {})).toBe('embeddings')
    expect(provider.classify('/v1/contextualizedembeddings', {})).toBe(
      'embeddings',
    )
    expect(provider.classify('/search', {})).toBeNull()
    expect(provider.classify('/v1/async/sonar', {})).toBeNull()
    expect(provider.classify('/v1/models', {})).toBeNull()
    expect(provider.classify('/v1/agent/{id}/cancel', {})).toBeNull()
    expect(provider.classify('/v1/analytics/computer/usage', {})).toBeNull()
  })
})

describe('perplexity listModels', () => {
  it('skips when the secret is absent', async () => {
    const result = await provider.listModels({})
    expect(result.skipped).toBe(
      'perplexity: PERPLEXITY_API_KEY not set — skipped',
    )
    expect(result.models).toEqual([])
  })

  it('joins the listing to the flags both docs pages state', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      urls.push(String(url))
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      if (String(url) === DOC_URL) {
        return Promise.resolve(new Response(MODELS_DOC))
      }
      if (String(url) === EFFORT_URL) {
        return Promise.resolve(new Response(EFFORT_DOC))
      }
      expect(
        new Headers(init?.headers).get('Authorization')?.startsWith('Bearer '),
      ).toBe(true)
      return Promise.resolve(
        Response.json({
          object: 'list',
          data: [
            { id: 'perplexity/kimi-k3', created: 1 },
            { id: 'perplexity/sonar', created: 2 },
            { id: 'openai/gpt-6-luna', created: 3 },
            { id: 'xai/grok-4.20-non-reasoning', created: 4 },
          ],
        }),
      )
    }) as typeof fetch

    const result = await provider.listModels({
      PERPLEXITY_API_KEY: 'test-key',
    })
    expect(urls.sort()).toEqual([MODELS_URL, EFFORT_URL, DOC_URL])
    expect(result.skipped).toBeUndefined()
    const source = (sourceUrl: string, path: string) => ({
      derivation: 'docs-derived',
      sourceUrl,
      sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      path,
    })
    expect(result.models).toEqual([
      {
        rawId: 'perplexity/kimi-k3',
        releasedAt: 1,
        activity: 'chat',
        capabilities: ['reasoning', 'reasoning_effort'],
        // The page publishes the levels and is silent on turning it off.
        reasoning: {
          mode: 'effort',
          mandatory: null,
          efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        },
        factSources: {
          reasoning: source(DOC_URL, 'reasoning_effort'),
          capabilities: {
            reasoning: source(DOC_URL, 'reasoning'),
            reasoning_effort: source(DOC_URL, 'reasoning_effort'),
          },
        },
      },
      { rawId: 'perplexity/sonar', releasedAt: 2, activity: 'chat' },
      {
        rawId: 'openai/gpt-6-luna',
        releasedAt: 3,
        activity: 'chat',
        capabilities: ['reasoning', 'reasoning_effort', 'tools'],
        factSources: {
          capabilities: {
            reasoning: source(EFFORT_URL, 'reasoning'),
            reasoning_effort: source(EFFORT_URL, 'reasoning_effort'),
            tools: source(EFFORT_URL, 'tools'),
          },
        },
      },
      { rawId: 'xai/grok-4.20-non-reasoning', releasedAt: 4, activity: 'chat' },
    ])
    // Only the row whose effort list the models page states gets `reasoning`.
    expect(result.models.filter((model) => model.reasoning != null)).toEqual([
      expect.objectContaining({ rawId: 'perplexity/kimi-k3' }),
    ])
    expect(
      provider.generationEndpointId?.({
        rawId: 'perplexity/sonar',
        activity: 'chat',
      }),
    ).toBe('v1/agent')
  })

  it('puts a card sentence’s limits on its own row only', async () => {
    const nemotron = 'perplexity/nemotron-3.5-super-120b-a12b'
    const nvidia = MODELS_DOC.replace(
      /^> > Nemotron 3 Ultra[^]*?(?=> \[tab\] Perplexity)/m,
      [
        ...quote([
          '> Nemotron 3.5 Super is a reasoning model with a 1,048,576-token context window and up to 131,072 output tokens. It accepts text input only.',
          '',
          ...HEADER,
          `| \`${nemotron}\` | 0.20 | 0.50 | 0.04 | — | — |`,
        ]),
        '',
        '',
      ].join('\n'),
    )
    globalThis.fetch = ((url: string) =>
      Promise.resolve(
        String(url) === MODELS_URL
          ? Response.json({
              data: [{ id: nemotron }, { id: 'perplexity/sonar' }],
            })
          : new Response(String(url) === DOC_URL ? nvidia : EFFORT_DOC),
      )) as typeof fetch
    const { models } = await provider.listModels({
      PERPLEXITY_API_KEY: 'test-key',
    })
    const row = models.find((m) => m.rawId === nemotron)
    expect(row).toMatchObject({
      contextWindow: 1_048_576,
      maxOutput: 131_072,
      factSources: {
        contextWindow: { derivation: 'docs-derived', sourceUrl: DOC_URL },
        maxOutput: { derivation: 'docs-derived', sourceUrl: DOC_URL },
      },
    })
    expect(row?.factSources?.contextWindow?.sourceHash).toMatch(
      /^[0-9a-f]{64}$/,
    )
    const sonar = models.find((m) => m.rawId === 'perplexity/sonar')
    expect(sonar?.contextWindow).toBeUndefined()
    expect(sonar?.factSources?.contextWindow).toBeUndefined()
  })

  it('reads an off value in the published list as "can be turned off"', async () => {
    const withNone = MODELS_DOC.replace('accepts `minimal`,', 'accepts `none`,')
    expect(withNone).not.toBe(MODELS_DOC)
    globalThis.fetch = ((url: string) =>
      Promise.resolve(
        String(url) === MODELS_URL
          ? Response.json({ data: [{ id: 'perplexity/kimi-k3' }] })
          : new Response(String(url) === DOC_URL ? withNone : EFFORT_DOC),
      )) as typeof fetch
    const result = await provider.listModels({ PERPLEXITY_API_KEY: 'test-key' })
    expect(result.models[0]?.reasoning).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    })
  })

  it('still lists, and reports the page, when a docs page is an HTML error page', async () => {
    globalThis.fetch = ((url: string) =>
      Promise.resolve(
        String(url) === MODELS_URL
          ? Response.json({ data: [{ id: 'perplexity/sonar' }] })
          : String(url) === DOC_URL
            ? new Response(MODELS_DOC)
            : new Response('<html>Not found</html>'),
      )) as typeof fetch
    // One page down withholds both pages' flags: half of them would read
    // as the other half dropped.
    expect(
      await provider.listModels({ PERPLEXITY_API_KEY: 'test-key' }),
    ).toEqual({
      models: [
        {
          rawId: 'perplexity/sonar',
          releasedAt: null,
          activity: 'chat',
          absent: {
            capabilities: 'unavailable',
            reasoning: 'unavailable',
            contextWindow: 'unavailable',
            maxOutput: 'unavailable',
          },
        },
      ],
      docsFailures: {
        failed: 1,
        skipped: 0,
        first: [
          {
            source: EFFORT_URL,
            error: 'perplexity: effort page lists no effort levels',
            elapsedMs: expect.any(Number) as number,
          },
        ],
      },
    })
  })

  it('fails the poll when the listing fails', async () => {
    globalThis.fetch = ((url: string) =>
      Promise.resolve(
        String(url) === MODELS_URL
          ? new Response('down', { status: 503 })
          : new Response(String(url) === DOC_URL ? MODELS_DOC : EFFORT_DOC),
      )) as typeof fetch
    await expect(
      provider.listModels({ PERPLEXITY_API_KEY: 'test-key' }),
    ).rejects.toThrow('503')
  })
})

describe('perplexity fetchSpec', () => {
  it('loads the published OpenAPI document without a key', async () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'Perplexity AI API' },
      paths: { '/v1/sonar': { post: { summary: 'Create Chat Completion' } } },
    }
    globalThis.fetch = ((url: string) => {
      expect(String(url)).toBe('https://docs.perplexity.ai/openapi.json')
      return Promise.resolve(new Response(JSON.stringify(spec)))
    }) as typeof fetch

    const fetched = await provider.fetchSpec({})
    expect(fetched.specs).toHaveLength(1)
    expect(fetched.specs[0]?.info?.title).toBe('Perplexity AI API')
    expect(fetched.sources[0]?.url).toBe(
      'https://docs.perplexity.ai/openapi.json',
    )
    expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(fetched.outputStrategy).toBe('post-200')
  })
})
