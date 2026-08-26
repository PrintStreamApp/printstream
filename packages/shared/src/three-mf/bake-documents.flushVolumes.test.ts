/**
 * The bake's handling of edited purge volumes (`SceneEdit.flushVolumes`).
 *
 * The whole reason this rides its own SceneEdit field rather than the generic global-process
 * override channel is ORDERING: overrides are applied last, after the repair pass, so a mis-sized
 * matrix arriving that way would be written verbatim with nothing left to catch it, and a
 * mis-sized `flush_volumes_matrix` is read out of bounds by the engine and segfaults mid-slice
 * (exit 139). These tests pin the two guarantees that buys: the edit lands AFTER the filament
 * remap (so the user's numbers win) and BEFORE the repair (so a stale one is still caught).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildProjectSettingsTransforms } from './bake-documents.js'
import { expectedFlushVolumesMatrixLength } from '../flush-volumes-matrix.js'
import type { SceneEdit } from '../slicing.js'

const singleNozzleProject = {
  filament_colour: ['#000000', '#F4EE2A'],
  filament_type: ['PLA', 'PETG'],
  nozzle_diameter: ['0.4'],
  flush_volumes_matrix: ['0', '450', '200', '0'],
  flush_multiplier: ['1']
}

const dualNozzleProject = {
  filament_colour: ['#000000', '#F4EE2A'],
  filament_type: ['PLA', 'PETG'],
  nozzle_diameter: ['0.4', '0.4'],
  nozzle_volume_type: ['Standard', 'High Flow'],
  flush_volumes_matrix: ['0', '450', '200', '0', '0', '450', '200', '0'],
  flush_multiplier: ['1', '1']
}

/** Run only the project_settings half of a bake, which is what these transforms are. */
function applyEdit(project: object, edit: Partial<SceneEdit>): Record<string, unknown> {
  const full = { plates: [], instances: [], ...edit } as unknown as SceneEdit
  const json = buildProjectSettingsTransforms(full)
    .reduce((acc, transform) => transform(acc), JSON.stringify(project))
  return JSON.parse(json) as Record<string, unknown>
}

test('edited volumes are written as one block per extruder', () => {
  const after = applyEdit(dualNozzleProject, {
    flushVolumes: { matrix: [[[0, 111], [222, 0]], [[0, 333], [444, 0]]], multiplier: [1, 2] }
  })
  assert.deepEqual(after.flush_volumes_matrix, ['0', '111', '222', '0', '0', '333', '444', '0'])
  assert.deepEqual(after.flush_multiplier, ['1', '2'])
})

test('a single-nozzle project writes one block', () => {
  const after = applyEdit(singleNozzleProject, {
    flushVolumes: { matrix: [[[0, 111], [222, 0]]], multiplier: [1.5] }
  })
  assert.deepEqual(after.flush_volumes_matrix, ['0', '111', '222', '0'])
  assert.deepEqual(after.flush_multiplier, ['1.5'])
})

test('volumes are written AFTER the filament remap, so the user edit wins', () => {
  // The filament list reverses the slots, which remaps the stored matrix; the user's own matrix
  // must still be what lands, not the remap's output.
  const after = applyEdit(singleNozzleProject, {
    filaments: [
      { color: '#F4EE2A', sourceIndex: 1 },
      { color: '#000000', sourceIndex: 0 }
    ] as SceneEdit['filaments'],
    flushVolumes: { matrix: [[[0, 111], [222, 0]]], multiplier: [1] }
  })
  assert.deepEqual(after.flush_volumes_matrix, ['0', '111', '222', '0'])
})

test('a matrix sized for a different material list is DROPPED, not forced to fit', () => {
  // The session had 2 materials when the grid was edited; the save is writing 3. Forcing the old
  // numbers in would either scramble them or write the shape the engine reads out of bounds.
  const after = applyEdit({
    ...singleNozzleProject,
    filament_colour: ['#000000', '#F4EE2A', '#00AE42'],
    filament_type: ['PLA', 'PETG', 'PLA'],
    flush_volumes_matrix: ['0', '450', '300', '200', '0', '300', '300', '300', '0']
  }, {
    flushVolumes: { matrix: [[[0, 111], [222, 0]]], multiplier: [1] }
  })
  // The project's own (correctly sized) matrix survives untouched.
  assert.deepEqual(after.flush_volumes_matrix, ['0', '450', '300', '200', '0', '300', '300', '300', '0'])
  assert.equal((after.flush_volumes_matrix as unknown[]).length, expectedFlushVolumesMatrixLength(3, 1))
})

test('a matrix missing an extruder block is dropped rather than left short', () => {
  const after = applyEdit(dualNozzleProject, {
    // One block, two extruders, exactly the exit-139 shape.
    flushVolumes: { matrix: [[[0, 111], [222, 0]]], multiplier: [1, 1] }
  })
  assert.deepEqual(after.flush_volumes_matrix, dualNozzleProject.flush_volumes_matrix)
  assert.equal((after.flush_volumes_matrix as unknown[]).length, expectedFlushVolumesMatrixLength(2, 2))
})

test('a stale multiplier is conformed to the extruder count rather than dropped', () => {
  // The multiplier is per-extruder and says nothing about the filament set, so unlike the matrix
  // a wrong-length one is repairable. Left short it fails the engine's size check (exit 156).
  const after = applyEdit(dualNozzleProject, {
    flushVolumes: { matrix: [[[0, 111], [222, 0]], [[0, 333], [444, 0]]], multiplier: [1.5] }
  })
  assert.deepEqual(after.flush_multiplier, ['1.5', '1.5'])
})

test('Fast purge mode writes the fast multiplier, leaving the normal one alone', () => {
  // BambuStudio's dialog reads and writes whichever key `prime_volume_mode` selects. Writing the
  // wrong one looks to the user like the edit did nothing.
  const after = applyEdit({ ...dualNozzleProject, prime_volume_mode: 'Fast', flush_multiplier_fast: ['1.2', '1.2'] }, {
    flushVolumes: { matrix: [[[0, 111], [222, 0]], [[0, 333], [444, 0]]], multiplier: [2, 2] }
  })
  assert.deepEqual(after.flush_multiplier_fast, ['2', '2'])
  assert.deepEqual(after.flush_multiplier, ['1', '1'])
})

test('no flushVolumes edit leaves the project untouched, including an ABSENT matrix', () => {
  // Absence is legitimate, it is what makes BambuStudio compute the matrix itself, so opening
  // the dialog and cancelling must not materialise one.
  const { flush_volumes_matrix: _omitted, ...withoutMatrix } = singleNozzleProject
  const after = applyEdit(withoutMatrix, {})
  assert.equal('flush_volumes_matrix' in after, false)
})
