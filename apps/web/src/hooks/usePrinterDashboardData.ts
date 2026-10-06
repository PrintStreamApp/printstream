/**
 * Loads the printer dashboard's workspace data and derives its access gates.
 *
 * Queries remain mounted while the route switches between overview and detail. The bridge
 * placeholder suppresses printer-dependent requests until a workspace bridge connects, and
 * printer status is seeded by HTTP before the live WebSocket cache takes over.
 */
import { useCallback, useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  LIBRARY_UPLOAD_PERMISSION,
  CAMERA_VIEW_PERMISSION,
  JOBS_DELETE_PERMISSION,
  JOBS_VIEW_PERMISSION,
  PRINTERS_CONTROL_PERMISSION,
  PRINTERS_MANAGE_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  PRINTER_STORAGE_DOWNLOAD_PERMISSION,
  PRINTER_STORAGE_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION,
  type BridgeListResponse,
  type DiscoveredPrinter,
  type Permission,
  type PrintJob,
  type Printer,
  type PrinterStatus,
  type SlicingCapabilities
} from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { prefetchSlicingPresets } from '../lib/slicingPresetsQuery'
import { useAuthBootstrapQuery } from '../lib/authQuery'
import { workspacePreferenceScopeKeyFromBootstrap } from '../lib/workspacePreferenceScope'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../lib/workspaceScope'
import {
  mapActiveDispatchJobsByPrinter,
  mapLatestActivePrintJobsByPrinter,
  mapLatestFinishedPrintJobsByPrinter
} from '../lib/trackedPrintJobs'
import { EMPTY_PRINTERS, EMPTY_PRINT_JOBS, EMPTY_PRINTER_VIEWS } from '../lib/printerViewConstants'
import { usePrinterViewsQuery } from '../lib/printerViewsQuery'
import { usePrintDispatchJobs } from './usePrintDispatchJobs'

