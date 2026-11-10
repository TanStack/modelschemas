import { afterEach, describe, expect, it } from 'vitest'

import { classifyAndBundle } from '#/server/ingest/sync.ts'

import type { OpenApiDocument } from '../types.ts'
import {
  WORLDLABS_MODELS_URL,
  WORLDLABS_OPENAPI_URL,
  parseWorldlabsModels,
  provider,
} from './worldlabs.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const MODELS_PAGE = `
| Marble model | API \`model\` |
| - | - |
| \`Marble 1.1 Plus\` | \`marble-1.1-plus\` |
| \`Marble 1.1\` | \`marble-1.1\` |
| \`Marble 1.0\` | \`marble-1.0\` |
| \`Marble 1.0 Draft\` | \`marble-1.0-draft\` |

| Current \`model\` value | Legacy \`model\` value |
| - | - |
| \`marble-1.0\` | \`Marble 0.1-plus\` |
| \`marble-1.0-draft\` | \`Marble 0.1-mini\` |
`

const PRICING_PAGE = `
You may purchase credits at a fixed rate of $1.00 USD per 1,250 credits.

#### Draft model totals (\`marble-1.0-draft\`)

| Input type | Pano generation | World generation | Total |
| - | -: | -: | -: |
| Image (pano) | 0 | 150 | 150 |
| Text | 80 | 150 | 230 |
| Image (non-pano) | 80 | 150 | 230 |
| Multi-image | 100 | 150 | 250 |
| Video | 100 | 150 | 250 |

#### Standard model totals (\`marble-1.0\`, \`marble-1.1\`)

| Input type | Pano generation | World generation | Total |
| - | -: | -: | -: |
| Image (pano) | 0 | 1,500 | 1,500 |
| Text | 80 | 1,500 | 1,580 |
| Image (non-pano) | 80 | 1,500 | 1,580 |
| Multi-image | 100 | 1,500 | 1,600 |
| Video | 100 | 1,500 | 1,600 |

#### Marble 1.1 Plus totals (\`marble-1.1-plus\`)

| Input type | Pano generation | Base world generation | Variable world generation | Total |
| - | -: | -: | - | - |
| Image (pano) | 0 | 1,500 | 0-1,500 | 1,500-3,000 |
| Text | 80 | 1,500 | 0-1,500 | 1,580-3,080 |
| Image (non-pano) | 80 | 1,500 | 0-1,500 | 1,580-3,080 |
| Multi-image | 100 | 1,500 | 0-1,500 | 1,600-3,100 |
| Video | 100 | 1,500 | 0-1,500 | 1,600-3,100 |
`

