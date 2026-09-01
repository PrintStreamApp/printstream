/**
 * Mesh booleans: union, difference and intersection over triangle soups.
 *
 * Mirrors BambuStudio's `GLGizmoMeshBoolean` contract -- the same three operations, the same A/B
 * split for difference, and the same minimum-input rules with the same wording -- but not its engine:
 * Studio uses CGAL and mcut, which are native C++. Here the work is done by `three-bvh-csg`, which
 * reuses the `three-mesh-bvh` acceleration structure the editor already ships.
 *
 * OWNS the geometry and the rules. It owns no scene, no selection and no React: callers hand it
 * WORLD-space soups and get a world-space soup back, exactly like the STL export path, so a boolean
 * between two objects means what it looks like on the plate rather than what it would mean in each
 * object's own coordinates.
 *
 * Two invariants worth keeping.
 *
 * A boolean is only meaningful between CLOSED solids. An open mesh has no inside, so "subtract B
 * from A" has no defined answer, and CSG on one does not fail -- it returns plausible-looking
 * geometry that slices into nonsense. {@link isClosedSoup} therefore gates every operand, and the
 * caller refuses rather than warning afterwards. The check runs INSIDE the evaluation (see
 * `meshBooleanCore.ts`), so it lands on the worker thread with the CSG; it is re-exported here
 * because the rule belongs with the rules even though the work does not.
 *
 * Order matters for difference and for nothing else. Union and intersection are commutative, so
 * their inputs fold in any order; difference is A minus B, which is why Studio keeps two lists and
 * why this takes two groups rather than a flat list.
 *
 * The EVALUATION is not here: it runs in a worker (`meshBooleanWorker.ts` via
 * `meshBooleanClient.ts`, over the DOM-free `meshBooleanCore.ts`) because CSG over two real models
 * is seconds of synchronous work. `evaluateMeshBoolean` is re-exported below so callers see one
 * module, and the split stays an implementation detail of where the work happens.
 */

import { isNonRenderableThreeMfPartSubtype, type SceneEditPartSubtype } from '@printstream/shared'

/** The three operations, spelled as BambuStudio spells them (`OP_UNION`, `A_NOT_B`, …). */
export type MeshBooleanOperation = 'union' | 'difference' | 'intersection'

/** Whether the operands are whole objects or volumes inside one object. Studio's two modes. */
export type MeshBooleanTargetMode = 'object' | 'part'

/**
 * Why a boolean cannot run yet, in BambuStudio's own words.
 *
 * Copied rather than reworded so a user reading our message and Studio's documentation sees the same
 * requirement, and because the counts ARE the rule: union and intersection need two operands, and
 * difference needs at least one on each side of the minus.
 */
export const MESH_BOOLEAN_WARNINGS = {
  minVolumesUnion: 'Union operation requires at least two volumes.',
  minVolumesIntersection: 'Intersection operation requires at least two volumes.',
  minVolumesDifference: 'Difference operation requires at least one volume in both A and B lists.',
  minObjectsUnion: 'Union operation requires at least two objects.',
  minObjectsIntersection: 'Intersection operation requires at least two objects.',
  minObjectsDifference: 'Difference operation requires at least one object in both A and B lists.'
} as const

/**
 * Whether the current selection satisfies the operation, or the reason it does not.
 *
 * Returns null when it is runnable. Mirrors `GLGizmoMeshBoolean::validate_operation`, including
 * choosing the object-worded or volume-worded message from the target mode: the same shortfall reads
 * differently depending on what the user thinks they are combining.
 */
export function validateMeshBoolean(
  operation: MeshBooleanOperation,
  mode: MeshBooleanTargetMode,
  counts: { working: number; listA: number; listB: number }
): string | null {
  const isObject = mode === 'object'
  if (operation === 'difference') {
    if (counts.listA >= 1 && counts.listB >= 1) return null
    return isObject ? MESH_BOOLEAN_WARNINGS.minObjectsDifference : MESH_BOOLEAN_WARNINGS.minVolumesDifference
  }
  if (counts.working >= 2) return null
  if (operation === 'union') {
    return isObject ? MESH_BOOLEAN_WARNINGS.minObjectsUnion : MESH_BOOLEAN_WARNINGS.minVolumesUnion
  }
  return isObject ? MESH_BOOLEAN_WARNINGS.minObjectsIntersection : MESH_BOOLEAN_WARNINGS.minVolumesIntersection
}



