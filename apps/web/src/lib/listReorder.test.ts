/**
 * The plate strip's drop-target geometry: pointer position -> insertion gap, and gap -> caret
 * position. Both must be direction-independent (the same drop point means the same landing
 * whichever way the drag came from) and orientation-agnostic (callers feed whichever axis the
 * strip runs on).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { listGapToIndex, listInsertionCaretCenter, listInsertionGap } from './listReorder'

// Three 92px tiles with 6px gaps: [0..92] [98..190] [196..288].
const TILES = [
  { start: 0, end: 92 },
  { start: 98, end: 190 },
  { start: 196, end: 288 }
]

test('listInsertionGap maps a pointer to the gap between tile midpoints', () => {
  assert.equal(listInsertionGap(TILES, -20), 0, 'before the strip inserts first')
  assert.equal(listInsertionGap(TILES, 10), 0, 'leading half of tile 1 inserts before it')
  assert.equal(listInsertionGap(TILES, 60), 1, 'trailing half of tile 1 inserts after it')
  assert.equal(listInsertionGap(TILES, 144), 1, 'the physical gap between tiles 1 and 2')
  assert.equal(listInsertionGap(TILES, 250), 3, 'trailing half of the last tile inserts at the end')
  assert.equal(listInsertionGap(TILES, 500), 3, 'past the strip inserts last')
  assert.equal(listInsertionGap([], 50), 0)
})

test('listInsertionCaretCenter sits mid-gap, or just outside a terminal tile', () => {
  assert.equal(listInsertionCaretCenter(TILES, 1), 95, 'between tiles: the middle of the 6px gap')
  assert.equal(listInsertionCaretCenter(TILES, 2), 193)
  assert.equal(listInsertionCaretCenter(TILES, 0), -2, 'before the first tile')
  assert.equal(listInsertionCaretCenter(TILES, 3), 290, 'after the last tile')
  assert.equal(listInsertionCaretCenter(TILES, 99), 290, 'out-of-range gaps clamp')
  assert.equal(listInsertionCaretCenter([], 0), null, 'nothing to anchor to')
})

/**
 * Gap -> splice index. The forward case is the one that hides: a backward drag reads correctly
 * while a forward drag lands one slot too far, which looks like an imprecise drag rather than a
 * bug. Worked as a full move over [A,B,C,D] so the expectation is the user-visible result.
 */
const moveByGap = (items: string[], from: number, insertAt: number): string[] => {
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(listGapToIndex(from, insertAt), 0, moved!)
  return next
}

test('listGapToIndex lands a FORWARD move in the gap the caret showed', () => {
  const items = ['A', 'B', 'C', 'D']
  // Dropped in the gap before C: A must end up between B and C, not after C.
  assert.deepEqual(moveByGap(items, 0, 2), ['B', 'A', 'C', 'D'])
  assert.deepEqual(moveByGap(items, 0, 4), ['B', 'C', 'D', 'A'], 'the gap past the end is last')
})

test('listGapToIndex lands a BACKWARD move in the gap the caret showed', () => {
  const items = ['A', 'B', 'C', 'D']
  assert.deepEqual(moveByGap(items, 3, 1), ['A', 'D', 'B', 'C'])
  assert.deepEqual(moveByGap(items, 3, 0), ['D', 'A', 'B', 'C'])
})

test('the two gaps either side of an item are a no-op', () => {
  const items = ['A', 'B', 'C', 'D']
  assert.deepEqual(moveByGap(items, 1, 1), items)
  assert.deepEqual(moveByGap(items, 1, 2), items)
  assert.equal(listGapToIndex(1, 1), 1)
  assert.equal(listGapToIndex(1, 2), 1)
})
