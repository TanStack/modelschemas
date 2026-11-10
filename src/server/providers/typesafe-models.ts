/**
 * Jev catalog from https://docs.typesafe.ai/models (issue #621). The
 * comparison table is the versioned model ids, the per-request context,
 * and the price. Aliases (`jev-latest`, `jev-preview`) are names for a
 * column in that table, not separate models. Output tokens are free only
 * while the page says so. A page that cannot be read throws.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import { markdownTableRows, parseDay, tokenCount } from './model-facts.ts'
import { sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const TYPESAFE_MODELS_URL = 'https://docs.typesafe.ai/models.md'

const JEV_ID = /^jev-[a-z0-9.]+$/
const PRICE = /^\\?\$(\d+(?:\.\d+)?) \/ \\?\$(\d+(?:\.\d+)?)$/
const CONTEXT =
  /^(\d+(?:\.\d+)?[kKmM]?) per-request \/ (\d+(?:\.\d+)?[kKmM]?) per-question$/
const MEDIA: Record<string, string> = {
  text: 'text',
  image: 'image',
  images: 'image',
  audio: 'audio',
  video: 'video',
}
const MEDIA_ORDER = ['text', 'image', 'audio', 'video']

export interface TypesafeModelRow {
  rawId: string
  displayName: string
  aliases: Array<string>
  /** USD per input token. Output tokens are free. */
  inputPerToken: number
  contextWindow: number
  input: Array<string>
  releasedAt: number | null
}

function unquote(cell: string): string {
  return cell.replace(/`/g, '').trim()
}

/** Comparison table plus the alias table. */
export function parseTypesafeModels(page: string): Array<TypesafeModelRow> {
  if (!/output tokens are (?:currently )?free/i.test(page)) {
    throw new Error(
      'typesafe: models page does not state that output tokens are free',
    )
  }
  const tables = markdownTableRows(page).map((cells) => cells.map(unquote))
  const idAt = tables.findIndex((cells) => cells[0] === 'Model ID')
  const idRow = tables[idAt]
  const headers = tables[idAt - 1]
  if (
    !idRow ||
    !headers ||
    headers[0] !== '' ||
    headers.length !== idRow.length
  ) {
    throw new Error('typesafe: models page has no model table')
  }
  const ids = idRow.slice(1)
  if (ids.length === 0 || ids.some((id) => id === '')) {
    throw new Error('typesafe: models page has an empty model id')
  }
  for (const id of ids) {
    if (!JEV_ID.test(id)) {
      throw new Error(`typesafe: model id ${id} is not a jev id`)
    }
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error('typesafe: models page repeats a model id')
  }

  const priceRow = tables.find((cells) => cells[0]?.startsWith('Price'))
  const contextRow = tables.find((cells) => cells[0] === 'Context length')
  const inputRow = tables.find((cells) => cells[0] === 'Input')
  if (!priceRow || !contextRow || !inputRow) {
    throw new Error('typesafe: models page omits price, context, or input')
  }
  for (const cells of [priceRow, contextRow, inputRow]) {
    if (cells.length !== idRow.length) {
      throw new Error(`typesafe: ${cells[0]} row does not cover every model`)
    }
  }

  const release = page.match(
    /([A-Z][\w .'-]*?) is the newest\b[\s\S]*?available from ([A-Z][a-z]+ \d{1,2}, \d{4})/,
  )
  let releasedId: string | null = null
  let releasedAt: number | null = null
  if (release?.[1] && release[2]) {
    const name = release[1].trim()
    const column = headers.indexOf(name)
    const id = ids[column - 1]
    if (!id) {
      throw new Error(
        `typesafe: release names ${name}, which is not a model column`,
      )
    }
    const day = parseDay(release[2])
    if (day === null) throw new Error('typesafe: release date is unreadable')
    releasedId = id
    releasedAt = day / 1000
  }

  const byId = new Map<string, TypesafeModelRow>()
  ids.forEach((rawId, index) => {
    const column = index + 1
    const priced = priceRow[column]?.match(PRICE)
    if (!priced?.[1] || !priced[2]) {
      throw new Error(`typesafe: ${rawId} price is not $Btok / $Mtok`)
    }
    const perBtok = Number(priced[1])
    const perMtok = Number(priced[2])
    const inputPerToken = perBtok / 1e9
    if (Math.abs(inputPerToken - perMtok / 1e6) > inputPerToken * 1e-9) {
      throw new Error(`typesafe: ${rawId} Btok and Mtok prices disagree`)
    }
    const context = contextRow[column]?.match(CONTEXT)
    const contextWindow = tokenCount(context?.[1])
    if (!context || contextWindow === null || tokenCount(context[2]) === null) {
      throw new Error(`typesafe: ${rawId} context length is unreadable`)
    }
    const input = (inputRow[column] ?? '')
      .split(',')
      .map((part) => MEDIA[part.trim().toLowerCase()])
      .filter((part): part is string => part !== undefined)
    const named = (inputRow[column] ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '')
    if (named.length === 0 || input.length !== named.length) {
      throw new Error(`typesafe: ${rawId} input modalities are unreadable`)
    }
    byId.set(rawId, {
      rawId,
      displayName: headers[column] ?? rawId,
      aliases: [],
      inputPerToken,
      contextWindow,
      input: MEDIA_ORDER.filter((medium) => input.includes(medium)),
      releasedAt: rawId === releasedId ? releasedAt : null,
    })
  })

  for (const cells of tables) {
    const alias = cells[0]
    const target = cells[1]
    if (!alias || !target || !JEV_ID.test(alias) || !JEV_ID.test(target)) {
      continue
    }
    if (byId.has(alias)) continue
    const model = byId.get(target)
    if (!model) {
      throw new Error(
        `typesafe: alias ${alias} points at ${target}, which the model table omits`,
      )
    }
    if (model.aliases.includes(alias)) {
      throw new Error(`typesafe: duplicate alias ${alias}`)
    }
    model.aliases.push(alias)
  }
  for (const model of byId.values()) model.aliases.sort()
  return [...byId.values()].sort((a, b) => (a.rawId < b.rawId ? -1 : 1))
}

/** One card per versioned id. Aliases are not their own rows. */
export async function typesafeModelInfos(
  page: string,
): Promise<Array<ModelInfo>> {
  const parsed = parseTypesafeModels(page)
  if (parsed.length === 0) {
    throw new Error('typesafe: models page listed no ids')
  }
  const source: RateCard['source'] = {
    url: TYPESAFE_MODELS_URL,
    hash: await sha256Text(page),
    extractedAt: new Date().toISOString(),
  }
  return parsed.map((row) => {
    const pricing = compileTokenCard(
      { input_tokens: row.inputPerToken, output_tokens: 0 },
      [],
      source,
    )
    if (!pricing)
      throw new Error(`typesafe: ${row.rawId} price did not compile`)
    const modalities = { input: row.input, output: [] as Array<string> }
    return {
      rawId: row.rawId,
      displayName: row.displayName,
      activity: 'decision' as const,
      aliases: row.aliases.length > 0 ? row.aliases : null,
      contextWindow: row.contextWindow,
      modalities,
      pricing,
      releasedAt: row.releasedAt,
      factSources: tagDocsFacts(
        { pricing, contextWindow: row.contextWindow, modalities },
        TYPESAFE_MODELS_URL,
        source.hash,
      ),
    }
  })
}
