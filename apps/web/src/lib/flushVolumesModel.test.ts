/**
 * The flushing-volumes dialog's decisions, tested through their inputs.
 *
 * The dialog itself renders icons, which a component render test cannot mount under the node
 * runner's CJS interop, so its behaviour is covered here instead (the web development notes).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProjectFlushContext } from '@printstream/shared'
import {
  FLUSH_PROVENANCE_NOTE,
  isPreviewingFlushVolumes,
  resolveFlushProvenance,
  seedFlushBlocks
} from './flushVolumesModel'

const context = (overrides: Partial<ProjectFlushContext> = {}): ProjectFlushContext => ({
  filamentCount: 2,
  extruderCount: 1,
  storedBlocks: [[[0, 111], [222, 0]]],
  matrixInconsistent: false,
  multiplier: [1],
  multipliers: { normal: [1], fast: [1.2] },
  multiplierKey: 'flush_multiplier',
  primeVolumeMode: 'Default',
  supportsFastPurge: false,
  supportsPrimeSaving: false,
  datasetCodes: [0],
  minFlushVolumes: [[0, 0]],
  filamentIsSupport: [false, false],
  filamentColors: ['#000000', '#FFFFFF'],
  ...overrides
})

const suggestion = () => [[0, 999], [999, 0]]

test('the grid opens on the project’s own volumes when they still fit', () => {
  assert.deepEqual(
    seedFlushBlocks({ context: context(), filamentCount: 2, suggestion }),
    [[[0, 111], [222, 0]]]
  )
})

test('a stored matrix for a different material count is not shown as the project’s', () => {
  // The session added a third material; the stored 2x2 describes purges between filaments that no
  // longer line up. Showing it would attribute numbers to pairs they were never measured for.
  assert.deepEqual(
    seedFlushBlocks({ context: context(), filamentCount: 3, suggestion }),
    [[[0, 999], [999, 0]]]
  )
})

test('a project with no matrix opens on the suggestion, per extruder', () => {
  assert.deepEqual(
    seedFlushBlocks({
      context: context({ storedBlocks: null, extruderCount: 2 }),
      filamentCount: 2,
      suggestion
    }),
    [[[0, 999], [999, 0]], [[0, 999], [999, 0]]]
  )
})

test('an unset matrix previews until the user touches something', () => {
  // Absence is legitimate, it is what makes BambuStudio compute the matrix itself, so merely
  // opening the dialog must not adopt a matrix the project never had.
  const unset = context({ storedBlocks: null })
  assert.equal(isPreviewingFlushVolumes({ context: unset, touched: false }), true)
  assert.equal(isPreviewingFlushVolumes({ context: unset, touched: true }), false)
  // A project that DOES set its own volumes is never a preview.
  assert.equal(isPreviewingFlushVolumes({ context: context(), touched: false }), false)
})

test('provenance never claims parity that was not checked', () => {
  const verdict = (agrees: boolean) => ({ agrees, engine: [], ours: [] })
  // A verdict outranks merely having the tables, it was checked against the real engine.
  assert.equal(resolveFlushProvenance({ hasMeasuredTables: true, calibration: verdict(true) }), 'engine-verified')
  assert.equal(resolveFlushProvenance({ hasMeasuredTables: true, calibration: verdict(false) }), 'engine-disagrees')
  // The regression this guards: "not checked" must not collapse into "agrees".
  assert.equal(resolveFlushProvenance({ hasMeasuredTables: true, calibration: null }), 'measured-unverified')
  assert.equal(resolveFlushProvenance({ hasMeasuredTables: false, calibration: null }), 'formula-only')
  // A disagreement is still reported even with no tables: the engine's word beats our inference.
  assert.equal(resolveFlushProvenance({ hasMeasuredTables: false, calibration: verdict(false) }), 'engine-disagrees')
})

test('every provenance has wording, and the unverified ones hedge', () => {
  for (const provenance of ['engine-verified', 'engine-disagrees', 'measured-unverified', 'formula-only'] as const) {
    assert.ok(FLUSH_PROVENANCE_NOTE[provenance].length > 0, provenance)
  }
  // Only the verified note may state it was checked; the others must not imply it.
  assert.match(FLUSH_PROVENANCE_NOTE['engine-verified'], /checked/)
  assert.doesNotMatch(FLUSH_PROVENANCE_NOTE['measured-unverified'], /checked/)
  assert.doesNotMatch(FLUSH_PROVENANCE_NOTE['formula-only'], /checked/)
})
