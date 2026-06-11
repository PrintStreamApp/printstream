process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION, AUTH_RECENT_VERIFICATION_REQUIRED_MESSAGE, DEFAULT_APP_LANDING_PAGE, SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import { AUTH_SESSION_COOKIE_NAME } from '../lib/auth-session.js'
import { authProviderRegistry } from '../lib/auth-registry.js'
import { DEMO_SETTINGS_MUTATION_MESSAGE } from '../lib/demo-mode.js'
import { settingsRouter } from './settings.js'
import type { RequestAuthContext } from '../lib/auth-context.js'
import { prisma } from '../lib/prisma.js'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'
import { HttpError } from '../lib/http-error.js'
import { listAllWorkspaceSupportPermissions } from '../lib/support-access.js'
import { installTenantContext } from '../lib/tenant-context.js'

const p = prisma as unknown as Record<string, Record<string, unknown>>
// Auto-restore the prisma/rootPrisma methods these tests override (was a per-method save/restore block).
restorePrismaMethodsAfterEach([
  [p.setting, 'findUnique'],
  [p.setting, 'upsert'],
  [p.authSession, 'findUnique'],
  [p.authUser, 'count']
])

afterEach(() => {
  authProviderRegistry.clear()
})

test('settings read remains available without auth permissions', async () => {
  prisma.setting.findUnique = ((async () => null) as unknown) as typeof prisma.setting.findUnique

  await withSettingsApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/settings`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      appTheme: 'default',
      unconstrainedWidth: false,
      landingPage: DEFAULT_APP_LANDING_PAGE,
      supportAccessEnabled: true,
      supportAccessPermissions: listAllWorkspaceSupportPermissions()
    })
  })
})

test('settings write requires authentication once auth is enabled', async () => {
  await withSettingsApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unconstrainedWidth: true })
    })

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('settings write returns 403 without settings.manage permission', async () => {
  await withSettingsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unconstrainedWidth: true })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('settings write allows actors with settings.manage permission', async () => {
  prisma.setting.upsert = ((async () => ({})) as unknown) as typeof prisma.setting.upsert
  prisma.setting.findUnique = ((async () => null) as unknown) as typeof prisma.setting.findUnique

  await withSettingsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unconstrainedWidth: true })
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      appTheme: 'default',
      unconstrainedWidth: true,
      landingPage: DEFAULT_APP_LANDING_PAGE,
      supportAccessEnabled: true,
      supportAccessPermissions: listAllWorkspaceSupportPermissions()
    })
  })
})

test('settings write is blocked in demo mode even with settings.manage permission', async () => {
  prisma.setting.upsert = ((async () => {
    throw new Error('demo-mode settings writes must not persist')
  }) as unknown) as typeof prisma.setting.upsert

  await withSettingsApp({
    authEnabled: false,
    publicDemoGuest: true,
    actor: { type: 'anonymous' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: true }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unconstrainedWidth: true })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: DEMO_SETTINGS_MUTATION_MESSAGE })
  })
})

test('settings write is blocked in the demo tenant even for a signed-in platform admin', async () => {
  prisma.setting.upsert = ((async () => {
    throw new Error('demo tenant settings writes must not persist')
  }) as unknown) as typeof prisma.setting.upsert

  await withSettingsApp({
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
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unconstrainedWidth: true })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: DEMO_SETTINGS_MUTATION_MESSAGE })
  })
})

test('settings write for support access requires the dedicated permission', async () => {
  prisma.setting.findUnique = ((async () => null) as unknown) as typeof prisma.setting.findUnique

  await withSettingsApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-1',
      tenant: {
        id: 'tenant-1',
        slug: 'alpha',
        name: 'Alpha'
      }
    },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token` },
      body: JSON.stringify({ supportAccessEnabled: false })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('settings write for support access requires recent verification', async () => {
  authProviderRegistry.register({
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
  prisma.setting.findUnique = ((async () => null) as unknown) as typeof prisma.setting.findUnique
  prisma.authSession.findUnique = ((async () => ({
    userId: 'user-1',
    createdAt: new Date(Date.now() - (16 * 60 * 1000)),
    expiresAt: new Date(Date.now() + (60 * 60 * 1000)),
    revokedAt: null
  })) as unknown) as typeof prisma.authSession.findUnique

  await withSettingsApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-1',
      tenant: {
        id: 'tenant-1',
        slug: 'alpha',
        name: 'Alpha'
      }
    },
    permissions: [AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token` },
      body: JSON.stringify({ supportAccessEnabled: false })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: AUTH_RECENT_VERIFICATION_REQUIRED_MESSAGE })
  })
})

test('settings write for support access allows a recently verified admin', async () => {
  prisma.setting.findUnique = ((async () => null) as unknown) as typeof prisma.setting.findUnique
  prisma.setting.upsert = ((async () => ({})) as unknown) as typeof prisma.setting.upsert
  prisma.authSession.findUnique = ((async () => ({
    userId: 'user-1',
    createdAt: new Date(Date.now() - (5 * 60 * 1000)),
    expiresAt: new Date(Date.now() + (60 * 60 * 1000)),
    revokedAt: null
  })) as unknown) as typeof prisma.authSession.findUnique
  prisma.authUser.count = ((async () => 1) as unknown) as typeof prisma.authUser.count

  await withSettingsApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-1',
      tenant: {
        id: 'tenant-1',
        slug: 'alpha',
        name: 'Alpha'
      }
    },
    permissions: [AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token` },
      body: JSON.stringify({ supportAccessEnabled: false, supportAccessPermissions: ['printers.view'] })
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      appTheme: 'default',
      unconstrainedWidth: false,
      landingPage: DEFAULT_APP_LANDING_PAGE,
      supportAccessEnabled: false,
      supportAccessPermissions: ['printers.view']
    })
  })
})

