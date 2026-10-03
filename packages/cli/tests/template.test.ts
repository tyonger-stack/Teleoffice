import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { templateDefaultLayout } from '../src/formats/slide-spec'
import type { TemplateInfo } from '@teleoffice/pipelines/slides'
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
  const templates = track(mkdtempSync(join(tmpdir(), 'teleoffice-templates-')))
  return { cwd: dir, env: { ...process.env, TELEOFFICE_TEMPLATES_DIR: templates } }
}

function layout(
  index: number,
  name: string,
  placeholderTypes: string[],
  decorations: number,
  usedBySamples = 0,
  master = 0,
): TemplateInfo['masters'][number]['layouts'][number] {
  return {
    index,
    master,
    name,
    type: 'custom',
    path: `ppt/slideLayouts/slideLayout${index + 1}.xml`,
    placeholders: placeholderTypes.map((type, idx) => ({
      type,
      idx,
      name: `${type} ${idx}`,
      box: { x: 0, y: 0, cx: 100, cy: 100 },
      px: { x: 0, y: 0, w: 1, h: 1 },
    })),
    decorations,
    usedBySamples,
  }
}

function templateInfo(
  primaryLayouts: TemplateInfo['masters'][number]['layouts'],
  secondaryLayouts: TemplateInfo['masters'][number]['layouts'] = [],
): TemplateInfo {
  const fonts = {
    major: { latin: '', ea: '', cs: '' },
    minor: { latin: '', ea: '', cs: '' },
  }
  return {
    slideSize: { cx: 1, cy: 1, px: { w: 1, h: 1 }, cm: { w: 1, h: 1 } },
    masters: [
      {
        index: 0,
        path: 'ppt/slideMasters/slideMaster1.xml',
        name: 'Primary',
        theme: { name: '', colors: {}, fonts },
        layouts: primaryLayouts,
      },
      {
        index: 1,
        path: 'ppt/slideMasters/slideMaster2.xml',
        name: 'Secondary',
        theme: { name: '', colors: {}, fonts },
        layouts: secondaryLayouts,
      },
    ],
    slides: [],
    defaultMaster: 0,
    duplicateLayoutNames: [],
  }
}

describe('templateDefaultLayout', () => {
  it('chooses the sample-used title layout over complex title and cover layouts', () => {
    const info = templateInfo(
      [
        layout(
          15,
          'Vertical title and text',
          ['title', 'obj', 'obj', 'obj', 'obj', 'body', 'body'],
          6,
        ),
        layout(19, '2_仅标题空内容', ['title'], 3, 2),
        layout(17, '2_标题页', [], 5, 1),
        layout(20, '4_尾页', ['ctrTitle'], 3, 1),
        layout(21, '目录', [], 4, 1),
      ],
      [layout(30, 'Secondary title', ['title'], 20, 50, 1)],
    )

    expect(templateDefaultLayout(info, { path: '/template.pptx' })).toBe(19)
  })

  it('ranks sampled layouts by usage before placeholder count and decoration', () => {
    const info = templateInfo([
      layout(0, 'Frequent but complex', ['title', 'obj', 'body'], 1, 3),
      layout(1, 'Rare and simple', ['title'], 20, 1),
    ])

    expect(templateDefaultLayout(info, { path: '/template.pptx' })).toBe(0)
  })

  it('falls back to decorated simple title layouts, then any title, then the first layout', () => {
    const noSamples = templateInfo([
      layout(0, 'Complex', ['title', 'obj', 'body'], 100),
      layout(1, 'Title only', ['title', 'dt', 'ftr'], 5),
      layout(2, 'Title and one body', ['title', 'obj'], 8),
    ])
    expect(templateDefaultLayout(noSamples, { path: '/template.pptx' })).toBe(2)

    const titleFallback = templateInfo([
      layout(4, 'Untitled', [], 100),
      layout(19, 'Complex title', ['title', 'obj', 'body'], 1),
    ])
    expect(templateDefaultLayout(titleFallback, { path: '/template.pptx' })).toBe(19)

    const noTitle = templateInfo([layout(7, 'First', [], 0), layout(8, 'Second', [], 10)])
    expect(templateDefaultLayout(noTitle, { path: '/template.pptx' })).toBe(7)
  })
})

