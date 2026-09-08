/**
 * The sidecar entries addressed by an object's POSITION rather than its id, and the one place that
 * keeps them in step when the object set changes.
 *
 * OWNS the ordinal remap for `cut_information.xml`, `layer_config_ranges.xml`,
 * `layer_heights_profile.txt` and `brim_ear_points.txt`. All four are keyed by a 1-based index over
 * the PLACED root objects in BUILD-ITEM order (see `parseRootModelObjectIdOrder`) and were copied
 * through a save verbatim. Delete or REORDER an object and every later position shifts, so the
 * entries describe the wrong objects from that save onward.
 *
 * Three of the four are also AUTHORED, and the caller skips the remap for whichever the save
 * authored: an authored file already speaks the saved ordinals, so remapping it would renumber
 * correct content. "Authored" is per SAVE, not per feature -- brim ears are authored only when the
 * session touched an ear, so most saves stream them, which is why leaving them off this list moved
 * an object's ears onto another model the first time anything reordered.
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
 * All four are confirmed against the importer rather than inferred from their contents: it resolves
 * every one of them by `object.second + 1` over the same map, and says so at `bbs_3mf.cpp:2129`
 * ("indexed by a 1 based model object index"). Adding a fifth means confirming it there first, not
 * pattern-matching on an `id` attribute.
 */
export const OBJECT_ORDINAL_SIDECAR_ENTRIES: ReadonlyArray<{
  path: string
  format: 'xml' | 'profileText'
  /** True when the entry ALSO names volumes inside an object, which a part reorder permutes. */
  volumeScoped?: boolean
}> = [
  { path: 'Metadata/cut_information.xml', format: 'xml', volumeScoped: true },
  { path: 'Metadata/layer_config_ranges.xml', format: 'xml' },
  { path: 'Metadata/layer_heights_profile.txt', format: 'profileText' },
  // Brim ears are AUTHORED whenever the session touched an ear, and the caller skips the remap in
  // that case exactly as it does for the two above. They are listed here for the other case, which
  // is every save that did not: the file then streams through, and an object reorder or delete
  // permutes the ordinals under it. Leaving it off the list is what moved an object's ears onto a
  // different model on the first reorder-only save.
  { path: 'Metadata/brim_ear_points.txt', format: 'profileText' }
]

/**
 * Rewrite one sidecar's object ordinals for a new object order.
 *
 * `oldOrder` and `newOrder` are placed root object IDS in build-item order, so an entry's ordinal is
 * its 1-based position in `oldOrder` and its new ordinal is that object's position in `newOrder`.
 * Returns the input unchanged when the order did not change, or when either order is unreadable.
 */
export function remapObjectOrdinalSidecar(
  content: string,
  oldOrder: readonly number[],
  newOrder: readonly number[],
  format: 'xml' | 'profileText' = 'xml',
  /**
   * Per-object VOLUME permutations (base ordinals in their new order), keyed by object id, for a
   * sidecar that also names volumes. Only `cut_information.xml` does.
   */
  volumeLayouts?: ReadonlyMap<number, readonly number[]>
): string {
  if (oldOrder.length === 0 || newOrder.length === 0) return content
  const sameObjects = oldOrder.length === newOrder.length && oldOrder.every((id, index) => id === newOrder[index])
  // The object order can be untouched while a VOLUME order is not: reordering the parts inside one
  // object moves no object at all. Returning early on the object check alone is what left the
  // connectors behind.
  if (sameObjects && (!volumeLayouts || volumeLayouts.size === 0)) return content

  // old 1-based ordinal -> new 1-based ordinal, absent when that object no longer exists.
  const moved = new Map<number, number>()
  oldOrder.forEach((objectId, index) => {
    const next = newOrder.indexOf(objectId)
    if (next >= 0) moved.set(index + 1, next + 1)
  })
  if (format === 'profileText') return remapProfileText(content, moved)

  // An entry's `<object id>` is an ordinal in the OLD order, so that is the space the volume
  // layouts are looked up through.
  const volumeRemapForOrdinal = volumeLayouts && volumeLayouts.size > 0
    ? (ordinal: number): ReadonlyMap<number, number> | undefined => {
      const objectId = oldOrder[ordinal - 1]
      const layout = objectId == null ? undefined : volumeLayouts.get(objectId)
      if (!layout) return undefined
      const byVolume = new Map<number, number>()
      layout.forEach((oldVolume, index) => byVolume.set(oldVolume, index))
      return byVolume
    }
    : undefined
  return remapXml(content, moved, volumeRemapForOrdinal)
}

