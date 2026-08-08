import assert from 'node:assert/strict'
import test from 'node:test'
import { isWorkspaceLandingReady, resolveDefaultWorkspaceRoute, resolveWorkspaceRouteRedirect, resolveWorkspaceLandingPath, resolveWorkspaceSwitchDestination, shouldClearPendingWorkspaceRoute } from './workspaceSwitch'

const baseInput = {
  currentPath: '/printers',
  defaultPath: '/',
  inPlatformMode: false,
  canUsePlatformWorkspace: false,
  hasWorkspaceContext: true,
  canViewPrinters: true,
  canViewLibrary: true,
  canViewJobs: true,
  canOpenSettings: true,
  canViewAccount: true,
  enabledPluginBasePaths: [] as const,
  pluginStateReady: true
}

test('resolveWorkspaceSwitchDestination falls back to workspace root from workspace routes', () => {
  assert.equal(resolveWorkspaceSwitchDestination({
    ...baseInput,
    currentPath: '/jobs'
  }), '/')
})

test('resolveWorkspaceSwitchDestination keeps the root overview route in workspace mode', () => {
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
    hasWorkspaceContext: false
  }), '/platform')
})

test('resolveWorkspaceSwitchDestination falls back to workspace root when switching away from a platform-only page', () => {
  assert.equal(resolveWorkspaceSwitchDestination({
    ...baseInput,
    currentPath: '/platform/workspaces'
  }), '/')
})

test('resolveWorkspaceSwitchDestination falls back to workspace root from settings routes', () => {
  assert.equal(resolveWorkspaceSwitchDestination({
    ...baseInput,
    currentPath: '/settings/auth/roles'
  }), '/')
})

test('resolveWorkspaceSwitchDestination falls back to workspace root from plugin routes', () => {
  assert.equal(resolveWorkspaceSwitchDestination({
    ...baseInput,
    currentPath: '/orders/active',
    enabledPluginBasePaths: ['/orders']
  }), '/')
})

test('resolveWorkspaceSwitchDestination falls back to workspace root from unknown routes without waiting for plugin state', () => {
  assert.equal(resolveWorkspaceSwitchDestination({
    ...baseInput,
    currentPath: '/orders/active',
    pluginStateReady: false
  }), '/')
})

test('resolveWorkspaceRouteRedirect waits for auth bootstrap before redirecting workspace routes away', () => {
  assert.equal(resolveWorkspaceRouteRedirect({
    authBootstrapReady: false,
    hasWorkspaceContext: false,
    workspacelessRedirect: '/workspaces'
  }), null)
})

