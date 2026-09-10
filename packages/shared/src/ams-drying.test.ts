import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AMS_DRYING_FILAMENT_TYPES,
  amsDryingTemperatureRange,
  assessAmsDryingRisk,
  clampDryingTemperature,
  defaultAmsDryingProfile,
  dryingPresetForFilament,
  formatAmsDryingRiskLabel,
  maxSafeAmsDryingTemperature,
  normalizeAmsDryingFilamentType,
  recommendedAmsDryingDurationHours,
  recommendedAmsDryingTemperature,
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
  assert.deepEqual(dryingPresetForFilament('PLA'), {
    temperature: 45, printingTemperature: 45, durationHours: 12, coolingTemp: 45
  })
  // TPU carries an AMS 2 Pro duration because Bambu's differs there (12h against the HT's 18h);
  // PLA above carries none, because Bambu gives it one figure for both.
  assert.deepEqual(dryingPresetForFilament('TPU'), {
    temperature: 75, printingTemperature: 45, durationHours: 18, amsProDurationHours: 12, coolingTemp: 40
  })
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

test('drying mid-print suggests Bambu\'s lower printing temperature', () => {
  // The eight materials whose printing column differs from their idle one. TPU is the extreme:
  // 75C idle, 45C while printing, and its heat-distortion point is 45C.
  assert.equal(recommendedAmsDryingTemperature('TPU', { printing: true }), 45)
  assert.equal(recommendedAmsDryingTemperature('PETG', { printing: true }), 55)
  assert.equal(recommendedAmsDryingTemperature('PVA', { printing: true }), 70)
  assert.equal(recommendedAmsDryingTemperature('BVOH', { printing: true }), 45)
  assert.equal(recommendedAmsDryingTemperature('PP', { printing: true }), 50)
  assert.equal(recommendedAmsDryingTemperature('ABS', { printing: true }), 75)
  assert.equal(recommendedAmsDryingTemperature('HIPS', { printing: true }), 75)
  assert.equal(recommendedAmsDryingTemperature('SUPPORT', { printing: true }), 50)

  // Materials Bambu does NOT lower must not be lowered here either.
  for (const type of ['PLA', 'ASA', 'PA', 'PC', 'PE', 'PET-CF', 'PPS']) {
    assert.equal(
      recommendedAmsDryingTemperature(type, { printing: true }),
      dryingPresetForFilament(type).temperature,
      `${type} should keep its idle temperature while printing`
    )
  }
})

test('the idle suggestion is unchanged by the printing-state work', () => {
  for (const type of ['PLA', 'PETG', 'TPU', 'PVA', 'ABS', 'BVOH', 'SUPPORT']) {
    assert.equal(recommendedAmsDryingTemperature(type), dryingPresetForFilament(type).temperature)
    assert.equal(recommendedAmsDryingTemperature(type, { printing: false }), dryingPresetForFilament(type).temperature)
  }
})

test('a printing suggestion never exceeds the material heat-distortion point', () => {
  // Studio clamps its printing value by softening and heat-distortion. On Bambu's current data the
  // clamp never binds, so this asserts the invariant rather than a specific number: if a future
  // vendored value rises above the limit, the suggestion must come down, not the limit go up.
  for (const type of AMS_DRYING_FILAMENT_TYPES) {
    assert.ok(
      recommendedAmsDryingTemperature(type, { printing: true }) <= maxSafeAmsDryingTemperature(type),
      `${type} printing suggestion exceeds its heat-distortion limit`
    )
  }
})

