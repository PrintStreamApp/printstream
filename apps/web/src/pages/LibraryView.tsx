/**
 * Library top-level view: browse folders/files, upload, rename/move/recycle,
 * file versions, and the in-view 3D preview overlay. Also home to the shared
 * slice/print dialog stack exported for reuse elsewhere — `SliceFileModal`,
 * `SliceThenPrintModal`, `SliceResultModal`, `PrintModal`, and the
 * `SliceSettingsPanel`/`SliceSettingsController` consumed by the model studio.
 */
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import {
  Alert, Autocomplete, AutocompleteOption, Box, Button, ButtonGroup, Card, CardContent, Checkbox, Chip, CircularProgress, DialogActions, Dropdown, FormControl, FormHelperText, FormLabel, IconButton, Link,
  Input, LinearProgress, ListItemContent, Menu, MenuButton, MenuItem, ModalDialog, Option, Select, Sheet, Stack, Tooltip, Typography
} from '@mui/joy'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import CreateNewFolderRoundedIcon from '@mui/icons-material/CreateNewFolderRounded'
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import DriveFolderUploadRoundedIcon from '@mui/icons-material/DriveFolderUploadRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import FileUploadRoundedIcon from '@mui/icons-material/FileUploadRounded'
import DriveFileMoveRoundedIcon from '@mui/icons-material/DriveFileMoveRounded'
import FolderOpenRoundedIcon from '@mui/icons-material/FolderOpenRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import ContentCutRoundedIcon from '@mui/icons-material/ContentCutRounded'
import DesignServicesRoundedIcon from '@mui/icons-material/DesignServicesRounded'
import RestoreRoundedIcon from '@mui/icons-material/RestoreRounded'
import RestoreFromTrashRoundedIcon from '@mui/icons-material/RestoreFromTrashRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ExternalSpool,
  FilamentCompatibilityIssue,
  LibraryBrowseResponse,
  LibraryFile,
  LibraryFileVersion,
  LibraryFolder,
  NozzleDiameterCompatibilityIssue,
  PrintDispatchJob,
  PrintNozzleOffsetCalibrationMode,
  PrintOnOffAutoMode,
  PrinterNozzleFlow,
  SlicingCapabilities,
  SlicingProfileSummary,
  SlicingProfilesResponse,
  SlicingJobResponse,
  Permission,
  Printer,
  PrinterStatus,
  SceneEdit,
  SceneEditFilament,
  SlicingManualProfileTarget,
  StartOrderPrintInput,
  ThreeMfIndex,
  ThreeMfProjectFilament
} from '@printstream/shared'
import {
  LIBRARY_DOWNLOAD_PERMISSION,
  LIBRARY_MANAGE_PERMISSION,
  LIBRARY_UPLOAD_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  PRINTERS_CLEAR_PLATE_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION,
  buildRequiredNozzleDiametersByExtruder,
  findFilamentCompatibilityIssues,
  findNozzleDiameterCompatibilityIssues,
  formatNozzleDiameterLabel,
  formatNozzleLabel,
  getPrinterControlCapabilities,
  getPrinterPrintStartOptions,
  getPrinterPrintOptionCapabilities,
  isDirectPrintableFileName,
  isPlateTypeCompatible,
  isPrinterModelCompatible,
  normalizeFallbackPlateLabel,
  resolvePrinterNozzleDiameters,
  supportsPrinterDoorSensor
} from '@printstream/shared'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { apiFetch } from '../lib/apiClient'

const ProcessSettingsDialog = lazy(() => import('../components/ProcessSettingsDialog'))
const PerObjectSettingsDialog = lazy(() => import('../components/PerObjectSettingsDialog'))
import { buildApiUrl } from '../lib/apiUrl'
import { bambuModelKeysAreCompatible } from '../lib/bambuPrinterModels'
import { COMMON_FILAMENT_COLOR_SWATCHES, commonFilamentColorName, filamentBackground, filamentTextColor, hasLoadedFilament, resolveFilamentColorSwatches, resolveFilamentDisplay, resolveProjectFilamentColorName } from '../lib/filamentColor'
import { prioritizeLoadedMaterialOptionsForFilament } from '../lib/sliceLoadedMaterialOptions'
import {
  extractLayerHeightToken,
  formatSlicingProfileDisplayName,
  isProjectProfileAllowedForTarget,
  isSelectableOrProjectFallbackSlicingProfile,
  isSelectableSlicingProfile,
  pickMostSimilarSlicingProfileByName,
  pickProjectFallbackSlicingProfileByName,
  pickSelectableSlicingProfileByName,
  pickSlicingProfileByBakedName,
  pickStandardProcessProfile,
  resolveSliceDisabledReason
} from '../lib/slicingProfileSelection'
import {
  buildFilamentMappings,
  buildInitialFilamentColorSelection,
  buildInitialFilamentMaterialOptionSelection,
  buildInitialFilamentToolheadSelection,
  buildLegacyMachineSwitchWarning,
  buildLoadedPrinterMaterialOptions,
  buildProjectSlicingProfiles,
  buildSliceDialogProjectFilaments,
  buildSliceDialogToolheads,
  buildSliceMaterialOptions,
  dedupeVisibleProcessProfiles,
  ensurePrinterModelOptions,
  formatPlateTypeLabel,
  formatPrinterModelLabel,
  groupSliceMaterialOptionsByGroup,
  isFilamentProfileCompatible,
  isMachineProfileCompatible,
  isProcessProfileCompatible,
  isProjectSlicingProfile,
  isVisibleFilamentProfile,
  isVisibleProcessProfile,
  matchesPrinterModel,
  mergeProjectSlicingProfiles,
  narrowMaterialOptions,
  normalizeSliceFilamentColor,
  pickMachineProfileByName,
  pickMachineProfileForPrinter,
  resolveCompatiblePlateTypes,
  resolveInitialManualPrinterModel,
  resolveInitialNozzleDiameter,
  resolveInitialPlateType,
  resolveMaterialTypeOptions,
  resolveSliceDialogNozzleDiameterOptions,
  resolveSliceDialogSourcePrinterModel,
  resolveSliceDialogTargetPrinterModel,
  slicingProfilesResponseIsUsable,
  type LoadedMaterialSource,
  type SliceMaterialOption
} from '../lib/sliceProfileMatching'
import { getSlotRemainingState, estimateRemainGrams } from '../lib/slotRemaining'
import { invalidateLibraryQueries } from '../lib/libraryQueryInvalidation'
import { useAuthBootstrapQuery } from '../lib/authQuery'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../lib/workspaceScope'
import {
  PLATE_CLEARING_STATE_QUERY_KEY,
  mergePlateClearingState,
  type PlateClearingStateResponse,
  usePlateClearingStates,
  usePlateClearingSync
} from '../lib/plateClearing'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { useMobileViewport } from '../components/useMobileViewport'
import { ColorSwatchPicker } from '../components/ColorSwatchPicker'
import { EmptyState } from '../components/EmptyState'
import { LibraryDestinationDialog } from '../components/LibraryDestinationDialog'
import { LibraryBreadcrumb } from '../components/LibraryBreadcrumb'
import { LibraryRecycleBinModal } from '../components/LibraryRecycleBinModal'
import { CreateFolderModal, MoveFolderModal, RenameFolderModal } from '../components/library/LibraryFolderDialogs'
import { RenameFileModal } from '../components/library/RenameFileModal'
import { MoveFileModal, MoveFilesModal } from '../components/library/MoveFilesDialog'
import { FileHistoryDialog } from '../components/library/FileHistoryDialog'
import { NoConnectedBridgesEmptyState } from '../components/NoConnectedBridgesEmptyState'
import { OverflowTooltipText } from '../components/OverflowTooltipText'
import { BackAwareModal as Modal } from '../components/BackAwareModal'
import { LibraryPlateCardPicker } from '../components/LibraryPlateSelect'
import { PaginatedSection } from '../components/PaginationFooter'
import { usePromptDialog } from '../components/PromptDialogProvider'
import { ScrollableDialogBody, ScrollableModalDialog } from '../components/ScrollableDialog'
import { DirectoryFiltersButton, DirectoryFiltersDialog, DirectoryPrimaryToolbar } from '../components/DirectoryToolbar'
import {
  LIBRARY_DRAG_MIME,
  LibraryBrowser,
  type LibraryDragItem,
  type LibrarySort,
  type LibraryViewMode
} from '../components/LibraryBrowser'
import { PluginSlot } from '../plugin/PluginSlot'
import { formatLibraryFileKindLabel, formatLibraryFileName, splitLibraryFileNameForRename } from '../lib/libraryDisplay'
import { parseLibraryDragItem } from '../lib/libraryDragItem'
import { filterLibraryEntries, filterLibraryFilesByMetadata, paginateLibraryEntries, sortLibraryEntries } from '../lib/libraryDirectory'
import { isPreviewOnlyLibraryFile, isUnslicedThreeMfFile } from '../lib/libraryFileTags'
import { getMeshThumbnailProvider } from '../lib/modelThumbnailRegistry'
import { buildLibraryBreadcrumb, buildLibraryFolderRoute, fromBridgeFolderId, isBridgeFolderId, toBridgeFolderId } from '../lib/libraryNavigation'
import { buildTenantWorkspacePath } from '../lib/workspaceRoute'
import { enqueueLibraryUploads, type LibraryUploadDestination } from '../lib/libraryUploadQueue'
import {
  collectUploadTreeFromDataTransfer,
  collectUploadTreeFromFileList,
  type LibraryUploadTreeItem
} from '../lib/libraryUploadTree'
import {
  formatSlicingProgress,
  getLatestSlicingProgressFrame,
  getSlicingJobStatusLabel,
  slicingStatusColor
} from '../lib/slicingJobPresentation'
import { formatSecondsDuration } from '../lib/time'
import { buildDefaultAmsMappingFromSlicingTarget } from '../lib/slicingPrintHandoff'
import { amsUnitLetter, filterTrayGroupsForFilament, sanitizeTrayMapping, type PrinterTrayGroup as PrinterTrayGroupBase } from '../lib/printerTrayMapping'
import { AmsSpoolSetupDialog, type AmsSpoolSetupTarget } from '../components/AmsSpoolSetupDialog'
import {
  buildPrintStartPreferenceKey,
  DEFAULT_STORED_PRINT_START_OPTIONS,
  mergePrintStartOptions,
  parseStoredPrintStartOptions,
  resolveFirstLayerInspectionDefault,
  resolvePrintStartPreferenceDefaults
} from '../lib/printStartOptions'
import { useRuntimePolicy } from '../lib/runtimePolicy'
import { toast } from '../lib/toast'
import { suppressJobToast } from '../lib/dialogToastSuppression'
import { useSlicingJobs } from '../hooks/useSlicingJobs'
import { useDeepStableValue } from '../hooks/useDeepStableValue'
import { useControlledMenuClickAway } from '../hooks/useControlledMenuClickAway'

const LIBRARY_VIEW_MODE_KEY = 'bambu.library.viewMode'
const LIBRARY_SORT_KEY = 'bambu.library.sort'
const LIBRARY_PAGE_SIZE_OPTIONS = [25, 50, 100] as const
const LIBRARY_METADATA_FILTER_ALL = '__all__'
const LIBRARY_SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'date', label: 'Date' },
  { value: 'size', label: 'Size' }
] as const
const VIRTUAL_TRAY_MAIN_ID = 255
const VIRTUAL_TRAY_DEPUTY_ID = 254
const AVAILABLE_PRINT_STAGES = new Set<PrinterStatus['stage']>(['idle', 'finished', 'failed', 'unknown'])
const PUBLIC_DEMO_LIBRARY_UPLOAD_NOTICE = 'This is a public demo. Curated library files stay read-only. Uploads are private temporary files, limited to 15 MB, and removed within 12 hours.'
const EMPTY_SLICER_TARGETS: SlicingCapabilities['targets'] = []
const EMPTY_SLICING_PROFILES: SlicingProfileSummary[] = []

const printOptionFieldSx = {
  display: 'grid',
  gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) minmax(7.5rem, 8.25rem)' },
  alignItems: 'center',
  gap: 0.75,
  minWidth: 0,
  width: '100%'
} as const

const printOptionSelectSx = {
  minWidth: 0,
  width: { xs: '100%', sm: '8.25rem' },
  maxWidth: '100%',
  justifySelf: { xs: 'stretch', sm: 'end' }
} as const

const printOptionHelpText = {
  bedLevel: 'This checks the flatness of the heatbed. Leveling makes the extruded height uniform.',
  vibrationCompensation: 'This calibrates printer vibrations before the print starts to reduce ringing and improve surface quality.',
  flowCalibration: 'This process determines the dynamic flow values to improve overall print quality. Automatic mode skips calibration if the filament was calibrated recently.',
  nozzleOffsetCalibration: 'Calibrate nozzle offsets to enhance print quality. Automatic mode checks for calibration before printing and skips it when unnecessary.'
} as const

type LibraryContextMenuState =
  | { kind: 'file'; file: LibraryFile; x: number; y: number }
  | { kind: 'folder'; folder: LibraryFolder; x: number; y: number }

type LibraryPrintTarget = {
  file: LibraryFile
  versionId: string | null
}

type SliceFileSubmitAction = 'save' | 'print' | 'slice'

type SliceFileSubmitInput = {
  slicerTargetId: string
  target: {
    mode: 'realPrinter' | 'manualProfile'
    printerId?: string
    printerProfileId: string
    printerModel?: string
    plateType?: string | null
    nozzleDiameters?: number[]
    toolheads?: Array<{ id: string; label: string; nozzleDiameter?: number | null; nozzleFlow?: PrinterNozzleFlow | null; position?: 'left' | 'right' | 'single' | null }>
    processProfileId?: string | null
    processSettingOverrides?: Record<string, string | string[]>
    filamentMappings?: Array<{ projectFilamentId: number; profileId?: string | null; material?: string | null; color?: string | null; source?: 'ams' | 'externalSpool' | 'manual'; trayId?: number | null }>
  }
  outputFileName: string
  outputFolderId?: string | null
  plate: number
  /** Object ids (Bambu `object_id`) to keep; omitted ⇒ all. Only used for single-plate slices. */
  selectedObjectIds?: number[]
  /** Per-object process overrides keyed by `object_id`; only used for single-plate slices. */
  objectProcessOverrides?: Record<string, Record<string, string | string[]>>
  /** Edited multi-plate arrangement from the interactive 3D editor; authoritative when present. */
  sceneEdit?: SceneEdit
}

type SliceThenPrintTarget = {
  sourceFile: LibraryFile
  jobId: string
}

function buildLibraryResourceBasePath(fileId: string, versionId: string | null = null): string {
  return versionId ? `/api/library/versions/${versionId}` : `/api/library/${fileId}`
}

function toHistoryPrintFile(version: LibraryFileVersion): LibraryFile {
  return {
    id: version.libraryFileId,
    name: version.name,
    sizeBytes: version.sizeBytes,
    uploadedAt: version.uploadedAt,
    kind: version.kind,
    thumbnailPath: version.thumbnailPath,
    folderId: version.folderId,
    compatiblePrinterModels: version.compatiblePrinterModels,
    plateTypeChips: version.plateTypeChips,
    nozzleSizeChips: version.nozzleSizeChips,
    projectFilamentChips: version.projectFilamentChips
  }
}

function buildSlicedOutputFileName(fileName: string, options?: { plateName?: string | null; plateNumber?: number | null }): string {
  const baseName = humanizeProjectName(fileName.replace(/\.3mf$/i, ''))
  const plateLabel = buildSlicedPlateLabel(options?.plateName, options?.plateNumber)
  const suffix = plateLabel ? ` - ${plateLabel}` : ''
  return `${baseName}${suffix}.gcode.3mf`
}

/** Convert underscore separators in a project file name into spaces ("Best_Shot_Golf" -> "Best Shot Golf"). */
function humanizeProjectName(value: string): string {
  const humanized = value.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  return humanized || value.trim()
}

/** Build a human-readable plate label ("Plate 4") for a sliced output file, preserving spaces. */
function buildSlicedPlateLabel(plateName: string | null | undefined, plateNumber: number | null | undefined): string | null {
  const normalized = plateName?.trim().replace(/\s+/g, ' ')
  if (normalized) return normalizeFallbackPlateLabel(normalized)
  if (plateNumber != null && plateNumber > 0) return `Plate ${plateNumber}`
  return null
}

function printerHasChamber(model: Printer['model']): boolean {
  const controls = getPrinterControlCapabilities(model)
  return controls.chamberFan || controls.chamberTemperature || supportsPrinterDoorSensor(model)
}

interface PlateTypeMismatchIssue {
  requiredPlateType: string
  selectedPlateType: string | null
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

function collectDistinctLibraryFilterValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right))
}

function stopEventPropagation(event: { stopPropagation(): void }): void {
  event.stopPropagation()
}

function PrintOptionLabel({
  label,
  tooltip
}: {
  label: string
  tooltip?: string
}) {
  return (
    <FormLabel sx={{ minWidth: 0 }}>
      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
        <Box component="span" sx={{ minWidth: 0 }}>{label}</Box>
        {tooltip ? (
          <Tooltip title={tooltip} variant="soft" size="sm">
            <Box
              component="span"
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                color: 'text.tertiary',
                cursor: 'help',
                flexShrink: 0,
                '& svg': { fontSize: 18 }
              }}
            >
              <InfoOutlinedIcon />
            </Box>
          </Tooltip>
        ) : null}
      </Box>
    </FormLabel>
  )
}

/**
 * Library file list with upload, delete, “Send to printer” and a
 * folder tree. Per-row actions are extensible via the
 * `library.fileActions` plugin slot. Folders are pure metadata
 * grouping — the on-disk layout under `LIBRARY_DIR` stays flat.
 */
