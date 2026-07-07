import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { Alert, Box, Button, ButtonGroup, CircularProgress, Divider, FormControl, IconButton, Menu, MenuItem, Option, Select, Sheet, Stack, Typography } from '@mui/joy'
import AddIcon from '@mui/icons-material/Add'
import SaveRoundedIcon from '@mui/icons-material/SaveRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import SortRoundedIcon from '@mui/icons-material/SortRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PaginatedSection } from '../components/PaginationFooter'
import { Printer3dRoundedIcon } from '../components/Printer3dRoundedIcon'
import { useNavigate, useParams } from 'react-router-dom'
import { LIBRARY_UPLOAD_PERMISSION, CAMERA_VIEW_PERMISSION, JOBS_DELETE_PERMISSION, JOBS_VIEW_PERMISSION, PRINTERS_CONTROL_PERMISSION, PRINTERS_MANAGE_PERMISSION, PRINTERS_VIEW_PERMISSION, PRINTER_STORAGE_DOWNLOAD_PERMISSION, PRINTER_STORAGE_VIEW_PERMISSION, PRINTS_DISPATCH_PERMISSION, type BridgeListResponse, defaultPrinterViewSort, extractErrorMessage, type Permission, type DiscoveredPrinter, type LibraryFile, type PrintDispatchJob, type PrintJob, type PrinterStatsResponse, type PrinterCardContentSettings, type Printer, type PrinterModel, type StartOrderPrintInput, type PrinterStatus, type SlicingCapabilities, type SlicingJobResponse, type PrinterView, type PrinterViewInput, type PrinterViewSort } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { prefetchSlicingProfiles } from '../lib/slicingProfilesQuery'
import { useAuthBootstrapQuery } from '../lib/authQuery'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../lib/workspaceScope'
import { formatLibraryFileName } from '../lib/libraryDisplay'
import { isUnslicedThreeMfFile } from '../lib/libraryFileTags'
import { mapActiveDispatchJobsByPrinter, mapLatestActivePrintJobsByPrinter, mapLatestFinishedPrintJobsByPrinter } from '../lib/trackedPrintJobs'
import { formatDateTime } from '../lib/time'
import { toast } from '../lib/toast'
import { EmptyState } from '../components/EmptyState'
import { ConfirmActionDialog } from '../components/ConfirmActionDialog'
import { NestedViewHeader } from '../components/NestedViewHeader'
import { NoConnectedBridgesEmptyState } from '../components/NoConnectedBridgesEmptyState'
import { usePromptDialog } from '../components/PromptDialogProvider'
import { type DirectorySortDirection, type DirectoryViewMode } from '../components/DirectoryControls'
import { DirectoryPrimaryToolbar } from '../components/DirectoryToolbar'
import { MultiSelectOption } from '../components/MultiSelectOption'
import { SliceFileModal } from '../components/library/SliceFileModal'
import { SliceThenPrintModal } from '../components/library/SliceThenPrintModal'
import { PrintModal } from '../components/library/PrintModal'
import { useMobileViewport } from '../components/useMobileViewport'
import { usePrintDispatchJobs } from '../hooks/usePrintDispatchJobs'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { usePersistentState } from '../hooks/usePersistentState'
import { useControlledMenuClickAway } from '../hooks/useControlledMenuClickAway'
import { shouldShowNoConnectedPrintersEmptyState } from '../lib/printersEmptyState'
import { usePlateClearingSync } from '../lib/plateClearing'
import { useRuntimePolicy } from '../lib/runtimePolicy'
import { buildTenantWorkspacePath, buildWorkspaceSelectionPath } from '../lib/workspaceRoute'
import { HISTORY_RESULTS, OVERVIEW_VIEW_LABEL, DEFAULT_PRINTER_CARD_CONTENT_SETTINGS, type PrinterStateFilter, parseHistoryViewMode, formatHistoryResultsSummary, formatPrinterViewSelectValue, parseCardsPerRow, parsePrinterStateFilter, encodePrinterViewSort, jobToLibraryFile, printerStateFilterLabel, matchesPrinterStateFilter, matchesPrinterViewAttributeFilters, matchesPrinterSearch, filterPrintersForView, sortPrintersForView, groupPrintersForOverview, parseStoredOptionalString, serializeStoredOptionalString, parseStoredStringArray, parsePrinterModelFilter, parsePrinterViewSort, parsePrinterCardContentSettings, parsePrinterGroupBy, parsePrinterOverviewPageSize, sameStringSet, PRINTER_OVERVIEW_PAGE_SIZE_OPTIONS, type PrinterGroupBy } from '../lib/printersViewHelpers'
import { EMPTY_PRINTERS, EMPTY_PRINT_JOBS, EMPTY_PRINTER_VIEWS, HISTORY_PAGE_SIZE_OPTIONS, HISTORY_SORT_OPTIONS, PRINTER_HISTORY_VIEW_MODE_KEY, PRINTER_HISTORY_SORT_DIR_KEY, PRINTER_HISTORY_RESULT_FILTER_KEY, PRINTER_HISTORY_PAGE_SIZE_KEY, OVERVIEW_VIEW_OPTION_VALUE, NEW_VIEW_OPTION_VALUE, PUBLIC_DEMO_PRINTER_MUTATION_NOTICE, showDemoPrinterMutationNotice, showDemoFileUploadNotice, DEFAULT_SINGLE_PRINTER_CARD_CONTENT_SETTINGS } from '../lib/printerViewConstants'
import { PrinterHistoryCard, PrinterStatsCardGrid } from '../components/printers/PrinterSummaryCards'
import { PrinterCard } from '../components/printers/PrinterCard'
import { PrinterSortModal, PrinterViewsModal } from '../components/printers/PrinterViewModals'
import { PrinterCardContentSettingsModal } from '../components/printers/PrinterCardContentSettingsModal'
import { PrinterFormModal, LocalFilePrintGate, type PrinterFormValues } from '../components/printers/PrinterFormModal'
import { PrinterOverviewToolbar } from '../components/printers/PrinterOverviewToolbar'
import { LibraryPickerModal } from '../components/printers/LibraryPickerModal'

type SliceFlowSubmitInput = Parameters<ComponentProps<typeof SliceFileModal>['onSubmit']>[0]
type SliceFlowSubmitAction = Parameters<ComponentProps<typeof SliceFileModal>['onSubmit']>[1]

/** The toolbar-editable ("view content") fields that stage as an unsaved draft on a saved view. */
type PrinterViewDraft = Partial<{
  sort: PrinterViewSort
  group: PrinterGroupBy
  stateFilter: PrinterStateFilter
  modelFilter: PrinterModel[]
  nozzleDiameterFilter: string[]
  plateTypeFilter: string[]
  printerIds: string[]
}>

/**
 * Printers dashboard. Lists configured printers with their live status
 * (sourced from the WS-fed `printer-status` cache) and supports adding
 * a new printer via a small modal.
 */
const HISTORY_PAGE_SIZES = new Set<number>(HISTORY_PAGE_SIZE_OPTIONS)
const HISTORY_RESULT_SET = new Set<PrintJob['result']>(HISTORY_RESULTS)

/** Validators for the per-printer detail history's persisted directory controls (sort direction, result filter, page size). */
function sanitizeHistorySortDirection(value: unknown): DirectorySortDirection {
  return value === 'asc' ? 'asc' : 'desc'
}
function sanitizeHistoryResults(value: unknown): PrintJob['result'][] {
  return Array.isArray(value)
    ? value.filter((entry): entry is PrintJob['result'] => HISTORY_RESULT_SET.has(entry as PrintJob['result']))
    : []
}
function sanitizeHistoryPageSize(value: unknown): number {
  return typeof value === 'number' && HISTORY_PAGE_SIZES.has(value) ? value : HISTORY_PAGE_SIZE_OPTIONS[0]
}

