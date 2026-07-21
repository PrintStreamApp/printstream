import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyProcessProfileToProjectSettings, retargetProjectSettingsToMachine } from './machine-retarget.js'

// A single-extruder A1-mini-ish project (only the fields that matter here).
const a1Project = {
  printer_settings_id: 'Bambu Lab A1 mini 0.4 nozzle',
  printer_model: 'Bambu Lab A1 mini',
  printable_area: ['0x0', '180x0', '180x180', '0x180'],
  nozzle_diameter: ['0.4'],
  physical_extruder_map: ['0'],
  extruder_variant_list: ['Direct Drive Standard'],
  filament_type: ['PLA', 'PLA'],
  filament_settings_id: ['Bambu PLA Basic @BBL A1M', 'Bambu PLA Basic @BBL A1M'],
  nozzle_temperature: ['220', '220'],
  filament_nozzle_map: ['0', '0']
}

// A resolved dual-extruder H2D-ish machine profile.
const h2dMachine = {
  name: 'Bambu Lab H2D 0.4 nozzle',
  type: 'machine',
  inherits: 'fdm_machine_common',
  printer_model: 'Bambu Lab H2D',
  printable_area: ['0x0', '325x0', '325x320', '0x320'],
  nozzle_diameter: ['0.4', '0.4'],
  physical_extruder_map: ['1', '0'],
  extruder_variant_list: ['Direct Drive High Flow', 'Direct Drive High Flow'],
  default_nozzle_volume_type: ['High Flow', 'High Flow'],
  extruder_max_nozzle_count: ['1', '1']
}

test('retargets project_settings to the target machine, preserving filaments + layout fields', () => {
  const out = retargetProjectSettingsToMachine(a1Project, h2dMachine, {
    printerSettingsId: 'Bambu Lab H2D 0.4 nozzle',
    printerModel: 'Bambu Lab H2D'
  })

  // Machine identity + machine-owned fields switch to H2D.
  assert.equal(out.printer_settings_id, 'Bambu Lab H2D 0.4 nozzle')
  assert.equal(out.printer_model, 'Bambu Lab H2D')
  assert.deepEqual(out.printable_area, ['0x0', '325x0', '325x320', '0x320'])
  assert.deepEqual(out.nozzle_diameter, ['0.4', '0.4'])
  assert.deepEqual(out.physical_extruder_map, ['1', '0'])

  // Dependent runtime maps are re-derived for the new (dual-extruder) topology.
  assert.deepEqual(out.filament_nozzle_map, ['1', '0']) // verbatim from physical_extruder_map
  assert.ok(Array.isArray(out.filament_volume_map) && (out.filament_volume_map as string[]).length === 2)

  // Filament selection + the project's own filament settings are untouched.
  assert.deepEqual(out.filament_settings_id, ['Bambu PLA Basic @BBL A1M', 'Bambu PLA Basic @BBL A1M'])
  assert.deepEqual(out.nozzle_temperature, ['220', '220'])

  // Printer-compatibility is re-declared for the target so stale source-printer chips don't linger.
  assert.deepEqual(out.print_compatible_printers, ['Bambu Lab H2D 0.4 nozzle'])
  // The project carried no compatible_printers, so none is added (matches BambuStudio).
  assert.equal(out.compatible_printers, undefined)

  // Profile metadata never leaks into project_settings.
  assert.equal(out.name, undefined)
  assert.equal(out.type, undefined)
  assert.equal(out.inherits, undefined)
})

test('retarget rewrites a project’s stale printer-compatibility declarations to the target', () => {
  const out = retargetProjectSettingsToMachine(
    { ...a1Project, print_compatible_printers: ['Bambu Lab A1 mini 0.4 nozzle'], compatible_printers: ['Bambu Lab A1 mini 0.4 nozzle'] },
    h2dMachine,
    { printerSettingsId: 'Bambu Lab H2D 0.4 nozzle', printerModel: 'Bambu Lab H2D' }
  )
  assert.deepEqual(out.print_compatible_printers, ['Bambu Lab H2D 0.4 nozzle'])
  assert.deepEqual(out.compatible_printers, ['Bambu Lab H2D 0.4 nozzle'])
})

