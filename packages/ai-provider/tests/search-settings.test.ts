import { describe, expect, it } from 'vitest'
import { defaultAiSettings, resolveAiSettings } from '../src/providers'
import {
  activeSearchProvider,
  defaultAiSearchSettings,
  resolveAiSearchSettings,
} from '../src/search-settings'

describe('search settings', () => {
  it('defaults to local-cli with empty keys and rides along in defaultAiSettings', () => {
    expect(defaultAiSearchSettings()).toEqual({
      provider: 'local-cli',
      providers: {
        serper: { apiKey: '' },
        serply: { apiKey: '' },
        tavily: { apiKey: '' },
        parallel: { apiKey: '' },
      },
    })
    expect(defaultAiSettings().search?.provider).toBe('local-cli')
    const resolved = resolveAiSettings(
      { provider: 'genspark', providers: {} as never },
      defaultAiSettings(),
    )
    expect(resolved.search).toEqual(defaultAiSearchSettings())
  })

  it('merges and trims stored keys', () => {
    const s = resolveAiSearchSettings({
      provider: 'tavily',
      providers: { tavily: { apiKey: ' tvly-1 ' } } as never,
    })
    expect(s.provider).toBe('tavily')
    expect(s.providers.tavily.apiKey).toBe('tvly-1')
    expect(s.providers.serper.apiKey).toBe('')
  })

  it('activates a BYOK search provider only with a key', () => {
    expect(activeSearchProvider({ search: undefined })).toBe('genspark')
    expect(
      activeSearchProvider({
        search: {
          provider: 'serper',
          providers: {
            serper: { apiKey: '' },
            serply: { apiKey: '' },
            tavily: { apiKey: '' },
            parallel: { apiKey: '' },
          },
        },
      }),
    ).toBe('genspark')
    expect(
      activeSearchProvider({
        search: {
          provider: 'serper',
          providers: {
            serper: { apiKey: 'k' },
            serply: { apiKey: '' },
            tavily: { apiKey: '' },
            parallel: { apiKey: '' },
          },
        },
      }),
    ).toBe('serper')
    expect(
      activeSearchProvider({
        search: {
          provider: 'serper',
          providers: {
            serper: { apiKey: '   ' },
            serply: { apiKey: '' },
            tavily: { apiKey: '' },
            parallel: { apiKey: '' },
          },
        },
      }),
    ).toBe('genspark')
    expect(activeSearchProvider({ search: { provider: 'bing', providers: {} } as never })).toBe(
      'genspark',
    )
  })
})

describe('Serply search settings', () => {
  it('restores and trims a saved Serply key and activates it only with a key', () => {
    const settings = resolveAiSearchSettings({
      provider: 'serply',
      providers: { serply: { apiKey: ' serply-key ' } } as never,
    })
    expect(settings.provider).toBe('serply')
    expect(settings.providers.serply.apiKey).toBe('serply-key')
    expect(activeSearchProvider({ search: settings })).toBe('serply')
    expect(
      activeSearchProvider({
        search: { ...settings, providers: { ...settings.providers, serply: { apiKey: '  ' } } },
      }),
    ).toBe('genspark')
  })
})

describe('Parallel search settings', () => {
  it('restores and trims a saved Parallel key', () => {
    const settings = resolveAiSearchSettings(
      JSON.parse(
        JSON.stringify({
          provider: 'parallel',
          providers: { parallel: { apiKey: ' parallel-key ' } },
        }),
      ),
    )
    expect(settings.providers.parallel.apiKey).toBe('parallel-key')
    expect(activeSearchProvider({ search: settings })).toBe('parallel')
  })

  it('loads older settings without changing the selected provider or existing keys', () => {
    const settings = resolveAiSearchSettings(
      JSON.parse(
        JSON.stringify({
          provider: 'tavily',
          providers: { tavily: { apiKey: 'existing-key' } },
        }),
      ),
    )
    expect(activeSearchProvider({ search: settings })).toBe('tavily')
    expect(settings.providers.tavily.apiKey).toBe('existing-key')
    expect(settings.providers.parallel.apiKey).toBe('')
  })

  it('keeps Parallel selected for free search when the key is blank', () => {
    const settings = resolveAiSearchSettings(
      JSON.parse(
        JSON.stringify({
          provider: 'parallel',
          providers: { parallel: { apiKey: '   ' } },
        }),
      ),
    )
    expect(activeSearchProvider({ search: settings })).toBe('parallel')
  })
})

describe('local CLI search settings', () => {
  it('activates the local CLI providers without a key', () => {
    for (const provider of ['local-cli', 'mmx', 'antigravity'] as const) {
      expect(
        activeSearchProvider({
          search: { ...defaultAiSearchSettings(), provider },
        }),
      ).toBe(provider)
    }
    expect(
      activeSearchProvider({ search: { ...defaultAiSearchSettings(), provider: 'genspark' } }),
    ).toBe('genspark')
  })

  it('keeps a stored local provider through resolution', () => {
    const settings = resolveAiSearchSettings(
      JSON.parse(JSON.stringify({ provider: 'mmx', providers: {} })),
    )
    expect(settings.provider).toBe('mmx')
    expect(activeSearchProvider({ search: settings })).toBe('mmx')
  })
})
