process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION, LIBRARY_MANAGE_PERMISSION, PRINTERS_CONTROL_PERMISSION, PRINTERS_CONTROL_REFRESH_SCOPE, PRINTERS_VIEW_PERMISSION, WORKSPACES_MANAGE_PERMISSION, type AuthProviderCapabilities } from '@printstream/shared'
import { authProviderRegistry } from './auth-registry.js'
import { installAuthContext, requestHasPermission } from './auth-context.js'
import { requireRequestPermission } from './authorization.js'
import { HttpError } from './http-error.js'
import { prisma, rootPrisma } from './prisma.js'
import { PUBLIC_DEMO_GUEST_PERMISSIONS } from './public-demo-policy.js'
import { getCurrentWorkspace, installWorkspaceContext } from './workspace-context.js'
import { listAllWorkspaceSupportPermissions } from './support-access.js'

const localAuthCapabilities: AuthProviderCapabilities = {
  signIn: true,
  setup: true,
  accountSecurity: true,
  adminUserProvisioning: true,
  adminUserCredentials: true,
  recentVerificationMethods: ['passkey']
}

const originalSessionFindUnique = prisma.authSession.findUnique
const originalSessionUpdateMany = prisma.authSession.updateMany
const originalServiceAccountFindUnique = prisma.authServiceAccount.findUnique
const originalServiceAccountUpdateMany = prisma.authServiceAccount.updateMany
const originalRootServiceAccountFindUnique = rootPrisma.authServiceAccount.findUnique
const originalRootServiceAccountUpdateMany = rootPrisma.authServiceAccount.updateMany
const originalWorkspaceFindFirst = prisma.workspace.findFirst
const originalRootWorkspaceFindMany = rootPrisma.workspace.findMany
const originalRootSettingFindMany = rootPrisma.setting.findMany
const originalRootSettingFindUnique = rootPrisma.setting.findUnique
const originalSettingFindUnique = prisma.setting.findUnique
const originalAuthUserGroupMembershipFindMany = (prisma as unknown as {
  authUserGroupMembership: {
    findMany: unknown
  }
}).authUserGroupMembership.findMany

afterEach(() => {
  authProviderRegistry.clear()
  prisma.authSession.findUnique = originalSessionFindUnique
  prisma.authSession.updateMany = originalSessionUpdateMany
  prisma.authServiceAccount.findUnique = originalServiceAccountFindUnique
  prisma.authServiceAccount.updateMany = originalServiceAccountUpdateMany
  rootPrisma.authServiceAccount.findUnique = originalRootServiceAccountFindUnique
  rootPrisma.authServiceAccount.updateMany = originalRootServiceAccountUpdateMany
  prisma.workspace.findFirst = originalWorkspaceFindFirst
  rootPrisma.workspace.findMany = originalRootWorkspaceFindMany
  rootPrisma.setting.findMany = originalRootSettingFindMany
  rootPrisma.setting.findUnique = originalRootSettingFindUnique
  prisma.setting.findUnique = originalSettingFindUnique
  ;(prisma as unknown as {
    authUserGroupMembership: {
      findMany: unknown
    }
  }).authUserGroupMembership.findMany = originalAuthUserGroupMembershipFindMany
})

function mockWorkspaceLookup(): void {
  // findFirst, not findUnique: resolution scopes out soft-deleted workspaces,
  // which a unique lookup cannot express. The stub asserts the scope is present
  // rather than merely accepting it — dropping it would let a deleted workspace
  // be entered, which no test above would otherwise notice.
  prisma.workspace.findFirst = ((async (input: { where: { slug?: string; id?: string; deletedAt?: null } }) => {
    assert.equal(input.where.deletedAt, null, 'workspace resolution must exclude deleted workspaces')
    const slug = input.where.slug
    if (slug === 'demo') return { id: 'workspace-demo', slug: 'demo', name: 'Public Demo' }
    if (slug === 'acme') return { id: 'workspace-acme', slug: 'acme', name: 'Acme Co' }
    return null
  }) as unknown) as typeof prisma.workspace.findFirst
}

