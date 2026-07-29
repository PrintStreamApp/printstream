import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyFilamentSlotOverrides, filamentPresetFamilyName, rebindProjectFilamentPhysics, selectFilamentRebindTargets } from './filament-rebind.js'

test('filamentPresetFamilyName strips the machine variant suffix (the BambuStudio alias)', () => {
  assert.equal(filamentPresetFamilyName('Bambu PETG HF @BBL X1C'), 'Bambu PETG HF')
  assert.equal(filamentPresetFamilyName('Bambu PETG HF @BBL H2D 0.4 nozzle'), 'Bambu PETG HF')
  assert.equal(filamentPresetFamilyName('Generic PLA'), 'Generic PLA')
})

// The production fossil: an X1C project carried the engine default pre_start_fan_time=0 flat
// (never a user choice — different_settings_to_system is empty), retargeted to H2D whose stock
// is 2. The rebind must move the value to the NEW variant's stock, exactly like BambuStudio's
// alias re-selection on a machine switch.
test('non-overridden values rebind to the new machine preset; the fossil disappears', () => {
  const record = {
    filament_settings_id: ['Bambu PETG HF @BBL X1C'],
    filament_colour: ['#000000'],
    filament_type: ['PETG'],
    filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'],
    different_settings_to_system: ['', ''],
    pre_start_fan_time: ['0'],
    nozzle_temperature: ['245']
  }
  const next = rebindProjectFilamentPhysics(record, [{
    config: { pre_start_fan_time: ['2', '2'], nozzle_temperature: ['245', '245'] },
    settingsId: 'Bambu PETG HF @BBL H2D 0.4 nozzle'
  }])
  assert.deepEqual(next.pre_start_fan_time, ['2', '2'], 'the fossil rebinds to the new variant stock, at the new variant width')
  assert.deepEqual(next.nozzle_temperature, ['245', '245'])
  assert.deepEqual(next.filament_settings_id, ['Bambu PETG HF @BBL H2D 0.4 nozzle'], 'the selection follows the alias re-selection')
  assert.equal(record.pre_start_fan_time[0], '0', 'the input record is never mutated')
})

test('a recorded user override survives the machine switch at the new variant width', () => {
  const record = {
    filament_settings_id: ['Bambu PETG HF @BBL X1C'],
    filament_colour: ['#000000'],
    filament_type: ['PETG'],
    filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'],
    // Slot 1's record (index 1; index 0 is the process slot) marks nozzle_temperature as a
    // genuine user override.
    different_settings_to_system: ['', 'nozzle_temperature'],
    nozzle_temperature: ['270'],
    pre_start_fan_time: ['0']
  }
  const next = rebindProjectFilamentPhysics(record, [{
    config: { nozzle_temperature: ['245', '245'], pre_start_fan_time: ['2', '2'] }
  }])
  assert.deepEqual(next.nozzle_temperature, ['270', '270'], 'the override outranks the new preset')
  assert.deepEqual(next.pre_start_fan_time, ['2', '2'], 'non-overridden siblings still rebind')
})

test('a present key the new preset does not define drops unless an override needs it', () => {
  const record = {
    filament_settings_id: ['Bambu PETG HF @BBL X1C', 'Bambu PLA Basic @BBL X1C'],
    filament_colour: ['#000000', '#FFFFFF'],
    filament_type: ['PETG', 'PLA'],
    different_settings_to_system: ['', '', 'filament_retraction_length'],
    // Neither new preset defines these; slot 2 overrides retraction, nobody overrides wipe.
    filament_retraction_length: ['0.4', '0.8'],
    filament_wipe_distance: ['1', '1']
  }
  const next = rebindProjectFilamentPhysics(record, [
    { config: { nozzle_temperature: ['245'] } },
    { config: { nozzle_temperature: ['220'] } }
  ])
  assert.equal('filament_wipe_distance' in next, false, 'absence means the preset default on the new machine')
  assert.deepEqual(next.filament_retraction_length, ['0.4', '0.8'], 'kept because slot 2 recorded it (slot 1 keeps its old value to fill the column)')
})

test('multi-slot: each slot rebinds to its own preset column-block', () => {
  const record = {
    filament_settings_id: ['Bambu PETG HF @BBL X1C', 'Bambu PLA Basic @BBL X1C'],
    filament_colour: ['#000000', '#FFFFFF'],
    filament_type: ['PETG', 'PLA'],
    filament_extruder_variant: ['DDS', 'DDHF', 'DDS', 'DDHF'],
    different_settings_to_system: ['', '', ''],
    nozzle_temperature: ['245', '245', '220', '220']
  }
  const next = rebindProjectFilamentPhysics(record, [
    { config: { nozzle_temperature: ['255', '255'] } },
    { config: { nozzle_temperature: ['225', '225'] } }
  ])
  assert.deepEqual(next.nozzle_temperature, ['255', '255', '225', '225'])
})

