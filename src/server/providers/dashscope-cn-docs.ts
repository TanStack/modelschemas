/** Public Beijing catalog and RMB quotes, without international substitution. */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { FactSource, ModelInfo } from './types.ts'

export const DASHSCOPE_CN_PRICES =
  'https://help.aliyun.com/zh/model-studio/model-pricing.md'
export const DASHSCOPE_CN_MODELS =
  'https://help.aliyun.com/zh/model-studio/models.md'
export interface CnDoc {
  text: string
  url: string
  hash: string
}
function fail(message: string): never {
  throw new Error(`dashscope-cn: ${message}`)
}
export function cnText(value: string): string {
  return value
    .replace(/\\</g, '&lt;')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\\</g, '<')
    .replace(/\\([_*-])/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
/** Expand actual MDX rowSpan/colSpan values, including self-closing empty cells. */
export function cnTable(table: string): string[][] {
  const grid: string[][] = []
  const pending = new Map<number, { text: string; remaining: number }>()
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const values: string[] = []
    let column = 0
    const fill = () => {
      while (pending.has(column)) {
        const span = pending.get(column)!
        values[column++] = span.text
        if (--span.remaining === 0) pending.delete(column - 1)
      }
    }
    for (const cell of row[1]!.matchAll(
      /<t[dh]\b([^>]*?)(?:\/>|>([\s\S]*?)<\/t[dh]>)/gi,
    )) {
      fill()
      const span = (name: string) => {
        const attrs = cell[1] ?? ''
        const found = new RegExp(
          `${name}\\s*=\\s*(?:\\{(\\d+)\\}|"(\\d+)")`,
          'i',
        ).exec(attrs)
        if (new RegExp(name, 'i').test(attrs) && !found)
          fail('unreadable table span')
        const value = Number(found?.[1] ?? found?.[2] ?? 1)
        if (!Number.isSafeInteger(value) || value < 1)
          fail('invalid table span')
        return value
      }
      const across = span('colspan'),
        down = span('rowspan')
      for (let index = 0; index < across; index++) {
        if (pending.has(column)) fail('overlapping table span')
        values[column] = cell[2] ?? ''
        if (down > 1)
          pending.set(column, { text: cell[2] ?? '', remaining: down - 1 })
        column++
      }
    }
    fill()
    if (values.length) grid.push(values)
  }
  // A rowSpan past the table's last row is clipped, as a browser shows it.
  return grid
}
function cellIds(cell: string): string[] {
  const body = cell.split(/\n\s*>/)[0] ?? ''
  const text = cnText(body.replace(/<\/(?:p|div)>|<br\s*\/?\s*>/gi, '\n'))
  const ids = [
    ...new Set(
      text.split(/\s+/).filter((id) => /^[a-z][a-z0-9_./-]+$/i.test(id)),
    ),
  ]
  if (
    !ids.length &&
    /^参见\s*模型列表$/.test(text) &&
    /(?:\[模型列表\]\([^)]*\)|<a\b[^>]*href=)/.test(body)
  )
    return []
  if (!ids.length) fail(`unreadable model ID cell: ${text}`)
  return ids
}
function activity(heading: string): ModelInfo['activity'] {
  if (/文本生成/.test(heading)) return 'chat'
  if (/向量|文本嵌入|多模态嵌入/.test(heading)) return 'embeddings'
  if (/重排序|排序模型/.test(heading)) return null // The repository has no rerank activity.;
  if (/图像|图片/.test(heading)) return 'image'
  if (/视频/.test(heading)) return 'video'
  if (/音频|语音|音乐/.test(heading)) return 'audio'
  return null
}
function ownSource(doc: CnDoc, path: string): FactSource {
  return {
    derivation: 'docs-derived',
    sourceUrl: doc.url,
    sourceHash: doc.hash,
    path,
  }
}
function yuanPerMillion(raw: string): number {
  const value = Number(raw) / 1e6
  if (!Number.isFinite(value) || value < 0) fail('invalid RMB token quote')
  return value
}
function amount(text: string): number {
  const match = /^(\d+(?:\.\d+)?)元$/.exec(text)
  if (!match) fail(`unreadable RMB token quote: ${text}`)
  return yuanPerMillion(match[1]!)
}
interface YuanQuote {
  rate: number
  /** Cache-hit input, only when the same cell states it. */
  cacheRead?: number
}
/**
 * A plain cell is `<n>元`. It may also state the cache-hit input rate:
 * `13元 缓存命中输入：1.3元`.
 *
 * `原价2元 （限时2.5折）` states a list price and the share billed while
 * the promo runs (N折 = N/10 of list, so 2.5折 of 2元 is 0.5元). The cell
 * names no end, so the card carries no `expiresAt` (#552). Any other promo
 * wording throws.
 */
