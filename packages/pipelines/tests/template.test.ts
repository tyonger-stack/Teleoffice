import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildTemplateDeck, inspectTemplate, parseTemplateDeckSpec } from '../src/slides/template'
import { toEngineParagraphs } from '../src/slides/page-spec'
import { parseOutline } from '../src/slides/outline'
import {
  PackageArchive,
  getSlideNotes,
  openPptx,
  parseTheme,
  resolveFontRef,
} from '@teleoffice/pptx-engine'
import { makeTwoMasterTemplate } from './template-fixture'

const PNG_1PX = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
)

const deps = {
  fetchImage: async () => ({ bytes: PNG_1PX, ext: 'png' }),
  imageDims: () => ({ width: 1, height: 1 }),
}

describe('inspectTemplate on a synthetic two-master template', () => {
  it('reads size, master order, sldLayoutIdLst layout order and samples', async () => {
    const info = await inspectTemplate(await makeTwoMasterTemplate())
    expect(info.slideSize.px).toEqual({ w: 1280, h: 720 })
    expect(info.slideSize.cm).toEqual({ w: 33.87, h: 19.05 })
    expect(info.masters.map((m) => m.name)).toEqual(['MasterOne', 'MasterTwo'])
    // flat order follows each master sldLayoutIdLst, not the rels order
    expect(info.masters.flatMap((m) => m.layouts.map((l) => l.name))).toEqual([
      'Blank',
      'TitleAndContent',
      'TitleOnly',
      'TitleAndContent',
      'Cover',
    ])
    expect(info.masters.flatMap((m) => m.layouts.map((l) => l.master))).toEqual([0, 0, 0, 1, 1])
    expect(info.slides.map((s) => s.layout)).toEqual([0, 3, 4])
    expect(info.slides.map((s) => s.layoutName)).toEqual(['Blank', 'TitleAndContent', 'Cover'])
    // two of three samples live on master 1
    expect(info.defaultMaster).toBe(1)
    expect(info.duplicateLayoutNames).toEqual(['TitleAndContent'])
  })

  it('resolves theme colors and fonts, inherited boxes and decorations', async () => {
    const bytes = await makeTwoMasterTemplate()
    const info = await inspectTemplate(bytes)
    const office = info.masters[0]!.theme
    expect(office.name).toBe('Office')
    expect(office.colors.accent1).toBe('#C43E1C')
    expect(office.colors.dk1).toBe('#000000')
    expect(office.colors.lt1).toBe('#FFFFFF')
    expect(office.fonts.major.latin).toBe('Calibri Light')
    // Blank theme (#1941): <a:ea> is empty. East Asian text resolves per script
    // (Hans/Hant/Jpan/Hang) instead of a Windows-only Microsoft YaHei pin.
    expect(office.fonts.major.ea).toBe('')
    expect(office.fonts.minor.ea).toBe('')
    const themeXml = (await openPptx(bytes)).archive.readText(office.path ?? 'ppt/theme/theme1.xml')
    const theme = parseTheme(themeXml ?? '')
    expect(theme.minorEaFont).toBeUndefined()
    expect(theme.majorEaFont).toBeUndefined()
    expect(resolveFontRef('+mn-ea', theme, 'sc')).toBe('等线')
    expect(resolveFontRef('+mn-ea', theme, 'tc')).toBe('新細明體')
    expect(resolveFontRef('+mn-ea', theme, 'ja')).toBe('ＭＳ Ｐゴシック')
    expect(resolveFontRef('+mn-ea', theme, 'ko')).toBe('맑은 고딕')
    expect(resolveFontRef('+mj-ea', theme, 'sc')).toBe('等线')
    expect(resolveFontRef('+mj-ea', theme, 'ja')).toBe('ＭＳ ゴシック')
    expect(info.masters[1]!.theme.colors.accent1).toBe('#C00000')
    const byName = new Map(info.masters.flatMap((m) => m.layouts).map((l) => [l.index, l]))
    // layout 1 has its own title box; layout 2 inherits the master title box
    expect(byName.get(1)!.placeholders[0]!.inherited).toBeUndefined()
    expect(byName.get(1)!.placeholders[0]!.box).toMatchObject({ x: 500000, y: 500000 })
    const inherited = byName.get(2)!.placeholders[0]!
    expect(inherited.inherited).toBe(true)
    expect(inherited.box).toMatchObject({ x: 914400, y: 685800, cx: 8229600 })
    expect(inherited.px).toMatchObject({ x: 96, y: 72 })
    expect(byName.get(1)!.decorations).toBe(1)
    expect(byName.get(4)!.decorations).toBe(2)
    expect(byName.get(4)!.placeholders).toEqual([])
  })
})

