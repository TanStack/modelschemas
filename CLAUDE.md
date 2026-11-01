# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A Cloudflare Workers service giving AI agents live access to model schemas:
per-endpoint request/response JSON Schemas and model metadata for 8 monitored
providers (OpenAI, Anthropic, Gemini, xAI Grok, ElevenLabs, OpenRouter, FAL,
BytePlus),
with react-query-style server-side caching (D1 source of truth, KV hot cache,
stale-while-revalidate) and cron-driven auto-refresh. Design ported from
TanStack AI PR #622 (`@tanstack/ai-schemas`), minus codegen — schemas are
extracted/bundled at runtime and served over HTTP/MCP.

The service is live at https://modelschemas.openstory.workers.dev. `0.1.0`
is on npm (`@modelschemas/*` plus unscoped `modelschemas`). Further
versions: OIDC `npm stage publish` via `.github/workflows/publish.yml` —
README "Releasing on npm".

**`PLAN.md` is a historical build log**, not the backlog. Open it for a
gotcha or decision from phases 0–18. New work is GitHub issues. This file
is the live map.

## Commands

Bun is the package manager; the repo is a bun workspace (`packages/*`).

```bash
bun install              # install + link workspace packages
bun run dev              # local D1 migrate, then dev server on http://localhost:3100 (NOT --bun: bun's ws shim hangs vite)
bun run test             # vitest, unit + workers projects (NOT --bun: cloudflare pool needs node)
bun run test src/path/to/file.test.ts       # single test file
bun --bun run lint       # oxlint --type-aware (no-explicit-any + no-unsafe-* are errors)
bun run typecheck        # tsc --noEmit (includes packages/*)
bun --bun run format     # oxfmt + oxlint --fix
bun --bun run check      # oxfmt --check
bun --bun run build      # production build (emits dist/server/wrangler.json)
bun run deploy           # build + wrangler deploy
bun run npm:pack         # pack public packages to dist/npm (no publish)
```

Database (drizzle-kit generates; wrangler applies):

```bash
bun run db:generate          # generate migrations from src/db/schema.ts
bun run db:migrate           # apply to wrangler's LOCAL D1
bun run db:migrate:remote    # apply to remote D1
bun run seed                 # seed the 8 providers (--remote for prod)
```

Generated artifacts (committed; CI fails on drift):

```bash
bun run openapi:emit         # src/server/openapi.ts → openapi.json
bun run generate:client      # → packages/client/src/generated (hey-api)
bun run check:client         # regenerate + git diff --exit-code (CI step)
bun scripts/emit-skill.ts    # src/server/skill.ts → skill/modelschemas/SKILL.md
```

A PR that touches `packages/*` (including the generated client) needs a
changeset (`bunx changeset`), or `bunx changeset --empty` when nothing
ships; CI runs `changeset status --since=origin/main` on PRs and fails
without one. `openapi.json` and `SKILL.md` are oxfmt-ignored (byte-stable
emitted artifacts). Lefthook pre-commit runs oxfmt/oxlint/typecheck — never
`--no-verify`. The cloudflare vite plugin is skipped under vitest;
Workers-binding tests (`*.worker.test.ts`) run in workerd via
`@cloudflare/vitest-plugin` (config: `vitest.workers.config.ts`,
migrations auto-applied via TEST_MIGRATIONS).

Local verification flows: `bun scripts/agent-roundtrip.ts` (agent-auth
register→execute), `bun scripts/client-smoke.ts` (typed client),
`bun packages/cli <cmd>` (CLI), `bun scripts/rederive.ts <provider>`
(re-derive schema content hashes from the upstream spec — no service/db;
shares `classifyAndBundle` with the sync engine), `bun run gap:report --table`
(per-provider score for the chat facts `@tanstack/ai-models` needs; one
`/v1/models` request; `docs/source-silent/<provider>.md` lists facts a provider does not
publish; `--check` exits 1 below `--target`). Admin sync:
`curl -X POST localhost:3100/v1/admin/sync/openrouter -H "X-Admin-Key: $ADMIN_KEY"`.

## Architecture

TanStack Start (React 19, SSR) on Cloudflare Workers via the Cloudflare vite
plugin + `wrangler.jsonc`. Tailwind v4. Worker entry is `src/worker.ts`:
rate-limits `/v1/*`, delegates fetch to the Start handler, and runs the
crons (15-min models poll + webhook drain; daily spec sync sharded across
four 05:00–05:30 UTC firings — FAL alone in shard 0, the rest round-robin —
so each shard gets its own invocation budgets; see `SPEC_SYNC_SHARD_CRONS`;
FAL `llms.txt` rate-card extract hourly 06:00–11:00 UTC —
`FAL_PRICING_EXTRACT_CRONS`).

