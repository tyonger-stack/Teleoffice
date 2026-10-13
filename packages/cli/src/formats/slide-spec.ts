import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import {
  auditDeck,
  buildDeckPptx,
  buildTemplateDeck,
  checkPageAgainstOutline,
  inspectTemplate,
  offPaletteColors,
  parseDeckSpec,
  parseTemplateDeckSpec,
  parseOutline,
  stylePalette,
  type BuildPageDeps,
  type DeckAuditPage,
  type DeckOutline,
  type DeckPageIssue,
  type OutlineIssue,
  type OutlinePage,
  type PageSpec,
  type TemplateLayoutUsed,
  type TemplateInfo,
  type TemplatePageSpec,
} from '@teleoffice/pipelines/slides'
import {
  getDefaultTemplate,
  listTemplates,
  resolveTemplate,
} from '@teleoffice/pipelines/slides/templates'
import {
  deleteSlide,
  mergeSlideFromPptx,
  moveSlide,
  promoteSlideBackground,
  type OpenedPptx,
} from '@teleoffice/pptx-engine'
import { HeuristicMetrics } from '@teleoffice/pptx-render'
import { extract } from '@teleoffice/pdf2docx'
import { assertAllowed, readInput, resolveInput, type PathContext } from '../fs'
import { CliError, EXIT, type ErrorHints } from '../result'

const INVALID: ErrorHints = { reason: 'invalid_argument' }
import { imageSize } from './image-size'
import { readImageSource } from './image-source'
import { loadPdfium } from './pdf'

/**
 * The app measures text with the system fonts it indexes at startup; the CLI
 * has no font index yet, so boxes grow and the audit measures with heuristic
 * glyph widths. Close for Latin and CJK body text, looser for display fonts.
 */
const metrics = new HeuristicMetrics()

export interface BuiltDeck {
  bytes: Uint8Array
  pages: number
  issues: DeckPageIssue[]
  imageFailures: { page: number; url: string }[]
  totalSlides?: number
  keptSlides?: number
}

function specDeps(ctx: PathContext, specDir?: string): BuildPageDeps {
  return {
    fetchImage: async (url) => {
      const r = await readImageSource(url, ctx, specDir)
      return r ? { bytes: r.bytes, ext: r.ext } : null
    },
    imageDims: (bytes) => {
      const s = imageSize(bytes)
      return s ? { width: s.width, height: s.height } : null
    },
    fontMetrics: metrics,
  }
}

/**
 * Deck spec JSON → pptx bytes. Image sources are local paths (relative to the
 * current directory, then to the spec file's folder), data: URLs or http(s) URLs.
 */
export async function buildDeckFromSpec(
  text: string,
  source: string,
  ctx: PathContext,
  specDir?: string,
): Promise<BuiltDeck> {
  const parsed = parseDeckSpec(text, { localImages: true })
  if (!parsed.ok) throw new CliError(EXIT.usage, `${source}: ${parsed.error}`, undefined, INVALID)
  const built = await buildDeckPptx(parsed.spec, specDeps(ctx, specDir))
  return {
    bytes: built.bytes,
    pages: parsed.spec.pages.length,
    issues: withImageWarnings(parsed.issues, inputIndexed(built.imageWarnings, parsed.issues)),
    imageFailures: inputIndexed(built.imageFailures, parsed.issues),
  }
}

/** Build-time image warnings (heavy cover crops) join the page's parse warnings so one list names everything wrong with a page. */
function withImageWarnings(
  issues: DeckPageIssue[],
  imageWarnings: { page: number; message: string }[],
): DeckPageIssue[] {
  if (imageWarnings.length === 0) return issues
  const out = issues.map((i) => ({ ...i, ...(i.warnings ? { warnings: [...i.warnings] } : {}) }))
  for (const w of imageWarnings) {
    let issue = out.find((i) => i.page === w.page)
    if (!issue) {
      issue = { page: w.page }
      out.push(issue)
    }
    issue.warnings = [...(issue.warnings ?? []), w.message]
  }
  return out.sort((a, b) => a.page - b.page)
}

/**
 * The builder numbers only the pages that survived parsing; callers reason in
 * input page numbers (the ones `issues` use), so map the failures back.
 */
function inputIndexed<T extends { page: number }>(failures: T[], issues: DeckPageIssue[]): T[] {
  const dropped = new Set(issues.filter((i) => i.error).map((i) => i.page))
  const maxPage = Math.max(-1, ...failures.map((f) => f.page))
  const kept: number[] = []
  for (let i = 0; kept.length <= maxPage; i++) if (!dropped.has(i)) kept.push(i)
  return failures.map((f) => ({ ...f, page: kept[f.page] ?? f.page }))
}

