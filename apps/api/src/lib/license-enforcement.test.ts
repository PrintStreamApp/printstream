import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LicenseStatus } from '@printstream/shared'
import {
  computeLicenseMode,
  licenseSatisfies,
  NATIVE_EVALUATION_DAYS,
  SELF_HOSTED_GRACE_DAYS
} from './license-enforcement.js'

const DAY_MS = 24 * 60 * 60 * 1000
const firstRunAt = new Date('2026-07-01T00:00:00Z')

function status(overrides: Partial<LicenseStatus> = {}): LicenseStatus {
  return {
    edition: 'commercial',
    licensee: 'Acme Corp',
    valid: true,
    expired: false,
    expiresAt: null,
    updatesExpired: false,
    updatesUntil: null,
    maxPrinters: null,
    ...overrides
  }
}

test('the cloud is never enforced, however old the install', () => {
  const result = computeLicenseMode({
    enforced: false,
    native: false,
    licensed: false,
    firstRunAt,
    now: new Date(firstRunAt.getTime() + 400 * DAY_MS)
  })
  assert.deepEqual(result, { mode: 'unrestricted', graceEndsAt: null })
})

test('a satisfying license unlocks fully, regardless of age', () => {
  const result = computeLicenseMode({
    enforced: true,
    native: true,
    licensed: true,
    firstRunAt,
    now: new Date(firstRunAt.getTime() + 400 * DAY_MS)
  })
  assert.deepEqual(result, { mode: 'unrestricted', graceEndsAt: null })
})

test('native runs a 14-day evaluation window, then limits', () => {
  const insideGrace = computeLicenseMode({
    enforced: true,
    native: true,
    licensed: false,
    firstRunAt,
    now: new Date(firstRunAt.getTime() + (NATIVE_EVALUATION_DAYS - 1) * DAY_MS)
  })
  assert.equal(insideGrace.mode, 'evaluation')
  assert.equal(insideGrace.graceEndsAt?.getTime(), firstRunAt.getTime() + NATIVE_EVALUATION_DAYS * DAY_MS)

  const pastGrace = computeLicenseMode({
    enforced: true,
    native: true,
    licensed: false,
    firstRunAt,
    now: new Date(firstRunAt.getTime() + (NATIVE_EVALUATION_DAYS + 1) * DAY_MS)
  })
  assert.equal(pastGrace.mode, 'limited')
})

test('Docker/OSS gets the longer grace window — the requirement is new there', () => {
  const stillFine = computeLicenseMode({
    enforced: true,
    native: false,
    licensed: false,
    firstRunAt,
    now: new Date(firstRunAt.getTime() + (NATIVE_EVALUATION_DAYS + 1) * DAY_MS)
  })
  assert.equal(stillFine.mode, 'evaluation')
  assert.equal(stillFine.graceEndsAt?.getTime(), firstRunAt.getTime() + SELF_HOSTED_GRACE_DAYS * DAY_MS)

  const pastGrace = computeLicenseMode({
    enforced: true,
    native: false,
    licensed: false,
    firstRunAt,
    now: new Date(firstRunAt.getTime() + (SELF_HOSTED_GRACE_DAYS + 1) * DAY_MS)
  })
  assert.equal(pastGrace.mode, 'limited')
})

test('a community key clears Docker/OSS but not the native app', () => {
  const community = status({ edition: 'community' })
  assert.equal(licenseSatisfies(community, false), true)
  assert.equal(licenseSatisfies(community, true), false)
})

test('a commercial key clears both builds', () => {
  assert.equal(licenseSatisfies(status(), false), true)
  assert.equal(licenseSatisfies(status(), true), true)
})

test('an expired key satisfies nothing — a lapsed subscription must stop working', () => {
  const lapsed = status({ valid: false, expired: true, expiresAt: 1_700_000_000 })
  assert.equal(licenseSatisfies(lapsed, false), false)
  assert.equal(licenseSatisfies(lapsed, true), false)
})

test('lapsed updates do not affect the right to run', () => {
  const updatesLapsed = status({ updatesExpired: true, updatesUntil: 1_700_000_000 })
  assert.equal(licenseSatisfies(updatesLapsed, true), true)
})

test('an absent key satisfies nothing', () => {
  assert.equal(licenseSatisfies(status({ edition: null, valid: false }), false), false)
})
