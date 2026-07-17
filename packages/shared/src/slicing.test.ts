import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exportArrangedThreeMfSchema, saveArrangedThreeMfSchema, MAX_PAINT_CODE_LENGTH } from './slicing.js'

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

test('exportArrangedThreeMf is the bake payload without persistence targeting', () => {
  // No mode/folder/bridge — and name stays optional (it only labels the audit entry).
  const parsed = exportArrangedThreeMfSchema.parse({ baseFileId: 'f1', sceneEdit, retarget, slicerTargetId: 't1' })
  assert.equal(parsed.retarget?.printerModel, 'H2D')
  assert.equal(parsed.name, undefined)
  const named = exportArrangedThreeMfSchema.parse({ baseFileId: null, sceneEdit, name: 'Widget.3mf' })
  assert.equal(named.name, 'Widget.3mf')

  // The save schema still enforces its persistence rules after the shared-base refactor.
  assert.equal(saveArrangedThreeMfSchema.safeParse({ baseFileId: 'f1', mode: 'saveAs', sceneEdit }).success, false)
  assert.equal(saveArrangedThreeMfSchema.safeParse({ baseFileId: null, mode: 'newVersion', sceneEdit }).success, false)
})

test('seam/support/colour paint accepts long sub-triangle split codes', () => {
  // Deeply painted parts encode long hex codes (observed ~1.1k chars in practice). The old
  // 64-char cap rejected these, so a save of any deeply-painted part failed validation.
  const longCode = '0004002002002006040020020060400200604006044AAAA2'.repeat(30) // ~1.4k hex chars
  assert.ok(longCode.length > 64 && longCode.length < MAX_PAINT_CODE_LENGTH)
  const painted = {
    ...sceneEdit,
    seamPaint: [{ objectId: 1, componentObjectId: 1, triangles: { '222': longCode } }],
    supportPaint: [{ objectId: 1, componentObjectId: 1, triangles: { '0': 'A4' } }],
    colorPaint: [{ objectId: 1, componentObjectId: 1, triangles: { '7': longCode } }]
  }
  const parsed = saveArrangedThreeMfSchema.parse({ baseFileId: 'f1', mode: 'newVersion', sceneEdit: painted })
  assert.equal(parsed.sceneEdit.seamPaint?.[0]?.triangles['222'], longCode)

  // Still rejects non-hex and absurdly long codes (the sanity guard).
  const nonHex = saveArrangedThreeMfSchema.safeParse({
    baseFileId: 'f1', mode: 'newVersion',
    sceneEdit: { ...sceneEdit, seamPaint: [{ objectId: 1, componentObjectId: 1, triangles: { '1': 'XYZ' } }] }
  })
  assert.equal(nonHex.success, false)
  const tooLong = saveArrangedThreeMfSchema.safeParse({
    baseFileId: 'f1', mode: 'newVersion',
    sceneEdit: { ...sceneEdit, seamPaint: [{ objectId: 1, componentObjectId: 1, triangles: { '1': 'A'.repeat(MAX_PAINT_CODE_LENGTH + 1) } }] }
  })
  assert.equal(tooLong.success, false)
})
