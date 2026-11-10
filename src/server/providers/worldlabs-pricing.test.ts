import { describe, expect, it } from 'vitest'

import { compileUnitCard, price } from '@modelschemas/rate-card'

import { cardRequestParamsOk } from '#/server/rate-card.ts'

import {
  WORLDLABS_PROMPT_INPUT,
  parseWorldlabsPricing,
} from './worldlabs-pricing.ts'

/** Excerpt of https://docs.worldlabs.ai/api/pricing.md (2026-11-10). */
const PAGE = `
You may purchase credits at a fixed rate of $1.00 USD per 1,250 credits through the platform.

#### Draft model totals (\`marble-1.0-draft\`)

| Input type | Pano generation | World generation | Total |
| - | -: | -: | -: |
| Image (pano) | 0 | 150 | 150 |
| Text | 80 | 150 | 230 |
| Image (non-pano) | 80 | 150 | 230 |
| Multi-image | 100 | 150 | 250 |
| Video | 100 | 150 | 250 |

#### Standard model totals (\`marble-1.0\`, \`marble-1.1\`)

| Input type | Pano generation | World generation | Total |
| - | -: | -: | -: |
| Image (pano) | 0 | 1,500 | 1,500 |
| Text | 80 | 1,500 | 1,580 |
| Image (non-pano) | 80 | 1,500 | 1,580 |
| Multi-image | 100 | 1,500 | 1,600 |
| Video | 100 | 1,500 | 1,600 |

#### Marble 1.1 Plus totals (\`marble-1.1-plus\`)

| Input type | Pano generation | Base world generation | Variable world generation | Total |
| - | -: | -: | - | - |
| Image (pano) | 0 | 1,500 | 0-1,500 | 1,500-3,000 |
| Text | 80 | 1,500 | 0-1,500 | 1,580-3,080 |
| Image (non-pano) | 80 | 1,500 | 0-1,500 | 1,580-3,080 |
| Multi-image | 100 | 1,500 | 0-1,500 | 1,600-3,100 |
| Video | 100 | 1,500 | 0-1,500 | 1,600-3,100 |
`

const SOURCE = {
  url: 'https://docs.worldlabs.ai/api/pricing.md',
  hash: 'a'.repeat(64),
  extractedAt: '2026-11-10T00:00:00.000Z',
}

describe('parseWorldlabsPricing', () => {
  const cards = parseWorldlabsPricing(PAGE)

  it('prices draft and standard models in USD per input type', () => {
    expect([...cards.keys()].sort()).toEqual([
      'marble-1.0',
      'marble-1.0-draft',
      'marble-1.1',
    ])
    const draft = compileUnitCard(cards.get('marble-1.0-draft')!, SOURCE)
    const standard = compileUnitCard(cards.get('marble-1.1')!, SOURCE)
    expect(draft).not.toBeNull()
    expect(standard).not.toBeNull()
    expect(price(draft!, { [WORLDLABS_PROMPT_INPUT]: 'Image (pano)' })).toBe(
      150 / 1250,
    )
    expect(price(draft!, { [WORLDLABS_PROMPT_INPUT]: 'Text' })).toBe(230 / 1250)
    expect(price(standard!, { [WORLDLABS_PROMPT_INPUT]: 'Text' })).toBe(
      1580 / 1250,
    )
    expect(price(standard!, { [WORLDLABS_PROMPT_INPUT]: 'Video' })).toBe(
      1600 / 1250,
    )
    expect(cards.get('marble-1.0')).toEqual(cards.get('marble-1.1'))
    // WorldsGenerateRequest top-level properties. The lever is not one of them.
    expect(
      cardRequestParamsOk(
        standard!,
        new Set([
          'display_name',
          'model',
          'permission',
          'seed',
          'tags',
          'world_prompt',
        ]),
      ),
    ).toBe(true)
  })

  it('leaves marble-1.1-plus unpriced while its totals are ranges', () => {
    expect(cards.has('marble-1.1-plus')).toBe(false)
  })

  it('throws when the credit rate or a fixed table is missing', () => {
    expect(() => parseWorldlabsPricing('no prices here')).toThrow(/credit rate/)
    expect(() =>
      parseWorldlabsPricing(
        PAGE.replace('#### Draft model totals', '#### Gone'),
      ),
    ).toThrow(/totals table is missing/)
  })
})