export function LibraryView() {
  const { confirm } = usePromptDialog()
  const navigate = useNavigate()
  const { demoMode } = useRuntimePolicy()
  const { tenantSlug, folderId: currentFolderIdParam } = useParams<{ tenantSlug: string; folderId?: string }>()
  const [searchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const authBootstrapQuery = useAuthBootstrapQuery()
  const workspaceScopeKey = readCurrentWorkspaceScopeKey()
  const printerStatusQuery = useQuery<Record<string, PrinterStatus>>({
    queryKey: workspaceQueryKeys.printerStatus(workspaceScopeKey),
    queryFn: () => Promise.resolve({}),
    initialData: {},
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })
  const inputRef = useRef<HTMLInputElement | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const externalDragDepthRef = useRef(0)
  const [externalDropActive, setExternalDropActive] = useState(false)
  const contextMenuAnchorRef = useRef<HTMLDivElement | null>(null)
  const [printTarget, setPrintTarget] = useState<LibraryPrintTarget | null>(null)
  const [previewFileId, setPreviewFileId] = useState<string | null>(null)
  // When set, the 3D preview overlay shows this archived version (read-only,
  // via the versioned resource routes) instead of the file's current content.
  const [previewVersion, setPreviewVersion] = useState<LibraryFileVersion | null>(null)
  const [sliceTarget, setSliceTarget] = useState<LibraryFile | null>(null)
  // True when the open editor is a brand-new project (backed by a hidden scaffold), so the
  // editor saves via "Save as new" (prompting for name + destination) rather than overwriting
  // the throwaway scaffold. Set from the scaffold flow's `onDiscard` presence.
  const [sliceTargetIsNewProject, setSliceTargetIsNewProject] = useState(false)
  // How the slice/editor dialog was opened: 'library' (the Edit action — slice/save
  // focused) or 'print' (the Print action — slice-then-print focused, matching the
  // PrintersView print dialog's 3MF flow).
  const [sliceFlow, setSliceFlow] = useState<'library' | 'print'>('library')
  // When set, the slice dialog targets this archived version of sliceTarget.
  const [sliceVersionId, setSliceVersionId] = useState<string | null>(null)
  const [sliceThenPrintTarget, setSliceThenPrintTarget] = useState<SliceThenPrintTarget | null>(null)
  const [sliceResultTarget, setSliceResultTarget] = useState<SliceThenPrintTarget | null>(null)
  const [historyTarget, setHistoryTarget] = useState<LibraryFile | null>(null)
  const [renameTarget, setRenameTarget] = useState<LibraryFile | null>(null)
  const [moveTarget, setMoveTarget] = useState<LibraryFile | null>(null)
  const [moveSelectionTarget, setMoveSelectionTarget] = useState<LibraryFile[] | null>(null)
  const [renameFolderTarget, setRenameFolderTarget] = useState<LibraryFolder | null>(null)
  const [moveFolderTarget, setMoveFolderTarget] = useState<LibraryFolder | null>(null)
  const [contextMenu, setContextMenu] = useState<LibraryContextMenuState | null>(null)
  const [contextMenuAnchorEl, setContextMenuAnchorEl] = useState<HTMLDivElement | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [recycleBinOpen, setRecycleBinOpen] = useState(false)
  const [dragMoveError, setDragMoveError] = useState<string | null>(null)
  const [draggedLibraryItem, setDraggedLibraryItem] = useState<LibraryDragItem | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([])
  const isMobileViewport = useMobileViewport()
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [fileTypeFilter, setFileTypeFilter] = useState<string>(LIBRARY_METADATA_FILTER_ALL)
  const [printerModelFilter, setPrinterModelFilter] = useState<string>(LIBRARY_METADATA_FILTER_ALL)
  const [nozzleSizeFilter, setNozzleSizeFilter] = useState<string>(LIBRARY_METADATA_FILTER_ALL)
  const [plateTypeFilter, setPlateTypeFilter] = useState<string>(LIBRARY_METADATA_FILTER_ALL)
  const [filtersDialogOpen, setFiltersDialogOpen] = useState(false)
  const [pageSize, setPageSize] = useState<(typeof LIBRARY_PAGE_SIZE_OPTIONS)[number]>(25)
  const [page, setPage] = useState(1)
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
  const currentFolderId = currentFolderIdParam ?? null
  const requestedBridgeId = searchParams.get('bridge')?.trim() || null

  const grantedPermissions = useMemo(
    () => new Set(authBootstrapQuery.data?.permissions ?? []),
    [authBootstrapQuery.data?.permissions]
  )
  const authEnabled = authBootstrapQuery.data?.authEnabled ?? false
  const canOpenBridgesSettings = authBootstrapQuery.data?.capabilities.canManageSettings ?? false
  const showNoConnectedBridgesPlaceholder = authBootstrapQuery.isSuccess
    && authBootstrapQuery.data?.tenant != null
    && !authBootstrapQuery.data.tenantHasConnectedBridges
  const hasPermission = (permission: Permission) => !authEnabled || grantedPermissions.has(permission)
  const canViewLibrary = hasPermission(LIBRARY_VIEW_PERMISSION)
  const canUploadLibrary = hasPermission(LIBRARY_UPLOAD_PERMISSION)
  const canManageLibrary = hasPermission(LIBRARY_MANAGE_PERMISSION)
  const canDownloadLibrary = hasPermission(LIBRARY_DOWNLOAD_PERMISSION)
  const canDispatchPrints = hasPermission(PRINTS_DISPATCH_PERMISSION)
  const canViewPrinters = hasPermission(PRINTERS_VIEW_PERMISSION)

  const browseQuery = useQuery({
    queryKey: ['library-browse', currentFolderId ?? 'root', requestedBridgeId ?? 'none'],
    queryFn: () => {
      const params = new URLSearchParams()
      if (currentFolderId) params.set('folderId', currentFolderId)
      if (requestedBridgeId) params.set('bridgeId', requestedBridgeId)
      const search = params.toString()
      return apiFetch<LibraryBrowseResponse>(`/api/library/browse${search ? `?${search}` : ''}`)
    },
    enabled: authBootstrapQuery.isSuccess ? (canViewLibrary && !showNoConnectedBridgesPlaceholder) : false
  })

  const resolvedBridgeId = browseQuery.data?.activeBridgeId ?? requestedBridgeId

  const foldersQuery = useQuery({
    queryKey: ['library-folders', resolvedBridgeId ?? 'none'],
    queryFn: () => {
      const params = new URLSearchParams()
      if (resolvedBridgeId) params.set('bridgeId', resolvedBridgeId)
      const search = params.toString()
      return apiFetch<{ folders: LibraryFolder[] }>(`/api/library/folders${search ? `?${search}` : ''}`)
    },
    enabled: authBootstrapQuery.isSuccess ? (canViewLibrary && !showNoConnectedBridgesPlaceholder) : false
  })

  const printersQuery = useQuery({
    queryKey: ['printers'],
    queryFn: () => apiFetch<{ printers: Printer[] }>('/api/printers'),
    enabled: authBootstrapQuery.isSuccess ? (canDispatchPrints && canViewPrinters && !showNoConnectedBridgesPlaceholder) : false
  })

  const slicingCapabilitiesQuery = useQuery({
    queryKey: ['slicing-capabilities'],
    queryFn: ({ signal }) => apiFetch<SlicingCapabilities>('/api/slicing/capabilities', { signal }),
    enabled: authBootstrapQuery.isSuccess ? (canUploadLibrary && canViewLibrary) : false
  })

  const allFolders = useMemo(() => foldersQuery.data?.folders ?? [], [foldersQuery.data])
  const browseData = browseQuery.data
  const bridgeRootMode = browseData?.mode === 'bridge-root'
  const bridgeEntries = useMemo(
    () => browseData?.bridgeEntries ?? [],
    [browseData?.bridgeEntries]
  )
  const activeBridgeId = resolvedBridgeId
  const activeBridge = activeBridgeId
    ? bridgeEntries.find((bridge) => bridge.id === activeBridgeId) ?? null
    : null
  const activeBridgeName = activeBridgeId
    ? activeBridge?.name ?? null
    : null
  const bridgeResourceUnavailable = Boolean(!bridgeRootMode && activeBridgeId && activeBridge && !activeBridge.connected)
  const bridgeResourceUnavailableReason = activeBridgeName
    ? `${activeBridgeName} is disconnected. Reconnect the bridge to open files, previews, and downloads.`
    : 'The selected bridge is disconnected. Reconnect the bridge to open files, previews, and downloads.'
  const showGlobalRootBreadcrumb = bridgeEntries.length !== 1
  const bridgeFolders = useMemo(
    () => bridgeEntries.map((bridge) => ({ id: toBridgeFolderId(bridge.id), name: bridge.name, parentId: null } satisfies LibraryFolder)),
    [bridgeEntries]
  )
  const childFolders = useMemo(
    () => bridgeRootMode ? bridgeFolders : (browseData?.folders ?? []),
    [bridgeFolders, bridgeRootMode, browseData?.folders]
  )
  const libraryBrowserLoading = browseQuery.isLoading || foldersQuery.isLoading
  const visibleFiles = useMemo(
    () => browseData?.files ?? [],
    [browseData?.files]
  )
  const fileTypeOptions = useMemo(
    () => collectDistinctLibraryFilterValues(visibleFiles.map((file) => formatLibraryFileKindLabel(file.name, file.kind))),
    [visibleFiles]
  )
  const printerModelOptions = useMemo(
    () => collectDistinctLibraryFilterValues(visibleFiles.flatMap((file) => file.compatiblePrinterModels)),
    [visibleFiles]
  )
  const nozzleSizeOptions = useMemo(
    () => collectDistinctLibraryFilterValues(visibleFiles.flatMap((file) => file.nozzleSizeChips)),
    [visibleFiles]
  )
  const plateTypeOptions = useMemo(
    () => collectDistinctLibraryFilterValues(visibleFiles.flatMap((file) => file.plateTypeChips)),
    [visibleFiles]
  )
  const activeMetadataFilterCount = Number(fileTypeFilter !== LIBRARY_METADATA_FILTER_ALL)
    + Number(printerModelFilter !== LIBRARY_METADATA_FILTER_ALL)
    + Number(nozzleSizeFilter !== LIBRARY_METADATA_FILTER_ALL)
    + Number(plateTypeFilter !== LIBRARY_METADATA_FILTER_ALL)
  const metadataFilteredFiles = useMemo(
    () => filterLibraryFilesByMetadata(visibleFiles, {
      fileType: fileTypeFilter,
      printerModel: printerModelFilter,
      nozzleSize: nozzleSizeFilter,
      plateType: plateTypeFilter
    }, LIBRARY_METADATA_FILTER_ALL),
    [fileTypeFilter, nozzleSizeFilter, plateTypeFilter, printerModelFilter, visibleFiles]
  )
  const filteredEntries = useMemo(
    () => filterLibraryEntries(childFolders, metadataFilteredFiles, deferredSearch),
    [childFolders, deferredSearch, metadataFilteredFiles]
  )
  const filteredFolders = filteredEntries.folders
  const filteredFiles = filteredEntries.files
  const filteredItemCount = filteredFolders.length + filteredFiles.length
  const pageCount = Math.max(1, Math.ceil(filteredItemCount / pageSize))
  const currentPage = Math.min(page, pageCount)
  // Sort BEFORE paginating: slicing pages out of the API's order and sorting
  // only the visible page made name-sorted items land on the wrong pages.
  const sortedEntries = useMemo(
    () => sortLibraryEntries(filteredFolders, filteredFiles, sort),
    [filteredFiles, filteredFolders, sort]
  )
  const pagedEntries = useMemo(
    () => paginateLibraryEntries(sortedEntries.folders, sortedEntries.files, currentPage, pageSize),
    [currentPage, sortedEntries, pageSize]
  )
  const pagedFolders = pagedEntries.folders
  const pagedFiles = pagedEntries.files
  const selectedVisibleFiles = useMemo(
    () => filteredFiles.filter((file) => selectedFileIds.includes(file.id)),
    [filteredFiles, selectedFileIds]
  )
  const showingLabel = filteredItemCount === 0
    ? 'Showing 0 of 0 items'
    : `Showing ${((currentPage - 1) * pageSize) + 1}-${Math.min(currentPage * pageSize, filteredItemCount)} of ${filteredItemCount} items`
  const breadcrumb = useMemo(
    () => buildLibraryBreadcrumb(allFolders, currentFolderId, activeBridgeId, activeBridgeName, {
      showRoot: showGlobalRootBreadcrumb
    }),
    [activeBridgeId, activeBridgeName, allFolders, currentFolderId, showGlobalRootBreadcrumb]
  )

  useEffect(() => {
    setSelectedFileIds((current) => {
      const next = current.filter((id) => visibleFiles.some((file) => file.id === id))
      return next.length === current.length ? current : next
    })
  }, [visibleFiles])

  useEffect(() => {
    setSelectionMode(false)
    setSelectedFileIds([])
  }, [currentFolderId])

  useEffect(() => {
    setPage(1)
  }, [currentFolderId, deferredSearch, fileTypeFilter, nozzleSizeFilter, pageSize, plateTypeFilter, printerModelFilter, requestedBridgeId])

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

  useEffect(() => {
    if (page !== currentPage) {
      setPage(currentPage)
    }
  }, [currentPage, page])

  function clearMetadataFilters() {
    setFileTypeFilter(LIBRARY_METADATA_FILTER_ALL)
    setPrinterModelFilter(LIBRARY_METADATA_FILTER_ALL)
    setNozzleSizeFilter(LIBRARY_METADATA_FILTER_ALL)
    setPlateTypeFilter(LIBRARY_METADATA_FILTER_ALL)
  }

  useEffect(() => {
    setContextMenu(null)
  }, [currentFolderId, selectionMode])

  useEffect(() => {
    if (canManageLibrary) return
    setSelectionMode(false)
    setSelectedFileIds([])
  }, [canManageLibrary])

  useEffect(() => {
    if (!currentFolderId || !foldersQuery.isSuccess) return
    if (allFolders.some((folder) => folder.id === currentFolderId)) return
    if (!tenantSlug) return
    navigate(buildLibraryFolderRoute(tenantSlug, null, activeBridgeId), { replace: true })
  }, [activeBridgeId, allFolders, currentFolderId, foldersQuery.isSuccess, navigate, tenantSlug])

  const invalidateAll = () => void invalidateLibraryQueries(queryClient)

  const navigateToFolder = (folderId: string | null) => {
    if (!tenantSlug) return
    if (folderId && isBridgeFolderId(folderId)) {
      navigate(buildLibraryFolderRoute(tenantSlug, null, fromBridgeFolderId(folderId)))
      return
    }
    if (folderId === null && showGlobalRootBreadcrumb) {
      navigate(buildLibraryFolderRoute(tenantSlug, null, null))
      return
    }
    navigate(buildLibraryFolderRoute(tenantSlug, folderId, activeBridgeId))
  }

  const isDefaultOpenableFile = (file: LibraryFile) => {
    if (bridgeResourceUnavailable) return false
    if (canDispatchPrints && isDirectPrintableFileName(file.name)) return true
    if (canUploadLibrary && isUnslicedThreeMfFile(file)) return true
    // STL/STEP have no print or edit action; clicking one opens the read-only 3D preview —
    // but only when the previewer (model-studio) is installed, so the card isn't a dead click.
    return isPreviewOnlyLibraryFile(file) && getMeshThumbnailProvider() !== null
  }

  const openFileDefaultAction = (file: LibraryFile) => {
    if (bridgeResourceUnavailable) return
    if (canDispatchPrints && isDirectPrintableFileName(file.name)) {
      setPrintTarget({ file, versionId: null })
      return
    }
    if (canUploadLibrary && isUnslicedThreeMfFile(file)) {
      setSliceVersionId(null)
      setSliceFlow('library')
      setSliceTarget(file)
      return
    }
    // STL/STEP: no print or edit action, so the default click opens the 3D preview
    // (the model-studio plugin renders it via the `library.overlays` slot).
    if (isPreviewOnlyLibraryFile(file)) {
      setPreviewVersion(null)
      setPreviewFileId(file.id)
    }
  }

  // A callback to run when the slice dialog closes — used to discard a new-project
  // scaffold the user abandoned (a saved copy is a separate visible file).
  const sliceTargetCleanupRef = useRef<(() => void) | null>(null)

  const closeSliceDialog = () => {
    setSliceTarget(null)
    setSliceFlow('library')
    setSliceVersionId(null)
    setSliceTargetIsNewProject(false)
    const cleanup = sliceTargetCleanupRef.current
    sliceTargetCleanupRef.current = null
    cleanup?.()
  }

  // Open the full slice/editor flow on a file. Used both to slice an existing file and
  // to back a brand-new project with a hidden scaffold (so a new project gets the SAME
  // full editor). `onDiscard` (scaffold cleanup) runs when the dialog closes.
  const openSliceForSavedFile = useCallback(async (file: { id: string; name: string }, opts?: { onDiscard?: () => void }) => {
    try {
      const { file: full } = await apiFetch<{ file: LibraryFile }>(`/api/library/${file.id}`)
      sliceTargetCleanupRef.current = opts?.onDiscard ?? null
      // A new-project scaffold is the only caller that passes an onDiscard cleanup.
      setSliceTargetIsNewProject(Boolean(opts?.onDiscard))
      setSliceVersionId(null)
      setSliceFlow('library')
      setSliceTarget(full)
    } catch (error) {
      opts?.onDiscard?.()
      toast.error(error instanceof Error ? error.message : 'Could not open the editor. Try again.')
    }
  }, [])

  // Uploads run through the module-level queue (lib/libraryUploadQueue), which
  // reports progress in a global toast and keeps draining after this view
  // unmounts. The destination is pinned at enqueue time, so navigating
  // mid-upload cannot redirect the remaining files. The library queries
  // refresh via the server's `resource.changed` WS broadcast.
  const uploadItems = useCallback((items: LibraryUploadTreeItem[], destination: LibraryUploadDestination) => {
    enqueueLibraryUploads(items, destination, {
      validateItem: demoMode
        ? (item) => (item.file.size > 15 * 1024 * 1024 ? 'Demo uploads are limited to 15 MB.' : null)
        : undefined
    })
  }, [demoMode])

  const startSlicingJob = useMutation({
    mutationFn: async (input: {
      file: LibraryFile
      versionId?: string | null
      action: SliceFileSubmitAction
      keepDialogOpen?: boolean
    } & SliceFileSubmitInput) => {
      const body = {
        sourceFileId: input.file.id,
        sourceVersionId: input.versionId ?? undefined,
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
              processSettingOverrides: input.target.processSettingOverrides,
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
              processSettingOverrides: input.target.processSettingOverrides,
              filamentMappings: input.target.filamentMappings
            },
        outputFileName: input.outputFileName,
        // 'print' discards the output (hidden, no folder); 'slice' keeps it hidden but
        // in the chosen folder so "Save to library" only has to un-hide it.
        outputFolderId: input.action === 'print' ? null : (input.outputFolderId ?? null),
        hiddenOutput: input.action === 'print' || input.action === 'slice',
        plate: input.plate,
        selectedObjectIds: input.selectedObjectIds,
        objectProcessOverrides: input.objectProcessOverrides,
        sceneEdit: input.sceneEdit
      }
      return await apiFetch<SlicingJobResponse>('/api/slicing/jobs', { method: 'POST', body })
    },
    onSuccess: async (response, variables) => {
      // Editor-initiated prints keep the slice dialog (and the editor on top of it)
      // open so the print flow layers over the editor; otherwise close as usual.
      if (!variables.keepDialogOpen) closeSliceDialog()
      await queryClient.invalidateQueries({ queryKey: ['slicing-jobs'] })
      if (variables.action === 'print') {
        setSliceThenPrintTarget({ sourceFile: variables.file, jobId: response.job.id })
      }
      if (variables.action === 'slice') {
        setSliceResultTarget({ sourceFile: variables.file, jobId: response.job.id })
      }
    }
  })

  // Deleting from the library is a soft delete: files move to the recycle bin
  // (restorable until emptied or expired) with an Undo affordance. Permanent
  // deletion happens from the recycle bin dialog.
  const recycleFiles = useMutation({
    mutationFn: async (files: LibraryFile[]) => {
      await apiFetch('/api/library/recycle-bin/files', {
        method: 'POST',
        body: { fileIds: files.map((file) => file.id) }
      })
      return files
    },
    onSuccess: (files) => {
      setSelectedFileIds([])
      invalidateAll()
      toast.success({
        message: files.length === 1
          ? `Moved "${formatLibraryFileName(files[0]?.name ?? '')}" to the recycle bin`
          : `Moved ${files.length} files to the recycle bin`,
        action: {
          label: 'Undo',
          onClick: async () => {
            await apiFetch('/api/library/recycle-bin/restore', {
              method: 'POST',
              body: { fileIds: files.map((file) => file.id) }
            }).catch((error: unknown) => {
              toast.error(error instanceof Error ? error.message : 'Failed to restore files')
            })
            invalidateAll()
          }
        }
      })
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to move files to the recycle bin')
    }
  })

  const moveFile = useMutation({
    mutationFn: ({ id, folderId }: { id: string; folderId: string | null }) =>
      apiFetch(`/api/library/${id}`, { method: 'PATCH', body: { folderId, bridgeId: activeBridgeId } }),
    onSuccess: invalidateAll
  })

  const moveFolder = useMutation({
    mutationFn: ({ id, parentId }: { id: string; parentId: string | null }) =>
      apiFetch(`/api/library/folders/${id}`, { method: 'PATCH', body: { parentId, bridgeId: activeBridgeId } }),
    onSuccess: invalidateAll
  })

  const removeFolder = useMutation({
    // Recursive: the folder's whole subtree (subfolders + files) is deleted.
    // The caller confirms with the user before mutating.
    mutationFn: (id: string) => apiFetch(`/api/library/folders/${id}?recursive=true`, { method: 'DELETE' }),
    onSuccess: invalidateAll
  })

  const handleDropIntoFolder = async (item: LibraryDragItem, targetFolder: LibraryFolder) => {
    setDragMoveError(null)
    try {
      if (item.type === 'file') {
        if (item.file.folderId === targetFolder.id) return
        await moveFile.mutateAsync({ id: item.file.id, folderId: targetFolder.id })
        return
      }
      if (item.type === 'files') {
        const filesToMove = item.files.filter((file) => file.folderId !== targetFolder.id)
        if (filesToMove.length === 0) return
        await Promise.all(
          filesToMove.map((file) => moveFile.mutateAsync({ id: file.id, folderId: targetFolder.id }))
        )
        return
      }
      if (item.folder.id === targetFolder.id || item.folder.parentId === targetFolder.id) return
      await moveFolder.mutateAsync({ id: item.folder.id, parentId: targetFolder.id })
    } catch (error) {
      setDragMoveError((error as Error).message)
    }
  }

  const readDraggedItem = (event: DragEvent<HTMLElement>): LibraryDragItem | null => {
    if (draggedLibraryItem) return draggedLibraryItem
    return parseLibraryDragItem(event.dataTransfer.getData(LIBRARY_DRAG_MIME), {
      files: visibleFiles,
      folders: allFolders
    })
  }

  const handleDropToRoot = async (event: DragEvent<HTMLElement>) => {
    const item = readDraggedItem(event)
    if (!item) return
    event.preventDefault()
    setDragMoveError(null)
    try {
      if (item.type === 'file') {
        if (item.file.folderId === null) return
        await moveFile.mutateAsync({ id: item.file.id, folderId: null })
        return
      }
      if (item.type === 'files') {
        const filesToMove = item.files.filter((file) => file.folderId !== null)
        if (filesToMove.length === 0) return
        await Promise.all(
          filesToMove.map((file) => moveFile.mutateAsync({ id: file.id, folderId: null }))
        )
        return
      }
      if (item.folder.parentId === null) return
      await moveFolder.mutateAsync({ id: item.folder.id, parentId: null })
    } catch (error) {
      setDragMoveError((error as Error).message)
    }
  }

  const handleDropToBreadcrumb = async (event: DragEvent<HTMLElement>, targetFolderId: string | null) => {
    if (targetFolderId === null) {
      await handleDropToRoot(event)
      return
    }

    const item = readDraggedItem(event)
    const targetFolder = allFolders.find((folder) => folder.id === targetFolderId)
    if (!item || !targetFolder) return
    event.preventDefault()
    await handleDropIntoFolder(item, targetFolder)
  }

  const toggleSelectedFile = (file: LibraryFile) => {
    setSelectedFileIds((current) => current.includes(file.id)
      ? current.filter((id) => id !== file.id)
      : [...current, file.id])
  }

  const setAllVisibleFilesSelected = (selected: boolean) => {
    setSelectedFileIds(selected ? filteredFiles.map((file) => file.id) : [])
  }

  const moveFilesToRecycleBin = async (files: LibraryFile[]) => {
    if (files.length === 0) return
    await recycleFiles.mutateAsync(files)
  }

  const closeContextMenu = () => {
    setContextMenu(null)
    setContextMenuAnchorEl(null)
    contextMenuAnchorRef.current = null
  }
  useControlledMenuClickAway(Boolean(contextMenu), 'library-context-menu', closeContextMenu, [contextMenuAnchorRef])

  const setContextMenuAnchorNode = (node: HTMLDivElement | null) => {
    contextMenuAnchorRef.current = node
    setContextMenuAnchorEl(node)
  }

  // Split Upload button (files picker primary, folder picker in the menu).
  // Shared by the page toolbar and the empty-folder state so both offer the
  // same upload paths.
  const uploadSplitButton = (
    <Dropdown>
      <ButtonGroup size="sm" variant="solid" color="primary" disabled={bridgeResourceUnavailable} aria-label="upload">
        <Button startDecorator={<FileUploadRoundedIcon />} onClick={() => inputRef.current?.click()}>Upload</Button>
        <MenuButton slots={{ root: IconButton }} aria-label="More upload options">
          <ArrowDropDownIcon />
        </MenuButton>
      </ButtonGroup>
      <Menu placement="bottom-end" sx={{ minWidth: 200 }}>
        <MenuItem onClick={() => inputRef.current?.click()}><FileUploadRoundedIcon /> Upload files…</MenuItem>
        <MenuItem onClick={() => folderInputRef.current?.click()}><DriveFolderUploadRoundedIcon /> Upload folder…</MenuItem>
      </Menu>
    </Dropdown>
  )

  const libraryEmptyState = deferredSearch.trim()
    ? (
        <EmptyState
          icon={<SearchRoundedIcon />}
          title="No matches found"
          description="Try a different search to find a file or folder in this library view."
        />
      )
    : bridgeRootMode
      ? (
          <EmptyState
            icon={<FolderOpenRoundedIcon />}
            title="No bridges connected"
            description="Connect a bridge to organize files by bridge."
          />
        )
      : (
          <EmptyState
            icon={<FolderOpenRoundedIcon />}
            title={currentFolderId ? 'This folder is empty' : 'Your library is empty'}
            description={
              currentFolderId
                ? 'Upload files or create a folder here to organize prints for later.'
                : 'Upload your first 3MF/G-code file to start building a library.'
            }
            action={
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', justifyContent: 'center' }}>
                {canManageLibrary && (
                  <Button
                    size="sm"
                    variant="soft"
                    startDecorator={<CreateNewFolderRoundedIcon />}
                    onClick={() => setCreatingFolder(true)}
                  >
                    New folder
                  </Button>
                )}
                {canUploadLibrary && !demoMode && uploadSplitButton}
              </Stack>
            }
          />
        )

  const libraryBrowser = (
    <LibraryBrowser
      folders={pagedFolders}
      files={pagedFiles}
      viewMode={viewMode}
      sort={sort}
      emptyState={libraryEmptyState}
      onFolderOpen={(folder) => navigateToFolder(folder.id)}
      onFilePick={openFileDefaultAction}
      isFilePickable={isDefaultOpenableFile}
      getFileDisabledReason={bridgeResourceUnavailable
        ? () => bridgeResourceUnavailableReason
        : undefined}
      disableFileThumbnails={bridgeResourceUnavailable}
      selectableFiles={canManageLibrary && !bridgeRootMode && selectionMode}
      selectedFileIds={selectedFileIds}
      onFileSelectionToggle={canManageLibrary && !bridgeRootMode ? toggleSelectedFile : undefined}
      onItemDrop={canManageLibrary && !bridgeRootMode ? handleDropIntoFolder : undefined}
      onDragItemChange={canManageLibrary && !bridgeRootMode ? setDraggedLibraryItem : undefined}
      hideMetadataChipsOnMobile
      hideFilamentSwatches
      onFolderContextMenu={canManageLibrary && !bridgeRootMode ? (event, folder) => {
        event.preventDefault()
        setContextMenu({ kind: 'folder', folder, x: event.clientX, y: event.clientY })
      } : undefined}
      onFileContextMenu={(canDownloadLibrary || (canManageLibrary && !bridgeRootMode)) ? (event, file) => {
        event.preventDefault()
        setContextMenu({ kind: 'file', file, x: event.clientX, y: event.clientY })
      } : undefined}
      renderFolderActions={canManageLibrary && !bridgeRootMode ? (folder) => (
        <Dropdown>
          <MenuButton
            slots={{ root: IconButton }}
            slotProps={{ root: { size: 'sm', variant: 'plain', color: 'neutral', 'aria-label': 'Folder actions' } }}
          >
            <MoreVertIcon />
          </MenuButton>
          <Menu placement="bottom-end">
            {renderFolderActionItems(folder)}
          </Menu>
        </Dropdown>
      ) : undefined}
      renderFileActions={(canViewLibrary || canDownloadLibrary || (canManageLibrary && !bridgeRootMode) || canUploadLibrary) ? (file) => (
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexShrink: 0 }}>
          <Dropdown>
            <MenuButton
              slots={{ root: IconButton }}
              slotProps={{ root: { size: 'sm', variant: 'plain', color: 'neutral', 'aria-label': 'File actions' } }}
            >
              <MoreVertIcon />
            </MenuButton>
            <Menu placement="bottom-end">
              {renderFileActionItems(file)}
            </Menu>
          </Dropdown>
        </Stack>
      ) : undefined}
    />
  )

  function renderFolderActionItems(folder: LibraryFolder, onAction?: () => void) {
    return (
      <>
        <MenuItem onClick={() => {
          onAction?.()
          setRenameFolderTarget(folder)
        }}><EditRoundedIcon /> Rename</MenuItem>
        <MenuItem onClick={() => {
          onAction?.()
          setMoveFolderTarget(folder)
        }}><DriveFileMoveRoundedIcon /> Move</MenuItem>
        <MenuItem
          color="danger"
          onClick={async () => {
            onAction?.()
            const confirmed = await confirm({
              title: 'Delete folder?',
              description: `Delete folder "${folder.name}" and everything inside it? Any files and subfolders it contains will be permanently deleted.`,
              confirmLabel: 'Delete folder',
              color: 'danger'
            })
            if (!confirmed) return
            removeFolder.mutate(folder.id)
          }}
        ><DeleteRoundedIcon /> Delete</MenuItem>
      </>
    )
  }

  function renderFileActionItems(file: LibraryFile, onAction?: () => void) {
    return (
      <>
        {canDispatchPrints && isDirectPrintableFileName(file.name) && (
          <MenuItem
            onClick={() => {
              if (bridgeResourceUnavailable) return
              onAction?.()
              setPrintTarget({ file, versionId: null })
            }}
            disabled={bridgeResourceUnavailable}
          >
            <PrintRoundedIcon /> Print
          </MenuItem>
        )}
        {canUploadLibrary && isUnslicedThreeMfFile(file) && (
          <MenuItem onClick={() => {
            if (bridgeResourceUnavailable) return
            onAction?.()
            setSliceVersionId(null)
            setSliceFlow('library')
            setSliceTarget(file)
          }} disabled={bridgeResourceUnavailable}><DesignServicesRoundedIcon /> Edit</MenuItem>
        )}
        {canDispatchPrints && canViewPrinters && canUploadLibrary && isUnslicedThreeMfFile(file) && (
          <MenuItem onClick={() => {
            if (bridgeResourceUnavailable) return
            onAction?.()
            setSliceVersionId(null)
            // Same slice-then-print flow as picking a 3MF in the printers' Print dialog.
            setSliceFlow('print')
            setSliceTarget(file)
          }} disabled={bridgeResourceUnavailable}><PrintRoundedIcon /> Print</MenuItem>
        )}
        {!bridgeResourceUnavailable && (
          <PluginSlot
            name="library.fileActions"
            context={{
              fileId: file.id,
              kind: file.kind,
              name: file.name,
              onAction,
              onPreview: () => { setPreviewVersion(null); setPreviewFileId(file.id) }
            }}
          />
        )}
        {canDownloadLibrary && (
          bridgeResourceUnavailable ? (
            <MenuItem disabled>
              <DownloadRoundedIcon /> Download unavailable while bridge is offline
            </MenuItem>
          ) : (
            <MenuItem
              component="a"
              href={buildApiUrl(`/api/library/${file.id}/download`)}
              download={file.name}
              onClick={() => onAction?.()}
            >
              <DownloadRoundedIcon /> Download
            </MenuItem>
          )
        )}
        {canViewLibrary && <MenuItem onClick={() => {
          onAction?.()
          setHistoryTarget(file)
        }}><HistoryRoundedIcon /> History</MenuItem>}
        {canManageLibrary && <MenuItem onClick={() => {
          onAction?.()
          setRenameTarget(file)
        }}><EditRoundedIcon /> Rename</MenuItem>}
        {canManageLibrary && <MenuItem onClick={() => {
          onAction?.()
          setMoveTarget(file)
        }}><DriveFileMoveRoundedIcon /> Move</MenuItem>}
        {canManageLibrary && (
          <MenuItem
            color="danger"
            onClick={async () => {
              onAction?.()
              const confirmed = await confirm({
                title: 'Move to recycle bin?',
                description: `Move "${formatLibraryFileName(file.name)}" to the recycle bin? It can be restored from there.`,
                confirmLabel: 'Move to recycle bin',
                color: 'danger'
              })
              if (!confirmed) return
              void moveFilesToRecycleBin([file])
            }}
          ><DeleteRoundedIcon /> Move to recycle bin</MenuItem>
        )}
      </>
    )
  }

  const moveSelectedFilesToRecycleBin = async () => {
    if (selectedVisibleFiles.length === 0) return
    const confirmed = await confirm({
      title: 'Move to recycle bin?',
      description: selectedVisibleFiles.length === 1
        ? `Move "${formatLibraryFileName(selectedVisibleFiles[0]?.name ?? '')}" to the recycle bin? It can be restored from there.`
        : `Move ${selectedVisibleFiles.length} selected files to the recycle bin? They can be restored from there.`,
      confirmLabel: 'Move to recycle bin',
      color: 'danger'
    })
    if (!confirmed) return
    await moveFilesToRecycleBin(selectedVisibleFiles)
    setSelectionMode(false)
  }

  const showSelectionControls = canManageLibrary && !bridgeRootMode && selectionMode
  const showPrimaryLibraryActions =
    (canManageLibrary && !bridgeRootMode) ||
    (canUploadLibrary && !bridgeRootMode)

  // External drag-and-drop upload: accepts a mix of files and folders from the
  // OS and replicates dropped folder trees in the library. Internal row drags
  // (LIBRARY_DRAG_MIME) are LibraryBrowser's move gesture, not an upload.
  const canDropUpload = canUploadLibrary && !bridgeRootMode && !showNoConnectedBridgesPlaceholder && !bridgeResourceUnavailable
  const isExternalFileDrag = (event: DragEvent<HTMLElement>) =>
    event.dataTransfer.types.includes('Files') && !event.dataTransfer.types.includes(LIBRARY_DRAG_MIME)

  return (
    <Stack
      spacing={2}
      sx={{ position: 'relative' }}
      onDragEnter={(event) => {
        if (!canDropUpload || !isExternalFileDrag(event)) return
        event.preventDefault()
        externalDragDepthRef.current += 1
        setExternalDropActive(true)
      }}
      onDragOver={(event) => {
        if (!canDropUpload || !isExternalFileDrag(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (!canDropUpload || !isExternalFileDrag(event)) return
        externalDragDepthRef.current = Math.max(0, externalDragDepthRef.current - 1)
        if (externalDragDepthRef.current === 0) setExternalDropActive(false)
      }}
      onDrop={(event) => {
        externalDragDepthRef.current = 0
        setExternalDropActive(false)
        if (!canDropUpload || !isExternalFileDrag(event)) return
        event.preventDefault()
        const transfer = event.dataTransfer
        const destination: LibraryUploadDestination = { folderId: currentFolderId, bridgeId: activeBridgeId }
        void collectUploadTreeFromDataTransfer(transfer).then((items) => uploadItems(items, destination))
      }}
    >
      {authBootstrapQuery.isLoading && <Typography>Loading…</Typography>}
      {authBootstrapQuery.isSuccess && !canViewLibrary && (
        <EmptyState
          icon={<FolderOpenRoundedIcon />}
          title="Library access required"
          description="Your account can open the app shell, but not the shared library."
        />
      )}
      {authBootstrapQuery.isSuccess && canViewLibrary && (
        <>
      {demoMode && (
        <Alert color="neutral" variant="outlined" startDecorator={<InfoOutlinedIcon />}>
          <Typography level="body-sm">
            {PUBLIC_DEMO_LIBRARY_UPLOAD_NOTICE}
          </Typography>
        </Alert>
      )}
      {bridgeResourceUnavailable && (
        <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
          <Typography level="body-sm">
            {bridgeResourceUnavailableReason}
          </Typography>
        </Alert>
      )}
      <Stack spacing={1}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Typography level="h3">Library</Typography>
          {!showNoConnectedBridgesPlaceholder && showPrimaryLibraryActions && (
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{
                flexWrap: 'wrap',
                justifyContent: { xs: 'flex-start', sm: 'flex-end' }
              }}
            >
              {!showSelectionControls && canManageLibrary && !bridgeRootMode && !isMobileViewport ? (
                <Button size="sm" variant="soft" onClick={() => setSelectionMode(true)}>
                  Select...
                </Button>
              ) : null}
              {canManageLibrary && !bridgeRootMode && <Button size="sm" variant="soft" startDecorator={<CreateNewFolderRoundedIcon />} onClick={() => setCreatingFolder(true)}>New folder</Button>}
              {canUploadLibrary && !bridgeRootMode && (
                <PluginSlot
                  name="library.create"
                  context={{ folderId: currentFolderId, bridgeId: activeBridgeId, onSaved: invalidateAll, onRequestSlice: openSliceForSavedFile }}
                />
              )}
              {canUploadLibrary && !bridgeRootMode && uploadSplitButton}
            </Stack>
          )}
        </Stack>

        {!showNoConnectedBridgesPlaceholder && showSelectionControls && (
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{
              flexWrap: 'wrap',
              justifyContent: { xs: 'flex-start', sm: 'flex-end' }
            }}
          >
            <Button
              size="sm"
              variant="soft"
              onClick={() => setAllVisibleFilesSelected(selectedVisibleFiles.length !== filteredFiles.length && filteredFiles.length > 0)}
              disabled={filteredFiles.length === 0 || recycleFiles.isPending}
            >
              {selectedVisibleFiles.length === filteredFiles.length && filteredFiles.length > 0 ? 'Clear all' : 'Select all'}
            </Button>
            <Button
              size="sm"
              variant="plain"
              onClick={() => {
                setSelectionMode(false)
                setSelectedFileIds([])
              }}
              disabled={recycleFiles.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              startDecorator={<DriveFileMoveRoundedIcon />}
              disabled={selectedVisibleFiles.length === 0 || recycleFiles.isPending}
              onClick={() => setMoveSelectionTarget(selectedVisibleFiles)}
            >
              Move selected{selectedVisibleFiles.length > 0 ? ` (${selectedVisibleFiles.length})` : ''}
            </Button>
            <Button
              size="sm"
              color="danger"
              startDecorator={<DeleteRoundedIcon />}
              disabled={selectedVisibleFiles.length === 0}
              loading={recycleFiles.isPending}
              onClick={() => void moveSelectedFilesToRecycleBin()}
            >
              Recycle selected{selectedVisibleFiles.length > 0 ? ` (${selectedVisibleFiles.length})` : ''}
            </Button>
          </Stack>
        )}

        {canUploadLibrary && !bridgeRootMode && !showNoConnectedBridgesPlaceholder && (
          <>
            <input
              ref={inputRef}
              type="file"
              accept=".3mf,.gcode,.stl,.step,.stp"
              multiple
              hidden
              disabled={bridgeResourceUnavailable}
              onChange={(event) => {
                if (bridgeResourceUnavailable) {
                  event.target.value = ''
                  return
                }
                const files = event.target.files
                if (files) uploadItems(collectUploadTreeFromFileList(files), { folderId: currentFolderId, bridgeId: activeBridgeId })
                event.target.value = ''
              }}
            />
            {/* Directory picker for "Upload folder…": the picked tree is replicated as
                library folders (metadata only — file bytes stay flat on the bridge). */}
            <input
              ref={folderInputRef}
              type="file"
              hidden
              disabled={bridgeResourceUnavailable}
              {...({ webkitdirectory: '' } as Record<string, string>)}
              onChange={(event) => {
                if (bridgeResourceUnavailable) {
                  event.target.value = ''
                  return
                }
                const files = event.target.files
                if (files) uploadItems(collectUploadTreeFromFileList(files), { folderId: currentFolderId, bridgeId: activeBridgeId })
                event.target.value = ''
              }}
            />
          </>
        )}
      </Stack>

      {showNoConnectedBridgesPlaceholder ? (
        <NoConnectedBridgesEmptyState
          title="Connect a bridge to use the library"
          description="Connect a bridge in Settings to browse printer-local files and send prints from your library."
          managedTitle="Your library is starting up"
          managedDescription="Your library will be available once PrintStream's services are running."
          canOpenBridgesSettings={canOpenBridgesSettings}
          onOpenBridgesSettings={() => tenantSlug && navigate(buildTenantWorkspacePath(tenantSlug, '/settings/bridges'))}
        />
      ) : (
        <>

      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <LibraryBreadcrumb
            crumbs={breadcrumb}
            onNavigate={navigateToFolder}
            onCrumbDrop={bridgeRootMode ? undefined : handleDropToBreadcrumb}
            draggedItem={draggedLibraryItem}
          />
        </Box>
        {canManageLibrary && !bridgeRootMode && (
          <Tooltip title="Recycle bin" variant="soft">
            <IconButton size="sm" variant="plain" color="neutral" aria-label="Recycle bin" onClick={() => setRecycleBinOpen(true)} sx={{ flexShrink: 0 }}>
              <RestoreFromTrashRoundedIcon />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      <DirectoryPrimaryToolbar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search files and folders"
        searchAriaLabel="Search library"
        filtersButton={(
          <DirectoryFiltersButton
            activeCount={activeMetadataFilterCount}
            onClick={() => setFiltersDialogOpen(true)}
            disabled={fileTypeOptions.length === 0 && printerModelOptions.length === 0 && nozzleSizeOptions.length === 0 && plateTypeOptions.length === 0}
          />
        )}
        pageSizeValue={pageSize}
        pageSizeOptions={LIBRARY_PAGE_SIZE_OPTIONS.map((value) => ({ value, label: `${value} per page` }))}
        onPageSizeChange={(value) => setPageSize(value as (typeof LIBRARY_PAGE_SIZE_OPTIONS)[number])}
        pageSizeAriaLabel="Items per page"
        pageSizeRenderValue={(value) => `${value} per page`}
        sortValue={sort.key}
        sortOptions={LIBRARY_SORT_OPTIONS}
        onSortValueChange={(key) => setSort({ ...sort, key })}
        sortDirection={sort.dir}
        onSortDirectionChange={(dir) => setSort({ ...sort, dir })}
        sortAriaLabel="Sort library by"
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        rightAlignViewModeOnMobile
      />

      {activeMetadataFilterCount > 0 && (
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

      {dragMoveError && <Typography color="danger" level="body-sm">{dragMoveError}</Typography>}

      {libraryBrowserLoading ? (
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="center" sx={{ py: 6 }}>
          <CircularProgress size="sm" />
          <Typography level="body-sm" textColor="text.tertiary">Loading library…</Typography>
        </Stack>
      ) : (
        filteredItemCount > 0 ? (
          <PaginatedSection
            showingLabel={showingLabel}
            previousDisabled={currentPage <= 1}
            nextDisabled={currentPage >= pageCount}
            onPrevious={() => setPage((current) => Math.max(1, current - 1))}
            onNext={() => setPage((current) => Math.min(pageCount, current + 1))}
          >
            {libraryBrowser}
          </PaginatedSection>
        ) : libraryBrowser
      )}
        </>
      )}

        {contextMenu && (
          <>
            <Box
              ref={setContextMenuAnchorNode}
              sx={{
                position: 'fixed',
                left: contextMenu.x,
                top: contextMenu.y,
                width: 0,
                height: 0,
                pointerEvents: 'none'
              }}
            />
            <Menu id="library-context-menu" open onClose={closeContextMenu} anchorEl={contextMenuAnchorEl} placement="bottom-start">
              {contextMenu.kind === 'folder'
                ? renderFolderActionItems(contextMenu.folder, closeContextMenu)
                : renderFileActionItems(contextMenu.file, closeContextMenu)}
            </Menu>
          </>
        )}

      {historyTarget && (
        <FileHistoryDialog
          file={historyTarget}
          canManageLibrary={canManageLibrary}
          canDispatchPrints={canDispatchPrints}
          canSliceFiles={canUploadLibrary}
          canViewPrinters={canViewPrinters}
          onClose={() => setHistoryTarget(null)}
          onPrintVersion={(version) => {
            // History stays open beneath (the print dialog mounts later, stacking on
            // top), so closing it returns the user to the version list.
            setPrintTarget({ file: toHistoryPrintFile(version), versionId: version.versionId })
          }}
          onSliceVersion={(version) => {
            // History stays open beneath the editor for the same reason.
            setSliceVersionId(version.versionId)
            setSliceFlow('library')
            setSliceTarget(toHistoryPrintFile(version))
          }}
          onPrintProjectVersion={(version) => {
            setHistoryTarget(null)
            setSliceVersionId(version.versionId)
            // Same slice-then-print flow as the kebab's Print on project 3MFs.
            setSliceFlow('print')
            setSliceTarget(toHistoryPrintFile(version))
          }}
          onPreviewVersion={(version) => {
            // History stays open beneath the preview overlay for the same reason.
            setPreviewVersion(version)
            setPreviewFileId(version.libraryFileId)
          }}
          onRestored={() => {
            invalidateAll()
          }}
        />
      )}

      {canDispatchPrints && printTarget && (
        <PrintModal
          file={printTarget.file}
          versionId={printTarget.versionId}
          printers={printersQuery.data?.printers ?? []}
          onClose={() => setPrintTarget(null)}
        />
      )}

      <PluginSlot
        name="library.overlays"
        context={{
          previewFileId,
          previewVersionId: previewVersion?.versionId ?? null,
          previewFile: previewVersion ? toHistoryPrintFile(previewVersion) : undefined,
          onPreviewClose: () => {
            setPreviewFileId(null)
            setPreviewVersion(null)
          }
        }}
      />

      {canDispatchPrints && canViewPrinters && sliceThenPrintTarget && (
        <SliceThenPrintModal
          sourceFile={sliceThenPrintTarget.sourceFile}
          jobId={sliceThenPrintTarget.jobId}
          printers={printersQuery.data?.printers ?? []}
          onClose={() => setSliceThenPrintTarget(null)}
        />
      )}

      {sliceResultTarget && (
        <SliceResultModal
          sourceFile={sliceResultTarget.sourceFile}
          jobId={sliceResultTarget.jobId}
          printers={printersQuery.data?.printers ?? []}
          canPrint={canDispatchPrints && canViewPrinters}
          folders={foldersQuery.data?.folders ?? []}
          bridgeId={resolvedBridgeId ?? null}
          bridgeName={activeBridgeName}
          showRoot={showGlobalRootBreadcrumb}
          onClose={() => setSliceResultTarget(null)}
        />
      )}

      <DirectoryFiltersDialog
        open={filtersDialogOpen}
        title="Library filters"
        onClose={() => setFiltersDialogOpen(false)}
        onClear={clearMetadataFilters}
        clearDisabled={activeMetadataFilterCount === 0}
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

      {canManageLibrary && creatingFolder && (
        <CreateFolderModal
          parentId={currentFolderId}
          bridgeId={activeBridgeId}
          onClose={() => setCreatingFolder(false)}
          onCreated={() => {
            setCreatingFolder(false)
            invalidateAll()
          }}
        />
      )}

      {canManageLibrary && renameTarget && (
        <RenameFileModal
          file={renameTarget}
          onClose={() => setRenameTarget(null)}
          onSaved={() => {
            setRenameTarget(null)
            invalidateAll()
          }}
        />
      )}

      {canManageLibrary && moveTarget && (
        <MoveFileModal
          file={moveTarget}
          folders={allFolders}
          bridgeId={activeBridgeId}
          bridgeName={activeBridgeName}
          showRoot={showGlobalRootBreadcrumb}
          onClose={() => setMoveTarget(null)}
          onSaved={() => {
            setMoveTarget(null)
            invalidateAll()
          }}
        />
      )}

      {canManageLibrary && moveSelectionTarget && (
        <MoveFilesModal
          files={moveSelectionTarget}
          folders={allFolders}
          bridgeId={activeBridgeId}
          bridgeName={activeBridgeName}
          showRoot={showGlobalRootBreadcrumb}
          onClose={() => setMoveSelectionTarget(null)}
          onSaved={() => {
            setMoveSelectionTarget(null)
            setSelectionMode(false)
            setSelectedFileIds([])
            invalidateAll()
          }}
        />
      )}

      {canManageLibrary && renameFolderTarget && (
        <RenameFolderModal
          folder={renameFolderTarget}
          onClose={() => setRenameFolderTarget(null)}
          onSaved={() => {
            setRenameFolderTarget(null)
            invalidateAll()
          }}
        />
      )}

      {canManageLibrary && moveFolderTarget && (
        <MoveFolderModal
          folder={moveFolderTarget}
          folders={allFolders}
          bridgeId={activeBridgeId}
          bridgeName={activeBridgeName}
          onClose={() => setMoveFolderTarget(null)}
          onSaved={() => {
            setMoveFolderTarget(null)
            invalidateAll()
          }}
        />
      )}

      {canManageLibrary && recycleBinOpen && (
        <LibraryRecycleBinModal onClose={() => setRecycleBinOpen(false)} />
      )}

      {canUploadLibrary && sliceTarget && (
        <SliceFileModal
          file={sliceTarget}
          flow={sliceFlow}
          isNewProject={sliceTargetIsNewProject}
          versionId={sliceVersionId}
          folders={allFolders}
          currentFolderId={currentFolderId}
          bridgeId={activeBridgeId}
          bridgeName={activeBridgeName}
          showRoot={showGlobalRootBreadcrumb}
          printers={printersQuery.data?.printers ?? []}
          printerStatuses={printerStatusQuery.data ?? {}}
          capabilities={slicingCapabilitiesQuery.data ?? null}
          capabilitiesLoading={slicingCapabilitiesQuery.isLoading && !slicingCapabilitiesQuery.data}
          capabilitiesError={slicingCapabilitiesQuery.error instanceof Error ? slicingCapabilitiesQuery.error.message : null}
          submitting={startSlicingJob.isPending}
          submitAction={startSlicingJob.variables?.action ?? null}
          submitError={startSlicingJob.error instanceof Error ? startSlicingJob.error.message : null}
          onClose={closeSliceDialog}
          onSubmit={(input, action, options) => startSlicingJob.mutate({ file: sliceTarget, versionId: sliceVersionId, action, keepDialogOpen: options?.keepDialogOpen, ...input })}
        />
      )}
        </>
      )}
      {externalDropActive && (
        <Sheet
          variant="soft"
          color="primary"
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: (theme) => theme.zIndex.popup,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'md',
            border: '2px dashed',
            borderColor: 'primary.500',
            opacity: 0.95,
            // Let drag events fall through to the Stack handlers above.
            pointerEvents: 'none'
          }}
        >
          <Typography level="title-lg" startDecorator={<DriveFolderUploadRoundedIcon />}>
            Drop files or folders to upload
          </Typography>
        </Sheet>
      )}
    </Stack>
  )
}

/**
 * Flatten the folder tree into a list of `id`/`label` entries with a
 * leading “Root” option. `excludeSubtreeOf` removes a folder
 * and all its descendants — used so a folder cannot be moved into
 * itself or one of its children.
 */
/**
 * Stateful bridge from `SliceFileModal` to the shared `SliceSettingsPanel`.
 *
 * The slice form's state stays owned by `SliceFileModal` (single source of
 * truth); this object exposes the values/setters/derived lists the settings UI
 * reads so the SAME panel can render both in the slim slicing dialog and inside
 * the 3D editor's "Settings" tab without duplicating controls. Module-scope
 * helpers/autocompletes used by the panel stay referenced directly (the panel
 * lives in this module), so only stateful values flow through here.
 */
export interface SliceSettingsController {
  file: LibraryFile
  resourceBasePath: string
  flow: 'library' | 'print'
  requiresSinglePlate: boolean
  canOpenThreeDimensionalPreview: boolean
  isMobileViewport: boolean
  tenantSlug: string | undefined
  navigate: ReturnType<typeof useNavigate>
  onClose: () => void
  // Slicer
  slicerTargets: SlicingCapabilities['targets']
  selectedSlicerTargetId: string
  setSelectedSlicerTargetId: React.Dispatch<React.SetStateAction<string>>
  legacyMachineSwitchWarning: string | null
  /** Slicer availability/loading state, surfaced as notices in the settings panel. */
  slicerStatus: {
    capabilitiesLoading: boolean
    hasCapabilities: boolean
    capabilitiesError: string | null
    configured: boolean
    slicerDataReady: boolean
    profilesError: string | null
  }
  // Printer
  printers: Printer[]
  selectedPrinter: Printer | null
  lockedPreferredPrinter: Printer | null
  targetMode: 'realPrinter' | 'manualProfile'
  setTargetMode: React.Dispatch<React.SetStateAction<'realPrinter' | 'manualProfile'>>
  setPrinterId: React.Dispatch<React.SetStateAction<string>>
  selectedPrinterModel: string
  manualPrinterModelTouchedRef: React.MutableRefObject<boolean>
  setManualPrinterModel: React.Dispatch<React.SetStateAction<string>>
  printerModelOptions: string[]
  nozzleDiameter: string
  setNozzleDiameter: React.Dispatch<React.SetStateAction<string>>
  nozzleDiameterOptions: string[]
  nozzleFlow: PrinterNozzleFlow
  setNozzleFlow: React.Dispatch<React.SetStateAction<PrinterNozzleFlow>>
  plateType: string
  setPlateType: React.Dispatch<React.SetStateAction<string>>
  plateTypeOptions: string[]
  // Plate (slim mode only)
  plateMode: 'all' | 'single'
  setPlateMode: React.Dispatch<React.SetStateAction<'all' | 'single'>>
  sceneEdit: SceneEdit | null
  setSceneEdit: React.Dispatch<React.SetStateAction<SceneEdit | null>>
  plateNumber: string
  setPlateNumber: React.Dispatch<React.SetStateAction<string>>
  slicePlateOptions: ThreeMfIndex['plates']
  setPreviewFileId: React.Dispatch<React.SetStateAction<string | null>>
  // Process
  compatibleProcessProfiles: SlicingProfileSummary[]
  selectedProcessProfile: SlicingProfileSummary | null
  processProfileModified: boolean
  setProcessProfileId: React.Dispatch<React.SetStateAction<string>>
  setProcessSettingOverrides: React.Dispatch<React.SetStateAction<Record<string, string | string[]>>>
  processProfileSelectionTouchedRef: React.MutableRefObject<boolean>
  selectedSlicerTargetIdForGuards: string
  processSettingOverrides: Record<string, string | string[]>
  setProcessSettingsDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  hasPlateObjects: boolean
  objectOverrideCount: number
  setPerObjectDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  selectedSliceObjectIds: Set<number>
  plateObjects: Array<{ id: number; name: string }>
  /**
   * Everything the editor sidebar needs to render per-object print toggles and
   * process overrides inline (no separate dialog). Null when no process profile is
   * selected yet. `value`/`globalOverrides` use the raw override-map shape.
   */
  perObjectSettings: {
    slicerTargetId: string
    processProfileId: string
    sourceFileId: string | null
    globalOverrides: Record<string, string | string[]>
    visibilityContext: { printerModel: string }
    value: Record<string, Record<string, string | string[]>>
    onChange: (next: Record<string, Record<string, string | string[]>>) => void
    printSelection: Set<number>
    onTogglePrint: (objectId: number) => void
  } | null
  // Materials
  projectFilaments: ReturnType<typeof buildSliceDialogProjectFilaments>
  /** Project-filament ids used by a given plate (for the "not on this plate" hint). */
  usedFilamentIdsForPlate: (plateIndex: number) => Set<number>
  materialOptions: SliceMaterialOption[]
  loadedMaterialOptions: SliceMaterialOption[]
  materialToolheadOptions: ReturnType<typeof buildSliceDialogToolheads>
  filamentMaterialOptionIds: Record<number, string>
  filamentMaterialTypeFilters: Record<number, string>
  setFilamentMaterialTypeFilters: React.Dispatch<React.SetStateAction<Record<number, string>>>
  filamentToolheadIds: Record<number, string>
  setFilamentToolheadIds: React.Dispatch<React.SetStateAction<Record<number, string>>>
  filamentColors: Record<number, string>
  setFilamentColors: React.Dispatch<React.SetStateAction<Record<number, string>>>
  setPrinterMaterialPickerFilamentId: React.Dispatch<React.SetStateAction<number | null>>
  handleMaterialOptionChange: (projectFilamentId: number, option: SliceMaterialOption | null) => void
  /**
   * Add/remove materials (Bambu-style). `desiredFilaments` is the full ordered filament
   * list to bake into the saved/sliced 3MF, or null when the user has not changed the
   * count (so unchanged projects don't rewrite project_settings.config). `onAddFilament`
   * appends a slot cloned from the first material; `onRemoveFilament` drops one (the UI
   * disables removing the last). Only surfaced in the editor ('editor' mode).
   */
  desiredFilaments: SceneEditFilament[] | null
  /**
   * Manual-profile target for the currently-selected machine when it is cross-model with the
   * project's source (so saving should retarget the 3MF to it, Bambu "switch printer + save").
   * Null when the selection matches the source model (no machine switch needed on save).
   */
  retargetTarget: SlicingManualProfileTarget | null
  onAddFilament: () => void
  onRemoveFilament: (projectFilamentId: number) => void
  /**
   * Whether a material is assigned to any object/part (the 3D editor supplies live usage).
   * When it returns true the material can't be removed — BambuStudio parity. Absent → not gated.
   */
  filamentInUse?: (projectFilamentId: number) => boolean
  /**
   * Point-in-time snapshot of the material-edit state + a restore fn, so the editor's
   * undo/redo can revert add/remove of materials alongside the scene (the material state
   * lives here, in the slice controller, not in the editor's scene state).
   */
  materialsSnapshot: SliceMaterialsSnapshot
  restoreMaterials: (snapshot: SliceMaterialsSnapshot) => void
  /**
   * Mutable listener the full editor sets to its `markDirty`, invoked whenever a material
   * is changed through this controller's own picker Modal (which the editor renders behind
   * itself). Lets picker-driven edits flip the editor's unsaved-changes flag even though they
   * bypass the markDirty-wrapped controller the editor hands to the settings panel.
   */
  materialEditListenerRef: React.MutableRefObject<(() => void) | null>
}

export interface SliceMaterialsSnapshot {
  removedFilamentIds: number[]
  profileEditedFilamentIds: number[]
  addedFilaments: Array<{ projectFilamentId: number; label: string; color: string | null; nozzleId: number | null; usedOnSelectedPlate: boolean }>
  addedFilamentSourceIndex: Record<number, number>
  filamentColors: Record<number, string>
  filamentMaterialOptionIds: Record<number, string>
  filamentToolheadIds: Record<number, string>
  filamentMaterialTypeFilters: Record<number, string>
  /** Per-object process overrides, so the editor's undo/redo can revert a gear edit. */
  objectProcessOverrides: Record<string, Record<string, string | string[]>>
}

/**
 * Shared slice-settings surface. `mode='simple'` renders the full set (incl. the
 * all/single-plate selector and the per-object overrides row) for the slim
 * slicing dialog; `mode='editor'` omits the plate-scope selector (the 3D editor
 * has its own plate strip) and the per-object row (the editor surfaces that in
 * its Objects tab). Both modes share one `controller` instance, so edits in
 * either surface update the same state.
 */
export function SliceSettingsPanel({ controller, mode }: { controller: SliceSettingsController; mode: 'simple' | 'editor'; activePlateIndex?: number }) {
  const {
    file, resourceBasePath, flow, requiresSinglePlate, canOpenThreeDimensionalPreview,
    tenantSlug, navigate, onClose,
    slicerTargets, selectedSlicerTargetId, setSelectedSlicerTargetId, legacyMachineSwitchWarning, slicerStatus,
    printers, selectedPrinter, lockedPreferredPrinter, targetMode, setTargetMode, setPrinterId,
    selectedPrinterModel, manualPrinterModelTouchedRef, setManualPrinterModel, printerModelOptions,
    nozzleDiameter, setNozzleDiameter, nozzleDiameterOptions, nozzleFlow, setNozzleFlow,
    plateType, setPlateType, plateTypeOptions,
    plateMode, setPlateMode, sceneEdit, setSceneEdit, plateNumber, setPlateNumber, slicePlateOptions, setPreviewFileId,
    compatibleProcessProfiles, selectedProcessProfile, processProfileModified, setProcessProfileId, setProcessSettingOverrides,
    processProfileSelectionTouchedRef, selectedSlicerTargetIdForGuards, processSettingOverrides, setProcessSettingsDialogOpen,
    hasPlateObjects, objectOverrideCount, setPerObjectDialogOpen, selectedSliceObjectIds, plateObjects,
    projectFilaments, materialOptions, loadedMaterialOptions, materialToolheadOptions,
    filamentMaterialOptionIds, filamentMaterialTypeFilters, setFilamentMaterialTypeFilters,
    filamentToolheadIds, setFilamentToolheadIds, filamentColors, setFilamentColors,
    setPrinterMaterialPickerFilamentId, handleMaterialOptionChange,
    onAddFilament, onRemoveFilament, filamentInUse
  } = controller
  const showPlateSection = mode === 'simple'
  const showPerObjectRow = mode === 'simple'
  // Add/remove materials is an editing affordance (Bambu-style) — only in the editor.
  const showMaterialEditing = mode === 'editor'
  return (
    <>
      {slicerStatus.capabilitiesLoading && !slicerStatus.hasCapabilities && (
        <Stack direction="row" spacing={1} alignItems="center">
          <CircularProgress size="sm" />
          <Typography level="body-sm" textColor="text.secondary">Checking slicer availability…</Typography>
        </Stack>
      )}
      {!slicerStatus.capabilitiesLoading && slicerStatus.capabilitiesError && (
        <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{slicerStatus.capabilitiesError}</Alert>
      )}
      {!slicerStatus.capabilitiesLoading && !slicerStatus.capabilitiesError && !slicerStatus.configured && (
        <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
          The slicer service is not reachable or no slicer versions are installed.
        </Alert>
      )}
      {slicerStatus.configured && !slicerStatus.capabilitiesError && !slicerStatus.slicerDataReady && !slicerStatus.profilesError && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 2 }}>
          <CircularProgress size="sm" />
          <Typography level="body-sm" textColor="text.secondary">Loading slicer data…</Typography>
        </Stack>
      )}
      {slicerStatus.profilesError && (
        <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{slicerStatus.profilesError}</Alert>
      )}
      {slicerStatus.slicerDataReady && (<>
      <Typography level="title-sm">Slicer</Typography>
      <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
        <Stack spacing={1}>
          <FormControl>
            <Select<string>
              value={selectedSlicerTargetId || null}
              placeholder="Choose a slicer version"
              disabled={slicerTargets.length === 0}
              slotProps={{ button: { 'aria-label': 'Version' } }}
              onChange={(_event, value) => setSelectedSlicerTargetId(value ?? '')}
            >
              {slicerTargets.map((target) => (
                <Option key={target.id} value={target.id}>{target.label}</Option>
              ))}
            </Select>
          </FormControl>
          {legacyMachineSwitchWarning && (
            <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
              {legacyMachineSwitchWarning}
            </Alert>
          )}
        </Stack>
      </Sheet>
      <Typography level="title-sm">Printer</Typography>
      <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
        <Box
          sx={{
            // The settings now live in a narrow sidebar, so keep at most two inputs
            // per line everywhere (the layout reads well at desktop and phone widths).
            display: 'grid',
            gap: 1,
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gridTemplateAreas: '"printer printer" "model plateType" "nozzleDiameter nozzleFlow"'
          }}
        >
            <FormControl sx={{ gridArea: 'printer', minWidth: 0 }}>
              <FormLabel>Printer</FormLabel>
              <Autocomplete
                options={printers}
                value={selectedPrinter}
                placeholder={lockedPreferredPrinter ? undefined : 'Optional'}
                clearOnEscape
                disableClearable={Boolean(lockedPreferredPrinter)}
                disabled={Boolean(lockedPreferredPrinter)}
                getOptionLabel={(printer) => printer.name}
                isOptionEqualToValue={(option, selected) => option.id === selected.id}
                onChange={(_event, value) => {
                  setPrinterId(value?.id ?? '')
                  setTargetMode(value ? 'realPrinter' : 'manualProfile')
                }}
                renderOption={(props, printer) => (
                  <AutocompleteOption {...props} key={printer.id}>
                    <ListItemContent>{printer.name}</ListItemContent>
                  </AutocompleteOption>
                )}
              />
            </FormControl>
            <FormControl sx={{ gridArea: 'model', minWidth: 0 }}>
              <FormLabel>Model</FormLabel>
              <Select<string>
                value={selectedPrinterModel}
                disabled={targetMode === 'realPrinter' || Boolean(lockedPreferredPrinter)}
                onChange={(_event, value) => {
                  if (targetMode === 'realPrinter') return
                  manualPrinterModelTouchedRef.current = true
                  setManualPrinterModel(value ?? printerModelOptions[0] ?? 'unknown')
                }}
              >
                {printerModelOptions.map((model) => (
                  <Option key={model} value={model}>{formatPrinterModelLabel(model)}</Option>
                ))}
              </Select>
            </FormControl>
            <FormControl sx={{ gridArea: 'nozzleDiameter', minWidth: 0 }}>
              <FormLabel>Nozzle diameter</FormLabel>
              <Select<string> value={nozzleDiameter} disabled={Boolean(lockedPreferredPrinter)} onChange={(_event, value) => setNozzleDiameter(value ?? '')}>
                {nozzleDiameterOptions.map((option) => (
                  <Option key={option} value={option}>{formatNozzleDiameterLabel(option) ?? `${option} mm`}</Option>
                ))}
              </Select>
            </FormControl>
            <FormControl sx={{ gridArea: 'nozzleFlow', minWidth: 0 }}>
              <FormLabel>Nozzle flow</FormLabel>
              <Select<PrinterNozzleFlow> value={nozzleFlow} disabled={Boolean(lockedPreferredPrinter)} onChange={(_event, value) => setNozzleFlow(value ?? 'standard')}>
                <Option value="standard">Standard flow</Option>
                <Option value="high">High flow</Option>
                <Option value="tpu-high">TPU high flow</Option>
              </Select>
            </FormControl>
            <FormControl sx={{ gridArea: 'plateType', minWidth: 0 }}>
              <FormLabel>Plate type</FormLabel>
              <Select<string> value={plateType} disabled={Boolean(lockedPreferredPrinter)} onChange={(_event, value) => setPlateType(value ?? '')}>
                {plateTypeOptions.map((option) => (
                  <Option key={option} value={option}>{formatPlateTypeLabel(option)}</Option>
                ))}
              </Select>
            </FormControl>
        </Box>
      </Sheet>
      {showPlateSection && (<>
      <Typography level="title-sm">Plate</Typography>
      <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
        <Stack spacing={1}>
          {!requiresSinglePlate && (
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between' }}
            >
              <ButtonGroup size="md" variant="outlined" sx={{ '--ButtonGroup-radius': 'var(--joy-radius-sm)', width: { xs: '100%', sm: 'auto' }, '& > *': { flex: { xs: 1, sm: 'initial' } } }}>
                <Button
                  type="button"
                  variant={plateMode === 'all' ? 'solid' : 'outlined'}
                  color={plateMode === 'all' ? 'primary' : 'neutral'}
                  onClick={() => setPlateMode('all')}
                >
                  All plates
                </Button>
                <Button
                  type="button"
                  variant={plateMode === 'single' ? 'solid' : 'outlined'}
                  color={plateMode === 'single' ? 'primary' : 'neutral'}
                  onClick={() => setPlateMode('single')}
                >
                  Specific plate
                </Button>
              </ButtonGroup>
              {canOpenThreeDimensionalPreview && (
                <Button
                  type="button"
                  variant="outlined"
                  color="neutral"
                  size="sm"
                  startDecorator={<VisibilityRoundedIcon />}
                  onClick={() => setPreviewFileId(file.id)}
                  sx={{ width: { xs: '100%', sm: 'auto' } }}
                >
                  Preview
                </Button>
              )}
            </Stack>
          )}
          {sceneEdit && (
            <Chip
              variant="soft"
              color="primary"
              size="md"
              endDecorator={
                <Tooltip title="Reset to original layout">
                  <IconButton
                    size="sm"
                    variant="plain"
                    color="primary"
                    onClick={() => setSceneEdit(null)}
                    aria-label="Reset custom layout"
                  >
                    <RestoreRoundedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              }
              sx={{ alignSelf: 'flex-start' }}
            >
              Custom layout: {sceneEdit.instances.length} {sceneEdit.instances.length === 1 ? 'model' : 'models'} on {sceneEdit.plates.length} {sceneEdit.plates.length === 1 ? 'plate' : 'plates'}
            </Chip>
          )}
          {(requiresSinglePlate || plateMode === 'single') && (
            slicePlateOptions.length > 0 ? (
              <LibraryPlateCardPicker
                fileId={file.id}
                resourceBasePath={resourceBasePath}
                thumbnailVersion={file.uploadedAt}
                plates={slicePlateOptions}
                value={Number.parseInt(plateNumber, 10)}
                onChange={(value) => setPlateNumber(String(value))}
                label={flow === 'print' ? 'Choose a plate to print' : 'Choose a plate to slice'}
                onPreview={canOpenThreeDimensionalPreview ? () => setPreviewFileId(file.id) : undefined}
              />
            ) : (
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Plate number</FormLabel>
                <Input type="number" slotProps={{ input: { min: 1, step: 1 } }} value={plateNumber} onChange={(event) => setPlateNumber(event.target.value)} />
              </FormControl>
            )
          )}
        </Stack>
      </Sheet>
      </>)}
      <Typography level="title-sm">Process</Typography>
      <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
        <Stack spacing={1}>
          <FormControl sx={{ flex: 1 }}>
            <FormLabel>Global</FormLabel>
            <Stack direction="row" spacing={1} alignItems="center">
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <SlicingProfileAutocomplete
                  profiles={compatibleProcessProfiles}
                  value={selectedProcessProfile}
                  placeholder="Choose a quality profile"
                  ariaLabel="Preset"
                  modified={processProfileModified}
                  onChange={(profile) => {
                    processProfileSelectionTouchedRef.current = true
                    setProcessProfileId(profile?.id ?? '')
                    setProcessSettingOverrides({})
                  }}
                />
              </Box>
              <Tooltip title={selectedProcessProfile ? 'Edit process settings' : 'Choose a quality profile first'}>
                <span>
                  <Button
                    variant="outlined"
                    color="neutral"
                    startDecorator={<EditRoundedIcon />}
                    disabled={!selectedProcessProfile || !selectedSlicerTargetIdForGuards}
                    onClick={() => setProcessSettingsDialogOpen(true)}
                  >
                    Edit
                    {Object.keys(processSettingOverrides).length > 0 && (
                      <Chip size="sm" variant="solid" color="primary" sx={{ ml: 0.75 }}>
                        {Object.keys(processSettingOverrides).length}
                      </Chip>
                    )}
                  </Button>
                </span>
              </Tooltip>
            </Stack>
          </FormControl>
          {showPerObjectRow && hasPlateObjects && (
            <Stack spacing={0.5}>
              <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center">
                <FormLabel sx={{ m: 0 }}>Per-object overrides</FormLabel>
                <Button
                  variant="outlined"
                  color="neutral"
                  size="sm"
                  disabled={!selectedProcessProfile || !selectedSlicerTargetIdForGuards}
                  onClick={() => setPerObjectDialogOpen(true)}
                >
                  Edit per-object
                  {objectOverrideCount > 0 && (
                    <Chip size="sm" variant="solid" color="primary" sx={{ ml: 0.75 }}>{objectOverrideCount}</Chip>
                  )}
                </Button>
              </Stack>
              {selectedSliceObjectIds.size < plateObjects.length && (
                <FormHelperText sx={selectedSliceObjectIds.size === 0 ? { color: 'danger.500' } : undefined}>
                  {selectedSliceObjectIds.size === 0
                    ? `Select at least one object to ${flow === 'print' ? 'print' : 'slice'}.`
                    : `${selectedSliceObjectIds.size} of ${plateObjects.length} objects will ${flow === 'print' ? 'print' : 'be sliced'}.`}
                </FormHelperText>
              )}
            </Stack>
          )}
          {tenantSlug && (
            <Link
              level="body-xs"
              component="button"
              type="button"
              onClick={() => {
                onClose()
                navigate(buildTenantWorkspacePath(tenantSlug, '/settings/slicing'))
              }}
              sx={{ alignSelf: 'flex-start' }}
            >
              Manage custom presets
            </Link>
          )}
        </Stack>
      </Sheet>
      {(projectFilaments.length > 0 || showMaterialEditing) && (
        <Stack spacing={1}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography level="title-sm">Materials</Typography>
            {showMaterialEditing && (
              <Button type="button" size="sm" variant="soft" startDecorator={<AddRoundedIcon />} sx={{ ml: 'auto' }} onClick={onAddFilament}>
                Add material
              </Button>
            )}
          </Stack>
          {projectFilaments.length === 0 && showMaterialEditing && (
            <Typography level="body-sm" textColor="text.tertiary">No materials yet. Add one to choose a material.</Typography>
          )}
          {projectFilaments.map((filament, filamentIndex) => {
            const selectedOption = materialOptions.find((option) => option.id === filamentMaterialOptionIds[filament.projectFilamentId]) ?? null
            const typeFilter = filamentMaterialTypeFilters[filament.projectFilamentId] ?? selectedOption?.materialType ?? ''
            const typeOptions = resolveMaterialTypeOptions(materialOptions)
            const narrowedMaterialOptions = narrowMaterialOptions(materialOptions, typeFilter, selectedOption?.id)
            const loadedOptionsForFilament = prioritizeLoadedMaterialOptionsForFilament(loadedMaterialOptions, filament.nozzleId ?? null)
            const selectedToolheadId = filamentToolheadIds[filament.projectFilamentId] ?? ''
            const useToolheadButtonSet = materialToolheadOptions.length === 2
            return (
            <Sheet key={filament.projectFilamentId} variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
              <Stack spacing={0.75}>
              <Stack direction="row" alignItems="center" sx={{ flexWrap: 'wrap', columnGap: 1, rowGap: 0.5 }}>
                <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0, flexWrap: 'wrap', rowGap: 0.25 }}>
                  <Typography level="title-sm">Material {filamentIndex + 1}</Typography>
                </Stack>
                <Stack direction="row" spacing={0.5} alignItems="center" sx={{ ml: 'auto' }}>
                  {targetMode === 'realPrinter' && (
                    <Button type="button" size="sm" variant="plain" disabled={loadedOptionsForFilament.length === 0} onClick={() => setPrinterMaterialPickerFilamentId(filament.projectFilamentId)}>
                      Choose from printer
                    </Button>
                  )}
                  {showMaterialEditing && (() => {
                    const inUse = filamentInUse?.(filament.projectFilamentId) ?? false
                    const removeDisabled = projectFilaments.length <= 1 || inUse
                    const removeTitle = projectFilaments.length <= 1
                      ? 'A project needs at least one material'
                      : inUse
                        ? 'This material is used by an object — reassign it before removing'
                        : 'Remove material'
                    return (
                      <Tooltip title={removeTitle}>
                        <span>
                          <IconButton
                            size="sm"
                            variant="plain"
                            color="danger"
                            disabled={removeDisabled}
                            onClick={() => onRemoveFilament(filament.projectFilamentId)}
                            aria-label={`Remove material ${filamentIndex + 1}`}
                          >
                            <DeleteRoundedIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    )
                  })()}
                </Stack>
              </Stack>
              <Stack direction="row" spacing={1} alignItems="flex-end" sx={{ flexWrap: 'wrap' }}>
                <FormControl sx={{ flex: '1 1 150px', minWidth: 0 }}>
                  <FormLabel>Type</FormLabel>
                  <Select<string>
                    value={typeFilter}
                    slotProps={{
                      listbox: {
                        sx: {
                          maxHeight: { xs: 'min(50vh, 18rem)', sm: 360 },
                          overflowY: 'auto',
                          overscrollBehavior: 'contain'
                        }
                      }
                    }}
                    onChange={(_event, value) => setFilamentMaterialTypeFilters((current) => ({ ...current, [filament.projectFilamentId]: value ?? '' }))}
                  >
                    <Option value="">All material types</Option>
                    {typeOptions.map((option) => <Option key={option} value={option}>{option}</Option>)}
                  </Select>
                </FormControl>
                <FormControl sx={{ flex: '1 1 150px', minWidth: 0 }}>
                  <FormLabel>Preset</FormLabel>
                  <SliceMaterialAutocomplete
                    options={narrowedMaterialOptions}
                    value={selectedOption}
                    placeholder="Choose a material profile"
                    onChange={(option) => handleMaterialOptionChange(filament.projectFilamentId, option)}
                  />
                </FormControl>
                <Stack direction="row" spacing={1} alignItems="flex-end" sx={{ flex: '1 1 100%', minWidth: 0, width: '100%' }}>
                  <FormControl sx={{ flex: '1 1 0', minWidth: 0 }}>
                    <FormLabel>Color</FormLabel>
                    <Box sx={{ display: 'flex', alignItems: 'center', height: 'var(--Input-minHeight, 2.25rem)', width: '100%' }}>
                      <SliceFilamentColorPicker
                        color={normalizeSliceFilamentColor(filamentColors[filament.projectFilamentId] ?? filament.color)}
                        material={(selectedOption?.materialType ?? typeFilter) || filament.label}
                        brand={selectedOption?.brand ?? ''}
                        fullWidth
                        onChange={(color) => setFilamentColors((current) => ({ ...current, [filament.projectFilamentId]: normalizeSliceFilamentColor(color) }))}
                      />
                    </Box>
                  </FormControl>
                  {materialToolheadOptions.length > 0 && (useToolheadButtonSet ? (
                    <FormControl sx={{ flex: '1 1 0', minWidth: 0 }} required>
                      <FormLabel>Nozzle</FormLabel>
                      <ButtonGroup size="md" variant="outlined" sx={{ '--ButtonGroup-radius': 'var(--joy-radius-sm)', width: '100%', '& > *': { minWidth: 0, px: 1.25, flex: 1 } }}>
                        {[...materialToolheadOptions].sort((left, right) => {
                          const rank = (position: 'left' | 'right' | 'single' | null | undefined) => position === 'left' ? 0 : position === 'right' ? 1 : 2
                          return rank(left.position) - rank(right.position)
                        }).map((toolhead) => {
                          const buttonLabel = toolhead.position === 'left'
                            ? 'Left'
                            : toolhead.position === 'right'
                              ? 'Right'
                              : toolhead.label
                          const selected = selectedToolheadId === toolhead.id
                          return (
                            <Button
                              key={toolhead.id}
                              type="button"
                              variant={selected ? 'solid' : 'outlined'}
                              color={selected ? 'primary' : 'neutral'}
                              aria-pressed={selected}
                              onClick={() => setFilamentToolheadIds((current) => ({ ...current, [filament.projectFilamentId]: toolhead.id }))}
                              title={toolhead.label}
                            >
                              {buttonLabel}
                            </Button>
                          )
                        })}
                      </ButtonGroup>
                    </FormControl>
                  ) : (
                    <FormControl sx={{ flex: '1 1 0', minWidth: 0 }} required>
                      <FormLabel>Nozzle</FormLabel>
                      <Select<string>
                        value={selectedToolheadId}
                        placeholder="Choose"
                        onChange={(_event, value) => setFilamentToolheadIds((current) => ({ ...current, [filament.projectFilamentId]: value ?? '' }))}
                      >
                        {materialToolheadOptions.map((toolhead) => (
                          <Option key={toolhead.id} value={toolhead.id}>{toolhead.label}</Option>
                        ))}
                      </Select>
                    </FormControl>
                  ))}
                </Stack>
              </Stack>
              </Stack>
            </Sheet>
          )})}
        </Stack>
      )}
      </>)}
    </>
  )
}

