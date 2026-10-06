/**
 * Index unsaved-import edits before the document builder assigns object ids.
 *
 * Every per-solid map is keyed by the staged solid index. Filtering or reordering
 * parts later must keep that original index so paint, material, type, and transform
 * edits land on the intended geometry. Replacement lookup uses the original
 * import map; the staged geometry itself is repaired separately.
 */
import type { SceneEdit } from '../slicing.js'
import type { ImportedMesh } from './imported-mesh.js'
import type { ImportedObjectInput } from './bake-documents.js'
import { repairImportedMeshGeometry } from './mesh-repair.js'

/** Triangle paint channels: the brush they come from and the 3MF attribute they write. */
export type TrianglePaintAttribute = 'paint_supports' | 'paint_seam' | 'paint_color' | 'paint_fuzzy_skin'

/**
 * The ONE channel-name to 3MF-attribute map. Both the import-paint collector here and the
 * saved-part channels in `bake.ts` resolve through it, because this pair drifted the moment a
 * fourth channel arrived: the collector's inline ternary defaulted anything unrecognised to
 * `paint_supports`, so a new channel silently painted supports instead of failing.
 */
export const PAINT_ATTRIBUTE_BY_CHANNEL: Readonly<Record<'support' | 'seam' | 'color' | 'fuzzy', TrianglePaintAttribute>> = {
  support: 'paint_supports',
  seam: 'paint_seam',
  color: 'paint_color',
  fuzzy: 'paint_fuzzy_skin'
}

/** Build lookup maps and repaired staged geometry for the import phase. */
export function indexImportEdits(edit: SceneEdit, initialImports: ImportedObjectInput[]) {
  let imports = initialImports
  const importsById = new Map(imports.map((imported) => [imported.importId, imported]))
  const consumedReplacementIds = new Set([
    ...(edit.partMeshReplacements ?? []).map((replacement) => replacement.meshImportId),
    ...(edit.importPartMeshReplacements ?? []).map((replacement) => replacement.meshImportId)
  ])
  const independentlyUsedImportIds = new Set([
    ...edit.instances.flatMap((instance) => instance.importId ? [instance.importId] : []),
    ...(edit.addedParts ?? []).map((part) => part.meshImportId)
  ])
  // An import consumed as an added part gets a mesh resource, but no standalone
  // model-settings object or build item.
  const partImportIds = new Set((edit.addedParts ?? []).map((part) => part.meshImportId))

  // "Repair mesh" on a not-yet-saved import: repair the geometry on its way into the document,
  // since there is no mesh XML to rewrite yet. Applied to the merged mesh AND each solid so a
  // multi-solid assembly repairs like a single one.
  const repairedImportIds = new Set(edit.repairedImportIds ?? [])
  if (repairedImportIds.size > 0) {
    imports = imports.map((imported) => {
      if (!repairedImportIds.has(imported.importId)) return imported
      const repairMesh = (mesh: ImportedMesh): ImportedMesh => {
        const repaired = repairImportedMeshGeometry(mesh.positions, mesh.indices)
        return repaired ? { ...mesh, positions: repaired.positions, indices: repaired.indices } : mesh
      }
      return {
        ...imported,
        mesh: repairMesh(imported.mesh),
        ...(imported.parts ? { parts: imported.parts.map((part) => ({ ...part, mesh: repairMesh(part.mesh) })) } : {})
      }
    })
  }

  // The first placing instance supplies each imported object's material.
  const importFilament = new Map<string, number>()
  for (const instance of edit.instances) {
    if (instance.importId && instance.filamentId != null && !importFilament.has(instance.importId)) {
      importFilament.set(instance.importId, instance.filamentId)
    }
  }
  // Per-part filament for multi-solid imports: importId -> (0-based solid index -> filamentId).
  const importPartFilament = new Map<string, Map<number, number>>()
  for (const entry of edit.importPartFilaments ?? []) {
    let byPart = importPartFilament.get(entry.importId)
    if (!byPart) { byPart = new Map(); importPartFilament.set(entry.importId, byPart) }
    byPart.set(entry.partIndex, entry.filamentId)
  }
  // Per-part PROCESS overrides for multi-solid imports: importId -> (solid index -> overrides).
  const importPartProcess = new Map<string, Map<number, Record<string, string | string[]>>>()
  for (const entry of edit.importPartProcessOverrides ?? []) {
    let byPart = importPartProcess.get(entry.importId)
    if (!byPart) { byPart = new Map(); importPartProcess.set(entry.importId, byPart) }
    byPart.set(entry.partIndex, entry.overrides)
  }
  // Per-part transforms for multi-solid imports retain the staged solid index.
  const importPartTransforms = new Map<string, Map<number, readonly number[]>>()
  for (const entry of edit.importPartTransforms ?? []) {
    let byPart = importPartTransforms.get(entry.importId)
    if (!byPart) { byPart = new Map(); importPartTransforms.set(entry.importId, byPart) }
    byPart.set(entry.partIndex, entry.matrix)
  }
  // Triangle paint authored on a not-yet-saved import: importId -> solid index -> attribute -> codes.
  const importPaint = new Map<string, Map<number, Map<TrianglePaintAttribute, Record<string, string>>>>()
  for (const entry of edit.importPaint ?? []) {
    const attribute: TrianglePaintAttribute = PAINT_ATTRIBUTE_BY_CHANNEL[entry.channel] ?? 'paint_supports'
    let byPart = importPaint.get(entry.importId)
    if (!byPart) { byPart = new Map(); importPaint.set(entry.importId, byPart) }
    let byAttribute = byPart.get(entry.partIndex)
    if (!byAttribute) { byAttribute = new Map(); byPart.set(entry.partIndex, byAttribute) }
    byAttribute.set(attribute, entry.triangles)
  }
  const importPartTypes = new Map<string, Map<number, string>>()
  for (const entry of edit.importPartTypes ?? []) {
    let byPart = importPartTypes.get(entry.importId)
    if (!byPart) { byPart = new Map(); importPartTypes.set(entry.importId, byPart) }
    byPart.set(entry.partIndex, entry.subtype)
  }
  const importPartMeshReplacements = new Map<string, Map<number, ImportedMesh>>()
  for (const entry of edit.importPartMeshReplacements ?? []) {
    const replacement = importsById.get(entry.meshImportId)
    if (!replacement) throw new Error('Scene edit references an unknown part replacement mesh')
    let byPart = importPartMeshReplacements.get(entry.importId)
    if (!byPart) { byPart = new Map(); importPartMeshReplacements.set(entry.importId, byPart) }
    byPart.set(entry.partIndex, replacement.mesh)
  }
  const importRemovedParts = new Map<string, Set<number>>()
  for (const entry of edit.importRemovedParts ?? []) {
    let byPart = importRemovedParts.get(entry.importId)
    if (!byPart) { byPart = new Set(); importRemovedParts.set(entry.importId, byPart) }
    byPart.add(entry.partIndex)
  }
  const importPartOrder = new Map<string, readonly number[]>()
  for (const entry of edit.importPartOrder ?? []) importPartOrder.set(entry.importId, entry.order)

  return {
    imports,
    importsById,
    consumedReplacementIds,
    independentlyUsedImportIds,
    partImportIds,
    importFilament,
    importPartFilament,
    importPartProcess,
    importPartTransforms,
    importPaint,
    importPartTypes,
    importPartMeshReplacements,
    importRemovedParts,
    importPartOrder
  }
}
