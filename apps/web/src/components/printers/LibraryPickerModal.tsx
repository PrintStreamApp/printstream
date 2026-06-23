import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { Box, Button, Chip, FormControl, FormLabel, Input, ModalClose, ModalDialog, Option, Select, Stack, Typography } from '@mui/joy'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import { useQuery } from '@tanstack/react-query'
import { LibraryBreadcrumb } from '../../components/LibraryBreadcrumb'
import { isDirectPrintableFileName, isPrinterModelCompatible, type LibraryBrowseResponse, type LibraryFile, type LibraryFolder, type PrinterModel } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { buildLibraryBreadcrumb, isBridgeFolderId, fromBridgeFolderId, toBridgeFolderId } from '../../lib/libraryNavigation'
import { formatLibraryFileKindLabel } from '../../lib/libraryDisplay'
import { isUnslicedThreeMfFile } from '../../lib/libraryFileTags'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { DialogSection } from '../../components/DialogSection'
import { DirectoryFiltersButton, DirectoryFiltersDialog } from '../../components/DirectoryToolbar'
import { SearchScopeToggle } from '../../components/library/SearchScopeToggle'
import {
  LibraryBrowser,
  LibraryToolbar,
  type LibrarySort,
  type LibraryViewMode
} from '../../components/LibraryBrowser'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import { filterLibraryEntries, filterLibraryFilesByMetadata } from '../../lib/libraryDirectory'
import { parseLibraryViewMode, parseLibrarySort, collectDistinctLibraryFilterValues } from '../../lib/printersViewHelpers'
import { LIBRARY_VIEW_MODE_KEY, LIBRARY_SORT_KEY, LIBRARY_METADATA_FILTER_ALL } from '../../lib/printerViewConstants'

/**
 * Lightweight library picker used by the printer card's "Print" button.
 *
 * Mirrors {@link LibraryView}'s folder navigation (root listing + drill-in)
 * but only surfaces direct-printable files. When launched from a specific
 * printer card, incompatible files stay visible for context but are
 * disabled with a short compatibility note before handing control back to
 * {@link PrintModal}.
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
  const PICKER_ICON_DIALOG_MAX_WIDTH = 640
  const [folderId, setFolderId] = useState<string | null>(null)
  const [bridgeId, setBridgeId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [searchAllFolders, setSearchAllFolders] = useState(false)
  const allFolderSearch = searchAllFolders ? deferredSearch.trim() : ''
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
                      endDecorator={<SearchScopeToggle allFolders={searchAllFolders} onChange={setSearchAllFolders} />}
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
                  favoritesOnly={favoritesOnly}
                  onFavoritesOnlyChange={setFavoritesOnly}
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
