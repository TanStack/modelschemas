/**
 * Facts OpenCode publishes for every Go request, plus training on request
 * data where the Go privacy table names that id (issue #463). A probe
 * record still states it for an id the table does not mention.
 */
import { markdownSection, markdownTableRows } from './model-facts.ts'
import { requiredHeaderParameters } from './connect.ts'
import { probesFor } from './probes/index.ts'
import type { FactSource, ModelFactSources, RequiredHeader } from './types.ts'

/** https://opencode.ai/docs/console/go/ (`/docs/go/` 301s here). */
export const OPENCODE_GO_DOCS_URL = 'https://opencode.ai/docs/console/go/'

export const OPENCODE_GO_REQUIRED_HEADERS: Array<RequiredHeader> = [
  {
    name: 'x-opencode-session',
    description:
      'A stable session id the client chooses for each conversation.',
  },
  {
    name: 'User-Agent',
    description:
      'A client-specific User-Agent, such as my-coding-agent/1.0, not a generic SDK or HTTP-library name.',
  },
]

/** OpenAPI header parameters for every Go operation. Values are not constants. */
export function openCodeGoHeaderParameters(): Array<Record<string, unknown>> {
  return requiredHeaderParameters(OPENCODE_GO_REQUIRED_HEADERS).map(
    (parameter) => ({
      ...parameter,
      description: `${String(parameter.description)} ${OPENCODE_GO_DOCS_URL}`,
    }),
  )
}

const HEADER_SOURCE: FactSource = {
  derivation: 'docs-derived',
  sourceUrl: OPENCODE_GO_DOCS_URL,
  path: 'Where can I use it?',
}

function cellId(cell: string | undefined): string {
  return (cell ?? '').replace(/^`|`$/g, '').trim()
}

/**
 * Privacy table joined to the Endpoints table on the model name.
 * `true` is "Yes". `false` is "Not used". Throws when a section, a row,
 * or a training cell is not the shape the page publishes.
 */
export function parseGoTraining(text: string): Map<string, boolean> {
  const endpoints = markdownSection(text, 'Endpoints')
  const privacy = markdownSection(text, 'Privacy')
  if (endpoints === '' || privacy === '') {
    throw new Error('opencode-go: go docs have no Endpoints or Privacy section')
  }
  const ids = new Map<string, string>()
  for (const cells of markdownTableRows(endpoints)) {
    if (cells[0] === 'Model') continue
    const name = cells[0]
    const id = cellId(cells[1])
    if (!name || id === '') continue
    ids.set(name, id)
  }
  const training = new Map<string, boolean>()
  for (const cells of markdownTableRows(privacy)) {
    if (cells[0] === 'Model') continue
    const name = cells[0]
    const stated = cells[1]
    if (!name) continue
    if (stated !== 'Yes' && stated !== 'Not used') {
      throw new Error(
        `opencode-go: privacy training cell ${JSON.stringify(stated)} for ${name}`,
      )
    }
    const id = ids.get(name)
    if (!id) {
      throw new Error(`opencode-go: privacy model ${name} has no endpoint id`)
    }
    training.set(id, stated === 'Yes')
  }
  if (training.size === 0) {
    throw new Error('opencode-go: privacy table names no models')
  }
  return training
}

export function openCodeGoFacts(
  providerId: string,
  rawId: string,
): {
  requiredRequestHeaders: Array<RequiredHeader> | null
  trainsOnRequestData: boolean | null
  factSources: Pick<
    ModelFactSources,
    'requiredRequestHeaders' | 'trainsOnRequestData'
  >
} {
  if (providerId !== 'opencode-go') {
    return {
      requiredRequestHeaders: null,
      trainsOnRequestData: null,
      factSources: {},
    }
  }
  const training = probesFor(providerId).find(
    (record) => record.model === rawId && record.trainsOnRequestData === true,
  )
  return {
    requiredRequestHeaders: OPENCODE_GO_REQUIRED_HEADERS,
    trainsOnRequestData: training ? true : null,
    factSources: {
      requiredRequestHeaders: HEADER_SOURCE,
      ...(training
        ? {
            trainsOnRequestData: {
              derivation: 'probe-verified' as const,
              verifiedAt: training.verifiedAt,
              sourceUrl: `src/server/providers/probes/opencode-go.ts#${training.id}`,
            },
          }
        : {}),
    },
  }
}
