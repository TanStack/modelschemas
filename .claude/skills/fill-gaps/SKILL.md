---
name: fill-gaps
description: One turn of the loop that fills the chat facts `@tanstack/ai-models` needs by fixing provider ingest. Use when asked to fill gaps, raise a provider's gap-report score, or run `/loop /fill-gaps`. Takes an optional comma-separated provider list.
---

# Fill gaps

Goal: every chat model in modelschemas has the facts `@tanstack/ai-models`
needs, read from the provider's own sources by its ingest. The gap report
(see the `gap-report` skill) is the only definition of done.

A gap is an ingest bug or a missing extractor. The fix is always code that
reads the provider's source on every sync. Never a hand-written value, never
a one-off backfill.

## Each turn

Before starting, check your own checkout has `.env.local` (`pnpm run
secrets:pull` creates it where Doppler is set up). Agents copy it: Doppler
is scoped to a directory, so `secrets:pull` fails in a new worktree.

1. Run `pnpm run gap:report`. If every provider with chat rows scores 1,
   stop the loop and report. Facts in `docs/source-silent/` are already
   left out of the score.
2. Pick up to three providers. Use the ones passed as arguments. With no
   arguments, take the lowest scores first. Skip a provider that:
   - has an open PR (`gh pr list --search "fill-gaps <provider>"`),
   - has `chat: 0` and `noActivity: 0` (it serves no chat models),
   - made no progress in its last two PRs. Report it as blocked.
3. For each provider, start one agent in its own worktree
   (`isolation: "worktree"`) with the filler brief below. Providers are
   independent, so run them in parallel.
4. For each PR that comes back, start a checker agent with the checker
   brief. The checker must not be the agent that wrote the PR.
5. Report: providers worked on, score before and after, PR links, new
   ledger entries, and anything that needs the user (an API key, a login, a
   provider with no public source).

Do not merge, deploy, or close issues. The user does that.

## Filler brief

Give the agent the provider id, its row from the gap report, a dev-server
port no other agent has (3101, 3102, 3103), the absolute path of your own
checkout (for its `.env.local`), and this:

- **Find the source.** For each missing fact, find where the provider
  publishes it: the model listing API, the docs, the pricing page, the
  request schema we already sync. Record the URL.
- **Fix ingest, in this order.** Stop at the first that works.
  1. The fact is already in a response we fetch (the listing, the spec).
     Map it in the provider's `listModels` or adapter under
     `src/server/providers/`.
  2. The fact is in a structured document: JSON, a `.md` twin of a docs
     page, a table with stable columns. Fetch and parse it. Follow the
     `*-pricing.ts` and `model-facts.ts` parsers: fail closed, and a page
     that parses nothing throws.
  3. The fact is in prose or in HTML that changes shape. Do not write a
     scraper. Extract it with a model, the way
     `src/server/ingest/extract-fal-pricing.ts` does: hash the source
     section and skip unchanged hashes, make one call per distinct hash,
     validate the output with a zod schema, allow one repair turn on the
     same model, and store nothing when validation fails. Try deterministic
     parsing of the common shapes first (`fal-unit-rate.ts`) and send only
     the leftovers to the model.
- **`chat: 0` with `noActivity > 0`** means the rows are unclassified. Fix
  the provider's `classify` or its listing-to-activity mapping first. The
  other facts are not counted until rows are `chat`.
- **Every filled fact carries its source** in `factSources`
  (`ModelFactSources` in `src/server/providers/types.ts`), with the URL.
- **Sources that are not allowed.** Never take a value from models.dev,
  OpenRouter, a gateway, or another provider's row. Use them only to see
  what a fact looks like and to spot disagreements.
- **Prices** are the standard tier, not batch, flex, or a promotion. A
  price is the billed price or it is absent. No estimates, no fallbacks.
- **Nothing published?** Leave the fact null and add a line to
  `docs/source-silent/<provider>.md`: `- <provider>: <fact> — <why>, <URL checked>,
  checked <date>`.
- **Do not change the DB schema or the API shape.** If a fact has no
  field, stop and say so.
- **Verify locally.** Other agents run at the same time, each in its own
  worktree, so do not use `pnpm run dev`: it binds port 3100. Use the port
  the orchestrator gave you. A new worktree has no `node_modules` and no
  `.env.local`.

  ```bash
  cp <orchestrator checkout>/.env.local .env.local
  pnpm install && pnpm run db:migrate && pnpm run seed
  pnpm exec vite dev --port <port> &
  curl -X POST localhost:<port>/v1/admin/sync/<provider> -H "X-Admin-Key: $ADMIN_KEY"
  curl "localhost:<port>/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*"   # model poll
  pnpm run gap:report -- --base http://localhost:<port> --check --providers <provider>
  ```

  Stop the dev server when done.

  Then `pnpm run test`, `pnpm run typecheck`, and `pnpm run lint`. Add a
  unit test with a fixture of the source for each new parser or extractor.

- **Open a PR** titled `fill-gaps <provider>: <facts>`. Put the provider's
  gap-report row before and after in the description. A provider that
  needs a key we do not have is a report item, not a PR.

## Checker brief

Give the agent the PR number, a free dev-server port, the absolute path of
your own checkout, and this:

- Check out the PR in your own worktree and run the local verify steps
  above on the port the orchestrator gave you.
- Pick 10 filled rows at random. Open each fact's source URL and confirm
  the stored value against the page. For a model-extracted fact, confirm
  the value is on the page, not only plausible.
- Confirm prices are the standard tier.
- List every row where modelschemas and models.dev disagree, and say
  which one the provider's source supports.
- Confirm no value came from models.dev, OpenRouter, or another provider,
  and that the diff holds no hand-written values.
- For each new ledger line, open the URL and confirm the fact is absent.
- Approve, or comment with the exact rows that are wrong.

## Running it

```text
/fill-gaps                    # one turn, worst scores first
/fill-gaps openai,gemini      # one turn, these providers
/loop /fill-gaps              # repeat until the report passes
```
