import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGY_NO_VIDEO,
  agyDescribe,
  agyGenerateImage,
  agySearch,
  agyTranscribe,
  agyVideoGenerate,
  defaultMmxVoice,
  isGroundingRedirectUrl,
  isDomesticQuery,
  localCliStatus,
  mmxDescribe,
  mmxGenerateImage,
  mmxSearch,
  mmxSynthesize,
  mmxTranscribe,
  mmxVideoGenerate,
  parseLastJsonObject,
  parseLooseJson,
  pickSearchProvider,
  resolveAgyPath,
  resolveMmxInvocation,
  setAgyRedirectResolver,
  setLocalCliRunner,
  stripCodeFences,
  stripAgyStagingRefs,
  testLocalCliMedia,
  type LocalCliSpawnResult,
} from '../src/local-cli'
import {
  analyzeMediaTool,
  generateImageTool,
  generateVideoTool,
  transcribeAudioTool,
} from '../src/media-tools'
import { webSearch } from '../src/index'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const PNG_B64 = PNG.toString('base64')
const FENCE = String.fromCharCode(96, 96, 96)

const savedEnv: Record<string, string | undefined> = {}
let dummyBin = ''

// Every temp dir a test makes is tracked here and removed in afterEach.
const ownedDirs: string[] = []
function ownedDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  ownedDirs.push(dir)
  return dir
}
function rmrf(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // best effort only
  }
}

function okResult(stdout: string): LocalCliSpawnResult {
  return { stdout, stderr: '', exitCode: 0, timedOut: false }
}

function agyEnvelope(response: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    conversation_id: 'conv-1',
    status: 'SUCCESS',
    response,
    duration_seconds: 1.2,
    num_turns: 1,
    ...extra,
  })
}

beforeEach(() => {
  for (const k of ['GENOFFICE_AGY_PATH', 'GENOFFICE_MMX_PATH', 'MINIMAX_API_KEY', 'MMX_CONFIG_DIR']) {
    savedEnv[k] = process.env[k]
  }
  const dir = ownedDir('genoffice-localcli-')
  dummyBin = join(dir, 'dummy')
  writeFileSync(dummyBin, '')
  process.env.GENOFFICE_AGY_PATH = dummyBin
  process.env.GENOFFICE_MMX_PATH = dummyBin
  delete process.env.MINIMAX_API_KEY
  delete process.env.MMX_CONFIG_DIR
})

afterEach(() => {
  setLocalCliRunner(null)
  setAgyRedirectResolver(null)
  vi.restoreAllMocks()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  while (ownedDirs.length) rmrf(ownedDirs.pop() as string)
})

function localSettingsFile(mediaProvider: string): string {
  const dir = ownedDir('genoffice-localcli-settings-')
  const path = join(dir, 'ai-settings.json')
  writeFileSync(
    path,
    JSON.stringify({
      provider: 'genspark',
      providers: {},
      media: {
        imageProvider: mediaProvider,
        analysisProvider: mediaProvider,
        videoAnalysisProvider: mediaProvider,
        providers: {},
      },
      search: { provider: 'local-cli' },
    }),
  )
  return path
}

describe('isDomesticQuery', () => {
  it('treats Han characters as domestic', () => {
    expect(isDomesticQuery('深圳天气')).toBe(true)
    expect(isDomesticQuery('hello world')).toBe(false)
    expect(isDomesticQuery('GenOffice 下载')).toBe(true)
  })

  it('matches Chinese sites by domain, suffix and site: operator', () => {
    expect(isDomesticQuery('best pandas site:zhihu.com')).toBe(true)
    expect(isDomesticQuery('news on example.com.cn today')).toBe(true)
    expect(isDomesticQuery('watch on bilibili.com')).toBe(true)
    expect(isDomesticQuery('react docs site:example.com')).toBe(false)
    expect(isDomesticQuery('github release notes')).toBe(false)
    expect(isDomesticQuery('')).toBe(false)
  })
})

