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

/** One flagged defect, and whether the Repair action can actually fix it. */
export interface SettingsRepair {
  reason: ThreeMfSettingsRepairReason
  /**
   * False when the inspector flagged the defect but its repair DECLINES the shape: the value
   * cannot be derived with certainty, so the never-guess rule leaves it alone. Reporting it is
   * still right (the file is broken), but offering a Repair button is not, because pressing it
   * writes a new library version, changes nothing, and brings the banner straight back.
   */
  repairable: boolean
}

/**
 * Every defect this project carries, with whether each one can be repaired.
 *
 * OWNS the repairability signal, which each inspector already computes and this seam used to
 * discard: only the reason names reached the wire, so the UI could not tell a fixable defect from
 * one it should send the user to fix by hand (issue #101).
 *
 * PER REASON, not per file, and that is the load-bearing part: a project can carry a repairable
 * and an unrepairable defect at once, and collapsing them to one flag would either strand the
 * fixable one or promise a fix for the other.
 *
 * Empty means nothing to repair, which is also the answer for a project with no readable settings,
 * since those are unaffected rather than broken.
 *
 * `modelSettingsXml` is optional because not every caller holds the raw document (printer-SD
 * indexes pass none): omitting it merely skips the model_settings-based invariants rather than
 * failing the settings-based ones.
 */
export function collectSettingsRepairs(
  projectSettingsJson: string | null | undefined,
  modelSettingsXml?: string | null
): SettingsRepair[] {
  const repairs: SettingsRepair[] = []
  // Flush sizing vs machine topology, two engine failures under one reason: an undersized
  // `flush_volumes_matrix` (BambuStudio reads the missing block out of bounds and segfaults
  // mid-slice, exit 139), and a `flush_multiplier` whose length the engine's g-code-time size
  // check rejects (exit 156, "Flush volumes matrix do not match to the correct size!").
  // Repairable whenever flagged: both sizes are derived from the machine topology, which the
  // project always states.
  if (inspectProjectFlushVolumesMatrix(projectSettingsJson)?.inconsistent === true) {
    repairs.push({ reason: 'flushMatrix', repairable: true })
  }
  // `filament_self_index` not matching the variant layout it is decoded against.
  const variantIndex = inspectProjectFilamentSelfIndex(projectSettingsJson)
  if (variantIndex?.inconsistent === true) {
    repairs.push({ reason: 'variantIndex', repairable: variantIndex.repairable })
  }
  // A slot's `filament_ids` entry naming a different material from its preset: BambuStudio binds on
  // the id, so it fabricates a defaults-only project preset for the slot instead of opening it.
  // `inconsistent` already requires a slot whose correct id is KNOWN, so a flagged file always has
  // something to fix; slots whose preset the catalogue cannot match ride in `unresolved` and are
  // reported by the repair itself as a partial result.
  if (inspectProjectFilamentIds(projectSettingsJson)?.inconsistent === true) {
    repairs.push({ reason: 'filamentIds', repairable: true })
  }
  // Named presets missing or malforming their values. Unlike the byte-level invariants this one is
  // repaired from RESOLVED PRESETS, not from the file alone: the editor's Repair resolves each
  // slot's preset and the bake writes the values back (`restore-filament-physics.ts`).
  if (inspectProjectFilamentPhysics(projectSettingsJson)?.inconsistent === true) {
    repairs.push({ reason: 'filamentPhysics', repairable: true })
  }
  // `inherits_group` not `filaments + 2` long, left by a save that changed the filament count. The
  // CLI reads the filament names past their end and SIGSEGVs while LOADING (exit 139). NOT always
  // repairable: an array too short to tell the process entry from the machine entry is left alone,
  // because guessing would move a preset name into the wrong role.
  const inheritsGroup = inspectProjectInheritsGroup(projectSettingsJson)
  if (inheritsGroup?.inconsistent === true) {
    repairs.push({ reason: 'inheritsGroup', repairable: inheritsGroup.repairable })
  }
  // An object carrying only part-level `extruder` metadata: the CLI slices by the OBJECT-level
  // entry, so the object silently prints with filament 1 instead of its assigned material. Every
  // shape this flags has a derivable slot (see `object-extruder.ts`), so a flagged file is always
  // clearable.
  if (inspectModelSettingsObjectExtruders(modelSettingsXml)?.inconsistent === true) {
    repairs.push({ reason: 'objectExtruder', repairable: true })
  }
  return repairs
}

/**
 * Every defect this project carries, in no particular order.
 *
 * The reason-only view of {@link collectSettingsRepairs}, kept because it is what the cached wire
 * field and every existing caller speak.
 */
export function collectSettingsRepairReasons(
  projectSettingsJson: string | null | undefined,
  modelSettingsXml?: string | null
): ThreeMfSettingsRepairReason[] {
  return collectSettingsRepairs(projectSettingsJson, modelSettingsXml).map((repair) => repair.reason)
}

/**
 * The flagged defects whose repair would decline, so a surface can withhold an action that cannot
 * work and name the manual remedy instead. Empty is the common case and also the honest answer for
 * a project with nothing wrong.
 */
export function unrepairableSettingsRepairReasons(
  projectSettingsJson: string | null | undefined,
  modelSettingsXml?: string | null
): ThreeMfSettingsRepairReason[] {
  return collectSettingsRepairs(projectSettingsJson, modelSettingsXml)
    .filter((repair) => !repair.repairable)
    .map((repair) => repair.reason)
}
