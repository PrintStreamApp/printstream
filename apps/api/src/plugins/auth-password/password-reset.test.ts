import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { WsEvent } from '@printstream/shared'
import { emailTransportRegistry, type EmailInput } from '../../lib/email-delivery.js'
import { HttpError } from '../../lib/http-error.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { createAuthPasswordPlugin } from './index.js'

afterEach(() => {
  emailTransportRegistry.clear()
})

type ResetUser = {
  id: string
  email: string
  isPlatformUser: boolean
  passwordCredential: { resetTokenHash?: string | null; resetTokenExpiresAt?: Date | null; userId?: string } | null
  tenantMemberships: Array<{ tenantId: string }>
} | null

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('base64url')
}

async function buildApp(options: {
  user: ResetUser
  emailConfigured: boolean
  credentialUpdates?: Array<Record<string, unknown>>
  sentEmails?: EmailInput[]
}): Promise<{ baseUrl: string; server: Server }> {
  emailTransportRegistry.clear()
  emailTransportRegistry.register({
    name: 'test',
    isConfigured: () => options.emailConfigured,
    send: async (input) => { options.sentEmails?.push(input) }
  })

  const plugin = createAuthPasswordPlugin()
  const router = express.Router()
  await plugin.register({
    pluginName: 'auth-password',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      authUser: { async findFirst() { return options.user } },
      authPasswordCredential: {
        async update(args: { data: Record<string, unknown> }) { options.credentialUpdates?.push(args.data); return null }
      },
      authSession: { async create(args: { data: Record<string, unknown> }) { return { id: 'session-1', ...args.data } } },
      setting: { async findUnique() { return null } }
    } as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast(_event: WsEvent) {} } as never,
    router,
    settings: {
      async get(key: string) { return key === 'platform:enabled' ? 'true' : null },
      async set() {}, async delete() {}, forTenant() { return this }
    },
    onShutdown() {},
    registerPrintGuard() { return () => undefined },
    registerSlotFilamentResolver() { return () => undefined },
    registerAuthProvider() { return () => undefined }
  })

  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = { authEnabled: false, actor: { type: 'anonymous' }, permissions: [], runtimePolicy: { demoMode: false } } as never
    next()
  })
  app.use('/api/plugins/auth-password', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) { response.status(error.statusCode).json({ error: error.message }); return }
    response.status(500).json({ error: 'Internal server error' })
  })
  const server = await listen(app)
  const address = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${address.port}/api/plugins/auth-password`, server }
}

test('GET /password-reset reports availability from the email transport', async () => {
  // The transport registry is a global singleton, so exercise one app at a time.
  const on = await buildApp({ user: null, emailConfigured: true })
  try {
    assert.deepEqual(await (await fetch(`${on.baseUrl}/password-reset`)).json(), { available: true })
  } finally {
    await close(on.server)
  }
  const off = await buildApp({ user: null, emailConfigured: false })
  try {
    assert.deepEqual(await (await fetch(`${off.baseUrl}/password-reset`)).json(), { available: false })
  } finally {
    await close(off.server)
  }
})

test('reset request stores a token and emails the user (generic response)', async () => {
  const credentialUpdates: Array<Record<string, unknown>> = []
  const sentEmails: EmailInput[] = []
  const { baseUrl, server } = await buildApp({
    user: { id: 'u1', email: 'admin@example.com', isPlatformUser: true, passwordCredential: { userId: 'u1' }, tenantMemberships: [] },
    emailConfigured: true,
    credentialUpdates,
    sentEmails
  })
  try {
    const response = await fetch(`${baseUrl}/password-reset/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com' })
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { delivered: true })
    assert.equal(credentialUpdates.length, 1)
    assert.ok(credentialUpdates[0]?.resetTokenHash)
    assert.equal(sentEmails.length, 1)
    assert.equal(sentEmails[0]?.to, 'admin@example.com')
  } finally {
    await close(server)
  }
})

test('reset request is a no-op (still generic) when email delivery is not configured', async () => {
  const credentialUpdates: Array<Record<string, unknown>> = []
  const sentEmails: EmailInput[] = []
  const { baseUrl, server } = await buildApp({
    user: { id: 'u1', email: 'admin@example.com', isPlatformUser: true, passwordCredential: { userId: 'u1' }, tenantMemberships: [] },
    emailConfigured: false,
    credentialUpdates,
    sentEmails
  })
  try {
    const response = await fetch(`${baseUrl}/password-reset/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com' })
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { delivered: true })
    assert.equal(credentialUpdates.length, 0)
    assert.equal(sentEmails.length, 0)
  } finally {
    await close(server)
  }
})

test('reset verify sets a new password and signs in with a valid code', async () => {
  const credentialUpdates: Array<Record<string, unknown>> = []
  const { baseUrl, server } = await buildApp({
    user: {
      id: 'u1', email: 'admin@example.com', isPlatformUser: true,
      passwordCredential: { resetTokenHash: hashCode('GOOD-CODE'), resetTokenExpiresAt: new Date(Date.now() + 60_000) },
      tenantMemberships: []
    },
    emailConfigured: true,
    credentialUpdates
  })
  try {
    const response = await fetch(`${baseUrl}/password-reset/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', code: 'GOOD-CODE', newPassword: 'a-fresh-passphrase' })
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('set-cookie') ?? '', /printstream_auth=/)
    const body = await response.json() as { authenticated: boolean }
    assert.equal(body.authenticated, true)
    assert.equal(credentialUpdates.length, 1)
    assert.equal(credentialUpdates[0]?.resetTokenHash, null) // token consumed
    assert.ok(credentialUpdates[0]?.passwordHash)
  } finally {
    await close(server)
  }
})

test('reset verify rejects a wrong or expired code', async () => {
  const wrong = await buildApp({
    user: { id: 'u1', email: 'admin@example.com', isPlatformUser: true, passwordCredential: { resetTokenHash: hashCode('GOOD-CODE'), resetTokenExpiresAt: new Date(Date.now() + 60_000) }, tenantMemberships: [] },
    emailConfigured: true
  })
  const expired = await buildApp({
    user: { id: 'u1', email: 'admin@example.com', isPlatformUser: true, passwordCredential: { resetTokenHash: hashCode('GOOD-CODE'), resetTokenExpiresAt: new Date(Date.now() - 1_000) }, tenantMemberships: [] },
    emailConfigured: true
  })
  try {
    const wrongResponse = await fetch(`${wrong.baseUrl}/password-reset/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', code: 'WRONG-CODE', newPassword: 'a-fresh-passphrase' })
    })
    const expiredResponse = await fetch(`${expired.baseUrl}/password-reset/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', code: 'GOOD-CODE', newPassword: 'a-fresh-passphrase' })
    })
    assert.equal(wrongResponse.status, 401)
    assert.equal(expiredResponse.status, 401)
  } finally {
    await close(wrong.server); await close(expired.server)
  }
})

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)) })
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()) })
}
