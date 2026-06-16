/**
 * 3MF scene-builder: bake an editor arrangement (a `SceneEdit`) into a 3MF on disk.
 *
 * This is the editor's write path. {@link buildEditedThreeMf} takes a base project (or builds one
 * from scratch), injects any imported STL/STEP meshes as new `<object><mesh>` resources, and
 * regenerates the `3D/3dmodel.model` build items plus the `model_settings.config` plates/instances
 * so moved/rotated/scaled/cloned/re-plated objects and per-object printability are honored at slice
 * time; existing geometry is copied verbatim. {@link writeArrangedThreeMf} is the thin in-project
 * wrapper (no foreign imports). Filament-set and prime-tower edits are applied to
 * `project_settings.config`. {@link threeMfTransformFromTRS} is the exact inverse of the reader's
 * scene decomposition, so an unedited round-trip reproduces the source placement.
 *
 * Depends on the reader for parse helpers and on three-mf-internal for ZIP I/O; nothing depends on
 * this module except the public three-mf barrel.
 */
import { createWriteStream } from 'node:fs'
import { type SceneEdit, type SceneEditFilament, type SceneEditObjectBrimEars, type SceneEditPartFilament, type SceneEditPartPaint, type SceneEditPlateFilamentChanges } from '@printstream/shared'
import yauzl, { type Entry } from 'yauzl'
import yazl from 'yazl'
import type { ImportedMesh } from './mesh-import.js'
import { escapeXmlAttribute, readEntry, readZipEntryBuffer } from './three-mf-internal.js'
import { BRIM_EAR_POINTS_ENTRY, CUSTOM_GCODE_PER_LAYER_ENTRY, extractPlateType, extractSceneBed, LOGICAL_PART_PLATE_GAP, normalizeColor, parseAttrs, parseModelSettingsScene, parseRootModelComponents, parseRootModelObjectIdOrder } from './three-mf-reader.js'

/**
 * Compose a 12-element 3MF transform (column-major 3x3 followed by translation) from a decomposed
 * translation/rotation/scale, matching three.js' `Matrix4 = T · R(euler 'XYZ') · S`. This is the
 * exact inverse of how the editor decomposes {@link ThreeMfSceneInstance.transform} into its gizmo
 * state, so an unedited round-trip reproduces the source placement.
 */
export function threeMfTransformFromTRS(
  position: { x: number; y: number; z: number },
  rotation: { x: number; y: number; z: number },
  scale: { x: number; y: number; z: number }
): number[] {
  const a = Math.cos(rotation.x)
  const b = Math.sin(rotation.x)
  const c = Math.cos(rotation.y)
  const d = Math.sin(rotation.y)
  const e = Math.cos(rotation.z)
  const f = Math.sin(rotation.z)
  const ae = a * e
  const af = a * f
  const be = b * e
  const bf = b * f

  // Rotation columns (column-major), per three.js makeRotationFromEuler order 'XYZ'.
  const r00 = c * e
  const r10 = af + be * d
  const r20 = bf - ae * d
  const r01 = -c * f
  const r11 = ae - bf * d
  const r21 = be + af * d
  const r02 = d
  const r12 = -b * c
  const r22 = a * c

  return [
    r00 * scale.x, r10 * scale.x, r20 * scale.x,
    r01 * scale.y, r11 * scale.y, r21 * scale.y,
    r02 * scale.z, r12 * scale.z, r22 * scale.z,
    position.x, position.y, position.z
  ].map((value) => (value === 0 ? 0 : value))
}

interface ArrangedInstance {
  objectId: number
  instanceId: number
  plateIndex: number
  /** Global build-item transform (plate-grid origin re-added). */
  transform: number[]
  /** BambuStudio "Printable" flag; false → write `printable="0"` (greyed, excluded from slice). */
  printable?: boolean
}

/**
 * Reproduce BambuStudio's plate-grid layout so the writer maps each plate's plate-local
 * placements back to the exact global build coordinates BambuStudio expects for that plate.
 *
 * BambuStudio (`PartPlateList::compute_shape_position`/`compute_colum_count`, PartPlate.cpp) lays
 * plates out row-major in a square-ish grid: the column count is `round(sqrt(n))` (rounded up when
 * the root isn't clean), and the plate at 0-based position `i` sits at column `i % cols`, row
 * `i / cols`, each cell offset by a per-axis stride of `bed * (1 + 1/5)` (rows grow toward −Y).
 * Slicing a plate checks its objects fall inside that plate's grid cell, so an origin that does not
 * match the grid pushes later plates outside the print volume (slicer exit 206) — the previous
 * single-row layout did exactly that for the 3rd+ plate. The scene reader removes this same offset
 * (see {@link resolveProjectPlateOrigin}) to give the editor plate-local coordinates.
 */
function computePlateOrigins(
  plates: SceneEdit['plates'],
  plateWidth: number,
  plateDepth: number
): Map<number, { x: number; y: number }> {
  const ordered = [...plates].sort((left, right) => left.index - right.index)
  const cols = computePlateColumnCount(ordered.length)
  const strideX = plateWidth * (1 + LOGICAL_PART_PLATE_GAP)
  const strideY = plateDepth * (1 + LOGICAL_PART_PLATE_GAP)
  const origins = new Map<number, { x: number; y: number }>()
  ordered.forEach((plate, position) => {
    const col = position % cols
    const row = Math.floor(position / cols)
    origins.set(plate.index, { x: col * strideX, y: -row * strideY })
  })
  return origins
}

/**
 * BambuStudio's `compute_colum_count`: arrange plates in a square-ish grid, rounding the column
 * count up when the plate count isn't a perfect square (e.g. 1→1, 2→2, 4→2, 5→3, 9→3, 36→6).
 */
function computePlateColumnCount(count: number): number {
  if (count <= 1) return 1
  const value = Math.sqrt(count)
  const rounded = Math.round(value)
  return value > rounded ? rounded + 1 : rounded
}

/** A scene-edit instance whose geometry reference has been resolved to a concrete object id. */
interface ResolvedEditInstance {
  objectId: number
  plateIndex: number
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
  /** Full local transform (12 numbers); used verbatim when present. */
  matrix?: number[]
  /** BambuStudio "Printable" flag; false → written as `printable="0"` on the build item. */
  printable?: boolean
}

