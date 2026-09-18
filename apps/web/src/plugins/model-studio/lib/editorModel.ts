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
import { listGapToIndex } from '../../../lib/listReorder'
import * as THREE from 'three'
import type {
  LibraryThreeMfPrimeTower,
  LibraryThreeMfScene,
  LibraryThreeMfSceneInstance,
  PlateLayerFilamentSequence,
  ProjectAuxiliaries,
  SceneEdit,
  SceneEditFlushVolumes,
  SceneEditImportPartFilament,
  SceneEditPartFilament,
  SceneEditPartSubtype,
  StagedImport,
  ThreeMfIndex
} from '@printstream/shared'
import { isSvgArchiveEntry, svgArchiveEntryPath } from '@printstream/shared/three-mf'
import type { BambuStudioShape, SvgPartRecord, TextInfo } from '@printstream/shared/three-mf'
import { canonicalThreeMfPartSubtype, isNonRenderableThreeMfPartSubtype, threeMfPartSubtypeCarriesFilament } from '@printstream/shared'
import type { RepairedFilamentPreset } from './filamentConfigAuthoring'
import { randomUUID } from '../../../lib/randomId'
import { createThreeMfMatrix } from './threeMfScene'
import { importMeshUrl } from './editorImports'
import { remapColorPaintCode, remapColorPaintMap } from './trianglePaintTree'
import { importIdByReplacedObjectId, parsePartPaintKey, placedObjectIds } from './sceneEditIdentity'

/**
 * How an import's mesh URL is resolved. Defaults to the api's staged-mesh endpoint; a host that
 * stages locally (the public editor) injects its own, which hands back an object URL. Kept as an
 * injected resolver rather than a plain string so a caller cannot forget one of the two places an
 * import's source is built.
 */
export type ImportMeshUrlResolver = (importId: string) => string

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
  /**
   * Set when this object IS text, created by the Text tool with nothing selected.
   *
   * The same record an added text part carries, so the tool can reopen it. Session-scoped for now:
   * a part's `textInfo` rides `SceneEdit.addedParts` to the bake, and an OBJECT has no equivalent
   * channel, so standalone text is re-editable until saved and plain geometry afterwards.
   */
  textInfo?: TextInfo
  /**
   * Set when this object IS extruded SVG artwork, created by the SVG tool with nothing selected.
   *
   * Session-scoped for the same reason {@link EditorInstance.textInfo} is: a part's record rides
   * `SceneEdit.addedParts` and an OBJECT has no equivalent channel, so a merged standalone import
   * is re-editable until saved and plain geometry afterwards. The non-body pieces of a SPLIT
   * standalone import are ordinary added parts and do persist.
   */
  svgPart?: SvgPartRecord
  /**
   * The cut group this object belongs to, from `cut_information.xml`. Two instances sharing a value
   * are the halves of one cut. Absent for anything that was never cut.
   */
  cutId?: number
  /** Plate-local placement in mm from the plate centre. */
  position: THREE.Vector3
  /** Euler rotation in radians, order 'XYZ'. */
  rotation: THREE.Euler
  /** Per-axis scale. */
  scale: THREE.Vector3
  /**
   * Exact plate-local 12-element transform, kept ONLY when the source matrix can't be reproduced
   * by the editor's T·S·R (translate·scale·rotate) decomposition: i.e. a foreign object that is
   * both rotated and non-uniformly scaled (its linear part shears relative to T·S·R). While set,
   * the object renders and re-emits this matrix verbatim (no shear), so an unedited round-trip is
   * exact; the first transform edit bakes it down to the editor's T·S·R and clears this. Absent
   * for everything else (the common case), which behaves exactly as before.
   */
  exactMatrix?: number[]
  /**
   * The object-level filament: what a part with no assignment of its own inherits, and what the
   * material swatch shows. A CACHE over {@link parts}, invalidated by every edit that changes a
   * part's filament, which must recompute it through {@link deriveObjectFilamentId} in the same
   * updater (see the retarget in `EditorView`). Never assign it from one part: consensus is the
   * whole point, and `parts[0]` is the "everything became material 1" regression.
   */
  filamentId: number | null
  /**
   * Whether this instance prints (BambuStudio's per-object "Printable" toggle). A
   * non-printable instance is greyed out in the viewport and excluded from the slice,
   * but kept in the saved 3MF so it can be re-enabled. This is the editor's source of
   * truth for printability, independent of the slice dialog's per-plate selection,
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
   * Height range modifiers seeded from the source 3MF (object-level, so identical across copies).
   * Session edits live in {@link EditorState.heightRanges}; this is the baseline.
   */
  heightRanges?: EditorHeightRange[]
  /**
   * Variable layer height profile seeded from the source 3MF (alternating z/height, object space).
   * Session edits live in {@link EditorState.layerHeightProfiles}; this is the baseline.
   */
  layerHeightProfile?: number[]
  /**
   * The geometry parts that make up this instance. Each part references a 3MF
   * model entry plus a component-local transform applied under the placement.
   */
  parts: EditorInstancePart[]
  /**
   * This object keeps no geometry of its own: its added volumes ARE the object.
   *
   * Set by deleting the BODY row, which post-save is an ordinary part and must therefore be
   * deletable before one. Only meaningful for an object with an empty `parts` list (the only kind
   * with a body row), and only ever set while a printed volume survives to carry the print -- the
   * same rule `canRemoveParts` applies to a baked part.
   *
   * Everything that reads geometry gets this for free, because the body mesh is simply never added
   * to the render group: bounds, footprint, the thumbnail, export and the boolean all walk the
   * group. The two places that must honour it explicitly are the scene build (which would otherwise
   * fetch and add the import's mesh) and {@link instanceVolumeRows} (which would otherwise offer a
   * row for geometry that is gone). It emits as `SceneEdit.removedObjectBodies`.
   */
  bodyRemoved?: boolean
  /** Display color hint from the source scene (falls back to a neutral grey). */
  color: string | null
}

/**
 * One geometry volume inside an instance.
 *
 * Two of these fields are MIRRORS of the session maps on {@link EditorState}, not independent
 * state: `transform` mirrors `partTransforms` and `subtype` mirrors `partTypeChanges`. The map is
 * what the save emits; the mirror is what the viewport and the sidebar render from, so both are
 * written in the SAME updater, a change that touches only the map renders stale, and one that
 * touches only the mirror is silently dropped at bake time. `filamentId` is not a mirror: it has no
 * session map and is read straight off the instances by `collectPartFilaments`.
 */
export interface EditorInstancePart {
  entryPath: string
  /**
   * The MESH this part draws, a `<component objectid>` / `<part id>` reference. NOT an identity:
   * BambuStudio writes the same id for every volume sharing a mesh, so an object can hold several
   * parts with the same `componentObjectId`. Use {@link EditorInstancePart.partIndex} to address a
   * part; use this only to find its geometry (and for MESH-scoped state like paint, which such
   * parts genuinely share).
   */
  componentObjectId: number
  /**
   * The part's 0-based ordinal within its object: BambuStudio's own part identity (it keys a
   * volume by its position as it parses `model_settings.config`). Stable for a given file because
   * `<part>`/`<component>` are written and read in volume order.
   */
  partIndex: number
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
  /**
   * What this part was AUTHORED from, when a tool made it: the text it was typed from, or the SVG
   * artwork it was extruded from. Absent for imported or primitive geometry, which is not authored
   * by anything we could reopen.
   *
   * Carried from the scene so a part stays re-editable ACROSS a close, not merely within the
   * session that created it. Both records reach the browser on the scene DTO
   * (`libraryThreeMfSceneInstancePartSchema`) and used to stop here: `textInfo` was written to the
   * file, parsed back, carried over the wire, and then never copied onto this type, so reopening a
   * saved project turned every text part into anonymous solids with nothing logged. Whatever is
   * added to the scene's part shape has to be copied here too, or it dies at this hop.
   */
  textInfo?: TextInfo
  svgPart?: SvgPartRecord
  /**
   * True when `cut_information.xml` names this volume a cut connector.
   *
   * BambuStudio leaves connectors out of an object's volume rows entirely and shows one
   * "Cut connectors" row instead (`can_add_volumes_to_object`, `GUI_ObjectList.cpp:4485`), so a
   * half with a body and one peg reads as a single row rather than as a multi-part object.
   * Carried through the same hops `textInfo` is, and for the same reason: without the read-back a
   * cut is only known to the session that made it.
   */
  cutConnector?: true
}

