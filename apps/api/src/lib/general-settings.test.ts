import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_APP_LANDING_PAGE } from '@printstream/shared'
import { getGeneralSettings, updateGeneralSettings } from './general-settings.js'
import { listAllWorkspaceSupportPermissions } from './support-access.js'
import { withTenantRequestContext } from './tenant-context.js'

test('getGeneralSettings defaults unconstrained width off when unset', async () => {
  const settings = await getGeneralSettings({
    async findUnique() {
      return null
    },
    async upsert() {
      throw new Error('upsert should not be called')
    }
  })

  assert.deepEqual(settings, {
    appTheme: 'default',
    unconstrainedWidth: false,
    landingPage: DEFAULT_APP_LANDING_PAGE,
    supportAccessEnabled: true,
    supportAccessPermissions: listAllWorkspaceSupportPermissions()
  })
})

test('getGeneralSettings reads a persisted unconstrained width flag', async () => {
  const settings = await getGeneralSettings({
    async findUnique(args) {
      if (args.where.key.endsWith('app:general:unconstrainedWidth')) {
        return { value: 'true' }
      }
      return null
    },
    async upsert() {
      throw new Error('upsert should not be called')
    }
  })

  assert.deepEqual(settings, {
    appTheme: 'default',
    unconstrainedWidth: true,
    landingPage: DEFAULT_APP_LANDING_PAGE,
    supportAccessEnabled: true,
    supportAccessPermissions: listAllWorkspaceSupportPermissions()
  })
})

test('updateGeneralSettings upserts the shared unconstrained width flag', async () => {
  let receivedArgs: unknown = null
  const settings = await updateGeneralSettings({ unconstrainedWidth: true }, {
    async findUnique() {
      return null
    },
    async upsert(args) {
      receivedArgs = args
      return { key: 'app:general:unconstrainedWidth', value: 'true' }
    }
  })

  assert.deepEqual(settings, {
    appTheme: 'default',
    unconstrainedWidth: true,
    landingPage: DEFAULT_APP_LANDING_PAGE,
    supportAccessEnabled: true,
    supportAccessPermissions: listAllWorkspaceSupportPermissions()
  })
  assert.deepEqual(receivedArgs, {
    where: { key: 'platform:app:general:unconstrainedWidth' },
    create: { key: 'platform:app:general:unconstrainedWidth', value: 'true' },
    update: { value: 'true' }
  })
})

test('updateGeneralSettings writes support access policy in workspace scope without resetting other values', async () => {
  const upserts: unknown[] = []

  const settings = await withTenantRequestContext({ id: 'tenant-1', slug: 'alpha', name: 'Alpha' }, async () => {
    return await updateGeneralSettings({
      supportAccessEnabled: false,
      supportAccessPermissions: ['printers.view', 'jobs.view']
    }, {
      async findUnique(args) {
        if (args.where.key === 'tenant:tenant-1:app:general:unconstrainedWidth') {
          return { value: 'true' }
        }
        return null
      },
      async upsert(args) {
        upserts.push(args)
        return { key: args.where.key, value: args.update.value }
      }
    })
  })

  assert.deepEqual(settings, {
    appTheme: 'default',
    unconstrainedWidth: true,
    landingPage: DEFAULT_APP_LANDING_PAGE,
    supportAccessEnabled: false,
    supportAccessPermissions: ['printers.view', 'jobs.view']
  })
  assert.deepEqual(upserts, [
    {
      where: { key: 'tenant:tenant-1:auth:supportAccessEnabled' },
      create: { key: 'tenant:tenant-1:auth:supportAccessEnabled', value: 'false' },
      update: { value: 'false' }
    },
    {
      where: { key: 'tenant:tenant-1:auth:supportAccessPermissions' },
      create: { key: 'tenant:tenant-1:auth:supportAccessPermissions', value: '["printers.view","jobs.view"]' },
      update: { value: '["printers.view","jobs.view"]' }
    }
  ])
})