describe('pickSearchProvider', () => {
  it('lets an explicit override win', () => {
    expect(pickSearchProvider('hello', 'auto', 'mmx')).toBe('mmx')
    expect(pickSearchProvider('深圳天气', 'auto', 'intl')).toBe('antigravity')
    expect(pickSearchProvider('hello', 'auto', 'cn')).toBe('mmx')
    expect(pickSearchProvider('hello', 'auto', 'domestic')).toBe('mmx')
    expect(pickSearchProvider('hello', 'auto', 'foreign')).toBe('antigravity')
    expect(pickSearchProvider('深圳天气', 'auto', 'agy')).toBe('antigravity')
  })

  it('honours the settings routing, then auto by query', () => {
    expect(pickSearchProvider('hello', 'mmx')).toBe('mmx')
    expect(pickSearchProvider('深圳天气', 'antigravity')).toBe('antigravity')
    expect(pickSearchProvider('深圳天气', 'auto')).toBe('mmx')
    expect(pickSearchProvider('electron release notes', 'auto')).toBe('antigravity')
  })
})

describe('agy output parsing', () => {
  it('parses the last JSON object after a jetski notice line', () => {
    const stdout =
      'jetski: no output produced - permission denied\n' + agyEnvelope([{ title: 'A' }])
    expect(parseLastJsonObject(stdout)?.conversation_id).toBe('conv-1')
    expect(parseLastJsonObject('')).toBe(null)
    expect(parseLastJsonObject('not json at all')).toBe(null)
  })

  it('strips fences and finds the first JSON block defensively', () => {
    expect(stripCodeFences(FENCE + 'json\n[{"a":1}]\n' + FENCE)).toBe('[{"a":1}]')
    expect(parseLooseJson('here: [{"title":"T","url":"u","snippet":"s"}] bye')).toEqual([
      { title: 'T', url: 'u', snippet: 's' },
    ])
    expect(parseLooseJson('{"results":[],"answer":"x"} trailing')).toEqual({
      results: [],
      answer: 'x',
    })
    expect(parseLooseJson('no json here')).toBe(undefined)
  })
})

describe('agySearch', () => {
  it('returns results from a fenced array response', async () => {
    setLocalCliRunner(async (cmd) => {
      expect(basename(cmd)).toBe('dummy')
      return okResult(
        agyEnvelope(FENCE + 'json\n[{"title":"T","url":"https://t.com","snippet":"s"}]\n' + FENCE),
      )
    })
    const r = await agySearch('GenOffice', 6, null)
    expect(r.results).toEqual([{ title: 'T', url: 'https://t.com', snippet: 's' }])
    expect(r.answer).toBe(undefined)
  })

  it('reads the schema-shaped object response', async () => {
    setLocalCliRunner(async () =>
      okResult(
        agyEnvelope(JSON.stringify({ results: [{ title: 'T', url: 'u', snippet: '' }], answer: 'hi' })),
      ),
    )
    const r = await agySearch('q', 6, null)
    expect(r.results).toHaveLength(1)
    expect(r.answer).toBe('hi')
  })

  it('treats denied actions with an empty response as failure', async () => {
    setLocalCliRunner(async () =>
      okResult(agyEnvelope('', { denied_actions: [{ action: 'command', display_name: 'RunCommand' }] })),
    )
    await expect(agySearch('q', 6, null)).rejects.toThrow(/auto-denied/)
  })

  it('fails clearly when the binary is missing', async () => {
    process.env.GENOFFICE_AGY_PATH = '/nonexistent/agy-binary'
    await expect(agySearch('q', 6, null)).rejects.toThrow(/not found/)
  })
})

describe('mmxSearch', () => {
  it('maps organic results', async () => {
    setLocalCliRunner(async () =>
      okResult(JSON.stringify({ organic: [{ title: 'T', link: 'https://t.com', snippet: 's' }] })),
    )
    const r = await mmxSearch('深圳天气', 6, null)
    expect(r).toEqual({ results: [{ title: 'T', url: 'https://t.com', snippet: 's' }] })
  })

  it('surfaces API errors and the missing-credentials code', async () => {
    setLocalCliRunner(async () =>
      okResult(JSON.stringify({ error: { code: 3, message: 'No credentials found' } })),
    )
    await expect(mmxSearch('q', 1, null)).rejects.toThrow(/not logged in/)
    setLocalCliRunner(async () => okResult(JSON.stringify({ error: { code: 9, message: 'boom' } })))
    await expect(mmxSearch('q', 1, null)).rejects.toThrow(/boom/)
    setLocalCliRunner(async () => ({ stdout: '', stderr: 'bad args', exitCode: 1, timedOut: false }))
    await expect(mmxSearch('q', 1, null)).rejects.toThrow(/failed/)
  })
})

