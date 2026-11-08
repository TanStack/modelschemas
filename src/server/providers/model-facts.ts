/**
 * Shared helpers for catalog facts the native `/models` endpoints omit
 * (issue #53): context window, max output, modalities, request-feature
 * capabilities. Docs parses fail closed (zero rows throws). Parsed docs
 * live in KV for six hours so cron isolates do not refetch every tick.
 */
import { errorMessage } from '#/server/errors.ts'
import { noteIngest, parseRowsEvent } from '#/server/ingest/ingest-signals.ts'
import { getJson, putJson } from '#/server/kv.ts'

import type { DocsFailures, ModelFact, ModelInfo } from './types.ts'

export type ModelFacts = Pick<
  ModelInfo,
  | 'contextWindow'
  | 'maxOutput'
  | 'modalities'
  | 'capabilities'
  | 'pricing'
  | 'reasoning'
  | 'serverTools'
  | 'factSources'
>

export const NO_FACTS: ModelFacts = {
  contextWindow: null,
  maxOutput: null,
  modalities: null,
  capabilities: null,
  pricing: null,
}

/**
 * Snapshot ids fall back to their alias:
 * `gpt-5-2025-08-07` → `gpt-5`, `claude-opus-4-5-20251101` → `claude-opus-4-5`.
 */
export function undatedId(rawId: string): string {
  return rawId.replace(/-\d{4}-\d{2}-\d{2}$|-\d{8}$/, '')
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

/** `December 31, 2026` → that day's UTC midnight, case-insensitive. */
export function parseDay(text: string): number | null {
  const match = text
    .trim()
    .toLowerCase()
    .match(/^([a-z]+) (\d{1,2}), (\d{4})$/)
  const month = match?.[1] ? MONTHS.indexOf(match[1]) : -1
  if (!match || month < 0) return null
  return Date.UTC(Number(match[3]), month, Number(match[2]))
}

/** `1,048,576` / `500k` / `1M` → number. */
export function tokenCount(text: string | undefined): number | null {
  const match = text?.match(/([\d,]*\.?\d+)\s*([kKmM])?/)
  if (!match?.[1]) return null
  const base = Number(match[1].replace(/,/g, ''))
  const unit = match[2]?.toLowerCase()
  return Math.round(base * (unit === 'm' ? 1e6 : unit === 'k' ? 1e3 : 1))
}

/**
 * Every `| a | b |` row in a markdown document as trimmed cells, separator
 * rows dropped. Callers pick rows by content; header rows come along.
 */
export function markdownTableRows(text: string): Array<Array<string>> {
  const rows: Array<Array<string>> = []
  // A cell may hold a newline ("Portrait: 720x1280\nLandscape: 1280x720"),
  // splitting one row over two lines; join until the row closes, and give
  // up on a line that carries no cell of its own.
  let pending = ''
  for (const line of text.split('\n')) {
    if (pending === '') {
      if (!line.startsWith('|')) continue
      pending = line
    } else if (line.includes('|')) {
      pending = `${pending} ${line}`
    } else {
      pending = ''
      continue
    }
    if (!pending.endsWith('|')) continue
    const cells = pending
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim())
    pending = ''
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue
    rows.push(cells)
  }
  return rows
}

