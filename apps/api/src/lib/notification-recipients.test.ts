import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NotificationMessage } from '@printstream/shared'
import type { PluginSettingStore } from '../plugin/types.js'
import {
  createChannelRecipient,
  LEGACY_RECIPIENT_ID,
  readChannelRecipients,
  resolveChannelDeliveryUrls,
  writeChannelRecipients,
  type ChannelRecipient
} from './notification-recipients.js'

const LEGACY = { legacyUrlKey: 'webhookUrl', legacyLabel: 'Discord webhook' }

function memoryStore(initial: Record<string, string> = {}): PluginSettingStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  const store = {
    data,
    async get(key: string) { return data.get(key) ?? null },
    async set(key: string, value: string) { data.set(key, value) },
    async delete(key: string) { data.delete(key) },
    forWorkspace(): never { throw new Error('not used') }
  }
  return store
}

function message(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    id: 'message-1',
    category: 'system',
    level: 'info',
    title: 'Title',
    body: 'Body',
    timestamp: '2026-07-12T00:00:00.000Z',
    ...overrides
  }
}

function recipient(url: string, userId?: string): ChannelRecipient {
  return createChannelRecipient({ url, userId, userName: userId ? `Name of ${userId}` : undefined })
}

test('a legacy single-URL config reads as one shared entry until migrated', async () => {
  const store = memoryStore({ webhookUrl: 'https://discord.test/legacy' })

  const before = await readChannelRecipients(store, LEGACY)
  assert.equal(before.length, 1)
  assert.equal(before[0]!.id, LEGACY_RECIPIENT_ID)
  assert.equal(before[0]!.url, 'https://discord.test/legacy')
  assert.equal(before[0]!.userId, undefined)

  await writeChannelRecipients(store, [...before, recipient('https://discord.test/new')], LEGACY)
  assert.equal(store.data.has('webhookUrl'), false, 'legacy key retired on first write')
  const after = await readChannelRecipients(store, LEGACY)
  assert.deepEqual(after.map((entry) => entry.url), ['https://discord.test/legacy', 'https://discord.test/new'])
})

test('broadcast messages deliver to shared entries only, with fallback when unconfigured', async () => {
  const store = memoryStore()
  await writeChannelRecipients(store, [
    recipient('https://discord.test/shared'),
    recipient('https://discord.test/personal', 'user-1')
  ], LEGACY)

  const urls = await resolveChannelDeliveryUrls({
    ...LEGACY,
    message: message({ workspaceId: 'workspace-a' }),
    pluginName: 'notifications-discord',
    prisma: { setting: { findMany: async () => [] } },
    settingsForScope: () => store,
    isEnabledForWorkspace: () => true
  })
  assert.deepEqual(urls, ['https://discord.test/shared'])

  const fallback = await resolveChannelDeliveryUrls({
    ...LEGACY,
    message: message({ workspaceId: 'workspace-b' }),
    pluginName: 'notifications-discord',
    prisma: { setting: { findMany: async () => [] } },
    settingsForScope: () => memoryStore(),
    isEnabledForWorkspace: () => true,
    fallbackUrl: 'https://ntfy.test/env-topic'
  })
  assert.deepEqual(fallback, ['https://ntfy.test/env-topic'])
})

test('workspace-scoped targeted messages deliver only to that scope\'s matching personal entries', async () => {
  const store = memoryStore()
  await writeChannelRecipients(store, [
    recipient('https://discord.test/shared'),
    recipient('https://discord.test/mine', 'user-1'),
    recipient('https://discord.test/other', 'user-2')
  ], LEGACY)

  const urls = await resolveChannelDeliveryUrls({
    ...LEGACY,
    message: message({ workspaceId: 'workspace-a', targetUserIds: ['user-1'] }),
    pluginName: 'notifications-discord',
    prisma: { setting: { findMany: async () => { throw new Error('scoped messages must not enumerate') } } },
    settingsForScope: (workspaceId) => {
      assert.equal(workspaceId, 'workspace-a')
      return store
    },
    isEnabledForWorkspace: () => true
  })
  assert.deepEqual(urls, ['https://discord.test/mine'])
})

test('workspaceless targeted messages span scopes, dedupe URLs, and skip disabled scopes', async () => {
  const platform = memoryStore()
  await writeChannelRecipients(platform, [recipient('https://discord.test/mine', 'user-1')], LEGACY)
  const workspaceA = memoryStore()
  await writeChannelRecipients(workspaceA, [
    recipient('https://discord.test/mine', 'user-1'), // same URL as platform: deduped
    recipient('https://discord.test/workspace-a', 'user-1')
  ], LEGACY)
  const workspaceB = memoryStore()
  await writeChannelRecipients(workspaceB, [recipient('https://discord.test/workspace-b', 'user-1')], LEGACY)

  const stores = new Map<string | null, PluginSettingStore>([
    [null, platform],
    ['workspace-a', workspaceA],
    ['workspace-b', workspaceB]
  ])
  const urls = await resolveChannelDeliveryUrls({
    ...LEGACY,
    message: message({ targetUserIds: ['user-1'] }),
    pluginName: 'notifications-discord',
    prisma: {
      setting: {
        findMany: async () => [
          { key: 'plugin:notifications-discord:workspace:workspace-a:recipients' },
          { key: 'plugin:notifications-discord:workspace:workspace-b:recipients' }
        ]
      }
    },
    settingsForScope: (workspaceId) => stores.get(workspaceId)!,
    isEnabledForWorkspace: (workspaceId) => workspaceId !== 'workspace-b'
  })

  assert.deepEqual(urls.sort(), ['https://discord.test/mine', 'https://discord.test/workspace-a'])
})

test('targeted messages never use the broadcast fallback URL', async () => {
  const urls = await resolveChannelDeliveryUrls({
    ...LEGACY,
    message: message({ targetUserIds: ['user-1'] }),
    pluginName: 'notifications-discord',
    prisma: { setting: { findMany: async () => [] } },
    settingsForScope: () => memoryStore(),
    isEnabledForWorkspace: () => true,
    fallbackUrl: 'https://ntfy.test/env-topic'
  })
  assert.deepEqual(urls, [])
})
