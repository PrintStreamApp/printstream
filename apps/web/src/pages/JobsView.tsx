import { Box, Button, Card, CardContent, Chip, FormControl, ListItemDecorator, MenuItem, Select, Stack, Typography } from '@mui/joy'
import ContentCutRoundedIcon from '@mui/icons-material/ContentCutRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import ReplayRoundedIcon from '@mui/icons-material/ReplayRounded'
import { useCallback, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CAMERA_VIEW_PERMISSION,
  LIBRARY_UPLOAD_PERMISSION,
  JOBS_DELETE_PERMISSION,
  JOBS_VIEW_PERMISSION,
  PRINTERS_CONTROL_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION,
  classifyLibraryFileKind,
  deriveJobHistoryFields,
  extractErrorMessage,
  formatBytes,
  getPrinterDisplayCapabilities,
  isDirectPrintableFileName,
  type JobHistoryResponse,
  type LibraryFile,
  type Permission,
  type PrintDispatchJob,
  type PrintJob,
  type Printer,
  type SlicingJob,
  type PrinterStatus
} from '@printstream/shared'
import { useNavigate, useParams } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { ConfirmActionDialog } from '../components/ConfirmActionDialog'
import { NoConnectedBridgesEmptyState } from '../components/NoConnectedBridgesEmptyState'
import { PaginatedSection } from '../components/PaginationFooter'
import { PrinterJobProgressBlock } from '../components/PrinterJobProgressBlock'
import { ProgressBar } from '../components/ProgressBar'
import { printerJobProgressSx } from '../components/printerJobProgressStyles'
import {
  dispatchProgressColor,
  dispatchProgressFill,
  dispatchProgressTrack,
  progressBarColor,
  progressBarFill,
  progressBarTrack,
  secondaryStageTextColor,
  stageLabelColor
} from '../components/printerJobProgressTone'
import { PrintJobHistoryCard, PrinterRouteButton, ProjectFilamentChipRow } from '../components/PrintJobHistoryCard'
import { PrinterJobMediaStrip } from '../components/PrinterJobMediaStrip'
import { type DirectorySortDirection, type DirectoryViewMode } from '../components/DirectoryControls'
import { DirectoryPrimaryToolbar } from '../components/DirectoryToolbar'
import { MultiSelectOption } from '../components/MultiSelectOption'
import { PageSectionHeading, pageSectionStackSpacing } from '../components/dashboard/PageSectionHeading'
import { SectionNav, type SectionNavEntry } from '../components/dashboard/SectionNav'
import { sectionScrollMarginTop } from '../components/dashboard/SectionNav.constants'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { usePersistentState } from '../hooks/usePersistentState'
import { useMobileViewport } from '../components/useMobileViewport'
import { apiFetch } from '../lib/apiClient'
import { useAuthBootstrapQuery } from '../lib/authQuery'
import { buildApiUrl } from '../lib/apiUrl'
import { formatLibraryFileName } from '../lib/libraryDisplay'
import { formatPrinterJobDisplayName } from '../lib/printerJobName'
import { buildPrintPauseMarkerView } from '../lib/printPauseMarkers'
import { formatSecondaryStageLabel } from '../lib/printerProgressSummary'
import { capitalize } from '../lib/printersViewHelpers'
import {
  formatSlicingMetadataDisplay,
  formatSlicingProgress,
  getLatestSlicingProgressFrame,
  getSlicingJobStatusLabel,
  isActiveSlicingJob,
  slicingStatusColor
} from '../lib/slicingJobPresentation'
import { selectDispatchQueueWithPrintJobs } from '../lib/trackedPrintJobs'
import { formatDateTime, formatEtaFromNow, formatMinutesDuration } from '../lib/time'
import { toast } from '../lib/toast'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../lib/workspaceScope'
import { buildWorkspacePath } from '../lib/workspaceRoute'
import { useBufferedCoverImage } from '../hooks/useBufferedCoverImage'
import { usePrintDispatchJobs } from '../hooks/usePrintDispatchJobs'
import { SlicingEngineLog } from '../components/SlicingEngineLog'
import { useRetrySlicingJob } from '../hooks/useRetrySlicingJob'
import { useSlicingJobs } from '../hooks/useSlicingJobs'
import { PluginSlot } from '../plugin/PluginSlot'
import { PrintModal } from '../components/library/PrintModal'
import { SliceThenPrintFlow } from '../components/library/SliceThenPrintFlow'
import { SplitButton } from '../components/SplitButton'
import { ListSkeleton } from '../components/ListSkeleton'

interface LiveJob {
  jobId: string
  printerId: string
  printerName: string
  printerModel: Printer['model'] | null
  jobName: string
  projectFilamentChips: PrintJob['projectFilamentChips']
  /**
   * Fallback pause markers from the tracked job's dispatched file, for printers that report
   * none themselves. Null for a print nobody started from here, which has no tracked row.
   */
  pauseSchedule: PrintJob['pauseSchedule']
  startedAt: string | null
  stage: PrinterStatus['stage']
  progressPercent: number | null
  remainingMinutes: number | null
  online: boolean
  status: PrinterStatus | null
}

const EMPTY_PRINTERS: Printer[] = []
const DISPATCHED_START_WARNING_TIMEOUT_MS = 60_000
const HISTORY_PAGE_SIZE_OPTIONS = [10, 25, 50] as const
const HISTORY_RESULTS: PrintJob['result'][] = ['success', 'failed', 'cancelled', 'unknown']
const HISTORY_SORT_OPTIONS = [
  { value: 'ended', label: 'Ended' },
  { value: 'started', label: 'Started' }
] as const
const HISTORY_VIEW_MODE_KEY = 'printstream.jobs.history.viewMode'
const HISTORY_SORT_KEY = 'printstream.jobs.history.sort'
const HISTORY_SORT_DIR_KEY = 'printstream.jobs.history.sortDir'
const HISTORY_RESULT_FILTER_KEY = 'printstream.jobs.history.resultFilter'
const HISTORY_PRINTER_FILTER_KEY = 'printstream.jobs.history.printerFilter'
const HISTORY_PAGE_SIZE_KEY = 'printstream.jobs.history.pageSize'

type HistorySortValue = (typeof HISTORY_SORT_OPTIONS)[number]['value']

const HISTORY_SORT_VALUES = new Set<string>(HISTORY_SORT_OPTIONS.map((option) => option.value))
const HISTORY_RESULT_VALUES = new Set<string>(HISTORY_RESULTS)

// Coerce stored (or corrupt) preference blobs back into valid values, falling
// back per field to the same defaults the directory controls start with.
function sanitizeHistorySort(value: unknown): HistorySortValue {
  return HISTORY_SORT_VALUES.has(value as string) ? (value as HistorySortValue) : 'ended'
}

function sanitizeHistorySortDirection(value: unknown): DirectorySortDirection {
  return value === 'asc' ? 'asc' : 'desc'
}

function sanitizeHistoryResults(value: unknown): PrintJob['result'][] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is PrintJob['result'] => HISTORY_RESULT_VALUES.has(entry as string))
}

function sanitizeHistoryPrinterIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function sanitizeHistoryPageSize(value: unknown): number {
  return (HISTORY_PAGE_SIZE_OPTIONS as readonly number[]).includes(value as number)
    ? (value as number)
    : HISTORY_PAGE_SIZE_OPTIONS[0]
}

const EMPTY_PRINTER_OPTIONS: JobHistoryResponse['printerOptions'] = []

