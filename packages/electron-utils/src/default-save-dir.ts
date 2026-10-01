/// The default folder where new/untitled files land on their first (silent)
/// save and where AI-generated drafts go. Defaults to <Documents>/TeleOffice
/// (formerly <Documents>/GenOffice); user-configurable via the
/// `defaultSaveDir` key in userData/app-settings.json (set from the home
/// screen's account menu). Every editor main module resolves through here so
/// they all honor the same setting.
import { accessSync, constants, mkdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** the subset of Electron's `app` needed here (kept structural: this package has no Electron dependency) */
export interface PathProvider {
  getPath(name: 'userData' | 'documents'): string
}

export const DEFAULT_SAVE_DIR_KEY = 'defaultSaveDir'

/** the configured folder from app-settings.json, or null when unset/unreadable */
export function readDefaultSaveDirSetting(settingsPath: string): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const value = (raw as Record<string, unknown>)[DEFAULT_SAVE_DIR_KEY]
    return typeof value === 'string' && isAbsolute(value) ? value : null
  } catch {
    return null
  }
}

/** true when the directory exists (or could be created) and is writable */
export function isUsableSaveDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Pick the effective default save folder: the configured one when it is
 * usable, otherwise the fallback (created on demand). A configured folder on
 * an unplugged drive or with revoked permissions degrades to the fallback
 * instead of breaking silent saves.
 */
export function resolveDefaultSaveDir(configured: string | null, fallbackDir: string): string {
  if (configured && isUsableSaveDir(configured)) return configured
  if (!isUsableSaveDir(fallbackDir)) throw new Error(`default save dir not usable: ${fallbackDir}`)
  return fallbackDir
}

/** folder name of the built-in default save folder under <Documents> */
export const DEFAULT_SAVE_DIR_NAME = 'TeleOffice'

/** folder name used before the TeleOffice rename; still honored for existing installs */
export const LEGACY_SAVE_DIR_NAME = 'GenOffice'

/** true when dir already exists as a writable directory (never creates it) */
function isExistingWritableDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The built-in fallback under <Documents>. New installs get TeleOffice. An
 * install that already has a GenOffice folder and no TeleOffice folder keeps
 * using GenOffice in place: nothing is renamed or moved, so open files,
 * recents, favorites and recovery drafts that point into it stay valid. Once a
 * TeleOffice folder exists (for example after the user renames the old one),
 * it wins.
 */
export function builtinDefaultSaveDir(documentsDir: string): string {
  const current = join(documentsDir, DEFAULT_SAVE_DIR_NAME)
  const legacy = join(documentsDir, LEGACY_SAVE_DIR_NAME)
  if (isExistingWritableDir(current)) return current
  if (isExistingWritableDir(legacy)) return legacy
  return current
}

/** convenience for the Electron mains: settings lookup + fallback in one call */
export function configuredDefaultSaveDir(app: PathProvider): string {
  const settingsPath = join(app.getPath('userData'), 'app-settings.json')
  const fallback = builtinDefaultSaveDir(app.getPath('documents'))
  return resolveDefaultSaveDir(readDefaultSaveDirSetting(settingsPath), fallback)
}
