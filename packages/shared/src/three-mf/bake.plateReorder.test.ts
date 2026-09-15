import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planEditedThreeMf, type ThreeMfBakeSource } from './bake.js'
import type { SceneEdit } from '../slicing.js'

/**
 * Plate-keyed records that live OUTSIDE the re-rendered `<plate>` blocks must follow a plate move.
 *
 * The plate blocks in `model_settings.config` are re-authored from the edit, so they cannot go
 * stale; every other plate-keyed document is copied through the save under the numbers it had when
 * the file was opened. `slice_info.config` was already covered (`plate-metadata.test.ts`); these
 * pin the two that were not, both of which misattribute silently rather than failing: layer pauses
 * and tool changes in `custom_gcode_per_layer.xml`, and the positional prime-tower corners in
 * `project_settings.config`.
 */

const BASE_MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter">',
  ' <resources>',
  '  <object id="1" type="model">',
  '   <mesh>',
  '    <vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/></vertices>',
  '    <triangles><triangle v1="0" v2="1" v3="2"/></triangles>',
  '   </mesh>',
  '  </object>',
  '  <object id="2" type="model">',
  '   <mesh>',
  '    <vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/></vertices>',
  '    <triangles><triangle v1="0" v2="1" v3="2"/></triangles>',
  '   </mesh>',
  '  </object>',
  ' </resources>',
  ' <build><item objectid="1"/><item objectid="2"/></build>',
  '</model>'
].join('\n')

const BASE_MODEL_SETTINGS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<config>',
  '  <object id="1"><metadata key="name" value="A"/></object>',
  '  <object id="2"><metadata key="name" value="B"/></object>',
  '  <plate>',
  '    <metadata key="plater_id" value="1"/>',
  '    <model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/></model_instance>',
  '  </plate>',
  '  <plate>',
  '    <metadata key="plater_id" value="2"/>',
  '    <model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/></model_instance>',
  '  </plate>',
  '</config>'
].join('\n')

/** Plate 1 pauses at 5 mm; plate 2 pauses at 9 mm and changes filament at 3 mm. */
const BASE_CUSTOM_GCODE_XML = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<custom_gcodes_per_layer>',
  '<plate>',
  '<plate_info id="1"/>',
  '<layer top_z="5" type="1" extruder="1" color="" extra="" gcode="M400 U1"/>',
  '<mode value="MultiAsSingle"/>',
  '</plate>',
  '<plate>',
  '<plate_info id="2"/>',
  '<layer top_z="3" type="2" extruder="2" color="#00FF00" extra="" gcode="tool_change"/>',
  '<layer top_z="9" type="1" extruder="1" color="" extra="" gcode="M400 U1"/>',
  '<mode value="MultiAsSingle"/>',
  '</plate>',
  '</custom_gcodes_per_layer>'
].join('\n')

const BASE_PROJECT_SETTINGS_JSON = JSON.stringify({
  wipe_tower_x: ['15', '80'],
  wipe_tower_y: ['220', '150']
})

function baseSource(): ThreeMfBakeSource {
  return {
    modelXml: BASE_MODEL_XML,
    modelSettingsXml: BASE_MODEL_SETTINGS_XML,
    projectSettingsJson: BASE_PROJECT_SETTINGS_JSON,
    customGcodeXml: BASE_CUSTOM_GCODE_XML,
    sliceInfoXml: null,
    modelRelsXml: null,
    subModelEntries: new Map(),
    hasBase: true
  }
}

function instance(objectId: number, plateIndex: number) {
  return {
    objectId,
    plateIndex,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 }
  }
}

/** The two plates swap places, and the session edited neither plate's layer G-code. */
function swappedEdit(): SceneEdit {
  return {
    plates: [{ index: 1, sourceIndex: 2 }, { index: 2, sourceIndex: 1 }],
    instances: [instance(2, 1), instance(1, 2)]
  } as unknown as SceneEdit
}

/** Same plates, same order: nothing may be rewritten. */
function unmovedEdit(): SceneEdit {
  return {
    plates: [{ index: 1, sourceIndex: 1 }, { index: 2, sourceIndex: 2 }],
    instances: [instance(1, 1), instance(2, 2)]
  } as unknown as SceneEdit
}

function customGcodeOutput(edit: SceneEdit): string | null | undefined {
  const plan = planEditedThreeMf(baseSource(), edit)
  return plan.copy?.transforms.get('Metadata/custom_gcode_per_layer.xml')?.(BASE_CUSTOM_GCODE_XML)
}

function plateBlock(xml: string, plateId: number): string {
  const match = new RegExp(`<plate>\\s*<plate_info id="${plateId}"/>([\\s\\S]*?)</plate>`).exec(xml)
  return match?.[1] ?? ''
}

test('a plate move carries layer pauses the session never edited onto the new plate number', () => {
  const out = customGcodeOutput(swappedEdit())
  assert.ok(out, 'the sidecar must be rewritten when the plates moved, edit or no edit')
  assert.match(plateBlock(out, 1), /top_z="9" type="1"/, 'saved plate 1 was source plate 2, so it pauses at 9mm')
  assert.match(plateBlock(out, 1), /top_z="3" type="2"/, 'its tool change moves with it')
  assert.match(plateBlock(out, 2), /top_z="5" type="1"/, 'saved plate 2 was source plate 1, so it pauses at 5mm')
  assert.doesNotMatch(plateBlock(out, 2), /type="2"/, 'source plate 1 had no tool change')
})

