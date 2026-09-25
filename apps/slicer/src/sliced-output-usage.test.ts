import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeSlicedOutputTiming, mergeSlicedOutputUsage, parseSlicedOutputUsage } from './sliced-output-usage.js'

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
    materials: [{ id: 1, type: 'PLA', color: '#112233', weightGrams: 205.96, lengthMm: 69060 }],
    plates: [{
      index: 1,
      estimatedPrintTimeSeconds: 17789,
      estimatedFilamentWeightGrams: 205.96,
      estimatedFilamentLengthMm: 69060,
      materials: [{ id: 1, type: 'PLA', color: '#112233', weightGrams: 205.96, lengthMm: 69060 }]
    }]
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
  assert.deepEqual(usage?.plates?.map((plate) => ({
    index: plate.index,
    estimatedFilamentWeightGrams: plate.estimatedFilamentWeightGrams,
    estimatedFilamentLengthMm: plate.estimatedFilamentLengthMm
  })), [
    { index: 1, estimatedFilamentWeightGrams: 3.5, estimatedFilamentLengthMm: 1250 },
    { index: 2, estimatedFilamentWeightGrams: 2.5, estimatedFilamentLengthMm: 750 }
  ])
})

test('per-plate print times follow sparse packaged plate indices', () => {
  const packaged = parseSlicedOutputUsage(`<config>
    <plate><metadata key="index" value="2"/><filament id="1" used_g="3"/></plate>
    <plate><metadata key="index" value="4"/><filament id="1" used_g="5"/></plate>
  </config>`)
  const merged = mergeSlicedOutputUsage({
    estimatedPrintTimeSeconds: 300,
    plates: [
      { index: 1, estimatedPrintTimeSeconds: 100 },
      { index: 2, estimatedPrintTimeSeconds: 200 }
    ]
  }, packaged)

  assert.ok(merged)
  assert.deepEqual(merged.plates?.map((plate) => ({
    index: plate.index,
    time: plate.estimatedPrintTimeSeconds,
    weight: plate.estimatedFilamentWeightGrams
  })), [
    { index: 2, time: 100, weight: 3 },
    { index: 4, time: 200, weight: 5 }
  ])
})

test('G-code plate times replace repeated whole-job predictions', () => {
  const metadata = {
    estimatedPrintTimeSeconds: 8 * 3600,
    plates: [
      { index: 1, estimatedPrintTimeSeconds: 8 * 3600, estimatedFilamentWeightGrams: 151 },
      { index: 2, estimatedPrintTimeSeconds: 8 * 3600, estimatedFilamentWeightGrams: 229.8 }
    ]
  }
  const merged = mergeSlicedOutputTiming(metadata, {
    totalSeconds: 8 * 3600,
    prepareSeconds: 20 * 60,
    plates: [
      { index: 1, totalSeconds: 3 * 3600 },
      { index: 2, totalSeconds: 5 * 3600 }
    ]
  })

  assert.equal(merged?.estimatedPrintTimeSeconds, 8 * 3600)
  assert.equal(merged?.estimatedPrepareTimeSeconds, 20 * 60)
  assert.deepEqual(merged?.plates?.map((plate) => plate.estimatedPrintTimeSeconds), [3 * 3600, 5 * 3600])
  assert.deepEqual(merged?.plates?.map((plate) => plate.estimatedFilamentWeightGrams), [151, 229.8])
})

test('repeated whole-job plate predictions are hidden when G-code timing is unavailable', () => {
  const merged = mergeSlicedOutputTiming({
    estimatedPrintTimeSeconds: 8 * 3600,
    plates: [
      { index: 1, estimatedPrintTimeSeconds: 8 * 3600 },
      { index: 2, estimatedPrintTimeSeconds: 8 * 3600 }
    ]
  }, { totalSeconds: null, prepareSeconds: null, plates: [] })

  assert.equal(merged?.estimatedPrintTimeSeconds, 8 * 3600)
  assert.deepEqual(merged?.plates, [{ index: 1 }, { index: 2 }])
})