export interface EditorPlate {
  /** 1-based, contiguous plate index. */
  index: number
  /**
   * Session-stable identity, minted by {@link mintPlateId}. `index` is the plate's POSITION and
   * every {@link reindexPlates} rewrites it, so anything keyed on it drifts when plates move,
   * that is exactly how a reorder left the dragged plate's thumbnail on two strip tiles. Caches
   * that outlive renumbering (live plate-strip thumbnails, the stale-thumbnail set, the
   * pending-scene set) key on this instead. Never persisted.
   */
  plateId: number
  /**
   * The plate index this plate holds in the OPENED archive, or null for a plate created this
   * session. Addresses per-plate reads from the project source, the embedded thumbnail PNG and
   * the plate's scene, which stay keyed by the source's numbering however the session reorders.
   * Stays valid across saves because the project source answers from its open-time snapshot.
   */
  sourcePlateIndex: number | null
  name: string | null
  /**
   * This plate's OWN bed type, or null when it takes the project-global one (the Settings tab's
   * plate-type selector). Named for the override rather than the type because the two must not be
   * confused: the plate prints on `plateTypeOverride ?? <global>`, and writing the resolved value
   * back here would turn every inheriting plate into an override that outlives the next global
   * change. `ThreeMfPlate.plateType` is the resolved one; `bedTypeOverride` is what seeds this.
   */
  plateTypeOverride: string | null
  /** This plate's own print sequence, or null when it takes the global. */
  printSequence: 'by layer' | 'by object' | null
  /** Physical material order on the first layer; null lets the slicer choose. */
  firstLayerFilamentSequence: number[] | null
  /** Physical material orders for later layer ranges; null lets the slicer choose. */
  otherLayerFilamentSequences: PlateLayerFilamentSequence[] | null
  /** This plate's own vase mode, or null when it takes the global. */
  spiralMode: boolean | null
  /** Locked against arrange. Not a tri-state: there is no global lock to inherit. */
  locked: boolean
  /**
   * Bed bounds in mm; used to size the bed surface and clamp adds. `maxZ` is the machine's usable
   * height, NULL when nothing states one -- which every consumer must read as "unknown" rather
   * than as unlimited, because a fit check that silently passes on a missing height is exactly the
   * wrong answer.
   */
  bed: { minX: number; maxX: number; minY: number; maxY: number; maxZ: number | null; excludeAreas: Array<{ polygon: Array<{ x: number; y: number }>; label: string | null }> }
  instances: EditorInstance[]
  /** Prime/wipe tower footprint (plate-local), or null when the plate has no tower. */
  primeTower: LibraryThreeMfPrimeTower | null
  /**
   * The machine's layer-height band from the project, or null when it states none (apply
   * BambuStudio's default rule then, never "unlimited").
   */
  layerHeightLimits?: { min: number; max: number } | null
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

/**
 * What a plate with no settings of its own looks like: everything inherited, nothing locked.
 *
 * Spread wherever a plate is minted (the empty-project seed, the seeding fallback, the editor's
 * add-plate) so a new per-plate setting cannot reach one of those sites and miss another, which is
 * how a plate ends up with `undefined` where the contract promises a tri-state.
 */
export const INHERITED_PLATE_SETTINGS: Pick<
  EditorPlate,
  'plateTypeOverride' | 'printSequence' | 'firstLayerFilamentSequence' | 'otherLayerFilamentSequences' | 'spiralMode' | 'locked'
> = {
  plateTypeOverride: null,
  printSequence: null,
  firstLayerFilamentSequence: null,
  otherLayerFilamentSequences: null,
  spiralMode: null,
  locked: false
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

/**
 * Shared empties for the per-plate G-code sidecars.
 *
 * A `?? []` fallback returns a NEW array each call, and "this plate has none" is the common case,
 * so the sections that render them re-rendered on every unrelated edit -- the one state where they
 * have nothing to draw. Frozen so a caller cannot mutate the shared instance.
 */
const NO_FILAMENT_CHANGES: readonly EditorFilamentChange[] = Object.freeze([])
const NO_PAUSES: readonly EditorPause[] = Object.freeze([])

/** Effective filament changes for a plate: this session's override, else the seed. */
export function effectiveFilamentChanges(plate: EditorPlate): readonly EditorFilamentChange[] {
  return plate.filamentChangesOverride ?? plate.filamentChanges ?? NO_FILAMENT_CHANGES
}

/** Effective layer pauses for a plate: this session's override, else the seed. */
export function effectivePauses(plate: EditorPlate): readonly EditorPause[] {
  return plate.pausesOverride ?? plate.pauses ?? NO_PAUSES
}

/**
 * One plane cut's outputs, addressed the way the editor addresses everything before a save: by the
 * import each piece was staged as. Resolved to baked object ids by `buildSceneEdit`'s consumer.
 */
export interface EditorCutGroup {
  /** Both halves, plus one per dowel pin. */
  importIds: string[]
  /** Connectors PLACED, including any whose hole was drilled away and left no volume. */
  connectorCount: number
  connectors: Array<{
    /** The half the volume was added to. */
    importId: string
    /** The volume's own staged mesh. */
    meshImportId: string
    type: 'plug' | 'dowel' | 'snap'
    radius: number
    height: number
    radiusTolerance: number
    heightTolerance: number
  }>
}

export interface EditorState {
  /** Immutable base-file material id to live session id mapping, retained across saves and undo. */
  baseFilamentIds?: Record<number, number>
  plates: EditorPlate[]
  /** Complete managed `Auxiliaries/` state, present only after its dialog authors an edit. */
  projectAuxiliaries?: ProjectAuxiliaries
  /**
   * Per-part support-paint overrides made this session, keyed by
   * {@link supportPaintKey}. Each value is the COMPLETE desired paint map for that
   * part (triangle index in mesh order -> `paint_supports` code), seeded from the
   * source mesh's existing paint on the first brush stroke. Parts without an entry
   * keep their source paint untouched. Participates in undo/redo via
   * {@link cloneEditorState} and is emitted by {@link buildSceneEdit}.
   */
  supportPaint?: Record<string, Record<number, string>>
  /**
   * Filament physics recovered this session by the "missing material settings" repair, keyed by
   * 1-based project filament id. Present only after the user ran that repair.
   *
   * Session state rather than an immediate write, so the repair behaves like every other edit: it
   * lights up Save, it is undoable (this map is cloned by {@link cloneEditorState}, so the scene
   * checkpoint covers it), and it never touches the stored file until the user saves. Each entry is
   * a whole resolved preset config plus the preset's BINDING (its parent's name and its own
   * deltas); the bake consumes them as `SceneEditFilament.config` / `presetInherits` /
   * `presetChangedKeys`. The binding is not optional garnish, without it BambuStudio reopens a
   * slot backed by a USER preset as a `(<project>.3mf)` copy however correct its values are (see
   * `filament-preset-binding.ts`).
   *
   * ALL SLOTS OR NONE: the repair only populates this once every slot's preset resolved, because
   * the arrays it feeds are positional (see `repairs/restore-filament-physics.ts`).
   */
  repairedFilamentConfigs?: Record<number, RepairedFilamentPreset>
  /**
   * The user pressed the staged settings Repair this session: the in-editor twin of the API's
   * repair route, for hosts with no stored file behind the project (the public editor). Emitted
   * as `SceneEdit.repairSettings`; the bake applies the shared repairs while saving. Lives in the
   * undo-cloned state so undo takes the repair back and the banner returns.
   */
  settingsRepairStaged?: boolean
  /** Seam-brush counterpart of {@link EditorState.supportPaint} (`paint_seam` codes). */
  seamPaint?: Record<string, Record<number, string>>
  /** Colour-brush counterpart of {@link EditorState.supportPaint} (`paint_color` codes). */
  colorPaint?: Record<string, Record<number, string>>
  /**
   * Fuzzy-skin counterpart of {@link EditorState.supportPaint} (`paint_fuzzy_skin` codes).
   *
   * Its own map even though BambuStudio gives fuzzy skin the same VALUE as a support enforcer
   * (`FUZZY_SKIN = ENFORCER`): the 3MF attribute is separate, so one triangle can be both, and
   * sharing a map would make painting either channel erase the other.
   */
  fuzzyPaint?: Record<string, Record<number, string>>
  /**
   * Per-object manual brim-ear overrides made this session, keyed by objectId. Each
   * value is the COMPLETE desired ear set for the object (object-local mm + radius);
   * an empty array clears the object's ears. Objects without an entry keep their
   * seeded ears ({@link EditorInstance.brimEars}). Cloned by {@link cloneEditorState}
   * and merged with the seeded baseline by {@link buildSceneEdit}.
   */
  brimEars?: Record<number, EditorBrimEar[]>
  /**
   * Per-object height range overrides made this session, keyed by {@link addedPartHostId}. Each
   * value is the COMPLETE desired band set; an empty array clears the object's ranges. Objects
   * without an entry keep their seeded bands ({@link EditorInstance.heightRanges}).
   */
  heightRanges?: Record<number, EditorHeightRange[]>
  /**
   * Per-object variable layer height set this session, keyed by {@link addedPartHostId}. The value
   * is the COMPLETE desired profile; an empty array clears the object's curve.
   */
  layerHeightProfiles?: Record<number, number[]>
  /**
   * New part volumes added inside models this session (normal parts, negative parts, modifiers,
   * support blockers/enforcers), keyed by {@link addedPartHostId}, an in-project object's Bambu
   * id, or an unsaved import's synthetic object id, so a part can be added before the project has
   * ever been saved. Parts are object-level (shared by every instance). Cloned by
   * {@link cloneEditorState}; emitted by {@link buildSceneEdit} as `SceneEdit.addedParts`.
   */
  addedParts?: Record<number, EditorAddedPart[]>
  /**
   * Source SVGs added this session, keyed by the archive entry path their parts' records name.
   *
   * Held on the state rather than on each part because one artwork backs MANY parts (the tool makes
   * one part per drawn shape), so storing the markup per part would put the same bytes in the
   * archive once per mark. {@link buildSceneEdit} emits only the entries a surviving part still
   * references, so deleting every part of an artwork takes its bytes out of the next save too
   * rather than leaving an orphan entry behind for good.
   */
  svgSources?: Record<string, string>
  /**
   * Cuts made this session, so a save can tell BambuStudio the halves belong together.
   *
   * Held on the state rather than derived at save time because the CUT is the only moment the
   * relationship exists: afterwards the halves are ordinary import-backed instances with nothing
   * linking them, and a connector volume is indistinguishable from any other added part. Entries
   * whose objects have since been deleted are dropped at emit, not here, so an undo of the deletion
   * brings the cut record back with them.
   */
  cutGroups?: EditorCutGroup[]
  /**
   * Parts DELETED from models this session, keyed by {@link addedPartHostId} exactly like
   * {@link EditorState.addedParts}, holding each removed part's BASE-FILE ordinal (`partIndex`).
   *
   * Recorded rather than derived, because a removal is invisible in the emitted state: the parts
   * that remain say nothing about the ones the base file still contains, and the bake reads that
   * base. The surviving parts KEEP their stored `partIndex`: the editor never renumbers them -
   * which is what lets every other part-scoped seam go on addressing the same volumes after a
   * deletion, and is why {@link EditorInstancePart} carries `partIndex` rather than relying on its
   * array position. Emitted by {@link buildSceneEdit} as `SceneEdit.removedParts` (in-project) or
   * `SceneEdit.importRemovedParts` (a solid of an unsaved multi-solid import).
   */
  removedParts?: Record<number, number[]>
  /**
   * Independent object COPIES made this session (BambuStudio's copy/paste, as opposed to placing
   * another instance against the same objectId, which stays LINKED). Maps the copy's negative
   * placeholder object id to the in-project object it was copied from; emitted as
   * `SceneEdit.objectClones`, which the bake resolves to a real new object before applying
   * anything else. Every other session map keys the copy by that same placeholder, so a copy's
   * paint, part types, materials, added volumes and name diverge from its source for free.
   */
  objectClones?: Record<number, number>
  /**
   * In-project objects the user marked for mesh repair this session (right-click →
   * "Repair mesh"), by objectId. The repair itself runs SERVER-SIDE while baking the save
   * (`SceneEdit.repairedObjectIds` → the shared `three-mf/mesh-repair`), so there is nothing to apply
   * to the local scene: repair only merges coincident vertices and drops degenerate/duplicate
   * facets, which is visually a no-op. Marking is therefore the whole client-side edit, it
   * participates in undo/redo via {@link cloneEditorState} and is emitted by
   * {@link buildSceneEdit}. Object-level (shared by every instance), like {@link EditorState.addedParts}.
   */
  repairedObjectIds?: number[]
  /**
   * Archive entries for project-embedded filament presets the user removed this session.
   *
   * Session state, like every other edit: undoable (cloned by {@link cloneEditorState}), applied
   * only on save. See `three-mf/embedded-presets.ts` for why removal is an explicit action and why
   * a preset a slot still names is never offered.
   */
  removedEmbeddedPresets?: string[]
  /**
   * Purge volumes edited this session (the flushing-volumes dialog), or absent while the project's
   * own values stand.
   *
   * Session state like every other edit: undoable, applied only on save. Held here rather than in
   * the slice controller because it is project-FILE content, it is written into
   * `project_settings.config`, not a per-slice choice, so it must survive alongside the scene and
   * ride the same save. Sized for the material list that was on screen when it was made; the bake
   * checks it against the list it actually writes (see `applyFlushVolumes`).
   */
  flushVolumes?: SceneEditFlushVolumes
  /**
   * Per-PART process overrides made this session (process settings on one part of an object,
   * separate from the object's overall overrides), keyed by {@link partSlotKey}
   * (`objectId:partIndex`). Each value is the desired override map for that part; an empty
   * map clears it. Cloned by {@link cloneEditorState}; emitted as `SceneEdit.partProcessOverrides`.
   */
  partProcessOverrides?: Record<string, Record<string, string>>
  /**
   * Part-type changes made this session (BambuStudio's "Change type": normal/negative/
   * modifier/support blocker/enforcer), keyed by {@link partSlotKey}
   * (`objectId:partIndex`; an unsaved import keys on its synthetic object id).
   * The change is also reflected onto every instance's `part.subtype` so the list and
   * viewport re-render from one source. Cloned by {@link cloneEditorState}; emitted as
   * `SceneEdit.partTypeChanges` / `SceneEdit.importPartTypes`.
   */
  partTypeChanges?: Record<string, SceneEditPartSubtype>
  /**
   * Part-placement changes made this session (moving/rotating/scaling a part inside its
   * object with the gizmo), keyed by {@link partSlotKey} (`objectId:partIndex`).
   * Each value is the part's new OBJECT-LOCAL 3MF matrix (12 numbers, column-major 3x3 +
   * translation). The change is also reflected onto every instance's `part.transform` so
   * rebuilds and thumbnails render from one source. Cloned by {@link cloneEditorState};
   * emitted as `SceneEdit.partTransforms`.
   */
  partTransforms?: Record<string, number[]>
  /** Staged replacement mesh per base part ordinal, preserving the part's identity and metadata. */
  partMeshReplacements?: Record<string, string>
  /**
   * Part ORDER changed this session (the sidebar drag inside an object), keyed by
   * {@link addedPartHostId}. The value is the object's COMPLETE desired sequence of BASE ordinals
   * (`EditorInstancePart.partIndex`), not of array positions.
   *
   * Geometry-level, like {@link EditorState.partTransforms}: every copy of an object shares one
   * part list, so a reorder on one copy applies to all of them, and the instances' `parts` arrays
   * are re-laid to match so the sidebar and the viewport read one source. An object with no entry
   * keeps the base file's `<component>` order. Cloned by {@link cloneEditorState}; emitted as
   * `SceneEdit.partOrder` (in-project) or `SceneEdit.importPartOrder` (an unsaved import).
   */
  partOrder?: Record<number, number[]>
}

/** A new volume added inside a model this session (Bambu "Add part / negative part/..."). */
export interface EditorAddedPart {
  /** Stable client key (viewport mesh tagging + list identity). */
  key: string
  /** Staged import providing the PART's own mesh to the server at save/slice time. */
  importId: string
  subtype: SceneEditPartSubtype
  name: string
  /**
   * Filament for a part that carries one (normal parts and modifiers, per
   * `threeMfPartSubtypeCarriesFilament`). Null means "not chosen": the bake writes no
   * `extruder`, which is also the only correct state for the subtypes that carry none.
   */
  filamentId?: number | null
  /** OBJECT-LOCAL placement (mesh/rotor space). */
  position: THREE.Vector3
  rotation: THREE.Euler
  scale: THREE.Vector3
  /** Client render geometry: non-indexed triangle soup, part-local (9 floats/tri). */
  soup: Float32Array
  /** Per-volume process overrides (modifier parts), serialized config strings. */
  settings?: Record<string, string>
  /**
   * What a TEXT part was typed from. Its presence is also what marks a part as text, which is how
   * the tool knows to reopen it for editing instead of treating it as anonymous geometry.
   */
  textInfo?: TextInfo
  /**
   * What an SVG part was extruded from, and which drawn shape of the artwork it is. Marks a part as
   * SVG in exactly the way {@link EditorAddedPart.textInfo} marks one as text.
   */
  svgPart?: SvgPartRecord
  /**
   * BambuStudio's interop view of the same SVG part, present only when the import produced ONE
   * part. Never set on a member of a split import: the element describes a whole artwork, so N of
   * them would each tell Studio they are the entire drawing (see `three-mf/svg-shape.ts`).
   */
  bambuShape?: BambuStudioShape
}

/**
 * The object identity that {@link EditorState.addedParts} keys a model's added parts under: the
 * Bambu `object_id` for an in-project object, else the import's synthetic object id (see
 * {@link EditorInstanceSource}). Null for an import with no identity yet, which cannot host parts.
 *
 * One key for both cases is what lets a part be added to a model the user has not saved: the
 * emit step ({@link buildSceneEdit}) is where the two diverge again into `objectId` vs `importId`.
 */
export function addedPartHostId(instance: EditorInstance): number | null {
  if (instance.source.kind === 'object') return instance.objectId
  return instance.source.replacedObjectId ?? null
}

/**
 * The shared "no added parts" result.
 *
 * One frozen array rather than a fresh `[]` per call, because the object list's rows are memoised on
 * their props: a new empty array for every part-less instance on every render would fail the shallow
 * compare and re-render the whole list, which is exactly the cost the memo exists to remove.
 */
const NO_ADDED_PARTS: readonly EditorAddedPart[] = Object.freeze([])

/** An instance's model's added parts (object-level, shared across instances). */
export function effectiveAddedParts(state: EditorState | null, instance: EditorInstance): readonly EditorAddedPart[] {
  const hostId = addedPartHostId(instance)
  return hostId == null ? NO_ADDED_PARTS : state?.addedParts?.[hostId] ?? NO_ADDED_PARTS
}

/**
 * The ordinal an object's BODY occupies once a save promotes it to a real `<part>`.
 *
 * Zero, and not by convention: the bake's `applyAddedParts` moves an inline-mesh object's geometry
 * into its own object and makes it the FIRST `<component>`, re-keying the host's own `<part>` entry
 * onto it, and every added volume is appended after. `applyPartProcessOverrides` and
 * `applyPartTypeChanges` then count `<part>` entries positionally, and both run AFTER that
 * promotion -- so an edit the editor records against ordinal 0 today lands on the body tomorrow.
 *
 * That is what lets the body carry per-part settings and a subtype BEFORE any save, which it must:
 * a save persists bytes and changes nothing else, so a row cannot grow controls by being written to
 * disk. Only an object whose `parts` list is empty has a body row, so this can never collide with a
 * real baked part 0.
 */
export const BODY_PART_INDEX = 0

/**
 * The subtype an object's body currently carries, which lives in the same map a baked part's does.
 *
 * Read rather than stored on the instance because the body is not IN `instance.parts` until a save
 * puts it there; `partTypeChanges` is the seam that already survives to the bake.
 */
export function bodyPartSubtype(
  state: EditorState | null | undefined,
  instance: EditorInstance
): SceneEditPartSubtype {
  if (instance.bodyRemoved) return 'normal_part'
  const hostId = addedPartHostId(instance)
  if (hostId == null) return 'normal_part'
  const stored = state?.partTypeChanges?.[partSlotKey(hostId, BODY_PART_INDEX)]
  return canonicalThreeMfPartSubtype(stored ?? null)
}

/**
 * The identity an object's BODY mesh paints under, or null when the body must not be paintable.
 *
 * Null for a body the user has retyped to a HELPER VOLUME, matching the three other mesh-build
 * sites, which all gate their paint tag on `isNonRenderableThreeMfPartSubtype`. That tag is the
 * single thing that puts a mesh in the brush's raycast set, so a tagged aid CATCHES strokes aimed at
 * the geometry behind it -- and records paint the bake will never write, since a blocker or a
 * negative volume carries none.
 *
 * The body is the only one of the four that could miss the guard, because its subtype lives in
 * `partTypeChanges` rather than on a part entry that does not exist until a save.
 */
export function bodyPaintHostId(
  state: EditorState | null | undefined,
  instance: EditorInstance
): number | null {
  if (isNonRenderableThreeMfPartSubtype(bodyPartSubtype(state, instance))) return null
  return addedPartHostId(instance)
}

/**
 * Every instance placing a given object, across every plate, in plate order.
 *
 * The "walk all plates and match `addedPartHostId`" search had been open-coded four times (the
 * part-settings dialog's host lookup, the parameter table's reveal action, and twice more with the
 * host id expanded inline as `source.kind === 'object' ? objectId : replacedObjectId`). It belongs
 * here rather than in the 4k-line view, and as ONE definition, because the identity rule is the
 * subtle part: an object is addressed by {@link addedPartHostId}, never by a bare `objectId`, or
 * the lookup silently misses every unsaved import and every independent copy.
 *
 * Returns several instances for a linked-copy object: they are placements of ONE object, so a
 * caller wanting "the object" takes the first and a caller wanting "where it is" needs them all.
 */
export function instancesForObject(
  state: EditorState | null | undefined,
  objectId: number
): EditorInstance[] {
  const found: EditorInstance[] = []
  for (const plate of state?.plates ?? []) {
    for (const instance of plate.instances) {
      if (addedPartHostId(instance) === objectId) found.push(instance)
    }
  }
  return found
}

/**
 * The plate an object should be revealed on, and the instance to select there.
 *
 * Prefers an instance on the plate ALREADY on screen, so revealing an object placed on several
 * plates does not move the user off the one they were looking at to show them the same object
 * somewhere else. Null when no instance places the object.
 */
export function locateObjectForReveal(
  state: EditorState | null | undefined,
  objectId: number,
  preferredPlateIndex: number
): { instance: EditorInstance; plateIndex: number } | null {
  for (const plate of state?.plates ?? []) {
    for (const instance of plate.instances) {
      if (addedPartHostId(instance) !== objectId) continue
      if (plate.index === preferredPlateIndex) return { instance, plateIndex: plate.index }
    }
  }
  for (const plate of state?.plates ?? []) {
    for (const instance of plate.instances) {
      if (addedPartHostId(instance) === objectId) return { instance, plateIndex: plate.index }
    }
  }
  return null
}

/**
 * Which volume rows an object lists, which is BambuStudio's rule: a row per volume as soon as the
 * object has TWO, and none at one (`ObjectList` rebuilds the children over every volume on a
 * split/add and folds them away again on delete).
 *
 * ONE definition, because the count is not `instance.parts.length`. An object's volumes are its
 * baked parts PLUS the volumes added this session, and where the part list is empty its body is a
 * volume too. Three sites used to derive this from `parts.length` alone, which is what made an
 * object with one baked part and one added volume list only the added one: the baked part lost its
 * name, material, type menu, settings and menu, and the same object grew all of them back on the
 * next save, when the added volume became a second baked part. That is a SAVE BOUNDARY showing
 * through, and the part-is-a-part rule in this plugin's development notes says it must not.
 *
 * `showBodyRow` is separate rather than derived by the caller because the body earns a row only
 * where the part list does not already describe it: an object WITH parts lists its body among them
 * (which is why `cat-hs` shows a `cat-hs.stl` row), so adding one there would double-count the
 * geometry.
 */
export function instanceVolumeRows(
  instance: EditorInstance,
  addedPartCount: number
): { showRows: boolean; showBodyRow: boolean; cutConnectorCount: number } {
  // Cut connectors are NOT volume rows. BambuStudio leaves them out of the count that decides
  // whether an object gets rows at all and skips them in the row loop
  // (`can_add_volumes_to_object` / `add_volumes_to_object_in_list`, `GUI_ObjectList.cpp:4485`),
  // showing one "Cut connectors" row instead. Counting them made a cut half read as a two-volume
  // object: an object row, a body row carrying the SAME name, and a row per peg.
  const cutConnectorCount = instance.parts.filter((part) => part.cutConnector).length
  const bakedVolumeCount = instance.parts.length - cutConnectorCount
  // A DELETED body is not a volume: the object's added parts are its whole geometry, exactly as
  // they are in the file the save writes.
  const showBodyRow = bakedVolumeCount === 0 && !instance.bodyRemoved && addedPartCount > 0
  return {
    showRows: bakedVolumeCount + addedPartCount + (showBodyRow ? 1 : 0) > 1,
    showBodyRow,
    cutConnectorCount
  }
}

/** One manual brim ear in object-local coordinates. */
export interface EditorBrimEar {
  x: number
  y: number
  z: number
  radius: number
}

/**
 * One height range modifier: a Z band in OBJECT space (z=0 at the object's underside) whose
 * process-setting overrides apply to the layers inside it, `[minZ, maxZ)`.
 */
export interface EditorHeightRange {
  minZ: number
  maxZ: number
  settings: Record<string, string>
}

/** Deep-copy a band, so an undo snapshot never shares its settings map with live state. */
export function cloneHeightRange(range: EditorHeightRange): EditorHeightRange {
  return { minZ: range.minZ, maxZ: range.maxZ, settings: { ...range.settings } }
}

/** Effective ears for an instance's object: this session's override, else the seed. */
export function effectiveBrimEars(state: EditorState | null, instance: EditorInstance): EditorBrimEar[] {
  // Keyed by the model's editor identity, so an unsaved import can carry ears too (they emit as
  // `importBrimEars`). Only an in-project object has SEEDED ears, an import has none in the file.
  const hostId = addedPartHostId(instance)
  if (hostId == null) return []
  const override = state?.brimEars?.[hostId]
  return override ?? instance.brimEars ?? []
}

/** Effective height ranges for an instance's object: this session's override, else the seed. */
export function effectiveHeightRanges(state: EditorState | null, instance: EditorInstance): EditorHeightRange[] {
  // Same identity rule as brim ears: an unsaved import can carry bands too (they emit as
  // `importHeightRanges`), and only an in-project object has seeded ones.
  const hostId = addedPartHostId(instance)
  if (hostId == null) return []
  const override = state?.heightRanges?.[hostId]
  return override ?? instance.heightRanges ?? []
}

/** Effective layer height profile for an instance's object: this session's override, else the seed. */
export function effectiveLayerHeightProfile(state: EditorState | null, instance: EditorInstance): number[] {
  const hostId = addedPartHostId(instance)
  if (hostId == null) return []
  const override = state?.layerHeightProfiles?.[hostId]
  return override ?? instance.layerHeightProfile ?? []
}

/** Key for {@link EditorState.supportPaint}: paint is shared per object part. */
export function supportPaintKey(objectId: number, componentObjectId: number): string {
  return `${objectId}:${componentObjectId}`
}

/**
 * Paint key for a SESSION-ADDED volume, whose mesh is a staged import rather than an entry in the
 * base file.
 *
 * Keyed by the volume's own `meshImportId` and not by an object/component pair, because it has
 * neither until a save: the bake allocates the mesh an object id itself. That importId is also
 * exactly what the emitted `importPaint` entry names, so the client key and the wire key are the
 * same fact and cannot drift.
 *
 * The `import:` prefix cannot collide with {@link supportPaintKey}, whose halves are both numbers.
 * Unlike an added part's `key`, an importId is minted by the import store rather than being user
 * data, so the prefix is not forgeable.
 *
 * A volume's mesh is its own -- nothing else references it -- so unlike baked parts there is no
 * mesh-sharing to model here; one volume, one key.
 */
export function addedPartPaintKey(meshImportId: string): string {
  return `import:${meshImportId}`
}

/** The importId a paint key names, or null when it keys a baked part instead. */
export function addedPartPaintImportId(key: string): string | null {
  return key.startsWith('import:') ? key.slice('import:'.length) : null
}

/**
 * Key for the ORDINAL-scoped per-part session maps: `partTransforms`, `partTypeChanges`,
 * `partProcessOverrides`. Deliberately separate from {@link supportPaintKey} despite the identical
 * string shape: paint is a property of the MESH (parts sharing a mesh share their paint, which is
 * BambuStudio's behaviour), while placement/type/process belong to the individual volume and must
 * not bleed between parts that happen to reference the same mesh.
 */
export function partSlotKey(objectId: number, partIndex: number): string {
  return `${objectId}:${partIndex}`
}

/** Inverse of {@link partSlotKey}; null when the key is malformed. */
export function parsePartSlotKey(key: string): { objectId: number; partIndex: number } | null {
  const [objectPart, indexPart] = key.split(':')
  const objectId = Number(objectPart)
  const partIndex = Number(indexPart)
  if (!Number.isInteger(objectId) || !Number.isInteger(partIndex) || partIndex < 0) return null
  return { objectId, partIndex }
}

const DEFAULT_BED = { minX: -128, maxX: 128, minY: -128, maxY: 128, maxZ: null as number | null, excludeAreas: [] as Array<{ polygon: Array<{ x: number; y: number }>; label: string | null }> }

/** Generate a unique, stable key for an editor instance. */
export function nextInstanceKey(): string {
  return randomUUID()
}

let plateIdCounter = 0
/** Allocate a session-unique plate identity (see {@link EditorPlate.plateId}). Never reused. */
export function mintPlateId(): number {
  plateIdCounter += 1
  return plateIdCounter
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
 * rotation: `world = translate · scale · rotate`), which is how the editor renders (outer
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
    ...(instance.cutId != null ? { cutId: instance.cutId } : {}),
    ...(instance.heightRanges && instance.heightRanges.length > 0
      ? { heightRanges: instance.heightRanges.map((range) => ({ ...range, settings: { ...range.settings } })) }
      : {}),
    ...(instance.layerHeightProfile && instance.layerHeightProfile.length > 0
      ? { layerHeightProfile: [...instance.layerHeightProfile] }
      : {}),
    parts: instance.parts.map((part, partIndex) => {
      const info = partInfo.get(partInfoKey(part.entryPath, part.componentObjectId))
      // Object-material inheritance is for PRINTED parts only. A support blocker/enforcer or
      // negative volume has no material at all, and a modifier's is "default" until the user
      // assigns one (BambuStudio writes extruder 0 for every helper volume). Inheriting here is
      // what put a filament swatch on a blocker in the sidebar and, worse, baked that extruder
      // back into its `<part>` metadata on the next save.
      const subtype = part.subtype ?? null
      const inherited = isNonRenderableThreeMfPartSubtype(subtype) ? null : instance.filamentId
      const carriesFilament = threeMfPartSubtypeCarriesFilament(subtype)
      return {
        entryPath: part.entryPath,
        componentObjectId: part.componentObjectId,
        partIndex,
        transform: [...part.transform],
        filamentId: carriesFilament ? info?.filamentId ?? inherited : null,
        name: info?.name ?? null,
        color: carriesFilament ? info?.color ?? (inherited != null ? instance.color : null) : null,
        subtype,
        ...(part.textInfo ? { textInfo: part.textInfo } : {}),
        ...(part.svgPart ? { svgPart: part.svgPart } : {}),
        // Carried from `cut_information.xml`, which is what lets a SAVED cut's connectors keep
        // behaving like connectors instead of reading as ordinary volumes on reopen.
        ...(part.cutConnector ? { cutConnector: true as const } : {})
      }
    })
  }
}

/** Seed an empty new-project state: a single empty plate, no instances. */
export function seedEmptyEditorState(): EditorState {
  return {
    plates: [{ index: 1, plateId: mintPlateId(), sourcePlateIndex: null, name: null, ...INHERITED_PLATE_SETTINGS, bed: { ...DEFAULT_BED }, instances: [], primeTower: null }]
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
    // filament isn't a property of the shared mesh: neutralize it so each editor
    // part falls back to its instance's filament/color instead of whichever row
    // happened to come last (which painted every copy the same colour AND would
    // have rewritten every object's extruder to that filament on save).
    if (existing.filamentId !== part.filamentId) existing.filamentId = null
    if (existing.color !== part.color) existing.color = null
  }
  return {
    ...plate,
    bed: { minX: scene.bed.minX, maxX: scene.bed.maxX, minY: scene.bed.minY, maxY: scene.bed.maxY, maxZ: scene.bed.maxZ, excludeAreas: scene.bed.excludeAreas },
    instances: scene.instances.map((instance) => instanceFromScene(instance, partInfo)),
    primeTower: scene.primeTower ?? null,
    layerHeightLimits: scene.layerHeightLimits ?? null,
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
 * seed empty and can be filled later via {@link fillPlateFromScene}, but they borrow
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
        maxZ: loadedScene.bed.maxZ,
        excludeAreas: loadedScene.bed.excludeAreas
      }
    : DEFAULT_BED
  const plates: EditorPlate[] = index.plates.map((plate) => {
    const scene = scenesByPlate.get(plate.index)
    const base: EditorPlate = {
      index: plate.index,
      plateId: mintPlateId(),
      sourcePlateIndex: plate.index,
      name: plate.name ?? null,
      // The plate's OWN settings, never its resolved ones: `plate.plateType` is the effective bed
      // type (own, else the project-global), and seeding the session from it would re-save the
      // global as N per-plate overrides the user never asked for.
      plateTypeOverride: plate.bedTypeOverride ?? null,
      printSequence: plate.printSequence ?? null,
      firstLayerFilamentSequence: plate.firstLayerFilamentSequence ? [...plate.firstLayerFilamentSequence] : null,
      otherLayerFilamentSequences: plate.otherLayerFilamentSequences
        ? plate.otherLayerFilamentSequences.map((range) => ({ ...range, filamentIds: [...range.filamentIds] }))
        : null,
      spiralMode: plate.spiralMode ?? null,
      locked: plate.locked ?? false,
      bed: { ...fallbackBed },
      instances: [],
      primeTower: null
    }
    return scene ? fillPlateFromScene(base, scene) : base
  })

  if (plates.length === 0) {
    plates.push({ index: 1, plateId: mintPlateId(), sourcePlateIndex: null, name: null, ...INHERITED_PLATE_SETTINGS, bed: { ...DEFAULT_BED }, instances: [], primeTower: null })
  }

  const partProcessOverrides = collectPartProcessOverridesFromScenes(scenesByPlate)
  return {
    // Normalised across the whole list, not per plate: see `normalizePlateObjectOrder`.
    plates: normalizePlateObjectOrder(reindexPlates(plates)),
    ...(Object.keys(partProcessOverrides).length > 0 ? { partProcessOverrides } : {})
  }
}

/**
 * The LIVE plate index the editor should open on, given the preferred SOURCE plate index.
 *
 * The two spaces differ: `preferredSourceIndex` is the archive's own numbering (what the baked
 * index and the host's plate pre-selection speak), while seeded plates are POSITIONAL after
 * {@link reindexPlates}. They coincide for the usual 1..n-contiguous archive, which is what let
 * the seed effect assign the source index directly for so long, until a file whose plate list
 * does not start at 1 (Bambu's per-plate "export sliced file" writes only the exported plate,
 * keeping its number) selected a live index that no seeded plate has, and the editor sat on
 * "Loading plates…" forever with the state fully seeded behind it.
 */
export function seededActivePlateIndex(plates: EditorPlate[], preferredSourceIndex: number | null): number {
  const preferred = preferredSourceIndex !== null
    ? plates.find((plate) => plate.sourcePlateIndex === preferredSourceIndex)
    : undefined
  return preferred?.index ?? plates[0]?.index ?? 1
}

/**
 * Re-hydrate per-part PROCESS overrides from saved scenes, keyed by {@link partSlotKey}
 * (`objectId:partIndex`). Mirrors the object-level re-hydration: the editor's per-part gear shows
 * what the 3MF already carries so a reopened project keeps its part-scoped settings instead of
 * starting blank.
 *
 * The ordinal is the part's POSITION in the scene's list, which is the same number
 * {@link instanceFromScene} stamps as `partIndex` -- so the seed and the live edits address one
 * space. It used to key on `componentObjectId`, the MESH id, which reads as an ordinal only on an
 * object whose volumes happen to be numbered from zero: everywhere else a reopened project put its
 * saved per-part settings on the wrong volume, silently, and the gear's count agreed with the
 * misplacement.
 */
export function collectPartProcessOverridesFromScenes(
  scenesByPlate: Map<number, LibraryThreeMfScene>
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const scene of scenesByPlate.values()) {
    for (const instance of scene.instances) {
      instance.parts.forEach((part, partIndex) => {
        if (!part.processOverrides || Object.keys(part.processOverrides).length === 0) return
        const key = partSlotKey(instance.objectId, partIndex)
        if (out[key]) return
        out[key] = { ...part.processOverrides }
      })
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
export function instanceFromStagedImport(
  staged: StagedImport,
  meshUrl: ImportMeshUrlResolver = importMeshUrl
): EditorInstance {
  // `staged.parts` always lists ≥1 solid; only treat it as multi-part when there is
  // more than one (a single-solid import keeps the simpler one-mesh render path).
  const parts: EditorInstancePart[] = staged.parts.length > 1
    ? staged.parts.map((part, index) => ({
        // For an unsaved import, parts have no baked 3MF ids yet: `entryPath` marks the
        // import and `componentObjectId` is the solid's index (a stable client key).
        entryPath: `import:${staged.importId}`,
        componentObjectId: index,
        partIndex: index,
        transform: IDENTITY_PART_TRANSFORM.slice(),
        filamentId: null,
        name: part.name,
        color: null,
        // A 3MF source carries its volume types in (BambuStudio's Import Object keeps them), so an
        // imported support blocker renders and lists as an aid rather than printed geometry. The
        // BAKE reads the subtype from the staged record, not from here, this is the client's copy.
        subtype: part.subtype ?? null
      }))
    : []
  return {
    key: nextInstanceKey(),
    // A synthetic object identity so the import's per-object process + per-part filament are
    // editable immediately, before any save (see {@link EditorInstanceSource}).
    source: { kind: 'import', importId: staged.importId, meshUrl: meshUrl(staged.importId), replacedObjectId: nextSyntheticObjectId() },
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

/**
 * The XY footprint of a staged import: where its centre sits in MESH coordinates, and how big it
 * is. An import keeps its file coordinates (origin is often a corner, not the centre), so placement
 * needs both: the centre to drop the model centred on a free spot, and the size to pick a spot
 * that actually fits it clear of what's already on the plate.
 */
export function stagedFootprint(staged: StagedImport): {
  center: { x: number; y: number }
  size: { width: number; depth: number }
} {
  const { min, max } = staged.bounds
  return {
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 },
    size: { width: Math.abs(max.x - min.x), depth: Math.abs(max.y - min.y) }
  }
}

/** Identity 12-element (column-major 3x3 + translation) part transform. */
const IDENTITY_PART_TRANSFORM = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

/**
 * Seat a replacement so its RENDERED centre lands on the old object's footprint centre, resting on
 * the bed: BambuStudio's `center_around_origin()` + `ensure_on_bed()` outcome for a replace.
 *
 * The subtlety is the rotation, and it is what a naive `position = oldCentre` gets wrong.
 * `position` places the object's local ORIGIN, and a staged import's origin is its XY centre with
 * its lowest point at z = 0, so the origin is the centre in X and Y but the FLOOR in Z. Inherit a
 * rotation from the old object and that un-centred axis turns into the plane: a -90 degrees X
 * rotation maps local z onto world y, so the origin ends up at the EDGE of the rotated footprint
 * and the model lands half a body-length away, its edge on the old centre.
 *
 * So the centre offset is measured in the object's own frame and rotated with it, which is exactly
 * what Studio does: `new_volume->translate(get_transformation().get_matrix(true) * (new mesh_offset
 * - old mesh_offset))`, where `get_matrix(true)` is the matrix WITHOUT translation, i.e. R * S.
 *
 * Z is solved from the same transformed box rather than inherited: after an inherited rotation the
 * mesh's floor is no longer at z = 0, so keeping the source's z would sink or float the model until
 * the user happened to drag it (`restObjectOnBed` runs on drag end, not on replace).
 *
 * Mutates `instance.position`. Its rotation and scale must already be set.
 */
function placeReplacementOnOldFootprint(
  instance: EditorInstance,
  staged: StagedImport,
  centerOn: { x: number; y: number }
): void {
  const { min, max } = staged.bounds
  const basis = new THREE.Matrix4()
    .makeRotationFromEuler(instance.rotation)
    .scale(instance.scale)
  const rotated = new THREE.Box3()
  // Every corner, not just min/max: rotating an AABB's two extreme corners does not bound the
  // rotated box (the other six can stick out further), which is the same trap `printableMeshBox`
  // documents for its cheap path.
  for (const x of [min.x, max.x]) {
    for (const y of [min.y, max.y]) {
      for (const z of [min.z, max.z]) {
        rotated.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(basis))
      }
    }
  }
  const centre = rotated.getCenter(new THREE.Vector3())
  // `-0` when the box already sits on the bed: harmless arithmetically, but it reaches the saved
  // transform and the readout panel, so normalise it away.
  const restOnBed = rotated.min.z === 0 ? 0 : -rotated.min.z
  instance.position.set(centerOn.x - centre.x, centerOn.y - centre.y, restOnBed)
}

/**
 * Replace an instance's geometry with a freshly staged foreign model while keeping the
 * object in place, like BambuStudio's "Replace with…": the new mesh inherits the old
 * instance's placement (position/rotation/scale), material (`filamentId`), printability,
 * and NAME. The result is import-backed (like Cut/Split outputs) with a NEW key.
 *
 * MATERIAL is object-level only, and deliberately so: the replacement's solids are unrelated to the
 * old object's parts, so per-part assignments cannot be carried and every new solid starts
 * unassigned, INHERITING this one value at bake time (see `effectivePartFilamentId`). The value
 * itself falls back past the consensus for a mixed-material source; both halves matter, because
 * between them they are the whole of "the material was kept".
 *
 * When `replacedObjectId` is given (replacing an in-project object), the object's identity
 * is retained for the slicer: the import carries `replacedObjectId` so {@link buildSceneEdit}
 * emits a `meshReplacements` entry and the object's per-object PROCESS overrides + name
 * follow onto the baked replacement. Attributes tied to the OLD geometry, in-project parts,
 * brim ears, and paint, do not carry over, since the new mesh is unrelated to the old shape.
 */
export function replaceInstanceGeometry(
  source: EditorInstance,
  staged: StagedImport,
  replacedObjectId?: number,
  meshUrl: ImportMeshUrlResolver = importMeshUrl,
  /**
   * Where the object being replaced actually SITS: the world XY centre of its printable mesh.
   *
   * Needed because `position` places an object's local ORIGIN, and the two coincide for a staged
   * import (normalised to its own centre, see `ImportNormalization`) but not for an in-project
   * Bambu object, whose mesh routinely carries plate coordinates. Copying `source.position` across
   * therefore drops the replacement's CENTRE onto the original's ORIGIN and the model jumps by the
   * difference. Null (an instance with no live group, e.g. on a non-active plate) keeps the
   * source's own placement, which is the best available answer rather than a guessed one.
   */
  centerOn?: { x: number; y: number } | null,
  /**
   * Volume types to re-apply to the replacement's solids by index ({@link carriedPartSubtypes}).
   * Opt-in rather than derived here, because the other callers of this function (Cut/Split, the
   * text tool) produce genuinely NEW geometry whose names carry no such correspondence.
   */
  carriedSubtypes?: ReadonlyMap<number, SceneEditPartSubtype>
): EditorInstance {
  const next = instanceFromStagedImport(staged, meshUrl)
  if (carriedSubtypes?.size) {
    next.parts = next.parts.map((part, index) => {
      const subtype = carriedSubtypes.get(index)
      return subtype ? { ...part, subtype } : part
    })
  }
  next.source = {
    kind: 'import',
    importId: staged.importId,
    meshUrl: meshUrl(staged.importId),
    // Keep the replaced object's identity; for an import without one, keep a fresh synthetic id
    // so the replacement is still per-object editable before a save.
    replacedObjectId: replacedObjectId ?? (next.source.kind === 'import' ? next.source.replacedObjectId : undefined)
  }
  next.position.copy(source.position)
  next.rotation.copy(source.rotation)
  next.scale.copy(source.scale)
  if (centerOn) placeReplacementOnOldFootprint(next, staged, centerOn)
  // The replacement's own solids all start unassigned, so this object-level value is the ONLY thing
  // carrying the material forward, and `source.filamentId` alone is not enough to do it: it is a
  // CONSENSUS over the printed parts (`scene-parser.ts`), so an object whose parts disagree - a body
  // on one material with labels on another - reports null. Leaving it null hands the decision to the
  // bake, which binds an unassigned import to filament 1, i.e. a multi-material object silently
  // comes back on the project's first material. Fall back to the leading printed part instead: the
  // parts cannot be mapped onto unrelated geometry, but the object's own first material is a far
  // better answer than the engine's default, and it is the one the user sees on the object row.
  next.filamentId = source.filamentId ?? printedParts(source)[0]?.filamentId ?? null
  next.printable = source.printable
  // Keep the object's name as part of its retained identity. Mark it overridden so it is
  // emitted (and applied to the baked import) rather than falling back to the new file name.
  next.name = source.name
  next.nameOverridden = true
  return next
}

/**
 * Forget the added part volumes of a model whose geometry is being replaced.
 *
 * A replacement RETAINS the object identity ({@link EditorInstanceSource.replacedObjectId}), which
 * is the same key {@link EditorState.addedParts} uses, so without this the old shape's blockers
 * and modifiers would silently reattach to an unrelated mesh at their old coordinates. Paint and
 * brim ears fall away on their own (they key on parts the replacement doesn't have); this is the
 * explicit counterpart for parts, and the reason {@link replaceInstanceGeometry}'s contract can
 * say the old shape's attributes do not carry over.
 */
export function dropAddedPartsForReplacedHost(state: EditorState, instance: EditorInstance): void {
  const hostId = addedPartHostId(instance)
  if (hostId == null) return
  if (state.addedParts?.[hostId]) delete state.addedParts[hostId]
  // Part DELETIONS are keyed by the same retained identity and are just as dangerous, in the
  // opposite direction: a removal recorded against the old shape's ordinals resolves to the
  // REPLACEMENT once the host is import-backed, so "delete part 1, then replace the object" would
  // silently drop solid 1 of the new mesh. The old object's parts are gone with its geometry, so
  // there is nothing left for those ordinals to mean.
  if (state.removedParts?.[hostId]) delete state.removedParts[hostId]
}

/**
 * The volume TYPES a replacement should inherit from the object it replaces, by solid index.
 *
 * Replace exists mainly to swap in a revised export of the SAME model, and a modifier or support
 * blocker is a slicing decision about a named piece of that model, not a property of its triangles.
 * Losing them turns five "Hole modifier" volumes into printed geometry, silently and destructively.
 * BambuStudio does not have this problem because its "Replace with…" swaps ONE volume's mesh and
 * keeps that volume's config; our whole-object replace rebuilds the parts, so the types have to be
 * carried deliberately.
 *
 * Matched by NAME, in occurrence order, which is the only correspondence that is actually evidence:
 * position alone would silently mis-assign a reordered export, and matching nothing at all is what
 * this fixes. Duplicate names (a model really can carry two "Cylinder size label 2") pair up first
 * to first, second to second.
 *
 * A solid the import ALREADY typed wins: a 3MF carries its volume types, and the file being
 * imported is better evidence than the file being replaced. Only helper types are carried, since
 * `normal_part` is the default a new solid already has.
 */
export function carriedPartSubtypes(
  previousParts: ReadonlyArray<{ name?: string | null; subtype?: string | null }>,
  stagedParts: ReadonlyArray<{ name?: string | null; subtype?: string | null }>
): Map<number, SceneEditPartSubtype> {
  const byName = new Map<string, SceneEditPartSubtype[]>()
  for (const part of previousParts) {
    const name = part.name?.trim()
    if (!name) continue
    const subtype = canonicalThreeMfPartSubtype(part.subtype ?? null)
    if (subtype === 'normal_part') continue
    const queue = byName.get(name) ?? []
    queue.push(subtype)
    byName.set(name, queue)
  }
  if (byName.size === 0) return new Map()

  const carried = new Map<number, SceneEditPartSubtype>()
  const consumed = new Map<string, number>()
  stagedParts.forEach((part, index) => {
    if (canonicalThreeMfPartSubtype(part.subtype ?? null) !== 'normal_part') return
    const name = part.name?.trim()
    if (!name) return
    const queue = byName.get(name)
    if (!queue) return
    const taken = consumed.get(name) ?? 0
    const subtype = queue[taken]
    if (!subtype) return
    consumed.set(name, taken + 1)
    carried.set(index, subtype)
  })
  return carried
}

/**
 * Whether an object still has printed geometry after removing `partIndexes`.
 *
 * An object whose every printed part is gone is not something BambuStudio can open: helper volumes
 * alone describe nothing to print: so the last one cannot be deleted. The user's route to that
 * outcome is deleting the OBJECT, which is a different action with different consequences (its
 * instances, overrides and paint go too) and should not be reachable by accident from a part row.
 */
export function canRemoveParts(
  instance: EditorInstance,
  partIndexes: ReadonlySet<number>,
  /**
   * Printed geometry the object will still hold that is NOT one of its baked parts: session-added
   * volumes, plus anything the caller is adding in the same commit (a boolean's result replacing the
   * parts it consumed). Both count, because "does this object still print something" is a question
   * about the object as the user sees it, not about which volumes happen to exist in the base file.
   * Omitting it is what made a boolean over an object's only printed part refuse, and what stopped
   * an object whose printed geometry is a session-added primitive from dropping its baked part.
   */
  otherPrintedParts = 0
): boolean {
  const printed = printedParts(instance)
  if (printed.length === 0) return otherPrintedParts > 0
  return printed.some((part) => !partIndexes.has(part.partIndex)) || otherPrintedParts > 0
}

/**
 * Delete parts from a model, on EVERY instance of it and on every plate.
 *
 * Parts are object-level, like their materials and types, so a deletion is geometry-level too: it
 * applies to every copy of the object, matching what the sidebar promises about linked copies.
 *
 * Two things happen, and both are needed. The parts are dropped from the live instances so the
 * viewport and sidebar stop showing them, and their BASE ordinals are recorded in
 * {@link EditorState.removedParts} so the bake removes them from the file. Survivors keep their own
 * `partIndex` untouched: nothing is renumbered: which is what keeps every other part-scoped edit
 * pointing at the volume it was made against.
 *
 * Returns a NEW state, or null (changing nothing) when the host owns no such parts or the removal
 * would leave the object with no printed geometry.
 */
export function withRemovedParts(
  state: EditorState,
  hostId: number,
  partIndexes: ReadonlySet<number>,
  /**
   * Printed volumes the object will hold after this call that are not baked parts: added volumes it
   * already has, MINUS any the caller is removing alongside, PLUS any it is adding in the same
   * commit. Defaults to counting what is already there, which is the answer for every caller that
   * only deletes.
   */
  otherPrintedParts?: number
): EditorState | null {
  if (partIndexes.size === 0) return null
  const host = state.plates
    .flatMap((plate) => plate.instances)
    .find((instance) => addedPartHostId(instance) === hostId)
  if (!host) return null
  const survivingAdded = otherPrintedParts ?? effectiveAddedParts(state, host)
    .filter((part) => !isNonRenderableThreeMfPartSubtype(part.subtype)).length
  if (!canRemoveParts(host, partIndexes, survivingAdded)) return null

  const plates = state.plates.map((plate) => ({
    ...plate,
    instances: plate.instances.map((instance) => (addedPartHostId(instance) === hostId
      ? { ...instance, parts: instance.parts.filter((part) => !partIndexes.has(part.partIndex)) }
      : instance))
  }))
  const existing = state.removedParts?.[hostId] ?? []
  // Drop the removed ordinals from any recorded ORDER too, so the two records describe the same
  // set of volumes. BambuStudio has no separate order to go stale -- `ModelObject::volumes` IS the
  // order, and a delete is an erase from it -- and this is the closest we get: without the prune,
  // "reorder then delete" emits an order naming a volume that no longer exists while "delete then
  // reorder" emits one that omits it, two payloads for one end state that the bake then has to be
  // correct for twice.
  const recordedOrder = state.partOrder?.[hostId]
  const prunedOrder = recordedOrder?.filter((index) => !partIndexes.has(index))
  return {
    ...state,
    plates,
    removedParts: {
      ...(state.removedParts ?? {}),
      [hostId]: [...existing, ...[...partIndexes].filter((index) => !existing.includes(index))]
    },
    // An order of fewer than two volumes says nothing, so it is dropped rather than kept as an
    // entry every collector then has to skip.
    ...(prunedOrder
      ? { partOrder: prunedOrder.length > 1
        ? { ...state.partOrder, [hostId]: prunedOrder }
        : Object.fromEntries(Object.entries(state.partOrder ?? {}).filter(([key]) => Number(key) !== hostId)) }
      : {})
  }
}

/**
 * Put an instance's placement at (x, y) on the plate, keeping a SHEARING instance intact.
 *
 * `position` is only the decomposed mirror of such an instance's placement: while
 * {@link EditorInstance.exactMatrix} is set, that matrix is what the viewport renders (EditorView's
 * group build copies it verbatim) and what `buildSceneEdit` emits, so writing `position` alone
 * moves nothing and leaves the two disagreeing about where the object is. Shift the matrix's
 * translation by the same delta and both stay true.
 *
 * For placing geometry that is NEW to the plate: a duplicate, a paste, a fill-bed copy, the
 * single-object export's re-centre. A user MOVE of an existing shearing object is deliberately the
 * opposite rule -- the gizmo (`bakeExactMatrix`) and auto-arrange DROP the matrix and bake the
 * object down to T-S-R, because an edit to the transform is exactly when the editor takes ownership
 * of it. Nothing here is an edit, so nothing here may deform the shape it is placing.
 */
export function placeInstanceAt(instance: EditorInstance, x: number, y: number): void {
  const dx = x - instance.position.x
  const dy = y - instance.position.y
  instance.position.set(x, y, instance.position.z)
  if (!instance.exactMatrix) return
  // 12-element column-major: 3x3 linear part, then the translation. Only the translation moves,
  // so the shear the matrix exists to preserve survives the placement.
  instance.exactMatrix[9] = (instance.exactMatrix[9] ?? 0) + dx
  instance.exactMatrix[10] = (instance.exactMatrix[10] ?? 0) + dy
}

/**
 * Replace a plate's bed while preserving every item's offset from the physical bed centre.
 *
 * Printer changes must translate the arrangement, never scale or re-arrange it. Instances are
 * copied before placement because {@link placeInstanceAt} also updates an exact shear matrix in
 * place. The prime tower shares the plate-local coordinate frame and follows the same translation.
 * Applying the inverse bed change restores the original coordinates, which keeps target-model
 * changes compatible with the editor's undo/redo history.
 */
export function movePlateContentsToBed(
  plate: EditorPlate,
  bed: EditorPlate['bed']
): EditorPlate {
  const dx = (bed.minX + bed.maxX - plate.bed.minX - plate.bed.maxX) / 2
  const dy = (bed.minY + bed.maxY - plate.bed.minY - plate.bed.maxY) / 2
  if (dx === 0 && dy === 0) return { ...plate, bed }

  const instances = plate.instances.map((instance) => {
    const moved = {
      ...instance,
      position: instance.position.clone(),
      ...(instance.exactMatrix ? { exactMatrix: [...instance.exactMatrix] } : {})
    }
    placeInstanceAt(moved, moved.position.x + dx, moved.position.y + dy)
    return moved
  })

  return {
    ...plate,
    bed,
    instances,
    primeTower: plate.primeTower
      ? { ...plate.primeTower, x: plate.primeTower.x + dx, y: plate.primeTower.y + dy }
      : null
  }
}

/**
 * Deep-clone an instance (for duplicate), offsetting it clear of the source.
 *
 * Copied WHOLE, then overridden, on the same rule as {@link cloneEditorState}: a copy is the same
 * OBJECT placed again, so the object-level fields seeded from the file (`brimEars`, `heightRanges`,
 * `layerHeightProfile`, and the authoring records) are the copy's too, and a re-listing that forgot
 * one silently produced a copy that had lost them. That is not merely a display difference: the
 * seeds are the baseline every `collect*` emitter reads through {@link effectiveBrimEars} and
 * friends, and those take the FIRST instance they find for an object -- so a stripped copy could
 * make the next save write an empty ear/band/profile set over what the file already carried.
 *
 * That includes `exactMatrix`, which used to be dropped so the copy could be placed by writing
 * `position` (three call sites relied on it). Dropping it is what MAKES the copy different from
 * what was copied: the matrix is kept only when T-S-R provably cannot reproduce the source
 * placement, so a copy without it renders and saves as the approximation, and Ctrl+D on a rotated,
 * non-uniformly scaled foreign object returned a subtly reshaped object with nothing logged.
 * Placement goes through {@link placeInstanceAt} instead, which moves both.
 *
 * The offset is a FALLBACK, not the placement: every caller (duplicate, paste, fill bed) picks a
 * free spot and places the copy itself. It only decides where a copy lands for a caller that does
 * not, and stops that case from stacking the copy invisibly on its source.
 */
export function duplicateInstance(instance: EditorInstance): EditorInstance {
  const copy: EditorInstance = {
    ...instance,
    key: nextInstanceKey(),
    source: instance.source.kind === 'import' ? { ...instance.source } : { kind: 'object' },
    position: instance.position.clone(),
    rotation: instance.rotation.clone(),
    scale: instance.scale.clone(),
    // Copied, never shared: `placeInstanceAt` writes into this array in place, so a shared one
    // would move the source every time the copy was placed.
    ...(instance.exactMatrix ? { exactMatrix: [...instance.exactMatrix] } : {}),
    ...(instance.brimEars ? { brimEars: instance.brimEars.map((ear) => ({ ...ear })) } : {}),
    ...(instance.heightRanges ? { heightRanges: instance.heightRanges.map(cloneHeightRange) } : {}),
    ...(instance.layerHeightProfile ? { layerHeightProfile: [...instance.layerHeightProfile] } : {}),
    parts: instance.parts.map((part) => ({ ...part, transform: [...part.transform] }))
  }
  placeInstanceAt(copy, copy.position.x + 10, copy.position.y + 10)
  return copy
}

/**
 * The OBJECT-level filament for an instance after a per-part material reassignment.
 *
 * `EditorInstance.filamentId` is the object's fallback material: the value the bake writes for
 * any part of a multi-solid import (STEP assembly) that carries no explicit assignment
 * (`objectExtruder` in `three-mf-scene-builder.ts`). Derive it from CONSENSUS: adopt a new value
 * only when every part agrees, and otherwise keep the prior object default. Deriving it from a
 * single part (e.g. `parts[0]`) is the trap it replaces: retargeting the first part would drop
 * the object fallback onto that part's new material, collapsing every still-unassigned part onto
 * it on save (the "everything became material 1" regression on a fresh assembly's first save).
 *
 * Helper volumes are not part of the consensus: a support blocker has no filament at all, so
 * counting it would permanently pin the object to its previous default.
 */
export function deriveObjectFilamentId(
  parts: ReadonlyArray<{ filamentId: number | null; subtype?: string | null }>,
  previous: number | null
): number | null {
  const printed = parts.filter((part) => !isNonRenderableThreeMfPartSubtype(part.subtype ?? null))
  const first = printed[0]?.filamentId ?? null
  const uniform = printed.length > 0 && printed.every((part) => part.filamentId != null && part.filamentId === first)
  return uniform ? first : previous
}

/**
 * Set a whole instance's material, whichever shape the instance is.
 *
 * An object's material lives in one of two places and the caller cannot assume which. A model WITH
 * printed parts carries it per part, and the object's own `filamentId` is a derived consensus. A
 * model with NO parts list -- a primitive, a single-solid STL/3MF import, a single-shell Cut
 * output, and any single-mesh object in a saved project -- carries it on the instance directly,
 * which is what `buildSceneEdit` emits as each `SceneEditInstance.filamentId`.
 *
 * Expressing a material change purely as `{objectId, partIndex}` targets is what made this a silent
 * no-op for the second shape: there is no part to name, so the target list came out empty and the
 * instance was returned untouched, with the UI showing an ordinary swatch throughout.
 *
 * Helper volumes keep their own material rules and are never retargeted here, matching the
 * part-scoped path: a blocker/enforcer or negative volume has no filament at all.
 *
 * @returns the same instance object when nothing changed, so callers can skip a state write.
 */
export function assignInstanceFilament(instance: EditorInstance, filamentId: number): EditorInstance {
  const printed = printedParts(instance)
  if (printed.length === 0) {
    return instance.filamentId === filamentId ? instance : { ...instance, filamentId }
  }
  const parts = instance.parts.map((part) => (threeMfPartSubtypeCarriesFilament(part.subtype)
    ? { ...part, filamentId }
    : part))
  return { ...instance, parts, filamentId: deriveObjectFilamentId(parts, instance.filamentId) }
}

/** An axis-aligned bed footprint in plate coordinates (mm), for placement collision tests. */
export interface PlateFootprintRect { minX: number; maxX: number; minY: number; maxY: number }

/** Nominal footprint assumed for a model/instance whose real size wasn't supplied. */
const NOMINAL_FOOTPRINT_MM = 60

/**
 * Find a free plate position for a newly added/duplicated model, returning where its FOOTPRINT
 * CENTRE should sit (callers offset by the model's centroid to place it).
 *
 * Size-aware: the placed model is kept fully inside the bed and clear of the footprints already on
 * the plate. The previous version treated every model as a POINT with a fixed 60mm radius, so a
 * large model could land overlapping its neighbours or hanging off the plate, and a big existing
 * model only blocked a small disc around its origin. Supply `size`/`occupied` for true footprint
 * placement; without them each instance falls back to a nominal square at its origin (the old
 * behaviour) so callers that can't measure geometry still spread models out.
 *
 * Returns the plate centre when nothing fits: the caller still places the model (overlapping),
 * matching the previous "always return somewhere" contract; the placement warnings then flag it.
 */
export function findFreePlatePosition(
  plate: EditorPlate,
  options: {
    /** Footprint of the model being placed (mm). */
    size?: { width: number; depth: number }
    /** Measured footprints already on the plate. Falls back to nominal squares when omitted. */
    occupied?: readonly PlateFootprintRect[]
    /** Clearance kept between footprints (mm). */
    gapMm?: number
  } = {}
): { x: number; y: number } {
  const gap = options.gapMm ?? 6
  const halfW = Math.max(options.size?.width ?? NOMINAL_FOOTPRINT_MM, 1) / 2
  const halfD = Math.max(options.size?.depth ?? NOMINAL_FOOTPRINT_MM, 1) / 2
  const centerX = (plate.bed.minX + plate.bed.maxX) / 2
  const centerY = (plate.bed.minY + plate.bed.maxY) / 2
  const half = NOMINAL_FOOTPRINT_MM / 2
  const occupied = options.occupied ?? plate.instances.map((instance) => ({
    minX: instance.position.x - half, maxX: instance.position.x + half,
    minY: instance.position.y - half, maxY: instance.position.y + half
  }))
  const fitsBed = (x: number, y: number) =>
    x - halfW >= plate.bed.minX && x + halfW <= plate.bed.maxX
    && y - halfD >= plate.bed.minY && y + halfD <= plate.bed.maxY
  // Separated on either axis (gap included) => no overlap.
  const isFree = (x: number, y: number) => occupied.every((rect) =>
    x - halfW - gap >= rect.maxX || x + halfW + gap <= rect.minX
    || y - halfD - gap >= rect.maxY || y + halfD + gap <= rect.minY)
  if (fitsBed(centerX, centerY) && isFree(centerX, centerY)) return { x: centerX, y: centerY }
  // Scan the positions where the model FITS on the bed and take the free one nearest the centre.
  // A ring/spiral walk skips narrow gaps (on a 200mm bed a 60mm model beside a 60mm occupant only
  // fits in a ~4mm band of X, which rings step straight over); a grid sweep can't miss it.
  const loX = plate.bed.minX + halfW
  const hiX = plate.bed.maxX - halfW
  const loY = plate.bed.minY + halfD
  const hiY = plate.bed.maxY - halfD
  if (loX > hiX || loY > hiY) return { x: centerX, y: centerY } // larger than the bed
  const step = Math.max(2, Math.min(halfW, halfD) / 2)
  // Include both extremes (and the centre) so a tight edge fit isn't stepped over.
  const axis = (lo: number, hi: number, mid: number): number[] => {
    const values = [lo, hi]
    if (mid > lo && mid < hi) values.push(mid)
    for (let v = lo + step; v < hi; v += step) values.push(v)
    return values
  }
  let best: { x: number; y: number } | null = null
  let bestDistance = Infinity
  for (const x of axis(loX, hiX, centerX)) {
    for (const y of axis(loY, hiY, centerY)) {
      if (!isFree(x, y)) continue
      const distance = (x - centerX) ** 2 + (y - centerY) ** 2
      if (distance < bestDistance) { bestDistance = distance; best = { x, y } }
    }
  }
  return best ?? { x: centerX, y: centerY }
}

/** Re-number plates to a contiguous 1-based sequence, preserving order. */
export function reindexPlates(plates: EditorPlate[]): EditorPlate[] {
  return plates.map((plate, position) => (plate.index === position + 1 ? plate : { ...plate, index: position + 1 }))
}

/**
 * Move the plate at live index `fromIndex` into insertion gap `insertAt`, a 0-based gap in the
 * CURRENT list (0 = before the first plate, `plates.length` = after the last). Gap semantics are
 * what the strip's between-tile drop zones produce; unlike a "target tile" splice they mean the
 * same thing whichever direction the drag came from. Returns the input array unchanged for a
 * no-op (unknown plate, or a gap adjacent to the plate's own position), so callers can cheaply
 * skip the history checkpoint and rebuild.
 */
export function movePlate(plates: EditorPlate[], fromIndex: number, insertAt: number): EditorPlate[] {
  const from = plates.findIndex((plate) => plate.index === fromIndex)
  if (from < 0) return plates
  const target = listGapToIndex(from, Math.max(0, Math.min(plates.length, insertAt)))
  if (target === from) return plates
  const reordered = [...plates]
  const [moved] = reordered.splice(from, 1)
  if (!moved) return plates
  reordered.splice(target, 0, moved)
  return reindexPlates(reordered)
}

/**
 * Move `items[from]` to sit immediately before the first item `isAnchor` accepts; last when the
 * anchor is null or matches nothing.
 *
 * An unknown anchor APPENDS rather than aborting: a stale drop is still a move the user asked for,
 * and last is the one position an anchor that is not there cannot contradict. Shared by the object
 * and part movers so that rule has one implementation.
 */
function moveBefore<T>(items: readonly T[], from: number, isAnchor: ((item: T) => boolean) | null): T[] {
  const next = [...items]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return next
  const at = isAnchor ? next.findIndex(isAnchor) : -1
  if (at < 0) next.push(moved)
  else next.splice(at, 0, moved)
  return next
}

/**
 * Instances grouped by the OBJECT each places, objects in first-appearance order.
 *
 * Display order is a property of the object, because that is the only thing the file can express:
 * BambuStudio builds its list by walking `<build><item>` and creating one `ModelObject` the first
 * time an id appears (`bbs_3mf.cpp` `_create_object_instance`), so two linked copies are one entry
 * in its list however their items are spread through the build section.
 *
 * The key is {@link addedPartHostId}, the SAME numeric identity every per-object and per-part seam
 * uses. An instance with none (an import that has not been given one, which nothing constructs
 * today) collects under a single trailing bucket and is not orderable, rather than being handed a
 * private identity: two instances of ONE unsaved import must not read as two objects here, because
 * the bake resolves them to one.
 */
function instancesByObject(instances: readonly EditorInstance[]): Map<number | null, EditorInstance[]> {
  const byObject = new Map<number | null, EditorInstance[]>()
  for (const instance of instances) {
    const hostId = addedPartHostId(instance)
    let list = byObject.get(hostId)
    if (!list) { list = []; byObject.set(hostId, list) }
    list.push(instance)
  }
  return byObject
}

/**
 * The PROJECT's objects in display order: each object once, at its first instance anywhere.
 *
 * Project-wide, not per plate, because the file has exactly one object order: the bake flattens
 * every plate's instances into one build section and BambuStudio's list is that one vector, bucketed
 * under plate nodes for display. An object placed on two plates therefore cannot sit third on one
 * and first on the other, and treating the order as per-plate silently lost a drag on the second
 * plate the next time the project was opened.
 */
export function projectObjectOrder(state: EditorState): number[] {
  return plateSetObjectOrder(state.plates)
}

/** {@link projectObjectOrder} over a bare plate list, for callers mid-update that have no state. */
function plateSetObjectOrder(plates: readonly EditorPlate[]): number[] {
  const order: number[] = []
  const seen = new Set<number>()
  for (const plate of plates) {
    for (const hostId of instancesByObject(plate.instances).keys()) {
      if (hostId == null || seen.has(hostId)) continue
      seen.add(hostId)
      order.push(hostId)
    }
  }
  return order
}

/**
 * Re-lay one plate's instances so every object's instances sit together, following `objectOrder`
 * where it names them.
 *
 * Grouping is not cosmetic tidying: the saved file groups build items by object no matter what this
 * list looks like, so an interleaved list is a sidebar that disagrees with both the file and
 * BambuStudio, and a drag in it would land the dragged object somewhere the user did not point at.
 * Each object's own instances keep their relative order, so a copy never swaps with its original.
 */
function layOutInstancesByObject(instances: EditorInstance[], objectOrder?: readonly number[]): EditorInstance[] {
  // Map iteration is insertion order, so this is already "grouped, objects in first-appearance
  // order" before any caller order is applied.
  const byObject = instancesByObject(instances)
  if (!objectOrder) return [...byObject.values()].flat()
  const out: EditorInstance[] = []
  const placed = new Set<number | null>()
  for (const hostId of objectOrder) {
    const list = byObject.get(hostId)
    if (!list || placed.has(hostId)) continue
    placed.add(hostId)
    out.push(...list)
  }
  // An object the order failed to name still ships, after the ones it did: a project-wide order
  // names objects on other plates too, and dropping one because it went unnamed would be a
  // deletion, not a reorder, with the unreferenced-object sweep taking its geometry on the save.
  for (const [hostId, list] of byObject) {
    if (!placed.has(hostId)) out.push(...list)
  }
  return out
}

/** True when the two lists hold the same items in the same positions. */
function sameOrder<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

/** `plate` with `instances`, or the SAME plate when nothing moved, so no caller rebuilds for a no-op. */
function withInstances(plate: EditorPlate, instances: EditorInstance[]): EditorPlate {
  return sameOrder(instances, plate.instances) ? plate : { ...plate, instances }
}

/**
 * Lay every plate out to ONE object order: the project's, grouped so each object's instances sit
 * together.
 *
 * Whole-list, not per plate, and that is the point. The saved file has a single object sequence
 * (the bake flattens every plate into one build section), so laying each plate out in its OWN
 * first-appearance order lets plate 2 display an order the save will not write: move a copy of A
 * and then a copy of B onto plate 2 and it shows `B, A` while the file says `A, B`, which is the
 * sidebar-disagrees-with-the-file bug this whole seam exists to remove. It also made a NO-OP drag
 * on plate 1 re-lay plate 2 and push an undo step for a change nobody could see.
 *
 * Run at seed time and after every structural edit. A file BambuStudio wrote is already grouped
 * (its `<model_instance>` list is a `std::set<std::pair<int,int>>`, so it is sorted by object), but
 * one of OUR saves need not be: duplicating an object appends the copy, which leaves the original's
 * other instances behind it. Idempotent and identity-stable, so an already-normal list is returned
 * as-is and nothing downstream rebuilds.
 */
export function normalizePlateObjectOrder(plates: EditorPlate[]): EditorPlate[] {
  const order = plateSetObjectOrder(plates)
  const next = plates.map((plate) => withInstances(plate, layOutInstancesByObject(plate.instances, order)))
  return sameOrder(next, plates) ? plates : next
}

/**
 * Move an object to sit immediately before `beforeHostId` in the PROJECT's object order, carrying
 * every instance of it on every plate. A null `beforeHostId` moves it last.
 *
 * Addressed by identity rather than by position on purpose. The sidebar lists only the instances
 * whose geometry has finished rendering, so its positions are a subset of the plate's during a
 * load, and a position handed over from there would name a different object than the one dragged.
 *
 * Whole-STATE, mirroring {@link movePartBefore}, because the order is project-wide (see
 * {@link projectObjectOrder}). The no-op contract mirrors {@link movePlate}: the same state back
 * when nothing moved, so the caller can skip the history checkpoint.
 */
export function moveObjectBefore(
  state: EditorState,
  hostId: number,
  beforeHostId: number | null
): EditorState {
  const order = projectObjectOrder(state)
  const from = order.indexOf(hostId)
  if (from < 0 || hostId === beforeHostId) return state
  const reordered = moveBefore(order, from, beforeHostId === null ? null : (entry) => entry === beforeHostId)
  if (sameOrder(reordered, order)) return state
  const plates = state.plates.map((plate) => withInstances(plate, layOutInstancesByObject(plate.instances, reordered)))
  return sameOrder(plates, state.plates) ? state : { ...state, plates }
}

/**
 * Move a part to sit immediately before `beforePartIndex` within its object, or last when that is
 * null. Both are BASE ordinals ({@link EditorInstancePart.partIndex}), never array positions.
 *
 * Applies to EVERY instance of the object, on every plate: part order is geometry-level, exactly
 * like {@link EditorState.partTransforms}. Reordering on one copy and not the others would make the
 * sidebar disagree with itself depending on which copy was expanded, and only one of the two orders
 * could survive the save.
 *
 * Returns the same state for a no-op, so the caller can skip the history checkpoint.
 */
export function movePartBefore(
  state: EditorState,
  hostId: number,
  partIndex: number,
  beforePartIndex: number | null
): EditorState {
  if (partIndex === beforePartIndex) return state
  let reordered: number[] | null = null
  const plates = state.plates.map((plate) => {
    let changed = false
    const instances = plate.instances.map((instance) => {
      if (addedPartHostId(instance) !== hostId) return instance
      const from = instance.parts.findIndex((part) => part.partIndex === partIndex)
      if (from < 0) return instance
      const parts = moveBefore(
        instance.parts,
        from,
        beforePartIndex === null ? null : (part) => part.partIndex === beforePartIndex
      )
      if (sameOrder(parts, instance.parts)) return instance
      // A HELPER VOLUME MAY NOT LEAD. BambuStudio requires the first volume to be a printed part,
      // refuses this drop in its own object list, and sorts the volumes on load if a file arrives
      // otherwise -- so allowing it here does not corrupt anything, it just means the order we save
      // is not the order the project reopens with, in Studio or in us. Refusing the move is what
      // Studio does, and it keeps the persisted order honest.
      const leading = parts[0]
      if (leading && isNonRenderableThreeMfPartSubtype(canonicalThreeMfPartSubtype(leading.subtype ?? null))) {
        return instance
      }
      changed = true
      // Recorded from the FIRST instance that moved; every other instance of the object is laid out
      // from the same list, so they cannot disagree.
      reordered ??= parts.map((part) => part.partIndex)
      return { ...instance, parts }
    })
    return changed ? { ...plate, instances } : plate
  })
  if (!reordered) return state
  return { ...state, plates, partOrder: { ...state.partOrder, [hostId]: reordered } }
}

/** Flatten the editable state into the locked `SceneEdit` contract. */
/**
 * Whether an instance needs its full matrix emitted. World-space scale only diverges
 * from the decomposed translate*rotate*scale form (and can shear) when the object is
 * BOTH rotated AND non-uniformly scaled. Otherwise T*R*S is exact, so we omit the
 * matrix to keep the slice request small, it travels in an HTTP header with a tight
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
  const placementBed = state.plates[0]?.bed
  return {
    plates: state.plates.map((plate) => ({
      index: plate.index,
      // `index` is a POSITION and is renumbered on every add, delete and reorder, so the bake needs
      // to be told which SOURCE plate this was or it cannot keep the plate-keyed records in step.
      // Null for a session-added plate, which has no source record to carry.
      sourceIndex: plate.sourcePlateIndex,
      name: plate.name ?? undefined,
      // Null, not undefined: the session KNOWS whether this plate inherits, and the bake needs the
      // difference. Undefined means "the edit does not say", which makes the bake keep the source
      // file's value and quietly undo the user clearing an override.
      plateType: plate.plateTypeOverride,
      printSequence: plate.printSequence,
      firstLayerFilamentSequence: plate.firstLayerFilamentSequence,
      otherLayerFilamentSequences: plate.otherLayerFilamentSequences,
      spiralMode: plate.spiralMode,
      locked: plate.locked,
      primeTower: plate.primeTower ? { x: plate.primeTower.x, y: plate.primeTower.y } : null
    })),
    ...(placementBed
      ? {
          placementBedSize: {
            width: placementBed.maxX - placementBed.minX,
            depth: placementBed.maxY - placementBed.minY
          }
        }
      : {}),
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
    projectAuxiliaries: state.projectAuxiliaries,
    partFilaments: collectPartFilaments(state),
    partProcessOverrides: collectPartProcessOverrides(state),
    partTypeChanges: collectPartTypeChanges(state),
    partTransforms: collectPartTransforms(state),
    ...collectPartMeshReplacements(state),
    importPartFilaments: collectImportPartFilaments(state),
    importPartProcessOverrides: collectImportPartProcessOverrides(state),
    importPartTypes: collectImportPartTypes(state),
    importPartTransforms: collectImportPartTransforms(state),
    supportPaint: collectPartPaint(state, state.supportPaint),
    seamPaint: collectPartPaint(state, state.seamPaint),
    colorPaint: collectPartPaint(state, state.colorPaint),
    fuzzyPaint: collectPartPaint(state, state.fuzzyPaint),
    importPaint: mergeImportPaint(collectImportPaint(state), collectAddedPartPaint(state)),
    brimEars: collectBrimEars(state),
    heightRanges: collectHeightRanges(state),
    importHeightRanges: collectImportHeightRanges(state),
    layerHeightProfiles: collectLayerHeightProfiles(state),
    importLayerHeightProfiles: collectImportLayerHeightProfiles(state),
    importBrimEars: collectImportBrimEars(state),
    filamentChanges: collectFilamentChanges(state),
    pauses: collectPauses(state),
    objectNames: collectObjectNames(state),
    addedParts: collectAddedParts(state),
    svgSources: collectSvgSources(state),
    cutGroups: collectCutGroups(state),
    ...collectRemovedParts(state),
    removedObjectBodies: collectRemovedObjectBodies(state),
    ...collectPartOrder(state),
    meshReplacements: collectMeshReplacements(state),
    repairedObjectIds: collectRepairedObjectIds(state),
    repairSettings: state.settingsRepairStaged ? true : undefined,
    // Complete state, not a diff: the whole set of removals the session has made. An empty set is
    // emitted as undefined so an untouched project's save carries nothing about them.
    removedEmbeddedPresets: state.removedEmbeddedPresets && state.removedEmbeddedPresets.length > 0
      ? [...state.removedEmbeddedPresets]
      : undefined,
    // Absent unless the session edited them: a project that legitimately carries NO matrix must
    // not have one materialised just because the editor was opened.
    flushVolumes: state.flushVolumes
      ? {
          matrix: state.flushVolumes.matrix?.map((block) => block.map((row) => [...row])) ?? null,
          multiplier: [...state.flushVolumes.multiplier],
          ...(state.flushVolumes.primeVolumeMode ? { primeVolumeMode: state.flushVolumes.primeVolumeMode } : {})
        }
      : undefined,
    repairedImportIds: collectRepairedImportIds(state),
    objectClones: collectObjectClones(state)
  }
}

/**
 * SESSION -> SAVED filament-id renumbering. A save bakes the controller's desired filament list as
 * slots 1..N, so a save that REMOVED or REORDERED materials renumbers every filament id, but the
 * editor state (and the SceneEdit it emits) speaks the SESSION id space. The map is positional:
 * session id `sessionIds[i]` becomes saved id `i + 1` (the desired list is built from the
 * controller's `projectFilaments` in order). Null when the mapping is identity, so callers can
 * skip the rewrite entirely: the overwhelmingly common case.
 *
 * Both halves of the invariant hang off this map:
 * - {@link rebaseSceneEditFilamentIds} translates the EMITTED edit, so the bake never writes a
 *   session id into the file (a part `extruder="2"` in a 1-filament project: stale data that
 *   fabricates phantom plate filaments downstream).
 * - {@link rebaseEditorStateFilamentIds} moves the LIVE session onto the saved ids after the save
 *   succeeds, so mesh colours keep resolving (the post-save "model reverted to its original
 *   colour" report) and a SECOND save doesn't re-translate already-translated ids.
 */
export function buildSessionFilamentIdRemap(sessionIds: number[]): Map<number, number> | null {
  const map = new Map<number, number>()
  let identity = true
  sessionIds.forEach((sessionId, index) => {
    map.set(sessionId, index + 1)
    if (sessionId !== index + 1) identity = false
  })
  return identity ? null : map
}

/**
 * Translate every filament id the SceneEdit carries from session space to the saved (1..N) space.
 * An id the map cannot translate references a REMOVED material: the assignment is dropped rather
 * than guessed (the bake then inherits the object/base value, which `remapModelSettingsFilamentRefs` keeps
 * correct). Colour paint is included, its codes are filament ids encoded inside the triangle
 * strings, so they go through `remapPaintTriangles`; the support/seam channels encode
 * enforcer/blocker CONSTANTS instead and must never be remapped.
 */
export function rebaseSceneEditFilamentIds(edit: SceneEdit, remap: Map<number, number>): SceneEdit {
  const translate = (id: number | null | undefined): number | null =>
    id == null ? null : remap.get(id) ?? null
  return {
    ...edit,
    plates: edit.plates.map((plate) => ({
      ...plate,
      firstLayerFilamentSequence: plate.firstLayerFilamentSequence?.map(translate).filter((id): id is number => id != null) ?? plate.firstLayerFilamentSequence,
      otherLayerFilamentSequences: plate.otherLayerFilamentSequences?.map((range) => ({
        ...range,
        filamentIds: range.filamentIds.map(translate).filter((id): id is number => id != null)
      })) ?? plate.otherLayerFilamentSequences
    })),
    instances: edit.instances.map((instance) => ({ ...instance, filamentId: translate(instance.filamentId) })),
    partFilaments: edit.partFilaments
      ?.map((part) => ({ ...part, filamentId: translate(part.filamentId) }))
      .filter((part): part is SceneEditPartFilament => part.filamentId != null),
    importPartFilaments: edit.importPartFilaments
      ?.map((part) => ({ ...part, filamentId: translate(part.filamentId) }))
      .filter((part): part is SceneEditImportPartFilament => part.filamentId != null),
    addedParts: edit.addedParts?.map((part) => {
      const filamentId = translate(part.filamentId)
      const { filamentId: _dropped, ...rest } = part
      return filamentId != null ? { ...rest, filamentId } : rest
    }),
    filamentChanges: edit.filamentChanges?.map((plate) => ({
      ...plate,
      changes: plate.changes
        .map((change) => ({ ...change, filamentId: translate(change.filamentId) }))
        .filter((change): change is typeof plate.changes[number] => change.filamentId != null)
    })),
    // Colour paint carries filament ids inside its triangle codes (see remapColorPaintCode), so the
    // bake must receive them in the SAVED id space like every other seam here.
    colorPaint: edit.colorPaint
      ?.map((part) => ({ ...part, triangles: remapPaintTriangles(part.triangles, remap) }))
      .filter((part) => Object.keys(part.triangles).length > 0),
    importPaint: edit.importPaint?.map((entry) => (entry.channel === 'color'
      ? { ...entry, triangles: remapPaintTriangles(entry.triangles, remap) }
      : entry))
  }
}

/** Remap the colour codes of one part's triangle map, dropping triangles left unpainted. */
function remapPaintTriangles(
  triangles: Record<string, string> | Record<number, string>,
  remap: Map<number, number>
): Record<number, string> {
  const out: Record<number, string> = {}
  for (const [key, code] of Object.entries(triangles)) {
    const next = remapColorPaintCode(code, remap)
    if (next) out[Number(key)] = next
  }
  return out
}

/**
 * Move the live editor session onto the saved filament ids: the state-side half of
 * {@link buildSessionFilamentIdRemap}'s invariant, applied once a project save succeeds. Ids the
 * map cannot translate (removed materials) become null (inherit), mirroring the emit-side drop.
 */
export function rebaseEditorStateFilamentIds(state: EditorState, remap: Map<number, number>): EditorState {
  const translate = (id: number | null | undefined): number | null =>
    id == null ? null : remap.get(id) ?? null
  const addedParts = state.addedParts
    ? Object.fromEntries(
        Object.entries(state.addedParts).map(([hostId, parts]) => [
          hostId,
          parts.map((part) => ({ ...part, filamentId: translate(part.filamentId) }))
        ])
      )
    : undefined
  return {
    ...state,
    plates: state.plates.map((plate) => ({
      ...plate,
      firstLayerFilamentSequence: plate.firstLayerFilamentSequence
        ?.map(translate).filter((id): id is number => id != null) ?? plate.firstLayerFilamentSequence,
      otherLayerFilamentSequences: plate.otherLayerFilamentSequences?.map((range) => ({
        ...range,
        filamentIds: range.filamentIds.map(translate).filter((id): id is number => id != null)
      })) ?? plate.otherLayerFilamentSequences,
      instances: plate.instances.map((instance) => ({
        ...instance,
        filamentId: translate(instance.filamentId),
        parts: instance.parts.map((part) => ({ ...part, filamentId: translate(part.filamentId) }))
      })),
      ...(plate.filamentChanges
        ? { filamentChanges: plate.filamentChanges.map((change) => ({ ...change, filamentId: translate(change.filamentId) ?? change.filamentId })) }
        : {}),
      ...(plate.filamentChangesOverride
        ? { filamentChangesOverride: plate.filamentChangesOverride.map((change) => ({ ...change, filamentId: translate(change.filamentId) ?? change.filamentId })) }
        : {})
    })),
    ...(addedParts ? { addedParts } : {}),
    // Colour paint stores the filament id IN the triangle code, so it has to move with everything
    // else, otherwise the painted regions survive the renumber pointing at whatever material now
    // holds the old number, and the model prints those areas in the wrong colour.
    ...(state.colorPaint ? { colorPaint: remapColorPaintMap(state.colorPaint, remap) } : {}),
    baseFilamentIds: state.baseFilamentIds
      ? Object.fromEntries(Object.entries(state.baseFilamentIds).map(([id, liveId]) => [id, remap.get(liveId) ?? liveId]))
      : Object.fromEntries(remap)
  }
}

/**
 * Emit the objects marked for mesh repair, dropped to those that still have a placed instance:
 * marking an object and then deleting it must not ship a dangling repair. An object replaced this
 * session is skipped too: its geometry is now import-backed, so the original mesh the mark referred
 * to is not what gets baked.
 */
function collectRepairedObjectIds(state: EditorState): SceneEdit['repairedObjectIds'] {
  if (!state.repairedObjectIds || state.repairedObjectIds.length === 0) return undefined
  const placed = placedObjectIds(state)
  // A REPLACED object keeps its identity but its geometry is now an import, so repairing it here
  // would mark a mesh the save is about to swap out; `repairedImportIds` covers that case instead.
  const replaced = new Set(importIdByReplacedObjectId(state).keys())
  const ids = state.repairedObjectIds.filter((id) => placed.has(id) && !replaced.has(id))
  return ids.length > 0 ? ids : undefined
}

/**
 * Repair marks that landed on an IMPORT's synthetic identity, mapped back to its importId. The
 * bake has no mesh XML to rewrite for an unsaved import, so it repairs the staged geometry instead
 * (`repairImportedMeshGeometry`), which is what lets "Repair mesh" work with no save first.
 */
function collectRepairedImportIds(state: EditorState): SceneEdit['repairedImportIds'] {
  if (!state.repairedObjectIds || state.repairedObjectIds.length === 0) return undefined
  const importByObjectId = importIdByReplacedObjectId(state)
  const ids = state.repairedObjectIds.flatMap((id) => {
    const importId = importByObjectId.get(id)
    return importId ? [importId] : []
  })
  return ids.length > 0 ? [...new Set(ids)] : undefined
}

/**
 * Brim ears authored on an IMPORT's synthetic identity, mapped back to its importId. The sidecar
 * addresses objects by baked root-resource ordinal, which an unsaved import does not have yet, so
 * the bake resolves these through `importIdToObjectId` instead.
 */
function collectImportBrimEars(state: EditorState): SceneEdit['importBrimEars'] {
  if (!state.brimEars || Object.keys(state.brimEars).length === 0) return undefined
  const importByObjectId = importIdByReplacedObjectId(state)
  const out: NonNullable<SceneEdit['importBrimEars']> = []
  for (const [objectIdRaw, ears] of Object.entries(state.brimEars)) {
    const importId = importByObjectId.get(Number.parseInt(objectIdRaw, 10))
    if (!importId || ears.length === 0) continue
    out.push({ importId, points: ears.map((ear) => ({ ...ear })) })
  }
  return out.length > 0 ? out : undefined
}

/** Variable layer height authored on an IMPORT's synthetic identity, mapped back to its importId. */
function collectImportLayerHeightProfiles(state: EditorState): SceneEdit['importLayerHeightProfiles'] {
  if (!state.layerHeightProfiles || Object.keys(state.layerHeightProfiles).length === 0) return undefined
  const importByObjectId = importIdByReplacedObjectId(state)
  const out: NonNullable<SceneEdit['importLayerHeightProfiles']> = []
  for (const [objectIdRaw, profile] of Object.entries(state.layerHeightProfiles)) {
    const importId = importByObjectId.get(Number.parseInt(objectIdRaw, 10))
    if (!importId || profile.length === 0) continue
    out.push({ importId, profile: [...profile] })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Height ranges authored on an IMPORT's synthetic identity, mapped back to its importId, for the
 * same reason as `collectImportBrimEars`: the sidecar addresses objects by baked ordinal, which an
 * unsaved import does not have until the bake assigns one.
 */
function collectImportHeightRanges(state: EditorState): SceneEdit['importHeightRanges'] {
  if (!state.heightRanges || Object.keys(state.heightRanges).length === 0) return undefined
  const importByObjectId = importIdByReplacedObjectId(state)
  const out: NonNullable<SceneEdit['importHeightRanges']> = []
  for (const [objectIdRaw, ranges] of Object.entries(state.heightRanges)) {
    const importId = importByObjectId.get(Number.parseInt(objectIdRaw, 10))
    if (!importId || ranges.length === 0) continue
    out.push({ importId, ranges: ranges.map(cloneHeightRange) })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Triangle paint authored on an IMPORT's synthetic identity, mapped to import + solid index.
 *
 * Indices are positions in the staged mesh's triangle order, which the editor rendered from and the
 * bake writes back to: see the contract note on `SceneEdit.importPaint`. A single-solid import
 * keys its only mesh as solid 0, matching `instanceFromStagedImport`'s part indexing.
 */
function collectImportPaint(state: EditorState): SceneEdit['importPaint'] {
  const channels = [
    { channel: 'support' as const, paint: state.supportPaint },
    { channel: 'seam' as const, paint: state.seamPaint },
    { channel: 'color' as const, paint: state.colorPaint },
    { channel: 'fuzzy' as const, paint: state.fuzzyPaint }
  ].filter((entry) => entry.paint && Object.keys(entry.paint).length > 0)
  if (channels.length === 0) return undefined
  const importByObjectId = importIdByReplacedObjectId(state)
  if (importByObjectId.size === 0) return undefined
  const out: NonNullable<SceneEdit['importPaint']> = []
  for (const { channel, paint } of channels) {
    for (const [key, triangles] of Object.entries(paint ?? {})) {
      const [objectIdRaw, partRaw] = key.split(':')
      const objectId = Number.parseInt(objectIdRaw ?? '', 10)
      const partIndex = Number.parseInt(partRaw ?? '', 10)
      if (!Number.isInteger(objectId) || !Number.isInteger(partIndex)) continue
      const importId = importByObjectId.get(objectId)
      if (!importId || Object.keys(triangles).length === 0) continue
      out.push({
        importId,
        partIndex,
        channel,
        triangles: Object.fromEntries(Object.entries(triangles).map(([index, code]) => [String(index), code]))
      })
    }
  }
  return out.length > 0 ? out : undefined
}

/** Both sources of `importPaint` as one list, or undefined when neither had anything to say. */
function mergeImportPaint(
  fromImports: SceneEdit['importPaint'],
  fromAddedParts: NonNullable<SceneEdit['importPaint']>
): SceneEdit['importPaint'] {
  const merged = [...(fromImports ?? []), ...fromAddedParts]
  return merged.length > 0 ? merged : undefined
}

/**
 * Paint the user applied to SESSION-ADDED volumes.
 *
 * Emitted as `importPaint` like an unsaved import's, because that is exactly what a volume's mesh
 * is: a single-solid `part` import, which the bake writes through the same
 * `renderImportedMeshObjectXml` call and whose paint it already reads from
 * `importPaint.get(importId).get(0)`. So this needed no bake-side seam of its own -- solid 0 is the
 * volume's only mesh.
 *
 * Split from {@link collectImportPaint} rather than folded into it because the two resolve their
 * importId from different places (that one maps a replaced object's synthetic id, this one reads
 * the volume's own record) and a single loop doing both reads as if the key space were shared.
 */
function collectAddedPartPaint(state: EditorState): NonNullable<SceneEdit['importPaint']> {
  const channels = [
    { channel: 'support' as const, paint: state.supportPaint },
    { channel: 'seam' as const, paint: state.seamPaint },
    { channel: 'color' as const, paint: state.colorPaint },
    { channel: 'fuzzy' as const, paint: state.fuzzyPaint }
  ].filter((entry) => entry.paint && Object.keys(entry.paint).length > 0)
  // Only volumes still attached to a placed host: deleting the volume (or its object) must not ship
  // paint for geometry the save does not write, exactly as the other per-part collectors drop theirs.
  const liveImportIds = new Set<string>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      for (const part of effectiveAddedParts(state, instance)) liveImportIds.add(part.importId)
    }
  }
  const out: NonNullable<SceneEdit['importPaint']> = []
  for (const { channel, paint } of channels) {
    for (const [key, triangles] of Object.entries(paint ?? {})) {
      const importId = addedPartPaintImportId(key)
      if (!importId || !liveImportIds.has(importId)) continue
      out.push({
        importId,
        // A volume's mesh is a single-solid import, so its only solid is 0.
        partIndex: 0,
        channel,
        triangles: Object.fromEntries(Object.entries(triangles).map(([index, code]) => [String(index), code]))
      })
    }
  }
  return out
}

/** Whether an object is already marked for mesh repair on save. */
export function isObjectMarkedForRepair(state: EditorState, objectId: number): boolean {
  return (state.repairedObjectIds ?? []).includes(objectId)
}

/**
 * Emit one `meshReplacements` entry per in-project object that was replaced this session
 * (its instances are now import-backed with a `replacedObjectId`). Deduped by the replaced
 * objectId, every copy of the object points at the same import, so the slicer can carry
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

/** Emit in-place volume mesh replacements in the address space of each surviving host. */
function collectPartMeshReplacements(
  state: EditorState
): Pick<SceneEdit, 'partMeshReplacements' | 'importPartMeshReplacements'> {
  if (!state.partMeshReplacements) return {}
  const hosts = partHostAddresses(state)
  const instancesByHost = new Map<number, EditorInstance>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      const hostId = addedPartHostId(instance)
      if (hostId != null && !instancesByHost.has(hostId)) instancesByHost.set(hostId, instance)
    }
  }
  const partMeshReplacements: NonNullable<SceneEdit['partMeshReplacements']> = []
  const importPartMeshReplacements: NonNullable<SceneEdit['importPartMeshReplacements']> = []
  for (const [key, meshImportId] of Object.entries(state.partMeshReplacements)) {
    const parsed = parsePartSlotKey(key)
    if (!parsed) continue
    const host = hosts.get(parsed.objectId)
    if (!host) continue
    const instance = instancesByHost.get(parsed.objectId)
    if (!instance?.parts.some((part) => part.partIndex === parsed.partIndex)) continue
    if ('objectId' in host) {
      partMeshReplacements.push({ objectId: host.objectId, partIndex: parsed.partIndex, meshImportId })
    } else {
      importPartMeshReplacements.push({ importId: host.importId, partIndex: parsed.partIndex, meshImportId })
    }
  }
  return {
    ...(partMeshReplacements.length > 0 ? { partMeshReplacements } : {}),
    ...(importPartMeshReplacements.length > 0 ? { importPartMeshReplacements } : {})
  }
}

/**
 * How each part host is ADDRESSED in the emitted edit: an in-project object by its Bambu object id,
 * an import that has never been saved by its importId.
 *
 * One map for every per-part collector, because they all have to answer the same question and a
 * host resolved two ways is a seam that emits against an object one save and an import the next. A
 * host with no placed instance is absent, which is what stops a removal or an order shipping
 * against a model the edit no longer places.
 */
function partHostAddresses(state: EditorState): Map<number, { objectId: number } | { importId: string }> {
  const hostById = new Map<number, { objectId: number } | { importId: string }>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      const hostId = addedPartHostId(instance)
      if (hostId == null || hostById.has(hostId)) continue
      hostById.set(hostId, instance.source.kind === 'object'
        ? { objectId: instance.objectId }
        : { importId: instance.source.importId })
    }
  }
  return hostById
}

/**
 * Emit the objects whose BODY was deleted: their added parts are the object's whole geometry.
 *
 * Addressed exactly like {@link collectAddedParts}, `objectId` XOR `importId`, because a body can be
 * deleted from a model that has never been saved (a primitive is the common case) and the bake
 * resolves the import to a real object id itself. Read off the instances rather than a session map
 * because the flag lives ON the instance, so an object deleted afterwards takes it with it.
 */
/**
 * Hosts whose BODY this session deleted, by the id the ordinal-keyed maps use.
 *
 * The body occupies {@link BODY_PART_INDEX} only while it exists. Once it is gone the bake writes
 * no component for it, so `<part>` position 0 is the object's FIRST ADDED VOLUME -- and any type or
 * per-part settings the user had given the body would land on that volume instead, silently, in the
 * saved file. The ordinal collectors drop ordinal 0 for these hosts rather than the delete clearing
 * the entries, so undoing the deletion brings the body's own type back with it.
 */
function bodyRemovedHostIds(state: EditorState): Set<number> {
  const hosts = new Set<number>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (!instance.bodyRemoved) continue
      const hostId = addedPartHostId(instance)
      if (hostId != null) hosts.add(hostId)
    }
  }
  return hosts
}

