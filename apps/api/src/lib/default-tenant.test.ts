import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listTenants, resolveSoleTenant, resolveWideOpenDefaultTenant } from './default-tenant.js'

test('listTenants requests the shared tenant directory ordering and fields', async () => {
  let findManyArgs: unknown = null

  const tenants = await listTenants({
    tenant: {
      findMany: async (args: unknown) => {
        findManyArgs = args
        return [{
          id: 'tenant-2',
          slug: 'alpha',
          name: 'Alpha',
          description: 'Workspace'
        }]
      }
    }
  } as never)

  assert.deepEqual(findManyArgs, {
    orderBy: [
      { name: 'asc' },
      { createdAt: 'asc' }
    ],
    select: {
      id: true,
      slug: true,
      name: true,
      description: true
    }
  })
  assert.deepEqual(tenants, [{
    id: 'tenant-2',
    slug: 'alpha',
    name: 'Alpha',
    description: 'Workspace'
  }])
})

test('listTenants preserves null descriptions from the tenant directory query', async () => {
  const tenants = await listTenants({
    tenant: {
      findMany: async () => ([{
        id: 'tenant-3',
        slug: 'beta',
        name: 'Beta',
        description: null
      }])
    }
  } as never)

  assert.deepEqual(tenants, [{
    id: 'tenant-3',
    slug: 'beta',
    name: 'Beta',
    description: null
  }])
})

const workspace = { id: 'tenant-1', slug: 'workspace', name: 'My Workspace' }
const otherWorkspace = { id: 'tenant-2', slug: 'second', name: 'Second Workspace' }
const demoWorkspace = { id: 'tenant-demo', slug: 'demo', name: 'Demo' }

function soleTenantDeps(overrides: Parameters<typeof resolveSoleTenant>[0] = {}) {
  return {
    listCandidateTenants: async () => [workspace],
    isTenantDisabled: async () => false,
    isPublicDemoTenant: (tenant: { slug: string }) => tenant.slug === 'demo',
    ...overrides
  }
}

test('resolveSoleTenant returns the only real workspace regardless of auth providers', async () => {
  assert.deepEqual(await resolveSoleTenant(soleTenantDeps()), workspace)
})

test('resolveSoleTenant returns null when no workspace exists', async () => {
  assert.equal(await resolveSoleTenant(soleTenantDeps({ listCandidateTenants: async () => [] })), null)
})

test('resolveSoleTenant returns null when more than one workspace is a candidate', async () => {
  assert.equal(
    await resolveSoleTenant(soleTenantDeps({ listCandidateTenants: async () => [workspace, otherWorkspace] })),
    null
  )
})

test('resolveSoleTenant ignores the public demo and disabled workspaces', async () => {
  assert.deepEqual(
    await resolveSoleTenant(soleTenantDeps({
      listCandidateTenants: async () => [demoWorkspace, otherWorkspace, workspace],
      isTenantDisabled: async (tenantId) => tenantId === otherWorkspace.id
    })),
    workspace
  )
})

function wideOpenDeps(overrides: Parameters<typeof resolveWideOpenDefaultTenant>[0] = {}) {
  return {
    listCandidateTenants: async () => [workspace],
    hasAnyEnabledProvider: async () => false,
    isTenantDisabled: async () => false,
    isPublicDemoTenant: (tenant: { slug: string }) => tenant.slug === 'demo',
    ...overrides
  }
}

test('resolveWideOpenDefaultTenant returns the single wide-open workspace', async () => {
  assert.deepEqual(await resolveWideOpenDefaultTenant(wideOpenDeps()), workspace)
})

test('resolveWideOpenDefaultTenant returns null when any provider is enabled at platform scope', async () => {
  assert.equal(
    await resolveWideOpenDefaultTenant(wideOpenDeps({
      hasAnyEnabledProvider: async (tenant) => tenant == null
    })),
    null
  )
})

test('resolveWideOpenDefaultTenant returns null when the workspace itself has auth enabled', async () => {
  assert.equal(
    await resolveWideOpenDefaultTenant(wideOpenDeps({
      hasAnyEnabledProvider: async (tenant) => tenant != null
    })),
    null
  )
})

test('resolveWideOpenDefaultTenant returns null when more than one workspace is a candidate', async () => {
  assert.equal(
    await resolveWideOpenDefaultTenant(wideOpenDeps({
      listCandidateTenants: async () => [workspace, otherWorkspace]
    })),
    null
  )
})

test('resolveWideOpenDefaultTenant ignores the public demo and disabled workspaces', async () => {
  assert.deepEqual(
    await resolveWideOpenDefaultTenant(wideOpenDeps({
      listCandidateTenants: async () => [demoWorkspace, otherWorkspace, workspace],
      isTenantDisabled: async (tenantId) => tenantId === otherWorkspace.id
    })),
    workspace
  )
})

test('resolveWideOpenDefaultTenant returns null when no workspaces exist yet', async () => {
  assert.equal(
    await resolveWideOpenDefaultTenant(wideOpenDeps({
      listCandidateTenants: async () => []
    })),
    null
  )
})