describe('local webSearch routing', () => {
  it('falls from agy to mmx for foreign queries and records the attempt', async () => {
    // both CLIs resolve to the same dummy binary in tests: tell them apart by argv
    setLocalCliRunner(async (_cmd, args) => {
      if (args.includes('-p')) {
        return okResult(agyEnvelope('', { denied_actions: [{ action: 'command' }] }))
      }
      return okResult(JSON.stringify({ organic: [{ title: 'T', link: 'https://t.com', snippet: 's' }] }))
    })
    const r = await webSearch('GenOffice', 3, {
      useGsk: false,
      localCli: { provider: 'local-cli', settings: null },
    })
    expect(r.method).toBe('mmx')
    expect(r.results).toHaveLength(1)
    expect(r.attempts).toHaveLength(1)
    expect(r.attempts?.[0]?.provider).toBe('antigravity')
  })

  it('routes domestic queries to mmx first with no attempts on success', async () => {
    const seen: string[][] = []
    setLocalCliRunner(async (_cmd, args) => {
      seen.push(args)
      return okResult(JSON.stringify({ organic: [{ title: 'T', link: 'https://t.com', snippet: 's' }] }))
    })
    const r = await webSearch('深圳天气', 3, {
      useGsk: false,
      localCli: { provider: 'local-cli', settings: null },
    })
    expect(r.method).toBe('mmx')
    expect(r.attempts).toEqual([])
    expect(seen[0]).toContain('search')
  })

  it('honours an explicit via override', async () => {
    const seen: string[][] = []
    setLocalCliRunner(async (_cmd, args) => {
      seen.push(args)
      if (args.includes('-p')) {
        return okResult(agyEnvelope('[{"title":"T","url":"https://t.com","snippet":"s"}]'))
      }
      return okResult(JSON.stringify({ organic: [] }))
    })
    const r = await webSearch('深圳天气', 3, {
      useGsk: false,
      localCli: { provider: 'local-cli', settings: null, via: 'agy' },
    })
    expect(r.method).toBe('antigravity')
    expect(r.results).toHaveLength(1)
    expect(seen[0]).toContain('-p')
  })
})

describe('image generation fallback', () => {
  it('falls from agy to mmx and stores the bytes', async () => {
    setLocalCliRunner(async (_cmd, args) => {
      const outIdx = args.indexOf('--out')
      if (outIdx !== -1) {
        writeFileSync(args[outIdx + 1] as string, PNG)
        return okResult(JSON.stringify({ saved: args[outIdx + 1] }))
      }
      // agy side: a valid envelope but no image file anywhere
      return okResult(agyEnvelope('/nope/missing.png'))
    })
    const r = await generateImageTool(localSettingsFile('antigravity'), { prompt: 'red apple icon' })
    expect(r.url).toMatch(/^file:/)
    expect(r.provider).toBe('mmx')
    expect(r.attempts).toHaveLength(1)
    expect(r.attempts?.[0]?.provider).toBe('antigravity')
  })

  it('finds the agy image the mocked runner drops in the temp cwd', async () => {
    setLocalCliRunner(async (_cmd, _args, opts) => {
      writeFileSync(join(opts.cwd as string, 'red_apple_icon_1.jpg'), PNG)
      return okResult(agyEnvelope('/some/stale/path.png'))
    })
    const bytes = await agyGenerateImage({ prompt: 'red apple' }, null)
    expect(bytes.mime).toBe('image/png')
    expect(bytes.bytes.length).toBe(PNG.length)
  })

  it('reports an error when neither side produces a file', async () => {
    // no --out write on either side: mmx fails reading its output file, agy finds nothing
    setLocalCliRunner(async () => okResult(agyEnvelope('/nope/missing.png')))
    const r = await generateImageTool(localSettingsFile('mmx'), { prompt: 'red apple icon' })
    expect(r.url).toBe(undefined)
    expect(r.error).toMatch(/antigravity/)
    expect(r.attempts).toHaveLength(2)
  })
})