/** The server-paged history request, every value here is also part of the query key. */
function buildJobHistoryUrl(input: {
  page: number
  pageSize: number
  search: string
  printerIds: ReadonlyArray<string>
  results: ReadonlyArray<PrintJob['result']>
  sortBy: HistorySortValue
  sortDirection: DirectorySortDirection
}): string {
  const params = new URLSearchParams()
  params.set('page', String(input.page))
  params.set('pageSize', String(input.pageSize))
  if (input.search) params.set('search', input.search)
  if (input.printerIds.length > 0) params.set('printerIds', input.printerIds.join(','))
  if (input.results.length > 0) params.set('results', input.results.join(','))
  params.set('sortBy', input.sortBy)
  params.set('sortDirection', input.sortDirection)
  return `/api/jobs/history?${params.toString()}`
}

function parseHistoryViewMode(raw: string): DirectoryViewMode | null {
  return raw === 'list' || raw === 'icon' ? raw : null
}

function formatHistoryResultsSummary(results: ReadonlyArray<PrintJob['result']>): string {
  if (results.length === 0) return 'No results'
  if (results.length === HISTORY_RESULTS.length) return 'All results'
  if (results.length === 1) return results[0] ? historyResultLabel(results[0]) : '1 result'
  return `${results.length} results`
}

function historyResultLabel(result: PrintJob['result']): string {
  switch (result) {
    case 'success':
      return 'Success'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'unknown':
      return 'Unknown'
  }
}

