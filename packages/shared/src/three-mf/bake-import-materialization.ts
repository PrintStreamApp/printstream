/**
 * Materialize staged mesh imports as 3MF objects, component part files, and
 * model-settings entries. Solid edits stay keyed by their original import
 * index even when the user removes or reorders solids before the bake.
 */
import { threeMfPartSubtypeCarriesFilament } from '../three-mf-part-subtype.js'
import { indexImportEdits } from './import-edit-index.js'
import { resolvePartLayout } from './bake-part-edits.js'
import {
  renderImportedComponentsObjectXml,
  renderImportedMeshObjectXml,
  renderImportedModelSettingsObjectXml,
  renderImportedMultiPartModelSettingsXml,
  renderImportedPartFileModel,
  type ImportedPartFileEntry
} from './bake-import-xml.js'

/**
 * Turn staged imports into 3MF resources and settings objects.
 * Preserve each solid's original index through filtering and reorder so
 * its paint, material, process, type, transform, and mesh edits stay attached.
 * Return the next free object id for the later added-volume phase.
 */
export function materializeImportedObjects(
  edits: ReturnType<typeof indexImportEdits>,
  nextObjectId: number,
  genUuid: (() => string) | null,
  copiedPartFiles: readonly ImportedPartFileEntry[],
  filamentToExtruder: ReadonlyMap<number, number>
) {
  const {
    imports,
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
  } = edits
  const importIdToObjectId = new Map<string, number>()
  const meshObjects: string[] = []
  const settingsObjects: string[] = []
  // Copies' sub-model files lead, and newly imported files follow in source order.
  const partFileEntries: ImportedPartFileEntry[] = [...copiedPartFiles]
  const toExtruder = (filamentId: number | null): number | null =>
    filamentId != null ? filamentToExtruder.get(filamentId) ?? filamentId : null
  for (const imported of imports) {
    if (consumedReplacementIds.has(imported.importId) && !independentlyUsedImportIds.has(imported.importId)) continue
    const objectId = nextObjectId
    nextObjectId += 1
    importIdToObjectId.set(imported.importId, objectId)
    const isPartImport = partImportIds.has(imported.importId)
    // A multi-solid import (STEP assembly) bakes as one object whose solids are component parts;
    // imports consumed as an added part volume stay single-mesh (applyAddedParts wraps them).
    //
    // Solids the user deleted are filtered out here, but each survivor carries its ORIGINAL index:
    // every other import-part seam (`importPartFilaments`, `importPartTypes`, `importPartTransforms`,
    // `importPaint`, ...) is keyed by the staged record's solid index, so looking those up by the
    // post-filter position would shift every one of them onto the wrong solid. The multi-part path
    // is also chosen on the ORIGINAL count, so an import whittled down to a single solid still bakes
    // as a one-component object rather than falling back to `imported.mesh`: that fallback is the
    // MERGED mesh and would silently reintroduce the removed geometry.
    const removedSolids = importRemovedParts.get(imported.importId)
    const allSolids = !isPartImport && imported.parts && imported.parts.length > 1
      ? imported.parts.map((part, sourceIndex) => ({ part, sourceIndex }))
      : null
    // Reordered and filtered together, through the same resolver the in-project layout uses, so
    // the two paths cannot disagree about what a partial or stale order means. Each survivor still
    // carries its ORIGINAL `sourceIndex` for the per-solid seams above.
    const multiParts = allSolids
      ? resolvePartLayout(allSolids.length, importPartOrder.get(imported.importId), removedSolids)
        .map((sourceIndex) => allSolids[sourceIndex]!)
      : null
    // An imported object is ALWAYS bound, never left implicit. An import starts at
    // `filamentId: null`, and writing nothing made the object's material a property of the ENGINE
    // rather than of the file: BambuStudio materialises extruder 1 for an object whose entry is
    // absent, `0`, or past the filament count (`bbs_3mf.cpp`, the block that also clamps volumes),
    // so the object printed filament 1 with nothing anywhere saying so. That left saved projects
    // flagged `objectExtruder` with mixed part coverage, the one shape the repair declines to
    // guess at, and no way for a user to clear it.
    //
    // 1 is not a guess: it is the value the engine already applies, so binding it changes nothing
    // about what prints and merely makes the file state what it does. It is also what desktop
    // BambuStudio writes back after a load-then-save round trip.
    const objectExtruder = toExtruder(importFilament.get(imported.importId) ?? null) ?? 1
    if (multiParts) {
      const componentIds = multiParts.map(() => {
        const id = nextObjectId
        nextObjectId += 1
        return id
      })
      const partFilaments = importPartFilament.get(imported.importId)
      const partProcess = importPartProcess.get(imported.importId)
      const partTypes = importPartTypes.get(imported.importId)
      const partTransforms = importPartTransforms.get(imported.importId)
      const solidPaint = importPaint.get(imported.importId)
      // The renderer indexes transforms by COMPONENT position, while the edit keys them by staged
      // solid index; those diverge as soon as a solid is removed, so rebase the map here rather
      // than letting each surviving solid inherit its neighbour's placement.
      const componentTransforms = partTransforms
        ? new Map(multiParts.flatMap((entry, i) => {
          const matrix = partTransforms.get(entry.sourceIndex)
          return matrix ? [[i, matrix] as const] : []
        }))
        : undefined
      const replacementMeshes = importPartMeshReplacements.get(imported.importId)
      const solidMeshXmls = multiParts.map((entry, i) => renderImportedMeshObjectXml(
        componentIds[i]!,
        replacementMeshes?.get(entry.sourceIndex) ?? entry.part.mesh,
        genUuid,
        solidPaint?.get(entry.sourceIndex)
      ))
      if (genUuid) {
        // Production extension: emit the solids as a separate /3D/Objects sub-model and reference
        // them by p:path, so a plate fetches/parses only this import's part file, not the whole
        // root model, and the layout matches BambuStudio's. The root keeps just the small assembly.
        const partFilePath = `3D/Objects/printstream_object_${objectId}.model`
        partFileEntries.push({ name: partFilePath, content: renderImportedPartFileModel(solidMeshXmls) })
        meshObjects.push(renderImportedComponentsObjectXml(objectId, componentIds, genUuid, `/${partFilePath}`, componentTransforms))
      } else {
        // Non-production project: keep the solids inline in the root model (same-file components).
        meshObjects.push(...solidMeshXmls)
        meshObjects.push(renderImportedComponentsObjectXml(objectId, componentIds, genUuid, null, componentTransforms))
      }
      settingsObjects.push(renderImportedMultiPartModelSettingsXml(
        objectId,
        imported.name,
        objectExtruder,
        // Each solid keeps its own filament when assigned; otherwise it inherits the object's.
        // Every per-solid lookup is by `sourceIndex`, the staged record's own index, because that
        // is what all the import-part seams are keyed by. Using the post-filter position `i` here
        // would hand each survivor its removed neighbour's material, type and overrides.
        multiParts.map((entry, i) => ({
          componentObjectId: componentIds[i]!,
          name: entry.part.name,
          // A helper volume carries no material (BambuStudio writes extruder 0), so it must
          // never inherit the object's: see threeMfPartSubtypeCarriesFilament.
          extruder: threeMfPartSubtypeCarriesFilament(partTypes?.get(entry.sourceIndex) ?? entry.part.subtype ?? null)
            ? toExtruder(partFilaments?.get(entry.sourceIndex) ?? null) ?? objectExtruder
            : null,
          // Per-part process overrides set on the unsaved import (keyed by solid index).
          processOverrides: partProcess?.get(entry.sourceIndex),
          // The type the user chose on the unsaved import ("Change type") wins; otherwise the
          // solid keeps the type it was imported WITH, a 3MF's support blocker stays a blocker
          // instead of silently baking as printed geometry.
          subtype: partTypes?.get(entry.sourceIndex) ?? entry.part.subtype ?? undefined
        }))
      ))
    } else {
      // Solid index 0 is a single-solid import's only mesh.
      meshObjects.push(renderImportedMeshObjectXml(objectId, imported.mesh, genUuid, importPaint.get(imported.importId)?.get(0)))
      if (!isPartImport) {
        settingsObjects.push(renderImportedModelSettingsObjectXml(objectId, imported.name, objectExtruder))
      }
    }
  }

  return { nextObjectId, importIdToObjectId, meshObjects, settingsObjects, partFileEntries }
}
