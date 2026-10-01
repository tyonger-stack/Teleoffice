import { basename } from 'node:path'
import { flagBool, flagString } from '../args'
import { readInput } from '../fs'
import { resolveTemplateSource } from '../formats/slide-spec'
import { inspectTemplate, type TemplateInfo } from '@genoffice/pipelines/slides'
import {
  addTemplate,
  listTemplates,
  removeTemplate,
  templatesDir,
} from '@genoffice/pipelines/slides/templates'
import type { CommandContext, CommandDef } from '../registry'
import { CliError, EXIT } from '../result'

export const templateCommand: CommandDef = {
  name: 'template',
  summary: 'Inspect, list and manage the .pptx templates for template-mode deck builds.',
  usage: 'template <inspect|list|add|remove|path>',
  options: [
    { name: 'copy', description: 'add: copy the file into the templates directory' },
    { name: 'master', value: 'n', description: 'add: default slide-master index' },
    { name: 'font', value: 'family', description: 'add: default typeface' },
    { name: 'description', value: 'text', description: 'add: one-line note with the template' },
    { name: 'force', description: 'add: overwrite an existing template of the same name' },
  ],
  async run(args, ctx) {
    const [verb, first, second] = args.positionals
    switch (verb) {
      case 'inspect':
        return inspectTemplateFile(first, ctx)
      case 'list':
        return list(ctx)
      case 'add':
        return add(first, second, args, ctx)
      case 'remove':
        return remove(first, ctx)
      case 'path':
        return path(ctx)
      default:
        throw new CliError(
          EXIT.usage,
          'expected template inspect|list|add|remove|path',
          { supported: ['inspect', 'list', 'add', 'remove', 'path'] },
          {
            reason: verb === undefined ? 'missing_argument' : 'invalid_argument',
            suggestion: 'run genoffice help template',
          },
        )
    }
  },
}

// One hint line per layout, naming the placeholder slots a page spec can fill.
export function templateUsage(info: TemplateInfo): string[] {
  const lines: string[] = []
  for (const m of info.masters) {
    for (const l of m.layouts) {
      const phs = l.placeholders.map((p) => p.type + '(' + p.idx + ')').join(' ')
      lines.push(
        'layout "' +
          l.name +
          '" (index ' +
          l.index +
          ', master ' +
          l.master +
          '): placeholders ' +
          (phs || '(none)'),
      )
    }
  }
  return lines
}

export async function inspectTemplateFile(
  fileOrName: string | undefined,
  ctx: CommandContext,
): Promise<{ summary: string; detail: Record<string, unknown> }> {
  if (!fileOrName) {
    throw new CliError(EXIT.usage, 'missing file or name to inspect', undefined, {
      reason: 'missing_argument',
    })
  }
  const resolved = resolveTemplateSource(fileOrName, ctx)
  const info = await inspectTemplate(new Uint8Array(readInput(resolved.path)))
  const layouts = info.masters.flatMap((m) => m.layouts).length
  return {
    summary:
      basename(resolved.path) +
      ': ' +
      info.masters.length +
      ' masters, ' +
      layouts +
      ' layouts, ' +
      info.slideSize.px.w +
      'x' +
      info.slideSize.px.h +
      ' px',
    detail: {
      ...info,
      canvas: info.slideSize.px,
      usage: templateUsage(info),
      ...(resolved.name ? { name: resolved.name } : {}),
      path: resolved.path,
    },
  }
}

function list(ctx: CommandContext): { summary: string; detail: Record<string, unknown> } {
  const dir = templatesDir(ctx.env)
  const templates = listTemplates(ctx.env)
  return {
    summary:
      templates.length === 0
        ? 'no templates in ' + dir
        : templates.length + ' template(s) in ' + dir,
    detail: { dir, templates },
  }
}

function add(
  name: string | undefined,
  file: string | undefined,
  args: Parameters<CommandDef['run']>[0],
  ctx: CommandContext,
): { summary: string; detail: Record<string, unknown> } {
  if (!name) {
    throw new CliError(EXIT.usage, 'missing name for the template', undefined, {
      reason: 'missing_argument',
    })
  }
  if (!file) {
    throw new CliError(EXIT.usage, 'missing file to register', undefined, {
      reason: 'missing_argument',
    })
  }
  const masterRaw = flagString(args, 'master')
  let master: number | undefined
  if (masterRaw !== undefined) {
    master = Number(masterRaw)
    if (!Number.isInteger(master) || master < 0) {
      throw new CliError(
        EXIT.usage,
        'master must be a 0-based master index, got ' + masterRaw,
        undefined,
        { reason: 'invalid_argument' },
      )
    }
  }
  const font = flagString(args, 'font')
  const description = flagString(args, 'description')
  try {
    const added = addTemplate(
      name,
      file,
      {
        copy: flagBool(args, 'copy'),
        ...(master !== undefined ? { master } : {}),
        ...(font !== undefined ? { font } : {}),
        ...(description !== undefined ? { description } : {}),
        force: flagBool(args, 'force'),
        cwd: ctx.cwd,
      },
      ctx.env,
    )
    return { summary: 'added template ' + added.name, detail: { ...added } }
  } catch (err) {
    throw new CliError(EXIT.usage, err instanceof Error ? err.message : String(err), undefined, {
      reason: 'invalid_argument',
    })
  }
}

function remove(
  name: string | undefined,
  ctx: CommandContext,
): { summary: string; detail: Record<string, unknown> } {
  if (!name) {
    throw new CliError(EXIT.usage, 'missing name to remove', undefined, {
      reason: 'missing_argument',
    })
  }
  try {
    const r = removeTemplate(name, ctx.env)
    return {
      summary: 'removed template ' + name.toLowerCase(),
      detail: { name: name.toLowerCase(), ...r },
    }
  } catch (err) {
    throw new CliError(EXIT.usage, err instanceof Error ? err.message : String(err), undefined, {
      reason: 'invalid_argument',
    })
  }
}

function path(ctx: CommandContext): { summary: string; detail: Record<string, unknown> } {
  const dir = templatesDir(ctx.env)
  return { summary: dir, detail: { path: dir } }
}
