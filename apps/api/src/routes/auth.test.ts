process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import {
  AUTH_ACCESS_VIEW_PERMISSION,
  AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION,
  AUTH_RECENT_VERIFICATION_REQUIRED_MESSAGE,
  AUTH_ROLES_ASSIGN_PERMISSION,
  AUTH_ROLES_CREATE_PERMISSION,
  AUTH_ROLES_EDIT_PERMISSION,
  AUTH_ROLES_VIEW_PERMISSION,
  AUTH_SERVICE_ACCOUNTS_ASSIGN_ROLES_PERMISSION,
  AUTH_SERVICE_ACCOUNTS_CREATE_PERMISSION,
  AUTH_SESSION_POLICY_MANAGE_PERMISSION,
  AUTH_USERS_ASSIGN_ROLES_PERMISSION,
  AUTH_USERS_CREATE_PERMISSION,
  AUTH_USERS_DISABLE_SIGN_IN_PERMISSION,
  AUTH_USERS_VIEW_PERMISSION,
  filterPermissionsForPlatformContext,
  filterPermissionsForTenantContext,
  permissionValues,
  PRINTERS_MANAGE_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  SETTINGS_MANAGE_PERMISSION,
  TENANTS_MANAGE_PERMISSION
} from '@printstream/shared'
import crypto from 'node:crypto'
import { authRouter } from './auth.js'
import { AUTH_SESSION_COOKIE_NAME } from '../lib/auth-session.js'
import { installAuditLogCapture } from '../lib/audit-logs.js'
import { authProviderRegistry } from '../lib/auth-registry.js'
import type { RequestAuthContext } from '../lib/auth-context.js'
import { env } from '../lib/env.js'
import { HttpError } from '../lib/http-error.js'
import { prisma, rootPrisma } from '../lib/prisma.js'
import { getCurrentTenant, installTenantContext } from '../lib/tenant-context.js'
import { builtInAuthGroupSeeds, builtInPlatformAuthGroupSeeds } from '../lib/default-auth-groups.js'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'

// These three are still read inside individual tests (to detect whether the test stubbed the method),
// so they stay as named references; the rest are tracked only by restorePrismaMethodsAfterEach below.
const originalRootAuthTenantMembershipFindMany = rootPrisma.authTenantMembership.findMany
const originalAuthTenantMembershipFindMany = prisma.authTenantMembership.findMany
const originalAuthTenantMembershipCount = prisma.authTenantMembership.count

// Auto-restore every prisma/rootPrisma method this suite overrides, so the tests no longer hand-track
// ~37 `original*` variables and a matching restore block. Accessed through loose-typed aliases so TS
// does not deep-instantiate the (enormous) Prisma delegate types across this list (TS2589).
const p = prisma as unknown as Record<string, Record<string, unknown>>
const rp = rootPrisma as unknown as Record<string, Record<string, unknown>>
restorePrismaMethodsAfterEach([
  [p.authUser, 'findFirst'],
  [p.authUser, 'findMany'],
  [p.authUser, 'findUnique'],
  [p.authUser, 'update'],
  [p, '$transaction'],
  [p.authGroup, 'create'],
  [p.authGroup, 'findFirst'],
  [p.authGroup, 'findMany'],
  [p.authGroup, 'count'],
  [p.authSession, 'create'],
  [p.authSession, 'findMany'],
  [p.authSession, 'findFirst'],
  [p.authSession, 'findUnique'],
  [p.authSession, 'updateMany'],
  [p.authTenantMembership, 'findMany'],
  [p.authTenantMembership, 'findFirst'],
  [p.authTenantMembership, 'count'],
  [p.authUserGroupMembership, 'deleteMany'],
  [p.authServiceAccount, 'count'],
  [p.setting, 'findUnique'],
  [p.setting, 'upsert'],
  [p.tenant, 'findUnique'],
  [p.tenant, 'findMany'],
  [p.tenant, 'create'],
  [p.tenant, 'update'],
  [p.bridge, 'count'],
  [rp.tenant, 'findMany'],
  [rp.setting, 'findMany'],
  [rp.setting, 'findUnique'],
  [rp.auditLog, 'create'],
  [rp.authGroup, 'create'],
  [rp.authGroup, 'findUnique'],
  [rp.authGroup, 'update'],
  [rp.authUser, 'count'],
  [rp.authTenantMembership, 'findMany'],
  [rp.authTenantMembership, 'count'],
  [rp.authUserGroupMembership, 'createMany']
])

afterEach(() => {
  authProviderRegistry.clear()
})

test('auth bootstrap exposes public demo runtime policy for the reserved demo tenant', async () => {
  prisma.tenant.findUnique = ((async (input: { where: { slug?: string } }) => {
    if (input.where.slug === 'demo') return { id: 'tenant-demo', slug: 'demo', name: 'Public Demo' }
    return null
  }) as unknown) as typeof prisma.tenant.findUnique

  await withAuthApp({
    authEnabled: true,
    publicDemoGuest: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: true }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`, { headers: { 'X-PrintStream-Tenant': 'demo' } })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      authEnabled: false,
      platformAuthEnabled: false,
      setupRequired: false,
      providers: [],
      tenant: { id: 'tenant-demo', slug: 'demo', name: 'Public Demo' },
      memberTenants: [],
      availableTenants: [],
      tenantHasConnectedBridges: false,
      actor: { type: 'anonymous', isPlatformUser: false },
      permissions: [],
      capabilities: {
        canViewAuth: false,
        canManageAuthProviders: false,
        canManageSettings: false,
        canManageSupportAccess: false,
        canManageTenants: false,
        canManagePlugins: false,
        canViewLogs: false
      },
      runtimePolicy: {
        demoMode: true,
        managedBridge: false
      }
    })
  })
})

test('auth bootstrap reports no-auth for a public demo guest even when the demo tenant has an enabled provider', async () => {
  prisma.tenant.findUnique = ((async (input: { where: { slug?: string } }) => {
    if (input.where.slug === 'demo') return { id: 'tenant-demo', slug: 'demo', name: 'Public Demo' }
    return null
  }) as unknown) as typeof prisma.tenant.findUnique
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

  await withAuthApp({
    authEnabled: true,
    publicDemoGuest: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: true }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`, { headers: { 'X-PrintStream-Tenant': 'demo' } })

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.authEnabled, false)
    assert.equal(payload.setupRequired, false)
    assert.deepEqual(payload.runtimePolicy, { demoMode: true, managedBridge: false })
    assert.deepEqual(payload.actor, { type: 'anonymous', isPlatformUser: false })
  })
})

test('auth bootstrap stays in platform context for anonymous requests when a provider is enabled', async () => {
  // An enabled provider keeps the install out of wide-open mode, so an
  // anonymous, context-less request resolves to no tenant rather than being
  // scoped into one.
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: false,
    capabilities: {
      signIn: true,
      setup: true,
      accountSecurity: true,
      adminUserProvisioning: true,
      adminUserCredentials: true,
      recentVerificationMethods: ['passkey']
    }
  })
  prisma.tenant.findUnique = ((async (input: { where: { slug?: string } }) => {
    if (input.where.slug === 'local') {
      return { id: 'tenant-1', slug: 'local', name: 'Local Dev' }
    }

    return null
  }) as unknown) as typeof prisma.tenant.findUnique
  prisma.tenant.findMany = ((async () => ([{ id: 'tenant-1', slug: 'local', name: 'Local Dev' }])) as unknown) as typeof prisma.tenant.findMany

  await withAuthApp({
    authEnabled: false,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`)

    assert.equal(response.status, 200)
    assert.equal((await response.json()).tenant, null)
  })
})

test('auth bootstrap defaults context-less anonymous requests into the single wide-open workspace', async () => {
  rootPrisma.tenant.findMany = ((async () => ([
    { id: 'tenant-1', slug: 'workspace', name: 'My Workspace' }
  ])) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findUnique = ((async () => null) as unknown) as typeof rootPrisma.setting.findUnique
  prisma.bridge.count = ((async () => 0) as unknown) as typeof prisma.bridge.count

  await withAuthApp({
    authEnabled: false,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`)

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.deepEqual(payload.tenant, { id: 'tenant-1', slug: 'workspace', name: 'My Workspace' })
    // Route guards bypass enforcement in this state, so bootstrap must report
    // the workspace permissions the UI is actually allowed to use.
    assert.ok(payload.permissions.includes('printers.view'))
    assert.ok(payload.permissions.includes('library.view'))
  })
})

test('auth bootstrap also defaults the explicit no-context hint into the wide-open workspace', async () => {
  rootPrisma.tenant.findMany = ((async () => ([
    { id: 'tenant-1', slug: 'workspace', name: 'My Workspace' }
  ])) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findUnique = ((async () => null) as unknown) as typeof rootPrisma.setting.findUnique
  prisma.bridge.count = ((async () => 0) as unknown) as typeof prisma.bridge.count

  await withAuthApp({
    authEnabled: false,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    // The web's ambient pages (e.g. `/`) pin "no workspace chosen".
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`, {
      headers: { 'X-PrintStream-Tenant': 'none' }
    })

    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).tenant, { id: 'tenant-1', slug: 'workspace', name: 'My Workspace' })
  })
})

test('auth bootstrap keeps the explicit platform hint on the platform scope', async () => {
  rootPrisma.tenant.findMany = ((async () => ([
    { id: 'tenant-1', slug: 'workspace', name: 'My Workspace' }
  ])) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findUnique = ((async () => null) as unknown) as typeof rootPrisma.setting.findUnique

  await withAuthApp({
    authEnabled: false,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`, {
      headers: { 'X-PrintStream-Tenant': 'platform' }
    })

    assert.equal(response.status, 200)
    assert.equal((await response.json()).tenant, null)
  })
})

test('auth bootstrap keeps requests carrying a live session cookie on the platform scope', async () => {
  rootPrisma.tenant.findMany = ((async () => ([
    { id: 'tenant-1', slug: 'workspace', name: 'My Workspace' }
  ])) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findUnique = ((async () => null) as unknown) as typeof rootPrisma.setting.findUnique
  prisma.authSession.findUnique = ((async () => ({
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000)
  })) as unknown) as typeof prisma.authSession.findUnique

  await withAuthApp({
    authEnabled: false,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`, {
      headers: { Cookie: 'printstream_auth=session-secret' }
    })

    assert.equal(response.status, 200)
    assert.equal((await response.json()).tenant, null)
  })
})

test('auth bootstrap ignores a stale session cookie when resolving the wide-open workspace', async () => {
  rootPrisma.tenant.findMany = ((async () => ([
    { id: 'tenant-1', slug: 'workspace', name: 'My Workspace' }
  ])) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findUnique = ((async () => null) as unknown) as typeof rootPrisma.setting.findUnique
  prisma.bridge.count = ((async () => 0) as unknown) as typeof prisma.bridge.count
  // A leftover cookie from an older deployment that no longer maps to a session.
  prisma.authSession.findUnique = ((async () => null) as unknown) as typeof prisma.authSession.findUnique

  await withAuthApp({
    authEnabled: false,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`, {
      headers: { Cookie: 'printstream_auth=stale-session-secret' }
    })

    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).tenant, { id: 'tenant-1', slug: 'workspace', name: 'My Workspace' })
  })
})