export function SliceFileModal({
  file,
  versionId = null,
  isNewProject = false,
  folders = [],
  currentFolderId = null,
  bridgeId = null,
  bridgeName = null,
  showRoot = false,
  printers,
  printerStatuses,
  capabilities,
  capabilitiesLoading,
  capabilitiesError,
  submitting,
  submitAction,
  submitError,
  flow = 'library',
  preferredPrinterId,
  defaultPlateNumber,
  onClose,
  onSubmit
}: {
  file: LibraryFile
  /** Slice an archived version of `file` instead of its current content. */
  versionId?: string | null
  /** The editor target is a brand-new project (hidden scaffold) → save prompts for name/location. */
  isNewProject?: boolean
  folders?: LibraryFolder[]
  currentFolderId?: string | null
  bridgeId?: string | null
  bridgeName?: string | null
  showRoot?: boolean
  printers: Printer[]
  printerStatuses: Record<string, PrinterStatus>
  capabilities: SlicingCapabilities | null
  capabilitiesLoading: boolean
  capabilitiesError: string | null
  submitting: boolean
  submitAction: SliceFileSubmitAction | null
  submitError: string | null
  flow?: 'library' | 'print'
  preferredPrinterId?: string
  /** Preselect this plate (e.g. an order item's plate) instead of plate 1. */
  defaultPlateNumber?: number
  onClose: () => void
  onSubmit: (input: SliceFileSubmitInput, action: SliceFileSubmitAction, options?: { keepDialogOpen?: boolean }) => void
}) {
  const navigate = useNavigate()
  const { tenantSlug } = useParams<{ tenantSlug: string }>()
  const resourceBasePath = buildLibraryResourceBasePath(file.id, versionId)
  const requiresSinglePlate = flow === 'print'
  const saveActionVisible = flow === 'library'
  const dialogTitle = flow === 'print'
    ? `Prepare ${formatLibraryFileName(file.name)} for print`
    : `Slice ${formatLibraryFileName(file.name)}`
  const dialogDescription = flow === 'print'
    ? 'Review slicing settings before continuing to printer selection.'
    : null
  const isMobileViewport = useMobileViewport()
  const printActionLabel = flow === 'print' ? 'Continue to print' : (isMobileViewport ? 'Print' : 'Print Now')
  const saveActionLabel = isMobileViewport ? 'Save' : 'Save to Library'
  const lockedPreferredPrinter = useMemo(
    () => flow === 'print' && preferredPrinterId
      ? printers.find((printer) => printer.id === preferredPrinterId) ?? null
      : null,
    [flow, preferredPrinterId, printers]
  )
  const [targetMode, setTargetMode] = useState<'realPrinter' | 'manualProfile'>(() => (lockedPreferredPrinter ? 'realPrinter' : 'manualProfile'))
  const [printerId, setPrinterId] = useState(() => lockedPreferredPrinter?.id ?? '')
  const appliedBakedDefaultsRef = useRef(false)
  // Mirrors appliedBakedDefaultsRef as state so the form can wait for the 3MF defaults to be
  // seeded before becoming interactive (avoids showing values that change once the slicer data
  // loads).
  const [bakedDefaultsApplied, setBakedDefaultsApplied] = useState(false)
  const manualPrinterModelTouchedRef = useRef(false)
  const processProfileSelectionTouchedRef = useRef(false)
  const [previewFileId, setPreviewFileId] = useState<string | null>(null)
  // Edited multi-plate arrangement from the interactive 3D editor. When set, it is
  // authoritative: the slice runs across every plate the edit defines (plate: 0).
  const [sceneEdit, setSceneEdit] = useState<SceneEdit | null>(null)
  // When the full 3D editor hands back a layout it also chooses the plate scope to
  // act on: a 1-based plate index, or 0 for all plates. Drives `plate` in the submit
  // payload so the editor's "print this plate" targets just that plate.
  const [editorPlatePreference, setEditorPlatePreference] = useState<number | null>(null)
  const slicerTargets = capabilities?.targets ?? EMPTY_SLICER_TARGETS
  const configured = Boolean(capabilities?.configured && capabilities?.healthy && slicerTargets.length > 0)
  const [selectedSlicerTargetId, setSelectedSlicerTargetId] = useState(() => capabilities?.defaultTargetId ?? capabilities?.targets[0]?.id ?? '')
  const selectedSlicerTarget = slicerTargets.find((target) => target.id === selectedSlicerTargetId) ?? null
  const shouldLoadSlicingProfiles = configured && selectedSlicerTargetId.length > 0
  const slicingProfilesQuery = useQuery({
    queryKey: ['slicing-profiles', selectedSlicerTargetId],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams()
      params.set('targetId', selectedSlicerTargetId)
      const result = await apiFetch<SlicingProfilesResponse>(`/api/slicing/profiles?${params.toString()}`, { signal })
      // A response with no builtin presets means the slicer answered before its bundled `*_full/`
      // preset dirs were indexed (restart / still initializing) and only the workspace's custom
      // profiles came back. Caching that strands the editor on a custom-only catalogue — see
      // `slicingProfilesResponseIsUsable` for the full failure mode (Slice disabled; loaded materials
      // mislabelling, e.g. PETG slots showing as "PLA Basic"). Throw so React Query retries with
      // backoff and surfaces a retryable error if it persists, rather than poisoning the cache.
      if (!slicingProfilesResponseIsUsable(result.profiles)) {
        throw new Error('Couldn’t load slicer profiles — the slicer may be restarting. Reopen the editor to try again.')
      }
      return result
    },
    enabled: shouldLoadSlicingProfiles,
    // The slicer's preset catalogue is effectively static per image, so keep it fresh for a few
    // minutes: reopening the editor reuses the cached profiles instead of refetching the whole
    // catalogue (which otherwise also blocks the plate/geometry load gated behind it).
    staleTime: 5 * 60_000,
    retry: 5,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000)
  })
  const profiles = slicingProfilesQuery.data?.profiles ?? EMPTY_SLICING_PROFILES
  // "Should have profiles but don't yet" — not merely "the query is actively fetching". The slicer
  // can briefly return an empty list while restarting, so the query throws and retries with backoff;
  // between retries `isLoading` flickers false while `profiles` is still empty. Gating only on
  // `isLoading` let the slice dialog apply — and one-shot lock (`appliedBakedDefaultsRef`) — its
  // filament defaults against an empty profile list during that gap, so a project's actual material
  // matched nothing and fell back to the generic machine default ("Bambu PLA Basic") until the dialog
  // was reopened after the profiles query had cached. Treat the whole load+retry window as waiting;
  // excluding the terminal error state preserves the existing error / empty-defaults handling.
  const waitingForSlicingProfiles = shouldLoadSlicingProfiles && profiles.length === 0 && !slicingProfilesQuery.isError
  const platesQuery = useQuery({
    queryKey: ['library-plates', file.id, versionId ?? 'current', 'slice-defaults'],
    queryFn: ({ signal }) => apiFetch<ThreeMfIndex>(`${resourceBasePath}/plates`, { signal }),
    // The 3MF index doesn't depend on slicer profiles, so fetch it in PARALLEL with the (slow)
    // profile catalogue instead of after it — the plate/object list and per-object UI become
    // available sooner. Applying baked slice defaults still waits for both (see the
    // `appliedBakedDefaultsRef` effect, which gates on `waitingForSlicingProfiles`).
    staleTime: 60_000
  })
  const bakedIndex = platesQuery.data ?? null
  const slicePlateOptions = useMemo(() => bakedIndex?.plates ?? [], [bakedIndex])
  const canOpenThreeDimensionalPreview = file.kind === '3mf' && slicePlateOptions.length > 0
  const machineProfiles = useMemo(
    () => mergeProjectSlicingProfiles(profiles.filter((profile) => profile.kind === 'machine'), buildProjectSlicingProfiles(bakedIndex, 'machine')),
    [bakedIndex, profiles]
  )
  const processProfiles = useMemo(
    () => mergeProjectSlicingProfiles(profiles.filter((profile) => profile.kind === 'process' && isVisibleProcessProfile(profile)), buildProjectSlicingProfiles(bakedIndex, 'process')),
    [bakedIndex, profiles]
  )
  const filamentProfiles = useMemo(
    () => mergeProjectSlicingProfiles(profiles.filter((profile) => profile.kind === 'filament' && isVisibleFilamentProfile(profile)), buildProjectSlicingProfiles(bakedIndex, 'filament')),
    [bakedIndex, profiles]
  )
  const selectedPrinter = printers.find((printer) => printer.id === printerId) ?? null
  const [manualPrinterModel, setManualPrinterModel] = useState<string>(() => resolveInitialManualPrinterModel(file, machineProfiles, lockedPreferredPrinter?.model ?? printers[0]?.model))
  const [printerProfileId, setPrinterProfileId] = useState(() => pickMachineProfileForPrinter(machineProfiles, lockedPreferredPrinter ?? printers[0])?.id ?? machineProfiles[0]?.id ?? '')
  // Default a fresh selection to the 0.20mm Standard preset rather than whatever is first
  // in the list; an existing file's baked profile still overrides this via the effects below.
  const [processProfileId, setProcessProfileId] = useState(() => pickStandardProcessProfile(processProfiles)?.id ?? processProfiles[0]?.id ?? '')
  const [processSettingOverrides, setProcessSettingOverrides] = useState<Record<string, string | string[]>>({})
  const [processSettingsDialogOpen, setProcessSettingsDialogOpen] = useState(false)
  const [objectProcessOverrides, setObjectProcessOverrides] = useState<Record<string, Record<string, string | string[]>>>({})
  const [perObjectDialogOpen, setPerObjectDialogOpen] = useState(false)
  const [plateMode, setPlateMode] = useState<'all' | 'single'>(() => requiresSinglePlate || defaultPlateNumber != null ? 'single' : 'all')
  const [plateNumber, setPlateNumber] = useState(() => String(defaultPlateNumber ?? 1))
  const [plateType, setPlateType] = useState(resolveInitialPlateType(file, null))
  const [nozzleDiameter, setNozzleDiameter] = useState(() => resolveInitialNozzleDiameter(file, lockedPreferredPrinter ?? printers[0], null, null))
  const [nozzleFlow, setNozzleFlow] = useState<PrinterNozzleFlow>('standard')
  const [filamentMaterialOptionIds, setFilamentMaterialOptionIds] = useState<Record<number, string>>(() => buildInitialFilamentMaterialOptionSelection(file, null, filamentProfiles))
  const [filamentMaterialTypeFilters, setFilamentMaterialTypeFilters] = useState<Record<number, string>>({})
  const [filamentColors, setFilamentColors] = useState<Record<number, string>>(() => buildInitialFilamentColorSelection(file, null))
  const [filamentToolheadIds, setFilamentToolheadIds] = useState<Record<number, string>>(() => buildInitialFilamentToolheadSelection(file, null))
  const [printerMaterialPickerFilamentId, setPrinterMaterialPickerFilamentId] = useState<number | null>(null)
  // The full editor renders this controller's own "Choose material" picker Modal behind itself
  // (the host slice dialog stays mounted), so a pick made there calls THIS controller's
  // `handleMaterialOptionChange` directly — not the markDirty-wrapped copy the editor hands to the
  // settings panel. The editor registers `markDirty` here so picker-driven material edits still
  // light its Save button. Null in the simple slice path.
  const materialEditListenerRef = useRef<(() => void) | null>(null)
  const [saveDestinationOpen, setSaveDestinationOpen] = useState(false)
  // Slice-time object selection (single-plate only). Tracks the kept objects; defaults to all.
  const [selectedSliceObjectIds, setSelectedSliceObjectIds] = useState<Set<number>>(new Set())
  const selectedPrinterModel = targetMode === 'realPrinter' ? selectedPrinter?.model ?? 'unknown' : manualPrinterModel
  const selectedPrinterStatus = printerId ? printerStatuses[printerId] : undefined
  const selectedMachineProfile = machineProfiles.find((profile) => profile.id === printerProfileId) ?? null
  const sourcePrinterModel = useMemo(
    () => resolveSliceDialogSourcePrinterModel(bakedIndex, file.compatiblePrinterModels),
    [bakedIndex, file.compatiblePrinterModels]
  )
  const targetPrinterModel = useMemo(
    () => resolveSliceDialogTargetPrinterModel(selectedPrinterModel, selectedMachineProfile),
    [selectedMachineProfile, selectedPrinterModel]
  )
  // BambuStudio drops the 3MF project's embedded presets when the chosen
  // printer is incompatible with the project's source model and falls back to
  // the target machine's defaults. We mirror that: project profiles stay
  // available for same-family targets (e.g. X1C project -> P1S) but are hidden
  // when the target is cross-family (e.g. X1C project -> H2D).
  const projectProfilesCompatibleWithTarget = useMemo(
    () => bambuModelKeysAreCompatible(sourcePrinterModel, targetPrinterModel),
    [sourcePrinterModel, targetPrinterModel]
  )
  const selectedNozzleDiameters = useMemo(() => {
    const diameter = Number.parseFloat(nozzleDiameter)
    return Number.isFinite(diameter) && diameter > 0 ? [diameter] : []
  }, [nozzleDiameter])
  const modelCompatibleMachineProfiles = useMemo(
    () => machineProfiles.filter((profile) => matchesPrinterModel(profile, selectedPrinterModel)),
    [machineProfiles, selectedPrinterModel]
  )
  const nozzleDiameterOptions = useMemo(
    () => resolveSliceDialogNozzleDiameterOptions(file, selectedPrinter, modelCompatibleMachineProfiles, bakedIndex),
    [bakedIndex, file, modelCompatibleMachineProfiles, selectedPrinter]
  )
  const compatibleMachineProfiles = useMemo(
    () => machineProfiles.filter((profile) => isMachineProfileCompatible(profile, selectedPrinterModel, selectedNozzleDiameters)),
    [machineProfiles, selectedNozzleDiameters, selectedPrinterModel]
  )
  const selectableMachineProfiles = useMemo(
    () => compatibleMachineProfiles.filter(isSelectableSlicingProfile),
    [compatibleMachineProfiles]
  )
  const printerCompatibleProcessProfiles = useMemo(
    () => processProfiles.filter((profile) => isSelectableOrProjectFallbackSlicingProfile(profile, processProfiles, bakedIndex?.processProfileName ?? null) && isProjectProfileAllowedForTarget(profile, projectProfilesCompatibleWithTarget) && isProcessProfileCompatible(profile, selectedMachineProfile, selectedPrinterModel, selectedNozzleDiameters, '')),
    [bakedIndex?.processProfileName, processProfiles, projectProfilesCompatibleWithTarget, selectedMachineProfile, selectedNozzleDiameters, selectedPrinterModel]
  )
  const plateTypeOptions = useMemo(
    () => resolveCompatiblePlateTypes(file, bakedIndex, selectedMachineProfile, printerCompatibleProcessProfiles),
    [bakedIndex, file, printerCompatibleProcessProfiles, selectedMachineProfile]
  )
  const compatibleProcessProfiles = useMemo(
    () => dedupeVisibleProcessProfiles(
      printerCompatibleProcessProfiles.filter((profile) => isProcessProfileCompatible(profile, selectedMachineProfile, selectedPrinterModel, selectedNozzleDiameters, plateType)),
      selectedMachineProfile,
      selectedPrinterModel
    ),
    [plateType, printerCompatibleProcessProfiles, selectedMachineProfile, selectedNozzleDiameters, selectedPrinterModel]
  )
  const selectedAnyProcessProfile = processProfiles.find((profile) => profile.id === processProfileId) ?? null
  const selectedProcessProfile = compatibleProcessProfiles.find((profile) => profile.id === processProfileId) ?? null
  const compatibleFilamentProfiles = useMemo(
    () => filamentProfiles.filter((profile) => isProjectProfileAllowedForTarget(profile, projectProfilesCompatibleWithTarget) && isFilamentProfileCompatible(profile, selectedMachineProfile, selectedProcessProfile, selectedPrinterModel, selectedNozzleDiameters)),
    [filamentProfiles, projectProfilesCompatibleWithTarget, selectedMachineProfile, selectedNozzleDiameters, selectedPrinterModel, selectedProcessProfile]
  )
  const loadedMaterialSource = useMemo<LoadedMaterialSource | null>(
    () => targetMode === 'realPrinter' && selectedPrinterStatus
      ? {
          ams: selectedPrinterStatus.ams,
          externalSpools: selectedPrinterStatus.externalSpools,
          nozzleCount: selectedPrinterStatus.nozzles.length > 0 ? selectedPrinterStatus.nozzles.length : null
        }
      : null,
    [selectedPrinterStatus, targetMode]
  )
  // Keep the source referentially stable across status frames that don't touch
  // loaded-material data, so the material dropdown doesn't lose scroll position
  // or typed input while the printer streams temperature/progress updates.
  const stableLoadedMaterialSource = useDeepStableValue(loadedMaterialSource)
  const loadedMaterialOptions = useMemo(
    () => buildLoadedPrinterMaterialOptions(stableLoadedMaterialSource, compatibleFilamentProfiles, selectedMachineProfile, selectedPrinterModel),
    [compatibleFilamentProfiles, selectedMachineProfile, selectedPrinterModel, stableLoadedMaterialSource]
  )
  const materialOptions = useMemo(
    () => buildSliceMaterialOptions(compatibleFilamentProfiles, loadedMaterialOptions),
    [compatibleFilamentProfiles, loadedMaterialOptions]
  )
  useEffect(() => {
    if (!lockedPreferredPrinter) return
    if (targetMode !== 'realPrinter') setTargetMode('realPrinter')
    if (printerId !== lockedPreferredPrinter.id) setPrinterId(lockedPreferredPrinter.id)
  }, [lockedPreferredPrinter, printerId, targetMode])
  useEffect(() => {
    const fallbackTargetId = capabilities?.defaultTargetId ?? slicerTargets[0]?.id ?? ''
    if (!fallbackTargetId) {
      if (selectedSlicerTargetId) setSelectedSlicerTargetId('')
      return
    }
    if (slicerTargets.some((target) => target.id === selectedSlicerTargetId)) return
    setSelectedSlicerTargetId(fallbackTargetId)
  }, [capabilities?.defaultTargetId, selectedSlicerTargetId, slicerTargets])
  useEffect(() => {
    appliedBakedDefaultsRef.current = false
    setBakedDefaultsApplied(false)
    manualPrinterModelTouchedRef.current = false
    processProfileSelectionTouchedRef.current = false
  }, [selectedSlicerTargetId])
  useEffect(() => {
    if (targetMode !== 'realPrinter') return
    const matchedProfile = pickMachineProfileForPrinter(selectableMachineProfiles, selectedPrinter)
    if (matchedProfile) setPrinterProfileId(matchedProfile.id)
  }, [selectableMachineProfiles, selectedPrinter, targetMode])
  useEffect(() => {
    const firstProfile = selectableMachineProfiles[0]
    if (printerProfileId && selectableMachineProfiles.some((profile) => profile.id === printerProfileId)) return
    if (!firstProfile) return
    setPrinterProfileId(firstProfile.id)
  }, [printerProfileId, selectableMachineProfiles])
  useEffect(() => {
    const firstProfile = compatibleProcessProfiles[0]
    if (processProfileId && compatibleProcessProfiles.some((profile) => profile.id === processProfileId)) return
    if (!processProfileId && processProfileSelectionTouchedRef.current) return
    const previousName = selectedAnyProcessProfile?.name ?? bakedIndex?.processProfileName ?? null
    // Mirror BambuStudio's machine-switch fallback: prefer the target machine's
    // default_print_profile when it shares the previous profile's layer height,
    // otherwise keep the closest layer-height match by name.
    const machineDefaultProfile = pickSlicingProfileByBakedName(compatibleProcessProfiles, selectedMachineProfile?.defaultProcessProfile)
    const previousLayerHeight = extractLayerHeightToken(previousName)
    if (machineDefaultProfile && (!previousLayerHeight || extractLayerHeightToken(machineDefaultProfile.name) === previousLayerHeight)) {
      setProcessProfileId(machineDefaultProfile.id)
      return
    }
    // Only match a "nearest" preset when there's an actual prior profile to match; for a
    // fresh selection (new project, no baked/previous profile) skip it so we don't latch
    // onto an arbitrary preset.
    const nearestProfile = previousName ? pickMostSimilarSlicingProfileByName(compatibleProcessProfiles, previousName) : null
    if (nearestProfile) {
      setProcessProfileId(nearestProfile.id)
      return
    }
    if (machineDefaultProfile) {
      setProcessProfileId(machineDefaultProfile.id)
      return
    }
    // Prefer the 0.20mm Standard preset over whatever happens to be first in the list.
    const standardProfile = pickStandardProcessProfile(compatibleProcessProfiles)
    if (standardProfile) {
      setProcessProfileId(standardProfile.id)
      return
    }
    if (!firstProfile) return
    setProcessProfileId(firstProfile.id)
  }, [bakedIndex?.processProfileName, compatibleProcessProfiles, processProfileId, selectedAnyProcessProfile?.name, selectedMachineProfile?.defaultProcessProfile])
  useEffect(() => {
    if (plateTypeOptions.includes(plateType)) return
    setPlateType(plateTypeOptions[0] ?? '')
  }, [plateType, plateTypeOptions])
  useEffect(() => {
    if (nozzleDiameterOptions.includes(nozzleDiameter)) return
    setNozzleDiameter(nozzleDiameterOptions[0] ?? '')
  }, [nozzleDiameter, nozzleDiameterOptions])
  useEffect(() => {
    if (manualPrinterModel !== 'unknown' || targetMode !== 'manualProfile') return
    const firstModel = ensurePrinterModelOptions(file.compatiblePrinterModels, selectedPrinter?.model, machineProfiles)[0]
    if (firstModel) setManualPrinterModel(firstModel)
  }, [file.compatiblePrinterModels, machineProfiles, manualPrinterModel, selectedPrinter?.model, targetMode])
  useEffect(() => {
    if (!bakedIndex || appliedBakedDefaultsRef.current || waitingForSlicingProfiles) return
    const preserveManualPrinterSelection = targetMode === 'manualProfile' && manualPrinterModelTouchedRef.current
    if (!preserveManualPrinterSelection && bakedIndex.compatiblePrinterModels[0]) setManualPrinterModel(bakedIndex.compatiblePrinterModels[0])
    const bakedPrinterProfile = pickSelectableSlicingProfileByName(machineProfiles, bakedIndex.printerProfileName)
      ?? pickMachineProfileByName(machineProfiles.filter(isSelectableSlicingProfile), bakedIndex.printerProfileName, bakedIndex.compatiblePrinterModels[0] ?? 'unknown')
    if (!preserveManualPrinterSelection && bakedPrinterProfile) setPrinterProfileId(bakedPrinterProfile.id)
    // Prefer the 3MF-embedded process profile over an identically-named installed
    // preset so the project's saved overrides (e.g. wall_loops) survive instead of
    // collapsing to the preset's defaults. Falls back to the installed preset when
    // the project carries no embedded process profile.
    const bakedProcessProfile = pickProjectFallbackSlicingProfileByName(processProfiles, bakedIndex.processProfileName)
      ?? pickSelectableSlicingProfileByName(processProfiles, bakedIndex.processProfileName)
    if (!preserveManualPrinterSelection && bakedProcessProfile) setProcessProfileId(bakedProcessProfile.id)
    setPlateType(resolveInitialPlateType(file, bakedIndex))
    setNozzleDiameter(resolveInitialNozzleDiameter(file, selectedPrinter, bakedPrinterProfile, bakedIndex))
    setFilamentMaterialOptionIds(buildInitialFilamentMaterialOptionSelection(file, bakedIndex, filamentProfiles, selectedMachineProfile))
    setFilamentColors(buildInitialFilamentColorSelection(file, bakedIndex))
    appliedBakedDefaultsRef.current = true
    setBakedDefaultsApplied(true)
  }, [bakedIndex, file, filamentProfiles, machineProfiles, processProfiles, selectedPrinter, targetMode, waitingForSlicingProfiles])
  useEffect(() => {
    setFilamentMaterialOptionIds((current) => {
      const defaults = buildInitialFilamentMaterialOptionSelection(file, bakedIndex, compatibleFilamentProfiles, selectedMachineProfile)
      const next: Record<number, string> = { ...defaults }
      // Preserve the user's current selection only while it still resolves to a
      // compatible material option; otherwise keep the default so a cross-model
      // machine switch lands on the target machine's default filament.
      for (const [filamentId, optionId] of Object.entries(current)) {
        if (optionId && materialOptions.some((option) => option.id === optionId)) next[Number(filamentId)] = optionId
      }
      return next
    })
  }, [bakedIndex, compatibleFilamentProfiles, file, materialOptions, selectedMachineProfile])
  useEffect(() => {
    setFilamentColors((current) => ({ ...buildInitialFilamentColorSelection(file, bakedIndex), ...current }))
  }, [bakedIndex, file])
  useEffect(() => {
    setFilamentToolheadIds((current) => ({ ...buildInitialFilamentToolheadSelection(file, bakedIndex), ...current }))
  }, [bakedIndex, file])
  useEffect(() => {
    if (!requiresSinglePlate || plateMode === 'single') return
    setPlateMode('single')
  }, [plateMode, requiresSinglePlate])
  useEffect(() => {
    if (plateMode !== 'single' || slicePlateOptions.length === 0) return
    if (slicePlateOptions.some((plate) => String(plate.index) === plateNumber)) return
    const firstPlate = slicePlateOptions[0]
    if (firstPlate) setPlateNumber(String(firstPlate.index))
  }, [plateMode, plateNumber, slicePlateOptions])
  const selectedPlate = !requiresSinglePlate && plateMode === 'all' ? 0 : Number.parseInt(plateNumber, 10)
  const selectedPlateOption = useMemo(
    () => slicePlateOptions.find((plate) => plate.index === selectedPlate) ?? null,
    [selectedPlate, slicePlateOptions]
  )
  const plateObjects = useMemo(() => selectedPlateOption?.objects ?? [], [selectedPlateOption])
  const plateObjectIdsKey = useMemo(() => plateObjects.map((object) => object.id).join(','), [plateObjects])
  // Reset the selection to "all objects" whenever the active plate's object set changes. Keyed on
  // the id string (not the array) so a same-object refetch does not discard the user's deselections.
  useEffect(() => {
    setSelectedSliceObjectIds(new Set(plateObjectIdsKey ? plateObjectIdsKey.split(',').map(Number) : []))
  }, [plateObjectIdsKey])
  // Per-object print selection + overrides are managed in the per-object dialog (a single plate's
  // objects). Available whenever the targeted plate has objects.
  const hasPlateObjects = selectedPlate > 0 && plateObjects.length > 0
  const toggleSliceObject = (id: number) => setSelectedSliceObjectIds((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  // Only narrow the slice when a strict subset is kept; otherwise let the slicer take every object.
  const submitSelectedObjectIds = hasPlateObjects && selectedSliceObjectIds.size < plateObjects.length
    ? plateObjects.filter((object) => selectedSliceObjectIds.has(object.id)).map((object) => object.id)
    : undefined
  const objectOverrideCount = useMemo(
    () => Object.values(objectProcessOverrides).filter((overrides) => Object.keys(overrides).length > 0).length,
    [objectProcessOverrides]
  )
  const submitObjectProcessOverrides = useMemo(() => {
    const entries = Object.entries(objectProcessOverrides).filter(([, overrides]) => Object.keys(overrides).length > 0)
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  }, [objectProcessOverrides])
  const baseProjectFilaments = useMemo(
    () => buildSliceDialogProjectFilaments(file, bakedIndex, selectedPlate),
    [bakedIndex, file, selectedPlate]
  )
  // Add/remove materials overlay (Bambu-style, editor only). `removedFilamentIds`
  // drops base filaments; `addedFilaments` appends new slots (each seeded — see
  // handleAddFilament — from the first material so it has a valid profile). The
  // resulting list bakes into the saved/sliced 3MF via `desiredFilaments`.
  const [removedFilamentIds, setRemovedFilamentIds] = useState<Set<number>>(() => new Set())
  // Slots whose material PROFILE the user explicitly changed (via the dropdown or the loaded-material
  // picker). A profile change writes a new `filament_settings_id`, but unlike a recolor it isn't
  // detectable by comparing values (the baked short name "Bambu PLA Basic" never equals the resolved
  // full preset "Bambu PLA Basic @BBL H2D 0.4 nozzle"), so we track the explicit edits instead. Drives
  // `desiredFilaments` so the choice persists into the saved 3MF. (Programmatic default application
  // sets the option ids directly, not through `handleMaterialOptionChange`, so it never flags here.)
  const [profileEditedFilamentIds, setProfileEditedFilamentIds] = useState<Set<number>>(() => new Set())
  const [addedFilaments, setAddedFilaments] = useState<Array<{ projectFilamentId: number; label: string; color: string | null; nozzleId: number | null; usedOnSelectedPlate: boolean }>>([])
  // 0-based source filament each added slot clones its slicer settings from.
  const [addedFilamentSourceIndex, setAddedFilamentSourceIndex] = useState<Record<number, number>>({})
  const addedFilamentIds = useMemo(() => new Set(addedFilaments.map((entry) => entry.projectFilamentId)), [addedFilaments])
  const projectFilaments = useMemo(
    () => [
      ...baseProjectFilaments.filter((filament) => !removedFilamentIds.has(filament.projectFilamentId)),
      ...addedFilaments
    ],
    [baseProjectFilaments, removedFilamentIds, addedFilaments]
  )
  // The print/slice dialog targets one plate, so it lists, validates, and maps only
  // the materials that plate actually uses — a project can carry materials for other
  // plates, and surfacing them all here just invites mis-mapping. `desiredFilaments`
  // still rewrites the full ordered set so other plates are never dropped.
  const visibleProjectFilaments = useMemo(
    () => projectFilaments.filter((filament) => filament.usedOnSelectedPlate),
    [projectFilaments]
  )
  const filamentCountChanged = removedFilamentIds.size > 0 || addedFilaments.length > 0
  // A material PROFILE change (e.g. PLA -> PETG) must persist its new `filament_settings_id`,
  // otherwise the saved 3MF keeps the old preset and reopens as the previous material.
  const filamentProfilesChanged = profileEditedFilamentIds.size > 0
  // A recolor (without add/remove) must also persist: otherwise a saved 3MF keeps the old
  // filament_colour even though the live preview/thumbnail shows the new colour.
  const filamentColorsChanged = useMemo(
    () => baseProjectFilaments.some((filament) => {
      const id = filament.projectFilamentId
      const current = filamentColors[id]
      return current != null && normalizeSliceFilamentColor(current) !== normalizeSliceFilamentColor(filament.color ?? '#FFFFFF')
    }),
    [baseProjectFilaments, filamentColors]
  )
  const sliceToolheads = buildSliceDialogToolheads(nozzleDiameter, nozzleFlow, targetMode === 'realPrinter' ? selectedPrinterStatus : undefined, selectedPrinterModel)
  const materialToolheadOptions = sliceToolheads.length > 1 ? sliceToolheads : []
  const missingFilamentProfile = visibleProjectFilaments.some((filament) => !filamentMaterialOptionIds[filament.projectFilamentId])
  const missingFilamentToolhead = materialToolheadOptions.length > 0 && visibleProjectFilaments.some((filament) => !filamentToolheadIds[filament.projectFilamentId])
  // The full ordered filament list to bake into the saved/sliced 3MF — only when the
  // user changed the material count (recolor-only keeps the existing slice-time path,
  // so unchanged projects never rewrite project_settings.config). `sourceIndex` tells
  // the writer which original filament to clone slicer settings from for each slot.
  const desiredFilaments = useMemo<SceneEditFilament[] | null>(() => {
    if (!filamentCountChanged && !filamentColorsChanged && !filamentProfilesChanged) return null
    return projectFilaments.map((filament) => {
      const isAdded = addedFilamentIds.has(filament.projectFilamentId)
      const sourceIndex = isAdded
        ? (addedFilamentSourceIndex[filament.projectFilamentId] ?? 0)
        : baseProjectFilaments.findIndex((base) => base.projectFilamentId === filament.projectFilamentId)
      const selectedOption = materialOptions.find((option) => option.id === filamentMaterialOptionIds[filament.projectFilamentId]) ?? null
      return {
        color: normalizeSliceFilamentColor(filamentColors[filament.projectFilamentId] ?? filament.color ?? '#FFFFFF'),
        type: selectedOption?.materialType ?? (isAdded ? 'PLA' : null),
        // The selected preset name (e.g. "Bambu PETG HF @BBL H2D 0.4 nozzle") so the material
        // choice persists as `filament_settings_id`. Null keeps the slot's existing preset.
        settingsId: selectedOption?.material ?? null,
        sourceIndex: sourceIndex >= 0 ? sourceIndex : 0
      }
    })
  }, [filamentCountChanged, filamentColorsChanged, filamentProfilesChanged, projectFilaments, addedFilamentIds, addedFilamentSourceIndex, baseProjectFilaments, materialOptions, filamentMaterialOptionIds, filamentColors])
  const handleAddFilament = useCallback(() => {
    const template = projectFilaments[0] ?? null
    const templateId = template?.projectFilamentId ?? null
    setAddedFilaments((current) => {
      const maxId = Math.max(0, ...baseProjectFilaments.map((entry) => entry.projectFilamentId), ...current.map((entry) => entry.projectFilamentId))
      const newId = maxId + 1
      // Seed the new slot's profile/color/toolhead from the first material so it is
      // immediately sliceable (BambuStudio needs a valid filament profile per slot).
      if (templateId != null) {
        setFilamentMaterialOptionIds((prev) => ({ ...prev, [newId]: prev[templateId] ?? '' }))
        setFilamentColors((prev) => ({ ...prev, [newId]: prev[templateId] ?? normalizeSliceFilamentColor(template?.color ?? '#FFFFFF') }))
        setFilamentToolheadIds((prev) => ({ ...prev, [newId]: prev[templateId] ?? '' }))
      }
      setAddedFilamentSourceIndex((prev) => ({ ...prev, [newId]: 0 }))
      return [...current, {
        projectFilamentId: newId,
        label: template?.label ?? 'PLA',
        color: template?.color ?? '#FFFFFF',
        nozzleId: template?.nozzleId ?? null,
        usedOnSelectedPlate: true
      }]
    })
  }, [projectFilaments, baseProjectFilaments])
  const handleRemoveFilament = useCallback((projectFilamentId: number) => {
    setAddedFilaments((current) => current.filter((entry) => entry.projectFilamentId !== projectFilamentId))
    setAddedFilamentSourceIndex((current) => {
      if (!(projectFilamentId in current)) return current
      const next = { ...current }
      delete next[projectFilamentId]
      return next
    })
    setRemovedFilamentIds((current) => {
      if (!baseProjectFilaments.some((base) => base.projectFilamentId === projectFilamentId)) return current
      const next = new Set(current)
      next.add(projectFilamentId)
      return next
    })
  }, [baseProjectFilaments])
  // Material state is immutably updated, so capturing references gives a valid snapshot
  // the editor's undo/redo can restore (removedFilamentIds copied to an array + rebuilt).
  const materialsSnapshot = useMemo<SliceMaterialsSnapshot>(() => ({
    removedFilamentIds: [...removedFilamentIds],
    profileEditedFilamentIds: [...profileEditedFilamentIds],
    addedFilaments,
    addedFilamentSourceIndex,
    filamentColors,
    filamentMaterialOptionIds,
    filamentToolheadIds,
    filamentMaterialTypeFilters,
    objectProcessOverrides
  }), [removedFilamentIds, profileEditedFilamentIds, addedFilaments, addedFilamentSourceIndex, filamentColors, filamentMaterialOptionIds, filamentToolheadIds, filamentMaterialTypeFilters, objectProcessOverrides])
  const restoreMaterials = useCallback((snapshot: SliceMaterialsSnapshot) => {
    setRemovedFilamentIds(new Set(snapshot.removedFilamentIds))
    setProfileEditedFilamentIds(new Set(snapshot.profileEditedFilamentIds ?? []))
    setAddedFilaments(snapshot.addedFilaments)
    setAddedFilamentSourceIndex(snapshot.addedFilamentSourceIndex)
    setFilamentColors(snapshot.filamentColors)
    setFilamentMaterialOptionIds(snapshot.filamentMaterialOptionIds)
    setFilamentToolheadIds(snapshot.filamentToolheadIds)
    setFilamentMaterialTypeFilters(snapshot.filamentMaterialTypeFilters)
    setObjectProcessOverrides(snapshot.objectProcessOverrides ?? {})
  }, [])
  const suggestedOutputFileName = useMemo(() => {
    if (!requiresSinglePlate && plateMode !== 'single') return buildSlicedOutputFileName(file.name)
    return buildSlicedOutputFileName(file.name, {
      plateName: selectedPlateOption?.name ?? null,
      plateNumber: Number.isInteger(selectedPlate) && selectedPlate > 0 ? selectedPlate : null
    })
  }, [file.name, plateMode, requiresSinglePlate, selectedPlate, selectedPlateOption?.name])
  const legacyMachineSwitchWarning = useMemo(
    () => buildLegacyMachineSwitchWarning({
      sourcePrinterModel,
      targetPrinterModel,
      slicerTarget: selectedSlicerTarget
    }),
    [selectedSlicerTarget, sourcePrinterModel, targetPrinterModel]
  )
  // The configuration form should not become interactive until the slicer capabilities, profiles,
  // and 3MF plate data have loaded and the embedded defaults are seeded — otherwise the user sees
  // values populate and change underneath them.
  const slicerDataReady = configured
    && !waitingForSlicingProfiles
    && !slicingProfilesQuery.isLoading
    && !platesQuery.isLoading
    && (!platesQuery.data || bakedDefaultsApplied)

  const canSubmit = Boolean(configured)
    && selectedSlicerTargetId.length > 0
    && suggestedOutputFileName.trim().length > 0
    && printerProfileId.length > 0
    && processProfileId.length > 0
    && selectedNozzleDiameters.length > 0
    && !missingFilamentProfile
    && !missingFilamentToolhead
    && !legacyMachineSwitchWarning
    && (Boolean(sceneEdit) || (!requiresSinglePlate && plateMode === 'all') || (Number.isInteger(selectedPlate) && selectedPlate > 0))
    && (Boolean(sceneEdit) || !hasPlateObjects || selectedSliceObjectIds.size > 0)
    && (targetMode === 'realPrinter' ? printerId.length > 0 : true)
    && !submitting

  // Show the Bambu "*" marker when the process diverges from its preset: explicit session
  // overrides, or a project profile that carries the 3MF's (typically modified) embedded config.
  const processProfileModified = Object.keys(processSettingOverrides).length > 0
    || (selectedProcessProfile != null && isProjectSlicingProfile(selectedProcessProfile))

  const buildSubmitInput = (options?: { outputFileName?: string; outputFolderId?: string | null }): SliceFileSubmitInput => ({
    slicerTargetId: selectedSlicerTargetId,
    outputFileName: (options?.outputFileName ?? suggestedOutputFileName).trim(),
    outputFolderId: options?.outputFolderId ?? null,
    // With a custom layout the edit defines the plates; honor the editor's chosen
    // plate scope (a 1-based index, or 0 for all). Without an edit, use the slim
    // dialog's plate selection.
    plate: sceneEdit ? (editorPlatePreference ?? 0) : selectedPlate,
    sceneEdit: sceneEdit ?? undefined,
    selectedObjectIds: sceneEdit ? undefined : submitSelectedObjectIds,
    objectProcessOverrides: submitObjectProcessOverrides,
    target: targetMode === 'realPrinter'
      ? {
          mode: 'realPrinter',
          printerId,
          printerProfileId,
          plateType,
          nozzleDiameters: selectedNozzleDiameters,
          toolheads: sliceToolheads,
          processProfileId,
          processSettingOverrides: Object.keys(processSettingOverrides).length > 0 ? processSettingOverrides : undefined,
          filamentMappings: buildFilamentMappings(visibleProjectFilaments, filamentMaterialOptionIds, filamentColors, filamentToolheadIds, materialOptions)
        }
      : {
          mode: 'manualProfile',
          printerProfileId,
          printerModel: manualPrinterModel,
          plateType,
          nozzleDiameters: selectedNozzleDiameters,
          toolheads: sliceToolheads,
          processProfileId,
          processSettingOverrides: Object.keys(processSettingOverrides).length > 0 ? processSettingOverrides : undefined,
          filamentMappings: buildFilamentMappings(visibleProjectFilaments, filamentMaterialOptionIds, filamentColors, filamentToolheadIds, materialOptions)
        }
  })

  const submit = (action: SliceFileSubmitAction, options?: { outputFileName?: string; outputFolderId?: string | null }) => {
    if (!canSubmit) return
    const input = buildSubmitInput(options)
    if (input.outputFileName.length === 0) return
    onSubmit(input, action)
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!saveActionVisible) {
      submit('print')
    }
  }

  const printerModelOptions = ensurePrinterModelOptions(file.compatiblePrinterModels, selectedPrinter?.model, machineProfiles)
  const selectedPrinterMaterialPickerFilament = projectFilaments.find((filament) => filament.projectFilamentId === printerMaterialPickerFilamentId) ?? null
  const selectedPrinterMaterialPickerOptions = selectedPrinterMaterialPickerFilament
    ? prioritizeLoadedMaterialOptionsForFilament(loadedMaterialOptions, selectedPrinterMaterialPickerFilament.nozzleId ?? null)
    : []
  const groupedSelectedPrinterMaterialPickerOptions = groupSliceMaterialOptionsByGroup(selectedPrinterMaterialPickerOptions)
  // Maps a loaded option's trayId back to its tray so the picker can show how much
  // filament that tray has left (only for RFID/Bambu spools that report it).
  const printerTrayMap = useMemo(() => buildPrinterTrayMap(selectedPrinterStatus), [selectedPrinterStatus])
  const handleMaterialOptionChange = (projectFilamentId: number, option: SliceMaterialOption | null) => {
    setFilamentMaterialOptionIds((current) => ({ ...current, [projectFilamentId]: option?.id ?? '' }))
    setProfileEditedFilamentIds((current) => current.has(projectFilamentId) ? current : new Set(current).add(projectFilamentId))
    if (option) {
      setFilamentMaterialTypeFilters((current) => ({ ...current, [projectFilamentId]: option.materialType }))
    }
    if (option?.color) {
      setFilamentColors((current) => ({ ...current, [projectFilamentId]: option.color ?? current[projectFilamentId] ?? '' }))
    }
    if (option?.toolheadId) {
      setFilamentToolheadIds((current) => ({ ...current, [projectFilamentId]: option.toolheadId ?? current[projectFilamentId] ?? '' }))
    }
    // Notify the editor (if any) so a pick from its picker Modal flips the unsaved-changes flag.
    materialEditListenerRef.current?.()
  }

  // Manual-profile target for the editor's "save as a different printer" flow. Only built when
  // the selected machine is cross-model with the project's source, so saving a same-model project
  // never round-trips the slicer. Always a manualProfile shape (the slicer only needs the target
  // machine to switch to); printerModel resolves a real printer's model or the manual selection.
  const retargetTarget: SlicingManualProfileTarget | null = (
    printerProfileId.length > 0
    && processProfileId.length > 0
    && Boolean(sourcePrinterModel) && Boolean(targetPrinterModel)
    && sourcePrinterModel !== targetPrinterModel
  )
    ? {
        mode: 'manualProfile',
        printerProfileId,
        printerModel: selectedPrinterModel,
        plateType,
        nozzleDiameters: selectedNozzleDiameters,
        toolheads: sliceToolheads,
        processProfileId,
        processSettingOverrides: Object.keys(processSettingOverrides).length > 0 ? processSettingOverrides : undefined,
        filamentMappings: buildFilamentMappings(visibleProjectFilaments, filamentMaterialOptionIds, filamentColors, filamentToolheadIds, materialOptions)
      }
    : null

  // The shared settings surface for both the slim dialog and the 3D editor's
  // Settings tab. State stays here (single source of truth); the controller is
  // the bridge. See SliceSettingsController.
  const sliceController: SliceSettingsController = {
    file, resourceBasePath, flow, requiresSinglePlate, canOpenThreeDimensionalPreview, isMobileViewport,
    tenantSlug, navigate, onClose,
    slicerTargets, selectedSlicerTargetId, setSelectedSlicerTargetId, legacyMachineSwitchWarning,
    slicerStatus: {
      capabilitiesLoading,
      hasCapabilities: capabilities != null,
      capabilitiesError,
      configured,
      slicerDataReady,
      profilesError: slicingProfilesQuery.isError
        ? (slicingProfilesQuery.error instanceof Error ? slicingProfilesQuery.error.message : 'Failed to load slicer profiles for this version.')
        : null
    },
    printers, selectedPrinter, lockedPreferredPrinter, targetMode, setTargetMode, setPrinterId,
    selectedPrinterModel, manualPrinterModelTouchedRef, setManualPrinterModel, printerModelOptions,
    nozzleDiameter, setNozzleDiameter, nozzleDiameterOptions, nozzleFlow, setNozzleFlow,
    plateType, setPlateType, plateTypeOptions,
    plateMode, setPlateMode, sceneEdit, setSceneEdit, plateNumber, setPlateNumber, slicePlateOptions, setPreviewFileId,
    compatibleProcessProfiles, selectedProcessProfile, processProfileModified, setProcessProfileId, setProcessSettingOverrides,
    processProfileSelectionTouchedRef, selectedSlicerTargetIdForGuards: selectedSlicerTargetId, processSettingOverrides, setProcessSettingsDialogOpen,
    hasPlateObjects, objectOverrideCount, setPerObjectDialogOpen, selectedSliceObjectIds, plateObjects,
    perObjectSettings: selectedProcessProfile ? {
      slicerTargetId: selectedSlicerTargetId,
      processProfileId: selectedProcessProfile.id,
      sourceFileId: file.id,
      globalOverrides: processSettingOverrides,
      visibilityContext: { printerModel: targetMode === 'manualProfile' ? manualPrinterModel : (selectedPrinter?.model ?? '') },
      value: objectProcessOverrides,
      onChange: setObjectProcessOverrides,
      printSelection: selectedSliceObjectIds,
      onTogglePrint: toggleSliceObject
    } : null,
    usedFilamentIdsForPlate: (plateIndex: number) => new Set(bakedIndex?.plates.find((plate) => plate.index === plateIndex)?.filaments.map((filament) => filament.id) ?? []),
    projectFilaments: visibleProjectFilaments, materialOptions, loadedMaterialOptions, materialToolheadOptions,
    filamentMaterialOptionIds, filamentMaterialTypeFilters, setFilamentMaterialTypeFilters,
    filamentToolheadIds, setFilamentToolheadIds, filamentColors, setFilamentColors,
    setPrinterMaterialPickerFilamentId, handleMaterialOptionChange,
    desiredFilaments, retargetTarget, onAddFilament: handleAddFilament, onRemoveFilament: handleRemoveFilament,
    materialsSnapshot, restoreMaterials, materialEditListenerRef
  }

  // The editor owns geometry; the slice is otherwise valid when printer/process/
  // filament settings are complete. (Plate/object-selection clauses are excluded —
  // the editor expresses plate scope via its own action.)
  const canSliceFromEditor = Boolean(configured)
    && selectedSlicerTargetId.length > 0
    && printerProfileId.length > 0
    && processProfileId.length > 0
    && selectedNozzleDiameters.length > 0
    && !missingFilamentProfile
    && !missingFilamentToolhead
    && !legacyMachineSwitchWarning
    && (targetMode === 'realPrinter' ? printerId.length > 0 : true)
    && !submitting

  // Human-readable explanation for a disabled Slice button so the editor never just greys it
  // out "for unknown reasons". See resolveSliceDisabledReason for the clause ordering.
  const sliceDisabledReason = resolveSliceDisabledReason({
    canSlice: canSliceFromEditor,
    configured: Boolean(configured),
    selectedSlicerTargetId,
    profilesError: slicingProfilesQuery.isError
      ? (slicingProfilesQuery.error instanceof Error ? slicingProfilesQuery.error.message : 'Slicer profiles failed to load.')
      : null,
    slicerDataReady,
    printerProfileId,
    processProfileId,
    nozzleDiameterCount: selectedNozzleDiameters.length,
    missingFilamentProfile,
    missingFilamentToolhead,
    legacyMachineSwitchWarning,
    targetMode,
    printerId,
    submitting
  })

  // Slice a single plate from the 3D editor without persisting a project: produces a
  // hidden gcode + slicing stats and opens the results dialog (which can save/print).
  const handleEditorSlice = (opts: { plate: number; sceneEdit: SceneEdit }) => {
    if (!canSliceFromEditor) return
    setSceneEdit(opts.sceneEdit)
    setEditorPlatePreference(opts.plate)
    // Name the output from the scope actually being sliced — `suggestedOutputFileName`
    // tracks the editor's per-object plate selection (always a single plate), so a
    // whole-project slice (plate 0) would otherwise wrongly get a "Plate 1" suffix.
    const slicedPlate = opts.plate > 0 ? opts.sceneEdit.plates.find((plate) => plate.index === opts.plate) : null
    const outputFileName = buildSlicedOutputFileName(
      file.name,
      opts.plate > 0 ? { plateName: slicedPlate?.name ?? null, plateNumber: opts.plate } : undefined
    )
    const input: SliceFileSubmitInput = {
      ...buildSubmitInput({ outputFileName }),
      plate: opts.plate,
      sceneEdit: opts.sceneEdit,
      selectedObjectIds: undefined,
      // Land the (initially hidden) gcode next to the source project, so "Save to
      // library" only has to reveal it.
      outputFolderId: file.folderId ?? null
    }
    onSubmit(input, 'slice', { keepDialogOpen: true })
  }

  // Context handed to the 3D editor (the "full slicer"). Shared by the slim
  // dialog's "Open full editor" button and the direct-open path below.
  const editorSlotContext = {
    fileId: file.id,
    baseVersionId: versionId ?? null,
    isNewProject,
    // The library context the new file should default into when saved (so the save dialog can
    // browse folders and the save lands on the right bridge).
    bridgeId,
    folderId: currentFolderId,
    currentEdit: sceneEdit,
    onApply: setSceneEdit,
    onSlice: handleEditorSlice,
    canSlice: canSliceFromEditor,
    sliceDisabledReason,
    slicing: submitting && (submitAction === 'print' || submitAction === 'slice'),
    sliceConfig: sliceController,
    initialPlateIndex: Number.parseInt(plateNumber, 10),
    targetPrinterModel,
    objectOverrideCount,
    hasPlateObjects,
    canEditSettings: Boolean(selectedProcessProfile && selectedSlicerTargetId),
    onEditObjectSettings: () => setPerObjectDialogOpen(true),
    onClose
  }
  // Simple mode is gone for the library flow: slicing opens the full 3D editor
  // directly. The print-prep flow (a file targeted at one printer) keeps the slim
  // dialog. The editor handles its own plate loading/errors.
  const editorOnly = flow === 'library' && file.kind === '3mf'

  return (
    <>
      {editorOnly ? (
        <PluginSlot name="slicing.editor" context={{ ...editorSlotContext, autoOpen: true }} />
      ) : (
      <Modal open onClose={onClose}>
        <ScrollableModalDialog sx={{ maxWidth: 560, width: '100%' }}>
          <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Typography level="h4">{dialogTitle}</Typography>
            <ScrollableDialogBody sx={{ mt: 1 }}>
              <Stack spacing={1.25}>
                {dialogDescription && (
                  <Typography level="body-sm" textColor="text.tertiary">
                    {dialogDescription}
                  </Typography>
                )}
              {/* The panel renders its own slicer availability/loading notices. */}
              <SliceSettingsPanel controller={sliceController} mode="simple" />
              {(!saveDestinationOpen || submitAction !== 'save') && submitError && <Typography level="body-sm" color="danger">{submitError}</Typography>}
            </Stack>
          </ScrollableDialogBody>
          <DialogActions sx={{ pt: 1 }}>
            <Button type="button" variant="plain" onClick={onClose}>{flow === 'print' ? 'Cancel' : 'Close'}</Button>
            {saveActionVisible && (
              <Button
                type="button"
                variant="outlined"
                loading={submitting && submitAction === 'save'}
                disabled={!canSubmit || submitting}
                startDecorator={<ContentCutRoundedIcon />}
                onClick={() => setSaveDestinationOpen(true)}
              >
                {saveActionLabel}
              </Button>
            )}
            <Button
              type="button"
              loading={submitting && submitAction === 'print'}
              disabled={!canSubmit || submitting}
              startDecorator={<PrintRoundedIcon />}
              onClick={() => submit('print')}
            >
              {printActionLabel}
            </Button>
          </DialogActions>
          </Box>
        </ScrollableModalDialog>
      </Modal>
      )}
      {/* Per-object + process settings dialogs live at the top level so they stack
          above the editor in editor-only mode (and above the slim dialog otherwise). */}
      {perObjectDialogOpen && selectedProcessProfile && (
        <Suspense fallback={null}>
          <PerObjectSettingsDialog
            open={perObjectDialogOpen}
            onClose={() => setPerObjectDialogOpen(false)}
            objects={plateObjects}
            slicerTargetId={selectedSlicerTargetId}
            processProfileId={selectedProcessProfile.id}
            processProfileName={selectedProcessProfile.name}
            sourceFileId={file.id}
            globalOverrides={processSettingOverrides}
            visibilityContext={{ printerModel: targetMode === 'manualProfile' ? manualPrinterModel : (selectedPrinter?.model ?? '') }}
            value={objectProcessOverrides}
            onChange={setObjectProcessOverrides}
            printSelection={selectedSliceObjectIds}
            onTogglePrint={toggleSliceObject}
            applyScope={editorOnly ? 'project' : 'slice'}
          />
        </Suspense>
      )}
      {processSettingsDialogOpen && selectedProcessProfile && (
        <Suspense fallback={null}>
          <ProcessSettingsDialog
            open={processSettingsDialogOpen}
            onClose={() => setProcessSettingsDialogOpen(false)}
            slicerTargetId={selectedSlicerTargetId}
            processProfileId={selectedProcessProfile.id}
            processProfileName={selectedProcessProfile.name}
            sourceFileId={file.id}
            initialOverrides={processSettingOverrides}
            visibilityContext={{ printerModel: targetMode === 'manualProfile' ? manualPrinterModel : (selectedPrinter?.model ?? '') }}
            profileOptions={compatibleProcessProfiles.map((profile) => ({ id: profile.id, name: formatSlicingProfileDisplayName(profile) }))}
            applyScope={editorOnly ? 'project' : 'slice'}
            onProfileChange={(profileId, carryOverrides) => {
              processProfileSelectionTouchedRef.current = true
              setProcessProfileId(profileId)
              setProcessSettingOverrides(carryOverrides)
            }}
            onApply={(overrides) => setProcessSettingOverrides(overrides)}
          />
        </Suspense>
      )}
      {saveActionVisible && saveDestinationOpen && (
        <LibraryDestinationDialog
          title="Save sliced file"
          description="Choose where to save the sliced file, then confirm the file name. Picking an existing file saves over it."
          showFiles
          fileNameField={{
            label: 'File name',
            initialValue: suggestedOutputFileName,
            extension: '.gcode.3mf'
          }}
          initialFolderId={currentFolderId}
          folders={folders}
          bridgeId={bridgeId}
          bridgeName={bridgeName}
          showRoot={showRoot}
          dialogWidth={720}
          submitting={submitting && submitAction === 'save'}
          error={submitAction === 'save' ? submitError : null}
          confirmStartDecorator={<ContentCutRoundedIcon />}
          confirmActionLabel={({ outputFolderId, rootDestinationLabel }) => outputFolderId ? 'Save here' : `Save to ${rootDestinationLabel}`}
          onClose={() => setSaveDestinationOpen(false)}
          onSubmit={({ outputFileName, outputFolderId }) => submit('save', { outputFileName: outputFileName ?? suggestedOutputFileName, outputFolderId })}
        />
      )}
      <PluginSlot
        name="library.overlays"
        context={{ previewFileId, previewPlateIndex: Number.parseInt(plateNumber, 10), onPreviewClose: () => setPreviewFileId(null) }}
      />
      <Modal open={Boolean(printerMaterialPickerFilamentId)} onClose={() => setPrinterMaterialPickerFilamentId(null)}>
        <ModalDialog size="md" sx={{ maxWidth: 480, width: '100%' }}>
          <Typography level="h4">Choose material {selectedPrinterMaterialPickerFilament ? projectFilaments.findIndex((filament) => filament.projectFilamentId === selectedPrinterMaterialPickerFilament.projectFilamentId) + 1 : ''}</Typography>
          <Stack spacing={1}>
            {selectedPrinterMaterialPickerOptions.length === 0 ? (
              <Typography level="body-sm" textColor="text.tertiary">No loaded printer materials are available for this material.</Typography>
            ) : groupedSelectedPrinterMaterialPickerOptions.map((group) => (
              <Stack key={group.label} spacing={0.5}>
                <Typography level="body-xs" textColor="text.tertiary" sx={{ fontWeight: 'lg', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{group.label}</Typography>
                {group.options.map((option) => {
                  const tray = option.trayId != null ? printerTrayMap.get(option.trayId) : undefined
                  // Only RFID/Bambu spools report a reliable remaining figure.
                  const remainGrams = tray && tray.trayUuid != null ? estimateRemainGrams(tray.remainPercent) : null
                  const remainingLabel = remainGrams != null && tray?.remainPercent != null
                    ? `${Math.round(tray.remainPercent)}% (~${remainGrams}g)`
                    : null
                  // The swatch badge already names the slot (A1/B2/Ext-L) and the group header names the
                  // nozzle, so the subtext only needs the loaded colour — no redundant "Slot N" / nozzle.
                  const subLabel = (tray ? resolveFilamentDisplay(tray).name : null) ?? tray?.filamentType ?? option.materialType
                  return (
                  <Button
                    key={option.id}
                    type="button"
                    variant="outlined"
                    color="neutral"
                    onClick={() => {
                      if (!selectedPrinterMaterialPickerFilament) return
                      handleMaterialOptionChange(selectedPrinterMaterialPickerFilament.projectFilamentId, option)
                      setPrinterMaterialPickerFilamentId(null)
                    }}
                    sx={{ justifyContent: 'flex-start', minHeight: 48 }}
                  >
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, width: '100%' }}>
                      <Box
                        sx={{
                          width: 28,
                          height: 28,
                          borderRadius: '50%',
                          background: filamentBackground(option.colors, option.color, 'var(--joy-palette-neutral-800)'),
                          color: filamentTextColor(option.colors, option.color, 'var(--joy-palette-text-primary)'),
                          border: '1px solid',
                          borderColor: 'divider',
                          flexShrink: 0,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '0.65rem',
                          fontWeight: 'lg',
                          lineHeight: 1,
                          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)'
                        }}
                      >
                        {option.slotLabel}
                      </Box>
                      <Stack spacing={0} sx={{ minWidth: 0, alignItems: 'flex-start', flex: 1 }}>
                        <Typography level="body-sm" noWrap sx={{ minWidth: 0 }}>{option.label}</Typography>
                        {subLabel && (
                          <Typography level="body-xs" textColor="text.tertiary" noWrap sx={{ minWidth: 0 }}>{subLabel}</Typography>
                        )}
                      </Stack>
                      {remainingLabel && (
                        <Chip size="sm" variant="soft" color="neutral" sx={{ ml: 1, flexShrink: 0 }}>{remainingLabel}</Chip>
                      )}
                    </Stack>
                  </Button>
                  )
                })}
              </Stack>
            ))}
          </Stack>
          <DialogActions>
            <Button type="button" variant="plain" onClick={() => setPrinterMaterialPickerFilamentId(null)}>Cancel</Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </>
  )
}

