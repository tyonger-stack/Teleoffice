/**
 * generate_image / analyze_media for the five editors' main processes: one
 * place that reads ai-settings.json live, routes to the BYOK media provider
 * when one is configured, and otherwise to the Genspark CLI behind the usual
 * login + cloud-tools gate. BYOK providers answer with bytes; those land in
 * the local generated-image store and come back as a file:// URL that the
 * insert pipelines' fetchRemoteImage accepts.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import {
  activeMediaConfig,
  analyzeMediaWithProvider,
  cloudToolsEnabled,
  defaultAiSettings,
  generateImageWithProvider,
  localCliSettingsOf,
  resolveAiSettings,
  type AiSettings,
  type LegacyAiSettings,
  type MediaBlob,
} from '@teleoffice/ai-provider'
// deep imports: the package root re-exports Electron-bound modules, and this file also runs in the teleoffice CLI
import {
  readGeneratedImage,
  storeGeneratedImage,
} from '@teleoffice/electron-utils/generated-images'
import {
  ResponseTooLargeError,
  fetchRemoteImage,
  readBodyCapped,
} from '@teleoffice/electron-utils/remote-image'
import { fetchWithSsrfGuard } from '@teleoffice/electron-utils/safe-remote-url'
import { gskAnalyzeMedia, gskGenerateImage, hasGskAuth, type GskGenerateImageOptions } from './gsk'
import {
  agyDescribe,
  agyGenerateImage,
  agyTranscribe,
  agyVideoGenerate,
  localCliBinariesMissing,
  mmxDescribe,
  mmxGenerateImage,
  mmxSynthesize,
  mmxTranscribe,
  mmxVideoDownload,
  mmxVideoGenerate,
  mmxVideoTask,
} from './local-cli'

export const GSK_NOT_LOGGED_IN_ERROR =
  'No Genspark API key configured; set GSK_API_KEY or choose another provider in Settings'
export const GSK_TOOLS_OFF_ERROR =
  'Genspark cloud tools are turned off in Settings (AI Model); enable them or configure an image provider under Settings (AI Media) to use this tool'

/** 200 MB: enough for a long clip through the Gemini Files API, small enough to hold in memory */
const MAX_MEDIA_BYTES = 200 * 1024 * 1024

/** Per-request ceiling across every reference of one tool call: MAX_MEDIA_BYTES bounds a single
 *  item, and without a total the same cap could be multiplied by the item count. */
const MAX_MEDIA_TOTAL_BYTES = 200 * 1024 * 1024

/** Per-request item ceiling: a media tool call is a handful of references, never a data dump. */
const MAX_MEDIA_ITEMS = 12

/** How many references are decoded at once, so peak memory is a small multiple of the total cap
 *  rather than the whole request. */
const MEDIA_LOAD_CONCURRENCY = 3

/** The production budget, exported so callers and tests can reason about the ceilings. */
export const MEDIA_BUDGET = {
  maxItems: MAX_MEDIA_ITEMS,
  maxItemBytes: MAX_MEDIA_BYTES,
  maxTotalBytes: MAX_MEDIA_TOTAL_BYTES,
  concurrency: MEDIA_LOAD_CONCURRENCY,
} as const

/** the only load failure that may hand the request back to Genspark; validation failures never do */
export class MediaTooLargeError extends Error {}

/** Subclasses MediaTooLargeError so the existing "too big, try Genspark" fallback applies. */
export class MediaBudgetExceededError extends MediaTooLargeError {}