/**
 * Which operands sit in which list, keyed by whatever identity the caller addresses operands with
 * (an instance key in object mode, a part key in part mode).
 *
 * Union and intersection fold `working`; difference is `a` minus `b`. All three are kept at once so
 * switching operation does not lose an assignment the user made, exactly as Studio's
 * `VolumeListManager` holds its working list alongside its A and B lists.
 *
 * READONLY by type, not by convention: `assignMeshBooleanList` passes `working` through by reference
 * and {@link EMPTY_MESH_BOOLEAN_LISTS} is a shared frozen constant, so an in-place push anywhere
 * would corrupt every consumer at once. Build a new array instead.
 */
export interface MeshBooleanLists {
  working: ReadonlyArray<string>
  a: ReadonlyArray<string>
  b: ReadonlyArray<string>
}

/**
 * No operands anywhere: what a surface renders before its lists are seeded.
 *
 * A shared frozen constant rather than a `{working: [], a: [], b: []}` literal at each call site,
 * because a fresh object per render defeats the memoisation of everything downstream of it -- and
 * the un-seeded case is the one a caller reaches on every open.
 *
 * Genuinely frozen, arrays included, because `assignMeshBooleanList` hands the lists straight
 * through by reference: an in-place push on one of them would otherwise corrupt the shared constant
 * for every consumer for the rest of the session, silently. Frozen, that becomes a throw at the
 * mutation instead of a mystery somewhere downstream.
 */
export const EMPTY_MESH_BOOLEAN_LISTS: MeshBooleanLists = Object.freeze({
  working: Object.freeze([]) as ReadonlyArray<string>,
  a: Object.freeze([]) as ReadonlyArray<string>,
  b: Object.freeze([]) as ReadonlyArray<string>
})

/**
 * Seed the lists from a selection, in selection order.
 *
 * Mirrors `VolumeListManager::init_object_mode_lists`: the FIRST operand goes to A and every other
 * to B, so a difference is "the thing you picked first, minus the rest" without further clicks.
 * Everything lands in the working list, which is what union and intersection read.
 */
export function seedMeshBooleanLists(operands: readonly string[]): MeshBooleanLists {
  const [first, ...rest] = operands
  return {
    working: [...operands],
    a: first == null ? [] : [first],
    b: [...rest]
  }
}

/**
 * Move one operand into `target`, removing it from the other difference list.
 *
 * A and B are exclusive (an operand cannot be both the minuend and the subtrahend), while `working`
 * is left alone: it is the union/intersection list and does not partition.
 */
export function assignMeshBooleanList(
  lists: MeshBooleanLists,
  operand: string,
  target: 'a' | 'b'
): MeshBooleanLists {
  const a = lists.a.filter((entry) => entry !== operand)
  const b = lists.b.filter((entry) => entry !== operand)
  if (target === 'a') a.push(operand)
  else b.push(operand)
  return { working: lists.working, a, b }
}

/**
 * Drop operands that are no longer selected, keeping the order of those that remain, and adopt any
 * that have newly appeared.
 *
 * The selection can change while the panel is open (a Ctrl-click in the viewport, an undo), and a
 * list naming an operand that is gone would send the evaluator geometry the user cannot see.
 *
 * An adopted operand must reach EVERY list, not just the working one: the difference panel renders
 * only A and B, so one that landed in `working` alone would be invisible there -- unassignable, and
 * silently left out of the operation the user is looking at. It joins B, which is where
 * {@link seedMeshBooleanLists} puts everything after the first, so adding a shape mid-session
 * subtracts it, exactly as picking it before opening the tool would have.
 */
