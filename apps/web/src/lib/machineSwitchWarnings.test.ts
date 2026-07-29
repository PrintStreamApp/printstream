/**
 * Machine-switch warnings (see machineSwitchWarnings.ts). These conditions used to surface only
 * later and worse: an off-bed object as the CLI's exit-206 after a slice attempt, and an
 * out-of-range layer height not at all (BambuStudio clamps it silently).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SlicingPresetSummary } from '@printstream/shared'
import { machineSwitchWarnings } from './machineSwitchWarnings'

const machine = (limits: { minLayerHeight?: number; maxLayerHeight?: number }): SlicingPresetSummary => ({
  id: 'builtin:machine:Bambu Lab A1 mini 0.4 nozzle',
  source: 'builtin',
  kind: 'machine',
  name: 'Bambu Lab A1 mini 0.4 nozzle',
  ...limits
} as SlicingPresetSummary)

test('a clean switch produces no warnings', () => {
  assert.deepEqual(
    machineSwitchWarnings({ printerModel: 'A1 mini', offBedObjectCount: 0, layerHeight: 0.2, machineProfile: machine({ minLayerHeight: 0.08, maxLayerHeight: 0.28 }) }),
    []
  )
})

test('objects that no longer fit the new bed are reported at switch time, singular and plural', () => {
  const one = machineSwitchWarnings({ printerModel: 'A1 mini', offBedObjectCount: 1 })
  assert.equal(one.length, 1)
  assert.equal(one[0]?.key, 'offBed')
  assert.match(one[0]!.message, /1 object no longer fits the A1 mini bed/)
  const many = machineSwitchWarnings({ printerModel: 'A1 mini', offBedObjectCount: 3 })
  assert.match(many[0]!.message, /3 objects no longer fit the A1 mini bed/)
})

test('a layer height outside the new machine envelope is reported in the offending direction', () => {
  const tooThick = machineSwitchWarnings({ printerModel: 'A1 mini', layerHeight: 0.32, machineProfile: machine({ minLayerHeight: 0.08, maxLayerHeight: 0.28 }) })
  assert.equal(tooThick.length, 1)
  assert.equal(tooThick[0]?.key, 'layerHeight')
  assert.match(tooThick[0]!.message, /above the A1 mini's maximum \(0\.28mm\)/)
  const tooThin = machineSwitchWarnings({ printerModel: 'A1 mini', layerHeight: 0.04, machineProfile: machine({ minLayerHeight: 0.08, maxLayerHeight: 0.28 }) })
  assert.match(tooThin[0]!.message, /below the A1 mini's minimum \(0\.08mm\)/)
})

test('a layer height exactly on a bound is in range, and unknown bounds never invent a warning', () => {
  // An older slicer image reports no envelope at all — a missing bound must stay silent.
  assert.deepEqual(machineSwitchWarnings({ printerModel: 'A1 mini', layerHeight: 0.28, machineProfile: machine({ maxLayerHeight: 0.28 }) }), [])
  assert.deepEqual(machineSwitchWarnings({ printerModel: 'A1 mini', layerHeight: 0.9, machineProfile: machine({}) }), [])
  assert.deepEqual(machineSwitchWarnings({ printerModel: 'A1 mini', layerHeight: 0.9, machineProfile: null }), [])
})

test('both warnings can fire together, and an unresolved model reads generically', () => {
  const both = machineSwitchWarnings({
    printerModel: 'unknown',
    offBedObjectCount: 2,
    layerHeight: 0.4,
    machineProfile: machine({ maxLayerHeight: 0.28 })
  })
  assert.deepEqual(both.map((warning) => warning.key), ['offBed', 'layerHeight'])
  for (const warning of both) assert.match(warning.message, /this printer/)
})
