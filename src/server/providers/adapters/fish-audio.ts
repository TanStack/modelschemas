/**
 * Fish Audio — TTS, speech-to-text, voice design and voice models (issue
 * #622). The REST OpenAPI 3.1 document is published at
 * docs.fish.audio/api-reference/openapi.json (linked from llms.txt).
 *
 * There is no keyless model listing: `GET /model` lists voices, and the
 * TTS/ASR model is chosen per request with the `model` HTTP header. The
 * public pricing page has one table row per model, so it is both the
 * catalog and the price source. `transcribe-stream-1` is WebSocket only,
 * so it binds no HTTP endpoint.
 */
import { compileUnitCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'
import { bearerConnect } from '../connect.ts'
import { tagDocsFacts } from '../fact-sources.ts'
import { normalizeMediaModalities } from '../media-modalities.ts'
import { assertParsed, markdownTableRows, parseDay } from '../model-facts.ts'
import { fetchOpenApi, fetchText, sha256Text } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const FISH_AUDIO_OPENAPI_URL =
  'https://docs.fish.audio/api-reference/openapi.json'
export const FISH_AUDIO_PRICING_URL =
  'https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits.md'
export const FISH_AUDIO_API_BASE = 'https://api.fish.audio'

/** POST routes served. `/model` POST creates a voice model. */
const AUDIO_PATHS = new Set([
  '/v1/tts',
  '/v1/tts/stream/with-timestamp',
  '/v1/asr',
  '/v1/voice-design',
  '/model',
])

/** Pricing-page section → the route its models are called on. */
const SECTIONS = [
  { heading: 'Text-to-Speech (TTS) Models', route: 'v1/tts' },
  { heading: 'Automatic Speech Recognition (ASR) Models', route: 'v1/asr' },
  { heading: 'Voice Design', route: 'v1/voice-design' },
] as const

/** WebSocket-only models: listed and priced, no HTTP route. */
const WEBSOCKET_ONLY = new Set(['transcribe-stream-1'])

/** Published price unit → the usage lever it bills and its divisor. */
const UNITS: Record<string, { param: string | null; per: number }> = {
  'M UTF-8 bytes': { param: 'utf8_bytes', per: 1_000_000 },
  'audio hour': { param: 'audio_seconds', per: 3600 },
  'session hour': { param: 'session_seconds', per: 3600 },
  'successful API request': { param: null, per: 1 },
}

const PRICE = /^\\?\$([\d,]*\.?\d+)\s*\/\s*(.+)$/
const PROMO =
  /Through ([A-Z][a-z]+ \d{1,2}, \d{4})\s+\(until [^)]*?(\d{2}):(\d{2})\s+UTC\),\s+`([^`]+)`\s+is\s+billed\s+at\s+a\s+launch\s+promotion\s+price\s+of\s+\\?\$([\d.]+)\s*\/\s*([^,.]+?)\s*,/g
const DAY_MS = 86_400_000

export interface FishAudioRow {
  rawId: string
  route: (typeof SECTIONS)[number]['route']
  unit: string
  usd: number
  /** Launch promotion: the billed rate until `endsAt` (epoch ms). */
  promo?: { usd: number; endsAt: number }
}

function section(page: string, heading: string): string {
  const start = page.indexOf(`### ${heading}\n`)
  if (start < 0) throw new Error(`fish-audio pricing: no ${heading} section`)
  const rest = page.slice(start + heading.length + 5)
  const end = rest.search(/\n##+ /)
  return end < 0 ? rest : rest.slice(0, end)
}

