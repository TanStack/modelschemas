# API changes

Non-additive changes to the catalog and estimate API. Package release
steps stay in the README under "Releasing on npm". npm package changelogs
are written by changesets.

**Breaking:** `GET /v1/openapi/{provider}` has no `{path}#stream`
operations. JSON and `text/event-stream` share one operation's `200`, and
schemas live in `components.schemas` (every `$ref` resolves). hey-api
clients lose typed streaming until hey-api/hey-api#4482 is fixed (README,
"Generation OpenAPI").

**Breaking (0.1.x):** `capabilities` is a map of booleans, not a list of
flag names: `["tools", "reasoning"]` is now `{ "tools": true, "reasoning":
true }`, and a flag the provider states the model does not support is
`false`. Replace `capabilities.includes('tools')` with
`capabilities?.tools === true`. A missing key is unknown, not `false`. The
provider-native objects five providers kept in `capabilities` (fal
`{ category }`, BytePlus, ElevenLabs, Replicate, Reactor) moved to the new
`providerMetadata` field, so `capabilities` is a boolean map or `null` on
every row. `?capability=` matches a flag set to `true` by exact name; it
was a substring match over the stored JSON, so `?capability=text-to-image`
(a fal category) no longer matches anything. Use `?activity=` or read
`providerMetadata.category`.

**Added (0.1.x):** model rows gain `releasedAt`, `knowledgeCutoff`,
`openWeights`, `weightsUrl` and `providerMetadata`, all nullable
(README, "Capability flags, dates and provider metadata").

Both need D1 migrations `0013` (columns) and `0014` (stored capability
lists become maps; native objects move to `provider_metadata`). Migrate
first, then deploy: `pnpm run deploy:ci` does both in that order.

**Breaking (0.1.x):** `reasoning.mode` gains `toggle` (an on/off thinking
switch and nothing else), and `reasoning.mandatory` is `boolean | null`.
`null` means the provider's source does not say whether thinking can be
turned off. It must NOT be read as `false`: `if (!reasoning.mandatory)`
now misreads it, so test `reasoning.mandatory === false` before offering
an off option. `efforts` is never present on `toggle`, a `toggle` row
always has a stated `mandatory`, and a `switch (mode)` needs a `toggle`
case. `true` means the provider states thinking cannot be turned off —
but rows written before this rule also store `true` when a level list
merely has no `none`. Until those adapters are converted, treat `true` as
"inferred" on `openai`, `vercel`, `amazon-bedrock` (effort rows),
`mistral`, `groq`, `grok`, `moonshotai-cn`, `baseten`, `byteplus`,
`fal`, and on the `effort` rows of `gemini` and `google-vertex`.

**Breaking (0.1.x):** `models.pricing` is a RateCard or `null`, not an
OpenRouter `{ prompt, completion, … }` blob. List rows carry a summary of
the stored card — `{ per: 'token', inputPerMillion, outputPerMillion }` at
the base rate (`tiered: true` when long prompts re-quote), or
`{ per: 'second' | 'character' | 'image' | 'request' }` for a card billed
by unit — so `null` on a list row always means no card. `GET
/v1/models?pricing=1` and model detail return the full card, and
`GET /v1/status` counts `priced` models per provider. Together all-zero placeholders are
`null`. `POST /v1/estimate` evaluates a stored card.

