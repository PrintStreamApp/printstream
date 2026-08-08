/**
 * The updates entitlement, and its fail-OPEN posture.
 *
 * The rule this guards is a product promise: a lapsed updates window must never
 * stop the app or lock data away. It only withholds newer builds. Every path
 * that cannot answer confidently therefore has to answer "entitled" — a
 * transient DB error must not look identical to an expired addon.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LicenseStatus } from '@printstream/shared'
import { areUpdatesEntitled, describeUpdateBlock } from './license-entitlements.js'

function status(overrides: Partial<LicenseStatus> = {}): LicenseStatus {
  return {
    edition: 'commercial',
    licensee: 'Acme Corp',
    valid: true,
    expired: false,
    expiresAt: null,
    updatesExpired: false,
    updatesUntil: 1_800_000_000,
    maxPrinters: null,
    metered: false,
    ...overrides
  }
}

const reading = (value: LicenseStatus) => async () => value

test('a live updates window is entitled', async () => {
  assert.equal(await areUpdatesEntitled(reading(status())), true)
  assert.equal(await describeUpdateBlock(reading(status())), null)
})

test('a lapsed window is the ONLY thing that withholds updates', async () => {
  const lapsed = reading(status({ updatesExpired: true }))
  assert.equal(await areUpdatesEntitled(lapsed), false)

  const reason = await describeUpdateBlock(lapsed)
  assert.ok(reason, 'a blocked update must explain itself')
  assert.match(reason, /keeps running/i, 'the message must say the current build still works')
})

test('a community key is entitled — perpetual, with no window to lapse', async () => {
  assert.equal(await areUpdatesEntitled(reading(status({ edition: 'community', updatesUntil: null }))), true)
})

test('an unlicensed install is entitled, not blocked', async () => {
  // Enforcement decides whether an unlicensed install may RUN. Withholding
  // updates from it as well would punish the same state twice.
  assert.equal(await areUpdatesEntitled(reading(status({ valid: false, edition: null }))), true)
})

test('an unreadable license fails OPEN', async () => {
  // A transient DB error must never be mistaken for an expired addon: shipping
  // a build to someone whose addon lapsed an hour ago is a far smaller failure
  // than freezing a paying customer out of updates over a blip.
  const broken = async (): Promise<LicenseStatus> => { throw new Error('db is down') }
  assert.equal(await areUpdatesEntitled(broken), true)
  assert.equal(await describeUpdateBlock(broken), null)
})
