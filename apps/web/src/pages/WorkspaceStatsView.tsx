import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded'
import StraightenRoundedIcon from '@mui/icons-material/StraightenRounded'
import ScaleRoundedIcon from '@mui/icons-material/ScaleRounded'
import AccessTimeRoundedIcon from '@mui/icons-material/AccessTimeRounded'
import type { WorkspaceStatsResponse } from '@printstream/shared'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Alert, Box, Stack, Typography } from '@mui/joy'
import { Printer3dRoundedIcon } from '../components/Printer3dRoundedIcon'
import { ActivityTrendStatCard, BreakdownStatCard, CapacityTrendStatCard } from '../components/StatsCards'
import { apiFetch } from '../lib/apiClient'
import { PluginSlot } from '../plugin/PluginSlot'
import { ListSkeleton } from '../components/ListSkeleton'
import { MaterialReliabilityCard, ModelReliabilityCard, PrinterReliabilityCard } from '../components/PrinterReliabilityCard'
import { PageSectionHeading, pageSectionStackSpacing } from '../components/dashboard/PageSectionHeading'
import { StatsDateRangePicker } from '../components/StatsDateRangePicker'
import { recentStatsDateRange, statsDateRangeSearch, type StatsDateRangeSelection } from '../lib/statsDateRange'
import { readCurrentWorkspaceScopeKey } from '../lib/workspaceScope'

const SUCCESS_COLOR = 'var(--joy-palette-success-500)'
const FAILED_COLOR = 'var(--joy-palette-danger-500)'
const CANCELLED_COLOR = 'var(--joy-palette-neutral-500)'
const STATS_CARD_GRID_SX = {
  display: 'grid',
  gridTemplateColumns: {
    xs: 'minmax(0, 1fr)',
    sm: 'repeat(2, minmax(0, 1fr))',
    lg: 'repeat(3, minmax(0, 1fr))'
  },
  gap: 1.5
} as const

/**
 * Workspace stats page: current printing activity and production totals.
 * Workspace onboarding lives on the Get started page (`GetStartedView`).
 */
