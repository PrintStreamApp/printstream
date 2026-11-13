/**
 * A project's filament VARIANT ROWS, and moving per-variant values between two layouts.
 *
 * OWNS one rule that four writers used to approximate with a uniform width: a variant-scoped
 * filament array (`variant-options.ts`) has one value per ROW of `filament_extruder_variant`, each
 * row owned by the slot `filament_self_index` names, and the rows are NOT evenly split. A TPU slot
 * claims every printer variant while other materials share the standard ones
 * (`buildFilamentVariantRows`), so PLA + TPU on an H2D is 3 + 4 rows. Dividing the row count by the
 * slot count was how a retarget left values at the old machine's width (a PETG slot read PLA's
 * 220 C through the engine's out-of-range `get_at`), how a rebind wrote a 6-row variant list under
 * a 7-row index (a file Bambu Studio refuses: `PresetBundle.cpp` "Invalid configuration file"),
 * and how removing a TPU slot deleted `nozzle_temperature` outright.
 *
 * Values move by (slot, variant NAME), which is how Bambu Studio itself remaps a variant edit
 * (`Tab.cpp` `handle_transfer_action`). A target row whose variant the source slot lacks takes the
 * source slot's FIRST row, which is what Studio's own loader does with a short vector
 * (`ConfigOptionVector::get_at` falls back to `front()`), so it invents nothing Studio would not.
 *
 * Pure and dependency-light; the callers own when a layout changes.
 */
import { filamentVariantRowsPerSlot } from './variant-options.js'

/** One row of a filament layout: the 0-based slot that owns it, and its extruder variant. */
export interface FilamentVariantRow {
  slot: number
  /** Null for a project with no variant layout, where each slot has exactly one row. */
  variant: string | null
}

/**
 * The layout a record DECLARES, row by row, for `slotCount` filament slots.
 *
 * A record with no `filament_extruder_variant` has one unnamed row per slot. Null when rows exist
 * but cannot be attributed to slots with certainty (no usable index and an uneven split): a caller
 * must then leave variant-scoped values alone rather than guess, see `filamentVariantRowsPerSlot`.
 */
export function readFilamentVariantRows(record: Record<string, unknown>, slotCount: number): FilamentVariantRow[] | null {
  if (slotCount <= 0) return null
  const declared = record.filament_extruder_variant
  if (!Array.isArray(declared) || declared.length === 0) {
    return Array.from({ length: slotCount }, (_unused, slot) => ({ slot, variant: null }))
  }
  const variants = declared.map((entry) => (typeof entry === 'string' ? entry : String(entry)))

  // Prefer the index itself: it names each row's owner, whatever order the rows are in.
  const selfIndex = record.filament_self_index
  if (Array.isArray(selfIndex) && selfIndex.length === variants.length) {
    const owners = selfIndex.map((entry) => Number.parseInt(String(entry), 10) - 1)
    const covered = new Set(owners)
    const valid = owners.every((owner) => Number.isInteger(owner) && owner >= 0 && owner < slotCount)
    if (valid && covered.size === slotCount) {
      return variants.map((variant, row) => ({ slot: owners[row]!, variant }))
    }
  }

  // No usable index: contiguous blocks, but only for a split that is certain.
  const perSlot = filamentVariantRowsPerSlot(record, slotCount)
  if (!perSlot) return null
  const rows: FilamentVariantRow[] = []
  perSlot.forEach((count, slot) => {
    for (let index = 0; index < count; index++) rows.push({ slot, variant: variants[rows.length] ?? null })
  })
  return rows.length === variants.length ? rows : null
}

/** Row indices owned by each slot, in layout order. */
export function filamentRowsBySlot(rows: readonly FilamentVariantRow[], slotCount: number): number[][] {
  const bySlot: number[][] = Array.from({ length: slotCount }, () => [])
  rows.forEach((row, index) => { bySlot[row.slot]?.push(index) })
  return bySlot
}

/**
 * Move one variant-scoped value from layout `from` to layout `to`.
 *
 * @param slotSource maps a TARGET slot to the SOURCE slot its values come from; identity by
 *   default. A list edit (reorder, remove, add-by-cloning) supplies its own mapping.
 * @returns the value at `to`'s width, or null when `value` does not match `from` (a stale array
 *   whose rows cannot be attributed) or a target slot has no source rows to read.
 */
export function relayFilamentVariantValue(
  value: readonly unknown[],
  from: readonly FilamentVariantRow[],
  to: readonly FilamentVariantRow[],
  slotSource: (targetSlot: number) => number = (slot) => slot
): unknown[] | null {
  if (value.length !== from.length) return null
  const out: unknown[] = []
  for (const target of to) {
    const sourceSlot = slotSource(target.slot)
    let firstOfSlot = -1
    let match = -1
    for (let index = 0; index < from.length; index++) {
      const row = from[index]!
      if (row.slot !== sourceSlot) continue
      if (firstOfSlot < 0) firstOfSlot = index
      if (target.variant != null && row.variant === target.variant) {
        match = index
        break
      }
    }
    const pick = match >= 0 ? match : firstOfSlot
    if (pick < 0) return null
    out.push(value[pick])
  }
  return out
}

/** Whether two layouts are row-for-row identical (no relay needed). */
export function sameFilamentVariantRows(a: readonly FilamentVariantRow[], b: readonly FilamentVariantRow[]): boolean {
  return a.length === b.length && a.every((row, index) => row.slot === b[index]!.slot && row.variant === b[index]!.variant)
}
