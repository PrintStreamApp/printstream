import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded'
import StraightenRoundedIcon from '@mui/icons-material/StraightenRounded'
import ScaleRoundedIcon from '@mui/icons-material/ScaleRounded'
import AccessTimeRoundedIcon from '@mui/icons-material/AccessTimeRounded'
import type { TenantStatsResponse } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { Alert, Box, Stack, Typography } from '@mui/joy'
import { Printer3dRoundedIcon } from '../components/Printer3dRoundedIcon'
import { ActivityTrendStatCard, BreakdownStatCard, CapacityTrendStatCard } from '../components/StatsCards'
import { apiFetch } from '../lib/apiClient'

const SUCCESS_COLOR = 'var(--joy-palette-success-500)'
const FAILED_COLOR = 'var(--joy-palette-danger-500)'
const CANCELLED_COLOR = 'var(--joy-palette-neutral-500)'

/**
 * Tenant stats page: current printing activity and production totals.
 * Workspace onboarding lives on the Get started page (`GetStartedView`).
 */
export function TenantStatsView() {
  const statsQuery = useQuery({
    queryKey: ['tenant-stats'],
    queryFn: ({ signal }) => apiFetch<TenantStatsResponse>('/api/stats', { signal })
  })

  if (statsQuery.isLoading) {
    return (
      <Stack spacing={2}>
        <Typography level="h3">Stats</Typography>
        <Typography>Loading…</Typography>
      </Stack>
    )
  }

  if (statsQuery.isError || !statsQuery.data) {
    return (
      <Stack spacing={2}>
        <Typography level="h3">Stats</Typography>
        <Alert color="danger" variant="soft">
          Workspace stats could not be loaded right now.
        </Alert>
      </Stack>
    )
  }

  const stats = statsQuery.data
  const todaysActivity = stats.stats.activityLast30Days[stats.stats.activityLast30Days.length - 1]
  return (
    <Stack spacing={2}>
      <Stack spacing={0.75}>
        <Typography level="h3">Stats</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Track current printing activity and production totals for this workspace at a glance.
        </Typography>
      </Stack>

      <Stack spacing={1.5}>
        <Typography level="title-md" startDecorator={<QueryStatsRoundedIcon />}>Workspace stats</Typography>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: 'minmax(0, 1fr)',
              sm: 'repeat(2, minmax(0, 1fr))',
              lg: 'repeat(3, minmax(0, 1fr))'
            },
            gap: 1.5
          }}
        >
          <ActivityTrendStatCard
            icon={<Printer3dRoundedIcon />}
            label="Printer activity"
            activePrintersValue={`${formatWholeNumber(stats.stats.printsInProgress)} of ${formatWholeNumber(stats.stats.printerCount)}`}
            activityLast30Days={stats.stats.activityLast30Days}
          />
          <CapacityTrendStatCard
            icon={<AccessTimeRoundedIcon />}
            label="Print capacity"
            capacityValue={`${formatDecimal(todaysActivity?.usedPrintHours ?? 0)} of ${formatDecimal(todaysActivity?.capacityPrintHours ?? 0)} h`}
            activityLast30Days={stats.stats.activityLast30Days}
          />
          <BreakdownStatCard
            icon={<QueryStatsRoundedIcon />}
            label="Total prints"
            primaryValue={formatWholeNumber(stats.stats.totalPrints)}
            description="All recorded print jobs."
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
        </Box>
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