export function SliceThenPrintModal({
  sourceFile,
  jobId,
  printers,
  preferredPrinterId,
  lockPrinterSelection = false,
  submitPrint,
  onClose
}: {
  sourceFile: LibraryFile
  jobId: string
  printers: Printer[]
  preferredPrinterId?: string
  lockPrinterSelection?: boolean
  /**
   * Override the final print submission (default posts to the slicing job's
   * own print endpoint). `outputFile` is the sliced library file being
   * dispatched — e.g. the orders flow records it against the order item.
   */
  submitPrint?: (input: {
    printerId: string
    body: Omit<StartOrderPrintInput, 'printerId'>
    outputFile: LibraryFile
  }) => Promise<void>
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const slicingJobsQuery = useSlicingJobs({ suppressGlobalErrorToast: true })
  // While this dialog tracks the job, suppress its redundant global toast.
  useEffect(() => suppressJobToast('slicing', jobId), [jobId])
  const cancelSlicing = useMutation({
    mutationFn: async () => {
      await apiFetch(`/api/slicing/jobs/${jobId}/cancel`, { method: 'POST' })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['slicing-jobs'] })
    }
  })
  const job = useMemo(
    () => slicingJobsQuery.data?.jobs.find((entry) => entry.id === jobId) ?? null,
    [jobId, slicingJobsQuery.data?.jobs]
  )
  const defaultAmsMapping = useMemo(
    () => (job?.target.mode === 'realPrinter' ? buildDefaultAmsMappingFromSlicingTarget(job.target) : null),
    [job?.target]
  )
  const outputFileQuery = useQuery({
    queryKey: ['library-file', job?.outputFileId ?? 'missing'],
    queryFn: ({ signal }) => apiFetch<{ file: LibraryFile }>(`/api/library/${job?.outputFileId}`, { signal }),
    enabled: Boolean(job?.status === 'ready' && job.outputFileId)
  })

  if (job?.status === 'ready' && outputFileQuery.data?.file) {
    const outputFile = outputFileQuery.data.file
    return (
      <PrintModal
        file={outputFile}
        printers={printers}
        defaultPrinterId={job.target.mode === 'realPrinter' ? job.target.printerId : preferredPrinterId}
        lockPrinterSelection={lockPrinterSelection}
        defaultPlate={job.plate > 0 ? job.plate : 1}
        defaultAmsMapping={defaultAmsMapping}
        submitPrint={submitPrint
          ? ({ printerId, body }) => submitPrint({ printerId, body, outputFile })
          : async ({ printerId, body }) => {
            await apiFetch(`/api/slicing/jobs/${job.id}/print`, {
              method: 'POST',
              body: {
                printerId,
                ...body
              }
            })
          }}
        onClose={onClose}
      />
    )
  }

  const progressFrame = job ? getLatestSlicingProgressFrame(job) : null
  const progressPercent = progressFrame?.displayPercent ?? progressFrame?.totalPercent ?? null
  const displayName = formatLibraryFileName(job?.outputFileName ?? sourceFile.name)
  const loadingOutputFile = job?.status === 'ready' && outputFileQuery.isLoading
  const jobError = outputFileQuery.error instanceof Error
    ? outputFileQuery.error.message
    : job?.error ?? null

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 520, width: '100%' }}>
        <Typography level="h4">Print now</Typography>
        <ScrollableDialogBody sx={{ mt: 1 }}>
          <Stack spacing={1.25}>
            <Typography level="body-sm" textColor="text.tertiary">
              {job && (job.status === 'ready'
                ? 'Slicing finished. Loading the print setup…'
                : 'This stays here until slicing is ready, then it switches into the normal print setup.')}
            </Typography>

            {slicingJobsQuery.isLoading && !job && (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size="sm" />
                <Typography level="body-sm" textColor="text.secondary">Loading slicing job…</Typography>
              </Stack>
            )}

            {!slicingJobsQuery.isLoading && !job && (
              <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                The slicing job is no longer available. If it already finished, you can find it in Jobs.
              </Alert>
            )}

            {job && (
              <Sheet variant="outlined" sx={{ p: 1.25, borderRadius: 'sm' }}>
                <Stack spacing={1}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                    <Typography level="title-md" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                      {displayName}
                    </Typography>
                    <Chip size="sm" variant="soft" color={slicingStatusColor(job.status)}>
                      {getSlicingJobStatusLabel(job)}
                    </Chip>
                  </Stack>
                  <LinearProgress
                    determinate={progressPercent != null}
                    value={progressPercent ?? 0}
                    color={slicingStatusColor(job.status)}
                  />
                  <Typography level="body-sm" textColor="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                    {loadingOutputFile ? 'Loading sliced file…' : formatSlicingProgress(job, progressFrame)}
                  </Typography>
                  {jobError && (
                    <Alert color={job.status === 'cancelled' ? 'warning' : 'danger'} variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                      {jobError}
                    </Alert>
                  )}
                </Stack>
              </Sheet>
            )}
          </Stack>
        </ScrollableDialogBody>
        <DialogActions>
          <Button type="button" variant="plain" color="neutral" onClick={onClose}>Close</Button>
          {job && job.status !== 'ready' && job.status !== 'failed' && job.status !== 'cancelled' && (
            <Button
              type="button"
              variant="plain"
              color="danger"
              loading={cancelSlicing.isPending}
              onClick={() => cancelSlicing.mutate()}
            >
              Cancel slicing
            </Button>
          )}
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}

