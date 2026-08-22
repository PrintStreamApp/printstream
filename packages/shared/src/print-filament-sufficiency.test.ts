import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findLowFilamentSlots, lowFilamentIssueSentence } from './print-filament-sufficiency.js'
import type { QueueLoadedSlot, QueueRequiredFilament } from './print-queue.js'

function required(overrides: Partial<QueueRequiredFilament> = {}): QueueRequiredFilament {
  return { id: 1, filamentType: 'PLA', color: '#00B7EB', usedGrams: 200, nozzleId: null, ...overrides }
}

/** An RFID tray at `percent` full, in AMS unit 0. */
function slot(trayIndex: number, percent: number | null, overrides: Partial<QueueLoadedSlot> = {}): QueueLoadedSlot {
  return {
    trayIndex,
    filamentType: 'PLA',
    color: '#00B7EB',
    colors: ['#00B7EB'],
    trayName: 'Cyan',
    trayInfoIdx: 'GFA01',
    trayUuid: `UUID${trayIndex}`,
    remainPercent: percent,
    occupied: true,
    nozzleId: null,
    ...overrides
  }
}

const NO_REFILL = { autoRefillEnabled: false }

test('reports a mapped slot that cannot finish the plate', () => {
  const issues = findLowFilamentSlots({
    required: [required({ usedGrams: 200 })],
    slots: [slot(0, 4)],
    amsMapping: [0],
    ...NO_REFILL
  })

  assert.equal(issues.length, 1)
  assert.deepEqual(
    { filamentId: issues[0]?.filamentId, remainGrams: issues[0]?.remainGrams, pooled: issues[0]?.pooled },
    { filamentId: 1, remainGrams: 40, pooled: false }
  )
})

test('says nothing about a slot that holds enough', () => {
  const issues = findLowFilamentSlots({
    required: [required({ usedGrams: 200 })],
    slots: [slot(0, 90)],
    amsMapping: [0],
    ...NO_REFILL
  })
  assert.deepEqual(issues, [])
})

test('says nothing about a slot it cannot measure', () => {
  // A hand-set spool reports no usable figure. Warning "0g left" on every one of them would
  // train the user to click straight through the confirmation.
  const issues = findLowFilamentSlots({
    required: [required({ usedGrams: 200 })],
    slots: [slot(0, null, { trayUuid: null })],
    amsMapping: [0],
    ...NO_REFILL
  })
  assert.deepEqual(issues, [])
})

test('says nothing when the plate never states its usage', () => {
  const issues = findLowFilamentSlots({
    required: [required({ usedGrams: null })],
    slots: [slot(0, 1)],
    amsMapping: [0],
    ...NO_REFILL
  })
  assert.deepEqual(issues, [])
})

test('a backup slot the printer will chain to covers the shortfall', () => {
  // "Too little AND no backup": neither slot could finish alone, but auto-refill runs them
  // as one supply, so there is nothing to confirm.
  const slots = [slot(0, 12), slot(1, 30)]
  assert.deepEqual(
    findLowFilamentSlots({ required: [required({ usedGrams: 300 })], slots, amsMapping: [0], autoRefillEnabled: true }),
    []
  )
  // Same two slots with auto-refill off: the printer will not chain them, so it is short.
  assert.equal(
    findLowFilamentSlots({ required: [required({ usedGrams: 300 })], slots, amsMapping: [0], ...NO_REFILL }).length,
    1
  )
})

test('a backed-up slot is still reported when the whole pool falls short', () => {
  const issues = findLowFilamentSlots({
    required: [required({ usedGrams: 800 })],
    slots: [slot(0, 12), slot(1, 30)],
    amsMapping: [0],
    autoRefillEnabled: true
  })

  assert.equal(issues.length, 1)
  assert.equal(issues[0]?.pooled, true)
  assert.equal(issues[0]?.remainGrams, 420)
})

test('ignores filaments that were never mapped', () => {
  const issues = findLowFilamentSlots({
    required: [required({ id: 1, usedGrams: 200 }), required({ id: 2, usedGrams: 200 })],
    slots: [slot(0, 4)],
    amsMapping: [0, -1],
    ...NO_REFILL
  })
  assert.deepEqual(issues.map((issue) => issue.filamentId), [1])
})

test('worst shortfall first', () => {
  const issues = findLowFilamentSlots({
    required: [required({ id: 1, usedGrams: 100 }), required({ id: 2, usedGrams: 900 })],
    slots: [slot(0, 6), slot(1, 6, { color: '#FF0000', colors: ['#FF0000'] })],
    amsMapping: [0, 1],
    ...NO_REFILL
  })
  assert.deepEqual(issues.map((issue) => issue.filamentId), [2, 1])
})

test('the sentence says what is actually wrong at each end of the threshold', () => {
  const short = findLowFilamentSlots({
    required: [required({ usedGrams: 200 })],
    slots: [slot(0, 4)],
    amsMapping: [0],
    ...NO_REFILL
  })[0]!
  assert.equal(
    lowFilamentIssueSentence(short, 'AMS A Slot 1'),
    'AMS A Slot 1 has about 40g of PLA left, and this plate needs 200g.'
  )

  // Over the plate's own figure but inside the 25g margin: "has 210g and needs 200g" would
  // read as a bug rather than a warning, so this case gets its own wording.
  const tight = findLowFilamentSlots({
    required: [required({ usedGrams: 200 })],
    slots: [slot(0, 21)],
    amsMapping: [0],
    ...NO_REFILL
  })[0]!
  assert.match(tight && lowFilamentIssueSentence(tight, 'AMS A Slot 1'), /barely over the 200g/)
})

test('a filament the plate consumes nothing of is never short', () => {
  // A listed-but-unused material (or one rounded down from under half a gram)
  // used to be graded against the bare 25g headroom, so any slot holding less
  // than that was reported, and the sentence read "barely over the 0g this plate
  // needs". Zero usage is not a requirement to grade.
  assert.deepEqual(
    findLowFilamentSlots({ required: [required({ usedGrams: 0 })], slots: [slot(0, 2)], amsMapping: [0], ...NO_REFILL }),
    []
  )
})

test('tracked grams are believed over the printer percent, in both directions', () => {
  // The browser attaches filament-manager's tracked grams before grading, and
  // `knownRemainGrams` REPLACES the percent estimate with them rather than taking
  // the lower of the two. So a tray the printer calls half empty can hold plenty
  // (a 5kg spool, or a hand-weighed figure), and a guard that grades without the
  // tracked number refuses a print the dialog raised no warning for.
  const req = [required({ usedGrams: 600 })]
  assert.deepEqual(
    findLowFilamentSlots({ required: req, slots: [slot(0, 50, { remainingGrams: 1000 })], amsMapping: [0], ...NO_REFILL }),
    []
  )
  assert.equal(
    findLowFilamentSlots({ required: req, slots: [slot(0, 50)], amsMapping: [0], ...NO_REFILL }).length,
    1
  )
})
