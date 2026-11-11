# Changesets

A PR that changes a published package adds one: `pnpm exec changeset`. The five
packages share one version (`fixed`). Pick **patch** unless the release
changes what a rate card can say — MAJOR.MINOR must equal
`RATE_CARD_LANGUAGE` in `packages/rate-card/src/card.ts`, so a minor bump
goes with bumping that constant.
