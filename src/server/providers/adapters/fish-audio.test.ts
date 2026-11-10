import { price } from '@modelschemas/rate-card'
import { afterEach, describe, expect, it } from 'vitest'

import { classifyAndBundle } from '#/server/ingest/sync.ts'
import { parseStoredRateCard } from '#/server/rate-card.ts'

import type { OpenApiDocument } from '../types.ts'
import {
  FISH_AUDIO_PRICING_URL,
  fishAudioCard,
  parseFishAudioPricing,
  provider,
} from './fish-audio.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

// Excerpt of the pricing page as served on 2026-11-10.
const PRICING_PAGE = `
## API Pricing

### Text-to-Speech (TTS) Models

| Model Name | Price (USD) |
| - | - |
| \`drama-3\` | \\$50.00 / M UTF-8 bytes |
| \`s2.1-pro\` | \\$15.00 / M UTF-8 bytes |
| \`s2.1-pro-free\` | \\$0.00 / M UTF-8 bytes |
| \`s1\` (deprecated, retiring December 31, 2026) | \\$15.00 / M UTF-8 bytes |

Through November 30, 2026 (until December 1, 00:00 PT / 08:00 UTC), \`drama-3\` is
billed at a launch promotion price of \\$10.00 / M UTF-8 bytes, 80% off the list
price above.

### Automatic Speech Recognition (ASR) Models

| Model Name | Price (USD) |
| - | - |
| \`transcribe-1-pro\` (recommended) | \\$0.36 / audio hour |
| \`transcribe-stream-1\` (Realtime ASR, Preview) | \\$0.36 / session hour |

### Voice Design

| Model Name | Price (USD) |
| - | - |
| \`voice-design-1\` | \\$0.01 / successful API request |

## Rate Limits

| Tier | Spending Threshold | Concurrent Requests |
| - | - | - |
| Starter | \\< \\$100 paid | 5 requests |
`

const SOURCE = {
  url: FISH_AUDIO_PRICING_URL,
  hash: 'a'.repeat(64),
  extractedAt: '2026-11-10T00:00:00.000Z',
}
const PROMO_END = Date.UTC(2026, 11, 1, 8)

describe('parseFishAudioPricing', () => {
  const rows = parseFishAudioPricing(PRICING_PAGE)

  it('reads each section row and the drama-3 promotion', () => {
    expect([...rows.keys()]).toEqual([
      'drama-3',
      's2.1-pro',
      's2.1-pro-free',
      's1',
      'transcribe-1-pro',
      'transcribe-stream-1',
      'voice-design-1',
    ])
    expect(rows.get('drama-3')?.promo).toEqual({ usd: 10, endsAt: PROMO_END })
    expect(rows.get('transcribe-1-pro')?.route).toBe('v1/asr')
  })

  it('bills the promotion until it ends, then the list price', () => {
    const drama = rows.get('drama-3')
    if (!drama) throw new Error('no drama-3')
    const during = fishAudioCard(drama, SOURCE, PROMO_END - 1)
    expect(during && price(during, {}, { utf8_bytes: 1e6 })).toBeCloseTo(10)
    expect(during?.source.expiresAt).toBe('2026-12-01T08:00:00.000Z')
    const after = fishAudioCard(drama, SOURCE, PROMO_END)
    expect(after && price(after, {}, { utf8_bytes: 1e6 })).toBeCloseTo(50)
    expect(after?.source.expiresAt).toBeUndefined()
  })

  it('prices per audio second, per request, and free at zero', () => {
    const card = (id: string) => {
      const row = rows.get(id)
      return row ? fishAudioCard(row, SOURCE, 0) : null
    }
    const asr = card('transcribe-1-pro')
    expect(asr && price(asr, {}, { audio_seconds: 3600 })).toBeCloseTo(0.36)
    const design = card('voice-design-1')
    expect(design && price(design)).toBeCloseTo(0.01)
    const free = card('s2.1-pro-free')
    expect(parseStoredRateCard(free)).not.toBeNull()
    expect(free && price(free, {}, { utf8_bytes: 1e6 })).toBe(0)
  })

  it('throws on an unread price or an unparsed promotion', () => {
    expect(() =>
      parseFishAudioPricing(PRICING_PAGE.replace('/ audio hour', '/ minute')),
    ).toThrow(/transcribe-1-pro has an unread price/)
    expect(() =>
      parseFishAudioPricing(
        PRICING_PAGE.replace('Through November 30, 2026', 'Until Nov 30'),
      ),
    ).toThrow(/promotion/)
  })
})

describe('fish-audio provider', () => {
  it('lists models from the pricing page; the realtime model binds no route', async () => {
    globalThis.fetch = () => Promise.resolve(new Response(PRICING_PAGE))
    const { models } = await provider.listModels({})
    const byId = new Map(models.map((m) => [m.rawId, m]))
    expect(byId.get('s2.1-pro')?.schemaEndpointId).toBe('v1/tts')
    expect(byId.get('transcribe-stream-1')?.schemaEndpointId).toBeNull()
    expect(byId.get('transcribe-1-pro')?.modalities).toMatchObject({
      input: ['audio'],
      output: ['text'],
    })
    expect(models.every((m) => m.activity === 'audio')).toBe(true)
  })

  it('classifies the speech routes and voice-model create, not agents', () => {
    const body = (properties: Record<string, unknown>) => ({
      requestBody: {
        content: {
          'application/json': { schema: { type: 'object', properties } },
        },
      },
      responses: { '200': { description: 'ok' } },
    })
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/v1/tts': { post: body({ text: { type: 'string' } }) },
        '/v1/asr': { post: body({ audio: { type: 'string' } }) },
        '/model': { post: body({ title: { type: 'string' } }) },
        '/v1/agent/agents': { post: body({ name: { type: 'string' } }) },
      },
    } as unknown as OpenApiDocument
    const { endpoints } = classifyAndBundle(provider, {
      specs: [spec],
      sources: [
        {
          url: 'https://docs.fish.audio/api-reference/openapi.json',
          hash: 'h',
        },
      ],
      outputStrategy: 'post-200',
    })
    expect(endpoints.map((e) => e.dbId)).toEqual([
      'fish-audio/v1/tts',
      'fish-audio/v1/asr',
      'fish-audio/model',
    ])
  })
})
