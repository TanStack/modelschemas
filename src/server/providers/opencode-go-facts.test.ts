import { describe, expect, it } from 'vitest'

import { openCodeGoFacts, parseGoTraining } from './opencode-go-facts.ts'

describe('openCodeGoFacts', () => {
  it('requires the session header and User-Agent on every Go row', () => {
    const facts = openCodeGoFacts('opencode-go', 'glm-5.2')
    expect(facts.requiredRequestHeaders?.map((header) => header.name)).toEqual([
      'x-opencode-session',
      'User-Agent',
    ])
    expect(facts.trainsOnRequestData).toBeNull()
    expect(facts.factSources.requiredRequestHeaders).toMatchObject({
      derivation: 'docs-derived',
      sourceUrl: 'https://opencode.ai/docs/console/go/',
    })
    expect(facts.factSources.trainsOnRequestData).toBeUndefined()
  })

  it('sets training only on the id whose probe stated it', () => {
    const argon = openCodeGoFacts('opencode-go', 'gemini-4-argon-contributor')
    expect(argon.trainsOnRequestData).toBe(true)
    expect(argon.factSources.trainsOnRequestData).toMatchObject({
      derivation: 'probe-verified',
      verifiedAt: '2026-10-23',
    })
    expect(
      openCodeGoFacts('opencode-go', 'muse-spark-1.3-contributor')
        .trainsOnRequestData,
    ).toBeNull()
    expect(openCodeGoFacts('opencode', 'gemini-4-argon-contributor')).toEqual({
      requiredRequestHeaders: null,
      trainsOnRequestData: null,
      factSources: {},
    })
  })
})

const PRIVACY = `
## Endpoints

| Model | Model ID | Endpoint |
| ----- | -------- | -------- |
| Muse Spark 1.3 Contributor | muse-spark-1.3-contributor | \`https://opencode.ai/inference/go/openai/v1/responses\` |
| Muse Spark 1.2 Contributor | muse-spark-1.2-contributor | \`https://opencode.ai/inference/go/openai/v1/responses\` |
| Gemini 4 Argon | gemini-4-argon | \`https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon\` |
| Other Contributor | other-contributor | \`https://opencode.ai/inference/go/openai/v1/responses\` |

## Privacy

| Model | Model training | Data retention |
| ----- | -------------- | -------------- |
| Muse Spark 1.3 Contributor | Yes | Not ZDR |
| Muse Spark 1.2 Contributor | Yes | Not ZDR |
| Gemini 4 Argon | Not used | 0 days |
| Other Contributor | Not used | 0 days |
`

describe('parseGoTraining', () => {
  it('binds Yes to that row’s model id and does not read the suffix', () => {
    const training = parseGoTraining(PRIVACY)
    expect(training.get('muse-spark-1.3-contributor')).toBe(true)
    expect(training.get('muse-spark-1.2-contributor')).toBe(true)
    expect(training.get('gemini-4-argon')).toBe(false)
    expect(training.get('other-contributor')).toBe(false)
    expect(training.has('gemini-4-argon-contributor')).toBe(false)
  })

  it('throws when a privacy training cell is empty', () => {
    expect(() =>
      parseGoTraining(`
## Endpoints

| Model | Model ID |
| ----- | -------- |
| Mini | mini |

## Privacy

| Model | Model training |
| ----- | -------------- |
| Mini | |
`),
    ).toThrow(/Mini/)
  })

  it('throws when a privacy name has no endpoint id', () => {
    expect(() =>
      parseGoTraining(`
## Endpoints

| Model | Model ID |
| ----- | -------- |
| Mini | mini |

## Privacy

| Model | Model training |
| ----- | -------------- |
| Missing | Yes |
`),
    ).toThrow(/Missing/)
  })
})
