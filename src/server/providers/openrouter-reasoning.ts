import type { ThinkingRequest } from './request-map.ts'

/** Gateway effort names come from normative provider documentation, never examples. */
export const OPENROUTER_REASONING_URL =
  'https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md'
export function openRouterGatewayEfforts(markdown: string): Array<string> {
  const prose = markdown.replace(/```[\s\S]*?```/g, '')
  if (!/When `null`, all gateway effort values are accepted/.test(prose))
    throw new Error('openrouter: native null-efforts contract missing')
  if (
    !/\*\*`mandatory`\*\*:[^\n]*When `true`[^\n]*do not send `effort: "none"`[^\n]*model rejects it/.test(
      prose,
    )
  )
    throw new Error('openrouter: native mandatory effort rejection missing')
  const values = [...prose.matchAll(/^\* `"effort": "([a-z]+)"` - .+$/gm)].map(
    (match) => match[1]!,
  )
  if (!values.length || new Set(values).size !== values.length)
    throw new Error(
      'openrouter: missing or ambiguous normative gateway efforts',
    )
  return values
}

/** Messages compatibility is explicitly normalized for every reasoning model. */
export function openRouterGatewayToggle(markdown: string): ThinkingRequest {
  const prose = markdown.replace(/```[\s\S]*?```/g, '')
  const section = prose
    .split(/^## Reasoning with the Anthropic Messages API\s*$/m)[1]
    ?.split(/^#{1,2} /m)[0]
  if (
    !section ||
    !/^Requests sent through[^\n]*OpenRouter normalizes both into the unified `reasoning` parameter, so they work on every reasoning model, not only Claude\./m.test(
      section,
    )
  )
    throw new Error('openrouter: native gateway toggle scope missing')
  if (
    !/^\| `thinking: \{ type: "adaptive" \}` \| `reasoning: \{ enabled: true \}` \|$/m.test(
      section,
    ) ||
    !/^\| `thinking: \{ type: "disabled" \}` \| `reasoning: \{ enabled: false \}` \|$/m.test(
      section,
    ) ||
    !/^`thinking: \{ type: "disabled" \}` disables reasoning even when an `output_config\.effort` is also present\./m.test(
      section,
    )
  )
    throw new Error(
      'openrouter: native gateway enable/disable contract missing',
    )
  const body = (type: 'adaptive' | 'disabled') => {
    const row = section
      .split('\n')
      .find((line) => line.startsWith(`| \`thinking: { type: "${type}" }\``))
    const wire = row?.match(/\| `([a-z_]+): \{ ([a-z_]+): (true|false) \}` \|$/)
    if (!wire?.[1] || !wire[2] || !wire[3])
      throw new Error('openrouter: native toggle wire map unreadable')
    return { [wire[1]]: { [wire[2]]: wire[3] === 'true' } }
  }
  return { on: body('adaptive'), off: body('disabled'), levels: null }
}

/**
 * The guide states `reasoning_content` as an alias of `reasoning`, and
 * `reasoning_details` replay, for every supported reasoning model. A model
 * exception would have to be named. Throws when that statement is gone.
 */
export function openRouterReasoningContentReplay(markdown: string): true {
  const prose = markdown.replace(/```[\s\S]*?```/g, '')
  if (
    !/You can also use `reasoning_content` as an alias - it functions identically to `reasoning`\./.test(
      prose,
    )
  ) {
    throw new Error('openrouter: reasoning_content alias missing')
  }
  const section = prose.split(/^## Preserving Reasoning\s*$/m)[1]
  if (
    !section ||
    !/you can pass it back to the API/.test(section) ||
    !/The `reasoning_details` functionality works identically across all supported reasoning models\./.test(
      prose,
    )
  ) {
    throw new Error('openrouter: reasoning_content replay statement missing')
  }
  return true
}

/** Read actual canonical effort wire fields from the native normalization table. */
export function openRouterGatewayEffortWire(markdown: string): {
  outer: string
  field: string
} {
  const prose = markdown.replace(/```[\s\S]*?```/g, '')
  const section = prose
    .split(/^## Reasoning with the Anthropic Messages API\s*$/m)[1]
    ?.split(/^#{1,2} /m)[0]
  if (
    !section ||
    !/^Requests sent through[^\n]*OpenRouter normalizes both into the unified `reasoning` parameter, so they work on every reasoning model, not only Claude\./m.test(
      section,
    )
  )
    throw new Error('openrouter: native effort wire scope missing')
  const row = section.match(
    /^\| `output_config: \{ effort \}` \| `([a-z_]+): \{ ([a-z_]+) \}` \|$/m,
  )
  if (!row?.[1] || !row[2])
    throw new Error('openrouter: native effort wire fields missing')
  return { outer: row[1], field: row[2] }
}