function assignArrangedInstances(instances: ResolvedEditInstance[], origins: Map<number, { x: number; y: number }>): ArrangedInstance[] {
  const instanceCounters = new Map<number, number>()
  const arranged: ArrangedInstance[] = []
  for (const instance of instances) {
    const instanceId = instanceCounters.get(instance.objectId) ?? 0
    instanceCounters.set(instance.objectId, instanceId + 1)
    const origin = origins.get(instance.plateIndex) ?? { x: 0, y: 0 }
    // A full matrix (world-space scale can shear) takes precedence over T*R*S.
    const local = instance.matrix && instance.matrix.length === 12
      ? [...instance.matrix]
      : threeMfTransformFromTRS(instance.position, instance.rotation, instance.scale)
    local[9] = (local[9] ?? 0) + origin.x
    local[10] = (local[10] ?? 0) + origin.y
    arranged.push({ objectId: instance.objectId, instanceId, plateIndex: instance.plateIndex, transform: local, printable: instance.printable })
  }
  return arranged
}

function formatThreeMfTransformValue(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

function renderArrangedBuildItems(arranged: ArrangedInstance[]): string {
  // Emit items grouped by object so each object's items appear in instance-id order, which is how
  // {@link parseRootBuildItemTransforms} indexes them back to instances.
  const byObject = new Map<number, ArrangedInstance[]>()
  for (const instance of arranged) {
    const list = byObject.get(instance.objectId) ?? []
    list.push(instance)
    byObject.set(instance.objectId, list)
  }
  const lines: string[] = []
  for (const list of byObject.values()) {
    for (const instance of [...list].sort((left, right) => left.instanceId - right.instanceId)) {
      const transform = instance.transform.map(formatThreeMfTransformValue).join(' ')
      // BambuStudio's per-object "Printable" toggle: a skipped instance is kept in the 3MF
      // (re-enableable) but marked printable="0", which greys it and excludes it from the slice.
      const printable = instance.printable === false ? '0' : '1'
      lines.push(`    <item objectid="${instance.objectId}" transform="${transform}" printable="${printable}"/>`)
    }
  }
  return lines.join('\n')
}

function replaceThreeMfBuildSection(modelXml: string, buildItemsXml: string): string {
  const body = buildItemsXml ? `\n${buildItemsXml}\n  ` : ''
  if (/<build\b[^>]*>[\s\S]*?<\/build>/.test(modelXml)) {
    return modelXml.replace(/<build\b([^>]*)>[\s\S]*?<\/build>/, (_full, attrs: string) => `<build${attrs}>${body}</build>`)
  }
  // No build section (rare): insert one before the closing model tag.
  return modelXml.replace(/<\/model>\s*$/, `  <build>${body}</build>\n</model>\n`)
}

function renderArrangedModelSettingsPlates(arranged: ArrangedInstance[], plates: SceneEdit['plates']): string {
  const instancesByPlate = new Map<number, ArrangedInstance[]>()
  for (const instance of arranged) {
    const list = instancesByPlate.get(instance.plateIndex) ?? []
    list.push(instance)
    instancesByPlate.set(instance.plateIndex, list)
  }
  const ordered = [...plates].sort((left, right) => left.index - right.index)
  const blocks = ordered.map((plate) => {
    const lines = [`  <plate>`, `    <metadata key="plater_id" value="${plate.index}"/>`]
    if (plate.name) lines.push(`    <metadata key="plater_name" value="${escapeXmlAttribute(plate.name)}"/>`)
    for (const instance of instancesByPlate.get(plate.index) ?? []) {
      lines.push(
        `    <model_instance>`,
        `      <metadata key="object_id" value="${instance.objectId}"/>`,
        `      <metadata key="instance_id" value="${instance.instanceId}"/>`,
        `    </model_instance>`
      )
    }
    lines.push(`  </plate>`)
    return lines.join('\n')
  })
  return blocks.join('\n')
}

function replaceModelSettingsPlates(xml: string, platesXml: string): string {
  const withoutPlates = xml.replace(/[ \t]*<plate\b[^>]*>[\s\S]*?<\/plate>\n?/g, '')
  const insertion = platesXml ? `${platesXml}\n` : ''
  if (/<\/config>/.test(withoutPlates)) {
    return withoutPlates.replace(/<\/config>/, `${insertion}</config>`)
  }
  return `${withoutPlates.trimEnd()}\n${insertion}`
}

/** A foreign mesh to inject into the output 3MF as a brand-new object the edit can reference. */
export interface ImportedObjectInput {
  importId: string
  name: string
  mesh: ImportedMesh
}

const NEW_PROJECT_MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
  '  <resources>',
  '  </resources>',
  '  <build>',
  '  </build>',
  '</model>'
].join('\n')

const NEW_PROJECT_MODEL_SETTINGS_XML = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>', '</config>'].join('\n')

const THREE_MF_CONTENT_TYPES_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
  '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
  '  <Default Extension="png" ContentType="image/png"/>',
  '  <Default Extension="config" ContentType="application/vnd.bambulab-package.settings+xml"/>',
  '</Types>'
].join('\n')

const THREE_MF_RELS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '  <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
  '</Relationships>'
].join('\n')