test('the bake uses the editor placement bed for a retargeted multi-plate grid', () => {
  const edit: SceneEdit = {
    plates: [{ index: 1, sourceIndex: 1 }, { index: 2, sourceIndex: 2 }],
    placementBedSize: { width: 350, depth: 320 },
    instances: [
      { ...instance(1, 1), position: { x: 175, y: 160, z: 0 } },
      { ...instance(2, 2), position: { x: 175, y: 160, z: 0 } }
    ]
  }
  const plan = planEditedThreeMf(baseSource(), edit)
  const rewrite = plan.copy?.transforms.get('3D/3dmodel.model')
  assert.ok(rewrite)
  const model = rewrite(BASE_MODEL_XML)
  assert.ok(model)

  const transforms = Array.from(model.matchAll(/<item\b[^>]*transform="([^"]+)"/g), (match) =>
    (match[1] ?? '').split(/\s+/).map(Number))
  assert.deepEqual(transforms.map((transform) => transform.slice(9, 11)), [
    [175, 160],
    // Two plates use two columns; the H2D stride is 350 * 1.2 = 420 mm.
    [595, 160]
  ])
})

test('an edited plate wins over the moved source content at the same number', () => {
  const edit = { ...swappedEdit(), pauses: [{ plateIndex: 1, pauses: [{ z: 12 }] }] } as unknown as SceneEdit
  const out = customGcodeOutput(edit)
  assert.ok(out)
  assert.match(plateBlock(out, 1), /top_z="12" type="1"/, 'the edit replaces the moved pauses')
  assert.doesNotMatch(plateBlock(out, 1), /top_z="9"/, 'the source plate 2 pause must not survive alongside it')
  assert.match(plateBlock(out, 1), /top_z="3" type="2"/, 'a pause edit still leaves the moved tool change alone')
  assert.match(plateBlock(out, 2), /top_z="5" type="1"/, 'the unedited plate still follows its move')
})

test('a deleted plate takes its layer G-code with it rather than handing it to its successor', () => {
  const edit = {
    plates: [{ index: 1, sourceIndex: 2 }],
    instances: [instance(2, 1)]
  } as unknown as SceneEdit
  const out = customGcodeOutput(edit)
  assert.ok(out)
  assert.match(plateBlock(out, 1), /top_z="9" type="1"/, 'the surviving plate keeps its own pause')
  assert.doesNotMatch(out, /top_z="5"/, "the removed plate's pause is gone, not renumbered onto plate 1")
})

test('plates that did not move leave the layer G-code sidecar untouched', () => {
  const plan = planEditedThreeMf(baseSource(), unmovedEdit())
  assert.equal(plan.copy?.transforms.has('Metadata/custom_gcode_per_layer.xml'), false,
    'no move and no edit means no rewrite of the source bytes')
})

test('a plate move permutes the positional prime-tower corners', () => {
  const plan = planEditedThreeMf(baseSource(), swappedEdit())
  const out = plan.copy?.transforms.get('Metadata/project_settings.config')?.(BASE_PROJECT_SETTINGS_JSON)
  assert.ok(out, 'project_settings must be rewritten when the plates moved')
  const parsed = JSON.parse(out) as { wipe_tower_x: string[]; wipe_tower_y: string[] }
  assert.deepEqual(parsed.wipe_tower_x, ['80', '15'], 'each corner follows its plate')
  assert.deepEqual(parsed.wipe_tower_y, ['150', '220'], 'each corner follows its plate')
})

test('plates that did not move leave the prime-tower corners alone', () => {
  const plan = planEditedThreeMf(baseSource(), unmovedEdit())
  const transform = plan.copy?.transforms.get('Metadata/project_settings.config')
  const out = transform ? transform(BASE_PROJECT_SETTINGS_JSON) : BASE_PROJECT_SETTINGS_JSON
  const parsed = JSON.parse(out ?? '{}') as { wipe_tower_x: string[]; wipe_tower_y: string[] }
  assert.deepEqual(parsed.wipe_tower_x, ['15', '80'])
  assert.deepEqual(parsed.wipe_tower_y, ['220', '150'])
})

test('deleting the final plate trims its stale prime-tower corner', () => {
  const source = baseSource()
  source.projectSettingsJson = JSON.stringify({
    wipe_tower_x: ['15', '80', '130'],
    wipe_tower_y: ['220', '150', '90']
  })
  const plan = planEditedThreeMf(source, unmovedEdit())
  const transform = plan.copy?.transforms.get('Metadata/project_settings.config')
  assert.ok(transform, 'an identity survivor map still needs plate-count conformance')
  const parsed = JSON.parse(transform(source.projectSettingsJson)) as {
    wipe_tower_x: string[]
    wipe_tower_y: string[]
  }
  assert.deepEqual(parsed.wipe_tower_x, ['15', '80'])
  assert.deepEqual(parsed.wipe_tower_y, ['220', '150'])
})

test('a new plate does not inherit the deleted plate that previously occupied its index', () => {
  const source = baseSource()
  source.projectSettingsJson = JSON.stringify({
    wipe_tower_x: ['15', '80', '130'],
    wipe_tower_y: ['220', '150', '90']
  })
  const edit = {
    plates: [{ index: 1, sourceIndex: 1 }, { index: 2, sourceIndex: 2 }, { index: 3, sourceIndex: null }],
    instances: [instance(1, 1), instance(2, 2)]
  } as unknown as SceneEdit
  const plan = planEditedThreeMf(source, edit)
  const transform = plan.copy?.transforms.get('Metadata/project_settings.config')
  assert.ok(transform)
  const parsed = JSON.parse(transform(source.projectSettingsJson)) as {
    wipe_tower_x: string[]
    wipe_tower_y: string[]
  }
  assert.deepEqual(parsed.wipe_tower_x, ['15', '80', '80'])
  assert.deepEqual(parsed.wipe_tower_y, ['220', '150', '150'])
})
