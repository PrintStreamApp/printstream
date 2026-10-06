/**
 * Existing-part edits for the shared 3MF bake.
 * Every part-scoped edit addresses the source component ordinal. Filament,
 * process, type, and transform changes run before layout/removal so an edit
 * cannot drift to a different volume when the component order changes.
 */
import { isProcessSettingKey } from '../process-settings.js'
import { setObjectLevelExtruderMetadata, sharedCarryingPartExtruderOfBlock } from '../repairs/object-extruder.js'
import type {
  SceneEditPartFilament,
  SceneEditPartProcessOverride,
  SceneEditPartTransform,
  SceneEditRemovedPart,
  SceneEditPartOrder,
  SceneEditPartTypeChange
} from '../slicing.js'
import { parseAttrs } from './index-parser.js'
import { escapeXmlAttribute } from './xml-write.js'
import { formatThreeMfTransformValue } from './bake-xml-format.js'
import { buildFilamentToExtruderMap } from './filament-slot-remap.js'

/** Rewrite (or insert) a `<part>`'s `extruder` metadata to a new slot. */
function setPartExtruderMetadata(partBlock: string, extruder: number): string {
  const metadata = `<metadata key="extruder" value="${extruder}"/>`
  if (/<metadata\s+key="extruder"\s+value="[^"]*"\s*\/>/.test(partBlock)) {
    return partBlock.replace(/<metadata\s+key="extruder"\s+value="[^"]*"\s*\/>/, metadata)
  }
  return partBlock.replace(/<\/part>/, `  ${metadata}\n    </part>`)
}

/**
 * Each object's `<component objectid>` sequence, which IS its volume list: the ordinal every
 * part-scoped edit addresses is a position in THIS list, because that is the list the scene parser
 * walks when it mints them (`scene-parser.ts` pairs each component with its `<part>` metadata by
 * mesh id, not by position).
 */
export function parseObjectComponentIds(modelXml: string): Map<number, number[]> {
  const byObject = new Map<number, number[]>()
  for (const match of modelXml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const objectId = Number.parseInt(parseAttrs(match[1] ?? '').id ?? '', 10)
    if (!Number.isInteger(objectId)) continue
    const ids: number[] = []
    for (const component of (match[2] ?? '').matchAll(/<component\b[^>]*\bobjectid="(\d+)"/gi)) {
      const id = Number.parseInt(component[1] ?? '', 10)
      if (Number.isInteger(id)) ids.push(id)
    }
    byObject.set(objectId, ids)
  }
  return byObject
}

/**
 * The index of the `<part>` block describing the volume at `ordinal`, or null when none does.
 *
 * Ports BambuStudio's own read rule (`_generate_volumes_new`): it loops an object's COMPONENTS and
 * looks each one's metadata up in the `<part>` list POSITIONALLY, guarded by an id check
 * (`index < volumes.size() && volumes[index].subobject_id == sub_object->id`), falling back to a
 * linear id search and then to defaults. Our writers only had the positional half, so they assumed
 * the two lists are a mirror. They usually are, and nothing anywhere asserted it: a file whose
 * `<part>` order differs (a foreign export, or an object `applyPartLayout` deliberately left
 * un-permuted because the lists were different lengths) silently landed every per-part material,
 * subtype, override and matrix on the WRONG volume, and each later save re-applied the same skew.
 *
 * Positional must win WHERE IT AGREES, which is why the id check comes before the search:
 * BambuStudio writes one id for every volume sharing a mesh (`m_share_mesh`), so an object can hold
 * four parts with the same id, and an id-first lookup would collapse all four onto the first.
 *
 * Null means no `<part>` describes that volume: the caller SKIPS it rather than writing onto an
 * unrelated block, which is the whole point. BambuStudio reads such a volume with default settings,
 * so skipping matches what the engine already does with the file.
 */
