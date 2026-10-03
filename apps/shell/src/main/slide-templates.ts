// Desktop template decks: list, create and import .pptx templates.
// Pure Node (no electron imports) so the logic stays unit-testable.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import { buildTemplateDeck, inspectTemplate, type SpecElement } from '@teleoffice/pipelines/slides'
import { PackageArchive } from '@teleoffice/pptx-engine'
import {
  addTemplate,
  clearDefaultTemplate,
  listTemplates,
  resolveRegisteredTemplate,
  setDefaultTemplate,
  templatesDir,
} from '@teleoffice/pipelines/slides/templates'

export interface SlideTemplateItem {
  name: string
  path: string
  exists: boolean
  description?: string
  isDefault: boolean
  source: 'registry' | 'file'
}

// List the registry templates for the home-screen picker.
export function listSlideTemplates(env: NodeJS.ProcessEnv = process.env): SlideTemplateItem[] {
  return listTemplates(env).map((t) => ({
    name: t.name,
    path: t.path,
    exists: t.exists,
    ...(t.description !== undefined ? { description: t.description } : {}),
    isDefault: t.isDefault,
    source: t.source,
  }))
}

// The home IPC accepts template names only; paths are rejected by the same
// resolver used when creating a starter deck.
export function setDefaultSlideTemplate(
  name: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (name === null) {
    clearDefaultTemplate(env)
    return null
  }
  const resolved = resolveRegisteredTemplate(name, { env })
  return setDefaultTemplate(resolved.name ?? name, env)
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

type TemplateInfoOf = Awaited<ReturnType<typeof inspectTemplate>>
type TemplateLayoutOf = TemplateInfoOf['masters'][number]['layouts'][number]

function hasTitlePlaceholder(layout: TemplateLayoutOf): boolean {
  return layout.placeholders.some((p) => p.type === 'ctrTitle' || p.type === 'title')
}

/**
 * The starter slide's layout: the registry startLayout when set; else, on the
 * registry master, the first layout a sample slide uses there (the template
 * author's own cover), then the most decorated title layout; without a
 * registry master, the first sample slide's layout, then a title layout of the
 * template's default master. Office default layouts that share a master with
 * the branded ones often carry no decorations, so "first layout with a title"
 * alone picks a blank page.
 */
export function pickStartLayout(
  info: TemplateInfoOf,
  pref: { master?: number; startLayout?: string },
): TemplateLayoutOf {
  const flat = info.masters.flatMap((m) => m.layouts)
  if (pref.startLayout) {
    // "Name", "<master>:Name" or a flat layout index, as `template add --start-layout` accepts
    const raw = pref.startLayout.trim()
    const scoped = /^(\d+)\s*:\s*(.+)$/.exec(raw)
    const scope = scoped ? Number(scoped[1]) : pref.master
    const wanted = (scoped ? scoped[2]! : raw).trim().toLowerCase()
    const named = (l: TemplateLayoutOf): boolean => l.name.toLowerCase() === wanted
    const hit = /^\d+$/.test(raw)
      ? flat[Number(raw)]
      : (flat.find((l) => named(l) && l.master === scope) ??
        (scoped ? undefined : flat.find(named)))
    if (hit) return hit
  }
  const masterIdx = pref.master !== undefined && info.masters[pref.master] ? pref.master : undefined
  const sampleLayouts = info.slides
    .map((s) => flat[s.layout])
    .filter((l): l is TemplateLayoutOf => !!l)
  if (masterIdx === undefined) {
    const first = sampleLayouts[0]
    if (first) return first
  } else {
    const first = sampleLayouts.find((l) => l.master === masterIdx)
    if (first) return first
  }
  const master =
    info.masters[masterIdx ?? info.defaultMaster] ??
    info.masters[info.defaultMaster] ??
    info.masters[0]!
  const titled = master.layouts.filter(hasTitlePlaceholder)
  const decorated = [...titled].sort((a, b) => b.decorations - a.decorations)[0]
  const chosen = decorated ?? master.layouts[0]
  if (!chosen) throw new Error('Template master has no layouts.')
  return chosen
}

/**
 * Title color for the added title box: the explicit color the template gives
 * its title placeholders on this master (brand titles usually carry one), else
 * the theme's dark text color.
 */
async function titleColor(
  bytes: Uint8Array,
  info: TemplateInfoOf,
  master: number,
): Promise<string> {
  try {
    const archive = await PackageArchive.open(bytes)
    for (const layout of info.masters[master]?.layouts ?? []) {
      const xml = archive.readText(layout.path) ?? ''
      for (const sp of xml.split('<p:sp>').slice(1)) {
        if (!/<p:ph[^>]*type="(title|ctrTitle)"/.test(sp)) continue
        const hex = /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(sp.split('</p:sp>')[0] ?? '')?.[1]
        if (hex) return '#' + hex.toUpperCase()
      }
    }
  } catch {
    // unreadable layout parts: fall back to the theme color
  }
  const colors = info.masters[master]?.theme.colors ?? {}
  const pick = colors.dk1 ?? colors.tx1 ?? '1F1F1F'
  return '#' + pick.replace(/^#/, '').toUpperCase()
}

// Build a one-slide starter deck from a template and write it atomically.
export async function createDeckFromTemplate(
  name: string,
  dir: string,
  untitledBase: string,
  env: NodeJS.ProcessEnv = process.env,
  titleText: string = untitledBase,
): Promise<string> {
  if (typeof name !== 'string' || !name) throw new Error('Invalid template name.')
  // Only registered (or templates-dir) names: the renderer never hands a path.
  const resolved = resolveRegisteredTemplate(name, { env })
  const bytes = new Uint8Array(readFileSync(resolved.path))
  const info = await inspectTemplate(bytes)
  if (info.masters.length === 0) throw new Error('Template has no masters.')
  const layout = pickStartLayout(info, {
    ...(resolved.master !== undefined ? { master: resolved.master } : {}),
    ...(resolved.startLayout ? { startLayout: resolved.startLayout } : {}),
  })
  const { w, h } = info.slideSize.px
  // A layout without a title placeholder (a branded cover) gets a title text
  // box so the starter slide is not empty.
  const boxColor = hasTitlePlaceholder(layout) ? '' : await titleColor(bytes, info, layout.master)
  const elements: SpecElement[] = hasTitlePlaceholder(layout)
    ? []
    : [
        {
          type: 'text',
          x: Math.round(w * 0.1),
          y: Math.round(h * 0.3),
          w: Math.round(w * 0.8),
          h: Math.round(h * 0.18),
          valign: 'middle',
          paragraphs: [
            {
              align: 'center',
              runs: [{ text: titleText, sizePt: 40, bold: true, color: boxColor }],
            },
          ],
        },
      ]
  const built = await buildTemplateDeck(
    bytes,
    {
      master: layout.master,
      ...(resolved.font !== undefined ? { font: resolved.font } : {}),
      keepSlides: false,
      pages: [
        {
          page: 0,
          layoutIndex: layout.index,
          layoutName: layout.name,
          master: layout.master,
          fills: [],
          elements,
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
