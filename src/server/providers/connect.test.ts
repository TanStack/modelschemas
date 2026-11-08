import { describe, expect, it } from 'vitest'

import { provider as bedrock } from './adapters/amazon-bedrock.ts'
import { provider as azure } from './adapters/azure.ts'
import { provider as workersAi } from './adapters/cloudflare-workers-ai.ts'
import { provider as cohere } from './adapters/cohere.ts'
import { provider as deepseek } from './adapters/deepseek.ts'
import { provider as groq } from './adapters/groq.ts'
import { provider as lovable } from './adapters/lovable.ts'
import { provider as mistral } from './adapters/mistral.ts'
import { provider as neon } from './adapters/neon.ts'
import { provider as opencode } from './adapters/opencode.ts'
import { provider as perplexity } from './adapters/perplexity.ts'
import { provider as together } from './adapters/together.ts'
import { provider as vercel } from './adapters/vercel.ts'

/** Issue #558: every provider TanStack AI generates a client for declares its data plane. */
describe('connect profiles', () => {
  it.each([
    [groq, 'https://api.groq.com', '/openai/v1/chat/completions'],
    [mistral, 'https://api.mistral.ai', '/v1/chat/completions'],
    [deepseek, 'https://api.deepseek.com', null],
    [together, 'https://api.together.ai', '/v1/chat/completions'],
    [perplexity, 'https://api.perplexity.ai', '/v1/sonar'],
    [cohere, 'https://api.cohere.com', '/v2/chat'],
    [opencode, 'https://opencode.ai', null],
    [
      workersAi,
      'https://api.cloudflare.com/client/v4',
      '/accounts/{account_id}/ai/run/@cf/meta/llama-3.1-8b-instruct',
    ],
    [vercel, 'https://ai-gateway.vercel.sh/v1', '/chat/completions'],
    [lovable, 'https://ai.gateway.lovable.dev/v1', '/responses'],
    [neon, 'https://{host}', '/v1/chat/completions'],
  ])('$id is bearer-addressable', (provider, server, path) => {
    expect(provider.connect?.servers[0]?.url).toBe(server)
    expect(provider.connect?.security).toEqual([{ bearerAuth: [] }])
    // The server plus a classified path is the route the client calls
    // (DeepSeek and OpenCode classify by operation marker, not path).
    if (path !== null) expect(provider.classify(path, {})).not.toBeNull()
  })

  it('azure takes an api-key header or an Entra bearer on the v1 resource host', () => {
    const connect = azure.connect
    expect(connect?.servers[0]?.url).toBe(
      'https://{resource}.openai.azure.com/openai/v1',
    )
    expect(connect?.servers[0]?.variables?.resource?.default).toBeTruthy()
    expect(connect?.securitySchemes.apiKey).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'api-key',
    })
    expect(connect?.security).toEqual([{ apiKey: [] }, { bearerAuth: [] }])
  })

  it('bedrock is SigV4-signed, with the Bedrock API key as the alternative', () => {
    const connect = bedrock.connect
    expect(connect?.servers[0]).toMatchObject({
      url: 'https://bedrock-runtime.{region}.amazonaws.com',
      variables: { region: { default: 'us-east-1' } },
    })
    expect(connect?.securitySchemes.sigv4).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'Authorization',
      'x-amazon-apigateway-authtype': 'awsSigv4',
    })
    expect(connect?.security).toEqual([{ sigv4: [] }, { bearerAuth: [] }])
  })
})
