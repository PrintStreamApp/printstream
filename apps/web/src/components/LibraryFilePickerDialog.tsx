/**
 * Reusable "choose a library file" dialog.
 *
 * The sibling `LibraryDestinationDialog` chooses *where* to save a file; this
 * dialog chooses *which* file to open. Both share the same browsing surface
 * (`LibraryBrowser` + breadcrumb + list/icon toggle) so picking a file looks and
 * navigates exactly like picking a destination. Folders drill in; clicking a
 * file calls `onPick` and the caller closes the dialog.
 *
 * Files are loaded per-folder from `/api/library/browse`, including bridge-root
 * mode where the top level lists bridges instead of folders.
 */
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react'
import { Alert, Box, Button, CircularProgress, Input, Sheet, Stack, Typography } from '@mui/joy'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import InventoryRoundedIcon from '@mui/icons-material/Inventory2Rounded'
import { useQuery } from '@tanstack/react-query'
import type { LibraryBrowseResponse, LibraryFile, LibraryFolder } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import {
  buildLibraryBreadcrumb,
  fromBridgeFolderId,
  isBridgeFolderId,
  toBridgeFolderId
} from '../lib/libraryNavigation'
import { filterLibraryEntries } from '../lib/libraryDirectory'
import { EmptyState } from './EmptyState'
import { LibraryBreadcrumb } from './LibraryBreadcrumb'
import { BackAwareModal as Modal } from './BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import { LibraryBrowser, LibraryToolbar, type LibrarySort, type LibraryViewMode } from './LibraryBrowser'

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

  const browseQuery = useQuery({
    queryKey: ['library-file-picker-browse', folderId ?? 'root', bridgeId ?? 'none'],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      if (folderId) params.set('folderId', folderId)
      if (bridgeId) params.set('bridgeId', bridgeId)
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
  const filtered = useMemo(
    () => filterLibraryEntries(bridgeRootMode ? bridgeFolders : (browseData?.folders ?? []), visibleFiles, deferredSearch),
    [bridgeFolders, bridgeRootMode, browseData?.folders, deferredSearch, visibleFiles]
  )
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
      <EmptyState
        icon={<InventoryRoundedIcon />}
        title={search ? 'No matching files' : 'No files here'}
        description={
          search
            ? 'Try a different search, or use the breadcrumb to look in another folder.'
            : 'Open a subfolder or use the breadcrumb to find a file.'
        }
      />
    </Box>
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

            <LibraryBreadcrumb crumbs={breadcrumb} onNavigate={navigate} />

            {/* Search sits on its own row; LibraryToolbar renders a full-width
                sort/view row beneath it (it is not a sibling-flex control). */}
            <Stack spacing={1}>
              <Input
                size="sm"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search files and folders"
                startDecorator={<SearchRoundedIcon />}
                slotProps={{ input: { 'aria-label': 'Search library' } }}
                sx={{ minWidth: 0 }}
              />
              <LibraryToolbar
                viewMode={viewMode}
                onViewModeChange={setViewMode}
                sort={sort}
                onSortChange={setSort}
                rightAlignViewModeOnMobile
              />
            </Stack>

            <Sheet
              variant="outlined"
              sx={{ p: 1.25, borderRadius: 'md', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}
            >
              {browseQuery.isLoading ? (
                <Stack spacing={1} alignItems="center" sx={{ flex: 1, justifyContent: 'center', py: 4 }}>
                  <CircularProgress size="sm" />
                  <Typography level="body-sm" textColor="text.tertiary">Loading library…</Typography>
                </Stack>
              ) : browseQuery.error ? (
                <Alert color="danger" variant="soft">
                  {browseQuery.error instanceof Error ? browseQuery.error.message : 'Unable to load the library.'}
                </Alert>
              ) : (
                <LibraryBrowser
                  folders={filtered.folders}
                  files={filtered.files}
                  viewMode={viewMode}
                  sort={sort}
                  onFolderOpen={(folder) => navigate(folder.id)}
                  onFilePick={onPick}
                  emptyState={resolvedEmptyState}
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
