# Providers to add — credential checklist

Working list against Vercel AI SDK first-party providers
([ai-sdk.dev/providers/ai-sdk-providers](https://ai-sdk.dev/providers/ai-sdk-providers)),
plus a few we added that they treat as community. Core 8 + the easy adapter
batch are shipped; remaining rows are the AI SDK vendors we still lack.

**Two things need auth, separately:**

- **Schemas** (`fetchSpec`) — keyless whenever the provider publishes a public
  spec URL. This is the core product.
- **Model list** (`listModels`) — needs the key below. Missing key → schemas
  still sync, model list is skipped. So a provider can ship schema-only first,
  key added later.

Set each secret in Doppler under the name in the **Secret** column (must match
`ProviderSecrets` in `src/server/providers/types.ts`). Console URLs are
best-known — confirm on signup.

## Already shipped — core

- [x] OpenAI
- [x] Anthropic
- [x] Gemini
- [x] Grok
- [x] ElevenLabs
- [x] OpenRouter
- [x] FAL
- [x] BytePlus (AI SDK names this **ByteDance** — same ModelArk host / `ARK_API_KEY`)

## Simple API key (bearer) — the easy batch

| Done | Secret                | Provider                   | Activity                             | Get it at                                                                               |
| ---- | --------------------- | -------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------- |
| [x]  | `MISTRAL_API_KEY`     | Mistral                    | chat · embed · moderation · audio    | [console.mistral.ai](https://console.mistral.ai)                                        |
| [x]  | `REPLICATE_API_TOKEN` | Replicate                  | chat · image · video · audio         | [replicate.com/account/api-tokens](https://replicate.com/account/api-tokens)            |
| [x]  | `GROQ_API_KEY`        | Groq                       | chat · audio                         | [console.groq.com/keys](https://console.groq.com/keys)                                  |
| [x]  | `FIREWORKS_API_KEY`   | Fireworks AI               | chat                                 | [fireworks.ai → API keys](https://fireworks.ai)                                         |
| [x]  | `TOGETHER_API_KEY`    | Together AI                | chat                                 | [api.together.ai → settings](https://api.together.ai/settings)                          |
| [x]  | `VOYAGE_API_KEY`      | Voyage AI                  | embed                                | [dashboard.voyageai.com](https://dashboard.voyageai.com)                                |
| [x]  | `COHERE_API_KEY`      | Cohere                     | chat · embed                         | [dashboard.cohere.com/api-keys](https://dashboard.cohere.com/api-keys)                  |
| [x]  | `DEEPSEEK_API_KEY`    | DeepSeek                   | chat                                 | [platform.deepseek.com](https://platform.deepseek.com)                                  |
| [x]  | `MOONSHOT_API_KEY`    | Moonshot (Kimi)            | chat                                 | [platform.moonshot.cn → API keys](https://platform.moonshot.cn)                         |
| [x]  | `DASHSCOPE_API_KEY`   | Alibaba Cloud Model Studio | chat · embed · image · audio · video | [Model Studio → API key](https://www.alibabacloud.com/help/en/model-studio/get-api-key) |
| [x]  | `DEEPGRAM_API_KEY`    | Deepgram                   | audio                                | [console.deepgram.com](https://console.deepgram.com)                                    |
| [x]  | `ASSEMBLYAI_API_KEY`  | AssemblyAI                 | audio                                | [assemblyai.com → dashboard](https://www.assemblyai.com/app)                            |
| [x]  | `RUNWAY_API_KEY`      | Runway                     | video · image                        | [dev.runwayml.com](https://dev.runwayml.com)                                            |
| [x]  | `CARTESIA_API_KEY`    | Cartesia                   | audio                                | [play.cartesia.ai → API keys](https://play.cartesia.ai)                                 |
| [x]  | `PERPLEXITY_API_KEY`  | Perplexity                 | chat                                 | [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api)                    |
| [x]  | `CEREBRAS_API_KEY`    | Cerebras                   | chat                                 | [cloud.cerebras.ai](https://cloud.cerebras.ai)                                          |
| [x]  | `SAMBANOVA_API_KEY`   | SambaNova                  | chat                                 | [cloud.sambanova.ai](https://cloud.sambanova.ai)                                        |
| [x]  | `JINA_API_KEY`        | Jina AI                    | embed                                | [jina.ai → API](https://jina.ai)                                                        |
| [x]  | `STABILITY_API_KEY`   | Stability AI               | image                                | [platform.stability.ai/account/keys](https://platform.stability.ai/account/keys)        |
| [x]  | `BFL_API_KEY`         | Black Forest Labs          | image                                | [api.bfl.ai (FLUX)](https://api.bfl.ai)                                                 |
| [x]  | `KLING_API_KEY`       | Kling AI                   | video · image                        | [app.klingai.com → dev console](https://app.klingai.com)                                |
| [x]  | `HYPERBOLIC_API_KEY`  | Hyperbolic                 | chat                                 | [app.hyperbolic.xyz](https://app.hyperbolic.xyz)                                        |
| [x]  | `NOVITA_API_KEY`      | Novita AI                  | chat · image                         | [novita.ai → key management](https://novita.ai)                                         |
| [x]  | `REACTOR_API_KEY`     | Reactor                    | video                                | [reactor.inc/dashboard](https://reactor.inc/dashboard)                                  |
| [x]  | `WORLDLABS_API_KEY`   | World Labs                 | world                                | [platform.worldlabs.ai](https://platform.worldlabs.ai)                                  |

### Next — AI SDK first-party we don't have

Highest-value unique vendors first; inference hosts last (another
OpenAI-compatible catalog, not a new API surface).

| Done | Secret                | Provider     | Activity      | Get it at                                                                                                 |
| ---- | --------------------- | ------------ | ------------- | --------------------------------------------------------------------------------------------------------- |
| [ ]  | `MINIMAX_API_KEY`     | MiniMax      | chat · video  | [platform.minimax.io → API keys](https://platform.minimax.io/user-center/basic-information/interface-key) |
| [ ]  | `LUMA_API_KEY`        | Luma         | image · video | [platform.lumalabs.ai](https://platform.lumalabs.ai)                                                      |
| [ ]  | `GLADIA_API_KEY`      | Gladia       | audio         | [app.gladia.io/apikeys](https://app.gladia.io/apikeys)                                                    |
| [ ]  | `LMNT_API_KEY`        | LMNT         | audio         | [docs.lmnt.com](https://docs.lmnt.com)                                                                    |
| [ ]  | `HUME_API_KEY`        | Hume         | audio         | [app.hume.ai/keys](https://app.hume.ai/keys)                                                              |
| [ ]  | `FISH_AUDIO_API_KEY`  | Fish Audio   | audio         | [fish.audio/app/api-keys](https://fish.audio/app/api-keys/)                                               |
| [ ]  | `REVAI_API_KEY`       | Rev.ai       | audio         | [rev.ai/access-token](https://www.rev.ai/access-token)                                                    |
| [ ]  | `PRODIA_API_KEY`      | Prodia       | image · video | [app.prodia.com/api](https://app.prodia.com/api)                                                          |
| [ ]  | `QUIVERAI_API_KEY`    | QuiverAI     | image         | [app.quiver.ai/settings/api-keys](https://app.quiver.ai/settings/api-keys)                                |
| [ ]  | `DEEPINFRA_API_KEY`   | DeepInfra    | chat · image  | [deepinfra.com/dash/api_keys](https://deepinfra.com/dash/api_keys)                                        |
| [ ]  | `BASETEN_API_KEY`     | Baseten      | chat          | [app.baseten.co/settings/api_keys](https://app.baseten.co/settings/api_keys)                              |
| [ ]  | `HUGGINGFACE_API_KEY` | Hugging Face | chat          | [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)                                  |
| [ ]  | `GMI_API_KEY`         | GMI Cloud    | chat          | [console.gmicloud.ai](https://console.gmicloud.ai)                                                        |

## Special auth — higher effort, do these later

(BytePlus graduated off this list 2026-08: the HMAC signature auth only guards
its control plane — the Ark data plane takes a plain bearer `ARK_API_KEY`, and
since there's no public spec and the data-plane `GET /models` is documented
non-exhaustive, the provider ships keyless with the spec + model catalog
embedded, ported from `@tanstack/ai-byteplus`.)

These wrap APIs we already catalog. They matter for Azure / Vertex / Bedrock
_request_ schemas, not for the models themselves.

| Done | Secret(s)                                               | Provider               | Why it's harder                                                              |
| ---- | ------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| [x]  | `ARK_API_KEY` (optional; upgrades the embedded catalog) | BytePlus / ByteDance   | Graduated — see note above.                                                  |
| [x]  | none (model cards + SDK service model are public)       | AWS Bedrock            | Keyless: docs model cards list ids; Converse is generated from botocore.     |
| [ ]  | service-account JSON                                    | Google Vertex AI       | OAuth service account, per-project routing.                                  |
| [ ]  | `AZURE_OPENAI_API_KEY` + endpoint                       | Azure OpenAI           | Key + resource endpoint + `api-version`; deployment-name routing.            |
| [ ]  | AWS creds + Anthropic-on-AWS host                       | Claude Platform on AWS | Anthropic models on AWS; same catalog as `anthropic`, different auth / host. |

## Not a vendor — skip

AI SDK lists these as first-party providers; they are not origin catalogs.

- **Vercel AI Gateway** — router over other providers.
- **Open Responses** — protocol adapter for OpenAI Responses-compatible endpoints (e.g. LM Studio).

## Keyless — no credential needed

Aggregators/specs that fetch without auth (like OpenRouter today): confirm each
provider's spec URL and `/models` endpoint are public before assuming. Portkey,
LiteLLM, and other gateways still need their own key if we poll their catalogs.
