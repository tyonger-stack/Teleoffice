import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createBlankPptx } from '@teleoffice/pptx-engine'
import {
  addTemplate,
  clearDefaultTemplate,
  getDefaultTemplate,
  listTemplates,
  removeTemplate,
  resolveRegisteredTemplate,
  resolveTemplate,
  setDefaultTemplate,
  templatesDir,
} from '../src/slides/template-registry'
import { inspectTemplate } from '../src/slides/template'

const owned: string[] = []

afterEach(() => {
  for (const dir of owned.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
})

function track(dir: string): string {
  owned.push(dir)
  return dir
}

function freshEnv(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = track(mkdtempSync(join(tmpdir(), 'tmpl-reg-')))
  return { env: { ...process.env, TELEOFFICE_TEMPLATES_DIR: dir }, dir }
}

function srcDir(): string {
  return track(mkdtempSync(join(tmpdir(), 'tmpl-src-')))
}

async function writeDeck(path: string): Promise<void> {
  writeFileSync(path, await createBlankPptx())
}

const workerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'template-registry-concurrency-worker.ts',
)

// Eight worker processes, each adding 20 entries (c-w<i>-n<j>).
function runWorkers(dir: string, src: string, startAt?: number): Promise<void[]> {
  const workers: Array<Promise<void>> = []
  for (let i = 0; i < 8; i++) {
    workers.push(
      new Promise<void>((done, fail) => {
        const args = ['--import', 'tsx', workerPath, dir, String(i), src]
        if (startAt !== undefined) args.push(String(startAt))
        const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let stderr = ''
        const errStream = child.stderr
        if (errStream) {
          errStream.on('data', (d) => {
            stderr += String(d)
          })
        }
        child.on('error', fail)
        child.on('exit', (code) => {
          if (code === 0) done()
          else fail(new Error('worker failed: ' + stderr))
        })
      }),
    )
  }
  return Promise.all(workers)
}

