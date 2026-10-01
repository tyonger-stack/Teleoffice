// Local CLI runtime: the Antigravity CLI (agy) and the MiniMax CLI (mmx) as
// GenOffice search / image / media backends.
//
// Node-only: child_process.spawn with an args array (never a shell string),
// no Electron imports - this file runs inside the genoffice CLI bundle AND
// the Electron main process. stdin is ignored. stdout/stderr are captured
// with size caps; a timeout kills the child with SIGTERM, then SIGKILL.
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative } from 'node:path'
import {
  defaultAiLocalCliSettings,
  type AiLocalCliSettings,
  type AiSettings,
} from '@genoffice/ai-provider'
import type { WebSearchResult } from './shared'

export type LocalCliSettingsInput = Pick<AiSettings, 'localCli'> | null | undefined

// Effective local CLI settings (stored block over defaults; tolerant of hand edits).
function eff(settings: LocalCliSettingsInput): AiLocalCliSettings {
  const stored = settings?.localCli
  const d = defaultAiLocalCliSettings()
  if (!stored || typeof stored !== 'object') return d
  return { ...d, ...stored }
}

function agyTimeoutMs(settings: LocalCliSettingsInput): { ms: number; sec: number } {
  const raw = eff(settings).agyTimeoutSec
  const sec = Number.isFinite(raw) && (raw as number) > 0 ? Math.floor(raw as number) : 300
  return { ms: Math.max(1, sec) * 1000, sec: Math.max(1, sec) }
}

// -- spawn ----------------------------------------------------------

export interface LocalCliSpawnResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

export interface LocalCliSpawnOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
}

export type LocalCliRunner = (
  cmd: string,
  args: string[],
  opts: LocalCliSpawnOptions,
) => Promise<LocalCliSpawnResult>

// stdout/stderr capture cap each (large JSON envelopes stay well under this).
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const SIGKILL_GRACE_MS = 3000

function appendCapped(current: string, chunk: Buffer, budget: number): string {
  const used = Buffer.byteLength(current, 'utf8')
  if (used >= budget) return current
  return current + chunk.toString('utf8').slice(0, Math.max(0, budget - used))
}

async function defaultRunner(
  cmd: string,
  args: string[],
  opts: LocalCliSpawnOptions,
): Promise<LocalCliSpawnResult> {
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let stdout = ''
    let stderr = ''
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({ stdout, stderr, exitCode, timedOut })
    }
    let child: ReturnType<typeof spawn> | undefined
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: null,
        timedOut: false,
      })
      return
    }
    const proc = child
    const timer = setTimeout(() => {
      timedOut = true
      try {
        proc.kill('SIGTERM')
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          // already gone
        }
      }, SIGKILL_GRACE_MS)
    }, Math.max(250, opts.timeoutMs))
    if (child.stdout) {
      child.stdout.on('data', (c: Buffer) => {
        stdout = appendCapped(stdout, c, MAX_OUTPUT_BYTES)
      })
    }
    if (child.stderr) {
      child.stderr.on('data', (c: Buffer) => {
        stderr = appendCapped(stderr, c, MAX_OUTPUT_BYTES)
      })
    }
    child.on('error', (err) => {
      stderr = appendCapped(stderr, Buffer.from(String(err)), MAX_OUTPUT_BYTES)
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

let runner: LocalCliRunner = defaultRunner

// Override the spawn implementation (unit tests); null restores the default.
export function setLocalCliRunner(fn: LocalCliRunner | null | undefined): void {
  runner = fn ?? defaultRunner
}

// -- binary resolution ----------------------------------------------

function findOnPath(name: string): string | null {
  const pathVar = process.env.PATH ?? ''
  const dirs = pathVar.split(process.platform === 'win32' ? ';' : ':')
  const candidates = process.platform === 'win32' ? [name, name + '.cmd', name + '.exe'] : [name]
  for (const dir of dirs) {
    if (!dir) continue
    for (const candidate of candidates) {
      const full = join(dir, candidate)
      try {
        if (existsSync(full) && !statSync(full).isDirectory()) return full
      } catch {
        // unreadable entry: keep looking
      }
    }
  }
  return null
}

// agy binary path (env override, then settings, then ~/.local/bin, then PATH).
export function resolveAgyPath(settings: LocalCliSettingsInput = undefined): string | null {
  const override = (process.env.GENOFFICE_AGY_PATH ?? '').trim() || eff(settings).agyPath
  if (override) return existsSync(override) ? override : null
  const homeBin = join(homedir(), '.local', 'bin', 'agy')
  if (existsSync(homeBin)) return homeBin
  return findOnPath('agy')
}

export interface MmxInvocation {
  cmd: string
  baseArgs: string[]
  env: NodeJS.ProcessEnv
  via: 'mmx-env' | 'mmx'
}

// mmx invocation: the mmx-env wrapper (injects the key, --non-interactive and
// the region) when MINIMAX_API_KEY is set and the wrapper exists, else plain
// mmx with --non-interactive --region. Null when no binary is found.
export function resolveMmxInvocation(
  settings: LocalCliSettingsInput = undefined,
): MmxInvocation | null {
  const s = eff(settings)
  const override = (process.env.GENOFFICE_MMX_PATH ?? '').trim() || s.mmxPath
  if (override) {
    if (!existsSync(override)) return null
    if (basename(override) === 'mmx-env') {
      return { cmd: override, baseArgs: [], env: { ...process.env }, via: 'mmx-env' }
    }
    return {
      cmd: override,
      baseArgs: ['--non-interactive', '--region', s.mmxRegion],
      env: { ...process.env },
      via: 'mmx',
    }
  }
  const key = (process.env.MINIMAX_API_KEY ?? '').trim()
  const wrapper = join(homedir(), '.local', 'bin', 'mmx-env')
  if (key && existsSync(wrapper)) {
    return { cmd: wrapper, baseArgs: [], env: { ...process.env }, via: 'mmx-env' }
  }
  const homeBin = join(homedir(), '.local', 'bin', 'mmx')
  const cmd = existsSync(homeBin) ? homeBin : findOnPath('mmx')
  if (!cmd) return null
  return {
    cmd,
    baseArgs: ['--non-interactive', '--region', s.mmxRegion],
    env: { ...process.env },
    via: 'mmx',
  }
}

// -- JSON parsing helpers --------------------------------------------

// Last top-level JSON object in stdout (a jetski notice line may precede it).
export function parseLastJsonObject(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim()
  if (!text) return null
  try {
    const whole = JSON.parse(text) as unknown
    if (whole && typeof whole === 'object' && !Array.isArray(whole)) {
      return whole as Record<string, unknown>
    }
  } catch {
    // fall through to the line scan
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // not the JSON line; keep scanning upward
    }
  }
  return null
}

// Strip the triple-backtick fences an LLM may wrap around its answer.
export function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const fence = String.fromCharCode(96, 96, 96)
  if (!trimmed.startsWith(fence)) return trimmed
  let inner = trimmed.slice(fence.length)
  const firstLine = inner.split('\n')[0] ?? ''
  if (firstLine.trim().toLowerCase() === 'json') inner = inner.slice(firstLine.length).trim()
  if (inner.endsWith(fence)) inner = inner.slice(0, inner.length - fence.length).trim()
  return inner
}

