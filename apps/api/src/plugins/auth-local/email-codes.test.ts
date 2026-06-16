import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { Permission } from '@printstream/shared'
import type { ApiPluginContext } from '../../plugin/types.js'
import type { RequestAuthActor } from '../../lib/auth-context.js'
import { HttpError } from '../../lib/http-error.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { registerAuthLocalEmailCodeRoutes } from './email-codes.js'

test('email-code request stores a token and returns a demo preview code for a known user', async () => {
  const now = new Date('2026-05-02T12:00:00.000Z')
  const createdTokens: Array<{ id: string; tokenHash: string; userId: string; email: string; redirectTo?: string | null; expiresAt: Date }> = []
  const deliveredCodes: string[] = []
  const deliveryRequests: Array<{ timeZone?: string | null; locale?: string | null }> = []
  const context = createContext({
    prisma: {
      authUser: {
        async findMany() {
          return [{
            id: 'user-1',
            email: 'admin@example.com',
            isPlatformUser: false,
            tenantMemberships: [{
              tenantId: 'tenant-1',
              tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
            }]
          }]
        }
      },
      authEmailCodeToken: {
        async deleteMany() {
          return { count: 0 }
        },
        async create(args: { data: { tokenHash: string; userId: string; email: string; redirectTo?: string | null; expiresAt: Date } }) {
          const created = { id: 'token-1', ...args.data }
          createdTokens.push(created)
          return created
        },
        async delete() {
          return undefined
        }
      }
    } as never
  })

  registerAuthLocalEmailCodeRoutes(context, {
    now: () => now,
    createCode: () => 'ABCD-EFGH',
    async deliverEmailCode(input) {
      deliveredCodes.push(input.code)
      deliveryRequests.push({ timeZone: input.timeZone, locale: input.locale })
      return { previewCode: input.code }
    }
  })

  const app = buildApp(context.router, { actor: { type: 'anonymous' }, permissions: [], demoMode: true })
  const server = await listen(app)
  const address = server.address() as AddressInfo

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/plugins/auth-local/email-codes/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      body: JSON.stringify({ email: 'admin@example.com', redirectTo: '/account', timeZone: 'America/New_York' })
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      delivered: true,
      requiresTenantSelection: false,
      tenants: [],
      expiresAt: '2026-05-02T12:15:00.000Z',
      previewCode: deliveredCodes[0]
    })
    assert.equal(createdTokens.length, 1)
    assert.equal(createdTokens[0]?.redirectTo, '/account')
    assert.equal(deliveredCodes[0], 'ABCD-EFGH')
    assert.deepEqual(deliveryRequests[0], { timeZone: 'America/New_York', locale: 'en-US' })
  } finally {
    await close(server)
  }
})

test('email-code request stays silent for unknown email addresses', async () => {
  let delivered = false
  const context = createContext({
    prisma: {
      authUser: {
        async findMany() {
          return []
        }
      },
      authEmailCodeToken: {
        async deleteMany() {
          return { count: 0 }
        }
      }
    } as never
  })

  registerAuthLocalEmailCodeRoutes(context, {
    now: () => new Date('2026-05-02T12:00:00.000Z'),
    createCode: () => 'ABCD-EFGH',
    async deliverEmailCode() {
      delivered = true
      return { previewCode: null }
    }
  })

  const app = buildApp(context.router, { actor: { type: 'anonymous' }, permissions: [], demoMode: false })
  const server = await listen(app)
  const address = server.address() as AddressInfo

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/plugins/auth-local/email-codes/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com' })
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      delivered: true,
      requiresTenantSelection: false,
      tenants: [],
      expiresAt: '2026-05-02T12:15:00.000Z',
      previewCode: null
    })
    assert.equal(delivered, false)
  } finally {
    await close(server)
  }
})