test('auth bootstrap keeps the platform scope when an enabled provider is still awaiting setup', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: true,
    capabilities: {
      signIn: true,
      setup: true,
      accountSecurity: true,
      adminUserProvisioning: true,
      adminUserCredentials: true,
      recentVerificationMethods: ['passkey']
    }
  })
  rootPrisma.tenant.findMany = ((async () => ([
    { id: 'tenant-1', slug: 'workspace', name: 'My Workspace' }
  ])) as unknown) as typeof rootPrisma.tenant.findMany

  await withAuthApp({
    authEnabled: false,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`)

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.tenant, null)
    assert.equal(payload.setupRequired, true)
  })
})

test('auth bootstrap hides tenant options from anonymous platform requests before auth is enabled', async () => {
  await withAuthApp({
    authEnabled: false,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`)

    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).memberTenants, [])
  })
})

test('auth bootstrap still hides tenant options from anonymous platform requests when some tenants are disabled', async () => {
  rootPrisma.setting.findMany = ((async () => ([
    { key: 'tenant:tenant-2:platform:tenantDisabled' }
  ])) as unknown) as typeof rootPrisma.setting.findMany

  await withAuthApp({
    authEnabled: false,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`)

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.deepEqual(payload.memberTenants, [])
    assert.deepEqual(payload.availableTenants, [])
  })
})

test('auth bootstrap includes registered provider metadata', async () => {
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
  prisma.authUser.findUnique = ((async () => ({
    email: 'admin@example.com',
    displayName: 'Primary Admin'
  })) as unknown) as typeof prisma.authUser.findUnique
  prisma.authUser.findMany = ((async () => ([])) as unknown) as typeof prisma.authUser.findMany

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      authEnabled: false,
      platformAuthEnabled: false,
      setupRequired: true,
      tenant: null,
      memberTenants: [],
      availableTenants: [],
      tenantHasConnectedBridges: false,
      providers: [{
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
      }],
      actor: {
        type: 'user',
        userId: 'user-1',
        email: 'admin@example.com',
        displayName: 'Primary Admin',
        isPlatformUser: false,
      },
      permissions: [PRINTERS_MANAGE_PERMISSION],
      capabilities: {
        canViewAuth: true,
        canManageAuthProviders: true,
        canManageSettings: false,
        canManageSupportAccess: false,
        canManageTenants: false,
        canManagePlugins: false,
        canViewLogs: false
      },
      runtimePolicy: {
        demoMode: false,
        managedBridge: false
      }
    })
  })
})

test('tenant auth bootstrap reports platform auth state separately from tenant auth state', async () => {
  prisma.tenant.findUnique = ((async (input: { where: { slug?: string } }) => {
    if (input.where.slug === 'alpha') {
      return { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    }

    return null
  }) as unknown) as typeof prisma.tenant.findUnique
  authProviderRegistry.register(() => {
    const tenant = getCurrentTenant()
    return {
      id: 'auth-local',
      label: 'Local Auth',
      enabled: tenant == null,
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
    }
  })

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`, {
      headers: { 'x-printstream-tenant': 'alpha' }
    })

    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()), {
      authEnabled: false,
      platformAuthEnabled: true,
      setupRequired: false,
      tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
      memberTenants: [],
      availableTenants: [],
      tenantHasConnectedBridges: false,
      providers: [{
        id: 'auth-local',
        label: 'Local Auth',
        enabled: false,
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
      }],
      actor: { type: 'anonymous', isPlatformUser: false },
      permissions: [],
      capabilities: {
        canViewAuth: false,
        canManageAuthProviders: false,
        canManageSettings: false,
        canManageSupportAccess: false,
        canManageTenants: false,
        canManagePlugins: false,
        canViewLogs: false
      },
      runtimePolicy: { demoMode: false, managedBridge: false }
    })
  })
})

test('tenant auth bootstrap reports whether the active workspace has connected bridges', async () => {
  prisma.tenant.findUnique = ((async (input: { where: { slug?: string } }) => {
    if (input.where.slug === 'alpha') {
      return { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    }

    return null
  }) as unknown) as typeof prisma.tenant.findUnique
  prisma.bridge.count = ((async () => 2) as unknown) as typeof prisma.bridge.count

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1', tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' } },
    permissions: [PRINTERS_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`, {
      headers: { 'x-printstream-tenant': 'alpha' }
    })

    assert.equal(response.status, 200)
    assert.equal((await response.json()).tenantHasConnectedBridges, true)
  })
})

test('tenant auth bootstrap reports managed-bridge mode when the server secret is set', async () => {
  const originalManagedBridge = env.MANAGED_BRIDGE
  env.MANAGED_BRIDGE = true
  prisma.tenant.findUnique = ((async () => ({ id: 'tenant-1', slug: 'alpha', name: 'Alpha' })) as unknown) as typeof prisma.tenant.findUnique
  prisma.bridge.count = ((async () => 1) as unknown) as typeof prisma.bridge.count

  try {
    await withAuthApp({
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1', tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' } },
      permissions: [PRINTERS_VIEW_PERMISSION],
      runtimePolicy: { demoMode: false }
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/auth/bootstrap`, {
        headers: { 'x-printstream-tenant': 'alpha' }
      })

      assert.equal(response.status, 200)
      assert.equal((await response.json()).runtimePolicy.managedBridge, true)
    })
  } finally {
    env.MANAGED_BRIDGE = originalManagedBridge
  }
})

test('auth bootstrap does not stay in global setup mode once any enabled provider is already active', async () => {
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
  authProviderRegistry.register({
    id: 'auth-oauth',
    label: 'Single Sign-On',
    enabled: true,
    methods: ['oauth'],
    setupRequired: true,
    capabilities: {
      signIn: true,
      setup: true,
      accountSecurity: false,
      adminUserProvisioning: false,
      adminUserCredentials: false,
      recentVerificationMethods: []
    }
  })

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`)
    const payload = await response.json()

    assert.equal(response.status, 200)
    assert.equal(payload.authEnabled, true)
    assert.equal(payload.setupRequired, false)
  })
})

test('auth bootstrap only lists the active tenant for a tenant-scoped user', async () => {
  rootPrisma.tenant.findMany = ((async () => ([
    { id: 'tenant-1', _count: { authMemberships: 3, printers: 5 } },
    { id: 'tenant-2', _count: { authMemberships: 1, printers: 2 } }
  ])) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.authTenantMembership.findMany = ((async () => ([
    { tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' } },
    { tenant: { id: 'tenant-2', slug: 'beta', name: 'Beta' } }
  ])) as unknown) as typeof rootPrisma.authTenantMembership.findMany

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-1',
      tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`)

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.deepEqual(payload.memberTenants, [
      { id: 'tenant-1', slug: 'alpha', name: 'Alpha', userCount: 3, printerCount: 5 },
      { id: 'tenant-2', slug: 'beta', name: 'Beta', userCount: 1, printerCount: 2 }
    ])
    assert.deepEqual(payload.availableTenants, [
      { id: 'tenant-1', slug: 'alpha', name: 'Alpha', userCount: 3, printerCount: 5 },
      { id: 'tenant-2', slug: 'beta', name: 'Beta', userCount: 1, printerCount: 2 }
    ])
  })
})

test('auth bootstrap includes tenant descriptions in available workspace summaries', async () => {
  rootPrisma.tenant.findMany = ((async () => ([
    { id: 'tenant-1', _count: { authMemberships: 2, printers: 4 } },
    { id: 'tenant-2', _count: { authMemberships: 1, printers: 0 } }
  ])) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.authTenantMembership.findMany = ((async () => ([
    {
      tenant: {
        id: 'tenant-1',
        slug: 'alpha',
        name: 'Alpha',
        description: 'Runs the alpha production line.'
      }
    },
    {
      tenant: {
        id: 'tenant-2',
        slug: 'beta',
        name: 'Beta',
        description: null
      }
    }
  ])) as unknown) as typeof rootPrisma.authTenantMembership.findMany

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-1',
      tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`)

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.deepEqual(payload.memberTenants, [
      {
        id: 'tenant-1',
        slug: 'alpha',
        name: 'Alpha',
        description: 'Runs the alpha production line.',
        userCount: 2,
        printerCount: 4
      },
      {
        id: 'tenant-2',
        slug: 'beta',
        name: 'Beta',
        description: null,
        userCount: 1,
        printerCount: 0
      }
    ])
    assert.deepEqual(payload.availableTenants, [
      {
        id: 'tenant-1',
        slug: 'alpha',
        name: 'Alpha',
        description: 'Runs the alpha production line.',
        userCount: 2,
        printerCount: 4
      },
      {
        id: 'tenant-2',
        slug: 'beta',
        name: 'Beta',
        description: null,
        userCount: 1,
        printerCount: 0
      }
    ])
  })
})

test('auth bootstrap lists all tenants for a platform admin user unless a tenant opts out', async () => {
  rootPrisma.tenant.findMany = ((async (args?: { select?: { _count?: unknown } }) => (
    args?.select && '_count' in args.select
      ? [
          { id: 'tenant-1', _count: { authMemberships: 4, printers: 6 } },
          { id: 'tenant-3', _count: { authMemberships: 2, printers: 1 } }
        ]
      : [
          { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
          { id: 'tenant-2', slug: 'beta', name: 'Beta' },
          { id: 'tenant-3', slug: 'gamma', name: 'Gamma' }
        ]
  )) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findMany = ((async () => ([
    { key: 'tenant:tenant-2:auth:supportAccessEnabled' }
  ])) as unknown) as typeof rootPrisma.setting.findMany

  prisma.authUser.findUnique = ((async () => ({
    email: 'platform@example.com',
    displayName: 'Platform Admin'
  })) as unknown) as typeof prisma.authUser.findUnique

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1', isPlatformUser: true },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`)

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.deepEqual(payload.memberTenants, [])
    assert.deepEqual(payload.availableTenants, [
      { id: 'tenant-1', slug: 'alpha', name: 'Alpha', userCount: 4, printerCount: 6 },
      { id: 'tenant-3', slug: 'gamma', name: 'Gamma', userCount: 2, printerCount: 1 }
    ])
  })
})