/** The `*.json` page files of a spec directory in name order: one file is one slide; an outline kept in the same folder is not a page. */
export function listPageFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter(
      (f) =>
        extname(f).toLowerCase() === '.json' &&
        !f.startsWith('.') &&
        f.toLowerCase() !== 'outline.json',
    )
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((f) => join(dir, f))
}

/**
 * The other files of the staged deck flow, looked up beside a page (or pages
 * folder) and one level up: `deck/pages/01.json` finds `deck/outline.json` and
 * `deck/style.md`.
 */
export interface StageFiles {
  outline?: string
  style?: string
}

export function findStageFiles(dir: string, ctx: PathContext): StageFiles {
  const find = (name: string) =>
    [join(dir, name), join(dir, '..', name)].find((p) => existsSync(p) && statSync(p).isFile())
  const out: StageFiles = {}
  const outline = find('outline.json')
  if (outline) out.outline = assertAllowed(resolve(outline), ctx.env, 'read')
  const style = find('style.md')
  if (style) out.style = assertAllowed(resolve(style), ctx.env, 'read')
  return out
}

/** What the page is checked against; the command layer resolves the files, this layer reads them. */
export interface StageContext {
  outline?: { file: string; outline: DeckOutline }
  style?: { file: string; palette: Set<string> }
  /** guidance when a stage file is missing */
  notes: string[]
}

export function stageContext(
  dir: string,
  ctx: PathContext,
  explicitOutline?: string,
): StageContext {
  const found = findStageFiles(dir, ctx)
  const outlineFile = explicitOutline ?? found.outline
  const out: StageContext = { notes: [] }
  if (outlineFile) out.outline = { file: outlineFile, outline: readOutline(outlineFile) }
  else {
    out.notes.push(
      'no outline.json beside the page files or one folder up: the staged flow writes deck/outline.json first and checks every page against it (teleoffice guide slides design)',
    )
  }
  if (found.style) {
    out.style = { file: found.style, palette: stylePalette(readFileSync(found.style, 'utf-8')) }
    if (out.style.palette.size === 0) {
      out.notes.push(
        `${basename(found.style)} names no #RRGGBB colors, so the palette is not checked`,
      )
    }
  } else {
    out.notes.push(
      'no style.md beside the page files or one folder up: write the style sheet (colors, fonts, layout library) before the pages',
    )
  }
  return out
}

export interface StageFindings {
  outline: OutlineIssue[]
  offPalette: string[]
}

/** One parsed page against its outline entry and the style sheet's palette. */
export function stageFindings(
  raw: unknown,
  spec: PageSpec,
  page: number,
  stage: StageContext,
): StageFindings {
  const outline: OutlineIssue[] = []
  if (stage.outline) {
    const entry = stage.outline.outline.pages[page]
    if (entry) outline.push(...checkPageAgainstOutline(raw, spec, entry, page))
    else {
      outline.push({
        page,
        level: 'error',
        message: `no outline entry for page ${page} (the outline has ${stage.outline.outline.pages.length} pages)`,
      })
    }
  }
  return {
    outline,
    offPalette: stage.style ? offPaletteColors(spec, stage.style.palette) : [],
  }
}

export interface BuiltDeckFromDir extends BuiltDeck {
  files: string[]
  stage: StageContext
  /** outline findings (warnings only; errors abort the build) keyed by page file */
  outlineFindings: (OutlineIssue & { file: string })[]
  offPalette: { file: string; colors: string[] }[]
}

/**
 * A directory of single-page spec files → one pptx. The files are the unit an
 * agent writes and checks one at a time; issues name the file they came from.
 * Every file is checked against its outline entry; a disagreement aborts.
 */
