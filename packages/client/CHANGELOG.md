# @modelschemas/client

## 0.2.4

### Patch Changes

- f0d8773: Cite the OpenCode Go console page that replaced `/docs/go/` in the generated client descriptions.

## 0.2.3

### Patch Changes

- 57f76fc: `GET /v1/openapi/{provider}` no longer caps a provider-grained document at 40 paths (#560). ElevenLabs is served again, and the whole `music-generation` tag is classified.
- 64fba2b: `GET /v1/openapi/fal` with no selector is one queue document: `POST /{endpoint_id}` and `GET /{endpoint_id}/requests/{request_id}`, with every live model in the `endpoint_id` enum and untyped bodies. `?activity=` narrows the enum and inlines each model's own body schema. Adds `GET /v1/providers/{provider}`: one provider's status, counts, and live model counts per activity.

## 0.2.2

### Patch Changes

- efd04aa: The OpenAPI `RateCard` schemas are now written from the rate-card zod schema (named `RateCard`, `RateCardInput`, `RateCardExpr`, `RateCardTable`, `RateCardPrice`, …), so the client's generated `RateCard` has typed `price` and `tables` and `getModel`'s `pricing` goes to `evaluateCard` after `'price' in pricing`, with no cast. The generated `RateCardInput` is now a union by `kind`, and `RateCardSource`/`RateCardExample` gain descriptions. `rateCardSchema` carries `.meta` ids; validation is unchanged.

  `CompactPricing`, `PricingRange`, `ModelReasoning` and `ChatRequestMap` are written from the same zod schemas the server builds them with. `ChatRequestMap.thinking.off` is now typed as an object or null (it was `unknown`); `ModelReasoning` and `PriceBounds` are named types. No served value changes, but the spec now closes these components and the rest of the RateCard family to extra fields (`additionalProperties: false`), as zod writes it for an output schema; a validator built from the spec rejects a field the server adds later.

- 653ed60: `Model` gains `requiredRequestHeaders` and `trainsOnRequestData`, and `FactSource` gains `verifiedAt` for a probe-verified fact. `GET /v1/status` gains `staleProbes`.
- 667b1d7: OpenCode Go required headers are the client-supplied half of the provider connect profile. `trainsOnRequestData` is true when that model's Go privacy row says Yes.
- 1780348: Format the generated client with oxfmt. No API change.
- 0dbb5aa: Vercel rows whose price varies by route store a `pricingRange` (#451).
  Each route is a Vercel `provider_name` with its compiled card inline, not
  a catalog row. `estimateCost` prices those inline cards and names min and
  max by provider. Endpoints with `status` other than 0 are omitted and
  named on `factSources.pricingRange`. Model row shape is v4.

## 0.2.1

### Patch Changes

- 589f284: Publish built JavaScript. Each package ships `dist/*.js` and `dist/*.d.ts`.
  `exports` and `main` point at `dist/`, and the CLI bin is the built file
  with a Node shebang. Plain Node can import the libraries and run
  `modelschemas --help` with no TypeScript loader.
- bcbe8d0: Estimate one price per value of a missing choice input (#450).
  `estimateCost` now returns
  `EstimateResult | EstimateRangeResult | EstimateByInputResult`: when the
  call omits exactly one required enum or boolean input with no default
  (BytePlus `pricing_period`), `{ currency, byInput: { input, values } }`
  holds one result per allowed value. `RateCardError` gains `input`, the
  card input the caller did not supply, on `bad-input` "required" and
  `estimate-unavailable`.
- 3153d38: `Model` gains `deprecation` (the provider's deprecations page entry: `deprecatedAt`, `retiresAt`, `replacedBy`, `sourceUrl`), and the change feed gains `model.deprecated`.
- bb2ae17: Type the model row. `listModels`, `listProviderModels`, `getModel` and the
  admin export now return typed rows (`Model`, `ModelList`,
  `ProviderModelList`, `ModelDetail`, `ExportModel`) instead of
  `{ [key: string]: unknown }`: every field is required except `factSources`
  (omitted with `provenance=0`), with `modalities`, `factSources`, `_links`
  and detail `discrepancies` spelled out. Adds the `catalog.shape_changed`
  change type: the feed announces each new row shape version.
- b530d22: Regenerate with `@hey-api/openapi-ts` 0.99.0. SDK functions now declare their return types (`RequestResult<…>`). The generated default `client` defaults to `baseUrl: '/'`; `createModelschemasClient({ baseUrl })` is unchanged.
- 589f284: **Breaking:** `rateCardSchema` moved from the `@modelschemas/rate-card`
  root to `@modelschemas/rate-card/schema`. The root no longer needs `zod`;
  install it only to import `./schema`.

  **Breaking:** the CLI, codegen, and vite declare `engines.node >= 22.18.0`.
  The CLI needs `import.meta.main`; on Node 20 it exited without running.

  client, codegen, and vite are `sideEffects: false`, and every package
  exports `./package.json`.

- 7210a10: Price ranges for routed model ids (#406). Model rows gain `pricingRange`
  (`PricingRange | null`) and `factSources.pricingRange`: a routed id whose
  routes bill different prices has `pricing: null` and a min/max per million
  over its routes' published cards, each route named by its own row. It is a
  bound, never the billed price. `estimateCost` now returns
  `EstimateResult | EstimateRangeResult`: on such a row,
  `{ currency, min, max, routes }`, with `min` and `max` naming their route.
