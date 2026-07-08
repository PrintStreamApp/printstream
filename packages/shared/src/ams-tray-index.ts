/**
 * AMS tray-index math — the single source of truth for converting between a
 * physical AMS slot (`unitId` + `slotId`) and the "global tray index" Bambu uses
 * in the `ams_mapping` print payload.
 *
 * This mirrors BambuStudio's `DevFilaSystem::GetTrayIndexMap`
 * (`src/slic3r/GUI/DeviceCore/DevFilaSystem.cpp`). Bambu numbers global trays
 * differently per AMS generation:
 *
 *   - AMS / AMS Lite / AMS 2 Pro (N3F): `trayIndex = unitId * 4 + slotId`
 *     (4 slots per unit; the classic 4-unit layout spans 0-15).
 *   - AMS HT (N3S, a single high-temp slot): `trayIndex = unitId`, where the
 *     unit id itself is in the 128-152 band. The slot id is always 0.
 *   - AMS Lite Mixed (N9 only): `trayIndex = 24 + slotId`.
 *   - External-spool virtual trays: 254 (deputy/left) and 255 (main/right).
 *     Those are represented by `virtualTrayAmsIdSchema`, not by this module's
 *     physical-range helpers, but `trayIndexToAmsSlot` still round-trips them.
 *
 * Why this module exists: the classic `unitId * 4 + slotId` formula tops out at
 * 15 for a 4-unit layout, and an old `max(15)` wire cap silently rejected every
 * H2/H2D/H2S print that touched an AMS HT unit (indices 128+). Keeping the ranges
 * and the forward/reverse math in ONE place means the wire schema
 * (`printerTrayMappingSchema`), the MQTT status parser (`bambu-report-parser`),
 * and consumption tracking (`filament-manager`) can never drift apart again.
 *
 * These are pure functions with no Zod dependency so they can be reused from the
 * parser hot path, the web tray-group builders, and validators alike.
 */

/**
 * AMS generation, derived from the DevAmsType code in the MQTT `ams[].info`
 * field (bits 0-3). String values are self-documenting on the wire; keep them in
 * sync with {@link AMS_UNIT_TYPE_BY_CODE}.
 */
export type AmsUnitType =
  | 'ext-spool'
  | 'ams'
  | 'ams-lite'
  | 'ams-2-pro'
  | 'ams-ht'
  | 'ams-lite-mixed'
  | 'unknown'

/** All valid {@link AmsUnitType} values; used to build the Zod enum. */
export const AMS_UNIT_TYPES: readonly AmsUnitType[] = [
  'ext-spool',
  'ams',
  'ams-lite',
  'ams-2-pro',
  'ams-ht',
  'ams-lite-mixed',
  'unknown'
]

/**
 * Bambu's `DevAmsType` enum (see `DevDefs.h`), keyed by the numeric code read
 * from `ams[].info` bits 0-3.
 */
const AMS_UNIT_TYPE_BY_CODE: Record<number, AmsUnitType> = {
  0: 'ext-spool',
  1: 'ams',
  2: 'ams-lite',
  3: 'ams-2-pro', // N3F
  4: 'ams-ht', // N3S
  5: 'ams-lite-mixed'
}

/** Map a raw DevAmsType code (or `null`/unknown) to an {@link AmsUnitType}. */
export function amsUnitTypeFromCode(code: number | null | undefined): AmsUnitType {
  if (code == null) return 'unknown'
  return AMS_UNIT_TYPE_BY_CODE[code] ?? 'unknown'
}

/** Offset applied to AMS Lite Mixed (N9) slot ids to form the global tray index. */
export const AMS_LITE_MIXED_TRAY_INDEX_OFFSET = 24

/** Inclusive band of global tray indices reserved for AMS HT (N3S) units. */
export const AMS_HT_TRAY_INDEX_MIN = 128
export const AMS_HT_TRAY_INDEX_MAX = 152