test('settings write for support access rejects disabling support when auth has no enabled admin users', async () => {
  authProviderRegistry.register({
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
  prisma.setting.findUnique = ((async () => null) as unknown) as typeof prisma.setting.findUnique
  prisma.setting.upsert = ((async () => {
    throw new Error('support access should not be disabled without an enabled admin')
  }) as unknown) as typeof prisma.setting.upsert
  prisma.authSession.findUnique = ((async () => ({
    userId: 'user-1',
    createdAt: new Date(Date.now() - (5 * 60 * 1000)),
    expiresAt: new Date(Date.now() + (60 * 60 * 1000)),
    revokedAt: null
  })) as unknown) as typeof prisma.authSession.findUnique
  prisma.authUser.count = ((async () => 0) as unknown) as typeof prisma.authUser.count

  await withSettingsApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-1',
      tenant: {
        id: 'tenant-1',
        slug: 'alpha',
        name: 'Alpha'
      }
    },
    permissions: [AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token` },
      body: JSON.stringify({ supportAccessEnabled: false })
    })

    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), {
      error: 'At least one enabled Admin user must remain before disabling support access.'
    })
  })
})

test('settings write for support access also rejects setup-incomplete auth with no enabled admin users', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey', 'email-code'],
    setupRequired: true,
    capabilities: {
      signIn: true,
      setup: true,
      accountSecurity: true,
      adminUserProvisioning: true,
      adminUserCredentials: true,
      recentVerificationMethods: ['passkey', 'email-code']
    }
  })
  prisma.setting.findUnique = ((async () => null) as unknown) as typeof prisma.setting.findUnique
  prisma.setting.upsert = ((async () => {
    throw new Error('support access should not be disabled while setup-incomplete auth has no admin')
  }) as unknown) as typeof prisma.setting.upsert
  prisma.authSession.findUnique = ((async () => ({
    userId: 'user-1',
    createdAt: new Date(Date.now() - (5 * 60 * 1000)),
    expiresAt: new Date(Date.now() + (60 * 60 * 1000)),
    revokedAt: null
  })) as unknown) as typeof prisma.authSession.findUnique
  prisma.authUser.count = ((async () => 0) as unknown) as typeof prisma.authUser.count

  await withSettingsApp({
    authEnabled: false,
    actor: {
      type: 'user',
      userId: 'user-1',
      tenant: {
        id: 'tenant-1',
        slug: 'alpha',
        name: 'Alpha'
      }
    },
    permissions: [AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token` },
      body: JSON.stringify({ supportAccessEnabled: false })
    })

    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), {
      error: 'At least one enabled Admin user must remain before disabling support access.'
    })
  })
})

async function withSettingsApp(
  auth: RequestAuthContext,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = auth
    next()
  })
  app.use(installTenantContext())
  app.use('/api/settings', settingsRouter)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    await run(baseUrl)
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