test('email-code request signs in one global user even when it can access multiple tenants', async () => {
  let delivered = false
  let createdTokenUserId: string | null = null
  const context = createContext({
    prisma: {
      authUser: {
        async findMany() {
          return [
            {
              id: 'user-1',
              email: 'shared@example.com',
              isPlatformUser: false,
              tenantMemberships: [
                { tenantId: 'tenant-1', tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' } },
                { tenantId: 'tenant-2', tenant: { id: 'tenant-2', slug: 'beta', name: 'Beta' } }
              ]
            }
          ]
        }
      },
      authEmailCodeToken: {
        async deleteMany() {
          return { count: 0 }
        },
        async create(args: { data: { userId: string } }) {
          createdTokenUserId = args.data.userId
          return {
            id: 'token-1',
            userId: args.data.userId,
            email: 'shared@example.com',
            tokenHash: 'token-hash',
            redirectTo: null,
            expiresAt: new Date('2026-05-02T12:15:00.000Z')
          }
        },
        async delete() {
          return undefined
        }
      }
    } as never
  })

  registerAuthLocalEmailCodeRoutes(context, {
    now: () => new Date('2026-05-02T12:00:00.000Z'),
    createCode: () => 'ABCD-EFGH',
    async deliverEmailCode() {
      delivered = true
      return { previewCode: null }
    }
  })

  const app = buildApp(context.router, { actor: { type: 'anonymous' }, permissions: [], demoMode: false })
  const server = await listen(app)
  const address = server.address() as AddressInfo

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/plugins/auth-local/email-codes/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'shared@example.com' })
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      delivered: true,
      requiresTenantSelection: false,
      tenants: [],
      expiresAt: '2026-05-02T12:15:00.000Z',
      previewCode: null
    })
    assert.equal(createdTokenUserId, 'user-1')
    assert.equal(delivered, true)
  } finally {
    await close(server)
  }
})

test('email-code verify creates a session and rejects reuse after the first sign-in', async () => {
  const now = new Date('2026-05-02T12:00:00.000Z')
  let consumed = false
  let tenantFilter: unknown = null
  const sessions: Array<{ userId: string; secretHash: string; userAgent?: string | null }> = []
  const context = createContext({
    prisma: {
      authEmailCodeToken: {
        async findFirst(args: { where: unknown }) {
          tenantFilter = args.where
          return {
            id: 'token-1',
            tokenHash: createHash('sha256').update('ABCDEFGH').digest('hex'),
            redirectTo: null,
            consumedAt: consumed ? now : null,
            expiresAt: new Date('2026-05-02T12:15:00.000Z'),
            email: 'admin@example.com',
            user: {
              id: 'user-1',
              email: 'admin@example.com',
              isPlatformUser: false,
              tenantMemberships: [{ tenantId: 'tenant-1' }]
            }
          }
        },
        async updateMany() {
          if (consumed) return { count: 0 }
          consumed = true
          return { count: 1 }
        }
      },
      authSession: {
        async create(args: { data: { userId: string; secretHash: string; userAgent?: string | null } }) {
          sessions.push({ userId: args.data.userId, secretHash: args.data.secretHash, userAgent: args.data.userAgent })
          return {
            id: 'session-1',
            userId: args.data.userId,
            secretHash: args.data.secretHash,
            createdAt: now,
            expiresAt: new Date('2026-05-02T13:00:00.000Z')
          }
        }
      },
      setting: {
        async findUnique() {
          return null
        }
      }
    } as never
  })

  registerAuthLocalEmailCodeRoutes(context, {
    now: () => now,
    createCode: () => 'ABCD-EFGH',
    async deliverEmailCode() {
      return { previewCode: null }
    }
  })

  const app = buildApp(context.router, { actor: { type: 'anonymous' }, permissions: [], demoMode: false })
  const server = await listen(app)
  const address = server.address() as AddressInfo
  const url = `http://127.0.0.1:${address.port}/api/plugins/auth-local/email-codes/verify`

  try {
    const first = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', tenantId: 'tenant-1', code: 'ABCD-EFGH' })
    })
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), {
      authenticated: true,
      actor: {
        type: 'user',
        userId: 'user-1',
        isPlatformUser: false
      },
      redirectTo: null
    })
    assert.match(first.headers.get('set-cookie') ?? '', /printstream_auth=/)
    assert.equal(sessions.length, 1)
    assert.deepEqual(tenantFilter, {
      email: 'admin@example.com',
      consumedAt: null,
      expiresAt: {
        gt: now
      }
    })

    const second = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', tenantId: 'tenant-1', code: 'ABCD-EFGH' })
    })
    assert.equal(second.status, 401)
  } finally {
    await close(server)
  }
})