export function resolvePartBlockIndex(
  ordinal: number,
  componentObjectIds: readonly number[] | undefined,
  partIds: ReadonlyArray<number | null>
): number | null {
  // An object whose mesh is INLINE declares no components, so its `<part>` list is the volume list.
  if (!componentObjectIds || componentObjectIds.length === 0) return ordinal
  const wanted = componentObjectIds[ordinal]
  if (wanted == null) return null
  if (partIds[ordinal] === wanted) return ordinal
  const found = partIds.indexOf(wanted)
  return found >= 0 ? found : null
}

/** The `id` of each `<part>` in one object block, in document order; null where unreadable. */
function parsePartIds(objectBlock: string): Array<number | null> {
  return [...objectBlock.matchAll(/<part\b([^>]*)>/g)].map((match) => {
    const id = Number.parseInt(parseAttrs(match[1] ?? '').id ?? '', 10)
    return Number.isInteger(id) ? id : null
  })
}

/**
 * Re-key one object's ordinal-addressed edits onto the `<part>` BLOCK INDEX each one describes.
 *
 * Every part-scoped applier below walks the object's `<part>` blocks with a running counter, so
 * handing it this map (instead of the raw ordinals) is the whole fix: on the overwhelmingly common
 * mirrored object the two are identical and nothing changes, and where they are not, the edit lands
 * on the volume it names instead of the one that happens to sit at that position.
 */
function resolvePartTargets<T>(
  objectBlock: string,
  componentObjectIds: readonly number[] | undefined,
  byOrdinal: ReadonlyMap<number, T>
): Map<number, T> {
  const partIds = parsePartIds(objectBlock)
  const resolved = new Map<number, T>()
  for (const [ordinal, value] of byOrdinal) {
    const index = resolvePartBlockIndex(ordinal, componentObjectIds, partIds)
    if (index != null) resolved.set(index, value)
  }
  return resolved
}

/**
 * Apply per-part filament reassignments by rewriting the matching `<part>`s' `extruder`
 * metadata inside `model_settings.config`. Filament is a property of the object's part, so
 * the change is keyed by objectId + the part's ORDINAL and affects every instance of that
 * object. Everything else in the document is left untouched.
 *
 * The OBJECT-level `extruder` follows the parts whenever they leave every filament-carrying part
 * on ONE slot: that entry is what the CLI actually slices by, so leaving it stale (or absent, in
 * an import-format object) silently prints the object with the old filament: the part-level
 * entries alone are not honored (A/B-verified; see `repairs/object-extruder.ts` for the stored
 * files this already happened to). Parts that DISAGREE leave the object entry alone: the object's
 * own default is not derivable from a per-part divergence, exactly like BambuStudio changing one
 * volume's filament without touching the object's.
 */
export function applyPartFilamentOverrides(
  modelSettingsXml: string,
  baseModelSettingsXml: string,
  partFilaments: SceneEditPartFilament[],
  modelXml: string
): string {
  const inverse = buildFilamentToExtruderMap(baseModelSettingsXml)
  const extruderByObjectPart = new Map<number, Map<number, number>>()
  for (const override of partFilaments) {
    const extruder = inverse.get(override.filamentId) ?? override.filamentId
    let parts = extruderByObjectPart.get(override.objectId)
    if (!parts) { parts = new Map(); extruderByObjectPart.set(override.objectId, parts) }
    parts.set(override.partIndex, extruder)
  }
  const componentIdsByObject = parseObjectComponentIds(modelXml)
  return modelSettingsXml.replace(/<object\b([^>]*)>[\s\S]*?<\/object>/g, (objectBlock, attrs: string) => {
    const objectId = Number.parseInt(parseAttrs(attrs).id ?? '', 10)
    const byOrdinal = extruderByObjectPart.get(objectId)
    if (!byOrdinal) return objectBlock
    const parts = resolvePartTargets(objectBlock, componentIdsByObject.get(objectId), byOrdinal)
    let partIndex = -1
    const rewritten = objectBlock.replace(/<part\b([^>]*)>[\s\S]*?<\/part>/g, (partBlock) => {
      partIndex += 1
      const extruder = parts.get(partIndex)
      return extruder == null ? partBlock : setPartExtruderMetadata(partBlock, extruder)
    })
    const shared = sharedCarryingPartExtruderOfBlock(rewritten)
    return shared == null ? rewritten : setObjectLevelExtruderMetadata(rewritten, shared)
  })
}

