import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFileFromTemplate,
  importOfficeTemplate,
  listOfficeTemplates,
  type OfficeTemplateKind,
} from '../src/main/office-templates'

const tempDirs: string[] = []

function freshEnv(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shell-office-tmpl-'))
  tempDirs.push(dir)
  return { env: { ...process.env, TELEOFFICE_TEMPLATES_DIR: dir }, dir }
}

function trackTemp(dir: string): void {
  tempDirs.push(dir)
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const KINDS: OfficeTemplateKind[] = ['docx', 'xlsx', 'md', 'html', 'pdf']

describe('office-templates', () => {
  it('lists an empty directory for every kind', () => {
    const { env } = freshEnv()
    for (const kind of KINDS) expect(listOfficeTemplates(kind, env)).toEqual([])
  })

  it('imports each kind into its own directory and copies the bytes', () => {
    const { env, dir } = freshEnv()
    const srcDir = mkdtempSync(join(tmpdir(), 'shell-office-src-'))
    trackTemp(srcDir)
    const samples: Array<[OfficeTemplateKind, string, string]> = [
      ['docx', 'Quarterly Review.docx', 'quarterly-review'],
      ['xlsx', 'Budget.xlsx', 'budget'],
      ['md', 'Notes.markdown', 'notes'],
      ['html', 'Page.htm', 'page'],
      ['pdf', 'Brief.pdf', 'brief'],
    ]
    for (const [kind, file, slug] of samples) {
      const src = join(srcDir, file)
      writeFileSync(src, 'payload-' + kind)
      const imported = importOfficeTemplate(kind, src, env)
      expect(imported.name).toBe(slug)
      expect(imported.path.startsWith(join(dir, kind))).toBe(true)
      expect(readFileSync(imported.path, 'utf8')).toBe('payload-' + kind)
      expect(readFileSync(src, 'utf8')).toBe('payload-' + kind)
      const listed = listOfficeTemplates(kind, env)
      expect(listed.map((item) => item.name)).toEqual([slug])
    }
    // A slide-template listing of the root must not see these subdirectories' files.
    expect(existsSync(join(dir, 'templates.json'))).toBe(false)
  })

  it('picks a free name and falls back for non-ASCII stems', () => {
    const { env } = freshEnv()
    const srcDir = mkdtempSync(join(tmpdir(), 'shell-office-src-'))
    trackTemp(srcDir)
    const first = join(srcDir, 'Board.docx')
    const second = join(srcDir, 'Board.docx')
    writeFileSync(first, 'a')
    writeFileSync(second, 'b')
    expect(importOfficeTemplate('docx', first, env).name).toBe('board')
    expect(importOfficeTemplate('docx', second, env).name).toBe('board-2')
    const uni = join(srcDir, '\u6a21\u677f.docx')
    writeFileSync(uni, 'c')
    expect(importOfficeTemplate('docx', uni, env).name).toMatch(/^template(-2)?$/)
  })

  it('refuses the wrong extension for a kind', () => {
    const { env } = freshEnv()
    const srcDir = mkdtempSync(join(tmpdir(), 'shell-office-src-'))
    trackTemp(srcDir)
    const bad = join(srcDir, 'notes.txt')
    writeFileSync(bad, 'hello')
    expect(() => importOfficeTemplate('docx', bad, env)).toThrow('.docx')
    expect(() => importOfficeTemplate('pdf', join(srcDir, 'x.docx'), env)).toThrow('.pdf')
  })

  it('copies a template to a new untitled file and keeps the source', () => {
    const { env } = freshEnv()
    const srcDir = mkdtempSync(join(tmpdir(), 'shell-office-src-'))
    trackTemp(srcDir)
    const src = join(srcDir, 'Letter.docx')
    writeFileSync(src, 'dear-team')
    importOfficeTemplate('docx', src, env)
    const outDir = mkdtempSync(join(tmpdir(), 'shell-office-out-'))
    trackTemp(outDir)
    const first = createFileFromTemplate('docx', 'letter', outDir, 'Untitled Document', env)
    expect(first).toBe(join(outDir, 'Untitled Document.docx'))
    expect(readFileSync(first, 'utf8')).toBe('dear-team')
    const second = createFileFromTemplate('docx', 'letter', outDir, 'Untitled Document', env)
    expect(second).toBe(join(outDir, 'Untitled Document 2.docx'))
    expect(readFileSync(src, 'utf8')).toBe('dear-team')
  })

  it('refuses names that are not registered templates', () => {
    const { env } = freshEnv()
    const outDir = mkdtempSync(join(tmpdir(), 'shell-office-out-'))
    trackTemp(outDir)
    expect(() => createFileFromTemplate('xlsx', 'missing', outDir, 'Untitled', env)).toThrow(
      'unknown template',
    )
    expect(() =>
      createFileFromTemplate('xlsx', '../secrets.xlsx', outDir, 'Untitled', env),
    ).toThrow('got a path')
  })
})