/** The item ceiling in one place, so the Genspark route rejects like the BYOK one. */
function assertMediaItemCount(count: number, maxItems: number): void {
  if (count > maxItems) {
    throw new MediaBudgetExceededError(
      `Too many media items in one request (${count}, limit ${maxItems}); analyze them in smaller batches`,
    )
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
}

const DATA_URL_RE = /^data:([^;,]+);base64,([\s\S]*)$/

/** Decoded size a data URL will produce, computed from the base64 length alone so the check runs
 *  before anything is allocated. Whitespace inside the payload only inflates the estimate. */
function dataUrlDecodedSize(ref: string): number {
  if (!ref.startsWith('data:')) return 0
  const match = DATA_URL_RE.exec(ref)
  if (!match) return 0
  const b64 = match[2] ?? ''
  return Math.floor((b64.length * 3) / 4)
}

export function readAiSettingsFile(path: string): AiSettings {
  let stored: Partial<AiSettings> & LegacyAiSettings = {}
  try {
    if (existsSync(path)) stored = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    /* corrupted settings file: defaults */
  }
  return resolveAiSettings(stored, defaultAiSettings())
}

type Gate = { error: string } | null

/** the Genspark route's preconditions; null when it may proceed */
function gskGate(settings: AiSettings, notLoggedInError: string): Gate {
  if (!hasGskAuth()) return { error: notLoggedInError }
  if (!cloudToolsEnabled(settings)) return { error: GSK_TOOLS_OFF_ERROR }
  return null
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Resolves a tool-supplied media reference to bytes: an https URL (SSRF-guarded),
 * a file:// URL from the generated-image store, or a local media file
 * (attachments). Only media extensions are read locally — the model must not be
 * able to ship arbitrary files to a vendor.
 */
export async function loadMediaReference(ref: string): Promise<MediaBlob> {
  if (/^https?:\/\//i.test(ref)) {
    const resp = await (ref.match(/\.(png|jpe?g|gif|webp)(\?|$)/i)
      ? fetchRemoteImage(ref)
      : fetchWithSsrfGuard(ref, { headers: { 'User-Agent': 'Mozilla/5.0' } }))
    if (!resp || !resp.ok) throw new Error(`Could not download ${ref}`)
    let bytes: Uint8Array
    try {
      bytes = await readBodyCapped(resp, MAX_MEDIA_BYTES)
    } catch (err) {
      if (err instanceof ResponseTooLargeError) {
        throw new MediaTooLargeError(`${ref} is too large to analyze`)
      }
      throw err
    }
    const rawCt = resp.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    const ct = rawCt && rawCt !== 'application/octet-stream' ? rawCt : undefined
    const name = basename(new URL(ref).pathname) || undefined
    const mime =
      ct && ct !== 'application/octet-stream' ? ct : MIME_BY_EXT[extname(name ?? '').toLowerCase()]
    if (!mime) throw new Error(`Could not tell the media type of ${ref}`)
    return { bytes, mime, ...(name ? { name } : {}) }
  }
  // data URLs (pictures embedded in a document) carry their own bytes and type
  if (ref.startsWith('data:')) {
    const m = DATA_URL_RE.exec(ref)
    if (!m) throw new Error('Unsupported data URL: only base64-encoded media can be analyzed')
    const [, mime = '', b64 = ''] = m
    const bytes = new Uint8Array(Buffer.from(b64.replace(/\s+/g, ''), 'base64'))
    if (bytes.byteLength > MAX_MEDIA_BYTES) {
      throw new MediaTooLargeError('data URL is too large to analyze')
    }
    return { bytes, mime: mime.toLowerCase() }
  }
  if (ref.startsWith('file:')) {
    const local = readGeneratedImage(ref)
    if (!local) throw new Error(`Not an accessible image: ${ref}`)
    return { bytes: new Uint8Array(local.bytes), mime: local.mime }
  }
  const mime = MIME_BY_EXT[extname(ref).toLowerCase()]
  if (!mime) throw new Error(`Unsupported media file: ${ref} (images, video and audio only)`)
  if (!existsSync(ref)) throw new Error(`File not found: ${ref}`)
  if (statSync(ref).size > MAX_MEDIA_BYTES) {
    throw new MediaTooLargeError(`${ref} is too large to analyze`)
  }
  return { bytes: new Uint8Array(readFileSync(ref)), mime, name: basename(ref) }
}

export interface MediaToolOptions {
  /** localized replacement for the default signed-out message */
  notLoggedInError?: string
}

export interface MediaBudget {
  maxItems?: number
  maxItemBytes?: number
  maxTotalBytes?: number
  concurrency?: number
}

/**
 * Load a tool call's references under a total byte budget and an item cap. Encoded data URLs are
 * measured before they are decoded, the references are loaded with bounded concurrency, and the
 * running total is re-checked as each one lands, so a request can no longer hold N times the
 * per-file cap in memory at once.
 */
export async function loadMediaReferences(
  refs: readonly string[],
  budget: MediaBudget = MEDIA_BUDGET,
): Promise<MediaBlob[]> {
  const maxItems = budget.maxItems ?? MAX_MEDIA_ITEMS
  const maxItemBytes = budget.maxItemBytes ?? MAX_MEDIA_BYTES
  const maxTotalBytes = budget.maxTotalBytes ?? MAX_MEDIA_TOTAL_BYTES
  const concurrency = Math.max(1, budget.concurrency ?? MEDIA_LOAD_CONCURRENCY)
  assertMediaItemCount(refs.length, maxItems)
  const declared = refs.map(dataUrlDecodedSize)
  for (const bytes of declared) {
    if (bytes > maxItemBytes) {
      throw new MediaTooLargeError(`data URL is too large to analyze (limit ${maxItemBytes} bytes)`)
    }
  }
  const declaredTotal = declared.reduce((n, bytes) => n + bytes, 0)
  if (declaredTotal > maxTotalBytes) {
    throw new MediaBudgetExceededError(
      `Media in one request is too large to analyze (${declaredTotal} bytes, limit ${maxTotalBytes}); analyze it in smaller batches`,
    )
  }
  const blobs: MediaBlob[] = new Array(refs.length)
  let next = 0
  let landed = 0
  const worker = async (): Promise<void> => {
    while (next < refs.length) {
      const index = next++
      const blob = await loadMediaReference(refs[index]!)
      landed += blob.bytes.byteLength
      if (landed > maxTotalBytes) {
        throw new MediaBudgetExceededError(
          `Media in one request is too large to analyze (over ${maxTotalBytes} bytes); analyze it in smaller batches`,
        )
      }
      blobs[index] = blob
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, refs.length) }, () => worker()))
  return blobs
}