function formatMeshCoordinate(value: number): string {
  const rounded = Math.round(value * 1e5) / 1e5
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

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

/** Render an imported mesh as a self-contained `<object><mesh>` for `3D/3dmodel.model` resources. */
function renderImportedMeshObjectXml(objectId: number, mesh: ImportedMesh): string {
  const vertices: string[] = []
  for (let i = 0; i < mesh.positions.length; i += 3) {
    vertices.push(`     <vertex x="${formatMeshCoordinate(mesh.positions[i] ?? 0)}" y="${formatMeshCoordinate(mesh.positions[i + 1] ?? 0)}" z="${formatMeshCoordinate(mesh.positions[i + 2] ?? 0)}"/>`)
  }
  const triangles: string[] = []
  for (let i = 0; i < mesh.indices.length; i += 3) {
    triangles.push(`     <triangle v1="${mesh.indices[i] ?? 0}" v2="${mesh.indices[i + 1] ?? 0}" v3="${mesh.indices[i + 2] ?? 0}"/>`)
  }
  return [
    `  <object id="${objectId}" type="model">`,
    '   <mesh>',
    '    <vertices>',
    vertices.join('\n'),
    '    </vertices>',
    '    <triangles>',
    triangles.join('\n'),
    '    </triangles>',
    '   </mesh>',
    '  </object>'
  ].join('\n')
}

/**
 * Render the matching `model_settings.config` `<object>` metadata for an imported mesh
 * object. `extruder` records the placing instance's filament so the part keeps its
 * material on reopen/preview (without it the part reads as "no filament" and renders
 * uncoloured).
 */
function renderImportedModelSettingsObjectXml(objectId: number, name: string, extruder: number | null): string {
  return [
    `  <object id="${objectId}">`,
    `    <metadata key="name" value="${escapeXmlAttribute(name)}"/>`,
    `    <part id="${objectId}" subtype="normal_part">`,
    `      <metadata key="name" value="${escapeXmlAttribute(name)}"/>`,
    ...(extruder != null ? [`      <metadata key="extruder" value="${extruder}"/>`] : []),
    '    </part>',
    '  </object>'
  ].join('\n')
}

function injectResourcesObjects(modelXml: string, objectsXml: string): string {
  if (!objectsXml) return modelXml
  if (/<\/resources>/.test(modelXml)) {
    return modelXml.replace(/<\/resources>/, `${objectsXml}\n  </resources>`)
  }
  // No resources section (skeleton safety): create one before the build section.
  return modelXml.replace(/<build\b/, `<resources>\n${objectsXml}\n  </resources>\n  <build`)
}

function injectModelSettingsObjects(xml: string, objectsXml: string): string {
  if (!objectsXml) return xml
  if (/<\/config>/.test(xml)) {
    return xml.replace(/<\/config>/, `${objectsXml}\n</config>`)
  }
  return `${xml.trimEnd()}\n${objectsXml}\n`
}

/**
 * Strip original objects that no instance in the edited build references anymore (an object
 * the editor's Cut tool replaced with staged-import halves, or a model the user deleted).
 * BambuStudio's 3MF loader re-instantiates resources objects that lack a build item (it adds
 * a default instance), so an orphaned original would silently reappear in the slice — landing
 * on top of the kept geometry and failing the plate. Objects referenced as a component of
 * another object (same-file assemblies in generic 3MFs) are conservatively kept; Bambu part
 * objects live in separate /3D/Objects files, so cut-away root objects never match that.
 */
function removeUnreferencedObjects(
  modelXml: string,
  modelSettingsXml: string,
  buildObjectIds: ReadonlySet<number>
): { modelXml: string; modelSettingsXml: string } {
  const referenced = new Set(buildObjectIds)
  for (const match of modelXml.matchAll(/<component\b[^>]*\bobjectid="(\d+)"/gi)) {
    referenced.add(Number.parseInt(match[1]!, 10))
  }
  const dropUnreferencedObjects = (xml: string) =>
    xml.replace(/[ \t]*<object\b[^>]*\bid="(\d+)"[^>]*>[\s\S]*?<\/object>\n?/g, (block, id: string) =>
      referenced.has(Number.parseInt(id, 10)) ? block : ''
    )
  // Assemble entries pointing at removed objects would dangle; drop those too.
  const settingsXml = dropUnreferencedObjects(modelSettingsXml)
    .replace(/[ \t]*<assemble_item\b[^>]*\bobject_id="(\d+)"[^>]*\/>\n?/g, (block, id: string) =>
      referenced.has(Number.parseInt(id, 10)) ? block : ''
    )
  return { modelXml: dropUnreferencedObjects(modelXml), modelSettingsXml: settingsXml }
}

/** Assemble the two edited 3MF documents (model + model_settings) from a base and the imports. */
function buildEditedThreeMfDocuments(
  baseModelXml: string,
  baseModelSettingsXml: string,
  projectSettingsJson: string | null,
  edit: SceneEdit,
  imports: ImportedObjectInput[]
): { modelXml: string; modelSettingsXml: string; importIdToObjectId: ReadonlyMap<string, number> } {
  let nextObjectId = maxThreeMfObjectId(baseModelXml, baseModelSettingsXml) + 1
  const importIdToObjectId = new Map<string, number>()
  const meshObjects: string[] = []
  const settingsObjects: string[] = []
  // Imports consumed as added PART volumes become components of an existing object:
  // they get a mesh object resource but no standalone model_settings object entry and
  // are never placed by build items.
  const partImportIds = new Set((edit.addedParts ?? []).map((part) => part.importId))
  // Material for each imported object: the first placing instance's filament, written
  // as the part's `extruder` (mapped through filament_maps like part reassignment).
  const filamentToExtruder = buildFilamentToExtruderMap(baseModelSettingsXml)
  const importFilament = new Map<string, number>()
  for (const instance of edit.instances) {
    if (instance.importId && instance.filamentId != null && !importFilament.has(instance.importId)) {
      importFilament.set(instance.importId, instance.filamentId)
    }
  }
  for (const imported of imports) {
    const objectId = nextObjectId
    nextObjectId += 1
    importIdToObjectId.set(imported.importId, objectId)
    meshObjects.push(renderImportedMeshObjectXml(objectId, imported.mesh))
    if (!partImportIds.has(imported.importId)) {
      const filamentId = importFilament.get(imported.importId) ?? null
      const extruder = filamentId != null ? filamentToExtruder.get(filamentId) ?? filamentId : null
      settingsObjects.push(renderImportedModelSettingsObjectXml(objectId, imported.name, extruder))
    }
  }

  const resolved: ResolvedEditInstance[] = edit.instances.map((instance) => {
    const objectId = instance.objectId ?? (instance.importId != null ? importIdToObjectId.get(instance.importId) : undefined)
    if (objectId == null) {
      throw new Error('Scene edit references an unknown imported model')
    }
    return {
      objectId,
      plateIndex: instance.plateIndex,
      position: instance.position,
      rotation: instance.rotation,
      scale: instance.scale,
      matrix: instance.matrix,
      printable: instance.printable
    }
  })

  const plateType = extractPlateType(projectSettingsJson)
  const { width, depth } = extractSceneBed(projectSettingsJson, plateType)
  const origins = computePlateOrigins(edit.plates, width, depth)
  const arranged = assignArrangedInstances(resolved, origins)

  let modelXml = injectResourcesObjects(baseModelXml, meshObjects.join('\n'))
  modelXml = replaceThreeMfBuildSection(modelXml, renderArrangedBuildItems(arranged))

  let modelSettingsXml = injectModelSettingsObjects(baseModelSettingsXml, settingsObjects.join('\n'))
  modelSettingsXml = replaceModelSettingsPlates(modelSettingsXml, renderArrangedModelSettingsPlates(arranged, edit.plates))

  // Attach added part volumes BEFORE the unreferenced-object sweep: a part mesh is
  // only kept alive by the <component> reference inserted here.
  if (edit.addedParts && edit.addedParts.length > 0) {
    const applied = applyAddedParts(modelXml, modelSettingsXml, edit.addedParts, importIdToObjectId, () => {
      const id = nextObjectId
      nextObjectId += 1
      return id
    })
    modelXml = applied.modelXml
    modelSettingsXml = applied.modelSettingsXml
  }

  const cleaned = removeUnreferencedObjects(modelXml, modelSettingsXml, new Set(arranged.map((instance) => instance.objectId)))
  modelXml = cleaned.modelXml
  modelSettingsXml = cleaned.modelSettingsXml

  if (edit.partFilaments && edit.partFilaments.length > 0) {
    modelSettingsXml = applyPartFilamentOverrides(modelSettingsXml, baseModelSettingsXml, edit.partFilaments)
  }

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

  // The filament arrays themselves live in project_settings.config (rewritten in
  // buildEditedThreeMf); here we remap each part's filament reference from its OLD slot
  // to the new one. Adding/removing materials reorders the list, so a part that used a
  // now-removed material reassigns to material 1 (matching Bambu Studio); a part that
  // used a material after a removed one shifts down with it.
  if (edit.filaments && edit.filaments.length > 0) {
    const oldIndexToNewId = new Map<number, number>()
    edit.filaments.forEach((filament, i) => {
      // null sourceIndex means "same slot" (identity), matching applyFilamentList; the
      // first new slot referencing an old index wins (kept slots precede cloned adds).
      const src = filament.sourceIndex ?? i
      if (!oldIndexToNewId.has(src)) oldIndexToNewId.set(src, i + 1)
    })
    modelSettingsXml = remapPartExtruders(modelSettingsXml, oldIndexToNewId)
  }

  return { modelXml, modelSettingsXml, importIdToObjectId }
}

const IDENTITY_THREE_MF_TRANSFORM = '1 0 0 0 1 0 0 0 1 0 0 0'

/**
 * Bake the edit's added part volumes (negative parts, modifiers, support
 * blockers/enforcers) into the documents: each part's already-injected mesh object is
 * referenced as a `<component>` of its parent root object (object-local transform),
 * and the parent's `model_settings.config` entry gains a `<part>` with the Bambu
 * subtype. Parents that carry their mesh inline (imports saved by an earlier session,
 * generic 3MFs) are first wrapped: the mesh moves to a new object referenced by an
 * identity component, and the parent's existing settings `<part>` is re-keyed to that
 * new id so 3MF's object = mesh XOR components rule holds.
 */
function applyAddedParts(
  modelXml: string,
  modelSettingsXml: string,
  addedParts: NonNullable<SceneEdit['addedParts']>,
  importIdToObjectId: ReadonlyMap<string, number>,
  allocateObjectId: () => number
): { modelXml: string; modelSettingsXml: string } {
  for (const part of addedParts) {
    const partObjectId = importIdToObjectId.get(part.importId)
    if (partObjectId == null) {
      throw new Error('Scene edit adds a part from an unknown imported mesh')
    }
    const parentPattern = new RegExp(`(<object\\b[^>]*\\bid="${part.objectId}"(?:[^>]*)>)([\\s\\S]*?)(</object>)`)
    const parentMatch = modelXml.match(parentPattern)
    if (!parentMatch) {
      throw new Error(`Scene edit adds a part to a missing object ${part.objectId}`)
    }
    const transform = part.matrix.map(formatThreeMfTransformValue).join(' ')
    const componentXml = `    <component objectid="${partObjectId}" transform="${transform}"/>`
    const body = parentMatch[2]!
    if (/<components\b/.test(body)) {
      const nextBody = body.replace(/<\/components>/, `${componentXml}\n   </components>`)
      modelXml = modelXml.replace(parentPattern, (_match, open: string, _body: string, close: string) => `${open}${nextBody}${close}`)
    } else if (/<mesh\b/.test(body)) {
      // Inline-mesh parent: move the mesh into its own object and reference both.
      const meshObjectId = allocateObjectId()
      const meshMatch = body.match(/<mesh\b[\s\S]*?<\/mesh>/)
      if (!meshMatch) throw new Error(`Object ${part.objectId} has an unreadable mesh`)
      const meshObjectXml = [
        `  <object id="${meshObjectId}" type="model">`,
        `   ${meshMatch[0]}`,
        '  </object>'
      ].join('\n')
      const nextBody = body.replace(/<mesh\b[\s\S]*?<\/mesh>/, [
        '<components>',
        `    <component objectid="${meshObjectId}" transform="${IDENTITY_THREE_MF_TRANSFORM}"/>`,
        componentXml,
        '   </components>'
      ].join('\n'))
      modelXml = modelXml.replace(parentPattern, (_match, open: string, _body: string, close: string) => `${open}${nextBody}${close}`)
      modelXml = injectResourcesObjects(modelXml, meshObjectXml)
      // The parent's existing settings <part> keyed by the parent id now describes the
      // moved mesh component.
      modelSettingsXml = modelSettingsXml.replace(
        new RegExp(`(<object\\b[^>]*\\bid="${part.objectId}"[^>]*>[\\s\\S]*?)<part id="${part.objectId}"`),
        `$1<part id="${meshObjectId}"`
      )
    } else {
      throw new Error(`Object ${part.objectId} has neither mesh nor components`)
    }
    modelSettingsXml = addModelSettingsPartEntry(modelSettingsXml, part.objectId, partObjectId, part.subtype, part.name, part.settings)
  }
  return { modelXml, modelSettingsXml }
}

/**
 * Append a `<part>` (with subtype + name, plus any per-volume config metadata — how
 * BambuStudio persists modifier-volume overrides) to a parent's model_settings entry.
 */
function addModelSettingsPartEntry(
  modelSettingsXml: string,
  parentObjectId: number,
  partObjectId: number,
  subtype: string,
  name: string,
  settings?: Record<string, string>
): string {
  const settingsXml = Object.entries(settings ?? {}).map(([key, value]) =>
    `      <metadata key="${escapeXmlAttribute(key)}" value="${escapeXmlAttribute(value)}"/>`)
  const partXml = [
    `    <part id="${partObjectId}" subtype="${escapeXmlAttribute(subtype)}">`,
    `      <metadata key="name" value="${escapeXmlAttribute(name)}"/>`,
    ...settingsXml,
    '    </part>'
  ].join('\n')
  const objectPattern = new RegExp(`(<object\\b[^>]*\\bid="${parentObjectId}"[^>]*>)([\\s\\S]*?)(</object>)`)
  if (objectPattern.test(modelSettingsXml)) {
    return modelSettingsXml.replace(objectPattern, (_match, open: string, body: string, close: string) =>
      `${open}${body.trimEnd()}\n${partXml}\n  ${close}`)
  }
  // Parent had no settings entry (minimal/generic file): create one.
  const objectXml = [`  <object id="${parentObjectId}">`, partXml, '  </object>'].join('\n')
  return injectModelSettingsObjects(modelSettingsXml, objectXml)
}

/**
 * Build a filament-id -> extruder-slot lookup from the project's `filament_maps` so a
 * reassignment to filament F writes the `extruder` slot the parser maps back to F. Only a
 * 1:1 map is inverted; otherwise the extruder equals the filament id (the parser's fallback).
 */
function buildFilamentToExtruderMap(modelSettingsXml: string): Map<number, number> {
  const { plates } = parseModelSettingsScene(modelSettingsXml)
  const maps = plates.map((plate) => plate.filamentMaps).find((entry) => entry.length > 0) ?? []
  const inverse = new Map<number, number>()
  const positive = maps.filter((value) => Number.isInteger(value) && value > 0)
  if (positive.length > 0 && new Set(positive).size === positive.length) {
    maps.forEach((filament, index) => { if (filament > 0) inverse.set(filament, index + 1) })
  }
  return inverse
}

/** Rewrite (or insert) a `<part>`'s `extruder` metadata to a new slot. */
function setPartExtruderMetadata(partBlock: string, extruder: number): string {
  const metadata = `<metadata key="extruder" value="${extruder}"/>`
  if (/<metadata\s+key="extruder"\s+value="[^"]*"\s*\/>/.test(partBlock)) {
    return partBlock.replace(/<metadata\s+key="extruder"\s+value="[^"]*"\s*\/>/, metadata)
  }
  return partBlock.replace(/<\/part>/, `  ${metadata}\n    </part>`)
}

