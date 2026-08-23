import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getSlotRemainingState, type SlotRemainingTray } from './slotRemaining'

/** An RFID-tagged Bambu tray: the only kind whose reported percent may be believed. */
function makeTray(overrides: Partial<SlotRemainingTray> = {}): SlotRemainingTray {
  return {
    kind: overrides.kind ?? 'ams',
    filamentType: overrides.filamentType ?? 'PLA Basic',
    color: overrides.color ?? '#00B7EB',
    colors: overrides.colors ?? ['#00B7EB'],
    trayName: overrides.trayName ?? 'Cyan',
    trayInfoIdx: overrides.trayInfoIdx ?? 'GFA01',
    trayUuid: 'trayUuid' in overrides ? overrides.trayUuid : 'A1B2C3D4',
    remainingGrams: overrides.remainingGrams,
    remainPercent: overrides.remainPercent ?? 10,
    nozzleId: overrides.nozzleId ?? 0
  }
}

/**
 * A spool the user set by hand: identity declared through the AMS dialog, but no RFID
 * tag, so the printer reports `remain: -1` and the parser hands us null.
 */
function makeManualTray(overrides: Partial<SlotRemainingTray> = {}): SlotRemainingTray {
  return makeTray({ ...overrides, trayUuid: null, remainPercent: overrides.remainPercent ?? null })
}

const REQUIREMENT = { requiredFilamentType: 'PLA Basic', requiredNozzleId: 0 }

test('marks an individual tray insufficient when auto-refill is disabled', () => {
  const tray = makeTray({ remainPercent: 4 })

  const result = getSlotRemainingState({
    tray,
    trays: [tray],
    ...REQUIREMENT,
    requiredGrams: 30,
    autoRefillEnabled: false
  })

  assert.equal(result.remainGrams, 40)
  assert.equal(result.insufficient, true)
  assert.equal(result.usesAutoRefill, false)
})

test('uses combined matching AMS trays when auto-refill is enabled', () => {
  const tray = makeTray({ remainPercent: 4 })
  const sibling = makeTray({ remainPercent: 3 })

  const result = getSlotRemainingState({
    tray,
    trays: [tray, sibling],
    ...REQUIREMENT,
    requiredGrams: 40,
    autoRefillEnabled: true
  })

  assert.equal(result.insufficient, false)
  assert.equal(result.usesAutoRefill, true)
  // The figure stays the slot's own: what sits in front of the user is 40g, and reporting
  // the pool's 70g here would contradict the number printed beside it.
  assert.equal(result.remainGrams, 40)
})

test('does not use AMS auto-refill for the same type when the color differs', () => {
  const tray = makeTray({ remainPercent: 4, color: '#00B7EB', colors: ['#00B7EB'], trayName: 'Cyan' })
  const sibling = makeTray({ remainPercent: 90, color: '#808080', colors: ['#808080'], trayName: 'Gray' })

  const result = getSlotRemainingState({
    tray,
    trays: [tray, sibling],
    ...REQUIREMENT,
    requiredGrams: 40,
    autoRefillEnabled: true
  })

  assert.equal(result.insufficient, true)
  assert.equal(result.usesAutoRefill, false)
})

test('does not use AMS auto-refill for the same type and color when the preset differs', () => {
  const tray = makeTray({ remainPercent: 4, trayInfoIdx: 'GFA01', trayName: 'Cyan' })
  const sibling = makeTray({ remainPercent: 90, trayInfoIdx: 'GFB99', trayName: 'Cyan' })

  const result = getSlotRemainingState({
    tray,
    trays: [tray, sibling],
    ...REQUIREMENT,
    requiredGrams: 40,
    autoRefillEnabled: true
  })

  assert.equal(result.insufficient, true)
  assert.equal(result.usesAutoRefill, false)
})

test('stays insufficient when matching AMS trays still do not add up enough', () => {
  const tray = makeTray({ remainPercent: 2 })
  const sibling = makeTray({ remainPercent: 1 })

  const result = getSlotRemainingState({
    tray,
    trays: [tray, sibling],
    ...REQUIREMENT,
    requiredGrams: 30,
    autoRefillEnabled: true
  })

  assert.equal(result.insufficient, true)
  assert.equal(result.usesAutoRefill, true)
})

test('does not treat external spools as auto-refill candidates', () => {
  const tray = makeTray({ kind: 'external', remainPercent: 4 })
  const matchingAms = makeTray({ remainPercent: 90 })

  const result = getSlotRemainingState({
    tray,
    trays: [tray, matchingAms],
    ...REQUIREMENT,
    requiredGrams: 30,
    autoRefillEnabled: true
  })

  assert.equal(result.insufficient, true)
  assert.equal(result.usesAutoRefill, false)
})

test('two manually-set spools that match each other still pool for auto-refill', () => {
  // The reported bug: auto-refill appeared to work only for Bambu RFID spools. Nothing about
  // the printer's chaining depends on RFID, it matches on the declared preset, which the AMS
  // dialog writes for a hand-set spool too, so the badge must appear with no tag in sight.
  const tray = makeManualTray()
  const sibling = makeManualTray()

  const result = getSlotRemainingState({
    tray,
    trays: [tray, sibling],
    ...REQUIREMENT,
    requiredGrams: 200,
    autoRefillEnabled: true
  })

  assert.equal(result.usesAutoRefill, true)
  // Nothing about either spool is measurable, so it is unknown, never "empty".
  assert.equal(result.insufficient, false)
  assert.equal(result.remainGrams, null)
})

test('does not believe a percent reported for a spool with no RFID tag', () => {
  // Firmware sends `remain: -1` for an unmeasurable spool. It used to be clamped to 0, which
  // made every manually-set slot read as an empty spool that could not finish anything.
  const tray = makeManualTray({ remainPercent: 0 })

  const result = getSlotRemainingState({
    tray,
    trays: [tray],
    ...REQUIREMENT,
    requiredGrams: 30,
    autoRefillEnabled: false
  })

  assert.equal(result.insufficient, false)
})

test('a tracked spool makes a manually-set slot gradeable, and pools on tracked grams', () => {
  const tray = makeManualTray({ remainingGrams: 60 })
  const sibling = makeManualTray({ remainingGrams: 400 })

  const alone = getSlotRemainingState({
    tray,
    trays: [tray],
    ...REQUIREMENT,
    requiredGrams: 200,
    autoRefillEnabled: false
  })
  assert.equal(alone.insufficient, true)

  const pooled = getSlotRemainingState({
    tray,
    trays: [tray, sibling],
    ...REQUIREMENT,
    requiredGrams: 200,
    autoRefillEnabled: true
  })
  assert.equal(pooled.insufficient, false)
  assert.equal(pooled.usesAutoRefill, true)
})

test('flags the refill pool even when the plate never states its usage', () => {
  // The badge answers "is this slot backed up", which does not depend on knowing what the
  // print will consume. Bailing out early on a missing gram figure hid it on every plate
  // whose filament had no stated usage.
  const tray = makeTray()
  const sibling = makeTray()

  const result = getSlotRemainingState({
    tray,
    trays: [tray, sibling],
    ...REQUIREMENT,
    requiredGrams: null,
    autoRefillEnabled: true
  })

  assert.equal(result.usesAutoRefill, true)
  assert.equal(result.insufficient, false)
})
