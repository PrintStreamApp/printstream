import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeInheritedMachineProfile, repairEstimateModeProjectSettings } from './machine-switch-repair.js'

test('repairs estimate-mode export into the target dual-nozzle machine shape', () => {
  const mergedProfile = mergeInheritedMachineProfile('Bambu Lab H2D 0.4 nozzle', new Map([
    ['fdm_bbl_3dp_002_common', {
      change_filament_gcode: '; h2d change filament',
      default_nozzle_volume_type: ['Standard', 'Standard'],
      extruder_colour: ['#018001', '#018001'],
      extruder_max_nozzle_count: ['1', '1'],
      extruder_offset: ['0x0', '0x0'],
      extruder_printable_height: ['320', '325'],
      extruder_type: ['Direct Drive', 'Direct Drive'],
      extruder_variant_list: [
        'Direct Drive Standard,Direct Drive High Flow',
        'Direct Drive Standard,Direct Drive High Flow'
      ],
      machine_end_gcode: '; h2d end gcode',
      machine_load_filament_time: '45',
      machine_start_gcode: '; h2d start gcode',
      machine_unload_filament_time: '55',
      physical_extruder_map: ['1', '0'],
    }],
    ['Bambu Lab H2D 0.4 nozzle', {
      inherits: 'fdm_bbl_3dp_002_common',
      name: 'Bambu Lab H2D 0.4 nozzle',
      extruder_variant_list: [
        'Direct Drive Standard,Direct Drive High Flow',
        'Direct Drive Standard,Direct Drive High Flow,Direct Drive TPU High Flow'
      ]
    }]
  ]))

  const repaired = repairEstimateModeProjectSettings({
    printer_model: 'Bambu Lab H2D',
    printer_settings_id: 'Bambu Lab H2D 0.4 nozzle',
    print_settings_id: '0.20mm Standard @BBL H2D',
    default_nozzle_volume_type: ['Standard'],
    enable_filament_dynamic_map: '0',
    extruder_ams_count: ['1#0|4#0', '1#0|4#0'],
    extruder_colour: ['#018001'],
    extruder_max_nozzle_count: ['1'],
    extruder_nozzle_stats: [],
    extruder_offset: ['0x2'],
    extruder_printable_height: [],
    extruder_type: ['Direct Drive'],
    filament_extruder_compatibility: ['0'],
    filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive Standard'],
    filament_map_2: ['1'],
    filament_nozzle_map: ['1'],
    filament_type: ['ABS', 'ABS'],
    filament_volume_map: ['0'],
    machine_end_gcode: 'G28 X0',
    machine_load_filament_time: '30',
    machine_start_gcode: 'G28',
    machine_unload_filament_time: '30',
    physical_extruder_map: ['0']
  }, mergedProfile)

  assert.equal(repaired.change_filament_gcode, '; h2d change filament')
  assert.deepEqual(repaired.default_nozzle_volume_type, ['Standard', 'Standard'])
  assert.deepEqual(repaired.extruder_ams_count, ['1#0|4#1', '1#0|4#1'])
  assert.deepEqual(repaired.extruder_max_nozzle_count, ['1', '1'])
  assert.deepEqual(repaired.extruder_nozzle_stats, ['Standard#1', 'Standard#1'])
  assert.deepEqual(repaired.filament_extruder_variant, [
    'Direct Drive Standard',
    'Direct Drive High Flow',
    'Direct Drive Standard',
    'Direct Drive High Flow'
  ])
  assert.deepEqual(repaired.printer_extruder_id, ['1', '1', '2', '2', '2'])
  assert.deepEqual(repaired.filament_nozzle_map, ['1', '0'])
  assert.deepEqual(repaired.filament_volume_map, ['0', '0'])
  assert.equal(repaired.machine_end_gcode, '; h2d end gcode')
  assert.equal(repaired.machine_load_filament_time, '45')
  assert.equal(repaired.machine_start_gcode, '; h2d start gcode')
  assert.equal(repaired.machine_unload_filament_time, '55')
  assert.deepEqual(repaired.physical_extruder_map, ['1', '0'])
  assert.equal('enable_filament_dynamic_map' in repaired, false)
  assert.equal('filament_extruder_compatibility' in repaired, false)
  assert.equal('filament_map_2' in repaired, false)
})

test('mergeInheritedMachineProfile fills blank machine gcode fields from included template profiles', () => {
  const mergedProfile = mergeInheritedMachineProfile('Bambu Lab H2D 0.4 nozzle', new Map([
    ['fdm_bbl_3dp_002_common', {
      machine_start_gcode: '',
      machine_end_gcode: '',
      change_filament_gcode: ''
    }],
    ['Bambu Lab H2D 0.4 nozzle template machine_start_gcode', {
      machine_start_gcode: '; h2d start gcode'
    }],
    ['Bambu Lab H2D 0.4 nozzle template machine_end_gcode', {
      machine_end_gcode: '; h2d end gcode'
    }],
    ['Bambu Lab H2D 0.4 nozzle template change_filament_gcode', {
      change_filament_gcode: '; h2d change filament'
    }],
    ['Bambu Lab H2D 0.4 nozzle', {
      inherits: 'fdm_bbl_3dp_002_common',
      include: [
        'Bambu Lab H2D 0.4 nozzle template machine_start_gcode',
        'Bambu Lab H2D 0.4 nozzle template machine_end_gcode',
        'Bambu Lab H2D 0.4 nozzle template change_filament_gcode'
      ],
      machine_start_gcode: '',
      machine_end_gcode: null,
      change_filament_gcode: ''
    }]
  ]))

  assert.equal(mergedProfile.machine_start_gcode, '; h2d start gcode')
  assert.equal(mergedProfile.machine_end_gcode, '; h2d end gcode')
  assert.equal(mergedProfile.change_filament_gcode, '; h2d change filament')
})

test('repairs estimate-mode filament variants without carrying TPU-only printer variants into non-TPU filaments', () => {
  const repaired = repairEstimateModeProjectSettings({
    extruder_variant_list: [
      'Direct Drive Standard,Direct Drive High Flow',
      'Direct Drive Standard,Direct Drive High Flow,Direct Drive TPU High Flow'
    ],
    filament_type: ['ABS', 'ABS']
  }, {
    extruder_variant_list: [
      'Direct Drive Standard,Direct Drive High Flow',
      'Direct Drive Standard,Direct Drive High Flow,Direct Drive TPU High Flow'
    ]
  })

  assert.deepEqual(repaired.filament_extruder_variant, [
    'Direct Drive Standard',
    'Direct Drive High Flow',
    'Direct Drive Standard',
    'Direct Drive High Flow'
  ])
})