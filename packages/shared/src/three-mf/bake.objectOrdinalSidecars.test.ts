/**
 * The bake half of the ordinal-keyed sidecar contract (`object-ordinal-sidecars.ts` owns the rule
 * itself). Deleting an object shifts every later object's POSITION, and these entries are addressed
 * by position, so copying them through a save verbatim reattaches cut connectors and layer ranges to
 * whichever object moved into the vacated slot.
 *
 * Found by the differential sweep, not by a report: 12 of 33 real projects that our code had never
 * written produced a stale ordinal from one ordinary "delete an object".
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planEditedThreeMf, type ThreeMfBakeSource } from './bake.js'
import type { SceneEdit } from '../slicing.js'

const MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter">',
  ' <resources>',
  '  <object id="1" type="model"><mesh><vertices/><triangles/></mesh></object>',
  '  <object id="2" type="model"><mesh><vertices/><triangles/></mesh></object>',
  '  <object id="3" type="model"><mesh><vertices/><triangles/></mesh></object>',
  ' </resources>',
  ' <build><item objectid="1"/><item objectid="2"/><item objectid="3"/></build>',
  '</model>'
].join('\n')

const MODEL_SETTINGS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<config>',
  '  <object id="1"><metadata key="name" value="A"/></object>',
  '  <object id="2"><metadata key="name" value="B"/></object>',
  '  <object id="3"><metadata key="name" value="C"/></object>',
  '</config>'
].join('\n')

const CUT_INFORMATION_XML = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<objects>',
  ' <object id="3">',
  '  <cut_id id="2652" check_sum="2" connectors_cnt="4"/>',
  ' </object>',
  '</objects>'
].join('\n')

function source(): ThreeMfBakeSource {
  return {
    modelXml: MODEL_XML,
    modelSettingsXml: MODEL_SETTINGS_XML,
    projectSettingsJson: null,
    customGcodeXml: null,
    sliceInfoXml: null,
    modelRelsXml: null,
    subModelEntries: new Map(),
    hasBase: true
  }
}

/** Keeps `objectIds`, in the order given, on one plate. */
function editKeeping(objectIds: number[]): SceneEdit {
  return {
    plates: [{ index: 1 }],
    instances: objectIds.map((objectId) => ({
      objectId,
      plateIndex: 1,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 }
    }))
  } as unknown as SceneEdit
}

function cutInformationAfter(objectIds: number[]): string {
  const plan = planEditedThreeMf(source(), editKeeping(objectIds))
  const transform = plan.copy?.transforms.get('Metadata/cut_information.xml')
  assert.ok(transform, 'the bake installed no transform for cut_information.xml')
  return transform(CUT_INFORMATION_XML) ?? ''
}

test("deleting an earlier object moves the cut record to its object's new position", () => {
  // Object 2 goes; the cut belongs to object 3, which is now the second object on the plate.
  const out = cutInformationAfter([1, 3])
  assert.match(out, /<object id="2">/, 'the cut record kept its old ordinal and now names object 1')
  assert.match(out, /2652/, 'the cut record was lost entirely')
})

test('deleting the object a cut belongs to drops its record', () => {
  // Not renumbered onto object 3: that would give an unrelated model this one's connectors.
  const out = cutInformationAfter([1, 2])
  assert.doesNotMatch(out, /2652/)
})

test('deleting nothing leaves the sidecar byte for byte', () => {
  assert.equal(cutInformationAfter([1, 2, 3]), CUT_INFORMATION_XML)
})

// --- Authored height ranges vs the ordinal remap ------------------------------------------------

const LAYER_RANGES_XML = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<objects>',
  ' <object id="3">',
  '  <range min_z="0" max_z="2"><option opt_key="extruder">0</option><option opt_key="layer_height">0.2</option></range>',
  ' </object>',
  '</objects>'
].join('\n')

/** An edit that keeps all three objects AND authors height ranges on object 1. */
function editAuthoringRanges(): SceneEdit {
  return {
    ...editKeeping([1, 2, 3]),
    heightRanges: [{ objectId: 1, ranges: [{ minZ: 0, maxZ: 4, settings: { layer_height: '0.08' } }] }]
  } as unknown as SceneEdit
}

test('an AUTHORED height-range file wins over the ordinal remap', () => {
  // Regression: the remap loop runs after the authored transforms and writes into the same map, so
  // without the skip it silently overwrote the file we just authored — and would have remapped
  // ordinals that were already correct for the saved model.
  const plan = planEditedThreeMf(source(), editAuthoringRanges())
  const transform = plan.copy?.transforms.get('Metadata/layer_config_ranges.xml')
  assert.ok(transform, 'no transform installed for layer_config_ranges.xml')
  const out = transform(LAYER_RANGES_XML) ?? ''
  assert.match(out, /max_z="4"/, 'the authored range is missing: the remap clobbered it')
  assert.match(out, /layer_height">0\.08</, 'the authored layer height is missing')
  assert.doesNotMatch(out, /max_z="2"/, "the source file's range should have been replaced wholesale")
  assert.match(out, /<object id="1">/, 'the authored file addresses object 1 by its saved ordinal')
})

test('an UNTOUCHED height-range file is still ordinal-remapped', () => {
  // The skip must be conditional: a file nobody edited still has to follow its objects.
  const plan = planEditedThreeMf(source(), editKeeping([1, 3]))
  const transform = plan.copy?.transforms.get('Metadata/layer_config_ranges.xml')
  assert.ok(transform)
  const out = transform(LAYER_RANGES_XML) ?? ''
  assert.match(out, /<object id="2">/, 'object 3 moved to position 2 and its ranges should follow')
  assert.match(out, /max_z="2"/, 'the source range was lost')
})
