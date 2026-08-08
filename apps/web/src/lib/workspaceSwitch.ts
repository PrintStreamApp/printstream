import type { AppLandingPageSetting } from '@printstream/shared'
import { buildWorkspacePath, buildWorkspaceSelectionPath, isWorkspaceCandidatePath } from './workspaceRoute'

export interface WorkspaceSwitchDestinationInput {
  currentPath: string
  defaultPath: string
  inPlatformMode: boolean
  canUsePlatformWorkspace: boolean
  hasWorkspaceContext: boolean
  canViewPrinters: boolean
  canViewLibrary: boolean
  canViewJobs: boolean
  canOpenSettings: boolean
  canViewAccount: boolean
  enabledPluginBasePaths: readonly string[]
  pluginStateReady: boolean
}

export interface WorkspaceRouteRedirectInput {
  authBootstrapReady: boolean
  hasWorkspaceContext: boolean
  workspacelessRedirect: string
}

export interface PendingWorkspaceRouteCleanupInput {
  sourcePath: string
  currentPath: string
  targetPath: string
}

export interface DefaultWorkspaceRouteInput {
  activeWorkspaceSlug?: string | null
  defaultPath: string
}

export interface WorkspaceLandingPathInput {
  preferredPage: AppLandingPageSetting
  canViewPrinters: boolean
  canViewLibrary: boolean
  canViewJobs: boolean
  canOpenSettings: boolean
  enabledPluginBasePaths: readonly string[]
}

export interface WorkspaceLandingReadyInput {
  routeWorkspaceSlug: string | null
  activeWorkspaceSlug: string | null
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
    return (input.inPlatformMode && input.canUsePlatformWorkspace) || input.hasWorkspaceContext
      ? input.currentPath
      : input.defaultPath
  }

  return input.defaultPath
}

export function resolveWorkspaceRouteRedirect(input: WorkspaceRouteRedirectInput): string | null {
  if (!input.authBootstrapReady) {
    return null
  }

  return input.hasWorkspaceContext ? null : input.workspacelessRedirect
}

export function shouldClearPendingWorkspaceRoute(input: PendingWorkspaceRouteCleanupInput): boolean {
  const currentPathname = readPathname(input.currentPath)
  return currentPathname !== readPathname(input.sourcePath)
    && currentPathname !== readPathname(input.targetPath)
}

/**
 * Where to send someone who has no route of their own yet.
 *
 * A workspace-candidate path (`/printers`, `/get-started`, ...) only means
 * something under a workspace slug. With no active workspace there is nothing
 * to scope it to, so it resolves to the chooser rather than being emitted bare:
 * unscoped, those paths match no route and fall through the catch-all to the
 * marketing home page, which is how "Switch workspace" used to land on `/`.
 */
export function resolveDefaultWorkspaceRoute(input: DefaultWorkspaceRouteInput): string {
  if (!isWorkspaceCandidatePath(input.defaultPath)) return input.defaultPath
  if (input.activeWorkspaceSlug) return buildWorkspacePath(input.activeWorkspaceSlug, input.defaultPath)
  // `/` is a route in its own right; every other candidate is a workspace page
  // that does not exist without one.
  return input.defaultPath === '/' ? input.defaultPath : buildWorkspaceSelectionPath()
}

export function resolveWorkspaceLandingPath(input: WorkspaceLandingPathInput): string {
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

export function isWorkspaceLandingReady(input: WorkspaceLandingReadyInput): boolean {
  if (input.routeWorkspaceSlug == null) {
    // Never ready before the auth bootstrap resolves: the landing redirect
    // would fire with no workspace context, sending `/` to a bare slug-less
    // page path that the catch-all bounces straight back to `/` — an
    // infinite redirect loop racing the bootstrap response.
    return input.authBootstrapReady
      && (input.activeWorkspaceSlug == null || (input.sharedSettingsReady && input.deviceLandingPageOverrideLoaded))
  }

  return input.authBootstrapReady
    && input.activeWorkspaceSlug === input.routeWorkspaceSlug
    && input.sharedSettingsReady
    && input.deviceLandingPageOverrideLoaded
}

function readPathname(path: string): string {
  const [pathname] = path.split(/[?#]/, 1)
  return pathname && pathname.length > 0 ? pathname : '/'
}

function pathIsAvailable(path: string, input: WorkspaceLandingPathInput): boolean {
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