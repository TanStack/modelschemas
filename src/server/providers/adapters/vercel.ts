/**
 * Vercel AI Gateway — public model list at ai-gateway.vercel.sh.
 * Token prices there are USD per token. A zero price is free, not a card.
 * Context-length tiers are the standard schedule. fast, flex, priority,
 * regional, and peak are not. Effort values are stored when the row
 * publishes them. A missing price stays null.
 *
 * A row with `pricing.varies_by_provider` has no single billed price:
 * "By default, AI Gateway dynamically chooses providers based on recent
 * uptime and latency" (docs/ai-gateway/models-and-providers/
 * provider-filtering-and-ordering), and each route bills its own rate
 * (`/v1/models/{id}/endpoints`). The top-level price is one route's, not
 * the cheapest or a stated default (reflection/beam quotes its free route,
 * alibaba/qwen-3-235b its vertex route over a cheaper deepinfra one), so
 * those rows store no card and say why (`absent.pricing: cleared`).
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'

import { SHARED_EFFORT_LEVELS } from '../request-map.ts'
import type {
  ChatRequestMap,
  EffortLevelMap,
  ThinkingRequest,
} from '../request-map.ts'
import { bearerConnect } from '../connect.ts'
import { compatGenerationEndpointId } from '../model-meta.ts'
import {
  classifyOpenAiCompat,
  fetchOpenAiCompatibleSpec,
} from '../openai-compat.ts'
import { fetchJson, sha256Text } from '../types.ts'
import { namespacedUpstreamIdentity } from '../upstream-model.ts'
import type {
  FactSource,
  ListModelsResult,
  ModelInfo,
  ModelReasoning,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const VERCEL_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models'

/**
 * The data plane (docs/ai-gateway/sdks-and-apis). Vercel publishes no
 * OpenAPI document; the routes it documents as OpenAI-compatible are
 * generated from OpenAI's.
 */
export const VERCEL_SERVER_URL = 'https://ai-gateway.vercel.sh/v1'

const TYPE_ACTIVITY: Record<string, Activity> = {
  language: 'chat',
  embedding: 'embeddings',
  image: 'image',
  video: 'video',
  speech: 'audio',
  transcription: 'audio',
}

/** Listing `supported_parameters` names that are catalog flags. */
const PARAMETER_FLAGS: Record<string, string> = {
  tools: 'tools',
  tool_choice: 'tool_choice',
  max_tokens: 'max_tokens',
  max_completion_tokens: 'max_tokens',
  temperature: 'temperature',
  top_p: 'top_p',
  top_k: 'top_k',
  stop: 'stop',
  seed: 'seed',
  frequency_penalty: 'frequency_penalty',
  presence_penalty: 'presence_penalty',
  response_format: 'response_format',
  reasoning: 'reasoning',
  include_reasoning: 'include_reasoning',
  reasoning_effort: 'reasoning_effort',
  structured_outputs: 'structured_outputs',
}

const TOKEN_LEVERS = [
  ['input', 'input_tokens'],
  ['output', 'output_tokens'],
  ['input_cache_read', 'cache_read_tokens'],
  ['input_cache_write', 'cache_write_tokens'],
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

function stringList(value: unknown): Array<string> | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const out: Array<string> = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    out.push(item)
  }
  return out
}

/** USD per token. Zero is free, not a billed rate. */
function perToken(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value
  }
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function modalities(value: unknown): ModelInfo['modalities'] {
  if (!isRecord(value)) return null
  const input = stringList(value.input)
  const output = stringList(value.output)
  if (!input || !output) return null
  return { input, output }
}

/**
 * The Chat Completions field behind a toggle or budget row
 * (vercel.com/docs/ai-gateway/models-and-providers/reasoning, "How
 * reasoning is mapped"). Effort rows carry no source of their own.
 */
function controlField(reasoning: ModelReasoning | null): string | null {
  if (reasoning?.mode === 'toggle') return 'reasoning.enabled'
  return reasoning?.mode === 'budget' ? 'reasoning.max_tokens' : null
}

