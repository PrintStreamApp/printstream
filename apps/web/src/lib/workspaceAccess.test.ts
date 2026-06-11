import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countAccessibleWorkspaceChoices, countSwitchableWorkspaceChoices, listAccessibleTenantWorkspaces } from './workspaceAccess'

test('listAccessibleTenantWorkspaces removes duplicate workspace entries and sorts them by name', () => {
  assert.deepEqual(
    listAccessibleTenantWorkspaces([
      { id: 'tenant-2', slug: 'beta', name: 'Beta' },
      { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
      { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    ]),
    [
      { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
      { id: 'tenant-2', slug: 'beta', name: 'Beta' }
    ]
  )
})

test('countAccessibleWorkspaceChoices includes platform access as a separate choice', () => {
  assert.equal(countAccessibleWorkspaceChoices({
    tenants: [
      { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
      { id: 'tenant-2', slug: 'beta', name: 'Beta' },
      { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    ],
    includePlatform: true
  }), 3)
})

test('countSwitchableWorkspaceChoices includes returning to platform from a support-access workspace', () => {
  assert.equal(countSwitchableWorkspaceChoices({
    tenants: [],
    includePlatform: true,
    activeTenantId: 'tenant-support-only'
  }), 1)
})

test('countSwitchableWorkspaceChoices excludes the current tenant from personal workspace options', () => {
  assert.equal(countSwitchableWorkspaceChoices({
    tenants: [
      { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
      { id: 'tenant-2', slug: 'beta', name: 'Beta' }
    ],
    includePlatform: true,
    activeTenantId: 'tenant-1'
  }), 2)
})