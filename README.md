# modelschemas

Live AI model schema service on Cloudflare Workers: per-endpoint
request/response JSON Schemas and model metadata for monitored providers
(OpenAI, Anthropic, Gemini, xAI Grok, ElevenLabs, OpenRouter, FAL, BytePlus),
with
react-query-style server-side caching (D1 source of truth, KV hot cache,
stale-while-revalidate) and automatic refresh — model lists every 15 minutes,
full OpenAPI spec syncs daily.

Surfaces:

- **HTTP API** under `/v1` — catalog, schemas, validation, cost estimate,
  changes feed (see `GET /v1` or [openapi.json](./openapi.json))
- **Agent guide** at `/llms.txt`, **agent skill** at `/skill`, **docs** at `/docs`
- **MCP server** at `/mcp` (streamable HTTP; tools: `list_models`,
  `get_model`, `get_schema`, `validate_payload`, `estimate_cost`,
  `recent_changes`)
- **Agent auth** — agent-auth protocol discovery at
  `/.well-known/agent-configuration`, plus an API-key fallback
  (`POST /v1/agents/register-key`)
- **TS client** `@modelschemas/client` (packages/client, generated from the
  spec) and the **`modelschemas` CLI** (packages/cli)
- **Build-time pulls** — `@modelschemas/vite` (packages/vite) +
  `@modelschemas/codegen` (packages/codegen): commit selected schemas and
  generated TypeScript into your repo, fetched at dev time only

## Build-time schema pulls (vite plugin + CLI)

Pull self-contained TypeScript modules (JSON Schema const + generated
interfaces — pure exports, no barrel, tree-shakeable) into your project.
Files are committed; production builds touch zero network.

```ts
// vite.config.ts
import { modelschemas } from '@modelschemas/vite'

export default defineConfig({
  plugins: [
    modelschemas({
      selections: ['anthropic/v1/messages#request', 'openai/chat/*'],
      outDir: 'src/modelschemas', // default; commit it
      apiKey: process.env.MODELSCHEMAS_API_KEY, // optional — lifts rate limits
    }),
  ],
})
```

```ts
import {
  anthropicV1MessagesRequestSchema,
  type AnthropicV1MessagesRequest,
} from './modelschemas/anthropic/v1-messages.request.ts'
```

The dev server pulls whatever is missing and _reports_ upstream schema
drift (it never rewrites existing files); `modelschemas update` is the
explicit refresh and the git diff is the review. `vite build` only verifies
files match the `.manifest.json` lockfile — offline, reproducible. Without
vite: `modelschemas pull 'anthropic/*' --out src/modelschemas`. The raw
surface behind all of this is `?format=types` on any
`/v1/schemas/{provider}/{activity}/{endpointId}` read
(`?optional=undefined` for `exactOptionalPropertyTypes` consumers who
assign `undefined` explicitly). Verify locally end-to-end with
`bun scripts/pull-roundtrip.ts`.

## Provenance & verification

You don't have to trust that a schema served here matches its upstream —
every derivation is recorded and reproducible:

- **Provenance on every version.** Each stored schema version records the
  upstream document it was derived from: `sourceUrl`, `sourceHash`
  (SHA-256 of the document as fetched — for file-served specs,
  `curl -s <sourceUrl> | shasum -a 256` reproduces it), `fetchedAt`, and
  the `extractorVersion` that derived it.
  `GET /v1/schemas/{provider}/{activity}/{endpointId}` returns all of it
  alongside the schema.
- **Content-addressed schemas.** `contentHash` is the SHA-256 of the
  key-sorted schema JSON; it doubles as the ETag and the
  `?version=<contentHash>` address, so a pinned version is immutable by
  construction.
- **Re-derive the hashes yourself.** The extraction pipeline is this repo;
  `bun scripts/rederive.ts <provider>` runs the same
  fetchSpec → classify → bundle → hash pipeline the sync engine runs
  (shared code, `classifyAndBundle`) directly against the upstream spec —
  no service, no database — and prints every endpoint's `contentHash`.
  Matching hashes prove the served schema is exactly what the upstream
  document derives to. If they differ, compare `sourceHash` first: the
  upstream usually moved after the service's last daily sync.
