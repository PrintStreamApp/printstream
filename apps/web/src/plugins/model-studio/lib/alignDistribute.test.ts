/**
 * The align/distribute arithmetic, checked against BambuStudio's rules rather than against what
 * looks reasonable. The two that matter: align never moves the selection as a whole (its reference
 * is an extreme already in the selection), and distribute equalises CENTRES while leaving both
 * extremes exactly where they are.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ALIGN_DISTRIBUTE_OPERATIONS,
  alignOffsets,
  distributeOffsets,
  minimumMembersFor,
  type AlignMember
} from './alignDistribute'

/** A member spanning `min..max` on the axis under test. */
const m = (key: string, min: number, max: number): AlignMember => ({ key, min, max })

test('align min pulls every member to the lowest edge already in the selection', () => {
  const offsets = alignOffsets([m('a', 10, 20), m('b', 30, 34), m('c', 50, 70)], 'min')
  // 'a' is already lowest, so it does not move at all and is absent from the map.
  assert.equal(offsets.has('a'), false)
  assert.equal(offsets.get('b'), -20)
  assert.equal(offsets.get('c'), -40)
})

test('align max pulls every member to the highest edge already in the selection', () => {
  const offsets = alignOffsets([m('a', 10, 20), m('b', 30, 34), m('c', 50, 70)], 'max')
  assert.equal(offsets.get('a'), 50)
  assert.equal(offsets.get('b'), 36)
  assert.equal(offsets.has('c'), false)
})

test('align centre uses the combined box, so a wide member does not drag the line', () => {
  // Combined box is 0..100, centre 50. The mean of the members' own centres would be 40, which is
  // what a hand-rolled version computes and is wrong.
  const offsets = alignOffsets([m('wide', 0, 100), m('a', 10, 20), m('b', 20, 30)], 'center')
  assert.equal(offsets.has('wide'), false, 'the wide member is already centred on the combined box')
  assert.equal(offsets.get('a'), 35)
  assert.equal(offsets.get('b'), 25)
})

test('aligning takes its reference from the selection, so the line stays put', () => {
  const members = [m('a', 10, 20), m('b', 30, 34), m('c', 50, 70)]

  // For min/max the reference IS a member's edge, so that member never moves.
  assert.equal(alignOffsets(members, 'min').has('a'), false, 'the lowest member moved')
  assert.equal(alignOffsets(members, 'max').has('c'), false, 'the highest member moved')

  // Centre is different and legitimately moves every member: they all converge on one line. The
  // invariant there is that the line itself is the combined box's centre and does not drift.
  const offsets = alignOffsets(members, 'center')
  const combinedCentre = (Math.min(...members.map((member) => member.min)) + Math.max(...members.map((member) => member.max))) / 2
  for (const member of members) {
    const moved = (member.min + member.max) / 2 + (offsets.get(member.key) ?? 0)
    assert.ok(Math.abs(moved - combinedCentre) < 1e-9, `${member.key} landed at ${moved}, not ${combinedCentre}`)
  }
})

test('align needs two members', () => {
  assert.equal(alignOffsets([m('only', 0, 10)], 'min').size, 0)
  assert.equal(alignOffsets([], 'center').size, 0)
})

test('distribute equalises centres and leaves both extremes alone', () => {
  // Centres at 5, 10, 45, 95. Span 5..95 over 3 intervals = 30, so targets are 35 and 65.
  const offsets = distributeOffsets([m('a', 0, 10), m('b', 5, 15), m('c', 40, 50), m('d', 90, 100)])
  assert.equal(offsets.has('a'), false, 'the low extreme moved')
  assert.equal(offsets.has('d'), false, 'the high extreme moved')
  assert.equal(offsets.get('b'), 25)
  assert.equal(offsets.get('c'), 20)
})

test('distribute equalises CENTRES, not gaps, when members differ in size', () => {
  // The distinction only shows up with unequal sizes, which is why equal-size fixtures pass either
  // implementation. Centres 5, 50, 95 -> the middle belongs at 50 whatever its width.
  const offsets = distributeOffsets([m('a', 0, 10), m('fat', 20, 80), m('c', 90, 100)])
  assert.equal(offsets.has('fat'), false, 'centre 50 is already the even position')

  // Shift the fat one off centre and it comes back to 50, not to an equal-gap position.
  const shifted = distributeOffsets([m('a', 0, 10), m('fat', 30, 90), m('c', 90, 100)])
  assert.equal(shifted.get('fat'), -10, 'expected a move back to centre 50')
})

test('distribute sorts by centre rather than trusting selection order', () => {
  // The user clicked them right-to-left; the result must be identical to the sorted case.
  const shuffled = distributeOffsets([m('d', 90, 100), m('b', 5, 15), m('a', 0, 10), m('c', 40, 50)])
  assert.equal(shuffled.get('b'), 25)
  assert.equal(shuffled.get('c'), 20)
  assert.equal(shuffled.has('a'), false)
  assert.equal(shuffled.has('d'), false)
})

test('distribute needs three members', () => {
  assert.equal(distributeOffsets([m('a', 0, 10), m('b', 90, 100)]).size, 0)
  assert.equal(distributeOffsets([m('a', 0, 10)]).size, 0)
})

test('an already-even spread produces no moves at all', () => {
  const offsets = distributeOffsets([m('a', 0, 10), m('b', 20, 30), m('c', 40, 50)])
  assert.equal(offsets.size, 0)
})

test('the catalogue is BambuStudios twelve, with the right minimums', () => {
  assert.equal(ALIGN_DISTRIBUTE_OPERATIONS.length, 12)
  const distribute = ALIGN_DISTRIBUTE_OPERATIONS.filter((operation) => !operation.mode)
  const align = ALIGN_DISTRIBUTE_OPERATIONS.filter((operation) => operation.mode)
  assert.equal(distribute.length, 3, 'one distribute per axis')
  assert.equal(align.length, 9, 'three align modes per axis')
  assert.deepEqual(distribute.map((operation) => minimumMembersFor(operation)), [3, 3, 3])
  assert.ok(align.every((operation) => minimumMembersFor(operation) === 2))
  assert.equal(new Set(ALIGN_DISTRIBUTE_OPERATIONS.map((operation) => operation.id)).size, 12, 'duplicate id')
})