export async function buildDeckFromDir(
  dir: string,
  ctx: PathContext,
  stage: StageContext,
): Promise<BuiltDeckFromDir> {
  const files = listPageFiles(dir)
  if (files.length === 0)
    throw new CliError(EXIT.usage, `${dir}: no page files (*.json)`, undefined, INVALID)
  const outline = stage.outline?.outline
  if (outline && outline.pages.length !== files.length) {
    throw new CliError(
      EXIT.usage,
      `${dir}: ${files.length} page file(s) for ${outline.pages.length} outline page(s); write every page before building`,
      { files: files.map((f) => basename(f)), outline_pages: outline.pages.map((p) => p.title) },
    )
  }
  const pages: unknown[] = []
  for (const file of files) {
    try {
      pages.push(JSON.parse(readFileSync(file, 'utf-8')))
    } catch (err) {
      throw new CliError(
        EXIT.usage,
        `${file}: invalid JSON (${(err as Error).message})`,
        undefined,
        { reason: 'invalid_json' },
      )
    }
  }
  const parsed = parseDeckSpec(JSON.stringify({ pages }), { localImages: true })
  if (!parsed.ok) throw new CliError(EXIT.usage, `${dir}: ${parsed.error}`, undefined, INVALID)
  const named = (i: number) => ({ file: basename(files[i]!) })

  const outlineFindings: BuiltDeckFromDir['outlineFindings'] = []
  const offPalette: BuiltDeckFromDir['offPalette'] = []
  const dropped = new Set(parsed.issues.filter((i) => i.error).map((i) => i.page))
  let kept = 0
  for (let i = 0; i < pages.length; i++) {
    if (dropped.has(i)) continue
    const f = stageFindings(pages[i], parsed.spec.pages[kept++]!, i, stage)
    outlineFindings.push(...f.outline.map((o) => ({ ...o, ...named(i) })))
    if (f.offPalette.length) offPalette.push({ ...named(i), colors: f.offPalette })
  }
  const badPages = new Set(outlineFindings.filter((o) => o.level === 'error').map((o) => o.file))
  if (badPages.size) {
    throw new CliError(
      EXIT.usage,
      `${dir}: ${badPages.size} page(s) disagree with ${basename(stage.outline!.file)}; fix the page files (or the outline) before building`,
      { outline: stage.outline!.file, findings: outlineFindings },
    )
  }

  const built = await buildDeckPptx(parsed.spec, specDeps(ctx, dir))
  const issues = withImageWarnings(parsed.issues, inputIndexed(built.imageWarnings, parsed.issues))
  return {
    bytes: built.bytes,
    pages: parsed.spec.pages.length,
    issues: issues.map((i) => ({ ...i, ...named(i.page) })),
    imageFailures: inputIndexed(built.imageFailures, parsed.issues).map((f) => ({
      ...f,
      ...named(f.page),
    })),
    files,
    stage,
    outlineFindings,
    offPalette,
  }
}

/** The position of a page file among its folder's page files: the slide it becomes. */
export function pageIndexOf(file: string): number {
  return listPageFiles(resolve(file, '..')).indexOf(resolve(file))
}

export function readOutline(path: string): DeckOutline {
  const r = parseOutline(readFileSync(path, 'utf-8'))
  if (!r.ok) throw new CliError(EXIT.usage, `${path}: ${r.error}`, undefined, INVALID)
  return r.outline
}

export interface PageCheck {
  warnings: string[]
  imageFailures: string[]
  audit: string[]
  stage?: StageFindings
}

function parseOnePage(
  text: string,
  source: string,
  what: string,
): { raw: unknown; spec: PageSpec; warnings: string[] } {
  const parsed = parseDeckSpec(text, { localImages: true })
  if (!parsed.ok) throw new CliError(EXIT.usage, `${source}: ${parsed.error}`, undefined, INVALID)
  if (parsed.spec.pages.length !== 1) {
    throw new CliError(
      EXIT.usage,
      `${source}: ${what} one page object, not ${parsed.spec.pages.length}`,
    )
  }
  return {
    raw: JSON.parse(text) as unknown,
    spec: parsed.spec.pages[0]!,
    warnings: parsed.issues.flatMap((i) => i.warnings ?? []),
  }
}

/**
 * One page spec built on its own and audited, so a page is fixed before the
 * next one is written; with a stage context, also checked against its outline
 * entry (`page`) and the style sheet.
 */
export async function checkPageSpec(
  text: string,
  source: string,
  ctx: PathContext,
  stage?: { context: StageContext; page: number },
): Promise<PageCheck> {
  const one = parseOnePage(text, source, 'a page file holds exactly')
  const built = await buildDeckPptx({ pages: [one.spec] }, specDeps(ctx, dirnameOf(source)))
  const audit = await auditDeckBytes(built.bytes)
  return {
    warnings: [...one.warnings, ...built.imageWarnings.map((w) => w.message)],
    imageFailures: built.imageFailures.map((f) => f.url),
    audit: audit[0]?.issues ?? [],
    ...(stage ? { stage: stageFindings(one.raw, one.spec, stage.page, stage.context) } : {}),
  }
}

function dirnameOf(source: string): string | undefined {
  return source === 'stdin' ? undefined : resolve(source, '..')
}

