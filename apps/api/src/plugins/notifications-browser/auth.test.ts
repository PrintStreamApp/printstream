process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import type { RequestAuthContext } from '../../lib/auth-context.js'
import { HttpError } from '../../lib/http-error.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { notificationsBrowserPlugin } from './index.js'
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

async function withBrowserNotificationsApp(
  auth: RequestAuthContext,
  run: (context: { baseUrl: string }) => Promise<void>,
  options: { tenantMembers?: string[] } = {}
): Promise<void> {
  const memberIds = new Set(
    options.tenantMembers ?? (auth.actor.type === 'user' ? [auth.actor.userId] : [])
  )
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = auth
    request.tenant = { id: 'test-tenant', slug: 'test', name: 'Test Tenant' }
    next()
  })

  const router = express.Router()
  app.use('/api/plugins/notifications-browser', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  const settings = new Map<string, string>()
  await notificationsBrowserPlugin.register({
    pluginName: 'notifications-browser',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      authTenantMembership: {
        async findFirst({ where }: { where: { userId: string } }) {
          return memberIds.has(where.userId) ? { userId: where.userId } : null
        },
        async findMany({ where }: { where: { userId: { in: string[] } } }) {
          return where.userId.in.filter((userId) => memberIds.has(userId)).map((userId) => ({ userId }))
        }
      }
    } as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast() {} } as never,
    router,
    settings: {
      async get(key) { return settings.get(key) ?? null },
      async set(key, value) { settings.set(key, value) },
      async delete(key) { settings.delete(key) },
      forTenant(tenantId: string) {
        const prefix = `tenant:${tenantId}:`
        return {
          async get(key: string) { return settings.get(prefix + key) ?? null },
          async set(key: string, value: string) { settings.set(prefix + key, value) },
          async delete(key: string) { settings.delete(prefix + key) },
          forTenant(): never { throw new Error('nested forTenant not supported') }
        }
      }
    },
    onShutdown() {},
    registerPrintGuard() { return () => undefined },
    registerSlotFilamentResolver() { return () => undefined },
    registerAuthProvider() { return () => undefined }
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    await run({ baseUrl })
  } finally {
    await close(server)
  }
}

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}