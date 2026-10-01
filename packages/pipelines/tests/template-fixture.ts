import { createBlankPptx, insertSlideWithLayout, openPptx, savePptx } from '@teleoffice/pptx-engine'

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const RELS_HEAD =
  XMLDECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
const LAYOUT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout'
const MASTER_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster'
const THEME_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme'

function spTree(shapes: string): string {
  return (
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    shapes +
    '</p:spTree>'
  )
}

function phShape(
  id: number,
  name: string,
  type: string,
  idx: number,
  box?: { x: number; y: number; cx: number; cy: number },
): string {
  const xfrm = box
    ? '<a:xfrm><a:off x="' +
      box.x +
      '" y="' +
      box.y +
      '"/><a:ext cx="' +
      box.cx +
      '" cy="' +
      box.cy +
      '"/></a:xfrm>'
    : ''
  return (
    '<p:sp><p:nvSpPr><p:cNvPr id="' +
    id +
    '" name="' +
    name +
    '"/>' +
    '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="' +
    type +
    '" idx="' +
    idx +
    '"/></p:nvPr></p:nvSpPr>' +
    '<p:spPr>' +
    xfrm +
    '</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>'
  )
}

function decoration(id: number, name: string): string {
  return (
    '<p:sp><p:nvSpPr><p:cNvPr id="' +
    id +
    '" name="' +
    name +
    '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:sp>'
  )
}

function picShape(id: number, name: string, idx: number): string {
  return (
    '<p:pic><p:nvPicPr><p:cNvPr id="' +
    id +
    '" name="' +
    name +
    '"/><p:cNvPicPr/><p:nvPr><p:ph type="pic" idx="' +
    idx +
    '"/></p:nvPr></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="rId9"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    '<p:spPr><a:xfrm><a:off x="914400" y="5486400"/><a:ext cx="3657600" cy="1371600"/></a:xfrm></p:spPr></p:pic>'
  )
}

function layoutXml(name: string, type: string, shapes: string): string {
  return (
    XMLDECL +
    '<p:sldLayout xmlns:a="' +
    NS_A +
    '" xmlns:r="' +
    NS_R +
    '" xmlns:p="' +
    NS_P +
    '" type="' +
    type +
    '">' +
    '<p:cSld name="' +
    name +
    '">' +
    spTree(shapes) +
    '</p:cSld>' +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
  )
}

function masterXml(name: string, shapes: string, layoutIds: string): string {
  return (
    XMLDECL +
    '<p:sldMaster xmlns:a="' +
    NS_A +
    '" xmlns:r="' +
    NS_R +
    '" xmlns:p="' +
    NS_P +
    '">' +
    '<p:cSld name="' +
    name +
    '">' +
    spTree(shapes) +
    '</p:cSld>' +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst>' +
    layoutIds +
    '</p:sldLayoutIdLst>' +
    '<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>' +
    '</p:sldMaster>'
  )
}

function themeXml(name: string, accent1: string, latin: string, ea: string): string {
  return (
    XMLDECL +
    '<a:theme xmlns:a="' +
    NS_A +
    '" name="' +
    name +
    '">' +
    '<a:themeElements>' +
    '<a:clrScheme name="' +
    name +
    '">' +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="44546A"/></a:dk2>' +
    '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="' +
    accent1 +
    '"/></a:accent1>' +
    '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>' +
    '<a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="4472C4"/></a:accent5>' +
    '<a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
    '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
    '</a:clrScheme>' +
    '<a:fontScheme name="' +
    name +
    '">' +
    '<a:majorFont><a:latin typeface="' +
    latin +
    '"/><a:ea typeface="' +
    ea +
    '"/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="' +
    latin +
    '"/><a:ea typeface="' +
    ea +
    '"/><a:cs typeface=""/></a:minorFont>' +
    '</a:fontScheme>' +
    '</a:themeElements></a:theme>'
  )
}

