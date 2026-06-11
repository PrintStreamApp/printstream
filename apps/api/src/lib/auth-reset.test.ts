import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PLATFORM_ADMIN_GROUP_KEY, builtInAuthGroupSeeds, builtInPlatformAuthGroupSeeds } from './default-auth-groups.js'
import { resetAuthData } from './auth-reset.js'

type GroupRow = {
  id: string
  tenantId: string | null
  key: string | null
  name: string
  description: string | null
  permissions: string[]
  isSystem: boolean
  isEditable: boolean
  isRemovable: boolean
}

test('resetAuthData clears auth state, preserves tenants, and reseeds built-in roles', async () => {
  const tenants = [
    { id: 'tenant-1', slug: 'default', name: 'Default' },
    { id: 'tenant-2', slug: 'studio', name: 'Studio' }
  ]
  const groups: GroupRow[] = [{
    id: 'custom-platform-role',
    tenantId: null,
    key: 'custom_platform',
    name: 'Custom platform role',
    description: null,
    permissions: ['settings.manage'],
    isSystem: false,
    isEditable: true,
    isRemovable: true
  }]
  const settings = [
    { key: 'plugin:auth-local:platform:enabled' },
    { key: 'plugin:auth-oauth:tenant:tenant-1:clientSecret' },
    { key: 'tenant:tenant-1:auth:supportAccessEnabled' },
    { key: 'platform:auth:sessionDuration' },
    { key: 'plugin:plate-clearing:tenant:tenant-1:enabled' }
  ]
  const scalarCounts = {
    authSession: 2,
    authEmailCodeToken: 1,
    authPasskeyCredential: 1,
    authUserGroupMembership: 3,
    authServiceAccountGroupMembership: 1,
    authTenantMembership: 2,
    authServiceAccount: 1,
    authUser: 2
  }

  const prisma = createAuthResetPrisma({ tenants, groups, settings, scalarCounts })

  const result = await resetAuthData(prisma as never)

  assert.deepEqual(result.tenantsPreserved, tenants)
  assert.deepEqual(result.before, {
    users: 2,
    roles: 1,
    tenantMemberships: 2,
    serviceAccounts: 1,
    sessions: 2,
    authSettings: 4
  })
  assert.equal(result.deleted.authUsers, 2)
  assert.equal(result.deleted.authGroups, 1)
  assert.equal(result.deleted.authSettings, 4)
  assert.deepEqual(result.after, {
    users: 0,
    roles: builtInPlatformAuthGroupSeeds.length + tenants.length * builtInAuthGroupSeeds.length,
    tenantMemberships: 0,
    serviceAccounts: 0,
    sessions: 0,
    authSettings: 0
  })
  assert.equal(result.reseededRoles, result.after.roles)
  assert.equal(settings.length, 1)
  assert.equal(settings[0]?.key, 'plugin:plate-clearing:tenant:tenant-1:enabled')
  assert.equal(groups.some((group) => group.key === 'custom_platform'), false)
  assert.equal(groups.find((group) => group.key === PLATFORM_ADMIN_GROUP_KEY)?.id, 'platform-group-admin')
  assert.equal(groups.filter((group) => group.tenantId === 'tenant-1').length, builtInAuthGroupSeeds.length)
  assert.equal(groups.filter((group) => group.tenantId === 'tenant-2').length, builtInAuthGroupSeeds.length)
})

function createAuthResetPrisma(input: {
  tenants: Array<{ id: string; slug: string; name: string }>
  groups: GroupRow[]
  settings: Array<{ key: string }>
  scalarCounts: Record<string, number>
}) {
  const deleteScalar = (modelName: string) => async () => {
    const count = input.scalarCounts[modelName] ?? 0
    input.scalarCounts[modelName] = 0
    return { count }
  }
  const countScalar = (modelName: string) => async () => input.scalarCounts[modelName] ?? 0

  return {
    tenant: {
      async findMany() {
        return input.tenants
      }
    },
    authSession: { count: countScalar('authSession'), deleteMany: deleteScalar('authSession') },
    authEmailCodeToken: { deleteMany: deleteScalar('authEmailCodeToken') },
    authPasskeyCredential: { deleteMany: deleteScalar('authPasskeyCredential') },
    authUserGroupMembership: { deleteMany: deleteScalar('authUserGroupMembership') },
    authServiceAccountGroupMembership: { deleteMany: deleteScalar('authServiceAccountGroupMembership') },
    authTenantMembership: { count: countScalar('authTenantMembership'), deleteMany: deleteScalar('authTenantMembership') },
    authServiceAccount: { count: countScalar('authServiceAccount'), deleteMany: deleteScalar('authServiceAccount') },
    authUser: { count: countScalar('authUser'), deleteMany: deleteScalar('authUser') },
    authGroup: {
      async count() {
        return input.groups.length
      },
      async deleteMany() {
        const count = input.groups.length
        input.groups.splice(0, input.groups.length)
        return { count }
      },
      async findUnique(args: { where: { tenantId_key?: { tenantId: string; key: string }; id?: string } }) {
        if (args.where.tenantId_key) {
          const { tenantId, key } = args.where.tenantId_key
          return input.groups.find((group) => group.tenantId === tenantId && group.key === key) ?? null
        }
        return input.groups.find((group) => group.id === args.where.id) ?? null
      },
      async findFirst(args: { where: { tenantId: string | null; key: string } }) {
        return input.groups.find((group) => group.tenantId === args.where.tenantId && group.key === args.where.key) ?? null
      },
      async create(args: { data: Partial<GroupRow> & { key: string; name: string; permissions: string[]; isSystem: boolean; isEditable: boolean; isRemovable: boolean } }) {
        const row: GroupRow = {
          id: args.data.id ?? `group-${input.groups.length + 1}`,
          tenantId: args.data.tenantId ?? null,
          key: args.data.key,
          name: args.data.name,
          description: args.data.description ?? null,
          permissions: args.data.permissions,
          isSystem: args.data.isSystem,
          isEditable: args.data.isEditable,
          isRemovable: args.data.isRemovable
        }
        input.groups.push(row)
        return row
      },
      async update(args: { where: { id: string }; data: Partial<GroupRow> }) {
        const existing = input.groups.find((group) => group.id === args.where.id)
        if (!existing) throw new Error('missing auth group')
        Object.assign(existing, args.data)
        return existing
      }
    },
    setting: {
      async count() {
        return input.settings.filter((row) => isAuthResetSetting(row.key)).length
      },
      async deleteMany() {
        const before = input.settings.length
        const remaining = input.settings.filter((row) => !isAuthResetSetting(row.key))
        input.settings.splice(0, input.settings.length, ...remaining)
        return { count: before - remaining.length }
      }
    },
    async $transaction(run: (tx: unknown) => Promise<unknown>) {
      return await run(this)
    }
  }
}

function isAuthResetSetting(key: string): boolean {
  return key.startsWith('plugin:auth-local:')
    || key.startsWith('plugin:auth-oauth:')
    || key.includes(':auth:sessionDuration')
    || key.includes(':auth:supportAccess')
    || key.startsWith('auth:')
}