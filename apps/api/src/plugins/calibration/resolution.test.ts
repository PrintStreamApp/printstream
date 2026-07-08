import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveCalibrationValue, type ResolvableCalibrationResult } from './resolution.js'

const identity = (over: Partial<ResolvableCalibrationResult>): ResolvableCalibrationResult => ({
  kind: 'pressureAdvance',
  value: 0,
  scope: 'identity',
  spoolId: null,
  brand: null,
  filamentType: null,
  materialSubtype: null,
  colorName: null,
  ...over
})

const polymakerSilver = {
  spoolId: 'spool-1',
  brand: 'Polymaker',
  filamentType: 'PLA',
  materialSubtype: 'PLA Pro',
  colorName: 'Metallic Silver'
}

test('a spool-specific result beats any identity match', () => {
  const candidates = [
    identity({ value: 0.02, brand: 'Polymaker', filamentType: 'PLA', materialSubtype: 'PLA Pro' }),
    { ...identity({ value: 0.035 }), scope: 'spool' as const, spoolId: 'spool-1' }
  ]
  const picked = resolveCalibrationValue(candidates, polymakerSilver)
  assert.equal(picked?.value, 0.035)
})

test('the most specific identity match wins', () => {
  const candidates = [
    identity({ value: 0.02, brand: 'Polymaker' }),
    identity({ value: 0.028, brand: 'Polymaker', filamentType: 'PLA', materialSubtype: 'PLA Pro' }),
    identity({ value: 0.025, brand: 'Polymaker', filamentType: 'PLA' })
  ]
  const picked = resolveCalibrationValue(candidates, polymakerSilver)
  assert.equal(picked?.value, 0.028)
})

test('a non-matching identity field disqualifies the result', () => {
  const candidates = [identity({ value: 0.02, brand: 'Bambu', filamentType: 'PLA' })]
  assert.equal(resolveCalibrationValue(candidates, polymakerSilver), null)
})

test('a spool-scoped result for a different spool is ignored', () => {
  const candidates = [{ ...identity({ value: 0.05 }), scope: 'spool' as const, spoolId: 'other-spool' }]
  assert.equal(resolveCalibrationValue(candidates, polymakerSilver), null)
})

test('identity match applies across printers of the same model (no spool needed)', () => {
  const candidates = [identity({ value: 0.022, brand: 'Polymaker', filamentType: 'PLA', materialSubtype: 'PLA Pro' })]
  // A fresh roll (no spool id / different spool) still matches on identity.
  const freshRoll = { ...polymakerSilver, spoolId: null }
  assert.equal(resolveCalibrationValue(candidates, freshRoll)?.value, 0.022)
})
