import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeSlicedOutputUsage, parseSlicedOutputUsage } from './sliced-output-usage.js'

test('finished slice metadata replaces a false zero length from result.json', () => {
  const packaged = parseSlicedOutputUsage(`<?xml version="1.0" encoding="UTF-8"?>
    <config>
      <plate>
        <metadata key="prediction" value="17789"/>
        <metadata key="weight" value="205.96"/>
        <filament id="1" type="PLA" color="#112233" used_m="69.06" used_g="205.96"/>
      </plate>
    </config>`)
  const merged = mergeSlicedOutputUsage({
    estimatedPrintTimeSeconds: 17789,
    estimatedFilamentWeightGrams: 205.9637451171875,
    materials: [{ id: 1, type: null, color: null, weightGrams: 205.9637451171875, lengthMm: 0 }]
  }, packaged)

  assert.deepEqual(merged, {
    estimatedPrintTimeSeconds: 17789,
    estimatedFilamentWeightGrams: 205.96,
    estimatedFilamentLengthMm: 69060,
    materials: [{ id: 1, type: 'PLA', color: '#112233', weightGrams: 205.96, lengthMm: 69060 }]
  })
})

test('usage is aggregated by filament across packaged plates', () => {
  const usage = parseSlicedOutputUsage(`<config>
    <plate><filament id="2" used_m="1.25" used_g="3.5"/></plate>
    <plate><filament id="2" used_m="0.75" used_g="2.5"/></plate>
  </config>`)

  assert.equal(usage?.estimatedFilamentLengthMm, 2000)
  assert.equal(usage?.estimatedFilamentWeightGrams, 6)
  assert.deepEqual(usage?.materials, [{
    id: 2,
    type: null,
    color: null,
    weightGrams: 6,
    lengthMm: 2000
  }])
})