test('a slot with no rebind target keeps its values; a full no-op returns the record unchanged', () => {
  const record = {
    filament_settings_id: ['Some Vendor Filament'],
    filament_colour: ['#111111'],
    filament_type: ['PLA'],
    different_settings_to_system: ['', ''],
    nozzle_temperature: ['215']
  }
  assert.equal(rebindProjectFilamentPhysics(record, [{ config: null }]), record, 'nothing to do returns the same reference')
  // Slot count mismatch is defensive no-op.
  assert.equal(rebindProjectFilamentPhysics(record, [{ config: { nozzle_temperature: ['200'] } }, { config: null }]), record)
})

// "Save in this 3MF" persistence: the tune dialog's per-material overrides write whole column
// sets into project_settings AND record themselves in different_settings_to_system — the marker
// that makes a later retarget preserve them instead of rebinding them away as fossils.
test('applyFilamentSlotOverrides writes the override column and records it for the slot', () => {
  const record = {
    filament_settings_id: ['Bambu PETG HF @BBL H2D 0.4 nozzle', 'Bambu PLA Basic @BBL H2D 0.4 nozzle'],
    filament_colour: ['#000000', '#FFFFFF'],
    filament_type: ['PETG', 'PLA'],
    filament_extruder_variant: ['DDS', 'DDHF', 'DDS', 'DDHF'],
    different_settings_to_system: ['wall_loops', '', '', ''],
    nozzle_temperature: ['245', '245', '220', '220']
  }
  const next = applyFilamentSlotOverrides(record, { 1: { nozzle_temperature: '270' } }, [null, null])
  assert.deepEqual(next.nozzle_temperature, ['270', '270', '220', '220'], 'slot 1 takes the override at variant width; slot 2 keeps its value')
  assert.deepEqual(next.different_settings_to_system, ['wall_loops', 'nozzle_temperature', '', ''], 'the override is recorded for slot 1 only')
  assert.deepEqual(record.nozzle_temperature, ['245', '245', '220', '220'], 'input record is not mutated')
})

test('applyFilamentSlotOverrides fills a missing key from the slot presets, or skips it whole', () => {
  const record = {
    filament_settings_id: ['Bambu PETG HF @BBL X1C', 'Bambu PLA Basic @BBL X1C'],
    filament_colour: ['#000000', '#FFFFFF'],
    filament_type: ['PETG', 'PLA'],
    different_settings_to_system: ['', '', '']
    // No physics arrays at all (a healed record).
  }
  // With preset configs, the non-overridden slot's column comes from its preset.
  const withPresets = applyFilamentSlotOverrides(record, { 1: { nozzle_temperature: '270' } }, [
    { nozzle_temperature: '245' },
    { nozzle_temperature: '220' }
  ])
  assert.deepEqual(withPresets.nozzle_temperature, ['270', '220'])
  // Without them the key cannot cover slot 2 — skipped whole, and NOT recorded (a record without
  // a deviating value would read as a phantom marker).
  const withoutPresets = applyFilamentSlotOverrides(record, { 1: { nozzle_temperature: '270' } }, [null, null])
  assert.equal('nozzle_temperature' in withoutPresets, false)
  assert.equal(withoutPresets, record, 'nothing written returns the same reference')
})

test('applyFilamentSlotOverrides dedupes an already-recorded key and pads a short record', () => {
  const record = {
    filament_settings_id: ['Bambu PETG HF @BBL H2D 0.4 nozzle'],
    filament_colour: ['#000000'],
    filament_type: ['PETG'],
    different_settings_to_system: ['', 'nozzle_temperature'],
    nozzle_temperature: ['270']
  }
  const next = applyFilamentSlotOverrides(record, { 1: { nozzle_temperature: '265', filament_flow_ratio: '0.97' } }, [null])
  assert.deepEqual(next.nozzle_temperature, ['265'])
  assert.deepEqual(next.filament_flow_ratio, ['0.97'])
  const slotRecord = (next.different_settings_to_system as string[])[1]!.split(';').sort()
  assert.deepEqual(slotRecord, ['filament_flow_ratio', 'nozzle_temperature'], 'recorded once each, no duplicate')
  assert.equal((next.different_settings_to_system as string[]).length, 3, 'record padded to [process, slot, machine] shape')
})

