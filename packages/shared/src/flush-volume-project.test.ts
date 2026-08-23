/**
 * Reading a real project's flush context.
 *
 * The fixture is the shape of an actual dual-nozzle (H2D) save, including the part that trips
 * everyone: `nozzle_volume` and `nozzle_flush_dataset` carry FIVE entries for two extruders,
 * because on a machine with extruder variants they are indexed by (extruder x variant), so an
 * extruder's row is NOT its position, and reading positionally is wrong in the worst way, since
 * index 0 is right for the first extruder and only the SECOND nozzle is silently mis-priced.
 *
 * Everything asserted here was checked against the real BambuStudio CLI, which computes this
 * matrix itself when handed `--filament-colour`. That is what caught the positional bug, and what
 * settled the two places its GUI and its engine disagree (the variant lookup, and hoisting the
 * dead volumes out of the per-extruder loop). See `docs/slicer-architecture.md`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readProjectFlushContext } from './flush-volume-project.js'

const h2dProject = {
  filament_colour: ['#FFFFFFFF', '#000000FF'],
  filament_type: ['PLA', 'PETG'],
  filament_is_support: ['0', '1'],
  nozzle_diameter: ['0.4', '0.4'],
  nozzle_volume: ['130', '133', '145', '148', '148'],
  nozzle_flush_dataset: ['1', '2', '1', '2', '2'],
  nozzle_volume_type: ['Standard', 'High Flow'],
  flush_volumes_matrix: ['0', '90', '900', '0', '0', '91', '901', '0'],
  flush_multiplier: ['1', '1'],
  long_retractions_when_cut: ['0', '0'],
  retraction_distances_when_cut: ['10', '10'],
  filament_retraction_distances_when_cut: ['nil', 'nil'],
  filament_long_retractions_when_cut: ['nil', 'nil'],
  enable_long_retraction_when_cut: '2',
  prime_volume_mode: 'Default'
}

test('a dual-nozzle project reads one matrix block per extruder', () => {
  const context = readProjectFlushContext(JSON.stringify(h2dProject))
  assert.ok(context)
  assert.equal(context.filamentCount, 2)
  assert.equal(context.extruderCount, 2)
  assert.deepEqual(context.storedBlocks, [[[0, 90], [900, 0]], [[0, 91], [901, 0]]])
  assert.equal(context.matrixInconsistent, false)
  assert.deepEqual(context.multiplier, [1, 1])
  assert.equal(context.multiplierKey, 'flush_multiplier')
  assert.deepEqual(context.filamentIsSupport, [false, true])
})

test('a variant-wide machine array is resolved through the variant table, not by position', () => {
  // The real H2D layout: five (extruder x variant) rows for two extruders. Extruder 2's row is
  // index 2, `Direct Drive Standard` with `printer_extruder_id` 2, NOT index 1. Reading
  // positionally gives it dataset 2 (a different measured table) and silently mis-prices every
  // purge on the second nozzle while the first stays correct. Confirmed against the real CLI:
  // this machine resolves BOTH extruders to dataset 1.
  const context = readProjectFlushContext(JSON.stringify({
    ...h2dProject,
    printer_extruder_variant: [
      'Direct Drive Standard', 'Direct Drive High Flow',
      'Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive TPU High Flow'
    ],
    printer_extruder_id: ['1', '1', '2', '2', '2'],
    extruder_type: ['Direct Drive', 'Direct Drive'],
    nozzle_volume_type: ['Standard', 'Standard']
  }))
  assert.ok(context)
  assert.deepEqual(context.datasetCodes, [1, 1])
})

test('a machine with no variant table falls back to positional rows', () => {
  // Every single-variant machine: BambuStudio's own `index = 0` default degrades to this.
  const context = readProjectFlushContext(JSON.stringify(h2dProject))
  assert.ok(context)
  assert.deepEqual(context.datasetCodes, [1, 2])
})

test('every extruder gets extruder 0 dead volumes, as the engine hoists them', () => {
  // `get_min_flush_volumes(config, 0)` sits OUTSIDE the engine's per-extruder loop, so the second
  // nozzle purges by the first one's volume even when its own differs (130 here, not 133). Its GUI
  // dialog computes per-extruder and therefore disagrees; we follow the engine, because these
  // numbers are written into the project and it is the engine that purges. Verified against the
  // real CLI on an H2D.
  const context = readProjectFlushContext(JSON.stringify(h2dProject))
  assert.ok(context)
  assert.deepEqual(context.minFlushVolumes, [[130, 130], [130, 130]])
})

test('a `nil` retraction distance is unset, not zero', () => {
  const context = readProjectFlushContext(JSON.stringify({
    ...h2dProject,
    filament_long_retractions_when_cut: ['1', '1'],
    filament_retraction_distances_when_cut: ['nil', '18']
  }))
  assert.ok(context)
  // Slot 0 falls back to the machine's 10 mm; slot 1 uses its own 18 mm. Reading `nil` as 0 would
  // silently give slot 0 the full nozzle volume and over-quote every purge from it.
  assert.deepEqual(context.minFlushVolumes[0], [105, 86])
})

test('Fast purge mode reads the fast multiplier', () => {
  const context = readProjectFlushContext(JSON.stringify({
    ...h2dProject, prime_volume_mode: 'Fast', flush_multiplier_fast: ['1.2', '1.4']
  }))
  assert.ok(context)
  assert.equal(context.multiplierKey, 'flush_multiplier_fast')
  assert.deepEqual(context.multiplier, [1.2, 1.4])
})

test('an absent multiplier falls back to the engine default for its key', () => {
  const { flush_multiplier: _omitted, ...withoutMultiplier } = h2dProject
  assert.deepEqual(readProjectFlushContext(JSON.stringify(withoutMultiplier))?.multiplier, [1, 1])
  const fast = readProjectFlushContext(JSON.stringify({ ...withoutMultiplier, prime_volume_mode: 'Fast' }))
  assert.deepEqual(fast?.multiplier, [1.2, 1.2])
})

test('an absent matrix reads as unset, and a mis-sized one as the repairable defect', () => {
  // Absent is legitimate, it is what makes BambuStudio compute the matrix itself.
  const { flush_volumes_matrix: _omitted, ...absent } = h2dProject
  const absentContext = readProjectFlushContext(JSON.stringify(absent))
  assert.equal(absentContext?.storedBlocks, null)
  assert.equal(absentContext?.matrixInconsistent, false)
  // A matrix left sized for one extruder after a dual retarget: no blocks to show, but this one
  // is a DEFECT and the UI must be able to say so rather than showing an empty grid.
  const short = readProjectFlushContext(JSON.stringify({ ...h2dProject, flush_volumes_matrix: ['0', '90', '900', '0'] }))
  assert.equal(short?.storedBlocks, null)
  assert.equal(short?.matrixInconsistent, true)
})

test('an unreadable or filament-less document is unknown, not healthy', () => {
  assert.equal(readProjectFlushContext(null), null)
  assert.equal(readProjectFlushContext('not json'), null)
  assert.equal(readProjectFlushContext('{}'), null)
})
