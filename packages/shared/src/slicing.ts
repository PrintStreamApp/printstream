/**
 * Server-side slicing contracts shared by the API, slicer UI, and the
 * standalone BambuStudio CLI worker runtime.
 */
import { z } from 'zod'
import { processSettingOverridesSchema } from './process-settings.js'
import { degenerateTransformMessage, findDegenerateTransformColumn } from './three-mf/transform-validity.js'
import { TEXT_SURFACE_TYPES, type TextInfo } from './three-mf/text-info.js'
import { isSvgArchiveEntry } from './three-mf/svg-shape.js'
import type { BambuStudioShape, SvgPartRecord } from './three-mf/svg-shape.js'

/**
 * Largest source SVG a save may carry, per artwork.
 *
 * Sized against the API's `express.json({ limit: '4mb' })` body cap rather than against anything
 * about SVG: the transport rejects an oversized body before validation runs, so a limit above that
 * could never be reported as a useful error. Left room for the rest of the edit, which on a busy
 * project is far from empty.
 */
export const MAX_SVG_SOURCE_BYTES = 1_500_000

/**
 * Total artwork one save may carry, across every entry.
 *
 * The per-artwork cap alone bounds nothing useful: 64 entries at the single-file limit is far past
 * the API's 4mb body cap, so three ordinary-sized drawings could brick save AND slice on a 413 that
 * names nothing. The import guard only ever sees one file, so the ceiling has to be enforced here
 * too, where the whole set is visible.
 */
export const MAX_SVG_SOURCES_TOTAL_BYTES = 2_500_000

/** UTF-8 byte length, which is what the transport limit counts. `String.length` counts UTF-16 units. */
export function svgSourceByteLength(markup: string): number {
  return new TextEncoder().encode(markup).length
}

export const slicingPresetKindSchema = z.enum(['machine', 'process', 'filament'])
export type SlicingPresetKind = z.infer<typeof slicingPresetKindSchema>

export const slicingPresetSourceSchema = z.enum(['builtin', 'custom'])
export type SlicingPresetSource = z.infer<typeof slicingPresetSourceSchema>

export const slicerFamilySchema = z.enum(['bambustudio', 'orcaslicer'])
export type SlicerFamily = z.infer<typeof slicerFamilySchema>

export const slicingTargetDescriptorSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  family: slicerFamilySchema,
  version: z.string().trim().min(1),
  slicerName: z.string().trim().min(1),
  supportsEstimateModeMachineSwitch: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  /**
   * Bundled from a Bambu PRE-release. Selectable so a project saved by a beta desktop build can be
   * sliced at all, but never chosen automatically: the picker labels it and the default-selection
   * fallback skips it. Defaults false so an older slicer service reads as stable.
   */
  prerelease: z.boolean().default(false)
})
export type SlicingTargetDescriptor = z.infer<typeof slicingTargetDescriptorSchema>

export const slicingPresetSummarySchema = z.object({
  id: z.string().trim().min(1),
  source: slicingPresetSourceSchema,
  kind: slicingPresetKindSchema,
  name: z.string().trim().min(1),
  /**
   * The preset this one `inherits` from, when it is a DERIVATIVE rather than a base preset.
   *
   * An IDENTITY fact about the preset itself, which is why it sits with the identity keys and is
   * never merged down from a parent (see `pickProfileMetadata`), a child of a child still names
   * its own immediate parent. Absent means the preset is its own base.
   *
   * Carried because a derivative inherits its parent's `filament_id`, so it cannot be told apart
   * from the preset it was derived from by identity alone. BambuStudio resolves an AMS tray to a
   * preset with `AMSMaterialsSetting::get_filament_by_id`, which skips any preset that is not its
   * own base (`filaments.get_preset_base(preset) != &preset`) before comparing `filament_id`.
   *
   * PROCESS presets need it for a second reason: a `project:` preset (the 3MF's own, minted in the
   * browser) carries no declared compatibility at all, so its parent is the only record of which
   * machine it was authored for, and it is the record the ENGINE judges the project by. See
   * `derivedFromADifferentPrinterModel`.
   */
  derivedFromPresetName: z.string().trim().min(1).optional(),
  /** BambuStudio filament profile ids from `filament_id`; used to match printer AMS/tray ids exactly. */
  filamentIds: z.array(z.string().trim().min(1)).optional(),
  /**
   * BambuStudio filament material family from `filament_type`, i.e. the BASE polymer
   * (`"PLA"` even for a support filament); preferred over parsing the profile name.
   * For the type users see and filter by, derive it with `resolveDisplayFilamentType`,
   * do not compare this field against a `PLA-S`-style display type.
   */
  filamentType: z.string().trim().min(1).optional(),
  /**
   * BambuStudio's `filament_is_support` flag. Carried explicitly because the derived
   * display type (`PLA-S`) cannot be recovered from `filamentType` alone: matching a
   * project's `PLA-S` filament against support presets typed `PLA` is what hid every
   * valid support preset from the material picker (issue #66).
   */
  filamentIsSupport: z.boolean().optional(),
  /** BambuStudio filament vendor from `filament_vendor`; preferred over parsing the profile name. */
  filamentVendor: z.string().trim().min(1).optional(),
  /** Process-only: `layer_height` in mm; preferred over scraping a `0.20mm` token out of the profile name. */
  layerHeight: z.number().positive().optional(),
  /**
   * Machine-only: the layer-height envelope the machine's extruders support (`min_layer_height` /
   * `max_layer_height`, reduced to the tightest bound across extruders). Lets a machine switch warn
   * that the project's layer height no longer fits, instead of letting BambuStudio clamp it silently.
   */
  minLayerHeight: z.number().positive().optional(),
  maxLayerHeight: z.number().positive().optional(),
  printerModels: z.array(z.string().trim().min(1)).optional(),
  compatiblePrinters: z.array(z.string().trim().min(1)).optional(),
  compatiblePrints: z.array(z.string().trim().min(1)).optional(),
  nozzleDiameters: z.array(z.number().positive()).optional(),
  plateTypes: z.array(z.string().trim().min(1)).optional(),
  compatiblePrintersCondition: z.string().trim().optional(),
  compatiblePrintsCondition: z.string().trim().optional(),
  /** Machine-only: `default_print_profile`; the process preset BambuStudio falls back to for this printer. */
  defaultProcessProfile: z.string().trim().min(1).optional(),
  /** Machine-only: `default_filament_profile`; the filament presets BambuStudio falls back to for this printer. */
  defaultFilamentProfiles: z.array(z.string().trim().min(1)).optional(),
  updatedAt: z.string().nullable().optional()
})
export type SlicingPresetSummary = z.infer<typeof slicingPresetSummarySchema>

export const slicingPresetsResponseSchema = z.object({
  profiles: z.array(slicingPresetSummarySchema)
})
export type SlicingPresetsResponse = z.infer<typeof slicingPresetsResponseSchema>

export const uploadSlicingPresetSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  kind: slicingPresetKindSchema.optional(),
  fileName: z.string().trim().min(1).max(255).optional(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  content: z.string().trim().min(1).max(2 * 1024 * 1024),
  /** When true, overwrite existing same-name presets instead of reporting them as conflicts. */
  overwrite: z.boolean().optional()
})
export type UploadSlicingPreset = z.infer<typeof uploadSlicingPresetSchema>

export const slicingPresetResponseSchema = z.object({
  profile: slicingPresetSummarySchema,
  /** Names of existing same-kind presets overwritten by this upload (for warning the user). */
  replaced: z.array(z.string()).default([])
})
export type SlicingPresetResponse = z.infer<typeof slicingPresetResponseSchema>

export const slicingTargetModeSchema = z.enum(['realPrinter', 'manualProfile'])
export type SlicingTargetMode = z.infer<typeof slicingTargetModeSchema>

export const slicingToolheadSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  nozzleDiameter: z.number().positive().nullable().optional(),
  nozzleFlow: z.enum(['standard', 'high', 'tpu-high']).nullable().optional(),
  position: z.enum(['left', 'right', 'single']).nullable().optional()
})
export type SlicingToolhead = z.infer<typeof slicingToolheadSchema>

export const slicingFilamentMappingSchema = z.object({
  projectFilamentId: z.number().int().positive(),
  material: z.string().trim().min(1).nullable().optional(),
  color: z.string().trim().min(1).nullable().optional(),
  source: z.enum(['ams', 'externalSpool', 'manual']).default('manual'),
  trayId: z.number().int().nonnegative().nullable().optional(),
  toolheadId: z.string().trim().min(1).nullable().optional(),
  profileId: z.string().trim().min(1).nullable().optional(),
  /**
   * Per-MATERIAL filament setting overrides from the material settings dialog ("save in this 3MF"
   * / apply-to-this-slice). Sparse map of changed keys applied on top of THIS slot's resolved
   * filament profile at slice time: unlike the target-level `filamentSettingOverrides`, which
   * applies to every filament. Merged over the target-level map, this slot's values winning.
   */
  settingOverrides: processSettingOverridesSchema.optional()
})
export type SlicingFilamentMapping = z.infer<typeof slicingFilamentMappingSchema>

const slicingBaseTargetSchema = z.object({
  plateType: z.string().trim().min(1).nullable().optional(),
  nozzleDiameters: z.array(z.number().positive()).optional(),
  toolheads: z.array(slicingToolheadSchema).optional(),
  filamentMappings: z.array(slicingFilamentMappingSchema).optional(),
  processProfileId: z.string().trim().min(1).nullable().optional(),
  printerProfileId: z.string().trim().min(1).nullable().optional(),
  /**
   * Per-slice process (quality) setting overrides. Sparse map of changed keys
   * applied on top of the resolved process profile before slicing.
   */
  processSettingOverrides: processSettingOverridesSchema.optional(),
  /**
   * Project-local MACHINE (printer) setting overrides: the printer's answer to
   * `processSettingOverrides`, applied on top of the resolved machine preset. Lets a project carry
   * a modified printer without minting a global preset, exactly as a modified process does.
   * Applied AFTER the machine step, since they are the same keys the preset writes.
   */
  machineSettingOverrides: processSettingOverridesSchema.optional(),
  /**
   * Per-slice filament setting overrides (e.g. `filament_flow_ratio`). Sparse map
   * of changed keys applied on top of every resolved filament profile before
   * slicing: used to apply a saved flow-ratio calibration at slice time.
   */
  filamentSettingOverrides: processSettingOverridesSchema.optional()
})

export const slicingRealPrinterTargetSchema = slicingBaseTargetSchema.extend({
  mode: z.literal('realPrinter'),
  printerId: z.string().trim().min(1)
})
export type SlicingRealPrinterTarget = z.infer<typeof slicingRealPrinterTargetSchema>

export const slicingManualProfileTargetSchema = slicingBaseTargetSchema.extend({
  mode: z.literal('manualProfile'),
  printerModel: z.string().trim().min(1).default('unknown'),
  printerProfileId: z.string().trim().min(1),
  /**
   * The user PICKED this machine preset, as opposed to the client's cascade deriving it.
   *
   * Load-bearing for saves, not slices. `printerProfileId` is always populated: the editor
   * resolves one whether or not anyone chose it, and for a project naming a preset this workspace
   * does not hold, that resolution falls back to the first catalogue profile matching the model.
   * Without this flag the server cannot tell a pick from a fallback, so an ordinary save of a
   * project carrying a hand-tuned BambuStudio printer preset re-authored it onto a stock one and
   * threw away its start G-code, accelerations and limits. Absent means "not stated": treated as
   * NOT chosen, which is the preserving direction.
   */
  printerProfileChosen: z.boolean().optional()
})
export type SlicingManualProfileTarget = z.infer<typeof slicingManualProfileTargetSchema>

export const slicingTargetSchema = z.discriminatedUnion('mode', [
  slicingRealPrinterTargetSchema,
  slicingManualProfileTargetSchema
])
export type SlicingTarget = z.infer<typeof slicingTargetSchema>

export const sceneEditVec3Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite()
})
export type SceneEditVec3 = z.infer<typeof sceneEditVec3Schema>

/**
 * A 12-element 3MF transform (column-major 3x3 followed by translation), sanity-guarded.
 *
 * The guard exists because a client-side transform bug once wrote part matrices with scale
 * factors around 1e7–1e13 (and near-zero counterparts) into saved projects; those degenerate
 * volumes overflow the slicer's fixed-point coordinates and poison the file permanently. Bounds
 * are generous, a print bed is ~350 mm and legitimate scales sit within a few orders of
 * magnitude of 1, so real content never trips them: every element must be finite and below
 * 1e6 in magnitude, and each basis column of the 3x3 must have a length in [1e-6, 1e6]
 * (rejecting both exploded and collapsed-to-degenerate axes).
 */