/**
 * The controls the gateway row lists in `reasoning_options`. An `effort`
 * entry is an effort row. Without one: `toggle` "identifies an on/off
 * control", so a row that lists it can turn reasoning off; a
 * `budget_tokens` entry alone leaves that unstated. A row with a control
 * type this does not know stores nothing.
 */
export function vercelReasoning(
  row: Record<string, unknown>,
): ModelReasoning | null {
  const options = Array.isArray(row.reasoning_options)
    ? row.reasoning_options.filter(isRecord)
    : []
  const toggle = options.some((option) => option.type === 'toggle')
  const effort = options.find((option) => option.type === 'effort')
  const efforts = effort ? stringList(effort.values) : null
  if (efforts) {
    return {
      mode: 'effort',
      mandatory:
        !toggle && !efforts.includes('none') && !efforts.includes('off'),
      efforts,
    }
  }
  const types = options.map((option) => option.type)
  if (types.some((type) => type !== 'toggle' && type !== 'budget_tokens')) {
    return null
  }
  if (types.includes('budget_tokens')) {
    return { mode: 'budget', mandatory: toggle ? false : null }
  }
  return toggle ? { mode: 'toggle', mandatory: false } : null
}

interface PriceTier {
  min: number
  max: number | null
  cost: number
}

function readTiers(
  rawId: string,
  key: string,
  value: unknown,
): Array<PriceTier> | null {
  if (value == null) return null
  if (!Array.isArray(value)) {
    throw new Error(`vercel: ${rawId} pricing.${key}_tiers is not an array`)
  }
  const tiers: Array<PriceTier> = []
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new Error(
        `vercel: ${rawId} pricing.${key}_tiers entry is not an object`,
      )
    }
    const cost = perToken(entry.cost)
    const min = entry.min === undefined ? 0 : entry.min
    const max = entry.max === undefined ? null : entry.max
    if (
      cost === null ||
      typeof min !== 'number' ||
      !Number.isFinite(min) ||
      min < 0 ||
      (max !== null &&
        (typeof max !== 'number' || !Number.isFinite(max) || max <= min))
    ) {
      throw new Error(
        `vercel: ${rawId} pricing.${key}_tiers entry is unreadable`,
      )
    }
    tiers.push({ min, max, cost })
  }
  tiers.sort((a, b) => a.min - b.min)
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i]
    const next = tiers[i + 1]
    if (!tier) continue
    if (i > 0 && tier.min === tiers[i - 1]?.min) {
      throw new Error(`vercel: ${rawId} pricing.${key}_tiers repeats a min`)
    }
    if (next) {
      if (tier.max === null || tier.max !== next.min) {
        throw new Error(
          `vercel: ${rawId} pricing.${key}_tiers ranges do not meet`,
        )
      }
    } else if (tier.max !== null) {
      throw new Error(
        `vercel: ${rawId} pricing.${key}_tiers does not cover every longer prompt`,
      )
    }
  }
  return tiers
}

/** Cost of the tier that contains `tokens`, or null when none does. */
function rateAt(tiers: Array<PriceTier>, tokens: number): number | null {
  let found: PriceTier | null = null
  for (const tier of tiers) {
    if (tier.min <= tokens && (tier.max === null || tokens < tier.max)) {
      if (!found || tier.min >= found.min) found = tier
    }
  }
  return found?.cost ?? null
}

/**
 * Standard token card. `input_tiers` and the cache tier arrays re-quote
 * that schedule above a prompt size. Vercel's `min` is inclusive;
 * `compileTokenCard` applies a tier only when the prompt is strictly above
 * `minPromptTokens`, so the stored threshold is `min - 1`.
 */
