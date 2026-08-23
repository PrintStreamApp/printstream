/**
 * The sidecar entries addressed by an object's POSITION rather than its id, and the one place that
 * keeps them in step when the object set changes.
 *
 * OWNS the ordinal remap for `cut_information.xml`, `layer_config_ranges.xml` and
 * `layer_heights_profile.txt`. All three are keyed by a 1-based index over the PLACED root objects
 * in document order, which is the same ordinal space `brim_ear_points.txt` uses, and all three were
 * copied through a save verbatim. Delete an object and every later position shifts, so the entries
 * describe the wrong objects from that save onward.
 *
 * WHY IT MATTERS MORE THAN AN ORPHANED ENTRY. BambuStudio does not skip a stale record: it looks
 * cut info up by `object.second + 1` and then indexes `model_object->volumes[connector.volume_id]`
 * behind an assert that release builds compile out (and which is off-by-one regardless). A shifted
 * entry therefore lands its connectors on whichever object slid into that position, and writes out
 * of bounds when that object has fewer volumes. Cut connectors reappearing on unrelated geometry is
 * the visible half; the out-of-bounds write is the half with no symptom until it matters.
 *
 * CONTRACT, following `repairs/index.ts`: an entry whose object survived MOVES to the object's new
 * position, an entry whose object is gone is DROPPED, and an ordinal space we cannot read leaves the
 * document untouched rather than guessing. A guess here silently attaches a cut to the wrong model.
 * An unchanged object set returns the input byte for byte, so an ordinary save churns nothing.
 *
 * Counterpart: `parseRootModelObjectIdOrder` (`scene-parser.ts`) supplies both orders, and is the
 * same function the brim-ear ordinals are built from, so the two cannot drift apart.
 */

/**
 * Entries whose object references are 1-based ordinals over the placed root objects, and the shape
 * each one writes them in.
 *
 * All three are confirmed against the importer rather than inferred from their contents: it resolves
 * every one of them by `object.second + 1` over the same map, and says so at `bbs_3mf.cpp:2129`
 * ("indexed by a 1 based model object index"). Adding a fourth means confirming it there first, not
 * pattern-matching on an `id` attribute.
 */
export const OBJECT_ORDINAL_SIDECAR_ENTRIES: ReadonlyArray<{ path: string; format: 'xml' | 'profileText' }> = [
  { path: 'Metadata/cut_information.xml', format: 'xml' },
  { path: 'Metadata/layer_config_ranges.xml', format: 'xml' },
  { path: 'Metadata/layer_heights_profile.txt', format: 'profileText' }
]

/**
 * Rewrite one sidecar's object ordinals for a new object order.
 *
 * `oldOrder` and `newOrder` are placed root object IDS in document order, so an entry's ordinal is
 * its 1-based position in `oldOrder` and its new ordinal is that object's position in `newOrder`.
 * Returns the input unchanged when the order did not change, or when either order is unreadable.
 */
export function remapObjectOrdinalSidecar(
  content: string,
  oldOrder: readonly number[],
  newOrder: readonly number[],
  format: 'xml' | 'profileText' = 'xml'
): string {
  if (oldOrder.length === 0 || newOrder.length === 0) return content
  const sameOrder = oldOrder.length === newOrder.length && oldOrder.every((id, index) => id === newOrder[index])
  if (sameOrder) return content

  // old 1-based ordinal -> new 1-based ordinal, absent when that object no longer exists.
  const moved = new Map<number, number>()
  oldOrder.forEach((objectId, index) => {
    const next = newOrder.indexOf(objectId)
    if (next >= 0) moved.set(index + 1, next + 1)
  })

  return format === 'xml' ? remapXml(content, moved) : remapProfileText(content, moved)
}

/** `<object id="N"> … </object>` blocks: `cut_information.xml`, `layer_config_ranges.xml`. */
function remapXml(xml: string, moved: ReadonlyMap<number, number>): string {
  return xml.replace(/[ \t]*<object\b([^>]*)>[\s\S]*?<\/object>\n?/g, (block, attrs: string) => {
    const ordinal = Number.parseInt((attrs ?? '').match(/\bid="(\d+)"/)?.[1] ?? '', 10)
    if (!Number.isInteger(ordinal)) return block
    const next = moved.get(ordinal)
    // The object is gone. Dropping is the only truthful answer: renumbering would hand this
    // object's cut connectors or height ranges to whichever object took its place.
    if (next == null) return ''
    return next === ordinal ? block : block.replace(/(<object\b[^>]*\bid=")\d+(")/, `$1${next}$2`)
  })
}

/** One `object_id=N|<semicolon-separated profile>` per line: `layer_heights_profile.txt`. */
function remapProfileText(text: string, moved: ReadonlyMap<number, number>): string {
  const kept: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const ordinal = Number.parseInt(line.match(/^object_id=(\d+)\|/)?.[1] ?? '', 10)
    if (!Number.isInteger(ordinal)) {
      // A blank trailing line or anything we do not recognise rides through untouched.
      kept.push(line)
      continue
    }
    const next = moved.get(ordinal)
    if (next == null) continue
    kept.push(next === ordinal ? line : line.replace(/^object_id=\d+\|/, `object_id=${next}|`))
  }
  return kept.join('\n')
}
