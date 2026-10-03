import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { computeTemplateMenuLayout } from '../src/renderer/src/template-menu-layout'

describe('computeTemplateMenuLayout', () => {
  it('opens above when the lower gap cannot fit three entries and the actions', () => {
    const layout = computeTemplateMenuLayout({
      cardTop: 283,
      cardBottom: 388,
      viewportHeight: 600,
    })

    expect(layout.placement).toBe('above')
    expect(layout.listMaxHeight).toBeGreaterThanOrEqual(104)
  })

  it('prefers below when there is enough room for the menu', () => {
    const layout = computeTemplateMenuLayout({
      cardTop: 283,
      cardBottom: 388,
      viewportHeight: 900,
      entryCount: 8,
    })

    expect(layout.placement).toBe('below')
    expect(layout.listMaxHeight).toBeGreaterThanOrEqual(104)
  })

  it('preserves a usable list and menu height when both gaps are tiny', () => {
    const layout = computeTemplateMenuLayout({
      cardTop: 80,
      cardBottom: 120,
      viewportHeight: 220,
    })

    expect(layout.listMaxHeight).toBeGreaterThanOrEqual(104)
    expect(layout.menuMaxHeight).toBeGreaterThanOrEqual(208)
  })
})

describe('template menu CSS', () => {
  it('gives the upward menu a more specific rule than the shared sort menu', () => {
    const css = readFileSync(new URL('../src/renderer/src/home.css', import.meta.url), 'utf8')

    expect(css).toMatch(
      /\.cloud-sort-menu\.template-menu-above\s*\{[^}]*top:\s*auto;[^}]*bottom:\s*var\(--template-menu-bottom\);/s,
    )
  })
})
