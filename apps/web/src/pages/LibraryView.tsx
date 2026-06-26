/**
 * Library top-level view: browse folders/files, upload, rename/move/recycle,
 * file versions, and the in-view 3D preview overlay. It hosts the shared
 * slice/print dialog stack defined in `components/library/` — `SliceFileModal`,
 * `SliceThenPrintModal`, `SliceResultModal`, `PrintModal`, and the
 * `SliceSettingsPanel`/`SliceSettingsController` (the latter also drives the
 * model studio's borrowed slice config).
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import {
  Alert, Box, Button, ButtonGroup, CircularProgress, Dropdown, IconButton,
  Menu, MenuButton, MenuItem, Sheet, Stack, Tooltip, Typography
} from '@mui/joy'
import CreateNewFolderRoundedIcon from '@mui/icons-material/CreateNewFolderRounded'
import FolderCopyRoundedIcon from '@mui/icons-material/FolderCopyRounded'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import DriveFolderUploadRoundedIcon from '@mui/icons-material/DriveFolderUploadRounded'
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
import DesignServicesRoundedIcon from '@mui/icons-material/DesignServicesRounded'
import RestoreFromTrashRoundedIcon from '@mui/icons-material/RestoreFromTrashRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import StarRoundedIcon from '@mui/icons-material/StarRounded'
import StarBorderRoundedIcon from '@mui/icons-material/StarBorderRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  LibraryBrowseResponse,
  LibraryFile,
  LibraryFileVersion,
  LibraryFolder,
  SlicingCapabilities,
  SlicingJobResponse,
  Permission,
  Printer,
  PrinterStatus
} from '@printstream/shared'
import {
  LIBRARY_DOWNLOAD_PERMISSION,
  LIBRARY_MANAGE_PERMISSION,
  LIBRARY_UPLOAD_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION,
  isDirectPrintableFileName
} from '@printstream/shared'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { apiFetch } from '../lib/apiClient'
import { buildApiUrl } from '../lib/apiUrl'
import { invalidateLibraryQueries } from '../lib/libraryQueryInvalidation'
import { useAuthBootstrapQuery } from '../lib/authQuery'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../lib/workspaceScope'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { useMobileViewport } from '../components/useMobileViewport'
import { EmptyState } from '../components/EmptyState'
import { LibraryBreadcrumb } from '../components/LibraryBreadcrumb'
import { LibraryRecycleBinModal } from '../components/LibraryRecycleBinModal'
import { CreateFolderModal, MoveFolderModal, RenameFolderModal } from '../components/library/LibraryFolderDialogs'
import { RenameFileModal } from '../components/library/RenameFileModal'
import { MoveFileModal, MoveFilesModal } from '../components/library/MoveFilesDialog'
import { FileHistoryDialog } from '../components/library/FileHistoryDialog'
import { NoConnectedBridgesEmptyState } from '../components/NoConnectedBridgesEmptyState'
import { usePromptDialog } from '../components/PromptDialogProvider'
import { DirectoryPrimaryToolbar } from '../components/DirectoryToolbar'
import { SearchScopeToggle } from '../components/library/SearchScopeToggle'
import {
  LIBRARY_DRAG_MIME,
  LibraryBrowser,
  type LibraryDragItem,
  type LibrarySort,
  type LibraryViewMode
} from '../components/LibraryBrowser'
import { PluginSlot } from '../plugin/PluginSlot'
import { formatLibraryFileName } from '../lib/libraryDisplay'
import { parseLibraryDragItem } from '../lib/libraryDragItem'
import { isPreviewOnlyLibraryFile, isUnslicedThreeMfFile } from '../lib/libraryFileTags'
import { LIBRARY_GROUP_OPTIONS, type LibraryGroupBy } from '../lib/libraryDirectory'
import { getMeshThumbnailProvider } from '../lib/modelThumbnailRegistry'
import { buildLibraryBreadcrumb, buildLibraryFavoritesRoute, buildLibraryFolderRoute, fromBridgeFolderId, isBridgeFolderId, isLibraryFavoritesPath, toBridgeFolderId } from '../lib/libraryNavigation'
import { buildTenantWorkspacePath } from '../lib/workspaceRoute'
import { enqueueLibraryUploads, type LibraryUploadDestination } from '../lib/libraryUploadQueue'
import {
  collectUploadTreeFromDataTransfer,
  collectUploadTreeFromFileList,
  type LibraryUploadTreeItem
} from '../lib/libraryUploadTree'
import { useRuntimePolicy } from '../lib/runtimePolicy'
import { toast } from '../lib/toast'
import { useControlledMenuClickAway } from '../hooks/useControlledMenuClickAway'
import { libraryFacetsEmpty, useLibraryFilters } from '../hooks/useLibraryFilters'
import { LibraryMetadataFilters } from '../components/library/LibraryMetadataFilters'
import { PaginatedLibraryBrowser } from '../components/library/PaginatedLibraryBrowser'
import { useLibrarySelection } from '../hooks/useLibrarySelection'
import {
  LIBRARY_GROUP_KEY,
  LIBRARY_PAGE_SIZE_OPTIONS,
  LIBRARY_SORT_KEY,
  LIBRARY_SORT_OPTIONS,
  LIBRARY_VIEW_MODE_KEY,
  parseLibraryGroup,
  parseLibrarySort,
  parseLibraryViewMode,
  PUBLIC_DEMO_LIBRARY_UPLOAD_NOTICE,
  toHistoryPrintFile,
  type SliceFileSubmitAction,
  type SliceFileSubmitInput
} from '../lib/libraryViewHelpers'
import { PrintModal } from '../components/library/PrintModal'
import { SliceFileModal } from '../components/library/SliceFileModal'
import { SliceResultModal, SliceThenPrintModal } from '../components/library/SliceThenPrintModal'

type LibraryContextMenuState =
  | { kind: 'file'; file: LibraryFile; x: number; y: number }
  | { kind: 'folder'; folder: LibraryFolder; x: number; y: number }

type LibraryPrintTarget = {
  file: LibraryFile
  versionId: string | null
}

type SliceThenPrintTarget = {
  sourceFile: LibraryFile
  jobId: string
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
  const location = useLocation()
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
  const [renameFolderTarget, setRenameFolderTarget] = useState<LibraryFolder | null>(null)
  const [moveFolderTarget, setMoveFolderTarget] = useState<LibraryFolder | null>(null)
  const [contextMenu, setContextMenu] = useState<LibraryContextMenuState | null>(null)
  const [contextMenuAnchorEl, setContextMenuAnchorEl] = useState<HTMLDivElement | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [recycleBinOpen, setRecycleBinOpen] = useState(false)
  const [dragMoveError, setDragMoveError] = useState<string | null>(null)
  const [draggedLibraryItem, setDraggedLibraryItem] = useState<LibraryDragItem | null>(null)
  const isMobileViewport = useMobileViewport()
  const [viewMode, setViewMode] = useLocalStorageState<LibraryViewMode>(
    LIBRARY_VIEW_MODE_KEY,
    'list',
    parseLibraryViewMode,
    String
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

  // Search box state lives here (not in useLibraryFilters) so the "All folders" scope can also drive
  // the browse query below. When that scope is on and there's a term, browse searches the whole
  // bridge server-side; otherwise it lists the current folder and useLibraryFilters filters locally.
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [searchAllFolders, setSearchAllFolders] = useState(false)
  const allFolderSearch = searchAllFolders ? deferredSearch.trim() : ''
  // Sort + "favorites only" live here (not in useLibraryFilters) because they drive
  // the browse query: the API applies them before its recency cap, so the top files
  // / a user's favorites surface even past the cap. The hook still re-sorts the
  // returned page client-side (and owns the metadata filters).
  const [sort, setSort] = useLocalStorageState<LibrarySort>(LIBRARY_SORT_KEY, { key: 'name', dir: 'asc' }, parseLibrarySort)
  const [group, setGroup] = useLocalStorageState<LibraryGroupBy>(LIBRARY_GROUP_KEY, 'none', parseLibraryGroup, String)
  // "Favorite Files" is its own route (bookmarkable + in history). Derive the mode
  // from the path rather than local state; the toggle navigates to/from it.
  const favoritesOnly = isLibraryFavoritesPath(location.pathname)

  const browseQuery = useQuery({
    queryKey: ['library-browse', currentFolderId ?? 'root', requestedBridgeId ?? 'none', allFolderSearch, sort.key, sort.dir, favoritesOnly],
    queryFn: () => {
      const params = new URLSearchParams()
      if (currentFolderId) params.set('folderId', currentFolderId)
      if (requestedBridgeId) params.set('bridgeId', requestedBridgeId)
      if (allFolderSearch) params.set('search', allFolderSearch)
      params.set('sort', sort.key)
      params.set('dir', sort.dir)
      if (favoritesOnly) params.set('favoritesOnly', 'true')
      const query = params.toString()
      return apiFetch<LibraryBrowseResponse>(`/api/library/browse${query ? `?${query}` : ''}`)
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
    enabled: authBootstrapQuery.isSuccess ? (canUploadLibrary && canViewLibrary) : false,
    // When the slicer is configured but not yet healthy (e.g. restarting), keep polling so
    // the editor/slice UI recovers on its own — the user just waits instead of hitting a
    // dead-end "reopen the editor" error.
    refetchInterval: (query) => {
      const data = query.state.data
      return data?.configured && !data.healthy ? 4000 : false
    }
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
  // The server caps a single folder/search at a fixed file count and flags the
  // overflow so a huge folder can't balloon one response. Surface it instead of
  // silently dropping rows — the user narrows via a subfolder or search.
  const browseTruncated = browseData?.truncated ?? false
  const browseFileLimitLabel = browseData?.fileLimit?.toLocaleString() ?? ''
  const libraryFilters = useLibraryFilters({ visibleFiles, childFolders, currentFolderId, requestedBridgeId, deferredSearch, sort, favoritesOnly })
  // Only the fields referenced outside the shared filters/pagination components
  // are destructured; the rest are passed straight through via `libraryFilters`.
  const {
    pageSize,
    setPageSize,
    activeMetadataFilterCount,
    filteredFiles,
    clearMetadataFilters
  } = libraryFilters
  const {
    selectionMode,
    setSelectionMode,
    selectedFileIds,
    setSelectedFileIds,
    moveSelectionTarget,
    setMoveSelectionTarget,
    selectedVisibleFiles,
    toggleSelectedFile,
    setAllVisibleFilesSelected
  } = useLibrarySelection({ filteredFiles, visibleFiles, currentFolderId, canManageLibrary })
  const breadcrumb = useMemo(
    () => buildLibraryBreadcrumb(allFolders, currentFolderId, activeBridgeId, activeBridgeName, {
      showRoot: showGlobalRootBreadcrumb
    }),
    [activeBridgeId, activeBridgeName, allFolders, currentFolderId, showGlobalRootBreadcrumb]
  )

  useEffect(() => {
    setContextMenu(null)
  }, [currentFolderId, selectionMode])

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

  // Personal favorite star. Optimistically flips the star across loaded browse
  // pages for instant feedback, then reconciles with the server (which also drops
  // unfavorited files from the "favorites only" view) once the request settles.
  const toggleFavorite = useMutation({
    mutationFn: ({ file, favorite }: { file: LibraryFile; favorite: boolean }) =>
      apiFetch<{ file: LibraryFile }>(`/api/library/${file.id}/favorite`, { method: 'PUT', body: { favorite } }),
    onMutate: ({ file, favorite }) => {
      queryClient.setQueriesData<LibraryBrowseResponse>({ queryKey: ['library-browse'] }, (prev) =>
        prev ? { ...prev, files: prev.files.map((entry) => (entry.id === file.id ? { ...entry, favorite } : entry)) } : prev
      )
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to update favorite')
    },
    onSettled: invalidateAll
  })
  const handleToggleFavorite = useCallback(
    (file: LibraryFile) => toggleFavorite.mutate({ file, favorite: !file.favorite }),
    [toggleFavorite]
  )

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
    : favoritesOnly
      ? (
          <EmptyState
            icon={<StarBorderRoundedIcon />}
            title="No favorite files yet"
            description="Open any file's ⋮ menu and choose Favorite to keep it here for quick access."
            action={(
              <Button
                size="sm"
                variant="soft"
                startDecorator={<FolderOpenRoundedIcon />}
                onClick={() => navigate(buildLibraryFolderRoute(tenantSlug ?? '', null, activeBridgeId))}
              >
                Browse library
              </Button>
            )}
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

  const renderBrowser = (browserFolders: LibraryFolder[], browserFiles: LibraryFile[], emptyStateNode?: ReactNode) => (
    <LibraryBrowser
      folders={browserFolders}
      files={browserFiles}
      viewMode={viewMode}
      sort={sort}
      emptyState={emptyStateNode}
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
              canDownload: canDownloadLibrary,
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
        {canViewLibrary && (
          <MenuItem onClick={() => {
            onAction?.()
            handleToggleFavorite(file)
          }}>
            {file.favorite ? <StarRoundedIcon /> : <StarBorderRoundedIcon />} {file.favorite ? 'Unfavorite' : 'Favorite'}
          </MenuItem>
        )}
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
      {browseTruncated && (
        <Alert color="neutral" variant="soft" startDecorator={<InfoOutlinedIcon />}>
          <Typography level="body-sm">
            {allFolderSearch
              ? `Showing the first ${browseFileLimitLabel} matches. Refine your search to narrow the results.`
              : `Showing the first ${browseFileLimitLabel} files here. Open a subfolder or use search to find the rest.`}
          </Typography>
        </Alert>
      )}
      <Stack spacing={1}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Typography level="h3" startDecorator={<FolderCopyRoundedIcon />}>Library</Typography>
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
          {favoritesOnly ? (
            // Favorites is its own flat, cross-folder view: stand in a static location
            // label for the folder breadcrumb while it's active.
            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
              <StarRoundedIcon htmlColor="gold" fontSize="small" />
              <Typography level="title-md" noWrap>Favorite Files</Typography>
            </Stack>
          ) : (
            <LibraryBreadcrumb
              crumbs={breadcrumb}
              onNavigate={navigateToFolder}
              onCrumbDrop={bridgeRootMode ? undefined : handleDropToBreadcrumb}
              draggedItem={draggedLibraryItem}
            />
          )}
        </Box>
        {!bridgeRootMode && (
          <Tooltip title={favoritesOnly ? 'Showing favorites only' : 'Show favorites only'} variant="soft">
            <IconButton
              size="sm"
              variant={favoritesOnly ? 'solid' : 'plain'}
              color={favoritesOnly ? 'warning' : 'neutral'}
              aria-label="Show favorites only"
              aria-pressed={favoritesOnly}
              onClick={() => navigate(favoritesOnly
                ? buildLibraryFolderRoute(tenantSlug ?? '', null, activeBridgeId)
                : buildLibraryFavoritesRoute(tenantSlug ?? '', activeBridgeId))}
              sx={{ flexShrink: 0 }}
            >
              {favoritesOnly ? <StarRoundedIcon /> : <StarBorderRoundedIcon />}
            </IconButton>
          </Tooltip>
        )}
        {canManageLibrary && !bridgeRootMode && (
          <Tooltip title="Recycle bin" variant="soft">
            <IconButton size="sm" variant="plain" color="neutral" aria-label="Recycle bin" onClick={() => setRecycleBinOpen(true)} sx={{ flexShrink: 0 }}>
              <RestoreFromTrashRoundedIcon />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      <DirectoryPrimaryToolbar
        pinStorageKey="library"
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search files and folders"
        searchAriaLabel="Search library"
        searchEndDecorator={<SearchScopeToggle allFolders={searchAllFolders} onChange={setSearchAllFolders} />}
        filters={{
          activeCount: activeMetadataFilterCount,
          onClear: clearMetadataFilters,
          clearDisabled: activeMetadataFilterCount === 0,
          disabled: libraryFacetsEmpty(libraryFilters),
          children: <LibraryMetadataFilters filters={libraryFilters} />
        }}
        grouping={{ value: group, options: LIBRARY_GROUP_OPTIONS, onChange: setGroup }}
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
      />

      {dragMoveError && <Typography color="danger" level="body-sm">{dragMoveError}</Typography>}

      <PaginatedLibraryBrowser
        loading={libraryBrowserLoading}
        loadingNode={
          <Stack direction="row" spacing={1} alignItems="center" justifyContent="center" sx={{ py: 6 }}>
            <CircularProgress size="sm" />
            <Typography level="body-sm" textColor="text.tertiary">Loading library…</Typography>
          </Stack>
        }
        group={group}
        sort={sort}
        filteredFolders={libraryFilters.filteredFolders}
        filteredFiles={filteredFiles}
        filteredItemCount={libraryFilters.filteredItemCount}
        pagedFolders={libraryFilters.pagedFolders}
        pagedFiles={libraryFilters.pagedFiles}
        pagination={{
          showingLabel: libraryFilters.showingLabel,
          currentPage: libraryFilters.currentPage,
          pageCount: libraryFilters.pageCount,
          onPageChange: libraryFilters.setPage
        }}
        emptyState={libraryEmptyState}
        renderBrowser={renderBrowser}
      />
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
