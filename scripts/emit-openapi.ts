// Writes the service's OpenAPI document (src/server/openapi.ts) to
// ./openapi.json — the input for client generation (task 7.4) and the
// drift check. Run via `pnpm run openapi:emit`.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { openApiDocument } from '../src/server/openapi.ts'

const out = join(import.meta.dirname, '..', 'openapi.json')
writeFileSync(out, JSON.stringify(openApiDocument, null, 2) + '\n')
console.log(`wrote ${out}`)