/**
 * Results dialog for a "slice without saving" run: tracks the slicing job, shows the
 * estimates (print time, filament, cost) when ready, and lets the user preview the sliced
 * toolpaths (via the model-studio plugin's `library.overlays` slot, which works on the
 * still-hidden output file), keep the gcode (un-hide it into the library) and/or print it.
 * Stays open after saving.
 */
export function SliceResultModal({
  sourceFile,
  jobId,
  printers,
  canPrint,
  folders,
  bridgeId,
  bridgeName,
  showRoot,
  onClose
}: {
  sourceFile: LibraryFile
  jobId: string
  printers: Printer[]
  canPrint: boolean
  folders: LibraryFolder[]
  bridgeId: string | null
  bridgeName: string | null
  showRoot: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const slicingJobsQuery = useSlicingJobs({ suppressGlobalErrorToast: true })
  useEffect(() => suppressJobToast('slicing', jobId), [jobId])
  const [printing, setPrinting] = useState(false)
  const [saved, setSaved] = useState(false)
  const [printed, setPrinted] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const job = useMemo(
    () => slicingJobsQuery.data?.jobs.find((entry) => entry.id === jobId) ?? null,
    [jobId, slicingJobsQuery.data?.jobs]
  )
  // Closing without saving or printing discards the still-hidden sliced output so it
  // doesn't linger forever.
  const handleClose = useCallback(() => {
    if (!saved && !printed && job?.status === 'ready' && job.outputFileId) {
      void apiFetch(`/api/slicing/jobs/${jobId}/discard`, { method: 'POST' }).catch(() => undefined)
    }
    onClose()
  }, [saved, printed, job?.status, job?.outputFileId, jobId, onClose])
  const defaultAmsMapping = useMemo(
    () => (job?.target.mode === 'realPrinter' ? buildDefaultAmsMappingFromSlicingTarget(job.target) : null),
    [job?.target]
  )
  const cancelSlicing = useMutation({
    mutationFn: async () => { await apiFetch(`/api/slicing/jobs/${jobId}/cancel`, { method: 'POST' }) },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['slicing-jobs'] }) }
  })
  const [saveDestinationOpen, setSaveDestinationOpen] = useState(false)
  const saveToLibrary = useMutation({
    mutationFn: async (vars: { outputFolderId: string | null; outputFileName?: string }) =>
      apiFetch<{ file: { id: string; name: string } }>(`/api/slicing/jobs/${jobId}/save`, { method: 'POST', body: vars }),
    onSuccess: async (response) => {
      setSaved(true)
      setSaveDestinationOpen(false)
      toast.success(`Saved ${formatLibraryFileName(response.file.name)} to the library`)
      await invalidateLibraryQueries(queryClient)
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Unable to save the sliced file.')
    }
  })
  const outputFileQuery = useQuery({
    queryKey: ['library-file', job?.outputFileId ?? 'missing'],
    queryFn: ({ signal }) => apiFetch<{ file: LibraryFile }>(`/api/library/${job?.outputFileId}`, { signal }),
    enabled: Boolean(printing && job?.status === 'ready' && job.outputFileId)
  })

  if (printing && canPrint && job?.status === 'ready' && outputFileQuery.data?.file) {
    return (
      <PrintModal
        file={outputFileQuery.data.file}
        printers={printers}
        defaultPrinterId={job.target.mode === 'realPrinter' ? job.target.printerId : undefined}
        defaultPlate={job.plate > 0 ? job.plate : 1}
        defaultAmsMapping={defaultAmsMapping}
        submitPrint={async ({ printerId, body }) => {
          await apiFetch(`/api/slicing/jobs/${job.id}/print`, { method: 'POST', body: { printerId, ...body } })
          setPrinted(true)
        }}
        onClose={() => setPrinting(false)}
      />
    )
  }

  const ready = job?.status === 'ready'
  const progressFrame = job ? getLatestSlicingProgressFrame(job) : null
  const progressPercent = progressFrame?.displayPercent ?? progressFrame?.totalPercent ?? null
  const displayName = formatLibraryFileName(job?.outputFileName ?? sourceFile.name)
  const jobError = job?.error ?? null
  const metadata = job?.metadata
  const stats: Array<{ label: string; value: string }> = []
  if (metadata?.estimatedPrintTimeSeconds != null && metadata.estimatedPrintTimeSeconds >= 1) {
    stats.push({ label: 'Estimated print time', value: formatSecondsDuration(metadata.estimatedPrintTimeSeconds) })
  }
  if (metadata?.estimatedPrepareTimeSeconds != null && metadata.estimatedPrepareTimeSeconds >= 1) {
    stats.push({ label: 'Prepare time', value: formatSecondsDuration(metadata.estimatedPrepareTimeSeconds) })
  }
  if (metadata?.estimatedFilamentWeightGrams != null) {
    stats.push({ label: 'Material used', value: `${metadata.estimatedFilamentWeightGrams.toFixed(1)} g` })
  }
  if (metadata?.estimatedFilamentLengthMm != null) {
    stats.push({ label: 'Material length', value: `${(metadata.estimatedFilamentLengthMm / 1000).toFixed(2)} m` })
  }
  if (metadata?.estimatedFilamentCost != null) {
    stats.push({ label: 'Estimated cost', value: `$${metadata.estimatedFilamentCost.toFixed(2)}` })
  }
  // result.json reports per-material weight by filament id but no name/colour, so enrich
  // each row from the slice request's chosen material (keyed by projectFilamentId == id).
  const materialInfoById = new Map<number, { name: string | null; color: string | null }>()
  for (const mapping of job?.target.filamentMappings ?? []) {
    materialInfoById.set(mapping.projectFilamentId, { name: mapping.material ?? null, color: mapping.color ?? null })
  }

  const outputNameParts = splitLibraryFileNameForRename(job?.outputFileName ?? sourceFile.name)
  return (
    <>
    <Modal open onClose={handleClose}>
      <ScrollableModalDialog sx={{ maxWidth: 480, width: '100%' }}>
        <Typography level="h4">Slice results</Typography>
        <ScrollableDialogBody sx={{ mt: 1 }}>
          <Stack spacing={1.25}>
            {slicingJobsQuery.isLoading && !job && (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size="sm" />
                <Typography level="body-sm" textColor="text.secondary">Loading slicing job…</Typography>
              </Stack>
            )}
            {!slicingJobsQuery.isLoading && !job && (
              <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                The slicing job is no longer available. If it already finished, you can find it in Jobs.
              </Alert>
            )}
            {job && (
              <Sheet variant="outlined" sx={{ p: 1.25, borderRadius: 'sm' }}>
                <Stack spacing={1}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                    <Typography level="title-md" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>{displayName}</Typography>
                    <Chip size="sm" variant="soft" color={slicingStatusColor(job.status)}>{getSlicingJobStatusLabel(job)}</Chip>
                  </Stack>
                  {!ready && job.status !== 'failed' && job.status !== 'cancelled' && (
                    <>
                      <LinearProgress determinate={progressPercent != null} value={progressPercent ?? 0} color={slicingStatusColor(job.status)} />
                      <Typography level="body-sm" textColor="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                        {formatSlicingProgress(job, progressFrame)}
                      </Typography>
                    </>
                  )}
                  {ready && (
                    stats.length > 0 ? (
                      <Stack spacing={1}>
                        <Stack spacing={0.5}>
                          {stats.map((stat) => (
                            <Stack key={stat.label} direction="row" justifyContent="space-between" spacing={2}>
                              <Typography level="body-sm" textColor="text.tertiary">{stat.label}</Typography>
                              <Typography level="body-sm" fontWeight="md">{stat.value}</Typography>
                            </Stack>
                          ))}
                        </Stack>
                        {(metadata?.materials?.length ?? 0) > 1 && (
                          <Stack spacing={0.5}>
                            <Typography level="body-xs" textColor="text.tertiary" sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>Per material</Typography>
                            {metadata!.materials!.map((material, index) => {
                              const info = material.id != null ? materialInfoById.get(material.id) : undefined
                              const color = info?.color || material.color || null
                              const name = info?.name || material.type || `Material ${material.id ?? index + 1}`
                              return (
                              <Stack key={material.id ?? index} direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                                <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                                  <Box sx={{ width: 14, height: 14, borderRadius: '3px', flexShrink: 0, bgcolor: color || 'neutral.softBg', border: '1px solid rgba(255,255,255,0.18)' }} />
                                  <Typography level="body-sm" textColor="text.tertiary" noWrap>{name}</Typography>
                                </Stack>
                                <Typography level="body-sm" fontWeight="md">{material.weightGrams != null ? `${material.weightGrams.toFixed(1)} g` : '—'}</Typography>
                              </Stack>
                            )})}
                          </Stack>
                        )}
                      </Stack>
                    ) : (
                      <Typography level="body-sm" textColor="text.secondary">
                        Slicing finished. The slicer did not report usage estimates for this job.
                      </Typography>
                    )
                  )}
                  {ready && job.outputFileId && (
                    <Button
                      type="button"
                      variant="outlined"
                      color="neutral"
                      size="sm"
                      startDecorator={<VisibilityRoundedIcon />}
                      onClick={() => setPreviewing(true)}
                      sx={{ width: { xs: '100%', sm: 'auto' }, alignSelf: { sm: 'flex-start' } }}
                    >
                      Preview
                    </Button>
                  )}
                  {jobError && (
                    <Alert color={job.status === 'cancelled' ? 'warning' : 'danger'} variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                      {jobError}
                    </Alert>
                  )}
                </Stack>
              </Sheet>
            )}
          </Stack>
        </ScrollableDialogBody>
        <DialogActions>
          <Button type="button" variant="plain" color="neutral" onClick={handleClose}>Close</Button>
          {job && job.status !== 'ready' && job.status !== 'failed' && job.status !== 'cancelled' && (
            <Button type="button" variant="plain" color="danger" loading={cancelSlicing.isPending} onClick={() => cancelSlicing.mutate()}>
              Cancel slicing
            </Button>
          )}
          {ready && (
            <Button
              type="button"
              variant="outlined"
              color="neutral"
              loading={saveToLibrary.isPending}
              disabled={saved}
              onClick={() => setSaveDestinationOpen(true)}
            >
              {saved ? 'Saved' : 'Save to library'}
            </Button>
          )}
          {ready && canPrint && (
            <Button type="button" startDecorator={<PrintRoundedIcon />} onClick={() => setPrinting(true)}>Print</Button>
          )}
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
    {saveDestinationOpen && (
      <LibraryDestinationDialog
        title="Save sliced file"
        description="Choose where to save the sliced file, then confirm the file name. Picking an existing file saves over it."
        showFiles
        fileNameField={{ label: 'File name', initialValue: outputNameParts.baseName, extension: outputNameParts.extension || '.gcode.3mf' }}
        initialFolderId={sourceFile.folderId ?? null}
        folders={folders}
        bridgeId={bridgeId}
        bridgeName={bridgeName}
        showRoot={showRoot}
        dialogWidth={720}
        submitting={saveToLibrary.isPending}
        error={saveToLibrary.error instanceof Error ? saveToLibrary.error.message : null}
        confirmActionLabel={({ outputFolderId, rootDestinationLabel }) => outputFolderId ? 'Save here' : `Save to ${rootDestinationLabel}`}
        onClose={() => setSaveDestinationOpen(false)}
        onSubmit={({ outputFileName, outputFolderId }) => saveToLibrary.mutate({
          outputFolderId,
          outputFileName: outputFileName ? `${outputFileName}${outputNameParts.extension}` : undefined
        })}
      />
    )}
    {/* Sliced-toolpath preview of the (possibly still hidden) output file; the model-studio
        plugin renders it on top of this dialog, mirroring the slice dialog's own slot. */}
    <PluginSlot
      name="library.overlays"
      context={{
        previewFileId: previewing && ready ? job?.outputFileId ?? null : null,
        previewPlateIndex: job && job.plate > 0 ? job.plate : undefined,
        onPreviewClose: () => setPreviewing(false)
      }}
    />
    </>
  )
}

