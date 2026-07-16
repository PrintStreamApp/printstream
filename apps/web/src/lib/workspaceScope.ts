/**
 * Workspace-scoping for the React Query cache. Every key holding server data is
 * scoped by a string derived from the current URL — `tenant:<slug>` for a
 * workspace, `platform` for the platform workspace, or `ambient` when neither
 * applies. `workspaceQueryKeys` builds the scoped keys; `usePrinterWebSocket`
 * and the invalidation helpers key off the same scope.
 *
 * Why: the app switches between workspaces in one session, so caching all
 * workspaces under one key would leak one workspace's printers/jobs into another
 * after a switch. Scoping isolates each workspace's cache and lets a WS
 * invalidation target only the scope it belongs to.
 */
import { isPlatformWorkspacePath, parseWorkspacePathname } from './workspaceRoute'

export function resolveWorkspaceScopeKey(pathname: string): string {
  const { tenantSlug } = parseWorkspacePathname(pathname)
  if (tenantSlug) return `tenant:${tenantSlug}`
  if (isPlatformWorkspacePath(pathname)) return 'platform'
  return 'ambient'
}

export function readCurrentWorkspaceScopeKey(): string {
  if (typeof window === 'undefined') return 'ambient'
  return resolveWorkspaceScopeKey(window.location.pathname)
}

export const workspaceQueryKeys = {
  deleteOperations: (scopeKey: string) => ['delete-operations', scopeKey] as const,
  jobs: (scopeKey: string) => ['jobs', scopeKey] as const,
  printDispatch: (scopeKey: string) => ['print-dispatch', scopeKey] as const,
  printerStatus: (scopeKey: string) => ['printer-status', scopeKey] as const,
  printersDiscovered: (scopeKey: string) => ['printers-discovered', scopeKey] as const,
  slicingJobs: (scopeKey: string) => ['slicing-jobs', scopeKey] as const
}