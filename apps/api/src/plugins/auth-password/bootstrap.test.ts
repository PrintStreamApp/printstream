import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { PASSWORD_POLICY, permissionDefinitions, type Permission, type WsEvent } from '@printstream/shared'
import { HttpError } from '../../lib/http-error.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { PLATFORM_ADMIN_GROUP_KEY } from '../../lib/default-auth-groups.js'
import { createAuthPasswordPlugin } from './index.js'
import { verifyPassword } from './password-hash.js'

type GroupRecord = {
  id: string
  tenantId?: string | null
  key: string | null
  name: string
  description: string | null
  permissions: Permission[]
  isSystem: boolean
  isEditable: boolean
  isRemovable: boolean
  createdAt: Date
  updatedAt: Date
}

function passwordStatus(userCount: number) {
  return {
    setupRequired: userCount === 0,
    sessionDuration: 'day' as const,
    permissions: ['auth.access.view'] as Permission[],
    permissionDefinitions,
    counts: { users: userCount, groups: 0, serviceAccounts: 0, passwordCredentials: 0 },
    policy: PASSWORD_POLICY
  }
}

test('password bootstrap creates the initial admin with a credential and signs them in', async () => {
  const createdAt = new Date('2026-06-01T00:00:00.000Z')
  const users: Array<{ id: string; email: string; displayName: string | null; isPlatformUser: boolean; createdAt: Date }> = []
  const memberships: Array<{ userId: string; groupId: string }> = []
  const credentials: Array<{ userId: string; passwordHash: string }> = []
  const groups: GroupRecord[] = []
  const settingWrites: Array<{ key: string; value: string }> = []

  const plugin = createAuthPasswordPlugin({
    async buildStatus() {
      return passwordStatus(users.length)
    }
  })

  const router = express.Router()
  await plugin.register({
    pluginName: 'auth-password',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      authSession: {
        async create(args: { data: Record<string, unknown> }) {
          return { id: 'session-1', ...args.data }
        }
      },
      setting: {
        async findUnique() {
          return null
        }
      },
      $transaction: async <T>(run: (tx: unknown) => Promise<T>) => run({
        authGroup: {
          async findFirst(input: { where: { tenantId?: string | null; key?: string } }) {
            return groups.find((group) => group.tenantId === input.where.tenantId && group.key === input.where.key) ?? null
          },
          async create(args: { data: GroupRecord }) {
            const next = { ...args.data, createdAt, updatedAt: createdAt }
            groups.push(next)
            return next
          },
          async update(args: { where: { id: string }; data: Partial<GroupRecord> }) {
            const existing = groups.find((group) => group.id === args.where.id)
            if (!existing) throw new Error('group not found')
            Object.assign(existing, args.data)
            return existing
          }
        },
        authUser: {
          async create(args: { data: { email: string; displayName: string | null; isPlatformUser: boolean } }) {
            const next = { id: `user-${users.length + 1}`, ...args.data, createdAt }
            users.push(next)
            return next
          }
        },
        authUserGroupMembership: {
          async create(args: { data: { userId: string; groupId: string } }) {
            memberships.push(args.data)
            return args.data
          }
        },
        authPasswordCredential: {
          async create(args: { data: { userId: string; passwordHash: string } }) {
            credentials.push(args.data)
            return args.data
          }
        }
      })
    } as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast(_event: WsEvent) {} } as never,
    router,
    settings: {
      async get(key: string) {
        if (key === 'platform:enabled') return 'true'
        return null
      },
      async set(key: string, value: string) {
        settingWrites.push({ key, value })
      },
      async delete() {},
      forTenant() { return this }
    },
    onShutdown() {},
    registerPrintGuard() { return () => undefined },
    registerSlotFilamentResolver() { return () => undefined },
    registerAuthProvider() { return () => undefined }
  })

  const app = buildApp(router)
  const server = await listen(app)
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}/api/plugins/auth-password`

  try {
    const response = await fetch(`${baseUrl}/bootstrap/admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'Admin@Example.com', displayName: 'Primary Admin', password: 'correct horse battery' })
    })

    assert.equal(response.status, 201)
    assert.match(response.headers.get('set-cookie') ?? '', /printstream_auth=/)
    const body = await response.json() as { user: { id: string; email: string }; group: { key: string | null }; authenticated: boolean; setupRequired: boolean }
    assert.equal(body.authenticated, true)
    assert.equal(body.user.email, 'admin@example.com')
    assert.equal(body.group.key, PLATFORM_ADMIN_GROUP_KEY)
    assert.deepEqual(users.map((user) => user.email), ['admin@example.com'])
    assert.equal(memberships.length, 1)
    assert.equal(credentials.length, 1)
    assert.equal(credentials[0]?.userId, 'user-1')
    // The stored credential is a verifiable hash, never the plaintext.
    assert.notEqual(credentials[0]?.passwordHash, 'correct horse battery')
    assert.equal(await verifyPassword(credentials[0]!.passwordHash, 'correct horse battery'), true)
    assert.ok(settingWrites.some((write) => write.key.endsWith('setupComplete') && write.value === 'true'))
  } finally {
    await close(server)
  }
})

test('password bootstrap rejects creating a second initial admin', async () => {
  const plugin = createAuthPasswordPlugin({
    async buildStatus() {
      return passwordStatus(1)
    }
  })

  const router = express.Router()
  await plugin.register({
    pluginName: 'auth-password',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      $transaction: async () => {
        throw new Error('unexpected transaction')
      }
    } as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast(_event: WsEvent) {} } as never,
    router,
    settings: {
      async get(key: string) {
        if (key === 'platform:enabled') return 'true'
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

  const app = buildApp(router)
  const server = await listen(app)
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}/api/plugins/auth-password`

  try {
    const response = await fetch(`${baseUrl}/bootstrap/admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'correct horse battery' })
    })

    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'The initial admin account has already been created.' })
  } finally {
    await close(server)
  }
})

function buildApp(router: express.Router): express.Express {
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
  return app
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
