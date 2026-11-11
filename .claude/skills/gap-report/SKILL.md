---
name: gap-report
description: Run the modelschemas gap report and say which chat facts `@tanstack/ai-models` still lacks per provider. Use when asked for the gap report, what a provider is missing, whether a provider is done, or which provider to fill next.
---

# Gap report

`pnpm run gap:report` scores each provider on the chat facts
`@tanstack/ai-models` needs. It makes one `GET /v1/models` request and
changes nothing.

## Run it

```bash
pnpm run gap:report -- --table                         # every provider, worst first
pnpm run gap:report                                      # JSON, for reading with jq
pnpm run gap:report -- --base http://localhost:3100      # a local dev server
pnpm run gap:report -- --check --providers grok,mistral  # exit 1 if either is below 1
pnpm run gap:report -- --check --providers grok --target 0.9
```

The default base is production (`https://modelschemas.com`). Use `--base`
with the local server to check work that is not deployed yet.

One provider's gaps, as `fact: have/need`:

```bash
pnpm run gap:report | jq '.providers[] | select(.provider == "grok")
  | .silent as $s | {score, silent, gaps: (.facts | with_entries(
      select(.value.have < .value.need and (.key | IN($s[]) | not))))}'
```

## Read it

- `score` is filled facts over needed facts, from 0 to 1, over chat rows only.
- A provider with rows and `chat: 0` scores 0. Its gap is the missing
  `activity`, shown by `noActivity`, not the facts.
- `reasoning` and `efforts` have a smaller `need` than `chat`: they count
  only the rows that claim reasoning, or that use an effort or adaptive mode.
- A fact under `silent` is one the provider does not publish. It is left out
  of the score. The ledger is `docs/source-silent/`, one file per provider.
- `fromModelsDev` rows have a price sourced from models.dev. They do not
  count as `priced` or `cacheRead`.

## Report it

Lead with the score and the facts below `need`, as `have/need`. Name the
silent facts apart from the gaps. Say which base URL the numbers came from.

## Fill a gap

The report only measures. When filling what it finds:

- Take each fact from the provider's own listing, docs, or spec. Never copy
  it from OpenRouter or any other catalog.
- If no native source states the fact, add a line to
  `docs/source-silent/<provider>.md` with the reason and the issue number. Do not
  invent a value.
- The provider is done when `--check --providers <id>` exits 0 against a
  base that serves the new data.

## Compare with models.dev (compare-only)

`pnpm run compare:models-dev` answers "do we have as much as models.dev for
the chat models we support?". It reads models.dev only to compare: models.dev
is never a source (#197), so nothing it shows may be copied into the DB, an
adapter, a fixture or the ledger. Fill a gap it finds from the provider's own
source, or ledger it.

```bash
pnpm run compare:models-dev                              # per-provider table, most behind first
pnpm run compare:models-dev -- --provider grok              # models where we are behind or disagree
pnpm run compare:models-dev -- --json                       # everything, per model
pnpm run compare:models-dev -- --ours a.json --theirs b.json  # saved inputs, no requests
pnpm run compare:models-dev -- --check --min 0.9            # exit 1 below 90% parity
```

- A fact cell is `behind/they have`: matched pairs where only models.dev has
  a value. `*` marks a fact on our source-silent ledger.
- `noMatch` is our chat rows with no models.dev model; `theyOnly` is their
  chat-like models we do not list. Ids match exactly, by our stored alias, or
  by case and dots-vs-hyphens. Siblings and dated variants never match.
- models.dev is not ground truth. "Behind" means a value exists there, not
  that it is correct; check a disagreement against the provider's own page.
- A capability flag missing from a row's list is `false` only when some
  chat row of that provider lists the flag. Otherwise it is unknown, and we
  are behind.
- A models.dev rate of zero counts as a value. The footer says how many
  there are and gives the headline without them.
