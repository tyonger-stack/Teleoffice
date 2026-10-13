/**
 * Template mode: build a brand-new deck on top of a corporate .pptx template
 * so slides use the template masters, layouts and theme instead of blank pages.
 *
 * Node-only: uses pptx-engine archive surgery (openPptx, savePptx, reparseDeck,
 * insertSlideWithLayout, deleteSlide, setSlideNotes, addImageMediaAndRel,
 * generateParagraphXml). Pure on bytes: no fs access here (the registry in
 * template-registry.ts owns the file side).
 */
import {
  addImageMediaAndRel,
  deleteSlide,
  escapeXmlAttr,
  escapeXmlText,
  generateParagraphXml,
  insertSlideWithLayout,
  openPptx,
  parseTheme,
  reparseDeck,
  savePptx,
  setSlideNotes,
  type OpenedPptx,
  type Paragraph,
  type Slide,
} from '@teleoffice/pptx-engine'
import { MAX_DECK_PAGES } from './deck-spec'
import { coverCropFractions } from './cover-crop'
import {
  addSpecElements,
  growTextBoxesToContent,
  parsePageSpecObject,
  parseSpecParagraphs,
  toEngineParagraphs,
  type BuildPageDeps,
  type SpecElement,
  type SpecParagraph,
} from './page-spec'

const EMU_PER_PX = 9525
const EMU_PER_CM = 360000

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1, -4)
}

function cSldName(xml: string, fallback: string): string {
  return /<p:cSld\s[^>]*name="([^"]*)"/.exec(xml)?.[1] || fallback
}

function resolveTargetLocal(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const dir = base.slice(0, base.lastIndexOf('/') + 1)
  const parts: string[] = []
  for (const seg of (dir + target).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

export interface EmuBox {
  x: number
  y: number
  cx: number
  cy: number
}

export interface TemplatePlaceholder {
  type: string
  idx: number
  name: string
  box: EmuBox
  px: { x: number; y: number; w: number; h: number }
  inherited?: boolean
}

export interface TemplateLayout {
  index: number
  master: number
  name: string
  type: string
  path: string
  placeholders: TemplatePlaceholder[]
  decorations: number
  usedBySamples: number
}

export interface TemplateThemeFonts {
  latin: string
  ea: string
  cs: string
}

export interface TemplateMasterTheme {
  path?: string
  name: string
  colors: Record<string, string>
  fonts: { major: TemplateThemeFonts; minor: TemplateThemeFonts }
}

export interface TemplateMaster {
  index: number
  path: string
  name: string
  theme: TemplateMasterTheme
  layouts: TemplateLayout[]
}

export interface TemplateSampleSlide {
  index: number
  layout: number
  layoutName: string
}

export interface TemplateInfo {
  slideSize: { cx: number; cy: number; px: { w: number; h: number }; cm: { w: number; h: number } }
  masters: TemplateMaster[]
  slides: TemplateSampleSlide[]
  defaultMaster: number
  duplicateLayoutNames: string[]
}
interface RawPh {
  type: string
  idx: number
  name: string
  box?: EmuBox
}

function numAttr(attrs: string, name: string): number | undefined {
  const v = new RegExp('\\b' + name + '="([^"]*)"').exec(attrs)?.[1]
  if (v === undefined) return undefined
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}

function xfrmBox(inner: string): EmuBox | undefined {
  const xfrm = /<a:xfrm\b[^>]*>([\s\S]*?)<\/a:xfrm>/.exec(inner)?.[1]
  if (!xfrm) return undefined
  const off = /<a:off\b([^>]*?)\/?>/.exec(xfrm)?.[1] ?? ''
  const ext = /<a:ext\b([^>]*?)\/?>/.exec(xfrm)?.[1] ?? ''
  const x = numAttr(off, 'x')
  const y = numAttr(off, 'y')
  const cx = numAttr(ext, 'cx')
  const cy = numAttr(ext, 'cy')
  if (x === undefined || y === undefined || cx === undefined || cy === undefined) return undefined
  return { x, y, cx, cy }
}

function scanShapePlaceholders(xml: string): RawPh[] {
  const out: RawPh[] = []
  const re = /<p:(sp|pic)(?:\s[^>]*)?>([\s\S]*?)<\/p:\1>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const inner = m[2] ?? ''
    const ph = /<p:ph\b([^>]*)\/?>/.exec(inner)
    if (!ph) continue
    const attrs = ph[1] ?? ''
    const type = /\btype="([^"]*)"/.exec(attrs)?.[1] || 'obj'
    const idxRaw = /\bidx="([^"]*)"/.exec(attrs)?.[1]
    const idx = idxRaw !== undefined ? parseInt(idxRaw, 10) : 0
    const name = /<p:cNvPr\b[^>]*\bname="([^"]*)"/.exec(inner)?.[1] ?? ''
    const box = xfrmBox(inner)
    out.push({
      type,
      idx: Number.isFinite(idx) ? idx : 0,
      name,
      ...(box ? { box } : {}),
    })
  }
  return out
}

function phTypeMatch(a: string, b: string): boolean {
  if (a === b) return true
  if ((a === 'title' || a === 'ctrTitle') && (b === 'title' || b === 'ctrTitle')) return true
  const body = new Set(['body', 'obj', 'subTitle'])
  return body.has(a) && body.has(b)
}

function findMasterBox(masterPhs: RawPh[], type: string, idx: number): EmuBox | undefined {
  const byIdx = masterPhs.filter((p) => p.idx === idx)
  const sameIdx = byIdx.find((p) => phTypeMatch(p.type, type)) ?? byIdx[0]
  if (sameIdx?.box) return sameIdx.box
  return masterPhs.find((p) => phTypeMatch(p.type, type))?.box
}

function emuBoxToPx(box: EmuBox): { x: number; y: number; w: number; h: number } {
  return {
    x: round2(box.x / EMU_PER_PX),
    y: round2(box.y / EMU_PER_PX),
    w: round2(box.cx / EMU_PER_PX),
    h: round2(box.cy / EMU_PER_PX),
  }
}