test('installAuthContext sets an anonymous auth context with runtime policy flags', async () => {
  const app = express()
  app.use(installAuthContext({ demoMode: true }))
  app.get('/context', (request, response) => {
    response.json(request.auth)
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/context`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      authEnabled: false,
      actor: { type: 'anonymous' },
      permissions: [],
      runtimePolicy: {
        demoMode: true
      }
    })
  } finally {
    await close(server)
  }
})

test('installAuthContext keeps auth inactive while the only enabled provider is still in setup', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: true,
    capabilities: localAuthCapabilities
  })

  const app = express()
  app.use(installAuthContext({ demoMode: false }))
  app.get('/context', (request, response) => {
    response.json(request.auth)
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/context`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      authEnabled: false,
      actor: { type: 'anonymous' },
      permissions: [],
      runtimePolicy: {
        demoMode: false
      }
    })
  } finally {
    await close(server)
  }
})

test('installAuthContext enables auth once a provider is setup-complete', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  })

  const app = express()
  app.use(installAuthContext({ demoMode: false }))
  app.get('/context', (request, response) => {
    response.json(request.auth)
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/context`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      authEnabled: true,
      actor: { type: 'anonymous' },
      permissions: [],
      runtimePolicy: {
        demoMode: false
      }
    })
  } finally {
    await close(server)
  }
})

test('installAuthContext resolves workspace-scoped auth enablement before auth middleware sets request workspace', async () => {
  prisma.workspace.findFirst = ((async () => ({
    id: 'workspace-1',
    slug: 'acme',
    name: 'Acme Co'
  })) as unknown) as typeof prisma.workspace.findFirst

  authProviderRegistry.register(async () => ({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: getCurrentWorkspace()?.slug === 'acme',
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  }))

  const app = express()
  app.use(installAuthContext({ demoMode: false }))
  app.get('/context', (request, response) => {
    response.json(request.auth)
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/context`, {
      headers: {
        'x-printstream-workspace': 'acme'
      }
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      authEnabled: true,
      actor: { type: 'anonymous' },
      permissions: [],
      runtimePolicy: {
        demoMode: false
      }
    })
  } finally {
    await close(server)
  }
})

test('installAuthContext grants explicit guest permissions for the public demo workspace', async () => {
  mockWorkspaceLookup()

  const app = express()
  app.use(installAuthContext({ demoMode: false }))
  app.get('/context', (request, response) => {
    response.json(request.auth)
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/context`, {
      headers: { 'x-printstream-workspace': 'demo' }
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      authEnabled: false,
      publicDemoGuest: true,
      actor: { type: 'anonymous' },
      permissions: [...PUBLIC_DEMO_GUEST_PERMISSIONS],
      runtimePolicy: {
        demoMode: true
      }
    })
  } finally {
    await close(server)
  }
})

test('installAuthContext does not grant demo guest permissions to other anonymous workspaces', async () => {
  mockWorkspaceLookup()

  const app = express()
  app.use(installAuthContext({ demoMode: false }))
  app.get('/context', (request, response) => {
    response.json(request.auth)
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/context`, {
      headers: { 'x-printstream-workspace': 'acme' }
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      authEnabled: false,
      actor: { type: 'anonymous' },
      permissions: [],
      runtimePolicy: {
        demoMode: false
      }
    })
  } finally {
    await close(server)
  }
})

test('public demo guests use explicit permissions instead of the auth-disabled workspace bypass', async () => {
  mockWorkspaceLookup()

  const app = express()
  app.use(installAuthContext({ demoMode: false }))
  app.use(installWorkspaceContext())
  app.get('/read', requireRequestPermission(PRINTERS_VIEW_PERMISSION), (_request, response) => {
    response.status(204).end()
  })
  app.post('/write', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), (_request, response) => {
    response.status(204).end()
  })
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
    const headers = { 'x-printstream-workspace': 'demo' }
    const readResponse = await fetch(`http://127.0.0.1:${address.port}/read`, { headers })
    const writeResponse = await fetch(`http://127.0.0.1:${address.port}/write`, { method: 'POST', headers })

    assert.equal(readResponse.status, 204)
    assert.equal(writeResponse.status, 403)
    assert.deepEqual(await writeResponse.json(), { error: 'You do not have permission to perform this action.' })
  } finally {
    await close(server)
  }
})