/**
 * Apply per-PART process overrides: set each part's process `<metadata>` inside its
 * `model_settings.config` `<part>` block (replacing the whole non-structural override set so a
 * cleared key is removed), keyed by objectId + the part's ORDINAL. Mirrors
 * {@link applyObjectProcessOverridesXml} but scoped to one part rather than the object head.
 */
export function applyPartProcessOverrides(
  modelSettingsXml: string,
  overrides: SceneEditPartProcessOverride[],
  modelXml: string
): string {
  const byObjectPart = new Map<number, Map<number, Record<string, string | string[]>>>()
  for (const override of overrides) {
    let parts = byObjectPart.get(override.objectId)
    if (!parts) { parts = new Map(); byObjectPart.set(override.objectId, parts) }
    parts.set(override.partIndex, override.overrides)
  }
  const componentIdsByObject = parseObjectComponentIds(modelXml)
  return modelSettingsXml.replace(/<object\b([^>]*)>[\s\S]*?<\/object>/g, (objectBlock, attrs: string) => {
    const objectId = Number.parseInt(parseAttrs(attrs).id ?? '', 10)
    const byOrdinal = byObjectPart.get(objectId)
    if (!byOrdinal) return objectBlock
    const parts = resolvePartTargets(objectBlock, componentIdsByObject.get(objectId), byOrdinal)
    let partIndex = -1
    return objectBlock.replace(/<part\b([^>]*)>([\s\S]*?)<\/part>/g, (partBlock, partAttrs: string, partBody: string) => {
      partIndex += 1
      const partOverrides = parts.get(partIndex)
      if (!partOverrides) return partBlock
      // Drop existing part-level PROCESS overrides only; keep everything else (name/extruder AND
      // identity/placement metadata like source_object_id, source_offset_*, matrix).
      const stripped = partBody.replace(/[ \t]*<metadata\s+key="([^"]+)"\s+value="[^"]*"\s*\/>\n?/g, (line, key: string) =>
        isProcessSettingKey(key) ? '' : line)
      // Inject ONLY process-setting keys. A stale/hand-built request whose override map carries
      // structural metadata (matrix, source_offset_*, name, extruder) must not clobber, or
      // duplicate, the part's real entries, which the strip above deliberately preserved.
      const injected = Object.entries(partOverrides).filter(([key]) => isProcessSettingKey(key)).map(([key, value]) => {
        const serialized = Array.isArray(value) ? value.join(';') : value
        return `\n      <metadata key="${escapeXmlAttribute(key)}" value="${escapeXmlAttribute(serialized)}"/>`
      }).join('')
      return `<part${partAttrs}>${injected}${stripped}</part>`
    })
  })
}

/**
 * Apply part-type changes (BambuStudio's "Change type": normal/negative/modifier/support
 * blocker/enforcer) by rewriting the matching `<part>`s' `subtype` attribute inside
 * `model_settings.config`. Keyed by objectId + the part's ORDINAL like
 * {@link applyPartProcessOverrides}; the type is shared by every instance of the object.
 */