function collectRemovedObjectBodies(state: EditorState): SceneEdit['removedObjectBodies'] {
  const seen = new Set<number>()
  const out: NonNullable<SceneEdit['removedObjectBodies']> = []
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (!instance.bodyRemoved) continue
      const hostId = addedPartHostId(instance)
      if (hostId == null || seen.has(hostId)) continue
      seen.add(hostId)
      out.push(instance.source.kind === 'object'
        ? { objectId: instance.objectId }
        : { importId: instance.source.importId })
    }
  }
  return out.length > 0 ? out : undefined
}

/**
 * Emit this session's part deletions, split by how their host is addressed. Mirrors
 * {@link collectAddedParts}, including the host resolution: a deletion must work on a model that
 * has never been saved, so an import-backed host emits `importRemovedParts` keyed by its importId
 * while an in-project object emits `removedParts` keyed by its Bambu object id.
 *
 * A host with no placed instance left contributes nothing: deleting a part and then deleting the
 * whole object must not ship a removal against an object the edit no longer places.
 */
function collectRemovedParts(state: EditorState): Pick<SceneEdit, 'removedParts' | 'importRemovedParts'> {
  if (!state.removedParts) return {}
  const hostById = partHostAddresses(state)
  const removedParts: NonNullable<SceneEdit['removedParts']> = []
  const importRemovedParts: NonNullable<SceneEdit['importRemovedParts']> = []
  for (const [hostIdRaw, partIndexes] of Object.entries(state.removedParts)) {
    const host = hostById.get(Number.parseInt(hostIdRaw, 10))
    if (!host) continue
    for (const partIndex of partIndexes) {
      if ('objectId' in host) removedParts.push({ objectId: host.objectId, partIndex })
      else importRemovedParts.push({ importId: host.importId, partIndex })
    }
  }
  return {
    ...(removedParts.length > 0 ? { removedParts } : {}),
    ...(importRemovedParts.length > 0 ? { importRemovedParts } : {})
  }
}

