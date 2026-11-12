/**
 * Reasoning controls and the chat request map, read on every poll.
 *
 * The reasoning page
 * (https://inference-docs.cerebras.ai/capabilities/reasoning.md) lists each
 * model under "Model behavior". That section's value table is the effort
 * list. A behavior of "Disables reasoning" is the off value; "Not supported"
 * is rejected; "always enables reasoning" or a rejected `none` is
 * `mandatory`. A section that says the API ignores `reasoning_effort` is
 * not a control. `mandatory` stays unset unless that section states it.
 *
 * The chat spec
 * (https://inference-docs.cerebras.ai/api-reference/openapi.yaml) names
 * `max_completion_tokens` (`max_tokens` is its alias) and says developer
 * messages are supported only by the ids in that sentence.
 */
import { assertParsed, cachedDocs } from './model-facts.ts'
import { reasoningFactsFor } from './reasoning-config.ts'
import type { ChatRequestMap, EffortLevelMap } from './request-map.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo, ModelReasoning } from './types.ts'

export const CEREBRAS_REASONING_URL =
  'https://inference-docs.cerebras.ai/capabilities/reasoning.md'
export const CEREBRAS_CHAT_SPEC_URL =
  'https://inference-docs.cerebras.ai/api-reference/openapi.yaml'

export interface CerebrasReasoningDoc {
  configured: Map<string, ModelReasoning>
  /** Accepts `reasoning_effort` and ignores it. No reasoning object. */
  ignored: Array<string>
}

export interface CerebrasChatSpec {
  maxTokensField: 'max_completion_tokens' | 'max_tokens'
  /** Ids the spec says may send `role: "developer"`. */
  developerIds: Array<string>
}

interface SummaryRow {
  name: string
  /** Null when the summary says the effort is not configurable. */
  defaultEffort: string | null
}

function tableCells(line: string): Array<string> | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null
  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim())
}

function isSeparator(cells: Array<string>): boolean {
  return cells.every((cell) => /^:?-+:?$/.test(cell))
}

function markdownTables(markdown: string): Array<Array<Array<string>>> {
  const tables: Array<Array<Array<string>>> = []
  let current: Array<Array<string>> | null = null
  for (const line of markdown.split('\n')) {
    const cells = tableCells(line)
    if (!cells) {
      if (current) tables.push(current)
      current = null
      continue
    }
    if (isSeparator(cells)) continue
    current ??= []
    current.push(cells)
  }
  if (current) tables.push(current)
  return tables
}

