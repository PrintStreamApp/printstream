/**
 * Repairable defects in a stored project's `project_settings.config`, and the one place that knows
 * which ones exist.
 *
 * OWNS the LIST of invariants. Regular code asks {@link collectSettingsRepairReasons} what is wrong
 * with a project and never enumerates the checks itself — the index parser used to accumulate one
 * `inspect…()` call per defect, which meant every new defect edited a hot path that has nothing to do
 * with repairing. Adding one here is a single-file change, and the BAKE is the matching seam on the
 * fixing side: the editor's Repair stages `SceneEdit.repairSettings`, and the bake applies each
 * defect's repair implementation as its last settings step (see `three-mf/bake-documents.ts`).
 *
 * CONTRACT, shared by every invariant listed here:
 *  - Detection and repair come from ONE implementation per defect, so a file cannot be flagged by
 *    one rule and left untouched by another.
 *  - Nothing heals at rest. Repair is always an explicit user action; stored files are never
 *    rewritten as a side effect of opening, listing, or slicing them, and the result persists as a
 *    NEW library version (the save the staged repair rides on) so the pre-repair bytes stay
 *    restorable.
 *  - A repair never GUESSES. Where the correct value cannot be derived with certainty the slot is
 *    left alone and reported, because writing a plausible-looking wrong value is what produced
 *    several of these defects in the first place.
 */
import type { ThreeMfSettingsRepairReason } from '../printer-contracts.js'
import { inspectProjectFlushVolumesMatrix } from '../flush-volumes-matrix.js'
import { inspectProjectFilamentSelfIndex } from '../filament-variant-index.js'
import { inspectProjectFilamentIds } from './filament-ids.js'
import { inspectProjectFilamentPhysics } from './filament-physics.js'
import { inspectProjectInheritsGroup } from './inherits-group.js'
import { inspectModelSettingsObjectExtruders } from './object-extruder.js'

export * from './filament-ids.js'
export * from './filament-physics.js'
export * from './restore-filament-physics.js'
export * from './inherits-group.js'
export * from './object-extruder.js'

/**
 * Every repairable defect this project carries, in no particular order. Empty means nothing to
 * repair — which is also the answer for a project with no readable settings, since those are
 * unaffected rather than broken.
 *
 * `modelSettingsXml` is optional because not every caller holds the raw document (printer-SD
 * indexes pass none) — omitting it merely skips the model_settings-based invariants rather than
 * failing the settings-based ones.
 */
export function collectSettingsRepairReasons(
  projectSettingsJson: string | null | undefined,
  modelSettingsXml?: string | null
): ThreeMfSettingsRepairReason[] {
  const reasons: ThreeMfSettingsRepairReason[] = []
  // Undersized `flush_volumes_matrix`: BambuStudio reads the missing block out of bounds and
  // segfaults mid-slice (exit 139).
  if (inspectProjectFlushVolumesMatrix(projectSettingsJson)?.inconsistent === true) reasons.push('flushMatrix')
  // `filament_self_index` not matching the variant layout it is decoded against.
  if (inspectProjectFilamentSelfIndex(projectSettingsJson)?.inconsistent === true) reasons.push('variantIndex')
  // A slot's `filament_ids` entry naming a different material from its preset — BambuStudio binds on
  // the id, so it fabricates a defaults-only project preset for the slot instead of opening it.
  if (inspectProjectFilamentIds(projectSettingsJson)?.inconsistent === true) reasons.push('filamentIds')
  // Named presets missing or malforming their values. Unlike the byte-level invariants this one is
  // repaired from RESOLVED PRESETS, not from the file alone: the editor's Repair resolves each
  // slot's preset and the bake writes the values back (`restore-filament-physics.ts`).
  if (inspectProjectFilamentPhysics(projectSettingsJson)?.inconsistent === true) reasons.push('filamentPhysics')
  // `inherits_group` not `filaments + 2` long, left by a save that changed the filament count. The
  // CLI reads the filament names past their end and SIGSEGVs while LOADING (exit 139).
  if (inspectProjectInheritsGroup(projectSettingsJson)?.inconsistent === true) reasons.push('inheritsGroup')
  // An object carrying only part-level `extruder` metadata: the CLI slices by the OBJECT-level
  // entry, so the object silently prints with filament 1 instead of its assigned material.
  if (inspectModelSettingsObjectExtruders(modelSettingsXml)?.inconsistent === true) reasons.push('objectExtruder')
  return reasons
}
