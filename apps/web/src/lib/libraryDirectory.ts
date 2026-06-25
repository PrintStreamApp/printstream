import type { LibraryFile, LibraryFolder } from '@printstream/shared'
import { formatLibraryFileKindLabel, formatLibraryFileName } from './libraryDisplay'

export interface FilteredLibraryEntries {
  folders: LibraryFolder[]
  files: LibraryFile[]
}

/**
 * Selected metadata facets. Each facet is a set of allowed values; an **empty
 * set means "no filter"** for that facet. Within a facet the match is OR (the
 * file matches any selected value); across facets it is AND.
 */
export interface LibraryFileMetadataFilters {
  printerModels: string[]
  nozzleSizes: string[]
  plateTypes: string[]
  fileTypes: string[]
}

export function filterLibraryFilesByMetadata(
  files: ReadonlyArray<LibraryFile>,
  filters: LibraryFileMetadataFilters
): LibraryFile[] {
  return files.filter((file) => {
    if (
      filters.printerModels.length > 0
      && !file.compatiblePrinterModels.some((model) => filters.printerModels.includes(model))
    ) {
      return false
    }
    if (filters.nozzleSizes.length > 0 && !file.nozzleSizeChips.some((size) => filters.nozzleSizes.includes(size))) {
      return false
    }
    if (filters.plateTypes.length > 0 && !file.plateTypeChips.some((plate) => filters.plateTypes.includes(plate))) {
      return false
    }
    if (filters.fileTypes.length > 0 && !filters.fileTypes.includes(formatLibraryFileKindLabel(file.name, file.kind))) {
      return false
    }
    return true
  })
}

export function filterLibraryEntries(
  folders: ReadonlyArray<LibraryFolder>,
  files: ReadonlyArray<LibraryFile>,
  search: string
): FilteredLibraryEntries {
  const needle = search.trim().toLowerCase()
  if (!needle) {
    return {
      folders: [...folders],
      files: [...files]
    }
  }

  return {
    folders: folders.filter((folder) => folder.name.toLowerCase().includes(needle)),
    files: files.filter((file) => {
      const displayName = formatLibraryFileName(file.name).toLowerCase()
      const rawName = file.name.toLowerCase()
      const kindLabel = formatLibraryFileKindLabel(file.name, file.kind).toLowerCase()
      return displayName.includes(needle) || rawName.includes(needle) || kindLabel.includes(needle)
    })
  }
}

export interface LibrarySortSpec {
  key: 'name' | 'date' | 'size' | 'mostPrinted' | 'lastPrinted'
  dir: 'asc' | 'desc'
}

/**
 * File comparator behind the library's sort selector. Mirrors the server-side
 * order (see `buildLibraryFileOrderBy` in the API) so the client re-sort agrees
 * with the order the API already applied before the recency cap. Never-printed
 * files (null `lastPrintedAt`) always sort last, regardless of direction.
 */
export function compareLibraryFiles(a: LibraryFile, b: LibraryFile, sort: LibrarySortSpec): number {
  if (sort.key === 'lastPrinted') {
    const aPrinted = a.lastPrintedAt
    const bPrinted = b.lastPrintedAt
    if (!aPrinted && !bPrinted) return 0
    if (!aPrinted) return 1
    if (!bPrinted) return -1
    return sort.dir === 'asc' ? aPrinted.localeCompare(bPrinted) : -aPrinted.localeCompare(bPrinted)
  }
  let cmp = 0
  switch (sort.key) {
    case 'name':
      cmp = a.name.localeCompare(b.name)
      break
    case 'date':
      cmp = a.uploadedAt.localeCompare(b.uploadedAt)
      break
    case 'size':
      cmp = a.sizeBytes - b.sizeBytes
      break
    case 'mostPrinted':
      cmp = (a.printCount ?? 0) - (b.printCount ?? 0)
      break
  }
  return sort.dir === 'asc' ? cmp : -cmp
}

