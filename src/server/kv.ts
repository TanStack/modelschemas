export interface KvEnv {
  SCHEMA_CACHE: KVNamespace
}

/**
 * Deterministic JSON stringify: object keys are sorted recursively so the
 * same logical value always produces the same string (and content hash).
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue)
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortValue((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/** SHA-256 hex digest of a stable-stringified value. */
export async function contentHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function getJson<T>(
  kv: KVNamespace,
  key: string,
): Promise<T | null> {
  const raw = await kv.get(key, 'text')
  if (raw === null) return null
  return JSON.parse(raw) as T
}

export async function putJson(
  kv: KVNamespace,
  key: string,
  value: unknown,
  options?: { expirationTtl?: number },
): Promise<void> {
  await kv.put(key, stableStringify(value), options)
}
