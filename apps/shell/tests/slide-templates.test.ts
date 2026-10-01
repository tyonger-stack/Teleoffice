import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { openPptx, PackageArchive } from '@genoffice/pptx-engine'
import { addTemplate } from '@genoffice/pipelines/slides/templates'
import { makeTwoMasterTemplate } from '../../../packages/pipelines/tests/template-fixture'
import {
  createDeckFromTemplate,
  ensureTemplatesDir,
  importSlideTemplate,
  listSlideTemplates,
} from '../src/main/slide-templates'

const tempDirs: string[] = []

function freshEnv(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shell-tmpl-'))
  tempDirs.push(dir)
  return { env: { ...process.env, GENOFFICE_TEMPLATES_DIR: dir }, dir }
}

function trackTemp(dir: string): void {
  tempDirs.push(dir)
}

async function writeTemplateFile(dir: string, name: string): Promise<string> {
  const path = join(dir, name)
  writeFileSync(path, await makeTwoMasterTemplate())
  return path
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('slide-templates', () => {
  it('ensures the templates dir exists', () => {
    const { env, dir } = freshEnv()
    rmSync(dir, { recursive: true, force: true })
    expect(existsSync(dir)).toBe(false)
    expect(ensureTemplatesDir(env)).toBe(dir)
    expect(existsSync(dir)).toBe(true)
  })

  it('lists an empty registry', () => {
    const { env } = freshEnv()
    expect(listSlideTemplates(env)).toEqual([])
  })

  it('imports a pptx file and lists it', async () => {
    const { env } = freshEnv()
    const srcDir = mkdtempSync(join(tmpdir(), 'shell-tmpl-src-'))
    trackTemp(srcDir)
    const src = await writeTemplateFile(srcDir, 'Quarterly Review.pptx')
    const imported = importSlideTemplate(src, env)
    expect(imported.name).toBe('quarterly-review')
    expect(existsSync(imported.path)).toBe(true)
    const listed = listSlideTemplates(env)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ name: 'quarterly-review', source: 'registry', exists: true })
    // The registry copy is independent of the source file.
    expect(listed[0]!.path).not.toBe(src)
  })

  it('picks a free name for duplicates and falls back for non-ASCII stems', async () => {
    const { env } = freshEnv()
    const srcDir = mkdtempSync(join(tmpdir(), 'shell-tmpl-src-'))
    trackTemp(srcDir)
    const first = await writeTemplateFile(srcDir, 'Board.pptx')
    expect(importSlideTemplate(first, env).name).toBe('board')
    const second = await writeTemplateFile(srcDir, 'Board.pptx')
    expect(importSlideTemplate(second, env).name).toBe('board-2')
    const uni = await writeTemplateFile(srcDir, '\u6a21\u677f.pptx')
    const fb = importSlideTemplate(uni, env)
    expect(fb.name).toMatch(/^template(-2)?$/)
    const uni2 = await writeTemplateFile(srcDir, '\u6a21\u677f.pptx')
    const fb2 = importSlideTemplate(uni2, env)
    expect(fb2.name).not.toBe(fb.name)
    expect(listSlideTemplates(env)).toHaveLength(4)
  })

  it('refuses non-pptx sources', () => {
    const { env } = freshEnv()
    const srcDir = mkdtempSync(join(tmpdir(), 'shell-tmpl-src-'))
    trackTemp(srcDir)
    const bad = join(srcDir, 'notes.txt')
    writeFileSync(bad, 'hello')
    expect(() => importSlideTemplate(bad, env)).toThrow('.pptx')
  })

  it('creates a starter deck on the first sample layout with unique names', async () => {
    const { env } = freshEnv()
    const srcDir = mkdtempSync(join(tmpdir(), 'shell-tmpl-src-'))
    trackTemp(srcDir)
    const src = await writeTemplateFile(srcDir, 'Corp.pptx')
    importSlideTemplate(src, env)
    const outDir = mkdtempSync(join(tmpdir(), 'shell-deck-'))
    trackTemp(outDir)
    const first = await createDeckFromTemplate('corp', outDir, 'Untitled Presentation', env)
    expect(first).toBe(join(outDir, 'Untitled Presentation.pptx'))
    expect(existsSync(first)).toBe(true)
    const opened = await openPptx(new Uint8Array(readFileSync(first)))
    expect(opened.deck.slides).toHaveLength(1)
    // No stray temp files remain next to the deck.
    const leftovers = (await import('node:fs'))
      .readdirSync(outDir)
      .filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
    const second = await createDeckFromTemplate('corp', outDir, 'Untitled Presentation', env)
    expect(second).toBe(join(outDir, 'Untitled Presentation 2.pptx'))
    expect(basename(second)).toBe('Untitled Presentation 2.pptx')
  })

  it('falls back to a title layout when the template has no samples', async () => {
    const { env } = freshEnv()
    const srcDir = mkdtempSync(join(tmpdir(), 'shell-tmpl-src-'))
    trackTemp(srcDir)
    const full = await makeTwoMasterTemplate()
    const opened = await openPptx(full)
    // Strip the sample slides without deleting the masters/layouts.
    const pres = opened.archive.readText('ppt/presentation.xml') ?? ''
    opened.archive.entries.set(
      'ppt/presentation.xml',
      Buffer.from(pres.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, ''), 'utf8'),
    )
    const { savePptx } = await import('@genoffice/pptx-engine')
    const empty = await savePptx(opened)
    const src = join(srcDir, 'Empty.pptx')
    writeFileSync(src, empty)
    importSlideTemplate(src, env)
    const outDir = mkdtempSync(join(tmpdir(), 'shell-deck-'))
    trackTemp(outDir)
    const deckPath = await createDeckFromTemplate('empty', outDir, 'Untitled Presentation', env)
    const deckBytes = new Uint8Array(readFileSync(deckPath))
    const deckOpened = await openPptx(deckBytes)
    expect(deckOpened.deck.slides).toHaveLength(1)
    const archive = await PackageArchive.open(deckBytes)
    const slide = archive.readText(deckOpened.deck.slides[0]!.path) ?? ''
    // The fallback layout carries a title placeholder emitted empty.
    expect(slide).toMatch(/<p:ph[^>]*type="title"/)
    expect(slide).toContain('<p:spPr/>')
  })

  it('uses the registry master over the sample slides', async () => {
    const { env } = freshEnv()
    const srcDir = mkdtempSync(join(tmpdir(), 'shell-tmpl-src-'))
    trackTemp(srcDir)
    const src = await writeTemplateFile(srcDir, 'Corp.pptx')
    addTemplate('corp2', src, { master: 1 }, env)
    const outDir = mkdtempSync(join(tmpdir(), 'shell-deck-'))
    trackTemp(outDir)
    const deckPath = await createDeckFromTemplate('corp2', outDir, 'Untitled Presentation', env)
    const deckBytes = new Uint8Array(readFileSync(deckPath))
    const deckOpened = await openPptx(deckBytes)
    const archive = await PackageArchive.open(deckBytes)
    const slidePath = deckOpened.deck.slides[0]!.path
    const rels =
      archive.readText(slidePath.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')) ?? ''
    const layout = /slideLayouts\/(slideLayout\d+\.xml)/.exec(rels)?.[1]
    expect(layout).toBeDefined()
    const layoutRels = archive.readText('ppt/slideLayouts/_rels/' + layout + '.rels') ?? ''
    expect(layoutRels).toContain('slideMaster2.xml')
  })
})