test('email-code request and verify succeeds when the stored user email casing differs from the submitted email', async () => {
  const now = new Date('2026-05-02T12:00:00.000Z')
  const storedTokens: Array<{
    id: string
    userId: string
    email: string
    tokenHash: string
    redirectTo: string | null
    expiresAt: Date
    consumedAt: Date | null
  }> = []

  const context = createContext({
    prisma: {
      authUser: {
        async findMany() {
          return [{
            id: 'user-1',
            email: 'Admin@Example.com',
            isPlatformUser: false,
            tenantMemberships: [{
              tenantId: 'tenant-1',
              tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
            }]
          }]
        }
      },
      authEmailCodeToken: {
        async deleteMany(args: { where: { OR: Array<{ email?: string; expiresAt?: { lt: Date }; consumedAt?: { not: null } }> } }) {
          const normalizedEmail = args.where.OR.find((entry) => entry.email)?.email ?? null
          const before = storedTokens.length
          for (let index = storedTokens.length - 1; index >= 0; index -= 1) {
            const token = storedTokens[index]
            if (!token) continue
            if (token.expiresAt < now || token.consumedAt !== null || (normalizedEmail !== null && token.email === normalizedEmail)) {
              storedTokens.splice(index, 1)
            }
          }
          return { count: before - storedTokens.length }
        },
        async create(args: { data: { userId: string; email: string; tokenHash: string; redirectTo?: string | null; expiresAt: Date } }) {
          const created = {
            id: `token-${storedTokens.length + 1}`,
            userId: args.data.userId,
            email: args.data.email,
            tokenHash: args.data.tokenHash,
            redirectTo: args.data.redirectTo ?? null,
            expiresAt: args.data.expiresAt,
            consumedAt: null
          }
          storedTokens.push(created)
          return created
        },
        async delete() {
          return undefined
        },
        async findFirst(args: {
          where: { email: string; user?: { tenantId: string }; consumedAt: null; expiresAt: { gt: Date } }
        }) {
          const token = storedTokens
            .filter((entry) => entry.email === args.where.email && entry.consumedAt === null && entry.expiresAt > args.where.expiresAt.gt)
            .at(-1)

          if (!token) return null

          return {
            id: token.id,
            tokenHash: token.tokenHash,
            redirectTo: token.redirectTo,
            consumedAt: token.consumedAt,
            expiresAt: token.expiresAt,
            email: token.email,
            user: {
              id: token.userId,
              email: 'Admin@Example.com',
              isPlatformUser: false,
              tenantMemberships: [{ tenantId: 'tenant-1' }]
            }
          }
        },
        async updateMany(args: { where: { id: string; consumedAt: null }; data: { consumedAt: Date } }) {
          const token = storedTokens.find((entry) => entry.id === args.where.id && entry.consumedAt === null)
          if (!token) return { count: 0 }
          token.consumedAt = args.data.consumedAt
          return { count: 1 }
        }
      },
      authSession: {
        async create(args: { data: { userId: string; secretHash: string; userAgent?: string | null } }) {
          return {
            id: 'session-1',
            userId: args.data.userId,
            secretHash: args.data.secretHash,
            createdAt: now,
            expiresAt: new Date('2026-05-02T13:00:00.000Z')
          }
        }
      },
      setting: {
        async findUnique() {
          return null
        }
      }
    } as never
  })

  registerAuthLocalEmailCodeRoutes(context, {
    now: () => now,
    createCode: () => '5WQV-BYGH',
    async deliverEmailCode() {
      return { previewCode: '5WQV-BYGH' }
    }
  })

  const app = buildApp(context.router, { actor: { type: 'anonymous' }, permissions: [], demoMode: true })
  const server = await listen(app)
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}/api/plugins/auth-local/email-codes`

  try {
    const requestResponse = await fetch(`${baseUrl}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', tenantId: 'tenant-1' })
    })

    assert.equal(requestResponse.status, 200)
    assert.equal(storedTokens[0]?.email, 'admin@example.com')

    const verifyResponse = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', tenantId: 'tenant-1', code: '5WQV-BYGH' })
    })

    assert.equal(verifyResponse.status, 200)
    assert.deepEqual(await verifyResponse.json(), {
      authenticated: true,
      actor: {
        type: 'user',
        userId: 'user-1',
        isPlatformUser: false
      },
      redirectTo: null
    })
  } finally {
    await close(server)
  }
})