export const threeMfTransformSchema = z.array(z.number().finite().gt(-1e6).lt(1e6)).length(12)
  .superRefine((elements, context) => {
    // The rule itself lives in `three-mf/transform-validity.ts` because the TRS form composes to
    // these same twelve numbers and has to be held to it too. Inlined here, it guarded `matrix` and
    // nothing else, so an identical transform was refused on one field and written from another.
    const degenerate = findDegenerateTransformColumn(elements)
    if (degenerate) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: degenerateTransformMessage(degenerate) })
    }
  })

/**
 * One placed model instance in an edited arrangement. References its geometry either by Bambu
 * `objectId` (already present in the base project's `model_settings.config`) or by `importId` (a
 * foreign mesh staged via the import endpoint and baked into the 3MF on save/slice). Exactly one of
 * the two must be set. Multiple instances may share an `objectId`/`importId` to clone the same model.
 * Placement is plate-local and decomposed (matching the editor's transform gizmos): `position` in mm
 * from the plate centre, `rotation` in radians as an XYZ Euler triple, and per-axis `scale`. The
 * backend recomposes these into the 3MF build-item transform and re-homes the instance onto
 * `plateIndex`.
 */
export const sceneEditInstanceSchema = z.object({
  /**
   * An in-project object's Bambu id, or a NEGATIVE placeholder naming an independent copy declared
   * in {@link sceneEditObjectCloneSchema} (resolved to a real id by the bake's clone pre-pass).
   */
  objectId: z.number().int().refine((value) => value !== 0, 'objectId must not be 0').optional(),
  /** Staged import this instance places (see `stagedImportSchema`); baked into a new 3MF object. */
  importId: z.string().trim().min(1).optional(),
  /** 1-based plate this instance is placed on. */
  plateIndex: z.number().int().positive(),
  position: sceneEditVec3Schema,
  rotation: sceneEditVec3Schema,
  scale: sceneEditVec3Schema,
  /**
   * Optional full local transform (12 numbers, column-major 3x3 + translation).
   * When present it is used verbatim instead of composing translate*rotate*scale:
   * needed because world-space scale on a rotated object produces a shear that the
   * decomposed T*R*S form can't represent. position/rotation/scale stay for display.
   */
  matrix: threeMfTransformSchema.optional(),
  /** Optional per-instance filament (1-based project filament id) override. */
  filamentId: z.number().int().positive().nullable().optional(),
  /**
   * Whether this instance prints. Mirrors BambuStudio's per-object "Printable" toggle: a
   * non-printable instance is greyed out in the editor and excluded from the slice, but is
   * kept in the saved 3MF (written as `printable="0"` on its build `<item>`) so it can be
   * re-enabled later. Omitted/undefined means printable (the default), so unchanged projects
   * don't grow the contract.
   */
  printable: z.boolean().optional()
}).refine((value) => (value.objectId == null) !== (value.importId == null), {
  message: 'Each instance must reference exactly one of objectId or importId'
})
export type SceneEditInstance = z.infer<typeof sceneEditInstanceSchema>

export const sceneEditPlateSchema = z.object({
  index: z.number().int().positive(),
  /**
   * Which plate of the BASE project this one was, when it came from there.
   *
   * Mirrors `SceneEditFilament.sourceIndex`, and exists for the same reason: `index` is a POSITION
   * and the editor renumbers it to a contiguous 1..N run on every add, delete and reorder, so after
   * one of those the bake cannot tell which source plate became which. Without it a stale
   * `slice_info` record binds to whatever plate slid into its number, and the plate reports another
   * plate's weight and time as its own.
   *
   * Null for a plate the session added; absent from an older client or a hand-built request, which
   * the bake treats conservatively rather than guessing.
   */
  sourceIndex: z.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(255).nullable().optional(),
  plateType: z.string().trim().min(1).nullable().optional(),
  /** Prime/wipe tower lower-left corner (plate-local) to write as wipe_tower_x/y. */
  primeTower: z.object({ x: z.number().finite(), y: z.number().finite() }).nullable().optional()
})
export type SceneEditPlate = z.infer<typeof sceneEditPlateSchema>

/**
 * A full edited plate arrangement produced by the 3D editor. `plates` is the ordered set of plates
 * (1-based, contiguous) and `instances` is the flat list of placed models across all of them.
 * Instances may reference base-project geometry (`objectId`) or staged imports (`importId`); the
 * latter are tessellated foreign STL/STEP meshes baked into the output 3MF. Applied by the slice-time
 * / save-time 3MF builder.
 */
/**
 * Per-part filament reassignment. Filament is a property of an object's part (a mesh
 * component), shared across every instance of that object, so it is keyed by the source
 * `objectId` + the part's `componentObjectId` rather than per placed instance. Applied by
 * rewriting the part's `extruder` metadata in `model_settings.config` at slice/save time.
 */
export const sceneEditPartFilamentSchema = z.object({
  /** In-project object id, or a NEGATIVE clone placeholder (see `sceneEditObjectCloneSchema`). */
  objectId: z.number().int().refine((value) => value !== 0, 'objectId must not be 0'),
  /**
   * The part's 0-based ORDINAL within its object: BambuStudio's own part identity
   * (`bbs_3mf.cpp _handle_start_config_volume` keys a volume by `volumes.size()` as it parses, i.e.
   * document order). The `<part id>` / `<component objectid>` attribute is a MESH reference and is
   * NOT unique: BambuStudio deliberately writes the same id for every volume sharing a mesh
   * (`m_share_mesh`), so an object with four modifier cubes cut from one cube mesh has four parts
   * all reading id 22. Keying on that made an edit to one of them hit all four.
   */
  partIndex: z.number().int().nonnegative(),
  filamentId: z.number().int().positive()
})
export type SceneEditPartFilament = z.infer<typeof sceneEditPartFilamentSchema>

/**
 * Per-PART process overrides: process settings on one part (volume) of an object, separate from
 * the object's overall overrides (BambuStudio's per-volume config). Keyed by the object id + the
 * part's ORDINAL (`partIndex`); written as `<metadata>` inside that part's `model_settings` block.
 * Like {@link sceneEditPartFilamentSchema}, a part is shared by every instance of the object.
 */
export const sceneEditPartProcessOverrideSchema = z.object({
  /** In-project object id, or a NEGATIVE clone placeholder (see `sceneEditObjectCloneSchema`). */
  objectId: z.number().int().refine((value) => value !== 0, 'objectId must not be 0'),
  /**
   * The part's 0-based ORDINAL within its object: BambuStudio's own part identity
   * (`bbs_3mf.cpp _handle_start_config_volume` keys a volume by `volumes.size()` as it parses, i.e.
   * document order). The `<part id>` / `<component objectid>` attribute is a MESH reference and is
   * NOT unique: BambuStudio deliberately writes the same id for every volume sharing a mesh
   * (`m_share_mesh`), so an object with four modifier cubes cut from one cube mesh has four parts
   * all reading id 22. Keying on that made an edit to one of them hit all four.
   */
  partIndex: z.number().int().nonnegative(),
  overrides: processSettingOverridesSchema
})
export type SceneEditPartProcessOverride = z.infer<typeof sceneEditPartProcessOverrideSchema>

/**
 * Per-object display-name override (user renamed an object in the editor's object
 * list). Keyed like an instance reference, by base-project `objectId` or by staged
 * `importId` (resolved to its baked object id at write time), and applied by
 * rewriting the object's `name` metadata in `model_settings.config`. The name is a
 * label only; it does not affect the sliced G-code.
 */
export const sceneEditObjectNameSchema = z.object({
  /** In-project object id, or a NEGATIVE clone placeholder (see `sceneEditObjectCloneSchema`). */
  objectId: z.number().int().refine((value) => value !== 0, 'objectId must not be 0').optional(),
  importId: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).max(255)
}).refine((value) => (value.objectId == null) !== (value.importId == null), {
  message: 'Each object name override must reference exactly one of objectId or importId'
})
export type SceneEditObjectName = z.infer<typeof sceneEditObjectNameSchema>

/**
 * Per-part triangle-paint state (Bambu Studio's "support painting" and "seam painting"
 * brushes share this shape). Paint lives on a part's mesh triangles, shared by every
 * instance of the object, so it is keyed like {@link sceneEditPartFilamentSchema} by
 * `objectId` + `componentObjectId`. `triangles` is the COMPLETE post-edit paint map for
 * the part: triangle index (in mesh order) to the Bambu/PrusaSlicer paint code (`'4'` =
 * whole-triangle enforcer, `'8'` = whole-triangle blocker; longer hex strings are
 * preserved sub-triangle split codes from the source file). Triangles absent from the
 * map have their paint removed. Parts the user never painted are omitted entirely,
 * leaving the source mesh untouched byte-for-byte.
 */
/**
 * Upper bound on a single triangle's paint code length. A sub-triangle split code grows with
 * subdivision depth (the brush splits to {@link MAX_SPLIT_DEPTH}=12 near painted boundaries), so
 * codes routinely run into the hundreds, and occasionally low thousands, of hex chars; the old
 * 64-char cap silently rejected any deeply-painted part on save. This is a generous sanity guard
 * only (the 4MB JSON body limit is the real DoS bound); it must stay well above anything the
 * editor's encoder or a source 3MF can legitimately produce so a save never fails on valid paint.
 */
export const MAX_PAINT_CODE_LENGTH = 100_000
export const sceneEditPartPaintSchema = z.object({
  /** In-project object id, or a NEGATIVE clone placeholder (see `sceneEditObjectCloneSchema`). */
  objectId: z.number().int().refine((value) => value !== 0, 'objectId must not be 0'),
  componentObjectId: z.number().int().positive(),
  triangles: z.record(
    z.string().regex(/^(0|[1-9]\d{0,8})$/),
    z.string().regex(/^[0-9A-Fa-f]+$/).max(MAX_PAINT_CODE_LENGTH)
  )
})
export type SceneEditPartPaint = z.infer<typeof sceneEditPartPaintSchema>

/** One layer-based filament change: swap to `filamentId` at print height `z` (mm). */
export const sceneEditFilamentChangeSchema = z.object({
  z: z.number().positive().max(1000),
  filamentId: z.number().int().positive(),
  /** Display colour written to the sidecar's `color` attribute (slicer metadata only). */
  color: z.string().trim().min(1).max(32).optional()
})
export type SceneEditFilamentChange = z.infer<typeof sceneEditFilamentChangeSchema>

/**
 * Per-plate layer-based filament changes (Bambu Studio's layer-slider "change
 * filament"), written as ToolChange entries in `Metadata/custom_gcode_per_layer.xml`.
 * Listed plates have their tool-change entries REPLACED by `changes` (empty array
 * clears them); pause/custom entries and unlisted plates are preserved from the
 * source file. Only takes effect when the project prints multiple filaments.
 */
export const sceneEditPlateFilamentChangesSchema = z.object({
  plateIndex: z.number().int().positive(),
  changes: z.array(sceneEditFilamentChangeSchema).max(64)
})
export type SceneEditPlateFilamentChanges = z.infer<typeof sceneEditPlateFilamentChangesSchema>

/**
 * One layer pause: printing stops just before the layer whose top is `z` (mm) starts.
 * The slicer snaps `z` to the nearest layer at slice time (BambuStudio semantics), so
 * the pause survives layer-height changes without a stored layer index.
 */
export const sceneEditPauseSchema = z.object({
  z: z.number().positive().max(1000)
})
export type SceneEditPause = z.infer<typeof sceneEditPauseSchema>

/**
 * Per-plate layer pauses (Bambu Studio's layer-slider "add pause"), written as
 * PausePrint entries in `Metadata/custom_gcode_per_layer.xml`. Listed plates have
 * their pause entries REPLACED by `pauses` (empty array clears them); other entry
 * types and unlisted plates are preserved from the source file.
 */
export const sceneEditPlatePausesSchema = z.object({
  plateIndex: z.number().int().positive(),
  pauses: z.array(sceneEditPauseSchema).max(64)
})
export type SceneEditPlatePauses = z.infer<typeof sceneEditPlatePausesSchema>

/** One manual brim ear: position in OBJECT-LOCAL mm plus the ear radius. */
export const sceneEditBrimEarSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  /** Ear radius in mm (BambuStudio's `head_front_radius`). */
  radius: z.number().positive().max(50)
})
export type SceneEditBrimEar = z.infer<typeof sceneEditBrimEarSchema>

