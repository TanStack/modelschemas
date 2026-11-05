/** Resolve a local `$ref` as a JSON pointer against the document root. */
function resolvePointer(document: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined
  let node: unknown = document
  for (const raw of ref.slice(2).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[token]
  }
  return node
}

/** Every `$ref` in `document` that does not resolve within it. */
export function unresolvedRefs(document: unknown): Array<string> {
  const misses: Array<string> = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node !== 'object' || node === null) return
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        if (resolvePointer(document, value) === undefined) misses.push(value)
      } else walk(value)
    }
  }
  walk(document)
  return misses
}
