/**
 * The plate-keyed records that must follow the plates: what survives on a re-rendered `<plate>`
 * block, and how `slice_info.config`'s plate numbers are kept in step.
 *
 * OWNS the per-plate key policy. `renderArrangedModelSettingsPlates` builds each plate block from
 * the `SceneEdit`, and `replaceModelSettingsPlates` deletes every source block before inserting
 * them, so any key the edit cannot express was silently discarded on EVERY save and every slice.
 * Our plate model carries four fields; BambuStudio's own writer emits nineteen
 * (`bbs_3mf.cpp:8082-8194`), and its importer reads all of them (`:4457-4655`).
 *
 * WHAT THAT COST. These are not cosmetic. `print_sequence` is per-plate print-by-object,
 * `spiral_mode` is vase mode, `bed_type` is the plate's own build surface (and therefore its
 * first-layer temperature), `filament_maps` is a hand-pinned filament-to-nozzle grouping on a
 * dual-nozzle machine. Losing them does not fail a slice, it slices something the user did not ask
 * for: a vase-mode plate comes out solid, a by-object plate comes out by-layer.
 *
 * THE SPLIT, and why it is where it is. This is an ALLOW-LIST, deliberately: carrying anything
 * unrecognised was tried and is wrong for THIS document, because a plate block is engine-
 * authoritative config that BambuStudio applies OVER the project-global values we author
 * (`BambuStudio.cpp:6866` applies the plate config on top of the loaded settings). An unknown key
 * here is not inert data, it is a per-plate override that can silently beat the user's own choice.
 *
 *  - CARRIED: settings the user made that we never author and that no edit invalidates. `locked`,
 *    `print_sequence` (per-plate print-by-object) and `spiral_mode` (vase mode).
 *  - FILAMENT-SCOPED: carried only while the filament list is untouched, because their values are
 *    filament INDICES. `filament_maps` / `filament_volume_maps` are the nozzle grouping;
 *    `filament_map_mode` goes with them or a plate is pinned to Manual with no map, which makes the
 *    engine fall back to the project-global map rather than to auto (`PartPlate.cpp:266-289`); and
 *    the print-sequence lists hold filament ids as their VALUES, which is why the project-level copy
 *    of the same key is re-keyed value-wise rather than remapped positionally.
 *  - NEVER CARRIED: `bed_type`, because we author the plate type as the project-global
 *    `curr_bed_type` and the engine prefers a plate's own value over it (`PartPlate.cpp:619-625`),
 *    so carrying a stale one silently outlives the user's Settings-tab change. `plater_id` and
 *    `plater_name` are ours to write. The slice-OUTPUT pointers (`gcode_file` and the thumbnails)
 *    name a slice we cannot tell we invalidated, so claiming a stale one is worse than claiming
 *    none, which is the same reasoning that drops `slice_info`.
 */

/**
 * Settings the user chose that we never author and that an arrangement edit cannot invalidate.
 * An allow-list: see the module header for why an unknown key here is not safe to carry.
 */
const CARRIED_PLATE_KEYS: ReadonlySet<string> = new Set(['locked', 'print_sequence', 'spiral_mode'])

/**
 * Carried only while the filament list is untouched, because their VALUES are filament indices.
 * `filament_map_mode` belongs here even though it holds no index itself: without its map a plate
 * pinned to Manual falls back to the project-global map rather than to auto.
 */
const FILAMENT_SCOPED_PLATE_KEYS: ReadonlySet<string> = new Set([
  'filament_maps',
  'filament_volume_maps',
  'filament_map_mode',
  'first_layer_print_sequence',
  'other_layers_print_sequence',
  'other_layers_print_sequence_nums'
])

/** One `<metadata key value/>` child of a `<plate>`, as it appeared in the source. */
export interface PlateMetadataEntry {
  key: string
  /** The RAW attribute text, still XML-escaped, so a round trip cannot change it. */
  rawValue: string
}

/**
 * The source file's plate blocks, keyed by `plater_id`.
 *
 * Keyed by the id rather than by document position because the two disagree the moment a plate is
 * reordered, and attaching one plate's bed type to another is exactly the class of bug this module
 * exists to stop.
 */
