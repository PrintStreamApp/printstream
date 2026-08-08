import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PrismaClient } from '@prisma/client'
import {
  AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION,
  AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION,
  AUTH_ROLES_VIEW_PERMISSION,
  AUTH_SERVICE_ACCOUNTS_VIEW_PERMISSION,
  AUTH_USERS_VIEW_PERMISSION,
  filterPermissionsForPlatformContext
} from '@printstream/shared'
import {
  PLATFORM_ADMIN_GROUP_KEY,
  builtInAuthGroupSeeds,
  builtInPlatformAuthGroupSeeds,
  ensureBuiltInAuthGroups,
  ensureBuiltInPlatformAuthGroups
} from './default-auth-groups.js'

type AuthGroupRow = {
  id: string
  workspaceId: string | null
  key: string | null
  name: string
  description: string | null
  permissions: string[]
  isSystem: boolean
  isEditable: boolean
  isRemovable: boolean
}

test('ensureBuiltInAuthGroups creates the default workspace roles', async () => {
  const store = createAuthGroupStore()

  await ensureBuiltInAuthGroups(store.prisma, 'workspace-1')

  assert.deepEqual(store.keysForWorkspace('workspace-1'), builtInAuthGroupSeeds.map((seed) => seed.key))
  assert.deepEqual(store.get('workspace-1', 'viewer')?.permissions, ['printers.view', 'camera.view', 'jobs.view'])
  assert.deepEqual(store.get('workspace-1', 'operator')?.permissions, [
    'printers.view',
    'camera.view',
    'jobs.view',
    'printers.control',
    'printers.clearPlate',
    'printerStorage.view',
    'library.view',
    'prints.dispatch'
  ])
  assert.equal(store.get('workspace-1', 'technician')?.name, 'Manager')
  assert.deepEqual(store.get('workspace-1', 'technician')?.permissions, builtInAuthGroupSeeds.find((seed) => seed.key === 'technician')?.permissions)
  assert.equal(store.get('workspace-1', 'viewer')?.permissions.includes('jobs.delete'), false)
  assert.equal(store.get('workspace-1', 'operator')?.permissions.includes('jobs.delete'), false)
  assert.equal(store.get('workspace-1', 'technician')?.permissions.includes('jobs.delete'), true)
  assert.equal(store.get('workspace-1', 'technician')?.permissions.includes(AUTH_USERS_VIEW_PERMISSION), true)
  assert.equal(store.get('workspace-1', 'technician')?.permissions.includes(AUTH_ROLES_VIEW_PERMISSION), true)
  assert.equal(store.get('workspace-1', 'technician')?.permissions.includes(AUTH_SERVICE_ACCOUNTS_VIEW_PERMISSION), true)
  assert.equal(store.get('workspace-1', 'technician')?.permissions.includes(AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION), true)
  assert.equal(store.get('workspace-1', 'admin')?.permissions.includes('jobs.delete'), true)
  assert.equal(store.get('workspace-1', 'admin')?.permissions.includes(AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION), true)
  assert.deepEqual(store.get('workspace-1', 'admin')?.permissions, builtInAuthGroupSeeds.find((seed) => seed.key === 'admin')?.permissions)
  assert.equal(store.get('workspace-1', 'admin')?.isEditable, false)
  assert.equal(store.get('workspace-1', 'admin')?.isRemovable, false)
})

test('ensureBuiltInPlatformAuthGroups creates and restores platform roles without deleting custom roles', async () => {
  const store = createAuthGroupStore([
    platformGroup({
      id: 'platform-group-admin',
      key: PLATFORM_ADMIN_GROUP_KEY,
      name: 'Broken',
      description: 'Broken',
      permissions: ['jobs.view'],
      isSystem: false,
      isEditable: true,
      isRemovable: true
    }),
    platformGroup({
      id: 'custom-platform-role',
      key: 'custom_platform',
      name: 'Custom',
      description: null,
      permissions: ['settings.manage'],
      isSystem: false,
      isEditable: true,
      isRemovable: true
    })
  ])

  await ensureBuiltInPlatformAuthGroups(store.prisma)

  assert.deepEqual(new Set(store.keysForWorkspace(null)), new Set([...builtInPlatformAuthGroupSeeds.map((seed) => seed.key), 'custom_platform']))
  assert.deepEqual(store.get(null, PLATFORM_ADMIN_GROUP_KEY), {
    id: 'platform-group-admin',
    workspaceId: null,
    key: PLATFORM_ADMIN_GROUP_KEY,
    name: 'Admin',
    description: 'Full platform access including billing, settings, plugins, workspaces, auth management, and support-access bypass.',
    permissions: builtInPlatformAuthGroupSeeds.find((seed) => seed.key === PLATFORM_ADMIN_GROUP_KEY)?.permissions,
    isSystem: true,
    isEditable: false,
    isRemovable: false
  })
  assert.equal(store.get(null, 'custom_platform')?.name, 'Custom')
})