describe('analysis fallback', () => {
  const dataUrl = 'data:image/png;base64,' + PNG_B64

  it('uses agy directly on success', async () => {
    setLocalCliRunner(async () => okResult(agyEnvelope('a red square icon')))
    const r = await analyzeMediaTool(localSettingsFile('antigravity'), {
      mediaUrls: [dataUrl],
      requirements: 'describe',
    })
    expect(r.text).toBe('a red square icon')
    expect(r.provider).toBe('antigravity')
    expect(r.attempts).toEqual([])
  })

  it('falls over to mmx for images when agy is denied', async () => {
    setLocalCliRunner(async (_cmd, args) => {
      if (args.includes('-p')) {
        return okResult(agyEnvelope('', { denied_actions: [{ action: 'command' }] }))
      }
      return okResult(JSON.stringify({ content: 'a red square' }))
    })
    const r = await analyzeMediaTool(localSettingsFile('antigravity'), {
      mediaUrls: [dataUrl],
      requirements: 'describe',
    })
    expect(r.text).toBe('a red square')
    expect(r.provider).toBe('mmx')
    expect(r.attempts?.map((a) => a.provider)).toEqual(['antigravity'])
  })

  it('reports the agy error for audio without trying mmx', async () => {
    const wav = 'data:audio/wav;base64,' + Buffer.from([0, 1, 2, 3]).toString('base64')
    setLocalCliRunner(async () => okResult(agyEnvelope('')))
    const r = await analyzeMediaTool(localSettingsFile('antigravity'), {
      mediaUrls: [wav],
      requirements: 'describe',
    })
    expect(r.text).toBe(undefined)
    expect(r.attempts?.map((a) => a.provider)).toEqual(['antigravity'])
    expect(r.error).toMatch(/antigravity/)
  })
})

describe('speech and video', () => {
  it('transcribes through agy, with mmx fallback on NO_AUDIO_ACCESS', async () => {
    const dir = ownedDir('genoffice-asr-')
    const audio = join(dir, 'a.wav')
    writeFileSync(audio, Buffer.from([0, 1, 2, 3]))
    setLocalCliRunner(async () => okResult(agyEnvelope('hello world')))
    expect(await agyTranscribe(audio, 'zh', null)).toBe('hello world')
    setLocalCliRunner(async (_cmd, args) => {
      if (args.includes('-p')) return okResult(agyEnvelope('NO_AUDIO_ACCESS'))
      return okResult(JSON.stringify({ text: 'fallback transcript' }))
    })
    const r = await transcribeAudioTool(localSettingsFile('antigravity'), { path: audio })
    expect(r.text).toBe('fallback transcript')
    expect(r.provider).toBe('mmx')
  })

  it('describes a single image through mmx', async () => {
    setLocalCliRunner(async () => okResult(JSON.stringify({ content: 'a cat' })))
    expect(await mmxDescribe('/tmp/x.png', 'what?', null)).toBe('a cat')
  })

  it('generates an image file through mmx and transcribes segments', async () => {
    setLocalCliRunner(async (_cmd, args) => {
      const outIdx = args.indexOf('--out')
      if (outIdx !== -1) writeFileSync(args[outIdx + 1] as string, PNG)
      return okResult(JSON.stringify({ ok: true }))
    })
    const image = await mmxGenerateImage({ prompt: 'apple', aspectRatio: '16:9' }, null)
    expect(image.mime).toBe('image/png')
    setLocalCliRunner(async () => okResult(JSON.stringify({ segments: [{ text: 'a' }, { text: 'b' }] })))
    expect(await mmxTranscribe('/tmp/a.wav', 'zh', null)).toBe('ab')
  })

  it('picks a Chinese voice for Han text only', () => {
    expect(defaultMmxVoice('你好', null)).toBe('male-qn-qingse')
    expect(defaultMmxVoice('hello world', null)).toBe(null)
    expect(defaultMmxVoice('hello', null)).toBe(null)
    expect(defaultMmxVoice('hello', { localCli: { ttsVoice: 'v' } } as never)).toBe('v')
  })

  it('synthesizes with the Chinese default voice and reads the bytes back', async () => {
    let seenArgs: string[] = []
    setLocalCliRunner(async (_cmd, args) => {
      seenArgs = [...args]
      writeFileSync(args[args.indexOf('--out') + 1] as string, Buffer.from([1, 2, 3, 4]))
      return okResult(JSON.stringify({ ok: true }))
    })
    const out = join(ownedDir('genoffice-tts-'), 'out.mp3')
    const r = await mmxSynthesize({ text: 'hello', out }, null)
    expect(r.bytes.length).toBe(4)
    expect(seenArgs).not.toContain('male-qn-qingse')
  })

  it('generates video through mmx async and refuses agy without the flag', async () => {
    setLocalCliRunner(async () => {
      throw new Error('must not spawn for agy video when disabled')
    })
    await expect(agyVideoGenerate({ prompt: 'x' }, null)).rejects.toThrow(AGY_NO_VIDEO)
    setLocalCliRunner(async () => okResult(JSON.stringify({ taskId: 't-1', status: 'queued' })))
    const r = await mmxVideoGenerate({ prompt: 'waves', async: true }, null)
    expect(r.taskId).toBe('t-1')
  })
})

