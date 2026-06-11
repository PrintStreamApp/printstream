/**
 * Regression tests for the first-run default workspace bootstrap: it must
 * only create a workspace when none exists and the feature is enabled, and
 * it must seed the built-in auth groups for the new tenant.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ensureDefaultWorkspace } from './default-workspace.js'

function fakeClient(initialCount: number) {
  const created: Array<{ slug: string; name: string }> = []
  return {
    created,
    client: {
      tenant: {
        count: async () => initialCount,
        create: async (args: { data: { slug: string; name: string } }) => {
          created.push(args.data)
          return { id: 'tenant-1', slug: args.data.slug }
        }
      }
    }
  }
}

test('creates a default workspace and seeds auth groups when no tenant exists', async () => {
  const { client, created } = fakeClient(0)
  const seededTenantIds: string[] = []
  const slug = await ensureDefaultWorkspace({
    enabled: true,
    client,
    ensureGroups: async (_client, tenantId) => {
      seededTenantIds.push(tenantId)
    }
  })
  assert.equal(slug, created[0]?.slug)
  assert.equal(created.length, 1)
  assert.deepEqual(seededTenantIds, ['tenant-1'])
})

test('does nothing when a tenant already exists', async () => {
  const { client, created } = fakeClient(2)
  const slug = await ensureDefaultWorkspace({
    enabled: true,
    client,
    ensureGroups: async () => assert.fail('should not seed groups')
  })
  assert.equal(slug, null)
  assert.equal(created.length, 0)
})

test('does nothing when disabled', async () => {
  const { client, created } = fakeClient(0)
  const slug = await ensureDefaultWorkspace({
    enabled: false,
    client,
    ensureGroups: async () => assert.fail('should not seed groups')
  })
  assert.equal(slug, null)
  assert.equal(created.length, 0)
})
