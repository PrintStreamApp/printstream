import assert from 'node:assert/strict'
import test from 'node:test'
import type { AuthBootstrap } from '@printstream/shared'
import { resolvePostAuthRedirectPath } from './postAuthRedirect'

function buildBootstrap(overrides: Partial<AuthBootstrap> = {}): AuthBootstrap {
  const { memberWorkspaces = [], availableWorkspaces = [], customers = [], ...rest } = overrides

  return {
    authEnabled: true,
    platformAuthEnabled: true,
    setupRequired: false,
    workspace: null,
    workspaceHasConnectedBridges: false,
    customers,
    providers: [],
    actor: { type: 'user', userId: 'user-1', isPlatformUser: false },
    permissions: [],
    capabilities: {
      canViewAuth: true,
      canManageAuthProviders: true,
      canManageSettings: false,
      canManageSupportAccess: false,
      canManageWorkspaces: false,
      canManagePlugins: false,
      canViewLogs: false
    },
    runtimePolicy: { demoMode: false, managedBridge: false, selfHosted: false },
    ...rest,
    memberWorkspaces,
    availableWorkspaces
  }
}

test('resolvePostAuthRedirectPath ignores legacy unscoped workspace redirect paths', () => {
  assert.equal(resolvePostAuthRedirectPath(buildBootstrap(), '/jobs?filter=mine'), '/workspaces')
})

test('resolvePostAuthRedirectPath keeps a scoped workspace redirect for multi-workspace users', () => {
  assert.equal(resolvePostAuthRedirectPath(buildBootstrap({
    memberWorkspaces: [
      { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
      { id: 'workspace-2', slug: 'beta', name: 'Beta' }
    ]
  }), '/workspaces/beta/jobs?filter=mine'), '/workspaces/beta/jobs?filter=mine')
})

test('resolvePostAuthRedirectPath sends multi-workspace users to the chooser before unscoped workspace pages', () => {
  assert.equal(resolvePostAuthRedirectPath(buildBootstrap({
    memberWorkspaces: [
      { id: 'workspace-1', slug: 'alpha', name: 'Alpha' },
      { id: 'workspace-2', slug: 'beta', name: 'Beta' }
    ]
  }), '/jobs?filter=mine'), '/workspaces')
})

test('resolvePostAuthRedirectPath sends platform users with multiple choices to the chooser', () => {
  assert.equal(resolvePostAuthRedirectPath(buildBootstrap({
    actor: { type: 'user', userId: 'user-1', isPlatformUser: true },
    memberWorkspaces: [
      { id: 'workspace-1', slug: 'alpha', name: 'Alpha' }
    ]
  })), '/workspaces')
})

test('resolvePostAuthRedirectPath sends users without another destination to the workspace chooser', () => {
  assert.equal(resolvePostAuthRedirectPath(buildBootstrap({ permissions: ['printers.view'] })), '/workspaces')
  assert.equal(resolvePostAuthRedirectPath(buildBootstrap({ permissions: ['library.view'] })), '/workspaces')
  assert.equal(resolvePostAuthRedirectPath(buildBootstrap({ permissions: ['jobs.view'] })), '/workspaces')
  assert.equal(resolvePostAuthRedirectPath(buildBootstrap({ permissions: ['settings.manage'] })), '/workspaces')
})

test('resolvePostAuthRedirectPath sends platform users without another destination to platform overview', () => {
  assert.equal(resolvePostAuthRedirectPath(buildBootstrap({
    actor: { type: 'user', userId: 'user-1', isPlatformUser: true }
  })), '/platform')
})

test('resolvePostAuthRedirectPath does not preserve root as an app redirect', () => {
  assert.equal(resolvePostAuthRedirectPath(buildBootstrap({
    actor: { type: 'user', userId: 'user-1', isPlatformUser: true }
  }), '/'), '/platform')
  assert.equal(resolvePostAuthRedirectPath(buildBootstrap({
    memberWorkspaces: [{ id: 'workspace-1', slug: 'alpha', name: 'Alpha' }]
  }), '/'), '/workspaces/alpha')
})

test('resolvePostAuthRedirectPath sends single-workspace users to their scoped workspace', () => {
  assert.equal(resolvePostAuthRedirectPath(buildBootstrap({
    memberWorkspaces: [{ id: 'workspace-1', slug: 'alpha', name: 'Alpha' }]
  })), '/workspaces/alpha')
  assert.equal(resolvePostAuthRedirectPath(buildBootstrap({
    memberWorkspaces: [{ id: 'workspace-1', slug: 'alpha', name: 'Alpha' }]
  }), '/jobs?filter=mine'), '/workspaces/alpha')
})

test('resolvePostAuthRedirectPath preserves platform redirects', () => {
  assert.equal(resolvePostAuthRedirectPath(buildBootstrap({
    actor: { type: 'user', userId: 'user-1', isPlatformUser: true }
  }), '/platform/settings'), '/platform/settings')
})

test('resolvePostAuthRedirectPath falls back to the workspace chooser for signed-in users without another destination', () => {
  assert.equal(resolvePostAuthRedirectPath(buildBootstrap()), '/workspaces')
})