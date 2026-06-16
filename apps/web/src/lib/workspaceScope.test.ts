import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveWorkspaceScopeKey } from './workspaceScope'

test('resolveWorkspaceScopeKey scopes tenant workspace routes by tenant slug', () => {
  assert.equal(resolveWorkspaceScopeKey('/workspaces/alpha/library'), 'tenant:alpha')
})

test('resolveWorkspaceScopeKey scopes platform workspace routes separately', () => {
  assert.equal(resolveWorkspaceScopeKey('/platform/settings'), 'platform')
})

test('resolveWorkspaceScopeKey keeps non-workspace routes ambient', () => {
  assert.equal(resolveWorkspaceScopeKey('/'), 'ambient')
})