// Parse the first JSON value starting at the first [ or {, honouring string
// escapes so trailing prose is ignored. Undefined when nothing parses (the
// schema may not be honoured - callers fall back).
export function parseLooseJson(text: string): unknown {
  const cleaned = stripCodeFences(text)
  const starts: number[] = []
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '[' || cleaned[i] === '{') starts.push(i)
  }
  for (const start of starts) {
    const parsed = parseBalanced(cleaned, start)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function parseBalanced(text: string, start: number): unknown {
  const open = text[start] as string
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const c = text[i] as string
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as unknown
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

function truncate(text: string, max = 500): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = typeof raw === 'number' ? Math.floor(raw) : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// -- agy core --------------------------------------------------------

export interface AgyEnvelope {
  conversation_id?: string
  status?: string
  response?: unknown
  denied_actions?: Array<{ action?: string; display_name?: string }>
  [key: string]: unknown
}

const AGY_MISSING = 'Antigravity CLI (agy) not found; install it or set the agy path in Settings'

async function runAgy(
  prompt: string,
  settings: LocalCliSettingsInput,
  opts: { jsonSchema?: unknown; timeoutSec?: number; keepCwd?: boolean } = {},
): Promise<{ envelope: AgyEnvelope; cwd: string }> {
  const agy = resolveAgyPath(settings)
  if (!agy) throw new Error(AGY_MISSING)
  const cwd = mkdtempSync(join(tmpdir(), 'genoffice-agy-'))
  try {
    const timeout = agyTimeoutMs(settings)
    const timeoutMs =
      opts.timeoutSec !== undefined ? Math.max(250, opts.timeoutSec * 1000) : timeout.ms
    const printSec = Math.max(
      1,
      opts.timeoutSec !== undefined ? Math.floor(opts.timeoutSec) : timeout.sec,
    )
    const args = ['-p', prompt, '--output-format', 'json', '--print-timeout', printSec + 's']
    const model = eff(settings).agyModel
    if (model) args.push('--model', model)
    if (opts.jsonSchema !== undefined) args.push('--json-schema', JSON.stringify(opts.jsonSchema))
    const r = await runner(agy, args, {
      cwd,
      env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
      timeoutMs,
    })
    if (r.timedOut) {
      throw new Error('Antigravity CLI (agy) timed out after ' + Math.round(timeoutMs / 1000) + 's')
    }
    const envelope = parseLastJsonObject(r.stdout)
    if (!envelope) {
      const hint = r.stderr.trim() ? ': ' + truncate(r.stderr) : ''
      const code = r.exitCode !== 0 && r.exitCode !== null ? ' (exit ' + r.exitCode + ')' : ''
      throw new Error('Antigravity CLI (agy) returned no JSON output' + code + hint)
    }
    return { envelope: envelope as AgyEnvelope, cwd }
  } finally {
    // The agent works in cwd but every usable output is either in the JSON
    // envelope or under the brain dir; drop the staging dir unless the caller
    // still needs to scan it (video generation).
    if (!opts.keepCwd) rmrf(cwd)
  }
}

// Best-effort removal of our own staging dirs (Fix 5: no /tmp leaks).
function rmrf(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // a half-written staging dir is litter either way; never fail the tool for it
  }
}

// Names of the agent's auto-denied actions, if any. A denied RunCommand alone
// is not a failure: the file or text usually still came back.
function agyDeniedLabel(envelope: AgyEnvelope): string | null {
  const denied = Array.isArray(envelope.denied_actions) ? envelope.denied_actions : []
  if (!denied.length) return null
  return (
    denied
      .map((d) => d.display_name || d.action)
      .filter(Boolean)
      .join(', ') || 'a shell action'
  )
}

// Empty text with no usable output: mention the denied action when there is one.
function agyEmptyError(envelope: AgyEnvelope, what: string): Error {
  const label = agyDeniedLabel(envelope)
  return new Error(
    'Antigravity CLI (agy) returned an empty ' +
      what +
      (label
        ? ': the agent needed permission for ' + label + ' and it was auto-denied headless'
        : ''),
  )
}

// Usable-output failure for the file producers: the scan already ran.
function agyMissingFileError(envelope: AgyEnvelope, kind: string): Error {
  const label = agyDeniedLabel(envelope)
  return new Error(
    'Antigravity CLI (agy) did not produce ' +
      kind +
      (label
        ? ': the agent needed permission for ' + label + ' and it was auto-denied headless'
        : ''),
  )
}

// -- media file helpers ----------------------------------------------

function agyBrainDir(conversationId: unknown): string | null {
  if (typeof conversationId !== 'string' || !conversationId) return null
  return join(homedir(), '.gemini', 'antigravity-cli', 'brain', conversationId)
}

function isInsideDir(file: string, dir: string): boolean {
  const rel = relative(dir, file)
  return rel !== '' && !rel.startsWith('..') && rel !== '..'
}

function mimeFromMagicBytes(bytes: Uint8Array): string | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    return 'image/png'
  }
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes.length > 5 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif'
  }
  if (
    bytes.length > 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

function videoMimeFromMagicBytes(bytes: Uint8Array): string | null {
  if (
    bytes.length > 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return 'video/webm'
  }
  // mp4 / mov / m4v carry the ftyp box at offset 4
  if (
    bytes.length > 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return 'video/mp4'
  }
  return null
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.m4v'])

export interface FoundMedia {
  path: string
  bytes: Uint8Array
  mime: string
}

// Newest valid media file in the given dirs (non-recursive plus one level,
// dot-dirs skipped). Validity is extension plus magic bytes via sniff.
function scanNewestMedia(
  dirs: Array<string | null | undefined>,
  exts: Set<string>,
  sniff: (bytes: Uint8Array) => string | null,
): FoundMedia | null {
  let best: (FoundMedia & { mtime: number }) | null = null
  const consider = (full: string): void => {
    try {
      if (!exts.has(extname(full).toLowerCase())) return
      const st = statSync(full)
      if (!st.isFile()) return
      const raw = readFileSync(full)
      const mime = sniff(new Uint8Array(raw))
      if (!mime) return
      if (!best || st.mtimeMs > best.mtime) {
        best = { path: full, bytes: new Uint8Array(raw), mime, mtime: st.mtimeMs }
      }
    } catch {
      // unreadable file: keep scanning
    }
  }
  for (const dir of dirs) {
    if (!dir) continue
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isFile()) consider(full)
      else if (entry.isDirectory()) {
        let sub: string[]
        try {
          sub = readdirSync(full)
        } catch {
          continue
        }
        for (const name of sub) {
          if (name.startsWith('.')) continue
          consider(join(full, name))
        }
      }
    }
  }
  return best
}