export function pruneMeshBooleanLists(
  lists: MeshBooleanLists,
  operands: readonly string[]
): MeshBooleanLists {
  const live = new Set(operands)
  const keep = (list: readonly string[]) => list.filter((entry) => live.has(entry))
  const adopted = (list: readonly string[]) => operands.filter((entry) => !list.includes(entry))
  const assigned = new Set([...lists.a, ...lists.b])
  return {
    working: [...keep(lists.working), ...adopted(lists.working)],
    a: keep(lists.a),
    // Already-assigned operands keep the side the user put them on; only genuinely new ones join B.
    b: [...keep(lists.b), ...adopted([...assigned])]
  }
}

/**
 * What an apply does to the operands themselves, as opposed to their geometry.
 *
 * `consumed` leave the plate; the helper volumes of everything in `carried` move onto the result;
 * the helper volumes of everything in `dropped` are lost with their object and the caller must say
 * so. An operand can be consumed without appearing in either list -- that is the whole point of the
 * split, since where a helper volume ENDS UP is not decided by whether its object survives.
 */
export interface MeshBooleanConsumptionPlan {
  consumed: string[]
  carried: string[]
  dropped: string[]
}

/**
 * Studio's own rules for who survives an apply and whose helper volumes follow the result.
 *
 * Ported from `prepare_job_data`'s collection block (`GLGizmoMeshBoolean.cpp:2200-2229`) and the
 * deletion block that runs after the job (`:2898-2917`). Three of them are easy to get wrong.
 *
 * **Difference always consumes A, even under "keep the originals"** (`:2899` "Difference: Always
 * delete A group objects"). A has BECOME the result, so keeping it would leave two solids in the
 * same place, one of them the shape the user just carved away from; the toggle protects B, which
 * the operation only read. Union and intersection consume the whole working list or nothing.
 *
 * **A helper volume follows its object only where that object is consumed.** Under "keep the
 * originals" the sources survive and keep their own volumes, so carrying a copy onto the result too
 * would duplicate every blocker in the project.
 *
 * **B's helper volumes are dropped rather than carried** (`:2211` "Skip B group volumes in Object
 * mode (they're never attached to result)"), which is right: they marked regions of the solid that
 * was subtracted, so on the remainder they would mark a hole. We follow Studio here but not in its
 * silence -- it deletes them with no warning, and this is the user's work going away, so `dropped`
 * exists for the caller to report exactly as the cut and split tools report theirs.
 *
 * With `solidPartsOnly` off nothing is carried or dropped: the helper geometry took part in the
 * boolean, so it is already IN the result rather than sitting beside it.
 */
export function planMeshBooleanConsumption(
  operation: MeshBooleanOperation,
  lists: MeshBooleanLists,
  options: { keepOriginals: boolean; solidPartsOnly: boolean }
): MeshBooleanConsumptionPlan {
  const consumed = operation === 'difference'
    ? [...lists.a, ...(options.keepOriginals ? [] : lists.b)]
    : (options.keepOriginals ? [] : [...lists.working])
  if (!options.solidPartsOnly) return { consumed, carried: [], dropped: [] }
  const consumedSet = new Set(consumed)
  return {
    consumed,
    carried: operation === 'difference'
      ? lists.a.filter((operand) => consumedSet.has(operand))
      : consumed,
    dropped: operation === 'difference' ? lists.b.filter((operand) => consumedSet.has(operand)) : []
  }
}

/**
 * One operand in PART mode, addressed the way the editor addresses that kind of part.
 *
 * A part is a part (see the the plugin development notes): both kinds are geometry the browser is already
 * holding, and the boolean reads triangles out of the render group either way. They differ only in
 * how they are NAMED -- a baked part by its base-file ordinal, a session-added volume by its own
 * key -- so the difference is confined to this codec and never reaches the lists, the panel, or the
 * evaluator, all of which see one opaque string per operand.
 */
