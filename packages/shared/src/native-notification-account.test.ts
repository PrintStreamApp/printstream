import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeNotificationAccount, type NativeNotificationIdentity } from './native-notification-account.js'

const anonymous: NativeNotificationIdentity = {
  actor: { type: 'anonymous' }, authEnabled: false,
  workspace: { id: 'workshop' }, runtimePolicy: { selfHosted: true, demoMode: false }
}

test('auth-disabled device identity is confined to a self-hosted workspace', () => {
  assert.equal(nativeNotificationAccount(anonymous), 'anonymous:workshop')
  assert.equal(nativeNotificationAccount({ ...anonymous, authEnabled: true }), null)
  assert.equal(nativeNotificationAccount({ ...anonymous, workspace: null }), null)
  assert.equal(nativeNotificationAccount({ ...anonymous, runtimePolicy: { selfHosted: false } }), null)
  assert.equal(nativeNotificationAccount({ ...anonymous, runtimePolicy: { selfHosted: true, demoMode: true } }), null)
  assert.equal(nativeNotificationAccount({ ...anonymous, actor: { type: 'service-account' } }), null)
  assert.equal(nativeNotificationAccount({ ...anonymous, actor: { type: 'user', userId: 'person' } }), 'person')
})