test('auth bootstrap still filters support-disabled tenants for a platform admin when tenant auth is disabled in the active workspace', async () => {
  rootPrisma.tenant.findMany = ((async (args?: { select?: { _count?: unknown } }) => (
    args?.select && '_count' in args.select
      ? [
          { id: 'tenant-1', _count: { authMemberships: 4, printers: 6 } },
          { id: 'tenant-3', _count: { authMemberships: 2, printers: 1 } }
        ]
      : [
          { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
          { id: 'tenant-2', slug: 'beta', name: 'Beta' },
          { id: 'tenant-3', slug: 'gamma', name: 'Gamma' }
        ]
  )) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findMany = ((async () => ([
    { key: 'tenant:tenant-2:auth:supportAccessEnabled' }
  ])) as unknown) as typeof rootPrisma.setting.findMany
  prisma.authUser.findUnique = ((async () => ({
    email: 'platform@example.com',
    displayName: 'Platform Admin'
  })) as unknown) as typeof prisma.authUser.findUnique

  await withAuthApp({
    authEnabled: false,
    actor: {
      type: 'user',
      userId: 'user-1',
      isPlatformUser: true,
      tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`)

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.deepEqual(payload.memberTenants, [])
    assert.deepEqual(payload.availableTenants, [
      { id: 'tenant-1', slug: 'alpha', name: 'Alpha', userCount: 4, printerCount: 6 },
      { id: 'tenant-3', slug: 'gamma', name: 'Gamma', userCount: 2, printerCount: 1 }
    ])
  })
})

test('auth bootstrap still hides support-disabled tenants for a platform admin already inside another tenant workspace', async () => {
  rootPrisma.tenant.findMany = ((async (args?: { select?: { _count?: unknown } }) => (
    args?.select && '_count' in args.select
      ? [
          { id: 'tenant-1', _count: { authMemberships: 4, printers: 6 } },
          { id: 'tenant-3', _count: { authMemberships: 2, printers: 1 } }
        ]
      : [
          { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
          { id: 'tenant-2', slug: 'beta', name: 'Beta' },
          { id: 'tenant-3', slug: 'gamma', name: 'Gamma' }
        ]
  )) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findMany = ((async () => ([
    { key: 'tenant:tenant-2:auth:supportAccessEnabled' }
  ])) as unknown) as typeof rootPrisma.setting.findMany

  prisma.authUser.findUnique = ((async () => ({
    email: 'platform@example.com',
    displayName: 'Platform Admin'
  })) as unknown) as typeof prisma.authUser.findUnique

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-1',
      isPlatformUser: true,
      tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`)

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.deepEqual(payload.memberTenants, [])
    assert.deepEqual(payload.availableTenants, [
      { id: 'tenant-1', slug: 'alpha', name: 'Alpha', userCount: 4, printerCount: 6 },
      { id: 'tenant-3', slug: 'gamma', name: 'Gamma', userCount: 2, printerCount: 1 }
    ])
  })
})

test('auth bootstrap clears a disabled tenant context cookie for a platform admin', async () => {
  prisma.tenant.findUnique = ((async (input: { where: { id?: string } }) => {
    if (input.where.id === 'tenant-2') {
      return { id: 'tenant-2', slug: 'beta', name: 'Beta' }
    }

    return null
  }) as unknown) as typeof prisma.tenant.findUnique
  rootPrisma.tenant.findMany = ((async (input: { where?: { id?: string } }) => {
    if (input.where?.id === 'tenant-2') {
      return [{ id: 'tenant-2', slug: 'beta', name: 'Beta' }]
    }

    return [{ id: 'tenant-2', slug: 'beta', name: 'Beta' }]
  }) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findMany = ((async () => ([
    { key: 'tenant:tenant-2:auth:supportAccessEnabled' }
  ])) as unknown) as typeof rootPrisma.setting.findMany
  prisma.authUser.findUnique = ((async () => ({
    email: 'platform@example.com',
    displayName: 'Platform Admin'
  })) as unknown) as typeof prisma.authUser.findUnique

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1', isPlatformUser: true },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`, {
      headers: { Cookie: 'printstream_tenant_context=tenant-2' }
    })

    assert.equal(response.status, 200)
    assert.equal((await response.json()).tenant, null)
  })
})

test('auth bootstrap ignores a tenant context cookie when the browser sends a neutral workspace hint', async () => {
  rootPrisma.tenant.findMany = ((async (args?: { select?: { _count?: unknown } }) => (
    args?.select && '_count' in args.select
      ? [{ id: 'tenant-2', _count: { authMemberships: 2, printers: 3 } }]
      : [{ id: 'tenant-2', slug: 'beta', name: 'Beta' }]
  )) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findMany = ((async () => []) as unknown) as typeof rootPrisma.setting.findMany
  prisma.authUser.findUnique = ((async () => ({
    email: 'platform@example.com',
    displayName: 'Platform Admin'
  })) as unknown) as typeof prisma.authUser.findUnique

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1', isPlatformUser: true },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`, {
      headers: {
        Cookie: 'printstream_tenant_context=tenant-2',
        'X-PrintStream-Tenant': 'none'
      }
    })

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.tenant, null)
    assert.deepEqual(payload.availableTenants, [
      { id: 'tenant-2', slug: 'beta', name: 'Beta', userCount: 2, printerCount: 3 }
    ])
  })
})

test('auth bootstrap includes tenants that have no matching tenant user for the platform admin', async () => {
  rootPrisma.tenant.findMany = ((async (args?: { select?: { _count?: unknown } }) => (
    args?.select && '_count' in args.select
      ? [
          { id: 'tenant-1', _count: { authMemberships: 4, printers: 6 } },
          { id: 'tenant-2', _count: { authMemberships: 2, printers: 3 } }
        ]
      : [
          { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
          { id: 'tenant-2', slug: 'beta', name: 'Beta' }
        ]
  )) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findMany = ((async () => []) as unknown) as typeof rootPrisma.setting.findMany
  prisma.authUser.findUnique = ((async () => ({
    email: 'platform@example.com',
    displayName: 'Platform Admin'
  })) as unknown) as typeof prisma.authUser.findUnique

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1', isPlatformUser: true },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`)

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.deepEqual(payload.memberTenants, [])
    assert.deepEqual(payload.availableTenants, [
      { id: 'tenant-1', slug: 'alpha', name: 'Alpha', userCount: 4, printerCount: 6 },
      { id: 'tenant-2', slug: 'beta', name: 'Beta', userCount: 2, printerCount: 3 }
    ])
  })
})

test('auth bootstrap separates personal memberships from broader accessible workspaces for platform users', async () => {
  rootPrisma.tenant.findMany = ((async (args?: { select?: { _count?: unknown } }) => (
    args?.select && '_count' in args.select
      ? [
          { id: 'tenant-1', _count: { authMemberships: 4, printers: 6 } },
          { id: 'tenant-2', _count: { authMemberships: 2, printers: 3 } }
        ]
      : [
          { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
          { id: 'tenant-2', slug: 'beta', name: 'Beta' }
        ]
  )) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findMany = ((async () => []) as unknown) as typeof rootPrisma.setting.findMany
  rootPrisma.authTenantMembership.findMany = ((async () => ([
    {
      tenant: {
        id: 'tenant-2',
        slug: 'beta',
        name: 'Beta',
        description: null
      }
    }
  ])) as unknown) as typeof rootPrisma.authTenantMembership.findMany
  prisma.authUser.findUnique = ((async () => ({
    email: 'platform@example.com',
    displayName: 'Platform Admin'
  })) as unknown) as typeof prisma.authUser.findUnique

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1', isPlatformUser: true },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`)
    const payload = await response.json()

    assert.equal(response.status, 200)
    assert.deepEqual(payload.memberTenants, [
      { id: 'tenant-2', slug: 'beta', name: 'Beta', description: null, userCount: 2, printerCount: 3 }
    ])
    assert.deepEqual(payload.availableTenants, [
      { id: 'tenant-1', slug: 'alpha', name: 'Alpha', userCount: 4, printerCount: 6 },
      { id: 'tenant-2', slug: 'beta', name: 'Beta', userCount: 2, printerCount: 3 }
    ])
  })
})

test('auth bootstrap keeps personal memberships visible while a platform user is inside a support-access workspace', async () => {
  rootPrisma.tenant.findMany = ((async (args?: { select?: { _count?: unknown } }) => (
    args?.select && '_count' in args.select
      ? [
          { id: 'tenant-1', _count: { authMemberships: 4, printers: 6 } },
          { id: 'tenant-2', _count: { authMemberships: 2, printers: 3 } },
          { id: 'tenant-3', _count: { authMemberships: 1, printers: 1 } }
        ]
      : [
          { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
          { id: 'tenant-2', slug: 'beta', name: 'Beta' },
          { id: 'tenant-3', slug: 'gamma', name: 'Gamma' }
        ]
  )) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findMany = ((async () => []) as unknown) as typeof rootPrisma.setting.findMany
  rootPrisma.authTenantMembership.findMany = ((async () => ([
    {
      tenant: {
        id: 'tenant-2',
        slug: 'beta',
        name: 'Beta',
        description: null
      }
    },
    {
      tenant: {
        id: 'tenant-3',
        slug: 'gamma',
        name: 'Gamma',
        description: null
      }
    }
  ])) as unknown) as typeof rootPrisma.authTenantMembership.findMany
  prisma.authTenantMembership.findMany = ((async () => ([
    {
      tenant: {
        id: 'tenant-1',
        slug: 'alpha',
        name: 'Alpha',
        description: null
      }
    }
  ])) as unknown) as typeof prisma.authTenantMembership.findMany
  prisma.authUser.findUnique = ((async () => ({
    email: 'platform@example.com',
    displayName: 'Platform Admin'
  })) as unknown) as typeof prisma.authUser.findUnique

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-1',
      isPlatformUser: true,
      tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`)
    const payload = await response.json()

    assert.equal(response.status, 200)
    assert.deepEqual(payload.memberTenants, [
      { id: 'tenant-2', slug: 'beta', name: 'Beta', description: null, userCount: 2, printerCount: 3 },
      { id: 'tenant-3', slug: 'gamma', name: 'Gamma', description: null, userCount: 1, printerCount: 1 }
    ])
    assert.deepEqual(payload.availableTenants, [
      { id: 'tenant-1', slug: 'alpha', name: 'Alpha', userCount: 4, printerCount: 6 },
      { id: 'tenant-2', slug: 'beta', name: 'Beta', userCount: 2, printerCount: 3 },
      { id: 'tenant-3', slug: 'gamma', name: 'Gamma', userCount: 1, printerCount: 1 }
    ])
  })
})

test('auth bootstrap keeps personal memberships visible while a platform user is inside a support-access workspace with tenant auth disabled', async () => {
  rootPrisma.tenant.findMany = ((async (args?: { select?: { _count?: unknown } }) => (
    args?.select && '_count' in args.select
      ? [
          { id: 'tenant-1', _count: { authMemberships: 4, printers: 6 } },
          { id: 'tenant-2', _count: { authMemberships: 2, printers: 3 } },
          { id: 'tenant-3', _count: { authMemberships: 1, printers: 1 } }
        ]
      : [
          { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
          { id: 'tenant-2', slug: 'beta', name: 'Beta' },
          { id: 'tenant-3', slug: 'gamma', name: 'Gamma' }
        ]
  )) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findMany = ((async () => []) as unknown) as typeof rootPrisma.setting.findMany
  rootPrisma.authTenantMembership.findMany = ((async () => ([
    {
      tenant: {
        id: 'tenant-2',
        slug: 'beta',
        name: 'Beta',
        description: null
      }
    },
    {
      tenant: {
        id: 'tenant-3',
        slug: 'gamma',
        name: 'Gamma',
        description: null
      }
    }
  ])) as unknown) as typeof rootPrisma.authTenantMembership.findMany
  prisma.authUser.findUnique = ((async () => ({
    email: 'platform@example.com',
    displayName: 'Platform Admin'
  })) as unknown) as typeof prisma.authUser.findUnique

  await withAuthApp({
    authEnabled: false,
    actor: {
      type: 'user',
      userId: 'user-1',
      isPlatformUser: true,
      tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`)
    const payload = await response.json()

    assert.equal(response.status, 200)
    assert.equal(payload.authEnabled, false)
    assert.deepEqual(payload.memberTenants, [
      { id: 'tenant-2', slug: 'beta', name: 'Beta', description: null, userCount: 2, printerCount: 3 },
      { id: 'tenant-3', slug: 'gamma', name: 'Gamma', description: null, userCount: 1, printerCount: 1 }
    ])
    assert.deepEqual(payload.availableTenants, [
      { id: 'tenant-1', slug: 'alpha', name: 'Alpha', userCount: 4, printerCount: 6 },
      { id: 'tenant-2', slug: 'beta', name: 'Beta', userCount: 2, printerCount: 3 },
      { id: 'tenant-3', slug: 'gamma', name: 'Gamma', userCount: 1, printerCount: 1 }
    ])
  })
})