/** Rebuild one page from its spec and put it where slide `index` was; the other slides are untouched. */
export async function replaceSlideFromSpec(
  opened: OpenedPptx,
  index: number,
  text: string,
  source: string,
  ctx: PathContext,
  stage?: StageContext,
): Promise<{ warnings: string[]; imageFailures: string[]; stage?: StageFindings }> {
  const one = parseOnePage(text, source, 'replace takes')
  const findings = stage ? stageFindings(one.raw, one.spec, index, stage) : undefined
  const errors = findings?.outline.filter((o) => o.level === 'error') ?? []
  if (errors.length) {
    throw new CliError(
      EXIT.usage,
      `${source}: the page disagrees with ${basename(stage!.outline!.file)} pages[${index}]`,
      { outline: stage!.outline!.file, findings: findings!.outline },
    )
  }
  const built = await buildDeckPptx({ pages: [one.spec] }, specDeps(ctx, dirnameOf(source)))
  // the rebuilt page keeps the replaced slide's layout, not the last slide's (often a back cover)
  const merged = await mergeSlideFromPptx(opened, built.bytes, {
    layoutFrom: opened.deck.slides[index],
  })
  if (!merged) throw new CliError(EXIT.conversion, `${source}: the built page could not be merged`)
  promoteSlideBackground(merged, opened.deck.size)
  const last = opened.deck.slides.length - 1
  if (last !== index) moveSlide(opened, last, index)
  if (!deleteSlide(opened, index + 1)) {
    throw new CliError(EXIT.conversion, `could not remove the old slide ${index}`)
  }
  return {
    warnings: [...one.warnings, ...built.imageWarnings.map((w) => w.message)],
    imageFailures: built.imageFailures.map((f) => f.url),
    ...(findings ? { stage: findings } : {}),
  }
}

export function auditDeckBytes(bytes: Uint8Array, only?: number): Promise<DeckAuditPage[]> {
  return auditDeck(bytes, { metrics, ...(only === undefined ? {} : { only }) })
}

/**
 * JSON-ready form of a deck audit, shared by `slides audit` and `create --audit`:
 * one flattened issue list with durable ids, the same `suggest` setTransform op
 * the audit produces, and per-slide issue strings. Findings are advisory; only
 * `counts` needs gating.
 */
export function deckAuditDetail(pages: DeckAuditPage[]) {
  const flat = pages.flatMap((p) => p.findings.map((f) => ({ page: p, f })))
  const counts = { error: 0, warning: 0 }
  for (const { f } of flat) counts[f.level]++
  const issues = flat.map(({ page, f }, i) => ({
    id: `${f.level[0]!.toUpperCase()}${i + 1}`,
    code: f.code,
    level: f.level,
    path: `${page.id}/${f.el}`,
    // slide: 0-based position (what --slide takes); page: 1-based (the PNG
    // page number). The s_<n> in path is a durable id, not a position.
    slide: page.slide,
    page: page.slide + 1,
    el: f.el,
    ...(f.els ? { els: f.els } : {}),
    message: f.message,
    box: f.box,
    ...(f.overflowPx !== undefined ? { overflowPx: f.overflowPx } : {}),
    ...(f.distortion_pct !== undefined
      ? {
          expected_ratio: f.expected_ratio,
          actual_ratio: f.actual_ratio,
          distortion_pct: f.distortion_pct,
        }
      : {}),
    ...(f.suggest ? { suggest: f.suggest } : {}),
  }))
  return {
    counts,
    issues,
    slides: pages.map((p) => ({ slide: p.slide, page: p.slide + 1, id: p.id, issues: p.issues })),
  }
}

export interface RasterizedPage {
  index: number
  png: Uint8Array
  width: number
  height: number
}

/** Every page of a PDF as PNG at `scale` × 72 dpi (2 = 144 dpi). */
export async function rasterizePdf(
  bytes: Uint8Array,
  scale: number,
  only?: number,
  range: { flag: string; oneBased: boolean } = { flag: 'slide', oneBased: false },
): Promise<RasterizedPage[]> {
  const m = await loadPdfium()
  return extract.withPdfDocument(m, bytes, (doc) => {
    const count = m._FPDF_GetPageCount(doc)
    if (only !== undefined && (only < 0 || only >= count)) {
      const [lo, hi] = range.oneBased ? [1, count] : [0, count - 1]
      throw new CliError(
        EXIT.usage,
        `--${range.flag} out of range (${lo}-${hi})`,
        { valid_range: [lo, hi] },
        { reason: 'out_of_range', suggestion: `use a value between ${lo} and ${hi}` },
      )
    }
    const out: RasterizedPage[] = []
    for (let i = 0; i < count; i++) {
      if (only !== undefined && i !== only) continue
      const r = extract.renderPageByIndexPng(m, doc, i, scale)
      if (!r) throw new CliError(EXIT.conversion, 'could not render page ' + (i + 1))
      out.push({ index: i, png: r.data, width: r.pixelWidth, height: r.pixelHeight })
    }
    return out
  })
}

