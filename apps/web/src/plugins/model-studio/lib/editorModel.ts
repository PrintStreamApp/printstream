/**
 * In-memory editable scene model for the interactive 3D plate editor.
 *
 * Owns the plain-data representation the editor mutates (plates -> instances ->
 * decomposed transforms) and the conversions to/from the locked shared contracts:
 * - `seedEditorState` builds the model from the per-plate `LibraryThreeMfScene`
 *   responses, decomposing each instance's plate-local 12-element transform into
 *   position/rotation(Euler XYZ)/scale so the gizmos can drive it directly.
 * - `buildSceneEdit` flattens the model back into a `SceneEdit` the slicer applies.
 *
 * The transform convention MUST match the backend: M = T * R(eulerXYZ) * S, with
 * position in mm plate-local (from plate centre), rotation in radians XYZ, and
 * per-axis scale. We never bake the plate origin here.
 */
import * as THREE from 'three'
import type {
  LibraryThreeMfPrimeTower,
  LibraryThreeMfScene,
  LibraryThreeMfSceneInstance,
  SceneEdit,
  SceneEditAddedPartSubtype,
  SceneEditPartSubtype,
  StagedImport,
  ThreeMfIndex
} from '@printstream/shared'
import { randomUUID } from '../../../lib/randomId'
import { createThreeMfMatrix } from './threeMfScene'
import { importMeshUrl } from './editorImports'

/**
 * Geometry source for an editor instance. `object`-backed instances reference
 * in-project Bambu objects (rendered from the base 3MF's model entries);
 * `import`-backed instances reference a foreign mesh staged server-side and
 * rendered from a binary STL at `meshUrl`. The two map to the locked
 * `SceneEditInstance` contract's mutually-exclusive `objectId` / `importId`.
 */
export type EditorInstanceSource =
  | { kind: 'object' }
  | {
      kind: 'import'
      importId: string
      meshUrl: string
      /**
       * The stable object identity for this import-backed instance, used so per-object
       * PROCESS overrides (and per-part filament) can be authored against it before any save
       * and re-keyed onto the baked object at slice/save time (via {@link collectMeshReplacements}).
       * Two cases:
       * - **Fresh import**: a synthetic NEGATIVE id from {@link nextSyntheticObjectId} (the
       *   object has no baked id yet).
       * - **"Replace with…"**: the replaced in-project object's real Bambu `object_id`, so its
       *   existing per-object overrides and name follow onto the replacement.
       * Either way the editor keeps the per-object settings UI attached to this id.
       */
      replacedObjectId?: number
    }

/** A single placed model instance the editor manipulates. */
export interface EditorInstance {
  /** Stable client key; survives re-renders and identifies the Three.js group. */
  key: string
  /** How this instance's geometry is sourced (in-project object vs staged import). */
  source: EditorInstanceSource
  /** Source geometry object id (Bambu root object_id). Only meaningful when `source.kind === 'object'`. */
  objectId: number
  /** Original copy index within the object (best-effort; not load-bearing on apply). */
  instanceId: number
  name: string
  /**
   * True once the user renamed this object in the editor. Only renamed objects emit
   * an `objectNames` override in {@link buildSceneEdit}, so untouched objects keep
   * the source 3MF's names (and generated `Object N` fallbacks aren't written out).
   */
  nameOverridden?: boolean
  /** Plate-local placement in mm from the plate centre. */
  position: THREE.Vector3
  /** Euler rotation in radians, order 'XYZ'. */
  rotation: THREE.Euler
  /** Per-axis scale. */
  scale: THREE.Vector3
  /**
   * Exact plate-local 12-element transform, kept ONLY when the source matrix can't be reproduced
   * by the editor's T·S·R (translate·scale·rotate) decomposition — i.e. a foreign object that is
   * both rotated and non-uniformly scaled (its linear part shears relative to T·S·R). While set,
   * the object renders and re-emits this matrix verbatim (no shear), so an unedited round-trip is
   * exact; the first transform edit bakes it down to the editor's T·S·R and clears this. Absent
   * for everything else (the common case), which behaves exactly as before.
   */
  exactMatrix?: number[]
  filamentId: number | null
  /**
   * Whether this instance prints (BambuStudio's per-object "Printable" toggle). A
   * non-printable instance is greyed out in the viewport and excluded from the slice,
   * but kept in the saved 3MF so it can be re-enabled. This is the editor's source of
   * truth for printability — independent of the slice dialog's per-plate selection —
   * so it follows the object across plate moves and duplicates and is emitted as
   * `printable` in {@link buildSceneEdit}. Defaults to true.
   */
  printable: boolean
  /**
   * Manual brim ears seeded from the source 3MF (object-level, so identical across
   * copies). Session edits live in {@link EditorState.brimEars}; this is the baseline.
   */
  brimEars?: EditorBrimEar[]
  /**
   * The geometry parts that make up this instance. Each part references a 3MF
   * model entry plus a component-local transform applied under the placement.
   */
  parts: EditorInstancePart[]
  /** Display color hint from the source scene (falls back to a neutral grey). */
  color: string | null
}

export interface EditorInstancePart {
  entryPath: string
  componentObjectId: number
  /** Component-local 12-element transform, applied under the instance placement. */
  transform: number[]
  /** Per-part filament/extruder assignment from the source 3MF (parts can differ from the object). */
  filamentId: number | null
  /** Part display name from the 3MF model-settings (falls back to a generated label in the UI). */
  name: string | null
  /** Baked color hint for this part's filament. */
  color: string | null
  /** Raw subtype (support_blocker/support_enforcer/modifier_part/...) or null for a normal part. */
  subtype: string | null
}

export interface EditorPlate {
  /** 1-based, contiguous plate index. */
  index: number
  name: string | null
  plateType: string | null
  /** Bed bounds in mm; used to size the bed surface and clamp adds. */
  bed: { minX: number; maxX: number; minY: number; maxY: number; excludeAreas: Array<{ polygon: Array<{ x: number; y: number }>; label: string | null }> }
  instances: EditorInstance[]
  /** Prime/wipe tower footprint (plate-local), or null when the plate has no tower. */
  primeTower: LibraryThreeMfPrimeTower | null
  /** Layer-based filament changes seeded from the source 3MF (baseline). */
  filamentChanges?: EditorFilamentChange[]
  /**
   * This session's edited change set for the plate; undefined means untouched (the
   * seeded baseline applies and nothing is emitted for this plate). Lives on the
   * plate so reorders/deletes keep it aligned with the right plate.
   */
  filamentChangesOverride?: EditorFilamentChange[]
  /** Layer pauses seeded from the source 3MF (baseline). */
  pauses?: EditorPause[]
  /** This session's edited pause set; undefined means untouched (same rules as filament changes). */
  pausesOverride?: EditorPause[]
}

