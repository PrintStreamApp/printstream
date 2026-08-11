import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planEditedThreeMf, type ThreeMfBakeSource } from './bake.js'
import { remapColorPaintInModelXml } from './triangle-paint-codec.js'
import type { SceneEdit } from '../slicing.js'

/**
 * A filament-slot PERMUTATION must re-key every base-file structure that speaks 1-based slot ids —
 * including content the session never touched, which otherwise streams through the save
 * byte-for-byte in the OLD order. Each test pins one such structure. The permutation used
 * throughout swaps a 3-material list end-to-end (old 1 -> new 3, old 2 -> new 2, old 3 -> new 1),
 * so `paint_color` leaf codes read: "4" = filament 1, "8" = filament 2, "0C" = filament 3.
 */

const BASE_MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
  ' <resources>',
  '  <object id="1" type="model">',
  '   <mesh>',
  '    <vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/></vertices>',
  '    <triangles><triangle v1="0" v2="1" v3="2" paint_color="4"/></triangles>',
  '   </mesh>',
  '  </object>',
  '  <object id="2" type="model">',
  '   <components><component p:path="/3D/Objects/object_2.model" objectid="2"/></components>',
  '  </object>',
  ' </resources>',
  ' <build><item objectid="1"/></build>',
  '</model>'
].join('\n')

const BASE_MODEL_SETTINGS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<config>',
  '  <object id="1">',
  '    <metadata key="name" value="Cube"/>',
  '    <metadata key="extruder" value="1"/>',
  '    <part id="1" subtype="normal_part">',
  '      <metadata key="extruder" value="3"/>',
  '      <metadata key="support_filament" value="3"/>',
  '    </part>',
  '  </object>',
  '</config>'
].join('\n')

const BASE_CUSTOM_GCODE_XML = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<custom_gcodes_per_layer>',
  '<plate>',
  '<plate_info id="1"/>',
  '<layer top_z="0.6" type="2" extruder="1" color="#FFFFFF" extra="" gcode="tool_change"/>',
  '<layer top_z="1.2" type="2" extruder="3" color="#000000" extra="" gcode="tool_change"/>',
  '<layer top_z="2" type="1" extruder="1" color="" extra="" gcode="M400 U1"/>',
  '<mode value="MultiAsSingle"/>',
  '</plate>',
  '</custom_gcodes_per_layer>'
].join('\n')

const BASE_SLICE_INFO_XML = [
  '<config>',
  '  <plate>',
  '    <metadata key="index" value="1"/>',
  '    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#FFFFFF" used_m="1.0" used_g="3.0"/>',
  '    <filament id="2" tray_info_idx="GFG00" type="PETG" color="#00FF00" used_m="1.0" used_g="3.0"/>',
  '    <filament id="3" tray_info_idx="GFB00" type="ABS" color="#0000FF" used_m="1.0" used_g="3.0"/>',
  '  </plate>',
  '</config>'
].join('\n')

function baseSource(): ThreeMfBakeSource {
  return {
    modelXml: BASE_MODEL_XML,
    modelSettingsXml: BASE_MODEL_SETTINGS_XML,
    projectSettingsJson: null,
    customGcodeXml: BASE_CUSTOM_GCODE_XML,
    sliceInfoXml: BASE_SLICE_INFO_XML,
    modelRelsXml: null,
    subModelEntries: new Map(),
    hasBase: true
  }
}