// The response path is only trusted when it exists and lives in one of the
// allowed dirs (the agent brain dir for this conversation or the temp cwd);
// otherwise the newest valid file found there wins.
function acceptResponseFile(
  response: unknown,
  dirs: Array<string | null | undefined>,
  exts: Set<string>,
  sniff: (bytes: Uint8Array) => string | null,
): FoundMedia | null {
  if (typeof response === 'string' && response.trim()) {
    const candidate = (response.trim().split('\n')[0] ?? '').trim()
    try {
      if (
        candidate &&
        existsSync(candidate) &&
        statSync(candidate).isFile() &&
        dirs.some((d) => d && isInsideDir(candidate, d)) &&
        exts.has(extname(candidate).toLowerCase())
      ) {
        const raw = readFileSync(candidate)
        const mime = sniff(new Uint8Array(raw))
        if (mime) return { path: candidate, bytes: new Uint8Array(raw), mime }
      }
    } catch {
      // fall through to the directory scan
    }
  }
  return scanNewestMedia(dirs, exts, sniff)
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
}

// Remote URLs, data URLs and file store URLs are materialised into the temp
// dir first (reuses loadMediaReference); plain local paths pass through.
async function materialiseForAgy(refs: string[], cwd: string): Promise<string[]> {
  const out: string[] = []
  const mod = await import('./media-tools')
  for (const ref of refs) {
    if (/^https?:\/\//i.test(ref) || ref.startsWith('data:') || ref.startsWith('file:')) {
      const blob = await mod.loadMediaReference(ref)
      const ext = MIME_TO_EXT[blob.mime.toLowerCase()] ?? '.bin'
      const target = join(cwd, 'input-' + out.length + ext)
      writeFileSync(target, blob.bytes)
      out.push(target)
    } else {
      out.push(ref)
    }
  }
  return out
}

// -- agy search ------------------------------------------------------

const AGY_SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          snippet: { type: 'string' },
        },
      },
    },
    answer: { type: 'string' },
  },
}

function toWebResults(items: unknown, max: number): WebSearchResult[] {
  if (!Array.isArray(items)) return []
  return items.slice(0, max).map((item) => {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    return {
      title: String(o.title ?? ''),
      url: String(o.url ?? o.link ?? ''),
      snippet: String(o.snippet ?? o.description ?? ''),
    }
  })
}

