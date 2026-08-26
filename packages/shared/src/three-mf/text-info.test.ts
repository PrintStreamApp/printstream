/**
 * `<text_info>` is a PERSISTED wire format shared with BambuStudio, so these tests are about
 * agreeing with somebody else's parser rather than with ourselves.
 *
 * The version gates are the subtle part and they are asymmetric: Studio's writer emits the modern
 * `surface_type` at font_version >= 2.0, but its reader only accepts `boldness`/`skew` above 2.2.
 * A file stamped between those two numbers round-trips its surface mode and silently loses its
 * boldness, which is why we stamp above both.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TEXT_INFO_FONT_VERSION,
  defaultTextInfo,
  parseTextInfo,
  serializeTextInfo
} from './text-info.js'

test('the stamped font version clears both of Studio\'s gates', () => {
  const version = Number.parseFloat(TEXT_INFO_FONT_VERSION)
  assert.ok(version >= 2.0, 'below 2.0 Studio writes the legacy surface pair instead of surface_type')
  assert.ok(version > 2.2, 'at or below 2.2 Studio\'s reader discards boldness and skew')
})

test('a full round trip preserves every field', () => {
  const info = {
    ...defaultTextInfo('Hello', 'Noto Sans'),
    styleName: 'Bold Italic', fontIndex: 2, fontSize: 12.5, thickness: 3.25,
    embeddedDepth: 1.5, rotateAngle: -45, textGap: 2.5, bold: true, italic: true,
    boldness: 0.4, skew: 0.2, surfaceType: 'surfaceChar' as const,
    hitMeshId: 7, hitPosition: [1, 2, 3] as const, hitNormal: [0, 1, 0] as const
  }
  const parsed = parseTextInfo(serializeTextInfo(info))
  assert.deepEqual(parsed, info)
})

test('the depth attribute keeps Studio\'s spelling', () => {
  // `embeded_depth` is misspelled in the file format. Correcting it drops the value silently in
  // both directions, because neither parser would find the other's name.
  const xml = serializeTextInfo({ ...defaultTextInfo('x', 'f'), embeddedDepth: 4 })
  assert.ok(xml.includes('embeded_depth="4"'), xml)
  assert.equal(parseTextInfo(xml)?.embeddedDepth, 4)
})

test('text is escaped and unescaped, so quotes and ampersands survive', () => {
  const info = { ...defaultTextInfo('A & B "quoted" <tag>', 'Font & Co') }
  const xml = serializeTextInfo(info)
  assert.ok(!xml.includes('"A & B'), 'raw quote would terminate the attribute and corrupt the element')
  const parsed = parseTextInfo(xml)
  assert.equal(parsed?.text, 'A & B "quoted" <tag>')
  assert.equal(parsed?.fontName, 'Font & Co')
})

test('an older file\'s legacy surface pair is understood', () => {
  // Studio wrote surface_text + keep_horizontal below version 2.0 and never rewrites old files.
  const legacy = (surface: number, horizontal: number): string =>
    `<text_info text="hi" font_version="1.1" surface_text="${surface}" keep_horizontal="${horizontal}"/>`
  assert.equal(parseTextInfo(legacy(1, 1))?.surfaceType, 'surfaceHorizontal')
  assert.equal(parseTextInfo(legacy(1, 0))?.surfaceType, 'surface')
  // Studio's own quirk: keep_horizontal alone, and neither flag, both mean plain horizontal.
  assert.equal(parseTextInfo(legacy(0, 1))?.surfaceType, 'horizontal')
  assert.equal(parseTextInfo(legacy(0, 0))?.surfaceType, 'horizontal')
})

test('boldness and skew are ignored below Studio\'s 2.2 gate', () => {
  // Studio would not read them from such a file, so trusting them would make us render text its
  // own editor renders differently.
  const old = '<text_info text="hi" font_version="2.0" boldness="0.9" skew="0.5"/>'
  assert.equal(parseTextInfo(old)?.boldness, 0)
  assert.equal(parseTextInfo(old)?.skew, 0)
})

test('bold defaults to TRUE when absent, matching Studio', () => {
  assert.equal(parseTextInfo('<text_info text="hi"/>')?.bold, true)
  assert.equal(parseTextInfo('<text_info text="hi" bold="0"/>')?.bold, false)
})

test('an element with no text is not editable text', () => {
  assert.equal(parseTextInfo('<text_info font_name="x" font_size="10"/>'), null)
})

test("an apostrophe survives a round trip, because Studio escapes it as &apos;", () => {
  // `xml_escape` (utils.cpp:1242) emits &apos;, which a decoder handling only the four common
  // entities leaves as literal text -- and the next save escapes its ampersand again, so the entity
  // grows on every cycle and the user sees the raw markup in the panel.
  const original = defaultTextInfo("Bob's & Co", 'DejaVu Sans')
  const parsed = parseTextInfo(serializeTextInfo(original))
  assert.equal(parsed?.text, "Bob's & Co")

  // And a file Studio itself wrote, which uses &apos; where we would use a literal quote.
  const fromStudio = parseTextInfo('<text_info text="Bob&apos;s &amp; Co" font_name="X"/>')
  assert.equal(fromStudio?.text, "Bob's & Co")
})
