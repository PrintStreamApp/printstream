/**
 * Per-object PROCESS overrides, written into `model_settings.config`.
 *
 * These ride the save/slice REQUEST rather than the `SceneEdit` (they are keyed by baked
 * `object_id`, which only exists after the bake resolves imports and clones), so they are applied
 * as a transform over the settings entry the bake produced.
 *
 * Shared because both surfaces need it: the api applies it as a second pass while preparing a slice,
 * and the browser composes it into its single bake when saving a local file.
 */
import { isProcessSettingKey } from '../process-settings.js'
import { decodeXmlAttributeValue, escapeXmlAttribute } from './xml-write.js'

/** Per-object process settings, keyed by baked `object_id` as a string. */
export type ObjectProcessOverrides = Record<string, Record<string, string | string[]>>

/**
 * Read the per-object process overrides out of ONE `<object>` block's head: the metadata before
 * its first `<part>`.
 *
 * The read half of {@link applyObjectProcessOverridesXml}, kept beside it so the two cannot drift:
 * anything this fails to recognise is an override a round-trip silently drops. Both the index
 * parser (so a surface that never loads the scene can still show and re-send them) and the scene
 * parser (so the editor re-seeds its per-object gear) go through here.
 *
 * Scoped to the HEAD deliberately: a `<part>` carries its own metadata of the same keys, and
 * reading the whole block would attribute a part's setting to its object.
 *
 * Allowlisted to real process keys, because an object's head also carries identity and placement
 * metadata (`name`, `extruder`, `source_object_id`, `matrix`, …) that is emphatically not a
 * process override: treating it as one would write junk back on the next save.
 */
export function readObjectProcessOverridesFromHead(objectHead: string): Record<string, string> {
  const overrides: Record<string, string> = {}
  for (const meta of objectHead.matchAll(/<metadata\s+key="([^"]+)"\s+value="([^"]*)"\s*\/>/g)) {
    const key = meta[1]
    const value = meta[2]
    if (key == null || value == null || !isProcessSettingKey(key)) continue
    overrides[key] = decodeXmlAttributeValue(value)
  }
  return overrides
}

/** The metadata region of an `<object>` block that belongs to the object itself, not to a part. */
export function objectHeadOf(objectBlock: string): string {
  const firstPart = objectBlock.search(/<part\b/)
  return firstPart >= 0 ? objectBlock.slice(0, firstPart) : objectBlock
}

/**
 * Sets each object's per-object process overrides in `model_settings.config`. For every object in
 * `overridesByObjectId`, the object's HEAD metadata (before its first `<part>`) has its existing
 * NON-structural metadata removed and the desired override set injected. Scoping to the head means
 * a part's per-volume `<metadata>` of the same key is never clobbered; replacing the whole override
 * set (rather than only the supplied keys) means an override the user CLEARED is actually removed,
 * not left behind. An empty override map for an object therefore clears all its object-level
 * overrides. Objects not listed (and all non-object blocks) are left untouched.
 */
export function applyObjectProcessOverridesXml(xml: string, overridesByObjectId: ObjectProcessOverrides): string {
  return xml.replace(/<object\b([^>]*)>([\s\S]*?)<\/object>/g, (full, attrs: string, body: string) => {
    const objectId = Number.parseInt(/(?:^|\s)id="(\d+)"/.exec(attrs)?.[1] ?? '', 10)
    const overrides = overridesByObjectId[String(objectId)]
    if (!Number.isInteger(objectId) || !overrides) return full
    const firstPart = body.search(/<part\b/)
    const head = firstPart >= 0 ? body.slice(0, firstPart) : body
    const tail = firstPart >= 0 ? body.slice(firstPart) : ''
    // Drop existing object-level PROCESS overrides only; keep all other object-head metadata.
    const strippedHead = head.replace(/[ \t]*<metadata\s+key="([^"]+)"\s+value="[^"]*"\s*\/>\n?/g, (line, key: string) =>
      isProcessSettingKey(key) ? '' : line)
    const injected = Object.entries(overrides).map(([key, value]) => {
      const serialized = Array.isArray(value) ? value.join(';') : value
      return `\n    <metadata key="${escapeXmlAttribute(key)}" value="${escapeXmlAttribute(serialized)}"/>`
    }).join('')
    return `<object${attrs}>${injected}${strippedHead}${tail}</object>`
  })
}

/**
 * Move per-object overrides from the ids the REQUEST used onto the ids the bake actually wrote.
 *
 * Overrides are keyed by baked `object_id`, but a replaced object or an independent copy is
 * addressed by an identity that does not exist in the file yet, a retained original id or a
 * negative placeholder, and only the bake knows what it became. Anything not listed is left
 * alone, so this is safe to run over a whole override set.
 *
 * Idempotent: re-running it after the keys have moved is a no-op, because the original key is gone.
 */
export function rekeyObjectProcessOverrides(
  overrides: ObjectProcessOverrides,
  moved: ReadonlyArray<{ originalObjectId: number; bakedObjectId: number }>
): ObjectProcessOverrides {
  if (moved.length === 0) return overrides
  const next: ObjectProcessOverrides = { ...overrides }
  for (const { originalObjectId, bakedObjectId } of moved) {
    const originalKey = String(originalObjectId)
    const original = next[originalKey]
    if (!original) continue
    const bakedKey = String(bakedObjectId)
    next[bakedKey] = { ...next[bakedKey], ...original }
    if (bakedKey !== originalKey) delete next[originalKey]
  }
  return next
}