/**
 * Per-object manual brim ears (BambuStudio/Orca's "brim ears" gizmo). Ears are an
 * object-level property shared by every instance, stored in object-local coordinates and
 * written to `Metadata/brim_ear_points.txt` at save/slice time. The array is the
 * COMPLETE desired set for the object; an object with an entry and zero points has its
 * ears removed. Objects without an entry keep the source file's ears. Ears only take
 * effect when the process `brim_type` is `brim_ears`.
 */
/** Cap on bands per object: past this the plate is a gradient, not a set of deliberate zones. */
export const MAX_HEIGHT_RANGES_PER_OBJECT = 64

/**
 * One height range modifier: a Z band in OBJECT space (z=0 at the object's underside, raft
 * excluded) whose process-setting overrides apply to the layers inside it. The band is
 * `[minZ, maxZ)` — closed at the bottom, open at the top, matching BambuStudio's slicer.
 *
 * `settings` must include `layer_height`: BambuStudio reads it without checking the key exists
 * and null-derefs otherwise (see `three-mf/layer-config-ranges.ts`).
 */
export const sceneEditHeightRangeSchema = z.object({
  minZ: z.number().min(0).max(10_000),
  maxZ: z.number().min(0).max(10_000),
  settings: processSettingOverridesSchema
}).refine((range) => range.maxZ > range.minZ, 'maxZ must be above minZ')
export type SceneEditHeightRange = z.infer<typeof sceneEditHeightRangeSchema>

/**
 * Per-object height range modifiers (BambuStudio's `layer_config_ranges`), written to
 * `Metadata/layer_config_ranges.xml`. Ranges are an object-level property shared by every
 * instance. The array is the COMPLETE desired set for the object; an object with an entry and
 * zero ranges has its bands removed, and objects without an entry keep the source file's.
 */
export const sceneEditObjectHeightRangesSchema = z.object({
  /** In-project object id, or a NEGATIVE clone placeholder (see `sceneEditObjectCloneSchema`). */
  objectId: z.number().int().refine((value) => value !== 0, 'objectId must not be 0'),
  ranges: z.array(sceneEditHeightRangeSchema).max(MAX_HEIGHT_RANGES_PER_OBJECT)
})
export type SceneEditObjectHeightRanges = z.infer<typeof sceneEditObjectHeightRangesSchema>

/**
 * Per-object variable layer height (BambuStudio's `layer_height_profile`), written to
 * `Metadata/layer_heights_profile.txt`. A flat array of alternating z/height pairs in OBJECT space,
 * linearly interpolated between control points. The array is the COMPLETE desired profile; an
 * object with an entry and an empty profile has its curve removed.
 *
 * NOTE the precedence: a profile OVERRIDES the `layer_height` of any height range on the same
 * object (`PrintObject.cpp:3340` only falls back to the ranges when the profile is absent or fails
 * validation). Surfaces that offer both must say so.
 */
export const sceneEditObjectLayerHeightProfileSchema = z.object({
  /** In-project object id, or a NEGATIVE clone placeholder (see `sceneEditObjectCloneSchema`). */
  objectId: z.number().int().refine((value) => value !== 0, 'objectId must not be 0'),
  /** Alternating z, height values (mm). Even length; empty clears the object's profile. */
  profile: z.array(z.number()).max(4096)
})
export type SceneEditObjectLayerHeightProfile = z.infer<typeof sceneEditObjectLayerHeightProfileSchema>

export const sceneEditObjectBrimEarsSchema = z.object({
  /** In-project object id, or a NEGATIVE clone placeholder (see `sceneEditObjectCloneSchema`). */
  objectId: z.number().int().refine((value) => value !== 0, 'objectId must not be 0'),
  points: z.array(sceneEditBrimEarSchema).max(512)
})
export type SceneEditObjectBrimEars = z.infer<typeof sceneEditObjectBrimEarsSchema>

/**
 * One entry in the project's desired ordered filament list. The array as a whole
 * replaces the project's filament set, so adding/removing materials in the editor is
 * expressed as a different-length `filaments` array (Bambu-style add/remove). Position
 * `i` (0-based) becomes filament id `i + 1`. `sourceIndex` is the 0-based index of an
 * existing filament whose slicer settings should seed this slot (so a cloned/new slot
 * inherits a sensible profile); null seeds from the first filament (or profile defaults
 * on a from-scratch project). `nozzleId` carries the per-slot dual-nozzle assignment.
 * Applied by rewriting the filament-indexed arrays in `project_settings.config` (and, for
 * the nozzle, `slice_info.config` group ids) at save/slice time.
 */
export const sceneEditFilamentSchema = z.object({
  color: z.string().trim().min(1),
  type: z.string().trim().min(1).nullable().optional(),
  /**
   * The filament preset name to write to `filament_settings_id` (e.g.
   * "Bambu PETG HF @BBL H2D 0.4 nozzle"). Carries the user's material choice into the saved
   * 3MF so a profile change (e.g. PLA -> PETG) persists, without it the saved file keeps the
   * old preset name and reopens as the previous material. Null/omitted keeps the existing id.
   */
  settingsId: z.string().trim().min(1).nullable().optional(),
  /**
   * The Bambu FILAMENT ID of the preset named in {@link sceneEditFilamentSchema.shape.settingsId}
   * (e.g. `GFG02` for Bambu PETG HF): the preset's own `filament_id`, which the catalogue exposes
   * as `filamentIds`.
   *
   * Load-bearing, and it must describe the SAME preset as `settingsId`: BambuStudio builds the two
   * project arrays as parallel projections of one selected-preset list
   * (`PresetBundle`: `filament_settings_id = [p.name…]`, `filament_ids = [p.filament_id…]`), and it
   * BINDS a slot on the id. A slot naming PETG HF while carrying an ABS id cannot be reconciled, so
   * BambuStudio fabricates a defaults-only project preset per slot named `(<project>.3mf)`, which
   * is what a real ABS-to-PETG switch produced, since `filament_ids` used to be carried over from
   * the old material positionally. Omitted leaves the slot's existing id alone (an unchanged slot);
   * for a slot whose material CHANGED, absent means "unknown", written as BambuStudio writes an
   * unknown id: an empty entry, never the previous material's.
   */
  filamentId: z.string().trim().min(1).nullable().optional(),
  /**
   * The RESOLVED config of the preset named in `settingsId`, so a saved project carries the new
   * material's physics instead of only its name.
   *
   * Without it, a material change drops every non-identity filament array (the old material's
   * temperatures, flow, cooling, retraction) and leans on the slicer to re-derive them from the
   * name at slice time. That is true for our slicer and FALSE for BambuStudio: it opens a project
   * whose slots have no values, has nothing to name a preset after, and shows the slot as an unnamed
   * `(<project>.3mf)` project preset carrying bare defaults. Confirmed by restoring exactly these
   * keys into an affected file, which made BambuStudio show all three materials correctly.
   *
   * Resolved IN THE BROWSER (both hosts already own a `FilamentConfigResolver` for the tune dialog
   * and the changed-vs-preset badge), keeping the editor's authoring client-side like the rest of the
   * model studio. Omitted keeps the previous behaviour, the drop, so a host that cannot resolve a
   * slot is no worse off than before.
   */
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  /**
   * The SYSTEM preset `settingsId` derives from, and the keys it changed: written to the project's
   * `inherits_group` / `different_settings_to_system` so BambuStudio can bind the slot to a USER
   * preset. Carrying the preset's VALUES is not enough on its own: without a named parent
   * BambuStudio skips the normalization step it applies to its own files, and any residual drift
   * makes it mint a `(<project>.3mf)` copy instead. See `filament-preset-binding.ts` for the rule
   * and the measurement. Omitted leaves the slot's existing record alone; `presetInherits: null`
   * says the preset IS a system one, which is a different statement from "unknown".
   */
  presetInherits: z.string().nullable().optional(),
  presetChangedKeys: z.array(z.string()).optional(),
  sourceIndex: z.number().int().nonnegative().nullable().optional(),
  /**
   * Desired runtime nozzle for this slot on a dual-nozzle machine (0 = right, 1 = left),
   * the same nozzle-id space the shared index parser (`extractNozzleMapping`) canonicalises
   * every BambuStudio nozzle-map quirk into. Carries the editor's per-material nozzle pick
   * into the saved 3MF (`filament_nozzle_map` + `slice_info` group ids); without it a
   * changed nozzle is dropped on save and the project reopens on the old nozzle. Null/omitted
   * leaves the slot's existing nozzle assignment untouched (single-nozzle projects, or slots
   * the user did not (re)assign).
   */
  nozzleId: z.number().int().min(0).nullable().optional()
})
export type SceneEditFilament = z.infer<typeof sceneEditFilamentSchema>

/**
 * A client-rendered preview of one plate's edited layout (base64 PNG, no data-URL prefix).
 * BambuStudio's CLI won't regenerate plate thumbnails for a project with explicit (editor-set)
 * positions, so the editor supplies its own render and the slice pipeline embeds it as the
 * plate's `Metadata/plate_N.png` so the library thumbnail reflects the edited arrangement.
 */
export const sceneEditPlateThumbnailSchema = z.object({
  plateIndex: z.number().int().positive(),
  png: z.string().min(1)
})
export type SceneEditPlateThumbnail = z.infer<typeof sceneEditPlateThumbnailSchema>

/**
 * The Bambu volume subtypes that are HELPER volumes: present in the scene but never printed as
 * geometry of their own. Deliberately not the set of subtypes the editor can add: a new part may
 * also be a `normal_part` (BambuStudio's "Add part"), which is why {@link sceneEditAddedPartSchema}
 * takes the full {@link sceneEditPartSubtypeSchema}. This enum names the volumes that get a
 * subtype colour instead of a material: keep it in step with `HELPER_SUBTYPES` in
 * `three-mf-part-subtype.ts`, which answers the same question for raw 3MF strings.
 */
export const sceneEditHelperVolumeSubtypeSchema = z.enum([
  'negative_part',
  'modifier_part',
  'support_blocker',
  'support_enforcer'
])
export type SceneEditHelperVolumeSubtype = z.infer<typeof sceneEditHelperVolumeSubtypeSchema>

/**
 * Every Bambu volume subtype a part can be CHANGED to (BambuStudio's right-click →
 * "Change type"): the helper subtypes plus `normal_part` (ordinary printed solid).
 */
export const sceneEditPartSubtypeSchema = z.enum([
  'normal_part',
  'negative_part',
  'modifier_part',
  'support_blocker',
  'support_enforcer'
])
export type SceneEditPartSubtype = z.infer<typeof sceneEditPartSubtypeSchema>

/**
 * A part-type change on one part (volume) of an in-project object: BambuStudio's
 * "Change type" (e.g. turning an imported solid into a modifier volume). Keyed like
 * {@link sceneEditPartProcessOverrideSchema} by objectId + the part's ORDINAL (`partIndex`);
 * applied by rewriting the part's `subtype` attribute in `model_settings.config`. The type
 * is a property of the object's part, shared by every placed instance.
 */
export const sceneEditPartTypeChangeSchema = z.object({
  /** In-project object id, or a NEGATIVE clone placeholder (see `sceneEditObjectCloneSchema`). */
  objectId: z.number().int().refine((value) => value !== 0, 'objectId must not be 0'),
  /**
   * The part's 0-based ORDINAL within its object: BambuStudio's own part identity
   * (`bbs_3mf.cpp _handle_start_config_volume` keys a volume by `volumes.size()` as it parses, i.e.
   * document order). The `<part id>` / `<component objectid>` attribute is a MESH reference and is
   * NOT unique: BambuStudio deliberately writes the same id for every volume sharing a mesh
   * (`m_share_mesh`), so an object with four modifier cubes cut from one cube mesh has four parts
   * all reading id 22. Keying on that made an edit to one of them hit all four.
   */
  partIndex: z.number().int().nonnegative(),
  subtype: sceneEditPartSubtypeSchema
})
export type SceneEditPartTypeChange = z.infer<typeof sceneEditPartTypeChangeSchema>

/**
 * A transform change on one part (volume) of an in-project object: moving / rotating /
 * scaling a part inside its object (e.g. repositioning a support blocker after it was
 * baked). `matrix` is the part's new OBJECT-LOCAL placement (12 numbers, column-major
 * 3x3 + translation, the same convention as `sceneEditInstanceSchema.matrix`), applied
 * by rewriting the part's `<component>` transform. Keyed like
 * {@link sceneEditPartTypeChangeSchema} by objectId + the part's ORDINAL (`partIndex`);
 * the placement is a property of the object's part, shared by every placed instance.
 */
