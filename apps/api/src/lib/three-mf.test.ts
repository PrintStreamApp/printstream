import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { PNG } from 'pngjs'
import yazl from 'yazl'
import { applyObjectProcessOverridesXml, buildPlateObjectsWithPreview, buildThreeMfIndex, createObjectCustomizedThreeMf, createObjectFilteredThreeMf, createSinglePlateThreeMf, plateObjectIdsFromModelSettingsXml, readEntry, readPlateIndex, readSceneManifest, rekeyReplacedObjectOverrides, setBuildItemsUnprintableXml, threeMfTransformFromTRS, writeArrangedThreeMf } from './three-mf.js'
import { plateSkipIdentifyIdsFromIndex } from './three-mf-output.js'
import { applyFilamentList, applyGlobalProcessOverrides, applyModelKindMarker, applyNozzleAssignmentToProjectSettings, applyPartProcessOverrides, applyPartTypeChanges, applyTrianglePaintToModelEntry, mergeCustomGcodePerLayer, rewriteSliceInfoNozzleGroups, serializeBrimEarPoints } from './three-mf-scene-builder.js'
import { rewriteThreeMfEntries } from './three-mf-internal.js'
import { parseBrimEarPoints, parseCustomGcodePauses, parseCustomGcodeToolChanges, parseModelSettingsScene } from './three-mf-reader.js'
import type { SceneEdit, SceneEditFilament } from '@printstream/shared'

const sliceInfoXml = `
<config>
  <plate>
    <metadata key="index" value="2"/>
    <metadata key="gcode_file" value="Metadata/plate_2.gcode"/>
    <metadata key="thumbnail_file" value="Metadata/plate_2.png"/>
    <metadata key="nozzle_diameters" value="0.4,0.6"/>
    <metadata key="printer_model_id" value="P2S"/>
    <filament id="1" type="PLA Basic" color="#112233" used_g="12.5" used_m="4.2" group_id="0" nozzle_diameter="0.4"/>
    <object identify_id="7" name="Bracket"/>
  </plate>
</config>
`.trim()

const projectSettingsJson = JSON.stringify({
  filament_colour: ['#112233'],
  filament_type: ['PLA-CF'],
  filament_settings_id: ['Bambu PLA Basic @BBL P1S'],
  chamber_temperatures: [45],
  curr_bed_type: 'Textured PEI Plate',
  printer_model: ['Bambu Lab P2S'],
  physical_extruder_map: ['0', '1'],
  extruder_nozzle_stats: ['tool#1', 'tool#0']
})

test('buildThreeMfIndex flags geometry-only 3MFs (no Bambu metadata) and only those', () => {
  // Vanilla mesh container: neither slice_info nor model_settings — the plate is fabricated.
  const vanilla = buildThreeMfIndex(null, null, new Map())
  assert.equal(vanilla.geometryOnly, true)
  assert.equal(vanilla.plates.length, 1)
  // Any model_settings plate (even the empty new-project scaffold's) marks a real project.
  const scaffold = buildThreeMfIndex(null, null, new Map([[1, 'Plate 1']]))
  assert.equal(scaffold.geometryOnly, false)
  // slice_info alone (a sliced gcode.3mf) is a project too.
  const sliced = buildThreeMfIndex('<config><plate><metadata key="index" value="1"/></plate></config>', null, new Map())
  assert.equal(sliced.geometryOnly, false)
})

test('single-object model exports round-trip the model-kind marker', () => {
  // The bake stamps project_settings; the index parser reads it back as `objectExport`.
  const stamped = applyModelKindMarker(JSON.stringify({ printer_settings_id: 'X' }))
  const index = buildThreeMfIndex(null, stamped, new Map([[1, 'Plate 1']]))
  assert.equal(index.objectExport, true)
  assert.equal(index.geometryOnly, false)
  // Ordinary projects (no marker) stay unflagged.
  assert.equal(buildThreeMfIndex(null, JSON.stringify({ printer_settings_id: 'X' }), new Map([[1, 'Plate 1']])).objectExport, false)
  // The marker never destroys existing settings keys.
  assert.equal((JSON.parse(stamped) as Record<string, unknown>).printer_settings_id, 'X')
})

test('buildThreeMfIndex distinguishes A1 mini from A1 (mini must not classify as A1)', () => {
  const miniSettings = JSON.stringify({ printer_model: ['Bambu Lab A1 mini'] })
  // "Bambu Lab A1 mini" contains " A1 ", which used to short-circuit to A1 — making the
  // slice dialog pair A1 filament profiles with the project's A1-mini machine profile.
  assert.deepEqual(buildThreeMfIndex(null, miniSettings, new Map()).compatiblePrinterModels, ['A1mini'])
  const a1Settings = JSON.stringify({ printer_model: ['Bambu Lab A1'] })
  assert.deepEqual(buildThreeMfIndex(null, a1Settings, new Map()).compatiblePrinterModels, ['A1'])
})

test('buildThreeMfIndex surfaces project support filament ids', () => {
  // White ABS (filament 3) is the support material: set as the interface support filament and
  // flagged `filament_is_support`. `support_filament: '0'` is the "use default" sentinel and must
  // be ignored. The remove-guard relies on these so a support-only material is not droppable.
  const settings = JSON.stringify({
    support_filament: '0',
    support_interface_filament: '3',
    filament_is_support: ['0', '0', '1', '0'],
    enable_support: '1'
  })
  assert.deepEqual(buildThreeMfIndex(null, settings, new Map()).supportFilamentIds, [3])
  // Nothing designated as support -> empty.
  assert.deepEqual(buildThreeMfIndex(null, JSON.stringify({ support_filament: '0' }), new Map()).supportFilamentIds, [])
})

test('buildThreeMfIndex backfills unsliced plate nozzle sizes from project settings', () => {
  // No slice_info: plates come from project metadata only, so nozzle chips must fall
  // back to the project's configured nozzle_diameter list.
  const settings = JSON.stringify({ printer_model: ['Bambu Lab P1S'], nozzle_diameter: ['0.4'], curr_bed_type: 'Textured PEI Plate' })
  const index = buildThreeMfIndex(null, settings, new Map())
  assert.deepEqual(index.plates[0]?.nozzleSizes, ['0.4'])
  assert.equal(index.plates[0]?.plateType, 'Textured PEI Plate')
})

test('buildThreeMfIndex merges slice-info and project settings metadata', () => {
  const index = buildThreeMfIndex(sliceInfoXml, projectSettingsJson, new Map([[2, 'Plate Two']]))

  assert.deepEqual(index.compatiblePrinterModels, ['P2S'])
  assert.equal(index.projectFilaments[0]?.filamentName, 'Bambu PLA Basic')
  assert.equal(index.projectFilaments[0]?.nozzleId, 1)
  assert.equal(index.projectFilaments[0]?.chamberTemperature, 45)
  assert.equal(index.plates[0]?.name, 'Plate Two')
  assert.equal(index.plates[0]?.plateType, 'Textured PEI Plate')
  assert.deepEqual(index.plates[0]?.nozzleSizes, ['0.4', '0.6'])
  assert.equal(index.plates[0]?.filaments[0]?.nozzleId, 1)
  assert.equal(index.plates[0]?.filaments[0]?.chamberTemperature, 45)
  // slice_info objects are keyed by identify_id, so the entry's own id doubles as its
  // firmware skip handle.
  assert.deepEqual(index.plates[0]?.objects[0], { id: 7, name: 'Bracket', identifyIds: [7] })
})

test('buildThreeMfIndex decodes XML entities in plate and object names', () => {
  const entitySliceInfoXml = `
<config>
  <plate>
    <metadata key="index" value="4"/>
    <metadata key="plater_name" value="Women&apos;s Cover"/>
    <object identify_id="9" name="Kid&apos;s &amp; Parent&apos;s Part"/>
  </plate>
</config>
`.trim()

  const index = buildThreeMfIndex(entitySliceInfoXml, null)

  assert.equal(index.plates[0]?.name, 'Women\'s Cover')
  assert.equal(index.plates[0]?.objects[0]?.name, 'Kid\'s & Parent\'s Part')
})

test('buildThreeMfIndex prefers model_settings object_id over slice_info identify_id for plate objects', () => {
  // Real-world failure mode (imported assembly 3MF): slice_info lists the object by its
  // `identify_id` (48216) while the model/scene/slice writer all use the model `object_id`
  // (71). Plate objects must use object_id so the per-object print toggle, partial-slice
  // selection, and per-object overrides line up with the scene instances.
  const sliceInfoXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    '  <plate>',
    '    <metadata key="index" value="1"/>',
    '    <object identify_id="48216" name="My Sign Draft.3mf" skipped="false" />',
    '  </plate>',
    '</config>'
  ].join('\n')
  const modelSettingsPlates = [
    { index: 1, name: null, thumbnailFile: null, usedFilamentIds: [], objects: [{ id: 71, name: 'My Sign Draft.3mf', identifyIds: [48216] }] }
  ]

  const index = buildThreeMfIndex(sliceInfoXml, null, modelSettingsPlates, new Map())

  assert.deepEqual(index.plates.find((plate) => plate.index === 1)?.objects, [{ id: 71, name: 'My Sign Draft.3mf', identifyIds: [48216] }])
})

test('buildThreeMfIndex parses string chamber temperatures from project settings', () => {
  const index = buildThreeMfIndex(sliceInfoXml, JSON.stringify({
    filament_colour: ['#112233'],
    filament_type: ['ABS'],
    filament_settings_id: ['Bambu ABS @BBL H2D'],
    chamber_temperatures: ['65']
  }))

  assert.equal(index.projectFilaments[0]?.chamberTemperature, 65)
  assert.equal(index.plates[0]?.filaments[0]?.chamberTemperature, 65)
})

test('buildThreeMfIndex prefers filament_nozzle_map when non-identity physical mapping conflicts with slice_info group ids', () => {
  const index = buildThreeMfIndex(`
<config>
  <plate>
    <metadata key="index" value="1"/>
    <filament id="1" type="ABS" color="#FFC72C" group_id="1"/>
    <filament id="2" type="ABS" color="#000000" group_id="0"/>
  </plate>
</config>
`.trim(), JSON.stringify({
    filament_colour: ['#FFC72C', '#000000'],
    filament_type: ['ABS', 'ABS'],
    filament_settings_id: ['ABS Left', 'ABS Right'],
    physical_extruder_map: ['1', '0'],
    filament_nozzle_map: ['0', '1'],
    extruder_nozzle_stats: ['tool#1', 'tool#1']
  }))

  assert.equal(index.projectFilaments[0]?.nozzleId, 1)
  assert.equal(index.projectFilaments[1]?.nozzleId, 0)
  assert.equal(index.plates[0]?.filaments[0]?.nozzleId, 1)
  assert.equal(index.plates[0]?.filaments[1]?.nozzleId, 0)
})

test('buildThreeMfIndex treats filament_nozzle_map as final nozzle ids when slice_info has no filament assignments', () => {
  const index = buildThreeMfIndex('<config><header /></config>', JSON.stringify({
    filament_colour: ['#FFC72C', '#789D4A', '#FFFFFF'],
    filament_type: ['ABS', 'ABS', 'ABS'],
    filament_settings_id: ['Bambu ABS', 'Bambu ABS', 'Bambu Support for ABS'],
    physical_extruder_map: ['1', '0'],
    filament_nozzle_map: ['1', '0', '0'],
    extruder_nozzle_stats: ['Standard#1', 'Standard#1']
  }))

  assert.equal(index.projectFilaments[0]?.nozzleId, 1)
  assert.equal(index.projectFilaments[1]?.nozzleId, 0)
  assert.equal(index.projectFilaments[2]?.nozzleId, 0)
})

test('buildThreeMfIndex prefers concrete slice_info filament usage over conflicting filament_nozzle_map', () => {
  const index = buildThreeMfIndex(`
<config>
  <plate>
    <metadata key="index" value="1"/>
    <filament id="1" tray_info_idx="GFB00" type="ABS" color="#FFC72C" used_m="50.12" used_g="125.38" group_id="0" nozzle_diameter="0.40" volume_type="Standard" used_for_object="true" used_for_support="false"/>
    <filament id="2" tray_info_idx="GFB00" type="ABS" color="#789D4A" used_m="0.37" used_g="0.92" group_id="1" nozzle_diameter="0.40" volume_type="Standard" used_for_object="true" used_for_support="false"/>
    <filament id="3" tray_info_idx="GFS06" type="ABS-S" color="#FFFFFF" used_m="2.10" used_g="5.86" group_id="1" nozzle_diameter="0.40" volume_type="Standard" used_for_object="false" used_for_support="true"/>
  </plate>
</config>
`.trim(), JSON.stringify({
    filament_colour: ['#FFC72C', '#789D4A', '#FFFFFF'],
    filament_type: ['ABS', 'ABS', 'ABS'],
    filament_settings_id: ['Bambu ABS', 'Bambu ABS', 'Bambu Support for ABS'],
    physical_extruder_map: ['1', '0'],
    filament_nozzle_map: ['1', '0', '0'],
    extruder_nozzle_stats: ['Standard#1', 'Standard#1']
  }))

  assert.equal(index.projectFilaments[0]?.nozzleId, 1)
  assert.equal(index.projectFilaments[1]?.nozzleId, 0)
  assert.equal(index.projectFilaments[2]?.nozzleId, 0)
  assert.equal(index.plates[0]?.filaments[0]?.nozzleId, 1)
  assert.equal(index.plates[0]?.filaments[1]?.nozzleId, 0)
  assert.equal(index.plates[0]?.filaments[2]?.nozzleId, 0)
})

// The editor-save nozzle-persistence path: applyNozzleAssignmentToProjectSettings +
// rewriteSliceInfoNozzleGroups must be the exact inverse of extractNozzleMapping so a nozzle
// pick round-trips back through buildThreeMfIndex. Written as read->write->read to lock the
// mirror; the H2D map (`["1","0"]`) is deliberately non-identity so a stray second inversion
// would surface here.
const H2D_PHYSICAL_EXTRUDER_MAP = ['1', '0']

test('nozzle assignment round-trips a left<->right swap through the index parser (sliced project)', () => {
  const sliceInfo = `
<config>
  <plate>
    <metadata key="index" value="1"/>
    <filament id="1" tray_info_idx="GFB00" type="ABS" color="#FFC72C" used_m="50" used_g="125" group_id="0" nozzle_diameter="0.40" volume_type="Standard" used_for_object="true"/>
    <filament id="2" tray_info_idx="GFB00" type="ABS" color="#000000" used_m="20" used_g="40" group_id="1" nozzle_diameter="0.40" volume_type="Standard" used_for_object="true"/>
  </plate>
</config>
`.trim()
  const projectSettings = JSON.stringify({
    filament_colour: ['#FFC72C', '#000000'],
    filament_type: ['ABS', 'ABS'],
    filament_settings_id: ['ABS Left', 'ABS Right'],
    physical_extruder_map: H2D_PHYSICAL_EXTRUDER_MAP,
    filament_nozzle_map: ['1', '0'],
    extruder_nozzle_stats: ['Standard#1', 'Standard#1']
  })
  const before = buildThreeMfIndex(sliceInfo, projectSettings)
  assert.equal(before.projectFilaments[0]?.nozzleId, 1) // material 1 on the left nozzle
  assert.equal(before.projectFilaments[1]?.nozzleId, 0) // material 2 on the right nozzle

  const filaments: SceneEditFilament[] = [
    { color: '#FFC72C', sourceIndex: 0, nozzleId: 0 }, // move material 1 to the right nozzle
    { color: '#000000', sourceIndex: 1, nozzleId: 1 }  // move material 2 to the left nozzle
  ]
  const nextProjectSettings = applyNozzleAssignmentToProjectSettings(projectSettings, filaments)
  const nextSliceInfo = rewriteSliceInfoNozzleGroups(sliceInfo, filaments, H2D_PHYSICAL_EXTRUDER_MAP)

  const after = buildThreeMfIndex(nextSliceInfo, nextProjectSettings)
  assert.equal(after.projectFilaments[0]?.nozzleId, 0)
  assert.equal(after.projectFilaments[1]?.nozzleId, 1)
  assert.equal(after.plates[0]?.filaments[0]?.nozzleId, 0)
  assert.equal(after.plates[0]?.filaments[1]?.nozzleId, 1)
})

test('nozzle assignment round-trips with no slice_info filament assignments (verbatim filament_nozzle_map)', () => {
  const projectSettings = JSON.stringify({
    filament_colour: ['#FFC72C', '#000000'],
    filament_type: ['ABS', 'ABS'],
    filament_settings_id: ['ABS Left', 'ABS Right'],
    physical_extruder_map: H2D_PHYSICAL_EXTRUDER_MAP,
    filament_nozzle_map: ['1', '0'],
    extruder_nozzle_stats: ['Standard#1', 'Standard#1']
  })
  const filaments: SceneEditFilament[] = [
    { color: '#FFC72C', sourceIndex: 0, nozzleId: 0 },
    { color: '#000000', sourceIndex: 1, nozzleId: 1 }
  ]
  const next = applyNozzleAssignmentToProjectSettings(projectSettings, filaments)
  const index = buildThreeMfIndex('<config><header /></config>', next)
  assert.equal(index.projectFilaments[0]?.nozzleId, 0)
  assert.equal(index.projectFilaments[1]?.nozzleId, 1)
})

test('nozzle assignment clears a stale single-active short-circuit so a move to the other nozzle persists', () => {
  // A project sliced with BOTH materials on the left nozzle: extruder_nozzle_stats marks only the
  // left extruder active, which short-circuits every filament onto that nozzle on read — this is
  // the "saves left no matter what" state before the fix.
  const sliceInfo = `
<config>
  <plate>
    <metadata key="index" value="1"/>
    <filament id="1" tray_info_idx="GFB00" type="ABS" color="#FFC72C" used_m="50" used_g="125" group_id="0" nozzle_diameter="0.40" volume_type="Standard" used_for_object="true"/>
    <filament id="2" tray_info_idx="GFB00" type="ABS" color="#000000" used_m="20" used_g="40" group_id="0" nozzle_diameter="0.40" volume_type="Standard" used_for_object="true"/>
  </plate>
</config>
`.trim()
  const projectSettings = JSON.stringify({
    filament_colour: ['#FFC72C', '#000000'],
    filament_type: ['ABS', 'ABS'],
    filament_settings_id: ['ABS Left', 'ABS Left'],
    physical_extruder_map: H2D_PHYSICAL_EXTRUDER_MAP,
    filament_nozzle_map: ['1', '1'],
    extruder_nozzle_stats: ['Standard#2', 'Standard#0'] // only the left extruder reads active
  })
  const before = buildThreeMfIndex(sliceInfo, projectSettings)
  assert.equal(before.projectFilaments[0]?.nozzleId, 1)
  assert.equal(before.projectFilaments[1]?.nozzleId, 1)

  const filaments: SceneEditFilament[] = [
    { color: '#FFC72C', sourceIndex: 0, nozzleId: 0 }, // move material 1 to the right nozzle
    { color: '#000000', sourceIndex: 1, nozzleId: 1 }  // material 2 stays left
  ]
  const nextProjectSettings = applyNozzleAssignmentToProjectSettings(projectSettings, filaments)
  const nextSliceInfo = rewriteSliceInfoNozzleGroups(sliceInfo, filaments, H2D_PHYSICAL_EXTRUDER_MAP)

  const after = buildThreeMfIndex(nextSliceInfo, nextProjectSettings)
  assert.equal(after.projectFilaments[0]?.nozzleId, 0)
  assert.equal(after.projectFilaments[1]?.nozzleId, 1)
})

