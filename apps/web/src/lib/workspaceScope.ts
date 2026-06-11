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