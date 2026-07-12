import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  amsDryingTemperatureRange,
  assessAmsDryingRisk,
  clampDryingTemperature,
  defaultAmsDryingProfile,
  dryingPresetForFilament,
  formatAmsDryingRiskLabel,
  maxSafeAmsDryingTemperature,
  normalizeAmsDryingFilamentType,
  validateAmsDryingStart
} from './ams-drying.js'
import type { AmsSlot, AmsUnit } from './printer-contracts.js'

function makeSlot(overrides: Partial<AmsSlot> = {}): AmsSlot {
  return {
    slot: 0,
    trayName: null,
    filamentType: null,
    color: null,
    colors: [],
    remainPercent: null,
    active: false,
    isReading: false,
    occupied: false,
    trayInfoIdx: null,
    caliIdx: null,
    k: null,
    trayUuid: null,
    ...overrides
  }
}

function makeUnit(overrides: Partial<AmsUnit> = {}): AmsUnit {
  return {
    unitId: 0,
    type: 'ams-ht',
    nozzleId: null,
    supportDrying: true,
    dryTimeRemainingMinutes: null,
    dryingActive: false,
    dryingPhase: 'idle',
    dryFilament: null,
    dryTemperature: null,
    dryDurationHours: null,
    humidityPercent: null,
    humidityLevel: null,
    temperature: null,
    slots: [],
    ...overrides
  }
}

test('normalizeAmsDryingFilamentType matches exact, partial, and falls back to PLA', () => {
  assert.equal(normalizeAmsDryingFilamentType('petg'), 'PETG')
  assert.equal(normalizeAmsDryingFilamentType('PLA Matte'), 'PLA')
  assert.equal(normalizeAmsDryingFilamentType('PA-GF'), 'PA')
  assert.equal(normalizeAmsDryingFilamentType('mystery'), 'PLA')
})

test('maxSafeAmsDryingTemperature reflects the Bambu heat-distortion limits', () => {
  assert.equal(maxSafeAmsDryingTemperature('PLA'), 45)
  assert.equal(maxSafeAmsDryingTemperature('TPU'), 45)
  assert.equal(maxSafeAmsDryingTemperature('PETG'), 75)
  assert.equal(maxSafeAmsDryingTemperature('ABS'), 90)
  assert.equal(maxSafeAmsDryingTemperature('ASA'), 100)
  // Unknown materials get the most conservative (PLA) limit.
  assert.equal(maxSafeAmsDryingTemperature('mystery'), 45)
})

test('dryingPresetForFilament carries the official Bambu idle-cycle values', () => {
  assert.deepEqual(dryingPresetForFilament('PLA'), { temperature: 45, durationHours: 12, coolingTemp: 45 })
  assert.deepEqual(dryingPresetForFilament('TPU'), { temperature: 75, durationHours: 18, coolingTemp: 40 })
  assert.equal(dryingPresetForFilament('ABS').temperature, 80)
  // Family variants share the base material's cycle.
  assert.deepEqual(dryingPresetForFilament('PETG-CF'), dryingPresetForFilament('PETG'))
})

test('amsDryingTemperatureRange mirrors the per-hardware heater limits', () => {
  assert.deepEqual(amsDryingTemperatureRange('ams-2-pro'), { min: 45, max: 65 })
  assert.deepEqual(amsDryingTemperatureRange('ams-ht'), { min: 45, max: 85 })
  // Unknown future units get the conservative band.
  assert.deepEqual(amsDryingTemperatureRange('unknown'), { min: 45, max: 65 })
})

test('clampDryingTemperature rounds and clamps into the hardware band', () => {
  const range = { min: 45, max: 65 }
  assert.equal(clampDryingTemperature(80, range), 65)
  assert.equal(clampDryingTemperature(30, range), 45)
  assert.equal(clampDryingTemperature(54.6, range), 55)
})

test('assessAmsDryingRisk flags threaded filament that the temperature would deform', () => {
  const unit = makeUnit({
    slots: [
      makeSlot({ slot: 0, filamentType: 'PETG', occupied: true }),
      makeSlot({ slot: 1, filamentType: 'PLA', occupied: true }),
      makeSlot({ slot: 2, filamentType: 'PLA', occupied: false }),
      makeSlot({ slot: 3 })
    ]
  })
  // 65C dries PETG safely but exceeds PLA's 45C distortion point; only the
  // slot with PLA still threaded is flagged.
  assert.deepEqual(assessAmsDryingRisk(unit, 65), [
    { slot: 1, filamentType: 'PLA', maxSafeTemperature: 45 }
  ])
  assert.deepEqual(assessAmsDryingRisk(unit, 45), [])
  assert.deepEqual(assessAmsDryingRisk(unit, Number.NaN), [])
})

test('assessAmsDryingRisk treats occupied slots with unidentified filament as PLA', () => {
  const unit = makeUnit({
    slots: [makeSlot({ slot: 2, filamentType: null, occupied: true })]
  })
  assert.deepEqual(assessAmsDryingRisk(unit, 55), [
    { slot: 2, filamentType: null, maxSafeTemperature: 45 }
  ])
})

