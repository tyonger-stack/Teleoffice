import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { run, tempDir } from './helpers'

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

function ownedTempDir(): string {
  return track(tempDir())
}

function textEl(text: string) {
  return {
    type: 'text',
    x: 80,
    y: 60,
    w: 800,
    h: 90,
    paragraphs: [{ runs: [{ text, sizePt: 28 }] }],
  }
}

async function makeTemplate(dir: string): Promise<string> {
  const spec = join(dir, 'base-spec.json')
  writeFileSync(spec, JSON.stringify({ pages: [{ elements: [textEl('Base')] }] }))
  const template = join(dir, 'base.pptx')
  const r = await run(['create', '--type', 'pptx', '--spec', spec, '--out', template, '--json'], {
    cwd: dir,
  })
  expect(r.code).toBe(0)
  return template
}

function templateEnv(dir: string): { cwd: string; env: NodeJS.ProcessEnv } {
  const templates = track(mkdtempSync(join(tmpdir(), 'genoffice-templates-')))
  return { cwd: dir, env: { ...process.env, GENOFFICE_TEMPLATES_DIR: templates } }
}

describe('genoffice template', () => {
  it('inspects a deck, manages the registry and reports the dir', async () => {
    const dir = ownedTempDir()
    const ctx = templateEnv(dir)
    const template = await makeTemplate(dir)
    const inspected = await run(['template', 'inspect', template, '--json'], ctx)
    expect(inspected.code).toBe(0)
    const detail = inspected.json().detail
    expect(detail.masters).toHaveLength(1)
    expect(detail.canvas).toEqual({ w: 1280, h: 720 })
    expect(detail.usage.length).toBeGreaterThan(0)
    expect(inspected.json().summary).toContain('1 layouts')
    expect((await run(['template', 'list', '--json'], ctx)).json().detail.templates).toEqual([])
    const added = await run(
      ['template', 'add', 'Base', template, '--master', '0', '--font', 'Arial', '--json'],
      ctx,
    )
    expect(added.code).toBe(0)
    expect(added.json().detail.name).toBe('base')
    const listed = await run(['template', 'list', '--json'], ctx)
    expect(listed.json().detail.templates).toMatchObject([{ name: 'base', master: 0 }])
    const byName = await run(['template', 'inspect', 'base', '--json'], ctx)
    expect(byName.code).toBe(0)
    expect(byName.json().detail.path).toBe(template)
    expect((await run(['template', 'remove', 'base', '--json'], ctx)).code).toBe(0)
    expect((await run(['template', 'list', '--json'], ctx)).json().detail.templates).toEqual([])
    expect((await run(['template', 'path', '--json'], ctx)).json().detail.path).toBe(
      ctx.env.GENOFFICE_TEMPLATES_DIR,
    )
  })

  it('builds a deck on a template file and on a registered name', async () => {
    const dir = ownedTempDir()
    const ctx = templateEnv(dir)
    const template = await makeTemplate(dir)
    const layout = (await run(['template', 'inspect', template, '--json'], ctx)).json().detail
      .masters[0].layouts[0].name as string
    const spec = join(dir, 'deck.json')
    writeFileSync(
      spec,
      JSON.stringify({
        pages: [
          { layout, title: 'Cover echo', elements: [textEl('Hello template')] },
          { layout, elements: [textEl('Second page')] },
        ],
      }),
    )
    const out = join(dir, 'deck.pptx')
    const r = await run(
      ['create', '--type', 'pptx', '--template', template, '--spec', spec, '--out', out, '--json'],
      ctx,
    )
    expect(r.code).toBe(0)
    expect(r.json().summary).toContain('2 slides')
    expect(r.json().detail.template.layoutsUsed).toHaveLength(2)
    expect(r.json().detail.template.slideSize).toEqual({ w: 1280, h: 720 })
    const read = await run(['slides', 'read', out, '--json'], ctx)
    expect(read.json().detail.slides).toBe(2)
    await run(['template', 'add', 'base', template, '--json'], ctx)
    const spec2 = join(dir, 'deck2.json')
    writeFileSync(
      spec2,
      JSON.stringify({ template: 'base', pages: [{ layout, elements: [textEl('By name')] }] }),
    )
    const out2 = join(dir, 'deck2.pptx')
    const r2 = await run(
      [
        'create',
        '--type',
        'pptx',
        '--template',
        'base',
        '--spec',
        spec2,
        '--out',
        out2,
        '--font',
        'Arial',
        '--keep-template-slides',
        '--json',
      ],
      ctx,
    )
    expect(r2.code).toBe(0)
    expect(r2.json().detail.template.name).toBe('base')
    expect((await run(['slides', 'read', out2, '--json'], ctx)).json().detail.slides).toBe(2)
  })

  it('refuses unknown layouts and non-pptx or ops template builds', async () => {
    const dir = ownedTempDir()
    const ctx = templateEnv(dir)
    const template = await makeTemplate(dir)
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, JSON.stringify({ pages: [{ layout: 'Nope', elements: [textEl('x')] }] }))
    const r = await run(
      [
        'create',
        '--type',
        'pptx',
        '--template',
        template,
        '--spec',
        bad,
        '--out',
        join(dir, 'x.pptx'),
        '--json',
      ],
      ctx,
    )
    expect(r.code).toBe(1)
    expect(r.json().message).toContain('unknown layout')
    const ops = join(dir, 'ops.json')
    writeFileSync(ops, JSON.stringify([]))
    const rOps = await run(
      [
        'create',
        '--type',
        'pptx',
        '--template',
        template,
        '--ops',
        ops,
        '--out',
        join(dir, 'y.pptx'),
        '--json',
      ],
      ctx,
    )
    expect(rOps.code).toBe(1)
    expect(rOps.json().message).toContain('--ops')
  })

  it('checks outlines and pages in template mode and aliases slides layouts', async () => {
    const dir = ownedTempDir()
    const ctx = templateEnv(dir)
    const template = await makeTemplate(dir)
    const layout = (await run(['template', 'inspect', template, '--json'], ctx)).json().detail
      .masters[0].layouts[0].name as string
    const outline = join(dir, 'outline.json')
    writeFileSync(
      outline,
      JSON.stringify({
        core_hook: 'A hook with tension and a number: sales grew 40 percent.',
        template,
        pages: [
          {
            title: 'Cover echo',
            type: 'content',
            layout,
            brief: 'The cover echo page with the headline and the supporting facts and figures.',
            image_queries: [],
          },
        ],
      }),
    )
    const checked = await run(['slides', 'check', outline, '--json'], ctx)
    expect(checked.code).toBe(0)
    expect(checked.json().detail.template.slideSize).toEqual({ w: 1280, h: 720 })
    const page = join(dir, 'pages', '01.json')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'pages'), { recursive: true })
    writeFileSync(
      page,
      JSON.stringify({ title: 'Cover echo', type: 'content', layout, elements: [textEl('Hello')] }),
    )
    const pageChecked = await run(['slides', 'check', page, '--json'], ctx)
    expect(pageChecked.code).toBe(0)
    expect(pageChecked.json().detail.template.path).toBe(template)
    const layouts = await run(['slides', 'layouts', template, '--json'], ctx)
    expect(layouts.code).toBe(0)
    expect(layouts.json().summary).toContain('1 layouts')
  })

  it('guards copy destination, same-file copy and remove kept files', async () => {
    const dir = ownedTempDir()
    const ctx = templateEnv(dir)
    const template = await makeTemplate(dir)
    const templatesDir = ctx.env.GENOFFICE_TEMPLATES_DIR as string
    await run(['template', 'add', 'guarded', template, '--copy', '--json'], ctx)
    const dest = join(templatesDir, 'guarded.pptx')
    expect(existsSync(dest)).toBe(true)
    const before = readFileSync(dest)
    const clash = await run(['template', 'add', 'guarded', template, '--copy', '--json'], ctx)
    expect(clash.code).toBe(1)
    expect(clash.json().message).toContain('--force')
    expect(readFileSync(dest).equals(before)).toBe(true)
    const forced = await run(
      ['template', 'add', 'guarded', template, '--copy', '--force', '--json'],
      ctx,
    )
    expect(forced.code).toBe(0)
    const ownFile = join(templatesDir, 'users-own.pptx')
    writeFileSync(ownFile, readFileSync(template))
    const aliasAdded = await run(['template', 'add', 'alias', ownFile, '--json'], ctx)
    expect(aliasAdded.code).toBe(0)
    const removedAlias = await run(['template', 'remove', 'alias', '--json'], ctx)
    expect(removedAlias.code).toBe(0)
    expect(removedAlias.json().detail.keptFile).toBe(ownFile)
    expect(existsSync(ownFile)).toBe(true)
    const removedGuarded = await run(['template', 'remove', 'guarded', '--json'], ctx)
    expect(removedGuarded.code).toBe(0)
    expect(removedGuarded.json().detail.deletedFile).toBe(dest)
    expect(existsSync(dest)).toBe(false)
  })

  it('validates start-layout and shows it in list', async () => {
    const dir = ownedTempDir()
    const ctx = templateEnv(dir)
    const template = await makeTemplate(dir)
    const layout = (await run(['template', 'inspect', template, '--json'], ctx)).json().detail
      .masters[0].layouts[0].name as string
    const ok = await run(
      ['template', 'add', 'with-start', template, '--start-layout', layout, '--json'],
      ctx,
    )
    expect(ok.code).toBe(0)
    const listed = await run(['template', 'list', '--json'], ctx)
    expect(listed.json().detail.templates).toMatchObject([
      { name: 'with-start', startLayout: layout },
    ])
    const bad = await run(
      ['template', 'add', 'bad-start', template, '--start-layout', 'No Such Layout XYZ', '--json'],
      ctx,
    )
    expect(bad.code).toBe(1)
    expect(bad.json().message).toContain('available layouts')
  })

  it('reports kept slides in the create summary', async () => {
    const dir = ownedTempDir()
    const ctx = templateEnv(dir)
    const template = await makeTemplate(dir)
    const layout = (await run(['template', 'inspect', template, '--json'], ctx)).json().detail
      .masters[0].layouts[0].name as string
    const spec = join(dir, 'deck.json')
    writeFileSync(spec, JSON.stringify({ pages: [{ layout, elements: [textEl('New page')] }] }))
    const out = join(dir, 'deck.pptx')
    const r = await run(
      [
        'create',
        '--type',
        'pptx',
        '--template',
        template,
        '--spec',
        spec,
        '--out',
        out,
        '--keep-template-slides',
        '--json',
      ],
      ctx,
    )
    expect(r.code).toBe(0)
    expect(r.json().summary).toContain('2 slides')
    expect(r.json().summary).toContain('1 new')
    expect(r.json().summary).toContain('kept from template')
  })

  it('rejects template paths with bad extension or missing files', async () => {
    const dir = ownedTempDir()
    const ctx = templateEnv(dir)
    const template = await makeTemplate(dir)
    const layout = (await run(['template', 'inspect', template, '--json'], ctx)).json().detail
      .masters[0].layouts[0].name as string
    const spec = join(dir, 'deck.json')
    writeFileSync(spec, JSON.stringify({ pages: [{ layout, elements: [textEl('x')] }] }))
    const badExt = join(dir, 'note.txt')
    writeFileSync(badExt, 'hello')
    const rExt = await run(
      [
        'create',
        '--type',
        'pptx',
        '--template',
        badExt,
        '--spec',
        spec,
        '--out',
        join(dir, 'o1.pptx'),
        '--json',
      ],
      ctx,
    )
    expect(rExt.code).not.toBe(0)
    expect(rExt.json().message).toContain('.pptx or .potx')
    const missing = join(dir, 'missing.pptx')
    const rMissing = await run(
      [
        'create',
        '--type',
        'pptx',
        '--template',
        missing,
        '--spec',
        spec,
        '--out',
        join(dir, 'o2.pptx'),
        '--json',
      ],
      ctx,
    )
    expect(rMissing.code).not.toBe(0)
    expect(rMissing.json().message).toContain('not found')
  })
})
