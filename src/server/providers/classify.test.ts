import { describe, expect, it } from 'vitest'

import { classifyAndBundle } from '../ingest/sync.ts'
import { anthropicProvider } from './anthropic.ts'
import { byteplusProvider } from './byteplus.ts'
import { elevenlabsProvider } from './elevenlabs.ts'
import { FAL_ACTIVITY_MARKER, falCategoryActivity, falProvider } from './fal.ts'
import {
  discoveryToOpenApi,
  geminiModelActivity,
  geminiProvider,
} from './gemini.ts'
import { grokProvider } from './grok.ts'
import { openaiProvider } from './openai.ts'
import {
  SYNTHETIC_VIDEO_MARKER,
  liftEmbeddingsSchemas,
  openrouterProvider,
  synthesizeVideoModelEndpoints,
} from './openrouter.ts'
import { getProvider, providerRegistry } from './index.ts'
import type { OpenApiDocument } from './types.ts'

const CORE_IDS = [
  'anthropic',
  'byteplus',
  'elevenlabs',
  'fal',
  'gemini',
  'grok',
  'openai',
  'openrouter',
] as const

describe('registry', () => {
  it('includes the original 8 providers and keeps ids unique', () => {
    const ids = providerRegistry.map((p) => p.id)
    expect(ids).toEqual(expect.arrayContaining([...CORE_IDS]))
    expect(new Set(ids).size).toBe(ids.length)
    expect(getProvider('anthropic')?.displayName).toBe('Anthropic')
    expect(getProvider('nope')).toBeUndefined()
  })
})

describe('openai classify', () => {
  const op = (tags: Array<string>) => ({ tags })

  it('maps generation tags to activities', () => {
    expect(openaiProvider.classify('/chat/completions', op(['Chat']))).toBe(
      'chat',
    )
    expect(openaiProvider.classify('/audio/speech', op(['Audio']))).toBe(
      'audio',
    )
    expect(openaiProvider.classify('/images/generations', op(['Images']))).toBe(
      'image',
    )
    expect(openaiProvider.classify('/videos', op(['Videos']))).toBe('video')
    expect(openaiProvider.classify('/embeddings', op(['Embeddings']))).toBe(
      'embeddings',
    )
    expect(openaiProvider.classify('/moderations', op(['Moderations']))).toBe(
      'moderation',
    )
  })

  it('drops platform tags and catches untagged /responses ops', () => {
    expect(openaiProvider.classify('/files', op(['Files']))).toBeNull()
    expect(openaiProvider.classify('/fine_tuning/jobs', op([]))).toBeNull()
    expect(openaiProvider.classify('/responses/input_tokens', op([]))).toBe(
      'chat',
    )
  })
})

describe('anthropic classify', () => {
  it('keeps messages + legacy completion, drops batches and platform', () => {
    expect(anthropicProvider.classify('/v1/messages', {})).toBe('chat')
    expect(anthropicProvider.classify('/v1/messages?beta=true', {})).toBe(
      'chat',
    )
    expect(anthropicProvider.classify('/v1/messages/count_tokens', {})).toBe(
      'chat',
    )
    expect(anthropicProvider.classify('/v1/complete', {})).toBe('chat')
    expect(anthropicProvider.classify('/v1/messages/batches', {})).toBeNull()
    expect(anthropicProvider.classify('/v1/files', {})).toBeNull()
  })
})

describe('gemini classify', () => {
  it('classifies by the :verb path suffix', () => {
    expect(
      geminiProvider.classify('/v1beta/models/{id}:generateContent', {}),
    ).toBe('chat')
    expect(
      geminiProvider.classify('/v1beta/models/{id}:embedContent', {}),
    ).toBe('embeddings')
    expect(geminiProvider.classify('/v1beta/models/{id}:predict', {})).toBe(
      'image',
    )
    expect(
      geminiProvider.classify('/v1beta/models/{id}:predictLongRunning', {}),
    ).toBe('video')
    expect(
      geminiProvider.classify('/v1beta/models/{id}:batchGenerateContent', {}),
    ).toBeNull()
    expect(geminiProvider.classify('/v1beta/files', {})).toBeNull()
  })
})

