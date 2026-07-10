/**
 * Result entry + save for a printed calibration run. The user reports the
 * measurement (best band height for a tower, smoothest patch for a flow plate),
 * sees the computed value, then chooses how widely to save it: to this spool, or
 * to a filament identity (toggle which fields must match), and — for pressure
 * advance — optionally straight to the printer's own K profile.
 *
 * One button does everything: it always submits the CURRENT form measurement and
 * then saves, so the previewed value and the saved value can never diverge. (A
 * two-step Record-then-Save flow shipped first and burned a user: a reopened
 * dialog reset its inputs but "Save" persisted the server's earlier measurement,
 * saving a different K than the preview showed.) Reopening a measured run seeds
 * the inputs from the recorded measurement for the same reason.
 */
import { memo, useMemo, useState } from 'react'
import { Alert, Button, Checkbox, FormControl, FormLabel, IconButton, Modal, ModalClose, Option, Radio, RadioGroup, Select, Stack, Tooltip, Typography } from '@mui/joy'
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  flowRatioFromOffset,
  pressureAdvanceFromHeight,
  type CalibrationRun,
  type SaveCalibrationResult
} from '@printstream/shared'
import { toast } from '../../lib/toast'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { DialogSection } from '../../components/DialogSection'
import { NumberField } from './NumberField'
import { calibrationKeys, saveCalibrationRun, submitCalibrationMeasurement } from './api'

