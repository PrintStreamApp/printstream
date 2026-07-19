import { useDeferredValue, useMemo, useState, type ReactNode } from 'react'
import { Box, Button, CircularProgress, ModalClose, Stack, Typography } from '@mui/joy'
import Inventory2RoundedIcon from '@mui/icons-material/Inventory2Rounded'
import { useQuery } from '@tanstack/react-query'
import { EmptyState } from '../../components/EmptyState'
import { LibraryBreadcrumb, LibraryBreadcrumbRow } from '../../components/LibraryBreadcrumb'
import { LibraryPickerEmptyState } from '../../components/LibraryPickerEmptyState'
import { isDirectPrintableFileName, isPrinterModelCompatible, type LibraryBrowseResponse, type LibraryFile, type LibraryFolder, type PrinterModel } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { buildLibraryBreadcrumb, isBridgeFolderId, fromBridgeFolderId, toBridgeFolderId } from '../../lib/libraryNavigation'
import { isUnslicedThreeMfFile } from '../../lib/libraryFileTags'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { DialogSection } from '../../components/DialogSection'
import { DirectoryPrimaryToolbar } from '../../components/DirectoryToolbar'
import { SearchScopeToggle } from '../../components/library/SearchScopeToggle'
import { LibraryMetadataFilters } from '../../components/library/LibraryMetadataFilters'
import { PaginatedLibraryBrowser } from '../../components/library/PaginatedLibraryBrowser'
import { LibraryBrowser, type LibrarySort, type LibraryViewMode } from '../../components/LibraryBrowser'
import { libraryFacetsEmpty, useLibraryFilters } from '../../hooks/useLibraryFilters'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import { LIBRARY_GROUP_OPTIONS, type LibraryGroupBy } from '../../lib/libraryDirectory'
import { parseLibraryViewMode, parseLibrarySort } from '../../lib/printersViewHelpers'
import { LIBRARY_VIEW_MODE_KEY, LIBRARY_SORT_KEY, LIBRARY_GROUP_KEY, LIBRARY_PAGE_SIZE_OPTIONS, LIBRARY_SORT_OPTIONS, parseLibraryGroup } from '../../lib/libraryViewHelpers'

/**
 * Lightweight library picker used by the printer card's "Print" button.
 *
 * Mirrors {@link LibraryView}'s folder navigation (root listing + drill-in) and
 * reuses the same toolbar (`DirectoryPrimaryToolbar`), filters
 * (`useLibraryFilters` + `LibraryMetadataFilters`), grouping, and pagination
 * (`PaginatedLibraryBrowser`) so the picker is inline with the Library page. It
 * only surfaces direct-printable files; when launched from a specific printer
 * card, incompatible files stay visible for context but are disabled with a
 * short compatibility note before handing control back to {@link PrintModal}.
 */