test('nozzle assignment is a no-op on single-nozzle projects', () => {
  const projectSettings = JSON.stringify({
    filament_colour: ['#FFC72C'],
    filament_type: ['PLA'],
    filament_settings_id: ['PLA'],
    physical_extruder_map: ['0']
  })
  const filaments: SceneEditFilament[] = [{ color: '#FFC72C', sourceIndex: 0, nozzleId: 0 }]
  assert.equal(applyNozzleAssignmentToProjectSettings(projectSettings, filaments), projectSettings)
})

// The editor-save global-process-override path: applyGlobalProcessOverrides merges the editor's
// global process edits into project_settings.config so they persist into the saved project.
test('applyGlobalProcessOverrides merges scalar and vector overrides verbatim, preserving other keys', () => {
  const projectSettings = JSON.stringify({
    layer_height: '0.2',
    sparse_infill_density: '15%',
    line_width: ['0.42', '0.42'],
    printer_model: ['Bambu Lab P1S']
  })
  const merged = JSON.parse(applyGlobalProcessOverrides(projectSettings, {
    layer_height: '0.28',
    line_width: ['0.5', '0.5'],
    wall_loops: '3'
  })) as Record<string, unknown>
  assert.equal(merged.layer_height, '0.28') // overwritten scalar
  assert.deepEqual(merged.line_width, ['0.5', '0.5']) // overwritten vector
  assert.equal(merged.wall_loops, '3') // added key
  assert.equal(merged.sparse_infill_density, '15%') // untouched
  assert.deepEqual(merged.printer_model, ['Bambu Lab P1S']) // untouched
})

test('applyGlobalProcessOverrides is a no-op on unparseable project settings', () => {
  assert.equal(applyGlobalProcessOverrides('not json', { layer_height: '0.3' }), 'not json')
})

// The material-leak fix: changing a slot's material (e.g. ABS -> PETG) must NOT carry the old
// material's cloned per-filament physics into the new material's slot. applyFilamentList drops
// every non-identity filament array (incl. the nozzle_temperature completeness sentinel) so the
// slicer re-derives physics from the new preset name. See three-mf-scene-builder.ts.
test('applyFilamentList drops the old material physics when a slot changes material, keeping identity', () => {
  const projectSettings = JSON.stringify({
    filament_colour: ['#FFC72C', '#000000'],
    filament_type: ['ABS', 'ABS'],
    filament_settings_id: ['Bambu ABS @BBL P1S', 'Bambu ABS @BBL P1S'],
    filament_nozzle_map: ['0', '0'],
    chamber_temperatures: ['60', '60'],
    nozzle_temperature: ['270', '270'],
    hot_plate_temp: ['100', '100'],
    textured_plate_temp: ['100', '100']
  })
  // Slot 0 ABS -> PETG, slot 1 ABS -> PLA (both keep their source index).
  const filaments: SceneEditFilament[] = [
    { color: '#00AE42', sourceIndex: 0, type: 'PETG', settingsId: 'Bambu PETG Basic @BBL P1S' },
    { color: '#FFFFFF', sourceIndex: 1, type: 'PLA', settingsId: 'Bambu PLA Basic @BBL P1S' }
  ]
  const next = JSON.parse(applyFilamentList(projectSettings, filaments)) as Record<string, unknown>

  // Identity/structure is preserved and updated to the new materials…
  assert.deepEqual(next.filament_type, ['PETG', 'PLA'])
  assert.deepEqual(next.filament_settings_id, ['Bambu PETG Basic @BBL P1S', 'Bambu PLA Basic @BBL P1S'])
  assert.deepEqual(next.filament_colour, ['#00AE42', '#FFFFFF'])
  assert.deepEqual(next.filament_nozzle_map, ['0', '0'])
  // …but the ABS physics is GONE (removing nozzle_temperature also makes the config incomplete,
  // which triggers the slicer's re-derivation from the new preset names at slice time).
  assert.equal('chamber_temperatures' in next, false)
  assert.equal('nozzle_temperature' in next, false)
  assert.equal('hot_plate_temp' in next, false)
  assert.equal('textured_plate_temp' in next, false)
})

test('applyFilamentList blanks a changed slot\'s different_settings_to_system record, keeping process/machine and unchanged slots', () => {
  // The material dialog treats a slot's different_settings_to_system entry as the authoritative
  // "changed within this 3MF" signal — a record inherited from the OLD material would flag keys
  // the new material never touched. Layout: [process, ...filament slots, machine].
  const projectSettings = JSON.stringify({
    filament_colour: ['#FFC72C', '#000000'],
    filament_type: ['ABS', 'ABS'],
    filament_settings_id: ['Bambu ABS @BBL P1S', 'Bambu ABS @BBL P1S'],
    different_settings_to_system: ['layer_height', 'nozzle_temperature;filament_flow_ratio', 'fan_min_speed', 'printable_area']
  })
  // Slot 0 ABS -> PETG (record blanked); slot 1 keeps ABS (record kept).
  const filaments: SceneEditFilament[] = [
    { color: '#00AE42', sourceIndex: 0, type: 'PETG', settingsId: 'Bambu PETG Basic @BBL P1S' },
    { color: '#000000', sourceIndex: 1, type: 'ABS', settingsId: 'Bambu ABS @BBL P1S' }
  ]
  const next = JSON.parse(applyFilamentList(projectSettings, filaments)) as Record<string, unknown>
  assert.deepEqual(next.different_settings_to_system, ['layer_height', '', 'fan_min_speed', 'printable_area'])
})

test('applyFilamentList keeps physics (full clone) when only colour changes, no material change', () => {
  const projectSettings = JSON.stringify({
    filament_colour: ['#FFC72C', '#000000'],
    filament_type: ['ABS', 'ABS'],
    filament_settings_id: ['Bambu ABS @BBL P1S', 'Bambu ABS @BBL P1S'],
    chamber_temperatures: ['60', '60'],
    nozzle_temperature: ['270', '270']
  })
  // Same type + settingsId as source, only the colours change -> not a material change.
  const filaments: SceneEditFilament[] = [
    { color: '#123456', sourceIndex: 0, type: 'ABS', settingsId: 'Bambu ABS @BBL P1S' },
    { color: '#654321', sourceIndex: 1, type: 'ABS', settingsId: 'Bambu ABS @BBL P1S' }
  ]
  const next = JSON.parse(applyFilamentList(projectSettings, filaments)) as Record<string, unknown>

  assert.deepEqual(next.filament_colour, ['#123456', '#654321'])
  // Physics is retained (cloned) because the material did not change — the config stays complete.
  assert.deepEqual(next.chamber_temperatures, ['60', '60'])
  assert.deepEqual(next.nozzle_temperature, ['270', '270'])
})

test('buildPlateObjectsWithPreview derives first-layer previews from gcode comments', () => {
  const index = buildThreeMfIndex(sliceInfoXml, projectSettingsJson)
  const gcode = Buffer.from([
    '; object ids of layer 1 start:',
    '; start printing object, unique label id: 7',
    '; FEATURE: Outer wall',
    'G90',
    'M82',
    'G1 X0 Y0 Z0.2 E0',
    'G1 X10 Y0 E1',
    'G1 X10 Y10 E2',
    'G1 X0 Y10 E3',
    'G1 X0 Y0 E4',
    '; Z_HEIGHT: 0.4'
  ].join('\n'), 'utf8')

  const objects = buildPlateObjectsWithPreview(index, 2, gcode)

  assert.equal(objects.length, 1)
  assert.equal(objects[0]?.id, 7)
  assert.equal(objects[0]?.previewBounds?.minX, 0)
  assert.equal(objects[0]?.previewBounds?.maxY, 10)
  assert.match(objects[0]?.previewPath ?? '', /^M 0 0 L 10 0/)
  assert.match(objects[0]?.previewPath ?? '', /Z$/)
})

test('buildPlateObjectsWithPreview derives previews when first layer starts at Z_HEIGHT before the object id marker', () => {
  const index = buildThreeMfIndex(sliceInfoXml, projectSettingsJson)
  const gcode = Buffer.from([
    '; Z_HEIGHT: 0.2',
    '; start printing object, unique label id: 7',
    '; FEATURE: Outer wall',
    'G90',
    'M82',
    'G1 X0 Y0 Z0.2 E0',
    'G1 X8 Y0 E1',
    'G1 X8 Y8 E2',
    'G1 X0 Y8 E3',
    'G1 X0 Y0 E4',
    '; object ids of layer 1 start: 7',
    '; Z_HEIGHT: 0.44',
    '; start printing object, unique label id: 7',
    '; FEATURE: Outer wall',
    'G1 X1 Y1 E5'
  ].join('\n'), 'utf8')

  const objects = buildPlateObjectsWithPreview(index, 2, gcode)

  assert.equal(objects.length, 1)
  assert.equal(objects[0]?.id, 7)
  assert.equal(objects[0]?.previewBounds?.minX, 0)
  assert.equal(objects[0]?.previewBounds?.maxY, 8)
  assert.match(objects[0]?.previewPath ?? '', /^M 0 0 L 8 0/)
  assert.match(objects[0]?.previewPath ?? '', /Z$/)
})

test('buildPlateObjectsWithPreview prefers embedded pick masks over G-code-derived previews', () => {
  const index = buildThreeMfIndex(sliceInfoXml, projectSettingsJson)
  const gcode = Buffer.from([
    '; object ids of layer 1 start:',
    '; start printing object, unique label id: 7',
    '; FEATURE: Outer wall',
    'G90',
    'M82',
    'G1 X0 Y0 Z0.2 E0',
    'G1 X10 Y0 E1',
    'G1 X10 Y10 E2',
    'G1 X0 Y10 E3',
    'G1 X0 Y0 E4',
    '; Z_HEIGHT: 0.4'
  ].join('\n'), 'utf8')
  const pickMask = createPickMaskPng(4, 4, [
    { x: 1, y: 0, width: 2, height: 3, objectId: 7 }
  ])

  const objects = buildPlateObjectsWithPreview(index, 2, gcode, pickMask)

  assert.equal(objects.length, 1)
  assert.equal(objects[0]?.previewBounds?.minX, 1)
  assert.equal(objects[0]?.previewBounds?.maxX, 3)
  assert.equal(objects[0]?.previewBounds?.minY, 1)
  assert.equal(objects[0]?.previewBounds?.maxY, 4)
  assert.match(objects[0]?.previewPath ?? '', /^M 1 1 L 3 1 L 3 4 L 1 4 L 1 1 Z$/)
})

test('buildThreeMfIndex parses multiple compatible printer models from serialized project settings', () => {
  const multiModelProjectSettingsJson = JSON.stringify({
    printer_settings_id: 'Bambu Lab P1S 0.4 nozzle; Bambu Lab P1P 0.4 nozzle',
    compatible_printers: 'Bambu Lab X1 Carbon; Bambu Lab P1S'
  })

  const index = buildThreeMfIndex(sliceInfoXml, multiModelProjectSettingsJson)

  assert.deepEqual([...index.compatiblePrinterModels].sort(), ['P1P', 'P1S', 'P2S', 'X1C'])
})

test('buildThreeMfIndex reads exported print-profile compatibility lists', () => {
  const exportedCompatibilityJson = JSON.stringify({
    printer_settings_id: 'Bambu Lab X1 Carbon 0.4 nozzle',
    print_compatible_printers: [
      'Bambu Lab X1 Carbon 0.4 nozzle',
      'Bambu Lab X1E 0.4 nozzle',
      'Bambu Lab P1S 0.4 nozzle'
    ]
  })

  const index = buildThreeMfIndex(null, exportedCompatibilityJson)

  assert.deepEqual([...index.compatiblePrinterModels].sort(), ['P1S', 'X1C', 'X1E'])
})

test('buildThreeMfIndex parses bracketed model serializations', () => {
  const bracketedModelsJson = JSON.stringify({
    models: '[Bambu Lab X1 Carbon++0.4][Bambu Lab P1S++0.4][Bambu Lab X1E++0.4]'
  })

  const index = buildThreeMfIndex(null, bracketedModelsJson)

  assert.deepEqual([...index.compatiblePrinterModels].sort(), ['P1S', 'X1C', 'X1E'])
})

test('readPlateIndex falls back to embedded plate thumbnails when slice-info is missing', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-thumbnail-plates-'))
  const sourcePath = path.join(tempDir, 'source.3mf')

  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/plate_1.png', Buffer.from('plate-one-preview')],
      ['Metadata/plate_2_small.png', Buffer.from('ignored-small-preview')],
      ['Metadata/plate_3.png', Buffer.from('plate-three-preview')]
    ])

    const index = await readPlateIndex(sourcePath)

    assert.deepEqual(index.plates.map((plate) => plate.index), [1, 3])
    assert.equal(index.plates[1]?.thumbnailFile, 'Metadata/plate_3.png')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readPlateIndex falls back to model-settings plates and default print profile when slice-info is missing', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-model-settings-'))
  const sourcePath = path.join(tempDir, 'source.3mf')

  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/model_settings.config', Buffer.from([
        '<config>',
        '  <plate>',
        '    <metadata key="plater_id" value="1"/>',
        '    <metadata key="plater_name" value="Front Plate"/>',
        '    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>',
        '  </plate>',
        '  <plate>',
        '    <metadata key="plater_id" value="2"/>',
        '    <metadata key="plater_name" value="Rear Plate"/>',
        '    <metadata key="thumbnail_file" value="Metadata/plate_2.png"/>',
        '  </plate>',
        '</config>'
      ].join('\n'), 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(JSON.stringify({
        default_print_profile: 'Custom Project Process',
        printer_settings_id: 'Bambu Lab P1S 0.4 nozzle'
      }), 'utf8')]
    ])

    const index = await readPlateIndex(sourcePath)

    assert.deepEqual(index.plates.map((plate) => plate.index), [1, 2])
    assert.equal(index.plates[0]?.name, 'Front Plate')
    assert.equal(index.plates[1]?.name, 'Rear Plate')
    assert.equal(index.plates[1]?.thumbnailFile, 'Metadata/plate_2.png')
    assert.equal(index.processProfileName, 'Custom Project Process')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

const OBJECT_MODEL_SETTINGS_XML = [
  '<config>',
  '  <object id="3">',
  '    <metadata key="name" value="Box"/>',
  '    <part id="1" subtype="normal_part"><metadata key="name" value="Box part"/></part>',
  '  </object>',
  '  <object id="11">',
  '    <metadata key="name" value="Lid"/>',
  '    <part id="2" subtype="normal_part"><metadata key="name" value="Lid part"/></part>',
  '  </object>',
  '  <plate>',
  '    <metadata key="plater_id" value="1"/>',
  '    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="153"/></model_instance>',
  '    <model_instance><metadata key="object_id" value="11"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="204"/></model_instance>',
  '  </plate>',
  '</config>'
].join('\n')

// Companion 3D/3dmodel.model for the model_settings fixture above: build items for objects 3 and 11
// (the build-item objectid is the model_settings object_id). Slice-time object exclusion rides on
// these items' `printable` flag, not on model_instance removal.
const OBJECT_MODEL_3DMODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
  '  <resources>',
  '    <object id="3" type="model"><mesh/></object>',
  '    <object id="11" type="model"><mesh/></object>',
  '  </resources>',
  '  <build>',
  '    <item objectid="3" transform="1 0 0 0 1 0 0 0 1 -40 0 0" printable="1"/>',
  '    <item objectid="11" transform="1 0 0 0 1 0 0 0 1 40 0 0" printable="1"/>',
  '  </build>',
  '</model>'
].join('\n')

test('readPlateIndex exposes plate objects (by object_id) for unsliced model-settings 3MFs', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-objects-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/model_settings.config', Buffer.from(OBJECT_MODEL_SETTINGS_XML, 'utf8')]
    ])

    const index = await readPlateIndex(sourcePath)
    // Each object also carries the identify_ids of its model_instances on the plate --
    // the firmware skip handles -- so consumers can map object -> skip ids from the
    // index alone, without re-reading the file.
    assert.deepEqual(index.plates[0]?.objects, [
      { id: 3, name: 'Box', identifyIds: [153] },
      { id: 11, name: 'Lid', identifyIds: [204] }
    ])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('plateObjectIdsFromModelSettingsXml reads the target plate object ids only', () => {
  assert.deepEqual([...plateObjectIdsFromModelSettingsXml(OBJECT_MODEL_SETTINGS_XML, 1)], [3, 11])
  assert.deepEqual([...plateObjectIdsFromModelSettingsXml(OBJECT_MODEL_SETTINGS_XML, 2)], [])
})

// Two plates; object 3 has TWO instances on plate 1 (identify_ids 153 and 154), and object 11
// reappears on plate 2 under a different identify_id — plate scoping must never leak that one.
const MULTI_INSTANCE_MODEL_SETTINGS_XML = [
  '<config>',
  '  <plate>',
  '    <metadata key="plater_id" value="1"/>',
  '    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="153"/></model_instance>',
  '    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="1"/><metadata key="identify_id" value="154"/></model_instance>',
  '    <model_instance><metadata key="object_id" value="11"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="204"/></model_instance>',
  '  </plate>',
  '  <plate>',
  '    <metadata key="plater_id" value="2"/>',
  '    <model_instance><metadata key="object_id" value="11"/><metadata key="instance_id" value="1"/><metadata key="identify_id" value="205"/></model_instance>',
  '  </plate>',
  '</config>'
].join('\n')