export async function agySearch(
  query: string,
  maxResults = 6,
  settings: LocalCliSettingsInput = undefined,
): Promise<{ results: WebSearchResult[]; answer?: string }> {
  const max = clampInt(maxResults, 1, 20, 6)
  const prompt =
    'Do not run any shell commands and do not open or resolve any URL; use only the search_web tool. Use it to search for: ' +
    query +
    '. Reply ONLY with a JSON array of up to ' +
    max +
    ' objects with keys title, url and snippet. Report each URL exactly as search_web returned it.'
  const started = Date.now()
  let envelope = (await runAgy(prompt, settings, { jsonSchema: AGY_SEARCH_SCHEMA })).envelope
  let raw = typeof envelope.response === 'string' ? envelope.response : ''
  // An empty answer after an auto-denied RunCommand is usually the agent
  // trying (and failing) to open URLs itself: retry once with the same
  // prompt, bounded by whatever is left of the agy timeout. Search only.
  if (!raw.trim() && agyDeniedLabel(envelope)) {
    const remaining = Math.floor(agyTimeoutMs(settings).sec - (Date.now() - started) / 1000)
    if (remaining >= 1) {
      envelope = (
        await runAgy(prompt, settings, { jsonSchema: AGY_SEARCH_SCHEMA, timeoutSec: remaining })
      ).envelope
      raw = typeof envelope.response === 'string' ? envelope.response : ''
    }
  }
  // A non-empty response is usable even when a shell action was denied; only
  // an empty one fails (naming the denied action when there is one).
  if (!raw.trim()) throw agyEmptyError(envelope, 'search response')
  const parsed = parseLooseJson(raw)
  const results = toWebResults(
    Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown> | null)?.results,
    max,
  )
  const answerRaw = (parsed as Record<string, unknown> | null)?.answer
  const answer = typeof answerRaw === 'string' && answerRaw.trim() ? answerRaw : undefined
  const resolved = await resolveGroundingRedirects(results)
  return answer === undefined ? { results: resolved } : { results: resolved, answer }
}

// Google grounding redirect URLs carry no usable host/path of their own.
export function isGroundingRedirectUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'vertexaisearch.cloud.google.com' &&
      url.pathname.startsWith('/grounding-api-redirect/')
    )
  } catch {
    return false
  }
}

export type AgyRedirectResolver = (url: string) => Promise<string | null>

// HEAD-less unwrap of one grounding redirect: the Location header wins when
// it is an absolute http(s) URL, anything else keeps the original URL.
async function defaultRedirectResolver(url: string): Promise<string | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const resp = await fetch(url, { method: 'GET', redirect: 'manual', signal: ctrl.signal })
    const location = resp.headers.get('location')
    return location && /^https?:\/\//i.test(location) ? location : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

let redirectResolver: AgyRedirectResolver = defaultRedirectResolver

// Override the grounding-redirect unwrapping (unit tests); null restores it.
export function setAgyRedirectResolver(fn: AgyRedirectResolver | null | undefined): void {
  redirectResolver = fn ?? defaultRedirectResolver
}

// Unwrap grounding redirects in parallel; only that exact https host is ever
// fetched, and any failure keeps the original URL.
async function resolveGroundingRedirects(
  results: WebSearchResult[],
): Promise<WebSearchResult[]> {
  return Promise.all(
    results.map(async (r) => {
      if (!isGroundingRedirectUrl(r.url)) return r
      try {
        const target = await redirectResolver(r.url)
        return target ? { ...r, url: target } : r
      } catch {
        return r
      }
    }),
  )
}

// -- agy image generation --------------------------------------------

export interface AgyGenerateImageInput {
  prompt: string
  aspectRatio?: string
  referenceImagePaths?: string[]
}

export async function agyGenerateImage(
  input: AgyGenerateImageInput,
  settings: LocalCliSettingsInput = undefined,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const agy = resolveAgyPath(settings)
  if (!agy) throw new Error(AGY_MISSING)
  const cwd = mkdtempSync(join(tmpdir(), 'genoffice-agy-'))
  try {
    let prompt =
      'Do not run any shell commands, do not copy/move/convert files; call generate_image exactly once to create: ' +
      input.prompt +
      '.'
    if (input.aspectRatio) prompt += ' Aspect ratio: ' + input.aspectRatio + '.'
    const refs = input.referenceImagePaths ?? []
    if (refs.length) {
      const staged: string[] = []
      for (let i = 0; i < refs.length; i++) {
        const src = refs[i] as string
        const target = join(cwd, 'ref-' + i + (extname(src).toLowerCase() || '.png'))
        try {
          writeFileSync(target, readFileSync(src))
          staged.push(target)
        } catch {
          throw new Error('Antigravity CLI (agy) reference image is not readable: ' + src)
        }
      }
      prompt += ' Use these reference images: ' + staged.join(', ') + '.'
    }
    prompt += ' Then reply only with the absolute file path of the generated file.'
    // runAgy makes its own temp cwd for the agent; the agent also writes into
    // its brain dir, so search both plus our staging dir for the output file.
    const timeout = agyTimeoutMs(settings)
    const args = ['-p', prompt, '--output-format', 'json', '--print-timeout', timeout.sec + 's']
    const model = eff(settings).agyModel
    if (model) args.push('--model', model)
    const r = await runner(agy, args, {
      cwd,
      env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
      timeoutMs: timeout.ms,
    })
    if (r.timedOut) {
      throw new Error('Antigravity CLI (agy) timed out generating the image')
    }
    const envelope = parseLastJsonObject(r.stdout)
    if (!envelope) throw new Error('Antigravity CLI (agy) returned no JSON output')
    // A denied RunCommand after the generation is not a failure: the file is
    // usually already in the brain dir, so always scan before failing.
    const typed = envelope as AgyEnvelope
    const found = acceptResponseFile(
      typed.response,
      [agyBrainDir(typed.conversation_id), cwd],
      IMAGE_EXTS,
      mimeFromMagicBytes,
    )
    if (!found) throw agyMissingFileError(typed, 'an image file')
    return { bytes: found.bytes, mime: found.mime }
  } finally {
    rmrf(cwd)
  }
}

