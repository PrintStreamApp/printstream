/**
 * Always-mounted host (rendered into the app-level `shell.overlays` slot) that shows the
 * pressure-advance calibration wizard for whichever AMS slot the store points at. Keeping the
 * wizard here — rather than in the menu item or dialog button that requested it — means it
 * survives those surfaces unmounting (the slot menu closes on click).
 */
import { useQuery } from '@tanstack/react-query'
import type { Printer } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { NewCalibrationDialog } from './NewCalibrationDialog'
import { closeSlotCalibration, useSlotCalibrationTarget } from './slotCalibrationStore'

export function SlotCalibrationHost() {
  const target = useSlotCalibrationTarget()
  const printersQuery = useQuery<{ printers: Printer[] }>({
    queryKey: ['printers'],
    queryFn: ({ signal }) => apiFetch<{ printers: Printer[] }>('/api/printers', { signal }),
    enabled: target != null
  })
  if (!target) return null
  return (
    <NewCalibrationDialog
      printers={printersQuery.data?.printers ?? []}
      lockedTarget={target}
      lockedTest="pressureAdvance"
      onClose={closeSlotCalibration}
    />
  )
}
