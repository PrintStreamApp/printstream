import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { blockedPluginsForWorkspace, planGatedPluginNames, registerPluginPlanGate } from './plugin-plan-gate.js'

afterEach(() => {
  registerPluginPlanGate(null)
})

test('with no gate registered (OSS/self-hosted), nothing is gated', async () => {
  assert.equal(planGatedPluginNames().size, 0)
  assert.equal((await blockedPluginsForWorkspace('workspace-1')).size, 0)
})

test('a registered gate blocks its plugins per workspace', async () => {
  const gated = new Set(['orders', 'print-queue'])
  registerPluginPlanGate({
    gatedPlugins: gated,
    blockedPluginsForWorkspace: async (workspaceId) => (workspaceId === 'free-workspace' ? gated : new Set())
  })
  assert.deepEqual([...planGatedPluginNames()].sort(), ['orders', 'print-queue'])
  assert.equal((await blockedPluginsForWorkspace('free-workspace')).has('orders'), true)
  assert.equal((await blockedPluginsForWorkspace('pro-workspace')).size, 0)
})

test('a failing gate fails open so plugins are never lost to transient errors', async () => {
  registerPluginPlanGate({
    gatedPlugins: new Set(['orders']),
    blockedPluginsForWorkspace: async () => {
      throw new Error('db down')
    }
  })
  assert.equal((await blockedPluginsForWorkspace('workspace-1')).size, 0)
})
