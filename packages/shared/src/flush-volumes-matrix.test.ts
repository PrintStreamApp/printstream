import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  expectedFlushVolumesMatrixLength,
  inspectProjectFlushVolumesMatrix,
  isFlushVolumesMatrixInconsistent,
  repairFlushVolumesMatrix
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
