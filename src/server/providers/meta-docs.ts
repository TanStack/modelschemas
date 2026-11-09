/** Meta's current hosted Model API documentation; no comparison catalogs. */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'
import type { ModelInfo } from './types.ts'

export const META_MODELS = 'https://dev.meta.ai/docs/models'
export const META_PRICING = 'https://dev.meta.ai/docs/pricing-rate-limits'
export const META_PROTOCOLS = 'https://dev.meta.ai/docs/protocols'
export const META_REASONING = 'https://dev.meta.ai/docs/reasoning'
export const META_REFERENCE = 'https://dev.meta.ai/docs/api-reference/'
function fail(message: string): never {
  throw new Error(`meta docs: ${message}`)
}
export function plain(text: string): string {
  return text
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
/** Only server-rendered article content, excluding navigation and hydration. */
export function article(html: string): string {
  const start = html.indexOf('<h1')
  if (start < 0) fail('missing article heading')
  return html.slice(start).split('<script')[0] ?? ''
}
export function tables(html: string): Array<Array<Array<string>>> {
  return [...html.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map((table) =>
    [...table[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((row) =>
      [...row[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
        plain(cell[1] ?? ''),
      ),
    ),
  )
}
function sections(
  html: string,
  level: number,
): Array<{ name: string; id: string; body: string }> {
  const source = article(html)
  const heads = [
    ...source.matchAll(
      new RegExp(
        `<h${level}\\b[^>]*id="([^"]+)"[^>]*>([\\s\\S]*?)<\\/h${level}>`,
        'gi',
      ),
    ),
  ]
  return heads.map((head, i) => ({
    name: plain(head[2] ?? ''),
    id: head[1] ?? '',
    body: source.slice(
      head.index + head[0].length,
      heads[i + 1]?.index ?? source.length,
    ),
  }))
}
const csv = (value: string) =>
  value.split(',').map((x) =>
    x
      .trim()
      .replace(/\*$/, '')
      .toLowerCase()
      .replace(/^text (?:prompt|transcript)$/, 'text'),
  )
const ID = /[a-z0-9][a-z0-9.-]*[a-z0-9]/g
export const list = (value: string) =>
  value.split(/,\s*(?:and\s+)?|\s+and\s+/).map((x) => x.trim().toLowerCase())
const capabilityLinks = (html: string) =>
  [
    ...new Set(
      [
        ...html.matchAll(
          /href="\/docs\/(tool-calling|structured-output|reasoning)"/g,
        ),
      ].map((m) => m[1]),
    ),
  ].map((page) =>
    page === 'tool-calling'
      ? 'tools'
      : page === 'structured-output'
        ? 'structured_outputs'
        : 'reasoning',
  )
const isChatTable = (head: Array<string>) =>
  head[0] === 'Model ID' && head.includes('Context window')
/** Chat lines list only their Standard IDs on the models page; each has its own page. */
export function metaChatFamilies(html: string): Array<string> {
  return sections(html, 2)
    .filter((s) => tables(s.body).some((rows) => isChatTable(rows[0] ?? [])))
    .map((s) => s.id)
}
export const metaFamilyUrl = (id: string) => `https://dev.meta.ai/docs/${id}`
/** A chat line's own page: its at-a-glance facts and every hosted ID with its mode. */
function parseMetaFamily(html: string, family: string): Array<ModelInfo> {
  const source = article(html)
  const all = tables(source)
  const glance = new Map(
    (all.find((rows) => rows.some((row) => row[0] === 'Context window')) ?? [])
      .filter((row) => row.length === 2)
      .map((row) => [row[0] ?? '', row[1] ?? '']),
  )
  const input = glance.get('Input')
  const output = glance.get('Output')
  if (!input || !output) fail('missing model modalities')
  const context = Number(
    (glance.get('Context window') ?? '')
      .replace(/ tokens$/, '')
      .replace(/,/g, ''),
  )
  if (!Number.isSafeInteger(context) || context <= 0)
    fail('unreadable model context')
  const rows = all.find((t) => ['Variant', 'Version'].includes(t[0]?.[0] ?? ''))
  if (!rows) fail('missing model availability table')
  const head = rows[0] ?? []
  if (head[1] !== 'Model API (pay-as-you-go)')
    fail('model availability headers changed')
  const capabilities = capabilityLinks(source)
  const out: Array<ModelInfo> = []
  for (const row of rows.slice(1)) {
    if (row.length !== head.length) fail('invalid or duplicate model row')
    if (row[1] === 'Not available') continue
    const id = /^(.+) \(([a-z0-9][a-z0-9.-]*)\)$/.exec(row[0] ?? '')
    const tier =
      /^(?:Available \()?(Standard|Contributor) mode(?: only\))?$/.exec(
        row[1] ?? '',
      )?.[1]
    if (!id?.[1] || !id[2]) fail('invalid or duplicate model row')
    if (!tier) fail('unreadable model availability')
    out.push({
      rawId: id[2],
      displayName: id[1],
      activity: 'chat',
      modalities: { input: list(input), output: list(output) },
      contextWindow: context,
      maxOutput: null,
      capabilities,
      pricing: null,
      reasoning: null,
      providerMetadata: { family, tier },
    })
  }
  return out
}
/** `families` maps each `metaChatFamilies` section id to that line's page. */
export function parseMetaModels(
  html: string,
  families: Record<string, string>,
): Array<ModelInfo> {
  const out: Array<ModelInfo> = []
  const seen = new Set<string>()
  const add = (model: ModelInfo) => {
    if (seen.has(model.rawId)) fail('invalid or duplicate model row')
    seen.add(model.rawId)
    out.push(model)
  }
  for (const section of sections(html, 2)) {
    const capabilities = capabilityLinks(section.body)
    for (const rows of tables(section.body)) {
      const head = rows[0] ?? []
      if (head[0] !== 'Model ID') continue
      const ids = rows.slice(1).flatMap((row) => {
        const cell = (row[0] ?? '').split(/,\s*/)
        if (
          row.length !== head.length ||
          cell.some((id) => !/^[a-z0-9][a-z0-9.-]*$/.test(id))
        )
          fail('invalid or duplicate model row')
        return cell
      })
      if (isChatTable(head)) {
        const page = families[section.id]
        if (page === undefined) fail(`missing model page ${section.id}`)
        const models = parseMetaFamily(page, section.name)
        // The models page lists exactly the Standard IDs its line's page has.
        const standard = models
          .filter((m) => m.providerMetadata?.tier === 'Standard')
          .map((m) => m.rawId)
        if ([...standard].sort().join() !== [...ids].sort().join())
          fail(`${section.name} page disagrees with the model table`)
        models.forEach(add)
        continue
      }
      const inputCol = head.findIndex(
        (h) => h === 'Input modalities' || h === 'Input',
      )
      const outputCol = head.findIndex(
        (h) => h === 'Output modalities' || h === 'Output',
      )
      if (inputCol < 0 || outputCol < 0) fail('model modality headers changed')
      for (const row of rows.slice(1)) {
        if ((row[0] ?? '').includes(',')) fail('invalid or duplicate model row')
        const rawId = row[0] ?? ''
        const input = row[inputCol]
        const output = row[outputCol]
        if (!input || !output) fail('missing model modalities')
        const activity =
          output === 'Image'
            ? 'image'
            : section.name === 'Muse Voice Transcribe'
              ? 'audio'
              : null
        add({
          rawId,
          // One-row tables sit under the heading that names their line.
          displayName: head.includes('Family')
            ? (row[1] ?? null)
            : rows.length === 2
              ? section.name
              : null,
          activity,
          modalities: { input: csv(input), output: csv(output) },
          contextWindow: null,
          maxOutput: null,
          capabilities,
          pricing: null,
          reasoning: null,
          providerMetadata: { family: section.name },
        })
      }
    }
  }
  if (!out.length) fail('model table listed no models')
  // A layout change that hides the chat tables must not read as removals.
  if (!out.some((model) => model.activity === 'chat'))
    fail('model page listed no chat models')
  return out
}
type TokenMode = 'Standard' | 'Contributor'
/** Mode columns are named. Meta publishes them in either order. */
function tokenModeColumns(
  head: Array<string>,
): Record<TokenMode, number> | undefined {
  if (head[0] !== 'Usage' || head.length !== 3) return
  const found = new Map<TokenMode, number>()
  for (let index = 1; index < head.length; index++) {
    const cell = head[index]
    const mode: TokenMode | undefined =
      cell === 'Standard mode (per 1M tokens)'
        ? 'Standard'
        : cell === 'Contributor mode (per 1M tokens)'
          ? 'Contributor'
          : undefined
    if (!mode || found.has(mode)) return
    found.set(mode, index)
  }
  const standard = found.get('Standard')
  const contributor = found.get('Contributor')
  if (standard === undefined || contributor === undefined) return
  return { Standard: standard, Contributor: contributor }
}
/**
 * Muse Ember prices the whole request from its input size, cached tokens
 * included. The two headers name the same threshold: at or below is the
 * base column, over it is the long-context column.
 */
function promptSizeColumns(
  head: Array<string>,
): { threshold: number; upTo: number; over: number } | undefined {
  if (head[0] !== 'Usage' || head.length !== 3) return
  const attempt = /^(?:Up to|Over)\b.*\binput tokens \(per 1M tokens\)$/
  const exact = /^(Up to|Over) (\d+)K input tokens \(per 1M tokens\)$/
  const cells = [head[1] ?? '', head[2] ?? '']
  if (!cells.some((cell) => attempt.test(cell))) return
  const found = new Map<'Up to' | 'Over', { index: number; tokens: number }>()
  for (let index = 0; index < cells.length; index++) {
    const match = exact.exec(cells[index] ?? '')
    if (!match) fail('unreadable prompt-size threshold')
    const label = match[1] === 'Over' ? 'Over' : 'Up to'
    if (found.has(label)) fail('unreadable prompt-size threshold')
    found.set(label, { index: index + 1, tokens: Number(match[2]) })
  }
  const upTo = found.get('Up to')
  const over = found.get('Over')
  if (!upTo || !over || upTo.tokens === 0)
    fail('unreadable prompt-size threshold')
  if (upTo.tokens !== over.tokens) fail('prompt-size thresholds disagree')
  const threshold = upTo.tokens * 1000
  if (!Number.isSafeInteger(threshold)) fail('unreadable prompt-size threshold')
  return { threshold, upTo: upTo.index, over: over.index }
}
export function parseMetaPricing(
  html: string,
  models: Array<ModelInfo>,
  source: RateCard['source'],
): Map<string, RateCard> {
  const cards = new Map<string, RateCard>()
  const tiers = new Map(
    models.map((model) => [
      model.rawId,
      (model.providerMetadata as { tier?: string } | undefined)?.tier,
    ]),
  )
  for (const section of sections(html, 3)) {
    const rows = tables(section.body)[0]
    const head = rows?.[0] ?? []
    const tokenCols = tokenModeColumns(head)
    const sizeCols = tokenCols ? undefined : promptSizeColumns(head)
    if (rows && (tokenCols || sizeCols)) {
      // "Models: a, b in Standard mode; c in Contributor mode." A section
      // that names no mode must have only one priced column.
      const columns = new Map<string, TokenMode | undefined>()
      for (const clause of plain(section.body.split(/<table\b/)[0] ?? '').split(
        ';',
      )) {
        const modes = [
          ...new Set(
            [...clause.matchAll(/\bin (Standard|Contributor) mode\b/g)].map(
              (m) => m[1],
            ),
          ),
        ]
        if (modes.length > 1) fail('ambiguous token price mode')
        for (const id of clause.match(ID) ?? []) {
          if (!tiers.has(id)) continue
          if (columns.has(id)) fail('duplicate model price')
          columns.set(
            id,
            modes[0] === 'Contributor' || modes[0] === 'Standard'
              ? modes[0]
              : undefined,
          )
        }
      }
      if (!columns.size) fail('token pricing has no native model IDs')
      const meters: Record<string, string> = {
        'Cached input': 'cache_read_tokens',
        Input: 'input_tokens',
        Output: 'output_tokens',
      }
      const columnRates = (index: number) => {
        const rates: Record<string, number> = {}
        for (const row of rows.slice(1)) {
          const key = meters[row[0] ?? '']
          if (!key || row.length !== 3) fail('unreadable token price')
          const cell = row[index] ?? ''
          if (cell === 'Not available') continue
          const price = /^\$(\d+(?:\.\d+)?)$/.exec(cell)
          if (!price) fail('unreadable token price')
          rates[key] = Number(price[1]) / 1e6
        }
        return rates
      }
      const rates: Record<TokenMode, Record<string, number>> = {
        Standard: {},
        Contributor: {},
      }
      if (tokenCols)
        for (const mode of ['Standard', 'Contributor'] as const)
          rates[mode] = columnRates(tokenCols[mode])
      const base = sizeCols ? columnRates(sizeCols.upTo) : {}
      const over = sizeCols ? columnRates(sizeCols.over) : {}
      const priced = (['Standard', 'Contributor'] as const).filter(
        (mode) => Object.keys(rates[mode]).length,
      )
      for (const [id, stated] of columns) {
        const mode = sizeCols
          ? stated
          : (stated ?? (priced.length === 1 ? priced[0] : undefined))
        if (!mode) fail('token price mode unstated')
        const tier = tiers.get(id)
        if (tier && mode !== tier)
          fail('token price mode disagrees with model tier')
        const colRates = sizeCols ? base : rates[mode]
        if (!('input_tokens' in colRates) || !('output_tokens' in colRates))
          fail('incomplete token pricing')
        // A lever the long-context column leaves out would bill at the base
        // rate (compileTokenCard tiers fall back), so both columns must
        // price the same levers.
        if (
          sizeCols &&
          Object.keys(over).sort().join() !== Object.keys(base).sort().join()
        )
          fail('prompt-size columns price different levers')
        if (cards.has(id)) fail('duplicate model price')
        const card = sizeCols
          ? compileTokenCard(
              colRates,
              [{ minPromptTokens: sizeCols.threshold, rates: over }],
              source,
            )
          : compileTokenCard(colRates, [], source)
        if (!card) fail('uncompilable token price')
        cards.set(id, card)
      }
    } else {
      const matches = models.filter((model) => {
        const metadata = model.providerMetadata as { family?: string }
        return section.name.includes(metadata.family ?? '\u0000')
      })
      if (!matches.length) continue
      const rates: Record<string, number> = {}
      const text = plain(section.body)
      if (rows?.[0]?.join('|') === 'Usage|Price')
        for (const row of rows.slice(1)) {
          const value = row[1] ?? ''
          if (row[0] === 'Audio processed') {
            const p = /^\$(\d+(?:\.\d+)?) per hour$/.exec(value)
            if (!p) fail('unreadable audio price')
            rates.audio_seconds = Number(p[1]) / 3600
          } else if (row[0] === 'Generated image') {
            const p = /^\$(\d+(?:\.\d+)?) per image$/.exec(value)
            if (!p) fail('unreadable image price')
            rates.generated_images = Number(p[1])
          } else if (
            row[0] === 'Image segmentation' ||
            row[0] === 'Video segmentation'
          ) {
            const p = /^\$(\d+(?:\.\d+)?) per ([\d,]+) (images|frames)$/.exec(
              value,
            )
            if (!p) fail('unreadable segmentation price')
            rates[p[3] === 'images' ? 'segmented_images' : 'video_frames'] =
              Number(p[1]) / Number(p[2]?.replace(/,/g, ''))
          } else fail('unknown priced usage')
        }
      else if (section.name.includes('Image generation')) {
        const p = /flat \$(\d+(?:\.\d+)?) per generated image/.exec(text)
        if (!p) fail('unreadable image price')
        rates.generated_images = Number(p[1])
      } else if (rows?.[0]?.[0] === 'Usage')
        fail(`unknown pricing table in ${section.name}`)
      else continue
      const card = compileTokenCard(rates, [], source)
      if (!card) fail('uncompilable unit pricing')
      for (const model of matches) cards.set(model.rawId, card)
    }
  }
  if (!cards.size) fail('pricing parsed no rates')
  // Every pay-as-you-go chat ID is token priced; a missing card is a misread.
  for (const [id, tier] of tiers)
    if (tier && !cards.has(id)) fail('token-priced model has no price')
  return cards
}

// A mechanical translation of Meta's own schema tables. Unknown types throw.
type Schema = Record<string, unknown>
const nameKey = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase()
export function parseMetaSchemas(html: string): Record<string, Schema> {
  const blocks = sections(html, 3)
  const names = new Map(blocks.map((b) => [nameKey(b.name), b.id]))
  const out: Record<string, Schema> = {}
  const typeOf = (text: string): Schema => {
    if (text === '') return { 'x-source-type': null }
    const union = text.split(/\s*\|\s*/)
    if (union.length > 1) return { anyOf: union.map(typeOf) }
    if (text.startsWith('array of '))
      return { type: 'array', items: typeOf(text.slice(9)) }
    if (text.startsWith('enum (')) {
      const values = [...text.matchAll(/'([^']*)'/g)].map((m) => m[1])
      if (!values.length) fail('unreadable enum')
      return { type: 'string', enum: values }
    }
    const primitive =
      /^(string|integer|number|boolean|object|null)(?: \((uri|unixtime|binary|int64|int32)\))?$/.exec(
        text,
      )
    if (primitive)
      return {
        type: primitive[1],
        ...(primitive[2] && primitive[2] !== 'unixtime'
          ? { format: primitive[2] }
          : {}),
      }
    const id = names.get(nameKey(text))
    if (!id) fail(`unknown schema type ${text}`)
    return { $ref: `#/components/schemas/${id}` }
  }
  for (const block of blocks) {
    const rows = tables(block.body)[0]
    if (rows?.[0]?.join('|') === 'Field|Type|Required|Description') {
      const schema: Schema = { type: 'object', properties: {} }
      const nodes = new Map<string, Schema>([['', schema]])
      for (const row of rows.slice(1)) {
        if (row.length !== 4 || !['Yes', 'No'].includes(row[2] ?? ''))
          fail('schema field row changed')
        const field = row[0] ?? ''
        const pieces = field.split('.')
        const leaf = pieces.pop()
        const parentPath = pieces.join('.')
        let parent = nodes.get(parentPath)
        if (!parent || !leaf) fail(`unresolved nested field ${field}`)
        // A nullable object has its object branch in anyOf.
        if (Array.isArray(parent.anyOf)) {
          parent = (parent.anyOf as Array<Schema>).find(
            (s) => s.type === 'object',
          )
          if (!parent) fail(`non-object parent ${field}`)
        }
        if (parent.type === 'array') parent = parent.items as Schema
        if (parent.type !== 'object') fail(`non-object field parent ${field}`)
        const node = typeOf(row[1] ?? '')
        const description = row[3] ?? ''
        node.description = description
        for (const m of description.matchAll(
          /\b(minimum|maximum|minItems|maxItems|minLength|maxLength): (-?\d+(?:\.\d+)?)/g,
        ))
          node[m[1] ?? ''] = Number(m[2])
        const def = description.match(
          /\bdefault: (true|false|-?\d+(?:\.\d+)?)/,
        )?.[1]
        if (def !== undefined)
          node.default =
            def === 'true' ? true : def === 'false' ? false : Number(def)
        const properties = (parent.properties ??= {}) as Record<string, Schema>
        properties[leaf.replace(/\[\]$/, '')] = node
        if (row[2] === 'Yes') {
          const required = (parent.required ??= []) as Array<string>
          required.push(leaf.replace(/\[\]$/, ''))
        }
        nodes.set(field, node)
        if (node.type === 'array') nodes.set(`${field}[]`, node)
        if (leaf.endsWith('[]')) nodes.set(field.replace(/\[\]$/, ''), node)
      }
      out[block.id] = schema
    } else {
      const alias = [...block.body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)]
        .map((p) => plain(p[1] ?? ''))
        .find((p) => p.startsWith('Type: '))
      if (!alias) fail(`schema ${block.name} has no table or type`)
      out[block.id] = typeOf(alias.slice(6))
    }
  }
  if (!Object.keys(out).length) fail('no native schema definitions')
  return out
}
export function metaOperation(
  html: string,
  schemas: Record<string, Schema>,
): { path: string; operation: Schema } {
  const source = article(html)
  const text = plain(source)
  const endpoint = text.match(/\bPOST (\/[^ ]+)/)?.[1]
  if (!endpoint) fail('missing native POST endpoint')
  const request = source
    .split('id="request-body"')[1]
    ?.split('id="response"')[0]
  const response = source.split('id="response"')[1]
  const content = (block: string | undefined): Record<string, unknown> => {
    if (!block) fail('missing native content block')
    const contentHeads = [...block.matchAll(/<h4\b[^>]*>[\s\S]*?<\/h4>/g)]
    const out: Record<string, unknown> = {}
    for (const [i, heading] of contentHeads.entries()) {
      const media = plain(heading[0]).match(/^Content Type: ([\w/+.-]+)$/)?.[1]
      if (!media) fail('unreadable native content type')
      const body =
        block
          .slice(
            heading.index + heading[0].length,
            contentHeads[i + 1]?.index ?? block.length,
          )
          .split(/<h3\b/)[0] ?? ''
      // Usually `<resource>/schemas#id`; Messages links the same ids on its own page.
      const id = body.match(/href="\/docs\/api-reference\/[^"#]+#([^"]+)"/)?.[1]
      let schema: Schema
      if (id) {
        if (!schemas[id]) fail('missing native schema reference')
        schema = { $ref: `#/components/schemas/${id}` }
      } else {
        // ASR publishes an inline `object`, without a field/type table. Keep
        // that exact declared shape unconstrained; do not invent multipart fields.
        const inline = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)]
          .map((p) => plain(p[1] ?? ''))
          .find((p) => p === 'object')
        if (!inline) fail('missing native schema reference')
        schema = { type: 'object', 'x-source-fields': null }
      }
      out[media] = { schema }
    }
    if (!Object.keys(out).length) fail('missing native content types')
    return out
  }
  if (!plain(response ?? '').includes('HTTP 200'))
    fail('missing native successful response')
  return {
    path: `/v1${endpoint}`,
    operation: {
      requestBody: { required: true, content: content(request) },
      responses: {
        '200': {
          description: 'Native documented response',
          content: content(response),
        },
      },
    },
  }
}
