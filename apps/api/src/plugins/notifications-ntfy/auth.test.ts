process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import type { RequestAuthContext } from '../../lib/auth-context.js'
import { HttpError } from '../../lib/http-error.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { notificationsNtfyPlugin } from './index.js'

test('ntfy settings require authentication once auth is enabled', async () => {
  await withNtfyApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/notifications-ntfy`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('ntfy settings return 403 without settings.manage permission', async () => {
  await withNtfyApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/notifications-ntfy/recipients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://ntfy.sh/test-topic', audience: 'everyone' })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('ntfy recipients can be listed, added, and removed by settings managers', async () => {
  await withNtfyApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const addResponse = await fetch(`${baseUrl}/api/plugins/notifications-ntfy/recipients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://ntfy.sh/test-topic', label: 'Shop topic', audience: 'everyone' })
    })
    assert.equal(addResponse.status, 201)

    const readResponse = await fetch(`${baseUrl}/api/plugins/notifications-ntfy`)
    assert.equal(readResponse.status, 200)
    const read = await readResponse.json() as {
      configured: boolean
      recipients: Array<{ id: string; label: string; audience: string; url?: string }>
    }
    assert.equal(read.configured, true)
    assert.deepEqual(read.recipients.map((entry) => [entry.label, entry.audience]), [['Shop topic', 'everyone']])
    assert.ok(read.recipients.every((entry) => entry.url === undefined), 'topic URLs never leave the server')

    const removeResponse = await fetch(
      `${baseUrl}/api/plugins/notifications-ntfy/recipients/${read.recipients[0]!.id}`,
      { method: 'DELETE' }
    )
    assert.equal(removeResponse.status, 200)
    assert.deepEqual((await removeResponse.json() as { recipients: unknown[] }).recipients, [])
  })
})

test('a legacy topicUrl setting appears as a shared recipient', async () => {
  await withNtfyApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const readResponse = await fetch(`${baseUrl}/api/plugins/notifications-ntfy`)
    const read = await readResponse.json() as { configured: boolean; recipients: Array<{ id: string; audience: string }> }
    assert.equal(read.configured, true)
    assert.deepEqual(read.recipients.map((entry) => entry.audience), ['everyone'])
    assert.equal(read.recipients[0]!.id, 'legacy')
  }, { initialSettings: { 'tenant:test-tenant:topicUrl': 'https://ntfy.sh/legacy-topic' } })
})

test('ntfy rejects an SSRF topic URL (cloud metadata / loopback)', async () => {
  await withNtfyApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    for (const topicUrl of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:8080/x', 'ftp://ntfy.sh/x']) {
      const response = await fetch(`${baseUrl}/api/plugins/notifications-ntfy/recipients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: topicUrl, audience: 'everyone' })
      })
      assert.equal(response.status, 400, `expected ${topicUrl} to be rejected`)
    }
  })
})

async function withNtfyApp(
  auth: RequestAuthContext,
  run: (context: { baseUrl: string }) => Promise<void>,
  options: { initialSettings?: Record<string, string> } = {}
): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = auth
    request.tenant = { id: 'test-tenant', slug: 'test', name: 'Test Tenant' }
    next()
  })

  const router = express.Router()
  app.use('/api/plugins/notifications-ntfy', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  const settings = new Map<string, string>(Object.entries(options.initialSettings ?? {}))
  await notificationsNtfyPlugin.register({
    pluginName: 'notifications-ntfy',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      authUser: {
        async findUnique() { return { displayName: 'User One', email: 'user1@example.com' } }
      },
      setting: {
        async findMany() { return [] }
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