import { price } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'
import { describe, expect, it } from 'vitest'

import { parseTypesafeModels, typesafeModelInfos } from './typesafe-models.ts'

/** Excerpt of https://docs.typesafe.ai/models.md (2026-11-10). */
const PAGE = `
| | Jev 1.14 | Jev 1.13 |
| :- | :- | :- |
| Model ID | \`jev-1.14.0\` | \`jev-1.13.0\` |
| Price (per Btok / per Mtok) | \\$42 / \\$0.042 | \\$42 / \\$0.042 |
| Context length | 64k per-request / 32k per-question | 64k per-request / 32k per-question |
| Input | Text, images | Text, images |
| Question types | Choice, Score, Noul, Box | Choice, Score, Noul |

Jev 1.14 is the newest Jev release, available from October 14, 2026.

* **Price:** You pay per input token. Output tokens are free. A Btok is a billion tokens and an Mtok is a million tokens.

| Alias | Points to | Meaning |
| :- | :- | :- |
| \`jev-latest\` | \`jev-1.14.0\` | The most recent stable release. |
| \`jev-preview\` | \`jev-1.14.0\` | The most recent release, official or not. |
`

describe('typesafe models page', () => {
  it('lists versioned ids, with aliases and a free output', () => {
    expect(parseTypesafeModels(PAGE)).toEqual([
      {
        rawId: 'jev-1.13.0',
        displayName: 'Jev 1.13',
        aliases: [],
        inputPerToken: 42 / 1e9,
        contextWindow: 64_000,
        input: ['text', 'image'],
        releasedAt: null,
      },
      {
        rawId: 'jev-1.14.0',
        displayName: 'Jev 1.14',
        aliases: ['jev-latest', 'jev-preview'],
        inputPerToken: 42 / 1e9,
        contextWindow: 64_000,
        input: ['text', 'image'],
        releasedAt: Date.UTC(2026, 9, 14) / 1000,
      },
    ])
  })

  it('compiles a card that bills input only', async () => {
    const models = await typesafeModelInfos(PAGE)
    const card = models.find((model) => model.rawId === 'jev-1.14.0')
      ?.pricing as RateCard
    expect(
      price(card, {}, { input_tokens: 1e6, output_tokens: 1e6 }),
    ).toBeCloseTo(0.042)
    expect(card.tables.rate?.base).toEqual({
      input_tokens: 42 / 1e9,
      output_tokens: 0,
    })
    expect(models.find((model) => model.rawId === 'jev-latest')).toBeUndefined()
    expect(models.every((model) => model.activity === 'decision')).toBe(true)
  })

  it('throws when the Btok and Mtok prices disagree', () => {
    expect(() =>
      parseTypesafeModels(PAGE.replace('\\$42 / \\$0.042', '\\$42 / \\$0.050')),
    ).toThrow(/disagree/)
  })

  it('throws when the page stops saying output is free', () => {
    expect(() =>
      parseTypesafeModels(
        PAGE.replace('Output tokens are free.', 'Output is metered.'),
      ),
    ).toThrow(/free/)
  })
})
