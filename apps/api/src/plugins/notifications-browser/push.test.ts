import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebPushDelivery } from './push.js'

test('tenant-scoped delivery loads subscriptions without overriding shared VAPID keys', async () => {
  const settingsStore = new Map<string, string>([
    ['subscriptions', JSON.stringify([{
      endpoint: 'https://push.example.test/subscription',
      keys: {
        p256dh: 'p256dh-key',
        auth: 'auth-key'
      },
      createdAt: '2026-05-11T00:00:00.000Z'
    }])]
  ])

  const delivery = new WebPushDelivery({
    async get(key) { return settingsStore.get(key) ?? null },
    async set(key, value) { settingsStore.set(key, value) },
    async delete(key) { settingsStore.delete(key) },
    forTenant(): never { throw new Error('nested forTenant not supported') }
  }, {
    info() {},
    warn() {},
    error() {}
  })

  delivery.setVapidKeys('server-public', 'server-private', 'mailto:server@example.test')
  await delivery.load({ includeVapid: false })

  assert.equal(delivery.getPublicKey(), 'server-public')
  assert.equal(delivery.getPrivateKey(), 'server-private')
  assert.equal(delivery.getSubject(), 'mailto:server@example.test')
  assert.equal(delivery.size(), 1)
  assert.equal(settingsStore.has('vapidPublicKey'), false)
  assert.equal(settingsStore.has('vapidPrivateKey'), false)
})