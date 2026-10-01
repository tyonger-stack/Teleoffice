import { randomBytes } from 'node:crypto'
import { extname } from 'node:path'
import { generateVideoTool, videoDownloadTool, videoTaskTool } from '@teleoffice/ai-search'
import { flagBool, flagString } from '../args'
import { aiSettingsPath, prepareCloud } from '../cloud'
import { resolveInput, resolveOutput } from '../fs'
import type { CommandDef } from '../registry'
import { CliError, EXIT } from '../result'

export const videoCommand: CommandDef = {
  name: 'video',
  summary:
    'Generate a video from a prompt with the MiniMax CLI (mmx); query tasks and download files.',
  usage:
    'video <prompt> [--out <file>] [--image <path>] [--model <id>] [--duration <n>] [--ratio <r>] [--async] [--force] | video --task <id> [--model <id>] | video --file-id <id> --out <file> [--force]',
  options: [
    { name: 'out', value: 'file', description: 'where to save (default: video-<time>.mp4 in cwd)' },
    { name: 'image', value: 'path', description: 'first-frame image for image-to-video' },
    { name: 'model', value: 'id', description: 'mmx video model id' },
    { name: 'duration', value: 'n', description: 'clip duration in seconds (model permitting)' },
    { name: 'ratio', value: 'r', description: 'aspect ratio (model permitting)' },
    { name: 'async', description: 'return the task id immediately without downloading' },
    { name: 'task', value: 'id', description: 'query a video task status instead of generating' },
    {
      name: 'file-id',
      value: 'id',
      description: 'download a finished video file instead of generating',
    },
    { name: 'force', description: 'overwrite an existing output file' },
  ],
  async run(args, ctx) {
    const taskId = flagString(args, 'task')
    const fileId = flagString(args, 'file-id')
    await prepareCloud(ctx.env)
    const settings = aiSettingsPath(ctx.env)
    if (taskId) {
      const r = await videoTaskTool(settings, {
        taskId,
        ...(flagString(args, 'model') !== undefined
          ? { model: flagString(args, 'model') as string }
          : {}),
      })
      if (r.result === undefined) throw new CliError(EXIT.app, r.error ?? 'video task query failed')
      const status =
        r.result && typeof r.result === 'object'
          ? String((r.result as Record<string, unknown>).status ?? 'see detail')
          : 'see detail'
      return {
        summary: 'task ' + taskId + ': ' + status,
        detail: { task_id: taskId, result: r.result, provider: r.provider ?? 'mmx' },
      }
    }
    if (fileId) {
      const out = flagString(args, 'out')
      if (!out)
        throw new CliError(EXIT.usage, 'video --file-id needs --out <file>', undefined, {
          reason: 'missing_argument',
        })
      const force = flagBool(args, 'force')
      const chosen = resolveOutput(out, ctx, { force, fresh: true })
      const r = await videoDownloadTool(settings, { fileId, out: chosen })
      if (!r.path)
        throw new CliError(EXIT.app, r.error ?? 'video download failed', undefined, {
          suggestion: 'check the file id and that the mmx CLI is logged in, or retry once later',
        })
      return {
        summary: 'saved video to ' + chosen,
        outputPath: chosen,
        detail: { path: r.path, provider: r.provider ?? 'mmx' },
      }
    }
    const prompt = args.positionals.join(' ').trim()
    if (!prompt)
      throw new CliError(EXIT.usage, 'missing <prompt>', undefined, { reason: 'missing_argument' })
    const durationRaw = flagString(args, 'duration')
    let duration: number | undefined
    if (durationRaw !== undefined) {
      duration = Number(durationRaw)
      if (!Number.isFinite(duration)) {
        throw new CliError(
          EXIT.usage,
          '--duration must be a number, got "' + durationRaw + '"',
          undefined,
          { reason: 'invalid_argument' },
        )
      }
    }
    const imageRaw = flagString(args, 'image')
    const image = imageRaw
      ? /^https?:\/\//i.test(imageRaw)
        ? imageRaw
        : resolveInput(imageRaw, ctx)
      : undefined
    const out = flagString(args, 'out')
    const force = flagBool(args, 'force')
    const stem = out ?? 'video-' + stamp()
    const outExt = out ? extname(out).slice(1).toLowerCase() : ''
    const chosen = resolveOutput(out && outExt ? out : stem + '.mp4', ctx, {
      force,
      fresh: true,
    })
    const isAsync = flagBool(args, 'async')
    const r = await generateVideoTool(settings, {
      prompt,
      out: chosen,
      ...(image !== undefined ? { image } : {}),
      ...(flagString(args, 'model') !== undefined
        ? { model: flagString(args, 'model') as string }
        : {}),
      ...(duration !== undefined ? { duration } : {}),
      ...(flagString(args, 'ratio') !== undefined
        ? { ratio: flagString(args, 'ratio') as string }
        : {}),
      ...(isAsync ? { async: true } : {}),
    })
    if (r.error !== undefined || (!r.path && !r.taskId)) {
      throw new CliError(EXIT.app, r.error ?? 'video generation failed', undefined, {
        suggestion: 'check that the mmx CLI is installed and logged in, or retry once later',
      })
    }
    if (r.path) {
      return {
        summary: 'saved video to ' + (r.path as string),
        outputPath: r.path as string,
        detail: {
          path: r.path,
          ...(r.taskId ? { task_id: r.taskId } : {}),
          ...(r.status ? { status: r.status } : {}),
          ...(r.fileId ? { file_id: r.fileId } : {}),
          provider: r.provider ?? 'mmx',
          ...(r.attempts?.length ? { attempts: r.attempts } : {}),
        },
      }
    }
    return {
      summary: 'task ' + (r.taskId as string) + ' started',
      detail: {
        task_id: r.taskId,
        provider: r.provider ?? 'mmx',
        ...(r.attempts?.length ? { attempts: r.attempts } : {}),
      },
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
