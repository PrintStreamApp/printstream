import assert from 'node:assert/strict'
import test from 'node:test'
import { isTenantWorkspaceLandingReady, resolveDefaultWorkspaceRoute, resolveTenantRouteRedirect, resolveTenantWorkspaceLandingPath, resolveWorkspaceSwitchDestination, shouldClearPendingWorkspaceRoute } from './workspaceSwitch'

const baseInput = {
  currentPath: '/printers',
  defaultPath: '/',
  inPlatformMode: false,
  canUsePlatformWorkspace: false,
  hasTenantContext: true,
  canViewPrinters: true,
  canViewLibrary: true,
  canViewJobs: true,
  canOpenSettings: true,
  canViewAccount: true,
  enabledPluginBasePaths: [] as const,
  pluginStateReady: true
}

test('resolveWorkspaceSwitchDestination falls back to tenant root from tenant routes', () => {
  assert.equal(resolveWorkspaceSwitchDestination({
    ...baseInput,
    currentPath: '/jobs'
  }), '/')
})

test('resolveWorkspaceSwitchDestination keeps the root overview route in tenant mode', () => {
  assert.equal(resolveWorkspaceSwitchDestination({
    ...baseInput,
    currentPath: '/',
    defaultPath: '/'
  }), '/')
})

test('resolveWorkspaceSwitchDestination keeps the explicit platform overview route in platform mode', () => {
  assert.equal(resolveWorkspaceSwitchDestination({
    ...baseInput,
    currentPath: '/platform',
    defaultPath: '/platform',
    inPlatformMode: true,
    canUsePlatformWorkspace: true,
    hasTenantContext: false
  }), '/platform')
})

test('resolveWorkspaceSwitchDestination falls back to tenant root when switching away from a platform-only page', () => {
  assert.equal(resolveWorkspaceSwitchDestination({
    ...baseInput,
    currentPath: '/platform/tenants'
  }), '/')
})

test('resolveWorkspaceSwitchDestination falls back to tenant root from settings routes', () => {
  assert.equal(resolveWorkspaceSwitchDestination({
    ...baseInput,
    currentPath: '/settings/auth/roles'
  }), '/')
})

test('resolveWorkspaceSwitchDestination falls back to tenant root from plugin routes', () => {
  assert.equal(resolveWorkspaceSwitchDestination({
    ...baseInput,
    currentPath: '/orders/active',
    enabledPluginBasePaths: ['/orders']
  }), '/')
})

test('resolveWorkspaceSwitchDestination falls back to tenant root from unknown routes without waiting for plugin state', () => {
  assert.equal(resolveWorkspaceSwitchDestination({
    ...baseInput,
    currentPath: '/orders/active',
    pluginStateReady: false
  }), '/')
})

test('resolveTenantRouteRedirect waits for auth bootstrap before redirecting tenant routes away', () => {
  assert.equal(resolveTenantRouteRedirect({
    authBootstrapReady: false,
    hasTenantContext: false,
    tenantlessRedirect: '/workspaces'
  }), null)
})

test('resolveTenantRouteRedirect redirects tenant routes once bootstrap confirms there is no tenant context', () => {
  assert.equal(resolveTenantRouteRedirect({
    authBootstrapReady: true,
    hasTenantContext: false,
    tenantlessRedirect: '/workspaces'
  }), '/workspaces')
})

test('shouldClearPendingWorkspaceRoute waits for an actual route change', () => {
  assert.equal(shouldClearPendingWorkspaceRoute({
    sourcePath: '/workspaces',
    currentPath: '/workspaces',
    targetPath: '/platform'
  }), false)

  assert.equal(shouldClearPendingWorkspaceRoute({
    sourcePath: '/workspaces',
    currentPath: '/platform',
    targetPath: '/platform'
  }), false)

  assert.equal(shouldClearPendingWorkspaceRoute({
    sourcePath: '/workspaces',
    currentPath: '/jobs',
    targetPath: '/platform'
  }), true)
})

test('resolveDefaultWorkspaceRoute scopes tenant app routes when a tenant is already active', () => {
  assert.equal(resolveDefaultWorkspaceRoute({
    activeTenantSlug: 'alpha',
    defaultPath: '/'
  }), '/workspaces/alpha')

  assert.equal(resolveDefaultWorkspaceRoute({
    activeTenantSlug: 'alpha',
    defaultPath: '/jobs?filter=mine'
  }), '/workspaces/alpha/jobs?filter=mine')
})

