import { describe, expect, it } from 'vitest'

import { price, priceDetailed } from '@modelschemas/rate-card'

import { storeListedPricing } from '../rate-card.ts'

import {
  byteplusRatesFor,
  compilePeriodCard,
  compileSeedanceCard,
  compileSeedreamProCard,
  parseByteplusAliases,
  parseByteplusImages,
  parseByteplusModelPage,
  parseByteplusPixelTiers,
  parseByteplusPricing,
  parseByteplusVideo,
  parseSeedanceGeometry,
  sharePublishedAliases,
} from './byteplus-pricing.ts'
import type { ByteplusDoc } from './byteplus-pricing.ts'
import liveImages from './fixtures/byteplus-pricing-images.json'
import { pricingDoc } from './fixtures/byteplus-pricing-doc.ts'
import type { PricingTable } from './fixtures/byteplus-pricing-doc.ts'
import { overlayModelFacts } from './reasoning-config.ts'
import type { ModelInfo } from './types.ts'

function cell(id: string, text: string) {
  return {
    ops: [{ insert: '*', attributes: { lmkr: '1' } }, { insert: `${text}\n` }],
    zoneId: id,
    zoneType: 'Z',
  }
}

/** Chat-table header as the live page words it (read 2026-10-23). */
const CHAT_HEADERS = [
  'Provider',
  'Model ID',
  'Prompt length (K tokens)',
  'Input',
  'Cached input',
  'Cache storage',
  'Output',
]

/** "Audio input" table: no output column (the chat table quotes it). */
const AUDIO_HEADERS = [
  'Model ID',
  'Prompt length (K tokens)',
  'Input',
  'Cached input',
]

/** Page document of `tables`, each a header row then body rows. */
function doc(...tables: Array<Array<Array<string>>>): ByteplusDoc {
  const data: ByteplusDoc['data'] = { '0': { ops: [] } }
  tables.forEach((body, t) => {
    data['0']?.ops?.push({
      insert: '*',
      attributes: { aceTable: `rows${t} cols${t}` },
    })
    data[`rows${t}`] = {
      ops: body.map((_, index) => ({ insert: { id: `t${t}r${index}` } })),
      zoneType: 'R',
    }
    data[`cols${t}`] = {
      ops: (body[0] ?? []).map((_, index) => ({
        insert: { id: `t${t}c${index}` },
      })),
      zoneType: 'C',
    }
    body.forEach((cells, row) => {
      cells.forEach((text, column) => {
        const id = `xt${t}r${row}xt${t}c${column}`
        data[id] = cell(id, text)
      })
    })
  })
  return { data }
}

