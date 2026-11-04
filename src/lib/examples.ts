/**
 * The hosted example apps. Each is a standalone TanStack Start app in
 * examples/<slug>, deployed as its own SSR worker on a zone route at
 * /examples/<slug>/ — the main worker never serves those paths, so this
 * list is the only coupling between the site and the examples.
 */
export interface ExampleApp {
  slug: string
  blurb: string
  package: string
}

export const EXAMPLES: Array<ExampleApp> = [
  {
    slug: 'schema-studio',
    blurb:
      'generative UI — request forms rendered at runtime from any schema on the system',
    package: '@modelschemas/vite',
  },
  {
    slug: 'image-dimensions',
    blurb:
      'every image model with its supported output sizes, extracted from each input schema',
    package: '@modelschemas/client',
  },
  {
    slug: 'video-composer',
    blurb:
      'video request builder whose knobs only offer values the schema allows',
    package: '@modelschemas/client',
  },
]

export const EXAMPLES_SOURCE_URL =
  'https://github.com/TanStack/modelschemas/tree/main/examples'
