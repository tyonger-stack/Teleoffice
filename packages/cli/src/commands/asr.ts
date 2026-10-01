import { fileURLToPath } from 'node:url'
import { transcribeAudioTool } from '@teleoffice/ai-search'
import { flagString } from '../args'
import { aiSettingsPath, prepareCloud } from '../cloud'
import { resolveInput } from '../fs'
import type { CommandDef } from '../registry'
import { CliError, EXIT } from '../result'

export const asrCommand: CommandDef = {
  name: 'asr',
  summary:
    'Transcribe speech in an audio file to text (Antigravity agy first, MiniMax mmx fallback).',
  usage: 'asr <audio file> [--language <code>]',
  options: [{ name: 'language', value: 'code', description: 'audio language (default zh)' }],
  async run(args, ctx) {
    const ref = args.positionals[0]
    if (!ref)
      throw new CliError(EXIT.usage, 'missing <audio file>', undefined, {
        reason: 'missing_argument',
      })
    const target = /^https?:\/\//i.test(ref)
      ? ref
      : resolveInput(ref.startsWith('file:') ? fileURLToPath(ref) : ref, ctx)
    await prepareCloud(ctx.env)
    const r = await transcribeAudioTool(aiSettingsPath(ctx.env), {
      path: target,
      ...(flagString(args, 'language') !== undefined
        ? { language: flagString(args, 'language') as string }
        : {}),
    })
    if (r.text === undefined)
      throw new CliError(EXIT.app, r.error ?? 'transcription failed', undefined, {
        suggestion:
          'check that the audio file is readable and the agy/mmx CLIs are set up, or retry once later',
      })
    return {
      summary: r.text,
      detail: {
        source: target,
        text: r.text,
        ...(r.provider ? { provider: r.provider } : {}),
        ...(r.attempts?.length ? { attempts: r.attempts } : {}),
      },
    }
  },
}
