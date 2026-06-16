import assert from 'node:assert/strict'
import { test } from 'node:test'
import { saveArrangedThreeMfSchema } from './slicing.js'

const sceneEdit = { plates: [{ index: 1 }], instances: [] }
const retarget = {
  mode: 'manualProfile' as const,
  printerProfileId: 'builtin:machine:H2D',
  printerModel: 'H2D',
  processProfileId: 'builtin:process:0.20',
  nozzleDiameters: [0.4],
  filamentMappings: [{ projectFilamentId: 1, profileId: 'builtin:filament:H2D' }]
}

test('saveArrangedThreeMf carries an optional retarget machine + slicer target', () => {
  const withRetarget = saveArrangedThreeMfSchema.parse({
    baseFileId: 'f1', mode: 'newVersion', sceneEdit, slicerTargetId: 'bambustudio-2-7-1-57', retarget
  })
  assert.equal(withRetarget.retarget?.printerModel, 'H2D')
  assert.equal(withRetarget.slicerTargetId, 'bambustudio-2-7-1-57')

  // Retarget is optional — a plain arrangement save still validates.
  const plain = saveArrangedThreeMfSchema.parse({ baseFileId: 'f1', mode: 'newVersion', sceneEdit })
  assert.equal(plain.retarget, undefined)
})
