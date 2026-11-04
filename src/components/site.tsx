/**
 * Shared chrome + building blocks for the "the resource is the page" theme:
 * mono request-line headers, a readable/json content-negotiation toggle on
 * every resource page, and editor-token colors doing the semantic work.
 */
import { useState } from 'react'

import { modelChangeHref } from '#/lib/change-link.ts'

export const GITHUB_URL = 'https://github.com/TanStack/modelschemas'

export function GithubIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      fill="currentColor"
      className={className}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

export function SiteNav({ active }: { active?: string }) {
  const links: Array<[label: string, href: string]> = [
    ['models', '/models'],
    ['schemas', '/schemas'],
    ['changes', '/changes'],
    ['examples', '/examples'],
    ['docs', '/docs'],
    ['openapi.json', '/openapi.json'],
  ]
  return (
    <nav className="hairline border-b">
      <div className="mx-auto flex max-w-[1080px] flex-wrap items-baseline gap-x-6 gap-y-1 px-6 py-3.5">
        <a href="/" className="font-mono text-[15px] font-semibold text-ink">
          modelschemas
          <span className="font-normal text-ink-faint">.com</span>
        </a>
        <div className="ml-auto flex flex-wrap items-baseline gap-x-5 gap-y-1">
          {links.map(([label, href]) => (
            <a
              key={href}
              href={href}
              className={`nav-link ${active === label ? 'is-active' : ''}`}
            >
              {label}
            </a>
          ))}
          <a
            href="/account"
            className={`nav-link !text-tok-blue ${active === 'account' ? 'is-active' : ''}`}
          >
            get an API key
          </a>
          <a
            href={GITHUB_URL}
            aria-label="GitHub repository"
            className="self-center text-ink-soft transition-colors hover:text-ink"
          >
            <GithubIcon className="h-4 w-4" />
          </a>
        </div>
      </div>
    </nav>
  )
}

export function SiteFooter() {
  return (
    <footer className="hairline mt-2 border-t">
      <div className="mx-auto flex max-w-[1080px] flex-wrap gap-x-5 gap-y-2 px-6 py-4 font-mono text-[11.5px] text-ink-faint">
        <span>
          agents start at{' '}
          <a className="press-link" href="/llms.txt">
            /llms.txt
          </a>
        </span>
        <a className="press-link" href="/.well-known/agent-configuration">
          /.well-known/agent-configuration
        </a>
        <a className="press-link" href="/skill">
          /skill
        </a>
        <a className="press-link" href="/mcp">
          /mcp
        </a>
        <a
          className="inline-flex items-center gap-1.5 self-center text-ink-soft transition-colors hover:text-ink"
          href={GITHUB_URL}
        >
          <GithubIcon className="h-3.5 w-3.5" />
          github
        </a>
        <span className="ml-auto">
          openapi-described · etag-cached · cron-refreshed
        </span>
      </div>
    </footer>
  )
}

/** Copy-to-clipboard with a brief confirmation state. */
export function CopyButton({
  text,
  label = 'copy',
  className = '',
}: {
  text: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={`copybtn ${copied ? 'copied' : ''} ${className}`}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
    >
      {copied ? 'copied' : label}
    </button>
  )
}

/** Dark editor-style code panel with a caption bar and optional copy. */
export function CodePanel({
  title,
  copyText,
  children,
}: {
  title: string
  copyText?: string
  children: React.ReactNode
}) {
  return (
    <div className="codepanel">
      <div className="codehead">
        <span>{title}</span>
        {copyText !== undefined ? <CopyButton text={copyText} /> : null}
      </div>
      <pre>{children}</pre>
    </div>
  )
}

const JSON_TOKEN =
  /("(?:[^"\\]|\\.)*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g

/** Highlight cap: beyond this, serve the JSON unhighlighted (FAL schemas can be huge). */
const HIGHLIGHT_MAX_CHARS = 200_000

