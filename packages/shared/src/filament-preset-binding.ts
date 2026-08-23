/**
 * Records, per filament slot, which SYSTEM preset the slot's preset derives from and what it
 * changed: the two fields BambuStudio needs to bind a slot to a USER preset.
 *
 * WHY THIS IS NOT COSMETIC. Opening a project, BambuStudio rebuilds each slot's config and compares
 * it to the installed preset of the same name (`PresetCollection::load_external_preset` ->
 * `profile_print_params_same`). One differing key and it declines to bind, inventing a
 * `(<project>.3mf)` copy instead. Before that comparison it NORMALIZES the slot, and there are two
 * routes in:
 *
 *   if (!inherits.empty() && different_settings_list.size() > 0)   // <- any preset, incl. a user one
 *       cfg.update_non_diff_values_to_base_config(parent.config, ...)
 *   else if (found && it->is_system && different_settings_list.size() > 0)  // <- SYSTEM presets only
 *       cfg.update_non_diff_values_to_base_config(it->config, ...)
 *
 * That normalization replaces every key NOT named in `different_settings_to_system` with the base
 * preset's own value, so any residual drift in the file is erased before the comparison. A SYSTEM
 * preset gets it for free from the second branch. A USER preset only gets it if the project names
 * its parent in `inherits_group`, and BambuStudio's own saves do exactly that.
 *
 * MEASURED: a repaired project whose slot values were byte-identical to a BambuStudio-written file
 * still refused to bind slot 3, the one slot pointing at a user preset. The only difference between
 * the two files was `inherits_group[3]`: `"Bambu PLA Basic @BBL H2D"` in theirs, empty in ours.
 *
 * THE TWO FIELDS ARE ONE FACT AND MUST AGREE. With a parent named, `different_settings_to_system`
 * stops being advisory and becomes the list of keys allowed to survive normalization: a key the
 * preset genuinely changed but does not declare is overwritten with the parent's value and the slot
 * fails to bind anyway. So a binding is written as a pair or not at all.
 *
 * Counterpart: `apps/api/src/routes/slicing.ts` and `localFilamentResolver.ts` produce the pair
 * (both already resolve the parent for the changed-vs-preset badge); `three-mf/bake-documents.ts`
 * writes it into the saved project.
 */
import { FILAMENT_PRESET_OPTIONS } from './generated/preset-options.generated.js'
import { filamentConfigValuesEqual, filamentSettingsCatalog } from './filament-settings.js'
import type { ProcessConfig } from './process-settings.js'

/**
 * Identity, not physics. These describe WHICH filament a slot holds, so a difference in them is not
 * a setting the user changed and must never reach `different_settings_to_system`: BambuStudio
 * would then exempt them from normalization and compare a project-shaped value (one entry per slot)
 * against a preset-shaped one.
 */
const IDENTITY_KEYS = new Set([
  'filament_colour',
  'filament_type',
  'filament_settings_id',
  'filament_ids',
  'filament_id',
  'filament_nozzle_map',
  'filament_extruder_variant',
  'filament_self_index'
])

/** What a slot's preset inherits from, and what it changed. Both, or neither: see the header. */
export interface FilamentPresetBinding {
  /** The preset's `inherits` (a SYSTEM preset name). Null for a system preset, which needs none. */
  inherits: string | null
  /** Keys whose value differs from that parent's, in BambuStudio's `different_settings` sense. */
  changedKeys: string[]
}

/**
 * The keys where a resolved preset differs from its parent.
 *
 * Compared with {@link filamentConfigValuesEqual} rather than `===`, because a preset JSON and its
 * parent routinely spell one value differently (`"45.0"` vs `"45%"`, absent vs empty) and a string
 * comparison would declare phantom changes, which here is not merely cosmetic noise: an
 * over-declared key is exempted from normalization, so the file's value is kept where the parent's
 * was wanted.
 *
 * Both configs must already be FLATTENED (a BambuStudio preset export is a delta), or a key the
 * preset simply inherits reads as a deletion.
 */
export function filamentPresetChangedKeys(preset: ProcessConfig, parent: ProcessConfig): string[] {
  const changed: string[] = []
  for (const key of FILAMENT_PRESET_OPTIONS) {
    if (IDENTITY_KEYS.has(key)) continue
    const value = preset[key]
    // A key the preset does not mention is inherited by definition, so it changed nothing.
    if (value === undefined) continue
    const parentValue = parent[key]
    if (parentValue === undefined || !filamentConfigValuesEqual(value, parentValue, filamentSettingsCatalog.options[key])) changed.push(key)
  }
  return changed
}

/**
 * Write each slot's binding into the project config, in place.
 *
 * LAYOUT: both arrays are `[process, ...filaments, printer]`, so slot `i` lives at `i + 1`. A slot
 * with no binding keeps whatever the project already had, this is additive, and a caller that
 * could not resolve a preset must not be able to blank a record it knows nothing about.
 *
 * A binding with no parent (`inherits: null`) writes an EMPTY inherits entry, which is correct
 * rather than merely harmless: that is how BambuStudio marks a system preset, and it is what routes
 * the slot to the `is_system` normalization branch instead.
 */
export function applyFilamentPresetBindings(
  record: Record<string, unknown>,
  bindings: ReadonlyArray<FilamentPresetBinding | null>
): void {
  if (bindings.every((binding) => binding == null)) return
  const width = bindings.length + 2

  // Rebuild at the current filament count, keeping the process entry and the printer entry (which
  // sits at the END, so it moves when the material count changes).
  const resize = (key: string): string[] => {
    const previous = Array.isArray(record[key]) ? (record[key] as unknown[]).map((entry) => (typeof entry === 'string' ? entry : '')) : []
    const next = Array.from({ length: width }, (_unused, index) => previous[index] ?? '')
    next[0] = previous[0] ?? ''
    next[width - 1] = previous.length >= 2 ? previous[previous.length - 1]! : ''
    return next
  }

  const inherits = resize('inherits_group')
  const different = resize('different_settings_to_system')
  bindings.forEach((binding, slot) => {
    if (!binding) return
    inherits[slot + 1] = binding.inherits ?? ''
    different[slot + 1] = binding.changedKeys.join(';')
  })
  record.inherits_group = inherits
  record.different_settings_to_system = different
}
