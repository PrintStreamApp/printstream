import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { canSendUserInvites, registerUserInviteSender, sendUserSignInInvite } from './user-invites.js'

afterEach(() => registerUserInviteSender(null))

const REQUEST = { userId: 'user-1', email: 'them@example.com' }

test('sendUserSignInInvite reports false with no provider registered', async () => {
  // The public/self-hosted shape, and the state before the auth provider
  // activates. Callers show this to the operator rather than claiming an email
  // went out, so it must not be indistinguishable from success.
  assert.equal(canSendUserInvites(), false)
  assert.equal(await sendUserSignInInvite(REQUEST), false)
})

test('sendUserSignInInvite passes the request through and reports success', async () => {
  const seen: unknown[] = []
  registerUserInviteSender(async (request) => { seen.push(request) })

  assert.equal(canSendUserInvites(), true)
  assert.equal(await sendUserSignInInvite({ ...REQUEST, redirectTo: '/account' }), true)
  assert.deepEqual(seen, [{ userId: 'user-1', email: 'them@example.com', redirectTo: '/account' }])
})

test('sendUserSignInInvite swallows a failing sender rather than failing the caller', async () => {
  // The contract the invite route depends on: by the time this runs the person
  // and every membership already exist, so a throwing mail host must not unwind
  // them. It reports false instead, and the caller offers a re-send.
  registerUserInviteSender(async () => { throw new Error('smtp is down') })

  assert.equal(await sendUserSignInInvite(REQUEST), false)
})

test('registering null takes the sender back out', async () => {
  // What plugin shutdown does. A deactivated provider must stop claiming it can
  // invite, or the UI offers a button that silently does nothing.
  registerUserInviteSender(async () => undefined)
  assert.equal(canSendUserInvites(), true)
  registerUserInviteSender(null)
  assert.equal(canSendUserInvites(), false)
  assert.equal(await sendUserSignInInvite(REQUEST), false)
})
