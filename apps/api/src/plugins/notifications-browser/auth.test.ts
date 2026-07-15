process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import { withBrowserNotificationsApp } from './test-harness.js'
import { WebPushDelivery } from './push.js'

test.afterEach(() => {
  mock.restoreAll()
})

test('browser notification settings require authentication once auth is enabled', async () => {
  await withBrowserNotificationsApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/notifications-browser`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('browser notification subscriptions return 403 without settings.manage permission', async () => {
  await withBrowserNotificationsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.test/subscription',
          keys: {
            p256dh: 'p256dh-key',
            auth: 'auth-key'
          }
        }
      })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('browser notification subscriptions can be managed by settings managers', async () => {
  await withBrowserNotificationsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const readResponse = await fetch(`${baseUrl}/api/plugins/notifications-browser`)
    const readBody = await readResponse.json() as { publicKey: string; subscriptions: number }

    assert.equal(readResponse.status, 200)
    assert.equal(typeof readBody.publicKey, 'string')
    assert.equal(readBody.publicKey.length > 0, true)
    assert.equal(readBody.subscriptions, 0)

    const subscribeResponse = await fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.test/subscription',
          keys: {
            p256dh: 'p256dh-key',
            auth: 'auth-key'
          }
        }
      })
    })

    assert.equal(subscribeResponse.status, 201)
    assert.deepEqual(await subscribeResponse.json(), { subscriptions: 1 })
  })
})

test('browser notification subscriptions reject non-members with settings.manage (support access)', async () => {
  await withBrowserNotificationsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'platform-user-1', isPlatformUser: true },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const subscribeResponse = await fetch(`${baseUrl}/api/plugins/notifications-browser/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.test/subscription',
          keys: {
            p256dh: 'p256dh-key',
            auth: 'auth-key'
          }
        }
      })
    })

    assert.equal(subscribeResponse.status, 403)
    assert.deepEqual(await subscribeResponse.json(), {
      error: 'Browser notifications are only available to workspace members.'
    })

    const readResponse = await fetch(`${baseUrl}/api/plugins/notifications-browser`)
    const readBody = await readResponse.json() as { subscriptions: number }
    assert.equal(readBody.subscriptions, 0)
  }, { tenantMembers: [] })
})

test('browser notification dismissals fan out only to the current actor key', async () => {
  const sendToActor = mock.method(WebPushDelivery.prototype, 'sendToActor', async () => {})

  await withBrowserNotificationsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/notifications-browser/dismissals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationId: 'notification-1', tag: 'printer:printer-1:job' })
    })

    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { ok: true })
  })

  assert.equal(sendToActor.mock.callCount(), 1)
  assert.equal(sendToActor.mock.calls[0]?.arguments[0], 'user:user-1')
  assert.deepEqual(sendToActor.mock.calls[0]?.arguments[1], {
    type: 'dismiss',
    notificationId: 'notification-1',
    tag: 'printer:printer-1:job'
  })
})

test('browser notification dismissals validate their payload', async () => {
  await withBrowserNotificationsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/notifications-browser/dismissals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'Invalid dismissal payload' })
  })
})
