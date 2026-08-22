import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isBambuCredentialDueForRenewal } from './index.js'

const DAY = 86_400_000

test('a fresh credential is not renewed', () => {
  const issued = Date.now()
  const expires = issued + 90 * DAY
  assert.equal(isBambuCredentialDueForRenewal(new Date(issued).toISOString(), expires, issued + DAY), false)
})

test('renewal happens with most of the window still to spare', () => {
  // Measured on a live account: Bambu expires the access token and the refresh token at
  // the SAME instant, 90 days out. So renewal cannot wait until the access token is
  // nearly dead — the refresh token would be nearly dead too, and a single missed window
  // (server down, workspace paused) costs a full password + 2FA sign-in.
  const issued = Date.now()
  const expires = issued + 90 * DAY

  assert.equal(isBambuCredentialDueForRenewal(new Date(issued).toISOString(), expires, issued + 60 * DAY), false)
  assert.equal(isBambuCredentialDueForRenewal(new Date(issued).toISOString(), expires, issued + 68 * DAY), true)

  // The margin left at the moment it first becomes due, which is the number that matters.
  const dueAt = issued + 90 * DAY * 0.75
  assert.ok((expires - dueAt) / DAY >= 20, 'renewal must leave weeks of slack, not hours')
})

test('the rule scales to a short-lived token instead of renewing constantly', () => {
  // A fixed lead would make an hour-long token permanently "due", i.e. a call every tick.
  const issued = Date.now()
  const expires = issued + 60 * 60_000

  assert.equal(isBambuCredentialDueForRenewal(new Date(issued).toISOString(), expires, issued + 30 * 60_000), false)
  assert.equal(isBambuCredentialDueForRenewal(new Date(issued).toISOString(), expires, issued + 50 * 60_000), true)
})

test('a credential with no known issue time still renews eventually', () => {
  // Connections stored before `issuedAt` existed: no lifetime to take a fraction of, so
  // fall back to a short lead rather than never renewing at all.
  const now = Date.now()
  assert.equal(isBambuCredentialDueForRenewal(null, now + 30 * DAY, now), false)
  assert.equal(isBambuCredentialDueForRenewal(null, now + 60_000, now), true)
  assert.equal(isBambuCredentialDueForRenewal(undefined, now + 60_000, now), true)
})

test('a nonsensical issue time does not make a credential permanently due', () => {
  const now = Date.now()
  // issuedAt after expiresAt (clock skew, bad data) must not read as "100% elapsed".
  assert.equal(isBambuCredentialDueForRenewal(new Date(now + 10 * DAY).toISOString(), now + DAY, now), false)
  assert.equal(isBambuCredentialDueForRenewal('not-a-date', now + 30 * DAY, now), false)
})
