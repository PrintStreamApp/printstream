import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { WsEvent } from '@printstream/shared'
import { HttpError } from '../../lib/http-error.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { registerAuthLocalProviderManagementRoutes, type AuthLocalProviderManagementServices } from './provider-management.js'

type GroupRecord = {
  id: string
  key: string | null
  name: string
  permissions: string[]
}

type UserRecord = {
  id: string
  email: string
  displayName: string | null
  loginDisabled: boolean
  groupIds: string[]
  passkeyCount: number
  createdAt: Date
  updatedAt: Date
}

type UserPasskeyRecord = {
  id: string
  userId: string
  nickname: string | null
  aaguid: string | null
  transports: string[]
  backedUp: boolean
  lastUsedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

test('auth-local provider management routes issue invites and manage admin-visible passkeys', async () => {
  const createdAt = new Date('2026-05-02T00:00:00.000Z')
  const groups: GroupRecord[] = [
    { id: 'group-admin', key: 'admin', name: 'Admin', permissions: ['auth.users.edit', 'auth.passkeys.view', 'auth.passkeys.edit', 'auth.passkeys.revoke', 'printers.view'] },
    { id: 'group-viewer', key: 'viewer', name: 'Viewer', permissions: ['printers.view'] }
  ]
  const users: UserRecord[] = [
    {
      id: 'admin-user',
      email: 'admin@example.com',
      displayName: 'Admin',
      loginDisabled: false,
      groupIds: ['group-admin'],
      passkeyCount: 1,
      createdAt,
      updatedAt: createdAt
    },
    {
      id: 'user-2',
      email: 'member@example.com',
      displayName: 'Member',
      loginDisabled: false,
      groupIds: ['group-viewer'],
      passkeyCount: 2,
      createdAt,
      updatedAt: createdAt
    }
  ]
  const passkeys: UserPasskeyRecord[] = [
    {
      id: 'passkey-1',
      userId: 'user-2',
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
      userId: 'user-2',
      nickname: 'Phone',
      aaguid: 'aaguid-2',
      transports: ['hybrid', 'internal'],
      backedUp: false,
      lastUsedAt: null,
      createdAt,
      updatedAt: createdAt
    }
  ]
  const issuedCodes: Array<{ id: string; userId: string; email: string; tokenHash: string; redirectTo: string | null; expiresAt: Date }> = []
  const deliveryRequests: Array<{ inviteUrl?: string | null; timeZone?: string | null; locale?: string | null }> = []

  const app = buildTestApp({
    prisma: {
      authUser: {
        async findFirst(input: { where: { id: string } }) {
          const user = users.find((entry) => entry.id === input.where.id)
          if (!user) return null
          return materializeUser(user, groups)
        }
      },
      authPasskeyCredential: {
        async findMany(input: { where: { userId: string } }) {
          return passkeys.filter((entry) => entry.userId === input.where.userId)
        },
        async findFirst(input: { where: { id: string; userId: string } }) {
          return passkeys.find((entry) => entry.id === input.where.id && entry.userId === input.where.userId) ?? null
        },
        async update(input: { where: { id: string }; data: { nickname: string | null } }) {
          const passkey = passkeys.find((entry) => entry.id === input.where.id)
          if (!passkey) throw new Error('passkey missing')
          passkey.nickname = input.data.nickname
          passkey.updatedAt = createdAt
          return passkey
        },
        async delete(input: { where: { id: string } }) {
          const index = passkeys.findIndex((entry) => entry.id === input.where.id)
          if (index < 0) throw new Error('passkey missing')
          const [removed] = passkeys.splice(index, 1)
          const user = users.find((entry) => entry.id === removed?.userId)
          if (user) user.passkeyCount = Math.max(0, user.passkeyCount - 1)
          return removed
        }
      },
      authEmailCodeToken: {
        async deleteMany() {
          return { count: 0 }
        },
        async create(input: { data: { userId: string; email: string; tokenHash: string; redirectTo: string | null; expiresAt: Date } }) {
          const next = {
            id: `token-${issuedCodes.length + 1}`,
            userId: input.data.userId,
            email: input.data.email,
            tokenHash: input.data.tokenHash,
            redirectTo: input.data.redirectTo,
            expiresAt: input.data.expiresAt
          }
          issuedCodes.push(next)
          return next
        }
      }
    },
    services: {
      now: () => createdAt,
      createCode: () => 'ABCD-EFGH',
      async deliverEmailCode(input) {
        deliveryRequests.push({ inviteUrl: input.inviteUrl, timeZone: input.timeZone, locale: input.locale })
        return { previewCode: 'ABCD-EFGH' }
      }
    },
    auth: {
      authEnabled: true,
      actor: { type: 'user', userId: 'admin-user' },
      // A legitimate manager: holds every permission the target viewer has, plus
      // the auth-management permissions for the routes themselves.
      permissions: ['auth.users.edit', 'auth.passkeys.view', 'auth.passkeys.edit', 'auth.passkeys.revoke', 'printers.view'],
      runtimePolicy: { demoMode: true }
    }
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}/api/plugins/auth-local`

  try {
    const listPasskeysResponse = await fetch(`${baseUrl}/users/user-2/passkeys`)
    assert.equal(listPasskeysResponse.status, 200)
    const listedPasskeys = await listPasskeysResponse.json()
    assert.equal(listedPasskeys.passkeys.length, 2)

    const renamePasskeyResponse = await fetch(`${baseUrl}/users/user-2/passkeys/passkey-2`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: 'Office phone' })
    })
    assert.equal(renamePasskeyResponse.status, 200)
    const renamedPasskey = await renamePasskeyResponse.json()
    assert.equal(renamedPasskey.passkey.nickname, 'Office phone')

    const inviteResponse = await fetch(`${baseUrl}/users/user-2/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-PrintStream-Time-Zone': 'America/Toronto'
      },
      body: JSON.stringify({ inviteUrl: 'https://hub.example.com/auth?invite=1&authMode=email-code&email=member%40example.com&tenantId=tenant-1' })
    })
    assert.equal(inviteResponse.status, 200)
    const invited = await inviteResponse.json()
    assert.equal(invited.invite.previewCode, 'ABCD-EFGH')
    assert.equal(issuedCodes.length, 1)
    assert.equal(issuedCodes[0]?.email, 'member@example.com')
    assert.equal(issuedCodes[0]?.redirectTo, '/account')
    assert.deepEqual(deliveryRequests[0], {
      inviteUrl: 'https://hub.example.com/auth?invite=1&authMode=email-code&email=member%40example.com&tenantId=tenant-1',
      timeZone: 'America/Toronto',
      locale: 'en-US'
    })

    const revokePasskeyResponse = await fetch(`${baseUrl}/users/user-2/passkeys/passkey-1/revoke`, {
      method: 'POST'
    })
    assert.equal(revokePasskeyResponse.status, 204)
    assert.equal(passkeys.length, 1)
    assert.equal(users.find((entry) => entry.id === 'user-2')?.passkeyCount, 1)
  } finally {
    await close(server)
  }
})