export const sceneEditPartTransformSchema = z.object({
  /** In-project object id, or a NEGATIVE clone placeholder (see `sceneEditObjectCloneSchema`). */
  objectId: z.number().int().refine((value) => value !== 0, 'objectId must not be 0'),
  /**
   * The part's 0-based ORDINAL within its object: BambuStudio's own part identity
   * (`bbs_3mf.cpp _handle_start_config_volume` keys a volume by `volumes.size()` as it parses, i.e.
   * document order). The `<part id>` / `<component objectid>` attribute is a MESH reference and is
   * NOT unique: BambuStudio deliberately writes the same id for every volume sharing a mesh
   * (`m_share_mesh`), so an object with four modifier cubes cut from one cube mesh has four parts
   * all reading id 22. Keying on that made an edit to one of them hit all four.
   */
  partIndex: z.number().int().nonnegative(),
  matrix: threeMfTransformSchema
})
export type SceneEditPartTransform = z.infer<typeof sceneEditPartTransformSchema>

/**
 * REMOVAL of one part (volume) from an in-project object: BambuStudio's per-volume Delete.
 *
 * This is the one part seam that is subtractive, and it needs to exist because the others cannot
 * express it. `SceneEdit.instances` is a COMPLETE list, so omitting an instance deletes the object
 * and `removeUnreferencedObjects` sweeps its geometry; parts have no such enumeration: they live
 * only in the base file's object XML and are addressed by ordinal, so a part's absence from an edit
 * means "leave it alone", never "remove it". Modelled on `removedEmbeddedPresets`, the other
 * explicit removal list.
 *
 * Keyed like {@link sceneEditPartTypeChangeSchema}, by objectId + the part's BASE-FILE ORDINAL, and
 * that is load-bearing for the bake ORDER: every other part-scoped seam addresses the same base
 * ordinals, so removals are applied AFTER all of them. Applying them first would shift the ordinals
 * out from under `partFilaments` / `partTypeChanges` / `partTransforms` / `partProcessOverrides`,
 * which is the failure mode that does not throw: it silently retargets an edit onto the wrong
 * volume. For the same reason the client keeps each surviving part's stored `partIndex` rather than
 * renumbering: a removal changes which parts exist, never what the remaining ones are called.
 */
export const sceneEditRemovedPartSchema = z.object({
  /** In-project object id, or a NEGATIVE clone placeholder (see `sceneEditObjectCloneSchema`). */
  objectId: z.number().int().refine((value) => value !== 0, 'objectId must not be 0'),
  /** The part's 0-based ordinal in the BASE file, unaffected by other removals in the same edit. */
  partIndex: z.number().int().nonnegative()
})
export type SceneEditRemovedPart = z.infer<typeof sceneEditRemovedPartSchema>

/**
 * A new PART order inside one in-project object: BambuStudio's drag-to-reorder within an object.
 *
 * Portable as-is, unlike object order: `<component>` sequence IS the volume list the importer reads
 * (`_handle_start_config_volume` keys a volume by its position), so the order carries real slicing
 * meaning. BambuStudio requires the FIRST volume to be a normal part, which is why this is
 * persisted rather than kept as a UI preference.
 *
 * `order` names parts by their BASE-FILE ORDINAL, like every other part-scoped seam, and NOT by
 * `componentObjectId`: that is the MESH id, and BambuStudio deliberately writes one id for every
 * volume sharing a mesh (`m_share_mesh`), so an object can hold four parts that a mesh-id order
 * cannot tell apart. A partial list moves only the ordinals it names, through the slots they
 * already occupy, leaving the rest where they are, so a stale entry cannot drop a part.
 *
 * Applied together with {@link sceneEditRemovedPartSchema} in ONE final layout pass, because both
 * address base ordinals and neither can run after the other: reordering first moves the ordinals a
 * removal names, removing first moves the ordinals an order names. One pass resolves both against
 * the base list, so there is no "which of these two goes last" to get wrong.
 */
export const sceneEditPartOrderSchema = z.object({
  /** In-project object id, or a NEGATIVE clone placeholder (see `sceneEditObjectCloneSchema`). */
  objectId: z.number().int().refine((value) => value !== 0, 'objectId must not be 0'),
  /** Base-file ordinals in the desired sequence. Unlisted parts keep their positions. */
  order: z.array(z.number().int().nonnegative()).max(400)
})
export type SceneEditPartOrder = z.infer<typeof sceneEditPartOrderSchema>

/**
 * The import counterpart of {@link sceneEditRemovedPartSchema}: dropping one solid of a multi-solid
 * import that has never been saved (a STEP assembly, a Split-to-parts result, an imported 3MF).
 *
 * Exists because no feature here may require a save first, and because the staged record is the
 * bake's only source for an import's solids: the client cannot drop one on its own. `partIndex` is
 * the solid's index in that staged record, so it keeps addressing the same solid however many
 * others are removed alongside it, exactly as the baked ordinals do.
 */
export const sceneEditImportRemovedPartSchema = z.object({
  importId: z.string().trim().min(1),
  partIndex: z.number().int().nonnegative()
})
export type SceneEditImportRemovedPart = z.infer<typeof sceneEditImportRemovedPartSchema>

/**
 * An object that keeps NO geometry of its own: everything it prints is an added part.
 *
 * The state BambuStudio reaches by deleting an object's first volume, and the one thing the two
 * removal seams above cannot express. An object whose geometry sits on an inline `<mesh>` has no
 * `<part>` entry to omit -- the bake CREATES one for it while attaching the added parts
 * (`applyAddedParts` moves the mesh into its own object as component 0 and re-keys the host's own
 * entry onto it) -- so "remove ordinal 0" names something that does not exist until mid-bake.
 * `importRemovedParts` cannot stand in either: it filters an import's SOURCE SOLIDS and no-ops
 * entirely for the single-solid imports (a primitive, an STL, a cut half) that this is mostly about.
 *
 * Flagged here instead, so the bake simply never creates that component: the object is written with
 * its added parts as its whole component list, and they keep their OWN names. Without it the editor
 * had to promote a volume into the body, which saved as a part named after the OBJECT -- so the same
 * delete produced `["Cube","Part"]` before a save and `["Part","Part"]` after one, which is a save
 * changing what the user sees.
 *
 * `objectId` XOR `importId`, the same shape {@link sceneEditAddedPartSchema} uses, because the host
 * may be an in-project object or an import that has never been saved. Ignored for a host that has
 * no added parts to stand in for its geometry: an object with nothing to print is not a thing to
 * write, and the editor refuses the delete on that same rule.
 */
export const sceneEditRemovedObjectBodySchema = z.object({
  objectId: z.number().int().refine((value) => value !== 0, 'objectId must not be 0').optional(),
  importId: z.string().trim().min(1).optional()
}).refine(
  (value) => (value.objectId == null) !== (value.importId == null),
  'Provide exactly one of objectId or importId'
)
export type SceneEditRemovedObjectBody = z.infer<typeof sceneEditRemovedObjectBodySchema>

/**
 * The import counterpart of {@link sceneEditPartOrderSchema}: reordering the solids of a
 * multi-solid import that has never been saved.
 *
 * Exists because no feature here may require a save first. `order` names solids by their index in
 * the STAGED record, the same space `importPartTypes` / `importPartFilaments` /
 * `importPartTransforms` / `importRemovedParts` use, so each solid keeps its address however the
 * others move.
 */
export const sceneEditImportPartOrderSchema = z.object({
  importId: z.string().trim().min(1),
  order: z.array(z.number().int().nonnegative()).max(400)
})
export type SceneEditImportPartOrder = z.infer<typeof sceneEditImportPartOrderSchema>

/**
 * A part-type change for one solid of a multi-solid import, keyed by import + 0-based solid
 * index, an unsaved import has no baked 3MF part ids yet, so its parts can't use
 * {@link sceneEditPartTypeChangeSchema}. Applied while the import's solids are baked into one
 * object (the part is written with this subtype instead of `normal_part`).
 */
export const sceneEditImportPartTypeSchema = z.object({
  importId: z.string().trim().min(1),
  partIndex: z.number().int().nonnegative(),
  subtype: sceneEditPartSubtypeSchema
})
export type SceneEditImportPartType = z.infer<typeof sceneEditImportPartTypeSchema>

/**
 * An INDEPENDENT copy of an in-project object: BambuStudio's copy/paste, which does
 * `Model::add_object(*src_object)` (a whole new `ModelObject`) rather than adding another
 * `ModelInstance` to the existing one. Placing several instances against the same `objectId` is
 * still how a LINKED copy is expressed; the two are different on purpose, and BambuStudio offers
 * both (its toolbar "+" adds an instance, Ctrl+C/V adds an object).
 *
 * The bake deep-copies the source object's mesh/components AND its `model_settings` entry, parts
 * with their subtypes, extruders, per-part config, and the object's own config, into fresh ids, so
 * the copy starts identical to its source and then diverges.
 *
 * `objectId` here is a NEGATIVE placeholder the client mints. Instances and every per-part seam
 * (paint, part transforms, part types, filaments, added parts, brim ears, per-object overrides)
 * address the copy by that placeholder, using the SOURCE's `componentObjectId`s for its parts. A
 * PRE-PASS resolves both, placeholder to real object id, source component id to the copy's new
 * component id, before any other edit is applied, so the rest of the pipeline only ever sees real
 * ids and needed no clone-specific variant of each seam.
 */
export const sceneEditObjectCloneSchema = z.object({
  /** Negative placeholder this copy is addressed by throughout the edit. */
  objectId: z.number().int().negative(),
  /** The in-project object being copied. */
  sourceObjectId: z.number().int().positive()
})
export type SceneEditObjectClone = z.infer<typeof sceneEditObjectCloneSchema>

/**
 * A placement change for one solid of a multi-solid import, keyed by import + 0-based solid index,
 * an unsaved import has no baked 3MF part ids yet, so its parts can't use
 * {@link sceneEditPartTransformSchema}. `matrix` is the solid's new OBJECT-LOCAL placement, applied
 * as its `<component transform>` while the import's solids are baked into one object (they are
 * otherwise emitted at identity, since an import's per-solid meshes already share assembly space).
 */
export const sceneEditImportPartTransformSchema = z.object({
  importId: z.string().trim().min(1),
  partIndex: z.number().int().nonnegative(),
  matrix: threeMfTransformSchema
})
export type SceneEditImportPartTransform = z.infer<typeof sceneEditImportPartTransformSchema>

/**
 * A new volume added INSIDE an existing object (BambuStudio's "Add part / negative part /
 * modifier / support blocker / enforcer"): `meshImportId`'s staged mesh becomes a new object
 * resource referenced as a `<component>` of the host root object, and the host's
 * `model_settings.config` entry gains a `<part>` with the given subtype. `matrix` is the part's
 * OBJECT-LOCAL placement (12 numbers, column-major 3x3 + translation, the same convention as
 * `sceneEditInstanceSchema.matrix`).
 *
 * TWO import ids are in play and they mean different things: `meshImportId` is the part's own
 * geometry, while `importId` names the HOST when the part is added to a model that is itself still
 * an unsaved import. Exactly one of `objectId` / `importId` identifies the host, an in-project
 * object by its Bambu `object_id`, or a staged import by the id the builder baked it under
 * (`importIdToObjectId`), which is what lets a part be added before the project is ever saved.
 */
/**
 * BambuStudio's `<text_info>` payload, as it rides a save request. The shape is
 * {@link TextInfo} from `three-mf/text-info.ts`, which owns the serializer, the parser and the
 * version rules; this is only its wire validation.
 */
export const sceneEditTextInfoSchema = z.object({
  text: z.string().max(2000),
  fontName: z.string().max(200),
  styleName: z.string().max(200),
  fontIndex: z.number().int().nonnegative(),
  fontSize: z.number().positive(),
  thickness: z.number().positive(),
  embeddedDepth: z.number().min(0),
  rotateAngle: z.number(),
  textGap: z.number(),
  bold: z.boolean(),
  italic: z.boolean(),
  boldness: z.number(),
  skew: z.number(),
  surfaceType: z.enum(TEXT_SURFACE_TYPES),
  hitMeshId: z.number().int(),
  // Readonly to match {@link TextInfo}: these are a record of where a surface hit landed, never
  // something a consumer edits in place.
  hitPosition: z.tuple([z.number(), z.number(), z.number()]).readonly(),
  hitNormal: z.tuple([z.number(), z.number(), z.number()]).readonly()
}) satisfies z.ZodType<TextInfo>

/**
 * Our `<printstream_svg>` payload, as it rides a save request. The shape is {@link SvgPartRecord}
 * from `three-mf/svg-shape.ts`, which owns the serializer, the parser and the interop rules; this
 * is only its wire validation.
 */
