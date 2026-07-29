import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorHistoryModel, type ApplyAndInvert } from './editorHistoryModel'
import { type EditorHistoryEntry } from './editorGeometry'

/** A throwaway entry — the model treats entries opaquely, so the contents do not matter here. */
const entry = (): EditorHistoryEntry => ({ state: null, sliceConfig: null })
/** Restore is faked: the model only needs an inverse back for the opposite stack. */
const apply: ApplyAndInvert = (e) => e

test('a fresh model is clean with nothing to undo or redo', () => {
  const m = new EditorHistoryModel()
  assert.equal(m.isDirty, false)
  assert.equal(m.canUndo, false)
  assert.equal(m.canRedo, false)
})

test('recording an undoable edit makes it dirty and undoable', () => {
  const m = new EditorHistoryModel()
  m.record(entry())
  assert.equal(m.isDirty, true)
  assert.equal(m.canUndo, true)
  assert.equal(m.canRedo, false)
})

test('undoing every edit returns the project to clean (the reported bug)', () => {
  const m = new EditorHistoryModel()
  m.record(entry())
  m.record(entry())
  assert.equal(m.isDirty, true)
  assert.equal(m.undo(apply), true)
  assert.equal(m.isDirty, true) // one edit still applied
  assert.equal(m.undo(apply), true)
  assert.equal(m.isDirty, false) // all the way undone -> clean
  assert.equal(m.canUndo, false)
  assert.equal(m.canRedo, true)
})

test('redoing back past the saved point is dirty again', () => {
  const m = new EditorHistoryModel()
  m.record(entry())
  m.undo(apply)
  assert.equal(m.isDirty, false)
  assert.equal(m.redo(apply), true)
  assert.equal(m.isDirty, true)
})

test('save adopts the current state as the clean baseline', () => {
  const m = new EditorHistoryModel()
  m.record(entry())
  m.markSaved()
  assert.equal(m.isDirty, false)
  // Undoing a *saved* edit is once again a deviation from saved.
  m.undo(apply)
  assert.equal(m.isDirty, true)
  m.redo(apply)
  assert.equal(m.isDirty, false)
})

test('non-undoable edits stay dirty until save, regardless of undo', () => {
  const m = new EditorHistoryModel()
  m.record(entry())
  m.markNonUndoableDirty()
  m.undo(apply)
  // Scene edit undone, but the non-undoable edit cannot be reversed.
  assert.equal(m.isDirty, true)
  assert.equal(m.canUndo, false)
  m.markSaved()
  assert.equal(m.isDirty, false)
})

test('branching to the same stack depth does not read as a false clean', () => {
  const m = new EditorHistoryModel() // saved baseline = v0
  m.record(entry()) // v1
  assert.equal(m.undo(apply), true) // back to v0 -> clean
  assert.equal(m.isDirty, false)
  m.record(entry()) // v2, discards the redo of v1; same stack depth as after the first record
  assert.equal(m.isDirty, true) // different version id, so not clean
  assert.equal(m.canRedo, false) // the old redo branch was discarded
})

test('once history is trimmed past the saved point, undo cannot reach clean again', () => {
  const m = new EditorHistoryModel(2) // keep at most 2 undo steps
  m.record(entry())
  m.record(entry())
  m.record(entry()) // the oldest checkpoint (back to v0) is dropped
  assert.equal(m.undo(apply), true)
  assert.equal(m.undo(apply), true)
  assert.equal(m.canUndo, false) // stacks exhausted
  assert.equal(m.isDirty, true) // but the saved (v0) state is unreachable, so still dirty
})

test('mapFrames rewrites both stacks without touching dirtiness or reachability', () => {
  // The id-space migration a renumbering save forces on the retained frames (audit F7). It must be
  // invisible to the version bookkeeping: a clean project stays clean, and undo still reaches the
  // saved point.
  const tagged = (tag: string): EditorHistoryEntry =>
    ({ state: { tag } as unknown as EditorHistoryEntry['state'], sliceConfig: null })
  const m = new EditorHistoryModel()
  m.record(tagged('a'))
  m.record(tagged('b'))
  m.undo(apply) // one frame now sits on the redo stack

  m.mapFrames((e) => tagged(`${(e.state as unknown as { tag: string }).tag}!`))

  assert.equal(m.isDirty, true)
  assert.equal(m.canUndo, true)
  assert.equal(m.canRedo, true)
  const seen: string[] = []
  const collect: ApplyAndInvert = (e) => { seen.push((e.state as unknown as { tag: string }).tag); return e }
  m.undo(collect)
  assert.equal(m.isDirty, false, 'undoing to the saved version still reads clean after a migration')
  m.redo(collect)
  assert.equal(m.isDirty, true, 'and redoing away from it is dirty again')
  assert.deepEqual(seen, ['a!', 'a!'], 'both stacks were rewritten, and both still restore')
})
