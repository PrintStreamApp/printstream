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
import { serializeTextInfo, type TextInfo } from './text-info.js'
import { FILAMENT_SETTING_KEYS } from '../filament-settings.js'
import { FILAMENT_INDEX_PROCESS_KEYS, isProcessSettingKey, type ProcessConfig } from '../process-settings.js'
import { rebindProjectFilamentPhysics } from '../filament-rebind.js'
import { isFilamentVariantOption } from '../variant-options.js'
import { inspectProjectFilamentPhysics } from '../repairs/filament-physics.js'
import { applyFilamentPresetBindings } from '../filament-preset-binding.js'
import { restoreFilamentPhysics } from '../repairs/restore-filament-physics.js'
import { repairModelSettingsObjectExtruders, setObjectLevelExtruderMetadata, sharedCarryingPartExtruderOfBlock } from '../repairs/object-extruder.js'
import { inspectProjectFilamentIds, repairFilamentIds } from '../repairs/filament-ids.js'
import { inspectProjectInheritsGroup, repairInheritsGroup } from '../repairs/inherits-group.js'
import { resizeParallelPresetRecord } from '../three-mf-project-config.js'
import {
  defaultFlushMultiplierFor,
  flushMultiplierKeyForPrimeVolumeMode,
  inspectProjectFlushVolumesMatrix,
  repairFlushMultiplier,
  repairFlushVolumesMatrix,
  writeFlushVolumesMatrixBlocks
} from '../flush-volumes-matrix.js'
import { inspectProjectFilamentSelfIndex, rebuildFilamentSelfIndex, repairFilamentSelfIndex } from '../filament-variant-index.js'
import { assertAcyclicComponentGraph } from './component-graph.js'
import { ensureApplicationMarker } from './application-marker.js'
import { parseSourcePlateMetadata, preservedPlateMetadata, type PlateMetadataEntry } from './plate-metadata.js'
import { dropEngineHostileOverrides } from '../settings-value-guard.js'
import { degenerateTransformMessage, findDegenerateTransformColumn } from './transform-validity.js'
import { remapColorPaintInModelXml } from './triangle-paint-codec.js'
import { canonicalThreeMfPartSubtype, threeMfPartSubtypeCarriesFilament } from '../three-mf-part-subtype.js'
import type {
  SceneEdit,
  SceneEditFilament,
  SceneEditFlushVolumes,
  SceneEditObjectBrimEars,
  SceneEditPartFilament,
  SceneEditPartPaint,
  SceneEditPartProcessOverride,
  SceneEditPartTransform,
  SceneEditRemovedPart,
  SceneEditPartOrder,
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
 * match the grid pushes later plates outside the print volume (slicer exit 206): the previous
 * single-row layout did exactly that for the 3rd+ plate. The scene reader removes this same offset
 * (see {@link resolveProjectPlateOrigin}) to give the editor plate-local coordinates.
 */
function computePlateOrigins(
  plates: SceneEdit['plates'],
  plateWidth: number,
  plateDepth: number
): Map<number, { x: number; y: number }> {
  // BambuStudio indexes `plate_data_list` by `plater_id - 1` and refuses the whole project when any
  // id exceeds the plate COUNT (`bbs_3mf.cpp:2323-2329`, and the same guard again at `:1633-1639`
  // for a printer-stored `.gcode.3mf`). Sorting alone does not make `[1, 3]` safe. Refused rather
  // than renumbered: the editor already reindexes every plate mutation to 1..N, so a sparse set is a
  // caller that disagrees with us about which plate is which, and silently moving its plate 3 to
  // position 2 would attach that plate's thumbnails and gcode pointers to different work.
  assertDensePlateIndexes(plates)
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
    // Held to the same rule whichever form it arrived in. A zero scale axis makes the importer
    // return before `set_transformation` (`bbs_3mf.cpp:4299-4307`), so the object loses its position
    // and rotation too and reappears unrotated at the plate origin, with no error anywhere.
    const degenerate = findDegenerateTransformColumn(local)
    if (degenerate) {
      throw new Error(`Scene edit places object ${instance.objectId} with a degenerate transform: ${degenerateTransformMessage(degenerate).toLowerCase()}`)
    }
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

/**
 * Instances grouped by object, objects in first-appearance order, each object's instances by
 * instance id.
 *
 * THE ORDER OF THE OBJECTS HERE IS THE ORDER BAMBUSTUDIO DISPLAYS. Its importer creates one
 * `ModelObject` the first time a build `<item>` names an id and only adds instances afterwards
 * (`bbs_3mf.cpp` `_create_object_instance`), and its object list, its plate tree and every
 * position-keyed sidecar walk that same vector. So this is how the editor's sidebar order becomes
 * portable: `arranged` follows `SceneEdit.instances`, which is the sidebar.
 *
 * Grouping is also what `parseRootBuildItemTransforms` relies on to index items back to instances,
 * and it is applied to `<model_instance>` through the SAME function so the two documents cannot
 * drift into disagreeing about which object comes first.
 */
function groupArrangedByObject(arranged: readonly ArrangedInstance[]): ArrangedInstance[] {
  const byObject = new Map<number, ArrangedInstance[]>()
  for (const instance of arranged) {
    const list = byObject.get(instance.objectId) ?? []
    list.push(instance)
    byObject.set(instance.objectId, list)
  }
  // Sorted in place: the arrays are this function's own, and nothing else holds a reference.
  return [...byObject.values()].flatMap((list) => list.sort((left, right) => left.instanceId - right.instanceId))
}

function renderArrangedBuildItems(arranged: ArrangedInstance[], genUuid: (() => string) | null): string {
  const lines: string[] = []
  for (const instance of groupArrangedByObject(arranged)) {
    const transform = instance.transform.map(formatThreeMfTransformValue).join(' ')
    // BambuStudio's per-object "Printable" toggle: a skipped instance is kept in the 3MF
    // (re-enableable) but marked printable="0", which greys it and excludes it from the slice.
    const printable = instance.printable === false ? '0' : '1'
    lines.push(`    <item objectid="${instance.objectId}"${productionUuidAttr(genUuid)} transform="${transform}" printable="${printable}"/>`)
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
 * BambuStudio's per-instance handle (`loaded_id` in the engine), the ONLY key the CLI's
 * `--skip-objects` flag accepts, so the bake must carry it through (or mint one) for the
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
  sourceIdentifyIds: ModelSettingsIdentifyIds,
  sourcePlates: ReadonlyMap<number, PlateMetadataEntry[]>,
  filamentSetStable: boolean
): string {
  const instancesByPlate = new Map<number, ArrangedInstance[]>()
  // Grouped by object through the SAME function the build items use. BambuStudio ignores this
  // order (it reads `<model_instance>` into a map keyed by object id, and writes its own from a
  // `std::set<std::pair<int,int>>`, which is sorted by object) but OUR scene parser seeds the
  // editor's sidebar from it, so writing it ungrouped is how a saved project reopened with an
  // object's copies split around another object, disagreeing with both the build items and
  // BambuStudio about which object comes first.
  for (const instance of groupArrangedByObject(arranged)) {
    const list = instancesByPlate.get(instance.plateIndex) ?? []
    list.push(instance)
    instancesByPlate.set(instance.plateIndex, list)
  }
  // Every instance carries an identify_id: a returning (objectId, instanceId) keeps the
  // source's, new/duplicated instances get fresh ids above the source's maximum. Without
  // one the CLI assigns its own loaded_id at load time, which the slicer service cannot
  // predict, making printable="0" instances impossible to translate into --skip-objects.
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
    // Everything the SceneEdit cannot express, carried from the source block. Without this the
    // re-render below silently discarded the plate's bed type, print sequence, vase mode and
    // nozzle grouping on every save (`plate-metadata.ts` has the policy and the reasoning).
    // `rawValue` is re-emitted unescaped because it is still the source's escaped text.
    // Keyed on the plate's SOURCE number, never its new one. `plate.index` is a position the
    // editor renumbers on every add, delete and reorder, so looking the source block up by it hands
    // a deleted plate's bed type and vase mode to whichever plate took its number, which is the
    // exact misattribution this carry exists to prevent. Falls back to the position only when the
    // edit does not say, which is an older client whose plates cannot have moved through it.
    const sourcePlateNumber = plate.sourceIndex ?? plate.index
    for (const carried of preservedPlateMetadata(sourcePlates.get(sourcePlateNumber), filamentSetStable)) {
      lines.push(`    <metadata key="${carried.key}" value="${carried.rawValue}"/>`)
    }
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
   * in `mesh.indices`, the SAME order the editor rendered through `meshToBinaryStl`, which is
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
 * object. `extruder` records the placing instance's filament at BOTH levels, exactly as
 * desktop BambuStudio writes it: the OBJECT-level entry is what the CLI slices by (a
 * part-level entry alone is ignored for an inline-mesh object, which silently printed the
 * object with filament 1, A/B-verified on a real project), and the part-level entry is
 * what keeps the part's material on reopen/preview.
 */
function renderImportedModelSettingsObjectXml(objectId: number, name: string, extruder: number | null): string {
  return [
    `  <object id="${objectId}">`,
    `    <metadata key="name" value="${escapeXmlAttribute(name)}"/>`,
    ...(extruder != null ? [`    <metadata key="extruder" value="${extruder}"/>`] : []),
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
 * places, so the whole assembly moves/clones as one, exactly how BambuStudio loads a multi-part
 * STEP. (3MF requires an object be mesh XOR components; the solids carry the meshes.)
 *
 * When `partPath` is set the solids live in a separate `/3D/Objects/…model` sub-model (the
 * Production-Extension "split" layout BambuStudio writes); each component then carries `p:path` so
 * the reader resolves the solid in that part file. When null the solids are inline in the root model
 * (same-file lookup): the fallback for non-production projects.
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
 * for the single-mesh case, including the OBJECT-level `extruder`: the entry the CLI slices by;
 * the per-part entries alone are not honored.
 */
export function renderImportedMultiPartModelSettingsXml(
  objectId: number,
  name: string,
  objectExtruder: number | null,
  parts: Array<{ componentObjectId: number; name: string; extruder: number | null; processOverrides?: Record<string, string | string[]>; subtype?: string }>
): string {
  return [
    `  <object id="${objectId}">`,
    `    <metadata key="name" value="${escapeXmlAttribute(name)}"/>`,
    ...(objectExtruder != null ? [`    <metadata key="extruder" value="${objectExtruder}"/>`] : []),
    ...parts.flatMap((part) => [
      // Canonicalised, never written raw. `ModelVolume::type_from_string` is an exact match on five
      // strings and DEFAULTS TO MODEL_PART for anything else (`Model.cpp:3400-3416`), so a stray
      // `ParameterModifier` does not fail, it prints the modifier as solid geometry. Nothing
      // observed produces a non-canonical value today; this is the rule `three-mf-part-subtype.ts`
      // already states, applied at the one place that writes the attribute.
      `    <part id="${part.componentObjectId}" subtype="${escapeXmlAttribute(canonicalThreeMfPartSubtype(part.subtype))}">`,
      `      <metadata key="name" value="${escapeXmlAttribute(part.name)}"/>`,
      ...(part.extruder != null ? [`      <metadata key="extruder" value="${part.extruder}"/>`] : []),
      // Per-part process overrides set on the unsaved import, baked into the part's metadata
      // (process-setting keys only: structural keys must not be forgeable through this map).
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
 * a default instance), so an orphaned original would silently reappear in the slice: landing
 * on top of the kept geometry and failing the plate. Objects referenced as a component of
 * another object (same-file assemblies in generic 3MFs) are conservatively kept; Bambu part
 * objects live in separate /3D/Objects files, so cut-away root objects never match that.
 */
/**
 * Refuse to place an object the model does not contain.
 *
 * Throws rather than dropping the instance: a placement naming a missing object means the caller and
 * the base project disagree about what exists (a stale editor session against a concurrently-saved
 * file is the realistic route), and silently saving the subset would persist that disagreement as
 * deleted models. Named ids are listed so the failure says which.
 */
function assertPlacedObjectsExist(modelXml: string, arranged: ReadonlyArray<{ objectId: number }>): void {
  const present = new Set<number>()
  for (const match of modelXml.matchAll(/<object\b[^>]*?\bid="(\d+)"/g)) {
    present.add(Number.parseInt(match[1]!, 10))
  }
  const missing = [...new Set(arranged.map((instance) => instance.objectId))].filter((id) => !present.has(id))
  if (missing.length > 0) {
    throw new Error(`Scene edit places object${missing.length > 1 ? 's' : ''} ${missing.join(', ')}, which this project does not contain`)
  }
}

/** Plate ids must be exactly 1..N, or BambuStudio refuses the project outright. */
function assertDensePlateIndexes(plates: ReadonlyArray<{ index: number }>): void {
  const seen = [...plates].map((plate) => plate.index).sort((left, right) => left - right)
  const dense = seen.every((index, position) => index === position + 1)
  if (!dense) {
    throw new Error(`Scene edit numbers its plates ${seen.join(', ')}; plates must be numbered 1 to ${seen.length} with no gaps`)
  }
}

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
  const importRemovedParts = new Map<string, Set<number>>()
  for (const entry of edit.importRemovedParts ?? []) {
    let byPart = importRemovedParts.get(entry.importId)
    if (!byPart) { byPart = new Set(); importRemovedParts.set(entry.importId, byPart) }
    byPart.add(entry.partIndex)
  }
  const importPartOrder = new Map<string, readonly number[]>()
  for (const entry of edit.importPartOrder ?? []) importPartOrder.set(entry.importId, entry.order)
  const toExtruder = (filamentId: number | null): number | null =>
    filamentId != null ? filamentToExtruder.get(filamentId) ?? filamentId : null
  for (const imported of imports) {
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
      const solidMeshXmls = multiParts.map((entry, i) => renderImportedMeshObjectXml(componentIds[i]!, entry.part.mesh, genUuid, solidPaint?.get(entry.sourceIndex)))
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
      )
    )
  )

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

  // Every placed object must EXIST before the sweep below runs, because the sweep is seeded from the
  // build items: an id naming nothing keeps the whole model from being referenced, so the real
  // objects are stripped as unused and the file is left with one item pointing at nothing. That is
  // silent geometry loss on our side and a refused open on BambuStudio's (`bbs_3mf.cpp:4205-4210`
  // aborts the parse rather than skipping the item). Checked here rather than at the schema, which
  // is context-free and cannot know which ids the base project holds.
  assertPlacedObjectsExist(modelXml, arranged)

  const cleaned = removeUnreferencedObjects(modelXml, modelSettingsXml, new Set(arranged.map((instance) => instance.objectId)))
  // The components are only complete once the imports, clones and added parts are all in. A cycle
  // among them hangs the importer outright rather than failing, so it must never reach a file.
  assertAcyclicComponentGraph(cleaned.modelXml)
  // We author Bambu-shaped documents whatever the base was, so the file has to SAY so: without the
  // generator marker the importer forces `dont_load_config` and skips the whole config half of the
  // archive (`bbs_3mf.cpp:1905-1908`), opening the project as bare geometry with every setting gone.
  // Only the from-scratch scaffold used to write it, so a save over any base that lacked one
  // inherited the defect and could never recover from it.
  cleaned.modelXml = ensureApplicationMarker(cleaned.modelXml)
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

  return { modelXml, modelSettingsXml, importIdToObjectId, partFileEntries, clonedObjectIds: cloned.resolvedIds, volumeLayouts }
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
/**
 * Exported for `bake-documents.addedParts.test.ts`: the `<part>` rewrites here are regex work over
 * XML whose exact shape varies between writers, which is a unit test's job rather than a full
 * archive round trip's.
 */
export function applyAddedParts(
  modelXml: string,
  modelSettingsXml: string,
  addedParts: NonNullable<SceneEdit['addedParts']>,
  importIdToObjectId: ReadonlyMap<string, number>,
  allocateObjectId: () => number,
  genUuid: (() => string) | null,
  filamentToExtruder: ReadonlyMap<number, number>,
  /**
   * Hosts that keep NO geometry of their own: their added parts ARE the object.
   *
   * Resolved to baked object ids by the caller, because an entry may name an import that only gets
   * an id here. See {@link sceneEditRemovedObjectBodySchema} for why this cannot be a removal.
   */
  removedBodies: ReadonlySet<number> = new Set()
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
      // The object's OWN geometry becomes component 0 -- UNLESS the user deleted it, in which case
      // it is simply never referenced and the added parts are the whole component list. Dropping it
      // here rather than removing it afterwards is what lets the surviving parts keep their own
      // names: a promoted body is named after the OBJECT, so a delete that went through a promotion
      // renamed the survivor and made the same edit read differently before and after a save.
      const keepsBody = !removedBodies.has(hostObjectId)
      const nextBody = body.replace(/<mesh\b[\s\S]*?<\/mesh>/, [
        '<components>',
        ...(keepsBody
          ? [`    <component objectid="${meshObjectId}"${productionUuidAttr(genUuid)} transform="${IDENTITY_THREE_MF_TRANSFORM}"/>`]
          : []),
        componentXml,
        '   </components>'
      ].join('\n'))
      modelXml = modelXml.replace(parentPattern, (_match, open: string, _body: string, close: string) => `${open}${nextBody}${close}`)
      // The moved mesh is only worth keeping as an object while something references it; the
      // unreferenced-object sweep would take it anyway, but not writing it keeps the file honest.
      if (keepsBody) modelXml = injectResourcesObjects(modelXml, meshObjectXml)
      // The parent's existing settings <part> keyed by the parent id now describes the
      // moved mesh component -- or, where the body is gone, describes nothing and is dropped, so
      // the object's part list is exactly its added parts.
      modelSettingsXml = keepsBody
        ? modelSettingsXml.replace(
          new RegExp(`(<object\\b[^>]*\\bid="${hostObjectId}"[^>]*>[\\s\\S]*?)<part id="${hostObjectId}"`),
          `$1<part id="${meshObjectId}"`
        )
        // A `<part>` may be SELF-CLOSING: nothing in the format forbids `<part id="1" .../>`, and
        // only our own writers always emit a closing tag. Matching `...>[\s\S]*?</part>` on one
        // then ran past it to the NEXT part's closing tag and deleted that part's name, extruder
        // and settings with it. The alternation takes the self-closing form first, so the greedy
        // form is only reached for an entry that genuinely has a body.
        : modelSettingsXml.replace(
          new RegExp(`(<object\\b[^>]*\\bid="${hostObjectId}"[^>]*>[\\s\\S]*?)`
            + `<part id="${hostObjectId}"(?:[^>]*\\/>|[^>]*>[\\s\\S]*?<\\/part>)\\s*`),
          '$1'
        )
    } else {
      throw new Error(`Object ${hostObjectId} has neither mesh nor components`)
    }
    // Only a filament-carrying subtype gets an extruder; see threeMfPartSubtypeCarriesFilament.
    const extruder = part.filamentId != null && threeMfPartSubtypeCarriesFilament(part.subtype)
      ? filamentToExtruder.get(part.filamentId) ?? part.filamentId
      : undefined
    modelSettingsXml = addModelSettingsPartEntry(
      modelSettingsXml, hostObjectId, partObjectId, part.subtype, part.name, part.settings, extruder,
      part.textInfo
    )
  }
  return { modelXml, modelSettingsXml }
}

/**
 * Append a `<part>` (with subtype + name, plus any per-volume config metadata: how
 * BambuStudio persists modifier-volume overrides) to a parent's model_settings entry.
 */
function addModelSettingsPartEntry(
  modelSettingsXml: string,
  parentObjectId: number,
  partObjectId: number,
  subtype: string,
  name: string,
  settings?: Record<string, string>,
  extruder?: number,
  textInfo?: TextInfo
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
    // A text part records what it was typed from, so a typo is a re-edit rather than a rebuild.
    // BambuStudio keeps this inside the <part> and keys it to the volume, which is why it is
    // authored here rather than alongside the object's own metadata.
    ...(textInfo ? [`      ${serializeTextInfo(textInfo)}`] : []),
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
    parts.set(override.partIndex, extruder)
  }
  return modelSettingsXml.replace(/<object\b([^>]*)>[\s\S]*?<\/object>/g, (objectBlock, attrs: string) => {
    const objectId = Number.parseInt(parseAttrs(attrs).id ?? '', 10)
    const parts = extruderByObjectPart.get(objectId)
    if (!parts) return objectBlock
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
export function applyPartProcessOverrides(modelSettingsXml: string, overrides: SceneEditPartProcessOverride[]): string {
  const byObjectPart = new Map<number, Map<number, Record<string, string | string[]>>>()
  for (const override of overrides) {
    let parts = byObjectPart.get(override.objectId)
    if (!parts) { parts = new Map(); byObjectPart.set(override.objectId, parts) }
    parts.set(override.partIndex, override.overrides)
  }
  return modelSettingsXml.replace(/<object\b([^>]*)>[\s\S]*?<\/object>/g, (objectBlock, attrs: string) => {
    const objectId = Number.parseInt(parseAttrs(attrs).id ?? '', 10)
    const parts = byObjectPart.get(objectId)
    if (!parts) return objectBlock
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

export function applyPartTypeChanges(modelSettingsXml: string, changes: SceneEditPartTypeChange[]): string {
  const byObjectPart = new Map<number, Map<number, string>>()
  for (const change of changes) {
    let parts = byObjectPart.get(change.objectId)
    if (!parts) { parts = new Map(); byObjectPart.set(change.objectId, parts) }
    parts.set(change.partIndex, change.subtype)
  }
  return modelSettingsXml.replace(/<object\b([^>]*)>[\s\S]*?<\/object>/g, (objectBlock, attrs: string) => {
    const objectId = Number.parseInt(parseAttrs(attrs).id ?? '', 10)
    const parts = byObjectPart.get(objectId)
    if (!parts) return objectBlock
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
  const nextModelSettingsXml = modelSettingsXml.replace(/<object\b([^>]*)>[\s\S]*?<\/object>/g, (objectBlock, attrs: string) => {
    const objectId = Number.parseInt(parseAttrs(attrs).id ?? '', 10)
    const parts = byObjectPart.get(objectId)
    if (!parts) return objectBlock
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
 * from the source slot) while every other filament-indexed array is dropped: see
 * {@link applyFilamentList}. `filament_settings_id` must stay: it names the new preset the slicer
 * re-derives physics from; `filament_nozzle_map` is a project-level assignment no filament preset
 * would restore.
 */
const FILAMENT_IDENTITY_KEYS = new Set([
  'filament_colour',
  'filament_type',
  'filament_settings_id',
  'filament_ids',
  'filament_nozzle_map',
  // Says WHAT the material is, not how it prints, so it belongs here rather than with the physics.
  // It is also the only remaining record that a slot is a support material now that `filament_type`
  // stores the RAW type: the engine derives the `PLA-S` the user sees from this flag plus
  // `filament_type` (`PrintConfig.cpp:7569-7638`). Dropping it turned a support slot into an
  // ordinary PLA in the saved file, where the old derived spelling had at least still said so.
  'filament_is_support',
  // Not identity, but it may never be dropped either: `PresetBundle.cpp` reads
  // `config.option<ConfigOptionFloats>("filament_diameter")->values.size()` with NO null check, so
  // an absent key is a null dereference and BambuStudio dies opening the project instead of
  // reporting anything. An absent key and an empty one are not the same thing, and a key the engine
  // assumes into existence is not optional.
  'filament_diameter'
])

/**
 * Machine-domain arrays that live in `project_settings.config` but are indexed by EXTRUDER (or
 * are machine-level lists), NOT by filament. {@link applyFilamentList} identifies filament-indexed
 * arrays by length, and on a dual-nozzle machine with exactly two filaments every one of these
 * length-2 arrays is indistinguishable from a filament array by length alone: the remap would
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
 * machine key from a future BambuStudio would still be misclassified: the slicer-side same-model
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
  // PrintConfig.cpp init_extruder_option_keys: the bare extruder-indexed names as they appear in
  // project_settings (the filament-override twins are `filament_*`-prefixed and stay strippable).
  'nozzle_diameter', 'min_layer_height', 'max_layer_height', 'extruder_offset',
  'retraction_length', 'z_hop', 'retraction_speed', 'retract_lift_above', 'retract_lift_below',
  'deretraction_speed', 'retract_before_wipe', 'retract_restart_extra', 'retraction_minimum_travel',
  'wipe', 'wipe_distance', 'retract_when_changing_layer', 'retract_length_toolchange',
  'retract_restart_extra_toolchange', 'extruder_colour', 'default_filament_profile',
  // Runtime-derived machine maps + project-level printer compatibility (not in the BBS preset
  // lists, but extruder-indexed / machine-identity in real project files).
  'extruder_nozzle_stats', 'extruder_ams_count', 'start_end_points', 'print_compatible_printers',
  // Per-EXTRUDER flush sizing + nozzle volume types (project keys, not preset keys: see
  // flush-volumes-matrix.ts). On a dual-nozzle machine with two filaments these length-2 arrays
  // are indistinguishable from filament arrays by length, and remapping them swaps or resizes the
  // per-extruder entries: a filament add stretched `flush_multiplier` past the extruder count,
  // which is the exact shape BambuStudio's g-code-time size check rejects (exit 156).
  'flush_multiplier', 'flush_multiplier_fast', 'nozzle_volume_type'
])

/**
 * Replace `project_settings.config`'s filament set with the desired ordered list
 * (Bambu-style add/remove of materials). Position `i` becomes filament `i + 1`.
 *
 * To stay resilient to BambuStudio version differences (project_settings carries many
 * parallel filament-indexed arrays we don't enumerate), EVERY top-level array whose
 * length equals the current filament count: except the machine/extruder-domain keys in
 * {@link MACHINE_DOMAIN_ARRAY_KEYS}, which are extruder-indexed and merely length-collide
 * with the filament count on dual-nozzle machines: is remapped by an index map: a desired slot
 * copies its `sourceIndex` (an existing filament's settings) so new/cloned slots inherit
 * a valid profile, then `filament_colour`/`filament_type` are set from the desired list.
 * The square `flush_volumes_matrix` (count x count) is rebuilt row/column-wise. When the
 * source has no filament arrays (a from-scratch project) only colour/type are written and
 * the slicer fills the rest from the filament profiles supplied at slice time.
 *
 * VARIANT EXPANSION (BambuStudio 2.x). On machines with extruder variants (H2D, and X1C's
 * standard/high-flow pair) the numeric filament settings are `filaments x variants` long:
 * slot i owns the V-wide block at i*V, V read from `filament_extruder_variant`'s length.
 * Those arrays get the same treatment block-wise (remap on reorder, drop on material change),
 * but ONLY for keys positively classified as filament-domain (the filament catalog +
 * `filament_extruder_variant` itself, which always survives by remap, it is the layout's
 * identity column): an N*V length alone would convict per-plate arrays. A filament-catalog
 * array whose length matches NEITHER width is provably stale (a pre-variant-aware save left
 * it behind) and is dropped so the slicer re-derives it, one re-save heals a diseased file.
 *
 * MATERIAL CHANGE (e.g. ABS -> PETG). Cloning `sourceIndex`'s arrays copies the OLD material's
 * per-filament physics (chamber/plate/nozzle temps, flow, cooling, retraction, ...), so a naive
 * remap leaves the project "PETG by name, ABS by temperature". When any slot's material identity
 * (type or `settingsId`) differs from its source slot, we therefore DROP every non-identity
 * filament array, which also removes the `nozzle_temperature` completeness sentinel. The slicer's
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
  /**
   * Whether slot `i` switched material, published out of the remap block below so the
   * `filament_ids` authoring at the end can tell "kept its material" (keep the id) from "changed
   * material with no resolvable id" (report unknown). Null when there was no base list to compare
   * against, in which case nothing was carried over and no slot counts as changed.
   */
  let materialChangedBySlot: ((index: number) => boolean) | null = null

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
    materialChangedBySlot = slotMaterialChanged
    // When the caller resolved the new presets, the old material's physics is REPLACED rather than
    // dropped: see `authorFilamentPhysics` below. The drop stays for a caller that could not
    // resolve them, so nothing regresses.
    const authoringPhysics = materialChanged && filaments.some((filament) => filament.config != null)
    // BambuStudio 2.x VARIANT EXPANSION: on machines with extruder variants (H2D dual-nozzle, and
    // even X1C's standard/high-flow pair) the numeric per-filament settings carry one value per
    // (filament x variant): `filament_extruder_variant` is that same layout's identity column, so
    // its length over the filament count gives the block width. A remap/drop that only recognizes
    // `length === oldCount` silently skips every such array, which is how a material switch kept
    // the OLD material's physics: identity keys (N-long) renamed the filament to PETG while the
    // N*V-long temperature arrays still said ABS (seen in production as phantom "changed" badges;
    // slices stayed correct only because slice-prep re-derives mapped columns independently).
    const variantColumns = Array.isArray(record.filament_extruder_variant) ? record.filament_extruder_variant.length : 0
    const variantCount = variantColumns > oldCount && variantColumns % oldCount === 0 ? variantColumns / oldCount : 1
    for (const [key, value] of Object.entries(record)) {
      if (!Array.isArray(value)) continue
      // Machine/extruder-domain arrays are indexed by extruder, not filament, on a machine
      // whose extruder count happens to equal the filament count (2 and 2 on a dual-nozzle
      // H2D) the length test below cannot tell them apart, and remapping or dropping them
      // destroys the project's machine topology. Never touch them here.
      if (MACHINE_DOMAIN_ARRAY_KEYS.has(key)) continue
      // The custom layer print sequences hold filament ids as VALUES (an ordered "print these
      // slots in this order" list, plus layer-range bounds), not one entry per slot: when a
      // sequence's length happens to equal the filament count, the positional remap below would
      // scramble it. They are re-keyed value-wise at the end of this function instead.
      if (key === 'first_layer_print_sequence' || key === 'other_layers_print_sequence') continue
      if (key === 'flush_volumes_matrix') {
        // One `filaments x filaments` block PER EXTRUDER, not a single square: see
        // `expectedFlushVolumesMatrixLength`. Remapping only the first block (which is all a
        // square rebuild produces) leaves a dual-nozzle project a block short, and BambuStudio
        // reads the missing block out of bounds and segfaults mid-slice.
        const extruderCount = Math.max(stringArray(record.nozzle_diameter).length, 1)
        const sourceBlocks = value.length > 0 && value.length % (oldCount * oldCount) === 0
          ? value.length / (oldCount * oldCount)
          : 0
        if (sourceBlocks > 0) {
          // A pair involving a filament the project did not have is SEEDED, never cloned from the
          // slot the new one was added beside. BambuStudio seeds it from `flush_volumes_vector`
          // (`update_multi_material_filament_presets`: `i == j ? 0 : filaments[2i] + filaments[2j+1]`,
          // 140 + 140 = 280 by default) and writes 0 only on the diagonal.
          //
          // Cloning read the SOURCE slot's own diagonal for the new pair, which is hard zero, so
          // adding a material left the print purging NOTHING between it and the slot it was added
          // beside: the new colour prints contaminated until it clears itself. Worst on a
          // single-filament project, whose stored matrix is just `["0"]` and whose every cloned
          // cell was therefore zero. Nothing detected any of it, because the guard here is a length
          // test and the matrix came out the right length.
          const flushVector = stringArray(record.flush_volumes_vector)
          // ALWAYS strings, never the source's cell type. `parse_str_arr` accepts only array and
          // string elements and returns false on anything else (`Config.cpp:836-860`), so a JSON
          // NUMBER is fatal whether or not the array is mixed: the loader logs, `break`s out of the
          // key loop (`:996-1000`) and then returns success (`:1123`), silently dropping every key
          // ordered after this one. This used to match the source's type, which preserved a numeric
          // matrix faithfully into a file the engine cannot read. Strings are also what BambuStudio
          // itself emits for every vector option (`Config.cpp:1512-1523` serialises through a
          // `vector<string>`), so this is matching the engine rather than choosing a format.
          const cell = (amount: number): string => String(amount)
          const seedFor = (row: number, col: number): string => {
            if (row === col) return cell(0)
            const unload = Number.parseFloat(flushVector[row * 2] ?? '')
            const load = Number.parseFloat(flushVector[col * 2 + 1] ?? '')
            // No usable vector: keep BambuStudio's own default pair rather than invent a number.
            if (!Number.isFinite(unload) || !Number.isFinite(load)) return cell(280)
            return cell(unload + load)
          }
          // Carried cells are normalised too: a source that arrived numeric must not survive as
          // numeric just because its value was reachable.
          const carryCell = (raw: unknown): string | undefined =>
            raw == null ? undefined : typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : undefined
          const next: unknown[] = []
          for (let extruder = 0; extruder < extruderCount; extruder++) {
            // A retarget that ADDED an extruder has no block for it yet; seed it from the last
            // one the project actually has rather than zero-filling a usable matrix away.
            const base = Math.min(extruder, sourceBlocks - 1) * oldCount * oldCount
            for (let row = 0; row < newCount; row++) {
              for (let col = 0; col < newCount; col++) {
                const carried = row < oldCount && col < oldCount
                next.push(carried
                  ? carryCell(value[base + sourceFor(row) * oldCount + sourceFor(col)]) ?? seedFor(row, col)
                  : seedFor(row, col))
              }
            }
          }
          record[key] = next
        }
        continue
      }
      if (key === 'flush_volumes_vector') {
        // `[unload_i, load_i]` PAIRS, one per filament slot: BambuStudio seeds new matrix cells
        // from `filaments[2*i] + filaments[2*j+1]` (PresetBundle::update_multi_material_filament_
        // presets). Its 2N length hides it from the generic remap below, and BambuStudio itself
        // only ever resizes it at the TAIL, so a mid-list remove or reorder must move the pairs
        // with their slots here or the per-material purge volumes describe the wrong filaments.
        // 140 is BambuStudio's default entry, used when the source pair is absent or short.
        record[key] = Array.from({ length: newCount * 2 }, (_unused, index) => {
          const source = sourceFor(Math.floor(index / 2)) * 2 + (index % 2)
          return value[source] ?? '140'
        })
        continue
      }
      // Variant-expanded arrays are handled ONLY for keys we can positively classify as
      // filament-domain (the filament catalog, plus the layout's own identity column): unlike the
      // N-long path below, an N*V length is too weak a signal on its own (a 4-plate project with
      // 2 filaments x 2 variants would convict per-plate arrays like `wipe_tower_x`).
      // Classified by BambuStudio's OPTION rule, not by length. A length test both convicts and
      // acquits wrongly: an ordinary per-slot array whose count happens to equal `slots x variants`
      // gets re-blocked, while a genuine variant key stored at another width is skipped. The layout's
      // own identity column is variant-scoped by definition. See `variant-options.ts`.
      const isVariantExpanded = variantCount > 1 && value.length === oldCount * variantCount
        && (key === 'filament_extruder_variant' || isFilamentVariantOption(key))
      if (isVariantExpanded) {
        // Slot i owns the V-wide block starting at i*V. The layout's identity column
        // (`filament_extruder_variant`) must ALWAYS survive by block-remap: losing it breaks the
        // variant topology every other N*V-long key is decoded against.
        if (key !== 'filament_extruder_variant' && materialChanged && !authoringPhysics) {
          // Same rule, and the same GATE, as the N-long arrays below: drop the OLD material's
          // physics only when the caller could not resolve the new presets, and let the slicer
          // re-derive every column from the kept `filament_settings_id` at slice time.
          //
          // The gate used to be missing here, which is not a smaller version of the same bug: a
          // dropped key is unrecoverable within the save, because `rebindProjectFilamentPhysics`
          // below only rewrites keys still PRESENT. So an editor save that HAD resolved the presets
          // still lost every `filament_options_with_variant` key, three of the five completeness
          // sentinels among them, and wrote a project BambuStudio opens as unnamed default presets.
          // The N-long keys beside them were re-authored correctly, which is what made the damage
          // look partial and material-specific rather than variant-specific.
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
        // variant-expanded width is provably stale: leftovers from an earlier filament set that a
        // pre-variant-aware save failed to rewrite (production files carry 10 columns beside a
        // 1-entry filament list). No index mapping can read it correctly, so drop it and let the
        // slicer re-derive from `filament_settings_id`. Keys outside the filament catalog (per-plate
        // arrays like `wipe_tower_x`, unknown domains) are left alone: length alone doesn't
        // convict them.
        //
        // SCOPED TO THE TUNE CATALOGUE ON PURPOSE, and narrower than what detection judges: the
        // inspector reads BambuStudio's full filament option list, so a handful of variant-scoped
        // keys it can flag (`volumetric_speed_coefficients`, `filament_preheat_temperature_delta`)
        // are invisible here. That is not a gap to close by widening this set. Deleting more of a
        // user's document during an ORDINARY save is the behind-the-scenes repair this project
        // deliberately does not do; those keys are rewritten by `restoreFilamentPhysics` when the
        // user asks for a repair, which `settings-repair-roundtrip.test.ts` pins end to end.
        if (FILAMENT_SETTING_KEYS.has(key) && !FILAMENT_IDENTITY_KEYS.has(key)) delete record[key]
        continue
      }
      if (materialChanged && !authoringPhysics && !FILAMENT_IDENTITY_KEYS.has(key)) {
        // No resolved presets to author from, so drop the OLD material's cloned physics and let the
        // slicer re-derive it from the name. Leaves the project incomplete for BambuStudio, which is
        // why a caller that CAN resolve the presets takes the authoring path instead.
        delete record[key]
        continue
      }
      record[key] = Array.from({ length: newCount }, (_unused, i) => value[sourceFor(i)])
    }
    // `different_settings_to_system` and `inherits_group` are PARALLEL PRESET RECORDS,
    // `[process, ...filament slots, machine]` (length oldCount+2), so the generic remap above skips
    // both. `resizeParallelPresetRecord` rebuilds them: each new slot follows its source slot, and a
    // slot whose MATERIAL changed is blanked.
    //
    // Blanking is right for both, for two different reasons. The changed-from-system record is the
    // authoritative "changed within this 3MF" signal the material dialog reads, so a stale entry
    // would flag keys the new material never touched. And a slot that no longer inherits the old
    // material's parent gets the honest empty value, which the CLI reads as "this slot IS a system
    // preset"; the binding pass fills in the real parent when it could resolve one.
    //
    // Leaving `inherits_group` at the OLD width is FATAL, not untidy: the CLI sizes its
    // filament-system-name vector from THIS array (`current_filaments_system_name.resize(size - 2)`)
    // and then indexes `filament_settings_id` with it, unguarded, so an entry left behind by a
    // removed slot makes BambuStudio read past the end of the filament names and SIGSEGV while
    // loading the project, before slicing starts (opaque exit 139). Seen in production: a project
    // taken from 5 filaments to 1 kept 7 entries here and killed every slice of that file.
    // `applyFilamentPresetBindings` also rebuilds it, but only when at least one slot resolved a
    // preset: the SIZE invariant has to hold regardless of whether it did.
    const resizeOptions = {
      oldFilamentCount: oldCount,
      newFilamentCount: newCount,
      sourceSlotFor: (slot: number) => (slotMaterialChanged(slot) ? null : sourceFor(slot))
    }
    for (const key of ['different_settings_to_system', 'inherits_group'] as const) {
      // Only a record already at the expected width is rebuilt: a mis-sized one is a defect the
      // Repair stage owns, and quietly reshaping it during an ordinary save is the behind-the-scenes
      // healing this project deliberately does not do.
      const previous = record[key]
      if (!Array.isArray(previous) || previous.length !== oldCount + 2) continue
      const resized = resizeParallelPresetRecord(previous, resizeOptions)
      if (resized) record[key] = resized
    }
  }

  // Write each changed slot's NEW material physics from its resolved preset, replacing the values
  // cloned from the slot it came from. This is what keeps a saved project self-contained: the file
  // carries the material's own temperatures, flow, cooling and retraction rather than only its name,
  // so BambuStudio can bind the slot to a NAMED preset instead of inventing an unnamed one from bare
  // defaults. Runs INSTEAD of the wholesale drop above, never after it: `rebindProjectFilamentPhysics`
  // only rewrites keys that are still present, so a dropped key would stay dropped. It preserves a
  // slot's genuine in-project overrides by contract (`different_settings_to_system`), which is the
  // behaviour a save wants: the user's own tweaks outlive a material change.
  if (materialChangedBySlot && filaments.some((filament) => filament.config != null)) {
    const rebound = rebindProjectFilamentPhysics(record, filaments.map((filament, i) => ({
      // Only a CHANGED slot is re-authored; an untouched slot keeps what the project already had.
      config: materialChangedBySlot(i) ? (filament.config as ProcessConfig | null) ?? null : null,
      settingsId: null
    })))
    for (const key of Object.keys(record)) if (!(key in rebound)) delete record[key]
    Object.assign(record, rebound)
  }

  // Name each slot's parent preset and declare what it changed. Writing the VALUES above is only
  // half of binding a slot: BambuStudio normalizes a slot against its parent before comparing it to
  // the installed preset, and for a USER preset that step is reached only through `inherits_group`.
  // Without it a slot whose values were byte-identical to a BambuStudio-written file still opened
  // as a `(<project>.3mf)` copy. See `filament-preset-binding.ts`.
  applyFilamentPresetBindings(record, filaments.map((filament) => (
    filament.presetInherits === undefined && filament.presetChangedKeys === undefined
      ? null
      : { inherits: filament.presetInherits ?? null, changedKeys: filament.presetChangedKeys ?? [] }
  )))

  // Authoritative colour/type from the desired list (overrides the cloned values above).
  record.filament_colour = filaments.map((filament) => filamentColourOut(filament.color))
  const previousTypes = Array.isArray(record.filament_type) ? record.filament_type : []
  // Written as `SceneEditFilament.type` gives it, which is the DERIVED display type ("PLA-S").
  //
  // That spelling is wrong for the engine: `get_filament_temp_type` (`Print.cpp:2703-2710`)
  // matches raw type names only, so a support slot falls out of the temperature-compatibility
  // tally and mixing it with a high-temp filament is not reported. Storing the raw type was tried and REVERTED, because
  // `slotMaterialChanged` compares this same `filament.type` against the stored value: making the
  // two different spellings marks every support slot as changed on every save, which drops the
  // material physics and wipes that slot's `inherits_group`. Fixing it means teaching the
  // COMPARISON to derive both sides, not just changing what is written.
  record.filament_type = filaments.map((filament, i) => filament.type ?? (typeof previousTypes[i] === 'string' ? previousTypes[i] : 'PLA'))
  // Persist the chosen filament preset name per slot so a material PROFILE change (e.g. PLA -> PETG)
  // survives a save, otherwise `filament_settings_id` keeps the prior preset and the project reopens
  // as the old material (with a name/type mismatch). A slot with no explicit `settingsId` keeps the
  // value carried over from its source slot above.
  // NEVER an empty name. An empty entry resolves to no preset, so BambuStudio mints a
  // project-embedded preset out of its BARE CONFIG DEFAULTS (max volumetric speed 2, flow ratio 1,
  // `compatible_printers` All) and names it `(<project>.3mf)`: the empty name plus its project
  // suffix, with `1(<project>.3mf)` for a second one. It then writes that junk preset into the file
  // as a `Metadata/filament_settings_N.config` sidecar and re-embeds it on EVERY later save (see
  // `PresetCollection::get_project_embedded_presets`), so one bad save follows the project forever
  // and the slot prints with default physics. Reported from a real file: slots reading
  // `1(test.3mf)` / `(test.3mf)`.
  //
  // The remap above only supplies a name when the base HAD a filament list; an editor-born project
  // (`oldCount === 0`) has none, so a slot whose material never resolved to a preset arrived here
  // with nothing. It inherits the name of the slot its physics were cloned from instead, the same
  // `sourceIndex` every other per-filament array is remapped through, so the name and the physics
  // describe one material. The gate below guarantees at least one resolved name exists to fall back
  // to, which is what makes the empty case unreachable rather than merely unlikely.
  if (filaments.some((filament) => filament.settingsId)) {
    const previousSettingsIds = Array.isArray(record.filament_settings_id) ? record.filament_settings_id : []
    const previousNameAt = (index: number): string | null =>
      (typeof previousSettingsIds[index] === 'string' && previousSettingsIds[index] !== ''
        ? previousSettingsIds[index] as string
        : null)
    const clonedFrom = (index: number): number => {
      const requested = filaments[index]?.sourceIndex
      const source = requested == null ? index : requested
      return source >= 0 && source < filaments.length ? source : 0
    }
    const anyResolvedName = filaments.find((filament) => filament.settingsId)?.settingsId as string
    record.filament_settings_id = filaments.map((filament, i) => {
      const source = clonedFrom(i)
      return filament.settingsId
        ?? previousNameAt(i)
        ?? filaments[source]?.settingsId
        ?? previousNameAt(source)
        ?? anyResolvedName
    })
  }

  // `filament_ids` is BambuStudio's BINDING key, and it must describe the same preset as
  // `filament_settings_id` above. BambuStudio guarantees that by construction, both arrays are
  // parallel projections of one selected-preset list (`PresetBundle`: `filament_settings_id` gets
  // `preset.name`, `filament_ids` gets `preset.filament_id`), so they cannot drift. Ours could,
  // because `filament_ids` is an IDENTITY key above and identity keys are cloned from the slot a
  // material came FROM. That is right for a colour or a nozzle pick (user choices worth carrying)
  // and wrong here: the id is derived from the material, so switching a slot's material kept the old
  // material's id under the new name. A real ABS -> PETG project therefore saved as
  // `["GFB00","GFB00","GFS06"]` (ABS, ABS, Support-for-ABS) while naming PETG HF and PLA Basic;
  // BambuStudio could not reconcile the two and fabricated a defaults-only project preset per slot,
  // named `(<project>.3mf)`. Sliced output was unaffected only because slice prep re-derives the
  // filament config from the NAMES.
  //
  // Mirrors BambuStudio for the unknown case too: it emplaces `preset.filament_id`, which is `""`
  // when the preset declares none (after the parent-preset fallback), so an unknown id is an EMPTY
  // entry that keeps the array positional, never a stale value, and never a dropped key.
  {
    const previousIds = Array.isArray(record.filament_ids) ? record.filament_ids : []
    const previousIdAt = (index: number): string | null =>
      (typeof previousIds[index] === 'string' ? previousIds[index] as string : null)
    const changedAt = materialChangedBySlot ?? (() => false)
    if (filaments.some((filament) => filament.filamentId) || previousIds.length > 0) {
      record.filament_ids = filaments.map((filament, i) => (
        // An explicit id always wins; otherwise a slot that kept its material keeps its id, and a
        // slot that CHANGED material without a resolvable id reports unknown rather than lying.
        filament.filamentId ?? (changedAt(i) ? '' : previousIdAt(i) ?? '')
      ))
    }
  }

  // Scalar filament-INDEX process values (`support_filament` and friends) each name a 1-based slot
  // (0 = "Default": the object's own filament), so a save that renumbers slots must move them like
  // the parallel arrays above. A value whose slot was removed, or that dangled beyond the old
  // list, has its key deleted, falling back to the default the way BambuStudio's own delete path
  // and the session-side `remapFilamentIndexOverrides` do.
  const slotIdRemap = filamentSlotIdRemap(filaments)
  for (const key of FILAMENT_INDEX_PROCESS_KEYS) {
    const raw = record[key]
    const value = typeof raw === 'string' || typeof raw === 'number' ? Number.parseInt(String(raw), 10) : Number.NaN
    if (!Number.isInteger(value) || value < 1) continue
    const moved = slotIdRemap.get(value)
    if (moved == null) delete record[key]
    else if (moved !== value) record[key] = String(moved)
  }

  // Custom layer print sequences are ordered lists of 1-based filament ids and must follow the
  // permutation too. `first_layer_print_sequence` is a plain id list (a leading "0" means AUTO and
  // carries no ids); `other_layers_print_sequence` is `other_layers_print_sequence_nums` equal
  // chunks of `[rangeStart, rangeEnd, ...filamentIds]` (BambuStudio's ParameterUtils.cpp). An id
  // whose slot was removed is dropped from every chunk, mirroring BambuStudio's delete handling
  // (`PartPlate::update_first_layer_print_sequence_when_delete_filament`); a file whose chunks
  // would come out unequal, the flat encoding cannot express that, is left untouched instead.
  if (Array.isArray(record.first_layer_print_sequence)
    && record.first_layer_print_sequence.length > 0
    && String(record.first_layer_print_sequence[0]) !== '0') {
    record.first_layer_print_sequence = record.first_layer_print_sequence
      .map((entry) => slotIdRemap.get(Number.parseInt(String(entry), 10)))
      .filter((id): id is number => id != null)
      .map((id) => String(id))
  }
  const otherLayersSequence = record.other_layers_print_sequence
  const sequenceChunks = Number.parseInt(String(record.other_layers_print_sequence_nums ?? ''), 10)
  if (Array.isArray(otherLayersSequence) && Number.isInteger(sequenceChunks) && sequenceChunks > 0
    && otherLayersSequence.length % sequenceChunks === 0) {
    const chunkSize = otherLayersSequence.length / sequenceChunks
    const chunks: string[][] = []
    for (let chunk = 0; chunk < sequenceChunks; chunk += 1) {
      const base = chunk * chunkSize
      const ids = otherLayersSequence.slice(base + 2, base + chunkSize)
        .map((entry) => slotIdRemap.get(Number.parseInt(String(entry), 10)))
        .filter((id): id is number => id != null)
        .map((id) => String(id))
      chunks.push([String(otherLayersSequence[base]), String(otherLayersSequence[base + 1]), ...ids])
    }
    if (chunks.every((chunk) => chunk.length === chunks[0]!.length)) {
      record.other_layers_print_sequence = chunks.flat()
    }
  }

  // `filament_self_index` rows carry the 1-based filament index per variant row. Uniform variant
  // blocks make it order-invariant, but a moved TPU slot changes the block widths and the stored
  // index would misdescribe the layout at its correct length. Rebuild it for the final slot order;
  // null (unreconstructable) leaves the file for the parse-side inspection to flag rather than
  // writing a plausible-looking wrong value.
  if (!isIdentityFilamentSlotRemap(slotIdRemap)) {
    const rebuiltSelfIndex = rebuildFilamentSelfIndex(record)
    if (rebuiltSelfIndex) record.filament_self_index = rebuiltSelfIndex
  }
  // And bring it back to the layout's length whenever THIS save changed the filament count,
  // whatever the remap looked like.
  //
  // Gated on the count, not run unconditionally, because those are different acts. Writing a
  // correctly sized array for a list we just grew or shrank is AUTHORING: we invalidated the old
  // one, so leaving it is writing a defect. Conforming an array on a save that changed nothing
  // would be repairing someone's stored file without being asked, which is the thing
  // `repairs/index.ts` forbids and `machine-retarget-variant-index.test.ts` pins.
  //
  // A remap only describes slots that SURVIVED, so appending a material and removing the last one
  // both look like the identity and skipped the rebuild above, while `filament_extruder_variant`
  // (a variant-scoped key) grew or shrank with the filament list. `filament_self_index` is in
  // neither the filament catalog nor the variant option set, so no other branch of this loop
  // resizes it either: it simply fell through at its old length.
  //
  // BambuStudio REFUSES TO OPEN the result. `load_config_file_config` throws "Invalid configuration
  // file" when `filament_extruder_variant.size() != filament_self_index.size()`, so an ordinary
  // Add-material wrote a project the user could no longer open in Studio. The CLI rebuilds the array
  // itself before slicing, which is exactly why this stayed invisible: the file still sliced here.
  //
  // Same implementation the parse-side inspection and the staged repair use, so a file cannot be
  // authored into a shape one of them would call broken. Null means unreconstructable, which leaves
  // the old value for the inspection to flag rather than writing a plausible wrong one.
  if (oldCount > 0 && newCount !== oldCount) {
    const conformedSelfIndex = repairFilamentSelfIndex(record)
    if (conformedSelfIndex) record.filament_self_index = conformedSelfIndex
  }

  // A project whose physics was DROPPED by an older save has no arrays left for
  // `rebindProjectFilamentPhysics` to rewrite (it only touches keys still present), so the values are
  // written from scratch instead: see `repairs/restore-filament-physics.ts` for why the column width
  // has to come from the preset rather than be guessed. This is what makes SAVING the repair for the
  // `filamentPhysics` defect: reopening an affected project and saving restores its materials.
  //
  // Judged on the RECORD THIS PASS HAS BUILT, and therefore LAST -- after the identity arrays above
  // exist. Two things depend on that placement, and the second is why this sits at the end of the
  // function rather than beside the rebind it complements.
  //
  // It cannot read the INPUT: a physics defect introduced by this same pass could then never be
  // restored by it, and one was (the variant-scoped drop wrote a project missing three of the five
  // completeness sentinels while the input was healthy, so the gate saw nothing to do).
  //
  // And it cannot run before the identity is written: `inspectProjectFilamentPhysics` counts SLOTS,
  // and a from-scratch bake (`applyProjectSettings('{}')`, which is every editor-born project's
  // first save) has none until the arrays below are assigned. Judging the empty record returned
  // null -- "nothing to judge" -- so a new project saved every material's physics into the void
  // however completely the editor had resolved it, and reopened flagged `filamentPhysics` on a file
  // the bake had just been handed the values for. The bake's own output check said so at the time,
  // in a log line nobody was reading: "wrote ... with repairable settings defects: filamentPhysics".
  //
  // Not a widening of what gets repaired. An unchanged pass produces the input, so an already-broken
  // project behaves exactly as before, and the restore still writes nothing without resolved presets
  // to write from, which is what keeps the deliberate no-preset drop above intact.
  if (inspectProjectFilamentPhysics(JSON.stringify(record))?.inconsistent === true) {
    restoreFilamentPhysics(record, filaments.map((filament) => (filament.config as ProcessConfig | null) ?? null))
  }

  return JSON.stringify(record)
}

/**
 * Persist the editor's per-material dual-nozzle assignment into `project_settings.config`.
 *
 * `filament_nozzle_map` is written **verbatim** as each slot's runtime nozzle id (0 = right,
 * 1 = left), the same nozzle-id space the index parser (`extractNozzleMapping`) reads back and
 * the slicer writes. Per the nozzle-mapping invariant, do NOT remap it through
 * `physical_extruder_map`: a second inversion mis-assigns nozzles on non-identity machines (the
 * H2D's `["1","0"]`) and fails dual-nozzle offset calibration (printer error 0300-4010).
 *
 * `extruder_nozzle_stats` is rebuilt so an extruder reads "active" iff a filament is assigned to
 * it, otherwise a stale single-active reading short-circuits `extractNozzleMapping` and forces
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
  // `extruder_nozzle_stats` is `VolumeType#count` per EXTRUDER, and the count IS how many filaments
  // that extruder feeds: BambuStudio's own save of a 3-filament dual-nozzle project reads
  // ["Standard#2","Standard#1"] for a 2/1 split, matching this. It must be rewritten whenever the
  // assignment changes: our index parser treats an extruder with count 0 as inactive and
  // short-circuits every filament onto the other nozzle, so a stale value makes a reassignment
  // silently fail to persist (pinned in `apps/api/src/lib/three-mf.test.ts`).
  //
  // The corruption seen in production came from the RETARGET recomputing this from
  // `extruder_max_nozzle_count` instead, that is a different quantity (["1","1"] on the very
  // machine whose stats are ["Standard#2","Standard#1"]), and it now preserves the value instead.
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
/**
 * The 1-based old-slot → new-slot map a desired filament list implies. `sourceIndex` names the
 * 0-based old slot each new slot was seeded from (null means "same slot"); the FIRST new slot
 * referencing an old slot wins, since kept slots precede cloned adds in the desired list. An old
 * slot with no entry was removed by this save: consumers drop or default references to it.
 */
export function filamentSlotIdRemap(filaments: SceneEditFilament[]): Map<number, number> {
  const remap = new Map<number, number>()
  filaments.forEach((filament, i) => {
    const src = filament.sourceIndex ?? i
    if (src >= 0 && !remap.has(src + 1)) remap.set(src + 1, i + 1)
  })
  return remap
}

/**
 * True when the remap moves nothing: every kept slot keeps its number. A pure tail shrink counts
 * as identity, a dangling reference above the new count is clamped by each consumer (BambuStudio
 * reads an out-of-range paint state / extruder as unpainted/default), so the whole-archive mesh
 * rewrites gated on this stay reserved for saves that actually permute slots.
 */
export function isIdentityFilamentSlotRemap(remap: ReadonlyMap<number, number>): boolean {
  for (const [oldId, newId] of remap) {
    if (oldId !== newId) return false
  }
  return true
}

/**
 * Re-key every 1-based filament reference in `model_settings.config` metadata: the part/object
 * `extruder` assignments plus the per-object/per-part filament-index process overrides
 * (`support_filament` and friends). A reference whose material was removed falls back the way
 * BambuStudio's delete path does: `extruder` to material 1 (a part must have SOME material), the
 * process keys to absent (their 0/"Default" state, meaning the object's own filament).
 */
function remapModelSettingsFilamentRefs(modelSettingsXml: string, remap: ReadonlyMap<number, number>): string {
  const filamentIndexKeys = new Set(FILAMENT_INDEX_PROCESS_KEYS)
  return modelSettingsXml.replace(
    /[ \t]*<metadata\s+key="([a-z_]+)"\s+value="(\d+)"\s*\/>\n?/g,
    (block, key: string, value: string) => {
      if (key !== 'extruder' && !filamentIndexKeys.has(key)) return block
      const oldId = Number.parseInt(value, 10)
      if (!Number.isInteger(oldId) || oldId < 1) return block
      const newId = remap.get(oldId)
      if (newId != null) return newId === oldId ? block : block.replace(`value="${value}"`, `value="${newId}"`)
      return key === 'extruder' ? block.replace(`value="${value}"`, 'value="1"') : ''
    }
  )
}

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
 * actually hold its geometry: `entryPath -> {mesh objectId}`. Mirrors {@link resolvePartPaintByEntry},
 * a Bambu project keeps each object's mesh in its own `3D/Objects/*.model`, so the id the editor
 * marked is a root that references the real mesh objects through `<components>`. An object with an
 * inline mesh (no components: e.g. a from-scratch scaffold) carries its own id in the root entry.
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
 * (add/remove materials) and per-slot dual-nozzle assignment, the plate type, per-plate
 * prime-tower corners, and, last, so authoring always wins first, the staged settings repairs.
 * Empty when the edit touches none of them.
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
  // AFTER the filament list (which remaps the matrix for the new material set) so the user's own
  // numbers win, and BEFORE the repair pass so a stale edit is still caught by it rather than
  // riding through as the exact shape the engine segfaults on.
  if (edit.flushVolumes) {
    const flushVolumes = edit.flushVolumes
    transforms.push((json) => applyFlushVolumes(json, flushVolumes))
  }
  if (edit.repairSettings) {
    transforms.push(repairProjectSettingsDocument)
  }
  return transforms
}

/**
 * Apply the settings-level shared repairs to a `project_settings.config` document: flush sizing
 * (`flush_volumes_matrix` + `flush_multiplier`), `filament_self_index`, `filament_ids`, and
 * `inherits_group`, each defect's single
 * repair implementation from `repairs/`, so detection and repair can never disagree. Every step is
 * inspect-gated, so a healthy document rides through byte-identical. `inherits_group` runs last
 * because it reads the filament slot count the other steps do not change. The model_settings half
 * of the staged repair (object-level extruders) is applied by {@link buildEditedThreeMfDocuments}.
 */
export function repairProjectSettingsDocument(projectSettingsJson: string): string {
  let record: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(projectSettingsJson)
    if (!parsed || typeof parsed !== 'object') return projectSettingsJson
    record = parsed as Record<string, unknown>
  } catch {
    return projectSettingsJson
  }
  const flushInspection = inspectProjectFlushVolumesMatrix(projectSettingsJson)
  if (flushInspection?.matrixInconsistent) {
    const repaired = repairFlushVolumesMatrix(
      Array.isArray(record.flush_volumes_matrix) ? record.flush_volumes_matrix : null,
      flushInspection.filamentCount,
      flushInspection.extruderCount
    )
    if (repaired) record.flush_volumes_matrix = repaired
  }
  if (flushInspection?.multiplierInconsistent) {
    const repaired = repairFlushMultiplier(record.flush_multiplier, flushInspection.extruderCount)
    if (repaired) record.flush_multiplier = repaired
  }
  if (inspectProjectFilamentSelfIndex(projectSettingsJson)?.inconsistent) {
    const repaired = repairFilamentSelfIndex(record)
    if (repaired) record.filament_self_index = repaired
  }
  if (inspectProjectFilamentIds(projectSettingsJson)?.inconsistent) {
    repairFilamentIds(record)
  }
  if (inspectProjectInheritsGroup(JSON.stringify(record))?.inconsistent) {
    const repaired = repairInheritsGroup(record)
    if (repaired) record.inherits_group = repaired
  }
  return JSON.stringify(record)
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
  // A cleared numeric field arrives as "", which BambuStudio's scalar deserialisers fail on, and the
  // resulting throw abandons every key it had not yet applied (`settings-value-guard.ts` has the
  // full trace). Dropping loses nothing: an empty value says only that the box is empty, and
  // omitting the override leaves the setting at whatever it already was.
  for (const [key, value] of Object.entries(dropEngineHostileOverrides(overrides))) record[key] = value
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
 * Write the editor's purge volumes into `flush_volumes_matrix` and the mode's multiplier key.
 *
 * The edit is checked against the topology of the document it is landing in, the filament set
 * this very bake just wrote, and DROPPED if it does not match, leaving the matrix
 * {@link applyFilamentList} already remapped. That is deliberate: a matrix authored for a
 * different material list describes purges between filaments that no longer exist, and forcing it
 * to fit would either scramble the numbers or write the out-of-bounds shape that segfaults the
 * engine mid-slice. Dropping loses an edit the user can redo; writing it loses the slice.
 *
 * The multiplier is per-EXTRUDER and independent of the filament set, so a stale one is conformed
 * rather than dropped.
 */
function applyFlushVolumes(projectSettingsJson: string, flushVolumes: SceneEditFlushVolumes): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return projectSettingsJson
  }
  if (!parsed || typeof parsed !== 'object') return projectSettingsJson
  const record = parsed as Record<string, unknown>
  // Same sources as `inspectProjectFlushVolumesMatrix`: filaments from `filament_colour`, extruders
  // from the NON-deduplicated `nozzle_diameter` (one entry per nozzle).
  const filamentCount = Array.isArray(record.filament_colour) ? record.filament_colour.length : 0
  const extruderCount = Array.isArray(record.nozzle_diameter) ? Math.max(record.nozzle_diameter.length, 1) : 1
  if (filamentCount <= 0) return projectSettingsJson

  const blocks = flushVolumes.matrix
  const shapeMatches = blocks.length === extruderCount
    && blocks.every((block) => block.length === filamentCount && block.every((row) => row.length === filamentCount))
  if (shapeMatches) {
    record.flush_volumes_matrix = writeFlushVolumesMatrixBlocks(blocks)
  }

  const multiplierKey = flushMultiplierKeyForPrimeVolumeMode(record.prime_volume_mode)
  const multiplier = flushVolumes.multiplier.map((value) => String(value))
  record[multiplierKey] = repairFlushMultiplier(multiplier, extruderCount, defaultFlushMultiplierFor(multiplierKey))
    ?? multiplier
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