/** One layer-based filament change: swap to `filamentId` at print height `z` (mm). */
export interface EditorFilamentChange {
  z: number
  filamentId: number
}

/** One layer pause: printing stops just before the layer whose top is `z` (mm). */
export interface EditorPause {
  z: number
}

/** Effective filament changes for a plate: this session's override, else the seed. */
export function effectiveFilamentChanges(plate: EditorPlate): EditorFilamentChange[] {
  return plate.filamentChangesOverride ?? plate.filamentChanges ?? []
}

/** Effective layer pauses for a plate: this session's override, else the seed. */
export function effectivePauses(plate: EditorPlate): EditorPause[] {
  return plate.pausesOverride ?? plate.pauses ?? []
}

export interface EditorState {
  plates: EditorPlate[]
  /**
   * Per-part support-paint overrides made this session, keyed by
   * {@link supportPaintKey}. Each value is the COMPLETE desired paint map for that
   * part (triangle index in mesh order -> `paint_supports` code), seeded from the
   * source mesh's existing paint on the first brush stroke. Parts without an entry
   * keep their source paint untouched. Participates in undo/redo via
   * {@link cloneEditorState} and is emitted by {@link buildSceneEdit}.
   */
  supportPaint?: Record<string, Record<number, string>>
  /** Seam-brush counterpart of {@link EditorState.supportPaint} (`paint_seam` codes). */
  seamPaint?: Record<string, Record<number, string>>
  /** Colour-brush counterpart of {@link EditorState.supportPaint} (`paint_color` codes). */
  colorPaint?: Record<string, Record<number, string>>
  /**
   * Per-object manual brim-ear overrides made this session, keyed by objectId. Each
   * value is the COMPLETE desired ear set for the object (object-local mm + radius);
   * an empty array clears the object's ears. Objects without an entry keep their
   * seeded ears ({@link EditorInstance.brimEars}). Cloned by {@link cloneEditorState}
   * and merged with the seeded baseline by {@link buildSceneEdit}.
   */
  brimEars?: Record<number, EditorBrimEar[]>
  /**
   * New part volumes added inside objects this session (negative parts, modifiers,
   * support blockers/enforcers), keyed by objectId. Parts are object-level (shared by
   * every instance). Cloned by {@link cloneEditorState}; emitted by
   * {@link buildSceneEdit} as `SceneEdit.addedParts`.
   */
  addedParts?: Record<number, EditorAddedPart[]>
  /**
   * In-project objects the user marked for mesh repair this session (right-click →
   * "Repair mesh"), by objectId. The repair itself runs SERVER-SIDE while baking the save
   * (`SceneEdit.repairedObjectIds` → `three-mf-mesh-repair`), so there is nothing to apply
   * to the local scene: repair only merges coincident vertices and drops degenerate/duplicate
   * facets, which is visually a no-op. Marking is therefore the whole client-side edit — it
   * participates in undo/redo via {@link cloneEditorState} and is emitted by
   * {@link buildSceneEdit}. Object-level (shared by every instance), like {@link EditorState.addedParts}.
   */
  repairedObjectIds?: number[]
  /**
   * Per-PART process overrides made this session (process settings on one part of an object,
   * separate from the object's overall overrides), keyed by {@link supportPaintKey}
   * (`objectId:componentObjectId`). Each value is the desired override map for that part; an empty
   * map clears it. Cloned by {@link cloneEditorState}; emitted as `SceneEdit.partProcessOverrides`.
   */
  partProcessOverrides?: Record<string, Record<string, string>>
  /**
   * Part-type changes made this session (BambuStudio's "Change type": normal/negative/
   * modifier/support blocker/enforcer), keyed by {@link supportPaintKey}
   * (`objectId:componentObjectId`; an unsaved import keys on its synthetic object id).
   * The change is also reflected onto every instance's `part.subtype` so the list and
   * viewport re-render from one source. Cloned by {@link cloneEditorState}; emitted as
   * `SceneEdit.partTypeChanges` / `SceneEdit.importPartTypes`.
   */
  partTypeChanges?: Record<string, SceneEditPartSubtype>
  /**
   * Part-placement changes made this session (moving/rotating/scaling a part inside its
   * object with the gizmo), keyed by {@link supportPaintKey} (`objectId:componentObjectId`).
   * Each value is the part's new OBJECT-LOCAL 3MF matrix (12 numbers, column-major 3x3 +
   * translation). The change is also reflected onto every instance's `part.transform` so
   * rebuilds and thumbnails render from one source. Cloned by {@link cloneEditorState};
   * emitted as `SceneEdit.partTransforms`.
   */
  partTransforms?: Record<string, number[]>
}

/** A new volume added inside an object this session (Bambu "Add negative part/..."). */
export interface EditorAddedPart {
  /** Stable client key (viewport mesh tagging + list identity). */
  key: string
  /** Staged import providing the mesh to the server at save/slice time. */
  importId: string
  subtype: SceneEditAddedPartSubtype
  name: string
  /** OBJECT-LOCAL placement (mesh/rotor space). */
  position: THREE.Vector3
  rotation: THREE.Euler
  scale: THREE.Vector3
  /** Client render geometry: non-indexed triangle soup, part-local (9 floats/tri). */
  soup: Float32Array
  /** Per-volume process overrides (modifier parts), serialized config strings. */
  settings?: Record<string, string>
}

/** An instance's object's added parts (object-level, shared across instances). */
export function effectiveAddedParts(state: EditorState | null, instance: EditorInstance): EditorAddedPart[] {
  if (instance.source.kind !== 'object') return []
  return state?.addedParts?.[instance.objectId] ?? []
}

/** One manual brim ear in object-local coordinates. */
export interface EditorBrimEar {
  x: number
  y: number
  z: number
  radius: number
}

/** Effective ears for an instance's object: this session's override, else the seed. */
export function effectiveBrimEars(state: EditorState | null, instance: EditorInstance): EditorBrimEar[] {
  if (instance.source.kind !== 'object') return []
  const override = state?.brimEars?.[instance.objectId]
  return override ?? instance.brimEars ?? []
}

/** Key for {@link EditorState.supportPaint}: paint is shared per object part. */
export function supportPaintKey(objectId: number, componentObjectId: number): string {
  return `${objectId}:${componentObjectId}`
}

const DEFAULT_BED = { minX: -128, maxX: 128, minY: -128, maxY: 128, excludeAreas: [] as Array<{ polygon: Array<{ x: number; y: number }>; label: string | null }> }

/** Generate a unique, stable key for an editor instance. */
export function nextInstanceKey(): string {
  return randomUUID()
}

let syntheticObjectIdCounter = 0
/**
 * Allocate a stable, NEGATIVE object id for a freshly-imported object. A not-yet-saved import
 * has no baked 3MF object id, so this synthetic id stands in as the object's identity: it lets
 * the editor author per-object process overrides and per-part filament against the import
 * immediately (no save first), and is re-keyed onto the baked object id at slice/save time via
 * the {@link collectMeshReplacements} seam. Negative so it can never collide with a real
 * (positive) baked object id.
 */