test('requestHasPermission resolves future child scopes through current parent permissions', () => {
  const allowed = requestHasPermission({
    auth: {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [PRINTERS_CONTROL_PERMISSION],
      runtimePolicy: { demoMode: false }
    }
  } as express.Request, PRINTERS_CONTROL_REFRESH_SCOPE)

  assert.equal(allowed, true)
})

test('installAuthContext resolves a signed-in user from the auth session cookie', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  })

  prisma.authSession.findUnique = ((async () => ({
    id: 'session-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: null,
    user: {
      id: 'user-1',
      isPlatformUser: false,
      workspaceMemberships: [{
        loginDisabled: false,
        workspace: {
          id: 'workspace-1',
          slug: 'acme',
          name: 'Acme Co'
        }
      }],
      memberships: [{ group: { workspaceId: 'workspace-1', permissions: [PRINTERS_CONTROL_PERMISSION] } }]
    },
    serviceAccount: null
  })) as unknown) as typeof prisma.authSession.findUnique
  prisma.authSession.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof prisma.authSession.updateMany

  const app = express()
  app.use(installAuthContext({ demoMode: false }))
  app.get('/context', (request, response) => {
    response.json(request.auth)
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/context`, {
      headers: { Cookie: 'printstream_auth=session-secret' }
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      authEnabled: true,
      actor: {
        type: 'user',
        userId: 'user-1',
        isPlatformUser: false,
        workspace: {
          id: 'workspace-1',
          slug: 'acme',
          name: 'Acme Co'
        }
      },
      permissions: [PRINTERS_CONTROL_PERMISSION],
      runtimePolicy: {
        demoMode: false
      }
    })
  } finally {
    await close(server)
  }
})

test('installAuthContext extends user session expiry and cookie on authenticated activity', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  })

  const now = Date.now()
  const previousLastSeenAt = new Date(now - 10 * 60_000)
  const sessionUpdates: Array<{ where: unknown; data: { expiresAt?: Date; lastSeenAt?: Date } }> = []
  prisma.authSession.findUnique = ((async () => ({
    id: 'session-1',
    revokedAt: null,
    expiresAt: new Date(now + 60_000),
    lastSeenAt: previousLastSeenAt,
    user: {
      id: 'user-1',
      isPlatformUser: false,
      workspaceMemberships: [{
        loginDisabled: false,
        workspace: {
          id: 'workspace-1',
          slug: 'acme',
          name: 'Acme Co'
        }
      }],
      memberships: [{ group: { workspaceId: 'workspace-1', permissions: [PRINTERS_CONTROL_PERMISSION] } }]
    },
    serviceAccount: null
  })) as unknown) as typeof prisma.authSession.findUnique
  prisma.authSession.updateMany = ((async (input: { where: unknown; data: { expiresAt?: Date; lastSeenAt?: Date } }) => {
    sessionUpdates.push(input)
    return { count: 1 }
  }) as unknown) as typeof prisma.authSession.updateMany
  prisma.setting.findUnique = ((async () => ({ value: 'custom:30' })) as unknown) as typeof prisma.setting.findUnique

  const app = express()
  app.use(installAuthContext({ demoMode: false }))
  app.get('/context', (request, response) => {
    response.json(request.auth)
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/context`, {
      headers: { Cookie: 'printstream_auth=session-secret' }
    })

    assert.equal(response.status, 200)
    assert.equal((await response.json()).actor.type, 'user')
    const sessionUpdate = sessionUpdates[0]
    assert.ok(sessionUpdate)
    assert.ok(sessionUpdate.data.expiresAt instanceof Date)
    assert.ok(sessionUpdate.data.lastSeenAt instanceof Date)
    assert.ok(sessionUpdate.data.expiresAt.getTime() - sessionUpdate.data.lastSeenAt.getTime() >= 29 * 60_000)
    const setCookie = response.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /printstream_auth=session-secret/)
    assert.match(setCookie, /Max-Age=1[78]\d\d/)
  } finally {
    await close(server)
  }
})