export function LibraryPickerModal({
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
  // List mode is a narrow column; icon mode grows wider so the responsive tile grid
  // can fit more thumbnails per row (the grid auto-fills columns to the width).
  const PICKER_LIST_DIALOG_MAX_WIDTH = 640
  const PICKER_ICON_DIALOG_MAX_WIDTH = 'min(960px, 96vw)'
  const [folderId, setFolderId] = useState<string | null>(null)
  const [bridgeId, setBridgeId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [searchAllFolders, setSearchAllFolders] = useState(false)
  const allFolderSearch = searchAllFolders ? deferredSearch.trim() : ''
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
  const [group, setGroup] = useLocalStorageState<LibraryGroupBy>(LIBRARY_GROUP_KEY, 'none', parseLibraryGroup, String)
  const [favoritesOnly, setFavoritesOnly] = useState(false)

  const browseQuery = useQuery({
    queryKey: ['library-browse', 'printer-picker', folderId ?? 'root', bridgeId ?? 'none', allFolderSearch, favoritesOnly],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      if (folderId) params.set('folderId', folderId)
      if (bridgeId) params.set('bridgeId', bridgeId)
      if (allFolderSearch) params.set('search', allFolderSearch)
      if (favoritesOnly) params.set('favoritesOnly', 'true')
      const query = params.toString()
      return apiFetch<LibraryBrowseResponse>(`/api/library/browse${query ? `?${query}` : ''}`, { signal })
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
  const bridgeEntries = useMemo(() => browseData?.bridgeEntries ?? [], [browseData?.bridgeEntries])
  const bridgeFolders = useMemo(
    () => bridgeEntries.map((bridge) => ({ id: toBridgeFolderId(bridge.id), name: bridge.name, parentId: null } satisfies LibraryFolder)),
    [bridgeEntries]
  )
  const allFolders = foldersQuery.data?.folders ?? []
  const pickerFiles = useMemo(
    () => (browseData?.files ?? []).filter((file) => isDirectPrintableFileName(file.name) || (canSlice && isUnslicedThreeMfFile(file))),
    [browseData?.files, canSlice]
  )
  const childFolders = useMemo(
    () => (bridgeRootMode ? bridgeFolders : (browseData?.folders ?? [])),
    [bridgeFolders, bridgeRootMode, browseData?.folders]
  )

  const filters = useLibraryFilters({
    visibleFiles: pickerFiles,
    childFolders,
    currentFolderId: folderId,
    requestedBridgeId: resolvedBridgeId,
    deferredSearch,
    sort,
    favoritesOnly
  })

  const activeBridgeName = resolvedBridgeId ? bridgeEntries.find((bridge) => bridge.id === resolvedBridgeId)?.name ?? null : null
  const breadcrumb = buildLibraryBreadcrumb(allFolders, folderId, resolvedBridgeId, activeBridgeName, {
    showRoot: bridgeEntries.length !== 1
  })

  /**
   * Single entry point for folder moves (browser rows/tiles and the breadcrumb alike).
   * Clearing the search is what makes a searched-for folder reachable: in "All folders"
   * scope the API ignores `folderId` while `search` is set and re-returns the same flat
   * whole-bridge list, so the click would otherwise appear to do nothing.
   */
  const navigateToFolder = (folderEntryId: string | null) => {
    setSearch('')
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
  }

  const pickerEmptyState = favoritesOnly
    ? <LibraryPickerEmptyState favoritesOnly />
    : deferredSearch.trim()
      ? <LibraryPickerEmptyState searching />
      : (
          <EmptyState
            icon={<Inventory2RoundedIcon />}
            title={bridgeRootMode ? 'No bridges connected' : 'No files here'}
            description={
              filters.activeMetadataFilterCount > 0
                ? 'No files match the current filters.'
                : bridgeRootMode
                  ? 'Connect a bridge to browse its files.'
                  : canSlice ? 'No printable or slicable files to pick here.' : 'No printable files to pick here.'
            }
          />
        )

  const renderBrowser = (folders: LibraryFolder[], files: LibraryFile[], emptyStateNode?: ReactNode) => {
    return (
      <LibraryBrowser
        folders={folders}
        files={files}
        viewMode={viewMode}
        sort={sort}
        surfaceStyle="dialog"
        hideFilamentSwatches
        emptyState={emptyStateNode}
        onFolderOpen={(folder) => navigateToFolder(folder.id)}
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
      />
    )
  }

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog
        sx={{
          maxWidth: viewMode === 'icon' ? PICKER_ICON_DIALOG_MAX_WIDTH : PICKER_LIST_DIALOG_MAX_WIDTH,
          width: '100%'
        }}
      >
        <ModalClose />
        <Typography level="h4">{printerName ? `Print on ${printerName}` : 'Print from library'}</Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, p: 0 }}>
        <Typography level="body-sm" textColor="text.tertiary" sx={{ mb: 1 }}>
          Choose a file from your library.
        </Typography>

        <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
          <DialogSection title="Location">
              <LibraryBreadcrumbRow favoritesOnly={favoritesOnly} onFavoritesOnlyChange={setFavoritesOnly}>
                <LibraryBreadcrumb
                  crumbs={breadcrumb}
                  onNavigate={navigateToFolder}
                />
              </LibraryBreadcrumbRow>
          </DialogSection>

          <DialogSection title="Files">
              <Stack spacing={1}>
                <DirectoryPrimaryToolbar
                  pinnable={false}
                  searchValue={search}
                  onSearchChange={setSearch}
                  searchPlaceholder="Search files and folders"
                  searchAriaLabel="Search print library"
                  searchEndDecorator={<SearchScopeToggle allFolders={searchAllFolders} onChange={setSearchAllFolders} />}
                  filters={{
                    activeCount: filters.activeMetadataFilterCount,
                    onClear: filters.clearMetadataFilters,
                    clearDisabled: filters.activeMetadataFilterCount === 0,
                    disabled: libraryFacetsEmpty(filters),
                    children: <LibraryMetadataFilters filters={filters} />
                  }}
                  grouping={{ value: group, options: LIBRARY_GROUP_OPTIONS, onChange: setGroup }}
                  pageSizeValue={filters.pageSize}
                  pageSizeOptions={LIBRARY_PAGE_SIZE_OPTIONS.map((value) => ({ value, label: `${value} per page` }))}
                  onPageSizeChange={(value) => filters.setPageSize(value as (typeof LIBRARY_PAGE_SIZE_OPTIONS)[number])}
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
                  compactControls
                />

                <Box sx={{ width: '100%', maxWidth: '100%' }}>
                  <PaginatedLibraryBrowser
                    loading={browseQuery.isLoading}
                    loadingNode={
                      <Stack spacing={1} alignItems="center" sx={{ py: 4 }}>
                        <CircularProgress size="sm" />
                        <Typography level="body-sm" textColor="text.tertiary">Loading library…</Typography>
                      </Stack>
                    }
                    group={group}
                    sort={sort}
                    filteredFolders={filters.filteredFolders}
                    filteredFiles={filters.filteredFiles}
                    filteredItemCount={filters.filteredItemCount}
                    pagedFolders={filters.pagedFolders}
                    pagedFiles={filters.pagedFiles}
                    pagination={{
                      showingLabel: filters.showingLabel,
                      currentPage: filters.currentPage,
                      pageCount: filters.pageCount,
                      onPageChange: filters.setPage
                    }}
                    emptyState={pickerEmptyState}
                    renderBrowser={renderBrowser}
                  />
                </Box>
              </Stack>
          </DialogSection>
        </Stack>
        </ScrollableDialogBody>

        <Stack direction="row" justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onClose}>Cancel</Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}
