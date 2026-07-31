import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyMachineRetargetToProjectSettings,
  applyProcessProfileToProjectSettings,
  retargetProjectSettingsToMachine,
  stripSliceInfoPrinterModelId
} from './machine-retarget.js'

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

  // Dependent runtime maps are re-derived for the new (dual-extruder) topology. The per-FILAMENT
  // nozzle map keeps each slot's own assignment when the target still has that nozzle — both
  // filaments were on nozzle 0 and H2D has one, so they stay there. (This assertion used to expect
  // `physical_extruder_map` copied in verbatim, which only looked right because a 2-filament project
  // and a 2-extruder machine have the same length: it silently split the two filaments across
  // nozzles, and for any other filament count it produced a WRONG-LENGTH map that BambuStudio read
  // out of bounds. See the per-filament tests below.)
  assert.deepEqual(out.filament_nozzle_map, ['0', '0'])
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

// `filament_nozzle_map` is indexed by FILAMENT, not by extruder. Copying `physical_extruder_map`
// into it produced a wrong-LENGTH map whenever the filament count differed from the extruder count,
// and BambuStudio then read a filament's extruder past the end of that vector — the documented
// "can not be printed on extruder <garbage>" abort / mid-slice SIGSEGV (CLI exit 139).
test('retarget rebuilds filament_nozzle_map per FILAMENT, not per extruder', () => {
  // 3 filaments onto a 2-extruder machine: the map must have 3 entries, not 2.
  const threeFilaments = {
    ...a1Project,
    filament_type: ['PLA', 'PETG', 'PLA'],
    filament_settings_id: ['A', 'B', 'C'],
    filament_nozzle_map: ['0', '0', '0']
  }
  const toH2D = retargetProjectSettingsToMachine(threeFilaments, h2dMachine, {
    printerSettingsId: 'Bambu Lab H2D 0.4 nozzle',
    printerModel: 'Bambu Lab H2D'
  })
  assert.equal((toH2D.filament_nozzle_map as string[]).length, 3, 'one entry per filament')
})

test('a dual -> single-nozzle retarget collapses every filament onto the remaining extruder', () => {
  // The H2D project has a filament assigned to the LEFT nozzle; A1 mini has only extruder 0, so
  // leaving the 1 behind is exactly what made the slice reference a nozzle that does not exist.
  const h2dProject = {
    ...a1Project,
    printer_settings_id: 'Bambu Lab H2D 0.4 nozzle',
    printer_model: 'Bambu Lab H2D',
    nozzle_diameter: ['0.4', '0.4'],
    physical_extruder_map: ['1', '0'],
    filament_type: ['PETG', 'PLA'],
    filament_settings_id: ['A', 'B'],
    filament_nozzle_map: ['1', '0']
  }
  const a1Machine = {
    name: 'Bambu Lab A1 mini 0.4 nozzle',
    type: 'machine',
    printer_model: 'Bambu Lab A1 mini',
    printable_area: ['0x0', '180x0', '180x180', '0x180'],
    nozzle_diameter: ['0.4'],
    physical_extruder_map: ['0'],
    extruder_variant_list: ['Direct Drive Standard'],
    default_nozzle_volume_type: ['Standard'],
    extruder_max_nozzle_count: ['1']
  }
  const next = retargetProjectSettingsToMachine(h2dProject, a1Machine, {
    printerSettingsId: 'Bambu Lab A1 mini 0.4 nozzle',
    printerModel: 'Bambu Lab A1 mini'
  })
  assert.deepEqual(next.filament_nozzle_map, ['0', '0'], 'no filament may reference the gone nozzle')
})

test('a retarget that keeps both nozzles preserves each filament’s own assignment', () => {
  // A coherent H2D project (dual topology + H2D identity) retargeted onto H2D.
  const h2dProject = {
    printer_settings_id: 'Bambu Lab H2D 0.4 nozzle',
    printer_model: 'Bambu Lab H2D',
    printable_area: ['0x0', '325x0', '325x320', '0x320'],
    nozzle_diameter: ['0.4', '0.4'],
    physical_extruder_map: ['1', '0'],
    extruder_variant_list: ['Direct Drive High Flow', 'Direct Drive High Flow'],
    filament_type: ['PETG', 'PLA'],
    filament_settings_id: ['A', 'B'],
    nozzle_temperature: ['255', '220'],
    filament_nozzle_map: ['1', '0']
  }
  const next = retargetProjectSettingsToMachine(h2dProject, h2dMachine, {
    printerSettingsId: 'Bambu Lab H2D 0.4 nozzle',
    printerModel: 'Bambu Lab H2D'
  })
  assert.deepEqual(next.filament_nozzle_map, ['1', '0'], 'valid per-slot choices survive the switch')
})

// ---- The whole operation in one call --------------------------------------
// `applyMachineRetargetToProjectSettings` is what the API's save and the public editor's
// browser-side save both run, so its ORDER is the contract: machine (rebuilds the topology maps
// everything later indexes by), then process, then the filament rebind. Doing the process step
// first would have the machine overwrite re-clobber it.

