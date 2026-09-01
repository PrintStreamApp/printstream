/**
 * Object DISPLAY order, and the fact that it needs no id renumbering to be portable.
 *
 * BambuStudio builds its object list by walking `<build><item>` and creating one `ModelObject` the
 * first time an id appears (`bbs_3mf.cpp` `_create_object_instance`), so the item order IS the
 * displayed order. Verified against the real thing rather than inferred: a 137-object customer
 * project whose item order, `<object>` resource order and id order all differ was round-tripped
 * through the BambuStudio 2.7.1 CLI, and every object came back in the input's ITEM order.
 *
 * So the editor's sidebar order rides `SceneEdit.instances` and lands in the build section
 * unchanged. These pin that, plus the two things that would silently break it: the object ids must
 * not move (every id-keyed structure in the session and in the saved file addresses them), and
 * `<model_instance>` must be grouped the same way, because our own scene parser seeds the sidebar
 * from it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planEditedThreeMf, type ThreeMfBakeSource } from './bake.js'
import { parseRootModelObjectIdOrder } from './scene-parser.js'
import type { SceneEdit } from '../slicing.js'

const MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter">',
  ' <resources>',
  '  <object id="4" type="model"><mesh><vertices/><triangles/></mesh></object>',
  '  <object id="7" type="model"><mesh><vertices/><triangles/></mesh></object>',
  '  <object id="9" type="model"><mesh><vertices/><triangles/></mesh></object>',
  ' </resources>',
  ' <build><item objectid="4"/><item objectid="7"/><item objectid="9"/></build>',
  '</model>'
].join('\n')

const MODEL_SETTINGS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<config>',
  '  <object id="4"><metadata key="name" value="A"/></object>',
  '  <object id="7"><metadata key="name" value="B"/></object>',
  '  <object id="9"><metadata key="name" value="C"/></object>',
  '  <plate>',
  '    <metadata key="plater_id" value="1"/>',
  '    <model_instance><metadata key="object_id" value="4"/><metadata key="instance_id" value="0"/></model_instance>',
  '    <model_instance><metadata key="object_id" value="7"/><metadata key="instance_id" value="0"/></model_instance>',
  '    <model_instance><metadata key="object_id" value="9"/><metadata key="instance_id" value="0"/></model_instance>',
  '  </plate>',
  '</config>'
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

/** A scene edit placing `objectIds` on plate 1, in sidebar order. */
function editPlacing(objectIds: number[]): SceneEdit {
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

function bake(edit: SceneEdit): { modelXml: string; settingsXml: string } {
  const plan = planEditedThreeMf(source(), edit)
  return {
    modelXml: plan.copy?.transforms.get('3D/3dmodel.model')?.('') ?? '',
    settingsXml: plan.copy?.transforms.get('Metadata/model_settings.config')?.('') ?? ''
  }
}

/** Build-item objectids in document order, i.e. what BambuStudio will show. */
const itemOrder = (modelXml: string): number[] =>
  [...(/<build\b[^>]*>[\s\S]*?<\/build>/.exec(modelXml)?.[0] ?? '').matchAll(/<item\b[^>]*objectid="(\d+)"/g)]
    .map((match) => Number(match[1]))

/** `<model_instance>` object ids in document order, i.e. what OUR parser seeds the sidebar from. */
const modelInstanceOrder = (settingsXml: string): number[] =>
  [...settingsXml.matchAll(/<model_instance>[\s\S]*?key="object_id" value="(\d+)"/g)].map((match) => Number(match[1]))

test('the sidebar order reaches the build items, which is what BambuStudio displays', () => {
  const { modelXml } = bake(editPlacing([9, 4, 7]))
  assert.deepEqual(itemOrder(modelXml), [9, 4, 7])
  // And it is the ordinal space the positional sidecars resolve against, so a brim ear or a height
  // range written for "the first object" follows the drag.
  assert.deepEqual(parseRootModelObjectIdOrder(modelXml), [9, 4, 7])
})

test('reordering does NOT renumber object ids', () => {
  // The whole point. Every id-keyed structure in the live session (paint, per-part transforms and
  // types, per-object overrides, added parts, brim ears) and every id reference in the file address
  // these, and a renumber is what made per-object settings gears vanish after a save-then-reorder.
  const { modelXml, settingsXml } = bake(editPlacing([9, 4, 7]))
  assert.deepEqual([...modelXml.matchAll(/<object\b[^>]*\bid="(\d+)"/g)].map((match) => Number(match[1])), [4, 7, 9])
  assert.match(/<object id="4">[\s\S]*?<\/object>/.exec(settingsXml)?.[0] ?? '', /value="A"/)
  assert.match(/<object id="9">[\s\S]*?<\/object>/.exec(settingsXml)?.[0] ?? '', /value="C"/)
})

test('the build items and <model_instance> agree about which object comes first', () => {
  // They are written from one grouping for exactly this reason: BambuStudio reads the items and we
  // read the model_instances, so a disagreement is a file that reopens in a different order here
  // than it displays there, with nothing to indicate which is right.
  const { modelXml, settingsXml } = bake(editPlacing([7, 9, 4]))
  assert.deepEqual(itemOrder(modelXml), [7, 9, 4])
  assert.deepEqual(modelInstanceOrder(settingsXml), [7, 9, 4])
})

test('a linked copy keeps its object together in both documents', () => {
  // Two instances of object 4 with object 7 between them in the edit. An object is ONE entry in
  // BambuStudio's list, so the file cannot interleave them; writing the model_instances ungrouped
  // is what reopened a saved project with an object's copies split around another object.
  const edit = editPlacing([4, 7, 4])
  const { modelXml, settingsXml } = bake(edit)
  assert.deepEqual(itemOrder(modelXml), [4, 4, 7])
  assert.deepEqual(modelInstanceOrder(settingsXml), [4, 4, 7])
})

test('an unchanged order is written unchanged', () => {
  const { modelXml, settingsXml } = bake(editPlacing([4, 7, 9]))
  assert.deepEqual(itemOrder(modelXml), [4, 7, 9])
  assert.deepEqual(modelInstanceOrder(settingsXml), [4, 7, 9])
})
