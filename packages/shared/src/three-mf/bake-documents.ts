/**
 * The 3MF bake, as pure document transforms.
 *
 * Coordinates the string-to-string rewrites the editor's write path performs: injecting imported
 * meshes as new `<object><mesh>` resources, regenerating the root model's build items and
 * `model_settings.config` plates/instances, applying per-part filament/type/transform/paint edits,
 * and rewriting `project_settings.config` for filament, plate-type, and prime-tower changes.
 * The ordered model-settings XML renderer lives in `bake-arranged-model-settings.ts`; imported
 * mesh and part-file XML rendering lives in `bake-import-xml.ts`; custom G-code
 * sidecar transforms live in `bake-custom-gcode.ts`; final project-settings repairs
 * and metadata transforms live in `bake-project-settings-finishing.ts`;
 * existing-part XML edits live in `bake-part-edits.ts`; filament-list and nozzle
 * authoring live in `bake-filament-settings.ts`; ordered project-settings
 * transforms live in `bake-project-settings.ts`; added-part XML lives in
 * `bake-added-parts.ts`, with shared insertion in `bake-xml-inject.ts`; mesh
 * paint and repair routing live in `bake-paint-and-repair.ts`; plate-grid
 * placement and root build items live in `bake-placement.ts`; staged import
 * materialization lives in `bake-import-materialization.ts`; placed-object
 * validation and cleanup live in `bake-object-sweep.ts`.
 * {@link threeMfTransformFromTRS} is the exact inverse of the reader's scene decomposition, so an
 * unedited round-trip reproduces the source placement.
 *
 * Contract: NOTHING here touches a file, an archive, or the network. Callers read the source
 * entries, hand them in as text, and write the results with their own ZIP layer --
 * `three-mf-scene-builder.ts` does that with yauzl/yazl over a path on disk. That separation is why
 * this file can move to `@printstream/shared/three-mf` and serve the browser editor, which bakes the
 * user's own file locally and never uploads it. Keep it Node-free: no `node:` imports, no `Buffer`.
 *
 * Split out of `three-mf-scene-builder.ts`, which retains the I/O orchestration and re-exports this
 * module's surface so existing api call sites are unaffected.
 */
import { repairModelSettingsObjectExtruders } from '../repairs/object-extruder.js'
import { parseSourcePlateMetadata } from './plate-metadata.js'
import {
  parseModelSettingsIdentifyIds,
  renderArrangedModelSettingsPlates,
  replaceModelSettingsPlates,
  type ArrangedInstance
} from './bake-arranged-model-settings.js'
import { remapColorPaintInModelXml } from './triangle-paint-codec.js'
import type { SceneEdit, SceneEditObjectBrimEars } from '../slicing.js'
import type { ImportedMesh } from './imported-mesh.js'
import { parseAttrs } from './index-parser.js'
import { applyObjectClones } from './object-clone.js'
import { indexImportEdits } from './import-edit-index.js'
import {
  buildFilamentToExtruderMap,
  filamentSlotIdRemap,
  isIdentityFilamentSlotRemap,
  remapModelSettingsFilamentRefs
} from './filament-slot-remap.js'
export { filamentSlotIdRemap, isIdentityFilamentSlotRemap } from './filament-slot-remap.js'
export { buildProjectSettingsTransforms } from './bake-project-settings.js'
export { applyGlobalProcessOverrides, applyModelKindMarker, repairProjectSettingsDocument } from './bake-project-settings-finishing.js'

export { PAINT_ATTRIBUTE_BY_CHANNEL } from './import-edit-index.js'
export type { TrianglePaintAttribute } from './import-edit-index.js'
import { parseRootModelObjectIdOrder } from './scene-parser.js'
import { escapeXmlAttribute } from './xml-write.js'
import { injectModelSettingsObjects, injectResourcesObjects } from './bake-xml-inject.js'
import { applyAddedParts } from './bake-added-parts.js'
import { materializeImportedObjects } from './bake-import-materialization.js'
import { removeUnreferencedObjects, validateAndSweepPlacedObjects } from './bake-object-sweep.js'
import { arrangeEditedInstances, renderArrangedBuildItems, replaceThreeMfBuildSection } from './bake-placement.js'
export { applyAddedParts } from './bake-added-parts.js'
import {
  applyPartFilamentOverrides,
  applyPartProcessOverrides,
  applyPartTypeChanges,
  applyPartTransforms,
  applyPartLayout
} from './bake-part-edits.js'
export {
  applyPartProcessOverrides,
  applyPartTypeChanges,
  applyPartTransforms,
  applyPartLayout,
  resolvePartLayout,
  parseObjectComponentIds,
  resolvePartBlockIndex
} from './bake-part-edits.js'