// -- agy understanding + transcription -------------------------------

export async function agyDescribe(
  paths: string[],
  requirements: string,
  settings: LocalCliSettingsInput = undefined,
): Promise<string> {
  if (!paths.length) throw new Error('agyDescribe needs at least one media file')
  const cwd = mkdtempSync(join(tmpdir(), 'genoffice-agy-'))
  try {
    const local = await materialiseForAgy(paths, cwd)
    const prompt =
      'Do not run any shell commands. Use view_file on each of these files: ' +
      local.join(', ') +
      '. Do not mention file names or paths in your answer. Then answer: ' +
      requirements
    const { envelope } = await runAgy(prompt, settings)
    const text = typeof envelope.response === 'string' ? envelope.response.trim() : ''
    if (!text) throw agyEmptyError(envelope, 'analysis')
    return stripAgyStagingRefs(
      text,
      [cwd, ...local.map((p) => dirname(p))],
      local,
    )
  } finally {
    rmrf(cwd)
  }
}

// The agent echoes our staged temp files back as markdown links and [media:]
// markers; neither belongs in the tool result. A link whose target lives in
// one of the staging dirs is dropped entirely (plus its now-empty ()/（）),
// and so are leading [media: {...}] markers.
// Callers also pass the dirname of every input path plus the inputs
// themselves, so links to the staged media dir (not just the agy cwd) match.
export function stripAgyStagingRefs(
  text: string,
  dirs: Array<string | null | undefined>,
  paths: string[] = [],
): string {
  let out = text
  for (;;) {
    const stripped = out.replace(/^\s*\[media:\s*\{[^}]*\}\]\s*/, '')
    if (stripped === out) break
    out = stripped
  }
  const normalise = (target: string): string => {
    let clean = target.trim()
    if (clean.startsWith('<') && clean.endsWith('>')) clean = clean.slice(1, -1)
    if (clean.toLowerCase().startsWith('file://')) {
      try {
        clean = decodeURIComponent(clean.slice('file://'.length))
      } catch {
        clean = clean.slice('file://'.length)
      }
    }
    return clean
  }
  const wanted = new Set(paths.map(normalise).filter(Boolean))
  const isStagingRef = (target: string): boolean => {
    const clean = normalise(target)
    if (wanted.has(clean)) return true
    return dirs.some((d) => d && (clean === d || clean.startsWith(d + '/')))
  }
  out = out.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (match, _label, target) =>
    isStagingRef(String(target)) ? '' : match,
  )
  out = out.replace(/（\s*）/g, '').replace(/\(\s*\)/g, '')
  // Removals leave doubled spaces and stray leading punctuation behind.
  out = out.replace(/ {2,}/g, ' ')
  out = out.replace(/^[\s,.;:!?，。；：！？、…—\-–'"")\]}>]+/, '')
  return out.trim()
}

export async function agyTranscribe(
  path: string,
  language: string | undefined,
  settings: LocalCliSettingsInput = undefined,
): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'genoffice-agy-'))
  try {
    const local = await materialiseForAgy([path], cwd)
    void language
    const prompt =
      'Do not run any shell commands. Call view_file on ' +
      (local[0] as string) +
      ' and transcribe the speech verbatim in its original language. Do not mention file names or paths in your answer. ' +
      'Reply only with the transcript, or exactly NO_AUDIO_ACCESS if you cannot hear it.'
    const { envelope } = await runAgy(prompt, settings)
    const text = typeof envelope.response === 'string' ? envelope.response.trim() : ''
    if (!text) throw agyEmptyError(envelope, 'transcript')
    if (text === 'NO_AUDIO_ACCESS') {
      const label = agyDeniedLabel(envelope)
      throw new Error(
        'Antigravity CLI (agy) could not transcribe the audio' +
          (label
            ? ': the agent needed permission for ' + label + ' and it was auto-denied headless'
            : ': the agent reported NO_AUDIO_ACCESS'),
      )
    }
    return stripAgyStagingRefs(
      text,
      [cwd, ...local.map((p) => dirname(p))],
      local,
    )
  } finally {
    rmrf(cwd)
  }
}

export const AGY_NO_VIDEO =
  'Antigravity CLI has no video generation tool (agy 1.2.13); falling back to mmx'

export async function agyVideoGenerate(
  input: { prompt: string },
  settings: LocalCliSettingsInput = undefined,
): Promise<{ bytes: Uint8Array; mime: string }> {
  if (!eff(settings).agyVideo) throw new Error(AGY_NO_VIDEO)
  const prompt =
    'Do not run any shell commands, do not copy/move/convert files. Use your video generation tool to create a video for: ' +
    input.prompt +
    '. Then reply only with the absolute file path of the generated video file on disk.'
  const { envelope, cwd } = await runAgy(prompt, settings, { keepCwd: true })
  try {
    const found = acceptResponseFile(
      envelope.response,
      [agyBrainDir(envelope.conversation_id), cwd],
      VIDEO_EXTS,
      videoMimeFromMagicBytes,
    )
    if (!found) throw agyMissingFileError(envelope, 'a video file')
    return { bytes: found.bytes, mime: found.mime }
  } finally {
    rmrf(cwd)
  }
}

