/**
 * The identity questions every `buildSceneEdit` collector has to answer, asked once.
 *
 * OWNS the three derivations the collectors kept re-deriving inline: which baked objects are
 * actually placed, which import carries a replaced object's identity, and how a per-part key
 * decomposes. Audit finding F6, the same rule encoded N times, counted the placed-object set
 * rebuilt in 8 places and the synthetic-import map in 7.
 *
 * WHY it matters beyond tidiness: these are the gates that decide whether an edit SURVIVES the
 * bake. A collector that builds the set slightly differently does not fail loudly, it accepts the
 * user's edit and then silently drops it, which is shape (2) of the "no feature may require a save
 * first" trap documented in this plugin'the s development notes. One definition means a fix reaches every
 * collector at once, and a new collector inherits the right behaviour by construction.
 *
 * Every helper is pure and takes the whole `EditorState`, so callers cannot accidentally scope the
 * question to one plate: the edits these gate are project-wide.
 */
import type { EditorState } from './editorModel'

/**
 * Baked `object_id`s that are actually placed on some plate.
 *
 * The membership test for anything addressed by a real object id (paint, per-part transforms,
 * per-object overrides). An id absent from here refers to an object the save will not write, so an
 * edit against it must be dropped rather than emitted against a dangling id.
 *
 * Deliberately excludes import-backed instances even when they carry a `replacedObjectId`: that id
 * is the identity being REPLACED, resolved server-side at bake time, and is not a placed object in
 * this state. Use {@link importIdByReplacedObjectId} for those.
 */
export function placedObjectIds(state: EditorState): Set<number> {
  const ids = new Set<number>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind === 'object') ids.add(instance.objectId)
    }
  }
  return ids
}

/**
 * Replaced object id -> the `importId` whose staged geometry now stands in for it.
 *
 * "Replace object" keeps the original object's identity so its per-object settings follow the new
 * mesh, but the geometry is an import until the bake resolves it. A collector addressing such an
 * object by id must emit against the IMPORT instead, or the edit lands on an object the save is
 * about to replace.
 */
export function importIdByReplacedObjectId(state: EditorState): Map<number, string> {
  const byObjectId = new Map<number, string>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind === 'import' && instance.source.replacedObjectId != null) {
        byObjectId.set(instance.source.replacedObjectId, instance.source.importId)
      }
    }
  }
  return byObjectId
}

/** A per-part map key decomposed into the pair that addresses one part of one object. */
export interface PartPaintKeyParts {
  objectId: number
  componentObjectId: number
}

/**
 * Parse a `"<objectId>:<componentObjectId>"` per-part key, or null when it is not one.
 *
 * Returns null rather than throwing or coercing: these keys come from persisted session state, and
 * a malformed one should drop its entry quietly instead of emitting an edit against `NaN`.
 */
export function parsePartPaintKey(key: string): PartPaintKeyParts | null {
  const [objectIdRaw, componentRaw] = key.split(':')
  const objectId = Number.parseInt(objectIdRaw ?? '', 10)
  const componentObjectId = Number.parseInt(componentRaw ?? '', 10)
  if (!Number.isInteger(objectId) || !Number.isInteger(componentObjectId)) return null
  return { objectId, componentObjectId }
}

/** Build the `"<objectId>:<componentObjectId>"` key {@link parsePartPaintKey} reads. */
export function partPaintKey(objectId: number, componentObjectId: number): string {
  return `${objectId}:${componentObjectId}`
}

/**
 * Object identities that can CARRY per-object settings: the placed objects, plus the retained
 * identity of every replaced object.
 *
 * Deliberately a superset of {@link placedObjectIds}, and the difference is load-bearing. "Replace
 * object" keeps the original object's identity precisely so its per-object process settings follow
 * the new mesh, so an override keyed by that id is still live even though no placed instance has
 * `kind === 'object'` for it. Gating overrides on `placedObjectIds` would silently discard the
 * settings of every replaced object.
 *
 * The two are separate functions rather than one flag because they answer different questions:
 * "does the save write this object?" (geometry-addressed edits) versus "can this identity hold
 * settings?" (request-addressed edits). Merging them would reintroduce the bug each avoids.
 */
export function objectIdsAcceptingOverrides(state: Pick<EditorState, 'plates'>): Set<number> {
  const ids = new Set<number>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind === 'object') ids.add(instance.objectId)
      else if (instance.source.replacedObjectId != null) ids.add(instance.source.replacedObjectId)
    }
  }
  return ids
}

/**
 * The per-object process overrides a save should carry, from the session map and the set of
 * identities that can hold them.
 *
 * ABSENCE IS NOT A DELETE. `sessionOverrides` holds only the objects currently in scope, the slice
 * dialog reseeds it from the ACTIVE PLATE's baked overrides, so an object on another plate is
 * missing for a reason that has nothing to do with the user's intent. Inferring a clear from
 * absence is what silently erased other plates' per-object settings, one plate per save, until the
 * project had none left. A real clear is an EXPLICIT empty entry (the per-object dialog's onApply
 * writes one), which passes through as `{}` and correctly strips the baked overrides; anything
 * absent is simply not mentioned, and the bake leaves objects it is not given alone.
 *
 * Returns undefined when nothing is to be said, so the save omits the field rather than sending an
 * empty map, which the bake would read as "no object has overrides".
 */
export function selectObjectProcessOverridesForSave(
  sessionOverrides: Record<string, Record<string, string | string[]>> | undefined,
  acceptingIds: ReadonlySet<number>
): Record<string, Record<string, string | string[]>> | undefined {
  if (!sessionOverrides) return undefined
  const out: Record<string, Record<string, string | string[]>> = {}
  for (const [key, overrides] of Object.entries(sessionOverrides)) {
    // Prunes objects that no longer exist: an id nothing accepts cannot be addressed by the bake.
    if (acceptingIds.has(Number(key))) out[key] = overrides
  }
  return Object.keys(out).length > 0 ? out : undefined
}
