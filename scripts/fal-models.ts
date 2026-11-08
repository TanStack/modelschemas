/**
 * FAL's model listing for scripts: the request properties an extract may
 * bind come from the endpoint's own OpenAPI document, as the bound schema
 * has them. Shared by `compare-fal-extract-models.ts` and
 * `fal-extract-smoke.ts`.
 */
import { execFileSync } from 'node:child_process'

import { requestSchemaPropertyNames } from '../src/server/providers/fact-sources.ts'

/** `name` from the environment, else Doppler `modelschemas/dev`. */
export function secret(name: string): string {
  const fromEnv = process.env[name]
  if (fromEnv) return fromEnv
  return execFileSync(
    'doppler',
    ['secrets', 'get', name, '--plain', '-p', 'modelschemas', '-c', 'dev'],
    { encoding: 'utf8' },
  ).trim()
}

const FAL_MODELS_URL = 'https://api.fal.ai/v1/models'

export interface FalModel {
  endpoint_id: string
  openapi?: {
    paths?: Record<string, { post?: { requestBody?: unknown } }>
    components?: { schemas?: Record<string, unknown> }
  }
}

export async function falModels(
  params: URLSearchParams,
): Promise<Array<FalModel>> {
  const key = secret('FAL_KEY')
  const models: Array<FalModel> = []
  let cursor: string | null = null
  do {
    if (cursor) params.set('cursor', cursor)
    const response = await fetch(`${FAL_MODELS_URL}?${params.toString()}`, {
      headers: { Authorization: `Key ${key}` },
    })
    if (!response.ok) throw new Error(`fal models ${response.status}`)
    const page = (await response.json()) as {
      models: Array<FalModel>
      has_more: boolean
      next_cursor: string | null
    }
    models.push(...page.models)
    cursor = page.has_more ? page.next_cursor : null
  } while (cursor)
  return models
}

/** Top-level input fields of the endpoint's POST body, as the bound schema has them. */
export async function requestPropertiesOf(rawId: string): Promise<Set<string>> {
  const params = new URLSearchParams({
    endpoint_id: rawId,
    expand: 'openapi-3.0',
  })
  const [model] = await falModels(params)
  if (!model) throw new Error(`fal models: ${rawId} not listed`)
  const spec = model.openapi
  const post = Object.values(spec?.paths ?? {}).find((op) => op.post)?.post
  let schema: unknown = (
    post?.requestBody as
      | { content?: Record<string, { schema?: unknown }> }
      | undefined
  )?.content?.['application/json']?.schema
  const ref = (schema as { $ref?: string } | undefined)?.$ref
  if (ref) schema = spec?.components?.schemas?.[ref.split('/').pop() ?? '']
  return requestSchemaPropertyNames(schema)
}
