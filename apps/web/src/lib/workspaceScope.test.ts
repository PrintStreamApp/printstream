import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveWorkspaceScopeKey } from './workspaceScope'

test('resolveWorkspaceScopeKey scopes workspace routes by workspace slug', () => {
  assert.equal(resolveWorkspaceScopeKey('/workspaces/alpha/library'), 'workspace:alpha')
})

test('resolveWorkspaceScopeKey scopes platform workspace routes separately', () => {
  assert.equal(resolveWorkspaceScopeKey('/platform/settings'), 'platform')
})

test('resolveWorkspaceScopeKey keeps non-workspace routes ambient', () => {
  assert.equal(resolveWorkspaceScopeKey('/'), 'ambient')
})