test('applyMachineRetargetToProjectSettings composes machine, process, and rebind in that order', () => {
  const next = applyMachineRetargetToProjectSettings(
    { ...a1Project, filament_colour: ['#000000', '#FFFFFF'], pre_start_fan_time: ['0', '0'], layer_height: ['0.28'] },
    {
      machineConfig: h2dMachine,
      printerSettingsId: 'Bambu Lab H2D 0.4 nozzle',
      printerModel: 'Bambu Lab H2D',
      processConfig: { name: '0.20mm Standard @BBL H2D', layer_height: ['0.2'] },
      processSettingOverrides: { layer_height: '0.16' },
      filamentRebinds: [
        { config: { pre_start_fan_time: ['2'] }, settingsId: 'Bambu PLA Basic @BBL H2D' },
        { config: { pre_start_fan_time: ['2'] }, settingsId: 'Bambu PLA Basic @BBL H2D' }
      ]
    }
  )
  assert.equal(next.printer_model, 'Bambu Lab H2D')
  assert.equal(next.print_settings_id, '0.20mm Standard @BBL H2D')
  assert.deepEqual(next.layer_height, '0.16', 'the session override outranks the resolved process preset')
  assert.deepEqual(next.filament_settings_id, ['Bambu PLA Basic @BBL H2D', 'Bambu PLA Basic @BBL H2D'])
  assert.deepEqual(next.pre_start_fan_time, ['2', '2'], 'the old machine’s fossil rebinds to the new stock')
})

test('applyMachineRetargetToProjectSettings with only a machine leaves process and filaments alone', () => {
  // Both are best-effort: an unresolvable process (a project-embedded preset has no file) must not
  // block the machine retarget, which is the part that makes the project openable on the new printer.
  const next = applyMachineRetargetToProjectSettings(
    { ...a1Project, filament_colour: ['#000000', '#FFFFFF'], layer_height: ['0.28'] },
    { machineConfig: h2dMachine, printerSettingsId: 'Bambu Lab H2D 0.4 nozzle', printerModel: 'Bambu Lab H2D' }
  )
  assert.equal(next.printer_model, 'Bambu Lab H2D')
  assert.deepEqual(next.layer_height, ['0.28'])
  assert.deepEqual(next.filament_settings_id, ['Bambu PLA Basic @BBL A1M', 'Bambu PLA Basic @BBL A1M'])
})

test('stripSliceInfoPrinterModelId drops the previous slice’s printer, and nothing else', () => {
  const xml = [
    '<config>',
    '  <metadata key="printer_model_id" value="BL-P001"/>',
    '  <metadata key="index" value="1"/>',
    '</config>'
  ].join('\n')
  const stripped = stripSliceInfoPrinterModelId(xml)
  assert.doesNotMatch(stripped, /printer_model_id/)
  assert.match(stripped, /key="index" value="1"/)
  // A project that never carried one is untouched rather than reformatted.
  assert.equal(stripSliceInfoPrinterModelId('<config><plate/></config>'), '<config><plate/></config>')
})

/**
 * A machine PRESET and a PROJECT spell the same value differently, so the wholesale copy has to
 * translate. Both cases measured against BambuStudio's own save of a real H2D project, which writes
 * `best_object_pos: "0.3,0.5"` and `enable_long_retraction_when_cut: "2"` where its machine preset
 * holds `"0.3x0.5"` and `["2"]`. Copying either verbatim left the project holding a value
 * BambuStudio never wrote.
 */
test('a point from the machine preset is rewritten in the project\'s serialization', () => {
  const next = retargetProjectSettingsToMachine(
    { best_object_pos: '0.3,0.5' } as never,
    { best_object_pos: '0.3x0.5' } as never,
    { printerSettingsId: 'Bambu Lab H2D 0.4 nozzle', printerModel: 'Bambu Lab H2D' }
  )
  assert.equal(next.best_object_pos, '0.3,0.5')
})

test('a one-element preset vector does not widen a scalar the project holds bare', () => {
  const next = retargetProjectSettingsToMachine(
    { enable_long_retraction_when_cut: '2' } as never,
    { enable_long_retraction_when_cut: ['2'] } as never,
    { printerSettingsId: 'Bambu Lab H2D 0.4 nozzle', printerModel: 'Bambu Lab H2D' }
  )
  assert.equal(next.enable_long_retraction_when_cut, '2')
})

/**
 * `extruder_nozzle_stats` is `VolumeType#count` per extruder, where the count is how many filaments
 * that extruder feeds — the BAKE owns it (it changes with every nozzle assignment). It is NOT
 * `extruder_max_nozzle_count`, which is a different quantity: a real H2D project carries
 * `["Standard#2","Standard#1"]` beside `extruder_max_nozzle_count: ["1","1"]`, so recomputing it
 * here flattened the project's own correct value to `["Standard#1","Standard#1"]` on every save.
 */
test('extruder_nozzle_stats survives a retarget that cannot derive it', () => {
  const next = retargetProjectSettingsToMachine(
    { extruder_nozzle_stats: ['Standard#2', 'Standard#1'] } as never,
    { extruder_max_nozzle_count: ['1', '1'], nozzle_volume_type: ['Standard', 'Standard'] } as never,
    { printerSettingsId: 'Bambu Lab H2D 0.4 nozzle', printerModel: 'Bambu Lab H2D' }
  )
  assert.deepEqual(next.extruder_nozzle_stats, ['Standard#2', 'Standard#1'])
})