export function JobsView() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const isMobileViewport = useMobileViewport()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const workspacePath = (path: string) => workspaceSlug ? buildWorkspacePath(workspaceSlug, path) : path
  const [reprintJob, setReprintJob] = useState<PrintJob | null>(null)
  // "Slice again": re-slice the project a finished print was produced from, rather than
  // re-dispatching the identical G-code. Held as the whole job so the flow can seed the
  // plate, engine and printer the original run used.
  const [resliceJob, setResliceJob] = useState<PrintJob | null>(null)
  const [deleteHistoryJobTarget, setDeleteHistoryJobTarget] = useState<PrintJob | null>(null)
  const [deleteSlicingHistoryJobTarget, setDeleteSlicingHistoryJobTarget] = useState<SlicingJob | null>(null)
  const [restartingJobId, setRestartingJobId] = useState<string | null>(null)
  const [historySearch, setHistorySearch] = useState('')
  const deferredHistorySearch = useDeferredValue(historySearch)
  const [historyPrinterIds, setHistoryPrinterIds] = usePersistentState<string[]>(HISTORY_PRINTER_FILTER_KEY, [], sanitizeHistoryPrinterIds)
  const [historyResults, setHistoryResults] = usePersistentState<PrintJob['result'][]>(HISTORY_RESULT_FILTER_KEY, [], sanitizeHistoryResults)
  const [historySortValue, setHistorySortValue] = usePersistentState<HistorySortValue>(HISTORY_SORT_KEY, 'ended', sanitizeHistorySort)
  const [historySortDirection, setHistorySortDirection] = usePersistentState<DirectorySortDirection>(HISTORY_SORT_DIR_KEY, 'desc', sanitizeHistorySortDirection)
  const [historyPage, setHistoryPage] = useState(0)
  const [historyPageSize, setHistoryPageSize] = usePersistentState<number>(HISTORY_PAGE_SIZE_KEY, HISTORY_PAGE_SIZE_OPTIONS[0], sanitizeHistoryPageSize)
  const [historyViewMode, setHistoryViewMode] = useLocalStorageState<DirectoryViewMode>(
    HISTORY_VIEW_MODE_KEY,
    'list',
    parseHistoryViewMode,
    String
  )
  const authBootstrapQuery = useAuthBootstrapQuery()
  const authEnabled = authBootstrapQuery.data?.authEnabled ?? false
  const permissions = authBootstrapQuery.data?.permissions ?? []
  const canOpenBridgesSettings = authBootstrapQuery.data?.capabilities.canManageSettings ?? false
  const showNoConnectedBridgesPlaceholder = authBootstrapQuery.isSuccess
    && authBootstrapQuery.data?.workspace != null
    && !authBootstrapQuery.data.workspaceHasConnectedBridges
  const hasPermission = (permission: Permission) => !authEnabled || permissions.includes(permission)
  const canDeleteJobs = hasPermission(JOBS_DELETE_PERMISSION)
  const canViewJobs = hasPermission(JOBS_VIEW_PERMISSION)
  const canViewPrinters = hasPermission(PRINTERS_VIEW_PERMISSION)
  const canDispatchPrints = hasPermission(PRINTS_DISPATCH_PERMISSION)
  const canControlPrinters = hasPermission(PRINTERS_CONTROL_PERMISSION)
  const canViewCamera = hasPermission(CAMERA_VIEW_PERMISSION)
  const canCancelSlicing = hasPermission(LIBRARY_UPLOAD_PERMISSION)
  const canSliceFiles = hasPermission(LIBRARY_UPLOAD_PERMISSION)
  const workspaceScopeKey = readCurrentWorkspaceScopeKey()
  const jobsQuery = useQuery({
    queryKey: ['jobs'],
    queryFn: () => apiFetch<{ jobs: PrintJob[] }>('/api/jobs'),
    enabled: canViewJobs && !showNoConnectedBridgesPlaceholder
  })
  const slicingJobsQuery = useSlicingJobs({ enabled: canViewJobs && !showNoConnectedBridgesPlaceholder })
  // The merged print+slicing history, paged/filtered/sorted SERVER-side (GET /api/jobs/history:
  // the shared selectJobHistoryPage owns the semantics). Every control that changes what a page
  // contains is part of the key; the page index itself is requested 1-based.
  const historyQuery = useQuery({
    queryKey: ['job-history', workspaceScopeKey, {
      page: historyPage + 1,
      pageSize: historyPageSize,
      search: deferredHistorySearch.trim(),
      printerIds: historyPrinterIds,
      results: historyResults,
      sortBy: historySortValue,
      sortDirection: historySortDirection
    }],
    queryFn: ({ signal }) => apiFetch<JobHistoryResponse>(buildJobHistoryUrl({
      page: historyPage + 1,
      pageSize: historyPageSize,
      search: deferredHistorySearch.trim(),
      printerIds: historyPrinterIds,
      results: historyResults,
      sortBy: historySortValue,
      sortDirection: historySortDirection
    }), { signal }),
    // Keep the previous page on screen while the next one loads, so paging/filtering never
    // flashes the list away (the workspaces directory sets the precedent).
    placeholderData: keepPreviousData,
    enabled: canViewJobs && !showNoConnectedBridgesPlaceholder
  })
  const dispatchQuery = usePrintDispatchJobs({ enabled: canViewJobs && !showNoConnectedBridgesPlaceholder })
  const printersQuery = useQuery({
    queryKey: ['printers'],
    queryFn: () => apiFetch<{ printers: Printer[] }>('/api/printers'),
    enabled: canViewPrinters && !showNoConnectedBridgesPlaceholder
  })
  const statusQuery = useQuery<Record<string, PrinterStatus>>({
    queryKey: workspaceQueryKeys.printerStatus(workspaceScopeKey),
    queryFn: () => Promise.resolve({}),
    initialData: {},
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })
  const cancelDispatch = useMutation({
    mutationFn: (job: PrintDispatchJob) => apiFetch<{ job: PrintDispatchJob }>(`/api/print-dispatch/${job.id}/cancel`, { method: 'POST' }),
    onSuccess: (_data, job) => {
      if (job.status === 'failed') {
        toast.success('Failed dispatch moved to history')
      }
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['print-dispatch'] }),
        queryClient.invalidateQueries({ queryKey: ['jobs'] })
      ])
    }
  })
  const retryDispatch = useMutation({
    mutationFn: (id: string) => apiFetch<{ job: PrintDispatchJob }>(`/api/print-dispatch/${id}/retry`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['print-dispatch'] })
    }
  })
  const restartJob = useMutation({
    mutationFn: async (input: { jobId: string; body?: Record<string, unknown> }) => {
      setRestartingJobId(input.jobId)
      return await apiFetch<void | { job: PrintDispatchJob }>(`/api/jobs/${input.jobId}/reprint`, {
        method: 'POST',
        ...(input.body ? { body: input.body } : {})
      })
    },
    onSettled: () => {
      setRestartingJobId(null)
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
      void queryClient.invalidateQueries({ queryKey: ['job-history'] })
    },
    onError: (error) => {
      toast.error(extractErrorMessage(error))
    }
  })
  // Re-runs a failed slice in place (same job id), so the history card it is rendered on updates
  // itself rather than being joined by a second entry. Shared with the toast stack and the slice
  // dialogs so all three offer the same act (`hooks/useRetrySlicingJob.ts`).
  const retrySlicingJob = useRetrySlicingJob({
    onRetried: () => {
      toast.success('Slicing again')
      void queryClient.invalidateQueries({ queryKey: ['job-history'] })
    }
  })
  const deleteSlicingHistoryJob = useMutation({
    mutationFn: (jobId: string) => apiFetch<void>(`/api/slicing/jobs/${jobId}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Slicing history entry deleted')
      void queryClient.invalidateQueries({ queryKey: ['slicing-jobs'] })
      void queryClient.invalidateQueries({ queryKey: ['job-history'] })
    },
    onError: (error) => {
      toast.error(extractErrorMessage(error))
    }
  })

  const persistedJobs = useMemo(() => jobsQuery.data?.jobs ?? [], [jobsQuery.data?.jobs])
  const slicingJobs = useMemo(() => slicingJobsQuery.data?.jobs ?? [], [slicingJobsQuery.data?.jobs])
  const dispatchQueue = useMemo(
    () => selectDispatchQueueWithPrintJobs(persistedJobs, dispatchQuery.data?.jobs ?? []),
    [dispatchQuery.data?.jobs, persistedJobs]
  )
  const unfinishedJobs = useMemo(
    () => persistedJobs
      .filter((job) => !job.finishedAt)
      .slice()
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
    [persistedJobs]
  )
  const activeSlicingJobs = useMemo(
    () => slicingJobs
      .filter(isActiveSlicingJob)
      .slice()
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)),
    [slicingJobs]
  )
  const printers = printersQuery.data?.printers ?? EMPTY_PRINTERS
  const printersById = useMemo(() => new Map(printers.map((printer) => [printer.id, printer])), [printers])
  const printerNames = useMemo(() => new Map(printers.map((printer) => [printer.id, printer.name])), [printers])
  // Facet from the server, derived over the WHOLE history, a filtered page must not shrink it.
  const historyPrinterOptions = historyQuery.data?.printerOptions ?? EMPTY_PRINTER_OPTIONS
  // Drop any selected printer that no longer appears in the history options.
  useEffect(() => {
    const ids = new Set(historyPrinterOptions.map((printer) => printer.id))
    setHistoryPrinterIds((current) => {
      const next = current.filter((id) => ids.has(id))
      return next.length === current.length ? current : next
    })
  }, [historyPrinterOptions, setHistoryPrinterIds])
  const liveJobs = useMemo<LiveJob[]>(() => {
    const statuses = statusQuery.data ?? {}
    const unfinishedByPrinter = new Map<string, PrintJob>()
    for (const job of unfinishedJobs) {
      if (!unfinishedByPrinter.has(job.printerId)) unfinishedByPrinter.set(job.printerId, job)
    }

    const printerIds = new Set<string>(unfinishedByPrinter.keys())
    for (const status of Object.values(statuses)) {
      if (isVisibleActiveStatus(status)) printerIds.add(status.printerId)
    }

    return Array.from(printerIds)
      .map((printerId) => {
        const persistedJob = unfinishedByPrinter.get(printerId)
        const status = statuses[printerId]
        if (!persistedJob && !status) return null

        return {
          jobId: persistedJob?.id ?? `live:${printerId}`,
          printerId,
          printerName: printerNames.get(printerId) ?? persistedJob?.printerName ?? 'Unknown printer',
          printerModel: printersById.get(printerId)?.model ?? null,
          jobName: status?.jobName ?? persistedJob?.jobName ?? 'Active print',
          projectFilamentChips: persistedJob?.projectFilamentChips ?? [],
          pauseSchedule: persistedJob?.pauseSchedule ?? null,
          startedAt: persistedJob?.startedAt ?? null,
          stage: isVisibleActiveStatus(status) ? status.stage : 'preparing',
          progressPercent: status?.progressPercent ?? persistedJob?.progressPercent ?? null,
          remainingMinutes: status?.remainingMinutes ?? null,
          online: status?.online ?? false,
          status: status ?? null
        }
      })
      .filter((job): job is LiveJob => job != null)
      .sort((a, b) => a.printerName.localeCompare(b.printerName))
  }, [printerNames, printersById, statusQuery.data, unfinishedJobs])
  // The page the server returned (filter/sort/search already applied). The derived fields
  // (identity, result, sort keys) come from the same shared function the server filtered with.
  const historyTotal = historyQuery.data?.total ?? 0
  const historyTotalUnfiltered = historyQuery.data?.totalUnfiltered ?? 0
  const visibleHistoryEntries = useMemo(
    () => (historyQuery.data?.entries ?? []).map((entry) => ({
      entry,
      derived: deriveJobHistoryFields(entry, (id) => printerNames.get(id) ?? null)
    })),
    [historyQuery.data?.entries, printerNames]
  )
  const historyPageCount = Math.max(1, Math.ceil(historyTotal / historyPageSize))
  const safeHistoryPage = Math.min(historyPage, historyPageCount - 1)
  const activeHistoryFilterCount = Number(historyPrinterIds.length > 0) + Number(historyResults.length > 0)
  const effectiveHistoryViewMode: DirectoryViewMode = isMobileViewport ? 'list' : historyViewMode

  // Deleting the last row of the last page (or narrowing filters) can strand the page index past
  // the end; clamp it back so the next request lands on a real page.
  useEffect(() => {
    setHistoryPage((current) => Math.min(current, Math.max(0, historyPageCount - 1)))
  }, [historyPageCount])

  function clearHistoryFilters() {
    setHistoryPrinterIds([])
    setHistoryResults([])
  }

  // Sections contributed by `jobs.sections` slot plugins (e.g. the print queue).
  // A slot component registers its SectionNav entry (and re-registers on count
  // changes) via this callback; the returned cleanup drops the entry when the
  // section unmounts, so the nav stays correct with the plugin disabled.
  const [pluginSections, setPluginSections] = useState<SectionNavEntry[]>([])
  const registerSection = useCallback((entry: SectionNavEntry) => {
    setPluginSections((current) => {
      const index = current.findIndex((existing) => existing.id === entry.id)
      if (index === -1) return [...current, entry]
      const next = [...current]
      next[index] = entry
      return next
    })
    return () => {
      setPluginSections((current) => current.filter((existing) => existing.id !== entry.id))
    }
  }, [])

  const inProgressCount = activeSlicingJobs.length + dispatchQueue.length + liveJobs.length
  const sections: SectionNavEntry[] = [
    ...pluginSections,
    { id: 'active', label: 'Active', desktopLabel: 'In progress', count: inProgressCount },
    { id: 'history', label: 'History', desktopLabel: 'Job history', count: historyTotalUnfiltered }
  ]

  return (
    <Stack spacing={pageSectionStackSpacing}>
      {!showNoConnectedBridgesPlaceholder && <SectionNav aria-label="Jobs sections" sections={sections} mb={0} />}
      <Typography level="h3" startDecorator={<HistoryRoundedIcon />}>Jobs</Typography>
      {authBootstrapQuery.isLoading && <ListSkeleton rows={3} />}
      {authBootstrapQuery.isSuccess && !canViewJobs && (
        <EmptyState
          compact
          icon={<HistoryRoundedIcon />}
          title="Job access required"
          description="Your account can sign in, but it cannot view the jobs dashboard."
        />
      )}
      {authBootstrapQuery.isSuccess && canViewJobs && (
        showNoConnectedBridgesPlaceholder ? (
          <NoConnectedBridgesEmptyState
            title="Connect a bridge to track jobs"
            description="Connect a bridge in Settings to start tracking queued, active, and completed prints here."
            managedTitle="Waiting for your printers"
            managedDescription="Queued, active, and completed prints will appear here once PrintStream connects to your printers."
            canOpenBridgesSettings={canOpenBridgesSettings}
            onOpenBridgesSettings={() => navigate(workspacePath('/settings/bridges'))}
          />
        ) : (
          <>
      {/* Plugin-contributed sections above the core ones: e.g. the print-queue
          plugin's backlog (apps/web/src/plugins/print-queue/QueueSection.tsx).
          Renders nothing when no plugin contributes. */}
      <PluginSlot name="jobs.sections" context={{ registerSection }} />
      <Box id="active" sx={{ scrollMarginTop: sectionScrollMarginTop }}>
        <Stack spacing={1}>
          <PageSectionHeading
            icon={<PrintRoundedIcon />}
            title="In progress"
            description="Slicing, uploading, and printing right now."
            count={inProgressCount}
          />
          {inProgressCount === 0 && (
            <EmptyState
              compact
              icon={<PrintRoundedIcon />}
              title="No jobs in progress"
              description="Queued slicing jobs, print dispatches, and live prints will appear here while work is on its way to or running on a printer."
            />
          )}
          {activeSlicingJobs.map((job) => (
            <ActiveSlicingJobCard
              key={job.id}
              job={job}
              canCancel={canCancelSlicing}
              onCancel={async (target) => {
                await apiFetch(`/api/slicing/jobs/${target.id}/cancel`, { method: 'POST' })
                await queryClient.invalidateQueries({ queryKey: ['slicing-jobs'] })
              }}
            />
          ))}
          {dispatchQueue.map(({ dispatchJob, printJob }) => {
            const cardJobId = printJob?.id ?? dispatchJob.printJobId
            const printerId = printJob?.printerId ?? dispatchJob.printerId
            const printerName = printJob?.printerName ?? dispatchJob.printerName
            const fileId = printJob?.fileId ?? dispatchJob.fileId
            const fileName = printJob?.fileName ?? dispatchJob.fileName
            const plate = printJob?.plate ?? dispatchJob.plate
            const cancellable = dispatchJob.status === 'queued' || dispatchJob.status === 'uploading' || dispatchJob.status === 'failed'
            const retryable = dispatchJob.status === 'failed'
            const displayName = formatLibraryFileName(fileName)
            const plateLabel = formatPlateLabel(plate, dispatchJob.plateName)
            const uploadPercent = dispatchJob.uploadPercent ?? null
            const showUploadProgress = dispatchJob.status === 'uploading'
            const projectFilamentChips = printJob?.projectFilamentChips.length
              ? printJob.projectFilamentChips
              : dispatchJob.projectFilamentChips
            return (
              <Card key={`dispatch:${cardJobId}`} variant="outlined">
                <CardContent>
                  <Stack spacing={1}>
                    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
                      <Stack sx={{ minWidth: 0, flex: 1 }}>
                        <Typography level="title-md" sx={{ overflowWrap: 'anywhere' }}>
                          <PrinterRouteButton printerId={printerId} label={printerName} />
                        </Typography>
                      </Stack>
                      <Stack
                        direction="row"
                        spacing={1}
                        alignItems="center"
                        sx={{
                          flexShrink: 0,
                          flexWrap: 'wrap',
                          justifyContent: { xs: 'flex-start', sm: 'flex-end' },
                          rowGap: 0.5,
                          columnGap: 1
                        }}
                      >
                        <Chip size="sm" color={dispatchStatusColor(dispatchJob.status)} variant="soft">{statusLabel(dispatchJob.status)}</Chip>
                        {canDispatchPrints && cancellable && (
                          <Button
                            size="sm"
                            variant="plain"
                            color="danger"
                            loading={cancelDispatch.isPending && cancelDispatch.variables?.id === dispatchJob.id}
                            onClick={() => cancelDispatch.mutate(dispatchJob)}
                          >
                            Cancel
                          </Button>
                        )}
                        {canDispatchPrints && retryable && (
                          <Button
                            size="sm"
                            variant="plain"
                            color="primary"
                            loading={retryDispatch.isPending && retryDispatch.variables === dispatchJob.id}
                            onClick={() => retryDispatch.mutate(dispatchJob.id)}
                          >
                            Retry
                          </Button>
                        )}
                      </Stack>
                    </Stack>

                    <PrinterJobMediaStrip
                      cover={fileId ? {
                        title: displayName,
                        src: buildApiUrl(`/api/library/${fileId}/thumbnail?plate=${plate}`),
                        loaded: true,
                        failed: false,
                        loading: false
                      } : null}
                      camera={null}
                    >
                      <>
                        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={0.75}>
                          <Typography level="body-sm" sx={{ minWidth: 0, flex: 1, whiteSpace: { xs: 'normal', sm: 'nowrap' }, overflowWrap: 'anywhere' }}>
                            {displayName}
                          </Typography>
                          {showUploadProgress && uploadPercent != null && (
                            <Typography level="body-xs" sx={{ flexShrink: 0 }}>
                              {Math.round(uploadPercent)}%
                            </Typography>
                          )}
                        </Stack>
                        <ProgressBar
                          value={showUploadProgress ? uploadPercent : null}
                          color={dispatchProgressColor(dispatchJob.status)}
                          sx={{
                            ...printerJobProgressSx({
                              value: showUploadProgress ? uploadPercent : null,
                              fillColor: dispatchProgressFill(dispatchJob.status),
                              trackColor: dispatchProgressTrack(dispatchJob.status)
                            }),
                            my: 0.5
                          }}
                        />
                        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                          <Typography level="body-xs" textColor="text.tertiary" sx={{ minWidth: 0, flex: 1, whiteSpace: { xs: 'normal', sm: 'nowrap' }, overflowWrap: 'anywhere' }}>
                            {plateLabel} - {formatDispatchProgress(dispatchJob)}
                          </Typography>
                        </Stack>
                        <ProjectFilamentChipRow chips={projectFilamentChips} />
                        {dispatchJob.error && (
                          <Typography level="body-xs" color="danger" sx={{ overflowWrap: 'anywhere' }}>
                            {dispatchJob.error}
                          </Typography>
                        )}
                      </>
                    </PrinterJobMediaStrip>
                  </Stack>
                </CardContent>
              </Card>
            )
          })}
          {liveJobs.map((job) => <ActiveJobCard key={job.jobId} job={job} canViewCamera={canViewCamera} workspaceSlug={workspaceSlug} />)}
        </Stack>
      </Box>

      <Box id="history" sx={{ scrollMarginTop: sectionScrollMarginTop }}>
        <Stack spacing={1}>
          <PageSectionHeading
            icon={<HistoryRoundedIcon />}
            title="Job history"
            description="Finished, failed, and cancelled jobs."
            count={historyTotalUnfiltered}
          />
          {historyQuery.isLoading && <ListSkeleton rows={3} />}
          {historyQuery.isSuccess && historyTotalUnfiltered === 0 && (
            <EmptyState
              compact
              icon={<HistoryRoundedIcon />}
              title="No job history yet"
              description="Completed and failed slicing jobs and prints will show up here once work has been started from PrintStream."
            />
          )}
          {historyTotalUnfiltered > 0 && (
            <DirectoryPrimaryToolbar
                pinStorageKey="jobs.history"
                searchValue={historySearch}
                onSearchChange={(value) => {
                  setHistoryPage(0)
                  setHistorySearch(value)
                }}
                searchPlaceholder="Search file, printer, result, slicer, or time"
                searchAriaLabel="Search job history"
                filters={{
                  activeCount: activeHistoryFilterCount,
                  onClear: clearHistoryFilters,
                  clearDisabled: activeHistoryFilterCount === 0,
                  children: (
                    <>
                      <FormControl>
                        <Typography level="body-sm" textColor="text.tertiary">Printer</Typography>
                        <Select
                          size="sm"
                          multiple
                          value={historyPrinterIds}
                          onChange={(_event, value) => {
                            setHistoryPage(0)
                            setHistoryPrinterIds(value ?? [])
                          }}
                          placeholder="All printers"
                          renderValue={() => historyPrinterIds.length === 0
                            ? null
                            : historyPrinterIds.length === 1
                              ? (historyPrinterOptions.find((printer) => printer.id === historyPrinterIds[0])?.name ?? '1 printer')
                              : `${historyPrinterIds.length} printers`}
                          slotProps={{ listbox: { disablePortal: true, sx: { maxHeight: 280 } } }}
                        >
                          {historyPrinterOptions.map((printer) => (
                            <MultiSelectOption key={printer.id} value={printer.id} selected={historyPrinterIds.includes(printer.id)}>{printer.name}</MultiSelectOption>
                          ))}
                        </Select>
                      </FormControl>
                      <FormControl>
                        <Typography level="body-sm" textColor="text.tertiary">Results</Typography>
                        <Select
                          size="sm"
                          multiple
                          value={historyResults}
                          onChange={(_event, value) => {
                            setHistoryPage(0)
                            setHistoryResults(value ?? [])
                          }}
                          placeholder="All results"
                          renderValue={() => historyResults.length === 0
                            ? null
                            : formatHistoryResultsSummary(historyResults)}
                          slotProps={{ listbox: { disablePortal: true, sx: { maxHeight: 280 } } }}
                        >
                          {HISTORY_RESULTS.map((result) => (
                            <MultiSelectOption key={result} value={result} selected={historyResults.includes(result)}>{historyResultLabel(result)}</MultiSelectOption>
                          ))}
                        </Select>
                      </FormControl>
                    </>
                  )
                }}
                pageSizeValue={historyPageSize}
                pageSizeOptions={HISTORY_PAGE_SIZE_OPTIONS.map((value) => ({ value, label: `${value} rows per page` }))}
                onPageSizeChange={(value) => {
                  setHistoryPage(0)
                  setHistoryPageSize(value)
                }}
                pageSizeAriaLabel="History rows per page"
                pageSizeRenderValue={(value) => `${value} per page`}
                sortValue={historySortValue}
                sortOptions={HISTORY_SORT_OPTIONS}
                onSortValueChange={(value) => {
                  setHistoryPage(0)
                  setHistorySortValue(value as HistorySortValue)
                }}
                sortDirection={historySortDirection}
                onSortDirectionChange={(direction) => {
                  setHistoryPage(0)
                  setHistorySortDirection(direction)
                }}
                sortAriaLabel="Sort print history by"
                viewMode={effectiveHistoryViewMode}
                onViewModeChange={setHistoryViewMode}
                disableIconModeOnMobile
              />
          )}
          {historyTotalUnfiltered > 0 && historyTotal === 0 && (
            <Typography level="body-sm" textColor="text.tertiary">
              No job history matches the current search or filters.
            </Typography>
          )}
          {historyTotal > 0 && (
            <PaginatedSection
              showingLabel={`Showing ${safeHistoryPage * historyPageSize + 1}-${Math.min(historyTotal, (safeHistoryPage + 1) * historyPageSize)} of ${historyTotal}`}
              previousDisabled={safeHistoryPage === 0}
              nextDisabled={safeHistoryPage >= historyPageCount - 1}
              onPrevious={() => setHistoryPage((current) => Math.max(0, current - 1))}
              onNext={() => setHistoryPage((current) => Math.min(historyPageCount - 1, current + 1))}
              spacing={1.5}
            >
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: effectiveHistoryViewMode === 'icon'
                    ? { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }
                    : 'minmax(0, 1fr)',
                  gap: 1.5,
                  alignItems: 'stretch'
                }}
              >
                {visibleHistoryEntries.map(({ entry, derived }) => {
                  if (entry.kind === 'slicing') {
                    const job = entry.slicingJob
                    const deleteAction = canDeleteJobs ? (
                      <Button
                        size="sm"
                        variant="plain"
                        color="danger"
                        startDecorator={<DeleteRoundedIcon />}
                        loading={deleteSlicingHistoryJob.isPending && deleteSlicingHistoryJob.variables === job.id}
                        onClick={() => setDeleteSlicingHistoryJobTarget(job)}
                      >
                        Delete
                      </Button>
                    ) : undefined
                    // Where a failed slice ends up once its toast is gone, so it carries the same
                    // retry. Ordered by consequence: re-run first, destructive last.
                    const retryAction = canSliceFiles && job.status === 'failed' ? (
                      <Button
                        size="sm"
                        variant="plain"
                        color="primary"
                        startDecorator={<RefreshRoundedIcon />}
                        loading={retrySlicingJob.isPending && retrySlicingJob.variables === job.id}
                        onClick={() => retrySlicingJob.mutate(job.id)}
                      >
                        Retry
                      </Button>
                    ) : undefined
                    return (
                      <SlicingJobHistoryCard
                        key={derived.id}
                        job={job}
                        printerName={derived.printerId ? (printerNames.get(derived.printerId) ?? derived.printerId) : null}
                        action={retryAction || deleteAction ? (
                          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                            {retryAction}
                            {deleteAction}
                          </Stack>
                        ) : undefined}
                      />
                    )
                  }

                  const job = entry.printJob
                  const canRestartFile = Boolean(
                    canDispatchPrints
                    && canViewPrinters
                    && job.finishedAt
                    && job.jobKind === 'file'
                    && job.fileId
                    && isDirectPrintableFileName(job.fileName || job.jobName || '')
                  )
                  const canRestartCalibration = Boolean(
                    canControlPrinters
                    && job.finishedAt
                    && job.jobKind === 'calibration'
                    && job.calibrationOption != null
                  )
                  // Offered only when the project this print was sliced from was preserved
                  // and still exists; re-slicing needs the same permission as slicing anything.
                  const canReslice = Boolean(
                    canSliceFiles
                    && canDispatchPrints
                    && canViewPrinters
                    && job.finishedAt
                    && job.sourceProjectFileId
                  )
                  const restartAction = canRestartFile && canReslice ? (
                    <SplitButton
                      size="sm"
                      variant="soft"
                      color="neutral"
                      label="Reprint"
                      ariaLabel={`Reprint ${job.jobName}`}
                      startDecorator={<ReplayRoundedIcon />}
                      onClick={() => setReprintJob(job)}
                    >
                      <MenuItem onClick={() => setResliceJob(job)}>
                        <ListItemDecorator><ContentCutRoundedIcon /></ListItemDecorator>
                        Slice again
                      </MenuItem>
                    </SplitButton>
                  ) : canRestartFile ? (
                    <Button
                      size="sm"
                      variant="soft"
                      startDecorator={<ReplayRoundedIcon />}
                      onClick={() => setReprintJob(job)}
                    >
                      Reprint
                    </Button>
                  ) : canReslice ? (
                    // The G-code is gone (deleted, or never re-printable) but its project
                    // survives: re-slicing is the only way back to this print, so offer it
                    // on its own rather than hiding it behind an unavailable Reprint.
                    <Button
                      size="sm"
                      variant="soft"
                      startDecorator={<ContentCutRoundedIcon />}
                      onClick={() => setResliceJob(job)}
                    >
                      Slice again
                    </Button>
                  ) : canRestartCalibration ? (
                    <Button
                      size="sm"
                      variant="soft"
                      startDecorator={<ReplayRoundedIcon />}
                      loading={restartJob.isPending && restartingJobId === job.id}
                      onClick={() => restartJob.mutate({ jobId: job.id })}
                    >
                      Reprint
                    </Button>
                  ) : undefined
                  const deleteAction = canDeleteJobs ? (
                    <Button
                      size="sm"
                      variant="plain"
                      color="danger"
                      startDecorator={<DeleteRoundedIcon />}
                      loading={deleteHistoryJob.isPending && deleteHistoryJob.variables === job.id}
                      onClick={() => setDeleteHistoryJobTarget(job)}
                    >
                      Delete
                    </Button>
                  ) : undefined
                  const action = restartAction || deleteAction ? (
                    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                      {restartAction}
                      {deleteAction}
                    </Stack>
                  ) : undefined
                  return <PrintJobHistoryCard key={job.id} job={job} action={action} />
                })}
              </Box>
            </PaginatedSection>
          )}
        </Stack>
      </Box>

      {canDispatchPrints && canViewPrinters && reprintJob && reprintJob.fileId && (
        <PrintModal
          file={jobToLibraryFile(reprintJob)}
          printers={printers}
          defaultPrinterId={reprintJob.printerId}
          defaultPlate={reprintJob.plate ?? 1}
          defaultPrintOptions={reprintJob.printOptions}
          defaultAmsMapping={reprintJob.amsMapping}
          submitPrint={async ({ printerId, body }) => {
            await restartJob.mutateAsync({
              jobId: reprintJob.id,
              body: {
                printerId,
                ...body
              }
            })
          }}
          onClose={() => setReprintJob(null)}
        />
      )}

      {canSliceFiles && canDispatchPrints && canViewPrinters && resliceJob?.sourceProjectFileId && (
        <SliceThenPrintFlow
          fileId={resliceJob.sourceProjectFileId}
          printers={printers}
          preferredPrinterId={resliceJob.printerId}
          // The project was preserved with every plate it had; the print used one of them.
          defaultPlate={resliceJob.plate ?? 1}
          initialSlicerTargetId={resliceJob.sliceSettings?.slicerTargetId}
          flowCopy={{
            title: `Slice ${formatLibraryFileName(resliceJob.sourceProjectFileName ?? resliceJob.jobName)} again`,
            description: 'These are the settings this print was sliced with. Change anything you like, then continue to printer selection.'
          }}
          onClose={() => setResliceJob(null)}
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
        open={deleteSlicingHistoryJobTarget != null}
        title="Delete slicing history entry?"
        description={deleteSlicingHistoryJobTarget
          ? `Delete slicing history for "${formatLibraryFileName(deleteSlicingHistoryJobTarget.outputFileName ?? deleteSlicingHistoryJobTarget.sourceFileName)}"?`
          : ''}
        confirmLabel="Delete history entry"
        pending={deleteSlicingHistoryJob.isPending && deleteSlicingHistoryJob.variables === deleteSlicingHistoryJobTarget?.id}
        onClose={() => setDeleteSlicingHistoryJobTarget(null)}
        onConfirm={() => {
          if (!deleteSlicingHistoryJobTarget) return
          deleteSlicingHistoryJob.mutate(deleteSlicingHistoryJobTarget.id, {
            onSettled: () => setDeleteSlicingHistoryJobTarget(null)
          })
        }}
      />
          </>
        )
      )}
    </Stack>
  )
}

function ActiveSlicingJobCard({
  job,
  canCancel,
  onCancel
}: {
  job: SlicingJob
  canCancel: boolean
  onCancel: (job: SlicingJob) => Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const progressFrame = getLatestSlicingProgressFrame(job)
  const progressPercent = progressFrame?.totalPercent ?? null
  const displayName = formatLibraryFileName(job.outputFileName ?? job.sourceFileName)
  const metadataLabel = formatSlicingMetadataDisplay(job.metadata)

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
            <Stack sx={{ minWidth: 0, flex: 1 }}>
              <Typography level="title-md" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                {displayName}
              </Typography>
              <Typography level="body-sm" textColor="text.tertiary" sx={{ overflowWrap: 'anywhere' }}>
                {job.slicerName ?? 'Server slicer'} - {job.target.mode === 'realPrinter' ? `Printer-targeted slice` : 'Manual profile slice'}
              </Typography>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Chip size="sm" color={slicingStatusColor(job.status)} variant="soft">{getSlicingJobStatusLabel(job)}</Chip>
              {canCancel && (
                <Button
                  size="sm"
                  variant="plain"
                  color="danger"
                  loading={pending}
                  onClick={async () => {
                    setPending(true)
                    try {
                      await onCancel(job)
                    } finally {
                      setPending(false)
                    }
                  }}
                >
                  Cancel
                </Button>
              )}
            </Stack>
          </Stack>

          <PrinterJobMediaStrip
            cover={{
              title: displayName,
              src: buildApiUrl(`/api/slicing/jobs/${job.id}/thumbnail`),
              loaded: true,
              failed: false,
              loading: false
            }}
            camera={null}
          >
            <>
              <PrinterJobProgressBlock
                header={(
                  <Typography level="body-sm" sx={{ minWidth: 0, flex: 1, whiteSpace: { xs: 'normal', sm: 'nowrap' }, overflowWrap: 'anywhere' }}>
                    {displayName}
                  </Typography>
                )}
                headerAside={progressPercent != null ? (
                  <Typography level="body-xs" sx={{ flexShrink: 0 }}>
                    {Math.round(progressPercent)}%
                  </Typography>
                ) : undefined}
                value={progressPercent}
                color={slicingStatusColor(job.status)}
                footer={(
                  <Typography level="body-xs" textColor="text.tertiary" sx={{ minWidth: 0, whiteSpace: { xs: 'normal', sm: 'nowrap' }, overflowWrap: 'anywhere' }}>
                    {formatSlicingProgress(job, progressFrame)}
                  </Typography>
                )}
                afterProgress={metadataLabel ? (
                  <Typography level="body-xs" textColor="text.tertiary" sx={{ minWidth: 0, whiteSpace: { xs: 'normal', sm: 'nowrap' }, overflowWrap: 'anywhere' }}>
                    {metadataLabel}
                  </Typography>
                ) : undefined}
              />
              {job.error && (
                <Typography level="body-xs" color="danger" sx={{ overflowWrap: 'anywhere' }}>
                  {job.error}
                </Typography>
              )}
            </>
          </PrinterJobMediaStrip>
        </Stack>
      </CardContent>
    </Card>
  )
}

function SlicingJobHistoryCard({ job, printerName, action }: { job: SlicingJob; printerName: string | null; action?: ReactNode }) {
  const displayName = formatLibraryFileName(job.outputFileName ?? job.sourceFileName)
  const detail = [
    job.slicerName ?? 'Server slicer',
    job.target.mode === 'realPrinter'
      ? (printerName ? `Targeted at ${printerName}` : 'Printer-targeted slice')
      : 'Manual profile slice'
  ].join(' - ')
  const startedAt = job.startedAt ?? job.createdAt
  const finishedAt = job.finishedAt ?? job.updatedAt
  const metadataLabel = formatSlicingMetadataDisplay(job.metadata)
  const activityLine = job.error ?? formatSlicingProgress(job, getLatestSlicingProgressFrame(job))

  return (
    <Card variant="outlined" sx={{ height: '100%', width: '100%', minWidth: 0 }}>
      <CardContent sx={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Box
          sx={{
            minWidth: 0,
            flex: 1,
            display: 'flow-root'
          }}
        >
          <PrinterJobMediaStrip
            cover={{
              title: displayName,
              src: buildApiUrl(`/api/slicing/jobs/${job.id}/thumbnail`),
              loaded: true,
              failed: false,
              loading: false
            }}
            camera={null}
          >
            <>
              <Stack spacing={0.75} sx={{ minWidth: 0 }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, flexWrap: 'wrap' }}>
                  <Typography level="title-md" sx={{ minWidth: 0, overflowWrap: 'anywhere', textWrap: 'balance' }}>
                    {displayName}
                  </Typography>
                  <Chip size="sm" variant="soft" color={slicingStatusColor(job.status)} sx={{ flexShrink: 0 }}>
                    {getSlicingJobStatusLabel(job)}
                  </Chip>
                </Stack>
                <Typography level="body-sm" textColor="text.tertiary" sx={{ textWrap: 'pretty', overflowWrap: 'anywhere' }}>
                  {detail}
                </Typography>
                <Typography level="body-xs" textColor="text.tertiary" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  {formatDateTime(startedAt)} - {formatDateTime(finishedAt)}
                </Typography>
                {metadataLabel && (
                  <Typography level="body-xs" textColor="text.tertiary" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                    {metadataLabel}
                  </Typography>
                )}
                {activityLine && (
                  <Typography level="body-xs" textColor={job.error ? 'danger.400' : 'text.secondary'} sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                    {activityLine}
                  </Typography>
                )}
                {/* Where a failed slice lands once its dialog and toast are gone, so the engine's
                    own output has to be reachable from here too. */}
                {job.status === 'failed' && <SlicingEngineLog jobId={job.id} />}
              </Stack>
            </>
          </PrinterJobMediaStrip>
        </Box>
        {action ? (
          <Box
            sx={{
              pt: { xs: 0.25, sm: 0.5 },
              display: 'flex',
              justifyContent: 'flex-start',
              mt: 'auto'
            }}
          >
            {action}
          </Box>
        ) : null}
      </CardContent>
    </Card>
  )
}

function ActiveJobCard({ job, canViewCamera, workspaceSlug }: { job: LiveJob; canViewCamera: boolean; workspaceSlug?: string }) {
  const navigate = useNavigate()
  const cameraSupported = job.printerModel ? getPrinterDisplayCapabilities(job.printerModel).camera : false
  const [pendingStartWarning, setPendingStartWarning] = useState(false)
  const displayJobName = formatPrinterJobDisplayName({
    jobName: job.jobName,
    gcodeFile: job.status?.gcodeFile ?? null
  }) || formatLibraryFileName(job.jobName)
  const livePrinterStatus = job.status ?? { stage: job.stage, online: job.online }
  const waitingForPrinterStart = job.online && job.status?.stage === 'idle' && job.progressPercent == null
  const secondaryStageLabel = waitingForPrinterStart ? null : formatSecondaryStageLabel(job.status ?? undefined)
  const activeJobSummaryDetail = formatActiveJobSummaryDetail(job.status, {
    waitingForPrinterStart,
    pendingStartWarning
  })
  // A job still waiting for the printer to pick it up has no position on the bar yet, so there is
  // nowhere honest to put a mark. Keyed on the individual FIELDS rather than on `job.status`,
  // which is a fresh object several times a second; see the same note in `PrinterCard`.
  const pausePreview = useMemo(
    () => (waitingForPrinterStart
      ? { markers: [], readout: null }
      : buildPrintPauseMarkerView(job.status ?? undefined, job)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above: fields, not the object.
    [
      waitingForPrinterStart,
      job.pauseSchedule,
      job.status?.pauseSchedule,
      job.status?.currentLayer,
      job.status?.remainingMinutes,
      job.status?.totalLayers,
      job.status?.stage
    ]
  )
  const activeCoverTaskQuery = job.status?.taskId ? `&task=${encodeURIComponent(job.status.taskId)}` : ''
  const coverRequestUrl = job.status?.jobName
    ? buildApiUrl(`/api/printers/${job.printerId}/cover?job=${encodeURIComponent(job.status.jobName)}&gcode=${encodeURIComponent(job.status.gcodeFile ?? '')}${activeCoverTaskQuery}`)
    : null
  const { coverUrl, coverLoaded, coverFailed } = useBufferedCoverImage({
    coverRequestUrl,
    enabled: Boolean(coverRequestUrl && job.online),
    mode: 'direct',
    treatDisabledAsFailed: true
  })
  const deferCameraSnapshotsForCover = Boolean(
    coverRequestUrl
    && !coverLoaded
    && !coverFailed
  )

  useEffect(() => {
    if (!waitingForPrinterStart || !job.startedAt) {
      setPendingStartWarning(false)
      return undefined
    }

    const warningAt = Date.parse(job.startedAt) + DISPATCHED_START_WARNING_TIMEOUT_MS
    const remainingMs = warningAt - Date.now()
    if (remainingMs <= 0) {
      setPendingStartWarning(true)
      return undefined
    }

    setPendingStartWarning(false)
    const timer = window.setTimeout(() => {
      setPendingStartWarning(true)
    }, remainingMs)

    return () => window.clearTimeout(timer)
  }, [job.startedAt, waitingForPrinterStart])

  return (
    <Card key={job.printerId} variant="outlined">
      <CardContent>
        <Stack spacing={1}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
            <Stack sx={{ minWidth: 0, flex: 1 }}>
              <Typography level="title-md" sx={{ overflowWrap: 'anywhere' }}>
                <PrinterRouteButton
                  printerId={job.printerId}
                  label={job.printerName}
                  onNavigate={(printerId) => {
                    if (workspaceSlug) navigate(buildWorkspacePath(workspaceSlug, `/printers/${printerId}`))
                  }}
                />
              </Typography>
            </Stack>
            <Chip
              size="sm"
              variant="soft"
              color={waitingForPrinterStart ? (pendingStartWarning ? 'warning' : 'success') : stageLabelColor(livePrinterStatus)}
              sx={{ flexShrink: 0 }}
            >
              {waitingForPrinterStart
                ? (pendingStartWarning ? 'Start delayed' : 'Waiting to start')
                : (job.online ? capitalize(job.stage) : `${capitalize(job.stage)} offline`)}
            </Chip>
          </Stack>

          <PrinterJobMediaStrip
            cover={{ title: displayJobName, src: coverUrl, loaded: coverLoaded, failed: coverFailed }}
            camera={canViewCamera && cameraSupported ? {
              printerId: job.printerId,
              printerName: job.printerName,
              showTile: true,
              paused: deferCameraSnapshotsForCover
            } : null}
          >
            <>
              <PrinterJobProgressBlock
                header={(
                  <Typography level="body-sm" sx={{ minWidth: 0, flex: 1, whiteSpace: { xs: 'normal', sm: 'nowrap' }, overflowWrap: 'anywhere' }}>
                    {displayJobName}
                  </Typography>
                )}
                headerAside={job.progressPercent != null ? (
                  <Typography level="body-xs" sx={{ flexShrink: 0 }}>
                    {Math.round(job.progressPercent)}%
                  </Typography>
                ) : undefined}
                value={job.progressPercent}
                markers={pausePreview.markers}
                color={waitingForPrinterStart ? (pendingStartWarning ? 'warning' : 'success') : progressBarColor(livePrinterStatus)}
                fillColor={waitingForPrinterStart ? undefined : progressBarFill(livePrinterStatus)}
                trackColor={waitingForPrinterStart ? undefined : progressBarTrack(livePrinterStatus)}
                afterProgress={secondaryStageLabel || pausePreview.readout ? (
                  <>
                    {secondaryStageLabel ? (
                      <Typography level="body-xs" textColor={secondaryStageTextColor(livePrinterStatus)} sx={{ minWidth: 0, whiteSpace: { xs: 'normal', sm: 'nowrap' }, overflowWrap: 'anywhere' }}>
                        {secondaryStageLabel}
                      </Typography>
                    ) : null}
                    {pausePreview.readout ? (
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ minWidth: 0, whiteSpace: { xs: 'normal', sm: 'nowrap' }, overflowWrap: 'anywhere' }}>
                        {pausePreview.readout}
                      </Typography>
                    ) : null}
                  </>
                ) : undefined}
                footer={secondaryStageLabel ? undefined : (
                  <Stack
                    direction="row"
                    justifyContent="space-between"
                    alignItems="center"
                    spacing={1}
                    sx={job.status && !waitingForPrinterStart
                      ? {
                          minWidth: 0,
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
                          alignItems: 'center'
                        }
                      : { minWidth: 0 }}
                  >
                    {job.status && !waitingForPrinterStart ? (
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ minWidth: 0, textAlign: 'left' }}>
                        {job.remainingMinutes != null ? `${formatRemaining(job.remainingMinutes)} left` : ''}
                      </Typography>
                    ) : (
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ minWidth: 0, flex: 1, whiteSpace: { xs: 'normal', sm: 'nowrap' }, overflowWrap: 'anywhere' }}>
                        {activeJobSummaryDetail ?? (job.remainingMinutes != null ? `${formatRemaining(job.remainingMinutes)} left` : 'Awaiting printer status')}
                      </Typography>
                    )}
                    {job.status && !waitingForPrinterStart && (
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ flexShrink: 0, px: 0.5, textAlign: 'center' }}>
                        {formatLayerSummary(job.status)}
                      </Typography>
                    )}
                    {job.status && !waitingForPrinterStart ? (
                      job.remainingMinutes != null ? (
                        <Typography level="body-xs" textColor="text.tertiary" sx={{ minWidth: 0, textAlign: 'right' }}>
                          {formatEtaFromNow(job.remainingMinutes)}
                        </Typography>
                      ) : (
                        <Box sx={{ minWidth: 0 }} />
                      )
                    ) : job.remainingMinutes != null && (
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ flexShrink: 0, textAlign: 'right' }}>
                        {formatEtaFromNow(job.remainingMinutes)}
                      </Typography>
                    )}
                  </Stack>
                )}
              />
              <ProjectFilamentChipRow chips={job.projectFilamentChips} />
            </>
          </PrinterJobMediaStrip>

        </Stack>
      </CardContent>
    </Card>
  )
}

function isLiveJobStage(stage: PrinterStatus['stage']): boolean {
  return stage === 'printing' || stage === 'preparing' || stage === 'heating' || stage === 'paused'
}

function isVisibleActiveStatus(status: PrinterStatus | null | undefined): status is PrinterStatus {
  return Boolean(status && isLiveJobStage(status.stage) && (status.jobName || status.progressPercent != null))
}

function dispatchStatusColor(status: PrintDispatchJob['status']): 'neutral' | 'primary' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'queued':
      return 'neutral'
    case 'uploading':
      return 'primary'
    case 'sent':
      return 'success'
    case 'cancelled':
      return 'warning'
    case 'failed':
      return 'danger'
  }
}

function statusLabel(status: PrintDispatchJob['status']): string {
  switch (status) {
    case 'queued':
      return 'Queued'
    case 'uploading':
      return 'Uploading'
    case 'sent':
      return 'Sent'
    case 'cancelled':
      return 'Cancelled'
    case 'failed':
      return 'Failed'
  }
}

function formatPlateLabel(plate: number, plateName: string | null | undefined): string {
  const normalized = plateName?.trim()
  return normalized || `Plate ${plate}`
}

function formatDispatchProgress(job: PrintDispatchJob): string {
  if (job.status === 'uploading' && job.uploadTotalBytes) {
    const percent = job.uploadPercent != null ? ` (${Math.round(job.uploadPercent)}%)` : ''
    const attempt = job.uploadAttempt > 1 && job.uploadMaxAttempts > 1 ? ` - attempt ${job.uploadAttempt} of ${job.uploadMaxAttempts}` : ''
    return `${formatBytes(job.uploadBytesSent)} of ${formatBytes(job.uploadTotalBytes)}${percent}${attempt}`
  }
  return job.progressMessage
}

function formatRemaining(minutes: number): string {
  return formatMinutesDuration(minutes)
}

function formatLayerSummary(status: Pick<PrinterStatus, 'currentLayer' | 'totalLayers'>): string {
  return `${status.currentLayer ?? 0} / ${status.totalLayers ?? 0}`
}

function formatActiveJobSummaryDetail(
  status: PrinterStatus | null,
  options: {
    waitingForPrinterStart?: boolean
    pendingStartWarning?: boolean
  } = {}
): string | null {
  if (options.waitingForPrinterStart) {
    return options.pendingStartWarning
      ? 'The job was dispatched, but the printer still has not reported activity. Check the printer for any prompt, error, or start failure.'
      : 'Print dispatched. Waiting for printer...'
  }

  if (!status) return 'Awaiting printer status'
  return formatSecondaryStageLabel(status)
}

function jobToLibraryFile(job: PrintJob): LibraryFile {
  return {
    id: job.fileId!,
    name: job.fileName ?? job.jobName,
    sizeBytes: job.fileSizeBytes ?? 0,
    uploadedAt: job.startedAt,
    kind: classifyLibraryFileKind(job.fileName ?? job.jobName),
    thumbnailPath: job.thumbnailPath,
    folderId: null,
    compatiblePrinterModels: [],
    plateTypeChips: [],
    nozzleSizeChips: [],
    projectFilamentChips: job.projectFilamentChips,
    favorite: false,
    printCount: 0,
    lastPrintedAt: null
  }
}