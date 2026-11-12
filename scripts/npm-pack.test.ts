import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { CardEvaluation } from '../packages/rate-card/src/evaluator.ts'
import type { RateCard } from '../packages/rate-card/src/card.ts'
import {
  ESTIMATE_CASES,
  packageExpected,
  settle,
} from '../packages/rate-card/src/fixtures/estimate-cases.ts'
import {
  assertPublishableManifest,
  assertShipsEntryPoints,
  assertVersionsMatchTag,
  listPublicPackages,
  main,
  manifestEntryPoints,
  packAll,
  packedEntryNames,
  pinWorkspaceSpecs,
  publishManifest,
  publishOrder,
  readPackedManifest,
  run,
  tarballFileName,
  versionFromTag,
} from './npm-pack.ts'
import type { PublicPackage } from './npm-pack.ts'

const EXPECTED_NAMES = [
  '@modelschemas/client',
  '@modelschemas/codegen',
  '@modelschemas/rate-card',
  '@modelschemas/vite',
  'modelschemas',
] as const

function sharedVersion(): string {
  const pkgs = listPublicPackages()
  const versions = new Set(pkgs.map((pkg) => pkg.version))
  expect(versions.size).toBe(1)
  const version = pkgs[0]?.version
  if (version === undefined) throw new Error('no public packages')
  return version
}

describe('listPublicPackages', () => {
  it('returns the five public workspace packages at one shared version', () => {
    const pkgs = listPublicPackages()
    expect(pkgs.map((pkg) => pkg.name).sort()).toEqual([...EXPECTED_NAMES])
    expect(new Set(pkgs.map((pkg) => pkg.version)).size).toBe(1)
  })
})

describe('publishOrder', () => {
  it('puts packages with no workspace deps before their dependents', () => {
    const ordered = publishOrder(listPublicPackages()).map((pkg) => pkg.name)
    expect(ordered.indexOf('@modelschemas/client')).toBeLessThan(
      ordered.indexOf('modelschemas'),
    )
    expect(ordered.indexOf('@modelschemas/codegen')).toBeLessThan(
      ordered.indexOf('modelschemas'),
    )
    expect(ordered.indexOf('@modelschemas/codegen')).toBeLessThan(
      ordered.indexOf('@modelschemas/vite'),
    )
  })

  it('throws on a workspace dependency cycle', () => {
    expect(() =>
      publishOrder([
        {
          name: 'a',
          version: '1.0.0',
          dir: '/tmp/a',
          dependencies: { b: 'workspace:*' },
        },
        {
          name: 'b',
          version: '1.0.0',
          dir: '/tmp/b',
          dependencies: { a: 'workspace:*' },
        },
      ]),
    ).toThrow(/workspace dependency cycle/)
  })
})

describe('tarballFileName / versionFromTag', () => {
  it('turns scoped names into slash-free tarball filenames', () => {
    expect(tarballFileName('@modelschemas/client', '0.1.0')).toBe(
      'modelschemas-client-0.1.0.tgz',
    )
    expect(tarballFileName('modelschemas', '0.1.0')).toBe(
      'modelschemas-0.1.0.tgz',
    )
  })

  it('parses v-prefixed semver tags only', () => {
    expect(versionFromTag('v0.1.0')).toBe('0.1.0')
    expect(versionFromTag('refs/tags/v1.2.3-rc.1')).toBe('1.2.3-rc.1')
    expect(versionFromTag('0.1.0')).toBeUndefined()
    expect(versionFromTag('vnext')).toBeUndefined()
  })

  it('rejects a tag that does not match package versions', () => {
    const pkgs = listPublicPackages()
    const version = sharedVersion()
    expect(() => assertVersionsMatchTag(pkgs, 'v9.9.9')).toThrow(
      /does not match/,
    )
    expect(() => assertVersionsMatchTag(pkgs, `v${version}`)).not.toThrow()
    expect(() =>
      assertVersionsMatchTag(
        [
          { name: 'ok', version: '0.2.0', dir: '/tmp', dependencies: {} },
          {
            name: 'modelschemas',
            version: '0.1.0',
            dir: '/tmp',
            dependencies: {},
          },
        ],
        'v0.2.0',
      ),
    ).toThrow(/modelschemas@0.1.0/)
  })
})

describe('main', () => {
  it('refuses --tag / RELEASE_TAG that do not match manifests', () => {
    expect(() => main(['--tag', 'v9.9.9'])).toThrow(/does not match/)
    const prev = process.env.RELEASE_TAG
    process.env.RELEASE_TAG = 'v9.9.9'
    try {
      expect(() => main([])).toThrow(/does not match/)
    } finally {
      if (prev === undefined) delete process.env.RELEASE_TAG
      else process.env.RELEASE_TAG = prev
    }
  })
})

describe('assertPublishableManifest', () => {
  it('rejects workspace: and catalog: specs', () => {
    expect(() =>
      assertPublishableManifest(
        {
          name: 'x',
          version: '1.0.0',
          dependencies: { '@modelschemas/client': 'workspace:*' },
        },
        'test',
      ),
    ).toThrow(/workspace:\*/)
  })
})