describe('byteplus pricing page', () => {
  it('reads standard token rates, tiers, and a dated catalog suffix', () => {
    const rates = parseByteplusPricing(
      pricingDoc([
        // Flex is not a lever, even first and with every Standard column.
        {
          tab: 'Flex',
          rows: [
            CHAT_HEADERS,
            [
              'Z.ai',
              'glm-5-2-260617',
              'Not applicable',
              '$0.7',
              '$0.26',
              '$0.0083',
              '$2.2',
            ],
          ],
        },
        {
          tab: 'Flex',
          rows: [
            AUDIO_HEADERS,
            ['seed-2-0-lite-260428', '[0, 128]', '$1.88', '$0.75'],
            ['', '(128, 256]', '$3.75', '$1.50'],
          ],
        },
        {
          tab: 'Standard',
          rows: [
            CHAT_HEADERS,
            [
              'ByteDance',
              'dola-seed-2-1-turbo',
              '[0, 256]',
              '$0.5',
              '$0.1',
              '$0.0083',
              '$2.5',
            ],
            [
              '',
              'seed-2-0-pro-260328',
              '[0, 128]',
              '$0.50',
              '$0.10',
              '$0.0083',
              '$3.00',
            ],
            ['', '', '(128, 256]', '$1.00', '$0.20', '$0.0083', '$6.00'],
            [
              '',
              'seed-2-0-lite-260428',
              '[0, 128]',
              '$0.25',
              '$0.05',
              '$0.0083',
              '$2.00',
            ],
            ['', '', '(128, 256]', '$0.50', '$0.10', '$0.0083', '$4.00'],
            [
              'DeepSeek',
              'deepseek-v4-1-flash-260910',
              'Off-peak hours',
              '$0.15',
              '$0.003',
              '$0.0083',
              '$0.60',
            ],
            ['', '', 'Peak hours', '$0.30', '$0.006', '$0.0083', '$1.20'],
            [
              'Z.ai',
              'glm-5-2-260617',
              'Not applicable',
              '$1.4',
              '$0.26',
              '$0.0083',
              '$4.4',
            ],
          ],
        },
        {
          tab: 'Standard',
          rows: [
            AUDIO_HEADERS,
            ['seed-2-0-lite-260428', '[0, 128]', '$3.75', '$0.75'],
            ['', '(128, 256]', '$7.50', '$1.50'],
          ],
        },
        {
          tab: 'Standard',
          folded: true,
          rows: [
            ['Model ID', 'Recommended replacement', ...CHAT_HEADERS.slice(2)],
            [
              'seed-1-8-251228',
              'dola-seed-2-0-lite-260428',
              'Not applicable',
              '$0.25',
              '$0.05',
              '$0.0083',
              '$2.00',
            ],
          ],
        },
      ]),
    )
    expect(rates.get('glm-5-2-260617')).toEqual({
      base: {
        input_tokens: 1.4e-6,
        cache_read_tokens: 0.26e-6,
        output_tokens: 4.4e-6,
      },
      tiers: [],
    })
    // Standard audio joins each chat bracket; the Flex audio table is not read.
    expect(rates.get('seed-2-0-lite-260428')).toEqual({
      base: {
        input_tokens: 0.25e-6,
        cache_read_tokens: 0.05 / 1e6,
        output_tokens: 2e-6,
        audio_tokens: 3.75e-6,
        audio_cache_tokens: 0.75e-6,
      },
      tiers: [
        {
          minPromptTokens: 128_000,
          rates: {
            input_tokens: 0.5e-6,
            cache_read_tokens: 0.1 / 1e6,
            output_tokens: 4e-6,
            audio_tokens: 7.5e-6,
            audio_cache_tokens: 1.5e-6,
          },
        },
      ],
    })
    // The folded "Retiring models" Standard table is read too.
    expect(rates.get('seed-1-8-251228')).toMatchObject({
      base: { input_tokens: 0.25e-6, output_tokens: 2e-6 },
    })
    expect(rates.get('seed-2-0-pro-260328')).toMatchObject({
      tiers: [
        {
          minPromptTokens: 128_000,
          rates: {
            input_tokens: 1 / 1e6,
            cache_read_tokens: 0.2 / 1e6,
            output_tokens: 6 / 1e6,
          },
        },
      ],
    })
    // Cache storage is per hour, so it is not a lever.
    expect(rates.get('glm-5-2-260617')).not.toHaveProperty('base.cache_storage')
    // Peak and off-peak rows are kept apart, never folded into one price.
    expect(rates.get('deepseek-v4-1-flash-260910')).toEqual({
      periods: {
        off_peak: {
          input_tokens: 0.15e-6,
          cache_read_tokens: 0.003e-6,
          output_tokens: 0.6e-6,
        },
        peak: {
          input_tokens: 0.3e-6,
          cache_read_tokens: 0.006e-6,
          output_tokens: 1.2e-6,
        },
      },
    })
    expect(byteplusRatesFor('dola-seed-2-1-turbo-260628', rates)).toMatchObject(
      { base: { input_tokens: 0.5e-6 } },
    )
    expect(byteplusRatesFor('seed-translation-250915', rates)).toBeUndefined()
    // Only a dated suffix reaches an undated row, never a sibling model.
    expect(
      byteplusRatesFor('dola-seed-2-1-turbo-flash-260628', rates),
    ).toBeUndefined()
  })

  it('refuses a period group that is not one off-peak and one peak row', () => {
    const offPeak = [
      'DeepSeek',
      'deepseek-v4-1-flash-261017',
      'Off-peak hours',
      '$0.15',
      '$0.003',
      '$0.0083',
      '$0.60',
    ]
    const standard = (...rows: Array<Array<string>>): Array<PricingTable> => [
      { tab: 'Standard', rows: [CHAT_HEADERS, ...rows] },
    ]
    const twoOffPeak = parseByteplusPricing(
      pricingDoc(standard(offPeak, ['', '', ...offPeak.slice(2)])),
    )
    expect(twoOffPeak.has('deepseek-v4-1-flash-261017')).toBe(false)
    const mixed = parseByteplusPricing(
      pricingDoc(
        standard(offPeak, ['', '', '(128, 256]', '$1', '-', '-', '$2']),
      ),
    )
    expect(mixed.has('deepseek-v4-1-flash-261017')).toBe(false)
  })

  it('refuses audio rates it cannot fold into the chat brackets', () => {
    const rates = parseByteplusPricing(
      pricingDoc([
        {
          tab: 'Standard',
          rows: [
            CHAT_HEADERS,
            [
              'ByteDance',
              'seed-2-0-mini-260428',
              '[0, 128]',
              '$0.10',
              '$0.02',
              '$0.0083',
              '$0.40',
            ],
            ['', '', '(128, 256]', '$0.20', '$0.04', '$0.0083', '$0.80'],
            [
              '',
              'dola-seed-2-1-turbo',
              '[0, 256]',
              '$0.5',
              '$0.1',
              '$0.0083',
              '$2.5',
            ],
          ],
        },
        {
          tab: 'Standard',
          rows: [
            AUDIO_HEADERS,
            ['seed-2-0-mini-260428', '[0, 128]', '$1.50', '$0.30'],
            // An unreadable audio row refuses the card rather than leave
            // audio input unpriced on a text-only one.
            ['dola-seed-2-1-turbo', '[0, 256]', 'TBD', '$0.30'],
          ],
        },
      ]),
    )
    expect(rates.has('seed-2-0-mini-260428')).toBe(false)
    expect(rates.has('dola-seed-2-1-turbo')).toBe(false)
  })

  it('prices a period card only for a stated pricing_period', async () => {
    const card = compilePeriodCard(
      {
        periods: {
          off_peak: {
            input_tokens: 0.12e-6,
            cache_read_tokens: 0.0024e-6,
            output_tokens: 0.48e-6,
          },
          peak: {
            input_tokens: 0.24e-6,
            cache_read_tokens: 0.0048e-6,
            output_tokens: 0.96e-6,
          },
        },
      },
      SOURCE,
    )
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 }
    expect(price(card, {}, { ...usage, pricing_period: 'off_peak' })).toBe(0.6)
    expect(
      price(
        card,
        {},
        { ...usage, cache_read_tokens: 1_000_000, pricing_period: 'peak' },
      ),
    ).toBeCloseTo(1.2048, 10)
    expect(() => price(card, {}, usage)).toThrow(/pricing_period/)
    expect(() =>
      price(card, {}, { ...usage, pricing_period: 'night' }),
    ).toThrow(/pricing_period/)
    // Usage-bound levers only, so the chat schema accepts the card as stored.
    const stored = await storeListedPricing(card, {
      sourceUrl: SOURCE.url,
      now: 1_790_000_000,
      requestProperties: new Set(['model', 'messages']),
    })
    expect(stored).toEqual({ card })
  })

  it('keeps each patch’s absent facts when overlaying', () => {
    const model = { rawId: 'seed-translation-250915', activity: 'chat' }
    const merged = overlayModelFacts(
      model as ModelInfo,
      { absent: { pricing: 'unavailable' } },
      { absent: { reasoning: 'unavailable' } },
    )
    expect(merged.absent).toEqual({
      pricing: 'unavailable',
      reasoning: 'unavailable',
    })
  })

  it("reads a model page's single price row (seed-translation)", () => {
    const headers = [
      'Input USD/M Tokens',
      'Input Hits Cache USD/M Tokens',
      'Output Unit Price USD/M Tokens',
      'Cache Storage USD/M Tokens/Hour',
    ]
    expect(
      parseByteplusModelPage(doc([headers, ['0.20', '-', '0.80', '-']])),
    ).toEqual({ input_tokens: 0.2 / 1e6, output_tokens: 0.8 / 1e6 })
    expect(() =>
      parseByteplusModelPage(
        doc([headers, ['0.20', '-', '0.80', '-'], ['0.30', '-', '1', '-']]),
      ),
    ).toThrow(/one price table row/)
    expect(() =>
      parseByteplusModelPage(doc([headers, ['0.20', '-', 'TBD', '-']])),
    ).toThrow(/unreadable/)
    expect(() => parseByteplusModelPage(doc([CHAT_HEADERS]))).toThrow()
  })

  it("reads gpt-oss-120b's model page headers, Standard columns only", () => {
    const headers = [
      'Input unit price USD/M Tokens',
      'Input cache hits USD/M Tokens',
      'Output unit price USD/M Tokens',
      'Cache Storage USD/M Tokens/Hour',
      'Input unit price [Batch] USD/M Tokens',
      'Input cache-hit unit price [Batch] USD/M Tokens',
      'Output unit price [Batch] USD/M Tokens',
    ]
    expect(
      parseByteplusModelPage(
        doc([
          headers,
          ['0.10', '0.02', '0.50', '0.0083', '0.05', '0.02', '0.25'],
        ]),
      ),
    ).toEqual({
      input_tokens: 0.1 / 1e6,
      cache_read_tokens: 0.02 / 1e6,
      output_tokens: 0.5 / 1e6,
    })
    // Both input spellings in one table: refused, not the first one picked.
    expect(() =>
      parseByteplusModelPage(
        doc([
          ['Input USD/M Tokens', ...headers],
          ['0.20', '0.10', '0.02', '0.50', '0.0083', '0.05', '0.02', '0.25'],
        ]),
      ),
    ).toThrow(/one price table row/)
  })
})

