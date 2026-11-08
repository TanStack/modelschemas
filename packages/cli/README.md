# modelschemas (CLI)

CLI for [modelschemas](https://modelschemas.com) — live per-endpoint
request/response JSON Schemas and model metadata for AI providers
(OpenAI, Anthropic, Gemini, xAI Grok, ElevenLabs, OpenRouter, FAL).

> The published bin is built JavaScript and runs on Node. No TypeScript loader.

```bash
bunx modelschemas models list --activity chat
bunx modelschemas schema get anthropic v1/messages --kind input
bunx modelschemas validate anthropic/v1/messages payload.json
```

```
login [--name <n>] [--delegated] [--api-key]   register this machine
whoami                                         show identity, grants, usage
models list|get                                model catalog
schema get <provider> <endpointId>             one self-contained JSON Schema
validate <provider/endpointId> <file>          validate a payload (exit 2 = invalid)
estimate <provider> <model> [body.json]        evaluate the stored rate card
                                               ({request?,usage?} or usage object)
changes [--since <epoch>]                      changelog feed
subscribe <url>                                webhook subscription
pull <selection...>                            generate schema/type modules
update                                         refresh pulled modules
verify                                         re-hash pulls against pinned content
                                               addresses + provenance
```

`--json` everywhere (default when piped), so the CLI is agent-friendly.
Output of `pull` is committed; `verify` proves the service still serves
bytes matching each pinned content hash.

Docs: [modelschemas.com/docs](https://modelschemas.com/docs) · Source:
[github.com/TanStack/modelschemas](https://github.com/TanStack/modelschemas)
