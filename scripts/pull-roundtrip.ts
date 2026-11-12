#!/usr/bin/env node
/**
 * E2E roundtrip for Phase 12 (PLAN.md task 12.6): against a live service
 * (default the local dev server), prove the full build-time pull flow —
 * pull a real selection, prove the second pull is a pure 304 no-op, then
 * stale the manifest entry
 * and prove `update` (a full pull) rewrites exactly that file.
 *
 *   pnpm run pull-roundtrip [baseUrl]
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MANIFEST_FILENAME, pull, readManifest } from '@modelschemas/codegen'

const baseUrl = process.argv[2] ?? 'http://localhost:3100'
const SELECTION = 'anthropic/v1/messages#request'
const KEY = 'anthropic/chat/v1/messages#request'

function check(condition: boolean, label: string): void {
  if (!condition) {
    console.error(`FAIL ${label}`)
    process.exit(1)
  }
  console.log(`ok   ${label}`)
}

const outDir = await mkdtemp(join(tmpdir(), 'modelschemas-roundtrip-'))
try {
  const config = { baseUrl, outDir, selections: [SELECTION] }

  const first = await pull(config)
  check(
    first.written.length === 1 && first.failed.length === 0,
    `pull ${SELECTION} from ${baseUrl}`,
  )

  const manifest = await readManifest(outDir)
  const entry = manifest?.entries[KEY]
  check(entry !== undefined, 'manifest entry recorded')
  if (entry === undefined || manifest === null) process.exit(1)

  const module_ = await readFile(join(outDir, entry.path), 'utf8')
  check(
    !/^import /m.test(module_) && /^export const /m.test(module_),
    'generated module is pure (no imports, const + types only)',
  )

  const second = await pull(config)
  check(
    second.written.length === 0 && second.unchanged.includes(KEY),
    'second pull is a conditional no-op (304)',
  )

  // Stale the lockfile entry → update must rewrite exactly that file.
  entry.etag = '"stale"'
  entry.contentHash = '0'.repeat(64)
  await writeManifestRaw()
  const third = await pull(config)
  check(
    third.written.length === 1 && third.written[0] === KEY,
    'update rewrites exactly the staled file',
  )
  const refreshed = await readManifest(outDir)
  check(
    refreshed?.entries[KEY]?.contentHash !== '0'.repeat(64),
    'manifest re-records the live content hash',
  )

  console.log('PASS pull-roundtrip')

  async function writeManifestRaw(): Promise<void> {
    await writeFile(
      join(outDir, MANIFEST_FILENAME),
      JSON.stringify(manifest, null, 2),
      'utf8',
    )
  }
} finally {
  await rm(outDir, { recursive: true, force: true })
}
