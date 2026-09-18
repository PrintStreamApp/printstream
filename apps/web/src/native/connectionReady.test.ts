import assert from 'node:assert/strict'
import test from 'node:test'
import { isNativeConnectionReady } from './connectionReady'

test('only confirmed access makes a connection resumable', () => {
  const state = { ready: true, actorType: 'anonymous', selfHosted: false, authEnabled: true, setupRequired: false, hasWorkspace: false }
  assert.equal(isNativeConnectionReady(state), false)
  assert.equal(isNativeConnectionReady({ ...state, actorType: 'user' }), true)
  assert.equal(isNativeConnectionReady({ ...state, actorType: 'user', ready: false }), false)
  assert.equal(isNativeConnectionReady({ ...state, actorType: 'user', setupRequired: true }), false)
  assert.equal(isNativeConnectionReady({ ...state, selfHosted: true, authEnabled: false, hasWorkspace: true }), true)
  assert.equal(isNativeConnectionReady({ ...state, selfHosted: true, authEnabled: false }), false)
  assert.equal(isNativeConnectionReady({ ...state, authEnabled: false, hasWorkspace: true }), false)
  assert.equal(isNativeConnectionReady({ ...state, actorType: 'service-account' }), false)
  assert.equal(isNativeConnectionReady({ ...state, actorType: 'demo' }), false)
  assert.equal(isNativeConnectionReady({ ...state, selfHosted: true, hasWorkspace: true }), false)
})
