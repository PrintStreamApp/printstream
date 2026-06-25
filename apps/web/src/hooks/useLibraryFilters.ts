/**
 * Owns the Library view's filter/search/sort/pagination concern, extracted
 * verbatim from `pages/LibraryView.tsx`: the search box + deferred search, the
 * four metadata filters (file type, printer model, nozzle size, plate type; each
 * multi-select — an empty selection means "no filter" for that facet), the
 * filters dialog open flag, page/page-size, and the persisted sort. From
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
import { formatLibraryFileKindLabel } from '../lib/libraryDisplay'
import {
  filterLibraryEntries,
  filterLibraryFilesByMetadata,
  paginateLibraryEntries,
  sortLibraryEntries
} from '../lib/libraryDirectory'
import {
  collectDistinctLibraryFilterValues,
  LIBRARY_PAGE_SIZE_OPTIONS
} from '../lib/libraryViewHelpers'
import type { LibrarySort } from '../components/LibraryBrowser'
import type { LibraryFile, LibraryFolder } from '@printstream/shared'

/** Keep only the values still present in `options`, preserving the array identity when nothing was dropped. */
function pruneToOptions(current: string[], options: string[]): string[] {
  const next = current.filter((value) => options.includes(value))
  return next.length === current.length ? current : next
}

export interface LibraryFiltersParams {
  visibleFiles: LibraryFile[]
  childFolders: LibraryFolder[]
  currentFolderId: string | null
  requestedBridgeId: string | null
  /** Deferred search term (owned by the caller so it can also drive the all-folders browse query). */
  deferredSearch: string
  /**
   * Active sort. Owned by the caller because it (and `favoritesOnly`) drive the
   * browse query so the API orders/filters before its recency cap; the hook still
   * re-sorts the returned page client-side to keep folders + files interleaved.
   */
  sort: LibrarySort
  /** "Favorites only" toggle. Applied server-side; here it only resets paging. */
  favoritesOnly: boolean
}

export interface LibraryFilters {
  fileTypeFilters: string[]
  setFileTypeFilters: (values: string[]) => void
  printerModelFilters: string[]
  setPrinterModelFilters: (values: string[]) => void
  nozzleSizeFilters: string[]
  setNozzleSizeFilters: (values: string[]) => void
  plateTypeFilters: string[]
  setPlateTypeFilters: (values: string[]) => void
  filtersDialogOpen: boolean
  setFiltersDialogOpen: (value: boolean) => void
  pageSize: (typeof LIBRARY_PAGE_SIZE_OPTIONS)[number]
  setPageSize: (value: (typeof LIBRARY_PAGE_SIZE_OPTIONS)[number]) => void
  setPage: React.Dispatch<React.SetStateAction<number>>
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

/** True when none of the four metadata facets have any selectable values (the filters control can be disabled). */
export function libraryFacetsEmpty(filters: Pick<LibraryFilters,
  'fileTypeOptions' | 'printerModelOptions' | 'nozzleSizeOptions' | 'plateTypeOptions'
>): boolean {
  return filters.fileTypeOptions.length === 0
    && filters.printerModelOptions.length === 0
    && filters.nozzleSizeOptions.length === 0
    && filters.plateTypeOptions.length === 0
}

export function useLibraryFilters(params: LibraryFiltersParams): LibraryFilters {
  const { visibleFiles, childFolders, currentFolderId, requestedBridgeId, deferredSearch, sort, favoritesOnly } = params
  const [fileTypeFilters, setFileTypeFilters] = useState<string[]>([])
  const [printerModelFilters, setPrinterModelFilters] = useState<string[]>([])
  const [nozzleSizeFilters, setNozzleSizeFilters] = useState<string[]>([])
  const [plateTypeFilters, setPlateTypeFilters] = useState<string[]>([])
  const [filtersDialogOpen, setFiltersDialogOpen] = useState(false)
  const [pageSize, setPageSize] = useState<(typeof LIBRARY_PAGE_SIZE_OPTIONS)[number]>(25)
  const [page, setPage] = useState(1)

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
  const activeMetadataFilterCount = Number(fileTypeFilters.length > 0)
    + Number(printerModelFilters.length > 0)
    + Number(nozzleSizeFilters.length > 0)
    + Number(plateTypeFilters.length > 0)
  const metadataFilteredFiles = useMemo(
    () => filterLibraryFilesByMetadata(visibleFiles, {
      fileTypes: fileTypeFilters,
      printerModels: printerModelFilters,
      nozzleSizes: nozzleSizeFilters,
      plateTypes: plateTypeFilters
    }),
    [fileTypeFilters, nozzleSizeFilters, plateTypeFilters, printerModelFilters, visibleFiles]
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
  }, [currentFolderId, deferredSearch, favoritesOnly, fileTypeFilters, nozzleSizeFilters, pageSize, plateTypeFilters, printerModelFilters, requestedBridgeId])

  // Drop any selected facet value that is no longer offered (e.g. after navigating
  // to a folder without it). The functional updater keeps the same array identity
  // when nothing changed, so this never loops.
  useEffect(() => {
    setFileTypeFilters((current) => pruneToOptions(current, fileTypeOptions))
  }, [fileTypeOptions])

  useEffect(() => {
    setPrinterModelFilters((current) => pruneToOptions(current, printerModelOptions))
  }, [printerModelOptions])

  useEffect(() => {
    setNozzleSizeFilters((current) => pruneToOptions(current, nozzleSizeOptions))
  }, [nozzleSizeOptions])

  useEffect(() => {
    setPlateTypeFilters((current) => pruneToOptions(current, plateTypeOptions))
  }, [plateTypeOptions])

  useEffect(() => {
    if (page !== currentPage) {
      setPage(currentPage)
    }
  }, [currentPage, page])

  function clearMetadataFilters() {
    setFileTypeFilters([])
    setPrinterModelFilters([])
    setNozzleSizeFilters([])
    setPlateTypeFilters([])
  }

  return {
    fileTypeFilters,
    setFileTypeFilters,
    printerModelFilters,
    setPrinterModelFilters,
    nozzleSizeFilters,
    setNozzleSizeFilters,
    plateTypeFilters,
    setPlateTypeFilters,
    filtersDialogOpen,
    setFiltersDialogOpen,
    pageSize,
    setPageSize,
    setPage,
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
