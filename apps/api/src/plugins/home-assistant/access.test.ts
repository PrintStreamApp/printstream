import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHomeAssistantAccessToken, readHomeAssistantAccessStatus } from './access.js'

test('home assistant access status reports missing when no token has been created', async () => {
  const harness = createHarness()

  const status = await readHomeAssistantAccessStatus(harness.prisma as never, harness.settings)

  assert.equal(status.state, 'missing')
  assert.equal(status.tokenRequired, true)
  assert.equal(status.serviceAccount, null)
  assert.ok(status.recommendedPermissions.includes('printers.view'))
  assert.ok(status.recommendedPermissions.includes('printers.control'))
})

test('creating a home assistant access token tracks the new service account and revokes the previous one', async () => {
  const harness = createHarness()

  const first = await createHomeAssistantAccessToken(harness.prisma as never, harness.settings, 'tenant-1')
  const second = await createHomeAssistantAccessToken(harness.prisma as never, harness.settings, 'tenant-1')
  const status = await readHomeAssistantAccessStatus(harness.prisma as never, harness.settings)

  assert.match(first.token, /^bhs_/)
  assert.match(second.token, /^bhs_/)
  assert.notEqual(first.serviceAccount.id, second.serviceAccount.id)
  assert.equal(harness.serviceAccounts.get(first.serviceAccount.id)?.revokedAt instanceof Date, true)
  assert.equal(status.state, 'active')
  assert.equal(status.serviceAccount?.id, second.serviceAccount.id)
  assert.deepEqual(status.missingPermissions, [])
})

test('home assistant access status reports deleted when the tracked service account disappears', async () => {
  const harness = createHarness()
  const created = await createHomeAssistantAccessToken(harness.prisma as never, harness.settings, 'tenant-1')

  harness.serviceAccounts.delete(created.serviceAccount.id)

  const status = await readHomeAssistantAccessStatus(harness.prisma as never, harness.settings)

  assert.equal(status.state, 'deleted')
  assert.equal(status.serviceAccount, null)
})

function createHarness() {
  const settingsStore = new Map<string, string>()
  const groups = new Map<string, {
    tenantId: string
    key: string
    name: string
    description: string | null
    permissions: string[]
    isSystem: boolean
    isEditable: boolean
    isRemovable: boolean
  }>()
  const serviceAccounts = new Map<string, {
    id: string
    tenantId: string
    name: string
    tokenHash: string
    tokenPrefix: string
    revokedAt: Date | null
    createdAt: Date
    updatedAt: Date
    groupKey: string
  }>()
  let nextId = 1

  const prisma = {
    authGroup: {
      async upsert(args: {
        where: { tenantId_key: { tenantId: string; key: string } }
        create: {
          tenantId: string
          key: string
          name: string
          description: string
          permissions: string[]
          isSystem: boolean
          isEditable: boolean
          isRemovable: boolean
        }
        update: {
          name: string
          description: string
          permissions: string[]
          isSystem: boolean
          isEditable: boolean
          isRemovable: boolean
        }
      }) {
        const key = `${args.where.tenantId_key.tenantId}:${args.where.tenantId_key.key}`
        const existing = groups.get(key)
        if (existing) {
          const updated = {
            ...existing,
            ...args.update
          }
          groups.set(key, updated)
          return updated
        }

        const created = {
          tenantId: args.create.tenantId,
          key: args.create.key,
          name: args.create.name,
          description: args.create.description,
          permissions: [...args.create.permissions],
          isSystem: args.create.isSystem,
          isEditable: args.create.isEditable,
          isRemovable: args.create.isRemovable
        }
        groups.set(key, created)
        return created
      }
    },
    authServiceAccount: {
      async findFirst(args: {
        where: { id: string }
        select?: { id: true; revokedAt: true }
        include?: unknown
      }) {
        const row = serviceAccounts.get(args.where.id)
        if (!row) {
          return null
        }

        if (args.select) {
          return {
            id: row.id,
            revokedAt: row.revokedAt
          }
        }

        return toServiceAccountRow(row)
      },
      async create(args: {
        data: {
          tenantId: string
          name: string
          tokenHash: string
          tokenPrefix: string
          memberships: {
            create: {
              group: {
                connect: {
                  tenantId_key: {
                    tenantId: string
                    key: string
                  }
                }
              }
            }
          }
        }
        include: unknown
      }) {
        const id = `service-account-${nextId++}`
        const now = new Date(`2026-05-10T00:00:0${nextId}Z`)
        const row = {
          id,
          tenantId: args.data.tenantId,
          name: args.data.name,
          tokenHash: args.data.tokenHash,
          tokenPrefix: args.data.tokenPrefix,
          revokedAt: null,
          createdAt: now,
          updatedAt: now,
          groupKey: `${args.data.memberships.create.group.connect.tenantId_key.tenantId}:${args.data.memberships.create.group.connect.tenantId_key.key}`
        }
        serviceAccounts.set(id, row)
        return toServiceAccountRow(row)
      },
      async update(args: {
        where: { id: string }
        data: { revokedAt: Date }
      }) {
        const existing = serviceAccounts.get(args.where.id)
        if (!existing) {
          throw new Error('Missing service account')
        }

        const updated = {
          ...existing,
          revokedAt: args.data.revokedAt,
          updatedAt: args.data.revokedAt
        }
        serviceAccounts.set(existing.id, updated)
        return toServiceAccountRow(updated)
      }
    }
  }

  function toServiceAccountRow(row: {
    id: string
    tenantId: string
    name: string
    tokenHash: string
    tokenPrefix: string
    revokedAt: Date | null
    createdAt: Date
    updatedAt: Date
    groupKey: string
  }) {
    const group = groups.get(row.groupKey)
    if (!group) {
      throw new Error('Missing group')
    }

    return {
      id: row.id,
      name: row.name,
      tokenPrefix: row.tokenPrefix,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      memberships: [{
        group: {
          permissions: [...group.permissions]
        }
      }]
    }
  }

  return {
    prisma,
    settings: {
      async get(key: string) {
        return settingsStore.get(key) ?? null
      },
      async set(key: string, value: string) {
        settingsStore.set(key, value)
      },
      async delete(key: string) {
        settingsStore.delete(key)
      },
      forTenant() {
        return this
      }
    },
    serviceAccounts
  }
}