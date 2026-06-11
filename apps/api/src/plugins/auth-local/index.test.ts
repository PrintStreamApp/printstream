import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { AUTH_PROVIDERS_MANAGE_PERMISSION, permissionDefinitions, type LocalAuthStatus, type WsEvent } from '@printstream/shared'
import type { RegisteredAuthProvider } from '../../lib/auth-registry.js'
import { DEMO_AUTH_MUTATION_MESSAGE } from '../../lib/demo-mode.js'
import { HttpError } from '../../lib/http-error.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { createAuthLocalPlugin } from './index.js'

const fakeStatus: LocalAuthStatus = {
  setupRequired: false,
  sessionDuration: 'day',
  permissions: ['auth.access.view', 'library.download', 'library.upload', 'library.view', 'plugins.manage', 'printers.manage', 'printers.view', 'prints.dispatch'],
  permissionDefinitions,
  counts: {
    users: 1,
    groups: 2,
    serviceAccounts: 1,
    passkeys: 3
  }
}

test('auth-local plugin registers provider metadata and serves live setup status', async () => {
  const router = express.Router()
  const registeredProviders: Array<() => Promise<RegisteredAuthProvider>> = []
  let liveStatus = fakeStatus

  const plugin = createAuthLocalPlugin({
    async ensureDefaultGroups() {},
    async buildStatus() {
      return liveStatus
    }
  })

  await plugin.register({
    pluginName: 'auth-local',
    logger: {
      info() {},
      warn() {},
      error() {}
    },
    prisma: {} as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast(_event: WsEvent) {} } as never,
    router,
    settings: {
      async get(key) {
        if (key === 'platform:enabled') return 'true'
        return null
      },
      async set() {},
      async delete() {},
      forTenant() { return this },
    },
    onShutdown() {},
    registerPrintGuard() {
      return () => undefined
    },
    registerAuthProvider(provider) {
      registeredProviders.push(async () => await Promise.resolve(typeof provider === 'function' ? provider() : provider))
      return () => undefined
    }
  })

  const app = express()
  app.use('/api/plugins/auth-local', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/plugins/auth-local/status`)
    const resolveRegisteredProvider = registeredProviders[0]

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), fakeStatus)
    const registeredProvider = resolveRegisteredProvider ? await resolveRegisteredProvider() : null
    assert.deepEqual(registeredProvider, {
      id: 'auth-local',
      label: 'Local Auth',
      enabled: true,
      methods: ['passkey', 'email-code'],
      setupRequired: false,
      capabilities: {
        signIn: true,
        setup: true,
        accountSecurity: true,
        adminUserProvisioning: true,
        adminUserCredentials: true,
        recentVerificationMethods: ['passkey', 'email-code']
      }
    })

    liveStatus = {
      ...fakeStatus,
      setupRequired: true,
      counts: {
        ...fakeStatus.counts,
        passkeys: 0
      }
    }

    const updatedResponse = await fetch(`http://127.0.0.1:${address.port}/api/plugins/auth-local/status`)
    assert.equal(updatedResponse.status, 200)
    assert.deepEqual(await updatedResponse.json(), liveStatus)
    if (!resolveRegisteredProvider) {
      throw new Error('expected auth-local provider to register')
    }
    assert.equal((await resolveRegisteredProvider()).setupRequired, true)
  } finally {
    await close(server)
  }
})

test('auth-local provider enable writes are blocked in demo mode', async () => {
  const router = express.Router()

  const plugin = createAuthLocalPlugin({
    async ensureDefaultGroups() {},
    async buildStatus() {
      return fakeStatus
    }
  })

  await plugin.register({
    pluginName: 'auth-local',
    logger: {
      info() {},
      warn() {},
      error() {}
    },
    prisma: {} as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast(_event: WsEvent) {} } as never,
    router,
    settings: {
      async get(key) {
        if (key === 'platform:enabled') return 'false'
        return null
      },
      async set() {
        throw new Error('demo-mode provider writes must not persist')
      },
      async delete() {},
      forTenant() { return this }
    },
    onShutdown() {},
    registerPrintGuard() {
      return () => undefined
    },
    registerAuthProvider() {
      return () => undefined
    }
  })

  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = {
      authEnabled: false,
      publicDemoGuest: true,
      actor: { type: 'anonymous' },
      permissions: [AUTH_PROVIDERS_MANAGE_PERMISSION],
      runtimePolicy: { demoMode: true }
    }
    next()
  })
  app.use('/api/plugins/auth-local', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/plugins/auth-local/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: DEMO_AUTH_MUTATION_MESSAGE })
  } finally {
    await close(server)
  }
})

test('auth-local provider enable writes are blocked in the demo tenant for signed-in platform admins', async () => {
  const router = express.Router()

  const plugin = createAuthLocalPlugin({
    async ensureDefaultGroups() {},
    async buildStatus() {
      return fakeStatus
    }
  })

  await plugin.register({
    pluginName: 'auth-local',
    logger: {
      info() {},
      warn() {},
      error() {}
    },
    prisma: {} as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast(_event: WsEvent) {} } as never,
    router,
    settings: {
      async get(key) {
        if (key === 'platform:enabled') return 'false'
        return null
      },
      async set() {
        throw new Error('demo tenant provider writes must not persist')
      },
      async delete() {},
      forTenant() { return this }
    },
    onShutdown() {},
    registerPrintGuard() {
      return () => undefined
    },
    registerAuthProvider() {
      return () => undefined
    }
  })

  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = {
      authEnabled: true,
      actor: {
        type: 'user',
        userId: 'platform-user-1',
        isPlatformUser: true,
        tenant: {
          id: 'tenant-demo',
          slug: 'demo',
          name: 'Public Demo'
        }
      },
      permissions: [AUTH_PROVIDERS_MANAGE_PERMISSION],
      runtimePolicy: { demoMode: false }
    }
    request.tenant = {
      id: 'tenant-demo',
      slug: 'demo',
      name: 'Public Demo'
    }
    next()
  })
  app.use('/api/plugins/auth-local', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/plugins/auth-local/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: DEMO_AUTH_MUTATION_MESSAGE })
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