test('resolveDefaultWorkspaceRoute preserves non-tenant workspace fallbacks', () => {
  assert.equal(resolveDefaultWorkspaceRoute({
    activeTenantSlug: 'alpha',
    defaultPath: '/workspaces'
  }), '/workspaces')

  assert.equal(resolveDefaultWorkspaceRoute({
    activeTenantSlug: 'alpha',
    defaultPath: '/platform'
  }), '/platform')

  assert.equal(resolveDefaultWorkspaceRoute({
    activeTenantSlug: null,
    defaultPath: '/'
  }), '/')
})

test('resolveTenantWorkspaceLandingPath returns the selected tenant page when it is allowed', () => {
  assert.equal(resolveTenantWorkspaceLandingPath({
    preferredPage: '/jobs',
    canViewPrinters: true,
    canViewLibrary: true,
    canViewJobs: true,
    canOpenSettings: true,
    enabledPluginBasePaths: []
  }), '/jobs')

  assert.equal(resolveTenantWorkspaceLandingPath({
    preferredPage: '/settings',
    canViewPrinters: true,
    canViewLibrary: true,
    canViewJobs: true,
    canOpenSettings: true,
    enabledPluginBasePaths: []
  }), '/settings')
})

test('resolveTenantWorkspaceLandingPath allows enabled plugin pages', () => {
  assert.equal(resolveTenantWorkspaceLandingPath({
    preferredPage: '/orders',
    canViewPrinters: true,
    canViewLibrary: true,
    canViewJobs: true,
    canOpenSettings: true,
    enabledPluginBasePaths: ['/orders']
  }), '/orders')
})

test('resolveTenantWorkspaceLandingPath falls back to the first available tenant page', () => {
  assert.equal(resolveTenantWorkspaceLandingPath({
    preferredPage: '/library',
    canViewPrinters: false,
    canViewLibrary: false,
    canViewJobs: true,
    canOpenSettings: true,
    enabledPluginBasePaths: []
  }), '/jobs')

  assert.equal(resolveTenantWorkspaceLandingPath({
    preferredPage: '/orders',
    canViewPrinters: true,
    canViewLibrary: false,
    canViewJobs: false,
    canOpenSettings: false,
    enabledPluginBasePaths: []
  }), '/printers')

  assert.equal(resolveTenantWorkspaceLandingPath({
    preferredPage: '/settings',
    canViewPrinters: false,
    canViewLibrary: false,
    canViewJobs: false,
    canOpenSettings: false,
    enabledPluginBasePaths: []
  }), '/printers')
})

test('resolveTenantWorkspaceLandingPath uses printers as the final fallback when landing state is ambiguous', () => {
  assert.equal(resolveTenantWorkspaceLandingPath({
    preferredPage: '/orders',
    canViewPrinters: false,
    canViewLibrary: false,
    canViewJobs: false,
    canOpenSettings: false,
    enabledPluginBasePaths: []
  }), '/printers')
})

test('isTenantWorkspaceLandingReady waits for tenant-scoped auth state before resolving a tenant landing route', () => {
  assert.equal(isTenantWorkspaceLandingReady({
    routeTenantSlug: 'alpha',
    activeTenantSlug: null,
    authBootstrapReady: false,
    sharedSettingsReady: true,
    deviceLandingPageOverrideLoaded: true
  }), false)

  assert.equal(isTenantWorkspaceLandingReady({
    routeTenantSlug: 'alpha',
    activeTenantSlug: 'beta',
    authBootstrapReady: true,
    sharedSettingsReady: true,
    deviceLandingPageOverrideLoaded: true
  }), false)

  assert.equal(isTenantWorkspaceLandingReady({
    routeTenantSlug: 'alpha',
    activeTenantSlug: 'alpha',
    authBootstrapReady: true,
    sharedSettingsReady: true,
    deviceLandingPageOverrideLoaded: true
  }), true)
})

test('isTenantWorkspaceLandingReady allows non-tenant routes to proceed once settings state is available', () => {
  assert.equal(isTenantWorkspaceLandingReady({
    routeTenantSlug: null,
    activeTenantSlug: null,
    authBootstrapReady: false,
    sharedSettingsReady: false,
    deviceLandingPageOverrideLoaded: false
  }), true)

  assert.equal(isTenantWorkspaceLandingReady({
    routeTenantSlug: null,
    activeTenantSlug: 'alpha',
    authBootstrapReady: true,
    sharedSettingsReady: false,
    deviceLandingPageOverrideLoaded: true
  }), false)

  assert.equal(isTenantWorkspaceLandingReady({
    routeTenantSlug: null,
    activeTenantSlug: 'alpha',
    authBootstrapReady: true,
    sharedSettingsReady: true,
    deviceLandingPageOverrideLoaded: true
  }), true)
})