export function nextSyntheticObjectId(): number {
  syntheticObjectIdCounter += 1
  return -syntheticObjectIdCounter
}

/**
 * Decompose a 3MF transform into the editor's T·S·R convention (scale applied OUTSIDE the
 * rotation — `world = translate · scale · rotate`), which is how the editor renders (outer
 * group carries scale, inner rotor carries rotation) AND how it re-emits the matrix
 * ({@link instanceTransformMatrix}). three.js' `Matrix4.decompose` assumes T·R·S (scale inside
 * rotation) and pulls scale from the matrix's COLUMN lengths; for a rotated, non-uniformly
 * scaled object that disagrees with the editor's render, so an unedited round-trip silently
 * sheared the object. Here scale comes from the linear part's ROW lengths and the rotation is
 * the row-normalized remainder, so `T·S·R` exactly reproduces a matrix the editor itself wrote.
 * For every other case (no rotation, uniform scale, or rotation-only) this equals three.js'
 * decomposition.
 */
export function decomposeInstanceTransform(transform: number[]): {
  position: THREE.Vector3
  rotation: THREE.Euler
  scale: THREE.Vector3
} {
  const m = createThreeMfMatrix(transform).elements // column-major; A[r][c] = m[c*4 + r]
  const position = new THREE.Vector3(m[12] ?? 0, m[13] ?? 0, m[14] ?? 0)
  // Row-length scales (A = S·R ⇒ |row r| = S_r).
  let sx = Math.hypot(m[0] ?? 0, m[4] ?? 0, m[8] ?? 0)
  const sy = Math.hypot(m[1] ?? 0, m[5] ?? 0, m[9] ?? 0)
  const sz = Math.hypot(m[2] ?? 0, m[6] ?? 0, m[10] ?? 0)
  // Keep the rotation proper (det +1): if the linear part is left-handed, flip one scale axis.
  const det =
    (m[0] ?? 0) * ((m[5] ?? 0) * (m[10] ?? 0) - (m[9] ?? 0) * (m[6] ?? 0))
    - (m[4] ?? 0) * ((m[1] ?? 0) * (m[10] ?? 0) - (m[9] ?? 0) * (m[2] ?? 0))
    + (m[8] ?? 0) * ((m[1] ?? 0) * (m[6] ?? 0) - (m[5] ?? 0) * (m[2] ?? 0))
  if (det < 0) sx = -sx
  const rx = sx || 1, ry = sy || 1, rz = sz || 1
  // R = diag(1/S) · A (divide each row by its scale), then read Euler XYZ from it.
  const rot = new THREE.Matrix4().set(
    (m[0] ?? 0) / rx, (m[4] ?? 0) / rx, (m[8] ?? 0) / rx, 0,
    (m[1] ?? 0) / ry, (m[5] ?? 0) / ry, (m[9] ?? 0) / ry, 0,
    (m[2] ?? 0) / rz, (m[6] ?? 0) / rz, (m[10] ?? 0) / rz, 0,
    0, 0, 0, 1
  )
  const rotation = new THREE.Euler().setFromRotationMatrix(rot, 'XYZ')
  return { position, rotation, scale: new THREE.Vector3(sx || 1, sy || 1, sz || 1) }
}

/** The editor's render/emit composition: world = T · S · R (matches {@link instanceTransformMatrix}). */
function composeTSRMatrix(position: THREE.Vector3, rotation: THREE.Euler, scale: THREE.Vector3): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeTranslation(position.x, position.y, position.z)
    .multiply(new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z))
    .multiply(new THREE.Matrix4().makeRotationFromEuler(rotation))
}

/**
 * The exact transform to keep ONLY when T·S·R can't reproduce the source (a foreign object that's
 * both rotated and non-uniformly scaled shears relative to T·S·R). Returns the 12-element source so
 * the editor can render/emit it verbatim; undefined when T·S·R is exact (the common case).
 */
export function exactTransformIfShearing(transform: number[]): number[] | undefined {
  const { position, rotation, scale } = decomposeInstanceTransform(transform)
  const source = createThreeMfMatrix(transform).elements
  const recomposed = composeTSRMatrix(position, rotation, scale).elements
  for (let i = 0; i < 16; i++) {
    if (Math.abs((source[i] ?? 0) - (recomposed[i] ?? 0)) > 1e-6) return [...transform]
  }
  return undefined
}

/** Per-part filament/name/color keyed by `entryPath::componentObjectId`, derived from the
 * scene's flat `parts` list (the grouped instance parts don't carry filament themselves). */
type PartInfoLookup = Map<string, { filamentId: number | null; name: string | null; color: string | null }>

const partInfoKey = (entryPath: string, componentObjectId: number) => `${entryPath}::${componentObjectId}`

function instanceFromScene(instance: LibraryThreeMfSceneInstance, partInfo: PartInfoLookup): EditorInstance {
  const { position, rotation, scale } = decomposeInstanceTransform(instance.transform)
  const exactMatrix = exactTransformIfShearing(instance.transform)
  return {
    key: nextInstanceKey(),
    source: { kind: 'object' },
    objectId: instance.objectId,
    instanceId: instance.instanceId,
    name: instance.name ?? `Object ${instance.objectId}`,
    position,
    rotation,
    scale,
    ...(exactMatrix ? { exactMatrix } : {}),
    filamentId: instance.filamentId,
    // Seed from the parsed 3MF so a project saved with non-printable objects reopens
    // with them still greyed out; absent (older parse / new object) means printable.
    printable: instance.printable ?? true,
    color: instance.color,
    ...(instance.brimEars && instance.brimEars.length > 0
      ? { brimEars: instance.brimEars.map((ear) => ({ ...ear })) }
      : {}),
    parts: instance.parts.map((part) => {
      const info = partInfo.get(partInfoKey(part.entryPath, part.componentObjectId))
      return {
        entryPath: part.entryPath,
        componentObjectId: part.componentObjectId,
        transform: [...part.transform],
        filamentId: info?.filamentId ?? instance.filamentId,
        name: info?.name ?? null,
        color: info?.color ?? instance.color,
        subtype: part.subtype ?? null
      }
    })
  }
}

/** Seed an empty new-project state: a single empty plate, no instances. */
export function seedEmptyEditorState(): EditorState {
  return {
    plates: [{ index: 1, name: null, plateType: null, bed: { ...DEFAULT_BED }, instances: [], primeTower: null }]
  }
}

/**
 * Apply a plate's scene response onto an (empty or placeholder) editor plate: bed,
 * instances, and prime tower. Used at seed time and again for plates whose scenes
 * stream in after the visible plate (the editor seeds without waiting for them).
 */
