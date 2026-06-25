/**
 * Reusable "choose a library file" dialog.
 *
 * The sibling `LibraryDestinationDialog` chooses *where* to save a file; this
 * dialog chooses *which* file to open. Both share the same browsing surface
 * (`LibraryBrowser` + breadcrumb + list/icon toggle) so picking a file looks and
 * navigates exactly like picking a destination. Folders drill in; clicking a
 * file calls `onPick` and the caller closes the dialog. The toolbar, filters,
 * grouping, and pagination are the shared library primitives, so the dialog
 * stays inline with the Library page.
 *
 * Files are loaded per-folder from `/api/library/browse`, including bridge-root
 * mode where the top level lists bridges instead of folders.
 */
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react'
import { Alert, Box, Button, CircularProgress, Sheet, Stack, Typography } from '@mui/joy'
import { useQuery } from '@tanstack/react-query'
import type { LibraryBrowseResponse, LibraryFile, LibraryFolder } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import {
  buildLibraryBreadcrumb,
  fromBridgeFolderId,
  isBridgeFolderId,
  toBridgeFolderId
} from '../lib/libraryNavigation'
import { LIBRARY_GROUP_OPTIONS, type LibraryGroupBy } from '../lib/libraryDirectory'
import { LIBRARY_PAGE_SIZE_OPTIONS, LIBRARY_SORT_OPTIONS } from '../lib/libraryViewHelpers'
import { LibraryBreadcrumb, LibraryBreadcrumbRow } from './LibraryBreadcrumb'
import { LibraryPickerEmptyState } from './LibraryPickerEmptyState'
import { BackAwareModal as Modal } from './BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import { LibraryBrowser, type LibrarySort, type LibraryViewMode } from './LibraryBrowser'
import { DirectoryPrimaryToolbar } from './DirectoryToolbar'
import { LibraryMetadataFilters } from './library/LibraryMetadataFilters'
import { PaginatedLibraryBrowser } from './library/PaginatedLibraryBrowser'
import { libraryFacetsEmpty, useLibraryFilters } from '../hooks/useLibraryFilters'