const SOURCE = {
  url: 'https://docs.byteplus.com/en/docs/ModelArk/1544106',
  hash: 'a'.repeat(64),
  extractedAt: '2026-10-02T00:00:00Z',
}

const VIDEO_HEADER = [
  ['Model', 'Online inference', '', '', 'Offline inference'],
  ['', '480p and 720p', '1080p', '4K', ''],
]

/** Video and image tables as the live page words them (read 2026-10-23). */
const VIDEO_TABLES: Array<PricingTable> = [
  {
    tab: 'Input without video',
    rows: [
      ...VIDEO_HEADER,
      [
        'dreamina-seedance-2-5-260628',
        '$10.70',
        '$11.7',
        'Not supported',
        'Not supported',
      ],
      [
        'dreamina-seedance-2-0-fast-260128',
        '$5.6',
        'Not supported',
        'Not supported',
        'Not supported',
      ],
      // One price merged over every online resolution column.
      ['seedance-1-0-pro-250528', '$2.5', '', '', '$1.25'],
      ['seedance-9-unknown-261231', 'Contact sales', '$1', '$1', '$1'],
      // A blank cell that is not part of a merge is unread, not free.
      ['seedance-9-gap-261231', '$1', '', '$1', 'Not supported'],

      ['dreamina-seedance-2-0-260128', '$7.0', '$7.7', '$4.0', 'Not supported'],
      [
        'seedance-9-noted-261231',
        '$2',
        'Not supported',
        'Not supported',
        'Not supported',
      ],
      [
        'seedance-9-no-video-input-261231',
        '$2',
        'Not supported',
        'Not supported',
        'Not supported',
      ],
      // Two prices for one slot: neither is the price.
      [
        'seedance-9-twice-261231',
        '$2',
        'Not supported',
        'Not supported',
        'Not supported',
      ],
      [
        'seedance-9-twice-261231',
        '$3',
        'Not supported',
        'Not supported',
        'Not supported',
      ],
    ],
    merges: [
      [[0], [1, 2, 3]],
      [[4], [1, 2, 3]],
    ],
  },
  {
    tab: 'Input with video',
    rows: [
      ...VIDEO_HEADER,
      [
        'dreamina-seedance-2-5-260628',
        '$6.40',
        '$7.0',
        'Not supported',
        'Not supported',
      ],
      [
        'dreamina-seedance-2-0-fast-260128',
        '$3.3',
        'Not supported',
        'Not supported',
        'Not supported',
      ],
      // No price without video input: no rate the card could fall back to.
      [
        'seedance-9-video-only-261231',
        '$1',
        'Not supported',
        'Not supported',
        'Not supported',
      ],

      ['dreamina-seedance-2-0-260128', '$4.3', '$4.7', '$2.4', 'Not supported'],
      // The id cell may carry a note after the id.
      [
        'seedance-9-noted-261231 (New)',
        '$1',
        'Not supported',
        'Not supported',
        'Not supported',
      ],
      // Listed with video but priced nowhere: video input is not one rate.
      [
        'seedance-9-no-video-input-261231',
        'Not supported',
        'Not supported',
        'Not supported',
        'Not supported',
      ],
    ],
    merges: [[[0], [1, 2, 3]]],
  },
  {
    folded: true,
    rows: [
      ['Model', 'Online inference', '', 'Offline inference', ''],
      [
        '',
        'Video with audio',
        'Video without audio',
        'Video with audio',
        'Video without audio',
      ],
      ['seedance-1-5-pro-251215', '$2.4', '$1.2', '$1.2', '$0.6'],
    ],
    merges: [
      [[0], [1, 2]],
      [[0], [3, 4]],
    ],
  },
]

