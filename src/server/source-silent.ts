/**
 * The source-silent ledger (`docs/source-silent/<provider>.md`), bundled at
 * build time so the Worker scores completeness with the same files
 * `pnpm run gap:report` reads from disk. Vite and vitest transform
 * `import.meta.glob`; Node does not, so the script reads them with `fs`.
 */
import { parseLedger } from '#/lib/completeness.ts'
import { parseSourceSilentEvidence } from './source-silent-facts.ts'

const files = import.meta.glob<string>(
  ['../../docs/source-silent/*.md', '!**/README.md'],
  { query: '?raw', import: 'default', eager: true },
)

const markdown = Object.values(files).join('\n')

export const sourceSilentLedger = parseLedger(markdown)
export const sourceSilentEvidenceLedger = parseSourceSilentEvidence(markdown)