describe('binary resolution and status', () => {
  it('honours explicit path overrides', () => {
    expect(resolveAgyPath(null)).toBe(dummyBin)
    expect(resolveMmxInvocation(null)?.cmd).toBe(dummyBin)
    expect(resolveMmxInvocation(null)?.via).toBe('mmx')
    process.env.GENOFFICE_AGY_PATH = '/nonexistent/agy'
    expect(resolveAgyPath(null)).toBe(null)
  })

  it('reports credentials without spawning or leaking', () => {
    expect(localCliStatus(null).mmx.credentials).toBe('missing')
    process.env.MINIMAX_API_KEY = 'secret-key'
    expect(localCliStatus(null).mmx.credentials).toBe('env')
    delete process.env.MINIMAX_API_KEY
    const dir = ownedDir('genoffice-mmxcfg-')
    process.env.MMX_CONFIG_DIR = dir
    expect(localCliStatus(null).mmx.credentials).toBe('missing')
    writeFileSync(join(dir, 'config.json'), '{}')
    expect(localCliStatus(null).mmx.credentials).toBe('config')
  })

  it('cheap-checks the local media backends', () => {
    expect(testLocalCliMedia('antigravity', null)).toEqual({ ok: true })
    process.env.GENOFFICE_AGY_PATH = '/nonexistent/agy'
    expect(testLocalCliMedia('antigravity', null).ok).toBe(false)
    expect(testLocalCliMedia('mmx', null).ok).toBe(false)
  })
})

describe('agyDescribe validation', () => {
  it('rejects empty input without spawning', async () => {
    setLocalCliRunner(async () => {
      throw new Error('must not spawn')
    })
    await expect(agyDescribe([], 'describe', null)).rejects.toThrow(/at least one/)
  })
})

describe('agySearch denied retry', () => {
  it('retries once with the same hands-off prompt after an empty denied answer', async () => {
    const prompts: string[] = []
    let calls = 0
    setLocalCliRunner(async (_cmd, args) => {
      calls++
      prompts.push(String(args[args.indexOf('-p') + 1] ?? ''))
      if (calls === 1) {
        return okResult(agyEnvelope('', { denied_actions: [{ action: 'command' }] }))
      }
      return okResult(agyEnvelope(JSON.stringify([{ title: 'T', url: 'https://t.com', snippet: 's' }])))
    })
    const r = await agySearch('GenOffice', 6, null)
    expect(calls).toBe(2)
    expect(r.results).toEqual([{ title: 'T', url: 'https://t.com', snippet: 's' }])
    expect(prompts[0]).toBe(prompts[1])
    expect(prompts[0]?.startsWith('Do not run any shell commands and do not open or resolve any URL; use only the search_web tool.')).toBe(true)
    expect(prompts[0]).toContain('Report each URL exactly as search_web returned it.')
  })

  it('fails after the retry when the answer stays empty', async () => {
    let calls = 0
    setLocalCliRunner(async () => {
      calls++
      return okResult(agyEnvelope('', { denied_actions: [{ action: 'command', display_name: 'RunCommand' }] }))
    })
    await expect(agySearch('q', 6, null)).rejects.toThrow(/auto-denied/)
    expect(calls).toBe(2)
  })

  it('does not retry a non-empty answer or a clean empty one', async () => {
    let calls = 0
    setLocalCliRunner(async () => {
      calls++
      return okResult(agyEnvelope('[]'))
    })
    await agySearch('q', 6, null)
    expect(calls).toBe(1)
  })
})

