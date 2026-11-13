/** Xiaomi MiMo: live native documentation, never another provider's catalog. */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'
import { bearerConnect } from '../connect.ts'
import {
  cachedDocs,
  docsReport,
  docsRun,
  tokenCount,
  tryDocs,
  unavailable,
} from '../model-facts.ts'
import { fetchText, sha256Text } from '../types.ts'
import type { ModelInfo, ProviderConfig, FactSource } from '../types.ts'
import {
  htmlTables,
  nativeSchemas,
  plain,
  XIAOMI_MODELS,
  XIAOMI_PRICING,
  XIAOMI_THINKING,
  XIAOMI_SCHEMA_URLS,
  xiaomiSpec,
} from '../xiaomi-docs.ts'

const IDS = /`(mimo-[a-z0-9.-]+)`/g
function fail(message: string): never {
  throw new Error(`xiaomi: ${message}`)
}
const ids = (text: string) =>
  [...text.matchAll(IDS)].map((match) => match[1] ?? '')

export function parseXiaomiModels(text: string): Array<ModelInfo> {
  const models: Array<ModelInfo> = []
  const seen = new Set<string>()
  const catalog = text.split('### Quick Selection Guide')[0] ?? text
  for (const rows of htmlTables(catalog)) {
    const header = rows[0]
    if (!header || !/Model ID/i.test(plain(header[0] ?? ''))) continue
    for (const row of rows.slice(1)) {
      if (row.length !== 4) fail('model table has an unexpected column count')
      const names = ids(row[0] ?? '')
      if (!names.length) fail('model row has no native model IDs')
      const support = plain(row[1] ?? '')
      const limits = plain(row[2] ?? '')
      const context = /Context Window:\s*([\d,.]+\s*[kKmM]?)/.exec(limits)?.[1]
      const output = /Maximum Output:\s*([\d,.]+\s*[kKmM]?)/.exec(limits)?.[1]
      if (!context || !output) fail('model row has unreadable token limits')
      const contextWindow = tokenCount(context)
      const maxOutput = tokenCount(output)
      if (
        contextWindow === null ||
        contextWindow <= 0 ||
        maxOutput === null ||
        maxOutput <= 0
      )
        fail('model row has invalid token limits')
      const capabilities: Array<string> = []
      const labels = new Map([
        ['Deep Thinking', 'reasoning'],
        ['Streaming Output', 'streaming'],
        ['Function Call', 'tools'],
        ['Structured Output', 'structured_outputs'],
      ])
      for (const [label, flag] of labels)
        if (support.includes(label)) capabilities.push(flag)
      const activity = support.includes('Text Generation')
        ? 'chat'
        : support.includes('Speech Recognition') ||
            support.includes('Speech Synthesis')
          ? 'audio'
          : null
      if (!activity) fail('unknown model generation capability')
      for (const rawId of names) {
        if (seen.has(rawId)) fail(`duplicate model ${rawId}`)
        seen.add(rawId)
        models.push({
          rawId,
          displayName: null,
          activity,
          contextWindow,
          maxOutput,
          capabilities: capabilities.length ? capabilities : null,
          modalities: support.includes('Speech Recognition')
            ? { input: ['audio'], output: ['text'] }
            : support.includes('Speech Synthesis')
              ? { input: ['text'], output: ['audio'] }
              : null,
          pricing: null,
          reasoning: null,
        })
      }
    }
  }
  if (!models.length) fail('model catalog listed no model IDs')
  return models
}