test('auth-local provider management denies managing a user whose permissions the actor does not hold', async () => {
  const createdAt = new Date('2026-05-02T00:00:00.000Z')
  // The target is a higher-privilege admin; the acting "manager" holds only the
  // coarse passkey/invite permissions, not the target's printers.* authority.
  const groups: GroupRecord[] = [
    { id: 'group-admin', key: 'admin', name: 'Admin', permissions: ['printers.view', 'printers.manage', 'auth.passkeys.revoke'] }
  ]
  const users: UserRecord[] = [
    { id: 'target-admin', email: 'admin@example.com', displayName: 'Admin', loginDisabled: false, groupIds: ['group-admin'], passkeyCount: 1, createdAt, updatedAt: createdAt }
  ]

  const app = buildTestApp({
    prisma: {
      authUser: {
        async findFirst(input: { where: { id: string } }) {
          const user = users.find((entry) => entry.id === input.where.id)
          return user ? materializeUser(user, groups) : null
        }
      },
      authPasskeyCredential: {
        // The hierarchy guard must fire before any passkey lookup.
        async findFirst() { throw new Error('reached passkey lookup despite hierarchy denial') },
        async findMany() { throw new Error('reached passkey lookup despite hierarchy denial') }
      }
    },
    auth: {
      authEnabled: true,
      actor: { type: 'user', userId: 'lesser-manager' },
      permissions: ['auth.passkeys.view', 'auth.passkeys.revoke', 'auth.users.edit'],
      runtimePolicy: { demoMode: true }
    }
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}/api/plugins/auth-local`

  try {
    const revoke = await fetch(`${baseUrl}/users/target-admin/passkeys/passkey-x/revoke`, { method: 'POST' })
    assert.equal(revoke.status, 403)

    const list = await fetch(`${baseUrl}/users/target-admin/passkeys`)
    assert.equal(list.status, 403)

    const invite = await fetch(`${baseUrl}/users/target-admin/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    assert.equal(invite.status, 403)
  } finally {
    await close(server)
  }
})

