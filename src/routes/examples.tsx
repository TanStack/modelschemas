import { createFileRoute } from '@tanstack/react-router'

import { CodePanel, SiteFooter, SiteNav } from '#/components/site.tsx'
import { EXAMPLES, EXAMPLES_SOURCE_URL } from '#/lib/examples.ts'

export const Route = createFileRoute('/examples')({
  component: Examples,
})

const CLONE_SNIPPET = `git clone https://github.com/TanStack/modelschemas
cd modelschemas && bun install
cd examples/schema-studio && bun run dev`

function Examples() {
  return (
    <div className="min-h-screen text-ink">
      <SiteNav active="examples" />

      <main className="mx-auto max-w-[1080px] px-6 pb-16">
        <header className="pt-13">
          <h1 className="m-0 mb-3 font-mono text-[clamp(22px,3.4vw,30px)] leading-[1.25] font-semibold tracking-[-0.01em]">
            Examples<span className="text-tok-blue">▌</span>
          </h1>
          <p className="m-0 mb-6 max-w-[40em] text-[14.5px] text-ink-soft">
            Three small TanStack Start apps showing the modelschemas packages in
            real use. Each one runs hosted here, and each is a standalone app
            you can clone and deploy to your own Cloudflare account.
          </p>
        </header>

        <div className="figure overflow-x-auto">
          <table className="dtable">
            <thead>
              <tr>
                <th>example</th>
                <th>shows</th>
                <th className="max-sm:hidden">package</th>
                <th className="max-sm:hidden">source</th>
              </tr>
            </thead>
            <tbody>
              {EXAMPLES.map((example) => (
                <tr key={example.slug}>
                  <td className="font-mono text-xs whitespace-nowrap">
                    <a
                      className="press-link"
                      href={`/examples/${example.slug}/`}
                    >
                      {example.slug}
                    </a>
                  </td>
                  <td className="max-w-[38em]">{example.blurb}</td>
                  <td className="font-mono text-xs whitespace-nowrap text-ink-faint max-sm:hidden">
                    {example.package}
                  </td>
                  <td className="font-mono text-xs whitespace-nowrap max-sm:hidden">
                    <a
                      className="press-link"
                      href={`${EXAMPLES_SOURCE_URL}/${example.slug}`}
                    >
                      github →
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-8 max-w-[46em]">
          <CodePanel title="run one locally" copyText={CLONE_SNIPPET}>
            <code>
              {CLONE_SNIPPET.split('\n').map((line) => (
                <span key={line}>
                  <span className="prompt">$</span> {line}
                  {'\n'}
                </span>
              ))}
            </code>
          </CodePanel>
          <p className="mt-2.5 font-mono text-xs text-ink-faint">
            All three read from the live API at modelschemas.com — no key
            needed. `bun run deploy` inside an example ships it to your own
            workers.dev subdomain.
          </p>
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}
