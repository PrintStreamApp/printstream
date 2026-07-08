/**
 * Calibration plugin (web side).
 *
 * Adds a top-level "Calibration" tab: start pressure-advance and flow-ratio
 * calibration prints, follow each run through slicing → printing → result entry,
 * and manage the saved values that are reused on matching filament. The heavy
 * work (geometry, slicing, dispatch) is all server-side; this surface is light,
 * so it eager-loads with the app shell like the other core tabs.
 */
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded'
import type { WebPlugin } from '../../plugin/types'
import { CalibrationView } from './CalibrationView'
import { AmsSlotCalibrateMenuItem } from './AmsSlotCalibrateMenuItem'
import { AmsSlotCalibrateAction } from './AmsSlotCalibrateAction'
import { SlotCalibrationHost } from './SlotCalibrationHost'

export const calibrationPlugin: WebPlugin = {
  name: 'calibration',
  version: '0.1.0',
  description: 'Print pressure-advance and flow-ratio calibration tests, then save the result for reuse on matching filament.',
  routes: [
    {
      path: '/calibration/*',
      navLabel: 'Calibration',
      navMobileIcon: <ScienceRoundedIcon />,
      element: CalibrationView
    }
  ],
  slots: [
    // "Calibrate filament…" in an AMS slot's context menu, and the calibrate action inside the
    // slot's pressure-advance dialog. Both launch the PA tower wizard for that slot's filament.
    { name: 'printer.amsSlot.menuItems', component: AmsSlotCalibrateMenuItem },
    { name: 'printer.amsSlot.calibration', component: AmsSlotCalibrateAction },
    // Always-mounted host that renders the wizard the two launch points request.
    { name: 'shell.overlays', component: SlotCalibrationHost }
  ]
}
