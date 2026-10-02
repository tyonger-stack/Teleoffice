import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFileFromTemplate,
  ensureOfficeTemplatesDir,
  importOfficeTemplate,
  listOfficeTemplates,
  type OfficeTemplateKind,
} from '../src/main/office-templates'
import { listSlideTemplates } from '../src/main/slide-templates'

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

  it('gives colliding stems unique names and opens the file that was chosen', () => {
    const { env } = freshEnv()
    const htmlDir = ensureOfficeTemplatesDir('html', env)
    writeFileSync(join(htmlDir, 'page.html'), 'html-bytes')
    writeFileSync(join(htmlDir, 'page.htm'), 'htm-bytes')
    writeFileSync(join(htmlDir, 'Page.HTML'), 'upper-bytes')
    mkdirSync(join(htmlDir, 'skip.html'))
    const htmlListed = listOfficeTemplates('html', env)
    expect(htmlListed.map((item) => item.name)).toEqual(['page', 'page-2', 'page-3'])
    const byName = new Map(htmlListed.map((item) => [item.name, item.path]))
    expect(readFileSync(byName.get('page')!, 'utf8')).toBe('html-bytes')
    expect(readFileSync(byName.get('page-2')!, 'utf8')).toBe('upper-bytes')
    expect(readFileSync(byName.get('page-3')!, 'utf8')).toBe('htm-bytes')

    const mdDir = ensureOfficeTemplatesDir('md', env)
    writeFileSync(join(mdDir, 'notes.markdown'), 'markdown-bytes')
    writeFileSync(join(mdDir, 'notes.md'), 'md-bytes')
    const mdListed = listOfficeTemplates('md', env)
    expect(mdListed.map((item) => item.name)).toEqual(['notes', 'notes-2'])
    expect(readFileSync(mdListed[0]!.path, 'utf8')).toBe('md-bytes')

    const outDir = mkdtempSync(join(tmpdir(), 'shell-office-out-'))
    trackTemp(outDir)
    expect(readFileSync(createFileFromTemplate('html', 'page', outDir, 'Page', env), 'utf8')).toBe(
      'html-bytes',
    )
    expect(
      readFileSync(createFileFromTemplate('html', 'page-3', outDir, 'Page', env), 'utf8'),
    ).toBe('htm-bytes')
    expect(readFileSync(createFileFromTemplate('md', 'notes', outDir, 'Notes', env), 'utf8')).toBe(
      'md-bytes',
    )
    expect(
      readFileSync(createFileFromTemplate('md', 'notes-2', outDir, 'Notes', env), 'utf8'),
    ).toBe('markdown-bytes')
  })

  it('keeps office files out of the slide list and slide files out of office lists', () => {
    const { env, dir } = freshEnv()
    writeFileSync(join(dir, 'deck.pptx'), 'pptx')
    writeFileSync(join(dir, 'docx.pptx'), 'also-pptx')
    const officeDir = ensureOfficeTemplatesDir('docx', env)
    writeFileSync(join(officeDir, 'letter.docx'), 'docx')
    writeFileSync(join(officeDir, 'deck.pptx'), 'pptx-in-docx-dir')
    expect(listOfficeTemplates('docx', env).map((item) => item.name)).toEqual(['letter'])
    expect(listSlideTemplates(env).map((item) => item.name)).toEqual(['deck', 'docx'])
  })
})
