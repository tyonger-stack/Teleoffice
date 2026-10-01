import { describe, expect, it } from 'vitest'
import { parseBulletSizePct } from '../src/xml-utils'

describe('parseBulletSizePct', () => {
  it('reads schema thousandths of a percent', () => {
    expect(parseBulletSizePct('80000')).toBe(80)
    expect(parseBulletSizePct('100000')).toBe(100)
    expect(parseBulletSizePct(125000)).toBe(125)
  })

  it('reads strict percent strings', () => {
    expect(parseBulletSizePct('80%')).toBe(80)
    expect(parseBulletSizePct('62.5%')).toBe(62.5)
  })

  it('treats small integers as whole percents (python-pptx style val="80")', () => {
    expect(parseBulletSizePct('80')).toBe(80)
    expect(parseBulletSizePct('100')).toBe(100)
  })

  it('clamps to the schema range and rejects junk', () => {
    expect(parseBulletSizePct('5000')).toBe(25)
    expect(parseBulletSizePct('900000')).toBe(400)
    expect(parseBulletSizePct('abc')).toBeNull()
    expect(parseBulletSizePct('')).toBeNull()
    expect(parseBulletSizePct(undefined)).toBeNull()
    expect(parseBulletSizePct('0')).toBeNull()
  })
})
