import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  expectedFlushVolumesMatrixLength,
  inspectProjectFlushVolumesMatrix,
  isFlushVolumesMatrixInconsistent,
  readFlushVolumesMatrixBlock,
  repairFlushMultiplier,
  repairFlushVolumesMatrix,
  writeFlushVolumesMatrixBlocks
} from './flush-volumes-matrix.js'

test('required length is filaments squared per extruder', () => {
  assert.equal(expectedFlushVolumesMatrixLength(1, 1), 1)
  // The regression: one filament on a dual-nozzle machine needs TWO entries, not one.
  assert.equal(expectedFlushVolumesMatrixLength(1, 2), 2)
  assert.equal(expectedFlushVolumesMatrixLength(2, 2), 8)
  assert.equal(expectedFlushVolumesMatrixLength(3, 2), 18)
})

test('a single-nozzle-sized matrix on a dual-nozzle project is inconsistent', () => {
  // Exactly the prod shape that segfaulted BambuStudio 2.7.1.62 at ~71% (exit 139).
  assert.equal(isFlushVolumesMatrixInconsistent(['0'], 1, 2), true)
  assert.equal(isFlushVolumesMatrixInconsistent(['0', '0'], 1, 2), false)
  assert.equal(isFlushVolumesMatrixInconsistent(['0'], 1, 1), false)
})

test('an absent or empty matrix is not a defect', () => {
  // Absence is one of the conditions that makes BambuStudio compute the matrix itself, so
  // flagging it would send users to repair files that already slice correctly.
  assert.equal(isFlushVolumesMatrixInconsistent(null, 1, 2), false)
  assert.equal(isFlushVolumesMatrixInconsistent(undefined, 1, 2), false)
  assert.equal(isFlushVolumesMatrixInconsistent([], 1, 2), false)
})

test('repair grows a single-nozzle matrix by duplicating its block per extruder', () => {
  assert.deepEqual(repairFlushVolumesMatrix(['0'], 1, 2), ['0', '0'])
  // 2 filaments: the 2x2 block is repeated for the second extruder, preserving the values.
  assert.deepEqual(
    repairFlushVolumesMatrix(['0', '632', '136', '0'], 2, 2),
    ['0', '632', '136', '0', '0', '632', '136', '0']
  )
})

test('repair trims an oversized matrix back to the topology', () => {
  // 16 entries on a 1-filament/2-extruder project (seen in prod) keeps only real blocks.
  assert.deepEqual(repairFlushVolumesMatrix(new Array(16).fill('7'), 1, 2), ['7', '7'])
})

test('repair returns null when there is nothing to do', () => {
  assert.equal(repairFlushVolumesMatrix(['0', '0'], 1, 2), null)
  assert.equal(repairFlushVolumesMatrix(null, 1, 2), null)
  assert.equal(repairFlushVolumesMatrix([], 1, 2), null)
  // No filaments means no meaningful matrix shape to derive.
  assert.equal(repairFlushVolumesMatrix(['0'], 0, 2), null)
})

test('inspecting project settings counts extruders per entry, not per distinct diameter', () => {
  // A dual-0.4 machine must count as TWO extruders; deduplicating the diameters would collapse
  // it to one and hide the defect entirely.
  const inspection = inspectProjectFlushVolumesMatrix(JSON.stringify({
    filament_colour: ['#F2754E'],
    nozzle_diameter: ['0.4', '0.4'],
    flush_volumes_matrix: ['0']
  }))
  assert.equal(inspection?.extruderCount, 2)
  assert.equal(inspection?.filamentCount, 1)
  assert.equal(inspection?.actualLength, 1)
  assert.equal(inspection?.expectedLength, 2)
  assert.equal(inspection?.inconsistent, true)
})

test('inspecting unreadable or filament-less settings reports unknown, never healthy', () => {
  assert.equal(inspectProjectFlushVolumesMatrix(null), null)
  assert.equal(inspectProjectFlushVolumesMatrix('not json'), null)
  assert.equal(inspectProjectFlushVolumesMatrix('[]'), null)
  assert.equal(inspectProjectFlushVolumesMatrix(JSON.stringify({ nozzle_diameter: ['0.4', '0.4'] })), null)
})

