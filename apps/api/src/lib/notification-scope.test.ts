import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listTenantScopesWithPluginSetting } from './notification-scope.js'

function settingReader(keys: string[]) {
  return {
    setting: {
      async findMany({ where }: { where: { key: { startsWith: string; endsWith: string } } }) {
        return keys
          .filter((key) => key.startsWith(where.key.startsWith) && key.endsWith(where.key.endsWith))
          .map((key) => ({ key }))
      }
    }
  }
}

test('listTenantScopesWithPluginSetting extracts tenant ids from scoped plugin keys', async () => {
  const prisma = settingReader([
    'plugin:notifications-browser:subscriptions', // platform scope: not a tenant
    'plugin:notifications-browser:tenant:tenant-a:subscriptions',
    'plugin:notifications-browser:tenant:tenant-b:subscriptions',
    'plugin:notifications-browser:tenant:tenant-b:subscriptions', // duplicate row
    'plugin:notifications-browser:tenant:tenant-c:vapidSubject', // different key
    'plugin:notifications-discord:tenant:tenant-d:subscriptions' // different plugin
  ])

  const scopes = await listTenantScopesWithPluginSetting(prisma, 'notifications-browser', 'subscriptions')

  assert.deepEqual(scopes.sort(), ['tenant-a', 'tenant-b'])
})

test('listTenantScopesWithPluginSetting returns empty when nothing matches', async () => {
  const scopes = await listTenantScopesWithPluginSetting(settingReader([]), 'notifications-browser', 'subscriptions')
  assert.deepEqual(scopes, [])
})