test('auth-local provider management routes verify a current-user email change before updating the account', async () => {
  const createdAt = new Date('2026-05-02T00:00:00.000Z')
  const groups: GroupRecord[] = [
    { id: 'group-viewer', key: 'viewer', name: 'Viewer', permissions: ['printers.view'] }
  ]
  const users: UserRecord[] = [
    {
      id: 'user-1',
      email: 'member@example.com',
      displayName: 'Member',
      loginDisabled: false,
      groupIds: ['group-viewer'],
      passkeyCount: 1,
      createdAt,
      updatedAt: createdAt
    }
  ]
  const emailChangeTokens: Array<{
    id: string
    userId: string
    email: string
    tokenHash: string
    createdAt: Date
    expiresAt: Date
    consumedAt: Date | null
  }> = []
  const deliveryRequests: Array<{ timeZone?: string | null; locale?: string | null }> = []

  const app = buildTestApp({
    prisma: {
      authUser: {
        async findUnique(input: { where: { id: string } }) {
          const user = users.find((entry) => entry.id === input.where.id)
          return user ? materializeUser(user, groups) : null
        },
        async findFirst(input: { where: Record<string, unknown> }) {
          if (typeof input.where.id === 'string') {
            const user = users.find((entry) => entry.id === input.where.id)
            return user ? materializeUser(user, groups) : null
          }
          const email = input.where.email as { equals: string; mode: 'insensitive' } | undefined
          const id = input.where.id as { not: string } | undefined
          if (email) {
            const user = users.find((entry) => entry.id !== id?.not && entry.email.toLowerCase() === email.equals.toLowerCase())
            return user ? { id: user.id } : null
          }
          return null
        },
        async update(input: { where: { id: string }; data: Partial<{ email: string; displayName: string | null }> }) {
          const user = users.find((entry) => entry.id === input.where.id)
          if (!user) throw new Error('user missing')
          if (input.data.email !== undefined) user.email = input.data.email
          if (input.data.displayName !== undefined) user.displayName = input.data.displayName
          user.updatedAt = createdAt
          return materializeUser(user, groups)
        }
      },
      authEmailCodeToken: {
        async deleteMany() {
          return { count: 0 }
        },
        async create(input: { data: { userId: string; email: string; tokenHash: string; expiresAt: Date } }) {
          const next = {
            id: `token-${emailChangeTokens.length + 1}`,
            userId: input.data.userId,
            email: input.data.email,
            tokenHash: input.data.tokenHash,
            createdAt,
            expiresAt: input.data.expiresAt,
            consumedAt: null
          }
          emailChangeTokens.push(next)
          return next
        },
        async findFirst(input: { where: { userId: string; email: string; consumedAt: null; expiresAt: { gt: Date } } }) {
          return emailChangeTokens
            .filter((entry) => (
              entry.userId === input.where.userId
              && entry.email === input.where.email
              && entry.consumedAt === null
              && entry.expiresAt > input.where.expiresAt.gt
            ))
            .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null
        },
        async updateMany(input: { where: { id: string; consumedAt: null }; data: { consumedAt: Date } }) {
          const token = emailChangeTokens.find((entry) => entry.id === input.where.id && entry.consumedAt === null)
          if (!token) return { count: 0 }
          token.consumedAt = input.data.consumedAt
          return { count: 1 }
        }
      }
    },
    services: {
      now: () => createdAt,
      createCode: () => 'ABCD-EFGH',
      async deliverEmailCode(input) {
        deliveryRequests.push({ timeZone: input.timeZone, locale: input.locale })
        return { previewCode: 'ABCD-EFGH' }
      }
    },
    auth: {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [],
      runtimePolicy: { demoMode: true }
    }
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}/api/plugins/auth-local`

  try {
    const requestResponse = await fetch(`${baseUrl}/me/email-change/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      body: JSON.stringify({
        email: 'Renamed.User@Example.com',
        timeZone: 'America/Los_Angeles'
      })
    })

    assert.equal(requestResponse.status, 200)
    const requested = await requestResponse.json()
    assert.equal(requested.delivered, true)
    assert.equal(requested.previewCode, 'ABCD-EFGH')
    assert.equal(emailChangeTokens.length, 1)
    assert.equal(emailChangeTokens[0]?.email, 'renamed.user@example.com')
    assert.deepEqual(deliveryRequests[0], { timeZone: 'America/Los_Angeles', locale: 'en-US' })

    const verifyResponse = await fetch(`${baseUrl}/me/email-change/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'Renamed.User@Example.com',
        code: 'ABCD-EFGH',
        displayName: 'Renamed User'
      })
    })

    assert.equal(verifyResponse.status, 200)
    const verified = await verifyResponse.json()
    assert.equal(verified.user.email, 'renamed.user@example.com')
    assert.equal(verified.user.displayName, 'Renamed User')
    assert.ok(emailChangeTokens[0]?.consumedAt)
  } finally {
    await close(server)
  }
})

function buildTestApp(input: {
  prisma: Record<string, unknown>
  services?: Partial<AuthLocalProviderManagementServices>
  auth: express.Request['auth']
}): express.Express {
  const app = express()
  const router = express.Router()
  const services: Partial<AuthLocalProviderManagementServices> = {
    buildStatus: async () => ({
      setupRequired: false,
      sessionDuration: 'day',
      permissions: [],
      permissionDefinitions: [],
      counts: {
        users: 0,
        groups: 0,
        serviceAccounts: 0,
        passkeys: 0
      }
    }),
    syncProviderStatus: () => {},
    ...input.services
  }

  registerAuthLocalProviderManagementRoutes({
    pluginName: 'auth-local',
    logger: { info() {}, warn() {}, error() {} },
    prisma: input.prisma as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast(_event: WsEvent) {} } as never,
    router,
    settings: {
      async get() { return null },
      async set() {},
      async delete() {},
      forTenant() { return this },
    },
    onShutdown() {},
    registerPrintGuard() { return () => undefined },
    registerAuthProvider() { return () => undefined }
  }, services)

  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = input.auth
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

function materializeUser(user: UserRecord, groups: GroupRecord[]) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    loginDisabled: user.loginDisabled,
    isPlatformUser: false,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    memberships: user.groupIds.map((groupId) => ({ group: requireGroup(groups, groupId) })),
    _count: {
      passkeys: user.passkeyCount
    }
  }
}

function requireGroup(groups: GroupRecord[], groupId: string): GroupRecord {
  const group = groups.find((entry) => entry.id === groupId)
  if (!group) throw new Error(`missing group: ${groupId}`)
  return group
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