test('installAuthContext keeps auth enabled when workspace scope comes from the signed-in user session', async () => {
  authProviderRegistry.register(async () => ({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: getCurrentWorkspace()?.slug === 'acme',
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  }))

  prisma.workspace.findFirst = ((async (input: { where: { slug?: string } }) => {
    if (input.where.slug === 'acme') {
      return { id: 'workspace-1', slug: 'acme', name: 'Acme Co' }
    }

    return null
  }) as unknown) as typeof prisma.workspace.findFirst
  prisma.authSession.findUnique = ((async () => ({
    id: 'session-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: null,
    user: {
      id: 'user-1',
      isPlatformUser: false,
      workspaceMemberships: [{
        loginDisabled: false,
        workspace: {
          id: 'workspace-1',
          slug: 'acme',
          name: 'Acme Co'
        }
      }],
      memberships: []
    },
    serviceAccount: null
  })) as unknown) as typeof prisma.authSession.findUnique
  prisma.authSession.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof prisma.authSession.updateMany

  const app = express()
  app.use(installAuthContext({ demoMode: false }))
  app.get('/context', (request, response) => {
    response.json(request.auth)
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/context`, {
      headers: {
        Cookie: 'printstream_auth=session-secret',
        'x-printstream-workspace': 'acme'
      }
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      authEnabled: true,
      actor: {
        type: 'user',
        userId: 'user-1',
        isPlatformUser: false,
        workspace: {
          id: 'workspace-1',
          slug: 'acme',
          name: 'Acme Co'
        }
      },
      permissions: [],
      runtimePolicy: {
        demoMode: false
      }
    })
  } finally {
    await close(server)
  }
})

test('installAuthContext strips platform-only permissions from workspace-scoped user sessions', async () => {
  authProviderRegistry.register(async () => ({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: getCurrentWorkspace()?.slug === 'acme',
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  }))

  prisma.workspace.findFirst = ((async (input: { where: { slug?: string } }) => {
    if (input.where.slug === 'acme') {
      return { id: 'workspace-1', slug: 'acme', name: 'Acme Co' }
    }

    return null
  }) as unknown) as typeof prisma.workspace.findFirst
  prisma.authSession.findUnique = ((async () => ({
    id: 'session-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: null,
    user: {
      id: 'user-1',
      isPlatformUser: false,
      workspaceMemberships: [{
        loginDisabled: false,
        workspace: {
          id: 'workspace-1',
          slug: 'acme',
          name: 'Acme Co'
        }
      }],
      memberships: [{ group: { workspaceId: 'workspace-1', permissions: [PRINTERS_CONTROL_PERMISSION, WORKSPACES_MANAGE_PERMISSION] } }]
    },
    serviceAccount: null
  })) as unknown) as typeof prisma.authSession.findUnique
  prisma.authSession.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof prisma.authSession.updateMany

  const app = express()
  app.use(installAuthContext({ demoMode: false }))
  app.get('/context', (request, response) => {
    response.json(request.auth)
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/context`, {
      headers: {
        Cookie: 'printstream_auth=session-secret',
        'x-printstream-workspace': 'acme'
      }
    })

    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).permissions, [PRINTERS_CONTROL_PERMISSION])
  } finally {
    await close(server)
  }
})

