import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NotificationMessage } from '@printstream/shared'
import type { StoredSubscription } from './push.js'
import { deliverTargetedPush, type TargetedPushScopeDelivery } from './targeted-push.js'

function subscription(endpoint: string, actorKey?: string): StoredSubscription {
  return {
    endpoint,
    keys: { p256dh: 'p', auth: 'a' },
    createdAt: '2026-07-12T00:00:00.000Z',
    actorKey
  }
}

function message(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    id: 'message-1',
    category: 'system',
    level: 'info',
    title: 'Title',
    body: 'Body',
    timestamp: '2026-07-12T00:00:00.000Z',
    targetUserIds: ['user-1'],
    ...overrides
  }
}

/** Fake scope delivery: records which stored entries the predicate accepted. */
function fakeScope(entries: StoredSubscription[]) {
  const delivered: string[] = []
  const delivery: TargetedPushScopeDelivery = {
    async sendMatching(_payload, predicate) {
      for (const entry of entries) {
        if (predicate(entry)) delivered.push(entry.endpoint)
      }
    }
  }
  return { delivery, delivered }
}

test('tenant-scoped targeted push stays in scope and matches only target actors', async () => {
  const scoped = fakeScope([
    subscription('endpoint-target', 'user:user-1'),
    subscription('endpoint-other-user', 'user:user-2'),
    subscription('endpoint-anonymous')
  ])

  await deliverTargetedPush({
    tenantId: 'tenant-a',
    payload: message(),
    targetUserIds: ['user-1'],
    getScopedDelivery: async (tenantId) => {
      assert.equal(tenantId, 'tenant-a')
      return scoped.delivery
    },
    listSubscriptionTenantScopes: async () => {
      throw new Error('scoped messages must not enumerate other scopes')
    },
    isEnabledForTenant: () => true
  })

  assert.deepEqual(scoped.delivered, ['endpoint-target'])
})

test('tenant-scoped targeted push applies the scope deliverability filter', async () => {
  const scoped = fakeScope([
    subscription('endpoint-member', 'user:user-1'),
    subscription('endpoint-ex-member', 'user:user-1')
  ])

  await deliverTargetedPush({
    tenantId: 'tenant-a',
    payload: message(),
    targetUserIds: ['user-1'],
    getScopedDelivery: async () => scoped.delivery,
    listSubscriptionTenantScopes: async () => [],
    isEnabledForTenant: () => true,
    isDeliverableInScope: (entry) => entry.endpoint === 'endpoint-member'
  })

  assert.deepEqual(scoped.delivered, ['endpoint-member'])
})

test('platform-wide targeted push spans scopes and dedupes shared endpoints', async () => {
  // The same device endpoint registered in two workspaces plus platform.
  const platform = fakeScope([subscription('endpoint-shared', 'user:user-1')])
  const tenantA = fakeScope([
    subscription('endpoint-shared', 'user:user-1'),
    subscription('endpoint-tenant-a-only', 'user:user-1'),
    subscription('endpoint-unrelated', 'user:user-9')
  ])
  const tenantB = fakeScope([subscription('endpoint-shared', 'user:user-1')])
  const scopes = new Map<string | null, TargetedPushScopeDelivery>([
    [null, platform.delivery],
    ['tenant-a', tenantA.delivery],
    ['tenant-b', tenantB.delivery]
  ])

  await deliverTargetedPush({
    tenantId: null,
    payload: message(),
    targetUserIds: ['user-1'],
    getScopedDelivery: async (tenantId) => scopes.get(tenantId)!,
    listSubscriptionTenantScopes: async () => ['tenant-a', 'tenant-b'],
    isEnabledForTenant: () => true
  })

  assert.deepEqual(platform.delivered, ['endpoint-shared'])
  assert.deepEqual(tenantA.delivered, ['endpoint-tenant-a-only'])
  assert.deepEqual(tenantB.delivered, [])
})

test('platform-wide targeted push skips scopes where the plugin is disabled', async () => {
  const platform = fakeScope([subscription('endpoint-platform', 'user:user-1')])
  const tenantA = fakeScope([subscription('endpoint-tenant-a', 'user:user-1')])
  const scopes = new Map<string | null, TargetedPushScopeDelivery>([
    [null, platform.delivery],
    ['tenant-a', tenantA.delivery]
  ])

  await deliverTargetedPush({
    tenantId: null,
    payload: message(),
    targetUserIds: ['user-1'],
    getScopedDelivery: async (tenantId) => scopes.get(tenantId)!,
    listSubscriptionTenantScopes: async () => ['tenant-a'],
    isEnabledForTenant: (tenantId) => tenantId !== 'tenant-a'
  })

  assert.deepEqual(platform.delivered, ['endpoint-platform'])
  assert.deepEqual(tenantA.delivered, [])
})