// ---- Template mode ----

/** A template reference resolved to a file: registry name or .pptx/.potx path. */
export interface TemplateSource {
  name?: string
  path: string
  master?: number
  font?: string
  startLayout?: string
}

// An existing deck path (relative to the working directory) wins over a
// registered name; otherwise the name resolves through the registry.
export function resolveTemplateSource(ref: string, ctx: PathContext): TemplateSource {
  if (ref.includes('/') || ref.includes('\\') || /\.potx?$/i.test(ref)) {
    const ext = extname(ref).toLowerCase()
    if (ext !== '.pptx' && ext !== '.potx') {
      throw new CliError(
        EXIT.usage,
        'template file must be a .pptx or .potx: ' + ref,
        undefined,
        INVALID,
      )
    }
    const candidate = isAbsolute(ref) ? ref : resolve(ctx.cwd, ref)
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      throw new CliError(EXIT.file, 'template file not found: ' + ref, undefined, {
        reason: 'file_not_found',
      })
    }
    const path = resolveInput(ref, ctx)
    const known = listTemplates(ctx.env).find((t) => t.path === path)
    return {
      ...(known?.name ? { name: known.name } : {}),
      path,
      ...(known?.master !== undefined ? { master: known.master } : {}),
      ...(known?.font !== undefined ? { font: known.font } : {}),
      ...(known?.startLayout !== undefined ? { startLayout: known.startLayout } : {}),
    }
  }
  try {
    return resolveTemplate(ref, { cwd: ctx.cwd, env: ctx.env })
  } catch (err) {
    throw new CliError(
      EXIT.usage,
      err instanceof Error ? err.message : String(err),
      undefined,
      INVALID,
    )
  }
}

export interface TemplateDeckDetail {
  name?: string
  path: string
  source?: 'default'
  master: number
  slideSize: { w: number; h: number }
  layoutsUsed: TemplateLayoutUsed[]
}

function deckTemplateField(text: string): unknown {
  try {
    const v: unknown = JSON.parse(text)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return (v as Record<string, unknown>).template
    }
    return undefined
  } catch {
    return undefined
  }
}

// True when a deck spec file names its own template (template mode without the flag).
export function deckSpecNamesTemplate(text: string): boolean {
  return typeof deckTemplateField(text) === 'string'
}

export interface TemplateBuildRequest {
  /** --template flag (wins over the spec and outline fields) */
  template?: string
  /** --font flag (wins over the spec font and the registry default) */
  font?: string
  keepSlides?: boolean
  source?: 'default'
  /** outline "template" field (weakest fallback) */
  outlineTemplate?: string
}

/** Return the configured default, failing clearly if its file has gone missing. */
export function configuredDefaultTemplate(ctx: PathContext): string | undefined {
  const name = getDefaultTemplate(ctx.env)
  if (!name) return undefined
  if (!listTemplates(ctx.env).some((template) => template.name === name && template.exists)) {
    throw new CliError(
      EXIT.usage,
      'configured default template "' +
        name +
        '" is unavailable; run `teleoffice template default --clear` or set another default',
      undefined,
      INVALID,
    )
  }
  return name
}

/** Check whether named layouts in a spec belong to a candidate default template. */
export function templateHasLayouts(
  info: TemplateInfo,
  refs: unknown[],
  preferredMaster?: number,
): boolean {
  const flat = info.masters.flatMap((master) => master.layouts)
  const preferred =
    preferredMaster === undefined ? flat : (info.masters[preferredMaster]?.layouts ?? flat)
  return refs.every((ref) => {
    if (ref === undefined || ref === null || ref === '') return true
    if (typeof ref === 'number' && Number.isInteger(ref)) return flat[ref] !== undefined
    if (typeof ref !== 'string' || !ref.trim()) return false
    const raw = ref.trim()
    // a layout name wins over the numeric reading, so a layout named "1" matches by name
    if (preferred.some((layout) => layout.name.toLowerCase() === raw.toLowerCase())) return true
    if (/^\d+$/.test(raw)) return flat[Number(raw)] !== undefined
    const scoped = /^(\d+)\s*:\s*(.+)$/.exec(raw)
    const name = (scoped?.[2] ?? raw).trim().toLowerCase()
    const layouts = scoped ? (info.masters[Number(scoped[1])]?.layouts ?? []) : preferred
    return layouts.some((layout) => layout.name.toLowerCase() === name)
  })
}