function SlicingProfileAutocomplete({
  profiles,
  value,
  placeholder,
  ariaLabel,
  modified,
  onChange
}: {
  profiles: SlicingProfileSummary[]
  value: SlicingProfileSummary | null
  placeholder: string
  ariaLabel?: string
  /** When true, prefixes the selected name with `*` (Bambu's "modified" marker). */
  modified?: boolean
  onChange: (profile: SlicingProfileSummary | null) => void
}) {
  const valueDisplayName = value ? `${modified ? '* ' : ''}${formatSlicingProfileDisplayName(value)}` : ''
  const [inputValue, setInputValue] = useState(valueDisplayName)

  useEffect(() => {
    setInputValue(valueDisplayName)
  }, [valueDisplayName])

  return (
    <Autocomplete
      options={profiles}
      value={value}
      inputValue={inputValue}
      onChange={(_event, profile) => onChange(profile)}
      onInputChange={(_event, nextValue, reason) => {
        if (reason === 'reset') return
        setInputValue(nextValue)
      }}
      getOptionLabel={formatSlicingProfileDisplayName}
      isOptionEqualToValue={(option, selected) => option.id === selected.id}
      groupBy={(profile) => isProjectSlicingProfile(profile) ? '3MF project profiles' : profile.source === 'custom' ? 'Workspace profiles' : 'Built-in profiles'}
      placeholder={placeholder}
      selectOnFocus
      handleHomeEndKeys
      openOnFocus
      slotProps={{
        input: ariaLabel ? { 'aria-label': ariaLabel } : undefined,
        listbox: { sx: { maxHeight: 360 } }
      }}
      renderOption={(props, profile) => (
        <AutocompleteOption {...props} key={profile.id}>
          <ListItemContent>
            <Typography level="body-sm" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{formatSlicingProfileDisplayName(profile)}</Typography>
          </ListItemContent>
        </AutocompleteOption>
      )}
    />
  )
}

function SliceMaterialAutocomplete({
  options,
  value,
  placeholder,
  onChange
}: {
  options: SliceMaterialOption[]
  value: SliceMaterialOption | null
  placeholder: string
  onChange: (option: SliceMaterialOption | null) => void
}) {
  const [inputValue, setInputValue] = useState(value?.label ?? '')

  useEffect(() => {
    setInputValue(value?.label ?? '')
  }, [value?.id, value?.label])

  return (
    <Autocomplete
      options={options}
      value={value}
      inputValue={inputValue}
      onChange={(_event, option) => onChange(option)}
      onInputChange={(_event, nextValue, reason) => {
        if (reason === 'reset') return
        setInputValue(nextValue)
      }}
      getOptionLabel={(option) => option.label}
      isOptionEqualToValue={(option, selected) => option.id === selected.id}
      groupBy={(option) => option.group}
      placeholder={placeholder}
      selectOnFocus
      handleHomeEndKeys
      openOnFocus
      slotProps={{ listbox: { sx: { maxHeight: 360 } } }}
      renderOption={(props, option) => (
        <AutocompleteOption {...props} key={option.id}>
          <ListItemContent>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
              <Box sx={{ width: 16, height: 16, borderRadius: '50%', bgcolor: option.color ?? 'neutral.500', border: '1px solid', borderColor: 'divider', flexShrink: 0 }} />
              <Stack spacing={0.35} sx={{ minWidth: 0 }}>
                <Typography level="body-sm" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{option.label}</Typography>
                <Typography level="body-xs" textColor="text.tertiary">
                  {[option.brand, option.metadata].filter(Boolean).join(' · ')}
                </Typography>
              </Stack>
            </Stack>
          </ListItemContent>
        </AutocompleteOption>
      )}
    />
  )
}

function SliceFilamentColorPicker({
  color,
  material,
  brand,
  fullWidth = false,
  onChange
}: {
  color: string
  material: string
  brand: string
  fullWidth?: boolean
  onChange: (color: string) => void
}) {
  const [colorDialogOpen, setColorDialogOpen] = useState(false)
  const [customColorOpen, setCustomColorOpen] = useState(false)
  const [draftColor, setDraftColor] = useState(() => normalizeSliceFilamentColor(color).toUpperCase())
  const normalizedColor = normalizeSliceFilamentColor(color).toUpperCase()
  const presetBrand = brand === 'Bambu' ? 'Bambu' : brand || null
  const { swatches, usesCommonFallback } = resolveFilamentColorSwatches(material, { presetBrand })
  const colorSwatches = brand === 'Bambu' && !usesCommonFallback ? swatches : COMMON_FILAMENT_COLOR_SWATCHES
  const colorName = brand === 'Bambu' && !usesCommonFallback
    ? swatches.find((swatch) => swatch.hex.toUpperCase() === normalizedColor)?.name ?? commonFilamentColorName(normalizedColor)
    : commonFilamentColorName(normalizedColor) ?? swatches.find((swatch) => swatch.hex.toUpperCase() === normalizedColor)?.name
  const normalizedDraftColor = normalizeSliceFilamentColor(draftColor).toUpperCase()
  const draftColorName = brand === 'Bambu' && !usesCommonFallback
    ? swatches.find((swatch) => swatch.hex.toUpperCase() === normalizedDraftColor)?.name ?? commonFilamentColorName(normalizedDraftColor)
    : commonFilamentColorName(normalizedDraftColor) ?? swatches.find((swatch) => swatch.hex.toUpperCase() === normalizedDraftColor)?.name
  const openColorDialog = () => {
    setDraftColor(normalizedColor)
    setCustomColorOpen(false)
    setColorDialogOpen(true)
  }
  const applyCustomColor = () => {
    onChange(draftColor)
    setColorDialogOpen(false)
  }
  return (
    <>
      <Box
        component="button"
        type="button"
        onClick={openColorDialog}
        title={`Color: ${colorName ?? normalizedColor}`}
        aria-label={`Color ${colorName ?? normalizedColor}`}
        sx={{
          appearance: 'none',
          width: fullWidth ? '100%' : 36,
          height: 'var(--Input-minHeight, 2.25rem)',
          px: fullWidth ? 1 : 0,
          py: 0,
          borderRadius: 'sm',
          border: (theme) => `1px solid ${theme.vars.palette.divider}`,
          background: normalizedColor,
          color: filamentTextColor(null, normalizedColor),
          cursor: 'pointer',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: fullWidth ? 'flex-start' : 'center',
          overflow: 'hidden',
          transition: 'transform 80ms ease, border-color 80ms ease',
          '&:hover': { transform: 'scale(1.04)', borderColor: 'primary.outlinedBorder' },
          '&:focus-visible': {
            outline: (theme) => `2px solid ${theme.vars.palette.focusVisible}`,
            outlineOffset: 2
          }
        }}
      >
        {fullWidth && (
          <Typography level="body-xs" fontWeight="md" noWrap sx={{ color: 'inherit' }}>
            {colorName ?? normalizedColor}
          </Typography>
        )}
      </Box>
      <Modal open={colorDialogOpen} onClose={() => setColorDialogOpen(false)}>
        <ModalDialog sx={{ maxWidth: 520, width: '100%' }}>
          <Stack direction="row" spacing={1.25} alignItems="center">
            <Box sx={{ width: 56, height: 56, borderRadius: 'sm', background: normalizedDraftColor, border: '1px solid', borderColor: 'divider', flexShrink: 0 }} />
            <Box sx={{ minWidth: 0 }}>
              <Typography level="h4">{draftColorName ?? normalizedDraftColor}</Typography>
              <Typography level="body-sm" textColor="text.tertiary">{[brand, material].filter(Boolean).join(' ') || 'Filament color'}</Typography>
            </Box>
          </Stack>
          <Stack spacing={1.25}>
            <ColorSwatchPicker
              title={brand === 'Bambu' && !usesCommonFallback ? `Bambu ${material} colors` : 'Common filament colors'}
              swatches={colorSwatches}
              selectedHex={normalizedDraftColor}
              onPick={(nextColor) => setDraftColor(normalizeSliceFilamentColor(nextColor).toUpperCase())}
              onCustomPick={() => setCustomColorOpen(true)}
            />
            {customColorOpen && (
              <Sheet variant="soft" sx={{ p: 1, borderRadius: 'sm' }}>
                <Stack spacing={1}>
                  <Typography level="title-sm">Custom color</Typography>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                    <FormControl sx={{ flex: 0 }}>
                      <FormLabel>Color</FormLabel>
                      <Input
                        type="color"
                        value={normalizeSliceFilamentColor(draftColor)}
                        onChange={(event) => setDraftColor(normalizeSliceFilamentColor(event.target.value).toUpperCase())}
                        slotProps={{ input: { 'aria-label': 'Color' } }}
                        sx={{ width: 72, p: 0.5 }}
                      />
                    </FormControl>
                    <FormControl sx={{ flex: 1 }}>
                      <FormLabel>Hex</FormLabel>
                      <Input
                        value={draftColor}
                        onChange={(event) => setDraftColor(normalizeSliceFilamentColor(event.target.value).toUpperCase())}
                        placeholder="#RRGGBB"
                      />
                    </FormControl>
                  </Stack>
                </Stack>
              </Sheet>
            )}
          </Stack>
          <DialogActions sx={{ pt: 1 }}>
            <Button type="button" variant="plain" onClick={() => setColorDialogOpen(false)}>Cancel</Button>
            <Button type="button" onClick={applyCustomColor}>Apply</Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </>
  )
}

interface PrintModalProps {
  file: LibraryFile
  versionId?: string | null
  printers: Printer[]
  onClose: () => void
  onBack?: () => void
  /**
   * Pre-select this printer when the dialog opens. Used when launching
   * the print flow from a specific printer card. Ignored if the printer
   * is currently busy or offline.
   */
  defaultPrinterId?: string
  lockPrinterSelection?: boolean
  defaultPlate?: number
  defaultBedLevel?: boolean
  defaultAmsMapping?: number[] | null
  projectFilamentOverrides?: ThreeMfProjectFilament[]
  selectionMode?: 'single' | 'multiple'
  submitPrint?: (input: {
    printerId: string
    body: Omit<StartOrderPrintInput, 'printerId'>
  }) => Promise<void>
  onSubmitted?: (printerIds: string[]) => void
}

interface AmsMappingsBySerial {
  /**
   * key = printer.id, value = array indexed by 0-based filament-id (project
   * filament `id - 1`) → dispatch tray mapping value. Standard AMS trays use
   * the global tray index; external spools use the virtual ids `255` / `254`.
   * `-1` (or absent) means “unset”, which we omit from the wire payload.
   */
  [printerId: string]: number[]
}

interface PrinterTrayOption {
  mappingValue: number
  key: string
  kind: 'ams' | 'external'
  label: string
  badgeLabel: string
  groupLabel: string | null
  color: string | null
  colors: string[]
  filamentType: string | null
  trayName: string | null
  trayInfoIdx: string | null
  remainPercent: number | null
  /** Spool identity (RFID/Bambu tag). Null for third-party spools that cannot report remaining. */
  trayUuid: string | null
  nozzleId: number | null
  /** Slot reports a physical spool even though its identity is unreadable. */
  occupied?: boolean | null
  /** AMS coordinates for the spool-setup dialog (AMS trays only). */
  amsUnitId?: number
  amsSlotId?: number
}

type PrinterTrayGroup = PrinterTrayGroupBase<PrinterTrayOption>

/**
 * Print dialog with multi-printer dispatch.
 *
 * The plate selector previews each plate's PNG. AMS mapping is keyed
 * by the project filament id, so the resulting `ams_mapping` payload
 * uses the same indices the printer firmware expects.
 */