export function LibraryFilePickerDialog({
  title,
  description,
  details,
  initialBridgeId = null,
  acceptFile,
  emptyState,
  dialogWidth = 920,
  onPick,
  onClose
}: {
  title: string
  description?: string
  details?: ReactNode
  /** Bridge to scope to initially. Defaults to the active/first bridge. */
  initialBridgeId?: string | null
  /** When set, only files matching the predicate are listed (others are hidden). */
  acceptFile?: (file: LibraryFile) => boolean
  /** Empty-state shown when a folder holds no pickable files. */
  emptyState?: ReactNode
  dialogWidth?: number
  onPick: (file: LibraryFile) => void
  onClose: () => void
}) {
  const [folderId, setFolderId] = useState<string | null>(null)
  const [bridgeId, setBridgeId] = useState<string | null>(initialBridgeId)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [viewMode, setViewMode] = useState<LibraryViewMode>('list')
  const [sort, setSort] = useState<LibrarySort>({ key: 'name', dir: 'asc' })
  const [group, setGroup] = useState<LibraryGroupBy>('none')
  const [favoritesOnly, setFavoritesOnly] = useState(false)

  const browseQuery = useQuery({
    queryKey: ['library-file-picker-browse', folderId ?? 'root', bridgeId ?? 'none', favoritesOnly],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      if (folderId) params.set('folderId', folderId)
      if (bridgeId) params.set('bridgeId', bridgeId)
      if (favoritesOnly) params.set('favoritesOnly', 'true')
      const qs = params.toString()
      return apiFetch<LibraryBrowseResponse>(`/api/library/browse${qs ? `?${qs}` : ''}`, { signal })
    }
  })
  const browseData = browseQuery.data
  const resolvedBridgeId = browseData?.activeBridgeId ?? bridgeId
  const foldersQuery = useQuery({
    queryKey: ['library-file-picker-folders', resolvedBridgeId ?? 'none'],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      if (resolvedBridgeId) params.set('bridgeId', resolvedBridgeId)
      const qs = params.toString()
      return apiFetch<{ folders: LibraryFolder[] }>(`/api/library/folders${qs ? `?${qs}` : ''}`, { signal })
    }
  })

  const bridgeRootMode = browseData?.mode === 'bridge-root'
  const bridgeEntries = useMemo(() => browseData?.bridgeEntries ?? [], [browseData?.bridgeEntries])
  const bridgeFolders = useMemo(
    () => bridgeEntries.map((bridge) => ({ id: toBridgeFolderId(bridge.id), name: bridge.name, parentId: null } satisfies LibraryFolder)),
    [bridgeEntries]
  )
  const allFolders = foldersQuery.data?.folders ?? []
  const visibleFiles = useMemo(
    () => (acceptFile ? (browseData?.files ?? []).filter(acceptFile) : (browseData?.files ?? [])),
    [acceptFile, browseData?.files]
  )
  const childFolders = useMemo(
    () => (bridgeRootMode ? bridgeFolders : (browseData?.folders ?? [])),
    [bridgeFolders, bridgeRootMode, browseData?.folders]
  )

  const filters = useLibraryFilters({
    visibleFiles,
    childFolders,
    currentFolderId: folderId,
    requestedBridgeId: resolvedBridgeId,
    deferredSearch,
    sort,
    favoritesOnly
  })

  const activeBridgeName = resolvedBridgeId
    ? bridgeEntries.find((bridge) => bridge.id === resolvedBridgeId)?.name ?? null
    : null
  const breadcrumb = buildLibraryBreadcrumb(allFolders, folderId, resolvedBridgeId, activeBridgeName, {
    showRoot: bridgeEntries.length !== 1
  })

  const navigate = (folderEntryId: string | null) => {
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

  const resolvedEmptyState = emptyState ?? (
    <Box sx={{ flex: 1, minHeight: '100%', display: 'grid', placeItems: 'center' }}>
      <LibraryPickerEmptyState favoritesOnly={favoritesOnly} searching={Boolean(search.trim())} />
    </Box>
  )

  const renderBrowser = (folders: LibraryFolder[], files: LibraryFile[], emptyStateNode?: ReactNode) => (
    <LibraryBrowser
      folders={folders}
      files={files}
      viewMode={viewMode}
      sort={sort}
      emptyState={emptyStateNode}
      onFolderOpen={(folder) => navigate(folder.id)}
      onFilePick={onPick}
    />
  )

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', md: dialogWidth } }}>
        <Typography level="h4">{title}</Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, p: 0 }}>
          <Stack spacing={1.5} sx={{ minHeight: 420, minWidth: 0 }}>
            {description ? (
              <Typography level="body-sm" textColor="text.secondary">{description}</Typography>
            ) : null}

            {details ?? null}

            <LibraryBreadcrumbRow favoritesOnly={favoritesOnly} onFavoritesOnlyChange={setFavoritesOnly}>
              <LibraryBreadcrumb crumbs={breadcrumb} onNavigate={navigate} />
            </LibraryBreadcrumbRow>

            <DirectoryPrimaryToolbar
              searchValue={search}
              onSearchChange={setSearch}
              searchPlaceholder="Search files and folders"
              searchAriaLabel="Search library"
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
            />

            <Sheet
              variant="outlined"
              sx={{ p: 1.25, borderRadius: 'md', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}
            >
              {browseQuery.error ? (
                <Alert color="danger" variant="soft">
                  {browseQuery.error instanceof Error ? browseQuery.error.message : 'Unable to load the library.'}
                </Alert>
              ) : (
                <PaginatedLibraryBrowser
                  loading={browseQuery.isLoading}
                  loadingNode={
                    <Stack spacing={1} alignItems="center" sx={{ flex: 1, justifyContent: 'center', py: 4 }}>
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
                  emptyState={resolvedEmptyState}
                  renderBrowser={renderBrowser}
                />
              )}
            </Sheet>
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onClose}>Cancel</Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}