const IMAGE_TABLE: PricingTable = {
  rows: [
    ['Model ID', 'Input image', 'Output image'],
    [
      'dola-seedream-5-0-pro-260628',
      'First image: Free From the second image: $0.003 Pricing varies by image generation scenario.',
      'Single-image generation: P ≤ 2.61 million (1.5K or lower): $0.045 P > 2.61 million (higher than 1.5K): $0.09 Layer decomposition: P ≤ 2.61 million (1.5K or lower): $0.0225 P > 2.61 million (higher than 1.5K): $0.045',
    ],
    ['seedream-5-0-lite-260128', 'Free', '$0.035'],
    ['dola-seedream-5-0-flash-260915', 'Free', '$0.018'],
    ['seedream-4-5-251128', 'Free', '$0.04'],
    ['seedream-4-0-250828', 'Free', '$0.03'],
  ],
}

describe('byteplus video and image tables', () => {
  const page = pricingDoc([...VIDEO_TABLES, IMAGE_TABLE])
  const video = parseByteplusVideo(page)

  it('reads list prices per tier, resolution, and variant', () => {
    expect(video.get('dreamina-seedance-2-0-fast-260128')).toEqual({
      default: {
        '480p': { no_video: 5.6, video: 3.3 },
        '720p': { no_video: 5.6, video: 3.3 },
      },
    })
    // One merged online price, and listed without video input only: one
    // rate whatever the resolution.
    expect(video.get('seedance-1-0-pro-250528')).toEqual({
      default: { '*': { all: 2.5 } },
      flex: { '*': { all: 1.25 } },
    })
    expect(video.get('seedance-1-5-pro-251215')).toEqual({
      default: { '*': { audio: 2.4, silent: 1.2 } },
      flex: { '*': { audio: 1.2, silent: 0.6 } },
    })
    expect(video.has('seedance-9-unknown-261231')).toBe(false)
    expect(video.has('seedance-9-gap-261231')).toBe(false)
    expect(video.has('seedance-9-video-only-261231')).toBe(false)
    expect(video.get('dreamina-seedance-2-0-260128')?.default?.['4k']).toEqual({
      no_video: 4,
      video: 2.4,
    })
    expect(video.get('seedance-9-noted-261231')).toEqual({
      default: {
        '480p': { no_video: 2, video: 1 },
        '720p': { no_video: 2, video: 1 },
      },
    })
    expect(video.has('seedance-9-no-video-input-261231')).toBe(false)
    expect(video.has('seedance-9-twice-261231')).toBe(false)
    expect(parseByteplusImages(page)).toEqual(
      new Map([
        ['seedream-5-0-lite-260128', 0.035],
        ['dola-seedream-5-0-flash-260915', 0.018],
        ['seedream-4-5-251128', 0.04],
        ['seedream-4-0-250828', 0.03],
      ]),
    )
  })

  it('copies a flat image price onto the model list alias, not onto chat', () => {
    const images = parseByteplusImages(page)
    const listed = doc([
      [
        'seedream-5-0-260128 (also supports: seedream-5-0-lite-260128)',
        'seedream-5-0-260128 (also supports: seedream-9-other-260128)',
      ],
    ])
    // Two different aliases for one id: not one price.
    expect(parseByteplusAliases(listed).size).toBe(0)
    const once = doc([
      ['seedream-5-0-260128\n(also supports: seedream-5-0-lite-260128)'],
    ])
    const aliases = parseByteplusAliases(once)
    sharePublishedAliases(images, aliases)
    expect(images.get('seedream-5-0-260128')).toBe(0.035)
    expect(images.get('seedream-5-0-lite-260128')).toBe(0.035)
    // No speech table on this page, and no price for an unlisted snapshot.
    expect(images.has('seed-asr')).toBe(false)
    expect(images.has('seed-audio-1.0')).toBe(false)
    expect(images.has('seedream-4-0-20260415')).toBe(false)
  })

  it('reads the model list note on its own "Also supports" line (#468)', () => {
    // The live cell as of 2026-10-23: two list lines, no parentheses.
    const listed = doc([
      ['seedream-5-0-260128\n*Also supports seedream-5-0-lite-260128'],
      ['seedream-4-5-251128', 'Also supports seedream-9-other-260128'],
      ['seedream-4-0-250828 Also supports seedream-9-other-260128Pro'],
    ])
    // The second row's note sits in the next cell, and a cut-off alias
    // is not an id: neither is a pair.
    expect(parseByteplusAliases(listed)).toEqual(
      new Map([['seedream-5-0-260128', 'seedream-5-0-lite-260128']]),
    )
    const images = parseByteplusImages(page)
    sharePublishedAliases(images, parseByteplusAliases(listed))
    expect(images.get('seedream-5-0-260128')).toBe(0.035)
  })

  it('prices billed completion_tokens and refuses what it cannot know', () => {
    const usd = (
      id: string,
      request: Record<string, unknown>,
      usage?: Record<string, unknown>,
    ) => {
      const rates = video.get(id)
      const card = rates && compileSeedanceCard(rates, SOURCE)
      if (!card) throw new Error(`no card for ${id}`)
      return Number(price(card, request, usage).toFixed(4))
    }
    const v25 = 'dreamina-seedance-2-5-260628'
    expect(
      usd(
        v25,
        { resolution: '1080p' },
        { completion_tokens: 1e6, input_video: true },
      ),
    ).toBe(7)
    // Seedance 1.0 Pro usage table: 489600 tokens → 1.22.
    expect(
      usd('seedance-1-0-pro-250528', {}, { completion_tokens: 489_600 }),
    ).toBe(1.224)
    expect(
      usd(
        'seedance-1-5-pro-251215',
        { generate_audio: true, service_tier: 'flex' },
        { completion_tokens: 1e6 },
      ),
    ).toBe(1.2)
    const billed = { completion_tokens: 1e6, input_video: false }
    // No billed count, no stated video input, no audio choice: refuse.
    expect(() => usd(v25, { resolution: '720p' }, {})).toThrow(
      /completion_tokens/,
    )
    expect(() =>
      usd(v25, { resolution: '720p' }, { completion_tokens: 1e6 }),
    ).toThrow(/input_video.*required/)
    expect(() =>
      usd('seedance-1-5-pro-251215', {}, { completion_tokens: 1 }),
    ).toThrow(/generate_audio.*required/)
    // Draft bills at another resolution; flex has no offline column.
    expect(() =>
      usd(v25, { resolution: '1080p', draft: true }, billed),
    ).toThrow(/draft/)
    expect(() =>
      usd(v25, { resolution: '720p', service_tier: 'flex' }, billed),
    ).toThrow(/flex/)
  })

  it('prices Seedream 5.0 pro by size tier and extra input images', () => {
    const tiers = parseByteplusPixelTiers(page).get(
      'dola-seedream-5-0-pro-260628',
    )
    const card = tiers && compileSeedreamProCard(tiers, SOURCE)
    if (!card) throw new Error('no Seedream 5.0 pro card')
    const usd = (request: Record<string, unknown>, inputImages = 0) =>
      Number(
        price(card, request, {
          generated_images: 1,
          input_images: inputImages,
        }).toFixed(4),
      )
    // Omitted size is Ark's default 2K, the high tier.
    expect(usd({})).toBe(0.09)
    expect(usd({ size: '1K' })).toBe(0.045)
    expect(usd({ size: '1.5K' })).toBe(0.045)
    // WxH by pixel count: 1536² = 2.36 MP ≤ 2.61 MP; 2048² is above.
    expect(usd({ size: '1536x1536' })).toBe(0.045)
    expect(usd({ size: '2048x2048' })).toBe(0.09)
    // First input image free, each further one 0.003 (usage.input_images).
    expect(usd({ size: '1K' }, 1)).toBe(0.045)
    expect(usd({ size: '1K' }, 3)).toBe(0.051)
    // Layers mix tiers; 4K/auto are not generation sizes; usage is required.
    expect(() => usd({ layer_decomposition: true })).toThrow(/layer/)
    expect(() => usd({ size: '4K' })).toThrow(/unknown size/)
    expect(() => usd({ size: 'auto' })).toThrow(/unknown size/)
    expect(() => price(card, {}, { input_images: 0 })).toThrow(
      /generated_images/,
    )
    expect(() => price(card, {}, { generated_images: 1 })).toThrow(
      /input_images/,
    )
  })
})

