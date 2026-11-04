# modelschemas catalog data

A read-only mirror of the [modelschemas](https://github.com/TanStack/modelschemas)
catalog, refreshed hourly from `GET /v1/admin/export`. D1 behind
https://modelschemas.openstory.workers.dev stays the source of truth.

- `providers/<provider>.json`
- `models/<provider>/<modelId>.json`
- `schemas/<provider>/<endpointId>.json` (current input and output schema)
- `feed.json`: the newest `/v1/changes` row when the export began, and the
  recent ids already listed in a commit message

Each commit message lists the `/v1/changes` ids recorded since the last
commit. The export is not one snapshot, so a commit's files can already hold
a change the next commit lists. Fields that move on every poll (such as
`lastSeenAt`) are left out, so a commit is a real change.

A run refuses an export that would delete over half the files (rerun with
`MIRROR_ALLOW_SHRINK=1` if that is real), or whose latest change is gone or
older than the mirror's (delete `feed.json` to re-seed).

**Pull requests here are overwritten by the next run.** A wrong fact is an
adapter fix, not a data edit: open an issue on
[TanStack/modelschemas](https://github.com/TanStack/modelschemas/issues).
