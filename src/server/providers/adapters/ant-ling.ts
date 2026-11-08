/** Dynamic direct Ant Ling facts; never reseller prices or borrowed schemas. */
import { cachedDocs } from '../model-facts.ts'
import { tagDocsFacts } from '../fact-sources.ts'
import { bearerConnect } from '../connect.ts'
import { sha256Text } from '../types.ts'
import { SHARED_EFFORT_LEVELS } from '../request-map.ts'
import type { ChatRequestMap, EffortLevelMap } from '../request-map.ts'
import type {
  ModelInfo,
  ProviderConfig,
  ProviderEnvironment,
} from '../types.ts'
import {
  ANT_OPENAI,
  ANT_OVERVIEW,
  ANT_PRICE,
  ANT_LING,
  ANT_EFFORT,
  text,
  article,
  controls,
  blocks,
  overviewContextIds,
  antModelRows,
  nativeModelIds,
  nativePriceTable,
  priceCards,
  nativeContexts,
  nativeFields,
  nativeRequest,
  antSpec,
} from '../ant-ling-docs.ts'

function validateNativeArticle(html: string): void {
  if (
    /window\.netd\s*=|id=["']netd-iframe["']|waf\.alipay\.com\/api\/v1\/sec-human-appeal/.test(
      html,
    )
  )
    throw new Error('native documentation blocked by Alipay WAF/captcha')
  article(html)
}

