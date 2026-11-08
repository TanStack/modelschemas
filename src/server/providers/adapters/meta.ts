/** The current Meta Model API: live provider-owned tables and schema references. */
import { cachedDocs } from '../model-facts.ts'
import { tagDocsFacts } from '../fact-sources.ts'
import { bearerConnect } from '../connect.ts'
import { fetchText, sha256Text } from '../types.ts'
import type { ProviderConfig, ModelInfo } from '../types.ts'
import {
  article,
  plain,
  tables,
  list,
  parseMetaModels,
  metaChatFamilies,
  metaFamilyUrl,
  parseMetaPricing,
  parseMetaSchemas,
  metaOperation,
  META_MODELS,
  META_PRICING,
  META_PROTOCOLS,
  META_REASONING,
  META_REFERENCE,
} from '../meta-docs.ts'

const REFERENCES = [
  { resource: 'chat-completions', operation: 'create-chat-completion' },
  { resource: 'responses', operation: 'create-response' },
  { resource: 'messages', operation: 'create-message' },
  { resource: 'images', operation: 'create-image' },
  { resource: 'images', operation: 'edit-image' },
  { resource: 'voice', operation: 'transcribe' },
]
async function load(url: string, kv?: KVNamespace) {
  return cachedDocs(kv, `meta:docs:${url}`, async () => {
    const html = await fetchText(url)
    return { html, hash: await sha256Text(html) }
  })
}
export const provider: ProviderConfig = {
  id: 'meta',
  displayName: 'Meta',
  specSourceUrl: META_REFERENCE,
  modelsEndpoint: META_MODELS,
  defaultDerivation: 'docs-derived',
  bindSyncedRoutesOnly: true,
  connect: bearerConnect('https://api.meta.ai'),
  async listModels(_env, kv) {
    const [catalog, prices, reasoning] = await Promise.all([
      load(META_MODELS, kv),
      load(META_PRICING, kv),
      load(META_REASONING, kv),
    ])
    const pages = Object.fromEntries(
      await Promise.all(
        metaChatFamilies(catalog.html).map(
          async (id) => [id, (await load(metaFamilyUrl(id), kv)).html] as const,
        ),
      ),
    )
    const models = parseMetaModels(catalog.html, pages)
    const source = {
      url: META_PRICING,
      hash: prices.hash,
      extractedAt: new Date().toISOString(),
    }
    const cards = parseMetaPricing(prices.html, models, source)
    const levels = tables(article(reasoning.html)).find(
      (rows) => rows[0]?.join('|') === 'Value|Behavior',
    )
    if (!levels) throw new Error('meta: missing reasoning effort table')
    const text = plain(article(reasoning.html))
    // '"none" disables reasoning entirely, which Muse Wonder and Muse Spark
    // do not support.' names the families whose reasoning cannot be off.
    const applies =
      /"none" disables reasoning entirely, which (.+?) (?:do|does) not support\./.exec(
        text,
      )?.[1]
    if (!applies) throw new Error('meta: unreadable reasoning applicability')
    const families = list(applies)
    if (
      levels
        .slice(1)
        .some(
          (row) =>
            row.length !== 2 || !/^"[a-z]+"$/.test(row[0] ?? '') || !row[1],
        )
    ) {
      throw new Error('meta: unreadable reasoning effort row')
    }
    const known = new Set(models.map((model) => model.rawId))
    const named = [
      ...known,
      ...models.map(
        (model) =>
          (model.providerMetadata as { family?: string }).family ?? '\u0000',
      ),
    ]
    const unreadable = (): never => {
      throw new Error('meta: unreadable reasoning effort restriction')
    }
    const ids = (clause?: string) => {
      if (clause === undefined) return undefined
      const out = list(clause)
      if (out.some((id) => !known.has(id))) unreadable()
      return out
    }
    const allows = (behavior: string, rawId: string) => {
      if (behavior.includes('Not supported')) return false
      const only = ids(
        /(?:^|\. )Supported by (.+?)(?:;|\.(?: |$))/.exec(behavior)?.[1],
      )
      const except = ids(
        /\bnot available with (.+?)(?:;|\.(?: |$))/.exec(behavior)?.[1],
      )
      if (
        !only &&
        !except &&
        (/\b(?:only|not available|supported)\b/i.test(behavior) ||
          named.some((name) => behavior.includes(name)))
      )
        unreadable()
      return (!only || only.includes(rawId)) && !except?.includes(rawId)
    }
    return {
      models: models.map((model): ModelInfo => {
        const reasons = families.includes(
          (
            (model.providerMetadata as { family?: string }).family ?? ''
          ).toLowerCase(),
        )
        const efforts = reasons
          ? levels
              .slice(1)
              .filter((row) => allows(row[1] ?? '', model.rawId))
              .map((row) => (row[0] ?? '').replace(/^"|"$/g, ''))
          : []
        if (reasons && !efforts.length)
          throw new Error('meta: no supported reasoning efforts')
        const facts = {
          ...model,
          pricing: cards.get(model.rawId) ?? null,
          reasoning: reasons
            ? { mode: 'effort' as const, mandatory: true, efforts }
            : null,
        }
        return {
          ...facts,
          absent: facts.pricing ? {} : { pricing: 'cleared' },
          factSources: {
            ...tagDocsFacts(
              {
                modalities: model.modalities,
                contextWindow: model.contextWindow,
                capabilities: model.capabilities,
              },
              META_MODELS,
              catalog.hash,
            ),
            ...(facts.pricing
              ? tagDocsFacts(
                  { pricing: facts.pricing },
                  META_PRICING,
                  prices.hash,
                )
              : {}),
            ...(facts.reasoning
              ? tagDocsFacts(
                  { reasoning: facts.reasoning },
                  META_REASONING,
                  reasoning.hash,
                )
              : {}),
          },
        }
      }),
    }
  },
  async fetchSpec(_env) {
    const [protocols, catalog] = await Promise.all([
      load(META_PROTOCOLS),
      load(META_MODELS),
    ])
    const routes =
      tables(article(protocols.html))[0]
        ?.slice(1)
        .map((row) => row[1]?.match(/^POST (\/v1\/[^ ]+)$/)?.[1]) ?? []
    if (!routes.length || routes.some((path) => !path))
      throw new Error('meta: unreadable native protocol endpoint table')
    const docs = await Promise.all(
      REFERENCES.map(async (ref) => {
        const schemaUrl = `${META_REFERENCE}${ref.resource}/schemas`
        const operationUrl = `${META_REFERENCE}${ref.resource}/${ref.operation}`
        const [schema, operation] = await Promise.all([
          load(schemaUrl),
          load(operationUrl),
        ])
        const schemas = parseMetaSchemas(schema.html)
        const parsed = metaOperation(operation.html, schemas)
        if (
          !routes.includes(parsed.path) &&
          !plain(article(catalog.html)).includes(parsed.path)
        )
          throw new Error('meta: operation absent from native protocol table')
        return {
          spec: {
            openapi: '3.1.0',
            info: { title: 'Meta native Model API', version: 'source-derived' },
            paths: { [parsed.path]: { post: parsed.operation } },
            components: { schemas },
          },
          // Each assembled document has one index-aligned provenance record.
          // Its revision covers schema types and native operation/protocol links.
          source: {
            url: schemaUrl,
            hash: await sha256Text(
              `${schema.html}\n${operation.html}\n${protocols.html}`,
            ),
          },
        }
      }),
    )
    if (
      routes.some(
        (path) =>
          !docs.some(
            (doc) =>
              path !== undefined &&
              Object.prototype.hasOwnProperty.call(doc.spec.paths, path),
          ),
      )
    ) {
      throw new Error(
        'meta: native protocol endpoint has no parsed schema resource',
      )
    }
    return {
      specs: docs.map((d) => d.spec),
      sources: docs.map((d) => d.source),
      outputStrategy: 'post-200',
    }
  },
  classify: (path) =>
    ['/v1/chat/completions', '/v1/responses', '/v1/messages'].includes(path)
      ? 'chat'
      : ['/v1/images/generations', '/v1/images/edits'].includes(path)
        ? 'image'
        : path === '/v1/asr/transcribe'
          ? 'audio'
          : null,
  generationEndpointId: ({ activity }) =>
    activity === 'chat'
      ? 'v1/chat/completions'
      : activity === 'image'
        ? 'v1/images/generations'
        : activity === 'audio'
          ? 'v1/asr/transcribe'
          : null,
}