function tokenCard(
  rawId: string,
  pricing: Record<string, unknown>,
  source: RateCard['source'],
): RateCard | null {
  const base: Record<string, number> = {}
  const tiersByLever = new Map<string, Array<PriceTier>>()
  for (const [key, lever] of TOKEN_LEVERS) {
    const rate = perToken(pricing[key])
    if (rate !== null) base[lever] = rate
    const tiers = readTiers(rawId, key, pricing[`${key}_tiers`])
    if (!tiers || tiers.length === 0) continue
    const floor = tiers.find((tier) => tier.min === 0)
    if (floor && rate !== null && floor.cost !== rate) {
      throw new Error(
        `vercel: ${rawId} pricing.${key} disagrees with its first tier`,
      )
    }
    if (rate === null) {
      throw new Error(
        `vercel: ${rawId} pricing.${key}_tiers has no base ${key}`,
      )
    }
    tiersByLever.set(lever, tiers)
  }
  if (base.input_tokens === undefined || base.output_tokens === undefined) {
    return null
  }
  const thresholds = new Set<number>()
  for (const tiers of tiersByLever.values()) {
    for (const tier of tiers) {
      if (tier.min > 0) thresholds.add(tier.min)
    }
  }
  const tokenTiers = [...thresholds]
    .sort((a, b) => a - b)
    .map((min) => {
      const rates: Record<string, number> = {}
      for (const [lever, tiers] of tiersByLever) {
        const at = rateAt(tiers, min)
        if (at === null) {
          throw new Error(
            `vercel: ${rawId} pricing tier at ${min} does not cover ${lever}`,
          )
        }
        rates[lever] = at
      }
      return { minPromptTokens: min - 1, rates }
    })
  return compileTokenCard(base, tokenTiers, source)
}

function parameterNames(rawId: string, value: unknown): Array<string> | null {
  if (value == null) return null
  if (!Array.isArray(value)) {
    throw new Error(
      `vercel: ${rawId} supported_parameters is not a string array`,
    )
  }
  const names: Array<string> = []
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(
        `vercel: ${rawId} supported_parameters is not a string array`,
      )
    }
    names.push(item)
  }
  return names
}

function capabilityFlags(names: Array<string>): Array<string> {
  const flags: Array<string> = []
  const seen = new Set<string>()
  for (const name of names) {
    const flag = PARAMETER_FLAGS[name]
    if (!flag || seen.has(flag)) continue
    seen.add(flag)
    flags.push(flag)
  }
  return flags
}

/**
 * Chat Completions body for the controls this row lists
 * (vercel.com/docs/ai-gateway/models-and-providers/reasoning, "How
 * reasoning is mapped"). `on` is effort high, and only when the row lists
 * `high`. A toggle is `reasoning.enabled`. A budget names no high token
 * count, so it adds no thinking body.
 */
function thinkingFor(
  options: Array<Record<string, unknown>>,
): ThinkingRequest | null {
  const effort = options.find((option) => option.type === 'effort')
  const values = effort ? stringList(effort.values) : null
  const toggle = options.some((option) => option.type === 'toggle')
  if (values?.includes('high')) {
    const off = values.includes('none')
      ? 'none'
      : values.includes('off')
        ? 'off'
        : null
    const levels = Object.fromEntries(
      SHARED_EFFORT_LEVELS.map((level) => [
        level,
        level === 'off' ? off : values.includes(level) ? level : null,
      ]),
    ) as EffortLevelMap
    return {
      on: { reasoning: { effort: 'high' } },
      off: off
        ? { reasoning: { effort: off } }
        : toggle
          ? { reasoning: { enabled: false } }
          : null,
      levels,
    }
  }
  // Effort values with no `high` have no "on at high" body. The toggle,
  // when the row also lists one, is the on/off control.
  if (toggle) {
    return {
      on: { reasoning: { enabled: true } },
      off: { reasoning: { enabled: false } },
      levels: null,
    }
  }
  return null
}

function chatRequest(
  activity: Activity | null,
  names: Array<string> | null,
  options: Array<Record<string, unknown>>,
): ChatRequestMap | null {
  if (activity !== 'chat') return null
  const params = names ?? []
  const maxTokensField = params.includes('max_completion_tokens')
    ? 'max_completion_tokens'
    : params.includes('max_tokens')
      ? 'max_tokens'
      : null
  const thinking = thinkingFor(options)
  if (maxTokensField === null && thinking === null) return null
  return {
    thinking,
    maxTokensField,
    developerRole: null,
    replayReasoningContent: null,
    store: null,
    strictTools: null,
    sessionAffinity: null,
    cacheControl: null,
    toolStream: null,
    reasoningEffort: null,
  }
}

