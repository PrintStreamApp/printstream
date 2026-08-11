/**
 * The plate strip's drop-target geometry: pointer position -> insertion gap, and gap -> caret
 * position. Both must be direction-independent (the same drop point means the same landing
 * whichever way the drag came from) and orientation-agnostic (callers feed whichever axis the
 * strip runs on).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { listInsertionCaretCenter, listInsertionGap } from './listReorder'

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