test('built-in platform role permissions are platform-visible', () => {
  for (const seed of builtInPlatformAuthGroupSeeds) {
    assert.deepEqual(seed.permissions, filterPermissionsForPlatformContext(seed.permissions), `${seed.key} contains a hidden platform permission`)
  }
})

test('platform Manager stays below platform Admin without support-access bypass', () => {
  const manager = builtInPlatformAuthGroupSeeds.find((seed) => seed.key === 'platform_manager')
  const admin = builtInPlatformAuthGroupSeeds.find((seed) => seed.key === PLATFORM_ADMIN_GROUP_KEY)
  const support = builtInPlatformAuthGroupSeeds.find((seed) => seed.key === 'platform_support')

  assert.ok(manager)
  assert.ok(admin)
  assert.ok(support)
  assert.equal(manager.permissions.includes(AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION), false)
  // Support is READ-ONLY, not empty: it looks up what an account holds so it can
  // answer questions. What matters is that it stays a strict subset of Manager
  // and never gains a write. `platform-account-authority.test.ts` pins which
  // permissions those are.
  assert.ok(
    support.permissions.every((permission) => manager.permissions.includes(permission)),
    'Support must not hold anything Manager lacks'
  )
  assert.ok(support.permissions.length < manager.permissions.length)
  assert.equal(support.permissions.includes(AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION), false)
  assert.equal(admin.permissions.every((permission) => manager.permissions.includes(permission)), false)
})

test('ensureBuiltInAuthGroups preserves customized lower roles but restores fixed Admin', async () => {
  const store = createAuthGroupStore([
    workspaceGroup('workspace-1', {
      id: 'viewer-id',
      key: 'viewer',
      name: 'Viewer+',
      description: 'Customized',
      permissions: ['printers.view', 'jobs.view', 'camera.view'],
      isSystem: true,
      isEditable: true,
      isRemovable: false
    }),
    workspaceGroup('workspace-1', {
      id: 'admin-id',
      key: 'admin',
      name: 'Admin',
      description: 'Broken',
      permissions: ['jobs.view'],
      isSystem: false,
      isEditable: true,
      isRemovable: true
    })
  ])

  await ensureBuiltInAuthGroups(store.prisma, 'workspace-1')

  assert.deepEqual(store.get('workspace-1', 'viewer')?.permissions, ['printers.view', 'jobs.view', 'camera.view'])
  assert.deepEqual(store.get('workspace-1', 'admin')?.permissions, builtInAuthGroupSeeds.find((seed) => seed.key === 'admin')?.permissions)
  assert.equal(store.get('workspace-1', 'admin')?.isEditable, false)
  assert.equal(store.get('workspace-1', 'admin')?.isRemovable, false)
})