export function fillPlateFromScene(plate: EditorPlate, scene: LibraryThreeMfScene): EditorPlate {
  const partInfo: PartInfoLookup = new Map()
  for (const part of scene.parts) {
    const key = partInfoKey(part.entryPath, part.objectId)
    const existing = partInfo.get(key)
    if (!existing) {
      partInfo.set(key, { filamentId: part.filamentId, name: part.name, color: part.color })
      continue
    }
    // The same mesh component can back several placed objects, each with its OWN
    // filament (scene.parts rows are per-placement). Conflicting rows mean the
    // filament isn't a property of the shared mesh — neutralize it so each editor
    // part falls back to its instance's filament/color instead of whichever row
    // happened to come last (which painted every copy the same colour AND would
    // have rewritten every object's extruder to that filament on save).
    if (existing.filamentId !== part.filamentId) existing.filamentId = null
    if (existing.color !== part.color) existing.color = null
  }
  return {
    ...plate,
    bed: { minX: scene.bed.minX, maxX: scene.bed.maxX, minY: scene.bed.minY, maxY: scene.bed.maxY, excludeAreas: scene.bed.excludeAreas },
    instances: scene.instances.map((instance) => instanceFromScene(instance, partInfo)),
    primeTower: scene.primeTower ?? null,
    ...(scene.filamentChanges && scene.filamentChanges.length > 0
      ? { filamentChanges: scene.filamentChanges.map((change) => ({ z: change.z, filamentId: change.filamentId })) }
      : {}),
    ...(scene.pauses && scene.pauses.length > 0
      ? { pauses: scene.pauses.map((pause) => ({ z: pause.z })) }
      : {})
  }
}

/**
 * Seed the editable state from the plate index and the per-plate scene responses.
 * Plates are taken from the index (so empty plates survive); instances come from
 * each plate's scene `instances` array. Plates whose scene is missing from the map
 * seed empty and can be filled later via {@link fillPlateFromScene} — but they borrow
 * the BED from any already-loaded scene (every plate in a project shares one printer
 * bed), so camera framing and unprintable zones never snap from a generic placeholder
 * when a late-loading plate is first selected.
 */
export function seedEditorState(
  index: ThreeMfIndex,
  scenesByPlate: Map<number, LibraryThreeMfScene>
): EditorState {
  const loadedScene = scenesByPlate.values().next().value as LibraryThreeMfScene | undefined
  const fallbackBed = loadedScene
    ? {
        minX: loadedScene.bed.minX, maxX: loadedScene.bed.maxX,
        minY: loadedScene.bed.minY, maxY: loadedScene.bed.maxY,
        excludeAreas: loadedScene.bed.excludeAreas
      }
    : DEFAULT_BED
  const plates: EditorPlate[] = index.plates.map((plate) => {
    const scene = scenesByPlate.get(plate.index)
    const base: EditorPlate = {
      index: plate.index,
      name: plate.name ?? null,
      plateType: plate.plateType ?? null,
      bed: { ...fallbackBed },
      instances: [],
      primeTower: null
    }
    return scene ? fillPlateFromScene(base, scene) : base
  })

  if (plates.length === 0) {
    plates.push({ index: 1, name: null, plateType: null, bed: { ...DEFAULT_BED }, instances: [], primeTower: null })
  }

  const partProcessOverrides = collectPartProcessOverridesFromScenes(scenesByPlate)
  return {
    plates: reindexPlates(plates),
    ...(Object.keys(partProcessOverrides).length > 0 ? { partProcessOverrides } : {})
  }
}

/**
 * Re-hydrate per-part PROCESS overrides from saved scenes, keyed by
 * {@link supportPaintKey} (`objectId:componentObjectId`). Mirrors the object-level
 * re-hydration: the editor's per-part gear shows what the 3MF already carries so a
 * reopened project keeps its part-scoped settings instead of starting blank.
 */
export function collectPartProcessOverridesFromScenes(
  scenesByPlate: Map<number, LibraryThreeMfScene>
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const scene of scenesByPlate.values()) {
    for (const instance of scene.instances) {
      for (const part of instance.parts) {
        if (!part.processOverrides || Object.keys(part.processOverrides).length === 0) continue
        const key = supportPaintKey(instance.objectId, part.componentObjectId)
        if (out[key]) continue
        out[key] = { ...part.processOverrides }
      }
    }
  }
  return out
}

/**
 * Build an import-backed instance from a freshly staged foreign model, placed at
 * the plate centre with identity rotation/scale. A single-solid import renders from
 * one staged binary STL and carries no `parts`; a multi-solid import (a STEP assembly)
 * carries one part per solid (rendered from a per-solid STL, listed nested, and baked
 * as one object with many parts). On apply it emits an `importId`.
 */
export function instanceFromStagedImport(staged: StagedImport): EditorInstance {
  // `staged.parts` always lists ≥1 solid; only treat it as multi-part when there is
  // more than one (a single-solid import keeps the simpler one-mesh render path).
  const parts: EditorInstancePart[] = staged.parts.length > 1
    ? staged.parts.map((part, index) => ({
        // For an unsaved import, parts have no baked 3MF ids yet: `entryPath` marks the
        // import and `componentObjectId` is the solid's index (a stable client key).
        entryPath: `import:${staged.importId}`,
        componentObjectId: index,
        transform: IDENTITY_PART_TRANSFORM.slice(),
        filamentId: null,
        name: part.name,
        color: null,
        subtype: null
      }))
    : []
  return {
    key: nextInstanceKey(),
    // A synthetic object identity so the import's per-object process + per-part filament are
    // editable immediately, before any save (see {@link EditorInstanceSource}).
    source: { kind: 'import', importId: staged.importId, meshUrl: importMeshUrl(staged.importId), replacedObjectId: nextSyntheticObjectId() },
    objectId: 0,
    instanceId: 0,
    name: staged.name,
    position: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Euler(0, 0, 0, 'XYZ'),
    scale: new THREE.Vector3(1, 1, 1),
    filamentId: null,
    printable: true,
    color: null,
    parts
  }
}

/** Identity 12-element (column-major 3x3 + translation) part transform. */
const IDENTITY_PART_TRANSFORM = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

/**
 * Replace an instance's geometry with a freshly staged foreign model while keeping the
 * object in place, like BambuStudio's "Replace with…": the new mesh inherits the old
 * instance's placement (position/rotation/scale), material (`filamentId`), printability,
 * and NAME. The result is import-backed (like Cut/Split outputs) with a NEW key.
 *
 * When `replacedObjectId` is given (replacing an in-project object), the object's identity
 * is retained for the slicer: the import carries `replacedObjectId` so {@link buildSceneEdit}
 * emits a `meshReplacements` entry and the object's per-object PROCESS overrides + name
 * follow onto the baked replacement. Attributes tied to the OLD geometry — in-project parts,
 * brim ears, and paint — do not carry over, since the new mesh is unrelated to the old shape.
 */