export function PrintersView() {
  const queryClient = useQueryClient()
  const { confirm } = usePromptDialog()
  const { demoMode } = useRuntimePolicy()
  const navigate = useNavigate()
  const { tenantSlug, printerId: routePrinterId } = useParams<{ tenantSlug: string; printerId: string }>()
  const workspacePath = useCallback((path: string) => (
    tenantSlug ? buildTenantWorkspacePath(tenantSlug, path) : buildWorkspaceSelectionPath()
  ), [tenantSlug])
  const authBootstrapQuery = useAuthBootstrapQuery()
  const workspacePreferenceScopeKey = authBootstrapQuery.data
    ? authBootstrapQuery.data.tenant?.id ?? 'platform'
    : 'pending'
  const printerViewsQueryKey = useMemo(
    () => ['printer-views', workspacePreferenceScopeKey] as const,
    [workspacePreferenceScopeKey]
  )
  const singlePrinterView = Boolean(routePrinterId)
  usePlateClearingSync()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Printer | null>(null)
  const [pickerForPrinter, setPickerForPrinter] = useState<Printer | null>(null)
  const [printTarget, setPrintTarget] = useState<{
    file: LibraryFile
    printerId: string
    defaultPlate?: number
    defaultBedLevel?: boolean
    defaultAmsMapping?: number[] | null
    submitPrint?: (input: {
      printerId: string
      body: Omit<StartOrderPrintInput, 'printerId'>
    }) => Promise<void>
  } | null>(null)
  const [sliceTarget, setSliceTarget] = useState<{ file: LibraryFile; preferredPrinterId: string } | null>(null)
  const [sliceThenPrintTarget, setSliceThenPrintTarget] = useState<{ sourceFile: LibraryFile; jobId: string; preferredPrinterId: string } | null>(null)
  const [replayingJobId, setReplayingJobId] = useState<string | null>(null)
  const [deleteHistoryJobTarget, setDeleteHistoryJobTarget] = useState<PrintJob | null>(null)
  const [deletePrinterViewTarget, setDeletePrinterViewTarget] = useState<PrinterView | null>(null)
  // "Print from local file" target. Distinct from `pickerForPrinter`
  // (which opens the library picker) - this opens a hidden file input,
  // uploads the chosen file with `hidden=true`, then opens the regular
  // PrintModal pre-targeting the originating printer.
  const [localFileForPrinter, setLocalFileForPrinter] = useState<Printer | null>(null)
  // Stable per-action callbacks for PrinterCard. The card is memoized, so these
  // must keep a constant identity across the parent's per-status-tick re-renders
  // or the whole grid would re-render anyway. Each takes the printer as an
  // argument (rather than closing over it) so one callback serves every card.
  const handleCardEdit = useCallback((printer: Printer) => setEditing(printer), [])
  const handleCardPrint = useCallback((printer: Printer) => setPickerForPrinter(printer), [])
  const handleCardPrintLocal = useCallback((printer: Printer) => {
    if (demoMode) showDemoFileUploadNotice()
    setLocalFileForPrinter(printer)
  }, [demoMode])
  const handleCardOpenDetails = useCallback(
    (printer: Printer) => navigate(workspacePath(`/printers/${printer.id}`)),
    [navigate, workspacePath]
  )
  // Page-level Print flow (split button next to "Add printer"). Mirrors
  // the per-card flow but with no preselected printer - the user picks
  // one in the subsequent PrintModal.
  const [pageLibraryPickerOpen, setPageLibraryPickerOpen] = useState(false)
  const [pagePrintMenuOpen, setPagePrintMenuOpen] = useState(false)
  const [sortDialogOpen, setSortDialogOpen] = useState(false)
  const [printerViewsDialogOpen, setPrinterViewsDialogOpen] = useState(false)
  const [printerViewsDialogMode, setPrinterViewsDialogMode] = useState<'settings' | 'create'>('settings')
  const [singleViewSettingsOpen, setSingleViewSettingsOpen] = useState(false)
  const [detailHistorySearch, setDetailHistorySearch] = useState('')
  const deferredDetailHistorySearch = useDeferredValue(detailHistorySearch)
  const [detailHistoryResults, setDetailHistoryResults] = usePersistentState<PrintJob['result'][]>(PRINTER_HISTORY_RESULT_FILTER_KEY, [], sanitizeHistoryResults)
  const [detailHistorySortDirection, setDetailHistorySortDirection] = usePersistentState<DirectorySortDirection>(PRINTER_HISTORY_SORT_DIR_KEY, 'desc', sanitizeHistorySortDirection)
  const [detailHistoryPage, setDetailHistoryPage] = useState(0)
  const [detailHistoryPageSize, setDetailHistoryPageSize] = usePersistentState<number>(PRINTER_HISTORY_PAGE_SIZE_KEY, HISTORY_PAGE_SIZE_OPTIONS[0], sanitizeHistoryPageSize)
  const [detailHistoryViewMode, setDetailHistoryViewMode] = useLocalStorageState<DirectoryViewMode>(
    PRINTER_HISTORY_VIEW_MODE_KEY,
    'list',
    parseHistoryViewMode,
    String
  )
  const pagePrintDesktopAnchorRef = useRef<HTMLDivElement>(null)
  const pagePrintMobileAnchorRef = useRef<HTMLDivElement>(null)
  const isMobileViewport = useMobileViewport()

  const closePrintFlow = () => {
    setPrintTarget(null)
    setSliceTarget(null)
    setSliceThenPrintTarget(null)
    setPickerForPrinter(null)
    setPageLibraryPickerOpen(false)
  }

  const goBackFromPrintFlow = () => {
    setPrintTarget(null)
  }

  const [cardsPerRow, setCardsPerRow] = useLocalStorageState(
    `bambu.printers.cardsPerRow.${workspacePreferenceScopeKey}`,
    3,
    parseCardsPerRow,
    String
  )
  const [stateFilter, setStateFilter] = useLocalStorageState<PrinterStateFilter>(
    `bambu.printers.stateFilter.${workspacePreferenceScopeKey}`,
    'all',
    parsePrinterStateFilter,
    String
  )
  const [modelFilter, setModelFilter] = useLocalStorageState<PrinterModel[]>(
    `bambu.printers.modelFilter.${workspacePreferenceScopeKey}`,
    [],
    parsePrinterModelFilter,
    JSON.stringify
  )
  const [nozzleDiameterFilter, setNozzleDiameterFilter] = useLocalStorageState<string[]>(
    `bambu.printers.nozzleDiameterFilter.${workspacePreferenceScopeKey}`,
    [],
    parseStoredStringArray,
    JSON.stringify
  )
  const [plateTypeFilter, setPlateTypeFilter] = useLocalStorageState<string[]>(
    `bambu.printers.plateTypeFilter.${workspacePreferenceScopeKey}`,
    [],
    parseStoredStringArray,
    JSON.stringify
  )
  useControlledMenuClickAway(pagePrintMenuOpen, 'page-print-menu', () => setPagePrintMenuOpen(false), [
    pagePrintDesktopAnchorRef,
    pagePrintMobileAnchorRef
  ])
  const [printerCardContentSettings, setPrinterCardContentSettings] = useLocalStorageState<PrinterCardContentSettings>(
    `bambu.printers.cardContentSettings.${workspacePreferenceScopeKey}`,
    DEFAULT_PRINTER_CARD_CONTENT_SETTINGS,
    parsePrinterCardContentSettings,
    JSON.stringify
  )
  // The single-printer view shows one full-detail card; its content toggles are
  // a workspace preference shared across every printer, independent of the
  // multi-printer Overview/saved-view settings above.
  const [singlePrinterCardContentSettings, setSinglePrinterCardContentSettings] = useLocalStorageState<PrinterCardContentSettings>(
    `bambu.printers.singleCardContentSettings.${workspacePreferenceScopeKey}`,
    DEFAULT_SINGLE_PRINTER_CARD_CONTENT_SETTINGS,
    parsePrinterCardContentSettings,
    JSON.stringify
  )
  const [defaultViewPrinterIds, setDefaultViewPrinterIds] = useLocalStorageState<string[]>(
    `bambu.printers.viewPrinterIds.${workspacePreferenceScopeKey}`,
    [],
    parseStoredStringArray,
    JSON.stringify
  )
  const [defaultViewSort, setDefaultViewSort] = useLocalStorageState<PrinterViewSort>(
    `bambu.printers.viewSort.${workspacePreferenceScopeKey}`,
    defaultPrinterViewSort,
    parsePrinterViewSort,
    encodePrinterViewSort
  )
  const [defaultPrinterViewId, setDefaultPrinterViewId] = useLocalStorageState<string | null>(
    `bambu.printers.defaultViewId.${workspacePreferenceScopeKey}`,
    null,
    parseStoredOptionalString,
    serializeStoredOptionalString
  )
  const [activePrinterViewId, setActivePrinterViewId] = useState<string | null>(() => defaultPrinterViewId)

  // Overview directory-toolbar state. Search + page are ephemeral; page size is a
  // local display preference. Sort, grouping, the attribute filters, and the printer
  // selection are "view content": on a saved view they stage in `viewDraft` until the
  // user saves; on the Overview they write the local defaults (see applyToolbarChange).
  const [overviewSearch, setOverviewSearch] = useState('')
  const deferredOverviewSearch = useDeferredValue(overviewSearch)
  // Overview has no server row, so its grouping is a local pref; saved views store
  // grouping server-side on the view itself.
  const [overviewGroup, setOverviewGroup] = useLocalStorageState<PrinterGroupBy>(
    `bambu.printers.overviewGroup.${workspacePreferenceScopeKey}`,
    'none',
    parsePrinterGroupBy,
    String
  )
  const [overviewPageSize, setOverviewPageSize] = useLocalStorageState<number>(
    `bambu.printers.overviewPageSize.${workspacePreferenceScopeKey}`,
    PRINTER_OVERVIEW_PAGE_SIZE_OPTIONS[1],
    parsePrinterOverviewPageSize,
    String
  )
  const [overviewPage, setOverviewPage] = useState(0)
  // Pending, unsaved toolbar edits to the active saved view (null = in sync with the
  // saved view). Overlays the view's stored fields until Save changes / Reset.
  const [viewDraft, setViewDraft] = useState<PrinterViewDraft | null>(null)

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
  const workspaceScopeKey = readCurrentWorkspaceScopeKey()
  const showNoConnectedBridgesPlaceholder = authBootstrapQuery.isSuccess
    && !singlePrinterView
    && authBootstrapQuery.data?.tenant != null
    && !authBootstrapQuery.data.tenantHasConnectedBridges

  const printersQuery = useQuery({
    queryKey: ['printers'],
    queryFn: ({ signal }) => apiFetch<{ printers: Printer[] }>('/api/printers', { signal }),
    enabled: authBootstrapQuery.isSuccess ? (canViewPrinters && !showNoConnectedBridgesPlaceholder) : false
  })
  const printerViewsQuery = useQuery({
    queryKey: printerViewsQueryKey,
    queryFn: ({ signal }) => apiFetch<{ views: PrinterView[] }>('/api/printer-views', { signal }),
    enabled: authBootstrapQuery.isSuccess ? (canViewPrinters && !showNoConnectedBridgesPlaceholder) : false
  })
  const bridgesQuery = useQuery({
    queryKey: ['bridges'],
    queryFn: ({ signal }) => apiFetch<BridgeListResponse>('/api/bridges', { signal }),
    enabled: authBootstrapQuery.isSuccess ? (canManagePrinters && !showNoConnectedBridgesPlaceholder) : false
  })

  // Discovered (LAN-broadcast) printers that the user has not yet
  // adopted. The WebSocket fan-out keeps this cache fresh; the initial
  // fetch covers the case where the WS replay has not arrived yet.
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
  // Warm the slicer profile catalogue before a print-from-library flow opens the slice dialog.
  const slicingCapabilitiesData = slicingCapabilitiesQuery.data
  useEffect(() => {
    prefetchSlicingProfiles(queryClient, slicingCapabilitiesData)
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

  // Seed the status cache from HTTP so cards do not default to Offline if
  // the WS replay is late, then keep it fresh from the shared WS hook.
  const statusQuery = useQuery<Record<string, PrinterStatus>>({
    queryKey: workspaceQueryKeys.printerStatus(workspaceScopeKey),
    queryFn: async ({ signal }) => (await apiFetch<{ statuses: Record<string, PrinterStatus> }>('/api/printers/status', { signal })).statuses,
    initialData: {},
    enabled: authBootstrapQuery.isSuccess ? (canViewPrinters && !showNoConnectedBridgesPlaceholder) : false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })
  const printerStatuses = statusQuery.data
  const printerRows = printersQuery.data?.printers
  const status = statusQuery.data
  const printers = printersQuery.data?.printers ?? EMPTY_PRINTERS
  const persistedJobs = jobsQuery.data?.jobs ?? EMPTY_PRINT_JOBS
  const printerViews = printerViewsQuery.data?.views ?? EMPTY_PRINTER_VIEWS
  const activePrinterView = useMemo(
    () => printerViews.find((view) => view.id === activePrinterViewId) ?? null,
    [activePrinterViewId, printerViews]
  )
  const hasStoredDefaultPrinterView = defaultPrinterViewId != null
    && printerViews.some((view) => view.id === defaultPrinterViewId)
  // Layout + card content are owned by the View settings dialog (not the toolbar),
  // so they read straight from the active view / local default.
  const effectiveCardsPerRow = activePrinterView?.cardsPerRow ?? cardsPerRow
  const effectiveCardContentSettings = activePrinterView?.cardContentSettings ?? printerCardContentSettings
  // Toolbar-owned "view content": the draft overlays the saved view; Overview reads its
  // local defaults. These drive the toolbar, filtering, sorting, and grouping below.
  const effectiveSort = activePrinterView ? (viewDraft?.sort ?? activePrinterView.sort) : defaultViewSort
  const effectiveGroup = activePrinterView ? (viewDraft?.group ?? activePrinterView.group) : overviewGroup
  const effectiveStateFilter = activePrinterView ? (viewDraft?.stateFilter ?? activePrinterView.stateFilter) : stateFilter
  const effectiveModelFilter = activePrinterView ? (viewDraft?.modelFilter ?? activePrinterView.modelFilter) : modelFilter
  const effectiveNozzleDiameterFilter = activePrinterView ? (viewDraft?.nozzleDiameterFilter ?? activePrinterView.nozzleDiameterFilter) : nozzleDiameterFilter
  const effectivePlateTypeFilter = activePrinterView ? (viewDraft?.plateTypeFilter ?? activePrinterView.plateTypeFilter) : plateTypeFilter
  const effectivePrinterIds = activePrinterView ? (viewDraft?.printerIds ?? activePrinterView.printerIds) : defaultViewPrinterIds
  // A saved view has unsaved toolbar edits when any "view content" field diverges from it.
  const isViewDirty = activePrinterView != null && (
    effectiveSort.key !== activePrinterView.sort.key
    || effectiveSort.direction !== activePrinterView.sort.direction
    || effectiveGroup !== activePrinterView.group
    || effectiveStateFilter !== activePrinterView.stateFilter
    || !sameStringSet(effectiveModelFilter, activePrinterView.modelFilter)
    || !sameStringSet(effectiveNozzleDiameterFilter, activePrinterView.nozzleDiameterFilter)
    || !sameStringSet(effectivePlateTypeFilter, activePrinterView.plateTypeFilter)
    || !sameStringSet(effectivePrinterIds, activePrinterView.printerIds)
  )
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
  useEffect(() => {
    if (!printerViewsQuery.data) return
    if (defaultPrinterViewId && !hasStoredDefaultPrinterView) {
      setDefaultPrinterViewId(null)
    }
    if (activePrinterViewId && !activePrinterView) {
      setActivePrinterViewId(hasStoredDefaultPrinterView ? defaultPrinterViewId : null)
    }
  }, [
    activePrinterView,
    activePrinterViewId,
    defaultPrinterViewId,
    hasStoredDefaultPrinterView,
    printerViewsQuery.data,
    setDefaultPrinterViewId
  ])

  const filteredPrinters = useMemo(
    () => {
      const attributeFiltered = (printerRows ?? []).filter((printer) => {
        const status = printerStatuses?.[printer.id]
        return matchesPrinterSearch(printer, deferredOverviewSearch)
          && matchesPrinterStateFilter(status, effectiveStateFilter)
          && matchesPrinterViewAttributeFilters(printer, status, {
            modelFilter: effectiveModelFilter,
            nozzleDiameterFilter: effectiveNozzleDiameterFilter,
            plateTypeFilter: effectivePlateTypeFilter
          })
      })
      const viewFiltered = filterPrintersForView(attributeFiltered, effectivePrinterIds)
      return sortPrintersForView(viewFiltered, printerStatuses ?? {}, effectiveSort)
    },
    [
      deferredOverviewSearch,
      effectiveModelFilter,
      effectiveNozzleDiameterFilter,
      effectivePlateTypeFilter,
      effectivePrinterIds,
      effectiveSort,
      effectiveStateFilter,
      printerRows,
      printerStatuses
    ]
  )
  const bridgeNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const bridge of bridgesQuery.data?.bridges ?? []) map.set(bridge.id, bridge.name)
    return map
  }, [bridgesQuery.data?.bridges])
  const resolveBridgeName = useCallback(
    (bridgeId: string | null) => (bridgeId ? bridgeNameById.get(bridgeId) ?? 'Unknown bridge' : 'No bridge'),
    [bridgeNameById]
  )
  const overviewPageCount = Math.max(1, Math.ceil(filteredPrinters.length / overviewPageSize))
  const safeOverviewPage = Math.min(overviewPage, overviewPageCount - 1)
  const pagedPrinters = useMemo(() => {
    const start = safeOverviewPage * overviewPageSize
    return filteredPrinters.slice(start, start + overviewPageSize)
  }, [filteredPrinters, overviewPageSize, safeOverviewPage])
  const printerGroups = useMemo(
    () => groupPrintersForOverview(pagedPrinters, printerStatuses ?? {}, effectiveGroup, resolveBridgeName),
    [effectiveGroup, pagedPrinters, printerStatuses, resolveBridgeName]
  )
  useEffect(() => {
    setOverviewPage((current) => Math.min(current, Math.max(0, Math.ceil(filteredPrinters.length / overviewPageSize) - 1)))
  }, [filteredPrinters.length, overviewPageSize])
  useEffect(() => {
    // Switching views drops any unsaved toolbar draft from the previous view.
    setOverviewPage(0)
    setViewDraft(null)
  }, [activePrinterViewId])
  const selectedPrinter = useMemo(
    () => (routePrinterId ? printers.find((printer) => printer.id === routePrinterId) ?? null : null),
    [printers, routePrinterId]
  )
  const printerStatsQuery = useQuery({
    queryKey: ['printer-stats', routePrinterId],
    queryFn: ({ signal }) => apiFetch<PrinterStatsResponse>(`/api/printers/${routePrinterId}/stats`, { signal }),
    enabled: authBootstrapQuery.isSuccess ? (singlePrinterView && canViewPrinters && selectedPrinter != null) : false
  })
  const selectedPrinterJobs = useMemo(() => {
    if (!routePrinterId) return []
    return (jobsQuery.data?.jobs ?? [])
      .filter((job) => job.printerId === routePrinterId && job.finishedAt)
      .slice()
      .sort((left, right) => detailHistorySortDirection === 'desc'
        ? (right.finishedAt ?? '').localeCompare(left.finishedAt ?? '')
        : (left.finishedAt ?? '').localeCompare(right.finishedAt ?? ''))
  }, [detailHistorySortDirection, jobsQuery.data?.jobs, routePrinterId])
  const filteredSelectedPrinterJobs = useMemo(() => {
    const activeResults = new Set(detailHistoryResults)
    const normalizedSearch = deferredDetailHistorySearch.trim().toLowerCase()
    return selectedPrinterJobs.filter((job) => {
      if (activeResults.size > 0 && !activeResults.has(job.result)) return false
      if (!normalizedSearch) return true
      const searchHaystack = [
        formatLibraryFileName(job.fileName || job.jobName || 'Untitled'),
        job.result,
        formatDateTime(job.startedAt)
      ].join(' ').toLowerCase()
      return searchHaystack.includes(normalizedSearch)
    })
  }, [deferredDetailHistorySearch, detailHistoryResults, selectedPrinterJobs])
  const detailHistoryPageCount = Math.max(1, Math.ceil(filteredSelectedPrinterJobs.length / detailHistoryPageSize))
  const safeDetailHistoryPage = Math.min(detailHistoryPage, detailHistoryPageCount - 1)
  const activeDetailHistoryFilterCount = Number(detailHistoryResults.length > 0)
  const effectiveDetailHistoryViewMode: DirectoryViewMode = isMobileViewport ? 'list' : detailHistoryViewMode
  const visibleSelectedPrinterJobs = useMemo(() => {
    const start = safeDetailHistoryPage * detailHistoryPageSize
    return filteredSelectedPrinterJobs.slice(start, start + detailHistoryPageSize)
  }, [detailHistoryPageSize, filteredSelectedPrinterJobs, safeDetailHistoryPage])

  useEffect(() => {
    setDetailHistoryPage((current) => Math.min(current, Math.max(0, Math.ceil(filteredSelectedPrinterJobs.length / detailHistoryPageSize) - 1)))
  }, [detailHistoryPageSize, filteredSelectedPrinterJobs.length])

  function clearDetailHistoryFilters() {
    setDetailHistoryResults([])
  }

  const addPrinter = useMutation({
    mutationFn: (input: PrinterFormValues) =>
      apiFetch<{ printer: Printer }>('/api/printers', { method: 'POST', body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['printers'] })
      setOpen(false)
    }
  })

  const editPrinter = useMutation({
    mutationFn: ({ id, input }: { id: string; input: PrinterFormValues }) => {
      // Access code is write-only: the server never sends it back, so a blank
      // field means "keep the current code" — omit it from the patch entirely.
      const { accessCode, ...rest } = input
      const body = accessCode.trim() ? input : rest
      return apiFetch<{ printer: Printer }>(`/api/printers/${id}`, { method: 'PATCH', body })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['printers'] })
      setEditing(null)
    }
  })

  const deletePrinter = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/printers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['printers'] })
      setEditing(null)
    }
  })

  const reorderPrinters = useMutation({
    mutationFn: (orderedIds: string[]) =>
      apiFetch('/api/printers/reorder', {
        method: 'POST',
        body: { orderedIds }
      }),
    onSuccess: () => {
      toast.success('Printer order saved')
      void queryClient.invalidateQueries({ queryKey: ['printers'] })
      setSortDialogOpen(false)
    }
  })
  const restartJob = useMutation({
    mutationFn: async (input: { jobId: string; body?: Record<string, unknown> }) => {
      setReplayingJobId(input.jobId)
      return await apiFetch<void | { job: PrintDispatchJob }>(`/api/jobs/${input.jobId}/reprint`, {
        method: 'POST',
        ...(input.body ? { body: input.body } : {})
      })
    },
    onSettled: () => {
      setReplayingJobId(null)
    },
    onSuccess: () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['jobs'] }),
        queryClient.invalidateQueries({ queryKey: ['print-dispatch'] }),
        queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.printerStatus(workspaceScopeKey) })
      ])
    }
  })
  const deleteHistoryJob = useMutation({
    mutationFn: (jobId: string) => apiFetch<void>(`/api/jobs/${jobId}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('History entry deleted')
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
    onError: (error) => {
      toast.error(extractErrorMessage(error))
    }
  })
  const startSlicingJob = useMutation({
    mutationFn: async (input: {
      file: LibraryFile
      preferredPrinterId: string
      action: SliceFlowSubmitAction
    } & SliceFlowSubmitInput) => {
      const body = {
        sourceFileId: input.file.id,
        slicerTargetId: input.slicerTargetId,
        target: input.target.mode === 'realPrinter'
          ? {
              mode: 'realPrinter',
              printerId: input.target.printerId,
              printerProfileId: input.target.printerProfileId,
              plateType: input.target.plateType,
              nozzleDiameters: input.target.nozzleDiameters,
              toolheads: input.target.toolheads,
              processProfileId: input.target.processProfileId,
              filamentMappings: input.target.filamentMappings
            }
          : {
              mode: 'manualProfile',
              printerProfileId: input.target.printerProfileId,
              printerModel: input.target.printerModel ?? 'unknown',
              plateType: input.target.plateType,
              nozzleDiameters: input.target.nozzleDiameters,
              toolheads: input.target.toolheads,
              processProfileId: input.target.processProfileId,
              filamentMappings: input.target.filamentMappings
            },
        outputFileName: input.outputFileName,
        outputFolderId: null,
        hiddenOutput: input.action === 'print',
        plate: input.plate
      }
      return await apiFetch<SlicingJobResponse>('/api/slicing/jobs', { method: 'POST', body })
    },
    onSuccess: async (response, variables) => {
      // Keep the slice dialog mounted beneath the print flow so its "Back" returns to
      // slice settings; the whole flow is torn down together via closePrintFlow.
      await queryClient.invalidateQueries({ queryKey: ['slicing-jobs'] })
      if (variables.action === 'print') {
        setSliceThenPrintTarget({
          sourceFile: variables.file,
          jobId: response.job.id,
          preferredPrinterId: variables.preferredPrinterId
        })
      }
    }
  })
  const createPrinterView = useMutation({
    mutationFn: (input: PrinterViewInput) =>
      apiFetch<{ view: PrinterView }>('/api/printer-views', { method: 'POST', body: input }),
    onSuccess: ({ view }) => {
      toast.success('View saved')
      queryClient.setQueryData<{ views: PrinterView[] }>(printerViewsQueryKey, (current) => ({
        views: [...(current?.views ?? []), view]
      }))
      void queryClient.invalidateQueries({ queryKey: printerViewsQueryKey })
      setViewDraft(null)
      setActivePrinterViewId(view.id)
      setPrinterViewsDialogOpen(false)
    }
  })
  const updatePrinterView = useMutation({
    mutationFn: ({ id, input }: { id: string; input: PrinterViewInput }) =>
      apiFetch<{ view: PrinterView }>(`/api/printer-views/${id}`, { method: 'PATCH', body: input }),
    onSuccess: ({ view }) => {
      toast.success('View updated')
      queryClient.setQueryData<{ views: PrinterView[] }>(printerViewsQueryKey, (current) => ({
        views: (current?.views ?? []).map((entry) => (entry.id === view.id ? view : entry))
      }))
      void queryClient.invalidateQueries({ queryKey: printerViewsQueryKey })
      setActivePrinterViewId(view.id)
      setPrinterViewsDialogOpen(false)
    }
  })
  const deletePrinterView = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/printer-views/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      toast.success('View deleted')
      queryClient.setQueryData<{ views: PrinterView[] }>(printerViewsQueryKey, (current) => ({
        views: (current?.views ?? []).filter((entry) => entry.id !== id)
      }))
      void queryClient.invalidateQueries({ queryKey: printerViewsQueryKey })
      if (activePrinterViewId === id) setActivePrinterViewId(null)
      if (defaultPrinterViewId === id) setDefaultPrinterViewId(null)
      setPrinterViewsDialogOpen(false)
    }
  })
  // Quiet (no toast / no dialog) PATCH used when the inline toolbar edits the
  // active saved view in place. Reconciles the cache from the server response.
  const quietUpdatePrinterView = useMutation({
    mutationFn: ({ id, input }: { id: string; input: PrinterViewInput }) =>
      apiFetch<{ view: PrinterView }>(`/api/printer-views/${id}`, { method: 'PATCH', body: input }),
    onSuccess: ({ view }) => {
      queryClient.setQueryData<{ views: PrinterView[] }>(printerViewsQueryKey, (current) => ({
        views: (current?.views ?? []).map((entry) => (entry.id === view.id ? view : entry))
      }))
    },
    onError: (error) => {
      toast.error(extractErrorMessage(error))
      void queryClient.invalidateQueries({ queryKey: printerViewsQueryKey })
    }
  })

  // Stage a toolbar "view content" change: on a saved view it overlays the draft
  // (committed later via Save changes); on the Overview it writes the local defaults.
  const applyToolbarChange = useCallback((partial: PrinterViewDraft) => {
    setOverviewPage(0)
    if (activePrinterView) {
      setViewDraft((current) => ({ ...current, ...partial }))
      return
    }
    if (partial.sort !== undefined) setDefaultViewSort(partial.sort)
    if (partial.group !== undefined) setOverviewGroup(partial.group)
    if (partial.stateFilter !== undefined) setStateFilter(partial.stateFilter)
    if (partial.modelFilter !== undefined) setModelFilter(partial.modelFilter)
    if (partial.nozzleDiameterFilter !== undefined) setNozzleDiameterFilter(partial.nozzleDiameterFilter)
    if (partial.plateTypeFilter !== undefined) setPlateTypeFilter(partial.plateTypeFilter)
    if (partial.printerIds !== undefined) setDefaultViewPrinterIds(partial.printerIds)
  }, [
    activePrinterView,
    setDefaultViewPrinterIds,
    setDefaultViewSort,
    setModelFilter,
    setNozzleDiameterFilter,
    setOverviewGroup,
    setPlateTypeFilter,
    setStateFilter
  ])

  const resetActiveView = useCallback(() => setViewDraft(null), [])

  // Commit the staged draft onto the saved view via PATCH (with an optimistic cache
  // update so the UI settles immediately), then clear the draft.
  const saveActiveView = useCallback(() => {
    if (!activePrinterView) return
    const input: PrinterViewInput = {
      name: activePrinterView.name,
      cardsPerRow: activePrinterView.cardsPerRow,
      cardContentSettings: activePrinterView.cardContentSettings,
      sort: effectiveSort,
      group: effectiveGroup,
      stateFilter: effectiveStateFilter,
      modelFilter: effectiveModelFilter,
      nozzleDiameterFilter: effectiveNozzleDiameterFilter,
      plateTypeFilter: effectivePlateTypeFilter,
      printerIds: effectivePrinterIds
    }
    queryClient.setQueryData<{ views: PrinterView[] }>(printerViewsQueryKey, (current) => ({
      views: (current?.views ?? []).map((entry) => (entry.id === activePrinterView.id ? { ...entry, ...input } : entry))
    }))
    quietUpdatePrinterView.mutate({ id: activePrinterView.id, input })
    setViewDraft(null)
    toast.success('View updated')
  }, [
    activePrinterView,
    effectiveGroup,
    effectiveModelFilter,
    effectiveNozzleDiameterFilter,
    effectivePlateTypeFilter,
    effectivePrinterIds,
    effectiveSort,
    effectiveStateFilter,
    printerViewsQueryKey,
    queryClient,
    quietUpdatePrinterView
  ])

  const printerViewsMutationError = createPrinterView.error
    ? (createPrinterView.error as Error).message
    : updatePrinterView.error
      ? (updatePrinterView.error as Error).message
      : deletePrinterView.error
        ? (deletePrinterView.error as Error).message
        : null
  const printerViewsSubmitting = createPrinterView.isPending || updatePrinterView.isPending || deletePrinterView.isPending
          const currentViewLabel = activePrinterView?.name ?? OVERVIEW_VIEW_LABEL
        const isOverviewDefaultView = defaultPrinterViewId == null
        const isActiveViewDefault = defaultPrinterViewId === (activePrinterView?.id ?? null)

  return (
    <Stack spacing={2}>
      {demoMode && (
        <Alert color="neutral" variant="outlined" startDecorator={<InfoOutlinedIcon />}>
          <Typography level="body-sm">
            {PUBLIC_DEMO_PRINTER_MUTATION_NOTICE}
          </Typography>
        </Alert>
      )}

      {singlePrinterView ? (
        <Stack
          direction="row"
          spacing={1}
          alignItems="flex-start"
          justifyContent="space-between"
          sx={{ flexWrap: 'wrap' }}
        >
          <NestedViewHeader
            crumbs={[
              { label: 'Printers', onClick: () => navigate(workspacePath('/printers')) },
              { label: selectedPrinter?.name ?? 'Printer' }
            ]}
            description={selectedPrinter
              ? `${selectedPrinter.model} details, live status, controls, storage, and print history.`
              : 'Live status, controls, storage, and print history for this printer.'}
          />
          {selectedPrinter && (
            <Button
              size="sm"
              variant="soft"
              color="neutral"
              startDecorator={<TuneRoundedIcon />}
              onClick={() => setSingleViewSettingsOpen(true)}
              sx={{ flex: '0 0 auto' }}
            >
              View settings
            </Button>
          )}
        </Stack>
      ) : showNoConnectedBridgesPlaceholder ? (
        <Stack spacing={1}>
          <Typography level="h3" startDecorator={<Printer3dRoundedIcon />}>Printers</Typography>
        </Stack>
      ) : (
        <Stack spacing={1}>
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            justifyContent="space-between"
            sx={{ flexWrap: 'wrap' }}
          >
            <Typography level="h3" startDecorator={<Printer3dRoundedIcon />}>Printers</Typography>
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              sx={{ display: { xs: 'none', sm: 'flex' }, flexWrap: 'wrap', justifyContent: 'flex-end', ml: 'auto', '& > *': { minWidth: 0 } }}
            >
              <Select
                size="sm"
                value={activePrinterViewId ?? OVERVIEW_VIEW_OPTION_VALUE}
                onChange={(_event, value) => {
                  if (value === NEW_VIEW_OPTION_VALUE) {
                    setPrinterViewsDialogMode('create')
                    setPrinterViewsDialogOpen(true)
                    return
                  }
                  setViewDraft(null)
                  setActivePrinterViewId(value === OVERVIEW_VIEW_OPTION_VALUE ? null : value ?? null)
                }}
                sx={{ minWidth: 168, flex: '0 0 auto' }}
                renderValue={() => `View: ${formatPrinterViewSelectValue(activePrinterViewId, printerViews, defaultPrinterViewId, isOverviewDefaultView)}`}
                slotProps={{ button: { 'aria-label': 'Saved printer views' } }}
              >
                <Option value={NEW_VIEW_OPTION_VALUE}>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                    <AddIcon fontSize="small" />
                    <span>New view…</span>
                  </Box>
                </Option>
                <Option value={OVERVIEW_VIEW_OPTION_VALUE}>
                  {isOverviewDefaultView ? `${OVERVIEW_VIEW_LABEL} (Default)` : OVERVIEW_VIEW_LABEL}
                </Option>
                {printerViews.map((view) => (
                  <Option key={view.id} value={view.id}>
                    {defaultPrinterViewId === view.id ? `${view.name} (Default)` : view.name}
                  </Option>
                ))}
              </Select>
              <Button
                size="sm"
                variant="soft"
                color="neutral"
                startDecorator={<TuneRoundedIcon />}
                onClick={() => {
                  setPrinterViewsDialogMode('settings')
                  setPrinterViewsDialogOpen(true)
                }}
                sx={{ flex: '0 0 auto' }}
              >
                View settings
              </Button>
              {canManagePrinters && <Divider orientation="vertical" sx={{ alignSelf: 'stretch', mx: 0.25 }} />}
              {canManagePrinters && (
                <Button
                  size="sm"
                  startDecorator={<AddIcon />}
                  sx={{ flex: '0 0 auto', minWidth: 0 }}
                  disabled={(bridgesQuery.data?.bridges.length ?? 0) === 0}
                  onClick={() => setOpen(true)}
                >
                  Add printer
                </Button>
              )}
              {canDispatchPrints && <Divider orientation="vertical" sx={{ alignSelf: 'stretch', mx: 0.25 }} />}
              {canDispatchPrints && (
                <ButtonGroup
                  ref={pagePrintDesktopAnchorRef}
                  size="sm"
                  color="primary"
                  variant="solid"
                  aria-label="print"
                  sx={{ flex: '0 0 auto', minWidth: 0 }}
                >
                  <Button
                    onClick={() => setPageLibraryPickerOpen(true)}
                    startDecorator={<PrintRoundedIcon />}
                    sx={{ flex: 1, minWidth: 0 }}
                  >
                    Print
                  </Button>
                  <IconButton
                    aria-controls={pagePrintMenuOpen ? 'page-print-menu' : undefined}
                    aria-expanded={pagePrintMenuOpen ? 'true' : undefined}
                    aria-haspopup="menu"
                    aria-label="More print options"
                    onClick={() => setPagePrintMenuOpen((value) => !value)}
                  >
                    <ArrowDropDownIcon />
                  </IconButton>
                </ButtonGroup>
              )}
            </Stack>
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              sx={{ display: { xs: 'flex', sm: 'none' }, ml: 'auto', '& > *': { minWidth: 0 } }}
            >
              {canManagePrinters && (
                <Button
                  size="sm"
                  onClick={() => setOpen(true)}
                  startDecorator={<AddIcon />}
                  sx={{ width: 119, flex: '0 0 auto' }}
                >
                  Add printer
                </Button>
              )}
              {canDispatchPrints && (
                <ButtonGroup
                  ref={pagePrintMobileAnchorRef}
                  size="sm"
                  color="primary"
                  variant="solid"
                  aria-label="print"
                  sx={{ width: 119, flex: '0 0 auto', minWidth: 0 }}
                >
                  <Button
                    onClick={() => setPageLibraryPickerOpen(true)}
                    startDecorator={<PrintRoundedIcon />}
                    sx={{ flex: 1, minWidth: 0 }}
                  >
                    Print
                  </Button>
                  <IconButton
                    aria-controls={pagePrintMenuOpen ? 'page-print-menu' : undefined}
                    aria-expanded={pagePrintMenuOpen ? 'true' : undefined}
                    aria-haspopup="menu"
                    aria-label="More print options"
                    onClick={() => setPagePrintMenuOpen((value) => !value)}
                  >
                    <ArrowDropDownIcon />
                  </IconButton>
                </ButtonGroup>
              )}
            </Stack>
          </Stack>
          <Stack
            spacing={1}
            sx={{ display: { xs: 'flex', sm: 'none' }, width: '100%' }}
          >
            <Stack direction="row" spacing={1} sx={{ width: '100%', '& > *': { minWidth: 0 } }}>
              <Select
                size="sm"
                value={activePrinterViewId ?? OVERVIEW_VIEW_OPTION_VALUE}
                onChange={(_event, value) => {
                  if (value === NEW_VIEW_OPTION_VALUE) {
                    setPrinterViewsDialogMode('create')
                    setPrinterViewsDialogOpen(true)
                    return
                  }
                  setViewDraft(null)
                  setActivePrinterViewId(value === OVERVIEW_VIEW_OPTION_VALUE ? null : value ?? null)
                }}
                sx={{ flex: '1 1 0', minWidth: 0 }}
                renderValue={() => `View: ${formatPrinterViewSelectValue(activePrinterViewId, printerViews, defaultPrinterViewId, isOverviewDefaultView)}`}
                slotProps={{ button: { 'aria-label': 'Saved printer views' } }}
              >
                <Option value={NEW_VIEW_OPTION_VALUE}>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                    <AddIcon fontSize="small" />
                    <span>New view…</span>
                  </Box>
                </Option>
                <Option value={OVERVIEW_VIEW_OPTION_VALUE}>
                  {isOverviewDefaultView ? `${OVERVIEW_VIEW_LABEL} (Default)` : OVERVIEW_VIEW_LABEL}
                </Option>
                {printerViews.map((view) => (
                  <Option key={view.id} value={view.id}>
                    {defaultPrinterViewId === view.id ? `${view.name} (Default)` : view.name}
                  </Option>
                ))}
              </Select>
              <Button
                size="sm"
                variant="soft"
                color="neutral"
                startDecorator={<TuneRoundedIcon />}
                onClick={() => {
                  setPrinterViewsDialogMode('settings')
                  setPrinterViewsDialogOpen(true)
                }}
                sx={{ flex: '0 0 auto', minWidth: 132, px: 1.5 }}
              >
                View settings
              </Button>
            </Stack>
          </Stack>
          {canDispatchPrints && (
            <Menu
              id="page-print-menu"
              open={pagePrintMenuOpen}
              onClose={() => setPagePrintMenuOpen(false)}
              anchorEl={pagePrintDesktopAnchorRef.current?.offsetParent != null
                ? pagePrintDesktopAnchorRef.current
                : pagePrintMobileAnchorRef.current}
              placement="bottom-end"
            >
              <MenuItem
                onClick={() => {
                  setPagePrintMenuOpen(false)
                  setPageLibraryPickerOpen(true)
                }}
              >
                Print from library…
              </MenuItem>
            </Menu>
          )}
        </Stack>
      )}

      {authBootstrapQuery.isLoading && <Typography>Loading…</Typography>}
      {printersQuery.isLoading && canViewPrinters && <Typography>Loading…</Typography>}
      {printersQuery.error && <Typography color="danger">{(printersQuery.error as Error).message}</Typography>}

      {authBootstrapQuery.isSuccess && !canViewPrinters && (
        <EmptyState
          icon={<Printer3dRoundedIcon />}
          title="Printer access required"
          description="Your account can view the app shell, but not the printers dashboard."
        />
      )}

      {authBootstrapQuery.isSuccess && canViewPrinters && (singlePrinterView ? (
        <Stack spacing={2}>
          {!printersQuery.isLoading && !printersQuery.error && !selectedPrinter && (
            <EmptyState
              icon={<Printer3dRoundedIcon />}
              title="Printer not found"
              description="This printer does not exist or is no longer configured."
              action={
                <Button size="sm" variant="soft" color="neutral" onClick={() => navigate(workspacePath('/printers'))}>
                  Back to printers
                </Button>
              }
            />
          )}

          {selectedPrinter && (
            <PrinterCard
              printer={selectedPrinter}
              status={status?.[selectedPrinter.id]}
              dispatchLink={dispatchJobsByPrinter.get(selectedPrinter.id)}
              activeJob={latestActiveJobsByPrinter.get(selectedPrinter.id)}
              latestJob={latestFinishedJobsByPrinter.get(selectedPrinter.id)}
              contentSettings={singlePrinterCardContentSettings}
              cardsPerRow={1}
              demoMode={demoMode}
              canControlPrinter={canControlPrinters}
              canManagePrinter={canManagePrinters}
              canViewPrinterStorage={canViewPrinterStorage}
              canDownloadPrinterStorage={canDownloadPrinterStorage}
              canDispatchPrints={canDispatchPrints}
              canViewCamera={canViewCamera}
              onEdit={handleCardEdit}
              onPrint={handleCardPrint}
              onPrintLocal={handleCardPrintLocal}
            />
          )}

          {selectedPrinter && (
            <Stack spacing={1.5}>
              <Typography level="title-lg">Print stats</Typography>

              {printerStatsQuery.isLoading && (
                <Stack direction="row" spacing={1} alignItems="center">
                  <CircularProgress size="sm" />
                  <Typography level="body-sm" textColor="text.tertiary">Loading printer stats…</Typography>
                </Stack>
              )}

              {printerStatsQuery.error && (
                <Alert color="danger" variant="soft">
                  Printer stats could not be loaded right now.
                </Alert>
              )}

              {printerStatsQuery.data && (
                <PrinterStatsCardGrid stats={printerStatsQuery.data.stats} />
              )}
            </Stack>
          )}

          {selectedPrinter && (
            <Stack spacing={1}>
              <Typography level="title-lg">Print history</Typography>

              {jobsQuery.isLoading && <Typography>Loading history…</Typography>}
              {jobsQuery.error && <Typography color="danger">{(jobsQuery.error as Error).message}</Typography>}

              {!jobsQuery.isLoading && !jobsQuery.error && selectedPrinterJobs.length === 0 && (
                <EmptyState
                  compact
                  icon={<PrintRoundedIcon />}
                  title="No print history yet"
                  description="Completed and failed prints for this printer will appear here once a job has been started from PrintStream."
                />
              )}

              {selectedPrinterJobs.length > 0 && (
                <DirectoryPrimaryToolbar
                    pinStorageKey="printers.history"
                    searchValue={detailHistorySearch}
                    onSearchChange={(value) => {
                      setDetailHistoryPage(0)
                      setDetailHistorySearch(value)
                    }}
                    searchPlaceholder="Search file, result, or time"
                    searchAriaLabel="Search printer print history"
                    filters={{
                      activeCount: activeDetailHistoryFilterCount,
                      onClear: clearDetailHistoryFilters,
                      clearDisabled: activeDetailHistoryFilterCount === 0,
                      children: (
                        <FormControl>
                          <Typography level="body-sm" textColor="text.tertiary">Results</Typography>
                          <Select
                            size="sm"
                            multiple
                            value={detailHistoryResults}
                            onChange={(_event, value) => {
                              setDetailHistoryPage(0)
                              setDetailHistoryResults(value ?? [])
                            }}
                            placeholder="All results"
                            renderValue={() => detailHistoryResults.length === 0
                              ? null
                              : formatHistoryResultsSummary(detailHistoryResults)}
                            slotProps={{ listbox: { disablePortal: true, sx: { maxHeight: 280 } } }}
                          >
                            {HISTORY_RESULTS.map((result) => (
                              <MultiSelectOption key={result} value={result} selected={detailHistoryResults.includes(result)}>{result}</MultiSelectOption>
                            ))}
                          </Select>
                        </FormControl>
                      )
                    }}
                    pageSizeValue={detailHistoryPageSize}
                    pageSizeOptions={HISTORY_PAGE_SIZE_OPTIONS.map((value) => ({ value, label: `${value} rows per page` }))}
                    onPageSizeChange={(value) => {
                      setDetailHistoryPage(0)
                      setDetailHistoryPageSize(value)
                    }}
                    pageSizeAriaLabel="Printer history rows per page"
                    pageSizeRenderValue={(value) => `${value} per page`}
                    sortValue="date"
                    sortOptions={HISTORY_SORT_OPTIONS}
                    onSortValueChange={() => undefined}
                    sortDirection={detailHistorySortDirection}
                    onSortDirectionChange={(direction) => {
                      setDetailHistoryPage(0)
                      setDetailHistorySortDirection(direction)
                    }}
                    sortAriaLabel="Sort printer print history by"
                    viewMode={effectiveDetailHistoryViewMode}
                    onViewModeChange={setDetailHistoryViewMode}
                    disableIconModeOnMobile
                  />
              )}

              {selectedPrinterJobs.length > 0 && filteredSelectedPrinterJobs.length === 0 && (
                <Typography level="body-sm" textColor="text.tertiary">
                  No print history matches the current search or filters.
                </Typography>
              )}

              {filteredSelectedPrinterJobs.length > 0 && (
                <PaginatedSection
                  showingLabel={`Showing ${safeDetailHistoryPage * detailHistoryPageSize + 1}-${Math.min(filteredSelectedPrinterJobs.length, (safeDetailHistoryPage + 1) * detailHistoryPageSize)} of ${filteredSelectedPrinterJobs.length}`}
                  previousDisabled={safeDetailHistoryPage === 0}
                  nextDisabled={safeDetailHistoryPage >= detailHistoryPageCount - 1}
                  onPrevious={() => setDetailHistoryPage((current) => Math.max(0, current - 1))}
                  onNext={() => setDetailHistoryPage((current) => Math.min(detailHistoryPageCount - 1, current + 1))}
                  spacing={1.5}
                >
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: effectiveDetailHistoryViewMode === 'icon'
                        ? { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }
                        : 'minmax(0, 1fr)',
                      gap: 1.5,
                      alignItems: 'stretch'
                    }}
                  >
                    {visibleSelectedPrinterJobs.map((job) => (
                      <PrinterHistoryCard
                        key={job.id}
                        job={job}
                        canDeleteJobs={canDeleteJobs}
                        canDispatchPrints={canDispatchPrints}
                        canControlPrinters={canControlPrinters}
                        deletingJobId={deleteHistoryJob.isPending ? deleteHistoryJob.variables ?? null : null}
                        replayingJobId={replayingJobId}
                        onDelete={(jobId) => {
                          const job = selectedPrinterJobs.find((entry) => entry.id === jobId) ?? null
                          if (job) setDeleteHistoryJobTarget(job)
                        }}
                        onReprintLibrary={(reprintJob) => {
                          setPrintTarget({
                            file: jobToLibraryFile(reprintJob),
                            printerId: reprintJob.printerId,
                            defaultPlate: reprintJob.plate ?? 1,
                            defaultBedLevel: reprintJob.bedLevel ?? true,
                            defaultAmsMapping: reprintJob.amsMapping,
                            submitPrint: async ({ printerId, body }) => {
                              await restartJob.mutateAsync({
                                jobId: reprintJob.id,
                                body: {
                                  printerId,
                                  ...body
                                }
                              })
                            }
                          })
                        }}
                        onReprintCalibration={(jobId) => restartJob.mutate({ jobId })}
                      />
                    ))}
                  </Box>
                </PaginatedSection>
              )}
            </Stack>
          )}
        </Stack>
      ) : showNoConnectedBridgesPlaceholder ? (
        <NoConnectedBridgesEmptyState
          title="Connect a bridge to add printers"
          description="Connect a bridge in Settings to bring local printers online and start monitoring them here."
          managedTitle="Waiting for your printers"
          managedDescription="Your printers will appear here once PrintStream's printer connection service is online."
          canOpenBridgesSettings={canOpenBridgesSettings}
          onOpenBridgesSettings={() => navigate(workspacePath('/settings/bridges'))}
        />
      ) : (
        <Stack spacing={1.5}>
          {printers.length > 0 && (
            <PrinterOverviewToolbar
              printers={printers}
              search={overviewSearch}
              onSearchChange={(value) => { setOverviewPage(0); setOverviewSearch(value) }}
              group={effectiveGroup}
              onGroupChange={(value) => applyToolbarChange({ group: value })}
              pageSize={overviewPageSize}
              onPageSizeChange={(value) => { setOverviewPage(0); setOverviewPageSize(value) }}
              sort={effectiveSort}
              onSortFieldChange={(key) => applyToolbarChange({ sort: { key, direction: effectiveSort.direction } })}
              onSortDirectionChange={(direction) => applyToolbarChange({ sort: { key: effectiveSort.key, direction } })}
              stateFilter={effectiveStateFilter}
              onStateFilterChange={(value) => applyToolbarChange({ stateFilter: value })}
              modelFilter={effectiveModelFilter}
              onModelFilterChange={(value) => applyToolbarChange({ modelFilter: value })}
              nozzleDiameterFilter={effectiveNozzleDiameterFilter}
              onNozzleDiameterFilterChange={(value) => applyToolbarChange({ nozzleDiameterFilter: value })}
              plateTypeFilter={effectivePlateTypeFilter}
              onPlateTypeFilterChange={(value) => applyToolbarChange({ plateTypeFilter: value })}
              printerIds={effectivePrinterIds}
              onPrinterIdsChange={(value) => applyToolbarChange({ printerIds: value })}
              onClearFilters={() => {
                setOverviewSearch('')
                applyToolbarChange({ stateFilter: 'all', modelFilter: [], nozzleDiameterFilter: [], plateTypeFilter: [], printerIds: [] })
              }}
            />
          )}

          {activePrinterView && isViewDirty && (
            <Sheet
              variant="soft"
              color="warning"
              sx={{ borderRadius: 'md', px: 1.5, py: 1, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}
            >
              <Typography level="body-sm">
                Unsaved changes to <strong>{activePrinterView.name}</strong>
              </Typography>
              <Stack direction="row" spacing={1} sx={{ ml: 'auto' }}>
                <Button size="sm" variant="plain" color="neutral" onClick={resetActiveView}>Reset</Button>
                <Button size="sm" variant="solid" color="primary" startDecorator={<SaveRoundedIcon />} onClick={saveActiveView}>
                  Save changes
                </Button>
              </Stack>
            </Sheet>
          )}

          {printers.length > 1 && effectiveSort.key === 'manual' && (
            <Box>
              <Button
                size="sm"
                variant="plain"
                color="neutral"
                startDecorator={<SortRoundedIcon />}
                onClick={() => setSortDialogOpen(true)}
              >
                Edit manual order
              </Button>
            </Box>
          )}

          {shouldShowNoConnectedPrintersEmptyState({
            showNoConnectedBridgesPlaceholder,
            printersCount: printers.length,
            loading: printersQuery.isLoading,
            hasError: Boolean(printersQuery.error)
          }) && (
            <EmptyState
              icon={<Printer3dRoundedIcon />}
              title="No printers connected"
              description="Add your first Bambu printer to start monitoring status, browsing storage, and sending prints from the library."
              action={canManagePrinters ? (
                <Button size="sm" startDecorator={<AddIcon />} onClick={() => setOpen(true)}>
                  Add printer
                </Button>
              ) : undefined}
            />
          )}

          {printers.length > 0 && filteredPrinters.length === 0 && !printersQuery.isLoading && !printersQuery.error && (
            <EmptyState
              icon={<Printer3dRoundedIcon />}
              title="No printers match this filter"
              description={
                effectiveModelFilter.length === 0
                  && effectiveNozzleDiameterFilter.length === 0
                  && effectivePlateTypeFilter.length === 0
                  && deferredOverviewSearch.trim() === ''
                  && effectiveStateFilter !== 'all'
                  ? `No printers are currently in the ${printerStateFilterLabel(effectiveStateFilter).toLowerCase()} state.`
                  : 'No printers match the current search or filters.'
              }
              action={
                <Button
                  size="sm"
                  variant="soft"
                  onClick={() => {
                    setOverviewSearch('')
                    applyToolbarChange({ stateFilter: 'all', modelFilter: [], nozzleDiameterFilter: [], plateTypeFilter: [], printerIds: [] })
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          )}

          {filteredPrinters.length > 0 && (
            <PaginatedSection
              showingLabel={`Showing ${safeOverviewPage * overviewPageSize + 1}-${Math.min(filteredPrinters.length, (safeOverviewPage + 1) * overviewPageSize)} of ${filteredPrinters.length}`}
              previousDisabled={safeOverviewPage === 0}
              nextDisabled={safeOverviewPage >= overviewPageCount - 1}
              onPrevious={() => setOverviewPage((current) => Math.max(0, current - 1))}
              onNext={() => setOverviewPage((current) => Math.min(overviewPageCount - 1, current + 1))}
              spacing={1.5}
            >
              <Stack spacing={2.5}>
                {printerGroups.map((groupEntry) => (
                  <Stack key={groupEntry.key} spacing={groupEntry.label ? 1 : 0}>
                    {groupEntry.label && (
                      <Typography level="title-sm" textColor="text.tertiary">
                        {groupEntry.label} · {groupEntry.printers.length}
                      </Typography>
                    )}
                    <Box
                      sx={{
                        display: 'grid',
                        gap: { xs: 1.5, sm: 2.5 },
                        gridTemplateColumns: {
                          xs: '1fr',
                          sm: `repeat(${effectiveCardsPerRow}, minmax(0, 1fr))`
                        }
                      }}
                    >
                      {groupEntry.printers.map((printer) => (
                        <PrinterCard
                          key={printer.id}
                          printer={printer}
                          status={status?.[printer.id]}
                          dispatchLink={dispatchJobsByPrinter.get(printer.id)}
                          activeJob={latestActiveJobsByPrinter.get(printer.id)}
                          latestJob={latestFinishedJobsByPrinter.get(printer.id)}
                          contentSettings={effectiveCardContentSettings}
                          compact={effectiveCardsPerRow >= 4}
                          cardsPerRow={effectiveCardsPerRow}
                          demoMode={demoMode}
                          canControlPrinter={canControlPrinters}
                          canManagePrinter={canManagePrinters}
                          canViewPrinterStorage={canViewPrinterStorage}
                          canDownloadPrinterStorage={canDownloadPrinterStorage}
                          canDispatchPrints={canDispatchPrints}
                          canViewCamera={canViewCamera}
                          onEdit={handleCardEdit}
                          onPrint={handleCardPrint}
                          onPrintLocal={handleCardPrintLocal}
                          onOpenDetails={handleCardOpenDetails}
                        />
                      ))}
                    </Box>
                  </Stack>
                ))}
              </Stack>
            </PaginatedSection>
          )}
        </Stack>
      ))}

      {open && (
        <PrinterFormModal
          mode="add"
          demoMode={demoMode}
          submitting={addPrinter.isPending}
          error={addPrinter.error ? (addPrinter.error as Error).message : null}
          bridges={bridgesQuery.data?.bridges ?? []}
          discovered={discoveredQuery.data?.printers ?? []}
          onCancel={() => setOpen(false)}
          onSubmit={(input) => {
            if (demoMode) {
              showDemoPrinterMutationNotice('add')
              return
            }
            addPrinter.mutate(input)
          }}
        />
      )}

      {editing && (
        <PrinterFormModal
          mode="edit"
          demoMode={demoMode}
          initialValues={{
            ...editing,
            bridgeId: editing.bridgeId ?? ''
          }}
          status={status?.[editing.id]}
          bridges={bridgesQuery.data?.bridges ?? []}
          submitting={editPrinter.isPending}
          deleting={deletePrinter.isPending}
          error={
            editPrinter.error
              ? (editPrinter.error as Error).message
              : deletePrinter.error
                ? (deletePrinter.error as Error).message
                : null
          }
          onCancel={() => setEditing(null)}
          onSubmit={(input) => {
            if (demoMode) {
              showDemoPrinterMutationNotice('edit')
              return
            }
            editPrinter.mutate({ id: editing.id, input })
          }}
          onDelete={async () => {
            const confirmed = await confirm({
              title: `Remove ${editing.name}?`,
              description: `Remove ${editing.name}? This will disconnect the printer.`,
              confirmLabel: 'Remove printer',
              color: 'danger'
            })
            if (!confirmed) return
            if (demoMode) {
              showDemoPrinterMutationNotice('delete')
              return
            }
            deletePrinter.mutate(editing.id)
          }}
        />
      )}

      {sortDialogOpen && (
        <PrinterSortModal
          printers={printers}
          submitting={reorderPrinters.isPending}
          error={reorderPrinters.error ? (reorderPrinters.error as Error).message : null}
          onCancel={() => setSortDialogOpen(false)}
          onSubmit={(orderedIds) => reorderPrinters.mutate(orderedIds)}
        />
      )}

      {printerViewsDialogOpen && (
        <PrinterViewsModal
          mode={printerViewsDialogMode}
          activeView={activePrinterView}
          currentViewLabel={printerViewsDialogMode === 'create' ? 'New view' : currentViewLabel}
          isCurrentDefaultView={printerViewsDialogMode === 'create' ? false : isActiveViewDefault}
          currentState={
            // View settings edits the saved view's committed content (independent of any
            // pending toolbar draft); New view / Overview capture the current display.
            printerViewsDialogMode === 'settings' && activePrinterView
              ? {
                  name: activePrinterView.name,
                  printerIds: activePrinterView.printerIds,
                  cardsPerRow: activePrinterView.cardsPerRow,
                  stateFilter: activePrinterView.stateFilter,
                  modelFilter: activePrinterView.modelFilter,
                  nozzleDiameterFilter: activePrinterView.nozzleDiameterFilter,
                  plateTypeFilter: activePrinterView.plateTypeFilter,
                  sort: activePrinterView.sort,
                  group: activePrinterView.group,
                  cardContentSettings: activePrinterView.cardContentSettings
                }
              : {
                  name: '',
                  printerIds: effectivePrinterIds,
                  cardsPerRow: effectiveCardsPerRow,
                  stateFilter: effectiveStateFilter,
                  modelFilter: effectiveModelFilter,
                  nozzleDiameterFilter: effectiveNozzleDiameterFilter,
                  plateTypeFilter: effectivePlateTypeFilter,
                  sort: effectiveSort,
                  group: effectiveGroup,
                  cardContentSettings: effectiveCardContentSettings
                }
          }
          submitting={printerViewsSubmitting}
          error={printerViewsMutationError}
          onClose={() => setPrinterViewsDialogOpen(false)}
          onApplyDefault={(input) => {
            setCardsPerRow(input.cardsPerRow)
            setStateFilter(input.stateFilter)
            setModelFilter(input.modelFilter)
            setNozzleDiameterFilter(input.nozzleDiameterFilter)
            setPlateTypeFilter(input.plateTypeFilter)
            setPrinterCardContentSettings(input.cardContentSettings)
            setDefaultViewPrinterIds(input.printerIds)
            setDefaultViewSort(input.sort)
            toast.success('Overview updated')
            setPrinterViewsDialogOpen(false)
          }}
          onCreate={(input) => createPrinterView.mutate(input)}
          onUpdate={(id, input) => updatePrinterView.mutate({ id, input })}
          onDelete={(id) => {
            const view = printerViews.find((entry) => entry.id === id) ?? null
            if (view) setDeletePrinterViewTarget(view)
          }}
          onSetAsDefault={() => {
            setDefaultPrinterViewId(activePrinterView?.id ?? null)
            toast.success(`${activePrinterView?.name ?? OVERVIEW_VIEW_LABEL} set as default`)
          }}
        />
      )}

      {singleViewSettingsOpen && (
        <PrinterCardContentSettingsModal
          initialSettings={singlePrinterCardContentSettings}
          defaultSettings={DEFAULT_SINGLE_PRINTER_CARD_CONTENT_SETTINGS}
          onClose={() => setSingleViewSettingsOpen(false)}
          onSave={(settings) => {
            setSinglePrinterCardContentSettings(settings)
            setSingleViewSettingsOpen(false)
          }}
        />
      )}

      {pickerForPrinter && (
        <LibraryPickerModal
          printerName={pickerForPrinter.name}
          printerModel={pickerForPrinter.model}
          canSlice={canUploadLibrary}
          onClose={() => setPickerForPrinter(null)}
          onPick={(file) => {
            // Keep the picker mounted underneath so "Back" from the slice/print setup
            // returns to file selection (matching the sliced-file branch below).
            if (isUnslicedThreeMfFile(file)) {
              setSliceTarget({ file, preferredPrinterId: pickerForPrinter.id })
              return
            }
            setPrintTarget({ file, printerId: pickerForPrinter.id })
          }}
        />
      )}

      {printTarget && (
        <PrintModal
          file={printTarget.file}
          printers={printersQuery.data?.printers ?? []}
          defaultPrinterId={printTarget.printerId}
          lockPrinterSelection={Boolean(printTarget.printerId)}
          defaultPlate={printTarget.defaultPlate}
          defaultBedLevel={printTarget.defaultBedLevel}
          defaultAmsMapping={printTarget.defaultAmsMapping}
          submitPrint={printTarget.submitPrint}
          onSubmitted={() => {
            void queryClient.invalidateQueries({ queryKey: ['jobs'] })
          }}
          onClose={closePrintFlow}
          onBack={pickerForPrinter || pageLibraryPickerOpen ? goBackFromPrintFlow : undefined}
        />
      )}

      {localFileForPrinter && (
        <LocalFilePrintGate
          demoMode={demoMode}
          printer={localFileForPrinter}
          onCancel={() => setLocalFileForPrinter(null)}
          onUploaded={(file) => {
            setPrintTarget({ file, printerId: localFileForPrinter.id })
            setLocalFileForPrinter(null)
          }}
        />
      )}

      {pageLibraryPickerOpen && (
        <LibraryPickerModal
          canSlice={canUploadLibrary}
          onClose={() => setPageLibraryPickerOpen(false)}
          onPick={(file) => {
            // Keep the picker mounted underneath so "Back" from the slice/print setup
            // returns to file selection (matching the sliced-file branch below).
            if (isUnslicedThreeMfFile(file)) {
              setSliceTarget({ file, preferredPrinterId: '' })
              return
            }
            setPrintTarget({ file, printerId: '' })
          }}
        />
      )}

      {sliceTarget && (
        <SliceFileModal
          // Re-mount per file: the dialog's per-file state (materials, one-shot default
          // seeding) must not survive a target swap. See LibraryView's mount.
          key={sliceTarget.file.id}
          file={sliceTarget.file}
          printers={printersQuery.data?.printers ?? []}
          printerStatuses={status ?? {}}
          capabilities={slicingCapabilitiesQuery.data ?? null}
          capabilitiesLoading={slicingCapabilitiesQuery.isLoading && !slicingCapabilitiesQuery.data}
          capabilitiesError={slicingCapabilitiesQuery.error instanceof Error ? slicingCapabilitiesQuery.error.message : null}
          submitting={startSlicingJob.isPending}
          submitAction={startSlicingJob.variables?.action ?? null}
          submitError={startSlicingJob.error instanceof Error ? startSlicingJob.error.message : null}
          flow="print"
          preferredPrinterId={sliceTarget.preferredPrinterId || undefined}
          // Back returns to the still-open library picker; Cancel abandons the whole flow.
          onBack={() => setSliceTarget(null)}
          onClose={closePrintFlow}
          onSubmit={(input, action) => startSlicingJob.mutate({
            file: sliceTarget.file,
            preferredPrinterId: sliceTarget.preferredPrinterId,
            action,
            ...input
          })}
        />
      )}

      {sliceThenPrintTarget && (
        <SliceThenPrintModal
          sourceFile={sliceThenPrintTarget.sourceFile}
          jobId={sliceThenPrintTarget.jobId}
          preferredPrinterId={sliceThenPrintTarget.preferredPrinterId || undefined}
          lockPrinterSelection={Boolean(sliceThenPrintTarget.preferredPrinterId)}
          printers={printersQuery.data?.printers ?? []}
          // Back returns to the still-open slice settings; Cancel abandons the whole flow.
          onBack={() => setSliceThenPrintTarget(null)}
          onClose={closePrintFlow}
        />
      )}

      <ConfirmActionDialog
        open={deleteHistoryJobTarget != null}
        title="Delete history entry?"
        description={deleteHistoryJobTarget ? `Delete "${deleteHistoryJobTarget.jobName}" from print history? This also removes any saved cover and snapshot images for this job.` : ''}
        confirmLabel="Delete history entry"
        pending={deleteHistoryJob.isPending && deleteHistoryJob.variables === deleteHistoryJobTarget?.id}
        onClose={() => setDeleteHistoryJobTarget(null)}
        onConfirm={() => {
          if (!deleteHistoryJobTarget) return
          deleteHistoryJob.mutate(deleteHistoryJobTarget.id, {
            onSettled: () => setDeleteHistoryJobTarget(null)
          })
        }}
      />

      <ConfirmActionDialog
        open={deletePrinterViewTarget != null}
        title="Delete saved view?"
        description={deletePrinterViewTarget ? `Delete the saved printer view "${deletePrinterViewTarget.name}"? This only removes the saved layout and filters.` : ''}
        confirmLabel="Delete view"
        pending={deletePrinterView.isPending && deletePrinterView.variables === deletePrinterViewTarget?.id}
        onClose={() => setDeletePrinterViewTarget(null)}
        onConfirm={() => {
          if (!deletePrinterViewTarget) return
          deletePrinterView.mutate(deletePrinterViewTarget.id, {
            onSettled: () => setDeletePrinterViewTarget(null)
          })
        }}
      />
    </Stack>
  )
}