/** Genspark background-removal model — chained after generation for transparentBackground */
export const GSK_RMBG_MODEL = 'fal-bria-rmbg'

export type GenerateImageToolOp = GskGenerateImageOptions & {
  /** The result must have real PNG alpha (icons/logos/cutouts). Generation models cannot
   * produce transparency from the prompt alone — they paint a fake gray checkerboard into
   * the pixels — so the tool strips the background in a second pass instead. */
  transparentBackground?: boolean
}

const LOCAL_IMAGE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

// Best-effort removal of our own staging dirs (no /tmp leaks).
function rmrf(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // staging litter must never fail the tool
  }
}

// Local CLI image route: antigravity first (or mmx first when selected),
// then the other CLI when fallback is on. Transparency is only a prompt hint
// for the local CLIs (no background-removal second pass there).
async function localGenerateImage(
  settings: AiSettings,
  prompt: string,
  op: GenerateImageToolOp,
): Promise<{
  url?: string
  error?: string
  provider?: string
  attempts?: { provider: string; error: string }[]
}> {
  const cli = localCliSettingsOf(settings)
  const primary = activeMediaConfig(settings, 'image')?.provider
  const order = primary === 'mmx' ? ['mmx', 'antigravity'] : ['antigravity', 'mmx']
  if (!cli.fallback) order.splice(1)
  const attempts: { provider: string; error: string }[] = []
  const fullPrompt =
    op.transparentBackground === true
      ? prompt +
        ' The subject must be isolated on a clean, uniform background (transparent-background style cutout).'
      : prompt
  let referenceImagePaths: string[] = []
  let refDir: string | null = null
  try {
    const references = await loadMediaReferences(op.referenceImageUrls ?? [])
    if (references.length) {
      refDir = mkdtempSync(join(tmpdir(), 'teleoffice-imgref-'))
      referenceImagePaths = references.map((blob, i) => {
        const target = join(
          refDir as string,
          'ref-' + i + (LOCAL_IMAGE_EXT[blob.mime.toLowerCase()] ?? '.png'),
        )
        writeFileSync(target, blob.bytes)
        return target
      })
    }
    for (const id of order) {
      try {
        const image =
          id === 'mmx'
            ? await mmxGenerateImage(
                { prompt: fullPrompt, aspectRatio: op.aspectRatio, referenceImagePaths },
                settings,
              )
            : await agyGenerateImage(
                { prompt: fullPrompt, aspectRatio: op.aspectRatio, referenceImagePaths },
                settings,
              )
        return { url: storeGeneratedImage(image.bytes, image.mime), provider: id, attempts }
      } catch (err) {
        attempts.push({ provider: id, error: errorText(err) })
      }
    }
    return {
      error:
        attempts.map((a) => a.provider + ': ' + a.error).join('; ') || 'image generation failed',
      attempts,
    }
  } catch (err) {
    return { error: errorText(err), attempts }
  } finally {
    if (refDir) rmrf(refDir)
  }
}

