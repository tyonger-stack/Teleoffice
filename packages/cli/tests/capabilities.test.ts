import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as aiSearch from '@genoffice/ai-search'
import { run, tempDir as makeTempDir } from './helpers'

// Every temp dir a test makes is removed in afterEach (no /tmp leaks).
const ownedDirs: string[] = []
function tempDir(): string {
  const dir = makeTempDir()
  ownedDirs.push(dir)
  return dir
}

// hasGskAuth reads process.env, not the command context: isolate the login state per test
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of [
    'GENOFFICE_AUTH_DIR',
    'AI_SEARCH_DISABLE_GSK',
    'GENOFFICE_AGY_PATH',
    'GENOFFICE_MMX_PATH',
    'MINIMAX_API_KEY',
    'MMX_CONFIG_DIR',
  ])
    saved[k] = process.env[k]
  process.env.GENOFFICE_AUTH_DIR = join(tempDir(), 'no-auth')
  process.env.AI_SEARCH_DISABLE_GSK = '1'
  // the local CLI defaults would otherwise pick up real binaries on this machine
  process.env.GENOFFICE_AGY_PATH = join(tempDir(), 'no-agy')
  process.env.GENOFFICE_MMX_PATH = join(tempDir(), 'no-mmx')
  delete process.env.MINIMAX_API_KEY
  process.env.MMX_CONFIG_DIR = join(tempDir(), 'no-mmx-config')
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  while (ownedDirs.length) {
    try {
      rmSync(ownedDirs.pop() as string, { recursive: true, force: true })
    } catch {
      // best effort only
    }
  }
})

// a real settings file always carries the chat provider block; without it every section resets to defaults
function settingsFile(dir: string, settings: Record<string, unknown>): string {
  const path = join(dir, 'ai-settings.json')
  writeFileSync(path, JSON.stringify({ provider: 'anthropic', providers: {}, ...settings }))
  return path
}

