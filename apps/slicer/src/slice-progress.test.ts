import assert from 'node:assert/strict'
import { test } from 'node:test'
import { outputSignalsSliceComplete } from './slice-progress.js'

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