/**
 * Upper bound of the classic `unitId * 4 + slotId` band. The real hardware
 * ceiling is 15 (four 4-slot units), but we accept up to 127 so extended
 * multi-unit H2 layouts never false-reject, while staying disjoint from the AMS
 * HT band at 128+.
 */
export const AMS_REGULAR_TRAY_INDEX_MAX = 127

/** Bambu virtual external-spool tray ids: main (right) and deputy (left). */
export const VIRTUAL_TRAY_MAIN_ID = 255
export const VIRTUAL_TRAY_DEPUTY_ID = 254

/**
 * Global tray index for a physical AMS slot, matching Bambu's
 * `GetTrayIndexMap`. Feed the result into `ams_mapping[filamentIndex]`.
 */
export function amsTrayIndex(unitType: AmsUnitType, unitId: number, slotId: number): number {
  switch (unitType) {
    case 'ams-ht':
      // Single high-temp slot: the unit id (128-152) *is* the global tray index.
      return unitId
    case 'ams-lite-mixed':
      return AMS_LITE_MIXED_TRAY_INDEX_OFFSET + slotId
    default:
      return unitId * 4 + slotId
  }
}

/** A physical AMS location. `slotId` is `null` for external virtual trays. */
export interface AmsSlotRef {
  amsId: number
  slotId: number | null
}

/**
 * Reverse of {@link amsTrayIndex}: resolve a global tray index (as stored in a
 * job's `amsMapping`) back to a physical `(amsId, slotId)` pair so consumption
 * tracking can find the loaded spool. Returns `null` for indices outside any
 * known band.
 *
 * Note: AMS Lite Mixed (N9) indices (24-27) are *not* disambiguated here — they
 * fall inside the regular band and reverse-map as regular slots. That printer
 * family is out of scope for consumption tracking; classic AMS and the H2 AMS HT
 * band are handled exactly.
 */
export function trayIndexToAmsSlot(trayIndex: number): AmsSlotRef | null {
  if (trayIndex === VIRTUAL_TRAY_MAIN_ID || trayIndex === VIRTUAL_TRAY_DEPUTY_ID) {
    return { amsId: trayIndex, slotId: null }
  }
  if (!Number.isInteger(trayIndex) || trayIndex < 0) return null
  if (trayIndex >= AMS_HT_TRAY_INDEX_MIN && trayIndex <= AMS_HT_TRAY_INDEX_MAX) {
    return { amsId: trayIndex, slotId: 0 }
  }
  if (trayIndex <= AMS_REGULAR_TRAY_INDEX_MAX) {
    return { amsId: Math.floor(trayIndex / 4), slotId: trayIndex % 4 }
  }
  return null
}

/**
 * Whether a value is a valid *physical* AMS tray index (a real slot, not an
 * external virtual tray). Used by `printerTrayMappingSchema` to validate the
 * `ams_mapping` entries a client submits.
 */
export function isPhysicalAmsTrayIndex(trayIndex: number): boolean {
  if (!Number.isInteger(trayIndex) || trayIndex < 0) return false
  if (trayIndex <= AMS_REGULAR_TRAY_INDEX_MAX) return true
  return trayIndex >= AMS_HT_TRAY_INDEX_MIN && trayIndex <= AMS_HT_TRAY_INDEX_MAX
}

/**
 * Spreadsheet-style unit letter for an AMS unit id: 0->A, 25->Z, 26->AA, ...
 * AMS HT (N3S) units are numbered from {@link AMS_HT_TRAY_INDEX_MIN} (128); Bambu
 * labels them A-Y by `unitId - 128`, so fold that band back down first.
 */
export function amsUnitLetter(unitId: number): string {
  if (!Number.isFinite(unitId) || unitId < 0) return String(unitId)
  let n = Math.floor(unitId)
  if (n >= AMS_HT_TRAY_INDEX_MIN) n -= AMS_HT_TRAY_INDEX_MIN
  let label = ''
  do {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return label
}
