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
    forTenant(): never { throw new Error('not used') }
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
    message: message({ tenantId: 'tenant-a' }),
    pluginName: 'notifications-discord',
    prisma: { setting: { findMany: async () => [] } },
    settingsForScope: () => store,
    isEnabledForTenant: () => true
  })
  assert.deepEqual(urls, ['https://discord.test/shared'])

  const fallback = await resolveChannelDeliveryUrls({
    ...LEGACY,
    message: message({ tenantId: 'tenant-b' }),
    pluginName: 'notifications-discord',
    prisma: { setting: { findMany: async () => [] } },
    settingsForScope: () => memoryStore(),
    isEnabledForTenant: () => true,
    fallbackUrl: 'https://ntfy.test/env-topic'
  })
  assert.deepEqual(fallback, ['https://ntfy.test/env-topic'])
})

test('tenant-scoped targeted messages deliver only to that scope\'s matching personal entries', async () => {
  const store = memoryStore()
  await writeChannelRecipients(store, [
    recipient('https://discord.test/shared'),
    recipient('https://discord.test/mine', 'user-1'),
    recipient('https://discord.test/other', 'user-2')
  ], LEGACY)

  const urls = await resolveChannelDeliveryUrls({
    ...LEGACY,
    message: message({ tenantId: 'tenant-a', targetUserIds: ['user-1'] }),
    pluginName: 'notifications-discord',
    prisma: { setting: { findMany: async () => { throw new Error('scoped messages must not enumerate') } } },
    settingsForScope: (tenantId) => {
      assert.equal(tenantId, 'tenant-a')
      return store
    },
    isEnabledForTenant: () => true
  })
  assert.deepEqual(urls, ['https://discord.test/mine'])
})

test('tenantless targeted messages span scopes, dedupe URLs, and skip disabled scopes', async () => {
  const platform = memoryStore()
  await writeChannelRecipients(platform, [recipient('https://discord.test/mine', 'user-1')], LEGACY)
  const tenantA = memoryStore()
  await writeChannelRecipients(tenantA, [
    recipient('https://discord.test/mine', 'user-1'), // same URL as platform: deduped
    recipient('https://discord.test/tenant-a', 'user-1')
  ], LEGACY)
  const tenantB = memoryStore()
  await writeChannelRecipients(tenantB, [recipient('https://discord.test/tenant-b', 'user-1')], LEGACY)

  const stores = new Map<string | null, PluginSettingStore>([
    [null, platform],
    ['tenant-a', tenantA],
    ['tenant-b', tenantB]
  ])
  const urls = await resolveChannelDeliveryUrls({
    ...LEGACY,
    message: message({ targetUserIds: ['user-1'] }),
    pluginName: 'notifications-discord',
    prisma: {
      setting: {
        findMany: async () => [
          { key: 'plugin:notifications-discord:tenant:tenant-a:recipients' },
          { key: 'plugin:notifications-discord:tenant:tenant-b:recipients' }
        ]
      }
    },
    settingsForScope: (tenantId) => stores.get(tenantId)!,
    isEnabledForTenant: (tenantId) => tenantId !== 'tenant-b'
  })

  assert.deepEqual(urls.sort(), ['https://discord.test/mine', 'https://discord.test/tenant-a'])
})

test('targeted messages never use the broadcast fallback URL', async () => {
  const urls = await resolveChannelDeliveryUrls({
    ...LEGACY,
    message: message({ targetUserIds: ['user-1'] }),
    pluginName: 'notifications-discord',
    prisma: { setting: { findMany: async () => [] } },
    settingsForScope: () => memoryStore(),
    isEnabledForTenant: () => true,
    fallbackUrl: 'https://ntfy.test/env-topic'
  })
  assert.deepEqual(urls, [])
})