import {
  replaceObjectMeshInModelXml,
  type ImportedPartFileEntry
} from './bake-import-xml.js'
export { appendImportPartRelationships, renderImportedMeshObjectXmlForTest, renderImportedMultiPartModelSettingsXml, replaceObjectMeshInModelXml } from './bake-import-xml.js'

/**
 * Does the base model use the 3MF Production Extension? BambuStudio always saves with it
 * (`requiredextensions="p"`, every object/component carrying a `p:UUID`). When it is in force, the
 * Bambu Studio **GUI** load path requires a `p:UUID` on every `<object>`/`<component>`, its parser
 * tolerates the absence, but the GUI drops UUID-less nodes during volume building, so a project we
 * saved with UUID-less injected objects loads as ZERO model objects and the GUI reports
 * "The file does not contain any geometry data." (The CLI slicer tolerates it, which is why slicing
 * worked while opening in the GUI did not.) So when the source is a production-extension project we
 * must stamp a UUID on every editor-injected node.
 */
function modelUsesProductionExtension(modelXml: string): boolean {
  return modelXml.includes(' p:UUID="') || /requiredextensions\s*=\s*"[^"]*\bp\b[^"]*"/.test(modelXml)
}

export { threeMfTransformFromTRS } from './bake-placement.js'

/** A foreign mesh to inject into the output 3MF as a brand-new object the edit can reference. */
export interface ImportedObjectInput {
  importId: string
  name: string
  mesh: ImportedMesh
  /**
   * Named sub-solids when the import is a multi-solid assembly (a STEP with several parts). When
   * present (>1), the import bakes as ONE object whose solids are `<component>` parts, each with
   * its own `model_settings` `<part>` entry, instead of a single merged `<object><mesh>`. The
   * top-level {@link ImportedObjectInput.mesh} is the merged geometry, used only when this is absent.
   */
  parts?: Array<{ name: string; mesh: ImportedMesh; subtype?: string | null }>
}

// The `Application: BambuStudio-…` metadata is what makes BambuStudio recognize the file as its
// own project (`is_bbl_3mf`). Without it the CLI refuses per-plate slicing ("not support to slice
// plate N, reset to 0") and drops per-plate custom G-code, so a from-scratch project (new-project
// scaffold or a generated calibration plate) must carry it, exactly like a saved Bambu file does.
export const NEW_PROJECT_MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
  '  <metadata name="Application">BambuStudio-02.07.01.57</metadata>',
  '  <metadata name="BambuStudio:3mfVersion">1</metadata>',
  '  <resources>',
  '  </resources>',
  '  <build>',
  '  </build>',
  '</model>'
].join('\n')

export const NEW_PROJECT_MODEL_SETTINGS_XML = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>', '</config>'].join('\n')

export const THREE_MF_CONTENT_TYPES_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
  '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
  '  <Default Extension="png" ContentType="image/png"/>',
  '  <Default Extension="config" ContentType="application/vnd.bambulab-package.settings+xml"/>',
  '</Types>'
].join('\n')

/**
 * The package relationships for an archive we build from scratch.
 *
 * The three thumbnail relationships mirror what BambuStudio's own exporter writes when a project
 * carries no explicit cover (`bbs_3mf.cpp:6829-6850`), TARGETS INCLUDED: it emits these same
 * `Metadata/plate_1.png` / `_small.png` defaults unconditionally, without checking that the entry
 * exists, and those are exactly the names `embedPlateThumbnails` writes. So this is copying the
 * engine's output rather than choosing a convention.
 *
 * Not load-bearing for any consumer we know of, which is why it went unnoticed: the importer falls
 * back to the `Metadata/plate_1.png` literal when the relationship is absent (`:1504`), the printer
 * file browser falls back to the plate's own `thumbnail_file`, and our readers resolve thumbnails by
 * name and never open this document. It is written because our fresh archives were the only files
 * in the wild missing it (33 of 33 real projects carry it), and a format divergence with no current
 * consumer is still one a stricter reader can find later.
 */
