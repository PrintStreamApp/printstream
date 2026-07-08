import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { WsEvent } from '@printstream/shared'
import { HttpError } from '../../lib/http-error.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { createAuthPasswordPlugin } from './index.js'
import { hashPassword } from './password-hash.js'

type SignInUser = {
  id: string
  isPlatformUser: boolean
  passwordCredential: { passwordHash: string } | null
  tenantMemberships: Array<{ tenantId: string }>
} | null

const SIGN_IN_FAILED = 'Email or password is incorrect.'

async function buildSignInApp(options: { user: SignInUser; enabled?: boolean }): Promise<{ baseUrl: string; server: Server }> {
  const enabled = options.enabled ?? true
  const plugin = createAuthPasswordPlugin()
  const router = express.Router()
  await plugin.register({
    pluginName: 'auth-password',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      authUser: {
        async findFirst() {
          return options.user
        }
      },
      authPasswordCredential: {
        async update() {
          return null
        }
      },
      authSession: {
        async create(args: { data: Record<string, unknown> }) {
          return { id: 'session-1', ...args.data }
        }
      },
      setting: {
        async findUnique() {
          return null
        }
      }
    } as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast(_event: WsEvent) {} } as never,
    router,
    settings: {
      async get(key: string) {
        if (key === 'platform:enabled') return enabled ? 'true' : 'false'
        return null
      },
      async set() {},
      async delete() {},
      forTenant() { return this }
    },
    onShutdown() {},
    registerPrintGuard() { return () => undefined },
    registerSlotFilamentResolver() { return () => undefined },
    registerAuthProvider() { return () => undefined }
  })

  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = {
      authEnabled: false,
      actor: { type: 'anonymous' },
      permissions: [],
      runtimePolicy: { demoMode: false }
    } as never
    next()
  })
  app.use('/api/plugins/auth-password', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${address.port}/api/plugins/auth-password`, server }
}

test('password sign-in succeeds with the correct password and sets a session cookie', async () => {
  const passwordHash = await hashPassword('correct horse battery staple')
  const { baseUrl, server } = await buildSignInApp({
    user: { id: 'user-1', isPlatformUser: true, passwordCredential: { passwordHash }, tenantMemberships: [] }
  })
  try {
    const response = await fetch(`${baseUrl}/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'correct horse battery staple' })
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('set-cookie') ?? '', /printstream_auth=/)
    assert.deepEqual(await response.json(), {
      authenticated: true,
      actor: { type: 'user', userId: 'user-1', isPlatformUser: false },
      redirectTo: null
    })
  } finally {
    await close(server)
  }
})

test('password sign-in returns an identical generic error for a wrong password and an unknown email', async () => {
  const passwordHash = await hashPassword('correct horse battery staple')
  const wrong = await buildSignInApp({
    user: { id: 'user-1', isPlatformUser: true, passwordCredential: { passwordHash }, tenantMemberships: [] }
  })
  const unknown = await buildSignInApp({ user: null })
  try {
    const wrongResponse = await fetch(`${wrong.baseUrl}/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'not the password' })
    })
    const unknownResponse = await fetch(`${unknown.baseUrl}/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ghost@example.com', password: 'whatever value here' })
    })

    assert.equal(wrongResponse.status, 401)
    assert.equal(unknownResponse.status, 401)
    assert.equal(wrongResponse.headers.get('set-cookie'), null)
    assert.deepEqual(await wrongResponse.json(), { error: SIGN_IN_FAILED })
    assert.deepEqual(await unknownResponse.json(), { error: SIGN_IN_FAILED })
  } finally {
    await close(wrong.server)
    await close(unknown.server)
  }
})

test('password sign-in rejects a user with no enabled tenant membership', async () => {
  const passwordHash = await hashPassword('correct horse battery staple')
  const { baseUrl, server } = await buildSignInApp({
    user: { id: 'user-1', isPlatformUser: false, passwordCredential: { passwordHash }, tenantMemberships: [] }
  })
  try {
    const response = await fetch(`${baseUrl}/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'member@example.com', password: 'correct horse battery staple' })
    })
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: SIGN_IN_FAILED })
  } finally {
    await close(server)
  }
})

test('password sign-in is rejected when the provider is disabled', async () => {
  const { baseUrl, server } = await buildSignInApp({ user: null, enabled: false })
  try {
    const response = await fetch(`${baseUrl}/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'whatever value here' })
    })
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Password sign-in is not enabled in this workspace.' })
  } finally {
    await close(server)
  }
})

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
