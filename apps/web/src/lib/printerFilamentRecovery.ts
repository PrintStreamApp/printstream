/**
 * Builds the list of filament sources offered for recovery when a print is paused on a filament
 * runout: every AMS slot and external spool that can currently be loaded, with the load command
 * to run. Pure (no React) — extracted from PrinterCard so the card's body stays render-focused.
 */
import {
  getAmsLoadFilamentAvailability,
  getExternalSpoolLoadAvailability,
  isPausedFilamentRunout,
  type AmsUnit,
  type ExternalSpool,
  type PrinterStatus
} from '@printstream/shared'
import { amsUnitLetter } from './printerTrayMapping'
import { externalSpoolLabel, formatFilamentRecoverySourceDetail, resolveFilamentChangeTargetTemp } from './printersViewHelpers'
import type { PrinterRecoveryFilamentSource } from './printerViewTypes'

export function computeFilamentRecoverySources(
  status: PrinterStatus | undefined,
  amsUnits: AmsUnit[],
  externalSpools: ExternalSpool[]
): PrinterRecoveryFilamentSource[] {
  if (!isPausedFilamentRunout(status)) return []

  const sources: PrinterRecoveryFilamentSource[] = []

  amsUnits.forEach((unit) => {
    unit.slots.forEach((slot) => {
      const availability = getAmsLoadFilamentAvailability(status, unit.unitId, slot.slot)
      if (!availability.allowed) return

      sources.push({
        key: `ams-${unit.unitId}-${slot.slot}`,
        label: `AMS ${amsUnitLetter(unit.unitId)}${slot.slot + 1}`,
        detail: formatFilamentRecoverySourceDetail(slot),
        command: {
          type: 'loadAmsFilament',
          amsId: unit.unitId,
          slotId: slot.slot,
          extruderId: unit.nozzleId ?? undefined,
          nozzleTemp: resolveFilamentChangeTargetTemp(slot) ?? 220
        }
      })
    })
  })

  externalSpools.forEach((spool) => {
    const availability = getExternalSpoolLoadAvailability(status, spool.amsId)
    if (!availability.allowed) return

    sources.push({
      key: `external-${spool.amsId}`,
      label: externalSpoolLabel(spool.amsId, externalSpools.length),
      detail: formatFilamentRecoverySourceDetail(spool),
      command: {
        type: 'loadExternalSpool',
        amsId: spool.amsId,
        extruderId: spool.nozzleId ?? undefined,
        nozzleTemp: resolveFilamentChangeTargetTemp(spool) ?? 220
      }
    })
  })

  return sources
}
