/**
 * Loads and displays one printer's retained job totals for the selected range.
 * PrintersView owns the range so changing printer routes or visiting Overview
 * does not reset the user's selection. Mount only for an accessible printer.
 */
import { Alert, CircularProgress, Stack, Typography } from '@mui/joy'
import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded'
import { useQuery } from '@tanstack/react-query'
import type { PrinterStatsResponse } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { statsDateRangeSearch, type StatsDateRangeSelection } from '../../lib/statsDateRange'
import { StatsDateRangePicker } from '../StatsDateRangePicker'
import { PageSectionHeading } from '../dashboard/PageSectionHeading'
import { PrinterStatsCardGrid } from './PrinterSummaryCards'

/** Render the stats section for a printer the caller has permission to view. */
export function PrinterDetailStatsSection({
  printerId,
  dateRange,
  onDateRangeChange
}: {
  printerId: string
  dateRange: StatsDateRangeSelection
  onDateRangeChange: (range: StatsDateRangeSelection) => void
}) {
  const statsQuery = useQuery({
    queryKey: ['printer-stats', printerId, dateRange?.from ?? 'all', dateRange?.to ?? 'all'],
    queryFn: ({ signal }) => apiFetch<PrinterStatsResponse>(
      `/api/printers/${printerId}/stats${statsDateRangeSearch(dateRange)}`,
      { signal }
    )
  })

  return (
    <Stack spacing={1.5}>
      <PageSectionHeading
        icon={<QueryStatsRoundedIcon />}
        title="Print stats"
        description={dateRange
          ? 'Retained job totals and runtime for the selected period.'
          : 'Lifetime print totals and runtime.'}
        actions={<StatsDateRangePicker value={dateRange} onChange={onDateRangeChange} />}
      />

      {statsQuery.isLoading && (
        <Stack direction="row" spacing={1} alignItems="center">
          <CircularProgress size="sm" />
          <Typography level="body-sm" textColor="text.tertiary">Loading printer stats…</Typography>
        </Stack>
      )}

      {statsQuery.error && (
        <Alert color="danger" variant="soft">
          Printer stats could not be loaded right now.
        </Alert>
      )}

      {statsQuery.data && (
        <PrinterStatsCardGrid stats={statsQuery.data.stats} allTime={dateRange === null} />
      )}
    </Stack>
  )
}
