#!/usr/bin/env node
/**
 * Public git mirror of the catalog (issue #343). Fetches
 * `GET /v1/admin/export`, writes one file per entity into a data repo
 * checkout, and prints the commit message on stdout:
 *
 *   providers/<provider>.json
 *   models/<provider>/<modelId>.json
 *   schemas/<provider>/<endpointId>.json
 *   feed.json   the export's latestChange, plus the /v1/changes ids
 *               already listed in a commit message
 *
 * The export already leaves out per-poll fields and sorts keys; files here
 * are pretty-printed with a trailing newline, so the same export always
 * writes the same bytes. The three entity folders are rewritten from
 * scratch, so a removed entity shows up as a deleted file.
 *
 * The message lists every /v1/changes id no earlier commit listed. A
 * change's createdAt is when its poll STARTED and ids are random, so a
 * (createdAt, id) cursor would skip rows a running poll inserts later.
 * Instead each run re-reads the feed from LOOKBACK_SECONDS before the
 * newest createdAt seen and drops ids already listed. The export is not
 * one snapshot either: files can hold a change a later commit lists.
 * Admin-keyed requests skip the rate limit, so paging the feed is free.
 *
 * Before touching the tree it refuses an export that would delete most of
 * the mirror (a fresh or wrong D1 still answers 200) unless
 * MIRROR_ALLOW_SHRINK=1, and a latestChange that is gone or moved
 * backwards (provider rows cascade-delete their changes): delete feed.json
 * by hand to re-seed from that export.
 *
 * Self-contained (no repo imports): the data repo's workflow runs it from a
 * sparse checkout of this file (scripts/mirror/catalog-mirror.yml).
 *
 *   MODELSCHEMAS_ADMIN_KEY=… node scripts/mirror-catalog.ts <data-repo-dir>
 *   MODELSCHEMAS_URL defaults to https://modelschemas.openstory.workers.dev
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface ChangeRef {
  id: string
  createdAt: number
}

export interface FeedChange extends ChangeRef {
  type: string
  summary: string
}

interface ExportBody {
  latestChange: ChangeRef | null
  providers: Array<{ id: string }>
  models: Array<{ id: string; provider: string }>
  schemas: Array<{ provider: string; endpointId: string }>
}

/** What the mirror has listed so far (feed.json). */
export interface FeedState {
  latestChange: ChangeRef | null
  /** Newest createdAt any listed change had. */
  highWater: number | null
  /** Listed changes with createdAt within LOOKBACK_SECONDS of highWater. */
  listed: Array<ChangeRef>
}

export const ENTITY_DIRS = ['providers', 'models', 'schemas'] as const
export const FEED_FILE = 'feed.json'
/**
 * ponytail: a poll that inserts changes more than an hour after it starts
 * would have rows missed; Workers cron invocations end well before that.
 */
export const LOOKBACK_SECONDS = 3600