describe('parseTemplateDeckSpec', () => {
  it('resolves names, indexes, scopes and masters; errors list the names', async () => {
    const info = await inspectTemplate(await makeTwoMasterTemplate())
    const ok = parseTemplateDeckSpec(
      {
        master: 1,
        pages: [
          { layout: 'TitleAndContent', title: 'Hello', body: ['a', ['b']] },
          { layout: 4, title: 'Cover page' },
        ],
      },
      info,
    )
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.spec.master).toBe(1)
    // preferred master 1 wins for the duplicated name
    expect(ok.spec.pages[0]!.layoutIndex).toBe(3)
    expect(ok.spec.pages[0]!.master).toBe(1)
    expect(ok.spec.pages[1]!.layoutIndex).toBe(4)
    // page master beats the deck master
    const scoped = parseTemplateDeckSpec(
      { pages: [{ layout: '0:TitleAndContent', master: 0, title: 'M0' }] },
      info,
      { master: 1 },
    )
    expect(scoped.ok).toBe(true)
    if (!scoped.ok) return
    expect(scoped.spec.pages[0]!.layoutIndex).toBe(1)
    // unknown names error with the preferred master names
    const bad = parseTemplateDeckSpec({ pages: [{ layout: 'Nope' }] }, info)
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error).toContain('unknown layout "Nope"')
    expect(bad.error).toContain('TitleAndContent')
    const badIdx = parseTemplateDeckSpec({ pages: [{ layout: 9 }] }, info)
    expect(badIdx.ok).toBe(false)
    if (badIdx.ok) return
    expect(badIdx.error).toContain('unknown layout index 9')
  })

  it('rejects out-of-range numeric layout strings with a range error', async () => {
    const info = await inspectTemplate(await makeTwoMasterTemplate())
    const badStr = parseTemplateDeckSpec({ pages: [{ layout: '999' }] }, info)
    expect(badStr.ok).toBe(false)
    if (badStr.ok) return
    expect(badStr.error).toContain('unknown layout index 999')
    expect(badStr.error).toContain('0-4')
    const okStr = parseTemplateDeckSpec({ pages: [{ layout: '1', elements: [] }] }, info)
    expect(okStr.ok).toBe(true)
    if (!okStr.ok) return
    expect(okStr.spec.pages[0]!.layoutIndex).toBe(1)
  })

  it('warns when the layout lacks the title slot and accepts blank pages', async () => {
    const info = await inspectTemplate(await makeTwoMasterTemplate())
    const r = parseTemplateDeckSpec(
      { pages: [{ layout: 'Cover', title: 'Only an echo', elements: [] }] },
      info,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.pages[0]!.fills).toEqual([])
    expect(r.issues[0]!.warnings!.join(' ')).toContain('has no title placeholder')
  })
})