/**
 * Emit this session's part reorders, split by host exactly like {@link collectRemovedParts}.
 *
 * An order of fewer than two parts is dropped rather than emitted: it says nothing, and the payload
 * rides an HTTP header on the slice path.
 */
function collectPartOrder(state: EditorState): Pick<SceneEdit, 'partOrder' | 'importPartOrder'> {
  if (!state.partOrder) return {}
  const hostById = partHostAddresses(state)
  const partOrder: NonNullable<SceneEdit['partOrder']> = []
  const importPartOrder: NonNullable<SceneEdit['importPartOrder']> = []
  for (const [hostIdRaw, order] of Object.entries(state.partOrder)) {
    const host = hostById.get(Number.parseInt(hostIdRaw, 10))
    if (!host || order.length < 2) continue
    if ('objectId' in host) partOrder.push({ objectId: host.objectId, order: [...order] })
    else importPartOrder.push({ importId: host.importId, order: [...order] })
  }
  return {
    ...(partOrder.length > 0 ? { partOrder } : {}),
    ...(importPartOrder.length > 0 ? { importPartOrder } : {})
  }
}

/**
 * Emit added part volumes for models that still have at least one placed instance (adding a part
 * and then deleting the model must not ship a dangling part). The host is emitted as the
 * `objectId` of an in-project object, or the `importId` of an import that has not been saved yet,
 * the contract takes exactly one, and the builder resolves an import host through the same
 * `importIdToObjectId` map it uses to place the import itself.
 */
