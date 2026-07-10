/**
 * Calibration page: start pressure-advance / flow-ratio calibrations, track each
 * run through slicing → printing → result entry, and manage the saved values that
 * are reused when matching filament is loaded. Runs poll while any is still
 * working (the slice queue emits no WS event).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Button, Card, Chip, IconButton, Sheet, Stack, Table, Typography } from '@mui/joy'
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CalibrationRun, Printer } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { toast } from '../../lib/toast'
import { EmptyState } from '../../components/EmptyState'
import {
  calibrationKeys,
  deleteCalibrationResult,
  deleteCalibrationRun,
  fetchCalibrationResults,
  fetchCalibrationRuns,
  isCalibrationRunActive,
  printCalibrationRun
} from './api'
import { NewCalibrationDialog } from './NewCalibrationDialog'
import { CalibrationResultDialog } from './CalibrationResultDialog'
import { runTitle } from './runPresentation'
import { suppressJobToast } from '../../lib/dialogToastSuppression'

const STATUS_LABELS: Record<CalibrationRun['status'], { label: string; color: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' }> = {
  slicing: { label: 'Slicing', color: 'primary' },
  readyToPrint: { label: 'Ready to print', color: 'primary' },
  printing: { label: 'Printing', color: 'primary' },
  awaitingResult: { label: 'Awaiting result', color: 'warning' },
  saved: { label: 'Saved', color: 'success' },
  discarded: { label: 'Discarded', color: 'neutral' },
  failed: { label: 'Failed', color: 'danger' }
}

/** One-line "what happens next" guidance per status, so a run reads as a step-by-step flow. */
const NEXT_STEP: Record<CalibrationRun['status'], string | null> = {
  slicing: 'Preparing your calibration print…',
  readyToPrint: 'Ready. Clear the plate, then print it.',
  printing: 'Printing… measure the result and enter it once it finishes.',
  awaitingResult: 'Measure the print, then enter the result to save it.',
  saved: null,
  discarded: null,
  failed: null
}

