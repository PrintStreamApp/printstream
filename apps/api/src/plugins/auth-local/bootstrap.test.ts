import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { permissionDefinitions, type Permission, type WsEvent } from '@printstream/shared'
import { DEMO_AUTH_MUTATION_MESSAGE } from '../../lib/demo-mode.js'
import { HttpError } from '../../lib/http-error.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { prisma } from '../../lib/prisma.js'
import { installTenantContext } from '../../lib/tenant-context.js'
import { PLATFORM_ADMIN_GROUP_KEY } from '../../lib/default-auth-groups.js'
import { createAuthLocalPlugin } from './index.js'

type UserRecord = {
  id: string
  email: string
  displayName: string | null
  createdAt: Date
}

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

const originalTenantFindUnique = prisma.tenant.findUnique

test('auth-local bootstrap creates the initial admin account during setup', async () => {
  const createdAt = new Date('2026-05-01T00:00:00.000Z')
  const users: Array<UserRecord & { isPlatformUser: boolean }> = []
  const memberships: Array<{ userId: string; groupId: string }> = []
  const issuedTokens: Array<{ userId: string; email: string; tokenHash: string; expiresAt: Date }> = []
  const groups: GroupRecord[] = []

  const plugin = createAuthLocalPlugin({
    async ensureDefaultGroups() {},
    async buildStatus() {
      return {
        setupRequired: true,
        sessionDuration: 'day',
        permissions: ['auth.access.view'],
        permissionDefinitions,
        counts: { users: users.length, groups: groups.length, serviceAccounts: 0, passkeys: 0 }
      }
    },
    emailCodeServices: {
      now: () => new Date('2026-05-01T00:00:00.000Z'),
      createCode: () => 'ABCD-EFGH',
      async deliverEmailCode() {
        return { delivered: true, previewCode: 'ABCD-EFGH' }
      }
    }
  })

  const router = express.Router()
  await plugin.register({
    pluginName: 'auth-local',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      authGroup: {
        async findUnique(input: { where: { key?: string; id?: string } }) {
          if (input.where.key) return groups.find((group) => group.key === input.where.key) ?? null
          if (input.where.id) return groups.find((group) => group.id === input.where.id) ?? null
          return null
        },
        async findFirst(input: { where: { tenantId?: string | null; key?: string } }) {
          return groups.find((group) => group.tenantId === input.where.tenantId && group.key === input.where.key) ?? null
        }
      },
      authEmailCodeToken: {
        async deleteMany() {
          return { count: 0 }
        },
        async create(args: { data: { userId: string; email: string; tokenHash: string; expiresAt: Date } }) {
          issuedTokens.push(args.data)
          return { id: `token-${issuedTokens.length}`, ...args.data }
        },
        async delete() {
          return null
        }
      },
      $transaction: async <T>(run: (tx: {
        authGroup: {
          findFirst(args: { where: { tenantId?: string | null; key?: string } }): Promise<GroupRecord | null>
          create(args: { data: Partial<GroupRecord> & { id: string; tenantId: string | null; key: string; name: string; description: string; permissions: Permission[]; isSystem: boolean; isEditable: boolean; isRemovable: boolean } }): Promise<GroupRecord>
          update(args: { where: { id: string }; data: Partial<GroupRecord> }): Promise<GroupRecord>
        }
        authUser: { create(args: { data: { email: string; displayName: string | null; isPlatformUser: boolean } }): Promise<UserRecord & { isPlatformUser: boolean }> }
        authUserGroupMembership: { create(args: { data: { userId: string; groupId: string } }): Promise<{ userId: string; groupId: string }> }
      }) => Promise<T>) => run({
        authGroup: {
          async findFirst(input) {
            return groups.find((group) => group.tenantId === input.where.tenantId && group.key === input.where.key) ?? null
          },
          async create(args) {
            const next = {
              ...args.data,
              createdAt,
              updatedAt: createdAt
            }
            groups.push(next)
            return next
          },
          async update(args) {
            const existing = groups.find((group) => group.id === args.where.id)
            if (!existing) throw new Error('group not found')
            Object.assign(existing, args.data)
            return existing
          }
        },
        authUser: {
          async create(args) {
            const next = {
              id: `user-${users.length + 1}`,
              email: args.data.email,
              displayName: args.data.displayName,
              isPlatformUser: args.data.isPlatformUser,
              createdAt
            }
            users.push(next)
            return next
          }
        },
        authUserGroupMembership: {
          async create(args) {
            memberships.push(args.data)
            return args.data
          }
        }
      })
    } as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast(_event: WsEvent) {} } as never,
    router,
    settings: {
      async get(key) {
        if (key === 'sessionDuration') return 'week'
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
      authEnabled: false,
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
    const response = await fetch(`${baseUrl}/bootstrap/admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'Admin@Example.com', displayName: 'Primary Admin' })
    })

    assert.equal(response.status, 201)
    const setCookie = response.headers.get('set-cookie')
    assert.deepEqual(await response.json(), {
      user: {
        id: 'user-1',
        email: 'admin@example.com',
        displayName: 'Primary Admin',
        createdAt: createdAt.toISOString()
      },
      group: {
        id: 'platform-group-admin',
        key: PLATFORM_ADMIN_GROUP_KEY,
        name: 'Admin'
      },
      invite: {
        delivered: true,
        expiresAt: '2026-05-01T00:15:00.000Z',
        previewCode: 'ABCD-EFGH'
      },
      setupRequired: true
    })
    assert.equal(setCookie, null)
    assert.deepEqual(users, [{
      id: 'user-1',
      email: 'admin@example.com',
      displayName: 'Primary Admin',
      isPlatformUser: true,
      createdAt
    }])
    assert.deepEqual(memberships, [{ userId: 'user-1', groupId: 'platform-group-admin' }])
    assert.equal(groups.find((group) => group.key === PLATFORM_ADMIN_GROUP_KEY)?.name, 'Admin')
    assert.equal(issuedTokens.length, 1)
    assert.equal(issuedTokens[0]?.userId, 'user-1')
    assert.equal(issuedTokens[0]?.email, 'admin@example.com')
  } finally {
    await close(server)
  }
})

test('auth-local bootstrap creates a tenant admin account when local auth is enabled for that tenant', async () => {
  prisma.tenant.findUnique = ((async ({ where }: { where: { slug?: string; id?: string } }) => {
    if (where.slug === 'acme' || where.id === 'tenant-1') {
      return {
        id: 'tenant-1',
        slug: 'acme',
        name: 'Acme Co'
      }
    }
    return null
  }) as unknown) as typeof prisma.tenant.findUnique

  const createdAt = new Date('2026-05-01T00:00:00.000Z')
  const users: Array<UserRecord & { isPlatformUser: boolean }> = []
  const tenantMemberships: Array<{ userId: string; tenantId: string }> = []
  const memberships: Array<{ userId: string; groupId: string }> = []
  const issuedTokens: Array<{ userId: string; email: string; tokenHash: string; expiresAt: Date }> = []
  const groups: GroupRecord[] = [{
    id: 'group-admin',
    tenantId: 'tenant-1',
    key: 'admin',
    name: 'Admin',
    description: 'Full access',
    permissions: ['auth.access.view'],
    isSystem: true,
    isEditable: false,
    isRemovable: false,
    createdAt,
    updatedAt: createdAt
  }]

  const plugin = createAuthLocalPlugin({
    async buildStatus() {
      return {
        setupRequired: true,
        sessionDuration: 'day',
        permissions: ['auth.access.view'],
        permissionDefinitions,
        counts: { users: users.length, groups: groups.length, serviceAccounts: 0, passkeys: 0 }
      }
    },
    emailCodeServices: {
      now: () => new Date('2026-05-01T00:00:00.000Z'),
      createCode: () => 'ABCD-EFGH',
      async deliverEmailCode() {
        return { delivered: true, previewCode: 'ABCD-EFGH' }
      }
    }
  })

  const router = express.Router()
  await plugin.register({
    pluginName: 'auth-local',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      authGroup: {
        async findUnique(input: { where: { tenantId_key?: { tenantId: string; key: string }; key?: string; id?: string } }) {
          if (input.where.tenantId_key) {
            const { tenantId, key } = input.where.tenantId_key
            return groups.find((group) => group.tenantId === tenantId && group.key === key) ?? null
          }
          if (input.where.key) return groups.find((group) => group.key === input.where.key) ?? null
          if (input.where.id) return groups.find((group) => group.id === input.where.id) ?? null
          return null
        },
        async create(args: { data: GroupRecord }) {
          groups.push(args.data)
          return args.data
        },
        async update(args: { where: { id: string }; data: Partial<GroupRecord> }) {
          const existing = groups.find((group) => group.id === args.where.id)
          if (!existing) throw new Error('group not found')
          Object.assign(existing, args.data)
          return existing
        }
      },
      authEmailCodeToken: {
        async deleteMany() {
          return { count: 0 }
        },
        async create(args: { data: { userId: string; email: string; tokenHash: string; expiresAt: Date } }) {
          issuedTokens.push(args.data)
          return { id: `token-${issuedTokens.length}`, ...args.data }
        },
        async delete() {
          return null
        }
      },
      $transaction: async <T>(run: (tx: {
        authGroup: {
          findUnique(args: { where: { tenantId_key?: { tenantId: string; key: string }; key?: string; id?: string } }): Promise<GroupRecord | null>
          create(args: { data: GroupRecord }): Promise<GroupRecord>
          update(args: { where: { id: string }; data: Partial<GroupRecord> }): Promise<GroupRecord>
        }
        authUser: {
          create(args: { data: { email: string; displayName: string | null; isPlatformUser: boolean } }): Promise<UserRecord & { isPlatformUser: boolean }>
        }
        authTenantMembership: { create(args: { data: { userId: string; tenantId: string } }): Promise<{ userId: string; tenantId: string }> }
        authUserGroupMembership: { create(args: { data: { userId: string; groupId: string } }): Promise<{ userId: string; groupId: string }> }
      }) => Promise<T>) => run({
        authGroup: {
          async findUnique(input) {
            if (input.where.tenantId_key) {
              const { tenantId, key } = input.where.tenantId_key
              return groups.find((group) => group.tenantId === tenantId && group.key === key) ?? null
            }
            if (input.where.key) return groups.find((group) => group.key === input.where.key) ?? null
            if (input.where.id) return groups.find((group) => group.id === input.where.id) ?? null
            return null
          },
          async create(args) {
            groups.push(args.data)
            return args.data
          },
          async update(args) {
            const existing = groups.find((group) => group.id === args.where.id)
            if (!existing) throw new Error('group not found')
            Object.assign(existing, args.data)
            return existing
          }
        },
        authUser: {
          async create(args) {
            const next = {
              id: `user-${users.length + 1}`,
              email: args.data.email,
              displayName: args.data.displayName,
              isPlatformUser: args.data.isPlatformUser,
              createdAt
            }
            users.push(next)
            return next
          }
        },
        authTenantMembership: {
          async create(args) {
            tenantMemberships.push(args.data)
            return args.data
          }
        },
        authUserGroupMembership: {
          async create(args) {
            memberships.push(args.data)
            return args.data
          }
        }
      })
    } as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast(_event: WsEvent) {} } as never,
    router,
    settings: {
      async get(key) {
        if (key === 'tenant:tenant-1:enabled') return 'true'
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
      authEnabled: false,
      actor: { type: 'anonymous' },
      permissions: [],
      runtimePolicy: { demoMode: false }
    }
    next()
  })
  app.use(installTenantContext())
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
    const response = await fetch(`${baseUrl}/bootstrap/admin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-printstream-tenant': 'acme'
      },
      body: JSON.stringify({ email: 'admin@customer.example', displayName: 'Customer Admin' })
    })

    assert.equal(response.status, 201)
    assert.deepEqual(await response.json(), {
      user: {
        id: 'user-1',
        email: 'admin@customer.example',
        displayName: 'Customer Admin',
        createdAt: createdAt.toISOString()
      },
      group: {
        id: 'group-admin',
        key: 'admin',
        name: 'Admin'
      },
      invite: {
        delivered: true,
        expiresAt: '2026-05-01T00:15:00.000Z',
        previewCode: 'ABCD-EFGH'
      },
      setupRequired: true
    })
    assert.deepEqual(users, [{
      id: 'user-1',
      email: 'admin@customer.example',
      displayName: 'Customer Admin',
      isPlatformUser: false,
      createdAt
    }])
    assert.deepEqual(tenantMemberships, [{ userId: 'user-1', tenantId: 'tenant-1' }])
    assert.deepEqual(memberships, [{ userId: 'user-1', groupId: 'group-admin' }])
    assert.equal(issuedTokens[0]?.email, 'admin@customer.example')
  } finally {
    prisma.tenant.findUnique = originalTenantFindUnique
    await close(server)
  }
})

