import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listTenants } from './default-tenant.js'

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