export function parseXiaomiPricing(
  text: string,
  source: RateCard['source'],
): Map<string, RateCard> {
  const overseas = text
    .split('### Overseas Pricing of the Model')[1]
    ?.split('### Pricing for Web Search Plugins')[0]
  if (!overseas) fail('pricing has no overseas USD section')
  const cards = new Map<string, RateCard>()
  for (const rows of htmlTables(overseas)) {
    const header = rows[0]?.map(plain) ?? []
    if (header.length === 5 && header[0]?.includes('Inference Type')) {
      if (
        !header[1]?.includes('Model Name') ||
        !header[2]?.includes('Input (Cache Hit)') ||
        !header[3]?.includes('Input (Cache Miss)') ||
        !header[4]?.includes('Output')
      )
        fail('USD token pricing headers changed')
      for (const row of rows.slice(1)) {
        if (row.length !== 5)
          fail('USD token pricing row has unexpected columns')
        const names = ids(row[1] ?? '')
        if (!names.length) fail('USD pricing row has no model ID')
        const rates = row.slice(2).map((cell) => {
          const match = /^\$([\d.]+)$/.exec(plain(cell))
          if (!match) fail('USD token price is unreadable')
          const rate = Number(match[1])
          if (!Number.isFinite(rate) || rate < 0)
            fail('USD token price is invalid')
          return rate / 1_000_000
        })
        const batch = plain(row[0] ?? '')
        if (!['**Real-time API**', '**Batch API**'].includes(batch))
          fail('unknown inference pricing type')
        if (batch !== '**Real-time API**') continue
        const [cache, input, output] = rates
        if (cache === undefined || input === undefined || output === undefined)
          fail('missing USD token rate')
        for (const rawId of names) {
          if (cards.has(rawId)) fail(`duplicate real-time price ${rawId}`)
          const card = compileTokenCard(
            {
              input_tokens: input,
              output_tokens: output,
              cache_read_tokens: cache,
            },
            [],
            source,
          )
          if (!card) fail(`USD price could not compile for ${rawId}`)
          cards.set(rawId, card)
        }
      }
    } else if (
      header.length === 2 &&
      header[1]?.includes('Input audio duration')
    ) {
      if (!header[0]?.includes('Model Name'))
        fail('USD audio pricing headers changed')
      for (const row of rows.slice(1)) {
        const names = ids(row[0] ?? '')
        const price = /^\$([\d.]+)\s*\/h$/.exec(plain(row[1] ?? ''))
        if (!names.length || !price) fail('USD audio price is unreadable')
        const rate = Number(price[1]) / 3600
        if (!Number.isFinite(rate) || rate < 0)
          fail('USD audio price is invalid')
        const card = compileTokenCard({ audio_seconds: rate }, [], source)
        if (!card) fail('USD audio price could not compile')
        for (const rawId of names) cards.set(rawId, card)
      }
    } else fail('unrecognized overseas pricing table')
  }
  if (!cards.size) fail('USD pricing parsed no rates')
  return cards
}

export function thinkingModels(text: string): Set<string> {
  const section = text
    .split('## Supported Models')[1]
    ?.split('## Request Parameters')[0]
  if (
    !section ||
    !/`thinking\.type`/.test(text) ||
    !/`enabled`/.test(text) ||
    !/`disabled`/.test(text)
  )
    fail('thinking controls are unreadable')
  const supported = new Set(ids(section))
  if (!supported.size) fail('thinking docs name no supported models')
  return supported
}

/** Exact model-scoped modality statement in Xiaomi's own chat schema tree. */
export function multimodalModels(text: string): Set<string> {
  const supported = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const obj = value as Record<string, unknown>
    if (typeof obj.description === 'string') {
      const named =
        /Currently, the (.+?) models support image, audio or video input\./.exec(
          obj.description,
        )?.[1]
      if (named)
        for (const match of named.matchAll(/mimo-[a-z0-9.-]+/g))
          supported.add(match[0])
    }
    Object.values(obj).forEach(visit)
  }
  nativeSchemas(text).forEach(visit)
  if (!supported.size) fail('chat docs have no model-scoped modality statement')
  return supported
}

async function load(
  url: string,
  kv?: KVNamespace,
  cached: typeof cachedDocs = cachedDocs,
) {
  return cached(kv, url, async () => {
    const text = await fetchText(url)
    return {
      text,
      hash: await sha256Text(text),
      extractedAt: new Date().toISOString(),
    }
  })
}

