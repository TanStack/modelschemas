/**
 * Integrity verification — the online counterpart to `verify()`'s offline
 * file check: re-fetch every manifest entry at its pinned
 * `?version=<contentHash>` address, recompute the hash locally, and fail
 * on any mismatch. The hash mirrors the server's content addressing
 * (SHA-256 of the recursively key-sorted JSON), so a match proves the
 * service serves exactly the bytes the pinned hash names — nothing to
 * take on trust. Full re-derivation from the upstream provider spec lives
 * in the service repo (`pnpm run rederive -- <provider>`); the
 * `provenance` echoed per check says which upstream document to audit.
 */
import { createHash } from 'node:crypto'

import { readManifest } from './manifest.ts'
import { DEFAULT_BASE_URL } from './pull.ts'
import type { PullConfig } from './pull.ts'
import { LABEL_KIND } from './selection.ts'
import type { Kind, KindLabel } from './selection.ts'

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortValue((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/** SHA-256 of the stable-stringified value — must equal the server's
 * `contentHash` (src/server/kv.ts) for the same schema. */
export function schemaContentHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortValue(value)))
    .digest('hex')
}

/** The `provenance` object served with every JSON schema read. */
export interface SchemaProvenance {
  sourceUrl: string | null
  sourceHash: string | null
  fetchedAt: number
  extractorVersion: string | null
}

export interface IntegrityCheck {
  key: string
  contentHash: string
  ok: boolean
  problem?: string
  provenance?: SchemaProvenance | null
}

export interface IntegrityResult {
  ok: boolean
  checks: Array<IntegrityCheck>
  /** Failures not tied to one manifest entry (e.g. missing manifest). */
  problems: Array<string>
}

interface ParsedKey {
  provider: string
  activity: string
  endpointId: string
  kind: Kind
}

/** Manifest keys are `provider/activity/endpointId#request|response`. */
function parseKey(key: string): ParsedKey | null {
  const hashIndex = key.lastIndexOf('#')
  if (hashIndex === -1) return null
  const kind = LABEL_KIND[key.slice(hashIndex + 1) as KindLabel] as
    | Kind
    | undefined
  if (kind === undefined) return null
  const [provider, activity, ...endpoint] = key.slice(0, hashIndex).split('/')
  if (provider === undefined || activity === undefined || endpoint.length === 0)
    return null
  return { provider, activity, endpointId: endpoint.join('/'), kind }
}

export async function verifyIntegrity(
  config: PullConfig,
): Promise<IntegrityResult> {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const fetchImpl = config.fetchImpl ?? fetch
  const log = config.log ?? (() => undefined)
  const manifest = await readManifest(config.outDir)
  if (manifest === null) {
    return {
      ok: false,
      checks: [],
      problems: [
        `No ${config.outDir}/.manifest.json — run \`modelschemas pull\` first.`,
      ],
    }
  }

  const checks: Array<IntegrityCheck> = []
  for (const [key, entry] of Object.entries(manifest.entries)) {
    const target = parseKey(key)
    if (target === null) {
      checks.push({
        key,
        contentHash: entry.contentHash,
        ok: false,
        problem: `Unparseable manifest key — regenerate with \`modelschemas pull\`.`,
      })
      continue
    }
    const path =
      `/v1/schemas/${encodeURIComponent(target.provider)}/${encodeURIComponent(target.activity)}/` +
      target.endpointId.split('/').map(encodeURIComponent).join('/') +
      `?kind=${target.kind}&version=${encodeURIComponent(entry.contentHash)}`

    let check: IntegrityCheck
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        headers:
          config.apiKey !== undefined
            ? { Authorization: `Bearer ${config.apiKey}` }
            : {},
      })
      if (response.status === 404) {
        check = {
          key,
          contentHash: entry.contentHash,
          ok: false,
          problem: `Service no longer serves the pinned version ${entry.contentHash}.`,
        }
      } else if (!response.ok) {
        check = {
          key,
          contentHash: entry.contentHash,
          ok: false,
          problem: `GET ${path} → ${String(response.status)}`,
        }
      } else {
        const body = (await response.json()) as {
          contentHash: string
          schema: unknown
          provenance?: SchemaProvenance | null
        }
        const recomputed = schemaContentHash(body.schema)
        const ok =
          recomputed === entry.contentHash &&
          body.contentHash === entry.contentHash
        check = {
          key,
          contentHash: entry.contentHash,
          ok,
          ...(ok
            ? {}
            : {
                problem: `Content hash mismatch: manifest ${entry.contentHash}, served ${body.contentHash}, recomputed ${recomputed}.`,
              }),
          provenance: body.provenance ?? null,
        }
      }
    } catch (error) {
      check = {
        key,
        contentHash: entry.contentHash,
        ok: false,
        problem: error instanceof Error ? error.message : String(error),
      }
    }
    checks.push(check)
    log(`${check.ok ? 'verified' : 'FAILED'} ${key}`)
  }
  return { ok: checks.every((c) => c.ok), checks, problems: [] }
}
