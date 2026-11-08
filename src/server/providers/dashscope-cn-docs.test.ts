import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cardCurrency, price } from '@modelschemas/rate-card'
import { rateCardSchema } from '@modelschemas/rate-card/schema'
import { describe, expect, it } from 'vitest'
import {
  applyCnCardFacts,
  applyCnCatalog,
  applyCnTextFacts,
  cnBeijingTabs,
  cnPriceModels,
  cnTable,
} from './dashscope-cn-docs.ts'
import type { CnDoc } from './dashscope-cn-docs.ts'

const doc = (file: string): CnDoc => {
  const text = readFileSync(
    new URL(`./fixtures/dashscope-cn/${file}.md.txt`, import.meta.url),
    'utf8',
  )
  return {
    text,
    url: `https://help.aliyun.com/zh/model-studio/${file}.md`,
    hash: createHash('sha256').update(text).digest('hex'),
  }
}

const prices = doc('model-pricing')
function native() {
  return applyCnCardFacts(
    applyCnTextFacts(
      applyCnCatalog(cnPriceModels(prices), doc('models')),
      doc('text-generation-model'),
    ),
    doc('qwen-flash'),
  )
}
describe('DashScope China native source parsing', () => {
  it('reads explicit Beijing ids with exact own CNY tiers, never international quotes', () => {
    const rows = native()
    expect(rows.length).toBeGreaterThan(400)
    const flash = rows.find((row) => row.rawId === 'qwen-flash')!
    expect(flash.contextWindow).toBe(1000000)
    expect(flash.maxOutput).toBe(32768)
    expect(flash.modalities).toEqual({ input: ['text'], output: ['text'] })
    expect(flash.capabilities).toEqual([
      'reasoning',
      'tools',
      'structured_outputs',
    ])
    expect(flash.schemaEndpointId).toBeNull()
    expect(flash.reasoning).toBeNull()
    expect(flash.requestMap).toBeNull()
    expect(cardCurrency(rateCardSchema.parse(flash.pricing))).toBe('CNY')
    expect(
      price(
        rateCardSchema.parse(flash.pricing),
        {},
        { input_tokens: 128000, output_tokens: 1000000 },
      ),
    ).toBeCloseTo(1.5192)
    expect(
      price(
        rateCardSchema.parse(flash.pricing),
        {},
        { input_tokens: 128001, output_tokens: 1000000 },
      ),
    ).toBeCloseTo(6.0768006)
    expect(
      price(
        rateCardSchema.parse(flash.pricing),
        {},
        { input_tokens: 256001, output_tokens: 1000000 },
      ),
    ).toBeCloseTo(12.3072012)
    const math = rows.find((row) => row.rawId === 'qwen-math-plus')!
    expect(
      price(
        rateCardSchema.parse(math.pricing),
        {},
        { input_tokens: 1000000, output_tokens: 1000000 },
      ),
    ).toBe(16)
    expect(
      rows.find((row) => row.rawId === 'qwen-deep-research')?.pricing,
    ).not.toBeNull()
    expect(flash.factSources?.modalities?.sourceUrl).toContain(
      '/zh/model-studio/qwen-flash.md',
    )
    expect(
      rows.every(
        (row) =>
          row.pricing === null ||
          cardCurrency(rateCardSchema.parse(row.pricing)) === 'CNY',
      ),
    ).toBe(true)
  })
  it('reads Beijing console ids from selection-page cards and anchors', () => {
    const rows = applyCnCatalog([], doc('models'))
    const glm = rows.find((row) => row.rawId === 'ZHIPU/GLM-5.3')!
    expect(glm.displayName).toBe('ZHIPU/GLM-5.3')
    expect(glm.activity).toBe('chat')
    expect(rows).toHaveLength(33)
    expect(rows.find((row) => row.rawId === 'qwen3.8-max')?.activity).toBe(
      'chat',
    )
    const anchored = applyCnCatalog([], {
      ...doc('models'),
      text: '## 文本生成\n<a href="https://bailian.console.aliyun.com/cn-beijing/model/market/detail/kimi%2Fkimi-k3">Kimi K3</a>',
    })
    expect(anchored.map((row) => [row.rawId, row.displayName])).toEqual([
      ['kimi/kimi-k3', 'Kimi K3'],
    ])
    expect(() =>
      applyCnCatalog([], {
        ...doc('models'),
        text: '<Card href="https://bailian.console.aliyun.com/cn-beijing/model/market/detail/qwen3.8-max">x</Card>',
      }),
    ).toThrow('card has no title')
  })
  it('expands sourced spans and balances nested model-family tabs', () => {
    expect(
      cnTable(
        '<table><tr><td rowSpan={2}>a</td><td colSpan={2}>b</td></tr><tr><td>c</td><td /></tr></table>',
      ),
    ).toEqual([
      ['a', 'b', 'b'],
      ['a', 'c', ''],
    ])
    expect(
      cnTable(
        '<table><tr><td>x</td><td rowSpan={5}>a</td></tr><tr><td>y</td></tr></table>',
      ),
    ).toEqual([
      ['x', 'a'],
      ['y', 'a'],
    ])
    expect(
      cnTable(
        '<table><tr><td>x</td><td rowSpan={4}>a</td><td>p</td></tr><tr><td>y</td><td>q</td></tr></table>',
      ),
    ).toEqual([
      ['x', 'a', 'p'],
      ['y', 'a', 'q'],
    ])
    expect(() =>
      cnTable('<table><tr><td rowSpan={oops}>a</td></tr></table>'),
    ).toThrow('unreadable table span')
    expect(
      cnBeijingTabs(
        '<Tabs><Tab title="华北2（北京）"><Tabs><Tab title="family">own</Tab></Tabs></Tab><Tab title="新加坡">foreign</Tab></Tabs>',
      )[0]?.body,
    ).toContain('own')
    expect(() => cnBeijingTabs('<Tab title="华北2（北京）">')).toThrow(
      'unclosed',
    )
  })
  it('clips a native rowSpan that runs past the last table row', () => {
    const rows = cnPriceModels(doc('model-pricing-span-overflow'))
    expect(rows.map((row) => row.rawId)).toEqual(['MiniMax-M2.5'])
    expect(rows[0]!.absent).toBeUndefined()
    const card = rateCardSchema.parse(rows[0]!.pricing)
    expect(cardCurrency(card)).toBe('CNY')
    expect(
      price(card, {}, { input_tokens: 1000000, output_tokens: 1000000 }),
    ).toBeCloseTo(10.5)
  })
  it('throws malformed recognized rates or units and never returns an empty success', () => {
    expect(() =>
      cnPriceModels({
        ...prices,
        text: prices.text.replace('0.15元', 'unknown元'),
      }),
    ).toThrow('unreadable RMB')
    expect(() =>
      cnPriceModels({
        ...prices,
        text: prices.text.replace('0.15元', '0.15USD'),
      }),
    ).toThrow('unreadable RMB')
    expect(() =>
      cnPriceModels({
        ...prices,
        text: prices.text.replace('0\\<Token≤128K', 'unreadable-range'),
      }),
    ).toThrow('token range')
    expect(() =>
      cnPriceModels({
        ...prices,
        text: prices.text.replaceAll('title="华北2（北京）"', 'title="新加坡"'),
      }),
    ).toThrow('no Beijing')
  })
  it('reads a price cell that tiers itself by prompt size', () => {
    const tiered = (input: string, output: string): CnDoc => ({
      ...prices,
      text: `## 文本生成\n<Tabs><Tab title="华北2（北京）"><table><tr><th>模型 ID（Model ID）</th><th>模式</th><th>输入单价（每百万Token）</th><th>输出单价（每百万Token）</th></tr><tr><td>MiniMax/MiniMax-M3</td><td>非思考和思考模式</td><td>${input}</td><td>${output}</td></tr></table></Tab></Tabs>`,
    })
    const [m3] = cnPriceModels(
      tiered(
        '输入不超过 512k Token：2.1元\n\n输入超过 512k Token：4.2元',
        '输入不超过 512k Token：8.4元\n\n输入超过 512k Token：16.8元',
      ),
    )
    const card = rateCardSchema.parse(m3!.pricing)
    expect(cardCurrency(card)).toBe('CNY')
    expect(
      price(card, {}, { input_tokens: 512000, output_tokens: 1000000 }),
    ).toBeCloseTo(1.0752 + 8.4)
    expect(
      price(card, {}, { input_tokens: 512001, output_tokens: 1000000 }),
    ).toBeCloseTo(512001 * 4.2e-6 + 16.8)
    expect(() =>
      cnPriceModels(
        tiered(
          '输入不超过 512k Token：2.1元 输入超过 512k Token：4.2元',
          '输入不超过 256k Token：8.4元 输入超过 256k Token：16.8元',
        ),
      ),
    ).toThrow('mismatched input and output price tiers')
    expect(() =>
      cnPriceModels(tiered('输入不超过 512k Token：2.1元', '8.4元')),
    ).toThrow('unreadable tiered RMB token quote')
  })
  it('keeps distinct native thinking or media prices null instead of choosing a mode', () => {
    const rows = native()
    expect(rows.find((row) => row.rawId === 'qwen-plus')?.pricing).toBeNull()
    expect(
      rows.find((row) => row.rawId === 'qwen3-omni-flash')?.pricing,
    ).toBeNull()
    expect(
      rows.some((row) => row.maxOutput === null && row.modalities === null),
    ).toBe(true)
    expect(
      rows
        .filter((row) => row.pricing === null)
        .every((row) => row.absent?.pricing === 'cleared'),
    ).toBe(true)
    const priced = rows.filter((row) => row.pricing !== null)
    expect(priced.length).toBeGreaterThan(0)
    expect(priced.every((row) => row.absent?.pricing === undefined)).toBe(true)
  })
})