export async function generateImageTool(
  settingsPath: string,
  op: GenerateImageToolOp,
  options: MediaToolOptions = {},
): Promise<{
  url?: string
  error?: string
  provider?: string
  attempts?: { provider: string; error: string }[]
}> {
  const prompt = String(op.prompt ?? '').trim()
  if (!prompt) return { error: 'prompt must not be empty' }
  const settings = readAiSettingsFile(settingsPath)
  const byok = activeMediaConfig(settings, 'image')
  try {
    if (!byok) {
      const gate = gskGate(settings, options.notLoggedInError ?? GSK_NOT_LOGGED_IN_ERROR)
      if (gate) return gate
      // gskGenerateImage hands the references straight to the CLI argv, so this route
      // enforces the same item ceiling as the BYOK one instead of passing them on
      assertMediaItemCount(op.referenceImageUrls?.length ?? 0, MEDIA_BUDGET.maxItems)
      const gen = await gskGenerateImage({ ...op, prompt })
      if (!op.transparentBackground || op.model === GSK_RMBG_MODEL) return { url: gen.url }
      try {
        const cut = await gskGenerateImage({
          prompt: 'remove the background completely, keep only the subject',
          model: GSK_RMBG_MODEL,
          referenceImageUrls: [gen.url],
        })
        return { url: cut.url }
      } catch {
        return { url: gen.url } // strip failed: the opaque image is still usable
      }
    }
    // Local CLI backends never reach the HTTP providers below (guarded there too).
    if (byok.provider === 'antigravity' || byok.provider === 'mmx') {
      const r = await localGenerateImage(settings, prompt, op)
      if (
        r.url ||
        !localCliBinariesMissing(settings) ||
        !hasGskAuth() ||
        !cloudToolsEnabled(settings)
      ) {
        return r
      }
      // Neither CLI binary exists while Genspark is available: run the gsk
      // route above and keep the CLI failures in attempts.
      const gate = gskGate(settings, options.notLoggedInError ?? GSK_NOT_LOGGED_IN_ERROR)
      if (gate) return { ...gate, attempts: [...(r.attempts ?? [])] }
      assertMediaItemCount(op.referenceImageUrls?.length ?? 0, MEDIA_BUDGET.maxItems)
      const gen = await gskGenerateImage({ ...op, prompt })
      const prior = [...(r.attempts ?? [])]
      if (!op.transparentBackground || op.model === GSK_RMBG_MODEL) {
        return prior.length ? { url: gen.url, attempts: prior } : { url: gen.url }
      }
      try {
        const cut = await gskGenerateImage({
          prompt: 'remove the background completely, keep only the subject',
          model: GSK_RMBG_MODEL,
          referenceImageUrls: [gen.url],
        })
        return prior.length ? { url: cut.url, attempts: prior } : { url: cut.url }
      } catch {
        return prior.length ? { url: gen.url, attempts: prior } : { url: gen.url }
      }
    }
    // `model` names Genspark-only special models (fal-*); BYOK uses the configured image model
    const references = await loadMediaReferences(op.referenceImageUrls ?? [])
    const image = await generateImageWithProvider(byok.provider, byok.config, {
      prompt,
      aspectRatio: op.aspectRatio,
      references,
      transparent: op.transparentBackground === true,
    })
    return { url: storeGeneratedImage(image.bytes, image.mime) }
  } catch (err) {
    return { error: errorText(err) }
  }
}

