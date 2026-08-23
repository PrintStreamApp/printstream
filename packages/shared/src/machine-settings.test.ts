import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildMachinePresetConfig,
  diffMachineConfig,
  machineColumnValue,
  machineColumnsForPage,
  machineExtruderCount,
  machineSettingsCatalog,
  machineSupportsSilentMode,
  setMachineColumnValue
} from './machine-settings.js'
import type { ProcessConfig } from './process-settings.js'

/** A two-extruder printer, as an H2D preset resolves. */
function dualExtruderConfig(extra: ProcessConfig = {}): ProcessConfig {
  return {
    nozzle_diameter: ['0.4', '0.4'],
    retraction_length: ['0.8', '1.2'],
    extruder_offset: ['0x0', '20x0'],
    ...extra
  }
}

test('catalog pages exist and every line key resolves to an option', () => {
  assert.ok(machineSettingsCatalog.pages.length >= 5)
  for (const page of machineSettingsCatalog.pages) {
    for (const group of page.groups) {
      for (const line of group.lines) {
        for (const key of line.keys) {
          assert.ok(machineSettingsCatalog.options[key], `${key} on ${page.id} has no option`)
        }
      }
    }
  }
})

test('extruder count comes from nozzle_diameter, defaulting to one', () => {
  assert.equal(machineExtruderCount(dualExtruderConfig()), 2)
  assert.equal(machineExtruderCount({ nozzle_diameter: ['0.4'] }), 1)
  // A preset that stored it as a scalar, or not at all, is still a printer with one extruder.
  assert.equal(machineExtruderCount({ nozzle_diameter: '0.4' }), 1)
  assert.equal(machineExtruderCount({}), 1)
})

test('the extruder page gives one labelled column per extruder', () => {
  const columns = machineColumnsForPage('retraction_length', 'extruder', dualExtruderConfig())
  assert.deepEqual(columns, [
    { index: 0, label: 'Extruder 1' },
    { index: 1, label: 'Extruder 2' }
  ])
})

test('a single-extruder printer gets one unlabelled column', () => {
  // BambuStudio names the page "Extruder" with no number when there is only one, so the control
  // needs no name of its own either: the line label already says what it is.
  const columns = machineColumnsForPage('retraction_length', 'extruder', { nozzle_diameter: ['0.4'] })
  assert.deepEqual(columns, [{ index: 0 }])
})

test('motion limits are Normal/Silent columns, and Silent only when the machine has it', () => {
  const quiet = { ...dualExtruderConfig(), silent_mode: '1' }
  assert.equal(machineSupportsSilentMode(quiet), true)
  assert.deepEqual(machineColumnsForPage('machine_max_speed_x', 'motion-ability', quiet), [
    { index: 0, label: 'Normal' },
    { index: 1, label: 'Silent' }
  ])
  // Two extruders must NOT turn the motion limits into two extruder columns: those elements are
  // print modes, not toolheads (`TabPrinter::build_kinematics_page`).
  assert.deepEqual(machineColumnsForPage('machine_max_speed_x', 'motion-ability', dualExtruderConfig()), [{ index: 0 }])
})

test('a vector option outside those pages stays a single column', () => {
  // `nozzle_type` is a vector, but its Basic information line is an `append_single_option_line`
  // with no extruder index, so BambuStudio shows the first element alone.
  assert.ok(machineSettingsCatalog.options.nozzle_type?.vector)
  assert.deepEqual(machineColumnsForPage('nozzle_type', 'basic-information', dualExtruderConfig()), [{ index: 0 }])
})

test('a non-vector option is a single column even on the extruder page', () => {
  assert.deepEqual(machineColumnsForPage('printable_height', 'extruder', dualExtruderConfig()), [{ index: 0 }])
})