test('auth switch-tenant lets a tenant member switch without reauthenticating', async () => {
  prisma.authTenantMembership.findFirst = ((async () => ({ tenantId: 'tenant-2' })) as unknown) as typeof prisma.authTenantMembership.findFirst

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-1',
      tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/switch-tenant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'printstream_auth=session-secret'
      },
      body: JSON.stringify({ tenantId: 'tenant-2' })
    })

    assert.equal(response.status, 204)
    assert.match(response.headers.get('set-cookie') ?? '', /printstream_tenant_context=tenant-2/)
  })
})

test('auth switch-tenant rejects disabled workspaces for platform users', async () => {
  rootPrisma.setting.findUnique = ((async (input: { where: { key: string } }) => {
    if (input.where.key === 'tenant:tenant-2:platform:tenantDisabled') {
      return { value: 'true' }
    }

    return null
  }) as unknown) as typeof rootPrisma.setting.findUnique

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1', isPlatformUser: true },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/switch-tenant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'printstream_auth=session-secret'
      },
      body: JSON.stringify({ tenantId: 'tenant-2' })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'This workspace is disabled.' })
  })
})

test('auth tenant-context stores the selected platform admin tenant context cookie and can switch back to platform mode', async () => {
  rootPrisma.tenant.findMany = ((async (input: { where?: { id?: string } }) => {
    if (input.where?.id) {
      return [{ id: input.where.id, slug: 'beta', name: 'Beta' }]
    }

    return []
  }) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findMany = ((async () => []) as unknown) as typeof rootPrisma.setting.findMany
  rootPrisma.authTenantMembership.findMany = ((async () => ([{ tenantId: 'tenant-2' }])) as unknown) as typeof rootPrisma.authTenantMembership.findMany

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1', isPlatformUser: true },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const tenantResponse = await fetch(`${baseUrl}/api/auth/tenant-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-2' })
    })

    assert.equal(tenantResponse.status, 204)
    assert.match(tenantResponse.headers.get('set-cookie') ?? '', /printstream_tenant_context=tenant-2/)

    const platformResponse = await fetch(`${baseUrl}/api/auth/tenant-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: null })
    })

    assert.equal(platformResponse.status, 204)
    assert.match(platformResponse.headers.get('set-cookie') ?? '', /printstream_tenant_context=platform/)
  })
})

test('auth tenant-context lets platform users enter a workspace through support access without a tenant account', async () => {
  rootPrisma.tenant.findMany = ((async (input: { where?: { id?: string } }) => {
    if (input.where?.id) {
      return [{ id: input.where.id, slug: 'beta', name: 'Beta' }]
    }
    return []
  }) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findMany = ((async () => []) as unknown) as typeof rootPrisma.setting.findMany

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1', isPlatformUser: true },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/tenant-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-2' })
    })

    assert.equal(response.status, 204)
    assert.match(response.headers.get('set-cookie') ?? '', /printstream_tenant_context=tenant-2/)
  })
})

test('auth tenant-context rejects platform users without a tenant account when support access is disabled', async () => {
  rootPrisma.tenant.findMany = ((async (input: { where?: { id?: string } }) => {
    if (input.where?.id) {
      return [{ id: input.where.id, slug: 'beta', name: 'Beta' }]
    }
    return []
  }) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findMany = ((async () => ([
    { key: 'tenant:tenant-2:auth:supportAccessEnabled' }
  ])) as unknown) as typeof rootPrisma.setting.findMany

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1', isPlatformUser: true },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/tenant-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-2' })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have access to this workspace.' })
  })
})

test('auth tenant-context allows platform admin tenant switching with a tenant account even when support access is disabled', async () => {
  rootPrisma.tenant.findMany = ((async (input: { where?: { id?: string } }) => {
    if (input.where?.id) {
      return [{ id: input.where.id, slug: 'beta', name: 'Beta' }]
    }
    return []
  }) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findMany = ((async () => ([
    { key: 'tenant:tenant-2:auth:supportAccessEnabled' }
  ])) as unknown) as typeof rootPrisma.setting.findMany
  rootPrisma.authTenantMembership.findMany = ((async () => ([{ tenantId: 'tenant-2' }])) as unknown) as typeof rootPrisma.authTenantMembership.findMany

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1', isPlatformUser: true },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/tenant-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-2' })
    })

    assert.equal(response.status, 204)
    assert.match(response.headers.get('set-cookie') ?? '', /printstream_tenant_context=tenant-2/)
  })
})

test('auth tenant-context requires sign-in before switching platform workspace context', async () => {
  await withAuthApp({
    authEnabled: false,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const tenantResponse = await fetch(`${baseUrl}/api/auth/tenant-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-2' })
    })

    assert.equal(tenantResponse.status, 401)
    assert.deepEqual(await tenantResponse.json(), {
      error: 'Sign in to change workspace context.'
    })
  })
})

test('auth logout revokes the current session cookie and clears it from the browser', async () => {
  let revokedWhere: unknown = null
  let revokedAt: Date | null = null
  prisma.authSession.updateMany = ((async (input: { where: unknown; data: { revokedAt: Date } }) => {
    revokedWhere = input.where
    revokedAt = input.data.revokedAt
    return { count: 1 }
  }) as unknown) as typeof prisma.authSession.updateMany

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: 'printstream_auth=session-secret' }
    })

    assert.equal(response.status, 204)
    assert.deepEqual(revokedWhere, {
      secretHash: crypto.createHash('sha256').update('session-secret').digest('base64url'),
      revokedAt: null
    })
    assert.ok(revokedAt instanceof Date)
    assert.match(response.headers.get('set-cookie') ?? '', /printstream_auth=/)
    assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/)
  })
})

test('auth logout writes an explicit session audit entry', async () => {
  let capturedData: Record<string, unknown> | null = null
  let resolveLogged: (() => void) | null = null
  const logged = new Promise<void>((resolve) => {
    resolveLogged = resolve
  })

  prisma.authSession.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof prisma.authSession.updateMany
  rootPrisma.auditLog.create = (async (args: { data: Record<string, unknown> }) => {
    capturedData = args.data
    resolveLogged?.()
    return { id: 'audit-logout-1' } as never
  }) as unknown as typeof rootPrisma.auditLog.create

  await withAuthAuditApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: 'printstream_auth=session-secret' }
    })

    assert.equal(response.status, 204)
  })

  await logged
  assert.deepEqual(capturedData, {
    tenantId: null,
    actorType: 'user',
    actorUserId: 'user-1',
    actorServiceAccountId: null,
    actorLabel: 'user:user-1',
    requestMethod: 'POST',
    requestPath: '/api/auth/logout',
    action: 'logout',
    resource: 'session',
    summary: 'Signed out of the current session.',
    statusCode: 204,
    ipAddress: '127.0.0.1',
    metadataJson: null
  })
})

