import type { AppLandingPageSetting } from '@printstream/shared'
import { buildTenantWorkspacePath, isTenantWorkspaceCandidatePath } from './workspaceRoute'

export interface WorkspaceSwitchDestinationInput {
  currentPath: string
  defaultPath: string
  inPlatformMode: boolean
  canUsePlatformWorkspace: boolean
  hasTenantContext: boolean
  canViewPrinters: boolean
  canViewLibrary: boolean
  canViewJobs: boolean
  canOpenSettings: boolean
  canViewAccount: boolean
  enabledPluginBasePaths: readonly string[]
  pluginStateReady: boolean
}

export interface TenantRouteRedirectInput {
  authBootstrapReady: boolean
  hasTenantContext: boolean
  tenantlessRedirect: string
}

export interface PendingWorkspaceRouteCleanupInput {
  sourcePath: string
  currentPath: string
  targetPath: string
}

export interface DefaultWorkspaceRouteInput {
  activeTenantSlug?: string | null
  defaultPath: string
}

export interface TenantWorkspaceLandingPathInput {
  preferredPage: AppLandingPageSetting
  canViewPrinters: boolean
  canViewLibrary: boolean
  canViewJobs: boolean
  canOpenSettings: boolean
  enabledPluginBasePaths: readonly string[]
}

export interface TenantWorkspaceLandingReadyInput {
  routeTenantSlug: string | null
  activeTenantSlug: string | null
  authBootstrapReady: boolean
  sharedSettingsReady: boolean
  deviceLandingPageOverrideLoaded: boolean
}

export function pluginBasePath(path: string): string {
  return path.endsWith('/*') ? path.slice(0, -2) : path
}

export function resolveWorkspaceSwitchDestination(input: WorkspaceSwitchDestinationInput): string | null {
  const pathname = readPathname(input.currentPath)

  if (pathname === '/' || pathname === '/platform') {
    return (input.inPlatformMode && input.canUsePlatformWorkspace) || input.hasTenantContext
      ? input.currentPath
      : input.defaultPath
  }

  return input.defaultPath
}

export function resolveTenantRouteRedirect(input: TenantRouteRedirectInput): string | null {
  if (!input.authBootstrapReady) {
    return null
  }

  return input.hasTenantContext ? null : input.tenantlessRedirect
}

export function shouldClearPendingWorkspaceRoute(input: PendingWorkspaceRouteCleanupInput): boolean {
  const currentPathname = readPathname(input.currentPath)
  return currentPathname !== readPathname(input.sourcePath)
    && currentPathname !== readPathname(input.targetPath)
}

export function resolveDefaultWorkspaceRoute(input: DefaultWorkspaceRouteInput): string {
  return input.activeTenantSlug && isTenantWorkspaceCandidatePath(input.defaultPath)
    ? buildTenantWorkspacePath(input.activeTenantSlug, input.defaultPath)
    : input.defaultPath
}

export function resolveTenantWorkspaceLandingPath(input: TenantWorkspaceLandingPathInput): string {
  if (pathIsAvailable(input.preferredPage, input)) {
    return input.preferredPage
  }

  for (const fallbackPath of ['/printers', '/library', '/jobs', '/settings'] as const) {
    if (pathIsAvailable(fallbackPath, input)) {
      return fallbackPath
    }
  }

  return '/printers'
}

export function isTenantWorkspaceLandingReady(input: TenantWorkspaceLandingReadyInput): boolean {
  if (input.routeTenantSlug == null) {
    // Never ready before the auth bootstrap resolves: the landing redirect
    // would fire with no workspace context, sending `/` to a bare slug-less
    // page path that the catch-all bounces straight back to `/` — an
    // infinite redirect loop racing the bootstrap response.
    return input.authBootstrapReady
      && (input.activeTenantSlug == null || (input.sharedSettingsReady && input.deviceLandingPageOverrideLoaded))
  }

  return input.authBootstrapReady
    && input.activeTenantSlug === input.routeTenantSlug
    && input.sharedSettingsReady
    && input.deviceLandingPageOverrideLoaded
}

function readPathname(path: string): string {
  const [pathname] = path.split(/[?#]/, 1)
  return pathname && pathname.length > 0 ? pathname : '/'
}

function pathIsAvailable(path: string, input: TenantWorkspaceLandingPathInput): boolean {
  switch (path) {
    case '/printers':
      return input.canViewPrinters
    case '/library':
      return input.canViewLibrary
    case '/jobs':
      return input.canViewJobs
    case '/settings':
      return input.canOpenSettings
    case '/stats':
      return true
    default:
      return input.enabledPluginBasePaths.includes(path)
  }
}