describe('template registry', () => {
  it('honors TELEOFFICE_TEMPLATES_DIR and starts empty', () => {
    const { env, dir } = freshEnv()
    expect(templatesDir(env)).toBe(dir)
    expect(listTemplates(env)).toEqual([])
  })

  it('still honors the legacy GENOFFICE_TEMPLATES_DIR, below TELEOFFICE_TEMPLATES_DIR', () => {
    const legacy = track(mkdtempSync(join(tmpdir(), 'tmpl-legacy-')))
    const current = track(mkdtempSync(join(tmpdir(), 'tmpl-current-')))
    expect(templatesDir({ GENOFFICE_TEMPLATES_DIR: legacy })).toBe(legacy)
    expect(
      templatesDir({ TELEOFFICE_TEMPLATES_DIR: current, GENOFFICE_TEMPLATES_DIR: legacy }),
    ).toBe(current)
  })

  it('defaults to templates/ in the per-user directory', () => {
    const home = track(mkdtempSync(join(tmpdir(), 'tmpl-home-')))
    expect(templatesDir({ TELEOFFICE_AUTH_DIR: home })).toBe(join(home, 'templates'))
  })

  it('adds, lists, resolves and removes a copied template', async () => {
    const { env, dir } = freshEnv()
    const src = join(srcDir(), 'src.pptx')
    await writeDeck(src)
    const added = addTemplate(
      'Quarterly',
      src,
      { copy: true, master: 1, font: 'Arial', description: 'QBR' },
      env,
    )
    expect(added.name).toBe('quarterly')
    expect(added.path).toBe(join(dir, 'quarterly.pptx'))
    const listed = listTemplates(env)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      name: 'quarterly',
      master: 1,
      font: 'Arial',
      source: 'registry',
      exists: true,
    })
    expect(resolveTemplate('QUARTERLY', { env }).path).toBe(join(dir, 'quarterly.pptx'))
    expect(resolveTemplate(join(dir, 'quarterly.pptx'), { env }).name).toBe('quarterly')
    const removed = removeTemplate('quarterly', env)
    expect(removed).toMatchObject({ removed: true, deletedFile: join(dir, 'quarterly.pptx') })
    expect(listTemplates(env)).toEqual([])
  })

  it('records absolute paths without copying and refuses clobbers', async () => {
    const { env } = freshEnv()
    const src = join(srcDir(), 'ext.pptx')
    await writeDeck(src)
    addTemplate('ext', src, {}, env)
    expect(() => addTemplate('ext', src, {}, env)).toThrow('already exists')
    addTemplate('ext', src, { force: true }, env)
    const removed = removeTemplate('ext', env)
    expect(removed.deletedFile).toBeUndefined()
    expect(removed.keptFile).toBeUndefined()
  })

  it('sets, reads, preserves, clears and removes the configured default', async () => {
    const { env, dir } = freshEnv()
    const src = join(srcDir(), 'src.pptx')
    await writeDeck(src)
    addTemplate('first', src, { copy: true }, env)
    expect(setDefaultTemplate('FIRST', env)).toBe('first')
    expect(getDefaultTemplate(env)).toBe('first')
    expect(JSON.parse(readFileSync(join(dir, 'templates.json'), 'utf-8'))).toMatchObject({
      default: 'first',
      templates: { first: { path: 'first.pptx' } },
    })
    expect(listTemplates(env)).toMatchObject([{ name: 'first', isDefault: true }])

    addTemplate('second', src, {}, env)
    expect(getDefaultTemplate(env)).toBe('first')
    expect(listTemplates(env)).toMatchObject([
      { name: 'first', isDefault: true },
      { name: 'second', isDefault: false },
    ])
    removeTemplate('second', env)
    expect(getDefaultTemplate(env)).toBe('first')
    removeTemplate('first', env)
    expect(getDefaultTemplate(env)).toBeUndefined()

    addTemplate('again', src, {}, env)
    setDefaultTemplate('again', env)
    expect(clearDefaultTemplate(env)).toBe('again')
    expect(clearDefaultTemplate(env)).toBeUndefined()
    expect(JSON.parse(readFileSync(join(dir, 'templates.json'), 'utf-8'))).not.toHaveProperty(
      'default',
    )
  })

  it('accepts a bare PPTX file, rejects unknown or path names, and exposes stale defaults', async () => {
    const { env, dir } = freshEnv()
    await writeDeck(join(dir, 'bare.pptx'))
    expect(setDefaultTemplate('bare', env)).toBe('bare')
    expect(listTemplates(env)).toMatchObject([{ name: 'bare', isDefault: true, source: 'file' }])
    expect(() => setDefaultTemplate('barr', env)).toThrow('did you mean "bare"?')
    expect(() => setDefaultTemplate('../bare.pptx', env)).toThrow('invalid template name')

    const src = join(srcDir(), 'removed.pptx')
    await writeDeck(src)
    addTemplate('gone', src, {}, env)
    setDefaultTemplate('gone', env)
    const reg = JSON.parse(readFileSync(join(dir, 'templates.json'), 'utf-8'))
    rmSync(src)
    writeFileSync(join(dir, 'templates.json'), JSON.stringify(reg))
    expect(getDefaultTemplate(env)).toBe('gone')
    expect(listTemplates(env).find((template) => template.name === 'gone')).toMatchObject({
      exists: false,
      isDefault: true,
    })
  })

  it('lists bare files by stem and suggests near names', async () => {
    const { env, dir } = freshEnv()
    await writeDeck(join(dir, 'board-deck.pptx'))
    expect(listTemplates(env)).toMatchObject([{ name: 'board-deck', source: 'file', exists: true }])
    expect(() => resolveTemplate('bored-deck', { env })).toThrow('did you mean "board-deck"?')
    expect(() => resolveTemplate('nothing-here', { env })).toThrow('registered templates')
  })

  it('refuses to overwrite the copy destination without force', async () => {
    const { env, dir } = freshEnv()
    const srcA = join(srcDir(), 'a.pptx')
    const srcB = join(srcDir(), 'b.pptx')
    await writeDeck(srcA)
    await writeDeck(srcB)
    addTemplate('guarded', srcA, { copy: true }, env)
    const dest = join(dir, 'guarded.pptx')
    const before = readFileSync(dest)
    expect(() => addTemplate('guarded', srcB, { copy: true }, env)).toThrow('--force')
    expect(readFileSync(dest).equals(before)).toBe(true)
    addTemplate('guarded', srcB, { copy: true, force: true }, env)
    expect(existsSync(dest)).toBe(true)
  })

  it('treats same-file copy as a no-op', async () => {
    const { env, dir } = freshEnv()
    const dest = join(dir, 'mydeck.pptx')
    await writeDeck(dest)
    const added = addTemplate('mydeck', dest, { copy: true }, env)
    expect(added.path).toBe(dest)
    expect(existsSync(dest)).toBe(true)
    expect(listTemplates(env)).toMatchObject([{ name: 'mydeck', source: 'registry' }])
  })

  it('refuses mutations on corrupt JSON without wiping it', async () => {
    const { env, dir } = freshEnv()
    const src = join(srcDir(), 'src.pptx')
    await writeDeck(src)
    addTemplate('good', src, {}, env)
    await writeDeck(join(dir, 'bare.pptx'))
    const regPath = join(dir, 'templates.json')
    writeFileSync(regPath, 'not json {')
    const before = readFileSync(regPath)
    expect(() => addTemplate('next', src, {}, env)).toThrow('templates.json is not valid JSON')
    expect(readFileSync(regPath).equals(before)).toBe(true)
    expect(() => removeTemplate('good', env)).toThrow('templates.json is not valid JSON')
    expect(readFileSync(regPath).equals(before)).toBe(true)
    const listed = listTemplates(env)
    expect(listed.some((t) => t.name === 'bare' && t.source === 'file')).toBe(true)
  })

  it('only deletes copied files inside the dir', async () => {
    const { env, dir } = freshEnv()
    const own = join(dir, 'users-own.pptx')
    await writeDeck(own)
    addTemplate('alias', own, {}, env)
    const kept = removeTemplate('alias', env)
    expect(kept.deletedFile).toBeUndefined()
    expect(kept.keptFile).toBe(own)
    expect(existsSync(own)).toBe(true)
    const src = join(srcDir(), 'src.pptx')
    await writeDeck(src)
    addTemplate('managed', src, { copy: true }, env)
    const managedPath = join(dir, 'managed.pptx')
    const deleted = removeTemplate('managed', env)
    expect(deleted.deletedFile).toBe(managedPath)
    expect(existsSync(managedPath)).toBe(false)
  })

  it('stores startLayout (layout validation lives in the CLI)', async () => {
    const { env } = freshEnv()
    const src = join(srcDir(), 'src.pptx')
    await writeDeck(src)
    const info = await inspectTemplate(await createBlankPptx())
    const valid = info.masters[0]?.layouts[0]?.name ?? ''
    expect(valid).not.toBe('')
    addTemplate('with-start', src, { startLayout: valid }, env)
    expect(listTemplates(env)).toMatchObject([{ name: 'with-start', startLayout: valid }])
    expect(resolveTemplate('with-start', { env }).startLayout).toBe(valid)
    expect(resolveRegisteredTemplate('with-start', { env }).startLayout).toBe(valid)
    expect(() => addTemplate('blank-start', src, { startLayout: '  ' }, env)).toThrow(
      'invalid start layout',
    )
  })

  it('resolveRegisteredTemplate rejects paths', async () => {
    const { env } = freshEnv()
    const src = join(srcDir(), 'src.pptx')
    await writeDeck(src)
    addTemplate('named', src, {}, env)
    expect(resolveRegisteredTemplate('named', { env }).path).toBe(src)
    expect(() => resolveRegisteredTemplate('a/b.pptx', { env })).toThrow(
      'expected a registered template name',
    )
    expect(() => resolveRegisteredTemplate(src, { env })).toThrow(
      'expected a registered template name',
    )
    expect(() => resolveRegisteredTemplate('missing-name', { env })).toThrow('unknown template')
  })

  it('keeps all entries under concurrent multi-process adds', async () => {
    const { env, dir } = freshEnv()
    const src = join(srcDir(), 'src.pptx')
    await writeDeck(src)
    await runWorkers(dir, src)
    const listed = listTemplates(env)
    expect(listed).toHaveLength(160)
    const names = new Set(listed.map((t) => t.name))
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 20; j++) {
        expect(names.has('c-w' + i + '-n' + j)).toBe(true)
      }
    }
    const parsed = JSON.parse(readFileSync(join(dir, 'templates.json'), 'utf-8'))
    expect(Object.keys(parsed.templates)).toHaveLength(160)
  }, 60000)

  it('keeps every entry when many waiters take over a stale lock at once', async () => {
    const { env, dir } = freshEnv()
    const src = join(srcDir(), 'src.pptx')
    await writeDeck(src)
    // a lock left by a crashed writer: dead pid and an mtime past the 30 s limit
    const dead = spawnSync(process.execPath, ['-e', ''])
    const lockPath = join(dir, 'templates.json.lock')
    writeFileSync(lockPath, String(dead.pid))
    const old = new Date(Date.now() - 120000)
    utimesSync(lockPath, old, old)
    // all eight workers hit the stale lock together after tsx has loaded
    await runWorkers(dir, src, Date.now() + 3000)
    const listed = listTemplates(env)
    expect(listed).toHaveLength(160)
    const parsed = JSON.parse(readFileSync(join(dir, 'templates.json'), 'utf-8'))
    expect(Object.keys(parsed.templates)).toHaveLength(160)
    expect(existsSync(lockPath)).toBe(false)
    expect(readdirSync(dir).filter((f) => f.includes('.lock'))).toEqual([])
  }, 60000)
})
