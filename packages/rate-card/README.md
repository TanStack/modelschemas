# @modelschemas/rate-card

Model pricing as data. A rate card is JSONLogic over a closed op set
(`var`, arithmetic, comparisons, `if`, `and`/`or`, `ceil`/`floor`,
`max`/`min`, plus `lookup` into named tables) with the source page's worked
examples attached. The evaluator refuses instead of coercing: an unknown op,
unbound input, missing table key, non-numeric operand or non-positive price
throws `RateCardError`. A refusal is an honest unknown.

> Ships as ES2022 JS with .d.ts; no Cloudflare, Node or DOM imports.

```bash
bun add @modelschemas/rate-card
```

## Evaluate a card

`@modelschemas/rate-card/evaluator` has no dependencies, so it runs on
edge runtimes. Fetch a card from `GET /v1/models/{provider}/{id}`
(`pricing`) and price each call where it happens:

```ts
import { evaluateCard } from '@modelschemas/rate-card/evaluator'

const { amount, currency, estimated } = evaluateCard(model.pricing, {
  request, // the request body, for request-bound levers
  usage: response.usage, // card levers or the provider's own usage object
})
```

`evaluateCard` returns `{ amount, currency, estimated }`. `POST /v1/estimate`
returns those plus `usd` on a USD card, `cardSource`, `defaulted`, and
`ignored`. One fixture suite runs each case through both and requires the
same amount, currency, and `estimated`. It throws `RateCardError` instead
of returning a number it cannot stand behind. A zero usage lever the card
does not read is dropped. A non-zero one throws `unknown-usage-key`.

## Versions

The package's MAJOR.MINOR version is the version of the card language
it reads, `RATE_CARD_LANGUAGE`. A change to what a card can say bumps
it. A fix that reads the same cards is a patch.

| Language | Adds                                            |
| -------- | ----------------------------------------------- |
| `0.1`    | Core ops, `lookup`, input estimates. USD only.  |
| `0.2`    | The `{ currency: [code, expr] }` price wrapper. |

The package root adds the listing compilers and needs no dependencies.
`@modelschemas/rate-card/schema` exports `rateCardSchema` (zod). `zod` is
an optional peer dependency: install it to import that entry.

```ts
import {
  compileOpenRouterPricing,
  price,
  verifyExamples,
} from '@modelschemas/rate-card'
import { rateCardSchema } from '@modelschemas/rate-card/schema'

const card = rateCardSchema.parse(json)
if (verifyExamples(card).some((r) => !r.ok)) throw new Error('bad card')

// request-bound levers read the body; usage-bound levers read usage.
// The number is in cardCurrency(card): USD unless the card says otherwise.
const amount = price(
  card,
  { duration: 5, resolution: '720p' },
  { input_tokens: 1200, output_tokens: 300 },
)

// OpenRouter `pricing` → usage-bound token card (null when it prices nothing)
const tokenCard = compileOpenRouterPricing(model.pricing, {
  url: 'https://openrouter.ai/api/v1/models',
  hash, // sha256 of the priced text
  extractedAt: new Date().toISOString(),
})
```

A number input may carry an `estimate`: the source's published way to
derive it when the caller omits it (Seedance `completion_tokens` from
resolution × ratio × duration), with its own `inputs` and `source`.
`priceDetailed` returns `{ amount, currency, usd?, estimated, defaulted, ignored }`;
`estimated` lists the params that were filled that way, so an estimate is never mistaken for the billed
price. Supplying the real value skips the estimate and its inputs. `price`
never estimates: it throws `required` for the omitted input instead.

`defaulted` lists omitted params that took the card's `default` (an
omitted count input is an empty list). `ignored` lists request keys the
card does not read: request-bound cards get full request bodies, so extra
fields are normal there. A usage key the card does not read is not normal:
`priceDetailed` throws `unknown-usage-key`, because a dropped usage count
is a wrong price. `cardParams(card)` lists the request and usage keys a
card reads. `price` does not check keys.

## Native usage

`normalizeUsage(card, usage)` maps a provider's own usage object, as the
API returned it, to the card's usage levers:

```ts
const usage = normalizeUsage(card, response.usage) // OpenAI, Anthropic
const amount = priceDetailed(card, request, usage).amount
```

It reads OpenAI Responses and Chat Completions `usage`, Anthropic `usage`,
and Gemini `usageMetadata`. OpenAI `cached_tokens` and
`cache_write_tokens`, and Gemini `cachedContentTokenCount`, move out of
the prompt total into `cache_read_tokens` and `cache_write_tokens`,
because card levers do not overlap. Anthropic cache
counts become `cache_read_tokens`, `cache_write_tokens` and
`cache_write_1h_tokens`. Reasoning, audio, image and video counts move to
their own lever only when the card reads it. A usage object in card
levers passes through, except a zero lever the card does not read, which
is dropped. A payload that mixes native fields and card levers throws
`mixed-usage`. `usageFormat(card, usage)` names the
format it read.

## Currency

A card is in one currency. A USD card's `price` is a bare expression,
exactly as before cards had a currency. A card in any other currency
wraps it:

```json
{
  "price": {
    "currency": ["CNY", { "*": [{ "var": "input_tokens" }, 0.00002] }]
  }
}
```

The wrapper is the only place a card states its currency (ISO 4217). USD
is said only by having no wrapper: `["USD", …]` and a top-level
`currency` key are both refused, by the schema and by the evaluator on an
unparsed card (`unknown-op`).
`cardCurrency(card)` reads it, `cardPrice(card)` returns
`{ currency, expr }`, and `priceDetailed` names the currency beside
`amount`, setting `usd` (deprecated) only for a USD card.
`compileTokenCard(rates, tiers, source, { currency: 'CNY' })` compiles a
wrapped card; the amounts are the same with and without the wrapper.
Nothing converts: never add or compare amounts from cards in different
currencies.

`currency` is not a core op, on purpose. **0.1.0 cannot read a non-USD
card: `rateCardSchema` rejects it and `price()` throws `unknown-op`.**
That is the intended failure: an evaluator that knows no currencies
refuses a yuan price instead of returning it as dollars. 0.2.0 reads
these cards. USD cards are unchanged and read the same in every version.

Token counts on compiled OpenRouter cards are disjoint: `input_tokens`
excludes `cache_read_tokens` / `cache_write_tokens`, `output_tokens`
excludes `reasoning_tokens`. `min_prompt_tokens` overrides become rate
tiers (strictly greater than the threshold); time-window overrides are not
applied (the card quotes the base rate).

Docs: [modelschemas.com/docs](https://modelschemas.com/docs) · Source:
[github.com/TanStack/modelschemas](https://github.com/TanStack/modelschemas)
