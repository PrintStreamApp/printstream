/**
 * The object-level extruder invariant: an object whose parts carry `extruder` metadata must carry
 * the OBJECT-level entry too, because that is what the BambuStudio CLI slices by. Fixtures mirror
 * the real affected file (CHM - H2 v10/v11: replaced objects written import-format, part-only) and
 * the legitimate BambuStudio shapes that must never be flagged.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectModelSettingsObjectExtruders, repairModelSettingsObjectExtruders } from './object-extruder'

/** The import-format shape our bake used to write for a replaced object (part-only extruder). */
const PART_ONLY = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<config>',
  '  <object id="166">',
  '    <metadata key="layer_height" value="0.12"/>',
  '    <metadata key="name" value="Track"/>',
  '    <part id="166" subtype="normal_part">',
  '      <metadata key="name" value="M - Track"/>',
  '      <metadata key="extruder" value="2"/>',
  '    </part>',
  '  </object>',
  '  <plate>',
  '    <metadata key="plater_id" value="1"/>',
  '  </plate>',
  '</config>'
].join('\n')

test('flags and repairs an object whose extruder lives only on its part', () => {
  const inspection = inspectModelSettingsObjectExtruders(PART_ONLY)
  assert.equal(inspection?.inconsistent, true)
  assert.deepEqual(inspection?.repairable, [{ objectId: 166, name: 'Track' }])
  assert.deepEqual(inspection?.ambiguous, [])

  const { xml, repaired, ambiguous } = repairModelSettingsObjectExtruders(PART_ONLY)
  assert.deepEqual(repaired, [{ objectId: 166, name: 'Track', extruder: 2 }])
  assert.deepEqual(ambiguous, [])
  // The entry lands in the object's HEAD (after the last object metadata, before the part), which
  // is where BambuStudio and the bake writers put it.
  assert.match(xml, /<metadata key="name" value="Track"\/>\n {4}<metadata key="extruder" value="2"\/>\n {4}<part/)
  // Repair and detection are one implementation: the repaired document must inspect clean.
  assert.equal(inspectModelSettingsObjectExtruders(xml)?.inconsistent, false)
})

test('never flags the shape BambuStudio itself writes (extruder at both levels)', () => {
  const xml = PART_ONLY.replace(
    '<metadata key="name" value="Track"/>',
    '<metadata key="name" value="Track"/>\n    <metadata key="extruder" value="1"/>'
  )
  // Object-level 1 with a part on 2 is a legitimate per-part material override — not a defect.
  assert.equal(inspectModelSettingsObjectExtruders(xml)?.inconsistent, false)
  assert.equal(repairModelSettingsObjectExtruders(xml).xml, xml)
})

test('divergent but fully-covered parts repair from the first part (the slot is engine-inert)', () => {
  // Two parts means components layout (3MF objects are mesh XOR components), where the CLI binds
  // each part's own extruder (measured: a mixed-material components object with no object-level
  // entry sliced each part with its assigned filament). Every carrying part has an entry, so the
  // object slot changes nothing for the engine — writing the first part's value just restores the
  // BambuStudio document shape instead of stranding the object in a "needs attention" loop.
  const xml = [
    '<config>',
    '  <object id="20">',
    '    <metadata key="name" value="Duo"/>',
    '    <part id="20" subtype="normal_part">',
    '      <metadata key="extruder" value="2"/>',
    '    </part>',
    '    <part id="21" subtype="normal_part">',
    '      <metadata key="extruder" value="3"/>',
    '    </part>',
    '  </object>',
    '</config>'
  ].join('\n')
  const inspection = inspectModelSettingsObjectExtruders(xml)
  assert.equal(inspection?.inconsistent, true)
  assert.deepEqual(inspection?.repairable, [{ objectId: 20, name: 'Duo' }])
  assert.deepEqual(inspection?.ambiguous, [])
  const result = repairModelSettingsObjectExtruders(xml)
  assert.deepEqual(result.repaired, [{ objectId: 20, name: 'Duo', extruder: 2 }])
  // The parts keep their own (divergent) entries — only the object head gains its slot.
  assert.match(result.xml, /<metadata key="name" value="Duo"\/>\n\s*<metadata key="extruder" value="2"\/>/)
  assert.match(result.xml, /<part id="21" subtype="normal_part">\n\s*<metadata key="extruder" value="3"\/>/)
  assert.equal(inspectModelSettingsObjectExtruders(result.xml)?.inconsistent, false)
})

test('a carrying part with no extruder of its own blocks the derivation (it inherits the object slot)', () => {
  const xml = [
    '<config>',
    '  <object id="30">',
    '    <metadata key="name" value="Pair"/>',
    '    <part id="30" subtype="normal_part">',
    '      <metadata key="extruder" value="2"/>',
    '    </part>',
    '    <part id="31" subtype="normal_part">',
    '      <metadata key="name" value="Inheritor"/>',
    '    </part>',
    '  </object>',
    '</config>'
  ].join('\n')
  // Writing object=2 would silently move the inheriting part off the default — not derivable.
  const inspection = inspectModelSettingsObjectExtruders(xml)
  assert.deepEqual(inspection?.repairable, [])
  assert.deepEqual(inspection?.ambiguous, [{ objectId: 30, name: 'Pair' }])
  const result = repairModelSettingsObjectExtruders(xml)
  assert.equal(result.xml, xml)
  assert.deepEqual(result.ambiguous, [{ objectId: 30, name: 'Pair' }])
})

test('helper volumes never make an object repairable', () => {
  const xml = [
    '<config>',
    '  <object id="40">',
    '    <metadata key="name" value="Aided"/>',
    '    <part id="40" subtype="support_blocker">',
    '      <metadata key="extruder" value="2"/>',
    '    </part>',
    '  </object>',
    '</config>'
  ].join('\n')
  // A blocker's extruder is meaningless (Studio writes 0 there); nothing claims a material.
  assert.equal(inspectModelSettingsObjectExtruders(xml)?.inconsistent, false)
})

test('a modifier part participates like a normal part (its extruder is meaningful)', () => {
  const xml = [
    '<config>',
    '  <object id="50">',
    '    <metadata key="name" value="Tinted"/>',
    '    <part id="50" subtype="normal_part">',
    '      <metadata key="extruder" value="2"/>',
    '    </part>',
    '    <part id="51" subtype="modifier_part">',
    '      <metadata key="extruder" value="2"/>',
    '    </part>',
    '  </object>',
    '</config>'
  ].join('\n')
  const { repaired } = repairModelSettingsObjectExtruders(xml)
  assert.deepEqual(repaired, [{ objectId: 50, name: 'Tinted', extruder: 2 }])
})

test('a document with no object blocks is nothing to judge', () => {
  // A sliced output's model_settings carries plates only.
  const platesOnly = '<config>\n  <plate>\n    <metadata key="plater_id" value="1"/>\n  </plate>\n</config>'
  assert.equal(inspectModelSettingsObjectExtruders(platesOnly), null)
  assert.equal(inspectModelSettingsObjectExtruders(null), null)
  assert.equal(inspectModelSettingsObjectExtruders(''), null)
})
