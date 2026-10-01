import { basename, isAbsolute, resolve } from 'node:path'
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
    { name: 'start-layout', value: 'name', description: 'add: starter layout for new decks' },
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

async function add(
  name: string | undefined,
  file: string | undefined,
  args: Parameters<CommandDef['run']>[0],
  ctx: CommandContext,
): Promise<{ summary: string; detail: Record<string, unknown> }> {
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
  const startLayoutRaw = flagString(args, 'start-layout')
  let startLayout: string | undefined
  if (startLayoutRaw !== undefined) {
    if (!startLayoutRaw.trim()) {
      throw new CliError(EXIT.usage, 'start-layout must be a layout name', undefined, {
        reason: 'invalid_argument',
      })
    }
    startLayout = startLayoutRaw.trim()
    await assertStartLayout(file, startLayout, master, ctx)
  }
  try {
    const added = addTemplate(
      name,
      file,
      {
        copy: flagBool(args, 'copy'),
        ...(master !== undefined ? { master } : {}),
        ...(font !== undefined ? { font } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(startLayout !== undefined ? { startLayout } : {}),
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

// Async startLayout check against the real template bytes so a typo fails
// at add time with the available names (the registry re-checks synchronously).
async function assertStartLayout(
  file: string,
  startLayout: string,
  master: number | undefined,
  ctx: CommandContext,
): Promise<void> {
  const abs = isAbsolute(file) ? file : resolve(ctx.cwd, file)
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(readInput(abs))
  } catch {
    return
  }
  let info: TemplateInfo
  try {
    info = await inspectTemplate(bytes)
  } catch {
    return
  }
  const flatCount = info.masters.flatMap((m) => m.layouts).length
  const raw = startLayout.trim()
  const fail = (message: string): never => {
    throw new CliError(EXIT.usage, message, undefined, { reason: 'invalid_argument' })
  }
  const scoped = /^(\d+)\s*:\s*(.+)$/.exec(raw)
  if (scoped) {
    const scope = Number(scoped[1])
    const name = (scoped[2] ?? '').trim()
    const pool = info.masters[scope]?.layouts ?? []
    if (!Number.isInteger(scope) || !info.masters[scope]) {
      fail(
        'unknown master ' +
          String(scoped[1]) +
          ' in start layout "' +
          raw +
          '" (this template has ' +
          info.masters.length +
          ' masters, 0-' +
          (info.masters.length - 1) +
          ')',
      )
    }
    if (pool.some((l) => l.name === name || l.name.toLowerCase() === name.toLowerCase())) return
    fail(
      'unknown start layout "' +
        name +
        '" in master ' +
        scope +
        '; available layouts: ' +
        (pool.map((l) => l.name).join(', ') || '(none)'),
    )
  }
  if (/^\d+$/.test(raw)) {
    const n = Number(raw)
    if (n < 0 || n >= flatCount) {
      fail(
        'unknown start layout index ' +
          n +
          ' (this template has ' +
          flatCount +
          ' layouts, 0-' +
          (flatCount - 1) +
          ')',
      )
    }
    return
  }
  if (master !== undefined) {
    const pool = info.masters[master]?.layouts ?? []
    if (!info.masters[master]) {
      fail(
        'unknown master ' +
          String(master) +
          ' for start layout "' +
          raw +
          '" (this template has ' +
          info.masters.length +
          ' masters)',
      )
    }
    if (pool.some((l) => l.name === raw || l.name.toLowerCase() === raw.toLowerCase())) return
    fail(
      'unknown start layout "' +
        raw +
        '" in master ' +
        master +
        '; available layouts: ' +
        (pool.map((l) => l.name).join(', ') || '(none)'),
    )
  }
  const all = info.masters.flatMap((m) => m.layouts)
  if (all.some((l) => l.name === raw || l.name.toLowerCase() === raw.toLowerCase())) return
  const seen = new Set<string>()
  const names: string[] = []
  for (const l of all) {
    if (!seen.has(l.name)) {
      seen.add(l.name)
      names.push(l.name)
    }
  }
  fail(
    'unknown start layout "' +
      raw +
      '"; available layouts (any master): ' +
      (names.join(', ') || '(none)'),
  )
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
      summary:
        r.keptFile !== undefined
          ? 'removed template ' + name.toLowerCase() + ' (kept file ' + r.keptFile + ')'
          : 'removed template ' + name.toLowerCase(),
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