export /**
 * Drop the legacy `volume_type` / `part_type` metadata from a retyped part.
 *
 * The importer applies the `subtype` ATTRIBUTE first and then walks the part's metadata, where
 * either of these calls `set_type` again (`bbs_3mf.cpp:5216` then `:5229-5230`). So a surviving
 * legacy entry silently OVERRIDES the type the user just chose, and because `type_from_string`
 * defaults to `MODEL_PART` for an unrecognised string, an old CamelCase value turns a modifier into
 * printed geometry rather than merely ignoring the change.
 *
 * Nothing observed writes these keys (BambuStudio's own writer is commented out at
 * `bbs_3mf.cpp:8000-8004`, and they appear in 0 of 141 real files), so this is closing the channel
 * rather than fixing a live defect. It runs only on parts a retype touched: a key we do not write
 * is still not ours to delete from a file we were not asked to change.
 */
function stripLegacyVolumeTypeMetadata(partBlock: string): string {
  return partBlock.replace(/[ \t]*<metadata\s+key="(?:volume_type|part_type)"[^>]*\/>\n?/g, '')
}

export function applyPartTypeChanges(
  modelSettingsXml: string,
  changes: SceneEditPartTypeChange[],
  modelXml: string
): string {
  const byObjectPart = new Map<number, Map<number, string>>()
  for (const change of changes) {
    let parts = byObjectPart.get(change.objectId)
    if (!parts) { parts = new Map(); byObjectPart.set(change.objectId, parts) }
    parts.set(change.partIndex, change.subtype)
  }
  const componentIdsByObject = parseObjectComponentIds(modelXml)
  return modelSettingsXml.replace(/<object\b([^>]*)>[\s\S]*?<\/object>/g, (objectBlock, attrs: string) => {
    const objectId = Number.parseInt(parseAttrs(attrs).id ?? '', 10)
    const byOrdinal = byObjectPart.get(objectId)
    if (!byOrdinal) return objectBlock
    const parts = resolvePartTargets(objectBlock, componentIdsByObject.get(objectId), byOrdinal)
    let partIndex = -1
    return objectBlock.replace(/<part\b([^>]*)>/g, (partTag, partAttrs: string) => {
      partIndex += 1
      const subtype = parts.get(partIndex)
      if (!subtype) return partTag
      if (/\bsubtype="[^"]*"/.test(partAttrs)) {
        return `<part${partAttrs.replace(/\bsubtype="[^"]*"/, `subtype="${escapeXmlAttribute(subtype)}"`)}>`
      }
      return `<part${partAttrs} subtype="${escapeXmlAttribute(subtype)}">`
    }).replace(/<part\b[^>]*>[\s\S]*?<\/part>/g, (partBlock) => stripLegacyVolumeTypeMetadata(partBlock))
  })
}

/**
 * Apply part-placement changes (move/rotate/scale a part inside its object). The
 * authoritative placement, what BambuStudio and the CLI slicer load into the volume's
 * transformation, is the part's `<component transform>` in the 3D model (12 numbers,
 * column-major 3x3 + translation), so that is rewritten. The `matrix` metadata in the
 * part's `model_settings.config` block (16 numbers, ROW-major 4x4) is only BambuStudio's
 * source-record (`volume->source.transform`); it is mirrored to the same matrix when
 * present so a later BambuStudio re-save doesn't compound a stale record. The placement
 * is a property of the object's part, shared by every placed instance, so it is keyed by
 * objectId + componentObjectId.
 */