export const sceneEditSvgPartSchema = z.object({
  entryPath: z.string().min(1).max(300),
  fileName: z.string().max(300),
  /** 0 for a merged import, else the 1-based paint order of the piece this part was extruded from. */
  pieceIndex: z.number().int().nonnegative(),
  /**
   * NON-NEGATIVE, not positive: `svgPartRecordFromBambuShape` reports 0 for a BambuStudio-embossed
   * part, meaning "not known yet" (Studio's `scale` is relative to nanosvg's own extents for the
   * file, so a millimetre width cannot be recovered until the artwork is parsed). Requiring a
   * positive value here would make a scene containing such a part fail to parse.
   */
  widthMm: z.number().nonnegative(),
  thickness: z.number().positive(),
  includeBackground: z.boolean()
}) satisfies z.ZodType<SvgPartRecord>

/**
 * BambuStudio's `<BambuStudioShape>` payload, as it rides a save request. The shape is
 * {@link BambuStudioShape} from `three-mf/svg-shape.ts`.
 */
export const sceneEditBambuShapeSchema = z.object({
  filePath: z.string().max(300),
  filePathIn3mf: z.string().max(300),
  scale: z.number().positive(),
  unhealed: z.boolean(),
  depth: z.number().positive(),
  useSurface: z.boolean(),
  fixTransform: z.array(z.number()).length(12).readonly().nullable()
}) satisfies z.ZodType<BambuStudioShape>

export const sceneEditAddedPartSchema = z.object({
  /** Host: an in-project object's Bambu `object_id`. Mutually exclusive with `importId`. */
  /** In-project object id, or a NEGATIVE clone placeholder (see `sceneEditObjectCloneSchema`). */
  objectId: z.number().int().refine((value) => value !== 0, 'objectId must not be 0').optional(),
  /** Host: a staged import, for a part added to a model that has not been saved yet. */
  importId: z.string().trim().min(1).optional(),
  /** The part's OWN geometry: always a staged import, whether a primitive or a loaded file. */
  meshImportId: z.string().trim().min(1),
  subtype: sceneEditPartSubtypeSchema,
  name: z.string().trim().min(1).max(200),
  matrix: threeMfTransformSchema,
  /**
   * Filament (1-based) for a part that carries one, normal parts and modifiers, per
   * `threeMfPartSubtypeCarriesFilament`. Written as the part's `extruder` metadata. Omitted for
   * support blockers/enforcers and negative volumes, which have no meaningful material;
   * BambuStudio writes 0 there and so do we (by writing nothing).
   */
  filamentId: z.number().int().positive().optional(),
  /**
   * Per-volume process overrides (modifier parts): written as `<metadata key value/>`
   * entries inside the part's `model_settings.config` block, which is exactly how
   * BambuStudio persists ModelVolume config: the slicer applies them inside the
   * volume. Values are the serialized config strings.
   */
  settings: z.record(z.string().min(1).max(64), z.string().max(512)).optional(),
  /**
   * What a TEXT part was made from, so it stays editable after the geometry is baked. Written as a
   * `<text_info/>` inside the part's `model_settings.config` block, which is where BambuStudio keeps
   * it and how a saved project round-trips still editable in either editor. Absent for every part
   * that is not text.
   */
  textInfo: sceneEditTextInfoSchema.optional(),
  /**
   * What an SVG part was extruded from, so it stays editable after the geometry is baked. Written
   * as a `<printstream_svg/>` inside the part's `model_settings.config` block. Absent for every
   * part that did not come from the SVG tool.
   */
  svgPart: sceneEditSvgPartSchema.optional(),
  /**
   * Studio's INTEROP record for the same part, written only when this import produced ONE part.
   * A split import must not carry it: the element describes a whole artwork, so N copies would each
   * tell BambuStudio they are the entire drawing (see `three-mf/svg-shape.ts`).
   */
  bambuShape: sceneEditBambuShapeSchema.optional()
}).refine(
  (part) => (part.objectId == null) !== (part.importId == null),
  { message: 'An added part must name exactly one host: objectId or importId' }
).refine(
  // A part whose geometry IS its host resolves to one object containing itself, and BambuStudio's
  // component walk has no visited set, so opening the file hangs and then exhausts memory. The bake
  // catches every cycle (`three-mf/component-graph.ts`); this catches the one shape a single request
  // can state outright, at the boundary, where the error can name the field.
  (part) => part.importId == null || part.importId !== part.meshImportId,
  { message: 'An added part cannot be its own host: meshImportId must differ from importId' }
)
export type SceneEditAddedPart = z.infer<typeof sceneEditAddedPartSchema>

/**
 * One object-geometry replacement (BambuStudio's "Replace with…"): the original object
 * `objectId` had its mesh swapped for the staged import `importId` in the editor. The placed
 * instances reference the import for geometry (so the original object drops out of the bake);
 * this entry records the original object the import stands in for, so the slicer can carry that
 * object's per-object PROCESS overrides (keyed by the original `objectId`) onto the
 * replacement's baked object. Object-level: one entry per replaced object, shared by every copy.
 */
export const sceneEditMeshReplacementSchema = z.object({
  objectId: z.number().int(),
  importId: z.string().trim().min(1)
})
export type SceneEditMeshReplacement = z.infer<typeof sceneEditMeshReplacementSchema>

/**
 * A per-part filament (material) assignment for a multi-solid import (a STEP assembly),
 * keyed by the import and the 0-based solid index, because an unsaved import has no baked
 * 3MF part ids yet. Applied while the import's parts are baked into one object, so each
 * solid keeps its own material. (In-project objects use {@link sceneEditPartFilamentSchema},
 * which keys by baked object/part ids instead.)
 */
export const sceneEditImportPartFilamentSchema = z.object({
  importId: z.string().trim().min(1),
  partIndex: z.number().int().nonnegative(),
  filamentId: z.number().int().positive()
})
export type SceneEditImportPartFilament = z.infer<typeof sceneEditImportPartFilamentSchema>

/**
 * Per-part PROCESS overrides for a multi-solid import, keyed by import + 0-based solid index,
 * an unsaved import has no baked 3MF part ids yet, so its parts can't use
 * {@link sceneEditPartProcessOverrideSchema} (which keys by baked object/part id). Applied while
 * the import's solids are baked into one object.
 */
export const sceneEditImportPartProcessOverrideSchema = z.object({
  importId: z.string().trim().min(1),
  partIndex: z.number().int().nonnegative(),
  overrides: processSettingOverridesSchema
})
export type SceneEditImportPartProcessOverride = z.infer<typeof sceneEditImportPartProcessOverrideSchema>

/**
 * Edited purge volumes for the project: BambuStudio's "Flushing volumes for filament change".
 *
 * `matrix` is ONE `filaments x filaments` block PER EXTRUDER, in extruder order, holding mm3 to
 * purge going from the row's filament to the column's. It is carried structured rather than
 * pre-flattened so the bake can check it against the filament set it is actually writing: a
 * flat array cannot be told apart from one sized for a different material list, and writing a
 * mis-sized `flush_volumes_matrix` is not a soft failure: the engine reads it out of bounds and
 * segfaults mid-slice. See `flush-volumes-matrix.ts`.
 *
 * `multiplier` carries one entry per extruder. Which KEY it lands in depends on the project's
 * `prime_volume_mode`, so the bake decides that from the document rather than the client.
 *
 * Absent means "leave the project's flush settings alone", including leaving them ABSENT, which
 * is a legitimate state that makes BambuStudio compute the matrix itself.
 */
export const sceneEditFlushVolumesSchema = z.object({
  matrix: z.array(z.array(z.array(z.number().nonnegative()).max(64)).max(64)).min(1).max(16),
  multiplier: z.array(z.number().nonnegative()).min(1).max(16)
})
export type SceneEditFlushVolumes = z.infer<typeof sceneEditFlushVolumesSchema>

