import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** Absolute path of a dependency's bin, to run with `process.execPath`. */
export function packageBin(name: string): string {
  const manifest = require(`${name}/package.json`) as {
    bin?: string | Record<string, string>
  }
  const bin = manifest.bin
  const relative = typeof bin === 'string' ? bin : bin?.[name]
  if (!relative) throw new Error(`${name} has no "${name}" bin`)
  return require.resolve(`${name}/${relative.replace(/^\.\//, '')}`)
}