function countDecorations(layoutXml: string): number {
  const tree = /<p:cSld\b[^>]*>([\s\S]*?)<\/p:cSld>/.exec(layoutXml)?.[1] ?? layoutXml
  let n = 0
  for (const mm of tree.matchAll(/<p:(sp|pic)(?:\s[^>]*)?>([\s\S]*?)<\/p:\1>/g)) {
    if (!/<p:ph\b/.test(mm[2] ?? '')) n++
  }
  for (const _mm of tree.matchAll(/<p:cxnSp\b/g)) n++
  for (const mm of tree.matchAll(/<p:graphicFrame>([\s\S]*?)<\/p:graphicFrame>/g)) {
    if (!/<p:ph\b/.test(mm[1] ?? '')) n++
  }
  return n
}

function masterIdPaths(archive: OpenedPptx['archive'], pres: string): string[] {
  const rels = archive.readRels('ppt/presentation.xml')
  const out: string[] = []
  const list = /<p:sldMasterIdLst>([\s\S]*?)<\/p:sldMasterIdLst>/.exec(pres)?.[1] ?? ''
  for (const mm of list.matchAll(/<p:sldMasterId\b[^>]*\br:id="([^"]+)"[^>]*\/>/g)) {
    const rel = rels.get(mm[1] ?? '')
    if (rel) out.push(resolveTargetLocal('ppt/presentation.xml', rel.target))
  }
  return out
}

function layoutIdPaths(
  archive: OpenedPptx['archive'],
  masterPath: string,
  masterXml: string,
): string[] {
  const rels = archive.readRels(masterPath)
  const list = /<p:sldLayoutIdLst>([\s\S]*?)<\/p:sldLayoutIdLst>/.exec(masterXml)?.[1]
  if (list !== undefined) {
    const out: string[] = []
    for (const mm of list.matchAll(/\br:id="([^"]+)"/g)) {
      const rel = rels.get(mm[1] ?? '')
      if (rel) out.push(resolveTargetLocal(masterPath, rel.target))
    }
    return out
  }
  return [...rels.values()]
    .filter((r) => r.type.endsWith('/slideLayout'))
    .map((r) => resolveTargetLocal(masterPath, r.target))
    .sort()
}

function readMasterTheme(archive: OpenedPptx['archive'], masterPath: string): TemplateMasterTheme {
  let themePath: string | undefined
  for (const r of archive.readRels(masterPath).values()) {
    if (r.type.endsWith('/theme')) {
      themePath = resolveTargetLocal(masterPath, r.target)
      break
    }
  }
  const empty = { latin: '', ea: '', cs: '' }
  const theme: TemplateMasterTheme = {
    name: '',
    colors: {},
    fonts: { major: { ...empty }, minor: { ...empty } },
  }
  if (!themePath) return theme
  theme.path = themePath
  const xml = archive.readText(themePath)
  if (!xml) return theme
  theme.name = /<a:theme\b[^>]*\bname="([^"]*)"/.exec(xml)?.[1] ?? baseName(themePath)
  try {
    const parsed = parseTheme(xml)
    theme.colors = parsed.colors ?? {}
    theme.fonts = {
      major: {
        latin: parsed.majorFont ?? '',
        ea: parsed.majorEaFont ?? '',
        cs: parsed.majorCsFont ?? '',
      },
      minor: {
        latin: parsed.minorFont ?? '',
        ea: parsed.minorEaFont ?? '',
        cs: parsed.minorCsFont ?? '',
      },
    }
  } catch {
    // keep the defaults; a theme part is never worth failing inspect over
  }
  return theme
}

export async function inspectTemplate(bytes: Uint8Array): Promise<TemplateInfo> {
  const opened = await openPptx(bytes)
  const archive = opened.archive
  const pres = archive.readText('ppt/presentation.xml') ?? ''
  let masterPaths = masterIdPaths(archive, pres)
  if (masterPaths.length === 0) {
    masterPaths = [...archive.entries.keys()]
      .filter((p) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(p))
      .sort()
  }
  const size = opened.deck.size
  const masters: TemplateMaster[] = []
  const byPath = new Map<string, number>()
  const layoutMaster: number[] = []
  let flat = 0
  for (const [mi, mpath] of masterPaths.entries()) {
    const mxml = archive.readText(mpath) ?? ''
    const masterPhs = scanShapePlaceholders(mxml)
    const layouts: TemplateLayout[] = []
    for (const lpath of layoutIdPaths(archive, mpath, mxml)) {
      const lxml = archive.readText(lpath) ?? ''
      const placeholders: TemplatePlaceholder[] = []
      for (const raw of scanShapePlaceholders(lxml)) {
        let box = raw.box
        let inherited = false
        if (!box) {
          const found = findMasterBox(masterPhs, raw.type, raw.idx)
          if (!found) continue
          box = found
          inherited = true
        }
        placeholders.push({
          type: raw.type,
          idx: raw.idx,
          name: raw.name,
          box,
          px: emuBoxToPx(box),
          ...(inherited ? { inherited: true as const } : {}),
        })
      }
      byPath.set(lpath, flat)
      layoutMaster.push(mi)
      layouts.push({
        index: flat++,
        master: mi,
        name: cSldName(lxml, baseName(lpath)),
        type: /<p:sldLayout\b[^>]*\btype="([^"]*)"/.exec(lxml)?.[1] ?? 'custom',
        path: lpath,
        placeholders,
        decorations: countDecorations(lxml),
        usedBySamples: 0,
      })
    }
    masters.push({
      index: mi,
      path: mpath,
      name: cSldName(mxml, baseName(mpath)),
      theme: readMasterTheme(archive, mpath),
      layouts,
    })
  }
  const layoutNameOf = (li: number): string =>
    masters[layoutMaster[li] ?? 0]?.layouts.find((l) => l.index === li)?.name ?? ''
  const slides: TemplateSampleSlide[] = opened.deck.slides.map((s, i) => {
    let li: number | undefined
    try {
      const chain = archive.resolveSlideChain(s.path)
      li = chain.layoutPath ? byPath.get(chain.layoutPath) : undefined
    } catch {
      li = undefined
    }
    if (li !== undefined) {
      const mi = layoutMaster[li] ?? 0
      const layout = masters[mi]?.layouts.find((l) => l.index === li)
      if (layout) layout.usedBySamples++
    }
    return { index: i, layout: li ?? -1, layoutName: li !== undefined ? layoutNameOf(li) : '' }
  })
  const perMaster = masters.map(() => 0)
  for (const s of slides) {
    if (s.layout >= 0) perMaster[layoutMaster[s.layout] ?? 0]!++
  }
  let defaultMaster = 0
  if (slides.length > 0) {
    let best = -1
    for (const [mi, count] of perMaster.entries()) {
      if (count >= best) {
        best = count
        defaultMaster = mi
      }
    }
  }
  const seenMasters = new Map<string, Set<number>>()
  for (const m of masters) {
    for (const l of m.layouts) {
      const set = seenMasters.get(l.name) ?? new Set<number>()
      set.add(m.index)
      seenMasters.set(l.name, set)
    }
  }
  const duplicateLayoutNames = [...seenMasters.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([name]) => name)
  return {
    slideSize: {
      cx: size.cx,
      cy: size.cy,
      px: { w: round2(size.cx / EMU_PER_PX), h: round2(size.cy / EMU_PER_PX) },
      cm: { w: round2(size.cx / EMU_PER_CM), h: round2(size.cy / EMU_PER_CM) },
    },
    masters,
    slides,
    defaultMaster,
    duplicateLayoutNames,
  }
}
export interface TemplateBullet {
  text: string
  level: number
}