export const provider: ProviderConfig = {
  id: 'xiaomi',
  displayName: 'Xiaomi',
  specSourceUrl: XIAOMI_SCHEMA_URLS[0],
  modelsEndpoint: XIAOMI_MODELS,
  defaultDerivation: 'generated',
  connect: bearerConnect('https://api.xiaomimimo.com'),
  async listModels(_env, kv) {
    const chatUrl = XIAOMI_SCHEMA_URLS[0]
    if (!chatUrl) fail('missing chat schema source URL')
    // The catalog is the listing. A docs page that 404s keeps the facts it
    // supplies and the poll continues (`tryDocs`).
    const docs = docsRun()
    const [catalog, pricing, thinking, chat] = await Promise.all([
      load(XIAOMI_MODELS, kv),
      tryDocs(docs, XIAOMI_PRICING, async (cached) => {
        const doc = await load(XIAOMI_PRICING, kv, cached)
        return {
          doc,
          cards: parseXiaomiPricing(doc.text, {
            url: XIAOMI_PRICING,
            hash: doc.hash,
            extractedAt: doc.extractedAt,
          }),
          free: new Set(
            ids(
              doc.text
                .split('### Overseas Pricing of the Model')[1]
                ?.split('### Pricing for Web Search Plugins')[0]
                ?.split('Free for a limited time:')[1] ?? '',
            ),
          ),
        }
      }),
      tryDocs(docs, XIAOMI_THINKING, async (cached) => {
        const doc = await load(XIAOMI_THINKING, kv, cached)
        return { doc, supported: thinkingModels(doc.text) }
      }),
      tryDocs(docs, chatUrl, async (cached) => {
        const doc = await load(chatUrl, kv, cached)
        return { doc, multimodal: multimodalModels(doc.text) }
      }),
    ])
    const source: FactSource = {
      derivation: 'docs-derived',
      sourceUrl: XIAOMI_MODELS,
      sourceHash: catalog.hash,
    }
    return {
      models: parseXiaomiModels(catalog.text).map((model): ModelInfo => {
        const fromChat = chat?.multimodal.has(model.rawId) ?? false
        const modalities = fromChat
          ? { input: ['text', 'image', 'audio', 'video'], output: ['text'] }
          : model.modalities
        const card = pricing?.cards.get(model.rawId)
        const thinks = thinking?.supported.has(model.rawId) ?? false
        const absent = {
          ...(pricing
            ? pricing.free.has(model.rawId)
              ? { pricing: 'cleared' as const }
              : {}
            : unavailable('pricing').absent),
          ...(thinking ? {} : unavailable('reasoning').absent),
          ...(chat ? {} : unavailable('modalities').absent),
        }
        return {
          ...model,
          pricing: card ?? null,
          modalities,
          ...(Object.keys(absent).length > 0 ? { absent } : {}),
          reasoning: thinks
            ? { mode: 'toggle' as const, mandatory: false }
            : null,
          factSources: {
            contextWindow: source,
            maxOutput: source,
            ...(card && pricing
              ? {
                  pricing: {
                    derivation: 'docs-derived' as const,
                    sourceUrl: XIAOMI_PRICING,
                    sourceHash: pricing.doc.hash,
                    path: 'Overseas Pricing of the Model',
                  },
                }
              : {}),
            // Chat docs name the multimodal rows. Speech modalities are on
            // the catalog. A failed chat page states neither.
            ...(chat && modalities
              ? {
                  modalities: fromChat
                    ? {
                        derivation: 'docs-derived' as const,
                        sourceUrl: chatUrl,
                        sourceHash: chat.doc.hash,
                      }
                    : source,
                }
              : {}),
            ...(Array.isArray(model.capabilities)
              ? {
                  capabilities: Object.fromEntries(
                    (model.capabilities as Array<string>).map((flag) => [
                      flag,
                      source,
                    ]),
                  ),
                }
              : {}),
            ...(thinks && thinking
              ? {
                  reasoning: {
                    derivation: 'docs-derived' as const,
                    sourceUrl: XIAOMI_THINKING,
                    sourceHash: thinking.doc.hash,
                  },
                }
              : {}),
          },
        }
      }),
      docsFailures: docsReport(docs),
    }
  },
  async fetchSpec(_env) {
    const docs = await Promise.all(
      XIAOMI_SCHEMA_URLS.map(async (url) => ({ url, ...(await load(url)) })),
    )
    return {
      specs: [xiaomiSpec(docs)],
      sources: docs.map(({ url, hash }) => ({ url, hash })),
      outputStrategy: 'post-200',
    }
  },
  classify: (path) =>
    [
      '/v1/chat/completions',
      '/v1/responses',
      '/anthropic/v1/messages',
    ].includes(path)
      ? 'chat'
      : null,
  generationEndpointId: ({ activity }) =>
    activity === 'chat' ? 'v1/chat/completions' : null,
}
