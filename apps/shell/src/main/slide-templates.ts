// Desktop template decks: list, create and import .pptx templates.
// Pure Node (no electron imports) so the logic stays unit-testable.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import { buildTemplateDeck, inspectTemplate } from '@genoffice/pipelines/slides'
import {
  addTemplate,
  listTemplates,
  resolveTemplate,
  templatesDir,
} from '@genoffice/pipelines/slides/templates'

export interface SlideTemplateItem {
  name: string
  path: string
  exists: boolean
  description?: string
  source: 'registry' | 'file'
}

// List the registry templates for the home-screen picker.
export function listSlideTemplates(env: NodeJS.ProcessEnv = process.env): SlideTemplateItem[] {
  return listTemplates(env).map((t) => ({
    name: t.name,
    path: t.path,
    exists: t.exists,
    ...(t.description !== undefined ? { description: t.description } : {}),
    source: t.source,
  }))
}

// Create the templates directory when it does not exist yet.
export function ensureTemplatesDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = templatesDir(env)
  mkdirSync(dir, { recursive: true })
  return dir
}

function slugifyStem(stem: string): string | undefined {
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64)
  if (/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) return slug
  return undefined
}

function freeName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const suffix = '-' + i
    const candidate = base.slice(0, 64 - suffix.length) + suffix
    if (!taken.has(candidate)) return candidate
  }
}

// Import a .pptx file into the registry (copied), picking a free slug name.
export function importSlideTemplate(
  sourcePath: string,
  env: NodeJS.ProcessEnv = process.env,
): { name: string; path: string } {
  if (typeof sourcePath !== 'string' || !sourcePath) throw new Error('Invalid template path.')
  if (extname(sourcePath).toLowerCase() !== '.pptx') {
    throw new Error('Template file must be a .pptx file: ' + sourcePath)
  }
  const stem = basename(sourcePath, extname(sourcePath))
  const taken = new Set(listTemplates(env).map((t) => t.name))
  const slug = slugifyStem(stem)
  // Non-ASCII stems slugify to nothing, so fall back to template/template-2...
  const base = slug ?? 'template'
  const name = freeName(base, taken)
  return addTemplate(name, sourcePath, { copy: true }, env)
}

function uniqueDeckPath(dir: string, base: string): string {
  const first = join(dir, base + '.pptx')
  if (!existsSync(first)) return first
  for (let i = 2; ; i++) {
    const candidate = join(dir, base + ' ' + i + '.pptx')
    if (!existsSync(candidate)) return candidate
  }
}

// Build a one-slide starter deck from a template and write it atomically.
export async function createDeckFromTemplate(
  name: string,
  dir: string,
  untitledBase: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (typeof name !== 'string' || !name) throw new Error('Invalid template name.')
  const resolved = resolveTemplate(name, { env })
  const bytes = new Uint8Array(readFileSync(resolved.path))
  const info = await inspectTemplate(bytes)
  if (info.masters.length === 0) throw new Error('Template has no masters.')
  let layoutIndex: number | undefined
  const firstSample = info.slides[0]?.layout
  // A registry master wins over the sample slides, which may sit on another master.
  if (resolved.master === undefined && typeof firstSample === 'number' && firstSample >= 0) {
    layoutIndex = firstSample
  } else {
    const masterIdx = resolved.master ?? info.defaultMaster
    const master = info.masters[masterIdx] ?? info.masters[info.defaultMaster] ?? info.masters[0]!
    const withTitle = master.layouts.find((l) =>
      l.placeholders.some((p) => p.type === 'ctrTitle' || p.type === 'title'),
    )
    const chosen = withTitle ?? master.layouts[0]
    if (!chosen) throw new Error('Template master has no layouts.')
    layoutIndex = chosen.index
  }
  const flat = info.masters.flatMap((m) => m.layouts)
  const layout = flat[layoutIndex]
  if (!layout) throw new Error('Unknown layout index ' + layoutIndex + '.')
  const built = await buildTemplateDeck(
    bytes,
    {
      master: layout.master,
      ...(resolved.font !== undefined ? { font: resolved.font } : {}),
      keepSlides: false,
      pages: [
        {
          page: 0,
          layoutIndex,
          layoutName: layout.name,
          master: layout.master,
          fills: [],
          elements: [],
          emptyPlaceholders: true,
        },
      ],
    },
    { fetchImage: async () => null },
  )
  mkdirSync(dir, { recursive: true })
  const target = uniqueDeckPath(dir, untitledBase)
  const tmp = join(dir, '.deck-' + randomBytes(6).toString('hex') + '.tmp')
  try {
    writeFileSync(tmp, built.bytes)
    renameSync(tmp, target)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // The temp file may not exist; the original error matters.
    }
    throw err
  }
  return target
}
