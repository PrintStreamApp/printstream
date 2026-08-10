/**
 * The saved printer-views list (`GET /api/printer-views`) as a shared React
 * Query resource. Owns the cache key shape so every consumer — the printers
 * dashboard (which also writes the cache from its create/update/delete
 * mutations) and the Default page landing setting (which offers views as
 * landing targets) — reads one cache entry per workspace scope.
 *
 * The key is scoped by the same workspace-preference scope key the dashboard
 * uses for its localStorage preferences (workspace id, or `platform` for the
 * platform workspace), so one workspace's views never bleed into another after
 * a switch.
 */
import { PRINTERS_VIEW_PERMISSION, type PrinterView } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './apiClient'
import { useAuthBootstrapQuery } from './authQuery'
import { workspacePreferenceScopeKeyFromBootstrap } from './workspacePreferenceScope'

export function printerViewsQueryKey(workspacePreferenceScopeKey: string): readonly [string, string] {
  return ['printer-views', workspacePreferenceScopeKey] as const
}

/**
 * Fetch the workspace's saved printer views. Gates itself on the auth bootstrap
 * and the printers-view permission, so callers only pass their own surface
 * condition (e.g. "the settings section is open"); without the permission the
 * query stays disabled and reports no data rather than a 403.
 */
export function usePrinterViewsQuery(enabled: boolean) {
  const authBootstrapQuery = useAuthBootstrapQuery()
  const bootstrap = authBootstrapQuery.data
  const canViewPrinters = bootstrap != null
    && (!bootstrap.authEnabled || bootstrap.permissions.includes(PRINTERS_VIEW_PERMISSION))
  const workspacePreferenceScopeKey = workspacePreferenceScopeKeyFromBootstrap(bootstrap)
  return useQuery({
    queryKey: printerViewsQueryKey(workspacePreferenceScopeKey),
    queryFn: ({ signal }) => apiFetch<{ views: PrinterView[] }>('/api/printer-views', { signal }),
    enabled: authBootstrapQuery.isSuccess && canViewPrinters && enabled
  })
}