test('applyProcessProfileToProjectSettings brings the process over, sets print_settings_id, and applies overrides', () => {
  const project = {
    print_settings_id: '0.20mm Standard @BBL A1M',
    layer_height: '0.2',
    wall_loops: '2',
    sparse_infill_density: '15%',
    filament_settings_id: ['Bambu PLA Basic @BBL A1M']
  }
  const h2dProcess = {
    name: '0.20mm Standard @BBL H2D',
    type: 'process',
    inherits: 'fdm_process_common',
    layer_height: '0.2',
    wall_loops: '3',
    compatible_printers: ['Bambu Lab H2D 0.4 nozzle']
  }
  const out = applyProcessProfileToProjectSettings(project, h2dProcess, { sparse_infill_density: '20%' })

  assert.equal(out.print_settings_id, '0.20mm Standard @BBL H2D')
  assert.equal(out.wall_loops, '3') // overwritten from the target process
  assert.equal(out.sparse_infill_density, '20%') // user override wins
  assert.equal(out.compatible_printers, undefined) // compatibility declaration is not a setting
  assert.deepEqual(out.filament_settings_id, ['Bambu PLA Basic @BBL A1M']) // filament selection untouched
  assert.equal(out.name, undefined)
})

test('retarget blanks the inherited machine parent so the CLI derives the system printer from the new id', () => {
  // A project saved with a CUSTOM machine preset carries its parent in inherits_group's
  // machine (last) slot; 2.7.1+ CLIs validate loaded filaments against that name, so a
  // stale "Bambu Lab P1P 0.4 nozzle" fails the slice after the retarget.
  const out = retargetProjectSettingsToMachine({
    ...a1Project,
    inherits_group: ['0.20mm Standard @BBL A1M', 'Bambu PLA Basic @BBL A1M', 'Bambu Lab P1P 0.4 nozzle']
  }, h2dMachine, {
    printerSettingsId: 'Bambu Lab H2D 0.4 nozzle',
    printerModel: 'Bambu Lab H2D'
  })
  assert.deepEqual(out.inherits_group, ['0.20mm Standard @BBL A1M', 'Bambu PLA Basic @BBL A1M', ''])
})

test('applyProcessProfileToProjectSettings blanks the inherited process parent alongside print_settings_id', () => {
  const out = applyProcessProfileToProjectSettings({
    ...a1Project,
    inherits_group: ['0.20mm Custom Standard', 'Bambu PLA Basic @BBL A1M', '']
  }, {
    name: '0.20mm Standard @BBL H2D',
    type: 'process',
    layer_height: '0.2'
  })
  assert.equal(out.print_settings_id, '0.20mm Standard @BBL H2D')
  assert.deepEqual(out.inherits_group, ['', 'Bambu PLA Basic @BBL A1M', ''])
})

test('retarget to a dual-nozzle machine resizes flush_volumes_matrix for the new extruder count', () => {
  // Regression: `flush_volumes_matrix` is a PROJECT key, so the machine-profile overwrite never
  // touched it and a single-nozzle-sized matrix survived onto a 2-extruder machine. BambuStudio
  // then read the missing second block out of bounds and segfaulted at ~71% (CLI exit 139) —
  // reproduced on real projects retargeted onto both dual-nozzle machine families.
  const singleFilamentProject = { ...a1Project, filament_colour: ['#F2754E'], flush_volumes_matrix: ['0'] }
  const out = retargetProjectSettingsToMachine(singleFilamentProject, h2dMachine, {
    printerSettingsId: 'Bambu Lab H2D 0.4 nozzle',
    printerModel: 'Bambu Lab H2D'
  })
  assert.deepEqual(out.flush_volumes_matrix, ['0', '0'])
})

test('retarget preserves an already correctly sized flush_volumes_matrix', () => {
  const twoFilamentProject = {
    ...a1Project,
    filament_colour: ['#000000', '#FFFFFF'],
    flush_volumes_matrix: ['0', '632', '136', '0', '0', '632', '136', '0']
  }
  const out = retargetProjectSettingsToMachine(twoFilamentProject, h2dMachine, {
    printerSettingsId: 'Bambu Lab H2D 0.4 nozzle',
    printerModel: 'Bambu Lab H2D'
  })
  assert.deepEqual(out.flush_volumes_matrix, ['0', '632', '136', '0', '0', '632', '136', '0'])
})
