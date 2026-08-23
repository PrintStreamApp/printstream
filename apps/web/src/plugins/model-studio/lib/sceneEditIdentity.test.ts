/**
 * The shared identity derivations (see sceneEditIdentity.ts). These are the gates deciding whether
 * an edit SURVIVES the bake, so getting one subtly wrong does not fail loudly, it accepts the
 * user's edit and silently drops it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  importIdByReplacedObjectId,
  objectIdsAcceptingOverrides,
  parsePartPaintKey,
  partPaintKey,
  placedObjectIds
} from './sceneEditIdentity'
import type { EditorState } from './editorModel'

const stateWith = (instances: unknown[]): EditorState =>
  ({ plates: [{ index: 1, instances }] }) as unknown as EditorState

const placedObject = (objectId: number) => ({ objectId, source: { kind: 'object' } })
const replacingImport = (replacedObjectId: number, importId: string) =>
  ({ objectId: -1, source: { kind: 'import', importId, replacedObjectId } })
const plainImport = (importId: string) => ({ objectId: -2, source: { kind: 'import', importId } })

test('placedObjectIds counts only objects the save will write', () => {
  const state = stateWith([placedObject(7), replacingImport(9, 'imp-a'), plainImport('imp-b')])
  assert.deepEqual([...placedObjectIds(state)], [7])
})

test('the override set is a SUPERSET, because a replaced object keeps its identity', () => {
  // This distinction is the whole reason the two functions exist. "Replace object" retains the
  // original id so its per-object settings follow the new mesh; gating overrides on
  // placedObjectIds would discard the settings of every replaced object.
  const state = stateWith([placedObject(7), replacingImport(9, 'imp-a'), plainImport('imp-b')])
  assert.deepEqual([...objectIdsAcceptingOverrides(state)].sort((a, b) => a - b), [7, 9])
  assert.ok(!placedObjectIds(state).has(9), 'the geometry gate must still exclude it')
})

test('importIdByReplacedObjectId maps a replaced identity to the import standing in for it', () => {
  const state = stateWith([placedObject(7), replacingImport(9, 'imp-a'), plainImport('imp-b')])
  const map = importIdByReplacedObjectId(state)
  assert.equal(map.get(9), 'imp-a')
  assert.equal(map.size, 1, 'an import that replaces nothing must not appear')
})

test('all three derivations span every plate, since the edits they gate are project-wide', () => {
  const state = ({
    plates: [
      { index: 1, instances: [placedObject(3)] },
      { index: 2, instances: [placedObject(4), replacingImport(5, 'imp-c')] }
    ]
  }) as unknown as EditorState
  assert.deepEqual([...placedObjectIds(state)].sort((a, b) => a - b), [3, 4])
  assert.deepEqual([...objectIdsAcceptingOverrides(state)].sort((a, b) => a - b), [3, 4, 5])
  assert.equal(importIdByReplacedObjectId(state).get(5), 'imp-c')
})

test('a per-part key round-trips, and a malformed one drops rather than emitting NaN', () => {
  assert.deepEqual(parsePartPaintKey(partPaintKey(12, 4)), { objectId: 12, componentObjectId: 4 })
  assert.deepEqual(parsePartPaintKey('-7:0'), { objectId: -7, componentObjectId: 0 }, 'clone placeholders are negative')
  for (const bad of ['', '12', 'a:b', '12:', ':4', '12:4:9']) {
    const parsed = parsePartPaintKey(bad)
    if (bad === '12:4:9') continue   // extra segments are ignored, not an error
    assert.equal(parsed, null, `"${bad}" must not parse`)
  }
})

/*
 * DATA LOSS regression (2026-07-28, "Best Shot Golf (PETG) 2"): per-object settings vanished one
 * PLATE per save. Proven from the bridge's own version history: object overrides went 4 -> 4 -> 4
 * -> 2 -> 0 entries, and which ones died tracked the ACTIVE PLATE. The session map holds only the
 * objects in scope (the slice dialog reseeds it from the active plate), so every save inferred
 * "cleared" from "absent" and stripped every other plate's settings.
 */
test('an object absent from the session map is not mentioned, so the save cannot strip it', async () => {
  const { selectObjectProcessOverridesForSave } = await import('./sceneEditIdentity.js')
  // Plate 5 is open: only object 165 is in the session map, but 57/59/162 (other plates) still
  // exist and still carry baked overrides.
  const accepting = new Set([57, 59, 162, 165])
  const selected = selectObjectProcessOverridesForSave({ '165': { enable_support: '1' } }, accepting)
  assert.deepEqual(selected, { '165': { enable_support: '1' } })
  // The point of the test: nothing was emitted for the absent objects. An entry of ANY kind for
  // them, `{}` included, is what erased them.
  for (const id of ['57', '59', '162']) {
    assert.equal(Object.hasOwn(selected ?? {}, id), false, `object ${id} must not be mentioned`)
  }
})

test('an explicit empty entry still clears, so a real reset is not silently ignored', async () => {
  const { selectObjectProcessOverridesForSave } = await import('./sceneEditIdentity.js')
  // The per-object dialog writes `{}` on clear precisely so "cleared" and "not in scope" stop
  // being the same thing. That entry must survive, or a reset would never strip the baked values.
  const selected = selectObjectProcessOverridesForSave({ '59': {}, '165': { wall_loops: '4' } }, new Set([59, 165]))
  assert.deepEqual(selected, { '59': {}, '165': { wall_loops: '4' } })
})

test('overrides for an object that no longer exists are pruned', async () => {
  const { selectObjectProcessOverridesForSave } = await import('./sceneEditIdentity.js')
  const selected = selectObjectProcessOverridesForSave({ '9': { wall_loops: '4' } }, new Set([57]))
  assert.equal(selected, undefined, 'nothing to say -> the field is omitted, not sent empty')
})

test('no session map at all says nothing, rather than saying "no object has overrides"', async () => {
  const { selectObjectProcessOverridesForSave } = await import('./sceneEditIdentity.js')
  assert.equal(selectObjectProcessOverridesForSave(undefined, new Set([57])), undefined)
  assert.equal(selectObjectProcessOverridesForSave({}, new Set([57])), undefined)
})
