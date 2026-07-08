/**
 * Presentation helpers for the H2C nozzle-changer (rack) surfaces: the printer
 * card chip and the controls-dialog section. Pure formatting only — the rack
 * data comes from `PrinterStatus.nozzleRack` (see the shared contract), which is
 * `null` on every non-H2C machine, so callers must null-check first.
 */
import { formatNozzleDiameterLabel, type NozzleRack, type NozzleRackSlot, type NozzleRackStatus } from '@printstream/shared'
import { formatNozzleFlow, formatNozzleMaterial } from './printersViewHelpers'

/** `0.4 mm · Hardened steel · High flow` for one hotend, best-effort from what the printer reports. */
export function formatNozzleSlotHardware(slot: NozzleRackSlot): string {
  const parts: string[] = []
  const diameter = formatNozzleDiameterLabel(slot.diameter)
  if (diameter) parts.push(diameter)
  const material = formatNozzleMaterial(slot.material)
  if (material) parts.push(material)
  const flow = formatNozzleFlow(slot.flow)
  if (flow) parts.push(flow)
  if (parts.length === 0 && slot.typeCode) parts.push(slot.typeCode)
  return parts.length > 0 ? parts.join(' · ') : 'Nozzle'
}

const NOZZLE_RACK_STATUS_LABELS: Record<NozzleRackStatus, string> = {
  idle: 'Idle',
  hotendCentre: 'Positioning hotend',
  toolheadCentre: 'Positioning toolhead',
  calibrateHotendRack: 'Calibrating rack',
  cutMaterial: 'Cutting filament',
  unlockHotend: 'Unlocking hotend',
  liftHotendRack: 'Lifting rack',
  placeHotend: 'Placing hotend',
  pickHotend: 'Picking hotend',
  lockHotend: 'Locking hotend',
  unknown: 'Unknown'
}

/** Human label for the rack motion state. */
export function formatNozzleRackStatus(status: NozzleRackStatus): string {
  return NOZZLE_RACK_STATUS_LABELS[status] ?? 'Unknown'
}

/** A nozzle change is underway whenever the rack is doing anything other than sitting idle. */
export function isNozzleRackChanging(rack: NozzleRack): boolean {
  return rack.status !== 'idle' && rack.status !== 'unknown'
}

export interface NozzleRackSummary {
  /** Hotends currently mounted on a toolhead. */
  mounted: NozzleRackSlot[]
  /** Spare hotends parked in the rack. */
  spares: NozzleRackSlot[]
  /** True while the changer is mid-swap. */
  changing: boolean
  /** Compact label for the card chip, e.g. `3 in rack` or `Changing nozzle`. */
  chipLabel: string
}

/** Split a rack into mounted vs parked hotends and build the card-chip label. */
export function summarizeNozzleRack(rack: NozzleRack): NozzleRackSummary {
  const mounted = rack.nozzles.filter((slot) => !slot.onRack)
  const spares = rack.nozzles.filter((slot) => slot.onRack)
  const changing = isNozzleRackChanging(rack)
  const chipLabel = changing
    ? 'Changing nozzle'
    : `${spares.length} in rack`
  return { mounted, spares, changing, chipLabel }
}