function collectAddedParts(state: EditorState): SceneEdit['addedParts'] {
  if (!state.addedParts) return undefined
  // Host key -> how to address it in the edit. An import wins only if no in-project object claims
  // the same key, which cannot happen: an import's synthetic id is negative, and a REPLACEMENT
  // import's (real, positive) id is only reachable once the object it replaced is gone.
  const hostById = new Map<number, { objectId: number } | { importId: string }>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      const hostId = addedPartHostId(instance)
      if (hostId == null || hostById.has(hostId)) continue
      hostById.set(hostId, instance.source.kind === 'object'
        ? { objectId: instance.objectId }
        : { importId: instance.source.importId })
    }
  }
  const out: NonNullable<SceneEdit['addedParts']> = []
  for (const [hostIdRaw, parts] of Object.entries(state.addedParts)) {
    const host = hostById.get(Number.parseInt(hostIdRaw, 10))
    if (!host) continue
    for (const part of parts) {
      const matrix = new THREE.Matrix4().compose(
        part.position,
        new THREE.Quaternion().setFromEuler(part.rotation),
        part.scale
      )
      const e = matrix.elements
      out.push({
        ...host,
        meshImportId: part.importId,
        subtype: part.subtype,
        name: part.name,
        matrix: [e[0]!, e[1]!, e[2]!, e[4]!, e[5]!, e[6]!, e[8]!, e[9]!, e[10]!, e[12]!, e[13]!, e[14]!],
        // Only a filament-carrying subtype ships one, so retyping a modifier to a support
        // blocker cannot leave a stale extruder behind on the baked part.
        ...(part.filamentId != null && threeMfPartSubtypeCarriesFilament(part.subtype)
          ? { filamentId: part.filamentId }
          : {}),
        ...(part.settings && Object.keys(part.settings).length > 0 ? { settings: { ...part.settings } } : {}),
        ...(part.textInfo ? { textInfo: part.textInfo } : {}),
        ...(part.svgPart ? { svgPart: part.svgPart } : {}),
        ...(part.bambuShape ? { bambuShape: part.bambuShape } : {})
      })
    }
  }
  return out.length > 0 ? out : undefined
}

