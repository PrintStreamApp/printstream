import type { LibraryFile, LibraryFolder } from '@printstream/shared'
import { formatLibraryFileKindLabel, formatLibraryFileName } from './libraryDisplay'

export interface FilteredLibraryEntries {
  folders: LibraryFolder[]
  files: LibraryFile[]
}

export interface LibraryFileMetadataFilters {
  printerModel: string
  nozzleSize: string
  plateType: string
  fileType: string
}

export function filterLibraryFilesByMetadata(
  files: ReadonlyArray<LibraryFile>,
  filters: LibraryFileMetadataFilters,
  allValue = '__all__'
): LibraryFile[] {
  return files.filter((file) => {
    if (
      filters.printerModel !== allValue
      && !file.compatiblePrinterModels.includes(filters.printerModel as LibraryFile['compatiblePrinterModels'][number])
    ) {
      return false
    }
    if (filters.nozzleSize !== allValue && !file.nozzleSizeChips.includes(filters.nozzleSize)) {
      return false
    }
    if (filters.plateType !== allValue && !file.plateTypeChips.includes(filters.plateType)) {
      return false
    }
    if (filters.fileType !== allValue && formatLibraryFileKindLabel(file.name, file.kind) !== filters.fileType) {
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