- **Verify your pulls.** `modelschemas verify` checks committed files
  against the `.manifest.json` lockfile, then re-fetches every entry at
  its pinned `?version=<contentHash>` address, recomputes the hash
  locally, and exits non-zero on any mismatch — so pulled schemas keep
  matching their content addresses, with each check's provenance telling
  you which upstream document to audit.

### Same model at another provider

A model row carries `sameAs: { provider, rawId }` when its own provider names
the upstream model — a gateway id such as `anthropic/claude-opus-4.5`, or
Azure's OpenAI model ids — and that model has a catalog row. It is a link
only: the row's price, limits, and other facts stay its own provider's.

- Within the named provider an exact id wins, then a documented alias, then
  the same with dots read as hyphens (`claude-opus-4.5` → `claude-opus-4-5`).
- `sameAs` is `null` when no upstream is stated, or the stated one matches no
  row or more than one. Priced variants such as `:batch` stay unlinked.
- `factSources.sameAs` records the source when the link is set, with
  `normalized: true` for a dots-as-hyphens match. Detail responses include
  it; model lists include it by default (`?provenance=0` explicitly omits it).
- Links refresh on each model poll (every 15 minutes) and a change emits
  `model.updated`.

### Capability flags, dates and provider metadata

`null` means "we do not know" on every model field.

- `capabilities` (`Record<string, boolean> | null`) is a map of flags:
  `{ "tools": true, "reasoning": false }`. `true`: the provider states the
  model supports it. `false`: the provider states it does not. Key absent:
  unknown. Never read a missing key as `false`; test
  `capabilities?.tools === true` to offer a feature and `=== false` to rule
  it out. `factSources.capabilities[flag]` is the source of each entry, a
  `true` and a `false` alike; a `false` whose source has `path: 'unlisted'`
  comes from the provider publishing the model's whole flag list without
  that flag. `?capability=tools` matches rows whose map has that flag set
  to `true` (exact flag name).
- `providerMetadata` (`object | null`): the provider's own listing object,
  as published and not normalised (fal `category`, BytePlus Ark features,
  ElevenLabs languages, Replicate visibility, Reactor pricing name). It is
  different for every provider and nothing in it is a capability flag.
- `releasedAt` (epoch seconds `| null`): the provider's own stated release
  or creation date. `firstSeenAt` still holds that date when there is one
  and our first observation otherwise; `releasedAt` is how to tell them
  apart. A row keeps its date when a listing stops stating it.
- `knowledgeCutoff` (`string | null`): `YYYY-MM`, or `YYYY-MM-DD` when the
  provider states a day. Never padded.
- `openWeights` (`boolean | null`) and `weightsUrl` (`string | null`): true
  only when the provider itself states the weights can be downloaded, with
  its link; false only when it states they cannot. Never inferred from a
  model name.