/** One volume of an extruded artwork, in whichever of the two address spaces it lives. */
export type SvgArtworkPart =
  | {
    kind: 'baked'
    partIndex: number
    pieceIndex: number
    transform: number[]
    subtype: string | null
    /**
     * The part's OWN material, not its object's. A re-extrude inherits this, because reading the
     * instance's instead repainted every mark to the object's colour on a width change.
     */
    filamentId: number | null
  }
  | { kind: 'added'; key: string; pieceIndex: number }

/**
 * Every volume of ONE artwork on ONE object, baked and session-added alike.
 *
 * The SVG tool's width and thickness describe the whole drawing, so re-extruding it has to replace
 * every piece of that drawing rather than the mark the user happened to click. Which pieces those
 * are is the parts sharing the record's `entryPath`.
 *
 * SURVIVORS ONLY, deliberately: a piece the user has since deleted is simply not in this list, so a
 * re-extrude does not resurrect it. Re-deriving the set from the artwork instead would bring back
 * the background they excluded and every mark they removed, on an edit that only meant to change a
 * width.
 *
 * Scoped to one host object. Adding the same file to two models produces two independent artworks
 * that happen to share an archive entry, and editing one must not reach into the other.
 */
export function svgArtworkParts(
  state: EditorState | null,
  hostId: number,
  entryPath: string
): SvgArtworkPart[] {
  const out: SvgArtworkPart[] = []
  // Baked parts are OBJECT-level, so one matching instance describes them all. Walking every plate
  // and every copy returned the same part once per instance -- on an object placed on two plates the
  // re-extrude then pushed two replacements for one removal and doubled the geometry, while the
  // panel offered to update twice as many parts as the drawing has.
  const seen = new Set<number>()
  for (const plate of state?.plates ?? []) {
    for (const instance of plate.instances) {
      if (addedPartHostId(instance) !== hostId) continue
      for (const part of instance.parts) {
        if (part.svgPart?.entryPath !== entryPath) continue
        if (seen.has(part.partIndex)) continue
        seen.add(part.partIndex)
        out.push({
          kind: 'baked',
          partIndex: part.partIndex,
          pieceIndex: part.svgPart.pieceIndex,
          transform: [...part.transform],
          subtype: part.subtype,
          filamentId: part.filamentId
        })
      }
    }
  }
  for (const part of state?.addedParts?.[hostId] ?? []) {
    if (part.svgPart?.entryPath !== entryPath) continue
    out.push({ kind: 'added', key: part.key, pieceIndex: part.svgPart.pieceIndex })
  }
  return out
}

/**
 * What a re-extrude must do to each piece of an artwork already in the project.
 *
 * PURE, and extracted from the commit so the awkward cases can be tested: they are exactly the ones
 * a replace-only pass got silently wrong, and none of them is reachable from the happy path of
 * "same file, different width".
 *
 * The new extrusion need not have the same pieces at all. The background toggle adds or drops one, a
 * replaced file can carry more or fewer shapes, and crossing the split threshold RENUMBERS
 * everything, because a merged import is piece 0 while a split one is 1..N. So each new piece either
 * replaces the survivor that shares its key or is added, and any survivor whose piece the artwork no
 * longer has is removed. Both sides must derive the key identically or a split/merge flip matches
 * nothing and the whole update reports "no pieces left" while changing not one thing.
 */
