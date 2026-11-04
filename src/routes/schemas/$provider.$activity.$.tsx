import { Provenance } from '#/components/provenance.tsx'
import { sourceHref } from '#/lib/provenance.ts'
import { Fragment, useMemo, useState } from 'react'
import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

import {
  CodePanel,
  CopyButton,
  JsonPane,
  MetaStrip,
  ReqLine,
  SectionHead,
  SiteFooter,
  SiteNav,
  ViewToggle,
} from '#/components/site.tsx'
import type { ResourceView } from '#/components/site.tsx'
import { defDomId, schemaToRows } from '#/lib/schema-view.ts'
import type { PropRow } from '#/lib/schema-view.ts'
import type { Json } from '#/lib/json.ts'
import { shortDate } from '#/lib/time.ts'
import { activities } from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import type { EndpointSchemaResult } from '#/server/schemas-api.ts'

type SchemaKind = 'input' | 'output'

/** EndpointSchemaResult with `schema: unknown` narrowed for serialization. */
type SerializableSchemaResult = Omit<EndpointSchemaResult, 'schema'> & {
  schema: Json
}

interface SchemaSearch {
  /** Absent means the default, `input` — keeps canonical URLs clean. */
  kind?: 'output'
  version?: string
}

const getSchema = createServerFn({ method: 'GET' })
  .validator(
    (params: {
      provider: string
      activity: string
      endpointId: string
      kind: SchemaKind
      version?: string
    }) => params,
  )
  .handler(async ({ data }): Promise<SerializableSchemaResult | null> => {
    const { env } = await import('cloudflare:workers')
    const { getDb } = await import('#/db/index.ts')
    const { getEndpointSchema } = await import('#/server/schemas-api.ts')
    if (!(activities as ReadonlyArray<string>).includes(data.activity)) {
      return null
    }
    const result = await getEndpointSchema(
      getDb(env, { replica: true }),
      data.provider,
      data.activity as Activity,
      data.endpointId,
      data.kind,
      data.version,
    )
    // stored schema text is parsed JSON, so the unknown really is Json
    return result as SerializableSchemaResult | null
  })

export const Route = createFileRoute('/schemas/$provider/$activity/$')({
  validateSearch: (search: Record<string, unknown>): SchemaSearch => ({
    kind: search.kind === 'output' ? 'output' : undefined,
    version:
      typeof search.version === 'string' && search.version !== ''
        ? search.version
        : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps }) => {
    const result = await getSchema({
      data: {
        provider: params.provider,
        activity: params.activity,
        endpointId: params._splat ?? '',
        kind: deps.kind ?? 'input',
        version: deps.version,
      },
    })
    if (result === null) throw notFound()
    return result
  },
  component: SchemaDetail,
})

/** Slash-preserving path segment. `encodeURIComponent` on the whole id shows `%2F`. */
function endpointPath(endpointId: string): string {
  return endpointId.split('/').map(encodeURIComponent).join('/')
}

function TypeLabel({ row }: { row: PropRow }) {
  if (row.typeRefs.length === 0) return <>{row.typeLabel}</>
  const nodes: Array<React.ReactNode> = []
  let rest = row.typeLabel
  let key = 0
  for (const name of row.typeRefs) {
    const index = rest.indexOf(name)
    if (index === -1) continue
    if (index > 0) nodes.push(rest.slice(0, index))
    nodes.push(
      <a
        key={`${name}-${String(key)}`}
        className="underline decoration-rule-strong underline-offset-2 hover:text-tok-blue"
        href={`#${defDomId(name)}`}
        onClick={(event) => event.stopPropagation()}
      >
        {name}
      </a>,
    )
    key += 1
    rest = rest.slice(index + name.length)
  }
  if (rest.length > 0) nodes.push(rest)
  return <>{nodes}</>
}

