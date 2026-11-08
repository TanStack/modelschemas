# Native reasoning and replay evidence (#269 / #270)

Checked 2026-10-09. Captured provider-owned fixtures are regression inputs only;
production fetches these sources during sync. No models.dev source or static model
registry is introduced. Source failures throw in the new source loaders, and no
provider-wide source-silent exemptions are added.

## OpenRouter

https://openrouter.ai/api/v1/models

The requested Seed 2.1 Turbo and Laguna S 2.1 examples already publish the
`reasoning` supported parameter, but publish no effort/budget mode. Their native
reasoning metadata is only a mandatory flag. Preserve their capability independent
of whether a valid reasoning configuration can be constructed. A reasoning
metadata object also contributes this capability; it never fabricates a mode.
Replay is not inferred from upstream models or output fields. OpenRouter's own
reasoning-details instructions use a different preserved structure, so this patch
does not stamp reasoning_content replay on its rows.

## OpenAI

- https://developers.openai.com/api/docs/models/gpt-6.1-sol.md — multiline list
  including max; the following sentence rejects none/minimal.
- https://developers.openai.com/api/docs/models/gpt-5.2-codex.md — supported effort
  list precedes the words reasoning effort settings.
- https://developers.openai.com/api/docs/models/gpt-oss-120b.md — parenthesized
  configurable reasoning effort list.
- https://developers.openai.com/api/docs/models/gpt-6-luna.md — explicit none
  support makes reasoning optional.
- https://developers.openai.com/api/docs/models/gpt-5-pro.md — "defaults to (and
  only supports) `reasoning.effort: high`": the one accepted level is not off, so
  mandatory is true.
- https://developers.openai.com/api/docs/guides/latest-model/gpt-5.md — the GPT-5
  family ids and their effort list, for gpt-5-mini and gpt-5-nano, whose pages
  state no levels.
- https://developers.openai.com/api/docs/guides/latest-model/gpt-5.1.md — `none` is
  new in GPT-5.1, and GPT-5's `minimal` still uses reasoning tokens. With the
  family list above (lowest level `minimal`, no `none`), this states the family
  cannot turn reasoning off: mandatory is true.
- https://developers.openai.com/api/docs/guides/latest-model/gpt-5.2.md — requests
  to the named older GPT-5 ids that carry `temperature` or `top_p` raise an error:
  both flags are `false` on those rows.

A family-guide or sampling-guide failure is a `tryDocs` failure. The ids that
guide names — or, when the family sentence did not parse, `gpt-5`, `gpt-5-mini`,
and `gpt-5-nano` — keep their stored reasoning or capabilities (`unavailable`).
A GPT-5.1 failure leaves the family effort list in place with `mandatory` null.
Other GPT-5 rows, including `gpt-5-pro`, keep the facts their own pages stated.

Parse only normative prose; fenced examples do not establish effort allowlists.
Individual model-page fetch and parse failures now error instead of returning
unknown facts. A model's own page takes precedence over another alias page's
snapshot reference. Realtime pages explicitly declaring configurable reasoning
effort retain effort mode with unknown levels and mandatory status.
A level list without `none` does not by itself prove mandatory thinking.
`mandatory` is true when the page says the model only supports one level other
than `none`, when cannot-disable or always-on prose says so, or when the GPT-5
family list has no `none` and the GPT-5.1 guide says that list's first level
still spends reasoning tokens. Otherwise it stays null. Reasoning-token
capability without a control declaration does not justify an invented effort
mode or mandatory=true. Such configurations remain null while capability
remains independently sourced. Pages that do not name effort levels are not
covered by a blanket effort exemption.

## Gemini

- https://aistudio.google.com/docs/models/gemini-3.8-flash.md — native
  Thinking Supported cell explicitly lists low, medium, high. Minimal is rejected.
- https://aistudio.google.com/docs/thinking.md?generate-content=true — scoped
  family controls and budget/effort values.
- https://aistudio.google.com/docs/models.md — native model/document index
  and explanation that latest aliases are hot-swapped.
