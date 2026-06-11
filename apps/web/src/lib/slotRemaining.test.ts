import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getSlotRemainingState, type SlotRemainingTray } from './slotRemaining'

function makeTray(overrides: Partial<SlotRemainingTray> = {}): SlotRemainingTray {
  return {
    kind: overrides.kind ?? 'ams',
    filamentType: overrides.filamentType ?? 'PLA Basic',
    color: overrides.color ?? '#00B7EB',
    colors: overrides.colors ?? ['#00B7EB'],
    trayName: overrides.trayName ?? 'Cyan',
    trayInfoIdx: overrides.trayInfoIdx ?? 'GFA01',
    remainPercent: overrides.remainPercent ?? 10,
    nozzleId: overrides.nozzleId ?? 0
  }
}

test('marks an individual tray insufficient when auto-refill is disabled', () => {
  const tray = makeTray({ remainPercent: 4 })

  const result = getSlotRemainingState({
    tray,
    trays: [tray],
    requiredFilamentType: 'PLA Basic',
    requiredNozzleId: 0,
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
    requiredFilamentType: 'PLA Basic',
    requiredNozzleId: 0,
    requiredGrams: 40,
    autoRefillEnabled: true
  })

  assert.equal(result.insufficient, false)
  assert.equal(result.usesAutoRefill, true)
})

test('does not use AMS auto-refill for the same type when the color differs', () => {
  const tray = makeTray({ remainPercent: 4, color: '#00B7EB', colors: ['#00B7EB'], trayName: 'Cyan' })
  const sibling = makeTray({ remainPercent: 90, color: '#808080', colors: ['#808080'], trayName: 'Gray' })

  const result = getSlotRemainingState({
    tray,
    trays: [tray, sibling],
    requiredFilamentType: 'PLA Basic',
    requiredNozzleId: 0,
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
    requiredFilamentType: 'PLA Basic',
    requiredNozzleId: 0,
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
    requiredFilamentType: 'PLA Basic',
    requiredNozzleId: 0,
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
    requiredFilamentType: 'PLA Basic',
    requiredNozzleId: 0,
    requiredGrams: 30,
    autoRefillEnabled: true
  })

  assert.equal(result.insufficient, true)
  assert.equal(result.usesAutoRefill, false)
})
