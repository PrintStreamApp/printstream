import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAuthRouteState, resolveProtectedRouteState, resolvePublicRootRouteState, shouldShowAccountTab, shouldShowWorkspaceSwitcher, shouldUsePlatformAuthTheme } from './authRoute'

test('shouldShowAccountTab keeps the account tab for signed-in users even when the current workspace auth is disabled', () => {
  assert.equal(shouldShowAccountTab({
    authBootstrapReady: true,
    actorType: 'user',
    activeTenantId: null,
    memberTenantIds: new Set()
  }), true)
})

test('shouldShowAccountTab keeps the account tab for users with a direct membership in the current workspace', () => {
  assert.equal(shouldShowAccountTab({
    authBootstrapReady: true,
    actorType: 'user',
    activeTenantId: 'tenant-1',
    memberTenantIds: new Set(['tenant-1'])
  }), true)
})

test('shouldShowAccountTab hides the account tab for platform users visiting a workspace they do not belong to', () => {
  assert.equal(shouldShowAccountTab({
    authBootstrapReady: true,
    actorType: 'user',
    activeTenantId: 'tenant-2',
    memberTenantIds: new Set(['tenant-1'])
  }), false)
})

test('shouldShowAccountTab hides the account tab for non-user actors', () => {
  assert.equal(shouldShowAccountTab({
    authBootstrapReady: true,
    actorType: 'anonymous',
    activeTenantId: null,
    memberTenantIds: new Set()
  }), false)
})

test('shouldShowAccountTab hides the account tab while bootstrap is still loading', () => {
  assert.equal(shouldShowAccountTab({
    authBootstrapReady: false,
    actorType: 'user',
    activeTenantId: null,
    memberTenantIds: new Set()
  }), false)
})

test('resolveAuthRouteState keeps the auth route mounted while bootstrap is loading', () => {
  assert.equal(resolveAuthRouteState({
    authBootstrapReady: false,
    authEnabled: false,
    authSetupRequired: false,
    isAuthenticated: false
  }), 'loading')
})

test('resolveAuthRouteState renders auth when local auth is enabled for an anonymous actor', () => {
  assert.equal(resolveAuthRouteState({
    authBootstrapReady: true,
    authEnabled: true,
    authSetupRequired: false,
    isAuthenticated: false
  }), 'auth')
})

test('resolveAuthRouteState renders auth while provider setup is still required', () => {
  assert.equal(resolveAuthRouteState({
    authBootstrapReady: true,
    authEnabled: false,
    authSetupRequired: true,
    isAuthenticated: false
  }), 'auth')
  assert.equal(resolveAuthRouteState({
    authBootstrapReady: true,
    authEnabled: false,
    authSetupRequired: true,
    isAuthenticated: true
  }), 'auth')
})

test('resolveAuthRouteState renders auth when platform providers exist but none are enabled yet', () => {
  assert.equal(resolveAuthRouteState({
    authBootstrapReady: true,
    authEnabled: false,
    authSetupRequired: false,
    authProviderSetupAvailable: true,
    isAuthenticated: false
  }), 'auth')
})

test('resolveAuthRouteState skips inline setup for tenant-scoped auth', () => {
  assert.equal(resolveAuthRouteState({
    authBootstrapReady: true,
    authEnabled: false,
    authSetupRequired: true,
    allowSetup: false,
    isAuthenticated: false
  }), 'redirect')
})

test('resolveProtectedRouteState keeps tenant routes mounted during tenant-scoped auth setup', () => {
  assert.equal(resolveProtectedRouteState({
    authBootstrapReady: true,
    authEnabled: false,
    authSetupRequired: true,
    allowSetup: false,
    isAuthenticated: false
  }), 'render')
})

test('resolveProtectedRouteState still shows auth when enabled auth blocks an anonymous actor', () => {
  assert.equal(resolveProtectedRouteState({
    authBootstrapReady: true,
    authEnabled: true,
    authSetupRequired: false,
    allowSetup: false,
    isAuthenticated: false
  }), 'auth')
})

test('resolveAuthRouteState redirects once auth is disabled or the actor is already signed in', () => {
  assert.equal(resolveAuthRouteState({
    authBootstrapReady: true,
    authEnabled: false,
    authSetupRequired: false,
    isAuthenticated: false
  }), 'redirect')
  assert.equal(resolveAuthRouteState({
    authBootstrapReady: true,
    authEnabled: true,
    authSetupRequired: false,
    isAuthenticated: true
  }), 'redirect')
})

test('resolvePublicRootRouteState keeps the marketing page for anonymous launches', () => {
  assert.equal(resolvePublicRootRouteState({
    isAuthenticated: false,
    defaultRouteReady: false
  }), 'marketing')
})

test('resolvePublicRootRouteState keeps the marketing page available for signed-in visits to root', () => {
  assert.equal(resolvePublicRootRouteState({
    isAuthenticated: true,
    defaultRouteReady: false
  }), 'marketing')

  assert.equal(resolvePublicRootRouteState({
    isAuthenticated: true,
    defaultRouteReady: true
  }), 'marketing')
})

test('shouldUsePlatformAuthTheme keeps platform auth screens on the platform theme before the first platform Admin exists', () => {
  assert.equal(shouldUsePlatformAuthTheme({
    hasTenantContext: false,
    canUsePlatformWorkspace: false,
    authRouteState: 'auth'
  }), true)
})

test('shouldUsePlatformAuthTheme keeps tenant auth screens on the tenant theme', () => {
  assert.equal(shouldUsePlatformAuthTheme({
    hasTenantContext: true,
    canUsePlatformWorkspace: false,
    authRouteState: 'auth'
  }), false)
})

test('shouldUsePlatformAuthTheme keeps the platform workspace on the platform theme once accessible', () => {
  assert.equal(shouldUsePlatformAuthTheme({
    hasTenantContext: false,
    canUsePlatformWorkspace: true,
    authRouteState: 'redirect'
  }), true)
})

test('shouldShowWorkspaceSwitcher hides the workspace switcher while auth screens are mounted', () => {
  assert.equal(shouldShowWorkspaceSwitcher({ authRouteState: 'auth' }), false)
  assert.equal(shouldShowWorkspaceSwitcher({ authRouteState: 'loading' }), false)
})

test('shouldShowWorkspaceSwitcher stays visible when the current route is not tenant-scoped', () => {
  assert.equal(shouldShowWorkspaceSwitcher({ authRouteState: 'redirect' }), true)
})

test('shouldShowWorkspaceSwitcher stays visible on valid tenant-scoped routes', () => {
  assert.equal(shouldShowWorkspaceSwitcher({
    authRouteState: 'redirect',
    requestedTenantSlug: 'alpha',
    activeTenantSlug: 'alpha'
  }), true)
})

test('shouldShowWorkspaceSwitcher stays visible when the tenant slug is invalid or unauthorized', () => {
  assert.equal(shouldShowWorkspaceSwitcher({
    authRouteState: 'redirect',
    requestedTenantSlug: 'alpha',
    activeTenantSlug: null
  }), true)
})