describe('genoffice capabilities', () => {
  it('reports nothing configured when signed out with default settings', async () => {
    const dir = tempDir()
    const r = await run(['capabilities', '--json'], {
      env: {
        ...process.env,
        GENOFFICE_AI_SETTINGS: join(dir, 'missing.json'),
        GENOFFICE_APP_BIN: '',
      },
    })
    expect(r.code).toBe(0)
    const d = r.json().detail
    expect(d.search.available).toBe(false)
    expect(d.image_search.available).toBe(false)
    expect(d.image_generation.available).toBe(false)
    expect(d.media_analysis.available).toBe(false)
  })

  it('counts a Serper key as search + image search and a BYOK image model as generation', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'bin'))
    const settings = settingsFile(dir, {
      search: {
        provider: 'serper',
        providers: { serper: { apiKey: 'k' }, tavily: { apiKey: '' } },
      },
      media: {
        imageProvider: 'openai',
        providers: { openai: { apiKey: 'sk', imageModel: 'gpt-image-1' } },
      },
    })
    const r = await run(['capabilities', '--json'], {
      env: {
        ...process.env,
        GENOFFICE_AI_SETTINGS: settings,
        GENOFFICE_APP_BIN: join(dir, 'bin', 'app'),
      },
    })
    expect(r.code).toBe(0)
    const d = r.json().detail
    expect(d.search).toEqual({ available: true, via: 'serper' })
    expect(d.image_search).toEqual({ available: true, via: 'serper' })
    expect(d.image_generation).toEqual({ available: true, via: 'openai' })
    expect(d.media_analysis.available).toBe(false)
    expect(d.app.available).toBe(true)
    expect(r.json().summary).toContain('image_generation')
  })

  it('counts a Serply key as search + image search', async () => {
    const settings = settingsFile(tempDir(), {
      search: { provider: 'serply', providers: { serply: { apiKey: 'k' } } },
    })
    const r = await run(['capabilities', '--json'], {
      env: { ...process.env, GENOFFICE_AI_SETTINGS: settings },
    })
    const d = r.json().detail
    expect(d.search).toEqual({ available: true, via: 'serply' })
    expect(d.image_search).toEqual({ available: true, via: 'serply' })
  })

  it.each(['tavily', 'parallel'])('%s gives web search but no image search', async (provider) => {
    const dir = tempDir()
    const settings = settingsFile(dir, {
      search: {
        provider,
        providers: { [provider]: { apiKey: 'test-key' } },
      },
    })
    const r = await run(['capabilities', '--json'], {
      env: { ...process.env, GENOFFICE_AI_SETTINGS: settings },
    })
    const d = r.json().detail
    expect(d.search).toEqual({ available: true, via: provider })
    expect(d.image_search.available).toBe(false)
  })

  it.each(['tavily', 'parallel'])(
    '%s does not advertise Genspark image search when signed in',
    async (provider) => {
      vi.spyOn(aiSearch, 'hasGskAuth').mockReturnValue(true)
      const settings = settingsFile(tempDir(), {
        search: { provider, providers: { [provider]: { apiKey: 'test-key' } } },
        media: {
          imageProvider: 'genspark',
          analysisProvider: 'genspark',
          videoAnalysisProvider: 'genspark',
          providers: {},
        },
      })
      const r = await run(['capabilities', '--json'], {
        env: { ...process.env, GENOFFICE_AI_SETTINGS: settings },
      })
      const d = r.json().detail
      expect(d.search).toEqual({ available: true, via: provider })
      expect(d.image_search).toEqual({ available: false, via: null })
      expect(d.image_generation).toEqual({ available: true, via: 'genspark' })
      expect(d.media_analysis).toEqual({ available: true, via: 'genspark' })
    },
  )

  it('reports selected keyless Parallel as web search without requiring a login', async () => {
    const settings = settingsFile(tempDir(), {
      search: { provider: 'parallel', providers: { parallel: { apiKey: '' } } },
    })
    const r = await run(['capabilities', '--json'], {
      env: { ...process.env, GENOFFICE_AI_SETTINGS: settings },
    })
    expect(r.json().detail.search).toEqual({ available: true, via: 'parallel' })
    expect(r.json().detail.image_search).toEqual({ available: false, via: null })
  })

  it('reports the local CLIs with routing labels and binary gates', async () => {
    const dir = tempDir()
    const agy = join(dir, 'agy')
    const mmx = join(dir, 'mmx')
    writeFileSync(agy, '')
    writeFileSync(mmx, '')
    const settings = settingsFile(dir, {})
    // local CLI resolution reads process.env (like the gsk login state)
    process.env.GENOFFICE_AGY_PATH = agy
    process.env.GENOFFICE_MMX_PATH = mmx
    process.env.MINIMAX_API_KEY = 'test-key'
    const r = await run(['capabilities', '--json'], {
      env: {
        ...process.env,
        GENOFFICE_AI_SETTINGS: settings,
      },
    })
    expect(r.code).toBe(0)
    const d = r.json().detail
    expect(d.search).toEqual({
      available: true,
      via: 'local-cli (mmx for Chinese / antigravity for foreign)',
    })
    expect(d.image_generation).toEqual({
      available: true,
      via: 'antigravity',
      fallback: 'mmx',
    })
    expect(d.media_analysis).toEqual({
      available: true,
      via: 'antigravity',
      fallback: 'mmx',
    })
    expect(d.tts).toEqual({ available: true, via: 'mmx' })
    expect(d.asr).toEqual({ available: true, via: 'antigravity', fallback: 'mmx' })
    expect(d.video_generation).toEqual({
      available: true,
      via: 'mmx',
      fallback: null,
      note: 'Antigravity CLI (agy 1.2.13) has no video generation tool; set localCli.agyVideo=true to try it first',
    })
    expect(d.local_cli.agy).toEqual({ path: agy, found: true })
    expect(d.local_cli.mmx).toMatchObject({ path: mmx, found: true, via: 'mmx' })
    expect(d.local_cli.mmx.credentials).toBe('env')
    expect(r.json().summary).toContain('tts')
  })

  it('tries agy first for video only with the agyVideo opt-in', async () => {
    const dir = tempDir()
    const agy = join(dir, 'agy')
    writeFileSync(agy, '')
    const settings = settingsFile(dir, {
      localCli: {
        agyPath: '',
        mmxPath: '',
        agyModel: '',
        agyTimeoutSec: 300,
        mmxRegion: 'cn',
        searchRouting: 'auto',
        fallback: true,
        agyVideo: true,
        ttsVoice: '',
        asrLanguage: 'zh',
      },
    })
    process.env.GENOFFICE_AGY_PATH = agy
    const r = await run(['capabilities', '--json'], {
      env: { ...process.env, GENOFFICE_AI_SETTINGS: settings },
    })
    expect(r.json().detail.video_generation).toEqual({
      available: true,
      via: 'antigravity',
      // mmx has no binary in this test, so no fallback is named
      fallback: null,
    })
  })

  it('marks mmx features unavailable without credentials', async () => {
    const dir = tempDir()
    const agy = join(dir, 'agy')
    writeFileSync(agy, '')
    const settings = settingsFile(dir, {
      search: { provider: 'mmx' },
    })
    process.env.GENOFFICE_AGY_PATH = agy
    const r = await run(['capabilities', '--json'], {
      env: {
        ...process.env,
        GENOFFICE_AI_SETTINGS: settings,
      },
    })
    const d = r.json().detail
    expect(d.search).toEqual({ available: false, via: null })
    expect(d.tts).toEqual({ available: false, via: null })
    expect(d.local_cli.mmx.credentials).toBe('missing')
    expect(d.local_cli.mmx.hint).toMatch(/MINIMAX_API_KEY/)
  })

  it('reports Genspark as the effective via when the local binaries are missing', async () => {
    vi.spyOn(aiSearch, 'hasGskAuth').mockReturnValue(true)
    const settings = settingsFile(tempDir(), {})
    const r = await run(['capabilities', '--json'], {
      env: { ...process.env, GENOFFICE_AI_SETTINGS: settings },
    })
    const d = r.json().detail
    expect(d.search).toEqual({ available: true, via: 'genspark' })
    expect(d.image_generation).toEqual({ available: true, via: 'genspark' })
    expect(d.media_analysis).toEqual({ available: true, via: 'genspark' })
    // tts has no Genspark equivalent: still gated on the mmx binary
    expect(d.tts).toEqual({ available: false, via: null })
  })

  it('keeps the local via when a binary exists even while signed in to Genspark', async () => {
    vi.spyOn(aiSearch, 'hasGskAuth').mockReturnValue(true)
    const dir = tempDir()
    const agy = join(dir, 'agy')
    writeFileSync(agy, '')
    process.env.GENOFFICE_AGY_PATH = agy
    const settings = settingsFile(dir, {})
    const r = await run(['capabilities', '--json'], {
      env: { ...process.env, GENOFFICE_AI_SETTINGS: settings },
    })
    const d = r.json().detail
    expect(d.image_generation.via).toBe('antigravity')
    expect(d.media_analysis.via).toBe('antigravity')
  })
})
