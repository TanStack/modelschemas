/**
 * The /llms.txt agent guide (PLAN.md task 4.1). Shared module so the /docs
 * page (7.3) and the distributable skill (7.6) render from the same source.
 */
export const llmsTxt = `# modelschemas

Live AI model schema service. Per-endpoint request/response JSON Schemas and
model metadata for 30+ monitored providers (OpenAI, Anthropic, Gemini, xAI
Grok, Mistral, Groq, DeepSeek, and more — GET /v1/providers for the full
roster), refreshed automatically: model lists every 15 minutes, full OpenAPI
spec syncs daily. Responses are JSON unless noted (\`text/typescript\`,
\`application/openapi+json\`).

## Why use this

- Discover which models exist *right now*, across providers, by activity
  (chat, image, video, audio, embeddings, moderation, world). Grain=provider
  catalogs (Grok, OpenAI, …) set \`activity\` on each row and
  \`schemaEndpointId\` pointing at the shared generation route
  (\`v1/images/generations\`, \`images/generations\`, …). \`pricing\` is a
  RateCard (or null when no price is stored). List rows carry a summary:
  \`{currency, per: 'token', inputPerMillion, outputPerMillion, tiered?}\`
  at the base rate, or \`{currency, per: 'second' | 'character' | 'image' | …}\`
  for a card billed by unit. \`currency\` is ISO 4217 (mostly USD; nothing
  is converted, so compare only like with like); \`?pricing=1\` returns
  the full card. \`/v1/status\` counts live \`priced\` models per provider
  and scores \`completeness\` (the share of chat facts filled; \`score\` is
  null with no chat models). A provider there carries \`docsFailing\`,
  \`priceClearsRefused\`, \`updateStorm\`, or \`staleProbes\` while its
  stored docs facts or prices may be stale, one poll rewrote most of its
  live rows, or a probe record is older than 90 days. A model row's
  \`requiredRequestHeaders\` lists client-supplied connect headers.
  \`trainsOnRequestData: true\` means that id's own source says it trains
  on request data.
- Fetch a self-contained JSON Schema (refs bundled under $defs) for any
  provider generation endpoint — request (input) and response (output).
  A listed model rawId also works as \`{endpointId}\`: it aliases onto that
  route and pins the request \`model\` field to the one id.
- Validate a payload server-side before spending tokens on a provider call.
- Estimate the cost of a call from the stored rate card, in the card's
  currency (\`POST /v1/estimate\`).
- Poll /v1/changes (or subscribe via webhooks) to hear about new models and
  API revisions. A catalog.shape_changed change means the model row itself
  changed shape (payload.version, payload.notes): re-read openapi.json.
  /v1 changes are otherwise additive; ignore keys you do not know.

## Quickstart (no auth needed for reads)

1. GET /v1 — endpoint index.
2. GET /v1/models?activity=chat — cross-provider catalog of chat models.
   GET /v1/providers/{provider} — one provider's status, counts, and live
   models per activity.
3. GET /v1/schemas — system-wide index: every provider's activities and
   endpoint ids in one response (all schemas on the system).
4. GET /v1/schemas/anthropic — activities + endpoint ids for one provider.
5. GET /v1/schemas/anthropic/chat/{endpointId}?kind=input — the JSON Schema
   for a request body (endpoint ids contain slashes; URL-encode them).
   Grain=provider models also accept the raw id:
   \`/v1/schemas/grok/image/grok-imagine-image-2.0?kind=input\`.
6. GET /v1/openapi/{provider} — generation-only OpenAPI (servers, auth,
   paths). FAL is one queue document: the model id is the endpoint_id path
   parameter (x-modelschemas-encode: raw — do not percent-encode slashes).
   Bare, the bodies are untyped; ?activity= inlines each model's own body
   schema (up to 1024 models); ?model= is that one model's paths. A filter
   that matches none: 400
   spec_requires_selector. HTTP only (no MCP tool).
7. POST /v1/validate {"provider","endpointId","payload"} — check a payload.
8. POST /v1/estimate {"provider","model","request"?,"usage"?} — {amount,
   currency} for a call from the stored rate card. Missing levers → 422;
   no card → 404 unknown_pricing. See "Estimate usage" below.
9. GET /v1/changes?since=<unix epoch> — what changed.

## TypeScript types

Add \`?format=types\` to a schema read
(GET /v1/schemas/{provider}/{activity}/{endpointId}) to get a self-contained
TypeScript module instead of JSON: the schema as a pure const plus generated
interfaces (\`text/typescript\`, zero imports, tree-shakeable, same ETag
discipline). \`?optional=undefined\` widens optional properties to
\`T | undefined\` for exactOptionalPropertyTypes consumers; default is
\`foo?: T\`. A request \`model\` field is the live catalog union plus
\`ListedModelId<'provider'>\` (still branded when the catalog is empty).
Minted by \`listModels\` / \`listProviderModels\` / \`getModel\` (or
\`asListedModelId\`). Arbitrary \`string\` values do not assign.

## Hypermedia (HAL, extended)

Every JSON read response carries \`_links\`: HAL link objects extended with
\`method\`, \`contentType\`, and an inline \`example\` (a resolvable URL for
GETs, a request body for POSTs) so you can follow the API without consulting
docs. Templated hrefs (RFC 6570) set \`"templated": true\` and always include
an example. Start at GET /v1 and follow \`_links\`.

## Long-polling

No sleep tool? Add \`?wait=30\` (seconds, cap 60, \`30s\` form accepted) to
GET /v1/changes or GET /v1/status: the request holds until new data lands or
the window expires, then returns whatever is current. One request, one
rate-limit token.

## Caching

Catalog and current schema reads (\`/v1/models\`, \`/v1/providers\`, \`/v1/schemas\`,
\`/v1/openapi/{provider}\`) send \`Cache-Control: public, max-age=900\` (the
15-minute model poll) and are edge-cached. A schema read with
\`?version=<content hash>\` is immutable and cached for a year. Responses also
carry ETag (content hash), Last-Modified, X-Fetched-At and X-Stale-At (unix
epoch seconds). Send If-None-Match to get 304s. \`/v1/changes\` and
\`/v1/status\` are not edge-cached. A response served from the edge does not
run the worker, so it does not count toward the rate limit, with or without
Authorization. Only cache misses are counted.

## Auth (optional — unlocks higher rate limits + webhooks)

- Agent-auth protocol: discovery at /.well-known/agent-configuration,
  register at POST /api/auth/agent/register, then execute capabilities with
  short-lived JWTs.
- Simple alternative: POST /v1/agents/register-key { "name" } returns an API
  key once; send it as Authorization: Bearer <key>.

## Machine-readable spec

GET /openapi.json — OpenAPI 3.1 for this service; every operation has an
operationId. GET /skill — installable agent skill (SKILL.md) teaching this
full workflow.

## Estimate usage

\`usage\` on POST /v1/estimate takes one of two shapes. A payload that
mixes them gets 422 mixed_usage.

- The provider's own usage object, as the API returned it: OpenAI
  Responses or Chat Completions \`usage\`, Anthropic \`usage\`, or Gemini
  \`usageMetadata\`. The service maps it to card levers.
- Card levers. Their counts do not overlap: \`input_tokens\` excludes the
  tokens in \`cache_read_tokens\`, \`cache_write_tokens\` (5-minute writes)
  and \`cache_write_1h_tokens\`. A card can also read \`reasoning_tokens\`,
  \`audio_tokens\`, \`image_tokens\` or \`web_searches\`; a count in one of
  these is not also in \`input_tokens\` or \`output_tokens\`. The model's
  \`pricing.inputs\` (GET /v1/models/{provider}/{id}) lists the levers its
  card reads. A zero card lever the card does not read is dropped. A
  non-zero one is 422 \`unknown_usage_key\`.

| Native field | Card lever |
| --- | --- |
| OpenAI \`input_tokens\` or \`prompt_tokens\` | \`input_tokens\`, less cached tokens and cache writes |
| OpenAI \`*_details.cached_tokens\` | \`cache_read_tokens\` |
| OpenAI \`*_details.cache_write_tokens\` | \`cache_write_tokens\` |
| OpenAI \`prompt_tokens_details.image_tokens\` | \`image_tokens\` when the card reads it; otherwise it stays in \`input_tokens\` |
| OpenAI \`prompt_tokens_details.text_tokens\` | not subtracted; it is already inside \`prompt_tokens\` |
| OpenAI \`output_tokens\` or \`completion_tokens\` | \`output_tokens\` |
| Anthropic \`input_tokens\` | \`input_tokens\` (already excludes cache) |
| Anthropic \`cache_read_input_tokens\` | \`cache_read_tokens\` |
| Anthropic \`cache_creation_input_tokens\` | \`cache_write_tokens\`; 1-hour writes go to \`cache_write_1h_tokens\` |
| Gemini \`promptTokenCount\` | \`input_tokens\`, less \`cachedContentTokenCount\` |
| Gemini \`cachedContentTokenCount\` | \`cache_read_tokens\` |
| Gemini \`candidatesTokenCount\` + \`thoughtsTokenCount\` | \`output_tokens\` |

Reasoning, audio, image and video counts move to their own lever only
when the card reads that lever. Otherwise they stay in the total, because
the source bills them at that rate. Example: gpt-5 usage
\`{"input_tokens":12000,"input_tokens_details":{"cached_tokens":4000},"output_tokens":800}\`
prices 8000 input, 4000 cached and 800 output tokens.

## Errors

All errors are JSON: { "error": { "code", "message" } }. Messages include
remedies (e.g. valid provider ids on a 404).
`