function summaryName(cell: string): string {
  const name = cell.match(/^\[([^\]]+)\]\(#[^)]+\)$/)?.[1]
  if (!name) {
    throw new Error(`cerebras reasoning: model cell has no anchor: ${cell}`)
  }
  return name
}

function summaryDefault(cell: string): string | null {
  if (/^not configurable$/i.test(cell)) return null
  const token = cell.match(
    /^`([a-z][a-z0-9]*)`(?:\s*\((?:disabled|default)\))?$/,
  )?.[1]
  if (!token) {
    throw new Error(`cerebras reasoning: unread default effort: ${cell}`)
  }
  return token
}

/** The supported-models table. Its default has to match the model section. */
function supportedModels(markdown: string): Array<SummaryRow> {
  const tables = markdownTables(markdown).filter((table) => {
    const header = table[0]
    return (
      header?.length === 3 &&
      header[0]?.toLowerCase() === 'model' &&
      header[1]?.toLowerCase() === 'default effort' &&
      header[2]?.toLowerCase() === 'availability'
    )
  })
  if (tables.length === 0) {
    throw new Error('cerebras reasoning: no supported-models table')
  }
  if (tables.length > 1) {
    throw new Error('cerebras reasoning: more than one supported-models table')
  }
  const rows = tables[0]?.slice(1) ?? []
  if (rows.length === 0) {
    throw new Error('cerebras reasoning: supported-models table is empty')
  }
  return rows.map((cells) => {
    if (cells.length !== 3) {
      throw new Error(
        `cerebras reasoning: short summary row: ${cells.join(' | ')}`,
      )
    }
    return {
      name: summaryName(cells[0] ?? ''),
      defaultEffort: summaryDefault(cells[1] ?? ''),
    }
  })
}

function modelSections(
  markdown: string,
): Array<{ heading: string; body: string }> {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line.trim() === '## Model behavior')
  if (start < 0) {
    throw new Error('cerebras reasoning: no model behavior section')
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index++) {
    if (/^## [^#]/.test(lines[index] ?? '')) {
      end = index
      break
    }
  }
  const parts = lines
    .slice(start + 1, end)
    .join('\n')
    .split(/^### /m)
  if (/^\|/m.test(parts[0] ?? '')) {
    throw new Error('cerebras reasoning: unread table before the first model')
  }
  const sections = parts.slice(1).map((part) => {
    const breakAt = part.indexOf('\n')
    const heading = (breakAt < 0 ? part : part.slice(0, breakAt)).trim()
    if (heading === '') {
      throw new Error('cerebras reasoning: empty model heading')
    }
    return { heading, body: breakAt < 0 ? '' : part.slice(breakAt + 1) }
  })
  if (sections.length === 0) {
    throw new Error('cerebras reasoning: no model sections')
  }
  return sections
}

/** The first backtick is the model id. A later `reasoning_effort` is not. */
function sectionModelId(heading: string, body: string): string {
  const id = body.match(/`([^`]+)`/)?.[1]
  if (!id || !/^[a-z0-9][a-z0-9.-]*$/.test(id)) {
    throw new Error(`cerebras reasoning: ${heading} names no model id`)
  }
  return id
}

function valueRows(
  id: string,
  body: string,
): Array<{ value: string; behavior: string }> {
  const rows: Array<{ value: string; behavior: string }> = []
  let open = false
  let tables = 0
  for (const line of body.split('\n')) {
    const cells = tableCells(line)
    if (!cells) {
      open = false
      continue
    }
    if (isSeparator(cells)) continue
    const header =
      cells.length === 2 &&
      cells[0]?.toLowerCase() === 'value' &&
      cells[1]?.toLowerCase() === 'behavior'
    if (header) {
      tables += 1
      if (tables > 1) {
        throw new Error(
          `cerebras reasoning: ${id} has more than one effort table`,
        )
      }
      open = true
      continue
    }
    if (!open || cells.length !== 2) {
      throw new Error(`cerebras reasoning: ${id} has an unread table`)
    }
    rows.push({ value: cells[0] ?? '', behavior: cells[1] ?? '' })
  }
  if (tables === 0) {
    throw new Error(`cerebras reasoning: ${id} has no effort table`)
  }
  if (rows.length === 0) {
    throw new Error(`cerebras reasoning: ${id} effort table is empty`)
  }
  return rows
}

function ignoresEffort(body: string): boolean {
  return (
    /accepts `reasoning_effort`[\s\S]{0,160}?ignores its value/i.test(body) ||
    /accepted but ignored/i.test(body)
  )
}

function readIgnored(
  id: string,
  rows: Array<{ value: string; behavior: string }>,
): void {
  for (const row of rows) {
    if (row.value.startsWith('`')) {
      throw new Error(
        `cerebras reasoning: ${id} ignores reasoning_effort but lists ${row.value}`,
      )
    }
    if (!/^(?:omitted|any accepted value)\b/i.test(row.value)) {
      throw new Error(
        `cerebras reasoning: ${id} unread ignored value: ${row.value}`,
      )
    }
    if (!/keeps reasoning enabled/i.test(row.behavior)) {
      throw new Error(
        `cerebras reasoning: ${id} unread ignored behavior: ${row.behavior}`,
      )
    }
  }
}

function behaviorKind(
  id: string,
  cell: string,
): 'disable' | 'accept' | 'reject' {
  if (/^disables reasoning\.?$/i.test(cell)) return 'disable'
  if (/^not supported\.?$/i.test(cell)) return 'reject'
  if (/^selects\b/i.test(cell) || /^enables reasoning\b/i.test(cell)) {
    return 'accept'
  }
  throw new Error(`cerebras reasoning: ${id} unread behavior: ${cell}`)
}

function effortTokens(
  id: string,
  cell: string,
): { tokens: Array<string>; defaultToken: string | null } {
  const parts = cell
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) {
    throw new Error(`cerebras reasoning: ${id} unread effort cell: ${cell}`)
  }
  const tokens: Array<string> = []
  let defaultToken: string | null = null
  for (const part of parts) {
    const match = part.match(/^`([a-z][a-z0-9]*)`(?:\s*\((default)\))?$/)
    const token = match?.[1]
    if (!token || tokens.includes(token)) {
      throw new Error(`cerebras reasoning: ${id} unread effort cell: ${cell}`)
    }
    tokens.push(token)
    if (match[2]) {
      if (defaultToken) {
        throw new Error(`cerebras reasoning: ${id} marks two defaults`)
      }
      defaultToken = token
    }
  }
  return { tokens, defaultToken }
}