/**
 * Apply per-part filament reassignments by rewriting the matching `<part>`s' `extruder`
 * metadata inside `model_settings.config`. Filament is a property of the object's part, so
 * the change is keyed by objectId + componentObjectId (the part id) and affects every
 * instance of that object. Everything else in the document is left untouched.
 */
function applyPartFilamentOverrides(
  modelSettingsXml: string,
  baseModelSettingsXml: string,
  partFilaments: SceneEditPartFilament[]
): string {
  const inverse = buildFilamentToExtruderMap(baseModelSettingsXml)
  const extruderByObjectPart = new Map<number, Map<number, number>>()
  for (const override of partFilaments) {
    const extruder = inverse.get(override.filamentId) ?? override.filamentId
    let parts = extruderByObjectPart.get(override.objectId)
    if (!parts) { parts = new Map(); extruderByObjectPart.set(override.objectId, parts) }
    parts.set(override.componentObjectId, extruder)
  }
  return modelSettingsXml.replace(/<object\b([^>]*)>[\s\S]*?<\/object>/g, (objectBlock, attrs: string) => {
    const objectId = Number.parseInt(parseAttrs(attrs).id ?? '', 10)
    const parts = extruderByObjectPart.get(objectId)
    if (!parts) return objectBlock
    return objectBlock.replace(/<part\b([^>]*)>[\s\S]*?<\/part>/g, (partBlock, partAttrs: string) => {
      const partId = Number.parseInt(parseAttrs(partAttrs).id ?? '', 10)
      const extruder = parts.get(partId)
      return extruder == null ? partBlock : setPartExtruderMetadata(partBlock, extruder)
    })
  })
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

/** Normalize a colour to BambuStudio's `#RRGGBB` form, never returning empty. */
function filamentColourOut(value: string): string {
  return normalizeColor(value) ?? (value.trim().startsWith('#') ? value.trim() : `#${value.trim()}`)
}

/**
 * Replace `project_settings.config`'s filament set with the desired ordered list
 * (Bambu-style add/remove of materials). Position `i` becomes filament `i + 1`.
 *
 * To stay resilient to BambuStudio version differences (project_settings carries many
 * parallel filament-indexed arrays we don't enumerate), EVERY top-level array whose
 * length equals the current filament count is remapped by an index map: a desired slot
 * copies its `sourceIndex` (an existing filament's settings) so new/cloned slots inherit
 * a valid profile, then `filament_colour`/`filament_type` are set from the desired list.
 * The square `flush_volumes_matrix` (count x count) is rebuilt row/column-wise. When the
 * source has no filament arrays (a from-scratch project) only colour/type are written and
 * the slicer fills the rest from the filament profiles supplied at slice time.
 */
function applyFilamentList(projectSettingsJson: string, filaments: SceneEditFilament[]): string {
  if (filaments.length === 0) return projectSettingsJson
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return projectSettingsJson
  }
  if (!parsed || typeof parsed !== 'object') return projectSettingsJson
  const record = parsed as Record<string, unknown>

  const oldCount = Math.max(
    Array.isArray(record.filament_colour) ? record.filament_colour.length : 0,
    Array.isArray(record.filament_type) ? record.filament_type.length : 0,
    Array.isArray(record.filament_settings_id) ? record.filament_settings_id.length : 0
  )
  const newCount = filaments.length

  if (oldCount > 0) {
    // Desired slot i is seeded from this old index (clamped into range).
    const sourceFor = (i: number): number => {
      const requested = filaments[i]?.sourceIndex
      const idx = requested == null ? i : requested
      return idx >= 0 && idx < oldCount ? idx : 0
    }
    for (const [key, value] of Object.entries(record)) {
      if (!Array.isArray(value)) continue
      if (key === 'flush_volumes_matrix') {
        if (value.length === oldCount * oldCount) {
          const next: unknown[] = []
          for (let row = 0; row < newCount; row++) {
            for (let col = 0; col < newCount; col++) {
              next.push(value[sourceFor(row) * oldCount + sourceFor(col)])
            }
          }
          record[key] = next
        }
        continue
      }
      if (value.length === oldCount) {
        record[key] = Array.from({ length: newCount }, (_unused, i) => value[sourceFor(i)])
      }
    }
  }

  // Authoritative colour/type from the desired list (overrides the cloned values above).
  record.filament_colour = filaments.map((filament) => filamentColourOut(filament.color))
  const previousTypes = Array.isArray(record.filament_type) ? record.filament_type : []
  record.filament_type = filaments.map((filament, i) => filament.type ?? (typeof previousTypes[i] === 'string' ? previousTypes[i] : 'PLA'))
  // Persist the chosen filament preset name per slot so a material PROFILE change (e.g. PLA -> PETG)
  // survives a save — otherwise `filament_settings_id` keeps the prior preset and the project reopens
  // as the old material (with a name/type mismatch). A slot with no explicit `settingsId` keeps the
  // value carried over from its source slot above.
  if (filaments.some((filament) => filament.settingsId)) {
    const previousSettingsIds = Array.isArray(record.filament_settings_id) ? record.filament_settings_id : []
    record.filament_settings_id = filaments.map((filament, i) => filament.settingsId ?? (typeof previousSettingsIds[i] === 'string' ? previousSettingsIds[i] : ''))
  }

  return JSON.stringify(record)
}

