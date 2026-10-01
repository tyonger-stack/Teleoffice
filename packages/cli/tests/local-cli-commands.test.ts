import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as aiSearch from '@teleoffice/ai-search'
import { run, tempDir as makeTempDir } from './helpers'

// Every temp dir a test makes is removed in afterEach (no /tmp leaks).
const ownedDirs: string[] = []
function tempDir(): string {
  const dir = makeTempDir()
  ownedDirs.push(dir)
  return dir
}

// New local-CLI commands (tts / asr / video) plus search --via/--region.
// The ai-search tools are stubbed: these tests cover CLI plumbing only.
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of [
    'TELEOFFICE_AUTH_DIR',
    'TELEOFFICE_AI_SETTINGS',
    'AI_SEARCH_DISABLE_GSK',
    'TELEOFFICE_AGY_PATH',
    'TELEOFFICE_MMX_PATH',
    'MINIMAX_API_KEY',
  ])
    saved[k] = process.env[k]
  process.env.TELEOFFICE_AUTH_DIR = join(tempDir(), 'no-auth')
  process.env.AI_SEARCH_DISABLE_GSK = '1'
  process.env.TELEOFFICE_AGY_PATH = join(tempDir(), 'no-agy')
  process.env.TELEOFFICE_MMX_PATH = join(tempDir(), 'no-mmx')
  delete process.env.MINIMAX_API_KEY
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

function settingsFile(dir: string): string {
  const path = join(dir, 'ai-settings.json')
  writeFileSync(path, JSON.stringify({ provider: 'anthropic', providers: {} }))
  return path
}

describe('teleoffice search --via/--region', () => {
  it('passes the backend override through to web search', async () => {
    const dir = tempDir()
    const web = vi
      .spyOn(aiSearch, 'webSearchTool')
      .mockResolvedValue({ results: [], method: 'mmx', attempts: [] })
    const settings = settingsFile(dir)
    const env = { ...process.env, TELEOFFICE_AI_SETTINGS: settings }
    const r = await run(['search', 'hello', '--via', 'agy', '--json'], { env })
    expect(r.code).toBe(0)
    expect(web).toHaveBeenCalledWith(settings, 'hello', 6, { via: 'agy' })
    expect(r.json().detail.method).toBe('mmx')
    expect(r.json().detail.attempts).toEqual([])
    const r2 = await run(['search', 'hello', '--region', 'cn', '--json'], { env })
    expect(r2.code).toBe(0)
    expect(web).toHaveBeenLastCalledWith(settings, 'hello', 6, { via: 'cn' })
  })

  it('rejects an unknown backend', async () => {
    const r = await run(['search', 'hello', '--via', 'mars', '--json'], {
      env: { ...process.env },
    })
    expect(r.code).toBe(1)
    expect(r.json().message).toMatch(/--via/)
  })
})

describe('teleoffice tts', () => {
  it('synthesizes to the requested file', async () => {
    const dir = tempDir()
    const out = join(dir, 'hello.mp3')
    const synth = vi
      .spyOn(aiSearch, 'synthesizeSpeechTool')
      .mockImplementation(async (_settings, op) => ({
        path: op.out as string,
        bytes: new Uint8Array([1, 2, 3]),
        provider: 'mmx',
      }))
    const settings = settingsFile(dir)
    const r = await run(
      ['tts', 'hello', '--out', out, '--voice', 'v', '--format', 'mp3', '--json'],
      { cwd: dir, env: { ...process.env, TELEOFFICE_AI_SETTINGS: settings } },
    )
    expect(r.code).toBe(0)
    expect(synth).toHaveBeenCalledWith(
      settings,
      expect.objectContaining({ text: 'hello', out, voice: 'v', format: 'mp3' }),
    )
    expect(r.json().output_path).toBe(out)
    expect(r.json().detail.provider).toBe('mmx')
  })

  it('warns when the output extension disagrees with the format', async () => {
    const dir = tempDir()
    const out = join(dir, 'hello.wav')
    vi.spyOn(aiSearch, 'synthesizeSpeechTool').mockImplementation(async (_settings, op) => ({
      path: op.out as string,
      bytes: new Uint8Array([1, 2, 3]),
      provider: 'mmx',
    }))
    const settings = settingsFile(dir)
    const r = await run(['tts', 'hello', '--out', out, '--format', 'mp3', '--json'], {
      cwd: dir,
      env: { ...process.env, TELEOFFICE_AI_SETTINGS: settings },
    })
    expect(r.code).toBe(0)
    expect(r.json().warnings?.[0]?.code).toBe('format_mismatch')
  })

  it('rejects an unknown format', async () => {
    const r = await run(['tts', 'hello', '--format', 'ogg2', '--json'], {
      env: { ...process.env },
    })
    expect(r.code).toBe(1)
  })
})

describe('teleoffice asr', () => {
  it('prints the transcript with provider detail', async () => {
    const dir = tempDir()
    const audio = join(dir, 'a.wav')
    writeFileSync(audio, Buffer.from([0, 1, 2, 3]))
    vi.spyOn(aiSearch, 'transcribeAudioTool').mockResolvedValue({
      text: 'hello world',
      provider: 'antigravity',
      attempts: [],
    })
    const settings = settingsFile(dir)
    const r = await run(['asr', audio, '--json'], {
      env: { ...process.env, TELEOFFICE_AI_SETTINGS: settings },
    })
    expect(r.code).toBe(0)
    expect(r.json().summary).toBe('hello world')
    expect(r.json().detail.provider).toBe('antigravity')
  })
})

describe('teleoffice video', () => {
  it('generates to a file and reports the task', async () => {
    const dir = tempDir()
    const out = join(dir, 'clip.mp4')
    const gen = vi.spyOn(aiSearch, 'generateVideoTool').mockResolvedValue({
      path: out,
      taskId: 't-1',
      status: 'done',
      provider: 'mmx',
      attempts: [],
    })
    const settings = settingsFile(dir)
    const r = await run(['video', 'waves', '--out', out, '--json'], {
      env: { ...process.env, TELEOFFICE_AI_SETTINGS: settings },
    })
    expect(r.code).toBe(0)
    expect(gen).toHaveBeenCalledWith(settings, expect.objectContaining({ prompt: 'waves', out }))
    expect(r.json().output_path).toBe(out)
    expect(r.json().detail.task_id).toBe('t-1')
  })

  it('queries a task and downloads a file', async () => {
    const dir = tempDir()
    const settings = settingsFile(dir)
    const env = { ...process.env, TELEOFFICE_AI_SETTINGS: settings }
    vi.spyOn(aiSearch, 'videoTaskTool').mockResolvedValue({
      result: { task_id: 't-1', status: 'done' },
      provider: 'mmx',
    })
    const status = await run(['video', '--task', 't-1', '--json'], { env })
    expect(status.code).toBe(0)
    expect(status.json().detail.task_id).toBe('t-1')
    const out = join(dir, 'clip.mp4')
    vi.spyOn(aiSearch, 'videoDownloadTool').mockImplementation(async (_s, op) => {
      writeFileSync(op.out, Buffer.from([9]))
      return { path: op.out, provider: 'mmx' }
    })
    const dl = await run(['video', '--file-id', 'f-1', '--out', out, '--json'], { env })
    expect(dl.code).toBe(0)
    expect(dl.json().output_path).toBe(out)
  })
})
