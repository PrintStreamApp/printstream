/** Synthetic dual-nozzle layouts reproduce the CHM comparison without retaining customer data. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { alignProcessConfigToLayout } from './process-variant-layout.js'
import { diffProcessConfig, resolvedProcessConfigBaselines, resolvedProcessModifiedKeys, resolvedProcessPresetOverrideKeys } from './process-settings.js'
import { extractProjectProcessConfig } from './three-mf-project-config.js'
import { applyProcessPresetBinding } from './process-preset-binding.js'

const standard = 'Direct Drive Standard'
const high = 'Direct Drive High Flow'
const e3d = 'Direct Drive E3D High Flow'
const tpu = 'Direct Drive TPU High Flow'
const preset = {
  print_extruder_id: ['1', '1', '1', '2', '2', '2', '2'],
  print_extruder_variant: [standard, high, e3d, standard, high, tpu, e3d],
  initial_layer_speed: ['50', '50', '50', '50', '50', '50', '50'],
  outer_wall_speed: ['200', '500', '500', '210', '510', '520', '530'],
  support_interface_speed: ['80', '80', '80', '80', '80', '80', '80'],
  post_process: ['a', 'b', 'c', 'd', 'e', 'f', 'g']
}
const layout = {
  print_extruder_id: ['1', '2'],
  print_extruder_variant: [standard, standard]
}

test('selects matching nozzle and flow columns rather than comparing raw vector width', () => {
  const aligned = alignProcessConfigToLayout(preset, layout)
  assert.deepEqual(aligned.initial_layer_speed, ['50', '50'])
  assert.deepEqual(aligned.outer_wall_speed, ['200', '210'])
  assert.deepEqual(aligned.print_extruder_id, ['1', '2'])
  assert.deepEqual(aligned.post_process, preset.post_process, 'ordinary ordered arrays never move')
  assert.equal(preset.initial_layer_speed.length, 7, 'the installed preset remains complete')
  assert.deepEqual(alignProcessConfigToLayout({ ...preset, initial_layer_speed: ['50'] }, layout).initial_layer_speed, ['50', '50'])
  assert.deepEqual(diffProcessConfig({ post_process: ['same', 'same'] }, { post_process: ['same'] }), { post_process: ['same'] }, 'uniform ordered lists are still distinct')
  assert.deepEqual(alignProcessConfigToLayout(preset, {
    print_extruder_id: ['2', '1'], print_extruder_variant: [standard, high]
  }).outer_wall_speed, ['210', '500'], 'reordering is semantic, and duplicate variant names retain nozzle identity')
})

test('incomplete, ambiguous and unknown layouts cannot authorize a guessed column mapping', () => {
  for (const target of [
    { print_extruder_variant: [standard, standard] },
    { ...layout, print_extruder_id: ['1'] },
    { ...layout, print_extruder_id: ['1', '1'] },
    { ...layout, print_extruder_variant: [standard, 'Unknown flow'] }
  ]) assert.equal(alignProcessConfigToLayout(preset, target), preset)
  assert.equal(alignProcessConfigToLayout({ outer_wall_speed: ['200'] }, layout).outer_wall_speed.length, 1)
})

test('project extraction retains column identity; markers, transfer and reset agree on actual changes', () => {
  const project = extractProjectProcessConfig({
    ...layout, print_settings_id: 'Synthetic custom H2D',
    initial_layer_speed: ['50', '50'], outer_wall_speed: ['200', '210'], support_interface_speed: ['50', '50']
  })!
  assert.deepEqual(project.config.print_extruder_id, layout.print_extruder_id)
  const changes = diffProcessConfig(preset, project.config)
  assert.deepEqual(changes, { support_interface_speed: ['50', '50'] })
  const response = { config: project.config, baseConfig: preset, overriddenKeys: [] }
  assert.deepEqual(resolvedProcessConfigBaselines(response).baseline.outer_wall_speed, ['200', '210'], 'the dialog reset/tooltip uses the same aligned baseline as the badge')
  assert.deepEqual(resolvedProcessModifiedKeys(response), ['support_interface_speed'])
  assert.deepEqual(resolvedProcessModifiedKeys(response, { outer_wall_speed: ['200', '220'] }), ['outer_wall_speed', 'support_interface_speed'])
  const baseline = alignProcessConfigToLayout(preset, project.config)
  assert.deepEqual(diffProcessConfig(baseline, { ...project.config, support_interface_speed: baseline.support_interface_speed }), {})
})

test('custom-parent emphasis and native metadata exclude unused nozzle variants but retain real edits', () => {
  const config = { ...layout, initial_layer_speed: ['50', '50'], outer_wall_speed: ['200', '210'], support_interface_speed: ['50', '50'] }
  assert.deepEqual(resolvedProcessPresetOverrideKeys({ config, baseConfig: preset, parentConfig: { ...preset, outer_wall_speed: ['200', '900', '900', '210', '900', '900', '900'] } }), [])
  const record: Record<string, unknown> = { ...config, filament_colour: ['#FFFFFF'], inherits_group: ['', 'Material', 'Machine'], different_settings_to_system: ['', 'filament_flow_ratio', 'machine_start_gcode'] }
  applyProcessPresetBinding(record, preset, { name: 'Synthetic custom H2D', parentName: 'Standard', parentConfig: preset })
  assert.equal((record.different_settings_to_system as string[])[0], 'support_interface_speed')
  assert.deepEqual((record.different_settings_to_system as string[]).slice(1), ['filament_flow_ratio', 'machine_start_gcode'])
})
