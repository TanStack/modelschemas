import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

import {
  CHANGE_STYLES,
  ChangeSummary,
  JsonPane,
  MetaStrip,
  ReqLine,
  SiteFooter,
  SiteNav,
  ViewToggle,
} from '#/components/site.tsx'
import type { ResourceView } from '#/components/site.tsx'
import { changeDiffs } from '#/lib/change-diff.ts'
import type { ChangeDiff } from '#/lib/change-diff.ts'
import { timeAgo } from '#/lib/time.ts'
import type { ChangeType } from '#/db/schema.ts'

interface ChangesSearch {
  cursor?: string
  provider?: string
  type?: ChangeType
}

/** Filter links above the table; `undefined` is every type. */
const TYPE_FILTERS: Array<[string, ChangeType | undefined]> = [
  ['all', undefined],
  ['new models', 'model.added'],
  ['removed models', 'model.removed'],
  ['updated models', 'model.updated'],
  ['row shape', 'catalog.shape_changed'],
  ['deprecated models', 'model.deprecated'],
]

interface ChangeRow {
  id: string
  type: string
  providerId: string
  subjectId: string
  summary: string
  createdAt: number
  /** What a `model.updated` changed; the raw payload stays on the API. */
  diffs: Array<ChangeDiff>
}

/** Diffs shown per row before the rest collapse into a count. */
const SHOWN_DIFFS = 4

interface ChangesData {
  count: number
  changes: Array<ChangeRow>
  nextCursor: string | null
  /** Epoch seconds the server read the feed; `timeAgo` measures from it. */
  renderedAt: number
}

const getChanges = createServerFn({ method: 'GET' })
  .validator((query: ChangesSearch) => query)
  .handler(async ({ data }): Promise<ChangesData> => {
    const { env } = await import('cloudflare:workers')
    const { getDb } = await import('#/db/index.ts')
    const { listChanges } = await import('#/server/changes-api.ts')
    // Same primary as GET /v1/changes: the cursor has to see the latest write.
    const outcome = await listChanges(getDb(env), { ...data, limit: 50 })
    const renderedAt = Math.floor(Date.now() / 1000)
    if (!outcome.ok)
      return { count: 0, changes: [], nextCursor: null, renderedAt }
    return {
      renderedAt,
      count: outcome.result.count,
      nextCursor: outcome.result.nextCursor,
      changes: outcome.result.changes.map((c) => ({
        id: c.id,
        type: c.type,
        providerId: c.providerId,
        subjectId: c.subjectId,
        summary: c.summary,
        createdAt: c.createdAt,
        diffs: changeDiffs(c.payload),
      })),
    }
  })