describe('gemini model activity', () => {
  const GENERATE = ['generateContent', 'countTokens', 'batchGenerateContent']

  it('derives Imagen/Veo/embeddings from generation methods', () => {
    expect(geminiModelActivity('imagen-4.0-generate-001', ['predict'])).toBe(
      'image',
    )
    expect(
      geminiModelActivity('veo-3.1-generate-preview', ['predictLongRunning']),
    ).toBe('video')
    expect(
      geminiModelActivity('gemini-embedding-2', [
        'embedContent',
        'countTextTokens',
        'countTokens',
      ]),
    ).toBe('embeddings')
  })

  it('splits the generateContent surface by id segment', () => {
    expect(geminiModelActivity('gemini-3.1-flash-lite-image', GENERATE)).toBe(
      'image',
    )
    expect(geminiModelActivity('gemini-3-pro-image-preview', GENERATE)).toBe(
      'image',
    )
    expect(geminiModelActivity('gemini-2.5-flash-preview-tts', GENERATE)).toBe(
      'audio',
    )
    expect(geminiModelActivity('gemini-3.1-flash', GENERATE)).toBe('chat')
    // 'image'/'tts' must be a whole dash-separated segment, not a substring.
    expect(geminiModelActivity('gemini-imagey-preview', GENERATE)).toBe('chat')
  })

  it('groups live models with chat and leaves inert models null', () => {
    expect(
      geminiModelActivity('gemini-3.1-flash-live-preview', [
        'bidiGenerateContent',
      ]),
    ).toBe('chat')
    expect(geminiModelActivity('aqa', ['generateAnswer'])).toBe('chat')
    expect(geminiModelActivity('some-utility', ['countTokens'])).toBeNull()
  })
})

describe('gemini discovery conversion', () => {
  it('converts methods, refs, and parameters into an OpenAPI document', () => {
    const spec = discoveryToOpenApi({
      title: 'Generative Language API',
      version: 'v1beta',
      baseUrl: 'https://generativelanguage.googleapis.com/',
      schemas: {
        GenerateContentRequest: {
          type: 'object',
          properties: {
            contents: { type: 'array', items: { type: 'object' } },
          },
        },
        GenerateContentResponse: { type: 'object' },
      },
      resources: {
        models: {
          methods: {
            generateContent: {
              id: 'generativelanguage.models.generateContent',
              flatPath: 'v1beta/models/{modelsId}:generateContent',
              httpMethod: 'POST',
              parameters: {
                model: { type: 'string', location: 'path', required: true },
              },
              request: { $ref: 'GenerateContentRequest' },
              response: { $ref: 'GenerateContentResponse' },
            },
          },
        },
      },
    })

    const post = spec.paths?.['/v1beta/models/{modelsId}:generateContent']?.post
    expect(post).toBeDefined()
    expect(post?.operationId).toBe('generativelanguage.models.generateContent')
    expect(
      (post?.requestBody as Record<string, unknown> | undefined)?.content,
    ).toEqual({
      'application/json': {
        schema: { $ref: '#/components/schemas/GenerateContentRequest' },
      },
    })
    expect(spec.components?.schemas?.GenerateContentRequest).toBeDefined()
    expect(spec.servers).toEqual([
      { url: 'https://generativelanguage.googleapis.com' },
    ])
  })
})

