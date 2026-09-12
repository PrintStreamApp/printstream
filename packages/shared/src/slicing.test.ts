import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createSlicingJobSchema,
  exportArrangedThreeMfSchema,
  parsePreservedSliceSettings,
  publicSlicingExecutionRequestSchema,
  saveArrangedThreeMfSchema,
  sliceEnvelopeSchema,
  slicingTargetSchema,
  MAX_PAINT_CODE_LENGTH
} from './slicing.js'

const sceneEdit = { plates: [{ index: 1 }], instances: [] }
const retarget = {
  mode: 'manualProfile' as const,
  printerProfileId: 'builtin:machine:H2D',
  printerModel: 'H2D',
  processProfileId: 'builtin:process:0.20',
  nozzleDiameters: [0.4],
  filamentMappings: [{ projectFilamentId: 1, profileId: 'builtin:filament:H2D' }]
}

test('public slicing refuses host post-processing commands in request overrides', () => {
  const base = {
    preparedProject: { contractVersion: 1 as const },
    target: retarget
  }
  assert.equal(publicSlicingExecutionRequestSchema.safeParse(base).success, true)
  assert.equal(publicSlicingExecutionRequestSchema.safeParse({
    ...base,
    target: { ...retarget, processSettingOverrides: { post_process: ['/tmp/untrusted'] } }
  }).success, false)
})

test('a browser-prepared source keeps original lineage and cannot repeat baked edits', () => {
  const base = {
    sourceFileId: 'original-project',
    sourceVersionId: 'opened-version',
    preparedSource: { id: 'browser-preparation', contractVersion: 1 as const },
    // Provenance only: the proof binds the prepared bytes to the immutable project version the
    // browser authored from. It is not an instruction to apply the edit again.
    contentBase: { fileId: 'original-project', versionId: 'opened-version' },
    target: retarget,
    plate: 2
  }
  const parsed = createSlicingJobSchema.parse(base)
  assert.equal(parsed.sourceFileId, 'original-project')
  assert.equal(parsed.sourceVersionId, 'opened-version')
  assert.deepEqual(parsed.preparedSource, { id: 'browser-preparation', contractVersion: 1 })
  assert.deepEqual(parsed.contentBase, { fileId: 'original-project', versionId: 'opened-version' })

  for (const duplicate of [
    { selectedObjectIds: [1] },
    { objectProcessOverrides: { '1': { layer_height: '0.2' } } },
    { filamentChanges: [] },
    { pauses: [] },
    { sceneEdit }
  ]) {
    assert.equal(
      createSlicingJobSchema.safeParse({ ...base, ...duplicate }).success,
      false,
      `prepared source accepted already-baked field ${Object.keys(duplicate)[0]}`
    )
  }
})

test('slice envelope carries an execution-only printer model independently of project metadata', () => {
  const parsed = sliceEnvelopeSchema.parse({
    jobId: 'job-1',
    sourceFileName: 'project.3mf',
    request: {
      sourceFileId: 'source-1',
      target: retarget,
      plate: 0
    },
    maxOutputBytes: 512 * 1024 * 1024,
    executionHints: { printerModel: 'P1S' }
  })
  assert.equal(parsed.executionHints?.printerModel, 'P1S')
  assert.equal(parsed.maxOutputBytes, 512 * 1024 * 1024)
})

test('saveArrangedThreeMf carries an optional retarget machine + slicer target', () => {
  const withRetarget = saveArrangedThreeMfSchema.parse({
    baseFileId: 'f1', mode: 'newVersion', sceneEdit, slicerTargetId: 'bambustudio-2-7-1-57', retarget
  })
  assert.equal(withRetarget.retarget?.printerModel, 'H2D')
  assert.equal(withRetarget.slicerTargetId, 'bambustudio-2-7-1-57')

  // Retarget is optional, a plain arrangement save still validates.
  const plain = saveArrangedThreeMfSchema.parse({ baseFileId: 'f1', mode: 'newVersion', sceneEdit })
  assert.equal(plain.retarget, undefined)
})

test('exportArrangedThreeMf is the bake payload without persistence targeting', () => {
  // No mode/folder/bridge, and name stays optional (it only labels the audit entry).
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

test('preserved slice settings survive the JSON round trip they are stored as', () => {
  // The blob is a persisted column, so everything that identifies the slice must come back
  // out, a settings shape that silently drops its presets would seed "Slice again" with
  // defaults and quietly print something else. (The target is re-parsed, so it gains the
  // filament-mapping `source` default; that is normalization, not loss.)
  const settings = { slicerTargetId: 'bambustudio-2-7-1-57', target: retarget, plate: 2 }
  const parsed = parsePreservedSliceSettings(JSON.stringify(settings))
  assert.equal(parsed?.slicerTargetId, 'bambustudio-2-7-1-57')
  assert.equal(parsed?.plate, 2)
  assert.deepEqual(parsed?.target, slicingTargetSchema.parse(retarget))
})

test('preserved slice settings degrade to null rather than throwing on unusable rows', () => {
  // Callers offer the affordance on the strength of this; a row written by an older build,
  // truncated, or hand-edited must read as "no seed", never as a failed request.
  assert.equal(parsePreservedSliceSettings(null), null)
  assert.equal(parsePreservedSliceSettings(''), null)
  assert.equal(parsePreservedSliceSettings('{'), null)
  assert.equal(parsePreservedSliceSettings('{"plate":1}'), null, 'a blob with no target cannot seed anything')
})

test('preserved slice settings default an absent plate to every plate', () => {
  const parsed = parsePreservedSliceSettings(JSON.stringify({ target: retarget }))
  assert.equal(parsed?.plate, 0)
})
