/**
 * Independent object copies for the 3MF bake — BambuStudio's copy/paste semantics.
 *
 * BambuStudio distinguishes two ways to have "another one of these", and so do we:
 * placing a second instance against the same `objectId` is a LINKED copy (BS's toolbar "+" /
 * `increase_instances`, which adds a `ModelInstance` to the same `ModelObject` — one mesh, shared
 * parts, materials, paint, and per-object config), while an INDEPENDENT copy is a whole new object
 * (BS's Ctrl+C/V, `Model::add_object(*src_object)`). This module owns the second one.
 *
 * **Contract.** {@link applyObjectClones} runs as a PRE-PASS, before any other edit is applied. For
 * each {@link SceneEditObjectClone} it deep-copies the source object — its mesh or its whole
 * `<components>` subtree, plus every component object those reference, plus its
 * `model_settings.config` entry (parts with subtypes/extruders/per-part config, and the object's own
 * config) — into freshly allocated ids. It then returns the edit rewritten so the copy's NEGATIVE
 * placeholder id is replaced by the new real object id, and every per-part reference to a SOURCE
 * component id is replaced by the copy's corresponding new component id.
 *
 * That rewrite is the whole reason the rest of the pipeline needed no clone-specific code: by the
 * time `buildEditedThreeMfDocuments` applies instances, paint, part transforms, added parts,
 * per-object overrides and the rest, every id it sees is real.
 *
 * **Invariant:** a placeholder that no clone declares is an error, not a silently dropped edit —
 * a dangling negative id would otherwise bake as a missing object and lose the user's copy.
 *
 * Counterpart on the web side: `EditorInstanceSource` kind `clone` in
 * `apps/web/src/plugins/model-studio/lib/editorModel.ts`, which mints the placeholders.
 */
import type { SceneEdit } from '@printstream/shared'
import { escapeXmlAttribute } from './three-mf-internal.js'
import { parseAttrs } from './three-mf-reader.js'

/** Ids allocated for one copied object: the root, plus source component id -> copy component id. */
interface ClonedObjectIds {
  objectId: number
  components: Map<number, number>
}

export interface ObjectCloneResult {
  modelXml: string
  modelSettingsXml: string
  /** The edit with every clone placeholder + source component id resolved to real ids. */
  edit: SceneEdit
  /** Next free 3MF object id after the copies were allocated. */
  nextObjectId: number
  /**
   * New `/3D/Objects/*.model` sub-model files holding the copies' meshes, for projects that use the
   * Production-Extension split layout. The caller writes them to the ZIP and declares them in
   * `3D/_rels/3dmodel.model.rels`, exactly as it does for split-out imports.
   */
  partFileEntries: Array<{ name: string; content: string }>
  /**
   * Each copy's placeholder id and the real `object_id` it baked as. Callers that key per-object
   * data by id OUTSIDE the `SceneEdit` — per-object process overrides, which ride the save/slice
   * request rather than the edit — re-key through this, exactly as they do for a replaced object.
   */
  resolvedIds: Array<{ originalObjectId: number; bakedObjectId: number }>
}

/** A sub-model part file body, matching the layout BambuStudio writes for a split-out object. */
function renderClonePartFileModel(meshObjectXmls: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">',
    ' <metadata name="BambuStudio:3mfVersion">1</metadata>',
    ' <resources>',
    ...meshObjectXmls,
    ' </resources>',
    ' <build/>',
    '</model>',
    ''
  ].join('\n')
}

/** Extract `<object id="N" …>…</object>` from a model document, or null when absent. */
function findObjectBlock(xml: string, objectId: number): string | null {
  const match = xml.match(new RegExp(`<object\\b[^>]*\\bid="${objectId}"[^>]*>[\\s\\S]*?</object>`))
  return match?.[0] ?? null
}

/**
 * The components an `<object>` block references, in document order: the target object id plus the
 * `p:path` sub-model it lives in (null when the mesh is inline in the same document).
 */
