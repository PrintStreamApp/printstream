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
import { randomUUID } from 'node:crypto'
import { isProcessSettingKey, type SceneEdit, type SceneEditFilament, type SceneEditObjectBrimEars, type SceneEditPartFilament, type SceneEditPartPaint, type SceneEditPartProcessOverride, type SceneEditPartTypeChange, type SceneEditPlateFilamentChanges, type SceneEditPlatePauses } from '@printstream/shared'
import { sliceExtruderForNozzleId, stringArray } from '@printstream/shared/three-mf'
import yauzl, { type Entry } from 'yauzl'
import yazl from 'yazl'
import type { ImportedMesh } from './mesh-import.js'
import { escapeXmlAttribute, readEntry, readZipEntryBuffer } from './three-mf-internal.js'
import { BRIM_EAR_POINTS_ENTRY, CUSTOM_GCODE_PER_LAYER_ENTRY, extractPlateType, extractSceneBed, LOGICAL_PART_PLATE_GAP, normalizeColor, parseAttrs, parseModelSettingsScene, parseRootModelComponents, parseRootModelObjectIdOrder } from './three-mf-reader.js'

/**
 * Does the base model use the 3MF Production Extension? BambuStudio always saves with it
 * (`requiredextensions="p"`, every object/component carrying a `p:UUID`). When it is in force, the
 * Bambu Studio **GUI** load path requires a `p:UUID` on every `<object>`/`<component>` — its parser
 * tolerates the absence, but the GUI drops UUID-less nodes during volume building, so a project we
 * saved with UUID-less injected objects loads as ZERO model objects and the GUI reports
 * "The file does not contain any geometry data." (The CLI slicer tolerates it, which is why slicing
 * worked while opening in the GUI did not.) So when the source is a production-extension project we
 * must stamp a UUID on every editor-injected node.
 */
function modelUsesProductionExtension(modelXml: string): boolean {
  return modelXml.includes(' p:UUID="') || /requiredextensions\s*=\s*"[^"]*\bp\b[^"]*"/.test(modelXml)
}

/**
 * ` p:UUID="…"` for an editor-injected node when the project uses the production extension, else `''`.
 * Any unique UUID satisfies the GUI; we mint fresh v4 UUIDs for injected nodes (the source's own
 * UUIDs are copied through untouched). v4 is deliberate: it never ends with BambuStudio's
 * `OBJECT_UUID_SUFFIX`, so it cannot trip BS's backup-restore path that reinterprets the UUID's hex
 * prefix as an object id.
 */
const productionUuidAttr = (gen: (() => string) | null): string => (gen ? ` p:UUID="${gen()}"` : '')

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