export function planSvgReextrude(
  survivors: readonly SvgArtworkPart[],
  /** Paint order of each piece the new extrusion produced, before keying. */
  pieceIndexes: readonly number[],
  /** Whether THIS extrusion splits; decides the key on both sides. */
  split: boolean
): {
  replace: Array<{ pieceIndex: number; survivor: SvgArtworkPart }>
  add: number[]
  remove: SvgArtworkPart[]
} {
  const key = (index: number) => (split ? index : 0)
  const survivorByPiece = new Map(survivors.map((part) => [part.pieceIndex, part]))
  const producedKeys = new Set(pieceIndexes.map(key))
  const replace: Array<{ pieceIndex: number; survivor: SvgArtworkPart }> = []
  const add: number[] = []
  for (const pieceIndex of pieceIndexes) {
    const survivor = survivorByPiece.get(key(pieceIndex))
    if (survivor) replace.push({ pieceIndex, survivor })
    else add.push(pieceIndex)
  }
  return { replace, add, remove: survivors.filter((part) => !producedKeys.has(part.pieceIndex)) }
}

/**
 * Decide which archive entry an artwork should be stored under, and whether it needs storing.
 *
 * Two rules, each of which was a bug first.
 *
 * **The taken set must include entries the OPENED FILE already carries**, not just this session's.
 * Those bytes live in the archive rather than in `svgSources`, so their names are only visible
 * through the records of the parts that reference them. Minting against the session alone let a
 * newly imported `logo.svg` reuse the entry name of a DIFFERENT `logo.svg` already in the project:
 * an appended entry never displaces one the copy pass already wrote, so the new markup was dropped
 * and the new part silently reopened as the old drawing.
 *
 * **Identical bytes reuse their entry.** Adding one artwork to several objects is ordinary, and
 * keying on the name alone wrote a byte-identical copy per repeat, into the save payload and the
 * stored file both. `reused` tells the caller it has nothing new to register.
 */
export function resolveSvgArchiveEntry(
  state: EditorState | null,
  fileName: string,
  markup: string,
  /**
   * Entry names the opened archive holds, from `EditorProjectSource.listEntries`. Without them the
   * taken set sees only entries some record still NAMES, so an orphan (artwork whose parts were all
   * deleted) reads as free and gets re-minted, which discards the new bytes.
   */
  archiveEntries: readonly string[] = []
): { entryPath: string; reused: boolean } {
  const sources = state?.svgSources ?? {}
  const identical = Object.entries(sources).find(([, existing]) => existing === markup)
  if (identical) return { entryPath: identical[0], reused: true }

  const taken = new Set([...Object.keys(sources), ...archiveEntries.filter(isSvgArchiveEntry)])
  for (const plate of state?.plates ?? []) {
    for (const instance of plate.instances) {
      if (instance.svgPart) taken.add(instance.svgPart.entryPath)
      for (const part of instance.parts) {
        if (part.svgPart) taken.add(part.svgPart.entryPath)
      }
    }
  }
  for (const parts of Object.values(state?.addedParts ?? {})) {
    for (const part of parts) {
      if (part.svgPart) taken.add(part.svgPart.entryPath)
    }
  }
  return { entryPath: svgArchiveEntryPath(fileName, taken), reused: false }
}

/**
 * The source SVGs this save must store, being exactly those a surviving part still names.
 *
 * REFERENCED, not "everything the session loaded". The tool can be opened on several files before
 * one is committed, and a part can be deleted after its artwork was added, so emitting the whole
 * map would write bytes for artwork the project does not contain and keep writing them on every
 * subsequent save. Anything a part still points at is required, though: without those bytes the
 * record names an entry nobody stored and the part reopens as anonymous solids, which is
 * indistinguishable from having no record at all.
 */
/**
 * The cuts this save can still describe: those whose pieces are all still on a plate.
 *
 * Filtered rather than trusted, because a cut record naming an object the user has since deleted
 * would report a group larger than the file contains -- and BambuStudio reads `check_sum` as how
 * many objects it should be able to select at once, so a group it can never fully select has
 * non-uniform scaling permanently disabled. Dropping the whole group when a piece goes is the
 * truthful answer: what remains is no longer the cut that was made.
 *
 * A group of fewer than two pieces is dropped for the same reason and is also a WIRE requirement:
 * `sceneEditSchema` demands at least two importIds, so emitting one fails validation at the save
 * route and blocks every save, export and slice of the project until the cut is undone. The cut
 * itself declines to record one; this is the backstop, because the state can also be seeded from a
 * reopened file.
 */
function collectCutGroups(state: EditorState): SceneEdit['cutGroups'] {
  const groups = state.cutGroups
  if (!groups || groups.length === 0) return undefined
  const placed = new Set<string>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind === 'import') placed.add(instance.source.importId)
    }
  }
  const surviving = groups
    .filter((group) => group.importIds.length >= 2 && group.importIds.every((importId) => placed.has(importId)))
    // A connector volume can be deleted on its own without touching the halves, so the volume list
    // is filtered separately; `connectorCount` is left alone because it counts what the cut PLACED.
    .map((group) => ({
      ...group,
      connectors: group.connectors.filter((connector) => placed.has(connector.importId))
    }))
  return surviving.length > 0 ? surviving : undefined
}

function collectSvgSources(state: EditorState): SceneEdit['svgSources'] {
  const sources = state.svgSources
  if (!sources) return undefined
  const referenced = new Set<string>()
  for (const parts of Object.values(state.addedParts ?? {})) {
    for (const part of parts) {
      if (part.svgPart) referenced.add(part.svgPart.entryPath)
    }
  }
  const out = [...referenced]
    .filter((entryPath) => sources[entryPath] != null)
    .map((entryPath) => ({ entryPath, markup: sources[entryPath]! }))
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
 * Emit every placed in-project object's COMPLETE layer height profile once the session has touched
 * any of them, carrying seeded curves through for objects the user did not edit (the bake authors
 * the sidecar wholesale). No session edits -> undefined, file kept as-is.
 */
function collectLayerHeightProfiles(state: EditorState): SceneEdit['layerHeightProfiles'] {
  if (!state.layerHeightProfiles || Object.keys(state.layerHeightProfiles).length === 0) return undefined
  const byObject = new Map<number, number[]>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind !== 'object' || byObject.has(instance.objectId)) continue
      byObject.set(instance.objectId, effectiveLayerHeightProfile(state, instance))
    }
  }
  const out: NonNullable<SceneEdit['layerHeightProfiles']> = []
  for (const [objectId, profile] of byObject) {
    if (profile.length === 0) continue
    out.push({ objectId, profile: [...profile] })
  }
  return out
}

/**
 * Emit every placed in-project object's COMPLETE height-range set once the session has touched any
 * of them, carrying seeded bands through for objects the user did not edit or they would be lost
 * (the bake authors the sidecar wholesale). No session edits -> undefined, file kept as-is.
 */
function collectHeightRanges(state: EditorState): SceneEdit['heightRanges'] {
  if (!state.heightRanges || Object.keys(state.heightRanges).length === 0) return undefined
  const byObject = new Map<number, EditorHeightRange[]>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind !== 'object' || byObject.has(instance.objectId)) continue
      byObject.set(instance.objectId, effectiveHeightRanges(state, instance))
    }
  }
  const out: NonNullable<SceneEdit['heightRanges']> = []
  for (const [objectId, ranges] of byObject) {
    if (ranges.length === 0) continue
    out.push({ objectId, ranges: ranges.map(cloneHeightRange) })
  }
  // A defined-but-empty array still clears the file (all bands removed).
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
  const placed = placedObjectIds(state)
  const out: NonNullable<SceneEdit['supportPaint']> = []
  for (const [key, triangles] of Object.entries(paint)) {
    const parsedKey = parsePartPaintKey(key)
    if (!parsedKey) continue
    const { objectId, componentObjectId } = parsedKey
    if (!placed.has(objectId)) continue
    out.push({
      objectId,
      componentObjectId,
      triangles: Object.fromEntries(Object.entries(triangles).map(([index, code]) => [String(index), code]))
    })
  }
  return out.length > 0 ? out : undefined
}

/** Part-type changes for parts whose in-project object is still placed (keyed objectId:partIndex). */
function collectPartTypeChanges(state: EditorState): SceneEdit['partTypeChanges'] {
  if (!state.partTypeChanges) return undefined
  const placed = placedObjectIds(state)
  const bodyRemoved = bodyRemovedHostIds(state)
  const out: NonNullable<SceneEdit['partTypeChanges']> = []
  for (const [key, subtype] of Object.entries(state.partTypeChanges)) {
    const parsedKey = parsePartSlotKey(key)
    if (!parsedKey) continue
    const { objectId, partIndex } = parsedKey
    if (!placed.has(objectId)) continue
    if (partIndex === BODY_PART_INDEX && bodyRemoved.has(objectId)) continue
    out.push({ objectId, partIndex, subtype })
  }
  return out.length > 0 ? out : undefined
}

