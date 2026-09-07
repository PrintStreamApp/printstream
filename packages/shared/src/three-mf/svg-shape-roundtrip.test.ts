/**
 * Extruded SVG artwork must survive a SAVE, or the tool is a one-shot: the geometry bakes to
 * triangles and the only record of what was drawn is the `<printstream_svg/>` the bake writes into
 * the part's model_settings entry, plus the `.svg` archive entry it names. This walks that whole
 * path -- author, then read back -- because the halves live in different modules and each has its
 * own way to drop the field silently.
 *
 * The archive entry gets the same treatment as the element. It is easy to write a record that
 * parses perfectly and names bytes nobody stored, which reopens as anonymous solids exactly as if
 * the record were missing, and passes every test that only looks at the XML.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseModelSettingsScene } from './scene-parser.js'
import { planEditedThreeMf, type ThreeMfBakeSource } from './bake.js'
import { studioShapeFixTransform, studioShapeScale, type SvgPartRecord } from './svg-shape.js'
import type { SceneEdit } from '../slicing.js'

const MARKUP = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>'

const RECORD: SvgPartRecord = {
  entryPath: '3D/logo.svg',
  fileName: 'logo.svg',
  pieceIndex: 2,
  widthMm: 42.5,
  thickness: 1.6,
  includeBackground: false
}

function baseSource(): ThreeMfBakeSource {
  return {
    modelXml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<model unit="millimeter">',
      ' <resources>',
      '  <object id="1" type="model"><mesh><vertices/><triangles/></mesh></object>',
      ' </resources>',
      ' <build><item objectid="1"/></build>',
      '</model>'
    ].join('\n'),
    modelSettingsXml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<config>',
      '  <object id="1"><metadata key="name" value="Host"/></object>',
      '</config>'
    ].join('\n'),
    projectSettingsJson: null,
    customGcodeXml: null,
    sliceInfoXml: null,
    modelRelsXml: null,
    subModelEntries: new Map(),
    hasBase: true
  }
}

/**
 * Run the REAL bake with one SVG part. Deliberately not a hand-written fixture: the bake's own call
 * site is exactly where an optional field gets forgotten, and a fixture pasting the serializer in
 * by hand would pass with the bake ignoring the record entirely.
 */
function bake(
  overrides: { svgPart?: SvgPartRecord; bambuShape?: unknown; withSource?: boolean } = {}
): { modelSettings: string; entries: Array<{ name: string; content: string }> } {
  const edit = {
    plates: [{ index: 1 }],
    instances: [{
      objectId: 1, plateIndex: 1,
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }
    }],
    addedParts: [{
      objectId: 1, meshImportId: 'svg-mesh', subtype: 'normal_part', name: 'logo 2',
      matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      svgPart: overrides.svgPart ?? RECORD,
      ...(overrides.bambuShape ? { bambuShape: overrides.bambuShape } : {})
    }],
    ...(overrides.withSource === false ? {} : { svgSources: [{ entryPath: '3D/logo.svg', markup: MARKUP }] })
  } as unknown as SceneEdit
  const plan = planEditedThreeMf(baseSource(), edit, [{
    importId: 'svg-mesh',
    name: 'logo 2',
    mesh: {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } }
    }
  }])
  return {
    modelSettings: plan.copy?.transforms.get('Metadata/model_settings.config')?.('') ?? '',
    entries: plan.copy?.appendEntries ?? []
  }
}

function partsOf(xml: string) {
  const scene = parseModelSettingsScene(xml)
  return [...scene.partsByObjectId.values()].flatMap((map) => [...map.values()])
}

test('an SVG part authored by the bake parses back with its record intact', () => {
  const part = partsOf(bake().modelSettings).find((entry) => entry.svgPart)
  assert.ok(part, 'the part carried no svgPart, so the artwork would reopen as plain geometry')
  assert.deepEqual(part.svgPart, RECORD)
})

test('the bake stores the artwork as its own archive entry', () => {
  // The records store no shapes -- both readers re-parse these bytes -- so a record naming an entry
  // nobody wrote is exactly as un-editable as no record at all, and looks fine in the XML.
  const entry = bake().entries.find((candidate) => candidate.name === '3D/logo.svg')
  assert.ok(entry, 'the source SVG was never written into the archive')
  assert.equal(entry.content, MARKUP)
})

test('the element sits INSIDE the part, keyed to the volume', () => {
  const part = /<part\b[\s\S]*?<\/part>/.exec(bake().modelSettings)?.[0] ?? ''
  assert.ok(part.includes('<printstream_svg'), 'the record was not written inside its part')
})

test('a part with no record reports none rather than an empty one', () => {
  const stripped = bake().modelSettings.replace(/ *<printstream_svg[^>]*\/>\n/, '')
  const parts = partsOf(stripped)
  assert.equal(parts.length, 1)
  assert.equal(parts[0]?.svgPart, undefined)
})

test('a merged import records piece 0, distinguishing it from the first of several', () => {
  const merged = { ...RECORD, pieceIndex: 0 }
  assert.equal(partsOf(bake({ svgPart: merged }).modelSettings)[0]?.svgPart?.pieceIndex, 0)
})

test('a filename with XML-special characters survives the file', () => {
  const awkward = { ...RECORD, fileName: 'a&b "v2" <draft>.svg' }
  assert.equal(partsOf(bake({ svgPart: awkward }).modelSettings)[0]?.svgPart?.fileName, awkward.fileName)
})

test('Studio\'s interop record is written alongside ours when the import made one part', () => {
  const shape = {
    filePath: 'logo.svg',
    filePathIn3mf: '3D/logo.svg',
    scale: studioShapeScale(0.5),
    unhealed: false,
    depth: 1.6,
    useSurface: false,
    fixTransform: studioShapeFixTransform(1.6)
  }
  const xml = bake({ svgPart: { ...RECORD, pieceIndex: 0 }, bambuShape: shape }).modelSettings
  const part = /<part\b[\s\S]*?<\/part>/.exec(xml)?.[0] ?? ''
  assert.ok(part.includes('<BambuStudioShape'), 'the interop record was not written')
  assert.match(part, /filepath3mf="3D\/logo\.svg"/)
  // Studio's reader has no fallback for a missing scale and reads it as 0, which opens collapsed.
  assert.match(part, /\bscale="/)
})

test('a SPLIT import carries our record but NOT Studio\'s', () => {
  // `<BambuStudioShape>` describes a WHOLE artwork, so one on each of N parts tells BambuStudio
  // that every mark is the entire logo, and editing any one of them there regenerates the whole
  // drawing over it. Absent is correct; a record that lies is not.
  const part = /<part\b[\s\S]*?<\/part>/.exec(bake({ svgPart: RECORD }).modelSettings)?.[0] ?? ''
  assert.ok(part.includes('<printstream_svg'), 'our own record should still be written')
  assert.ok(!part.includes('<BambuStudioShape'), 'a split part must not claim to be the whole artwork')
})
