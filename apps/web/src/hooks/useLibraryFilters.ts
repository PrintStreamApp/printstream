/**
 * Owns the Library view's filter/search/sort/pagination concern, extracted
 * verbatim from `pages/LibraryView.tsx`: the search box + deferred search, the
 * four metadata filters (file type, printer model, nozzle size, plate type),
 * the filters dialog open flag, page/page-size, and the persisted sort. From
 * those it derives the distinct filter option lists, the metadata/search-filtered
 * entries, and the sorted+paginated page the browser renders.
 *
 * Inputs are the already-resolved `visibleFiles`/`childFolders` for the current
 * folder plus the `currentFolderId`/`requestedBridgeId` that reset paging when
 * the user navigates. The browse/folders queries do NOT depend on this filter
 * state, so it lives here rather than in the view.
 *
 * Invariant: behavior-preserving — the bodies below are moved unchanged from
 * LibraryView. Selection state (and `selectedVisibleFiles`) stays in the view;
 * it reads `filteredFiles` from this hook's return.
 */
import { useEffect, useMemo, useState } from 'react'
import { useLocalStorageState } from './useLocalStorageState'
import { formatLibraryFileKindLabel } from '../lib/libraryDisplay'
import {
  filterLibraryEntries,
  filterLibraryFilesByMetadata,
  paginateLibraryEntries,
  sortLibraryEntries
} from '../lib/libraryDirectory'
import {
  collectDistinctLibraryFilterValues,
  LIBRARY_METADATA_FILTER_ALL,
  LIBRARY_PAGE_SIZE_OPTIONS,
  LIBRARY_SORT_KEY,
  parseLibrarySort
} from '../lib/libraryViewHelpers'
import type { LibrarySort } from '../components/LibraryBrowser'
import type { LibraryFile, LibraryFolder } from '@printstream/shared'

export interface LibraryFiltersParams {
  visibleFiles: LibraryFile[]
  childFolders: LibraryFolder[]
  currentFolderId: string | null
  requestedBridgeId: string | null
  /** Deferred search term (owned by the caller so it can also drive the all-folders browse query). */
  deferredSearch: string
}

export interface LibraryFilters {
  fileTypeFilter: string
  setFileTypeFilter: (value: string) => void
  printerModelFilter: string
  setPrinterModelFilter: (value: string) => void
  nozzleSizeFilter: string
  setNozzleSizeFilter: (value: string) => void
  plateTypeFilter: string
  setPlateTypeFilter: (value: string) => void
  filtersDialogOpen: boolean
  setFiltersDialogOpen: (value: boolean) => void
  pageSize: (typeof LIBRARY_PAGE_SIZE_OPTIONS)[number]
  setPageSize: (value: (typeof LIBRARY_PAGE_SIZE_OPTIONS)[number]) => void
  setPage: React.Dispatch<React.SetStateAction<number>>
  sort: LibrarySort
  setSort: (value: LibrarySort) => void
  fileTypeOptions: string[]
  printerModelOptions: string[]
  nozzleSizeOptions: string[]
  plateTypeOptions: string[]
  activeMetadataFilterCount: number
  filteredFolders: LibraryFolder[]
  filteredFiles: LibraryFile[]
  filteredItemCount: number
  pageCount: number
  currentPage: number
  pagedFolders: LibraryFolder[]
  pagedFiles: LibraryFile[]
  showingLabel: string
  clearMetadataFilters: () => void
}

export function useLibraryFilters(params: LibraryFiltersParams): LibraryFilters {
  const { visibleFiles, childFolders, currentFolderId, requestedBridgeId, deferredSearch } = params
  const [fileTypeFilter, setFileTypeFilter] = useState<string>(LIBRARY_METADATA_FILTER_ALL)
  const [printerModelFilter, setPrinterModelFilter] = useState<string>(LIBRARY_METADATA_FILTER_ALL)
  const [nozzleSizeFilter, setNozzleSizeFilter] = useState<string>(LIBRARY_METADATA_FILTER_ALL)
  const [plateTypeFilter, setPlateTypeFilter] = useState<string>(LIBRARY_METADATA_FILTER_ALL)
  const [filtersDialogOpen, setFiltersDialogOpen] = useState(false)
  const [pageSize, setPageSize] = useState<(typeof LIBRARY_PAGE_SIZE_OPTIONS)[number]>(25)
  const [page, setPage] = useState(1)
  const [sort, setSort] = useLocalStorageState<LibrarySort>(
    LIBRARY_SORT_KEY,
    { key: 'name', dir: 'asc' },
    parseLibrarySort
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
  const showingLabel = filteredItemCount === 0
    ? 'Showing 0 of 0 items'
    : `Showing ${((currentPage - 1) * pageSize) + 1}-${Math.min(currentPage * pageSize, filteredItemCount)} of ${filteredItemCount} items`

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

  return {
    fileTypeFilter,
    setFileTypeFilter,
    printerModelFilter,
    setPrinterModelFilter,
    nozzleSizeFilter,
    setNozzleSizeFilter,
    plateTypeFilter,
    setPlateTypeFilter,
    filtersDialogOpen,
    setFiltersDialogOpen,
    pageSize,
    setPageSize,
    setPage,
    sort,
    setSort,
    fileTypeOptions,
    printerModelOptions,
    nozzleSizeOptions,
    plateTypeOptions,
    activeMetadataFilterCount,
    filteredFolders,
    filteredFiles,
    filteredItemCount,
    pageCount,
    currentPage,
    pagedFolders,
    pagedFiles,
    showingLabel,
    clearMetadataFilters
  }
}
