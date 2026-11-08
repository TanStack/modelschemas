/** Controls from AWS-hosted guides, scoped by their own model tables. */
import { nativeReasoningCapability } from './native-host-reasoning.ts'
import { tagDocsFacts } from './fact-sources.ts'
import {
  markdownSection,
  markdownTableRows,
  tryDocs,
  unavailable,
} from './model-facts.ts'
import type { DocsRun } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo, ModelReasoning } from './types.ts'

const DOCS = 'https://docs.aws.amazon.com/bedrock/latest/userguide/'
export const BEDROCK_EXTENDED_THINKING_URL = `${DOCS}claude-messages-extended-thinking.md`
export const BEDROCK_NOVA_THINKING_URL =
  'https://docs.aws.amazon.com/nova/latest/nova2-userguide/using-converse-api.md'
export const BEDROCK_ADAPTIVE_THINKING_URL = `${DOCS}claude-messages-adaptive-thinking.md`
export interface BedrockThinkingGuide {
  controls: Record<string, ModelReasoning>
  namedControls?: Record<string, ModelReasoning>
  runtimeNamedControls?: Record<string, ModelReasoning>
  url: string
  hash: string
}
export interface BedrockCardOwnedGroup {
  /** Only base IDs and profile IDs explicitly declared by this one card. */
  modelName: string | null
  runtimeRowIds?: Array<string>
  baseIds: Array<string>
  rowIds: Array<string>
}

