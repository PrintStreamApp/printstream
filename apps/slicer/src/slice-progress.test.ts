import assert from 'node:assert/strict'
import { test } from 'node:test'
import { outputReachedSlicingStage, outputSignalsSliceComplete, summarizeSliceProgress } from './slice-progress.js'

// The real crash sequence captured from a torus model that segfaults at "Detect overhangs for
// auto-lift" (66%) — the fixture the engine-crash classification is built around.
const OVERHANG_CRASH_OUTPUT = [
  '{"message":"Prepare slicing","plate_count":0,"plate_index":0,"plate_percent":3,"total_percent":3}',
  '{"message":"Slicing begins","plate_count":1,"plate_index":1,"plate_percent":4,"total_percent":6}',
  '{"message":"Generating walls","plate_count":1,"plate_index":1,"plate_percent":15,"total_percent":16}',
  '{"message":"Checking support necessity","plate_count":1,"plate_index":1,"plate_percent":50,"total_percent":48}',
  '{"message":"Detect overhangs for auto-lift","plate_count":1,"plate_index":1,"plate_percent":71,"total_percent":66}',
  'Segmentation fault'
].join('\n')

test('summarizeSliceProgress reports the last stage and furthest percent', () => {
  const { lastStage, maxPercent } = summarizeSliceProgress(OVERHANG_CRASH_OUTPUT)
  assert.equal(lastStage, 'Detect overhangs for auto-lift')
  assert.equal(maxPercent, 66)
})

test('summarizeSliceProgress is empty when no progress line was printed', () => {
  const loadCrash = [
    '[2026-07-15 22:51:31] [trace]   Initializing StaticPrintConfigs',
    'Segmentation fault (core dumped)'
  ].join('\n')
  assert.deepEqual(summarizeSliceProgress(loadCrash), { lastStage: null, maxPercent: 0 })
})

test('outputReachedSlicingStage separates post-load slicing from project load', () => {
  assert.equal(outputReachedSlicingStage(OVERHANG_CRASH_OUTPUT), true)
  // Only "Start to load files"/"Prepare slicing" (<=3%) means the crash was still in load.
  assert.equal(outputReachedSlicingStage('{"message":"Prepare slicing","total_percent":3}'), false)
  assert.equal(outputReachedSlicingStage(''), false)
})

test('outputSignalsSliceComplete matches the BambuStudio success line', () => {
  assert.equal(
    outputSignalsSliceComplete('{"message":"All done, Success","plate_count":1,"plate_index":0,"plate_percent":100,"total_percent":100}'),
    true
  )
  // Tolerant of spacing variants in the emitted JSON.
  assert.equal(outputSignalsSliceComplete('{"message": "All done,  Success"}'), true)
})

test('outputSignalsSliceComplete ignores in-progress and unrelated lines', () => {
  // "Exporting 3mf" (97%) is the step the slice gets stuck on — it is NOT completion.
  assert.equal(outputSignalsSliceComplete('{"message":"Exporting 3mf","plate_percent":97,"total_percent":97}'), false)
  assert.equal(outputSignalsSliceComplete('{"message":"Slicing finished","total_percent":93}'), false)
  assert.equal(outputSignalsSliceComplete('[2026-06-28] [warning] all done loading the project'), false)
  assert.equal(outputSignalsSliceComplete(''), false)
})