/**
 * Sort folders (always by name, honoring direction) and files (by the active
 * sort). Callers that paginate MUST sort before slicing pages — sorting only
 * the visible page leaves the global order as whatever the API returned.
 */
export function sortLibraryEntries(
  folders: ReadonlyArray<LibraryFolder>,
  files: ReadonlyArray<LibraryFile>,
  sort: LibrarySortSpec
): FilteredLibraryEntries {
  return {
    folders: [...folders].sort((a, b) =>
      sort.dir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
    ),
    files: [...files].sort((a, b) => compareLibraryFiles(a, b, sort))
  }
}

export type LibraryGroupBy = 'none' | 'fileType' | 'letter' | 'dateAdded'

/** Grouping options offered by the library views/pickers, in display order. */
export const LIBRARY_GROUP_OPTIONS: ReadonlyArray<{ value: LibraryGroupBy; label: string }> = [
  { value: 'none', label: 'No grouping' },
  { value: 'fileType', label: 'File type' },
  { value: 'letter', label: 'Name (A–Z)' },
  { value: 'dateAdded', label: 'Date added' }
]

export interface LibraryFileGroup {
  key: string
  label: string
  files: LibraryFile[]
}

function libraryGroupKey(file: LibraryFile, groupBy: LibraryGroupBy, nowMs: number): { key: string; label: string } {
  switch (groupBy) {
    case 'fileType': {
      const label = formatLibraryFileKindLabel(file.name, file.kind)
      return { key: label.toLowerCase(), label }
    }
    case 'letter': {
      const first = formatLibraryFileName(file.name).trim().charAt(0).toUpperCase()
      if (first >= 'A' && first <= 'Z') return { key: first, label: first }
      // Non-alphabetic names bucket under "#", sorted last via a high key.
      return { key: '￿', label: '#' }
    }
    case 'dateAdded':
    default: {
      const ts = Date.parse(file.uploadedAt)
      const days = Number.isNaN(ts) ? Number.POSITIVE_INFINITY : (nowMs - ts) / 86_400_000
      if (days < 1) return { key: '0', label: 'Today' }
      if (days < 7) return { key: '1', label: 'This week' }
      if (days < 31) return { key: '2', label: 'This month' }
      return { key: '3', label: 'Older' }
    }
  }
}

/**
 * Bucket files for the library's grouping control. Returns one group when
 * `groupBy` is `none`. Groups are ordered by key (alphabetic for file type and
 * letter, with "#" last; chronological buckets for date added). Files keep their
 * incoming order, so callers should sort before grouping.
 */
export function groupLibraryFiles(
  files: ReadonlyArray<LibraryFile>,
  groupBy: LibraryGroupBy,
  nowMs: number = Date.now()
): LibraryFileGroup[] {
  if (groupBy === 'none') return [{ key: 'all', label: '', files: [...files] }]
  const buckets = new Map<string, LibraryFileGroup>()
  for (const file of files) {
    const { key, label } = libraryGroupKey(file, groupBy, nowMs)
    const bucket = buckets.get(key)
    if (bucket) bucket.files.push(file)
    else buckets.set(key, { key, label, files: [file] })
  }
  return [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key))
}

export function paginateLibraryEntries(
  folders: ReadonlyArray<LibraryFolder>,
  files: ReadonlyArray<LibraryFile>,
  page: number,
  pageSize: number
): FilteredLibraryEntries {
  if (pageSize <= 0) {
    return {
      folders: [...folders],
      files: [...files]
    }
  }

  const startIndex = Math.max(0, (page - 1) * pageSize)
  const endIndex = startIndex + pageSize
  const pagedFolders = folders.slice(startIndex, endIndex)
  const fileStartIndex = Math.max(0, startIndex - folders.length)
  const fileEndIndex = Math.max(0, endIndex - folders.length)

  return {
    folders: pagedFolders,
    files: files.slice(fileStartIndex, fileEndIndex)
  }
}