describe('staging refs from the media dir', () => {
  it('strips the exact live analyze link and its leading space', () => {
    const live =
      '[media-0.png](file:///tmp/genoffice-analyze-LWS36c/media-0.png) 展示了一个…'
    expect(stripAgyStagingRefs(live, [], ['/tmp/genoffice-analyze-LWS36c/media-0.png'])).toBe(
      '展示了一个…',
    )
    // the media dir itself works too, without the exact path
    expect(stripAgyStagingRefs(live, ['/tmp/genoffice-analyze-LWS36c'])).toBe('展示了一个…')
  })

  it('strips leading punctuation left at the start', () => {
    expect(stripAgyStagingRefs('， hello', [])).toBe('hello')
    expect(stripAgyStagingRefs('  spaced  out  ', [])).toBe('spaced out')
  })

  it('scrubs echoed staging paths from a real agyDescribe answer', async () => {
    const dataUrl = 'data:image/png;base64,' + PNG_B64
    setLocalCliRunner(async (_cmd, args) => {
      const prompt = String(args[args.indexOf('-p') + 1] ?? '')
      const staged = /(\/[^\s,]+)/.exec(prompt)?.[1] ?? 'missing'
      return okResult(agyEnvelope('[media-0.png](file://' + staged + ') 展示了一个…'))
    })
    const r = await agyDescribe([dataUrl], 'describe', null)
    expect(r).toBe('展示了一个…')
  })

  it('asks the agent not to mention file names or paths', async () => {
    const prompts: string[] = []
    setLocalCliRunner(async (_cmd, args) => {
      prompts.push(String(args[args.indexOf('-p') + 1] ?? ''))
      return okResult(agyEnvelope('some text'))
    })
    const dir = ownedDir('genoffice-agy-prompt-')
    const file = join(dir, 'a.wav')
    writeFileSync(file, Buffer.from([0, 1, 2, 3]))
    await agyDescribe([file], 'describe', null)
    await agyTranscribe(file, 'zh', null)
    expect(prompts).toHaveLength(2)
    for (const p of prompts) {
      expect(p).toContain('Do not mention file names or paths in your answer.')
    }
  })
})

describe('grounding redirect unwrapping', () => {
  const grounding =
    'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQabc123'

  it('recognises only the exact grounding host and path', () => {
    expect(isGroundingRedirectUrl(grounding)).toBe(true)
    expect(isGroundingRedirectUrl('https://vertexaisearch.cloud.google.com/other')).toBe(false)
    expect(isGroundingRedirectUrl('https://example.com/grounding-api-redirect/x')).toBe(false)
    expect(isGroundingRedirectUrl('not a url')).toBe(false)
  })

  it('replaces grounding URLs with the resolved source', async () => {
    setLocalCliRunner(async () =>
      okResult(
        agyEnvelope(
          JSON.stringify([{ title: 'T', url: grounding, snippet: 's' }]),
        ),
      ),
    )
    setAgyRedirectResolver(async (url) => {
      expect(url).toBe(grounding)
      return 'https://source.example/article'
    })
    const r = await agySearch('q', 6, null)
    expect(r.results[0]?.url).toBe('https://source.example/article')
  })

  it('keeps the original URL when resolving fails', async () => {
    setLocalCliRunner(async () =>
      okResult(agyEnvelope(JSON.stringify([{ title: 'T', url: grounding, snippet: 's' }]))),
    )
    setAgyRedirectResolver(async () => {
      throw new Error('no network')
    })
    const r = await agySearch('q', 6, null)
    expect(r.results[0]?.url).toBe(grounding)
  })
})

