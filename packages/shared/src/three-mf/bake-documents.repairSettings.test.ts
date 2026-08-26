/**
 * `SceneEdit.repairSettings`: the staged, undoable repair the editor's Repair button sets, and the
 * ONLY repair path there is. A server-side repair route existed once and was removed deliberately:
 * repairs are explicit and user-driven, with no automatic rewriting behind the user's back. Riding
 * a save is what gives that its teeth, the result persists as a new library version, so the
 * pre-repair bytes stay restorable, and it works unchanged for hosts with no stored file behind
 * the project (the public editor). The bake applies the shared repair implementations, so a
 * repaired file cannot differ by which surface repaired it, and a healthy document rides through
 * untouched.
 *
 * Whether a repair STICKS across a save + reopen is pinned separately, in
 * `settings-repair-roundtrip.test.ts`, a repair that writes the fix and then has it regenerated
 * away by a later bake stage would pass every assertion here.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildEditedThreeMfDocuments,
  buildProjectSettingsTransforms,
  repairProjectSettingsDocument
} from './bake-documents.js'
import type { SceneEdit } from '../slicing.js'

const at = { x: 0, y: 0, z: 0 }

function editWith(overrides: Partial<SceneEdit>): SceneEdit {
  return { plates: [{ index: 1 }], instances: [], ...overrides } as SceneEdit
}

test('repairSettings fixes an undersized flush matrix and a stale inherits_group', () => {
  // The two field shapes: a dual-nozzle project whose matrix kept one block (exit-139 mid-slice),
  // and an inherits_group left at another filament count's width (exit-139 at load).
  const settings = JSON.stringify({
    filament_colour: ['#111111'],
    filament_settings_id: ['Bambu PLA Basic @BBL H2D'],
    nozzle_diameter: ['0.4', '0.4'],
    flush_volumes_matrix: ['0'],
    inherits_group: ['', '', '', '', '']
  })
  const transforms = buildProjectSettingsTransforms(editWith({ repairSettings: true }))
  assert.equal(transforms.length, 1, 'repairSettings alone must still produce a transform')
  const repaired = JSON.parse(transforms.reduce((json, transform) => transform(json), settings))
  assert.deepEqual(repaired.flush_volumes_matrix, ['0', '0'])
  assert.equal(repaired.inherits_group.length, 3)
})

test('repairSettings resizes a flush_multiplier the engine would reject', () => {
  // The exit-156 shape: matrix correct for the topology, but `flush_multiplier` (which the engine
  // uses as the heads count in its g-code-time size check) still one entry, with a consistent
  // `nozzle_volume_type` so the CLI's own recompute never fires to hide it.
  const settings = JSON.stringify({
    filament_colour: ['#000000', '#F4EE2A'],
    filament_settings_id: ['Bambu PLA Basic @BBL X2D', 'Bambu PLA Basic @BBL X2D'],
    nozzle_diameter: ['0.4', '0.4'],
    nozzle_volume_type: ['Standard', 'Standard'],
    flush_volumes_matrix: ['0', '632', '136', '0', '0', '632', '136', '0'],
    flush_multiplier: ['1'],
    // A one-entry fast multiplier is Studio-normal (fast purge mode only) and must ride through.
    flush_multiplier_fast: ['1.2'],
    inherits_group: ['', '', '', '']
  })
  const repaired = JSON.parse(repairProjectSettingsDocument(settings)) as Record<string, unknown>
  assert.deepEqual(repaired.flush_multiplier, ['1', '1'])
  assert.deepEqual(repaired.flush_multiplier_fast, ['1.2'])
  assert.deepEqual(repaired.flush_volumes_matrix, ['0', '632', '136', '0', '0', '632', '136', '0'])
})

test('a healthy document rides through the repair transform byte-identical', () => {
  const settings = JSON.stringify({
    filament_colour: ['#111111'],
    filament_settings_id: ['Bambu PLA Basic @BBL H2D'],
    nozzle_diameter: ['0.4'],
    flush_volumes_matrix: ['0'],
    inherits_group: ['', '', '']
  })
  assert.equal(repairProjectSettingsDocument(settings), settings)
})

const BASE_MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
  '  <metadata name="Application">BambuStudio-02.07.01.57</metadata>',
  '  <resources>',
  '   <object id="166" type="model">',
  '    <mesh>',
  '     <vertices>',
  '      <vertex x="0" y="0" z="0"/>',
  '      <vertex x="10" y="0" z="0"/>',
  '      <vertex x="0" y="10" z="0"/>',
  '     </vertices>',
  '     <triangles>',
  '      <triangle v1="0" v2="1" v3="2"/>',
  '     </triangles>',
  '    </mesh>',
  '   </object>',
  '  </resources>',
  '  <build>',
  '   <item objectid="166" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>',
  '  </build>',
  '</model>'
].join('\n')

const PART_ONLY_MODEL_SETTINGS = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<config>',
  '  <object id="166">',
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

test('repairSettings writes the missing object-level extruder while baking', () => {
  const edit = editWith({
    repairSettings: true,
    instances: [{ objectId: 166, plateIndex: 1, position: at, rotation: at, scale: { x: 1, y: 1, z: 1 } }]
  })
  const { modelSettingsXml } = buildEditedThreeMfDocuments(BASE_MODEL_XML, PART_ONLY_MODEL_SETTINGS, null, edit, [])
  // The CHM shape: the object head gains the entry the CLI slices by.
  assert.match(modelSettingsXml, /<metadata key="name" value="Track"\/>\n\s*<metadata key="extruder" value="2"\/>/)
})

test('without repairSettings the bake leaves a part-only object as it was', () => {
  // The flag is the user's explicit action, nothing heals at rest, saves included.
  const edit = editWith({
    instances: [{ objectId: 166, plateIndex: 1, position: at, rotation: at, scale: { x: 1, y: 1, z: 1 } }]
  })
  const { modelSettingsXml } = buildEditedThreeMfDocuments(BASE_MODEL_XML, PART_ONLY_MODEL_SETTINGS, null, edit, [])
  const head = modelSettingsXml.slice(0, modelSettingsXml.search(/<part\b/))
  assert.ok(!/key="extruder"/.test(head), 'no object-level extruder may appear without the flag')
})