export const sceneEditSchema = z.object({
  plates: z.array(sceneEditPlateSchema).min(1),
  instances: z.array(sceneEditInstanceSchema),
  /** Optional new volumes added inside existing objects (negative parts, modifiers, ...). */
  addedParts: z.array(sceneEditAddedPartSchema).max(200).optional(),
  /**
   * Source SVGs to store in the archive, keyed by the entry path the parts' records name.
   *
   * These are the ARTWORK, not a convenience copy of it: neither our `<printstream_svg>` nor
   * BambuStudio's `<BambuStudioShape>` stores the shapes themselves, so both reopen by re-parsing
   * these bytes. An edit whose parts name an entry that is not written here, and was not already in
   * the base archive, produces parts that reopen as anonymous solids, which is the whole defect
   * the records exist to fix.
   *
   * Absent on every save that did not add SVG artwork; entries already in the base are not resent.
   */
  svgSources: z.array(z.object({
    /**
     * Constrained to `3D/<name>.svg`, and NOT merely as tidiness.
     *
     * The bake writes this verbatim as an archive entry name, and both writers key entries by name
     * last-wins, so an unconstrained value lets a save name `3D/3dmodel.model` and replace the model
     * document with arbitrary text, leaving an unopenable file. `isSvgArchiveEntry` is Studio's own
     * case-sensitive test, which is also the rule its reader uses to FIND these entries, so anything
     * failing it could not be re-read by either tool anyway. Traversal segments are rejected for the
     * same reason: a name is a zip path, not a filesystem one, and `..` in it is never legitimate.
     */
    entryPath: z.string().min(1).max(300)
      .refine(isSvgArchiveEntry, 'An SVG source entry must be 3D/<name>.svg')
      .refine((value) => !value.split('/').includes('..'), 'An SVG source entry must not traverse'),
    // Kept under the API's own 4mb JSON body limit with room for the rest of the edit, because the
    // transport rejects an oversized body BEFORE Zod runs: a larger cap here would be unreachable
    // and would surface as an opaque 413 on every save AND slice of the project. `handleAddSvg`
    // refuses the import up front so the failure names the artwork instead.
    markup: z.string().refine(
      (value) => svgSourceByteLength(value) <= MAX_SVG_SOURCE_BYTES,
      `An SVG source must be at most ${MAX_SVG_SOURCE_BYTES} bytes`
    )
  })).max(64).refine(
    (sources) => sources.reduce((total, source) => total + svgSourceByteLength(source.markup), 0)
      <= MAX_SVG_SOURCES_TOTAL_BYTES,
    'The project carries more SVG artwork than a save can send'
  ).optional(),
  /** Optional object→import geometry replacements (Replace-with); see {@link sceneEditMeshReplacementSchema}. */
  meshReplacements: z.array(sceneEditMeshReplacementSchema).max(200).optional(),
  /**
   * In-project objects the user asked to mesh-repair (editor right-click → "Repair mesh"), by Bambu
   * `object_id`. The repair is applied SERVER-SIDE while baking the save (`buildEditedThreeMf` →
   * `repairSingleMeshXml`): near-duplicate ("cracked") vertices are welded and degenerate/duplicate
   * facets dropped, in place in the object's mesh XML. It is deliberately not a geometry replacement,
   * repairing in place keeps every per-triangle paint attribute and the object's part volumes,
   * which staging a replacement import would destroy. Repair is visually a no-op (it only merges
   * coincident geometry and drops junk), so the editor marks the object and the change materialises
   * on Save like any other edit. No-op for an object whose mesh is already clean.
   */
  repairedObjectIds: z.array(z.number().int()).max(200).optional(),
  /**
   * Apply the shared settings repairs (`repairs/`: flush matrix, variant index, filament ids,
   * inherits_group, object-level extruders) while baking, as the LAST project_settings /
   * model_settings step so authoring always wins first. The staged, undoable twin of the API's
   * repair route for hosts with no stored file behind the project (the public editor): the user
   * pressed Repair in the editor, the pin rides the edit, and nothing is written until they save.
   * Every repair is inspect-gated and idempotent, so a healthy document is untouched.
   */
  repairSettings: z.boolean().optional(),
  /** Optional per-object-part filament overrides (material reassignment) for in-project objects. */
  partFilaments: z.array(sceneEditPartFilamentSchema).optional(),
  /** Optional per-part process overrides (process settings on individual parts of an object). */
  partProcessOverrides: z.array(sceneEditPartProcessOverrideSchema).optional(),
  /** Optional part-type changes (normal/negative/modifier/blocker/enforcer) on in-project objects' parts. */
  partTypeChanges: z.array(sceneEditPartTypeChangeSchema).max(400).optional(),
  /** Optional part-placement changes (move/rotate/scale a part inside its object). */
  partTransforms: z.array(sceneEditPartTransformSchema).max(400).optional(),
  /**
   * Optional part REMOVALS on in-project objects. Complete state, like every other domain the
   * editor owns: the whole set of parts this session removed, not a diff. Applied after every
   * other part-scoped seam so their base ordinals stay valid; see the schema.
   */
  removedParts: z.array(sceneEditRemovedPartSchema).max(400).optional(),
  /**
   * Optional per-object part ORDER changes (the sidebar drag inside an object). Each entry is that
   * object's complete desired sequence of base ordinals; applied in the same final layout pass as
   * `removedParts`, which is the only place either of them can run without invalidating the other.
   */
  partOrder: z.array(sceneEditPartOrderSchema).max(400).optional(),
  /** Optional solid ORDER changes on multi-solid imports, keyed by import. */
  importPartOrder: z.array(sceneEditImportPartOrderSchema).max(400).optional(),
  /** Optional solid removals on multi-solid imports, keyed by import + solid index. */
  importRemovedParts: z.array(sceneEditImportRemovedPartSchema).max(400).optional(),
  removedObjectBodies: z.array(sceneEditRemovedObjectBodySchema).max(400).optional(),
  /** Optional per-part filament for multi-solid imports, keyed by import + solid index. */
  importPartFilaments: z.array(sceneEditImportPartFilamentSchema).max(400).optional(),
  /** Optional per-part process overrides for multi-solid imports, keyed by import + solid index. */
  importPartProcessOverrides: z.array(sceneEditImportPartProcessOverrideSchema).max(400).optional(),
  /** Optional part-type changes for multi-solid imports' solids, keyed by import + solid index. */
  importPartTypes: z.array(sceneEditImportPartTypeSchema).max(400).optional(),
  /** Optional part-placement changes for multi-solid imports' solids, keyed by import + solid index. */
  importPartTransforms: z.array(sceneEditImportPartTransformSchema).max(400).optional(),
  /**
   * Optional staged imports the user asked to mesh-repair. The import counterpart of
   * `repairedObjectIds`: an unsaved import has no mesh in the document yet, so the repair is
   * applied to its stored geometry before injection (`repairImportedMeshGeometry`). Same rules
   * either way, so repairing before or after a save gives the same result.
   */
  repairedImportIds: z.array(z.string().trim().min(1)).max(200).optional(),
  /**
   * Optional manual brim ears on a not-yet-saved import, keyed by importId: the import
   * counterpart of `brimEars`, which addresses an object by its baked id. Resolved through
   * `importIdToObjectId` when the sidecar is written.
   */
  importBrimEars: z.array(z.object({
    importId: z.string().trim().min(1),
    points: z.array(sceneEditBrimEarSchema).max(512)
  })).max(200).optional(),
  /**
   * Optional height range modifiers on a not-yet-saved import, keyed by importId: the import
   * counterpart of `heightRanges`. Resolved through `importIdToObjectId` when the sidecar is
   * written, so a range can be authored before the object has a baked id.
   */
  importHeightRanges: z.array(z.object({
    importId: z.string().trim().min(1),
    ranges: z.array(sceneEditHeightRangeSchema).max(MAX_HEIGHT_RANGES_PER_OBJECT)
  })).max(200).optional(),
  /**
   * Optional variable layer height on a not-yet-saved import, keyed by importId: the import
   * counterpart of `layerHeightProfiles`, resolved through `importIdToObjectId` at bake time.
   */
  importLayerHeightProfiles: z.array(z.object({
    importId: z.string().trim().min(1),
    profile: z.array(z.number()).max(4096)
  })).max(200).optional(),
  /**
   * What one plane cut produced, so BambuStudio reopens the halves as a CUT rather than as
   * unrelated objects: the cut badge, "delete all connectors", and the lock that stops one half
   * being scaled non-uniformly out of fitting the other.
   *
   * Keyed by importId throughout, because a cut's outputs are freshly staged imports that have no
   * baked object id until this save writes them. Nothing about the print depends on it; see
   * `three-mf/cut-information.ts` for what it can and cannot honestly record, in particular that a
   * connector whose hole was drilled into the geometry has no volume to name.
   */
  cutGroups: z.array(z.object({
    /** Both halves, plus one per dowel pin. Fewer than two is not a cut and is not recorded. */
    importIds: z.array(z.string().trim().min(1)).min(2).max(64),
    /**
     * Connectors the cut PLACED, including any that left no volume behind. Not the length of
     * `connectors`: BambuStudio compares this across a group to decide the halves belong together.
     */
    connectorCount: z.number().int().min(0).max(512),
    connectors: z.array(z.object({
      /** The half the connector volume was added to. */
      importId: z.string().trim().min(1),
      /** The staged mesh of the volume itself, which locates it among the object's components. */
      meshImportId: z.string().trim().min(1),
      type: z.enum(['plug', 'dowel', 'snap']),
      /** Millimetres, not Studio's unit-mesh scale factor. */
      radius: z.number().positive().max(1000),
      height: z.number().positive().max(1000),
      radiusTolerance: z.number().min(0).max(1000),
      heightTolerance: z.number().min(0).max(1000)
    })).max(512)
  })).max(64).optional(),
  /**
   * Optional triangle paint on a not-yet-saved import, keyed by import + 0-based solid index
   * (`partIndex` 0 is a single-solid import's only mesh). The import counterpart of
   * `supportPaint`/`seamPaint`/`colorPaint`/`fuzzyPaint`, which address a baked part by object + component id.
   *
   * Triangle indices are positions in the STAGED mesh's `indices`, the same order the editor
   * renders (`meshToBinaryStl`) and the bake writes (`renderImportedMeshObjectXml`), a contract
   * pinned by a test in `mesh-import.test.ts`. Breaking that order silently paints the wrong
   * facets, so do not reorder either serializer.
   */
  importPaint: z.array(z.object({
    importId: z.string().trim().min(1),
    partIndex: z.number().int().nonnegative(),
    channel: z.enum(['support', 'seam', 'color', 'fuzzy']),
    triangles: z.record(z.string(), z.string().max(MAX_PAINT_CODE_LENGTH))
  })).max(400).optional(),
  /**
   * Optional INDEPENDENT copies of in-project objects (BambuStudio's copy/paste semantics, as
   * opposed to placing another instance against the same `objectId`, which stays linked). Resolved
   * by a pre-pass before every other seam: see {@link sceneEditObjectCloneSchema}.
   */
  objectClones: z.array(sceneEditObjectCloneSchema).max(200).optional(),
  /** Optional per-part support-paint maps (parts painted with the support brush). */
  supportPaint: z.array(sceneEditPartPaintSchema).optional(),
  /** Optional per-part seam-paint maps (parts painted with the seam brush). */
  seamPaint: z.array(sceneEditPartPaintSchema).optional(),
  /** Optional per-part colour-paint maps (`paint_color`, Bambu's colour painting). */
  colorPaint: z.array(sceneEditPartPaintSchema).optional(),
  /**
   * Per-triangle FUZZY SKIN enforcers, written as `paint_fuzzy_skin`.
   *
   * A separate channel from supports even though BambuStudio gives them the same underlying value
   * (`FUZZY_SKIN = ENFORCER`, `Model.hpp:719`): the ATTRIBUTE is its own, so a triangle can be both
   * a support enforcer and fuzzy, and folding them together would make painting one erase the other.
   */
  fuzzyPaint: z.array(sceneEditPartPaintSchema).optional(),
  /** Optional per-object manual brim ears (complete replacement sets). */
  brimEars: z.array(sceneEditObjectBrimEarsSchema).optional(),
  /** Optional per-object height range modifiers (complete replacement sets). */
  heightRanges: z.array(sceneEditObjectHeightRangesSchema).optional(),
  /** Optional per-object variable layer height profiles (complete replacement). */
  layerHeightProfiles: z.array(sceneEditObjectLayerHeightProfileSchema).optional(),
  /** Optional per-plate layer-based filament changes (replaces listed plates' entries). */
  filamentChanges: z.array(sceneEditPlateFilamentChangesSchema).optional(),
  /** Optional per-plate layer pauses (replaces listed plates' pause entries). */
  pauses: z.array(sceneEditPlatePausesSchema).optional(),
  /** Optional per-object display-name overrides (object renamed in the editor). */
  objectNames: z.array(sceneEditObjectNameSchema).optional(),
  /**
   * Optional full desired filament list. When present it replaces the project's
   * filament set (enabling Bambu-style add/remove of materials); when omitted the
   * source project's filaments are kept as-is.
   */
  filaments: z.array(sceneEditFilamentSchema).optional(),
  /** Optional edited purge volumes; see {@link sceneEditFlushVolumesSchema}. */
  flushVolumes: sceneEditFlushVolumesSchema.optional(),
  /**
   * Archive entries for project-embedded filament presets the user removed
   * (`Metadata/filament_settings_N.config`).
   *
   * BambuStudio re-embeds every sidecar it finds on every save, so one it fabricated once, because
   * a slot named a preset it could not bind, reappears in the user's filament dropdown forever, on
   * every machine that opens the file. Dropping the entry is the only way out, and it is an
   * EXPLICIT user action: an embedded preset can be the only surviving record of settings someone
   * tuned, so an unreferenced one is still not ours to delete unasked. See
   * `three-mf/embedded-presets.ts`.
   */
  removedEmbeddedPresets: z.array(z.string()).optional(),
  /**
   * Optional client-rendered plate previews (edited layout) to embed as each plate's
   * thumbnail in the sliced output, since the slicer CLI can't regenerate them here.
   */
  plateThumbnails: z.array(sceneEditPlateThumbnailSchema).optional()
}).superRefine((edit, context) => {
  // A filament id is a 1-based index into THIS edit's filament list, so an id above its length
  // names nothing. BambuStudio clamps such an index to 1 at load (`bbs_3mf.cpp:2283-2298`), which
  // means the object silently prints in the WRONG MATERIAL rather than failing, and the bad index
  // stays on disk to do it again on the next open. Worse, the clamp is bounded by
  // `filament_settings_id.size()`, so a project missing that key is not clamped at all.
  //
  // Checked here because it is the only place that sees both halves. The bake AUTHORS these ids
  // after its slot remap has run (staged imports, `partFilaments`, `addedParts`), deliberately, so
  // the remap that clamps a bad index inherited from the BASE file cannot also catch one the
  // request supplied. Our own index parser is fooled too: it adds any positive `extruder` to the
  // plate's filament set, fabricating a slot that does not exist.
  const slots = edit.filaments?.length
  if (slots == null || slots === 0) return
  const flag = (path: (string | number)[], id: number) => context.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message: `filamentId ${id} is above this project's ${slots} material${slots === 1 ? '' : 's'}`
  })
  edit.instances?.forEach((instance, index) => {
    if (instance.filamentId != null && instance.filamentId > slots) flag(['instances', index, 'filamentId'], instance.filamentId)
  })
  edit.partFilaments?.forEach((part, index) => {
    if (part.filamentId > slots) flag(['partFilaments', index, 'filamentId'], part.filamentId)
  })
  edit.importPartFilaments?.forEach((part, index) => {
    if (part.filamentId > slots) flag(['importPartFilaments', index, 'filamentId'], part.filamentId)
  })
  edit.addedParts?.forEach((part, index) => {
    if (part.filamentId != null && part.filamentId > slots) flag(['addedParts', index, 'filamentId'], part.filamentId)
  })
})
export type SceneEdit = z.infer<typeof sceneEditSchema>

export const stagedImportFormatSchema = z.enum(['stl', 'step', '3mf'])
export type StagedImportFormat = z.infer<typeof stagedImportFormatSchema>

/**
 * Metadata for a foreign model staged on the server (parsed/tessellated to a mesh) and referenced by
 * `SceneEditInstance.importId` until baked into a 3MF. The mesh itself is fetched separately as a
 * binary so it can be rendered with the existing STL loader rather than shipped as JSON.
 */
/**
 * One named solid of a staged import. A multi-solid STEP lists each of its solids here so the
 * editor imports the file as a single object with many parts; a single-solid STEP/STL lists one
 * part named after the import. Each part's mesh is fetched separately as a binary STL by index.
 */
export const stagedImportPartSchema = z.object({
  name: z.string().min(1),
  triangleCount: z.number().int().nonnegative(),
  bounds: z.object({ min: sceneEditVec3Schema, max: sceneEditVec3Schema }),
  /**
   * Raw 3MF `subtype` for a solid that came in as a HELPER volume (support blocker/enforcer,
   * modifier, negative part); null for ordinary printed geometry, and always null for STL/STEP,
   * which have no volume concept. Only a 3MF source sets it: BambuStudio's "Import Object"
   * (`LoadStrategy::LoadModel`) loads a 3MF's ModelVolumes whole and its importer applies each
   * volume's type unconditionally, so a blocker must survive an export/import round-trip rather
   * than silently becoming printed geometry or vanishing.
   */
  subtype: z.string().nullable().default(null)
})
export type StagedImportPart = z.infer<typeof stagedImportPartSchema>

