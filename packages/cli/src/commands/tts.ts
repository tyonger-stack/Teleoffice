import { randomBytes } from 'node:crypto'
import { extname } from 'node:path'
import { synthesizeSpeechTool } from '@genoffice/ai-search'
import { flagBool, flagString } from '../args'
import { aiSettingsPath, prepareCloud } from '../cloud'
import { resolveInput, resolveOutput, writeOutput } from '../fs'
import type { CommandDef } from '../registry'
import { CliError, EXIT } from '../result'

const FORMATS = ['mp3', 'wav', 'flac', 'pcm', 'opus']

export const ttsCommand: CommandDef = {
  name: 'tts',
  summary: 'Synthesize speech from text with the MiniMax CLI (mmx) and save it as an audio file.',
  usage:
    'tts <text> [--out <file>] [--voice <id>] [--format mp3] [--text-file <path>] [--speed <n>] [--emotion <e>] [--language <code>] [--force]',
  options: [
    { name: 'out', value: 'file', description: 'where to save (default: speech-<time>.mp3 in cwd)' },
    { name: 'voice', value: 'id', description: 'mmx voice id (default: Chinese voice for Han text)' },
    { name: 'format', value: 'fmt', description: 'mp3 | wav | flac | pcm | opus (default mp3)' },
    { name: 'text-file', value: 'path', description: 'read the text from a file instead of <text>' },
    { name: 'speed', value: 'n', description: 'speech speed multiplier' },
    { name: 'emotion', value: 'e', description: 'mmx emotion hint' },
    { name: 'language', value: 'code', description: 'mmx language code' },
    { name: 'force', description: 'overwrite an existing output file' },
  ],
  async run(args, ctx) {
    const text = args.positionals.join(' ').trim()
    const textFileRaw = flagString(args, 'text-file')
    if (!text && !textFileRaw) {
      throw new CliError(EXIT.usage, 'missing <text> (or --text-file)', undefined, {
        reason: 'missing_argument',
      })
    }
    const format = flagString(args, 'format') ?? 'mp3'
    if (!FORMATS.includes(format)) {
      throw new CliError(EXIT.usage, '--format must be one of ' + FORMATS.join(', '), undefined, {
        reason: 'invalid_argument',
      })
    }
    const speedRaw = flagString(args, 'speed')
    let speed: number | undefined
    if (speedRaw !== undefined) {
      speed = Number(speedRaw)
      if (!Number.isFinite(speed)) {
        throw new CliError(EXIT.usage, '--speed must be a number, got "' + speedRaw + '"', undefined, {
          reason: 'invalid_argument',
        })
      }
    }
    const textFile = textFileRaw ? resolveInput(textFileRaw, ctx) : undefined
    const out = flagString(args, 'out')
    const force = flagBool(args, 'force')
    const stem = out ?? 'speech-' + stamp()
    const outExt = out ? extname(out).slice(1).toLowerCase() : ''
    const chosen = resolveOutput(out && outExt ? out : stem + '.' + format, ctx, {
      force,
      fresh: true,
    })
    await prepareCloud(ctx.env)
    const r = await synthesizeSpeechTool(aiSettingsPath(ctx.env), {
      ...(text ? { text } : {}),
      ...(textFile ? { textFile } : {}),
      out: chosen,
      ...(flagString(args, 'voice') !== undefined ? { voice: flagString(args, 'voice') as string } : {}),
      format,
      ...(speed !== undefined ? { speed } : {}),
      ...(flagString(args, 'emotion') !== undefined
        ? { emotion: flagString(args, 'emotion') as string }
        : {}),
      ...(flagString(args, 'language') !== undefined
        ? { language: flagString(args, 'language') as string }
        : {}),
    })
    if (!r.path || !r.bytes) {
      throw new CliError(EXIT.app, r.error ?? 'speech synthesis failed', undefined, {
        suggestion:
          'check that the mmx CLI is installed and logged in, or retry once later',
      })
    }
    writeOutput(chosen, r.bytes)
    return {
      summary: 'saved ' + r.bytes.byteLength + ' bytes (' + format + ') to ' + chosen,
      outputPath: chosen,
      detail: { bytes: r.bytes.byteLength, format, path: r.path, provider: r.provider ?? 'mmx' },
    }
  },
}

// yyyymmdd-hhmmssmmm plus a random tail, so two runs in the same instant do not collide
function stamp(): string {
  return (
    new Date().toISOString().replace(/[-:.]/g, '').replace('Z', '').replace('T', '-') +
    '-' +
    randomBytes(2).toString('hex')
  )
}
