/**
 * Calibration page: start filament and motion calibrations, track each
 * run through slicing → printing → result entry, and manage the saved values that
 * are reused when matching filament is loaded. Runs poll while any is still
 * working (the slice queue emits no WS event).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Button, Card, Chip, IconButton, Sheet, Stack, Table, Typography } from '@mui/joy'
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isAutomaticPressureAdvance, type CalibrationResult, type CalibrationRun, type Printer } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { EmptyState } from '../../components/EmptyState'
import { PageSectionHeading, pageSectionStackSpacing } from '../../components/dashboard/PageSectionHeading'
import {
  calibrationKeys,
  deleteCalibrationResult,
  deleteCalibrationRun,
  fetchCalibrationResults,
  fetchCalibrationRuns,
  isCalibrationRunActive
} from './api'
import { NewCalibrationDialog } from './NewCalibrationDialog'
import { CalibrationResultDialog, type CalibrationIdentitySuggestions } from './CalibrationResultDialog'
import { CalibrationSlicePrintModal } from './CalibrationSlicePrintModal'
import { calibrationKindLabel, calibrationValueLabel, calibrationPrinterTargetLabel, runTitle } from './runPresentation'
import { suppressJobToast } from '../../lib/dialogToastSuppression'
import { PluginSlot } from '../../plugin/PluginSlot'
import { SavedCalibrationDirectory } from './SavedCalibrationDirectory'

const STATUS_LABELS: Record<CalibrationRun['status'], { label: string; color: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' }> = {
  slicing: { label: 'Slicing', color: 'primary' },
  readyToPrint: { label: 'Ready to print', color: 'primary' },
  printing: { label: 'Printing', color: 'primary' },
  awaitingResult: { label: 'Awaiting result', color: 'warning' },
  saved: { label: 'Saved', color: 'success' },
  failed: { label: 'Failed', color: 'danger' }
}

/** One-line "what happens next" guidance per status, so a run reads as a step-by-step flow. */
const NEXT_STEP: Record<CalibrationRun['status'], string | null> = {
  slicing: 'Preparing your calibration print…',
  readyToPrint: 'Ready. Clear the plate, then print it.',
  printing: 'Printing… measure the result and enter it once it finishes.',
  awaitingResult: 'Measure the print, then enter the result to save it.',
  saved: null,
  failed: null
}

/** Known filament values from earlier runs/results, offered without preventing a new value. */
function buildIdentitySuggestions(
  runs: CalibrationRun[],
  results: CalibrationResult[]
): CalibrationIdentitySuggestions {
  const sources = [...runs, ...results]
  const values = (field: keyof CalibrationIdentitySuggestions) => [...new Set(sources
    .map((source) => source[field]?.trim())
    .filter((value): value is string => Boolean(value)))]
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))

  return {
    brand: values('brand'),
    filamentType: values('filamentType'),
    materialSubtype: sources.flatMap((source) => source.materialSubtype?.trim()
      ? [{ filamentType: source.filamentType, label: source.materialSubtype.trim() }]
      : []),
    colorName: values('colorName')
  }
}

