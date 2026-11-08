# @modelschemas/rate-card

## 0.2.4

No changes in this release.

## 0.2.3

No changes in this release.

## 0.2.2

### Patch Changes

- efd04aa: The OpenAPI `RateCard` schemas are now written from the rate-card zod schema (named `RateCard`, `RateCardInput`, `RateCardExpr`, `RateCardTable`, `RateCardPrice`, …), so the client's generated `RateCard` has typed `price` and `tables` and `getModel`'s `pricing` goes to `evaluateCard` after `'price' in pricing`, with no cast. The generated `RateCardInput` is now a union by `kind`, and `RateCardSource`/`RateCardExample` gain descriptions. `rateCardSchema` carries `.meta` ids; validation is unchanged.

  `CompactPricing`, `PricingRange`, `ModelReasoning` and `ChatRequestMap` are written from the same zod schemas the server builds them with. `ChatRequestMap.thinking.off` is now typed as an object or null (it was `unknown`); `ModelReasoning` and `PriceBounds` are named types. No served value changes, but the spec now closes these components and the rest of the RateCard family to extra fields (`additionalProperties: false`), as zod writes it for an output schema; a validator built from the spec rejects a field the server adds later.

- 1780348: Format the generated client with oxfmt. No API change.
- a8dcd8b: `evaluateCard` drops a zero usage lever the card does not read (#495).
  A non-zero lever the card does not read still throws `unknown-usage-key`.
  `POST /v1/estimate` does the same, because it shares `normalizeUsage`.

## 0.2.1

### Patch Changes

- bcbe8d0: Estimate one price per value of a missing choice input (#450).
  `estimateCost` now returns
  `EstimateResult | EstimateRangeResult | EstimateByInputResult`: when the
  call omits exactly one required enum or boolean input with no default
  (BytePlus `pricing_period`), `{ currency, byInput: { input, values } }`
  holds one result per allowed value. `RateCardError` gains `input`, the
  card input the caller did not supply, on `bad-input` "required" and
  `estimate-unavailable`.
- 589f284: **Breaking:** `rateCardSchema` moved from the `@modelschemas/rate-card`
  root to `@modelschemas/rate-card/schema`. The root no longer needs `zod`;
  install it only to import `./schema`.

  **Breaking:** the CLI, codegen, and vite declare `engines.node >= 22.18.0`.
  The CLI needs `import.meta.main`; on Node 20 it exited without running.

  client, codegen, and vite are `sideEffects: false`, and every package
  exports `./package.json`.