test('readPlateIndex + plateSkipIdentifyIdsFromIndex map object_ids to every plate instance identify_id', async () => {
  // The dispatch skip-resolution path end to end: identify_id is a different id space from
  // object_id (the G-code "unique label id" the firmware's skip_objects keys on); deselecting
  // object 3 must skip both of its instances, and plate scoping must not leak object 11's
  // plate-2 instance into a plate-1 skip.
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-skip-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/model_settings.config', Buffer.from(MULTI_INSTANCE_MODEL_SETTINGS_XML, 'utf8')]
    ])

    const index = await readPlateIndex(sourcePath)
    const mapped = plateSkipIdentifyIdsFromIndex(index, 1, new Set([3]))
    assert.deepEqual(mapped.identifyIds, [153, 154])
    assert.deepEqual(mapped.unmatchedObjectIds, [])
    assert.equal(mapped.plateInstanceCount, 3)

    // Object 11 exists on both plates; a plate-2 skip must return plate 2's identify_id only,
    // and an object with no instance on the requested plate reports as unmatched.
    const plateTwo = plateSkipIdentifyIdsFromIndex(index, 2, new Set([3, 11]))
    assert.deepEqual(plateTwo.identifyIds, [205])
    assert.deepEqual(plateTwo.unmatchedObjectIds, [3])
    assert.equal(plateTwo.plateInstanceCount, 1)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('skip resolution handles gcode-only 3MFs whose objects exist only in slice_info', async () => {
  // Regression: Bambu Studio "sliced plate" exports (and MakerWorld print profiles) ship a
  // model_settings.config with plate metadata but NO model_instance blocks, so the index falls
  // back to slice_info objects whose ids ARE identify_ids. Resolving those ids against
  // model_settings (the dispatcher's old path) matched nothing and rejected every deselection;
  // resolving through the same parsed index the print dialog displayed must map them 1:1.
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-skip-gcode-only-'))
  const sourcePath = path.join(tempDir, 'source.gcode.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/model_settings.config', Buffer.from([
        '<config>',
        '  <plate>',
        '    <metadata key="plater_id" value="2"/>',
        '    <metadata key="plater_name" value="2 - Mast, Feeders"/>',
        '  </plate>',
        '</config>'
      ].join('\n'), 'utf8')],
      ['Metadata/slice_info.config', Buffer.from([
        '<config>',
        '  <plate>',
        '    <metadata key="index" value="2"/>',
        '    <metadata key="prediction" value="9684"/>',
        '    <object identify_id="11018" name="Yarn guide" skipped="false" />',
        '    <object identify_id="11051" name="Clamp foot" skipped="false" />',
        '    <object identify_id="11792" name="Clamp foot" skipped="false" />',
        '  </plate>',
        '</config>'
      ].join('\n'), 'utf8')]
    ])

    const index = await readPlateIndex(sourcePath)
    const mapped = plateSkipIdentifyIdsFromIndex(index, 2, new Set([11018, 11051]))
    assert.deepEqual(mapped.identifyIds, [11018, 11051])
    assert.deepEqual(mapped.unmatchedObjectIds, [])
    assert.equal(mapped.plateInstanceCount, 3)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('plateSkipIdentifyIdsFromIndex maps deselected plate objects through the parsed index', () => {
  // The shared resolver behind both the library-dispatch and storage-print flows. Object 3
  // has two instances on plate 1; object 11 reappears on plate 2 under a different
  // identify_id and must stay plate-scoped.
  const index = {
    plates: [
      {
        index: 1,
        objects: [
          { id: 3, name: 'Box', identifyIds: [153, 154] },
          { id: 11, name: 'Lid', identifyIds: [204] }
        ]
      },
      { index: 2, objects: [{ id: 11, name: 'Lid', identifyIds: [205] }] }
    ]
  }

  const mapped = plateSkipIdentifyIdsFromIndex(index, 1, new Set([3]))
  assert.deepEqual(mapped.identifyIds, [153, 154])
  assert.deepEqual(mapped.unmatchedObjectIds, [])
  assert.equal(mapped.plateInstanceCount, 3)

  // Plate scoping: a plate-2 skip of object 11 returns plate 2's identify_id only.
  assert.deepEqual(plateSkipIdentifyIdsFromIndex(index, 2, new Set([11])).identifyIds, [205])

  // Unknown object ids and objects without identify_ids report as unmatched.
  const unmatched = plateSkipIdentifyIdsFromIndex(index, 1, new Set([3, 99]))
  assert.deepEqual(unmatched.identifyIds, [153, 154])
  assert.deepEqual(unmatched.unmatchedObjectIds, [99])
  const noHandles = {
    plates: [{ index: 1, objects: [{ id: 5, name: 'Plain', identifyIds: [] as number[] }] }]
  }
  const withoutHandles = plateSkipIdentifyIdsFromIndex(noHandles, 1, new Set([5]))
  assert.deepEqual(withoutHandles.unmatchedObjectIds, [5])
  // A handle-less object still counts as occupying the plate (skip-everything guard).
  assert.equal(withoutHandles.plateInstanceCount, 1)

  // A missing plate matches nothing.
  const missingPlate = plateSkipIdentifyIdsFromIndex(index, 9, new Set([3]))
  assert.deepEqual(missingPlate.identifyIds, [])
  assert.equal(missingPlate.plateInstanceCount, 0)
})

test('setBuildItemsUnprintableXml marks only the listed build items printable="0"', () => {
  const out = setBuildItemsUnprintableXml(OBJECT_MODEL_3DMODEL_XML, new Set([11]))
  assert.match(out, /<item objectid="3"[^>]*printable="1"/)
  assert.match(out, /<item objectid="11"[^>]*printable="0"/)
  // An empty set is a no-op.
  assert.equal(setBuildItemsUnprintableXml(OBJECT_MODEL_3DMODEL_XML, new Set()), OBJECT_MODEL_3DMODEL_XML)
})

test('setBuildItemsUnprintableXml inserts printable="0" when the build item has no flag', () => {
  const xml = '<model><build><item objectid="7" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></build></model>'
  assert.match(setBuildItemsUnprintableXml(xml, new Set([7])), /<item objectid="7"[^>]*printable="0"\/>/)
})

test('createObjectFilteredThreeMf excludes unselected objects via build-item printable, keeping instances', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-objfilter-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'filtered.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/model_settings.config', Buffer.from(OBJECT_MODEL_SETTINGS_XML, 'utf8')],
      ['3D/3dmodel.model', Buffer.from(OBJECT_MODEL_3DMODEL_XML, 'utf8')]
    ])

    await createObjectFilteredThreeMf(sourcePath, outputPath, 1, [3])

    // Object 3 stays printable; the deselected object 11 is marked printable="0".
    const model = (await readEntry(outputPath, '3D/3dmodel.model')).toString('utf8')
    assert.match(model, /<item objectid="3"[^>]*printable="1"/)
    assert.match(model, /<item objectid="11"[^>]*printable="0"/)
    // Instance metadata is left intact for both objects (BambuStudio's native "unprintable" state).
    const settings = (await readEntry(outputPath, 'Metadata/model_settings.config')).toString('utf8')
    assert.match(settings, /object_id"\s+value="3"/)
    assert.match(settings, /object_id"\s+value="11"/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readPlateIndex backfills plate objects from model_settings when slice_info plates omit them', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-objects-backfill-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  try {
    await writeZipFixture(sourcePath, [
      // slice_info provides the plate list but no <object> entries (a common Bambu export shape).
      ['Metadata/slice_info.config', Buffer.from('<config><plate><metadata key="index" value="1"/><filament id="1" type="PLA" color="#ffffff"/></plate></config>', 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(OBJECT_MODEL_SETTINGS_XML, 'utf8')]
    ])

    const index = await readPlateIndex(sourcePath)
    assert.deepEqual(index.plates[0]?.objects, [
      { id: 3, name: 'Box', identifyIds: [153] },
      { id: 11, name: 'Lid', identifyIds: [204] }
    ])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readPlateIndex exposes slice_info prediction and weight per plate', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-prediction-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/slice_info.config', Buffer.from(
        '<config><plate>'
        + '<metadata key="index" value="1"/>'
        + '<metadata key="prediction" value="4503"/>'
        + '<metadata key="weight" value="12.34"/>'
        + '<filament id="1" type="PLA" color="#ffffff" used_g="12.34" used_m="4.1"/>'
        + '</plate></config>', 'utf8')]
    ])
    const index = await readPlateIndex(sourcePath)
    assert.equal(index.plates[0]?.prediction, 4503)
    assert.equal(index.plates[0]?.weight, 12.34)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('applyObjectProcessOverridesXml injects per-object metadata, replacing existing keys, on the right object only', () => {
  const out = applyObjectProcessOverridesXml(OBJECT_MODEL_SETTINGS_XML, {
    '3': { layer_height: '0.12', wall_loops: '4' }
  })
  // Object 3 gets the override metadata; its existing name is preserved.
  const object3 = /<object id="3">[\s\S]*?<\/object>/.exec(out)?.[0] ?? ''
  assert.match(object3, /<metadata key="layer_height" value="0.12"\/>/)
  assert.match(object3, /<metadata key="wall_loops" value="4"\/>/)
  assert.match(object3, /<metadata key="name" value="Box"\/>/)
  // Object 11 is untouched (no overrides for it).
  const object11 = /<object id="11">[\s\S]*?<\/object>/.exec(out)?.[0] ?? ''
  assert.doesNotMatch(object11, /layer_height/)
})

test('applyObjectProcessOverridesXml overrides a pre-existing object metadata value', () => {
  const xml = '<config><object id="3"><metadata key="name" value="Box"/><metadata key="layer_height" value="0.2"/></object></config>'
  const out = applyObjectProcessOverridesXml(xml, { '3': { layer_height: '0.08' } })
  assert.match(out, /<metadata key="layer_height" value="0.08"\/>/)
  assert.doesNotMatch(out, /value="0.2"/)
})

test('applyObjectProcessOverridesXml does not touch a part\'s per-volume metadata of the same key', () => {
  const xml = '<config><object id="3"><metadata key="name" value="Box"/><metadata key="wall_loops" value="2"/><part id="3"><metadata key="wall_loops" value="9"/></part></object></config>'
  const out = applyObjectProcessOverridesXml(xml, { '3': { wall_loops: '5' } })
  // Object-level becomes 5; the part's per-volume wall_loops="9" survives untouched.
  assert.match(out, /<part id="3"><metadata key="wall_loops" value="9"\/><\/part>/)
  const head = out.slice(0, out.indexOf('<part'))
  assert.match(head, /<metadata key="wall_loops" value="5"\/>/)
})

test('applyObjectProcessOverridesXml with an empty map clears object-level overrides but keeps structural metadata', () => {
  const xml = '<config><object id="3"><metadata key="name" value="Box"/><metadata key="module" value="m"/><metadata key="wall_loops" value="5"/></object></config>'
  const out = applyObjectProcessOverridesXml(xml, { '3': {} })
  assert.doesNotMatch(out, /wall_loops/) // cleared
  assert.match(out, /<metadata key="name" value="Box"\/>/) // structural kept
  assert.match(out, /<metadata key="module" value="m"\/>/) // structural kept
})

test('parseModelSettingsScene reads object process overrides but not structural metadata (name/extruder/module)', () => {
  const xml = '<config><object id="3"><metadata key="name" value="Box"/><metadata key="extruder" value="2"/><metadata key="module" value="cut"/><metadata key="wall_loops" value="5"/><part id="3"><metadata key="layer_height" value="0.1"/></part></object></config>'
  const { objectProcessOverridesById, objectNamesById } = parseModelSettingsScene(xml)
  const overrides = objectProcessOverridesById.get(3) ?? {}
  assert.equal(overrides.wall_loops, '5')
  assert.equal(overrides.name, undefined)
  assert.equal(overrides.extruder, undefined)
  assert.equal(overrides.module, undefined) // Bambu cut/assembly module, not a process override
  assert.equal(overrides.layer_height, undefined) // part-level, not object-level
  assert.equal(objectNamesById.get(3), 'Box')
})

test('applyPartProcessOverrides sets a part\'s process metadata without touching the object or siblings', () => {
  const xml = '<config><object id="3"><metadata key="name" value="Asm"/><metadata key="wall_loops" value="2"/><part id="3"><metadata key="name" value="A"/></part><part id="4"><metadata key="name" value="B"/></part></object></config>'
  const out = applyPartProcessOverrides(xml, [{ objectId: 3, componentObjectId: 4, overrides: { wall_loops: '6' } }])
  // Part 4 gains the override; its name (structural) stays; part 3 and the object head are untouched.
  const part4 = /<part id="4">[\s\S]*?<\/part>/.exec(out)?.[0] ?? ''
  assert.match(part4, /<metadata key="wall_loops" value="6"\/>/)
  assert.match(part4, /<metadata key="name" value="B"\/>/)
  assert.doesNotMatch(/<part id="3">[\s\S]*?<\/part>/.exec(out)?.[0] ?? '', /wall_loops/)
  // The object-level wall_loops="2" is unchanged (per-part is separate from the object's).
  assert.match(out.slice(0, out.indexOf('<part')), /<metadata key="wall_loops" value="2"\/>/)
})

test('applyPartProcessOverrides refuses to inject structural keys smuggled into the override map', () => {
  // A June-2026 editor bug seeded override maps from ALL part metadata — including matrix and
  // source_offset_* — which, injected back, duplicated the part's structural entries. Only
  // process-setting keys may pass through.
  const xml = '<config><object id="3"><part id="4"><metadata key="name" value="B"/><metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/></part></object></config>'
  const out = applyPartProcessOverrides(xml, [{
    objectId: 3,
    componentObjectId: 4,
    overrides: { wall_loops: '6', matrix: '9 9 9 9 9 9 9 9 9 9 9 9 9 9 9 9', source_offset_x: '42', name: 'evil' }
  }])
  const part4 = /<part id="4">[\s\S]*?<\/part>/.exec(out)?.[0] ?? ''
  assert.match(part4, /<metadata key="wall_loops" value="6"\/>/)
  // The real structural entries survive untouched, and no duplicates/forgeries are injected.
  assert.match(part4, /<metadata key="name" value="B"\/>/)
  assert.match(part4, /<metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"\/>/)
  assert.doesNotMatch(part4, /9 9 9/)
  assert.doesNotMatch(part4, /source_offset_x/)
  assert.doesNotMatch(part4, /evil/)
})

test('applyPartTypeChanges rewrites only the targeted part\'s subtype', () => {
  const xml = '<config><object id="3"><part id="3" subtype="normal_part"><metadata key="name" value="A"/></part><part id="4" subtype="normal_part"><metadata key="name" value="B"/></part></object><object id="7"><part id="8" subtype="normal_part"/></object></config>'
  const out = applyPartTypeChanges(xml, [{ objectId: 3, componentObjectId: 4, subtype: 'modifier_part' }])
  assert.match(out, /<part id="4" subtype="modifier_part">/)
  assert.match(out, /<part id="3" subtype="normal_part">/)
  assert.match(out, /<part id="8" subtype="normal_part"\/>/)
})

test('applyPartTypeChanges inserts a subtype attribute when the part has none', () => {
  const xml = '<config><object id="3"><part id="4"><metadata key="name" value="B"/></part></object></config>'
  const out = applyPartTypeChanges(xml, [{ objectId: 3, componentObjectId: 4, subtype: 'support_blocker' }])
  assert.match(out, /<part id="4" subtype="support_blocker">/)
})

test('createObjectCustomizedThreeMf excludes deselected objects and injects per-object overrides in one pass', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-objcustom-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'custom.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/model_settings.config', Buffer.from(OBJECT_MODEL_SETTINGS_XML, 'utf8')],
      ['3D/3dmodel.model', Buffer.from(OBJECT_MODEL_3DMODEL_XML, 'utf8')]
    ])

    // Keep only object 3; deselect 11. Override targets the kept object 3.
    await createObjectCustomizedThreeMf(sourcePath, outputPath, 1, {
      selectedObjectIds: [3],
      objectProcessOverrides: { '3': { sparse_infill_density: '35%' } }
    })

    // Selection: the deselected object 11's build item is marked unprintable; object 3 stays printable.
    const model = (await readEntry(outputPath, '3D/3dmodel.model')).toString('utf8')
    assert.match(model, /<item objectid="3"[^>]*printable="1"/)
    assert.match(model, /<item objectid="11"[^>]*printable="0"/)
    // Overrides: object 3 gains the per-object metadata in model_settings.
    const rewritten = (await readEntry(outputPath, 'Metadata/model_settings.config')).toString('utf8')
    const object3 = /<object id="3">[\s\S]*?<\/object>/.exec(rewritten)?.[0] ?? ''
    assert.match(object3, /<metadata key="sparse_infill_density" value="35%"\/>/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readPlateIndex derives used filament ids from model-settings object extruders when slice-info lacks plate data', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-model-settings-filaments-'))
  const sourcePath = path.join(tempDir, 'source.3mf')

  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/slice_info.config', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><config><header/></config>', 'utf8')],
      ['Metadata/model_settings.config', Buffer.from([
        '<config>',
        '  <object id="8">',
        '    <metadata key="extruder" value="1"/>',
        '    <part id="1"><metadata key="extruder" value="2"/></part>',
        '  </object>',
        '  <object id="9">',
        '    <metadata key="extruder" value="3"/>',
        '  </object>',
        '  <plate>',
        '    <metadata key="plater_id" value="1"/>',
        '    <model_instance>',
        '      <metadata key="object_id" value="8"/>',
        '    </model_instance>',
        '  </plate>',
        '  <plate>',
        '    <metadata key="plater_id" value="2"/>',
        '    <model_instance>',
        '      <metadata key="object_id" value="9"/>',
        '    </model_instance>',
        '  </plate>',
        '</config>'
      ].join('\n'), 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(JSON.stringify({
        filament_type: ['PLA', 'PETG', 'ABS'],
        filament_settings_id: ['Bambu PLA Basic', 'Bambu PETG HF', 'Bambu ABS']
      }), 'utf8')]
    ])

    const index = await readPlateIndex(sourcePath)

    assert.deepEqual(index.plates.map((plate) => plate.index), [1, 2])
    assert.deepEqual(index.plates[0]?.filaments.map((filament) => filament.id), [1, 2])
    assert.deepEqual(index.plates[1]?.filaments.map((filament) => filament.id), [3])
    assert.equal(index.plates[0]?.filaments[0]?.filamentName, 'Bambu PLA Basic')
    assert.equal(index.plates[0]?.filaments[1]?.filamentName, 'Bambu PETG HF')
    assert.equal(index.plates[1]?.filaments[0]?.filamentName, 'Bambu ABS')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readPlateIndex adds support-interface filament ids for support-enabled model-settings objects when slice-info lacks plate data', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-model-settings-support-filaments-'))
  const sourcePath = path.join(tempDir, 'source.3mf')

  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/slice_info.config', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><config><header/></config>', 'utf8')],
      ['Metadata/model_settings.config', Buffer.from([
        '<config>',
        '  <object id="8">',
        '    <metadata key="enable_support" value="1"/>',
        '    <metadata key="extruder" value="1"/>',
        '    <part id="1"><metadata key="extruder" value="2"/></part>',
        '  </object>',
        '  <object id="9">',
        '    <metadata key="extruder" value="2"/>',
        '  </object>',
        '  <plate>',
        '    <metadata key="plater_id" value="1"/>',
        '    <model_instance>',
        '      <metadata key="object_id" value="8"/>',
        '    </model_instance>',
        '  </plate>',
        '  <plate>',
        '    <metadata key="plater_id" value="2"/>',
        '    <model_instance>',
        '      <metadata key="object_id" value="9"/>',
        '    </model_instance>',
        '  </plate>',
        '</config>'
      ].join('\n'), 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(JSON.stringify({
        filament_type: ['ABS', 'ABS', 'ABS'],
        filament_settings_id: ['Bambu ABS', 'Bambu ABS', 'Bambu Support for ABS'],
        support_filament: '0',
        support_interface_filament: '3'
      }), 'utf8')]
    ])

    const index = await readPlateIndex(sourcePath)

    assert.deepEqual(index.plates.map((plate) => plate.index), [1, 2])
    assert.deepEqual(index.plates[0]?.filaments.map((filament) => filament.id), [1, 2, 3])
    assert.deepEqual(index.plates[1]?.filaments.map((filament) => filament.id), [2])
    assert.equal(index.plates[0]?.filaments[2]?.filamentName, 'Bambu Support for ABS')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readPlateIndex surfaces the dedicated support material on every unsliced plate without leaking the support-base colour', async () => {
  // Regression for a manual/global-support project: support is enabled project-wide
  // (enable_support=1) and filament 4 is a dedicated support material (filament_is_support),
  // while the support BASE is the regular print colour filament 1. Because which plate actually
  // generates support is only known after slicing, the dedicated support material is surfaced on
  // EVERY plate (so it can be mapped), but the support-base colour must NOT be added to a plate
  // whose geometry doesn't otherwise use it (that's what made a print colour look "used").
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-global-support-filaments-'))
  const sourcePath = path.join(tempDir, 'source.3mf')

  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/slice_info.config', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><config><header/></config>', 'utf8')],
      ['Metadata/model_settings.config', Buffer.from([
        '<config>',
        // Plate-1 object: prints in filament 3 only, no per-object support metadata.
        '  <object id="8">',
        '    <metadata key="extruder" value="3"/>',
        '  </object>',
        // Plate-2 object: prints in filament 1 only, no per-object support metadata.
        '  <object id="9">',
        '    <metadata key="extruder" value="1"/>',
        '  </object>',
        '  <plate>',
        '    <metadata key="plater_id" value="1"/>',
        '    <model_instance>',
        '      <metadata key="object_id" value="8"/>',
        '    </model_instance>',
        '  </plate>',
        '  <plate>',
        '    <metadata key="plater_id" value="2"/>',
        '    <model_instance>',
        '      <metadata key="object_id" value="9"/>',
        '    </model_instance>',
        '  </plate>',
        '</config>'
      ].join('\n'), 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(JSON.stringify({
        filament_type: ['PLA', 'PETG', 'PLA', 'PLA'],
        filament_settings_id: ['Bambu PLA Basic', 'Bambu PETG HF', 'Bambu PLA Basic', 'Bambu Support For PLA/PETG'],
        filament_is_support: ['0', '0', '0', '1'],
        enable_support: '1',
        support_filament: '1',
        support_interface_filament: '4'
      }), 'utf8')]
    ])

    const index = await readPlateIndex(sourcePath)

    assert.deepEqual(index.plates.map((plate) => plate.index), [1, 2])
    // Plate 1 geometry is filament 3; it gains the dedicated support material 4 but NOT the
    // support-base colour 1 (which its geometry never uses).
    assert.deepEqual(index.plates[0]?.filaments.map((filament) => filament.id), [3, 4])
    // Plate 2 geometry is filament 1, which already covers the support base; it also gains 4.
    assert.deepEqual(index.plates[1]?.filaments.map((filament) => filament.id), [1, 4])
    assert.equal(index.plates[0]?.filaments[1]?.filamentName, 'Bambu Support For PLA/PETG')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('createSinglePlateThreeMf strips bulk 3D payload while keeping the selected plate gcode', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-test-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'plate-2.3mf')

  try {
    await writeZipFixture(sourcePath, [
      ['[Content_Types].xml', Buffer.from('<Types/>', 'utf8')],
      ['_rels/.rels', Buffer.from('<Relationships/>', 'utf8')],
      ['3D/3dmodel.model', Buffer.concat([Buffer.from('<model>', 'utf8'), randomBytes(256 * 1024), Buffer.from('</model>', 'utf8')])],
      ['3D/Textures/huge.texture', randomBytes(128 * 1024)],
      ['Metadata/slice_info.config', Buffer.from([
        '<config>',
        '  <plate><metadata key="index" value="1"/><metadata key="gcode_file" value="Metadata/plate_1.gcode"/></plate>',
        '  <plate><metadata key="index" value="2"/><metadata key="gcode_file" value="Metadata/plate_2.gcode"/></plate>',
        '</config>'
      ].join('\n'), 'utf8')],
      ['Metadata/model_settings.config', Buffer.from([
        '<config>',
        '  <plate><metadata key="plater_id" value="1"/><metadata key="gcode_file" value="Metadata/plate_1.gcode"/></plate>',
        '  <plate><metadata key="plater_id" value="2"/><metadata key="gcode_file" value="Metadata/plate_2.gcode"/></plate>',
        '</config>'
      ].join('\n'), 'utf8')],
      ['Metadata/plate_1.gcode.md5', Buffer.from('md5-plate-one', 'utf8')],
      ['Metadata/plate_2.gcode.md5', Buffer.from('md5-plate-two', 'utf8')],
      ['Metadata/plate_1.gcode', Buffer.from('plate-one', 'utf8')],
      ['Metadata/plate_2.gcode', Buffer.from('plate-two', 'utf8')]
    ])

    await createSinglePlateThreeMf(sourcePath, outputPath, 2)

    const sourceSize = (await stat(sourcePath)).size
    const outputSize = (await stat(outputPath)).size
    assert.ok(outputSize < sourceSize / 4, `expected slim 3MF to be much smaller than source (${outputSize} vs ${sourceSize})`)
    assert.equal((await readEntry(outputPath, 'Metadata/plate_2.gcode')).toString('utf8'), 'plate-two')
    await assert.rejects(() => readEntry(outputPath, 'Metadata/plate_1.gcode'))
    await assert.rejects(() => readEntry(outputPath, '3D/Textures/huge.texture'))
    assert.match((await readEntry(outputPath, '3D/3dmodel.model')).toString('utf8'), /<build\/>/)
    const filteredSliceInfo = (await readEntry(outputPath, 'Metadata/slice_info.config')).toString('utf8')
    assert.match(filteredSliceInfo, /value="2"/)
    assert.doesNotMatch(filteredSliceInfo, /value="1"/)
    const filteredModelSettings = (await readEntry(outputPath, 'Metadata/model_settings.config')).toString('utf8')
    assert.match(filteredModelSettings, /value="2"/)
    assert.doesNotMatch(filteredModelSettings, /value="1"/)
    assert.equal((await readEntry(outputPath, 'Metadata/plate_2.gcode.md5')).toString('utf8'), 'md5-plate-two')
    await assert.rejects(() => readEntry(outputPath, 'Metadata/plate_1.gcode.md5'))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

function createPickMaskPng(
  width: number,
  height: number,
  rectangles: Array<{ x: number; y: number; width: number; height: number; objectId: number }>
): Buffer {
  const png = new PNG({ width, height })
  for (const rectangle of rectangles) {
    for (let y = rectangle.y; y < rectangle.y + rectangle.height; y += 1) {
      for (let x = rectangle.x; x < rectangle.x + rectangle.width; x += 1) {
        const offset = (y * width + x) * 4
        png.data[offset] = rectangle.objectId & 0xff
        png.data[offset + 1] = (rectangle.objectId >> 8) & 0xff
        png.data[offset + 2] = (rectangle.objectId >> 16) & 0xff
        png.data[offset + 3] = 255
      }
    }
  }
  return PNG.sync.write(png)
}

async function writeZipFixture(filePath: string, entries: Array<[string, Buffer]>): Promise<void> {
  const zip = new yazl.ZipFile()
  for (const [entryPath, buffer] of entries) {
    zip.addBuffer(buffer, entryPath)
  }

  await new Promise<void>((resolve, reject) => {
    zip.outputStream
      .pipe(createWriteStream(filePath))
      .on('close', resolve)
      .on('error', reject)
    zip.end()
  })
}
const ARRANGE_MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
  '  <resources>',
  '    <object id="3" type="model"><components><component p:path="/3D/Objects/object_3.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>',
  '    <object id="11" type="model"><components><component p:path="/3D/Objects/object_11.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>',
  '  </resources>',
  '  <build>',
  '    <item objectid="3" transform="1 0 0 0 1 0 0 0 1 -40 0 0" printable="1"/>',
  '    <item objectid="11" transform="1 0 0 0 1 0 0 0 1 40 0 0" printable="1"/>',
  '  </build>',
  '</model>'
].join('\n')