function PropRows({
  rows,
  depth,
  parentKey,
}: {
  rows: Array<PropRow>
  depth: number
  parentKey: string
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  return (
    <>
      {rows.map((row) => {
        const key = `${parentKey}.${row.name}`
        const expandable = row.children.length > 0
        const isOpen = open[key] === true
        return (
          <Fragment key={key}>
            <tr
              className={
                expandable ? 'cursor-pointer hover:bg-paper-inset' : ''
              }
              onClick={
                expandable
                  ? () => setOpen((prev) => ({ ...prev, [key]: !isOpen }))
                  : undefined
              }
            >
              <td
                className="font-mono text-[13px] font-medium whitespace-nowrap"
                style={{ paddingLeft: `${String(14 + depth * 22)}px` }}
              >
                {expandable ? (
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${row.name}`}
                    className="mr-1.5 cursor-pointer border-none bg-transparent p-0 font-mono text-ink-faint"
                  >
                    {isOpen ? '▾' : '▸'}
                  </button>
                ) : null}
                {row.name}
                {row.required ? <span className="text-tok-red">*</span> : null}
              </td>
              <td>
                <span className={`ptype t-${row.typeClass}`}>
                  <TypeLabel row={row} />
                </span>
              </td>
              <td className="max-w-[46em] text-[13px] text-ink-soft">
                {row.description ?? ''}
              </td>
              <td className="font-mono text-[11px] whitespace-nowrap text-ink-faint">
                {row.constraints.join(' · ')}
                {row.deprecated ? (
                  <span className="text-tok-red">
                    {row.constraints.length > 0 ? ' · ' : ''}deprecated
                  </span>
                ) : null}
              </td>
            </tr>
            {expandable && isOpen ? (
              <PropRows rows={row.children} depth={depth + 1} parentKey={key} />
            ) : null}
          </Fragment>
        )
      })}
    </>
  )
}

function SchemaDetail() {
  const result = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [view, setView] = useState<ResourceView>('readable')

  const pathId = endpointPath(result.endpointId)
  const kindQuery = search.kind === 'output' ? '?kind=output' : ''
  const apiPath = `/v1/schemas/${result.provider}/${result.activity}/${pathId}${kindQuery}`
  const jsonBody = useMemo(() => JSON.stringify(result, null, 2), [result])
  const table = useMemo(() => schemaToRows(result.schema), [result.schema])

  const validateCurl = `curl -X POST https://modelschemas.com/v1/validate -d '{"provider":"${result.provider}","endpointId":"${result.endpointId}","payload":{}}'`
  const sourceUrl = sourceHref(result.provenance.sourceUrl)
  const jsonBytes = new Blob([jsonBody]).size

  return (
    <div className="min-h-screen text-ink">
      <SiteNav active="models" />
      <main className="mx-auto max-w-[1080px] px-6 pb-16">
        <ReqLine
          path={
            <>
              /v1/schemas/{result.provider}/{result.activity}/
              <span className="text-tok-blue">{result.endpointId}</span>
              {kindQuery === '' ? null : (
                <span className="text-ink-faint">{kindQuery}</span>
              )}
            </>
          }
          copyUrl={`https://modelschemas.com${apiPath}`}
          right={
            <div className="ml-auto flex flex-wrap items-center gap-2.5">
              <div className="seg">
                {(['input', 'output'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={(search.kind ?? 'input') === k}
                    onClick={() => {
                      void navigate({
                        search: (): SchemaSearch => ({
                          kind: k === 'output' ? 'output' : undefined,
                          version: undefined,
                        }),
                      })
                    }}
                  >
                    {k}
                  </button>
                ))}
              </div>
              <ViewToggle view={view} onChange={setView} />
            </div>
          }
        />
        <MetaStrip
          items={[
            ['kind', result.kind],
            [
              'activity',
              <a
                key="a"
                className="press-link"
                href={`/models?activity=${result.activity}&provider=${result.provider}`}
              >
                {result.activity}
              </a>,
            ],
            [
              'hash',
              <span key="h" className="inline-flex items-center gap-1.5">
                {result.contentHash.slice(0, 8)}…
                <CopyButton text={result.contentHash} />
              </span>,
            ],
            ['extracted', shortDate(result.createdAt)],
            [
              'version',
              result.supersededAt === null ? (
                'current'
              ) : (
                <span className="text-tok-amber">
                  superseded {shortDate(result.supersededAt)}
                </span>
              ),
            ],
            ...(sourceUrl !== null
              ? ([
                  [
                    'source',
                    <a key="s" className="press-link" href={sourceUrl}>
                      upstream spec ↗
                    </a>,
                  ],
                ] as Array<[string, React.ReactNode]>)
              : []),
          ]}
        />

        <section id="sources" className="mb-6">
          <Provenance
            facts={{ schema: result.provenance }}
            omitLinks={sourceUrl !== null}
          />
        </section>

        {view === 'json' ? (
          <JsonPane
            title={`application/json · 200 OK · ${String(Math.round(jsonBytes / 1024))} KB`}
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
            {result.provider === 'byteplus' &&
            result.endpointId === 'contents/generations/tasks' ? (
              <p className="mb-4 max-w-[46em] font-mono text-[13px] text-ink-soft">
                This call returns a task id. The video is on{' '}
                <a
                  className="press-link"
                  href={`/schemas/byteplus/video/${endpointPath('contents/generations/tasks/{id}')}?kind=output`}
                >
                  GET /contents/generations/tasks/{'{id}'}
                </a>
                . Poll until <code>status</code> is <code>succeeded</code>, then
                download <code>content.video_url</code> (valid 24 hours).
              </p>
            ) : null}

            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 pb-3">
              <h2 className="m-0 font-mono text-xs font-semibold tracking-[0.14em] text-ink uppercase">
                {result.kind === 'input' ? 'Request body' : 'Response body'}
              </h2>
              <span className="ml-auto font-mono text-[11.5px] text-ink-faint">
                {table.propertyCount} properties ·{' '}
                <span className="text-tok-red">
                  {table.requiredCount} required
                </span>{' '}
                · {table.defsCount} $defs
              </span>
            </div>

            {table.fallback ? (
              <div className="space-y-2.5">
                <p className="font-mono text-sm text-ink-faint">
                  This schema isn’t a plain object with properties — showing the
                  raw JSON instead.
                </p>
                <JsonPane title="application/json" json={jsonBody} />
              </div>
            ) : (
              <div className="figure overflow-x-auto">
                <table className="dtable">
                  <thead>
                    <tr>
                      <th className="w-56">property</th>
                      <th className="w-32">type</th>
                      <th className="min-w-[24em]">description</th>
                      <th>constraints</th>
                    </tr>
                  </thead>
                  <tbody>
                    <PropRows rows={table.rows} depth={0} parentKey="root" />
                  </tbody>
                </table>
              </div>
            )}

            {table.definitions.length > 0 ? (
              <>
                <SectionHead
                  title="Types"
                  aside={`${String(table.definitions.length)} $defs`}
                />
                <div className="space-y-8">
                  {table.definitions.map((def) => (
                    <section key={def.name} id={defDomId(def.name)}>
                      <h3 className="mb-2 font-mono text-[13px] font-medium text-ink">
                        <a
                          className="hover:text-tok-blue"
                          href={`#${defDomId(def.name)}`}
                        >
                          {def.name}
                        </a>
                        <span className={`ptype t-${def.typeClass} ml-2`}>
                          <TypeLabel row={def} />
                        </span>
                      </h3>
                      {def.description !== null ? (
                        <p className="mb-2 max-w-[46em] text-[13px] text-ink-soft">
                          {def.description}
                        </p>
                      ) : null}
                      {def.children.length > 0 ? (
                        <div className="figure overflow-x-auto">
                          <table className="dtable">
                            <tbody>
                              <PropRows
                                rows={def.children}
                                depth={0}
                                parentKey={def.name}
                              />
                            </tbody>
                          </table>
                        </div>
                      ) : def.constraints.length > 0 ? (
                        <p className="font-mono text-[11px] text-ink-faint">
                          {def.constraints.join(' · ')}
                        </p>
                      ) : null}
                    </section>
                  ))}
                </div>
              </>
            ) : null}

            <SectionHead
              title="Validate a payload"
              aside="before you spend tokens"
            />
            <CodePanel title="shell" copyText={validateCurl}>
              <code>
                <span className="prompt">$</span> curl -X POST
                https://modelschemas.com/v1/validate \{'\n    '}-d{' '}
                <span className="cj-str">
                  {`'{"provider":"${result.provider}","endpointId":"${result.endpointId}","payload":{…}}'`}
                </span>
                {'\n'}
                <span className="cj-dim">
                  {`→ {"valid": false, "errors": [{"path": "#", "keyword": "required", …}]}`}
                </span>
              </code>
            </CodePanel>
          </>
        )}
      </main>
      <SiteFooter />
    </div>
  )
}