function referencedComponents(objectXml: string): Array<{ objectId: number; path: string | null }> {
  const out: Array<{ objectId: number; path: string | null }> = []
  for (const match of objectXml.matchAll(/<component\b([^>]*)\/>/g)) {
    const attrs = parseAttrs(match[1] ?? '')
    const id = Number.parseInt(attrs.objectid ?? '', 10)
    if (Number.isInteger(id)) out.push({ objectId: id, path: attrs['p:path'] ?? null })
  }
  return out
}

/** Rewrite an `<object>` block's own id, leaving everything else untouched. */
function withObjectId(objectXml: string, objectId: number): string {
  return objectXml.replace(/(<object\b[^>]*\bid=")\d+(")/, `$1${objectId}$2`)
}

/**
 * Copy one object (and everything it references) into fresh ids.
 *
 * A Bambu object is either mesh-bearing or a `<components>` assembly whose parts are separate
 * objects; both shapes are copied, and the assembly's component references are re-pointed at the
 * copied part objects so the two objects never share a resource. Production-extension `p:UUID`
 * attributes are dropped from the copies and re-minted by the caller's `genUuid` where required —
 * a duplicated UUID is invalid and BambuStudio's loader rejects it.
 */
function cloneObjectXml(
  modelXml: string,
  sourceObjectId: number,
  allocate: () => number,
  genUuid: (() => string) | null,
  subModelEntries: ReadonlyMap<string, string>
): { objectsXml: string[]; partFileMeshes: string[]; ids: ClonedObjectIds } | null {
  const sourceBlock = findObjectBlock(modelXml, sourceObjectId)
  if (!sourceBlock) return null
  const objectId = allocate()
  const components = new Map<number, number>()
  const objectsXml: string[] = []
  // Meshes copied out of a sub-model part file; the caller writes these into the copy's OWN
  // `/3D/Objects` entry so the two objects never share a mesh resource.
  const partFileMeshes: string[] = []

  for (const component of referencedComponents(sourceBlock)) {
    if (components.has(component.objectId)) continue
    // A Bambu project keeps each object's mesh in its own `/3D/Objects/*.model`, referenced by
    // `p:path`; a from-scratch or flattened project keeps it inline in the root. Copy from
    // whichever holds it. Sharing the source's mesh would be a silent trap rather than an
    // optimisation: paint and mesh repair are applied per (entry, object id), so painting the
    // copy would repaint its source.
    const sourceXml = component.path
      ? subModelEntries.get(component.path.replace(/^\//, ''))
      : modelXml
    const componentBlock = sourceXml ? findObjectBlock(sourceXml, component.objectId) : null
    if (!componentBlock) continue
    const newComponentId = allocate()
    components.set(component.objectId, newComponentId)
    const copied = refreshUuids(withObjectId(componentBlock, newComponentId), genUuid)
    if (component.path) partFileMeshes.push(copied)
    else objectsXml.push(copied)
  }

  let rootXml = withObjectId(sourceBlock, objectId)
  // Re-point the copy's component references at the copied part objects.
  rootXml = rootXml.replace(/(<component\b[^>]*\bobjectid=")(\d+)(")/g, (match, head: string, id: string, tail: string) => {
    const mapped = components.get(Number.parseInt(id, 10))
    return mapped == null ? match : `${head}${mapped}${tail}`
  })
  objectsXml.push(refreshUuids(rootXml, genUuid))
  return { objectsXml, partFileMeshes, ids: { objectId, components } }
}

/** Replace every `p:UUID` in a copied block with a fresh one (or strip them when unused). */
function refreshUuids(xml: string, genUuid: (() => string) | null): string {
  return xml.replace(/\sp:UUID="[^"]*"/g, () => (genUuid ? ` p:UUID="${genUuid()}"` : ''))
}

/**
 * Copy an object's `model_settings.config` entry, re-keying the object id and every `<part id>` to
 * the copy's ids. Parts whose component id was not copied (sub-model components) keep their id, so
 * the entry still describes real parts.
 */
function cloneModelSettingsEntry(modelSettingsXml: string, sourceObjectId: number, ids: ClonedObjectIds): string | null {
  const match = modelSettingsXml.match(new RegExp(`<object\\b[^>]*\\bid="${sourceObjectId}"[^>]*>[\\s\\S]*?</object>`))
  if (!match) return null
  let entry = match[0].replace(/(<object\b[^>]*\bid=")\d+(")/, `$1${ids.objectId}$2`)
  entry = entry.replace(/(<part\b[^>]*\bid=")(\d+)(")/g, (partMatch, head: string, id: string, tail: string) => {
    const mapped = ids.components.get(Number.parseInt(id, 10))
    return mapped == null ? partMatch : `${head}${mapped}${tail}`
  })
  return entry
}

/** Resolve one addressed object id through the clone map (a positive id passes through). */
function resolveObjectId(objectId: number, clones: ReadonlyMap<number, ClonedObjectIds>): number {
  return clones.get(objectId)?.objectId ?? objectId
}

/** Resolve a part reference: both the owning object and, for a copy, the part's component id. */
function resolvePart<T extends { objectId: number; componentObjectId: number }>(
  entry: T,
  clones: ReadonlyMap<number, ClonedObjectIds>
): T {
  const clone = clones.get(entry.objectId)
  if (!clone) return entry
  return {
    ...entry,
    objectId: clone.objectId,
    componentObjectId: clone.components.get(entry.componentObjectId) ?? entry.componentObjectId
  }
}

/**
 * Materialise the edit's independent object copies and return the edit with every clone
 * placeholder resolved. A no-op (same documents, same edit) when the edit declares no clones.
 *
 * Throws when a clone names a source object the base project does not contain — the user's copy
 * would otherwise bake as nothing.
 */
export function applyObjectClones(
  modelXml: string,
  modelSettingsXml: string,
  edit: SceneEdit,
  nextObjectId: number,
  genUuid: (() => string) | null,
  /** Source `/3D/Objects/*.model` bodies by ZIP entry path, for projects using the split layout. */
  subModelEntries: ReadonlyMap<string, string> = new Map()
): ObjectCloneResult {
  const declared = edit.objectClones ?? []
  if (declared.length === 0) {
    return { modelXml, modelSettingsXml, edit, nextObjectId, partFileEntries: [], resolvedIds: [] }
  }

  let allocated = nextObjectId
  const allocate = (): number => {
    const id = allocated
    allocated += 1
    return id
  }

  const clones = new Map<number, ClonedObjectIds>()
  const newObjectsXml: string[] = []
  const newSettingsXml: string[] = []
  const partFileEntries: Array<{ name: string; content: string }> = []
  for (const clone of declared) {
    if (clones.has(clone.objectId)) continue
    const copied = cloneObjectXml(modelXml, clone.sourceObjectId, allocate, genUuid, subModelEntries)
    if (!copied) {
      throw new Error(`Scene edit copies a missing object ${clone.sourceObjectId}`)
    }
    clones.set(clone.objectId, copied.ids)
    if (copied.partFileMeshes.length > 0) {
      // The copy's meshes get their own sub-model entry, and its root object's components are
      // re-pointed at it — otherwise both objects would name the SOURCE's part file.
      const partFilePath = `3D/Objects/printstream_object_${copied.ids.objectId}.model`
      partFileEntries.push({ name: partFilePath, content: renderClonePartFileModel(copied.partFileMeshes) })
      const repathed = copied.objectsXml.map((xml) => xml.replace(
        /(<component\b[^>]*\bp:path=")[^"]*(")/g,
        `$1/${escapeXmlAttribute(partFilePath)}$2`
      ))
      newObjectsXml.push(...repathed)
    } else {
      newObjectsXml.push(...copied.objectsXml)
    }
    const settingsEntry = cloneModelSettingsEntry(modelSettingsXml, clone.sourceObjectId, copied.ids)
    if (settingsEntry) newSettingsXml.push(settingsEntry)
  }

  const resolvedModelXml = newObjectsXml.length > 0
    ? modelXml.replace(/<\/resources>/, `${newObjectsXml.join('\n')}\n  </resources>`)
    : modelXml
  const resolvedSettingsXml = newSettingsXml.length > 0
    ? (/<\/config>/.test(modelSettingsXml)
        ? modelSettingsXml.replace(/<\/config>/, `${newSettingsXml.join('\n')}\n</config>`)
        : `${modelSettingsXml.trimEnd()}\n${newSettingsXml.join('\n')}\n`)
    : modelSettingsXml

  const unresolved = (objectId: number | undefined): boolean => objectId != null && objectId < 0 && !clones.has(objectId)
  for (const instance of edit.instances) {
    if (unresolved(instance.objectId)) {
      throw new Error(`Scene edit places an undeclared object copy ${instance.objectId}`)
    }
  }

  return {
    modelXml: resolvedModelXml,
    modelSettingsXml: resolvedSettingsXml,
    nextObjectId: allocated,
    partFileEntries,
    resolvedIds: [...clones].map(([originalObjectId, ids]) => ({ originalObjectId, bakedObjectId: ids.objectId })),
    edit: {
      ...edit,
      objectClones: undefined,
      instances: edit.instances.map((instance) => (instance.objectId != null
        ? { ...instance, objectId: resolveObjectId(instance.objectId, clones) }
        : instance)),
      ...(edit.partFilaments ? { partFilaments: edit.partFilaments.map((entry) => resolvePart(entry, clones)) } : {}),
      ...(edit.partProcessOverrides ? { partProcessOverrides: edit.partProcessOverrides.map((entry) => resolvePart(entry, clones)) } : {}),
      ...(edit.partTypeChanges ? { partTypeChanges: edit.partTypeChanges.map((entry) => resolvePart(entry, clones)) } : {}),
      ...(edit.partTransforms ? { partTransforms: edit.partTransforms.map((entry) => resolvePart(entry, clones)) } : {}),
      ...(edit.supportPaint ? { supportPaint: edit.supportPaint.map((entry) => resolvePart(entry, clones)) } : {}),
      ...(edit.seamPaint ? { seamPaint: edit.seamPaint.map((entry) => resolvePart(entry, clones)) } : {}),
      ...(edit.colorPaint ? { colorPaint: edit.colorPaint.map((entry) => resolvePart(entry, clones)) } : {}),
      ...(edit.brimEars
        ? { brimEars: edit.brimEars.map((entry) => ({ ...entry, objectId: resolveObjectId(entry.objectId, clones) })) }
        : {}),
      ...(edit.objectNames
        ? {
          objectNames: edit.objectNames.map((entry) => (entry.objectId != null
            ? { ...entry, objectId: resolveObjectId(entry.objectId, clones) }
            : entry))
        }
        : {}),
      ...(edit.addedParts
        ? {
          addedParts: edit.addedParts.map((part) => (part.objectId != null
            ? { ...part, objectId: resolveObjectId(part.objectId, clones) }
            : part))
        }
        : {}),
      // Mesh repair and per-object process overrides are keyed by object id alone.
      ...(edit.repairedObjectIds
        ? { repairedObjectIds: edit.repairedObjectIds.map((objectId) => resolveObjectId(objectId, clones)) }
        : {})
    }
  }
}

/** The clone placeholder -> source object id map, for callers that key per-object data by id. */
export function objectCloneSources(edit: SceneEdit): ReadonlyMap<number, number> {
  return new Map((edit.objectClones ?? []).map((clone) => [clone.objectId, clone.sourceObjectId]))
}
