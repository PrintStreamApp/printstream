import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { blockedPluginsForTenant, planGatedPluginNames, registerPluginPlanGate } from './plugin-plan-gate.js'

afterEach(() => {
  registerPluginPlanGate(null)
})

test('with no gate registered (OSS/self-hosted), nothing is gated', async () => {
  assert.equal(planGatedPluginNames().size, 0)
  assert.equal((await blockedPluginsForTenant('tenant-1')).size, 0)
})

test('a registered gate blocks its plugins per tenant', async () => {
  const gated = new Set(['orders', 'print-queue'])
  registerPluginPlanGate({
    gatedPlugins: gated,
    blockedPluginsForTenant: async (tenantId) => (tenantId === 'free-tenant' ? gated : new Set())
  })
  assert.deepEqual([...planGatedPluginNames()].sort(), ['orders', 'print-queue'])
  assert.equal((await blockedPluginsForTenant('free-tenant')).has('orders'), true)
  assert.equal((await blockedPluginsForTenant('pro-tenant')).size, 0)
})

test('a failing gate fails open so plugins are never lost to transient errors', async () => {
  registerPluginPlanGate({
    gatedPlugins: new Set(['orders']),
    blockedPluginsForTenant: async () => {
      throw new Error('db down')
    }
  })
  assert.equal((await blockedPluginsForTenant('tenant-1')).size, 0)
})
