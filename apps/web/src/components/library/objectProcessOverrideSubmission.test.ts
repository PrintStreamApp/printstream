/**
 * The two rules that decide what a slice sends as per-object PROCESS overrides. Both matter because
 * the slice-time transform REPLACES an object's whole override set: a map that is stale, partial or
 * scoped to the wrong plate deletes settings rather than merging them.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bakedObjectProcessOverrides,
  changedObjectProcessOverrides,
  type ObjectProcessOverrideMap,
  type PlateObjects
} from './objectProcessOverrideSubmission'

const PLATES: PlateObjects[] = [
  { objects: [{ id: 59, processOverrides: { sparse_infill_density: '33%' } }, { id: 99, processOverrides: {} }] },
  { objects: [{ id: 217, processOverrides: {} }] },
  { objects: [{ id: 281, processOverrides: { enable_support: '1' } }] }
]

test('the baked baseline spans every plate, not just the selected one', () => {
  const baked = bakedObjectProcessOverrides(PLATES)
  assert.deepEqual(baked, {
    59: { sparse_infill_density: '33%' },
    281: { enable_support: '1' }
  })
})

test('an object whose overrides match the file is not sent, even from another plate', () => {
  // Visiting plate 1 then slicing plate 3 leaves plate 1's object in the session map. Diffed
  // against a baseline covering only the selected plate it read as "changed" and rode along on
  // every slice, forcing the rewrite branch on a slice nobody customised.
  const session: ObjectProcessOverrideMap = {
    59: { sparse_infill_density: '33%' },
    281: { enable_support: '1' }
  }
  assert.equal(changedObjectProcessOverrides(session, bakedObjectProcessOverrides(PLATES)), undefined)
})

test('a CLEARED object is sent as an explicit empty entry', () => {
  // This is the only thing that strips the file's values: the transform rewrites the objects it is
  // GIVEN, so an object dropped from the map is an object it never touches.
  const session: ObjectProcessOverrideMap = { 281: {} }
  assert.deepEqual(changedObjectProcessOverrides(session, bakedObjectProcessOverrides(PLATES)), { 281: {} })
})

test('an object the user never opened is left out entirely', () => {
  // Absence must mean "untouched", never "delete": the session map only ever holds objects that
  // came into scope, so treating a missing key as a clear would strip settings on sight.
  assert.equal(changedObjectProcessOverrides({}, bakedObjectProcessOverrides(PLATES)), undefined)
})

test('a genuine edit is sent as the objects whole new set', () => {
  const session: ObjectProcessOverrideMap = {
    59: { sparse_infill_density: '33%' },
    281: { enable_support: '1', support_threshold_angle: '45' }
  }
  assert.deepEqual(changedObjectProcessOverrides(session, bakedObjectProcessOverrides(PLATES)), {
    281: { enable_support: '1', support_threshold_angle: '45' }
  })
})

test('an object with no baked overrides is sent as soon as it gains one', () => {
  const session: ObjectProcessOverrideMap = { 217: { brim_type: 'outer_only' } }
  assert.deepEqual(changedObjectProcessOverrides(session, bakedObjectProcessOverrides(PLATES)), {
    217: { brim_type: 'outer_only' }
  })
})

test('key order does not make an unchanged object look changed', () => {
  // The baked set comes out of the file in document order; a session set is rebuilt by the settings
  // dialog. Comparing the two by serializing them made the same settings, written in a different
  // order, read as an edit.
  const baked = { 281: { enable_support: '1', support_threshold_angle: '45' } }
  const session: ObjectProcessOverrideMap = { 281: { support_threshold_angle: '45', enable_support: '1' } }
  assert.equal(changedObjectProcessOverrides(session, baked), undefined)
})

test('a vector value is compared element-wise, not by identity', () => {
  const baked = { 281: { some_vector: ['1', '2'] } }
  assert.equal(changedObjectProcessOverrides({ 281: { some_vector: ['1', '2'] } }, baked), undefined)
  assert.deepEqual(changedObjectProcessOverrides({ 281: { some_vector: ['1', '3'] } }, baked), {
    281: { some_vector: ['1', '3'] }
  })
})

test('a plate carrying no object list at all is tolerated', () => {
  // A geometry-only plate contributes no objects rather than failing the whole baseline.
  assert.deepEqual(bakedObjectProcessOverrides([{}, ...PLATES]), {
    59: { sparse_infill_density: '33%' },
    281: { enable_support: '1' }
  })
})
