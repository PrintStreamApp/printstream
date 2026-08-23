/**
 * Bridges live printer state into the shared low-filament rule for the print dialogs'
 * "a slot you picked will run out" confirmation (`components/LowFilamentAlert`).
 *
 * Sibling of `autoTrayMatch.ts` and built on its adapters on purpose: the slots the matcher
 * graded when it SUGGESTED a mapping must be the same slots, with the same tracked-spool
 * grams attached, that the warning grades once the user has finished editing it. Otherwise
 * the matcher can pick a slot it believes holds enough and the dialog then flag it.
 *
 * The rule itself is `@printstream/shared`'s `findLowFilamentSlots`, which the API's dispatch
 * guard also runs, this module only owns the web's tray shapes and labels.
 */
import {
  findLowFilamentSlots,
  type LowFilamentSlot,
  type PrinterStatus,
  type ThreeMfProjectFilament
} from '@printstream/shared'
import { buildAutoMatchRequirements, buildAutoMatchSlots } from './autoTrayMatch'
import { buildPrinterTrayGroups } from './libraryViewHelpers'
import type { SlotFilamentIdentityLookup } from './slotFilamentIdentity'

/**
 * The mapped slots that will run out on this printer, worst shortfall first. Empty when the
 * printer has no status, nothing is mapped, or no mapped slot can be measured: most spools
 * report nothing usable, so an empty result means "nothing to warn about", not "checked and fine".
 */
export function findPrinterLowFilamentSlots(
  printerId: string,
  status: PrinterStatus | undefined,
  filaments: readonly ThreeMfProjectFilament[],
  usedGramsById: ReadonlyMap<number, number>,
  amsMapping: number[] | undefined,
  resolveSlotFilament: SlotFilamentIdentityLookup
): LowFilamentSlot[] {
  if (!status) return []
  return findLowFilamentSlots({
    required: buildAutoMatchRequirements(filaments, usedGramsById),
    slots: buildAutoMatchSlots(printerId, status, resolveSlotFilament),
    amsMapping,
    autoRefillEnabled: status.amsSettings.autoRefill === true
  })
}

/**
 * How the print dialogs name the slot behind a tray index ("AMS A Slot 2"). Falls back to the
 * bare index rather than inventing a name for a slot the status no longer reports.
 */
export function printerSlotLabeller(status: PrinterStatus | undefined): (trayIndex: number) => string {
  const trays = new Map(
    buildPrinterTrayGroups(status)
      .flatMap((group) => group.trays)
      .map((tray) => [
        tray.mappingValue,
        tray.kind === 'ams' && tray.groupLabel ? `${tray.groupLabel} ${tray.label}` : tray.label
      ] as const)
  )
  return (trayIndex) => trays.get(trayIndex) ?? `Slot ${trayIndex}`
}