- https://aistudio.google.com/docs/live-api/capabilities.md — the Model
  comparison table's Thinking row: the one column that "Uses `thinkingBudget`"
  is the native audio model its name links. Mandatory is unstated.

These pages are Markdoc since #568; `markdocTables` reads their tables.

A native model-page capability or explicit level declaration does not depend on
the Models API including its optional thinking flag. An explicit API
thinking=false is preserved and suppresses docs-derived controls/capability;
absence and false remain distinct. Version identities already
parsed from native pages are retained; no numeric/latest alias heuristic is added.
The public index and current linked version tables do not bind gemini-flash-latest
to a specific current family, and do not list gemma-4-31b-it. Their controls remain
unknown without a native binding. Read-only Models.get using an already configured
key confirms both models explicitly return thinking=true, so their capability is
already sourced by the listing adapter. Neither native record supplies a
baseModelId/alias target or effort controls. No page absence is treated as retirement.

- https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest
- https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it

These metadata requests used authentication headers, with no credential in the
source URL, fixture or output; they make no inference calls.

## Mistral

https://docs.mistral.ai/studio/conversations/reasoning.md

The guide scopes adjustable reasoning to named model IDs, followed by a normative
parameter-value section describing high and none. These values apply to that
scope, while its explicit zai-glm-5-3 low/high/max list overrides them. Code
assignments alone do not establish the values. The existing adapter retains native
API alias relationships when copying these facts; no sibling relationships are
invented. Models outside the guide's scope do not inherit its controls. Fenced
examples cannot expand the normative values. The GLM always-thinking note
explicitly establishes mandatory=true; a value list alone leaves it null.

## Dashscope

https://www.alibabacloud.com/help/en/model-studio/deep-thinking.md

The Supported Models section explicitly names qwen3.7-max, qwen3.5-flash and their
published snapshots as hybrid thinking, and qwq-plus as thinking-only. The parser
uses this section, excluding samples and linked URL paths. Hybrid rows get a
sourced toggle mode; thinking-only rows get capability without inventing a control
mode. The source says control parameters vary by model, so the adapter does not
stamp a generic enable_thinking body on every row.

The Pass Thinking Process section lists preserve_thinking-supported IDs and says
the client supplies prior assistant reasoning_content. Replay=true is scoped to
those explicitly named IDs with a compatible request map. This is preserved
thinking support: the source explicitly says omitted reasoning_content does not
cause an error. No unconditional second-turn failure is asserted. Models absent
from this scope remain unknown. The shared compatibility parameter table is not a
complete model capability allowlist; omission must not manufacture false flags.

## Together

- https://docs.together.ai/docs/inference/chat/reasoning.md — preserved thinking
  example and instruction to include unmodified reasoning_content for GLM-5.2.
- https://docs.together.ai/docs/glm-5.3-quickstart.md — both native GLM variants are
  explicitly described as reasoning models; preserved thinking examples identify
  only GLM-5.3. Enable preserved thinking with clear_thinking=false and return
  reasoning_content unchanged. Flash does not inherit this replay claim.
- https://docs.together.ai/docs/deepseek-v4-quickstart.md — own model ID is
  deepseek-ai/DeepSeek-V4-Pro-0813. During multi-turn function calling the host
  explicitly requires content, reasoning_content and tool_calls on the next
  request, even when the response exposes the reasoning alias. Plain turns do not
  carry prior CoT into context. Scope replay to the native page's model ID.
- https://docs.together.ai/llms.txt — current native quickstart discovery index.

A reasoning capability does not require a parsed control mode. For newly sourced
rows, unknown wire controls remain null instead of invoking generic shared
thinking/reasoning_effort defaults. The current native docs do not provide a
corresponding DeepSeek V4.1 Flash quickstart, so this sibling remains unknown.
Preserved-thinking and tool-call conditions remain documented; this patch does not
claim every issue example is now filled or source-silent.

Replay additions preserve whole-request-map provenance and add only field-specific
requestMapFields.replayReasoningContent evidence. Existing populated request fields
and boolean capability-map positives/negatives are retained. Contradictory explicit
reasoning/replay rejections throw rather than being overwritten. OpenRouter
malformed metadata/parameter lists and missing or empty catalogs also throw.