test('defaultAmsDryingProfile ranks the safest material by the printing figure while printing', () => {
  // PETG (65 idle / 55 printing) and ABS (80 / 75) loaded together on an AMS HT. PETG is the
  // safest either way, but the number offered has to be the printing one.
  const unit = {
    unitId: 0,
    type: 'ams-ht',
    supportDrying: true,
    slots: [
      { slot: 0, filamentType: 'PETG', occupied: true },
      { slot: 1, filamentType: 'ABS', occupied: true }
    ]
  } as unknown as Parameters<typeof defaultAmsDryingProfile>[0]

  assert.equal(defaultAmsDryingProfile(unit).temperature, 65)
  assert.equal(defaultAmsDryingProfile(unit, { printing: true }).temperature, 55)
  assert.equal(defaultAmsDryingProfile(unit, { printing: true }).filamentType, 'PETG')
  // The duration is the same in both states; Bambu's time array does not vary by printer state.
  assert.equal(
    defaultAmsDryingProfile(unit, { printing: true }).durationHours,
    defaultAmsDryingProfile(unit).durationHours
  )
})

test('the printing suggestion is clamped into the AMS 2 Pro band like the idle one', () => {
  const unit = {
    unitId: 0,
    type: 'ams-2-pro',
    supportDrying: true,
    slots: [{ slot: 0, filamentType: 'PA', occupied: true }]
  } as unknown as Parameters<typeof defaultAmsDryingProfile>[0]

  // PA is 85C in both columns; the AMS 2 Pro heater stops at 65, which is also Bambu's own
  // N3F figure for it.
  assert.equal(defaultAmsDryingProfile(unit).temperature, 65)
  assert.equal(defaultAmsDryingProfile(unit, { printing: true }).temperature, 65)
})

test('the drying duration follows the hardware, in BOTH directions', () => {
  // Not a monotonic rule, which is why the figures are stored rather than derived: the cooler AMS
  // 2 Pro takes LONGER for ABS/ASA/PC and SHORTER for TPU/PVA.
  assert.equal(recommendedAmsDryingDurationHours('ABS', 'ams-ht'), 8)
  assert.equal(recommendedAmsDryingDurationHours('ABS', 'ams-2-pro'), 12)
  assert.equal(recommendedAmsDryingDurationHours('PC', 'ams-2-pro'), 12)
  assert.equal(recommendedAmsDryingDurationHours('TPU', 'ams-ht'), 18)
  assert.equal(recommendedAmsDryingDurationHours('TPU', 'ams-2-pro'), 12)
  assert.equal(recommendedAmsDryingDurationHours('PVA', 'ams-2-pro'), 12)

  // A material Bambu gives one figure for reads the same on both.
  for (const type of ['PLA', 'PETG', 'PA', 'BVOH', 'HIPS', 'PP']) {
    assert.equal(
      recommendedAmsDryingDurationHours(type, 'ams-2-pro'),
      recommendedAmsDryingDurationHours(type, 'ams-ht'),
      `${type} should not vary by hardware`
    )
  }

  // An unknown unit type gets the conservative AMS 2 Pro answer, like the temperature band does.
  assert.equal(recommendedAmsDryingDurationHours('ABS', 'ams'), 12)
})

test('defaultAmsDryingProfile pairs the hardware temperature with the hardware duration', () => {
  const abs = (type: 'ams-ht' | 'ams-2-pro') => ({
    unitId: 0,
    type,
    supportDrying: true,
    slots: [{ slot: 0, filamentType: 'ABS', occupied: true }]
  } as unknown as Parameters<typeof defaultAmsDryingProfile>[0])

  // The pairing is the point: an AMS 2 Pro used to be offered Bambu's 65C with the 85C machine's
  // 8h runtime, which is neither of Bambu's two recommendations.
  assert.deepEqual(
    { t: defaultAmsDryingProfile(abs('ams-ht')).temperature, h: defaultAmsDryingProfile(abs('ams-ht')).durationHours },
    { t: 80, h: 8 }
  )
  assert.deepEqual(
    { t: defaultAmsDryingProfile(abs('ams-2-pro')).temperature, h: defaultAmsDryingProfile(abs('ams-2-pro')).durationHours },
    { t: 65, h: 12 }
  )
})