export const THREE_MF_RELS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '  <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
  '  <Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>',
  '  <Relationship Target="/Metadata/plate_1.png" Id="rel-4" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"/>',
  '  <Relationship Target="/Metadata/plate_1_small.png" Id="rel-5" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-small"/>',
  '</Relationships>'
].join('\n')

/**
 * The `/3D/Objects/*.model` ZIP entries holding the meshes of the given root objects (no leading
 * slash, ready for `readEntry`). Used by the independent-copy path, which must duplicate a source
 * object's mesh entry rather than reference it.
 */
export function subModelPathsForObjects(modelXml: string, objectIds: ReadonlySet<number>): Set<string> {
  const out = new Set<string>()
  for (const match of modelXml.matchAll(/<object\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    if (!objectIds.has(Number.parseInt(match[1] ?? '', 10))) continue
    for (const component of (match[2] ?? '').matchAll(/<component\b([^>]*)\/>/g)) {
      const path = parseAttrs(component[1] ?? '')['p:path']
      if (path) out.add(path.replace(/^\//, ''))
    }
  }
  return out
}

/**
 * Every `/3D/Objects/*.model` ZIP entry the root model references (no leading slash). Used by the
 * bake's copy pass to reach mesh entries it never loads into memory: e.g. re-keying colour paint
 * on a filament-slot permutation, which must visit EVERY mesh entry, not just the ones an edit
 * touched.
 */
export function allSubModelPaths(modelXml: string): Set<string> {
  const out = new Set<string>()
  for (const component of modelXml.matchAll(/<component\b([^>]*)\/>/g)) {
    const path = parseAttrs(component[1] ?? '')['p:path']
    if (path) out.add(path.replace(/^\//, ''))
  }
  return out
}

/** Sub-model relationships file: lists the `/3D/Objects/…model` part files the root model references. */
/** Slice metadata: per-plate `<filament>` entries carrying each material's sliced `group_id` (nozzle). */
/** Highest object/component id referenced anywhere in the base documents, so new ids never collide. */
function maxThreeMfObjectId(...xmls: string[]): number {
  let max = 0
  for (const xml of xmls) {
    for (const match of xml.matchAll(/\b(?:object)?id="(\d+)"/g)) {
      const id = Number.parseInt(match[1] ?? '', 10)
      if (Number.isInteger(id) && id > max) max = id
    }
  }
  return max
}

/** Resolve a host's base part ordinal to the mesh object and archive entry that owns it. */
function partMeshAddress(
  modelXml: string,
  modelSettingsXml: string,
  hostObjectId: number,
  partIndex: number
): { entryPath: string; objectId: number } {
  const host = [...modelXml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)]
    .find((match) => Number.parseInt(parseAttrs(match[1] ?? '').id ?? '', 10) === hostObjectId)
  const component = host ? [...(host[2] ?? '').matchAll(/<component\b([^>]*)\/>/g)][partIndex] : undefined
  const componentAttrs = parseAttrs(component?.[1] ?? '')
  const componentObjectId = Number.parseInt(componentAttrs.objectid ?? '', 10)
  if (Number.isInteger(componentObjectId)) {
    return {
      entryPath: componentAttrs['p:path']?.replace(/^\//, '') ?? '3D/3dmodel.model',
      objectId: componentObjectId
    }
  }

  // Inline-mesh objects have no components. Their settings parts are the volume list itself.
  const settingsObject = [...modelSettingsXml.matchAll(/<object\b([^>]*)>[\s\S]*?<\/object>/g)]
    .find((match) => Number.parseInt(parseAttrs(match[1] ?? '').id ?? '', 10) === hostObjectId)?.[0]
  const part = settingsObject ? [...settingsObject.matchAll(/<part\b([^>]*)>/g)][partIndex] : undefined
  const objectId = Number.parseInt(parseAttrs(part?.[1] ?? '').id ?? '', 10)
  if (!Number.isInteger(objectId)) throw new Error(`Part ${partIndex} of object ${hostObjectId} was not found`)
  if (objectId === hostObjectId) return { entryPath: '3D/3dmodel.model', objectId }
  return { entryPath: '3D/3dmodel.model', objectId }
}

/**
 * How many filaments the SOURCE project declared, or -1 when it says nothing.
 *
 * Used to tell an APPEND from an untouched list. An identity slot remap only says no existing slot
 * moved, and appending moves nothing, so the remap alone reports a grown list as stable and the
 * filament-indexed plate keys are carried at the old width. -1 for an unreadable source, which can
 * never equal a real length, so the keys drop rather than being carried against an unknown.
 */
function sourceFilamentCount(projectSettingsJson: string | null): number {
  if (!projectSettingsJson) return -1
  try {
    const parsed = JSON.parse(projectSettingsJson) as Record<string, unknown>
    return Array.isArray(parsed.filament_colour) ? parsed.filament_colour.length : -1
  } catch {
    return -1
  }
}

/** Assemble the two edited 3MF documents in the order required by their references. */
export function buildEditedThreeMfDocuments(
  baseModelXml: string,
  baseModelSettingsXml: string,
  projectSettingsJson: string | null,
  edit: SceneEdit,
  imports: ImportedObjectInput[],
  /** Source `/3D/Objects/*.model` bodies, needed only to copy an object independently. */
  subModelEntries: ReadonlyMap<string, string> = new Map()
): {
  modelXml: string
  modelSettingsXml: string
  importIdToObjectId: ReadonlyMap<string, number>
  partFileEntries: ImportedPartFileEntry[]
  clonedObjectIds: Array<{ originalObjectId: number; bakedObjectId: number }>
  /**
   * Per-object volume permutations this bake applied, base ordinals in their new order, for the
   * objects whose part layout actually changed.
   *
   * Surfaced because `cut_information.xml` addresses a connector by VOLUME ordinal, which a part
   * removal or reorder permutes; the caller remaps it. Empty for the overwhelmingly common save.
   */
  volumeLayouts: ReadonlyMap<number, number[]>
  /** Existing sub-model entries whose mesh payload changes during the streaming copy. */
  partMeshReplacementsByEntry: ReadonlyMap<string, ReadonlyMap<number, ImportedMesh>>
} {
  // When the source is a Production-Extension project, BambuStudio's GUI requires a p:UUID on every
  // injected object/component/build-item (see modelUsesProductionExtension); a fresh/core 3MF needs
  // none. Null disables UUID emission for the non-production case.
  const genUuid: (() => string) | null = modelUsesProductionExtension(baseModelXml) ? () => globalThis.crypto.randomUUID() : null
  // A save that PERMUTES the filament slots must re-key the BASE file's colour paint before
  // anything copies or builds on it: paint leaf states are 1-based filament ids, and a part the
  // session never painted otherwise streams its codes through in the OLD slot order: the painted
  // regions survive and silently print in whatever material now holds the old number. Done here,
  // ahead of the clone pre-pass, so independent copies duplicate re-keyed meshes; parts the session
  // DID paint arrive in the edit already re-keyed (`rebaseSceneEditFilamentIds`) and overwrite this
  // wholesale, so applying both is safe. Sub-entries the bake never loads are re-keyed by the copy
  // pass in `bake.ts` with this same map.
  const slotRemap = edit.filaments && edit.filaments.length > 0 ? filamentSlotIdRemap(edit.filaments) : null
  if (slotRemap && !isIdentityFilamentSlotRemap(slotRemap)) {
    baseModelXml = remapColorPaintInModelXml(baseModelXml, slotRemap)
    if (subModelEntries.size > 0) {
      const remapped = new Map<string, string>()
      for (const [entryPath, body] of subModelEntries) remapped.set(entryPath, remapColorPaintInModelXml(body, slotRemap))
      subModelEntries = remapped
    }
  }
  // Independent object copies FIRST: everything below (instances, paint, part edits, added parts)
  // addresses a copy by a negative placeholder, and this resolves those to real ids so the rest of
  // the pipeline only ever sees real objects. See the shared `three-mf/object-clone.ts`.
  const cloned = applyObjectClones(
    baseModelXml,
    baseModelSettingsXml,
    edit,
    maxThreeMfObjectId(baseModelXml, baseModelSettingsXml) + 1,
    genUuid,
    subModelEntries
  )
  baseModelXml = cloned.modelXml
  baseModelSettingsXml = cloned.modelSettingsXml
  edit = cloned.edit
  const importEdits = indexImportEdits(edit, imports)
  const importsById = importEdits.importsById
  const filamentToExtruder = buildFilamentToExtruderMap(baseModelSettingsXml)
  const materialized = materializeImportedObjects(
    importEdits,
    cloned.nextObjectId,
    genUuid,
    cloned.partFileEntries,
    filamentToExtruder
  )
  const { importIdToObjectId, meshObjects, settingsObjects, partFileEntries } = materialized

  const arranged = arrangeEditedInstances(edit, importIdToObjectId, projectSettingsJson)

  let modelXml = injectResourcesObjects(baseModelXml, meshObjects.join('\n'))
  modelXml = replaceThreeMfBuildSection(modelXml, renderArrangedBuildItems(arranged, genUuid))

  let modelSettingsXml = buildArrangedModelSettings(
    baseModelSettingsXml,
    settingsObjects,
    slotRemap,
    arranged,
    edit,
    projectSettingsJson
  )

  const meshReplacements = applyEditedPartMeshReplacements(
    modelXml,
    modelSettingsXml,
    edit,
    importsById
  )
  modelXml = meshReplacements.modelXml
  const partMeshReplacementsByEntry = meshReplacements.partMeshReplacementsByEntry

  const addedParts = attachEditedPartVolumes(
    modelXml,
    modelSettingsXml,
    edit,
    importIdToObjectId,
    materialized.nextObjectId,
    genUuid,
    filamentToExtruder
  )
  modelXml = addedParts.modelXml
  modelSettingsXml = addedParts.modelSettingsXml

  const swept = validateAndSweepPlacedObjects(modelXml, modelSettingsXml, arranged)
  modelXml = swept.modelXml
  modelSettingsXml = swept.modelSettingsXml

  const partEdits = applyPartScopedDocumentEdits(
    modelXml,
    modelSettingsXml,
    baseModelSettingsXml,
    edit,
    arranged
  )
  modelXml = partEdits.modelXml
  modelSettingsXml = partEdits.modelSettingsXml
  const volumeLayouts = partEdits.volumeLayouts

  if (edit.objectNames && edit.objectNames.length > 0) {
    const namesByObjectId = new Map<number, string>()
    for (const override of edit.objectNames) {
      const objectId = override.objectId ?? (override.importId != null ? importIdToObjectId.get(override.importId) : undefined)
      if (objectId != null) namesByObjectId.set(objectId, override.name)
    }
    if (namesByObjectId.size > 0) {
      modelSettingsXml = applyObjectNameOverrides(modelSettingsXml, namesByObjectId)
    }
  }

  // NOTE: the OLD-slot -> NEW-id part-extruder remap for a material add/remove happens on the
  // BASE model_settings BEFORE the bake-authored parts are injected (see above), so the imported
  // solids / added volumes / per-part reassignments keep the new-id extruders written for them.

  // The model_settings half of the staged settings repair (object-level extruder bindings), LAST
  // so it inspects the final part set every edit above produced. Inspect-gated, so an unaffected
  // document rides through untouched.
  //
  // This save IS the repair. A server-side repair route used to exist and was REMOVED on purpose:
  // repairs are explicit and user-driven, never applied behind the user's back. Do not reintroduce
  // one: rewriting a stored file outside a save the user asked for breaks the `repairs/index.ts`
  // contract that nothing heals at rest, and loses the pre-repair bytes that a new library version
  // is what preserves.
  //
  // Every flagged object is repairable, so a staged repair CLEARS the file: the saved bytes must
  // re-inspect clean. That holds on two conditions, BOTH of which have been broken here before and
  // are pinned by `settings-repair-roundtrip.test.ts`: the derivation must never decline a shape it
  // flagged (mixed part coverage used to be reported un-repairable), and the writer must never
  // decline a block the derivation accepted (an object head with no metadata to anchor on used to
  // be returned untouched while still being counted as repaired). Either one produces the same
  // user-visible failure: the button is pressed, the save succeeds, and the banner is back on the
  // next open.
  if (edit.repairSettings) {
    modelSettingsXml = repairModelSettingsObjectExtruders(modelSettingsXml).xml
  }

  return {
    modelXml,
    modelSettingsXml,
    importIdToObjectId,
    partFileEntries,
    clonedObjectIds: cloned.resolvedIds,
    volumeLayouts,
    partMeshReplacementsByEntry
  }
}

/**
 * Inject authored object and plate settings after remapping only base-file
 * filament references. Newly imported parts already use the new slot space,
 * so remapping them here would assign the wrong material.
 */
function buildArrangedModelSettings(
  baseModelSettingsXml: string,
  settingsObjects: readonly string[],
  slotRemap: ReturnType<typeof filamentSlotIdRemap> | null,
  arranged: ArrangedInstance[],
  edit: SceneEdit,
  projectSettingsJson: string | null
): string {
  // A material add/remove/reorder remaps each part's `extruder`, and the per-object/per-part
  // filament-index process overrides, from its OLD filament slot to the new id. This applies ONLY
  // to parts inherited from the BASE project: every part the bake authors below (imported solids
  // via `settingsObjects`, added volumes, per-part reassignments) is already written in the NEW
  // filament-id space, so it must not be remapped. Remapping the base HERE, before those parts
  // are injected, is what keeps a fresh multi-solid import's per-part materials from being
  // double-remapped and collapsed to filament 1. No-op when the filament set is unchanged.
  let baseModelSettingsForInject = baseModelSettingsXml
  if (slotRemap) {
    baseModelSettingsForInject = remapModelSettingsFilamentRefs(baseModelSettingsXml, slotRemap)
  }

  let modelSettingsXml = injectModelSettingsObjects(baseModelSettingsForInject, settingsObjects.join('\n'))
  modelSettingsXml = replaceModelSettingsPlates(
    modelSettingsXml,
    renderArrangedModelSettingsPlates(
      arranged,
      edit.plates,
      parseModelSettingsIdentifyIds(baseModelSettingsXml),
      parseSourcePlateMetadata(baseModelSettingsXml),
      // The filament-scoped plate keys are positional over the filament list, so they only survive
      // while that list is untouched. An edit with no filament list changes nothing about it.
      //
      // BOTH halves are needed. An identity remap only says no slot MOVED; appending a material
      // leaves slots 1..n mapping to themselves, so the remap alone reports "stable" and the keys
      // are carried at the OLD width against a longer filament list. Measured on a real 8-material
      // project: adding a 9th kept `filament_maps` and `first_layer_print_sequence` 8 entries wide,
      // which is the same one-per-filament-array-left-short defect this file repairs elsewhere.
      // A slot the edit did not carry over contributes no remap entry, so comparing the list length
      // against the remap size catches an add, and a removal or reorder already fails the identity
      // test.
      edit.filaments == null || (
        isIdentityFilamentSlotRemap(filamentSlotIdRemap(edit.filaments))
        && edit.filaments.length === sourceFilamentCount(projectSettingsJson)
      ),
      // Keyed on the KEY being PRESENT, not on it having a value. A client that authors per-plate
      // bed types always sends it (null when the project states none), so a blank global still
      // authors the plates; testing truthiness instead made an unseeded machine target silently
      // DELETE every per-plate bed type in the file, since the carry no longer covers `bed_type`.
      edit.plateType !== undefined
    )
  )

  return modelSettingsXml
}

/**
 * Replace root-model meshes immediately and record sub-model replacements
 * for the archive copy. The host part metadata and ordinal stay unchanged.
 */
function applyEditedPartMeshReplacements(
  modelXml: string,
  modelSettingsXml: string,
  edit: SceneEdit,
  importsById: ReturnType<typeof indexImportEdits>['importsById']
): {
  modelXml: string
  partMeshReplacementsByEntry: Map<string, Map<number, ImportedMesh>>
} {
  // Replace a baked volume in place. The model-settings part and host component are untouched, so
  // its ordinal, subtype, name, process metadata and object-local transform all remain authoritative.
  const partMeshReplacementsByEntry = new Map<string, Map<number, ImportedMesh>>()
  for (const replacement of edit.partMeshReplacements ?? []) {
    const imported = importsById.get(replacement.meshImportId)
    if (!imported) throw new Error('Scene edit references an unknown part replacement mesh')
    const address = partMeshAddress(modelXml, modelSettingsXml, replacement.objectId, replacement.partIndex)
    if (address.entryPath === '3D/3dmodel.model') {
      modelXml = replaceObjectMeshInModelXml(modelXml, address.objectId, imported.mesh)
      continue
    }
    const byObject = partMeshReplacementsByEntry.get(address.entryPath) ?? new Map<number, ImportedMesh>()
    byObject.set(address.objectId, imported.mesh)
    partMeshReplacementsByEntry.set(address.entryPath, byObject)
  }

  return { modelXml, partMeshReplacementsByEntry }
}

/**
 * Attach added part volumes after imports have real object ids and before
 * the first unreferenced-object sweep. The new component reference is what
 * keeps each added part's mesh alive.
 */
function attachEditedPartVolumes(
  modelXml: string,
  modelSettingsXml: string,
  edit: SceneEdit,
  importIdToObjectId: ReadonlyMap<string, number>,
  nextObjectId: number,
  genUuid: (() => string) | null,
  filamentToExtruder: ReadonlyMap<number, number>
): { modelXml: string; modelSettingsXml: string } {
  // Attach added part volumes BEFORE the unreferenced-object sweep: a part mesh is
  // only kept alive by the <component> reference inserted here.
  if (edit.addedParts && edit.addedParts.length > 0) {
    // Resolved HERE because an entry may name an IMPORT, whose object id only exists once the
    // imports above have been baked; the flag then travels as a plain baked-id set.
    const removedBodies = new Set<number>()
    for (const entry of edit.removedObjectBodies ?? []) {
      const objectId = entry.objectId ?? (entry.importId != null ? importIdToObjectId.get(entry.importId) : undefined)
      if (objectId != null) removedBodies.add(objectId)
    }
    const applied = applyAddedParts(modelXml, modelSettingsXml, edit.addedParts, importIdToObjectId, () => {
      const id = nextObjectId
      nextObjectId += 1
      return id
    }, genUuid, filamentToExtruder, removedBodies)
    modelXml = applied.modelXml
    modelSettingsXml = applied.modelSettingsXml
  }

  return { modelXml, modelSettingsXml }
}

/**
 * Apply existing-part edits in ordinal order, then remove or reorder volumes.
 * Every earlier edit addresses base-file ordinals; moving a part first would
 * silently retarget filament, process, type, or transform changes. A removal
 * also requires a second geometry sweep after its component reference is gone.
 */
function applyPartScopedDocumentEdits(
  modelXml: string,
  modelSettingsXml: string,
  baseModelSettingsXml: string,
  edit: SceneEdit,
  arranged: readonly ArrangedInstance[]
): { modelXml: string; modelSettingsXml: string; volumeLayouts: ReadonlyMap<number, number[]> } {
  if (edit.partFilaments && edit.partFilaments.length > 0) {
    modelSettingsXml = applyPartFilamentOverrides(modelSettingsXml, baseModelSettingsXml, edit.partFilaments, modelXml)
  }

  if (edit.partProcessOverrides && edit.partProcessOverrides.length > 0) {
    modelSettingsXml = applyPartProcessOverrides(modelSettingsXml, edit.partProcessOverrides, modelXml)
  }

  if (edit.partTypeChanges && edit.partTypeChanges.length > 0) {
    modelSettingsXml = applyPartTypeChanges(modelSettingsXml, edit.partTypeChanges, modelXml)
  }

  if (edit.partTransforms && edit.partTransforms.length > 0) {
    const applied = applyPartTransforms(modelXml, modelSettingsXml, edit.partTransforms)
    modelXml = applied.modelXml
    modelSettingsXml = applied.modelSettingsXml
  }

  // LAST of the part-scoped appliers, deliberately: every one above addresses base-file ordinals,
  // so moving or removing a part before them would shift the ordinals under their feet and silently
  // retarget each edit onto the neighbouring volume. Removals and the reorder go together in ONE
  // pass for the same reason applied to each other. See `sceneEditRemovedPartSchema`.
  const removedParts = edit.removedParts ?? []
  const partOrder = edit.partOrder ?? []
  let volumeLayouts: ReadonlyMap<number, number[]> = new Map()
  if (removedParts.length > 0 || partOrder.length > 0) {
    const applied = applyPartLayout(modelXml, modelSettingsXml, removedParts, partOrder)
    modelXml = applied.modelXml
    modelSettingsXml = applied.modelSettingsXml
    volumeLayouts = applied.volumeLayouts
  }
  if (removedParts.length > 0) {
    // A removed `<component>` was the only reference keeping its mesh object alive, so sweep again
    // rather than shipping the orphaned geometry. The sweep is idempotent and seeded from the same
    // placed-object set as the pass above. A pure REORDER references every mesh it started with, so
    // it needs no sweep.
    const swept = removeUnreferencedObjects(modelXml, modelSettingsXml, new Set(arranged.map((instance) => instance.objectId)))
    modelXml = swept.modelXml
    modelSettingsXml = swept.modelSettingsXml
  }

  return { modelXml, modelSettingsXml, volumeLayouts }
}


/**
 * Set (or insert) an `<object>`'s object-level `name` metadata. The object's name sits
 * between the `<object ...>` opening tag and its first `<part>`; part-level names (mesh
 * components) are left untouched, matching how Bambu Studio renames an object.
 */
function setObjectNameMetadata(objectBlock: string, name: string): string {
  const metadata = `<metadata key="name" value="${escapeXmlAttribute(name)}"/>`
  const firstPartIndex = objectBlock.search(/<part\b/)
  const head = firstPartIndex >= 0 ? objectBlock.slice(0, firstPartIndex) : objectBlock
  const tail = firstPartIndex >= 0 ? objectBlock.slice(firstPartIndex) : ''
  if (/<metadata\s+key="name"\s+value="[^"]*"\s*\/>/.test(head)) {
    return head.replace(/<metadata\s+key="name"\s+value="[^"]*"\s*\/>/, metadata) + tail
  }
  // No existing object-level name: insert one right after the opening <object ...> tag.
  return objectBlock.replace(/^(<object\b[^>]*>)/, `$1\n    ${metadata}`)
}

/**
 * Apply per-object display-name overrides by rewriting the matching `<object>`s'
 * object-level `name` metadata inside `model_settings.config`. Keyed by resolved
 * objectId; every other part of the document is left untouched.
 */
function applyObjectNameOverrides(modelSettingsXml: string, namesByObjectId: Map<number, string>): string {
  return modelSettingsXml.replace(/<object\b([^>]*)>[\s\S]*?<\/object>/g, (objectBlock, attrs: string) => {
    const objectId = Number.parseInt(parseAttrs(attrs).id ?? '', 10)
    const name = namesByObjectId.get(objectId)
    return name == null ? objectBlock : setObjectNameMetadata(objectBlock, name)
  })
}

export {
  applyFilamentList,
  applyNozzleAssignmentToProjectSettings,
  rewriteSliceInfoNozzleGroups
} from './bake-filament-settings.js'

export { applyTrianglePaintToModelEntry, resolvePartPaintByEntry, resolveRepairMeshesByEntry } from './bake-paint-and-repair.js'

export { customGcodePlateIds, mergeCustomGcodePerLayer, remapCustomGcodeFilamentIds } from './bake-custom-gcode.js'

/**
 * Serialize per-object manual brim ears into BambuStudio's `brim_ear_points.txt`
 * format: a version header plus one `object_id=<1-based root-object ordinal>|x y z r ...`
 * line per object with ears. Returns '' when nothing serializes (clears the file).
 */
export function serializeBrimEarPoints(brimEars: SceneEditObjectBrimEars[], modelXml: string): string {
  const ordinalByObjectId = new Map<number, number>()
  parseRootModelObjectIdOrder(modelXml).forEach((id, index) => {
    if (!ordinalByObjectId.has(id)) ordinalByObjectId.set(id, index + 1)
  })
  const lines: string[] = []
  for (const entry of brimEars) {
    const ordinal = ordinalByObjectId.get(entry.objectId)
    if (!ordinal || entry.points.length === 0) continue
    const points = entry.points
      .map((point) => `${point.x.toFixed(6)} ${point.y.toFixed(6)} ${point.z.toFixed(6)} ${point.radius.toFixed(6)}`)
      .join(' ')
    lines.push(`object_id=${ordinal}|${points}`)
  }
  if (lines.length === 0) return ''
  return `brim_points_format_version=0\n${lines.join('\n')}\n`
}
