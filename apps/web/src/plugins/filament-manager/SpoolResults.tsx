/**
 * The spool library's grouped/paginated result region, shared by the Filament
 * tab and the AMS-slot spool picker. Grouped mode shows a titled section per
 * group (no pagination); ungrouped mode wraps the page in a `PaginatedSection`.
 * The caller supplies how a flat list of spools renders via `renderRows`.
 */
import { Box, CircularProgress, Stack, Typography } from '@mui/joy'
import type { ReactNode } from 'react'
import type { FilamentSpool } from '@printstream/shared'
import { PaginatedSection } from '../../components/PaginationFooter'
import type { SpoolDirectory } from './useSpoolDirectory'

export function SpoolResults({
  directory,
  hasAnySpools,
  loading = false,
  renderRows,
  emptyState,
  noMatchState
}: {
  directory: SpoolDirectory
  /** Whether the source has any spools at all (drives "empty" vs "no matches"). */
  hasAnySpools: boolean
  loading?: boolean
  renderRows: (spools: FilamentSpool[]) => ReactNode
  /** Shown when there are no spools at all. */
  emptyState: ReactNode
  /** Shown when spools exist but none match the search/filters. */
  noMatchState: ReactNode
}) {
  const { grouped, groups, total, pageItems, start, pageSize, page, setPage } = directory

  if (loading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress /></Box>
  }
  if (!hasAnySpools) return <>{emptyState}</>
  if (total === 0) return <>{noMatchState}</>

  if (grouped) {
    return (
      <Stack spacing={1.5}>
        {groups.map((bucket) => (
          <Stack key={bucket.key} spacing={0.75}>
            <Typography level="title-sm" textColor="text.tertiary">{bucket.label} · {bucket.spools.length}</Typography>
            {renderRows(bucket.spools)}
          </Stack>
        ))}
      </Stack>
    )
  }

  return (
    <PaginatedSection
      showingLabel={`Showing ${start + 1}–${Math.min(start + pageSize, total)} of ${total}`}
      previousDisabled={page <= 1}
      nextDisabled={start + pageSize >= total}
      onPrevious={() => setPage((current) => Math.max(1, current - 1))}
      onNext={() => setPage((current) => current + 1)}
    >
      {renderRows(pageItems)}
    </PaginatedSection>
  )
}