export function applyPartTransforms(
  modelXml: string,
  modelSettingsXml: string,
  partTransforms: SceneEditPartTransform[]
): { modelXml: string; modelSettingsXml: string } {
  const byObjectPart = new Map<number, Map<number, number[]>>()
  for (const change of partTransforms) {
    let parts = byObjectPart.get(change.objectId)
    if (!parts) { parts = new Map(); byObjectPart.set(change.objectId, parts) }
    parts.set(change.partIndex, change.matrix)
  }
  const nextModelXml = modelXml.replace(/<object\b([^>]*)>[\s\S]*?<\/object>/g, (objectBlock, attrs: string) => {
    const objectId = Number.parseInt(parseAttrs(attrs).id ?? '', 10)
    const parts = byObjectPart.get(objectId)
    if (!parts) return objectBlock
    // The Nth `<component>` and the Nth `<part>` are the same volume: BambuStudio writes both in
    // volume order and parses them positionally. Matching on `objectid`/`id` instead moved every
    // volume sharing a mesh (four modifier cubes cut from one cube) whenever one was moved.
    let componentIndex = -1
    return objectBlock.replace(/<component\b([^>]*)\/>/g, (componentTag, componentAttrs: string) => {
      componentIndex += 1
      const matrix = parts.get(componentIndex)
      if (!matrix) return componentTag
      const transform = matrix.map(formatThreeMfTransformValue).join(' ')
      if (/\btransform="[^"]*"/.test(componentAttrs)) {
        return `<component${componentAttrs.replace(/\btransform="[^"]*"/, `transform="${transform}"`)}/>`
      }
      return `<component${componentAttrs} transform="${transform}"/>`
    })
  })
  const componentIdsByObject = parseObjectComponentIds(modelXml)
  const nextModelSettingsXml = modelSettingsXml.replace(/<object\b([^>]*)>[\s\S]*?<\/object>/g, (objectBlock, attrs: string) => {
    const objectId = Number.parseInt(parseAttrs(attrs).id ?? '', 10)
    const byOrdinal = byObjectPart.get(objectId)
    if (!byOrdinal) return objectBlock
    const parts = resolvePartTargets(objectBlock, componentIdsByObject.get(objectId), byOrdinal)
    let settingsPartIndex = -1
    return objectBlock.replace(/<part\b[^>]*>[\s\S]*?<\/part>/g, (partBlock) => {
      settingsPartIndex += 1
      const matrix = parts.get(settingsPartIndex)
      if (!matrix || !/<metadata\s+key="matrix"/.test(partBlock)) return partBlock
      // Column-major 12 -> row-major 4x4 16 (BambuStudio's transform3d_from_string layout).
      const m = (index: number) => formatThreeMfTransformValue(matrix[index] ?? 0)
      const rowMajor = [
        m(0), m(3), m(6), m(9),
        m(1), m(4), m(7), m(10),
        m(2), m(5), m(8), m(11),
        '0', '0', '0', '1'
      ].join(' ')
      return partBlock.replace(/<metadata\s+key="matrix"\s+value="[^"]*"\s*\/>/, `<metadata key="matrix" value="${rowMajor}"/>`)
    })
  })
  return { modelXml: nextModelXml, modelSettingsXml: nextModelSettingsXml }
}

/**
 * The final sequence of BASE ordinals for one object's volumes: the requested order applied, then
 * the requested removals dropped.
 *
 * Exported for its test; the two inputs are resolved together because neither can be applied after
 * the other. A reorder moves the ordinals a removal names, and a removal moves the ordinals an
 * order names, so running them as two passes silently retargets whichever went second.
 *
 * A partial `order` shuffles only the ordinals it names, through the SLOTS those ordinals already
 * occupy, and leaves everything else where it is. That is what makes a stale order (a part deleted
 * since it was composed, an ordinal the object never had) a no-op for the parts it does not name
 * instead of a reshuffle or a dropped volume.
 */
export function resolvePartLayout(
  count: number,
  order: readonly number[] | undefined,
  removed?: ReadonlySet<number>
): number[] {
  const layout = Array.from({ length: count }, (_unused, index) => index)
  // Only ordinals this object actually has, each at most once: a duplicate would place one volume
  // twice and silently drop another. `new Set` keeps the first occurrence, which is the one meant.
  const moving = [...new Set(order ?? [])].filter((ordinal) => ordinal >= 0 && ordinal < count)
  const moved = new Set(moving)
  // The slots those ordinals occupy today, filled back in the requested sequence. Everything else
  // stays where it is, which is what makes a partial order (the normal shape once a removal is
  // also pending) move only what it names.
  const slots = layout.filter((ordinal) => moved.has(ordinal))
  moving.forEach((ordinal, position) => { layout[slots[position]!] = ordinal })
  return removed ? layout.filter((ordinal) => !removed.has(ordinal)) : layout
}

