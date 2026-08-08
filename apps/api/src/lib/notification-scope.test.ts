import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listWorkspaceScopesWithPluginSetting } from './notification-scope.js'

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

test('listWorkspaceScopesWithPluginSetting extracts workspace ids from scoped plugin keys', async () => {
  const prisma = settingReader([
    'plugin:notifications-browser:subscriptions', // platform scope: not a workspace
    'plugin:notifications-browser:workspace:workspace-a:subscriptions',
    'plugin:notifications-browser:workspace:workspace-b:subscriptions',
    'plugin:notifications-browser:workspace:workspace-b:subscriptions', // duplicate row
    'plugin:notifications-browser:workspace:workspace-c:vapidSubject', // different key
    'plugin:notifications-discord:workspace:workspace-d:subscriptions' // different plugin
  ])

  const scopes = await listWorkspaceScopesWithPluginSetting(prisma, 'notifications-browser', 'subscriptions')

  assert.deepEqual(scopes.sort(), ['workspace-a', 'workspace-b'])
})

test('listWorkspaceScopesWithPluginSetting returns empty when nothing matches', async () => {
  const scopes = await listWorkspaceScopesWithPluginSetting(settingReader([]), 'notifications-browser', 'subscriptions')
  assert.deepEqual(scopes, [])
})
