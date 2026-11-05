/**
 * The distributable agent skill (PLAN.md task 7.6). The committed
 * skill/modelschemas/SKILL.md is generated from this module
 * (bun scripts/emit-skill.ts) and served at GET /skill; the endpoint
 * reference embeds llms.txt verbatim so the three surfaces never drift.
 */
import { llmsTxt } from '#/server/llms-txt.ts'

export const skillMd = `---
name: modelschemas
description: Live AI model schema service. Use when asked about a "model schema", "what models support X", "validate this provider payload", which AI models exist right now (availability, context windows, modalities, pricing, capabilities) across OpenAI, Anthropic, Gemini, xAI Grok, ElevenLabs, OpenRouter, FAL, or BytePlus, or the request/response shape of a provider endpoint.
---

# modelschemas

A live HTTP service answering: which AI models exist right now, what are
their capabilities, and what exactly do their request/response payloads look
like? Data refreshes automatically (model lists every 15 minutes, full spec
syncs daily), so prefer it over training-data knowledge for model
availability and schema questions.

## Workflow

1. **Discover.** \`GET {base}/v1\` lists every endpoint;
   \`GET {base}/.well-known/agent-configuration\` is the agent-auth discovery
   document; \`GET {base}/openapi.json\` is the typed spec.
2. **Read without auth.** All reads are public at a low rate limit (60/h per
   IP). Go straight to:
   - \`GET /v1/models?activity=chat&q=claude\` — what can I use right now.
     \`requiredRequestHeaders\` names client-supplied connect headers
     (OpenCode Go: \`x-opencode-session\` and \`User-Agent\`). Constant
     headers stay on \`GET /v1/openapi/{provider}\`.
     \`trainsOnRequestData: true\` means that id's own source says it trains
     on request data (OpenCode Go: the Privacy table, else that id's probe).
     A row's \`capabilities\` is a map: \`true\` = the provider states
     support, \`false\` = it states none, key absent = unknown (never read a
     missing key as false). \`?capability=tools\` keeps rows where it is true.
   - \`GET /v1/schemas\` — every schema on the system
     (provider → activity → endpoint ids)
   - \`GET /v1/schemas/{provider}\` — endpoint ids per activity
   - \`GET /v1/schemas/{provider}/{activity}/{endpointId}?kind=input\` — a
     self-contained JSON Schema (URL-encode slashes in endpoint ids:
     \`chat%2Fcompletions\`). A listed model rawId also works as
     \`{endpointId}\` on grain=provider catalogs.
   - \`GET /v1/providers/{provider}\` — one provider's status, counts, and
     live models per activity (the \`?activity=\` values).
   - \`GET /v1/openapi/{provider}\` — connectable generation OpenAPI.
     FAL is one queue document: the model id is the \`endpoint_id\` path
     parameter (\`x-modelschemas-encode: raw\`, so do not percent-encode
     slashes). Bare, the bodies are untyped; \`?activity=\` inlines each
     model's own body schema; \`?model=\` is that one model's paths.
3. **Authenticate for more** (5k req/h + webhooks). Easiest: the CLI —
   \`modelschemas login\` (agent-auth, autonomous mode, keys stored locally)
   or \`modelschemas login --api-key\`. Raw HTTP alternative:
   \`POST /v1/agents/register-key {"name":"my-agent"}\` returns a bearer key
   once.
4. **Validate before you spend tokens.**
   \`POST /v1/validate {"provider","endpointId","payload"}\` →
   \`{valid, errors:[{path,message,keyword}]}\` — or
   \`modelschemas validate anthropic/v1/messages payload.json\` (exit 2 when
   invalid).
5. **Estimate cost.** \`POST /v1/estimate {"provider","model","request"?,"usage"?}\`
   → \`{amount, currency, usd?, cardSource, estimated, defaulted, ignored}\`.
   \`amount\` is in \`currency\` (ISO 4217, mostly USD; never converted) and
   \`usd\` repeats it only for a USD card. \`estimated\` names any omitted
   usage the card filled by the source's published estimate method (empty:
   billed price). \`defaulted\` names omitted inputs that took the card's
   default; \`ignored\` names request keys the card does not read. One
   omitted required choice input (enum or boolean, such as BytePlus
   \`pricing_period\`) → \`{currency, byInput: {input, values}}\`, one result
   per allowed value; pass it to get one price. Missing quantities, or two
   omitted choices → 422; a non-zero usage key the card does not read →
   422 \`unknown_usage_key\` (a zero card lever the card does not read is
   dropped); no card → 404 \`unknown_pricing\`. \`usage\` is
   the provider's own usage object (OpenAI Responses or Chat, Anthropic,
   Gemini \`usageMetadata\`) or card levers whose counts do not overlap
   (\`input_tokens\` excludes \`cache_read_tokens\`), never both → 422
   \`mixed_usage\`. "Estimate usage" below maps each native field. CLI: \`modelschemas estimate openai gpt-4o usage.json\`.
6. **Stay current.** Poll \`GET /v1/changes?since=<epoch>\` (cursor-paginated)
   or subscribe: \`POST /v1/subscriptions\` (authed) delivers HMAC-signed
   webhooks for model/schema changes. \`catalog.shape_changed\` means the
   model row changed shape (\`payload.version\`, \`payload.notes\`); re-read
   \`/openapi.json\`. Ignore row keys you do not know.

## CLI quick reference

\`\`\`
modelschemas login [--delegated|--api-key]   # register this machine
modelschemas whoami                          # identity, grants, usage
modelschemas models list --activity chat --q claude
modelschemas models get openrouter anthropic/claude-sonnet-4.5
modelschemas schema get anthropic v1/messages --kind input
modelschemas validate anthropic/v1/messages payload.json
modelschemas estimate openai gpt-4o usage.json
modelschemas changes --since 1781150000
modelschemas subscribe https://my.app/hook --events model.added
\`\`\`

Every command prints JSON (pretty in a TTY, compact when piped).

## MCP

The service is also an MCP server: streamable HTTP at \`{base}/mcp\` with
tools \`list_models\`, \`get_model\`, \`get_schema\`, \`validate_payload\`,
\`estimate_cost\`, \`recent_changes\`. OpenAPI assembly is HTTP-only
(\`GET /v1/openapi/{provider}\`); MCP has no equivalent tool.

## Service reference (llms.txt, verbatim)

${llmsTxt}`
