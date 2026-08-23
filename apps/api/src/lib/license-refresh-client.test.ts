/**
 * Who is allowed to phone home, and when.
 *
 * This predicate IS the self-hosted privacy promise, stated publicly in the
 * marketing FAQ: a perpetual key makes no automatic request to us, so an
 * air-gapped install stays silent. It is also what lets a Lifetime owner
 * collect a renewed updates window, which is a signed field the install cannot
 * learn any other way. The two pull in opposite directions, so the boundary is
 * worth pinning: widening it by accident would turn a documented "we never
 * contact you" into a daily beacon.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldContactVendor } from './license-refresh-client.js'

const subscription = { expiresAt: 1_800_000_000, updatesUntil: 1_800_000_000, edition: 'commercial', valid: true }
const lifetime = { expiresAt: null, updatesUntil: 1_800_000_000, edition: 'commercial', valid: true }
const community = { expiresAt: null, updatesUntil: null, edition: 'community', valid: true }
const unlicensed = { expiresAt: null, updatesUntil: null, edition: null, valid: false }

test('a subscription key refreshes on the timer, its run window depends on it', () => {
  assert.equal(shouldContactVendor(subscription, false), true)
  assert.equal(shouldContactVendor(subscription, true), true)
})

test('a Lifetime key is SILENT on the timer but may be refreshed by hand', () => {
  // The whole point: no unprompted request (the air-gapped promise), but a
  // person who has just paid for a renewal can still go and get it.
  assert.equal(shouldContactVendor(lifetime, false), false)
  assert.equal(shouldContactVendor(lifetime, true), true)
})

test('a community key never contacts us, even when asked', () => {
  // Perpetual with no updates window: there is nothing that could have changed,
  // so a request would be a beacon with no purpose. The FAQ says exactly this.
  assert.equal(shouldContactVendor(community, false), false)
  assert.equal(shouldContactVendor(community, true), false)
})

test('an install with no valid key never contacts us', () => {
  assert.equal(shouldContactVendor(unlicensed, false), false)
  assert.equal(shouldContactVendor(unlicensed, true), false)
})