describe('grok classify', () => {
  it('classifies the OpenAI- and Anthropic-compatible surfaces by path', () => {
    expect(grokProvider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(grokProvider.classify('/v1/messages', {})).toBe('chat')
    expect(grokProvider.classify('/v1/images/generations', {})).toBe('image')
    expect(grokProvider.classify('/v1/videos/generations', {})).toBe('video')
    expect(grokProvider.classify('/v1/embeddings', {})).toBe('embeddings')
    expect(grokProvider.classify('/v1/files', {})).toBeNull()
  })
})

describe('elevenlabs classify', () => {
  it('maps audio generation tags to audio, drops management surfaces', () => {
    expect(
      elevenlabsProvider.classify('/v1/text-to-speech/{voice_id}', {
        tags: ['text-to-speech'],
      }),
    ).toBe('audio')
    expect(
      elevenlabsProvider.classify('/v1/voices', { tags: ['voices'] }),
    ).toBe('audio')
    expect(
      elevenlabsProvider.classify('/v1/music', { tags: ['music-generation'] }),
    ).toBe('audio')
    expect(
      elevenlabsProvider.classify('/v1/music/detailed', {
        tags: ['music-generation'],
      }),
    ).toBe('audio')
    expect(
      elevenlabsProvider.classify('/v1/music/stream', {
        tags: ['music-generation'],
      }),
    ).toBe('audio')
    expect(
      elevenlabsProvider.classify('/v1/music/plan', {
        tags: ['music-generation'],
      }),
    ).toBe('audio')
    expect(
      elevenlabsProvider.classify('/v1/music/video-to-music', {
        tags: ['video-to-music'],
      }),
    ).toBe('audio')
    expect(
      elevenlabsProvider.classify('/v1/studio/projects', {
        tags: ['studio'],
      }),
    ).toBeNull()
    expect(
      elevenlabsProvider.classify('/v1/music/finetunes', {
        tags: ['music-finetunes'],
      }),
    ).toBeNull()
    expect(elevenlabsProvider.classify('/v1/anything', {})).toBeNull()
    // The whole `music-generation` tag is in: the provider OpenAPI document
    // has no path cap (#560), so nothing is carved out to fit one.
    expect(
      elevenlabsProvider.classify('/v1/music/upload', {
        tags: ['music-generation'],
      }),
    ).toBe('audio')
    expect(
      elevenlabsProvider.classify('/v1/music/stem-separation', {
        tags: ['music-generation'],
      }),
    ).toBe('audio')
    expect(
      elevenlabsProvider.classify('/v1/music/detailed/stream', {
        tags: ['music-generation'],
      }),
    ).toBe('audio')
    expect(elevenlabsProvider.classify('/v1/music', { tags: ['music'] })).toBe(
      'audio',
    )
  })

  it('bundles compose input schemas, including the MusicModelID enum', () => {
    const spec: OpenApiDocument = {
      paths: {
        '/v1/music': {
          post: {
            tags: ['music-generation'],
            summary: 'Compose music',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/Body_Compose_music_v1_music_post',
                  },
                },
              },
            },
            responses: {
              '200': {
                content: {
                  'audio/*': {
                    schema: { type: 'string', format: 'binary' },
                  },
                },
              },
            },
          },
        },
        '/v1/music/plan': {
          post: {
            tags: ['music-generation'],
            summary: 'Compose a plan',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { prompt: { type: 'string' } },
                  },
                },
              },
            },
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { type: 'object' },
                  },
                },
              },
            },
          },
        },
        '/v1/music/finetunes': {
          post: {
            tags: ['music-finetunes'],
            requestBody: {
              content: {
                'multipart/form-data': {
                  schema: { type: 'object' },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Body_Compose_music_v1_music_post: {
            type: 'object',
            properties: {
              model_id: {
                $ref: '#/components/schemas/MusicModelID',
                description: 'The model to use for the generation.',
                default: 'music_v1',
              },
            },
          },
          MusicModelID: {
            type: 'string',
            enum: ['music_v1', 'music_v2', 'music_v2_5'],
            title: 'MusicModelID',
          },
        },
      },
    }
    const { endpoints, warnings } = classifyAndBundle(elevenlabsProvider, {
      specs: [spec],
      sources: [{ url: 'https://api.elevenlabs.io/openapi.json', hash: 'abc' }],
      outputStrategy: 'post-200',
    })
    expect(warnings).toEqual([])
    expect(endpoints.map((endpoint) => endpoint.dbId).sort()).toEqual([
      'elevenlabs/v1/music',
      'elevenlabs/v1/music/plan',
    ])
    const compose = endpoints.find(
      (endpoint) => endpoint.dbId === 'elevenlabs/v1/music',
    )
    const modelId = compose?.input?.properties
    expect(modelId).toBeTypeOf('object')
    const modelIdSchema = (modelId as { model_id?: { $ref?: string } }).model_id
    expect(modelIdSchema?.$ref).toBe('#/$defs/MusicModelID')
    const defs = compose?.input?.$defs as
      | { MusicModelID?: { enum?: Array<string> } }
      | undefined
    expect(defs?.MusicModelID?.enum).toEqual([
      'music_v1',
      'music_v2',
      'music_v2_5',
    ])
    expect(compose?.output).toBeUndefined()
    expect(
      endpoints.find((endpoint) => endpoint.dbId === 'elevenlabs/v1/music/plan')
        ?.output,
    ).toBeDefined()
  })
})

describe('openrouter classify', () => {
  it('classifies chat/audio/video/embeddings and drops platform paths', () => {
    expect(openrouterProvider.classify('/chat/completions', {})).toBe('chat')
    expect(openrouterProvider.classify('/messages', {})).toBe('chat')
    expect(openrouterProvider.classify('/audio/speech', {})).toBe('audio')
    expect(openrouterProvider.classify('/videos', {})).toBe('video')
    expect(openrouterProvider.classify('/embeddings', {})).toBe('embeddings')
    expect(openrouterProvider.classify('/auth/keys', {})).toBeNull()
  })

  it('routes synthetic video paths via the marker, not the path shape', () => {
    expect(
      openrouterProvider.classify('/videos/some-model', {
        [SYNTHETIC_VIDEO_MARKER]: 'some-model',
      }),
    ).toBe('video')
    // A real upstream addition under /videos/* must NOT classify by accident.
    expect(openrouterProvider.classify('/videos/some-model', {})).toBeNull()
  })
})