test('auth-local bootstrap rejects creating a second initial admin', async () => {
  const plugin = createAuthLocalPlugin({
    async ensureDefaultGroups() {},
    async buildStatus() {
      return {
        setupRequired: true,
        sessionDuration: 'day',
        permissions: ['auth.access.view'],
        permissionDefinitions,
        counts: { users: 1, groups: 1, serviceAccounts: 0, passkeys: 0 }
      }
    }
  })

  const router = express.Router()
  await plugin.register({
    pluginName: 'auth-local',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      authGroup: {
        async findUnique() {
          return { id: 'group-admin', key: 'admin', name: 'Admin' }
        }
      },
      $transaction: async () => {
        throw new Error('unexpected transaction')
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
      authEnabled: false,
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
    const response = await fetch(`${baseUrl}/bootstrap/admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com' })
    })

    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'The initial admin account has already been created.' })
  } finally {
    await close(server)
  }
})

test('auth-local bootstrap is blocked in the demo tenant even for signed-in platform admins', async () => {
  prisma.tenant.findUnique = ((async ({ where }: { where: { slug?: string; id?: string } }) => {
    if (where.slug === 'demo' || where.id === 'tenant-demo') {
      return {
        id: 'tenant-demo',
        slug: 'demo',
        name: 'Public Demo'
      }
    }
    return null
  }) as unknown) as typeof prisma.tenant.findUnique

  const plugin = createAuthLocalPlugin({
    async ensureDefaultGroups() {},
    async buildStatus() {
      return {
        setupRequired: true,
        sessionDuration: 'day',
        permissions: ['auth.access.view'],
        permissionDefinitions,
        counts: { users: 0, groups: 0, serviceAccounts: 0, passkeys: 0 }
      }
    }
  })

  const router = express.Router()
  await plugin.register({
    pluginName: 'auth-local',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      $transaction: async () => {
        throw new Error('demo tenant bootstrap must not persist')
      }
    } as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast(_event: WsEvent) {} } as never,
    router,
    settings: {
      async get(key) {
        if (key === 'tenant:tenant-demo:enabled') return 'true'
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
      permissions: [],
      runtimePolicy: { demoMode: false }
    }
    next()
  })
  app.use(installTenantContext())
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
    const response = await fetch(`${baseUrl}/bootstrap/admin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-printstream-tenant': 'demo'
      },
      body: JSON.stringify({ email: 'admin@example.com', displayName: 'Primary Admin' })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: DEMO_AUTH_MUTATION_MESSAGE })
  } finally {
    prisma.tenant.findUnique = originalTenantFindUnique
    await close(server)
  }
})

