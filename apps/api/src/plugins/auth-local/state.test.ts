import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PrismaClient } from '@prisma/client'
import {
  TENANTS_MANAGE_PERMISSION,
  filterPermissionDefinitionsForPlatformContext,
  filterPermissionsForPlatformContext,
  permissionDefinitions,
  permissionValues
} from '@printstream/shared'
import { buildLocalAuthStatus } from './state.js'
import { withTenantRequestContext } from '../../lib/tenant-context.js'

test('buildLocalAuthStatus reports first-run setup while no auth users exist', async () => {
  const prisma = {
    authPasskeyCredential: { count: async () => 0 },
    authGroup: { count: async () => 3 },
    authServiceAccount: { count: async () => 0 },
    authTenantMembership: { count: async () => 0 },
    authUser: {
      count: async () => 0,
      findFirst: async () => null
    },
    setting: { findUnique: async () => null }
  } as unknown as PrismaClient

  const status = await buildLocalAuthStatus(prisma)

  assert.deepEqual(status, {
    setupRequired: true,
    sessionDuration: 'day',
    permissions: filterPermissionsForPlatformContext([...permissionValues]),
    permissionDefinitions: filterPermissionDefinitionsForPlatformContext(permissionDefinitions),
    initialAdminEmail: null,
    counts: {
      users: 0,
      groups: 3,
      serviceAccounts: 0,
      passkeys: 0
    }
  })
})

test('buildLocalAuthStatus stays in setup mode when the first admin is explicitly pending verification', async () => {
  const prisma = {
    authTenantMembership: { count: async () => 0 },
    authGroup: { count: async () => 0 },
    authServiceAccount: { count: async () => 0 },
    authUser: {
      count: async () => 1,
      findFirst: async () => ({ email: 'admin@example.com' })
    },
    authPasskeyCredential: { count: async () => 0 },
    setting: { findUnique: async () => null }
  } as unknown as PrismaClient

  const status = await buildLocalAuthStatus(prisma, { setupComplete: false })

  assert.equal(status.setupRequired, true)
  assert.equal(status.sessionDuration, 'day')
  assert.equal(status.counts.users, 1)
  assert.equal(status.counts.groups, 0)
  assert.equal(status.counts.serviceAccounts, 0)
  assert.equal(status.counts.passkeys, 0)
  assert.equal(status.initialAdminEmail, 'admin@example.com')
})

test('buildLocalAuthStatus treats missing setup state with existing users as re-enabled auth', async () => {
  const prisma = {
    authTenantMembership: { count: async () => 0 },
    authGroup: { count: async () => 0 },
    authServiceAccount: { count: async () => 0 },
    authUser: {
      count: async () => 1,
      findFirst: async () => ({ email: 'admin@example.com' })
    },
    authPasskeyCredential: { count: async () => 0 },
    setting: { findUnique: async () => null }
  } as unknown as PrismaClient

  const status = await buildLocalAuthStatus(prisma)

  assert.equal(status.setupRequired, false)
  assert.equal(status.sessionDuration, 'day')
  assert.equal(status.counts.users, 1)
  assert.equal(status.counts.groups, 0)
  assert.equal(status.counts.serviceAccounts, 0)
  assert.equal(status.counts.passkeys, 0)
  assert.equal(status.initialAdminEmail, null)
})

test('buildLocalAuthStatus clears setupRequired once the initial admin email is verified', async () => {
  const prisma = {
    authTenantMembership: { count: async () => 0 },
    authGroup: { count: async () => 0 },
    authServiceAccount: { count: async () => 0 },
    authUser: {
      count: async () => 1,
      findFirst: async () => ({ email: 'admin@example.com' })
    },
    authPasskeyCredential: { count: async () => 0 },
    setting: { findUnique: async () => null }
  } as unknown as PrismaClient

  const status = await buildLocalAuthStatus(prisma, { setupComplete: true })

  assert.equal(status.setupRequired, false)
  assert.equal(status.counts.users, 1)
  assert.equal(status.counts.passkeys, 0)
  assert.equal(status.initialAdminEmail, null)
})

test('buildLocalAuthStatus clears setupRequired once an auth user has a credential', async () => {
  const prisma = {
    authTenantMembership: { count: async () => 0 },
    authGroup: { count: async () => 0 },
    authServiceAccount: { count: async () => 0 },
    authUser: {
      count: async () => 1,
      findFirst: async () => ({ email: 'admin@example.com' })
    },
    authPasskeyCredential: { count: async () => 3 },
    setting: { findUnique: async () => null }
  } as unknown as PrismaClient

  const status = await buildLocalAuthStatus(prisma)

  assert.equal(status.setupRequired, false)
  assert.equal(status.sessionDuration, 'day')
  assert.equal(status.counts.users, 1)
  assert.equal(status.counts.groups, 0)
  assert.equal(status.counts.serviceAccounts, 0)
  assert.equal(status.counts.passkeys, 3)
  assert.equal(status.initialAdminEmail, null)
})

test('buildLocalAuthStatus hides platform-only permissions in tenant workspaces', async () => {
  const prisma = {
    authPasskeyCredential: { count: async () => 0 },
    authTenantMembership: { count: async () => 0 },
    authUser: {
      count: async () => 0,
      findFirst: async () => null
    },
    authGroup: { count: async () => 0 },
    authServiceAccount: { count: async () => 0 },
    setting: { findUnique: async () => null }
  } as unknown as PrismaClient

  const status = await withTenantRequestContext({ id: 'tenant-1', slug: 'alpha', name: 'Alpha' }, async () => await buildLocalAuthStatus(prisma))

  assert.equal(status.permissions.includes(TENANTS_MANAGE_PERMISSION), false)
  assert.equal(status.permissionDefinitions.some((definition) => definition.key === TENANTS_MANAGE_PERMISSION), false)
})