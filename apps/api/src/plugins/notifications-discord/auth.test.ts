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
import { notificationsDiscordPlugin } from './index.js'

test('discord settings require authentication once auth is enabled', async () => {
  await withDiscordApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/notifications-discord`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('discord settings return 403 without settings.manage permission', async () => {
  await withDiscordApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/notifications-discord/recipients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://discord.com/api/webhooks/123/abc', audience: 'everyone' })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('discord recipients can be listed, added, and removed by settings managers', async () => {
  await withDiscordApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const addShared = await fetch(`${baseUrl}/api/plugins/notifications-discord/recipients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://discord.com/api/webhooks/123/abc', label: 'Team', audience: 'everyone' })
    })
    assert.equal(addShared.status, 201)

    const addPersonal = await fetch(`${baseUrl}/api/plugins/notifications-discord/recipients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://discord.com/api/webhooks/456/def', audience: 'mine' })
    })
    assert.equal(addPersonal.status, 201)

    const readResponse = await fetch(`${baseUrl}/api/plugins/notifications-discord`)
    assert.equal(readResponse.status, 200)
    const read = await readResponse.json() as {
      configured: boolean
      recipients: Array<{ id: string; label: string; audience: string; userName?: string; url?: string }>
    }
    assert.equal(read.configured, true)
    assert.deepEqual(read.recipients.map((entry) => entry.audience), ['everyone', 'personal'])
    assert.equal(read.recipients[1]!.userName, 'User One')
    assert.ok(read.recipients.every((entry) => entry.url === undefined), 'destination URLs never leave the server')

    const removeResponse = await fetch(
      `${baseUrl}/api/plugins/notifications-discord/recipients/${read.recipients[0]!.id}`,
      { method: 'DELETE' }
    )
    assert.equal(removeResponse.status, 200)
    const afterRemove = await removeResponse.json() as { recipients: Array<{ audience: string }> }
    assert.deepEqual(afterRemove.recipients.map((entry) => entry.audience), ['personal'])
  })
})

test('discord recipients reject non-discord webhook URLs', async () => {
  await withDiscordApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/notifications-discord/recipients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/webhook', audience: 'everyone' })
    })
    assert.equal(response.status, 400)
  })
})

test('a legacy webhookUrl setting appears as a shared recipient', async () => {
  await withDiscordApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const readResponse = await fetch(`${baseUrl}/api/plugins/notifications-discord`)
    const read = await readResponse.json() as { configured: boolean; recipients: Array<{ id: string; audience: string }> }
    assert.equal(read.configured, true)
    assert.deepEqual(read.recipients.map((entry) => entry.audience), ['everyone'])
    assert.equal(read.recipients[0]!.id, 'legacy')
  }, { initialSettings: { 'tenant:test-tenant:webhookUrl': 'https://discord.com/api/webhooks/1/legacy' } })
})

async function withDiscordApp(
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
  app.use('/api/plugins/notifications-discord', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  const settings = new Map<string, string>(Object.entries(options.initialSettings ?? {}))
  await notificationsDiscordPlugin.register({
    pluginName: 'notifications-discord',
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