export function WorkspaceStatsView({ canViewPrinters }: { canViewPrinters: boolean }) {
  const [dateRange, setDateRange] = useState<StatsDateRangeSelection>(() => recentStatsDateRange(30))
  const scopeKey = readCurrentWorkspaceScopeKey()
  const rangeSearch = statsDateRangeSearch(dateRange)
  const statsQuery = useQuery({
    queryKey: ['workspace-stats', scopeKey, dateRange?.from ?? 'all', dateRange?.to ?? 'all'],
    queryFn: ({ signal }) => apiFetch<WorkspaceStatsResponse>(`/api/stats${rangeSearch}`, { signal })
  })

  if (statsQuery.isLoading) {
    return (
      <Stack spacing={2}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" useFlexGap sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Typography level="h3" startDecorator={<QueryStatsRoundedIcon />}>Stats</Typography>
          <StatsDateRangePicker value={dateRange} onChange={setDateRange} />
        </Stack>
        <ListSkeleton rows={3} />
      </Stack>
    )
  }

  if (statsQuery.isError || !statsQuery.data) {
    return (
      <Stack spacing={2}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" useFlexGap sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Typography level="h3" startDecorator={<QueryStatsRoundedIcon />}>Stats</Typography>
          <StatsDateRangePicker value={dateRange} onChange={setDateRange} />
        </Stack>
        <Alert color="danger" variant="soft">
          Workspace stats could not be loaded right now.
        </Alert>
      </Stack>
    )
  }

  const stats = statsQuery.data
  const lastPeriodActivity = stats.stats.activityLast30Days[stats.stats.activityLast30Days.length - 1]
  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" useFlexGap sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Typography level="h3" startDecorator={<QueryStatsRoundedIcon />}>Stats</Typography>
        <StatsDateRangePicker value={dateRange} onChange={setDateRange} />
      </Stack>

      <Stack spacing={pageSectionStackSpacing}>
        <Stack spacing={1.25}>
          <PageSectionHeading
            icon={<Printer3dRoundedIcon />}
            title="Activity and capacity"
            description={dateRange
              ? 'Printer activity and available printing time in the selected period.'
              : 'Daily activity shows the last 30 days; outcome and filament totals below cover all time.'}
          />
          <Box sx={STATS_CARD_GRID_SX}>
            <ActivityTrendStatCard
              icon={<Printer3dRoundedIcon />}
              label="Printer activity"
              activePrintersValue={dateRange
                ? `${formatWholeNumber(lastPeriodActivity?.activePrinterCount ?? 0)} of ${formatWholeNumber(lastPeriodActivity?.totalPrinterCount ?? 0)}`
                : `${formatWholeNumber(stats.stats.printsInProgress)} of ${formatWholeNumber(stats.stats.printerCount)}`}
              activityLast30Days={stats.stats.activityLast30Days}
            />
            <CapacityTrendStatCard
              icon={<AccessTimeRoundedIcon />}
              label="Print capacity"
              capacityValue={`${formatDecimal(lastPeriodActivity?.usedPrintHours ?? 0)} of ${formatDecimal(lastPeriodActivity?.capacityPrintHours ?? 0)} h`}
              activityLast30Days={stats.stats.activityLast30Days}
            />
          </Box>
        </Stack>

        <Stack spacing={1.25}>
          <PageSectionHeading
            icon={<QueryStatsRoundedIcon />}
            title="Print outcomes"
            description="Recorded jobs, print time, and reliability by printer, model, and material."
          />
          <Box sx={STATS_CARD_GRID_SX}>
            <BreakdownStatCard
              icon={<QueryStatsRoundedIcon />}
              label="Total prints"
              primaryValue={formatWholeNumber(stats.stats.totalPrints)}
              description={dateRange
                ? 'Retained jobs finished in the selected period.'
                : 'Lifetime totals, including deleted job history.'}
              items={[
                {
                  label: 'Successful',
                  value: formatWholeNumber(stats.stats.successfulPrints),
                  amount: stats.stats.successfulPrints,
                  color: SUCCESS_COLOR
                },
                {
                  label: 'Failed',
                  value: formatWholeNumber(stats.stats.failedPrints),
                  amount: stats.stats.failedPrints,
                  color: FAILED_COLOR
                },
                {
                  label: 'Cancelled',
                  value: formatWholeNumber(stats.stats.cancelledPrints),
                  amount: stats.stats.cancelledPrints,
                  color: CANCELLED_COLOR
                }
              ]}
            />
            <BreakdownStatCard
              icon={<AccessTimeRoundedIcon />}
              label="Print hours"
              primaryValue={`${formatDecimal(stats.stats.totalPrintHours)} h`}
              description="Printer runtime."
              items={[
                {
                  label: 'Successful',
                  value: `${formatDecimal(stats.stats.successfulPrintHours)} h`,
                  amount: stats.stats.successfulPrintHours,
                  color: SUCCESS_COLOR
                },
                {
                  label: 'Failed',
                  value: `${formatDecimal(stats.stats.failedPrintHours)} h`,
                  amount: stats.stats.failedPrintHours,
                  color: FAILED_COLOR
                },
                {
                  label: 'Cancelled',
                  value: `${formatDecimal(stats.stats.cancelledPrintHours)} h`,
                  amount: stats.stats.cancelledPrintHours,
                  color: CANCELLED_COLOR
                }
              ]}
            />
          </Box>
          {canViewPrinters ? (
            <Box sx={STATS_CARD_GRID_SX}>
              <PrinterReliabilityCard dateRange={dateRange} />
              <ModelReliabilityCard dateRange={dateRange} />
              <MaterialReliabilityCard dateRange={dateRange} />
            </Box>
          ) : null}
        </Stack>

        <Stack spacing={1.25}>
          <PageSectionHeading
            icon={<ScaleRoundedIcon />}
            title="Filament usage"
            description="How much filament was used and which materials were printed."
          />
          <Box sx={STATS_CARD_GRID_SX}>
            <BreakdownStatCard
              icon={<ScaleRoundedIcon />}
              label="Filament printed"
              primaryValue={stats.stats.filamentKilogramsPrinted == null ? 'Not tracked yet' : `${formatDecimal(stats.stats.filamentKilogramsPrinted)} kg`}
              description="Tracked filament mass."
              items={[
                {
                  label: 'Successful',
                  value: stats.stats.successfulFilamentKilogramsPrinted == null ? 'Not tracked' : `${formatDecimal(stats.stats.successfulFilamentKilogramsPrinted)} kg`,
                  amount: stats.stats.successfulFilamentKilogramsPrinted ?? 0,
                  color: SUCCESS_COLOR
                },
                {
                  label: 'Failed',
                  value: stats.stats.failedFilamentKilogramsPrinted == null ? 'Not tracked' : `${formatDecimal(stats.stats.failedFilamentKilogramsPrinted)} kg`,
                  amount: stats.stats.failedFilamentKilogramsPrinted ?? 0,
                  color: FAILED_COLOR
                },
                {
                  label: 'Cancelled',
                  value: stats.stats.cancelledFilamentKilogramsPrinted == null ? 'Not tracked' : `${formatDecimal(stats.stats.cancelledFilamentKilogramsPrinted)} kg`,
                  amount: stats.stats.cancelledFilamentKilogramsPrinted ?? 0,
                  color: CANCELLED_COLOR
                }
              ]}
            />
            <BreakdownStatCard
              icon={<StraightenRoundedIcon />}
              label="Filament length"
              primaryValue={stats.stats.filamentMetersPrinted == null ? 'Not tracked yet' : `${formatDecimal(stats.stats.filamentMetersPrinted)} m`}
              description={stats.stats.filamentFeetPrinted == null ? 'Linear filament usage.' : `${formatDecimal(stats.stats.filamentFeetPrinted)} ft total tracked.`}
              items={[
                {
                  label: 'Successful',
                  value: stats.stats.successfulFilamentMetersPrinted == null || stats.stats.successfulFilamentFeetPrinted == null ? 'Not tracked' : `${formatDecimal(stats.stats.successfulFilamentMetersPrinted)} m / ${formatDecimal(stats.stats.successfulFilamentFeetPrinted)} ft`,
                  amount: stats.stats.successfulFilamentMetersPrinted ?? 0,
                  color: SUCCESS_COLOR
                },
                {
                  label: 'Failed',
                  value: stats.stats.failedFilamentMetersPrinted == null || stats.stats.failedFilamentFeetPrinted == null ? 'Not tracked' : `${formatDecimal(stats.stats.failedFilamentMetersPrinted)} m / ${formatDecimal(stats.stats.failedFilamentFeetPrinted)} ft`,
                  amount: stats.stats.failedFilamentMetersPrinted ?? 0,
                  color: FAILED_COLOR
                },
                {
                  label: 'Cancelled',
                  value: stats.stats.cancelledFilamentMetersPrinted == null || stats.stats.cancelledFilamentFeetPrinted == null ? 'Not tracked' : `${formatDecimal(stats.stats.cancelledFilamentMetersPrinted)} m / ${formatDecimal(stats.stats.cancelledFilamentFeetPrinted)} ft`,
                  amount: stats.stats.cancelledFilamentMetersPrinted ?? 0,
                  color: CANCELLED_COLOR
                }
              ]}
            />
            <PluginSlot name="stats.cards" />
          </Box>
        </Stack>
      </Stack>
    </Stack>
  )
}

function formatWholeNumber(value: number): string {
  return new Intl.NumberFormat().format(value)
}

function formatDecimal(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
}