test('installAuthContext applies the workspace support permission allowlist for platform-user sessions', async () => {
  authProviderRegistry.register(async () => ({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: getCurrentWorkspace()?.slug === 'acme',
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  }))

  prisma.workspace.findFirst = ((async (input: { where: { id?: string; slug?: string } }) => {
    if (input.where.id === 'workspace-1' || input.where.slug === 'acme') {
      return { id: 'workspace-1', slug: 'acme', name: 'Acme Co' }
    }

    return null
  }) as unknown) as typeof prisma.workspace.findFirst
  rootPrisma.workspace.findMany = ((async () => ([{
    id: 'workspace-1',
    slug: 'acme',
    name: 'Acme Co'
  }])) as unknown) as typeof rootPrisma.workspace.findMany
  rootPrisma.setting.findMany = ((async () => []) as unknown) as typeof rootPrisma.setting.findMany
  rootPrisma.setting.findUnique = ((async () => ({
    value: JSON.stringify([PRINTERS_CONTROL_PERMISSION])
  })) as unknown) as typeof rootPrisma.setting.findUnique
  prisma.authSession.findUnique = ((async () => ({
    id: 'session-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: null,
    user: {
      id: 'user-1',
      isPlatformUser: true,
      workspaceMemberships: [],
      memberships: [],
      platformMemberships: [{
        group: {
          permissions: [PRINTERS_CONTROL_PERMISSION, WORKSPACES_MANAGE_PERMISSION]
        }
      }]
    },
    serviceAccount: null
  })) as unknown) as typeof prisma.authSession.findUnique
  ;(prisma as unknown as {
    authUserGroupMembership: {
      findMany: (args: unknown) => Promise<Array<{ group: { permissions: string[] } }>>
    }
  }).authUserGroupMembership.findMany = async () => [{
    group: {
      permissions: [PRINTERS_CONTROL_PERMISSION, WORKSPACES_MANAGE_PERMISSION]
    }
  }]
  prisma.authSession.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof prisma.authSession.updateMany

  const app = express()
  app.use(installAuthContext({ demoMode: false }))
  app.get('/context', (request, response) => {
    response.json(request.auth)
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/context`, {
      headers: {
        Cookie: 'printstream_auth=session-secret; printstream_workspace_context=workspace-1'
      }
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      authEnabled: true,
      actor: {
        type: 'user',
        userId: 'user-1',
        isPlatformUser: true,
        workspace: null
      },
      permissions: [PRINTERS_CONTROL_PERMISSION],
      platformPermissions: [WORKSPACES_MANAGE_PERMISSION],
      runtimePolicy: {
        demoMode: false
      }
    })
  } finally {
    await close(server)
  }
})

test('installAuthContext lets platform support bypass ignore disabled workspace support policy', async () => {
  authProviderRegistry.register(async () => ({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: getCurrentWorkspace()?.slug === 'acme',
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  }))

  prisma.workspace.findFirst = ((async (input: { where: { id?: string; slug?: string } }) => {
    if (input.where.id === 'workspace-1' || input.where.slug === 'acme') {
      return { id: 'workspace-1', slug: 'acme', name: 'Acme Co' }
    }

    return null
  }) as unknown) as typeof prisma.workspace.findFirst
  rootPrisma.workspace.findMany = ((async () => ([{
    id: 'workspace-1',
    slug: 'acme',
    name: 'Acme Co'
  }])) as unknown) as typeof rootPrisma.workspace.findMany
  rootPrisma.setting.findMany = ((async () => [{ key: 'workspace:workspace-1:auth:supportAccessEnabled' }]) as unknown) as typeof rootPrisma.setting.findMany
  rootPrisma.setting.findUnique = ((async () => ({
    value: JSON.stringify([PRINTERS_CONTROL_PERMISSION])
  })) as unknown) as typeof rootPrisma.setting.findUnique
  prisma.authSession.findUnique = ((async () => ({
    id: 'session-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: null,
    user: {
      id: 'user-1',
      isPlatformUser: true,
      workspaceMemberships: [],
      memberships: [],
      platformMemberships: [{
        group: {
          permissions: [AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION]
        }
      }]
    },
    serviceAccount: null
  })) as unknown) as typeof prisma.authSession.findUnique
  ;(prisma as unknown as {
    authUserGroupMembership: {
      findMany: (args: unknown) => Promise<Array<{ group: { permissions: string[] } }>>
    }
  }).authUserGroupMembership.findMany = async () => [{
    group: {
      permissions: [AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION]
    }
  }]
  prisma.authSession.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof prisma.authSession.updateMany

  const app = express()
  app.use(installAuthContext({ demoMode: false }))
  app.get('/context', (request, response) => {
    response.json(request.auth)
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/context`, {
      headers: {
        Cookie: 'printstream_auth=session-secret; printstream_workspace_context=workspace-1'
      }
    })

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.platformPermissions, [AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION])
    assert.deepEqual(body.permissions, listAllWorkspaceSupportPermissions())
  } finally {
    await close(server)
  }
})