/**
 * Remap every `model_settings.config` part `extruder` from its OLD filament slot to the
 * new one after a material add/remove. `oldIndexToNewId` maps a 0-based old filament index
 * to its 1-based new id (built from each desired filament's `sourceIndex`). A part whose
 * old slot is gone (its material was removed) reassigns to material 1, matching Bambu
 * Studio; everything else shifts with its material.
 */
function remapPartExtruders(modelSettingsXml: string, oldIndexToNewId: Map<number, number>): string {
  return modelSettingsXml.replace(/<metadata\s+key="extruder"\s+value="(\d+)"\s*\/>/g, (block, value: string) => {
    const oldId = Number.parseInt(value, 10)
    if (!Number.isInteger(oldId) || oldId < 1) return block
    const newId = oldIndexToNewId.get(oldId - 1) ?? 1
    return `<metadata key="extruder" value="${newId}"/>`
  })
}

/** Triangle paint channels: the brush they come from and the 3MF attribute they write. */
export type TrianglePaintAttribute = 'paint_supports' | 'paint_seam' | 'paint_color'

/**
 * Rewrite one mesh object's `<triangle>` paint attribute inside a model entry's XML.
 * `codes` is the complete desired map (triangle index in mesh order -> hex code):
 * mapped triangles get the attribute set, unmapped triangles get it removed. Triangle
 * tags whose paint does not change are left byte-for-byte intact. Codes are
 * schema-validated hex strings, so direct attribute interpolation is safe.
 */