// A synthetic two-master template for inspect/build tests:
// master 0 (MasterOne, Office theme) layouts Blank(0, inherited empty), TitleAndContent(1), TitleOnly(2, inherits title box);
// master 1 (MasterTwo, Custom theme) layouts TitleAndContent(3, same name), Cover(4, no placeholders).
// Sample slides: slide1 on Blank, plus slide2 on layout 3 and slide3 on layout 4.
export async function makeTwoMasterTemplate(): Promise<Uint8Array> {
  const opened = await openPptx(await createBlankPptx())
  const archive = opened.archive
  const set = (path: string, xml: string): void => {
    archive.entries.set(path, Buffer.from(xml, 'utf8'))
  }
  const TITLE_BOX = { x: 914400, y: 685800, cx: 8229600, cy: 1143000 }
  const BODY_BOX = { x: 914400, y: 2286000, cx: 8229600, cy: 3200400 }

  set(
    'ppt/slideMasters/slideMaster1.xml',
    masterXml(
      'MasterOne',
      phShape(2, 'Title 1', 'title', 0, TITLE_BOX) + phShape(3, 'Body 2', 'body', 1, BODY_BOX),
      '<p:sldLayoutId id="11" r:id="rId1"/><p:sldLayoutId id="12" r:id="rId3"/><p:sldLayoutId id="13" r:id="rId4"/>',
    ),
  )
  // rels order differs from sldLayoutIdLst order on purpose (layout3 first)
  set(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    RELS_HEAD +
      '<Relationship Id="rId4" Type="' +
      LAYOUT_REL +
      '" Target="../slideLayouts/slideLayout3.xml"/>' +
      '<Relationship Id="rId1" Type="' +
      LAYOUT_REL +
      '" Target="../slideLayouts/slideLayout1.xml"/>' +
      '<Relationship Id="rId3" Type="' +
      LAYOUT_REL +
      '" Target="../slideLayouts/slideLayout2.xml"/>' +
      '<Relationship Id="rId2" Type="' +
      THEME_REL +
      '" Target="../theme/theme1.xml"/>' +
      '</Relationships>',
  )
  set(
    'ppt/slideLayouts/slideLayout2.xml',
    layoutXml(
      'TitleAndContent',
      'titleAndContent',
      phShape(2, 'Title 1', 'title', 0, { x: 500000, y: 500000, cx: 8000000, cy: 1000000 }) +
        phShape(3, 'Body 2', 'body', 1, BODY_BOX) +
        decoration(9, 'Ribbon'),
    ),
  )
  set(
    'ppt/slideLayouts/_rels/slideLayout2.xml.rels',
    RELS_HEAD +
      '<Relationship Id="rId1" Type="' +
      MASTER_REL +
      '" Target="../slideMasters/slideMaster1.xml"/>' +
      '</Relationships>',
  )
  // title placeholder without geometry: the box comes from the master
  set(
    'ppt/slideLayouts/slideLayout3.xml',
    layoutXml('TitleOnly', 'titleOnly', phShape(2, 'Title 1', 'title', 0)),
  )
  set(
    'ppt/slideLayouts/_rels/slideLayout3.xml.rels',
    RELS_HEAD +
      '<Relationship Id="rId1" Type="' +
      MASTER_REL +
      '" Target="../slideMasters/slideMaster1.xml"/>' +
      '</Relationships>',
  )
  set('ppt/theme/theme2.xml', themeXml('Custom', 'C00000', 'Arial', 'SimSun'))
  set(
    'ppt/slideMasters/slideMaster2.xml',
    masterXml(
      'MasterTwo',
      '',
      '<p:sldLayoutId id="21" r:id="rId1"/><p:sldLayoutId id="22" r:id="rId2"/>',
    ),
  )
  set(
    'ppt/slideMasters/_rels/slideMaster2.xml.rels',
    RELS_HEAD +
      '<Relationship Id="rId1" Type="' +
      LAYOUT_REL +
      '" Target="../slideLayouts/slideLayout4.xml"/>' +
      '<Relationship Id="rId2" Type="' +
      LAYOUT_REL +
      '" Target="../slideLayouts/slideLayout5.xml"/>' +
      '<Relationship Id="rId3" Type="' +
      THEME_REL +
      '" Target="../theme/theme2.xml"/>' +
      '</Relationships>',
  )
  set(
    'ppt/slideLayouts/slideLayout4.xml',
    layoutXml(
      'TitleAndContent',
      'titleAndContent',
      phShape(2, 'Title 1', 'title', 0, TITLE_BOX) +
        phShape(3, 'Body 2', 'body', 1, BODY_BOX) +
        picShape(4, 'Picture 3', 2),
    ),
  )
  set(
    'ppt/slideLayouts/_rels/slideLayout4.xml.rels',
    RELS_HEAD +
      '<Relationship Id="rId1" Type="' +
      MASTER_REL +
      '" Target="../slideMasters/slideMaster2.xml"/>' +
      '</Relationships>',
  )
  set(
    'ppt/slideLayouts/slideLayout5.xml',
    layoutXml('Cover', 'custom', decoration(9, 'Logo') + decoration(10, 'Band')),
  )
  set(
    'ppt/slideLayouts/_rels/slideLayout5.xml.rels',
    RELS_HEAD +
      '<Relationship Id="rId1" Type="' +
      MASTER_REL +
      '" Target="../slideMasters/slideMaster2.xml"/>' +
      '</Relationships>',
  )
  const ct = archive.readText('[Content_Types].xml') ?? ''
  set(
    '[Content_Types].xml',
    ct.replace(
      '</Types>',
      '<Override PartName="/ppt/slideMasters/slideMaster2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
        '<Override PartName="/ppt/slideLayouts/slideLayout2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
        '<Override PartName="/ppt/slideLayouts/slideLayout3.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
        '<Override PartName="/ppt/slideLayouts/slideLayout4.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
        '<Override PartName="/ppt/slideLayouts/slideLayout5.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
        '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
        '</Types>',
    ),
  )
  const pres = archive.readText('ppt/presentation.xml') ?? ''
  set(
    'ppt/presentation.xml',
    pres.replace(
      '</p:sldMasterIdLst>',
      '<p:sldMasterId id="2147483649" r:id="rId3"/></p:sldMasterIdLst>',
    ),
  )
  const presRels = archive.readText('ppt/_rels/presentation.xml.rels') ?? ''
  set(
    'ppt/_rels/presentation.xml.rels',
    presRels.replace(
      '</Relationships>',
      '<Relationship Id="rId3" Type="' +
        MASTER_REL +
        '" Target="slideMasters/slideMaster2.xml"/>' +
        '</Relationships>',
    ),
  )
  // two more sample slides: slide2 on layout 3 (master 1), slide3 on layout 4 (master 1)
  insertSlideWithLayout(opened, 0, 'ppt/slideLayouts/slideLayout4.xml')
  insertSlideWithLayout(opened, 1, 'ppt/slideLayouts/slideLayout5.xml')
  // template metadata the builder scrubs
  set(
    'docProps/core.xml',
    XMLDECL +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<dc:creator>Someone</dc:creator><cp:lastModifiedBy>Someone</cp:lastModifiedBy>' +
      '<cp:revision>5</cp:revision><dc:title>Old title</dc:title>' +
      '<dc:subject>s</dc:subject><cp:keywords>k</cp:keywords><dc:description>d</dc:description>' +
      '</cp:coreProperties>',
  )
  set(
    'docProps/app.xml',
    XMLDECL +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>TeleOffice</Application><Slides>3</Slides>' +
      '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Slides</vt:lpstr></vt:variant><vt:variant><vt:i4>3</vt:i4></vt:variant></vt:vector></HeadingPairs>' +
      '<TitlesOfParts><vt:vector size="3" baseType="lpstr"><vt:lpstr>Old 1</vt:lpstr><vt:lpstr>Old 2</vt:lpstr><vt:lpstr>Old 3</vt:lpstr></vt:vector></TitlesOfParts>' +
      '</Properties>',
  )
  set(
    'ppt/commentAuthors.xml',
    XMLDECL +
      '<p:cmAuthorLst xmlns:a="' +
      NS_A +
      '" xmlns:r="' +
      NS_R +
      '" xmlns:p="' +
      NS_P +
      '">' +
      '<p:cmAuthor id="0" name="Someone"/></p:cmAuthorLst>',
  )
  const ct2 = archive.readText('[Content_Types].xml') ?? ''
  set(
    '[Content_Types].xml',
    ct2.replace(
      '</Types>',
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
        '<Override PartName="/ppt/commentAuthors.xml" ContentType="application/vnd.openxmlformats-officedocument.commentAuthors+xml"/>' +
        '</Types>',
    ),
  )
  return savePptx(opened)
}
