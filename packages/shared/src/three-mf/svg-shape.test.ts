/**
 * `<BambuStudioShape>` is a PERSISTED wire format shared with BambuStudio, so these tests are about
 * agreeing with somebody else's parser rather than with ourselves. Each assertion cites the line of
 * `bbs_3mf.cpp` it is agreeing with.
 *
 * The traps are all "an absent attribute does not mean what you would guess": a missing `scale`
 * reads as ZERO rather than the struct default and collapses the shape, a missing `depth` reads as
 * 10, and the two flag attributes are tested against the literal `1` so `"true"` reads as false.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BAMBU_SHAPE_ELEMENT,
  PRINTSTREAM_SVG_ELEMENT,
  STUDIO_SHAPE_SCALE,
  isSvgArchiveEntry,
  parseBambuStudioShape,
  parseSvgPartRecord,
  serializeBambuStudioShape,
  serializeSvgPartRecord,
  studioShapeFixTransform,
  studioShapeScale,
  svgArchiveEntryPath,
  svgPartRecordFromBambuShape
} from './svg-shape.js'
import {
  MAX_SVG_SOURCE_BYTES,
  sceneEditSvgPartSchema,
  sceneEditSchema,
  svgSourceByteLength
} from '../slicing.js'

const shape = {
  filePath: 'logo.svg',
  filePathIn3mf: '3D/logo.svg',
  scale: STUDIO_SHAPE_SCALE,
  unhealed: false,
  depth: 10,
  useSurface: false,
  fixTransform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 4.985]
}

test('a full round trip preserves every field', () => {
  const parsed = parseBambuStudioShape(serializeBambuStudioShape({
    ...shape, unhealed: true, useSurface: true, depth: 3.5, scale: 2.5e-5
  }))
  assert.equal(parsed.filePath, 'logo.svg')
  assert.equal(parsed.filePathIn3mf, '3D/logo.svg')
  assert.equal(parsed.scale, 2.5e-5)
  assert.equal(parsed.unhealed, true)
  assert.equal(parsed.depth, 3.5)
  assert.equal(parsed.useSurface, true)
  assert.deepEqual(parsed.fixTransform, shape.fixTransform)
})

test('scale is always written, because Studio reads an absent one as zero', () => {
  // `read_emboss_shape` constructs the struct positionally (bbs_3mf.cpp:9841), so the
  // `= SCALING_FACTOR` member initialiser never runs and the shape opens collapsed.
  assert.match(serializeBambuStudioShape({ ...shape, scale: STUDIO_SHAPE_SCALE }), /\bscale="/)
  assert.equal(parseBambuStudioShape(`<${BAMBU_SHAPE_ELEMENT} depth="10"/>`).scale, 0)
})

test('the flag attributes are written only when true, and only as literal 1', () => {
  // Studio tests `== 1` exactly (bbs_3mf.cpp:9823), so `use_surface="true"` reads as FALSE there.
  const off = serializeBambuStudioShape(shape)
  assert.doesNotMatch(off, /use_surface/)
  assert.doesNotMatch(off, /unhealed/)
  const on = serializeBambuStudioShape({ ...shape, useSurface: true, unhealed: true })
  assert.match(on, /use_surface="1"/)
  assert.match(on, /unhealed="1"/)
  assert.equal(parseBambuStudioShape(`<x use_surface="true"/>`).useSurface, false)
})

test('an absent depth reads as 10, matching Studio\'s own coercion', () => {
  // bbs_3mf.cpp:9820. A genuine depth="0" is inexpressible in this format, in both tools.
  assert.equal(parseBambuStudioShape(`<x scale="1e-5"/>`).depth, 10)
  assert.equal(parseBambuStudioShape(`<x scale="1e-5" depth="0"/>`).depth, 10)
})

test('both path attributes are omitted together when there is no archive entry', () => {
  // Studio's writer returns before emitting either (bbs_3mf.cpp:9762); a `filepath` alone would
  // name a file only the authoring machine can see.
  const xml = serializeBambuStudioShape({ ...shape, filePathIn3mf: '' })
  assert.doesNotMatch(xml, /filepath/)
})

test('a record naming no archive entry parses rather than failing', () => {
  // Studio emits both paths and only THEN discovers it has no bytes (bbs_3mf.cpp:9772), so a
  // dangling reference is a state it really produces and we have to represent.
  const parsed = parseBambuStudioShape(`<x scale="1e-5" depth="10"/>`)
  assert.equal(parsed.filePathIn3mf, '')
})

test('a malformed transform is dropped rather than half-read', () => {
  assert.equal(parseBambuStudioShape(`<x transform="1 0 0"/>`).fixTransform, null)
  assert.equal(parseBambuStudioShape(`<x transform="1 0 0 0 1 0 0 0 1 0 0 nope"/>`).fixTransform, null)
})

test('the fix transform offsets by half the depth, less Studio\'s surface inset', () => {
  // Our extrusion is centred on z=0; the mesh Studio regenerates runs -0.015..depth. Writing
  // identity makes the first edit in Studio jump the part up by depth/2.
  assert.deepEqual(studioShapeFixTransform(10), [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 4.985])
})

test('the scale undoes nanosvg\'s unit conversion', () => {
  // Studio parses at units=mm, dpi=96 (NSVGUtils.hpp:68), so one user unit is 25.4/96 mm. Artwork
  // sized at exactly that many mm per unit is the natural size, and reopens at Studio's default.
  assert.ok(Math.abs(studioShapeScale(25.4 / 96) - STUDIO_SHAPE_SCALE) < 1e-12)
  // Twice the natural size is twice the scale.
  assert.ok(Math.abs(studioShapeScale(2 * 25.4 / 96) - 2 * STUDIO_SHAPE_SCALE) < 1e-12)
  // A nonsense width falls back rather than writing a zero that would collapse the shape.
  assert.equal(studioShapeScale(0), STUDIO_SHAPE_SCALE)
})

test('archive entry names follow Studio\'s collision scheme, which has no _1', () => {
  // Plater.cpp:23048 post-increments, so the sequence runs logo, logo_2, logo_3.
  assert.equal(svgArchiveEntryPath('logo.svg', new Set()), '3D/logo.svg')
  assert.equal(svgArchiveEntryPath('logo.svg', new Set(['3D/logo.svg'])), '3D/logo_2.svg')
  assert.equal(
    svgArchiveEntryPath('logo.svg', new Set(['3D/logo.svg', '3D/logo_2.svg'])),
    '3D/logo_3.svg'
  )
  assert.equal(svgArchiveEntryPath('', new Set()), '3D/unknown.svg')
})

test('Studio\'s archive-entry test is case-sensitive on both halves', () => {
  // bbs_3mf.cpp:2520. An entry it does not recognise is one it drops on the next save.
  assert.equal(isSvgArchiveEntry('3D/logo.svg'), true)
  assert.equal(isSvgArchiveEntry('3d/logo.svg'), false)
  assert.equal(isSvgArchiveEntry('3D/logo.SVG'), false)
  assert.equal(isSvgArchiveEntry('Metadata/logo.svg'), false)
})

test('our own record round-trips, and needs an entry to be meaningful', () => {
  const record = {
    entryPath: '3D/logo.svg',
    fileName: 'logo.svg',
    pieceIndex: 3,
    widthMm: 42.5,
    thickness: 1.6,
    includeBackground: true
  }
  assert.deepEqual(parseSvgPartRecord(serializeSvgPartRecord(record)), record)
  assert.equal(parseSvgPartRecord(`<${PRINTSTREAM_SVG_ELEMENT} file_name="logo.svg"/>`), null)
})

test('a merged import records piece 0, distinguishing it from the first of several', () => {
  const merged = parseSvgPartRecord(serializeSvgPartRecord({
    entryPath: '3D/logo.svg', fileName: 'logo.svg', pieceIndex: 0,
    widthMm: 40, thickness: 2, includeBackground: false
  }))
  assert.equal(merged?.pieceIndex, 0)
})

test('XML-special characters in a filename survive the file', () => {
  const record = {
    entryPath: '3D/a&b.svg',
    fileName: 'a&b "quoted" <tag>.svg',
    pieceIndex: 1,
    widthMm: 10,
    thickness: 1,
    includeBackground: false
  }
  assert.deepEqual(parseSvgPartRecord(serializeSvgPartRecord(record)), record)
})

test('a Studio-embossed volume converts to a whole-artwork record', () => {
  // Studio makes ONE volume per SVG, so a file embossed there carries only its own record. Reading
  // just ours made those reopen here as anonymous solids, the same defect from the other direction.
  const record = svgPartRecordFromBambuShape(parseBambuStudioShape(
    serializeBambuStudioShape({ ...shape, depth: 3.5 })
  ))
  assert.equal(record?.entryPath, '3D/logo.svg')
  assert.equal(record?.fileName, 'logo.svg')
  assert.equal(record?.pieceIndex, 0, 'a Studio volume is the whole artwork')
  assert.equal(record?.thickness, 3.5)
  // Studio has no backdrop concept: it extrudes every shape in the file.
  assert.equal(record?.includeBackground, true)
  // Not recoverable: `scale` is relative to nanosvg's own extents for the file, which are unknown
  // until the artwork is parsed. Zero is "not known yet" and must not read as a real width.
  assert.equal(record?.widthMm, 0)
})

test('a Studio record naming no archive entry converts to nothing', () => {
  // There is no artwork to re-derive, and Studio really does write this (bbs_3mf.cpp:9772).
  assert.equal(svgPartRecordFromBambuShape(parseBambuStudioShape('<x scale="1e-5"/>')), null)
})

test('a Studio record with no filepath falls back to the archive entry for its label', () => {
  const record = svgPartRecordFromBambuShape(parseBambuStudioShape(
    '<x filepath3mf="3D/badge_2.svg" scale="1e-5" depth="2"/>'
  ))
  assert.equal(record?.fileName, 'badge_2.svg')
})

test('a Studio-derived record satisfies the wire schema despite its unknown width', () => {
  // `svgPartRecordFromBambuShape` reports widthMm 0 for "not known yet". A `.positive()` constraint
  // contradicted that outright, so a scene carrying a BambuStudio-embossed part would fail to parse.
  const record = svgPartRecordFromBambuShape(parseBambuStudioShape(serializeBambuStudioShape(shape)))
  assert.ok(record)
  assert.equal(sceneEditSvgPartSchema.safeParse(record).success, true)
  assert.equal(record.widthMm, 0)
})

test('artwork is bounded per file AND across the whole save', () => {
  // The per-file cap alone bounds nothing useful: 64 entries at that limit is far past the API's
  // body cap, so a few ordinary drawings could brick save and slice on an opaque 413.
  const sources = (count: number, bytes: number) => Array.from({ length: count }, (_unused, i) => ({
    entryPath: `3D/a${i}.svg`,
    markup: 'x'.repeat(bytes)
  }))
  const parse = (list: ReturnType<typeof sources>) => sceneEditSchema.safeParse({
    plates: [{ index: 1 }], instances: [], svgSources: list
  }).success
  assert.equal(parse(sources(1, 1000)), true)
  assert.equal(parse(sources(1, MAX_SVG_SOURCE_BYTES + 1)), false, 'one oversized file is refused')
  assert.equal(parse(sources(4, 1_000_000)), false, 'the total is refused even when each file fits')
})

test('the size limit counts BYTES, not UTF-16 units', () => {
  // A multi-byte character costs more on the wire than `String.length` suggests, which is what the
  // transport limit actually measures.
  assert.equal(svgSourceByteLength('abc'), 3)
  assert.equal(svgSourceByteLength('é'), 2)
  assert.ok(svgSourceByteLength('\u{1F600}') > '\u{1F600}'.length)
})