export interface TemplateFillImage {
  url: string
  fit: 'cover' | 'contain'
}

export interface TemplatePlaceholderFill {
  ph: TemplatePlaceholder
  plain?: boolean
  paragraphs?: SpecParagraph[]
  image?: TemplateFillImage
}

export interface TemplatePageSpec {
  page: number
  layoutIndex: number
  layoutName: string
  master: number
  title?: string
  fills: TemplatePlaceholderFill[]
  notes?: string
  elements: SpecElement[]
  emptyPlaceholders?: boolean
}

export interface TemplateDeckSpec {
  template?: string
  master: number
  font?: string
  keepSlides: boolean
  title?: string
  pages: TemplatePageSpec[]
}

export interface TemplateDeckPageIssue {
  page: number
  error?: string
  warnings?: string[]
}

export interface TemplateDeckSpecOptions {
  localImages?: boolean
  master?: number | string
  /** layout for pages without a layout field in implicit default-template mode */
  defaultLayout?: number | string
}

function flatLayouts(info: TemplateInfo): TemplateLayout[] {
  return info.masters.flatMap((m) => m.layouts)
}

function availableNames(info: TemplateInfo, mi: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const l of info.masters[mi]?.layouts ?? []) {
    if (!seen.has(l.name)) {
      seen.add(l.name)
      out.push(l.name)
    }
  }
  return out
}

interface ResolvedLayout {
  index: number
  layout: TemplateLayout
}

// Exact name first, then case-insensitive, searching masters in the given order.
function findLayoutByName(
  info: TemplateInfo,
  name: string,
  masterOrder: number[],
): TemplateLayout | undefined {
  for (const mi of masterOrder) {
    const layout = info.masters[mi]?.layouts.find((l) => l.name === name)
    if (layout) return layout
  }
  const lower = name.toLowerCase()
  for (const mi of masterOrder) {
    const layout = info.masters[mi]?.layouts.find((l) => l.name.toLowerCase() === lower)
    if (layout) return layout
  }
  return undefined
}

function resolveLayout(
  info: TemplateInfo,
  ref: unknown,
  preferred: number,
): { ok: true; resolved: ResolvedLayout } | { ok: false; error: string } {
  const flat = flatLayouts(info)
  if (typeof ref === 'number' && Number.isInteger(ref)) {
    const layout = flat[ref]
    if (!layout) {
      return {
        ok: false,
        error:
          'unknown layout index ' +
          ref +
          ' (this template has ' +
          flat.length +
          ' layouts, 0-' +
          (flat.length - 1) +
          ')',
      }
    }
    return { ok: true, resolved: { index: ref, layout } }
  }
  if (typeof ref === 'string' && ref.trim()) {
    let name = ref.trim()
    const masterOrder = [
      preferred,
      ...info.masters.map((m) => m.index).filter((x) => x !== preferred),
    ]
    // A layout name wins over the numeric and "<master>:<name>" readings, so a
    // layout literally named "1" is still reachable by its name.
    const named = findLayoutByName(info, name, masterOrder)
    if (named) return { ok: true, resolved: { index: named.index, layout: named } }
    // Other numeric strings are flat indexes, range-checked like numbers.
    if (/^\d+$/.test(name)) {
      const n = Number(name)
      const layout = flat[n]
      if (!layout) {
        return {
          ok: false,
          error:
            'unknown layout index ' +
            n +
            ' (this template has ' +
            flat.length +
            ' layouts, 0-' +
            (flat.length - 1) +
            ')',
        }
      }
      return { ok: true, resolved: { index: n, layout } }
    }
    let scope: number | undefined
    const scoped = /^(\d+)\s*:\s*(.+)$/.exec(name)
    if (scoped) {
      scope = Number(scoped[1])
      name = (scoped[2] ?? '').trim()
      if (!Number.isInteger(scope) || !info.masters[scope]) {
        return {
          ok: false,
          error:
            'unknown master ' +
            scoped[1] +
            ' in layout "' +
            ref.trim() +
            '" (this template has ' +
            info.masters.length +
            ' masters, 0-' +
            (info.masters.length - 1) +
            ')',
        }
      }
    }
    const layout = findLayoutByName(info, name, scope !== undefined ? [scope] : masterOrder)
    if (layout) return { ok: true, resolved: { index: layout.index, layout } }
    const names = availableNames(info, scope ?? preferred)
    return {
      ok: false,
      error:
        'unknown layout "' +
        name +
        '"' +
        (scope !== undefined ? ' in master ' + scope : '') +
        '; available layouts' +
        (scope === undefined ? ' in master ' + preferred : '') +
        ': ' +
        (names.join(', ') || '(none)'),
    }
  }
  const first = availableNames(info, preferred).slice(0, 8).join(', ')
  return {
    ok: false,
    error:
      '"layout" is required: a layout name (e.g. "' +
      first +
      '") or flat index from template inspect',
  }
}