export function parseSourcePlateMetadata(modelSettingsXml: string): Map<number, PlateMetadataEntry[]> {
  const byPlate = new Map<number, PlateMetadataEntry[]>()
  for (const block of modelSettingsXml.matchAll(/<plate\b[^>]*>([\s\S]*?)<\/plate>/g)) {
    const body = block[1] ?? ''
    // Only the plate's OWN children: a `<model_instance>` carries `object_id` and friends, which
    // are instance keys and are re-authored per instance.
    const own = body.replace(/<model_instance\b[\s\S]*?<\/model_instance>/g, '')
    const entries: PlateMetadataEntry[] = []
    let plateId: number | null = null
    for (const meta of own.matchAll(/<metadata\s+key="([^"]+)"\s+value="([^"]*)"\s*\/>/g)) {
      const key = meta[1] ?? ''
      const rawValue = meta[2] ?? ''
      if (key === 'plater_id') plateId = Number.parseInt(rawValue, 10)
      entries.push({ key, rawValue })
    }
    if (plateId != null && Number.isInteger(plateId)) byPlate.set(plateId, entries)
  }
  return byPlate
}

/**
 * The entries to re-emit for one plate, in source order.
 *
 * `filamentSetStable` false drops the filament-scoped keys; see the module header for why they are
 * not re-keyed instead.
 */
export function preservedPlateMetadata(
  entries: readonly PlateMetadataEntry[] | undefined,
  filamentSetStable: boolean
): PlateMetadataEntry[] {
  if (!entries) return []
  return entries.filter((entry) => {
    if (CARRIED_PLATE_KEYS.has(entry.key)) return true
    if (FILAMENT_SCOPED_PLATE_KEYS.has(entry.key)) return filamentSetStable
    return false
  })
}

/**
 * Rewrite `slice_info.config`'s plate numbers for a new plate order, dropping records whose plate is
 * gone. Returns null when the mapping is unknown, so the caller can decide.
 *
 * `slice_info` is a SEPARATE document keyed by the same plate numbers `model_settings` uses: the
 * importer builds its plate map from `plater_id` and then looks each slice record up by its `index`
 * (`bbs_3mf.cpp:4593-4599`). The two are renumbered independently today, because the plate blocks
 * are re-rendered from the edit while `slice_info` is copied through verbatim.
 *
 * The failure is misattribution, not absence, which is why it went unnoticed. Delete plate 1 of
 * three and the remaining plates renumber to 1 and 2, while the records still say 1, 2 and 3: plate
 * 1 now reports the deleted plate's weight and print time, plate 2 reports plate 1's, and record 3
 * matches nothing. A pure REORDER is worse still, since every record resolves and the plates simply
 * swap each other's estimates with no miss anywhere. A record that matches nothing also aborts the
 * rest of the slice_info parse (`:4766-4773` returns false), so later plates lose their data too.
 *
 * `plateMap` is source plate number -> saved plate number.
 */
export function remapSliceInfoPlates(xml: string, plateMap: ReadonlyMap<number, number>): string {
  return xml.replace(/[ \t]*<plate\b[^>]*>[\s\S]*?<\/plate>\n?/g, (block) => {
    const index = Number.parseInt(/<metadata\s+key="index"\s+value="(\d+)"\s*\/>/.exec(block)?.[1] ?? '', 10)
    if (!Number.isInteger(index)) return block
    const next = plateMap.get(index)
    // The plate is gone. Dropping is the only truthful answer: renumbering would hand this plate's
    // usage and estimates to whichever plate took its place.
    if (next == null) return ''
    return next === index
      ? block
      : block.replace(/(<metadata\s+key="index"\s+value=")\d+(")/, `$1${next}$2`)
  })
}

/**
 * Source plate number -> saved plate number, or null when the edit does not say.
 *
 * Only plates that name a `sourceIndex` contribute: a session-added plate has no source record to
 * carry, and an edit where NO plate names one (an older client, a hand-built request) cannot be
 * mapped at all. Null there rather than a guess, because the identity mapping it would otherwise
 * imply is exactly the wrong answer for the reorder case.
 */
export function sourcePlateMapping(
  plates: ReadonlyArray<{ index: number; sourceIndex?: number | null }>
): Map<number, number> | null {
  const mapping = new Map<number, number>()
  let named = false
  for (const plate of plates) {
    if (plate.sourceIndex == null) continue
    named = true
    if (!mapping.has(plate.sourceIndex)) mapping.set(plate.sourceIndex, plate.index)
  }
  return named ? mapping : null
}