describe('byteplus image table as published 2026-11-13 (#640)', () => {
  // The image table cut verbatim from the live doc: the "Output image"
  // header now carries a note line, and Seedream 5.0 pro's tiers read
  // "P ≤ 2.61 million".
  const page: ByteplusDoc = liveImages

  it('reads the flat rows under the annotated header', () => {
    expect(parseByteplusImages(page)).toEqual(
      new Map([
        ['dola-seedream-5-0-flash-260915', 0.018],
        ['seedream-5-0-lite-260128', 0.035],
        ['seedream-4-5-251128', 0.04],
        ['seedream-4-0-250828', 0.03],
        ['seededit-3-0-i2i-250628', 0.03],
      ]),
    )
  })

  it('reads Seedream 5.0 pro tiers and leaves Seedream 5.5 unpriced', () => {
    expect(parseByteplusPixelTiers(page)).toEqual(
      new Map([
        [
          'dola-seedream-5-0-pro-260628',
          {
            extraInput: 0.003,
            maxLowPixels: 2.61e6,
            lowLevel: '1.5K',
            low: 0.045,
            high: 0.09,
          },
        ],
      ]),
    )
  })

  it('still parses nothing from a table with no output column', () => {
    const none = pricingDoc([
      {
        rows: [
          ['Model ID', 'Input image'],
          ['seedream-4-0-250828', 'Free'],
        ],
      },
    ])
    expect(parseByteplusImages(none).size).toBe(0)
    expect(parseByteplusPixelTiers(none).size).toBe(0)
  })
})