function applyTrianglePaintToObjectBlock(block: string, attribute: TrianglePaintAttribute, codes: Record<string, string>): string {
  let triangleIndex = -1
  const stripPattern = new RegExp(`\\s+${attribute}="[^"]*"`, 'g')
  return block.replace(/<triangle\b([^>]*?)(\/?)>/g, (full, attrs: string, selfClose: string) => {
    triangleIndex += 1
    const code = codes[String(triangleIndex)]
    const cleaned = attrs.replace(stripPattern, '')
    if (code == null) {
      return cleaned === attrs ? full : `<triangle${cleaned}${selfClose}>`
    }
    return `<triangle${cleaned} ${attribute}="${code}"${selfClose}>`
  })
}

/**
 * Apply per-mesh triangle paint for one channel to a model entry's XML. `paints` keys
 * are the mesh object ids WITHIN this entry (component object ids); objects without an
 * entry are untouched.
 */
export function applyTrianglePaintToModelEntry(
  xml: string,
  attribute: TrianglePaintAttribute,
  paints: Map<number, Record<string, string>>
): string {
  if (paints.size === 0) return xml
  return xml.replace(/<object\b([^>]*)>([\s\S]*?)<\/object>/g, (full, attrs: string) => {
    const objectId = Number.parseInt(parseAttrs(attrs).id ?? '', 10)
    const codes = Number.isInteger(objectId) ? paints.get(objectId) : undefined
    if (!codes) return full
    return applyTrianglePaintToObjectBlock(full, attribute, codes)
  })
}

/**
 * Resolve each painted part to the model entry its mesh lives in:
 * `entryPath -> (mesh object id within that entry -> triangle paint map)`. Painted parts
 * that cannot be resolved against the base model (stale ids, import-backed parts) are
 * skipped so the source geometry stays untouched rather than mis-painted.
 */
function resolvePartPaintByEntry(
  baseModelXml: string,
  partPaint: SceneEditPartPaint[]
): Map<string, Map<number, Record<string, string>>> {
  const byEntry = new Map<string, Map<number, Record<string, string>>>()
  const componentsByObjectId = parseRootModelComponents(baseModelXml)
  for (const paint of partPaint) {
    const component = componentsByObjectId
      .get(paint.objectId)
      ?.find((entry) => entry.objectId === paint.componentObjectId)
    if (!component) continue
    const byMesh = byEntry.get(component.entryPath) ?? new Map<number, Record<string, string>>()
    byMesh.set(component.objectId, paint.triangles)
    byEntry.set(component.entryPath, byMesh)
  }
  return byEntry
}

/**
 * Merge layer-based filament changes into BambuStudio's `custom_gcode_per_layer.xml`.
 * Listed plates get their ToolChange (`type="2"`) entries REPLACED by the edit; their
 * pause/custom entries and every unlisted plate are preserved verbatim from the source.
 * Returns '' when nothing remains (clears the sidecar).
 */
export function mergeCustomGcodePerLayer(
  sourceXml: string | null,
  edits: SceneEditPlateFilamentChanges[]
): string {
  const sourcePlates = new Map<number, { toolChanges: string[]; others: string[]; mode: string | null }>()
  if (sourceXml) {
    for (const plateMatch of sourceXml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
      const block = plateMatch[1] ?? ''
      const id = Number.parseInt(parseAttrs(/<plate_info\b([^>]*)\/>/.exec(block)?.[1] ?? '').id ?? '', 10)
      if (!Number.isInteger(id) || id <= 0) continue
      const toolChanges: string[] = []
      const others: string[] = []
      for (const layerMatch of block.matchAll(/<layer\b([^>]*)\/>/g)) {
        const target = parseAttrs(layerMatch[1] ?? '').type === '2' ? toolChanges : others
        target.push(layerMatch[0])
      }
      const mode = /<mode\b[^>]*\/>/.exec(block)?.[0] ?? null
      sourcePlates.set(id, { toolChanges, others, mode })
    }
  }
  const editsByPlate = new Map(edits.map((entry) => [entry.plateIndex, entry.changes]))
  const plateIds = [...new Set([...sourcePlates.keys(), ...editsByPlate.keys()])].sort((left, right) => left - right)
  const blocks: string[] = []
  for (const plateId of plateIds) {
    const source = sourcePlates.get(plateId)
    const edited = editsByPlate.get(plateId)
    const toolChangeTags = edited
      ? edited.map((change) =>
        `<layer top_z="${change.z}" type="2" extruder="${change.filamentId}" color="${escapeXmlAttribute(change.color ?? '')}" extra="" gcode="tool_change"/>`)
      : source?.toolChanges ?? []
    const otherTags = source?.others ?? []
    if (toolChangeTags.length === 0 && otherTags.length === 0) continue
    blocks.push([
      '<plate>',
      `<plate_info id="${plateId}"/>`,
      ...toolChangeTags,
      ...otherTags,
      source?.mode ?? '<mode value="MultiAsSingle"/>',
      '</plate>'
    ].join('\n'))
  }
  if (blocks.length === 0) return ''
  return ['<?xml version="1.0" encoding="utf-8"?>', '<custom_gcodes_per_layer>', ...blocks, '</custom_gcodes_per_layer>', ''].join('\n')
}

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

/**
 * Build an edited 3MF from a base project (or from scratch when `baseSourcePath` is null) plus an
 * arrangement and a set of imported meshes. Imported STL/STEP meshes are injected as new
 * `<object><mesh>` resources with fresh object ids; the arrangement's build items and
 * `model_settings.config` plates/instances are regenerated (existing geometry copied verbatim from
 * the base, except parts repainted with the support brush, whose `<triangle>` paint attributes are
 * rewritten in place). Used for slicing the unsaved arrangement and for persisting it back to the
 * library.
 */
