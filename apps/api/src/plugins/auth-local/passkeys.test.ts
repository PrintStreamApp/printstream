import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { permissionDefinitions, type WsEvent } from '@printstream/shared'
import type { RegisteredAuthProvider } from '../../lib/auth-registry.js'
import { HttpError } from '../../lib/http-error.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { createAuthLocalPlugin } from './index.js'

test('auth-local passkey registration stores a verified credential for the signed-in setup user', async () => {
  const createdAt = new Date('2026-05-01T00:00:00.000Z')
  const sessionCreatedAt = new Date()
  const passkeys: Array<{ id: string; credentialId: string; nickname: string | null; transports: string[]; backedUp: boolean; createdAt: Date }> = []
  const freshSessionHash = crypto.createHash('sha256').update('fresh-session').digest('base64url')
  const registeredProviders: Array<() => Promise<RegisteredAuthProvider>> = []

  const plugin = createAuthLocalPlugin({
    async ensureDefaultGroups() {},
    async buildStatus() {
      return {
        setupRequired: passkeys.length === 0,
        sessionDuration: 'day',
        permissions: ['auth.access.view'],
        permissionDefinitions,
        counts: { users: 1, groups: 1, serviceAccounts: 0, passkeys: passkeys.length }
      }
    },
    passkeyServices: {
      async beginRegistration() {
        return { challenge: 'registration-challenge' } as never
      },
      async finishRegistration() {
        return {
          verified: true,
          registrationInfo: {
            credential: {
              id: 'credential-1',
              publicKey: new Uint8Array([1, 2, 3]),
              counter: 1
            },
            credentialDeviceType: 'singleDevice',
            credentialBackedUp: false,
            aaguid: 'aaguid-1'
          }
        } as never
      }
    }
  })

  const router = express.Router()
  await plugin.register({
    pluginName: 'auth-local',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      authGroup: { async findUnique() { return { id: 'group-admin', key: 'admin', name: 'Admin' } } },
      authUser: {
        async findUnique() {
          return {
            id: 'user-1',
            email: 'admin@example.com',
            displayName: 'Primary Admin',
            loginDisabled: false,
            passkeys: []
          }
        }
      },
      authSession: {
        async findUnique(args: { where: { secretHash: string } }) {
          if (args.where.secretHash !== freshSessionHash) {
            return null
          }

          return {
            userId: 'user-1',
            createdAt: sessionCreatedAt,
            expiresAt: new Date(sessionCreatedAt.getTime() + 60 * 60 * 1000),
            revokedAt: null
          }
        }
      },
      authPasskeyCredential: {
        async create(args: { data: { credentialId: string; nickname: string | null; transports: string[]; backedUp: boolean } }) {
          const next = {
            id: 'passkey-1',
            credentialId: args.data.credentialId,
            nickname: args.data.nickname,
            transports: args.data.transports,
            backedUp: args.data.backedUp,
            createdAt
          }
          passkeys.push(next)
          return next
        },
        async findUniqueOrThrow() {
          return passkeys[0]
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
      async get(key) {
        if (key === 'platform:enabled') return 'true'
        return null
      },
      async set() {},
      async delete() {},
      forTenant() { return this },
    },
    onShutdown() {},
    registerPrintGuard() { return () => undefined },
    registerAuthProvider(provider) {
      registeredProviders.push(async () => await Promise.resolve(typeof provider === 'function' ? provider() : provider))
      return () => undefined
    }
  })

  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = {
      authEnabled: false,
      actor: { type: 'user', userId: 'user-1' },
      permissions: ['auth.access.view'],
      runtimePolicy: { demoMode: false }
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
  const baseUrl = `http://127.0.0.1:${address.port}/api/plugins/auth-local`

  try {
    const optionsResponse = await fetch(`${baseUrl}/passkeys/register/options`, {
      method: 'POST',
      headers: {
        Cookie: 'printstream_auth=fresh-session'
      }
    })
    assert.equal(optionsResponse.status, 200)
    const challengeCookie = optionsResponse.headers.get('set-cookie')
    assert.match(challengeCookie ?? '', /printstream_auth_challenge=registration%3Aregistration-challenge/)

    const verifyResponse = await fetch(`${baseUrl}/passkeys/register/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'printstream_auth=fresh-session; printstream_auth_challenge=registration%3Aregistration-challenge'
      },
      body: JSON.stringify({
        response: {
          id: 'credential-1',
          response: { transports: ['internal'] }
        },
        nickname: 'Laptop passkey'
      })
    })

    assert.equal(verifyResponse.status, 201)
    assert.deepEqual(await verifyResponse.json(), {
      credential: {
        id: 'passkey-1',
        nickname: 'Laptop passkey',
        createdAt: createdAt.toISOString()
      },
      setupRequired: false
    })
    assert.equal(passkeys[0]?.backedUp, false)
    const resolveRegisteredProvider = registeredProviders[0]
    if (!resolveRegisteredProvider) {
      throw new Error('expected auth-local provider to register')
    }
    assert.equal((await resolveRegisteredProvider()).setupRequired, false)
  } finally {
    await close(server)
  }
})

test('auth-local passkey registration requires recent verification before a new passkey can be added', async () => {
  const plugin = createAuthLocalPlugin({
    async ensureDefaultGroups() {},
    async buildStatus() {
      return {
        setupRequired: false,
        sessionDuration: 'day',
        permissions: ['auth.access.view'],
        permissionDefinitions,
        counts: { users: 1, groups: 1, serviceAccounts: 0, passkeys: 1 }
      }
    }
  })

  const router = express.Router()
  await plugin.register({
    pluginName: 'auth-local',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      authGroup: { async findUnique() { return { id: 'group-admin', key: 'admin', name: 'Admin' } } },
      authUser: {
        async findUnique() {
          return {
            id: 'user-1',
            email: 'admin@example.com',
            displayName: 'Primary Admin',
            loginDisabled: false,
            passkeys: []
          }
        }
      },
      authSession: {
        async findUnique() {
          return null
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
      async get(key) {
        if (key === 'platform:enabled') return 'true'
        return null
      },
      async set() {},
      async delete() {},
      forTenant() { return this },
    },
    onShutdown() {},
    registerPrintGuard() { return () => undefined },
    registerAuthProvider() { return () => undefined }
  })

  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: ['auth.access.view'],
      runtimePolicy: { demoMode: false }
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
  const baseUrl = `http://127.0.0.1:${address.port}/api/plugins/auth-local`

  try {
    const optionsResponse = await fetch(`${baseUrl}/passkeys/register/options`, {
      method: 'POST'
    })

    assert.equal(optionsResponse.status, 401)
    assert.deepEqual(await optionsResponse.json(), {
      error: 'Verify your identity again to continue.'
    })
  } finally {
    await close(server)
  }
})

test('auth-local passkey authentication creates a user session from a verified credential', async () => {
  const updates: Array<{ counter: number; backedUp: boolean }> = []
  const plugin = createAuthLocalPlugin({
    async ensureDefaultGroups() {},
    async buildStatus() {
      return {
        setupRequired: false,
        sessionDuration: 'day',
        permissions: ['auth.access.view'],
        permissionDefinitions,
        counts: { users: 1, groups: 1, serviceAccounts: 0, passkeys: 1 }
      }
    },
    passkeyServices: {
      async beginAuthentication() {
        return { challenge: 'authentication-challenge' } as never
      },
      async finishAuthentication() {
        return {
          verified: true,
          authenticationInfo: { newCounter: 2, credentialDeviceType: 'multiDevice', credentialBackedUp: true }
        } as never
      }
    }
  })

  const router = express.Router()
  const sessions: Array<{ secretHash: string; userId: string; userAgent?: string | null }> = []
  await plugin.register({
    pluginName: 'auth-local',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      authGroup: { async findUnique() { return { id: 'group-admin', key: 'admin', name: 'Admin' } } },
      authPasskeyCredential: {
        async findUnique() {
          return {
            id: 'passkey-1',
            credentialId: 'credential-1',
            publicKey: Buffer.from([1, 2, 3]),
            counter: 1,
            transports: ['internal'],
            user: {
              id: 'user-1',
              isPlatformUser: false,
              tenantMemberships: [{ tenantId: 'tenant-1', loginDisabled: false }]
            }
          }
        },
        async update(args: { data: { counter: number; backedUp: boolean } }) {
          updates.push({ counter: args.data.counter, backedUp: args.data.backedUp })
          return undefined
        }
      },
      authSession: {
        async create(args: { data: { secretHash: string; userId: string; userAgent?: string | null } }) {
          sessions.push({ secretHash: args.data.secretHash, userId: args.data.userId, userAgent: args.data.userAgent })
          return { id: `session-${sessions.length}`, ...args.data, expiresAt: new Date(Date.now() + 60_000) }
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
      async get(key) {
        if (key === 'platform:enabled') return 'true'
        return null
      },
      async set() {},
      async delete() {},
      forTenant() { return this },
    },
    onShutdown() {},
    registerPrintGuard() { return () => undefined },
    registerAuthProvider() { return () => undefined }
  })

  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = {
      authEnabled: true,
      actor: { type: 'anonymous' },
      permissions: [],
      runtimePolicy: { demoMode: false }
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
  const baseUrl = `http://127.0.0.1:${address.port}/api/plugins/auth-local`

  try {
    const optionsResponse = await fetch(`${baseUrl}/passkeys/authenticate/options`, { method: 'POST' })
    assert.equal(optionsResponse.status, 200)
    assert.match(optionsResponse.headers.get('set-cookie') ?? '', /printstream_auth_challenge=authentication%3Aauthentication-challenge/)

    const verifyResponse = await fetch(`${baseUrl}/passkeys/authenticate/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'printstream_auth_challenge=authentication%3Aauthentication-challenge'
      },
      body: JSON.stringify({ response: { id: 'credential-1' } })
    })
    assert.equal(verifyResponse.status, 200)
    assert.deepEqual(await verifyResponse.json(), {
      authenticated: true,
      actor: {
        type: 'user',
        userId: 'user-1',
        isPlatformUser: false
      }
    })
    assert.deepEqual(updates, [{ counter: 2, backedUp: true }])
    assert.match(verifyResponse.headers.get('set-cookie') ?? '', /printstream_auth=/)
    assert.equal(sessions.length, 1)
  } finally {
    await close(server)
  }
})

test('auth-local passkey routes list, rename, and revoke the current user credentials', async () => {
  const createdAt = new Date('2026-05-01T00:00:00.000Z')
  const passkeys: Array<{
    id: string
    userId: string
    credentialId: string
    nickname: string | null
    aaguid: string | null
    transports: string[]
    backedUp: boolean
    lastUsedAt: Date | null
    createdAt: Date
    updatedAt: Date
  }> = [
    {
      id: 'passkey-1',
      userId: 'user-1',
      credentialId: 'credential-1',
      nickname: 'Laptop',
      aaguid: 'aaguid-1',
      transports: ['internal'],
      backedUp: true,
      lastUsedAt: createdAt,
      createdAt,
      updatedAt: createdAt
    },
    {
      id: 'passkey-2',
      userId: 'user-1',
      credentialId: 'credential-2',
      nickname: 'Phone',
      aaguid: 'aaguid-2',
      transports: ['hybrid', 'internal'],
      backedUp: false,
      lastUsedAt: null,
      createdAt,
      updatedAt: createdAt
    }
  ]

  const plugin = createAuthLocalPlugin({
    async ensureDefaultGroups() {},
    async buildStatus() {
      return {
        setupRequired: false,
        sessionDuration: 'day',
        permissions: ['auth.access.view'],
        permissionDefinitions,
        counts: { users: 1, groups: 1, serviceAccounts: 0, passkeys: passkeys.length }
      }
    }
  })

  const router = express.Router()
  await plugin.register({
    pluginName: 'auth-local',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      authGroup: { async findUnique() { return { id: 'group-admin', key: 'admin', name: 'Admin' } } },
      authUser: {
        async findUnique() {
          return {
            id: 'user-1',
            email: 'admin@example.com',
            displayName: 'Primary Admin',
            loginDisabled: false,
            passkeys: passkeys.map((passkey) => ({
              credentialId: passkey.credentialId,
              transports: ['internal']
            }))
          }
        }
      },
      authPasskeyCredential: {
        async findMany(input: { where: { userId: string } }) {
          return passkeys.filter((passkey) => passkey.userId === input.where.userId)
        },
        async findFirst(input: { where: { id: string; userId: string } }) {
          return passkeys.find((passkey) => passkey.id === input.where.id && passkey.userId === input.where.userId) ?? null
        },
        async update(input: { where: { id: string }; data: { nickname: string | null } }) {
          const passkey = passkeys.find((entry) => entry.id === input.where.id)
          if (!passkey) {
            throw new Error('passkey missing')
          }
          passkey.nickname = input.data.nickname
          passkey.updatedAt = createdAt
          return passkey
        },
        async delete(input: { where: { id: string } }) {
          const index = passkeys.findIndex((passkey) => passkey.id === input.where.id)
          if (index >= 0) {
            passkeys.splice(index, 1)
          }
          return undefined
        }
      },
      authSession: {
        async findUnique(input: { where: { secretHash: string } }) {
          if (input.where.secretHash !== hashSessionSecret('fresh-session')) {
            return null
          }

          const now = new Date()

          return {
            userId: 'user-1',
            createdAt: now,
            expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
            revokedAt: null
          }
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
      async get(key) {
        if (key === 'platform:enabled') return 'true'
        return null
      },
      async set() {},
      async delete() {},
      forTenant() { return this },
    },
    onShutdown() {},
    registerPrintGuard() { return () => undefined },
    registerAuthProvider() { return () => undefined }
  })

  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [],
      runtimePolicy: { demoMode: false }
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
  const baseUrl = `http://127.0.0.1:${address.port}/api/plugins/auth-local`

  try {
    const listResponse = await fetch(`${baseUrl}/passkeys`)
    assert.equal(listResponse.status, 200)
    const listed = await listResponse.json()
    assert.equal(listed.passkeys.length, 2)
    assert.equal(listed.passkeys[0].id, 'passkey-1')

    const renameResponse = await fetch(`${baseUrl}/passkeys/passkey-2`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ nickname: 'Desk phone' })
    })
    assert.equal(renameResponse.status, 200)
    assert.deepEqual(await renameResponse.json(), {
      passkey: {
        id: 'passkey-2',
        nickname: 'Desk phone',
        aaguid: 'aaguid-2',
        transports: ['hybrid', 'internal'],
        backedUp: false,
        lastUsedAt: null,
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString()
      }
    })
    assert.equal(passkeys[1]?.nickname, 'Desk phone')

    const revokeResponse = await fetch(`${baseUrl}/passkeys/passkey-1/revoke`, {
      method: 'POST',
      headers: {
        Cookie: 'printstream_auth=fresh-session'
      }
    })
    assert.equal(revokeResponse.status, 204)
    assert.equal(passkeys.length, 1)
    assert.equal(passkeys[0]?.id, 'passkey-2')
  } finally {
    await close(server)
  }
})

test('auth-local passkey revoke requires a recent authenticated session', async () => {
  const plugin = createAuthLocalPlugin({
    async ensureDefaultGroups() {},
    async buildStatus() {
      return {
        setupRequired: false,
        sessionDuration: 'day',
        permissions: ['auth.access.view'],
        permissionDefinitions,
        counts: { users: 1, groups: 1, serviceAccounts: 0, passkeys: 1 }
      }
    }
  })

  const router = express.Router()
  await plugin.register({
    pluginName: 'auth-local',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      authGroup: { async findUnique() { return { id: 'group-admin', key: 'admin', name: 'Admin' } } },
      authUser: {
        async findUnique() {
          return {
            id: 'user-1',
            email: 'admin@example.com',
            displayName: 'Primary Admin',
            loginDisabled: false,
            passkeys: [{ credentialId: 'credential-1', transports: ['internal'] }]
          }
        }
      },
      authPasskeyCredential: {
        async findMany() {
          return []
        },
        async findFirst() {
          return {
            id: 'passkey-1',
            userId: 'user-1'
          }
        },
        async delete() {
          throw new Error('delete should not be reached without recent auth')
        }
      },
      authSession: {
        async findUnique() {
          return null
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
      async get(key) {
        if (key === 'platform:enabled') return 'true'
        return null
      },
      async set() {},
      async delete() {},
      forTenant() { return this },
    },
    onShutdown() {},
    registerPrintGuard() { return () => undefined },
    registerAuthProvider() { return () => undefined }
  })

  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [],
      runtimePolicy: { demoMode: false }
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
    const revokeResponse = await fetch(`http://127.0.0.1:${address.port}/api/plugins/auth-local/passkeys/passkey-1/revoke`, {
      method: 'POST'
    })

    assert.equal(revokeResponse.status, 401)
    assert.deepEqual(await revokeResponse.json(), {
      error: 'Verify your identity again to continue.'
    })
  } finally {
    await close(server)
  }
})

function hashSessionSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('base64url')
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