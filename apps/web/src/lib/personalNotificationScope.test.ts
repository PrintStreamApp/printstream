import assert from 'node:assert/strict'
import test from 'node:test'
import type { AuthBootstrap } from '@printstream/shared'
import { scopeAcceptsPersonalNotifications } from './personalNotificationScope.js'

type NotificationBootstrap = Pick<AuthBootstrap, 'workspace' | 'actor' | 'memberWorkspaces'>

function bootstrap(overrides: Partial<NotificationBootstrap>): NotificationBootstrap {
  return {
    actor: { type: 'user', userId: 'user-1', email: 'user@example.test', displayName: null, isPlatformUser: false },
    workspace: null,
    memberWorkspaces: [],
    ...overrides
  }
}

test('accepts the active workspace only when the actor is a member', () => {
  const workspace = { id: 'workspace-1', slug: 'alpha', name: 'Alpha' }
  assert.equal(scopeAcceptsPersonalNotifications(bootstrap({ workspace, memberWorkspaces: [workspace] })), true)
  assert.equal(scopeAcceptsPersonalNotifications(bootstrap({ workspace, memberWorkspaces: [] })), false)
})

test('accepts platform scope only for platform users', () => {
  assert.equal(scopeAcceptsPersonalNotifications(bootstrap({
    actor: { type: 'user', userId: 'operator-1', email: 'operator@example.test', displayName: null, isPlatformUser: true }
  })), true)
  assert.equal(scopeAcceptsPersonalNotifications(bootstrap({})), false)
})