export const stagedImportSchema = z.object({
  importId: z.string().min(1),
  name: z.string().min(1),
  format: stagedImportFormatSchema,
  triangleCount: z.number().int().nonnegative(),
  bounds: z.object({ min: sceneEditVec3Schema, max: sceneEditVec3Schema }),
  /** The import's named solids (always ≥1; >1 only for a multi-solid STEP assembly). */
  parts: z.array(stagedImportPartSchema).min(1)
})
export type StagedImport = z.infer<typeof stagedImportSchema>

/**
 * What a staged import is FOR, which decides how its geometry is normalised.
 *
 * `object` — a whole object on the plate (Add model, Replace with…, an import from the library).
 * Normalised to the editor's pivot convention: XY bounding-box centre on the origin, lowest point
 * at z = 0 (`rebaseImportedMesh`). That is what makes `position` place the object's own centre, and
 * the rotate gizmo pivot there rather than at whatever point the file's exporter chose.
 *
 * `part` — a volume INSIDE a host object (an added part, a modifier, a support blocker). Left
 * exactly as staged: `primitivePartSoup` centres a part on EVERY axis and `addedPartDropPosition`
 * places it by that single point relative to its host, so flooring its Z would bury a helper volume
 * half its own height above where it was dropped.
 *
 * The two go through ONE staging endpoint, and nothing about the bytes distinguishes them, so the
 * caller states it. The client type makes it REQUIRED for that reason; the server defaults to
 * `object` only so a request that omits it fails safe for the common case rather than 400ing.
 */
export const importNormalizationSchema = z.enum(['object', 'part'])
export type ImportNormalization = z.infer<typeof importNormalizationSchema>

export const stageImportFromLibrarySchema = z.object({
  libraryFileId: z.string().trim().min(1),
  /** For multi-object 3MF sources, the Bambu object_id to import; omitted ⇒ the whole model. */
  objectId: z.number().int().positive().optional(),
  normalize: importNormalizationSchema.default('object')
})
export type StageImportFromLibrary = z.infer<typeof stageImportFromLibrarySchema>

/**
 * The bake inputs shared by every "arranged 3MF" operation: persist as a library file
 * (`saveArrangedThreeMfSchema`) or stream back as a download (`exportArrangedThreeMfSchema`).
 * `baseFileId` is the source project the edit started from, or null for a brand-new project
 * built from an empty skeleton.
 */
const arrangedThreeMfBakeSchema = z.object({
  baseFileId: z.string().trim().min(1).nullable(),
  /**
   * Build from an archived version's content instead of the file's current content
   * (the history dialog's Edit flow). Must belong to `baseFileId`. `newVersion` saves
   * still land as a NEW version of the file: the old version is never mutated.
   */
  baseVersionId: z.string().trim().min(1).nullable().optional(),
  /**
   * Which BYTES to author from, when that is not the save target's current content.
   *
   * `baseFileId`/`baseVersionId` conflate two questions, "whose bytes do I bake from" and "which
   * file am I writing a version of", and answering both with the target makes every save patch
   * the PREVIOUS save's output. That chaining is what strands one dead mesh object per solid per
   * save on an import-backed project, and what forced the editor to re-read its own file
   * afterwards to learn the ids the bake assigned. This field separates the two: the editor pins
   * the version it OPENED and keeps sending it, so save N is authored exactly like save 1.
   *
   * `fileId` is deliberately independent of `baseFileId`: after a saveAs the session continues
   * against a NEW file while the content base must stay the ORIGINAL file's version, which a
   * target-scoped version lookup would reject.
   *
   * REQUIRED in practice whenever `baseFileId` names a file and `baseVersionId` does not name a
   * version: the route refuses such a request rather than falling back to the target's current
   * content, because after this session's first save that content IS this session's output and
   * baking from it re-applies the edit over itself. Optional here only so a request that carries
   * immutable bytes (an explicit `baseVersionId`) or none at all (`ignoreBaseContent`) need not
   * repeat itself. Ignored when `ignoreBaseContent` is set, which means "carry no base bytes at
   * all".
   */
  contentBase: z.object({
    fileId: z.string().trim().min(1),
    /** Null/absent ⇒ that file's CURRENT content (the first save of a session). */
    versionId: z.string().trim().min(1).nullable().optional()
  }).optional(),
  /**
   * Bake purely from `sceneEdit` + its staged imports, ignoring the base file's BYTES while still
   * targeting it (name/folder/bridge, and a `newVersion` save still lands on it as usual).
   *
   * Exists so the editor can stay open on a project it created instead of re-mounting on the
   * just-saved file after every save. A new project's instances stay IMPORT-backed for the whole
   * session, so each save re-injects those imports; re-reading the previous save's output then
   * leaves the base's now-unreferenced component objects behind as orphans. The placed instance
   * stays correct, but a multi-solid import strands one dead mesh object PER SOLID PER SAVE, a
   * 134-part assembly bloats the file on every save. Baking from the editor state alone
   * reproduces the first save's output exactly, so repeated saves are stable.
   *
   * Only an EDITOR-BORN project may set this. A project opened from a real file must not: the
   * bake copies every base entry it has no transform for through verbatim, and that passthrough
   * is the only thing preserving what `SceneEdit` cannot express (`Auxiliaries/` attachments,
   * plate thumbnails, `_rels/`, `[Content_Types].xml`, future vendor parts). A new-project
   * scaffold holds none of that, it is itself a from-null bake of one plate and one default
   * filament (`POST /api/editor/new-project`), both of which the editor state already models.
   */
  ignoreBaseContent: z.boolean().optional(),
  sceneEdit: sceneEditSchema,
  /**
   * Stamp the baked 3MF as a single-object model export (`printstream_model_kind` in
   * project_settings.config), so the library treats it as a reusable model (preview on
   * click) rather than an openable project. Sent only by the editor's "Export object as
   * 3MF" flows (save-to-library and download), never by ordinary saves.
   */
  objectExport: z.boolean().optional(),
  /**
   * Per-object process-setting overrides, keyed by Bambu `object_id` (or a fresh import's
   * synthetic id, which is re-keyed onto the baked object). Persisted into the saved 3MF's
   * `model_settings.config` so per-object process edits survive the save (not just a slice).
   */
  objectProcessOverrides: z.record(z.string().min(1), processSettingOverridesSchema).optional(),
  /**
   * Global (project-wide) process-setting overrides authored in the editor, keyed by
   * BambuStudio process-config key. Merged into the saved 3MF's `project_settings.config` so
   * editor process edits persist into the project (not just a one-off slice): mirrors how the
   * slicer merges a `project:`-profile's overrides into project_settings.config at slice time
   * (`apps/slicer/src/index.ts`). Absent/empty ⇒ the base project settings are preserved as-is.
   */
  processSettingOverrides: processSettingOverridesSchema.optional(),
  /**
   * Project-local machine (printer) setting overrides, merged into the saved 3MF's
   * `project_settings.config` after the machine step so an edited printer persists into the
   * project rather than only into one slice. Absent/empty leaves the machine block as authored.
   */
  machineSettingOverrides: processSettingOverridesSchema.optional(),
  /**
   * Per-MATERIAL filament-setting overrides from the material tune dialog ("Save in this 3MF"),
   * keyed by the material's 1-based SAVED slot position (post-renumber, never a session id) and
   * then by filament-config key. The api persists them into `project_settings.config` (whole
   * column sets, other slots filled from their current/preset values) AND records each key in
   * that slot's `different_settings_to_system`: the marker that makes a later machine retarget
   * preserve the edit instead of rebinding it away as a fossil. Absent/empty ⇒ nothing persists
   * (the overrides still ride slice requests via `filamentMappings[].settingOverrides`).
   */
  filamentSettingOverrides: z.record(z.string().regex(/^\d+$/), processSettingOverridesSchema).optional(),
  /**
   * Slicer target (version) used for a cross-model retarget on save. Required alongside
   * `retarget`; chooses which BambuStudio CLI performs the machine switch.
   */
  slicerTargetId: z.string().trim().min(1).optional(),
  /**
   * When set, retarget the saved 3MF to this machine (BambuStudio "switch printer + save").
   * The API runs the slicer's machine switch when this machine's model differs from the
   * project's embedded model, so the saved project opens/slices for the new printer instead
   * of silently keeping the source machine. Omitted ⇒ save the arrangement as-authored.
   */
  retarget: slicingManualProfileTargetSchema.optional()
})

/**
 * Persist an edited arrangement as a 3MF library file. `mode` chooses between overwriting
 * the base as a new library version and creating a new library file (`name` required for
 * the latter).
 */
export const saveArrangedThreeMfSchema = arrangedThreeMfBakeSchema.extend({
  mode: z.enum(['newVersion', 'saveAs']),
  name: z.string().trim().min(1).max(255).optional(),
  folderId: z.string().trim().min(1).nullable().optional(),
  bridgeId: z.string().trim().min(1).nullable().optional()
}).refine((value) => value.mode !== 'saveAs' || Boolean(value.name), {
  message: 'A name is required when saving as a new file'
}).refine((value) => value.mode !== 'newVersion' || Boolean(value.baseFileId), {
  message: 'newVersion requires a base file'
})
export type SaveArrangedThreeMf = z.infer<typeof saveArrangedThreeMfSchema>

/**
 * Bake an edited arrangement and stream the 3MF back as a download, nothing is persisted
 * server-side (the download counterpart of a `saveAs`, for "Download 3MF project"). `name`
 * only labels the audit entry; the client names the downloaded file itself.
 */
export const exportArrangedThreeMfSchema = arrangedThreeMfBakeSchema.extend({
  name: z.string().trim().min(1).max(255).optional()
})
export type ExportArrangedThreeMf = z.infer<typeof exportArrangedThreeMfSchema>

export const createSlicingJobSchema = z.object({
  sourceFileId: z.string().trim().min(1),
  /**
   * Slice an archived version of the source file instead of the current
   * content. Must belong to `sourceFileId`; outputs still land beside the
   * parent file.
   */
  sourceVersionId: z.string().trim().min(1).optional(),
  /**
   * Which BYTES to bake `sceneEdit` from, when that is not the source file's current content.
   *
   * The exact field the editor SAVE sends (`contentBase` on {@link arrangedThreeMfBakeSchema}), and
   * for the same reason: a `SceneEdit` is a diff against the file the session OPENED, so every bake
   * of it must read those same bytes. A save advances the file's head, so a later slice that
   * resolved `sourceFileId`'s current content re-applied an edit the save had already baked in. The
   * idempotent members survived that; `partOrder` and `removedParts` did not, and applying a part
   * reorder twice permuted an object's volumes while the per-part `extruder` values stayed on their
   * old positions, so parts silently traded materials and a two-colour plate printed inverted.
   *
   * `fileId` is deliberately independent of `sourceFileId`, exactly as it is for a save: after a
   * "save as" the session keeps authoring from the ORIGINAL file's bytes.
   *
   * Absent means the legacy behaviour (bake from `sourceVersionId ?? sourceFileId`'s current
   * content), which is right for every non-editor slice: those carry no `sceneEdit` to re-apply.
   */
  contentBase: z.object({
    fileId: z.string().trim().min(1),
    /** Null/absent means that file's CURRENT content (a session that has not saved yet). */
    versionId: z.string().trim().min(1).nullable().optional()
  }).optional(),
  slicerTargetId: z.string().trim().min(1).optional(),
  /**
   * The user has been warned that this project was saved by a NEWER Bambu Studio than the chosen
   * engine, and chose to slice anyway. Passes BambuStudio's `--allow-newer-file`, which bypasses
   * the refusal it would otherwise exit 232 on.
   *
   * Deliberately an explicit acknowledgement rather than an always-on flag: the version gate is
   * the vendor's own, and an older engine can silently misinterpret settings a newer one wrote,
   * so a slice that succeeds is not proof the G-code is right. Same shape as the AMS drying
   * `acknowledgeRisks` contract: the UI warns, the user accepts, the server carries the choice.
   */
  allowNewerProjectFile: z.boolean().optional(),
  target: slicingTargetSchema,
  outputFileName: z.string().trim().min(1).max(255).optional(),
  outputFolderId: z.string().trim().min(1).nullable().optional(),
  hiddenOutput: z.boolean().optional(),
  /**
   * The browser TAB that started this slice (`apps/web/src/lib/tabSession.ts`). It owns the job:
   * only that tab shows its progress toast, and the API cancels the job when the tab goes away
   * for good (see `client-sessions.ts`). Optional, and absent means unowned, a job from a script
   * or a non-browser caller belongs to no tab, so it is nobody's to hide and nobody's to cancel.
   */
  ownerClientId: z.string().trim().min(1).max(128).optional(),
  /** 0 slices all plates; positive values are 1-based plate indexes inside the source project. */
  plate: z.number().int().nonnegative().default(0),
  /**
   * Object ids (Bambu `object_id` from the source 3MF's `model_settings.config`) to keep when
   * slicing. Omitted ⇒ slice every object. Only honored for a single-plate slice (`plate > 0`):
   * objects on the target plate that are not listed get their build items marked `printable="0"`,
   * which the slicer service translates into BambuStudio's `--skip-objects` CLI flag (the only
   * mechanism the engine actually honors).
   */
  selectedObjectIds: z.array(z.number().int().nonnegative()).optional(),
  /**
   * Per-object process-setting overrides, keyed by Bambu `object_id`. Each value is a sparse
   * override map injected as `<metadata>` into that object's `model_settings.config` block so the
   * slicer applies it to just that object.
   */
  objectProcessOverrides: z.record(z.string().min(1), processSettingOverridesSchema).optional(),
  /**
   * Per-plate layer-based filament changes to apply to THIS slice only (nothing is persisted to
   * the library file). Same replace-per-listed-plate semantics as `sceneEdit.filamentChanges`,
   * an empty `changes` array clears the plate's baked entries. Only honored when `sceneEdit` is
   * absent: an edited layout is authoritative and carries its own entries.
   */
  filamentChanges: z.array(sceneEditPlateFilamentChangesSchema).optional(),
  /** Per-plate layer pauses for THIS slice; same contract as `filamentChanges`. */
  pauses: z.array(sceneEditPlatePausesSchema).optional(),
  /**
   * Edited plate arrangement from the interactive 3D editor. When present, the source 3MF's
   * build items and `model_settings.config` plates/instances are rewritten to match before
   * slicing, so moved/rotated/scaled/added/removed models and multi-plate layout changes are
   * honored. Mutually layered with `selectedObjectIds`/`plate` (the edit is authoritative when set).
   */
  sceneEdit: sceneEditSchema.optional(),
  /**
   * Plate previews to embed as each plate's `Metadata/plate_N.png` in the sliced output, for slices
   * with no `sceneEdit` to carry them (e.g. procedural calibration prints, which BambuStudio's CLI
   * gives no useful preview). When `sceneEdit.plateThumbnails` is present it takes precedence.
   */
  plateThumbnails: z.array(sceneEditPlateThumbnailSchema).optional()
})
export type CreateSlicingJob = z.infer<typeof createSlicingJobSchema>