// The exit-156 shape: the ENGINE validates the matrix against `flush_multiplier.size()`, not
// `nozzle_diameter`, so a correct matrix beside a stale one-entry multiplier fails every
// multi-filament slice at "Generating G-code". A/B-reproduced against BambuStudio 2.7.1.62.
const dualNozzleTwoFilaments = {
  filament_colour: ['#000000', '#F4EE2A'],
  nozzle_diameter: ['0.4', '0.4'],
  nozzle_volume_type: ['Standard', 'Standard'],
  flush_volumes_matrix: ['0', '632', '136', '0', '0', '632', '136', '0']
}

test('a one-entry flush_multiplier on a dual-nozzle multi-filament project is inconsistent', () => {
  const inspection = inspectProjectFlushVolumesMatrix(JSON.stringify({
    ...dualNozzleTwoFilaments,
    flush_multiplier: ['1']
  }))
  assert.equal(inspection?.multiplierInconsistent, true)
  assert.equal(inspection?.matrixInconsistent, false)
  assert.equal(inspection?.inconsistent, true)
  assert.equal(inspection?.multiplierLength, 1)
})

test('an ABSENT flush_multiplier on a dual-nozzle multi-filament project is inconsistent', () => {
  // The engine default is the one-entry {1.0}, so absence fails the size check exactly like a
  // stored one-entry value (verified against the real CLI).
  const inspection = inspectProjectFlushVolumesMatrix(JSON.stringify(dualNozzleTwoFilaments))
  assert.equal(inspection?.multiplierInconsistent, true)
})

test('an OVERSIZED flush_multiplier is inconsistent too', () => {
  // The shape a filament-array remap used to produce: one entry per FILAMENT on a machine with
  // fewer extruders.
  const inspection = inspectProjectFlushVolumesMatrix(JSON.stringify({
    ...dualNozzleTwoFilaments,
    flush_multiplier: ['1', '1', '1']
  }))
  assert.equal(inspection?.multiplierInconsistent, true)
})

test('a per-extruder flush_multiplier is healthy however it fails elsewhere', () => {
  const inspection = inspectProjectFlushVolumesMatrix(JSON.stringify({
    ...dualNozzleTwoFilaments,
    flush_multiplier: ['1', '1'],
    // A one-entry fast multiplier is what genuine Bambu Studio dual-nozzle saves carry — it is
    // only read in fast purge mode and must never flag a file.
    flush_multiplier_fast: ['1.2']
  }))
  assert.equal(inspection?.multiplierInconsistent, false)
  assert.equal(inspection?.inconsistent, false)
})

test('the multiplier check models the engine escapes: one filament, absent matrix, nvt mismatch', () => {
  // One filament: GCode.cpp escapes its size check entirely.
  assert.equal(inspectProjectFlushVolumesMatrix(JSON.stringify({
    ...dualNozzleTwoFilaments,
    filament_colour: ['#000000'],
    flush_volumes_matrix: ['0', '0'],
    flush_multiplier: ['1']
  }))?.multiplierInconsistent, false)
  // Absent matrix: the CLI recomputes matrix AND multiplier itself.
  assert.equal(inspectProjectFlushVolumesMatrix(JSON.stringify({
    ...dualNozzleTwoFilaments,
    flush_volumes_matrix: undefined,
    flush_multiplier: ['1']
  }))?.multiplierInconsistent, false)
  // `nozzle_volume_type` shorter than the extruder count (or absent): that mismatch triggers the
  // CLI's flush recompute, which resizes the multiplier — such files slice clean today, and
  // flagging them would block print-prep on working projects.
  assert.equal(inspectProjectFlushVolumesMatrix(JSON.stringify({
    ...dualNozzleTwoFilaments,
    nozzle_volume_type: ['Standard'],
    flush_multiplier: ['1']
  }))?.multiplierInconsistent, false)
  assert.equal(inspectProjectFlushVolumesMatrix(JSON.stringify({
    ...dualNozzleTwoFilaments,
    nozzle_volume_type: undefined,
    flush_multiplier: ['1']
  }))?.multiplierInconsistent, false)
})

