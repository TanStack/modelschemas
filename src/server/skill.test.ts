import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { llmsTxt } from './llms-txt.ts'
import { skillMd } from './skill.ts'

describe('agent skill (SKILL.md)', () => {
  it('has valid frontmatter with name and trigger-phrase description', () => {
    const match = /^---\n([\s\S]+?)\n---\n/.exec(skillMd)
    expect(match).not.toBeNull()
    const frontmatter = parse(match?.[1] ?? '') as {
      name: string
      description: string
    }
    expect(frontmatter.name).toBe('modelschemas')
    for (const trigger of [
      'model schema',
      'what models support X',
      'validate this provider payload',
    ]) {
      expect(frontmatter.description).toContain(trigger)
    }
  })

  it('teaches the full workflow and embeds llms.txt verbatim', () => {
    for (const needle of [
      '/.well-known/agent-configuration',
      'modelschemas login',
      '/v1/validate',
      '/v1/estimate',
      '/v1/changes',
      '/mcp',
    ]) {
      expect(skillMd).toContain(needle)
    }
    expect(skillMd).toContain(llmsTxt)
  })

  it('matches the committed skill/modelschemas/SKILL.md (run pnpm run emit-skill after edits)', () => {
    const committed = readFileSync(
      join(process.cwd(), 'skill', 'modelschemas', 'SKILL.md'),
      'utf8',
    )
    expect(committed).toBe(skillMd)
  })
})
