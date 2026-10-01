/**
 * Named template registry: templates live in TELEOFFICE_TEMPLATES_DIR (or
 * ~/.teleoffice/templates) as <name>.pptx files plus a templates.json sidecar
 * with per-template defaults. Node with fs; no engine access needed.
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'

export interface TemplateRegistryEntry {
  path: string
  master?: number
  font?: string
  description?: string
  copied?: boolean
  startLayout?: string
}

export interface TemplateListItem {
  name: string
  path: string
  exists: boolean
  master?: number
  font?: string
  description?: string
  startLayout?: string
  source: 'registry' | 'file'
}

export interface ResolvedTemplate {
  name?: string
  path: string
  master?: number
  font?: string
  startLayout?: string
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

function validName(name: string): boolean {
  return NAME_RE.test(name.toLowerCase())
}

export function templatesDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.TELEOFFICE_TEMPLATES_DIR
  if (dir && dir.trim()) return resolve(dir.trim())
  return join(homedir(), '.teleoffice', 'templates')
}

function registryPath(dir: string): string {
  return join(dir, 'templates.json')
}

function lockPathFor(dir: string): string {
  return join(dir, 'templates.json.lock')
}

function cleanEntries(raw: unknown): Record<string, TemplateRegistryEntry> {
  const out: Record<string, TemplateRegistryEntry> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!validName(name) || !entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    if (typeof rec.path !== 'string') continue
    const cleaned: TemplateRegistryEntry = { path: rec.path }
    if (typeof rec.master === 'number' && Number.isInteger(rec.master)) cleaned.master = rec.master
    if (typeof rec.font === 'string') cleaned.font = rec.font
    if (typeof rec.description === 'string') cleaned.description = rec.description
    if (rec.copied === true) cleaned.copied = true
    if (typeof rec.startLayout === 'string' && rec.startLayout.trim()) {
      cleaned.startLayout = rec.startLayout.trim()
    }
    out[name.toLowerCase()] = cleaned
  }
  return out
}

// Lenient read for listing and resolving: a corrupt templates.json yields an
// empty registry so file-based templates still resolve, with corrupt set.
function readRegistryLenient(dir: string): {
  entries: Record<string, TemplateRegistryEntry>
  corrupt?: string
} {
  const path = registryPath(dir)
  if (!existsSync(path)) return { entries: {} }
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return { entries: {} }
  }
  try {
    const parsed = JSON.parse(raw) as { templates?: unknown }
    if (!parsed || typeof parsed !== 'object' || !parsed.templates) return { entries: {} }
    return { entries: cleanEntries(parsed.templates) }
  } catch (err) {
    return { entries: {}, corrupt: err instanceof Error ? err.message : String(err) }
  }
}

// Strict read for mutations: refuse to overwrite a corrupt registry file.
// Copies the corrupt file aside before throwing, never writes the registry.
function readRegistryStrict(dir: string): Record<string, TemplateRegistryEntry> {
  const path = registryPath(dir)
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf-8')
  try {
    const parsed = JSON.parse(raw) as { templates?: unknown }
    if (!parsed || typeof parsed !== 'object' || !parsed.templates) return {}
    return cleanEntries(parsed.templates)
  } catch (err) {
    try {
      copyFileSync(path, path + '.bak-' + Date.now())
    } catch {
      // backup is best effort; the refusal below is what matters
    }
    throw new Error(
      'templates.json is not valid JSON; fix or remove it: ' +
        path +
        ' (' +
        (err instanceof Error ? err.message : String(err)) +
        ')',
      { cause: err },
    )
  }
}

function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Exclusive lock for the read-modify-write cycle, kept synchronous for the
// existing sync API. Uses open(wx) with jittered back-off up to ~10s.
function acquireRegistryLock(dir: string): number {
  mkdirSync(dir, { recursive: true })
  const lockPath = lockPathFor(dir)
  const deadline = Date.now() + 10000
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o644)
      try {
        writeSync(fd, String(process.pid))
      } catch {
        // pid note is best effort; the lock file itself is the mutex
      }
      return fd
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      let stale = false
      try {
        const st = statSync(lockPath)
        if (Date.now() - st.mtimeMs > 30000) {
          stale = true
        } else {
          try {
            const pid = Number.parseInt(readFileSync(lockPath, 'utf-8').trim(), 10)
            if (Number.isFinite(pid) && pid > 0) {
              try {
                process.kill(pid, 0)
              } catch (killErr) {
                if ((killErr as NodeJS.ErrnoException).code === 'ESRCH') stale = true
              }
            }
          } catch {
            // unreadable lock: keep waiting, it may be freshly created
          }
        }
      } catch {
        // lock vanished between open and stat: retry immediately
      }
      if (stale) {
        try {
          rmSync(lockPath, { force: true })
        } catch {
          // another process may have taken it; fall through to back-off
        }
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error('timed out waiting for templates.json.lock in ' + dir, { cause: err })
      }
      sleepSyncMs(10 + Math.floor(Math.random() * 41))
    }
  }
}

function releaseRegistryLock(dir: string, fd: number): void {
  try {
    closeSync(fd)
  } catch {
    // ignore close errors; unlinking is what releases the lock
  }
  try {
    rmSync(lockPathFor(dir), { force: true })
  } catch {
    // ignore unlink errors; a stale lock is reclaimed by mtime/pid checks
  }
}

function withRegistryLock<T>(dir: string, fn: () => T): T {
  const fd = acquireRegistryLock(dir)
  try {
    return fn()
  } finally {
    releaseRegistryLock(dir, fd)
  }
}

// Atomic registry write: temp file in the same directory then rename.
function writeRegistryAtomic(dir: string, entries: Record<string, TemplateRegistryEntry>): void {
  mkdirSync(dir, { recursive: true })
  const target = registryPath(dir)
  const tmp = join(
    dir,
    'templates.json.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp',
  )
  try {
    writeFileSync(tmp, JSON.stringify({ templates: entries }, null, 2) + '\n')
    renameSync(tmp, target)
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // tmp may already be renamed; nothing to clean
    }
  }
}

export function registryReadError(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = templatesDir(env)
  const path = registryPath(dir)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { templates?: unknown }
    if (!parsed || typeof parsed !== 'object' || !parsed.templates) return undefined
    return undefined
  } catch (err) {
    return (
      'templates.json is not valid JSON; fix or remove it: ' +
      path +
      ' (' +
      (err instanceof Error ? err.message : String(err)) +
      ')'
    )
  }
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
  const entries = readRegistryLenient(dir).entries
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
      ...(entry.startLayout !== undefined ? { startLayout: entry.startLayout } : {}),
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
  const lenient = readRegistryLenient(dir)
  const entries = lenient.entries
  const listed = listTemplates(env)
  const names = [...Object.keys(entries), ...listed.map((t) => t.name)]
  const unique = [...new Set(names)]
  const candidate = isAbsolute(nameOrPath) ? nameOrPath : resolve(cwd, nameOrPath)
  if (isDeckFile(candidate) && existsSync(candidate)) {
    const named = listed.find((t) => t.path === candidate)
    return {
      ...(named ? { name: named.name } : {}),
      path: candidate,
      ...(named?.master !== undefined ? { master: named.master } : {}),
      ...(named?.font !== undefined ? { font: named.font } : {}),
      ...(named?.startLayout !== undefined ? { startLayout: named.startLayout } : {}),
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
      ...(entry.startLayout !== undefined ? { startLayout: entry.startLayout } : {}),
    }
  }
  const file = listed.find((t) => t.name === key)
  if (file) {
    return {
      name: file.name,
      path: file.path,
      ...(file.master !== undefined ? { master: file.master } : {}),
      ...(file.font !== undefined ? { font: file.font } : {}),
      ...(file.startLayout !== undefined ? { startLayout: file.startLayout } : {}),
    }
  }
  const hint = didYouMean(key, unique)
  let message =
    'unknown template "' +
    nameOrPath +
    '"; registered templates: ' +
    (unique.join(', ') || '(none)') +
    (hint ? '; did you mean "' + hint + '"?' : '')
  if (lenient.corrupt) {
    message += ' (templates.json is not valid JSON; fix or remove it)'
  }
  throw new Error(message)
}

// Names-only resolution for the desktop GUI IPC: accepts registered names
// and bare <dir>/*.pptx stems, never filesystem paths.
export function resolveRegisteredTemplate(
  name: string,
  opts: { env?: NodeJS.ProcessEnv } = {},
): ResolvedTemplate {
  const env = opts.env ?? process.env
  const dir = templatesDir(env)
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('expected a registered template name, got an empty name')
  }
  const trimmed = name.trim()
  if (
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    isAbsolute(trimmed) ||
    /\.potx?$/i.test(trimmed)
  ) {
    throw new Error('expected a registered template name, got a path: ' + name)
  }
  const lenient = readRegistryLenient(dir)
  const entries = lenient.entries
  const listed = listTemplates(env)
  const key = trimmed.toLowerCase()
  const entry = entries[key]
  if (entry) {
    return {
      name: key,
      path: entryPath(dir, entry),
      ...(entry.master !== undefined ? { master: entry.master } : {}),
      ...(entry.font !== undefined ? { font: entry.font } : {}),
      ...(entry.startLayout !== undefined ? { startLayout: entry.startLayout } : {}),
    }
  }
  const file = listed.find((t) => t.name === key)
  if (file) {
    return {
      name: file.name,
      path: file.path,
      ...(file.master !== undefined ? { master: file.master } : {}),
      ...(file.font !== undefined ? { font: file.font } : {}),
      ...(file.startLayout !== undefined ? { startLayout: file.startLayout } : {}),
    }
  }
  const names = [...Object.keys(entries), ...listed.map((t) => t.name)]
  const unique = [...new Set(names)]
  const hint = didYouMean(key, unique)
  let message =
    'unknown template "' +
    name +
    '"; registered templates: ' +
    (unique.join(', ') || '(none)') +
    (hint ? '; did you mean "' + hint + '"?' : '')
  if (lenient.corrupt) {
    message += ' (templates.json is not valid JSON; fix or remove it)'
  }
  throw new Error(message)
}

export interface AddTemplateOptions {
  copy?: boolean
  master?: number
  font?: string
  description?: string
  startLayout?: string
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
  if (opts.startLayout !== undefined) {
    if (typeof opts.startLayout !== 'string' || !opts.startLayout.trim()) {
      throw new Error('invalid start layout for template "' + key + '" (expected a layout name)')
    }
  }
  return withRegistryLock(dir, () => {
    const entries = readRegistryStrict(dir)
    if (entries[key] && !opts.force) {
      throw new Error('template "' + key + '" already exists (pass --force to overwrite)')
    }
    let stored = abs
    let copied = false
    if (opts.copy) {
      mkdirSync(dir, { recursive: true })
      const dest = join(dir, key + '.pptx')
      if (resolve(dest) === resolve(abs)) {
        stored = dest
      } else {
        if (existsSync(dest) && !opts.force) {
          throw new Error('template file ' + dest + ' already exists (pass --force to overwrite)')
        }
        copyFileSync(abs, dest)
        stored = dest
        copied = true
      }
    }
    // The layout itself is checked by callers that can inspect the template
    // (CLI `template add --start-layout`); the GUI falls back when it is gone.
    const startLayout = opts.startLayout?.trim() || undefined
    const rel = relative(dir, stored)
    entries[key] = {
      path: rel.startsWith('..') || isAbsolute(rel) ? stored : rel,
      ...(opts.master !== undefined ? { master: opts.master } : {}),
      ...(opts.font !== undefined ? { font: opts.font } : {}),
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(startLayout !== undefined ? { startLayout } : {}),
      ...(copied ? { copied: true as const } : {}),
    }
    writeRegistryAtomic(dir, entries)
    return { name: key, path: stored }
  })
}

export function removeTemplate(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): { removed: boolean; deletedFile?: string; keptFile?: string } {
  const key = name.toLowerCase()
  const dir = templatesDir(env)
  return withRegistryLock(dir, () => {
    const entries = readRegistryStrict(dir)
    const entry = entries[key]
    if (!entry) throw new Error('unknown template "' + name + '"')
    delete entries[key]
    writeRegistryAtomic(dir, entries)
    const full = entryPath(dir, entry)
    const inside = relative(dir, full)
    const isInside = !inside.startsWith('..') && !isAbsolute(inside)
    if (isInside && existsSync(full) && isDeckFile(full)) {
      if (entry.copied === true) {
        rmSync(full)
        return { removed: true, deletedFile: full }
      }
      return { removed: true, keptFile: full }
    }
    return { removed: true }
  })
}