function fail(message: string): never {
  throw new Error(`mirror: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function changeRef(value: unknown, what: string): ChangeRef | null {
  if (value === null) return null
  if (
    isRecord(value) &&
    typeof value.id === 'string' &&
    Number.isInteger(value.createdAt)
  ) {
    return { id: value.id, createdAt: value.createdAt as number }
  }
  return fail(`${what} is not null or { id, createdAt }`)
}

function rows<T>(value: unknown, keys: Array<string>, what: string): Array<T> {
  if (!Array.isArray(value)) fail(`${what} is not an array`)
  for (const item of value) {
    if (!isRecord(item) || keys.some((key) => typeof item[key] !== 'string')) {
      fail(`${what} row lacks string ${keys.join(', ')}`)
    }
  }
  return value as Array<T>
}

/** The export body, checked: a cast would commit a wrong shape. */
export function parseExport(value: unknown): ExportBody {
  if (!isRecord(value) || !('latestChange' in value)) {
    fail('export body has no latestChange')
  }
  const providers = rows<{ id: string }>(
    value.providers,
    ['id'],
    'export providers',
  )
  if (providers.length === 0) fail('export has no providers')
  return {
    latestChange: changeRef(value.latestChange, 'export latestChange'),
    providers,
    models: rows(value.models, ['id', 'provider'], 'export models'),
    schemas: rows(value.schemas, ['provider', 'endpointId'], 'export schemas'),
  }
}

function parseFeedPage(value: unknown) {
  if (
    !isRecord(value) ||
    !(value.nextCursor === null || typeof value.nextCursor === 'string')
  ) {
    fail('/v1/changes page lacks nextCursor')
  }
  const changes = rows<FeedChange>(
    value.changes,
    ['id', 'type', 'summary'],
    '/v1/changes',
  )
  for (const change of changes) changeRef(change, '/v1/changes row')
  return { changes, nextCursor: value.nextCursor }
}

export function parseFeedState(text: string | null): FeedState {
  if (text === null) return { latestChange: null, highWater: null, listed: [] }
  const value: unknown = JSON.parse(text)
  if (
    !isRecord(value) ||
    !(value.highWater === null || Number.isInteger(value.highWater)) ||
    !Array.isArray(value.listed)
  ) {
    fail(`${FEED_FILE} lacks highWater or listed`)
  }
  return {
    latestChange: changeRef(value.latestChange, `${FEED_FILE} latestChange`),
    highWater: value.highWater as number | null,
    listed: value.listed.map(
      (ref: unknown) =>
        changeRef(ref, `${FEED_FILE} listed row`) ??
        fail(`${FEED_FILE} listed row is null`),
    ),
  }
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Ids become path segments; refuse anything that could leave its folder. */
function safeSegments(id: string): string {
  const parts = id.split('/')
  if (
    id === '' ||
    id.includes('\\') ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail(`unsafe id for a file path: ${JSON.stringify(id)}`)
  }
  return id
}

/** Every entity file (path → contents) for one export body. */
export function mirrorFiles(body: ExportBody): Map<string, string> {
  const files = new Map<string, string>()
  const add = (path: string, value: unknown) => {
    if (files.has(path)) fail(`two entities write ${path}`)
    files.set(path, pretty(value))
  }
  for (const provider of body.providers) {
    add(`providers/${safeSegments(provider.id)}.json`, provider)
  }
  for (const model of body.models) {
    add(
      `models/${safeSegments(model.provider)}/${safeSegments(model.id)}.json`,
      model,
    )
  }
  for (const schema of body.schemas) {
    add(
      `schemas/${safeSegments(schema.provider)}/${safeSegments(schema.endpointId)}.json`,
      schema,
    )
  }
  return files
}

/** Feed order: newest first by createdAt, then id. */
function after(a: ChangeRef, b: ChangeRef): boolean {
  return (
    a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id)
  )
}

/**
 * Refuse a run that would rewrite history: the latest change gone or moved
 * backwards, or under half of today's entity files left.
 */
export function refuseRun(
  previous: ChangeRef | null,
  latest: ChangeRef | null,
  existingFiles: number,
  newFiles: number,
  allowShrink: boolean,
) {
  const reseed = `delete ${FEED_FILE} to re-seed from this export`
  if (previous && !latest) {
    fail(
      `export has no latestChange but the mirror is at ${previous.id}; ${reseed}`,
    )
  }
  if (previous && latest && after(previous, latest)) {
    fail(
      `latestChange moved backwards from ${previous.id} to ${latest.id}; ${reseed}`,
    )
  }
  if (!allowShrink && newFiles < existingFiles / 2) {
    fail(
      `export has ${newFiles} entity files, the mirror ${existingFiles}; rerun with MIRROR_ALLOW_SHRINK=1 if that is real`,
    )
  }
}

/**
 * Changes from the feed window that no earlier commit listed, and the
 * state to store. `window` is every row with createdAt >= the previous
 * highWater minus LOOKBACK_SECONDS.
 */
export function newChanges(
  state: FeedState,
  window: Array<FeedChange>,
  latestChange: ChangeRef | null,
): { listed: Array<FeedChange>; state: FeedState } {
  const seen = new Set(state.listed.map((ref) => ref.id))
  const listed = window.filter((change) => !seen.has(change.id))
  const highWater = Math.max(
    state.highWater ?? -Infinity,
    ...window.map((change) => change.createdAt),
  )
  // Listed refs drop out once they fall behind the next run's window.
  const keep = [...state.listed, ...listed]
    .filter((ref) => ref.createdAt >= highWater - LOOKBACK_SECONDS)
    .map(({ id, createdAt }) => ({ id, createdAt }))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
  return {
    listed,
    state: {
      latestChange,
      highWater: Number.isFinite(highWater) ? highWater : null,
      listed: keep,
    },
  }
}

export function commitMessage(
  seeded: boolean,
  latest: ChangeRef | null,
  listed: Array<FeedChange>,
): string {
  if (seeded) {
    return latest === null
      ? 'Catalog snapshot (no changes recorded yet)\n'
      : `Catalog snapshot up to change ${latest.id}\n`
  }
  if (listed.length === 0) return 'Catalog refresh (no new /v1/changes)\n'
  const lines = listed.map((c) => `- ${c.id} ${c.type}: ${c.summary}`)
  return `Catalog: ${listed.length} change${listed.length === 1 ? '' : 's'}\n\n/v1/changes ids recorded since the last mirror commit:\n${lines.join('\n')}\n`
}

async function readOptional(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

async function countEntityFiles(dir: string): Promise<number> {
  let count = 0
  for (const entity of ENTITY_DIRS) {
    const names = await readdir(join(dir, entity), { recursive: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      },
    )
    count += names.filter((name) => name.endsWith('.json')).length
  }
  return count
}

async function main() {
  const [dir] = process.argv.slice(2)
  const adminKey = process.env.MODELSCHEMAS_ADMIN_KEY
  if (!dir || !adminKey) {
    fail(
      'usage: MODELSCHEMAS_ADMIN_KEY=… node scripts/mirror-catalog.ts <data-repo-dir>',
    )
  }
  const base =
    process.env.MODELSCHEMAS_URL ?? 'https://modelschemas.openstory.workers.dev'
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(new URL(path, base), {
      headers: { 'X-Admin-Key': adminKey },
    })
    if (!response.ok) {
      fail(`GET ${path}: ${response.status} ${await response.text()}`)
    }
    // A stream error mid-body makes this throw, so a cut body writes nothing.
    return response.json()
  }

  const stateText = await readOptional(join(dir, FEED_FILE))
  const state = parseFeedState(stateText)

  const body = parseExport(await get('/v1/admin/export'))
  const files = mirrorFiles(body)
  refuseRun(
    state.latestChange,
    body.latestChange,
    await countEntityFiles(dir),
    files.size,
    process.env.MIRROR_ALLOW_SHRINK === '1',
  )

  // Read the feed before touching the tree: a failure leaves it as it was.
  // A first run lists nothing and starts the window at the newest change.
  const since =
    state.highWater === null
      ? (body.latestChange?.createdAt ?? null)
      : state.highWater - LOOKBACK_SECONDS
  const window: Array<FeedChange> = []
  if (since !== null) {
    let next: string | null = `/v1/changes?since=${since}&limit=200`
    while (next) {
      const page = parseFeedPage(await get(next))
      window.push(...page.changes)
      next = page.nextCursor
        ? `/v1/changes?since=${since}&limit=200&cursor=${encodeURIComponent(page.nextCursor)}`
        : null
    }
  }
  const seeded = stateText === null
  const result = newChanges(state, window, body.latestChange)

  for (const entity of ENTITY_DIRS) {
    await rm(join(dir, entity), { recursive: true, force: true })
  }
  for (const [path, contents] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), contents)
  }
  await writeFile(join(dir, FEED_FILE), pretty(result.state))
  process.stdout.write(commitMessage(seeded, body.latestChange, result.listed))
}

if (import.meta.main) await main()
