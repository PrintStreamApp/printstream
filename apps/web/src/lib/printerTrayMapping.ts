/**
 * Shared, behavior-identical helpers for the printer "tray / filament mapping"
 * pickers used by both the library print dialog (`pages/LibraryView.tsx`) and
 * the printer-storage print dialog (`components/PrinterStorageModal.tsx`).
 *
 * Only the pieces that were byte-for-byte identical between the two call sites
 * live here:
 *   - the `PrinterTrayGroup<T>` shape (a labelled bucket of tray options),
 *   - `filterTrayGroupsForFilament` (drop trays whose nozzle can't feed a
 *     filament, then drop emptied groups),
 *   - `sanitizeTrayMapping` (trim trailing unset entries off a mapping array),
 *   - `amsUnitLetter` (0-based AMS unit id -> spreadsheet-style letter), now
 *     re-exported from `@printstream/shared`'s `ams-tray-index` so the labelling
 *     (including the AMS HT 128+ band) stays in one place.
 *
 * The global tray index a slot maps to for `ams_mapping` is NOT computed here:
 * use `amsTrayIndex()` from `@printstream/shared` (the single source of truth,
 * mirroring BambuStudio's `GetTrayIndexMap`) rather than `unitId * 4 + slotId`,
 * which is wrong for AMS HT (N3S) units.
 *
 * The tray-group BUILDERS, the default-mapping seeding, the compatibility-issue
 * computation, and the picker COMPONENTS still differ between the two sites and
 * are deliberately NOT shared here — see the dedup notes in those files.
 *
 * The group type is generic over the tray-option element so the two sites can
 * keep their own (drifted) tray-option shapes while still sharing this logic;
 * the only fields touched here are `group.trays` and `tray.nozzleId`.
 */

/** Minimal tray-option contract this module needs (nozzle the slot feeds). */
export interface TrayNozzleInfo {
  nozzleId: number | null
}

/** A labelled bucket of tray options (an AMS unit or the external-spool group). */
export interface PrinterTrayGroup<T extends TrayNozzleInfo> {
  key: string
  label: string
  trays: T[]
}

/**
 * Restrict tray groups to slots that can feed a filament's required nozzle.
 * Trays with no known nozzle (`null`) stay eligible; groups that end up empty
 * are dropped. A `null` requirement leaves the groups untouched.
 */
export function filterTrayGroupsForFilament<T extends TrayNozzleInfo>(
  groups: PrinterTrayGroup<T>[],
  requiredNozzleId: number | null
): PrinterTrayGroup<T>[] {
  if (requiredNozzleId == null) return groups
  return groups
    .map((group) => ({
      ...group,
      trays: group.trays.filter((tray) => tray.nozzleId == null || tray.nozzleId === requiredNozzleId)
    }))
    .filter((group) => group.trays.length > 0)
}

/**
 * Trim trailing unset entries off a mapping array. Every used filament must
 * already have a chosen slot before this is called (the submit button is gated
 * on the mapping being complete), so any remaining `-1` is for an unused
 * filament and is safe to drop or clamp to 0. Returns `undefined` when nothing
 * is mapped.
 */
export function sanitizeTrayMapping(mapping: number[] | undefined): number[] | undefined {
  if (!mapping || mapping.length === 0) return undefined
  let lastSet = -1
  for (let i = 0; i < mapping.length; i++) {
    if ((mapping[i] ?? -1) >= 0) lastSet = i
  }
  if (lastSet === -1) return undefined
  return mapping.slice(0, lastSet + 1).map((value) => (value < 0 ? 0 : value))
}

/**
 * Spreadsheet-style letter for a 0-based AMS unit id (0->A, 25->Z, 26->AA, ...),
 * with AMS HT (N3S) units in the 128+ band folded back to A-Y. Re-exported from
 * the shared `ams-tray-index` module so the labelling stays in one place; kept
 * exported here because many web components import it from this module.
 */
export { amsUnitLetter } from '@printstream/shared'