/**
 * Lay out each in-project object's volumes: apply the session's part ORDER and its part REMOVALS in
 * one pass, rewriting the `<component>` sequence in the model and the matching `<part>` sequence in
 * `model_settings.config` so the two documents agree.
 *
 * Both are rewritten because BambuStudio pairs them by position first and only falls back to a
 * linear id search, and because the `<part>` order is what its importer reads a volume's identity
 * from (`_handle_start_config_volume` uses `volumes.size()`, not the `id` attribute).
 *
 * Three rules. **Ordinals are counted over the BASE document and never renumbered mid-pass**, so
 * removing parts 1 and 2 removes those two rather than part 1 and then whatever slid into slot 2.
 * **This runs AFTER every other part-scoped applier**, all of which address the same base ordinals;
 * the caller enforces that, and getting it wrong retargets edits silently rather than failing.
 *
 * And **the MODEL's `<component>` list is the volume list; `model_settings` follows it**, because
 * that is how BambuStudio reads them. `_generate_volumes_new` loops over the object's COMPONENTS and
 * looks each one's metadata up in the `<part>` list positionally, guarded by an id check
 * (`index < volumes.size() && volumes[index].subobject_id == sub_object->id`), falling back to a
 * linear id search and then to defaults. So the two lists get ONE layout, computed from the
 * components. When their lengths disagree the object is not a positional mirror at all, and the
 * `<part>` list is left ALONE rather than permuted onto a different length: a `<part>` that matches
 * no component is simply never read by that loop, while a wrongly-permuted one is metadata landing
 * on the wrong volume. An object whose mesh is INLINE has no components, so its single
 * self-referencing `<part>` is the volume list and the settings count leads instead.
 *
 * A removed component was the only thing keeping its mesh object referenced, so the caller re-runs
 * the unreferenced-object sweep afterwards. Removing an object's LAST printed part is refused
 * client-side (an object with no geometry is not a thing BambuStudio can open); nothing here depends
 * on that, so a malformed edit degrades to an empty object rather than a corrupt file.
 */
