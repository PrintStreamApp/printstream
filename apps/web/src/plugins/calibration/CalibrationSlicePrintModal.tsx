/**
 * Slice-then-print tracker for a calibration run, mirroring the library's
 * `SliceThenPrintModal` flow: it stays open after the wizard starts a run, shows
 * live slice progress, and — once the slice is ready — offers a Print button that
 * dispatches the calibration to the printer/slot the wizard already chose. Unlike
 * the library flow it does not hand off to `PrintModal` (there is no printer/AMS
 * choice to make), and leaving does not orphan anything: the run is a tracked
 * entity that stays on the Calibration page to be printed or discarded later.
 *
 * On close (any exit) it routes to the Calibration page so the user lands where
 * the run lives instead of back on wherever they launched it from.
 */
import { useCallback, useEffect, useMemo } from 'react'
import { Alert, Button, Chip, CircularProgress, DialogActions, LinearProgress, Sheet, Stack, Typography } from '@mui/joy'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import type { CalibrationRun } from '@printstream/shared'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { toast } from '../../lib/toast'
import { suppressJobToast } from '../../lib/dialogToastSuppression'
import { buildTenantWorkspacePath, parseWorkspacePathname } from '../../lib/workspaceRoute'
import { useSlicingJobs } from '../../hooks/useSlicingJobs'
import {
  formatSlicingProgress,
  getLatestSlicingProgressFrame,
  slicingStatusColor
} from '../../lib/slicingJobPresentation'
import { formatSecondsDuration } from '../../lib/time'
import { calibrationKeys, fetchCalibrationRuns, isCalibrationRunActive, printCalibrationRun } from './api'
import { runTitle } from './runPresentation'

const STATUS_LABELS: Record<CalibrationRun['status'], { label: string; color: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' }> = {
  slicing: { label: 'Slicing', color: 'primary' },
  readyToPrint: { label: 'Ready to print', color: 'primary' },
  printing: { label: 'Printing', color: 'primary' },
  awaitingResult: { label: 'Awaiting result', color: 'warning' },
  saved: { label: 'Saved', color: 'success' },
  discarded: { label: 'Discarded', color: 'neutral' },
  failed: { label: 'Failed', color: 'danger' }
}