export function CalibrationView() {
  const queryClient = useQueryClient()
  const [showNew, setShowNew] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const [editingResult, setEditingResult] = useState<CalibrationResult | null>(null)
  const closeSavedValueDialog = useCallback(() => setEditingResult(null), [])
  const editingResults = useMemo(() => editingResult ? [editingResult] : [], [editingResult])
  const closeManualDialog = useCallback(() => setShowManual(false), [])
  const [resultRun, setResultRun] = useState<CalibrationRun | null>(null)
  const [readyRun, setReadyRun] = useState<CalibrationRun | null>(null)
  // Stable across the parent's frequent re-renders (printer-status ticks) so the
  // memoized dialogs don't re-render, otherwise a fresh inline `onClose` each
  // render defeats React.memo and thrashes their dropdowns.
  const closeNewDialog = useCallback(() => setShowNew(false), [])
  const closeResultDialog = useCallback(() => setResultRun(null), [])
  const closeReadyRun = useCallback(() => setReadyRun(null), [])

  // Shares the `['printers']` cache key with the rest of the app, which stores the
  // full `{ printers }` response: read `.printers`, never treat data as the array.
  const printersQuery = useQuery<{ printers: Printer[] }>({
    queryKey: ['printers'],
    queryFn: ({ signal }) => apiFetch<{ printers: Printer[] }>('/api/printers', { signal })
  })
  const runsQuery = useQuery({
    queryKey: calibrationKeys.runs,
    queryFn: ({ signal }) => fetchCalibrationRuns(signal),
    // Poll only while a run is still working (the slice queue and print dispatch emit no WS event we
    // subscribe to here). Once a run reaches awaitingResult the interval stops, but the print often
    // finishes while this tab is backgrounded (the user starts it, then goes to watch the printer),
    // which pauses the interval, so refetch on focus too or a returning user sees a stale page with no
    // "Enter result" action until a manual reload.
    refetchInterval: (query) => (query.state.data?.some(isCalibrationRunActive) ? 3000 : false),
    refetchOnWindowFocus: true
  })
  const resultsQuery = useQuery({ queryKey: calibrationKeys.results, queryFn: ({ signal }) => fetchCalibrationResults(signal) })

  const runs = useMemo(() => runsQuery.data ?? [], [runsQuery.data])
  const results = useMemo(() => resultsQuery.data ?? [], [resultsQuery.data])
  const unfinishedRuns = useMemo(() => runs.filter((run) => run.status !== 'saved'), [runs])
  const printers = useMemo(() => printersQuery.data?.printers ?? [], [printersQuery.data])
  const identitySuggestions = useMemo(
    () => buildIdentitySuggestions(runs, results),
    [runs, results]
  )

  // This page shows each run's slice progress inline (status chip + next-step line), so the global
  // slicing toast for a calibration run is redundant: suppress it while its slice is in flight.
  const slicingJobIds = runs.filter((run) => run.status === 'slicing' && run.slicingJobId).map((run) => run.slicingJobId!).join(',')
  useEffect(() => {
    const cleanups = slicingJobIds ? slicingJobIds.split(',').map((jobId) => suppressJobToast('slicing', jobId)) : []
    return () => { for (const cleanup of cleanups) cleanup() }
  }, [slicingJobIds])

  const invalidateRuns = () => queryClient.invalidateQueries({ queryKey: calibrationKeys.runs })

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
    <Stack spacing={pageSectionStackSpacing}>
      <Typography level="h3" startDecorator={<ScienceRoundedIcon />}>Calibration</Typography>

      <Stack spacing={1}>
        <PageSectionHeading
          icon={<ScienceRoundedIcon />}
          title="Runs"
          description="Find the best settings for a material."
          count={unfinishedRuns.length}
          actions={<Button size="sm" startDecorator={<AddRoundedIcon />} onClick={() => setShowNew(true)} disabled={printers.length === 0}>New calibration</Button>}
          actionsInline
        />
        {unfinishedRuns.length === 0 ? (
          <EmptyState
            compact
            icon={<ScienceRoundedIcon />}
            title="No unfinished calibrations"
            description="Start a calibration to print a test."
          />
        ) : (
        <Stack spacing={1}>
          {unfinishedRuns.map((run) => {
            const badge = STATUS_LABELS[run.status]
            const automatic = isAutomaticPressureAdvance(run.parameters)
            const nextStep = automatic && run.status === 'printing'
              ? 'The printer is measuring pressure advance with Micro Lidar.'
              : automatic && run.status === 'awaitingResult'
                ? 'Review the measured value and choose where it applies.'
                : NEXT_STEP[run.status]
            return (
              <Card key={run.id} variant="outlined" orientation="horizontal" sx={{ alignItems: 'center', gap: 1.5 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography level="title-sm">{runTitle(run)}</Typography>
                  <Typography level="body-xs" textColor="text.tertiary">
                    {printerName.get(run.printerId ?? '') ?? 'Printer'} · {run.printerModel} · {run.nozzleDiameter} mm
                    {run.resultValue != null ? ` · ${calibrationValueLabel(run.kind, run.resultValue)}` : ''}
                  </Typography>
                  {run.errorMessage ? <Typography level="body-xs" color="danger">{run.errorMessage}</Typography> : null}
                  {!run.errorMessage && nextStep ? (
                    <Typography level="body-xs" textColor="text.secondary" sx={{ mt: 0.25 }}>{nextStep}</Typography>
                  ) : null}
                </Box>
                <Chip size="sm" variant="soft" color={badge.color}>{badge.label}</Chip>
                {run.status === 'readyToPrint' ? <Button size="sm" onClick={() => setReadyRun(run)}>Print</Button> : null}
                {run.status === 'awaitingResult' ? (
                  <Button
                    size="sm"
                    variant="solid"
                    color="primary"
                    onClick={() => setResultRun(run)}
                  >
                    {automatic ? 'Save result' : 'Enter result'}
                  </Button>
                ) : null}
                <IconButton size="sm" variant="plain" color="danger" aria-label="Delete run" onClick={() => removeRun.mutate(run.id)}><DeleteRoundedIcon /></IconButton>
              </Card>
            )
          })}
        </Stack>
        )}
      </Stack>

      <Stack spacing={1}>
        <PageSectionHeading
          icon={<TuneRoundedIcon />}
          title="Saved values"
          helpText="Applied automatically to matching materials. Values saved for a specific spool take priority."
          actions={<Button size="sm" startDecorator={<AddRoundedIcon />} onClick={() => setShowManual(true)}>Add saved value</Button>}
          actionsInline
          count={results.length}
        />
        <SavedCalibrationDirectory results={results} runs={runs} printers={printers}>
          {(pageResults) => (
          <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
            <Table size="sm" borderAxis="xBetween" hoverRow>
              <thead>
                {/* 64, not 48: the theme gives a row's outer cells a wider gutter than the
                    gaps between columns, and a fixed-layout table would squeeze the
                    action button rather than grow the column. */}
                <tr><th>Test</th><th>Value</th><th>Applies to</th><th>Printer</th><th aria-label="Actions" style={{ width: 64 }} /></tr>
              </thead>
              <tbody>
                {pageResults.map((result) => (
                  <tr key={result.id}>
                    <th scope="row">{calibrationKindLabel(result.kind)}</th>
                    <td>{calibrationValueLabel(result.kind, result.value)}</td>
                    <td>
                      {result.scope === 'spool' ? (
                        <PluginSlot
                          name="calibration.spoolTarget"
                          context={{ spoolId: result.spoolId }}
                          fallback={<Typography level="body-sm">Specific spool</Typography>}
                        />
                      ) : (
                        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap' }}>
                          {[result.brand, result.filamentType, result.materialSubtype, result.colorName]
                            .filter((value): value is string => Boolean(value))
                            .map((value) => <Chip key={value} size="sm" variant="soft">{value}</Chip>)}
                        </Stack>
                      )}
                    </td>
                    <td>{calibrationPrinterTargetLabel(result, printerName)} · {result.nozzleDiameter} mm</td>
                    <td>
                      <Stack direction="row" spacing={0.25} justifyContent="flex-end">
                        {(
                          <IconButton
                            size="sm"
                            variant="plain"
                            color="neutral"
                            aria-label="Edit saved value"
                            onClick={() => setEditingResult(result)}
                          >
                            <EditRoundedIcon />
                          </IconButton>
                        )}
                        <IconButton size="sm" variant="plain" color="danger" aria-label="Delete saved value" onClick={() => removeResult.mutate(result.id)}><DeleteRoundedIcon /></IconButton>
                      </Stack>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Sheet>
          )}
        </SavedCalibrationDirectory>
      </Stack>

      {showNew ? <NewCalibrationDialog printers={printers} onClose={closeNewDialog} /> : null}
      {showManual ? <CalibrationResultDialog printers={printers} identitySuggestions={identitySuggestions} onClose={closeManualDialog} /> : null}
      {editingResult ? <CalibrationResultDialog printers={printers} savedResults={editingResults} identitySuggestions={identitySuggestions} onClose={closeSavedValueDialog} /> : null}
      {readyRun ? <CalibrationSlicePrintModal run={readyRun} onClose={closeReadyRun} /> : null}
      {resultRun ? (
        <CalibrationResultDialog
          run={resultRun}
          printers={printers}
          savedResults={results.filter((result) => result.runId === resultRun.id)}
          identitySuggestions={identitySuggestions}
          onClose={closeResultDialog}
        />
      ) : null}
    </Stack>
  )
}
