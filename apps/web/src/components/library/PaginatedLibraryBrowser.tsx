/**
 * The library's grouped/paginated result region, shared by the Library page and
 * every library picker so they render identically.
 *
 * Two modes, matching the Library view:
 * - **Grouped** (`group !== 'none'`): folders first, then a titled section per
 *   file group. No pagination — all filtered entries show.
 * - **Ungrouped**: the current page of folders+files wrapped in a
 *   `PaginatedSection` (pagination rows above and below).
 *
 * The caller owns how a flat list of entries renders (selection, context menus,
 * picker affordances, etc.) via `renderBrowser`; this component only owns the
 * grouping + pagination structure around it.
 */
import { Stack, Typography, type StackProps } from '@mui/joy'
import type { ReactNode } from 'react'
import type { LibraryFile, LibraryFolder } from '@printstream/shared'
import { groupLibraryFiles, sortLibraryEntries, type LibraryGroupBy } from '../../lib/libraryDirectory'
import type { LibrarySort } from '../LibraryBrowser'
import { PaginatedSection } from '../PaginationFooter'

export interface LibraryPaginationState {
  showingLabel: string
  currentPage: number
  pageCount: number
  onPageChange: (page: number) => void
}

export function PaginatedLibraryBrowser({
  loading = false,
  loadingNode = null,
  group,
  sort,
  filteredFolders,
  filteredFiles,
  filteredItemCount,
  pagedFolders,
  pagedFiles,
  pagination,
  emptyState,
  renderBrowser,
  groupSpacing = 1.5
}: {
  loading?: boolean
  loadingNode?: ReactNode
  group: LibraryGroupBy
  sort: LibrarySort
  filteredFolders: LibraryFolder[]
  filteredFiles: LibraryFile[]
  filteredItemCount: number
  pagedFolders: LibraryFolder[]
  pagedFiles: LibraryFile[]
  pagination: LibraryPaginationState
  emptyState?: ReactNode
  renderBrowser: (folders: LibraryFolder[], files: LibraryFile[], emptyStateNode?: ReactNode) => ReactNode
  /** Vertical spacing between the group sections (grouped mode). */
  groupSpacing?: StackProps['spacing']
}) {
  if (loading) return <>{loadingNode}</>

  if (group !== 'none') {
    // Grouped mode shows all filtered entries (no pagination): folders first,
    // then a section per file group.
    if (filteredItemCount === 0) return <>{renderBrowser(pagedFolders, pagedFiles, emptyState)}</>
    return (
      <Stack spacing={groupSpacing}>
        {filteredFolders.length > 0 && (
          <Stack spacing={0.75}>
            <Typography level="title-sm" textColor="text.tertiary">Folders · {filteredFolders.length}</Typography>
            {renderBrowser(sortLibraryEntries(filteredFolders, [], sort).folders, [])}
          </Stack>
        )}
        {groupLibraryFiles(sortLibraryEntries([], filteredFiles, sort).files, group).map((fileGroup) => (
          <Stack key={fileGroup.key} spacing={0.75}>
            <Typography level="title-sm" textColor="text.tertiary">{fileGroup.label} · {fileGroup.files.length}</Typography>
            {renderBrowser([], fileGroup.files)}
          </Stack>
        ))}
      </Stack>
    )
  }

  if (filteredItemCount > 0) {
    return (
      <PaginatedSection
        showingLabel={pagination.showingLabel}
        previousDisabled={pagination.currentPage <= 1}
        nextDisabled={pagination.currentPage >= pagination.pageCount}
        onPrevious={() => pagination.onPageChange(Math.max(1, pagination.currentPage - 1))}
        onNext={() => pagination.onPageChange(Math.min(pagination.pageCount, pagination.currentPage + 1))}
      >
        {renderBrowser(pagedFolders, pagedFiles, emptyState)}
      </PaginatedSection>
    )
  }

  return <>{renderBrowser(pagedFolders, pagedFiles, emptyState)}</>
}
