/**
 * MCP server endpoint (PLAN.md task 7.1) — stateless streamable-HTTP:
 * every request is a self-contained JSON-RPC POST answered with JSON (no
 * SSE session state to hold on Workers). Tools reuse the Phase 4 service
 * functions directly.
 */
import type { Db } from '#/db/index.ts'
import { asText } from '#/lib/text.ts'
import { activities, changeTypes } from '#/db/schema.ts'
import type { Activity, ChangeType } from '#/db/schema.ts'
import { listChanges } from '#/server/changes-api.ts'
import { getModelDetail, listModelsCatalog } from '#/server/catalog.ts'
import { estimateCost } from '#/server/estimate.ts'
import { llmsTxt } from '#/server/llms-txt.ts'
import {
  getEndpointSchema,
  getProviderSchemaIndex,
  getSystemSchemaIndex,
  providerExists,
} from '#/server/schemas-api.ts'
import { validatePayload } from '#/server/validate.ts'

export const MCP_PROTOCOL_VERSION = '2025-03-26'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const TOOLS: Array<ToolDefinition> = [
  {
    name: 'list_models',
    description:
      'Cross-provider model catalog: which AI models exist right now, filterable by activity (chat/image/video/audio/embeddings/moderation/world/decision), provider, capability flag (a flag the model is stated to support, e.g. tools), or free text.',
    inputSchema: {
      type: 'object',
      properties: {
        activity: { type: 'string', enum: [...activities] },
        provider: { type: 'string' },
        capability: { type: 'string' },
        q: { type: 'string' },
      },
    },
  },
  {
    name: 'get_model',
    description:
      'Full metadata for one model (context window, modalities, pricing, capabilities). Accepts the model slug or raw provider id.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string' },
        modelId: { type: 'string' },
      },
      required: ['provider', 'modelId'],
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
        activity: { type: 'string', enum: [...activities] },
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
  {
    name: 'estimate_cost',
    description:
      'Evaluate the stored rate card for a model. Pass request-bound levers in request. Pass in usage the usage object of the provider as returned (OpenAI Responses or Chat usage, Anthropic usage, Gemini usageMetadata), or card levers whose counts do not overlap (input_tokens excludes cache_read_tokens); a payload that mixes the two is a mixed_usage error. Returns { amount, currency, usd?, cardSource, estimated, defaulted, ignored }: amount is in currency (ISO 4217, never converted) and usd (deprecated) repeats it only for a USD card. A non-empty estimated names omitted usage the card filled by the published estimate method of its source, so amount is then an estimate, not the billed price. defaulted names omitted inputs that took the card default; ignored names request keys the card does not read. A zero card lever the card does not read is dropped. Any other usage key the card does not read is an unknown_usage_key error that lists the keys the card reads. A routed model with a pricingRange and no card returns { currency, min, max, routes }: the call priced on every route, min and max each naming its route (a catalog id, or a gateway provider name when the card is inline); neither is the billed price. When the call omits exactly one required choice input (enum or boolean with no default, such as pricing_period) and supplies everything else, returns { currency, byInput: { input, values } }: one result per allowed value, keyed by value; pass the input to get one price. Two omitted choice inputs, or an omitted quantity, is an unbound_input error naming each.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
        request: { type: 'object' },
        usage: { type: 'object' },
      },
      required: ['provider', 'model'],
    },
  },
  {
    name: 'recent_changes',
    description:
      'Changelog feed of model/schema/endpoint changes (cursor-paginated, newest first). A model.updated payload includes changed: the fact paths that differ. A source hash, an extract time, and operand or values order are not changes.',
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'integer',
          description: 'Unix epoch seconds lower bound.',
        },
        provider: { type: 'string' },
        type: { type: 'string', enum: [...changeTypes] },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        cursor: { type: 'string' },
      },
    },
  },
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function rpcResult(id: JsonRpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0' as const, id: id ?? null, result }
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0' as const, id: id ?? null, error: { code, message } }
}

function toolText(value: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 1) }],
    isError,
  }
}