function reasoningFrom(
  id: string,
  body: string,
  rows: Array<{ value: string; behavior: string }>,
  summaryDefaultEffort: string,
): ModelReasoning {
  const efforts: Array<string> = []
  const rejected: Array<string> = []
  let defaultToken: string | null = null
  let disables = false
  for (const row of rows) {
    const kind = behaviorKind(id, row.behavior)
    const parsed = effortTokens(id, row.value)
    if (parsed.defaultToken) {
      if (kind === 'reject') {
        throw new Error(
          `cerebras reasoning: ${id} default ${parsed.defaultToken} is not supported`,
        )
      }
      if (defaultToken) {
        throw new Error(`cerebras reasoning: ${id} marks two defaults`)
      }
      defaultToken = parsed.defaultToken
    }
    for (const token of parsed.tokens) {
      if (efforts.includes(token) || rejected.includes(token)) {
        throw new Error(`cerebras reasoning: ${id} lists ${token} twice`)
      }
      if (kind === 'reject') rejected.push(token)
      else efforts.push(token)
    }
    if (kind === 'disable') disables = true
  }
  if (efforts.length === 0) {
    throw new Error(`cerebras reasoning: ${id} lists no effort values`)
  }
  if (!defaultToken || !efforts.includes(defaultToken)) {
    throw new Error(`cerebras reasoning: ${id} marks no accepted default`)
  }
  if (defaultToken !== summaryDefaultEffort) {
    throw new Error(
      `cerebras reasoning: ${id} default is ${defaultToken} but the summary says ${summaryDefaultEffort}`,
    )
  }
  const always = /always enables reasoning/i.test(body)
  if (disables && always) {
    throw new Error(
      `cerebras reasoning: ${id} always enables reasoning but a value disables it`,
    )
  }
  const proseOff = /set `reasoning_effort` to `none`/i.test(body)
  // `none` that disables, or a stated always-on / rejected `none`. Nothing
  // else sets mandatory: a bare effort list states no off switch.
  const mandatory = disables
    ? false
    : always || rejected.includes('none')
      ? true
      : null
  if (mandatory === null) {
    throw new Error(
      `cerebras reasoning: ${id} does not state whether reasoning can be disabled`,
    )
  }
  if (proseOff && (mandatory || !efforts.includes('none'))) {
    throw new Error(
      `cerebras reasoning: ${id} says to send none but the table disagrees`,
    )
  }
  if (mandatory && efforts.includes('none')) {
    throw new Error(
      `cerebras reasoning: ${id} cannot be disabled but lists none`,
    )
  }
  if (!mandatory && !efforts.includes('none')) {
    throw new Error(
      `cerebras reasoning: ${id} can be disabled but lists no none`,
    )
  }
  return { mode: 'effort', mandatory, efforts }
}

/**
 * Per-model sections under "Model behavior". The summary table only checks
 * that every listed model has a section and that its default matches.
 */
export function parseCerebrasReasoning(markdown: string): CerebrasReasoningDoc {
  const text = markdown.replace(/```[\s\S]*?```/g, '')
  const summary = supportedModels(text)
  const sections = modelSections(text)
  if (sections.length !== summary.length) {
    throw new Error(
      `cerebras reasoning: ${sections.length} model sections for ${summary.length} summary rows`,
    )
  }
  const configured = new Map<string, ModelReasoning>()
  const ignored: Array<string> = []
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index]
    const row = summary[index]
    if (!section || !row || section.heading !== row.name) {
      throw new Error(
        `cerebras reasoning: section ${section?.heading ?? '(missing)'} is not summary row ${row?.name ?? '(missing)'}`,
      )
    }
    const id = sectionModelId(section.heading, section.body)
    if (configured.has(id) || ignored.includes(id)) {
      throw new Error(`cerebras reasoning: duplicate id ${id}`)
    }
    const values = valueRows(id, section.body)
    if (ignoresEffort(section.body)) {
      readIgnored(id, values)
      if (row.defaultEffort !== null) {
        throw new Error(
          `cerebras reasoning: ${id} ignores reasoning_effort but the summary default is ${row.defaultEffort}`,
        )
      }
      ignored.push(id)
      continue
    }
    if (row.defaultEffort === null) {
      throw new Error(
        `cerebras reasoning: ${id} summary says not configurable but the section lists efforts`,
      )
    }
    configured.set(
      id,
      reasoningFrom(id, section.body, values, row.defaultEffort),
    )
  }
  return { configured, ignored }
}

function property(yaml: string, name: string): boolean {
  return new RegExp(`^[ \\t]+${name}:[ \\t]*$`, 'm').test(yaml)
}

/**
 * Output-cap field and the models allowed to send `developer`. Throws when
 * the spec no longer says which field is the alias, or which models take
 * the developer role.
 */
