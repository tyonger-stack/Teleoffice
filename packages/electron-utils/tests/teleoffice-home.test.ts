import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  migrateLegacyHome,
  relocatedPath,
  rewriteTemplateRegistry,
  teleofficeHomeDir,
} from '../src/teleoffice-home'

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'teleoffice-home-'))
}

function registry(dir: string, templates: Record<string, unknown>): string {
  const file = join(dir, 'templates', 'templates.json')
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(file, JSON.stringify({ templates }, null, 2) + '\n')
  return file
}

/** a legacy ~/.genoffice with the files a real install leaves behind */
function legacyHome(home: string): string {
  const legacy = join(home, '.genoffice')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'auth.json'), '{"key":"k"}')
  writeFileSync(join(legacy, 'launcher'), '/opt/GenOffice/resources/cli\n')
  writeFileSync(join(legacy, 'cli-audit.jsonl'), '{"cmd":"info"}\n')
  registry(legacy, {
    inside: { path: join(legacy, 'templates', 'brand.pptx'), master: 1 },
    outside: { path: '/srv/shared/company.pptx', font: 'Microsoft YaHei' },
    relative: { path: 'plain.pptx' },
  })
  writeFileSync(join(legacy, 'templates', 'brand.pptx'), 'pptx')
  return legacy
}

const read = (file: string) => JSON.parse(readFileSync(file, 'utf-8'))

describe('teleofficeHomeDir', () => {
  it('is ~/.teleoffice on a fresh machine', () => {
    const home = tempHome()
    expect(teleofficeHomeDir({}, home)).toBe(join(home, '.teleoffice'))
  })

  it('keeps reading ~/.genoffice until it has been migrated', () => {
    const home = tempHome()
    legacyHome(home)
    expect(teleofficeHomeDir({}, home)).toBe(join(home, '.genoffice'))
    mkdirSync(join(home, '.teleoffice'))
    expect(teleofficeHomeDir({}, home)).toBe(join(home, '.teleoffice'))
  })

  it('prefers TELEOFFICE_AUTH_DIR over the legacy GENOFFICE_AUTH_DIR', () => {
    const home = tempHome()
    expect(teleofficeHomeDir({ GENOFFICE_AUTH_DIR: '/old' }, home)).toBe('/old')
    expect(
      teleofficeHomeDir({ TELEOFFICE_AUTH_DIR: '/new', GENOFFICE_AUTH_DIR: '/old' }, home),
    ).toBe('/new')
    expect(teleofficeHomeDir({ TELEOFFICE_AUTH_DIR: '  ' }, home)).toBe(join(home, '.teleoffice'))
  })
})

