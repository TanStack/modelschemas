/** Build with public configuration from Doppler; never write values to disk. */
import { spawnSync } from 'node:child_process'

import { dopplerSecrets, parseConfigFlag, publicBuildEnv } from './secrets.ts'

const config = parseConfigFlag(process.argv.slice(2), 'prd')
const buildEnv = publicBuildEnv(dopplerSecrets(config))
for (const name of [
  'VITE_PUBLIC_POSTHOG_PROJECT_TOKEN',
  'VITE_PUBLIC_POSTHOG_HOST',
]) {
  if (!buildEnv[name]) {
    throw new Error(`${name} is missing from Doppler config ${config}`)
  }
}

console.log(`Building with public configuration from Doppler ${config}`)
const result = spawnSync('pnpm', ['run', 'build'], {
  env: { ...process.env, ...buildEnv },
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
