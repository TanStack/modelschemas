import { Fragment, useState } from 'react'
import { Provenance } from '#/components/provenance.tsx'
import { recordedSources } from '#/lib/provenance.ts'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

import {
  JsonPane,
  MetaStrip,
  ReqLine,
  SiteFooter,
  SiteNav,
  ViewToggle,
} from '#/components/site.tsx'
import type { ResourceView } from '#/components/site.tsx'
import { activities } from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import type { ModelRow } from '#/lib/completeness.ts'
import type { SerializableModel } from '#/lib/json.ts'
import { timeAgo, shortDate } from '#/lib/time.ts'

/** Rows shown / serialized per page-load; refine with filters beyond this. */
const MAX_ROWS = 200

interface CatalogSearch {
  provider?: string
  activity?: Activity
  q?: string
}

/** Chat facts filled of those scored for one row; null for non-chat rows. */
interface RowCompleteness {
  filled: number
  needed: number
  missing: Array<string>
}

interface CatalogData {
  count: number
  /** By model id, for the rows shown. */
  completeness: Record<string, RowCompleteness>
  models: Array<SerializableModel>
  providers: Array<string>
  truncated: boolean
  /** Epoch seconds the server read the catalog; `timeAgo` measures from it. */
  renderedAt: number
}

const getCatalog = createServerFn({ method: 'GET' })
  .validator((filters: CatalogSearch) => filters)
  .handler(async ({ data }): Promise<CatalogData> => {
    const { env } = await import('cloudflare:workers')
    const { getDb } = await import('#/db/index.ts')
    const { listModelsCatalog, knownProviderIds } =
      await import('#/server/catalog.ts')
    const { FACT_KEYS, buildReport } = await import('#/lib/completeness.ts')
    const { sourceSilentLedger } = await import('#/server/source-silent.ts')
    const db = getDb(env, { replica: true })
    // The second read carries full rate cards: the score reads them, and the
    // page shows the compact rows the API serves.
    const [result, scored, providers] = await Promise.all([
      listModelsCatalog(db, data),
      listModelsCatalog(db, { ...data, pricing: true }),
      knownProviderIds(db),
    ])
    const completeness: Record<string, RowCompleteness> = {}
    for (const row of scored.models.slice(0, MAX_ROWS)) {
      if (row.activity !== 'chat') continue
      // Same scorer as the front page and `bun run gap:report`, one row at a time.
      const [report] = buildReport(
        [row as unknown as ModelRow],
        sourceSilentLedger,
      ).providers
      if (!report) continue
      const counted = FACT_KEYS.filter(
        (key) =>
          !report.silent.includes(key) &&
          report.facts[key].need - (report.modelSilent?.[key] ?? 0) > 0,
      )
      const missing = counted.filter((key) => report.facts[key].have === 0)
      completeness[row.id] = {
        filled: counted.length - missing.length,
        needed: counted.length,
        missing,
      }
    }
    return {
      count: result.count,
      completeness,
      // drizzle json columns are typed unknown; the values are plain JSON
      models: result.models.slice(
        0,
        MAX_ROWS,
      ) as unknown as Array<SerializableModel>,
      providers,
      truncated: result.count > MAX_ROWS,
      renderedAt: Math.floor(Date.now() / 1000),
    }
  })

