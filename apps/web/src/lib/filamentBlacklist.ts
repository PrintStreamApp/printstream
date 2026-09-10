/**
 * Bridges live printer state into the shared filament-blacklist rules for the print dialogs'
 * "Bambu does not support this material here" alert (`components/FilamentBlacklistAlert`).
 *
 * Sibling of `lowFilament.ts`, and thin for the same reason: the rules and the wording are
 * `@printstream/shared`'s (`checkPrinterFilamentBlacklist`), which the API's dispatch guard runs
 * too, so this module owns only the web's slot LABELS and the per-printer grouping the dialogs
 * render. A prohibition the dialog shows and a prohibition dispatch refuses on are then the same
 * sentence about the same tray, which is what lets the dialog offer a confirm that actually works.
 *
 * Note the two severities are kept apart all the way to the component: only prohibitions gate the
 * Print button, and only they are what `allowBlacklistedFilament` consents to. Warnings are advice
 * with nothing to accept, so folding them together here would either block ordinary TPU prints or
 * make the checkbox claim to cover a risk it does not.
 */
import {
  blacklistProhibitions,
  blacklistWarnings,
  checkPrinterFilamentBlacklist,
  type FilamentBlacklistFinding,
  type PrinterStatus
} from '@printstream/shared'
import { printerSlotLabeller } from './lowFilament'

/** One tray, named the way this dialog names trays, and what the rules said about it. */
export interface FilamentBlacklistSlotEntry {
  trayIndex: number
  slotLabel: string
  prohibitions: FilamentBlacklistFinding[]
  warnings: FilamentBlacklistFinding[]
}

/** A printer's blacklist findings, grouped so a multi-printer dialog can head each block. */
export interface FilamentBlacklistEntry {
  printerId: string
  /** Omitted when the dialog targets a single printer and a heading would be noise. */
  printerName?: string | null
  slots: FilamentBlacklistSlotEntry[]
}

/**
 * The mapped trays this printer has something to say about, labelled.
 *
 * Empty when the printer has no status or nothing is mapped: an empty result means "no rule
 * matched", never "checked and safe". Only trays with at least one finding appear.
 */
export function findPrinterFilamentBlacklist(
  printerId: string,
  printerModel: string,
  status: PrinterStatus | undefined,
  amsMapping: number[] | undefined,
  /**
   * The filament ids the selected plate uses. Passed for the same reason the API passes it: the
   * mapping is positional over every project filament, and an entry for one this plate does not
   * print must not be graded on either side.
   */
  plateFilamentIds?: readonly number[],
  supportFilamentIds?: readonly number[],
  printerName?: string | null
): FilamentBlacklistEntry | null {
  if (!status) return null
  const labelFor = printerSlotLabeller(status)
  const slots = checkPrinterFilamentBlacklist({
    printerModel,
    status,
    amsMapping,
    plateFilamentIds,
    supportFilamentIds
  }).map((entry) => ({
    trayIndex: entry.trayIndex,
    slotLabel: labelFor(entry.trayIndex) || entry.fallbackLabel,
    prohibitions: blacklistProhibitions(entry.findings),
    warnings: blacklistWarnings(entry.findings)
  }))

  if (slots.length === 0) return null
  return { printerId, printerName, slots }
}

/** Whether any entry carries a prohibition, i.e. whether the Print button must be gated. */
export function hasBlacklistProhibitions(entries: readonly FilamentBlacklistEntry[]): boolean {
  return entries.some((entry) => entry.slots.some((slot) => slot.prohibitions.length > 0))
}

/** Stable content identity for the exact prohibitions a consent checkbox acknowledges. */
export function filamentBlacklistConsentSignature(entries: readonly FilamentBlacklistEntry[]): string {
  return JSON.stringify(entries.map((entry) => [
    entry.printerId,
    entry.slots.map((slot) => [slot.trayIndex, slot.prohibitions.map((finding) => finding.message)])
  ]))
}