/** Outcome of {@link buildEditedThreeMf} the slicer needs after the bake. */
export interface BuildEditedThreeMfResult {
  /**
   * For each object replaced via "Replace with…" (`edit.meshReplacements`), the baked
   * `object_id` its staged-import geometry was written as. The slicer uses this to carry the
   * original object's per-object PROCESS overrides (keyed by the original `object_id`) onto
   * the replacement's baked object before slicing.
   */
  replacedObjectIds: Array<{ originalObjectId: number; bakedObjectId: number }>
}

export async function buildEditedThreeMf(
  baseSourcePath: string | null,
  outputPath: string,
  edit: SceneEdit,
  imports: ImportedObjectInput[] = []
): Promise<BuildEditedThreeMfResult> {
  let baseModelXml = NEW_PROJECT_MODEL_XML
  let baseModelSettingsXml = NEW_PROJECT_MODEL_SETTINGS_XML
  let projectSettingsJson: string | null = null
  let baseCustomGcodeXml: string | null = null
  if (baseSourcePath) {
    baseModelXml = (await readEntry(baseSourcePath, '3D/3dmodel.model', undefined, 256 * 1024 * 1024)).toString('utf8')
    baseModelSettingsXml = await readEntry(baseSourcePath, 'Metadata/model_settings.config', undefined, 64 * 1024 * 1024)
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => NEW_PROJECT_MODEL_SETTINGS_XML)
    projectSettingsJson = await readEntry(baseSourcePath, 'Metadata/project_settings.config', undefined, 8 * 1024 * 1024)
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => null)
    baseCustomGcodeXml = await readEntry(baseSourcePath, CUSTOM_GCODE_PER_LAYER_ENTRY, undefined, 4 * 1024 * 1024)
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => null)
  }

  const documents = buildEditedThreeMfDocuments(
    baseModelXml,
    baseModelSettingsXml,
    projectSettingsJson,
    edit,
    imports
  )
  let modelXml = documents.modelXml
  const modelSettingsXml = documents.modelSettingsXml

  // Map each replaced object to the baked object_id its import landed on, so the slicer can
  // re-key the original object's per-object process overrides onto the replacement.
  const replacedObjectIds = (edit.meshReplacements ?? []).flatMap((replacement) => {
    const bakedObjectId = documents.importIdToObjectId.get(replacement.importId)
    return bakedObjectId != null ? [{ originalObjectId: replacement.objectId, bakedObjectId }] : []
  })

  // Triangle paint (support + seam brushes): rewrite painted parts' triangle attributes.
  // Root-entry meshes are rewritten on the already-built model XML; meshes in per-object
  // sub-entries get a transform in the copy pass below.
  const paintChannels: Array<{ attribute: TrianglePaintAttribute; byEntry: Map<string, Map<number, Record<string, string>>> }> = []
  if (baseSourcePath) {
    if (edit.supportPaint && edit.supportPaint.length > 0) {
      paintChannels.push({ attribute: 'paint_supports', byEntry: resolvePartPaintByEntry(baseModelXml, edit.supportPaint) })
    }
    if (edit.seamPaint && edit.seamPaint.length > 0) {
      paintChannels.push({ attribute: 'paint_seam', byEntry: resolvePartPaintByEntry(baseModelXml, edit.seamPaint) })
    }
    if (edit.colorPaint && edit.colorPaint.length > 0) {
      paintChannels.push({ attribute: 'paint_color', byEntry: resolvePartPaintByEntry(baseModelXml, edit.colorPaint) })
    }
  }
  for (const channel of paintChannels) {
    const rootEntryPaint = channel.byEntry.get('3D/3dmodel.model')
    if (rootEntryPaint) {
      modelXml = applyTrianglePaintToModelEntry(modelXml, channel.attribute, rootEntryPaint)
    }
  }

  // Manual brim ears: when the edit carries the set, the sidecar file is rewritten
  // wholesale (or emptied, clearing the source's ears); absent keeps the source file.
  const brimEarPointsContent = edit.brimEars !== undefined
    ? serializeBrimEarPoints(edit.brimEars, modelXml)
    : null
  // Layer-based filament changes: merged with the source sidecar (preserving pauses
  // and unedited plates); absent keeps the source file untouched.
  const customGcodeContent = edit.filamentChanges !== undefined
    ? mergeCustomGcodePerLayer(baseCustomGcodeXml, edit.filamentChanges)
    : null

  if (baseSourcePath) {
    // Copy the base archive, replacing the two edited entries (and adding model_settings if absent).
    // `baseModelSettingsXml` is the placeholder only when the source had no model_settings.config
    // (the read above fell back). Reuse that instead of a 1-byte existence probe, which threw
    // "Entry too large" for every real config and made us append a DUPLICATE entry.
    const hasModelSettings = baseModelSettingsXml !== NEW_PROJECT_MODEL_SETTINGS_XML
    const extraEntries = hasModelSettings ? [] : [{ name: 'Metadata/model_settings.config', content: modelSettingsXml }]
    if (brimEarPointsContent !== null) {
      // Replace the entry when the source has one; append it when it doesn't.
      extraEntries.push({ name: BRIM_EAR_POINTS_ENTRY, content: brimEarPointsContent })
    }
    if (customGcodeContent !== null) {
      extraEntries.push({ name: CUSTOM_GCODE_PER_LAYER_ENTRY, content: customGcodeContent })
    }
    const transforms = new Map<string, (xml: string) => string>([
      ['3D/3dmodel.model', () => modelXml],
      ['Metadata/model_settings.config', () => modelSettingsXml]
    ])
    if (brimEarPointsContent !== null) {
      transforms.set(BRIM_EAR_POINTS_ENTRY, () => brimEarPointsContent)
    }
    if (customGcodeContent !== null) {
      transforms.set(CUSTOM_GCODE_PER_LAYER_ENTRY, () => customGcodeContent)
    }
    // Painted parts whose meshes live in per-object sub-entries (Bambu's 3D/Objects/*.model).
    // One transform per entry composes every channel that touches it.
    const paintedEntryPaths = new Set(paintChannels.flatMap((channel) => [...channel.byEntry.keys()]))
    paintedEntryPaths.delete('3D/3dmodel.model')
    for (const entryPath of paintedEntryPaths) {
      transforms.set(entryPath, (xml) => paintChannels.reduce((acc, channel) => {
        const paints = channel.byEntry.get(entryPath)
        return paints ? applyTrianglePaintToModelEntry(acc, channel.attribute, paints) : acc
      }, xml))
    }
    // Compose project_settings.config rewrites: filament set first (add/remove
    // materials), then per-plate prime-tower corners.
    const projectSettingsTransforms: Array<(xml: string) => string> = []
    if (edit.filaments && edit.filaments.length > 0) {
      const filaments = edit.filaments
      projectSettingsTransforms.push((xml) => applyFilamentList(xml, filaments))
    }
    if (edit.plates.some((plate) => plate.primeTower)) {
      projectSettingsTransforms.push((xml) => applyPrimeTowerSettings(xml, edit))
    }
    if (projectSettingsTransforms.length > 0) {
      transforms.set(
        'Metadata/project_settings.config',
        (xml) => projectSettingsTransforms.reduce((acc, transform) => transform(acc), xml)
      )
    }
    await rewriteThreeMfEntries(baseSourcePath, outputPath, transforms, extraEntries)
    return { replacedObjectIds }
  }

  await writeFreshThreeMf(outputPath, [
    { name: '[Content_Types].xml', content: THREE_MF_CONTENT_TYPES_XML },
    { name: '_rels/.rels', content: THREE_MF_RELS_XML },
    { name: '3D/3dmodel.model', content: modelXml },
    { name: 'Metadata/model_settings.config', content: modelSettingsXml },
    ...(brimEarPointsContent ? [{ name: BRIM_EAR_POINTS_ENTRY, content: brimEarPointsContent }] : []),
    ...(customGcodeContent ? [{ name: CUSTOM_GCODE_PER_LAYER_ENTRY, content: customGcodeContent }] : [])
  ])
  return { replacedObjectIds }
}