/** Reverses the 3-slot list: old slot 1 -> new 3, old 2 -> new 2, old 3 -> new 1. */
function reorderEdit(): SceneEdit {
  return {
    plates: [{ index: 1 }],
    instances: [
      { objectId: 1, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
    ],
    filaments: [
      { color: '#0000FF', sourceIndex: 2 },
      { color: '#00FF00', sourceIndex: 1 },
      { color: '#FFFFFF', sourceIndex: 0 }
    ]
  } as unknown as SceneEdit
}

/** The same slots in their original order — no re-key work may fire. */
function identityEdit(): SceneEdit {
  const edit = reorderEdit()
  return {
    ...edit,
    filaments: [
      { color: '#FFFFFF', sourceIndex: 0 },
      { color: '#00FF00', sourceIndex: 1 },
      { color: '#0000FF', sourceIndex: 2 }
    ]
  } as unknown as SceneEdit
}

test('a reorder re-keys colour paint in the root model entry', () => {
  const plan = planEditedThreeMf(baseSource(), reorderEdit())
  const rootXml = plan.copy?.transforms.get('3D/3dmodel.model')?.(BASE_MODEL_XML)
  // The inline mesh was painted filament 1 ("4"); after the swap that material is slot 3 ("0C").
  assert.ok(rootXml?.includes('paint_color="0C"'), `root paint must move with its material: ${rootXml}`)
  assert.ok(!rootXml?.includes('paint_color="4"'), 'the old code must not survive')
})

test('a reorder re-keys colour paint in sub-model entries no edit touched', () => {
  const plan = planEditedThreeMf(baseSource(), reorderEdit())
  const transform = plan.copy?.transforms.get('3D/Objects/object_2.model')
  assert.ok(transform, 'every referenced mesh entry must be visited on a permutation')
  const out = transform('<triangle paint_color="4"/><triangle paint_color="8"/><triangle paint_color="0C"/>')
  assert.equal(out, '<triangle paint_color="0C"/><triangle paint_color="8"/><triangle paint_color="4"/>')
})

test('an identity filament list leaves untouched mesh entries alone', () => {
  const plan = planEditedThreeMf(baseSource(), identityEdit())
  assert.equal(plan.copy?.transforms.has('3D/Objects/object_2.model'), false,
    'no permutation, no whole-archive rewrite')
})

test('a reorder re-keys part extruders and filament-index metadata in model_settings', () => {
  const plan = planEditedThreeMf(baseSource(), reorderEdit())
  const settingsXml = plan.copy?.transforms.get('Metadata/model_settings.config')?.(BASE_MODEL_SETTINGS_XML) ?? ''
  // Object on filament 1 -> slot 3; part on filament 3 -> slot 1; support painted from slot 3 -> 1.
  assert.match(settingsXml, /<object id="1">[\s\S]*?<metadata key="extruder" value="3"\/>/)
  assert.match(settingsXml, /<part\b[\s\S]*?<metadata key="extruder" value="1"\/>/)
  assert.match(settingsXml, /<metadata key="support_filament" value="1"\/>/)
})

test('a reorder re-keys tool changes on plates the session never edited', () => {
  const plan = planEditedThreeMf(baseSource(), reorderEdit())
  const transform = plan.copy?.transforms.get('Metadata/custom_gcode_per_layer.xml')
  assert.ok(transform, 'the sidecar must be rewritten even without a filament-change edit')
  const out = transform(BASE_CUSTOM_GCODE_XML) ?? ''
  assert.ok(out.includes('top_z="0.6" type="2" extruder="3"'), 'change to filament 1 now targets slot 3')
  assert.ok(out.includes('top_z="1.2" type="2" extruder="1"'), 'change to filament 3 now targets slot 1')
  // The pause layer's extruder attribute is a placeholder, not a material reference.
  assert.ok(out.includes('type="1" extruder="1"'), 'pauses are untouched')
})

test('a same-count reorder drops slice_info instead of carrying stale per-id records', () => {
  const plan = planEditedThreeMf(baseSource(), reorderEdit())
  const transform = plan.copy?.transforms.get('Metadata/slice_info.config')
  assert.ok(transform, 'slice_info must be addressed on a permutation')
  assert.equal(transform(BASE_SLICE_INFO_XML), null,
    'the record describes the OLD order (and the reader prefers its group ids) — the honest result is no record')
})

test('remapColorPaintInModelXml drops paint whose material was removed and keeps other channels', () => {
  const xml = '<triangle v1="0" v2="1" v3="2" paint_color="8" paint_supports="8"/>'
  // Only filament 1 survives (old slot 1 -> new 1); the paint on removed filament 2 empties out.
  const out = remapColorPaintInModelXml(xml, new Map([[1, 1]]))
  assert.equal(out, '<triangle v1="0" v2="1" v3="2" paint_supports="8"/>',
    'paint_color removed, support paint (same code, different channel) untouched')
})
