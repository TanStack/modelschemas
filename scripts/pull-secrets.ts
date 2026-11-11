/**
 * Pull a Doppler config into `.env.local` for local dev.
 *
 * Same remove list as push-secrets: everything in the config is written
 * except `DOPPLER_*` context vars. Existing local-only keys that Doppler
 * does not define are kept; removed names already in the file are dropped.
 *
 * Values are never printed. Dry run unless `--write` is passed.
 *
 * Usage:
 *   pnpm run secrets:pull                 # report
 *   pnpm run secrets:pull --write         # write .env.local
 *   pnpm run secrets:pull --config stg    # non-dev source
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

import {
  dopplerSecrets,
  formatEnvFile,
  isRemoved,
  parseConfigFlag,
  parseEnvFile,
  withoutRemoved,
} from './secrets.ts'

const dest = '.env.local'
const write = process.argv.includes('--write')
const dopplerConfig = parseConfigFlag(process.argv.slice(2), 'dev')

const fromDoppler = withoutRemoved(dopplerSecrets(dopplerConfig))
const existing = existsSync(dest)
  ? parseEnvFile(readFileSync(dest, 'utf8'))
  : {}

const droppedFromFile = Object.keys(existing)
  .filter((name) => isRemoved(name))
  .sort()
const localOnly: Record<string, string> = {}
for (const [name, value] of Object.entries(existing)) {
  if (!isRemoved(name) && !(name in fromDoppler)) localOnly[name] = value
}
const next = { ...localOnly, ...fromDoppler }

const names = [...new Set([...Object.keys(existing), ...Object.keys(next)])]
  .filter((name) => !isRemoved(name))
  .sort()
const rows: Array<[string, string]> = []
for (const name of names) {
  const was = name in existing && !isRemoved(name)
  const will = name in fromDoppler
  if (will && was) rows.push([name, 'update'])
  else if (will) rows.push([name, 'CREATE'])
  else rows.push([name, 'keep (local only)'])
}

const width = rows.length > 0 ? Math.max(...rows.map(([n]) => n.length)) : 0
console.log(
  `\nDoppler config: ${dopplerConfig}   dest: ${dest}   mode: ${
    write ? 'WRITE' : 'dry run'
  }\n`,
)
for (const [name, action] of rows) {
  console.log(`  ${name.padEnd(width)}  ${action}`)
}
if (droppedFromFile.length > 0) {
  console.log(
    `\n  dropped from ${dest} (remove list): ${droppedFromFile.join(', ')}`,
  )
}

const count = Object.keys(fromDoppler).length
if (!write) {
  console.log(
    `\nDry run — ${dest} untouched. ${count} secret(s) would be written` +
      ` from Doppler.` +
      ` Re-run with --write to apply.\n`,
  )
  process.exit(0)
}

writeFileSync(
  dest,
  formatEnvFile(next, [
    `Written by pnpm run secrets:pull from Doppler config \`${dopplerConfig}\`.`,
    'DOPPLER_* is stripped. Local-only keys not in Doppler are kept.',
  ]),
  { encoding: 'utf8' },
)
chmodSync(dest, 0o600)
console.log(`\nWrote ${Object.keys(next).length} key(s) to ${dest}.\n`)