/** Use the default only when its named layouts do not conflict with the spec. */
export async function defaultTemplateForLayouts(
  refs: unknown[],
  ctx: PathContext,
): Promise<string | undefined> {
  const name = configuredDefaultTemplate(ctx)
  if (!name) return undefined
  const { info, resolved } = await templateBytesAndInfo(name, ctx)
  return templateHasLayouts(info, refs, resolved.master) ? name : undefined
}

export function templateDefaultLayout(
  info: TemplateInfo,
  resolved: TemplateSource,
): number | undefined {
  const preferred = resolved.master ?? info.defaultMaster
  const candidates = info.masters[preferred]?.layouts ?? []
  const kind = (layout: (typeof candidates)[number]): 'title' | 'ctrTitle' | undefined => {
    if (layout.placeholders.some((placeholder) => placeholder.type === 'title')) return 'title'
    if (layout.placeholders.some((placeholder) => placeholder.type === 'ctrTitle'))
      return 'ctrTitle'
    return undefined
  }
  const contentCount = (layout: (typeof candidates)[number]) =>
    layout.placeholders.filter(
      (placeholder) => !['title', 'ctrTitle', 'dt', 'ftr', 'sldNum'].includes(placeholder.type),
    ).length
  const decorations = (layout: (typeof candidates)[number]) => layout.decorations ?? 0
  const titleLayouts = candidates.filter((layout) => kind(layout) !== undefined)
  const sampled = titleLayouts.filter((layout) => (layout.usedBySamples ?? 0) > 0)
  if (sampled.length) {
    // A normal title placeholder is a better body-page fit than a centered title,
    // which is commonly reserved for covers and closing pages.
    const regularTitleSamples = sampled.filter((layout) => kind(layout) === 'title')
    const pool = regularTitleSamples.length ? regularTitleSamples : sampled
    pool.sort(
      (a, b) =>
        (b.usedBySamples ?? 0) - (a.usedBySamples ?? 0) ||
        contentCount(a) - contentCount(b) ||
        decorations(b) - decorations(a),
    )
    return pool[0]!.index
  }

  const regularTitles = titleLayouts.filter((layout) => kind(layout) === 'title')
  const centeredTitles = titleLayouts.filter((layout) => kind(layout) === 'ctrTitle')
  const simple = (layouts: typeof titleLayouts) =>
    layouts.filter((layout) => {
      const count = contentCount(layout)
      return (
        count === 0 ||
        (count === 1 &&
          layout.placeholders.some(
            (placeholder) => placeholder.type === 'body' || placeholder.type === 'obj',
          ))
      )
    })
  const simpleTitles = simple(regularTitles)
  const simpleCenteredTitles = simple(centeredTitles)
  const simplePool = simpleTitles.length ? simpleTitles : simpleCenteredTitles
  if (simplePool.length) {
    simplePool.sort((a, b) => decorations(b) - decorations(a) || contentCount(a) - contentCount(b))
    return simplePool[0]!.index
  }

  const titlePool = regularTitles.length ? regularTitles : centeredTitles
  if (titlePool.length) {
    // Complex layouts are a last resort; fewer empty content slots win.
    titlePool.sort((a, b) => contentCount(a) - contentCount(b) || decorations(b) - decorations(a))
    return titlePool[0]!.index
  }
  return candidates[0]?.index
}

function templateRefOf(text: string, req: TemplateBuildRequest): string {
  const fromSpec = deckTemplateField(text)
  const ref =
    req.template ?? (typeof fromSpec === 'string' ? fromSpec : undefined) ?? req.outlineTemplate
  if (!ref) {
    throw new CliError(
      EXIT.usage,
      'template mode needs --template <file|name> (or "template" in the spec or outline)',
      undefined,
      INVALID,
    )
  }
  return ref
}

export async function templateBytesAndInfo(
  ref: string,
  ctx: PathContext,
): Promise<{
  resolved: TemplateSource
  bytes: Uint8Array
  info: Awaited<ReturnType<typeof inspectTemplate>>
}> {
  const resolved = resolveTemplateSource(ref, ctx)
  const bytes = new Uint8Array(readInput(resolved.path))
  return { resolved, bytes, info: await inspectTemplate(bytes) }
}