export function replaceInstanceGeometry(
  source: EditorInstance,
  staged: StagedImport,
  replacedObjectId?: number
): EditorInstance {
  const next = instanceFromStagedImport(staged)
  next.source = {
    kind: 'import',
    importId: staged.importId,
    meshUrl: importMeshUrl(staged.importId),
    // Keep the replaced object's identity; for an import without one, keep a fresh synthetic id
    // so the replacement is still per-object editable before a save.
    replacedObjectId: replacedObjectId ?? (next.source.kind === 'import' ? next.source.replacedObjectId : undefined)
  }
  next.position.copy(source.position)
  next.rotation.copy(source.rotation)
  next.scale.copy(source.scale)
  next.filamentId = source.filamentId
  next.printable = source.printable
  // Keep the object's name as part of its retained identity. Mark it overridden so it is
  // emitted (and applied to the baked import) rather than falling back to the new file name.
  next.name = source.name
  next.nameOverridden = true
  return next
}

/** Deep-clone an instance (for duplicate), offsetting it slightly so it is visible. */
export function duplicateInstance(instance: EditorInstance): EditorInstance {
  return {
    key: nextInstanceKey(),
    source:
      instance.source.kind === 'import'
        ? {
            kind: 'import',
            importId: instance.source.importId,
            meshUrl: instance.source.meshUrl,
            ...(instance.source.replacedObjectId != null ? { replacedObjectId: instance.source.replacedObjectId } : {})
          }
        : { kind: 'object' },
    objectId: instance.objectId,
    instanceId: instance.instanceId,
    name: instance.name,
    nameOverridden: instance.nameOverridden,
    position: instance.position.clone().add(new THREE.Vector3(10, 10, 0)),
    rotation: instance.rotation.clone(),
    scale: instance.scale.clone(),
    filamentId: instance.filamentId,
    printable: instance.printable,
    color: instance.color,
    parts: instance.parts.map((part) => ({ ...part, transform: [...part.transform] }))
  }
}

/**
 * Find a free plate-local position for a newly added/duplicated model: start at the
 * plate centre and spiral outward until a spot at least `spacing` mm from every
 * existing instance is found (kept within the bed). Approximates Bambu's "place new
 * objects where they don't overlap" without needing per-object geometry sizes.
 */
export function findFreePlatePosition(plate: EditorPlate, spacing = 60): { x: number; y: number } {
  const centerX = (plate.bed.minX + plate.bed.maxX) / 2
  const centerY = (plate.bed.minY + plate.bed.maxY) / 2
  const taken = plate.instances.map((instance) => ({ x: instance.position.x, y: instance.position.y }))
  const margin = spacing / 2
  const inBed = (x: number, y: number) =>
    x >= plate.bed.minX + margin && x <= plate.bed.maxX - margin
    && y >= plate.bed.minY + margin && y <= plate.bed.maxY - margin
  const isFree = (x: number, y: number) => taken.every((point) => Math.hypot(point.x - x, point.y - y) >= spacing)
  if (isFree(centerX, centerY)) return { x: centerX, y: centerY }
  for (let ring = 1; ring <= 10; ring += 1) {
    for (let step = 0; step < ring * 8; step += 1) {
      const angle = (step / (ring * 8)) * Math.PI * 2
      const x = centerX + Math.cos(angle) * spacing * ring
      const y = centerY + Math.sin(angle) * spacing * ring
      if (inBed(x, y) && isFree(x, y)) return { x, y }
    }
  }
  return { x: centerX, y: centerY }
}

/** Re-number plates to a contiguous 1-based sequence, preserving order. */
export function reindexPlates(plates: EditorPlate[]): EditorPlate[] {
  return plates.map((plate, position) => (plate.index === position + 1 ? plate : { ...plate, index: position + 1 }))
}

/** Flatten the editable state into the locked `SceneEdit` contract. */
/**
 * Whether an instance needs its full matrix emitted. World-space scale only diverges
 * from the decomposed translate*rotate*scale form (and can shear) when the object is
 * BOTH rotated AND non-uniformly scaled. Otherwise T*R*S is exact, so we omit the
 * matrix to keep the slice request small — it travels in an HTTP header with a tight
 * size limit, so emitting 12 extra numbers per instance unconditionally can overflow it.
 */
function instanceNeedsMatrix(instance: EditorInstance): boolean {
  const EPS = 1e-6
  const { rotation: r, scale: s } = instance
  const rotated = Math.abs(r.x) > EPS || Math.abs(r.y) > EPS || Math.abs(r.z) > EPS
  const nonUniform = Math.abs(s.x - s.y) > EPS || Math.abs(s.y - s.z) > EPS || Math.abs(s.x - s.z) > EPS
  return rotated && nonUniform
}

/**
 * Full local transform as a 12-element column-major matrix (3x3 + translation),
 * composed as translate * scale * rotate. Scale is applied *outside* the rotation
 * (matching the editor's outer-group/rotor split) so it's along the bed axes; this
 * can shear for rotated + non-uniformly-scaled objects, which T*R*S can't express.
 */
function instanceTransformMatrix(instance: EditorInstance): number[] {
  const matrix = new THREE.Matrix4()
    .makeTranslation(instance.position.x, instance.position.y, instance.position.z)
    .multiply(new THREE.Matrix4().makeScale(instance.scale.x, instance.scale.y, instance.scale.z))
    .multiply(new THREE.Matrix4().makeRotationFromEuler(instance.rotation))
  const e = matrix.elements
  return [e[0]!, e[1]!, e[2]!, e[4]!, e[5]!, e[6]!, e[8]!, e[9]!, e[10]!, e[12]!, e[13]!, e[14]!]
}