test('resolveWorkspaceRouteRedirect redirects workspace routes once bootstrap confirms there is no workspace context', () => {
  assert.equal(resolveWorkspaceRouteRedirect({
    authBootstrapReady: true,
    hasWorkspaceContext: false,
    workspacelessRedirect: '/workspaces'
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

test('resolveDefaultWorkspaceRoute scopes workspace app routes when a workspace is already active', () => {
  assert.equal(resolveDefaultWorkspaceRoute({
    activeWorkspaceSlug: 'alpha',
    defaultPath: '/'
  }), '/workspaces/alpha')

  assert.equal(resolveDefaultWorkspaceRoute({
    activeWorkspaceSlug: 'alpha',
    defaultPath: '/jobs?filter=mine'
  }), '/workspaces/alpha/jobs?filter=mine')
})

test('resolveDefaultWorkspaceRoute preserves non-workspace fallbacks', () => {
  assert.equal(resolveDefaultWorkspaceRoute({
    activeWorkspaceSlug: 'alpha',
    defaultPath: '/workspaces'
  }), '/workspaces')

  assert.equal(resolveDefaultWorkspaceRoute({
    activeWorkspaceSlug: 'alpha',
    defaultPath: '/platform'
  }), '/platform')

  assert.equal(resolveDefaultWorkspaceRoute({
    activeWorkspaceSlug: null,
    defaultPath: '/'
  }), '/')
})

test('resolveDefaultWorkspaceRoute sends unscoped workspace pages to the chooser', () => {
  // Regression: with no active workspace these used to resolve bare, match no
  // route, and fall through the catch-all to the marketing home page -- which
  // is what "Switch workspace" did before the chooser became the landing point.
  for (const path of ['/get-started', '/printers', '/library', '/jobs']) {
    assert.equal(
      resolveDefaultWorkspaceRoute({ activeWorkspaceSlug: null, defaultPath: path }),
      '/workspaces',
      `${path} must not be emitted without a workspace slug`
    )
  }
})

test('resolveWorkspaceLandingPath returns the selected workspace page when it is allowed', () => {
  assert.equal(resolveWorkspaceLandingPath({
    preferredPage: '/jobs',
    canViewPrinters: true,
    canViewLibrary: true,
    canViewJobs: true,
    canOpenSettings: true,
    enabledPluginBasePaths: []
  }), '/jobs')

  assert.equal(resolveWorkspaceLandingPath({
    preferredPage: '/settings',
    canViewPrinters: true,
    canViewLibrary: true,
    canViewJobs: true,
    canOpenSettings: true,
    enabledPluginBasePaths: []
  }), '/settings')
})

test('resolveWorkspaceLandingPath allows enabled plugin pages', () => {
  assert.equal(resolveWorkspaceLandingPath({
    preferredPage: '/orders',
    canViewPrinters: true,
    canViewLibrary: true,
    canViewJobs: true,
    canOpenSettings: true,
    enabledPluginBasePaths: ['/orders']
  }), '/orders')
})

test('resolveWorkspaceLandingPath falls back to the first available workspace page', () => {
  assert.equal(resolveWorkspaceLandingPath({
    preferredPage: '/library',
    canViewPrinters: false,
    canViewLibrary: false,
    canViewJobs: true,
    canOpenSettings: true,
    enabledPluginBasePaths: []
  }), '/jobs')

  assert.equal(resolveWorkspaceLandingPath({
    preferredPage: '/orders',
    canViewPrinters: true,
    canViewLibrary: false,
    canViewJobs: false,
    canOpenSettings: false,
    enabledPluginBasePaths: []
  }), '/printers')

  assert.equal(resolveWorkspaceLandingPath({
    preferredPage: '/settings',
    canViewPrinters: false,
    canViewLibrary: false,
    canViewJobs: false,
    canOpenSettings: false,
    enabledPluginBasePaths: []
  }), '/printers')
})

test('resolveWorkspaceLandingPath uses printers as the final fallback when landing state is ambiguous', () => {
  assert.equal(resolveWorkspaceLandingPath({
    preferredPage: '/orders',
    canViewPrinters: false,
    canViewLibrary: false,
    canViewJobs: false,
    canOpenSettings: false,
    enabledPluginBasePaths: []
  }), '/printers')
})

test('isWorkspaceLandingReady waits for workspace-scoped auth state before resolving a workspace landing route', () => {
  assert.equal(isWorkspaceLandingReady({
    routeWorkspaceSlug: 'alpha',
    activeWorkspaceSlug: null,
    authBootstrapReady: false,
    sharedSettingsReady: true,
    deviceLandingPageOverrideLoaded: true
  }), false)

  assert.equal(isWorkspaceLandingReady({
    routeWorkspaceSlug: 'alpha',
    activeWorkspaceSlug: 'beta',
    authBootstrapReady: true,
    sharedSettingsReady: true,
    deviceLandingPageOverrideLoaded: true
  }), false)

  assert.equal(isWorkspaceLandingReady({
    routeWorkspaceSlug: 'alpha',
    activeWorkspaceSlug: 'alpha',
    authBootstrapReady: true,
    sharedSettingsReady: true,
    deviceLandingPageOverrideLoaded: true
  }), true)
})

test('isWorkspaceLandingReady allows non-workspace routes to proceed once settings state is available', () => {
  // Pre-bootstrap the landing redirect must hold: navigating without
  // workspace context loops `/` -> bare page path -> catch-all -> `/`.
  assert.equal(isWorkspaceLandingReady({
    routeWorkspaceSlug: null,
    activeWorkspaceSlug: null,
    authBootstrapReady: false,
    sharedSettingsReady: false,
    deviceLandingPageOverrideLoaded: false
  }), false)

  assert.equal(isWorkspaceLandingReady({
    routeWorkspaceSlug: null,
    activeWorkspaceSlug: null,
    authBootstrapReady: true,
    sharedSettingsReady: false,
    deviceLandingPageOverrideLoaded: false
  }), true)

  assert.equal(isWorkspaceLandingReady({
    routeWorkspaceSlug: null,
    activeWorkspaceSlug: 'alpha',
    authBootstrapReady: true,
    sharedSettingsReady: false,
    deviceLandingPageOverrideLoaded: true
  }), false)

  assert.equal(isWorkspaceLandingReady({
    routeWorkspaceSlug: null,
    activeWorkspaceSlug: 'alpha',
    authBootstrapReady: true,
    sharedSettingsReady: true,
    deviceLandingPageOverrideLoaded: true
  }), true)
})
