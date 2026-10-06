/**
 * BambuStudio custom G-code sidecar transforms used by the shared 3MF bake.
 * Preserve untouched plate entries while re-keying edited plates and material ids.
 */
import type { SceneEditPlateFilamentChanges, SceneEditPlatePauses } from '../slicing.js'
import { parseAttrs } from './index-parser.js'
import { escapeXmlAttribute } from './xml-write.js'

/** A `<layer .../>` tag paired with its parsed top_z so merged plates can emit in z order. */
interface CustomGcodeLayerTag {
  tag: string
  z: number
}

/**
 * BambuStudio's default pause command for Bambu machines. Informational in the sidecar:
 * at slice time the engine re-resolves the machine profile's `machine_pause_gcode`
 * rather than using the stored string.
 */
const PAUSE_PRINT_GCODE = 'M400 U1'

/** The `plate_info id`s carried by a `custom_gcode_per_layer.xml` document. */
export function customGcodePlateIds(xml: string): number[] {
  const ids: number[] = []
  for (const plateMatch of xml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const id = Number.parseInt(parseAttrs(/<plate_info\b([^>]*)\/>/.exec(plateMatch[1] ?? '')?.[1] ?? '').id ?? '', 10)
    if (Number.isInteger(id) && id > 0) ids.push(id)
  }
  return ids
}

/**
 * Merge layer-based filament changes and layer pauses into BambuStudio's
 * `custom_gcode_per_layer.xml`. Plates listed in `filamentEdits` get their ToolChange
 * (`type="2"`) entries REPLACED; plates listed in `pauseEdits` get their PausePrint
 * (`type="1"`) entries REPLACED. All other entry types and every unlisted plate are
 * preserved verbatim from the source. An undefined edit list leaves that entry type
 * untouched everywhere. Returns '' when nothing remains (clears the sidecar).
 */
export function mergeCustomGcodePerLayer(
  sourceXml: string | null,
  filamentEdits: SceneEditPlateFilamentChanges[] | undefined,
  pauseEdits?: SceneEditPlatePauses[],
  /** Source plate number -> saved plate number. Unmapped source plates were deleted. */
  sourcePlateMap?: ReadonlyMap<number, number> | null
): string {
  const sourcePlates = new Map<number, { toolChanges: CustomGcodeLayerTag[]; pauses: CustomGcodeLayerTag[]; others: CustomGcodeLayerTag[]; mode: string | null }>()
  if (sourceXml) {
    for (const plateMatch of sourceXml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
      const block = plateMatch[1] ?? ''
      const sourceId = Number.parseInt(parseAttrs(/<plate_info\b([^>]*)\/>/.exec(block)?.[1] ?? '').id ?? '', 10)
      if (!Number.isInteger(sourceId) || sourceId <= 0) continue
      const id = sourcePlateMap ? sourcePlateMap.get(sourceId) : sourceId
      if (id == null) continue
      const toolChanges: CustomGcodeLayerTag[] = []
      const pauses: CustomGcodeLayerTag[] = []
      const others: CustomGcodeLayerTag[] = []
      for (const layerMatch of block.matchAll(/<layer\b([^>]*)\/>/g)) {
        const attrs = parseAttrs(layerMatch[1] ?? '')
        const target = attrs.type === '2' ? toolChanges : attrs.type === '1' ? pauses : others
        const z = Number.parseFloat(attrs.top_z ?? '')
        target.push({ tag: layerMatch[0], z: Number.isFinite(z) ? z : 0 })
      }
      const mode = /<mode\b[^>]*\/>/.exec(block)?.[0] ?? null
      sourcePlates.set(id, { toolChanges, pauses, others, mode })
    }
  }
  const filamentEditsByPlate = filamentEdits ? new Map(filamentEdits.map((entry) => [entry.plateIndex, entry.changes])) : null
  const pauseEditsByPlate = pauseEdits ? new Map(pauseEdits.map((entry) => [entry.plateIndex, entry.pauses])) : null
  const plateIds = [...new Set([
    ...sourcePlates.keys(),
    ...(filamentEditsByPlate?.keys() ?? []),
    ...(pauseEditsByPlate?.keys() ?? [])
  ])].sort((left, right) => left - right)
  const blocks: string[] = []
  for (const plateId of plateIds) {
    const source = sourcePlates.get(plateId)
    const editedChanges = filamentEditsByPlate?.get(plateId)
    const editedPauses = pauseEditsByPlate?.get(plateId)
    const toolChangeTags = editedChanges
      ? editedChanges.map((change): CustomGcodeLayerTag => ({
        tag: `<layer top_z="${change.z}" type="2" extruder="${change.filamentId}" color="${escapeXmlAttribute(change.color ?? '')}" extra="" gcode="tool_change"/>`,
        z: change.z
      }))
      : source?.toolChanges ?? []
    const pauseTags = editedPauses
      ? editedPauses.map((pause): CustomGcodeLayerTag => ({
        tag: `<layer top_z="${pause.z}" type="1" extruder="1" color="" extra="" gcode="${PAUSE_PRINT_GCODE}"/>`,
        z: pause.z
      }))
      : source?.pauses ?? []
    const otherTags = source?.others ?? []
    const layerTags = [...toolChangeTags, ...pauseTags, ...otherTags].sort((left, right) => left.z - right.z)
    if (layerTags.length === 0) continue
    blocks.push([
      '<plate>',
      `<plate_info id="${plateId}"/>`,
      ...layerTags.map((entry) => entry.tag),
      source?.mode ?? '<mode value="MultiAsSingle"/>',
      '</plate>'
    ].join('\n'))
  }
  if (blocks.length === 0) return ''
  return ['<?xml version="1.0" encoding="utf-8"?>', '<custom_gcodes_per_layer>', ...blocks, '</custom_gcodes_per_layer>', ''].join('\n')
}

/**
 * Re-key the 1-based filament ids inside a `custom_gcode_per_layer.xml` document after a save that
 * renumbers the filament slots.
 *
 * Only tool-change layers (`type="2"`) reference a material, their `extruder` attribute is the
 * filament the print switches to. A change targeting a removed material is dropped outright,
 * as BambuStudio's delete path does (`Plater::on_filaments_delete` removes the ToolChange item).
 * Other layer types keep their `extruder` verbatim: a pause writes a placeholder `extruder="1"`
 * that carries no material semantics.
 *
 * Counterpart of `mergeCustomGcodePerLayer` above: plates the session EDITED get their tool
 * changes re-authored from the edit (already in the new id space); this pass is what covers the
 * plates the session never touched, whose sidecar content would otherwise stream through the save
 * still speaking the old slot order.
 */
export function remapCustomGcodeFilamentIds(sourceXml: string, remap: ReadonlyMap<number, number>): string {
  return sourceXml.replace(/[ \t]*<layer\b([^>]*)\/>\n?/g, (block, attrs: string) => {
    const parsed = parseAttrs(attrs)
    if (parsed.type !== '2') return block
    const oldId = Number.parseInt(parsed.extruder ?? '', 10)
    if (!Number.isInteger(oldId) || oldId < 1) return block
    const newId = remap.get(oldId)
    if (newId == null) return ''
    if (newId === oldId) return block
    return block.replace(`extruder="${parsed.extruder}"`, `extruder="${newId}"`)
  })
}