function normalizeMaster(ref: unknown, info: TemplateInfo): number | undefined {
  if (typeof ref === 'number' && Number.isInteger(ref) && info.masters[ref]) return ref
  if (typeof ref === 'string' && ref.trim()) {
    const name = ref.trim()
    const exact = info.masters.find((m) => m.name === name)
    if (exact) return exact.index
    const lower = info.masters.find((m) => m.name.toLowerCase() === name.toLowerCase())
    if (lower) return lower.index
    if (/^\d+$/.test(name)) {
      const n = Number(name)
      if (info.masters[n]) return n
    }
  }
  return undefined
}

function numLevel(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 8 ? v : fallback
}

function normalizeBullets(v: unknown, level = 0, out: TemplateBullet[] = []): TemplateBullet[] {
  if (!Array.isArray(v)) return out
  for (const it of v) {
    if (Array.isArray(it)) {
      normalizeBullets(it, Math.min(level + 1, 8), out)
    } else if (it && typeof it === 'object') {
      const r = it as Record<string, unknown>
      if (Array.isArray(r.runs)) {
        const text = (r.runs as unknown[])
          .map((run) => (typeof asRecord(run).text === 'string' ? String(asRecord(run).text) : ''))
          .join('')
        if (text) out.push({ text, level: numLevel(r.level, level) })
      } else if (typeof r.text === 'string' && r.text) {
        out.push({ text: r.text, level: numLevel(r.level, level) })
      }
    } else if (typeof it === 'string' && it) {
      out.push({ text: it, level })
    }
  }
  return out
}

function textParagraphs(text: string): SpecParagraph[] {
  return text.split('\n').map((line) => ({ runs: [{ text: line }] }))
}

function bodyParagraphs(items: TemplateBullet[]): SpecParagraph[] {
  return items.map((b) => ({
    runs: [{ text: b.text }],
    ...(b.level ? { level: b.level } : {}),
  }))
}

function fillKey(ph: TemplatePlaceholder): string {
  return ph.type + ':' + ph.idx
}

function findBodyPh(layout: TemplateLayout): TemplatePlaceholder | undefined {
  return layout.placeholders.find((p) => p.type === 'body' || p.type === 'obj')
}

interface PageCtx {
  master: number
  pxW: number
  pxH: number
  localImages: boolean
  defaultLayout?: number | string
}

function parseTemplatePage(
  raw: unknown,
  i: number,
  info: TemplateInfo,
  ctx: PageCtx,
): { page?: TemplatePageSpec; error?: string; warnings?: string[] } {
  const root = asRecord(raw)
  const pageMaster = root.master !== undefined ? normalizeMaster(root.master, info) : undefined
  if (root.master !== undefined && pageMaster === undefined) {
    return {
      error:
        'unknown master ' +
        JSON.stringify(root.master) +
        ' (this template has ' +
        info.masters.length +
        ' masters)',
    }
  }
  const preferred = pageMaster ?? ctx.master
  const missingLayout = root.layout === undefined || root.layout === null || root.layout === ''
  const requestedLayout = missingLayout ? ctx.defaultLayout : root.layout
  const resolved = resolveLayout(info, requestedLayout, preferred)
  if (!resolved.ok) return { error: resolved.error }
  const layout = resolved.resolved.layout
  const master = layout.master
  const warnings: string[] = []
  const fills = new Map<string, TemplatePlaceholderFill>()
  const title = typeof root.title === 'string' && root.title.trim() ? root.title.trim() : undefined
  if (title !== undefined) {
    const ph = layout.placeholders.find((p) => p.type === 'title' || p.type === 'ctrTitle')
    if (!ph) {
      warnings.push(
        'layout "' +
          layout.name +
          '" has no title placeholder; title is only the outline echo - draw it in elements',
      )
    } else {
      fills.set(fillKey(ph), { ph, plain: true, paragraphs: textParagraphs(title) })
    }
  }
  const body = normalizeBullets(root.body)
  const bodyPh = findBodyPh(layout)
  if (body.length > 0) {
    if (!bodyPh) {
      warnings.push(
        'layout "' +
          layout.name +
          '" has no body placeholder; body is only the outline echo - draw it in elements',
      )
    } else {
      fills.set(fillKey(bodyPh), { ph: bodyPh, plain: true, paragraphs: bodyParagraphs(body) })
    }
  }
  const subtitle =
    typeof root.subtitle === 'string' && root.subtitle.trim() ? root.subtitle.trim() : undefined
  if (subtitle !== undefined) {
    let ph = layout.placeholders.find((p) => p.type === 'subTitle')
    if (!ph && bodyPh) {
      ph = layout.placeholders.find(
        (p) => (p.type === 'body' || p.type === 'obj') && p.idx !== bodyPh.idx,
      )
    }
    if (!ph) {
      warnings.push(
        'layout "' +
          layout.name +
          '" has no subtitle placeholder; subtitle is only the outline echo - draw it in elements',
      )
    } else {
      fills.set(fillKey(ph), { ph, plain: true, paragraphs: textParagraphs(subtitle) })
    }
  }
  if (Array.isArray(root.placeholders)) {
    for (const [j, entry] of (root.placeholders as unknown[]).entries()) {
      const rec = asRecord(entry)
      let target: TemplatePlaceholder | undefined
      if (typeof rec.idx === 'number' && Number.isInteger(rec.idx)) {
        const byIdx = layout.placeholders.filter((p) => p.idx === rec.idx)
        const wantType = typeof rec.type === 'string' && rec.type ? String(rec.type) : undefined
        target =
          (wantType ? byIdx.find((p) => p.type === wantType) : undefined) ??
          (wantType ? byIdx.find((p) => phTypeMatch(p.type, wantType)) : undefined) ??
          (wantType ? undefined : byIdx[0])
      } else if (typeof rec.type === 'string' && rec.type) {
        target =
          layout.placeholders.find((p) => p.type === rec.type) ??
          layout.placeholders.find((p) => phTypeMatch(p.type, String(rec.type)))
      }
      if (!target) {
        warnings.push(
          'placeholder entry ' +
            j +
            ' targets ' +
            JSON.stringify(rec.idx ?? rec.type ?? '?') +
            ' but layout "' +
            layout.name +
            '" has no such placeholder; dropped',
        )
        continue
      }
      const hasText = typeof rec.text === 'string'
      const paras = parseSpecParagraphs(rec.paragraphs)
      const bullets = normalizeBullets(rec.bullets)
      const image = typeof rec.image === 'string' && rec.image.trim() ? rec.image.trim() : undefined
      if (!hasText && paras.length === 0 && bullets.length === 0 && !image) {
        warnings.push(
          'placeholder entry ' +
            j +
            ' for "' +
            target.name +
            '" carries no text, paragraphs, bullets or image; dropped',
        )
        continue
      }
      const fill: TemplatePlaceholderFill = { ph: target }
      if (hasText || paras.length > 0 || bullets.length > 0) {
        fill.paragraphs = [
          ...(hasText ? textParagraphs(rec.text as string) : []),
          ...paras,
          ...bodyParagraphs(bullets),
        ]
      }
      if (image) {
        fill.image = { url: image, fit: rec.fit === 'contain' ? 'contain' : 'cover' }
      }
      fills.set(fillKey(target), fill)
    }
  }
  const parsed = parsePageSpecObject({ elements: root.elements ?? [] }, ctx.pxW, ctx.pxH, {
    localImages: ctx.localImages,
    allowEmptyElements: true,
  })
  if (!parsed.ok) return { error: parsed.error }
  warnings.push(...parsed.warnings)
  const notes = typeof root.notes === 'string' && root.notes.trim() ? root.notes : undefined
  return {
    page: {
      page: i,
      layoutIndex: resolved.resolved.index,
      layoutName: layout.name,
      master,
      ...(title !== undefined ? { title } : {}),
      fills: [...fills.values()],
      ...(notes !== undefined ? { notes } : {}),
      elements: parsed.spec.elements,
      ...(root.emptyPlaceholders === true ? { emptyPlaceholders: true as const } : {}),
    },
    ...(warnings.length ? { warnings } : {}),
  }
}