test('email-code request rejects mismatched email for pending initial admin', async () => {
  const now = new Date('2026-05-02T12:00:00.000Z')
  const user = {
    id: 'user-1',
    email: 'admin@example.com',
    tenantId: 'tenant-1'
  }

  const context = createContext({
    prisma: {
      authUser: {
        async findMany(args: {
          where: Record<string, unknown>
          take?: number
          orderBy?: { createdAt: 'asc' }
        }) {
          if ('email' in args.where) {
            return []
          }
          return [{ id: user.id, email: user.email }]
        }
      },
      authPasskeyCredential: {
        async count() { return 0 }
      },
      authEmailCodeToken: {
        async deleteMany() { return { count: 0 } },
        async findFirst() { return null }
      },
      setting: {
        async findUnique() { return null }
      }
    } as never
  })

  registerAuthLocalEmailCodeRoutes(context, {
    now: () => now,
    createCode: () => '5WQV-BYGH',
    async deliverEmailCode() {
      return { previewCode: '5WQV-BYGH' }
    }
  })

  const app = buildApp(context.router, { actor: { type: 'anonymous' }, permissions: [], demoMode: true })
  const server = await listen(app)
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}/api/plugins/auth-local/email-codes`

  try {
    // Request with a different email than the admin's registered email.
    // Returns 200 to prevent email enumeration, but no token is stored.
    const requestResponse = await fetch(`${baseUrl}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'attacker@example.com', tenantId: 'tenant-1' })
    })

    assert.equal(requestResponse.status, 200)

    // Verify the attacker cannot actually sign in — no code was issued
    const verifyResponse = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'attacker@example.com', tenantId: 'tenant-1', code: '5WQV-BYGH' })
    })

    assert.equal(verifyResponse.status, 401)
  } finally {
    await close(server)
  }
})