/** Part-placement changes for parts whose in-project object is still placed (keyed objectId:partIndex). */
function collectPartTransforms(state: EditorState): SceneEdit['partTransforms'] {
  if (!state.partTransforms) return undefined
  const placed = placedObjectIds(state)
  const out: NonNullable<SceneEdit['partTransforms']> = []
  for (const [key, matrix] of Object.entries(state.partTransforms)) {
    const parsedKey = parsePartSlotKey(key)
    if (!parsedKey) continue
    const { objectId, partIndex } = parsedKey
    if (!placed.has(objectId) || matrix.length !== 12) continue
    out.push({ objectId, partIndex, matrix: [...matrix] })
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
  const importByObjectId = importIdByReplacedObjectId(state)
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

/**
 * Placement changes for a multi-solid IMPORT's solids, keyed by import + 0-based solid index:
 * the import counterpart of {@link collectPartTransforms}, which can only address parts that
 * already have baked 3MF ids. Without this an import sub-part could be dragged with the gizmo and
 * the move would be silently lost on save.
 */
function collectImportPartTransforms(state: EditorState): SceneEdit['importPartTransforms'] {
  if (!state.partTransforms) return undefined
  const importByObjectId = importIdByReplacedObjectId(state)
  if (importByObjectId.size === 0) return undefined
  const out: NonNullable<SceneEdit['importPartTransforms']> = []
  for (const [key, matrix] of Object.entries(state.partTransforms)) {
    const [objectIdRaw, partRaw] = key.split(':')
    const objectId = Number.parseInt(objectIdRaw ?? '', 10)
    const partIndex = Number.parseInt(partRaw ?? '', 10)
    if (!Number.isInteger(objectId) || !Number.isInteger(partIndex) || matrix.length !== 12) continue
    const importId = importByObjectId.get(objectId)
    if (!importId) continue
    out.push({ importId, partIndex, matrix: [...matrix] })
  }
  return out.length > 0 ? out : undefined
}

/** Per-part process overrides for parts whose object is still placed (keyed objectId:partIndex). */
function collectPartProcessOverrides(state: EditorState): SceneEdit['partProcessOverrides'] {
  if (!state.partProcessOverrides) return undefined
  const placed = placedObjectIds(state)
  const bodyRemoved = bodyRemovedHostIds(state)
  const out: NonNullable<SceneEdit['partProcessOverrides']> = []
  for (const [key, overrides] of Object.entries(state.partProcessOverrides)) {
    const parsedKey = parsePartSlotKey(key)
    if (!parsedKey) continue
    const { objectId, partIndex } = parsedKey
    if (!placed.has(objectId)) continue
    if (partIndex === BODY_PART_INDEX && bodyRemoved.has(objectId)) continue
    out.push({ objectId, partIndex, overrides })
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
 * every instance of an object, so we dedupe by objectId + the part's ORDINAL; the slice-time
 * writer rewrites those parts' `extruder` metadata to persist material reassignments.
 */
function collectPartFilaments(state: EditorState): SceneEdit['partFilaments'] {
  const byKey = new Map<string, { objectId: number; partIndex: number; filamentId: number }>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind !== 'object') continue
      for (const part of instance.parts) {
        if (part.filamentId == null) continue
        byKey.set(partSlotKey(instance.objectId, part.partIndex), {
          objectId: instance.objectId,
          partIndex: part.partIndex,
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
  const importByObjectId = importIdByReplacedObjectId(state)
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
 * Single-object project state for "Export object as 3MF": the chosen instance alone on
 * one plate (re-indexed to 1, centred on its bed), deep-copied together with every
 * session map so the bake keeps the object's parts, per-part filaments/types/transforms,
 * paint, added part volumes, name override, and repair mark: `buildSceneEdit`'s
 * collectors already prune each map to placed instances, so entries for the objects left
 * behind simply drop out. Plate-scoped choreography (plate name, layer filament changes,
 * pauses, prime tower) is deliberately NOT carried over: it belongs to the source plate's
 * composition, not the object. Returns null when `key` is not placed.
 */
export function buildSingleObjectExportState(
  state: EditorState,
  key: string,
  /**
   * The object's rendered XY footprint centre in PLATE coordinates (helper volumes excluded, as
   * `printableMeshBox` gives it). Required to centre the export correctly: see below. When the
   * caller has no rendered group for the object, the placement is left untouched rather than
   * guessed, because guessing is what produced the half-off-the-bed export.
   */
  footprintCenter?: { x: number; y: number }
): EditorState | null {
  const sourcePlate = state.plates.find((plate) => plate.instances.some((instance) => instance.key === key))
  if (!sourcePlate) return null
  const cloned = cloneEditorState(state)
  const plate = cloned.plates.find((entry) => entry.index === sourcePlate.index)
  const instance = plate?.instances.find((entry) => entry.key === key)
  if (!plate || !instance) return null
  if (footprintCenter) {
    const centerX = (plate.bed.minX + plate.bed.maxX) / 2
    const centerY = (plate.bed.minY + plate.bed.maxY) / 2
    // Centre by SHIFTING the placement, never by assigning the bed centre to `position`.
    // `position` is the instance transform's translation, the object's local ORIGIN, not its
    // bounding-box centre, and a Bambu object's mesh routinely carries plate coordinates with a
    // near-identity transform. Assigning there moved the object by the whole origin-to-centroid
    // offset, which is what exported models half off the bed. Same rule as placing an added
    // model (`addInstanceToActivePlate` takes a mesh centroid for exactly this reason).
    // A shearing instance is moved by BOTH its position and its exact matrix, or the two disagree
    // about where the object is; {@link placeInstanceAt} is the one place that rule lives.
    placeInstanceAt(
      instance,
      instance.position.x + (centerX - footprintCenter.x),
      instance.position.y + (centerY - footprintCenter.y)
    )
  }
  return {
    ...cloned,
    plates: [{
      ...plate,
      index: 1,
      // A synthetic plate, not the source plate at a new position: its own identity keeps the
      // export render from ever being attributed to the source plate's caches.
      plateId: mintPlateId(),
      sourcePlateIndex: null,
      name: null,
      // A synthetic plate inherits everything, exactly like a newly added one: the source plate's
      // lock, bed type, print sequence and vase mode describe THAT plate, and spreading them here
      // exports a project whose only plate silently refuses Auto-arrange, Fill bed and Auto-orient
      // on a bed type nobody chose for it. This is the mint site the constant exists for.
      ...INHERITED_PLATE_SETTINGS,
      instances: [instance],
      primeTower: null,
      filamentChanges: undefined,
      filamentChangesOverride: undefined,
      pauses: undefined,
      pausesOverride: undefined
    }]
  }
}

/**
 * Emit the independent copies that still have a placed instance: copying an object and then
 * deleting the copy must not ship a dangling clone (which the bake would reject).
 */
function collectObjectClones(state: EditorState): SceneEdit['objectClones'] {
  if (!state.objectClones) return undefined
  const placed = new Set<number>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      if (instance.source.kind === 'object') placed.add(instance.objectId)
    }
  }
  const out: NonNullable<SceneEdit['objectClones']> = []
  for (const [objectIdRaw, sourceObjectId] of Object.entries(state.objectClones)) {
    const objectId = Number.parseInt(objectIdRaw, 10)
    if (!Number.isInteger(objectId) || objectId >= 0 || !placed.has(objectId)) continue
    out.push({ objectId, sourceObjectId })
  }
  return out.length > 0 ? out : undefined
}

/**
 * The in-project object an id ultimately copies FROM. A copy of a copy still has to name a real
 * object, because the bake duplicates the source's baked XML: chaining placeholders would name
 * an object that does not exist in the base file.
 */
export function objectCloneSource(state: EditorState, objectId: number): number {
  return state.objectClones?.[objectId] ?? objectId
}

/**
 * Give `objectId`'s session edits to `cloneObjectId` as well, so an independent copy starts
 * IDENTICAL to its source and then diverges. The copy inherits the source's BAKED state through
 * the server-side object copy; this is the other half, everything edited in this session but not
 * yet saved. Keys that address a part are re-keyed onto the copy, keeping the SOURCE's part
 * address (mesh id for paint, ordinal for the rest), which is what the bake's clone pre-pass
 * expects.
 *
 * **Every object-keyed map in {@link EditorState} belongs here.** A map left out does not fail
 * loudly, it makes the copy quietly differ from the thing it was copied from: omitting
 * `removedParts` resurrected volumes the user had deleted from the source, and omitting
 * `repairedObjectIds` left the copy unrepaired while its source repaired.
 */
function copySessionEditsOntoClone(state: EditorState, objectId: number, cloneObjectId: number): void {
  // Two key spaces with one string shape. They are passed their own builder rather than sharing
  // one, because reading a mesh id as an ordinal type-checks and lands on the wrong volume.
  const rekeyParts = (
    map: Record<string, unknown> | undefined,
    keyFor: (owner: number, part: number) => string
  ): void => {
    if (!map) return
    for (const [key, value] of Object.entries(map)) {
      const [ownerRaw, partRaw] = key.split(':')
      if (Number.parseInt(ownerRaw ?? '', 10) !== objectId || partRaw == null) continue
      const cloned = typeof value === 'object' && value !== null
        ? JSON.parse(JSON.stringify(value)) as unknown
        : value
      ;(map as Record<string, unknown>)[keyFor(cloneObjectId, Number.parseInt(partRaw, 10))] = cloned
    }
  }
  rekeyParts(state.supportPaint, supportPaintKey)
  rekeyParts(state.seamPaint, supportPaintKey)
  rekeyParts(state.colorPaint, supportPaintKey)
  rekeyParts(state.fuzzyPaint, supportPaintKey)
  rekeyParts(state.partProcessOverrides, partSlotKey)
  rekeyParts(state.partTypeChanges, partSlotKey)
  rekeyParts(state.partTransforms, partSlotKey)
  rekeyParts(state.partMeshReplacements, partSlotKey)
  if (state.removedParts?.[objectId]) {
    // Base-file ordinals, so they address the copy's volumes exactly as they address the source's:
    // the clone pre-pass duplicates that same object's XML.
    state.removedParts[cloneObjectId] = [...state.removedParts[objectId]!]
  }
  if (state.partOrder?.[objectId]) {
    // Same reasoning: an order is a sequence of base ordinals, and the copy's volumes carry the
    // source's ordinals. Without this the copy's parts came back in the base file's order while
    // the sidebar showed the source's, which is one object rendering two ways.
    state.partOrder[cloneObjectId] = [...state.partOrder[objectId]!]
  }
  if (state.repairedObjectIds?.includes(objectId) && !state.repairedObjectIds.includes(cloneObjectId)) {
    // The copy gets its OWN mesh entry, so a pending repair has to name it too or the save
    // repairs one of the two identical bodies.
    state.repairedObjectIds = [...state.repairedObjectIds, cloneObjectId]
  }
  if (state.heightRanges?.[objectId]) {
    state.heightRanges[cloneObjectId] = state.heightRanges[objectId]!.map(cloneHeightRange)
  }
  if (state.layerHeightProfiles?.[objectId]) {
    state.layerHeightProfiles[cloneObjectId] = [...state.layerHeightProfiles[objectId]!]
  }
  if (state.brimEars?.[objectId]) {
    state.brimEars[cloneObjectId] = state.brimEars[objectId]!.map((ear) => ({ ...ear }))
  }
  if (state.addedParts?.[objectId]) {
    // Fresh keys: the copy's volumes are its own, so removing one must not remove the source's.
    state.addedParts[cloneObjectId] = state.addedParts[objectId]!.map((part) => ({
      ...part,
      key: nextInstanceKey(),
      position: part.position.clone(),
      rotation: part.rotation.clone(),
      scale: part.scale.clone(),
      ...(part.settings ? { settings: { ...part.settings } } : {})
    }))
  }
}

/**
 * What makes two instances LINKED: the identity they share when they are copies of one object.
 *
 * Two identities, because an instance has two ways of being object-backed and only one of them
 * survives a round trip. A file-backed instance is identified by its Bambu `objectId`, which
 * {@link makeInstanceIndependent} reassigns to break a link. A SESSION-added one has no baked
 * object yet (`objectId` is 0 for every import), and its linkage rides in `source`: a linked
 * duplicate copies the `importId` and `replacedObjectId` verbatim, and the bake later hangs both
 * build items off the one mesh object those name.
 *
 * Keying on `objectId` alone is what made the sidebar's `xN` badge appear only after a save and
 * reopen: until the save minted real object ids, every session-added copy compared as `0 === 0`
 * against unrelated imports, so the predicate had to reject them all.
 *
 * Returns null for an instance with no shareable identity, which is never linked to anything.
 */
export function instanceLinkageKey(instance: EditorInstance): string | null {
  if (instance.source.kind === 'object') return `object:${instance.objectId}`
  // `replacedObjectId` first: it is the stable per-object identity the editor already hangs
  // per-object settings on, and "Replace with…" gives it the replaced object's real id, so two
  // instances of a replacement agree on it even though their import is incidental.
  const identity = instance.source.replacedObjectId ?? instance.source.importId
  return identity != null ? `import:${identity}` : null
}

/**
 * Turn an instance into an INDEPENDENT copy of the object it currently places: it stops sharing
 * that object's parts, materials, paint and volumes, and gets its own. Registers the copy in
 * {@link EditorState.objectClones} and snapshots the source's session edits onto it.
 *
 * Mutates `state` and `instance` in place (both are already session-mutable, and the caller records
 * an undo checkpoint first).
 *
 * Both KINDS of instance are handled, and an import-backed one is not the no-op this used to claim.
 * "Independent by nature" was true only while nothing could copy an import: a linked duplicate
 * copies `importId` and `replacedObjectId` verbatim, so two session-added instances shared their
 * object identity (per-object settings, the sidebar's linked badge) AND their mesh, and asking for
 * an independent copy of one silently returned the linked pair it was meant to break.
 *
 * The identity split is all that happens HERE, because it is all that can happen synchronously (the
 * caller runs inside a plate updater). Giving the copy its own MESH means re-staging its import,
 * which is async, and is `restageIndependentCopy` in `EditorView`, exactly as the added volumes
 * already work.
 */
export function makeInstanceIndependent(state: EditorState, instance: EditorInstance): void {
  if (instance.source.kind === 'object') {
    const sourceObjectId = objectCloneSource(state, instance.objectId)
    const cloneObjectId = nextSyntheticObjectId()
    copySessionEditsOntoClone(state, instance.objectId, cloneObjectId)
    if (!state.objectClones) state.objectClones = {}
    state.objectClones[cloneObjectId] = sourceObjectId
    instance.objectId = cloneObjectId
    return
  }

  // An import-backed instance's object identity is `replacedObjectId`: the id per-object settings
  // and added volumes hang off, synthetic for a fresh import and the replaced object's real id for
  // a "Replace with...". Minting a new one is the same move as reassigning `objectId` above.
  const sourceObjectId = instance.source.replacedObjectId
  const cloneObjectId = nextSyntheticObjectId()
  if (sourceObjectId != null) copySessionEditsOntoClone(state, sourceObjectId, cloneObjectId)
  // Deliberately NOT registered in `objectClones`. That registry drives the bake's clone pre-pass,
  // which deep-copies a BAKED object's XML and mesh entry; an import-backed instance has no baked
  // object to copy, the bake builds one from the staged import. Registering it would point the
  // pre-pass at an id no source object exists for.
  instance.source = { ...instance.source, replacedObjectId: cloneObjectId }
}

/**
 * Deep-clone the editable state for the undo/redo history. Transform edits mutate
 * instance position/rotation/scale in place, so snapshots must clone those Three.js
 * objects (and the plate/instance/part structure) to stay independent of later edits.
 *
 * **Plates, instances and parts are COPIED WHOLE and then deep-copied where they are mutable**,
 * never re-listed field by field. A snapshot is what undo restores, so a field a re-list forgets is
 * user state the first Ctrl+Z destroys -- silently, with the model still on screen looking
 * unchanged, and with nothing to fail a typecheck, because every field such a list can drop is
 * optional. The list dropped two before this rule replaced it: `EditorInstancePart.cutConnector`
 * (so one undo exploded a saved cut half into an object row, a body row of the same name and a row
 * per peg, reported on `cat-hs` plate 2) and `EditorPlate.layerHeightLimits` (so one undo dropped
 * the machine's layer band back to a generic default that permits heights the engine responds to by
 * discarding the whole profile).
 *
 * **Copying whole is not free of judgement, and its failure is not loud.** A spread carries a new
 * MUTABLE field by REFERENCE, so a handler that writes into it after `recordHistory()` reaches
 * through into every retained frame, and the undo then restores everything except that field. That
 * is the same silent class as the losses above: nothing throws, nothing renders differently at the
 * moment of the write, and the user sees an undo that half-worked. So a new field that is written
 * IN PLACE still has to be named below. What the rule buys is that forgetting one leaves the value
 * present and wrong for one edit, instead of gone from every undo forever.
 *
 * The top-level {@link EditorState} maps are the deliberate exception, and stay enumerated: each is
 * a nested structure (a map of maps, a map of arrays of objects) needing its own copy rule, so a
 * spread there would carry every new one by reference and be pure false safety.
 */
export function cloneEditorState(state: EditorState): EditorState {
  return {
    ...(state.baseFilamentIds ? { baseFilamentIds: { ...state.baseFilamentIds } } : {}),
    plates: state.plates.map((plate) => ({
      ...plate,
      // The bed's exclude zones are polygons of points, so a one-level spread would share them:
      // the retarget effect REPLACES a plate's bed wholesale today, but a snapshot cannot rest on
      // a promise about how a future edit will be written.
      bed: {
        ...plate.bed,
        excludeAreas: plate.bed.excludeAreas.map((area) => ({ ...area, polygon: area.polygon.map((point) => ({ ...point })) }))
      },
      ...(plate.layerHeightLimits ? { layerHeightLimits: { ...plate.layerHeightLimits } } : {}),
      ...(plate.firstLayerFilamentSequence ? { firstLayerFilamentSequence: [...plate.firstLayerFilamentSequence] } : {}),
      ...(plate.otherLayerFilamentSequences
        ? { otherLayerFilamentSequences: plate.otherLayerFilamentSequences.map((range) => ({ ...range, filamentIds: [...range.filamentIds] })) }
        : {}),
      instances: plate.instances.map((instance) => ({
        ...instance,
        // An import's source object carries the identity per-object settings and added volumes hang
        // off (`replacedObjectId`), and `makeInstanceIndependent` REPLACES it rather than mutating
        // it -- but copy it anyway, so no future in-place write can reach through a snapshot.
        source: instance.source.kind === 'import' ? { ...instance.source } : { kind: 'object' },
        position: instance.position.clone(),
        rotation: instance.rotation.clone(),
        scale: instance.scale.clone(),
        ...(instance.exactMatrix ? { exactMatrix: [...instance.exactMatrix] } : {}),
        ...(instance.brimEars ? { brimEars: instance.brimEars.map((ear) => ({ ...ear })) } : {}),
        ...(instance.heightRanges ? { heightRanges: instance.heightRanges.map(cloneHeightRange) } : {}),
        ...(instance.layerHeightProfile ? { layerHeightProfile: [...instance.layerHeightProfile] } : {}),
        // `transform` is written in place by the part gizmo; everything else on a part is either a
        // scalar or a read-only authoring record (`textInfo` / `svgPart`), which an edit REPLACES
        // rather than mutates, so the snapshot shares those. Same copy as `duplicateInstance`.
        parts: instance.parts.map((part) => ({ ...part, transform: [...part.transform] }))
      })),
      // The tower drag writes x/y on this object; `sizing` is its own record underneath.
      primeTower: plate.primeTower ? { ...plate.primeTower, sizing: { ...plate.primeTower.sizing } } : null,
      ...(plate.filamentChanges ? { filamentChanges: plate.filamentChanges.map((change) => ({ ...change })) } : {}),
      ...(plate.filamentChangesOverride ? { filamentChangesOverride: plate.filamentChangesOverride.map((change) => ({ ...change })) } : {}),
      ...(plate.pauses ? { pauses: plate.pauses.map((pause) => ({ ...pause })) } : {}),
      ...(plate.pausesOverride ? { pausesOverride: plate.pausesOverride.map((pause) => ({ ...pause })) } : {})
    })),
    ...(state.projectAuxiliaries
      ? {
          projectAuxiliaries: {
            files: state.projectAuxiliaries.files.map((file) => ({ ...file })),
            metadata: { ...state.projectAuxiliaries.metadata },
            ...(state.projectAuxiliaries.coverThumbnails
              ? { coverThumbnails: { ...state.projectAuxiliaries.coverThumbnails } }
              : {})
          }
        }
      : {}),
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
    ...(state.fuzzyPaint
      ? {
        fuzzyPaint: Object.fromEntries(
          Object.entries(state.fuzzyPaint).map(([key, codes]) => [key, { ...codes }])
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
    ...(state.partMeshReplacements ? { partMeshReplacements: { ...state.partMeshReplacements } } : {}),
    ...(state.partOrder
      ? {
        partOrder: Object.fromEntries(
          Object.entries(state.partOrder).map(([key, order]) => [key, [...order]])
        )
      }
      : {}),
    ...(state.layerHeightProfiles
      ? {
        layerHeightProfiles: Object.fromEntries(
          Object.entries(state.layerHeightProfiles).map(([key, profile]) => [key, [...profile]])
        )
      }
      : {}),
    ...(state.heightRanges
      ? {
        heightRanges: Object.fromEntries(
          Object.entries(state.heightRanges).map(([key, ranges]) => [key, ranges.map(cloneHeightRange)])
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
    ...(state.repairedFilamentConfigs
      ? {
          repairedFilamentConfigs: Object.fromEntries(
            Object.entries(state.repairedFilamentConfigs).map(([slot, preset]) => [slot, {
              ...preset,
              config: { ...preset.config },
              ...(preset.changedKeys ? { changedKeys: [...preset.changedKeys] } : {})
            }])
          )
        }
      : {}),
    ...(state.repairedObjectIds ? { repairedObjectIds: [...state.repairedObjectIds] } : {}),
    ...(state.settingsRepairStaged ? { settingsRepairStaged: true } : {}),
    ...(state.removedEmbeddedPresets ? { removedEmbeddedPresets: [...state.removedEmbeddedPresets] } : {}),
    ...(state.flushVolumes
      ? {
          flushVolumes: {
            matrix: state.flushVolumes.matrix?.map((block) => block.map((row) => [...row])) ?? null,
            multiplier: [...state.flushVolumes.multiplier],
            ...(state.flushVolumes.primeVolumeMode ? { primeVolumeMode: state.flushVolumes.primeVolumeMode } : {})
          }
        }
      : {}),
    ...(state.objectClones ? { objectClones: { ...state.objectClones } } : {}),
    // A session-added volume is a PART (this plugin's part-is-a-part rule), so it is copied whole
    // like one -- not re-listed. It is also the type that grows fields most often (`textInfo`,
    // `svgPart`, `bambuShape` all arrived after it shipped), and `copySessionEditsOntoClone`
    // already copies these whole, so a re-list here left the two copy paths for one type disagreeing
    // about what an added volume is. Its `soup` is immutable after staging, so snapshots share it.
    ...(state.addedParts
      ? {
        addedParts: Object.fromEntries(
          Object.entries(state.addedParts).map(([key, parts]) => [key, parts.map((part) => ({
            ...part,
            position: part.position.clone(),
            rotation: part.rotation.clone(),
            scale: part.scale.clone(),
            ...(part.settings ? { settings: { ...part.settings } } : {})
          }))])
        )
      }
      : {}),
    // The artwork behind every SVG part. Snapshotted alongside the parts that NAME it, or an undo
    // leaves records pointing at bytes the state no longer holds, which saves a file whose parts
    // reopen as anonymous solids -- indistinguishable from carrying no record at all.
    ...(state.svgSources ? { svgSources: { ...state.svgSources } } : {}),
    // A cut group holds two collections of its own (the pieces, and a record per connector), so the
    // copy has to reach them: a one-level spread shares both with live state.
    ...(state.cutGroups
      ? {
        cutGroups: state.cutGroups.map((group) => ({
          ...group,
          importIds: [...group.importIds],
          connectors: group.connectors.map((connector) => ({ ...connector }))
        }))
      }
      : {}),
    // Undo has to restore deleted parts, so the removal set is part of the snapshot like every
    // other session-owned map. Copied per host, not shared, or an undo frame would keep mutating.
    ...(state.removedParts
      ? { removedParts: Object.fromEntries(Object.entries(state.removedParts).map(([key, indexes]) => [key, [...indexes]])) }
      : {})
  }
}

/**
 * The parts of an object that a material summary or an object-level reassignment applies to:
 * the printed ones. Helper volumes are excluded even when they can hold a filament (a modifier),
 * because the object badge answers "what is this object printed in" and "set all parts' material"
 * must not retarget a modifier region the user deliberately put on another filament.
 */
export function printedParts(instance: EditorInstance): EditorInstancePart[] {
  return instance.parts.filter((part) => !isNonRenderableThreeMfPartSubtype(part.subtype))
}

/**
 * The filament a part actually PRINTS in, which is not the same as the filament it names.
 *
 * A part's own `filamentId` is tri-state: a number is an explicit choice, and null means "not
 * chosen", which the bake resolves to the OBJECT's material
 * (`toExtruder(partFilaments?.get(i) ?? null) ?? objectExtruder` in `bake-documents.ts`). Every
 * surface that shows or renders a part's material must resolve it the same way, or it reports a
 * different material from the one that will be sliced.
 *
 * Resolving the bare part id is what made **Replace object** read as a material change: a
 * replacement's solids all start unassigned, and the id then falls through `resolveColorFilamentId`,
 * whose fallback exists to recolour a DANGLING id (a material the user removed) and so answers with
 * the project's first material. An object that prints in material 5 displayed as material 1 in the
 * sidebar and rendered in material 1's colour in the viewport, on every one of its parts.
 *
 * A helper volume carries no material at all and never inherits one (BambuStudio writes extruder 0
 * and the bake mirrors that), so it resolves to null however its object is assigned.
 */
export function effectivePartFilamentId(
  // `undefined` as well as null, so a session-ADDED volume (whose filamentId is optional) resolves
  // through the same rule as a baked part rather than needing its own.
  part: { filamentId?: number | null; subtype?: string | null },
  instanceFilamentId: number | null
): number | null {
  if (!threeMfPartSubtypeCarriesFilament(part.subtype ?? null)) return null
  return part.filamentId ?? instanceFilamentId
}

/** What a material summary is taken over: enough of a volume to name its filament and its colour. */
interface MaterialVolume { filamentId?: number | null; subtype?: string | null; color?: string | null }

/**
 * Every volume of an object that has a material, in sidebar order.
 *
 * The BODY is one of them where the part list does not describe it (a single-solid import, a
 * primitive, a single-mesh object in a saved project): it carries the object's own `filamentId`,
 * which is the second of the two places a material can live. Written out here rather than at each
 * caller because the two homes are exactly what surfaces keep getting wrong -- see the
 * material-lives-in-one-of-TWO-places rule in this plugin's development notes.
 */
function instanceMaterialVolumes(
  instance: EditorInstance,
  addedParts: readonly EditorAddedPart[]
): MaterialVolume[] {
  const baked = printedParts(instance)
  const added = addedParts.filter(
    (part) => !isNonRenderableThreeMfPartSubtype(canonicalThreeMfPartSubtype(part.subtype))
  )
  if (baked.length > 0) return [...baked, ...added]
  return [{ filamentId: instance.filamentId, color: instance.color }, ...added]
}

/**
 * The material a multi-volume object should advertise: `uniformId` when every printed volume
 * resolves to the same filament (or the object has a single one), otherwise `mixedColors` with the
 * distinct volume colours for the indeterminate swatch. Exactly one of the two is set.
 */
export function summarizeInstanceMaterial(
  instance: EditorInstance,
  resolveId: (id: number | null) => number | null,
  /** Same live-colour resolver the single-material badges use, so a recolour updates the bands. */
  liveColor: (filamentId: number | null, fallback: string | null) => string | null,
  /**
   * The object's session-added volumes, which count exactly like baked parts.
   *
   * Omitting them made the badge LIE: a normal added part inherits an explicit filament on add, so
   * an object whose baked parts are on material 1 and whose added volume is on material 3 summarised
   * as a uniform material 1 -- and it changed on the next save, when the volume became a baked part
   * and joined the summary. Defaulted so callers with no session state (tests, read-only previews)
   * keep the baked-only answer.
   */
  addedParts: readonly EditorAddedPart[] = NO_ADDED_PARTS
): { uniformId: number | null; uniformColor: string | null; mixedColors?: string[] } {
  const parts = instanceMaterialVolumes(instance, addedParts)
  if (parts.length <= 1) {
    return { uniformId: resolveId(parts[0]?.filamentId ?? instance.filamentId), uniformColor: parts[0]?.color ?? instance.color }
  }
  // Unassigned parts inherit the object's material at bake time, so they must not each resolve to
  // the project's first material here: that turned one uniform object into a "mixed" swatch, or
  // into the wrong single material. See effectivePartFilamentId.
  const ids = parts.map((part) => resolveId(effectivePartFilamentId(part, instance.filamentId)))
  const distinct = [...new Set(ids)]
  if (distinct.length === 1) {
    const only = parts[0]
    return { uniformId: distinct[0] ?? null, uniformColor: only?.color ?? instance.color }
  }
  // Keep first-seen order so the bands match the part list's reading order.
  const seen = new Set<number | null>()
  const mixedColors: string[] = []
  parts.forEach((part, index) => {
    const id = ids[index] ?? null
    if (seen.has(id)) return
    seen.add(id)
    mixedColors.push(liveColor(id, part.color ?? null) || 'rgba(255,255,255,0.25)')
  })
  return { uniformId: null, uniformColor: null, mixedColors }
}