async function callTool(
  db: Db,
  name: string,
  args: Record<string, unknown>,
): Promise<ReturnType<typeof toolText>> {
  switch (name) {
    case 'list_models': {
      const result = await listModelsCatalog(db, {
        activity: args.activity as Activity | undefined,
        provider: args.provider as string | undefined,
        capability: args.capability as string | undefined,
        q: args.q as string | undefined,
      })
      return toolText(result)
    }
    case 'get_model': {
      const model = await getModelDetail(
        db,
        asText(args.provider),
        asText(args.modelId),
      )
      if (!model) {
        return toolText(
          {
            error: 'unknown_model',
            hint: 'Use list_models to find valid ids.',
          },
          true,
        )
      }
      return toolText(model)
    }
    case 'list_schemas': {
      const provider = args.provider as string | undefined
      if (provider === undefined || provider === '') {
        return toolText(await getSystemSchemaIndex(db))
      }
      if (!(await providerExists(db, provider))) {
        return toolText(
          {
            error: 'unknown_provider',
            hint: 'Call list_schemas without arguments for the full provider → endpoint index.',
          },
          true,
        )
      }
      return toolText(await getProviderSchemaIndex(db, provider))
    }
    case 'get_schema': {
      const kind = args.kind === 'output' ? 'output' : 'input'
      const schema = await getEndpointSchema(
        db,
        asText(args.provider),
        args.activity as Activity,
        asText(args.endpointId),
        kind,
        args.version as string | undefined,
      )
      if (!schema) {
        return toolText(
          {
            error: 'unknown_schema',
            hint: 'Check provider/activity/endpointId; list endpoints via the schema index at /v1/schemas/{provider}.',
          },
          true,
        )
      }
      return toolText(schema)
    }
    case 'validate_payload': {
      const outcome = await validatePayload(db, {
        provider: asText(args.provider),
        endpointId: asText(args.endpointId),
        kind: args.kind === 'output' ? 'output' : undefined,
        payload: args.payload,
      })
      if (!outcome.ok) {
        return toolText({ error: outcome.code, message: outcome.message }, true)
      }
      return toolText(outcome.result)
    }
    case 'estimate_cost': {
      const outcome = await estimateCost(db, {
        provider: asText(args.provider),
        model: asText(args.model),
        request: isRecord(args.request) ? args.request : undefined,
        usage: isRecord(args.usage) ? args.usage : undefined,
      })
      if (!outcome.ok) {
        return toolText({ error: outcome.code, message: outcome.message }, true)
      }
      return toolText(outcome.result)
    }
    case 'recent_changes': {
      const outcome = await listChanges(db, {
        since: args.since as number | undefined,
        provider: args.provider as string | undefined,
        type: args.type as ChangeType | undefined,
        limit: args.limit as number | undefined,
        cursor: args.cursor as string | undefined,
      })
      if (!outcome.ok) {
        return toolText({ error: outcome.code, message: outcome.message }, true)
      }
      return toolText(outcome.result)
    }
    default:
      return toolText(
        {
          error: 'unknown_tool',
          message: `Unknown tool '${name}'. Available: ${TOOLS.map((t) => t.name).join(', ')}.`,
        },
        true,
      )
  }
}

/** Handle one MCP request (POST /mcp). */
export async function handleMcpRequest(
  db: Db,
  request: Request,
): Promise<Response> {
  if (request.method === 'GET') {
    // Stateless server: no SSE stream to subscribe to.
    return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  }
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  }

  let rpc: JsonRpcRequest
  try {
    rpc = (await request.json()) as JsonRpcRequest
  } catch {
    return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400 })
  }

  // Notifications get a body-less 202 per streamable HTTP.
  if (rpc.method.startsWith('notifications/')) {
    return new Response(null, { status: 202 })
  }

  switch (rpc.method) {
    case 'initialize':
      return Response.json(
        rpcResult(rpc.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: {
            name: 'modelschemas',
            version: '0.1.0',
            description:
              'Live AI model schemas: catalog, JSON Schemas, validation, change feed.',
          },
          // Shared with the GET / narrative root (task 11.2) — one source.
          instructions: llmsTxt,
        }),
      )
    case 'ping':
      return Response.json(rpcResult(rpc.id, {}))
    case 'tools/list':
      return Response.json(rpcResult(rpc.id, { tools: TOOLS }))
    case 'tools/call': {
      const name = asText(rpc.params?.name)
      const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>
      return Response.json(rpcResult(rpc.id, await callTool(db, name, args)))
    }
    default:
      return Response.json(
        rpcError(rpc.id, -32601, `Method not found: ${rpc.method}`),
      )
  }
}