const ARRANGE_MODEL_SETTINGS_XML = [
  '<config>',
  '  <object id="3"><metadata key="name" value="Box"/><part id="1" subtype="normal_part"><metadata key="name" value="Box part"/></part></object>',
  '  <object id="11"><metadata key="name" value="Lid"/><part id="2" subtype="normal_part"><metadata key="name" value="Lid part"/></part></object>',
  '  <plate>',
  '    <metadata key="plater_id" value="1"/>',
  '    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/></model_instance>',
  '    <model_instance><metadata key="object_id" value="11"/><metadata key="instance_id" value="0"/></model_instance>',
  '  </plate>',
  '</config>'
].join('\n')

test('threeMfTransformFromTRS composes translation, rotation and scale to a 3MF matrix', () => {
  assert.deepEqual(
    threeMfTransformFromTRS({ x: 5, y: -2, z: 1 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }),
    [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, -2, 1]
  )
  // 90 degrees about Z maps +X -> +Y (column-major 3x3 first column becomes [0,1,0]).
  const rotated = threeMfTransformFromTRS({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: Math.PI / 2 }, { x: 1, y: 1, z: 1 })
  assert.ok(Math.abs((rotated[0] ?? 1) - 0) < 1e-9 && Math.abs((rotated[1] ?? 0) - 1) < 1e-9)
  // Non-uniform scale multiplies the matching column.
  const scaled = threeMfTransformFromTRS({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 2, y: 3, z: 4 })
  assert.deepEqual([scaled[0] ?? 0, scaled[4] ?? 0, scaled[8] ?? 0], [2, 3, 4])
})

test('writeArrangedThreeMf re-plates, clones and re-homes instances so the scene round-trips', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-arrange-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'arranged.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')]
    ])

    // Sanity: the source has both objects on plate 1.
    const sourceScene = await readSceneManifest(sourcePath, 1)
    assert.deepEqual(sourceScene.instances.map((entry) => entry.objectId).sort((left, right) => left - right), [3, 11])

    // Keep Box on plate 1, move Lid to plate 2, and clone Box onto plate 2.
    const edit: SceneEdit = {
      plates: [{ index: 1 }, { index: 2 }],
      instances: [
        { objectId: 3, plateIndex: 1, position: { x: -40, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        { objectId: 11, plateIndex: 2, position: { x: 10, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        { objectId: 3, plateIndex: 2, position: { x: -10, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ]
    }
    await writeArrangedThreeMf(sourcePath, outputPath, edit)

    const plateOne = await readSceneManifest(outputPath, 1)
    assert.equal(plateOne.instances.length, 1)
    assert.equal(plateOne.instances[0]?.objectId, 3)
    assert.ok(Math.abs((plateOne.instances[0]?.transform[9] ?? 0) - -40) < 1e-3)

    const plateTwo = await readSceneManifest(outputPath, 2)
    assert.deepEqual(plateTwo.instances.map((entry) => entry.objectId).sort((left, right) => left - right), [3, 11])
    const lid = plateTwo.instances.find((entry) => entry.objectId === 11)
    const clonedBox = plateTwo.instances.find((entry) => entry.objectId === 3)
    // Plate-local placements are recovered after the plate-grid origin is removed again.
    assert.ok(Math.abs((lid?.transform[9] ?? 0) - 10) < 1e-3)
    assert.ok(Math.abs((clonedBox?.transform[9] ?? 0) - -10) < 1e-3)

    // Geometry/object definitions are preserved verbatim.
    const rewrittenModel = (await readEntry(outputPath, '3D/3dmodel.model')).toString('utf8')
    assert.match(rewrittenModel, /<object id="3"/)
    assert.match(rewrittenModel, /<object id="11"/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('writeArrangedThreeMf writes printable="0" for skipped instances and readSceneManifest reads it back', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-printable-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'arranged.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')]
    ])

    // Box (3) prints; Lid (11) is toggled non-printable.
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: 3, plateIndex: 1, position: { x: -40, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        { objectId: 11, plateIndex: 1, position: { x: 40, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, printable: false }
      ]
    }
    await writeArrangedThreeMf(sourcePath, outputPath, edit)

    // The build section carries Bambu's native printable attribute (kept in the 3MF, excluded from slice).
    const rewrittenModel = (await readEntry(outputPath, '3D/3dmodel.model')).toString('utf8')
    assert.match(rewrittenModel, /<item objectid="3"[^>]*printable="1"/)
    assert.match(rewrittenModel, /<item objectid="11"[^>]*printable="0"/)

    // Reopening restores the per-instance flag: omitted when printable, false when skipped.
    const scene = await readSceneManifest(outputPath, 1)
    assert.equal(scene.instances.find((entry) => entry.objectId === 3)?.printable, undefined)
    assert.equal(scene.instances.find((entry) => entry.objectId === 11)?.printable, false)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('partFilaments on SOME parts round-trips without painting the untouched parts', async () => {
  // Regression: an object whose parts carry no extruder metadata (they inherit), with a
  // filament assigned to only SOME parts. The reader used to report the first assigned
  // part's filament as the INSTANCE filament, so on reload the editor seeded the untouched
  // parts with the reassigned sibling's material — and the next save baked it onto them.
  const modelXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
    '  <resources>',
    '    <object id="3" type="model"><components>'
      + '<component p:path="/3D/Objects/object_3.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>'
      + '<component p:path="/3D/Objects/object_3.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>'
      + '</components></object>',
    '    <object id="11" type="model"><components><component p:path="/3D/Objects/object_11.model" objectid="4" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>',
    '  </resources>',
    '  <build>',
    '    <item objectid="3" transform="1 0 0 0 1 0 0 0 1 -40 0 0" printable="1"/>',
    '    <item objectid="11" transform="1 0 0 0 1 0 0 0 1 40 0 0" printable="1"/>',
    '  </build>',
    '</model>'
  ].join('\n')
  const modelSettingsXml = [
    '<config>',
    '  <object id="3"><metadata key="name" value="Assembly"/>'
      + '<part id="1" subtype="normal_part"><metadata key="name" value="Main"/></part>'
      + '<part id="2" subtype="normal_part"><metadata key="name" value="Trim"/></part></object>',
    '  <object id="11"><metadata key="name" value="Lid"/><part id="4" subtype="normal_part"><metadata key="name" value="Lid part"/></part></object>',
    '  <plate>',
    '    <metadata key="plater_id" value="1"/>',
    '    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/></model_instance>',
    '    <model_instance><metadata key="object_id" value="11"/><metadata key="instance_id" value="0"/></model_instance>',
    '  </plate>',
    '</config>'
  ].join('\n')
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-part-filament-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'arranged.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(modelXml, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(modelSettingsXml, 'utf8')]
    ])

    // Assign filament 2 to ONE part of the assembly and filament 3 to the lid's only part.
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: 3, plateIndex: 1, position: { x: -40, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        { objectId: 11, plateIndex: 1, position: { x: 40, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ],
      partFilaments: [
        { objectId: 3, componentObjectId: 2, filamentId: 2 },
        { objectId: 11, componentObjectId: 4, filamentId: 3 }
      ]
    }
    await writeArrangedThreeMf(sourcePath, outputPath, edit)

    const scene = await readSceneManifest(outputPath, 1)
    const partFilament = (componentObjectId: number) =>
      scene.parts.find((part) => part.objectId === componentObjectId)?.filamentId ?? null
    // The reassigned part carries filament 2; the untouched sibling stays unassigned.
    assert.equal(partFilament(2), 2)
    assert.equal(partFilament(1), null)
    // The instance is NOT uniformly assigned, so it reports no instance-level filament —
    // the editor must not seed the untouched part from a sibling's assignment.
    assert.equal(scene.instances.find((entry) => entry.objectId === 3)?.filamentId, null)
    // A uniformly-assigned object still reports its filament at the instance level.
    assert.equal(partFilament(4), 3)
    assert.equal(scene.instances.find((entry) => entry.objectId === 11)?.filamentId, 3)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('partTransforms rewrite the component transform and mirror the matrix metadata', async () => {
  // Moving/scaling a baked part: the authoritative placement is the part's <component
  // transform>; the model_settings `matrix` metadata (BambuStudio's source-record,
  // row-major 4x4) must be mirrored when present so a BambuStudio re-save doesn't
  // compound a stale record.
  const modelXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
    '  <resources>',
    '    <object id="3" type="model"><components>'
      + '<component p:path="/3D/Objects/object_3.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>'
      + '<component p:path="/3D/Objects/object_3.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>'
      + '</components></object>',
    '  </resources>',
    '  <build>',
    '    <item objectid="3" transform="1 0 0 0 1 0 0 0 1 -40 0 0" printable="1"/>',
    '  </build>',
    '</model>'
  ].join('\n')
  const modelSettingsXml = [
    '<config>',
    '  <object id="3"><metadata key="name" value="Assembly"/>'
      + '<part id="1" subtype="normal_part"><metadata key="name" value="Main"/></part>'
      + '<part id="2" subtype="support_blocker"><metadata key="name" value="Blocker"/>'
      + '<metadata key="matrix" value="1 0 0 5 0 1 0 0 0 0 1 0 0 0 0 1"/></part></object>',
    '  <plate>',
    '    <metadata key="plater_id" value="1"/>',
    '    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/></model_instance>',
    '  </plate>',
    '</config>'
  ].join('\n')
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-part-transform-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'arranged.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(modelXml, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(modelSettingsXml, 'utf8')]
    ])

    // Move the blocker to (10, 4, 2) and scale it 2x on Z (column-major 3x3 + translation).
    const matrix = [1, 0, 0, 0, 1, 0, 0, 0, 2, 10, 4, 2]
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: 3, plateIndex: 1, position: { x: -40, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ],
      partTransforms: [{ objectId: 3, componentObjectId: 2, matrix }]
    }
    await writeArrangedThreeMf(sourcePath, outputPath, edit)

    const rewrittenModel = (await readEntry(outputPath, '3D/3dmodel.model')).toString('utf8')
    assert.match(rewrittenModel, /objectid="2"[^>]*transform="1 0 0 0 1 0 0 0 2 10 4 2"/)
    // The untouched sibling keeps its transform.
    assert.match(rewrittenModel, /objectid="1"[^>]*transform="1 0 0 0 1 0 0 0 1 0 0 0"/)
    // The matrix metadata is mirrored in ROW-major 4x4 layout.
    const rewrittenSettings = (await readEntry(outputPath, 'Metadata/model_settings.config')).toString('utf8')
    assert.match(rewrittenSettings, /<metadata key="matrix" value="1 0 0 10 0 1 0 4 0 0 2 2 0 0 0 1"\/>/)

    // Reopening the file yields the moved part placement.
    const scene = await readSceneManifest(outputPath, 1)
    const parts = scene.instances.find((entry) => entry.objectId === 3)?.parts ?? []
    assert.deepEqual(parts.find((part) => part.componentObjectId === 2)?.transform, matrix)
    assert.deepEqual(parts.find((part) => part.componentObjectId === 1)?.transform, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('embedPlateThumbnails writes/replaces per-plate PNGs while preserving other entries', async () => {
  const { embedPlateThumbnails } = await import('./three-mf.js')
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-embed-'))
  const filePath = path.join(tempDir, 'sliced.gcode.3mf')
  try {
    await writeZipFixture(filePath, [
      ['Metadata/plate_1.gcode', Buffer.from('G1 X1', 'utf8')],
      ['Metadata/plate_1.png', Buffer.from('OLD-RENDER', 'utf8')], // a stale render to be replaced
      ['Metadata/slice_info.config', Buffer.from('<config/>', 'utf8')]
    ])

    await embedPlateThumbnails(filePath, [{ plateIndex: 1, png: Buffer.from('NEW-RENDER', 'utf8') }])

    assert.equal((await readEntry(filePath, 'Metadata/plate_1.png')).toString('utf8'), 'NEW-RENDER')
    assert.equal((await readEntry(filePath, 'Metadata/plate_1_small.png')).toString('utf8'), 'NEW-RENDER')
    // Unrelated entries are preserved, and no entry is duplicated.
    assert.equal((await readEntry(filePath, 'Metadata/plate_1.gcode')).toString('utf8'), 'G1 X1')
    assert.equal((await readEntry(filePath, 'Metadata/slice_info.config')).toString('utf8'), '<config/>')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('writeArrangedThreeMf lays plates out in BambuStudio\'s 2D grid (3rd plate wraps to row 1, not column 2)', async () => {
  // Regression for the slice exit-206 bug: a single-row layout pushed the 3rd+ plate past the
  // print volume. BambuStudio arranges plates in a square-ish grid (cols = round(sqrt(n))), so for
  // 4 plates the 3rd belongs in row 1 / column 0 (negative Y), not column 2 of row 0. The scene
  // reader self-corrects any in-cell layout, so this asserts the RAW global build positions the
  // slicer actually sees.
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-grid-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'arranged.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')]
    ])

    // One clone of object 3 per plate, each at the plate-local origin so its global build
    // translation equals the plate's grid origin.
    const edit: SceneEdit = {
      plates: [{ index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }],
      instances: [1, 2, 3, 4].map((plateIndex) => ({
        objectId: 3,
        plateIndex,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 }
      }))
    }
    await writeArrangedThreeMf(sourcePath, outputPath, edit)

    // Correlate each plate's model_instance back to its global build-item translation.
    const modelXml = (await readEntry(outputPath, '3D/3dmodel.model')).toString('utf8')
    const modelSettingsXml = (await readEntry(outputPath, 'Metadata/model_settings.config')).toString('utf8')
    const itemTranslations: Array<{ x: number; y: number }> = []
    for (const match of modelXml.matchAll(/<item\b[^>]*\bobjectid="3"[^>]*\btransform="([^"]+)"/g)) {
      const nums = match[1]!.trim().split(/\s+/).map(Number)
      itemTranslations.push({ x: nums[9]!, y: nums[10]! })
    }
    assert.equal(itemTranslations.length, 4, 'one build item per plated clone')
    const originByPlate = new Map<number, { x: number; y: number }>()
    for (const plateBlock of modelSettingsXml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
      const body = plateBlock[1]!
      const plateId = Number(/plater_id"\s+value="(\d+)"/.exec(body)?.[1])
      const instanceId = Number(/instance_id"\s+value="(\d+)"/.exec(body)?.[1])
      originByPlate.set(plateId, itemTranslations[instanceId]!)
    }

    const p1 = originByPlate.get(1)!
    const p2 = originByPlate.get(2)!
    const p3 = originByPlate.get(3)!
    const p4 = originByPlate.get(4)!

    // Row 0: plates 1,2 share Y. Row 1: plates 3,4 share a lower (more negative) Y.
    assert.ok(Math.abs(p1.y - p2.y) < 1e-3, 'plates 1 and 2 are in the same row')
    assert.ok(Math.abs(p3.y - p4.y) < 1e-3, 'plates 3 and 4 are in the same row')
    assert.ok(p3.y < p1.y - 1, 'plate 3 wraps down to the next row (negative Y), not column 2 of row 0')
    // Columns: plates 1,3 in column 0; plates 2,4 one stride to the right.
    assert.ok(Math.abs(p1.x - p3.x) < 1e-3, 'plates 1 and 3 share column 0')
    assert.ok(Math.abs(p2.x - p4.x) < 1e-3, 'plates 2 and 4 share column 1')
    assert.ok(p2.x > p1.x + 1, 'plate 2 sits one column to the right of plate 1')
    // The X and Y strides are equal for a square bed (sanity that we did not collapse a dimension).
    assert.ok(Math.abs((p2.x - p1.x) - (p1.y - p3.y)) < 1e-3, 'square bed yields equal X/Y strides')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('writeArrangedThreeMf applies object name overrides to object-level name metadata only', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-rename-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'renamed.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')]
    ])

    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: 3, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        { objectId: 11, plateIndex: 1, position: { x: 20, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ],
      objectNames: [{ objectId: 3, name: 'Renamed Box' }]
    }
    await writeArrangedThreeMf(sourcePath, outputPath, edit)

    const config = (await readEntry(outputPath, 'Metadata/model_settings.config')).toString('utf8')
    const objectThree = /<object id="3"[\s\S]*?<\/object>/.exec(config)?.[0] ?? ''
    // The object-level name is updated...
    assert.match(objectThree, /<metadata key="name" value="Renamed Box"\/>/)
    assert.doesNotMatch(objectThree, /<metadata key="name" value="Box"\/>/)
    // ...while the mesh part keeps its own name (matching Bambu Studio's rename).
    assert.match(objectThree, /<metadata key="name" value="Box part"\/>/)
    // An object without an override is left untouched.
    const objectEleven = /<object id="11"[\s\S]*?<\/object>/.exec(config)?.[0] ?? ''
    assert.match(objectEleven, /<metadata key="name" value="Lid"\/>/)

    // The plate index reflects the new name end-to-end (parser reads object-level name).
    const renamedPlate = await readSceneManifest(outputPath, 1)
    assert.equal(renamedPlate.instances.length, 2)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

const PAINT_OBJECT_ENTRY_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model>',
  '  <resources>',
  '    <object id="1" type="model"><mesh>',
  '      <vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices>',
  '      <triangles>',
  '        <triangle v1="0" v2="1" v3="2"/>',
  '        <triangle v1="0" v2="1" v3="3" paint_supports="8"/>',
  '        <triangle v1="0" v2="2" v3="3" paint_supports="1C84"/>',
  '      </triangles>',
  '    </mesh></object>',
  '  </resources>',
  '</model>'
].join('\n')