function plainQuote(text: string): YuanQuote {
  const match =
    /^(\d+(?:\.\d+)?)元(?:\s+缓存命中输入：(\d+(?:\.\d+)?)元)?$/.exec(text)
  if (match) {
    const quote: YuanQuote = { rate: yuanPerMillion(match[1]!) }
    if (match[2] !== undefined) quote.cacheRead = yuanPerMillion(match[2])
    return quote
  }
  const promo = /^原价(\d+(?:\.\d+)?)元\s*（限时(\d+(?:\.\d+)?)折）$/.exec(text)
  if (!promo) fail(`unreadable RMB token quote: ${text}`)
  const fold = Number(promo[2])
  // 10折 is the list price. Above that, or a zero fold, is not this wording.
  if (!(fold > 0) || fold > 10) fail(`unreadable RMB token quote: ${text}`)
  return { rate: yuanPerMillion(String(Number(promo[1]) * (fold / 10))) }
}
/**
 * One quote per prompt-size floor. A cell may tier itself, as MiniMax-M3's
 * does: "输入不超过 512k Token：2.1元 输入超过 512k Token：4.2元".
 * The cache-hit suffix is read only on a plain cell; a tiered cell that
 * carries any other text still throws.
 */
function amounts(cell: string): Map<number, YuanQuote> {
  const text = cnText(cell)
  if (!/Token：/.test(text)) return new Map([[0, plainQuote(text)]])
  const match =
    /^输入不超过\s*(\d+(?:\.\d+)?)([KM])\s*Token：(\S+)\s+输入超过\s*(\d+(?:\.\d+)?)([KM])\s*Token：(\S+)$/i.exec(
      text,
    )
  if (!match || match[1] !== match[4] || match[2] !== match[5])
    fail(`unreadable tiered RMB token quote: ${text}`)
  const bound = Number(match[1]) * (match[2]!.toUpperCase() === 'M' ? 1e6 : 1e3)
  if (!Number.isSafeInteger(bound) || bound <= 0)
    fail('invalid tiered token bound')
  return new Map([
    [0, { rate: amount(match[3]!) }],
    [bound, { rate: amount(match[6]!) }],
  ])
}
function floor(cell: string): number {
  const text = cnText(cell).replace(/\s+/g, '')
  if (text === '无阶梯计价' || text === '不区分阶梯') return 0
  const match =
    /^(\d+(?:\.\d+)?)([KM]?)<Token[≤<](?:=?)(\d+(?:\.\d+)?)([KM]?)$/i.exec(text)
  if (!match) fail(`unreadable token range: ${text}`)
  const scale = (unit: string) =>
    unit.toUpperCase() === 'M' ? 1e6 : unit.toUpperCase() === 'K' ? 1e3 : 1
  const min = Number(match[1]) * scale(match[2]!),
    max = Number(match[3]) * scale(match[4]!)
  if (!Number.isFinite(min) || max <= min) fail('invalid token range')
  return min
}
interface Quoted {
  models: string[]
  mode: string
  floor: number
  rates: Record<string, number>
}
/** Balance nested model-family Tabs inside each explicitly Beijing panel. */
export function cnBeijingTabs(
  text: string,
): Array<{ body: string; start: number }> {
  const panels: Array<{ body: string; start: number }> = []
  const stack: Array<{ start: number; bodyAt: number; beijing: boolean }> = []
  for (const tag of text.matchAll(/<\/?Tab\b[^>]*>/g)) {
    if (tag[0].startsWith('</')) {
      const open = stack.pop()
      if (!open) fail('unbalanced region Tab')
      if (open.beijing)
        panels.push({
          body: text.slice(open.bodyAt, tag.index),
          start: open.start,
        })
    } else
      stack.push({
        start: tag.index,
        bodyAt: tag.index + tag[0].length,
        beijing: /\btitle="华北2（北京）"/.test(tag[0]),
      })
  }
  if (stack.length) fail('unclosed region Tab')
  return panels
}
export function cnPriceModels(doc: CnDoc): ModelInfo[] {
  const result = new Map<string, ModelInfo>()
  const quoted = new Map<string, Quoted[]>()
  let tabs = 0
  for (const tab of cnBeijingTabs(doc.text)) {
    tabs++
    const prior = doc.text.slice(0, tab.start)
    const major = [...prior.matchAll(/^## (.*)$/gm)].at(-1)?.[1] ?? ''
    for (const table of tab.body.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/g)) {
      const rows = cnTable(table[0])
      const head = (rows.shift() ?? []).map(cnText)
      const idAt = head.findIndex((column) => /模型\s*ID/.test(column))
      if (idAt < 0) continue // Native cache/promotion tables are not model listings.
      for (const column of head) {
        if (
          /^(?:输入|输出)单价.*Token/.test(column) &&
          !/^(?:输入|输出)单价\s*（每百万\s*Token）/.test(column)
        )
          fail(`unknown token price unit ${column}`)
      }
      const inputAt = head.findIndex((column) =>
        /^输入单价\s*（每百万\s*Token）/.test(column),
      )
      const multipleTokenMeters =
        head.filter((column) => /^输入单价\s*（每百万\s*Token）/.test(column))
          .length > 1 ||
        head.filter((column) => /^输出单价\s*（每百万\s*Token）/.test(column))
          .length > 1
      while (rows[0] && cnText(rows[0][idAt] ?? '') === head[idAt]) rows.shift()
      const outputAt = head.findIndex((column) =>
        /^输出单价\s*（每百万\s*Token）/.test(column),
      )
      const rangeAt = head.findIndex((column) =>
        /输入Token(?:数|范围|数量)/.test(column),
      )
      const modeAt = head.indexOf('模式')
      for (const row of rows) {
        if (row.length !== head.length)
          fail(`unequal model table columns ${head.join('|')}`)
        const ids = cellIds(row[idAt]!)
        for (const rawId of ids) {
          if (!result.has(rawId))
            result.set(rawId, {
              rawId,
              displayName: null,
              activity: activity(major),
              pricing: null,
              contextWindow: null,
              maxOutput: null,
              capabilities: null,
              serverTools: null,
              modalities: null,
              reasoning: null,
              requestMap: null,
              schemaEndpointId: null,
              absent: { pricing: 'cleared' },
              providerMetadata: {
                listingScope: 'public Beijing documentation',
                nativePricingColumns: head,
              },
            })
        }
        // Dimensional audio/image/video/size pricing is sourced but requires its
        // own usage model; it is not a single text token quote. Remain null.
        if (inputAt < 0 || multipleTokenMeters) continue
        if (/^已下线(?:[ >]|$)/.test(cnText(row[inputAt]!))) {
          for (const id of ids) result.get(id)!.deprecated = true
          continue
        }
        if (/^目前仅供免费体验[。.]?|^限时免费$/.test(cnText(row[inputAt]!)))
          continue
        if (
          /忙时.+闲时|^(?:文本|图片|视频|音频)输入：/.test(
            cnText(row[inputAt]!),
          )
        )
          continue
        const input = amounts(row[inputAt]!)
        const output = outputAt >= 0 ? amounts(row[outputAt]!) : null
        if (
          output &&
          JSON.stringify([...input.keys()]) !==
            JSON.stringify([...output.keys()])
        )
          fail(`mismatched input and output price tiers ${ids.join(',')}`)
        if (input.size > 1 && rangeAt >= 0)
          fail(`tiered price cell inside a token range row ${ids.join(',')}`)
        for (const [cellFloor, inputRate] of input) {
          const rates: Record<string, number> = {
            input_tokens: inputRate.rate,
          }
          if (inputRate.cacheRead !== undefined)
            rates.cache_read_tokens = inputRate.cacheRead
          const outputRate = output?.get(cellFloor)
          if (outputRate?.cacheRead !== undefined)
            fail(`cached-input quote on an output price ${ids.join(',')}`)
          if (outputRate) rates.output_tokens = outputRate.rate
          const quote: Quoted = {
            models: ids,
            mode: modeAt >= 0 ? cnText(row[modeAt]!) : '',
            floor: rangeAt >= 0 ? floor(row[rangeAt]!) : cellFloor,
            rates,
          }
          for (const id of ids)
            quoted.set(id, [...(quoted.get(id) ?? []), quote])
        }
      }
    }
  }
  if (!tabs || !result.size) fail('no Beijing model listing tables')
  for (const [id, rows] of quoted) {
    const modes = new Set(rows.map((row) => row.mode))
    // Distinct thinking-mode prices cannot be selected silently.
    if (modes.size > 1) continue
    const tiers = new Map<number, Record<string, number>>()
    for (const row of rows) {
      const old = tiers.get(row.floor)
      if (old && JSON.stringify(old) !== JSON.stringify(row.rates))
        fail(`conflicting Beijing price ${id}`)
      tiers.set(row.floor, row.rates)
    }
    const base = tiers.get(0)
    if (
      base &&
      [...tiers.values()].some((rates) =>
        Object.keys(base).some((lever) => rates[lever] === undefined),
      )
    )
      fail(`incomplete price tier ${id}`)
    if (!base) fail(`missing base price tier ${id}`)
    const pricing = compileTokenCard(
      base,
      [...tiers]
        .filter(([min]) => min > 0)
        .sort(([a], [b]) => a - b)
        .map(([minPromptTokens, rates]) => ({ minPromptTokens, rates })),
      { url: doc.url, hash: doc.hash, extractedAt: new Date().toISOString() },
      { currency: 'CNY' },
    )
    if (!pricing) fail(`unrepresentable token quote ${id}`)
    const model = result.get(id)!
    model.pricing = pricing
    delete model.absent
    model.factSources = {
      pricing: ownSource(doc, '华北2（北京） model pricing table'),
    }
  }
  return [...result.values()]
}

/** Exact ids and expressly included snapshots in the provider's Chinese table. */
export function applyCnTextFacts(models: ModelInfo[], doc: CnDoc): ModelInfo[] {
  const facts = new Map<
    string,
    {
      contextWindow: number
      capabilities: string[]
      unsupportedCapabilities: string[]
      snapshots: boolean
    }
  >()
  for (const table of doc.text.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/g)) {
    const rows = cnTable(table[0]),
      head = (rows.shift() ?? []).map(cnText)
    if (head[0] !== '模型ID' || !head.includes('上下文')) continue
    const contextAt = head.indexOf('上下文')
    const mapped: Record<string, string> = {
      思考模式: 'reasoning',
      'Function Calling': 'tools',
      结构化输出: 'structured_outputs',
    }
    for (const row of rows) {
      if (row.length !== head.length) fail('unequal native capability table')
      const ids = [...row[0]!.matchAll(/<code>([^<]+)<\/code>/g)].map(
        (match) => match[1]!,
      )
      if (!ids.length) ids.push(...cellIds(row[0]!))
      const contextValue = cnText(row[contextAt]!),
        match = /^(\d+(?:\.\d+)?)([KM])$/i.exec(contextValue)
      if (!match) fail(`unreadable native context limit ${contextValue}`)
      const contextWindow =
        Number(match[1]) * (match[2]!.toUpperCase() === 'M' ? 1e6 : 1e3)
      if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)
        fail('invalid native context limit')
      const capabilities: string[] = [],
        unsupportedCapabilities: string[] = []
      for (let index = 0; index < head.length; index++) {
        const flag = mapped[head[index]!]
        if (!flag) continue
        const value = cnText(row[index]!)
        // JSON Mode is a response_format yes and says nothing about strict
        // structured outputs (same split as openai-compat's json_mode).
        if (flag === 'structured_outputs' && value === '支持（JSON Mode）') {
          capabilities.push('response_format')
          continue
        }
        if (value !== '支持' && value !== '不支持')
          fail(`unknown capability support value: ${value}`)
        if (value === '支持') capabilities.push(flag)
        else unsupportedCapabilities.push(flag)
      }
      for (const id of ids) {
        const fact = {
          contextWindow,
          capabilities,
          unsupportedCapabilities,
          snapshots: /及其快照版本/.test(cnText(row[0]!)),
        }
        if (
          facts.has(id) &&
          JSON.stringify(facts.get(id)) !== JSON.stringify(fact)
        )
          fail('conflicting native capability rows')
        facts.set(id, fact)
      }
    }
  }
  if (!facts.size) fail('native text catalog has no capability tables')
  return models.map((model) => {
    const candidates = [...facts].filter(
      ([id, fact]) =>
        id === model.rawId ||
        (fact.snapshots &&
          model.rawId.startsWith(`${id}-`) &&
          /^\d{4}-\d{2}-\d{2}$/.test(model.rawId.slice(id.length + 1))),
    )
    if (candidates.length > 1) fail('ambiguous native snapshot scope')
    const fact = candidates[0]?.[1]
    if (!fact) return model
    return {
      ...model,
      contextWindow: fact.contextWindow,
      capabilities: fact.capabilities,
      unsupportedCapabilities: fact.unsupportedCapabilities,
      factSources: {
        ...model.factSources,
        contextWindow: ownSource(doc, '上下文'),
        capabilities: Object.fromEntries(
          [...fact.capabilities, ...fact.unsupportedCapabilities].map(
            (flag) => [flag, ownSource(doc, `model capability table.${flag}`)],
          ),
        ),
      },
    }
  })
}

