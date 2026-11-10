import { Validator } from '@cfworker/json-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { classifyAndBundle } from '../../ingest/sync.ts'
import { sha256Text } from '../types.ts'
import {
  OLLAYA_CONTRACT_URL,
  parseOllayaConfig,
  provider,
  registryTags,
} from './ollaya.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Serve docs/api.md with this text; any other URL fails the test. */
function serveContract(text: string) {
  vi.stubGlobal('fetch', (url: string) =>
    Promise.resolve(
      url === OLLAYA_CONTRACT_URL
        ? new Response(text)
        : new Response('unexpected', { status: 500 }),
    ),
  )
}

describe('ollaya', () => {
  it('hashes the contract text, so a docs/api.md edit is a new source', async () => {
    serveContract('# contract v1')
    const first = await provider.fetchSpec({})
    expect(first.sources[0]?.hash).toBe(await sha256Text('# contract v1'))
    serveContract('# contract v2')
    const second = await provider.fetchSpec({})
    expect(second.sources[0]?.hash).not.toBe(first.sources[0]?.hash)
  })

  it('bundles POST /v1/systemone as a decision endpoint', async () => {
    serveContract('# contract')
    const bundled = classifyAndBundle(provider, await provider.fetchSpec({}))
    expect(bundled.endpoints).toHaveLength(1)
    const [endpoint] = bundled.endpoints
    expect(endpoint?.path).toBe('/v1/systemone')
    expect(endpoint?.activity).toBe('decision')

    const input = new Validator(endpoint?.input as object, '2020-12', false)
    const ok = {
      model: 'laya',
      state: { message: 'Can I get an invoice?' },
      questions: {
        intent: { type: 'choice', criteria: { invoice: 'x', other: 'y' } },
        tags: { type: 'choice', criteria: ['a', 'b'], ordinal: true },
        urgency: { type: 'score', criteria: ['low', 'high'] },
        billing: { type: 'noul', instructions: 'About billing?' },
      },
    }
    expect(input.validate(ok).valid).toBe(true)
    expect(input.validate({ ...ok, questions: {} }).valid).toBe(false)
    expect(
      input.validate({
        ...ok,
        questions: { q: { type: 'box', instructions: 'x' } },
      }).valid,
    ).toBe(false)

    const output = new Validator(endpoint?.output as object, '2020-12', false)
    expect(
      output.validate({
        model: 'laya:en',
        answers: {
          intent: {
            type: 'choice',
            choice: 'invoice',
            confidence: 0.8995,
            probabilities: { invoice: 0.933, other: 0.067 },
          },
          billing: { type: 'noul', noul: 0.9641 },
        },
        usage: { input_tokens: 71, output_tokens: 0 },
      }).valid,
    ).toBe(true)
  })

  it('lists tags, skipping digests and precision pins of a listed tag', () => {
    const blob = (path: string) => ({ path, type: 'blob' })
    expect(
      registryTags({
        truncated: false,
        tree: [
          { path: 'laya', type: 'tree' },
          blob('laya/manifests/en'),
          blob('laya/manifests/en-fp32'),
          blob('laya/manifests/latest'),
          blob('laya/manifests/sha256-abc'),
          blob('kev/manifests/9b-fp16'),
        ],
      }),
    ).toEqual(['kev:9b-fp16', 'laya:en', 'laya:latest'])
    expect(() => registryTags({ truncated: true, tree: [] })).toThrow()
  })

  it('reads a config blob', () => {
    expect(
      parseOllayaConfig('laya:en', {
        family: 'laya',
        context_length: 512,
        source:
          'huggingface.co/convaiinnovations/laya@aa8c91ca088ec597df95a0d1c76b3063cb2ae5e8',
        release_date: '2026-09-23',
      }),
    ).toMatchObject({
      rawId: 'laya:en',
      activity: 'decision',
      contextWindow: 512,
      releasedAt: Date.UTC(2026, 8, 23) / 1000,
      openWeights: true,
      weightsUrl: 'https://huggingface.co/convaiinnovations/laya',
    })
    // A router has no weights and no context of its own.
    expect(
      parseOllayaConfig('laya:latest', {
        model_format: 'router',
        context_length: 0,
        source: '',
      }),
    ).toMatchObject({
      contextWindow: null,
      openWeights: null,
      weightsUrl: null,
    })
  })

  it('throws on a config value it cannot read', () => {
    expect(() => parseOllayaConfig('x:1', { context_length: '512' })).toThrow(
      /context_length/,
    )
    expect(() => parseOllayaConfig('x:1', { release_date: 'soon' })).toThrow(
      /release_date/,
    )
    expect(() => parseOllayaConfig('x:1', { source: 42 })).toThrow(/source/)
    // Absent fields are unstated, not errors.
    expect(parseOllayaConfig('x:1', {})).toMatchObject({
      contextWindow: null,
      releasedAt: null,
      openWeights: null,
    })
  })
})