export function buildSceneEdit(state: EditorState): SceneEdit {
  return {
    plates: state.plates.map((plate) => ({
      index: plate.index,
      name: plate.name ?? undefined,
      plateType: plate.plateType ?? undefined,
      primeTower: plate.primeTower ? { x: plate.primeTower.x, y: plate.primeTower.y } : null
    })),
    instances: state.plates.flatMap((plate) =>
      plate.instances.map((instance) => ({
        // Exactly one geometry reference per the locked SceneEditInstance contract.
        ...(instance.source.kind === 'import'
          ? { importId: instance.source.importId }
          : { objectId: instance.objectId }),
        plateIndex: plate.index,
        position: { x: instance.position.x, y: instance.position.y, z: instance.position.z },
        rotation: { x: instance.rotation.x, y: instance.rotation.y, z: instance.rotation.z },
        scale: { x: instance.scale.x, y: instance.scale.y, z: instance.scale.z },
        // An unedited shearing object emits its exact matrix verbatim (so it round-trips without
        // deforming); otherwise emit a full matrix only when T·S·R can't be reproduced from TRS.
        ...(instance.exactMatrix
          ? { matrix: instance.exactMatrix }
          : instanceNeedsMatrix(instance) ? { matrix: instanceTransformMatrix(instance) } : {}),
        filamentId: instance.filamentId,
        // Only emit when skipped; undefined means printable (the contract default), so
        // unchanged projects don't carry a redundant flag on every instance.
        ...(instance.printable ? {} : { printable: false })
      }))
    ),
    partFilaments: collectPartFilaments(state),
    partProcessOverrides: collectPartProcessOverrides(state),
    partTypeChanges: collectPartTypeChanges(state),
    partTransforms: collectPartTransforms(state),
    importPartFilaments: collectImportPartFilaments(state),
    importPartProcessOverrides: collectImportPartProcessOverrides(state),
    importPartTypes: collectImportPartTypes(state),
    supportPaint: collectPartPaint(state, state.supportPaint),
    seamPaint: collectPartPaint(state, state.seamPaint),
    colorPaint: collectPartPaint(state, state.colorPaint),
    brimEars: collectBrimEars(state),
    filamentChanges: collectFilamentChanges(state),
    pauses: collectPauses(state),
    objectNames: collectObjectNames(state),
    addedParts: collectAddedParts(state),
    meshReplacements: collectMeshReplacements(state),
    repairedObjectIds: collectRepairedObjectIds(state)
  }
}

/**
 * Emit the objects marked for mesh repair, dropped to those that still have a placed instance —
 * marking an object and then deleting it must not ship a dangling repair. An object replaced this
 * session is skipped too: its geometry is now import-backed, so the original mesh the mark referred
 * to is not what gets baked.
 */
function collectRepairedObjectIds(state: EditorState): SceneEdit['repairedObjectIds'] {
  if (!state.repairedObjectIds || state.repairedObjectIds.length === 0) return undefined
  const placedObjectIds = new Set<number>()
  const replacedObjectIds = new Set<number>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind === 'object') placedObjectIds.add(instance.objectId)
      else if (instance.source.replacedObjectId != null) replacedObjectIds.add(instance.source.replacedObjectId)
    }
  }
  const ids = state.repairedObjectIds.filter((id) => placedObjectIds.has(id) && !replacedObjectIds.has(id))
  return ids.length > 0 ? ids : undefined
}

/** Whether an object is already marked for mesh repair on save. */
export function isObjectMarkedForRepair(state: EditorState, objectId: number): boolean {
  return (state.repairedObjectIds ?? []).includes(objectId)
}

/**
 * Emit one `meshReplacements` entry per in-project object that was replaced this session
 * (its instances are now import-backed with a `replacedObjectId`). Deduped by the replaced
 * objectId — every copy of the object points at the same import — so the slicer can carry
 * the original object's per-object process overrides onto the baked replacement.
 */
function collectMeshReplacements(state: EditorState): SceneEdit['meshReplacements'] {
  const byObject = new Map<number, string>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind !== 'import' || instance.source.replacedObjectId == null) continue
      byObject.set(instance.source.replacedObjectId, instance.source.importId)
    }
  }
  if (byObject.size === 0) return undefined
  return [...byObject].map(([objectId, importId]) => ({ objectId, importId }))
}

/**
 * Emit added part volumes for objects that still have at least one placed instance
 * (adding a part and then deleting the object must not ship a dangling part).
 */
function collectAddedParts(state: EditorState): SceneEdit['addedParts'] {
  if (!state.addedParts) return undefined
  const placedObjectIds = new Set<number>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind === 'object') placedObjectIds.add(instance.objectId)
    }
  }
  const out: NonNullable<SceneEdit['addedParts']> = []
  for (const [objectIdRaw, parts] of Object.entries(state.addedParts)) {
    const objectId = Number.parseInt(objectIdRaw, 10)
    if (!Number.isInteger(objectId) || !placedObjectIds.has(objectId)) continue
    for (const part of parts) {
      const matrix = new THREE.Matrix4().compose(
        part.position,
        new THREE.Quaternion().setFromEuler(part.rotation),
        part.scale
      )
      const e = matrix.elements
      out.push({
        objectId,
        importId: part.importId,
        subtype: part.subtype,
        name: part.name,
        matrix: [e[0]!, e[1]!, e[2]!, e[4]!, e[5]!, e[6]!, e[8]!, e[9]!, e[10]!, e[12]!, e[13]!, e[14]!],
        ...(part.settings && Object.keys(part.settings).length > 0 ? { settings: { ...part.settings } } : {})
      })
    }
  }
  return out.length > 0 ? out : undefined
}

/**
 * Emit only plates whose filament changes were edited this session (the writer merges
 * them with the source sidecar, preserving untouched plates and pause entries). An
 * edited-to-empty plate emits an empty list so its changes are cleared.
 */