/** The tutorial's model and pixel tables as the live page words them. */
const GUIDE = doc(
  [
    [
      'Model name',
      '',
      'Dreamina Seedance 2.0',
      'Dreamina Seedance 2.0 Fast',
      'Seedance 1.0 Pro',
    ],
    [
      'Model ID',
      '',
      'dreamina-seedance-2-0-260128',
      'dreamina-seedance-2-0-fast-260128',
      'seedance-1-0-pro-250528',
    ],
    ['', 'Frame rate', '24 fps', '24 fps', '24 fps'],
  ],
  [
    [
      'Resolution',
      'Aspect ratio',
      'Dreamina Seedance 2.0 series',
      'Seedance 1.0 series',
    ],
    ['720p', '16:9', '1280×720', '1248×704'],
    ['', '4:3', '1112×834', '1120×832'],
    [
      '1080p Dreamina Seedance 2.0 Fast and Dreamina Seedance 2.0 Mini do not support 1080p',
      '16:9',
      '1920×1080',
      '1920×1088',
    ],
    ['4k Only Dreamina Seedance 2.0 supports 4K', '16:9', '3840×2160', ''],
    ['', '4:3', '3326×2494', '-'],
    ['', '1:1', '2880×2880', '-'],
    ['8k Contact sales for 8K', '16:9', '7680×4320', '7680×4320'],
  ],
)

