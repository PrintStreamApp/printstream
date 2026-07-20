/**
 * Per-slot filament preset coverage for the CLI's `--load-filaments`.
 *
 * Owns one invariant, and it is the whole reason this module exists:
 *
 * > **`--load-filaments` carries exactly one entry per project filament slot, or
 * > it is not passed at all. A SHORT list is never emitted.**
 *
 * BambuStudio sizes its per-filament vectors from the loaded filament count and
 * indexes them by the project's slot ids. Hand it 1 preset for a 2-filament
 * project and it does not error — it broadcasts that preset across every slot, so
 * a PETG slot silently inherits a support filament's 210°C, and the loader then
 * reads out of bounds and segfaults (opaque exit 139; issue #66).
 *
 * The list used to be built from whichever presets the REQUEST could resolve to a
 * file, which is not one-per-slot: a slot left on the project's own preset
 * (`project:…`) resolves to no file by design — the 3MF's embedded settings ARE
 * that preset. So the common case of "change one material, leave the other" sent
 * a 1-entry list for a 2-slot project. That is why re-picking every preset by hand
 * made a failing project slice: it gave every slot a file.
 *
 * Precedence per slot: the request's own materialized preset (it carries the
 * user's per-material overrides) → the preset the 3MF names for that slot →
 * Generic PLA as a structural stand-in. Only if a slot can satisfy none of those
 * does the whole list collapse to null, leaving the project's embedded config to
 * drive every slot — which is what BambuStudio's own project loader does anyway
 * (`PresetBundle::load_config_model` scatters the project config column-wise onto
 * a complete default preset; it never needs per-slot preset files).
 *
 * Counterpart: `buildFilamentCoverageFromEmbedded` in `project-settings-fallback.ts`
 * enforces the same invariant for the settings-REPAIR export.
 */

/** One project filament slot, in the request's mapping order. */
export interface FilamentSlotRequest {
  /** 1-based project filament id. */
  projectFilamentId: number
  /** The preset chosen for this slot, or null/undefined for the project's own preset. */
  profileId?: string | null
}

/** Where one slot's filament preset comes from. Resolved here; materialized by the caller. */
export type FilamentSlotSource =
  /** The preset the request chose for this slot (carries the user's per-material tune). */
  | { origin: 'requested'; profileId: string }
  /** The builtin preset the 3MF names for this slot, or the Generic PLA stand-in. */
  | { origin: 'builtin'; name: string }

export interface FilamentSlotCoverageInput {
  /** One entry per project filament slot. Empty when the request carried no mappings. */
  slots: readonly FilamentSlotRequest[]
  /** Profile ids the request actually resolved to a preset file. */
  requestedProfileIds: ReadonlySet<string>
  /**
   * The input 3MF's per-slot `filament_settings_id`. Authoritative for the slot
   * COUNT and for the preset each slot names — by this point the pre-slice
   * metadata rewrite has already written the request's choices into it.
   */
  embeddedPresetNames: readonly string[]
  /** Whether a builtin preset name exists in the bundled catalogue. */
  hasBuiltinPreset: (name: string) => Promise<boolean>
}

/** The stand-in used for a slot no preset can be found for; only ever a structural baseline. */
export const FALLBACK_FILAMENT_PRESET_NAME = 'Generic PLA'

/**
 * One preset source per project slot, or `null` when full coverage is impossible
 * (see the invariant above — a short list is never returned).
 *
 * Returns null for a project with no filament slots at all, which is simply
 * "nothing to load" rather than a failure.
 */
export async function buildFilamentSlotCoverage(input: FilamentSlotCoverageInput): Promise<FilamentSlotSource[] | null> {
  const slotCount = Math.max(input.slots.length, input.embeddedPresetNames.length)
  if (slotCount === 0) return null

  // Index the request's slots by their 1-based project filament id rather than by
  // array position: mappings arrive in request order, which need not be slot order.
  const requestedBySlot = new Map<number, FilamentSlotRequest>()
  for (const slot of input.slots) requestedBySlot.set(slot.projectFilamentId, slot)

  let fallbackExists: boolean | undefined
  const sources: FilamentSlotSource[] = []

  for (let index = 0; index < slotCount; index += 1) {
    const chosenProfileId = requestedBySlot.get(index + 1)?.profileId?.trim()
    if (chosenProfileId && input.requestedProfileIds.has(chosenProfileId)) {
      sources.push({ origin: 'requested', profileId: chosenProfileId })
      continue
    }

    // No file for this slot (a `project:` preset, or one that did not resolve):
    // fall back to whatever preset the 3MF names for the slot.
    const embeddedName = input.embeddedPresetNames[index]?.trim()
    if (embeddedName && await input.hasBuiltinPreset(embeddedName)) {
      sources.push({ origin: 'builtin', name: embeddedName })
      continue
    }

    if (fallbackExists === undefined) fallbackExists = await input.hasBuiltinPreset(FALLBACK_FILAMENT_PRESET_NAME)
    // Nothing can cover this slot, so no list can be complete — see the invariant.
    if (!fallbackExists) return null
    sources.push({ origin: 'builtin', name: FALLBACK_FILAMENT_PRESET_NAME })
  }

  return sources
}