function collectFilamentChanges(state: EditorState): SceneEdit['filamentChanges'] {
  const out: NonNullable<SceneEdit['filamentChanges']> = []
  for (const plate of state.plates) {
    if (!plate.filamentChangesOverride) continue
    out.push({
      plateIndex: plate.index,
      changes: [...plate.filamentChangesOverride]
        .sort((left, right) => left.z - right.z)
        .map((change) => ({ z: change.z, filamentId: change.filamentId }))
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Emit only plates whose layer pauses were edited this session (the writer merges them
 * with the source sidecar, preserving untouched plates and other entry types). An
 * edited-to-empty plate emits an empty list so its pauses are cleared.
 */
function collectPauses(state: EditorState): SceneEdit['pauses'] {
  const out: NonNullable<SceneEdit['pauses']> = []
  for (const plate of state.plates) {
    if (!plate.pausesOverride) continue
    out.push({
      plateIndex: plate.index,
      pauses: [...plate.pausesOverride]
        .sort((left, right) => left.z - right.z)
        .map((pause) => ({ z: pause.z }))
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Emit the COMPLETE brim-ear picture once any object was edited this session: the
 * sidecar file is rewritten wholesale, so untouched placed objects must re-emit their
 * seeded ears or they would be lost. No session edits -> undefined (file kept as-is).
 */
function collectBrimEars(state: EditorState): SceneEdit['brimEars'] {
  if (!state.brimEars || Object.keys(state.brimEars).length === 0) return undefined
  const byObject = new Map<number, EditorBrimEar[]>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind !== 'object' || byObject.has(instance.objectId)) continue
      byObject.set(instance.objectId, effectiveBrimEars(state, instance))
    }
  }
  const out: NonNullable<SceneEdit['brimEars']> = []
  for (const [objectId, ears] of byObject) {
    if (ears.length === 0) continue
    out.push({ objectId, points: ears.map((ear) => ({ ...ear })) })
  }
  // A defined-but-empty array still clears the file (all ears removed).
  return out
}

/**
 * Emit one channel's paint overrides for parts whose object still has at least one
 * placed instance (painting an object and then deleting it must not ship paint for
 * geometry the output no longer references).
 */
function collectPartPaint(
  state: EditorState,
  paint: Record<string, Record<number, string>> | undefined
): SceneEdit['supportPaint'] {
  if (!paint) return undefined
  const placedObjectIds = new Set<number>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind === 'object') placedObjectIds.add(instance.objectId)
    }
  }
  const out: NonNullable<SceneEdit['supportPaint']> = []
  for (const [key, triangles] of Object.entries(paint)) {
    const [objectIdRaw, componentRaw] = key.split(':')
    const objectId = Number.parseInt(objectIdRaw ?? '', 10)
    const componentObjectId = Number.parseInt(componentRaw ?? '', 10)
    if (!Number.isInteger(objectId) || !Number.isInteger(componentObjectId)) continue
    if (!placedObjectIds.has(objectId)) continue
    out.push({
      objectId,
      componentObjectId,
      triangles: Object.fromEntries(Object.entries(triangles).map(([index, code]) => [String(index), code]))
    })
  }
  return out.length > 0 ? out : undefined
}

/** Part-type changes for parts whose in-project object is still placed (keyed objectId:componentId). */
function collectPartTypeChanges(state: EditorState): SceneEdit['partTypeChanges'] {
  if (!state.partTypeChanges) return undefined
  const placedObjectIds = new Set<number>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind === 'object') placedObjectIds.add(instance.objectId)
    }
  }
  const out: NonNullable<SceneEdit['partTypeChanges']> = []
  for (const [key, subtype] of Object.entries(state.partTypeChanges)) {
    const [objectIdRaw, componentRaw] = key.split(':')
    const objectId = Number.parseInt(objectIdRaw ?? '', 10)
    const componentObjectId = Number.parseInt(componentRaw ?? '', 10)
    if (!Number.isInteger(objectId) || !Number.isInteger(componentObjectId)) continue
    if (!placedObjectIds.has(objectId)) continue
    out.push({ objectId, componentObjectId, subtype })
  }
  return out.length > 0 ? out : undefined
}

/** Part-placement changes for parts whose in-project object is still placed (keyed objectId:componentId). */
function collectPartTransforms(state: EditorState): SceneEdit['partTransforms'] {
  if (!state.partTransforms) return undefined
  const placedObjectIds = new Set<number>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind === 'object') placedObjectIds.add(instance.objectId)
    }
  }
  const out: NonNullable<SceneEdit['partTransforms']> = []
  for (const [key, matrix] of Object.entries(state.partTransforms)) {
    const [objectIdRaw, componentRaw] = key.split(':')
    const objectId = Number.parseInt(objectIdRaw ?? '', 10)
    const componentObjectId = Number.parseInt(componentRaw ?? '', 10)
    if (!Number.isInteger(objectId) || !Number.isInteger(componentObjectId)) continue
    if (!placedObjectIds.has(objectId) || matrix.length !== 12) continue
    out.push({ objectId, componentObjectId, matrix: [...matrix] })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Part-type changes for multi-solid imports, keyed by import + 0-based solid index. Mirrors
 * {@link collectImportPartProcessOverrides}: the UI keys the change by the import instance's
 * synthetic object id, mapped back to the importId here so the bake writes the solid's
 * `<part>` with the chosen subtype.
 */
function collectImportPartTypes(state: EditorState): SceneEdit['importPartTypes'] {
  if (!state.partTypeChanges) return undefined
  const importByObjectId = new Map<number, string>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind === 'import' && instance.source.replacedObjectId != null) {
        importByObjectId.set(instance.source.replacedObjectId, instance.source.importId)
      }
    }
  }
  if (importByObjectId.size === 0) return undefined
  const out: NonNullable<SceneEdit['importPartTypes']> = []
  for (const [key, subtype] of Object.entries(state.partTypeChanges)) {
    const [objectIdRaw, partRaw] = key.split(':')
    const objectId = Number.parseInt(objectIdRaw ?? '', 10)
    const partIndex = Number.parseInt(partRaw ?? '', 10)
    if (!Number.isInteger(objectId) || !Number.isInteger(partIndex)) continue
    const importId = importByObjectId.get(objectId)
    if (!importId) continue
    out.push({ importId, partIndex, subtype })
  }
  return out.length > 0 ? out : undefined
}

/** Per-part process overrides for parts whose object is still placed (keyed objectId:componentId). */
function collectPartProcessOverrides(state: EditorState): SceneEdit['partProcessOverrides'] {
  if (!state.partProcessOverrides) return undefined
  const placedObjectIds = new Set<number>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind === 'object') placedObjectIds.add(instance.objectId)
    }
  }
  const out: NonNullable<SceneEdit['partProcessOverrides']> = []
  for (const [key, overrides] of Object.entries(state.partProcessOverrides)) {
    const [objectIdRaw, componentRaw] = key.split(':')
    const objectId = Number.parseInt(objectIdRaw ?? '', 10)
    const componentObjectId = Number.parseInt(componentRaw ?? '', 10)
    if (!Number.isInteger(objectId) || !Number.isInteger(componentObjectId)) continue
    if (!placedObjectIds.has(objectId) || Object.keys(overrides).length === 0) continue
    out.push({ objectId, componentObjectId, overrides })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Collect per-object display-name overrides for objects the user renamed. Deduped by
 * object reference (objectId for in-project objects, importId for staged imports) since
 * the name is a property of the object, shared by all its instances.
 */
function collectObjectNames(state: EditorState): SceneEdit['objectNames'] {
  const byObject = new Map<string, NonNullable<SceneEdit['objectNames']>[number]>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (!instance.nameOverridden) continue
      if (instance.source.kind === 'import') {
        byObject.set(`import:${instance.source.importId}`, { importId: instance.source.importId, name: instance.name })
      } else {
        byObject.set(`object:${instance.objectId}`, { objectId: instance.objectId, name: instance.name })
      }
    }
  }
  return byObject.size > 0 ? [...byObject.values()] : undefined
}

/**
 * Distinct per-object-part filament assignments across the scene. Filament is shared by
 * every instance of an object, so we dedupe by objectId+componentObjectId; the slice-time
 * writer rewrites those parts' `extruder` metadata to persist material reassignments.
 */
function collectPartFilaments(state: EditorState): SceneEdit['partFilaments'] {
  const byKey = new Map<string, { objectId: number; componentObjectId: number; filamentId: number }>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind !== 'object') continue
      for (const part of instance.parts) {
        if (part.filamentId == null) continue
        byKey.set(`${instance.objectId}:${part.componentObjectId}`, {
          objectId: instance.objectId,
          componentObjectId: part.componentObjectId,
          filamentId: part.filamentId
        })
      }
    }
  }
  return byKey.size > 0 ? [...byKey.values()] : undefined
}

