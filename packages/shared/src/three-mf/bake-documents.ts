/**
 * The 3MF bake, as pure document transforms.
 *
 * Owns every string-to-string rewrite the editor's write path performs: injecting imported meshes
 * as new `<object><mesh>` resources, regenerating the root model's build items and
 * `model_settings.config` plates/instances, applying per-part filament/type/transform/paint edits,
 * and rewriting `project_settings.config` for filament, plate-type, and prime-tower changes.
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
import { canonicalCurrBedType } from '../plate-types.js'
import { FILAMENT_SETTING_KEYS } from '../filament-settings.js'
import { isProcessSettingKey } from '../process-settings.js'
import { threeMfPartSubtypeCarriesFilament } from '../three-mf-part-subtype.js'
import type {
  SceneEdit,
  SceneEditFilament,
  SceneEditObjectBrimEars,
  SceneEditPartFilament,
  SceneEditPartPaint,
  SceneEditPartProcessOverride,
  SceneEditPartTransform,
  SceneEditPartTypeChange,
  SceneEditPlateFilamentChanges,
  SceneEditPlatePauses
} from '../slicing.js'
import type { ImportedMesh } from './imported-mesh.js'
import {
  PRINTSTREAM_MODEL_KIND_KEY,
  PRINTSTREAM_MODEL_KIND_OBJECT_EXPORT,
  extractPlateType,
  normalizeColor,
  parseAttrs,
  sliceExtruderForNozzleId,
  stringArray
} from './index-parser.js'
import { applyObjectClones } from './object-clone.js'
import { repairImportedMeshGeometry } from './mesh-repair.js'
import {
  LOGICAL_PART_PLATE_GAP,
  extractSceneBed,
  parseModelSettingsScene,
  parseRootModelComponents,
  parseRootModelObjectIdOrder
} from './scene-parser.js'
import { escapeXmlAttribute } from './xml-write.js'

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
  parts?: Array<{ name: string; mesh: ImportedMesh; subtype?: string | null }>
}

// The `Application: BambuStudio-…` metadata is what makes BambuStudio recognize the file as its
// own project (`is_bbl_3mf`). Without it the CLI refuses per-plate slicing ("not support to slice
// plate N, reset to 0") and drops per-plate custom G-code — so a from-scratch project (new-project
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

export const THREE_MF_RELS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '  <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
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

/** Sub-model relationships file: lists the `/3D/Objects/…model` part files the root model references. */
/** Slice metadata: per-plate `<filament>` entries carrying each material's sliced `group_id` (nozzle). */
const THREE_MF_3DMODEL_REL_TYPE = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel'

/**
 * Append a `<Relationship>` for each split-out import part file to the sub-model rels XML (or build a
 * fresh one when the source had none). Each part file MUST be declared here or BambuStudio won't load
 * it. Ids are derived from the part path so re-runs are stable and never collide with the source's.
 */