/** Every model row on the pricing page. Unreadable rows throw. */
export function parseFishAudioPricing(page: string): Map<string, FishAudioRow> {
  const rows = new Map<string, FishAudioRow>()
  for (const { heading, route } of SECTIONS) {
    for (const cells of markdownTableRows(section(page, heading))) {
      const rawId = /`([^`]+)`/.exec(cells[0] ?? '')?.[1]
      if (!rawId) continue
      const price = PRICE.exec((cells[1] ?? '').trim())
      const unit = price?.[2]?.trim()
      if (!price?.[1] || !unit || !(unit in UNITS)) {
        throw new Error(`fish-audio pricing: ${rawId} has an unread price`)
      }
      if (rows.has(rawId)) {
        throw new Error(`fish-audio pricing: ${rawId} is listed twice`)
      }
      rows.set(rawId, {
        rawId,
        route,
        unit,
        usd: Number(price[1].replace(/,/g, '')),
      })
    }
  }
  let promos = 0
  for (const match of page.matchAll(PROMO)) {
    const [, through, hh, mm, rawId, usd, unit] = match
    const day = parseDay(through ?? '')
    const row = rows.get(rawId ?? '')
    if (day === null || !row || unit?.trim() !== row.unit) {
      throw new Error(`fish-audio pricing: unreadable promotion for ${rawId}`)
    }
    row.promo = {
      usd: Number(usd),
      endsAt: day + DAY_MS + (Number(hh) * 60 + Number(mm)) * 60_000,
    }
    promos++
  }
  // A promotion the regex missed would quote the list price as billed.
  const stated = page.match(/launch promotion price/g)?.length ?? 0
  if (stated !== promos) {
    throw new Error('fish-audio pricing: a promotion sentence did not parse')
  }
  return rows
}

/** The card billed at `now`: the promotion while it runs, else list. */
export function fishAudioCard(
  row: FishAudioRow,
  source: Omit<RateCard['source'], 'expiresAt'>,
  now: number,
): RateCard | null {
  const promo = row.promo && now < row.promo.endsAt ? row.promo : null
  const usd = promo ? promo.usd : row.usd
  const { param, per } = UNITS[row.unit] ?? { param: null, per: 1 }
  const sourced = promo
    ? { ...source, expiresAt: new Date(promo.endsAt).toISOString() }
    : source
  if (usd === 0) {
    // A published $0 rate is a free card, not an unknown price.
    return {
      inputs: param
        ? { [param]: { param, bound: 'usage', kind: 'number' } }
        : {},
      tables: {},
      price: 0,
      examples: [],
      source: sourced,
    }
  }
  return compileUnitCard(
    {
      ...(param && { quantity: { param, bound: 'usage' as const } }),
      // 0.36 / 3600 is 0.00009999999999999999: drop the float noise.
      rates: Number((usd / per).toPrecision(12)),
    },
    sourced,
  )
}

function modalities(route: FishAudioRow['route']) {
  const asr = route === 'v1/asr'
  return normalizeMediaModalities({
    activity: 'audio',
    listingInput: asr ? ['audio'] : ['text'],
    listingOutput: asr ? ['text'] : ['audio'],
  })
}

function classify(path: string): Activity | null {
  return AUDIO_PATHS.has(path.split('?')[0] ?? path) ? 'audio' : null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(FISH_AUDIO_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: FISH_AUDIO_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const page = await fetchText(FISH_AUDIO_PRICING_URL)
  const rows = parseFishAudioPricing(page)
  assertParsed(rows, 'fish-audio pricing page')
  const hash = await sha256Text(page)
  const source = {
    url: FISH_AUDIO_PRICING_URL,
    hash,
    extractedAt: new Date().toISOString(),
  }
  const now = Date.now()
  const models: Array<ModelInfo> = [...rows.values()].map((row) => {
    const pricing = fishAudioCard(row, source, now)
    const mods = modalities(row.route)
    return {
      rawId: row.rawId,
      displayName: null,
      activity: 'audio',
      schemaEndpointId: WEBSOCKET_ONLY.has(row.rawId) ? null : row.route,
      modalities: mods,
      pricing,
      factSources: tagDocsFacts(
        { pricing, modalities: mods },
        FISH_AUDIO_PRICING_URL,
        hash,
      ),
    }
  })
  return { models }
}

export const provider: ProviderConfig = {
  id: 'fish-audio',
  displayName: 'Fish Audio',
  authEnvVar: 'FISH_AUDIO_API_KEY',
  specSourceUrl: FISH_AUDIO_OPENAPI_URL,
  modelsEndpoint: FISH_AUDIO_PRICING_URL,
  defaultDerivation: 'upstream-spec',
  connect: { ...bearerConnect(FISH_AUDIO_API_BASE), modelHeader: 'model' },
  fetchSpec,
  listModels,
  classify,
}
