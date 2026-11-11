/**
 * Reconcile production Worker secrets against a Doppler config.
 *
 * Runs entirely on a trusted machine using credentials that are already
 * there — your Doppler CLI login and your wrangler login. Nothing new is
 * stored anywhere, no token is added to CI, and the blast radius stays
 * exactly what it is today: this laptop. That is the whole reason to prefer
 * it over a CI job, which would need a long-lived Doppler service token AND a
 * Cloudflare API token sitting in GitHub.
 *
 * Handling rules, because a careless version of this script is how secrets
 * leak:
 * - Values are held in memory only. Never written to disk, never passed as
 *   argv (visible in `ps`), never echoed. They reach wrangler over stdin.
 * - Doppler is the source of truth. Everything in the config is pushed
 *   except the remove list (`DOPPLER_*` context vars, plus
 *   `BETTER_AUTH_URL` which is already a wrangler `vars` binding, and
 *   `VITE_*` build-time variables). Use `pnpm run secrets:build` to build
 *   with public configuration from Doppler.
 *   `DOPPLER_*` are not application secrets; pushing them is how the
 *   deployed Worker ended up with three junk bindings.
 * - Nothing is ever deleted. `wrangler secret bulk` can delete via null, but
 *   this script never emits one — removing a secret stays a deliberate
 *   manual act.
 * - Dry run unless `--push` is passed.
 *
 * Secrets are written into a new Worker version rather than the live one;
 * the next deploy inherits them. See the push call at the bottom for why.
 *
 * Usage:
 *   pnpm run secrets:check                      # reconcile + report
 *   pnpm run secrets:push                       # apply
 *   pnpm run secrets:check -- --config stg      # non-prod target
 */
import { packageBin } from './package-bin.ts'
import {
  PUSH_REMOVE_LIST,
  dopplerSecrets,
  isRemoved,
  parseConfigFlag,
  run,
  withoutRemoved,
} from './secrets.ts'

const push = process.argv.includes('--push')
const dopplerConfig = parseConfigFlag(process.argv.slice(2), 'prd')

/** Secret names currently bound to the deployed Worker (names only). */
const wrangler = packageBin('wrangler')

function workerSecretNames(): Set<string> {
  const raw = run(process.execPath, [wrangler, 'secret', 'list'])
  const parsed = JSON.parse(raw) as Array<{ name: string }>
  return new Set(parsed.map((s) => s.name))
}

const rawDoppler = dopplerSecrets(dopplerConfig)
const payload = withoutRemoved(rawDoppler, PUSH_REMOVE_LIST)
const onWorker = workerSecretNames()

const rows: Array<[string, string]> = []
for (const name of Object.keys(payload).sort()) {
  rows.push([name, onWorker.has(name) ? 'update' : 'CREATE'])
}

const width = rows.length > 0 ? Math.max(...rows.map(([n]) => n.length)) : 0
console.log(
  `\nDoppler config: ${dopplerConfig}   Worker: modelschemas   mode: ${
    push ? 'PUSH' : 'dry run'
  }\n`,
)
for (const [name, action] of rows) {
  console.log(`  ${name.padEnd(width)}  ${action}`)
}

const dropped = Object.keys(rawDoppler)
  .filter((name) => isRemoved(name, PUSH_REMOVE_LIST))
  .sort()
if (dropped.length > 0) {
  console.log(`\n  remove list, skipped: ${dropped.join(', ')}`)
}
if (dropped.some((name) => name.startsWith('VITE_'))) {
  console.log(
    '  VITE_* values are build-time configuration, not Worker secrets.' +
      '\n  Build with pnpm run secrets:build, or configure Workers Builds variables.',
  )
}

const workerOnly = [...onWorker].filter((name) => !(name in payload)).sort()
const workerRemoved = workerOnly.filter((name) =>
  isRemoved(name, PUSH_REMOVE_LIST),
)
const workerMissing = workerOnly.filter(
  (name) => !isRemoved(name, PUSH_REMOVE_LIST),
)
if (workerRemoved.length > 0) {
  console.log(
    `  on Worker, in the remove list (not deleted): ${workerRemoved.join(', ')}`,
  )
}
if (workerMissing.length > 0) {
  console.log(
    `\n  ${workerMissing.length} secret(s) live on the Worker but not in Doppler,` +
      ` so they will be left untouched:\n    ${workerMissing.join(', ')}` +
      `\n  Add them to the '${dopplerConfig}' config before relying on this script.`,
  )
}

const count = Object.keys(payload).length
if (!push) {
  console.log(
    `\nDry run — nothing sent. ${count} secret(s) would be written.` +
      ` Re-run with --push to apply.\n`,
  )
  process.exit(0)
}
if (count === 0) {
  console.log('\nNothing to push.\n')
  process.exit(0)
}

/**
 * One API call, over stdin: no temp file, nothing in argv, nothing in shell
 * history. Deletions are impossible here because no key is ever set to null.
 *
 * `wrangler versions secret bulk` rather than the plain `wrangler secret
 * bulk`, which edits the live Worker and refuses with Cloudflare error 10215
 * whenever the newest uploaded version is not the deployed one — the normal
 * state here, since Workers Builds uploads a preview version on every
 * non-production branch push. The versions API has no such precondition, so
 * this always works.
 *
 * It writes the secrets into a NEW version instead of the live one, and
 * that is enough: a version inherits its bindings from the previous one, so
 * the next deploy carries these secrets forward automatically (verified on
 * this Worker — CI-uploaded versions list every secret despite CI never
 * seeing a value). Only the bindings inherit, not the code, so staging from
 * a branch cannot leak unmerged code into a later deploy.
 */
run(
  process.execPath,
  [wrangler, 'versions', 'secret', 'bulk'],
  JSON.stringify(payload),
)
console.log(
  `\nWrote ${count} secret(s) into a new version.` +
    `\nThey go live with the next deploy, which inherits them.\n`,
)