test('the tune-edit record survives a subsequent machine retarget (the passes compose)', () => {
  const record = {
    filament_settings_id: ['Bambu PETG HF @BBL X1C'],
    filament_colour: ['#000000'],
    filament_type: ['PETG'],
    different_settings_to_system: ['', ''],
    nozzle_temperature: ['245'],
    pre_start_fan_time: ['0']
  }
  // 1. The user's tune edit persists + records.
  const tuned = applyFilamentSlotOverrides(record, { 1: { nozzle_temperature: '270' } }, [null])
  // 2. A later save retargets to H2D: the recorded tune edit survives, the fossil rebinds.
  const retargeted = rebindProjectFilamentPhysics(tuned, [{
    config: { nozzle_temperature: ['255', '255'], pre_start_fan_time: ['2', '2'] },
    settingsId: 'Bambu PETG HF @BBL H2D 0.4 nozzle'
  }])
  assert.deepEqual(retargeted.nozzle_temperature, ['270'], 'the recorded tune edit outranks the new preset')
  assert.deepEqual(retargeted.pre_start_fan_time, ['2'], 'the unrecorded fossil rebinds to stock')
})

// The rebind SELECTION, shared so the api's save and the public editor's browser-side save cannot
// disagree about where a slot lands. Both then resolve the chosen preset's config their own way.
test('selectFilamentRebindTargets keeps a compatible exact preset', () => {
  const selections = selectFilamentRebindTargets({
    filamentSettingsIds: ['Bambu PLA Basic @BBL H2D'],
    candidates: [{ id: 'a', name: 'Bambu PLA Basic @BBL H2D', printerModels: ['H2D'] }],
    targetModelKey: 'H2D',
    nozzleHint: 'Bambu Lab H2D 0.4 nozzle'
  })
  assert.equal(selections?.[0]?.target?.name, 'Bambu PLA Basic @BBL H2D')
})

test('selectFilamentRebindTargets moves an incompatible slot to its family variant, nozzle-matched', () => {
  const selections = selectFilamentRebindTargets({
    filamentSettingsIds: ['Bambu PLA Basic @BBL X1C'],
    candidates: [
      { id: 'a', name: 'Bambu PLA Basic @BBL X1C', printerModels: ['X1C'] },
      { id: 'b', name: 'Bambu PLA Basic @BBL H2D 0.2 nozzle', printerModels: ['H2D'] },
      { id: 'c', name: 'Bambu PLA Basic @BBL H2D 0.4 nozzle', printerModels: ['H2D'] }
    ],
    targetModelKey: 'H2D',
    nozzleHint: 'Bambu Lab H2D 0.4 nozzle'
  })
  assert.equal(selections?.[0]?.target?.name, 'Bambu PLA Basic @BBL H2D 0.4 nozzle')
})

test('selectFilamentRebindTargets leaves a slot alone when its family has no variant for the target', () => {
  const selections = selectFilamentRebindTargets({
    filamentSettingsIds: ['Some Exotic PA-CF @BBL X1C'],
    candidates: [{ id: 'a', name: 'Bambu PLA Basic @BBL H2D', printerModels: ['H2D'] }],
    targetModelKey: 'H2D',
    nozzleHint: 'Bambu Lab H2D 0.4 nozzle'
  })
  assert.equal(selections?.[0]?.target, null)
})

test('selectFilamentRebindTargets treats a suffix-less preset as machine-agnostic', () => {
  // "Generic PLA" declares no printers and carries no `@<printer>` suffix, so it is eligible for
  // every machine — narrowing it would strand every project using one.
  const selections = selectFilamentRebindTargets({
    filamentSettingsIds: ['Generic PLA'],
    candidates: [{ id: 'a', name: 'Generic PLA' }],
    targetModelKey: 'H2D',
    nozzleHint: 'Bambu Lab H2D 0.4 nozzle'
  })
  assert.equal(selections?.[0]?.target?.name, 'Generic PLA')
})

test('selectFilamentRebindTargets refuses a partly-blank slot list rather than mis-columning it', () => {
  assert.equal(selectFilamentRebindTargets({
    filamentSettingsIds: ['Bambu PLA Basic @BBL H2D', ''],
    candidates: [{ id: 'a', name: 'Bambu PLA Basic @BBL H2D', printerModels: ['H2D'] }],
    targetModelKey: 'H2D',
    nozzleHint: 'Bambu Lab H2D 0.4 nozzle'
  }), null)
})