const prose = (text: string) => text.replace(/```[\s\S]*?```/g, '')
const rows = (text: string) => markdownTableRows(text.replace(/[ \t]+$/gm, ''))
const clean = (text: string) => text.replace(/[*`]/g, '').trim()
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function models(text: string): Map<string, string> {
  const beforeExamples = text.split(/^## /m)[0] ?? ''
  const table = rows(beforeExamples)
  const header = table[0]
  if (header?.[0] !== 'Model' || header[1] !== 'Model ID') {
    throw new Error(
      'amazon-bedrock thinking guide: missing supported model table',
    )
  }
  const result = new Map<string, string>()
  for (const row of table.slice(1)) {
    // The hosted table links each name to its model card. The label is the
    // name the effort rows use; anything else stays fail-closed.
    const name = row[0]
      ?.trim()
      .replace(/^\[([^\]]+)\]\([^)\s]+\)$/, (_, label: string) => label.trim())
    const id = row[1]?.match(/^`(anthropic\.[a-z0-9.:-]+)`$/)?.[1]
    if (!name || !id || row.length !== 2 || result.has(name)) {
      throw new Error(
        'amazon-bedrock thinking guide: unreadable supported model row',
      )
    }
    result.set(name, id)
  }
  if (!result.size)
    throw new Error(
      'amazon-bedrock thinking guide: empty supported model table',
    )
  return result
}

/** Whole names only: Opus 5 is never an abbreviation for Opus 5.5. */
function namedIds(text: string, names: Map<string, string>): Array<string> {
  const result: Array<string> = []
  for (const [name, id] of names) {
    if (
      new RegExp(`(?<![\\w.])${escape(name)}(?![\\w]|\\.\\d|\\s+\\d)`).test(
        clean(text),
      )
    )
      result.push(id)
  }
  return result
}

export function parseBedrockExtendedThinking(
  text: string,
): Record<string, ModelReasoning> {
  const native = prose(text)
  const supported = models(native)
  const use = markdownSection(native, 'How to use extended thinking')
  if (
    !/^To turn on extended thinking, add a `thinking` object/m.test(use) ||
    !/^The `budget_tokens` parameter determines the maximum number of tokens/m.test(
      use,
    )
  ) {
    throw new Error(
      'amazon-bedrock extended thinking: missing native budget declaration',
    )
  }
  return Object.fromEntries(
    [...supported.values()].map((id) => [
      id,
      { mode: 'budget', mandatory: null },
    ]),
  )
}

export function parseBedrockAdaptiveThinking(
  text: string,
): Record<string, ModelReasoning> {
  const native = prose(text)
  const supported = models(native)
  const effortSection = markdownSection(
    native,
    'Adaptive thinking with the effort parameter',
  )
  const table = rows(effortSection)
  if (
    table[0]?.[0] !== 'Effort level' ||
    table[0][1] !== 'Thinking behavior' ||
    table.length < 2 ||
    !/^Set `thinking.type` to `"adaptive"` in your API request:$/m.test(native)
  ) {
    throw new Error(
      'amazon-bedrock adaptive thinking: missing native mode or effort table',
    )
  }
  const result: Record<string, ModelReasoning> = Object.fromEntries(
    [...supported.values()].map((id) => [
      id,
      { mode: 'adaptive', mandatory: null, efforts: [] },
    ]),
  )
  const seen = new Set<string>()
  for (const row of table.slice(1)) {
    const level = row[0]?.match(
      /^([a-z][a-z0-9_-]*)(?: \(default(?: [^)]+)?\))?$/,
    )?.[1]
    const description = row[1]
    if (!level || !description || row.length !== 2 || seen.has(level))
      throw new Error('amazon-bedrock adaptive thinking: unreadable effort row')
    seen.add(level)
    const named = namedIds(description, supported)
    let unmatched = clean(description)
    for (const name of supported.keys())
      unmatched = unmatched.replace(
        new RegExp(`(?<![\\w.])${escape(name)}(?![\\w]|\\.\\d|\\s+\\d)`, 'g'),
        '',
      )
    if (/\bClaude\s+[A-Z0-9]/.test(unmatched))
      throw new Error(
        `amazon-bedrock adaptive thinking: unsupported named scope for ${level}`,
      )
    const scoped =
      /\bonly\b|\bsupports?\b|\bsupported\b|unsupported models/i.test(
        description,
      )
    if (scoped && !named.length)
      throw new Error(
        `amazon-bedrock adaptive thinking: unreadable model scope for ${level}`,
      )
    if (named.length && !scoped)
      throw new Error(
        `amazon-bedrock adaptive thinking: ambiguous model scope for ${level}`,
      )
    for (const id of scoped ? named : supported.values())
      result[id]?.efforts?.push(level)
  }
  for (const control of Object.values(result)) {
    if (!control.efforts?.length)
      throw new Error(
        'amazon-bedrock adaptive thinking: model has no published effort levels',
      )
  }
  // Read operational declarations, never infer mandatory from defaults or enums.
  const declare = (ids: Array<string>, mandatory: boolean) => {
    for (const id of ids) {
      const control = result[id]
      if (!control) continue
      if (control.mandatory != null && control.mandatory !== mandatory)
        throw new Error(
          `amazon-bedrock adaptive thinking: contradictory disabling evidence for ${id}`,
        )
      control.mandatory = mandatory
    }
  }
  for (const line of native.split('\n')) {
    if (
      /disabled thinking[^\n]*are not supported on these models/.test(line) &&
      !/\b(?:not|never|assume|example|hypothetical)\b/i.test(
        line.split(/only\*? support adaptive thinking/)[0] ?? '',
      )
    ) {
      declare(
        namedIds(
          line.split(/only\*? support adaptive thinking/)[0] ?? '',
          supported,
        ),
        true,
      )
    }
    if (
      /supports adaptive and disabled thinking/.test(line) &&
      !/\b(?:not|never|assume|example|hypothetical)\b/i.test(
        line.split('supports adaptive and disabled thinking')[0] ?? '',
      )
    ) {
      declare(
        namedIds(
          line.split('supports adaptive and disabled thinking')[0] ?? '',
          supported,
        ),
        false,
      )
    }
    if (
      /also supports disabled thinking/.test(line) &&
      !/\b(?:not|never|assume|example|hypothetical)\b/i.test(
        line.split('also supports disabled thinking')[0] ?? '',
      )
    ) {
      declare(
        namedIds(
          line.split('also supports disabled thinking')[0] ?? '',
          supported,
        ),
        false,
      )
    }
  }
  const defaultBlock = native.match(
    /^\*\*Adaptive thinking is on by default on (.+?)\.\*\*[^\n]*\n([^\n]+)/m,
  )
  if (
    defaultBlock &&
    /To turn thinking off entirely on these models[^\n]*disabled/.test(
      defaultBlock[2] ?? '',
    )
  ) {
    declare(namedIds(defaultBlock[1] ?? '', supported), false)
  }
  return result
}

/** The hosted guide names one model explicitly; examples cannot add scope. */
export function parseBedrockNovaThinking(text: string): {
  modelName: string
  reasoning: ModelReasoning
} {
  const native = markdownSection(prose(text), 'Using reasoning')
  const modelName = native.match(
    /^([^\n]+) supports extended thinking for complex problem-solving\. Enable reasoning with `reasoningConfig`\.$/m,
  )?.[1]
  const type = native.match(/^\+ `type`: (.+)$/m)?.[1]
  const declaration = native.match(
    /^\+ `maxReasoningEffort`: (.+?)\. This is required when reasoning is enabled\./m,
  )?.[1]
  if (
    !modelName ||
    !type ||
    !/^`enabled` or `disabled` \(default: `disabled`\)$/.test(type) ||
    !declaration
  ) {
    throw new Error(
      'amazon-bedrock Nova thinking: missing native model, type or effort declaration',
    )
  }
  const efforts = [...declaration.matchAll(/`([a-z][a-z0-9_-]*)`/g)].map(
    (match) => match[1] ?? '',
  )
  if (
    !efforts.length ||
    new Set(efforts).size !== efforts.length ||
    declaration
      .replace(/`[a-z][a-z0-9_-]*`/g, '')
      .replace(/[,\s]|\bor\b/g, '') !== ''
  ) {
    throw new Error(
      'amazon-bedrock Nova thinking: unreadable native effort list',
    )
  }
  return { modelName, reasoning: { mode: 'effort', mandatory: false, efforts } }
}

/** A profile is enriched only through IDs explicitly declared on its card. */
export function applyBedrockThinkingGuides(
  catalog: Array<ModelInfo>,
  groups: Array<BedrockCardOwnedGroup>,
  guides: Array<BedrockThinkingGuide>,
): Array<ModelInfo> {
  const byRow = new Map<
    string,
    ModelReasoning & { url: string; hash: string }
  >()
  // Adaptive is AWS's recommended successor where its table overlaps extended.
  for (const guide of guides) {
    for (const group of groups) {
      const named = group.modelName
        ? (guide.namedControls ?? guide.runtimeNamedControls)?.[group.modelName]
        : undefined
      const byId = group.baseIds
        .map((id) => guide.controls[id])
        .filter((value): value is ModelReasoning => value != null)
      const useName = !!guide.namedControls || (!byId.length && named != null)
      const declarations = useName ? (named ? [named] : []) : byId
      if (
        useName &&
        named &&
        (!Array.isArray(group.runtimeRowIds) ||
          !group.runtimeRowIds.every((id) => typeof id === 'string'))
      )
        throw new Error(
          'amazon-bedrock thinking: unreadable native runtime card binding',
        )
      const targetIds = useName
        ? (group.runtimeRowIds ?? []).filter((id) => group.rowIds.includes(id))
        : group.rowIds
      if (
        useName &&
        named &&
        groups.filter((candidate) => candidate.modelName === group.modelName)
          .length !== 1
      )
        throw new Error(
          'amazon-bedrock thinking: ambiguous native card title binding',
        )
      if (!declarations.length) continue
      if (
        declarations.some(
          (value) => JSON.stringify(value) !== JSON.stringify(declarations[0]),
        )
      )
        throw new Error(
          'amazon-bedrock thinking: contradictory controls for card-owned base IDs',
        )
      for (const id of targetIds)
        byRow.set(id, { ...declarations[0]!, url: guide.url, hash: guide.hash })
    }
  }
  return catalog.map((model) => {
    const declaration = byRow.get(model.rawId)
    if (!declaration) return model
    const capSource = tagDocsFacts(
      { capabilities: ['reasoning'] },
      declaration.url,
      declaration.hash,
    ).capabilities!.reasoning!
    const capable = nativeReasoningCapability(model, capSource)
    const existing = model.reasoning
    if (
      existing?.mandatory != null &&
      declaration.mandatory != null &&
      existing.mandatory !== declaration.mandatory
    )
      throw new Error(
        `amazon-bedrock thinking: native guide contradicts card mandatory for ${model.rawId}`,
      )
    // Do not add adaptive efforts to a budget/effort object from a card.
    if (existing && existing.mode !== declaration.mode) return model
    if (existing?.efforts?.length && existing.mandatory != null) return model
    // Only cite the guide for a complete object when every retained value is
    // independently supported by that guide. Otherwise leave the card intact.
    if (
      existing?.mandatory != null &&
      existing.mandatory !== declaration.mandatory
    )
      return model
    if (
      existing?.efforts?.length &&
      JSON.stringify([...existing.efforts].sort()) !==
        JSON.stringify([...(declaration.efforts ?? [])].sort())
    )
      return model
    const reasoning: ModelReasoning = {
      mode: existing?.mode ?? declaration.mode,
      mandatory: existing?.mandatory ?? declaration.mandatory,
      ...(existing?.efforts?.length
        ? { efforts: existing.efforts }
        : declaration.efforts?.length
          ? { efforts: declaration.efforts }
          : {}),
    }
    if (JSON.stringify(reasoning) === JSON.stringify(existing)) return model
    const reasonSource = tagDocsFacts(
      { reasoning },
      declaration.url,
      declaration.hash,
    )
    return {
      ...capable,
      reasoning,
      factSources: {
        ...model.factSources,
        ...reasonSource,
        capabilities: {
          ...capable.factSources?.capabilities,
          reasoning: model.factSources?.capabilities?.reasoning ?? capSource,
        },
      },
    }
  })
}

export async function loadBedrockThinkingGuides(
  catalog: Array<ModelInfo>,
  groups: Array<BedrockCardOwnedGroup>,
  run: DocsRun,
  kv?: KVNamespace,
): Promise<Array<ModelInfo>> {
  const sources = [
    {
      url: BEDROCK_EXTENDED_THINKING_URL,
      parse: (text: string) => {
        const controls = parseBedrockExtendedThinking(text)
        return {
          controls,
          runtimeNamedControls: Object.fromEntries(
            [...models(prose(text))].map(([name, id]) => [name, controls[id]!]),
          ),
        }
      },
    },
    {
      url: BEDROCK_ADAPTIVE_THINKING_URL,
      parse: (text: string) => {
        const controls = parseBedrockAdaptiveThinking(text)
        return {
          controls,
          runtimeNamedControls: Object.fromEntries(
            [...models(prose(text))].map(([name, id]) => [name, controls[id]!]),
          ),
        }
      },
    },
    {
      url: BEDROCK_NOVA_THINKING_URL,
      parse: (text: string) => {
        const declaration = parseBedrockNovaThinking(text)
        return {
          controls: {},
          namedControls: { [declaration.modelName]: declaration.reasoning },
        }
      },
    },
  ]
  const guides = await Promise.all(
    sources.map((source) =>
      tryDocs(run, source.url, (cached) =>
        cached(kv, source.url, async () => {
          const text = await fetchText(source.url, {
            signal: AbortSignal.timeout(20_000),
            headers: {
              'User-Agent':
                'modelschemas (+https://modelschemas.openstory.workers.dev)',
            },
          })
          return {
            ...source.parse(text),
            url: source.url,
            hash: await sha256Text(text),
          }
        }),
      ),
    ),
  )
  let enriched = catalog
  const failedSources = new Set(
    sources
      .filter((_, index) => guides[index] == null)
      .map((source) => source.url),
  )
  // Apply adaptive first: it is the recommendation for overlapping IDs.
  for (const index of [1, 0, 2]) {
    const guide = guides[index]
    if (!guide) continue
    const result = await tryDocs(run, guide.url, async () =>
      applyBedrockThinkingGuides(enriched, groups, [guide]),
    )
    if (result) enriched = result
    else failedSources.add(guide.url)
  }
  if (!failedSources.size) return enriched
  // A failed guide cannot clear missing controls that it may have supplied.
  // Existing populated card facts remain intact; failures are public.
  const claude = new Set(
    groups
      .filter((group) =>
        group.baseIds.some((id) => id.startsWith('anthropic.')),
      )
      .flatMap((group) => group.rowIds),
  )
  const nova = new Set(
    groups
      .filter((group) =>
        group.baseIds.some((id) => id.startsWith('amazon.nova-')),
      )
      .flatMap((group) => group.rowIds),
  )
  return enriched.map((model) => {
    const missingMode = model.reasoning == null
    const missingAdaptiveEfforts =
      model.reasoning?.mode === 'adaptive' && !model.reasoning.efforts?.length
    const missingNovaEfforts =
      model.reasoning?.mode === 'effort' && !model.reasoning.efforts?.length
    const affected =
      (claude.has(model.rawId) &&
        ((failedSources.has(BEDROCK_EXTENDED_THINKING_URL) && missingMode) ||
          (failedSources.has(BEDROCK_ADAPTIVE_THINKING_URL) &&
            (missingMode || missingAdaptiveEfforts)))) ||
      (nova.has(model.rawId) &&
        failedSources.has(BEDROCK_NOVA_THINKING_URL) &&
        (missingMode || missingNovaEfforts))
    return affected
      ? {
          ...model,
          absent: { ...model.absent, ...unavailable('reasoning').absent },
        }
      : model
  })
}