test('auth-local bootstrap rolls back the created tenant admin when invite delivery fails', async () => {
  prisma.tenant.findUnique = ((async ({ where }: { where: { slug?: string; id?: string } }) => {
    if (where.slug === 'acme' || where.id === 'tenant-1') {
      return {
        id: 'tenant-1',
        slug: 'acme',
        name: 'Acme Co'
      }
    }
    return null
  }) as unknown) as typeof prisma.tenant.findUnique

  const createdAt = new Date('2026-05-01T00:00:00.000Z')
  const users: Array<UserRecord & { isPlatformUser: boolean }> = []
  const tenantMemberships: Array<{ userId: string; tenantId: string }> = []
  const memberships: Array<{ userId: string; groupId: string }> = []
  const issuedTokens: Array<{ id: string; userId: string; email: string; tokenHash: string; expiresAt: Date }> = []
  const groups: GroupRecord[] = [{
    id: 'group-admin',
    tenantId: 'tenant-1',
    key: 'admin',
    name: 'Admin',
    description: 'Full access',
    permissions: ['auth.access.view'],
    isSystem: true,
    isEditable: false,
    isRemovable: false,
    createdAt,
    updatedAt: createdAt
  }]

  const plugin = createAuthLocalPlugin({
    async buildStatus() {
      return {
        setupRequired: true,
        sessionDuration: 'day',
        permissions: ['auth.access.view'],
        permissionDefinitions,
        counts: { users: users.length, groups: groups.length, serviceAccounts: 0, passkeys: 0 }
      }
    },
    emailCodeServices: {
      now: () => new Date('2026-05-01T00:00:00.000Z'),
      createCode: () => 'ABCD-EFGH',
      async deliverEmailCode() {
        throw new HttpError(503, 'Email-code delivery is not configured.')
      }
    }
  })

  const router = express.Router()
  await plugin.register({
    pluginName: 'auth-local',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      authGroup: {
        async findUnique(input: { where: { tenantId_key?: { tenantId: string; key: string }; key?: string; id?: string } }) {
          if (input.where.tenantId_key) {
            const { tenantId, key } = input.where.tenantId_key
            return groups.find((group) => group.tenantId === tenantId && group.key === key) ?? null
          }
          if (input.where.key) return groups.find((group) => group.key === input.where.key) ?? null
          if (input.where.id) return groups.find((group) => group.id === input.where.id) ?? null
          return null
        },
        async create(args: { data: GroupRecord }) {
          groups.push(args.data)
          return args.data
        },
        async update(args: { where: { id: string }; data: Partial<GroupRecord> }) {
          const existing = groups.find((group) => group.id === args.where.id)
          if (!existing) throw new Error('group not found')
          Object.assign(existing, args.data)
          return existing
        }
      },
      authEmailCodeToken: {
        async deleteMany(args: { where: { userId?: string } }) {
          if (args.where.userId) {
            const before = issuedTokens.length
            for (let index = issuedTokens.length - 1; index >= 0; index -= 1) {
              if (issuedTokens[index]?.userId === args.where.userId) {
                issuedTokens.splice(index, 1)
              }
            }
            return { count: before - issuedTokens.length }
          }
          const count = issuedTokens.length
          issuedTokens.length = 0
          return { count }
        },
        async create(args: { data: { userId: string; email: string; tokenHash: string; expiresAt: Date } }) {
          const next = { id: `token-${issuedTokens.length + 1}`, ...args.data }
          issuedTokens.push(next)
          return next
        },
        async delete(args: { where: { id: string } }) {
          const index = issuedTokens.findIndex((token) => token.id === args.where.id)
          if (index >= 0) issuedTokens.splice(index, 1)
          return null
        }
      },
      $transaction: async <T>(run: (tx: {
        authGroup: {
          findUnique(args: { where: { tenantId_key?: { tenantId: string; key: string }; key?: string; id?: string } }): Promise<GroupRecord | null>
          create(args: { data: GroupRecord }): Promise<GroupRecord>
          update(args: { where: { id: string }; data: Partial<GroupRecord> }): Promise<GroupRecord>
        }
        authUser: {
          create(args: { data: { email: string; displayName: string | null; isPlatformUser: boolean } }): Promise<UserRecord & { isPlatformUser: boolean }>
          delete(args: { where: { id: string } }): Promise<void>
        }
        authTenantMembership: {
          create(args: { data: { userId: string; tenantId: string } }): Promise<{ userId: string; tenantId: string }>
          deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>
        }
        authUserGroupMembership: {
          create(args: { data: { userId: string; groupId: string } }): Promise<{ userId: string; groupId: string }>
          deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>
        }
        authEmailCodeToken: {
          deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>
        }
      }) => Promise<T>) => run({
        authGroup: {
          async findUnique(input) {
            if (input.where.tenantId_key) {
              const { tenantId, key } = input.where.tenantId_key
              return groups.find((group) => group.tenantId === tenantId && group.key === key) ?? null
            }
            if (input.where.key) return groups.find((group) => group.key === input.where.key) ?? null
            if (input.where.id) return groups.find((group) => group.id === input.where.id) ?? null
            return null
          },
          async create(args) {
            groups.push(args.data)
            return args.data
          },
          async update(args) {
            const existing = groups.find((group) => group.id === args.where.id)
            if (!existing) throw new Error('group not found')
            Object.assign(existing, args.data)
            return existing
          }
        },
        authUser: {
          async create(args) {
            const next = {
              id: `user-${users.length + 1}`,
              email: args.data.email,
              displayName: args.data.displayName,
              isPlatformUser: args.data.isPlatformUser,
              createdAt
            }
            users.push(next)
            return next
          },
          async delete(args) {
            const index = users.findIndex((user) => user.id === args.where.id)
            if (index >= 0) users.splice(index, 1)
          }
        },
        authTenantMembership: {
          async create(args) {
            tenantMemberships.push(args.data)
            return args.data
          },
          async deleteMany(args) {
            const before = tenantMemberships.length
            for (let index = tenantMemberships.length - 1; index >= 0; index -= 1) {
              if (tenantMemberships[index]?.userId === args.where.userId) {
                tenantMemberships.splice(index, 1)
              }
            }
            return { count: before - tenantMemberships.length }
          }
        },
        authUserGroupMembership: {
          async create(args) {
            memberships.push(args.data)
            return args.data
          },
          async deleteMany(args) {
            const before = memberships.length
            for (let index = memberships.length - 1; index >= 0; index -= 1) {
              if (memberships[index]?.userId === args.where.userId) {
                memberships.splice(index, 1)
              }
            }
            return { count: before - memberships.length }
          }
        },
        authEmailCodeToken: {
          async deleteMany(args) {
            const before = issuedTokens.length
            for (let index = issuedTokens.length - 1; index >= 0; index -= 1) {
              if (issuedTokens[index]?.userId === args.where.userId) {
                issuedTokens.splice(index, 1)
              }
            }
            return { count: before - issuedTokens.length }
          }
        }
      })
    } as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast(_event: WsEvent) {} } as never,
    router,
    settings: {
      async get(key) {
        if (key === 'tenant:tenant-1:enabled') return 'true'
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
      authEnabled: false,
      actor: { type: 'anonymous' },
      permissions: [],
      runtimePolicy: { demoMode: false }
    }
    next()
  })
  app.use(installTenantContext())
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
    const response = await fetch(`${baseUrl}/bootstrap/admin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-printstream-tenant': 'acme'
      },
      body: JSON.stringify({ email: 'admin@customer.example', displayName: 'Customer Admin' })
    })

    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'Email-code delivery is not configured.' })
    assert.deepEqual(users, [])
    assert.deepEqual(tenantMemberships, [])
    assert.deepEqual(memberships, [])
    assert.deepEqual(issuedTokens, [])
  } finally {
    prisma.tenant.findUnique = originalTenantFindUnique
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