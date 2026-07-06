import assert from 'node:assert/strict'
import test from 'node:test'
import {
  prunePartSelection,
  rangePartSelection,
  rangeSlice,
  togglePartInSelection,
  type PartSelection
} from './selectionModel'

test('togglePartInSelection starts a selection from nothing', () => {
  assert.deepEqual(togglePartInSelection(null, 7, 12), { objectId: 7, componentObjectIds: [12] })
})

test('togglePartInSelection adds and removes siblings of the same object', () => {
  let selection = togglePartInSelection(null, 7, 12)
  selection = togglePartInSelection(selection, 7, 15)
  assert.deepEqual(selection, { objectId: 7, componentObjectIds: [12, 15] })
  selection = togglePartInSelection(selection, 7, 12)
  assert.deepEqual(selection, { objectId: 7, componentObjectIds: [15] })
})

test('togglePartInSelection clears when the last part is toggled off', () => {
  const selection: PartSelection = { objectId: 7, componentObjectIds: [12] }
  assert.equal(togglePartInSelection(selection, 7, 12), null)
})

test('togglePartInSelection converts to a different object instead of mixing (BambuStudio rule)', () => {
  const selection: PartSelection = { objectId: 7, componentObjectIds: [12, 15] }
  assert.deepEqual(togglePartInSelection(selection, 9, 4), { objectId: 9, componentObjectIds: [4] })
})

test('rangeSlice keeps the anchor first in both directions', () => {
  const ordered = ['a', 'b', 'c', 'd', 'e']
  assert.deepEqual(rangeSlice(ordered, 'b', 'd'), ['b', 'c', 'd'])
  assert.deepEqual(rangeSlice(ordered, 'd', 'b'), ['d', 'c', 'b'])
})

test('rangeSlice falls back to the target without a valid anchor', () => {
  assert.deepEqual(rangeSlice(['a', 'b', 'c'], null, 'c'), ['c'])
  assert.deepEqual(rangeSlice(['a', 'b', 'c'], 'z', 'b'), ['b'])
})

test('rangePartSelection ranges within one object', () => {
  const selection = rangePartSelection(7, [10, 11, 12, 13], { objectId: 7, componentObjectId: 11 }, 13)
  assert.deepEqual(selection, { objectId: 7, componentObjectIds: [11, 12, 13] })
})

test('rangePartSelection ignores an anchor from another object', () => {
  const selection = rangePartSelection(7, [10, 11, 12], { objectId: 9, componentObjectId: 11 }, 12)
  assert.deepEqual(selection, { objectId: 7, componentObjectIds: [12] })
})

test('prunePartSelection drops vanished parts and empties to null', () => {
  const selection: PartSelection = { objectId: 7, componentObjectIds: [12, 15, 18] }
  assert.deepEqual(prunePartSelection(selection, [12, 18]), { objectId: 7, componentObjectIds: [12, 18] })
  assert.equal(prunePartSelection(selection, []), null)
  assert.equal(prunePartSelection(selection, null), null)
  assert.equal(prunePartSelection(null, [12]), null)
})

test('prunePartSelection returns the same reference when nothing changed', () => {
  const selection: PartSelection = { objectId: 7, componentObjectIds: [12, 15] }
  assert.equal(prunePartSelection(selection, [12, 15, 20]), selection)
})