/** Return the mounted queries, permission decisions, and data used by both printer routes. */
export function usePrinterDashboardData(singlePrinterView: boolean) {
  const queryClient = useQueryClient()
  const authBootstrapQuery = useAuthBootstrapQuery()
  const workspacePreferenceScopeKey = workspacePreferenceScopeKeyFromBootstrap(authBootstrapQuery.data)
  const workspaceScopeKey = readCurrentWorkspaceScopeKey()
  const grantedPermissions = useMemo(
    () => new Set(authBootstrapQuery.data?.permissions ?? []),
    [authBootstrapQuery.data?.permissions]
  )
  const authEnabled = authBootstrapQuery.data?.authEnabled ?? false
  const canOpenBridgesSettings = authBootstrapQuery.data?.capabilities.canManageSettings ?? false
  const hasPermission = useCallback(
    (permission: Permission) => !authEnabled || grantedPermissions.has(permission),
    [authEnabled, grantedPermissions]
  )
  const canDeleteJobs = hasPermission(JOBS_DELETE_PERMISSION)
  const canUploadLibrary = hasPermission(LIBRARY_UPLOAD_PERMISSION)
  const canViewPrinters = hasPermission(PRINTERS_VIEW_PERMISSION)
  const canManagePrinters = hasPermission(PRINTERS_MANAGE_PERMISSION)
  const canControlPrinters = hasPermission(PRINTERS_CONTROL_PERMISSION)
  const canViewPrinterStorage = hasPermission(PRINTER_STORAGE_VIEW_PERMISSION)
  const canDownloadPrinterStorage = hasPermission(PRINTER_STORAGE_DOWNLOAD_PERMISSION)
  const canDispatchPrints = hasPermission(PRINTS_DISPATCH_PERMISSION)
  const canViewJobs = hasPermission(JOBS_VIEW_PERMISSION)
  const canViewCamera = hasPermission(CAMERA_VIEW_PERMISSION)
  const showNoConnectedBridgesPlaceholder = authBootstrapQuery.isSuccess
    && !singlePrinterView
    && authBootstrapQuery.data?.workspace != null
    && !authBootstrapQuery.data.workspaceHasConnectedBridges

  const printersQuery = useQuery({
    queryKey: ['printers'],
    queryFn: ({ signal }) => apiFetch<{ printers: Printer[] }>('/api/printers', { signal }),
    enabled: authBootstrapQuery.isSuccess ? (canViewPrinters && !showNoConnectedBridgesPlaceholder) : false
  })
  const printerViewsQuery = usePrinterViewsQuery(!showNoConnectedBridgesPlaceholder)
  const bridgesQuery = useQuery({
    queryKey: ['bridges'],
    queryFn: ({ signal }) => apiFetch<BridgeListResponse>('/api/bridges', { signal }),
    enabled: authBootstrapQuery.isSuccess ? (canManagePrinters && !showNoConnectedBridgesPlaceholder) : false
  })
  // WebSocket fan-out keeps discovered printers fresh; HTTP covers a late initial replay.
  const discoveredQuery = useQuery({
    queryKey: workspaceQueryKeys.printersDiscovered(workspaceScopeKey),
    queryFn: ({ signal }) => apiFetch<{ printers: DiscoveredPrinter[] }>('/api/printers/discovered', { signal }),
    enabled: authBootstrapQuery.isSuccess ? (canManagePrinters && !showNoConnectedBridgesPlaceholder) : false,
    staleTime: 10_000
  })
  const slicingCapabilitiesQuery = useQuery({
    queryKey: ['slicing-capabilities'],
    queryFn: ({ signal }) => apiFetch<SlicingCapabilities>('/api/slicing/capabilities', { signal }),
    enabled: authBootstrapQuery.isSuccess ? (canDispatchPrints && canUploadLibrary && !showNoConnectedBridgesPlaceholder) : false
  })
  const slicingCapabilitiesData = slicingCapabilitiesQuery.data
  useEffect(() => {
    prefetchSlicingPresets(queryClient, slicingCapabilitiesData)
  }, [queryClient, slicingCapabilitiesData])
  const jobsQuery = useQuery({
    queryKey: ['jobs'],
    queryFn: ({ signal }) => apiFetch<{ jobs: PrintJob[] }>('/api/jobs', { signal }),
    enabled: authBootstrapQuery.isSuccess ? (canViewJobs && !showNoConnectedBridgesPlaceholder) : false
  })
  const dispatchQuery = usePrintDispatchJobs({
    enabled: authBootstrapQuery.isSuccess ? (canViewJobs && !showNoConnectedBridgesPlaceholder) : false,
    suppressGlobalErrorToast: true
  })
  const statusQuery = useQuery<Record<string, PrinterStatus>>({
    queryKey: workspaceQueryKeys.printerStatus(workspaceScopeKey),
    queryFn: async ({ signal }) => (await apiFetch<{ statuses: Record<string, PrinterStatus> }>('/api/printers/status', { signal })).statuses,
    initialData: {},
    enabled: authBootstrapQuery.isSuccess ? (canViewPrinters && !showNoConnectedBridgesPlaceholder) : false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })

  const printerRows = printersQuery.data?.printers
  const printers = printerRows ?? EMPTY_PRINTERS
  const printerViews = printerViewsQuery.data?.views ?? EMPTY_PRINTER_VIEWS
  const persistedJobs = jobsQuery.data?.jobs ?? EMPTY_PRINT_JOBS
  const dispatchJobsByPrinter = useMemo(
    () => mapActiveDispatchJobsByPrinter(persistedJobs, dispatchQuery.data?.jobs ?? []),
    [dispatchQuery.data?.jobs, persistedJobs]
  )
  const latestFinishedJobsByPrinter = useMemo(
    () => mapLatestFinishedPrintJobsByPrinter(persistedJobs),
    [persistedJobs]
  )
  const latestActiveJobsByPrinter = useMemo(
    () => mapLatestActivePrintJobsByPrinter(persistedJobs),
    [persistedJobs]
  )

  return {
    authBootstrapQuery,
    workspacePreferenceScopeKey,
    workspaceScopeKey,
    canOpenBridgesSettings,
    canDeleteJobs,
    canUploadLibrary,
    canViewPrinters,
    canManagePrinters,
    canControlPrinters,
    canViewPrinterStorage,
    canDownloadPrinterStorage,
    canDispatchPrints,
    canViewCamera,
    showNoConnectedBridgesPlaceholder,
    printersQuery,
    printerViewsQuery,
    bridgesQuery,
    discoveredQuery,
    slicingCapabilitiesQuery,
    jobsQuery,
    printerRows,
    printers,
    printerViews,
    printerStatuses: statusQuery.data,
    status: statusQuery.data,
    dispatchJobsByPrinter,
    latestFinishedJobsByPrinter,
    latestActiveJobsByPrinter
  }
}