/**
 * The slice settings preserved beside a sliced output's project 3MF, so a later
 * "slice again" can reopen the prepare-print dialog on what actually ran.
 *
 * A deliberately narrow subset of {@link createSlicingJobSchema}: the engine target,
 * the preset target, the plate scope, and the newer-project acknowledgement. Everything
 * else the original slice applied is already BAKED INTO the preserved project: the
 * arranged scene, object selection, per-object overrides, the authored machine, and (via
 * `slice-settings-authoring.ts`) the process and filament presets with their overrides,
 * so repeating it from here would apply it twice. What survives is only what is genuinely
 * not project state: which engine build ran it, and which plate was printed.
 *
 * This is a persisted wire format (a JSON column on `LibraryFile`/`PrintJob`): new fields
 * must be optional, and a row that fails to parse is treated as absent rather than fatal.
 */
export const preservedSliceSettingsSchema = z.object({
  slicerTargetId: z.string().trim().min(1).optional(),
  target: slicingTargetSchema,
  plate: z.number().int().nonnegative().default(0),
  allowNewerProjectFile: z.boolean().optional()
})
export type PreservedSliceSettings = z.infer<typeof preservedSliceSettingsSchema>

/**
 * Parse a persisted {@link PreservedSliceSettings} blob, returning null for absent or
 * unreadable values. Callers use it to decide whether a re-slice can be seeded; they must
 * never fail a request over it (an old or hand-edited row is a missing convenience, not an
 * error).
 */
export function parsePreservedSliceSettings(value: string | null | undefined): PreservedSliceSettings | null {
  if (!value) return null
  try {
    const parsed = preservedSliceSettingsSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export const slicingJobStatusSchema = z.enum([
  'queued',
  'preparing',
  'slicing',
  'saving',
  'ready',
  'failed',
  'cancelled'
])
export type SlicingJobStatus = z.infer<typeof slicingJobStatusSchema>

export const slicingOutputLineSchema = z.object({
  stream: z.enum(['stdout', 'stderr', 'system']),
  text: z.string(),
  createdAt: z.string()
})
export type SlicingOutputLine = z.infer<typeof slicingOutputLineSchema>

/** Per-material usage in a slice result (one row per project filament that was used). */
export const slicingMaterialUsageSchema = z.object({
  id: z.number().int().nullable().optional(),
  type: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  weightGrams: z.number().nonnegative().nullable().optional(),
  lengthMm: z.number().nonnegative().nullable().optional()
})
export type SlicingMaterialUsage = z.infer<typeof slicingMaterialUsageSchema>

export const slicingMetadataSchema = z.object({
  estimatedPrintTimeSeconds: z.number().nonnegative().nullable().optional(),
  estimatedPrepareTimeSeconds: z.number().nonnegative().nullable().optional(),
  estimatedFilamentLengthMm: z.number().nonnegative().nullable().optional(),
  estimatedFilamentWeightGrams: z.number().nonnegative().nullable().optional(),
  estimatedFilamentCost: z.number().nonnegative().nullable().optional(),
  /** Per-material usage breakdown (weight/length per project filament). */
  materials: z.array(slicingMaterialUsageSchema).nullable().optional()
}).optional()
export type SlicingMetadata = z.infer<typeof slicingMetadataSchema>

export const slicingJobSchema = z.object({
  id: z.string(),
  sourceFileId: z.string(),
  sourceFileName: z.string(),
  slicerTargetId: z.string().nullable().optional(),
  outputFileId: z.string().nullable(),
  outputFileName: z.string().nullable(),
  target: slicingTargetSchema,
  plate: z.number().int().nonnegative(),
  /** The browser tab that started it; see `createSlicingJobSchema.ownerClientId`. */
  ownerClientId: z.string().nullable().optional(),
  status: slicingJobStatusSchema,
  queuePosition: z.number().int().positive().nullable(),
  slicerName: z.string().nullable(),
  metadata: slicingMetadataSchema,
  output: z.array(slicingOutputLineSchema),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  cancelRequested: z.boolean()
})
export type SlicingJob = z.infer<typeof slicingJobSchema>

export const slicingJobsResponseSchema = z.object({
  jobs: z.array(slicingJobSchema)
})
export type SlicingJobsResponse = z.infer<typeof slicingJobsResponseSchema>

export const slicingJobResponseSchema = z.object({
  job: slicingJobSchema
})
export type SlicingJobResponse = z.infer<typeof slicingJobResponseSchema>

/** A job still moving through the pipeline (anything not ready/failed/cancelled). */
export function isActiveSlicingJob(job: SlicingJob): boolean {
  return job.status === 'queued' || job.status === 'preparing' || job.status === 'slicing' || job.status === 'saving'
}

/**
 * The status chip/search label for a slicing job. Shared because the server-side job-history
 * search matches against the SAME text users see on the card, a client-only copy would let
 * the two drift and make search misses look like missing jobs.
 */
export function getSlicingJobStatusLabel(job: SlicingJob): string {
  if (job.status === 'queued' && job.queuePosition) return `Queued #${job.queuePosition}`
  switch (job.status) {
    case 'queued': return 'Queued'
    case 'preparing': return 'Preparing'
    case 'slicing': return 'Slicing'
    case 'saving': return 'Saving'
    case 'ready': return 'Ready'
    case 'failed': return 'Failed'
    case 'cancelled': return 'Cancelled'
  }
}

/**
 * In-flight work on one engine. Absent means nothing is happening.
 *
 * A FAILED state is reported rather than cleared, because reverting a failed
 * install to plain "not installed" reads as the click having done nothing,
 * which is how someone retries into the same error without ever seeing it.
 */
export const slicerEngineInstallStatusSchema = z.object({
  state: z.enum(['installing', 'failed']),
  /** 0-1 while downloading; absent for phases with no measurable total. */
  fraction: z.number().min(0).max(1).optional(),
  label: z.string(),
  error: z.string().optional()
})
export type SlicerEngineInstallStatus = z.infer<typeof slicerEngineInstallStatusSchema>

/**
 * Which engines a workspace shows its users.
 *
 * `visibleIds: null` means all of them, a workspace that has never chosen must
 * not be pinned to whatever the engine set happened to be when it was created.
 * `available` is what the deployment actually has installed, so the surface can
 * offer the full set rather than only what is already chosen.
 */
export const slicerEngineVisibilitySchema = z.object({
  available: z.array(z.object({ id: z.string(), label: z.string() })),
  visibleIds: z.array(z.string()).nullable()
})
export type SlicerEngineVisibility = z.infer<typeof slicerEngineVisibilitySchema>

/** An empty list CLEARS the choice, restoring "show everything". */
export const slicerEngineVisibilityUpdateSchema = z.object({
  visibleIds: z.array(z.string().trim().min(1)).max(50)
})
export type SlicerEngineVisibilityUpdate = z.infer<typeof slicerEngineVisibilityUpdateSchema>

export const slicingCapabilitiesSchema = z.object({
  configured: z.boolean(),
  healthy: z.boolean(),
  slicerName: z.string().nullable(),
  defaultTargetId: z.string().trim().min(1).nullable(),
  targets: z.array(slicingTargetDescriptorSchema),
  maxConcurrentJobs: z.number().int().positive(),
  maxQueuedJobs: z.number().int().nonnegative(),
  targetModes: z.array(slicingTargetModeSchema),
  /**
   * An engine being fetched right now, or null.
   *
   * On CAPABILITIES rather than only the engines route, which needs
   * `settings.manage` and does not exist on the hosted plan. The person who
   * needs this is whoever opened a slice dialog on a container that is still
   * downloading its first engine, an ordinary user, who can read this and
   * nothing else.
   */
  engineInstall: slicerEngineInstallStatusSchema.nullable().default(null)
})
export type SlicingCapabilities = z.infer<typeof slicingCapabilitiesSchema>


export const slicerEngineSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string(),
  version: z.string(),
  slicerName: z.string(),
  /** Installable, but never chosen as the default. */
  prerelease: z.boolean(),
  /** True only when EVERY configured slicer instance has it. */
  installed: z.boolean(),
  downloadBytes: z.number().int().nonnegative(),
  installBytes: z.number().int().nonnegative(),
  status: slicerEngineInstallStatusSchema.nullable().default(null)
})
export type SlicerEngine = z.infer<typeof slicerEngineSchema>

/**
 * The engine manager's view of a deployment.
 *
 * `available: false` means the question could not be answered, no slicer
 * configured, or an instance did not respond. Distinct from an empty list,
 * because telling an operator nothing is installed when a sidecar is merely
 * restarting invites reinstalling gigabytes that are already there.
 */
export const slicerEngineListResponseSchema = z.object({
  available: z.boolean(),
  defaultTargetId: z.string().trim().min(1).nullable().default(null),
  engines: z.array(slicerEngineSchema).default([]),
  /** False where no engine can run on the slicer's platform (Linux on ARM). */
  platformSupported: z.boolean().default(false)
})
export type SlicerEngineListResponse = z.infer<typeof slicerEngineListResponseSchema>

/**
 * Wire contract for a single resolved profile file sent to the standalone
 * slicer with a slice request. The API produces these (resolved against the
 * workspace's profiles) and the slicer materialises them as CLI `--load-*` args.
 */
export const slicingPresetFileSchema = z.object({
  id: z.string().trim().min(1),
  source: z.enum(['builtin', 'custom']),
  kind: slicingPresetKindSchema,
  name: z.string().trim().min(1),
  content: z.string().optional()
})
export type SlicingPresetFile = z.infer<typeof slicingPresetFileSchema>

/**
 * Wire contract for the slice-request envelope the API POSTs to the standalone
 * slicer's `/slice` endpoint (carried as a base64 header). The API is the
 * producer and the slicer validates against this same schema, so the two
 * cannot drift.
 */
export const sliceEnvelopeSchema = z.object({
  jobId: z.string().trim().min(1),
  sourceFileName: z.string().trim().min(1),
  request: createSlicingJobSchema,
  profileFiles: z.array(slicingPresetFileSchema).optional()
})
export type SliceEnvelope = z.infer<typeof sliceEnvelopeSchema>
