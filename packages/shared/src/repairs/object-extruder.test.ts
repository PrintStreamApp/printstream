/**
 * The object-level extruder invariant: an object whose parts carry `extruder` metadata must carry
 * the OBJECT-level entry too, because that is what the BambuStudio CLI slices by. Fixtures mirror
 * the real affected file (CHM - H2 v10/v11: replaced objects written import-format, part-only) and
 * the legitimate BambuStudio shapes that must never be flagged.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectModelSettingsObjectExtruders, repairModelSettingsObjectExtruders } from './object-extruder.js'

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

  const { xml, repaired } = repairModelSettingsObjectExtruders(PART_ONLY)
  assert.deepEqual(repaired, [{ objectId: 166, name: 'Track', extruder: 2 }])
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
  // Object-level 1 with a part on 2 is a legitimate per-part material override, not a defect.
  assert.equal(inspectModelSettingsObjectExtruders(xml)?.inconsistent, false)
  assert.equal(repairModelSettingsObjectExtruders(xml).xml, xml)
})

test('divergent but fully-covered parts repair from the first part (the slot is engine-inert)', () => {
  // Two parts means components layout (3MF objects are mesh XOR components), where the CLI binds
  // each part's own extruder (measured: a mixed-material components object with no object-level
  // entry sliced each part with its assigned filament). Every carrying part has an entry, so the
  // object slot changes nothing for the engine: writing the first part's value just restores the
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
  const result = repairModelSettingsObjectExtruders(xml)
  assert.deepEqual(result.repaired, [{ objectId: 20, name: 'Duo', extruder: 2 }])
  // The parts keep their own (divergent) entries, only the object head gains its slot.
  assert.match(result.xml, /<metadata key="name" value="Duo"\/>\n\s*<metadata key="extruder" value="2"\/>/)
  assert.match(result.xml, /<part id="21" subtype="normal_part">\n\s*<metadata key="extruder" value="3"\/>/)
  assert.equal(inspectModelSettingsObjectExtruders(result.xml)?.inconsistent, false)
})

test('a carrying part with no extruder of its own repairs to filament 1, never to a sibling\'s slot', () => {
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
  // Writing object=2 would silently move the inheriting part onto a material nobody chose for it.
  // Writing 1 cannot: BambuStudio already resolves the absent object slot to 1, so "Inheritor"
  // prints filament 1 before and after: the repair only makes that explicit.
  const inspection = inspectModelSettingsObjectExtruders(xml)
  assert.deepEqual(inspection?.repairable, [{ objectId: 30, name: 'Pair' }])
  const result = repairModelSettingsObjectExtruders(xml)
  assert.deepEqual(result.repaired, [{ objectId: 30, name: 'Pair', extruder: 1 }])
  assert.match(result.xml, /<metadata key="name" value="Pair"\/>\s*<metadata key="extruder" value="1"\/>/)
  // The covered sibling keeps the material it declares; only the object head gained an entry.
  assert.match(result.xml, /<part id="30"[\s\S]*?value="2"/)
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

test('an object head with no metadata to anchor on is still repaired, and success is never claimed falsely', () => {
  // Our own bake writes this shape: an `<object>` whose only child is the `<part>`, with no
  // object-level `name`/`layer_height` metadata to insert after. The writer used to bail here and
  // return the block untouched WHILE the caller had already recorded it as repaired, so Repair
  // reported success, changed no bytes, and the banner came back on reopen. Third confirmed cause
  // of "I pressed Repair and it did not stick".
  const xml = [
    '<config>',
    '  <object id="5">',
    '    <part id="5" subtype="normal_part">',
    '      <metadata key="extruder" value="2"/>',
    '    </part>',
    '  </object>',
    '</config>'
  ].join('\n')
  assert.equal(inspectModelSettingsObjectExtruders(xml)?.inconsistent, true)
  const result = repairModelSettingsObjectExtruders(xml)
  assert.notEqual(result.xml, xml, 'the repair must actually write the object-level entry')
  assert.deepEqual(result.repaired, [{ objectId: 5, name: null, extruder: 2 }])
  // The invariant that makes `repaired` trustworthy anywhere it is reported or logged.
  assert.equal(inspectModelSettingsObjectExtruders(result.xml)?.inconsistent, false)
})

test('an object that cannot be rewritten is never reported as repaired', () => {
  // `repaired` must mean "bytes changed", not "we intended to". A malformed block that the writer
  // declines must fall out of the list rather than claim a fix that did not happen.
  const malformed = '<config>\n  <object id="7"\n</config>'
  const result = repairModelSettingsObjectExtruders(malformed)
  assert.deepEqual(result.repaired, [])
  assert.equal(result.xml, malformed)
})