export function applyPartLayout(
  modelXml: string,
  modelSettingsXml: string,
  removedParts: readonly SceneEditRemovedPart[],
  partOrder: readonly SceneEditPartOrder[]
): { modelXml: string; modelSettingsXml: string; volumeLayouts: ReadonlyMap<number, number[]> } {
  const removedByObject = new Map<number, Set<number>>()
  for (const removal of removedParts) {
    let parts = removedByObject.get(removal.objectId)
    if (!parts) { parts = new Set(); removedByObject.set(removal.objectId, parts) }
    parts.add(removal.partIndex)
  }
  const orderByObject = new Map<number, readonly number[]>()
  for (const entry of partOrder) orderByObject.set(entry.objectId, entry.order)
  const volumeLayouts = new Map<number, number[]>()
  if (removedByObject.size === 0 && orderByObject.size === 0) {
    return { modelXml, modelSettingsXml, volumeLayouts }
  }

  const COMPONENT_PATTERN = /[^\S\r\n]*<component\b[^>]*\/>\n?/g
  const PART_PATTERN = /[^\S\r\n]*<part\b[^>]*>[\s\S]*?<\/part>\n?/g

  /** How many `<component>`s each object declares: the length of its volume list. */
  const componentCounts = new Map<number, number>()
  for (const match of modelXml.matchAll(/<object\b([^>]*)>[\s\S]*?<\/object>/g)) {
    const objectId = Number.parseInt(parseAttrs(match[1] ?? '').id ?? '', 10)
    if (Number.isInteger(objectId)) componentCounts.set(objectId, [...match[0].matchAll(COMPONENT_PATTERN)].length)
  }

  /** Rewrite one document's per-object volume blocks into the object's single resolved layout. */
  const relayout = (xml: string, blockPattern: RegExp): string =>
    xml.replace(/<object\b([^>]*)>[\s\S]*?<\/object>/g, (objectBlock, attrs: string) => {
      const objectId = Number.parseInt(parseAttrs(attrs).id ?? '', 10)
      const removed = removedByObject.get(objectId)
      const order = orderByObject.get(objectId)
      if (!removed && !order) return objectBlock
      const blocks = [...objectBlock.matchAll(blockPattern)].map((match) => match[0])
      // The components lead; an inline-mesh object has none, so its own `<part>` list does.
      const volumeCount = componentCounts.get(objectId) || blocks.length
      if (blocks.length !== volumeCount) return objectBlock
      const layout = resolvePartLayout(volumeCount, order, removed)
      // Same order and nothing dropped: return the block untouched so an ordinary save churns no
      // bytes, which is also what keeps the ordinal-sidecar remap a no-op.
      if (layout.length === blocks.length && layout.every((ordinal, index) => ordinal === index)) return objectBlock
      volumeLayouts.set(objectId, layout)
      const rewritten = layout.map((ordinal) => blocks[ordinal]!)
      // Past the end of the new layout are the removed volumes' slots, which emit nothing.
      let emitted = 0
      return objectBlock.replace(blockPattern, () => rewritten[emitted++] ?? '')
    })

  const relaidModel = relayout(modelXml, COMPONENT_PATTERN)
  const relaidSettings = relayout(modelSettingsXml, PART_PATTERN)
  return {
    modelXml: relaidModel,
    // After the object pass, which populates the layouts this needs and cannot reach `<assemble>`.
    modelSettingsXml: remapAssembleItems(relaidSettings, volumeLayouts),
    volumeLayouts
  }
}

/**
 * Rewrite the root `<assemble>` block's `<assemble_item volume_id>`s for the new volume order.
 *
 * The SECOND place a volume ordinal appears in `model_settings.config`, and the one the per-object
 * pass above cannot reach: `<assemble>` is a SIBLING of the `<object>` blocks, not a child, so the
 * relayout's own `<object>…</object>` scope steps straight over it.
 *
 * Each item carries the assembly-view transform for one volume, which BambuStudio replays as
 * `mo->volumes[entry.volume_id]->set_assemble_from_transform(...)`, a bare index, so a stale
 * ordinal silently lands the transform on whichever volume slid into that slot. An item whose
 * volume was REMOVED is dropped rather than renumbered onto a survivor, the same rule its
 * `<connector>` counterpart follows and for the same reason: renumbering hands unrelated geometry
 * a transform nobody authored for it.
 */
function remapAssembleItems(
  settingsXml: string,
  volumeLayouts: ReadonlyMap<number, readonly number[]>
): string {
  if (volumeLayouts.size === 0) return settingsXml
  // Both spellings, as in `remapConnectorVolumes`: BambuStudio writes the self-closing form, but a
  // hand-edited or foreign file may use an explicit close, and those must not be left stale.
  return settingsXml.replace(
    /[ \t]*<assemble_item\b([^>]*?)(?:\/>|>[\s\S]*?<\/assemble_item>)\n?/g,
    (item, attrs: string) => {
      const parsed = parseAttrs(attrs ?? '')
      const layout = volumeLayouts.get(Number.parseInt(parsed.object_id ?? '', 10))
      if (!layout) return item
      const volumeId = Number.parseInt(parsed.volume_id ?? '', 10)
      if (!Number.isInteger(volumeId)) return item
      // `layout[newIndex] = oldOrdinal`, so the new home of an old volume is its position in it.
      const next = layout.indexOf(volumeId)
      if (next < 0) return ''
      return next === volumeId ? item : item.replace(/(\bvolume_id=")\d+(")/, `$1${next}$2`)
    }
  )
}
