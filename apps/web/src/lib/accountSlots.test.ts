/**
 * The account scope has more than one host, and only one of them was ever
 * exercised. Account -> Messages linked to `/account/messages` from
 * `/platform/account`, which matches no route, and the router's catch-all sent
 * the click to the home page rather than failing, so these assertions are
 * about the PREFIX, which is the part that silently went missing.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ACCOUNT_MESSAGES_SUBPATH, buildAccountPath } from './accountSlots'

test('buildAccountPath keeps a workspace link inside the workspace being viewed', () => {
  assert.equal(buildAccountPath('/workspaces/acme/printers'), '/workspaces/acme/account')
  assert.equal(
    buildAccountPath('/workspaces/acme/account', ACCOUNT_MESSAGES_SUBPATH),
    '/workspaces/acme/account/messages'
  )
})

test('buildAccountPath keeps a platform link at the platform', () => {
  assert.equal(buildAccountPath('/platform/account'), '/platform/account')
  // The regression: this used to return '/account/messages', which is routed
  // nowhere, so the catch-all redirected the operator to the home page.
  assert.equal(
    buildAccountPath('/platform/account', ACCOUNT_MESSAGES_SUBPATH),
    '/platform/account/messages'
  )
  assert.equal(
    buildAccountPath('/platform/customers', ACCOUNT_MESSAGES_SUBPATH),
    '/platform/account/messages'
  )
})

test('buildAccountPath falls back to the bare account path off both hosts', () => {
  assert.equal(buildAccountPath('/billing/cus_1', ACCOUNT_MESSAGES_SUBPATH), '/account/messages')
})