test('ensureBuiltInAuthGroups upgrades previous built-in role snapshots', async () => {
  const store = createAuthGroupStore([
    workspaceGroup('workspace-1', {
      id: 'viewer-id',
      key: 'viewer',
      name: 'Viewer',
      description: 'Read-only visibility into printers, camera feeds, and jobs.',
      permissions: ['printers.view', 'camera.view', 'jobs.view'],
      isSystem: true,
      isEditable: true,
      isRemovable: false
    }),
    workspaceGroup('workspace-1', {
      id: 'operator-id',
      key: 'operator',
      name: 'Operator',
      description: 'Viewer access plus library browsing, print dispatch, and read-only printer storage browsing.',
      permissions: ['printers.view', 'camera.view', 'jobs.view', 'printers.clearPlate', 'printerStorage.view', 'library.view', 'prints.dispatch'],
      isSystem: true,
      isEditable: true,
      isRemovable: false
    }),
    workspaceGroup('workspace-1', {
      id: 'technician-id',
      key: 'technician',
      name: 'Technician',
      description: 'Maintain printers and shared files, including printer configuration, storage downloads, and library management.',
      permissions: ['printers.view', 'camera.view', 'jobs.view', 'printers.control', 'printers.manage', 'printerStorage.view', 'printerStorage.download', 'library.view', 'library.download', 'library.upload', 'library.manage'],
      isSystem: true,
      isEditable: true,
      isRemovable: false
    }),
    workspaceGroup('workspace-2', {
      id: 'workspace-2-technician-id',
      key: 'technician',
      name: 'Manager',
      description: 'Coordinate day-to-day operations, including print dispatch, plate clearing, printer management, storage downloads, and library management.',
      permissions: ['printers.view', 'camera.view', 'jobs.view', 'printers.control', 'printers.clearPlate', 'printers.manage', 'printerStorage.view', 'printerStorage.download', 'library.view', 'library.download', 'library.upload', 'library.manage', 'prints.dispatch'],
      isSystem: true,
      isEditable: true,
      isRemovable: false
    })
  ])

  await ensureBuiltInAuthGroups(store.prisma, 'workspace-1')
  await ensureBuiltInAuthGroups(store.prisma, 'workspace-2')

  assert.deepEqual(store.get('workspace-1', 'viewer')?.permissions, ['printers.view', 'camera.view', 'jobs.view'])
  assert.deepEqual(store.get('workspace-1', 'operator')?.permissions, ['printers.view', 'camera.view', 'jobs.view', 'printers.control', 'printers.clearPlate', 'printerStorage.view', 'library.view', 'prints.dispatch'])
  assert.equal(store.get('workspace-1', 'technician')?.name, 'Manager')
  assert.deepEqual(store.get('workspace-1', 'technician')?.permissions, builtInAuthGroupSeeds.find((seed) => seed.key === 'technician')?.permissions)
  assert.deepEqual(store.get('workspace-2', 'technician')?.permissions, builtInAuthGroupSeeds.find((seed) => seed.key === 'technician')?.permissions)
})

function createAuthGroupStore(initialRows: AuthGroupRow[] = []) {
  const rows = [...initialRows]

  const prisma = {
    authGroup: {
      async findUnique(input: { where: { workspaceId_key?: { workspaceId: string; key: string }; id?: string } }) {
        if (input.where.workspaceId_key) {
          const { workspaceId, key } = input.where.workspaceId_key
          return rows.find((row) => row.workspaceId === workspaceId && row.key === key) ?? null
        }
        return rows.find((row) => row.id === input.where.id) ?? null
      },
      async findFirst(input: { where: { workspaceId: string | null; key: string } }) {
        return rows.find((row) => row.workspaceId === input.where.workspaceId && row.key === input.where.key) ?? null
      },
      async create(input: { data: Partial<AuthGroupRow> & { key: string | null; name: string; description: string; permissions: string[]; isSystem: boolean; isEditable: boolean; isRemovable: boolean } }) {
        const row: AuthGroupRow = {
          id: input.data.id ?? `group-${rows.length + 1}`,
          workspaceId: input.data.workspaceId ?? null,
          key: input.data.key,
          name: input.data.name,
          description: input.data.description,
          permissions: input.data.permissions,
          isSystem: input.data.isSystem,
          isEditable: input.data.isEditable,
          isRemovable: input.data.isRemovable
        }
        rows.push(row)
        return row
      },
      async update(input: { where: { id: string }; data: Partial<AuthGroupRow> }) {
        const existing = rows.find((row) => row.id === input.where.id)
        if (!existing) throw new Error('missing row')
        Object.assign(existing, input.data)
        return existing
      }
    }
  } as unknown as PrismaClient

  return {
    prisma,
    get(workspaceId: string | null, key: string) {
      return rows.find((row) => row.workspaceId === workspaceId && row.key === key)
    },
    keysForWorkspace(workspaceId: string | null) {
      return rows.filter((row) => row.workspaceId === workspaceId).map((row) => row.key)
    }
  }
}

function platformGroup(row: Omit<AuthGroupRow, 'workspaceId'>): AuthGroupRow {
  return { ...row, workspaceId: null }
}

function workspaceGroup(workspaceId: string, row: Omit<AuthGroupRow, 'workspaceId'>): AuthGroupRow {
  return { ...row, workspaceId }
}
