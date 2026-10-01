import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  builtinDefaultSaveDir,
  configuredDefaultSaveDir,
  readDefaultSaveDirSetting,
  resolveDefaultSaveDir,
} from '../src/index'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genoffice-save-dir-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('readDefaultSaveDirSetting', () => {
  const settingsPath = () => join(root, 'app-settings.json')

  it('returns the configured absolute path', () => {
    writeFileSync(settingsPath(), JSON.stringify({ defaultSaveDir: '/some/where' }))
    expect(readDefaultSaveDirSetting(settingsPath())).toBe('/some/where')
  })

  it('returns null when the file is missing, corrupt, or the key is absent', () => {
    expect(readDefaultSaveDirSetting(settingsPath())).toBeNull()
    writeFileSync(settingsPath(), 'not json')
    expect(readDefaultSaveDirSetting(settingsPath())).toBeNull()
    writeFileSync(settingsPath(), JSON.stringify({ language: 'en' }))
    expect(readDefaultSaveDirSetting(settingsPath())).toBeNull()
  })

  it('rejects non-string and relative values', () => {
    writeFileSync(settingsPath(), JSON.stringify({ defaultSaveDir: 42 }))
    expect(readDefaultSaveDirSetting(settingsPath())).toBeNull()
    writeFileSync(settingsPath(), JSON.stringify({ defaultSaveDir: 'relative/dir' }))
    expect(readDefaultSaveDirSetting(settingsPath())).toBeNull()
  })
})

describe('resolveDefaultSaveDir', () => {
  it('uses the configured folder when it is usable (creating it on demand)', () => {
    const configured = join(root, 'custom', 'nested')
    const resolved = resolveDefaultSaveDir(configured, join(root, 'fallback'))
    expect(resolved).toBe(configured)
    expect(existsSync(configured)).toBe(true)
  })

  it('creates and returns the fallback when nothing is configured', () => {
    const fallback = join(root, 'Documents', 'TeleOffice')
    expect(resolveDefaultSaveDir(null, fallback)).toBe(fallback)
    expect(existsSync(fallback)).toBe(true)
  })

  it('degrades to the fallback when the configured folder is not writable', () => {
    const readOnly = join(root, 'read-only')
    mkdirSync(readOnly)
    chmodSync(readOnly, 0o500)
    const fallback = join(root, 'fallback')
    try {
      expect(resolveDefaultSaveDir(readOnly, fallback)).toBe(fallback)
    } finally {
      chmodSync(readOnly, 0o700)
    }
  })

  it('throws a descriptive error when the fallback itself is unusable', () => {
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'x')
    expect(() => resolveDefaultSaveDir(null, blocker)).toThrow(/default save dir not usable/)
  })
})

describe('configuredDefaultSaveDir', () => {
  it('reads the setting from userData/app-settings.json and honors it', () => {
    const userData = join(root, 'userData')
    const documents = join(root, 'Documents')
    mkdirSync(userData, { recursive: true })
    const custom = join(root, 'my-files')
    writeFileSync(join(userData, 'app-settings.json'), JSON.stringify({ defaultSaveDir: custom }))
    const app = {
      getPath: (name: 'userData' | 'documents') => (name === 'userData' ? userData : documents),
    }
    expect(configuredDefaultSaveDir(app)).toBe(custom)
  })

  const appWith = (userData: string, documents: string) => ({
    getPath: (name: 'userData' | 'documents') => (name === 'userData' ? userData : documents),
  })

  it('falls back to <Documents>/TeleOffice without a setting', () => {
    const userData = join(root, 'userData')
    const documents = join(root, 'Documents')
    mkdirSync(userData, { recursive: true })
    expect(configuredDefaultSaveDir(appWith(userData, documents))).toBe(
      join(documents, 'TeleOffice'),
    )
    expect(existsSync(join(documents, 'TeleOffice'))).toBe(true)
    expect(existsSync(join(documents, 'GenOffice'))).toBe(false)
  })

  it('keeps using an existing legacy <Documents>/GenOffice in place', () => {
    const userData = join(root, 'userData')
    const documents = join(root, 'Documents')
    const legacy = join(documents, 'GenOffice')
    mkdirSync(userData, { recursive: true })
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'report.docx'), 'keep me')
    expect(configuredDefaultSaveDir(appWith(userData, documents))).toBe(legacy)
    // nothing is renamed, moved or created next to it
    expect(readFileSync(join(legacy, 'report.docx'), 'utf8')).toBe('keep me')
    expect(existsSync(join(documents, 'TeleOffice'))).toBe(false)
  })

  it('a configured folder still wins over the legacy folder', () => {
    const userData = join(root, 'userData')
    const documents = join(root, 'Documents')
    mkdirSync(userData, { recursive: true })
    mkdirSync(join(documents, 'GenOffice'), { recursive: true })
    const custom = join(root, 'my-files')
    writeFileSync(join(userData, 'app-settings.json'), JSON.stringify({ defaultSaveDir: custom }))
    expect(configuredDefaultSaveDir(appWith(userData, documents))).toBe(custom)
  })
})

describe('builtinDefaultSaveDir', () => {
  it('returns <Documents>/TeleOffice when neither folder exists, without creating it', () => {
    const documents = join(root, 'Documents')
    expect(builtinDefaultSaveDir(documents)).toBe(join(documents, 'TeleOffice'))
    expect(existsSync(join(documents, 'TeleOffice'))).toBe(false)
  })

  it('prefers TeleOffice once it exists, leaving the legacy folder untouched', () => {
    const documents = join(root, 'Documents')
    mkdirSync(join(documents, 'TeleOffice'), { recursive: true })
    mkdirSync(join(documents, 'GenOffice'), { recursive: true })
    writeFileSync(join(documents, 'GenOffice', 'old.xlsx'), 'old')
    expect(builtinDefaultSaveDir(documents)).toBe(join(documents, 'TeleOffice'))
    expect(readFileSync(join(documents, 'GenOffice', 'old.xlsx'), 'utf8')).toBe('old')
  })

  it('ignores a legacy GenOffice path that is a file, not a folder', () => {
    const documents = join(root, 'Documents')
    mkdirSync(documents, { recursive: true })
    writeFileSync(join(documents, 'GenOffice'), 'not a folder')
    expect(builtinDefaultSaveDir(documents)).toBe(join(documents, 'TeleOffice'))
  })

  it('skips a legacy folder that is not writable', () => {
    const documents = join(root, 'Documents')
    const legacy = join(documents, 'GenOffice')
    mkdirSync(legacy, { recursive: true })
    chmodSync(legacy, 0o500)
    try {
      expect(builtinDefaultSaveDir(documents)).toBe(join(documents, 'TeleOffice'))
    } finally {
      chmodSync(legacy, 0o700)
    }
  })
})
