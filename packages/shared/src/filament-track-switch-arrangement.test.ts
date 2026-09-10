import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  filamentTrackSwitchArrangement,
  filamentTrackSwitchMoveSentence
} from './filament-track-switch-arrangement.js'
import type { PrinterStatus } from './printer-contracts.js'

/**
 * A printer with two AMS units behind the switch, unit 0 on inlet A and unit 1 on inlet B.
 * Tray indexes are the plain `unitId * 4 + slot` of an ordinary AMS.
 */
function buildStatus(overrides: {
  installed?: boolean
  inlets?: (('A' | 'B') | null)[]
} = {}): PrinterStatus {
  const inlets = overrides.inlets ?? ['A', 'B']
  return {
    externalSpools: [],
    nozzles: [],
    filamentTrackSwitch: {
      installed: overrides.installed ?? true,
      inputA: null,
      inputB: null,
      outputAExtruderId: 0,
      outputBExtruderId: 1,
      calibrating: false,
      filamentPresent: null
    },
    ams: inlets.map((switchInput, unitId) => ({
      unitId,
      type: 'ams',
      nozzleId: null,
      switchInput,
      slots: [0, 1, 2, 3].map((slot) => ({ slot, filamentType: 'PLA' }))
    }))
  } as unknown as PrinterStatus
}

test('two groups already on the right inlets need no moves', () => {
  // Filaments 1+2 (group 0) sit in unit 0 (inlet A); filaments 3+4 (group 1) in unit 1 (inlet B).
  const result = filamentTrackSwitchArrangement({
    optimalAssignment: [0, 0, 1, 1],
    status: buildStatus(),
    amsMapping: [0, 1, 4, 5]
  })

  assert.ok(result)
  assert.deepEqual(result.moves, [])
  assert.equal(result.suggestedInletByFilamentId.get(1), 'A')
  assert.equal(result.suggestedInletByFilamentId.get(3), 'B')
})

test('a filament on the wrong inlet is reported as one move, not a whole re-plan', () => {
  // Same grouping, but filament 3 (group 1) sits in unit 0 (inlet A) with the group-0 pair.
  const result = filamentTrackSwitchArrangement({
    optimalAssignment: [0, 0, 1, 1],
    status: buildStatus(),
    amsMapping: [0, 1, 2, 5]
  })

  assert.ok(result)
  assert.deepEqual(result.moves, [{ filamentId: 3, trayIndex: 2, currentInlet: 'A', suggestedInlet: 'B' }])
})

test('the cheaper of the two assignments wins, so the majority never moves', () => {
  // Group 0 is filaments 1-3, all on inlet B; group 1 is filament 4, on inlet A. Putting group 0
  // on A would move three spools; leaving it on B moves none.
  const result = filamentTrackSwitchArrangement({
    optimalAssignment: [0, 0, 0, 1],
    status: buildStatus(),
    amsMapping: [4, 5, 6, 0]
  })

  assert.ok(result)
  assert.deepEqual(result.moves, [])
  assert.equal(result.suggestedInletByFilamentId.get(1), 'B')
  assert.equal(result.suggestedInletByFilamentId.get(4), 'A')
})

test('one group settles on whichever inlet already holds more of it', () => {
  // Three filaments on inlet B, one on A, all in one group: move the odd one out, not the three.
  const result = filamentTrackSwitchArrangement({
    optimalAssignment: [0, 0, 0, 0],
    status: buildStatus(),
    amsMapping: [4, 5, 6, 0]
  })

  assert.ok(result)
  assert.deepEqual(result.moves, [{ filamentId: 4, trayIndex: 0, currentInlet: 'A', suggestedInlet: 'B' }])
})

test('an AMS that does not report its inlet silences the hint entirely', () => {
  // Not "assume A": a unit we cannot place would count as already-correct on both options, which
  // makes the whole comparison unsound rather than slightly wrong.
  const result = filamentTrackSwitchArrangement({
    optimalAssignment: [0, 0, 1, 1],
    status: buildStatus({ inlets: ['A', null] }),
    amsMapping: [0, 1, 4, 5]
  })

  assert.equal(result, null)
})

test('more than two groups has no meaning on a two-inlet switch', () => {
  const result = filamentTrackSwitchArrangement({
    optimalAssignment: [0, 1, 2],
    status: buildStatus(),
    amsMapping: [0, 4, 1]
  })

  assert.equal(result, null)
})

test('no switch, no slicer grouping and no mapping each silence the hint', () => {
  const base = { optimalAssignment: [0, 1], status: buildStatus(), amsMapping: [0, 4] }
  assert.ok(filamentTrackSwitchArrangement(base))

  assert.equal(filamentTrackSwitchArrangement({ ...base, status: buildStatus({ installed: false }) }), null)
  // Absent grouping means "not sliced for a switch", which is not the same as one group.
  assert.equal(filamentTrackSwitchArrangement({ ...base, optimalAssignment: null }), null)
  assert.equal(filamentTrackSwitchArrangement({ ...base, optimalAssignment: [] }), null)
  assert.equal(filamentTrackSwitchArrangement({ ...base, amsMapping: [] }), null)
  assert.equal(filamentTrackSwitchArrangement({ ...base, status: null }), null)
})

test('unmapped filaments are ignored, including their group', () => {
  // Filament 2 is unmapped (-1). Its group must not create a second group out of nothing.
  const result = filamentTrackSwitchArrangement({
    optimalAssignment: [0, 1, 0],
    status: buildStatus(),
    amsMapping: [0, -1, 1]
  })

  assert.ok(result)
  assert.equal(result.suggestedInletByFilamentId.has(2), false)
  assert.deepEqual(result.moves, [])
})

test('an empty moves list is not the same as no suggestion', () => {
  // The distinction the UI depends on: null means "nothing trustworthy to say" and must render
  // nothing, while an empty list means "checked, already arranged well".
  const arranged = filamentTrackSwitchArrangement({
    optimalAssignment: [0, 0],
    status: buildStatus(),
    amsMapping: [0, 1]
  })
  assert.ok(arranged)
  assert.deepEqual(arranged.moves, [])

  assert.equal(filamentTrackSwitchArrangement({
    optimalAssignment: [0, 0],
    status: buildStatus({ installed: false }),
    amsMapping: [0, 1]
  }), null)
})

test('a move sentence names the slot the caller gave it', () => {
  const sentence = filamentTrackSwitchMoveSentence(
    { filamentId: 3, trayIndex: 2, currentInlet: 'A', suggestedInlet: 'B' },
    'AMS A Slot 3'
  )
  assert.match(sentence, /Filament 3 is in AMS A Slot 3, behind inlet A\./)
  assert.match(sentence, /an AMS on inlet B/)
})
