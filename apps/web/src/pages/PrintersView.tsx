import { Fragment, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type Dispatch, type DragEvent, type SetStateAction } from 'react'
import { ClickAwayListener } from '@mui/base/ClickAwayListener'
import {
  Alert, Box, Button, ButtonGroup, Card, CardActions, CardContent, CardOverflow, Checkbox, Chip, CircularProgress, DialogActions, Divider, Dropdown, FormControl, FormLabel, IconButton, Input, LinearProgress, Link,
  ListDivider,
  Menu, MenuButton, MenuItem, ModalClose, ModalDialog, Option,
  Autocomplete, AutocompleteOption, ListItemContent,
  Select, Sheet, Stack, Tab, TabList, Tabs, Tooltip, Typography
} from '@mui/joy'
import AddIcon from '@mui/icons-material/Add'
import DragIndicatorRoundedIcon from '@mui/icons-material/DragIndicatorRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded'
import AccessTimeRoundedIcon from '@mui/icons-material/AccessTimeRounded'
import SaveRoundedIcon from '@mui/icons-material/SaveRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import PauseRoundedIcon from '@mui/icons-material/PauseRounded'
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded'
import MoveUpRoundedIcon from '@mui/icons-material/MoveUpRounded'
import StopRoundedIcon from '@mui/icons-material/StopRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import LocalFireDepartmentRoundedIcon from '@mui/icons-material/LocalFireDepartmentRounded'
import SpeedRoundedIcon from '@mui/icons-material/SpeedRounded'
import AirRoundedIcon from '@mui/icons-material/AirRounded'
import MeetingRoomRoundedIcon from '@mui/icons-material/MeetingRoomRounded'
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import SortRoundedIcon from '@mui/icons-material/SortRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import TaskAltRoundedIcon from '@mui/icons-material/TaskAltRounded'
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded'
import ScaleRoundedIcon from '@mui/icons-material/ScaleRounded'
import StraightenRoundedIcon from '@mui/icons-material/StraightenRounded'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded'
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded'
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded'
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PaginatedSection } from '../components/PaginationFooter'
import { Printer3dRoundedIcon } from '../components/Printer3dRoundedIcon'
import { BreakdownStatCard } from '../components/StatsCards'
import { useNavigate, useParams } from 'react-router-dom'
import { ScrollableDialogBody, ScrollableModalDialog } from '../components/ScrollableDialog'
import { LibraryBreadcrumb } from '../components/LibraryBreadcrumb'
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
  PRINTER_EXTRUDER_CONTROL_MIN_TEMP_C,
  classifyLibraryFileKind,
  type BridgeListResponse,
  type BridgeSummary,
  type PrinterConnectionValidation,
  getAmsLoadFilamentAvailability,
  getAmsUnloadFilamentAvailability,
  canUseExtruderControl,
  canUseMotionControl,
  canUsePrintSpeedControl,
  getCheckAssistantAvailability,
  defaultPrinterCardContentSettings,
  defaultPrinterViewSort,
  extractErrorMessage,
  formatNozzleDiameterLabel,
  getExternalSpoolLoadAvailability,
  getExternalSpoolUnloadAvailability,
  getConfirmAmsFilamentExtrudedAvailability,
  getIgnoreHmsErrorAvailability,
  getJumpToLiveViewAvailability,
  getLoadFilamentAvailability,
  getPauseAvailability,
  getDetectedPrinterNozzleDiameters,
  getPrinterCalibrationCapabilities,
  getPrinterChamberTemperatureMax,
  getPrinterDisplayCapabilities,
  getPrinterControlCapabilities,
  getPrinterRecoveryActions,
  printerCardContentSettingsSchema,
  mayRequireExternalStorageForActiveSkipObjects,
  getRetryAmsFilamentChangeAvailability,
  getResumeAvailability,
  getStopAvailability,
  isPausedFilamentRunout,
  isPausedFilamentRunoutWarning,
  isDirectPrintableFileName,
  isPrinterActiveJobStage,
  isPrinterIdleCompatibleStage,
  isPrinterModelCompatible,
  normalizeNozzleDiameter,
  normalizePlateType,
  printerPressureAdvanceProfilesResponseSchema,
  printerViewModelFilterSchema,
  resolvePrinterNozzleDiameters,
  type Permission,
  type AmsSlot,
  type AmsUnit,
  type DiscoveredPrinter,
  type LibraryBrowseResponse,
  type ExternalSpool,
  type LibraryFile,
  type LibraryFolder,
  type PrintDispatchJob,
  type PrintJob,
  type PrinterStatsResponse,
  type PrinterActivePrintObjects,
  type PrinterCardContentSettings,
  type PrinterNozzleDiameterSelection,
  type Printer,
  type PrinterAirductMode,
  type PrinterCommand,
  type PrinterControllableLightNode,
  type PrinterFanId,
  type PrinterLightMode,
  type PrinterModel,
  type PrinterPressureAdvanceProfile,
  type PrinterPrintOptionKey,
  type PrinterPrintOptionSensitivity,
  type PrinterSelectableAirductMode,
  type StartOrderPrintInput,
  type PrinterStatus,
  type SlicingCapabilities,
  type SlicingJobResponse,
  type PrinterView,
  type PrinterViewInput,
  type PrinterViewSort,
  type PrinterViewStateFilter,
  normalizeFallbackPlateLabel
} from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { buildApiUrl } from '../lib/apiUrl'
import { useAuthBootstrapQuery } from '../lib/authQuery'
import { buildLibraryBreadcrumb, isBridgeFolderId, fromBridgeFolderId, toBridgeFolderId } from '../lib/libraryNavigation'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../lib/workspaceScope'
import { usePluginCatalogQuery } from '../lib/pluginCatalogQuery'
import {
  COMMON_FILAMENT_COLOR_SWATCHES,
  commonFilamentColorName,
  filamentBackground,
  filamentTextColor,
  hasLoadedFilament,
  isRawTrayCode,
  resolveCompactFilamentTypeLabel,
  resolveFilamentColorSwatches,
  resolveFilamentDisplay,
  resolveFilamentSwatchName
} from '../lib/filamentColor'
import { isActiveDispatchJob } from '../lib/dispatchToastVisibility'
import { formatLibraryFileKindLabel, formatLibraryFileName } from '../lib/libraryDisplay'
import { isUnslicedThreeMfFile } from '../lib/libraryFileTags'

const SUCCESS_COLOR = 'var(--joy-palette-success-500)'
const FAILED_COLOR = 'var(--joy-palette-danger-500)'
const CANCELLED_COLOR = 'var(--joy-palette-neutral-500)'
import {
  mapActiveDispatchJobsByPrinter,
  mapLatestActivePrintJobsByPrinter,
  mapLatestFinishedPrintJobsByPrinter,
  type LinkedDispatchJob
} from '../lib/trackedPrintJobs'
import { formatDateTime, formatEtaFromNow, formatMinutesDuration } from '../lib/time'
import { toast } from '../lib/toast'
import { resolvePrinterCardFooterOverflowKeys } from '../lib/printerCardFooterActions'
import { formatPrinterJobDisplayName } from '../lib/printerJobName'
import { bambuColorName } from '../data/bambuColors'
import { EmptyState } from '../components/EmptyState'
import { BackAwareModal as Modal } from '../components/BackAwareModal'
import { ConfirmActionDialog } from '../components/ConfirmActionDialog'
import { DialogSection } from '../components/DialogSection'
import { NestedViewHeader } from '../components/NestedViewHeader'
import { NoConnectedBridgesEmptyState } from '../components/NoConnectedBridgesEmptyState'
import { PrintJobHistoryCard } from '../components/PrintJobHistoryCard'
import { PrinterJobMediaStrip } from '../components/PrinterJobMediaStrip'
import { usePromptDialog } from '../components/PromptDialogProvider'
import { PrinterJobProgressBlock } from '../components/PrinterJobProgressBlock'
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
import { type DirectorySortDirection, type DirectoryViewMode } from '../components/DirectoryControls'
import { DirectoryFiltersButton, DirectoryFiltersDialog, DirectoryPrimaryToolbar } from '../components/DirectoryToolbar'
import {
  LibraryBrowser,
  LibraryToolbar,
  type LibrarySort,
  type LibraryViewMode
} from '../components/LibraryBrowser'
import { PrintModal, SliceFileModal, SliceThenPrintModal } from './LibraryView'
import { OverflowTooltipText } from '../components/OverflowTooltipText'
import { useMobileViewport } from '../components/useMobileViewport'
import { usePrintDispatchJobs } from '../hooks/usePrintDispatchJobs'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import {
  formatSecondaryStageLabel,
  getPrinterAttentionSummary
} from '../lib/printerProgressSummary'
import { getPrinterCommandPrompt } from '../lib/printerCommandWarnings'
import { useBufferedCoverImage } from '../hooks/useBufferedCoverImage'
import { buildPrinterConnectionValidationFeedback } from '../lib/printerConnectionValidation'
import { shouldShowNoConnectedPrintersEmptyState } from '../lib/printersEmptyState'
import { PrinterStorageModal } from '../components/PrinterStorageModal'
import { PluginSlot } from '../plugin/PluginSlot'
import { webPluginRegistry } from '../plugin/registry'
import { isPluginActiveByName } from '../lib/pluginSettings'
import { usePlateClearingState, usePlateClearingSync } from '../lib/plateClearing'
import { useRuntimePolicy } from '../lib/runtimePolicy'
import { buildTenantWorkspacePath, buildWorkspaceSelectionPath } from '../lib/workspaceRoute'
import { uploadLibraryFileInChunks, type ChunkedLibraryUploadPhase } from '../lib/chunkedLibraryUpload'
import { filterLibraryEntries, filterLibraryFilesByMetadata } from '../lib/libraryDirectory'
import {
  bambuMaterialFromPresetName,
  bambuMaterialFromType
} from '../data/bambuColors'
import { BAMBU_FILAMENT_PRESET_NAMES } from '../data/bambuFilamentPresets'
import { BAMBU_FILAMENT_PRESETS, BAMBU_FILAMENT_PRESET_GROUPS, FILAMENT_PRESETS, filamentTypeDefaults } from '../data/filamentSetupCatalog'
import { ColorSwatchPicker } from '../components/ColorSwatchPicker'

const CARDS_PER_ROW_OPTIONS = [1, 2, 3, 4, 5, 6] as const
const PRINTER_STATE_FILTER_OPTIONS = ['all', 'idle', 'printing', 'paused', 'error', 'offline'] as const
const LIBRARY_VIEW_MODE_KEY = 'bambu.library.viewMode'
const LIBRARY_SORT_KEY = 'bambu.library.sort'
const LIBRARY_METADATA_FILTER_ALL = '__all__'
const COMMON_PLATE_TYPES = ['Cool Plate', 'Engineering Plate', 'High Temp Plate', 'Smooth PEI Plate', 'Supertack Plate', 'Textured PEI Plate']
const NOZZLE_DIAMETER_OPTIONS = ['0.2', '0.4', '0.6', '0.8', '1.0']
const DUAL_NOZZLE_PRINTER_MODELS: PrinterModel[] = ['X2D', 'H2D', 'H2DPRO', 'H2C']
type PrinterControlsDialogTab = 'printer' | 'speed' | 'temperature' | 'fans' | 'motion' | 'extruder'
type PrinterRecoveryLoadCommand =
  | Extract<PrinterCommand, { type: 'loadAmsFilament' }>
  | Extract<PrinterCommand, { type: 'loadExternalSpool' }>

type PrinterRecoveryFilamentSource = {
  key: string
  label: string
  detail: string
  command: PrinterRecoveryLoadCommand
}

const EMPTY_PRINTERS: Printer[] = []
const EMPTY_PRINT_JOBS: PrintJob[] = []
const EMPTY_PRINTER_VIEWS: PrinterView[] = []
const HISTORY_PAGE_SIZE_OPTIONS = [10, 25, 50] as const
const HISTORY_RESULTS: PrintJob['result'][] = ['success', 'failed', 'cancelled', 'unknown']
const HISTORY_SORT_OPTIONS = [{ value: 'date', label: 'Date' }] as const
const PRINTER_HISTORY_VIEW_MODE_KEY = 'printstream.printers.history.viewMode'

type SliceFlowSubmitInput = Parameters<ComponentProps<typeof SliceFileModal>['onSubmit']>[0]
type SliceFlowSubmitAction = Parameters<ComponentProps<typeof SliceFileModal>['onSubmit']>[1]

function parseHistoryViewMode(raw: string): DirectoryViewMode | null {
  return raw === 'list' || raw === 'icon' ? raw : null
}

function formatHistoryResultsSummary(results: ReadonlyArray<PrintJob['result']>): string {
  if (results.length === 0) return 'No results'
  if (results.length === HISTORY_RESULTS.length) return 'All results'
  if (results.length === 1) return results[0] ?? '1 result'
  return `${results.length} results`
}
const OVERVIEW_VIEW_LABEL = 'Overview'
const OVERVIEW_VIEW_OPTION_VALUE = '__overview__'
const NEW_VIEW_OPTION_VALUE = '__new__'
const PUBLIC_DEMO_PRINTER_MUTATION_NOTICE = 'This is a public demo. You can explore printer setup, but changes will not be saved.'
const PUBLIC_DEMO_FILE_UPLOAD_NOTICE = 'This is a public demo. Local uploads stay private, are limited to 15 MB, and are removed within 12 hours. Curated demo library files remain read-only.'
const DEMO_TEMP_UPLOAD_MAX_BYTES = 15 * 1024 * 1024
const DISPATCHED_START_WARNING_TIMEOUT_MS = 60_000

function formatPrinterViewSelectValue(
  activePrinterViewId: string | null,
  printerViews: readonly PrinterView[],
  defaultPrinterViewId: string | null,
  isOverviewDefaultView: boolean
): string {
  if (!activePrinterViewId) {
    return isOverviewDefaultView ? `${OVERVIEW_VIEW_LABEL} (Default)` : OVERVIEW_VIEW_LABEL
  }

  const view = printerViews.find((entry) => entry.id === activePrinterViewId)
  if (!view) return OVERVIEW_VIEW_LABEL
  return defaultPrinterViewId === view.id ? `${view.name} (Default)` : view.name
}

function showDemoPrinterMutationNotice(action: 'add' | 'edit' | 'delete'): void {
  const actionLabel = action === 'add'
    ? 'Adding printers'
    : action === 'edit'
      ? 'Editing printers'
      : 'Deleting printers'
  toast.info(`${actionLabel} is disabled in the public demo. ${PUBLIC_DEMO_PRINTER_MUTATION_NOTICE}`)
}

function showDemoFileUploadNotice(): void {
  toast.info(PUBLIC_DEMO_FILE_UPLOAD_NOTICE)
}

function useControlledMenuClickAway(
  open: boolean,
  menuId: string,
  onClose: () => void,
  anchorRefs: ReadonlyArray<{ current: HTMLElement | null }>
): void {
  useEffect(() => {
    if (!open) return undefined

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (anchorRefs.some((anchorRef) => anchorRef.current?.contains(target))) return
      if (document.getElementById(menuId)?.contains(target)) return
      onClose()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [anchorRefs, menuId, onClose, open])
}

type PrinterStateFilter = PrinterViewStateFilter
type PrinterControlCommand = Extract<
  PrinterCommand,
  {
    type:
      | 'light'
      | 'setAirductMode'
      | 'setNozzleTemperature'
      | 'setBedTemperature'
      | 'setChamberTemperature'
      | 'setFanSpeed'
      | 'setPrintSpeed'
      | 'moveAxis'
      | 'homeAxes'
      | 'extrudeFilament'
  }
>
type PrinterSettingsDialogCommand = Extract<PrinterCommand, { type: 'setPrintOption' | 'setAirductMode' }>

const DEFAULT_PRINTER_CARD_CONTENT_SETTINGS: PrinterCardContentSettings = defaultPrinterCardContentSettings
const SINGLE_PRINTER_CARD_CONTENT_SETTINGS: PrinterCardContentSettings = {
  nozzleTemperatures: true,
  bedTemperature: true,
  chamberTemperature: true,
  printSpeed: true,
  printStatus: true,
  doorState: true,
  ductState: true,
  modelThumbnail: true,
  cameraThumbnail: true,
  fullWidthSnapshot: true,
  amsCards: true,
  footerControls: true
}
const PRINTER_VIEW_SORT_OPTIONS: Array<{ value: PrinterViewSort; label: string }> = [
  { value: { key: 'manual', direction: 'asc' }, label: 'Manual order' },
  { value: defaultPrinterViewSort, label: 'Name A-Z' },
  { value: { key: 'name', direction: 'desc' }, label: 'Name Z-A' },
  { value: { key: 'model', direction: 'asc' }, label: 'Model A-Z' },
  { value: { key: 'model', direction: 'desc' }, label: 'Model Z-A' },
  { value: { key: 'state', direction: 'asc' }, label: 'State' },
  { value: { key: 'state', direction: 'desc' }, label: 'State (reverse)' }
]
const PRINTER_SETTINGS_LABELS: Record<PrinterPrintOptionKey, string> = {
  aiMonitoring: 'AI monitoring',
  spaghettiDetection: 'Spaghetti detection',
  purgeChutePileupDetection: 'Purge chute pileup detection',
  nozzleClumpingDetection: 'Nozzle clumping detection',
  airPrintingDetection: 'Air printing detection',
  firstLayerInspection: 'First-layer inspection',
  autoRecovery: 'Auto-recovery from step loss',
  promptSound: 'Notification sounds',
  filamentTangleDetection: 'Filament tangle detection'
}
const PRINTER_SETTINGS_DESCRIPTIONS: Record<PrinterPrintOptionKey, string> = {
  aiMonitoring: 'Uses the printer camera to watch for print failures and stop according to the selected sensitivity.',
  spaghettiDetection: 'Detects spaghetti-like print failures with the camera-based detector.',
  purgeChutePileupDetection: 'Watches for purge waste piling up near the chute during material changes.',
  nozzleClumpingDetection: 'Detects blobs or clumps forming around the nozzle before they turn into a failed print.',
  airPrintingDetection: 'Looks for extrusion continuing without the printed part being formed underneath.',
  firstLayerInspection: 'Checks the first printed layer before the rest of the job continues.',
  autoRecovery: 'Attempts to recover automatically after skipped steps or motion loss events.',
  promptSound: 'Plays the printer notification sound for prompts and warnings.',
  filamentTangleDetection: 'Warns when the printer detects filament tangles or feed obstruction.'
}
const PRINTER_SETTINGS_SECTIONS: Array<{ title: string; options: PrinterPrintOptionKey[] }> = [
  {
    title: 'AI monitoring',
    options: ['aiMonitoring', 'spaghettiDetection', 'purgeChutePileupDetection', 'nozzleClumpingDetection', 'airPrintingDetection']
  },
  {
    title: 'Protection',
    options: ['firstLayerInspection', 'autoRecovery', 'filamentTangleDetection', 'promptSound']
  }
]
const AI_MONITORING_SENSITIVITY_OPTIONS: PrinterPrintOptionSensitivity[] = ['never_halt', 'low', 'medium', 'high']
const DETECTION_SENSITIVITY_OPTIONS: PrinterPrintOptionSensitivity[] = ['low', 'medium', 'high']
const AIR_MANAGEMENT_MODES: PrinterSelectableAirductMode[] = ['cooling', 'heating']
const CONTROLLABLE_LIGHT_NODES: PrinterControllableLightNode[] = ['chamber', 'heatbed']

function parseCardsPerRow(raw: string): number | null {
  const parsed = Number(raw)
  return CARDS_PER_ROW_OPTIONS.includes(parsed as (typeof CARDS_PER_ROW_OPTIONS)[number]) ? parsed : null
}

function parsePrinterStateFilter(raw: string): PrinterStateFilter | null {
  return PRINTER_STATE_FILTER_OPTIONS.includes(raw as PrinterStateFilter)
    ? (raw as PrinterStateFilter)
    : null
}

function parseLibraryViewMode(raw: string): LibraryViewMode | null {
  return raw === 'list' || raw === 'icon' ? raw : null
}

function parseLibrarySort(raw: string): LibrarySort | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LibrarySort>
    const key = parsed.key
    const dir = parsed.dir
    const validKey = key === 'name' || key === 'date' || key === 'size'
    const validDir = dir === 'asc' || dir === 'desc'
    return validKey && validDir ? { key, dir } : null
  } catch {
    return null
  }
}

/**
 * Printers dashboard. Lists configured printers with their live status
 * (sourced from the WS-fed `printer-status` cache) and supports adding
 * a new printer via a small modal.
 */
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
  // Page-level Print flow (split button next to "Add printer"). Mirrors
  // the per-card flow but with no preselected printer - the user picks
  // one in the subsequent PrintModal.
  const [pageLibraryPickerOpen, setPageLibraryPickerOpen] = useState(false)
  const [pagePrintMenuOpen, setPagePrintMenuOpen] = useState(false)
  const [sortDialogOpen, setSortDialogOpen] = useState(false)
  const [printerViewsDialogOpen, setPrinterViewsDialogOpen] = useState(false)
  const [printerViewsDialogMode, setPrinterViewsDialogMode] = useState<'edit' | 'create'>('edit')
  const [detailHistorySearch, setDetailHistorySearch] = useState('')
  const deferredDetailHistorySearch = useDeferredValue(detailHistorySearch)
  const [detailHistoryResults, setDetailHistoryResults] = useState<PrintJob['result'][]>(() => [...HISTORY_RESULTS])
  const [detailHistoryFiltersDialogOpen, setDetailHistoryFiltersDialogOpen] = useState(false)
  const [detailHistorySortDirection, setDetailHistorySortDirection] = useState<DirectorySortDirection>('desc')
  const [detailHistoryPage, setDetailHistoryPage] = useState(0)
  const [detailHistoryPageSize, setDetailHistoryPageSize] = useState<number>(HISTORY_PAGE_SIZE_OPTIONS[0])
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
  const effectiveCardsPerRow = activePrinterView?.cardsPerRow ?? cardsPerRow
  const effectiveStateFilter = activePrinterView?.stateFilter ?? stateFilter
  const effectiveModelFilter = activePrinterView?.modelFilter ?? modelFilter
  const effectiveNozzleDiameterFilter = activePrinterView?.nozzleDiameterFilter ?? nozzleDiameterFilter
  const effectivePlateTypeFilter = activePrinterView?.plateTypeFilter ?? plateTypeFilter
  const effectiveCardContentSettings = activePrinterView?.cardContentSettings ?? printerCardContentSettings
  const effectivePrinterIds = activePrinterView?.printerIds ?? defaultViewPrinterIds
  const effectiveSort = activePrinterView?.sort ?? defaultViewSort
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
        return matchesPrinterStateFilter(status, effectiveStateFilter)
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
      if (!activeResults.has(job.result)) return false
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
  const activeDetailHistoryFilterCount = Number(detailHistoryResults.length !== HISTORY_RESULTS.length)
  const effectiveDetailHistoryViewMode: DirectoryViewMode = isMobileViewport ? 'list' : detailHistoryViewMode
  const visibleSelectedPrinterJobs = useMemo(() => {
    const start = safeDetailHistoryPage * detailHistoryPageSize
    return filteredSelectedPrinterJobs.slice(start, start + detailHistoryPageSize)
  }, [detailHistoryPageSize, filteredSelectedPrinterJobs, safeDetailHistoryPage])

  useEffect(() => {
    setDetailHistoryPage((current) => Math.min(current, Math.max(0, Math.ceil(filteredSelectedPrinterJobs.length / detailHistoryPageSize) - 1)))
  }, [detailHistoryPageSize, filteredSelectedPrinterJobs.length])

  function clearDetailHistoryFilters() {
    setDetailHistoryResults([...HISTORY_RESULTS])
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
    mutationFn: ({ id, input }: { id: string; input: PrinterFormValues }) =>
      apiFetch<{ printer: Printer }>(`/api/printers/${id}`, { method: 'PATCH', body: input }),
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
      setSliceTarget(null)
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
        <Stack spacing={1}>
          <NestedViewHeader
            crumbs={[
              { label: 'Printers', onClick: () => navigate(workspacePath('/printers')) },
              { label: selectedPrinter?.name ?? 'Printer' }
            ]}
            description={selectedPrinter
              ? `${selectedPrinter.model} details, live status, controls, storage, and print history.`
              : 'Live status, controls, storage, and print history for this printer.'}
          />
        </Stack>
      ) : showNoConnectedBridgesPlaceholder ? (
        <Stack spacing={1}>
          <Typography level="h3">Printers</Typography>
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
            <Typography level="h3">Printers</Typography>
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
                  setPrinterViewsDialogMode('edit')
                  setPrinterViewsDialogOpen(true)
                }}
                sx={{ flex: '0 0 auto' }}
              >
                Edit view
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
                  setPrinterViewsDialogMode('edit')
                  setPrinterViewsDialogOpen(true)
                }}
                sx={{ flex: '0 0 auto', minWidth: 132, px: 1.5 }}
              >
                Edit view
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
              contentSettings={SINGLE_PRINTER_CARD_CONTENT_SETTINGS}
              cardsPerRow={1}
              demoMode={demoMode}
              canControlPrinter={canControlPrinters}
              canManagePrinter={canManagePrinters}
              canViewPrinterStorage={canViewPrinterStorage}
              canDownloadPrinterStorage={canDownloadPrinterStorage}
              canDispatchPrints={canDispatchPrints}
              canViewCamera={canViewCamera}
              onEdit={() => setEditing(selectedPrinter)}
              onPrint={() => setPickerForPrinter(selectedPrinter)}
              onPrintLocal={() => {
                if (demoMode) {
                  showDemoFileUploadNotice()
                }
                setLocalFileForPrinter(selectedPrinter)
              }}
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
                <Stack spacing={1.25}>
                  <DirectoryPrimaryToolbar
                    searchValue={detailHistorySearch}
                    onSearchChange={(value) => {
                      setDetailHistoryPage(0)
                      setDetailHistorySearch(value)
                    }}
                    searchPlaceholder="Search file, result, or time"
                    searchAriaLabel="Search printer print history"
                    filtersButton={<DirectoryFiltersButton activeCount={activeDetailHistoryFilterCount} onClick={() => setDetailHistoryFiltersDialogOpen(true)} />}
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
                    sortMinWidth={140}
                  />

                  {activeDetailHistoryFilterCount > 0 && (
                    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                      <Chip size="sm" variant="soft" color="neutral">{formatHistoryResultsSummary(detailHistoryResults)}</Chip>
                      <Button size="sm" variant="plain" color="neutral" onClick={clearDetailHistoryFilters}>
                        Clear filters
                      </Button>
                    </Stack>
                  )}

                  <DirectoryFiltersDialog
                    open={detailHistoryFiltersDialogOpen}
                    title="Print history filters"
                    onClose={() => setDetailHistoryFiltersDialogOpen(false)}
                    onClear={clearDetailHistoryFilters}
                    clearDisabled={activeDetailHistoryFilterCount === 0}
                  >
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
                        renderValue={() => (
                          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                            <Chip size="sm" variant="soft">{formatHistoryResultsSummary(detailHistoryResults)}</Chip>
                          </Stack>
                        )}
                        slotProps={{ listbox: { sx: { maxHeight: 280 } } }}
                      >
                        {HISTORY_RESULTS.map((result) => (
                          <Option key={result} value={result}>{result}</Option>
                        ))}
                      </Select>
                    </FormControl>
                  </DirectoryFiltersDialog>

                </Stack>
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
          {shouldShowNoConnectedPrintersEmptyState({
            showNoConnectedBridgesPlaceholder,
            printersCount: printers.length,
            loading: printersQuery.isLoading,
            hasError: Boolean(printersQuery.error)
          }) && (
            <Box sx={{ gridColumn: '1 / -1' }}>
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
            </Box>
          )}
          {printers.length > 0 && filteredPrinters.length === 0 && !printersQuery.isLoading && !printersQuery.error && (
            <Box sx={{ gridColumn: '1 / -1' }}>
              <EmptyState
                icon={<Printer3dRoundedIcon />}
                title="No printers match this filter"
                description={
                  effectiveModelFilter.length === 0
                    && effectiveNozzleDiameterFilter.length === 0
                    && effectivePlateTypeFilter.length === 0
                    && effectiveStateFilter !== 'all'
                    ? `No printers are currently in the ${printerStateFilterLabel(effectiveStateFilter).toLowerCase()} state.`
                    : 'No printers match the selected filters.'
                }
                action={
                  <Button
                    size="sm"
                    variant="soft"
                    onClick={() => {
                      if (activePrinterViewId) {
                        setActivePrinterViewId(null)
                        return
                      }
                      setStateFilter('all')
                      setModelFilter([])
                      setNozzleDiameterFilter([])
                      setPlateTypeFilter([])
                    }}
                  >
                    Clear filter
                  </Button>
                }
              />
            </Box>
          )}
          {filteredPrinters.map((printer) => (
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
              onEdit={() => setEditing(printer)}
              onPrint={() => setPickerForPrinter(printer)}
              onPrintLocal={() => {
                if (demoMode) {
                  showDemoFileUploadNotice()
                }
                setLocalFileForPrinter(printer)
              }}
              onOpenDetails={() => navigate(workspacePath(`/printers/${printer.id}`))}
            />
          ))}
        </Box>
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
          printers={printers}
          activeView={activePrinterView}
          currentViewLabel={printerViewsDialogMode === 'create' ? 'New view' : currentViewLabel}
          isCurrentDefaultView={printerViewsDialogMode === 'create' ? false : isActiveViewDefault}
          currentState={{
            name: printerViewsDialogMode === 'create' ? '' : activePrinterView?.name ?? '',
            printerIds: effectivePrinterIds,
            cardsPerRow: effectiveCardsPerRow,
            stateFilter: effectiveStateFilter,
            modelFilter: effectiveModelFilter,
            nozzleDiameterFilter: effectiveNozzleDiameterFilter,
            plateTypeFilter: effectivePlateTypeFilter,
            sort: effectiveSort,
            cardContentSettings: effectiveCardContentSettings
          }}
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
          onEditManualOrder={() => {
            setPrinterViewsDialogOpen(false)
            setSortDialogOpen(true)
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
            if (isUnslicedThreeMfFile(file)) {
              setSliceTarget({ file, preferredPrinterId: pickerForPrinter.id })
              setPickerForPrinter(null)
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
            if (isUnslicedThreeMfFile(file)) {
              setSliceTarget({ file, preferredPrinterId: '' })
              setPageLibraryPickerOpen(false)
              return
            }
            setPrintTarget({ file, printerId: '' })
          }}
        />
      )}

      {sliceTarget && (
        <SliceFileModal
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
          onClose={() => setSliceTarget(null)}
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
          onClose={() => setSliceThenPrintTarget(null)}
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

function moveListItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return items
  const next = items.slice()
  const [moved] = next.splice(fromIndex, 1)
  if (moved === undefined) return items
  next.splice(toIndex, 0, moved)
  return next
}

function PrinterSortModal({
  printers,
  submitting,
  error,
  onCancel,
  onSubmit
}: {
  printers: Printer[]
  submitting: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (orderedIds: string[]) => void
}) {
  const [orderedPrinters, setOrderedPrinters] = useState(printers)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const draggedPrinterIdRef = useRef<string | null>(null)

  useEffect(() => {
    setOrderedPrinters(printers)
  }, [printers])

  const applyDrop = useCallback((targetId: string) => {
    const draggedPrinterId = draggedPrinterIdRef.current
    if (!draggedPrinterId || draggedPrinterId === targetId) return
    setOrderedPrinters((current) => {
      const fromIndex = current.findIndex((printer) => printer.id === draggedPrinterId)
      const toIndex = current.findIndex((printer) => printer.id === targetId)
      if (fromIndex < 0 || toIndex < 0) return current
      return moveListItem(current, fromIndex, toIndex)
    })
  }, [])

  const endDrag = () => {
    draggedPrinterIdRef.current = null
    setDropTargetId(null)
  }

  const hasChanges = orderedPrinters.length !== printers.length
    || orderedPrinters.some((printer, index) => printer.id !== printers[index]?.id)

  return (
    <Modal open onClose={onCancel}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', sm: 560 } }}>
        <ModalClose />
        <Typography level="h4">Sort printers</Typography>
        <Typography level="body-sm" textColor="text.tertiary" sx={{ mt: 0.5 }}>
          Drag printers into the order you want on the dashboard.
        </Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, p: 0 }}>
          <Stack spacing={1}>
            {orderedPrinters.map((printer, index) => {
              const isDropTarget = dropTargetId === printer.id
              return (
                <Sheet
                  key={printer.id}
                  variant="soft"
                  draggable
                  onDragStart={(event: DragEvent<HTMLElement>) => {
                    draggedPrinterIdRef.current = printer.id
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', printer.id)
                  }}
                  onDragEnd={endDrag}
                  onDragOver={(event: DragEvent<HTMLElement>) => {
                    const draggedPrinterId = draggedPrinterIdRef.current
                    if (!draggedPrinterId || draggedPrinterId === printer.id) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    setDropTargetId(printer.id)
                  }}
                  onDragLeave={() => {
                    setDropTargetId((current) => (current === printer.id ? null : current))
                  }}
                  onDrop={(event: DragEvent<HTMLElement>) => {
                    event.preventDefault()
                    applyDrop(printer.id)
                    endDrag()
                  }}
                  sx={{
                    px: 1.25,
                    py: 1,
                    borderRadius: 'md',
                    border: '1px solid',
                    borderColor: isDropTarget ? 'primary.500' : 'divider',
                    boxShadow: isDropTarget ? '0 0 0 1px var(--joy-palette-primary-500)' : 'none',
                    transition: 'border-color 120ms ease, box-shadow 120ms ease'
                  }}
                >
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Chip size="sm" variant="soft" color="neutral">{index + 1}</Chip>
                    <Box
                      aria-hidden
                      sx={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'text.tertiary',
                        cursor: 'grab'
                      }}
                    >
                      <DragIndicatorRoundedIcon fontSize="small" />
                    </Box>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography level="title-sm" noWrap>{printer.name}</Typography>
                      <Typography level="body-xs" textColor="text.tertiary" noWrap>
                        {printer.model} · {printer.host}
                      </Typography>
                    </Box>
                  </Stack>
                </Sheet>
              )
            })}
            {error && <Typography color="danger" level="body-sm">{error}</Typography>}
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onCancel}>Cancel</Button>
          <Button
            startDecorator={<SaveRoundedIcon />}
            loading={submitting}
            disabled={!hasChanges}
            onClick={() => onSubmit(orderedPrinters.map((printer) => printer.id))}
          >
            Save order
          </Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

function PrinterCardSettingsRow({
  title,
  description,
  checked,
  onChange
}: {
  title: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <Stack
      direction="row"
      spacing={1.5}
      alignItems="flex-start"
      onClick={() => onChange(!checked)}
      sx={{ px: 1.5, py: 1.25, cursor: 'pointer' }}
    >
      <Checkbox
        checked={checked}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onChange(event.target.checked)}
        sx={{ mt: 0.25 }}
      />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography level="title-sm">{title}</Typography>
        <Typography level="body-sm" textColor="text.tertiary">{description}</Typography>
      </Box>
    </Stack>
  )
}

function PrinterViewsModal({
  mode,
  printers,
  activeView,
  currentViewLabel,
  isCurrentDefaultView,
  currentState,
  submitting,
  error,
  onClose,
  onApplyDefault,
  onCreate,
  onUpdate,
  onDelete,
  onSetAsDefault,
  onEditManualOrder
}: {
  mode: 'edit' | 'create'
  printers: Printer[]
  activeView: PrinterView | null
  currentViewLabel: string
  isCurrentDefaultView: boolean
  currentState: PrinterViewInput
  submitting: boolean
  error: string | null
  onClose: () => void
  onApplyDefault: (input: PrinterViewInput) => void
  onCreate: (input: PrinterViewInput) => void
  onUpdate: (id: string, input: PrinterViewInput) => void
  onDelete: (id: string) => void
  onSetAsDefault: () => void
  onEditManualOrder: () => void
}) {
  const [formValues, setFormValues] = useState<PrinterViewInput>(() => clonePrinterViewInput(currentState))
  const modelFilterOptions = useMemo(
    () => buildPrinterModelFilterOptions(printers, formValues.modelFilter),
    [printers, formValues.modelFilter]
  )
  const nozzleDiameterFilterOptions = useMemo(
    () => buildNozzleDiameterFilterOptions(formValues.nozzleDiameterFilter),
    [formValues.nozzleDiameterFilter]
  )
  const plateTypeFilterOptions = useMemo(
    () => buildPlateTypeFilterOptions(printers, formValues.plateTypeFilter),
    [printers, formValues.plateTypeFilter]
  )
  const editingView = mode === 'edit' ? activeView : null
  const isDefaultView = mode === 'edit' && editingView == null
  const isCreatingView = mode === 'create'
  const canSubmitView = !isCreatingView || formValues.name.trim().length > 0

  const submitView = () => {
    if (editingView) onUpdate(editingView.id, normalizePrinterViewInput(formValues))
    else if (isCreatingView) onCreate(normalizePrinterViewInput(formValues))
  }

  const handleFormSubmit = (event: React.FormEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (!canSubmitView || submitting) return
    submitView()
  }

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog
        component="form"
        onSubmit={handleFormSubmit}
        sx={{
          width: { xs: '96vw', sm: 720 },
          maxWidth: '100%'
        }}
      >
        <ModalClose />
        <Typography level="h4">{isCreatingView ? 'New view' : 'Edit view'}</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          {isCreatingView
            ? 'Create a saved printer view from the current dashboard state, including layout, filter, sorting, and card content options.'
            : `Configure ${currentViewLabel} from one place, including layout, filter, sorting, and card content options.`}
        </Typography>

        <ScrollableDialogBody sx={{ mt: 1.5 }}>
          <Stack spacing={2}>
            <DialogSection
              title={isCreatingView ? 'View' : 'View details'}
              description={isDefaultView ? 'Overview only persists on this device.' : undefined}
            >
              {isCreatingView || !isDefaultView ? (
                <FormControl>
                  <FormLabel>Name</FormLabel>
                  <Input
                    value={formValues.name}
                    onChange={(event) => setFormValues((current) => ({ ...current, name: event.target.value }))}
                  />
                </FormControl>
              ) : (
                <Typography level="body-sm">
                  Changes to Overview only persist on this device.
                </Typography>
              )}
            </DialogSection>

            <DialogSection title="Layout and sorting">
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25}>
                <FormControl sx={{ flex: 1 }}>
                  <FormLabel>Cards per row</FormLabel>
                  <Select
                    value={formValues.cardsPerRow}
                    onChange={(_event, value) => value && setFormValues((current) => ({ ...current, cardsPerRow: value }))}
                  >
                    {CARDS_PER_ROW_OPTIONS.map((value) => (
                      <Option key={`view-cards-${value}`} value={value}>{value} per row</Option>
                    ))}
                  </Select>
                </FormControl>
                <FormControl sx={{ flex: 1 }}>
                  <FormLabel>Sort</FormLabel>
                  <Stack spacing={0.75}>
                    <Select
                      value={encodePrinterViewSort(formValues.sort)}
                      onChange={(_event, value) => {
                        if (!value) return
                        setFormValues((current) => ({ ...current, sort: decodePrinterViewSort(value) }))
                      }}
                    >
                      {PRINTER_VIEW_SORT_OPTIONS.map((option) => (
                        <Option key={encodePrinterViewSort(option.value)} value={encodePrinterViewSort(option.value)}>
                          {option.label}
                        </Option>
                      ))}
                    </Select>
                    {formValues.sort.key === 'manual' && (
                      <Button
                        type="button"
                        size="sm"
                        variant="plain"
                        color="neutral"
                        startDecorator={<SortRoundedIcon />}
                        disabled={printers.length < 2}
                        onClick={onEditManualOrder}
                        sx={{ alignSelf: 'flex-start' }}
                      >
                        Edit manual order
                      </Button>
                    )}
                  </Stack>
                </FormControl>
              </Stack>
            </DialogSection>

            <DialogSection
              title="Filters"
              description="Limit the view to printers matching every selected filter. Leave a filter empty to include all printers."
            >
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1.25}
                useFlexGap
                sx={{ flexWrap: 'wrap' }}
              >
                <FormControl sx={{ flex: '1 1 45%', minWidth: 180 }}>
                  <FormLabel>State</FormLabel>
                  <Select
                    value={formValues.stateFilter}
                    onChange={(_event, value) => value && setFormValues((current) => ({ ...current, stateFilter: value }))}
                  >
                    <Option value="all">All states</Option>
                    <Option value="idle">Idle</Option>
                    <Option value="printing">Printing</Option>
                    <Option value="paused">Paused</Option>
                    <Option value="error">Error</Option>
                    <Option value="offline">Offline</Option>
                  </Select>
                </FormControl>
                <FormControl sx={{ flex: '1 1 45%', minWidth: 180 }}>
                  <FormLabel>Model</FormLabel>
                  <Select
                    multiple
                    placeholder="All models"
                    value={formValues.modelFilter}
                    onChange={(_event, value) => setFormValues((current) => ({ ...current, modelFilter: value }))}
                    renderValue={(selected) => (selected.length === 0 ? 'All models' : selected.map((option) => option.label).join(', '))}
                    slotProps={{ listbox: { sx: { maxHeight: 280, overflow: 'auto' } } }}
                  >
                    {modelFilterOptions.map((model) => (
                      <Option key={`view-model-${model}`} value={model}>{model}</Option>
                    ))}
                  </Select>
                </FormControl>
                <FormControl sx={{ flex: '1 1 45%', minWidth: 180 }}>
                  <FormLabel>Nozzle diameter</FormLabel>
                  <Select
                    multiple
                    placeholder="All sizes"
                    value={formValues.nozzleDiameterFilter}
                    onChange={(_event, value) => setFormValues((current) => ({ ...current, nozzleDiameterFilter: value }))}
                    renderValue={(selected) => (selected.length === 0 ? 'All sizes' : selected.map((option) => `${option.value} mm`).join(', '))}
                    slotProps={{ listbox: { sx: { maxHeight: 280, overflow: 'auto' } } }}
                  >
                    {nozzleDiameterFilterOptions.map((diameter) => (
                      <Option key={`view-nozzle-${diameter}`} value={diameter}>{diameter} mm</Option>
                    ))}
                  </Select>
                </FormControl>
                <FormControl sx={{ flex: '1 1 45%', minWidth: 180 }}>
                  <FormLabel>Plate type</FormLabel>
                  <Select
                    multiple
                    placeholder="All plate types"
                    value={formValues.plateTypeFilter}
                    onChange={(_event, value) => setFormValues((current) => ({ ...current, plateTypeFilter: value }))}
                    renderValue={(selected) => (selected.length === 0 ? 'All plate types' : selected.map((option) => option.label).join(', '))}
                    slotProps={{ listbox: { sx: { maxHeight: 280, overflow: 'auto' } } }}
                  >
                    {plateTypeFilterOptions.map((plateType) => (
                      <Option key={`view-plate-${plateType}`} value={plateType}>{plateType}</Option>
                    ))}
                  </Select>
                </FormControl>
              </Stack>
            </DialogSection>

            <DialogSection
              title="Printers"
              description="Leave the selection empty to include every configured printer."
            >
              <Stack spacing={1}>
                {formValues.printerIds.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="plain"
                    color="neutral"
                    onClick={() => setFormValues((current) => ({ ...current, printerIds: [] }))}
                    sx={{ alignSelf: 'flex-start' }}
                  >
                    Use all printers
                  </Button>
                )}
                <Sheet variant="soft" sx={{ borderRadius: 'md', overflow: 'hidden' }}>
                  <Stack divider={<ListDivider inset="gutter" />}>
                    {printers.map((printer) => {
                      const checked = formValues.printerIds.includes(printer.id)
                      return (
                        <Stack
                          key={printer.id}
                          direction="row"
                          spacing={1.25}
                          alignItems="center"
                          onClick={() => {
                            setFormValues((current) => ({
                              ...current,
                              printerIds: togglePrinterSelection(current.printerIds, printer.id)
                            }))
                          }}
                          sx={{ px: 1.5, py: 1, cursor: 'pointer' }}
                        >
                          <Checkbox
                            checked={checked}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => {
                              setFormValues((current) => ({
                                ...current,
                                printerIds: togglePrinterSelection(current.printerIds, printer.id)
                              }))
                            }}
                          />
                          <Box sx={{ minWidth: 0, flex: 1 }}>
                            <Typography level="title-sm" noWrap>{printer.name}</Typography>
                            <Typography level="body-xs" textColor="text.tertiary" noWrap>
                              {printer.model} · {printer.host}
                            </Typography>
                          </Box>
                        </Stack>
                      )
                    })}
                  </Stack>
                </Sheet>
              </Stack>
            </DialogSection>

            <DialogSection
              title="Card content"
              description="Choose which status blocks appear on each printer card."
            >
              <Stack divider={<ListDivider inset="gutter" />}>
                <PrinterCardSettingsRow
                  title="Full-width snapshot"
                  description="Show the camera snapshot in a full-width row above the progress and status block."
                  checked={formValues.cardContentSettings.fullWidthSnapshot}
                  onChange={(checked) => updateViewCardContentSetting(setFormValues, 'fullWidthSnapshot', checked)}
                />
                <PrinterCardSettingsRow
                  title="Model thumbnail"
                  description="Show the plate preview image for the active print."
                  checked={formValues.cardContentSettings.modelThumbnail}
                  onChange={(checked) => updateViewCardContentSetting(setFormValues, 'modelThumbnail', checked)}
                />
                <PrinterCardSettingsRow
                  title="Camera thumbnail"
                  description="Show the live camera snapshot strip on each printer card."
                  checked={formValues.cardContentSettings.cameraThumbnail}
                  onChange={(checked) => updateViewCardContentSetting(setFormValues, 'cameraThumbnail', checked)}
                />
                <PrinterCardSettingsRow
                  title="Print status"
                  description="Show the active job name, progress, and ETA block alongside the media section."
                  checked={formValues.cardContentSettings.printStatus}
                  onChange={(checked) => updateViewCardContentSetting(setFormValues, 'printStatus', checked)}
                />
                <PrinterCardSettingsRow
                  title="Nozzle temps"
                  description="Show the live nozzle temperature readout on each printer card."
                  checked={formValues.cardContentSettings.nozzleTemperatures}
                  onChange={(checked) => updateViewCardContentSetting(setFormValues, 'nozzleTemperatures', checked)}
                />
                <PrinterCardSettingsRow
                  title="Bed temp"
                  description="Show the heated bed temperature on each printer card."
                  checked={formValues.cardContentSettings.bedTemperature}
                  onChange={(checked) => updateViewCardContentSetting(setFormValues, 'bedTemperature', checked)}
                />
                <PrinterCardSettingsRow
                  title="Chamber temp"
                  description="Show chamber temperature when the printer reports one."
                  checked={formValues.cardContentSettings.chamberTemperature}
                  onChange={(checked) => updateViewCardContentSetting(setFormValues, 'chamberTemperature', checked)}
                />
                <PrinterCardSettingsRow
                  title="Print speed"
                  description="Show the printer speed profile chip on each card."
                  checked={formValues.cardContentSettings.printSpeed}
                  onChange={(checked) => updateViewCardContentSetting(setFormValues, 'printSpeed', checked)}
                />
                <PrinterCardSettingsRow
                  title="Door state"
                  description="Show a door open or closed chip on supported printers."
                  checked={formValues.cardContentSettings.doorState}
                  onChange={(checked) => updateViewCardContentSetting(setFormValues, 'doorState', checked)}
                />
                <PrinterCardSettingsRow
                  title="Duct state"
                  description="Show the reported duct mode chip on supported printers."
                  checked={formValues.cardContentSettings.ductState}
                  onChange={(checked) => updateViewCardContentSetting(setFormValues, 'ductState', checked)}
                />
                <PrinterCardSettingsRow
                  title="AMS cards"
                  description="Show AMS units and external spool cards on printer cards."
                  checked={formValues.cardContentSettings.amsCards}
                  onChange={(checked) => updateViewCardContentSetting(setFormValues, 'amsCards', checked)}
                />
                <PrinterCardSettingsRow
                  title="Footer controls"
                  description="Show the action row with light, print, pause, resume, and stop controls."
                  checked={formValues.cardContentSettings.footerControls}
                  onChange={(checked) => updateViewCardContentSetting(setFormValues, 'footerControls', checked)}
                />
              </Stack>
            </DialogSection>

            {error && <Typography color="danger" level="body-sm">{error}</Typography>}

            <DialogSection
              title="Defaults"
              description="Reset this view back to the standard layout or save it as the default for this workspace."
            >
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ flexWrap: 'wrap', justifyContent: 'flex-start' }}
              >
                <Button
                  type="button"
                  variant="plain"
                  color="neutral"
                  onClick={() => setFormValues((current) => resetPrinterViewInput(current))}
                >
                  Reset to defaults
                </Button>
                {!isCreatingView && !isCurrentDefaultView && (
                  <Button
                    type="button"
                    variant="soft"
                    color="neutral"
                    onClick={onSetAsDefault}
                  >
                    Set as default
                  </Button>
                )}
              </Stack>
            </DialogSection>
          </Stack>
        </ScrollableDialogBody>

        <Stack spacing={1} sx={{ mt: 2 }}>
          <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center">
            {editingView ? (
              <Button
                type="button"
                variant="soft"
                color="danger"
                loading={submitting}
                onClick={() => onDelete(editingView.id)}
              >
                Delete
              </Button>
            ) : (
              <Box />
            )}
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ flexWrap: 'wrap', justifyContent: 'flex-end', ml: 'auto' }}
            >
              <Button type="button" variant="plain" color="neutral" onClick={onClose}>Cancel</Button>
              {isDefaultView && (
                <Button
                  type="button"
                  variant="soft"
                  color="neutral"
                  onClick={() => onApplyDefault(normalizePrinterViewInput(formValues))}
                >
                  Apply
                </Button>
              )}
              {(editingView || isCreatingView) && (
                <Button
                  type="submit"
                  loading={submitting}
                  disabled={!canSubmitView}
                >
                  {editingView ? 'Save view' : 'Create view'}
                </Button>
              )}
            </Stack>
          </Stack>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

function updateViewCardContentSetting(
  setFormValues: Dispatch<SetStateAction<PrinterViewInput>>,
  key: keyof PrinterCardContentSettings,
  value: boolean
): void {
  setFormValues((current) => ({
    ...current,
    cardContentSettings: {
      ...current.cardContentSettings,
      [key]: value
    }
  }))
}

function togglePrinterSelection(printerIds: readonly string[], printerId: string): string[] {
  return printerIds.includes(printerId)
    ? printerIds.filter((entry) => entry !== printerId)
    : [...printerIds, printerId]
}

/**
 * Build the option lists for the printer-view attribute filters. Each list is
 * the union of values that make sense to offer (those present on configured
 * printers plus the common defaults) and any value already selected, so a saved
 * filter referencing a now-absent printer still renders as a checked option.
 */
function buildPrinterModelFilterOptions(printers: Printer[], selected: readonly PrinterModel[]): PrinterModel[] {
  const models = new Set<PrinterModel>()
  for (const printer of printers) {
    if (printer.model !== 'unknown') models.add(printer.model)
  }
  for (const model of selected) models.add(model)
  return Array.from(models).sort((left, right) => left.localeCompare(right))
}

function buildNozzleDiameterFilterOptions(selected: readonly string[]): string[] {
  const diameters = new Set<string>(NOZZLE_DIAMETER_OPTIONS)
  for (const value of selected) {
    const normalized = normalizeNozzleDiameter(value)
    if (normalized) diameters.add(normalized)
  }
  return Array.from(diameters).sort((left, right) => Number.parseFloat(left) - Number.parseFloat(right))
}

function buildPlateTypeFilterOptions(printers: Printer[], selected: readonly string[]): string[] {
  const plateTypes = new Set<string>(COMMON_PLATE_TYPES)
  for (const printer of printers) {
    const normalized = normalizePlateType(printer.currentPlateType)
    if (normalized) plateTypes.add(normalized)
  }
  for (const value of selected) {
    const normalized = normalizePlateType(value)
    if (normalized) plateTypes.add(normalized)
  }
  return Array.from(plateTypes).sort((left, right) => left.localeCompare(right))
}

function clonePrinterViewInput(input: PrinterViewInput): PrinterViewInput {
  return {
    name: input.name,
    printerIds: [...input.printerIds],
    cardsPerRow: input.cardsPerRow,
    stateFilter: input.stateFilter,
    modelFilter: [...input.modelFilter],
    nozzleDiameterFilter: [...input.nozzleDiameterFilter],
    plateTypeFilter: [...input.plateTypeFilter],
    sort: { ...input.sort },
    cardContentSettings: { ...input.cardContentSettings }
  }
}

function resetPrinterViewInput(input: PrinterViewInput): PrinterViewInput {
  return {
    name: input.name,
    printerIds: [],
    cardsPerRow: 3,
    stateFilter: 'all',
    modelFilter: [],
    nozzleDiameterFilter: [],
    plateTypeFilter: [],
    sort: { ...defaultPrinterViewSort },
    cardContentSettings: { ...DEFAULT_PRINTER_CARD_CONTENT_SETTINGS }
  }
}

function normalizePrinterViewInput(input: PrinterViewInput): PrinterViewInput {
  return {
    ...clonePrinterViewInput(input),
    name: input.name.trim()
  }
}

function encodePrinterViewSort(sort: PrinterViewSort): string {
  return `${sort.key}:${sort.direction}`
}

function decodePrinterViewSort(value: string): PrinterViewSort {
  const [key, direction] = value.split(':')
  const option = PRINTER_VIEW_SORT_OPTIONS.find((entry) => entry.value.key === key && entry.value.direction === direction)
  return option?.value ?? defaultPrinterViewSort
}

function PrinterCard({
  printer,
  status,
  dispatchLink,
  activeJob,
  latestJob,
  contentSettings,
  compact,
  cardsPerRow,
  demoMode,
  canControlPrinter,
  canManagePrinter,
  canViewPrinterStorage,
  canDownloadPrinterStorage,
  canDispatchPrints,
  canViewCamera,
  onEdit,
  onPrint,
  onPrintLocal,
  onOpenDetails
}: {
  printer: Printer
  status: PrinterStatus | undefined
  dispatchLink: LinkedDispatchJob | undefined
  activeJob: PrintJob | undefined
  latestJob: PrintJob | undefined
  contentSettings: PrinterCardContentSettings
  /** Hide target temps to save space on compact cards. */
  compact?: boolean
  /** How many printer cards are shown per row. */
  cardsPerRow: number
  demoMode: boolean
  canControlPrinter: boolean
  canManagePrinter: boolean
  canViewPrinterStorage: boolean
  canDownloadPrinterStorage: boolean
  canDispatchPrints: boolean
  canViewCamera: boolean
  onEdit: () => void
  onPrint: () => void
  /** Open the “Print from local file” flow (uploads as hidden, then dispatches). */
  onPrintLocal: () => void
  onOpenDetails?: () => void
}) {
  const { confirm } = usePromptDialog()
  const cardRef = useRef<HTMLDivElement | null>(null)
  const footerActionRowRef = useRef<HTMLDivElement | null>(null)
  const footerActionMeasureRootRef = useRef<HTMLDivElement | null>(null)
  const footerOverflowMenuMeasureRef = useRef<HTMLButtonElement | null>(null)
  const footerActionMeasureRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const layerSummaryRowRef = useRef<HTMLDivElement | null>(null)
  const layerSummaryTextRef = useRef<HTMLElement | null>(null)
  const [storageDialogOpen, setStorageDialogOpen] = useState(false)
  // Two specialized variants of the storage browser. Models opens at the
  // root and filters to printable slices; Timelapses opens at /timelapse
  // and limits to .mp4 files (read-only — no print action).
  const [modelsDialogOpen, setModelsDialogOpen] = useState(false)
  const [timelapsesDialogOpen, setTimelapsesDialogOpen] = useState(false)
  const [amsSettingsDialogOpen, setAmsSettingsDialogOpen] = useState(false)
  const [printerSettingsDialogOpen, setPrinterSettingsDialogOpen] = useState(false)
  const [amsDryingUnitId, setAmsDryingUnitId] = useState<number | null>(null)
  const [assistantDialogOpen, setAssistantDialogOpen] = useState(false)
  const [filamentRecoveryDialogOpen, setFilamentRecoveryDialogOpen] = useState(false)
  const [cameraDialogOpenRequestedAt, setCameraDialogOpenRequestedAt] = useState<number | null>(null)
  const activeTrackedJobName = activeJob?.jobName ?? null
  const historyJobName = latestJob?.jobName ?? null
  const latestJobProgressPercent = latestJob?.progressPercent ?? status?.progressPercent ?? (latestJob?.result === 'success' ? 100 : null)
  // Elapsed-since-finish label for the history footer, using the same compact duration
  // format as the live "X left" remaining time. Computed every render so it refreshes as
  // the card re-renders on incoming status events.
  const latestJobFinishedAgo = latestJob?.result === 'success' ? formatFinishedAgo(latestJob.finishedAt) : null
  const displayJobName = status?.jobName ?? historyJobName
  const displayGcodeFile = status?.gcodeFile ?? null
  const activeDisplayJobName = formatPrinterJobDisplayName({
    jobName: status?.jobName ?? null,
    gcodeFile: status?.gcodeFile ?? null
  })
  const activeTrackedDisplayJobName = formatPrinterJobDisplayName({
    jobName: activeTrackedJobName,
    plate: activeJob?.plate ?? null
  })
  const preferredActiveDisplayJobName = shouldPreferTrackedActiveJobName(status?.jobName ?? null, activeTrackedJobName)
    ? activeTrackedDisplayJobName || activeDisplayJobName
    : activeDisplayJobName
  const historyDisplayJobName = formatPrinterJobDisplayName({
    jobName: historyJobName,
    plate: latestJob?.plate ?? null
  })
  const displayJobLabel = preferredActiveDisplayJobName || historyDisplayJobName || displayJobName || ''
  const activeCoverPlateQuery = activeJob?.plate ? `&plate=${encodeURIComponent(String(activeJob.plate))}` : ''
  const activeCoverTaskQuery = status?.taskId ? `&task=${encodeURIComponent(status.taskId)}` : ''
  const activeCoverRequestUrl = status?.jobName && isPrinterActiveJobStage(status?.stage)
    ? buildApiUrl(`/api/printers/${printer.id}/cover?job=${encodeURIComponent(status.jobName)}&gcode=${encodeURIComponent(displayGcodeFile ?? '')}${activeCoverPlateQuery}${activeCoverTaskQuery}`)
    : null
  const historyCoverRequestUrl = latestJob && (latestJob.thumbnailPath || latestJob.fileId)
    ? buildApiUrl(`/api/jobs/${latestJob.id}/thumbnail`)
    : null
  const coverRequestUrl = activeCoverRequestUrl ?? historyCoverRequestUrl
  const { coverUrl, coverLoaded, coverFailed } = useBufferedCoverImage({
    coverRequestUrl,
    enabled: Boolean(contentSettings.modelThumbnail && coverRequestUrl),
    mode: 'blob'
  })
  const [coverLoadStatus, setCoverLoadStatus] = useState<'idle' | 'resolving' | 'downloading' | 'extracting'>('idle')
  const [coverProgress, setCoverProgress] = useState<number | null>(null)
  const [editingSlot, setEditingSlot] = useState<{ unit: AmsUnit; slot: AmsSlot } | null>(null)
  const [editingExternalSpool, setEditingExternalSpool] = useState<ExternalSpool | null>(null)
  const [externalSpoolsExpanded, setExternalSpoolsExpanded] = useLocalStorageState<boolean>(
    `bambu.printers.externalSpoolsExpanded.${printer.id}`,
    false,
    parseStoredBoolean,
    String
  )
  const [printMenuOpen, setPrintMenuOpen] = useState(false)
  const [calibrationDialogOpen, setCalibrationDialogOpen] = useState(false)
  const [controlsDialogOpen, setControlsDialogOpen] = useState(false)
  const [controlsDialogInitialTab, setControlsDialogInitialTab] = useState<PrinterControlsDialogTab>('printer')
  const [skipObjectDialogOpen, setSkipObjectDialogOpen] = useState(false)
  const [footerActionRowWidth, setFooterActionRowWidth] = useState<number | null>(null)
  const [footerActionWidths, setFooterActionWidths] = useState<Record<string, number>>({})
  const [footerOverflowMenuButtonWidth, setFooterOverflowMenuButtonWidth] = useState<number | null>(null)
  const [layerSummaryRowWidth, setLayerSummaryRowWidth] = useState(0)
  const [remainingSummaryWidth, setRemainingSummaryWidth] = useState(0)
  const [etaSummaryWidth, setEtaSummaryWidth] = useState(0)
  const [layerSummaryWidth, setLayerSummaryWidth] = useState(0)
  const queryClient = useQueryClient()
  const printAnchorRef = useRef<HTMLDivElement>(null)
  useControlledMenuClickAway(printMenuOpen, `print-menu-${printer.id}`, () => setPrintMenuOpen(false), [printAnchorRef])
  const dispatchJob = dispatchLink?.dispatchJob
  const dispatchPrintJob = dispatchLink?.printJob
  const [pendingStartWarning, setPendingStartWarning] = useState(false)
  const sendCommand = useMutation({
    mutationFn: (command: PrinterCommand) =>
      apiFetch(`/api/printers/${printer.id}/command`, { method: 'POST', body: command }),
    onSuccess: (_data, command) => {
      if (command.type === 'calibrate') {
        setCalibrationDialogOpen(false)
        toast.success('Calibration started')
      } else if (command.type === 'rescanAmsSlot') {
        toast.success('Rescan requested')
      } else if (command.type === 'resetAmsSlot') {
        toast.success('Slot reset')
      } else if (command.type === 'setPrintOption') {
        toast.success(`${PRINTER_SETTINGS_LABELS[command.option]} updated`)
      } else if (command.type === 'setAmsUserSettings') {
        toast.success('AMS settings updated')
      } else if (command.type === 'setAmsFilamentBackup') {
        toast.success(command.enabled ? 'AMS filament backup enabled' : 'AMS filament backup disabled')
      } else if (command.type === 'startAmsDrying') {
        setAmsDryingUnitId(null)
        toast.success('AMS drying started')
      } else if (command.type === 'stopAmsDrying') {
        setAmsDryingUnitId(null)
        toast.success('AMS drying stop requested')
      } else if (command.type === 'skipObjects') {
        setSkipObjectDialogOpen(false)
        toast.success(command.objectIds.length === 1 ? 'Object skip requested' : 'Object skips requested')
      } else if (isPrinterControlCommand(command)) {
        toast.success(printerControlSuccessMessage(command))
      }
    },
    onError: (error, command) => {
      if (
        command.type === 'calibrate' ||
        command.type === 'rescanAmsSlot' ||
        command.type === 'resetAmsSlot' ||
        command.type === 'setPrintOption' ||
        command.type === 'setAmsUserSettings' ||
        command.type === 'setAmsFilamentBackup' ||
        command.type === 'startAmsDrying' ||
        command.type === 'stopAmsDrying' ||
        command.type === 'skipObjects' ||
        isPrinterControlCommand(command)
      ) {
        toast.error((error as Error).message)
      }
    }
  })

  const displayCapabilities = getPrinterDisplayCapabilities(printer.model)
  const cameraSupported = displayCapabilities.camera
  const coverVisible = contentSettings.modelThumbnail
  const stage = status?.stage
  const isOnline = status?.online ?? false
  const isIdleLikeStage = isPrinterIdleCompatibleStage(stage)
  const isActivePrintStage = isPrinterActiveJobStage(stage)
  const showJobSummary = isOnline && isActivePrintStage && (status?.jobName || status?.progressPercent != null)
  const showDispatchSummary = dispatchJob != null && isActiveDispatchJob(dispatchJob)
  const showPendingDispatchSummary = !showJobSummary
    && !showDispatchSummary
    && isOnline
    && isIdleLikeStage
    && activeJob != null
  const printerAttentionSummary = getPrinterAttentionSummary(status)
  const terminalJobSummaryVisible = isOnline
    && !showJobSummary
    && !showDispatchSummary
    && !showPendingDispatchSummary
    && stage === 'failed'
    && Boolean(status?.jobName || status?.taskId || status?.progressPercent != null)
  const showHistoryJobSummary = isOnline
    && !showJobSummary
    && !showDispatchSummary
    && !showPendingDispatchSummary
    && !terminalJobSummaryVisible
    && Boolean(latestJob)
  const deferCameraSnapshotsForCover = Boolean(
    coverVisible
    && coverRequestUrl
    && !coverLoaded
    && !coverFailed
    && status?.jobName
    && status.stage
    && status.stage !== 'paused'
    && isPrinterActiveJobStage(status.stage)
  )
  const freezeCameraThumbnail = demoMode && (stage === 'idle' || stage === 'finished')
  // Reset the cover-image fallback whenever the active job changes so a
  // newly started print gets a fresh fetch attempt.
  useEffect(() => {
    setCoverLoadStatus(coverVisible && coverRequestUrl && showJobSummary ? 'resolving' : 'idle')
    setCoverProgress(null)
  }, [coverRequestUrl, coverVisible, showJobSummary])
  const calibrationCapabilities = getPrinterCalibrationCapabilities(printer.model)
  const controlCapabilities = getPrinterControlCapabilities(printer.model)
  const chamberTemperature = status?.chamberTemp ?? null
  const chamberTarget = status?.chamberTarget ?? null
  const showChamberTemperature = chamberTemperature != null
    && displayCapabilities.chamberTemperature
  const nozzleSizeLabel = formatPrinterCardNozzleSizes(status, printer.currentNozzleDiameters)
  const secondaryStageLabel = formatSecondaryStageLabel(status)
  const printerAttentionSummaryText = printerAttentionSummary
    ? formatPrinterAttentionSummaryText(printerAttentionSummary)
    : null
  const cameraVisible = canViewCamera
    && isOnline
    && cameraSupported
    && (contentSettings.cameraThumbnail || contentSettings.fullWidthSnapshot)
  const showWideCamera = Boolean(
    canViewCamera
    && isOnline
    && cameraSupported
    && contentSettings.fullWidthSnapshot
  )
  const pauseAvailability = getPauseAvailability(status)
  const resumeAvailability = getResumeAvailability(status)
  const loadFilamentAvailability = getLoadFilamentAvailability(status)
  const ignoreHmsErrorAvailability = getIgnoreHmsErrorAvailability(status)
  const checkAssistantAvailability = getCheckAssistantAvailability(status)
  const jumpToLiveViewAvailability = getJumpToLiveViewAvailability(status)
  const retryAmsFilamentChangeAvailability = getRetryAmsFilamentChangeAvailability(status)
  const confirmAmsFilamentExtrudedAvailability = getConfirmAmsFilamentExtrudedAvailability(status)
  const stopAvailability = getStopAvailability(status)
  const recoveryActionIds = getPrinterRecoveryActions(status).map((action) => action.id)
  const showPauseAction = stage === 'printing' || stage === 'preparing' || stage === 'heating'
  const showResumeAction = recoveryActionIds.includes('resume')
  const showLoadFilamentAction = recoveryActionIds.includes('loadFilament')
    && canManagePrinter
    && loadFilamentAvailability.allowed
  const showIgnoreHmsContinueAction = recoveryActionIds.includes('ignoreHmsError')
  const showCheckAssistantAction = recoveryActionIds.includes('checkAssistant')
  const canOpenAssistantLiveView = recoveryActionIds.includes('jumpToLiveView')
    && canViewCamera
    && cameraSupported
  const showRetryAmsFilamentChangeAction = recoveryActionIds.includes('retryAmsFilamentChange')
  const showConfirmAmsFilamentExtrudedAction = recoveryActionIds.includes('confirmAmsFilamentExtruded')
  const pausedOnDeviceError = stage === 'paused' && status?.deviceError != null
  const showStopAction = isPrinterActiveJobStage(stage)
  const requestStopPrint = useCallback(() => {
    const run = async () => {
      if (sendCommand.isPending || !stopAvailability.allowed) return
      const confirmed = await confirm({
        title: 'Stop active print?',
        description: `Stop the active print on ${printer.name}?`,
        confirmLabel: 'Stop print',
        color: 'danger'
      })
      if (!confirmed) return
      sendCommand.mutate({ type: 'stop' })
    }

    void run()
  }, [confirm, printer.name, sendCommand, stopAvailability.allowed])
  const requestResumePrint = useCallback(() => {
    if (sendCommand.isPending || !resumeAvailability.allowed) return

    sendCommand.mutate({ type: 'resume' })
  }, [resumeAvailability.allowed, sendCommand])

  const requestIgnoreHmsError = useCallback(() => {
    const run = async () => {
      if (sendCommand.isPending || !ignoreHmsErrorAvailability.allowed || status?.deviceError == null) return

      const prompt = getPrinterCommandPrompt(
        {
          stage: status?.stage ?? 'unknown',
          ductMode: status?.ductMode ?? null,
          chamberLightOffRequiresConfirm: status?.chamberLightOffRequiresConfirm ?? false,
          deviceError: status?.deviceError ?? null
        },
        { type: 'ignoreHmsError' }
      )
      if (prompt?.kind === 'confirm') {
        const confirmed = await confirm({
          title: prompt.title ?? 'Continue print?',
          description: prompt.message,
          confirmLabel: prompt.confirmLabel,
          cancelLabel: prompt.cancelLabel,
          color: prompt.color ?? 'primary'
        })
        if (!confirmed) return
      }

      sendCommand.mutate({ type: 'ignoreHmsError' })
    }

    void run()
  }, [confirm, ignoreHmsErrorAvailability.allowed, sendCommand, status])
  const requestLoadFilament = useCallback(() => {
    if (sendCommand.isPending || !loadFilamentAvailability.allowed) return
    setFilamentRecoveryDialogOpen(true)
  }, [loadFilamentAvailability.allowed, sendCommand.isPending])
  const requestCheckAssistant = useCallback(() => {
    if (!checkAssistantAvailability.allowed) return
    setAssistantDialogOpen(true)
  }, [checkAssistantAvailability.allowed])
  const requestRetryAmsFilamentChange = useCallback(() => {
    if (sendCommand.isPending || !retryAmsFilamentChangeAvailability.allowed) return

    sendCommand.mutate({ type: 'retryAmsFilamentChange' })
  }, [retryAmsFilamentChangeAvailability.allowed, sendCommand])
  const requestConfirmAmsFilamentExtruded = useCallback(() => {
    if (sendCommand.isPending || !confirmAmsFilamentExtrudedAvailability.allowed) return

    sendCommand.mutate({ type: 'confirmAmsFilamentExtruded' })
  }, [confirmAmsFilamentExtrudedAvailability.allowed, sendCommand])
  const canSkipObjects = isOnline && (stage === 'printing' || stage === 'paused') && !pausedOnDeviceError
  const activePrintObjectsQuery = useQuery({
    queryKey: ['printer-active-print-objects', printer.id, status?.jobName, status?.gcodeFile, status?.taskId],
    queryFn: ({ signal }) => apiFetch<PrinterActivePrintObjects>(`/api/printers/${printer.id}/active-print-objects`, { signal }),
    enabled: skipObjectDialogOpen && canSkipObjects,
    staleTime: 30_000,
    refetchInterval: (query) => query.state.data?.loading ? 2_000 : false
  })
  const activePrintObjects = activePrintObjectsQuery.data?.objects ?? []
  const activePrintObjectsLoading = activePrintObjectsQuery.data?.loading ?? activePrintObjectsQuery.isLoading
  const activePrintObjectsUnavailableReason = activePrintObjectsQuery.data?.unavailableReason ?? null
  const activePrintObjectsUnavailableMessage = activePrintObjectsQuery.data?.unavailableMessage ?? null
  const { cleared: plateCleared } = usePlateClearingState(printer.id)
  // Keep the Print affordance visible for online idle-like printers,
  // even when plate clearing is blocking the next job, so the footer
  // does not disappear entirely on affected printers.
  const canShowPrintAction = canDispatchPrints && isOnline && isIdleLikeStage
  const dispatchInProgress = dispatchJob != null && isActiveDispatchJob(dispatchJob)
  const printDisabledReason = plateCleared
    ? (dispatchInProgress ? 'A print is already being dispatched to this printer. Wait for that transfer to finish or cancel it first.' : null)
    : 'Plate has not been confirmed cleared. Confirm in PrintStream before printing again.'
  const canPrint = canShowPrintAction && plateCleared && !dispatchInProgress
  const canShowCalibrate = isOnline && (stage === 'idle' || stage === 'finished' || stage === 'failed' || stage === 'unknown' || stage == null) && Object.values(calibrationCapabilities).some(Boolean)
  const canCalibrate = canShowCalibrate && plateCleared
  const canOpenControls = canControlPrinter && isOnline
  const canPrintFromPrinter = canPrint
  const openControlsDialog = useCallback((tab: PrinterControlsDialogTab = 'printer') => {
    setControlsDialogInitialTab(tab)
    setControlsDialogOpen(true)
  }, [])

  useEffect(() => {
    if (!showPendingDispatchSummary || !activeJob) {
      setPendingStartWarning(false)
      return undefined
    }

    const warningAt = Date.parse(activeJob.startedAt) + DISPATCHED_START_WARNING_TIMEOUT_MS
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
  }, [activeJob, showPendingDispatchSummary])

  useEffect(() => {
    if (!coverVisible || !coverRequestUrl || !showJobSummary || coverLoaded || coverFailed) {
      if (!showJobSummary || coverLoaded || coverFailed) {
        setCoverLoadStatus('idle')
        setCoverProgress(null)
      }
      return undefined
    }

    let cancelled = false
    let pollTimer: number | null = null
    const controller = new AbortController()

    const stopPolling = () => {
      if (pollTimer != null) {
        window.clearTimeout(pollTimer)
        pollTimer = null
      }
    }

    const pollProgress = async () => {
      try {
        const response = await apiFetch<{ status: 'idle' | 'resolving' | 'downloading' | 'extracting'; progressPercent: number | null }>(
          `/api/printers/${printer.id}/cover/status`,
          { signal: controller.signal }
        )
        if (cancelled) return
        setCoverLoadStatus(response.status)
        if (response.status === 'downloading' && typeof response.progressPercent === 'number') {
          setCoverProgress(Math.max(0, Math.min(100, response.progressPercent)))
        } else {
          setCoverProgress(null)
        }
      } catch {
        // Ignore polling failures; the cover fetch itself is authoritative.
      }
      if (!cancelled) {
        pollTimer = window.setTimeout(pollProgress, 250)
      }
    }

    void pollProgress()

    return () => {
      cancelled = true
      controller.abort()
      stopPolling()
    }
  }, [coverFailed, coverLoaded, coverRequestUrl, coverVisible, printer.id, showJobSummary])

  useEffect(() => {
    if (!canSkipObjects && skipObjectDialogOpen) {
      setSkipObjectDialogOpen(false)
    }
  }, [canSkipObjects, skipObjectDialogOpen])

  const showDeterminateCoverProgress = !coverFailed && !coverLoaded && coverLoadStatus === 'downloading' && coverProgress != null
  const showIndeterminateCoverProgress = !coverFailed && !coverLoaded && !showDeterminateCoverProgress

  const amsUnits = useMemo(() => status?.ams ?? [], [status?.ams])
  const externalSpools = useMemo(() => status?.externalSpools ?? [], [status?.externalSpools])
  const currentEditingUnit = editingSlot
    ? amsUnits.find((unit) => unit.unitId === editingSlot.unit.unitId) ?? editingSlot.unit
    : null
  const currentEditingSlot = editingSlot && currentEditingUnit
    ? currentEditingUnit.slots.find((slot) => slot.slot === editingSlot.slot.slot) ?? editingSlot.slot
    : null
  const currentEditingExternalSpool = editingExternalSpool
    ? externalSpools.find((spool) => spool.amsId === editingExternalSpool.amsId) ?? editingExternalSpool
    : null
  const currentDryingUnit = amsDryingUnitId != null
    ? amsUnits.find((unit) => unit.unitId === amsDryingUnitId) ?? null
    : null
  const defaultExternalSpoolTemp = resolveFilamentChangeTargetTemp(currentEditingExternalSpool) ?? 220
  const filamentRecoverySources = useMemo<PrinterRecoveryFilamentSource[]>(() => {
    if (!isPausedFilamentRunout(status)) return []

    const sources: PrinterRecoveryFilamentSource[] = []

    amsUnits.forEach((unit) => {
      unit.slots.forEach((slot) => {
        const availability = getAmsLoadFilamentAvailability(status, unit.unitId, slot.slot)
        if (!availability.allowed) return

        sources.push({
          key: `ams-${unit.unitId}-${slot.slot}`,
          label: `AMS ${amsUnitLetter(unit.unitId)}${slot.slot + 1}`,
          detail: formatFilamentRecoverySourceDetail(slot),
          command: {
            type: 'loadAmsFilament',
            amsId: unit.unitId,
            slotId: slot.slot,
            extruderId: unit.nozzleId ?? undefined,
            nozzleTemp: resolveFilamentChangeTargetTemp(slot) ?? 220
          }
        })
      })
    })

    externalSpools.forEach((spool) => {
      const availability = getExternalSpoolLoadAvailability(status, spool.amsId)
      if (!availability.allowed) return

      sources.push({
        key: `external-${spool.amsId}`,
        label: externalSpoolLabel(spool.amsId, externalSpools.length),
        detail: formatFilamentRecoverySourceDetail(spool),
        command: {
          type: 'loadExternalSpool',
          amsId: spool.amsId,
          extruderId: spool.nozzleId ?? undefined,
          nozzleTemp: resolveFilamentChangeTargetTemp(spool) ?? 220
        }
      })
    })

    return sources
  }, [amsUnits, externalSpools, status])
  const amsGridColumns = printerCardAmsGridColumns(cardsPerRow)
  const hasAmsUnits = amsUnits.length > 0
  const hasExternalSpools = externalSpools.length > 0
  const canOpenAmsSettings = canManagePrinter && hasAmsUnits && isOnline
  const canToggleExternalSpools = contentSettings.amsCards && hasAmsUnits && hasExternalSpools
  const showExternalSpools = !hasAmsUnits || externalSpoolsExpanded
  const editAmsSlot = canManagePrinter
    ? (unit: AmsUnit, slot: AmsSlot) => setEditingSlot({ unit, slot })
    : undefined
  const rescanAmsSlot = canManagePrinter
    ? (unit: AmsUnit, slot: AmsSlot) => sendCommand.mutate({
      type: 'rescanAmsSlot',
      amsId: unit.unitId,
      slotId: slot.slot
    })
    : undefined
  const resetAmsSlot = canManagePrinter
    ? (unit: AmsUnit, slot: AmsSlot) => sendCommand.mutate({
      type: 'resetAmsSlot',
      amsId: unit.unitId,
      slotId: slot.slot
    })
    : undefined
  const nozzleReadouts = printerNozzles(status)
  const showCoverTile = Boolean((showJobSummary || terminalJobSummaryVisible || showHistoryJobSummary) && coverRequestUrl && coverVisible)
  const showCameraTile = Boolean(cameraVisible && contentSettings.cameraThumbnail)
  const cameraSurfaceVisible = canViewCamera
    && isOnline
    && cameraSupported
    && (contentSettings.cameraThumbnail || contentSettings.fullWidthSnapshot || canOpenAssistantLiveView)
  const cameraLightControls = status ? [
    {
      key: 'chamber',
      label: 'Chamber',
      on: isActiveLightMode(lightModeForControl(status, 'chamber')),
      onToggle: () => {
        const lightOn = isActiveLightMode(lightModeForControl(status, 'chamber'))
        sendCommand.mutate({ type: 'light', node: 'chamber', on: !lightOn })
      }
    }
  ] : []
  const showPrintStatusBlock = Boolean(contentSettings.printStatus && (showJobSummary || showDispatchSummary || showPendingDispatchSummary || terminalJobSummaryVisible || showHistoryJobSummary || cameraVisible))
  const showMediaStrip = showCoverTile || showWideCamera || showCameraTile || showPrintStatusBlock || cameraDialogOpenRequestedAt != null
  const printerIpAddress = status?.ipAddress ?? printer.host
  const wifiSignalLabel = formatWifiSignal(status?.wifiSignalDbm)
  const clearActivePrinterError = canControlPrinter
    ? () => sendCommand.mutate({ type: 'clearHmsErrors' })
    : undefined
  const showLayerSummary = Boolean(
    cardsPerRow < 4
    && status?.remainingMinutes != null
    && status.currentLayer != null
    && status.totalLayers != null
    && status.totalLayers > 0
  )
  const hideLayerSummaryForWidth = showLayerSummary
    && layerSummaryRowWidth > 0
    && remainingSummaryWidth > 0
    && etaSummaryWidth > 0
    && (remainingSummaryWidth + etaSummaryWidth + (layerSummaryWidth || 64) + 16) - layerSummaryRowWidth > 1
  const showCenteredLayerSummary = showLayerSummary && !hideLayerSummaryForWidth
  const showHistoryResultChip = latestJob != null
    && latestJob.result !== 'success'
    && latestJob.result !== 'unknown'
  const showDoorStateChip = Boolean(
    displayCapabilities.doorState
    && contentSettings.doorState
    && status?.doorOpen != null
  )
  const showDuctStateChip = Boolean(
    displayCapabilities.airductMode
    && contentSettings.ductState
    && status?.ductMode
  )
  const pluginStateQuery = usePluginCatalogQuery({ suppressGlobalErrorToast: true })
  const apiPluginsByName = useMemo(
    () => new Map((pluginStateQuery.data?.plugins ?? []).map((plugin) => [plugin.name, plugin] as const)),
    [pluginStateQuery.data?.plugins]
  )
  const footerPluginSlots = useMemo(
    () => webPluginRegistry
      .slots('printer.card.actions')
      .filter((slot) => slot.runtimeSurfaces.includes('tenant'))
      .filter((slot) => isPluginActiveByName(slot.pluginName, apiPluginsByName, pluginStateQuery.data?.plugins != null)),
    [apiPluginsByName, pluginStateQuery.data?.plugins]
  )
  const footerActions = useMemo<Array<{
    key: string
    fill?: boolean
    optional?: boolean
    inline: JSX.Element
    overflow: JSX.Element
  }>>(() => {
    const actions: Array<{
      key: string
      fill?: boolean
      optional?: boolean
      inline: JSX.Element
      overflow: JSX.Element
    }> = []

    footerPluginSlots.forEach((slot, index) => {
      const Component = slot.component
      actions.push({
        key: `plugin:${slot.name}:${slot.order ?? 0}:${index}`,
        optional: true,
        inline: <Component printerId={printer.id} printerName={printer.name} presentation="inline" />,
        overflow: <Component printerId={printer.id} printerName={printer.name} presentation="menu" />
      })
    })

    if (canControlPrinter && showPauseAction) {
      actions.push({
        key: 'pause',
        fill: true,
        inline: withDisabledActionReason(
          <Button
            size="sm"
            variant="soft"
            startDecorator={<PauseRoundedIcon />}
            disabled={sendCommand.isPending || !pauseAvailability.allowed}
            onClick={() => sendCommand.mutate({ type: 'pause' })}
          >
            Pause
          </Button>,
          sendCommand.isPending ? null : pauseAvailability.reason,
          { fill: true }
        ),
        overflow: <MenuItem disabled={sendCommand.isPending || !pauseAvailability.allowed} onClick={() => sendCommand.mutate({ type: 'pause' })}>Pause</MenuItem>
      })
    }

    if (canControlPrinter && showResumeAction) {
      actions.push({
        key: 'resume',
        fill: true,
        inline: withDisabledActionReason(
          <Button
            size="sm"
            variant="soft"
            startDecorator={<PlayArrowRoundedIcon />}
            disabled={sendCommand.isPending || !resumeAvailability.allowed}
            onClick={requestResumePrint}
          >
            Resume
          </Button>,
          sendCommand.isPending ? null : resumeAvailability.reason,
          { fill: true }
        ),
        overflow: <MenuItem disabled={sendCommand.isPending || !resumeAvailability.allowed} onClick={requestResumePrint}>Resume</MenuItem>
      })
    }

    if (showLoadFilamentAction) {
      actions.push({
        key: 'load-filament',
        fill: true,
        inline: withDisabledActionReason(
          <Button
            size="sm"
            variant="soft"
            color="neutral"
            startDecorator={<AddIcon />}
            disabled={sendCommand.isPending || !loadFilamentAvailability.allowed}
            onClick={requestLoadFilament}
          >
            Load filament
          </Button>,
          sendCommand.isPending ? null : loadFilamentAvailability.reason,
          { fill: true }
        ),
        overflow: <MenuItem disabled={sendCommand.isPending || !loadFilamentAvailability.allowed} onClick={requestLoadFilament}>Load filament</MenuItem>
      })
    }

    if (canControlPrinter && showRetryAmsFilamentChangeAction) {
      actions.push({
        key: 'retry-ams-filament-change',
        fill: true,
        inline: withDisabledActionReason(
          <Button
            size="sm"
            variant="soft"
            color="neutral"
            startDecorator={<RefreshRoundedIcon />}
            disabled={sendCommand.isPending || !retryAmsFilamentChangeAvailability.allowed}
            onClick={requestRetryAmsFilamentChange}
          >
            Retry
          </Button>,
          sendCommand.isPending ? null : retryAmsFilamentChangeAvailability.reason,
          { fill: true }
        ),
        overflow: <MenuItem disabled={sendCommand.isPending || !retryAmsFilamentChangeAvailability.allowed} onClick={requestRetryAmsFilamentChange}>Retry</MenuItem>
      })
    }

    if (canControlPrinter && showIgnoreHmsContinueAction) {
      actions.push({
        key: 'ignore-hms-error',
        fill: true,
        inline: withDisabledActionReason(
          <Button
            size="sm"
            variant="soft"
            color="warning"
            startDecorator={<WarningAmberRoundedIcon />}
            disabled={sendCommand.isPending || !ignoreHmsErrorAvailability.allowed}
            onClick={requestIgnoreHmsError}
          >
            Continue
          </Button>,
          sendCommand.isPending ? null : ignoreHmsErrorAvailability.reason,
          { fill: true }
        ),
        overflow: <MenuItem disabled={sendCommand.isPending || !ignoreHmsErrorAvailability.allowed} onClick={requestIgnoreHmsError}>Continue</MenuItem>
      })
    }

    if (showCheckAssistantAction) {
      actions.push({
        key: 'check-assistant',
        inline: withDisabledActionReason(
          <Button
            size="sm"
            variant="soft"
            color="warning"
            startDecorator={<InfoOutlinedIcon />}
            disabled={!checkAssistantAvailability.allowed}
            onClick={requestCheckAssistant}
          >
            Check assistant
          </Button>,
          checkAssistantAvailability.reason
        ),
        overflow: <MenuItem disabled={!checkAssistantAvailability.allowed} onClick={requestCheckAssistant}>Check assistant</MenuItem>
      })
    }

    if (canControlPrinter && showConfirmAmsFilamentExtrudedAction) {
      actions.push({
        key: 'confirm-ams-filament-extruded',
        fill: true,
        inline: withDisabledActionReason(
          <Button
            size="sm"
            variant="soft"
            startDecorator={<TaskAltRoundedIcon />}
            disabled={sendCommand.isPending || !confirmAmsFilamentExtrudedAvailability.allowed}
            onClick={requestConfirmAmsFilamentExtruded}
          >
            Continue
          </Button>,
          sendCommand.isPending ? null : confirmAmsFilamentExtrudedAvailability.reason,
          { fill: true }
        ),
        overflow: <MenuItem disabled={sendCommand.isPending || !confirmAmsFilamentExtrudedAvailability.allowed} onClick={requestConfirmAmsFilamentExtruded}>Continue</MenuItem>
      })
    }

    if (canControlPrinter && canSkipObjects) {
      actions.push({
        key: 'skip-objects',
        fill: true,
        inline: <Button size="sm" variant="soft" color="warning" startDecorator={<MoveUpRoundedIcon style={{ transform: 'rotate(90deg)' }} />} disabled={sendCommand.isPending} onClick={() => setSkipObjectDialogOpen(true)}>Skip object</Button>,
        overflow: <MenuItem disabled={sendCommand.isPending} onClick={() => setSkipObjectDialogOpen(true)}>Skip object</MenuItem>
      })
    }

    if (canControlPrinter && showStopAction) {
      actions.push({
        key: 'stop',
        fill: true,
        inline: withDisabledActionReason(
          <Button
            size="sm"
            variant="soft"
            color="danger"
            startDecorator={<StopRoundedIcon />}
            disabled={sendCommand.isPending || !stopAvailability.allowed}
            onClick={requestStopPrint}
          >
            Stop
          </Button>,
          sendCommand.isPending ? null : stopAvailability.reason,
          { fill: true }
        ),
        overflow: <MenuItem disabled={sendCommand.isPending || !stopAvailability.allowed} onClick={requestStopPrint}>Stop</MenuItem>
      })
    }

    return actions
  }, [
    canControlPrinter,
    canSkipObjects,
    checkAssistantAvailability.allowed,
    checkAssistantAvailability.reason,
    confirmAmsFilamentExtrudedAvailability.allowed,
    confirmAmsFilamentExtrudedAvailability.reason,
    footerPluginSlots,
    ignoreHmsErrorAvailability.allowed,
    ignoreHmsErrorAvailability.reason,
    loadFilamentAvailability.allowed,
    loadFilamentAvailability.reason,
    pauseAvailability.allowed,
    pauseAvailability.reason,
    printer.id,
    printer.name,
    requestCheckAssistant,
    requestConfirmAmsFilamentExtruded,
    requestIgnoreHmsError,
    requestLoadFilament,
    requestRetryAmsFilamentChange,
    requestStopPrint,
    requestResumePrint,
    resumeAvailability.allowed,
    resumeAvailability.reason,
    retryAmsFilamentChangeAvailability.allowed,
    retryAmsFilamentChangeAvailability.reason,
    sendCommand
    ,showCheckAssistantAction
    ,showConfirmAmsFilamentExtrudedAction
    ,showIgnoreHmsContinueAction
    ,showLoadFilamentAction
    ,showPauseAction
    ,showResumeAction
    ,showRetryAmsFilamentChangeAction
    ,showStopAction
    ,stopAvailability.allowed
    ,stopAvailability.reason
  ])

  const footerActionGapPx = 8
  const reservedOverflowMenuButtonWidth = footerOverflowMenuButtonWidth ?? 36
  const footerOverflowKeys = resolvePrinterCardFooterOverflowKeys({
    actions: footerActions,
    actionWidths: footerActionWidths,
    rowWidth: footerActionRowWidth,
    overflowButtonWidth: reservedOverflowMenuButtonWidth,
    gapPx: footerActionGapPx
  })
  const measurableFooterActions = footerActions.filter((action) => !action.optional || (footerActionWidths[action.key] ?? 0) > 0)

  const visibleFooterActions = footerActions.filter((action) => !footerOverflowKeys.has(action.key))
  const overflowFooterActions = footerActions.filter((action) => footerOverflowKeys.has(action.key))
  const hasFooterControls = canShowPrintAction || measurableFooterActions.length > 0

  useEffect(() => {
    const node = layerSummaryRowRef.current
    if (!node) return undefined

    const updateWidth = () => {
      const nextWidth = Math.round(node.getBoundingClientRect().width)
      setLayerSummaryRowWidth((current) => (current === nextWidth ? current : nextWidth))
    }

    updateWidth()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth)
      return () => {
        window.removeEventListener('resize', updateWidth)
      }
    }

    const observer = new ResizeObserver(updateWidth)
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [showLayerSummary])

  useEffect(() => {
    const node = layerSummaryTextRef.current
    if (!node) return undefined

    const updateWidth = () => {
      const nextWidth = Math.round(node.getBoundingClientRect().width)
      setLayerSummaryWidth((current) => (current === nextWidth ? current : nextWidth))
    }

    updateWidth()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth)
      return () => {
        window.removeEventListener('resize', updateWidth)
      }
    }

    const observer = new ResizeObserver(updateWidth)
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [showCenteredLayerSummary, status?.currentLayer, status?.totalLayers])

  const measureFooterActions = useCallback(() => {
    const row = footerActionRowRef.current
    const nextRowWidth = row ? Math.round(row.getBoundingClientRect().width) : null
    setFooterActionRowWidth((current) => (current === nextRowWidth ? current : nextRowWidth))

    const nextActionWidths = Object.fromEntries(footerActions.map((action) => {
      const node = footerActionMeasureRefs.current[action.key]
      return [action.key, node ? Math.round(node.getBoundingClientRect().width) : 0]
    }))
    setFooterActionWidths((current) => areNumberMapsEqual(current, nextActionWidths) ? current : nextActionWidths)

    const overflowMenuButton = footerOverflowMenuMeasureRef.current
    const nextOverflowButtonWidth = overflowMenuButton ? Math.round(overflowMenuButton.getBoundingClientRect().width) : null
    setFooterOverflowMenuButtonWidth((current) => (current === nextOverflowButtonWidth ? current : nextOverflowButtonWidth))
  }, [footerActions])

  useLayoutEffect(() => {
    if (!contentSettings.footerControls) return undefined

    measureFooterActions()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measureFooterActions)
      return () => {
        window.removeEventListener('resize', measureFooterActions)
      }
    }

    let frameId: number | null = null
    const scheduleMeasurement = () => {
      if (frameId != null) window.cancelAnimationFrame(frameId)
      frameId = window.requestAnimationFrame(() => {
        frameId = null
        measureFooterActions()
      })
    }

    const observer = new ResizeObserver(scheduleMeasurement)
    const row = footerActionRowRef.current
    const measureRoot = footerActionMeasureRootRef.current
    const overflowMenuButton = footerOverflowMenuMeasureRef.current

    if (row) observer.observe(row)
    if (measureRoot) {
      observer.observe(measureRoot)
      for (const child of Array.from(measureRoot.children)) {
        observer.observe(child)
      }
    }
    if (overflowMenuButton) observer.observe(overflowMenuButton)

    return () => {
      if (frameId != null) window.cancelAnimationFrame(frameId)
      observer.disconnect()
    }
  }, [contentSettings.footerControls, footerActions, measureFooterActions])

  return (
    <Card
      ref={cardRef}
      variant="outlined"
      sx={{
        height: '100%',
        minWidth: 0,
        containerType: 'inline-size',
        containerName: 'printer-card',
        borderRadius: { xs: 'sm', sm: 'md' },
        '--Card-padding': { xs: '0.625rem', sm: '0.85rem' },
        pb: contentSettings.footerControls && hasFooterControls ? 0 : undefined
      }}
    >
      <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: { xs: 0.75, sm: 1 } }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, flex: 1 }}>
            {onOpenDetails ? (
              <Box
                component="button"
                type="button"
                tabIndex={0}
                onClick={onOpenDetails}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onOpenDetails()
                  }
                }}
                sx={{
                  '--printer-name-color': 'var(--joy-palette-text-secondary)',
                  minWidth: 0,
                  maxWidth: '100%',
                  flexShrink: 1,
                  p: 0,
                  border: 0,
                  background: 'transparent',
                  font: 'inherit',
                  textAlign: 'left',
                  cursor: 'pointer',
                  '&:hover, &:focus-visible': {
                    '--printer-name-color': 'var(--joy-palette-primary-200)'
                  },
                  '&:focus-visible': {
                    outline: '2px solid var(--joy-palette-focusVisible)',
                    outlineOffset: '3px',
                    borderRadius: 'var(--joy-radius-xs)'
                  }
                }}
              >
                <OverflowTooltipText
                  level="title-md"
                  noWrap
                  sx={{ minWidth: 0, maxWidth: '100%', color: 'var(--printer-name-color)', transition: 'color 0.15s ease' }}
                  className="printer-name-text"
                  text={printer.name}
                  observeRef={cardRef}
                />
              </Box>
            ) : (
              <OverflowTooltipText level="title-md" noWrap sx={{ minWidth: 0 }} text={printer.name} observeRef={cardRef} />
            )}
            <Tooltip
              arrow
              placement="top"
              title={(
                <Stack spacing={0.25} sx={{ py: 0.25 }}>
                  <Typography level="body-xs">IP: {printerIpAddress}</Typography>
                  <Typography level="body-xs">Wi-Fi signal: {wifiSignalLabel}</Typography>
                </Stack>
              )}
            >
              <Chip size="sm" variant="soft" color="neutral" sx={{ flexShrink: 0 }}>{printer.model}</Chip>
            </Tooltip>
            {nozzleSizeLabel && (
              <Tooltip arrow placement="top" title="Current nozzle size">
                <Chip size="sm" variant="soft" color="primary" sx={{ flexShrink: 0 }}>{nozzleSizeLabel}</Chip>
              </Tooltip>
            )}
          </Stack>
          {!isIdleLikeStage && (
            <Chip
              size="sm"
              variant="soft"
              color={stageLabelColor(status)}
              sx={{ flexShrink: 0 }}
            >
              {formatStageLabel(status)}
            </Chip>
          )}
          {showPendingDispatchSummary && activeJob && (
            <Chip
              size="sm"
              variant="soft"
              color={pendingStartWarning ? 'warning' : 'success'}
              sx={{ flexShrink: 0 }}
            >
              {pendingStartWarning ? 'Start delayed' : 'Waiting to start'}
            </Chip>
          )}
          {isOnline && status?.hmsErrors && status.hmsErrors.length > 0 && (
            <PrinterErrorChip
              chipLabel={status.hmsErrors.length > 1 ? `HMS ${status.hmsErrors.length}` : 'HMS'}
              menuTitle={status.hmsErrors.length > 1 ? `${status.hmsErrors.length} HMS alerts` : 'HMS alert'}
              errors={status.hmsErrors}
              printerModel={printer.model}
              printerSerial={printer.serial}
            />
          )}
          <PluginSlot name="printer.card.headerChips" context={{ printerId: printer.id, printerName: printer.name }} />
          <Dropdown>
            <MenuButton
              slots={{ root: IconButton }}
              slotProps={{ root: { size: 'sm', variant: 'plain', color: 'neutral', 'aria-label': 'Actions' } }}
            >
              <MoreVertIcon />
            </MenuButton>
            <Menu size="sm" placement="bottom-end">
              {canManagePrinter && <MenuItem onClick={onEdit}>Edit</MenuItem>}
              {canControlPrinter && <MenuItem disabled={!isOnline} onClick={() => sendCommand.mutate({ type: 'refresh' })}>Refresh</MenuItem>}
              {canManagePrinter && <MenuItem disabled={!isOnline} onClick={() => setPrinterSettingsDialogOpen(true)}>Printer settings…</MenuItem>}
              <PluginSlot name="printer.card.menuItems" context={{ printerId: printer.id, printerName: printer.name }} />
              {canControlPrinter && <MenuItem disabled={!isOnline} onClick={() => openControlsDialog()}>Controls…</MenuItem>}
              {canOpenAmsSettings && <MenuItem disabled={!isOnline} onClick={() => setAmsSettingsDialogOpen(true)}>AMS settings…</MenuItem>}
              {canControlPrinter && canShowCalibrate && (
                <MenuItem disabled={!canCalibrate} onClick={() => setCalibrationDialogOpen(true)}>Calibrate…</MenuItem>
              )}
              {canViewPrinterStorage && <MenuItem disabled={!isOnline} onClick={() => setStorageDialogOpen(true)}>Browse files…</MenuItem>}
              {canViewPrinterStorage && <MenuItem disabled={!isOnline} onClick={() => setModelsDialogOpen(true)}>Browse models…</MenuItem>}
              {canViewPrinterStorage && <MenuItem disabled={!isOnline} onClick={() => setTimelapsesDialogOpen(true)}>Browse timelapses…</MenuItem>}
              {canToggleExternalSpools && (
                <MenuItem onClick={() => setExternalSpoolsExpanded(!externalSpoolsExpanded)}>
                  {showExternalSpools ? 'Hide external spool' : 'Show external spool'}
                </MenuItem>
              )}
            </Menu>
          </Dropdown>
          <PluginSlot name="printer.card.dialogs" context={{ printerId: printer.id, printerName: printer.name }} />
        </Stack>

        <Divider sx={{ mb: 0.75 }} inset="context" />

        {!isOnline && (
          <Box
            sx={{
              minHeight: { xs: 92, sm: 108 },
              borderRadius: 'sm',
              border: '1px dashed var(--joy-palette-neutral-outlinedBorder)',
              backgroundColor: 'var(--joy-palette-background-level1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              px: { xs: 1.25, sm: 1.5 },
              py: { xs: 1.25, sm: 1.5 }
            }}
          >
            <Stack direction="row" spacing={1.25} alignItems="center" sx={{ minWidth: 0 }}>
              <Printer3dRoundedIcon color="disabled" fontSize="small" />
              <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                <Typography level="title-sm">Printer offline</Typography>
                <Typography level="body-xs" textColor="text.tertiary">
                  Live status is unavailable.
                </Typography>
              </Stack>
            </Stack>
          </Box>
        )}

        {isOnline && showMediaStrip && (
          <PrinterJobMediaStrip
            cover={showCoverTile ? {
              title: displayJobLabel,
              src: coverUrl,
              loaded: coverLoaded,
              failed: coverFailed,
              progress: showDeterminateCoverProgress ? coverProgress : null,
              loading: showIndeterminateCoverProgress || showDeterminateCoverProgress
            } : null}
            camera={cameraSurfaceVisible ? {
              printerId: printer.id,
              printerName: printer.name,
              showTile: showCameraTile && !showWideCamera,
              showWide: showWideCamera,
              openRequestedAt: cameraDialogOpenRequestedAt,
              onDialogClose: () => setCameraDialogOpenRequestedAt(null),
              paused: deferCameraSnapshotsForCover,
              freezeThumbnail: freezeCameraThumbnail,
              lightControls: cameraLightControls
            } : null}
            mobileTileSize={68}
            layout={contentSettings.fullWidthSnapshot ? 'snapshot-above' : 'inline'}
            showCenter={showPrintStatusBlock}
            centerJustify={showJobSummary || showDispatchSummary || showPendingDispatchSummary || terminalJobSummaryVisible || showHistoryJobSummary ? 'space-between' : 'center'}
          >
            {showPrintStatusBlock ? <>
              {showDispatchSummary && dispatchJob && (
                <>
                  <PrinterJobProgressBlock
                    header={<Typography level="body-sm" noWrap sx={{ minWidth: 0 }}>{dispatchPrintJob?.jobName ?? dispatchJob.jobName}</Typography>}
                    headerAside={(
                      <Chip
                        size="sm"
                        variant="soft"
                        color={dispatchStatusColor(dispatchJob.status)}
                        sx={{ flexShrink: 0 }}
                      >
                        {dispatchStatusLabel(dispatchJob.status)}
                      </Chip>
                    )}
                    determinate={dispatchJob.uploadPercent != null}
                    value={dispatchJob.uploadPercent ?? 0}
                    color={dispatchProgressColor(dispatchJob.status)}
                    fillColor={dispatchProgressFill(dispatchJob.status)}
                    trackColor={dispatchProgressTrack(dispatchJob.status)}
                    footer={<Typography level="body-xs" textColor="text.tertiary" noWrap>{formatDispatchProgress(dispatchJob)}</Typography>}
                  />
                </>
              )}
              {showPendingDispatchSummary && activeJob && (
                <>
                  <PrinterJobProgressBlock
                    header={<Typography level="body-sm" noWrap sx={{ minWidth: 0 }}>{activeTrackedDisplayJobName || activeJob.jobName}</Typography>}
                    determinate={false}
                    value={0}
                    color={pendingStartWarning ? 'warning' : 'success'}
                    footer={(
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ textWrap: 'pretty' }}>
                        {pendingStartWarning
                          ? 'The job was dispatched, but the printer still has not reported activity. Check the printer for any prompt, error, or start failure.'
                          : 'Print dispatched. Waiting for printer...'}
                      </Typography>
                    )}
                  />
                </>
              )}
              {showJobSummary && status?.progressPercent != null && (
                <PrinterJobProgressBlock
                  header={status?.jobName ? (
                    <OverflowTooltipText
                      level="body-xs"
                      noWrap
                      sx={{ minWidth: 0, flex: 1, flexShrink: 1 }}
                      text={activeDisplayJobName || status.jobName}
                      observeRef={cardRef}
                    />
                  ) : (
                    <Box sx={{ minWidth: 0, flex: 1 }} />
                  )}
                  headerAside={status?.progressPercent != null ? (
                    <Typography level="body-xs">{Math.round(status.progressPercent)}%</Typography>
                  ) : undefined}
                  determinate
                  value={status.progressPercent}
                  color={progressBarColor(status)}
                  fillColor={progressBarFill(status)}
                  trackColor={progressBarTrack(status)}
                  afterProgress={secondaryStageLabel ? (
                    <OverflowTooltipText
                      level="body-xs"
                      textColor={secondaryStageTextColor(status)}
                      noWrap
                      sx={{ minWidth: 0 }}
                      text={secondaryStageLabel}
                      observeRef={cardRef}
                    />
                  ) : undefined}
                  footer={!secondaryStageLabel ? (
                    <Stack
                      ref={layerSummaryRowRef}
                      direction="row"
                      justifyContent="space-between"
                      alignItems="center"
                      spacing={1}
                      sx={showCenteredLayerSummary
                        ? {
                            minWidth: 0,
                            display: 'grid',
                            // Size the side cells to their content so the finish-time ETA keeps
                            // its full width (incl. the AM/PM suffix) instead of sharing an equal
                            // 1fr split with the shorter "X left" label and getting clipped.
                            // hideLayerSummaryForWidth already guarantees the measured widths fit.
                            gridTemplateColumns: 'minmax(max-content, 1fr) auto minmax(max-content, 1fr)',
                            alignItems: 'center'
                          }
                        : { minWidth: 0 }}
                    >
                      {status.remainingMinutes != null ? (
                        <OverflowTooltipText
                          level="body-xs"
                          textColor="text.tertiary"
                          noWrap
                          sx={showCenteredLayerSummary
                            ? { minWidth: 0, textAlign: 'left' }
                            : { minWidth: 0, flex: 1, flexShrink: 0 }}
                          text={`${formatRemaining(status.remainingMinutes)} left`}
                          observeRef={cardRef}
                          onMetricsChange={({ naturalWidth }) => {
                            const nextWidth = Math.round(naturalWidth)
                            setRemainingSummaryWidth((current) => (current === nextWidth ? current : nextWidth))
                          }}
                        />
                      ) : (
                        <Box sx={showCenteredLayerSummary ? { minWidth: 0 } : { minWidth: 0, flex: 1 }} />
                      )}
                      {showCenteredLayerSummary && (
                        <Typography
                          ref={layerSummaryTextRef}
                          level="body-xs"
                          textColor="text.tertiary"
                          noWrap
                          sx={{ flexShrink: 0, px: 0.5, textAlign: 'center' }}
                        >
                          {formatLayerSummary(status)}
                        </Typography>
                      )}
                      {status.remainingMinutes != null && !secondaryStageLabel && (
                        <OverflowTooltipText
                          level="body-xs"
                          textColor="text.tertiary"
                          noWrap
                          sx={showCenteredLayerSummary
                            ? { minWidth: 0, textAlign: 'right' }
                            : { minWidth: 0, flex: 1, flexShrink: 0, textAlign: 'right' }}
                          text={formatEstimatedCompletionTime(status.remainingMinutes)}
                          observeRef={cardRef}
                          onMetricsChange={({ naturalWidth }) => {
                            const nextWidth = Math.round(naturalWidth)
                            setEtaSummaryWidth((current) => (current === nextWidth ? current : nextWidth))
                          }}
                        />
                      )}
                    </Stack>
                  ) : undefined}
                />
              )}
              {terminalJobSummaryVisible && (
                <PrinterJobProgressBlock
                  header={(
                    <OverflowTooltipText
                      level="body-xs"
                      noWrap
                      sx={{ minWidth: 0, flex: 1, flexShrink: 1 }}
                      text={activeDisplayJobName || historyDisplayJobName || status?.jobName || latestJob?.jobName || 'Last job'}
                      observeRef={cardRef}
                    />
                  )}
                  determinate
                  value={100}
                  color="danger"
                  afterProgress={(
                    <OverflowTooltipText
                      level="body-xs"
                      noWrap
                      sx={{
                        minWidth: 0,
                        flex: 1,
                        color: printerAttentionSummary?.kind === 'hmsError'
                          ? 'var(--joy-palette-warning-300)'
                          : 'var(--joy-palette-danger-300)'
                      }}
                      text={printerAttentionSummaryText ?? 'Printer reported this job as failed.'}
                      observeRef={cardRef}
                    />
                  )}
                />
              )}
              {showHistoryJobSummary && latestJob && (
                <PrinterJobProgressBlock
                  header={(
                    <OverflowTooltipText
                      level="body-xs"
                      noWrap
                      sx={{ minWidth: 0, flex: 1, flexShrink: 1 }}
                      text={historyDisplayJobName || latestJob.jobName}
                      observeRef={cardRef}
                    />
                  )}
                  showProgress={latestJobProgressPercent != null}
                  determinate
                  value={latestJobProgressPercent ?? 0}
                  color={printerHistoryResultColor(latestJob.result)}
                  footer={(
                    <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                      <Typography level="body-xs" textColor="text.tertiary" noWrap>
                        {latestJob.result === 'success'
                          ? latestJobFinishedAgo
                            ? `Print finished ${latestJobFinishedAgo}`
                            : 'Print finished'
                          : latestJobProgressPercent != null
                            ? `${Math.round(latestJobProgressPercent)}%`
                            : 'Last job'}
                      </Typography>
                      {showHistoryResultChip && (
                        <Chip
                          size="sm"
                          variant="soft"
                          color={printerHistoryResultColor(latestJob.result)}
                          sx={{ flexShrink: 0 }}
                        >
                          {latestJob.result}
                        </Chip>
                      )}
                    </Stack>
                  )}
                />
              )}
              {!showJobSummary && !showDispatchSummary && !showPendingDispatchSummary && !showHistoryJobSummary && !terminalJobSummaryVisible && cameraVisible && (
                <Typography level="body-xs" textColor="text.tertiary">No active job</Typography>
              )}
            </> : null}
          </PrinterJobMediaStrip>
        )}

        {isOnline && printerAttentionSummaryText && !terminalJobSummaryVisible && (
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
            <OverflowTooltipText
              level="body-xs"
              noWrap
              sx={{
                minWidth: 0,
                flex: 1,
                color: printerAttentionSummary?.kind === 'hmsError'
                  ? 'var(--joy-palette-warning-300)'
                  : 'var(--joy-palette-danger-300)'
              }}
              text={printerAttentionSummaryText}
              observeRef={cardRef}
            />
            {clearActivePrinterError && (
              <IconButton
                size="sm"
                variant="plain"
                color="danger"
                aria-label="Clear printer error"
                disabled={sendCommand.isPending}
                onClick={clearActivePrinterError}
                sx={{ minHeight: 0, minWidth: 0, p: 0.25, flexShrink: 0 }}
              >
                ✕
              </IconButton>
            )}
          </Stack>
        )}

        {isOnline && status && (
          contentSettings.nozzleTemperatures
          || contentSettings.bedTemperature
          || contentSettings.chamberTemperature
          || contentSettings.printSpeed
          || showDoorStateChip
          || showDuctStateChip
        ) && (
          <Stack
            direction="row"
            spacing={{ xs: 0.5, sm: 0.75 }}
            sx={{ flexWrap: 'wrap', alignItems: 'center' }}
          >
            {contentSettings.nozzleTemperatures && nozzleReadouts.length > 1 ? (
              <DualTempReadout
                icon={<HeaterThermometerIcon color="warning" />}
                ariaLabel="Nozzle temperatures"
                values={nozzleReadouts}
                showTargets={!compact}
                onClick={canOpenControls ? () => openControlsDialog('temperature') : undefined}
              />
            ) : contentSettings.nozzleTemperatures ? (
              <TempReadout
                icon={<HeaterThermometerIcon color="warning" />}
                ariaLabel="Nozzle temperature"
                current={status.nozzleTemp}
                target={compact ? null : status.nozzleTarget}
                tooltipTarget={status.nozzleTarget}
                onClick={canOpenControls ? () => openControlsDialog('temperature') : undefined}
              />
            ) : null}
            {contentSettings.bedTemperature && (
              <TempReadout
                icon={<HeaterThermometerIcon color="primary" />}
                ariaLabel="Bed temperature"
                current={status.bedTemp}
                target={compact ? null : status.bedTarget}
                tooltipTarget={status.bedTarget}
                onClick={canOpenControls ? () => openControlsDialog('temperature') : undefined}
              />
            )}
            {contentSettings.chamberTemperature && showChamberTemperature && (
              <TempReadout
                icon={<HeaterThermometerIcon color="success" />}
                ariaLabel="Chamber temperature"
                current={chamberTemperature}
                target={compact ? null : chamberTarget}
                tooltipTarget={chamberTarget}
                onClick={canOpenControls ? () => openControlsDialog('temperature') : undefined}
              />
            )}
            {contentSettings.printSpeed && status.speedLevel != null && (
              <MetricChip
                icon={<SpeedRoundedIcon fontSize="inherit" />}
                ariaLabel="Print speed"
                value={speedLabel(status.speedLevel)}
                onClick={canOpenControls ? () => openControlsDialog('speed') : undefined}
              />
            )}
            {showDoorStateChip && (
              <MetricChip
                icon={<MeetingRoomRoundedIcon fontSize="inherit" />}
                ariaLabel="Door state"
                value={status.doorOpen ? 'Door open' : 'Door closed'}
              />
            )}
            {showDuctStateChip && status.ductMode && (
              <MetricChip
                icon={<AirRoundedIcon fontSize="inherit" />}
                ariaLabel="Duct mode"
                value={`Duct ${formatDuctMode(status.ductMode)}`}
              />
            )}
          </Stack>
        )}

        {contentSettings.amsCards && isOnline && (amsUnits.length > 0 || externalSpools.length > 0) && (
          <Box
            sx={{
              display: 'grid',
              gap: { xs: 0.5, sm: 0.75 },
              gridTemplateColumns: {
                xs: 'repeat(4, minmax(0, 1fr))',
                sm: `repeat(${amsGridColumns}, minmax(0, 1fr))`
              },
              '& > *': { minWidth: 0 }
            }}
          >
            {amsUnits.map((unit) => (
              <Box
                key={unit.unitId}
                sx={{
                  gridColumn: {
                    xs: `span ${amsUnitSlotSpan(unit)}`,
                    sm: `span ${amsUnitSlotSpan(unit)}`
                  }
                }}
              >
                <AmsUnitRow
                  unit={unit}
                  compact={amsUnitSlotSpan(unit) < 4}
                  onRefresh={canControlPrinter ? () => sendCommand.mutate({ type: 'refresh' }) : undefined}
                  onOpenDrying={canManagePrinter ? () => setAmsDryingUnitId(unit.unitId) : undefined}
                  onEditSlot={editAmsSlot ? (slot) => editAmsSlot(unit, slot) : undefined}
                  onRescanSlot={rescanAmsSlot ? (slot) => rescanAmsSlot(unit, slot) : undefined}
                  onResetSlot={resetAmsSlot ? (slot) => resetAmsSlot(unit, slot) : undefined}
                  slotActionsDisabled={sendCommand.isPending}
                />
              </Box>
            ))}
            {showExternalSpools && externalSpools.map((spool) => (
              <Box
                key={spool.amsId}
                sx={{
                  gridColumn: {
                    xs: 'span 1',
                    sm: 'span 1'
                  }
                }}
              >
                <ExternalSpoolRow
                  spool={spool}
                  spoolCount={externalSpools.length}
                  compact={cardsPerRow >= 4}
                  onEdit={canManagePrinter ? () => setEditingExternalSpool(spool) : undefined}
                />
              </Box>
            ))}
          </Box>
        )}

        {/* HMS errors are surfaced via the chip in the card header. */}
      </CardContent>
      {contentSettings.footerControls && hasFooterControls && (
      <CardOverflow variant="plain">
        <Divider sx={{ mb: 0.5 }} inset="context" />
        <CardActions
          sx={{
            pt: { xs: 1, sm: 1.25 },
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 1
          }}
        >
          <Box
            aria-hidden
            ref={footerActionMeasureRootRef}
            sx={{
              position: 'absolute',
              visibility: 'hidden',
              pointerEvents: 'none',
              height: 0,
              overflow: 'hidden',
              whiteSpace: 'nowrap'
            }}
          >
            {footerActions.map((action) => (
              <Box
                key={`measure:${action.key}`}
                ref={(node) => {
                  footerActionMeasureRefs.current[action.key] = node as HTMLDivElement | null
                }}
                sx={{ display: 'inline-flex', mr: 1 }}
              >
                {action.inline}
              </Box>
            ))}
            <IconButton ref={footerOverflowMenuMeasureRef} size="sm" variant="soft" color="neutral" aria-label="Measure footer actions menu">
              <MoreVertIcon />
            </IconButton>
          </Box>
          <Box
            ref={footerActionRowRef}
            sx={{
              width: '100%',
              display: 'flex',
              flexWrap: 'nowrap',
              justifyContent: 'flex-start',
              alignItems: 'center',
              minWidth: 0,
              gap: 1,
                '& .printer-card-action:empty': {
                  display: 'none'
                },
              '& .printer-card-action': {
                flexShrink: 0
              },
              '& .printer-card-fill-action': {
                flexShrink: 0
              },
              '& .printer-card-fill-action > .MuiButton-root': {
                width: '100%',
                whiteSpace: 'nowrap'
              },
              '@container printer-card (min-width: 310px) and (max-width: 340px)': {
                '& .printer-card-fill-action': {
                  flex: '1 1 0',
                  minWidth: 0
                }
              }
            }}
          >
            {canShowPrintAction && (
              <>
                {withDisabledActionReason(
                  <ButtonGroup
                    ref={printAnchorRef}
                    size="sm"
                    variant="solid"
                    color="primary"
                    aria-label="print"
                  >
                    <Button disabled={!canPrintFromPrinter} onClick={onPrint} startDecorator={<PrintRoundedIcon />}>Print</Button>
                    <IconButton
                      size="sm"
                      disabled={!canPrintFromPrinter}
                      aria-controls={printMenuOpen ? `print-menu-${printer.id}` : undefined}
                      aria-expanded={printMenuOpen ? 'true' : undefined}
                      aria-haspopup="menu"
                      aria-label="More print options"
                      onClick={() => setPrintMenuOpen((value) => !value)}
                    >
                      <ArrowDropDownIcon />
                    </IconButton>
                  </ButtonGroup>,
                  printDisabledReason
                )}
                <Menu
                  id={`print-menu-${printer.id}`}
                  open={canPrintFromPrinter && printMenuOpen}
                  onClose={() => setPrintMenuOpen(false)}
                  anchorEl={printAnchorRef.current}
                  placement="bottom-end"
                >
                  <MenuItem
                    disabled={!canPrintFromPrinter}
                    onClick={() => {
                      setPrintMenuOpen(false)
                      onPrint()
                    }}
                  >
                    Print from library…
                  </MenuItem>
                  <MenuItem
                    disabled={!canPrintFromPrinter}
                    onClick={() => {
                      setPrintMenuOpen(false)
                      onPrintLocal()
                    }}
                  >
                    Print from local file…
                  </MenuItem>
                </Menu>
              </>
            )}
            {visibleFooterActions.map((action) => (
              <Box
                key={action.key}
                className={action.fill ? 'printer-card-action printer-card-fill-action' : 'printer-card-action'}
                sx={{ display: 'flex', minWidth: 0 }}
              >
                {action.inline}
              </Box>
            ))}
            {overflowFooterActions.length > 0 && (
              <Dropdown>
                <MenuButton
                  slots={{ root: IconButton }}
                  slotProps={{ root: { size: 'sm', variant: 'soft', color: 'neutral', 'aria-label': 'More footer actions' } }}
                >
                  <MoreVertIcon />
                </MenuButton>
                <Menu size="sm" placement="bottom-end">
                  {overflowFooterActions.map((action) => (
                    <Fragment key={action.key}>
                      {action.overflow}
                    </Fragment>
                  ))}
                </Menu>
              </Dropdown>
            )}
          </Box>
        </CardActions>
      </CardOverflow>
      )}
      {storageDialogOpen && (
        <PrinterStorageModal
          printerId={printer.id}
          printerName={printer.name}
          printerModel={printer.model}
          allowPrint={canDispatchPrints}
          allowUpload={canManagePrinter && !demoMode}
          allowDownload={canDownloadPrinterStorage}
          allowManage={canManagePrinter}
          onClose={() => setStorageDialogOpen(false)}
        />
      )}
      {modelsDialogOpen && (
        <PrinterStorageModal
          printerId={printer.id}
          printerName={printer.name}
          printerModel={printer.model}
          title={`Models on ${printer.name}`}
          description="Sliced 3MF/G-code files stored on the printer. Tap a file to print it."
          acceptExtensions={/\.(3mf|gcode)$/i}
          previewKind="model"
          flat
          allowPrint={canDispatchPrints}
          allowDownload={canDownloadPrinterStorage}
          allowManage={canManagePrinter}
          allowUpload={false}
          onClose={() => setModelsDialogOpen(false)}
        />
      )}
      {timelapsesDialogOpen && (
        <PrinterStorageModal
          printerId={printer.id}
          printerName={printer.name}
          printerModel={printer.model}
          title={`Timelapses on ${printer.name}`}
          description="Recorded timelapses on the printer's SD card."
          initialPath="/timelapse"
          acceptExtensions={/\.mp4$/i}
          previewKind="timelapse"
          flat
          allowPrint={false}
          allowDownload={canDownloadPrinterStorage}
          allowManage={canManagePrinter}
          allowUpload={false}
          onClose={() => setTimelapsesDialogOpen(false)}
        />
      )}
      {canManagePrinter && amsSettingsDialogOpen && status && (
        <AmsSettingsModal
          printerName={printer.name}
          settings={status.amsSettings}
          submitting={sendCommand.isPending}
          onClose={() => setAmsSettingsDialogOpen(false)}
          onUpdateUserSettings={(settingsCommand) => sendCommand.mutate(settingsCommand)}
          onUpdateFilamentBackup={(enabled) => sendCommand.mutate({ type: 'setAmsFilamentBackup', enabled })}
        />
      )}
      {canManagePrinter && currentDryingUnit && (
        <AmsDryingModal
          printerName={printer.name}
          unit={currentDryingUnit}
          submitting={sendCommand.isPending}
          onClose={() => setAmsDryingUnitId(null)}
          onStart={(command) => sendCommand.mutate(command)}
          onStop={(amsId) => sendCommand.mutate({ type: 'stopAmsDrying', amsId })}
        />
      )}
      {filamentRecoveryDialogOpen && (
        <FilamentRecoveryDialog
          printerName={printer.name}
          sources={filamentRecoverySources}
          submitting={sendCommand.isPending}
          onClose={() => setFilamentRecoveryDialogOpen(false)}
          onLoad={(command) => {
            setFilamentRecoveryDialogOpen(false)
            sendCommand.mutate(command)
          }}
        />
      )}
      {assistantDialogOpen && status && (
        <PrinterAssistantDialog
          printerName={printer.name}
          printerModel={printer.model}
          printerSerial={printer.serial}
          status={status}
          canOpenLiveView={canOpenAssistantLiveView && jumpToLiveViewAvailability.allowed}
          canLoadFilament={showLoadFilamentAction && filamentRecoverySources.length > 0}
          onClose={() => setAssistantDialogOpen(false)}
          onOpenLiveView={() => {
            setAssistantDialogOpen(false)
            setCameraDialogOpenRequestedAt(Date.now())
          }}
          onLoadFilament={() => {
            setAssistantDialogOpen(false)
            setFilamentRecoveryDialogOpen(true)
          }}
        />
      )}
      {canManagePrinter && editingSlot && (
        <AmsSlotEditModal
          printerId={printer.id}
          status={status}
          unit={currentEditingUnit ?? editingSlot.unit}
          slot={currentEditingSlot ?? editingSlot.slot}
          defaultNozzleTemp={resolveFilamentChangeTargetTemp(currentEditingSlot ?? editingSlot.slot) ?? 220}
          rescanActive={currentEditingSlot?.isReading ?? false}
          onClose={() => setEditingSlot(null)}
        />
      )}
      {canManagePrinter && editingExternalSpool && (
        <ExternalSpoolEditModal
          printerId={printer.id}
          status={status}
          spool={currentEditingExternalSpool ?? editingExternalSpool}
          spoolCount={externalSpools.length}
          defaultNozzleTemp={defaultExternalSpoolTemp}
          onClose={() => setEditingExternalSpool(null)}
        />
      )}
      {canControlPrinter && calibrationDialogOpen && (
        <CalibrationModal
          capabilities={calibrationCapabilities}
          printerName={printer.name}
          submitting={sendCommand.isPending}
          onClose={() => setCalibrationDialogOpen(false)}
          onSubmit={(command) => sendCommand.mutate(command)}
        />
      )}
      {canControlPrinter && controlsDialogOpen && status && (
        <PrinterControlsDialog
          printer={printer}
          status={status}
          capabilities={controlCapabilities}
          initialTab={controlsDialogInitialTab}
          submitting={sendCommand.isPending}
          onClose={() => setControlsDialogOpen(false)}
          onSubmit={(command) => sendCommand.mutate(command)}
        />
      )}
      {canManagePrinter && printerSettingsDialogOpen && status && (
        <PrinterSettingsDialog
          printerModel={printer.model}
          printerName={printer.name}
          ductMode={status.ductMode}
          ductAvailableModes={status.ductAvailableModes}
          settings={status.printOptions}
          submitting={sendCommand.isPending}
          onClose={() => setPrinterSettingsDialogOpen(false)}
          onSubmit={(command) => sendCommand.mutate(command)}
        />
      )}
      {canControlPrinter && skipObjectDialogOpen && canSkipObjects && (
        <SkipObjectsModal
          printerName={printer.name}
          objects={activePrintObjects}
          loading={activePrintObjectsLoading}
          unavailable={activePrintObjectsQuery.isError || (!activePrintObjectsLoading && activePrintObjects.length === 0)}
          unavailableReason={activePrintObjectsUnavailableReason}
          unavailableMessage={activePrintObjectsUnavailableMessage}
          submitting={sendCommand.isPending}
          onClose={() => {
            void queryClient.cancelQueries({ queryKey: ['printer-active-print-objects', printer.id] })
            setSkipObjectDialogOpen(false)
          }}
          onSkip={(objectIds) => sendCommand.mutate({ type: 'skipObjects', objectIds })}
        />
      )}
    </Card>
  )
}

function areNumberMapsEqual(left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return rightKeys.every((key) => left[key] === right[key])
}

function PrinterHistoryCard({
  job,
  canDeleteJobs,
  canDispatchPrints,
  canControlPrinters,
  deletingJobId,
  replayingJobId,
  onDelete,
  onReprintLibrary,
  onReprintCalibration
}: {
  job: PrintJob
  canDeleteJobs: boolean
  canDispatchPrints: boolean
  canControlPrinters: boolean
  deletingJobId: string | null
  replayingJobId: string | null
  onDelete: (jobId: string) => void
  onReprintLibrary: (job: PrintJob) => void
  onReprintCalibration: (jobId: string) => void
}) {
  const canReprintLibrary = Boolean(
    canDispatchPrints
    && job.finishedAt
    && job.jobKind === 'file'
    && job.fileId
    && isDirectPrintableFileName(job.fileName || job.jobName || '')
  )
  const canReprintCalibration = Boolean(
    canControlPrinters
    && job.finishedAt
    && job.jobKind === 'calibration'
    && job.calibrationOption != null
  )

  const reprintAction = canReprintLibrary ? (
    <Button size="sm" variant="soft" startDecorator={<RestartAltRoundedIcon />} onClick={() => onReprintLibrary(job)}>
      Reprint
    </Button>
  ) : canReprintCalibration ? (
    <Button
      size="sm"
      variant="soft"
      startDecorator={<RestartAltRoundedIcon />}
      loading={replayingJobId === job.id}
      onClick={() => onReprintCalibration(job.id)}
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
      loading={deletingJobId === job.id}
      onClick={() => onDelete(job.id)}
    >
      Delete
    </Button>
  ) : undefined
  const action = reprintAction || deleteAction ? (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      {reprintAction}
      {deleteAction}
    </Stack>
  ) : undefined

  return <PrintJobHistoryCard job={job} showPrinterLink={false} action={action} />
}

function printerHistoryResultColor(result: PrintJob['result']): 'neutral' | 'success' | 'warning' | 'danger' {
  switch (result) {
    case 'success':
      return 'success'
    case 'failed':
      return 'danger'
    case 'cancelled':
      return 'warning'
    case 'unknown':
      return 'neutral'
  }
}


function PrinterStatsCardGrid({
  stats
}: {
  stats: PrinterStatsResponse['stats']
}) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: 'minmax(0, 1fr)',
          sm: 'repeat(2, minmax(0, 1fr))',
          xl: 'repeat(2, minmax(0, 1fr))'
        },
        gap: 1.5
      }}
    >
      <BreakdownStatCard
        icon={<QueryStatsRoundedIcon />}
        label="Total prints"
        primaryValue={formatPrinterStatsWholeNumber(stats.totalPrints)}
        description="All recorded jobs for this printer across its lifetime in this workspace."
        items={[
          {
            label: 'Successful',
            value: formatPrinterStatsWholeNumber(stats.successfulPrints),
            amount: stats.successfulPrints,
            color: SUCCESS_COLOR
          },
          {
            label: 'Failed',
            value: formatPrinterStatsWholeNumber(stats.failedPrints),
            amount: stats.failedPrints,
            color: FAILED_COLOR
          },
          {
            label: 'Cancelled',
            value: formatPrinterStatsWholeNumber(stats.cancelledPrints),
            amount: stats.cancelledPrints,
            color: CANCELLED_COLOR
          }
        ]}
      />
      <BreakdownStatCard
        icon={<AccessTimeRoundedIcon />}
        label="Print hours"
        primaryValue={`${formatPrinterStatsDecimal(stats.totalPrintHours)} h`}
        description="Printer runtime."
        items={[
          {
            label: 'Successful',
            value: `${formatPrinterStatsDecimal(stats.successfulPrintHours)} h`,
            amount: stats.successfulPrintHours,
            color: SUCCESS_COLOR
          },
          {
            label: 'Failed',
            value: `${formatPrinterStatsDecimal(stats.failedPrintHours)} h`,
            amount: stats.failedPrintHours,
            color: FAILED_COLOR
          },
          {
            label: 'Cancelled',
            value: `${formatPrinterStatsDecimal(stats.cancelledPrintHours)} h`,
            amount: stats.cancelledPrintHours,
            color: CANCELLED_COLOR
          }
        ]}
      />
      <BreakdownStatCard
        icon={<ScaleRoundedIcon />}
        label="Filament printed"
        primaryValue={stats.filamentKilogramsPrinted == null ? 'Not tracked yet' : `${formatPrinterStatsDecimal(stats.filamentKilogramsPrinted)} kg`}
        description="Tracked filament mass."
        items={[
          {
            label: 'Successful',
            value: stats.successfulFilamentKilogramsPrinted == null ? 'Not tracked' : `${formatPrinterStatsDecimal(stats.successfulFilamentKilogramsPrinted)} kg`,
            amount: stats.successfulFilamentKilogramsPrinted ?? 0,
            color: SUCCESS_COLOR
          },
          {
            label: 'Failed',
            value: stats.failedFilamentKilogramsPrinted == null ? 'Not tracked' : `${formatPrinterStatsDecimal(stats.failedFilamentKilogramsPrinted)} kg`,
            amount: stats.failedFilamentKilogramsPrinted ?? 0,
            color: FAILED_COLOR
          },
          {
            label: 'Cancelled',
            value: stats.cancelledFilamentKilogramsPrinted == null ? 'Not tracked' : `${formatPrinterStatsDecimal(stats.cancelledFilamentKilogramsPrinted)} kg`,
            amount: stats.cancelledFilamentKilogramsPrinted ?? 0,
            color: CANCELLED_COLOR
          }
        ]}
      />
      <BreakdownStatCard
        icon={<StraightenRoundedIcon />}
        label="Filament length"
        primaryValue={stats.filamentMetersPrinted == null ? 'Not tracked yet' : `${formatPrinterStatsDecimal(stats.filamentMetersPrinted)} m`}
        description={stats.filamentFeetPrinted == null ? 'Linear filament usage recorded for finished prints on this printer.' : `${formatPrinterStatsDecimal(stats.filamentFeetPrinted)} ft total tracked.`}
        items={[
          {
            label: 'Successful',
            value: stats.successfulFilamentMetersPrinted == null || stats.successfulFilamentFeetPrinted == null ? 'Not tracked' : `${formatPrinterStatsDecimal(stats.successfulFilamentMetersPrinted)} m / ${formatPrinterStatsDecimal(stats.successfulFilamentFeetPrinted)} ft`,
            amount: stats.successfulFilamentMetersPrinted ?? 0,
            color: SUCCESS_COLOR
          },
          {
            label: 'Failed',
            value: stats.failedFilamentMetersPrinted == null || stats.failedFilamentFeetPrinted == null ? 'Not tracked' : `${formatPrinterStatsDecimal(stats.failedFilamentMetersPrinted)} m / ${formatPrinterStatsDecimal(stats.failedFilamentFeetPrinted)} ft`,
            amount: stats.failedFilamentMetersPrinted ?? 0,
            color: FAILED_COLOR
          },
          {
            label: 'Cancelled',
            value: stats.cancelledFilamentMetersPrinted == null || stats.cancelledFilamentFeetPrinted == null ? 'Not tracked' : `${formatPrinterStatsDecimal(stats.cancelledFilamentMetersPrinted)} m / ${formatPrinterStatsDecimal(stats.cancelledFilamentFeetPrinted)} ft`,
            amount: stats.cancelledFilamentMetersPrinted ?? 0,
            color: CANCELLED_COLOR
          }
        ]}
      />
    </Box>
  )
}

function formatPrinterStatsWholeNumber(value: number): string {
  return new Intl.NumberFormat().format(value)
}

function formatPrinterStatsDecimal(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
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
    projectFilamentChips: []
  }
}

function PrinterSettingsDialog({
  printerModel,
  printerName,
  ductMode,
  ductAvailableModes,
  settings,
  submitting,
  onClose,
  onSubmit
}: {
  printerModel: PrinterModel
  printerName: string
  ductMode: PrinterAirductMode | null
  ductAvailableModes: PrinterSelectableAirductMode[]
  settings: PrinterStatus['printOptions']
  submitting: boolean
  onClose: () => void
  onSubmit: (command: PrinterSettingsDialogCommand) => void
}) {
  const supportedSections = PRINTER_SETTINGS_SECTIONS
    .map((section) => ({
      ...section,
      options: section.options.filter((option) => settings[option].supported)
    }))
    .filter((section) => section.options.length > 0)
  const supportsAirManagement = getPrinterDisplayCapabilities(printerModel).airductMode
  const airManagementLocked = ductMode === 'laser'
  const availableAirManagementModes = ductAvailableModes.length > 0 ? ductAvailableModes : AIR_MANAGEMENT_MODES
  const selectedAirManagementMode: PrinterSelectableAirductMode = ductMode === 'heating' ? 'heating' : 'cooling'

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '96vw', sm: 720 }, maxWidth: '100%' }}>
        <ModalClose />
        <Typography level="h4">Printer settings for {printerName}</Typography>
        <Typography level="body-sm" textColor="text.tertiary" sx={{ mb: 1 }}>
          These options come from the printer&apos;s live capability report. Unsupported settings stay hidden.
        </Typography>

        <ScrollableDialogBody>
          <Stack spacing={1.5}>
            {supportsAirManagement && (
              <Stack spacing={1}>
                <Typography level="title-sm">Air management</Typography>
                <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                  <Stack spacing={1.25}>
                    {airManagementLocked ? (
                      <>
                        <Typography level="body-sm">Current mode: {formatDuctMode('laser')}</Typography>
                        <Typography level="body-xs" color="warning">
                          Air management cannot be changed while the printer reports laser mode.
                        </Typography>
                      </>
                    ) : (
                      <FormControl size="sm" disabled={submitting || availableAirManagementModes.length === 0}>
                        <FormLabel>Mode</FormLabel>
                        <Select
                          value={selectedAirManagementMode}
                          onChange={(_event, value) => {
                            if (!value || value === selectedAirManagementMode) return
                            onSubmit({ type: 'setAirductMode', mode: value })
                          }}
                        >
                          {availableAirManagementModes.map((value) => (
                            <Option key={value} value={value}>{formatDuctMode(value)}</Option>
                          ))}
                        </Select>
                      </FormControl>
                    )}
                    <Typography level="body-xs" textColor="text.tertiary">
                      Supported modes come from the printer's live report when firmware exposes them.
                    </Typography>
                  </Stack>
                </Sheet>
              </Stack>
            )}
            {supportedSections.length === 0 && !supportsAirManagement ? (
              <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'md' }}>
                <Typography level="body-sm">This printer has not reported any configurable Bambu Studio-style settings yet.</Typography>
              </Sheet>
            ) : supportedSections.map((section) => (
              <Stack key={section.title} spacing={1}>
                <Typography level="title-sm">{section.title}</Typography>
                {section.options.map((optionKey) => {
                  const option = settings[optionKey]
                  const supportsSensitivity = printOptionSupportsSensitivity(optionKey)
                  const selectedSensitivity = ('sensitivity' in option ? option.sensitivity : null) ?? defaultPrintOptionSensitivity(optionKey)
                  return (
                    <Sheet key={optionKey} variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'flex-start' }}>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Checkbox
                            label={PRINTER_SETTINGS_LABELS[optionKey]}
                            checked={option.enabled ?? false}
                            disabled={submitting}
                            onChange={(event) => onSubmit({
                              type: 'setPrintOption',
                              option: optionKey,
                              enabled: event.target.checked,
                              ...(supportsSensitivity ? { sensitivity: selectedSensitivity } : {})
                            })}
                          />
                          <Typography level="body-xs" textColor="text.tertiary" sx={{ ml: 3.25, mt: 0.5 }}>
                            {PRINTER_SETTINGS_DESCRIPTIONS[optionKey]}
                          </Typography>
                        </Box>
                        {supportsSensitivity && (
                          <FormControl size="sm" sx={{ minWidth: { xs: '100%', sm: 180 } }}>
                            <FormLabel>Sensitivity</FormLabel>
                            <Select
                              value={selectedSensitivity}
                              disabled={submitting}
                              onChange={(_event, value) => {
                                if (!value) return
                                onSubmit({
                                  type: 'setPrintOption',
                                  option: optionKey,
                                  enabled: option.enabled ?? false,
                                  sensitivity: value
                                })
                              }}
                            >
                              {printOptionSensitivityOptions(optionKey).map((value) => (
                                <Option key={value} value={value}>{printOptionSensitivityLabel(value)}</Option>
                              ))}
                            </Select>
                          </FormControl>
                        )}
                      </Stack>
                    </Sheet>
                  )
                })}
              </Stack>
            ))}
          </Stack>
        </ScrollableDialogBody>

        <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 2 }}>
          <Button variant="plain" onClick={onClose}>Close</Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

function printOptionSupportsSensitivity(option: PrinterPrintOptionKey): boolean {
  return option === 'aiMonitoring'
    || option === 'spaghettiDetection'
    || option === 'purgeChutePileupDetection'
    || option === 'nozzleClumpingDetection'
    || option === 'airPrintingDetection'
}

function printOptionSensitivityOptions(option: PrinterPrintOptionKey): PrinterPrintOptionSensitivity[] {
  return option === 'aiMonitoring' ? AI_MONITORING_SENSITIVITY_OPTIONS : DETECTION_SENSITIVITY_OPTIONS
}

function defaultPrintOptionSensitivity(_option: PrinterPrintOptionKey): PrinterPrintOptionSensitivity {
  return 'medium'
}

function printOptionSensitivityLabel(value: PrinterPrintOptionSensitivity): string {
  switch (value) {
    case 'never_halt':
      return 'Never halt'
    case 'low':
      return 'Low'
    case 'medium':
      return 'Medium'
    case 'high':
      return 'High'
  }
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

function dispatchStatusLabel(status: PrintDispatchJob['status']): string {
  switch (status) {
    case 'queued':
      return 'Queued'
    case 'uploading':
      return 'Sending'
    case 'sent':
      return 'Sent'
    case 'cancelled':
      return 'Cancelled'
    case 'failed':
      return 'Failed'
  }
}

function formatDispatchProgress(job: PrintDispatchJob): string {
  if (job.status === 'uploading' && job.uploadTotalBytes) {
    const percent = job.uploadPercent != null ? ` (${Math.round(job.uploadPercent)}%)` : ''
    const attempt = job.uploadAttempt > 1 && job.uploadMaxAttempts > 1 ? ` - attempt ${job.uploadAttempt} of ${job.uploadMaxAttempts}` : ''
    return `${formatBytes(job.uploadBytesSent)} of ${formatBytes(job.uploadTotalBytes)}${percent}${attempt}`
  }
  return `${job.progressMessage} - ${formatBytes(job.fileSizeBytes)}`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unit]}`
}

function CalibrationModal({
  capabilities,
  printerName,
  submitting,
  onClose,
  onSubmit
}: {
  capabilities: ReturnType<typeof getPrinterCalibrationCapabilities>
  printerName: string
  submitting: boolean
  onClose: () => void
  onSubmit: (command: Extract<PrinterCommand, { type: 'calibrate' }>) => void
}) {
  const [xcam, setXcam] = useState<boolean>(false)
  const [bedLeveling, setBedLeveling] = useState(capabilities.bedLeveling)
  const [vibration, setVibration] = useState(capabilities.vibration)
  const [motorNoise, setMotorNoise] = useState(false)
  const [nozzleOffset, setNozzleOffset] = useState(false)
  const [highTempHeatbed, setHighTempHeatbed] = useState(false)
  const [nozzleClumping, setNozzleClumping] = useState(false)
  const hasSelection = xcam || bedLeveling || vibration || motorNoise || nozzleOffset || highTempHeatbed || nozzleClumping

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ width: { xs: '94vw', sm: 420 } }}>
        <ModalClose />
        <Typography level="h4">Calibrate {printerName}</Typography>
        <Stack spacing={1.25} sx={{ mt: 1 }}>
          {capabilities.bedLeveling && (
            <Checkbox label="Auto bed leveling" checked={bedLeveling} onChange={(event) => setBedLeveling(event.target.checked)} />
          )}
          {capabilities.vibration && (
            <Checkbox label="Vibration compensation" checked={vibration} onChange={(event) => setVibration(event.target.checked)} />
          )}
          {capabilities.motorNoise && (
            <Checkbox label="Motor noise cancellation" checked={motorNoise} onChange={(event) => setMotorNoise(event.target.checked)} />
          )}
          {capabilities.nozzleOffset && (
            <Checkbox label="Nozzle offset calibration" checked={nozzleOffset} onChange={(event) => setNozzleOffset(event.target.checked)} />
          )}
          {capabilities.highTempHeatbed && (
            <Checkbox label="High-temperature bed leveling" checked={highTempHeatbed} onChange={(event) => setHighTempHeatbed(event.target.checked)} />
          )}
          {capabilities.xcam && (
            <Checkbox label="Micro Lidar calibration" checked={xcam} onChange={(event) => setXcam(event.target.checked)} />
          )}
          {capabilities.nozzleClumping && (
            <Checkbox label="Nozzle clumping detection" checked={nozzleClumping} onChange={(event) => setNozzleClumping(event.target.checked)} />
          )}
        </Stack>
        <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 2 }}>
          <Button variant="plain" color="neutral" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            startDecorator={<Printer3dRoundedIcon />}
            loading={submitting}
            disabled={!hasSelection}
            onClick={() => onSubmit({
              type: 'calibrate',
              xcam,
              bedLeveling,
              vibration,
              motorNoise,
              nozzleOffset,
              highTempHeatbed,
              nozzleClumping
            })}
          >
            Start
          </Button>
        </Stack>
      </ModalDialog>
    </Modal>
  )
}

function PrinterControlsDialog({
  printer,
  status,
  capabilities,
  initialTab,
  submitting,
  onClose,
  onSubmit
}: {
  printer: Printer
  status: PrinterStatus
  capabilities: ReturnType<typeof getPrinterControlCapabilities>
  initialTab: PrinterControlsDialogTab
  submitting: boolean
  onClose: () => void
  onSubmit: (command: PrinterControlCommand) => void
}) {
  const nozzles = printerNozzles(status)
  const [temperatureInputs, setTemperatureInputs] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const nozzle of nozzles) {
      initial[`nozzle:${nozzle.extruderId}`] = suggestedTemperatureInput(nozzle.currentTemp, nozzle.targetTemp)
    }
    initial.bed = suggestedTemperatureInput(status.bedTemp, status.bedTarget)
    if (capabilities.chamberTemperature) {
      initial.chamber = suggestedTemperatureInput(status.chamberTemp, status.chamberTarget)
    }
    return initial
  })
  const [fanInputs, setFanInputs] = useState<Record<PrinterFanId, string>>(() => ({
    part: suggestedPercentInput(status.partFanPercent),
    aux: suggestedPercentInput(status.auxFanPercent),
    chamber: suggestedPercentInput(status.chamberFanPercent)
  }))
  const [activeTab, setActiveTab] = useState<PrinterControlsDialogTab>(initialTab)
  const [motionStep, setMotionStep] = useState<1 | 10>(10)
  const negativeMotionStep: -1 | -10 = motionStep === 10 ? -10 : -1
  const canAdjustPrintSpeed = canUsePrintSpeedControl(status)
  const canUseMotion = canUseMotionControl(status)
  const canUseAnyExtruderControl = nozzles.some((nozzle) => canUseExtruderControl(status, nozzle.extruderId))
  const chamberTempMax = getPrinterChamberTemperatureMax(printer.model)
  const stackedControlReadoutInset = 14
  const controllableLights = CONTROLLABLE_LIGHT_NODES.filter((node) => node === 'chamber' || status.lightCapabilities[node])
  const showWorkLight = status.lightCapabilities.work
  const hasFanControls = capabilities.partFan || capabilities.auxFan || capabilities.chamberFan
  const hasExtruderControls = capabilities.extruderControl

  const updateTemperatureInput = (key: string, value: string) => {
    setTemperatureInputs((current) => ({ ...current, [key]: value }))
  }

  const updateFanInput = (fan: PrinterFanId, value: string) => {
    setFanInputs((current) => ({ ...current, [fan]: value }))
  }

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '96vw', sm: 720 }, maxWidth: '100%' }}>
        <ModalClose />
        <Typography level="h4">Controls for {printer.name}</Typography>
        <Typography level="body-sm" textColor="text.tertiary" sx={{ mb: 1 }}>
          Only controls that are safe and supported for the current printer state are enabled.
        </Typography>

        <Tabs
          value={activeTab}
          onChange={(_event, value) => {
            if (typeof value === 'string') setActiveTab(value as PrinterControlsDialogTab)
          }}
          sx={{ minWidth: 0 }}
        >
          <TabList
            sx={{
              mb: 1,
              flexWrap: 'wrap',
              rowGap: 0.75,
              columnGap: 0.75
            }}
          >
            <Tab value="printer">Lights</Tab>
            <Tab value="speed">Speed</Tab>
            <Tab value="temperature">Temperatures</Tab>
            {hasFanControls && <Tab value="fans">Fans</Tab>}
            <Tab value="motion">Motion</Tab>
            {hasExtruderControls && <Tab value="extruder">Extruder</Tab>}
          </TabList>

          <ScrollableDialogBody>
            <Stack spacing={1.25}>
              {activeTab === 'printer' && (
                <DialogSection title="Lights" wrapInSheet={false}>
                  <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                    <Stack spacing={1}>
                      {controllableLights.map((node) => {
                        const mode = lightModeForControl(status, node)
                        const lightOn = isActiveLightMode(mode)
                        return (
                          <Stack key={node} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                            <Box sx={{ flex: 1, minWidth: 0 }}>
                              <Typography level="body-sm">{lightNodeLabel(node)}</Typography>
                              <Typography level="body-xs" textColor="text.tertiary">
                                {formatLightMode(mode)}
                              </Typography>
                            </Box>
                            <Button
                              size="sm"
                              variant={lightOn ? 'soft' : 'solid'}
                              color={lightOn ? 'warning' : 'neutral'}
                              startDecorator={<LightbulbIcon on={lightOn} />}
                              disabled={!status.online || submitting}
                              onClick={() => onSubmit({ type: 'light', node, on: !lightOn })}
                            >
                              {lightOn ? 'Turn off' : 'Turn on'}
                            </Button>
                          </Stack>
                        )
                      })}
                      {showWorkLight && (
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Typography level="body-sm">{lightNodeLabel('work')}</Typography>
                            <Typography level="body-xs" textColor="text.tertiary">
                              {formatLightMode(status.lightModes.work)}
                            </Typography>
                          </Box>
                          <Chip size="sm" variant="soft" color="neutral">Read-only</Chip>
                        </Stack>
                      )}
                    </Stack>
                    {!status.online && (
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 1 }}>
                        Printer actions are only available while the printer is connected.
                      </Typography>
                    )}
                  </Sheet>
                </DialogSection>
              )}

              {activeTab === 'speed' && (
                <DialogSection title="Print speed" wrapInSheet={false}>
                  <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                    <ButtonGroup size="sm" orientation="vertical" aria-label="Print speed" sx={{ width: '100%', '& > *': { minWidth: 0 } }}>
                      {[1, 2, 3, 4].map((level) => (
                        <Button
                          key={level}
                          variant={status.speedLevel === level ? 'solid' : 'soft'}
                          color={status.speedLevel === level ? 'primary' : 'neutral'}
                          disabled={!canAdjustPrintSpeed || submitting}
                          onClick={() => onSubmit({ type: 'setPrintSpeed', level: level as 1 | 2 | 3 | 4 })}
                          sx={{ px: { xs: 1, sm: 1.5 } }}
                        >
                          {speedLabel(level)}
                        </Button>
                      ))}
                    </ButtonGroup>
                    {!canAdjustPrintSpeed && (
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 1 }}>
                        Print speed can only be changed while a print is active.
                      </Typography>
                    )}
                  </Sheet>
                </DialogSection>
              )}

              {activeTab === 'temperature' && (
                <DialogSection title="Temperatures" wrapInSheet={false}>
                  <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                    <Stack spacing={1}>
                      {nozzles.map((nozzle) => {
                const label = capabilities.dualNozzles
                  ? nozzle.extruderId === 0
                    ? 'Right nozzle'
                    : 'Left nozzle'
                  : 'Nozzle'
                const inputKey = `nozzle:${nozzle.extruderId}`
                const parsedTarget = parseIntegerInput(temperatureInputs[inputKey] ?? '', 0, 320)
                const hardwareSummary = formatNozzleHardwareSummary(nozzle)
                return (
                  <Stack key={inputKey} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                    <Box sx={{ minWidth: { sm: 150 }, pr: { xs: stackedControlReadoutInset, sm: 0 } }}>
                      <Stack
                        direction={{ xs: 'row', sm: 'column' }}
                        spacing={{ xs: 0.75, sm: 0.25 }}
                        alignItems={{ xs: 'baseline', sm: 'flex-start' }}
                        sx={{
                          minWidth: 0,
                          flexWrap: { xs: 'wrap', sm: 'nowrap' },
                          justifyContent: { xs: 'space-between', sm: 'flex-start' }
                        }}
                      >
                        <Typography level="body-sm">{label}</Typography>
                        {hardwareSummary && (
                          <Typography
                            level="body-xs"
                            textColor="text.tertiary"
                            sx={{ minWidth: 0, textAlign: { xs: 'right', sm: 'left' } }}
                          >
                            {hardwareSummary}
                          </Typography>
                        )}
                        <Typography
                          level="body-xs"
                          textColor="text.tertiary"
                          sx={{ minWidth: 0, flexBasis: { xs: '100%', sm: 'auto' }, textAlign: { xs: 'right', sm: 'left' } }}
                        >
                          Now {formatTemperatureValue(nozzle.currentTemp)} · Target {formatTemperatureValue(nozzle.targetTemp)}
                        </Typography>
                      </Stack>
                    </Box>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1, minWidth: 0, justifyContent: { sm: 'flex-end' } }}>
                      <Input
                        type="number"
                        value={temperatureInputs[inputKey] ?? ''}
                        onChange={(event) => updateTemperatureInput(inputKey, event.target.value)}
                        endDecorator="°C"
                        sx={{ flex: 1, minWidth: 0, maxWidth: { sm: 160 } }}
                      />
                      <Button
                        size="sm"
                        disabled={!status.online || parsedTarget == null || submitting}
                        onClick={() => parsedTarget != null && onSubmit({ type: 'setNozzleTemperature', extruderId: nozzle.extruderId, target: parsedTarget })}
                      >
                        Set
                      </Button>
                      <Button
                        size="sm"
                        variant="plain"
                        disabled={!status.online || submitting}
                        onClick={() => onSubmit({ type: 'setNozzleTemperature', extruderId: nozzle.extruderId, target: 0 })}
                      >
                        Off
                      </Button>
                    </Stack>
                  </Stack>
                        )
                      })}
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                <Box sx={{ minWidth: { sm: 150 }, pr: { xs: stackedControlReadoutInset, sm: 0 } }}>
                  <Stack
                    direction={{ xs: 'row', sm: 'column' }}
                    spacing={{ xs: 0.75, sm: 0.25 }}
                    alignItems={{ xs: 'baseline', sm: 'flex-start' }}
                    sx={{
                      minWidth: 0,
                      flexWrap: { xs: 'wrap', sm: 'nowrap' },
                      justifyContent: { xs: 'space-between', sm: 'flex-start' }
                    }}
                  >
                    <Typography level="body-sm">Bed</Typography>
                    <Typography level="body-xs" textColor="text.tertiary" sx={{ minWidth: 0, textAlign: { xs: 'right', sm: 'left' } }}>
                      Now {formatTemperatureValue(status.bedTemp)} · Target {formatTemperatureValue(status.bedTarget)}
                    </Typography>
                  </Stack>
                </Box>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1, minWidth: 0, justifyContent: { sm: 'flex-end' } }}>
                  <Input
                    type="number"
                    value={temperatureInputs.bed ?? ''}
                    onChange={(event) => updateTemperatureInput('bed', event.target.value)}
                    endDecorator="°C"
                    sx={{ flex: 1, minWidth: 0, maxWidth: { sm: 160 } }}
                  />
                  <Button
                    size="sm"
                    disabled={!status.online || parseIntegerInput(temperatureInputs.bed ?? '', 0, 120) == null || submitting}
                    onClick={() => {
                      const parsedTarget = parseIntegerInput(temperatureInputs.bed ?? '', 0, 120)
                      if (parsedTarget != null) onSubmit({ type: 'setBedTemperature', target: parsedTarget })
                    }}
                  >
                    Set
                  </Button>
                  <Button
                    size="sm"
                    variant="plain"
                    disabled={!status.online || submitting}
                    onClick={() => onSubmit({ type: 'setBedTemperature', target: 0 })}
                  >
                    Off
                  </Button>
                </Stack>
                      </Stack>
                      {capabilities.chamberTemperature && (
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                  <Box sx={{ minWidth: { sm: 150 }, pr: { xs: stackedControlReadoutInset, sm: 0 } }}>
                    <Stack
                      direction={{ xs: 'row', sm: 'column' }}
                      spacing={{ xs: 0.75, sm: 0.25 }}
                      alignItems={{ xs: 'baseline', sm: 'flex-start' }}
                      sx={{
                        minWidth: 0,
                        flexWrap: { xs: 'wrap', sm: 'nowrap' },
                        justifyContent: { xs: 'space-between', sm: 'flex-start' }
                      }}
                    >
                      <Typography level="body-sm">Chamber</Typography>
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ minWidth: 0, textAlign: { xs: 'right', sm: 'left' } }}>
                        Now {formatTemperatureValue(status.chamberTemp)} · Target {formatTemperatureValue(status.chamberTarget)}
                      </Typography>
                    </Stack>
                  </Box>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1, minWidth: 0, justifyContent: { sm: 'flex-end' } }}>
                    <Input
                      type="number"
                      value={temperatureInputs.chamber ?? ''}
                      onChange={(event) => updateTemperatureInput('chamber', event.target.value)}
                      endDecorator="°C"
                      sx={{ flex: 1, minWidth: 0, maxWidth: { sm: 160 } }}
                    />
                    <Button
                      size="sm"
                      disabled={!status.online || parseIntegerInput(temperatureInputs.chamber ?? '', 0, chamberTempMax) == null || submitting}
                      onClick={() => {
                        const parsedTarget = parseIntegerInput(temperatureInputs.chamber ?? '', 0, chamberTempMax)
                        if (parsedTarget != null) onSubmit({ type: 'setChamberTemperature', target: parsedTarget })
                      }}
                    >
                      Set
                    </Button>
                    <Button
                      size="sm"
                      variant="plain"
                      disabled={!status.online || submitting}
                      onClick={() => onSubmit({ type: 'setChamberTemperature', target: 0 })}
                    >
                      Off
                    </Button>
                  </Stack>
                        </Stack>
                      )}
                      {!status.online && (
                        <Typography level="body-xs" textColor="text.tertiary">
                          Temperature controls are only available while the printer is connected.
                        </Typography>
                      )}
                    </Stack>
                  </Sheet>
                </DialogSection>
              )}

              {activeTab === 'fans' && hasFanControls && (
                <DialogSection title="Fans" wrapInSheet={false}>
                  <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                    <Stack spacing={1}>
                      {([
                { fan: 'part', label: 'Part fan', supported: capabilities.partFan, current: status.partFanPercent },
                { fan: 'aux', label: 'Aux fan', supported: capabilities.auxFan, current: status.auxFanPercent },
                { fan: 'chamber', label: 'Chamber fan', supported: capabilities.chamberFan, current: status.chamberFanPercent }
              ] as const)
                .filter((entry) => entry.supported)
                .map((entry) => {
                  const parsedPercent = parseIntegerInput(fanInputs[entry.fan], 0, 100)
                  return (
                    <Stack key={entry.fan} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                      <Box sx={{ minWidth: { sm: 150 }, pr: { xs: stackedControlReadoutInset, sm: 0 } }}>
                        <Stack
                          direction={{ xs: 'row', sm: 'column' }}
                          spacing={{ xs: 0.75, sm: 0.25 }}
                          alignItems={{ xs: 'baseline', sm: 'flex-start' }}
                          sx={{
                            minWidth: 0,
                            flexWrap: { xs: 'wrap', sm: 'nowrap' },
                            justifyContent: { xs: 'space-between', sm: 'flex-start' }
                          }}
                        >
                          <Typography level="body-sm">{entry.label}</Typography>
                          <Typography level="body-xs" textColor="text.tertiary" sx={{ minWidth: 0, textAlign: { xs: 'right', sm: 'left' } }}>
                            Current {formatPercentValue(entry.current)}
                          </Typography>
                        </Stack>
                      </Box>
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1, minWidth: 0, justifyContent: { sm: 'flex-end' } }}>
                        <Input
                          type="number"
                          value={fanInputs[entry.fan]}
                          onChange={(event) => updateFanInput(entry.fan, event.target.value)}
                          endDecorator="%"
                          sx={{ flex: 1, minWidth: 0, maxWidth: { sm: 160 } }}
                        />
                        <Button
                          size="sm"
                          disabled={!status.online || parsedPercent == null || submitting}
                          onClick={() => parsedPercent != null && onSubmit({ type: 'setFanSpeed', fan: entry.fan, percent: parsedPercent })}
                        >
                          Set
                        </Button>
                        <Button
                          size="sm"
                          variant="plain"
                          disabled={!status.online || submitting}
                          onClick={() => onSubmit({ type: 'setFanSpeed', fan: entry.fan, percent: 0 })}
                        >
                          Off
                        </Button>
                      </Stack>
                    </Stack>
                  )
                })}
                      {!status.online && (
                        <Typography level="body-xs" textColor="text.tertiary">
                          Fan controls are only available while the printer is connected.
                        </Typography>
                      )}
                    </Stack>
                  </Sheet>
                </DialogSection>
              )}

              {activeTab === 'motion' && (
                <DialogSection
                  title="Motion control"
                  description={`Current stage: ${formatStageLabel(status)}`}
                  wrapInSheet={false}
                >
                  <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                    <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center" sx={{ mb: 1, flexWrap: 'wrap', rowGap: 0.75 }}>
                      <Box sx={{ flex: 1 }} />
                      <ButtonGroup size="sm">
                        {[1, 10].map((step) => (
                          <Button
                            key={step}
                            variant={motionStep === step ? 'solid' : 'soft'}
                            onClick={() => setMotionStep(step as 1 | 10)}
                          >
                            {step} mm
                          </Button>
                        ))}
                      </ButtonGroup>
                    </Stack>
                    <Stack direction="row" spacing={1} alignItems="stretch" sx={{ minWidth: 0 }}>
              <Box
                sx={{
                  display: 'grid',
                  gap: 1,
                  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                  flex: 1,
                  minWidth: 0,
                  flexShrink: 1
                }}
              >
                <Box />
                <Button
                  size="sm"
                  sx={{ minHeight: 64 }}
                  aria-label={`Move Y positive ${motionStep} millimeters`}
                  disabled={!canUseMotion || submitting}
                  onClick={() => onSubmit({ type: 'moveAxis', axis: 'Y', distanceMm: motionStep })}
                >
                  <ArrowUpwardRoundedIcon fontSize="small" />
                </Button>
                <Box />
                <Button
                  size="sm"
                  sx={{ minHeight: 64 }}
                  aria-label={`Move X negative ${motionStep} millimeters`}
                  disabled={!canUseMotion || submitting}
                  onClick={() => onSubmit({ type: 'moveAxis', axis: 'X', distanceMm: negativeMotionStep })}
                >
                  <ArrowBackRoundedIcon fontSize="small" />
                </Button>
                <Button size="sm" variant="soft" sx={{ minHeight: 64 }} disabled={!canUseMotion || submitting} onClick={() => onSubmit({ type: 'homeAxes' })}>Home</Button>
                <Button
                  size="sm"
                  sx={{ minHeight: 64 }}
                  aria-label={`Move X positive ${motionStep} millimeters`}
                  disabled={!canUseMotion || submitting}
                  onClick={() => onSubmit({ type: 'moveAxis', axis: 'X', distanceMm: motionStep })}
                >
                  <ArrowForwardRoundedIcon fontSize="small" />
                </Button>
                <Box />
                <Button
                  size="sm"
                  sx={{ minHeight: 64 }}
                  aria-label={`Move Y negative ${motionStep} millimeters`}
                  disabled={!canUseMotion || submitting}
                  onClick={() => onSubmit({ type: 'moveAxis', axis: 'Y', distanceMm: negativeMotionStep })}
                >
                  <ArrowDownwardRoundedIcon fontSize="small" />
                </Button>
                <Box />
              </Box>
              <Divider orientation="vertical" sx={{ alignSelf: 'stretch' }} />
              <Stack spacing={1} sx={{ flexShrink: 0, alignSelf: 'stretch', minWidth: 128 }}>
                <Button
                  size="sm"
                  sx={{ flex: 1, minHeight: 64, minWidth: 128 }}
                  aria-label={`Move the bed up ${motionStep} millimeters`}
                  disabled={!canUseMotion || submitting}
                  onClick={() => onSubmit({ type: 'moveAxis', axis: 'Z', distanceMm: negativeMotionStep })}
                >
                  <ArrowUpwardRoundedIcon fontSize="small" />
                </Button>
                <Button
                  size="sm"
                  sx={{ flex: 1, minHeight: 64, minWidth: 128 }}
                  aria-label={`Move the bed down ${motionStep} millimeters`}
                  disabled={!canUseMotion || submitting}
                  onClick={() => onSubmit({ type: 'moveAxis', axis: 'Z', distanceMm: motionStep })}
                >
                  <ArrowDownwardRoundedIcon fontSize="small" />
                </Button>
              </Stack>
                    </Stack>
                    {!canUseMotion && (
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 1 }}>
                        Motion control is only available while the printer is idle.
                      </Typography>
                    )}
                  </Sheet>
                </DialogSection>
              )}

              {activeTab === 'extruder' && hasExtruderControls && (
                <DialogSection title="Extruder control" wrapInSheet={false}>
                  <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                    <Stack spacing={1}>
                      {nozzles.map((nozzle) => {
                  const label = capabilities.dualNozzles
                    ? nozzle.extruderId === 0
                      ? 'Right nozzle'
                      : 'Left nozzle'
                    : 'Nozzle'
                  const canControlThisExtruder = canUseExtruderControl(status, nozzle.extruderId)
                  return (
                    <Stack key={`extruder:${nozzle.extruderId}`} direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography level="body-sm">{label}</Typography>
                        <Typography level="body-xs" textColor="text.tertiary">
                          Current {formatTemperatureValue(nozzle.currentTemp)}
                        </Typography>
                      </Box>
                      <Stack spacing={1} sx={{ flexShrink: 0 }}>
                        <Button
                          size="sm"
                          variant="soft"
                          disabled={!canControlThisExtruder || submitting}
                          onClick={() => onSubmit({ type: 'extrudeFilament', extruderId: nozzle.extruderId, distanceMm: negativeMotionStep })}
                        >
                          Retract {motionStep} mm
                        </Button>
                        <Button
                          size="sm"
                          disabled={!canControlThisExtruder || submitting}
                          onClick={() => onSubmit({ type: 'extrudeFilament', extruderId: nozzle.extruderId, distanceMm: motionStep })}
                        >
                          Extrude {motionStep} mm
                        </Button>
                      </Stack>
                    </Stack>
                  )
                      })}
                      {!canUseAnyExtruderControl && (
                        <Typography level="body-xs" textColor="text.tertiary">
                          Extruder control requires an idle printer and a nozzle temperature of at least {PRINTER_EXTRUDER_CONTROL_MIN_TEMP_C}°C.
                        </Typography>
                      )}
                    </Stack>
                  </Sheet>
                </DialogSection>
              )}
            </Stack>
          </ScrollableDialogBody>
        </Tabs>

        <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 2 }}>
          <Button variant="plain" onClick={onClose}>Close</Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

function SkipObjectsModal({
  printerName,
  objects,
  loading,
  unavailable,
  unavailableReason,
  unavailableMessage,
  submitting,
  onClose,
  onSkip
}: {
  printerName: string
  objects: PrinterActivePrintObjects['objects']
  loading: boolean
  unavailable: boolean
  unavailableReason: PrinterActivePrintObjects['unavailableReason']
  unavailableMessage: PrinterActivePrintObjects['unavailableMessage']
  submitting: boolean
  onClose: () => void
  onSkip: (objectIds: number[]) => void
}) {
  const [selectedObjectIds, setSelectedObjectIds] = useState<number[]>([])

  const selectedObjectIdSet = useMemo(() => new Set(selectedObjectIds), [selectedObjectIds])
  const previewObjects = useMemo(() => {
    return objects.filter((object) => object.previewPath && object.previewBounds)
  }, [objects])
  const objectLabels = useMemo(() => {
    const totals = new Map<string, number>()
    for (const object of objects) {
      const label = object.name.trim() || 'Unnamed object'
      totals.set(label, (totals.get(label) ?? 0) + 1)
    }

    const seen = new Map<string, number>()
    return new Map(objects.map((object) => {
      const label = object.name.trim() || 'Unnamed object'
      const total = totals.get(label) ?? 0
      if (total <= 1) return [object.id, label] as const

      const index = (seen.get(label) ?? 0) + 1
      seen.set(label, index)
      return [object.id, `${label} ${index}/${total}`] as const
    }))
  }, [objects])

  const previewViewBox = useMemo(() => {
    if (previewObjects.length === 0) return null
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const object of previewObjects) {
      const bounds = object.previewBounds
      if (!bounds) continue
      minX = Math.min(minX, bounds.minX)
      minY = Math.min(minY, bounds.minY)
      maxX = Math.max(maxX, bounds.maxX)
      maxY = Math.max(maxY, bounds.maxY)
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null
    }
    const padding = 4
    return {
      minX: minX - padding,
      minY: minY - padding,
      width: Math.max(1, maxX - minX + padding * 2),
      height: Math.max(1, maxY - minY + padding * 2),
      flipY: minY + maxY
    }
  }, [previewObjects])
  const previewAspectRatio = useMemo(
    () => previewViewBox ? previewViewBox.width / previewViewBox.height : 1,
    [previewViewBox]
  )
  const previewPanelHeight = useMemo(
    () => ({
      xs: previewAspectRatio < 0.8 ? 'min(42svh, 360px)' : 'min(38svh, 320px)',
      md: previewAspectRatio < 0.8 ? 'min(48dvh, 520px)' : 'min(56dvh, 560px)'
    }),
    [previewAspectRatio]
  )

  const allObjectIds = useMemo(() => objects.map((object) => object.id), [objects])
  const allSelected = objects.length > 0 && selectedObjectIds.length === objects.length
  const partiallySelected = selectedObjectIds.length > 0 && selectedObjectIds.length < objects.length

  const toggleObject = (objectId: number) => {
    setSelectedObjectIds((current) => {
      return current.includes(objectId)
        ? current.filter((value) => value !== objectId)
        : [...current, objectId]
    })
  }

  const toggleAllObjects = (checked: boolean) => {
    setSelectedObjectIds(checked ? allObjectIds : [])
  }

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog
        sx={{
          width: { xs: '96vw', md: 920 },
          maxWidth: '100%'
          // Let the dialog size to its content and grow up to the viewport cap that
          // ScrollableModalDialog already enforces; the body scrolls once that's reached.
        }}
      >
        <ModalClose />
        <Typography level="h4">Skip object on {printerName}</Typography>
        <Typography level="body-sm" textColor="text.tertiary" sx={{ mt: 0.25 }}>
          Choose one or more objects from the current plate to cancel while the rest of the print continues.
        </Typography>

        <ScrollableDialogBody sx={{ mt: 1 }}>
          <Box
            sx={{
              display: 'grid',
              gap: 1.25,
              gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) 280px' },
              alignItems: 'stretch',
              minHeight: 0,
              '& > *': { minWidth: 0 }
            }}
          >
            <DialogSection title="Preview">
              <Box
                sx={{
                  minWidth: 0,
                  minHeight: { xs: 0, md: 'auto' },
                  height: previewPanelHeight,
                  borderRadius: 'xl',
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'background.level1'
                }}
              >
                {loading ? (
                  <Stack direction="row" spacing={1} alignItems="center">
                    <CircularProgress size="sm" />
                    <Typography level="body-sm">Loading first-layer object map…</Typography>
                  </Stack>
                ) : previewViewBox ? (
                  <Box
                    component="svg"
                    viewBox={`${previewViewBox.minX} ${previewViewBox.minY} ${previewViewBox.width} ${previewViewBox.height}`}
                    preserveAspectRatio="xMidYMid meet"
                    sx={{
                      width: '100%',
                      height: '100%',
                      maxWidth: '100%',
                      maxHeight: '100%',
                      display: 'block',
                      flex: 1
                    }}
                  >
                    <g transform={`translate(0 ${previewViewBox.flipY}) scale(1 -1)`}>
                      {previewObjects.map((object) => {
                        const selected = selectedObjectIdSet.has(object.id)
                        const label = objectLabels.get(object.id) ?? 'Unnamed object'
                        return (
                          <path
                            key={object.id}
                            d={object.previewPath ?? ''}
                            fill={selected ? 'var(--joy-palette-warning-300)' : 'rgba(255, 255, 255, 0.72)'}
                            fillRule="evenodd"
                            stroke="none"
                            style={{
                              cursor: submitting ? 'default' : 'pointer',
                              filter: selected ? 'drop-shadow(0 0 0.45rem rgba(255, 221, 63, 0.35))' : undefined,
                              transition: 'fill 120ms ease, filter 120ms ease'
                            }}
                            onClick={submitting ? undefined : () => toggleObject(object.id)}
                          >
                            <title>{label}</title>
                          </path>
                        )
                      })}
                    </g>
                  </Box>
                ) : (
                  <Typography level="body-sm" textColor="text.tertiary" sx={{ px: 2, textAlign: 'center' }}>
                    First-layer shape data is unavailable for this print, but the object list can still be used.
                  </Typography>
                )}
              </Box>
            </DialogSection>

            <DialogSection title="Objects">
              <Stack spacing={1.25} sx={{ minHeight: 0 }}>
                <Checkbox
                  label="Select all"
                  checked={allSelected}
                  indeterminate={partiallySelected}
                  disabled={loading || objects.length === 0 || submitting}
                  onChange={(event) => toggleAllObjects(event.target.checked)}
                />
                <Divider />
                <Box
                  sx={{
                    minHeight: 0,
                    // Let the full list render; the dialog body scrolls as one unit once the
                    // preview + list exceed the viewport cap, rather than a nested mini-scroller.
                    pr: 0.5
                  }}
                >
                  <Stack spacing={0.75}>
                    {!loading && unavailable && (
                      <Stack spacing={0.5}>
                        <Typography level="body-sm" textColor="text.tertiary">
                          This print did not expose skippable object metadata.
                        </Typography>
                        {unavailableReason === 'internalStorageUnsupported' && unavailableMessage ? (
                          <Typography level="body-xs" textColor="text.tertiary">
                            {unavailableMessage}
                          </Typography>
                        ) : (
                          <Typography level="body-xs" textColor="text.tertiary">
                            Some newer printer and firmware combinations only expose this data when the job is stored on printer-accessible external media.
                          </Typography>
                        )}
                      </Stack>
                    )}

                    {!loading && !unavailable && objects.map((object) => {
                      const label = objectLabels.get(object.id) ?? 'Unnamed object'
                      return (
                        <Checkbox
                          key={object.id}
                          label={label}
                          checked={selectedObjectIdSet.has(object.id)}
                          disabled={submitting}
                          onChange={() => toggleObject(object.id)}
                        />
                      )
                    })}
                  </Stack>
                </Box>
              </Stack>
            </DialogSection>
          </Box>
        </ScrollableDialogBody>

        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} spacing={1} sx={{ mt: 1.5, flexShrink: 0 }}>
          <Typography level="body-sm" textColor={selectedObjectIds.length > 0 ? 'success.500' : 'text.tertiary'}>
            {selectedObjectIds.length}/{objects.length} selected
          </Typography>

          <Stack direction="row" justifyContent="flex-end" spacing={1}>
            <Button variant="plain" color="neutral" onClick={onClose} disabled={submitting}>Close</Button>
            <Button
              color="warning"
              disabled={loading || selectedObjectIds.length === 0 || submitting}
              onClick={() => onSkip(selectedObjectIds)}
            >
              Skip selected
            </Button>
          </Stack>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

function AmsSettingsModal({
  printerName,
  settings,
  submitting,
  onClose,
  onUpdateUserSettings,
  onUpdateFilamentBackup
}: {
  printerName: string
  settings: PrinterStatus['amsSettings']
  submitting: boolean
  onClose: () => void
  onUpdateUserSettings: (command: Extract<PrinterCommand, { type: 'setAmsUserSettings' }>) => void
  onUpdateFilamentBackup: (enabled: boolean) => void
}) {
  const userSettingsReady =
    settings.detectOnInsert != null &&
    settings.detectOnPowerup != null &&
    settings.remainEnabled != null

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', sm: 640 } }}>
        <ModalClose />
        <Typography level="h4">AMS settings</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          {printerName}
        </Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, p: 0 }}>
          <Stack spacing={1.5}>
            <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'hidden' }}>
              <Stack divider={<ListDivider inset="gutter" />}>
                <AmsSettingsRow
                  title="Read on insert"
                  description="Automatically read filament details when a spool is inserted into the AMS."
                  value={settings.detectOnInsert}
                  disabled={!userSettingsReady || submitting}
                  onToggle={(nextValue) => {
                    if (!userSettingsReady) return
                    onUpdateUserSettings({
                      type: 'setAmsUserSettings',
                      trayReadOption: nextValue,
                      startupReadOption: settings.detectOnPowerup ?? false,
                      calibrateRemainFlag: settings.remainEnabled ?? false
                    })
                  }}
                />
                <AmsSettingsRow
                  title="Read on startup"
                  description="Read inserted filament automatically when the printer starts up."
                  value={settings.detectOnPowerup}
                  disabled={!userSettingsReady || submitting}
                  onToggle={(nextValue) => {
                    if (!userSettingsReady) return
                    onUpdateUserSettings({
                      type: 'setAmsUserSettings',
                      trayReadOption: settings.detectOnInsert ?? false,
                      startupReadOption: nextValue,
                      calibrateRemainFlag: settings.remainEnabled ?? false
                    })
                  }}
                />
                <AmsSettingsRow
                  title="Update filament remain"
                  description="Use AMS spool metadata to track remaining filament instead of always showing a full spool."
                  value={settings.remainEnabled}
                  disabled={!userSettingsReady || submitting}
                  onToggle={(nextValue) => {
                    if (!userSettingsReady) return
                    onUpdateUserSettings({
                      type: 'setAmsUserSettings',
                      trayReadOption: settings.detectOnInsert ?? false,
                      startupReadOption: settings.detectOnPowerup ?? false,
                      calibrateRemainFlag: nextValue
                    })
                  }}
                />
                <AmsSettingsRow
                  title="AMS filament backup"
                  description="Automatically continue on another matching spool when the active one runs out."
                  value={settings.autoRefill}
                  unsupported={settings.supportFilamentBackup === false}
                  disabled={settings.autoRefill == null || submitting || settings.supportFilamentBackup === false}
                  onToggle={(nextValue) => onUpdateFilamentBackup(nextValue)}
                />
              </Stack>
            </Sheet>
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ pt: 1 }}>
          <Button variant="plain" color="neutral" onClick={onClose}>Close</Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

function AmsSettingsRow({
  title,
  description,
  value,
  disabled,
  unsupported = false,
  onToggle
}: {
  title: string
  description: string
  value: boolean | null
  disabled: boolean
  unsupported?: boolean
  onToggle: (nextValue: boolean) => void
}) {
  const stateLabel = unsupported ? 'Unsupported' : value == null ? 'Unknown' : value ? 'On' : 'Off'
  const color: 'neutral' | 'success' = !unsupported && value ? 'success' : 'neutral'

  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1.25}
      justifyContent="space-between"
      alignItems={{ xs: 'stretch', sm: 'center' }}
      sx={{ p: 1.25 }}
    >
      <Stack spacing={0.5} sx={{ minWidth: 0, flex: 1 }}>
        <Typography level="title-sm">{title}</Typography>
        <Typography level="body-xs" textColor="text.tertiary">{description}</Typography>
      </Stack>
      <Stack direction="row" spacing={1} justifyContent="flex-end" alignItems="center">
        <Chip size="sm" variant="soft" color={color}>{stateLabel}</Chip>
        {!unsupported && (
          <Button size="sm" variant="soft" disabled={disabled} onClick={() => onToggle(!(value ?? false))}>
            {value ? 'Disable' : 'Enable'}
          </Button>
        )}
      </Stack>
    </Stack>
  )
}

function AmsDryingModal({
  printerName,
  unit,
  submitting,
  onClose,
  onStart,
  onStop
}: {
  printerName: string
  unit: AmsUnit
  submitting: boolean
  onClose: () => void
  onStart: (command: Extract<PrinterCommand, { type: 'startAmsDrying' }>) => void
  onStop: (amsId: number) => void
}) {
  const defaultProfile = defaultAmsDryingProfile(unit)
  const [filamentType, setFilamentType] = useState(defaultProfile.filamentType)
  const [temperature, setTemperature] = useState(String(defaultProfile.temperature))
  const [durationHours, setDurationHours] = useState(String(defaultProfile.durationHours))
  const [rotateTray, setRotateTray] = useState(defaultProfile.rotateTray)
  const parsedTemperature = Number(temperature)
  const parsedDurationHours = Number(durationHours)
  const dryingPhaseLabel = formatAmsDryingPhaseLabel(unit)
  const dryingPhaseDescription = formatAmsDryingPhaseDescription(unit)
  const canStart =
    filamentType !== '' &&
    Number.isFinite(parsedTemperature) &&
    parsedTemperature >= 30 &&
    parsedTemperature <= 90 &&
    Number.isFinite(parsedDurationHours) &&
    parsedDurationHours >= 1 &&
    parsedDurationHours <= 24

  const handleFilamentTypeChange = (_event: unknown, nextValue: string | null) => {
    if (!nextValue) return
    const preset = dryingPresetForFilament(nextValue)
    setFilamentType(nextValue)
    setTemperature(String(preset.temperature))
    setDurationHours(String(preset.durationHours))
  }

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ width: { xs: '96vw', sm: 460 } }}>
        <ModalClose />
        <Typography level="h4">AMS {amsUnitLetter(unit.unitId)} drying</Typography>
        <Typography level="body-sm" textColor="text.tertiary">{printerName}</Typography>
        <Stack spacing={2} sx={{ mt: 1.5 }}>
          <DialogSection title="Status">
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                {unit.temperature != null && <Chip size="sm" variant="soft">{`${Math.round(unit.temperature)}°C`}</Chip>}
                {unit.humidityPercent != null && <Chip size="sm" variant="soft">{`${Math.round(unit.humidityPercent)}% RH`}</Chip>}
                <Chip size="sm" variant="soft" color={unit.dryingActive ? 'warning' : 'neutral'}>
                  {dryingPhaseLabel}
                </Chip>
                {unit.dryTimeRemainingMinutes != null && unit.dryTimeRemainingMinutes > 0 && (
                  <Chip size="sm" variant="soft">{`${formatRemaining(unit.dryTimeRemainingMinutes)} left`}</Chip>
                )}
              </Stack>
              <Typography level="body-sm">{dryingPhaseDescription}</Typography>
            </Stack>
          </DialogSection>

          {unit.dryingActive ? (
            <DialogSection title="Cycle">
              <Stack spacing={1}>
                <Typography level="body-sm">
                  {unit.dryFilament ? `${unit.dryFilament} profile` : 'Current drying profile'}
                  {unit.dryTemperature != null ? ` at ${Math.round(unit.dryTemperature)}°C` : ''}
                  {unit.dryDurationHours != null ? ` for ${unit.dryDurationHours}h` : ''}
                </Typography>
                <Typography level="body-xs" textColor="text.tertiary">
                  Stop the current cycle from here. Starting a new cycle is only available after the AMS returns to idle.
                </Typography>
              </Stack>
            </DialogSection>
          ) : (
            <DialogSection
              title="Settings"
              description="Cooling temperature is derived automatically from the selected filament profile."
            >
              <Stack spacing={1.25}>
                <FormControl>
                  <FormLabel>Filament type</FormLabel>
                  <Select value={filamentType} onChange={handleFilamentTypeChange}>
                    {AMS_DRYING_FILAMENT_TYPES.map((type) => (
                      <Option key={type} value={type}>{type}</Option>
                    ))}
                  </Select>
                </FormControl>
                <Box
                  sx={{
                    display: 'grid',
                    gap: 1,
                    gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
                    '& > *': { minWidth: 0 }
                  }}
                >
                  <FormControl>
                    <FormLabel>Temperature</FormLabel>
                    <Input
                      type="number"
                      value={temperature}
                      onChange={(event) => setTemperature(event.target.value)}
                      endDecorator="°C"
                    />
                  </FormControl>
                  <FormControl>
                    <FormLabel>Duration</FormLabel>
                    <Input
                      type="number"
                      value={durationHours}
                      onChange={(event) => setDurationHours(event.target.value)}
                      endDecorator="h"
                    />
                  </FormControl>
                </Box>
                <Checkbox
                  label="Rotate trays while drying"
                  checked={rotateTray}
                  onChange={(event) => setRotateTray(event.target.checked)}
                />
              </Stack>
            </DialogSection>
          )}
        </Stack>
        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose} disabled={submitting}>Close</Button>
          {unit.dryingActive ? (
            <Button color="danger" variant="soft" loading={submitting} onClick={() => onStop(unit.unitId)}>
              Stop
            </Button>
          ) : (
            <Button
              loading={submitting}
              disabled={!canStart}
              onClick={() => onStart({
                type: 'startAmsDrying',
                amsId: unit.unitId,
                filamentType,
                temperature: Math.round(parsedTemperature),
                durationHours: Math.round(parsedDurationHours),
                rotateTray,
                coolingTemp: dryingCoolingTemperature(filamentType),
                closePowerConflict: false
              })}
            >
              Start drying
            </Button>
          )}
        </DialogActions>
      </ModalDialog>
    </Modal>
  )
}

function AmsUnitRow({
  unit,
  compact = false,
  onRefresh,
  onOpenDrying,
  onEditSlot,
  onRescanSlot,
  onResetSlot,
  slotActionsDisabled = false
}: {
  unit: AmsUnit
  compact?: boolean
  onRefresh?: () => void
  onOpenDrying?: () => void
  onEditSlot?: (slot: AmsSlot) => void
  onRescanSlot?: (slot: AmsSlot) => void
  onResetSlot?: (slot: AmsSlot) => void
  slotActionsDisabled?: boolean
}) {
  const contextMenuAnchorRef = useRef<HTMLDivElement | null>(null)
  const tooltipOpenTimerRef = useRef<number | null>(null)
  const tooltipSuppressionTimerRef = useRef<number | null>(null)
  const lastSlotPointerTypeRef = useRef<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ slot: AmsSlot; anchorEl: HTMLDivElement } | null>(null)
  const [activeTooltipSlot, setActiveTooltipSlot] = useState<number | null>(null)
  const [tooltipSuppression, setTooltipSuppression] = useState<{ slot: number; anchorEl: HTMLDivElement } | null>(null)

  const clearPendingTooltipOpen = useCallback(() => {
    if (tooltipOpenTimerRef.current != null) {
      window.clearTimeout(tooltipOpenTimerRef.current)
      tooltipOpenTimerRef.current = null
    }
  }, [])

  const clearTooltipSuppression = useCallback((slot?: number) => {
    setTooltipSuppression((current) => {
      if (!current) return null
      if (slot != null && current.slot !== slot) return current
      return null
    })
  }, [])

  const scheduleSlotTooltipOpen = useCallback((slot: number) => {
    clearPendingTooltipOpen()
    if (contextMenu || tooltipSuppression?.slot === slot) return
    tooltipOpenTimerRef.current = window.setTimeout(() => {
      tooltipOpenTimerRef.current = null
      setActiveTooltipSlot(slot)
    }, 150)
  }, [clearPendingTooltipOpen, contextMenu, tooltipSuppression?.slot])

  const closeSlotTooltip = useCallback((slot: number) => {
    clearPendingTooltipOpen()
    setActiveTooltipSlot((current) => current === slot ? null : current)
  }, [clearPendingTooltipOpen])

  const suppressSlotTooltip = useCallback((slot: number, anchorEl: HTMLDivElement, durationMs = 350) => {
    clearPendingTooltipOpen()
    setActiveTooltipSlot(null)
    setTooltipSuppression({ slot, anchorEl })
    if (tooltipSuppressionTimerRef.current != null) {
      window.clearTimeout(tooltipSuppressionTimerRef.current)
    }
    tooltipSuppressionTimerRef.current = window.setTimeout(() => {
      tooltipSuppressionTimerRef.current = null
      if (!anchorEl.matches(':hover') && document.activeElement !== anchorEl) {
        clearTooltipSuppression(slot)
      }
    }, durationMs)
  }, [clearPendingTooltipOpen, clearTooltipSuppression])

  const closeContextMenu = useCallback(() => {
    clearPendingTooltipOpen()
    if (contextMenu) {
      const suppressedSlot = contextMenu.slot.slot
      const suppressedAnchorEl = contextMenu.anchorEl
      contextMenu.anchorEl.blur()
      suppressSlotTooltip(suppressedSlot, suppressedAnchorEl)
    }
    setContextMenu(null)
    contextMenuAnchorRef.current = null
  }, [clearPendingTooltipOpen, contextMenu, suppressSlotTooltip])

  useEffect(() => () => {
    clearPendingTooltipOpen()
    if (tooltipSuppressionTimerRef.current != null) {
      window.clearTimeout(tooltipSuppressionTimerRef.current)
    }
  }, [clearPendingTooltipOpen])

  useControlledMenuClickAway(Boolean(contextMenu), `ams-slot-context-menu-${unit.unitId}`, closeContextMenu, [contextMenuAnchorRef])

  const openSlotContextMenu = (slot: AmsSlot, anchorEl: HTMLDivElement) => {
    if (!onEditSlot && !onRescanSlot && !onResetSlot) return
    clearPendingTooltipOpen()
    suppressSlotTooltip(slot.slot, anchorEl)
    contextMenuAnchorRef.current = anchorEl
    setContextMenu({ slot, anchorEl })
  }

  const canOpenSlotTooltipForPointer = (pointerType: string) => (
    pointerType === 'mouse'
    && (typeof window === 'undefined' || window.matchMedia('(hover: hover)').matches)
  )

  return (
    <Stack
      sx={{
        height: '100%',
        p: compact ? { xs: 0.625, sm: 0.75 } : { xs: 0.75, sm: 1 },
        borderRadius: 'sm',
        border: '1px solid var(--joy-palette-neutral-700)',
        backgroundColor: 'var(--joy-palette-background-surface)'
      }}
      spacing={{ xs: 0.5, sm: 0.75 }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
          <Typography level="body-xs" textColor="text.tertiary">AMS {amsUnitLetter(unit.unitId)}</Typography>
        </Stack>
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minHeight: '1rem' }}>
          {unit.temperature != null && (
            <Typography level="body-xs" textColor="text.tertiary">
              {`${unit.temperature.toFixed(0)}°`}
            </Typography>
          )}
          {unit.humidityPercent != null ? (
            <Typography level="body-xs" textColor="text.tertiary">
              {`${Math.round(unit.humidityPercent)}% RH`}
            </Typography>
          ) : unit.humidityLevel != null ? (
            <Tooltip
              variant="outlined"
              size="sm"
              title={`Humidity level ${unit.humidityLevel}/5 — ${humidityLevelLabel(unit.humidityLevel)} (older AMS units do not report a percentage).`}
            >
              <Typography level="body-xs" textColor="text.tertiary">
                {`Lv ${unit.humidityLevel}/5`}
              </Typography>
            </Tooltip>
          ) : null}
          {unit.dryingActive && unit.dryTimeRemainingMinutes != null && unit.dryTimeRemainingMinutes > 0 && (
            <Typography level="body-xs" textColor="warning.plainColor" noWrap>
              {`${formatRemaining(unit.dryTimeRemainingMinutes)} left`}
            </Typography>
          )}
          {unit.supportDrying && onOpenDrying && (
            <Tooltip title={unit.dryingActive ? 'View AMS drying' : 'Start AMS drying'} variant="soft" size="sm">
              <IconButton
                size="sm"
                variant="plain"
                onClick={onOpenDrying}
                aria-label={unit.dryingActive ? `View AMS ${amsUnitLetter(unit.unitId)} drying` : `Start AMS ${amsUnitLetter(unit.unitId)} drying`}
                color={unit.dryingActive ? 'warning' : 'neutral'}
                sx={{ minHeight: 0, minWidth: 0, p: 0.25, fontSize: '0.95rem' }}
              >
                <LocalFireDepartmentRoundedIcon fontSize="inherit" />
              </IconButton>
            </Tooltip>
          )}
          {onRefresh && (
            <Tooltip title={`Refresh AMS ${amsUnitLetter(unit.unitId)}`} variant="soft" size="sm">
              <IconButton
                size="sm"
                variant="plain"
                onClick={onRefresh}
                aria-label={`Refresh AMS ${amsUnitLetter(unit.unitId)}`}
                sx={{ minHeight: 0, minWidth: 0, p: 0.25 }}
              >
                <Box component="span" aria-hidden sx={{ fontSize: '0.85rem' }}>↻</Box>
              </IconButton>
            </Tooltip>
          )}
        </Stack>
      </Stack>
      <Stack direction="row" spacing={{ xs: 0.375, sm: 0.5 }}>
        {unit.slots.map((slot) => {
          const contextMenuOpenForSlot = contextMenu?.slot.slot === slot.slot
          const tooltipSuppressedForSlot = tooltipSuppression?.slot === slot.slot
          const isRescanning = slot.isReading
          const slotNumber = slot.slot + 1
          const slotLabel = `${amsUnitLetter(unit.unitId)}${slotNumber}`
          const isActive = slot.active
          const filament = resolveFilamentDisplay(slot)
          const compactFilamentType = resolveCompactFilamentTypeLabel(
            filamentPresetLabel(slot.trayInfoIdx, filament.material, slot.filamentType)
            ?? slot.filamentType
            ?? filament.material
          )
          const textColor = filamentTextColor(filament.colors, slot.color, 'var(--joy-palette-neutral-400)')
          const slotColorName = filament.name
          const hasColorName = Boolean(slotColorName)
          const centerFilamentType = !hasColorName
          const filamentTypeLabel = compactFilamentType ?? '?'
          const filamentTypeLabelColor = compactFilamentType ? textColor : 'var(--joy-palette-warning-300)'
          const hasFilament = hasLoadedFilament(slot.filamentType, slot.color, slot.colors, {
            trayInfoIdx: slot.trayInfoIdx,
            trayName: slot.trayName,
            trayUuid: slot.trayUuid,
            occupied: slot.occupied,
            remainPercent: slot.remainPercent
          })
          const hasScannedSpool = slot.trayUuid != null
          const remaining = hasScannedSpool && hasFilament && slot.remainPercent != null
            ? Math.max(0, Math.min(100, slot.remainPercent))
            : null
          // Stoplight coloring for the remaining-filament bar so users
          // can spot a near-empty spool at a glance regardless of the
          // swatch underneath.
          const remainingFill =
            remaining == null ? null
              : remaining <= 10 ? 'var(--joy-palette-danger-400)'
              : remaining <= 25 ? 'var(--joy-palette-warning-300)'
              : 'var(--joy-palette-success-400)'
          return (
            <Tooltip
              key={slot.slot}
              variant="outlined"
              placement="top"
              arrow
              disableHoverListener
              disableFocusListener
              disableTouchListener
              open={activeTooltipSlot === slot.slot && !contextMenuOpenForSlot && !tooltipSuppressedForSlot}
              title={<AmsSlotTooltipBody slot={slot} slotLabel={slotLabel} />}
              sx={{ maxWidth: 280, p: 0 }}
            >
              <Box
                onClick={onEditSlot ? (event) => {
                  suppressSlotTooltip(slot.slot, event.currentTarget, 1_000)
                  onEditSlot(slot)
                } : undefined}
                onPointerDown={(event) => {
                  lastSlotPointerTypeRef.current = event.pointerType
                  if (event.pointerType !== 'mouse') {
                    suppressSlotTooltip(slot.slot, event.currentTarget, 1_000)
                  }
                }}
                onPointerEnter={(event) => {
                  lastSlotPointerTypeRef.current = event.pointerType
                  if (canOpenSlotTooltipForPointer(event.pointerType)) {
                    scheduleSlotTooltipOpen(slot.slot)
                  }
                }}
                onPointerLeave={() => {
                  lastSlotPointerTypeRef.current = null
                  closeSlotTooltip(slot.slot)
                  clearTooltipSuppression(slot.slot)
                }}
                onFocus={() => {
                  if (lastSlotPointerTypeRef.current == null) {
                    scheduleSlotTooltipOpen(slot.slot)
                  }
                }}
                onBlur={() => {
                  lastSlotPointerTypeRef.current = null
                  closeSlotTooltip(slot.slot)
                  clearTooltipSuppression(slot.slot)
                }}
                onContextMenu={(event) => {
                  if (!onEditSlot && !onRescanSlot && !onResetSlot) return
                  event.preventDefault()
                  openSlotContextMenu(slot, event.currentTarget)
                }}
                role={onEditSlot ? 'button' : undefined}
                tabIndex={onEditSlot ? 0 : undefined}
                onKeyDown={(event) => {
                  if ((event.key === 'Enter' || event.key === ' ') && onEditSlot) {
                    event.preventDefault()
                    onEditSlot(slot)
                    return
                  }
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault()
                    openSlotContextMenu(slot, event.currentTarget)
                  }
                }}
                sx={{
                  position: 'relative',
                  flex: 1,
                  minHeight: compact ? { xs: 48, sm: 54 } : { xs: 52, sm: 60 },
                  borderRadius: 'sm',
                  border: isActive
                    ? '2px solid var(--joy-palette-primary-400)'
                    : '1px solid var(--joy-palette-neutral-700)',
                  background: hasFilament
                    ? filamentBackground(filament.colors, slot.color, 'var(--joy-palette-neutral-800)')
                    : 'var(--joy-palette-neutral-800)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                  cursor: onEditSlot ? 'pointer' : 'default',
                  boxShadow: isActive ? '0 0 0 1px rgba(122, 162, 255, 0.35), 0 0 18px rgba(122, 162, 255, 0.18)' : 'none'
                }}
              >
                {isRescanning && (
                  <Box
                    sx={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 'inherit',
                      backgroundColor: 'rgba(7, 10, 16, 0.54)',
                      backdropFilter: 'blur(1px)',
                      zIndex: 1
                    }}
                  >
                    <CircularProgress size="sm" determinate={false} />
                  </Box>
                )}
                <Typography
                  level="body-xs"
                  sx={{
                    position: 'absolute',
                    top: 2,
                    left: 4,
                    color: textColor,
                    opacity: 0.75,
                    fontWeight: 'md',
                    lineHeight: 1
                  }}
                >
                  {slotLabel}
                </Typography>
                {hasFilament ? (
                  <Stack
                    spacing={hasColorName ? 0 : 0.125}
                    alignItems="center"
                    sx={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      top: centerFilamentType ? '50%' : 'auto',
                      bottom: centerFilamentType
                        ? 'auto'
                        : hasColorName
                          ? { xs: 9, sm: 11 }
                          : { xs: 11, sm: 14 },
                      transform: centerFilamentType ? 'translateY(-50%)' : 'none',
                      px: 0.75,
                      minWidth: 0,
                      maxWidth: '100%',
                      minHeight: centerFilamentType ? 'auto' : '1.85em'
                    }}
                  >
                    <Typography
                      level="body-xs"
                      noWrap
                      sx={{ color: filamentTypeLabelColor, fontWeight: compactFilamentType ? 'md' : 'lg', maxWidth: '100%', lineHeight: 1.05 }}
                    >
                      {filamentTypeLabel}
                    </Typography>
                    {hasColorName ? (
                      <Typography
                        level="body-xs"
                        noWrap
                        sx={{
                          color: textColor,
                          opacity: 0.78,
                          maxWidth: '100%',
                          lineHeight: 1.05
                        }}
                      >
                        {slotColorName}
                      </Typography>
                    ) : null}
                  </Stack>
                ) : (
                  <Typography
                    level="body-xs"
                    sx={{ color: textColor, fontWeight: 'md' }}
                  >
                    —
                  </Typography>
                )}
                {/* Thin rounded remaining bar across the bottom; the fill
                    is the filament color over a dark track, with a
                    contrasting outline so it reads on any swatch. */}
              {remaining != null && remainingFill != null && (
                <Box
                  aria-hidden
                  sx={{
                    position: 'absolute',
                    left: 4,
                    right: 4,
                    bottom: { xs: 3, sm: 4 },
                    height: { xs: 6, sm: 8 },
                    borderRadius: 4,
                    backgroundColor: 'rgba(0, 0, 0, 0.55)',
                    border: `1px solid ${textColor === '#fff'
                      ? 'rgba(255, 255, 255, 0.15)'
                      : 'rgba(0, 0, 0, 0.22)'}`,
                    overflow: 'hidden',
                    boxSizing: 'border-box'
                  }}
                >
                  <Box
                    sx={{
                      width: `${remaining}%`,
                      height: '100%',
                      backgroundColor: remainingFill,
                      transition: 'width 200ms ease, background-color 200ms ease'
                    }}
                  />
                </Box>
              )}
              </Box>
            </Tooltip>
          )
        })}
      </Stack>
      {contextMenu && (
        <Menu
          id={`ams-slot-context-menu-${unit.unitId}`}
          open
          onClose={closeContextMenu}
          anchorEl={contextMenu.anchorEl}
          placement="bottom-start"
        >
          {onEditSlot && (
            <MenuItem
              disabled={slotActionsDisabled}
              onClick={() => {
                const slot = contextMenu.slot
                closeContextMenu()
                onEditSlot(slot)
              }}
            >
              <EditRoundedIcon /> Edit
            </MenuItem>
          )}
          {onRescanSlot && (
            <MenuItem
              disabled={slotActionsDisabled}
              onClick={() => {
                const slot = contextMenu.slot
                closeContextMenu()
                onRescanSlot(slot)
              }}
            >
              <RefreshRoundedIcon /> Rescan
            </MenuItem>
          )}
          {onResetSlot && (
            <MenuItem
              disabled={slotActionsDisabled}
              onClick={() => {
                const slot = contextMenu.slot
                closeContextMenu()
                onResetSlot(slot)
              }}
            >
              <RestartAltRoundedIcon /> Reset
            </MenuItem>
          )}
        </Menu>
      )}
    </Stack>
  )
}

function ExternalSpoolRow({
  spool,
  spoolCount,
  compact = false,
  onEdit
}: {
  spool: ExternalSpool
  spoolCount: number
  compact?: boolean
  onEdit?: () => void
}) {
  const label = externalSpoolLabel(spool.amsId, spoolCount)
  const filament = resolveFilamentDisplay(spool)
  const compactFilamentType = resolveCompactFilamentTypeLabel(
    filamentPresetLabel(spool.trayInfoIdx, filament.material, spool.filamentType)
    ?? spool.filamentType
    ?? filament.material
  )
  const textColor = filamentTextColor(filament.colors, spool.color, 'var(--joy-palette-neutral-400)')
  const filamentTypeLabel = compactFilamentType ?? '?'
  const filamentTypeLabelColor = compactFilamentType ? textColor : 'var(--joy-palette-warning-300)'
  const hasFilament = hasLoadedFilament(spool.filamentType, spool.color, spool.colors, {
    trayInfoIdx: spool.trayInfoIdx,
    trayName: spool.trayName,
    trayUuid: spool.trayUuid,
    occupied: false,
    remainPercent: spool.remainPercent
  })
  const hasScannedSpool = spool.trayUuid != null
  const remaining = hasScannedSpool && hasFilament && spool.remainPercent != null
    ? Math.max(0, Math.min(100, spool.remainPercent))
    : null
  const remainingFill =
    remaining == null ? null
      : remaining <= 15 ? 'var(--joy-palette-danger-400)'
      : remaining <= 35 ? 'var(--joy-palette-warning-300)'
      : 'var(--joy-palette-success-400)'
  const isActive = spool.active

  return (
    <Stack
      sx={{
        height: '100%',
        p: compact ? { xs: 0.625, sm: 0.75 } : { xs: 0.75, sm: 1 },
        borderRadius: 'sm',
        border: isActive ? '1px solid var(--joy-palette-primary-500)' : '1px solid var(--joy-palette-neutral-700)',
        backgroundColor: 'var(--joy-palette-background-surface)'
      }}
      spacing={{ xs: 0.5, sm: 0.75 }}
    >
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        spacing={1}
        sx={{ minHeight: 'calc(var(--joy-fontSize-xs) * var(--joy-lineHeight-xs) + 0.4rem)' }}
      >
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
          <Typography level="body-xs" textColor="text.tertiary">{label}</Typography>
        </Stack>
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minHeight: '1rem' }}>
          <Box sx={{ width: '0.85rem', height: '0.85rem', visibility: 'hidden', flexShrink: 0 }} />
        </Stack>
      </Stack>
      <Tooltip
        variant="outlined"
        placement="top"
        arrow
        title={<ExternalSpoolTooltipBody spool={spool} label={label} />}
        sx={{ maxWidth: 280, p: 0 }}
      >
        <Box
          onClick={onEdit}
          role={onEdit ? 'button' : undefined}
          tabIndex={onEdit ? 0 : undefined}
          onKeyDown={(event) => {
            if (!onEdit) return
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onEdit()
            }
          }}
          sx={{
            position: 'relative',
            minHeight: compact ? { xs: 48, sm: 54 } : { xs: 52, sm: 60 },
            borderRadius: 'sm',
            border: isActive
              ? '2px solid var(--joy-palette-primary-400)'
              : '1px solid var(--joy-palette-neutral-700)',
            background: hasFilament
              ? filamentBackground(filament.colors, spool.color, 'var(--joy-palette-neutral-800)')
              : 'var(--joy-palette-neutral-800)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            cursor: onEdit ? 'pointer' : 'default',
            boxShadow: isActive ? '0 0 0 1px rgba(122, 162, 255, 0.35), 0 0 18px rgba(122, 162, 255, 0.18)' : 'none'
          }}
        >
          <Typography
            level="body-xs"
            sx={{
              color: filamentTypeLabelColor,
              fontWeight: compactFilamentType ? 'md' : 'lg'
            }}
          >
            {filamentTypeLabel}
          </Typography>
          {remaining != null && remainingFill != null && (
            <Box
              aria-hidden
              sx={{
                position: 'absolute',
                left: 4,
                right: 4,
                bottom: { xs: 3, sm: 4 },
                height: { xs: 6, sm: 8 },
                borderRadius: 4,
                backgroundColor: 'rgba(0, 0, 0, 0.55)',
                border: `1px solid ${textColor === '#fff'
                  ? 'rgba(255, 255, 255, 0.15)'
                  : 'rgba(0, 0, 0, 0.22)'}`,
                overflow: 'hidden',
                boxSizing: 'border-box'
              }}
            >
              <Box
                sx={{
                  width: `${remaining}%`,
                  height: '100%',
                  backgroundColor: remainingFill,
                  transition: 'width 200ms ease, background-color 200ms ease'
                }}
              />
            </Box>
          )}
        </Box>
      </Tooltip>
    </Stack>
  )
}

/** Convert a 0-based AMS unit id to its Bambu letter label (0 -> A, 1 -> B, ...). */
function amsUnitLetter(unitId: number): string {
  if (!Number.isFinite(unitId) || unitId < 0) return String(unitId)
  let n = Math.floor(unitId)
  let label = ''
  do {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return label
}

function filamentPresetLabel(trayInfoIdx: string | null | undefined, fallbackMaterial: string | null, fallbackType: string | null | undefined): string | null {
  const presetName = trayInfoIdx ? BAMBU_FILAMENT_PRESET_NAMES[trayInfoIdx] : null
  if (presetName) return presetName
  if (fallbackMaterial) return `Bambu ${fallbackMaterial}`

  const filamentType = fallbackType?.trim() ?? ''
  return filamentType || null
}

/**
 * Plain-language label for the 1-5 humidity level reported by older AMS
 * units. Mirrors the descriptions Bambu Studio shows next to the dot icon.
 */
function humidityLevelLabel(level: number): string {
  switch (level) {
    case 1: return 'Very dry'
    case 2: return 'Dry'
    case 3: return 'Fair'
    case 4: return 'Damp'
    case 5: return 'Wet'
    default: return 'Unknown'
  }
}

function defaultAmsDryingProfile(unit: AmsUnit): {
  filamentType: string
  temperature: number
  durationHours: number
  rotateTray: boolean
} {
  const detectedType = normalizeAmsDryingFilamentType(unit.dryFilament
    ?? unit.slots.find((slot) => slot.filamentType && slot.filamentType.trim() !== '')?.filamentType
    ?? 'PLA')
  const preset = dryingPresetForFilament(detectedType)
  const hasActiveTemperature = unit.dryTemperature != null && unit.dryTemperature >= 30
  const hasActiveDuration = unit.dryDurationHours != null && unit.dryDurationHours >= 1
  return {
    filamentType: detectedType,
    temperature: hasActiveTemperature ? Math.round(unit.dryTemperature!) : preset.temperature,
    durationHours: hasActiveDuration ? unit.dryDurationHours! : preset.durationHours,
    rotateTray: true
  }
}

function formatAmsDryingPhaseLabel(unit: AmsUnit): string {
  switch (unit.dryingPhase) {
    case 'starting':
      return 'Starting'
    case 'drying':
      return 'Drying'
    case 'cooling':
      return 'Cooling down'
    case 'finishing':
      return 'Finishing'
    case 'unknown':
      return unit.dryingActive ? 'Drying active' : 'Idle'
    case 'idle':
    default:
      return unit.dryingActive ? 'Drying active' : 'Idle'
  }
}

function formatAmsDryingPhaseDescription(unit: AmsUnit): string {
  switch (unit.dryingPhase) {
    case 'starting':
      return 'The AMS is warming up and preparing the drying cycle.'
    case 'drying':
      return 'The drying cycle is actively removing moisture from the loaded filament.'
    case 'cooling':
      return 'The AMS is cooling down before it returns to idle.'
    case 'finishing':
      return 'The drying cycle is wrapping up and the AMS will return to idle shortly.'
    case 'unknown':
      return 'The AMS reports an active drying cycle.'
    case 'idle':
    default:
      return 'The AMS is idle and ready for a new drying cycle.'
  }
}

function usePendingFilamentActionLabel(status: PrinterStatus | undefined) {
  const [pendingActionLabel, setPendingActionLabelState] = useState<string | null>(null)
  const [requestedAtObservation, setRequestedAtObservation] = useState<string | null>(null)
  const [sawLiveProgress, setSawLiveProgress] = useState(false)

  const setPendingActionLabel = useCallback((label: string | null) => {
    setPendingActionLabelState(label)
    setRequestedAtObservation(label ? status?.observedAt ?? null : null)
    setSawLiveProgress(false)
  }, [status?.observedAt])

  useEffect(() => {
    if (!pendingActionLabel) return

    const hasLiveProgress = Boolean(status?.filamentChange.currentStepLabel)
      || (status?.filamentChange.steps.length ?? 0) > 0

    if (hasLiveProgress) {
      if (!sawLiveProgress) setSawLiveProgress(true)
      return
    }

    const hasFreshObservation = Boolean(
      requestedAtObservation
      && status?.observedAt
      && status.observedAt !== requestedAtObservation
    )

    if (sawLiveProgress || (hasFreshObservation && isPrinterIdleCompatibleStage(status?.stage))) {
      setPendingActionLabelState(null)
      setRequestedAtObservation(null)
      setSawLiveProgress(false)
    }
  }, [pendingActionLabel, requestedAtObservation, sawLiveProgress, status])

  return [pendingActionLabel, setPendingActionLabel] as const
}

function dryingCoolingTemperature(filamentType: string): number {
  return dryingPresetForFilament(filamentType).coolingTemp
}

const AMS_DRYING_FILAMENT_TYPES = [
  'PLA',
  'PLA-CF',
  'PETG',
  'PETG-ESD',
  'PETG-CF',
  'ABS',
  'ABS-GF',
  'ASA',
  'ASA-CF',
  'TPU',
  'PA',
  'PA-CF',
  'PAHT-CF',
  'PA6-CF',
  'PA6-GF',
  'PA12-CF',
  'PA612-CF',
  'PPA',
  'PPA-CF',
  'PPA-GF',
  'PC',
  'PP',
  'PE',
  'PET-CF',
  'PPS',
  'PPS-CF',
  'PVA',
  'BVOH',
  'HIPS',
  'SUPPORT'
] as const

function normalizeAmsDryingFilamentType(filamentType: string): string {
  const normalized = filamentType.trim().toUpperCase()
  const exact = AMS_DRYING_FILAMENT_TYPES.find((entry) => entry === normalized)
  if (exact) return exact

  const partial = AMS_DRYING_FILAMENT_TYPES.find((entry) => normalized.includes(entry))
  return partial ?? 'PLA'
}

function dryingPresetForFilament(filamentType: string): {
  temperature: number
  durationHours: number
  coolingTemp: number
} {
  const normalized = filamentType.trim().toUpperCase()
  if (normalized.includes('TPU')) return { temperature: 65, durationHours: 12, coolingTemp: 40 }
  if (normalized.includes('PETG')) return { temperature: 65, durationHours: 8, coolingTemp: 50 }
  if (normalized.includes('ASA')) return { temperature: 75, durationHours: 8, coolingTemp: 60 }
  if (normalized.includes('ABS')) return { temperature: 75, durationHours: 8, coolingTemp: 60 }
  if (normalized.includes('PA') || normalized.includes('NYLON')) return { temperature: 80, durationHours: 12, coolingTemp: 65 }
  if (normalized.includes('PC')) return { temperature: 75, durationHours: 10, coolingTemp: 60 }
  if (normalized.includes('PVA')) return { temperature: 55, durationHours: 6, coolingTemp: 40 }
  return { temperature: 55, durationHours: 8, coolingTemp: 45 }
}

/**
 * Rich AMS slot tooltip body. Mirrors the slot dropdown rendering used
 * inside the print dialog (`SlotOptionLabel`) so the printer card and
 * the dispatch flow show the same information for a given slot:
 * brand/material, the Bambu color name when known, and the remaining
 * percentage with a rough gram estimate (1kg spool = 100%).
 */
function AmsSlotTooltipBody({ slot, slotLabel }: { slot: AmsSlot; slotLabel: string }) {
  const filament = resolveFilamentDisplay(slot)
  const presetLabel = filamentPresetLabel(slot.trayInfoIdx, filament.material, slot.filamentType)
  const colorName = resolveFilamentSwatchName(slot)
  const hasFilament = hasLoadedFilament(slot.filamentType, slot.color, slot.colors, {
    trayInfoIdx: slot.trayInfoIdx,
    trayName: slot.trayName,
    trayUuid: slot.trayUuid,
    occupied: slot.occupied,
    remainPercent: slot.remainPercent
  })
  const remainGrams = hasFilament && slot.remainPercent != null ? Math.round(slot.remainPercent * 10) : null
  // Header band is the actual filament colour (bambuddy-style). Pick a
  // contrasting text colour so light filaments stay readable. Empty
  // slots fall back to a neutral surface.
  const headerBg = filamentBackground(filament.colors, slot.color, 'var(--joy-palette-neutral-800)')
  const headerFg = filamentTextColor(filament.colors, slot.color, 'var(--joy-palette-text-primary)')
  return (
    <Stack
      sx={{
        minWidth: 220,
        // Clip the colour band to the tooltip's rounded corners. Done
        // here (not on the Tooltip root) so the arrow isn't clipped.
        borderRadius: 'var(--joy-radius-sm)',
        overflow: 'hidden'
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={1}
        sx={{
          px: 1.25,
          py: 0.75,
          background: headerBg,
          color: headerFg,
          borderBottom: '1px solid rgba(0, 0, 0, 0.25)'
        }}
      >
        <Typography
          level="title-sm"
          sx={{ color: 'inherit', fontWeight: 'lg', flex: 1, minWidth: 0 }}
          noWrap
        >
          {colorName ?? (hasFilament ? 'Custom colour' : 'Empty')}
        </Typography>
        <Typography
          level="body-xs"
          sx={{ color: 'inherit', opacity: 0.85, flexShrink: 0 }}
        >
          Slot {slotLabel}
        </Typography>
      </Stack>
      <Stack spacing={0.5} sx={{ px: 1.25, py: 1 }}>
        {hasFilament ? (
          <>
            <Typography level="body-sm">
              {presetLabel ?? 'Unknown filament'}
            </Typography>
            {slot.trayName && slot.trayName !== slot.filamentType && slot.trayName !== presetLabel && slot.trayName !== colorName && !isRawTrayCode(slot.trayName) && (
              <Typography level="body-xs" textColor="text.tertiary">
                {slot.trayName}
              </Typography>
            )}
            {slot.remainPercent != null && remainGrams != null && (
              <Typography level="body-xs" textColor="text.tertiary">
                {Math.round(slot.remainPercent)}% remaining (~{remainGrams}g)
              </Typography>
            )}
          </>
        ) : (
          <Typography level="body-sm" textColor="text.tertiary">No filament loaded</Typography>
        )}
      </Stack>
    </Stack>
  )
}

function ExternalSpoolTooltipBody({ spool, label }: { spool: ExternalSpool; label: string }) {
  const filament = resolveFilamentDisplay(spool)
  const presetLabel = filamentPresetLabel(spool.trayInfoIdx, filament.material, spool.filamentType)
  const colorName = resolveFilamentSwatchName(spool)
  const hasFilament = hasLoadedFilament(spool.filamentType, spool.color, spool.colors, {
    trayInfoIdx: spool.trayInfoIdx,
    trayName: spool.trayName,
    trayUuid: spool.trayUuid,
    occupied: false,
    remainPercent: spool.remainPercent
  })
  const remainGrams = hasFilament && spool.remainPercent != null ? Math.round(spool.remainPercent * 10) : null
  const headerBg = filamentBackground(filament.colors, spool.color, 'var(--joy-palette-neutral-800)')
  const headerFg = filamentTextColor(filament.colors, spool.color, 'var(--joy-palette-text-primary)')

  return (
    <Stack
      sx={{
        minWidth: 220,
        borderRadius: 'var(--joy-radius-sm)',
        overflow: 'hidden'
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={1}
        sx={{
          px: 1.25,
          py: 0.75,
          background: headerBg,
          color: headerFg,
          borderBottom: '1px solid rgba(0, 0, 0, 0.25)'
        }}
      >
        <Typography
          level="title-sm"
          sx={{ color: 'inherit', fontWeight: 'lg', flex: 1, minWidth: 0 }}
          noWrap
        >
          {colorName ?? (hasFilament ? 'Custom colour' : 'Empty')}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'inherit', opacity: 0.85, flexShrink: 0 }}>
          {label}
        </Typography>
      </Stack>
      <Stack spacing={0.5} sx={{ px: 1.25, py: 1 }}>
        {hasFilament ? (
          <>
            <Typography level="body-sm">
              {presetLabel ?? 'Unknown filament'}
            </Typography>
            {spool.trayName && spool.trayName !== spool.filamentType && spool.trayName !== presetLabel && spool.trayName !== colorName && !isRawTrayCode(spool.trayName) && (
              <Typography level="body-xs" textColor="text.tertiary">
                {spool.trayName}
              </Typography>
            )}
            {spool.remainPercent != null && remainGrams != null && (
              <Typography level="body-xs" textColor="text.tertiary">
                {Math.round(spool.remainPercent)}% remaining (~{remainGrams}g)
              </Typography>
            )}
          </>
        ) : (
          <Typography level="body-sm" textColor="text.tertiary">No filament configured</Typography>
        )}
        <Typography level="body-xs" textColor="text.tertiary">
          Manual slot only. RFID scan and auto-detection are not available.
        </Typography>
      </Stack>
    </Stack>
  )
}

function shouldPreferTrackedActiveJobName(liveJobName: string | null, trackedJobName: string | null): boolean {
  if (!liveJobName || !trackedJobName || liveJobName === trackedJobName) return false
  const splitIndex = liveJobName.lastIndexOf(' - ')
  const livePlateLabel = splitIndex > 0 ? liveJobName.slice(splitIndex + 3).trim() : liveJobName.trim()
  return normalizeFallbackPlateLabel(livePlateLabel) !== livePlateLabel
}

function externalSpoolLabel(amsId: ExternalSpool['amsId'], spoolCount: number): string {
  if (spoolCount > 1) {
    return amsId === 255 ? 'Ext-R' : 'Ext-L'
  }
  return 'Ext'
}

function printerCardAmsGridColumns(cardsPerRow: number): number {
  if (cardsPerRow === 1) return 8
  if (cardsPerRow === 2) return 4
  return 4
}

function amsUnitSlotSpan(unit: AmsUnit): number {
  return Math.max(1, Math.min(4, unit.slots.length))
}

function parseStoredBoolean(raw: string): boolean | null {
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

function parseStoredOptionalString(raw: string): string | null {
  const value = raw.trim()
  return value && value !== 'null' ? value : null
}

function serializeStoredOptionalString(value: string | null): string {
  return value ?? ''
}

function parseStoredStringArray(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
  } catch {
    return null
  }
}

function parsePrinterModelFilter(raw: string): PrinterModel[] | null {
  try {
    const result = printerViewModelFilterSchema.safeParse(JSON.parse(raw) as unknown)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

function parsePrinterViewSort(raw: string): PrinterViewSort | null {
  if (!raw) return null
  return decodePrinterViewSort(raw)
}

function parsePrinterCardContentSettings(raw: string): PrinterCardContentSettings | null {
  try {
    const result = printerCardContentSettingsSchema.safeParse(JSON.parse(raw) as unknown)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

function printerNozzles(status: PrinterStatus | undefined): PrinterStatus['nozzles'] {
  if (!status) return []
  if (status.nozzles.length > 0) return status.nozzles
  if (status.nozzleTemp == null && status.nozzleTarget == null) return []
  return [{ extruderId: 0, diameter: null, typeCode: null, material: null, flow: null, currentTemp: status.nozzleTemp, targetTemp: status.nozzleTarget }]
}

function formatNozzleMaterial(material: PrinterStatus['nozzles'][number]['material']): string | null {
  switch (material) {
    case 'stainless-steel':
      return 'Stainless steel'
    case 'hardened-steel':
      return 'Hardened steel'
    case 'tungsten-carbide':
      return 'Tungsten carbide'
    default:
      return null
  }
}

function formatNozzleFlow(flow: PrinterStatus['nozzles'][number]['flow']): string | null {
  switch (flow) {
    case 'standard':
      return 'Standard flow'
    case 'high':
      return 'High flow'
    case 'tpu-high':
      return 'TPU high flow'
    default:
      return null
  }
}

function formatNozzleHardwareSummary(nozzle: PrinterStatus['nozzles'][number]): string | null {
  const parts: string[] = []
  const diameterLabel = formatNozzleDiameterLabel(nozzle.diameter)
  if (diameterLabel) parts.push(diameterLabel)

  const materialLabel = formatNozzleMaterial(nozzle.material)
  if (materialLabel) parts.push(materialLabel)

  const flowLabel = formatNozzleFlow(nozzle.flow)
  if (flowLabel) parts.push(flowLabel)

  if (parts.length === 0 && nozzle.typeCode) parts.push(nozzle.typeCode)
  return parts.length > 0 ? parts.join(' · ') : null
}

function formatPrinterCardNozzleSizes(
  status: PrinterStatus | undefined,
  savedSelections: readonly PrinterNozzleDiameterSelection[] | null | undefined
): string | null {
  const labels = Array.from(new Set(
    resolvePrinterNozzleDiameters(status, savedSelections)
      .map((selection) => formatNozzleDiameterLabel(selection.diameter))
      .filter((label): label is string => Boolean(label))
  ))

  if (labels.length === 0) return null
  if (labels.length === 1) return labels[0] ?? null
  return labels.join(' / ')
}

function resolveFilamentChangeTargetTemp(
  source:
    | Pick<AmsSlot, 'trayInfoIdx' | 'filamentType'>
    | Pick<ExternalSpool, 'trayInfoIdx' | 'filamentType'>
    | null
    | undefined
): number | null {
  if (!source) return null
  const preset = (typeof source.trayInfoIdx === 'string' && source.trayInfoIdx.trim() !== '')
    ? BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === source.trayInfoIdx)
    : filamentTypeDefaults(source.filamentType)

  if (preset?.tempMin == null || preset.tempMax == null) return null
  return Math.round((preset.tempMin + preset.tempMax) / 2)
}

function TempReadout({
  icon,
  ariaLabel,
  current,
  target,
  tooltipTarget,
  onClick
}: {
  icon: React.ReactNode
  ariaLabel: string
  current: number | null
  target: number | null
  tooltipTarget?: number | null
  onClick?: () => void
}) {
  if (current == null) return null
  const value = `${Math.round(current)}°${target != null && target > 0 ? ` / ${Math.round(target)}°` : ''}`
  const fullTarget = tooltipTarget ?? target
  const tooltipValue = `${Math.round(current)}°${fullTarget != null && fullTarget > 0 ? ` / ${Math.round(fullTarget)}°` : ''}`
  return <MetricChip icon={icon} ariaLabel={ariaLabel} value={value} tooltipTitle={`${ariaLabel}: ${tooltipValue}`} onClick={onClick} />
}

function DualTempReadout({
  icon,
  ariaLabel,
  values,
  showTargets,
  onClick
}: {
  icon: React.ReactNode
  ariaLabel: string
  values: Array<{ extruderId: number; currentTemp: number | null; targetTemp: number | null }>
  showTargets: boolean
  onClick?: () => void
}) {
  const parts = values
    .filter((entry) => entry.currentTemp != null)
    .map((entry) => {
      const currentValue = `${Math.round(entry.currentTemp!)}°`
      const targetValue = showTargets && entry.targetTemp != null && entry.targetTemp > 0
        ? ` / ${Math.round(entry.targetTemp)}°`
        : ''
      return `${currentValue}${targetValue}`
    })
  const tooltipParts = values
    .filter((entry) => entry.currentTemp != null)
    .map((entry) => {
      const currentValue = `${Math.round(entry.currentTemp!)}°`
      const targetValue = entry.targetTemp != null && entry.targetTemp > 0
        ? ` / ${Math.round(entry.targetTemp)}°`
        : ''
      return `${currentValue}${targetValue}`
    })

  if (parts.length === 0) return null

  return (
    <MetricChip
      icon={icon}
      ariaLabel={`${ariaLabel}: ${parts.join(', ')}`}
      tooltipTitle={`${ariaLabel}: ${tooltipParts.join(', ')}`}
      onClick={onClick}
      value={
        <Stack direction="row" spacing={0.5} alignItems="center">
          {parts.map((part, index) => (
            <Box key={`${part}-${index}`} component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
              {index > 0 ? (
                <Box
                  component="span"
                  aria-hidden
                  sx={{ color: 'text.tertiary', fontWeight: 'md', lineHeight: 1 }}
                >
                  |
                </Box>
              ) : null}
              <Typography component="span" level="body-xs" textColor="text.primary" sx={{ fontWeight: 'lg' }}>
                {part}
              </Typography>
            </Box>
          ))}
        </Stack>
      }
    />
  )
}

function MetricChip({
  icon,
  ariaLabel,
  value,
  tooltipTitle,
  onClick
}: {
  icon: React.ReactNode
  ariaLabel: string
  value: React.ReactNode
  tooltipTitle?: React.ReactNode
  onClick?: () => void
}) {
  const resolvedTooltipTitle = tooltipTitle ?? (typeof value === 'string' ? `${ariaLabel}: ${value}` : ariaLabel)
  const chip = (
    <Chip
      size="sm"
      variant="soft"
      color="neutral"
      aria-label={ariaLabel}
      sx={{
        minHeight: { xs: 22, sm: 24 },
        px: { xs: 0.625, sm: 0.75 },
        borderRadius: 'sm',
        border: '1px solid rgba(196, 208, 221, 0.12)',
        backgroundColor: 'rgba(36, 48, 67, 0.58)',
        '& .MuiChip-label': {
          display: 'flex',
          alignItems: 'center',
          gap: 0.625,
          minWidth: 0
        }
      }}
    >
      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
        <Box
          component="span"
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'text.tertiary',
            fontSize: '0.85rem',
            lineHeight: 1,
            flexShrink: 0
          }}
        >
          {icon}
        </Box>
      </Box>
      {typeof value === 'string' ? (
        <Typography component="span" level="body-xs" textColor="text.primary" sx={{ fontWeight: 'lg', lineHeight: 1.1 }}>
          {value}
        </Typography>
      ) : (
        value
      )}
    </Chip>
  )

  if (!onClick) {
    return (
      <Tooltip title={resolvedTooltipTitle} variant="soft" size="sm">
        {chip}
      </Tooltip>
    )
  }

  return (
    <Tooltip title={resolvedTooltipTitle} variant="soft" size="sm">
      <Box
        component="button"
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        sx={{
          p: 0,
          m: 0,
          border: 'none',
          background: 'none',
          display: 'inline-flex',
          cursor: 'pointer',
          borderRadius: 'sm',
          '&:focus-visible': {
            outline: '2px solid var(--joy-palette-primary-500)',
            outlineOffset: 2
          }
        }}
      >
        {chip}
      </Box>
    </Tooltip>
  )
}

function HeaterThermometerIcon({ color }: { color: 'warning' | 'primary' | 'success' }) {
  const fill =
    color === 'warning'
      ? 'var(--joy-palette-warning-300)'
      : color === 'primary'
        ? 'var(--joy-palette-primary-300)'
        : 'var(--joy-palette-success-300)'

  return (
    <Box
      component="svg"
      viewBox="0 0 12 20"
      aria-hidden
      sx={{ width: '0.75rem', height: '1rem', display: 'block' }}
    >
      <Box component="rect" x="4.5" y="3" width="3" height="9.5" rx="0.5" sx={{ fill }} />
      <Box component="circle" cx="6" cy="15" r="2" sx={{ fill }} />
      <Box
        component="path"
        d="M6 0.5C4.6 0.5 3.5 1.6 3.5 3V12.1C2.6 12.8 2 13.9 2 15C2 17.2 3.8 19 6 19C8.2 19 10 17.2 10 15C10 13.9 9.4 12.8 8.5 12.1V3C8.5 1.6 7.4 0.5 6 0.5Z"
        sx={{ fill: 'none', stroke: fill, strokeWidth: 1 }}
      />
    </Box>
  )
}

function formatHmsDisplayCode(code: string): string {
  const normalized = code.toUpperCase()
  if (/^[0-9A-F]{16}$/.test(normalized)) {
    return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}`
  }
  if (/^[0-9A-F]{8}$/.test(normalized)) {
    return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}`
  }
  return normalized
}

function bambuHmsLanguageCode(): string {
  const raw = typeof navigator === 'object' && typeof navigator.language === 'string'
    ? navigator.language
    : 'en'
  const normalized = raw.toLowerCase().replace('_', '-')
  if (normalized.startsWith('zh')) return 'zh-cn'

  const short = normalized.slice(0, 2)
  switch (short) {
    case 'uk':
    case 'cs':
    case 'ru':
    case 'tr':
    case 'pt':
    case 'ko':
      return 'en'
    default:
      return short || 'en'
  }
}

function compactHmsCode(code: string): string {
  return formatHmsDisplayCode(code).replace(/-/g, '').trim().toUpperCase()
}

function hmsSupportSearchUrl(
  code: string,
  _message: string | null,
  _printerModel?: PrinterModel,
  printerSerial?: string
): string {
  const language = bambuHmsLanguageCode() === 'zh-cn' ? 'zh' : 'en'
  const baseUrl = `https://wiki.bambulab.com/${language}/hms/home`
  const displayCode = formatHmsDisplayCode(code).trim()

  const compactCode = compactHmsCode(code)
  if (/^[0-9A-F]{16}$/i.test(compactCode)) {
    const params = new URLSearchParams({
      e: compactCode,
      s: 'device_hms',
      lang: language
    })
    if (printerSerial?.trim()) {
      params.set('d', printerSerial.trim())
    }
    return `https://e.bambulab.com/index.php?${params.toString()}`
  }

  if (!displayCode) {
    return baseUrl
  }

  return `${baseUrl}#:~:text=${encodeURIComponent(displayCode)}`
}

function hmsFallbackMessage(code: string): string {
  if (/^[0-9A-F]{8}$/i.test(code)) {
    return 'No Bambu description is available for this device error yet.'
  }
  if (/^[0-9A-F]{16}$/i.test(code)) {
    return 'No Bambu description is available for this HMS code yet.'
  }
  return 'No Bambu description is available for this printer error yet.'
}

function formatPrinterAttentionSummaryText(summary: { code: string; message: string | null; count: number }): string {
  const codeLabel = formatHmsDisplayCode(summary.code)
  const message = summary.message ?? hmsFallbackMessage(summary.code)
  if (summary.count > 1) {
    return `${message} (${codeLabel}, +${summary.count - 1} more)`
  }
  return `${message} (${codeLabel})`
}

/**
 * Inline panel that surfaces HMS (Health Management System) errors
 * reported by the printer. Each row shows the dotted error code, any
 * attached message and a support link. HMS alerts are informational here;
 * Studio does not expose a generic clear action for them.
 */
/**
 * Compact danger Chip that lives in the printer card header next to
 * the actions menu. Shows the error count and opens a Joy `Menu` popover
 * on click with per-error rows. We use a Dropdown rather than a
 * Tooltip because the rows are interactive (link + dismiss button).
 */
type PrinterErrorEntry = NonNullable<PrinterStatus['deviceError']>

function PrinterErrorChip({
  chipLabel,
  menuTitle,
  errors,
  printerModel,
  printerSerial
}: {
  chipLabel: string
  menuTitle: string
  errors: PrinterStatus['hmsErrors'] | PrinterErrorEntry[]
  printerModel?: PrinterModel
  printerSerial?: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <ClickAwayListener onClickAway={() => setOpen(false)}>
      <Box sx={{ display: 'contents' }}>
        <Dropdown open={open} onOpenChange={(_event, nextOpen) => setOpen(nextOpen)}>
          <MenuButton
            slots={{ root: Chip }}
            slotProps={{
              root: {
                size: 'sm',
                variant: 'solid',
                color: 'danger',
                startDecorator: <Box component="span" aria-hidden sx={{ lineHeight: 1 }}>⚠</Box>,
                sx: { flexShrink: 0, cursor: 'pointer' },
                'aria-label': menuTitle
              }
            }}
          >
            {chipLabel}
          </MenuButton>
          <Menu
            size="sm"
            placement="bottom-end"
            modifiers={[{ name: 'offset', options: { offset: [0, 8] } }]}
            sx={{
              maxWidth: 320,
              p: 1,
              borderColor: 'var(--joy-palette-danger-700)',
              overflow: 'visible',
              '&::before, &::after': {
                content: '""',
                position: 'absolute',
                bottom: '100%',
                right: 12,
                width: 0,
                height: 0,
                borderLeft: '7px solid transparent',
                borderRight: '7px solid transparent'
              },
              '&::before': {
                borderBottom: '7px solid var(--joy-palette-danger-700)'
              },
              '&::after': {
                borderBottom: '7px solid var(--joy-palette-background-popup)',
                marginBottom: '-1px'
              }
            }}
          >
            <Stack
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{ px: 0.5, pb: 0.5 }}
            >
              <Typography level="body-xs" textColor="text.tertiary">
                {menuTitle}
              </Typography>
            </Stack>
            <Stack spacing={0.5} sx={{ px: 0.5 }}>
              {errors.map((error) => (
                <Stack
                  key={error.code}
                  direction="row"
                  spacing={1}
                  alignItems="flex-start"
                  sx={{ minWidth: 0 }}
                >
                  <Stack spacing={0.25} sx={{ flex: 1, minWidth: 0 }}>
                    <Link
                      href={hmsSupportSearchUrl(error.code, error.message, printerModel, printerSerial)}
                      target="_blank"
                      rel="noreferrer noopener"
                      underline="hover"
                      color="danger"
                      level="body-sm"
                      sx={{ whiteSpace: 'normal', alignSelf: 'flex-start' }}
                    >
                      {error.message ?? hmsFallbackMessage(error.code)}
                    </Link>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ fontFamily: 'monospace' }}>
                        {formatHmsDisplayCode(error.code)}
                      </Typography>
                    </Stack>
                  </Stack>
                </Stack>
              ))}
            </Stack>
          </Menu>
        </Dropdown>
      </Box>
    </ClickAwayListener>
  )
}

function PrinterAssistantDialog({
  printerName,
  printerModel,
  printerSerial,
  status,
  canOpenLiveView,
  canLoadFilament,
  onClose,
  onOpenLiveView,
  onLoadFilament
}: {
  printerName: string
  printerModel: PrinterModel
  printerSerial: string
  status: PrinterStatus
  canOpenLiveView: boolean
  canLoadFilament: boolean
  onClose: () => void
  onOpenLiveView: () => void
  onLoadFilament: () => void
}) {
  const attentionEntries = status.hmsErrors.length > 0
    ? status.hmsErrors
    : status.deviceError ? [status.deviceError] : []

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: '100%', maxWidth: 560 }}>
        <ModalClose />
        <Typography level="h4">{printerName} assistant</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Review the printer warning and choose the next recovery step.
        </Typography>
        <ScrollableDialogBody>
          <Stack spacing={1.25}>
            {isPausedFilamentRunoutWarning(status) && (
              <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                Follow the printer prompt to replace the empty filament, then resume once the AMS is ready.
              </Alert>
            )}
            {attentionEntries.map((entry) => (
              <Sheet key={`${entry.code}:${entry.message ?? ''}`} variant="soft" color="warning" sx={{ p: 1.25, borderRadius: 'sm' }}>
                <Stack spacing={0.5}>
                  <Link
                    href={hmsSupportSearchUrl(entry.code, entry.message, printerModel, printerSerial)}
                    target="_blank"
                    rel="noreferrer noopener"
                    underline="hover"
                    color="warning"
                    level="title-sm"
                    sx={{ alignSelf: 'flex-start', whiteSpace: 'normal' }}
                  >
                    {entry.message ?? hmsFallbackMessage(entry.code)}
                  </Link>
                  <Typography level="body-xs" textColor="text.tertiary" sx={{ fontFamily: 'monospace' }}>
                    {formatHmsDisplayCode(entry.code)}
                  </Typography>
                </Stack>
              </Sheet>
            ))}
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onClose}>Close</Button>
          {canOpenLiveView && (
            <Button variant="soft" color="neutral" startDecorator={<VisibilityRoundedIcon />} onClick={onOpenLiveView}>
              Live view
            </Button>
          )}
          {canLoadFilament && (
            <Button variant="soft" color="neutral" startDecorator={<AddIcon />} onClick={onLoadFilament}>
              Load filament
            </Button>
          )}
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

function FilamentRecoveryDialog({
  printerName,
  sources,
  submitting,
  onClose,
  onLoad
}: {
  printerName: string
  sources: PrinterRecoveryFilamentSource[]
  submitting: boolean
  onClose: () => void
  onLoad: (command: PrinterRecoveryLoadCommand) => void
}) {
  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: '100%', maxWidth: 520 }}>
        <ModalClose />
        <Typography level="h4">Load filament</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Choose the source to load on {printerName}, then resume the paused print when the printer is ready.
        </Typography>
        <ScrollableDialogBody>
          <Stack spacing={1}>
            {sources.length === 0 ? (
              <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                No configured AMS slot or external spool is ready to load right now.
              </Alert>
            ) : (
              sources.map((source) => (
                <Sheet key={source.key} variant="soft" sx={{ p: 1.25, borderRadius: 'sm' }}>
                  <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography level="title-sm">{source.label}</Typography>
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ textWrap: 'pretty' }}>
                        {source.detail}
                      </Typography>
                    </Box>
                    <Button size="sm" variant="soft" color="neutral" disabled={submitting} onClick={() => onLoad(source.command)}>
                      Load
                    </Button>
                  </Stack>
                </Sheet>
              ))
            )}
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onClose}>Close</Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

function formatFilamentRecoverySourceDetail(source: Pick<AmsSlot | ExternalSpool, 'filamentType' | 'trayInfoIdx' | 'trayName'>): string {
  const parts: string[] = []
  const filamentType = source.filamentType?.trim() ?? ''

  if (filamentType !== '') {
    parts.push(resolveCompactFilamentTypeLabel(filamentType) ?? filamentType)
  } else if (source.trayInfoIdx && source.trayInfoIdx.trim() !== '') {
    parts.push('Configured filament')
  } else {
    parts.push('Configured source')
  }

  if (
    source.trayName
    && source.trayName.trim() !== ''
    && !isRawTrayCode(source.trayName)
    && source.trayName !== source.filamentType
  ) {
    parts.push(source.trayName)
  }

  return parts.join(' · ')
}

function formatRemaining(minutes: number): string {
  return formatMinutesDuration(minutes)
}

/**
 * "how long ago a print finished" label for the history footer, mirroring the compact
 * duration format used for remaining time. Returns null when the timestamp is missing or
 * unparseable; "just now" for sub-minute elapsed times.
 */
function formatFinishedAgo(finishedAt: string | null | undefined): string | null {
  if (!finishedAt) return null
  const finishedAtMs = Date.parse(finishedAt)
  if (Number.isNaN(finishedAtMs)) return null
  const minutes = Math.max(0, Math.round((Date.now() - finishedAtMs) / 60_000))
  return minutes < 1 ? 'just now' : `${formatMinutesDuration(minutes)} ago`
}

function formatLayerSummary(status: Pick<PrinterStatus, 'currentLayer' | 'totalLayers'>): string {
  return `${status.currentLayer ?? 0} / ${status.totalLayers ?? 0}`
}

function formatEstimatedCompletionTime(minutes: number): string {
  return formatEtaFromNow(minutes)
}

function formatWifiSignal(signalDbm: number | null | undefined): string {
  if (signalDbm == null) return 'unavailable'
  return `${Math.round(signalDbm)} dBm`
}

function formatDuctMode(mode: NonNullable<PrinterStatus['ductMode']>): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1)
}

function lightNodeLabel(node: 'work' | PrinterControllableLightNode): string {
  switch (node) {
    case 'chamber':
      return 'Chamber light'
    case 'heatbed':
      return 'Heatbed light'
    case 'work':
      return 'Work light'
  }
}

function isActiveLightMode(mode: PrinterLightMode | null | undefined): boolean {
  return mode === 'on' || mode === 'flashing'
}

function formatLightMode(mode: PrinterLightMode | null | undefined): string {
  switch (mode) {
    case 'on':
      return 'Currently on'
    case 'off':
      return 'Currently off'
    case 'flashing':
      return 'Currently flashing'
    case 'unknown':
      return 'State unavailable'
    default:
      return 'Not reported'
  }
}

function lightModeForControl(status: PrinterStatus, node: PrinterControllableLightNode): PrinterLightMode | null {
  if (node === 'chamber') {
    return status.lightModes.chamber ?? (status.lightOn == null ? null : status.lightOn ? 'on' : 'off')
  }
  return status.lightModes[node]
}

/**
 * Human-readable stage label for the printer card header. Returns
 * `"Offline"` when no status frame is available, prefixes `"Offline · "`
 * to the stage when the printer is reachable but the MQTT bridge marks
 * it offline, and otherwise returns the capitalized stage name.
 */
function formatStageLabel(status: PrinterStatus | undefined): string {
  if (!status) return 'Offline'
  if ((status.stage === 'preparing' || status.stage === 'heating') && status.jobName === 'Calibration') {
    return status.online ? 'Calibrating' : 'Offline · Calibrating'
  }
  const stage = status.stage === 'finished' ? 'Idle' : capitalize(status.stage)
  return status.online ? stage : `Offline · ${stage}`
}

function printerStateFilterLabel(filter: PrinterStateFilter): string {
  switch (filter) {
    case 'idle':
      return 'Idle'
    case 'printing':
      return 'Printing'
    case 'paused':
      return 'Paused'
    case 'error':
      return 'Error'
    case 'offline':
      return 'Offline'
    case 'all':
    default:
      return 'All states'
  }
}

function matchesPrinterStateFilter(
  status: PrinterStatus | undefined,
  filter: PrinterStateFilter
): boolean {
  if (filter === 'all') return true
  if (!status || !status.online) return filter === 'offline'

  switch (filter) {
    case 'idle':
      return status.stage === 'idle' || status.stage === 'finished'
    case 'printing':
      return status.stage === 'printing' || status.stage === 'preparing' || status.stage === 'heating'
    case 'paused':
      return status.stage === 'paused'
    case 'error':
      return status.stage === 'failed' || status.deviceError != null || status.hmsErrors.length > 0
    case 'offline':
      return false
    default:
      return true
  }
}

/**
 * Applies the optional attribute filters a printer view can layer on top of the
 * state filter. Each filter is a set of allowed values; an empty set is a no-op.
 * Nozzle diameters are resolved from live status merged with the printer's saved
 * selections so the filter still works while a printer is offline.
 */
function matchesPrinterViewAttributeFilters(
  printer: Printer,
  status: PrinterStatus | undefined,
  filters: {
    modelFilter: readonly PrinterModel[]
    nozzleDiameterFilter: readonly string[]
    plateTypeFilter: readonly string[]
  }
): boolean {
  if (filters.modelFilter.length > 0 && !filters.modelFilter.includes(printer.model)) {
    return false
  }

  if (filters.nozzleDiameterFilter.length > 0) {
    const allowed = new Set(
      filters.nozzleDiameterFilter
        .map((value) => normalizeNozzleDiameter(value))
        .filter((value): value is string => value !== null)
    )
    const printerDiameters = resolvePrinterNozzleDiameters(status, printer.currentNozzleDiameters)
      .map((entry) => entry.diameter)
      .filter((value): value is string => value !== null)
    if (!printerDiameters.some((value) => allowed.has(value))) {
      return false
    }
  }

  if (filters.plateTypeFilter.length > 0) {
    const allowed = new Set(
      filters.plateTypeFilter
        .map((value) => normalizePlateType(value)?.toUpperCase())
        .filter((value): value is string => value != null)
    )
    const plateType = normalizePlateType(printer.currentPlateType)
    if (!plateType || !allowed.has(plateType.toUpperCase())) {
      return false
    }
  }

  return true
}

function filterPrintersForView(printers: Printer[], printerIds: readonly string[]): Printer[] {
  if (printerIds.length === 0) return printers
  const allowed = new Set(printerIds)
  return printers.filter((printer) => allowed.has(printer.id))
}

function sortPrintersForView(
  printers: Printer[],
  statuses: Record<string, PrinterStatus>,
  sort: PrinterViewSort
): Printer[] {
  if (sort.key === 'manual') return printers

  const direction = sort.direction === 'asc' ? 1 : -1
  return printers.slice().sort((left, right) => {
    let comparison = 0
    if (sort.key === 'name') {
      comparison = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    } else if (sort.key === 'model') {
      comparison = left.model.localeCompare(right.model, undefined, { sensitivity: 'base' })
      if (comparison === 0) {
        comparison = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
      }
    } else if (sort.key === 'state') {
      comparison = printerStateSortRank(statuses[left.id]) - printerStateSortRank(statuses[right.id])
      if (comparison === 0) {
        comparison = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
      }
    }

    if (comparison !== 0) return comparison * direction
    return left.position - right.position
  })
}

function printerStateSortRank(status: PrinterStatus | undefined): number {
  if (!status || !status.online) return 4
  if (status.stage === 'failed' || status.deviceError != null || status.hmsErrors.length > 0) return 3
  if (status.stage === 'paused') return 2
  if (status.stage === 'printing' || status.stage === 'preparing' || status.stage === 'heating') return 0
  return 1
}

/**
 * Joy UI color token for the stage label. Reflects how attention-worthy
 * the current state is: green for active progress, yellow for paused
 * (user attention needed), red for failures, neutral for idle/offline.
 */
function capitalize(value: string): string {
  if (!value) return value
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function speedLabel(level: number): string {
  switch (level) {
    case 1: return 'Silent'
    case 2: return 'Standard'
    case 3: return 'Sport'
    case 4: return 'Ludicrous'
    default: return String(level)
  }
}

function withDisabledActionReason(content: JSX.Element, reason: string | null, options?: { fill?: boolean }): JSX.Element {
  if (!reason) return content

  const fill = options?.fill ?? false

  return (
    <Tooltip title={reason} variant="soft" size="sm">
      <Box
        sx={{
          display: fill ? 'flex' : 'inline-flex',
          width: fill ? '100%' : 'fit-content',
          maxWidth: '100%',
          minWidth: 0,
          '& > *': {
            flex: fill ? 1 : '0 1 auto',
            minWidth: 0
          }
        }}
      >
        {content}
      </Box>
    </Tooltip>
  )
}

function isPrinterControlCommand(command: PrinterCommand): command is PrinterControlCommand {
  return (
    command.type === 'light' ||
    command.type === 'setAirductMode' ||
    command.type === 'setNozzleTemperature' ||
    command.type === 'setBedTemperature' ||
    command.type === 'setChamberTemperature' ||
    command.type === 'setFanSpeed' ||
    command.type === 'setPrintSpeed' ||
    command.type === 'moveAxis' ||
    command.type === 'homeAxes' ||
    command.type === 'extrudeFilament'
  )
}

function printerControlSuccessMessage(command: PrinterControlCommand): string {
  switch (command.type) {
    case 'light':
      return `${lightNodeLabel(command.node)} ${command.on ? 'turned on' : 'turned off'}`
    case 'setAirductMode':
      return `Air management set to ${formatDuctMode(command.mode)}`
    case 'setNozzleTemperature':
      return command.target > 0 ? `Nozzle target set to ${command.target}°C` : 'Nozzle heater turned off'
    case 'setBedTemperature':
      return 'Bed temperature updated'
    case 'setChamberTemperature':
      return 'Chamber temperature updated'
    case 'setFanSpeed':
      return `${fanControlLabel(command.fan)} updated`
    case 'setPrintSpeed':
      return 'Print speed updated'
    case 'moveAxis':
      return `${command.axis}-axis move requested`
    case 'homeAxes':
      return 'Homing requested'
    case 'extrudeFilament':
      return command.distanceMm > 0 ? 'Extrusion requested' : 'Retraction requested'
  }
}

function suggestedTemperatureInput(current: number | null, target: number | null): string {
  if (target != null && target > 0) return String(Math.round(target))
  if (current != null && current > 0) return String(Math.round(current))
  return ''
}

function suggestedPercentInput(value: number | null): string {
  return value != null ? String(Math.round(value)) : ''
}

function parseIntegerInput(value: string, min: number, max: number): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null
  return parsed
}

function formatTemperatureValue(value: number | null): string {
  return value != null ? `${Math.round(value)}°` : '—'
}

function formatPercentValue(value: number | null): string {
  return value != null ? `${Math.round(value)}%` : '—'
}

function fanControlLabel(fan: PrinterFanId): string {
  switch (fan) {
    case 'part':
      return 'Part fan'
    case 'aux':
      return 'Aux fan'
    case 'chamber':
      return 'Chamber fan'
  }
}


function AmsSlotEditModal({
  printerId,
  status,
  unit,
  slot,
  defaultNozzleTemp,
  rescanActive,
  onClose
}: {
  printerId: string
  status: PrinterStatus | undefined
  unit: AmsUnit
  slot: AmsSlot
  defaultNozzleTemp: number
  rescanActive: boolean
  onClose: () => void
}) {
  const normalizeSelectedPressureAdvanceProfile = (caliIdx: number | null | undefined): string => (
    caliIdx == null || caliIdx < 0 ? 'default' : String(caliIdx)
  )

  const queryClient = useQueryClient()
  const isBambuSpool = slot.trayUuid != null
  const initialBambuPreset = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === slot.trayInfoIdx)
  const [type, setType] = useState<string>(slot.filamentType ?? initialBambuPreset?.type ?? 'PLA')
  const [color, setColor] = useState<string>(slot.color ?? '#000000')
  const [trayInfoIdx, setTrayInfoIdx] = useState<string>(slot.trayInfoIdx ?? '')
  const [selectedPaProfile, setSelectedPaProfile] = useState<string>(normalizeSelectedPressureAdvanceProfile(slot.caliIdx))
  const [paEditorMode, setPaEditorMode] = useState<'idle' | 'create' | 'edit'>('idle')
  const [newPaProfileKValue, setNewPaProfileKValue] = useState<string>(slot.k != null ? slot.k.toFixed(3) : '')
  const [newPaProfileName, setNewPaProfileName] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [pendingFilamentActionLabel, setPendingFilamentActionLabel] = usePendingFilamentActionLabel(status)
  // Split-button state for the Rescan / Reset slot menu. Following Joy's
  // canonical SplitButton example (anchor ref + open flag + Menu with
  // `anchorEl`) sidesteps the z-index quirks of `Dropdown` inside a Modal.
  const [rescanMenuOpen, setRescanMenuOpen] = useState(false)
  const rescanAnchorRef = useRef<HTMLDivElement>(null)
  useControlledMenuClickAway(rescanMenuOpen, 'slot-actions-menu', () => setRescanMenuOpen(false), [rescanAnchorRef])

  /** Derive nozzle temp range from the selected filament type / preset. */
  const tempsForCurrentType = () => {
    const fromBambu = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === trayInfoIdx)
    const preset = (fromBambu?.tempMin != null && fromBambu?.tempMax != null)
      ? { tempMin: fromBambu.tempMin, tempMax: fromBambu.tempMax }
      : filamentTypeDefaults(type)
    return { tempMin: preset?.tempMin ?? 190, tempMax: preset?.tempMax ?? 230 }
  }

  const fetchPressureAdvanceProfiles = async () => {
    const params = new URLSearchParams({
      amsId: String(unit.unitId),
      slotId: String(slot.slot),
      filamentId: trayInfoIdx
    })
    const response = await apiFetch(`/api/printers/${printerId}/pressure-advance-profiles?${params.toString()}`)
    return printerPressureAdvanceProfilesResponseSchema.parse(response)
  }

  const applySelectedPressureAdvanceProfile = async (profileId: string) => {
    await apiFetch(`/api/printers/${printerId}/command`, {
      method: 'POST',
      body: {
        type: 'selectAmsPressureAdvanceProfile',
        amsId: unit.unitId,
        slotId: slot.slot,
        caliIdx: profileId === 'default' ? -1 : Number(profileId),
        filamentId: trayInfoIdx
      }
    })
  }

  const resetPressureAdvanceEditor = useCallback(() => {
    setPaEditorMode('idle')
    setNewPaProfileName('')
    setNewPaProfileKValue(slot.k != null ? slot.k.toFixed(3) : '')
  }, [slot.k])

  const send = useMutation({
    mutationFn: async () => {
      const trayColor = color.replace('#', '').padEnd(8, 'F').slice(0, 8).toUpperCase()
      const { tempMin, tempMax } = tempsForCurrentType()
      await apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: {
          type: 'setAmsSlot',
          amsId: unit.unitId,
          slotId: slot.slot,
          trayInfoIdx,
          trayColor,
          trayType: type,
          nozzleTempMin: tempMin,
          nozzleTempMax: tempMax
        }
      })
      let profileToApply = selectedPaProfile
      if (canManagePressureAdvanceProfiles) {
        if (paEditorMode !== 'idle') {
          const parsed = Number(newPaProfileKValue)
          if (!Number.isFinite(parsed)) {
            throw new Error('K value must be a number')
          }

          const trimmedProfileName = newPaProfileName.trim()
          if (trimmedProfileName === '') {
            throw new Error('Profile name is required')
          }

          if (paEditorMode === 'edit' && selectedSavedPaProfile) {
            await apiFetch(`/api/printers/${printerId}/command`, {
              method: 'POST',
              body: {
                type: 'deleteAmsPressureAdvanceProfile',
                amsId: unit.unitId,
                slotId: slot.slot,
                caliIdx: selectedSavedPaProfile.caliIdx,
                filamentId: selectedSavedPaProfile.filamentId,
                nozzleDiameter: selectedSavedPaProfile.nozzleDiameter ?? '0.4',
                extruderId: 0
              } satisfies Extract<PrinterCommand, { type: 'deleteAmsPressureAdvanceProfile' }>
            })
          }

          await apiFetch(`/api/printers/${printerId}/command`, {
            method: 'POST',
            body: {
              type: 'createAmsPressureAdvanceProfile',
              amsId: unit.unitId,
              slotId: slot.slot,
              kValue: parsed,
              filamentId: trayInfoIdx,
              settingId: selectedSavedPaProfile?.settingId ?? '',
              profileName: trimmedProfileName,
              nozzleDiameter: selectedSavedPaProfile?.nozzleDiameter ?? '0.4',
              extruderId: 0
            } satisfies Extract<PrinterCommand, { type: 'createAmsPressureAdvanceProfile' }>
          })

          const refreshedProfiles = await fetchPressureAdvanceProfiles()
          const createdProfile = [...refreshedProfiles.profiles]
            .sort((left, right) => right.caliIdx - left.caliIdx)
            .find((profile) => {
              const profileName = profile.name?.trim() ?? ''
              return profile.filamentId === trayInfoIdx
                && profileName === trimmedProfileName
                && Math.abs(profile.kValue - parsed) < 0.0005
            })

          if (!createdProfile) {
            throw new Error('Profile was saved but could not be found afterward')
          }

          profileToApply = String(createdProfile.caliIdx)
        }

        if (profileToApply === 'default' || selectedPaProfileExists || paEditorMode !== 'idle') {
          await applySelectedPressureAdvanceProfile(profileToApply)
        }
      }

      return { profileToApply }
    },
    onSuccess: async ({ profileToApply }) => {
      setError(null)
      setSelectedPaProfile(profileToApply)
      resetPressureAdvanceEditor()
      await queryClient.invalidateQueries({ queryKey: pressureAdvanceProfilesQueryKey })
      void queryClient.invalidateQueries({ queryKey: ['printer-status'] })
      onClose()
    },
    onError: (err: Error) => setError(err.message)
  })

  const resetSlot = useMutation({
    mutationFn: () =>
      apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: { type: 'resetAmsSlot', amsId: unit.unitId, slotId: slot.slot }
      }),
    onSuccess: () => {
      toast.success('Slot reset')
    },
    onError: (err: Error) => toast.error(err.message)
  })

  const loadFilament = useMutation({
    mutationFn: () =>
      apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: {
          type: 'loadAmsFilament',
          amsId: unit.unitId,
          slotId: slot.slot,
          extruderId: unit.nozzleId ?? undefined,
          nozzleTemp: defaultNozzleTemp
        }
      }),
    onSuccess: () => {
      setError(null)
      setPendingFilamentActionLabel('Loading filament')
      toast.success(`AMS ${amsUnitLetter(unit.unitId)}${slot.slot + 1} load requested`)
    },
    onError: (err: Error) => setError(err.message)
  })

  const unloadFilament = useMutation({
    mutationFn: () =>
      apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: {
          type: 'unloadAmsFilament',
          amsId: unit.unitId,
          slotId: slot.slot,
          extruderId: unit.nozzleId ?? undefined,
          nozzleTemp: defaultNozzleTemp
        }
      }),
    onSuccess: () => {
      setError(null)
      setPendingFilamentActionLabel('Unloading filament')
      toast.success(`AMS ${amsUnitLetter(unit.unitId)}${slot.slot + 1} unload requested`)
    },
    onError: (err: Error) => setError(err.message)
  })

  const pressureAdvanceProfilesQueryKey = ['printer-pressure-advance-profiles', printerId, unit.unitId, slot.slot, trayInfoIdx] as const
  const pressureAdvanceProfilesQuery = useQuery({
    queryKey: pressureAdvanceProfilesQueryKey,
    enabled: !isBambuSpool && trayInfoIdx !== '',
    queryFn: fetchPressureAdvanceProfiles
  })
  const pressureAdvanceProfiles: PrinterPressureAdvanceProfile[] = pressureAdvanceProfilesQuery.data?.profiles ?? []
  const canManagePressureAdvanceProfiles = trayInfoIdx !== ''
  const selectedSavedPaProfile = selectedPaProfile === 'default'
    ? null
    : pressureAdvanceProfiles.find((profile) => String(profile.caliIdx) === selectedPaProfile) ?? null
  const isEditingPressureAdvanceProfile = paEditorMode === 'edit'
  const selectedPaProfileExists = selectedPaProfile === 'default'
    || pressureAdvanceProfiles.some((profile) => String(profile.caliIdx) === selectedPaProfile)
  const isPressureAdvanceDraftValid = newPaProfileName.trim() !== '' && Number.isFinite(Number(newPaProfileKValue))

  const pressureAdvanceProfileLabel = (profile: Pick<PrinterPressureAdvanceProfile, 'caliIdx' | 'kValue' | 'name'>) => {
    const profileName = profile.name && profile.name.trim() !== '' ? profile.name : `Profile ${profile.caliIdx}`
    return `${profileName} · K ${profile.kValue.toFixed(3)}`
  }

  useEffect(() => {
    setSelectedPaProfile(
      trayInfoIdx === (slot.trayInfoIdx ?? '')
        ? normalizeSelectedPressureAdvanceProfile(slot.caliIdx)
        : 'default'
    )
  }, [slot.caliIdx, slot.trayInfoIdx, trayInfoIdx])

  useEffect(() => {
    setNewPaProfileKValue(slot.k != null ? slot.k.toFixed(3) : '')
  }, [slot.k])

  useEffect(() => {
    resetPressureAdvanceEditor()
  }, [resetPressureAdvanceEditor, trayInfoIdx])

  const deletePressureAdvanceProfile = useMutation({
    mutationFn: () => {
      if (!selectedSavedPaProfile) {
        return Promise.reject(new Error('Select a saved profile to delete'))
      }
      return apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: {
          type: 'deleteAmsPressureAdvanceProfile',
          amsId: unit.unitId,
          slotId: slot.slot,
          caliIdx: selectedSavedPaProfile.caliIdx,
          filamentId: selectedSavedPaProfile.filamentId,
          nozzleDiameter: selectedSavedPaProfile.nozzleDiameter ?? '0.4',
          extruderId: 0
        } satisfies Extract<PrinterCommand, { type: 'deleteAmsPressureAdvanceProfile' }>
      })
    },
    onSuccess: async () => {
      setError(null)
      setSelectedPaProfile('default')
      resetPressureAdvanceEditor()
      await queryClient.invalidateQueries({ queryKey: pressureAdvanceProfilesQueryKey })
      void queryClient.invalidateQueries({ queryKey: ['printer-status'] })
    },
    onError: (err: Error) => setError(err.message)
  })

  const startCreatingPressureAdvanceProfile = () => {
    setPaEditorMode('create')
    setNewPaProfileName('')
    setNewPaProfileKValue(slot.k != null ? slot.k.toFixed(3) : '')
  }

  const startEditingPressureAdvanceProfile = () => {
    if (!selectedSavedPaProfile) return
    setPaEditorMode('edit')
    setNewPaProfileName(selectedSavedPaProfile.name?.trim() || `Profile ${selectedSavedPaProfile.caliIdx}`)
    setNewPaProfileKValue(selectedSavedPaProfile.kValue.toFixed(3))
  }

  const cancelEditingPressureAdvanceProfile = () => {
    resetPressureAdvanceEditor()
  }

  const rescan = useMutation({
    mutationFn: () =>
      apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: {
          type: 'rescanAmsSlot',
          amsId: unit.unitId,
          slotId: slot.slot
        }
      }),
    onSuccess: () => {
      toast.success('Rescan requested')
    },
    onError: (err: Error) => toast.error(err.message)
  })

  const requestRescan = () => {
    setRescanMenuOpen(false)
    rescan.mutate()
    onClose()
  }

  const requestResetSlot = () => {
    setRescanMenuOpen(false)
    resetSlot.mutate()
    onClose()
  }

  const applyPreset = (next: string) => {
    setType(next)
  }

  const applyBambuPreset = (next: string) => {
    setTrayInfoIdx(next)
    const preset = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === next)
    if (!preset) return
    setType(preset.type)
  }

  const currentCustomPresetId = trayInfoIdx && !BAMBU_FILAMENT_PRESETS.some((preset) => preset.id === trayInfoIdx)
    ? trayInfoIdx
    : null
  const loadFilamentAvailability = getAmsLoadFilamentAvailability(status, unit.unitId, slot.slot)
  const unloadFilamentAvailability = getAmsUnloadFilamentAvailability(status, unit.unitId, slot.slot)

  type PresetOption = { id: string; label: string; brand: string }
  const presetOptions = useMemo<PresetOption[]>(() => [
    { id: '', label: 'Custom / no Bambu preset', brand: 'Custom' },
    ...(currentCustomPresetId
      ? [{ id: currentCustomPresetId, label: 'Current custom preset', brand: 'Custom' } as PresetOption]
      : []),
    ...BAMBU_FILAMENT_PRESET_GROUPS.flatMap((group) =>
      group.presets.map((preset) => ({ id: preset.id, label: preset.name, brand: group.brand }))
    )
  ], [currentCustomPresetId])
  const selectedPresetOption = useMemo(
    () => presetOptions.find((option) => option.id === trayInfoIdx) ?? presetOptions[0],
    [presetOptions, trayInfoIdx]
  )

  const selectedBambuPreset = BAMBU_FILAMENT_PRESETS.find((preset) => preset.id === trayInfoIdx)
  const selectedPresetBrand = selectedBambuPreset?.brand ?? null
  const swatchMaterial = selectedBambuPreset
    ? bambuMaterialFromPresetName(selectedBambuPreset.name)
    : bambuMaterialFromType(type)
  const { swatches: suggestedColorSwatches, usesCommonFallback } = resolveFilamentColorSwatches(swatchMaterial, { presetBrand: selectedPresetBrand })
  const colorSwatches = selectedBambuPreset
    ? suggestedColorSwatches
    : COMMON_FILAMENT_COLOR_SWATCHES
  const colorSwatchTitle = selectedBambuPreset && selectedPresetBrand === 'Bambu' && !usesCommonFallback
    ? `Bambu ${swatchMaterial ?? selectedBambuPreset.type} colors`
    : 'Common filament colors'
  const normalizedColor = normalizeHex(color).toUpperCase()
  const detectedFilament = resolveFilamentDisplay(slot)
  const detectedPresetLabel = filamentPresetLabel(slot.trayInfoIdx, detectedFilament.material, slot.filamentType)
  const detectedColorName = detectedFilament.name
  const detectedHeaderBg = filamentBackground(detectedFilament.colors, slot.color, 'var(--joy-palette-neutral-700)')
  const detectedHeaderFg = filamentTextColor(detectedFilament.colors, slot.color, 'var(--joy-palette-text-primary)')
  const showDetectedTrayName = Boolean(
    slot.trayName
    && slot.trayName !== slot.filamentType
    && slot.trayName !== detectedPresetLabel
    && slot.trayName !== detectedColorName
    && !isRawTrayCode(slot.trayName)
  )
  const showDetectedTrayCode = Boolean(slot.trayName && isRawTrayCode(slot.trayName))
  const hasFilament = hasLoadedFilament(slot.filamentType, slot.color, slot.colors, {
    trayInfoIdx: slot.trayInfoIdx,
    trayName: slot.trayName,
    trayUuid: slot.trayUuid,
    remainPercent: slot.remainPercent
  })
  const remainGrams = hasFilament && slot.remainPercent != null ? Math.round(slot.remainPercent * 10) : null
  const selectedColorName = selectedPresetBrand === 'Bambu'
    ? bambuColorName(normalizedColor, swatchMaterial) ?? commonFilamentColorName(normalizedColor)
    : commonFilamentColorName(normalizedColor) ?? (!selectedBambuPreset ? bambuColorName(normalizedColor, swatchMaterial) : null)

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 420, width: '100%' }}>
        <Typography level="h4">AMS {amsUnitLetter(unit.unitId)}{slot.slot + 1}</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          {isBambuSpool ? 'Bambu spool detected (read-only)' : 'Edit filament details'}
        </Typography>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {isBambuSpool ? (
            <DialogSection title="Detected filament" wrapInSheet={false}>
              <Sheet variant="soft" sx={{ borderRadius: 'sm', overflow: 'hidden' }}>
                <Stack
                  direction="row"
                  alignItems="center"
                  spacing={1}
                  sx={{
                    px: 1.25,
                    py: 1,
                    background: detectedHeaderBg,
                    color: detectedHeaderFg,
                    borderBottom: '1px solid rgba(0, 0, 0, 0.25)'
                  }}
                >
                  <Typography level="title-sm" sx={{ color: 'inherit', fontWeight: 'lg', flex: 1, minWidth: 0 }} noWrap>
                    {detectedColorName ?? (hasFilament ? 'Custom colour' : 'Empty')}
                  </Typography>
                </Stack>
                <Stack spacing={0.75} sx={{ px: 1.25, py: 1 }}>
                  <Typography level="body-sm">
                    {detectedPresetLabel ?? detectedFilament.material ?? slot.filamentType ?? 'Bambu filament'}
                  </Typography>
                  {showDetectedTrayName && (
                    <Typography level="body-xs" textColor="text.tertiary">
                      {slot.trayName}
                    </Typography>
                  )}
                  {showDetectedTrayCode && (
                    <Typography level="body-xs" textColor="text.tertiary">
                      Bambu code: {slot.trayName}
                    </Typography>
                  )}
                  {(detectedFilament.colors.length > 1 || (!detectedColorName && slot.color)) && (
                    <Typography level="body-xs" textColor="text.tertiary">
                      Color{detectedFilament.colors.length > 1 ? 's' : ''}: {detectedFilament.colors.length > 0 ? detectedFilament.colors.join(' · ') : slot.color ?? '—'}
                    </Typography>
                  )}
                  {hasFilament && slot.remainPercent != null && remainGrams != null && (
                    <Typography level="body-xs" textColor="text.tertiary">
                      Remaining: {Math.round(slot.remainPercent)}% (~{remainGrams}g)
                    </Typography>
                  )}
                </Stack>
              </Sheet>
            </DialogSection>
          ) : (
            <DialogSection title="Filament">
              <Stack spacing={1.25}>
                <FormControl>
                  <FormLabel>Bambu preset</FormLabel>
                  <Autocomplete
                    options={presetOptions}
                    value={selectedPresetOption}
                    onChange={(_event, value) => {
                      if (value) applyBambuPreset(value.id)
                    }}
                    getOptionLabel={(option) => option.label}
                    isOptionEqualToValue={(option, value) => option.id === value.id}
                    groupBy={(option) => option.brand}
                    disableClearable
                    selectOnFocus
                    handleHomeEndKeys
                    openOnFocus
                    slotProps={{ listbox: { sx: { maxHeight: 360 } } }}
                    renderOption={(props, option) => (
                      <AutocompleteOption {...props} key={option.id}>
                        <ListItemContent>{option.label}</ListItemContent>
                      </AutocompleteOption>
                    )}
                  />
                </FormControl>
                <FormControl>
                  <FormLabel>Color</FormLabel>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Input
                      type="color"
                      value={normalizeHex(color)}
                      onChange={(event) => setColor(event.target.value)}
                      slotProps={{ input: { 'aria-label': 'Color' } }}
                      sx={{ width: 56, p: 0.5 }}
                    />
                    <Input
                      value={color}
                      onChange={(event) => setColor(event.target.value)}
                      placeholder="#RRGGBB"
                      sx={{ flex: 1 }}
                    />
                  </Stack>
                  {selectedColorName && (
                    <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                      Known color: {selectedColorName}
                    </Typography>
                  )}
                </FormControl>
                {colorSwatches.length > 0 && (
                  <ColorSwatchPicker
                    title={colorSwatchTitle}
                    swatches={colorSwatches}
                    selectedHex={normalizedColor}
                    onPick={(hex) => setColor(hex)}
                  />
                )}
                {trayInfoIdx === '' && (
                  <FormControl>
                    <FormLabel>Type</FormLabel>
                    <Select value={type} onChange={(_event, value) => value && applyPreset(value)}>
                      {FILAMENT_PRESETS.map((preset) => (
                        <Option key={preset.type} value={preset.type}>{preset.type}</Option>
                      ))}
                    </Select>
                  </FormControl>
                )}
              </Stack>
            </DialogSection>
          )}

          {!isBambuSpool && (
            <DialogSection
              title="Pressure advance"
              description="Default uses the printer's built-in behavior. Profiles are tied to the selected filament preset and keep their own custom names."
            >
              <Stack spacing={1.25}>
                <Typography level="body-xs" textColor="text.tertiary">
                  Preset: {trayInfoIdx !== '' ? (selectedPresetOption?.label ?? 'Selected preset') : 'Select a filament preset first'}
                </Typography>
                <FormControl>
                  <FormLabel>Selected profile</FormLabel>
                  <Select
                    value={selectedPaProfile}
                    onChange={(_event, value) => value && setSelectedPaProfile(value)}
                    disabled={!canManagePressureAdvanceProfiles || pressureAdvanceProfilesQuery.isLoading || deletePressureAdvanceProfile.isPending}
                    renderValue={(option) => (
                      <Typography level="body-sm" noWrap title={typeof option?.label === 'string' ? option.label : undefined}>
                        {option?.label ?? 'Default'}
                      </Typography>
                    )}
                    slotProps={{
                      button: {
                        sx: {
                          minWidth: 0,
                          overflow: 'hidden'
                        }
                      }
                    }}
                    sx={{ minWidth: 0 }}
                  >
                    <Option value="default">Default</Option>
                    {pressureAdvanceProfiles.map((profile) => (
                      <Option key={profile.caliIdx} value={String(profile.caliIdx)}>
                        <Typography level="body-sm" noWrap title={pressureAdvanceProfileLabel(profile)}>
                          {pressureAdvanceProfileLabel(profile)}
                        </Typography>
                      </Option>
                    ))}
                  </Select>
                  {!canManagePressureAdvanceProfiles && (
                    <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                      Select a Bambu preset to load the saved profiles for that preset.
                    </Typography>
                  )}
                  {canManagePressureAdvanceProfiles && (
                    <ButtonGroup size="sm" variant="soft" color="neutral" sx={{ alignSelf: 'flex-start', mt: 1 }}>
                      <Button disabled={deletePressureAdvanceProfile.isPending || send.isPending} onClick={startCreatingPressureAdvanceProfile}>
                        New
                      </Button>
                      <Button
                        disabled={!selectedSavedPaProfile || deletePressureAdvanceProfile.isPending || send.isPending}
                        onClick={startEditingPressureAdvanceProfile}
                      >
                        Edit
                      </Button>
                      <Button
                        color="danger"
                        disabled={!selectedSavedPaProfile || send.isPending}
                        loading={deletePressureAdvanceProfile.isPending}
                        onClick={() => deletePressureAdvanceProfile.mutate()}
                      >
                        Delete
                      </Button>
                    </ButtonGroup>
                  )}
                  {pressureAdvanceProfilesQuery.isLoading && (
                    <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                      Loading saved profiles…
                    </Typography>
                  )}
                  {pressureAdvanceProfilesQuery.isError && (
                    <Typography level="body-xs" color="danger" sx={{ mt: 0.5 }}>
                      {(pressureAdvanceProfilesQuery.error as Error).message}
                    </Typography>
                  )}
                  {!pressureAdvanceProfilesQuery.isLoading && !pressureAdvanceProfilesQuery.isError && pressureAdvanceProfiles.length === 0 && (
                    <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                      No saved profiles reported for this filament yet.
                    </Typography>
                  )}
                </FormControl>
                {paEditorMode !== 'idle' && (
                  <>
                    <Divider />
                    <FormControl>
                      <FormLabel>{isEditingPressureAdvanceProfile ? 'Edit profile' : 'New profile'}</FormLabel>
                      <Input
                        value={newPaProfileName}
                        onChange={(event) => setNewPaProfileName(event.target.value)}
                        placeholder="Custom profile name"
                        disabled={!canManagePressureAdvanceProfiles || deletePressureAdvanceProfile.isPending || send.isPending}
                      />
                      <Input
                        type="number"
                        value={newPaProfileKValue}
                        onChange={(event) => setNewPaProfileKValue(event.target.value)}
                        placeholder={slot.k != null ? slot.k.toFixed(3) : '0.020'}
                        slotProps={{ input: { step: 0.001, min: 0, max: 2 } }}
                        disabled={!canManagePressureAdvanceProfiles || deletePressureAdvanceProfile.isPending || send.isPending}
                      />
                      <Button
                        size="sm"
                        variant="plain"
                        sx={{ alignSelf: 'flex-end' }}
                        disabled={send.isPending || deletePressureAdvanceProfile.isPending}
                        onClick={cancelEditingPressureAdvanceProfile}
                      >
                        Cancel {isEditingPressureAdvanceProfile ? 'edit' : 'new profile'}
                      </Button>
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                        {isEditingPressureAdvanceProfile
                          ? 'Save replaces the selected profile and applies the replacement.'
                          : 'Save creates the new named profile and applies it.'}
                      </Typography>
                    </FormControl>
                  </>
                )}
              </Stack>
            </DialogSection>
          )}

          <DialogSection
            title="Filament actions"
            description={`Heater target for load/unload defaults to ${defaultNozzleTemp}°C from this slot's configured filament profile.`}
          >
            <Stack spacing={1.25}>
              <ButtonGroup
                size="sm"
                variant="soft"
                color="neutral"
                sx={{
                  width: '100%',
                  '& > *': {
                    flex: 1,
                    minWidth: 0
                  }
                }}
              >
                {withDisabledActionReason(
                  <Button
                    loading={loadFilament.isPending}
                    disabled={unloadFilament.isPending || !loadFilamentAvailability.allowed}
                    onClick={() => loadFilament.mutate()}
                  >
                    Load filament
                  </Button>,
                  unloadFilament.isPending || loadFilament.isPending ? null : loadFilamentAvailability.reason,
                  { fill: true }
                )}
                {withDisabledActionReason(
                  <Button
                    loading={unloadFilament.isPending}
                    disabled={loadFilament.isPending || !unloadFilamentAvailability.allowed}
                    onClick={() => unloadFilament.mutate()}
                  >
                    Unload filament
                  </Button>,
                  loadFilament.isPending || unloadFilament.isPending ? null : unloadFilamentAvailability.reason,
                  { fill: true }
                )}
              </ButtonGroup>
              <FilamentChangeProgressPanel status={status} pendingActionLabel={pendingFilamentActionLabel} />
            </Stack>
          </DialogSection>

          {error && <Typography color="danger" level="body-sm">{error}</Typography>}
          <Stack direction="row" spacing={1} justifyContent="space-between" sx={{ pt: 1 }}>
            {isBambuSpool ? (
              <Button
                variant="soft"
                color="neutral"
                startDecorator={<RefreshRoundedIcon />}
                loading={rescan.isPending || rescanActive}
                onClick={requestRescan}
              >
                Rescan
              </Button>
            ) : (
              <>
                <ButtonGroup
                  ref={rescanAnchorRef}
                  variant="soft"
                  color="neutral"
                  aria-label="rescan / reset slot"
                >
                  <Button
                    startDecorator={<RefreshRoundedIcon />}
                    loading={rescan.isPending || rescanActive}
                    onClick={requestRescan}
                  >
                    Rescan
                  </Button>
                  <IconButton
                    aria-controls={rescanMenuOpen ? 'slot-actions-menu' : undefined}
                    aria-expanded={rescanMenuOpen ? 'true' : undefined}
                    aria-haspopup="menu"
                    aria-label="More slot actions"
                    onClick={() => setRescanMenuOpen((value) => !value)}
                  >
                    <ArrowDropDownIcon />
                  </IconButton>
                </ButtonGroup>
                <Menu
                  id="slot-actions-menu"
                  open={rescanMenuOpen}
                  onClose={() => setRescanMenuOpen(false)}
                  anchorEl={rescanAnchorRef.current}
                  placement="bottom-end"
                  // Joy's tooltip token (1500) is the only built-in layer
                  // that beats `modal` (1300), so a popper opened from
                  // inside a Modal renders above the dialog.
                  sx={{ zIndex: (theme) => theme.zIndex.tooltip }}
                >
                  <MenuItem
                    color="danger"
                    onClick={requestResetSlot}
                  >
                    <RestartAltRoundedIcon fontSize="small" />
                    Reset slot
                  </MenuItem>
                </Menu>
              </>
            )}
            <Stack direction="row" spacing={1}>
              <Button variant="plain" onClick={onClose}>
                {isBambuSpool ? 'Close' : 'Cancel'}
              </Button>
              {!isBambuSpool && (
                <Button
                  loading={send.isPending}
                  disabled={deletePressureAdvanceProfile.isPending || (paEditorMode !== 'idle' && !isPressureAdvanceDraftValid) || (canManagePressureAdvanceProfiles && !selectedPaProfileExists && paEditorMode === 'idle')}
                  startDecorator={<SaveRoundedIcon />}
                  onClick={() => send.mutate()}
                >
                  Save
                </Button>
              )}
            </Stack>
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  )
}

function ExternalSpoolEditModal({
  printerId,
  status,
  spool,
  spoolCount,
  defaultNozzleTemp,
  onClose
}: {
  printerId: string
  status: PrinterStatus | undefined
  spool: ExternalSpool
  spoolCount: number
  defaultNozzleTemp: number
  onClose: () => void
}) {
  const label = externalSpoolLabel(spool.amsId, spoolCount)
  const initialBambuPreset = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === spool.trayInfoIdx)
  const [type, setType] = useState<string>(spool.filamentType ?? initialBambuPreset?.type ?? 'PLA')
  const [color, setColor] = useState<string>(spool.color ?? '#000000')
  const [trayInfoIdx, setTrayInfoIdx] = useState<string>(spool.trayInfoIdx ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pendingFilamentActionLabel, setPendingFilamentActionLabel] = usePendingFilamentActionLabel(status)

  const tempsForCurrentType = () => {
    const fromBambu = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === trayInfoIdx)
    const preset = (fromBambu?.tempMin != null && fromBambu?.tempMax != null)
      ? { tempMin: fromBambu.tempMin, tempMax: fromBambu.tempMax }
      : filamentTypeDefaults(type)
    return { tempMin: preset?.tempMin ?? 190, tempMax: preset?.tempMax ?? 230 }
  }

  const send = useMutation({
    mutationFn: () => {
      const trayColor = color.replace('#', '').padEnd(8, 'F').slice(0, 8).toUpperCase()
      const { tempMin, tempMax } = tempsForCurrentType()
      return apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: {
          type: 'setExternalSpool',
          amsId: spool.amsId,
          trayInfoIdx,
          trayColor,
          trayType: type,
          nozzleTempMin: tempMin,
          nozzleTempMax: tempMax
        }
      })
    },
    onSuccess: () => onClose(),
    onError: (err: Error) => setError(err.message)
  })

  const resetSpool = useMutation({
    mutationFn: () =>
      apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: { type: 'resetExternalSpool', amsId: spool.amsId }
      }),
    onSuccess: () => {
      toast.success('External spool reset')
      onClose()
    },
    onError: (err: Error) => setError(err.message)
  })

  const loadSpool = useMutation({
    mutationFn: () =>
      apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: {
          type: 'loadExternalSpool',
          amsId: spool.amsId,
          extruderId: spool.nozzleId ?? undefined,
          nozzleTemp: defaultNozzleTemp
        }
      }),
    onSuccess: () => {
      setError(null)
      setPendingFilamentActionLabel('Loading filament')
      toast.success('External spool load requested')
    },
    onError: (err: Error) => setError(err.message)
  })

  const unloadSpool = useMutation({
    mutationFn: () =>
      apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: {
          type: 'unloadExternalSpool',
          amsId: spool.amsId,
          extruderId: spool.nozzleId ?? undefined,
          nozzleTemp: defaultNozzleTemp
        }
      }),
    onSuccess: () => {
      setError(null)
      setPendingFilamentActionLabel('Unloading filament')
      toast.success('External spool unload requested')
    },
    onError: (err: Error) => setError(err.message)
  })

  const applyPreset = (next: string) => {
    setType(next)
  }

  const applyBambuPreset = (next: string) => {
    setTrayInfoIdx(next)
    const preset = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === next)
    if (!preset) return
    setType(preset.type)
  }

  const currentCustomPresetId = trayInfoIdx && !BAMBU_FILAMENT_PRESETS.some((preset) => preset.id === trayInfoIdx)
    ? trayInfoIdx
    : null

  type PresetOption = { id: string; label: string; brand: string }
  const presetOptions = useMemo<PresetOption[]>(() => [
    { id: '', label: 'Custom / no Bambu preset', brand: 'Custom' },
    ...(currentCustomPresetId
      ? [{ id: currentCustomPresetId, label: 'Current custom preset', brand: 'Custom' } as PresetOption]
      : []),
    ...BAMBU_FILAMENT_PRESET_GROUPS.flatMap((group) =>
      group.presets.map((preset) => ({ id: preset.id, label: preset.name, brand: group.brand }))
    )
  ], [currentCustomPresetId])
  const selectedPresetOption = useMemo(
    () => presetOptions.find((option) => option.id === trayInfoIdx) ?? presetOptions[0],
    [presetOptions, trayInfoIdx]
  )

  const selectedBambuPreset = BAMBU_FILAMENT_PRESETS.find((preset) => preset.id === trayInfoIdx)
  const selectedPresetBrand = selectedBambuPreset?.brand ?? null
  const loadSpoolAvailability = getExternalSpoolLoadAvailability(status, spool.amsId)
  const unloadSpoolAvailability = getExternalSpoolUnloadAvailability(status, spool.amsId)
  const swatchMaterial = selectedBambuPreset
    ? bambuMaterialFromPresetName(selectedBambuPreset.name)
    : bambuMaterialFromType(type)
  const { swatches: suggestedColorSwatches, usesCommonFallback } = resolveFilamentColorSwatches(swatchMaterial, { presetBrand: selectedPresetBrand })
  const colorSwatches = selectedBambuPreset
    ? suggestedColorSwatches
    : COMMON_FILAMENT_COLOR_SWATCHES
  const colorSwatchTitle = selectedBambuPreset && selectedPresetBrand === 'Bambu' && !usesCommonFallback
    ? `Bambu ${swatchMaterial ?? selectedBambuPreset.type} colors`
    : 'Common filament colors'
  const normalizedColor = normalizeHex(color).toUpperCase()

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 420, width: '100%' }}>
        <Typography level="h4">{label}</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Manual filament slot. It shares the nozzle path with AMS and does not support RFID scan.
        </Typography>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <DialogSection title="Filament">
            <Stack spacing={1.25}>
              <FormControl>
                <FormLabel>Bambu preset</FormLabel>
                <Autocomplete
                  options={presetOptions}
                  value={selectedPresetOption}
                  onChange={(_event, value) => {
                    if (value) applyBambuPreset(value.id)
                  }}
                  getOptionLabel={(option) => option.label}
                  isOptionEqualToValue={(option, value) => option.id === value.id}
                  groupBy={(option) => option.brand}
                  disableClearable
                  selectOnFocus
                  handleHomeEndKeys
                  openOnFocus
                  slotProps={{ listbox: { sx: { maxHeight: 360 } } }}
                  renderOption={(props, option) => (
                    <AutocompleteOption {...props} key={option.id}>
                      <ListItemContent>{option.label}</ListItemContent>
                    </AutocompleteOption>
                  )}
                />
              </FormControl>
              <FormControl>
                <FormLabel>Color</FormLabel>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Input
                    type="color"
                    value={normalizeHex(color)}
                    onChange={(event) => setColor(event.target.value)}
                    slotProps={{ input: { 'aria-label': 'Color' } }}
                    sx={{ width: 56, p: 0.5 }}
                  />
                  <Input
                    value={color}
                    onChange={(event) => setColor(event.target.value)}
                    placeholder="#RRGGBB"
                    sx={{ flex: 1 }}
                  />
                </Stack>
              </FormControl>
              {colorSwatches.length > 0 && (
                <ColorSwatchPicker
                  title={colorSwatchTitle}
                  swatches={colorSwatches}
                  selectedHex={normalizedColor}
                  onPick={(hex) => setColor(hex)}
                />
              )}
              {trayInfoIdx === '' && (
                <FormControl>
                  <FormLabel>Type</FormLabel>
                  <Select value={type} onChange={(_event, value) => value && applyPreset(value)}>
                    {FILAMENT_PRESETS.map((preset) => (
                      <Option key={preset.type} value={preset.type}>{preset.type}</Option>
                    ))}
                  </Select>
                </FormControl>
              )}
            </Stack>
          </DialogSection>

          <DialogSection
            title="Filament actions"
            description={`Heater target for load/unload defaults to ${defaultNozzleTemp}°C from this spool's configured filament profile.`}
          >
            <Stack spacing={1.25}>
              <ButtonGroup
                size="sm"
                variant="soft"
                color="neutral"
                sx={{
                  width: '100%',
                  '& > *': {
                    flex: 1,
                    minWidth: 0
                  }
                }}
              >
                {withDisabledActionReason(
                  <Button
                    loading={loadSpool.isPending}
                    disabled={unloadSpool.isPending || !loadSpoolAvailability.allowed}
                    onClick={() => loadSpool.mutate()}
                  >
                    Load filament
                  </Button>,
                  unloadSpool.isPending || loadSpool.isPending ? null : loadSpoolAvailability.reason,
                  { fill: true }
                )}
                {withDisabledActionReason(
                  <Button
                    loading={unloadSpool.isPending}
                    disabled={loadSpool.isPending || !unloadSpoolAvailability.allowed}
                    onClick={() => unloadSpool.mutate()}
                  >
                    Unload filament
                  </Button>,
                  loadSpool.isPending || unloadSpool.isPending ? null : unloadSpoolAvailability.reason,
                  { fill: true }
                )}
              </ButtonGroup>
              <FilamentChangeProgressPanel status={status} pendingActionLabel={pendingFilamentActionLabel} />
            </Stack>
          </DialogSection>

          {error && <Typography color="danger" level="body-sm">{error}</Typography>}
          <Stack direction="row" spacing={1} justifyContent="space-between" sx={{ pt: 1 }}>
            <Button
              variant="soft"
              color="danger"
              startDecorator={<RestartAltRoundedIcon />}
              loading={resetSpool.isPending}
              onClick={() => resetSpool.mutate()}
            >
              Reset slot
            </Button>
            <Stack direction="row" spacing={1}>
              <Button variant="plain" onClick={onClose}>Cancel</Button>
              <Button loading={send.isPending} startDecorator={<SaveRoundedIcon />} onClick={() => send.mutate()}>Save</Button>
            </Stack>
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  )
}

/** Coerce a possibly 8-char `#RRGGBBAA` string to the 7-char `#RRGGBB` form HTML color inputs require. */
function normalizeHex(value: string): string {
  const hex = value.replace('#', '').slice(0, 6)
  if (!/^[0-9a-fA-F]+$/.test(hex)) return '#000000'
  return `#${hex.padStart(6, '0')}`
}

function FilamentChangeProgressPanel({
  status,
  pendingActionLabel
}: {
  status: PrinterStatus | undefined
  pendingActionLabel: string | null
}) {
  const filamentChange = status?.filamentChange
  const canUseStageFallback = status != null && (status.stage === 'paused' || isPrinterActiveJobStage(status.stage))
  const liveLabel = filamentChange?.currentStepLabel ?? (canUseStageFallback ? formatSecondaryStageLabel(status) : null)
  const summary = liveLabel ?? (pendingActionLabel ? `${pendingActionLabel} requested. Waiting for printer...` : null)
  const steps = filamentChange?.steps ?? []
  const currentStepIndex = filamentChange?.currentStepIndex ?? null
  if (!summary && steps.length === 0) return null

  return (
    <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'sm', display: 'grid', gap: 1 }}>
      <Typography level="title-sm">Filament change progress</Typography>
      {summary && (
        <Alert size="sm" color="primary" variant="soft" startDecorator={<InfoOutlinedIcon />}>
          {summary}
        </Alert>
      )}
      {steps.length > 0 && (
        <Stack spacing={0.75}>
          {steps.map((step, index) => {
            const state = currentStepIndex == null
              ? 'pending'
              : index < currentStepIndex
                ? 'done'
                : index === currentStepIndex
                  ? 'active'
                  : 'pending'

            return (
              <Stack key={`${step}-${index}`} direction="row" spacing={1} alignItems="center">
                <Chip
                  size="sm"
                  color={state === 'done' ? 'success' : state === 'active' ? 'primary' : 'neutral'}
                  variant={state === 'pending' ? 'outlined' : 'soft'}
                >
                  {index + 1}
                </Chip>
                <Typography
                  level="body-sm"
                  textColor={state === 'pending' ? 'text.tertiary' : 'text.primary'}
                  fontWeight={state === 'active' ? 'lg' : 'md'}
                >
                  {step}
                </Typography>
              </Stack>
            )
          })}
        </Stack>
      )}
    </Sheet>
  )
}


/**
 * Material "more vertical" three-dot glyph used by the row-level Actions
 * menus across the dashboard.
 */
export function MoreVertIcon() {
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      aria-hidden
      sx={{ width: '1.1em', height: '1.1em', fill: 'currentColor' }}
    >
      <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
    </Box>
  )
}

/**
 * Material "lightbulb" glyph used by the chamber-light toggle. Filled when
 * `on` is true and tinted yellow via `currentColor`, outline when off.
 */
function LightbulbIcon({ on }: { on: boolean }) {
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      aria-hidden
      sx={{
        width: 18,
        height: 18,
        color: on ? '#fbc02d' : 'currentColor',
        fill: 'currentColor'
      }}
    >
      {on ? (
        <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z" />
      ) : (
        <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7zm2.85 11.1l-.85.6V16h-4v-2.3l-.85-.6C7.8 12.16 7 10.63 7 9c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.63-.8 3.16-2.15 4.1z" />
      )}
    </Box>
  )
}

interface PrinterFormValues {
  name: string
  host: string
  serial: string
  accessCode: string
  model: PrinterModel
  bridgeId: string
  currentPlateType: string | null
  currentNozzleDiameters: PrinterNozzleDiameterSelection[]
}

interface PrinterFormModalProps {
  mode: 'add' | 'edit'
  demoMode?: boolean
  submitting: boolean
  deleting?: boolean
  error: string | null
  initialValues?: PrinterFormValues
  status?: PrinterStatus
  bridges?: BridgeSummary[]
  /** Discovered LAN printers, used in `add` mode to pre-fill the form. */
  discovered?: DiscoveredPrinter[]
  onCancel: () => void
  onSubmit: (input: PrinterFormValues) => void
  onDelete?: () => void
}

const PRINTER_MODEL_GROUPS: Array<{ label: string; models: PrinterModel[] }> = [
  { label: 'A-series', models: ['A1', 'A1mini', 'A2L'] },
  { label: 'P-series', models: ['P1P', 'P1S', 'P2S'] },
  { label: 'H-series', models: ['H2C', 'H2D', 'H2DPRO', 'H2S'] },
  { label: 'X-series', models: ['X1', 'X1C', 'X1E', 'X2D'] }
]
const OTHER_PRINTER_MODELS: PrinterModel[] = ['unknown']

/**
 * "Print from local file" launcher for a specific printer. Mounts a
 * hidden file input that fires immediately on mount, uploads the picked
 * file as a hidden bridge-backed library row, and hands the resulting
 * `LibraryFile` row back to the caller so it can open the regular
 * `PrintModal`. Cancellation (the native picker's Cancel) closes the
 * gate without uploading.
 */
function formatLocalUploadPhase(phase: ChunkedLibraryUploadPhase): string {
  switch (phase) {
    case 'sending-to-bridge':
      return 'Sending to bridge'
    case 'finalizing':
      return 'Finalizing'
    case 'waiting-for-server':
      return 'Waiting for server (rate limited)'
    case 'uploading-to-server':
    default:
      return 'Uploading to server'
  }
}

function LocalFilePrintGate({
  demoMode = false,
  printer,
  onUploaded,
  onCancel
}: {
  demoMode?: boolean
  /** The destination printer determines which bridge stores the file. */
  printer: Printer
  onUploaded: (file: LibraryFile) => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ phase: ChunkedLibraryUploadPhase; uploadedBytes: number; totalBytes: number } | null>(null)
  // Use a ref (not state) so React 18 strict-mode double-mount in dev
  // does not re-fire the click after the user has already picked a file.
  const openedRef = useRef(false)

  useEffect(() => {
    if (openedRef.current) return
    openedRef.current = true
    inputRef.current?.click()
  }, [demoMode, onCancel])

  const handleFile = async (file: File) => {
    setUploading(true)
    try {
      if (!printer.bridgeId) {
        throw new Error('Assign this printer to a bridge before printing a local file')
      }
      setUploadProgress({ phase: 'uploading-to-server', uploadedBytes: 0, totalBytes: file.size })
      const body = await uploadLibraryFileInChunks(file, {
        hidden: true,
        bridgeId: printer.bridgeId,
        onProgress: setUploadProgress
      })
      onUploaded(body.file)
    } catch (error) {
      toast.error((error as Error).message)
      onCancel()
    } finally {
      setUploading(false)
      setUploadProgress(null)
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".gcode,.gcode.3mf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) {
            onCancel()
            return
          }
          if (!isDirectPrintableFileName(file.name)) {
            toast.error('Only .gcode or .gcode.3mf files can be printed directly')
            onCancel()
            return
          }
          if (demoMode && file.size > DEMO_TEMP_UPLOAD_MAX_BYTES) {
            toast.error('Demo uploads are limited to 15 MB.')
            onCancel()
            return
          }
          void handleFile(file)
        }}
      />
      {uploading && (
        <Modal open onClose={() => undefined}>
          <ModalDialog sx={{ maxWidth: 360 }}>
            <Typography level="title-md">Uploading to {printer.name}</Typography>
            <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
              {uploadProgress ? formatLocalUploadPhase(uploadProgress.phase) : 'Preparing upload'}
            </Typography>
            <LinearProgress
              determinate={uploadProgress != null}
              value={uploadProgress ? (uploadProgress.uploadedBytes / Math.max(uploadProgress.totalBytes, 1)) * 100 : undefined}
              sx={{
                mt: 1,
                '--LinearProgress-thickness': '8px',
                '&::before': {
                  left: '2px',
                  inlineSize: 'max(calc(var(--LinearProgress-percent) * 1% - 4px), 0px)'
                }
              }}
            />
            {uploadProgress && (
              <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 1 }}>
                {Math.floor((uploadProgress.uploadedBytes / Math.max(uploadProgress.totalBytes, 1)) * 100)}%
              </Typography>
            )}
            <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 1 }}>
              The file will not be saved to the library.
            </Typography>
          </ModalDialog>
        </Modal>
      )}
    </>
  )
}

function PrinterFormModal({
  mode,
  demoMode = false,
  submitting,
  deleting = false,
  error,
  initialValues,
  status,
  bridges = [],
  discovered = [],
  onCancel,
  onSubmit,
  onDelete
}: PrinterFormModalProps) {
  const [name, setName] = useState(initialValues?.name ?? '')
  const [host, setHost] = useState(initialValues?.host ?? '')
  const [serial, setSerial] = useState(initialValues?.serial ?? '')
  const [accessCode, setAccessCode] = useState(initialValues?.accessCode ?? '')
  const [model, setModel] = useState<PrinterModel>(initialValues?.model ?? 'P1S')
  const [bridgeId, setBridgeId] = useState<string>(initialValues?.bridgeId ?? bridges[0]?.id ?? '')
  const [currentPlateType, setCurrentPlateType] = useState(initialValues?.currentPlateType ?? null)
  const [currentNozzleDiameters, setCurrentNozzleDiameters] = useState<PrinterNozzleDiameterSelection[]>(initialValues?.currentNozzleDiameters ?? [])
  const [autoDetectNozzleHardware, setAutoDetectNozzleHardware] = useState(mode === 'add' && (initialValues?.currentNozzleDiameters.length ?? 0) === 0)
  const [connectionValidation, setConnectionValidation] = useState<PrinterConnectionValidation | null>(null)
  const [connectionValidationError, setConnectionValidationError] = useState<string | null>(null)
  // Managed-bridge installs own a single bundled bridge, so picking a
  // "connection location" is meaningless — auto-select it and hide the control.
  // Fall back to the picker if more than one bridge somehow exists.
  const { managedBridge } = useRuntimePolicy()
  const hideBridgePicker = managedBridge && bridges.length === 1

  const validateConnection = useMutation({
    mutationFn: (input: { host: string; serial: string; accessCode: string; bridgeId: string }) =>
      apiFetch<PrinterConnectionValidation>('/api/printers/validate', {
        method: 'POST',
        body: input
      }),
    onError: (mutationError) => {
      setConnectionValidation(null)
      setConnectionValidationError(extractErrorMessage(mutationError))
    }
  })

  const title = mode === 'add' ? 'Add printer' : 'Edit printer'
  const submitLabel = mode === 'add' ? 'Add' : 'Save'
  const connectionValidationFeedback = buildPrinterConnectionValidationFeedback(connectionValidation)
  const submitPending = submitting || validateConnection.isPending
  const isDualNozzleModel = DUAL_NOZZLE_PRINTER_MODELS.includes(model)
  const editableExtruderIds = isDualNozzleModel ? [0, 1] : [0]
  const detectedNozzleDiameters = getDetectedPrinterNozzleDiameters(status)
  const detectedNozzleDiameterMap = new Map(detectedNozzleDiameters.map((entry) => [entry.extruderId, entry.diameter]))
  const detectedNozzleMap = new Map(printerNozzles(status).map((entry) => [entry.extruderId, entry]))
  const sharedDetectedNozzle = detectedNozzleMap.get(0) ?? detectedNozzleMap.get(1) ?? null
  const sharedDetectedNozzleDiameter = sharedDetectedNozzle?.diameter ?? null
  const sharedSelectedNozzleDiameter = sharedDetectedNozzleDiameter
    ?? currentNozzleDiameters.find((entry) => entry.extruderId === 0)?.diameter
    ?? currentNozzleDiameters[0]?.diameter
    ?? null
  const sharedDetectedNozzleSummary = sharedDetectedNozzle ? formatNozzleHardwareSummary(sharedDetectedNozzle) : null
  const discoveredPrinterGroups = useMemo(() => {
    const bridgeNamesById = new Map(bridges.map((bridge) => [bridge.id, bridge.name] as const))
    const groups: Array<{ key: string; label: string; entries: DiscoveredPrinter[] }> = []
    const groupsByKey = new Map<string, { key: string; label: string; entries: DiscoveredPrinter[] }>()

    for (const entry of discovered) {
      const key = entry.bridgeId ?? '__unknown__'
      const existing = groupsByKey.get(key)
      if (existing) {
        existing.entries.push(entry)
        continue
      }

      const nextGroup = {
        key,
        label: entry.bridgeId ? (bridgeNamesById.get(entry.bridgeId) ?? 'Unknown bridge') : 'Unknown bridge',
        entries: [entry]
      }
      groupsByKey.set(key, nextGroup)
      groups.push(nextGroup)
    }

    return groups
  }, [bridges, discovered])

  useEffect(() => {
    if (!bridgeId && bridges[0]?.id) {
      setBridgeId(bridges[0].id)
    }
  }, [bridgeId, bridges])

  const updateNozzleDiameter = (extruderId: number, diameter: string | null) => {
    setCurrentNozzleDiameters((current) => {
      const next = [...current]
      const index = next.findIndex((entry) => entry.extruderId === extruderId)
      const updated = { extruderId, diameter }
      if (index >= 0) next[index] = updated
      else next.push(updated)
      return next.sort((left, right) => left.extruderId - right.extruderId)
    })
  }

  const updateSharedNozzleDiameter = (diameter: string | null) => {
    setCurrentNozzleDiameters(editableExtruderIds.map((extruderId) => ({ extruderId, diameter })))
  }

  const clearConnectionValidation = () => {
    if (mode !== 'add') return
    setConnectionValidation(null)
    setConnectionValidationError(null)
  }

  const applyDiscovered = (entry: DiscoveredPrinter) => {
    clearConnectionValidation()
    setName(entry.name ?? `Bambu ${entry.serial.slice(-6)}`)
    setHost(entry.host)
    setSerial(entry.serial)
    setModel(entry.model)
    setBridgeId(entry.bridgeId ?? '')
  }

  const handleSubmit = async () => {
    const trimmedHost = host.trim()
    const trimmedSerial = serial.trim().toUpperCase()
    const trimmedAccessCode = accessCode.trim()
    const resolvedNozzleDiameters = mode === 'add' && autoDetectNozzleHardware
      ? []
      : resolvePrinterNozzleDiameters(status, currentNozzleDiameters)
    const normalizedNozzleDiameters = isDualNozzleModel
      ? (() => {
          const sharedDiameter = resolvedNozzleDiameters.find((entry) => entry.extruderId === 0)?.diameter
            ?? resolvedNozzleDiameters[0]?.diameter
            ?? null
          return sharedDiameter == null
            ? []
            : editableExtruderIds.map((extruderId) => ({ extruderId, diameter: sharedDiameter }))
        })()
      : resolvedNozzleDiameters
    if (!bridgeId) {
      toast.error('Choose a connected bridge before saving this printer')
      return
    }

    if (mode === 'add') {
      setConnectionValidationError(null)
      try {
        const validation = await validateConnection.mutateAsync({
          host: trimmedHost,
          serial: trimmedSerial,
          accessCode: trimmedAccessCode,
          bridgeId
        })
        setConnectionValidation(validation)
        if (!validation.ok) {
          return
        }
      } catch {
        return
      }
    }

    const input: PrinterFormValues = {
      name,
      host: trimmedHost,
      serial: trimmedSerial,
      accessCode: trimmedAccessCode,
      model,
      bridgeId,
      currentPlateType,
      currentNozzleDiameters: normalizedNozzleDiameters
    }

    onSubmit(input)
  }

  const handleFormSubmit = (event: React.FormEvent<HTMLDivElement>) => {
    event.preventDefault()
    void handleSubmit()
  }

  return (
    <Modal open onClose={onCancel}>
      <ScrollableModalDialog
        component="form"
        onSubmit={handleFormSubmit}
        sx={{ width: { xs: '96vw', sm: 640 }, maxWidth: '100%' }}
      >
        <Typography level="h4">{title}</Typography>
        <ScrollableDialogBody sx={{ mt: 1 }}>
          <Stack spacing={2}>
            {mode === 'add' && discovered.length > 0 && (
              <DialogSection
                title="Discovery"
                description="Found on your network. Choose a printer to fill the form, then enter its LAN access code from the printer screen."
              >
                <Stack spacing={1}>
                  {discoveredPrinterGroups.map((group) => (
                    <Stack key={group.key} spacing={0.5}>
                      <Typography
                        level="body-xs"
                        textColor="text.tertiary"
                        sx={{ px: 0.25, textTransform: 'uppercase', letterSpacing: '0.08em' }}
                      >
                        {group.label}
                      </Typography>
                      <Stack spacing={0.5}>
                        {group.entries.map((entry) => (
                          <Button
                            key={entry.serial}
                            variant="outlined"
                            color="neutral"
                            size="sm"
                            onClick={() => applyDiscovered(entry)}
                            sx={{ justifyContent: 'flex-start', textAlign: 'left' }}
                          >
                            <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%', minWidth: 0 }}>
                              <Typography level="body-sm" sx={{ fontWeight: 'md', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {entry.name ?? `Bambu ${entry.serial.slice(-6)}`}
                              </Typography>
                              <Chip size="sm" variant="soft">{entry.model}</Chip>
                              <Typography level="body-xs" sx={{ opacity: 0.7 }}>{entry.host}</Typography>
                            </Stack>
                          </Button>
                        ))}
                      </Stack>
                    </Stack>
                  ))}
                </Stack>
              </DialogSection>
            )}
            {demoMode ? (
              <Alert color="neutral" variant="outlined" startDecorator={<InfoOutlinedIcon />}>
                <Typography level="body-sm">
                  {PUBLIC_DEMO_PRINTER_MUTATION_NOTICE}
                </Typography>
              </Alert>
            ) : null}
            {!demoMode && bridges.length === 0 ? (
              <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                <Typography level="body-sm">
                  Connect a bridge first. Printers can only be added through a bridge.
                </Typography>
              </Alert>
            ) : null}

            <DialogSection title="Printer">
              <Stack spacing={1.25}>
                <FormControl>
                  <FormLabel>Name</FormLabel>
                  <Input value={name} onChange={(event) => setName(event.target.value)} />
                </FormControl>
                <FormControl>
                  <FormLabel>Model</FormLabel>
                  <Select value={model} onChange={(_event, value) => value && setModel(value)}>
                    {PRINTER_MODEL_GROUPS.flatMap((group, groupIndex) => {
                      const nodes = [
                        <Option key={`group-${group.label}`} value={group.models[0]} disabled sx={{ fontWeight: 'lg', opacity: 1 }}>
                          {group.label}
                        </Option>,
                        ...group.models.map((entry) => (
                          <Option key={entry} value={entry}>{entry}</Option>
                        ))
                      ]
                      if (groupIndex < PRINTER_MODEL_GROUPS.length - 1 || OTHER_PRINTER_MODELS.length > 0) {
                        nodes.push(<ListDivider key={`divider-${group.label}`} inset="gutter" />)
                      }
                      return nodes
                    })}
                    {OTHER_PRINTER_MODELS.length > 0 && (
                      <>
                        <Option value={OTHER_PRINTER_MODELS[0]} disabled sx={{ fontWeight: 'lg', opacity: 1 }}>
                          Other
                        </Option>
                        {OTHER_PRINTER_MODELS.map((entry) => (
                          <Option key={entry} value={entry}>{entry}</Option>
                        ))}
                      </>
                    )}
                  </Select>
                </FormControl>
              </Stack>
            </DialogSection>

            <DialogSection
              title="Connection"
              description="Enter the printer address, serial, LAN access code, and the bridge that can reach it on the local network."
            >
              <Stack spacing={1.25}>
                <FormControl>
                  <FormLabel>IP / hostname</FormLabel>
                  <Input value={host} onChange={(event) => {
                    clearConnectionValidation()
                    setHost(event.target.value)
                  }} />
                </FormControl>
                <FormControl>
                  <FormLabel>Serial</FormLabel>
                  <Input value={serial} onChange={(event) => {
                    clearConnectionValidation()
                    setSerial(event.target.value)
                  }} />
                </FormControl>
                <FormControl>
                  <FormLabel>LAN access code</FormLabel>
                  <Input value={accessCode} onChange={(event) => {
                    clearConnectionValidation()
                    setAccessCode(event.target.value)
                  }} />
                </FormControl>
                {mayRequireExternalStorageForActiveSkipObjects(model) ? (
                  <Alert color="neutral" variant="soft" startDecorator={<InfoOutlinedIcon />}>
                    <Typography level="body-sm">
                      For H2D-, H2S-, and P2S-class printers, active Skip Objects works best when Bambu Studio stores sent files on external storage. Internal-only active jobs may not expose object metadata yet.
                    </Typography>
                  </Alert>
                ) : null}
                {!hideBridgePicker && (
                  <FormControl required>
                    <FormLabel>Connection location</FormLabel>
                    <Select
                      value={bridgeId || null}
                      onChange={(_event, value) => {
                        clearConnectionValidation()
                        setBridgeId(value ?? '')
                      }}
                      placeholder={bridges.length > 0 ? 'Select a bridge' : 'No connected bridges available'}
                    >
                      {bridges.map((bridge) => (
                        <Option key={bridge.id} value={bridge.id}>{bridge.name}</Option>
                      ))}
                    </Select>
                    <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                      Choose the bridge that can reach this printer on the local network.
                    </Typography>
                  </FormControl>
                )}
                {connectionValidationFeedback && (
                  <Alert color={connectionValidationFeedback.color} variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                    <Stack spacing={0.25}>
                      <Typography level="body-sm" fontWeight="lg">Connection check failed</Typography>
                      {connectionValidationFeedback.messages.map((message) => (
                        <Typography key={message} level="body-sm">{message}</Typography>
                      ))}
                    </Stack>
                  </Alert>
                )}
                {connectionValidationError && <Typography color="danger" level="body-sm">{connectionValidationError}</Typography>}
              </Stack>
            </DialogSection>

            <DialogSection
              title="Installed hardware"
              description="Saved hardware settings are used for compatibility checks. Live nozzle details take over automatically when the printer reports them."
            >
              <Stack spacing={1.25} sx={{ minWidth: 0 }}>
                {mode === 'add' && (
                  <Stack spacing={0.75}>
                    <Stack direction="row" spacing={1} alignItems="flex-start">
                      <Checkbox
                        checked={autoDetectNozzleHardware}
                        onChange={(event) => setAutoDetectNozzleHardware(event.target.checked)}
                        sx={{ mt: 0.125 }}
                      />
                      <Box sx={{ minWidth: 0 }}>
                        <Typography level="body-sm">Use detected nozzle hardware when available</Typography>
                        <Typography level="body-xs" textColor="text.tertiary">
                          Recommended. PrintStream will use the printer's live nozzle details when they are available, instead of making you choose them here first.
                        </Typography>
                      </Box>
                    </Stack>
                  </Stack>
                )}
                {detectedNozzleDiameters.length > 0 && (
                  <Typography level="body-xs" textColor="primary.softColor">
                    This printer is currently reporting installed nozzle details live. Those detected values will be used for print checks and saved as the fallback when you save.
                  </Typography>
                )}
                <FormControl>
                  <FormLabel>Current plate type (optional)</FormLabel>
                  <Select
                    value={currentPlateType}
                    placeholder="Leave unset"
                    onChange={(_event, value) => setCurrentPlateType(value && value !== '__unset__' ? value : null)}
                  >
                    <Option value="__unset__">Clear selection</Option>
                    {COMMON_PLATE_TYPES.map((entry) => (
                      <Option key={entry} value={entry}>{entry}</Option>
                    ))}
                  </Select>
                  <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                    Leave this unset if you do not know the installed plate yet. You can save the printer now and set it later.
                  </Typography>
                </FormControl>
                {isDualNozzleModel ? (
                  <FormControl>
                    <FormLabel>Nozzle size</FormLabel>
                    <Select
                      value={sharedSelectedNozzleDiameter ?? '__unset__'}
                      disabled={autoDetectNozzleHardware || sharedDetectedNozzleDiameter != null}
                      onChange={(_event, value) => updateSharedNozzleDiameter(value && value !== '__unset__' ? value : null)}
                    >
                      <Option value="__unset__">Not set</Option>
                      {NOZZLE_DIAMETER_OPTIONS.map((entry) => (
                        <Option key={`shared-${entry}`} value={entry}>{formatNozzleDiameterLabel(entry) ?? entry}</Option>
                      ))}
                    </Select>
                    <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                      Applies to both nozzles. Bambu currently supports one installed nozzle size per dual-nozzle printer.
                    </Typography>
                    {sharedDetectedNozzleSummary && (
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                        Detected live: {sharedDetectedNozzleSummary}
                      </Typography>
                    )}
                  </FormControl>
                ) : editableExtruderIds.map((extruderId) => {
                  const detectedNozzle = detectedNozzleMap.get(extruderId)
                  const selectedDiameter = detectedNozzleDiameterMap.get(extruderId)
                    ?? currentNozzleDiameters.find((entry) => entry.extruderId === extruderId)?.diameter
                    ?? null
                  const hardwareSummary = detectedNozzle ? formatNozzleHardwareSummary(detectedNozzle) : null
                  return (
                    <FormControl key={extruderId}>
                      <FormLabel>Nozzle size</FormLabel>
                      <Select
                        value={selectedDiameter ?? '__unset__'}
                        disabled={autoDetectNozzleHardware || detectedNozzleDiameterMap.has(extruderId)}
                        onChange={(_event, value) => updateNozzleDiameter(extruderId, value && value !== '__unset__' ? value : null)}
                      >
                        <Option value="__unset__">Not set</Option>
                        {NOZZLE_DIAMETER_OPTIONS.map((entry) => (
                          <Option key={`${extruderId}-${entry}`} value={entry}>{formatNozzleDiameterLabel(entry) ?? entry}</Option>
                        ))}
                      </Select>
                      {hardwareSummary && (
                        <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                          Detected live: {hardwareSummary}
                        </Typography>
                      )}
                    </FormControl>
                  )
                })}
              </Stack>
            </DialogSection>
          </Stack>
        </ScrollableDialogBody>
        {error && <Typography color="danger" level="body-sm">{error}</Typography>}
        <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            {mode === 'edit' && onDelete && (
              <Button type="button" variant="soft" color="danger" loading={deleting} disabled={submitPending} startDecorator={<DeleteRoundedIcon />} onClick={onDelete}>
                Remove
              </Button>
            )}
          </Box>
          <Stack direction="row" spacing={1} justifyContent="flex-end" alignItems="center" sx={{ ml: 'auto' }}>
            <Button type="button" variant="plain" onClick={onCancel} disabled={submitPending}>Cancel</Button>
            <Button
              type="submit"
              loading={submitPending}
              disabled={demoMode || bridges.length === 0 || deleting}
              startDecorator={mode === 'add' ? <AddIcon /> : <SaveRoundedIcon />}
            >
              {submitLabel}
            </Button>
          </Stack>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

/**
 * Lightweight library picker used by the printer card's "Print" button.
 *
 * Mirrors {@link LibraryView}'s folder navigation (root listing + drill-in)
 * but only surfaces direct-printable files. When launched from a specific
 * printer card, incompatible files stay visible for context but are
 * disabled with a short compatibility note before handing control back to
 * {@link PrintModal}.
 */
function LibraryPickerModal({
  printerName,
  printerModel,
  canSlice,
  onPick,
  onClose
}: {
  /** Optional printer name shown in the dialog title. Omit when the
   * caller has not yet chosen a printer (e.g. the page-level Print
   * button) — the user picks the printer in the subsequent PrintModal. */
  printerName?: string
  printerModel?: PrinterModel
  canSlice: boolean
  onPick: (file: LibraryFile) => void
  onClose: () => void
}) {
  const PICKER_ICON_DIALOG_MAX_WIDTH = 640
  const [folderId, setFolderId] = useState<string | null>(null)
  const [bridgeId, setBridgeId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [filtersDialogOpen, setFiltersDialogOpen] = useState(false)
  const [fileTypeFilter, setFileTypeFilter] = useState<string>(LIBRARY_METADATA_FILTER_ALL)
  const [printerModelFilter, setPrinterModelFilter] = useState<string>(LIBRARY_METADATA_FILTER_ALL)
  const [nozzleSizeFilter, setNozzleSizeFilter] = useState<string>(LIBRARY_METADATA_FILTER_ALL)
  const [plateTypeFilter, setPlateTypeFilter] = useState<string>(LIBRARY_METADATA_FILTER_ALL)
  const [viewMode, setViewMode] = useLocalStorageState<LibraryViewMode>(
    LIBRARY_VIEW_MODE_KEY,
    'list',
    parseLibraryViewMode,
    String
  )
  const [sort, setSort] = useLocalStorageState<LibrarySort>(
    LIBRARY_SORT_KEY,
    { key: 'name', dir: 'asc' },
    parseLibrarySort
  )

  const browseQuery = useQuery({
    queryKey: ['library-browse', 'printer-picker', folderId ?? 'root', bridgeId ?? 'none'],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      if (folderId) params.set('folderId', folderId)
      if (bridgeId) params.set('bridgeId', bridgeId)
      const search = params.toString()
      return apiFetch<LibraryBrowseResponse>(`/api/library/browse${search ? `?${search}` : ''}`, { signal })
    }
  })
  const browseData = browseQuery.data
  const resolvedBridgeId = browseData?.activeBridgeId ?? bridgeId
  const foldersQuery = useQuery({
    queryKey: ['library-folders', 'printer-picker', resolvedBridgeId ?? 'none'],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      if (resolvedBridgeId) params.set('bridgeId', resolvedBridgeId)
      const search = params.toString()
      return apiFetch<{ folders: LibraryFolder[] }>(`/api/library/folders${search ? `?${search}` : ''}`, { signal })
    }
  })
  const bridgeRootMode = browseData?.mode === 'bridge-root'
  const bridgeEntries = browseData?.bridgeEntries ?? []
  const bridgeFolders = bridgeEntries.map((bridge) => ({ id: toBridgeFolderId(bridge.id), name: bridge.name, parentId: null } satisfies LibraryFolder))
  const allFolders = foldersQuery.data?.folders ?? []
  const pickerFiles = useMemo(
    () => (browseData?.files ?? []).filter((file) => isDirectPrintableFileName(file.name) || (canSlice && isUnslicedThreeMfFile(file))),
    [browseData?.files, canSlice]
  )
  const fileTypeOptions = useMemo(
    () => collectDistinctLibraryFilterValues(pickerFiles.map((file) => formatLibraryFileKindLabel(file.name, file.kind))),
    [pickerFiles]
  )
  const printerModelOptions = useMemo(
    () => collectDistinctLibraryFilterValues(pickerFiles.flatMap((file) => file.compatiblePrinterModels)),
    [pickerFiles]
  )
  const nozzleSizeOptions = useMemo(
    () => collectDistinctLibraryFilterValues(pickerFiles.flatMap((file) => file.nozzleSizeChips)),
    [pickerFiles]
  )
  const plateTypeOptions = useMemo(
    () => collectDistinctLibraryFilterValues(pickerFiles.flatMap((file) => file.plateTypeChips)),
    [pickerFiles]
  )
  const activeFilterCount = Number(fileTypeFilter !== LIBRARY_METADATA_FILTER_ALL)
    + Number(printerModelFilter !== LIBRARY_METADATA_FILTER_ALL)
    + Number(nozzleSizeFilter !== LIBRARY_METADATA_FILTER_ALL)
    + Number(plateTypeFilter !== LIBRARY_METADATA_FILTER_ALL)
  const metadataFilteredFiles = useMemo(
    () => filterLibraryFilesByMetadata(pickerFiles, {
      fileType: fileTypeFilter,
      printerModel: printerModelFilter,
      nozzleSize: nozzleSizeFilter,
      plateType: plateTypeFilter
    }, LIBRARY_METADATA_FILTER_ALL),
    [fileTypeFilter, nozzleSizeFilter, pickerFiles, plateTypeFilter, printerModelFilter]
  )
  const filteredEntries = useMemo(
    () => filterLibraryEntries(bridgeRootMode ? bridgeFolders : (browseData?.folders ?? []), metadataFilteredFiles, deferredSearch),
    [bridgeFolders, bridgeRootMode, browseData?.folders, deferredSearch, metadataFilteredFiles]
  )
  const filteredFolders = filteredEntries.folders
  const filteredFiles = filteredEntries.files
  const pickerEntryCount = filteredFolders.length + filteredFiles.length
  const pickerIconColumnCount = Math.min(Math.max(pickerEntryCount, 1), 3)
  const activeBridgeName = resolvedBridgeId ? bridgeEntries.find((bridge) => bridge.id === resolvedBridgeId)?.name ?? null : null
  const breadcrumb = buildLibraryBreadcrumb(allFolders, folderId, resolvedBridgeId, activeBridgeName, {
    showRoot: bridgeEntries.length !== 1
  })

  useEffect(() => {
    if (fileTypeFilter !== LIBRARY_METADATA_FILTER_ALL && !fileTypeOptions.includes(fileTypeFilter)) {
      setFileTypeFilter(LIBRARY_METADATA_FILTER_ALL)
    }
  }, [fileTypeFilter, fileTypeOptions])

  useEffect(() => {
    if (printerModelFilter !== LIBRARY_METADATA_FILTER_ALL && !printerModelOptions.includes(printerModelFilter)) {
      setPrinterModelFilter(LIBRARY_METADATA_FILTER_ALL)
    }
  }, [printerModelFilter, printerModelOptions])

  useEffect(() => {
    if (nozzleSizeFilter !== LIBRARY_METADATA_FILTER_ALL && !nozzleSizeOptions.includes(nozzleSizeFilter)) {
      setNozzleSizeFilter(LIBRARY_METADATA_FILTER_ALL)
    }
  }, [nozzleSizeFilter, nozzleSizeOptions])

  useEffect(() => {
    if (plateTypeFilter !== LIBRARY_METADATA_FILTER_ALL && !plateTypeOptions.includes(plateTypeFilter)) {
      setPlateTypeFilter(LIBRARY_METADATA_FILTER_ALL)
    }
  }, [plateTypeFilter, plateTypeOptions])

  function clearMetadataFilters() {
    setFileTypeFilter(LIBRARY_METADATA_FILTER_ALL)
    setPrinterModelFilter(LIBRARY_METADATA_FILTER_ALL)
    setNozzleSizeFilter(LIBRARY_METADATA_FILTER_ALL)
    setPlateTypeFilter(LIBRARY_METADATA_FILTER_ALL)
  }

  return (
    <Modal open onClose={onClose}>
      <ModalDialog
        sx={{
          maxWidth: PICKER_ICON_DIALOG_MAX_WIDTH,
          width: {
            xs: '100%',
            sm: viewMode === 'icon' ? 'fit-content' : '100%'
          }
        }}
      >
        <ModalClose />
        <Typography level="h4">{printerName ? `Print on ${printerName}` : 'Print from library'}</Typography>
        <Typography level="body-sm" textColor="text.tertiary" sx={{ mb: 1 }}>
          Choose a file from your library.
        </Typography>

        <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
          <DialogSection title="Location">
              <LibraryBreadcrumb
                crumbs={breadcrumb}
                onNavigate={(folderEntryId) => {
                  if (folderEntryId === null) {
                    setFolderId(null)
                    setBridgeId(null)
                    return
                  }
                  if (isBridgeFolderId(folderEntryId)) {
                    setBridgeId(fromBridgeFolderId(folderEntryId))
                    setFolderId(null)
                    return
                  }
                  setFolderId(folderEntryId)
                }}
              />
          </DialogSection>

          <DialogSection title="Files">
              <Stack spacing={1}>
                <Stack spacing={1}>
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: {
                        xs: 'minmax(0, 1fr) auto',
                        md: 'repeat(4, minmax(0, 1fr))'
                      },
                      gap: 1,
                      alignItems: 'center'
                    }}
                  >
                    <Input
                      size="sm"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search files and folders"
                      startDecorator={<SearchRoundedIcon />}
                      slotProps={{ input: { 'aria-label': 'Search print library' } }}
                      sx={{ minWidth: 0, gridColumn: { md: 'span 3' } }}
                    />
                    <DirectoryFiltersButton
                      activeCount={activeFilterCount}
                      onClick={() => setFiltersDialogOpen(true)}
                      disabled={fileTypeOptions.length === 0 && printerModelOptions.length === 0 && nozzleSizeOptions.length === 0 && plateTypeOptions.length === 0}
                    />
                  </Box>

                  {activeFilterCount > 0 && (
                    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                      {fileTypeFilter !== LIBRARY_METADATA_FILTER_ALL && (
                        <Chip size="sm" variant="soft" color="neutral">{fileTypeFilter}</Chip>
                      )}
                      {printerModelFilter !== LIBRARY_METADATA_FILTER_ALL && (
                        <Chip size="sm" variant="soft" color="neutral">{printerModelFilter}</Chip>
                      )}
                      {nozzleSizeFilter !== LIBRARY_METADATA_FILTER_ALL && (
                        <Chip size="sm" variant="soft" color="neutral">{nozzleSizeFilter}</Chip>
                      )}
                      {plateTypeFilter !== LIBRARY_METADATA_FILTER_ALL && (
                        <Chip size="sm" variant="soft" color="neutral">{plateTypeFilter}</Chip>
                      )}
                      <Button size="sm" variant="plain" color="neutral" onClick={clearMetadataFilters}>
                        Clear filters
                      </Button>
                    </Stack>
                  )}
                </Stack>

                <LibraryToolbar
                  viewMode={viewMode}
                  onViewModeChange={setViewMode}
                  sort={sort}
                  onSortChange={setSort}
                  rightAlignViewModeOnMobile
                />

                <Box
                  sx={{
                    maxHeight: '60vh',
                    overflowY: 'auto',
                    pr: 0.5,
                    width: {
                      xs: '100%',
                      sm: viewMode === 'icon' ? 'fit-content' : '100%'
                    },
                    maxWidth: '100%'
                  }}
                >
                  <LibraryBrowser
                    folders={filteredFolders}
                    files={filteredFiles}
                    viewMode={viewMode}
                    sort={sort}
                    surfaceStyle="dialog"
                    hideFilamentSwatches
                    stretchIconColumns={false}
                    iconColumnCount={viewMode === 'icon' ? pickerIconColumnCount : undefined}
                    onFolderOpen={(folder) => {
                      if (isBridgeFolderId(folder.id)) {
                        setBridgeId(fromBridgeFolderId(folder.id))
                        setFolderId(null)
                        return
                      }
                      setFolderId(folder.id)
                    }}
                    onFilePick={onPick}
                    isFilePickable={(file) => {
                      if (isDirectPrintableFileName(file.name)) {
                        return printerModel ? isPrinterModelCompatible(file.compatiblePrinterModels, printerModel) : true
                      }
                      return canSlice && isUnslicedThreeMfFile(file)
                    }}
                    getFileDisabledReason={(file) => {
                      if (isDirectPrintableFileName(file.name)) {
                        return printerModel && !isPrinterModelCompatible(file.compatiblePrinterModels, printerModel)
                          ? `Not compatible with ${printerModel}.`
                          : null
                      }
                      if (isUnslicedThreeMfFile(file) && !canSlice) {
                        return 'You need Library Upload permission to slice 3MF files before printing.'
                      }
                      return null
                    }}
                    emptyText={
                      browseQuery.isLoading
                        ? 'Loading…'
                        : deferredSearch.trim()
                          ? 'No matches found.'
                          : activeFilterCount > 0
                            ? 'No files match the current filters.'
                        : bridgeRootMode
                          ? 'No bridges connected.'
                          : canSlice ? 'No printable or slicable files here.' : 'No printable files here.'
                    }
                  />
                </Box>
              </Stack>
          </DialogSection>
        </Stack>

        <DirectoryFiltersDialog
          open={filtersDialogOpen}
          title="Print library filters"
          onClose={() => setFiltersDialogOpen(false)}
          onClear={clearMetadataFilters}
          clearDisabled={activeFilterCount === 0}
        >
          <FormControl>
            <FormLabel>File type</FormLabel>
            <Select<string>
              size="sm"
              value={fileTypeFilter}
              onChange={(_event, value) => setFileTypeFilter(value ?? LIBRARY_METADATA_FILTER_ALL)}
              disabled={fileTypeOptions.length === 0}
            >
              <Option value={LIBRARY_METADATA_FILTER_ALL}>All file types</Option>
              {fileTypeOptions.map((value) => (
                <Option key={value} value={value}>{value}</Option>
              ))}
            </Select>
          </FormControl>
          <FormControl>
            <FormLabel>Printer model</FormLabel>
            <Select<string>
              size="sm"
              value={printerModelFilter}
              onChange={(_event, value) => setPrinterModelFilter(value ?? LIBRARY_METADATA_FILTER_ALL)}
              disabled={printerModelOptions.length === 0}
            >
              <Option value={LIBRARY_METADATA_FILTER_ALL}>All printer models</Option>
              {printerModelOptions.map((value) => (
                <Option key={value} value={value}>{value}</Option>
              ))}
            </Select>
          </FormControl>
          <FormControl>
            <FormLabel>Nozzle size</FormLabel>
            <Select<string>
              size="sm"
              value={nozzleSizeFilter}
              onChange={(_event, value) => setNozzleSizeFilter(value ?? LIBRARY_METADATA_FILTER_ALL)}
              disabled={nozzleSizeOptions.length === 0}
            >
              <Option value={LIBRARY_METADATA_FILTER_ALL}>All nozzle sizes</Option>
              {nozzleSizeOptions.map((value) => (
                <Option key={value} value={value}>{value}</Option>
              ))}
            </Select>
          </FormControl>
          <FormControl>
            <FormLabel>Plate type</FormLabel>
            <Select<string>
              size="sm"
              value={plateTypeFilter}
              onChange={(_event, value) => setPlateTypeFilter(value ?? LIBRARY_METADATA_FILTER_ALL)}
              disabled={plateTypeOptions.length === 0}
            >
              <Option value={LIBRARY_METADATA_FILTER_ALL}>All plate types</Option>
              {plateTypeOptions.map((value) => (
                <Option key={value} value={value}>{value}</Option>
              ))}
            </Select>
          </FormControl>
        </DirectoryFiltersDialog>

        <Stack direction="row" justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onClose}>Cancel</Button>
        </Stack>
      </ModalDialog>
    </Modal>
  )
}

function collectDistinctLibraryFilterValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right))
}