export function parseTemplateDeckSpec(
  raw: string | unknown,
  info: TemplateInfo,
  opts: TemplateDeckSpecOptions = {},
):
  | { ok: true; spec: TemplateDeckSpec; issues: TemplateDeckPageIssue[] }
  | { ok: false; error: string } {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      return { ok: false, error: 'invalid JSON: ' + (e instanceof Error ? e.message : String(e)) }
    }
  }
  let fields: Record<string, unknown> = {}
  let rawPages: unknown[] | null = null
  if (Array.isArray(parsed)) {
    rawPages = parsed
  } else if (parsed && typeof parsed === 'object') {
    const root = parsed as Record<string, unknown>
    if (Array.isArray(root.pages)) {
      fields = root
      rawPages = root.pages as unknown[]
    } else if ('layout' in root || 'elements' in root) {
      rawPages = [parsed]
    }
  }
  if (!rawPages) {
    return {
      ok: false,
      error:
        'expected { "pages": [ { "layout", ... } ] }, a bare array of pages, or one page object with "layout"',
    }
  }
  if (rawPages.length === 0) return { ok: false, error: 'the "pages" array is empty' }
  if (rawPages.length > MAX_DECK_PAGES) {
    return {
      ok: false,
      error: 'too many pages (' + rawPages.length + '; the limit is ' + MAX_DECK_PAGES + ')',
    }
  }
  const masterRef = fields.master ?? opts.master
  const master = masterRef !== undefined ? normalizeMaster(masterRef, info) : info.defaultMaster
  if (master === undefined) {
    return {
      ok: false,
      error:
        'unknown master ' +
        JSON.stringify(masterRef) +
        ' (this template has ' +
        info.masters.length +
        ' masters)',
    }
  }
  const ctx: PageCtx = {
    master,
    pxW: info.slideSize.px.w,
    pxH: info.slideSize.px.h,
    localImages: opts.localImages ?? false,
    ...(opts.defaultLayout !== undefined ? { defaultLayout: opts.defaultLayout } : {}),
  }
  const pages: TemplatePageSpec[] = []
  const issues: TemplateDeckPageIssue[] = []
  for (const [i, rawPage] of rawPages.entries()) {
    const r = parseTemplatePage(rawPage, i, info, ctx)
    if (!r.page) {
      issues.push({ page: i, error: r.error })
      continue
    }
    if (r.warnings?.length) issues.push({ page: i, warnings: r.warnings })
    pages.push(r.page)
  }
  if (pages.length === 0) {
    return {
      ok: false,
      error:
        'no valid pages (' + issues.map((x) => 'page ' + x.page + ': ' + x.error).join('; ') + ')',
    }
  }
  const font =
    typeof fields.font === 'string' && fields.font.trim() ? fields.font.trim() : undefined
  const title =
    typeof fields.title === 'string' && fields.title.trim() ? fields.title.trim() : undefined
  const template =
    typeof fields.template === 'string' && fields.template.trim()
      ? fields.template.trim()
      : undefined
  return {
    ok: true,
    spec: {
      ...(template !== undefined ? { template } : {}),
      master,
      ...(font !== undefined ? { font } : {}),
      keepSlides: fields.keepSlides === true,
      ...(title !== undefined ? { title } : {}),
      pages,
    },
    issues,
  }
}
export interface TemplateLayoutUsed {
  page: number
  layout: number
  layoutName: string
  master: number
}

export interface TemplateBuildResult {
  bytes: Uint8Array
  imageFailures: { page: number; url: string }[]
  imageWarnings: { page: number; message: string }[]
  issues: TemplateDeckPageIssue[]
  layoutsUsed: TemplateLayoutUsed[]
  totalSlides: number
  keptSlides: number
}

export type TemplateBuildDeps = BuildPageDeps & { font?: string }

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const EMPTY_SPTREE =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