export const Route = createFileRoute('/models/')({
  validateSearch: (search: Record<string, unknown>): CatalogSearch => ({
    provider:
      typeof search.provider === 'string' && search.provider !== ''
        ? search.provider
        : undefined,
    activity: (activities as ReadonlyArray<string>).includes(
      String(search.activity),
    )
      ? (search.activity as Activity)
      : undefined,
    q: typeof search.q === 'string' && search.q !== '' ? search.q : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getCatalog({ data: deps }),
  component: ModelsCatalog,
})

function queryString(search: CatalogSearch): string {
  const params = new URLSearchParams()
  if (search.provider) params.set('provider', search.provider)
  if (search.activity) params.set('activity', search.activity)
  if (search.q) params.set('q', search.q)
  const qs = params.toString()
  return qs === '' ? '' : `?${qs}`
}

function completenessCell(row: RowCompleteness | undefined): string {
  return row ? `${String(row.filled)}/${String(row.needed)}` : '—'
}

function completenessTitle(row: RowCompleteness | undefined): string {
  if (!row) return 'Scored for chat models only'
  return row.missing.length === 0
    ? 'Every scored fact is filled'
    : `Missing: ${row.missing.join(', ')}`
}

/** Model rawIds can contain slashes (FAL); those detail URLs use the slug id. */
export function modelHref(model: SerializableModel): string {
  const id = model.rawId.includes('/') ? model.id : model.rawId
  return `/models/${model.provider}/${id}`
}

function ModelsCatalog() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [view, setView] = useState<ResourceView>('readable')
  const [q, setQ] = useState(search.q ?? '')
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null)

  const qs = queryString(search)
  const apiPath = `/v1/models${qs}`
  const jsonBody = JSON.stringify(
    { count: data.count, models: data.models },
    null,
    2,
  )

  const setSearch = (patch: Partial<CatalogSearch>) => {
    void navigate({
      search: (prev: CatalogSearch): CatalogSearch => {
        const next = { ...prev, ...patch }
        return {
          provider: next.provider || undefined,
          activity: next.activity || undefined,
          q: next.q || undefined,
        }
      },
    })
  }

  const selectClasses =
    'hairline rounded-[3px] border bg-paper-raised px-2.5 py-1.5 font-mono text-xs text-ink outline-none transition-colors focus:border-rule-strong'

  return (
    <div className="min-h-screen text-ink">
      <SiteNav active="models" />
      <main className="mx-auto max-w-[1080px] px-6 pb-16">
        <ReqLine
          path={
            <>
              /v1/models
              {qs === '' ? null : <span className="text-ink-faint">{qs}</span>}
            </>
          }
          copyUrl={`https://modelschemas.com${apiPath}`}
          right={<ViewToggle view={view} onChange={setView} />}
        />
        <MetaStrip
          items={[
            ['count', String(data.count)],
            ['cache', '15m'],
            ['shown', data.truncated ? `first ${String(MAX_ROWS)}` : 'all'],
          ]}
        />

        {view === 'json' ? (
          <JsonPane
            title={`application/json · 200 OK${data.truncated ? ` · trimmed to ${String(MAX_ROWS)} models` : ''}`}
            json={jsonBody}
            note={
              <>
                identical body to{' '}
                <code>curl https://modelschemas.com{apiPath}</code>
                {data.truncated ? ' — the API returns the full list' : null}
              </>
            }
          />
        ) : (
          <>
            <div className="mb-3.5 flex flex-wrap items-center gap-2 font-mono text-xs">
              <select
                aria-label="Filter by provider"
                className={selectClasses}
                value={search.provider ?? ''}
                onChange={(event) => {
                  setSearch({ provider: event.target.value || undefined })
                }}
              >
                <option value="">provider=any</option>
                {data.providers.map((p) => (
                  <option key={p} value={p}>
                    provider={p}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filter by activity"
                className={selectClasses}
                value={search.activity ?? ''}
                onChange={(event) => {
                  setSearch({
                    activity: (event.target.value || undefined) as
                      | Activity
                      | undefined,
                  })
                }}
              >
                <option value="">activity=any</option>
                {activities.map((a) => (
                  <option key={a} value={a}>
                    activity={a}
                  </option>
                ))}
              </select>
              <form
                className="contents"
                onSubmit={(event) => {
                  event.preventDefault()
                  setSearch({ q: q || undefined })
                }}
              >
                <input
                  aria-label="Filter models by text"
                  className={`${selectClasses} w-52`}
                  placeholder="q=filter models…"
                  value={q}
                  onChange={(event) => setQ(event.target.value)}
                  onBlur={() => setSearch({ q: q || undefined })}
                />
              </form>
            </div>

            <div className="figure overflow-x-auto">
              <table className="dtable">
                <thead>
                  <tr>
                    <th>model id</th>
                    <th>display name</th>
                    <th className="max-sm:hidden">activity</th>
                    <th title="Has a price card">priced</th>
                    <th
                      className="num max-sm:hidden"
                      title="Chat completeness: chat facts filled of those scored for this model. Facts the provider does not publish are left out."
                    >
                      chat
                    </th>
                    <th className="num">first seen</th>
                    <th className="num">last seen</th>
                    <th aria-label="links" />
                  </tr>
                </thead>
                <tbody>
                  {data.models.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="text-ink-faint">
                        No models match these filters — clear a filter or
                        broaden <code>q</code>.
                      </td>
                    </tr>
                  ) : (
                    data.models.map((m) => {
                      const expanded = expandedModelId === m.id
                      const sourceId = `model-sources-${encodeURIComponent(m.id)}`
                      const sourceCount = new Set(
                        recordedSources(m.factSources).flatMap((source) =>
                          source.sourceUrl ? [source.sourceUrl] : [],
                        ),
                      ).size
                      return (
                        <Fragment key={m.id}>
                          <tr>
                            <td className="font-mono text-[12.5px]">
                              <a
                                className="font-medium text-ink hover:text-tok-blue"
                                href={modelHref(m)}
                              >
                                {m.rawId}
                              </a>
                            </td>
                            <td>{m.displayName ?? '—'}</td>
                            <td className="font-mono text-xs text-ink-soft max-sm:hidden">
                              {m.activity ?? '—'}
                            </td>
                            <td
                              className={
                                m.pricing === null
                                  ? 'text-ink-faint'
                                  : 'text-tok-green'
                              }
                              aria-label={
                                m.pricing === null ? 'not priced' : 'priced'
                              }
                            >
                              {m.pricing === null ? '✗' : '✓'}
                            </td>
                            <td
                              className="num text-ink-soft max-sm:hidden"
                              title={completenessTitle(data.completeness[m.id])}
                            >
                              {completenessCell(data.completeness[m.id])}
                            </td>
                            <td className="num text-ink-faint">
                              {shortDate(m.firstSeenAt)}
                            </td>
                            <td className="num text-ink-faint">
                              {timeAgo(m.lastSeenAt, data.renderedAt)}
                            </td>
                            <td className="font-mono text-xs">
                              <a className="press-link" href={modelHref(m)}>
                                detail →
                              </a>
                              <button
                                type="button"
                                className="press-link mt-1 block cursor-pointer"
                                aria-expanded={expanded}
                                aria-controls={sourceId}
                                aria-label={`Sources for ${m.rawId}`}
                                onClick={() =>
                                  setExpandedModelId(expanded ? null : m.id)
                                }
                              >
                                {expanded ? '▾' : '▸'} sources
                                {sourceCount ? ` (${sourceCount})` : ''}
                              </button>
                            </td>
                          </tr>
                          {expanded && (
                            <tr id={sourceId}>
                              <td colSpan={8}>
                                <div className="py-2">
                                  <p className="mb-3 font-mono text-xs text-ink-soft">
                                    Sources for {m.rawId}
                                  </p>
                                  <Provenance facts={m.factSources} />
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
            {data.truncated ? (
              <p className="mt-2.5 font-mono text-xs text-ink-faint">
                showing {MAX_ROWS} of {data.count} — narrow with the filters
                above, or fetch the full list from{' '}
                <a className="press-link" href={apiPath}>
                  {apiPath}
                </a>
              </p>
            ) : null}
          </>
        )}
      </main>
      <SiteFooter />
    </div>
  )
}
