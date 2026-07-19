/**
 * Keeping filament-index process settings pointing at the right material when a material is
 * removed.
 *
 * BambuStudio lets you delete a material even while a setting references it: the referencing
 * setting falls back to "Default" and everything else keeps pointing at the same material. We
 * mirror that, which is what makes removal safe to allow rather than block.
 *
 * The subtlety is that these settings store a POSITION in the ordered filament list (the index
 * the slicer reads), not a stable id — so removing position N does not just clear refs to N, it
 * shifts every higher reference down by one. Miss that and deleting material 2 of 3 silently
 * repoints "support interface" from material 3 to whatever now sits at 3 (nothing), or worse, at
 * a material the user never chose.
 *
 * Counterpart: `FILAMENT_INDEX_PROCESS_KEYS` in `@printstream/shared` names the settings whose
 * value is such an index; `SettingValueField` renders them as material pickers.
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
 * Apply {@link remapFilamentIndexValue} to every filament-index setting in an override map.
 * Returns the SAME object when nothing changed, so callers can skip a state update.
 */
export function remapFilamentIndexOverrides(
  overrides: Record<string, string | string[]>,
  removedPosition: number
): Record<string, string | string[]> {
  let changed = false
  const next: Record<string, string | string[]> = { ...overrides }
  for (const key of FILAMENT_INDEX_PROCESS_KEYS) {
    const raw = next[key]
    if (raw == null) continue
    // Array-valued overrides are per-extruder lists; remap each entry the same way.
    if (Array.isArray(raw)) {
      const mapped = raw.map((entry) => remapFilamentIndexValue(entry, removedPosition))
      if (mapped.some((entry, index) => entry !== raw[index])) {
        next[key] = mapped
        changed = true
      }
      continue
    }
    const mapped = remapFilamentIndexValue(raw, removedPosition)
    if (mapped !== raw) {
      next[key] = mapped
      changed = true
    }
  }
  return changed ? next : overrides
}

/**
 * The per-object variant: remaps each object's override map, returning the same object when no
 * object referenced the removed material.
 */
export function remapPerObjectFilamentIndexOverrides<T extends Record<string, Record<string, string | string[]>>>(
  perObject: T,
  removedPosition: number
): T {
  let changed = false
  const next = { ...perObject } as Record<string, Record<string, string | string[]>>
  for (const [objectKey, overrides] of Object.entries(perObject)) {
    const mapped = remapFilamentIndexOverrides(overrides, removedPosition)
    if (mapped !== overrides) {
      next[objectKey] = mapped
      changed = true
    }
  }
  return changed ? (next as T) : perObject
}
