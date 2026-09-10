import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hasEditorSelection,
  parsePartMember,
  partMemberKey,
  partRowMenuSelection,
  prunePartSelection,
  rangePartSelection,
  rangeSlice,
  samePartMember,
  togglePartInSelection,
  type PartMember,
  type PartSelection
} from './selectionModel'

/** A part baked into the project's 3MF, by its ordinal. */
const baked = (partIndex: number): PartMember => ({ kind: 'baked', partIndex })
/** A volume added this session, by its own key. */
const added = (key: string): PartMember => ({ kind: 'added', key })
/** The object's own geometry, for an object whose part list does not describe it. */
const body: PartMember = { kind: 'body' }

test('the body is a member like any other, and cannot be confused with a part', () => {
  // It earns a row once something is added beside it (BambuStudio's "a row per volume once there
  // are two"), and from then on it selects, ranges and toggles exactly as the other kinds do.
  assert.deepEqual(parsePartMember(partMemberKey(body)), body)
  assert.equal(samePartMember(body, body), true)
  assert.equal(samePartMember(body, baked(0)), false)
  assert.equal(samePartMember(body, added('body')), false)
  // A part whose key is literally "body" must not decode as the body: that is why the body's key
  // carries no separator, so nothing prefixed can forge it.
  assert.equal(partMemberKey(added('body')), 'added:body')
  assert.deepEqual(parsePartMember('added:body'), added('body'))

  let selection = togglePartInSelection(null, 7, body)
  selection = togglePartInSelection(selection, 7, added('cube-1'))
  assert.deepEqual(selection, { objectId: 7, members: [body, added('cube-1')] })
})

test('a shift-range can start at the body, which the sidebar lists first', () => {
  const ordered = [body, added('cube-1'), added('cube-2')]
  const selection = rangePartSelection(7, ordered, { objectId: 7, member: body }, added('cube-2'))
  assert.deepEqual(selection, { objectId: 7, members: ordered })
})

test('togglePartInSelection starts a selection from nothing', () => {
  assert.deepEqual(togglePartInSelection(null, 7, baked(12)), { objectId: 7, members: [baked(12)] })
})

test('togglePartInSelection adds and removes siblings of the same object', () => {
  let selection = togglePartInSelection(null, 7, baked(12))
  selection = togglePartInSelection(selection, 7, baked(15))
  assert.deepEqual(selection, { objectId: 7, members: [baked(12), baked(15)] })
  selection = togglePartInSelection(selection, 7, baked(12))
  assert.deepEqual(selection, { objectId: 7, members: [baked(15)] })
})

test('a session-added volume joins the same selection as a baked part', () => {
  // THE gap this shape closes. A volume added this session and a part baked into the file are the
  // same thing to the user (the part-is-a-part rule in this plugin's development notes); holding the added
  // one in a separate single-value state meant it could not join a multi-part selection at all, so
  // the sidebar had rows that multi-select and rows that do not, with no visible reason why.
  let selection = togglePartInSelection(null, 7, baked(12))
  selection = togglePartInSelection(selection, 7, added('text-1'))
  assert.deepEqual(selection, { objectId: 7, members: [baked(12), added('text-1')] })
  // And it toggles off again by its own identity, leaving the baked part behind.
  selection = togglePartInSelection(selection, 7, added('text-1'))
  assert.deepEqual(selection, { objectId: 7, members: [baked(12)] })
})

test('the two address spaces are disjoint, so a toggle cannot remove the wrong member', () => {
  assert.equal(samePartMember(baked(1), added('1')), false)
  assert.equal(samePartMember(added('a'), added('a')), true)
  assert.equal(samePartMember(baked(1), baked(1)), true)
})

test('a member round-trips through its key, including a key containing the separator', () => {
  // Range selection compares members as strings, so a key holding a colon must survive: decoding by
  // splitting would truncate it, and a truncated key addresses no volume -- the member would
  // silently select nothing rather than failing.
  for (const member of [baked(0), baked(42), added('text-1'), added('svg:2026:a')]) {
    assert.deepEqual(parsePartMember(partMemberKey(member)), member)
  }
  assert.equal(parsePartMember('added:'), null, 'an empty key names nothing')
  assert.equal(parsePartMember('instance-3'), null, 'an object key is not a part')
})

test('togglePartInSelection clears when the last part is toggled off', () => {
  const selection: PartSelection = { objectId: 7, members: [baked(12)] }
  assert.equal(togglePartInSelection(selection, 7, baked(12)), null)
})

test('togglePartInSelection converts to a different object instead of mixing (BambuStudio rule)', () => {
  const selection: PartSelection = { objectId: 7, members: [baked(12), baked(15)] }
  assert.deepEqual(togglePartInSelection(selection, 9, baked(4)), { objectId: 9, members: [baked(4)] })
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
  const ordered = [baked(10), baked(11), baked(12), baked(13)]
  const selection = rangePartSelection(7, ordered, { objectId: 7, member: baked(11) }, baked(13))
  assert.deepEqual(selection, { objectId: 7, members: [baked(11), baked(12), baked(13)] })
})

test('a shift-range spans both kinds, because the rows it crosses are one list on screen', () => {
  // The sidebar interleaves an object's baked parts and its added volumes, so a range that silently
  // skipped the volumes would select something other than what the user dragged across.
  const ordered = [baked(10), added('text-1'), baked(11), added('svg-2')]
  const selection = rangePartSelection(7, ordered, { objectId: 7, member: baked(10) }, added('svg-2'))
  assert.deepEqual(selection, { objectId: 7, members: ordered })
  // Backwards keeps the anchor first, so the anchor stays the primary.
  const reverse = rangePartSelection(7, ordered, { objectId: 7, member: added('svg-2') }, baked(10))
  assert.deepEqual(reverse, { objectId: 7, members: [...ordered].reverse() })
})