export function PrintModal({
  file,
  versionId = null,
  printers,
  onClose,
  onBack,
  defaultPrinterId,
  lockPrinterSelection = false,
  defaultPlate,
  defaultBedLevel,
  defaultAmsMapping,
  projectFilamentOverrides,
  selectionMode = 'multiple',
  submitPrint,
  onSubmitted
}: PrintModalProps) {
  const { confirm } = usePromptDialog()
  const workspaceScopeKey = readCurrentWorkspaceScopeKey()
  const resourceBasePath = buildLibraryResourceBasePath(file.id, versionId)
  const queryClient = useQueryClient()
  usePlateClearingSync()
  const authBootstrapQuery = useAuthBootstrapQuery()
  const platesQuery = useQuery({
    queryKey: ['library-plates', file.id, versionId ?? 'current'],
    queryFn: ({ signal }) => apiFetch<ThreeMfIndex>(`${resourceBasePath}/plates`, { signal }),
    staleTime: 60_000,
    refetchOnMount: 'always'
  })
  const plates = useMemo(() => platesQuery.data?.plates ?? [], [platesQuery.data])
  const projectFilaments = useMemo(
    () => projectFilamentOverrides ?? platesQuery.data?.projectFilaments ?? [],
    [platesQuery.data, projectFilamentOverrides]
  )
  const compatiblePrinterModels = useMemo(
    () => platesQuery.data?.compatiblePrinterModels ?? file.compatiblePrinterModels,
    [file.compatiblePrinterModels, platesQuery.data]
  )

  const statusQuery = useQuery<Record<string, PrinterStatus>>({
    queryKey: workspaceQueryKeys.printerStatus(workspaceScopeKey),
    queryFn: () => Promise.resolve({}),
    initialData: {},
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })
  const statuses = useMemo(() => statusQuery.data ?? {}, [statusQuery.data])
  const authEnabled = authBootstrapQuery.data?.authEnabled ?? false
  const canClearPlate = authBootstrapQuery.data
    ? !authEnabled || authBootstrapQuery.data.permissions.includes(PRINTERS_CLEAR_PLATE_PERMISSION)
    : false
  const { clearedByPrinterId } = usePlateClearingStates()
  const printerSelectionLocked = Boolean(lockPrinterSelection && defaultPrinterId && printers.some((printer) => printer.id === defaultPrinterId))
  const singlePrinterMode = useMemo(
    () => Boolean(defaultPrinterId && printers.some((printer) => printer.id === defaultPrinterId)),
    [defaultPrinterId, printers]
  )

  /**
   * A printer is "available" for a new job when it's reachable and not
   * already mid-job. We treat unknown stages as available so the user
   * can attempt to dispatch and let the firmware reject if needed.
   */
  const isAvailable = (printerId: string): boolean => {
    const status = statuses[printerId]
    if (!status || !status.online) return false
    return AVAILABLE_PRINT_STAGES.has(status.stage)
  }
  const availablePrinterIds = useMemo(
    () => new Set(Object.entries(statuses)
      .filter(([, status]) => status?.online && AVAILABLE_PRINT_STAGES.has(status.stage))
      .map(([printerId]) => printerId)),
    [statuses]
  )

  // Only pre-select a printer when the dialog was opened from a specific
  // printer card (defaultPrinterId provided). Page-level and library
  // entry points open with no printer selected so the user makes an
  // explicit choice.
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    if (
      defaultPrinterId
      && printers.some(
        (printer) =>
          printer.id === defaultPrinterId
          && isPrinterModelCompatible(file.compatiblePrinterModels, printer.model)
      )
    ) {
      return [defaultPrinterId]
    }
    return []
  })
  const selectedPrinters = useMemo(
    () => selectedIds
      .map((printerId) => printers.find((printer) => printer.id === printerId))
      .filter((printer): printer is Printer => Boolean(printer)),
    [printers, selectedIds]
  )
  const hasSelectedPrinters = selectedPrinters.length > 0
  const preferencePrinterModels = useMemo(() => {
    if (selectedPrinters.length > 0) {
      return selectedPrinters.map((printer) => printer.model)
    }
    if (singlePrinterMode && defaultPrinterId) {
      const defaultPrinter = printers.find((printer) => printer.id === defaultPrinterId)
      return defaultPrinter ? [defaultPrinter.model] : []
    }
    return []
  }, [defaultPrinterId, printers, selectedPrinters, singlePrinterMode])
  const storedPrintOptionsKey = useMemo(
    () => buildPrintStartPreferenceKey(authBootstrapQuery.data, preferencePrinterModels),
    [authBootstrapQuery.data, preferencePrinterModels]
  )
  const [storedPrintOptions, setStoredPrintOptions, storedPrintOptionsReady] = useLocalStorageState(
    storedPrintOptionsKey,
    DEFAULT_STORED_PRINT_START_OPTIONS,
    parseStoredPrintStartOptions
  )
  const [plateIndex, setPlateIndex] = useState<number>(defaultPlate ?? 1)
  const [bedLevel, setBedLevel] = useState<PrintOnOffAutoMode>('on')
  const [vibrationCompensation, setVibrationCompensation] = useState(false)
  const [flowCalibration, setFlowCalibration] = useState<PrintOnOffAutoMode>('off')
  const [timelapse, setTimelapse] = useState(false)
  const [nozzleOffsetCalibration, setNozzleOffsetCalibration] = useState<PrintNozzleOffsetCalibrationMode>('auto')
  const [printOptionsTouched, setPrintOptionsTouched] = useState(false)
  const [initializedPrintOptionsSelectionKey, setInitializedPrintOptionsSelectionKey] = useState<string | null>(null)
  const [mappings, setMappings] = useState<AmsMappingsBySerial>(() => {
    if (!defaultPrinterId || !defaultAmsMapping || defaultAmsMapping.length === 0) return {}
    return { [defaultPrinterId]: defaultAmsMapping }
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [allowIncompatibleFilament, setAllowIncompatibleFilament] = useState(false)
  const [allowPlateTypeMismatch, setAllowPlateTypeMismatch] = useState(false)
  const [showOtherPrinters, setShowOtherPrinters] = useState(false)
  const [previewFileId, setPreviewFileId] = useState<string | null>(null)
  const canOpenThreeDimensionalPreview = (file.kind === '3mf' || file.kind === 'gcode') && plates.length > 0

  const confirmPlateCleared = useMutation({
    mutationFn: async (printerId: string) => {
      await apiFetch(`/api/plugins/plate-clearing/state/${printerId}/clear`, { method: 'POST' })
      return printerId
    },
    onSuccess: (printerId) => {
      queryClient.setQueryData<PlateClearingStateResponse>(
        PLATE_CLEARING_STATE_QUERY_KEY,
        (existing) => mergePlateClearingState(existing, printerId, true)
      )
    }
  })

  const activePlate = useMemo(
    () => plates.find((plate) => plate.index === plateIndex) ?? plates[0],
    [plates, plateIndex]
  )
  /**
   * Filaments displayed for AMS mapping. Prefer the full project list
   * (Bambu Studio's view), but fall back to the per-plate filaments for
   * older 3MFs that omit `project_settings.config`.
   */
  const filamentEntries = useMemo<ThreeMfProjectFilament[]>(() => {
    if (projectFilaments.length > 0) return projectFilaments
    return (activePlate?.filaments ?? []).map((filament) => ({
      id: filament.id,
      filamentType: filament.filamentType,
      filamentName: filament.filamentName,
      color: filament.color,
      nozzleId: filament.nozzleId ?? null,
      chamberTemperature: filament.chamberTemperature ?? null
    }))
  }, [projectFilaments, activePlate])
  const usedIds = useMemo(
    () => new Set((activePlate?.filaments ?? []).map((filament) => filament.id)),
    [activePlate]
  )
  /**
   * Per-filament gram usage for the active plate. Used by the printer
   * mapping rows to show "this print needs 12g of #1 PLA" so the user
   * can compare against the remaining-spool estimate next to each AMS
   * slot.
   */
  const usedGramsById = useMemo(() => {
    const map = new Map<number, number>()
    for (const filament of activePlate?.filaments ?? []) {
      if (filament.usedGrams != null) map.set(filament.id, filament.usedGrams)
    }
    return map
  }, [activePlate])

  const visibleFilaments = useMemo(
    () => filamentsForMapping(filamentEntries, usedIds),
    [filamentEntries, usedIds]
  )
  const requiredNozzleDiameters = useMemo(
    () => buildRequiredNozzleDiametersByExtruder(activePlate?.filaments ?? [], activePlate?.nozzleSizes ?? []),
    [activePlate]
  )
  const setSlot = (printerId: string, filamentId: number, trayValue: number) => {
    setMappings((prev) => {
      const current = prev[printerId] ? [...prev[printerId]] : []
      const externalSpoolCount = statuses[printerId]?.externalSpools.length ?? 0
      const selectedTray = buildPrinterTrayMap(statuses[printerId]).get(trayValue)
      const selectedTrayNozzleId = selectedTray?.nozzleId ?? null
      const targetFilamentIds =
        externalSpoolCount === 1 && isExternalSpoolMappingValue(trayValue)
          ? visibleFilaments
            .filter(
              (filament) =>
                filament.nozzleId == null
                || (selectedTrayNozzleId != null && filament.nozzleId === selectedTrayNozzleId)
            )
            .map((filament) => filament.id)
          : [filamentId]
      for (const targetFilamentId of targetFilamentIds) {
        const slot = targetFilamentId - 1
        while (current.length <= slot) current.push(-1)
        current[slot] = trayValue
      }
      return { ...prev, [printerId]: current }
    })
  }

  /**
   * IDs of filaments the active plate actually consumes. Every one of
   * these must have an explicit AMS slot chosen for each selected
   * printer before we let the user dispatch.
   */
  const requiredFilamentIds = useMemo(
    () => (activePlate?.filaments ?? []).map((filament) => filament.id),
    [activePlate]
  )
  const visibleFilamentById = useMemo(
    () => new Map(visibleFilaments.map((filament) => [filament.id, filament] as const)),
    [visibleFilaments]
  )
  const isMappingComplete = (printerId: string): boolean => {
    if (!printerHasSelectableTrays(statuses[printerId])) return true
    const mapping = mappings[printerId] ?? []
    const trayGroups = buildPrinterTrayGroups(statuses[printerId])
    return requiredFilamentIds.every((id) => {
      const selectedValue = mapping[id - 1] ?? -1
      if (selectedValue < 0) return false
      const filament = visibleFilamentById.get(id)
      const allowedTrayValues = new Set(
        filterTrayGroupsForFilament(trayGroups, filament?.nozzleId ?? null)
          .flatMap((group) => group.trays)
          .map((tray) => tray.mappingValue)
      )
      return allowedTrayValues.has(selectedValue)
    })
  }
  const allMappingsComplete = selectedIds.every(isMappingComplete)

  const compatibilityIssuesByPrinter = useMemo(() => {
    const next: Record<string, FilamentCompatibilityIssue[]> = {}
    for (const printerId of selectedIds) {
      const mapping = mappings[printerId] ?? []
      const trayByValue = buildPrinterTrayMap(statuses[printerId])
      const selectedTrays = new Map<number, { filamentType: string | null; label: string; nozzleId: number | null }>()
      for (const filament of visibleFilaments) {
        const trayValue = mapping[filament.id - 1]
        if (typeof trayValue !== 'number' || trayValue < 0) continue
        const tray = trayByValue.get(trayValue)
        if (!tray) continue
        selectedTrays.set(filament.id, {
          filamentType: tray.filamentType,
          label: tray.kind === 'external'
            ? tray.label
            : [tray.groupLabel ?? 'AMS', tray.label].join(' '),
          nozzleId: tray.nozzleId
        })
      }

      const issues = findFilamentCompatibilityIssues(
        visibleFilaments.map((filament) => ({
          filamentId: filament.id,
          filamentType: filament.filamentType,
          filamentName: filament.filamentName,
          nozzleId: filament.nozzleId ?? null
        })),
        selectedTrays
      )

      if (issues.length > 0) next[printerId] = issues
    }
    return next
  }, [mappings, selectedIds, statuses, visibleFilaments])
  const compatibilityIssueEntries = useMemo(
    () => selectedIds
      .map((printerId) => [printerId, compatibilityIssuesByPrinter[printerId] ?? []] as const)
      .filter(([, issues]) => issues.length > 0),
    [compatibilityIssuesByPrinter, selectedIds]
  )
  const hardCompatibilityIssueEntries = useMemo(
    () => compatibilityIssueEntries
      .map(([printerId, issues]) => [printerId, issues.filter((issue) => issue.nozzleMismatch)] as const)
      .filter(([, issues]) => issues.length > 0),
    [compatibilityIssueEntries]
  )
  const softCompatibilityIssueEntries = useMemo(
    () => compatibilityIssueEntries
      .map(([printerId, issues]) => [printerId, issues.filter((issue) => issue.typeMismatch && !issue.nozzleMismatch)] as const)
      .filter(([, issues]) => issues.length > 0),
    [compatibilityIssueEntries]
  )
  const hasHardCompatibilityIssues = hardCompatibilityIssueEntries.length > 0
  const hasSoftCompatibilityIssues = softCompatibilityIssueEntries.length > 0
  const highTemperatureFilamentLabels = useMemo(() => {
    const projectFilamentsById = new Map(filamentEntries.map((filament) => [filament.id, filament] as const))
    const labels = new Set<string>()
    for (const filament of activePlate?.filaments ?? []) {
      const projectFilament = projectFilamentsById.get(filament.id)
      const chamberTemperature = projectFilament?.chamberTemperature ?? filament.chamberTemperature ?? null
      if (chamberTemperature == null || chamberTemperature < 40) continue
      const label = projectFilament?.filamentType?.trim() || filament.filamentType?.trim() || null
      if (label) labels.add(label)
    }
    return Array.from(labels)
  }, [activePlate, filamentEntries])
  const compatibilitySignature = useMemo(
    () => JSON.stringify({ hardCompatibilityIssueEntries, softCompatibilityIssueEntries }),
    [hardCompatibilityIssueEntries, softCompatibilityIssueEntries]
  )

  useEffect(() => {
    setAllowIncompatibleFilament(false)
  }, [compatibilitySignature])

  const printersById = useMemo(
    () => new Map(printers.map((printer) => [printer.id, printer] as const)),
    [printers]
  )
  const environmentWarningEntries = useMemo(() => {
    if (highTemperatureFilamentLabels.length === 0 || selectedIds.length === 0) return []
    const filamentList = highTemperatureFilamentLabels.join(', ')
    return selectedIds
      .map((printerId) => {
        const printer = printersById.get(printerId)
        if (!printer) return null
        const message = printerHasChamber(printer.model)
          ? `[ ${filamentList} ] requires printing in a high-temperature environment. Reminder to close the door if not already closed.`
          : `[ ${filamentList} ] requires printing in a high-temperature environment.`
        return {
          printerId,
          printerName: printer.name,
          message
        }
      })
      .filter((entry): entry is { printerId: string; printerName: string; message: string } => entry != null)
  }, [highTemperatureFilamentLabels, printersById, selectedIds])
  const compatiblePrinters = useMemo(
    () => printers.filter((printer) => isPrinterModelCompatible(compatiblePrinterModels, printer.model)),
    [compatiblePrinterModels, printers]
  )
  const busyPrinters = useMemo(
    () => printers.filter((printer) => {
      const status = statuses[printer.id]
      return Boolean(status?.online && !AVAILABLE_PRINT_STAGES.has(status.stage))
    }),
    [printers, statuses]
  )
  const incompatiblePrinters = useMemo(
    () => printers.filter((printer) => !isPrinterModelCompatible(compatiblePrinterModels, printer.model)),
    [compatiblePrinterModels, printers]
  )
  const visiblePrinters = useMemo(
    () => {
      if (printerSelectionLocked) {
        return printers.filter((printer) => printer.id === defaultPrinterId)
      }
      if (singlePrinterMode) {
        return showOtherPrinters
          ? printers
          : printers.filter((printer) => printer.id === defaultPrinterId)
      }

      return showOtherPrinters
        ? printers
        : printers.filter((printer) => {
          if (selectedIds.includes(printer.id)) return true
          if (!isPrinterModelCompatible(compatiblePrinterModels, printer.model)) return false
          const status = statuses[printer.id]
          return !(status?.online && !AVAILABLE_PRINT_STAGES.has(status.stage))
        })
    },
    [compatiblePrinterModels, defaultPrinterId, printerSelectionLocked, printers, selectedIds, showOtherPrinters, singlePrinterMode, statuses]
  )
  const visiblePrintStartOptions = useMemo(() => {
    if (selectedPrinters.length === 0) return null

    return mergePrintStartOptions(
      selectedPrinters.map((printer) => {
        const printerStatus = statuses[printer.id]
        return getPrinterPrintStartOptions(
          printer.model,
          printerStatus
            ? {
                printOptions: printerStatus.printOptions,
                printStartOptions: printerStatus.printStartOptions
              }
            : null
        )
      })
    )
  }, [selectedPrinters, statuses])
  const visiblePrintOptionCapabilities = useMemo(() => ({
    bedLevel: visiblePrintStartOptions?.bedLevel.supported ?? false,
    bedLevelAuto: visiblePrintStartOptions?.bedLevel.autoSupported ?? false,
    vibrationCompensation: visiblePrintStartOptions?.vibrationCompensation.supported ?? false,
    flowCalibration: visiblePrintStartOptions?.flowCalibration.supported ?? false,
    flowCalibrationAuto: visiblePrintStartOptions?.flowCalibration.autoSupported ?? false,
    firstLayerInspection: visiblePrintStartOptions?.firstLayerInspection.supported ?? false,
    timelapse: visiblePrintStartOptions?.timelapse.supported ?? false,
    nozzleOffsetCalibration: visiblePrintStartOptions?.nozzleOffsetCalibration.supported ?? false
  }), [visiblePrintStartOptions])
  const resolvedStoredPrintOptions = useMemo(
    () => resolvePrintStartPreferenceDefaults(storedPrintOptions, visiblePrintStartOptions),
    [storedPrintOptions, visiblePrintStartOptions]
  )
  const selectedPrinterSelectionKey = useMemo(
    () => selectedIds.slice().sort().join(','),
    [selectedIds]
  )

  // Print options are remembered per printer-model set (the storage key). When the model set
  // changes, clear the "user touched" flag so the form re-seeds from the new model's own
  // remembered (capability-clamped) values instead of carrying the previous model's edits over
  // and writing them into the new model's key. Keyed on the storage key rather than the raw
  // selection so adding a same-model printer keeps any in-progress edits.
  useEffect(() => {
    setPrintOptionsTouched(false)
  }, [storedPrintOptionsKey])

  useEffect(() => {
    if (!hasSelectedPrinters) {
      setInitializedPrintOptionsSelectionKey(null)
      return
    }
    if (printOptionsTouched) return
    if (!storedPrintOptionsReady) return
    if (initializedPrintOptionsSelectionKey === selectedPrinterSelectionKey) return
    setBedLevel(defaultBedLevel == null ? resolvedStoredPrintOptions.bedLevel : defaultBedLevel ? 'on' : 'off')
    setVibrationCompensation(resolvedStoredPrintOptions.vibrationCompensation)
    setFlowCalibration(resolvedStoredPrintOptions.flowCalibration)
    setTimelapse(resolvedStoredPrintOptions.timelapse)
    setNozzleOffsetCalibration(resolvedStoredPrintOptions.nozzleOffsetCalibration)
    setInitializedPrintOptionsSelectionKey(selectedPrinterSelectionKey)
  }, [
    defaultBedLevel,
    hasSelectedPrinters,
    initializedPrintOptionsSelectionKey,
    printOptionsTouched,
    resolvedStoredPrintOptions,
    selectedPrinterSelectionKey,
    storedPrintOptionsReady
  ])

  const selectedTrayWarningEntries = useMemo(() => {
    return selectedIds
      .map((printerId) => {
        const printer = printersById.get(printerId)
        const warnings = getSelectedTrayWarningMessages({
          mapping: mappings[printerId] ?? [],
          trayByMappingValue: buildPrinterTrayMap(statuses[printerId]),
          filaments: visibleFilaments,
          timelapse,
          status: statuses[printerId]
        })
        if (!printer || warnings.length === 0) return null
        return {
          printerId,
          printerName: printer.name,
          warnings
        }
      })
      .filter((entry): entry is { printerId: string; printerName: string; warnings: string[] } => entry != null)
  }, [mappings, printersById, selectedIds, statuses, timelapse, visibleFilaments])

  const hardwareIssuesByPrinter = useMemo(() => {
    const next: Record<string, { plateType: PlateTypeMismatchIssue | null; nozzleDiameters: NozzleDiameterCompatibilityIssue[] }> = {}
    for (const printerId of selectedIds) {
      const printer = printersById.get(printerId)
      const selection = {
        plateType: printer?.currentPlateType ?? null,
        nozzleDiameters: resolvePrinterNozzleDiameters(statuses[printerId], printer?.currentNozzleDiameters ?? [])
      }
      const plateTypeIssue = activePlate?.plateType
        ? !selection.plateType || !isPlateTypeCompatible(activePlate.plateType, selection.plateType)
          ? {
            requiredPlateType: activePlate.plateType,
            selectedPlateType: selection.plateType ?? null
          }
          : null
        : null
      const nozzleDiameters = findNozzleDiameterCompatibilityIssues(requiredNozzleDiameters, selection.nozzleDiameters)
      if (plateTypeIssue || nozzleDiameters.length > 0) {
        next[printerId] = { plateType: plateTypeIssue, nozzleDiameters }
      }
    }
    return next
  }, [activePlate, printersById, requiredNozzleDiameters, selectedIds, statuses])
  const plateTypeIssueEntries = useMemo(
    () => selectedIds
      .map((printerId) => [printerId, hardwareIssuesByPrinter[printerId]?.plateType ?? null] as const)
      .filter(([, issue]) => issue != null),
    [hardwareIssuesByPrinter, selectedIds]
  )
  const nozzleDiameterIssueEntries = useMemo(
    () => selectedIds
      .map((printerId) => [printerId, hardwareIssuesByPrinter[printerId]?.nozzleDiameters ?? []] as const)
      .filter(([, issues]) => issues.length > 0),
    [hardwareIssuesByPrinter, selectedIds]
  )
  const hasPlateTypeIssues = plateTypeIssueEntries.length > 0
  const hasHardNozzleDiameterIssues = nozzleDiameterIssueEntries.length > 0
  const hardwareSignature = useMemo(
    () => JSON.stringify({ plateTypeIssueEntries, nozzleDiameterIssueEntries }),
    [nozzleDiameterIssueEntries, plateTypeIssueEntries]
  )

  useEffect(() => {
    setAllowPlateTypeMismatch(false)
  }, [hardwareSignature])

  useEffect(() => {
    if (!hasSelectedPrinters) return
    if (!storedPrintOptionsReady) return
    if (!printOptionsTouched && initializedPrintOptionsSelectionKey !== selectedPrinterSelectionKey) return
    setStoredPrintOptions({
      bedLevel,
      vibrationCompensation,
      flowCalibration,
      timelapse,
      nozzleOffsetCalibration
    })
  }, [
    bedLevel,
    vibrationCompensation,
    flowCalibration,
    hasSelectedPrinters,
    initializedPrintOptionsSelectionKey,
    timelapse,
    nozzleOffsetCalibration,
    printOptionsTouched,
    selectedPrinterSelectionKey,
    setStoredPrintOptions,
    storedPrintOptionsReady
  ])

  const updateBedLevel = (value: PrintOnOffAutoMode) => {
    setPrintOptionsTouched(true)
    setBedLevel(value)
  }

  const updateVibrationCompensation = (value: boolean) => {
    setPrintOptionsTouched(true)
    setVibrationCompensation(value)
  }

  const updateFlowCalibration = (value: PrintOnOffAutoMode) => {
    setPrintOptionsTouched(true)
    setFlowCalibration(value)
  }

  const updateTimelapse = (value: boolean) => {
    setPrintOptionsTouched(true)
    setTimelapse(value)
  }

  const updateNozzleOffsetCalibration = (value: PrintNozzleOffsetCalibrationMode) => {
    setPrintOptionsTouched(true)
    setNozzleOffsetCalibration(value)
  }

  useEffect(() => {
    setSelectedIds((current) => {
      const next = current.filter((printerId) => {
        const printer = printers.find((entry) => entry.id === printerId)
        return printer
          ? isPrinterModelCompatible(compatiblePrinterModels, printer.model)
            && clearedByPrinterId[printerId] !== false
          : false
      })
      return next.length === current.length ? current : next
    })
  }, [clearedByPrinterId, compatiblePrinterModels, printers])

  useEffect(() => {
    if (!printerSelectionLocked || !defaultPrinterId) return
    const lockedPrinter = printers.find((printer) => printer.id === defaultPrinterId)
    const next = lockedPrinter
      && isPrinterModelCompatible(compatiblePrinterModels, lockedPrinter.model)
      && clearedByPrinterId[defaultPrinterId] !== false
      && availablePrinterIds.has(defaultPrinterId)
      ? [defaultPrinterId]
      : []
    setSelectedIds((current) => current.length === next.length && current.every((value, index) => value === next[index]) ? current : next)
  }, [availablePrinterIds, clearedByPrinterId, compatiblePrinterModels, defaultPrinterId, printerSelectionLocked, printers])

  const togglePrinter = (printer: Printer) => {
    if (printerSelectionLocked) return
    const modelCompatible = isPrinterModelCompatible(compatiblePrinterModels, printer.model)
    const plateNeedsClear = clearedByPrinterId[printer.id] === false
    if ((!isAvailable(printer.id) || !modelCompatible || plateNeedsClear) && !selectedIds.includes(printer.id)) return
    setSelectedIds((current) => {
      if (selectionMode === 'single') {
        return current.includes(printer.id) ? [] : [printer.id]
      }
      return current.includes(printer.id)
        ? current.filter((id) => id !== printer.id)
        : [...current, printer.id]
    })
  }

  const submitInFlightRef = useRef(false)

  const submit = async () => {
    if (submitInFlightRef.current) {
      return
    }

    submitInFlightRef.current = true
    setSubmitting(true)
    setErrors({})

    try {
      const next: Record<string, string> = {}
      const submittedPrinterIds: string[] = []
      await Promise.all(
        selectedIds.map(async (printerId) => {
          try {
            const printer = printersById.get(printerId)
            const capabilities = getPrinterPrintOptionCapabilities(
              printer?.model ?? 'unknown',
              statuses[printerId]
                ? {
                    printOptions: statuses[printerId].printOptions,
                    printStartOptions: statuses[printerId].printStartOptions
                  }
                : null
            )
            const printStartOptions = getPrinterPrintStartOptions(
              printer?.model ?? 'unknown',
              statuses[printerId]
                ? {
                    printOptions: statuses[printerId].printOptions,
                    printStartOptions: statuses[printerId].printStartOptions
                  }
                : null
            )
            const normalizedBedLevel = !capabilities.bedLevel
              ? 'off'
              : bedLevel === 'auto' && !capabilities.bedLevelAuto
                ? 'on'
                : bedLevel
            const normalizedFlowCalibration = !capabilities.flowCalibration
              ? 'off'
              : flowCalibration === 'auto' && !capabilities.flowCalibrationAuto
                ? 'on'
                : flowCalibration
            const body = {
              useAms: true,
              bedLevel: normalizedBedLevel,
              vibrationCompensation: capabilities.vibrationCompensation && vibrationCompensation,
              flowCalibration: normalizedFlowCalibration,
              firstLayerInspection: resolveFirstLayerInspectionDefault(printStartOptions),
              timelapse: capabilities.timelapse && timelapse,
              filamentDynamicsCalibration: false,
              nozzleOffsetCalibration:
                capabilities.nozzleOffsetCalibration ? nozzleOffsetCalibration : 'off',
              allowIncompatibleFilament,
              allowPlateTypeMismatch,
              currentPlateType: printer?.currentPlateType ?? null,
              currentNozzleDiameters: resolvePrinterNozzleDiameters(
                statuses[printerId],
                printer?.currentNozzleDiameters ?? []
              ),
              plate: activePlate?.index ?? 1,
              amsMapping: sanitizeTrayMapping(mappings[printerId])
            } satisfies Omit<StartOrderPrintInput, 'printerId'>

            if (submitPrint) {
              await submitPrint({ printerId, body })
            } else {
              await apiFetch<{ job: PrintDispatchJob }>(`${resourceBasePath}/print`, {
                method: 'POST',
                body: {
                  printerId,
                  ...body
                }
              })
            }
            submittedPrinterIds.push(printerId)
          } catch (error) {
            next[printerId] = (error as Error).message
          }
        })
      )

      setErrors(next)
      if (submittedPrinterIds.length > 0) {
        onSubmitted?.(submittedPrinterIds)
      }
      if (Object.keys(next).length === 0) {
        void queryClient.invalidateQueries({ queryKey: ['print-dispatch'] })
        onClose()
      }
    } finally {
      submitInFlightRef.current = false
      setSubmitting(false)
    }
  }

  const dismissCurrentStep = onBack ?? onClose

  return (
    <>
      <Modal open onClose={dismissCurrentStep}>
        <ScrollableModalDialog sx={{ maxWidth: 640, width: '100%' }}>
        <Typography level="h4">Send to printer</Typography>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          justifyContent="space-between"
          sx={{ mb: 1, minWidth: 0 }}
        >
          <Typography level="body-sm" textColor="text.tertiary" sx={{ minWidth: 0 }}>
            {formatLibraryFileName(file.name)}
          </Typography>
          {(compatiblePrinterModels.length > 0 || activePlate?.plateType || activePlate?.nozzleSizes.length) ? (
            <Stack
              direction="row"
              spacing={0.5}
              useFlexGap
              sx={{
                flexWrap: 'wrap',
                minWidth: 0,
                justifyContent: { xs: 'flex-start', sm: 'flex-end' },
                flexShrink: 0
              }}
            >
              {compatiblePrinterModels.map((model) => (
                <Chip key={model} size="sm" variant="soft" color="neutral" sx={{ flexShrink: 0 }}>
                  {model}
                </Chip>
              ))}
              {(activePlate?.nozzleSizes ?? []).map((size) => (
                <Chip key={size} size="sm" variant="soft" color="neutral" sx={{ flexShrink: 0 }}>
                  {formatNozzleDiameterLabel(size) ?? size}
                </Chip>
              ))}
              {activePlate?.plateType && (
                <Chip size="sm" variant="soft" color="warning" sx={{ flexShrink: 0 }}>
                  {activePlate.plateType}
                </Chip>
              )}
            </Stack>
          ) : null}
        </Stack>
        <ScrollableDialogBody sx={{ p: 0, overflowX: 'hidden' }}>
        <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
          {plates.length > 0 && (
            <>
              <Typography level="title-sm">Plate</Typography>
              <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
                <LibraryPlateCardPicker
                  fileId={file.id}
                  resourceBasePath={resourceBasePath}
                  thumbnailVersion={file.uploadedAt}
                  plates={plates}
                  value={plateIndex}
                  onChange={setPlateIndex}
                  label={null}
                  onPreview={canOpenThreeDimensionalPreview ? () => setPreviewFileId(file.id) : undefined}
                />
              </Sheet>
            </>
          )}

          <Typography level="title-sm">Printers</Typography>
          <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                <Typography level="body-sm" textColor="text.tertiary">
                  {printerSelectionLocked
                    ? 'This print is locked to the originating printer.'
                    : singlePrinterMode ? 'Select a printer for this plate.' : 'Select one or more printers for this plate.'}
                </Typography>
                {!printerSelectionLocked && ((singlePrinterMode && printers.length > 1) || (!singlePrinterMode && (incompatiblePrinters.length > 0 || busyPrinters.length > 0))) && (
                  <Typography
                    level="body-sm"
                    textColor="primary.softColor"
                    sx={{ cursor: 'pointer', flexShrink: 0 }}
                    onClick={() => setShowOtherPrinters((current) => !current)}
                  >
                    {showOtherPrinters ? 'Hide other printers' : 'Show other printers'}
                  </Typography>
                )}
              </Stack>
              {printers.length === 0 && (
                <Typography level="body-sm" textColor="text.tertiary">
                  No printers configured.
                </Typography>
              )}
              {printers.length > 0 && compatiblePrinterModels.length > 0 && compatiblePrinters.length === 0 && (
                <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                  No compatible printers are configured for this file. It can only be sent to {compatiblePrinterModels.join(', ')}.
                </Alert>
              )}
              {visiblePrinters.map((printer) => {
                const checked = selectedIds.includes(printer.id)
                const status = statuses[printer.id]
                const available = isAvailable(printer.id)
                const modelCompatible = isPrinterModelCompatible(compatiblePrinterModels, printer.model)
                const plateNeedsClear = clearedByPrinterId[printer.id] === false
                const plateClearActionable = available && modelCompatible && plateNeedsClear
                const selectable = available && modelCompatible && !plateNeedsClear
                const canToggleSelection = selectable && !printerSelectionLocked
                const canConfirmClear = canClearPlate && plateClearActionable
                const toggle = () => canToggleSelection && togglePrinter(printer)
                return (
                  <Card
                    key={printer.id}
                    variant="outlined"
                    size="sm"
                    onClick={toggle}
                    sx={{
                      opacity: selectable || plateClearActionable ? 1 : 0.6,
                      cursor: canToggleSelection ? 'pointer' : canConfirmClear ? 'default' : 'not-allowed',
                      borderColor: checked ? 'var(--joy-palette-primary-500)' : undefined,
                      boxShadow: checked ? '0 0 0 1px var(--joy-palette-primary-500)' : undefined,
                      transition: 'border-color 120ms, box-shadow 120ms'
                    }}
                  >
                    <CardContent>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Checkbox
                          checked={checked}
                          disabled={!canToggleSelection}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => togglePrinter(printer)}
                        />
                        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
                          <Typography level="body-sm" noWrap sx={{ minWidth: 0 }}>{printer.name}</Typography>
                          <Chip size="sm" variant="soft" color="neutral" sx={{ flexShrink: 0 }}>{printer.model}</Chip>
                        </Stack>
                        <Chip
                          size="sm"
                          variant="soft"
                          onClick={canConfirmClear
                            ? async (event) => {
                              event.stopPropagation()
                              const confirmed = await confirm({
                                title: 'Confirm build plate cleared?',
                                description: `Confirm that the build plate on ${printer.name} has been cleared?`,
                                confirmLabel: 'Plate is cleared',
                                color: 'warning'
                              })
                              if (!confirmed) {
                                return
                              }
                              try {
                                await confirmPlateCleared.mutateAsync(printer.id)
                                setSelectedIds((current) => {
                                  return current.includes(printer.id) ? current : [...current, printer.id]
                                })
                              } catch {
                                // Error state is surfaced by the mutation; keep selection unchanged.
                              }
                            }
                            : undefined}
                          color={
                            modelCompatible
                              ? plateNeedsClear
                                ? 'warning'
                                : printerStatusChipColor(status, available)
                              : 'danger'
                          }
                          sx={{
                            flexShrink: 0,
                            cursor: canConfirmClear ? 'pointer' : undefined,
                            pointerEvents: canConfirmClear ? 'auto' : undefined
                          }}
                        >
                          {modelCompatible
                            ? plateNeedsClear
                              ? 'clear plate'
                              : printerStatusChipLabel(status, available)
                            : 'model mismatch'}
                        </Chip>
                      </Stack>

                      {!modelCompatible && compatiblePrinterModels.length > 0 && (
                        <Typography level="body-xs" color="danger" sx={{ mt: 0.5 }}>
                          This file is only compatible with {compatiblePrinterModels.join(', ')}.
                        </Typography>
                      )}

                      {checked && filamentEntries.length > 0 && (
                        <Box
                          onClick={stopEventPropagation}
                          onMouseDown={stopEventPropagation}
                          onPointerDown={stopEventPropagation}
                          onTouchStart={stopEventPropagation}
                          sx={{ mt: 1 }}
                        >
                          <PrinterMapping
                            printer={printer}
                            status={status}
                            filaments={filamentEntries}
                            usedIds={usedIds}
                            usedGramsById={usedGramsById}
                            mapping={mappings[printer.id] ?? []}
                            issues={compatibilityIssuesByPrinter[printer.id] ?? []}
                            onChange={(filamentId, tray) => setSlot(printer.id, filamentId, tray)}
                          />
                        </Box>
                      )}

                      {errors[printer.id] && (
                        <Typography color="danger" level="body-xs" sx={{ mt: 0.5 }}>
                          {errors[printer.id]}
                        </Typography>
                      )}
                    </CardContent>
                  </Card>
                )
              })}
              {environmentWarningEntries.length > 0 && (
                <Stack spacing={0.5}>
                  {environmentWarningEntries.map((warning) => (
                    <Stack
                      key={warning.printerId}
                      direction="row"
                      spacing={1}
                      alignItems="flex-start"
                      sx={{ px: 0, py: 0 }}
                    >
                      <WarningAmberRoundedIcon color="warning" fontSize="small" />
                      <Stack spacing={0.25}>
                        {environmentWarningEntries.length > 1 && (
                          <Typography level="body-xs" textColor="text.tertiary">{warning.printerName}</Typography>
                        )}
                        <Typography level="body-sm" color="warning">{warning.message}</Typography>
                      </Stack>
                    </Stack>
                  ))}
                </Stack>
              )}
              {selectedTrayWarningEntries.length > 0 && (
                <Stack spacing={0.5}>
                  {selectedTrayWarningEntries.map((entry) => (
                    <Stack
                      key={`selected-tray-${entry.printerId}`}
                      direction="row"
                      spacing={1}
                      alignItems="flex-start"
                      sx={{ px: 0, py: 0 }}
                    >
                      <WarningAmberRoundedIcon color="warning" fontSize="small" />
                      <Stack spacing={0.25}>
                        {selectedTrayWarningEntries.length > 1 && (
                          <Typography level="body-xs" textColor="text.tertiary">{entry.printerName}</Typography>
                        )}
                        {entry.warnings.map((warning) => (
                          <Typography key={`${entry.printerId}-${warning}`} level="body-sm" color="warning">{warning}</Typography>
                        ))}
                      </Stack>
                    </Stack>
                  ))}
                </Stack>
              )}
            </Stack>
          </Sheet>

          <Typography level="title-sm">Print settings</Typography>
          <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
            {!hasSelectedPrinters ? (
              <Typography level="body-sm" textColor="text.tertiary">
                Select at least one printer to review print settings.
              </Typography>
            ) : (
              <Box sx={{ minWidth: 0, width: '100%', display: 'grid', gap: 1 }}>
                {visiblePrintOptionCapabilities.timelapse && (
                  <FormControl sx={printOptionFieldSx}>
                    <PrintOptionLabel label="Timelapse" />
                    <Select<'off' | 'on'>
                      value={timelapse ? 'on' : 'off'}
                      onChange={(_event, value) => value && updateTimelapse(value === 'on')}
                      size="sm"
                      sx={printOptionSelectSx}
                    >
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                    </Select>
                  </FormControl>
                )}
                {visiblePrintOptionCapabilities.bedLevel && (
                  <FormControl sx={printOptionFieldSx}>
                    <PrintOptionLabel label="Auto Bed Leveling" tooltip={printOptionHelpText.bedLevel} />
                    <Select<PrintOnOffAutoMode>
                      value={bedLevel}
                      onChange={(_event, value) => value && updateBedLevel(value)}
                      size="sm"
                      sx={printOptionSelectSx}
                    >
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                      {visiblePrintOptionCapabilities.bedLevelAuto && <Option value="auto">Auto</Option>}
                    </Select>
                  </FormControl>
                )}
                {visiblePrintOptionCapabilities.vibrationCompensation && (
                  <FormControl sx={printOptionFieldSx}>
                    <PrintOptionLabel label="Vibration Compensation" tooltip={printOptionHelpText.vibrationCompensation} />
                    <Select<'off' | 'on'>
                      value={vibrationCompensation ? 'on' : 'off'}
                      onChange={(_event, value) => value && updateVibrationCompensation(value === 'on')}
                      size="sm"
                      sx={printOptionSelectSx}
                    >
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                    </Select>
                  </FormControl>
                )}
                {visiblePrintOptionCapabilities.flowCalibration && (
                  <FormControl sx={printOptionFieldSx}>
                    <PrintOptionLabel label="Flow Dynamics Calibration" tooltip={printOptionHelpText.flowCalibration} />
                    <Select<PrintOnOffAutoMode>
                      value={flowCalibration}
                      onChange={(_event, value) => value && updateFlowCalibration(value)}
                      size="sm"
                      sx={printOptionSelectSx}
                    >
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                      {visiblePrintOptionCapabilities.flowCalibrationAuto && <Option value="auto">Auto</Option>}
                    </Select>
                  </FormControl>
                )}
                {visiblePrintOptionCapabilities.nozzleOffsetCalibration && (
                  <FormControl sx={printOptionFieldSx}>
                    <PrintOptionLabel label="Nozzle Offset Calibration" tooltip={printOptionHelpText.nozzleOffsetCalibration} />
                    <Select<PrintNozzleOffsetCalibrationMode>
                      value={nozzleOffsetCalibration}
                      onChange={(_event, value) => value && updateNozzleOffsetCalibration(value)}
                      size="sm"
                      sx={printOptionSelectSx}
                    >
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                      <Option value="auto">Auto</Option>
                    </Select>
                  </FormControl>
                )}
              </Box>
            )}
          </Sheet>

          {(hasHardNozzleDiameterIssues || hasPlateTypeIssues) && (
            <Alert
              color={hasHardNozzleDiameterIssues ? 'danger' : 'warning'}
              variant="soft"
              startDecorator={hasHardNozzleDiameterIssues ? <ErrorOutlineRoundedIcon /> : <WarningAmberRoundedIcon />}
            >
              <Stack spacing={1} sx={{ width: '100%' }}>
                <Typography level="title-sm">
                  {hasHardNozzleDiameterIssues ? 'Printer hardware must be fixed' : 'Plate type mismatch detected'}
                </Typography>
                <Typography level="body-sm">
                  {hasHardNozzleDiameterIssues
                    ? 'The sliced nozzle diameter does not match the nozzle size saved in printer settings. Update the printer on the Printers page before dispatching.'
                    : 'The saved printer plate type does not match the sliced plate type. Review and confirm before dispatching.'}
                </Typography>
                {nozzleDiameterIssueEntries.map(([printerId, issues]) => {
                  const printer = printers.find((entry) => entry.id === printerId)
                  const printerName = printer?.name ?? printerId
                  const nozzleCount = printer ? resolvePrinterNozzleCount(printer, statuses[printerId]) : null
                  return (
                    <Stack key={`nozzle-${printerId}`} spacing={0.25}>
                      <Typography level="body-sm" fontWeight="lg">{printerName}</Typography>
                      {issues.map((issue) => (
                        <Typography key={`nozzle-${printerId}-${issue.extruderId}`} level="body-xs">
                          {formatNozzleDiameterIssue(issue, nozzleCount)}
                        </Typography>
                      ))}
                    </Stack>
                  )
                })}
                {plateTypeIssueEntries.map(([printerId, issue]) => {
                  const printerName = printers.find((printer) => printer.id === printerId)?.name ?? printerId
                  return issue ? (
                    <Stack key={`plate-${printerId}`} spacing={0.25}>
                      <Typography level="body-sm" fontWeight="lg">{printerName}</Typography>
                      <Typography level="body-xs">{formatPlateTypeIssue(issue)}</Typography>
                    </Stack>
                  ) : null
                })}
                {hasPlateTypeIssues && (
                  <Checkbox
                    label="Print anyway with the current plate type"
                    checked={allowPlateTypeMismatch}
                    onChange={(event) => setAllowPlateTypeMismatch(event.target.checked)}
                  />
                )}
              </Stack>
            </Alert>
          )}

          {(hasHardCompatibilityIssues || hasSoftCompatibilityIssues) && (
            <Alert
              color={hasHardCompatibilityIssues ? 'danger' : 'warning'}
              variant="soft"
              startDecorator={hasHardCompatibilityIssues ? <ErrorOutlineRoundedIcon /> : <WarningAmberRoundedIcon />}
            >
              <Stack spacing={1} sx={{ width: '100%' }}>
                <Typography level="title-sm">
                  {hasHardCompatibilityIssues ? 'Tray assignment must be fixed' : 'Filament mismatch detected'}
                </Typography>
                <Typography level="body-sm">
                  {hasHardCompatibilityIssues
                    ? 'One or more selected trays are bound to the wrong nozzle for this sliced file. Pick a tray on the matching nozzle before dispatching.'
                    : 'One or more selected trays do not match the sliced material. Review the warnings below before dispatching.'}
                </Typography>
                {hardCompatibilityIssueEntries.map(([printerId, issues]) => {
                  const printer = printers.find((entry) => entry.id === printerId)
                  const printerName = printer?.name ?? printerId
                  const nozzleCount = printer ? resolvePrinterNozzleCount(printer, statuses[printerId]) : null
                  return (
                    <Stack key={printerId} spacing={0.25}>
                      <Typography level="body-sm" fontWeight="lg">{printerName}</Typography>
                      {issues.map((issue) => (
                        <Typography key={`${printerId}-${issue.filamentId}`} level="body-xs">
                          {formatCompatibilityIssue(issue, nozzleCount)}
                        </Typography>
                      ))}
                    </Stack>
                  )
                })}
                {softCompatibilityIssueEntries.map(([printerId, issues]) => {
                  const printer = printers.find((entry) => entry.id === printerId)
                  const printerName = printer?.name ?? printerId
                  const nozzleCount = printer ? resolvePrinterNozzleCount(printer, statuses[printerId]) : null
                  return (
                    <Stack key={`soft-${printerId}`} spacing={0.25}>
                      <Typography level="body-sm" fontWeight="lg">{printerName}</Typography>
                      {issues.map((issue) => (
                        <Typography key={`soft-${printerId}-${issue.filamentId}`} level="body-xs">
                          {formatCompatibilityIssue(issue, nozzleCount)}
                        </Typography>
                      ))}
                    </Stack>
                  )
                })}
                {hasSoftCompatibilityIssues && (
                  <Checkbox
                    label="Print anyway with the current tray assignments"
                    checked={allowIncompatibleFilament}
                    onChange={(event) => setAllowIncompatibleFilament(event.target.checked)}
                  />
                )}
              </Stack>
            </Alert>
          )}
        </Stack>
        </ScrollableDialogBody>
        <DialogActions sx={{ pt: 1, justifyContent: 'space-between' }}>
          {onBack ? (
            <Button
              variant="plain"
              color="neutral"
              startDecorator={<ArrowBackRoundedIcon />}
              onClick={onBack}
              disabled={submitting}
            >
              Back
            </Button>
          ) : (
            <Box />
          )}
          <Stack direction="row" spacing={1}>
            <Button variant="plain" onClick={onClose} disabled={submitting}>Cancel</Button>
            <Button
              loading={submitting}
              disabled={
                selectedIds.length === 0
                || !allMappingsComplete
                || hasHardCompatibilityIssues
                || hasHardNozzleDiameterIssues
                || (hasPlateTypeIssues && !allowPlateTypeMismatch)
                || (hasSoftCompatibilityIssues && !allowIncompatibleFilament)
              }
              onClick={submit}
            >
              Print on {selectedIds.length} printer{selectedIds.length === 1 ? '' : 's'}
            </Button>
          </Stack>
        </DialogActions>
        </ScrollableModalDialog>
      </Modal>
      <PluginSlot
        name="library.overlays"
        context={{ previewFileId, previewPlateIndex: plateIndex, onPreviewClose: () => setPreviewFileId(null) }}
      />
    </>
  )
}