describe('migrateLegacyHome', () => {
  it('does nothing without a legacy directory', () => {
    const home = tempHome()
    expect(migrateLegacyHome({ env: {}, home }).status).toBe('none')
    expect(existsSync(join(home, '.teleoffice'))).toBe(false)
  })

  it('leaves everything alone under an explicit override', () => {
    const home = tempHome()
    legacyHome(home)
    expect(migrateLegacyHome({ env: { TELEOFFICE_AUTH_DIR: '/x' }, home }).status).toBe('override')
    expect(existsSync(join(home, '.genoffice'))).toBe(true)
    expect(existsSync(join(home, '.teleoffice'))).toBe(false)
  })

  it('renames ~/.genoffice and rewrites registry paths that pointed inside it', () => {
    const home = tempHome()
    const legacy = legacyHome(home)
    const to = join(home, '.teleoffice')
    const r = migrateLegacyHome({ env: {}, home })
    expect(r).toMatchObject({ status: 'renamed', from: legacy, to, rewritten: 1 })
    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(join(to, 'auth.json'), 'utf-8')).toBe('{"key":"k"}')
    expect(readFileSync(join(to, 'launcher'), 'utf-8')).toBe('/opt/GenOffice/resources/cli\n')
    expect(readFileSync(join(to, 'cli-audit.jsonl'), 'utf-8')).toBe('{"cmd":"info"}\n')
    expect(read(join(to, 'templates', 'templates.json')).templates).toEqual({
      inside: { path: join(to, 'templates', 'brand.pptx'), master: 1 },
      outside: { path: '/srv/shared/company.pptx', font: 'Microsoft YaHei' },
      relative: { path: 'plain.pptx' },
    })
    expect(readdirSync(join(to, 'templates')).sort()).toEqual(['brand.pptx', 'templates.json'])
    // a second run finds the new directory and stops
    expect(migrateLegacyHome({ env: {}, home }).status).toBe('current')
  })

  it('copies when the rename fails, keeping the legacy directory', () => {
    const home = tempHome()
    const legacy = legacyHome(home)
    const to = join(home, '.teleoffice')
    const r = migrateLegacyHome({
      env: {},
      home,
      rename: () => {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
      },
    })
    expect(r).toMatchObject({ status: 'copied', rewritten: 1 })
    expect(readFileSync(join(to, 'auth.json'), 'utf-8')).toBe('{"key":"k"}')
    expect(read(join(to, 'templates', 'templates.json')).templates.inside.path).toBe(
      join(to, 'templates', 'brand.pptx'),
    )
    // the original is untouched, registry included
    expect(readFileSync(join(legacy, 'auth.json'), 'utf-8')).toBe('{"key":"k"}')
    expect(read(join(legacy, 'templates', 'templates.json')).templates.inside.path).toBe(
      join(legacy, 'templates', 'brand.pptx'),
    )
    // no temporary copy is left beside the result
    expect(readdirSync(home).sort()).toEqual(['.genoffice', '.teleoffice'])
  })

  it('uses the new directory when both exist and never touches the old one', () => {
    const home = tempHome()
    const legacy = legacyHome(home)
    const to = join(home, '.teleoffice')
    mkdirSync(to)
    writeFileSync(join(to, 'auth.json'), '{"key":"new"}')
    expect(migrateLegacyHome({ env: {}, home }).status).toBe('current')
    expect(readFileSync(join(to, 'auth.json'), 'utf-8')).toBe('{"key":"new"}')
    expect(readFileSync(join(legacy, 'auth.json'), 'utf-8')).toBe('{"key":"k"}')
    expect(existsSync(join(to, 'templates'))).toBe(false)
  })

  it.skipIf(process.getuid?.() === 0)(
    'reports a failure and keeps the legacy directory in use when nothing works',
    () => {
      const home = tempHome()
      const legacy = legacyHome(home)
      // a read-only home: neither the rename nor the temporary copy can be created
      chmodSync(home, 0o555)
      try {
        const r = migrateLegacyHome({ env: {}, home })
        expect(r.status).toBe('failed')
        expect(r.error).toMatch(/rename: .*; copy: /)
        expect(existsSync(join(home, '.teleoffice'))).toBe(false)
        expect(readFileSync(join(legacy, 'auth.json'), 'utf-8')).toBe('{"key":"k"}')
        expect(teleofficeHomeDir({}, home)).toBe(legacy)
      } finally {
        chmodSync(home, 0o755)
      }
    },
  )
})

describe('rewriteTemplateRegistry', () => {
  it('leaves a corrupt registry untouched', () => {
    const dir = tempHome()
    mkdirSync(join(dir, 'templates'))
    writeFileSync(join(dir, 'templates', 'templates.json'), '{not json')
    expect(rewriteTemplateRegistry(dir, '/old', dir)).toBe(0)
    expect(readFileSync(join(dir, 'templates', 'templates.json'), 'utf-8')).toBe('{not json')
  })

  it('does not rewrite a file when no path changes', () => {
    const dir = tempHome()
    const file = registry(dir, { a: { path: '/elsewhere/a.pptx' } })
    const before = readFileSync(file, 'utf-8')
    expect(rewriteTemplateRegistry(dir, '/old', dir)).toBe(0)
    expect(readFileSync(file, 'utf-8')).toBe(before)
  })
})

describe('relocatedPath', () => {
  it('moves only paths inside the old directory', () => {
    expect(relocatedPath('/h/.genoffice/t/a.pptx', '/h/.genoffice', '/h/.teleoffice')).toBe(
      '/h/.teleoffice/t/a.pptx',
    )
    expect(relocatedPath('/h/.genoffice', '/h/.genoffice', '/h/.teleoffice')).toBe('/h/.teleoffice')
    expect(relocatedPath('/h/.genoffice-other/a', '/h/.genoffice', '/h/.teleoffice')).toBeNull()
    expect(relocatedPath('/srv/a.pptx', '/h/.genoffice', '/h/.teleoffice')).toBeNull()
  })
})
