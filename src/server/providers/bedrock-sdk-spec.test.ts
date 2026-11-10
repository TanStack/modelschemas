import { describe, expect, it } from 'vitest'

import { classifyAndBundle } from '../ingest/sync.ts'
import { provider } from './adapters/amazon-bedrock.ts'
import sdk from './fixtures/bedrock-converse-native-sdk.json'
import {
  BEDROCK_RUNTIME_PATHS,
  bedrockConverseSpec,
} from './bedrock-sdk-spec.ts'

const spec = bedrockConverseSpec(sdk)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`missing ${label}`)
  return value
}

function schema(name: string): Record<string, unknown> {
  return record(spec.components?.schemas?.[name], `schema ${name}`)
}

describe('bedrock runtime paths', () => {
  it('publishes converse, converse-stream, invoke, and invoke-with-response-stream', () => {
    expect(Object.keys(spec.paths ?? {})).toEqual([...BEDROCK_RUNTIME_PATHS])
    const bundled = classifyAndBundle(provider, {
      specs: [spec],
      sources: [],
      outputStrategy: 'post-200',
    })
    expect(bundled.warnings).toEqual([])
    expect(bundled.endpoints.map((endpoint) => endpoint.path)).toEqual([
      ...BEDROCK_RUNTIME_PATHS,
    ])
    expect(
      new Set(bundled.endpoints.map((endpoint) => endpoint.activity)),
    ).toEqual(new Set(['chat']))
  })

  it('publishes one ConverseStream event per message, including stream errors', () => {
    const events = schema('ConverseStreamOutput')
    expect(events).toMatchObject({ minProperties: 1, maxProperties: 1 })
    expect(Object.keys(record(events.properties, 'events'))).toEqual([
      'messageStart',
      'contentBlockStart',
      'contentBlockDelta',
      'contentBlockStop',
      'messageStop',
      'metadata',
      'internalServerException',
      'modelStreamErrorException',
      'validationException',
      'throttlingException',
      'serviceUnavailableException',
    ])
    const stream = bundledOutput('/model/{modelId}/converse-stream')
    expect(stream.responseContentTypes).toEqual([
      'application/vnd.amazon.eventstream',
    ])
    expect(stream.output).toMatchObject({
      minProperties: 1,
      maxProperties: 1,
    })
    expect(record(stream.output?.properties, 'stream events')).toHaveProperty(
      'messageStart',
    )
    expect(record(stream.output?.$defs, 'stream defs')).toHaveProperty(
      'InternalServerException',
    )
  })

  it('publishes InvokeModel as the raw JSON document, and its stream as events', () => {
    const invoke = bundledOutput('/model/{modelId}/invoke')
    expect(typeof invoke.input?.description).toBe('string')
    expect(invoke.input).not.toHaveProperty('contentEncoding')
    expect(invoke.input).not.toHaveProperty('type')
    expect(invoke.responseContentTypes).toBeNull()

    const streaming = bundledOutput(
      '/model/{modelId}/invoke-with-response-stream',
    )
    expect(streaming.input).not.toHaveProperty('contentEncoding')
    expect(streaming.responseContentTypes).toEqual([
      'application/vnd.amazon.eventstream',
    ])
    expect(
      Object.keys(
        record(schema('ResponseStream').properties, 'response stream'),
      ),
    ).toContain('chunk')
    expect(
      record(streaming.output?.properties, 'invoke events'),
    ).toHaveProperty('chunk')
  })
})

function bundledOutput(path: string) {
  const endpoint = classifyAndBundle(provider, {
    specs: [spec],
    sources: [],
    outputStrategy: 'post-200',
  }).endpoints.find((item) => item.path === path)
  if (!endpoint?.output) throw new Error(`no bundled output for ${path}`)
  return endpoint
}