test('installAuthContext keeps platform users inside auth-disabled workspaces even when support access is disabled', async () => {
  authProviderRegistry.register(async () => ({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: getCurrentWorkspace() == null,
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  }))

  prisma.workspace.findFirst = ((async (input: { where: { id?: string; slug?: string } }) => {
    if (input.where.id === 'workspace-1' || input.where.slug === 'acme') {
      return { id: 'workspace-1', slug: 'acme', name: 'Acme Co' }
    }

    return null
  }) as unknown) as typeof prisma.workspace.findFirst
  rootPrisma.workspace.findMany = ((async () => ([{
    id: 'workspace-1',
    slug: 'acme',
    name: 'Acme Co'
  }])) as unknown) as typeof rootPrisma.workspace.findMany
  rootPrisma.setting.findMany = ((async () => [{ key: 'workspace:workspace-1:auth:supportAccessEnabled' }]) as unknown) as typeof rootPrisma.setting.findMany
  prisma.authSession.findUnique = ((async () => ({
    id: 'session-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: null,
    user: {
      id: 'user-1',
      isPlatformUser: true,
      workspaceMemberships: [],
      memberships: [],
      platformMemberships: []
    },
    serviceAccount: null
  })) as unknown) as typeof prisma.authSession.findUnique
  ;(prisma as unknown as {
    authUserGroupMembership: {
      findMany: (args: unknown) => Promise<Array<{ group: { permissions: string[] } }>>
    }
  }).authUserGroupMembership.findMany = async () => []
  prisma.authSession.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof prisma.authSession.updateMany

  const app = express()
  app.use(installAuthContext({ demoMode: false }))
  app.get('/context', (request, response) => {
    response.json({
      auth: request.auth,
      workspace: request.workspace
    })
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/context`, {
      headers: {
        Cookie: 'printstream_auth=session-secret; printstream_workspace_context=workspace-1'
      }
    })

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.workspace, {
      id: 'workspace-1',
      slug: 'acme',
      name: 'Acme Co'
    })
    assert.equal(body.auth.authEnabled, false)
    assert.equal(body.auth.actor.type, 'user')
    assert.equal(body.auth.actor.isPlatformUser, true)
  } finally {
    await close(server)
  }
})

test('installAuthContext resolves a service account from a bearer token', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  })

  rootPrisma.authServiceAccount.findUnique = ((async () => ({
    id: 'service-account-1',
    lastUsedAt: null,
    revokedAt: null,
    memberships: [{ group: { permissions: [PRINTERS_CONTROL_PERMISSION] } }]
  })) as unknown) as typeof rootPrisma.authServiceAccount.findUnique
  rootPrisma.authServiceAccount.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof rootPrisma.authServiceAccount.updateMany

  const app = express()
  app.use(installAuthContext({ demoMode: false }))
  app.get('/context', (request, response) => {
    response.json(request.auth)
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/context`, {
      headers: { Authorization: 'Bearer bhs_test_token' }
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      authEnabled: true,
      actor: { type: 'anonymous' },
      permissions: [],
      runtimePolicy: {
        demoMode: false
      }
    })
  } finally {
    await close(server)
  }
})

test('service-account bearer auth establishes workspace context without an explicit workspace hint', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  })

  rootPrisma.authServiceAccount.findUnique = ((async () => ({
    id: 'service-account-1',
    workspaceId: 'workspace-1',
    workspace: {
      id: 'workspace-1',
      slug: 'acme',
      name: 'Acme Co'
    },
    lastUsedAt: null,
    revokedAt: null,
    memberships: [{ group: { permissions: ['printers.view'] } }]
  })) as unknown) as typeof rootPrisma.authServiceAccount.findUnique
  rootPrisma.authServiceAccount.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof rootPrisma.authServiceAccount.updateMany

  const app = express()
  app.use(installAuthContext({ demoMode: false }))
  app.use(installWorkspaceContext())
  app.get('/context', (request, response) => {
    response.json({
      auth: request.auth,
      workspace: request.workspace,
      currentWorkspace: getCurrentWorkspace()
    })
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/context`, {
      headers: { Authorization: 'Bearer bhs_test_token' }
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      auth: {
        authEnabled: true,
        actor: {
          type: 'service-account',
          serviceAccountId: 'service-account-1',
          workspace: {
            id: 'workspace-1',
            slug: 'acme',
            name: 'Acme Co'
          }
        },
        permissions: ['printers.view'],
        runtimePolicy: {
          demoMode: false
        }
      },
      workspace: {
        id: 'workspace-1',
        slug: 'acme',
        name: 'Acme Co'
      },
      currentWorkspace: {
        id: 'workspace-1',
        slug: 'acme',
        name: 'Acme Co'
      }
    })
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