- `requiredRequestHeaders` (`array | null`): the client-supplied entries of
  the provider connect profile `requiredHeaders` (`name` plus the rule for
  the value). A constant header, such as `anthropic-version`, stays on
  `GET /v1/openapi/{provider}` as `schema.const` and is not copied here.
  Null when the provider publishes none. OpenCode Go lists
  `x-opencode-session` and `User-Agent`
  ([Go docs](https://opencode.ai/docs/go/), "Where can I use it?"). The
  same headers are parameters on each Go operation.
- `trainsOnRequestData` (`true | null`): true when that model's own source
  states it trains on request data. OpenCode Go reads the Privacy table
  (Yes). An id that table does not name can still be true from that id's
  probe record. Null when the table says Not used, or no source states it.
  Never inferred from an id suffix.

`knowledgeCutoff` and `openWeights` are null on every row until provider
adapters fill them. A row's first `releasedAt` and first `providerMetadata`
are written without a `model.updated` change; a later change emits one.

A `model.updated` event is written only when a fact changed.
`payload.changed` lists those field paths, for example `contextWindow` or
`pricing.tables.rate.base.input_tokens`, and is never empty. A source hash,
an extract time, the operand order of `+`, and the order of an input's
`values` are not facts: a poll that only moves them writes no row and no
event. The stored `source` then says when the price last changed.
`model.added` and `model.removed` are unchanged. `GET /v1/status` adds
`updateStorm` while one poll updated more than half of a provider's live
rows (and at least 20). The updates are still written; the field only
marks them, and the next quieter poll clears it.

### API stability (`/v1`)

The model row is typed field by field in [openapi.json](./openapi.json)
(`Model`, `ModelList`, `ProviderModelList`, `ModelDetail`, `ExportModel`),
and `@modelschemas/client` types its responses from it.

- **Additive changes** keep `/v1`: a new field, a new key in a map, a new
  enum value or change type. Ignore keys you do not know, and handle an
  enum value you do not know.
- **Any change to the row shape** (additive or not: a field added,
  removed, renamed, retyped or moved to another field) bumps
  `MODEL_ROW_SHAPE.version` in `src/server/row-shape.ts` and ships with a
  `@modelschemas/client` changeset. `row-shape.test.ts` hashes the row
  schemas (descriptions and the emitter's spelling excluded) and fails
  until the record matches, so a shape change cannot merge without one. A
  hash that moves with no served change (a zod bump respelling the same
  schema) is re-recorded under the same version and announces nothing.
- **The feed announces it.** The first models poll after the deploy
  (within 15 minutes) writes one `catalog.shape_changed` change per
  provider, `subjectId: "model-row"`, with
  `payload: { version, contentHash, previousHash, notes }`, and webhooks
  deliver it. Watch for it with `GET /v1/changes?type=catalog.shape_changed`.
  The rows of one announcement share `payload.contentHash`: dedupe on it
  when you read across providers. A provider added later gets the current
  shape's row on its first poll.
- A change that is not additive is also recorded in
  [docs/api-changes.md](docs/api-changes.md).

## Examples

Three TanStack Start apps in [`examples/`](./examples) exercise the
packages end-to-end: **schema-studio** (`@modelschemas/vite` pulls →
generative UI from JSON Schemas), **image-dimensions** (live image-model
discovery, supported dimensions drawn to scale), and **video-composer**
(request builder restricted to each video schema's allowed
model/aspect-ratio/duration values). `bun install`, then `bun run dev`
inside any example.

## Development

```bash
bun install
bun run dev              # dev server on http://localhost:3100 (NOT --bun)
bun run test             # vitest: unit + workers-pool projects (NOT --bun)
bun --bun run lint
bun run typecheck
bun --bun run build
```

Local data setup:

```bash
bun run db:migrate       # apply migrations to wrangler's local D1
bun run seed             # seed the 8 providers
bun run dev              # then, in another shell:
curl -X POST http://localhost:3100/v1/admin/sync/openrouter -H "X-Admin-Key: $ADMIN_KEY"
```

Secrets live in `.env.local` (see CLAUDE.md). Pull them from Doppler:

```bash
bun run secrets:pull     # Doppler `dev` → .env.local (strips DOPPLER_*)
```

`ADMIN_KEY` gates `POST /v1/admin/sync/{provider}`,
`POST /v1/admin/extract/fal`, and `GET /v1/admin/export` (the whole
catalog in one streamed response, for the git mirror). Useful scripts:
`bun scripts/agent-roundtrip.ts` (agent-auth end-to-end),
`bun scripts/client-smoke.ts` (typed client), `bun run check:client`
(client/spec drift), `bun scripts/emit-skill.ts` (regenerate SKILL.md),
`bun scripts/rederive.ts <provider>` (re-derive schema hashes from the
upstream spec, no service needed).

PostHog browser and API analytics use `VITE_PUBLIC_POSTHOG_PROJECT_TOKEN`
and `VITE_PUBLIC_POSTHOG_HOST`. Store these in the relevant Doppler config
and pull them into `.env.local` for development. These are public SDK
configuration values, not personal API credentials. Keep personal API keys
out of `VITE_PUBLIC_*` variables, which are included in the browser bundle.
The existing `POSTHOG_PROJECT_KEY` Worker secret separately captures ingest
signals.

Vite reads the public variables at build time. Configure both variables in
the Cloudflare Workers Builds environment before building production, or
build locally with `bun run secrets:build` (defaults to Doppler `prd`;
use `bun run secrets:build --config dev` for another config). This injects
only `VITE_PUBLIC_*` values from Doppler into the build process without
writing them to disk.
`secrets:push` only supplies Worker runtime bindings; it does not configure
the browser bundle, and skips `VITE_*` bindings. A build without these variables disables the new
analytics integration in production; development reports missing
configuration with an error.

## Production setup

1. Create resources and put their IDs in `wrangler.jsonc`:

   ```bash
   bunx wrangler d1 create modelschemas        # → d1_databases[0].database_id
   bunx wrangler kv namespace create SCHEMA_CACHE  # → kv_namespaces[0].id
   ```

2. Apply migrations and seed:

   ```bash
   bun run db:migrate:remote
   bun run seed -- --remote
   ```

3. Secrets (`wrangler secret put <NAME>`): `BETTER_AUTH_SECRET` (32+ random
   bytes), `ADMIN_KEY`, and optionally provider keys — `OPENAI_API_KEY`,
   `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`,
   `ELEVENLABS_API_KEY`, `FAL_KEY`, `ARK_API_KEY`. Providers without keys are
   skipped with a recorded warning (OpenRouter needs none; Anthropic's spec
   sync is also keyless). `ARK_API_KEY` is the exception: it is optional and
   only upgrades BytePlus's model catalog from the embedded one to Ark's live
   listing — BytePlus still serves schemas and a catalog without it.
   `GITHUB_TOKEN` is optional too. When set, `api.github.com` requests send
   `Authorization: Bearer` (the Cloudflare AI Gateway catalog listing). A
   classic personal access token with no scopes is enough to leave the
   anonymous 60-requests-per-hour quota that shared Worker egress exhausts.
   `raw.githubusercontent.com` fetches, including the BytePlus Go SDK, stay
   unauthenticated, and both polls still run when the token is absent. Set
   the `BETTER_AUTH_URL` var in `wrangler.jsonc` to the deployed origin
   (agent JWT audiences are origin-bound).

   Rather than setting them one at a time, reconcile against Doppler:

   ```bash
   bun run secrets:check   # Doppler prd ↔ Worker (names only)
   bun run secrets:push    # apply (one wrangler secret bulk call)
   ```

   It runs locally against your existing Doppler and wrangler logins, so no
   token goes near CI. Doppler is the source of truth: every name in the
   config is pushed except the remove list (`DOPPLER_*` context vars, and
   `BETTER_AUTH_URL` which is already a wrangler `vars` binding, and
   `VITE_*` build-time configuration).
   Secrets are written into a new Worker version rather
   than the live one (the live API refuses while an undeployed preview
   version exists); the next deploy inherits them. Nothing is ever deleted.
   Deliberately NOT a CI job: that would need a long-lived Doppler service
   token plus a Cloudflare API token in GitHub, turning repo write access
   into full production compromise.

4. Deploy and warm:

   ```bash
   bun run deploy
   curl https://<worker-url>/v1/status
   curl -X POST https://<worker-url>/v1/admin/sync/openrouter -H "X-Admin-Key: ..."
   ```

Cron triggers start automatically on deploy: `*/15 * * * *` (models poll +
webhook drain), four spec-sync shards (`0/10/20/30 5 * * *`) — each shard
is its own invocation with its own subrequest/CPU budgets, FAL alone in
shard 0, the rest of the registry round-robined across the other three
(`SPEC_SYNC_SHARD_CRONS` in `src/server/ingest/sync.ts`) — a daily
`0 4 * * *` firing for Vercel `/endpoints` price ranges
(`VERCEL_PRICING_EXTRACT_CRON`; rows with `varies_by_provider` only) —
and six hourly
firings `0 6-11 * * *` for the FAL per-endpoint `llms.txt` rate-card
extract (`FAL_PRICING_EXTRACT_CRONS`), each covering ~250 endpoints so the
whole FAL roster is walked in one calendar day. Most Pricing sections are a
single unit rate and compile with no model call; only the multi-rate ones
go to the extract model, once per distinct Pricing-section hash. Force one
shard's worth with `POST /v1/admin/extract/fal`;
`POST /v1/admin/sync/fal` stays spec-only.

The extract model runs through Cloudflare AI Gateway on Unified Billing,
so its cost lands on the Cloudflare bill and needs no provider key: the
Worker's `AI` binding calls the gateway named by the `AI_GATEWAY_ID` var
in `wrangler.jsonc` (TanStack AI `chat()` with the Anthropic adapter over
`cloudflareBindingFetch` from `@tanstack/ai-cloudflare`). Create that gateway in the dashboard (AI →
AI Gateway) and load credits on the account. Without them every
leftover fails and the cursor rewinds, as it does for any extract
error. Re-pick the model with `bun scripts/compare-fal-extract-models.ts`.

### Continuous deploys (Workers Builds)

Pushes to `main` deploy via Cloudflare Workers Builds (dashboard → Workers
& Pages → `modelschemas` → Settings → Build → connect the GitHub repo).
Settings:

- **Build command:** `bun run build`
- **Deploy command:** `bun run deploy:ci` — applies pending D1 migrations
  (`wrangler d1 migrations apply modelschemas --remote`, by database name so
  a binding rename can't retarget it) and then `wrangler deploy`, which
  follows the build-emitted redirect (`.wrangler/deploy/config.json`) to the
  real worker config at `dist/server/wrangler.json`. Deploying the repo-root
  `wrangler.jsonc` directly will not work.
- **Non-production branch deploy command:** leave as the default
  `npx wrangler versions upload` — preview versions share the production D1
  binding, so migrations must never run from non-production branches.

`bun run deploy` remains the manual/emergency path (build + the same
migrate-then-deploy).

## Releasing on npm

Non-additive API changes are recorded in [docs/api-changes.md](docs/api-changes.md).

Five public packages (`0.1.0` is on the registry; `@modelschemas/rate-card` from its bootstrap; `0.2.0` is the next release):

| Package                        | Directory            |
| ------------------------------ | -------------------- |
| `@modelschemas/client`         | `packages/client`    |
| `@modelschemas/codegen`        | `packages/codegen`   |
| `@modelschemas/rate-card`      | `packages/rate-card` |
| `@modelschemas/vite`           | `packages/vite`      |
| `modelschemas` (CLI, unscoped) | `packages/cli`       |

CI **never** holds an npm token. `.github/workflows/publish.yml` packs
with Bun (rewrites `workspace:*`), then `npm stage publish` over GitHub
OIDC. A human 2FA-approves each staged version before it is installable.

### Bootstrap (done 2026-08-21)

`npm trust` and `npm stage publish` require the package to already exist,
so the first version of each name was a laptop `npm publish` with 2FA,
then stage-only trusted publishers. Repeat that only when adding a **new
package name**.

Trusted-publisher config on every package must match:

```bash
npm install -g npm@11.19.0  # trust/stage need >= 11.15; npm 12 wants Node 24.15+
npm trust github <name> \
  --file publish.yml \
  --repo modelschemas/modelschemas \
  --env npm \
  --allow-stage-publish
```

Each package: **Settings → Publishing access → Require two-factor
authentication and disallow tokens**. GitHub Environment `npm`: required
reviewer; deployment branches limited to `main` and tags `v*`.

### Ongoing releases

1. A PR that changes a published package adds a changeset
   (`bunx changeset`). The five packages share one version. MAJOR.MINOR
   must equal `RATE_CARD_LANGUAGE` in `packages/rate-card/src/card.ts`
   (a test checks it): a release that changes what a card can say bumps
   both (minor), and a release that does not is a patch.
2. On main, the Publish workflow keeps a **Version Packages** PR open
   that applies the pending changesets (versions + CHANGELOGs). Merge it.
3. That merge's Publish run sees no changesets and a version npm lacks,
   so it runs CI, packs, then (after the `npm` environment approval)
   `npm stage publish`. Inspect the tarball artifacts on the run. Pushing
   a `vX.Y.Z` tag still works as a manual trigger.
4. On [npmjs.com](https://www.npmjs.com) → **Staged Packages**, 2FA-approve
   in the same order as bootstrap. Until you approve, `npm install` cannot
   see the version.

Dry-run the pipeline without staging:

```bash
# Actions → Publish → Run workflow, leave dry_run checked
# or locally:
bun scripts/npm-pack.ts --pack-dir dist/npm
```

Do not add `NPM_TOKEN` / `NODE_AUTH_TOKEN` to GitHub Secrets. `bun publish`
is token-auth only and is not used for releases.

## Runbook: a provider sync is failing

1. `GET /v1/status` — the failing provider shows `status: "degraded"` and a
   stale `lastSyncedAt`/`lastPolledAt`.
2. Tail logs during a manual sync (`observability.enabled` is on, so the
   dashboard's Workers Logs works too):

   ```bash
   bunx wrangler tail modelschemas --format pretty
   # in another shell:
   curl -X POST https://<worker-url>/v1/admin/sync/<provider> -H "X-Admin-Key: ..."
   ```

   Cron handlers log structured JSON lines:
   `{"job":"models-poll"|"spec-sync"|"webhooks", outcomes:[{providerId, error?, skipped?, ...}]}`.

3. Interpret the outcome:
   - `skipped: "<provider>: X_API_KEY not set"` → set the secret
     (`wrangler secret put X_API_KEY`) or ignore if intentional.
   - `error: "fetch failed: <url> → 4xx/5xx"` → the upstream spec/models URL
     moved or is down; check `providers.spec_source_url` (seeded from
     `src/db/seed-providers.ts`) against the provider's docs.
   - Anthropic `403 forbidden` or Gemini
     `User location is not supported` on the models poll, or an OpenAI
     `docsFailures` entry `403 Forbidden … hkg1::` → the host refused the
     caller's region. Their listing calls (and Anthropic's and OpenAI's
     docs pages) go through the `US_EGRESS`
     Durable Object (`src/server/providers/us-egress.ts`), created with
     `locationHint: 'enam'`. The hint is best effort and an object never
     moves, so if this persists, change its name (`provider-egress`) so
     a fresh object is created under the hint.
   - Dangling-`$ref` warnings → the upstream spec changed shape; see
     `src/server/ingest/bundle.ts`.
   - `docsFailing` on a `/v1/status` provider (a `docs` marker on the home
     page) → a docs page stopped loading or changed shape. Polls go on and
     `status` stays as it was; the docs-derived facts are frozen at their
     stored values. `sources` and `error` name the page: fix its parser in
     the provider's adapter. The next poll whose docs all load clears it.
   - `priceClearsRefused` on a `/v1/status` provider (a `prices` marker) →
     a poll asked to clear `refused` of `priced` stored prices and none was
     cleared. Either the adapter misreads a reshaped listing (fix it), or
     the prices really are gone (null the stale cards by hand in D1). The
     next poll that refuses nothing clears it.
   - `updateStorm` on a `/v1/status` provider (an `updates` marker) → one
     poll wrote `model.updated` for more than half of the live rows, and
     at least 20. The events were written. A new kind of non-fact is the
     usual cause; a real catalog-wide repricing looks the same. The next
     poll under that line clears it.
   - Those records are written and cleared only by a poll whose listing
     loads. While the listing itself fails (`lastPolledAt` stalls) they stay
     as last written, with an old `lastAt`.
   - `completeness.score` null for every provider and
     `completenessComputedAt` null → no score is stored, as after a deploy
     that changes the scorer. The 15-minute poll cron computes it; trigger
     that cron to force a recompute. A failed computation logs
     `{"job":"completeness","error":…}` and keeps the previous scores.
4. One provider failing never sinks the run (per-provider isolation); fix
   and re-trigger with the admin sync endpoint. Schema history is preserved
   across failures — superseded versions stay queryable via
   `?version=<contentHash>`.

## Architecture

See `CLAUDE.md` for the operational map. `PLAN.md` is the completed build
log (not the backlog). Borrows the provider-registry,
activity-grouping, and `$defs`-bundling design from TanStack AI PR #622,
re-implemented as a runtime service (no codegen) on Workers.
