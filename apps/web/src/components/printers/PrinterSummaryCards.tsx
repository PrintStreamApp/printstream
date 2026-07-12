/**
 * Printer history and lifetime-stats summary cards extracted from
 * `pages/PrintersView.tsx`: `PrinterHistoryCard` wraps a finished job with
 * reprint/delete actions, and `PrinterStatsCardGrid` lays out the lifetime
 * print/filament breakdown cards for a single printer.
 */
import { Box, Button, Stack } from '@mui/joy'
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded'
import AccessTimeRoundedIcon from '@mui/icons-material/AccessTimeRounded'
import ScaleRoundedIcon from '@mui/icons-material/ScaleRounded'
import StraightenRoundedIcon from '@mui/icons-material/StraightenRounded'
import { isDirectPrintableFileName, type PrintJob, type PrinterStatsResponse } from '@printstream/shared'
import { BreakdownStatCard } from '../StatsCards'
import { PrintJobHistoryCard } from '../PrintJobHistoryCard'
import { formatPrinterStatsWholeNumber, formatPrinterStatsDecimal } from '../../lib/printersViewHelpers'
import { SUCCESS_COLOR, FAILED_COLOR, CANCELLED_COLOR, MANUAL_COLOR } from '../../lib/printerViewConstants'

export function PrinterHistoryCard({
  job,
  canDeleteJobs,
  canDispatchPrints,
  canControlPrinters,
  deletingJobId,
  replayingJobId,
  onDelete,
  onReprintLibrary,
  onReprintCalibration
}: {
  job: PrintJob
  canDeleteJobs: boolean
  canDispatchPrints: boolean
  canControlPrinters: boolean
  deletingJobId: string | null
  replayingJobId: string | null
  onDelete: (jobId: string) => void
  onReprintLibrary: (job: PrintJob) => void
  onReprintCalibration: (jobId: string) => void
}) {
  const canReprintLibrary = Boolean(
    canDispatchPrints
    && job.finishedAt
    && job.jobKind === 'file'
    && job.fileId
    && isDirectPrintableFileName(job.fileName || job.jobName || '')
  )
  const canReprintCalibration = Boolean(
    canControlPrinters
    && job.finishedAt
    && job.jobKind === 'calibration'
    && job.calibrationOption != null
  )

  const reprintAction = canReprintLibrary ? (
    <Button size="sm" variant="soft" startDecorator={<RestartAltRoundedIcon />} onClick={() => onReprintLibrary(job)}>
      Reprint
    </Button>
  ) : canReprintCalibration ? (
    <Button
      size="sm"
      variant="soft"
      startDecorator={<RestartAltRoundedIcon />}
      loading={replayingJobId === job.id}
      onClick={() => onReprintCalibration(job.id)}
    >
      Reprint
    </Button>
  ) : undefined
  const deleteAction = canDeleteJobs ? (
    <Button
      size="sm"
      variant="plain"
      color="danger"
      startDecorator={<DeleteRoundedIcon />}
      loading={deletingJobId === job.id}
      onClick={() => onDelete(job.id)}
    >
      Delete
    </Button>
  ) : undefined
  const action = reprintAction || deleteAction ? (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      {reprintAction}
      {deleteAction}
    </Stack>
  ) : undefined

  return <PrintJobHistoryCard job={job} showPrinterLink={false} action={action} />
}

