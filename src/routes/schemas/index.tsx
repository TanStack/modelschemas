import { useMemo, useState } from 'react'
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
import type { ProviderSchemaGroup } from '#/server/schemas-api.ts'

/** Rows shown per page-load; refine with filters beyond this. */
const MAX_ROWS = 300

interface SchemaIndexSearch {
  provider?: string
  activity?: Activity
  q?: string
}

interface SchemaIndexData {
  count: number
  providers: Array<ProviderSchemaGroup>
}

const getSchemaIndex = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SchemaIndexData> => {
    const { env } = await import('cloudflare:workers')
    const { getDb } = await import('#/db/index.ts')
    const { getSystemSchemaIndex } = await import('#/server/schemas-api.ts')
    const index = await getSystemSchemaIndex(getDb(env, { replica: true }))
    return { count: index.count, providers: index.providers }
  },
)

export const Route = createFileRoute('/schemas/')({
  validateSearch: (search: Record<string, unknown>): SchemaIndexSearch => ({
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
  loader: () => getSchemaIndex(),
  component: SchemaIndex,
})

interface EndpointRow {
  provider: string
  activity: Activity
  endpointId: string
}

function flatten(providers: Array<ProviderSchemaGroup>): Array<EndpointRow> {
  const rows: Array<EndpointRow> = []
  for (const group of providers) {
    for (const [activity, ids] of Object.entries(group.activities)) {
      for (const endpointId of ids) {
        rows.push({
          provider: group.provider,
          activity: activity as Activity,
          endpointId,
        })
      }
    }
  }
  return rows
}

function endpointPath(endpointId: string): string {
  return endpointId.split('/').map(encodeURIComponent).join('/')
}

function schemaHref(row: EndpointRow, kind?: 'output'): string {
  const base = `/schemas/${row.provider}/${row.activity}/${endpointPath(row.endpointId)}`
  return kind === 'output' ? `${base}?kind=output` : base
}

function SchemaIndex() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [view, setView] = useState<ResourceView>('readable')
  const [q, setQ] = useState(search.q ?? '')

  const allRows = useMemo(() => flatten(data.providers), [data.providers])
  const filtered = useMemo(() => {
    const needle = search.q?.toLowerCase()
    return allRows.filter(
      (row) =>
        (!search.provider || row.provider === search.provider) &&
        (!search.activity || row.activity === search.activity) &&
        (needle === undefined || row.endpointId.toLowerCase().includes(needle)),
    )
  }, [allRows, search.provider, search.activity, search.q])
  const shown = filtered.slice(0, MAX_ROWS)
  const truncated = filtered.length > MAX_ROWS

  const jsonBody = useMemo(
    () =>
      JSON.stringify({ count: data.count, providers: data.providers }, null, 2),
    [data],
  )

  const setSearch = (patch: Partial<SchemaIndexSearch>) => {
    void navigate({
      search: (prev: SchemaIndexSearch): SchemaIndexSearch => {
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
      <SiteNav active="schemas" />
      <main className="mx-auto max-w-[1080px] px-6 pb-16">
        <ReqLine
          path="/v1/schemas"
          copyUrl="https://modelschemas.com/v1/schemas"
          right={<ViewToggle view={view} onChange={setView} />}
        />
        <MetaStrip
          items={[
            ['schemas', String(data.count)],
            ['providers', String(data.providers.length)],
            ['cache', '15m'],
          ]}
        />

        {view === 'json' ? (
          <JsonPane
            title="application/json · 200 OK"
            json={jsonBody}
            note={
              <>
                identical body to{' '}
                <code>curl https://modelschemas.com/v1/schemas</code>
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
                  <option key={p.provider} value={p.provider}>
                    provider={p.provider}
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
                  aria-label="Filter endpoints by text"
                  className={`${selectClasses} w-52`}
                  placeholder="q=filter endpoints…"
                  value={q}
                  onChange={(event) => setQ(event.target.value)}
                  onBlur={() => setSearch({ q: q || undefined })}
                />
              </form>
              <span className="ml-auto text-ink-faint">
                {filtered.length} of {data.count} endpoints
              </span>
            </div>

            <div className="figure overflow-x-auto">
              <table className="dtable">
                <thead>
                  <tr>
                    <th>endpoint</th>
                    <th className="max-sm:hidden">provider</th>
                    <th>activity</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="text-ink-faint">
                        No endpoints match these filters — clear a filter or
                        broaden <code>q</code>.
                      </td>
                    </tr>
                  ) : (
                    shown.map((row) => (
                      <tr key={`${row.provider}/${row.endpointId}`}>
                        <td className="font-mono text-[12.5px]">
                          <a
                            className="font-medium text-ink hover:text-tok-blue"
                            href={schemaHref(row)}
                          >
                            {row.endpointId}
                          </a>
                          <div className="mt-1 text-xs">
                            <a className="press-link" href={schemaHref(row)}>
                              input
                            </a>
                            <span className="text-ink-faint"> · </span>
                            <a
                              className="press-link"
                              href={schemaHref(row, 'output')}
                            >
                              output
                            </a>
                            <span className="text-ink-faint"> · </span>
                            <a
                              className="press-link"
                              href={`${schemaHref(row)}#sources`}
                            >
                              sources
                            </a>
                          </div>
                        </td>
                        <td className="font-mono text-xs text-ink-soft max-sm:hidden">
                          <a
                            className="press-link"
                            href={`/schemas?provider=${row.provider}`}
                          >
                            {row.provider}
                          </a>
                        </td>
                        <td className="font-mono text-xs text-ink-soft">
                          {row.activity}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {truncated ? (
              <p className="mt-2.5 font-mono text-xs text-ink-faint">
                showing {MAX_ROWS} of {filtered.length} — narrow with the
                filters above, or fetch the full index from{' '}
                <a className="press-link" href="/v1/schemas">
                  /v1/schemas
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
