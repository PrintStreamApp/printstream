/**
 * Fills the core `printer.amsSlot.calibration` slot in the AMS slot's pressure-advance dialog: a
 * "Calibrate this filament…" button. Works for any filament (the primary case is custom, non-Bambu
 * spools that ship without a tuned pressure advance). Launches the PA tower wizard for the slot.
 */
import { Button, Stack, Typography } from '@mui/joy'
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded'
import { openSlotCalibration } from './slotCalibrationStore'

export function AmsSlotCalibrateAction(props: Record<string, unknown>) {
  const printerId = typeof props.printerId === 'string' ? props.printerId : null
  const amsId = typeof props.amsId === 'number' ? props.amsId : null
  const slotId = typeof props.slotId === 'number' ? props.slotId : null
  if (printerId == null || amsId == null || slotId == null) return null
  const filamentType = typeof props.filamentType === 'string' ? props.filamentType : null
  const label = typeof props.label === 'string' ? props.label : undefined

  return (
    <Stack spacing={1}>
      <Typography level="body-sm" textColor="text.tertiary">
        Print a pressure-advance tower to find the right value for this filament, then save it for reuse.
      </Typography>
      <Button
        size="sm"
        variant="soft"
        color="primary"
        startDecorator={<ScienceRoundedIcon />}
        sx={{ alignSelf: 'flex-start' }}
        onClick={() => openSlotCalibration({ printerId, amsId, slotId, filamentType, label })}
      >
        Calibrate this filament…
      </Button>
    </Stack>
  )
}