describe('openrouter spec fixes', () => {
  it('lifts inline /embeddings schemas into components', () => {
    const spec: OpenApiDocument = {
      paths: {
        '/embeddings': {
          post: {
            requestBody: {
              content: {
                'application/json': { schema: { type: 'object' } },
              },
            },
            responses: {
              '200': {
                content: {
                  'application/json': { schema: { type: 'object' } },
                },
              },
            },
          },
        },
      },
      components: { schemas: {} },
    }
    liftEmbeddingsSchemas(spec)
    expect(spec.components?.schemas?.EmbeddingsRequest).toEqual({
      type: 'object',
    })
    const post = spec.paths?.['/embeddings']?.post as {
      requestBody: { content: Record<string, { schema: unknown }> }
    }
    expect(post.requestBody.content['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/EmbeddingsRequest',
    })
  })

  it('synthesizes constrained per-model video endpoints', () => {
    const spec: OpenApiDocument = {
      paths: {
        '/videos': {
          post: { responses: { '200': { description: 'ok' } } },
        },
      },
      components: {
        schemas: {
          VideoGenerationRequest: {
            type: 'object',
            properties: {
              model: { type: 'string' },
              duration: { type: 'number' },
              resolution: { type: 'string' },
              generate_audio: { type: 'boolean' },
              seed: { type: 'integer' },
              frame_images: { type: 'array' },
            },
          },
        },
      },
    }
    synthesizeVideoModelEndpoints(spec, [
      {
        id: 'acme/video-1',
        name: 'Acme Video 1',
        supported_durations: [5, 10],
        supported_resolutions: ['720p'],
        generate_audio: false,
        seed: true,
      },
    ])

    const synthetic = spec.paths?.['/videos/acme/video-1']?.post
    expect(synthetic).toBeDefined()
    expect(synthetic?.[SYNTHETIC_VIDEO_MARKER]).toBe('acme/video-1')

    const schema = spec.components?.schemas
      ?.VideoGenerationRequestAcmeVideo1 as {
      properties: Record<string, Record<string, unknown>>
    }
    expect(schema.properties.model?.enum).toEqual(['acme/video-1'])
    expect(schema.properties.duration?.enum).toEqual([5, 10])
    expect(schema.properties.resolution?.enum).toEqual(['720p'])
    expect(schema.properties.generate_audio).toBeUndefined()
    expect(schema.properties.seed).toBeDefined()
    expect(schema.properties.frame_images).toBeUndefined()
    // The base schema is untouched.
    const base = spec.components?.schemas?.VideoGenerationRequest as {
      properties: Record<string, unknown>
    }
    expect(base.properties.generate_audio).toBeDefined()
  })
})

describe('fal classify', () => {
  it('maps categories to activities via override + target modality', () => {
    expect(falCategoryActivity('text-to-image')).toBe('image')
    expect(falCategoryActivity('image-to-video')).toBe('video')
    expect(falCategoryActivity('text-to-speech')).toBe('audio')
    expect(falCategoryActivity('text-to-music')).toBe('audio')
    expect(falCategoryActivity('speech-to-text')).toBe('audio') // override beats text target
    expect(falCategoryActivity('audio-to-text')).toBe('audio')
    expect(falCategoryActivity('image-to-text')).toBe('chat')
    expect(falCategoryActivity('llm')).toBe('chat')
    expect(falCategoryActivity('training')).toBeNull()
    expect(falCategoryActivity('workflow')).toBeNull()
    expect(falCategoryActivity('text-to-3d')).toBeNull() // outside taxonomy
  })

  it('classifies operations by the fetch-time activity marker', () => {
    expect(
      falProvider.classify('/fal-ai/flux/dev', {
        [FAL_ACTIVITY_MARKER]: 'image',
      }),
    ).toBe('image')
    expect(falProvider.classify('/fal-ai/flux/dev', {})).toBeNull()
    expect(
      falProvider.classify('/x', { [FAL_ACTIVITY_MARKER]: 'not-real' }),
    ).toBeNull()
  })
})

describe('byteplus classify', () => {
  it('maps the two hosts by exact path, drops everything else', () => {
    expect(byteplusProvider.classify('/chat/completions', {})).toBe('chat')
    expect(byteplusProvider.classify('/images/generations', {})).toBe('image')
    expect(byteplusProvider.classify('/contents/generations/tasks', {})).toBe(
      'video',
    )
    expect(byteplusProvider.classify('/tts/create', {})).toBe('audio')
    expect(byteplusProvider.classify('/auc/bigmodel/recognize/flash', {})).toBe(
      'audio',
    )
    expect(byteplusProvider.classify('/models', {})).toBeNull()
    expect(
      byteplusProvider.classify('/contents/generations/tasks/{id}', {}),
    ).toBe('video')
  })
})

describe('provider derivations', () => {
  it('grades the original 8 providers', () => {
    const byId = Object.fromEntries(
      providerRegistry.map((p) => [p.id, p.defaultDerivation]),
    )
    // The seven that re-fetch a published spec document every sync.
    for (const id of [
      'openai',
      'anthropic',
      'gemini',
      'grok',
      'elevenlabs',
      'openrouter',
      'fal',
    ]) {
      expect(byId[id], id).toBe('upstream-spec')
    }
    // BytePlus stamps per operation; the default is only a backstop.
    expect(byId.byteplus).toBe('probe-verified')
  })
})