// -- mmx core --------------------------------------------------------

const MMX_MISSING_NO_KEY =
  'MiniMax CLI (mmx) is not logged in (MINIMAX_API_KEY is missing and no mmx credentials were found)'
const MMX_MISSING_BINARY =
  'MiniMax CLI (mmx) not found; install it or set the mmx path in Settings'

function mmxErrorMessage(raw: unknown): { code: unknown; message: string } {
  if (typeof raw === 'string') return { code: undefined, message: raw }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    code: o.code,
    message: String(o.message ?? o.msg ?? 'unknown error'),
  }
}

// First non-empty line, capped: never dump a whole stderr blob or hint paths.
function firstLine(text: string, max = 300): string {
  for (const line of text.split('\n')) {
    const clean = line.replace(/\s+/g, ' ').trim()
    if (clean) return clean.length > max ? clean.slice(0, max) + '…' : clean
  }
  return ''
}

// Condensed mmx failure: {error:{code,message}} becomes a one-liner without
// the hint blob; anything else is the first stderr line, capped.
function mmxFailureMessage(stdout: string, stderr: string): string {
  const payload = parseLastJsonObject(stdout) ?? parseLastJsonObject(stderr)
  const rec = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const err = rec.error !== undefined && rec.error !== null ? rec.error : rec
  const hasErrorShape =
    rec.error !== undefined && rec.error !== null
      ? true
      : typeof rec.code !== 'undefined' || typeof rec.message !== 'undefined'
  if (hasErrorShape) {
    const { code, message } = mmxErrorMessage(err)
    const head = 'MiniMax CLI (mmx): ' + message + (code !== undefined ? ' (code ' + String(code) + ')' : '')
    return code === 3
      ? head + ' - mmx is not logged in and MINIMAX_API_KEY is not set'
      : head
  }
  const line = firstLine(stderr || stdout)
  return 'MiniMax CLI (mmx) failed' + (line ? ': ' + line : '')
}

async function runMmx(
  args: string[],
  settings: LocalCliSettingsInput,
  opts: { timeoutMs?: number; quiet?: boolean } = {},
): Promise<{ json: unknown; stdout: string }> {
  const inv = resolveMmxInvocation(settings)
  if (!inv) {
    throw new Error((process.env.MINIMAX_API_KEY ?? '').trim() ? MMX_MISSING_BINARY : MMX_MISSING_NO_KEY)
  }
  const full = [...inv.baseArgs, ...args]
  // --quiet must not be passed where it changes JSON output (video --download prints only the path).
  if (opts.quiet !== false && !args.includes('--download')) full.push('--quiet')
  const r = await runner(inv.cmd, full, {
    env: inv.env,
    timeoutMs: opts.timeoutMs ?? 300000,
  })
  if (r.timedOut) throw new Error('MiniMax CLI (mmx) timed out')
  if (r.exitCode !== 0) {
    throw new Error(mmxFailureMessage(r.stdout, r.stderr))
  }
  const parsed = parseLastJsonObject(r.stdout) ?? parseLooseJson(r.stdout)
  if (parsed === undefined || parsed === null) {
    throw new Error('MiniMax CLI (mmx) returned no JSON output')
  }
  const rec = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  if (rec.error !== undefined && rec.error !== null) {
    const { code, message } = mmxErrorMessage(rec.error)
    // Same condensed shape as a non-zero exit (no hint blob, code 3 spells
    // out the login remedy). MMX_MISSING_NO_KEY stays the no-binary/no-key
    // resolution error above.
    const head =
      'MiniMax CLI (mmx): ' + message + (code !== undefined ? ' (code ' + String(code) + ')' : '')
    throw new Error(
      code === 3 ? head + ' - mmx is not logged in and MINIMAX_API_KEY is not set' : head,
    )
  }
  return { json: parsed, stdout: r.stdout }
}

// -- mmx search ------------------------------------------------------