export function CalibrationView() {
  const queryClient = useQueryClient()
  const [showNew, setShowNew] = useState(false)
  const [resultRun, setResultRun] = useState<CalibrationRun | null>(null)
  // Stable across the parent's frequent re-renders (printer-status ticks) so the
  // memoized dialogs don't re-render — otherwise a fresh inline `onClose` each
  // render defeats React.memo and thrashes their dropdowns.
  const closeNewDialog = useCallback(() => setShowNew(false), [])
  const closeResultDialog = useCallback(() => setResultRun(null), [])

  // Shares the `['printers']` cache key with the rest of the app, which stores the
  // full `{ printers }` response — read `.printers`, never treat data as the array.
  const printersQuery = useQuery<{ printers: Printer[] }>({
    queryKey: ['printers'],
    queryFn: ({ signal }) => apiFetch<{ printers: Printer[] }>('/api/printers', { signal })
  })
  const runsQuery = useQuery({
    queryKey: calibrationKeys.runs,
    queryFn: ({ signal }) => fetchCalibrationRuns(signal),
    // Poll only while a run is still working (the slice queue and print dispatch emit no WS event we
    // subscribe to here). Once a run reaches awaitingResult the interval stops — but the print often
    // finishes while this tab is backgrounded (the user starts it, then goes to watch the printer),
    // which pauses the interval, so refetch on focus too or a returning user sees a stale page with no
    // "Enter result" action until a manual reload.
    refetchInterval: (query) => (query.state.data?.some(isCalibrationRunActive) ? 3000 : false),
    refetchOnWindowFocus: true
  })
  const resultsQuery = useQuery({ queryKey: calibrationKeys.results, queryFn: ({ signal }) => fetchCalibrationResults(signal) })

  const runs = runsQuery.data ?? []
  const results = resultsQuery.data ?? []
  const printers = useMemo(() => printersQuery.data?.printers ?? [], [printersQuery.data])

  // This page shows each run's slice progress inline (status chip + next-step line), so the global
  // slicing toast for a calibration run is redundant — suppress it while its slice is in flight.
  const slicingJobIds = runs.filter((run) => run.status === 'slicing' && run.slicingJobId).map((run) => run.slicingJobId!).join(',')
  useEffect(() => {
    const cleanups = slicingJobIds ? slicingJobIds.split(',').map((jobId) => suppressJobToast('slicing', jobId)) : []
    return () => { for (const cleanup of cleanups) cleanup() }
  }, [slicingJobIds])

  const invalidateRuns = () => queryClient.invalidateQueries({ queryKey: calibrationKeys.runs })

  // Errors are surfaced once by the global mutation error handler (main.tsx); do not add a local
  // onError toast here or the message shows twice.
  const printRun = useMutation({
    mutationFn: (runId: string) => printCalibrationRun(runId),
    onSuccess: () => { void invalidateRuns(); toast.success('Calibration print dispatched') }
  })
  const removeRun = useMutation({
    mutationFn: (runId: string) => deleteCalibrationRun(runId),
    onSuccess: () => void invalidateRuns()
  })
  const removeResult = useMutation({
    mutationFn: (resultId: string) => deleteCalibrationResult(resultId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: calibrationKeys.results })
  })

  const printerName = useMemo(() => new Map(printers.map((printer) => [printer.id, printer.name])), [printers])

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="flex-start" justifyContent="space-between" sx={{ flexWrap: 'wrap' }}>
        <Typography level="h3" startDecorator={<ScienceRoundedIcon />}>Calibration</Typography>
        <Button size="sm" startDecorator={<AddRoundedIcon />} onClick={() => setShowNew(true)} disabled={printers.length === 0}>New calibration</Button>
      </Stack>

      <Box>
        <Typography level="title-md" sx={{ mb: 1 }}>Runs</Typography>
        {runs.length === 0 ? (
          <Sheet variant="soft" sx={{ borderRadius: 'md', p: 2 }}>
            <EmptyState icon={<ScienceRoundedIcon />} title="No calibrations yet" description="Print a pressure-advance tower or flow-ratio plate, then enter the result to save it." action={<Button size="sm" startDecorator={<AddRoundedIcon />} onClick={() => setShowNew(true)} disabled={printers.length === 0}>New calibration</Button>} />
          </Sheet>
        ) : (
        <Stack spacing={1}>
          {runs.map((run) => {
            const badge = STATUS_LABELS[run.status]
            return (
              <Card key={run.id} variant="outlined" orientation="horizontal" sx={{ alignItems: 'center', gap: 1.5 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography level="title-sm">{runTitle(run)}</Typography>
                  <Typography level="body-xs" textColor="text.tertiary">
                    {printerName.get(run.printerId ?? '') ?? 'Printer'} · {run.printerModel} · {run.nozzleDiameter} mm
                    {run.resultValue != null ? ` · ${run.parameters.kind === 'flowRatio' ? `flow ${run.resultValue.toFixed(3)}` : `K ${run.resultValue.toFixed(4)}`}` : ''}
                  </Typography>
                  {run.errorMessage ? <Typography level="body-xs" color="danger">{run.errorMessage}</Typography> : null}
                  {!run.errorMessage && NEXT_STEP[run.status] ? (
                    <Typography level="body-xs" textColor="text.secondary" sx={{ mt: 0.25 }}>{NEXT_STEP[run.status]}</Typography>
                  ) : null}
                </Box>
                <Chip size="sm" variant="soft" color={badge.color}>{badge.label}</Chip>
                {run.status === 'readyToPrint' ? <Button size="sm" onClick={() => printRun.mutate(run.id)} loading={printRun.isPending}>Print</Button> : null}
                {/* A saved run stays editable: the dialog resubmits the on-screen measurement and
                    the result store upserts (re-applying to the printer), so a mis-entered
                    measurement can be corrected without reprinting the test. */}
                {run.status === 'awaitingResult' || run.status === 'saved' ? (
                  <Button
                    size="sm"
                    variant={run.status === 'saved' && run.resultValue != null ? 'outlined' : 'solid'}
                    color={run.status === 'saved' && run.resultValue != null ? 'neutral' : 'primary'}
                    onClick={() => setResultRun(run)}
                  >
                    {run.status === 'saved' && run.resultValue != null ? 'Edit result' : 'Enter result'}
                  </Button>
                ) : null}
                <IconButton size="sm" variant="plain" color="danger" aria-label="Delete run" onClick={() => removeRun.mutate(run.id)}><DeleteRoundedIcon /></IconButton>
              </Card>
            )
          })}
        </Stack>
        )}
      </Box>

      <Box>
        <Typography level="title-md" sx={{ mb: 1 }}>Saved values</Typography>
        {results.length === 0 ? (
          <Typography level="body-sm" textColor="text.tertiary">Saved calibrations appear here and are applied automatically to matching filament.</Typography>
        ) : (
          <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
            <Table size="sm" borderAxis="xBetween" hoverRow>
              <thead>
                <tr><th>Test</th><th>Value</th><th>Applies to</th><th>Printer</th><th aria-label="Actions" style={{ width: 48 }} /></tr>
              </thead>
              <tbody>
                {results.map((result) => (
                  <tr key={result.id}>
                    <th scope="row">{result.kind === 'flowRatio' ? 'Flow ratio' : 'Pressure advance'}</th>
                    <td>{result.kind === 'flowRatio' ? result.value.toFixed(3) : `K ${result.value.toFixed(4)}`}</td>
                    <td>{result.scope === 'spool' ? 'This spool' : [result.brand, result.filamentType, result.materialSubtype, result.colorName].filter(Boolean).join(' ') || 'Any filament'}</td>
                    <td>{result.printerModel} · {result.nozzleDiameter} mm</td>
                    <td><IconButton size="sm" variant="plain" color="danger" aria-label="Delete saved value" onClick={() => removeResult.mutate(result.id)}><DeleteRoundedIcon /></IconButton></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Sheet>
        )}
      </Box>

      {showNew ? <NewCalibrationDialog printers={printers} onClose={closeNewDialog} /> : null}
      {resultRun ? <CalibrationResultDialog run={resultRun} onClose={closeResultDialog} /> : null}
    </Stack>
  )
}
