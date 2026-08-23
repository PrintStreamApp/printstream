/**
 * Repairable defects in a stored project's `project_settings.config`, and the one place that knows
 * which ones exist.
 *
 * OWNS the LIST of invariants. Regular code asks {@link collectSettingsRepairReasons} what is wrong
 * with a project and never enumerates the checks itself: the index parser used to accumulate one
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
 *
 * WHERE THIS SITS AGAINST BAMBUSTUDIO. Studio has no registry like this one; its invariants are
 * scattered across the importer, the preset bundle and the slicer, which is why the same rule
 * appears twice there with different bounds. What it does have are three guards, all three assessed
 * against this codebase rather than adopted on principle:
 *
 *  - CLAMP AT POINT OF USE (`PrintObject.cpp`: a filament reference above the filament count falls
 *    back to 1). We hold this already, and earlier: `FILAMENT_INDEX_PROCESS_KEYS` is exactly the
 *    same five keys and the bake rewrites them while AUTHORING, so the saved file is self-consistent
 *    instead of relying on the engine to paper over it at slice time. Pinned by
 *    `three-mf/bake-documents.filamentRefs.test.ts`.
 *  - RANGE-CHECK EVERY OPTION against the bounds in its own definition (`validate()`). Not
 *    duplicated here. We carry `min`/`max` too and could sweep them before slicing, but that would
 *    be a second implementation of the engine's rule, free to disagree with the engine it exists to
 *    predict, and every defect in this area came from exactly that shape. The engine already
 *    answers, and the CLI prints which options it refused, so `apps/slicer/src/cli-exit-codes.ts`
 *    reports THAT instead.
 *  - A SUBSTITUTION LEDGER (`ConfigSubstitutionContext`: every value the loader replaces is recorded
 *    with old and new, and the caller passes the policy, throw / silent / report). Not built. The
 *    one place we substitute silently is the bake rewriting a reference to a material that is gone,
 *    and the editor already refuses to remove a material an object still uses, so that path is
 *    defence in depth rather than something a user reaches. Worth revisiting the day a substitution
 *    can happen where nothing upstream prevents it; the pattern to copy then is the POLICY being an
 *    argument, not the ledger itself.
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
 * repair, which is also the answer for a project with no readable settings, since those are
 * unaffected rather than broken.
 *
 * `modelSettingsXml` is optional because not every caller holds the raw document (printer-SD
 * indexes pass none): omitting it merely skips the model_settings-based invariants rather than
 * failing the settings-based ones.
 */
export function collectSettingsRepairReasons(
  projectSettingsJson: string | null | undefined,
  modelSettingsXml?: string | null
): ThreeMfSettingsRepairReason[] {
  const reasons: ThreeMfSettingsRepairReason[] = []
  // Flush sizing vs machine topology, two engine failures under one reason: an undersized
  // `flush_volumes_matrix` (BambuStudio reads the missing block out of bounds and segfaults
  // mid-slice, exit 139), and a `flush_multiplier` whose length the engine's g-code-time size
  // check rejects (exit 156, "Flush volumes matrix do not match to the correct size!").
  if (inspectProjectFlushVolumesMatrix(projectSettingsJson)?.inconsistent === true) reasons.push('flushMatrix')
  // `filament_self_index` not matching the variant layout it is decoded against.
  if (inspectProjectFilamentSelfIndex(projectSettingsJson)?.inconsistent === true) reasons.push('variantIndex')
  // A slot's `filament_ids` entry naming a different material from its preset: BambuStudio binds on
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