test('auth sessions lists active user sessions and marks the current session', async () => {
  const createdAt = new Date('2026-05-02T00:00:00.000Z')
  const currentSecretHash = crypto.createHash('sha256').update('session-secret').digest('base64url')
  prisma.authSession.findMany = ((async () => ([
    {
      id: 'session-1',
      secretHash: currentSecretHash,
      createdAt,
      lastSeenAt: createdAt,
      expiresAt: new Date('2026-06-01T00:00:00.000Z')
    },
    {
      id: 'session-2',
      secretHash: 'hash-2',
      createdAt,
      lastSeenAt: null,
      expiresAt: new Date('2026-06-02T00:00:00.000Z')
    }
  ])) as unknown) as typeof prisma.authSession.findMany

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/sessions`, {
      headers: { Cookie: 'printstream_auth=session-secret' }
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      sessions: [
        {
          id: 'session-1',
          current: true,
          userAgent: null,
          createdAt: createdAt.toISOString(),
          lastSeenAt: createdAt.toISOString(),
          expiresAt: '2026-06-01T00:00:00.000Z'
        },
        {
          id: 'session-2',
          current: false,
          userAgent: null,
          createdAt: createdAt.toISOString(),
          lastSeenAt: null,
          expiresAt: '2026-06-02T00:00:00.000Z'
        }
      ]
    })
  })
})

test('auth sessions revokes another active user session but blocks revoking the current one', async () => {
  const currentSecretHash = crypto.createHash('sha256').update('session-secret').digest('base64url')
  let revokedWhere: unknown = null

  prisma.authSession.findFirst = ((async (input: { where: { id: string } }) => {
    if (input.where.id === 'session-2') {
      return {
        id: 'session-2',
        secretHash: 'hash-2',
        userAgent: null
      }
    }

    if (input.where.id === 'session-1') {
      return {
        id: 'session-1',
        secretHash: currentSecretHash,
        userAgent: null
      }
    }

    return null
  }) as unknown) as typeof prisma.authSession.findFirst
  prisma.authSession.updateMany = ((async (input: { where: unknown; data: { revokedAt: Date } }) => {
    revokedWhere = input.where
    return { count: 1 }
  }) as unknown) as typeof prisma.authSession.updateMany

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const revokeOtherResponse = await fetch(`${baseUrl}/api/auth/sessions/session-2/revoke`, {
      method: 'POST',
      headers: { Cookie: 'printstream_auth=session-secret' }
    })

    assert.equal(revokeOtherResponse.status, 204)
    assert.deepEqual(revokedWhere, {
      id: 'session-2',
      revokedAt: null
    })

    const revokeCurrentResponse = await fetch(`${baseUrl}/api/auth/sessions/session-1/revoke`, {
      method: 'POST',
      headers: { Cookie: 'printstream_auth=session-secret' }
    })

    assert.equal(revokeCurrentResponse.status, 403)
    assert.deepEqual(await revokeCurrentResponse.json(), {
      error: 'Use sign out to revoke the current browser session.'
    })
  })
})

test('auth me returns the current user profile and blocks direct email changes without verification', async () => {
  const createdAt = new Date('2026-05-02T00:00:00.000Z')
  let profile = {
    id: 'user-1',
    email: 'member@example.com',
    displayName: 'Member',
    isPlatformUser: false,
    tenantMemberships: [{ loginDisabled: false }],
    memberships: [{ group: { id: 'group-admin', key: 'admin', name: 'Admin' } }],
    _count: { passkeys: 1 },
    createdAt,
    updatedAt: createdAt
  }

  prisma.authUser.findFirst = ((async () => profile) as unknown) as typeof prisma.authUser.findFirst
  prisma.authUser.findUnique = ((async () => profile) as unknown) as typeof prisma.authUser.findUnique
  prisma.authUser.update = ((async (input: { data: { displayName?: string | null } }) => {
    profile = {
      ...profile,
      displayName: input.data.displayName ?? profile.displayName
    }
    return profile
  }) as unknown) as typeof prisma.authUser.update

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const getResponse = await fetch(`${baseUrl}/api/auth/me`)
    assert.equal(getResponse.status, 200)
    assert.deepEqual(await getResponse.json(), {
      user: {
        id: 'user-1',
        email: 'member@example.com',
        displayName: 'Member',
        loginDisabled: false,
        isPlatformUser: false,
        groups: [{ id: 'group-admin', key: 'admin', name: 'Admin' }],
        passkeyCount: 1,
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString()
      }
    })

    const patchEmailResponse = await fetch(`${baseUrl}/api/auth/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'updated@example.com' })
    })
    assert.equal(patchEmailResponse.status, 409)
    assert.deepEqual(await patchEmailResponse.json(), {
      error: 'Verify the new email address before changing it.'
    })

    const patchDisplayNameResponse = await fetch(`${baseUrl}/api/auth/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Updated Member' })
    })
    assert.equal(patchDisplayNameResponse.status, 200)
    assert.deepEqual(await patchDisplayNameResponse.json(), {
      user: {
        id: 'user-1',
        email: 'member@example.com',
        displayName: 'Updated Member',
        loginDisabled: false,
        isPlatformUser: false,
        groups: [{ id: 'group-admin', key: 'admin', name: 'Admin' }],
        passkeyCount: 1,
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString()
      }
    })
  })
})

test('auth session policy reads and updates the core browser-session duration', async () => {
  let storedValue: string | null = null

  prisma.setting.findUnique = ((async () => storedValue == null ? null : { key: 'auth:sessionDuration', value: storedValue }) as unknown) as typeof prisma.setting.findUnique
  prisma.setting.upsert = ((async (input: { update: { value: string } }) => {
    storedValue = input.update.value
    return { key: 'auth:sessionDuration', value: storedValue }
  }) as unknown) as typeof prisma.setting.upsert

  await withAuthApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [AUTH_SESSION_POLICY_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const getResponse = await fetch(`${baseUrl}/api/auth/session-policy`)
    assert.equal(getResponse.status, 200)
    assert.deepEqual(await getResponse.json(), {
      sessionDuration: 'day'
    })

    const putResponse = await fetch(`${baseUrl}/api/auth/session-policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionDuration: 'custom:45' })
    })
    assert.equal(putResponse.status, 200)
    assert.deepEqual(await putResponse.json(), {
      sessionDuration: 'custom:45'
    })
    assert.equal(storedValue, 'custom:45')

    const invalidPutResponse = await fetch(`${baseUrl}/api/auth/session-policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionDuration: 'custom:10' })
    })
    assert.equal(invalidPutResponse.status, 400)
    assert.equal(storedValue, 'custom:45')
  })
})

test('auth groups list stays scoped to the current tenant workspace', async () => {
  let requestedWhere: unknown = null

  prisma.authGroup.findUnique = ((async () => null) as unknown) as typeof prisma.authGroup.findUnique
  prisma.authGroup.create = ((async () => ({})) as unknown) as typeof prisma.authGroup.create

  prisma.authGroup.findMany = ((async (input: { where?: unknown }) => {
    requestedWhere = input.where ?? null
    return [
      {
        id: 'group-1',
        key: 'viewer',
        name: 'Viewer',
        description: 'Tenant one viewer',
        permissions: [AUTH_ROLES_VIEW_PERMISSION, TENANTS_MANAGE_PERMISSION],
        isSystem: true,
        isEditable: true,
        isRemovable: false,
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
        updatedAt: new Date('2026-05-01T00:00:00.000Z'),
        _count: {
          userMemberships: 1,
          serviceAccountMemberships: 0
        }
      }
    ]
  }) as unknown) as typeof prisma.authGroup.findMany

  await withAuthApp({
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
    permissions: [AUTH_ROLES_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/groups`)
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.deepEqual(requestedWhere, { tenantId: 'tenant-1' })
    assert.equal(body.groups.length, 1)
    assert.deepEqual(body.groups[0]?.permissions, [AUTH_ROLES_VIEW_PERMISSION])
  })
})

test('auth groups list recreates missing built-in tenant roles before returning them', async () => {
  const tenantId = 'tenant-1'
  const createdAt = new Date('2026-05-01T00:00:00.000Z')
  const store = new Map<string, {
    id: string
    key: string | null
    name: string
    description: string | null
    permissions: string[]
    isSystem: boolean
    isEditable: boolean
    isRemovable: boolean
    createdAt: Date
    updatedAt: Date
    _count: {
      userMemberships: number
      serviceAccountMemberships: number
    }
  }>()

  prisma.authGroup.findUnique = ((async (input: { where: { tenantId_key: { tenantId: string; key: string } } }) => {
    const compound = input.where.tenantId_key
    return store.get(`${compound.tenantId}:${compound.key}`) ?? null
  }) as unknown) as typeof prisma.authGroup.findUnique

  prisma.authGroup.create = ((async (input: { data: { tenantId: string | null; key: string | null; name: string; description: string; permissions: string[]; isSystem: boolean; isEditable: boolean; isRemovable: boolean } }) => {
    const row = {
      id: `group-${input.data.key}`,
      key: input.data.key,
      name: input.data.name,
      description: input.data.description,
      permissions: input.data.permissions,
      isSystem: input.data.isSystem,
      isEditable: input.data.isEditable,
      isRemovable: input.data.isRemovable,
      createdAt,
      updatedAt: createdAt,
      _count: {
        userMemberships: 0,
        serviceAccountMemberships: 0
      }
    }
    store.set(`${input.data.tenantId}:${input.data.key}`, row)
    return row
  }) as unknown) as typeof prisma.authGroup.create

  prisma.authGroup.findMany = ((async (input: { where?: { tenantId?: string | null } }) => {
    return Array.from(store.values())
      .filter((row) => row.key != null && row && input.where?.tenantId === tenantId)
      .sort((left, right) => left.name.localeCompare(right.name))
  }) as unknown) as typeof prisma.authGroup.findMany

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-1',
      tenant: {
        id: tenantId,
        slug: 'alpha',
        name: 'Alpha'
      }
    },
    permissions: [AUTH_ROLES_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/groups`)
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.groups.length, builtInAuthGroupSeeds.length)
    assert.deepEqual(
      body.groups.map((group: { key: string | null }) => group.key),
      builtInAuthGroupSeeds.map((seed) => seed.key)
    )
  })
})

test('auth status counts stay scoped to the current tenant workspace', async () => {
  let requestedGroupCountWhere: unknown = null
  let requestedServiceAccountCountWhere: unknown = null

  prisma.authGroup.findUnique = ((async () => null) as unknown) as typeof prisma.authGroup.findUnique
  prisma.authGroup.create = ((async () => ({})) as unknown) as typeof prisma.authGroup.create
  prisma.authTenantMembership.count = ((async () => 2) as unknown) as typeof prisma.authTenantMembership.count
  prisma.authGroup.count = ((async (input: { where?: unknown }) => {
    requestedGroupCountWhere = input.where ?? null
    return 3
  }) as unknown) as typeof prisma.authGroup.count
  prisma.authServiceAccount.count = ((async (input: { where?: unknown }) => {
    requestedServiceAccountCountWhere = input.where ?? null
    return 4
  }) as unknown) as typeof prisma.authServiceAccount.count
  prisma.setting.findUnique = ((async () => null) as unknown) as typeof prisma.setting.findUnique

  await withAuthApp({
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
    permissions: [AUTH_ACCESS_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/status`)
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.deepEqual(requestedGroupCountWhere, { tenantId: 'tenant-1' })
    assert.deepEqual(requestedServiceAccountCountWhere, { tenantId: 'tenant-1' })
    assert.deepEqual(body.counts, {
      users: 2,
      groups: 3,
      serviceAccounts: 4
    })
    assert.equal(body.permissionDefinitions.some((definition: { key: string }) => definition.key === TENANTS_MANAGE_PERMISSION), false)
  })
})