// Deck spec JSON in template mode: every page fills the named template layout.
export async function buildDeckFromTemplateText(
  text: string,
  source: string,
  ctx: PathContext,
  specDir: string | undefined,
  req: TemplateBuildRequest,
): Promise<BuiltDeck & { template: TemplateDeckDetail }> {
  const { resolved, bytes, info } = await templateBytesAndInfo(templateRefOf(text, req), ctx)
  const parsed = parseTemplateDeckSpec(text, info, {
    localImages: true,
    master: resolved.master,
    ...(req.source === 'default' ? { defaultLayout: templateDefaultLayout(info, resolved) } : {}),
  })
  if (!parsed.ok) throw new CliError(EXIT.usage, source + ': ' + parsed.error, undefined, INVALID)
  if (req.keepSlides) parsed.spec.keepSlides = true
  const font = req.font ?? parsed.spec.font ?? resolved.font
  const built = await buildTemplateDeck(bytes, parsed.spec, {
    ...specDeps(ctx, specDir),
    ...(font ? { font } : {}),
  })
  return {
    bytes: built.bytes,
    pages: parsed.spec.pages.length,
    totalSlides: built.totalSlides,
    keptSlides: built.keptSlides,
    issues: withImageWarnings(parsed.issues, built.imageWarnings),
    imageFailures: built.imageFailures,
    template: {
      ...(resolved.name ? { name: resolved.name } : {}),
      ...(req.source ? { source: req.source } : {}),
      path: resolved.path,
      master: parsed.spec.master,
      slideSize: info.slideSize.px,
      layoutsUsed: built.layoutsUsed,
    },
  }
}

export interface BuiltTemplateDeckFromDir extends BuiltDeck {
  files: string[]
  template: TemplateDeckDetail
  outlineFindings: (OutlineIssue & { file: string })[]
}

// A directory of single-page template spec files: same page-file listing and
// outline count checks as the plain flow, echo-only outline comparison.
export async function buildDeckFromTemplateDir(
  dir: string,
  ctx: PathContext,
  stage: StageContext,
  req: TemplateBuildRequest,
): Promise<BuiltTemplateDeckFromDir> {
  const files = listPageFiles(dir)
  if (files.length === 0)
    throw new CliError(EXIT.usage, dir + ': no page files (*.json)', undefined, INVALID)
  const outline = stage.outline?.outline
  if (outline && outline.pages.length !== files.length) {
    throw new CliError(
      EXIT.usage,
      dir +
        ': ' +
        files.length +
        ' page file(s) for ' +
        outline.pages.length +
        ' outline page(s); write every page before building',
      { files: files.map((f) => basename(f)), outline_pages: outline.pages.map((p) => p.title) },
    )
  }
  const ref = req.template ?? outline?.template ?? req.outlineTemplate
  if (!ref) {
    throw new CliError(
      EXIT.usage,
      dir + ': template mode needs --template <file|name> (or "template" in the outline)',
      undefined,
      INVALID,
    )
  }
  const { resolved, bytes, info } = await templateBytesAndInfo(ref, ctx)
  const pages: unknown[] = []
  for (const file of files) {
    try {
      pages.push(JSON.parse(readFileSync(file, 'utf-8')))
    } catch (err) {
      throw new CliError(
        EXIT.usage,
        file + ': invalid JSON (' + (err as Error).message + ')',
        undefined,
        { reason: 'invalid_json' },
      )
    }
  }
  const pagesForBuild = pages.map((page, index) => {
    const entry = outline?.pages[index]
    if (!resolved.startLayout || entry?.type !== 'cover' || entry.layout.trim()) return page
    const record = page && typeof page === 'object' ? (page as Record<string, unknown>) : null
    if (!record) return page
    const pageLayout = record.layout
    if (
      pageLayout !== undefined &&
      pageLayout !== null &&
      !(typeof pageLayout === 'string' && pageLayout.trim() === '')
    ) {
      return page
    }
    return { ...record, layout: resolved.startLayout }
  })
  const parsed = parseTemplateDeckSpec(JSON.stringify({ pages: pagesForBuild }), info, {
    localImages: true,
    master: resolved.master,
    ...(req.source === 'default' ? { defaultLayout: templateDefaultLayout(info, resolved) } : {}),
  })
  if (!parsed.ok) throw new CliError(EXIT.usage, dir + ': ' + parsed.error, undefined, INVALID)
  if (req.keepSlides) parsed.spec.keepSlides = true
  if (!parsed.spec.title && outline?.topic?.trim()) {
    parsed.spec.title = outline.topic.trim()
  }
  const named = (i: number): { file: string } => ({ file: basename(files[i]!) })
  const outlineFindings: BuiltTemplateDeckFromDir['outlineFindings'] = []
  if (outline) {
    for (const page of parsed.spec.pages) {
      const entry = outline.pages[page.page]
      if (!entry) {
        outlineFindings.push({
          page: page.page,
          level: 'error',
          message: 'no outline entry for page ' + page.page,
          ...named(page.page),
        })
        continue
      }
      outlineFindings.push(
        ...templateOutlineFindings(pages[page.page], page, entry, page.page).map((o) => ({
          ...o,
          ...named(page.page),
        })),
      )
    }
    const bad = new Set(outlineFindings.filter((o) => o.level === 'error').map((o) => o.file))
    if (bad.size) {
      throw new CliError(
        EXIT.usage,
        dir +
          ': ' +
          bad.size +
          ' page(s) disagree with ' +
          basename(stage.outline!.file) +
          '; fix the page files (or the outline) before building',
        { outline: stage.outline!.file, findings: outlineFindings },
      )
    }
  }
  const font = req.font ?? resolved.font
  const built = await buildTemplateDeck(bytes, parsed.spec, {
    ...specDeps(ctx, dir),
    ...(font ? { font } : {}),
  })
  return {
    bytes: built.bytes,
    pages: parsed.spec.pages.length,
    totalSlides: built.totalSlides,
    keptSlides: built.keptSlides,
    issues: withImageWarnings(parsed.issues, built.imageWarnings).map((x) => ({
      ...x,
      ...named(x.page),
    })),
    imageFailures: built.imageFailures.map((f) => ({ ...f, ...named(f.page) })),
    files,
    template: {
      ...(resolved.name ? { name: resolved.name } : {}),
      ...(req.source ? { source: req.source } : {}),
      path: resolved.path,
      master: parsed.spec.master,
      slideSize: info.slideSize.px,
      layoutsUsed: built.layoutsUsed,
    },
    outlineFindings,
  }
}