describe('byteplus video generation tutorial', () => {
  const geometry = parseSeedanceGeometry(GUIDE)

  it('reads frame rate and sizes per model, series columns included', () => {
    expect(geometry.get('seedance-1-0-pro-250528')).toEqual({
      fps: 24,
      dims: {
        '720p': {
          '16:9': { w: 1248, h: 704 },
          '4:3': { w: 1120, h: 832 },
        },
        '1080p': { '16:9': { w: 1920, h: 1088 } },
      },
    })
    expect(
      geometry.get('dreamina-seedance-2-0-260128')?.dims['4k']?.['4:3'],
    ).toEqual({ w: 3326, h: 2494 })
  })

  it('labels the estimate, and keeps sizes to the resolutions priced', () => {
    const id = 'dreamina-seedance-2-0-fast-260128'
    const model = geometry.get(id)
    if (!model) throw new Error('no geometry')
    const card = compileSeedanceCard(
      {
        default: {
          '480p': { no_video: 5.6, video: 3.3 },
          '720p': { no_video: 5.6, video: 3.3 },
        },
      },
      SOURCE,
      { model, url: 'https://example.test/guide', hash: 'b'.repeat(64) },
    )
    if (!card) throw new Error('no card')
    // The series column lists 1080p and 4K; Fast prices neither.
    expect(Object.keys(card.tables.pixels ?? {})).toEqual(['720p'])
    // Page: "Dreamina Seedance 2.0 Fast (USD) 0.60 per video" (720p 16:9 5 s).
    const request = { resolution: '720p', ratio: '16:9', duration: 5 }
    const result = priceDetailed(card, request, { input_video: false })
    expect(result.estimated).toEqual(['completion_tokens'])
    expect(result.amount.toFixed(2)).toBe('0.60')
    // Video input carries a minimum-token floor the method does not cover
    // unless the Lark range was supplied.
    expect(() => priceDetailed(card, request, { input_video: true })).toThrow(
      /estimate_supported/,
    )
  })

  it('bills a short input video at the Lark minimum for that output', async () => {
    const card = compileSeedanceCard(
      {
        default: {
          '480p': { no_video: 10.7, video: 6.4 },
          '720p': { no_video: 10.7, video: 6.4 },
          '1080p': { no_video: 11.7, video: 7 },
        },
      },
      SOURCE,
      {
        model: {
          fps: 24,
          dims: {
            '480p': { '16:9': { w: 854, h: 480 } },
            '720p': { '16:9': { w: 1280, h: 720 } },
            '1080p': { '16:9': { w: 1920, h: 1080 } },
          },
        },
        url: 'https://example.test/guide',
        hash: 'b'.repeat(64),
        videoMinimumsThrough: 30,
      },
    )
    if (!card) throw new Error('no card')
    const video = (duration: number, input = 0, resolution = '720p') =>
      priceDetailed(
        card,
        { resolution, ratio: '16:9', duration, input_video_duration: input },
        { input_video: true },
      )
    // Page: 720p 16:9, 5s out, 2–4s in → $1.244. 480p → $0.553.
    expect(video(5, 2).amount.toFixed(3)).toBe('1.244')
    expect(video(5, 2, '480p').amount.toFixed(3)).toBe('0.553')
    // 30s out floors a 2s input at 20s in: 480,375 tokens × $6.40.
    expect(video(30, 2, '480p').amount).toBeCloseTo((480_375 * 6.4) / 1e6, 6)
    // Past the minimum, the real input length wins.
    expect(video(30, 30, '480p').amount).toBeCloseTo((576_450 * 6.4) / 1e6, 6)
    expect(() => video(31, 2)).toThrow(/min_input_seconds/)
    // The generation schema has duration and ratio, not input seconds.
    // That lever must still store; refusing it used to null the card.
    const stored = await storeListedPricing(card, {
      sourceUrl: 'https://docs.byteplus.com/en/docs/ModelArk/1544106',
      now: 1_790_000_000,
      requestProperties: new Set([
        'service_tier',
        'draft',
        'resolution',
        'duration',
        'ratio',
      ]),
    })
    expect(stored.refused).toBeUndefined()
    expect(stored.card?.inputs.completion_tokens).toMatchObject({
      kind: 'number',
    })
  })
})

