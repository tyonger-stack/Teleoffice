import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBlankPptx } from '@genoffice/pptx-engine'
import {
  addTemplate,
  listTemplates,
  removeTemplate,
  resolveTemplate,
  templatesDir,
} from '../src/slides/template-registry'

function freshEnv(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tmpl-reg-'))
  return { env: { ...process.env, GENOFFICE_TEMPLATES_DIR: dir }, dir }
}

function srcDir(): string {
  return mkdtempSync(join(tmpdir(), 'tmpl-src-'))
}

async function writeDeck(path: string): Promise<void> {
  writeFileSync(path, await createBlankPptx())
}

describe('template registry', () => {
  it('honors GENOFFICE_TEMPLATES_DIR and starts empty', () => {
    const { env, dir } = freshEnv()
    expect(templatesDir(env)).toBe(dir)
    expect(listTemplates(env)).toEqual([])
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
    // removing deletes the copied file, not the source
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
  })

  it('lists bare files by stem and suggests near names', async () => {
    const { env, dir } = freshEnv()
    await writeDeck(join(dir, 'board-deck.pptx'))
    expect(listTemplates(env)).toMatchObject([{ name: 'board-deck', source: 'file', exists: true }])
    expect(() => resolveTemplate('bored-deck', { env })).toThrow('did you mean "board-deck"?')
    expect(() => resolveTemplate('nothing-here', { env })).toThrow('registered templates')
  })
})