export const CalibrationResultDialog = memo(function CalibrationResultDialog({ run, onClose }: { run: CalibrationRun; onClose: () => void }) {
  const queryClient = useQueryClient()
  const isFlow = run.parameters.kind === 'flowRatio'

  const [heightMm, setHeightMm] = useState(() => (run.measurement?.kind === 'pressureAdvance' ? run.measurement.bestHeightMm : 0))
  const [offset, setOffset] = useState<number>(() => {
    if (run.measurement?.kind === 'flowRatio') return run.measurement.selectedOffset
    return run.parameters.kind === 'flowRatio' ? (run.parameters.offsets[0] ?? 0) : 0
  })
  const [scope, setScope] = useState<'spool' | 'identity'>(run.spoolId ? 'spool' : 'identity')
  const [match, setMatch] = useState({ brand: true, filamentType: true, materialSubtype: true, colorName: false })

  const computedValue = useMemo(() => {
    if (run.parameters.kind === 'flowRatio') return flowRatioFromOffset(run.parameters.currentFlowRatio, offset)
    return pressureAdvanceFromHeight(run.parameters.startK, run.parameters.step, heightMm)
  }, [run.parameters, offset, heightMm])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: calibrationKeys.runs })

  const save = useMutation({
    mutationFn: async () => {
      // Always submit the measurement currently on screen before saving — never trust a
      // previously recorded one — so the previewed value is the one that gets saved.
      await submitCalibrationMeasurement(run.id, {
        measurement: run.parameters.kind === 'flowRatio'
          ? { kind: 'flowRatio', selectedOffset: offset }
          : { kind: 'pressureAdvance', bestHeightMm: heightMm }
      })
      const body: SaveCalibrationResult = { scope, applyToPrinter: !isFlow && applyToPrinter, ...(scope === 'identity' ? { match } : {}) }
      return saveCalibrationRun(run.id, body)
    },
    onSuccess: () => {
      void invalidate()
      void queryClient.invalidateQueries({ queryKey: calibrationKeys.results })
      toast.success('Calibration saved')
      onClose()
    }
    // Errors surface once via the global mutation error handler (main.tsx) — no local onError toast.
  })

  const [applyToPrinter, setApplyToPrinter] = useState(!isFlow)

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog aria-labelledby="calibration-result-title" sx={{ maxWidth: 520 }}>
        <Typography id="calibration-result-title" level="h4">Enter calibration result</Typography>
        <ModalClose />
        <ScrollableDialogBody>
          <Stack spacing={2}>
            <DialogSection title="Measurement" description={isFlow ? 'Pick the patch whose top surface felt smoothest.' : 'Measure the height of the best-looking band with calipers.'}>
              {run.parameters.kind === 'flowRatio' ? (
                <FormControl>
                  <FormLabel>Best patch</FormLabel>
                  <Select value={offset} onChange={(_event, value) => value != null && setOffset(value)}>
                    {run.parameters.offsets.map((option) => (
                      <Option key={option} value={option}>
                        {`${option > 0 ? '+' : ''}${option}% → flow ${flowRatioFromOffset((run.parameters as { currentFlowRatio: number }).currentFlowRatio, option).toFixed(3)}`}
                      </Option>
                    ))}
                  </Select>
                </FormControl>
              ) : (
                <NumberField label="Best band height" value={heightMm} min={0} step={1} endDecorator="mm" onChange={setHeightMm} />
              )}
              <Alert color="primary" size="sm" sx={{ mt: 1 }}>
                {isFlow ? `New flow ratio: ${computedValue.toFixed(3)}` : `Pressure advance K: ${computedValue.toFixed(4)}`}
              </Alert>
            </DialogSection>

            <DialogSection title="Save for" description="Reused automatically the next time this filament is loaded on a printer of the same model.">
              {/* Only offer the scope radios when there is a real choice — a run tied to a spool can save
                  just for that spool or for any matching filament. Without a spool the only option is
                  matching filament, so a one-option radio group would just be noise: show the match
                  fields directly instead. */}
              {run.spoolId ? (
                <RadioGroup value={scope} onChange={(event) => setScope(event.target.value as 'spool' | 'identity')}>
                  <Stack spacing={1}>
                    <Radio value="spool" label="This spool only" />
                    <Radio value="identity" label="All matching filament" />
                  </Stack>
                </RadioGroup>
              ) : null}
              {scope === 'identity' ? (
                <Stack spacing={1} sx={{ mt: run.spoolId ? 1 : 0 }}>
                  <FormLabel>{run.spoolId ? 'Match on' : 'Save for any filament matching'}</FormLabel>
                  <Stack direction="row" spacing={2} flexWrap="wrap">
                    <Checkbox size="sm" label={`Brand${run.brand ? ` (${run.brand})` : ''}`} checked={match.brand} onChange={(event) => setMatch((prev) => ({ ...prev, brand: event.target.checked }))} />
                    <Checkbox size="sm" label={`Type${run.filamentType ? ` (${run.filamentType})` : ''}`} checked={match.filamentType} onChange={(event) => setMatch((prev) => ({ ...prev, filamentType: event.target.checked }))} />
                    <Checkbox size="sm" label={`Subtype${run.materialSubtype ? ` (${run.materialSubtype})` : ''}`} checked={match.materialSubtype} onChange={(event) => setMatch((prev) => ({ ...prev, materialSubtype: event.target.checked }))} />
                    <Checkbox size="sm" label={`Colour${run.colorName ? ` (${run.colorName})` : ''}`} checked={match.colorName} onChange={(event) => setMatch((prev) => ({ ...prev, colorName: event.target.checked }))} />
                  </Stack>
                </Stack>
              ) : null}
              {/* The printer-side K push targets a specific AMS slot, so it can only act when the run
                  carries one; hide it otherwise rather than showing a checkbox that silently no-ops. */}
              {!isFlow && run.amsId != null && run.slotId != null ? (
                <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 1 }}>
                  <Checkbox size="sm" label="Also save to the printer's own K profile" checked={applyToPrinter} onChange={(event) => setApplyToPrinter(event.target.checked)} />
                  <Tooltip
                    variant="soft"
                    placement="top"
                    sx={{ maxWidth: 280 }}
                    title="Writes this K value into a pressure-advance profile on the printer itself and selects it, so it is applied even for prints you start outside PrintStream (from the printer, Bambu Studio, or Handy). Leave it off to keep the value in PrintStream only — it is still applied automatically whenever PrintStream starts a print with this filament."
                  >
                    <IconButton size="sm" variant="plain" color="neutral" aria-label="What does saving to the printer's own K profile do?">
                      <HelpOutlineRoundedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              ) : null}
            </DialogSection>
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" color="neutral" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>Save result</Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
})
