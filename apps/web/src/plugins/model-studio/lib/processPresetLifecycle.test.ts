/** Save/reopen contract with synthetic metadata shaped like the production regression. No customer geometry. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { strToU8, strFromU8, zipSync, unzipSync } from 'fflate'
import { applyProcessProfileToProjectSettings, buildBuiltinSlicingPresetId, buildProjectSlicingPresetId,
  type ProcessConfig, type ResolveProcessConfigResponse, type SaveArrangedThreeMf } from '@printstream/shared'
import { applyGlobalProcessOverrides } from '@printstream/shared/three-mf'
import { resolveCustomProfileConfigWith } from '../../../../../slicer/src/custom-profile-resolve'
import { bakeClientThreeMf } from './clientThreeMfBake'
import { openThreeMfArchive } from './threeMfArchive'
import { bakeOptionsFor, bakePassesFor } from './editorBakePasses'
import { projectProcessResolver } from '../../../lib/projectProcessResolver'
import { deriveProjectCarryOverrides } from '../../../lib/processCarryOverrides'
import type { RetargetResolvers } from './browserMachineRetarget'

const name = '0.20mm Ryan @BBL X1C'
const parentName = '0.20mm Standard @BBL X1C'
const parent: ProcessConfig = { name: parentName, wall_loops: '2', sparse_infill_pattern: 'grid', top_shell_layers: '5',
  wall_generator: 'classic', enable_support: '0', support_type: 'tree(auto)', support_object_xy_distance: '0.35' }
const project = { print_settings_id: parentName, printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
  printer_model: 'Bambu Lab P1S', nozzle_diameter: ['0.4'], machine_start_gcode: 'G28 ; original',
  filament_settings_id: ['PLA'], filament_colour: ['#FFFFFF'], nozzle_temperature: ['220'],
  inherits_group: ['', 'Filament parent', 'Machine parent'], different_settings_to_system: ['', 'nozzle_temperature', 'machine_start_gcode'],
  ...Object.fromEntries(Object.entries(parent).filter(([key]) => key !== 'name')) }

async function leaf(): Promise<ResolveProcessConfigResponse> {
  const config = await resolveCustomProfileConfigWith(JSON.stringify({ print_settings_id: name, inherits: parentName,
    sparse_infill_pattern: '3dhoneycomb', top_shell_layers: '4', wall_generator: 'arachne' }),
  'process', async () => parent) as ProcessConfig
  return { preset: { name, parentName }, config, baseConfig: config, parentConfig: parent, overriddenKeys: [] }
}

async function archive() {
  return openThreeMfArchive(new Blob([new Uint8Array(zipSync({
    '3D/3dmodel.model': strToU8('<model unit="millimeter"><resources/><build/></model>'),
    'Metadata/model_settings.config': strToU8('<config/>'),
    'Metadata/project_settings.config': strToU8(JSON.stringify(project))
  }))]))
}

const selected = { mode: 'manualProfile' as const, printerModel: 'Bambu Lab P1S',
  printerProfileId: buildBuiltinSlicingPresetId('machine', 'Bambu Lab P1S 0.4 nozzle'),
  processProfileId: 'custom:ryan', processProfileChosen: true, nozzleDiameters: [0.4],
  processSettingOverrides: { enable_support: '1', support_type: 'normal(auto)', support_object_xy_distance: '1' } }

function payload(overrides = selected.processSettingOverrides): SaveArrangedThreeMf {
  return { mode: 'newVersion', baseFileId: 'synthetic', sceneEdit: { plates: [{ index: 1 }], instances: [] },
    retarget: { ...selected, processSettingOverrides: overrides }, processSettingOverrides: overrides }
}

function resolvers(resolved: ResolveProcessConfigResponse): RetargetResolvers {
  return { canResolve: () => true, machine: async () => ({ config: {}, name: 'Bambu Lab P1S 0.4 nozzle' }),
    process: async () => resolved, filament: async () => { throw new Error('must not rebind materials') } }
}

test('same printer: sparse custom selection, support edits, identity and native metadata survive save/reopen', async () => {
  const resolved = await leaf()
  const original = await archive()
  const request = payload()
  const result = await bakeClientThreeMf(original, request.sceneEdit, [], bakeOptionsFor(request),
    bakePassesFor(request, { resolvers: resolvers(resolved), filamentPresets: async () => [] }))
  const json = strFromU8(unzipSync(result.bytes)['Metadata/project_settings.config']!)
  const saved = JSON.parse(json)
  assert.equal(saved.print_settings_id, name)
  assert.equal(saved.enable_support, '1')
  assert.equal(saved.support_type, 'normal(auto)')
  assert.equal(saved.support_object_xy_distance, '1')
  assert.equal(saved.sparse_infill_pattern, '3dhoneycomb')
  assert.equal(saved.machine_start_gcode, project.machine_start_gcode)
  assert.deepEqual(saved.nozzle_temperature, project.nozzle_temperature)
  assert.deepEqual(saved.inherits_group, [parentName, 'Filament parent', 'Machine parent'])
  const nativeChanges = saved.different_settings_to_system[0].split(';')
  for (const key of ['sparse_infill_pattern', 'top_shell_layers', 'wall_generator', 'enable_support', 'support_type', 'support_object_xy_distance']) assert.ok(nativeChanges.includes(key), key)
  assert.deepEqual(saved.different_settings_to_system.slice(1), project.different_settings_to_system.slice(1))
  const reopened = await projectProcessResolver({ readSettings: async () => json,
    profiles: () => [{ id: 'custom:ryan', name, kind: 'process', source: 'custom' }], resolveInstalled: async () => resolved
  })({ processProfileId: buildProjectSlicingPresetId('process', name), targetId: null, sourceFileId: 'synthetic' })
  assert.equal(reopened.preset?.name, name)
  assert.deepEqual(deriveProjectCarryOverrides(reopened), selected.processSettingOverrides)
})

test('repeated saves from the same pinned archive honor an explicit empty map after reset', async () => {
  const resolved = await leaf()
  const original = await archive()
  for (const overrides of [selected.processSettingOverrides, {}, { support_object_xy_distance: '1' }]) {
    const request = payload(overrides as typeof selected.processSettingOverrides)
    const { bytes } = await bakeClientThreeMf(original, request.sceneEdit, [], bakeOptionsFor(request),
      bakePassesFor(request, { resolvers: resolvers(resolved), filamentPresets: async () => [] }))
    const saved = JSON.parse(strFromU8(unzipSync(bytes)['Metadata/project_settings.config']!))
    assert.equal(saved.print_settings_id, name)
    assert.equal(saved.enable_support, 'enable_support' in overrides ? '1' : '0')
    assert.equal(saved.support_object_xy_distance, 'support_object_xy_distance' in overrides ? '1' : '0.35')
  }
})

test('failed resolution rejects save instead of acknowledging an unwritten preset choice', async () => {
  const request = payload()
  const broken = { ...resolvers(await leaf()), process: async () => { throw new Error('offline') } }
  await assert.rejects(() => bakeClientThreeMf(null, request.sceneEdit, [], {},
    bakePassesFor(request, { resolvers: broken, filamentPresets: async () => [] })), /offline/)
})

test('project-only edits maintain native changed keys without altering other preset slots', () => {
  const saved = JSON.parse(applyGlobalProcessOverrides(JSON.stringify(project), { enable_support: '1', support_object_xy_distance: '1' }))
  assert.ok(saved.different_settings_to_system[0].includes('enable_support'))
  assert.ok(saved.different_settings_to_system[0].includes('support_object_xy_distance'))
  assert.deepEqual(saved.different_settings_to_system.slice(1), project.different_settings_to_system.slice(1))
})

test('a process written after machine retargeting uses final machine variant columns', async () => {
  const resolved = await leaf()
  const saved = applyProcessProfileToProjectSettings({ printer_extruder_variant: ['High Flow', 'Standard'], printer_extruder_id: ['1', '2'] },
    { ...resolved.config, print_extruder_variant: ['Standard', 'High Flow'], print_extruder_id: ['1', '1'], outer_wall_speed: ['100', '200'] })
  assert.deepEqual(saved.print_extruder_variant, ['High Flow', 'Standard'])
  assert.deepEqual(saved.print_extruder_id, ['1', '2'])
  assert.deepEqual(saved.outer_wall_speed, ['200', '100'])
})

test('saved process settings agree with the browser-prepared slice from the same selection', async () => {
  const resolved = await leaf()
  const original = await archive()
  const request = payload()
  const options = { resolvers: resolvers(resolved), filamentPresets: async () => [] }
  const save = await bakeClientThreeMf(original, request.sceneEdit, [], bakeOptionsFor(request), bakePassesFor(request, options))
  const slice = await bakeClientThreeMf(original, request.sceneEdit, [], {}, {
    sliceTarget: { target: selected, slicerTargetId: null, resolvers: options.resolvers }
  })
  const read = (bytes: Uint8Array) => JSON.parse(strFromU8(unzipSync(bytes)['Metadata/project_settings.config']!))
  const saved = read(save.bytes)
  const staged = read(slice.bytes)
  for (const key of ['print_settings_id', 'enable_support', 'support_type', 'support_object_xy_distance',
    'sparse_infill_pattern', 'top_shell_layers', 'wall_generator']) assert.deepEqual(staged[key], saved[key], key)
  assert.equal(staged.inherits_group[0], saved.inherits_group[0])
  assert.equal(staged.different_settings_to_system[0], saved.different_settings_to_system[0])
})

test('native process metadata is replaced atomically after reset, for absent, empty and stale records', async () => {
  const resolved = await leaf()
  for (const record of [undefined, [], ['enable_support;support_object_xy_distance;obsolete_key', 'material-change', 'machine-change']]) {
    const saved = applyProcessProfileToProjectSettings({ filament_settings_id: ['PLA'], different_settings_to_system: record },
      resolved.config, {}, { ...resolved.preset!, parentConfig: resolved.parentConfig })
    const keys = (saved.different_settings_to_system as string[])[0]!.split(';')
    assert.ok(!keys.includes('enable_support'))
    assert.ok(!keys.includes('support_object_xy_distance'))
    assert.ok(!keys.includes('obsolete_key'))
    assert.ok(keys.includes('sparse_infill_pattern'))
    if (record?.length) assert.deepEqual((saved.different_settings_to_system as string[]).slice(1), record.slice(1))
  }
})

test('an unchanged process name still checks compatibility after a machine rewrite', async () => {
  const request = payload()
  request.retarget!.processProfileChosen = false
  const resolved = await leaf()
  resolved.config.compatible_printers = ['Old machine']
  const passes = bakePassesFor(request, { resolvers: resolvers(resolved), filamentPresets: async () => [] })
  await assert.rejects(() => passes.processSettings!({ print_settings_id: name, printer_settings_id: 'New machine' },
    { machineRetargeted: true }), /incompatible with New machine/)
})

test('final process authoring preserves removed material replacement and rejects resurrection', async () => {
  const { withLoadedProcessFilamentReferences, remapFilamentIndexOverrides } = await import('../../../lib/filamentIndexOverrides')
  const resolved = await leaf()
  resolved.config.support_filament = '3'
  resolved.config.support_interface_filament = '3'
  const captured = withLoadedProcessFilamentReferences({}, resolved.config)
  const overrides = remapFilamentIndexOverrides(captured, 3, 1)
  const request = payload()
  request.retarget!.processSettingOverrides = overrides
  const pass = bakePassesFor(request, { resolvers: resolvers(resolved), filamentPresets: async () => [] }).processSettings!
  const twoMaterials = { ...project, filament_colour: ['#FFFFFF', '#000000'], filament_settings_id: ['A', 'B'] }
  const saved = await pass(twoMaterials)
  assert.equal(saved.support_filament, '1')
  assert.equal(saved.support_interface_filament, '1')
  assert.ok((saved.different_settings_to_system as string[])[0]!.includes('support_filament'))
  request.retarget!.processSettingOverrides = {}
  const unsafe = bakePassesFor(request, { resolvers: resolvers(resolved), filamentPresets: async () => [] }).processSettings!
  await assert.rejects(() => unsafe(twoMaterials), /support_filament.*material 3.*unavailable/)
})