export function parseCerebrasChatSpec(yaml: string): CerebrasChatSpec {
  const completion = property(yaml, 'max_completion_tokens')
  const alias = property(yaml, 'max_tokens')
  if (!completion && !alias) {
    throw new Error('cerebras spec: no max token field')
  }
  if (alias) {
    const aliasOf =
      /max_tokens:[\s\S]{0,400}?An alias for `max_completion_tokens`/.test(yaml)
    if (!aliasOf) {
      throw new Error(
        'cerebras spec: max_tokens is not an alias of max_completion_tokens',
      )
    }
  }
  if (!completion) {
    return { maxTokensField: 'max_tokens', developerIds: developerIds(yaml) }
  }
  return {
    maxTokensField: 'max_completion_tokens',
    developerIds: developerIds(yaml),
  }
}

function developerIds(yaml: string): Array<string> {
  const sentence = yaml.match(
    /Developer messages are supported only by ([^.]+)\./,
  )?.[1]
  if (!sentence) {
    throw new Error('cerebras spec: developer-role sentence missing')
  }
  const ids = [...sentence.matchAll(/`([^`]+)`/g)].map(
    (match) => match[1] ?? '',
  )
  if (ids.length === 0 || ids.some((id) => id === '')) {
    throw new Error('cerebras spec: developer-role sentence names no model')
  }
  return ids
}

function levelsFor(efforts: Array<string>, off: string | null): EffortLevelMap {
  return {
    off,
    minimal: efforts.includes('minimal') ? 'minimal' : null,
    low: efforts.includes('low') ? 'low' : null,
    medium: efforts.includes('medium') ? 'medium' : null,
    high: efforts.includes('high') ? 'high' : null,
    xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
    max: efforts.includes('max') ? 'max' : null,
  }
}

/** `on` is effort high. A model that does not accept `high` has no such body. */
export function cerebrasThinking(
  efforts: Array<string>,
): ChatRequestMap['thinking'] {
  if (!efforts.includes('high')) return null
  const off = efforts.includes('none') ? 'none' : null
  return {
    on: { reasoning_effort: 'high' },
    off: off === null ? null : { reasoning_effort: off },
    levels: levelsFor(efforts, off),
  }
}

export function cerebrasRequestMap(
  rawId: string,
  spec: CerebrasChatSpec,
  reasoning: ModelReasoning | undefined,
  ignored: boolean,
): ChatRequestMap {
  const efforts =
    reasoning?.mode === 'effort' ? (reasoning.efforts ?? []) : null
  return {
    thinking: efforts ? cerebrasThinking(efforts) : null,
    maxTokensField: spec.maxTokensField,
    developerRole: spec.developerIds.includes(rawId),
    replayReasoningContent: null,
    store: null,
    strictTools: null,
    sessionAffinity: null,
    cacheControl: null,
    toolStream: null,
    reasoningEffort: efforts !== null || ignored ? true : null,
  }
}

interface CachedReasoning {
  byId: Record<string, ModelReasoning>
  ignored: Array<string>
  hash: string
}

interface CachedSpec {
  spec: CerebrasChatSpec
  hash: string
}

/** Reasoning object plus the request map for one listed id. */
export async function cerebrasChatFacts(
  kv?: KVNamespace,
): Promise<(rawId: string, capability: boolean) => Partial<ModelInfo>> {
  const [reasoning, spec] = await Promise.all([
    cachedDocs(kv, CEREBRAS_REASONING_URL, async () => {
      const markdown = await fetchText(CEREBRAS_REASONING_URL)
      const parsed = parseCerebrasReasoning(markdown)
      assertParsed(parsed.configured, 'cerebras reasoning')
      const cached: CachedReasoning = {
        byId: Object.fromEntries(parsed.configured),
        ignored: parsed.ignored,
        hash: await sha256Text(markdown),
      }
      return cached
    }),
    cachedDocs(kv, CEREBRAS_CHAT_SPEC_URL, async () => {
      const yaml = await fetchText(CEREBRAS_CHAT_SPEC_URL)
      const cached: CachedSpec = {
        spec: parseCerebrasChatSpec(yaml),
        hash: await sha256Text(yaml),
      }
      return cached
    }),
  ])
  return (rawId, capability) => {
    const row = reasoning.byId[rawId]
    return {
      ...reasoningFactsFor(
        rawId,
        reasoning.byId,
        { url: CEREBRAS_REASONING_URL, hash: reasoning.hash },
        capability,
      ),
      requestMap: cerebrasRequestMap(
        rawId,
        spec.spec,
        row,
        reasoning.ignored.includes(rawId),
      ),
    }
  }
}
