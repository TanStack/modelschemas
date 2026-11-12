/**
 * Pack the public workspace packages for npm.
 *
 * This script only writes tarballs. Staging is `npm stage publish`
 * from `.github/workflows/publish.yml` (OIDC, env `npm`, workflow
 * filename `publish.yml`) so the trusted-publisher match holds.
 * Future Actions stages get provenance; laptop `0.1.0` did not.
 *
 *   pnpm run npm:pack                        # dist/npm, then stop
 *   pnpm run npm:pack -- --pack-dir /tmp/npm
 *
 * If `--tag` or `RELEASE_TAG` is set, it must be `vMAJOR.MINOR.PATCH`
 * (optional prerelease) and match every public package's version.
 *
 * A package with a `build` script is built first. A package whose
 * `publishConfig` names entry points (rate-card: `dist/` JS and .d.ts
 * instead of `src/` TypeScript) is packed from a staged copy with those
 * fields lifted onto the manifest. Staging leaves the workspace, so
 * `workspace:*` is pinned to that package's version before `npm pack`.
 * Every tarball must contain each file its manifest points at.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export type PublicPackage = {
  name: string
  version: string
  dir: string
  dependencies: Record<string, string>
}

const WORKSPACE_OR_CATALOG = /^(workspace|catalog):/

export function repoRoot(): string {
  return join(import.meta.dirname, '..')
}

export function tarballFileName(name: string, version: string): string {
  const unscoped = name.startsWith('@') ? name.slice(1).replace('/', '-') : name
  return `${unscoped}-${version}.tgz`
}

/** `v0.1.0`, `refs/tags/v0.1.0`, or `v1.2.3-rc.1` → version. Else undefined. */
export function versionFromTag(tag: string): string | undefined {
  const trimmed = tag.replace(/^refs\/tags\//, '')
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(trimmed)) return undefined
  return trimmed.slice(1)
}

export function listPublicPackages(
  packagesDir: string = join(repoRoot(), 'packages'),
): Array<PublicPackage> {
  const pkgs: Array<PublicPackage> = []
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pkgPath = join(packagesDir, entry.name, 'package.json')
    let raw: string
    try {
      raw = readFileSync(pkgPath, 'utf8')
    } catch {
      continue
    }
    const parsed: unknown = JSON.parse(raw)
    const pkg = asPackageJson(parsed, pkgPath)
    if (pkg.private) continue
    pkgs.push({
      name: pkg.name,
      version: pkg.version,
      dir: join(packagesDir, entry.name),
      dependencies: pkg.dependencies,
    })
  }
  pkgs.sort((a, b) => a.name.localeCompare(b.name))
  return pkgs
}

/** Dependents last (client/codegen, then vite, CLI) — npmjs.com approve order. */
export function publishOrder(
  packages: Array<PublicPackage>,
): Array<PublicPackage> {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const remaining = new Set(packages.map((pkg) => pkg.name))
  const ordered: Array<PublicPackage> = []
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((name) => {
        const pkg = byName.get(name)
        if (!pkg) return false
        return Object.keys(pkg.dependencies).every((dep) => !remaining.has(dep))
      })
      .sort()
    if (ready.length === 0) {
      throw new Error(
        `workspace dependency cycle among ${[...remaining].join(', ')}`,
      )
    }
    for (const name of ready) {
      remaining.delete(name)
      const pkg = byName.get(name)
      if (!pkg) throw new Error(`missing package ${name}`)
      ordered.push(pkg)
    }
  }
  return ordered
}

export function assertVersionsMatchTag(
  packages: Array<PublicPackage>,
  tag: string,
): void {
  const expected = versionFromTag(tag)
  if (expected === undefined) {
    throw new Error(
      `release tag ${JSON.stringify(tag)} is not vMAJOR.MINOR.PATCH`,
    )
  }
  const mismatches = packages.filter((pkg) => pkg.version !== expected)
  if (mismatches.length > 0) {
    const detail = mismatches
      .map((pkg) => `${pkg.name}@${pkg.version}`)
      .join(', ')
    throw new Error(
      `tag v${expected} does not match package versions: ${detail}`,
    )
  }
}

