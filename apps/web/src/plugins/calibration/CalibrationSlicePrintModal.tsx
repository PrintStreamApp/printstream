/**
 * Slice-then-print tracker for a calibration run, mirroring the library's
 * `SliceThenPrintModal` flow: it stays open after the wizard starts a run, shows
 * live slice progress, and, once the slice is ready, offers a Print button that
 * dispatches the calibration to the printer/slot the wizard already chose. Unlike
 * the library flow it does not hand off to `PrintModal` (there is no printer/AMS
 * choice to make), and leaving does not orphan anything: the run is a tracked
 * entity that stays on the Calibration page to be printed or discarded later.
 *
 * On close (any exit) it routes to the Calibration page so the user lands where
 * the run lives instead of back on wherever they launched it from.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Chip, CircularProgress, DialogActions, Sheet, Stack, Typography } from '@mui/joy'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { PRINTERS_CLEAR_PLATE_PERMISSION, isAutomaticPressureAdvance, type CalibrationRun } from '@printstream/shared'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { usePromptDialog } from '../../components/PromptDialogProvider'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { SliceEstimates } from '../../components/library/SliceEstimates'
import { PluginSlot } from '../../plugin/PluginSlot'
import { toast } from '../../lib/toast'
import { suppressJobToast } from '../../lib/dialogToastSuppression'
import { buildWorkspacePath, parseWorkspacePathname } from '../../lib/workspaceRoute'
import { useSlicingJob } from '../../hooks/useSlicingJob'
import {
  formatSlicingProgress,
  getLatestSlicingProgressFrame,
  getSlicingProgressPercent,
  slicingStatusColor
} from '../../lib/slicingJobPresentation'
import { calibrationKeys, fetchCalibrationRuns, isCalibrationRunActive, printCalibrationRun } from './api'
import { runTitle } from './runPresentation'
import { ProgressBar } from '../../components/ProgressBar'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import {
  useMarkPrinterPlateCleared,
  usePlateClearingState,
  usePlateClearingSync
} from '../../lib/plateClearing'

const STATUS_LABELS: Record<CalibrationRun['status'], { label: string; color: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' }> = {
  slicing: { label: 'Slicing', color: 'primary' },
  readyToPrint: { label: 'Ready to print', color: 'primary' },
  printing: { label: 'Printing', color: 'primary' },
  awaitingResult: { label: 'Awaiting result', color: 'warning' },
  saved: { label: 'Saved', color: 'success' },
  failed: { label: 'Failed', color: 'danger' }
}

export function CalibrationSlicePrintModal({ run: initialRun, onClose }: { run: CalibrationRun; onClose: () => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const { confirm } = usePromptDialog()
  const [previewing, setPreviewing] = useState(false)
  usePlateClearingSync()

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
  const automatic = isAutomaticPressureAdvance(run.parameters)

  // The job's own record, not the list: the list carries only active/recent jobs now, and this
  // dialog can be reopened on a run whose slice finished long ago.
  const slicingJobQuery = useSlicingJob(run.slicingJobId)
  // This dialog shows the slice inline, so its redundant global toast is suppressed while open.
  useEffect(() => (run.slicingJobId ? suppressJobToast('slicing', run.slicingJobId) : undefined), [run.slicingJobId])
  const job = slicingJobQuery.data?.job ?? null

  // Every exit lands on the Calibration page so the run is visible where it is managed.
  const handleClose = useCallback(() => {
    const { workspaceSlug } = parseWorkspacePathname(location.pathname)
    if (workspaceSlug) navigate(buildWorkspacePath(workspaceSlug, '/calibration'))
    onClose()
  }, [location.pathname, navigate, onClose])

  // Errors surface once via the global mutation error handler (main.tsx), no local onError toast.
  const print = useMutation({
    mutationFn: () => printCalibrationRun(run.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: calibrationKeys.runs })
      toast.success(automatic ? 'Automatic calibration started. Review the measured result when it finishes.' : 'Calibration print started: measure it and enter the result when it finishes')
      handleClose()
    }
  })

  const progressFrame = job ? getLatestSlicingProgressFrame(job) : null
  const progressPercent = job ? getSlicingProgressPercent(job, progressFrame) : null
  const badge = STATUS_LABELS[run.status]
  const isSlicing = run.status === 'slicing'
  const isReady = run.status === 'readyToPrint'
  const isFailed = run.status === 'failed'
  const plateClearing = usePlateClearingState(run.printerId ?? '')
  const markPlateCleared = useMarkPrinterPlateCleared()
  const authBootstrapQuery = useAuthBootstrapQuery()
  const authEnabled = authBootstrapQuery.data?.authEnabled ?? false
  const canClearPlate = authBootstrapQuery.data
    ? !authEnabled || authBootstrapQuery.data.permissions.includes(PRINTERS_CLEAR_PLATE_PERMISSION)
    : false
  const plateNeedsClear = isReady && !plateClearing.loading && !plateClearing.cleared

  /** Confirm the physical acknowledgement before changing the shared printer state. */
  const confirmPlateIsClear = async () => {
    if (!run.printerId) return
    const accepted = await confirm({
      title: 'Confirm build plate cleared?',
      description: 'Confirm that the printer build plate has been cleared?',
      confirmLabel: 'Plate is cleared',
      color: 'warning',
      confirmDecorator: <CheckCircleRoundedIcon />
    })
    if (!accepted) return
    try {
      await markPlateCleared.mutateAsync(run.printerId)
    } catch {
      // The global mutation handler surfaces the API error; keep this prepared run open.
    }
  }

  return (
    <>
    <Modal open onClose={handleClose}>
      <ScrollableModalDialog sx={{ maxWidth: 520, width: '100%' }}>
        <Typography level="h4">Calibration</Typography>
        <ScrollableDialogBody sx={{ mt: 1 }}>
          <Stack spacing={1.25}>
            <Typography level="body-sm" textColor="text.tertiary">
              {isReady
                ? automatic ? 'Clear the plate, then start automatic calibration.' : 'Slicing finished. Clear the plate, then start the print.'
                : isFailed
                  ? 'Calibration failed. You can close this and try again from the Calibration page.'
                  : 'Preparing your calibration print.'}
            </Typography>

            {slicingJobQuery.isLoading && !job && isSlicing && (
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
                    <ProgressBar
                      value={progressPercent}
                      color={job ? slicingStatusColor(job.status) : 'primary'}
                    />
                    <Typography level="body-sm" textColor="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                      {job ? formatSlicingProgress(job, progressFrame) : 'Waiting for the slicer…'}
                    </Typography>
                  </>
                )}
                {isReady && !automatic && (
                  <SliceEstimates metadata={job?.metadata} filamentMappings={job?.target.filamentMappings} />
                )}
                {isReady && run.outputFileId && (
                  <Button
                    type="button"
                    variant="outlined"
                    color="neutral"
                    size="sm"
                    startDecorator={<VisibilityRoundedIcon />}
                    onClick={() => setPreviewing(true)}
                    sx={{ width: { xs: '100%', sm: 'auto' }, alignSelf: { sm: 'flex-start' } }}
                  >
                    Preview
                  </Button>
                )}
                {plateNeedsClear && (
                  <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                    {canClearPlate
                      ? 'Confirm that the build plate is clear to print this calibration without starting over.'
                      : 'The build plate must be marked clear by someone with printer control permission.'}
                  </Alert>
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
            plateNeedsClear && canClearPlate ? (
              <Button
                type="button"
                color="warning"
                startDecorator={<CheckCircleRoundedIcon />}
                loading={markPlateCleared.isPending}
                onClick={() => void confirmPlateIsClear()}
              >
                Mark plate cleared
              </Button>
            ) : (
              <Button
                type="button"
                startDecorator={<PrintRoundedIcon />}
                loading={print.isPending || plateClearing.loading}
                disabled={plateNeedsClear}
                onClick={() => print.mutate()}
              >
                Print calibration
              </Button>
            )
          )}
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
    {/* Sliced-toolpath preview of the run's hidden output file; the model-studio plugin
        renders it on top of this dialog, mirroring the library slice-result flow. */}
    <PluginSlot
      name="library.overlays"
      context={{
        previewFileId: previewing && isReady ? run.outputFileId : null,
        previewPlateIndex: 1,
        onPreviewClose: () => setPreviewing(false)
      }}
    />
    </>
  )
}
