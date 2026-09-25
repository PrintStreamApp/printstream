import assert from 'node:assert/strict'
import test from 'node:test'
import { canUseSuggestions, hasInAppSupport, inAppSupportUnavailabilityReason, type LicenseStatus } from './license.js'

const current: LicenseStatus = {
  edition: 'commercial',
  licensee: 'Workshop',
  valid: true,
  expired: false,
  expiresAt: null,
  updatesExpired: false,
  updatesUntil: 2_000_000_000,
  maxPrinters: null,
  metered: false
}

test('Help needs commercial support; Suggestions uses only key validity', () => {
  for (const status of [
    { ...current, edition: 'community' as const, updatesUntil: null },
    { ...current, updatesExpired: true }
  ]) {
    assert.equal(hasInAppSupport(status), false)
    assert.equal(canUseSuggestions(status), true)
    assert.ok(inAppSupportUnavailabilityReason(status))
  }
  assert.equal(hasInAppSupport(current), true)
  assert.equal(inAppSupportUnavailabilityReason(current), null)
  assert.equal(hasInAppSupport({ ...current, updatesUntil: null }), true)
  assert.equal(canUseSuggestions({ ...current, valid: false }), false)
})