Request path: route files in `src/routes/` (server handlers via
`server.handlers`) → service functions in `src/server/` → drizzle/D1 +
KV. Bindings come from `import { env, waitUntil } from 'cloudflare:workers'` —
typed by the committed, wrangler-generated `worker-configuration.d.ts`
(`bun run types` regenerates it; rerun after changing wrangler.jsonc or
.env.local since secret names are typed into Env). Workers runtime types are
GLOBAL (KVNamespace, D1Database, …) — do not import from
@cloudflare/workers-types (removed; its types conflict with the generated
ones).

- **BytePlus** publishes no OpenAPI document (`/openapi.json` is a catch-all
  200-empty; the real ones sit behind the console's API Explorer login), so
  its Ark spec is GENERATED at sync time from BytePlus's official Go SDK:
  `fetchSpec` pulls `service/arkruntime/model/*.go` from GitHub,
  `go-struct-parser.ts` turns the `json:"…"`-tagged structs into schemas, and
  `byteplus-ark-build.ts` maps them onto paths and re-applies curated
  descriptions plus the few request fields the SDK omits. `byteplus-spec.ts`
  holds the hand-ported fallback used when that fetch/parse fails, and the
  Seed Speech document, which no SDK covers. The model catalog is live when
  `ARK_API_KEY` is set (Ark `GET /models`), with the embedded catalog filling
  the gaps that listing omits — Seed Speech and unlisted-but-served ids.
- **Ingest** (`src/server/providers/` + `src/server/ingest/`): per-provider
  `ProviderConfig` (fetchSpec/listModels/classify) → `bundle.ts` extracts
  request/response schemas and inlines `$ref` closures under `$defs` →
  `sync.ts` content-hash-diffs into `schema_versions` + `changes`, warms KV;
  `poll-models.ts` diffs model lists. Keyed providers skip cleanly when the
  secret is absent. `models.pricing` is a RateCard or null: listings compile
  at write (`src/server/rate-card.ts`), and OpenAI/Anthropic/Gemini prices
  are parsed from their pricing pages (`*-pricing.ts`, `openai-model-docs.ts`)
  — every parser fail-closed, a page that parses nothing throws rather than
  nulling stored cards. A card is USD unless its price is wrapped
  as `{ currency: ['CNY', expr] }` (`moonshotai-cn`, `minimax-cn`): the
  wrapper is the one place a currency is stated, and it is not a core op so
  pre-currency evaluators refuse the card. Summaries and estimates name the
  currency; nothing converts or compares across currencies.
  A listing that omits a price keeps the stored card
  and logs `pricing_lost`; any other omitted fact is written null once the
  usual fills are tried (the bound schema for capabilities and modalities,
  the provider table for the request map). An adapter that knows why says
  so in `ModelInfo.absent` (`FactAbsence` in `types.ts` has the exact
  table): `cleared` writes null quietly (Hugging Face hosts that stopped
  agreeing on a price), `unavailable` keeps the stored value. `cleared` is
  only for a value the source visibly lacks: an unreadable shape throws,
  and the poller refuses a poll that would clear 5 or more stored prices
  and over half of the priced rows the provider lists (`refusesPriceClears`).
  A refused mass clear repeats every poll until the adapter or the bound
  changes, or the stale cards are nulled by hand in D1. Wrap a
  docs load in `tryDocs` (`model-facts.ts`) so its throw marks rows
  `unavailable(...)` and is reported as `docsFailures` instead of failing
  the provider's poll; the listing itself is never wrapped. While a
  provider's docs keep failing, `cache_meta` holds one
  `docs-failing:<providerId>` row saying since when (`docs-failing.ts`); a
  refused mass clear holds a `price-clears-refused:<providerId>` row the
  same way. `GET /v1/status` serves both per provider (`docsFailing`,
  `priceClearsRefused`), the home page marks the row, and neither changes
  `status`. `/v1/status` model counts are live rows only (`counts.deprecated`
  holds the rest), and `completeness` there is the gap-report score:
  `src/lib/completeness.ts` is the one scorer, shared with
  `scripts/gap-report.ts`; the Worker bundles `docs/source-silent/*.md`
  (`source-silent.ts`). The 15-minute cron scores once after the poll
  (`recordCompleteness`, one `cache_meta` row); requests only read it.
  BytePlus chat, Seedance, and Seedream cards come
  from its public ModelArk pricing doc (`byteplus-pricing.ts`; the console
  pricing view and `arkcli pricing` are login-gated). FAL cards come from `extract-fal-pricing.ts`:
  `fal-unit-rate.ts` compiles the common `$X per <unit>` sections with no
  model call, leftovers go to one extract model per distinct Pricing-section
  hash and are copied onto every row sharing it. A priced leftover must
  become a card (one repair turn, same model); a failed one rewinds the
  cursor so the next shard retries it once. The model call is TanStack AI
  `chat()` (`@tanstack/ai-anthropic` over `@tanstack/ai-cloudflare`'s `cloudflareBindingFetch`) on the `AI` binding through AI Gateway (`gatewayChat`, Unified
  Billing, gateway id `AI_GATEWAY_ID`); `scripts/compare-fal-extract-models.ts`
  scores candidates through the same code.
  `models.reasoning` (`{ mode, mandatory, efforts? }`; mode is
  adaptive/budget/effort/toggle). `mandatory` has one meaning: `true` the
  source STATES thinking cannot be turned off, `false` it states it can
  (prose, or an off value in the model's OWN schema or level list), `null`
  unstated — a shared schema or a list with no `none` states nothing. A
  `toggle` is never stored with `null`. Full rules on `ModelReasoning` in
  `providers/types.ts`; `reasoningViolation` gates every poll write
  (`keepValidReasoning`: a bad object keeps the prior value and emits
  `ingest_failed`). Older adapters still infer `true` (docs/api-changes.md
  lists them). `models.reasoning` and
  `models.serverTools` (provider tool type ids) come from docs: OpenAI and
  xAI model pages, Gemini model pages + thinking tables, the Anthropic
  Models API + thinking table; Anthropic tools and sampling support
  (`temperature`/`top_p`/`top_k`, `false` where the migration guides say 400) are hand-written tables
  in `anthropic-features.ts` (re-verify on each Claude launch).
- **Stated facts** (`settleStatedFacts` in `poll-models.ts`; contract in
  the `FactAbsence` comment in `providers/types.ts`): `models.capabilities`
  is a yes/no flag map (`src/lib/capabilities.ts`), a boolean map or null
  on every row. Adapters still emit the list of supported flags, plus
  `unsupportedCapabilities` for a stated no; `settleCapabilities` is the one
  place they become the map, and it adds `false` for `exactCapabilities`
  rows from the flags that provider's exact rows list in the same poll. A
  provider's native listing object goes in `providerMetadata`, never in
  `capabilities` (the gate refuses a non-flag value). `models.releasedAt`
  is the provider's own date (`firstSeenAt` still folds it in), kept when
  a listing stops stating it. `knowledgeCutoff` (`YYYY-MM[-DD]`) and
  `openWeights` + `weightsUrl` are null unless the provider states them.
  A stored row's first `releasedAt` or `providerMetadata` is written with
  no `model.updated`. Migration `0014` is a drizzle custom migration that
  converted the stored lists. A fact the provider's docs do not state can
  still come from a live API check: one file per provider under
  `src/server/providers/probes/`, derivation `probe-verified`, dated
  `verifiedAt`. The adapter binds that fact only for the exact model and
  route the record names. A record older than 90 days stays served;
  `GET /v1/status` counts it on `staleProbes`. Re-run with
  `bun scripts/probe.ts <provider> [--write]` (not CI, not the 15-minute
  poll). The script reads the provider key from the environment or Doppler
  and never prints it.
- **sameAs links** (issue #199, `src/server/ingest/model-identity.ts`): a
  reseller row links to the upstream row its own provider names — never
  inferred from a similar name alone, and never a copied fact. Adapters
  state the upstream with `ProviderConfig.upstreamModelIdentity`
  (OpenRouter, Vercel, Azure, Perplexity's `anthropic/`-style ids — not
  OpenCode, whose AI SDK package column names the wire protocol, not the
  maker); polls store it as evidence
  (`models.upstream_provider`/`upstream_raw_id`/`upstream_source`), writing
  only what changed. Names gateways use for a provider (`google` → gemini)
  are rows in `provider_model_namespaces`, mirrored from
  `ProviderConfig.modelNamespaces` on each poll by `ensureProviderRow`.
  `reconcileSameAs` runs once per poll run, across all providers, and
  resolves evidence to `same_as_model_id`: exact id, then alias, then
  dots-as-hyphens; ambiguous or missing → null. Each link change emits
  `model.updated`. The catalog serves the link, with the evidence as
  `factSources.sameAs`, only while the row's current evidence still names
  that target. Cloudflare AI Gateway is held until it has its own listing.
  Migration `0012` is hand-written (in-place `ALTER TABLE`, no rebuild).
- **API** (`src/routes/v1/`): catalog, schema reads (SWR via
  `src/server/cache.ts`, ETag/304 via `http-cache.ts`), `POST /v1/validate`
  (@cfworker/json-schema), `POST /v1/estimate` (`@modelschemas/rate-card`),
  cursor-paginated `/v1/changes`, subscriptions.
  Errors are always `{ error: { code, message } }` with remediation hints.
- **Spec components from zod**: the RateCard family (`packages/rate-card`)
  and `CompactPricing`, `PricingRange`, `ModelReasoning`, `ChatRequestMap`
  (`src/server/api-schemas.ts`) are zod schemas with a `.meta` id; the TS
  types are inferred from them and `openapi.ts` writes every id'd schema
  into `components.schemas`. Change the zod schema, not a hand-written
  component (the rest of `openapi.ts` is still hand-written). A spec change
  to a served row needs the `MODEL_ROW_SHAPE` bump.
- **MCP** (`src/server/mcp.ts`, route `/mcp`): stateless streamable-HTTP
  JSON-RPC wrapping the same service functions.
- **Auth** (`src/lib/auth.ts` factory → lazy runtime instance in
  `src/server/auth.ts`; betterAuth CANNOT construct at module scope in
  workerd): better-auth + agent-auth (capabilities derived from
  `src/server/openapi.ts`, admin ops excluded), api-key fallback, bearer.
  `requireAgent` (`src/server/require-agent.ts`) guards native routes; agent
  JWT jtis are single-use — mint per request. Rate limiting
  (`src/server/rate-limit.ts`): KV fixed-window, 60/h anon-IP, 5k/h
  per verified credential.
- **Webhooks** (`src/server/webhooks.ts`): checkpointed fan-out of `changes`
  to subscriptions, HMAC-SHA256-signed delivery, exponential backoff,
  auto-pause after 8 failures; drained by the 15-min cron. Destination URLs
  are SSRF-guarded (public https only, no redirects).
- **DB** (`src/db/schema.ts`): better-auth tables + providers/provider_model_namespaces/models/
  endpoints/schema_versions/changes + cache_meta/subscriptions/
  webhook_deliveries. Epoch-second integers for our tables; ids are slugs
  (`provider/path` for endpoints, `provider-rawid-slug` for models).
- **Workspace packages**: `packages/client` (`@modelschemas/client`,
  generated + hand-written auth entry), `packages/codegen`,
  `packages/vite`, `packages/cli` (`modelschemas` bin:
  login/whoami/models/schema/validate/estimate/changes/subscribe),
  `packages/rate-card` (`@modelschemas/rate-card`: pricing schema +
  evaluator + OpenRouter listing compiler; no Workers deps). Its
  `./evaluator` entry (`evaluateCard`) imports no package. Every public
  package's npm tarball is `bun run build` output (`dist/` JS + .d.ts);
  `npm-pack` lifts `publishConfig` onto the packed manifest. The CLI
  `bin` is `dist/index.js`. MAJOR.MINOR equals
  `RATE_CARD_LANGUAGE` (`card.ts`). The shared estimate cases
  (`packages/rate-card/src/fixtures/estimate-cases.ts`) run through the package, the packed
  tarball and `POST /v1/estimate`.
- **Path aliases**: `#/*` and `@/*` → `./src/*`; `.ts` import extensions
  allowed. `src/routeTree.gen.ts` is generated by the DEV SERVER (the pinned
  `tsr` CLI emits an old format) — never edit by hand; boot `bun run dev`
  after adding routes, then typecheck. No tests under `src/routes/` (the
  router treats them as routes; a `.claude` hook blocks them) — test the
  `src/server`/`src/lib` code the route calls.
- **Env**: `.env.local` holds `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`
  (http://localhost:3100 — JWT audiences are origin-bound), `ADMIN_KEY`,
  optional provider keys (`bun run secrets:pull` from Doppler `dev`;
  `DOPPLER_*` is stripped). Prod: `bun run secrets:push` or
  `wrangler secret put`. README has the full production-setup + runbook.

API map: `GET /v1` (index) · `/v1/status` · `/v1/providers[/{p}/models]` ·
`/v1/models[?activity,provider,capability,q,pricing]` · `/v1/models/{p}/{id}` ·
`/v1/schemas/{p}[/{activity}[/{endpointId}?kind,version]]` ·
`POST /v1/validate` · `POST /v1/estimate` · `/v1/changes` · `POST /v1/agents/register-key` ·
`/v1/agents/me` · `/v1/subscriptions` · `POST /v1/admin/sync/{p}` · `POST /v1/admin/extract/fal` ·
`/v1/admin/export` · `/openapi.json` · `/llms.txt` · `/skill` · `/docs` · `/mcp` ·
`/.well-known/agent-configuration`.