test('email-code request and verify updates the sole initial admin email during first-run setup', async () => {
  const now = new Date('2026-05-02T12:00:00.000Z')
  const user = {
    id: 'user-1',
    email: 'correct@example.com',
    tenantId: 'tenant-1'
  }
  const storedTokens: Array<{
    id: string
    userId: string
    email: string
    tokenHash: string
    redirectTo: string | null
    expiresAt: Date
    consumedAt: Date | null
  }> = []

  const context = createContext({
    prisma: {
      authUser: {
        async findMany(args: {
          where: Record<string, unknown>
          take?: number
          orderBy?: { createdAt: 'asc' }
        }) {
          if ('email' in args.where) {
            return []
          }

          return [{
            id: user.id,
            email: user.email
          }]
        },
        async update(args: { where: { id: string }; data: { email: string } }) {
          assert.equal(args.where.id, user.id)
          user.email = args.data.email
          return { ...user }
        }
      },
      authPasskeyCredential: {
        async count(args: { where: { userId: string } }) {
          assert.equal(args.where.userId, user.id)
          return 0
        }
      },
      authEmailCodeToken: {
        async deleteMany(args: { where: { OR: Array<{ email?: string; expiresAt?: { lt: Date }; consumedAt?: { not: null } }> } }) {
          const normalizedEmail = args.where.OR.find((entry) => entry.email)?.email ?? null
          const before = storedTokens.length
          for (let index = storedTokens.length - 1; index >= 0; index -= 1) {
            const token = storedTokens[index]
            if (!token) continue
            if (token.expiresAt < now || token.consumedAt !== null || (normalizedEmail !== null && token.email === normalizedEmail)) {
              storedTokens.splice(index, 1)
            }
          }
          return { count: before - storedTokens.length }
        },
        async create(args: { data: { userId: string; email: string; tokenHash: string; redirectTo?: string | null; expiresAt: Date } }) {
          const created = {
            id: `token-${storedTokens.length + 1}`,
            userId: args.data.userId,
            email: args.data.email,
            tokenHash: args.data.tokenHash,
            redirectTo: args.data.redirectTo ?? null,
            expiresAt: args.data.expiresAt,
            consumedAt: null
          }
          storedTokens.push(created)
          return created
        },
        async delete() {
          return undefined
        },
        async findFirst(args: {
          where: { email: string; user?: { tenantId: string }; consumedAt: null; expiresAt: { gt: Date } }
        }) {
          const token = storedTokens
            .filter((entry) => entry.email === args.where.email && entry.consumedAt === null && entry.expiresAt > args.where.expiresAt.gt)
            .at(-1)

          if (!token) return null

          return {
            id: token.id,
            tokenHash: token.tokenHash,
            redirectTo: token.redirectTo,
            consumedAt: token.consumedAt,
            expiresAt: token.expiresAt,
            email: token.email,
            user: {
              id: token.userId,
              email: user.email,
              isPlatformUser: false,
              tenantMemberships: [{ tenantId: 'tenant-1' }]
            }
          }
        },
        async updateMany(args: { where: { id: string; consumedAt: null }; data: { consumedAt: Date } }) {
          const token = storedTokens.find((entry) => entry.id === args.where.id && entry.consumedAt === null)
          if (!token) return { count: 0 }
          token.consumedAt = args.data.consumedAt
          return { count: 1 }
        }
      },
      authSession: {
        async create(args: { data: { userId: string; secretHash: string; userAgent?: string | null } }) {
          return {
            id: 'session-1',
            userId: args.data.userId,
            secretHash: args.data.secretHash,
            createdAt: now,
            expiresAt: new Date('2026-05-02T13:00:00.000Z')
          }
        }
      },
      setting: {
        async findUnique() {
          return null
        }
      }
    } as never
  })

  registerAuthLocalEmailCodeRoutes(context, {
    now: () => now,
    createCode: () => '5WQV-BYGH',
    async deliverEmailCode() {
      return { previewCode: '5WQV-BYGH' }
    }
  })

  const app = buildApp(context.router, { actor: { type: 'anonymous' }, permissions: [], demoMode: true })
  const server = await listen(app)
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}/api/plugins/auth-local/email-codes`

  try {
    const requestResponse = await fetch(`${baseUrl}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'correct@example.com', tenantId: 'tenant-1' })
    })

    assert.equal(requestResponse.status, 200)
    assert.equal(storedTokens[0]?.userId, 'user-1')
    assert.equal(storedTokens[0]?.email, 'correct@example.com')

    const verifyResponse = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'correct@example.com', tenantId: 'tenant-1', code: '5WQV-BYGH' })
    })

    assert.equal(verifyResponse.status, 200)
    assert.equal(user.email, 'correct@example.com')
    assert.ok(storedTokens[0]?.consumedAt)
  } finally {
    await close(server)
  }
})

function createContext(overrides: Partial<ApiPluginContext>): ApiPluginContext {
  const prisma = overrides.prisma as {
    authUser?: {
      findFirst?: (args: unknown) => Promise<unknown>
      findMany?: (args: unknown) => Promise<unknown[]>
    }
  } | undefined

  if (prisma?.authUser && !prisma.authUser.findFirst && prisma.authUser.findMany) {
    prisma.authUser.findFirst = async (args: unknown) => (await prisma.authUser?.findMany?.(args))?.[0] ?? null
  }

  return {
    pluginName: 'auth-local',
    logger: { info() {}, warn() {}, error() {} },
    prisma: (prisma ?? {}) as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast() {} } as never,
    router: express.Router(),
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
    registerAuthProvider() {
      return () => undefined
    },
    ...overrides
  }
}

function buildApp(router: express.Router, auth: { actor: RequestAuthActor; permissions: Permission[]; demoMode: boolean }) {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = {
      authEnabled: true,
      actor: auth.actor,
      permissions: auth.permissions,
      runtimePolicy: { demoMode: auth.demoMode }
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