describe('mmx condensed errors', () => {
  it('condenses a JSON error blob without the hint paths', async () => {
    const blob = JSON.stringify({
      error: { code: 3, message: 'No credentials found', hint: '/very/long/path/blob ' + 'x'.repeat(500) },
    })
    setLocalCliRunner(async () => ({ stdout: blob, stderr: '', exitCode: 1, timedOut: false }))
    await expect(mmxSearch('q', 1, null)).rejects.toThrow(
      'MiniMax CLI (mmx): No credentials found (code 3) - mmx is not logged in and MINIMAX_API_KEY is not set',
    )
  })

  it('condenses non-credential errors with their code', async () => {
    setLocalCliRunner(async () =>
      okResult(JSON.stringify({ error: { code: 9, message: 'quota exhausted' } })),
    )
    await expect(mmxSearch('q', 1, null)).rejects.toThrow(
      'MiniMax CLI (mmx): quota exhausted (code 9)',
    )
  })

  it('falls back to the first stderr line, capped', async () => {
    const long = 'first problem line here\nsecond line\n' + 'z'.repeat(500)
    setLocalCliRunner(async () => ({ stdout: '', stderr: long, exitCode: 2, timedOut: false }))
    try {
      await mmxSearch('q', 1, null)
      expect.unreachable()
    } catch (err) {
      const message = (err as Error).message
      expect(message.startsWith('MiniMax CLI (mmx) failed: first problem line here')).toBe(true)
      expect(message.length).toBeLessThanOrEqual('MiniMax CLI (mmx) failed: '.length + 300 + 1)
    }
  })
})

describe('agy staging-ref cleanup', () => {
  it('drops temp-dir markdown links, empty parens and media markers', () => {
    const dir = '/tmp/genoffice-analyze-ABC123'
    const text =
      '[media: {"mime_type":"image/png"}] 一只猫矢量插画（[media-0.png](file://' +
      dir +
      '/media-0.png)）。 See [docs](https://example.com/x).'
    expect(stripAgyStagingRefs(text, [dir])).toBe(
      '一只猫矢量插画。 See [docs](https://example.com/x).',
    )
  })

  it('drops ascii empty parens left behind and collapses spaces', () => {
    expect(stripAgyStagingRefs('a cat (file) ([x](/tmp/genoffice-agy-Z/img.png)) end', ['/tmp/genoffice-agy-Z'])).toBe(
      'a cat (file) end',
    )
  })

  it('leaves text without staging refs alone', () => {
    expect(stripAgyStagingRefs('  plain answer  ', ['/tmp/genoffice-agy-Z'])).toBe('plain answer')
  })
})

describe('temp-dir cleanup', () => {
  const helperPrefixes = [
    'genoffice-agy-',
    'genoffice-analyze-',
    'genoffice-asr-',
    'genoffice-mmx-',
    'genoffice-imgref-',
  ]

  function helperDirs(): string[] {
    let entries: string[]
    try {
      entries = readdirSync(tmpdir())
    } catch {
      return []
    }
    return entries.filter((n) => helperPrefixes.some((p) => n.startsWith(p)))
  }

  it('leaves no helper staging dirs behind', async () => {
    const before = new Set(helperDirs())
    setLocalCliRunner(async (_cmd, args, opts) => {
      if (args.includes('video')) return okResult(JSON.stringify({ taskId: 't-9', status: 'queued' }))
      const outIdx = args.indexOf('--out')
      if (outIdx !== -1) writeFileSync(args[outIdx + 1] as string, PNG)
      if (opts.cwd) writeFileSync(join(opts.cwd, 'gen.png'), PNG)
      return okResult(agyEnvelope('a red square'))
    })
    const dataUrl = 'data:image/png;base64,' + PNG_B64
    await agyDescribe([dataUrl], 'describe', null)
    await agyTranscribe(dataUrl, 'zh', null)
    await agyGenerateImage({ prompt: 'x' }, null)
    await mmxGenerateImage({ prompt: 'x' }, null)
    await generateImageTool(localSettingsFile('antigravity'), { prompt: 'x' })
    await analyzeMediaTool(localSettingsFile('antigravity'), {
      mediaUrls: [dataUrl],
      requirements: 'describe',
    })
    await generateVideoTool(localSettingsFile('antigravity'), { prompt: 'x', async: true })
    const leaked = helperDirs().filter((n) => !before.has(n))
    expect(leaked).toEqual([])
  })
})

describe('video agy skip note', () => {
  it('records the antigravity skip before the mmx attempt', async () => {
    setLocalCliRunner(async () => okResult(JSON.stringify({ taskId: 't-9', status: 'queued' })))
    const r = await generateVideoTool(localSettingsFile('antigravity'), {
      prompt: 'waves',
      async: true,
    })
    expect(r.taskId).toBe('t-9')
    expect(r.provider).toBe('mmx')
    expect(r.attempts?.[0]).toEqual({
      provider: 'antigravity',
      error: 'skipped: agy has no video generation tool (localCli.agyVideo=false)',
    })
  })
})