export async function analyzeMediaTool(
  settingsPath: string,
  op: { mediaUrls: string[]; requirements: string },
  options: MediaToolOptions = {},
): Promise<{
  text?: string
  error?: string
  provider?: string
  attempts?: { provider: string; error: string }[]
}> {
  const mediaUrls = (op.mediaUrls ?? []).map(String).filter(Boolean)
  const requirements = String(op.requirements ?? '').trim()
  if (!mediaUrls.length) return { error: 'mediaUrls must not be empty' }
  if (!requirements) return { error: 'requirements must not be empty' }
  const settings = readAiSettingsFile(settingsPath)
  const imageByok = activeMediaConfig(settings, 'analysis')
  const videoByok = activeMediaConfig(settings, 'video')
  try {
    const viaGsk = async () => {
      const gate = gskGate(settings, options.notLoggedInError ?? GSK_NOT_LOGGED_IN_ERROR)
      if (gate) return gate
      // gskAnalyzeMedia spreads the URLs straight into the CLI argv, so this route
      // enforces the same item ceiling as the BYOK one instead of passing them on
      assertMediaItemCount(mediaUrls.length, MEDIA_BUDGET.maxItems)
      return { text: await gskAnalyzeMedia({ mediaUrls, requirements }) }
    }
    if (!imageByok && !videoByok) return await viaGsk()
    // route on the loaded bytes' real MIME, not the URL spelling: images go to the
    // image-analysis provider, anything with video/audio to the video one
    let media: MediaBlob[]
    try {
      media = await loadMediaReferences(mediaUrls)
    } catch (err) {
      // only the size cap hands the request back to Genspark (the CLI streams large
      // files itself); scheme / path / SSRF rejections stay rejections
      if (err instanceof MediaTooLargeError && (!imageByok || !videoByok)) return await viaGsk()
      return { error: errorText(err) }
    }
    const hasVideo = media.some((m) => !m.mime.startsWith('image/'))
    const byok = hasVideo ? videoByok : imageByok
    if (!byok) return await viaGsk()
    if (byok.provider === 'antigravity' || byok.provider === 'mmx') {
      const r = await localAnalyzeMedia(settings, mediaUrls, media, requirements, byok.provider)
      if (
        r.text ||
        !localCliBinariesMissing(settings) ||
        !hasGskAuth() ||
        !cloudToolsEnabled(settings)
      ) {
        return r
      }
      // Neither CLI binary exists while Genspark is available: run the gsk
      // route and keep the CLI failures in attempts.
      const g = await viaGsk()
      return { ...g, attempts: [...(r.attempts ?? [])] }
    }
    return {
      text: await analyzeMediaWithProvider(byok.provider, byok.config, { media, requirements }),
    }
  } catch (err) {
    return { error: errorText(err) }
  }
}

const LOCAL_ANALYZE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
}