describe('buildTemplateDeck', () => {
  it('fills placeholders with inheriting markup, drops samples, writes notes', async () => {
    const bytes = await makeTwoMasterTemplate()
    const info = await inspectTemplate(bytes)
    const parsed = parseTemplateDeckSpec(
      {
        title: 'Deck title',
        pages: [
          {
            layout: 'TitleAndContent',
            master: 0,
            title: 'Page one',
            body: ['First', { text: 'Second', level: 1 }],
            notes: 'Say hello',
          },
          {
            layout: 'Cover',
            elements: [
              {
                type: 'text',
                x: 640,
                y: 600,
                w: 640,
                h: 100,
                paragraphs: [{ runs: [{ text: 'Cover note' }] }],
              },
            ],
          },
        ],
      },
      info,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const built = await buildTemplateDeck(bytes, parsed.spec, deps)
    expect(built.layoutsUsed).toEqual([
      { page: 0, layout: 1, layoutName: 'TitleAndContent', master: 0 },
      { page: 1, layout: 4, layoutName: 'Cover', master: 1 },
    ])
    const opened = await openPptx(built.bytes)
    expect(opened.deck.slides).toHaveLength(2)
    const archive = await PackageArchive.open(built.bytes)
    // sample slides are gone and the new parts are renumbered from slide1.xml
    expect(
      [...archive.entries.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort(),
    ).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml'])
    expect(archive.readText('[Content_Types].xml')).not.toContain('slide4.xml')
    const slide1 = archive.readText('ppt/slides/slide1.xml') ?? ''
    expect(slide1).toContain('<p:ph type="title" idx="0"/>')
    expect(slide1).toContain('<p:spPr/>')
    expect(slide1).toContain('Page one')
    expect(slide1).toContain('lvl="1"')
    expect(slide1).not.toContain('marL')
    const rels1 = archive.readText('ppt/slides/_rels/slide1.xml.rels') ?? ''
    expect(rels1).toContain('slideLayout2.xml')
    expect(getSlideNotes(archive, 'ppt/slides/slide1.xml')).toBe('Say hello')
    const slide2 = archive.readText('ppt/slides/slide2.xml') ?? ''
    expect(slide2).toContain('Cover note')
    expect(slide2).toContain('x="6096000"')
    const core = archive.readText('docProps/core.xml') ?? ''
    expect(core).toContain('<dc:creator/>')
    expect(core).toContain('<cp:revision>1</cp:revision>')
    expect(core).toContain('<dc:title>Deck title</dc:title>')
    const app = archive.readText('docProps/app.xml') ?? ''
    expect(app).toContain('<Slides>2</Slides>')
    expect(app).not.toContain('TitlesOfParts')
    expect(app).not.toContain('HeadingPairs')
    expect(archive.readText('ppt/commentAuthors.xml')).toContain('<p:cmAuthorLst')
    expect(archive.readText('ppt/commentAuthors.xml')).not.toContain('cmAuthor id')
  })

  it('keeps samples with keepSlides and applies the font override', async () => {
    const bytes = await makeTwoMasterTemplate()
    const info = await inspectTemplate(bytes)
    const parsed = parseTemplateDeckSpec(
      {
        keepSlides: true,
        font: 'Microsoft YaHei',
        pages: [{ layout: 'TitleOnly', title: 'Kept' }],
      },
      info,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const built = await buildTemplateDeck(bytes, parsed.spec, deps)
    const opened = await openPptx(built.bytes)
    expect(opened.deck.slides).toHaveLength(4)
    const archive = await PackageArchive.open(built.bytes)
    const theme = archive.readText('ppt/theme/theme1.xml') ?? ''
    expect(theme).toContain('<a:latin typeface="Microsoft YaHei"/>')
    expect(theme).toContain('<a:ea typeface="Microsoft YaHei"/>')
    const slide = archive.readText('ppt/slides/slide4.xml') ?? ''
    expect(slide).toContain('<a:latin typeface="Microsoft YaHei"/>')
    expect(slide).toContain('<a:cs typeface="Microsoft YaHei"/>')
  })

  it('applies the font override to the Chinese per-script theme fonts too', async () => {
    const bytes = await makeTwoMasterTemplate({ scriptFonts: true, explicitFonts: true })
    const before = (await PackageArchive.open(bytes)).readText('ppt/theme/theme2.xml') ?? ''
    expect(before).toContain('<a:font script="Hans" typeface="宋体"/>')
    const info = await inspectTemplate(bytes)
    const parsed = parseTemplateDeckSpec(
      { font: 'Microsoft YaHei', pages: [{ layout: 'TitleAndContent', title: 'Fonts' }] },
      info,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const built = await buildTemplateDeck(bytes, parsed.spec, deps)
    const archive = await PackageArchive.open(built.bytes)
    const theme = archive.readText('ppt/theme/theme2.xml') ?? ''
    for (const kind of ['major', 'minor']) {
      const scheme =
        new RegExp('<a:' + kind + 'Font>[\\s\\S]*?</a:' + kind + 'Font>').exec(theme)?.[0] ?? ''
      expect(scheme).toContain('<a:latin typeface="Microsoft YaHei"/>')
      expect(scheme).toContain('<a:ea typeface="Microsoft YaHei"/>')
      expect(scheme).toContain('<a:font script="Hans" typeface="Microsoft YaHei"/>')
      expect(scheme).toContain('<a:font script="Hant" typeface="Microsoft YaHei"/>')
      // other scripts are left to the template
      expect(scheme).toContain('<a:font script="Jpan" typeface="Yu Gothic"/>')
    }
    expect(theme).not.toContain('宋体')
    expect(theme).not.toContain('新細明體')
    expect(theme).not.toContain('SimSun')
    // explicit fonts in layout runs follow too; theme refs and symbol fonts stay
    const layout = archive.readText('ppt/slideLayouts/slideLayout5.xml') ?? ''
    expect(layout).toContain(
      '<a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="+mn-cs"/><a:sym typeface="Wingdings"/>',
    )
    for (const path of archive.entries.keys()) {
      if (!path.endsWith('.xml')) continue
      const xml = archive.readText(path) ?? ''
      expect(xml, path).not.toMatch(/宋体|SimSun|新細明體|Calibri"/)
    }
  })

  it('fills picture placeholders and reports image failures per page', async () => {
    const bytes = await makeTwoMasterTemplate()
    const info = await inspectTemplate(bytes)
    const parsed = parseTemplateDeckSpec(
      {
        pages: [
          {
            layout: 'TitleAndContent',
            master: 1,
            title: 'Pics',
            placeholders: [{ type: 'pic', image: 'chart.png', fit: 'contain' }],
          },
        ],
      },
      info,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const built = await buildTemplateDeck(bytes, parsed.spec, deps)
    const archive = await PackageArchive.open(built.bytes)
    const slide = archive.readText('ppt/slides/slide1.xml') ?? ''
    expect(slide).toContain('<p:pic>')
    expect(slide).toContain('<p:ph type="pic" idx="2"/>')
    expect(slide).not.toContain('srcRect')
    const failing = await buildTemplateDeck(bytes, parsed.spec, { fetchImage: async () => null })
    expect(failing.imageFailures).toEqual([{ page: 0, url: 'chart.png' }])
  })

  it('emits unfilled placeholders as empty inheriting shapes', async () => {
    const bytes = await makeTwoMasterTemplate()
    const info = await inspectTemplate(bytes)
    const parsed = parseTemplateDeckSpec(
      {
        pages: [
          {
            layout: 'TitleAndContent',
            master: 1,
            title: 'Only title',
            emptyPlaceholders: true,
          },
        ],
      },
      info,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.spec.pages[0]!.emptyPlaceholders).toBe(true)
    const built = await buildTemplateDeck(bytes, parsed.spec, deps)
    const archive = await PackageArchive.open(built.bytes)
    const slide = archive.readText('ppt/slides/slide1.xml') ?? ''
    expect(slide).toContain('Only title')
    // Unfilled body placeholder appears as an empty inheriting shape.
    expect(slide).toContain('<p:ph type="body" idx="1"/>')
    expect(slide).toContain('<p:spPr/>')
    expect(slide).toContain('<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>')
    // Pic placeholders stay an empty sp with the pic ph, never a pic element.
    expect(slide).toContain('<p:ph type="pic" idx="2"/>')
    expect(slide).not.toContain('<p:pic>')
    // Without the flag the unfilled placeholders stay absent.
    const plain = parseTemplateDeckSpec(
      {
        pages: [{ layout: 'TitleAndContent', master: 1, title: 'Only title' }],
      },
      info,
    )
    expect(plain.ok).toBe(true)
    if (!plain.ok) return
    expect(plain.spec.pages[0]!.emptyPlaceholders).toBeUndefined()
    const builtPlain = await buildTemplateDeck(bytes, plain.spec, deps)
    const archivePlain = await PackageArchive.open(builtPlain.bytes)
    const slidePlain = archivePlain.readText('ppt/slides/slide1.xml') ?? ''
    expect(slidePlain).not.toContain('type="body"')
    expect(slidePlain).not.toContain('type="pic"')
  })
})

describe('page-spec extensions', () => {
  it('maps bullet glyph, color, size, font and level', () => {
    const one = toEngineParagraphs([
      {
        runs: [{ text: 'Hi' }],
        bullet: 'X',
        bulletColor: '#C00000',
        bulletSizePct: 80,
        bulletFont: 'Wingdings',
        level: 2,
      },
    ])
    const p = one[0]!
    expect(p.bullet).toMatchObject({
      type: 'char',
      char: 'X',
      color: '#C00000',
      sizePct: 80,
      font: 'Wingdings',
    })
    expect(p.marL).toBe(3 * 228600)
    expect(p.indent).toBe(-228600)
    expect(p.level).toBe(2)
    const two = toEngineParagraphs([{ runs: [{ text: 'Hi' }], bullet: true }])
    expect(two[0]!.bullet).toMatchObject({ type: 'char', char: '•' })
    expect(two[0]!.marL).toBe(228600)
    expect(two[0]!.level).toBeUndefined()
  })

  it('writes the bullet glyph and level into slide XML and shrinks contain images', async () => {
    const pageSpec = await import('../src/slides/page-spec')
    const built = await pageSpec.buildPagePptx(
      {
        elements: [
          {
            type: 'text',
            x: 80,
            y: 60,
            w: 800,
            h: 90,
            paragraphs: [{ runs: [{ text: 'Point' }], bullet: 'X', level: 1 }],
          },
          { type: 'image', url: 'pic.png', x: 0, y: 0, w: 200, h: 100, fit: 'contain' },
        ],
      },
      {
        fetchImage: async () => ({ bytes: PNG_1PX, ext: 'png' }),
        imageDims: () => ({ width: 50, height: 100 }),
      },
    )
    const archive = await PackageArchive.open(built.bytes)
    const slide = archive.readText('ppt/slides/slide1.xml') ?? ''
    expect(slide).toContain('buChar char="X"')
    expect(slide).toContain('lvl="1"')
    const opened = await openPptx(built.bytes)
    const pic = opened.deck.slides[0]!.elements.find((e) => e.type === 'picture')
    expect(pic).toBeDefined()
    expect(pic!.transform.offset).toMatchObject({ x: 75 * 9525, cx: 50 * 9525, cy: 100 * 9525 })
  })
})

describe('parseOutline in template mode', () => {
  const outlineOf = (layouts: string[]) =>
    JSON.stringify({
      core_hook: 'Margins fell while volume grew',
      pages: layouts.map((layout, i) => ({
        title: 'Page ' + (i + 1),
        type: 'content',
        layout,
        brief: 'Main title plus three supporting facts with the real figures for this page.',
        image_queries: [],
      })),
    })
  it('accepts template layouts and skips the variety rules', () => {
    const r = parseOutline(
      outlineOf(['TitleAndContent', 'TitleAndContent', 'Cover', 'TitleAndContent']),
      {
        templateLayouts: ['TitleAndContent', 'Cover'],
      },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.issues.filter((x) => x.level === 'error')).toEqual([])
  })
  it('rejects unknown layouts with the template names', () => {
    const r = parseOutline(outlineOf(['Nope']), { templateLayouts: ['TitleAndContent', 'Cover'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(
      r.issues.some(
        (x) => x.level === 'error' && x.message.includes('not a layout of the template'),
      ),
    ).toBe(true)
  })
  it('range-checks numeric layouts against the flat count', () => {
    const ok = parseOutline(outlineOf(['1']), {
      templateLayouts: ['TitleAndContent', 'Cover'],
      templateLayoutCount: 5,
    })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.issues.filter((x) => x.level === 'error')).toEqual([])
    const bad = parseOutline(outlineOf(['999']), {
      templateLayouts: ['TitleAndContent', 'Cover'],
      templateLayoutCount: 5,
    })
    expect(bad.ok).toBe(true)
    if (!bad.ok) return
    expect(bad.issues.some((x) => x.level === 'error' && x.message.includes('out of range'))).toBe(
      true,
    )
  })
  it('accepts any numeric layout without a count for compatibility', () => {
    const r = parseOutline(outlineOf(['999']), { templateLayouts: ['TitleAndContent', 'Cover'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.issues.filter((x) => x.level === 'error')).toEqual([])
  })
})

describe('layout names that read as numbers', () => {
  it('resolves a layout named "1" by name and other digit strings as flat indexes', async () => {
    const bytes = await makeTwoMasterTemplate({ coverName: '1' })
    const info = await inspectTemplate(bytes)
    expect(info.masters.flatMap((m) => m.layouts.map((l) => l.name))).toEqual([
      'Blank',
      'TitleAndContent',
      'TitleOnly',
      'TitleAndContent',
      '1',
    ])
    const parsed = parseTemplateDeckSpec(
      {
        pages: [
          { layout: '1' },
          { layout: '2', title: 'By index' },
          { layout: 1, title: 'Number' },
        ],
      },
      info,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    // "1" is the layout named "1" (flat index 4); "2" has no such name, so it is index 2;
    // a JSON number stays an index
    expect(parsed.spec.pages.map((p) => [p.layoutIndex, p.layoutName])).toEqual([
      [4, '1'],
      [2, 'TitleOnly'],
      [1, 'TitleAndContent'],
    ])
    const built = await buildTemplateDeck(bytes, parsed.spec, deps)
    expect((await openPptx(built.bytes)).deck.slides).toHaveLength(3)
    // without such a name, "1" is still flat index 1
    const plain = parseTemplateDeckSpec(
      { pages: [{ layout: '1', title: 'x' }] },
      await inspectTemplate(await makeTwoMasterTemplate()),
    )
    expect(plain.ok && plain.spec.pages[0]!.layoutIndex).toBe(1)
  })

  it('accepts a digit layout name in outlines even past the flat count', () => {
    const outline = JSON.stringify({
      core_hook: 'Margins fell while volume grew',
      pages: [
        {
          title: 'Page 1',
          type: 'content',
          layout: '7',
          brief: 'Main title plus three supporting facts with the real figures for this page.',
          image_queries: [],
        },
      ],
    })
    const named = parseOutline(outline, {
      templateLayouts: ['TitleAndContent', '7'],
      templateLayoutCount: 5,
    })
    expect(named.ok).toBe(true)
    if (!named.ok) return
    expect(named.issues.filter((x) => x.level === 'error')).toEqual([])
    const unnamed = parseOutline(outline, {
      templateLayouts: ['TitleAndContent'],
      templateLayoutCount: 5,
    })
    expect(unnamed.ok).toBe(true)
    if (!unnamed.ok) return
    expect(
      unnamed.issues.some((x) => x.level === 'error' && x.message.includes('out of range')),
    ).toBe(true)
  })
})

describe('company template', () => {
  const templatePath = process.env.TELEOFFICE_COMPANY_TEMPLATE
  it.skipIf(!templatePath)('inspects the deck at TELEOFFICE_COMPANY_TEMPLATE', async () => {
    if (!templatePath) {
      throw new Error('TELEOFFICE_COMPANY_TEMPLATE is not set')
    }
    if (!existsSync(templatePath)) {
      throw new Error(
        `TELEOFFICE_COMPANY_TEMPLATE is set but the file does not exist: ${templatePath}`,
      )
    }
    const info = await inspectTemplate(new Uint8Array(readFileSync(templatePath)))
    expect(info.masters).toHaveLength(2)
    expect(info.masters.flatMap((m) => m.layouts)).toHaveLength(22)
    expect(info.defaultMaster).toBe(0)
    expect(info.slideSize.px).toEqual({ w: 1280, h: 720 })
    expect(info.duplicateLayoutNames.length).toBeGreaterThan(0)
  })
})
describe('empty template deck', () => {
  it('appends the first slide past an empty sldIdLst', async () => {
    const full = await makeTwoMasterTemplate()
    const opened = await openPptx(full)
    const pres = opened.archive.readText('ppt/presentation.xml') ?? ''
    opened.archive.entries.set(
      'ppt/presentation.xml',
      Buffer.from(pres.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, ''), 'utf8'),
    )
    const engine = await import('@teleoffice/pptx-engine')
    const empty = await engine.savePptx(opened)
    const info = await inspectTemplate(empty)
    expect(info.slides).toEqual([])
    expect(info.defaultMaster).toBe(0)
    const parsed = parseTemplateDeckSpec({ pages: [{ layout: 'Cover' }] }, info)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const built = await buildTemplateDeck(empty, parsed.spec, deps)
    expect((await openPptx(built.bytes)).deck.slides).toHaveLength(1)
  })
})