/** Own card headings define exact ids; Beijing capability tables alone win. */
export function applyCnCardFacts(models: ModelInfo[], doc: CnDoc): ModelInfo[] {
  const byId = new Map<
    string,
    Partial<Omit<ModelInfo, 'capabilities'>> & { capabilities?: string[] }
  >()
  const completed = new Map<string, Set<string>>()
  let current: string | null = null
  const starts = [...doc.text.matchAll(/^#{1,6}\s+([^\n]+)$/gm)]
  for (let index = 0; index < starts.length; index++) {
    const heading = cnText(starts[index]![1]!)
    if (/^[a-z][a-z0-9._-]*-[a-z0-9._-]+$/.test(heading)) current = heading
    if (!current) continue
    const section = doc.text.slice(
      starts[index]!.index + starts[index]![0].length,
      starts[index + 1]?.index ?? doc.text.length,
    )
    const facts = byId.get(current) ?? {}
    const seen = completed.get(current) ?? new Set<string>()
    if (heading === '上下文限制') {
      for (const table of section.matchAll(
        /<table\b[^>]*>[\s\S]*?<\/table>/g,
      )) {
        for (const row of cnTable(table[0]).slice(1))
          for (let column = 0; column + 1 < row.length; column += 2) {
            const label = cnText(row[column]!),
              text = cnText(row[column + 1]!)
            if (label !== '上下文长度' && label !== '最大输出长度') continue
            if (
              !/^\d+$/.test(text) ||
              !Number.isSafeInteger(Number(text)) ||
              Number(text) <= 0
            )
              fail('unreadable card token limit')
            const key = label === '上下文长度' ? 'contextWindow' : 'maxOutput'
            if (facts[key] != null && facts[key] !== Number(text))
              fail('conflicting card token limit')
            facts[key] = Number(text)
            seen.add(key)
          }
      }
    }
    if (heading === '模型能力') {
      const modes: Record<string, string> = {
        Text: 'text',
        Image: 'image',
        Audio: 'audio',
        Video: 'video',
      }
      let input: string[] | null = null,
        output: string[] | null = null
      const flags = new Set<string>(),
        unsupported = new Set<string>()
      const checked = new Set<string>()
      const panels = cnBeijingTabs(section)
      if (!panels.length) fail('card has no Beijing capability panel')
      for (const panel of panels)
        for (const table of panel.body.matchAll(
          /<table\b[^>]*>[\s\S]*?<\/table>/g,
        )) {
          for (const row of cnTable(table[0]).slice(1))
            for (let column = 0; column + 1 < row.length; column += 2) {
              const label = cnText(row[column]!),
                value = cnText(row[column + 1]!)
              if (label === '输入模态' || label === '输出模态') {
                const kinds = value
                  .split(/[,，/\s]+/)
                  .map(
                    (kind) =>
                      modes[kind] ?? fail(`unknown card modality ${kind}`),
                  )
                const old = label === '输入模态' ? input : output
                if (old && JSON.stringify(old) !== JSON.stringify(kinds))
                  fail('conflicting card modality')
                if (label === '输入模态') input = kinds
                else output = kinds
              }
              const flag =
                label === 'Function Calling'
                  ? 'tools'
                  : label === '结构化输出'
                    ? 'structured_outputs'
                    : null
              if (flag) {
                if (value !== '支持' && value !== '不支持')
                  fail('unknown card capability status')
                if (
                  (flags.has(flag) && value === '不支持') ||
                  (unsupported.has(flag) && value === '支持')
                )
                  fail('conflicting card capability status')
                checked.add(flag)
                if (value === '支持') flags.add(flag)
                else unsupported.add(flag)
              }
            }
        }
      if (
        !input ||
        !output ||
        !checked.has('tools') ||
        !checked.has('structured_outputs')
      )
        fail('incomplete Beijing card capability table')
      facts.modalities = { input, output }
      facts.capabilities = [...flags]
      facts.unsupportedCapabilities = [...unsupported]
      seen.add('capabilities')
    }
    byId.set(current, facts)
    completed.set(current, seen)
  }
  if (!byId.size) fail('own card names no model ids')
  for (const [id, seen] of completed)
    if (
      !['contextWindow', 'maxOutput', 'capabilities'].every((key) =>
        seen.has(key),
      )
    )
      fail(`incomplete native card ${id}`)
  return models.map((model) => {
    const fact = byId.get(model.rawId)
    if (!fact) return model
    const capabilities = [
      ...new Set([
        ...(Array.isArray(model.capabilities)
          ? (model.capabilities as string[]).filter(
              (flag) =>
                !Array.isArray(fact.capabilities) ||
                (flag !== 'tools' && flag !== 'structured_outputs'),
            )
          : []),
        ...(Array.isArray(fact.capabilities) ? fact.capabilities : []),
      ]),
    ]
    const sources = { ...model.factSources }
    if (fact.contextWindow != null)
      sources.contextWindow = ownSource(doc, '上下文限制.上下文长度')
    if (fact.maxOutput != null)
      sources.maxOutput = ownSource(doc, '上下文限制.最大输出长度')
    if (fact.modalities != null)
      sources.modalities = ownSource(
        doc,
        '华北2（北京）.模型能力.输入/输出模态',
      )
    if (Array.isArray(fact.capabilities))
      sources.capabilities = {
        ...Object.fromEntries(
          Object.entries(model.factSources?.capabilities ?? {}).filter(
            ([flag]) => flag !== 'tools' && flag !== 'structured_outputs',
          ),
        ),
        ...Object.fromEntries(
          [...fact.capabilities, ...(fact.unsupportedCapabilities ?? [])].map(
            (flag) => [flag, ownSource(doc, `华北2（北京）.模型能力.${flag}`)],
          ),
        ),
      }
    const unsupportedCapabilities = [
      ...new Set([
        ...(model.unsupportedCapabilities ?? []).filter(
          (flag) => !['tools', 'structured_outputs'].includes(flag),
        ),
        ...(fact.unsupportedCapabilities ?? []),
      ]),
    ]
    return {
      ...model,
      ...fact,
      capabilities,
      unsupportedCapabilities,
      factSources: sources,
    }
  })
}

const CN_CONSOLE_DETAIL =
  'https:\\/\\/bailian\\.console\\.aliyun\\.com\\/cn-beijing\\/model\\/market\\/detail\\/[^"?#]+'

/**
 * Beijing console links on the selection page: `<a href>name</a>`, or the
 * MDX `<Card title="name" href>` the page uses as of 2026-10-27.
 */
function cnConsoleLinks(text: string) {
  const links: { href: string; name: string; index: number }[] = []
  for (const anchor of text.matchAll(
    new RegExp(
      `<a\\b[^>]*href="(${CN_CONSOLE_DETAIL})"[^>]*>([\\s\\S]*?)<\\/a>`,
      'g',
    ),
  ))
    links.push({ href: anchor[1]!, name: anchor[2]!, index: anchor.index })
  for (const card of text.matchAll(/<Card\b([^>]*)>/g)) {
    const href = /(?:^|\s)href="([^"]+)"/.exec(card[1]!)?.[1]
    if (!href || !new RegExp(`^${CN_CONSOLE_DETAIL}$`).test(href)) continue
    const name = /(?:^|\s)title="([^"]*)"/.exec(card[1]!)?.[1]
    if (name === undefined) fail('native console card has no title')
    links.push({ href, name, index: card.index })
  }
  return links.sort((a, b) => a.index - b.index)
}

