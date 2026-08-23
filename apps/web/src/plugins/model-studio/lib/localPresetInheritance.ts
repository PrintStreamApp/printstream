/**
 * Flattens a browser-stored preset onto the built-in it inherits from.
 *
 * WHY: a preset exported from BambuStudio is a DELTA, not a full config: `inherits` names its
 * parent and the document carries only the keys the user changed. Handing that document out as if it
 * were a resolved config is how a project "repaired" against an uploaded preset came back with
 * almost nothing written: the repair only writes a key every slot defines, and a thin preset defines
 * a handful. The symptom is the worst kind: the repair reports success, the banner clears, and the
 * saved file is untouched.
 *
 * The workspace route resolves this server-side against the workspace catalogue. This is the same
 * operation for the public editor, whose "catalogue" is the browser store plus the anonymous
 * built-in endpoint.
 *
 * PARENT RESOLUTION, in order of confidence: the document's own `inherits`, then the name-prefix
 * match `findParentBuiltinPreset` already uses for baselines ("Bambu PLA Basic @BBL H2D - 55 degree
 * plate" -> "Bambu PLA Basic @BBL H2D"). A preset with neither resolves to itself: thin, but never
 * WRONG, and the repair's all-or-nothing rule then declines rather than writing half a material.
 *
 * Counterpart: `localFilamentResolver.ts` (the tune dialog / repair) and `localMachineRetarget.ts`
 * (the rebind), which must agree, they feed the same bake.
 */
import { buildBuiltinSlicingPresetId, filamentPresetChangedKeys, type ProcessConfig, type SlicingPresetSummary } from '@printstream/shared'
import { findParentBuiltinPreset } from './localPresetBaseline'
import type { LocalSlicingPreset } from './localSlicingPresets'

/** Keys BambuStudio writes for bookkeeping, not as settings. Never merged into a config. */
const PRESET_METADATA_KEYS = new Set(['inherits', 'from', 'is_custom_defined', 'version', 'type', 'setting_id', 'instantiation'])

/** The `inherits` name a stored preset declares, if any. */
export function localPresetParentName(preset: LocalSlicingPreset): string | null {
  const inherits = preset.raw.inherits
  if (typeof inherits === 'string' && inherits.trim().length > 0) return inherits.trim()
  return null
}

/** A stored preset resolved against its parent, plus what a SAVE needs to bind a slot to it. */
export interface FlattenedLocalPreset {
  /** The parent's values with the preset's own on top. */
  config: ProcessConfig
  /**
   * The parent's NAME, for the project's `inherits_group`. Null when no parent resolved, which is
   * "unknown", not "system": a saved project then leaves the slot's record alone rather than
   * claiming the preset has no parent. See `filament-preset-binding.ts`.
   */
  parentName: string | null
  /** Keys the preset changes versus that parent. Empty when there is no parent to measure against. */
  changedKeys: string[]
  /** The parent's own values, so a caller can measure the SLOT (preset plus project drift) against it. */
  parentConfig: ProcessConfig | null
  /**
   * True only when the preset NAMES a parent that could not be resolved: i.e. `config` is missing
   * inherited values it should have had.
   *
   * Distinct from `parentConfig: null`, which is also how a legitimately self-contained preset
   * returns. Collapsing the two made the tune dialog tell users that a preset with no parent "is
   * based on one that isn't available here", which is a false statement about their own file.
   */
  parentUnresolved: boolean
}

/**
 * Resolve a stored preset to a COMPLETE config: its parent's values with the preset's own on top.
 *
 * `resolveBuiltin` is injected so both hosts (and tests) can supply their own transport. A parent
 * that fails to resolve is not fatal: the preset's own values are returned alone, which is thin but
 * truthful.
 */
export async function flattenLocalPreset(
  preset: LocalSlicingPreset,
  profiles: SlicingPresetSummary[],
  resolveBuiltin: (builtinPresetId: string) => Promise<ProcessConfig | null>
): Promise<FlattenedLocalPreset> {
  const own: ProcessConfig = {}
  for (const [key, value] of Object.entries(preset.raw)) {
    if (PRESET_METADATA_KEYS.has(key)) continue
    own[key] = value as ProcessConfig[string]
  }

  const parentName = localPresetParentName(preset)
    ?? findParentBuiltinPreset(profiles, preset.name, preset.kind)?.name
    ?? null
  // Nothing to inherit FROM: the preset stands alone and `own` is already complete.
  if (!parentName) return { config: own, parentName: null, changedKeys: [], parentConfig: null, parentUnresolved: false }

  let parent: ProcessConfig | null = null
  try {
    parent = await resolveBuiltin(buildBuiltinSlicingPresetId(preset.kind, parentName))
  } catch {
    // Best effort: an unresolvable parent leaves the preset's own values, never a guess at the rest.
    parent = null
  }
  // A parent was named but did not resolve, so `own` is genuinely short of its inherited values.
  if (!parent) return { config: own, parentName: null, changedKeys: [], parentConfig: null, parentUnresolved: true }

  // PER-COLUMN merge, not per-key. A variant-scoped option holds one value per extruder variant, and
  // a delta preset routinely spells out only the first: BambuStudio's own file has
  // `filament_max_volumetric_speed: ["25","40"]` (Standard, High Flow) while a user preset may carry
  // just ["25"]. Replacing the whole key with the short array drops the High Flow value, and the
  // caller then has to invent one, which is how a repaired project opened in BambuStudio showing
  // "max volumetric speed changed to 25". The parent supplies every column the delta does not.
  const merged: ProcessConfig = { ...parent }
  for (const [key, value] of Object.entries(own)) {
    const parentValue = parent[key]
    if (!Array.isArray(value) || !Array.isArray(parentValue) || value.length >= parentValue.length) {
      merged[key] = value
      continue
    }
    merged[key] = parentValue.map((inherited, column) => value[column] ?? inherited)
  }
  // Measured on the MERGED config, not on `own`: a delta preset that spells out only column 0 of a
  // variant-scoped key differs from its parent in that column alone, and declaring the key from the
  // raw delta would exempt the whole key from BambuStudio's normalization.
  return { config: merged, parentName, changedKeys: filamentPresetChangedKeys(merged, parent), parentConfig: parent, parentUnresolved: false }
}
