/// The per-user TeleOffice directory: auth.json, the CLI audit log, the
/// launcher pointer and the template registry. It was ~/.genoffice before the
/// command was renamed to teleoffice; `migrateLegacyHome` moves an existing
/// ~/.genoffice over once, and until that has happened the resolvers keep
/// reading the old directory so nothing already stored there goes missing.
/// Pure Node (no Electron), shared by the app, the CLI and the pipelines.
import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

export const HOME_DIR_NAME = '.teleoffice'
export const LEGACY_HOME_DIR_NAME = '.genoffice'

/** first non-blank value among the given environment variables */
export function envValue(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]
    if (value && value.trim()) return value.trim()
  }
  return undefined
}

/** explicit directory override: TELEOFFICE_AUTH_DIR, or the legacy GENOFFICE_AUTH_DIR */
export function homeDirOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return envValue(env, 'TELEOFFICE_AUTH_DIR', 'GENOFFICE_AUTH_DIR')
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * The directory to use right now, without touching the disk: an explicit
 * override, else ~/.teleoffice. While ~/.teleoffice does not exist yet but a
 * legacy ~/.genoffice does (migration not run, or it could not move the
 * folder), the legacy directory is returned so its contents stay reachable.
 */
export function teleofficeHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const override = homeDirOverride(env)
  if (override) return override
  const current = join(home, HOME_DIR_NAME)
  const legacy = join(home, LEGACY_HOME_DIR_NAME)
  if (!exists(current) && isDirectory(legacy)) return legacy
  return current
}

export type HomeMigrationStatus =
  /** an explicit directory override is set; nothing to migrate */
  | 'override'
  /** no legacy directory */
  | 'none'
  /** ~/.teleoffice already exists; a legacy directory, if any, is left as it is */
  | 'current'
  /** ~/.genoffice was renamed to ~/.teleoffice */
  | 'renamed'
  /** the rename failed, so ~/.genoffice was copied to ~/.teleoffice and kept */
  | 'copied'
  /** neither rename nor copy worked; ~/.genoffice stays in use */
  | 'failed'

export interface HomeMigrationResult {
  status: HomeMigrationStatus
  from: string
  to: string
  /** template registry entries whose path was rewritten into the new directory */
  rewritten: number
  error?: string
}

export interface HomeMigrationOptions {
  env?: NodeJS.ProcessEnv
  home?: string
  /** test seam: the rename step (defaults to fs.renameSync) */
  rename?: (from: string, to: string) => void
}

/**
 * One-time move of ~/.genoffice to ~/.teleoffice. Runs only when the new
 * directory does not exist and the legacy one does. Tries an atomic rename
 * first; if that fails (another device, permissions) it copies into a
 * temporary sibling and renames that into place, leaving the legacy
 * directory untouched. Never deletes anything and never throws. Absolute
 * paths inside the legacy directory recorded in templates/templates.json are
 * rewritten to the new location.
 */
export function migrateLegacyHome(opts: HomeMigrationOptions = {}): HomeMigrationResult {
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const from = join(home, LEGACY_HOME_DIR_NAME)
  const to = join(home, HOME_DIR_NAME)
  const result = (status: HomeMigrationStatus, extra: Partial<HomeMigrationResult> = {}) => ({
    status,
    from,
    to,
    rewritten: 0,
    ...extra,
  })
  if (homeDirOverride(env)) return result('override')
  if (exists(to)) return result('current')
  if (!isDirectory(from)) return result('none')
  const rename = opts.rename ?? renameSync
  try {
    rename(from, to)
    return result('renamed', { rewritten: rewriteTemplateRegistry(to, from, to) })
  } catch (renameErr) {
    // another process may have finished the move in the meantime
    if (exists(to)) return result('current')
    const tmp = `${to}.migrating-${process.pid}-${Math.random().toString(36).slice(2)}`
    try {
      cpSync(from, tmp, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      })
      renameSync(tmp, to)
      return result('copied', { rewritten: rewriteTemplateRegistry(to, from, to) })
    } catch (copyErr) {
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        // a leftover temp copy is harmless; the legacy directory is intact
      }
      if (exists(to)) return result('current')
      const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
      return result('failed', { error: `rename: ${msg(renameErr)}; copy: ${msg(copyErr)}` })
    }
  }
}

/** `path` moved from under `from` to under `to`, or null when it was not inside `from` */
export function relocatedPath(path: string, from: string, to: string): string | null {
  if (path === from) return to
  for (const s of new Set([sep, '/'])) {
    if (path.startsWith(from + s)) return to + path.slice(from.length)
  }
  return null
}

/**
 * Rewrite registry entries that pointed into the legacy directory. Every
 * other field and entry is kept as is; an unreadable or corrupt registry is
 * left alone. Returns how many paths changed.
 */
export function rewriteTemplateRegistry(dir: string, from: string, to: string): number {
  const file = join(dir, 'templates', 'templates.json')
  if (!existsSync(file)) return 0
  let doc: unknown
  try {
    doc = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return 0
  }
  if (!doc || typeof doc !== 'object') return 0
  const templates = (doc as { templates?: unknown }).templates
  if (!templates || typeof templates !== 'object') return 0
  let changed = 0
  for (const entry of Object.values(templates as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    if (typeof rec.path !== 'string') continue
    const next = relocatedPath(rec.path, from, to)
    if (next && next !== rec.path) {
      rec.path = next
      changed++
    }
  }
  if (!changed) return 0
  const tmp = `${file}.${process.pid}.migrate.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n')
    renameSync(tmp, file)
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // nothing else to clean up
    }
    return 0
  }
  return changed
}
