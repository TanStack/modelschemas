// Re-run one provider's probe records. Not for CI: it spends a key and
// calls the provider. Never prints the key.
//
//   pnpm run probe -- <provider> [--write]
//
// `--write` sets `verifiedAt` to today on records that still match.
// A mismatch exits 1 and leaves the file alone.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

import {
  bumpVerifiedAt,
  observationMatches,
} from '../src/server/providers/probes/compare.ts'
import {
  probeRecords,
  probesFor,
} from '../src/server/providers/probes/index.ts'
import { OPENCODE_GO_PROBE_SOURCE } from '../src/server/providers/probes/opencode-go.ts'
import type { ProbeRecord } from '../src/server/providers/probes/types.ts'

const KEY_ENV = 'OPENCODE_GO_API_KEY'
const FILES: Record<string, string> = {
  'opencode-go': OPENCODE_GO_PROBE_SOURCE,
}
const ORIGIN: Record<string, string> = {
  'opencode-go': 'https://opencode.ai',
}

const providerId = process.argv[2]
const write = process.argv.includes('--write')
const known = [...new Set(probeRecords.map((record) => record.provider))]
if (!providerId || !known.includes(providerId) || providerId.startsWith('-')) {
  console.error(
    `usage: pnpm run probe -- <provider> [--write]\nproviders: ${known.join(', ')}`,
  )
  process.exit(1)
}

const records = probesFor(providerId)
const apiKey = readKey()
const today = new Date().toISOString().slice(0, 10)
const mismatches: Array<string> = []
for (const record of records) {
  const mismatch = await runRecord(record, apiKey)
  if (mismatch) mismatches.push(`${record.id}: ${mismatch}`)
  else console.log(`${record.id}: match`)
}
if (mismatches.length > 0) {
  for (const line of mismatches) console.error(line)
  process.exit(1)
}
if (write) {
  const file = FILES[providerId]
  if (!file) throw new Error(`probe: ${providerId} has no source file`)
  const next = records.reduce(
    (source, record) => bumpVerifiedAt(source, record.id, today),
    readFileSync(file, 'utf8'),
  )
  writeFileSync(file, next)
  console.log(`wrote verifiedAt ${today} in ${file}`)
}

function readKey(): string {
  const fromEnv = process.env[KEY_ENV]?.trim()
  if (fromEnv) return fromEnv
  const result = spawnSync(
    'doppler',
    [
      'secrets',
      'get',
      KEY_ENV,
      '--project',
      'modelschemas',
      '--config',
      'dev',
      '--plain',
    ],
    { encoding: 'utf8' },
  )
  const value = result.stdout.trim()
  if (result.status !== 0 || value.length === 0) {
    console.error(
      `${KEY_ENV} is missing from the environment and from Doppler dev.`,
    )
    const detail = result.stderr.trim()
    if (detail) console.error(detail)
    process.exit(1)
  }
  return value
}

function headersFor(
  record: ProbeRecord,
  secret: string,
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(record.request.headers)) {
    headers[name] = value.replaceAll(`$${KEY_ENV}`, secret)
  }
  return headers
}

async function runRecord(
  record: ProbeRecord,
  secret: string,
): Promise<string | null> {
  const origin = ORIGIN[record.provider]
  if (!origin) return `${record.provider} has no probe origin`
  const response = await fetch(`${origin}${record.request.path}`, {
    method: record.request.method,
    headers: headersFor(record, secret),
    body: JSON.stringify(record.request.body),
  })
  const text = await response.text()
  const payloads = record.expect.sse ? ssePayloads(text) : [parseJson(text)]
  return observationMatches(record.expect, {
    status: response.status,
    payloads: payloads.filter((payload) => payload !== undefined),
  })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function ssePayloads(text: string): Array<unknown> {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => parseJson(line.slice('data:'.length).trim()))
    .filter((payload) => payload !== undefined)
}