function operation(
  summary: string,
  method: 'get' | 'post',
): NonNullable<OpenApiDocument['paths']>[string] {
  const op = {
    summary,
    responses: {
      '200': {
        content: {
          'application/json': {
            schema: { type: 'object', properties: { id: { type: 'string' } } },
          },
        },
      },
    },
  }
  if (method === 'get') return { get: op }
  return {
    post: {
      ...op,
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                world_prompt: { type: 'object' },
                model: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }
}

describe('worldlabs classify', () => {
  it('keeps the Marble generation paths, including operation polling', () => {
    expect(provider.classify('/marble/v1/worlds:generate', {})).toBe('world')
    expect(provider.classify('/marble/v1/operations/{operation_id}', {})).toBe(
      'world',
    )
    expect(provider.classify('/marble/v1/worlds/{world_id}', {})).toBe('world')
    expect(provider.classify('/marble/v1/worlds/{world_id}:export', {})).toBe(
      'world',
    )
    expect(provider.classify('/marble/v1/worlds:list', {})).toBe('world')
    expect(
      provider.classify('/marble/v1/media-assets:prepare_upload', {}),
    ).toBe('world')
    expect(
      provider.classify('/marble/v1/media-assets/{media_asset_id}', {}),
    ).toBe('world')
    expect(provider.classify('/marble/v1/pano:depth_to_rgb', {})).toBe('world')
    expect(provider.classify('/marble/v1/credits', {})).toBe('world')
  })

  it('drops paths the Marble document does not publish as generation', () => {
    expect(
      provider.classify('/marble/v1/worlds/{world_id}/share', {}),
    ).toBeNull()
  })
})

describe('parseWorldlabsModels', () => {
  it('reads the mapping table and the legacy aliases it states', () => {
    const models = parseWorldlabsModels(MODELS_PAGE)
    expect(models.get('marble-1.1')?.displayName).toBe('Marble 1.1')
    expect(models.get('marble-1.0')?.aliases).toEqual(['Marble 0.1-plus'])
    expect(models.get('marble-1.0-draft')?.aliases).toEqual(['Marble 0.1-mini'])
    expect(models.get('marble-1.1-plus')?.aliases).toEqual([])
  })
})

describe('worldlabs listModels', () => {
  it('lists the public catalog without an API key', async () => {
    globalThis.fetch = ((url: string) => {
      const body =
        String(url) === WORLDLABS_MODELS_URL ? MODELS_PAGE : PRICING_PAGE
      return Promise.resolve(new Response(body))
    }) as typeof fetch

    const result = await provider.listModels({})
    expect(result.skipped).toBeUndefined()
    expect(result.models.map((model) => model.rawId)).toEqual([
      'marble-1.1-plus',
      'marble-1.1',
      'marble-1.0',
      'marble-1.0-draft',
    ])
    expect(result.models.every((model) => model.activity === 'world')).toBe(
      true,
    )
    const plus = result.models.find(
      (model) => model.rawId === 'marble-1.1-plus',
    )
    const standard = result.models.find((model) => model.rawId === 'marble-1.1')
    expect(plus?.pricing).toBeUndefined()
    expect(standard?.pricing).toMatchObject({
      price: {
        lookup: {
          table: 'rate',
          keys: [{ var: 'world_prompt_kind' }],
        },
      },
    })
  })
})

describe('worldlabs fetchSpec', () => {
  it('loads the public Marble document and bundles every covered path', async () => {
    const spec: OpenApiDocument = {
      openapi: '3.1.0',
      info: { title: 'Marble Public API v1', version: '1.0.0' },
      paths: {
        '/marble/v1/worlds:generate': operation('Generate World', 'post'),
        '/marble/v1/worlds/{world_id}': operation('Get World', 'get'),
        '/marble/v1/worlds/{world_id}:export': operation(
          'Export World',
          'post',
        ),
        '/marble/v1/worlds:list': operation('List Worlds', 'post'),
        '/marble/v1/operations/{operation_id}': operation(
          'Get Operation',
          'get',
        ),
        '/marble/v1/media-assets:prepare_upload': operation(
          'Prepare upload',
          'post',
        ),
        '/marble/v1/media-assets/{media_asset_id}': operation(
          'Get Media Asset',
          'get',
        ),
        '/marble/v1/pano:depth_to_rgb': operation('Pano Depth To Rgb', 'post'),
        '/marble/v1/credits': operation('Get Credits', 'get'),
        '/marble/v1/admin': operation('Admin', 'get'),
      },
    }
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      return Promise.resolve(new Response(JSON.stringify(spec)))
    }) as typeof fetch

    const fetched = await provider.fetchSpec({})
    expect(urls).toEqual([WORLDLABS_OPENAPI_URL])
    const { endpoints, warnings } = classifyAndBundle(provider, fetched)
    expect(warnings).toEqual([])
    expect(endpoints.map((endpoint) => endpoint.path).sort()).toEqual([
      '/marble/v1/credits',
      '/marble/v1/media-assets/{media_asset_id}',
      '/marble/v1/media-assets:prepare_upload',
      '/marble/v1/operations/{operation_id}',
      '/marble/v1/pano:depth_to_rgb',
      '/marble/v1/worlds/{world_id}',
      '/marble/v1/worlds/{world_id}:export',
      '/marble/v1/worlds:generate',
      '/marble/v1/worlds:list',
    ])
    expect(endpoints.every((endpoint) => endpoint.activity === 'world')).toBe(
      true,
    )
    expect(
      provider.generationEndpointId?.({
        rawId: 'marble-1.1',
        activity: 'world',
      }),
    ).toBe('marble/v1/worlds:generate')
  })
})
