import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeNativeLicenseMode, NATIVE_EVALUATION_DAYS } from './license-enforcement.js'

const DAY_MS = 24 * 60 * 60 * 1000
const firstRunAt = new Date('2026-07-01T00:00:00Z')

test('non-native installs are always unrestricted', () => {
  const result = computeNativeLicenseMode({ native: false, commercialLicensed: false, firstRunAt, now: new Date(firstRunAt.getTime() + 400 * DAY_MS) })
  assert.deepEqual(result, { mode: 'unrestricted', graceEndsAt: null })
})

test('a commercial license unlocks native fully, regardless of age', () => {
  const result = computeNativeLicenseMode({ native: true, commercialLicensed: true, firstRunAt, now: new Date(firstRunAt.getTime() + 400 * DAY_MS) })
  assert.deepEqual(result, { mode: 'unrestricted', graceEndsAt: null })
})

test('native without a commercial license runs an evaluation window, then limits', () => {
  const insideGrace = computeNativeLicenseMode({
    native: true,
    commercialLicensed: false,
    firstRunAt,
    now: new Date(firstRunAt.getTime() + (NATIVE_EVALUATION_DAYS - 1) * DAY_MS)
  })
  assert.equal(insideGrace.mode, 'evaluation')
  assert.equal(insideGrace.graceEndsAt?.getTime(), firstRunAt.getTime() + NATIVE_EVALUATION_DAYS * DAY_MS)

  const pastGrace = computeNativeLicenseMode({
    native: true,
    commercialLicensed: false,
    firstRunAt,
    now: new Date(firstRunAt.getTime() + (NATIVE_EVALUATION_DAYS + 1) * DAY_MS)
  })
  assert.equal(pastGrace.mode, 'limited')
})

test('a community key does not satisfy native enforcement (commercialLicensed=false)', () => {
  // The caller maps edition==='community' to commercialLicensed=false; past the
  // window that means limited — community covers the Docker build only.
  const result = computeNativeLicenseMode({
    native: true,
    commercialLicensed: false,
    firstRunAt,
    now: new Date(firstRunAt.getTime() + (NATIVE_EVALUATION_DAYS + 30) * DAY_MS)
  })
  assert.equal(result.mode, 'limited')
})