describe('publishManifest / assertShipsEntryPoints', () => {
  it('pins workspace:* to the workspace package version', () => {
    const manifest = {
      dependencies: { '@modelschemas/client': 'workspace:*' },
    }
    pinWorkspaceSpecs(manifest, join(import.meta.dirname, '..', 'packages'))
    expect(manifest.dependencies['@modelschemas/client']).toBe(sharedVersion())
  })

  it('lifts publishConfig entry points and keeps npm config there', () => {
    expect(
      publishManifest({
        name: 'x',
        main: './src/index.ts',
        publishConfig: { access: 'public', main: './dist/index.js' },
      }),
    ).toEqual({
      name: 'x',
      main: './dist/index.js',
      publishConfig: { access: 'public' },
    })
    expect(
      publishManifest({ name: 'x', publishConfig: { access: 'public' } }),
    ).toBeUndefined()
  })

  it('refuses a tarball missing a file its manifest points at', () => {
    const manifest = {
      main: './dist/index.js',
      exports: { '.': { types: './dist/index.d.ts' } },
    }
    expect(manifestEntryPoints(manifest)).toEqual([
      'dist/index.d.ts',
      'dist/index.js',
    ])
    expect(() =>
      assertShipsEntryPoints(manifest, ['package/dist/index.js'], 'x.tgz'),
    ).toThrow(/x.tgz: does not ship dist\/index.d.ts/)
  })
})

