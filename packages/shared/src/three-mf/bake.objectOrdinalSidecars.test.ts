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