/** Text of one Markdoc table cell, its lines already de-indented. */
function markdocCell(lines: Array<string>): string {
  let out = ''
  for (const line of lines) {
    if (line.trim() === '') {
      // A paragraph break inside a cell reads as one space.
      if (out !== '' && !out.endsWith(' ') && !out.endsWith('<br>')) out += ' '
      continue
    }
    // Two trailing spaces, or a trailing backslash, are a hard line break:
    // one price per line.
    const hard = /( {2,}|\\+\s*)$/.test(line)
    const text = line.replace(/\s*\\+\s*$/, '').trim()
    out += `${out === '' || out.endsWith(' ') || out.endsWith('<br>') ? '' : ' '}${text}`
    if (hard) out += '<br>'
  }
  return (
    out
      .replace(/(?:<br>\s*)+$/, '')
      // Footnote markers are not part of the value.
      .replace(/\{%\s*sup\s*%\}[\s\S]*?\{%\s*\/sup\s*%\}/g, '')
      // `label=Supported (low, medium, high)` is the badge's whole text.
      .replace(/\{%\s*badge\s+label=("?)(.*?)\1\s+type="[^"]*"\s*\/%\}/g, '$2')
      .replace(/\{%\s*badge type="supported"\s*\/%\}/g, 'Supported')
      .replace(/\{%\s*badge type="not-supported"\s*\/%\}/g, 'Not supported')
      .replace(/\{%[\s\S]*?%\}/g, '')
      // `[**Name**](url)` reads as the `**[Name](url)**` older pages used.
      .replace(/\[\*\*([^\]*]+)\*\*\]\(([^)]*)\)/g, '**[$1]($2)**')
      .replace(/\|/g, '/')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/**
 * Rewrites every Markdoc `{% table %}` block (the aistudio.google.com docs
 * format) as `| a | b |` rows, one line per row, so `markdownTableRows` and
 * line-based parsers read it. Rows are split by `---`; a cell is a `* `
 * item at the row's own indent, and a deeper `* ` stays inside its cell.
 * A hard line break inside a cell becomes `<br>`. Everything outside the
 * tables is left as it is.
 */
export function markdocTables(text: string): string {
  return text.replace(
    /^[ \t]*\{%\s*table\b[^%]*%\}[ \t]*\n([\s\S]*?)^[ \t]*\{%\s*\/table\s*%\}[ \t]*$/gm,
    (_block, body: string) =>
      body
        .split(/^[ \t]*---[ \t]*$/m)
        .map((row) => {
          const lines = row.split('\n')
          const indent = lines.find((line) => /^\s*\* /.test(line))
          if (indent === undefined) return null
          const marker = indent.slice(0, indent.indexOf('*'))
          const cells: Array<Array<string>> = []
          for (const line of lines) {
            if (line.startsWith(`${marker}* `) || line === `${marker}*`) {
              cells.push([line.slice(marker.length + 1)])
            } else {
              cells.at(-1)?.push(line)
            }
          }
          return `| ${cells.map(markdocCell).join(' | ')} |`
        })
        .filter((row) => row !== null)
        .join('\n'),
  )
}

/**
 * One `## <heading>` section of a markdown document, up to the next `## `.
 * Empty when the heading is absent.
 */
export function markdownSection(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}`)
  if (start < 0) return ''
  const rest = text.slice(start + 1)
  const end = rest.indexOf('\n## ')
  return end < 0 ? rest : rest.slice(0, end)
}

/**
 * One page of a Mintlify `llms-full.txt`: each page opens with a `# <title>`
 * line followed by `Source: <url>`, and runs to the next such pair. Throws
 * unless exactly one page names `url`.
 */
export function llmsFullPage(text: string, url: string): string {
  const lines = text.split('\n')
  const opens = (index: number) =>
    lines[index]?.startsWith('# ') === true &&
    lines[index + 1]?.startsWith('Source: ') === true
  const starts = lines.flatMap((_line, index) =>
    opens(index) && lines[index + 1] === `Source: ${url}` ? [index] : [],
  )
  if (starts.length !== 1) {
    throw new Error(
      `llms-full.txt names ${url} ${String(starts.length)} times, not once`,
    )
  }
  const start = starts[0] ?? 0
  let end = start + 2
  while (end < lines.length && !opens(end)) end += 1
  return lines.slice(start, end).join('\n')
}

export const DOCS_TTL_SECONDS = 6 * 60 * 60

/**
 * Bumped whenever a parsed-docs shape changes. A deploy that changed the
 * shape would otherwise read the old one back out of KV for six hours and
 * see missing fields as missing facts.
 */
// v7: OpenAI model pages price the first token table and only the default
// snapshot. A v6 entry would keep o3's batch table and gpt-4o's old snapshot.
// v8: Grok model-page cache includes maxOutput (#119).
// v9: BytePlus and Mistral cached docs include serverTools. A v8 entry
// would keep the old card and leave tools null for six hours.
// v10: BytePlus image and video cards copy published alias ids. A v9 entry
// would leave those aliases unpriced for six hours.
// v11: Grok maxOutput (#119) lands after v10 shipped; a v10 entry has no
// maxOutput on Grok pages for six hours.
// v12: Azure rows gain `tabulated` and the price doc gains `thresholds`. A
// v11 entry written by the PR's preview build would drop every Azure row.
// v13: MiniMax M2 rows store no maxOutput (the spec maximum is the context
// window). A v12 entry would keep 204800 on them for six hours.
// v14: Gemini and Mistral model pages gain `modalities`. A v13 entry has
// none, and the schema walk that used to fill the field no longer does.
// v15: open fill-gaps PRs #242 and #244. Do not reuse.
// v16: Mistral model pages gain maxOutput and page pricing, and the pricing
// doc stores the table without those pages. A v14 entry would keep Large 4's
// sale row skipped and leave the new fields null for six hours.
// v21: Azure rows gain effort lists, request maps, and the gpt-4 /
// computer-use-preview meter match. A v16 entry would leave those null
// for six hours.
// v22: DashScope compat cache includes `scope`. A v21 entry has no scope,
// so a chat id the page does not name would still get the compat map.
// v23: Gemini's cached index is `{url, ids}` rows, thinking pages cache
// budget bodies, and model pages cache per-id sections. Thinking-level
// `mandatory` is true only when the page says that family cannot turn
// thinking off. A v22 entry has none of that, so Gemini facts read from
// it would stay null or mark every level column mandatory.
// v24: Cerebras model pages include paid maxOutput. A v23 entry has no
// maxOutput and would leave it null for six hours.
// v25: Bedrock cards gain request maps, feature flags, and price-list
// rates. A v24 entry would leave those null for six hours.
// v26: Together reasoning pages and the serverless chat catalog cache
// plain records. A v25 entry stored Maps, which JSON reads back as {},
// and the next poll throws before any together row is written.
// v27: native reasoning controls now distinguish published levels, mandatory
// status and genuine source silence. Re-read cached parsed facts so earlier
// guesses cannot survive the new parsers until the six-hour TTL expires.
// v28: re-read native budget applicability and replay declarations after the
// scoped guide enrichments and stricter normative-prose checks.
// v30: DashScope China priced rows no longer carry absent.pricing 'cleared'.
// A v29 entry would keep dropping every CNY card for six hours.
// v31: the Gemini pricing entry gained `named`; a v30 entry has none.
// v32: OpenAI "only supports" a non-none effort is mandatory true. A v31
// model-page entry would keep gpt-5-pro at mandatory null for six hours.
// v33: Vertex Claude card titles drop a leading "Anthropic's" (#390). A v32
// entry keeps every row unpriced, so the poll refuses the clear for six hours.
// v34: OpenAI pages add `file` input from `file_uploads` and Mistral pages from
// `document-qna` (#407). A v33 entry would keep them without it for six hours.
// v35: Mistral pages cache their Features (and the web search guide is read);
// Gemini caches probed pages; Perplexity caches stated limits
// (#408, #409). A v34 entry has none of them for six hours.
// v36: Mistral OCR cells take the unit from their "Prices /1000 Pages"
// header (#439). A v35 entry would keep OCR rows unpriced for six hours.
// v37: DeepSeek cards store off-peak and peak behind pricing_period (#449).
// A v36 entry would keep serving the off-peak rate alone for six hours.
// v38: Anthropic Haiku 5.5 stores the over-100k prompt tier (#481). A v37
// entry is the short rate alone and would underprice long prompts for six
// hours.
// v39: Deepgram rates are keyed by the pricing page's OfferCatalog product
// names (#528). A v38 entry's old keys would leave every row unpriced.
// v41: A Mistral model the pricing table dropped keeps the price its
// markdown page states (#543). A v40 page entry has no markdown price
// and would log pricing_lost until the TTL.
const DOCS_CACHE_VERSION = 'v41'

/** Fresh-window key for one parsed docs page. Shared with the stale copy. */
export function docsCacheKey(url: string): string {
  return `docs:${DOCS_CACHE_VERSION}:${url}`
}

/**
 * KV cache for parsed docs, keyed by source URL. A failed load is not
 * stored, so the next poll retries. `kv` is omitted in unit tests that
 * never hit the network.
 */
export async function cachedDocs<T>(
  kv: KVNamespace | undefined,
  url: string,
  load: () => Promise<T>,
): Promise<T> {
  const key = docsCacheKey(url)
  if (kv) {
    const hit = await getJson<T>(kv, key)
    if (hit !== null) return hit
  }
  const value = await load()
  if (kv) {
    await putJson(kv, key, value, { expirationTtl: DOCS_TTL_SECONDS })
  }
  return value
}

/**
 * Once one provider's failed docs loads have cost this much wall-clock time
 * in a poll, nothing more is fetched for it: a docs host that is down would
 * otherwise spend a timeout per document and stall every provider polled
 * after it. Loads that overlap count once, so eight concurrent failures of
 * 2.5 s cost 2.5 s. A host that hangs still costs one full round of its
 * timeout (60 s for an NVIDIA card) before this can trip. A few pages that
 * fail fast never reach it, so they do not stop the healthy ones loading.
 */
const DOCS_FAILURE_BUDGET_MS = 15_000

/** Failures kept in full per provider per poll; the rest are only counted. */
const DOCS_FAILURES_KEPT = 5

/** One provider's docs loads in one poll. Make it with `docsRun()`. */
export interface DocsRun extends DocsFailures {
  /** Wall-clock time lost to failed loads so far. */
  lostMs: number
  /** When the latest failed load ended; where the next one's cost starts. */
  lostUntil: number
}

export function docsRun(): DocsRun {
  return { failed: 0, skipped: 0, first: [], lostMs: 0, lostUntil: 0 }
}

/** `ListModelsResult.docsFailures` for a finished run. */
export function docsReport(run: DocsRun): DocsFailures {
  return { failed: run.failed, skipped: run.skipped, first: run.first }
}

class DocsSkipped extends Error {}

/** `cachedDocs` that serves a KV hit and refuses to fetch. */
const cachedOnly: typeof cachedDocs = (kv, url) =>
  cachedDocs(kv, url, () => Promise.reject(new DocsSkipped()))

/**
 * Load and parse one docs source for `listModels`. A throw is counted in
 * `run` and returns null, so the listing and the other sources still poll.
 * The caller gives the rows that source feeds `unavailable(...)` and
 * returns `docsReport(run)` as `docsFailures`. Parsers stay strict: they
 * throw, and only this catches. Never wrap the listing itself.
 *
 * `load` must fetch through the `cached` it is handed: once the failure
 * budget is spent that one serves KV hits only, and a miss is counted as
 * skipped rather than fetched.
 */
export async function tryDocs<T>(
  run: DocsRun,
  source: string,
  load: (cached: typeof cachedDocs) => Promise<T>,
): Promise<T | null> {
  const started = Date.now()
  try {
    return await load(
      run.lostMs >= DOCS_FAILURE_BUDGET_MS ? cachedOnly : cachedDocs,
    )
  } catch (error) {
    if (error instanceof DocsSkipped) {
      run.skipped++
      return null
    }
    const ended = Date.now()
    run.lostMs += Math.max(0, ended - Math.max(started, run.lostUntil))
    run.lostUntil = Math.max(run.lostUntil, ended)
    run.failed++
    if (run.first.length < DOCS_FAILURES_KEPT) {
      run.first.push({
        source,
        error: errorMessage(error),
        elapsedMs: ended - started,
      })
    }
    return null
  }
}

/** Row patch: the source of these facts failed, keep what is stored. */
export function unavailable(
  ...facts: Array<ModelFact>
): Pick<ModelInfo, 'absent'> {
  return {
    absent: Object.fromEntries(facts.map((fact) => [fact, 'unavailable'])),
  }
}

/**
 * Throw when a docs parse comes back empty — never silently null a catalog.
 * A non-empty parse records one `parse_rows` event (`source`, `rows`).
 * Cache hits do not emit, so the daily event count swings with the six-hour
 * TTL and with deploys. The drop alert counts distinct `source` values on a
 * finished UTC day and fires when that set shrinks. The zero-row throw is
 * `ingest_failed` at the job boundary.
 */
export function assertParsed<T>(rows: Map<string, T>, source: string): void {
  if (rows.size === 0) throw new Error(`${source}: parsed 0 model rows`)
  noteIngest(parseRowsEvent(source, rows.size))
}

/** Bounded-concurrency map, order preserved. */
export async function mapConcurrent<T, TResult>(
  items: Array<T>,
  limit: number,
  fn: (item: T) => Promise<TResult>,
): Promise<Array<TResult>> {
  const results: Array<TResult> = Array.from({ length: items.length })
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      const item = items[index]
      if (item === undefined) continue
      results[index] = await fn(item)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  )
  return results
}