describe('DashScope evidence boundaries', () => {
  it('treats a parenthetical support note as a stated yes', () => {
    const rows = applyCnTextFacts(
      [{ rawId: 'kimi-k3.1-pro', displayName: null }],
      {
        text: `<table><tr><th>模型ID</th><th>上下文</th><th>结构化输出</th></tr><tr><td><code>kimi-k3.1-pro</code></td><td>1M</td><td>支持（JSON Mode）</td></tr></table>`,
        url: 'https://help.aliyun.com/zh/model-studio/text-generation-model.md',
        hash: 'a'.repeat(64),
      },
    )
    expect(rows[0]?.capabilities).toEqual(['structured_outputs'])
    expect(rows[0]?.unsupportedCapabilities).toEqual([])
  })
  it('records explicit negatives without claiming a complete capability vocabulary', () => {
    const rows = applyCnTextFacts(
      cnPriceModels(prices),
      doc('text-generation-model'),
    )
    const row = rows.find((item) => item.rawId === 'qwen-mt-plus')!
    expect(row.exactCapabilities).toBeUndefined()
    expect(row.unsupportedCapabilities).toEqual([
      'reasoning',
      'tools',
      'structured_outputs',
    ])
    expect(row.factSources?.capabilities?.reasoning?.sourceUrl).toBe(
      doc('text-generation-model').url,
    )
  })
  it('rejects partial or wrong-region cards instead of fabricating empty capabilities', () => {
    const base = cnPriceModels(prices)
    const card = doc('qwen-flash')
    expect(() =>
      applyCnCardFacts(base, {
        ...card,
        text: card.text.replace('title="华北2（北京）"', 'title="新加坡"'),
      }),
    ).toThrow('no Beijing')
    expect(() =>
      applyCnCardFacts(base, {
        ...card,
        text: card.text.replace('## 上下文限制', '## unrelated'),
      }),
    ).toThrow('incomplete native card')
    expect(() =>
      applyCnCardFacts(base, {
        ...card,
        text: card.text.replace('## 模型能力', '## unrelated'),
      }),
    ).toThrow('incomplete native card')
  })
  it('rejects conflicting published token limits', () => {
    const card = doc('qwen-flash')
    expect(() =>
      applyCnCardFacts(cnPriceModels(prices), {
        ...card,
        text: card.text.replace(
          '## 模型价格',
          '## 上下文限制\n<table><tr><th>参数</th><th>值</th></tr><tr><td>上下文长度</td><td>999999</td></tr></table>\n## 模型价格',
        ),
      }),
    ).toThrow('conflicting card token limit')
  })
})
