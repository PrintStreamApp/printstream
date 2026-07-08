/**
 * Slot contribution for the core `printer.amsSlot.filamentIdentity` extension point (AMS slot and
 * external-spool tooltips). When the filament-manager has a spool recorded as loaded into the slot,
 * this renders that spool's real identity (e.g. "Michael's PLA") in place of the printer's generic
 * preset/type label — so custom filament reads as itself rather than the Bambu slicing preset it was
 * assigned. When no spool is linked to the slot, it renders the core fallback unchanged.
 *
 * The spool is matched by loaded LOCATION (printer + AMS + slot), which the plugin sets for both
 * RFID auto-detected spools and manual "Pick from library" assignments — so it works for non-RFID
 * custom filament, which is exactly the case that needs it.
 */
import { Typography } from '@mui/joy'
import type { ReactNode } from 'react'
import { brandFromPresetName } from '../../data/bambuFilamentPresets'
import { useSpoolsQuery } from './api'
import { findLoadedSpoolForSlot, spoolIdentityLabel } from './filters'

interface AmsSlotFilamentIdentityProps {
  printerId?: string
  amsId?: number
  slotId?: number | null
  fallback?: ReactNode
}

export function AmsSlotFilamentIdentity({ printerId, amsId, slotId, fallback = null }: AmsSlotFilamentIdentityProps) {
  const spoolsQuery = useSpoolsQuery()
  const spool = findLoadedSpoolForSlot(spoolsQuery.data, { printerId, amsId, slotId })
  // Only override the core label for a non-Bambu (custom/third-party) spool. Genuine Bambu filament
  // is already named accurately — and more specifically ("Bambu PLA Basic") — by the printer's own
  // RFID preset label that core shows, so we leave it alone; the tracked spool record is coarser.
  if (!spool || brandFromPresetName(spool.brand ?? '') === 'Bambu') return <>{fallback}</>
  return <Typography level="body-sm">{spoolIdentityLabel(spool)}</Typography>
}
