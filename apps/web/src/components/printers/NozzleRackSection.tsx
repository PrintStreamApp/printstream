/**
 * Nozzle-changer (rack) status and safe maintenance controls: the body of the
 * printer controls dialog's Nozzles tab.
 *
 * The H2C has a static left nozzle and a swappable right-side nozzle system: a
 * rack of spare hotends the printer swaps automatically during prints. Bambu
 * exposes no manual "load nozzle N" command. It does expose rack positioning,
 * homing, and hotend re-read commands for physical maintenance.
 *
 * Rendered only when `status.nozzleRack` is present (H2C only); the tab is
 * hidden otherwise.
 */
import { Box, Button, ButtonGroup, Chip, Sheet, Stack, Typography } from '@mui/joy'
import SwapVertRoundedIcon from '@mui/icons-material/SwapVertRounded'
import { getNozzleRackControlAvailability, type NozzleRackSlot, type PrinterStatus } from '@printstream/shared'
import { DialogSection } from '../DialogSection'
import { formatNozzleRackStatus, formatNozzleSlotHardware, summarizeNozzleRack } from '../../lib/nozzleRackHelpers'
import { usePromptDialog } from '../PromptDialogProvider'
import type { PrinterControlCommand } from '../../lib/printersViewHelpers'

function NozzleRow({ slot }: { slot: NozzleRackSlot }) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
      <Box
        aria-hidden
        sx={{
          width: 12,
          height: 12,
          borderRadius: '50%',
          flexShrink: 0,
          border: '1px solid',
          borderColor: 'neutral.outlinedBorder',
          backgroundColor: slot.loadedFilamentColor ?? 'transparent'
        }}
      />
      <Typography level="body-sm" sx={{ minWidth: 0 }} noWrap>
        {formatNozzleSlotHardware(slot)}
      </Typography>
      {slot.wear != null ? (
        <Typography level="body-xs" textColor="text.tertiary">
          wear {slot.wear}
        </Typography>
      ) : null}
    </Stack>
  )
}

export function NozzleRackSection({
  status,
  submitting,
  onSubmit
}: {
  status: PrinterStatus
  submitting: boolean
  onSubmit: (command: PrinterControlCommand) => void
}) {
  const { confirm } = usePromptDialog()
  const rack = status.nozzleRack
  if (!rack) return null

  const summary = summarizeNozzleRack(rack)
  const availability = getNozzleRackControlAvailability(status)
  const controlsDisabled = submitting || !availability.allowed

  const requestMotion = async (action: 'home' | 'raiseA' | 'raiseB') => {
    const accepted = await confirm({
      title: 'Move the nozzle rack?',
      description: 'The toolhead and hotend rack may move. Keep your hands away from the chamber.',
      confirmLabel: 'Move rack',
      color: 'warning'
    })
    if (accepted) onSubmit({ type: 'controlNozzleRack', action })
  }

  return (
    <DialogSection title="Nozzle changer" wrapInSheet={false}>
      <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
        <Stack spacing={1.25}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
            <Chip
              size="sm"
              variant="soft"
              color={summary.changing ? 'primary' : 'neutral'}
              startDecorator={<SwapVertRoundedIcon fontSize="inherit" />}
            >
              {formatNozzleRackStatus(rack.status)}
            </Chip>
            <Typography level="body-xs" textColor="text.tertiary">
              {summary.mounted.length} mounted · {summary.spares.length} in rack
            </Typography>
          </Stack>

          {summary.mounted.length > 0 ? (
            <Box>
              <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 0.5 }}>
                Mounted
              </Typography>
              <Stack spacing={0.75}>
                {summary.mounted.map((slot) => (
                  <NozzleRow key={`mounted-${slot.nozzleId}`} slot={slot} />
                ))}
              </Stack>
            </Box>
          ) : null}

          {summary.spares.length > 0 ? (
            <Box>
              <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 0.5 }}>
                In rack
              </Typography>
              <Stack spacing={0.75}>
                {summary.spares.map((slot) => (
                  <NozzleRow key={`rack-${slot.nozzleId}`} slot={slot} />
                ))}
              </Stack>
            </Box>
          ) : null}

          <Stack spacing={0.75}>
            <Typography level="body-xs" textColor="text.tertiary">Rack maintenance</Typography>
            <ButtonGroup size="sm" variant="outlined" color="neutral" sx={{ alignSelf: 'flex-start', flexWrap: 'wrap' }}>
              <Button disabled={controlsDisabled} onClick={() => void requestMotion('raiseA')}>Raise row A</Button>
              <Button disabled={controlsDisabled} onClick={() => void requestMotion('raiseB')}>Raise row B</Button>
              <Button disabled={controlsDisabled} onClick={() => void requestMotion('home')}>Home</Button>
            </ButtonGroup>
            <Button
              size="sm"
              variant="soft"
              color="neutral"
              disabled={controlsDisabled}
              onClick={() => onSubmit({ type: 'controlNozzleRack', action: 'refreshAll' })}
              sx={{ alignSelf: 'flex-start' }}
            >
              Re-read hotends
            </Button>
            {!availability.allowed && (
              <Typography level="body-xs" textColor="text.tertiary">{availability.reason}</Typography>
            )}
          </Stack>
        </Stack>
      </Sheet>
    </DialogSection>
  )
}
