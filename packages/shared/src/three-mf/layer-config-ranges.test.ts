import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseLayerConfigRanges,
  serializeLayerConfigRanges,
  type ObjectHeightRanges
} from './layer-config-ranges.js'

/** A root model whose build order gives ordinals 1..3 to object ids 7, 4, 9. */
const ROOT_MODEL = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter">
  <resources>
    <object id="7" type="model"><mesh/></object>
    <object id="4" type="model"><mesh/></object>
    <object id="9" type="model"><mesh/></object>
  </resources>
  <build>
    <item objectid="7"/>
    <item objectid="4"/>
    <item objectid="9"/>
  </build>
</model>`

/** Shaped like BambuStudio's own writer output (boost property_tree, alphabetical options). */
const STUDIO_FILE = `<?xml version="1.0" encoding="utf-8"?>
<objects>
 <object id="1">
  <range min_z="0" max_z="2">
   <option opt_key="extruder">0</option>
   <option opt_key="layer_height">0.2</option>
  </range>
  <range min_z="2" max_z="5.5">
   <option opt_key="extruder">3</option>
   <option opt_key="layer_height">0.12</option>
   <option opt_key="sparse_infill_density">45%</option>
  </range>
 </object>
 <object id="3">
  <range min_z="0" max_z="1.4">
   <option opt_key="extruder">0</option>
   <option opt_key="layer_height">0.08</option>
  </range>
 </object>
</objects>`

test('parses BambuStudio ranges onto the right OBJECT IDS via the 1-based ordinal', () => {
  const parsed = parseLayerConfigRanges(STUDIO_FILE, ROOT_MODEL)
  // Ordinal 1 -> object 7, ordinal 3 -> object 9. Object 4 (ordinal 2) has none.
  assert.deepEqual([...parsed.keys()].sort((a, b) => a - b), [7, 9])
  assert.equal(parsed.get(4), undefined)

  const first = parsed.get(7)!
  assert.equal(first.length, 2)
  assert.deepEqual(first[0], { minZ: 0, maxZ: 2, settings: { extruder: '0', layer_height: '0.2' } })
  assert.deepEqual(first[1], {
    minZ: 2, maxZ: 5.5,
    settings: { extruder: '3', layer_height: '0.12', sparse_infill_density: '45%' }
  })
  assert.deepEqual(parsed.get(9), [{ minZ: 0, maxZ: 1.4, settings: { extruder: '0', layer_height: '0.08' } }])
})

test('a malformed sidecar is skipped, never thrown on', () => {
  // BambuStudio's reader aborts the whole 3MF load on any of these; ours must not.
  const broken = `<objects>
 <object id="1"><range max_z="2"><option opt_key="layer_height">0.2</option></range></object>
 <object id="1"><range min_z="0" max_z="0"><option opt_key="layer_height">0.2</option></range></object>
 <object id="99"><range min_z="0" max_z="2"><option opt_key="layer_height">0.2</option></range></object>
 <object><range min_z="0" max_z="2"><option opt_key="layer_height">0.2</option></range></object>
 <object id="2"><range min_z="0" max_z="3"><option opt_key="layer_height">0.15</option></range></object>