test('rangePartSelection ignores an anchor from another object', () => {
  const ordered = [baked(10), baked(11), baked(12)]
  const selection = rangePartSelection(7, ordered, { objectId: 9, member: baked(11) }, baked(12))
  assert.deepEqual(selection, { objectId: 7, members: [baked(12)] })
})

test('prunePartSelection drops vanished parts and empties to null', () => {
  const selection: PartSelection = { objectId: 7, members: [baked(12), baked(15), baked(18)] }
  assert.deepEqual(prunePartSelection(selection, [baked(12), baked(18)]),
    { objectId: 7, members: [baked(12), baked(18)] })
  assert.equal(prunePartSelection(selection, []), null)
  assert.equal(prunePartSelection(selection, null), null)
  assert.equal(prunePartSelection(null, [baked(12)]), null)
})

test('pruning drops a deleted VOLUME as readily as a deleted part', () => {
  // Both kinds vanish for their own reasons -- an undo restores a part list, a volume leaves
  // `addedParts` -- and a selection that outlived either used to address geometry no longer on the
  // plate. There was no prune for the added half at all before this shape existed.
  const selection: PartSelection = { objectId: 7, members: [baked(12), added('text-1')] }
  assert.deepEqual(prunePartSelection(selection, [baked(12)]), { objectId: 7, members: [baked(12)] })
  assert.deepEqual(prunePartSelection(selection, [added('text-1')]), { objectId: 7, members: [added('text-1')] })
})

test('prunePartSelection returns the same reference when nothing changed', () => {
  const selection: PartSelection = { objectId: 7, members: [baked(12), baked(15)] }
  assert.equal(prunePartSelection(selection, [baked(12), baked(15), baked(20)]), selection)
})

test('a part row menu leaves a gizmo-selected part alone, keeping the object selected', () => {
  // A part that owns a mesh group is selected by keeping `selectedKey` and giving the part the
  // gizmo. Forcing the bulk path here cleared `selectedKey`, which made M/R/S inert and reset every
  // mode that needs a selection right out from under an in-progress brushstroke.
  const result = partRowMenuSelection(
    { objectId: 7, member: baked(2) }, null, { objectId: 7, member: baked(2) }, 'instance-a', 'instance-a')
  assert.equal(result.selectFirst, false)
  assert.deepEqual([...result.members], [baked(2)])
})

test('the gizmo only counts for the instance actually selected', () => {
  // `baked` is object-scoped but the gizmo hangs off ONE instance, so the same part on another
  // instance is not the selected one and does need selecting.
  const result = partRowMenuSelection(
    { objectId: 7, member: baked(2) }, null, { objectId: 7, member: baked(2) }, 'instance-a', 'instance-b')
  assert.equal(result.selectFirst, true)
})

test('a part already in a bulk selection is left alone, and the menu acts on the whole set', () => {
  // A menu never deselects, and never narrows: Delete over a visible multi-part selection removes
  // the set, not just the row it was summoned from.
  const result = partRowMenuSelection(
    { objectId: 7, member: baked(2) },
    { objectId: 7, members: [baked(1), baked(2), added('text-1')] }, null, null, 'instance-a')
  assert.equal(result.selectFirst, false)
  assert.deepEqual([...result.members], [baked(1), baked(2), added('text-1')],
    'the menu acts on the whole mixed set, not just its baked half')
})

test('an unselected part is selected first, and the menu acts on just it', () => {
  const result = partRowMenuSelection(
    { objectId: 7, member: baked(3) }, { objectId: 7, members: [baked(1), baked(2)] }, null, null, 'instance-a')
  assert.equal(result.selectFirst, true)
  assert.deepEqual([...result.members], [baked(3)])
})

test('a bulk selection belonging to another object does not count', () => {
  const result = partRowMenuSelection(
    { objectId: 8, member: baked(1) }, { objectId: 7, members: [baked(1)] }, null, null, 'instance-a')
  assert.equal(result.selectFirst, true)
  assert.deepEqual([...result.members], [baked(1)])
})

/**
 * Escape's "is anything selected" question, which is more than one field.
 *
 * The bulk part path nulls `selectedKey` on purpose (an object selection and a part selection are
 * different modes and never coexist), so the object field alone answers "nothing selected" while a
 * part is highlighted on screen. Escape used to ask exactly that and close the editor -- over a live
 * selection, and with unsaved work behind a discard prompt.
 */
test('every selection shape counts as a selection, including the ones that null the object key', () => {
  const none = { objectKey: null, partSelection: null, gizmoPart: null }
  assert.equal(hasEditorSelection(none), false)

  assert.equal(hasEditorSelection({ ...none, objectKey: 'plate-1:obj-5' }), true)
  // The ones that leave `objectKey` null. Each was reported as "nothing selected" before.
  assert.equal(hasEditorSelection({ ...none, partSelection: { objectId: 5, members: [baked(0), baked(2)] } }), true,
    'a bulk part selection reads as an empty editor')
  assert.equal(hasEditorSelection({ ...none, gizmoPart: { objectId: 5, member: baked(1) } }), true,
    'the part holding the gizmo reads as an empty editor')
  // A session-added volume is no longer a shape of its own: it is a member like any other, which is
  // what stopped every clearing site from having to remember a fourth field.
  assert.equal(hasEditorSelection({ ...none, partSelection: { objectId: 5, members: [added('text-1')] } }), true)
  assert.equal(hasEditorSelection({ ...none, gizmoPart: { objectId: 5, member: added('text-1') } }), true)
})