test('auth groups reject platform-only permissions in tenant workspaces', async () => {
  prisma.authSession.findUnique = ((async () => ({
    userId: 'user-1',
    createdAt: new Date(Date.now() - (5 * 60 * 1000)),
    expiresAt: new Date(Date.now() + (60 * 60 * 1000)),
    revokedAt: null
  })) as unknown) as typeof prisma.authSession.findUnique

  await withAuthApp({
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
    permissions: [AUTH_ROLES_CREATE_PERMISSION, AUTH_ROLES_ASSIGN_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/groups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token`
      },
      body: JSON.stringify({
        name: 'Support',
        description: 'Support access',
        permissions: [TENANTS_MANAGE_PERMISSION]
      })
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: 'One or more permissions are not available in this workspace.'
    })
  })
})

test('tenant auth groups hide platform-only permissions in returned roles', async () => {
  const createdAt = new Date('2026-05-01T00:00:00.000Z')
  prisma.authGroup.findUnique = ((async () => null) as unknown) as typeof prisma.authGroup.findUnique
  prisma.authGroup.create = ((async () => ({})) as unknown) as typeof prisma.authGroup.create
  prisma.authGroup.findMany = ((async () => ([{
    id: 'group-admin',
    key: 'admin',
    name: 'Admin',
    description: 'Workspace administrators',
    permissions: [AUTH_ROLES_VIEW_PERMISSION, SETTINGS_MANAGE_PERMISSION, TENANTS_MANAGE_PERMISSION, AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION],
    tenantId: 'tenant-1',
    isSystem: true,
    isEditable: false,
    isRemovable: false,
    createdAt,
    updatedAt: createdAt,
    _count: {
      userMemberships: 1,
      serviceAccountMemberships: 0
    }
  }])) as unknown) as typeof prisma.authGroup.findMany

  await withAuthApp({
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
    permissions: [AUTH_ROLES_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/groups`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      groups: [{
        id: 'group-admin',
        key: 'admin',
        name: 'Admin',
        description: 'Workspace administrators',
        permissions: [AUTH_ROLES_VIEW_PERMISSION, SETTINGS_MANAGE_PERMISSION],
        isSystem: true,
        canManage: false,
        isEditable: false,
        isRemovable: false,
        userCount: 1,
        serviceAccountCount: 0,
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString()
      }]
    })
  })
})

test('platform auth groups reject workspace permissions but allow owned platform permissions', async () => {
  prisma.authSession.findUnique = ((async () => ({
    userId: 'user-1',
    createdAt: new Date(Date.now() - (5 * 60 * 1000)),
    expiresAt: new Date(Date.now() + (60 * 60 * 1000)),
    revokedAt: null
  })) as unknown) as typeof prisma.authSession.findUnique

  const createdAt = new Date('2026-05-01T00:00:00.000Z')
  prisma.authGroup.create = ((async (input: { data: { tenantId: string | null; name: string; description: string | null; permissions: string[] } }) => ({
    id: 'platform-group-custom',
    key: null,
    name: input.data.name,
    description: input.data.description,
    permissions: input.data.permissions,
    tenantId: input.data.tenantId,
    isSystem: false,
    isEditable: true,
    isRemovable: true,
    createdAt,
    updatedAt: createdAt,
    _count: {
      userMemberships: 0,
      serviceAccountMemberships: 0
    }
  })) as unknown) as typeof prisma.authGroup.create

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-1',
      isPlatformUser: true,
      tenant: null
    },
    permissions: [AUTH_ROLES_CREATE_PERMISSION, AUTH_ROLES_ASSIGN_PERMISSION, AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION, TENANTS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const workspacePermissionResponse = await fetch(`${baseUrl}/api/auth/groups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token`
      },
      body: JSON.stringify({
        name: 'Workspace-shaped platform role',
        description: 'Invalid',
        permissions: [PRINTERS_MANAGE_PERMISSION]
      })
    })

    assert.equal(workspacePermissionResponse.status, 400)
    assert.deepEqual(await workspacePermissionResponse.json(), {
      error: 'One or more permissions are not available for platform roles.'
    })

    const bypassResponse = await fetch(`${baseUrl}/api/auth/groups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token`
      },
      body: JSON.stringify({
        name: 'Support Bypass',
        description: 'Support users who can enter any workspace.',
        permissions: [AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION, TENANTS_MANAGE_PERMISSION]
      })
    })

    assert.equal(bypassResponse.status, 201)
    const body = await bypassResponse.json()
    assert.deepEqual(body.group.permissions, [AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION, TENANTS_MANAGE_PERMISSION])
  })
})

test('auth group permission edits require recent verification', async () => {
  prisma.authSession.findUnique = ((async () => ({
    userId: 'user-1',
    createdAt: new Date(Date.now() - (16 * 60 * 1000)),
    expiresAt: new Date(Date.now() + (60 * 60 * 1000)),
    revokedAt: null
  })) as unknown) as typeof prisma.authSession.findUnique

  await withAuthApp({
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
    permissions: [AUTH_ROLES_CREATE_PERMISSION, AUTH_ROLES_ASSIGN_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/groups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token`
      },
      body: JSON.stringify({
        name: 'Support',
        description: 'Support access',
        permissions: []
      })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), {
      error: AUTH_RECENT_VERIFICATION_REQUIRED_MESSAGE
    })
  })
})

test('auth user role assignment requires recent verification', async () => {
  prisma.authSession.findUnique = ((async () => ({
    userId: 'user-1',
    createdAt: new Date(Date.now() - (16 * 60 * 1000)),
    expiresAt: new Date(Date.now() + (60 * 60 * 1000)),
    revokedAt: null
  })) as unknown) as typeof prisma.authSession.findUnique

  await withAuthApp({
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
    permissions: [AUTH_USERS_ASSIGN_ROLES_PERMISSION, AUTH_ROLES_ASSIGN_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/users/user-2/groups`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token`
      },
      body: JSON.stringify({ groupIds: ['group-1'] })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), {
      error: AUTH_RECENT_VERIFICATION_REQUIRED_MESSAGE
    })
  })
})

test('auth user creation with initial roles requires recent verification', async () => {
  prisma.authSession.findUnique = ((async () => ({
    userId: 'user-1',
    createdAt: new Date(Date.now() - (16 * 60 * 1000)),
    expiresAt: new Date(Date.now() + (60 * 60 * 1000)),
    revokedAt: null
  })) as unknown) as typeof prisma.authSession.findUnique

  await withAuthApp({
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
    permissions: [AUTH_USERS_CREATE_PERMISSION, AUTH_USERS_ASSIGN_ROLES_PERMISSION, AUTH_ROLES_ASSIGN_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token`
      },
      body: JSON.stringify({
        email: 'new@example.com',
        displayName: 'New User',
        groupIds: ['group-1']
      })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), {
      error: AUTH_RECENT_VERIFICATION_REQUIRED_MESSAGE
    })
  })
})

test('platform user creation reuses an existing tenant identity with the same email', async () => {
  const createdAt = new Date('2026-05-16T00:00:00.000Z')
  const platformAdminPermissions = filterPermissionsForPlatformContext(permissionValues)
  let promotedUserId: string | null = null
  let createdPlatformUser = false
  let assignedMemberships: Array<{ userId: string; groupId: string }> = []

  prisma.authSession.findUnique = ((async () => ({
    userId: 'user-platform-admin',
    createdAt: new Date(Date.now() - (5 * 60 * 1000)),
    expiresAt: new Date(Date.now() + (60 * 60 * 1000)),
    revokedAt: null
  })) as unknown) as typeof prisma.authSession.findUnique

  prisma.authGroup.findMany = ((async () => ([{
    id: 'platform-group-admin',
    permissions: platformAdminPermissions
  }])) as unknown) as typeof prisma.authGroup.findMany

  prisma.$transaction = ((async <T>(run: (tx: {
    authUser: {
      findFirst(args: { where: { email: { equals: string; mode: 'insensitive' } } }): Promise<{ id: string; isPlatformUser: boolean } | null>
      update(args: { where: { id: string }; data: { isPlatformUser: boolean }; select: { id: true } }): Promise<{ id: string }>
      create(): Promise<{ id: string }>
    }
    authUserGroupMembership: {
      createMany(args: { data: Array<{ userId: string; groupId: string }> }): Promise<unknown>
    }
  }) => Promise<T>) => await run({
    authUser: {
      async findFirst(args) {
        assert.equal(args.where.email.equals, 'tenant-user@example.com')
        return {
          id: 'user-tenant-only',
          isPlatformUser: false
        }
      },
      async update(args) {
        promotedUserId = args.where.id
        assert.deepEqual(args.data, { isPlatformUser: true })
        return { id: args.where.id }
      },
      async create() {
        createdPlatformUser = true
        throw new Error('expected platform user creation to reuse the existing identity')
      }
    },
    authUserGroupMembership: {
      async createMany(args) {
        assignedMemberships = args.data
        return { count: args.data.length }
      }
    }
  })) as unknown) as typeof prisma.$transaction

  prisma.authUser.findFirst = ((async () => ({
    id: 'user-tenant-only',
    email: 'tenant-user@example.com',
    displayName: 'Tenant User',
    isPlatformUser: true,
    tenantMemberships: [],
    memberships: [{ group: { id: 'platform-group-admin', key: 'admin', name: 'Admin', permissions: platformAdminPermissions } }],
    _count: { passkeys: 0 },
    createdAt,
    updatedAt: createdAt
  })) as unknown) as typeof prisma.authUser.findFirst

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-platform-admin',
      isPlatformUser: true,
      tenant: null
    },
    permissions: [AUTH_USERS_CREATE_PERMISSION, AUTH_USERS_ASSIGN_ROLES_PERMISSION, AUTH_ROLES_ASSIGN_PERMISSION, ...platformAdminPermissions],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token`
      },
      body: JSON.stringify({
        email: 'tenant-user@example.com',
        displayName: 'Tenant User',
        groupIds: ['platform-group-admin']
      })
    })

    assert.equal(response.status, 201)
    assert.equal(createdPlatformUser, false)
    assert.equal(promotedUserId, 'user-tenant-only')
    assert.deepEqual(assignedMemberships, [{ userId: 'user-tenant-only', groupId: 'platform-group-admin' }])
    assert.deepEqual(await response.json(), {
      user: {
        id: 'user-tenant-only',
        email: 'tenant-user@example.com',
        displayName: 'Tenant User',
        loginDisabled: false,
        isPlatformUser: true,
        groups: [{ id: 'platform-group-admin', key: 'admin', name: 'Admin' }],
        passkeyCount: 0,
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString()
      }
    })
  })
})

test('platform auth managers cannot manage users with broader platform permissions', async () => {
  const createdAt = new Date('2026-05-04T00:00:00.000Z')
  const superAdminPermissions = [AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION, AUTH_USERS_VIEW_PERMISSION, AUTH_USERS_ASSIGN_ROLES_PERMISSION, AUTH_ROLES_ASSIGN_PERMISSION, SETTINGS_MANAGE_PERMISSION, TENANTS_MANAGE_PERMISSION]

  prisma.authUser.findMany = ((async () => ([{
    id: 'user-super',
    email: 'super@example.com',
    displayName: 'Super Admin',
    isPlatformUser: true,
    tenantMemberships: [],
    memberships: [{ group: { id: 'platform-group-admin', key: 'admin', name: 'Admin', permissions: superAdminPermissions } }],
    _count: { passkeys: 0 },
    createdAt,
    updatedAt: createdAt
  }])) as unknown) as typeof prisma.authUser.findMany

  prisma.authUser.findFirst = ((async () => ({
    id: 'user-super',
    email: 'super@example.com',
    displayName: 'Super Admin',
    isPlatformUser: true,
    tenantMemberships: [],
    memberships: [{ group: { id: 'platform-group-admin', key: 'admin', name: 'Admin', permissions: superAdminPermissions } }],
    _count: { passkeys: 0 },
    createdAt,
    updatedAt: createdAt
  })) as unknown) as typeof prisma.authUser.findFirst

  prisma.authSession.findUnique = ((async () => ({
    userId: 'user-manager',
    createdAt: new Date(Date.now() - (5 * 60 * 1000)),
    expiresAt: new Date(Date.now() + (60 * 60 * 1000)),
    revokedAt: null
  })) as unknown) as typeof prisma.authSession.findUnique

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-manager',
      isPlatformUser: true,
      tenant: null
    },
    permissions: [AUTH_USERS_VIEW_PERMISSION, AUTH_USERS_ASSIGN_ROLES_PERMISSION, AUTH_ROLES_ASSIGN_PERMISSION, TENANTS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const listResponse = await fetch(`${baseUrl}/api/auth/users`)
    assert.equal(listResponse.status, 200)
    assert.equal((await listResponse.json()).users[0].canManage, false)

    const updateResponse = await fetch(`${baseUrl}/api/auth/users/user-super/groups`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token`
      },
      body: JSON.stringify({ groupIds: ['platform-group-support'] })
    })

    assert.equal(updateResponse.status, 403)
    assert.deepEqual(await updateResponse.json(), {
      error: 'You cannot manage a user with permissions you do not have.'
    })
  })
})