function listed(source: RateCard['source'], path: string): FactSource {
  return {
    derivation: 'listing',
    sourceUrl: source.url,
    sourceHash: source.hash,
    path,
  }
}

export function parseVercelModels(
  payload: unknown,
  source: RateCard['source'],
): Array<ModelInfo> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('vercel: models payload has no data array')
  }
  const models: Array<ModelInfo> = []
  for (const row of payload.data) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) {
      continue
    }
    const pricing = isRecord(row.pricing) ? row.pricing : null
    const variesByRoute = pricing?.varies_by_provider === true
    const card =
      pricing && !variesByRoute ? tokenCard(row.id, pricing, source) : null
    const activity =
      typeof row.type === 'string' ? (TYPE_ACTIVITY[row.type] ?? null) : null
    const reasoning = vercelReasoning(row)
    const field = controlField(reasoning)
    const names = parameterNames(row.id, row.supported_parameters)
    const flags = names ? capabilityFlags(names) : null
    const options = Array.isArray(row.reasoning_options)
      ? row.reasoning_options.filter(isRecord)
      : []
    const requestMap = chatRequest(activity, names, options)
    const factSources: NonNullable<ModelInfo['factSources']> = {}
    if (card) factSources.pricing = listed(source, 'pricing')
    if (flags && flags.length > 0 && names) {
      const seen = new Set<string>()
      factSources.capabilities = {}
      for (const name of names) {
        const flag = PARAMETER_FLAGS[name]
        if (!flag || seen.has(flag)) continue
        seen.add(flag)
        factSources.capabilities[flag] = listed(
          source,
          `supported_parameters.${name}`,
        )
      }
    }
    if (field) factSources.reasoning = listed(source, field)
    models.push({
      rawId: row.id,
      displayName: typeof row.name === 'string' ? row.name : null,
      activity,
      contextWindow: positive(row.context_window),
      maxOutput: positive(row.max_tokens),
      modalities: modalities(row.modalities),
      pricing: card,
      ...(flags ? { capabilities: flags, exactCapabilities: true } : {}),
      reasoning,
      ...(requestMap ? { requestMap } : {}),
      releasedAt: positive(row.released),
      ...(variesByRoute ? { absent: { pricing: 'cleared' as const } } : {}),
      ...(Object.keys(factSources).length > 0 ? { factSources } : {}),
    })
  }
  if (models.length === 0) {
    throw new Error('vercel: models payload listed no ids')
  }
  return models
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const payload = await fetchJson(VERCEL_MODELS_URL)
  const text = JSON.stringify(payload)
  return {
    models: parseVercelModels(payload, {
      url: VERCEL_MODELS_URL,
      hash: await sha256Text(text),
      extractedAt: new Date().toISOString(),
    }),
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, url, hash } = await fetchOpenAiCompatibleSpec({
    title: 'Vercel AI Gateway',
    serverUrl: VERCEL_SERVER_URL,
    // openai-chat-completions (chat, embeddings), responses, and
    // image-generation ("Image-only models" use the Images endpoints).
    include: [
      '/chat/completions',
      '/responses',
      '/embeddings',
      '/images/generations',
      '/images/edits',
    ],
  })
  return {
    specs: [spec],
    sources: [{ url, hash }],
    outputStrategy: 'post-200',
  }
}

export const provider: ProviderConfig = {
  id: 'vercel',
  upstreamModelIdentity: (rawId) =>
    namespacedUpstreamIdentity(rawId, {
      derivation: 'listing',
      sourceUrl: VERCEL_MODELS_URL,
      path: 'data[].id',
    }),
  displayName: 'Vercel AI Gateway',
  specSourceUrl: 'https://vercel.com/docs/ai-gateway',
  modelsEndpoint: VERCEL_MODELS_URL,
  defaultDerivation: 'generated',
  connect: bearerConnect(VERCEL_SERVER_URL),
  fetchSpec,
  listModels,
  classify: classifyOpenAiCompat,
  generationEndpointId: ({ activity }) => compatGenerationEndpointId(activity),
}
