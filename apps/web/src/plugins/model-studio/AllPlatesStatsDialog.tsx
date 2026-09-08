/**
 * "Statistics of all plates": what a whole project costs, not just the plate on screen (#92).
 *
 * BambuStudio's window of the same name. Two tables: filament aggregated ACROSS every plate (so a
 * material used on three plates is one row), and a per-plate time/weight breakdown.
 *
 * It needs no new data. `PreviewView` already holds every plate's stats, because `/plates` returns
 * the whole 3MF index in one response; the per-plate panel simply only ever looked at one of them.
 *
 * Two honest limits, both stated in the UI rather than papered over:
 * - **A plate that was never sliced has no numbers.** `prediction`/`weight`/`usedGrams` come from
 *   `slice_info.config`, which only a sliced plate carries, so those plates are counted and named
 *   but contribute nothing to the totals.
 * - **Cost has no currency.** BambuStudio's `filament_cost` is "money/kg" with no unit stored
 *   anywhere in the 3MF or in Studio itself. The column is omitted entirely when the project
 *   priced nothing, rather than showing a confident 0.00.
 *
 * Counterpart: `GcodeToolpathPanel.tsx` (the per-plate panel this expands on).
 */
import { useMemo } from 'react'
import { Box, Button, DialogActions, Sheet, Stack, Table, Typography } from '@mui/joy'
import type { ThreeMfIndex } from '@printstream/shared'
import { BackAwareModal } from '../../components/BackAwareModal'
import { DialogSection } from '../../components/DialogSection'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { formatSecondsDuration } from '../../lib/time'
import { aggregatePlateFilaments, platePrintedGrams, summarizeAllPlates } from './lib/allPlatesStats'
import { plateDisplayName } from './lib/plateName'
import { formatFilamentCost } from '../../lib/filamentCost'

export interface AllPlatesStatsDialogProps {
  open: boolean
  onClose: () => void
  plates: ThreeMfIndex['plates']
  projectFilaments: ThreeMfIndex['projectFilaments']
}

export function AllPlatesStatsDialog({ open, onClose, plates, projectFilaments }: AllPlatesStatsDialogProps) {
  // Skip the aggregation while closed, but keep the modal MOUNTED. This dialog is a permanent
  // sibling of the preview modal, so it re-renders on every layer-slider drag frame and must not
  // re-walk every plate's filament list each time. It used to `return null` instead, which
  // unmounted `BackAwareModal` while it was still `open`: only `syncClosedDialog` spends the
  // dialog's pushed history entry, and an unmount never reaches it, so the entry was left on the
  // stack and the next browser Back did nothing (see apps/web/the development notes).
  const summary = useMemo(
    () => {
      if (!open) return null
      const filaments = aggregatePlateFilaments(plates, projectFilaments)
      return { filaments, totals: summarizeAllPlates(plates, filaments) }
    },
    [open, plates, projectFilaments]
  )
  const filaments = summary?.filaments ?? []
  const totals = summary?.totals
  const totalGrams = totals?.grams ?? 0
  const totalPlateGrams = totals?.plateGrams ?? 0
  const totalMeters = totals?.meters ?? 0
  const totalSeconds = totals?.seconds ?? 0
  const unslicedPlates = totals?.unslicedPlates ?? 0
  const showsCost = totals?.cost != null
  const totalCost = totals?.cost ?? 0

  return (
    <BackAwareModal open={open} onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 720, width: '100%' }}>
        <Typography level="title-lg">Statistics of all plates</Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, px: 0 }}>
          <Stack spacing={2}>
            <DialogSection title="Material">
              <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
                <Table size="sm" borderAxis="xBetween" hoverRow>
                  <thead>
                    <tr>
                      <th>Filament</th>
                      <th style={{ width: '6rem', textAlign: 'right' }}>Weight</th>
                      <th style={{ width: '6rem', textAlign: 'right' }}>Length</th>
                      {showsCost && <th style={{ width: '6rem', textAlign: 'right' }}>Cost</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {filaments.map((filament) => (
                      <tr key={filament.id}>
                        <th scope="row" style={{ fontWeight: 'inherit' }}>
                          <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                            <Box
                              sx={{
                                width: 14,
                                height: 14,
                                borderRadius: '3px',
                                flexShrink: 0,
                                bgcolor: filament.color || 'neutral.softBg',
                                border: '1px solid rgba(255,255,255,0.18)'
                              }}
                            />
                            <Typography level="body-sm" noWrap>{filament.label}</Typography>
                          </Stack>
                        </th>
                        <td style={{ textAlign: 'right' }}>{filament.grams.toFixed(1)} g</td>
                        <td style={{ textAlign: 'right' }}>{filament.meters.toFixed(2)} m</td>
                        {showsCost && (
                          <td style={{ textAlign: 'right' }}>
                            {filament.cost != null ? formatFilamentCost(filament.cost) : '-'}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Total</th>
                      <td style={{ textAlign: 'right' }}>{totalGrams.toFixed(1)} g</td>
                      <td style={{ textAlign: 'right' }}>{totalMeters.toFixed(2)} m</td>
                      {showsCost && <td style={{ textAlign: 'right' }}>{formatFilamentCost(totalCost)}</td>}
                    </tr>
                  </tfoot>
                </Table>
              </Sheet>
              {showsCost && (
                <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.75 }}>
                  Cost uses the price per kilogram saved in the project, which records no currency.
                </Typography>
              )}
            </DialogSection>

            <DialogSection title="Plates">
              <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
                <Table size="sm" borderAxis="xBetween" hoverRow>
                  <thead>
                    <tr>
                      <th>Plate</th>
                      <th style={{ width: '7rem', textAlign: 'right' }}>Time</th>
                      <th style={{ width: '6rem', textAlign: 'right' }}>Weight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plates.map((plate) => {
                      const grams = platePrintedGrams(plate)
                      return (
                        <tr key={plate.index}>
                          <th scope="row" style={{ fontWeight: 'inherit' }}>
                            <Typography level="body-sm" noWrap>
                              {plateDisplayName(plate.name, plate.index)}
                            </Typography>
                          </th>
                          <td style={{ textAlign: 'right' }}>
                            {plate.prediction != null ? formatSecondsDuration(Math.round(plate.prediction)) : 'Not sliced'}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {grams != null ? `${grams.toFixed(1)} g` : '-'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Total</th>
                      <td style={{ textAlign: 'right' }}>{formatSecondsDuration(Math.round(totalSeconds))}</td>
                      {/* The sum of THIS column, not the filament table's: the two read different
                          slice_info fields and a plate can record either one alone. */}
                      <td style={{ textAlign: 'right' }}>{totalPlateGrams.toFixed(1)} g</td>
                    </tr>
                  </tfoot>
                </Table>
              </Sheet>
              {unslicedPlates > 0 && (
                <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.75 }}>
                  {unslicedPlates === 1 ? 'One plate has' : `${unslicedPlates} plates have`} not been sliced, so
                  {unslicedPlates === 1 ? ' it contributes' : ' they contribute'} nothing to these totals.
                </Typography>
              )}
            </DialogSection>
          </Stack>
        </ScrollableDialogBody>
        <DialogActions>
          <Button onClick={onClose}>Done</Button>
        </DialogActions>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}