test('tenant auth managers cannot assign roles with permissions they do not have', async () => {
  const createdAt = new Date('2026-05-04T00:00:00.000Z')

  prisma.authUser.findFirst = ((async () => ({
    id: 'user-viewer',
    email: 'viewer@example.com',
    displayName: 'Viewer',
    isPlatformUser: false,
    tenantMemberships: [{ loginDisabled: false }],
    memberships: [{ group: { id: 'group-viewer', key: 'viewer', name: 'Viewer', permissions: [PRINTERS_VIEW_PERMISSION] } }],
    _count: { passkeys: 0 },
    createdAt,
    updatedAt: createdAt
  })) as unknown) as typeof prisma.authUser.findFirst

  prisma.authGroup.findMany = ((async () => ([{
    id: 'group-admin',
    permissions: [AUTH_USERS_ASSIGN_ROLES_PERMISSION, PRINTERS_VIEW_PERMISSION, SETTINGS_MANAGE_PERMISSION]
  }])) as unknown) as typeof prisma.authGroup.findMany

  prisma.authSession.findUnique = ((async () => ({
    userId: 'user-manager',
    createdAt: new Date(Date.now() - (5 * 60 * 1000)),
    expiresAt: new Date(Date.now() + (60 * 60 * 1000)),
    revokedAt: null
  })) as unknown) as typeof prisma.authSession.findUnique

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-manager',
      tenant: {
        id: 'tenant-1',
        slug: 'alpha',
        name: 'Alpha'
      }
    },
    permissions: [AUTH_USERS_ASSIGN_ROLES_PERMISSION, AUTH_ROLES_ASSIGN_PERMISSION, PRINTERS_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/users/user-viewer/groups`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token`
      },
      body: JSON.stringify({ groupIds: ['group-admin'] })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), {
      error: 'You cannot assign roles with permissions you do not have.'
    })
  })
})

test('auth managers cannot manage users with equal permissions unless they are admin-equivalent', async () => {
  const createdAt = new Date('2026-05-04T00:00:00.000Z')

  prisma.authUser.findFirst = ((async () => ({
    id: 'user-peer',
    email: 'peer@example.com',
    displayName: 'Peer Manager',
    isPlatformUser: false,
    tenantMemberships: [{ loginDisabled: false }],
    memberships: [{ group: { id: 'group-manager', key: null, name: 'Manager', permissions: [AUTH_USERS_DISABLE_SIGN_IN_PERMISSION] } }],
    _count: { passkeys: 0 },
    createdAt,
    updatedAt: createdAt
  })) as unknown) as typeof prisma.authUser.findFirst

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-manager',
      tenant: {
        id: 'tenant-1',
        slug: 'alpha',
        name: 'Alpha'
      }
    },
    permissions: [AUTH_USERS_DISABLE_SIGN_IN_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/users/user-peer`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginDisabled: true })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), {
      error: 'You cannot manage a user with permissions you do not have.'
    })
  })
})

test('tenant admin-equivalent users can manage equal-permission users', async () => {
  const createdAt = new Date('2026-05-04T00:00:00.000Z')
  const tenantAdminPermissions = filterPermissionsForTenantContext(permissionValues)

  prisma.authUser.findFirst = ((async () => ({
    id: 'user-admin-peer',
    email: 'admin-peer@example.com',
    displayName: 'Admin Peer',
    isPlatformUser: false,
    tenantMemberships: [{ loginDisabled: false }],
    memberships: [{ group: { id: 'group-admin', key: 'admin', name: 'Admin', permissions: tenantAdminPermissions } }],
    _count: { passkeys: 0 },
    createdAt,
    updatedAt: createdAt
  })) as unknown) as typeof prisma.authUser.findFirst

  prisma.authSession.findMany = ((async () => ([])) as unknown) as typeof prisma.authSession.findMany

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-admin',
      tenant: {
        id: 'tenant-1',
        slug: 'alpha',
        name: 'Alpha'
      }
    },
    permissions: tenantAdminPermissions,
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/users/user-admin-peer/sessions`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { sessions: [] })
  })
})

test('tenant admin users can disable sign-in for other tenant admins', async () => {
  const createdAt = new Date('2026-05-04T00:00:00.000Z')
  const tenantAdminPermissions = filterPermissionsForTenantContext(permissionValues)
  const targetUser = {
    id: 'user-admin-peer',
    email: 'admin-peer@example.com',
    displayName: 'Admin Peer',
    isPlatformUser: false,
    tenantMemberships: [{ loginDisabled: false }],
    memberships: [{ group: { id: 'group-admin', key: 'admin', name: 'Admin', permissions: tenantAdminPermissions } }],
    _count: { passkeys: 0 },
    createdAt,
    updatedAt: createdAt
  }
  let currentUser = targetUser

  prisma.authUser.findFirst = ((async () => currentUser) as unknown) as typeof prisma.authUser.findFirst
  prisma.authUser.count = ((async () => 1) as unknown) as typeof prisma.authUser.count
  prisma.$transaction = ((async <T>(run: (tx: {
    authTenantMembership: { update(args: { data: { loginDisabled: boolean } }): Promise<unknown> }
  }) => Promise<T>) => await run({
    authTenantMembership: {
      async update(args) {
        currentUser = {
          ...currentUser,
          tenantMemberships: [{ loginDisabled: args.data.loginDisabled }]
        }
        return {}
      }
    }
  })) as unknown as typeof prisma.$transaction)

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-admin',
      tenant: {
        id: 'tenant-1',
        slug: 'alpha',
        name: 'Alpha'
      }
    },
    permissions: tenantAdminPermissions,
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/users/user-admin-peer`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginDisabled: true })
    })

    assert.equal(response.status, 200)
    assert.equal((await response.json()).user.loginDisabled, true)
  })
})

test('platform admin users can delete the last remaining tenant admin', async () => {
  const createdAt = new Date('2026-05-04T00:00:00.000Z')
  const tenantAdminPermissions = filterPermissionsForTenantContext(permissionValues)
  let deletedUserId: string | null = null

  prisma.authUser.findFirst = ((async () => ({
    id: 'user-tenant-admin',
    email: 'tenant-admin@example.com',
    displayName: 'Tenant Admin',
    isPlatformUser: false,
    tenantMemberships: [{ loginDisabled: false }],
    memberships: [{ group: { id: 'group-admin', key: 'admin', name: 'Admin', permissions: tenantAdminPermissions } }],
    _count: { passkeys: 0 },
    createdAt,
    updatedAt: createdAt
  })) as unknown) as typeof prisma.authUser.findFirst

  prisma.$transaction = ((async <T>(run: (tx: {
    authUserGroupMembership: { deleteMany(): Promise<unknown> }
    authTenantMembership: { delete(): Promise<unknown> }
    authUser: {
      findUnique(): Promise<{ isPlatformUser: boolean; _count: { tenantMemberships: number } }>
      delete(args: { where: { id: string } }): Promise<unknown>
    }
  }) => Promise<T>) => await run({
    authUserGroupMembership: {
      async deleteMany() {
        return { count: 1 }
      }
    },
    authTenantMembership: {
      async delete() {
        return {}
      }
    },
    authUser: {
      async findUnique() {
        return {
          isPlatformUser: false,
          _count: { tenantMemberships: 0 }
        }
      },
      async delete(args) {
        deletedUserId = args.where.id
        return {}
      }
    }
  })) as unknown) as typeof prisma.$transaction

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-platform-admin',
      isPlatformUser: true,
      tenant: {
        id: 'tenant-1',
        slug: 'alpha',
        name: 'Alpha'
      }
    },
    platformPermissions: filterPermissionsForPlatformContext(permissionValues),
    permissions: tenantAdminPermissions,
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/users/user-tenant-admin`, {
      method: 'DELETE'
    })

    assert.equal(response.status, 204)
    assert.equal(deletedUserId, 'user-tenant-admin')
  })
})

test('tenant admin users cannot remove their own last admin role', async () => {
  const createdAt = new Date('2026-05-04T00:00:00.000Z')
  const tenantAdminPermissions = filterPermissionsForTenantContext(permissionValues)
  let membershipDeleteCalled = false

  prisma.authUser.findFirst = ((async () => ({
    id: 'user-admin-self',
    email: 'admin-self@example.com',
    displayName: 'Admin Self',
    isPlatformUser: false,
    tenantMemberships: [{ loginDisabled: false }],
    memberships: [{ group: { id: 'group-admin', key: 'admin', name: 'Admin', permissions: tenantAdminPermissions } }],
    _count: { passkeys: 0 },
    createdAt,
    updatedAt: createdAt
  })) as unknown) as typeof prisma.authUser.findFirst

  prisma.authUser.count = ((async () => 0) as unknown) as typeof prisma.authUser.count
  prisma.authUserGroupMembership.deleteMany = ((async () => {
    membershipDeleteCalled = true
    return { count: 1 }
  }) as unknown) as typeof prisma.authUserGroupMembership.deleteMany
  prisma.authSession.findUnique = ((async () => ({
    userId: 'user-admin-self',
    createdAt: new Date(Date.now() - (5 * 60 * 1000)),
    expiresAt: new Date(Date.now() + (60 * 60 * 1000)),
    revokedAt: null
  })) as unknown) as typeof prisma.authSession.findUnique

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-admin-self',
      tenant: {
        id: 'tenant-1',
        slug: 'alpha',
        name: 'Alpha'
      }
    },
    permissions: tenantAdminPermissions,
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/users/user-admin-self/groups`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token`
      },
      body: JSON.stringify({ groupIds: [] })
    })

    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), {
      error: 'At least one enabled Admin user must remain to prevent lockout.'
    })
    assert.equal(membershipDeleteCalled, false)
  })
})

