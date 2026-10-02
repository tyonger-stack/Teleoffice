// Desktop templates for the non-slide Office kinds: list, import and copy.
// Slide decks stay in the pptx registry (slide-templates.ts). These files live
// in a per-kind subdirectory so they never show up as slide templates.
// Pure Node (no electron imports) so the logic stays unit-testable.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, extname, join, resolve, sep } from 'node:path'
import { templatesDir } from '@genoffice/pipelines/slides/templates'

export const OFFICE_TEMPLATE_KINDS = ['docx', 'xlsx', 'md', 'html', 'pdf'] as const
export type OfficeTemplateKind = (typeof OFFICE_TEMPLATE_KINDS)[number]

export interface OfficeTemplateItem {
  name: string
  path: string
  exists: boolean
}

const CANONICAL_EXT: Record<OfficeTemplateKind, string> = {
  docx: '.docx',
  xlsx: '.xlsx',
  md: '.md',
  html: '.html',
  pdf: '.pdf',
}

const ACCEPTED_EXT: Record<OfficeTemplateKind, readonly string[]> = {
  docx: ['.docx'],
  xlsx: ['.xlsx'],
  md: ['.md', '.markdown'],
  html: ['.html', '.htm'],
  pdf: ['.pdf'],
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function isOfficeTemplateKind(kind: unknown): kind is OfficeTemplateKind {
  return kind === 'docx' || kind === 'xlsx' || kind === 'md' || kind === 'html' || kind === 'pdf'
}

export function officeTemplatesDir(
  kind: OfficeTemplateKind,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(templatesDir(env), kind)
}

export function ensureOfficeTemplatesDir(
  kind: OfficeTemplateKind,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = officeTemplatesDir(kind, env)
  mkdirSync(dir, { recursive: true })
  return dir
}

function slugifyStem(stem: string): string | undefined {
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64)
  if (NAME_RE.test(slug)) return slug
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

function acceptedExt(kind: OfficeTemplateKind, path: string): boolean {
  return ACCEPTED_EXT[kind].includes(extname(path).toLowerCase())
}

// Lower rank wins the plain slug. Index 0 is the canonical extension.
function extRank(kind: OfficeTemplateKind, file: string): number {
  const idx = ACCEPTED_EXT[kind].indexOf(extname(file).toLowerCase())
  return idx === -1 ? ACCEPTED_EXT[kind].length : idx
}

function stemIsLower(file: string): boolean {
  const stem = basename(file, extname(file))
  return stem === stem.toLowerCase()
}

export function listOfficeTemplates(
  kind: OfficeTemplateKind,
  env: NodeJS.ProcessEnv = process.env,
): OfficeTemplateItem[] {
  const dir = officeTemplatesDir(kind, env)
  if (!existsSync(dir)) return []
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  // Canonical extension, then an already-lowercase stem, then filename order.
  // That way page.html keeps the name "page" and page.htm becomes "page-2"
  // instead of both listing as "page" (the click would always open the first).
  const candidates: Array<{ file: string; stem: string; rank: number; path: string }> = []
  for (const file of files) {
    if (file.startsWith('.')) continue
    const path = join(dir, file)
    if (!acceptedExt(kind, file)) continue
    let fileStat: ReturnType<typeof statSync>
    try {
      fileStat = statSync(path)
    } catch {
      continue
    }
    if (!fileStat.isFile()) continue
    const stem = basename(file, extname(file)).toLowerCase()
    if (!NAME_RE.test(stem)) continue
    candidates.push({ file, stem, rank: extRank(kind, file), path })
  }
  candidates.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank
    const aLower = stemIsLower(a.file) ? 0 : 1
    const bLower = stemIsLower(b.file) ? 0 : 1
    if (aLower !== bLower) return aLower - bLower
    if (a.file < b.file) return -1
    if (a.file > b.file) return 1
    return 0
  })
  const taken = new Set<string>()
  const out: OfficeTemplateItem[] = []
  for (const item of candidates) {
    const name = freeName(item.stem, taken)
    taken.add(name)
    out.push({ name, path: item.path, exists: true })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

// Import a file of this kind into the kind directory (copied), picking a free slug.
export function importOfficeTemplate(
  kind: OfficeTemplateKind,
  sourcePath: string,
  env: NodeJS.ProcessEnv = process.env,
): { name: string; path: string } {
  if (typeof sourcePath !== 'string' || !sourcePath) throw new Error('Invalid template path.')
  if (!acceptedExt(kind, sourcePath)) {
    throw new Error(
      'Template file must be a ' + ACCEPTED_EXT[kind].join(' or ') + ' file: ' + sourcePath,
    )
  }
  if (!existsSync(sourcePath)) throw new Error('Template file not found: ' + sourcePath)
  const stem = basename(sourcePath, extname(sourcePath))
  const taken = new Set(listOfficeTemplates(kind, env).map((item) => item.name))
  const slug = slugifyStem(stem)
  const name = freeName(slug ?? 'template', taken)
  const dir = ensureOfficeTemplatesDir(kind, env)
  const dest = join(dir, name + CANONICAL_EXT[kind])
  if (resolve(dest) !== resolve(sourcePath)) copyFileSync(sourcePath, dest)
  return { name, path: dest }
}

function uniqueFilePath(dir: string, base: string, ext: string): string {
  const first = join(dir, base + ext)
  if (!existsSync(first)) return first
  for (let i = 2; ; i++) {
    const candidate = join(dir, base + ' ' + i + ext)
    if (!existsSync(candidate)) return candidate
  }
}

function resolveListedTemplate(
  kind: OfficeTemplateKind,
  name: string,
  env: NodeJS.ProcessEnv,
): string {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('expected a template name, got an empty name')
  }
  const trimmed = name.trim()
  if (trimmed.includes('/') || trimmed.includes('\\') || !NAME_RE.test(trimmed.toLowerCase())) {
    throw new Error('expected a template name, got a path: ' + name)
  }
  const key = trimmed.toLowerCase()
  const hit = listOfficeTemplates(kind, env).find((item) => item.name === key)
  if (!hit || !hit.exists) throw new Error('unknown template "' + name + '"')
  const root = resolve(officeTemplatesDir(kind, env))
  const full = resolve(hit.path)
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error('template path escapes the templates directory')
  }
  return full
}

// Copy a registered template into dir under a free "Untitled …" name.
export function createFileFromTemplate(
  kind: OfficeTemplateKind,
  name: string,
  dir: string,
  untitledBase: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const source = resolveListedTemplate(kind, name, env)
  mkdirSync(dir, { recursive: true })
  const target = uniqueFilePath(dir, untitledBase, CANONICAL_EXT[kind])
  const tmp = join(dir, '.tmpl-' + randomBytes(6).toString('hex') + '.tmp')
  try {
    copyFileSync(source, tmp)
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