const INPUT_WORDS: Record<string, string> = {
  text: 'text',
  images: 'image',
  videos: 'video',
  audio: 'audio',
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function browserHtml(
  url: string,
  env: ProviderEnvironment,
): Promise<string> {
  if (!env.BROWSER || typeof env.BROWSER.quickAction !== 'function')
    throw new Error('Cloudflare Browser Rendering BROWSER binding is required')
  const response = await env.BROWSER.quickAction('content', {
    url,
    gotoOptions: { timeout: 30_000, waitUntil: 'domcontentloaded' },
    actionTimeout: 30_000,
  })
  if (!response.ok)
    throw new Error(
      `Cloudflare Browser Rendering request failed: HTTP ${response.status}`,
    )
  const body: unknown = await response.json()
  if (
    !record(body) ||
    body.success !== true ||
    typeof body.result !== 'string' ||
    !record(body.meta)
  )
    throw new Error('unreadable Cloudflare Browser Rendering content response')
  const meta = body.meta
  if (
    typeof meta.status !== 'number' ||
    !Number.isInteger(meta.status) ||
    meta.status < 200 ||
    meta.status >= 300
  )
    throw new Error(
      `Cloudflare Browser Rendering native page failed: status ${String(meta.status)}`,
    )
  if (
    typeof meta.finalUrl !== 'string' ||
    new URL(meta.finalUrl).href !== new URL(url).href
  )
    throw new Error('Cloudflare Browser Rendering native page URL mismatch')
  return body.result
}

async function load(url: string, env: ProviderEnvironment, kv?: KVNamespace) {
  try {
    if (!env.BROWSER || typeof env.BROWSER.quickAction !== 'function')
      throw new Error(
        'Cloudflare Browser Rendering BROWSER binding is required',
      )
    const doc = await cachedDocs(
      kv,
      `ant-ling:${url}#cloudflare-browser-content-v1`,
      async () => {
        const html = await browserHtml(url, env)
        validateNativeArticle(html)
        return { html, hash: await sha256Text(html) }
      },
    )
    validateNativeArticle(doc.html)
    return doc
  } catch (error) {
    throw new Error(
      `ant-ling: native source ${url}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}
export const provider: ProviderConfig = {
  id: 'ant-ling',
  displayName: 'Ant Ling',
  specSourceUrl: ANT_OPENAI,
  modelsEndpoint: ANT_PRICE,
  defaultDerivation: 'docs-derived',
  bindSyncedRoutesOnly: true,
  perModelSchemaFlags: ['reasoning'],
  connect: bearerConnect('https://api.ant-ling.com'),
  async listModels(env, kv) {
    // Sequential cache misses keep browser requests within session capacity.
    const sources = []
    for (const url of [
      ANT_OPENAI,
      ANT_OVERVIEW,
      ANT_PRICE,
      ANT_LING,
      ANT_EFFORT,
    ])
      sources.push(await load(url, env, kv))
    const [api, overview, pricing, ling, effort] = sources
    if (!api || !overview || !pricing || !ling || !effort)
      throw new Error('ant-ling: missing loaded source')
    const overviewIds = overviewContextIds(overview.html)
    const contexts = nativeContexts(overview.html, ling.html)
    const { tokens: quotes, perImage } = nativePriceTable(pricing.html)
    const cards = priceCards(quotes, {
      url: ANT_PRICE,
      hash: pricing.hash,
      extractedAt: new Date().toISOString(),
    })
    const control = controls(api.html)
    const fields = nativeFields(api.html)
    const schema = nativeRequest(api.html)
    const properties = schema.properties as Record<string, unknown>
    const role = fields.get('messages.role')
    if (!role) throw new Error('ant-ling: missing native role declaration')
    const apiIds = new Set(nativeModelIds(api.html))
    const nativePaths = Object.keys(antSpec(api.html).paths)
    if (nativePaths.length !== 1 || !nativePaths[0])
      throw new Error('ant-ling: unreadable native API route')
    const nativeEndpointId = nativePaths[0].replace(/^\//, '')
    const apiOverview = text(article(overview.html))
    // "When using <id>, the request accepts text, images, and videos." — one
    // statement per model that takes more than text. Since 2026-10-27 a model
    // may read "natively accepts <list> with native multimodal understanding."
    const accepts = new Map(
      [
        ...text(fields.get('model') ?? '').matchAll(
          /When using ([\w.-]+)\s*, the request (?:natively )?accepts ([^.]+?)(?: with native multimodal understanding)?\./g,
        ),
      ].map(([, id = '', list = '']) => [
        id,
        list.split(/,\s*(?:and\s+)?|\s+and\s+/).map((word) => {
          const modality = INPUT_WORDS[word]
          if (!modality)
            throw new Error(
              `ant-ling: unreadable native input modality ${word}`,
            )
          return modality
        }),
      ]),
    )
    if (
      !accepts.size ||
      accepts.size !==
        text(fields.get('model') ?? '').split('When using ').length - 1 ||
      [...accepts.keys()].some((id) => !apiIds.has(id))
    )
      throw new Error('ant-ling: missing native multimodal applicability')
    const levels = Object.fromEntries(
      SHARED_EFFORT_LEVELS.map((level) => [
        level,
        control.efforts.includes(level) ? level : null,
      ]),
    ) as EffortLevelMap
    const toggleOn = control.toggles.find((v) => v === 'enabled')
    const toggleOff = control.toggles.find((v) => v === 'disabled')
    if (
      !toggleOn ||
      !toggleOff ||
      (control.effortIds.length > 0 &&
        (!control.efforts.length ||
          !control.effortDefault ||
          !control.efforts.includes(control.effortDefault)))
    )
      throw new Error('ant-ling: unreadable native control values')
    const effortText = text(article(effort.html))
    if (!control.effortIds.every((id) => effortText.includes(id)))
      throw new Error('ant-ling: effort source model disagreement')
    const map: ChatRequestMap = {
      thinking: null,
      maxTokensField: 'max_tokens' in properties ? 'max_tokens' : null,
      developerRole: text(role).includes('developer') ? null : false,
      replayReasoningContent: null,
      store: null,
      strictTools: null,
      sessionAffinity: null,
      cacheControl: null,
      toolStream: null,
      reasoningEffort: null,
    }
    return {
      models: antModelRows(api.html, pricing.html, contexts).map(
        (model): ModelInfo => {
          const hasEffort = control.effortIds.includes(model.rawId)
          const hasToggle = control.toggleIds.includes(model.rawId)
          const reasoning = hasEffort
            ? {
                mode: 'effort' as const,
                mandatory: null,
                efforts: control.efforts,
              }
            : hasToggle
              ? { mode: 'toggle' as const, mandatory: false }
              : null
          const thinking = hasEffort
            ? {
                on:
                  control.effortField === 'reasoning'
                    ? { reasoning: { effort: control.effortDefault } }
                    : { reasoning_effort: control.effortDefault },
                off: null,
                levels,
              }
            : hasToggle
              ? {
                  on: { thinking: { type: toggleOn } },
                  off: { thinking: { type: toggleOff } },
                  levels: null,
                }
              : null
          const declaredText =
            apiIds.has(model.rawId) && apiOverview.includes('Text Conversation')
          // Text-only rows are sourced from the native text-conversation scope;
          // a price-only ID (a newer chat ID, a per-image Ming-Image row) has
          // no API-scoped modality statement.
          const modalities = declaredText
            ? {
                input: accepts.get(model.rawId) ?? ['text'],
                output: ['text'],
              }
            : null
          const lingDetail = text(
            blocks(article(ling.html)).get(model.rawId) ?? '',
          )
          const capabilities = declaredText
            ? ['tools', ...(reasoning ? ['reasoning'] : [])]
            : /tool calling/.test(lingDetail)
              ? [
                  'tools',
                  ...(/hybrid reasoning/.test(lingDetail) ? ['reasoning'] : []),
                ]
              : null
          const requestMap = apiIds.has(model.rawId)
            ? { ...map, thinking }
            : null
          const facts = {
            ...model,
            modalities,
            capabilities,
            pricing: cards.get(model.rawId) ?? null,
            // A per-image price is stated but no token card carries it, so
            // no reason is given: a new row stays null, and a stored card
            // hidden behind one is kept with a pricing_lost signal.
            absent:
              cards.has(model.rawId) || perImage.has(model.rawId)
                ? undefined
                : { pricing: 'cleared' as const },
            schemaEndpointId: apiIds.has(model.rawId) ? nativeEndpointId : null,
            reasoning,
            requestMap,
          }
          const contextUrl = overviewIds.has(model.rawId)
            ? ANT_OVERVIEW
            : ANT_LING
          const contextHash =
            contextUrl === ANT_OVERVIEW ? overview.hash : ling.hash
          return {
            ...facts,
            providerMetadata: {
              ...(quotes.has(model.rawId)
                ? {
                    directQuote: quotes.get(model.rawId)?.free
                      ? 'currently-free'
                      : 'paid',
                  }
                : {}),
              ...(control.effortIds.includes(model.rawId)
                ? { nativeReasoningModelSource: ANT_EFFORT }
                : {}),
            },
            factSources: {
              ...(apiIds.has(model.rawId)
                ? {
                    schemaEndpointId: {
                      derivation: 'docs-derived' as const,
                      sourceUrl: ANT_OPENAI,
                      sourceHash: api.hash,
                      path: 'Request Address + model.Options',
                    },
                  }
                : {}),
              ...tagDocsFacts(
                { contextWindow: model.contextWindow },
                contextUrl,
                contextHash,
              ),
              ...tagDocsFacts({ modalities, reasoning }, ANT_OPENAI, api.hash),
              ...(capabilities
                ? tagDocsFacts(
                    { capabilities },
                    declaredText ? ANT_OPENAI : ANT_LING,
                    declaredText ? api.hash : ling.hash,
                  )
                : {}),
              ...(requestMap
                ? {
                    requestMap: {
                      derivation: 'docs-derived' as const,
                      sourceUrl: ANT_OPENAI,
                      sourceHash: api.hash,
                      path: 'Request Body',
                    },
                  }
                : {}),
              ...(facts.pricing
                ? tagDocsFacts(
                    { pricing: facts.pricing },
                    ANT_PRICE,
                    pricing.hash,
                  )
                : {}),
            },
          }
        },
      ),
    }
  },
  async fetchSpec(env) {
    const api = await load(ANT_OPENAI, env)
    return {
      specs: [antSpec(api.html)],
      sources: [{ url: ANT_OPENAI, hash: api.hash }],
      outputStrategy: 'post-200',
    }
  },
  classify: (path) => (path === '/v1/chat/completions' ? 'chat' : null),
}