describe('packAll', () => {
  const dest = join('dist', 'npm-pack-test')
  const abs = resolve(dest)
  let packed: Array<{ pkg: PublicPackage; tarball: string }> = []

  beforeAll(() => {
    packed = packAll(publishOrder(listPublicPackages()), dest)
  }, 120_000)
  afterAll(() => rmSync(abs, { recursive: true, force: true }))

  it('rewrites workspace protocol, omits tests, and resolves relative dest from cwd', () => {
    expect(packed.map((row) => row.pkg.name)).toEqual(
      publishOrder(listPublicPackages()).map((pkg) => pkg.name),
    )
    const version = sharedVersion()
    for (const { pkg, tarball } of packed) {
      expect(tarball.startsWith(`${abs}${sep}`)).toBe(true)
      expect(tarball.includes(`${sep}packages${sep}`)).toBe(false)
      expect(existsSync(tarball)).toBe(true)
      const manifest = readPackedManifest(tarball)
      assertPublishableManifest(manifest, tarball)
      const json = JSON.stringify(manifest)
      expect(json).not.toContain('workspace:')
      expect(json).not.toContain('catalog:')
      if (pkg.name === 'modelschemas') {
        expect(json).toContain(`"@modelschemas/client":"${version}"`)
        expect(json).toContain(`"@modelschemas/codegen":"${version}"`)
      }
      if (pkg.name === '@modelschemas/vite') {
        expect(json).toContain(`"@modelschemas/codegen":"${version}"`)
      }
      const entries = packedEntryNames(tarball)
      expect(entries.some((entry) => entry.endsWith('.test.ts'))).toBe(false)
      expect(entries).toContain('package/package.json')
      expect(entries).toContain('package/LICENSE')
      expect(entries).toContain('package/dist/index.js')
      expect(entries).toContain('package/dist/index.d.ts')
      expect(
        entries.filter((e) => e.endsWith('.ts') && !e.endsWith('.d.ts')),
      ).toEqual([])
      if (pkg.name === '@modelschemas/rate-card') {
        expect(entries).toContain('package/dist/evaluator.d.ts')
      }
      if (pkg.name === 'modelschemas') {
        expect(json).toContain('"./dist/index.js"')
      }
    }
  })

  describe('plain Node loads the built packages', () => {
    let root = ''

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'modelschemas-node-'))
      const nm = join(root, 'node_modules')
      mkdirSync(join(nm, '@modelschemas'), { recursive: true })
      const place = (name: string, target: string) => {
        const row = packed.find((r) => r.pkg.name === name)
        if (!row) throw new Error(`${name} was not packed`)
        const extract = mkdtempSync(join(tmpdir(), 'extract-'))
        run('tar', ['-xzf', row.tarball, '-C', extract], extract)
        cpSync(join(extract, 'package'), target, { recursive: true })
        rmSync(extract, { recursive: true, force: true })
      }
      place('@modelschemas/client', join(nm, '@modelschemas', 'client'))
      place('@modelschemas/codegen', join(nm, '@modelschemas', 'codegen'))
      place('@modelschemas/vite', join(nm, '@modelschemas', 'vite'))
      place('modelschemas', join(nm, 'modelschemas'))
      const repoModules = join(import.meta.dirname, '..', 'node_modules')
      cpSync(join(repoModules, 'jose'), join(nm, 'jose'), { recursive: true })
      cpSync(join(repoModules, 'vite'), join(nm, 'vite'), { recursive: true })
    })
    afterAll(() => rmSync(root, { recursive: true, force: true }))

    it('imports client, codegen, and vite with no loader', () => {
      for (const name of [
        '@modelschemas/client',
        '@modelschemas/codegen',
        '@modelschemas/vite',
      ]) {
        const result = run(
          'node',
          ['--input-type=module', '-e', `import('${name}')`],
          root,
        )
        expect(result).toBe('')
      }
    })

    it('runs modelschemas --help', () => {
      // No command exits 1 after printing help. A command plus --help exits 0.
      const result = spawnSync(
        'node',
        [
          join(root, 'node_modules', 'modelschemas', 'dist', 'index.js'),
          '--help',
        ],
        { cwd: root, encoding: 'utf8' },
      )
      expect(result.stdout).toContain('modelschemas — live AI model schemas')
      expect(result.status).toBe(1)
    })

    it('typechecks a nodenext consumer against dist declarations', () => {
      const file = join(root, 'consumer.ts')
      writeFileSync(
        file,
        `import { createModelschemasClient } from '@modelschemas/client'
import { pull } from '@modelschemas/codegen'
import { modelschemas } from '@modelschemas/vite'
createModelschemasClient({ baseUrl: 'https://modelschemas.com' })
void pull
void modelschemas
`,
      )
      run(
        join(
          import.meta.dirname,
          '..',
          'node_modules',
          'typescript',
          'bin',
          'tsc',
        ),
        [
          '--strict',
          '--module',
          'nodenext',
          '--moduleResolution',
          'nodenext',
          '--noEmit',
          '--pretty',
          'false',
          file,
        ],
        root,
      )
    }, 60_000)

    it('publint passes on each packed package', () => {
      for (const name of [
        '@modelschemas/client',
        '@modelschemas/codegen',
        '@modelschemas/vite',
        'modelschemas',
      ]) {
        const dir =
          name === 'modelschemas'
            ? join(root, 'node_modules', 'modelschemas')
            : join(root, 'node_modules', name)
        const out = run('pnpm', ['exec', 'publint'], dir)
        expect(out).not.toMatch(/error/i)
      }
    }, 60_000)
  })

  describe('the packed rate-card evaluator', () => {
    let dir = ''
    let evaluator = ''

    beforeAll(() => {
      const row = packed.find((r) => r.pkg.name === '@modelschemas/rate-card')
      if (!row) throw new Error('rate-card was not packed')
      // No node_modules anywhere above: an import of any package fails.
      dir = mkdtempSync(join(tmpdir(), 'rate-card-'))
      run('tar', ['-xzf', row.tarball, '-C', dir], dir)
      evaluator = join(dir, 'package', 'dist', 'evaluator.js')
    })
    afterAll(() => rmSync(dir, { recursive: true, force: true }))

    it('gives every shared estimate case its expected result', async () => {
      const { evaluateCard } = (await import(
        /* @vite-ignore */ pathToFileURL(evaluator).href
      )) as {
        evaluateCard: (
          card: RateCard,
          inputs: { request?: object; usage?: object },
        ) => CardEvaluation
      }
      for (const c of ESTIMATE_CASES) {
        expect(
          settle(() =>
            evaluateCard(c.card, { request: c.request, usage: c.usage }),
          ),
          c.name,
        ).toEqual(packageExpected(c))
      }
    })

    it('loads the package root without zod', async () => {
      const root = join(dir, 'package', 'dist', 'index.js')
      const mod = (await import(
        /* @vite-ignore */ pathToFileURL(root).href
      )) as Record<string, unknown>
      expect(mod.compileOpenRouterPricing).toBeTypeOf('function')
      expect(mod.rateCardSchema).toBeUndefined()
    })
  })
})

describe('publish.yml', () => {
  it('is the trusted-publisher workflow: OIDC, stage-only, no npm token', () => {
    const yaml = readFileSync(
      join(import.meta.dirname, '..', '.github', 'workflows', 'publish.yml'),
      'utf8',
    )
    const withoutComments = yaml.replace(/^\s*#.*$/gm, '')
    expect(withoutComments).toMatch(/id-token:\s*write/)
    expect(withoutComments).toMatch(/environment:\s*npm/)
    expect(withoutComments).toContain('npm stage publish')
    expect(withoutComments.replaceAll('npm stage publish', '')).not.toContain(
      'npm publish',
    )
    expect(withoutComments).not.toContain('NPM_TOKEN')
    expect(withoutComments).not.toContain('NODE_AUTH_TOKEN')
    expect(withoutComments).not.toContain('bun publish')
    expect(withoutComments).toContain('RELEASE_TAG')
    expect(withoutComments).toContain('scripts/npm-pack.ts')
    expect(withoutComments).toMatch(/!inputs\.dry_run/)
    expect(withoutComments).toMatch(/default:\s*true/)
    expect(withoutComments).toContain('npm@11.19.0')
    expect(withoutComments).not.toContain('npm@latest')
    expect(withoutComments).toContain('persist-credentials: false')
    expect(withoutComments).toMatch(/permissions:\s*\{\}/)
  })
})