function phTag(ph: TemplatePlaceholder): string {
  const typeAttr = ph.type && ph.type !== 'obj' ? ' type="' + escapeXmlAttr(ph.type) + '"' : ''
  return '<p:ph' + typeAttr + ' idx="' + ph.idx + '"/>'
}

function textFillXml(
  ph: TemplatePlaceholder,
  paragraphsXml: string,
  id: number,
  name: string,
): string {
  return (
    '<p:sp><p:nvSpPr><p:cNvPr id="' +
    id +
    '" name="' +
    escapeXmlAttr(name) +
    '"/>' +
    '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>' +
    phTag(ph) +
    '</p:nvPr></p:nvSpPr>' +
    '<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>' +
    paragraphsXml +
    '</p:txBody></p:sp>'
  )
}

function picFillXml(
  ph: TemplatePlaceholder,
  rid: string,
  fit: 'cover' | 'contain',
  dims: { width: number; height: number } | null,
  id: number,
  name: string,
): string {
  const to5 = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 100000)
  let srcRect = ''
  if (fit === 'cover' && dims) {
    const crop = coverCropFractions(dims.width, dims.height, ph.box.cx, ph.box.cy)
    if (crop) {
      const attrs =
        (crop.l ? ' l="' + to5(crop.l) + '"' : '') +
        (crop.t ? ' t="' + to5(crop.t) + '"' : '') +
        (crop.r ? ' r="' + to5(crop.r) + '"' : '') +
        (crop.b ? ' b="' + to5(crop.b) + '"' : '')
      if (attrs) srcRect = '<a:srcRect' + attrs + '/>'
    }
  }
  // Empty spPr inherits the layout placeholder geometry; contain instead
  // centers an aspect-true box inside it so the whole picture stays visible.
  let spPr = '<p:spPr/>'
  if (fit === 'contain' && dims && dims.width > 0 && dims.height > 0) {
    let x = ph.box.x
    let y = ph.box.y
    let cx = ph.box.cx
    let cy = ph.box.cy
    if (dims.width / dims.height > cx / cy) {
      const h = cx / (dims.width / dims.height)
      y += (cy - h) / 2
      cy = h
    } else {
      const w = cy * (dims.width / dims.height)
      x += (cx - w) / 2
      cx = w
    }
    spPr =
      '<p:spPr><a:xfrm><a:off x="' +
      Math.round(x) +
      '" y="' +
      Math.round(y) +
      '"/>' +
      '<a:ext cx="' +
      Math.round(cx) +
      '" cy="' +
      Math.round(cy) +
      '"/></a:xfrm></p:spPr>'
  }
  return (
    '<p:pic><p:nvPicPr><p:cNvPr id="' +
    id +
    '" name="' +
    escapeXmlAttr(name) +
    '"/>' +
    '<p:cNvPicPr/><p:nvPr>' +
    phTag(ph) +
    '</p:nvPr></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="' +
    rid +
    '"/>' +
    srcRect +
    '<a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    spPr +
    '</p:pic>'
  )
}

function templateSlideXml(shapes: string[]): string {
  return (
    XMLDECL +
    '<p:sld xmlns:a="' +
    NS_A +
    '" xmlns:r="' +
    NS_R +
    '" xmlns:p="' +
    NS_P +
    '">' +
    '<p:cSld><p:spTree>' +
    EMPTY_SPTREE +
    shapes.join('') +
    '</p:spTree></p:cSld>' +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  )
}

function fillParagraphs(fill: TemplatePlaceholderFill, font: string | undefined): Paragraph[] {
  const ps = fill.paragraphs ?? [{ runs: [{ text: '' }] }]
  if (fill.plain) {
    return ps.map((p) => ({
      runs: p.runs.map((r) => ({
        text: r.text,
        ...(font ? { fontFamily: font, latinFont: font, eaFont: font, csFont: font } : {}),
      })),
      ...(p.level ? { level: p.level } : {}),
    }))
  }
  return toEngineParagraphs(ps, font)
}

function setFontSlot(body: string, tag: 'latin' | 'ea', face: string): string {
  const selfClosed = new RegExp('<a:' + tag + '\\b[^>]*\\/>')
  if (selfClosed.test(body)) {
    return body.replace(selfClosed, '<a:' + tag + ' typeface="' + face + '"/>')
  }
  const paired = new RegExp('<a:' + tag + '\\b[^>]*>[\\s\\S]*?<\\/a:' + tag + '>')
  if (paired.test(body)) {
    return body.replace(paired, '<a:' + tag + ' typeface="' + face + '"/>')
  }
  if (tag === 'latin' || !/<a:latin\b/.test(body)) {
    return tag === 'latin'
      ? '<a:' + tag + ' typeface="' + face + '"/>' + body
      : body + '<a:' + tag + ' typeface="' + face + '"/>'
  }
  return body.replace(
    /(<a:latin\b[^>]*(\/>|>[\s\S]*?<\/a:latin>))/,
    '$1<a:ea typeface="' + face + '"/>',
  )
}

// Per-script theme fonts for Chinese (Hans simplified, Hant traditional). Office
// themes carry e.g. SimSun / PMingLiU here; PowerPoint can fall back to them for
// Chinese text when the ea slot does not apply, so they follow the template font.
const CHINESE_SCRIPT_FONT_RE = /<a:font\b(?=[^>]*\bscript=(?:"Han[st]"|'Han[st]'))[^>]*?\/?>/g