test('applyTrianglePaintToModelEntry rewrites only mapped objects and triangles', () => {
  const painted = applyTrianglePaintToModelEntry(
    PAINT_OBJECT_ENTRY_XML,
    'paint_supports',
    new Map([[1, { 0: '4', 2: '1C84' }]])
  )
  // Triangle 0 gains enforcer paint, triangle 1's old blocker paint is stripped (absent
  // from the map), and triangle 2's sub-triangle split code is preserved verbatim.
  assert.match(painted, /<triangle v1="0" v2="1" v3="2" paint_supports="4"\/>/)
  assert.match(painted, /<triangle v1="0" v2="1" v3="3"\/>/)
  assert.match(painted, /<triangle v1="0" v2="2" v3="3" paint_supports="1C84"\/>/)
  // An entry with no mapped object is returned byte-for-byte.
  assert.equal(applyTrianglePaintToModelEntry(PAINT_OBJECT_ENTRY_XML, 'paint_supports', new Map([[99, { 0: '4' }]])), PAINT_OBJECT_ENTRY_XML)
})

test('applyTrianglePaintToModelEntry seam channel leaves support paint intact', () => {
  const painted = applyTrianglePaintToModelEntry(
    PAINT_OBJECT_ENTRY_XML,
    'paint_seam',
    new Map([[1, { 0: '4', 1: '8' }]])
  )
  // Seam paint lands on its own attribute; existing support paint is untouched.
  assert.match(painted, /<triangle v1="0" v2="1" v3="2" paint_seam="4"\/>/)
  assert.match(painted, /<triangle v1="0" v2="1" v3="3" paint_supports="8" paint_seam="8"\/>/)
  assert.match(painted, /<triangle v1="0" v2="2" v3="3" paint_supports="1C84"\/>/)
})

test('writeArrangedThreeMf bakes support paint into the painted part\'s mesh entry only', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-paint-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'painted.3mf')
  try {
    const lidEntryXml = PAINT_OBJECT_ENTRY_XML.replaceAll('id="1"', 'id="2"')
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['3D/Objects/object_3.model', Buffer.from(PAINT_OBJECT_ENTRY_XML, 'utf8')],
      ['3D/Objects/object_11.model', Buffer.from(lidEntryXml, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')]
    ])

    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: 3, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        { objectId: 11, plateIndex: 1, position: { x: 20, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ],
      // Box (object 3 -> component object 1 in its sub-entry): enforce triangle 0,
      // erase triangle 1, keep nothing else; seam-paint triangle 1.
      supportPaint: [{ objectId: 3, componentObjectId: 1, triangles: { 0: '4' } }],
      seamPaint: [{ objectId: 3, componentObjectId: 1, triangles: { 1: '4' } }]
    }
    await writeArrangedThreeMf(sourcePath, outputPath, edit)

    const paintedEntry = (await readEntry(outputPath, '3D/Objects/object_3.model')).toString('utf8')
    assert.match(paintedEntry, /<triangle v1="0" v2="1" v3="2" paint_supports="4"\/>/)
    assert.match(paintedEntry, /<triangle v1="0" v2="1" v3="3" paint_seam="4"\/>/)
    assert.doesNotMatch(paintedEntry, /paint_supports="8"/)
    assert.doesNotMatch(paintedEntry, /paint_supports="1C84"/)

    // The unpainted object's mesh entry is copied verbatim, keeping its source paint.
    const untouchedEntry = (await readEntry(outputPath, '3D/Objects/object_11.model')).toString('utf8')
    assert.equal(untouchedEntry, lidEntryXml)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('brim ear points serialize to Bambu object ordinals and parse back by object id', () => {
  const out = serializeBrimEarPoints(
    [{ objectId: 11, points: [{ x: 1, y: 2, z: 0.5, radius: 4 }] }],
    ARRANGE_MODEL_XML
  )
  // Object 11 is the SECOND root <object> resource, so it serializes as ordinal 2.
  assert.equal(out, 'brim_points_format_version=0\nobject_id=2|1.000000 2.000000 0.500000 4.000000\n')
  const parsed = parseBrimEarPoints(out, ARRANGE_MODEL_XML)
  assert.deepEqual(parsed.get(11), [{ x: 1, y: 2, z: 0.5, radius: 4 }])
  // Nothing to serialize -> empty content (clears the sidecar file).
  assert.equal(serializeBrimEarPoints([], ARRANGE_MODEL_XML), '')
  assert.equal(serializeBrimEarPoints([{ objectId: 3, points: [] }], ARRANGE_MODEL_XML), '')
})

test('brim ear ordinals count only build-placed roots, not injected import component objects', () => {
  // A multi-solid import: component mesh objects (50, 51) precede the placed root (52); only the
  // root has a build <item>. The root's ordinal must be 1 — the components must not shift it.
  const model = [
    '<model><resources>',
    '<object id="50" type="model"><mesh/></object>',
    '<object id="51" type="model"><mesh/></object>',
    '<object id="52" type="model"><components><component objectid="50"/><component objectid="51"/></components></object>',
    '</resources><build>',
    '<item objectid="52" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
    '</build></model>'
  ].join('')
  const out = serializeBrimEarPoints([{ objectId: 52, points: [{ x: 0, y: 0, z: 0, radius: 3 }] }], model)
  assert.equal(out, 'brim_points_format_version=0\nobject_id=1|0.000000 0.000000 0.000000 3.000000\n')
  assert.deepEqual(parseBrimEarPoints(out, model).get(52), [{ x: 0, y: 0, z: 0, radius: 3 }])
})

test('writeArrangedThreeMf writes brim ears and readSceneManifest exposes them', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-ears-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'ears.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')]
    ])
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: 3, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        { objectId: 11, plateIndex: 1, position: { x: 20, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ],
      brimEars: [{ objectId: 3, points: [{ x: -5, y: 5, z: 0, radius: 4 }] }]
    }
    await writeArrangedThreeMf(sourcePath, outputPath, edit)

    const sidecar = (await readEntry(outputPath, 'Metadata/brim_ear_points.txt')).toString('utf8')
    assert.equal(sidecar, 'brim_points_format_version=0\nobject_id=1|-5.000000 5.000000 0.000000 4.000000\n')

    const scene = await readSceneManifest(outputPath, 1)
    assert.deepEqual(scene.instances.find((entry) => entry.objectId === 3)?.brimEars, [{ x: -5, y: 5, z: 0, radius: 4 }])
    assert.equal(scene.instances.find((entry) => entry.objectId === 11)?.brimEars, undefined)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('writeArrangedThreeMf writes layer pauses and readSceneManifest exposes them', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-pauses-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'pauses.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')]
    ])
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: 3, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ],
      pauses: [{ plateIndex: 1, pauses: [{ z: 5.6 }] }]
    }
    await writeArrangedThreeMf(sourcePath, outputPath, edit)

    const sidecar = (await readEntry(outputPath, 'Metadata/custom_gcode_per_layer.xml')).toString('utf8')
    assert.match(sidecar, /<layer top_z="5.6" type="1" extruder="1" color="" extra="" gcode="M400 U1"\/>/)

    const scene = await readSceneManifest(outputPath, 1)
    assert.deepEqual(scene.pauses, [{ z: 5.6 }])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

const CUSTOM_GCODE_SOURCE_XML = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<custom_gcodes_per_layer>',
  '<plate>',
  '<plate_info id="1"/>',
  '<layer top_z="4" type="2" extruder="2" color="#FF0000" extra="" gcode="tool_change"/>',
  '<layer top_z="9" type="1" extruder="1" color="" extra="pause here" gcode="M400 U1"/>',
  '<mode value="MultiAsSingle"/>',
  '</plate>',
  '<plate>',
  '<plate_info id="2"/>',
  '<layer top_z="2.4" type="2" extruder="3" color="#0000FF" extra="" gcode="tool_change"/>',
  '<mode value="MultiAsSingle"/>',
  '</plate>',
  '</custom_gcodes_per_layer>'
].join('\n')

test('mergeCustomGcodePerLayer replaces edited plates, preserves pauses and other plates', () => {
  const merged = mergeCustomGcodePerLayer(CUSTOM_GCODE_SOURCE_XML, [
    { plateIndex: 1, changes: [{ z: 6.2, filamentId: 4, color: '#00FF00' }] }
  ])
  // Plate 1: the old tool change is replaced, the pause entry survives.
  assert.match(merged, /<layer top_z="6.2" type="2" extruder="4" color="#00FF00" extra="" gcode="tool_change"\/>/)
  assert.doesNotMatch(merged, /extruder="2"/)
  assert.match(merged, /<layer top_z="9" type="1" extruder="1" color="" extra="pause here" gcode="M400 U1"\/>/)
  // Plate 2 is untouched.
  assert.match(merged, /<layer top_z="2.4" type="2" extruder="3" color="#0000FF" extra="" gcode="tool_change"\/>/)

  // Editing a plate to empty clears only its tool changes; clearing everything with no
  // other entries empties the sidecar.
  const cleared = mergeCustomGcodePerLayer(CUSTOM_GCODE_SOURCE_XML, [
    { plateIndex: 1, changes: [] },
    { plateIndex: 2, changes: [] }
  ])
  assert.doesNotMatch(cleared, /tool_change/)
  assert.match(cleared, /pause here/)
  assert.equal(mergeCustomGcodePerLayer(null, [{ plateIndex: 1, changes: [] }]), '')

  // Creating from nothing produces a fresh sidecar the reader round-trips.
  const fresh = mergeCustomGcodePerLayer(null, [{ plateIndex: 1, changes: [{ z: 3, filamentId: 2, color: '#FFFF00' }] }])
  assert.deepEqual(parseCustomGcodeToolChanges(fresh, 1), [{ z: 3, filamentId: 2, color: '#FFFF00' }])
  assert.deepEqual(parseCustomGcodeToolChanges(fresh, 2), [])
})

test('parseCustomGcodeToolChanges reads only the requested plate and tool changes', () => {
  assert.deepEqual(parseCustomGcodeToolChanges(CUSTOM_GCODE_SOURCE_XML, 1), [{ z: 4, filamentId: 2, color: '#FF0000' }])
  assert.deepEqual(parseCustomGcodeToolChanges(CUSTOM_GCODE_SOURCE_XML, 2), [{ z: 2.4, filamentId: 3, color: '#0000FF' }])
  assert.deepEqual(parseCustomGcodeToolChanges(null, 1), [])
})

test('mergeCustomGcodePerLayer replaces edited plates\' pauses, preserves tool changes', () => {
  const merged = mergeCustomGcodePerLayer(CUSTOM_GCODE_SOURCE_XML, undefined, [
    { plateIndex: 1, pauses: [{ z: 12.4 }, { z: 3.2 }] }
  ])
  // Plate 1: the old pause is replaced by the two new ones; the tool change survives.
  assert.doesNotMatch(merged, /pause here/)
  assert.match(merged, /<layer top_z="3.2" type="1" extruder="1" color="" extra="" gcode="M400 U1"\/>/)
  assert.match(merged, /<layer top_z="12.4" type="1" extruder="1" color="" extra="" gcode="M400 U1"\/>/)
  assert.match(merged, /<layer top_z="4" type="2" extruder="2" color="#FF0000" extra="" gcode="tool_change"\/>/)
  // Entries emit in ascending top_z order within the plate (BambuStudio keeps ticks sorted).
  assert.ok(merged.indexOf('top_z="3.2"') < merged.indexOf('top_z="4"'))
  assert.ok(merged.indexOf('top_z="4"') < merged.indexOf('top_z="12.4"'))
  // Plate 2 is untouched.
  assert.match(merged, /<layer top_z="2.4" type="2" extruder="3" color="#0000FF" extra="" gcode="tool_change"\/>/)

  // Clearing a plate's pauses keeps its tool changes.
  const cleared = mergeCustomGcodePerLayer(CUSTOM_GCODE_SOURCE_XML, undefined, [{ plateIndex: 1, pauses: [] }])
  assert.doesNotMatch(cleared, /type="1"/)
  assert.match(cleared, /<layer top_z="4" type="2"/)

  // Editing filament changes and pauses in one merge composes on the same plate.
  const both = mergeCustomGcodePerLayer(
    CUSTOM_GCODE_SOURCE_XML,
    [{ plateIndex: 1, changes: [{ z: 6.2, filamentId: 4 }] }],
    [{ plateIndex: 1, pauses: [{ z: 8 }] }]
  )
  assert.deepEqual(parseCustomGcodeToolChanges(both, 1), [{ z: 6.2, filamentId: 4, color: null }])
  assert.deepEqual(parseCustomGcodePauses(both, 1), [{ z: 8 }])

  // Creating from nothing produces a fresh sidecar the pause parser round-trips.
  const fresh = mergeCustomGcodePerLayer(null, undefined, [{ plateIndex: 2, pauses: [{ z: 5.6 }] }])
  assert.deepEqual(parseCustomGcodePauses(fresh, 2), [{ z: 5.6 }])
  assert.deepEqual(parseCustomGcodePauses(fresh, 1), [])
  assert.equal(mergeCustomGcodePerLayer(null, undefined, [{ plateIndex: 1, pauses: [] }]), '')
})

test('parseCustomGcodePauses reads only the requested plate\'s pause entries', () => {
  assert.deepEqual(parseCustomGcodePauses(CUSTOM_GCODE_SOURCE_XML, 1), [{ z: 9 }])
  assert.deepEqual(parseCustomGcodePauses(CUSTOM_GCODE_SOURCE_XML, 2), [])
  assert.deepEqual(parseCustomGcodePauses(null, 1), [])
})

test('buildThreeMfIndex surfaces per-plate filament changes and pauses from the custom G-code sidecar', () => {
  const index = buildThreeMfIndex(null, null, new Map([[1, 'Plate A'], [2, 'Plate B']]), new Map(), CUSTOM_GCODE_SOURCE_XML)
  const plateOne = index.plates.find((plate) => plate.index === 1)
  const plateTwo = index.plates.find((plate) => plate.index === 2)
  assert.deepEqual(plateOne?.filamentChanges, [{ z: 4, filamentId: 2 }])
  assert.deepEqual(plateOne?.pauses, [{ z: 9 }])
  assert.deepEqual(plateTwo?.filamentChanges, [{ z: 2.4, filamentId: 3 }])
  // No pause entries on plate 2 → the field is omitted, not an empty array.
  assert.equal(plateTwo?.pauses, undefined)
  // No sidecar at all → nothing attaches.
  const bare = buildThreeMfIndex(null, null, new Map([[1, 'Plate A']]), new Map(), null)
  assert.equal(bare.plates[0]?.filamentChanges, undefined)
})