test('platform support users with full effective tenant permissions can manage tenant admins', async () => {
  const createdAt = new Date('2026-05-04T00:00:00.000Z')
  const tenantAdminPermissions = filterPermissionsForTenantContext(permissionValues)

  prisma.authUser.findFirst = ((async () => ({
    id: 'user-tenant-admin',
    email: 'tenant-admin@example.com',
    displayName: 'Tenant Admin',
    isPlatformUser: false,
    tenantMemberships: [{ loginDisabled: false }],
    memberships: [{ group: { id: 'group-admin', key: 'admin', name: 'Admin', permissions: tenantAdminPermissions } }],
    _count: { passkeys: 0 },
    createdAt,
    updatedAt: createdAt
  })) as unknown) as typeof prisma.authUser.findFirst

  prisma.authSession.findMany = ((async () => ([])) as unknown) as typeof prisma.authSession.findMany

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-platform-support',
      isPlatformUser: true,
      tenant: {
        id: 'tenant-1',
        slug: 'alpha',
        name: 'Alpha'
      }
    },
    permissions: tenantAdminPermissions,
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/users/user-tenant-admin/sessions`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { sessions: [] })
  })
})

test('platform admin users can manage equal-permission platform users', async () => {
  const createdAt = new Date('2026-05-04T00:00:00.000Z')
  const platformAdminPermissions = filterPermissionsForPlatformContext(permissionValues)

  prisma.authUser.findFirst = ((async () => ({
    id: 'user-platform-peer',
    email: 'platform-peer@example.com',
    displayName: 'Platform Peer',
    isPlatformUser: true,
    tenantMemberships: [],
    memberships: [{ group: { id: 'group-platform-admin', key: 'admin', name: 'Admin', permissions: platformAdminPermissions } }],
    _count: { passkeys: 0 },
    createdAt,
    updatedAt: createdAt
  })) as unknown) as typeof prisma.authUser.findFirst

  prisma.authSession.findMany = ((async () => ([])) as unknown) as typeof prisma.authSession.findMany

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-platform-admin',
      isPlatformUser: true,
      tenant: null
    },
    platformPermissions: platformAdminPermissions,
    permissions: platformAdminPermissions,
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/users/user-platform-peer/sessions`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { sessions: [] })
  })
})

test('platform admin users cannot edit other platform admins global profile fields', async () => {
  const createdAt = new Date('2026-05-04T00:00:00.000Z')
  const platformAdminPermissions = filterPermissionsForPlatformContext(permissionValues)

  prisma.authUser.findFirst = ((async () => ({
    id: 'user-platform-peer',
    email: 'platform-peer@example.com',
    displayName: 'Platform Peer',
    isPlatformUser: true,
    tenantMemberships: [],
    memberships: [{ group: { id: 'group-platform-admin', key: 'admin', name: 'Admin', permissions: platformAdminPermissions } }],
    _count: { passkeys: 0 },
    createdAt,
    updatedAt: createdAt
  })) as unknown) as typeof prisma.authUser.findFirst

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-platform-admin',
      isPlatformUser: true,
      tenant: null
    },
    platformPermissions: platformAdminPermissions,
    permissions: platformAdminPermissions,
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/users/user-platform-peer`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Updated Platform Peer' })
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: 'Invalid auth user payload.'
    })
  })
})

test('platform admin users can create lower platform manager roles', async () => {
  const createdAt = new Date('2026-05-04T00:00:00.000Z')
  const platformAdminPermissions = filterPermissionsForPlatformContext(permissionValues)
  const platformManagerPermissions = builtInPlatformAuthGroupSeeds.find((seed) => seed.key === 'platform_manager')?.permissions ?? []

  prisma.authSession.findUnique = ((async () => ({
    userId: 'user-platform-admin',
    createdAt: new Date(Date.now() - (5 * 60 * 1000)),
    expiresAt: new Date(Date.now() + (60 * 60 * 1000)),
    revokedAt: null
  })) as unknown) as typeof prisma.authSession.findUnique

  prisma.authGroup.create = ((async (args: { data: { name: string; description?: string | null; permissions: string[] } }) => ({
    id: 'group-created-manager',
    tenantId: null,
    key: null,
    name: args.data.name,
    description: args.data.description ?? null,
    permissions: args.data.permissions,
    isSystem: false,
    isEditable: true,
    isRemovable: true,
    createdAt,
    updatedAt: createdAt,
    _count: {
      userMemberships: 0,
      serviceAccountMemberships: 0
    }
  })) as unknown) as typeof prisma.authGroup.create

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-platform-admin',
      isPlatformUser: true,
      tenant: null
    },
    platformPermissions: platformAdminPermissions,
    permissions: platformAdminPermissions,
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/groups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token`
      },
      body: JSON.stringify({
        name: 'Escalation Manager',
        permissions: platformManagerPermissions
      })
    })

    assert.equal(response.status, 201)
    const body = await response.json()
    assert.deepEqual(body.group.permissions, platformManagerPermissions)
  })
})

test('platform managers cannot mint equal platform managers', async () => {
  const platformManagerPermissions = builtInPlatformAuthGroupSeeds.find((seed) => seed.key === 'platform_manager')?.permissions ?? []

  prisma.authSession.findUnique = ((async () => ({
    userId: 'user-platform-manager',
    createdAt: new Date(Date.now() - (5 * 60 * 1000)),
    expiresAt: new Date(Date.now() + (60 * 60 * 1000)),
    revokedAt: null
  })) as unknown) as typeof prisma.authSession.findUnique

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-platform-manager',
      isPlatformUser: true,
      tenant: null
    },
    platformPermissions: platformManagerPermissions,
    permissions: platformManagerPermissions,
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/groups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token`
      },
      body: JSON.stringify({
        name: 'Peer Manager',
        permissions: platformManagerPermissions
      })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), {
      error: 'You cannot assign roles with permissions you do not have.'
    })
  })
})

test('auth managers cannot edit roles with permissions they do not have', async () => {
  prisma.authSession.findUnique = ((async () => ({
    userId: 'user-manager',
    createdAt: new Date(Date.now() - (5 * 60 * 1000)),
    expiresAt: new Date(Date.now() + (60 * 60 * 1000)),
    revokedAt: null
  })) as unknown) as typeof prisma.authSession.findUnique

  prisma.authGroup.findFirst = ((async () => ({
    id: 'group-adminish',
    key: null,
    name: 'Admin-ish',
    description: null,
    permissions: [AUTH_ROLES_EDIT_PERMISSION, SETTINGS_MANAGE_PERMISSION],
    isSystem: false,
    isEditable: true,
    isRemovable: true,
    createdAt: new Date('2026-05-04T00:00:00.000Z'),
    updatedAt: new Date('2026-05-04T00:00:00.000Z')
  })) as unknown) as typeof prisma.authGroup.findFirst

  await withAuthApp({
    authEnabled: true,
    actor: {
      type: 'user',
      userId: 'user-manager',
      tenant: {
        id: 'tenant-1',
        slug: 'alpha',
        name: 'Alpha'
      }
    },
    permissions: [AUTH_ROLES_EDIT_PERMISSION, AUTH_ROLES_ASSIGN_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/groups/group-adminish`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token`
      },
      body: JSON.stringify({ name: 'Reduced role', permissions: [AUTH_ROLES_EDIT_PERMISSION] })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), {
      error: 'You cannot assign roles with permissions you do not have.'
    })
  })
})

test('auth service-account role assignment requires recent verification', async () => {
  prisma.authSession.findUnique = ((async () => ({
    userId: 'user-1',
    createdAt: new Date(Date.now() - (16 * 60 * 1000)),
    expiresAt: new Date(Date.now() + (60 * 60 * 1000)),
    revokedAt: null
  })) as unknown) as typeof prisma.authSession.findUnique

  await withAuthApp({
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
    permissions: [AUTH_SERVICE_ACCOUNTS_CREATE_PERMISSION, AUTH_SERVICE_ACCOUNTS_ASSIGN_ROLES_PERMISSION, AUTH_ROLES_ASSIGN_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/service-accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${AUTH_SESSION_COOKIE_NAME}=session-token`
      },
      body: JSON.stringify({
        name: 'Automation',
        groupIds: ['group-1']
      })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), {
      error: AUTH_RECENT_VERIFICATION_REQUIRED_MESSAGE
    })
  })
})

async function withAuthApp(auth: RequestAuthContext, run: (baseUrl: string) => Promise<void>): Promise<void> {
  if (rootPrisma.authTenantMembership.findMany === originalRootAuthTenantMembershipFindMany) {
    rootPrisma.authTenantMembership.findMany = ((async () => ([])) as unknown) as typeof rootPrisma.authTenantMembership.findMany
  }

  if (prisma.authTenantMembership.findMany === originalAuthTenantMembershipFindMany) {
    prisma.authTenantMembership.findMany = ((async () => ([])) as unknown) as typeof prisma.authTenantMembership.findMany
  }

  if (prisma.authTenantMembership.count === originalAuthTenantMembershipCount) {
    prisma.authTenantMembership.count = ((async () => 0) as unknown) as typeof prisma.authTenantMembership.count
  }

  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = auth
    next()
  })
  app.use(installTenantContext())
  app.use('/api/auth', authRouter)
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

async function withAuthAuditApp(auth: RequestAuthContext, run: (baseUrl: string) => Promise<void>): Promise<void> {
  if (rootPrisma.authTenantMembership.findMany === originalRootAuthTenantMembershipFindMany) {
    rootPrisma.authTenantMembership.findMany = ((async () => ([])) as unknown) as typeof rootPrisma.authTenantMembership.findMany
  }

  if (prisma.authTenantMembership.findMany === originalAuthTenantMembershipFindMany) {
    prisma.authTenantMembership.findMany = ((async () => ([])) as unknown) as typeof prisma.authTenantMembership.findMany
  }

  if (prisma.authTenantMembership.count === originalAuthTenantMembershipCount) {
    prisma.authTenantMembership.count = ((async () => 0) as unknown) as typeof prisma.authTenantMembership.count
  }

  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = auth
    next()
  })
  app.use(installTenantContext())
  app.use(installAuditLogCapture())
  app.use('/api/auth', authRouter)
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