export async function mmxSearch(
  query: string,
  maxResults = 6,
  settings: LocalCliSettingsInput = undefined,
): Promise<{ results: WebSearchResult[]; answer?: string }> {
  const max = clampInt(maxResults, 1, 20, 6)
  const { json } = await runMmx(['search', 'query', '--q', query, '--output', 'json'], settings)
  const rec = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const organic = Array.isArray(rec.organic) ? rec.organic : []
  const results: WebSearchResult[] = []
  for (const item of organic) {
    if (results.length >= max) break
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const url = String(o.link ?? o.url ?? '')
    if (!/^https?:\/\//i.test(url)) continue
    results.push({ title: String(o.title ?? ''), url, snippet: String(o.snippet ?? '') })
  }
  return { results }
}

// -- mmx vision (images only) ----------------------------------------

export async function mmxDescribe(
  pathOrUrl: string,
  prompt: string,
  settings: LocalCliSettingsInput = undefined,
): Promise<string> {
  const { json } = await runMmx(
    ['vision', 'describe', '--image', pathOrUrl, '--prompt', prompt, '--output', 'json'],
    settings,
  )
  const rec = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const content = String(rec.content ?? '').trim()
  if (!content) throw new Error('MiniMax CLI (mmx) returned an empty description')
  return content
}

// -- mmx image generation (fallback path) -----------------------------

export interface MmxGenerateImageInput {
  prompt: string
  aspectRatio?: string
  referenceImagePaths?: string[]
}

export async function mmxGenerateImage(
  input: MmxGenerateImageInput,
  settings: LocalCliSettingsInput = undefined,
): Promise<{ bytes: Uint8Array; mime: string }> {
  void input.referenceImagePaths
  const cwd = mkdtempSync(join(tmpdir(), 'genoffice-mmx-'))
  try {
    const out = join(cwd, 'image.png')
    const args = ['image', 'generate', '--prompt', input.prompt]
    if (input.aspectRatio && /^\d+:\d+$/.test(input.aspectRatio)) {
      args.push('--aspect-ratio', input.aspectRatio)
    }
    args.push('--out', out, '--output', 'json')
    await runMmx(args, settings, { timeoutMs: 600000 })
    let raw: Buffer
    try {
      raw = readFileSync(out)
    } catch {
      throw new Error('MiniMax CLI (mmx) did not write the image file')
    }
    return { bytes: new Uint8Array(raw), mime: mimeFromMagicBytes(new Uint8Array(raw)) ?? 'image/png' }
  } finally {
    rmrf(cwd)
  }
}

// -- mmx speech ------------------------------------------------------

export interface MmxSynthesizeInput {
  text: string
  out: string
  voice?: string
  format?: string
  model?: string
  speed?: number
  emotion?: string
  language?: string
}

const HAN_RE = /\p{Script=Han}/u

export function defaultMmxVoice(text: string, settings: LocalCliSettingsInput = undefined): string | null {
  const configured = eff(settings).ttsVoice
  if (configured) return configured
  return HAN_RE.test(text) ? 'male-qn-qingse' : null
}

export async function mmxSynthesize(
  input: MmxSynthesizeInput,
  settings: LocalCliSettingsInput = undefined,
): Promise<{ path: string; bytes: Uint8Array }> {
  const text = String(input.text ?? '')
  if (!text.trim()) throw new Error('mmxSynthesize needs non-empty text')
  const args = ['speech', 'synthesize', '--text', text, '--out', input.out]
  const voice = input.voice || defaultMmxVoice(text, settings) || undefined
  if (voice) args.push('--voice', voice)
  args.push('--model', input.model || 'speech-2.8-hd')
  if (input.format) args.push('--format', input.format)
  if (typeof input.speed === 'number' && Number.isFinite(input.speed)) {
    args.push('--speed', String(input.speed))
  }
  if (input.emotion) args.push('--emotion', input.emotion)
  if (input.language) args.push('--language', input.language)
  args.push('--output', 'json')
  await runMmx(args, settings, { timeoutMs: 600000 })
  let raw: Buffer
  try {
    raw = readFileSync(input.out)
  } catch {
    throw new Error('MiniMax CLI (mmx) did not write the audio file')
  }
  return { path: input.out, bytes: new Uint8Array(raw) }
}

export async function mmxTranscribe(
  path: string,
  language: string | undefined,
  settings: LocalCliSettingsInput = undefined,
): Promise<string> {
  const args = ['speech', 'transcribe', '--file', path]
  if (language) args.push('--language', language)
  args.push('--output', 'json')
  const { json } = await runMmx(args, settings, { timeoutMs: 600000 })
  const rec = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  if (typeof rec.text === 'string' && rec.text.trim()) return rec.text.trim()
  const segments = Array.isArray(rec.segments) ? rec.segments : []
  const joined = segments
    .map((s) => {
      const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>
      return String(o.text ?? '')
    })
    .join('')
    .trim()
  if (joined) return joined
  throw new Error('MiniMax CLI (mmx) returned an empty transcript')
}

// -- mmx video -------------------------------------------------------

export interface MmxVideoGenerateInput {
  prompt: string
  out?: string
  image?: string
  model?: string
  duration?: number
  ratio?: string
  async?: boolean
}

export interface MmxVideoResult {
  taskId: string
  status?: string
  fileId?: string
  path?: string
}

export async function mmxVideoGenerate(
  input: MmxVideoGenerateInput,
  settings: LocalCliSettingsInput = undefined,
): Promise<MmxVideoResult> {
  const args = ['video', 'generate', '--prompt', input.prompt]
  if (input.model) args.push('--model', input.model)
  if (input.image) args.push('--image', input.image)
  if (typeof input.duration === 'number' && Number.isFinite(input.duration)) {
    args.push('--duration', String(input.duration))
  }
  if (input.ratio) args.push('--ratio', input.ratio)
  if (input.async) {
    args.push('--async')
  } else if (input.out) {
    // --download changes stdout to the bare path: never add --quiet here.
    args.push('--download', input.out)
  }
  args.push('--output', 'json')
  const { json } = await runMmx(args, settings, { timeoutMs: 1800000, quiet: input.async ? true : false })
  const rec = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const taskId = String(rec.task_id ?? rec.taskId ?? '')
  if (!taskId && !input.async) {
    // synchronous --download run without a task id: the file itself is the result
    if (input.out && existsSync(input.out)) return { taskId: '', path: input.out }
  }
  if (!taskId) throw new Error('MiniMax CLI (mmx) returned no task id')
  const out = input.out
  const result: MmxVideoResult = { taskId }
  if (typeof rec.status === 'string') result.status = rec.status
  const fileId = rec.file_id ?? rec.fileId
  if (typeof fileId === 'string' && fileId) result.fileId = fileId
  const saved = rec.saved
  if (typeof saved === 'string' && saved) result.path = saved
  else if (out && !input.async && existsSync(out)) result.path = out
  return result
}

export async function mmxVideoTask(
  taskId: string,
  model: string | undefined,
  settings: LocalCliSettingsInput = undefined,
): Promise<unknown> {
  const args = ['video', 'task', 'get', '--task-id', taskId]
  if (model) args.push('--model', model)
  args.push('--output', 'json')
  const { json } = await runMmx(args, settings, { timeoutMs: 120000 })
  return json
}

export async function mmxVideoDownload(
  fileId: string,
  out: string,
  settings: LocalCliSettingsInput = undefined,
): Promise<string> {
  await runMmx(['video', 'download', '--file-id', fileId, '--out', out], settings, {
    timeoutMs: 1800000,
  })
  return out
}

// -- status ------------------------------------------------------------

export interface LocalCliStatus {
  agy: { path: string | null; found: boolean }
  mmx: {
    path: string | null
    found: boolean
    via: 'mmx-env' | 'mmx' | null
    credentials: 'env' | 'config' | 'missing'
  }
}

// Binary presence + credential existence only: no network, no spawning.
export function localCliStatus(
  settings: LocalCliSettingsInput = undefined,
): LocalCliStatus {
  const agyPath = resolveAgyPath(settings)
  const inv = resolveMmxInvocation(settings)
  let credentials: 'env' | 'config' | 'missing' = 'missing'
  if ((process.env.MINIMAX_API_KEY ?? '').trim()) {
    credentials = 'env'
  } else {
    const configDir = (process.env.MMX_CONFIG_DIR ?? '').trim() || join(homedir(), '.mmx')
    try {
      if (existsSync(join(configDir, 'config.json'))) credentials = 'config'
    } catch {
      // existence check only; unreadable means missing
    }
  }
  return {
    agy: { path: agyPath, found: agyPath !== null },
    mmx: {
      path: inv ? inv.cmd : null,
      found: inv !== null,
      via: inv ? inv.via : null,
      credentials,
    },
  }
}

// -- routing -----------------------------------------------------------

const DOMESTIC_HOSTS = [
  'baidu.com',
  'zhihu.com',
  'weibo.com',
  'bilibili.com',
  'qq.com',
  '163.com',
  'sina.com.cn',
  'sohu.com',
  'csdn.net',
  'douban.com',
  'jd.com',
  'taobao.com',
  'xiaohongshu.com',
  'toutiao.com',
  '36kr.com',
  'tmall.com',
  'aliyun.com',
]

// True for Chinese-language queries or queries targeting Chinese sites.
export function isDomesticQuery(query: string): boolean {
  if (typeof query !== 'string' || !query) return false
  if (HAN_RE.test(query)) return true
  const lower = query.toLowerCase()
  const hosts: string[] = []
  const siteRe = /site:\s*([^\s]+)/g
  let m: RegExpExecArray | null
  while ((m = siteRe.exec(lower)) !== null) hosts.push(m[1] as string)
  const tokens = lower.match(/(?:[a-z0-9-]+\.)+[a-z]{2,}/g) ?? []
  hosts.push(...tokens)
  for (let host of hosts) {
    host = host.split('/')[0] as string
    host = host.split(':')[0] as string
    if (!host) continue
    if (host === 'cn' || host.endsWith('.cn')) return true
    if (DOMESTIC_HOSTS.some((d) => host === d || host.endsWith('.' + d))) return true
  }
  return false
}

export type LocalSearchCli = 'mmx' | 'antigravity'

// Explicit override wins, then the settings routing, then auto by query.
export function pickSearchProvider(
  query: string,
  routing?: AiLocalCliSettings['searchRouting'],
  explicit?: string,
): LocalSearchCli {
  const e = (explicit ?? '').trim().toLowerCase()
  if (
    e === 'mmx' ||
    e === 'antigravity' ||
    e === 'cn' ||
    e === 'domestic' ||
    e === 'china'
  ) {
    return 'mmx'
  }
  // NOTE: 'agy' (the Antigravity CLI binary) selects antigravity, so that
  // search --via agy / --region intl reaches the agy backend.
  if (e === 'agy' || e === 'intl' || e === 'foreign' || e === 'global') return 'antigravity'
  if (routing === 'mmx') return 'mmx'
  if (routing === 'antigravity') return 'antigravity'
  return isDomesticQuery(query) ? 'mmx' : 'antigravity'
}

// Cheap settings-UI check for the local media backends: binary present (plus
// mmx credentials), without generating anything. No network, no spawning.
export function testLocalCliMedia(
  provider: 'antigravity' | 'mmx',
  settings: LocalCliSettingsInput = undefined,
): { ok: boolean; error?: string } {
  const status = localCliStatus(settings)
  if (provider === 'antigravity') {
    return status.agy.found
      ? { ok: true }
      : { ok: false, error: 'Antigravity CLI (agy) not found on this machine' }
  }
  if (!status.mmx.found) {
    return { ok: false, error: 'MiniMax CLI (mmx) not found on this machine' }
  }
  if (status.mmx.credentials === 'missing') {
    return {
      ok: false,
      error: 'MiniMax CLI (mmx) is not logged in (MINIMAX_API_KEY is missing)',
    }
  }
  return { ok: true }
}