export type MeshBooleanPartOperand =
  | { kind: 'baked'; partIndex: number }
  | { kind: 'added'; key: string }
  /**
   * The object's OWN geometry, which exists as an operand only where the object has no `parts` list
   * to describe it: a single-solid import (STL, primitive, cut half, assemble output, an earlier
   * boolean result) keeps its body on the instance's own mesh and reports `parts: []`. Without this
   * kind, part mode on such an object could only boolean its added volumes against each other and
   * would silently leave out the very body the user meant to cut.
   */
  | { kind: 'body' }

/** Encode a part operand as the opaque list key. */
export function meshBooleanPartOperandKey(operand: MeshBooleanPartOperand): string {
  if (operand.kind === 'body') return BODY_OPERAND_KEY
  return operand.kind === 'baked' ? `baked:${operand.partIndex}` : `added:${operand.key}`
}

/**
 * The body's list key. Separator-free on purpose: an added part's key is user data and could be the
 * literal string `body`, so a `body:` prefix would be forgeable, while nothing can encode to a bare
 * `body` except the body itself.
 */
const BODY_OPERAND_KEY = 'body'

/**
 * Decode a list key back to the part it names, or null when it is not a part key at all (an object
 * mode operand, which is a bare instance key).
 */
export function parseMeshBooleanPartOperand(key: string): MeshBooleanPartOperand | null {
  if (key === BODY_OPERAND_KEY) return { kind: 'body' }
  if (key.startsWith('baked:')) {
    const partIndex = Number(key.slice('baked:'.length))
    return Number.isFinite(partIndex) ? { kind: 'baked', partIndex } : null
  }
  // An added part's own key may contain anything, so take everything after the FIRST separator
  // rather than splitting: a key holding a colon would otherwise decode to a truncated id that
  // matches no volume, and the operand would silently contribute nothing.
  if (key.startsWith('added:')) {
    const addedKey = key.slice('added:'.length)
    return addedKey.length > 0 ? { kind: 'added', key: addedKey } : null
  }
  return null
}

/**
 * Which mode the tool opens in, mirroring `GLGizmoMeshBoolean::update_cur_mode`: several whole
 * objects boolean as OBJECTS, and anything else that qualifies booleans the PARTS inside one object.
 *
 * Studio decides this from its selection every frame. Ours decides it once on entry, because our
 * lists are seeded on entry too and a mode that flipped mid-session would silently reinterpret the
 * operands the user had already assigned.
 */
export function meshBooleanTargetMode(counts: { objects: number; partsInOneObject: number }): MeshBooleanTargetMode {
  if (counts.objects >= 2) return 'object'
  return counts.partsInOneObject >= 2 ? 'part' : 'object'
}

// The evaluation, re-exported so a caller needs only this module. It runs off the main thread; see
// `meshBooleanClient.ts` for the readiness handshake, the deadline, and the fallback.
export { evaluateMeshBoolean } from './meshBooleanClient'
// The closed-solid gate lives with the evaluation, not with the rules: it now WELDS the soup first
// (see its own doc), which is the same cost class as the boolean and belongs on the same thread.
export { isClosedSoup, MeshBooleanDataError, MeshBooleanOpenOperandError } from './meshBooleanCore'

/**
 * Whether an operand takes part in the evaluation, given the solid-parts toggle.
 *
 * Studio's `filter_volumes`: with the toggle on, a helper volume contributes no geometry, so it must
 * leave the OPERAND SET rather than reach the evaluator as an empty soup -- which the closed-solid
 * gate would then reject as an unrepairable open mesh, pointing the user at a repair that cannot
 * help. Object-mode operands are whole objects and always participate; only a part can be a helper.
 *
 * `subtype` is null for an operand whose kind carries none (an object, or a part that could not be
 * resolved), and those participate: refusing an operand we failed to classify would be a silent
 * omission, which is the failure mode this whole area is careful about.
 */
export function meshBooleanOperandParticipates(
  subtype: SceneEditPartSubtype | null,
  options: { solidPartsOnly: boolean; mode: MeshBooleanTargetMode }
): boolean {
  if (options.mode !== 'part' || !options.solidPartsOnly) return true
  return subtype == null || !isNonRenderableThreeMfPartSubtype(subtype)
}