// Echo-only outline comparison for template pages: title, type and layout must
// match the entry word for word (layout = the template layout name).
export function templateOutlineFindings(
  raw: unknown,
  page: TemplatePageSpec,
  entry: OutlinePage,
  index: number,
): OutlineIssue[] {
  void page
  const issues: OutlineIssue[] = []
  const root = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  for (const field of ['title', 'type', 'layout'] as const) {
    const declared = typeof root[field] === 'string' ? (root[field] as string).trim() : ''
    if (declared && declared !== entry[field]) {
      issues.push({
        page: index,
        level: 'error',
        message:
          'the page file\u2019s ' +
          field +
          ' "' +
          declared +
          '" is not outline pages[' +
          index +
          ']\u2019s "' +
          entry[field] +
          '"',
      })
    }
  }
  return issues
}

export interface TemplatePageCheck {
  warnings: string[]
  imageFailures: string[]
  audit: string[]
  page: TemplatePageSpec
  raw: unknown
  template: Omit<TemplateDeckDetail, 'layoutsUsed'>
}

// One template page spec built on its template and audited, so a page is fixed
// before the next one is written. Canvas = the template own slide size.
export async function checkTemplatePageSpec(
  text: string,
  source: string,
  ctx: PathContext,
  req: TemplateBuildRequest,
): Promise<TemplatePageCheck> {
  const { resolved, bytes, info } = await templateBytesAndInfo(templateRefOf(text, req), ctx)
  const parsed = parseTemplateDeckSpec(text, info, {
    localImages: true,
    master: resolved.master,
    ...(req.source === 'default' ? { defaultLayout: templateDefaultLayout(info, resolved) } : {}),
  })
  if (!parsed.ok) throw new CliError(EXIT.usage, source + ': ' + parsed.error, undefined, INVALID)
  if (parsed.spec.pages.length !== 1) {
    throw new CliError(
      EXIT.usage,
      source + ': a page file holds exactly one page object, not ' + parsed.spec.pages.length,
    )
  }
  if (req.keepSlides) parsed.spec.keepSlides = true
  const font = req.font ?? parsed.spec.font ?? resolved.font
  const built = await buildTemplateDeck(bytes, parsed.spec, {
    ...specDeps(ctx, dirnameOf(source)),
    ...(font ? { font } : {}),
  })
  const audit = await auditDeckBytes(built.bytes)
  return {
    warnings: [
      ...parsed.issues.flatMap((x) => x.warnings ?? []),
      ...built.imageWarnings.map((w) => w.message),
    ],
    imageFailures: built.imageFailures.map((f) => f.url),
    audit: audit[0]?.issues ?? [],
    page: parsed.spec.pages[0]!,
    raw: JSON.parse(text) as unknown,
    template: {
      ...(resolved.name ? { name: resolved.name } : {}),
      ...(req.source ? { source: req.source } : {}),
      path: resolved.path,
      master: parsed.spec.master,
      slideSize: info.slideSize.px,
    },
  }
}
