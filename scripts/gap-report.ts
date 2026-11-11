/**
 * Gap report: which facts `@tanstack/ai-models` needs are still missing,
 * per provider, over chat rows. One HTTP request; no per-model detail calls.
 *
 *   pnpm run gap:report                       # JSON
 *   pnpm run gap:report -- --table            # readable, worst score first
 *   pnpm run gap:report -- --base http://localhost:3100
 *   pnpm run gap:report -- --check --providers grok,mistral --target 0.9
 *
 * `docs/source-silent/<provider>.md` lists facts a provider does not publish; those
 * are left out of that provider's score and listed under `silent`. `flags`
 * lists rows whose stored shape is wrong; flags do not change the score.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import {
  FACT_KEYS,
  FLAG_KEYS,
  buildReport,
  parseLedger,
} from '../src/lib/completeness.ts'
import type { GapReport, Ledger, ModelRow } from '../src/lib/completeness.ts'

// The scoring itself is shared with `GET /v1/status`.
export * from '../src/lib/completeness.ts'

const LEDGER_DIR = join(import.meta.dirname, '..', 'docs', 'source-silent')

/** The on-disk ledger; the Worker bundles the same files (`source-silent.ts`). */
export function readLedger(dir = LEDGER_DIR): Ledger | undefined {
  if (!existsSync(dir)) return undefined
  return parseLedger(
    readdirSync(dir)
      .filter((file) => file.endsWith('.md') && file !== 'README.md')
      .map((file) => readFileSync(join(dir, file), 'utf8'))
      .join('\n'),
  )
}

/** Providers below `target`. With no `names`, every provider with chat rows. */
export function failing(
  report: GapReport,
  target: number,
  names?: Array<string>,
): Array<string> {
  if (!names) {
    return report.providers
      .filter((p) => p.chat > 0 && p.score != null && p.score < target)
      .map((p) => p.provider)
  }
  const scores = new Map(report.providers.map((p) => [p.provider, p.score]))
  // A named provider with no rows at all fails. A provider that does not
  // serve chat scores null and is not below target.
  return names.filter((name) => {
    const score = scores.get(name)
    if (score === undefined) return true
    if (score === null) return false
    return score < target
  })
}

export function formatTable(report: GapReport): string {
  const header = [
    'provider',
    'score',
    'rows',
    'chat',
    'noAct',
    'm.dev',
    ...FACT_KEYS,
    ...FLAG_KEYS,
  ]
  const body = report.providers.map((p) => [
    p.provider,
    p.score == null ? 'n/a' : p.score.toFixed(2),
    String(p.rows),
    String(p.chat),
    String(p.noActivity),
    String(p.fromModelsDev),
    ...FACT_KEYS.map((key) =>
      p.silent.includes(key)
        ? 'silent'
        : `${p.facts[key].have}/${p.facts[key].need}${p.modelSilent?.[key] ? ` (${p.modelSilent[key]} model-silent)` : ''}`,
    ),
    ...FLAG_KEYS.map((key) => String(p.flags[key].length)),
  ])
  const width = (i: number) =>
    Math.max(...[header, ...body].map((line) => line[i]?.length ?? 0))
  return [header, ...body]
    .map((line) =>
      line
        .map((cell, i) =>
          i === 0 ? cell.padEnd(width(i)) : cell.padStart(width(i)),
        )
        .join('  '),
    )
    .join('\n')
}

export async function main(
  argv: Array<string> = process.argv.slice(2),
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: 'string', default: 'https://modelschemas.com' },
      table: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      providers: { type: 'string' },
      target: { type: 'string', default: '1' },
    },
  })
  const target = Number(values.target)
  if (!(target >= 0 && target <= 1)) {
    throw new Error(`--target must be between 0 and 1, got "${values.target}"`)
  }

  const url = new URL('/v1/models?pricing=1&limit=20000', values.base)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url.href} → ${response.status}`)
  const { models } = (await response.json()) as { models: Array<ModelRow> }

  const report = buildReport(models, readLedger())

  console.log(
    values.table ? formatTable(report) : JSON.stringify(report, null, 2),
  )

  if (!values.check) return 0
  const names = values.providers?.split(',').filter(Boolean)
  const below = failing(report, target, names)
  if (below.length > 0) {
    console.error(`below target ${target}: ${below.join(', ')}`)
    return 1
  }
  return 0
}

if (import.meta.main) {
  process.exit(await main())
}