export function CalibrationSlicePrintModal({ run: initialRun, onClose }: { run: CalibrationRun; onClose: () => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()

  // Authoritative run lifecycle (slicing -> readyToPrint -> printing) comes from the runs list, which
  // reconciles the slice queue on read; the slicing job only supplies the live progress bar detail.
  const runsQuery = useQuery({
    queryKey: calibrationKeys.runs,
    queryFn: ({ signal }) => fetchCalibrationRuns(signal),
    refetchInterval: (query) => (query.state.data?.some(isCalibrationRunActive) ? 3000 : false),
    refetchOnWindowFocus: true
  })
  const run = useMemo(
    () => runsQuery.data?.find((entry) => entry.id === initialRun.id) ?? initialRun,
    [runsQuery.data, initialRun]
  )

  const slicingJobsQuery = useSlicingJobs({ suppressGlobalErrorToast: true })
  // This dialog shows the slice inline, so its redundant global toast is suppressed while open.
  useEffect(() => (run.slicingJobId ? suppressJobToast('slicing', run.slicingJobId) : undefined), [run.slicingJobId])
  const job = useMemo(
    () => (run.slicingJobId ? slicingJobsQuery.data?.jobs.find((entry) => entry.id === run.slicingJobId) ?? null : null),
    [run.slicingJobId, slicingJobsQuery.data?.jobs]
  )

  // Every exit lands on the Calibration page so the run is visible where it is managed.
  const handleClose = useCallback(() => {
    const { tenantSlug } = parseWorkspacePathname(location.pathname)
    if (tenantSlug) navigate(buildTenantWorkspacePath(tenantSlug, '/calibration'))
    onClose()
  }, [location.pathname, navigate, onClose])

  // Errors surface once via the global mutation error handler (main.tsx) — no local onError toast.
  const print = useMutation({
    mutationFn: () => printCalibrationRun(run.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: calibrationKeys.runs })
      toast.success('Calibration print started — measure it and enter the result when it finishes')
      handleClose()
    }
  })

  const progressFrame = job ? getLatestSlicingProgressFrame(job) : null
  const progressPercent = progressFrame?.displayPercent ?? progressFrame?.totalPercent ?? null
  const badge = STATUS_LABELS[run.status]
  const isSlicing = run.status === 'slicing'
  const isReady = run.status === 'readyToPrint'
  const isFailed = run.status === 'failed'

  const metadata = job?.metadata
  const stats: Array<{ label: string; value: string }> = []
  if (isReady && metadata?.estimatedPrintTimeSeconds != null && metadata.estimatedPrintTimeSeconds >= 1) {
    stats.push({ label: 'Estimated print time', value: formatSecondsDuration(metadata.estimatedPrintTimeSeconds) })
  }
  if (isReady && metadata?.estimatedFilamentWeightGrams != null) {
    stats.push({ label: 'Material used', value: `${metadata.estimatedFilamentWeightGrams.toFixed(1)} g` })
  }

  return (
    <Modal open onClose={handleClose}>
      <ScrollableModalDialog sx={{ maxWidth: 520, width: '100%' }}>
        <Typography level="h4">Calibration</Typography>
        <ScrollableDialogBody sx={{ mt: 1 }}>
          <Stack spacing={1.25}>
            <Typography level="body-sm" textColor="text.tertiary">
              {isReady
                ? 'Slicing finished. Clear the plate, then start the print.'
                : isFailed
                  ? 'Slicing failed. You can close this and try again from the Calibration page.'
                  : 'Preparing your calibration print. This stays here until it is ready to print.'}
            </Typography>

            {slicingJobsQuery.isLoading && !job && isSlicing && (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size="sm" />
                <Typography level="body-sm" textColor="text.secondary">Loading slice progress…</Typography>
              </Stack>
            )}

            <Sheet variant="outlined" sx={{ p: 1.25, borderRadius: 'sm' }}>
              <Stack spacing={1}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                  <Typography level="title-md" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>{runTitle(run)}</Typography>
                  <Chip size="sm" variant="soft" color={badge.color}>{badge.label}</Chip>
                </Stack>
                <Typography level="body-xs" textColor="text.tertiary">
                  {run.printerModel} · {run.nozzleDiameter} mm
                </Typography>
                {isSlicing && (
                  <>
                    <LinearProgress
                      determinate={progressPercent != null}
                      value={progressPercent ?? 0}
                      color={job ? slicingStatusColor(job.status) : 'primary'}
                    />
                    <Typography level="body-sm" textColor="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                      {job ? formatSlicingProgress(job, progressFrame) : 'Waiting for the slicer…'}
                    </Typography>
                  </>
                )}
                {stats.length > 0 && (
                  <Stack spacing={0.5}>
                    {stats.map((stat) => (
                      <Stack key={stat.label} direction="row" justifyContent="space-between" spacing={2}>
                        <Typography level="body-sm" textColor="text.tertiary">{stat.label}</Typography>
                        <Typography level="body-sm" fontWeight="md">{stat.value}</Typography>
                      </Stack>
                    ))}
                  </Stack>
                )}
                {isFailed && run.errorMessage && (
                  <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{run.errorMessage}</Alert>
                )}
                {job?.status === 'failed' && !isFailed && job.error && (
                  <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>{job.error}</Alert>
                )}
              </Stack>
            </Sheet>
          </Stack>
        </ScrollableDialogBody>
        <DialogActions>
          <Button type="button" variant="plain" color="neutral" onClick={handleClose}>
            {isSlicing ? 'Slice in background' : 'Close'}
          </Button>
          {isReady && (
            <Button type="button" startDecorator={<PrintRoundedIcon />} loading={print.isPending} onClick={() => print.mutate()}>
              Print calibration
            </Button>
          )}
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}
