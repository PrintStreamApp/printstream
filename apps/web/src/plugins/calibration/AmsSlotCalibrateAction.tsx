/**
 * Fills `printer.amsSlot.calibration` with the PrintStream alternative to printer profiles.
 * Works for any filament (the primary case is custom, non-Bambu
 * spools that ship without a tuned pressure advance). Launches the PA tower wizard for the slot.
 */
import { Button } from '@mui/joy'
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded'
import { DialogSection } from '../../components/DialogSection'
import { openSlotCalibration } from './slotCalibrationStore'

export function AmsSlotCalibrateAction(props: Record<string, unknown>) {
  const printerId = typeof props.printerId === 'string' ? props.printerId : null
  const amsId = typeof props.amsId === 'number' ? props.amsId : null
  const slotId = typeof props.slotId === 'number' ? props.slotId : null
  if (printerId == null || amsId == null || slotId == null) return null
  const filamentType = typeof props.filamentType === 'string' ? props.filamentType : null
  const label = typeof props.label === 'string' ? props.label : undefined

  return (
    <DialogSection
      title="PrintStream (recommended)"
      description={
        <>
          Store a calibrated K value in PrintStream for a particular spool, or for a combination of
          brand/type/product line/color of material, and have it automatically applied when slicing
          (written into G-code). Look for the{' '}
          <ScienceRoundedIcon titleAccess="Calibration" fontSize="inherit" />{' '}
          icon when slicing with a matching spool or material.
        </>
      }
    >
      <Button
        size="sm"
        variant="soft"
        color="primary"
        startDecorator={<ScienceRoundedIcon />}
        fullWidth
        onClick={() => openSlotCalibration({ printerId, amsId, slotId, filamentType, label })}
      >
        Calibrate with PrintStream…
      </Button>
    </DialogSection>
  )
}
