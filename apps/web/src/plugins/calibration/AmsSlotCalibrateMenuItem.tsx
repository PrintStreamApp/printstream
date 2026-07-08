/**
 * Fills the core `printer.amsSlot.menuItems` slot: a "Calibrate filament…" entry in an AMS slot's
 * context menu. Reads the slot context defensively and launches the pressure-advance wizard for
 * that slot via the store (the menu unmounts on click, so the wizard is hosted elsewhere).
 */
import { MenuItem } from '@mui/joy'
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded'
import { openSlotCalibration } from './slotCalibrationStore'

export function AmsSlotCalibrateMenuItem(props: Record<string, unknown>) {
  const printerId = typeof props.printerId === 'string' ? props.printerId : null
  const amsId = typeof props.amsId === 'number' ? props.amsId : null
  const slotId = typeof props.slotId === 'number' ? props.slotId : null
  if (printerId == null || amsId == null || slotId == null) return null
  const filamentType = typeof props.filamentType === 'string' ? props.filamentType : null
  const label = typeof props.label === 'string' ? props.label : undefined
  const onSelected = typeof props.onSelected === 'function' ? (props.onSelected as () => void) : undefined
  const disabled = Boolean(props.disabled)

  return (
    <MenuItem
      disabled={disabled}
      onClick={() => {
        onSelected?.()
        openSlotCalibration({ printerId, amsId, slotId, filamentType, label })
      }}
    >
      <ScienceRoundedIcon /> Calibrate filament…
    </MenuItem>
  )
}