/**
 * Distinct per-part filament assignments for multi-solid imports, keyed by importId + the
 * solid's 0-based index (the part's `componentObjectId`, set at import time). Filament is shared
 * by every copy of the import, so we dedupe by importId+partIndex; the bake writes each part's
 * `extruder` directly (the import has no baked part ids yet, so it can't use `partFilaments`).
 */
/**
 * Per-part PROCESS overrides for multi-solid imports, keyed by import + 0-based solid index.
 * The per-part gear keys overrides by the instance's objectId, which for an unsaved import is its
 * synthetic `replacedObjectId`; map that back to the importId so the bake can apply them while the
 * import's solids are baked into one object. In-project objects are handled by
 * {@link collectPartProcessOverrides}; this only emits the import-backed ones.
 */
function collectImportPartProcessOverrides(state: EditorState): SceneEdit['importPartProcessOverrides'] {
  if (!state.partProcessOverrides) return undefined
  const importByObjectId = new Map<number, string>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind === 'import' && instance.source.replacedObjectId != null) {
        importByObjectId.set(instance.source.replacedObjectId, instance.source.importId)
      }
    }
  }
  if (importByObjectId.size === 0) return undefined
  const out: NonNullable<SceneEdit['importPartProcessOverrides']> = []
  for (const [key, overrides] of Object.entries(state.partProcessOverrides)) {
    const [objectIdRaw, partRaw] = key.split(':')
    const objectId = Number.parseInt(objectIdRaw ?? '', 10)
    const partIndex = Number.parseInt(partRaw ?? '', 10)
    if (!Number.isInteger(objectId) || !Number.isInteger(partIndex)) continue
    const importId = importByObjectId.get(objectId)
    if (!importId || Object.keys(overrides).length === 0) continue
    out.push({ importId, partIndex, overrides })
  }
  return out.length > 0 ? out : undefined
}

function collectImportPartFilaments(state: EditorState): SceneEdit['importPartFilaments'] {
  const byKey = new Map<string, { importId: string; partIndex: number; filamentId: number }>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind !== 'import' || instance.parts.length <= 1) continue
      const importId = instance.source.importId
      for (const part of instance.parts) {
        if (part.filamentId == null) continue
        byKey.set(`${importId}:${part.componentObjectId}`, { importId, partIndex: part.componentObjectId, filamentId: part.filamentId })
      }
    }
  }
  return byKey.size > 0 ? [...byKey.values()] : undefined
}

/**
 * Deep-clone the editable state for the undo/redo history. Transform edits mutate
 * instance position/rotation/scale in place, so snapshots must clone those Three.js
 * objects (and the plate/instance/part structure) to stay independent of later edits.
 */
export function cloneEditorState(state: EditorState): EditorState {
  return {
    plates: state.plates.map((plate) => ({
      index: plate.index,
      name: plate.name,
      plateType: plate.plateType,
      bed: { ...plate.bed },
      instances: plate.instances.map((instance) => ({
        key: instance.key,
        source: instance.source.kind === 'import'
          ? {
              kind: 'import',
              importId: instance.source.importId,
              meshUrl: instance.source.meshUrl,
              ...(instance.source.replacedObjectId != null ? { replacedObjectId: instance.source.replacedObjectId } : {})
            }
          : { kind: 'object' },
        objectId: instance.objectId,
        instanceId: instance.instanceId,
        name: instance.name,
        position: instance.position.clone(),
        rotation: instance.rotation.clone(),
        scale: instance.scale.clone(),
        ...(instance.exactMatrix ? { exactMatrix: [...instance.exactMatrix] } : {}),
        filamentId: instance.filamentId,
        printable: instance.printable,
        ...(instance.brimEars ? { brimEars: instance.brimEars.map((ear) => ({ ...ear })) } : {}),
        parts: instance.parts.map((part) => ({
          entryPath: part.entryPath,
          componentObjectId: part.componentObjectId,
          transform: [...part.transform],
          filamentId: part.filamentId,
          name: part.name,
          color: part.color,
          subtype: part.subtype
        })),
        color: instance.color
      })),
      primeTower: plate.primeTower ? { ...plate.primeTower } : null,
      ...(plate.filamentChanges ? { filamentChanges: plate.filamentChanges.map((change) => ({ ...change })) } : {}),
      ...(plate.filamentChangesOverride ? { filamentChangesOverride: plate.filamentChangesOverride.map((change) => ({ ...change })) } : {}),
      ...(plate.pauses ? { pauses: plate.pauses.map((pause) => ({ ...pause })) } : {}),
      ...(plate.pausesOverride ? { pausesOverride: plate.pausesOverride.map((pause) => ({ ...pause })) } : {})
    })),
    ...(state.supportPaint
      ? {
        supportPaint: Object.fromEntries(
          Object.entries(state.supportPaint).map(([key, codes]) => [key, { ...codes }])
        )
      }
      : {}),
    ...(state.seamPaint
      ? {
        seamPaint: Object.fromEntries(
          Object.entries(state.seamPaint).map(([key, codes]) => [key, { ...codes }])
        )
      }
      : {}),
    ...(state.colorPaint
      ? {
        colorPaint: Object.fromEntries(
          Object.entries(state.colorPaint).map(([key, codes]) => [key, { ...codes }])
        )
      }
      : {}),
    ...(state.partProcessOverrides
      ? {
        partProcessOverrides: Object.fromEntries(
          Object.entries(state.partProcessOverrides).map(([key, overrides]) => [key, { ...overrides }])
        )
      }
      : {}),
    ...(state.partTypeChanges ? { partTypeChanges: { ...state.partTypeChanges } } : {}),
    ...(state.partTransforms
      ? {
        partTransforms: Object.fromEntries(
          Object.entries(state.partTransforms).map(([key, matrix]) => [key, [...matrix]])
        )
      }
      : {}),
    ...(state.brimEars
      ? {
        brimEars: Object.fromEntries(
          Object.entries(state.brimEars).map(([key, ears]) => [key, ears.map((ear) => ({ ...ear }))])
        )
      }
      : {}),
    ...(state.repairedObjectIds ? { repairedObjectIds: [...state.repairedObjectIds] } : {}),
    ...(state.addedParts
      ? {
        addedParts: Object.fromEntries(
          Object.entries(state.addedParts).map(([key, parts]) => [key, parts.map((part) => ({
            key: part.key,
            importId: part.importId,
            subtype: part.subtype,
            name: part.name,
            position: part.position.clone(),
            rotation: part.rotation.clone(),
            scale: part.scale.clone(),
            // Geometry is immutable after staging; snapshots can share it.
            soup: part.soup,
            ...(part.settings ? { settings: { ...part.settings } } : {})
          }))])
        )
      }
      : {})
  }
}
