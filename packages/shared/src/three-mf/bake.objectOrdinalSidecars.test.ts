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

function sourceFrom(modelXml: string, modelSettingsXml: string): ThreeMfBakeSource {
  return {
    modelXml,
    modelSettingsXml,
    projectSettingsJson: null,
    customGcodeXml: null,
    sliceInfoXml: null,
    modelRelsXml: null,
    subModelEntries: new Map(),
    hasBase: true
  }
}

const source = () => sourceFrom(MODEL_XML, MODEL_SETTINGS_XML)

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

// --- Authored cut information ---------------------------------------------------------------

/**
 * A cut's two halves as freshly staged imports, plus a connector volume on the second.
 *
 * Cut records are the one authored sidecar that MERGES with the base, because a project can already
 * carry groups made in BambuStudio for objects this session never touched.
 */
function editAuthoringCut(): SceneEdit {
  return {
    ...editKeeping([1, 2, 3]),
    instances: [
      ...editKeeping([1, 2, 3]).instances,
      { importId: 'upper', plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      { importId: 'lower', plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
    ],
    addedParts: [
      { importId: 'lower', meshImportId: 'peg', subtype: 'normal_part', name: 'Connector-1', matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] }
    ],
    cutGroups: [{
      importIds: ['upper', 'lower'],
      connectorCount: 2,
      connectors: [{
        importId: 'lower',
        meshImportId: 'peg',
        type: 'plug',
        radius: 1.25,
        height: 3,
        radiusTolerance: 0.1,
        heightTolerance: 0.1
      }]
    }]
  } as unknown as SceneEdit
}

/** Imports reach the bake as their own argument, not through the edit. */
const CUT_IMPORTS = ['upper', 'lower', 'peg'].map((importId) => ({
  importId,
  name: importId,
  mesh: {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } }
  }
}))

function bakedCutInformation(): string {
  const plan = planEditedThreeMf(source(), editAuthoringCut(), CUT_IMPORTS as never)
  const transform = plan.copy?.transforms.get('Metadata/cut_information.xml')
  assert.ok(transform, 'the bake installed no transform for cut_information.xml')
  return transform(CUT_INFORMATION_XML) ?? ''
}

test('an authored cut is written alongside the groups the base already had', () => {
  // The merge rule. Replacing the file wholesale, as the other authored sidecars do, would strip
  // cuts made in BambuStudio for objects this session never touched.
  const out = bakedCutInformation()
  assert.match(out, /id="2652"/, 'the inherited group was dropped')
  const cutIds = [...out.matchAll(/<cut_id id="(\d+)"/g)].map((match) => Number(match[1]))
  const ours = cutIds.filter((id) => id !== 2652)
  assert.equal(ours.length, 2, 'both halves of the new cut should be recorded')
  assert.equal(new Set(ours).size, 1, 'the halves must share one cut id')
  assert.ok(ours[0]! > 2652, 'a new cut id must not collide with an inherited one')
})

test('the authored halves are named by their BAKED build ordinals', () => {
  // The halves are imports with no object id until this save writes them, which is the whole reason
  // the record is keyed by importId and resolved here.
  const out = bakedCutInformation()
  // Three base objects come first, so the two halves are ordinals 4 and 5.
  assert.match(out, /<object id="4">/)
  assert.match(out, /<object id="5">/)
})

test('a connector is recorded against the volume the bake actually wrote', () => {
  const out = bakedCutInformation()
  assert.match(out, /<connector volume_id="\d+" type="0"/)
  assert.match(out, /r_tolerance="0\.1" h_tolerance="0\.1"/)
  // Only ONE volume exists; the other connector's hole was drilled away. The count still says two,
  // which is what keeps the two halves recognisable as one cut.
  assert.equal([...out.matchAll(/<connector\b/g)].length, 1)
  assert.match(out, /connectors_cnt="2"/)
})

test('a cut file left with nothing to say is DROPPED, never restored un-remapped', () => {
  // The serializer answers null when it can describe no group at all: here the base's only group
  // belonged to object 3, which this save deletes, and the session's own group names imports that
  // never reached the file. Falling back to the transform's INPUT wrote the base's original
  // ordinals straight back into the saved 3MF -- the exact stale-ordinal corruption the remap on
  // the same line exists to prevent, and it survived precisely because the remap had already
  // decided there was nothing left to keep.
  const edit = {
    ...editKeeping([1, 2]),
    cutGroups: [{ importIds: ['gone-a', 'gone-b'], connectorCount: 0, connectors: [] }]
  } as unknown as SceneEdit
  const plan = planEditedThreeMf(source(), edit)
  const transform = plan.copy?.transforms.get('Metadata/cut_information.xml')
  assert.ok(transform, 'the bake installed no transform for cut_information.xml')
  const out = transform(CUT_INFORMATION_XML)
  assert.notEqual(out, CUT_INFORMATION_XML, 'the un-remapped base content was written back')
  assert.equal(out, null, 'nothing describable left: the entry must be dropped')
})

test('a project with no base cut file still gets one when a cut is made', () => {
  const plan = planEditedThreeMf(source(), editAuthoringCut(), CUT_IMPORTS as never)
  const appended = plan.copy?.appendEntries.find((entry) => entry.name === 'Metadata/cut_information.xml')
  assert.ok(appended, 'a cut must be recorded even when the base carried no cut information')
  assert.match(appended.content, /<cut_id/)
})

/** One bake of {@link editAuthoringCut}, returning the three documents a following bake reads. */
function bakeCut(modelXml: string, modelSettingsXml: string, cutXml: string) {
  const copy = planEditedThreeMf(sourceFrom(modelXml, modelSettingsXml), editAuthoringCut(), CUT_IMPORTS as never).copy
  assert.ok(copy, 'the bake planned no copy pass')
  return {
    modelXml: copy.transforms.get('3D/3dmodel.model')!(modelXml)!,
    modelSettingsXml: copy.transforms.get('Metadata/model_settings.config')!(modelSettingsXml)!,
    cutXml: copy.transforms.get('Metadata/cut_information.xml')!(cutXml)
  }
}

test('re-baking one edit against its OWN previous output does not double a cut record', () => {
  // `serializeCutInformation` appends its groups to whatever the base carried, with no check that an
  // ordinal is already described, and this is the case that makes that safe rather than lucky. A
  // session keeps its halves IMPORT-backed after a save (nothing converts a placed instance's source
  // back to an object id), so every later save re-emits the same group: the editor's content-base pin
  // means a save normally never reads its own output, but the pin is optional on the wire and an
  // export or slice that omitted it would bake against the file's head.
  //
  // What holds it together is two rules one layer out, not the merge: the previously baked halves are
  // referenced by no instance, so they are swept and their inherited blocks are DROPPED by the
  // identity remap, and the re-imported halves take fresh object ids. A base block therefore always
  // names a surviving base object and an authored one always names a new object, so the two can never
  // want the same position in the build order. Break either rule and BambuStudio silently applies
  // whichever block for that object it reads last.
  const first = bakeCut(MODEL_XML, MODEL_SETTINGS_XML, CUT_INFORMATION_XML)
  const second = bakeCut(first.modelXml, first.modelSettingsXml, first.cutXml!)
  const ordinals = [...(second.cutXml ?? '').matchAll(/<object id="(\d+)">/g)].map((match) => match[1]!)
  assert.equal(new Set(ordinals).size, ordinals.length, `one object is described twice:\n${second.cutXml}`)
  assert.equal(second.cutXml, first.cutXml, 'the same edit baked twice must record the same cut')
})
