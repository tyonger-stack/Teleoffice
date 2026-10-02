import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('privacy disclosure', () => {
  it('does not emit or document usage analytics events', () => {
    const source = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')
    const privacy = readFileSync(join(__dirname, '../../../PRIVACY.md'), 'utf8')
    expect(source).not.toMatch(/\banalytics\.track\(/)
    expect(privacy).not.toMatch(/anonymous usage statistics\*\*/)
    expect(privacy).toMatch(/does not send anonymous usage statistics/)
  })
})