describe('byteplus tutorial notes and columns', () => {
  it('applies resolution notes, and drops rows whose note it cannot read', () => {
    const geometry = parseSeedanceGeometry(GUIDE)
    // "2.0 Fast and Mini do not support 1080p"; "Only 2.0 supports 4K".
    const fast = geometry.get('dreamina-seedance-2-0-fast-260128')?.dims
    expect(Object.keys(fast ?? {})).toEqual(['720p'])
    expect(
      geometry.get('dreamina-seedance-2-0-260128')?.dims['4k']?.['1:1'],
    ).toEqual({ w: 2880, h: 2880 })
    // "Contact sales for 8K" names no rule: nobody gets 8K.
    for (const model of geometry.values()) {
      expect(model.dims).not.toHaveProperty('8k')
    }
  })

  it("prefers a model's own column, and drops a model whose sizes conflict", () => {
    const geometry = parseSeedanceGeometry(
      doc(
        [
          ['Model name', '', 'Seedance 1.0 Pro', 'Seedance 1.0 Pro Fast'],
          [
            'Model ID',
            '',
            'seedance-1-0-pro-250528',
            'seedance-1-0-pro-fast-251015',
          ],
          ['', 'Frame rate', '24 fps', '24 fps'],
        ],
        [
          [
            'Resolution',
            'Aspect ratio',
            'Seedance 1.0 series',
            'Seedance 1.0 Pro Fast',
            'Seedance 1.0 Pro',
          ],
          ['720p', '16:9', '1248×704', '1280×720', '1248×704'],
          ['', '4:3', '1120×832', '1120×832', '1112×834'],
        ],
      ),
    )
    expect(
      geometry.get('seedance-1-0-pro-fast-251015')?.dims['720p']?.['16:9'],
    ).toEqual({ w: 1280, h: 720 })
    // Pro's own column agrees at 16:9 but the series disagrees at 4:3 —
    // own beats series, so Pro keeps its own 1112×834.
    expect(
      geometry.get('seedance-1-0-pro-250528')?.dims['720p']?.['4:3'],
    ).toEqual({ w: 1112, h: 834 })
    const twice = parseSeedanceGeometry(
      doc(
        [
          ['Model name', '', 'Seedance 1.0 Pro'],
          ['Model ID', '', 'seedance-1-0-pro-250528'],
          ['', 'Frame rate', '24 fps'],
        ],
        [
          [
            'Resolution',
            'Aspect ratio',
            'Seedance 1.0 Pro',
            'Seedance 1.0 Pro',
          ],
          ['720p', '16:9', '1248×704', '1280×720'],
        ],
      ),
    )
    expect(twice.has('seedance-1-0-pro-250528')).toBe(false)
  })

  it('refuses to estimate a draft', () => {
    const model = parseSeedanceGeometry(GUIDE).get('seedance-1-0-pro-250528')
    if (!model) throw new Error('no geometry')
    const card = compileSeedanceCard(
      { default: { '*': { all: 2.5 } } },
      SOURCE,
      { model, url: 'https://example.test/guide', hash: 'b'.repeat(64) },
    )
    if (!card) throw new Error('no card')
    const request = { resolution: '720p', ratio: '16:9', duration: 5 }
    expect(priceDetailed(card, request).estimated).toEqual([
      'completion_tokens',
    ])
    expect(() => priceDetailed(card, { ...request, draft: true })).toThrow(
      /cannot be estimated.*draft/,
    )
    // Billed tokens price a 1.0 draft: its rate does not split on resolution.
    expect(
      priceDetailed(card, { draft: true }, { completion_tokens: 1e6 }),
    ).toEqual({
      amount: 2.5,
      currency: 'USD',
      usd: 2.5,
      estimated: [],
      defaulted: ['service_tier'],
      ignored: [],
    })
  })
})
