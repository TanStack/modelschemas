/**
 * WebMCP (PLAN.md task 10.6): when the browser exposes the draft
 * `navigator.modelContext` API, register in-page tools wrapping the public
 * API so an embedded agent can use the service without leaving the page.
 * Definitions are literal copies of the server MCP tools (no server imports
 * — keeps drizzle/workers code out of the client bundle); a unit test pins
 * them to src/server/mcp.ts TOOLS so they cannot drift.
 */

export interface WebMcpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const ACTIVITIES = [
  'chat',
  'image',
  'video',
  'audio',
  'embeddings',
  'moderation',
  'world',
]

export const WEBMCP_TOOLS: Array<WebMcpToolDefinition> = [
  {
    name: 'list_models',
    description:
      'Cross-provider model catalog: which AI models exist right now, filterable by activity (chat/image/video/audio/embeddings/moderation/world), provider, capability flag (a flag the model is stated to support, e.g. tools), or free text.',
    inputSchema: {
      type: 'object',
      properties: {
        activity: { type: 'string', enum: ACTIVITIES },
        provider: { type: 'string' },
        capability: { type: 'string' },
        q: { type: 'string' },
      },
    },
  },
  {
    name: 'list_schemas',
    description:
      'Index of every schema on the system: provider → activity → endpoint ids. Pass provider to narrow to one provider. Use it to discover valid get_schema arguments.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Optional provider id to narrow the index.',
        },
      },
    },
  },
  {
    name: 'get_schema',
    description:
      'Self-contained JSON Schema ($defs-bundled) for a provider endpoint — request (input) or response (output) shape.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string' },
        activity: { type: 'string', enum: ACTIVITIES },
        endpointId: {
          type: 'string',
          description:
            "Path-derived id (e.g. 'v1/messages' or 'chat/completions') or a listed model rawId, which aliases onto that activity's generation route.",
        },
        kind: { type: 'string', enum: ['input', 'output'] },
        version: {
          type: 'string',
          description: 'Content hash of a historical version.',
        },
      },
      required: ['provider', 'activity', 'endpointId'],
    },
  },
  {
    name: 'validate_payload',
    description:
      'Validate a request/response payload against the current stored schema for a provider endpoint before spending tokens on a real call.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string' },
        endpointId: { type: 'string' },
        kind: { type: 'string', enum: ['input', 'output'] },
        payload: { description: 'The payload to validate.' },
      },
      required: ['provider', 'endpointId', 'payload'],
    },
  },
]

interface ModelContextTool extends WebMcpToolDefinition {
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

interface ModelContext {
  provideContext: (context: { tools: Array<ModelContextTool> }) => void
}

/** Each tool call is a JSON-RPC tools/call against our own /mcp endpoint,
 * so WebMCP results are byte-identical to remote MCP results. */
async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const body = (await response.json()) as {
    result?: unknown
    error?: unknown
  }
  return body.result ?? body.error
}

/** Registers the tools when navigator.modelContext exists; no-op (false)
 * everywhere else. Safe to call during SSR. */
export function registerWebMcp(): boolean {
  if (typeof navigator === 'undefined') return false
  const modelContext = (navigator as { modelContext?: ModelContext })
    .modelContext
  if (typeof modelContext?.provideContext !== 'function') return false
  modelContext.provideContext({
    tools: WEBMCP_TOOLS.map((tool) => ({
      ...tool,
      execute: (args: Record<string, unknown>) => callMcpTool(tool.name, args),
    })),
  })
  return true
}
