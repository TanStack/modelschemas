import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { verifyExamples } from '@modelschemas/rate-card'

import { NANO_BANANA_2 } from '../../../packages/rate-card/src/fixtures/nano-banana-2.ts'

import {
  FAL_PRICING_EXTRACT_CRONS,
  FAL_PRICING_EXTRACT_CAP,
  FAL_PRICING_EXTRACT_MODEL,
  FAL_PRICING_FETCH_CAP,
  FAL_PRICING_FETCH_FAIL_ABORT,
  EXTRACT_SYSTEM,
  checkExtractedCard,
  isRetryableLlmsStatus,
  extractRateCard,
  gatewayChat,
  isStubPricingSection,
  pricingSection,
  pricingSectionHash,
  resumeIndex,
  shouldSkipExtract,
} from './extract-fal-pricing.ts'
import { parseFalUnitRate } from './fal-unit-rate.ts'
import { SPEC_SYNC_SHARD_CRONS } from './sync.ts'

type RunMock = Mock<
  (
    model: string,
    inputs: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<Response>
>

/** Gateway `run` answering successive chat calls with these contents. */
function gatewayReplies(...replies: Array<unknown>): RunMock {
  const mock: RunMock = vi.fn()
  for (const reply of replies) {
    const content = typeof reply === 'string' ? reply : JSON.stringify(reply)
    mock.mockResolvedValueOnce(sseReply(content))
  }
  return mock
}

/** A streamed Anthropic Messages reply, as the gateway returns it. */
function sseReply(text: string): Response {
  const events: Array<[string, unknown]> = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: FAL_PRICING_EXTRACT_MODEL,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]
  const body = events
    .map(
      ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join('')
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** `env.AI` with only `run` doing anything. */
function fakeAi(run: RunMock): Ai {
  return { run } as unknown as Ai
}

/** The Anthropic Messages body of call `n`. */
function runInput(
  run: RunMock,
  n: number,
): {
  system?: unknown
  messages: Array<{ role: string; content: unknown }>
} {
  return run.mock.calls[n]?.[1] as {
    messages: Array<{ role: string; content: unknown }>
  }
}

/** A message's text, whether sent as a string or as content blocks. */
function textOf(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

const NANO_LLMS = `# Nano Banana 2

## Overview

- **Endpoint**: \`https://fal.run/fal-ai/nano-banana-2\`

## Pricing

Your request will cost **$0.08** per image. For **$1.00**, you can run this model **12** times. 2K and 4K outputs will be charged at **1.5** times and **2** times the standard rate, respectively. 0.5K (512px) resolution outputs will be charged at **0.75** times the standard rate. If web search is used, an additional $0.015 will be charged. If high thinking is used, an additional $0.002 will be charged. **Note: Pricing is subject to change.**

For more details, see [fal.ai pricing](https://fal.ai/pricing).

## API Information

This model can be used via our HTTP API.
`

describe('pricingSection', () => {
  it('cuts the Pricing heading from llms.txt and ignores sibling sections', () => {
    const section = pricingSection(NANO_LLMS)
    expect(section.startsWith('## Pricing')).toBe(true)
    expect(section).toContain('$0.08')
    expect(section).not.toContain('API Information')
    expect(section).not.toContain('Nano Banana 2 is')
  })

  it('is empty when the heading is absent', () => {
    expect(pricingSection('# Title\n\n## Overview\n\nNope.\n')).toBe('')
  })
})

describe('isStubPricingSection', () => {
  it('treats empty, boilerplate, and zero-dollar sections as stubs', () => {
    expect(isStubPricingSection('')).toBe(true)
    expect(
      isStubPricingSection(
        '## Pricing\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).',
      ),
    ).toBe(true)
    expect(
      isStubPricingSection(
        '## Pricing\n\nYour request will cost **$0.00** per image.',
      ),
    ).toBe(true)
  })

  it('keeps a section that names a positive price', () => {
    expect(isStubPricingSection(pricingSection(NANO_LLMS))).toBe(false)
  })

  it('keeps bold and suffix-$ prices the old regex missed (#70)', () => {
    expect(isStubPricingSection('- **Price**: $**0.04** per images')).toBe(
      false,
    )
    expect(isStubPricingSection('- **Price**: **0.17** $ per second')).toBe(
      false,
    )
  })
})

describe('pricingSectionHash', () => {
  it('hashes the Pricing section, not the rest of the file', async () => {
    const a = await pricingSectionHash(pricingSection(NANO_LLMS))
    const b = await pricingSectionHash(
      pricingSection(NANO_LLMS.replace('Nano Banana 2', 'Renamed')),
    )
    const c = await pricingSectionHash(
      pricingSection(NANO_LLMS.replace('$0.08', '$0.09')),
    )
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(b)
    expect(c).not.toBe(a)
  })
})

describe('resumeIndex', () => {
  const ids = ['a/one', 'b/two', 'c/three']

  it('starts at 0 with no cursor and wraps past the tail', () => {
    expect(resumeIndex(ids, null)).toBe(0)
    expect(resumeIndex(ids, 'c/three')).toBe(0)
    expect(resumeIndex(ids, 'b/two')).toBe(2)
  })

  it('resumes after a cursor that left the roster', () => {
    expect(resumeIndex(ids, 'a/two')).toBe(1)
    expect(resumeIndex(ids, 'z/gone')).toBe(0)
  })
})

describe('shouldSkipExtract', () => {
  const hash = 'a'.repeat(64)
  const now = 1_781_150_000

  it('skips an unchanged hash and re-extracts after expiresAt', () => {
    expect(
      shouldSkipExtract({
        storedHash: hash,
        sectionHash: hash,
        hasCard: true,
        stub: false,
        expiresAt: undefined,
        now,
      }),
    ).toBe(true)
    expect(
      shouldSkipExtract({
        storedHash: hash,
        sectionHash: 'b'.repeat(64),
        hasCard: true,
        stub: false,
        expiresAt: undefined,
        now,
      }),
    ).toBe(false)
    expect(
      shouldSkipExtract({
        storedHash: hash,
        sectionHash: hash,
        hasCard: true,
        stub: false,
        expiresAt: '2020-01-01T00:00:00.000Z',
        now,
      }),
    ).toBe(false)
    expect(
      shouldSkipExtract({
        storedHash: hash,
        sectionHash: hash,
        hasCard: true,
        stub: false,
        expiresAt: '2099-01-01T00:00:00.000Z',
        now,
      }),
    ).toBe(true)
  })

  it('retries an unchanged hash whose card is still null unless it is a stub (#84)', () => {
    const base = { storedHash: hash, sectionHash: hash, expiresAt: undefined }
    expect(
      shouldSkipExtract({ ...base, hasCard: false, stub: false, now }),
    ).toBe(false)
    expect(
      shouldSkipExtract({ ...base, hasCard: false, stub: true, now }),
    ).toBe(true)
  })
})

describe('FAL_PRICING_EXTRACT_CRONS', () => {
  it('is six hourly daytime shards, none of them a spec-sync shard', () => {
    expect([...FAL_PRICING_EXTRACT_CRONS]).toEqual([
      '0 6 * * *',
      '0 7 * * *',
      '0 8 * * *',
      '0 9 * * *',
      '0 10 * * *',
      '0 11 * * *',
    ])
    expect(FAL_PRICING_FETCH_CAP).toBe(250)
    expect(FAL_PRICING_EXTRACT_CAP).toBe(40)
    expect(FAL_PRICING_FETCH_FAIL_ABORT).toBe(8)
    expect(FAL_PRICING_EXTRACT_MODEL).toBe('claude-sonnet-5-5')
    for (const cron of FAL_PRICING_EXTRACT_CRONS) {
      expect(
        (SPEC_SYNC_SHARD_CRONS as ReadonlyArray<string>).includes(cron),
      ).toBe(false)
      expect(cron).not.toBe('*/15 * * * *')
    }
    // Six shards x 250 fetches covers the FAL roster in one calendar day.
    expect(
      FAL_PRICING_EXTRACT_CRONS.length * FAL_PRICING_FETCH_CAP,
    ).toBeGreaterThanOrEqual(1500)
  })

  it('keeps wrangler.jsonc in lockstep', async () => {
    const fs = await import('node:fs/promises')
    const raw = await fs.readFile('wrangler.jsonc', 'utf8')
    for (const cron of FAL_PRICING_EXTRACT_CRONS) {
      expect(raw).toContain(`"${cron}"`)
    }
    expect(raw).toContain('"*/15 * * * *"')
    for (const cron of SPEC_SYNC_SHARD_CRONS) {
      expect(raw).toContain(`"${cron}"`)
    }
  })
})

describe('isRetryableLlmsStatus', () => {
  it('retries network, 408, 429, and 5xx; 404 is done', () => {
    expect(isRetryableLlmsStatus(0)).toBe(true)
    expect(isRetryableLlmsStatus(408)).toBe(true)
    expect(isRetryableLlmsStatus(429)).toBe(true)
    expect(isRetryableLlmsStatus(500)).toBe(true)
    expect(isRetryableLlmsStatus(503)).toBe(true)
    expect(isRetryableLlmsStatus(404)).toBe(false)
    expect(isRetryableLlmsStatus(400)).toBe(false)
  })
})

type ExtractArgs = Omit<Parameters<typeof extractRateCard>[0], 'chat'>

function extract(args: ExtractArgs, run: RunMock) {
  return extractRateCard({ ...args, chat: gatewayChat(fakeAi(run), 'gw-test') })
}

async function extractError(
  args: ExtractArgs,
  run: RunMock,
): Promise<string | null> {
  const result = await extract(args, run)
  return typeof result === 'object' && 'error' in result ? result.error : null
}

describe('extractRateCard through the gateway', () => {
  const args = {
    pricingText: pricingSection(NANO_LLMS),
    requestProperties: new Set([
      'num_images',
      'resolution',
      'enable_web_search',
      'thinking_level',
    ]),
    sourceUrl: NANO_BANANA_2.source.url,
    sourceHash: 'c'.repeat(64),
    now: 1_781_150_000,
  }
  const { source: _source, ...body } = NANO_BANANA_2

  it('stamps source and accepts a verified card', async () => {
    const run = gatewayReplies(body)
    const card = await extract(args, run)
    expect(card).not.toBe('unverified')
    expect(card).not.toHaveProperty('error')
    if (card === 'unverified' || 'error' in card) return
    expect(card.source.hash).toBe(args.sourceHash)
    expect(card.source.url).toBe(args.sourceUrl)
    const [model, input, options] = run.mock.calls[0] ?? []
    expect(model).toBe(`anthropic/${FAL_PRICING_EXTRACT_MODEL}`)
    expect(options).toMatchObject({ gateway: { id: 'gw-test' } })
    // Claude 5 400s on temperature (#550).
    expect(input).not.toHaveProperty('temperature')
    expect(textOf(runInput(run, 0).system)).toContain(
      'You write a modelschemas RateCard',
    )
  })

  it('returns unverified only for a section that names no price', async () => {
    const run = gatewayReplies({ unverified: true })
    await expect(
      extract(
        {
          ...args,
          pricingText:
            '## Pricing\n\nSee [fal.ai pricing](https://fal.ai/pricing).',
        },
        run,
      ),
    ).resolves.toBe('unverified')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('sends a priced section back once when the model says unverified (#88)', async () => {
    const run = gatewayReplies({ unverified: true }, body)
    const card = await extract(args, run)
    expect(card).toMatchObject({ price: NANO_BANANA_2.price })
    expect(run).toHaveBeenCalledTimes(2)
    const retry = runInput(run, 1)
    expect(retry.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ])
    expect(textOf(retry.messages[2]?.content)).toContain('$0.08')
  })

  it('returns the rejection when a priced section is refused twice', async () => {
    for (const reply of [{ unverified: true }, { ...body, examples: [] }]) {
      const run = gatewayReplies(reply, reply)
      expect(await extractError(args, run)).toMatch(
        /^rejected twice: the section names/,
      )
      expect(run).toHaveBeenCalledTimes(2)
    }
  })

  it('returns the rejection when verifyExamples fails on both turns', async () => {
    const { examples, ...rest } = body
    const first = examples[0]
    const bad = {
      ...rest,
      examples: first
        ? [{ ...first, usd: 999 }]
        : [{ params: {}, usd: 999, quote: 'nope' }],
    }
    const run = gatewayReplies(bad, bad)
    expect(await extractError(args, run)).toMatch(
      /^rejected twice: verifyExamples failed/,
    )
    expect(textOf(runInput(run, 1).messages[2]?.content)).toContain(
      'verifyExamples failed',
    )
  })

  it('rejects a request-bound param the input schema does not have', async () => {
    const invented = {
      ...body,
      inputs: {
        ...body.inputs,
        num_images: { param: 'image_count', kind: 'number', default: 1 },
      },
    }
    expect(
      await extractError(args, gatewayReplies(invented, invented)),
    ).toMatch(/^rejected twice: a request-bound/)
  })

  it('fails closed on a non-card payload', async () => {
    await expect(
      extract(args, gatewayReplies({ nope: true }, 'not json')),
    ).resolves.toEqual({ error: 'rejected twice: reply is not JSON' })
  })

  it('fails closed when the binding call throws', async () => {
    // The Anthropic SDK reports a thrown fetch as "Connection error.";
    // gatewayChat keeps the binding's own error as the cause.
    const run: RunMock = vi
      .fn()
      .mockRejectedValue(new Error('3040: Capacity temporarily exceeded'))
    expect(await extractError(args, run)).toMatch(
      /Connection error\..*caused by: 3040: Capacity temporarily exceeded/,
    )
  })

  it('does not blame an earlier retried throw for a later HTTP error', async () => {
    const run: RunMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('3040: Capacity temporarily exceeded'))
      .mockImplementation(() =>
        Promise.resolve(
          Response.json(
            { error: { message: 'rate limited' } },
            { status: 429 },
          ),
        ),
      )
    const error = await extractError(args, run)
    expect(error).toMatch(/429.*rate limited/)
    expect(error).not.toContain('3040')
  })

  it('returns the provider status and body when the gateway answers non-ok (#394)', async () => {
    const run: RunMock = vi.fn(() =>
      Promise.resolve(
        Response.json({ error: { message: 'rate limited' } }, { status: 429 }),
      ),
    )
    expect(await extractError(args, run)).toMatch(/429.*rate limited/)
  })

  it('treats an empty reply as a rejection', async () => {
    const run: RunMock = vi.fn(() => Promise.resolve(sseReply('')))
    await expect(extract(args, run)).resolves.toEqual({
      error: 'rejected twice: reply is not JSON',
    })
  })
})

describe('EXTRACT_SYSTEM', () => {
  // The model copies these, so each must pass the checks its reply does.
  // A count input binds a list param; without a worked one the model wrote
  // `{"reference_image_urls": 1}` and `x.length` (#489).
  const workedExamples = [
    ...EXTRACT_SYSTEM.matchAll(
      /Section: "(.+)" Allowed: (.+)\.\n(\{"inputs".+\})$/gm,
    ),
  ].map(([, section = '', allowed = '', reply = '']) => ({
    section,
    allowed: new Set(allowed.split(', ')),
    reply,
  }))

  it('includes a worked count input', () => {
    // Every "Example." in the prompt is parsed, none skipped by the regex.
    expect(workedExamples).toHaveLength(
      EXTRACT_SYSTEM.match(/^Example\. /gm)?.length ?? 0,
    )
    expect(workedExamples.length).toBeGreaterThan(1)
    expect(workedExamples.some(({ reply }) => reply.includes('"count"'))).toBe(
      true,
    )
  })

  it('has worked examples that pass checkExtractedCard', () => {
    expect(workedExamples.length).toBeGreaterThan(0)
    for (const { section, allowed, reply } of workedExamples) {
      const card = checkExtractedCard(reply, {
        pricingText: section,
        requestProperties: allowed,
        sourceUrl: 'https://fal.ai/models/fal-ai/example/llms.txt',
        sourceHash: 'e'.repeat(64),
        now: 1_781_150_000,
      })
      if (card === 'unverified' || 'error' in card) {
        throw new Error(`${section}: ${JSON.stringify(card)}`)
      }
      expect(verifyExamples(card).every((r) => r.ok)).toBe(true)
    }
  })
})

describe('checkExtractedCard', () => {
  const base = {
    requestProperties: new Set(['resolution', 'duration']),
    sourceUrl:
      'https://fal.ai/models/fal-ai/wan-25-preview/text-to-video/llms.txt',
    sourceHash: 'd'.repeat(64),
    now: 1_781_150_000,
  }

  /** Live fal-ai/wan-25-preview/text-to-video, read 2026-09-30. */
  const WAN_TABLE = `## Pricing

Your request will cost **$0.05** per second for **480p**, **$0.10** per second for **720p**, **$0.15** per second for **1080p**.

For more details, see [fal.ai pricing](https://fal.ai/pricing).`

  it('accepts a lookup calculator for a per-second resolution table', () => {
    // The fast path refuses several rates by design — this is leftover work.
    expect(parseFalUnitRate(WAN_TABLE)).toBeNull()
    const reply = {
      inputs: {
        resolution: {
          param: 'resolution',
          kind: 'enum',
          bound: 'request',
          values: ['480p', '720p', '1080p'],
          default: '1080p',
        },
        seconds: { param: 'seconds', kind: 'number', bound: 'usage' },
      },
      tables: { rate: { '480p': 0.05, '720p': 0.1, '1080p': 0.15 } },
      price: {
        '*': [
          { var: 'seconds' },
          { lookup: { table: 'rate', keys: [{ var: 'resolution' }] } },
        ],
      },
      examples: [
        {
          params: { resolution: '480p', seconds: 1 },
          usd: 0.05,
          quote: 'Your request will cost **$0.05** per second for **480p**',
        },
        {
          params: { resolution: '720p', seconds: 1 },
          usd: 0.1,
          quote: '**$0.10** per second for **720p**',
        },
        {
          params: { seconds: 1 },
          usd: 0.15,
          quote: '**$0.15** per second for **1080p**',
        },
      ],
    }
    const card = checkExtractedCard(JSON.stringify(reply), {
      ...base,
      pricingText: WAN_TABLE,
    })
    if (card === 'unverified' || 'error' in card) {
      throw new Error(JSON.stringify(card))
    }
    expect(card.source.hash).toBe(base.sourceHash)
    expect(verifyExamples(card).every((r) => r.ok)).toBe(true)
    expect(card.price).toMatchObject({
      '*': [{ var: 'seconds' }, { lookup: {} }],
    })
  })

  // #304: live grok-4-fast reply for xai/grok-imagine-video/extend-video,
  // whose request has no resolution field.
  it('refuses a usage-bound input with a default', () => {
    const reply = {
      inputs: {
        resolution: {
          param: 'resolution',
          bound: 'usage',
          kind: 'enum',
          values: ['480p', '720p'],
          default: '480p',
        },
        seconds: { param: 'seconds', bound: 'usage', kind: 'number' },
      },
      tables: { rate: { '480p': 0.05, '720p': 0.07 } },
      price: {
        '*': [
          { var: 'seconds' },
          { lookup: { table: 'rate', keys: [{ var: 'resolution' }] } },
        ],
      },
      examples: [
        {
          params: { resolution: '480p', seconds: 1 },
          usd: 0.05,
          quote: 'Cost is **$0.05** per second of 480p output video',
        },
      ],
    }
    const pricingText =
      '## Pricing\n\nCost is **$0.05** per second of 480p output video (**$0.07** at 720p).'
    const refused = checkExtractedCard(JSON.stringify(reply), {
      ...base,
      requestProperties: new Set(['prompt']),
      pricingText,
    })
    expect(
      typeof refused === 'object' && 'error' in refused && refused.error,
    ).toContain('usage-bound enums have a default (resolution)')
    const { default: _default, ...resolution } = reply.inputs.resolution
    const card = checkExtractedCard(
      JSON.stringify({ ...reply, inputs: { ...reply.inputs, resolution } }),
      { ...base, requestProperties: new Set(['prompt']), pricingText },
    )
    expect(typeof card === 'object' && 'inputs' in card).toBe(true)
  })

  it('refuses unverified for the table but allows it for a zero-price stub', () => {
    const refused = checkExtractedCard('{"unverified":true}', {
      ...base,
      pricingText: WAN_TABLE,
    })
    expect(
      typeof refused === 'object' && 'error' in refused && refused.error,
    ).toContain('$0.05')
    expect(
      checkExtractedCard('{"unverified":true}', {
        ...base,
        pricingText:
          '## Pricing\n\nYour request will cost **$0.00** per image.',
      }),
    ).toBe('unverified')
  })
})