export const Route = createFileRoute('/changes')({
  validateSearch: (search: Record<string, unknown>): ChangesSearch => ({
    cursor:
      typeof search.cursor === 'string' && search.cursor !== ''
        ? search.cursor
        : undefined,
    provider:
      typeof search.provider === 'string' && search.provider !== ''
        ? search.provider
        : undefined,
    type: TYPE_FILTERS.find(([, type]) => type === search.type)?.[1],
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getChanges({ data: deps }),
  component: Changes,
})

function Changes() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const [view, setView] = useState<ResourceView>('readable')

  const params = new URLSearchParams()
  if (search.provider) params.set('provider', search.provider)
  if (search.type) params.set('type', search.type)
  if (search.cursor) params.set('cursor', search.cursor)
  const qs = params.toString() === '' ? '' : `?${params.toString()}`
  const apiPath = `/v1/changes${qs}`
  const jsonBody = JSON.stringify(
    {
      count: data.count,
      changes: data.changes.map(({ diffs: _diffs, ...change }) => change),
      nextCursor: data.nextCursor,
    },
    null,
    2,
  )

  const olderParams = new URLSearchParams()
  if (search.provider) olderParams.set('provider', search.provider)
  if (search.type) olderParams.set('type', search.type)
  if (data.nextCursor) olderParams.set('cursor', data.nextCursor)

  /** A filter link keeps the provider and starts again at the newest page. */
  const typeHref = (type: ChangeType | undefined) => {
    const filter = new URLSearchParams()
    if (search.provider) filter.set('provider', search.provider)
    if (type) filter.set('type', type)
    const query = filter.toString()
    return query === '' ? '/changes' : `/changes?${query}`
  }

  return (
    <div className="min-h-screen text-ink">
      <SiteNav active="changes" />
      <main className="mx-auto max-w-[1080px] px-6 pb-16">
        <ReqLine
          path={
            <>
              /v1/changes
              {qs === '' ? null : <span className="text-ink-faint">{qs}</span>}
            </>
          }
          copyUrl={`https://modelschemas.com${apiPath}`}
          right={<ViewToggle view={view} onChange={setView} />}
        />
        <MetaStrip
          items={[
            ['count', String(data.count)],
            ['order', 'newest first'],
            ['page size', '50'],
          ]}
        />

        <div className="mb-2.5 flex flex-wrap gap-4 font-mono text-xs">
          {TYPE_FILTERS.map(([label, type]) =>
            type === search.type ? (
              <span key={label} className="text-ink">
                {label}
              </span>
            ) : (
              <a key={label} className="press-link" href={typeHref(type)}>
                {label}
              </a>
            ),
          )}
        </div>

        {view === 'json' ? (
          <JsonPane
            title="application/json · 200 OK"
            json={jsonBody}
            note={
              <>
                identical body to{' '}
                <code>curl https://modelschemas.com{apiPath}</code>
              </>
            }
          />
        ) : (
          <>
            <div className="figure overflow-x-auto">
              <table className="dtable">
                <thead>
                  <tr>
                    <th>when</th>
                    <th>type</th>
                    <th>summary</th>
                    <th className="max-sm:hidden">provider</th>
                  </tr>
                </thead>
                <tbody>
                  {data.changes.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="text-ink-faint">
                        {search.type || search.provider
                          ? 'no changes match this filter.'
                          : 'no changes yet — the next cron poll will populate this feed.'}
                      </td>
                    </tr>
                  ) : (
                    data.changes.map((change) => (
                      <tr key={change.id}>
                        <td className="font-mono text-xs whitespace-nowrap text-ink-faint">
                          {timeAgo(change.createdAt, data.renderedAt)}
                        </td>
                        <td
                          className={`font-mono text-xs whitespace-nowrap ${CHANGE_STYLES[change.type] ?? 'text-ink-soft'}`}
                        >
                          {change.type}
                        </td>
                        <td className="max-w-[38em]">
                          <div className="truncate">
                            <ChangeSummary change={change} />
                          </div>
                          {change.diffs.slice(0, SHOWN_DIFFS).map((diff) => (
                            <div
                              key={diff.path}
                              className="truncate font-mono text-xs text-ink-faint"
                            >
                              {diff.path}{' '}
                              <span className="text-tok-red">
                                {diff.before}
                              </span>
                              {' → '}
                              <span className="text-tok-green">
                                {diff.after}
                              </span>
                            </div>
                          ))}
                          {change.diffs.length > SHOWN_DIFFS ? (
                            <div className="font-mono text-xs text-ink-faint">
                              +{change.diffs.length - SHOWN_DIFFS} more
                            </div>
                          ) : null}
                        </td>
                        <td className="font-mono text-xs text-ink-faint max-sm:hidden">
                          <a
                            className="press-link"
                            href={`/changes?provider=${change.providerId}`}
                          >
                            {change.providerId}
                          </a>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-4 font-mono text-xs">
              {data.nextCursor === null ? null : (
                <a
                  className="press-link"
                  href={`/changes?${olderParams.toString()}`}
                >
                  older →
                </a>
              )}
              <span className="ml-auto text-ink-faint">
                webhook push:{' '}
                <a className="press-link" href="/docs">
                  POST /v1/subscriptions
                </a>
              </span>
            </div>
          </>
        )}
      </main>
      <SiteFooter />
    </div>
  )
}