export function assertPublishableManifest(
  manifest: unknown,
  source: string,
): void {
  const pkg = asPackageJson(manifest, source)
  if (pkg.private) {
    throw new Error(`${source}: packed manifest is private`)
  }
  for (const [name, spec] of Object.entries(pkg.dependencies)) {
    if (WORKSPACE_OR_CATALOG.test(spec)) {
      throw new Error(`${source}: ${name} still uses ${spec}`)
    }
  }
}

export function readPackedManifest(tarball: string): unknown {
  return JSON.parse(
    run('tar', ['-xOf', tarball, 'package/package.json'], process.cwd()),
  ) as unknown
}

export function packedEntryNames(tarball: string): Array<string> {
  return run('tar', ['-tzf', tarball], process.cwd())
    .split('\n')
    .filter((line) => line.length > 0)
}

/** Absolute dest so `npm pack` (cwd = package dir) writes where we look. */
export function resolvePackDir(packDir: string): string {
  return resolve(packDir)
}

/** `publishConfig` keys that configure npm, not the packed manifest. */
const NPM_CONFIG_KEYS = new Set(['access', 'registry', 'tag', 'provenance'])

/**
 * The manifest npm should see: `publishConfig` manifest fields (`main`,
 * `types`, `exports`) lifted to the top level, as pnpm does on publish.
 * `undefined` when there is nothing to lift.
 */
export function publishManifest(
  manifest: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const config = manifest.publishConfig
  if (!isRecord(config)) return undefined
  const lifted = Object.entries(config).filter(
    ([key]) => !NPM_CONFIG_KEYS.has(key),
  )
  if (lifted.length === 0) return undefined
  return {
    ...manifest,
    ...Object.fromEntries(lifted),
    publishConfig: Object.fromEntries(
      Object.entries(config).filter(([key]) => NPM_CONFIG_KEYS.has(key)),
    ),
  }
}

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

/** `workspace:*` → that package's version. npm does not rewrite the protocol. */
export function pinWorkspaceSpecs(
  manifest: Record<string, unknown>,
  packagesDir: string,
): void {
  for (const field of DEP_FIELDS) {
    const deps = manifest[field]
    if (!isRecord(deps)) continue
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue
      if (spec !== 'workspace:*') {
        throw new Error(`${name}: unsupported workspace spec ${spec}`)
      }
      deps[name] = workspaceVersion(packagesDir, name)
    }
  }
}

function workspaceVersion(packagesDir: string, name: string): string {
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pkgPath = join(packagesDir, entry.name, 'package.json')
    if (!existsSync(pkgPath)) continue
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (!isRecord(parsed) || parsed.name !== name) continue
    if (typeof parsed.version !== 'string') {
      throw new Error(`${pkgPath}: version is not a string`)
    }
    return parsed.version
  }
  throw new Error(`no workspace package named ${name}`)
}

/** Relative file paths a manifest's `main`, `types`, `bin` and `exports` name. */
export function manifestEntryPoints(manifest: unknown): Array<string> {
  if (!isRecord(manifest)) return []
  const paths = new Set<string>()
  const collect = (value: unknown) => {
    if (typeof value === 'string') {
      if (value.startsWith('./')) paths.add(value.slice(2))
    } else if (isRecord(value)) {
      Object.values(value).forEach(collect)
    }
  }
  for (const key of ['main', 'types', 'module', 'bin', 'exports']) {
    collect(manifest[key])
  }
  return [...paths].sort()
}

export function assertShipsEntryPoints(
  manifest: unknown,
  entries: Array<string>,
  source: string,
): void {
  const missing = manifestEntryPoints(manifest).filter(
    (path) => !entries.includes(`package/${path}`),
  )
  if (missing.length > 0) {
    throw new Error(`${source}: does not ship ${missing.join(', ')}`)
  }
}