// Local CLI analysis route: the selected CLI first, then the other one when
// fallback is on. mmx vision reads images only: for audio/video inputs the
// agy error is reported instead of failing over to mmx.
async function localAnalyzeMedia(
  settings: AiSettings,
  mediaUrls: string[],
  media: MediaBlob[],
  requirements: string,
  primary: 'antigravity' | 'mmx',
): Promise<{
  text?: string
  error?: string
  provider?: string
  attempts?: { provider: string; error: string }[]
}> {
  const cli = localCliSettingsOf(settings)
  const imageOnly = media.every((m) => m.mime.startsWith('image/'))
  const order: Array<'antigravity' | 'mmx'> =
    primary === 'mmx' ? ['mmx', 'antigravity'] : ['antigravity', 'mmx']
  if (!cli.fallback) order.splice(1)
  const attempts: { provider: string; error: string }[] = []
  const staged: string[] = []
  const stageBlobs = (blobs: MediaBlob[]): string[] => {
    const dir = mkdtempSync(join(tmpdir(), 'teleoffice-analyze-'))
    staged.push(dir)
    return blobs.map((blob, i) => {
      const target = join(
        dir,
        'media-' + i + (LOCAL_ANALYZE_EXT[blob.mime.toLowerCase()] ?? '.bin'),
      )
      writeFileSync(target, blob.bytes)
      return target
    })
  }
  try {
    for (const id of order) {
      try {
        if (id === 'mmx') {
          if (!imageOnly) {
            throw new Error('MiniMax CLI (mmx) vision reads images only, not audio/video')
          }
          // https URLs go straight to mmx; everything else is already-loaded bytes.
          const dir = mkdtempSync(join(tmpdir(), 'teleoffice-analyze-'))
          staged.push(dir)
          const inputs = media.map((blob, i) => {
            const ref = mediaUrls[i] as string
            if (/^https?:\/\//i.test(ref)) return ref
            const target = join(
              dir,
              'media-' + i + (LOCAL_ANALYZE_EXT[blob.mime.toLowerCase()] ?? '.bin'),
            )
            writeFileSync(target, blob.bytes)
            return target
          })
          const parts: string[] = []
          for (const input of inputs) {
            parts.push(await mmxDescribe(input, requirements, settings))
          }
          return { text: parts.join('\n\n'), provider: 'mmx', attempts }
        }
        const text = await agyDescribe(stageBlobs(media), requirements, settings)
        return { text, provider: 'antigravity', attempts }
      } catch (err) {
        attempts.push({ provider: id, error: errorText(err) })
        // mmx cannot read audio/video at all: report the agy error, do not fail over.
        if (id === 'antigravity' && !imageOnly && order.includes('mmx')) break
      }
    }
    return {
      error: attempts.map((a) => a.provider + ': ' + a.error).join('; ') || 'media analysis failed',
      attempts,
    }
  } finally {
    for (const dir of staged) rmrf(dir)
  }
}

// -- speech + video tools (local CLIs only) --------------------------

export interface SynthesizeSpeechToolOp {
  text?: string
  textFile?: string
  out?: string
  voice?: string
  format?: string
  model?: string
  speed?: number
  emotion?: string
  language?: string
}

// Text to speech through mmx (the only local TTS backend).
export async function synthesizeSpeechTool(
  settingsPath: string,
  op: SynthesizeSpeechToolOp,
): Promise<{ path?: string; bytes?: Uint8Array; error?: string; provider?: string }> {
  const settings = readAiSettingsFile(settingsPath)
  let text = String(op.text ?? '')
  if (op.textFile) {
    try {
      text = readFileSync(op.textFile, 'utf-8')
    } catch (err) {
      return { error: 'could not read text file: ' + errorText(err) }
    }
  }
  if (!text.trim()) return { error: 'text must not be empty' }
  const format = op.format || 'mp3'
  const out = op.out ?? join(tmpdir(), 'speech-' + Date.now() + '.' + format)
  try {
    const r = await mmxSynthesize(
      {
        text,
        out,
        ...(op.voice !== undefined ? { voice: op.voice } : {}),
        ...(op.format !== undefined ? { format: op.format } : {}),
        ...(op.model !== undefined ? { model: op.model } : {}),
        ...(op.speed !== undefined ? { speed: op.speed } : {}),
        ...(op.emotion !== undefined ? { emotion: op.emotion } : {}),
        ...(op.language !== undefined ? { language: op.language } : {}),
      },
      settings,
    )
    return { path: r.path, bytes: r.bytes, provider: 'mmx' }
  } catch (err) {
    return { error: errorText(err) }
  }
}

// Ensure a tool-supplied audio reference is a local file mmx can read.

// Materialise a remote audio reference into the given staging dir; plain
// local paths pass through untouched.
async function ensureLocalAudioFile(ref: string, dir: string): Promise<string> {
  if (/^https?:\/\//i.test(ref) || ref.startsWith('data:') || ref.startsWith('file:')) {
    const blob = await loadMediaReference(ref)
    const target = join(dir, 'audio' + (LOCAL_ANALYZE_EXT[blob.mime.toLowerCase()] ?? '.bin'))
    writeFileSync(target, blob.bytes)
    return target
  }
  return ref
}

// Speech transcription: agy first (hears audio via view_file), mmx fallback.
export async function transcribeAudioTool(
  settingsPath: string,
  op: { path: string; language?: string },
): Promise<{
  text?: string
  error?: string
  provider?: string
  attempts?: { provider: string; error: string }[]
}> {
  const ref = String(op.path ?? '')
  if (!ref) return { error: 'path must not be empty' }
  const settings = readAiSettingsFile(settingsPath)
  const cli = localCliSettingsOf(settings)
  const language = op.language ?? cli.asrLanguage
  const attempts: { provider: string; error: string }[] = []
  try {
    return { text: await agyTranscribe(ref, language, settings), provider: 'antigravity', attempts }
  } catch (err) {
    attempts.push({ provider: 'antigravity', error: errorText(err) })
  }
  if (!cli.fallback) {
    return { error: attempts.map((a) => a.provider + ': ' + a.error).join('; '), attempts }
  }
  const staging = mkdtempSync(join(tmpdir(), 'teleoffice-asr-'))
  try {
    const local = await ensureLocalAudioFile(ref, staging)
    return { text: await mmxTranscribe(local, language, settings), provider: 'mmx', attempts }
  } catch (err) {
    attempts.push({ provider: 'mmx', error: errorText(err) })
    return { error: attempts.map((a) => a.provider + ': ' + a.error).join('; '), attempts }
  } finally {
    rmrf(staging)
  }
}

export interface GenerateVideoToolOp {
  prompt: string
  out?: string
  image?: string
  model?: string
  duration?: number
  ratio?: string
  async?: boolean
}

// Video generation: agy only when explicitly enabled (it has no video tool),
// then mmx. agy bytes are written to out; mmx downloads there itself.
export async function generateVideoTool(
  settingsPath: string,
  op: GenerateVideoToolOp,
): Promise<{
  path?: string
  taskId?: string
  status?: string
  fileId?: string
  error?: string
  provider?: string
  attempts?: { provider: string; error: string }[]
}> {
  const prompt = String(op.prompt ?? '').trim()
  if (!prompt) return { error: 'prompt must not be empty' }
  const settings = readAiSettingsFile(settingsPath)
  const cli = localCliSettingsOf(settings)
  const attempts: { provider: string; error: string }[] = []
  const out = op.out ?? join(tmpdir(), 'video-' + Date.now() + '.mp4')
  const order: Array<'antigravity' | 'mmx'> = cli.agyVideo ? ['antigravity', 'mmx'] : ['mmx']
  if (!cli.fallback) order.splice(1)
  // agyVideo off means agy is never attempted: say so up front so the CLI
  // error explains why only mmx appears in the attempts.
  if (!cli.agyVideo) {
    attempts.push({
      provider: 'antigravity',
      error: 'skipped: agy has no video generation tool (localCli.agyVideo=false)',
    })
  }
  for (const id of order) {
    try {
      if (id === 'antigravity') {
        const video = await agyVideoGenerate({ prompt }, settings)
        writeFileSync(out, video.bytes)
        return { path: out, provider: 'antigravity', attempts }
      }
      const r = await mmxVideoGenerate(
        {
          prompt,
          out,
          ...(op.image !== undefined ? { image: op.image } : {}),
          ...(op.model !== undefined ? { model: op.model } : {}),
          ...(op.duration !== undefined ? { duration: op.duration } : {}),
          ...(op.ratio !== undefined ? { ratio: op.ratio } : {}),
          ...(op.async !== undefined ? { async: op.async } : {}),
        },
        settings,
      )
      return {
        ...(r.path !== undefined ? { path: r.path } : {}),
        ...(r.taskId ? { taskId: r.taskId } : {}),
        ...(r.status !== undefined ? { status: r.status } : {}),
        ...(r.fileId !== undefined ? { fileId: r.fileId } : {}),
        provider: 'mmx',
        attempts,
      }
    } catch (err) {
      attempts.push({ provider: id, error: errorText(err) })
    }
  }
  return {
    error: attempts.map((a) => a.provider + ': ' + a.error).join('; ') || 'video generation failed',
    attempts,
  }
}

// mmx video task status (no agy equivalent).
export async function videoTaskTool(
  settingsPath: string,
  op: { taskId: string; model?: string },
): Promise<{ result?: unknown; error?: string; provider?: string }> {
  const taskId = String(op.taskId ?? '').trim()
  if (!taskId) return { error: 'taskId must not be empty' }
  const settings = readAiSettingsFile(settingsPath)
  try {
    const result = await mmxVideoTask(taskId, op.model, settings)
    return { result, provider: 'mmx' }
  } catch (err) {
    return { error: errorText(err) }
  }
}

// mmx video file download (no agy equivalent).
export async function videoDownloadTool(
  settingsPath: string,
  op: { fileId: string; out: string },
): Promise<{ path?: string; error?: string; provider?: string }> {
  const fileId = String(op.fileId ?? '').trim()
  if (!fileId) return { error: 'fileId must not be empty' }
  if (!op.out) return { error: 'out must not be empty' }
  const settings = readAiSettingsFile(settingsPath)
  try {
    const path = await mmxVideoDownload(fileId, op.out, settings)
    return { path, provider: 'mmx' }
  } catch (err) {
    return { error: errorText(err) }
  }
}