describe('teleoffice template', () => {
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
      ctx.env.TELEOFFICE_TEMPLATES_DIR,
    )
  })

  it('manages the default and applies it only to compatible deck specs', async () => {
    const dir = ownedTempDir()
    const ctx = templateEnv(dir)
    const template = await makeTemplate(dir)
    const plainSpec = join(dir, 'plain.json')
    writeFileSync(plainSpec, JSON.stringify({ pages: [{ elements: [textEl('Plain page')] }] }))

    const before = await run(
      ['create', '--type', 'pptx', '--spec', plainSpec, '--out', join(dir, 'plain.pptx'), '--json'],
      ctx,
    )
    expect(before.code).toBe(0)
    expect(before.json().detail.template).toBeUndefined()

    const add = await run(['template', 'add', 'Base', template, '--default', '--json'], ctx)
    expect(add.code).toBe(0)
    expect(add.json().detail.isDefault).toBe(true)
    expect((await run(['template', 'default', '--json'], ctx)).json().detail.default).toBe('base')
    const listed = await run(['template', 'list', '--json'], ctx)
    expect(listed.json().detail.default).toBe('base')
    expect(listed.json().detail.templates).toMatchObject([{ name: 'base', isDefault: true }])
    expect((await run(['template', 'list'], ctx)).stdout).toContain('base (default)')

    const automatic = await run(
      [
        'create',
        '--type',
        'pptx',
        '--spec',
        plainSpec,
        '--out',
        join(dir, 'automatic.pptx'),
        '--json',
      ],
      ctx,
    )
    expect(automatic.code).toBe(0)
    expect(automatic.json().summary).toContain('using default template base')
    expect(automatic.json().detail.template).toMatchObject({ name: 'base', source: 'default' })
    expect(automatic.json().detail.template.layoutsUsed).toHaveLength(1)

    const optedOut = await run(
      [
        'create',
        '--type',
        'pptx',
        '--spec',
        plainSpec,
        '--no-template',
        '--out',
        join(dir, 'ordinary.pptx'),
        '--json',
      ],
      ctx,
    )
    expect(optedOut.code).toBe(0)
    expect(optedOut.json().detail.template).toBeUndefined()

    const layout = (await run(['template', 'inspect', 'base', '--json'], ctx)).json().detail
      .masters[0].layouts[0].name as string
    const explicitSpec = join(dir, 'explicit.json')
    writeFileSync(
      explicitSpec,
      JSON.stringify({ pages: [{ layout, elements: [textEl('Explicit layout')] }] }),
    )
    await run(['template', 'add', 'other', template, '--json'], ctx)
    const explicit = await run(
      [
        'create',
        '--type',
        'pptx',
        '--template',
        'other',
        '--spec',
        explicitSpec,
        '--out',
        join(dir, 'explicit.pptx'),
        '--json',
      ],
      ctx,
    )
    expect(explicit.code).toBe(0)
    expect(explicit.json().detail.template).toMatchObject({ name: 'other' })
    expect(explicit.json().detail.template.source).toBeUndefined()

    await run(['template', 'default', 'other', '--json'], ctx)
    const embeddedSpec = join(dir, 'embedded-template.json')
    writeFileSync(
      embeddedSpec,
      JSON.stringify({
        template: 'base',
        pages: [{ layout, elements: [textEl('Spec template')] }],
      }),
    )
    const embedded = await run(
      [
        'create',
        '--type',
        'pptx',
        '--spec',
        embeddedSpec,
        '--out',
        join(dir, 'embedded.pptx'),
        '--json',
      ],
      ctx,
    )
    expect(embedded.code).toBe(0)
    expect(embedded.json().detail.template).toMatchObject({ name: 'base' })

    const staged = join(dir, 'staged')
    mkdirSync(join(staged, 'pages'), { recursive: true })
    const stagedOutline = join(staged, 'outline.json')
    writeFileSync(
      stagedOutline,
      JSON.stringify({
        core_hook: 'A hook with tension and a number: sales grew 40 percent.',
        template: 'base',
        pages: [
          {
            title: 'Template page',
            type: 'content',
            layout,
            brief:
              'A sufficiently detailed page brief with the real data and names for its content.',
            image_queries: [],
          },
        ],
      }),
    )
    writeFileSync(
      join(staged, 'pages', '01.json'),
      JSON.stringify({
        title: 'Template page',
        type: 'content',
        layout,
        elements: [textEl('Outline template')],
      }),
    )
    const outlined = await run(
      [
        'create',
        '--type',
        'pptx',
        '--spec',
        join(staged, 'pages'),
        '--outline',
        stagedOutline,
        '--out',
        join(dir, 'outlined.pptx'),
        '--json',
      ],
      ctx,
    )
    expect(outlined.code, JSON.stringify(outlined.json())).toBe(0)
    expect(outlined.json().detail.template).toMatchObject({ name: 'base' })
    expect(outlined.json().detail.template.source).toBeUndefined()

    const conflict = join(dir, 'conflict.json')
    writeFileSync(
      conflict,
      JSON.stringify({ pages: [{ layout: 'cover_typography_hero', elements: [textEl('Plain')] }] }),
    )
    const skipped = await run(
      [
        'create',
        '--type',
        'pptx',
        '--spec',
        conflict,
        '--out',
        join(dir, 'conflict.pptx'),
        '--json',
      ],
      ctx,
    )
    expect(skipped.code).toBe(0)
    expect(skipped.json().summary).toContain('skipped default template other')
    expect(skipped.json().detail.template).toBeUndefined()
    expect(skipped.json().detail.defaultTemplateSkipped.name).toBe('other')

    expect((await run(['template', 'default', 'other', '--json'], ctx)).code).toBe(0)
    expect(
      (await run(['template', 'default', '--clear', '--json'], ctx)).json().detail.previous,
    ).toBe('other')
    expect((await run(['template', 'default', 'bas', '--json'], ctx)).json().message).toContain(
      'did you mean',
    )
  })

  it('uses the default for compatible outline and page checks, with --no-template opt-out', async () => {
    const dir = ownedTempDir()
    const ctx = templateEnv(dir)
    const template = await makeTemplate(dir)
    await run(['template', 'add', 'base', template, '--default', '--json'], ctx)
    const outline = join(dir, 'outline.json')
    writeFileSync(
      outline,
      JSON.stringify({
        core_hook: 'A hook with tension and a number: sales grew 40 percent.',
        pages: [
          {
            title: 'A plain page',
            type: 'content',
            brief:
              'A sufficiently detailed page brief with the real data and names for its content.',
            image_queries: [],
          },
        ],
      }),
    )
    const checkedOutline = await run(['slides', 'check', outline, '--json'], ctx)
    expect(checkedOutline.code, JSON.stringify(checkedOutline.json())).toBe(0)
    expect(checkedOutline.json().detail.template).toMatchObject({ name: 'base', source: 'default' })
    expect(checkedOutline.json().detail.template.defaultLayout).toBeTruthy()

    mkdirSync(join(dir, 'pages'))
    const page = join(dir, 'pages', '01.json')
    writeFileSync(page, JSON.stringify({ elements: [textEl('A page without a named layout')] }))
    const checkedPage = await run(['slides', 'check', page, '--json'], ctx)
    expect(checkedPage.code, JSON.stringify(checkedPage.json())).toBe(0)
    expect(checkedPage.json().detail.template).toMatchObject({ name: 'base', source: 'default' })
    const ordinary = await run(['slides', 'check', outline, '--no-template', '--json'], ctx)
    expect(ordinary.code).toBe(1)
    expect(JSON.stringify(ordinary.json().detail.issues)).toContain('layout')
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
    const templatesDir = ctx.env.TELEOFFICE_TEMPLATES_DIR as string
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

    const staged = join(dir, 'staged')
    mkdirSync(join(staged, 'pages'), { recursive: true })
    writeFileSync(
      join(staged, 'outline.json'),
      JSON.stringify({
        template: 'with-start',
        core_hook: 'A cover starts the story with a clear point and a concrete fact.',
        pages: [
          {
            title: 'Cover',
            type: 'cover',
            brief:
              'A cover that states the central idea and gives the audience a reason to listen.',
            image_queries: [],
          },
        ],
      }),
    )
    writeFileSync(
      join(staged, 'pages', '01.json'),
      JSON.stringify({ title: 'Cover', type: 'cover', elements: [textEl('Cover content')] }),
    )
    const cover = await run(
      [
        'create',
        '--type',
        'pptx',
        '--spec',
        join(staged, 'pages'),
        '--out',
        join(dir, 'cover.pptx'),
        '--json',
      ],
      ctx,
    )
    expect(cover.code, JSON.stringify(cover.json())).toBe(0)
    expect(cover.json().detail.template.layoutsUsed[0].layoutName).toBe(layout)

    const ordinarySpec = join(dir, 'ordinary-no-layout.json')
    writeFileSync(ordinarySpec, JSON.stringify({ pages: [{ elements: [textEl('Ordinary')] }] }))
    const ordinary = await run(
      [
        'create',
        '--type',
        'pptx',
        '--template',
        'with-start',
        '--spec',
        ordinarySpec,
        '--out',
        join(dir, 'ordinary-no-layout.pptx'),
        '--json',
      ],
      ctx,
    )
    expect(ordinary.code).toBe(1)
    expect(ordinary.json().message).toContain('"layout" is required')
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
