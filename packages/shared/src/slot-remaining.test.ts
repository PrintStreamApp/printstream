import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  gradeSlotSufficiency,
  knownRemainGrams,
  traysMatchForAutoRefill,
  type RemainingFilamentTray
} from './slot-remaining.js'

function tray(overrides: Partial<RemainingFilamentTray> = {}): RemainingFilamentTray {
  return {
    filamentType: 'PLA',
    color: '#00B7EB',
    colors: ['#00B7EB'],
    trayName: 'Cyan',
    trayInfoIdx: 'GFA01',
    trayUuid: null,
    remainPercent: null,
    ...overrides
  }
}

function grade(anchor: RemainingFilamentTray, candidates: RemainingFilamentTray[], requiredGrams: number | null) {
  return gradeSlotSufficiency({
    tray: anchor,
    trayIsRefillable: candidates.includes(anchor),
    refillCandidates: candidates,
    requiredGrams,
    autoRefillEnabled: true
  })
}

test('a percent is believed only for an RFID tray', () => {
  assert.equal(knownRemainGrams(tray({ trayUuid: 'A1B2C3', remainPercent: 80 })), 800)
  // Third-party spool: the printer cannot measure it, so its percent means nothing.
  assert.equal(knownRemainGrams(tray({ trayUuid: null, remainPercent: 80 })), null)
  // An all-zero uuid is Bambu's "no tag", which the parser already maps to null.
  assert.equal(knownRemainGrams(tray({ trayUuid: '00000000', remainPercent: 80 })), null)
})

test('a tracked spool outranks the percent estimate', () => {
  const slot = tray({ trayUuid: 'A1B2C3', remainPercent: 5, remainingGrams: 640 })
  assert.equal(knownRemainGrams(slot), 640)
})

test('pooling is decided by declared identity, never by RFID', () => {
  const manual = tray({ trayUuid: null })
  const tagged = tray({ trayUuid: 'A1B2C3' })
  assert.equal(traysMatchForAutoRefill(manual, tray({ trayUuid: null })), true)
  assert.equal(traysMatchForAutoRefill(manual, tagged), true)
  // Identity is what the printer chains on, so a slot declaring none never pools.
  const anonymous = tray({ trayName: null, trayInfoIdx: null })
  assert.equal(traysMatchForAutoRefill(anonymous, tray({ trayName: null, trayInfoIdx: null })), false)
})

test('a pool nothing can measure is unknown, not empty', () => {
  // Two hand-set spools backing each other up. Grading them as 0g + 0g made auto-refill
  // actively WORSE than leaving it off, which demoted the pool below an ungradeable solo slot.
  const anchor = tray()
  const mate = tray()
  const result = grade(anchor, [anchor, mate], 200)

  assert.equal(result.pooled, true)
  assert.equal(result.remainGrams, null)
  assert.equal(result.sufficiency, 'unknown')
})

test('an unmeasurable poolmate understates the pool rather than voiding it', () => {
  const anchor = tray({ trayUuid: 'A1B2C3', remainPercent: 90 })
  const mate = tray()
  const result = grade(anchor, [anchor, mate], 200)

  // 900g known plus one unknown: at LEAST 900g, so reporting 900 can only over-warn.
  assert.equal(result.remainGrams, 900)
  assert.equal(result.sufficiency, 'enough')
})

test('a pool is graded on its combined remaining', () => {
  const anchor = tray({ trayUuid: 'A1', remainPercent: 12 })
  const mate = tray({ trayUuid: 'B2', remainPercent: 30 })

  assert.equal(grade(anchor, [anchor, mate], 300).sufficiency, 'enough')
  assert.equal(grade(anchor, [anchor, mate], 400).sufficiency, 'short')
})

test('a slot the printer cannot refill from is never pooled', () => {
  // The anchor is an external spool: two matching AMS trays sit behind it, but the
  // printer will not chain them to it, so it must be graded alone.
  const anchor = tray({ trayUuid: 'A1', remainPercent: 2 })
  const mates = [tray({ trayUuid: 'B2', remainPercent: 90 }), tray({ trayUuid: 'C3', remainPercent: 90 })]
  const result = gradeSlotSufficiency({
    tray: anchor,
    trayIsRefillable: false,
    refillCandidates: mates,
    requiredGrams: 100,
    autoRefillEnabled: true
  })

  assert.equal(result.pooled, false)
  assert.equal(result.remainGrams, 20)
  assert.equal(result.sufficiency, 'short')
})

test('the headroom is what separates short from enough', () => {
  const slot = tray({ trayUuid: 'A1', remainPercent: 22 })
  assert.equal(grade(slot, [slot], 195).sufficiency, 'enough')
  // 220g against 200g needed: over the plate's figure, but inside the 25g margin.
  assert.equal(grade(slot, [slot], 200).sufficiency, 'short')
})

test('a plate that states no usage cannot be graded, but its pool is still known', () => {
  const anchor = tray({ trayUuid: 'A1', remainPercent: 2 })
  const mate = tray({ trayUuid: 'B2', remainPercent: 90 })
  const result = grade(anchor, [anchor, mate], null)

  assert.equal(result.sufficiency, 'unknown')
  assert.equal(result.pooled, true)
})
