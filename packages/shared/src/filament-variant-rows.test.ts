/**
 * Filament values move by (slot, variant) whenever the row layout changes, and the rows are not a
 * uniform width (a TPU slot owns more). Each case below shipped as a wrong print or an unopenable
 * file before `filament-variant-rows.ts` existed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildFilamentVariantRows } from './filament-variant-index.js'
import { readFilamentVariantRows, relayFilamentVariantValue } from './filament-variant-rows.js'
import { applyMachineRetargetToProjectSettings, retargetProjectSettingsToMachine } from './machine-retarget.js'
import { rebindProjectFilamentPhysics } from './filament-rebind.js'
import { applyFilamentList } from './three-mf/bake-documents.js'

const X1C_VARIANTS = ['Direct Drive Standard', 'Direct Drive High Flow']
const H2D_VARIANTS = ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive TPU High Flow']

/** A two-material project on an X1C-like machine: two variant rows per slot. */
function x1cProject(): Record<string, unknown> {
  return {
    printer_settings_id: 'Bambu Lab X1 Carbon 0.4 nozzle',
    printer_model: 'Bambu Lab X1 Carbon',
    nozzle_diameter: ['0.4'],
    extruder_variant_list: ['Direct Drive Standard,Direct Drive High Flow'],
    printer_extruder_variant: X1C_VARIANTS,
    printer_extruder_id: ['1', '1'],
    filament_settings_id: ['My PLA', 'My PETG'],
    filament_colour: ['#FFFFFF', '#000000'],
    filament_type: ['PLA', 'PETG'],
    filament_extruder_variant: [...X1C_VARIANTS, ...X1C_VARIANTS],
    filament_self_index: ['1', '1', '2', '2'],
    nozzle_temperature: ['220', '221', '255', '256']
  }
}

/** An X2D-like machine: a direct-drive extruder and a Bowden one, three variants each. */
const X2D_MACHINE = {
  printer_model: 'Bambu Lab X2D',
  nozzle_diameter: ['0.4', '0.4'],
  physical_extruder_map: ['1', '0'],
  extruder_variant_list: [
    'Direct Drive Standard,Direct Drive High Flow,Direct Drive E3D High Flow',
    'Bowden Standard,Bowden High Flow,Bowden E3D High Flow'
  ],
  default_nozzle_volume_type: ['Standard', 'Standard'],
  extruder_max_nozzle_count: ['1', '1']
}

test('rows are read from the index, so a TPU slot may own more of them', () => {
  const layout = buildFilamentVariantRows(H2D_VARIANTS, ['PLA', 'TPU'])
  const rows = readFilamentVariantRows({ filament_extruder_variant: layout.variants, filament_self_index: layout.selfIndex }, 2)
  assert.deepEqual(rows?.map((row) => row.slot), [0, 0, 1, 1, 1])
  assert.equal(readFilamentVariantRows({ filament_extruder_variant: ['a', 'b', 'c'] }, 2), null, 'an uneven split with no index is not guessed')
})

test('a value moves by variant name, and a variant the source lacks takes the slot\'s first row', () => {
  const from = [{ slot: 0, variant: 'A' }, { slot: 0, variant: 'B' }, { slot: 1, variant: 'A' }]
  const to = [{ slot: 0, variant: 'B' }, { slot: 0, variant: 'C' }, { slot: 1, variant: 'A' }, { slot: 1, variant: 'B' }]
  assert.deepEqual(relayFilamentVariantValue(['a0', 'b0', 'a1'], from, to), ['b0', 'a0', 'a1', 'a1'])
  assert.equal(relayFilamentVariantValue(['short'], from, to), null, 'a value that does not match its layout is not attributed')
})

// F01: the retarget rebuilt the layout and left the values at the old width, so slot 2's rows were
// out of range and the engine read slot 1's 220 C for the PETG.
test('a retarget re-lays kept filament values into the new machine\'s rows', () => {
  const next = retargetProjectSettingsToMachine(x1cProject(), X2D_MACHINE, {
    printerSettingsId: 'Bambu Lab X2D 0.4 nozzle',
    printerModel: 'Bambu Lab X2D'
  })
  const variants = next.filament_extruder_variant as string[]
  const temps = next.nozzle_temperature as string[]
  assert.equal(temps.length, variants.length, 'one value per declared row')
  const index = next.filament_self_index as string[]
  const slot2 = temps.filter((_value, row) => index[row] === '2')
  assert.ok(slot2.every((value) => value === '255' || value === '256'), `the PETG keeps its own temperatures, got ${slot2}`)
  assert.equal(temps[variants.indexOf('Direct Drive High Flow')], '221', 'a variant both machines share keeps its own value')
})

