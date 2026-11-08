import { Provenance } from '#/components/provenance.tsx'
import { sourceHref } from '#/lib/provenance.ts'
import { useEffect, useRef, useState } from 'react'
import { createFileRoute, notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import type { RateCard } from '@modelschemas/rate-card'

import { MetaStrip, ReqLine, SiteFooter, SiteNav } from '#/components/site.tsx'
import {
  formFields,
  formatAmount,
  toEstimateParts,
} from '#/lib/rate-card-form.ts'
import type { FieldValue } from '#/lib/rate-card-form.ts'

type Quote =
  | { ok: true; amount: number; estimated: string[] }
  | { ok: false; message: string }

interface CalculatorData {
  provider: string
  modelId: string
  rawId: string
  displayName: string | null
  inputs: RateCard['inputs']
  compact: {
    currency: string
    per: string
    inputPerMillion?: number
    outputPerMillion?: number
    tiered?: true
  }
  sourceUrl: string | null
  sourceTrace: { sourceUrl: string; sourceHash: string | null }
  examples: Array<{ usd: number; quote: string }>
  values: Record<string, FieldValue>
  quote: Quote
}

const QUOTE_FAILED =
  'Could not reach the estimator; the last quote is kept. Edit a field to retry.'

/**
 * Same validator and service function `POST /v1/estimate` uses — no second
 * formula. Unexpected throws come back as a failed quote, not a 500.
 */
async function runQuote(raw: unknown): Promise<Quote> {
  const { env } = await import('cloudflare:workers')
  const { getDb } = await import('#/db/index.ts')
  const { estimateCost, parseEstimateBody } =
    await import('#/server/estimate.ts')
  const body = parseEstimateBody(raw)
  if (!body) {
    return {
      ok: false,
      message:
        'Body must be { provider: string, model: string, request?: object, usage?: object }.',
    }
  }
  try {
    const outcome = await estimateCost(getDb(env), body)
    if (!outcome.ok) return { ok: false, message: outcome.message }
    // The calculator renders only for a row with a card; a routed row's
    // range has no single amount to show.
    if ('min' in outcome.result) {
      return { ok: false, message: 'This model has no single billed price.' }
    }
    if ('byInput' in outcome.result) {
      return {
        ok: false,
        message: `Choose ${outcome.result.byInput.input} to see one price.`,
      }
    }
    return {
      ok: true,
      amount: outcome.result.amount,
      estimated: outcome.result.estimated,
    }
  } catch (cause) {
    console.error('rate card quote failed', body.provider, body.model, cause)
    return { ok: false, message: QUOTE_FAILED }
  }
}

const quoteRateCard = createServerFn({ method: 'POST' })
  .validator((data: unknown) => data)
  .handler(({ data }) => runQuote(data))

const getCalculator = createServerFn({ method: 'GET' })
  .validator((params: { provider: string; modelId: string }) => params)
  .handler(async ({ data }): Promise<CalculatorData | null> => {
    const { env } = await import('cloudflare:workers')
    const { getDb } = await import('#/db/index.ts')
    const { getModelDetail } = await import('#/server/catalog.ts')
    const { parseStoredRateCard, projectTokenPricing } =
      await import('#/server/rate-card.ts')
    const { seedValues } = await import('#/lib/rate-card-form.ts')

    const model = await getModelDetail(
      getDb(env, { replica: true }),
      data.provider,
      data.modelId,
    )
    const card = model ? parseStoredRateCard(model.pricing) : null
    if (model && model.pricing != null && !card) {
      console.error(
        'stored rate card failed to parse',
        data.provider,
        data.modelId,
      )
    }
    if (!model || !card) return null
    const values = seedValues(card)
    return {
      provider: data.provider,
      modelId: data.modelId,
      rawId: model.rawId,
      displayName: model.displayName,
      inputs: card.inputs,
      compact: projectTokenPricing(card),
      sourceUrl: sourceHref(card.source.url),
      sourceTrace: {
        sourceUrl: card.source.url,
        sourceHash: card.source.hash,
      },
      examples: card.examples.map(({ usd, quote }) => ({ usd, quote })),
      values,
      quote: await runQuote({
        provider: data.provider,
        model: data.modelId,
        ...toEstimateParts(card.inputs, values),
      }),
    }
  })

export const Route = createFileRoute('/models/$provider/$modelId_/pricing')({
  loader: async ({ params }) => {
    const data = await getCalculator({ data: params })
    if (data === null) throw notFound()
    return data
  },
  component: RateCardCalculator,
})

const fieldClass =
  'w-40 rounded border border-rule bg-transparent px-2 py-1 font-mono text-[12.5px]'

function describe(
  inputs: RateCard['inputs'],
  values: Record<string, FieldValue>,
): string {
  return formFields(inputs)
    .map(({ name, input }) => {
      const value = values[name]
      const shown =
        value === ''
          ? 'estimated'
          : typeof value === 'object'
            ? `${value.width}×${value.height}`
            : String(value)
      return `${input.param} ${shown}`
    })
    .join(' · ')
}

function RateCardCalculator() {
  const data = Route.useLoaderData()
  const { inputs, compact } = data
  const fields = formFields(inputs)
  const [values, setValues] = useState(data.values)
  const [amount, setAmount] = useState(data.quote.ok ? data.quote.amount : null)
  const [estimated, setEstimated] = useState(
    data.quote.ok ? data.quote.estimated : [],
  )
  const [quoted, setQuoted] = useState(describe(inputs, data.values))
  const [error, setError] = useState(data.quote.ok ? null : data.quote.message)
  const [loading, setLoading] = useState(false)
  const latest = useRef(0)
  const seeded = useRef(values)

  useEffect(() => {
    if (values === seeded.current) return
    const id = ++latest.current
    setLoading(true)
    const timer = setTimeout(() => {
      // Only the newest edit's answer may land; older ones are dropped.
      const settle = (quote: Quote) => {
        if (id !== latest.current) return
        setLoading(false)
        if (quote.ok) {
          setAmount(quote.amount)
          setEstimated(quote.estimated)
          setQuoted(describe(inputs, values))
          setError(null)
        } else {
          setError(quote.message)
        }
      }
      // Inside the promise so a throw while building the body still settles.
      Promise.resolve()
        .then(() =>
          quoteRateCard({
            data: {
              provider: data.provider,
              model: data.modelId,
              ...toEstimateParts(inputs, values),
            },
          }),
        )
        .then(settle, (cause: unknown) => {
          console.error('rate card quote failed', cause)
          settle({ ok: false, message: QUOTE_FAILED })
        })
    }, 250)
    return () => clearTimeout(timer)
  }, [values, data.provider, data.modelId, inputs])

  const set = (name: string, value: FieldValue) =>
    setValues((prev) => ({ ...prev, [name]: value }))

  const perMillion: Record<string, number | undefined> = {
    input_tokens: compact.inputPerMillion,
    output_tokens: compact.outputPerMillion,
  }
  const modelHref = `/models/${data.provider}/${data.modelId}`

  return (
    <div className="min-h-screen text-ink">
      <SiteNav active="models" />
      <main className="mx-auto max-w-[1080px] px-6 pb-16">
        <ReqLine
          method="POST"
          path={
            <>
              /v1/estimate · <span className="text-tok-blue">{data.rawId}</span>
            </>
          }
          copyUrl="https://modelschemas.com/v1/estimate"
        />
        <MetaStrip
          items={[
            [
              'model',
              <a key="m" className="press-link" href={modelHref}>
                {data.displayName ?? data.rawId}
              </a>,
            ],
            ['priced per', compact.per],
            [
              'source',
              <a
                key="s"
                className="press-link"
                href={data.sourceUrl ?? undefined}
                title={data.sourceUrl ?? undefined}
              >
                {data.sourceUrl ? 'pricing page ↗' : 'Source unknown'}
              </a>,
            ],
          ]}
        />

        <section id="sources" className="mb-6">
          <Provenance
            facts={{ pricing: data.sourceTrace }}
            omitLinks={data.sourceUrl !== null}
          />
        </section>
        <div className="figure overflow-x-auto">
          <table className="dtable">
            <tbody>
              {fields.map(({ name, input, estimates: estimatesParam }) => {
                const value = values[name]
                const id = `rc-${name}`
                const rate = perMillion[input.param]
                return (
                  <tr key={name}>
                    <td className="w-56 font-mono text-xs text-ink-faint">
                      <label htmlFor={id}>{input.param}</label>
                      <div className="text-[11px]">
                        {input.kind} · {input.bound ?? 'request'}
                        {estimatesParam ? ` · estimates ${estimatesParam}` : ''}
                      </div>
                    </td>
                    <td className="font-mono text-[12.5px]">
                      <Field
                        id={id}
                        input={input}
                        value={value}
                        onChange={(next) => set(name, next)}
                      />
                      {rate !== undefined ? (
                        <span className="ml-3 text-ink-faint">
                          {formatAmount(rate, compact.currency)} / 1M
                        </span>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
              <tr>
                <td className="font-mono text-xs text-ink-faint">quote</td>
                <td className="font-mono text-[12.5px]" aria-live="polite">
                  <span className="text-base font-semibold">
                    {amount === null
                      ? '—'
                      : formatAmount(amount, compact.currency)}
                  </span>
                  {amount === null ? null : (
                    <span className="text-ink-soft"> — {quoted}</span>
                  )}
                  {estimated.length > 0 ? (
                    <div className="text-ink-faint">
                      estimated {estimated.join(', ')}, not a billed usage count
                    </div>
                  ) : null}
                  {loading ? (
                    <span className="ml-2 text-ink-faint">re-quoting…</span>
                  ) : null}
                  {compact.tiered ? (
                    <div className="text-ink-faint">
                      base rate; long prompts re-quote
                    </div>
                  ) : null}
                  {error !== null ? (
                    <div className="text-tok-red" role="alert">
                      {error}
                    </div>
                  ) : null}
                </td>
              </tr>
              {data.examples.length > 0 ? (
                <tr>
                  <td className="font-mono text-xs text-ink-faint">examples</td>
                  <td className="font-mono text-[12.5px]">
                    {data.examples.map((example) => (
                      <div key={example.quote}>
                        {formatAmount(example.usd, compact.currency)} —{' '}
                        {example.quote}
                      </div>
                    ))}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {inputs.input_video ? (
          <p className="mt-2.5 font-mono text-xs text-ink-faint">
            Input video uses a lower token rate. With tokens left blank, a short
            input is billed at the published minimum input length for that
            output duration. A length the table does not list refuses.
          </p>
        ) : null}
        <p className="mt-2.5 font-mono text-xs text-ink-faint">
          <a className="press-link" href={modelHref}>
            ← back to {data.rawId}
          </a>
        </p>
      </main>
      <SiteFooter />
    </div>
  )
}

function Field({
  id,
  input,
  value,
  onChange,
}: {
  id: string
  input: RateCard['inputs'][string]
  value: FieldValue | undefined
  onChange: (value: FieldValue) => void
}) {
  if (typeof value === 'boolean') {
    return (
      <input
        id={id}
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
    )
  }
  if (typeof value === 'object') {
    const presets = input.kind === 'dimensions' ? (input.presets ?? {}) : {}
    const matched = Object.entries(presets).find(
      ([, [w, h]]) => String(w) === value.width && String(h) === value.height,
    )
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <input
          id={id}
          aria-label={`${input.param} width`}
          className={`${fieldClass} w-24`}
          type="number"
          min={1}
          value={value.width}
          onChange={(e) => onChange({ ...value, width: e.target.value })}
        />
        ×
        <input
          aria-label={`${input.param} height`}
          className={`${fieldClass} w-24`}
          type="number"
          min={1}
          value={value.height}
          onChange={(e) => onChange({ ...value, height: e.target.value })}
        />
        {Object.keys(presets).length > 0 ? (
          <select
            aria-label={`${input.param} preset`}
            className={fieldClass}
            value={matched?.[0] ?? ''}
            onChange={(e) => {
              const preset = presets[e.target.value]
              if (preset) {
                onChange({
                  width: String(preset[0]),
                  height: String(preset[1]),
                })
              }
            }}
          >
            <option value="">custom</option>
            {Object.keys(presets).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : null}
      </span>
    )
  }
  if (input.kind === 'enum') {
    return (
      <select
        id={id}
        className={fieldClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {input.values.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    )
  }
  return (
    <input
      id={id}
      className={fieldClass}
      type="number"
      min={0}
      step={input.kind === 'count' ? 1 : 'any'}
      value={value ?? ''}
      placeholder={
        input.kind === 'number' && input.estimate ? 'estimated' : undefined
      }
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