function setChineseScriptFonts(body: string, face: string): string {
  return body.replace(CHINESE_SCRIPT_FONT_RE, (tag: string) =>
    /\btypeface=/.test(tag)
      ? tag.replace(/\btypeface=(?:"[^"]*"|'[^']*')/, 'typeface="' + face + '"')
      : tag.replace(/^<a:font\b/, '<a:font typeface="' + face + '"'),
  )
}

// Template chrome: masters and layouts (plus notes/handout masters) whose run
// properties may name fonts outright, e.g. a slide-number field in SimSun.
const TEMPLATE_CHROME_RE =
  /^ppt\/(?:slideMasters|slideLayouts|notesMasters|handoutMasters)\/[^/]+\.xml$/
const EXPLICIT_RUN_FONT_RE = /<a:(latin|ea|cs)\b([^>]*?)(\/?)>/g

// Retype explicit latin/ea/cs fonts to the template font. Theme references
// (+mn-lt, +mj-ea, ...) already follow the retyped theme and stay; bullet and
// symbol fonts (a:buFont, a:sym) are other elements and stay too. The panose
// and charset hints describe the old face, so they go with it.
function retypeExplicitRunFonts(xml: string, face: string): string {
  return xml.replace(
    EXPLICIT_RUN_FONT_RE,
    (tag: string, kind: string, attrs: string, end: string) => {
      const current = /\btypeface=(?:"([^"]*)"|'([^']*)')/.exec(attrs)
      const value = current ? (current[1] ?? current[2] ?? '') : ''
      if (!value || value.startsWith('+')) return tag
      return '<a:' + kind + ' typeface="' + face + '"' + end + '>'
    },
  )
}

function applyTemplateFont(archive: OpenedPptx['archive'], font: string): void {
  const face = escapeXmlAttr(font)
  for (const path of [...archive.entries.keys()]) {
    if (!TEMPLATE_CHROME_RE.test(path)) continue
    const xml = archive.readText(path)
    if (!xml) continue
    const next = retypeExplicitRunFonts(xml, face)
    if (next !== xml) archive.entries.set(path, Buffer.from(next, 'utf8'))
  }
  for (const path of archive.entries.keys()) {
    if (!/^ppt\/theme\/theme\d+\.xml$/.test(path)) continue
    const xml = archive.readText(path)
    if (!xml) continue
    const next = xml.replace(
      /<a:(major|minor)Font>([\s\S]*?)<\/a:\1Font>/g,
      (m: string, kind: string, inner: string) =>
        '<a:' +
        kind +
        'Font>' +
        setChineseScriptFonts(
          setFontSlot(setFontSlot(String(inner), 'latin', face), 'ea', face),
          face,
        ) +
        '</a:' +
        kind +
        'Font>',
    )
    if (next !== xml) archive.entries.set(path, Buffer.from(next, 'utf8'))
  }
}

/**
 * Rename the slide parts to slide1.xml … slideN.xml in presentation order.
 * New slides are numbered after the template's samples (slide26.xml on a
 * 25-sample template), and the durable `s_<n>` ids derive from the part
 * name, so without this a fresh deck would start at s_26. Only called once
 * every sample slide is gone, so only the builder's own slides are renamed;
 * every relationship target and content-type override naming a slide part is
 * rewritten with the same map.
 */
export function renumberSlideParts(archive: OpenedPptx['archive']): void {
  const { slidePaths } = archive.readPresentation()
  const map = new Map<string, string>()
  slidePaths.forEach((path, i) => {
    const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(path)
    if (m && m[1] !== String(i + 1)) map.set(m[1]!, String(i + 1))
  })
  if (map.size === 0) return
  const renamed = new Map<string, Uint8Array>()
  for (const [path, data] of [...archive.entries]) {
    const m = /^ppt\/slides\/(_rels\/)?slide(\d+)\.xml(\.rels)?$/.exec(path)
    const to = m ? map.get(m[2]!) : undefined
    if (m && to && Boolean(m[1]) === Boolean(m[3])) {
      archive.entries.delete(path)
      renamed.set('ppt/slides/' + (m[1] ?? '') + 'slide' + to + '.xml' + (m[3] ?? ''), data)
    }
  }
  for (const [path, data] of renamed) archive.entries.set(path, data)
  for (const path of [...archive.entries.keys()]) {
    if (!path.endsWith('.rels') && path !== '[Content_Types].xml') continue
    const xml = archive.readText(path)
    if (!xml) continue
    const next = xml.replace(
      /(^|[^A-Za-z])slides\/slide(\d+)\.xml/g,
      (all, pre: string, n: string) => {
        const to = map.get(n)
        return to ? pre + 'slides/slide' + to + '.xml' : all
      },
    )
    if (next !== xml) archive.entries.set(path, Buffer.from(next, 'utf8'))
  }
}

function scrubTemplateSections(archive: OpenedPptx['archive']): void {
  const presPath = 'ppt/presentation.xml'
  let pres = archive.readText(presPath)
  if (!pres) return
  pres = pres
    .replace(/<p:custShowLst\b[^>]*\/>/g, '')
    .replace(/<p:custShowLst\b[^>]*>[\s\S]*?<\/p:custShowLst>/g, '')
    .replace(/<p:ext\b(?:[^>]*)>([\s\S]*?)<\/p:ext>/g, (m: string) =>
      /sectionLst/.test(m) ? '' : m,
    )
  archive.entries.set(presPath, Buffer.from(pres, 'utf8'))
}

function emptyTag(xml: string, tag: string): string {
  return xml.replace(
    new RegExp('<' + tag + '(\\s[^>]*)?>[\\s\\S]*?<\\/' + tag + '>', 'g'),
    '<' + tag + '/>',
  )
}