/**
 * Write each plate's edited prime-tower corner into the per-plate `wipe_tower_x`/
 * `wipe_tower_y` arrays of `project_settings.config` (string-valued, like Bambu).
 */
function applyPrimeTowerSettings(projectSettingsJson: string, edit: SceneEdit): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return projectSettingsJson
  }
  if (!parsed || typeof parsed !== 'object') return projectSettingsJson
  const record = parsed as Record<string, unknown>
  const xs = Array.isArray(record.wipe_tower_x) ? record.wipe_tower_x.map(String) : []
  const ys = Array.isArray(record.wipe_tower_y) ? record.wipe_tower_y.map(String) : []
  for (const plate of edit.plates) {
    if (!plate.primeTower) continue
    const index = plate.index - 1
    while (xs.length <= index) xs.push(xs[xs.length - 1] ?? '15')
    while (ys.length <= index) ys.push(ys[ys.length - 1] ?? '220')
    xs[index] = String(plate.primeTower.x)
    ys[index] = String(plate.primeTower.y)
  }
  record.wipe_tower_x = xs
  record.wipe_tower_y = ys
  return JSON.stringify(record)
}

/** Write a brand-new 3MF (ZIP) from a fixed set of UTF-8 text entries. */
function writeFreshThreeMf(outputPath: string, entries: Array<{ name: string; content: string }>): Promise<void> {
  return new Promise((resolve, reject) => {
    const outputZip = new yazl.ZipFile()
    const output = createWriteStream(outputPath)
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (error) {
        output.destroy()
        reject(error)
      } else {
        resolve()
      }
    }
    outputZip.outputStream.pipe(output)
    outputZip.outputStream.on('error', finish)
    output.on('error', finish)
    output.on('finish', () => finish())
    for (const entry of entries) {
      outputZip.addBuffer(Buffer.from(entry.content, 'utf8'), entry.name)
    }
    outputZip.end()
  })
}

/**
 * Write a copy of `sourcePath` whose plate arrangement matches `edit`: the `3D/3dmodel.model`
 * build items and `Metadata/model_settings.config` plates/instances are regenerated so moved,
 * rotated, scaled, cloned, removed, and re-plated models (across multiple plates) are honored at
 * slice time. Mesh geometry is copied verbatim from the source. Thin wrapper over
 * {@link buildEditedThreeMf} for the common case of an in-project edit with no foreign imports.
 */
export async function writeArrangedThreeMf(sourcePath: string, outputPath: string, edit: SceneEdit): Promise<void> {
  await buildEditedThreeMf(sourcePath, outputPath, edit, [])
}

/**
 * Copies every archive entry verbatim except those named in `transforms`, whose UTF-8 text is
 * passed through the matching transform. Generalizes {@link rewriteModelSettingsThreeMf} to rewrite
 * several entries in one streaming copy pass.
 */
function rewriteThreeMfEntries(
  sourcePath: string,
  outputPath: string,
  transforms: Map<string, (xml: string) => string>,
  extraEntries: Array<{ name: string; content: string }> = []
): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(sourcePath, { lazyEntries: true }, (openError, sourceZip) => {
      if (openError || !sourceZip) {
        reject(openError ?? new Error('Failed to open 3MF'))
        return
      }

      const outputZip = new yazl.ZipFile()
      const output = createWriteStream(outputPath)
      let settled = false

      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        sourceZip.close()
        if (error) {
          output.destroy()
          reject(error)
        } else {
          resolve()
        }
      }

      outputZip.outputStream.pipe(output)
      outputZip.outputStream.on('error', finish)
      output.on('error', finish)
      output.on('finish', () => finish())

      // A 3MF reader rejects archives with two entries of the same name (e.g. a duplicate
      // model_settings.config surfaces as "Duplicated object id"), so never write a name twice.
      const writtenNames = new Set<string>()
      sourceZip.on('error', finish)
      sourceZip.on('end', () => {
        for (const entry of extraEntries) {
          if (writtenNames.has(entry.name)) continue
          writtenNames.add(entry.name)
          outputZip.addBuffer(Buffer.from(entry.content, 'utf8'), entry.name)
        }
        outputZip.end()
      })
      sourceZip.on('entry', (entry: Entry) => {
        if (writtenNames.has(entry.fileName)) { sourceZip.readEntry(); return }
        writtenNames.add(entry.fileName)
        const transform = transforms.get(entry.fileName)
        if (transform) {
          readZipEntryBuffer(sourceZip, entry).then(
            (buffer) => {
              outputZip.addBuffer(Buffer.from(transform(buffer.toString('utf8')), 'utf8'), entry.fileName, { mtime: entry.getLastModDate() })
              sourceZip.readEntry()
            },
            finish
          )
          return
        }
        if (entry.fileName.endsWith('/')) {
          outputZip.addEmptyDirectory(entry.fileName, { mtime: entry.getLastModDate() })
          sourceZip.readEntry()
          return
        }
        sourceZip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finish(streamError ?? new Error(`Failed to read ${entry.fileName}`))
            return
          }
          stream.on('error', finish)
          stream.on('end', () => sourceZip.readEntry())
          outputZip.addReadStream(stream, entry.fileName, { mtime: entry.getLastModDate() })
        })
      })
      sourceZip.readEntry()
    })
  })
}