export function appendImportPartRelationships(baseRelsXml: string | null, partFiles: ImportedPartFileEntry[]): string {
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
/** Test seam for the import paint contract (see `mesh-import.test.ts`). */
export function renderImportedMeshObjectXmlForTest(objectId: number, mesh: ImportedMesh): string {
  return renderImportedMeshObjectXml(objectId, mesh, null)
}

function renderImportedMeshObjectXml(
  objectId: number,
  mesh: ImportedMesh,
  genUuid: (() => string) | null,
  /**
   * Triangle paint for this mesh, by channel attribute and triangle index. Indices are positions
   * in `mesh.indices` — the SAME order the editor rendered through `meshToBinaryStl`, which is
   * what makes painting an unsaved import safe (contract pinned in `mesh-import.test.ts`).
   */
  paint?: ReadonlyMap<TrianglePaintAttribute, Record<string, string>>
): string {
  const vertices: string[] = []
  for (let i = 0; i < mesh.positions.length; i += 3) {
    vertices.push(`     <vertex x="${formatMeshCoordinate(mesh.positions[i] ?? 0)}" y="${formatMeshCoordinate(mesh.positions[i + 1] ?? 0)}" z="${formatMeshCoordinate(mesh.positions[i + 2] ?? 0)}"/>`)
  }
  const triangles: string[] = []
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const triangleIndex = i / 3
    let attrs = ''
    if (paint) {
      for (const [attribute, codes] of paint) {
        const code = codes[String(triangleIndex)]
        if (code) attrs += ` ${attribute}="${escapeXmlAttribute(code)}"`
      }
    }
    triangles.push(`     <triangle v1="${mesh.indices[i] ?? 0}" v2="${mesh.indices[i + 1] ?? 0}" v3="${mesh.indices[i + 2] ?? 0}"${attrs}/>`)
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
  partPath: string | null = null,
  /**
   * Per-solid object-local placement, by the same index as `componentObjectIds`. An import's
   * per-solid meshes already share assembly space, so a solid the user never moved stays at
   * identity; `SceneEdit.importPartTransforms` supplies the rest (the gizmo on an import sub-part).
   */
  partTransforms?: ReadonlyMap<number, readonly number[]>
): string {
  const pathAttr = partPath ? ` p:path="${escapeXmlAttribute(partPath)}"` : ''
  return [
    `  <object id="${objectId}"${productionUuidAttr(genUuid)} type="model">`,
    '   <components>',
    ...componentObjectIds.map((id, index) => {
      const matrix = partTransforms?.get(index)
      const transform = matrix ? matrix.map(formatThreeMfTransformValue).join(' ') : IDENTITY_THREE_MF_TRANSFORM
      return `    <component${pathAttr} objectid="${id}"${productionUuidAttr(genUuid)} transform="${transform}"/>`
    }),
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
} {
  // When the source is a Production-Extension project, BambuStudio's GUI requires a p:UUID on every
  // injected object/component/build-item (see modelUsesProductionExtension); a fresh/core 3MF needs
  // none. Null disables UUID emission for the non-production case.
  const genUuid: (() => string) | null = modelUsesProductionExtension(baseModelXml) ? () => globalThis.crypto.randomUUID() : null
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
  let nextObjectId = cloned.nextObjectId
  const importIdToObjectId = new Map<string, number>()
  const meshObjects: string[] = []
  const settingsObjects: string[] = []
  // Split-out sub-model part files for imported objects (Production-Extension layout). Populated only
  // for production-extension projects; each entry is written to the ZIP and declared in
  // 3D/_rels/3dmodel.model.rels by buildEditedThreeMf.
  // Seeded with the copies' sub-model files (see the clone pre-pass above); imports append theirs.
  const partFileEntries: ImportedPartFileEntry[] = [...cloned.partFileEntries]
  // Imports consumed as added PART volumes become components of an existing object:
  // they get a mesh object resource but no standalone model_settings object entry and
  // are never placed by build items.
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
  const importPartTransforms = new Map<string, Map<number, readonly number[]>>()
  for (const entry of edit.importPartTransforms ?? []) {
    let byPart = importPartTransforms.get(entry.importId)
    if (!byPart) { byPart = new Map(); importPartTransforms.set(entry.importId, byPart) }
    byPart.set(entry.partIndex, entry.matrix)
  }
  // Triangle paint authored on a not-yet-saved import: importId -> solid index -> attribute -> codes.
  const importPaint = new Map<string, Map<number, Map<TrianglePaintAttribute, Record<string, string>>>>()
  for (const entry of edit.importPaint ?? []) {
    const attribute: TrianglePaintAttribute = entry.channel === 'seam'
      ? 'paint_seam'
      : entry.channel === 'color' ? 'paint_color' : 'paint_supports'
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
      const partTransforms = importPartTransforms.get(imported.importId)
      const solidPaint = importPaint.get(imported.importId)
      const solidMeshXmls = multiParts.map((part, i) => renderImportedMeshObjectXml(componentIds[i]!, part.mesh, genUuid, solidPaint?.get(i)))
      if (genUuid) {
        // Production extension: emit the solids as a separate /3D/Objects sub-model and reference
        // them by p:path — so a plate fetches/parses only this import's part file, not the whole
        // root model, and the layout matches BambuStudio's. The root keeps just the small assembly.
        const partFilePath = `3D/Objects/printstream_object_${objectId}.model`
        partFileEntries.push({ name: partFilePath, content: renderImportedPartFileModel(solidMeshXmls) })
        meshObjects.push(renderImportedComponentsObjectXml(objectId, componentIds, genUuid, `/${partFilePath}`, partTransforms))
      } else {
        // Non-production project: keep the solids inline in the root model (same-file components).
        meshObjects.push(...solidMeshXmls)
        meshObjects.push(renderImportedComponentsObjectXml(objectId, componentIds, genUuid, null, partTransforms))
      }
      settingsObjects.push(renderImportedMultiPartModelSettingsXml(
        objectId,
        imported.name,
        // Each solid keeps its own filament when assigned; otherwise it inherits the object's.
        multiParts.map((part, i) => ({
          componentObjectId: componentIds[i]!,
          name: part.name,
          // A helper volume carries no material (BambuStudio writes extruder 0), so it must
          // never inherit the object's — see threeMfPartSubtypeCarriesFilament.
          extruder: threeMfPartSubtypeCarriesFilament(partTypes?.get(i) ?? part.subtype ?? null)
            ? toExtruder(partFilaments?.get(i) ?? null) ?? objectExtruder
            : null,
          // Per-part process overrides set on the unsaved import (keyed by solid index).
          processOverrides: partProcess?.get(i),
          // The type the user chose on the unsaved import ("Change type") wins; otherwise the
          // solid keeps the type it was imported WITH — a 3MF's support blocker stays a blocker
          // instead of silently baking as printed geometry.
          subtype: partTypes?.get(i) ?? part.subtype ?? undefined
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

  // A material add/remove remaps each part's `extruder` from its OLD filament slot to the new id.
  // This applies ONLY to parts inherited from the BASE project: every part the bake authors below
  // (imported solids via `settingsObjects`, added volumes, per-part reassignments) is already
  // written in the NEW filament-id space, so it must not be remapped. Remapping the base HERE —
  // before those parts are injected — is what keeps a fresh multi-solid import's per-part materials
  // from being double-remapped and collapsed to filament 1. No-op when the filament set is unchanged.
  let baseModelSettingsForInject = baseModelSettingsXml
  if (edit.filaments && edit.filaments.length > 0) {
    const oldIndexToNewId = new Map<number, number>()
    edit.filaments.forEach((filament, i) => {
      // null sourceIndex means "same slot" (identity), matching applyFilamentList; the
      // first new slot referencing an old index wins (kept slots precede cloned adds).
      const src = filament.sourceIndex ?? i
      if (!oldIndexToNewId.has(src)) oldIndexToNewId.set(src, i + 1)
    })
    baseModelSettingsForInject = remapPartExtruders(baseModelSettingsXml, oldIndexToNewId)
  }

  let modelSettingsXml = injectModelSettingsObjects(baseModelSettingsForInject, settingsObjects.join('\n'))
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
    }, genUuid, filamentToExtruder)
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

  if (edit.partTransforms && edit.partTransforms.length > 0) {
    const applied = applyPartTransforms(modelXml, modelSettingsXml, edit.partTransforms)
    modelXml = applied.modelXml
    modelSettingsXml = applied.modelSettingsXml
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

  // NOTE: the OLD-slot -> NEW-id part-extruder remap for a material add/remove happens on the
  // BASE model_settings BEFORE the bake-authored parts are injected (see above), so the imported
  // solids / added volumes / per-part reassignments keep the new-id extruders written for them.

  return { modelXml, modelSettingsXml, importIdToObjectId, partFileEntries, clonedObjectIds: cloned.resolvedIds }
}

const IDENTITY_THREE_MF_TRANSFORM = '1 0 0 0 1 0 0 0 1 0 0 0'

/**
 * Bake the edit's added part volumes (normal parts, negative parts, modifiers, support
 * blockers/enforcers) into the documents: each part's already-injected mesh object is
 * referenced as a `<component>` of its host root object (object-local transform),
 * and the host's `model_settings.config` entry gains a `<part>` with the Bambu
 * subtype. Hosts that carry their mesh inline (imports saved by an earlier session,
 * generic 3MFs) are first wrapped: the mesh moves to a new object referenced by an
 * identity component, and the host's existing settings `<part>` is re-keyed to that
 * new id so 3MF's object = mesh XOR components rule holds.
 *
 * Must run AFTER the edit's imports are injected: an added part's host may itself be a staged
 * import (a part added to a model the user has not saved yet), which is only resolvable through
 * `importIdToObjectId`. The inline-mesh wrapping branch below is the normal path for such a host,
 * since a freshly baked import always carries its mesh inline.
 */
function applyAddedParts(
  modelXml: string,
  modelSettingsXml: string,
  addedParts: NonNullable<SceneEdit['addedParts']>,
  importIdToObjectId: ReadonlyMap<string, number>,
  allocateObjectId: () => number,
  genUuid: (() => string) | null,
  filamentToExtruder: ReadonlyMap<number, number>
): { modelXml: string; modelSettingsXml: string } {
  for (const part of addedParts) {
    const partObjectId = importIdToObjectId.get(part.meshImportId)
    if (partObjectId == null) {
      throw new Error('Scene edit adds a part from an unknown imported mesh')
    }
    const hostObjectId = part.objectId ?? (part.importId != null ? importIdToObjectId.get(part.importId) : undefined)
    if (hostObjectId == null) {
      throw new Error('Scene edit adds a part to an unknown host model')
    }
    const parentPattern = new RegExp(`(<object\\b[^>]*\\bid="${hostObjectId}"(?:[^>]*)>)([\\s\\S]*?)(</object>)`)
    const parentMatch = modelXml.match(parentPattern)
    if (!parentMatch) {
      throw new Error(`Scene edit adds a part to a missing object ${hostObjectId}`)
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
        new RegExp(`(<object\\b[^>]*\\bid="${hostObjectId}"[^>]*>[\\s\\S]*?)<part id="${hostObjectId}"`),
        `$1<part id="${meshObjectId}"`
      )
    } else {
      throw new Error(`Object ${hostObjectId} has neither mesh nor components`)
    }
    // Only a filament-carrying subtype gets an extruder; see threeMfPartSubtypeCarriesFilament.
    const extruder = part.filamentId != null && threeMfPartSubtypeCarriesFilament(part.subtype)
      ? filamentToExtruder.get(part.filamentId) ?? part.filamentId
      : undefined
    modelSettingsXml = addModelSettingsPartEntry(
      modelSettingsXml, hostObjectId, partObjectId, part.subtype, part.name, part.settings, extruder
    )
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
  settings?: Record<string, string>,
  extruder?: number
): string {
  // Process-setting keys only: the name/extruder/matrix entries are authored explicitly, so a
  // structural key smuggled through the settings map must not duplicate or clobber them.
  const settingsXml = Object.entries(settings ?? {}).filter(([key]) => isProcessSettingKey(key)).map(([key, value]) =>
    `      <metadata key="${escapeXmlAttribute(key)}" value="${escapeXmlAttribute(value)}"/>`)
  const partXml = [
    `    <part id="${partObjectId}" subtype="${escapeXmlAttribute(subtype)}">`,
    `      <metadata key="name" value="${escapeXmlAttribute(name)}"/>`,
    ...(extruder != null ? [`      <metadata key="extruder" value="${extruder}"/>`] : []),
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
 * Apply part-placement changes (move/rotate/scale a part inside its object). The
 * authoritative placement — what BambuStudio and the CLI slicer load into the volume's
 * transformation — is the part's `<component transform>` in the 3D model (12 numbers,
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
    parts.set(change.componentObjectId, change.matrix)
  }
  const nextModelXml = modelXml.replace(/<object\b([^>]*)>[\s\S]*?<\/object>/g, (objectBlock, attrs: string) => {
    const objectId = Number.parseInt(parseAttrs(attrs).id ?? '', 10)
    const parts = byObjectPart.get(objectId)
    if (!parts) return objectBlock
    return objectBlock.replace(/<component\b([^>]*)\/>/g, (componentTag, componentAttrs: string) => {
      const matrix = parts.get(Number.parseInt(parseAttrs(componentAttrs).objectid ?? '', 10))
      if (!matrix) return componentTag
      const transform = matrix.map(formatThreeMfTransformValue).join(' ')
      if (/\btransform="[^"]*"/.test(componentAttrs)) {
        return `<component${componentAttrs.replace(/\btransform="[^"]*"/, `transform="${transform}"`)}/>`
      }
      return `<component${componentAttrs} transform="${transform}"/>`
    })
  })
  const nextModelSettingsXml = modelSettingsXml.replace(/<object\b([^>]*)>[\s\S]*?<\/object>/g, (objectBlock, attrs: string) => {
    const objectId = Number.parseInt(parseAttrs(attrs).id ?? '', 10)
    const parts = byObjectPart.get(objectId)
    if (!parts) return objectBlock
    return objectBlock.replace(/<part\b([^>]*)>[\s\S]*?<\/part>/g, (partBlock, partAttrs: string) => {
      const matrix = parts.get(Number.parseInt(parseAttrs(partAttrs).id ?? '', 10))
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
 * Per-filament arrays that carry IDENTITY / STRUCTURE (a user choice or the key that drives
 * slice-time re-resolution), not material physics. On a material change these are kept (remapped
 * from the source slot) while every other filament-indexed array is dropped — see
 * {@link applyFilamentList}. `filament_settings_id` must stay: it names the new preset the slicer
 * re-derives physics from; `filament_nozzle_map` is a project-level assignment no filament preset
 * would restore.
 */
const FILAMENT_IDENTITY_KEYS = new Set([
  'filament_colour',
  'filament_type',
  'filament_settings_id',
  'filament_ids',
  'filament_nozzle_map'
])

/**
 * Machine-domain arrays that live in `project_settings.config` but are indexed by EXTRUDER (or
 * are machine-level lists), NOT by filament. {@link applyFilamentList} identifies filament-indexed
 * arrays by length, and on a dual-nozzle machine with exactly two filaments every one of these
 * length-2 arrays is indistinguishable from a filament array by length alone — the remap would
 * corrupt them on an add/remove and the material-change drop DELETED them (a real save on an H2D
 * stripped `nozzle_diameter`/`physical_extruder_map`/`extruder_type`/`extruder_variant_list`,
 * leaving a project the slicer's machine-switch guard rejects as missing its dual-nozzle
 * topology). These keys must never be remapped or dropped by the filament rewrite.
 *
 * Sourced from BambuStudio's own preset-domain split (vendored source,
 * `libslic3r/Preset.cpp` `s_Preset_printer_options` + `s_Preset_machine_limits_options`, and
 * `PrintConfig.cpp` `init_extruder_option_keys`) plus the runtime-derived machine maps observed
 * in real projects (`extruder_nozzle_stats`, `extruder_ams_count`, `start_end_points`) and the
 * project-level printer-compatibility declarations. The bare extruder-indexed names are listed;
 * their per-filament override twins use `filament_*` prefixes and stay strippable. An unknown NEW
 * machine key from a future BambuStudio would still be misclassified — the slicer-side same-model
 * topology heal (machine-switch-guard) backstops that by re-authoring the machine block.
 */
const MACHINE_DOMAIN_ARRAY_KEYS = new Set([
  // Preset.cpp s_Preset_printer_options (Bambu-relevant subset; scalars included harmlessly).
  'printable_area', 'extruder_printable_area', 'bed_exclude_area', 'gcode_flavor',
  'machine_start_gcode', 'machine_end_gcode', 'printing_by_object_gcode', 'before_layer_change_gcode',
  'layer_change_gcode', 'time_lapse_gcode', 'wrapping_detection_gcode', 'change_filament_gcode',
  'printer_model', 'printer_variant', 'printer_extruder_id', 'printer_extruder_variant',
  'extruder_variant_list', 'default_nozzle_volume_type', 'printable_height', 'extruder_printable_height',
  'extruder_clearance_dist_to_rod', 'extruder_clearance_max_radius', 'extruder_clearance_height_to_lid',
  'extruder_clearance_height_to_rod', 'nozzle_height', 'master_extruder_id', 'default_print_profile',
  'silent_mode', 'scan_first_layer', 'wrapping_detection_layers', 'wrapping_exclude_area',
  'machine_load_filament_time', 'machine_unload_filament_time', 'machine_pause_gcode',
  'template_custom_gcode', 'machine_hotend_change_time', 'nozzle_type', 'auxiliary_fan', 'fan_direction',
  'nozzle_volume', 'upward_compatible_machine', 'z_hop_types', 'support_chamber_temp_control',
  'support_air_filtration', 'support_cooling_filter', 'cooling_filter_enabled', 'printer_structure',
  'thumbnail_size', 'best_object_pos', 'head_wrap_detect_zone', 'printer_notes', 'print_in_clockwise',
  'enable_long_retraction_when_cut', 'long_retractions_when_cut', 'retraction_distances_when_cut',
  'use_relative_e_distances', 'extruder_type', 'use_firmware_retraction', 'grab_length',
  'machine_switch_extruder_time', 'hotend_cooling_rate', 'hotend_heating_rate', 'enable_pre_heating',
  'support_object_skip_flush', 'physical_extruder_map', 'bed_temperature_formula',
  'machine_prepare_compensation_time', 'nozzle_flush_dataset', 'group_algo_with_time',
  'extruder_max_nozzle_count', 'support_fast_purge_mode',
  // Preset.cpp s_Preset_machine_limits_options.
  'machine_max_acceleration_extruding', 'machine_max_acceleration_retracting', 'machine_max_acceleration_travel',
  'machine_max_acceleration_x', 'machine_max_acceleration_y', 'machine_max_acceleration_z', 'machine_max_acceleration_e',
  'machine_max_speed_x', 'machine_max_speed_y', 'machine_max_speed_z', 'machine_max_speed_e',
  'machine_min_extruding_rate', 'machine_min_travel_rate',
  'machine_max_jerk_x', 'machine_max_jerk_y', 'machine_max_jerk_z', 'machine_max_jerk_e',
  'machine_max_force_Y', 'machine_bed_mass_Y', 'machine_max_printed_mass',
  // PrintConfig.cpp init_extruder_option_keys — the bare extruder-indexed names as they appear in
  // project_settings (the filament-override twins are `filament_*`-prefixed and stay strippable).
  'nozzle_diameter', 'min_layer_height', 'max_layer_height', 'extruder_offset',
  'retraction_length', 'z_hop', 'retraction_speed', 'retract_lift_above', 'retract_lift_below',
  'deretraction_speed', 'retract_before_wipe', 'retract_restart_extra', 'retraction_minimum_travel',
  'wipe', 'wipe_distance', 'retract_when_changing_layer', 'retract_length_toolchange',
  'retract_restart_extra_toolchange', 'extruder_colour', 'default_filament_profile',
  // Runtime-derived machine maps + project-level printer compatibility (not in the BBS preset
  // lists, but extruder-indexed / machine-identity in real project files).
  'extruder_nozzle_stats', 'extruder_ams_count', 'start_end_points', 'print_compatible_printers'
])

/**
 * Replace `project_settings.config`'s filament set with the desired ordered list
 * (Bambu-style add/remove of materials). Position `i` becomes filament `i + 1`.
 *
 * To stay resilient to BambuStudio version differences (project_settings carries many
 * parallel filament-indexed arrays we don't enumerate), EVERY top-level array whose
 * length equals the current filament count — except the machine/extruder-domain keys in
 * {@link MACHINE_DOMAIN_ARRAY_KEYS}, which are extruder-indexed and merely length-collide
 * with the filament count on dual-nozzle machines — is remapped by an index map: a desired slot
 * copies its `sourceIndex` (an existing filament's settings) so new/cloned slots inherit
 * a valid profile, then `filament_colour`/`filament_type` are set from the desired list.
 * The square `flush_volumes_matrix` (count x count) is rebuilt row/column-wise. When the
 * source has no filament arrays (a from-scratch project) only colour/type are written and
 * the slicer fills the rest from the filament profiles supplied at slice time.
 *
 * VARIANT EXPANSION (BambuStudio 2.x). On machines with extruder variants (H2D, and X1C's
 * standard/high-flow pair) the numeric filament settings are `filaments x variants` long —
 * slot i owns the V-wide block at i*V, V read from `filament_extruder_variant`'s length.
 * Those arrays get the same treatment block-wise (remap on reorder, drop on material change),
 * but ONLY for keys positively classified as filament-domain (the filament catalog +
 * `filament_extruder_variant` itself, which always survives by remap — it is the layout's
 * identity column): an N*V length alone would convict per-plate arrays. A filament-catalog
 * array whose length matches NEITHER width is provably stale (a pre-variant-aware save left
 * it behind) and is dropped so the slicer re-derives it — one re-save heals a diseased file.
 *
 * MATERIAL CHANGE (e.g. ABS -> PETG). Cloning `sourceIndex`'s arrays copies the OLD material's
 * per-filament physics (chamber/plate/nozzle temps, flow, cooling, retraction, ...), so a naive
 * remap leaves the project "PETG by name, ABS by temperature". When any slot's material identity
 * (type or `settingsId`) differs from its source slot, we therefore DROP every non-identity
 * filament array — which also removes the `nozzle_temperature` completeness sentinel. The slicer's
 * {@link ensureEmbeddedProjectSettings} / `ensureFilamentCoverage` (apps/slicer) then re-derives
 * the physics from the kept `filament_settings_id` preset names at slice time, so the new material
 * slices with its own temperatures. This heals only NEW saves (the embedded config the slicer
 * reads); already-saved projects keep their stale physics until re-saved. Identity/structure keys
 * ({@link FILAMENT_IDENTITY_KEYS}) are still remapped so the user's colours and nozzle assignment
 * survive; imported projects with no material change are left byte-for-byte (full clone, no drop),
 * preserving any in-desktop-BambuStudio filament tweaks.
 */
export function applyFilamentList(projectSettingsJson: string, filaments: SceneEditFilament[]): string {
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
    // A slot changed material iff its desired type/settingsId differs from the slot it clones from.
    const sourceTypes = Array.isArray(record.filament_type) ? record.filament_type : []
    const sourceSettingsIds = Array.isArray(record.filament_settings_id) ? record.filament_settings_id : []
    const slotMaterialChanged = (i: number): boolean => {
      const src = sourceFor(i)
      const filament = filaments[i]
      return (filament?.settingsId != null && filament.settingsId !== sourceSettingsIds[src])
        || (filament?.type != null && filament.type !== sourceTypes[src])
    }
    const materialChanged = filaments.some((_filament, i) => slotMaterialChanged(i))
    // BambuStudio 2.x VARIANT EXPANSION: on machines with extruder variants (H2D dual-nozzle, and
    // even X1C's standard/high-flow pair) the numeric per-filament settings carry one value per
    // (filament x variant) — `filament_extruder_variant` is that same layout's identity column, so
    // its length over the filament count gives the block width. A remap/drop that only recognizes
    // `length === oldCount` silently skips every such array, which is how a material switch kept
    // the OLD material's physics: identity keys (N-long) renamed the filament to PETG while the
    // N*V-long temperature arrays still said ABS (seen in production as phantom "changed" badges;
    // slices stayed correct only because slice-prep re-derives mapped columns independently).
    const variantColumns = Array.isArray(record.filament_extruder_variant) ? record.filament_extruder_variant.length : 0
    const variantCount = variantColumns > oldCount && variantColumns % oldCount === 0 ? variantColumns / oldCount : 1
    for (const [key, value] of Object.entries(record)) {
      if (!Array.isArray(value)) continue
      // Machine/extruder-domain arrays are indexed by extruder, not filament — on a machine
      // whose extruder count happens to equal the filament count (2 and 2 on a dual-nozzle
      // H2D) the length test below cannot tell them apart, and remapping or dropping them
      // destroys the project's machine topology. Never touch them here.
      if (MACHINE_DOMAIN_ARRAY_KEYS.has(key)) continue
      if (key === 'flush_volumes_matrix') {
        // One `filaments x filaments` block PER EXTRUDER, not a single square — see
        // `expectedFlushVolumesMatrixLength`. Remapping only the first block (which is all a
        // square rebuild produces) leaves a dual-nozzle project a block short, and BambuStudio
        // reads the missing block out of bounds and segfaults mid-slice.
        const extruderCount = Math.max(stringArray(record.nozzle_diameter).length, 1)
        const sourceBlocks = value.length > 0 && value.length % (oldCount * oldCount) === 0
          ? value.length / (oldCount * oldCount)
          : 0
        if (sourceBlocks > 0) {
          const next: unknown[] = []
          for (let extruder = 0; extruder < extruderCount; extruder++) {
            // A retarget that ADDED an extruder has no block for it yet; seed it from the last
            // one the project actually has rather than zero-filling a usable matrix away.
            const base = Math.min(extruder, sourceBlocks - 1) * oldCount * oldCount
            for (let row = 0; row < newCount; row++) {
              for (let col = 0; col < newCount; col++) {
                next.push(value[base + sourceFor(row) * oldCount + sourceFor(col)] ?? '0')
              }
            }
          }
          record[key] = next
        }
        continue
      }
      // Variant-expanded arrays are handled ONLY for keys we can positively classify as
      // filament-domain (the filament catalog, plus the layout's own identity column) — unlike the
      // N-long path below, an N*V length is too weak a signal on its own (a 4-plate project with
      // 2 filaments x 2 variants would convict per-plate arrays like `wipe_tower_x`).
      const isVariantExpanded = variantCount > 1 && value.length === oldCount * variantCount
        && (key === 'filament_extruder_variant' || FILAMENT_SETTING_KEYS.has(key))
      if (isVariantExpanded) {
        // Slot i owns the V-wide block starting at i*V. The layout's identity column
        // (`filament_extruder_variant`) must ALWAYS survive by block-remap — losing it breaks the
        // variant topology every other N*V-long key is decoded against.
        if (key !== 'filament_extruder_variant' && materialChanged) {
          // Same rule as the N-long arrays below: drop the OLD material's physics wholesale; the
          // slicer re-derives every column from the kept `filament_settings_id` at slice time.
          delete record[key]
          continue
        }
        const next: unknown[] = []
        for (let i = 0; i < newCount; i++) {
          const base = sourceFor(i) * variantCount
          for (let variant = 0; variant < variantCount; variant++) next.push(value[base + variant])
        }
        record[key] = next
        continue
      }
      if (value.length !== oldCount) {
        // A filament-catalog array whose length matches NEITHER the filament count NOR its
        // variant-expanded width is provably stale — leftovers from an earlier filament set that a
        // pre-variant-aware save failed to rewrite (production files carry 10 columns beside a
        // 1-entry filament list). No index mapping can read it correctly, so drop it and let the
        // slicer re-derive from `filament_settings_id`; this is what lets one re-save heal an
        // already-diseased file. Keys outside the filament catalog (per-plate arrays like
        // `wipe_tower_x`, unknown domains) are left alone — length alone doesn't convict them.
        if (FILAMENT_SETTING_KEYS.has(key) && !FILAMENT_IDENTITY_KEYS.has(key)) delete record[key]
        continue
      }
      if (materialChanged && !FILAMENT_IDENTITY_KEYS.has(key)) {
        // Drop the OLD material's cloned physics; the slicer re-derives it from the new preset.
        delete record[key]
        continue
      }
      record[key] = Array.from({ length: newCount }, (_unused, i) => value[sourceFor(i)])
    }
    // `different_settings_to_system` is `[process, ...filament slots, machine]` (length oldCount+2),
    // so the generic remap above skips it. Rebuild it by hand: each new slot follows its source
    // slot's record, but a slot whose MATERIAL changed gets a BLANK record — its in-project changes
    // belonged to the old material, and the material dialog treats this record as the authoritative
    // "changed within this 3MF" signal, so a stale entry would flag keys the new material never
    // touched.
    const differentSettings = record.different_settings_to_system
    if (Array.isArray(differentSettings) && differentSettings.length === oldCount + 2) {
      record.different_settings_to_system = [
        differentSettings[0],
        ...Array.from({ length: newCount }, (_unused, i) => (slotMaterialChanged(i) ? '' : differentSettings[sourceFor(i) + 1])),
        differentSettings[oldCount + 1]
      ]
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
  // Gap filler for slots this edit does not assign. A hole in `filament_nozzle_map` is NOT
  // survivable on a multi-extruder machine: BambuStudio reads the empty entry as an extruder
  // index and lands on garbage, failing the slice with "filament <name> can not be printed on
  // extruder 23075, under manual mode for multi extruder printer" (seen in production). So an
  // unassigned slot inherits its existing mapping, else the first assigned slot's nozzle.
  const fallbackNozzleId = filaments.find((filament) => filament.nozzleId != null)?.nozzleId ?? 0
  const nozzleMapEntry = (index: number): string => {
    const existing = nozzleMap[index]
    return existing != null && existing.trim() !== '' ? existing : String(fallbackNozzleId)
  }
  const extruderUsage = new Array<number>(physicalExtruderMap.length).fill(0)
  filaments.forEach((filament, index) => {
    if (filament.nozzleId == null) {
      while (nozzleMap.length <= index) nozzleMap.push(nozzleMapEntry(nozzleMap.length))
      nozzleMap[index] = nozzleMapEntry(index)
      return
    }
    while (nozzleMap.length <= index) nozzleMap.push(nozzleMapEntry(nozzleMap.length))
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
/**
 * Map each `SceneEdit.repairedObjectIds` root object to the entry + mesh-carrying object ids that
 * actually hold its geometry: `entryPath -> {mesh objectId}`. Mirrors {@link resolvePartPaintByEntry}
 * — a Bambu project keeps each object's mesh in its own `3D/Objects/*.model`, so the id the editor
 * marked is a root that references the real mesh objects through `<components>`. An object with an
 * inline mesh (no components — e.g. a from-scratch scaffold) carries its own id in the root entry.
 */
export function resolveRepairMeshesByEntry(baseModelXml: string, repairedObjectIds: readonly number[]): Map<string, Set<number>> {
  const byEntry = new Map<string, Set<number>>()
  const componentsByObjectId = parseRootModelComponents(baseModelXml)
  const add = (entryPath: string, objectId: number) => {
    const ids = byEntry.get(entryPath) ?? new Set<number>()
    ids.add(objectId)
    byEntry.set(entryPath, ids)
  }
  for (const objectId of repairedObjectIds) {
    const components = componentsByObjectId.get(objectId) ?? []
    if (components.length === 0) {
      add('3D/3dmodel.model', objectId)
      continue
    }
    for (const component of components) add(component.entryPath, component.objectId)
  }
  return byEntry
}

export function resolvePartPaintByEntry(
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
 * The ordered `project_settings.config` rewrites a SceneEdit calls for: the filament set
 * (add/remove materials) and per-slot dual-nozzle assignment, the plate type, and per-plate
 * prime-tower corners. Empty when the edit touches none of them.
 */
export function buildProjectSettingsTransforms(edit: SceneEdit): Array<(json: string) => string> {
  const transforms: Array<(json: string) => string> = []
  if (edit.filaments && edit.filaments.length > 0) {
    const filaments = edit.filaments
    transforms.push((json) => applyFilamentList(json, filaments))
    transforms.push((json) => applyNozzleAssignmentToProjectSettings(json, filaments))
  }
  const plateType = edit.plates.find((plate) => plate.plateType)?.plateType
  if (plateType) {
    transforms.push((json) => applyProjectPlateType(json, plateType))
  }
  if (edit.plates.some((plate) => plate.primeTower)) {
    transforms.push((json) => applyPrimeTowerSettings(json, edit))
  }
  return transforms
}

/**
 * Persist the editor's chosen plate type as the project-global `curr_bed_type` (normalized to
 * BambuStudio's serialized enum value). Without this, a plate-type change in the editor only
 * lives in the UI: the source's `curr_bed_type` is copied verbatim and wins on reopen.
 */
/**
 * Merges global process-setting overrides into `project_settings.config`, writing each value
 * verbatim (BambuStudio serialized string / string array). Inverse of the resolve-process read
 * and identical to the slicer's `applyProcessSettingOverrides`, so a saved override reopens as
 * the project's baseline (the editor then shows no pending override). No-op on unparseable JSON.
 */
/**
 * Stamp `project_settings.config` as a single-object model export. Reader counterpart:
 * the shared index parser's `PRINTSTREAM_MODEL_KIND_KEY` extraction (see its doc for the
 * BambuStudio unknown-key tolerance rationale).
 */
export function applyModelKindMarker(projectSettingsJson: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return projectSettingsJson
  }
  if (!parsed || typeof parsed !== 'object') return projectSettingsJson
  const record = parsed as Record<string, unknown>
  record[PRINTSTREAM_MODEL_KIND_KEY] = PRINTSTREAM_MODEL_KIND_OBJECT_EXPORT
  return JSON.stringify(record)
}

export function applyGlobalProcessOverrides(projectSettingsJson: string, overrides: Record<string, string | string[]>): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return projectSettingsJson
  }
  if (!parsed || typeof parsed !== 'object') return projectSettingsJson
  const record = parsed as Record<string, unknown>
  for (const [key, value] of Object.entries(overrides)) record[key] = value
  return JSON.stringify(record)
}

function applyProjectPlateType(projectSettingsJson: string, plateType: string): string {
  const canonical = canonicalCurrBedType(plateType)
  if (!canonical) return projectSettingsJson
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return projectSettingsJson
  }
  if (!parsed || typeof parsed !== 'object') return projectSettingsJson
  const record = parsed as Record<string, unknown>
  record.curr_bed_type = canonical
  return JSON.stringify(record)
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
