/**
 * `ModelVolume::type_from_string` is an exact match on five strings and DEFAULTS TO MODEL_PART for
 * anything else (`Model.cpp:3400-3416`), so a non-canonical subtype does not fail: a modifier or a
 * support blocker prints as solid geometry. And the importer applies the `subtype` ATTRIBUTE first,
 * then walks the part's metadata where `volume_type` / `part_type` calls `set_type` AGAIN
 * (`bbs_3mf.cpp:5216` then `:5229-5230`), so a legacy entry silently overrides a retype.
 *
 * Nothing observed writes either shape (0 of 141 real files), so both are closed channels rather
 * than live defects; the rule they enforce is the one `three-mf-part-subtype.ts` already states.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyPartTypeChanges, renderImportedMultiPartModelSettingsXml } from './bake-documents'

test('an imported part subtype is canonicalised on the way out', () => {
  // `ParameterModifier` is what older and foreign writers use; the engine matches only
  // `modifier_part` and silently treats the rest as printed geometry.
  const xml = renderImportedMultiPartModelSettingsXml(7, 'Widget', null, [
    { componentObjectId: 11, name: 'Modifier', subtype: 'ParameterModifier', extruder: null }
  ] as never)
  assert.match(xml, /subtype="modifier_part"/)
  assert.doesNotMatch(xml, /ParameterModifier/)
})

test('an already-canonical subtype is unchanged', () => {
  const xml = renderImportedMultiPartModelSettingsXml(7, 'Widget', null, [
    { componentObjectId: 11, name: 'Blocker', subtype: 'support_blocker', extruder: null }
  ] as never)
  assert.match(xml, /subtype="support_blocker"/)
})

test('an unknown subtype falls back to a normal part rather than being written raw', () => {
  const xml = renderImportedMultiPartModelSettingsXml(7, 'Widget', null, [
    { componentObjectId: 11, name: 'Odd', subtype: 'something_invented', extruder: null }
  ] as never)
  assert.match(xml, /subtype="normal_part"/)
  assert.doesNotMatch(xml, /something_invented/)
})

test('a retype strips the legacy metadata that would override it', () => {
  const source = [
    '<config>',
    '  <object id="3">',
    '    <part id="1" subtype="normal_part">',
    '      <metadata key="name" value="Body"/>',
    '      <metadata key="volume_type" value="ModelPart"/>',
    '    </part>',
    '  </object>',
    '</config>'
  ].join('\n')
  const out = applyPartTypeChanges(source, [{ objectId: 3, partIndex: 0, subtype: 'modifier_part' }] as never)
  assert.match(out, /subtype="modifier_part"/)
  assert.doesNotMatch(out, /volume_type/, 'the legacy key survived and would override the retype')
  assert.match(out, /key="name" value="Body"/, 'unrelated part metadata was destroyed')
})

test('a part the retype did not touch keeps its metadata untouched', () => {
  // A key we do not write is still not ours to delete from a file we were not asked to change.
  const source = [
    '<config>',
    '  <object id="3">',
    '    <part id="1" subtype="normal_part"><metadata key="volume_type" value="ModelPart"/></part>',
    '  </object>',
    '</config>'
  ].join('\n')
  const out = applyPartTypeChanges(source, [{ objectId: 9, partIndex: 0, subtype: 'modifier_part' }] as never)
  assert.match(out, /volume_type/)
})