function renderArrangedBuildItems(arranged: ArrangedInstance[], genUuid: (() => string) | null): string {
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
      lines.push(`    <item objectid="${instance.objectId}"${productionUuidAttr(genUuid)} transform="${transform}" printable="${printable}"/>`)
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

/**
 * Instance `identify_id`s parsed from a source `model_settings.config`, keyed
 * `"<object_id>:<instance_id>"`, plus the highest id seen (0 when there are none).
 * The bake preserves a returning instance's id and allocates fresh ones above `maxId`.
 */
interface ModelSettingsIdentifyIds {
  byInstance: Map<string, number>
  maxId: number
}

/**
 * Read every `model_instance`'s `identify_id` out of a `model_settings.config`. The id is
 * BambuStudio's per-instance handle (`loaded_id` in the engine) — the ONLY key the CLI's
 * `--skip-objects` flag accepts — so the bake must carry it through (or mint one) for the
 * per-object/instance "Printable" exclusion to be enforceable on the rewritten file.
 */
function parseModelSettingsIdentifyIds(modelSettingsXml: string): ModelSettingsIdentifyIds {
  const byInstance = new Map<string, number>()
  let maxId = 0
  for (const instance of modelSettingsXml.matchAll(/<model_instance\b[^>]*>[\s\S]*?<\/model_instance>/g)) {
    const objectId = Number(/object_id"\s+value="(\d+)"/.exec(instance[0])?.[1])
    const instanceId = Number(/instance_id"\s+value="(\d+)"/.exec(instance[0])?.[1])
    const identifyId = Number(/identify_id"\s+value="(\d+)"/.exec(instance[0])?.[1])
    if (!Number.isInteger(identifyId)) continue
    maxId = Math.max(maxId, identifyId)
    if (Number.isInteger(objectId) && Number.isInteger(instanceId)) {
      byInstance.set(`${objectId}:${instanceId}`, identifyId)
    }
  }
  return { byInstance, maxId }
}

function renderArrangedModelSettingsPlates(
  arranged: ArrangedInstance[],
  plates: SceneEdit['plates'],
  sourceIdentifyIds: ModelSettingsIdentifyIds
): string {
  const instancesByPlate = new Map<number, ArrangedInstance[]>()
  for (const instance of arranged) {
    const list = instancesByPlate.get(instance.plateIndex) ?? []
    list.push(instance)
    instancesByPlate.set(instance.plateIndex, list)
  }
  // Every instance carries an identify_id: a returning (objectId, instanceId) keeps the
  // source's, new/duplicated instances get fresh ids above the source's maximum. Without
  // one the CLI assigns its own loaded_id at load time, which the slicer service cannot
  // predict — making printable="0" instances impossible to translate into --skip-objects.
  let nextIdentifyId = sourceIdentifyIds.maxId + 1
  const identifyIdFor = (instance: ArrangedInstance): number => {
    const preserved = sourceIdentifyIds.byInstance.get(`${instance.objectId}:${instance.instanceId}`)
    if (preserved != null) return preserved
    const allocated = nextIdentifyId
    nextIdentifyId += 1
    return allocated
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
        `      <metadata key="identify_id" value="${identifyIdFor(instance)}"/>`,
        `    </model_instance>`
      )
    }
    lines.push(`  </plate>`)
    return lines.join('\n')
  })
  return blocks.join('\n')
}

function replaceModelSettingsPlates(xml: string, platesXml: string): string {
  // No leading `[ \t]*` indentation trim: it made the scan quadratic on
  // whitespace-heavy uploads, and any orphaned indentation is inert in XML.
  const withoutPlates = xml.replace(/<plate\b[^>]*>[\s\S]*?<\/plate>\n?/g, '')
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
  /**
   * Named sub-solids when the import is a multi-solid assembly (a STEP with several parts). When
   * present (>1), the import bakes as ONE object whose solids are `<component>` parts, each with
   * its own `model_settings` `<part>` entry — instead of a single merged `<object><mesh>`. The
   * top-level {@link ImportedObjectInput.mesh} is the merged geometry, used only when this is absent.
   */
  parts?: Array<{ name: string; mesh: ImportedMesh }>
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

/** Sub-model relationships file: lists the `/3D/Objects/…model` part files the root model references. */
const THREE_MF_MODEL_RELS_ENTRY = '3D/_rels/3dmodel.model.rels'
/** Slice metadata: per-plate `<filament>` entries carrying each material's sliced `group_id` (nozzle). */
const SLICE_INFO_ENTRY = 'Metadata/slice_info.config'
const THREE_MF_3DMODEL_REL_TYPE = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel'

/**
 * Append a `<Relationship>` for each split-out import part file to the sub-model rels XML (or build a
 * fresh one when the source had none). Each part file MUST be declared here or BambuStudio won't load
 * it. Ids are derived from the part path so re-runs are stable and never collide with the source's.
 */
function appendImportPartRelationships(baseRelsXml: string | null, partFiles: ImportedPartFileEntry[]): string {
  const relationships = partFiles.map((entry) => {
    const id = `rel-${entry.name.replace(/[^a-zA-Z0-9]+/g, '-')}`
    return `  <Relationship Target="/${entry.name}" Id="${id}" Type="${THREE_MF_3DMODEL_REL_TYPE}"/>`
  })
  if (baseRelsXml && /<\/Relationships>/.test(baseRelsXml)) {
    return baseRelsXml.replace(/<\/Relationships>/, `${relationships.join('\n')}\n</Relationships>`)
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...relationships,
    '</Relationships>'
  ].join('\n')
}

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
function renderImportedMeshObjectXml(objectId: number, mesh: ImportedMesh, genUuid: (() => string) | null): string {
  const vertices: string[] = []
  for (let i = 0; i < mesh.positions.length; i += 3) {
    vertices.push(`     <vertex x="${formatMeshCoordinate(mesh.positions[i] ?? 0)}" y="${formatMeshCoordinate(mesh.positions[i + 1] ?? 0)}" z="${formatMeshCoordinate(mesh.positions[i + 2] ?? 0)}"/>`)
  }
  const triangles: string[] = []
  for (let i = 0; i < mesh.indices.length; i += 3) {
    triangles.push(`     <triangle v1="${mesh.indices[i] ?? 0}" v2="${mesh.indices[i + 1] ?? 0}" v3="${mesh.indices[i + 2] ?? 0}"/>`)
  }
  return [
    `  <object id="${objectId}"${productionUuidAttr(genUuid)} type="model">`,
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

/**
 * Render a multi-solid import's ROOT object: a `<components>` object (no mesh of its own) that
 * references each solid's mesh object by an identity transform. This is the object a build item
 * places, so the whole assembly moves/clones as one — exactly how BambuStudio loads a multi-part
 * STEP. (3MF requires an object be mesh XOR components; the solids carry the meshes.)
 *
 * When `partPath` is set the solids live in a separate `/3D/Objects/…model` sub-model (the
 * Production-Extension "split" layout BambuStudio writes); each component then carries `p:path` so
 * the reader resolves the solid in that part file. When null the solids are inline in the root model
 * (same-file lookup) — the fallback for non-production projects.
 */
function renderImportedComponentsObjectXml(
  objectId: number,
  componentObjectIds: number[],
  genUuid: (() => string) | null,
  partPath: string | null = null
): string {
  const pathAttr = partPath ? ` p:path="${escapeXmlAttribute(partPath)}"` : ''
  return [
    `  <object id="${objectId}"${productionUuidAttr(genUuid)} type="model">`,
    '   <components>',
    ...componentObjectIds.map((id) => `    <component${pathAttr} objectid="${id}"${productionUuidAttr(genUuid)} transform="${IDENTITY_THREE_MF_TRANSFORM}"/>`),
    '   </components>',
    '  </object>'
  ].join('\n')
}

/**
 * Wrap imported solid mesh objects in a standalone Production-Extension sub-model
 * (`/3D/Objects/…model`). BambuStudio splits every object into its own such part file and references
 * it via `p:path`; emitting large imported meshes here (instead of inline in the 13MB root model)
 * lets the editor fetch/parse only the objects a plate actually shows, and produces a byte-layout
 * that matches BambuStudio's own. Mirrors the header BS writes (confirmed to open in the GUI).
 */
function renderImportedPartFileModel(meshObjectXmls: string[]): string {
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

/** A sub-model part file produced for a split-out import, plus its `3D/_rels` relationship target. */
interface ImportedPartFileEntry {
  /** ZIP entry path, e.g. `3D/Objects/printstream_object_157.model` (no leading slash). */
  name: string
  content: string
}

/**
 * Render the `model_settings.config` entry for a multi-solid import: one `<part subtype="normal_part">`
 * per solid (keyed by its component object id, named, carrying the placing instance's filament as
 * `extruder` so every part keeps a material). Mirrors {@link renderImportedModelSettingsObjectXml}
 * for the single-mesh case.
 */
function renderImportedMultiPartModelSettingsXml(
  objectId: number,
  name: string,
  parts: Array<{ componentObjectId: number; name: string; extruder: number | null; processOverrides?: Record<string, string | string[]>; subtype?: string }>
): string {
  return [
    `  <object id="${objectId}">`,
    `    <metadata key="name" value="${escapeXmlAttribute(name)}"/>`,
    ...parts.flatMap((part) => [
      `    <part id="${part.componentObjectId}" subtype="${escapeXmlAttribute(part.subtype ?? 'normal_part')}">`,
      `      <metadata key="name" value="${escapeXmlAttribute(part.name)}"/>`,
      ...(part.extruder != null ? [`      <metadata key="extruder" value="${part.extruder}"/>`] : []),
      // Per-part process overrides set on the unsaved import, baked into the part's metadata
      // (process-setting keys only — structural keys must not be forgeable through this map).
      ...Object.entries(part.processOverrides ?? {}).filter(([key]) => isProcessSettingKey(key)).map(([key, value]) =>
        `      <metadata key="${escapeXmlAttribute(key)}" value="${escapeXmlAttribute(Array.isArray(value) ? value.join(';') : value)}"/>`),
      '    </part>'
    ]),
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
): { modelXml: string; modelSettingsXml: string; importIdToObjectId: ReadonlyMap<string, number>; partFileEntries: ImportedPartFileEntry[] } {
  let nextObjectId = maxThreeMfObjectId(baseModelXml, baseModelSettingsXml) + 1
  // When the source is a Production-Extension project, BambuStudio's GUI requires a p:UUID on every
  // injected object/component/build-item (see modelUsesProductionExtension); a fresh/core 3MF needs
  // none. Null disables UUID emission for the non-production case.
  const genUuid: (() => string) | null = modelUsesProductionExtension(baseModelXml) ? () => randomUUID() : null
  const importIdToObjectId = new Map<string, number>()
  const meshObjects: string[] = []
  const settingsObjects: string[] = []
  // Split-out sub-model part files for imported objects (Production-Extension layout). Populated only
  // for production-extension projects; each entry is written to the ZIP and declared in
  // 3D/_rels/3dmodel.model.rels by buildEditedThreeMf.
  const partFileEntries: ImportedPartFileEntry[] = []
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
  // Part-type changes for multi-solid imports: importId -> (solid index -> Bambu subtype).
  const importPartTypes = new Map<string, Map<number, string>>()
  for (const entry of edit.importPartTypes ?? []) {
    let byPart = importPartTypes.get(entry.importId)
    if (!byPart) { byPart = new Map(); importPartTypes.set(entry.importId, byPart) }
    byPart.set(entry.partIndex, entry.subtype)
  }
  const toExtruder = (filamentId: number | null): number | null =>
    filamentId != null ? filamentToExtruder.get(filamentId) ?? filamentId : null
  for (const imported of imports) {
    const objectId = nextObjectId
    nextObjectId += 1
    importIdToObjectId.set(imported.importId, objectId)
    const isPartImport = partImportIds.has(imported.importId)
    // A multi-solid import (STEP assembly) bakes as one object whose solids are component parts;
    // imports consumed as an added part volume stay single-mesh (applyAddedParts wraps them).
    const multiParts = !isPartImport && imported.parts && imported.parts.length > 1 ? imported.parts : null
    const objectExtruder = toExtruder(importFilament.get(imported.importId) ?? null)
    if (multiParts) {
      const componentIds = multiParts.map(() => {
        const id = nextObjectId
        nextObjectId += 1
        return id
      })
      const partFilaments = importPartFilament.get(imported.importId)
      const partProcess = importPartProcess.get(imported.importId)
      const partTypes = importPartTypes.get(imported.importId)
      const solidMeshXmls = multiParts.map((part, i) => renderImportedMeshObjectXml(componentIds[i]!, part.mesh, genUuid))
      if (genUuid) {
        // Production extension: emit the solids as a separate /3D/Objects sub-model and reference
        // them by p:path — so a plate fetches/parses only this import's part file, not the whole
        // root model, and the layout matches BambuStudio's. The root keeps just the small assembly.
        const partFilePath = `3D/Objects/printstream_object_${objectId}.model`
        partFileEntries.push({ name: partFilePath, content: renderImportedPartFileModel(solidMeshXmls) })
        meshObjects.push(renderImportedComponentsObjectXml(objectId, componentIds, genUuid, `/${partFilePath}`))
      } else {
        // Non-production project: keep the solids inline in the root model (same-file components).
        meshObjects.push(...solidMeshXmls)
        meshObjects.push(renderImportedComponentsObjectXml(objectId, componentIds, genUuid))
      }
      settingsObjects.push(renderImportedMultiPartModelSettingsXml(
        objectId,
        imported.name,
        // Each solid keeps its own filament when assigned; otherwise it inherits the object's.
        multiParts.map((part, i) => ({
          componentObjectId: componentIds[i]!,
          name: part.name,
          extruder: toExtruder(partFilaments?.get(i) ?? null) ?? objectExtruder,
          // Per-part process overrides set on the unsaved import (keyed by solid index).
          processOverrides: partProcess?.get(i),
          // Part type chosen on the unsaved import (Change type); defaults to normal_part.
          subtype: partTypes?.get(i)
        }))
      ))
    } else {
      meshObjects.push(renderImportedMeshObjectXml(objectId, imported.mesh, genUuid))
      if (!isPartImport) {
        settingsObjects.push(renderImportedModelSettingsObjectXml(objectId, imported.name, objectExtruder))
      }
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
  modelXml = replaceThreeMfBuildSection(modelXml, renderArrangedBuildItems(arranged, genUuid))

  let modelSettingsXml = injectModelSettingsObjects(baseModelSettingsXml, settingsObjects.join('\n'))
  modelSettingsXml = replaceModelSettingsPlates(
    modelSettingsXml,
    renderArrangedModelSettingsPlates(arranged, edit.plates, parseModelSettingsIdentifyIds(baseModelSettingsXml))
  )

  // Attach added part volumes BEFORE the unreferenced-object sweep: a part mesh is
  // only kept alive by the <component> reference inserted here.
  if (edit.addedParts && edit.addedParts.length > 0) {
    const applied = applyAddedParts(modelXml, modelSettingsXml, edit.addedParts, importIdToObjectId, () => {
      const id = nextObjectId
      nextObjectId += 1
      return id
    }, genUuid)
    modelXml = applied.modelXml
    modelSettingsXml = applied.modelSettingsXml
  }

  const cleaned = removeUnreferencedObjects(modelXml, modelSettingsXml, new Set(arranged.map((instance) => instance.objectId)))
  modelXml = cleaned.modelXml
  modelSettingsXml = cleaned.modelSettingsXml

  if (edit.partFilaments && edit.partFilaments.length > 0) {
    modelSettingsXml = applyPartFilamentOverrides(modelSettingsXml, baseModelSettingsXml, edit.partFilaments)
  }

  if (edit.partProcessOverrides && edit.partProcessOverrides.length > 0) {
    modelSettingsXml = applyPartProcessOverrides(modelSettingsXml, edit.partProcessOverrides)
  }

  if (edit.partTypeChanges && edit.partTypeChanges.length > 0) {
    modelSettingsXml = applyPartTypeChanges(modelSettingsXml, edit.partTypeChanges)
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

  return { modelXml, modelSettingsXml, importIdToObjectId, partFileEntries }
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
  allocateObjectId: () => number,
  genUuid: (() => string) | null
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
    const componentXml = `    <component objectid="${partObjectId}"${productionUuidAttr(genUuid)} transform="${transform}"/>`
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
        `  <object id="${meshObjectId}"${productionUuidAttr(genUuid)} type="model">`,
        `   ${meshMatch[0]}`,
        '  </object>'
      ].join('\n')
      const nextBody = body.replace(/<mesh\b[\s\S]*?<\/mesh>/, [
        '<components>',
        `    <component objectid="${meshObjectId}"${productionUuidAttr(genUuid)} transform="${IDENTITY_THREE_MF_TRANSFORM}"/>`,
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
  // Process-setting keys only: the name/extruder/matrix entries are authored explicitly, so a
  // structural key smuggled through the settings map must not duplicate or clobber them.
  const settingsXml = Object.entries(settings ?? {}).filter(([key]) => isProcessSettingKey(key)).map(([key, value]) =>
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
 * Apply per-PART process overrides: set each part's process `<metadata>` inside its
 * `model_settings.config` `<part>` block (replacing the whole non-structural override set so a
 * cleared key is removed), keyed by objectId + componentObjectId. Mirrors
 * {@link applyObjectProcessOverridesXml} but scoped to one part rather than the object head.
 */
export function applyPartProcessOverrides(modelSettingsXml: string, overrides: SceneEditPartProcessOverride[]): string {
  const byObjectPart = new Map<number, Map<number, Record<string, string | string[]>>>()
  for (const override of overrides) {
    let parts = byObjectPart.get(override.objectId)
    if (!parts) { parts = new Map(); byObjectPart.set(override.objectId, parts) }
    parts.set(override.componentObjectId, override.overrides)
  }
  return modelSettingsXml.replace(/<object\b([^>]*)>[\s\S]*?<\/object>/g, (objectBlock, attrs: string) => {
    const objectId = Number.parseInt(parseAttrs(attrs).id ?? '', 10)
    const parts = byObjectPart.get(objectId)
    if (!parts) return objectBlock
    return objectBlock.replace(/<part\b([^>]*)>([\s\S]*?)<\/part>/g, (partBlock, partAttrs: string, partBody: string) => {
      const partId = Number.parseInt(parseAttrs(partAttrs).id ?? '', 10)
      const partOverrides = parts.get(partId)
      if (!partOverrides) return partBlock
      // Drop existing part-level PROCESS overrides only; keep everything else (name/extruder AND
      // identity/placement metadata like source_object_id, source_offset_*, matrix).
      const stripped = partBody.replace(/[ \t]*<metadata\s+key="([^"]+)"\s+value="[^"]*"\s*\/>\n?/g, (line, key: string) =>
        isProcessSettingKey(key) ? '' : line)
      // Inject ONLY process-setting keys. A stale/hand-built request whose override map carries
      // structural metadata (matrix, source_offset_*, name, extruder) must not clobber — or
      // duplicate — the part's real entries, which the strip above deliberately preserved.
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
 * `model_settings.config`. Keyed by objectId + componentObjectId like
 * {@link applyPartProcessOverrides}; the type is shared by every instance of the object.
 */
export function applyPartTypeChanges(modelSettingsXml: string, changes: SceneEditPartTypeChange[]): string {
  const byObjectPart = new Map<number, Map<number, string>>()
  for (const change of changes) {
    let parts = byObjectPart.get(change.objectId)
    if (!parts) { parts = new Map(); byObjectPart.set(change.objectId, parts) }
    parts.set(change.componentObjectId, change.subtype)
  }
  return modelSettingsXml.replace(/<object\b([^>]*)>[\s\S]*?<\/object>/g, (objectBlock, attrs: string) => {
    const objectId = Number.parseInt(parseAttrs(attrs).id ?? '', 10)
    const parts = byObjectPart.get(objectId)
    if (!parts) return objectBlock
    return objectBlock.replace(/<part\b([^>]*)>/g, (partTag, partAttrs: string) => {
      const parsed = parseAttrs(partAttrs)
      const subtype = parts.get(Number.parseInt(parsed.id ?? '', 10))
      if (!subtype) return partTag
      if (/\bsubtype="[^"]*"/.test(partAttrs)) {
        return `<part${partAttrs.replace(/\bsubtype="[^"]*"/, `subtype="${escapeXmlAttribute(subtype)}"`)}>`
      }
      return `<part${partAttrs} subtype="${escapeXmlAttribute(subtype)}">`
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
 * Persist the editor's per-material dual-nozzle assignment into `project_settings.config`.
 *
 * `filament_nozzle_map` is written **verbatim** as each slot's runtime nozzle id (0 = right,
 * 1 = left) — the same nozzle-id space the index parser (`extractNozzleMapping`) reads back and
 * the slicer writes. Per the nozzle-mapping invariant, do NOT remap it through
 * `physical_extruder_map`: a second inversion mis-assigns nozzles on non-identity machines (the
 * H2D's `["1","0"]`) and fails dual-nozzle offset calibration (printer error 0300-4010).
 *
 * `extruder_nozzle_stats` is rebuilt so an extruder reads "active" iff a filament is assigned to
 * it — otherwise a stale single-active reading short-circuits `extractNozzleMapping` and forces
 * every filament onto one nozzle (which is exactly how a save silently reverts to the old nozzle).
 * The rebuild is coarse (one `Standard` bucket per extruder) and only runs when the edit assigns
 * EVERY slot a nozzle, so the active/inactive set is complete; the slicer regenerates the precise
 * per-volume-type stats at the next slice. A no-op on single-nozzle projects
 * (`physical_extruder_map` shorter than 2) or when no filament carries a nozzle id.
 */
export function applyNozzleAssignmentToProjectSettings(projectSettingsJson: string, filaments: SceneEditFilament[]): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return projectSettingsJson
  }
  if (!parsed || typeof parsed !== 'object') return projectSettingsJson
  const record = parsed as Record<string, unknown>
  const physicalExtruderMap = stringArray(record.physical_extruder_map)
  if (physicalExtruderMap.length < 2) return projectSettingsJson
  if (!filaments.some((filament) => filament.nozzleId != null)) return projectSettingsJson

  const nozzleMap = Array.isArray(record.filament_nozzle_map) ? record.filament_nozzle_map.map((value) => String(value)) : []
  const extruderUsage = new Array<number>(physicalExtruderMap.length).fill(0)
  filaments.forEach((filament, index) => {
    if (filament.nozzleId == null) return
    while (nozzleMap.length <= index) nozzleMap.push('')
    nozzleMap[index] = String(filament.nozzleId)
    const extruder = sliceExtruderForNozzleId(filament.nozzleId, physicalExtruderMap)
    if (extruder != null && extruder < extruderUsage.length) extruderUsage[extruder] = (extruderUsage[extruder] ?? 0) + 1
  })
  record.filament_nozzle_map = nozzleMap
  if (filaments.every((filament) => filament.nozzleId != null)) {
    record.extruder_nozzle_stats = extruderUsage.map((count) => `Standard#${count}`)
  }

  return JSON.stringify(record)
}

/**
 * Move each `<filament id=…>`'s `group_id` in `slice_info.config` onto the slicer extruder that
 * feeds its desired runtime nozzle. slice_info's group ids are the authoritative signal the index
 * parser prefers once a project carries concrete slice usage, so they must follow the assignment or
 * a reopened sliced project shows the pre-edit nozzle. Filaments the edit does not (re)assign, and
 * files without a matching `<filament>` entry, are left byte-for-byte intact. A no-op on
 * single-nozzle projects or when no assignment inverts to a valid extruder.
 */
export function rewriteSliceInfoNozzleGroups(sliceInfoXml: string, filaments: SceneEditFilament[], physicalExtruderMap: string[]): string {
  if (physicalExtruderMap.length < 2) return sliceInfoXml
  const groupByFilamentId = new Map<number, number>()
  filaments.forEach((filament, index) => {
    if (filament.nozzleId == null) return
    const extruder = sliceExtruderForNozzleId(filament.nozzleId, physicalExtruderMap)
    if (extruder != null) groupByFilamentId.set(index + 1, extruder)
  })
  if (groupByFilamentId.size === 0) return sliceInfoXml
  return sliceInfoXml.replace(/<filament\b([^>]*?)(\/?)>(?:<\/filament>)?/g, (match, attrs: string, selfClosing: string) => {
    const idMatch = attrs.match(/\sid="(\d+)"/)
    const filamentId = Number.parseInt(idMatch?.[1] ?? '', 10)
    const group = Number.isInteger(filamentId) ? groupByFilamentId.get(filamentId) : undefined
    if (group == null) return match
    const nextAttrs = upsertXmlIntAttribute(attrs, 'group_id', group)
    return `<filament${nextAttrs}${selfClosing === '/' ? '/>' : '></filament>'}`
  })
}

/** Replace an integer XML attribute in an attribute string, or append it when absent. */
function upsertXmlIntAttribute(attrs: string, key: string, value: number): string {
  const pattern = new RegExp(`\\s${key}="[^"]*"`)
  const replacement = ` ${key}="${value}"`
  return pattern.test(attrs) ? attrs.replace(pattern, replacement) : `${attrs}${replacement}`
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
  pauseEdits?: SceneEditPlatePauses[]
): string {
  const sourcePlates = new Map<number, { toolChanges: CustomGcodeLayerTag[]; pauses: CustomGcodeLayerTag[]; others: CustomGcodeLayerTag[]; mode: string | null }>()
  if (sourceXml) {
    for (const plateMatch of sourceXml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
      const block = plateMatch[1] ?? ''
      const id = Number.parseInt(parseAttrs(/<plate_info\b([^>]*)\/>/.exec(block)?.[1] ?? '').id ?? '', 10)
      if (!Number.isInteger(id) || id <= 0) continue
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
  // The sliced project's `slice_info.config` (per-plate `<filament>` group ids). Read so a nozzle
  // reassignment can move each filament's `group_id` — the signal the index parser prefers once a
  // project carries concrete slice usage — onto the chosen nozzle. Null for unsliced projects.
  let baseSliceInfoXml: string | null = null
  // The sub-model relationships file (Production-Extension projects). Split-out imported part files
  // are appended here so BambuStudio loads them; null when the source has none (we create one then).
  let baseModelRelsXml: string | null = null
  if (baseSourcePath) {
    baseModelXml = (await readEntry(baseSourcePath, '3D/3dmodel.model', undefined, 256 * 1024 * 1024)).toString('utf8')
    baseModelRelsXml = await readEntry(baseSourcePath, THREE_MF_MODEL_RELS_ENTRY, undefined, 4 * 1024 * 1024)
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => null)
    // Default 8 MiB cap — matches the bridge's bound for the same entry, and
    // bounds the plate-rewrite regex scans over this XML.
    baseModelSettingsXml = await readEntry(baseSourcePath, 'Metadata/model_settings.config')
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => NEW_PROJECT_MODEL_SETTINGS_XML)
    projectSettingsJson = await readEntry(baseSourcePath, 'Metadata/project_settings.config', undefined, 8 * 1024 * 1024)
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => null)
    baseCustomGcodeXml = await readEntry(baseSourcePath, CUSTOM_GCODE_PER_LAYER_ENTRY, undefined, 4 * 1024 * 1024)
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => null)
    baseSliceInfoXml = await readEntry(baseSourcePath, SLICE_INFO_ENTRY, undefined, 8 * 1024 * 1024)
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
  // Layer-based filament changes + layer pauses: merged with the source sidecar
  // (preserving unedited entry types and plates); both absent keeps the source file untouched.
  const customGcodeContent = edit.filamentChanges !== undefined || edit.pauses !== undefined
    ? mergeCustomGcodePerLayer(baseCustomGcodeXml, edit.filamentChanges, edit.pauses)
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
    // The project's slicer->runtime nozzle map, needed to move slice_info group ids onto the
    // chosen nozzles. Empty for single-nozzle projects or a from-scratch project with no settings.
    let physicalExtruderMap: string[] = []
    if (projectSettingsJson) {
      try {
        const parsed: unknown = JSON.parse(projectSettingsJson)
        if (parsed && typeof parsed === 'object') physicalExtruderMap = stringArray((parsed as Record<string, unknown>).physical_extruder_map)
      } catch { /* not JSON we can read; leave the nozzle map empty */ }
    }
    // Compose project_settings.config rewrites: filament set first (add/remove materials), then the
    // per-slot dual-nozzle assignment, then per-plate prime-tower corners.
    const projectSettingsTransforms: Array<(xml: string) => string> = []
    if (edit.filaments && edit.filaments.length > 0) {
      const filaments = edit.filaments
      projectSettingsTransforms.push((xml) => applyFilamentList(xml, filaments))
      projectSettingsTransforms.push((xml) => applyNozzleAssignmentToProjectSettings(xml, filaments))
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
    // slice_info.config: move each reassigned filament's group_id onto the chosen nozzle so a
    // reopened sliced project reflects the new assignment (group ids outrank filament_nozzle_map
    // once the project carries concrete slice usage). Only when the source shipped slice_info.
    if (edit.filaments && edit.filaments.length > 0 && baseSliceInfoXml !== null && physicalExtruderMap.length >= 2) {
      const filaments = edit.filaments
      transforms.set(SLICE_INFO_ENTRY, (xml) => rewriteSliceInfoNozzleGroups(xml, filaments, physicalExtruderMap))
    }
    // Split-out imported sub-models: write each part file and declare it in the sub-model rels so
    // BambuStudio loads them (transform the existing rels, or add a fresh one if the source had none).
    if (documents.partFileEntries.length > 0) {
      for (const partFile of documents.partFileEntries) extraEntries.push(partFile)
      const updatedModelRels = appendImportPartRelationships(baseModelRelsXml, documents.partFileEntries)
      if (baseModelRelsXml !== null) {
        transforms.set(THREE_MF_MODEL_RELS_ENTRY, () => updatedModelRels)
      } else {
        extraEntries.push({ name: THREE_MF_MODEL_RELS_ENTRY, content: updatedModelRels })
      }
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