</objects>`
  const parsed = parseLayerConfigRanges(broken, ROOT_MODEL)
  // Only the well-formed object-2 (-> object id 4) entry survives; nothing throws.
  assert.deepEqual([...parsed.keys()], [4])
  assert.equal(parsed.get(4)!.length, 1)
  assert.equal(parsed.get(4)![0]!.maxZ, 3)
})

test('absent or empty input yields no ranges', () => {
  assert.equal(parseLayerConfigRanges(null, ROOT_MODEL).size, 0)
  assert.equal(parseLayerConfigRanges('', ROOT_MODEL).size, 0)
  assert.equal(parseLayerConfigRanges('<objects/>', ROOT_MODEL).size, 0)
})

test('serializes back to ordinals resolved against the SAVED model', () => {
  const entries: ObjectHeightRanges[] = [
    { objectId: 9, ranges: [{ minZ: 0, maxZ: 1.4, settings: { layer_height: '0.08', extruder: '0' } }] },
    { objectId: 7, ranges: [{ minZ: 0, maxZ: 2, settings: { layer_height: '0.2', extruder: '0' } }] }
  ]
  const xml = serializeLayerConfigRanges(entries, ROOT_MODEL)
  assert.match(xml, /<object id="1">/)
  assert.match(xml, /<object id="3">/)
  assert.doesNotMatch(xml, /<object id="2">/)
  // Whole-number Z values print like boost does: "2", not "2.0".
  assert.match(xml, /min_z="0" max_z="2"/)
  assert.match(xml, /min_z="0" max_z="1.4"/)
})

test('a range round-trips through serialize and parse unchanged', () => {
  const entries: ObjectHeightRanges[] = [{
    objectId: 7,
    ranges: [
      { minZ: 0, maxZ: 2, settings: { layer_height: '0.2', extruder: '0' } },
      { minZ: 2, maxZ: 5.5, settings: { layer_height: '0.12', extruder: '3', sparse_infill_density: '45%' } }
    ]
  }]
  const reparsed = parseLayerConfigRanges(serializeLayerConfigRanges(entries, ROOT_MODEL), ROOT_MODEL)
  assert.deepEqual(reparsed.get(7), entries[0]!.ranges)
})

test('never writes a range without layer_height, which crashes BambuStudio', () => {
  // Slicing.cpp:179 reads option("layer_height")->getFloat() with no has() check.
  const xml = serializeLayerConfigRanges([{
    objectId: 7,
    ranges: [
      { minZ: 0, maxZ: 2, settings: { sparse_infill_density: '20%' } },
      { minZ: 2, maxZ: 4, settings: { layer_height: '0.1' } }
    ]
  }], ROOT_MODEL)
  assert.doesNotMatch(xml, /min_z="0" max_z="2"/, 'the layer_height-less range must be dropped')
  assert.match(xml, /min_z="2" max_z="4"/)
})

test('always writes extruder, or BambuStudio hides the range from its own object list', () => {
  // GUI_ObjectList.cpp:4803 returns early when a range has no "extruder" key.
  const xml = serializeLayerConfigRanges([{
    objectId: 7, ranges: [{ minZ: 0, maxZ: 2, settings: { layer_height: '0.2' } }]
  }], ROOT_MODEL)
  assert.match(xml, /<option opt_key="extruder">0<\/option>/)
})

test('an empty set clears the file rather than leaving a stale one', () => {
  assert.equal(serializeLayerConfigRanges([], ROOT_MODEL), '')
  assert.equal(serializeLayerConfigRanges([{ objectId: 7, ranges: [] }], ROOT_MODEL), '')
  // An object that is no longer in the saved model contributes nothing.
  assert.equal(serializeLayerConfigRanges([{
    objectId: 404, ranges: [{ minZ: 0, maxZ: 2, settings: { layer_height: '0.2' } }]
  }], ROOT_MODEL), '')
})

test('ranges and objects serialize in a stable order regardless of input order', () => {
  const jumbled: ObjectHeightRanges[] = [{
    objectId: 7,
    ranges: [
      { minZ: 4, maxZ: 6, settings: { layer_height: '0.1' } },
      { minZ: 0, maxZ: 2, settings: { layer_height: '0.2' } }
    ]
  }]
  const xml = serializeLayerConfigRanges(jumbled, ROOT_MODEL)
  assert.ok(xml.indexOf('min_z="0"') < xml.indexOf('min_z="4"'), 'ranges sort by minZ')
})

test('option values with XML-special characters survive a round trip', () => {
  const entries: ObjectHeightRanges[] = [{
    objectId: 7,
    ranges: [{ minZ: 0, maxZ: 2, settings: { layer_height: '0.2', extruder: '0', custom_gcode: 'M117 a<b & c>d' } }]
  }]
  const reparsed = parseLayerConfigRanges(serializeLayerConfigRanges(entries, ROOT_MODEL), ROOT_MODEL)
  assert.equal(reparsed.get(7)![0]!.settings.custom_gcode, 'M117 a<b & c>d')
})
