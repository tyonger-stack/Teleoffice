/**
 * Named template registry: templates live in GENOFFICE_TEMPLATES_DIR (or
 * ~/.genoffice/templates) as <name>.pptx files plus a templates.json sidecar
 * with per-template defaults. Node with fs; no engine access needed.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'

export interface TemplateRegistryEntry {
  path: string
  master?: number
  font?: string
  description?: string
}

export interface TemplateListItem {
  name: string
  path: string
  exists: boolean
  master?: number
  font?: string
  description?: string
  source: 'registry' | 'file'
}

export interface ResolvedTemplate {
  name?: string
  path: string
  master?: number
  font?: string
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

function validName(name: string): boolean {
  return NAME_RE.test(name.toLowerCase())
}

export function templatesDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.GENOFFICE_TEMPLATES_DIR
  if (dir && dir.trim()) return resolve(dir.trim())
  return join(homedir(), '.genoffice', 'templates')
}

function registryPath(dir: string): string {
  return join(dir, 'templates.json')
}

function readRegistry(dir: string): Record<string, TemplateRegistryEntry> {
  const path = registryPath(dir)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      templates?: Record<string, TemplateRegistryEntry>
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.templates) return {}
    const out: Record<string, TemplateRegistryEntry> = {}
    for (const [name, entry] of Object.entries(parsed.templates)) {
      if (!validName(name) || !entry || typeof entry !== 'object') continue
      if (typeof (entry as TemplateRegistryEntry).path !== 'string') continue
      out[name.toLowerCase()] = entry as TemplateRegistryEntry
    }
    return out
  } catch {
    return {}
  }
}

function writeRegistry(dir: string, entries: Record<string, TemplateRegistryEntry>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(registryPath(dir), JSON.stringify({ templates: entries }, null, 2) + '\n')
}

function entryPath(dir: string, entry: TemplateRegistryEntry): string {
  return isAbsolute(entry.path) ? entry.path : resolve(dir, entry.path)
}

function stemOf(path: string): string {
  return basename(path, extname(path))
}

function isDeckFile(path: string): boolean {
  return extname(path).toLowerCase() === '.pptx' || extname(path).toLowerCase() === '.potx'
}

export function listTemplates(env: NodeJS.ProcessEnv = process.env): TemplateListItem[] {
  const dir = templatesDir(env)
  const entries = readRegistry(dir)
  const out = new Map<string, TemplateListItem>()
  for (const [name, entry] of Object.entries(entries)) {
    const path = entryPath(dir, entry)
    out.set(name, {
      name,
      path,
      exists: existsSync(path),
      ...(entry.master !== undefined ? { master: entry.master } : {}),
      ...(entry.font !== undefined ? { font: entry.font } : {}),
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      source: 'registry',
    })
  }
  if (existsSync(dir)) {
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      files = []
    }
    for (const f of files) {
      const full = join(dir, f)
      if (!isDeckFile(full)) continue
      const name = stemOf(f).toLowerCase()
      if (!validName(name) || out.has(name)) continue
      out.set(name, { name, path: full, exists: true, source: 'file' })
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = prev[j]!
      prev[j] = next
    }
  }
  return prev[b.length]!
}

function didYouMean(name: string, names: string[]): string | undefined {
  let best: string | undefined
  let bestScore = 3
  for (const n of names) {
    const score = editDistance(name, n)
    if (score < bestScore) {
      bestScore = score
      best = n
    }
  }
  return best
}

export function resolveTemplate(
  nameOrPath: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ResolvedTemplate {
  const cwd = opts.cwd ?? process.cwd()
  const env = opts.env ?? process.env
  const dir = templatesDir(env)
  const entries = readRegistry(dir)
  const names = [...Object.keys(entries), ...listTemplates(env).map((t) => t.name)]
  const unique = [...new Set(names)]
  const candidate = isAbsolute(nameOrPath) ? nameOrPath : resolve(cwd, nameOrPath)
  if (isDeckFile(candidate) && existsSync(candidate)) {
    const named = listTemplates(env).find((t) => t.path === candidate)
    return {
      ...(named ? { name: named.name } : {}),
      path: candidate,
      ...(named?.master !== undefined ? { master: named.master } : {}),
      ...(named?.font !== undefined ? { font: named.font } : {}),
    }
  }
  const key = nameOrPath.toLowerCase()
  const entry = entries[key]
  if (entry) {
    return {
      name: key,
      path: entryPath(dir, entry),
      ...(entry.master !== undefined ? { master: entry.master } : {}),
      ...(entry.font !== undefined ? { font: entry.font } : {}),
    }
  }
  const file = listTemplates(env).find((t) => t.name === key)
  if (file) return { name: file.name, path: file.path }
  const hint = didYouMean(key, unique)
  throw new Error(
    'unknown template "' +
      nameOrPath +
      '"; registered templates: ' +
      (unique.join(', ') || '(none)') +
      (hint ? '; did you mean "' + hint + '"?' : ''),
  )
}

export interface AddTemplateOptions {
  copy?: boolean
  master?: number
  font?: string
  description?: string
  force?: boolean
  cwd?: string
}

export function addTemplate(
  name: string,
  sourcePath: string,
  opts: AddTemplateOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): { name: string; path: string } {
  const key = name.toLowerCase()
  if (!validName(name)) {
    throw new Error('invalid template name "' + name + '" (lowercase [a-z0-9._-], up to 64 chars)')
  }
  const cwd = opts.cwd ?? process.cwd()
  const abs = isAbsolute(sourcePath) ? sourcePath : resolve(cwd, sourcePath)
  if (!existsSync(abs)) throw new Error('template file not found: ' + sourcePath)
  if (!isDeckFile(abs))
    throw new Error('template file must be a .pptx or .potx file: ' + sourcePath)
  const dir = templatesDir(env)
  const entries = readRegistry(dir)
  if (entries[key] && !opts.force) {
    throw new Error('template "' + key + '" already exists (pass --force to overwrite)')
  }
  let stored = abs
  if (opts.copy) {
    mkdirSync(dir, { recursive: true })
    const dest = join(dir, key + '.pptx')
    copyFileSync(abs, dest)
    stored = dest
  }
  const rel = relative(dir, stored)
  entries[key] = {
    path: rel.startsWith('..') || isAbsolute(rel) ? stored : rel,
    ...(opts.master !== undefined ? { master: opts.master } : {}),
    ...(opts.font !== undefined ? { font: opts.font } : {}),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
  }
  writeRegistry(dir, entries)
  return { name: key, path: stored }
}

export function removeTemplate(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): { removed: boolean; deletedFile?: string } {
  const key = name.toLowerCase()
  const dir = templatesDir(env)
  const entries = readRegistry(dir)
  const entry = entries[key]
  if (!entry) throw new Error('unknown template "' + name + '"')
  delete entries[key]
  writeRegistry(dir, entries)
  const full = entryPath(dir, entry)
  const inside = relative(dir, full)
  if (!inside.startsWith('..') && !isAbsolute(inside) && existsSync(full) && isDeckFile(full)) {
    rmSync(full)
    return { removed: true, deletedFile: full }
  }
  return { removed: true }
}
