/** Browser slice authoring must describe the frozen target, not preserve save-time settings. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SceneEdit, SlicingTarget } from '@printstream/shared'
import { THREE_MF_MODEL_SETTINGS_ENTRY, THREE_MF_PROJECT_SETTINGS_ENTRY, THREE_MF_SLICE_INFO_ENTRY } from '@printstream/shared/three-mf'
import { applyClientSliceSettings } from './clientSliceSettingsPass'
import type { RetargetResolvers } from './browserMachineRetarget'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

test('authors a selected process even when the printer did not change', async () => {
  const abort = new AbortController()
  const seenSignals: Array<AbortSignal | undefined> = []
  const resolvers: RetargetResolvers = {
    canResolve: () => true,
    machine: async (_id, _target, options) => {
      seenSignals.push(options?.signal)
      return {
        name: 'Selected Machine',
        config: {
          printer_model: 'Test Printer',
          printer_settings_id: 'Selected Machine',
          inherits: 'System Test Printer 0.4 nozzle',
          printable_area: ['0x0', '200x0', '200x200', '0x200']
        }
      }
    },
    process: async (_id, _target, options) => {
      seenSignals.push(options?.signal)
      return {
        config: {
          name: 'Selected Fine',
          layer_height: '0.12',
          sparse_infill_density: '15%'
        },
        baseConfig: {},
        overriddenKeys: []
      }
    },
    filament: async () => { throw new Error('not used') }
  }
  const target: SlicingTarget = {
    mode: 'manualProfile',
    printerProfileId: 'custom:selected',
    printerModel: 'Test Printer',
    processProfileId: 'process:selected',
    processSettingOverrides: { sparse_infill_density: '28%' },
    plateType: 'textured_pei_plate',
    filamentMappings: []
  }
  const output = {
    [THREE_MF_PROJECT_SETTINGS_ENTRY]: encoder.encode(JSON.stringify({
      printer_model: 'Test Printer',
      printer_settings_id: 'Selected Machine',
      print_settings_id: 'Old Draft',
      layer_height: '0.28',
      sparse_infill_density: '5%',
      filament_settings_id: ['Generic PLA'],
      filament_colour: ['#FFFFFF'],
      inherits_group: ['Old process parent', 'Old filament parent', 'Old machine parent']
    })),
    [THREE_MF_SLICE_INFO_ENTRY]: encoder.encode(
      '<config>\n  <metadata key="printer_model_id" value="OLD"/>\n  <plate><filament id="1" group_id="0"/></plate>\n</config>'
    )
  }

  await applyClientSliceSettings(output, { plates: [] } as unknown as SceneEdit, {
    target,
    slicerTargetId: 'engine-1',
    resolvers,
    signal: abort.signal
  })

  const settings = JSON.parse(decoder.decode(output[THREE_MF_PROJECT_SETTINGS_ENTRY])) as Record<string, unknown>
  assert.equal(settings.print_settings_id, 'Selected Fine')
  assert.equal(settings.layer_height, '0.12')
  assert.equal(settings.sparse_infill_density, '28%')
  assert.equal(settings.curr_bed_type, 'Textured PEI Plate')
  assert.deepEqual(settings.inherits_group, ['', 'Old filament parent', 'System Test Printer 0.4 nozzle'])
  assert.doesNotMatch(decoder.decode(output[THREE_MF_SLICE_INFO_ENTRY]), /printer_model_id/)
  assert.doesNotMatch(decoder.decode(output[THREE_MF_SLICE_INFO_ENTRY]), /group_id/)
  assert.deepEqual(seenSignals, [abort.signal, abort.signal])
})

test('authors per-slot filament selection and lets slot overrides beat slice-wide overrides', async () => {
  const resolvers: RetargetResolvers = {
    canResolve: () => true,
    machine: async () => ({
      name: 'Dual Machine',
      config: {
        printer_model: 'Dual Printer',
        printer_settings_id: 'Dual Machine',
        physical_extruder_map: ['1', '0'],
        extruder_nozzle_stats: ['Standard#1', 'Standard#1']
      }
    }),
    process: async () => ({ config: {}, baseConfig: {}, overriddenKeys: [] }),
    filament: async () => ({
      config: {
        filament_settings_id: ['Selected PETG'],
        filament_type: ['PETG'],
        nozzle_temperature: ['245']
      },
      baseConfig: {},
      overriddenKeys: []
    })
  }
  const target: SlicingTarget = {
    mode: 'manualProfile',
    printerProfileId: 'machine:dual',
    printerModel: 'Dual Printer',
    processProfileId: null,
    filamentSettingOverrides: { nozzle_temperature: '250' },
    filamentMappings: [{
      projectFilamentId: 1,
      profileId: 'filament:petg',
      source: 'manual',
      toolheadId: 'nozzle-1',
      settingOverrides: { nozzle_temperature: '255' }
    }]
  }
  const edit = {
    plates: [],
    // The frozen target below moves this slot to nozzle 1. The edit's older value must not win.
    filaments: [{ color: '#ffffff', type: 'PETG', settingsId: 'Old PLA', nozzleId: 0 }]
  } as unknown as SceneEdit
  const output = {
    [THREE_MF_PROJECT_SETTINGS_ENTRY]: encoder.encode(JSON.stringify({
      filament_settings_id: ['Old PLA'],
      filament_type: ['PLA'],
      nozzle_temperature: ['210']
    })),
    [THREE_MF_MODEL_SETTINGS_ENTRY]: encoder.encode('<config><plate><metadata key="filament_map_mode" value="Auto For Flush"/></plate></config>')
  }

  await applyClientSliceSettings(output, edit, { target, slicerTargetId: null, resolvers })

  const settings = JSON.parse(decoder.decode(output[THREE_MF_PROJECT_SETTINGS_ENTRY])) as Record<string, unknown>
  assert.deepEqual(settings.filament_settings_id, ['Selected PETG'])
  assert.deepEqual(settings.filament_type, ['PETG'])
  assert.deepEqual(settings.nozzle_temperature, ['255'])
  assert.deepEqual(settings.filament_nozzle_map, ['1'])
  assert.equal(settings.filament_map_mode, 'Manual')
  assert.deepEqual(settings.filament_map, ['1'])
  assert.match(decoder.decode(output[THREE_MF_MODEL_SETTINGS_ENTRY]), /filament_map_mode" value="Manual"/)
  assert.match(decoder.decode(output[THREE_MF_MODEL_SETTINGS_ENTRY]), /filament_maps" value="1"/)
})

test('clears an inherited manual map when retargeting to a single-nozzle machine', async () => {
  const resolvers: RetargetResolvers = {
    canResolve: () => true,
    machine: async () => ({
      name: 'Single Machine',
      config: {
        printer_model: 'Single Printer',
        printer_settings_id: 'Single Machine',
        physical_extruder_map: ['0'],
        extruder_nozzle_stats: ['Standard#1']
      }
    }),
    process: async () => ({ config: {}, baseConfig: {}, overriddenKeys: [] }),
    filament: async () => { throw new Error('not used') }
  }
  const target: SlicingTarget = {
    mode: 'manualProfile',
    printerProfileId: 'machine:single',
    printerModel: 'Single Printer',
    filamentMappings: [{ projectFilamentId: 1, source: 'manual' }]
  }
  const output = {
    [THREE_MF_PROJECT_SETTINGS_ENTRY]: encoder.encode(JSON.stringify({
      filament_settings_id: ['PLA'],
      filament_type: ['PLA'],
      filament_colour: ['#FFFFFF'],
      filament_map_mode: 'Manual',
      filament_map: ['2']
    })),
    [THREE_MF_MODEL_SETTINGS_ENTRY]: encoder.encode(
      '<config><plate><metadata key="filament_map_mode" value="Manual"/><metadata key="filament_maps" value="2"/></plate></config>'
    )
  }

  await applyClientSliceSettings(output, { plates: [], filaments: [{ color: '#FFFFFF', type: 'PLA' }] } as unknown as SceneEdit, {
    target,
    slicerTargetId: null,
    resolvers
  })

  const settings = JSON.parse(decoder.decode(output[THREE_MF_PROJECT_SETTINGS_ENTRY])) as Record<string, unknown>
  assert.equal('filament_map_mode' in settings, false)
  assert.equal('filament_map' in settings, false)
  assert.doesNotMatch(decoder.decode(output[THREE_MF_MODEL_SETTINGS_ENTRY]), /filament_map/)
})
