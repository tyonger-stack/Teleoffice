import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'

vi.mock('../src/gsk', () => ({
  gskGenerateImage: vi.fn(),
  gskAnalyzeMedia: vi.fn(),
  hasGskAuth: vi.fn(() => true),
}))

import { generateImageTool, analyzeMediaTool, GSK_RMBG_MODEL } from '../src/media-tools'
import { gskGenerateImage, gskAnalyzeMedia } from '../src/gsk'

const gskGen = vi.mocked(gskGenerateImage)
const gskAnalyze = vi.mocked(gskAnalyzeMedia)
// Explicit Genspark media settings: the app defaults now select the local
// CLIs, so the Genspark route needs its providers spelled out.
function gensparkSettingsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'genoffice-media-test-'))
  const path = join(dir, 'ai-settings.json')
  writeFileSync(
    path,
    JSON.stringify({
      provider: 'genspark',
      providers: {},
      media: {
        imageProvider: 'genspark',
        analysisProvider: 'genspark',
        videoAnalysisProvider: 'genspark',
        providers: {},
      },
    }),
  )
  return path
}
const SETTINGS = gensparkSettingsFile()

beforeEach(() => {
  gskGen.mockReset()
  gskAnalyze.mockReset()
})

afterAll(() => {
  try {
    rmSync(dirname(SETTINGS), { recursive: true, force: true })
  } catch {
    // best effort only
  }
})

describe('generateImageTool transparentBackground (Genspark route)', () => {
  it('chains a fal-bria-rmbg pass over the generated image and returns the stripped URL', async () => {
    gskGen
      .mockResolvedValueOnce({ url: 'https://cdn/x/opaque.png', taskId: '1' })
      .mockResolvedValueOnce({ url: 'https://cdn/x/cutout.png', taskId: '2' })
    const r = await generateImageTool(SETTINGS, {
      prompt: 'red podcast icon',
      transparentBackground: true,
    })
    expect(r.url).toBe('https://cdn/x/cutout.png')
    expect(gskGen).toHaveBeenCalledTimes(2)
    expect(gskGen.mock.calls[1]![0]).toMatchObject({
      model: GSK_RMBG_MODEL,
      referenceImageUrls: ['https://cdn/x/opaque.png'],
    })
  })

  it('without the flag generation stays a single pass', async () => {
    gskGen.mockResolvedValueOnce({ url: 'https://cdn/x/opaque.png', taskId: '1' })
    const r = await generateImageTool(SETTINGS, { prompt: 'red podcast icon' })
    expect(r.url).toBe('https://cdn/x/opaque.png')
    expect(gskGen).toHaveBeenCalledTimes(1)
  })

  it('does not chain when the caller already runs the background-removal model', async () => {
    gskGen.mockResolvedValueOnce({ url: 'https://cdn/x/cutout.png', taskId: '1' })
    const r = await generateImageTool(SETTINGS, {
      prompt: 'remove background',
      model: GSK_RMBG_MODEL,
      referenceImageUrls: ['https://cdn/x/src.png'],
      transparentBackground: true,
    })
    expect(r).toEqual({ url: 'https://cdn/x/cutout.png' })
    expect(gskGen).toHaveBeenCalledTimes(1)
  })

  it('falls back to the opaque image when the strip pass fails', async () => {
    gskGen
      .mockResolvedValueOnce({ url: 'https://cdn/x/opaque.png', taskId: '1' })
      .mockRejectedValueOnce(new Error('rmbg down'))
    const r = await generateImageTool(SETTINGS, {
      prompt: 'red podcast icon',
      transparentBackground: true,
    })
    expect(r.url).toBe('https://cdn/x/opaque.png')
  })

  it('a generation failure still surfaces as an error (no half-run chain)', async () => {
    gskGen.mockRejectedValueOnce(new Error('quota exceeded'))
    const r = await generateImageTool(SETTINGS, {
      prompt: 'red podcast icon',
      transparentBackground: true,
    })
    expect(r).toEqual({ error: 'quota exceeded' })
    expect(gskGen).toHaveBeenCalledTimes(1)
  })
})

describe('generateImageTool reference budget (Genspark route)', () => {
  it('rejects too many reference images with the BYOK wording, before calling the CLI', async () => {
    gskGen.mockResolvedValue({ url: 'https://cdn/x/out.png', taskId: '1' })
    const referenceImageUrls = Array.from({ length: 13 }, (_, i) => `https://cdn/x/${i}.png`)
    const r = await generateImageTool(SETTINGS, { prompt: 'red podcast icon', referenceImageUrls })
    expect(r).toEqual({
      error: 'Too many media items in one request (13, limit 12); analyze them in smaller batches',
    })
    expect(gskGen).not.toHaveBeenCalled()
  })

  it('still passes a reference count within the budget to the CLI', async () => {
    gskGen.mockResolvedValueOnce({ url: 'https://cdn/x/out.png', taskId: '1' })
    const referenceImageUrls = Array.from({ length: 12 }, (_, i) => `https://cdn/x/${i}.png`)
    const r = await generateImageTool(SETTINGS, { prompt: 'red podcast icon', referenceImageUrls })
    expect(r).toEqual({ url: 'https://cdn/x/out.png' })
    expect(gskGen).toHaveBeenCalledTimes(1)
  })
})

describe('analyzeMediaTool media budget (Genspark route)', () => {
  it('rejects too many media URLs with the BYOK wording, before calling the CLI', async () => {
    gskAnalyze.mockResolvedValueOnce('done')
    const mediaUrls = Array.from({ length: 13 }, (_, i) => `https://cdn/x/${i}.png`)
    const r = await analyzeMediaTool(SETTINGS, { mediaUrls, requirements: 'describe these' })
    expect(r).toEqual({
      error: 'Too many media items in one request (13, limit 12); analyze them in smaller batches',
    })
    expect(gskAnalyze).not.toHaveBeenCalled()
  })
})
