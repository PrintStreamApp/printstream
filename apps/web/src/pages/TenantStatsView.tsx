import ChecklistRoundedIcon from '@mui/icons-material/ChecklistRounded'
import RouterRoundedIcon from '@mui/icons-material/RouterRounded'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'
import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded'
import StraightenRoundedIcon from '@mui/icons-material/StraightenRounded'
import ScaleRoundedIcon from '@mui/icons-material/ScaleRounded'
import AccessTimeRoundedIcon from '@mui/icons-material/AccessTimeRounded'
import type { TenantStatsResponse } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Alert, Box, Card, CardContent, Stack, Typography } from '@mui/joy'
import { Link as RouterLink, useLocation } from 'react-router-dom'
import { Printer3dRoundedIcon } from '../components/Printer3dRoundedIcon'
import { ActivityTrendStatCard, BreakdownStatCard, CapacityTrendStatCard } from '../components/StatsCards'
import { apiFetch } from '../lib/apiClient'
import { buildTenantWorkspacePath, buildWorkspaceSelectionPath, parseWorkspacePathname } from '../lib/workspaceRoute'

const SUCCESS_COLOR = 'var(--joy-palette-success-500)'
const FAILED_COLOR = 'var(--joy-palette-danger-500)'
const CANCELLED_COLOR = 'var(--joy-palette-neutral-500)'

/**
 * Tenant stats page. It starts with a quick-start checklist until the
 * workspace has bridges and printers, then graduates to production stats.
 */
export function TenantStatsView({
  canOpenSettings
}: {
  canOpenSettings: boolean
}) {
  const location = useLocation()
  const tenantSlug = parseWorkspacePathname(location.pathname).tenantSlug
  const statsQuery = useQuery({
    queryKey: ['tenant-stats'],
    queryFn: ({ signal }) => apiFetch<TenantStatsResponse>('/api/stats', { signal })
  })
  const workspacePath = (path: string) => tenantSlug ? buildTenantWorkspacePath(tenantSlug, path) : buildWorkspaceSelectionPath()

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
          {stats.setupRequired
            ? 'Finish setup to start tracking printers, jobs, and production in this workspace.'
            : 'Track current printing activity and production totals for this workspace at a glance.'}
        </Typography>
      </Stack>

      {stats.setupRequired ? (
        <Stack spacing={1.5}>
          <Typography level="title-md" startDecorator={<ChecklistRoundedIcon />}>
            Quick start ({stats.quickStartCompletedCount}/{stats.quickStartItems.length})
          </Typography>
          {stats.quickStartItems.map((item) => (
            <QuickStartCard
              key={item.id}
              icon={item.id === 'connect-bridge' ? <RouterRoundedIcon /> : <Printer3dRoundedIcon />}
              title={item.complete ? `${item.title} complete` : item.title}
              description={item.description}
              actionTo={resolveQuickStartHref(item.id, canOpenSettings, item.complete, workspacePath)}
            />
          ))}
        </Stack>
      ) : (
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
      )}
    </Stack>
  )
}

function resolveQuickStartHref(id: TenantStatsResponse['quickStartItems'][number]['id'], canOpenSettings: boolean, complete: boolean, workspacePath: (path: string) => string): string | undefined {
  if (complete) return undefined
  if (id === 'connect-bridge') return canOpenSettings ? workspacePath('/settings/bridges') : undefined
  if (id === 'add-printer') return workspacePath('/printers')
  return workspacePath('/library')
}

function formatWholeNumber(value: number): string {
  return new Intl.NumberFormat().format(value)
}

function formatDecimal(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
}

function QuickStartCard({
  icon,
  title,
  description,
  actionTo,
  actionLabel
}: {
  icon: ReactNode
  title: string
  description: string
  actionTo?: string
  actionLabel?: string
}) {
  const content = (
    <CardContent>
      <Stack direction="row" spacing={1.5} justifyContent="space-between" alignItems="center">
        <Stack spacing={1.25} sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography level="title-lg" sx={{ display: 'inline-flex', alignItems: 'center' }}>
              {icon}
            </Typography>
            <Typography level="title-lg">{title}</Typography>
          </Stack>
          <Typography level="body-sm" textColor="text.tertiary">{description}</Typography>
        </Stack>
        {actionTo ? (
          <Typography
            aria-hidden="true"
            level="title-lg"
            textColor="text.tertiary"
            sx={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
          >
            <KeyboardArrowRightRoundedIcon />
          </Typography>
        ) : null}
      </Stack>
      {actionLabel && !actionTo ? (
        <Typography level="body-xs" textColor="text.tertiary">
          {actionLabel}
        </Typography>
      ) : null}
    </CardContent>
  )

  const cardSx = {
    textAlign: 'left',
    ...(actionTo
      ? {
          cursor: 'pointer',
          textDecoration: 'none',
          color: 'inherit',
          transition: 'background-color 0.2s ease, border-color 0.2s ease, transform 0.2s ease',
          '&:hover': {
            backgroundColor: 'background.level1',
            borderColor: 'primary.softColor'
          },
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'focusVisible',
            outlineOffset: '2px'
          }
        }
      : {})
  } as const

  if (actionTo) {
    return (
      <Card component={RouterLink} to={actionTo} variant="outlined" sx={cardSx}>
        {content}
      </Card>
    )
  }

  return (
    <Card variant="outlined" sx={cardSx}>
      {content}
    </Card>
  )
}