/**
 * Per-printer tray mapping editor. For each project filament, the user
 * picks which printer tray should feed it. Filaments not
 * actually used by the selected plate are dimmed but still configurable
 * (so the user can pre-set values when later switching plates).
 *
 * Every used filament must have an explicit tray before the print can
 * be dispatched — there is no “auto” fallback because the printer
 * doesn’t actually pick slots itself.
 */
function PrinterMapping({
  printer,
  status,
  filaments,
  usedIds,
  usedGramsById,
  mapping,
  issues,
  onChange
}: {
  printer: Printer
  status: PrinterStatus | undefined
  filaments: ThreeMfProjectFilament[]
  usedIds: Set<number>
  usedGramsById: Map<number, number>
  mapping: number[]
  issues: FilamentCompatibilityIssue[]
  onChange: (filamentId: number, tray: number) => void
}) {
  const trayGroups = useMemo(() => buildPrinterTrayGroups(status), [status])
  const printerTrays = useMemo(() => trayGroups.flatMap((group) => group.trays), [trayGroups])
  const nozzleCount = resolvePrinterNozzleCount(printer, status)
  // Spool-setup dialog for unrecognized-but-occupied slots picked in the mapping.
  const [spoolSetupTarget, setSpoolSetupTarget] = useState<AmsSpoolSetupTarget | null>(null)
  const issueByFilamentId = useMemo(
    () => new Map(issues.map((issue) => [issue.filamentId, issue] as const)),
    [issues]
  )

  if (trayGroups.length === 0) {
    return (
      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 1 }}>
        {printer.name} has no reported printer trays yet — using printer default.
      </Typography>
    )
  }

  const visible = filamentsForMapping(filaments, usedIds)

  return (
    <Stack spacing={0.5} sx={{ mt: 1 }}>
      {visible.map((filament) => {
        const allowedTrayGroups = filterTrayGroupsForFilament(trayGroups, filament.nozzleId ?? null)
        const slotIndex = filament.id - 1
        const value = mapping[slotIndex] ?? -1
        const selectedTray = printerTrays.find((tray) => tray.mappingValue === value)
        const selectedUnknownTray = selectedTray && trayHasUnknownSpool(selectedTray) ? selectedTray : null
        const grams = usedGramsById.get(filament.id)
        const colorLabel = resolveProjectFilamentColorName({
          color: filament.color,
          filamentName: filament.filamentName,
          filamentType: filament.filamentType
        })
        const issue = issueByFilamentId.get(filament.id)
        const nozzleLabel = formatNozzleLabel(filament.nozzleId ?? null, 'short', nozzleCount)
        const filamentPrimaryLabel = [
          filament.filamentName ?? filament.filamentType ?? 'filament',
          colorLabel
        ].filter(Boolean).join(' · ')
        const filamentMetaLabel = [
          nozzleLabel,
          grams != null ? `${grams.toFixed(grams < 10 ? 1 : 0)}g` : null
        ].filter(Boolean).join(' · ')
        const allowedTrayByValue = new Map(
          allowedTrayGroups.flatMap((group) => group.trays.map((tray) => [tray.mappingValue, tray] as const))
        )
        return (
          <Stack key={filament.id} spacing={0.25}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: '1 1 0', minWidth: 0 }}>
                <Box
                  sx={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    backgroundColor: filament.color ?? 'var(--joy-palette-neutral-700)',
                    border: '1px solid var(--joy-palette-neutral-700)',
                    flexShrink: 0,
                    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)'
                  }}
                />
                <Stack spacing={0} sx={{ minWidth: 0, flex: '1 1 0' }}>
                  <OverflowTooltipText
                    level="body-xs"
                    sx={{ minWidth: 0 }}
                    noWrap
                    text={filamentPrimaryLabel}
                  />
                  {filamentMetaLabel ? (
                    <OverflowTooltipText
                      level="body-xs"
                      textColor="text.tertiary"
                      sx={{ minWidth: 0 }}
                      noWrap
                      text={filamentMetaLabel}
                    />
                  ) : null}
                </Stack>
              </Stack>
              <Select
                size="sm"
                value={value === -1 ? null : value}
                placeholder="Choose slot…"
                color={value === -1 || issue ? 'warning' : 'neutral'}
                onChange={(_event, next) => next != null && onChange(filament.id, next)}
                renderValue={(option) => {
                  if (!option) return <Typography level="body-xs">Choose slot…</Typography>
                  const tray = allowedTrayByValue.get(option.value as number)
                  if (!tray) return <Typography level="body-xs">Choose slot…</Typography>
                  return (
                    <SlotOptionLabel
                      tray={tray}
                      trays={printerTrays}
                      nozzleCount={nozzleCount}
                      requiredFilamentType={filament.filamentType}
                      requiredNozzleId={filament.nozzleId ?? null}
                      requiredGrams={grams ?? null}
                      autoRefillEnabled={status?.amsSettings.autoRefill === true}
                    />
                  )
                }}
                sx={{ flex: '1 1 0', minWidth: 0 }}
                slotProps={{
                  // Joy's Select button centers its content by default;
                  // the rendered value here is a flex row that needs to
                  // hug the left edge so it visually matches the option
                  // rows in the dropdown.
                  button: {
                    onClick: stopEventPropagation,
                    onMouseDown: stopEventPropagation,
                    onPointerDown: stopEventPropagation,
                    onTouchStart: stopEventPropagation,
                    sx: { textAlign: 'left', justifyContent: 'flex-start', minHeight: 40 }
                  },
                  listbox: {
                    placement: 'bottom-end',
                    modifiers: [{ name: 'equalWidth', enabled: false }],
                    sx: {
                      minWidth: { xs: 'min(92vw, 360px)', sm: 360 },
                      maxWidth: 'calc(100vw - 32px)',
                      width: 'max-content'
                    }
                  }
                }}
              >
                {(() => {
                  const nodes: ReactNode[] = []
                  for (const group of allowedTrayGroups) {
                    if (allowedTrayGroups.length > 0) {
                      nodes.push(
                        <Typography
                          key={`header-${group.key}`}
                          level="body-xs"
                          textColor="text.tertiary"
                          sx={{ px: 1, pt: 0.5, pb: 0.25, fontWeight: 'lg', textTransform: 'uppercase', letterSpacing: '0.05em' }}
                        >
                          {group.label}
                        </Typography>
                      )
                    }
                    for (const tray of group.trays) {
                      nodes.push(
                        <Option key={tray.key} value={tray.mappingValue}>
                          <SlotOptionLabel
                            tray={tray}
                            trays={printerTrays}
                            nozzleCount={nozzleCount}
                            requiredFilamentType={filament.filamentType}
                            requiredNozzleId={filament.nozzleId ?? null}
                            requiredGrams={grams ?? null}
                            autoRefillEnabled={status?.amsSettings.autoRefill === true}
                          />
                        </Option>
                      )
                    }
                  }
                  return nodes
                })()}
              </Select>
            </Stack>
            {issue && (
              <Typography level="body-xs" color="warning" sx={{ pl: 'calc(14px + 8px)' }}>
                {formatCompatibilityIssue(issue, nozzleCount)}
              </Typography>
            )}
            {selectedUnknownTray && (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ pl: 'calc(14px + 8px)' }}>
                <Typography level="body-xs" color="warning">
                  This slot holds an unrecognized spool.
                </Typography>
                <Button
                  size="sm"
                  variant="plain"
                  sx={{ minHeight: 0, py: 0 }}
                  onClick={() => setSpoolSetupTarget({
                    printerId: printer.id,
                    kind: selectedUnknownTray.kind,
                    amsId: selectedUnknownTray.kind === 'ams' ? selectedUnknownTray.amsUnitId ?? 0 : selectedUnknownTray.mappingValue,
                    ...(selectedUnknownTray.kind === 'ams' ? { slotId: selectedUnknownTray.amsSlotId ?? 0 } : {}),
                    label: `${selectedUnknownTray.groupLabel ?? 'Slot'} ${selectedUnknownTray.badgeLabel}`,
                    initial: {
                      filamentType: selectedUnknownTray.filamentType,
                      color: selectedUnknownTray.color,
                      trayInfoIdx: selectedUnknownTray.trayInfoIdx
                    }
                  })}
                >
                  Set up spool…
                </Button>
              </Stack>
            )}
          </Stack>
        )
      })}
      {spoolSetupTarget && (
        <AmsSpoolSetupDialog target={spoolSetupTarget} onClose={() => setSpoolSetupTarget(null)} />
      )}
    </Stack>
  )
}

/** Color swatch + slot label + loaded filament type + remaining estimate, used in slot Selects. */
function SlotOptionLabel({
  tray,
  trays,
  nozzleCount,
  requiredFilamentType,
  requiredNozzleId,
  requiredGrams,
  autoRefillEnabled
}: {
  tray: PrinterTrayOption
  trays: readonly PrinterTrayOption[]
  nozzleCount?: number | null
  requiredFilamentType?: string | null
  requiredNozzleId?: number | null
  requiredGrams?: number | null
  autoRefillEnabled?: boolean
}) {
  const hasFilament = trayHasLoadedFilament(tray)
  const unknownSpool = trayHasUnknownSpool(tray)
  const filament = resolveFilamentDisplay(tray)
  const brandLabel = filament.material ? `Bambu ${filament.material}` : tray.filamentType
  const filamentDetail = unknownSpool
    ? 'Unknown spool'
    : [brandLabel ?? 'Empty', filament.name].filter(Boolean).join(' · ')
  const remainingState = getSlotRemainingState({
    tray,
    trays,
    requiredFilamentType,
    requiredNozzleId,
    requiredGrams,
    autoRefillEnabled
  })
  const remainGrams = remainingState.remainGrams
  // Only spools with a readable RFID/Bambu tag (trayUuid) report remaining; third-party
  // spools have no reliable figure, so we omit the estimate rather than show a guess.
  const remainingDetail =
    hasFilament && tray.trayUuid != null && tray.remainPercent != null && remainGrams != null
      ? `${Math.round(tray.remainPercent)}% (~${remainGrams}g)`
      : null
  const typeMismatch = Boolean(
    requiredFilamentType
    && tray.filamentType
    && findFilamentCompatibilityIssues(
      [{ filamentId: 1, filamentType: requiredFilamentType, filamentName: null, nozzleId: requiredNozzleId ?? null }],
      new Map([[1, { filamentType: tray.filamentType, label: tray.label, nozzleId: tray.nozzleId }]])
    )[0]?.typeMismatch
  )
  const nozzleMismatch = Boolean(
    requiredNozzleId != null
    && (tray.nozzleId == null || requiredNozzleId !== tray.nozzleId)
  )
  const incompatibilityLabel = typeMismatch
    ? `Incompatible material: requires ${requiredFilamentType ?? 'the selected material'}${tray.filamentType ? `, slot has ${tray.filamentType}` : ''}.`
    : nozzleMismatch
      ? `Incompatible nozzle: requires ${formatNozzleLabel(requiredNozzleId ?? null, 'short', nozzleCount) ?? 'the target nozzle'}${tray.nozzleId != null ? `, slot is ${formatNozzleLabel(tray.nozzleId, 'short', nozzleCount)}` : ''}.`
      : null
  const badgeBackground = filamentBackground(filament.colors, tray.color, 'var(--joy-palette-neutral-800)')
  const badgeForeground = filamentTextColor(filament.colors, tray.color, 'var(--joy-palette-text-primary)')
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%', minWidth: 0 }}>
      <Box
        sx={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          border: '1px solid var(--joy-palette-neutral-700)',
          background: badgeBackground,
          color: badgeForeground,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '0.7rem',
          fontWeight: 'lg',
          lineHeight: 1,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)'
        }}
      >
        {tray.badgeLabel}
      </Box>
      <Box
        sx={{
          minWidth: 0,
          flex: 1,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          columnGap: 1,
          rowGap: 0.125
        }}
      >
        <Typography level="body-xs" textColor={unknownSpool ? 'warning.300' : 'text.tertiary'} noWrap sx={{ minWidth: 0, gridColumn: '1 / 2' }}>
          {filamentDetail}
        </Typography>
        {incompatibilityLabel && (
          <IncompatibilityWarningGlyph label={incompatibilityLabel} />
        )}
        {remainingDetail && (
          <Stack
            direction="row"
            spacing={0.5}
            alignItems="center"
            sx={{ gridColumn: '1 / 2', minWidth: 0 }}
          >
            <Typography
              level="body-xs"
              textColor={remainingState.insufficient ? 'danger.plainColor' : 'text.primary'}
              noWrap
              sx={{ minWidth: 0, fontWeight: remainingState.insufficient ? 'md' : undefined }}
            >
              {remainingDetail}
            </Typography>
            {remainingState.usesAutoRefill && (
              <Tooltip title="AMS auto-refill can continue this filament from another matching AMS slot." variant="soft" size="sm">
                <Box
                  component="span"
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    color: 'primary.plainColor',
                    flexShrink: 0
                  }}
                >
                  <AutoRefillGlyph />
                </Box>
              </Tooltip>
            )}
          </Stack>
        )}
      </Box>
    </Stack>
  )
}

function IncompatibilityWarningGlyph({ label }: { label: string }) {
  return (
    <Tooltip title={label} variant="soft" size="sm">
      <Box
        component="span"
        aria-label={label}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          color: 'warning.plainColor',
          flexShrink: 0,
          gridColumn: '2 / 3',
          gridRow: '1 / span 2',
          alignSelf: 'center',
          justifySelf: 'end',
          cursor: 'help'
        }}
      >
        <WarningGlyph />
      </Box>
    </Tooltip>
  )
}

function AutoRefillGlyph() {
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      aria-hidden
      sx={{ width: 14, height: 14, display: 'block', fill: 'currentColor' }}
    >
      <path d="M12 5a7 7 0 0 1 6.42 4.22H16v2h6V5h-2v2.38A9 9 0 0 0 3 12h2a7 7 0 0 1 7-7zm7 6a7 7 0 0 1-13.42 2.78H8v-2H2v6h2v-2.38A9 9 0 0 0 21 12h-2a7 7 0 0 1-7 7z" />
    </Box>
  )
}

function WarningGlyph() {
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      aria-hidden
      sx={{ width: 16, height: 16, display: 'block', fill: 'currentColor' }}
    >
      <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
    </Box>
  )
}

/**
 * Short label shown in the printer-status chip on the print dialog's
 * printer rows. Mirrors the wording used in the previous inline text:
 * "offline" when the printer isn't reachable, the stage name otherwise,
 * with "busy" appended when the printer is online but unavailable for a
 * new dispatch (e.g. mid-print).
 */
function printerStatusChipLabel(
  status: PrinterStatus | undefined,
  available: boolean
): string {
  if (!status?.online) return 'offline'
  if (!available) return `${status.stage} · busy`
  return status.stage === 'finished' ? 'idle' : status.stage
}

/**
 * Joy palette for the printer-status chip. Picks the most attention-worthy
 * tone for the printer's current state so the row reads at a glance.
 */
function printerStatusChipColor(
  status: PrinterStatus | undefined,
  available: boolean
): 'neutral' | 'primary' | 'success' | 'warning' | 'danger' {
  if (!status?.online) return 'neutral'
  if (!available) return 'warning'
  switch (status.stage) {
    case 'paused':
      return 'warning'
    case 'failed':
      return 'danger'
    case 'printing':
      return 'success'
    case 'preparing':
    case 'heating':
      return 'primary'
    case 'idle':
    case 'finished':
    case 'unknown':
    default:
      return 'neutral'
  }
}

function formatPlateTypeIssue(issue: PlateTypeMismatchIssue): string {
  if (!issue.selectedPlateType) {
    return `This file was sliced for ${issue.requiredPlateType}. Set the printer's current plate type on the Printers page or confirm the mismatch.`
  }
  return `This file was sliced for ${issue.requiredPlateType}, but the printer is set to ${issue.selectedPlateType}.`
}

function formatNozzleDiameterIssue(issue: NozzleDiameterCompatibilityIssue, nozzleCount?: number | null): string {
  const nozzleLabel = formatNozzleLabel(issue.extruderId, 'long', nozzleCount) ?? 'Required nozzle'
  const required = formatNozzleDiameterLabel(issue.requiredDiameter) ?? issue.requiredDiameter
  if (!issue.selectedDiameter) {
    return `${nozzleLabel}: select the installed nozzle size (${required} required)`
  }
  const selected = formatNozzleDiameterLabel(issue.selectedDiameter) ?? issue.selectedDiameter
  return `${nozzleLabel}: sliced for ${required}, printer is set to ${selected}`
}


function filamentsForMapping(
  filaments: ThreeMfProjectFilament[],
  usedIds: Set<number>
): ThreeMfProjectFilament[] {
  return filaments.filter((filament) => usedIds.size === 0 || usedIds.has(filament.id))
}

function trayHasLoadedFilament(tray: Pick<PrinterTrayOption, 'filamentType' | 'color' | 'colors' | 'trayInfoIdx' | 'trayName'>): boolean {
  return hasLoadedFilament(tray.filamentType, tray.color, tray.colors, {
    trayInfoIdx: tray.trayInfoIdx,
    trayName: tray.trayName
  })
}

/**
 * A spool is physically present but the printer couldn't identify it (no type,
 * colour, or tray identity). The printers view marks these with a warning "?";
 * mapping pickers must NOT call them "Empty".
 */
function trayHasUnknownSpool(tray: Pick<PrinterTrayOption, 'filamentType' | 'color' | 'colors' | 'trayInfoIdx' | 'trayName' | 'occupied'>): boolean {
  return !trayHasLoadedFilament(tray) && tray.occupied === true
}

function buildPrinterTrayGroups(status: PrinterStatus | undefined): PrinterTrayGroup[] {
  const groups: PrinterTrayGroup[] = []
  if (!status) return groups
  const nozzleCount = status.nozzles.length > 0 ? status.nozzles.length : null
  if (status.externalSpools.length > 0) {
    groups.push({
      key: 'external',
      label: 'External Spool',
      trays: status.externalSpools.map((spool) => ({
        mappingValue: spool.amsId,
        key: `external-${spool.amsId}`,
        kind: 'external',
        label: externalSpoolLabel(spool, status.externalSpools.length),
        badgeLabel: externalSpoolLabel(spool, status.externalSpools.length),
        groupLabel: 'External Spool',
        color: spool.color,
        colors: spool.colors,
        filamentType: spool.filamentType,
        trayName: spool.trayName,
        trayInfoIdx: spool.trayInfoIdx,
        remainPercent: spool.remainPercent,
        trayUuid: spool.trayUuid,
        nozzleId: spool.nozzleId
      }))
    })
  }
  for (const unit of status.ams) {
    const groupLabel = `AMS ${amsUnitLetter(unit.unitId)}`
    groups.push({
      key: `ams-${unit.unitId}`,
      label: [
        groupLabel,
        formatNozzleLabel(unit.nozzleId, 'long', nozzleCount)
      ].filter(Boolean).join(' · '),
      trays: unit.slots.map((slot) => ({
        mappingValue: unit.unitId * 4 + slot.slot,
        key: `ams-${unit.unitId}-${slot.slot}`,
        kind: 'ams',
        label: `Slot ${slot.slot + 1}`,
        badgeLabel: `${amsUnitLetter(unit.unitId)}${slot.slot + 1}`,
        groupLabel,
        color: slot.color,
        colors: slot.colors,
        filamentType: slot.filamentType,
        trayName: slot.trayName,
        trayInfoIdx: slot.trayInfoIdx,
        remainPercent: slot.remainPercent,
        trayUuid: slot.trayUuid,
        nozzleId: unit.nozzleId,
        occupied: slot.occupied ?? null,
        amsUnitId: unit.unitId,
        amsSlotId: slot.slot
      }))
    })
  }
  return groups
}

function buildPrinterTrayMap(status: PrinterStatus | undefined): Map<number, PrinterTrayOption> {
  return new Map(
    buildPrinterTrayGroups(status).flatMap((group) => group.trays.map((tray) => [tray.mappingValue, tray] as const))
  )
}

function printerHasSelectableTrays(status: PrinterStatus | undefined): boolean {
  if (!status) return false
  if (status.externalSpools.length > 0) return true
  return status.ams.some((unit) => unit.slots.length > 0)
}

function isExternalSpoolMappingValue(value: number): boolean {
  return value === VIRTUAL_TRAY_MAIN_ID || value === VIRTUAL_TRAY_DEPUTY_ID
}

function externalSpoolLabel(spool: ExternalSpool, spoolCount: number): string {
  if (spoolCount > 1) {
    return spool.amsId === VIRTUAL_TRAY_MAIN_ID ? 'Ext-R' : 'Ext-L'
  }
  return 'Ext'
}

function formatCompatibilityIssue(issue: FilamentCompatibilityIssue, nozzleCount?: number | null): string {
  const subject = `#${issue.filamentId} ${issue.requiredFilamentName ?? issue.requiredFilamentType ?? 'filament'}`
  const trayLabel = issue.trayLabel ?? 'selected tray'
  const parts: string[] = []

  if (issue.typeMismatch) {
    parts.push(`${trayLabel} has ${issue.selectedFilamentType ?? 'an unknown material'}, expected ${issue.requiredFilamentType ?? 'the sliced material'}`)
  }
  if (issue.nozzleMismatch) {
    parts.push(`${trayLabel} feeds ${formatNozzleLabel(issue.trayNozzleId, 'long', nozzleCount) ?? 'the wrong nozzle'}, expected ${formatNozzleLabel(issue.nozzleId, 'long', nozzleCount) ?? 'the target nozzle'}`)
  }

  return `${subject}: ${parts.join('; ')}`
}

function getSelectedTrayWarningMessages(input: {
  mapping: number[]
  trayByMappingValue: Map<number, PrinterTrayOption>
  filaments: ThreeMfProjectFilament[]
  timelapse: boolean
  status: PrinterStatus | undefined
}): string[] {
  const warnings = new Set<string>()
  let hasAms = false
  let hasExternal = false

  for (const filament of input.filaments) {
    const mappingValue = input.mapping[filament.id - 1]
    if (typeof mappingValue !== 'number' || mappingValue < 0) continue
    const tray = input.trayByMappingValue.get(mappingValue)
    if (!tray) continue
    hasAms = hasAms || tray.kind === 'ams'
    hasExternal = hasExternal || tray.kind === 'external'
    if (!tray.filamentType && !tray.trayInfoIdx) {
      warnings.add('One or more selected trays have unknown filament details. Check the printer before starting the print.')
    }
  }

  if (hasAms && hasExternal) {
    warnings.add('This tray assignment mixes AMS slots and external spools. Review the mapping before printing.')
  }
  if (input.timelapse && input.status?.sdCardPresent === false) {
    warnings.add('Timelapse is enabled, but the printer reports no SD card.')
  }

  return Array.from(warnings)
}

function resolvePrinterNozzleCount(printer: Printer, status: PrinterStatus | undefined): number | null {
  if (status?.nozzles.length) return status.nozzles.length
  if (printer.currentNozzleDiameters.length > 0) return printer.currentNozzleDiameters.length
  return null
}