/** `<object id="N"> … </object>` blocks: `cut_information.xml`, `layer_config_ranges.xml`. */
function remapXml(
  xml: string,
  moved: ReadonlyMap<number, number>,
  volumeRemapForOrdinal?: (ordinal: number) => ReadonlyMap<number, number> | undefined
): string {
  return xml.replace(/[ \t]*<object\b([^>]*)>[\s\S]*?<\/object>\n?/g, (block, attrs: string) => {
    const ordinal = Number.parseInt((attrs ?? '').match(/\bid="(\d+)"/)?.[1] ?? '', 10)
    if (!Number.isInteger(ordinal)) return block
    const next = moved.get(ordinal)
    // The object is gone. Dropping is the only truthful answer: renumbering would hand this
    // object's cut connectors or height ranges to whichever object took its place.
    if (next == null) return ''
    const volumeRemap = volumeRemapForOrdinal?.(ordinal)
    const withVolumes = volumeRemap ? remapConnectorVolumes(block, volumeRemap) : block
    return next === ordinal ? withVolumes : withVolumes.replace(/(<object\b[^>]*\bid=")\d+(")/, `$1${next}$2`)
  })
}

/**
 * Rewrite one `cut_information.xml` object block's `<connector volume_id>`s for a new volume order.
 *
 * A connector names a VOLUME by its ordinal inside the object, which a part removal or reorder
 * permutes; this is a different index from the object ordinal `remapXml` handles, in the same file.
 * BambuStudio indexes it as `model_object->volumes[connector.volume_id]` with the only bounds check
 * being an assert that release builds compile out (and which is written `<=`), so a stale entry is a
 * connector on the wrong volume at best and an out-of-bounds write at worst.
 *
 * A connector whose volume was REMOVED is dropped, matching how a stale object entry is dropped
 * rather than renumbered onto a survivor.
 *
 * `connectors_cnt` is deliberately LEFT ALONE, though it sits on the same element and reads like a
 * count of the list below it. It is not one: BambuStudio writes it from `cut_id.connectors_cnt()`,
 * a cumulative counter incremented once per cut and shared by every half of a cut group, and
 * `CutObjectBase::is_equal` compares it alongside the id and check sum to decide whether two
 * objects came from the same cut. That is how "delete all connectors" finds an object's siblings.
 * So the two numbers legitimately diverge, and correcting one to match the list we happen to see
 * desynchronises this half from its sibling -- on a pure reorder, with nothing removed at all.
 */
function remapConnectorVolumes(block: string, volumeRemap: ReadonlyMap<number, number>): string {
  // Both spellings: BambuStudio writes `<connector .../>`, but a hand-edited or foreign file may
  // use an explicit close, and matching only the self-closing form would leave those volume ids
  // stale.
  return block.replace(/[ \t]*<connector\b([^>]*?)(?:\/>|>[\s\S]*?<\/connector>)\n?/g, (connector, attrs: string) => {
    const volumeId = Number.parseInt((attrs ?? '').match(/\bvolume_id="(\d+)"/)?.[1] ?? '', 10)
    if (!Number.isInteger(volumeId)) return connector
    const next = volumeRemap.get(volumeId)
    if (next == null) return ''
    return next === volumeId ? connector : connector.replace(/(\bvolume_id=")\d+(")/, `$1${next}$2`)
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