/** Native CN console links publish their exact encoded model ids. */
export function applyCnCatalog(models: ModelInfo[], doc: CnDoc): ModelInfo[] {
  const out = new Map(models.map((model) => [model.rawId, model]))
  let count = 0
  for (const link of cnConsoleLinks(doc.text)) {
    const encoded = new URL(link.href).pathname.split('/detail/')[1]
    if (!encoded) fail('empty native console id')
    const rawId = decodeURIComponent(encoded)
    if (!/^[a-z][a-z0-9_./-]+$/i.test(rawId))
      fail('malformed native console id')
    count++
    if (out.has(rawId)) {
      out.get(rawId)!.displayName = cnText(link.name) || null
      continue
    }
    const prior = doc.text.slice(0, link.index)
    const major = [...prior.matchAll(/^## (.*)$/gm)].at(-1)?.[1] ?? ''
    const ambiguous = /图像与视频|向量与重排序/.test(major)
    out.set(rawId, {
      rawId,
      displayName: cnText(link.name) || null,
      activity: ambiguous ? null : activity(major),
      pricing: null,
      absent: { pricing: 'cleared' },
      contextWindow: null,
      maxOutput: null,
      modalities: null,
      capabilities: null,
      serverTools: null,
      reasoning: null,
      requestMap: null,
      schemaEndpointId: null,
      providerMetadata: {
        listingScope: 'public Beijing console links',
        catalogSource: doc.url,
      },
    })
  }
  if (!count) fail('native selection docs have no Beijing console models')
  return [...out.values()]
}
