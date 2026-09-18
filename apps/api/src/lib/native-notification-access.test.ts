/** Both transports must stop anonymous delivery as soon as workspace access policy changes. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Request } from 'express'
import type { ApiPluginContext } from '../plugin/types.js'
import { authProviderRegistry } from './auth-registry.js'
import { env } from './env.js'
import { mayReceiveNativeNotifications, requestNativeNotificationAccount } from './native-notification-access.js'

test('anonymous enrollment and delivery fail closed for cloud, auth, demo, disabled and foreign scopes', async () => {
  const previous = env.SELF_HOSTED
  env.SELF_HOSTED = true
  let enabled = false
  let disabled = false
  let slug = 'workshop'
  const unregister = authProviderRegistry.register(() => ({
    id: 'test-native', label: 'Test', enabled, methods: [], setupRequired: false,
    capabilities: { signIn: false, signOut: false, manageUsers: false, manageServiceAccounts: false, recentVerificationMethods: [] }
  }) as never)
  const context = { prisma: {
    workspace: { findFirst: async () => ({ id: 'workshop', name: 'Workshop', slug }) },
    setting: { findUnique: async () => ({ value: String(disabled) }) }
  } } as unknown as ApiPluginContext
  const request = { workspace: { id: 'workshop' }, auth: {
    actor: { type: 'anonymous' }, authEnabled: false, runtimePolicy: { demoMode: false }
  } } as unknown as Request
  try {
    assert.equal(requestNativeNotificationAccount(request), 'anonymous:workshop')
    assert.equal(await mayReceiveNativeNotifications(context, 'anonymous:workshop', 'workshop'), true)
    assert.equal(await mayReceiveNativeNotifications(context, 'anonymous:foreign', 'workshop'), false)
    assert.equal(await mayReceiveNativeNotifications(context, 'anonymous:workshop', null), false)
    enabled = true
    request.auth.authEnabled = true
    assert.throws(() => requestNativeNotificationAccount(request), { statusCode: 401 })
    assert.equal(await mayReceiveNativeNotifications(context, 'anonymous:workshop', 'workshop'), false)
    enabled = false
    disabled = true
    assert.equal(await mayReceiveNativeNotifications(context, 'anonymous:workshop', 'workshop'), false)
    disabled = false
    slug = 'demo'
    assert.equal(await mayReceiveNativeNotifications(context, 'anonymous:workshop', 'workshop'), false)
    slug = 'workshop'
    env.SELF_HOSTED = false
    assert.equal(await mayReceiveNativeNotifications(context, 'anonymous:workshop', 'workshop'), false)
  } finally {
    unregister()
    env.SELF_HOSTED = previous
  }
})
