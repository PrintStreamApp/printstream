/**
 * Owns library metadata facets and pagination for the page and all library pickers.
 * The caller supplies search, sort, and the shared tag facet because they also drive
 * server-side browse filtering before the result cap. This hook reapplies those
 * filters locally, interleaves folders, and sorts before paginating.
 */
import { type TagFilter } from './useTagFilter'
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
  LIBRARY_FILE_TYPE_FILTERS_KEY,
  LIBRARY_NOZZLE_SIZE_FILTERS_KEY,
  LIBRARY_PAGE_SIZE_KEY,
  LIBRARY_PAGE_SIZE_OPTIONS,
  LIBRARY_PLATE_TYPE_FILTERS_KEY,
  LIBRARY_PRINTER_MODEL_FILTERS_KEY
} from '../lib/libraryViewHelpers'
import { usePersistentState } from './usePersistentState'
import type { LibrarySort } from '../components/LibraryBrowser'
import type { LibraryFile, LibraryFolder } from '@printstream/shared'

type LibraryPageSize = (typeof LIBRARY_PAGE_SIZE_OPTIONS)[number]

const EMPTY_FILTER_VALUES: string[] = []
const LIBRARY_PAGE_SIZES = new Set<number>(LIBRARY_PAGE_SIZE_OPTIONS)

/** Coerce a stored filter blob into a plain string array (facet values are pruned against the live options separately). */
function sanitizeFilterValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function sanitizeLibraryPageSize(value: unknown): LibraryPageSize {
  return typeof value === 'number' && LIBRARY_PAGE_SIZES.has(value) ? (value as LibraryPageSize) : 25
}

/** Keep only the values still present in `options`, preserving the array identity when nothing was dropped. */
function pruneToOptions(current: string[], options: string[]): string[] {
  const next = current.filter((value) => options.includes(value))
  return next.length === current.length ? current : next
}

export interface LibraryFiltersParams {
  tagFilter: TagFilter
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
  tagFilter: TagFilter
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

/** True when neither tags nor metadata facets have any selectable values (the filters control can be disabled). */
export function libraryFacetsEmpty(filters: Pick<LibraryFilters,
  'fileTypeOptions' | 'printerModelOptions' | 'nozzleSizeOptions' | 'plateTypeOptions' | 'tagFilter'
>): boolean {
  return filters.tagFilter.tags.length === 0 && filters.tagFilter.value.length === 0
    && filters.fileTypeOptions.length === 0
    && filters.printerModelOptions.length === 0
    && filters.nozzleSizeOptions.length === 0
    && filters.plateTypeOptions.length === 0
}

export function useLibraryFilters(params: LibraryFiltersParams): LibraryFilters {
  const { tagFilter, visibleFiles, childFolders, currentFolderId, requestedBridgeId, deferredSearch, sort, favoritesOnly } = params
  const { matches: matchesTags, searchText: tagSearchText } = tagFilter
  const [fileTypeFilters, setFileTypeFilters] = usePersistentState<string[]>(LIBRARY_FILE_TYPE_FILTERS_KEY, EMPTY_FILTER_VALUES, sanitizeFilterValues)
  const [printerModelFilters, setPrinterModelFilters] = usePersistentState<string[]>(LIBRARY_PRINTER_MODEL_FILTERS_KEY, EMPTY_FILTER_VALUES, sanitizeFilterValues)
  const [nozzleSizeFilters, setNozzleSizeFilters] = usePersistentState<string[]>(LIBRARY_NOZZLE_SIZE_FILTERS_KEY, EMPTY_FILTER_VALUES, sanitizeFilterValues)
  const [plateTypeFilters, setPlateTypeFilters] = usePersistentState<string[]>(LIBRARY_PLATE_TYPE_FILTERS_KEY, EMPTY_FILTER_VALUES, sanitizeFilterValues)
  const [filtersDialogOpen, setFiltersDialogOpen] = useState(false)
  const [pageSize, setPageSize] = usePersistentState<LibraryPageSize>(LIBRARY_PAGE_SIZE_KEY, 25, sanitizeLibraryPageSize)
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
  const activeMetadataFilterCount = Number(tagFilter.value.length > 0) + Number(fileTypeFilters.length > 0)
    + Number(printerModelFilters.length > 0)
    + Number(nozzleSizeFilters.length > 0)
    + Number(plateTypeFilters.length > 0)
  const metadataFilteredFiles = useMemo(
    () => filterLibraryFilesByMetadata(visibleFiles.filter((file) => matchesTags(file.id)), {
      fileTypes: fileTypeFilters,
      printerModels: printerModelFilters,
      nozzleSizes: nozzleSizeFilters,
      plateTypes: plateTypeFilters
    }),
    [fileTypeFilters, nozzleSizeFilters, plateTypeFilters, printerModelFilters, visibleFiles, matchesTags]
  )
  const filteredEntries = useMemo(
    // Tags filter files, not the folders/bridge entries needed to navigate to them.
    () => filterLibraryEntries(childFolders, metadataFilteredFiles, deferredSearch, tagSearchText),
    [childFolders, deferredSearch, metadataFilteredFiles, tagSearchText]
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
  }, [tagFilter.value, currentFolderId, deferredSearch, favoritesOnly, fileTypeFilters, nozzleSizeFilters, pageSize, plateTypeFilters, printerModelFilters, requestedBridgeId])

  // Drop any selected facet value that is no longer offered (e.g. after navigating
  // to a folder without it). The functional updater keeps the same array identity
  // when nothing changed, so this never loops. Each effect skips while its option
  // list is still empty so a persisted filter isn't wiped before the folder's
  // files have loaded (the options are empty only mid-load or in an empty folder).
  useEffect(() => {
    if (fileTypeOptions.length === 0) return
    setFileTypeFilters((current) => pruneToOptions(current, fileTypeOptions))
  }, [fileTypeOptions, setFileTypeFilters])

  useEffect(() => {
    if (printerModelOptions.length === 0) return
    setPrinterModelFilters((current) => pruneToOptions(current, printerModelOptions))
  }, [printerModelOptions, setPrinterModelFilters])

  useEffect(() => {
    if (nozzleSizeOptions.length === 0) return
    setNozzleSizeFilters((current) => pruneToOptions(current, nozzleSizeOptions))
  }, [nozzleSizeOptions, setNozzleSizeFilters])

  useEffect(() => {
    if (plateTypeOptions.length === 0) return
    setPlateTypeFilters((current) => pruneToOptions(current, plateTypeOptions))
  }, [plateTypeOptions, setPlateTypeFilters])

  useEffect(() => {
    if (page !== currentPage) {
      setPage(currentPage)
    }
  }, [currentPage, page])

  function clearMetadataFilters() {
    tagFilter.clear()
    setFileTypeFilters([])
    setPrinterModelFilters([])
    setNozzleSizeFilters([])
    setPlateTypeFilters([])
  }

  return {
    tagFilter,
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
