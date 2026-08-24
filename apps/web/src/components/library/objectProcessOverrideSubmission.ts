/**
 * What the prepare-print dialog sends as per-object PROCESS overrides: what the FILE already
 * carries, and which of the session's entries genuinely differ from it.
 *
 * OWNS two rules that the slice-time transform makes dangerous to get wrong. That transform
 * (`applyObjectProcessOverridesXml`) is authoritative PER OBJECT: for every object it is handed it
 * deletes the object's whole existing override set and writes back exactly what it was given. So a
 * map that is partial, stale, or scoped to the wrong plate does not merge, it DELETES.
 *
 * Rule 1: the baseline spans EVERY plate. It used to be built from the selected plate's objects
 * only, while the session map accumulates entries for every plate the user visits, so an object
 * from another plate compared against a baseline that never covered it and read as "changed" on
 * every slice. Harmless in what it wrote (the same values back) but it forced the rewrite branch on
 * slices nobody had customised, which the code claimed to avoid.
 *
 * Rule 2: a CLEARED object is an explicit empty entry and must be SENT; only ABSENCE means
 * untouched. Deleting the key instead is what made "clear this object's settings" do nothing: the
 * key vanished from the map, so nothing was sent, so the transform never ran and the file kept the
 * values. The editor's own per-object dialog already encodes this (see the `applyBulkOverridesToMember`
 * call in `EditorView`); this is the same rule, which is why it lives in one testable place now
 * rather than being written out twice and drifting again.
 *
 * Counterpart on the server: `applyObjectProcessOverridesXml` in `@printstream/shared/three-mf`,
 * plus the bake's inheritance for a REPLACED object, which addresses the case where the object the
 * overrides belong to no longer exists under its old id.
 */
import type { BridgeLibraryThreeMfObject } from '@printstream/shared'

/** Per-object process overrides keyed by Bambu `object_id` as a string, as the wire carries them. */
export type ObjectProcessOverrideMap = Record<string, Record<string, string | string[]>>

/** A plate as the baked index reports it: only its object list matters here. */
export interface PlateObjects {
  objects?: ReadonlyArray<Pick<BridgeLibraryThreeMfObject, 'id' | 'processOverrides'>>
}

/**
 * The per-object overrides the FILE carries, across every plate.
 *
 * Objects with no overrides are omitted rather than given an empty entry, so the result reads the
 * same as an untouched session map and an ordinary slice sends nothing.
 */
export function bakedObjectProcessOverrides(
  plates: ReadonlyArray<PlateObjects>
): ObjectProcessOverrideMap {
  const out: ObjectProcessOverrideMap = {}
  for (const plate of plates) {
    for (const object of plate.objects ?? []) {
      const overrides = object.processOverrides
      if (overrides && Object.keys(overrides).length > 0) out[String(object.id)] = { ...overrides }
    }
  }
  return out
}

/**
 * The subset of `session` worth sending: every object whose overrides differ from `baked`.
 *
 * Returns undefined when nothing differs, which is what keeps an ordinary slice out of the
 * object-customization rewrite entirely. An entry present in `session` but EMPTY differs from a
 * non-empty baked entry and is therefore sent, which is how a clear reaches the file; an object
 * absent from `session` is never sent, so an override the user never opened is left alone.
 */
export function changedObjectProcessOverrides(
  session: ObjectProcessOverrideMap,
  baked: ObjectProcessOverrideMap
): ObjectProcessOverrideMap | undefined {
  const entries = Object.entries(session).filter(([objectId, overrides]) =>
    !sameOverrides(overrides, baked[objectId] ?? {}))
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/**
 * Do two override sets mean the same thing?
 *
 * Key-by-key rather than by serializing both, because `JSON.stringify` is ORDER-SENSITIVE: the
 * baked set comes out of the file in document order and a session set is rebuilt by the settings
 * dialog, so two identical sets written in different orders compared as "changed" and sent an
 * object into the rewrite for no reason. Array values (a vector setting) are compared element-wise
 * for the same reason.
 */
function sameOverrides(
  a: Record<string, string | string[]>,
  b: Record<string, string | string[]>
): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => {
    const left = a[key]
    const right = b[key]
    if (Array.isArray(left) || Array.isArray(right)) {
      const leftArray = Array.isArray(left) ? left : [left ?? '']
      const rightArray = Array.isArray(right) ? right : [right ?? '']
      return leftArray.length === rightArray.length && leftArray.every((value, index) => value === rightArray[index])
    }
    return left === right
  })
}
