import { imageSearchTool, webSearchTool } from '@genoffice/ai-search'
import { flagBool, flagString } from '../args'
import { aiSettingsPath, prepareCloud } from '../cloud'
import type { CommandDef } from '../registry'
import { CliError, EXIT } from '../result'

const VIA_VALUES = ['auto', 'mmx', 'agy']
const REGION_VALUES = ['cn', 'intl']

export const searchCommand: CommandDef = {
  name: 'search',
  summary:
    'Web or image search (default: local CLIs - mmx for Chinese queries, Antigravity agy for foreign - with Genspark/BYOK fallbacks).',
  usage: 'search <query> [--images] [--max <n>] [--via <auto|mmx|agy>] [--region <cn|intl>]',
  options: [
    { name: 'images', description: 'search images instead of web pages' },
    { name: 'max', value: 'n', description: 'result count (default 6 web, 8 images; at most 20)' },
    { name: 'via', value: 'backend', description: 'force a local CLI backend: auto | mmx | agy' },
    { name: 'region', value: 'region', description: 'alias for --via: cn (= mmx) | intl (= agy)' },
  ],
  async run(args, ctx) {
    const query = args.positionals.join(' ').trim()
    if (!query)
      throw new CliError(EXIT.usage, 'missing <query>', undefined, { reason: 'missing_argument' })
    const max = resultCount(flagString(args, 'max'))
    const via = viaOverride(flagString(args, 'via'), flagString(args, 'region'))
    await prepareCloud(ctx.env)
    const settings = aiSettingsPath(ctx.env)
    if (flagBool(args, 'images')) {
      const r = await imageSearchTool(settings, query, max ?? 8)
      if (r.method === 'error') throw new CliError(EXIT.app, r.error ?? 'image search failed')
      return {
        summary: `${r.images.length} images for "${query}" via ${r.method}`,
        detail: { method: r.method, images: r.images },
      }
    }
    const r = await webSearchTool(
      settings,
      query,
      max ?? 6,
      via !== undefined ? { via } : undefined,
    )
    if (r.method === 'error') throw new CliError(EXIT.app, r.error ?? 'search failed')
    return {
      summary: `${r.results.length} results for "${query}" via ${r.method}`,
      detail: {
        method: r.method,
        ...(r.answer ? { answer: r.answer } : {}),
        results: r.results,
        ...('attempts' in r && r.attempts ? { attempts: r.attempts } : {}),
      },
    }
  },
}

// --via wins over --region; auto means no override (routing decides).
export function viaOverride(
  via: string | undefined,
  region: string | undefined,
): string | undefined {
  if (via !== undefined) {
    if (!VIA_VALUES.includes(via)) {
      throw new CliError(EXIT.usage, `--via must be one of ${VIA_VALUES.join(', ')}`, undefined, {
        reason: 'invalid_argument',
      })
    }
    return via === 'auto' ? undefined : via
  }
  if (region !== undefined) {
    if (!REGION_VALUES.includes(region)) {
      throw new CliError(
        EXIT.usage,
        `--region must be one of ${REGION_VALUES.join(', ')}`,
        undefined,
        { reason: 'invalid_argument' },
      )
    }
    return region
  }
  return undefined
}

/** `--max` clamped to 1..20; undefined when absent so each mode keeps its own default. */
export function resultCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n))
    throw new CliError(EXIT.usage, `--max must be a number, got "${raw}"`, undefined, {
      reason: 'invalid_argument',
    })
  return Math.min(20, Math.max(1, Math.floor(n)))
}