test('createObjectCustomizedThreeMf applies slice-time layer G-code edits, upserting a missing sidecar', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-gcode-edit-'))
  try {
    // Source WITH a sidecar: the edit replaces plate 1's tool change, keeps its pause.
    const withSidecar = path.join(tempDir, 'with.3mf')
    const withOut = path.join(tempDir, 'with-out.3mf')
    await writeZipFixture(withSidecar, [
      ['Metadata/model_settings.config', Buffer.from(OBJECT_MODEL_SETTINGS_XML, 'utf8')],
      ['Metadata/custom_gcode_per_layer.xml', Buffer.from(CUSTOM_GCODE_SOURCE_XML, 'utf8')]
    ])
    await createObjectCustomizedThreeMf(withSidecar, withOut, 1, {
      customGcode: { filamentChanges: [{ plateIndex: 1, changes: [{ z: 6.2, filamentId: 4, color: '#00FF00' }] }] }
    })
    const merged = (await readEntry(withOut, 'Metadata/custom_gcode_per_layer.xml')).toString('utf8')
    assert.deepEqual(parseCustomGcodeToolChanges(merged, 1), [{ z: 6.2, filamentId: 4, color: '#00FF00' }])
    assert.deepEqual(parseCustomGcodePauses(merged, 1), [{ z: 9 }])
    // Unlisted plate 2 is preserved verbatim.
    assert.deepEqual(parseCustomGcodeToolChanges(merged, 2), [{ z: 2.4, filamentId: 3, color: '#0000FF' }])

    // Source WITHOUT a sidecar: the entry is created (append path).
    const bare = path.join(tempDir, 'bare.3mf')
    const bareOut = path.join(tempDir, 'bare-out.3mf')
    await writeZipFixture(bare, [
      ['Metadata/model_settings.config', Buffer.from(OBJECT_MODEL_SETTINGS_XML, 'utf8')]
    ])
    await createObjectCustomizedThreeMf(bare, bareOut, 1, {
      customGcode: { pauses: [{ plateIndex: 1, pauses: [{ z: 5.6 }] }] }
    })
    const created = (await readEntry(bareOut, 'Metadata/custom_gcode_per_layer.xml')).toString('utf8')
    assert.deepEqual(parseCustomGcodePauses(created, 1), [{ z: 5.6 }])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

const FILAMENT_MODEL_SETTINGS_XML = [
  '<config>',
  '  <object id="3"><metadata key="name" value="Box"/><part id="1" subtype="normal_part"><metadata key="name" value="Box part"/><metadata key="extruder" value="2"/></part></object>',
  '  <plate>',
  '    <metadata key="plater_id" value="1"/>',
  '    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/></model_instance>',
  '  </plate>',
  '</config>'
].join('\n')

const FILAMENT_PROJECT_SETTINGS_JSON = JSON.stringify({
  filament_colour: ['#FF0000', '#00FF00'],
  filament_type: ['PLA', 'PETG'],
  filament_settings_id: ['Bambu PLA Basic', 'Generic PETG'],
  nozzle_temperature: ['220', '240'],
  flush_volumes_matrix: [0, 280, 280, 0]
})

async function readProjectSettings(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse((await readEntry(filePath, 'Metadata/project_settings.config')).toString('utf8')) as Record<string, unknown>
}

test('writeArrangedThreeMf adds a filament: parallel arrays grow, new slot clones its sourceIndex, flush matrix rebuilds', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-filadd-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'added.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(FILAMENT_MODEL_SETTINGS_XML, 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(FILAMENT_PROJECT_SETTINGS_JSON, 'utf8')]
    ])
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: 3, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ],
      filaments: [
        { color: '#FF0000', type: 'PLA' },
        { color: '#00FF00', type: 'PETG' },
        { color: '#0000FF', type: 'PLA', sourceIndex: 0 }
      ]
    }
    await writeArrangedThreeMf(sourcePath, outputPath, edit)

    const settings = await readProjectSettings(outputPath)
    assert.deepEqual(settings.filament_colour, ['#FF0000', '#00FF00', '#0000FF'])
    assert.deepEqual(settings.filament_type, ['PLA', 'PETG', 'PLA'])
    // The cloned slot inherits filament_settings_id + temperature from sourceIndex 0.
    assert.deepEqual(settings.filament_settings_id, ['Bambu PLA Basic', 'Generic PETG', 'Bambu PLA Basic'])
    assert.deepEqual(settings.nozzle_temperature, ['220', '240', '220'])
    // 2x2 -> 3x3 flush matrix, row/col cloned from [0,1,0].
    assert.deepEqual(settings.flush_volumes_matrix, [0, 280, 0, 280, 0, 280, 0, 280, 0])
    // The Box part used material 2, which is kept -> its extruder stays 2 (not remapped).
    const config = (await readEntry(outputPath, 'Metadata/model_settings.config')).toString('utf8')
    assert.match(config, /<metadata key="extruder" value="2"\/>/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('writeArrangedThreeMf removes a filament: arrays shrink and parts reassign to material 1', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-filrm-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'removed.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(FILAMENT_MODEL_SETTINGS_XML, 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(FILAMENT_PROJECT_SETTINGS_JSON, 'utf8')]
    ])
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: 3, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ],
      // Keep only the first filament (drop filament 2).
      filaments: [{ color: '#FF0000', type: 'PLA' }]
    }
    await writeArrangedThreeMf(sourcePath, outputPath, edit)

    const settings = await readProjectSettings(outputPath)
    assert.deepEqual(settings.filament_colour, ['#FF0000'])
    assert.deepEqual(settings.filament_type, ['PLA'])
    assert.deepEqual(settings.filament_settings_id, ['Bambu PLA Basic'])
    assert.deepEqual(settings.flush_volumes_matrix, [0])

    // The Box part referenced extruder 2, which no longer exists -> clamped to 1.
    const config = (await readEntry(outputPath, 'Metadata/model_settings.config')).toString('utf8')
    assert.match(config, /<metadata key="extruder" value="1"\/>/)
    assert.doesNotMatch(config, /<metadata key="extruder" value="2"\/>/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('writeArrangedThreeMf persists a material profile change: filament_settings_id + type follow the desired list', async () => {
  // Regression: changing a material (e.g. PLA -> PETG) without adding/removing slots used to be
  // dropped — `filament_settings_id` was never written, so the saved project kept the old preset
  // (with a name/type mismatch) and reopened as the previous material.
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-filprofile-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'reprofiled.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(FILAMENT_MODEL_SETTINGS_XML, 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(FILAMENT_PROJECT_SETTINGS_JSON, 'utf8')]
    ])
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: 3, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ],
      // Same slot count; slot 1 switches PLA -> PETG, slot 2 carries no explicit id (keeps its own).
      filaments: [
        { color: '#FF0000', type: 'PETG', settingsId: 'Bambu PETG HF @BBL H2D 0.4 nozzle' },
        { color: '#00FF00', type: 'PETG' }
      ]
    }
    await writeArrangedThreeMf(sourcePath, outputPath, edit)

    const settings = await readProjectSettings(outputPath)
    assert.deepEqual(settings.filament_type, ['PETG', 'PETG'])
    // Slot 1 takes the new preset; slot 2 keeps its existing id (no explicit settingsId).
    assert.deepEqual(settings.filament_settings_id, ['Bambu PETG HF @BBL H2D 0.4 nozzle', 'Generic PETG'])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('saving from a settings-less new-project scaffold synthesizes project_settings.config (materials + plate type survive)', async () => {
  // Regression: a new-project scaffold carries no Metadata/project_settings.config, and the
  // filament/plate-type rewrites used to be registered only as copy-pass transforms of an
  // EXISTING entry — so the first save of a new project silently dropped the chosen material
  // and plate type, and the project reopened with defaults.
  const { buildEditedThreeMf } = await import('./three-mf.js')
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-scaffold-'))
  const scaffoldPath = path.join(tempDir, 'scaffold.3mf')
  const savedPath = path.join(tempDir, 'saved.3mf')
  try {
    // The scaffold exactly as POST /api/editor/new-project builds it: from scratch, empty edit.
    await buildEditedThreeMf(null, scaffoldPath, { plates: [{ index: 1 }], instances: [] }, [])
    await assert.rejects(readEntry(scaffoldPath, 'Metadata/project_settings.config'))

    // First save: a material and a plate type were chosen in the editor.
    const edit: SceneEdit = {
      plates: [{ index: 1, plateType: 'textured_pei_plate' }],
      instances: [],
      filaments: [{ color: '#00AE42', type: 'PLA', settingsId: 'Bambu PLA Basic @BBL P1P' }]
    }
    await buildEditedThreeMf(scaffoldPath, savedPath, edit, [])

    const settings = await readProjectSettings(savedPath)
    assert.deepEqual(settings.filament_colour, ['#00AE42'])
    assert.deepEqual(settings.filament_type, ['PLA'])
    assert.deepEqual(settings.filament_settings_id, ['Bambu PLA Basic @BBL P1P'])
    // Canonicalized to BambuStudio's serialized enum value.
    assert.equal(settings.curr_bed_type, 'Textured PEI Plate')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('a from-scratch build with filaments embeds project_settings.config directly', async () => {
  const { buildEditedThreeMf } = await import('./three-mf.js')
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-freshsettings-'))
  const outputPath = path.join(tempDir, 'fresh.3mf')
  try {
    const edit: SceneEdit = {
      plates: [{ index: 1, plateType: 'cool_plate' }],
      instances: [],
      filaments: [{ color: '#112233', type: 'PETG' }]
    }
    await buildEditedThreeMf(null, outputPath, edit, [])
    const settings = await readProjectSettings(outputPath)
    assert.deepEqual(settings.filament_colour, ['#112233'])
    assert.equal(settings.curr_bed_type, 'Cool Plate')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('writeArrangedThreeMf persists a plate-type change on a project with existing settings', async () => {
  // Regression: no save path ever wrote `curr_bed_type`, so a plate-type change in the editor
  // was lost on reopen even for projects WITH embedded settings (the source value was copied
  // verbatim and won).
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-platetype-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'replated.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(FILAMENT_MODEL_SETTINGS_XML, 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(FILAMENT_PROJECT_SETTINGS_JSON, 'utf8')]
    ])
    const edit: SceneEdit = {
      plates: [{ index: 1, plateType: 'Cool Plate' }],
      instances: [
        { objectId: 3, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ]
    }
    await writeArrangedThreeMf(sourcePath, outputPath, edit)
    const settings = await readProjectSettings(outputPath)
    assert.equal(settings.curr_bed_type, 'Cool Plate')
    // The rest of the settings survive the rewrite untouched.
    assert.deepEqual(settings.filament_colour, ['#FF0000', '#00FF00'])
    assert.deepEqual(settings.nozzle_temperature, ['220', '240'])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('rewriteThreeMfEntries upserts appendEntries: appended when absent, transform wins when present', async () => {
  // The machine-retarget write path relies on this to give a settings-less scaffold save its
  // project_settings.config while never duplicating the entry on a normal project.
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-upsert-'))
  const withoutPath = path.join(tempDir, 'without.3mf')
  const withPath = path.join(tempDir, 'with.3mf')
  const appendedPath = path.join(tempDir, 'appended.3mf')
  const transformedPath = path.join(tempDir, 'transformed.3mf')
  try {
    const entryName = 'Metadata/project_settings.config'
    await writeZipFixture(withoutPath, [['3D/3dmodel.model', Buffer.from('<model/>', 'utf8')]])
    await rewriteThreeMfEntries(withoutPath, appendedPath, {}, [{ name: entryName, content: '{"appended":true}' }])
    assert.equal((await readEntry(appendedPath, entryName)).toString('utf8'), '{"appended":true}')

    await writeZipFixture(withPath, [
      ['3D/3dmodel.model', Buffer.from('<model/>', 'utf8')],
      [entryName, Buffer.from('{"original":true}', 'utf8')]
    ])
    await rewriteThreeMfEntries(
      withPath,
      transformedPath,
      { [entryName]: () => '{"transformed":true}' },
      [{ name: entryName, content: '{"appended":true}' }]
    )
    assert.equal((await readEntry(transformedPath, entryName)).toString('utf8'), '{"transformed":true}')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('buildEditedThreeMf creates a new-project 3MF with an injected imported mesh placed on a plate', async () => {
  const { buildEditedThreeMf } = await import('./three-mf.js')
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-import-'))
  const outputPath = path.join(tempDir, 'new-project.3mf')
  try {
    // A flat quad (two triangles) as a stand-in imported mesh.
    const mesh = {
      positions: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0],
      indices: [0, 1, 2, 0, 2, 3],
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } }
    }
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { importId: 'imp-1', plateIndex: 1, position: { x: 10, y: 20, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ]
    }
    await buildEditedThreeMf(null, outputPath, edit, [{ importId: 'imp-1', name: 'Imported Cube', mesh }])

    // The standalone 3MF parses back: one plate, one instance, placed where we asked.
    const scene = await readSceneManifest(outputPath, 1)
    assert.equal(scene.instances.length, 1)
    const instance = scene.instances[0]
    assert.ok(Math.abs((instance?.transform[9] ?? 0) - 10) < 1e-3)
    assert.ok(Math.abs((instance?.transform[10] ?? 0) - 20) < 1e-3)
    // Geometry is inlined in the root model entry.
    assert.equal(instance?.parts[0]?.entryPath, '3D/3dmodel.model')
    const modelXml = (await readEntry(outputPath, '3D/3dmodel.model')).toString('utf8')
    assert.match(modelXml, /<mesh>/)
    assert.match(modelXml, /<triangle v1="0" v2="1" v3="2"\/>/)
    // A minimal valid 3MF carries the OPC content-types part.
    const contentTypes = (await readEntry(outputPath, '[Content_Types].xml')).toString('utf8')
    assert.match(contentTypes, /3dmodel/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('buildEditedThreeMf bakes a multi-solid import as one object with many normal parts', async () => {
  const { buildEditedThreeMf } = await import('./three-mf.js')
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-import-multipart-'))
  const outputPath = path.join(tempDir, 'assembly.3mf')
  try {
    const quad = (z: number) => ({
      positions: [0, 0, z, 10, 0, z, 10, 10, z, 0, 10, z],
      indices: [0, 1, 2, 0, 2, 3],
      bounds: { min: { x: 0, y: 0, z }, max: { x: 10, y: 10, z } }
    })
    const mesh = { ...quad(0), parts: [
      { name: 'Cylinder', mesh: quad(0) },
      { name: 'Hole modifier 1', mesh: quad(5) }
    ] }
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { importId: 'imp-1', plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, filamentId: 1 }
      ],
      // The second solid takes its own material; the first inherits the object's (filament 1).
      importPartFilaments: [{ importId: 'imp-1', partIndex: 1, filamentId: 3 }],
      // Per-part process override set on the (still unsaved) import's second solid.
      importPartProcessOverrides: [{ importId: 'imp-1', partIndex: 1, overrides: { sparse_infill_density: '99%' } }]
    }
    await buildEditedThreeMf(null, outputPath, edit, [{ importId: 'imp-1', name: 'CHM Cylinder', mesh, parts: mesh.parts }])

    const modelXml = (await readEntry(outputPath, '3D/3dmodel.model')).toString('utf8')
    // One root object that references both solids as components (no mesh of its own).
    const componentIds = [...modelXml.matchAll(/<component objectid="(\d+)"/g)].map((m) => m[1])
    assert.equal(componentIds.length, 2)
    // Both solids exist as mesh objects.
    assert.equal((modelXml.match(/<mesh>/g) ?? []).length, 2)
    // Exactly one build item — the assembly places as a single object.
    assert.equal((modelXml.match(/<item objectid=/g) ?? []).length, 1)

    const settingsXml = (await readEntry(outputPath, 'Metadata/model_settings.config')).toString('utf8')
    const partNames = [...settingsXml.matchAll(/<part id="\d+" subtype="normal_part">\s*<metadata key="name" value="([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(partNames, ['Cylinder', 'Hole modifier 1'])
    // Each solid keeps its own material: first inherits the object filament (1), second is 3.
    const extruders = [...settingsXml.matchAll(/<part\b[\s\S]*?<metadata key="extruder" value="(\d+)"/g)].map((m) => m[1])
    assert.deepEqual(extruders, ['1', '3'])

    // The scene reader sees one instance made of two parts.
    const scene = await readSceneManifest(outputPath, 1)
    assert.equal(scene.instances.length, 1)
    assert.equal(scene.instances[0]?.parts.length, 2)
    // The import's per-part process override baked onto the second solid (and re-hydrates).
    assert.deepEqual(scene.instances[0]?.parts[1]?.processOverrides, { sparse_infill_density: '99%' })
    assert.equal(scene.instances[0]?.parts[0]?.processOverrides, undefined)

    // Re-open + re-save flow: the baked import is now an in-project object. Editing a part's
    // process settings and saving again must persist — and the parts must keep their names.
    const bakedObjectId = scene.instances[0]!.objectId
    const bakedParts = scene.instances[0]!.parts
    assert.ok(bakedParts.every((part) => part.componentObjectId > 0), 'parts have baked component ids')
    const reEdit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: bakedObjectId, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ],
      partProcessOverrides: [
        { objectId: bakedObjectId, componentObjectId: bakedParts[1]!.componentObjectId, overrides: { sparse_infill_density: '99%' } }
      ]
    }
    const reOutput = path.join(tempDir, 'reedited.3mf')
    await buildEditedThreeMf(outputPath, reOutput, reEdit, [])
    const reScene = await readSceneManifest(reOutput, 1)
    const reParts = reScene.instances[0]?.parts ?? []
    // The same parts survive the re-save (component ids preserved).
    assert.deepEqual(reParts.map((part) => part.componentObjectId), bakedParts.map((part) => part.componentObjectId))
    // The per-part process override persisted onto the matching part.
    const overridden = reParts.find((part) => part.componentObjectId === bakedParts[1]!.componentObjectId)
    assert.deepEqual(overridden?.processOverrides, { sparse_infill_density: '99%' })
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('buildEditedThreeMf preserves source identify_ids and mints fresh ones for new instances', async () => {
  // identify_id is the CLI's per-instance handle (`loaded_id`) — the only key `--skip-objects`
  // accepts. The bake must carry the source ids through (and mint unique ones for duplicates)
  // or per-object/instance exclusion silently stops working on every editor-rewritten project.
  const { buildEditedThreeMf } = await import('./three-mf.js')
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-identify-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'edited.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['Metadata/model_settings.config', Buffer.from(OBJECT_MODEL_SETTINGS_XML, 'utf8')],
      ['3D/3dmodel.model', Buffer.from(OBJECT_MODEL_3DMODEL_XML, 'utf8')]
    ])
    const place = (x: number) => ({ position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } })
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: 3, plateIndex: 1, ...place(-40) },
        // A second copy of object 3 added this session (no source identify_id to preserve),
        // toggled unprintable so the skip path has something to key on.
        { objectId: 3, plateIndex: 1, ...place(0), printable: false },
        { objectId: 11, plateIndex: 1, ...place(40) }
      ]
    }
    await buildEditedThreeMf(sourcePath, outputPath, edit, [])

    const settingsXml = (await readEntry(outputPath, 'Metadata/model_settings.config')).toString('utf8')
    const instances = [...settingsXml.matchAll(/<model_instance>[\s\S]*?<\/model_instance>/g)].map((match) => ({
      objectId: Number(/object_id" value="(\d+)"/.exec(match[0])?.[1]),
      instanceId: Number(/instance_id" value="(\d+)"/.exec(match[0])?.[1]),
      identifyId: Number(/identify_id" value="(\d+)"/.exec(match[0])?.[1])
    }))
    // Returning instances keep their source ids (object 3 instance 0 -> 153, object 11 -> 204).
    assert.equal(instances.find((entry) => entry.objectId === 3 && entry.instanceId === 0)?.identifyId, 153)
    assert.equal(instances.find((entry) => entry.objectId === 11 && entry.instanceId === 0)?.identifyId, 204)
    // The new duplicate gets a fresh id above the source maximum, and all ids are unique.
    const duplicate = instances.find((entry) => entry.objectId === 3 && entry.instanceId === 1)
    assert.ok((duplicate?.identifyId ?? 0) > 204, 'new instance id is minted above the source maximum')
    assert.equal(new Set(instances.map((entry) => entry.identifyId)).size, instances.length)
    // The unprintable duplicate's build item carries printable="0" — with the identify_id above,
    // the slicer's --skip-objects translation can now enforce the editor's Printable toggle.
    const modelXml = (await readEntry(outputPath, '3D/3dmodel.model')).toString('utf8')
    const object3Items = [...modelXml.matchAll(/<item objectid="3"[^>]*\/>/g)].map((match) => match[0])
    assert.equal(object3Items.length, 2)
    assert.match(object3Items[1]!, /printable="0"/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('buildEditedThreeMf applies part-type changes on baked parts and import solids', async () => {
  const { buildEditedThreeMf } = await import('./three-mf.js')
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-parttype-'))
  const outputPath = path.join(tempDir, 'assembly.3mf')
  try {
    const quad = (z: number) => ({
      positions: [0, 0, z, 10, 0, z, 10, 10, z, 0, 10, z],
      indices: [0, 1, 2, 0, 2, 3],
      bounds: { min: { x: 0, y: 0, z }, max: { x: 10, y: 10, z } }
    })
    const mesh = { ...quad(0), parts: [
      { name: 'Cylinder', mesh: quad(0) },
      { name: 'Hole modifier', mesh: quad(5) }
    ] }
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { importId: 'imp-1', plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ],
      // "Change type" on the unsaved import's second solid: bake it as a modifier volume.
      importPartTypes: [{ importId: 'imp-1', partIndex: 1, subtype: 'modifier_part' }]
    }
    await buildEditedThreeMf(null, outputPath, edit, [{ importId: 'imp-1', name: 'CHM Cylinder', mesh, parts: mesh.parts }])

    const settingsXml = (await readEntry(outputPath, 'Metadata/model_settings.config')).toString('utf8')
    const subtypes = [...settingsXml.matchAll(/<part id="\d+" subtype="([^"]+)">/g)].map((match) => match[1])
    assert.deepEqual(subtypes, ['normal_part', 'modifier_part'])

    // The scene reader re-hydrates the subtype, and a later save can change a BAKED part's type.
    const scene = await readSceneManifest(outputPath, 1)
    const parts = scene.instances[0]!.parts
    assert.equal(parts[1]?.subtype, 'modifier_part')
    const reEdit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: scene.instances[0]!.objectId, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ],
      partTypeChanges: [
        { objectId: scene.instances[0]!.objectId, componentObjectId: parts[1]!.componentObjectId, subtype: 'support_enforcer' },
        { objectId: scene.instances[0]!.objectId, componentObjectId: parts[0]!.componentObjectId, subtype: 'negative_part' }
      ]
    }
    const reOutput = path.join(tempDir, 'reedited.3mf')
    await buildEditedThreeMf(outputPath, reOutput, reEdit, [])
    const reScene = await readSceneManifest(reOutput, 1)
    const reParts = reScene.instances[0]!.parts
    assert.equal(reParts.find((part) => part.componentObjectId === parts[0]!.componentObjectId)?.subtype, 'negative_part')
    assert.equal(reParts.find((part) => part.componentObjectId === parts[1]!.componentObjectId)?.subtype, 'support_enforcer')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('buildEditedThreeMf stamps p:UUID on injected nodes for a production-extension project, but not for a core 3MF', async () => {
  // Bambu Studio's GUI rejects a saved project ("The file does not contain any geometry data") when a
  // requiredextensions="p" model has editor-injected objects/components without a p:UUID — its parser
  // tolerates the absence but the GUI volume builder drops UUID-less nodes (the CLI slices it fine,
  // which is why this only showed up on GUI open). A core 3MF (no production extension) must NOT gain
  // spurious UUIDs.
  const { buildEditedThreeMf } = await import('./three-mf.js')
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-uuid-'))
  const prodSource = path.join(tempDir, 'prod.3mf')
  const prodOutput = path.join(tempDir, 'prod-edited.3mf')
  const coreSource = path.join(tempDir, 'core.3mf')
  const coreOutput = path.join(tempDir, 'core-edited.3mf')
  try {
    const quad = (z: number) => ({
      positions: [0, 0, z, 10, 0, z, 10, 10, z, 0, 10, z],
      indices: [0, 1, 2, 0, 2, 3],
      bounds: { min: { x: 0, y: 0, z }, max: { x: 10, y: 10, z } }
    })
    const multiMesh = { ...quad(0), parts: [{ name: 'A', mesh: quad(0) }, { name: 'B', mesh: quad(5) }] }
    const uuidRe = /p:UUID="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/
    const importEdit = (importId: string): SceneEdit => ({
      plates: [{ index: 1 }],
      instances: [{ importId, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }]
    })

    // --- Production-extension base: injected nodes MUST get a p:UUID ---
    const prodModelXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">',
      '  <resources>',
      '    <object id="3" p:UUID="00000003-0000-0000-0000-000000000003" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>',
      '  </resources>',
      '  <build><item objectid="3" p:UUID="00000003-0000-0000-0000-0000000000aa" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/></build>',
      '</model>'
    ].join('\n')
    await writeZipFixture(prodSource, [
      ['3D/3dmodel.model', Buffer.from(prodModelXml, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <object id="3"><metadata key="name" value="Base"/></object>\n</config>', 'utf8')]
    ])
    await buildEditedThreeMf(prodSource, prodOutput, importEdit('imp-1'), [{ importId: 'imp-1', name: 'Import', mesh: multiMesh, parts: multiMesh.parts }])
    const prodXml = (await readEntry(prodOutput, '3D/3dmodel.model')).toString('utf8')
    // Split-part layout (production extension): the import's solids move to a /3D/Objects sub-model,
    // so the root model keeps only the small assembly object (components -> p:path) and has NO inline
    // import <mesh>. (base object 3 is swept as unreferenced.)
    assert.ok(!prodXml.includes('<mesh>'), 'root model carries no inline import mesh (solids split out)')
    const rootObjects = [...prodXml.matchAll(/<object id="(\d+)"([^>]*)>/g)]
    assert.equal(rootObjects.length, 1, 'root has exactly the assembly object')
    assert.match(rootObjects[0]![2]!, uuidRe, 'assembly object carries a p:UUID')
    // Components reference the split-out part file by p:path and carry a p:UUID.
    const components = prodXml.match(/<component\b[^>]*\/>/g) ?? []
    assert.equal(components.length, 2, 'assembly references both solids')
    const partPath = components[0]!.match(/p:path="([^"]+)"/)?.[1]
    assert.ok(partPath != null && /^\/3D\/Objects\/.+\.model$/.test(partPath), 'components use a /3D/Objects p:path')
    for (const componentTag of components) assert.match(componentTag, uuidRe, 'component carries a p:UUID')
    assert.match(prodXml, /<item objectid="\d+" p:UUID="[0-9a-f-]{36}" transform=/, 'build item carries a p:UUID')
    // The part file exists with both solids (each a mesh + p:UUID) and is declared in the sub-model rels.
    const partEntryName = partPath!.replace(/^\//, '')
    const partXml = (await readEntry(prodOutput, partEntryName)).toString('utf8')
    assert.equal((partXml.match(/<mesh>/g) ?? []).length, 2, 'both solids live in the part file')
    for (const objTag of partXml.match(/<object\b[^>]*>/g) ?? []) assert.match(objTag, uuidRe, 'part-file solid carries a p:UUID')
    const relsXml = (await readEntry(prodOutput, '3D/_rels/3dmodel.model.rels')).toString('utf8')
    assert.ok(relsXml.includes(`Target="/${partEntryName}"`), 'part file is declared in the sub-model rels')
    // Round-trip: the reader follows p:path into the part file and re-hydrates the two solids.
    const reScene = await readSceneManifest(prodOutput, 1)
    assert.equal(reScene.instances.length, 1, 're-hydrates one instance')
    assert.equal(reScene.instances[0]?.parts.length, 2, 'both solids re-hydrate from the part file')

    // --- Core (non-production) base: NO spurious p:UUID ---
    await writeZipFixture(coreSource, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')]
    ])
    await buildEditedThreeMf(coreSource, coreOutput, importEdit('imp-2'), [{ importId: 'imp-2', name: 'Plain', mesh: quad(0) }])
    const coreXml = (await readEntry(coreOutput, '3D/3dmodel.model')).toString('utf8')
    assert.equal(coreXml.includes('p:UUID='), false, 'a core 3MF must not gain injected p:UUIDs')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('per-object process overrides on a fresh import re-key onto the baked object and persist', async () => {
  // Mirrors the editor save path: a fresh import carries a synthetic (negative) object identity
  // as a meshReplacements entry; the override authored against that id must land on the baked
  // object_id in the saved model_settings.config.
  const { buildEditedThreeMf } = await import('./three-mf.js')
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-import-overrides-'))
  const outputPath = path.join(tempDir, 'new-project.3mf')
  const customizedPath = path.join(tempDir, 'customized.3mf')
  try {
    const mesh = {
      positions: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0],
      indices: [0, 1, 2, 0, 2, 3],
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } }
    }
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { importId: 'imp-1', plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ],
      // The editor renames the imported object and emits a meshReplacements entry so its
      // overrides re-key onto the baked object — both must survive a save (not just a slice).
      objectNames: [{ importId: 'imp-1', name: 'Spacer 2' }],
      meshReplacements: [{ objectId: -1, importId: 'imp-1' }]
    }
    const { replacedObjectIds } = await buildEditedThreeMf(null, outputPath, edit, [{ importId: 'imp-1', name: 'Spacer', mesh }])
    const baked = replacedObjectIds.find((entry) => entry.originalObjectId === -1)
    assert.ok(baked, 'the fresh import should report a synthetic→baked id mapping')

    // The rename is baked by buildEditedThreeMf itself.
    const bakedSettings = (await readEntry(outputPath, 'Metadata/model_settings.config')).toString('utf8')
    const bakedBlock = new RegExp(`<object id="${baked!.bakedObjectId}"[^>]*>[\\s\\S]*?</object>`).exec(bakedSettings)?.[0] ?? ''
    assert.match(bakedBlock, /<metadata key="name" value="Spacer 2"\/>/)
    // ...and the scene reader surfaces the renamed OBJECT name (not the import's part name) so the
    // rename round-trips into the editor on reopen.
    const reopened = await readSceneManifest(outputPath, 1)
    assert.equal(reopened.instances[0]?.name, 'Spacer 2')

    const rekeyed = rekeyReplacedObjectOverrides({ '-1': { wall_loops: '5' } }, replacedObjectIds)
    assert.deepEqual(rekeyed, { [String(baked!.bakedObjectId)]: { wall_loops: '5' } })

    await createObjectCustomizedThreeMf(outputPath, customizedPath, 0, { objectProcessOverrides: rekeyed })
    const settingsXml = (await readEntry(customizedPath, 'Metadata/model_settings.config')).toString('utf8')
    const objectBlock = new RegExp(`<object id="${baked!.bakedObjectId}"[^>]*>[\\s\\S]*?</object>`).exec(settingsXml)?.[0] ?? ''
    assert.match(objectBlock, /<metadata key="wall_loops" value="5"\/>/)
    // And the rename survives the override pass.
    assert.match(objectBlock, /<metadata key="name" value="Spacer 2"\/>/)
    // The scene reader surfaces the saved per-object override so the editor can re-seed its gear.
    const reopenedWithOverrides = await readSceneManifest(customizedPath, 1)
    assert.equal(reopenedWithOverrides.instances[0]?.processOverrides?.wall_loops, '5')
    // ...and never mistakes the object name/extruder for a process override.
    assert.equal(reopenedWithOverrides.instances[0]?.processOverrides?.name, undefined)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('buildEditedThreeMf injects an imported mesh into an existing base project alongside its objects', async () => {
  const { buildEditedThreeMf } = await import('./three-mf.js')
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-import-base-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'edited.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')]
    ])
    const mesh = {
      positions: [0, 0, 0, 5, 0, 0, 5, 5, 0],
      indices: [0, 1, 2],
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 5, z: 0 } }
    }
    // Keep existing Box (object 3) and add the imported mesh, both on plate 1.
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: 3, plateIndex: 1, position: { x: -20, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        { importId: 'imp-1', plateIndex: 1, position: { x: 20, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ]
    }
    await buildEditedThreeMf(sourcePath, outputPath, edit, [{ importId: 'imp-1', name: 'Widget', mesh }])

    const scene = await readSceneManifest(outputPath, 1)
    assert.equal(scene.instances.length, 2)
    // The imported object got a fresh id beyond the existing max (3, 11) -> 12.
    const objectIds = scene.instances.map((entry) => entry.objectId).sort((left, right) => left - right)
    assert.deepEqual(objectIds, [3, 12])
    // Original geometry for object 3's sub-model reference is still copied verbatim.
    const modelXml = (await readEntry(outputPath, '3D/3dmodel.model')).toString('utf8')
    assert.match(modelXml, /<object id="3"/)
    assert.match(modelXml, /<object id="12"/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('buildEditedThreeMf removes objects the edit no longer references (cut/delete) from both documents', async () => {
  const { buildEditedThreeMf } = await import('./three-mf.js')
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-cut-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'edited.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')]
    ])
    const mesh = {
      positions: [0, 0, 0, 5, 0, 0, 5, 5, 0],
      indices: [0, 1, 2],
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 5, z: 0 } }
    }
    // The Cut tool replaced object 3 with a staged-import half and the user kept only it:
    // object 3 is absent from the edit. Object 11 stays. The baked 3MF must not keep object 3
    // anywhere — BambuStudio re-instantiates resources objects that lack a build item, so an
    // orphaned original would reappear in the slice on top of the kept half.
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: 11, plateIndex: 1, position: { x: 40, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        { importId: 'imp-1', plateIndex: 1, position: { x: -40, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ]
    }
    await buildEditedThreeMf(sourcePath, outputPath, edit, [{ importId: 'imp-1', name: 'Widget (left)', mesh }])

    const modelXml = (await readEntry(outputPath, '3D/3dmodel.model')).toString('utf8')
    assert.doesNotMatch(modelXml, /<object id="3"/)
    assert.doesNotMatch(modelXml, /<item objectid="3"/)
    assert.match(modelXml, /<object id="11"/)
    assert.match(modelXml, /<object id="12"/)
    const settingsXml = (await readEntry(outputPath, 'Metadata/model_settings.config')).toString('utf8')
    assert.doesNotMatch(settingsXml, /<object id="3">/)
    assert.match(settingsXml, /<object id="11">/)
    // The edited scene still round-trips with exactly the kept instances.
    const scene = await readSceneManifest(outputPath, 1)
    assert.deepEqual(scene.instances.map((entry) => entry.objectId).sort((left, right) => left - right), [11, 12])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('rekeyReplacedObjectOverrides moves a replaced object’s overrides onto its baked id', () => {
  const overrides = { '3': { sparse_infill_density: '35%' }, '11': { wall_loops: '4' } }
  const rekeyed = rekeyReplacedObjectOverrides(overrides, [{ originalObjectId: 3, bakedObjectId: 12 }])
  // Object 3's overrides moved to the baked replacement (12); the untouched object keeps its key.
  assert.deepEqual(rekeyed, { '12': { sparse_infill_density: '35%' }, '11': { wall_loops: '4' } })
  // No replacements -> identity.
  assert.equal(rekeyReplacedObjectOverrides(overrides, []), overrides)
})

test('buildEditedThreeMf reports replaced object ids so overrides follow the new mesh', async () => {
  const { buildEditedThreeMf } = await import('./three-mf.js')
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-replace-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'edited.3mf')
  const customizedPath = path.join(tempDir, 'custom.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')]
    ])
    const mesh = {
      positions: [0, 0, 0, 5, 0, 0, 5, 5, 0],
      indices: [0, 1, 2],
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 5, z: 0 } }
    }
    // The user replaced object 3 with a staged import: its instance now references the import,
    // and meshReplacements records the provenance so its per-object overrides can follow.
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { importId: 'imp-1', plateIndex: 1, position: { x: -40, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        { objectId: 11, plateIndex: 1, position: { x: 40, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ],
      meshReplacements: [{ objectId: 3, importId: 'imp-1' }],
      objectNames: [{ importId: 'imp-1', name: 'Box' }]
    }
    const result = await buildEditedThreeMf(sourcePath, outputPath, edit, [{ importId: 'imp-1', name: 'Gear', mesh }])

    // The import baked as object 12 (max existing id 11 + 1); object 3 is gone, replaced by it.
    assert.deepEqual(result.replacedObjectIds, [{ originalObjectId: 3, bakedObjectId: 12 }])
    const settingsXml = (await readEntry(outputPath, 'Metadata/model_settings.config')).toString('utf8')
    assert.doesNotMatch(settingsXml, /<object id="3">/)
    assert.match(settingsXml, /<object id="12">/)
    // The retained object name was applied to the baked replacement (Replace keeps identity).
    assert.match(/<object id="12">[\s\S]*?<\/object>/.exec(settingsXml)?.[0] ?? '', /key="name" value="Box"/)

    // Re-keying object 3's process overrides onto the baked id and injecting them lands the
    // metadata inside the replacement object (object 12), proving overrides follow the new mesh.
    const effective = rekeyReplacedObjectOverrides({ '3': { sparse_infill_density: '35%' } }, result.replacedObjectIds)
    await createObjectCustomizedThreeMf(outputPath, customizedPath, 1, { objectProcessOverrides: effective })
    const customized = (await readEntry(customizedPath, 'Metadata/model_settings.config')).toString('utf8')
    const object12 = /<object id="12">[\s\S]*?<\/object>/.exec(customized)?.[0] ?? ''
    assert.match(object12, /<metadata key="sparse_infill_density" value="35%"\/>/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('buildEditedThreeMf bakes added part volumes as components with Bambu subtypes', async () => {
  const { buildEditedThreeMf } = await import('./three-mf.js')
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-added-part-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'edited.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')]
    ])
    const mesh = {
      positions: [0, 0, 0, 5, 0, 0, 5, 5, 0],
      indices: [0, 1, 2],
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 5, z: 0 } }
    }
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: 3, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ],
      addedParts: [
        {
          objectId: 3,
          importId: 'part-1',
          subtype: 'negative_part',
          name: 'Hole punch',
          matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 6, 7],
          settings: { sparse_infill_density: '80%' }
        }
      ]
    }
    await buildEditedThreeMf(sourcePath, outputPath, edit, [{ importId: 'part-1', name: 'Hole punch', mesh }])

    const modelXml = (await readEntry(outputPath, '3D/3dmodel.model')).toString('utf8')
    // The part mesh became a new object (next id after 3/11 -> 12) referenced as a
    // component of object 3 at the requested object-local transform...
    assert.match(modelXml, /<object id="12" type="model">[\s\S]*?<mesh>/)
    assert.match(modelXml, /<object id="3"[^>]*>[\s\S]*?<component objectid="12" transform="1 0 0 0 1 0 0 0 1 5 6 7"\/>[\s\S]*?<\/object>/)
    // ...and is never placed by a build item of its own.
    assert.doesNotMatch(modelXml, /<item objectid="12"/)
    const settingsXml = (await readEntry(outputPath, 'Metadata/model_settings.config')).toString('utf8')
    // The parent's settings entry gains the subtype'd part; no standalone object entry.
    assert.match(settingsXml, /<object id="3">[\s\S]*?<part id="12" subtype="negative_part">[\s\S]*?Hole punch[\s\S]*?<\/object>/)
    assert.doesNotMatch(settingsXml, /<object id="12">/)
    // Per-volume process overrides ride as part metadata (how BS persists volume config).
    assert.match(settingsXml, /<part id="12" subtype="negative_part">[\s\S]*?<metadata key="sparse_infill_density" value="80%"\/>[\s\S]*?<\/part>/)
    // Round-trip: the scene manifest sees the new part on object 3 with its subtype.
    const scene = await readSceneManifest(outputPath, 1)
    const instance = scene.instances.find((entry) => entry.objectId === 3)
    const part = instance?.parts.find((entry) => entry.subtype === 'negative_part')
    assert.ok(part, 'expected the negative part to round-trip onto object 3')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('buildEditedThreeMf wraps an inline-mesh object to add a part volume to it', async () => {
  const { buildEditedThreeMf } = await import('./three-mf.js')
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-wrap-part-'))
  const basePath = path.join(tempDir, 'base.3mf')
  const outputPath = path.join(tempDir, 'edited.3mf')
  try {
    const quad = {
      positions: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0],
      indices: [0, 1, 2, 0, 2, 3],
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } }
    }
    // A saved import becomes an object carrying its mesh inline (id 1).
    await buildEditedThreeMf(null, basePath, {
      plates: [{ index: 1 }],
      instances: [
        { importId: 'imp-1', plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ]
    }, [{ importId: 'imp-1', name: 'Widget', mesh: quad }])

    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: 1, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ],
      addedParts: [
        { objectId: 1, importId: 'part-1', subtype: 'modifier_part', name: 'Modifier', matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 2] }
      ]
    }
    await buildEditedThreeMf(basePath, outputPath, edit, [
      { importId: 'part-1', name: 'Modifier', mesh: quad }
    ])

    const modelXml = (await readEntry(outputPath, '3D/3dmodel.model')).toString('utf8')
    // Object 1 no longer carries a mesh: it wraps its original mesh (moved to a new
    // object, identity component) plus the modifier component (3MF: mesh XOR components).
    const objectOne = modelXml.match(/<object id="1"[^>]*>[\s\S]*?<\/object>/)?.[0] ?? ''
    assert.doesNotMatch(objectOne, /<mesh\b/)
    assert.match(objectOne, /<component objectid="3" transform="1 0 0 0 1 0 0 0 1 0 0 0"\/>/)
    assert.match(objectOne, /<component objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 2"\/>/)
    assert.match(modelXml, /<object id="3" type="model">[\s\S]*?<mesh>/)
    const settingsXml = (await readEntry(outputPath, 'Metadata/model_settings.config')).toString('utf8')
    // The original part entry re-keys to the moved mesh object; the modifier is added.
    assert.match(settingsXml, /<part id="3" subtype="normal_part">/)
    assert.match(settingsXml, /<part id="2" subtype="modifier_part">/)
    const scene = await readSceneManifest(outputPath, 1)
    const instance = scene.instances.find((entry) => entry.objectId === 1)
    assert.ok(instance, 'wrapped object still parses')
    assert.equal(instance?.parts.length, 2)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

const PRIME_TOWER_PROJECT_SETTINGS = JSON.stringify({
  enable_prime_tower: '1',
  prime_tower_width: '35',
  wipe_tower_x: ['15'],
  wipe_tower_y: ['220']
})

test('readSceneManifest reads the prime tower; buildEditedThreeMf persists a moved tower', async () => {
  const { buildEditedThreeMf } = await import('./three-mf.js')
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-primetower-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'edited.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(PRIME_TOWER_PROJECT_SETTINGS, 'utf8')]
    ])

    // Config omits the sizing keys, so the parser fills in BambuStudio's defaults.
    const DEFAULT_SIZING = {
      wipeVolume: 45, layerHeight: 0.2, infillGap: 1.5, ribWall: true,
      ribWidth: 8, extraRibLength: 0, extruderCount: 1, needWipeTower: false
    }
    const scene = await readSceneManifest(sourcePath, 1)
    assert.deepEqual(scene.primeTower, { x: 15, y: 220, width: 35, sizing: DEFAULT_SIZING })

    const edit: SceneEdit = {
      plates: [{ index: 1, primeTower: { x: 50, y: 60 } }],
      instances: [
        { objectId: 3, plateIndex: 1, position: { x: -40, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ]
    }
    await buildEditedThreeMf(sourcePath, outputPath, edit, [])

    const settings = JSON.parse((await readEntry(outputPath, 'Metadata/project_settings.config')).toString('utf8'))
    assert.deepEqual(settings.wipe_tower_x, ['50'])
    assert.deepEqual(settings.wipe_tower_y, ['60'])

    // The moved tower round-trips back through the scene reader.
    const reread = await readSceneManifest(outputPath, 1)
    assert.deepEqual(reread.primeTower, { x: 50, y: 60, width: 35, sizing: DEFAULT_SIZING })
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readSceneManifest captures prime-tower sizing config (purge volume, layer height, rib walls)', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-towersize-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  try {
    const settings = JSON.stringify({
      enable_prime_tower: '1',
      prime_tower_width: '35',
      wipe_tower_x: ['15'],
      wipe_tower_y: ['220'],
      filament_prime_volume: ['80', '120', '60'],
      layer_height: '0.16',
      prime_tower_infill_gap: '100',
      prime_tower_rib_wall: '0',
      prime_tower_rib_width: '6',
      nozzle_diameter: ['0.4', '0.4'],
      prime_volume_mode: 'Default'
    })
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(settings, 'utf8')]
    ])
    const scene = await readSceneManifest(sourcePath, 1)
    assert.deepEqual(scene.primeTower?.sizing, {
      wipeVolume: 120,        // max of the per-filament prime volumes
      layerHeight: 0.16,
      infillGap: 1,           // 100% / 100
      ribWall: false,
      ribWidth: 6,
      extraRibLength: 0,
      extruderCount: 2,       // two nozzle_diameter entries
      needWipeTower: false
    })
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readSceneManifest forces prime volume to 15 in Saving mode', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-towersave-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  try {
    const settings = JSON.stringify({
      enable_prime_tower: '1',
      wipe_tower_x: ['15'],
      wipe_tower_y: ['220'],
      filament_prime_volume: ['80', '120'],
      prime_volume_mode: 'Saving'
    })
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(settings, 'utf8')]
    ])
    const scene = await readSceneManifest(sourcePath, 1)
    assert.equal(scene.primeTower?.sizing.wipeVolume, 15)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readSceneManifest keeps support/modifier parts and tags their subtype', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-modifier-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  try {
    const modelXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<model xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
      '  <resources>',
      '    <object id="3" type="model"><components>',
      '      <component p:path="/3D/Objects/object_3.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
      '      <component p:path="/3D/Objects/object_3.model" objectid="4" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
      '    </components></object>',
      '  </resources>',
      '  <build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/></build>',
      '</model>'
    ].join('\n')
    const modelSettingsXml = [
      '<config>',
      '  <object id="3"><metadata key="name" value="Widget"/>',
      '    <part id="1" subtype="normal_part"><metadata key="name" value="Body"/><metadata key="extruder" value="1"/></part>',
      '    <part id="4" subtype="support_blocker"><metadata key="name" value="No support here"/></part>',
      '  </object>',
      '  <plate>',
      '    <metadata key="plater_id" value="1"/>',
      '    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/></model_instance>',
      '  </plate>',
      '</config>'
    ].join('\n')
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(modelXml, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(modelSettingsXml, 'utf8')]
    ])

    const scene = await readSceneManifest(sourcePath, 1)
    const blocker = scene.parts.find((part) => part.subtype === 'support_blocker')
    assert.ok(blocker, 'the support_blocker part is kept, not dropped')
    assert.equal(blocker!.filamentId, null) // modifiers carry no filament
    assert.ok(scene.parts.some((part) => part.subtype === 'normal_part'))
    // The instance carries both parts (including the blocker) with their subtype.
    assert.equal(scene.instances.length, 1)
    assert.ok(scene.instances[0]!.parts.some((part) => part.subtype === 'support_blocker'))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readSceneManifest re-hydrates per-part process overrides (minus structural keys) onto the instance part', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-partproc-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  try {
    const modelXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<model xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
      '  <resources>',
      '    <object id="3" type="model"><components>',
      '      <component p:path="/3D/Objects/object_3.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
      '      <component p:path="/3D/Objects/object_3.model" objectid="4" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
      '    </components></object>',
      '  </resources>',
      '  <build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/></build>',
      '</model>'
    ].join('\n')
    const modelSettingsXml = [
      '<config>',
      '  <object id="3"><metadata key="name" value="Widget"/>',
      // Part 1 carries a real process override (wall_loops) alongside structural keys (name/extruder)
      // AND Bambu identity/placement metadata (source_object_id, source_offset_x, matrix) that must
      // NOT be mistaken for process overrides.
      '    <part id="1" subtype="normal_part"><metadata key="name" value="Body"/><metadata key="extruder" value="1"/><metadata key="source_object_id" value="0"/><metadata key="source_offset_x" value="12.5"/><metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/><metadata key="wall_loops" value="6"/></part>',
      // Part 4 has only structural/placement metadata, so it should expose no processOverrides.
      '    <part id="4" subtype="normal_part"><metadata key="name" value="Lid"/><metadata key="source_offset_y" value="3"/></part>',
      '  </object>',
      '  <plate>',
      '    <metadata key="plater_id" value="1"/>',
      '    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/></model_instance>',
      '  </plate>',
      '</config>'
    ].join('\n')
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(modelXml, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(modelSettingsXml, 'utf8')]
    ])

    const scene = await readSceneManifest(sourcePath, 1)
    const parts = scene.instances[0]!.parts
    const body = parts.find((part) => part.componentObjectId === 1)
    const lid = parts.find((part) => part.componentObjectId === 4)
    // The process override comes back; structural name/extruder are NOT treated as overrides.
    assert.deepEqual(body!.processOverrides, { wall_loops: '6' })
    assert.equal(lid!.processOverrides, undefined)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

