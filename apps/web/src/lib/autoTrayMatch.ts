/**
 * Bridges live printer state into the shared print matcher for the dialogs'
 * automatic slot selection (`PrintModal`, `StoragePrintModal`, the print-queue
 * start/edit dialogs). Owns two adaptations the shared matcher can't do itself:
 * enriching each loaded slot with the tracked spool's remaining grams (the
 * filament-manager lookup is a web hook), and shaping project filaments + the
 * per-plate gram usage into matcher requirements.
 *
 * The precedence contract: the matcher's output is a SUGGESTION layered UNDER
 * explicit picks via the shared `mergeAmsMapping` (explicit slots win, `-1`
 * falls back to the computed match) — the same model the API's queue dispatch
 * uses — so a recomputed match can never clobber a user's or caller's choice.
 */
import {
  evaluateQueueMatch,
  loadedSlotsFromStatus,
  trayIndexToAmsSlot,
  type PrinterStatus,
  type QueueLoadedSlot,
  type QueueRequiredFilament,
  type ThreeMfProjectFilament
} from '@printstream/shared'
import type { SlotFilamentIdentityLookup } from './slotFilamentIdentity'

/**
 * Flatten a printer's loaded slots for matching, attaching each tracked spool's
 * remaining grams (which the matcher prefers over the RFID percent estimate).
 */
export function buildAutoMatchSlots(
  printerId: string,
  status: PrinterStatus,
  resolveSlotFilament: SlotFilamentIdentityLookup
): QueueLoadedSlot[] {
  return loadedSlotsFromStatus(status).map((slot) => {
    const ref = trayIndexToAmsSlot(slot.trayIndex)
    const spool = ref ? resolveSlotFilament(printerId, ref.amsId, ref.slotId) : null
    return spool?.remainingGrams != null ? { ...slot, remainingGrams: spool.remainingGrams } : slot
  })
}

/** Shape the dialog's mapping filaments (+ the active plate's gram usage) into matcher requirements. */
export function buildAutoMatchRequirements(
  filaments: readonly ThreeMfProjectFilament[],
  usedGramsById: ReadonlyMap<number, number>
): QueueRequiredFilament[] {
  return filaments.map((filament) => ({
    id: filament.id,
    filamentType: filament.filamentType,
    filamentName: filament.filamentName,
    color: filament.color,
    nozzleId: filament.nozzleId ?? null,
    usedGrams: usedGramsById.get(filament.id) ?? null
  }))
}

/**
 * The automatic mapping suggestion for one printer: exact matches only
 * (type + colour; near matches stay the user's deliberate call), nozzle-aware,
 * refill-aware. Empty when the printer has no status yet.
 */
export function computeAutoTrayMapping(
  printerId: string,
  status: PrinterStatus | undefined,
  filaments: readonly ThreeMfProjectFilament[],
  usedGramsById: ReadonlyMap<number, number>,
  resolveSlotFilament: SlotFilamentIdentityLookup
): number[] {
  if (!status) return []
  return evaluateQueueMatch(
    buildAutoMatchRequirements(filaments, usedGramsById),
    buildAutoMatchSlots(printerId, status, resolveSlotFilament),
    { allowTypeOnlyMatch: false, autoRefillEnabled: status.amsSettings.autoRefill === true }
  ).amsMapping
}

/**
 * Filament ids whose EFFECTIVE selection came from the auto match rather than
 * an explicit pick — i.e. the rows the "auto-selected" marker should flag.
 */
export function autoSelectedFilamentIds(
  filaments: readonly ThreeMfProjectFilament[],
  autoMapping: readonly number[],
  explicitMapping: readonly number[]
): Set<number> {
  const ids = new Set<number>()
  for (const filament of filaments) {
    const index = filament.id - 1
    if ((explicitMapping[index] ?? -1) < 0 && (autoMapping[index] ?? -1) >= 0) ids.add(filament.id)
  }
  return ids
}
