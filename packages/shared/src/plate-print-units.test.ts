import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  platePrintDeselectedKeys,
  platePrintSkipSelection,
  platePrintUnits
} from './plate-print-units.js'
import type { ThreeMfPlateObject } from './printer-contracts.js'

const object = (id: number, name: string, identifyIds: number[]): ThreeMfPlateObject => ({
  id,
  name,
  identifyIds,
  processOverrides: {}
})

test('every COPY of an object is its own unit', () => {
  // The reported bug: a plate arranged with several copies of a few models showed one row per
  // MODEL, so it looked like the plate held fewer objects than it does.
  const units = platePrintUnits([
    object(1, 'Gear', [11051, 11792, 11793]),
    object(2, 'Housing', [11800])
  ])
  assert.deepEqual(units.map((unit) => unit.label), ['Gear #1', 'Gear #2', 'Gear #3', 'Housing'])
  assert.deepEqual(units.map((unit) => unit.identifyId), [11051, 11792, 11793, 11800])
  assert.equal(new Set(units.map((unit) => unit.key)).size, 4)
})

test('a slice_info-shaped plate numbers its copies identically to a model_settings one', () => {
  // The two index derivations disagree in SHAPE: a library file gives one object carrying N
  // handles, while printer storage (and any gcode-only export) gives N objects that each carry
  // one handle and repeat the name. Numbering per object would leave the second as N identical
  // rows, so the same plate would read differently depending on where it was printed from.
  const fromLibrary = platePrintUnits([object(5, 'Gear', [101, 102, 103])])
  const fromStorage = platePrintUnits([object(101, 'Gear', [101]), object(102, 'Gear', [102]), object(103, 'Gear', [103])])
  assert.deepEqual(fromStorage.map((unit) => unit.label), ['Gear #1', 'Gear #2', 'Gear #3'])
  assert.deepEqual(fromLibrary.map((unit) => unit.label), fromStorage.map((unit) => unit.label))
})

test('a single-copy plate is not numbered', () => {
  const units = platePrintUnits([object(1, 'Gear', [11051]), object(2, 'Housing', [11800])])
  assert.deepEqual(units.map((unit) => unit.label), ['Gear', 'Housing'])
})

test('an object with no identify_id is listed but cannot be skipped', () => {
  // Firmware keys skipping on the handle alone, so there is nothing to send. The row still has to
  // appear (the plate holds it, and the "n of m will print" count would otherwise lie), but
  // deselecting it could only produce a request the server is guaranteed to reject.
  const units = platePrintUnits([object(7, 'Plate body', [])])
  assert.deepEqual(units, [{ key: 'object:7', objectId: 7, identifyId: null, label: 'Plate body', skippable: false }])
  assert.deepEqual(platePrintSkipSelection(units, new Set(['object:7'])), { skipInstances: [] })
})

test('a deselection is expressed purely as instance handles', () => {
  const units = platePrintUnits([object(1, 'Gear', [11051, 11792])])
  assert.deepEqual(platePrintSkipSelection(units, new Set(['instance:11792'])), { skipInstances: [11792] })
  // Deselecting every copy still names the copies: both reach the same resolver, so collapsing to
  // an object id gains nothing and loses which copies the user actually chose.
  assert.deepEqual(
    platePrintSkipSelection(units, new Set(['instance:11051', 'instance:11792'])),
    { skipInstances: [11051, 11792] }
  )
})

test('a stored selection round-trips back to the same rows', () => {
  const units = platePrintUnits([object(1, 'Gear', [11051, 11792])])
  const keys = new Set(['instance:11792'])
  assert.deepEqual(platePrintDeselectedKeys(units, platePrintSkipSelection(units, keys)), keys)
})

test('a whole-object skip stored by an older client checks every copy', () => {
  // Selections persisted on queue items before instance granularity existed name object ids and
  // mean "all copies"; reopening the item must show that, not an empty selection.
  const units = platePrintUnits([object(1, 'Gear', [11051, 11792])])
  assert.deepEqual(
    platePrintDeselectedKeys(units, { skipObjects: [1] }),
    new Set(['instance:11051', 'instance:11792'])
  )
})

test('a selection stored against another plate resolves to no rows', () => {
  const units = platePrintUnits([object(1, 'Gear', [11051])])
  assert.equal(platePrintDeselectedKeys(units, { skipInstances: [99999], skipObjects: [42] }).size, 0)
})