export function run(command: string, args: Array<string>, cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} in ${cwd} failed: ${result.stderr || result.stdout}`,
    )
  }
  return result.stdout
}

export function packPackage(pkg: PublicPackage, packDir: string): string {
  const dest = resolvePackDir(packDir)
  mkdirSync(dest, { recursive: true })
  const manifest: unknown = JSON.parse(
    readFileSync(join(pkg.dir, 'package.json'), 'utf8'),
  )
  if (!isRecord(manifest)) {
    throw new Error(`${pkg.dir}: package.json is not an object`)
  }
  if (
    isRecord(manifest.scripts) &&
    typeof manifest.scripts.build === 'string'
  ) {
    run('pnpm', ['run', 'build'], pkg.dir)
  }
  const published = publishManifest(manifest)
  let cwd = pkg.dir
  if (published) {
    // Outside the workspace. Pin `workspace:*` before packing.
    cwd = mkdtempSync(join(tmpdir(), 'npm-pack-'))
    cpSync(pkg.dir, cwd, {
      recursive: true,
      filter: (path) => basename(path) !== 'node_modules',
    })
    pinWorkspaceSpecs(published, join(pkg.dir, '..'))
    writeFileSync(
      join(cwd, 'package.json'),
      `${JSON.stringify(published, null, 2)}\n`,
    )
  }
  let stdout: string
  try {
    stdout = run(
      'npm',
      ['pack', '--ignore-scripts', '--pack-destination', dest],
      cwd,
    )
  } finally {
    if (cwd !== pkg.dir) rmSync(cwd, { recursive: true, force: true })
  }
  const tarball = join(dest, tarballFileName(pkg.name, pkg.version))
  if (!existsSync(tarball)) {
    throw new Error(
      `expected ${tarball} after npm pack; stdout=${stdout.trim()}`,
    )
  }
  return tarball
}

export function packAll(
  packages: Array<PublicPackage>,
  packDir: string,
): Array<{ pkg: PublicPackage; tarball: string }> {
  const dest = resolvePackDir(packDir)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const packed: Array<{ pkg: PublicPackage; tarball: string }> = []
  for (const pkg of packages) {
    const tarball = packPackage(pkg, dest)
    const manifest = readPackedManifest(tarball)
    assertPublishableManifest(manifest, tarball)
    const entries = packedEntryNames(tarball)
    assertShipsEntryPoints(manifest, entries, tarball)
    const tests = entries.filter((entry) => entry.endsWith('.test.ts'))
    if (tests.length > 0) {
      throw new Error(`${tarball} includes test files: ${tests.join(', ')}`)
    }
    packed.push({ pkg, tarball })
  }
  return packed
}

function asPackageJson(
  value: unknown,
  source: string,
): {
  name: string
  version: string
  private: boolean
  dependencies: Record<string, string>
} {
  if (!isRecord(value)) {
    throw new Error(`${source}: package.json is not an object`)
  }
  if (typeof value.name !== 'string' || typeof value.version !== 'string') {
    throw new Error(`${source}: name and version must be strings`)
  }
  return {
    name: value.name,
    version: value.version,
    private: value.private === true,
    dependencies: {
      ...stringRecord(value.dependencies, `${source} dependencies`),
      ...stringRecord(
        value.optionalDependencies,
        `${source} optionalDependencies`,
      ),
      ...stringRecord(value.peerDependencies, `${source} peerDependencies`),
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringRecord(value: unknown, source: string): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error(`${source}: expected an object`)
  const out: Record<string, string> = {}
  for (const [key, spec] of Object.entries(value)) {
    if (typeof spec !== 'string') {
      throw new Error(`${source}: ${key} is not a string`)
    }
    out[key] = spec
  }
  return out
}

function parseCli(argv: Array<string>): {
  packDir: string | undefined
  tag: string | undefined
} {
  let packDir: string | undefined
  let tag: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--pack-dir') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--pack-dir requires a path')
      packDir = value
      i += 1
      continue
    }
    if (arg === '--tag') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--tag requires a value')
      tag = value
      i += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  return { packDir, tag }
}

export function main(argv: Array<string> = process.argv.slice(2)): void {
  const flags = parseCli(argv)
  const packages = publishOrder(listPublicPackages())
  if (packages.length === 0) {
    throw new Error('no public packages under packages/')
  }
  const tag = flags.tag ?? process.env.RELEASE_TAG
  if (tag !== undefined && tag !== '') {
    assertVersionsMatchTag(packages, tag)
  }
  const packDir = resolvePackDir(
    flags.packDir ??
      process.env.NPM_PACK_DIR ??
      join(repoRoot(), 'dist', 'npm'),
  )
  const packed = packAll(packages, packDir)
  console.log(`packed ${packed.length} packages → ${packDir}\n`)
  for (const { pkg, tarball } of packed) {
    console.log(`  ${pkg.name}@${pkg.version}`)
    console.log(`    ${tarball}`)
  }
  console.log(
    `\nNext: npm stage publish happens in .github/workflows/publish.yml (OIDC).`,
  )
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exit(1)
  }
}
