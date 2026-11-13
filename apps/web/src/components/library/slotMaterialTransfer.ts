/**
 * Whether a material slot's tuned values survive a change of the slot's material.
 *
 * Bambu Studio's rule (`Tab::select_preset`): switching to a filament preset whose RAW
 * `filament_type` differs sets `no_transfer`, so edits made for PLA never ride onto PETG. The
 * values-side twin is `filamentSlotValuesCarryTo` in `@printstream/shared`; this answers the same
 * question from the preset SUMMARIES the picker holds, because a pick happens before any config is
 * resolved. Unknown on either side carries, matching the shared rule: dropping a user's tuning on
 * a guess is the worse failure.
 */
import { filamentTransferType, type SlicingPresetSummary } from '@printstream/shared'

/**
 * @param previousRawType the slot's current material type, raw (`PLA`, never the display `PLA-S`)
 * @param nextProfileId the newly picked option's preset id, or null for an option with no preset
 * @param profiles the catalogue the ids resolve in
 * @returns true when the slot's tuned values should be dropped
 */
export function slotMaterialChangeDropsTuning(
  previousRawType: string | null | undefined,
  nextProfileId: string | null,
  profiles: readonly SlicingPresetSummary[]
): boolean {
  const previous = filamentTransferType(previousRawType)
  const next = filamentTransferType(nextProfileId ? profiles.find((profile) => profile.id === nextProfileId)?.filamentType : null)
  if (!previous || !next) return false
  return previous !== next
}

/**
 * The raw type a slot carries before a pick: the preset behind its current pick, else the type the
 * file recorded for the slot it was cloned from.
 */
export function slotCurrentRawMaterialType(input: {
  pickedProfileId: string | null | undefined
  profiles: readonly SlicingPresetSummary[]
  fileFilamentType: string | null | undefined
}): string | null {
  if (input.pickedProfileId) {
    const picked = input.profiles.find((profile) => profile.id === input.pickedProfileId)?.filamentType
    if (picked?.trim()) return picked.trim()
  }
  return input.fileFilamentType?.trim() || null
}