function scrubTemplateMetadata(
  archive: OpenedPptx['archive'],
  title: string | undefined,
  slideCount: number,
): void {
  const corePath = 'docProps/core.xml'
  const core = archive.readText(corePath)
  if (core) {
    let next = core
    for (const tag of [
      'dc:creator',
      'cp:lastModifiedBy',
      'dc:subject',
      'cp:keywords',
      'dc:description',
    ]) {
      next = emptyTag(next, tag)
    }
    next = emptyTag(next, 'dc:title')
    if (title) {
      next = next.replace(/<dc:title\/>/, '<dc:title>' + escapeXmlText(title) + '</dc:title>')
    }
    next = next.replace(/<cp:revision>\d+<\/cp:revision>/, '<cp:revision>1</cp:revision>')
    // A new deck, not the template: stamp both dates with the build time.
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    next = next.replace(
      /(<dcterms:(created|modified)\b[^>]*>)[^<]*(<\/dcterms:\2>)/g,
      (_m: string, open: string, _tag: string, close: string) => open + now + close,
    )
    archive.entries.set(corePath, Buffer.from(next, 'utf8'))
  }
  const appPath = 'docProps/app.xml'
  const app = archive.readText(appPath)
  if (app) {
    const next = app
      .replace(/<TitlesOfParts>[\s\S]*?<\/TitlesOfParts>/, '')
      .replace(/<HeadingPairs>[\s\S]*?<\/HeadingPairs>/, '')
      .replace(/<Slides>\d+<\/Slides>/, '<Slides>' + slideCount + '</Slides>')
    archive.entries.set(appPath, Buffer.from(next, 'utf8'))
  }
  const authorsPath = 'ppt/commentAuthors.xml'
  if (archive.readText(authorsPath) !== undefined && archive.readText(authorsPath) !== null) {
    archive.entries.set(
      authorsPath,
      Buffer.from(
        XMLDECL +
          '<p:cmAuthorLst xmlns:a="' +
          NS_A +
          '" xmlns:r="' +
          NS_R +
          '" xmlns:p="' +
          NS_P +
          '"/>',
        'utf8',
      ),
    )
  }
}

export async function buildTemplateDeck(
  templateBytes: Uint8Array,
  spec: TemplateDeckSpec,
  deps: TemplateBuildDeps,
): Promise<TemplateBuildResult> {
  if (spec.pages.length === 0) throw new Error('no valid pages')
  const info = await inspectTemplate(templateBytes)
  const flat = flatLayouts(info)
  const opened = await openPptx(templateBytes)
  const archive = opened.archive
  const n0 = opened.deck.slides.length
  const font = deps.font ?? spec.font
  const canvasW = info.slideSize.px.w
  const scale = opened.deck.size.cx / canvasW
  const imageFailures: TemplateBuildResult['imageFailures'] = []
  const imageWarnings: TemplateBuildResult['imageWarnings'] = []
  const layoutsUsed: TemplateLayoutUsed[] = []

  const urls = [
    ...new Set(spec.pages.flatMap((p) => p.fills.filter((f) => f.image).map((f) => f.image!.url))),
  ]
  const fetched = new Map<string, { bytes: Uint8Array; ext: string } | null>()
  await Promise.all(
    urls.map(async (url) => {
      try {
        fetched.set(url, await deps.fetchImage(url))
      } catch {
        fetched.set(url, null)
      }
    }),
  )

  for (const [k, page] of spec.pages.entries()) {
    const layout = flat[page.layoutIndex]
    if (!layout) throw new Error('unknown layout index ' + page.layoutIndex)
    const slide = insertSlideWithLayout(
      opened,
      n0 === 0 && k === 0 ? -1 : opened.deck.slides.length - 1,
      layout.path,
    )
    if (!slide) throw new Error('could not insert a slide with layout "' + page.layoutName + '"')
    const shapes: string[] = []
    let id = 2
    for (const fill of page.fills) {
      if (fill.image) {
        const img = fetched.get(fill.image.url)
        if (!img) {
          imageFailures.push({ page: page.page, url: fill.image.url })
          continue
        }
        const added = addImageMediaAndRel(opened, slide, img.bytes, img.ext)
        if (!added) {
          imageFailures.push({ page: page.page, url: fill.image.url })
          continue
        }
        const dims = deps.imageDims?.(img.bytes) ?? null
        shapes.push(
          picFillXml(fill.ph, added.rid, fill.image.fit, dims, id, fill.ph.name || 'Picture ' + id),
        )
        id++
      } else {
        const paras =
          fillParagraphs(fill, font)
            .map((p) => generateParagraphXml(p))
            .join('') || '<a:p/>'
        shapes.push(textFillXml(fill.ph, paras, id, fill.ph.name || 'Placeholder ' + id))
        id++
      }
    }
    if (page.emptyPlaceholders === true) {
      const filled = new Set(page.fills.map((f) => fillKey(f.ph)))
      for (const ph of layout.placeholders) {
        if (ph.type === 'dt' || ph.type === 'ftr' || ph.type === 'sldNum') continue
        if (filled.has(fillKey(ph))) continue
        // Empty inheriting shape so the host shows the layout click-to-add prompt.
        // Pic placeholders stay an empty sp with the pic ph (not a pic element).
        shapes.push(textFillXml(ph, '<a:p/>', id, ph.name || 'Placeholder ' + id))
        id++
      }
    }
    archive.entries.set(slide.path, Buffer.from(templateSlideXml(shapes), 'utf8'))
    layoutsUsed.push({
      page: page.page,
      layout: page.layoutIndex,
      layoutName: page.layoutName,
      master: page.master,
    })
  }

  if (!spec.keepSlides && n0 > 0) {
    for (let i = 0; i < n0; i++) deleteSlide(opened, 0)
    scrubTemplateSections(archive)
    renumberSlideParts(archive)
  }
  const current = reparseDeck(opened)
  const base = !spec.keepSlides && n0 > 0 ? 0 : n0
  for (const [k, page] of spec.pages.entries()) {
    const slide: Slide | undefined = current.deck.slides[base + k]
    if (!slide) throw new Error('built slide ' + k + ' is missing after reparse')
    const r = await addSpecElements(current, slide, page.elements, {
      scale,
      deps,
      ...(font ? { font } : {}),
    })
    for (const url of r.imageFailures) imageFailures.push({ page: page.page, url })
    for (const message of r.imageWarnings) imageWarnings.push({ page: page.page, message })
    if (page.notes !== undefined) setSlideNotes(current, base + k, page.notes)
  }
  if (font) applyTemplateFont(current.archive, font)
  scrubTemplateMetadata(current.archive, spec.title, current.deck.slides.length)
  let bytes = await savePptx(current)
  if (deps.fontMetrics) {
    for (let s = base; s < base + spec.pages.length; s++) {
      bytes = (await growTextBoxesToContent(bytes, deps.fontMetrics, s)) ?? bytes
    }
  }
  return {
    bytes,
    imageFailures,
    imageWarnings,
    issues: [],
    layoutsUsed,
    totalSlides: current.deck.slides.length,
    keptSlides: spec.keepSlides ? n0 : 0,
  }
}