/** Tokenize a JSON string into syntax-colored spans (no innerHTML). */
export function highlightJson(text: string): React.ReactNode {
  if (text.length > HIGHLIGHT_MAX_CHARS) return text
  const nodes: Array<React.ReactNode> = []
  let last = 0
  let key = 0
  for (const match of text.matchAll(JSON_TOKEN)) {
    const index = match.index
    const [full, str, colon] = match
    if (index > last) nodes.push(text.slice(last, index))
    if (str !== undefined) {
      if (colon !== undefined) {
        nodes.push(
          <span key={key++} className="cj-key">
            {str}
          </span>,
          colon,
        )
      } else {
        nodes.push(
          <span key={key++} className="cj-str">
            {str}
          </span>,
        )
      }
    } else if (full === 'true' || full === 'false' || full === 'null') {
      nodes.push(
        <span key={key++} className="cj-kw">
          {full}
        </span>,
      )
    } else {
      nodes.push(
        <span key={key++} className="cj-num">
          {full}
        </span>,
      )
    }
    last = index + full.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** The JSON representation pane: exact response bytes, highlighted. */
export function JsonPane({
  title,
  json,
  note,
}: {
  title: string
  json: string
  note?: React.ReactNode
}) {
  return (
    <div className="space-y-2.5">
      <CodePanel title={title} copyText={json}>
        <code>{highlightJson(json)}</code>
      </CodePanel>
      {note !== undefined ? (
        <p className="font-mono text-xs text-ink-faint">{note}</p>
      ) : null}
    </div>
  )
}

export type ResourceView = 'readable' | 'json'

/** The signature control: content negotiation as a segmented toggle. */
export function ViewToggle({
  view,
  onChange,
}: {
  view: ResourceView
  onChange: (view: ResourceView) => void
}) {
  return (
    <div className="ml-auto flex items-center gap-2.5">
      <span className="hidden font-mono text-[10.5px] text-ink-faint sm:inline">
        Accept:
      </span>
      <div className="seg">
        {(['readable', 'json'] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => onChange(v)}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Request-line page header: the URL is the page title. */
export function ReqLine({
  method = 'GET',
  path,
  copyUrl,
  right,
}: {
  method?: string
  path: React.ReactNode
  copyUrl?: string
  right?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 pt-7 pb-3.5">
      <span className="method-chip">{method}</span>
      <h1 className="m-0 font-mono text-[19px] font-medium break-all text-ink max-sm:text-base">
        {path}
      </h1>
      {copyUrl !== undefined ? (
        <CopyButton text={copyUrl} label="copy url" />
      ) : null}
      {right}
    </div>
  )
}

/** Freshness + provenance strip under the request line. */
export function MetaStrip({
  items,
}: {
  items: Array<[key: string, value: React.ReactNode]>
}) {
  return (
    <div className="hairline mb-7 flex flex-wrap gap-x-5 gap-y-2 border-b pt-2.5 pb-6 font-mono text-[11.5px] text-ink-soft">
      {items.map(([key, value]) => (
        <span key={key} className="inline-flex items-baseline gap-1.5">
          <span className="text-ink-faint">{key}</span> {value}
        </span>
      ))}
    </div>
  )
}

export function SectionHead({
  title,
  aside,
}: {
  title: string
  aside?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 pt-10 pb-3">
      <h2 className="m-0 font-mono text-xs font-semibold tracking-[0.14em] text-ink uppercase">
        {title}
      </h2>
      {aside !== undefined ? (
        <span className="ml-auto font-mono text-[11.5px] text-ink-faint">
          {aside}
        </span>
      ) : null}
    </div>
  )
}

export function ChangeSummary({
  change,
}: {
  change: {
    type: string
    providerId: string
    subjectId: string
    summary: string
  }
}) {
  const href = modelChangeHref(change)
  if (href === null) return change.summary
  return (
    <a className="text-ink hover:text-tok-blue" href={href}>
      {change.summary}
    </a>
  )
}

export const CHANGE_STYLES: Record<string, string> = {
  'model.added': 'text-tok-green',
  'model.removed': 'text-tok-red',
  'model.updated': 'text-tok-amber',
  'catalog.shape_changed': 'text-tok-red',
  'model.deprecated': 'text-tok-red',
  'schema.added': 'text-tok-green',
  'schema.updated': 'text-tok-amber',
  'endpoint.added': 'text-tok-green',
  'endpoint.removed': 'text-tok-red',
}

export const STATUS_DOT: Record<string, string> = {
  active: 'bg-tok-green',
  degraded: 'bg-tok-amber',
  disabled: 'bg-ink-faint',
  // Registered in code, first sync not yet landed.
  pending: 'bg-tok-blue',
}

export function StatusDot({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`pulse-dot ${STATUS_DOT[status] ?? 'bg-ink-faint'}`} />
      <span className="text-xs">{status}</span>
    </span>
  )
}