test('a column reads its own element, falling back to the first', () => {
  assert.equal(machineColumnValue(['0.8', '1.2'], 1), '1.2')
  assert.equal(machineColumnValue('0.8', 0), '0.8')
  // A vector shorter than the extruder count is normal, BambuStudio resizes lazily, and must read
  // as the first extruder's value, not as blank.
  assert.equal(machineColumnValue(['0.8'], 1), '0.8')
  assert.equal(machineColumnValue(undefined, 0), '')
})

test('editing one extruder leaves the others alone', () => {
  // The regression this whole column model exists for: collapsing a vector to element 0 (what the
  // process dialog's scalar accessor does) would write extruder 2's edit into extruder 1.
  const edited = setMachineColumnValue(['0.8', '1.2'], 1, '2.4')
  assert.deepEqual(edited, ['0.8', '2.4'])
  const first = setMachineColumnValue(['0.8', '1.2'], 0, '0.2')
  assert.deepEqual(first, ['0.2', '1.2'])
})

test('editing a later extruder widens a short vector by repeating the first value', () => {
  // Padding with blanks instead would leave extruder 1 with no retraction length at all.
  assert.deepEqual(setMachineColumnValue(['0.8'], 1, '1.2'), ['0.8', '1.2'])
  assert.deepEqual(setMachineColumnValue('0.8', 1, '1.2'), ['0.8', '1.2'])
  assert.deepEqual(setMachineColumnValue(undefined, 1, '1.2'), ['', '1.2'])
})

test('editing column 0 of a scalar keeps it scalar', () => {
  // A preset that never stored a vector here must not grow one just because it was edited.
  assert.equal(setMachineColumnValue('0.4', 0, '0.6'), '0.6')
})

test('diffMachineConfig compares through the catalog option', () => {
  const base: ProcessConfig = { printable_height: '250' }
  assert.deepEqual(diffMachineConfig(base, { printable_height: '250' }), {})
  assert.deepEqual(diffMachineConfig(base, { printable_height: '240' }), { printable_height: '240' })
})

test('saving a printer preset preserves the keys the editor cannot show', () => {
  // The bed shape, printable area and model identity are edited in BambuStudio through bespoke
  // widgets this dialog does not have, so they are absent from the catalog. A save assembled from
  // the editable keys alone would drop them and rebuild the preset around a different bed.
  const resolved: ProcessConfig = {
    printable_area: ['0x0', '256x0', '256x256', '0x256'],
    bed_exclude_area: ['0x0', '18x0', '18x28', '0x28'],
    printer_model: 'Bambu Lab X1 Carbon',
    printer_variant: '0.4',
    printable_height: '250',
    nozzle_diameter: ['0.4']
  }
  const baseline: ProcessConfig = { ...resolved }
  const saved = buildMachinePresetConfig({
    resolved,
    baseline,
    edited: { ...baseline, printable_height: '240' },
    name: 'X1C tall bed'
  })

  assert.deepEqual(saved.printable_area, ['0x0', '256x0', '256x256', '0x256'])
  assert.deepEqual(saved.bed_exclude_area, ['0x0', '18x0', '18x28', '0x28'])
  assert.equal(saved.printer_model, 'Bambu Lab X1 Carbon')
  assert.equal(saved.printer_variant, '0.4')
  assert.equal(saved.printable_height, '240')
  assert.equal(saved.name, 'X1C tall bed')
  assert.equal(saved.type, 'machine')
})

test('a saved printer preset carries a per-extruder edit as a full vector', () => {
  const resolved = dualExtruderConfig({ printer_model: 'Bambu Lab H2D' })
  const saved = buildMachinePresetConfig({
    resolved,
    baseline: { ...resolved },
    edited: { ...resolved, retraction_length: setMachineColumnValue(resolved.retraction_length, 1, '2.4') },
    name: 'H2D tuned'
  })
  assert.deepEqual(saved.retraction_length, ['0.8', '2.4'])
  assert.deepEqual(saved.extruder_offset, ['0x0', '20x0'])
})
