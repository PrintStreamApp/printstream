/**
 * Keeping filament-index process settings pointing at the right material when the material LIST
 * changes shape — a material removed, or the list reordered.
 *
 * BambuStudio lets you delete a material even while a setting references it: the referencing
 * setting falls back to "Default" and everything else keeps pointing at the same material. We
 * mirror that, which is what makes removal safe to allow rather than block.
 *
 * The subtlety is that these settings store a POSITION in the ordered filament list (the index
 * the slicer reads), not a stable id — so removing position N does not just clear refs to N, it
 * shifts every higher reference down by one, and reordering the list renumbers every reference.
 * Miss that and deleting material 2 of 3 silently repoints "support interface" from material 3 to
 * whatever now sits at 3 (nothing), or worse, at a material the user never chose.
 *
 * Counterpart: `FILAMENT_INDEX_PROCESS_KEYS` in `@printstream/shared` names the settings whose
 * value is such an index; `SettingValueField` renders them as material pickers. The BAKE re-keys
 * the same references inside the saved file (`applyFilamentList` /
 * `remapModelSettingsFilamentRefs`); this module covers the session's live override state.
 */
import { FILAMENT_INDEX_PROCESS_KEYS } from '@printstream/shared'

/** BambuStudio's "Default" for a filament-index setting: use the object's own filament. */
const FILAMENT_INDEX_DEFAULT = '0'

/**
 * The value a filament-index setting should take after the material at 1-based `removedPosition`
 * is deleted: refs to it become "Default", refs above it shift down, refs below are untouched.
 * Non-numeric or already-default values pass through unchanged.
 */
export function remapFilamentIndexValue(value: string, removedPosition: number): string {
  const index = Number.parseInt(value, 10)
  if (!Number.isFinite(index) || index <= 0) return value
  if (index === removedPosition) return FILAMENT_INDEX_DEFAULT
  return index > removedPosition ? String(index - 1) : value
}

/**
 * The value a filament-index setting should take after the material list is REORDERED: `remap` is
 * the 1-based old-position → new-position permutation. A reference the permutation does not cover
 * (a dangling index) becomes "Default" rather than silently pointing at whatever material took
 * over the number.
 */
export function permuteFilamentIndexValue(value: string, remap: ReadonlyMap<number, number>): string {
  const index = Number.parseInt(value, 10)
  if (!Number.isFinite(index) || index <= 0) return value
  const moved = remap.get(index)
  return moved == null ? FILAMENT_INDEX_DEFAULT : String(moved)
}

/**
 * Apply one value-mapping rule to every filament-index setting in an override map.
 * Returns the SAME object when nothing changed, so callers can skip a state update.
 */
function mapFilamentIndexOverrides(
  overrides: Record<string, string | string[]>,
  mapValue: (value: string) => string
): Record<string, string | string[]> {
  let changed = false
  const next: Record<string, string | string[]> = { ...overrides }
  for (const key of FILAMENT_INDEX_PROCESS_KEYS) {
    const raw = next[key]
    if (raw == null) continue
    // Array-valued overrides are per-extruder lists; remap each entry the same way.
    if (Array.isArray(raw)) {
      const mapped = raw.map(mapValue)
      if (mapped.some((entry, index) => entry !== raw[index])) {
        next[key] = mapped
        changed = true
      }
      continue
    }
    const mapped = mapValue(raw)
    if (mapped !== raw) {
      next[key] = mapped
      changed = true
    }
  }
  return changed ? next : overrides
}

/** {@link remapFilamentIndexValue} over a whole override map (same-object return when unchanged). */
export function remapFilamentIndexOverrides(
  overrides: Record<string, string | string[]>,
  removedPosition: number
): Record<string, string | string[]> {
  return mapFilamentIndexOverrides(overrides, (value) => remapFilamentIndexValue(value, removedPosition))
}

/** {@link permuteFilamentIndexValue} over a whole override map (same-object return when unchanged). */
export function permuteFilamentIndexOverrides(
  overrides: Record<string, string | string[]>,
  remap: ReadonlyMap<number, number>
): Record<string, string | string[]> {
  return mapFilamentIndexOverrides(overrides, (value) => permuteFilamentIndexValue(value, remap))
}

/**
 * The per-object variant: remaps each object's override map, returning the same object when no
 * object referenced an affected material.
 */
function mapPerObjectFilamentIndexOverrides<T extends Record<string, Record<string, string | string[]>>>(
  perObject: T,
  mapOverrides: (overrides: Record<string, string | string[]>) => Record<string, string | string[]>
): T {
  let changed = false
  const next = { ...perObject } as Record<string, Record<string, string | string[]>>
  for (const [objectKey, overrides] of Object.entries(perObject)) {
    const mapped = mapOverrides(overrides)
    if (mapped !== overrides) {
      next[objectKey] = mapped
      changed = true
    }
  }
  return changed ? (next as T) : perObject
}

/** Per-object removal remap (same-object return when unchanged). */
export function remapPerObjectFilamentIndexOverrides<T extends Record<string, Record<string, string | string[]>>>(
  perObject: T,
  removedPosition: number
): T {
  return mapPerObjectFilamentIndexOverrides(perObject, (overrides) => remapFilamentIndexOverrides(overrides, removedPosition))
}

/** Per-object reorder remap (same-object return when unchanged). */
export function permutePerObjectFilamentIndexOverrides<T extends Record<string, Record<string, string | string[]>>>(
  perObject: T,
  remap: ReadonlyMap<number, number>
): T {
  return mapPerObjectFilamentIndexOverrides(perObject, (overrides) => permuteFilamentIndexOverrides(overrides, remap))
}