const DUAL_NOZZLE_PROJECT_SETTINGS = JSON.stringify({
  printer_model: ['Bambu Lab H2D'],
  extruder_printable_area: ['0x0,325x0,325x320,0x320', '25x0,350x0,350x320,25x320']
})

test('readSceneManifest derives labeled left/right nozzle-only zones for dual-nozzle machines', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-dualnozzle-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(DUAL_NOZZLE_PROJECT_SETTINGS, 'utf8')]
    ])
    const scene = await readSceneManifest(sourcePath, 1)
    assert.equal(scene.bed.minX, 0)
    assert.equal(scene.bed.maxX, 350)

    const left = scene.bed.excludeAreas.find((zone) => zone.label === 'Left nozzle only area')
    const right = scene.bed.excludeAreas.find((zone) => zone.label === 'Right nozzle only area')
    assert.ok(left, 'expected a left nozzle only zone')
    assert.ok(right, 'expected a right nozzle only zone')
    const leftXs = left!.polygon.map((point) => point.x)
    assert.deepEqual([Math.min(...leftXs), Math.max(...leftXs)], [0, 25])
    const rightXs = right!.polygon.map((point) => point.x)
    assert.deepEqual([Math.min(...rightXs), Math.max(...rightXs)], [325, 350])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readSceneManifest derives H2C nozzle-only zones from the per-model fallback when the area is not embedded', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-h2c-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  try {
    // A realistic H2C export: references the machine profile, so it carries no
    // embedded extruder_printable_area — the per-model fallback must supply it.
    const settings = JSON.stringify({ printer_model: ['Bambu Lab H2C'] })
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(settings, 'utf8')]
    ])
    const scene = await readSceneManifest(sourcePath, 1)

    const left = scene.bed.excludeAreas.find((zone) => zone.label === 'Left nozzle only area')
    const right = scene.bed.excludeAreas.find((zone) => zone.label === 'Right nozzle only area')
    assert.ok(left, 'expected a left nozzle only zone for H2C')
    assert.ok(right, 'expected a right nozzle only zone for H2C')
    // H2C reaches x=325 on the first nozzle and x=330 on the second.
    const leftXs = left!.polygon.map((point) => point.x)
    assert.deepEqual([Math.min(...leftXs), Math.max(...leftXs)], [0, 25])
    const rightXs = right!.polygon.map((point) => point.x)
    assert.deepEqual([Math.min(...rightXs), Math.max(...rightXs)], [325, 330])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readSceneManifest falls back to the X1/P1 corner zone from printer_settings_id alone', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-x1fallback-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  try {
    // A realistic Bambu export: references the machine profile, no bed_exclude_area.
    const settings = JSON.stringify({ printer_settings_id: 'Bambu Lab X1 Carbon 0.4 nozzle' })
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(settings, 'utf8')]
    ])
    const scene = await readSceneManifest(sourcePath, 1)
    assert.equal(scene.bed.excludeAreas.length, 1)
    const xs = scene.bed.excludeAreas[0]!.polygon.map((p) => p.x)
    assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0, 18])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readSceneManifest ignores a placeholder zero bed_exclude_area and uses the model fallback', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-zeroexclude-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  try {
    const settings = JSON.stringify({
      printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
      bed_exclude_area: ['0x0', '0x0', '0x0', '0x0']
    })
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(settings, 'utf8')]
    ])
    const scene = await readSceneManifest(sourcePath, 1)
    assert.equal(scene.bed.excludeAreas.length, 1)
    const xs = scene.bed.excludeAreas[0]!.polygon.map((p) => p.x)
    assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0, 18])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('readSceneManifest overrides the bed + zones for a selected target printer', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-bedoverride-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  try {
    // File is an H2D (dual-nozzle, 350x320) but the user targets a P1S in the dialog.
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')],
      ['Metadata/project_settings.config', Buffer.from(DUAL_NOZZLE_PROJECT_SETTINGS, 'utf8')]
    ])
    const fileScene = await readSceneManifest(sourcePath, 1)
    assert.equal(fileScene.bed.maxX, 350)

    const p1sScene = await readSceneManifest(sourcePath, 1, undefined, 'P1S')
    assert.equal(p1sScene.bed.minX, 0)
    assert.equal(p1sScene.bed.maxX, 256)
    assert.equal(p1sScene.bed.maxY, 256)
    // P1S has the front-left corner zone and no dual-nozzle strips.
    assert.equal(p1sScene.bed.excludeAreas.length, 1)
    assert.equal(p1sScene.bed.excludeAreas[0]!.label, null)
    const xs = p1sScene.bed.excludeAreas[0]!.polygon.map((p) => p.x)
    assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0, 18])

    // H2C: bed is 330x320 (NOT 350) and the bed edge must coincide with the right
    // nozzle-only strip (325..330) so no phantom unreachable strip appears past it.
    const h2cScene = await readSceneManifest(sourcePath, 1, undefined, 'H2C')
    assert.equal(h2cScene.bed.maxX, 330)
    assert.equal(h2cScene.bed.maxY, 320)
    const h2cRight = h2cScene.bed.excludeAreas.find((zone) => zone.label === 'Right nozzle only area')
    assert.ok(h2cRight, 'expected an H2C right nozzle only zone')
    const h2cRightXs = h2cRight!.polygon.map((p) => p.x)
    assert.deepEqual([Math.min(...h2cRightXs), Math.max(...h2cRightXs)], [325, 330])

    // X2D: bed is 256x256 (NOT 350x320); left nozzle-only strip 0..20.5.
    const x2dScene = await readSceneManifest(sourcePath, 1, undefined, 'X2D')
    assert.equal(x2dScene.bed.maxX, 256)
    assert.equal(x2dScene.bed.maxY, 256)
    const x2dLeft = x2dScene.bed.excludeAreas.find((zone) => zone.label === 'Left nozzle only area')
    assert.ok(x2dLeft, 'expected an X2D left nozzle only zone')
    const x2dLeftXs = x2dLeft!.polygon.map((p) => p.x)
    assert.deepEqual([Math.min(...x2dLeftXs), Math.max(...x2dLeftXs)], [0, 20.5])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('buildEditedThreeMf uses an instance full matrix verbatim (world-scale shear round-trips)', async () => {
  const { buildEditedThreeMf } = await import('./three-mf.js')
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-matrix-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'edited.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')]
    ])
    // A sheared matrix (col 1 has a non-zero X term) that T*R*S can't represent.
    const matrix = [2, 0, 0, 0.5, 1, 0, 0, 0, 1, 10, 20, 5]
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: 3, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, matrix }
      ]
    }
    await buildEditedThreeMf(sourcePath, outputPath, edit, [])
    const model = (await readEntry(outputPath, '3D/3dmodel.model')).toString('utf8')
    const item = /<item objectid="3" transform="([^"]+)"/.exec(model)
    assert.ok(item, 'expected a build item for object 3')
    assert.equal(item![1], '2 0 0 0.5 1 0 0 0 1 10 20 5')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('buildEditedThreeMf emits a single model_settings.config when the source already has one', async () => {
  const { buildEditedThreeMf } = await import('./three-mf.js')
  const yauzl = (await import('yauzl')).default
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-three-mf-dupe-'))
  const sourcePath = path.join(tempDir, 'source.3mf')
  const outputPath = path.join(tempDir, 'edited.3mf')
  try {
    await writeZipFixture(sourcePath, [
      ['3D/3dmodel.model', Buffer.from(ARRANGE_MODEL_XML, 'utf8')],
      // A model_settings.config larger than 1 byte (the old existence probe threw here,
      // which made the writer append a DUPLICATE entry -> "Duplicated object id" in the slicer).
      ['Metadata/model_settings.config', Buffer.from(ARRANGE_MODEL_SETTINGS_XML, 'utf8')]
    ])
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [
        { objectId: 3, plateIndex: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
      ]
    }
    await buildEditedThreeMf(sourcePath, outputPath, edit, [])
    const names = await new Promise<string[]>((resolve, reject) => {
      const found: string[] = []
      yauzl.open(outputPath, { lazyEntries: true }, (err, zip) => {
        if (err || !zip) { reject(err ?? new Error('open failed')); return }
        zip.on('entry', (entry) => { found.push(entry.fileName); zip.readEntry() })
        zip.on('end', () => resolve(found))
        zip.on('error', reject)
        zip.readEntry()
      })
    })
    const configCount = names.filter((name) => name === 'Metadata/model_settings.config').length
    assert.equal(configCount, 1, `expected exactly one model_settings.config, got ${configCount}`)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('extractSceneBed override resolves every canonical Bambu model key to a real bed (X1/A1mini regression)', async () => {
  // The editor's bed override sends canonicalBambuModelKey output through
  // printerModelSchema; X1 and A1 mini used to fall out of that round-trip and
  // the editor silently kept the FILE's bed (e.g. an H2D 350x320) for them.
  const { extractSceneBed } = await import('./three-mf-reader.js')
  const expectBed = (model: string, width: number, depth: number) => {
    const placement = extractSceneBed(null, null, model as never)
    assert.equal(placement.bed.maxX - placement.bed.minX, width, `${model} width`)
    assert.equal(placement.bed.maxY - placement.bed.minY, depth, `${model} depth`)
  }
  expectBed('X1', 256, 256)
  expectBed('A1mini', 180, 180)
  expectBed('A2L', 330, 320)
  expectBed('X2D', 256, 256)
  expectBed('H2D', 350, 320)
})