**Breaking (0.1.x):** `POST /v1/estimate` (and the MCP `estimate_cost`
tool, and `estimateCost` in `@modelschemas/client`) can return a range
(#406). A routed id whose routes bill different prices (LLM Gateway bare
ids such as `gpt-oss-120b`) has `pricing: null` and a `pricingRange`:
min/max per million over the routes' published cards, each route named by
its own pinned row (`groq/gpt-oss-120b`). It is a bound, never the billed
price. Estimating such a row prices the call on every route and returns
`{ currency, min, max, routes }` instead of `{ amount, … }`; `min` and
`max` each carry `model` (the route) and the usual result fields. A route
with no card refuses the estimate. Check for `min` before reading
`amount`. Vercel rows whose price varies by route (#346, #451) are
`pricing: null` and, after the daily `/endpoints` extract, a
`pricingRange` whose routes are Vercel `provider_name`s with the card
inline. An endpoint with `status` other than 0 is omitted and named on
`factSources.pricingRange` (`skipped status!=0`). It is not a catalog row.

**Breaking (0.1.x):** `POST /v1/estimate` (and `estimate_cost`,
`estimateCost`) has a third result shape (#450). When the call omits
exactly one required choice input (an enum or boolean with no default,
such as BytePlus `pricing_period: off_peak | peak`) and supplies every
other required input, it returns `{ currency, byInput: { input, values }
}`: one usual result per allowed value, keyed by value (`"true"`/`"false"`
for a boolean). Supplying the input returns one result as before. Two
omitted choices, or any omitted quantity, is still 422 `unbound_input`,
now naming every omitted choice with its values. A routed id whose route
hits this case refuses. Check for `byInput` (and `min`) before reading
`amount`. `RateCardError` in `@modelschemas/rate-card` gains `input`: the
card input the caller did not supply, on `bad-input` "required" and
`estimate-unavailable`.

**Breaking (0.1.x):** Native DeepSeek cards hold both published rates
behind required `usage.pricing_period` (`off_peak` or `peak`, #449). The
service does not choose a period from the clock. Omitting only that choice
returns `byInput` (#450). An unknown value is refused.

**Breaking (0.1.x):** `opencode-go` endpoint ids moved from `v1/<tail>` to
the documented `inference/go/<protocol>/v1/<tail>` (#393), e.g.
`/v1/schemas/opencode-go/chat/inference/go/openai/v1/chat/completions`.
The next spec sync emits `endpoint.removed` for the old ids. Until it runs,
polls leave Go models unbound; run `POST /v1/admin/sync/opencode-go` after
deploy.

**Deprecations:** for Groq and Mistral the poll reads the provider's own
deprecations page. A model it lists carries `deprecation: { deprecatedAt,
retiresAt, replacedBy, sourceUrl }` exactly as stated (null where the page
states nothing) and is deprecated: `deprecatedAt` is set, so it leaves the
default `GET /v1/models` list (`?deprecated=true` includes it) even while
it still answers before `retiresAt`. An id the page names that was never in
a listing gets a retired row with only those facts. Each change to an entry
is a `model.deprecated` change in `/v1/changes`. Other providers'
`deprecatedAt` is still when the row was flagged or left the listing.

**Currencies:** rate cards may be in a currency other than USD.
`moonshotai-cn` and `minimax-cn` are priced in CNY. A USD card is unchanged;
a card in another currency wraps its price as
`{ "currency": ["CNY", <expression>] }` (ISO 4217), and that wrapper is the
only place the currency is stated. `price()` returns an amount in the
card's currency. **`@modelschemas/rate-card` 0.1.0 cannot read non-USD
cards: it rejects them at parse and `price()` throws `unknown-op`, so it
refuses rather than report yuan as dollars. 0.2.0 reads them.**
`/v1/estimate` and `estimate_cost` return `{ amount, currency }`; `usd` is
present only for USD cards and is deprecated. List summaries always include
`currency`. Nothing is converted, so amounts in different currencies never
compare.

Cards come from each host's own source — the OpenRouter, Together and xAI
listings (`listing`), and the OpenAI, Anthropic and Gemini pricing pages
(`docs-derived`); `factSources.pricing` says which. Token models carry
their cache, media-token and long-prompt rates; models billed by the
second, the minute, the character, the image or the request carry a
`quantity × rate[size]` card instead. What a source does not state, a card
does not guess: an unrecognised surcharge, a rate keyed on something the
request cannot express, or an alias the pricing page never names leaves the
model with no card rather than a partial one. A card is re-read when its
source text changes, or once the `expiresAt` of a dated price change has
passed.

**Breaking (`@modelschemas/rate-card` 0.2.0):** the package ships built
JS and .d.ts, not TypeScript source. `zod` is an optional peer
dependency: install it to import the package root (`rateCardSchema`).
`@modelschemas/rate-card/evaluator` (`evaluateCard`, `price`,
`normalizeUsage`) imports no package and runs on edge runtimes.