test('assessAmsDryingRisk falls back to the filament type when occupancy is unreported', () => {
  const unit = makeUnit({
    slots: [makeSlot({ slot: 0, filamentType: 'TPU', occupied: undefined })]
  })
  assert.deepEqual(assessAmsDryingRisk(unit, 65), [
    { slot: 0, filamentType: 'TPU', maxSafeTemperature: 45 }
  ])
})

test('formatAmsDryingRiskLabel names the slot the way the AMS grid does', () => {
  assert.equal(
    formatAmsDryingRiskLabel(1, { slot: 2, filamentType: 'PLA', maxSafeTemperature: 45 }),
    'B3 PLA: safe up to 45°C'
  )
  assert.equal(
    formatAmsDryingRiskLabel(0, { slot: 0, filamentType: null, maxSafeTemperature: 45 }),
    'A1 Unidentified filament: safe up to 45°C'
  )
})

test('validateAmsDryingStart rejects units without drying support', () => {
  const unit = makeUnit({ type: 'ams', supportDrying: false })
  assert.equal(validateAmsDryingStart(unit, { temperature: 45, acknowledgeRisks: false }), 'This AMS does not support drying')
})

test('validateAmsDryingStart hard-rejects temperatures outside the hardware band', () => {
  const unit = makeUnit({ type: 'ams-2-pro' })
  assert.match(
    validateAmsDryingStart(unit, { temperature: 80, acknowledgeRisks: true }) ?? '',
    /between 45 and 65/
  )
  assert.equal(validateAmsDryingStart(unit, { temperature: 65, acknowledgeRisks: false }), null)
})

test('validateAmsDryingStart rejects a risky temperature unless the caller acknowledges it', () => {
  const unit = makeUnit({
    slots: [
      makeSlot({ slot: 0, filamentType: 'PETG', occupied: true }),
      makeSlot({ slot: 1, filamentType: 'PLA', occupied: true })
    ]
  })
  const rejection = validateAmsDryingStart(unit, { temperature: 65, acknowledgeRisks: false })
  assert.match(rejection ?? '', /can deform loaded filament/)
  assert.match(rejection ?? '', /A2 PLA: safe up to 45°C/)
  // The acknowledged retry (what the web modal sends after warning) passes.
  assert.equal(validateAmsDryingStart(unit, { temperature: 65, acknowledgeRisks: true }), null)
  // A safe temperature never needed the acknowledgement.
  assert.equal(validateAmsDryingStart(unit, { temperature: 45, acknowledgeRisks: false }), null)
})

test('defaultAmsDryingProfile picks the loaded material with the lowest drying temperature', () => {
  const unit = makeUnit({
    slots: [
      makeSlot({ slot: 0, filamentType: 'PETG', occupied: true }),
      makeSlot({ slot: 1, filamentType: 'PLA', occupied: true })
    ]
  })
  const profile = defaultAmsDryingProfile(unit)
  assert.equal(profile.filamentType, 'PLA')
  assert.equal(profile.temperature, 45)
  assert.equal(profile.durationHours, 12)
})

test('defaultAmsDryingProfile counts occupied unidentified slots as PLA', () => {
  const unit = makeUnit({
    slots: [
      makeSlot({ slot: 0, filamentType: 'PETG', occupied: true }),
      makeSlot({ slot: 1, filamentType: null, occupied: true })
    ]
  })
  assert.equal(defaultAmsDryingProfile(unit).filamentType, 'PLA')
})

test('defaultAmsDryingProfile clamps the preset into the hardware band', () => {
  const unit = makeUnit({
    type: 'ams-2-pro',
    slots: [makeSlot({ slot: 0, filamentType: 'PA', occupied: true })]
  })
  // PA's preset is 85C; an AMS 2 Pro tops out at 65C.
  assert.equal(defaultAmsDryingProfile(unit).temperature, 65)
})

test('defaultAmsDryingProfile carries over reported settings only for the same, still-safe profile', () => {
  const petgOnly = [makeSlot({ slot: 0, filamentType: 'PETG', occupied: true })]
  const carried = defaultAmsDryingProfile(makeUnit({
    slots: petgOnly,
    dryFilament: 'PETG',
    dryTemperature: 60,
    dryDurationHours: 10
  }))
  assert.equal(carried.temperature, 60)
  assert.equal(carried.durationHours, 10)

  // A PLA spool loaded since the last cycle changes the safest profile, so
  // the reported PETG settings no longer apply.
  const invalidated = defaultAmsDryingProfile(makeUnit({
    slots: [...petgOnly, makeSlot({ slot: 1, filamentType: 'PLA', occupied: true })],
    dryFilament: 'PETG',
    dryTemperature: 60,
    dryDurationHours: 10
  }))
  assert.equal(invalidated.filamentType, 'PLA')
  assert.equal(invalidated.temperature, 45)
  assert.equal(invalidated.durationHours, 12)
})

test('defaultAmsDryingProfile falls back to the last dried profile when the unit is empty', () => {
  const unit = makeUnit({ dryFilament: 'PETG' })
  const profile = defaultAmsDryingProfile(unit)
  assert.equal(profile.filamentType, 'PETG')
  assert.equal(profile.temperature, 65)
})