test('a single-nozzle project with a scalar or absent multiplier is healthy', () => {
  // Old single-nozzle saves store `flush_multiplier` as a bare scalar; the engine parses it as a
  // one-entry list, which matches the one extruder.
  for (const flush_multiplier of [['1'], '1', 1, undefined]) {
    assert.equal(inspectProjectFlushVolumesMatrix(JSON.stringify({
      filament_colour: ['#000000', '#F4EE2A'],
      nozzle_diameter: ['0.4'],
      nozzle_volume_type: ['Standard'],
      flush_volumes_matrix: ['0', '632', '136', '0'],
      flush_multiplier
    }))?.multiplierInconsistent, false)
  }
})

test('a dual-length multiplier left behind by a dual-to-single retarget is inconsistent', () => {
  assert.equal(inspectProjectFlushVolumesMatrix(JSON.stringify({
    filament_colour: ['#000000', '#F4EE2A'],
    nozzle_diameter: ['0.4'],
    nozzle_volume_type: ['Standard'],
    flush_volumes_matrix: ['0', '632', '136', '0'],
    flush_multiplier: ['1', '1']
  }))?.multiplierInconsistent, true)
})

test('repairFlushMultiplier resizes to one entry per extruder, preserving what exists', () => {
  assert.deepEqual(repairFlushMultiplier(['1'], 2), ['1', '1'])
  assert.deepEqual(repairFlushMultiplier(['0.8', '1'], 3), ['0.8', '1', '1'])
  // A legacy bare scalar counts as one entry and seeds the rest.
  assert.deepEqual(repairFlushMultiplier('1.1', 2), ['1.1', '1.1'])
  // Absence is authored from the engine's own default.
  assert.deepEqual(repairFlushMultiplier(undefined, 2), ['1', '1'])
  assert.deepEqual(repairFlushMultiplier(undefined, 2, '1.2'), ['1.2', '1.2'])
  // Dual -> single truncates.
  assert.deepEqual(repairFlushMultiplier(['1', '0.9'], 1), ['1'])
})

test('repairFlushMultiplier returns null when there is nothing to do', () => {
  assert.equal(repairFlushMultiplier(['1', '1'], 2), null)
  assert.equal(repairFlushMultiplier(['1'], 1), null)
  // Absent on a single-extruder machine equals the engine default; writing the key would churn
  // bytes for nothing.
  assert.equal(repairFlushMultiplier(undefined, 1), null)
})

test('a stored matrix reads back block-per-extruder, and round-trips', () => {
  // Two filaments, two extruders: 8 entries as two 2x2 blocks.
  const stored = ['0', '90', '900', '0', '1', '2', '3', '4']
  assert.deepEqual(readFlushVolumesMatrixBlock(stored, 0, 2, 2), [[0, 90], [900, 0]])
  assert.deepEqual(readFlushVolumesMatrixBlock(stored, 1, 2, 2), [[1, 2], [3, 4]])
  assert.deepEqual(
    writeFlushVolumesMatrixBlocks([[[0, 90], [900, 0]], [[1, 2], [3, 4]]]),
    stored
  )
})

test('reading a block refuses a matrix that does not match the topology', () => {
  // An ABSENT matrix is legitimate (BambuStudio computes it), and a WRONG-sized one is the
  // exit-139 defect — neither may be rendered as a grid of zeroes the user could then save.
  assert.equal(readFlushVolumesMatrixBlock(null, 0, 2, 2), null)
  assert.equal(readFlushVolumesMatrixBlock([], 0, 2, 2), null)
  assert.equal(readFlushVolumesMatrixBlock(['0', '90', '900', '0'], 0, 2, 2), null)
  assert.equal(readFlushVolumesMatrixBlock(['0', '90', '900', '0'], 1, 2, 1), null)
})

test('writing rejects block shapes the engine would read out of bounds', () => {
  assert.throws(() => writeFlushVolumesMatrixBlocks([]))
  assert.throws(() => writeFlushVolumesMatrixBlocks([[[0, 1], [2, 3]], [[0, 1]]]))
  assert.throws(() => writeFlushVolumesMatrixBlocks([[[0, 1, 2], [2, 3, 4]]]))
})