export function PrinterStatsCardGrid({
  stats
}: {
  stats: PrinterStatsResponse['stats']
}) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: 'minmax(0, 1fr)',
          sm: 'repeat(2, minmax(0, 1fr))',
          xl: 'repeat(2, minmax(0, 1fr))'
        },
        gap: 1.5
      }}
    >
      <BreakdownStatCard
        icon={<QueryStatsRoundedIcon />}
        label="Total prints"
        primaryValue={formatPrinterStatsWholeNumber(stats.totalPrints)}
        description="All recorded jobs for this printer across its lifetime in this workspace, plus any manually added usage."
        items={[
          {
            label: 'Successful',
            value: formatPrinterStatsWholeNumber(stats.successfulPrints),
            amount: stats.successfulPrints,
            color: SUCCESS_COLOR
          },
          {
            label: 'Failed',
            value: formatPrinterStatsWholeNumber(stats.failedPrints),
            amount: stats.failedPrints,
            color: FAILED_COLOR
          },
          {
            label: 'Cancelled',
            value: formatPrinterStatsWholeNumber(stats.cancelledPrints),
            amount: stats.cancelledPrints,
            color: CANCELLED_COLOR
          },
          ...(stats.manualPrints > 0
            ? [{
                label: 'Manually added',
                value: formatPrinterStatsWholeNumber(stats.manualPrints),
                amount: stats.manualPrints,
                color: MANUAL_COLOR
              }]
            : [])
        ]}
      />
      <BreakdownStatCard
        icon={<AccessTimeRoundedIcon />}
        label="Print hours"
        primaryValue={`${formatPrinterStatsDecimal(stats.totalPrintHours)} h`}
        description="Printer runtime."
        items={[
          {
            label: 'Successful',
            value: `${formatPrinterStatsDecimal(stats.successfulPrintHours)} h`,
            amount: stats.successfulPrintHours,
            color: SUCCESS_COLOR
          },
          {
            label: 'Failed',
            value: `${formatPrinterStatsDecimal(stats.failedPrintHours)} h`,
            amount: stats.failedPrintHours,
            color: FAILED_COLOR
          },
          {
            label: 'Cancelled',
            value: `${formatPrinterStatsDecimal(stats.cancelledPrintHours)} h`,
            amount: stats.cancelledPrintHours,
            color: CANCELLED_COLOR
          },
          ...(stats.manualPrintHours > 0
            ? [{
                label: 'Manually added',
                value: `${formatPrinterStatsDecimal(stats.manualPrintHours)} h`,
                amount: stats.manualPrintHours,
                color: MANUAL_COLOR
              }]
            : [])
        ]}
      />
      <BreakdownStatCard
        icon={<ScaleRoundedIcon />}
        label="Filament printed"
        primaryValue={stats.filamentKilogramsPrinted == null ? 'Not tracked yet' : `${formatPrinterStatsDecimal(stats.filamentKilogramsPrinted)} kg`}
        description="Tracked filament mass."
        items={[
          {
            label: 'Successful',
            value: stats.successfulFilamentKilogramsPrinted == null ? 'Not tracked' : `${formatPrinterStatsDecimal(stats.successfulFilamentKilogramsPrinted)} kg`,
            amount: stats.successfulFilamentKilogramsPrinted ?? 0,
            color: SUCCESS_COLOR
          },
          {
            label: 'Failed',
            value: stats.failedFilamentKilogramsPrinted == null ? 'Not tracked' : `${formatPrinterStatsDecimal(stats.failedFilamentKilogramsPrinted)} kg`,
            amount: stats.failedFilamentKilogramsPrinted ?? 0,
            color: FAILED_COLOR
          },
          {
            label: 'Cancelled',
            value: stats.cancelledFilamentKilogramsPrinted == null ? 'Not tracked' : `${formatPrinterStatsDecimal(stats.cancelledFilamentKilogramsPrinted)} kg`,
            amount: stats.cancelledFilamentKilogramsPrinted ?? 0,
            color: CANCELLED_COLOR
          }
        ]}
      />
      <BreakdownStatCard
        icon={<StraightenRoundedIcon />}
        label="Filament length"
        primaryValue={stats.filamentMetersPrinted == null ? 'Not tracked yet' : `${formatPrinterStatsDecimal(stats.filamentMetersPrinted)} m`}
        description={stats.filamentFeetPrinted == null ? 'Linear filament usage recorded for finished prints on this printer.' : `${formatPrinterStatsDecimal(stats.filamentFeetPrinted)} ft total tracked.`}
        items={[
          {
            label: 'Successful',
            value: stats.successfulFilamentMetersPrinted == null || stats.successfulFilamentFeetPrinted == null ? 'Not tracked' : `${formatPrinterStatsDecimal(stats.successfulFilamentMetersPrinted)} m / ${formatPrinterStatsDecimal(stats.successfulFilamentFeetPrinted)} ft`,
            amount: stats.successfulFilamentMetersPrinted ?? 0,
            color: SUCCESS_COLOR
          },
          {
            label: 'Failed',
            value: stats.failedFilamentMetersPrinted == null || stats.failedFilamentFeetPrinted == null ? 'Not tracked' : `${formatPrinterStatsDecimal(stats.failedFilamentMetersPrinted)} m / ${formatPrinterStatsDecimal(stats.failedFilamentFeetPrinted)} ft`,
            amount: stats.failedFilamentMetersPrinted ?? 0,
            color: FAILED_COLOR
          },
          {
            label: 'Cancelled',
            value: stats.cancelledFilamentMetersPrinted == null || stats.cancelledFilamentFeetPrinted == null ? 'Not tracked' : `${formatPrinterStatsDecimal(stats.cancelledFilamentMetersPrinted)} m / ${formatPrinterStatsDecimal(stats.cancelledFilamentFeetPrinted)} ft`,
            amount: stats.cancelledFilamentMetersPrinted ?? 0,
            color: CANCELLED_COLOR
          }
        ]}
      />
    </Box>
  )
}