// F02: the rebind treated the layout's own variant list as physics and rewrote it at a uniform
// width, leaving 6 variants under a 7-row index: Bambu Studio refuses to open that.
test('a PLA + TPU rebind keeps the layout and writes every value at the declared rows', () => {
  const layout = buildFilamentVariantRows(H2D_VARIANTS, ['PLA', 'TPU'])
  const record = {
    filament_settings_id: ['Bambu PLA Basic @BBL H2D', 'Bambu TPU 95A HF @BBL H2D'],
    filament_colour: ['#FFFFFF', '#000000'],
    filament_type: ['PLA', 'TPU'],
    filament_extruder_variant: layout.variants,
    filament_self_index: layout.selfIndex,
    different_settings_to_system: ['', '', '', ''],
    nozzle_temperature: ['220', '221', '230', '231', '232']
  }
  const next = rebindProjectFilamentPhysics(record, [
    { config: { filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'], nozzle_temperature: ['210', '211'] } },
    { config: { filament_extruder_variant: H2D_VARIANTS, nozzle_temperature: ['240', '241', '242'] } }
  ])
  assert.deepEqual(next.filament_extruder_variant, layout.variants, 'the layout is the retarget\'s, never rewritten here')
  assert.deepEqual(next.filament_self_index, layout.selfIndex)
  assert.deepEqual(next.nozzle_temperature, ['210', '211', '240', '241', '242'])
})

// F04: shrinking the width (H2D 3 rows to X1C 2) read a no-target slot with the wrong stride, so
// the PETG printed at a column of the PLA.
test('a no-target slot keeps its own values when the machine has fewer variants', () => {
  const h2dLayout = buildFilamentVariantRows(H2D_VARIANTS, ['PLA', 'PETG'])
  const project = {
    ...x1cProject(),
    printer_settings_id: 'Bambu Lab H2D 0.4 nozzle',
    nozzle_diameter: ['0.4', '0.4'],
    extruder_variant_list: ['Direct Drive Standard,Direct Drive High Flow', 'Direct Drive Standard,Direct Drive High Flow,Direct Drive TPU High Flow'],
    printer_extruder_variant: H2D_VARIANTS,
    filament_extruder_variant: h2dLayout.variants,
    filament_self_index: h2dLayout.selfIndex,
    different_settings_to_system: ['', '', '', ''],
    nozzle_temperature: ['220', '221', '255', '256']
  }
  const next = applyMachineRetargetToProjectSettings(project, {
    machineConfig: {
      printer_model: 'Bambu Lab X1 Carbon',
      nozzle_diameter: ['0.4'],
      extruder_variant_list: ['Direct Drive Standard,Direct Drive High Flow'],
      default_nozzle_volume_type: ['Standard'],
      extruder_max_nozzle_count: ['1']
    },
    printerSettingsId: 'Bambu Lab X1 Carbon 0.4 nozzle',
    printerModel: 'Bambu Lab X1 Carbon',
    filamentRebinds: [{ config: { nozzle_temperature: ['200', '201'] } }, { config: null }]
  })
  assert.deepEqual(next.nozzle_temperature, ['200', '201', '255', '256'])
})

// F09: removing or reordering materials on a PLA + TPU layout (3 + 4 rows) deleted the variant
// keys as "stale" and left the variant list unpermuted.
test('removing or reordering materials moves their variant rows with them', () => {
  const layout = buildFilamentVariantRows(H2D_VARIANTS, ['PLA', 'TPU'])
  const project = JSON.stringify({
    extruder_variant_list: ['Direct Drive Standard,Direct Drive High Flow', 'Direct Drive Standard,Direct Drive High Flow,Direct Drive TPU High Flow'],
    printer_extruder_variant: H2D_VARIANTS,
    filament_settings_id: ['Bambu PLA Basic @BBL H2D', 'Bambu TPU 95A HF @BBL H2D'],
    filament_colour: ['#FFFFFF', '#000000'],
    filament_type: ['PLA', 'TPU'],
    filament_extruder_variant: layout.variants,
    filament_self_index: layout.selfIndex,
    nozzle_temperature: ['220', '221', '230', '231', '232']
  })

  const removed = JSON.parse(applyFilamentList(project, [
    { color: '#FFFFFF', type: 'PLA', settingsId: 'Bambu PLA Basic @BBL H2D', sourceIndex: 0 }
  ])) as Record<string, unknown>
  assert.deepEqual(removed.nozzle_temperature, ['220', '221'])
  assert.deepEqual(removed.filament_extruder_variant, ['Direct Drive Standard', 'Direct Drive High Flow'])
  assert.deepEqual(removed.filament_self_index, ['1', '1'])

  const swapped = JSON.parse(applyFilamentList(project, [
    { color: '#000000', type: 'TPU', settingsId: 'Bambu TPU 95A HF @BBL H2D', sourceIndex: 1 },
    { color: '#FFFFFF', type: 'PLA', settingsId: 'Bambu PLA Basic @BBL H2D', sourceIndex: 0 }
  ])) as Record<string, unknown>
  assert.deepEqual(swapped.nozzle_temperature, ['230', '231', '232', '220', '221'])
  assert.deepEqual(swapped.filament_extruder_variant, [...H2D_VARIANTS, 'Direct Drive Standard', 'Direct Drive High Flow'])
  assert.deepEqual(swapped.filament_self_index, ['1', '1', '1', '2', '2'])
})
