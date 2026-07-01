/**
 * Server-side slicing contracts shared by the API, slicer UI, and the
 * standalone BambuStudio CLI worker runtime.
 */
import { z } from 'zod'
import { processSettingOverridesSchema } from './process-settings.js'

export const slicingProfileKindSchema = z.enum(['machine', 'process', 'filament'])
export type SlicingProfileKind = z.infer<typeof slicingProfileKindSchema>

export const slicingProfileSourceSchema = z.enum(['builtin', 'custom'])
export type SlicingProfileSource = z.infer<typeof slicingProfileSourceSchema>

export const slicerFamilySchema = z.enum(['bambustudio', 'orcaslicer'])
export type SlicerFamily = z.infer<typeof slicerFamilySchema>

export const slicingTargetDescriptorSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  family: slicerFamilySchema,
  version: z.string().trim().min(1),
  slicerName: z.string().trim().min(1),
  supportsEstimateModeMachineSwitch: z.boolean().default(false),
  isDefault: z.boolean().default(false)
})
export type SlicingTargetDescriptor = z.infer<typeof slicingTargetDescriptorSchema>

export const slicingProfileSummarySchema = z.object({
  id: z.string().trim().min(1),
  source: slicingProfileSourceSchema,
  kind: slicingProfileKindSchema,
  name: z.string().trim().min(1),
  /** BambuStudio filament profile ids from `filament_id`; used to match printer AMS/tray ids exactly. */
  filamentIds: z.array(z.string().trim().min(1)).optional(),
  /** BambuStudio filament material family from `filament_type`; preferred over parsing the profile name. */
  filamentType: z.string().trim().min(1).optional(),
  /** BambuStudio filament vendor from `filament_vendor`; preferred over parsing the profile name. */
  filamentVendor: z.string().trim().min(1).optional(),
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
export type SlicingProfileSummary = z.infer<typeof slicingProfileSummarySchema>

export const slicingProfilesResponseSchema = z.object({
  profiles: z.array(slicingProfileSummarySchema)
})
export type SlicingProfilesResponse = z.infer<typeof slicingProfilesResponseSchema>

export const uploadSlicingProfileSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  kind: slicingProfileKindSchema.optional(),
  fileName: z.string().trim().min(1).max(255).optional(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  content: z.string().trim().min(1).max(2 * 1024 * 1024),
  /** When true, overwrite existing same-name presets instead of reporting them as conflicts. */
  overwrite: z.boolean().optional()
})
export type UploadSlicingProfile = z.infer<typeof uploadSlicingProfileSchema>

export const slicingProfileResponseSchema = z.object({
  profile: slicingProfileSummarySchema,
  /** Names of existing same-kind presets overwritten by this upload (for warning the user). */
  replaced: z.array(z.string()).default([])
})
export type SlicingProfileResponse = z.infer<typeof slicingProfileResponseSchema>

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
  profileId: z.string().trim().min(1).nullable().optional()
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
  processSettingOverrides: processSettingOverridesSchema.optional()
})

export const slicingRealPrinterTargetSchema = slicingBaseTargetSchema.extend({
  mode: z.literal('realPrinter'),
  printerId: z.string().trim().min(1)
})
export type SlicingRealPrinterTarget = z.infer<typeof slicingRealPrinterTargetSchema>

export const slicingManualProfileTargetSchema = slicingBaseTargetSchema.extend({
  mode: z.literal('manualProfile'),
  printerModel: z.string().trim().min(1).default('unknown'),
  printerProfileId: z.string().trim().min(1)
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
  objectId: z.number().int().positive().optional(),
  /** Staged import this instance places (see `stagedImportSchema`); baked into a new 3MF object. */
  importId: z.string().trim().min(1).optional(),
  /** 1-based plate this instance is placed on. */
  plateIndex: z.number().int().positive(),
  position: sceneEditVec3Schema,
  rotation: sceneEditVec3Schema,
  scale: sceneEditVec3Schema,
  /**
   * Optional full local transform (12 numbers, column-major 3x3 + translation).
   * When present it is used verbatim instead of composing translate*rotate*scale —
   * needed because world-space scale on a rotated object produces a shear that the
   * decomposed T*R*S form can't represent. position/rotation/scale stay for display.
   */
  matrix: z.array(z.number()).length(12).optional(),
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
  objectId: z.number().int().positive(),
  componentObjectId: z.number().int().positive(),
  filamentId: z.number().int().positive()
})
export type SceneEditPartFilament = z.infer<typeof sceneEditPartFilamentSchema>

/**
 * Per-PART process overrides — process settings on one part (volume) of an object, separate from
 * the object's overall overrides (BambuStudio's per-volume config). Keyed by the object id + the
 * part's component object id; written as `<metadata>` inside that part's `model_settings` block.
 * Like {@link sceneEditPartFilamentSchema}, a part is shared by every instance of the object.
 */
export const sceneEditPartProcessOverrideSchema = z.object({
  objectId: z.number().int().positive(),
  componentObjectId: z.number().int().positive(),
  overrides: processSettingOverridesSchema
})
export type SceneEditPartProcessOverride = z.infer<typeof sceneEditPartProcessOverrideSchema>

/**
 * Per-object display-name override (user renamed an object in the editor's object
 * list). Keyed like an instance reference — by base-project `objectId` or by staged
 * `importId` (resolved to its baked object id at write time) — and applied by
 * rewriting the object's `name` metadata in `model_settings.config`. The name is a
 * label only; it does not affect the sliced G-code.
 */
export const sceneEditObjectNameSchema = z.object({
  objectId: z.number().int().positive().optional(),
  importId: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).max(255)
}).refine((value) => (value.objectId == null) !== (value.importId == null), {
  message: 'Each object name override must reference exactly one of objectId or importId'
})
export type SceneEditObjectName = z.infer<typeof sceneEditObjectNameSchema>

/**
 * Per-part triangle-paint state (Bambu Studio's "support painting" and "seam painting"
 * brushes share this shape). Paint lives on a part's mesh triangles — shared by every
 * instance of the object — so it is keyed like {@link sceneEditPartFilamentSchema} by
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
 * codes routinely run into the hundreds — and occasionally low thousands — of hex chars; the old
 * 64-char cap silently rejected any deeply-painted part on save. This is a generous sanity guard
 * only (the 4MB JSON body limit is the real DoS bound); it must stay well above anything the
 * editor's encoder or a source 3MF can legitimately produce so a save never fails on valid paint.
 */
export const MAX_PAINT_CODE_LENGTH = 100_000
export const sceneEditPartPaintSchema = z.object({
  objectId: z.number().int().positive(),
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
export const sceneEditObjectBrimEarsSchema = z.object({
  objectId: z.number().int().positive(),
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
   * 3MF so a profile change (e.g. PLA -> PETG) persists — without it the saved file keeps the
   * old preset name and reopens as the previous material. Null/omitted keeps the existing id.
   */
  settingsId: z.string().trim().min(1).nullable().optional(),
  sourceIndex: z.number().int().nonnegative().nullable().optional(),
  /**
   * Desired runtime nozzle for this slot on a dual-nozzle machine (0 = right, 1 = left) —
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

/** Bambu volume subtypes the editor can add to an object as a new part. */
export const sceneEditAddedPartSubtypeSchema = z.enum([
  'negative_part',
  'modifier_part',
  'support_blocker',
  'support_enforcer'
])
export type SceneEditAddedPartSubtype = z.infer<typeof sceneEditAddedPartSubtypeSchema>

/**
 * A new volume added INSIDE an existing object (BambuStudio's "Add negative part /
 * modifier / support blocker / enforcer"): the staged import's mesh becomes a new
 * object resource referenced as a `<component>` of the parent root object, and the
 * parent's `model_settings.config` entry gains a `<part>` with the given subtype.
 * `matrix` is the part's OBJECT-LOCAL placement (12 numbers, column-major 3x3 +
 * translation — the same convention as `sceneEditInstanceSchema.matrix`).
 */
export const sceneEditAddedPartSchema = z.object({
  objectId: z.number().int().positive(),
  importId: z.string().trim().min(1),
  subtype: sceneEditAddedPartSubtypeSchema,
  name: z.string().trim().min(1).max(200),
  matrix: z.array(z.number()).length(12),
  /**
   * Per-volume process overrides (modifier parts): written as `<metadata key value/>`
   * entries inside the part's `model_settings.config` block, which is exactly how
   * BambuStudio persists ModelVolume config — the slicer applies them inside the
   * volume. Values are the serialized config strings.
   */
  settings: z.record(z.string().min(1).max(64), z.string().max(512)).optional()
})
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
 * keyed by the import and the 0-based solid index — because an unsaved import has no baked
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
 * Per-part PROCESS overrides for a multi-solid import, keyed by import + 0-based solid index —
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

export const sceneEditSchema = z.object({
  plates: z.array(sceneEditPlateSchema).min(1),
  instances: z.array(sceneEditInstanceSchema),
  /** Optional new volumes added inside existing objects (negative parts, modifiers, ...). */
  addedParts: z.array(sceneEditAddedPartSchema).max(200).optional(),
  /** Optional object→import geometry replacements (Replace-with); see {@link sceneEditMeshReplacementSchema}. */
  meshReplacements: z.array(sceneEditMeshReplacementSchema).max(200).optional(),
  /** Optional per-object-part filament overrides (material reassignment) for in-project objects. */
  partFilaments: z.array(sceneEditPartFilamentSchema).optional(),
  /** Optional per-part process overrides (process settings on individual parts of an object). */
  partProcessOverrides: z.array(sceneEditPartProcessOverrideSchema).optional(),
  /** Optional per-part filament for multi-solid imports, keyed by import + solid index. */
  importPartFilaments: z.array(sceneEditImportPartFilamentSchema).max(400).optional(),
  /** Optional per-part process overrides for multi-solid imports, keyed by import + solid index. */
  importPartProcessOverrides: z.array(sceneEditImportPartProcessOverrideSchema).max(400).optional(),
  /** Optional per-part support-paint maps (parts painted with the support brush). */
  supportPaint: z.array(sceneEditPartPaintSchema).optional(),
  /** Optional per-part seam-paint maps (parts painted with the seam brush). */
  seamPaint: z.array(sceneEditPartPaintSchema).optional(),
  /** Optional per-part colour-paint maps (`paint_color`, Bambu's colour painting). */
  colorPaint: z.array(sceneEditPartPaintSchema).optional(),
  /** Optional per-object manual brim ears (complete replacement sets). */
  brimEars: z.array(sceneEditObjectBrimEarsSchema).optional(),
  /** Optional per-plate layer-based filament changes (replaces listed plates' entries). */
  filamentChanges: z.array(sceneEditPlateFilamentChangesSchema).optional(),
  /** Optional per-object display-name overrides (object renamed in the editor). */
  objectNames: z.array(sceneEditObjectNameSchema).optional(),
  /**
   * Optional full desired filament list. When present it replaces the project's
   * filament set (enabling Bambu-style add/remove of materials); when omitted the
   * source project's filaments are kept as-is.
   */
  filaments: z.array(sceneEditFilamentSchema).optional(),
  /**
   * Optional client-rendered plate previews (edited layout) to embed as each plate's
   * thumbnail in the sliced output, since the slicer CLI can't regenerate them here.
   */
  plateThumbnails: z.array(sceneEditPlateThumbnailSchema).optional()
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
  bounds: z.object({ min: sceneEditVec3Schema, max: sceneEditVec3Schema })
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

export const stageImportFromLibrarySchema = z.object({
  libraryFileId: z.string().trim().min(1),
  /** For multi-object 3MF sources, the Bambu object_id to import; omitted ⇒ the whole model. */
  objectId: z.number().int().positive().optional()
})
export type StageImportFromLibrary = z.infer<typeof stageImportFromLibrarySchema>

/**
 * Persist an edited arrangement as a 3MF. `baseFileId` is the source project the edit started from,
 * or null for a brand-new project built from an empty skeleton. `mode` chooses between overwriting
 * the base as a new library version and creating a new library file (`name` required for the latter).
 */
export const saveArrangedThreeMfSchema = z.object({
  baseFileId: z.string().trim().min(1).nullable(),
  /**
   * Build from an archived version's content instead of the file's current content
   * (the history dialog's Edit flow). Must belong to `baseFileId`. `newVersion` saves
   * still land as a NEW version of the file — the old version is never mutated.
   */
  baseVersionId: z.string().trim().min(1).nullable().optional(),
  mode: z.enum(['newVersion', 'saveAs']),
  name: z.string().trim().min(1).max(255).optional(),
  folderId: z.string().trim().min(1).nullable().optional(),
  bridgeId: z.string().trim().min(1).nullable().optional(),
  sceneEdit: sceneEditSchema,
  /**
   * Per-object process-setting overrides, keyed by Bambu `object_id` (or a fresh import's
   * synthetic id, which is re-keyed onto the baked object). Persisted into the saved 3MF's
   * `model_settings.config` so per-object process edits survive the save (not just a slice).
   */
  objectProcessOverrides: z.record(z.string().min(1), processSettingOverridesSchema).optional(),
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
}).refine((value) => value.mode !== 'saveAs' || Boolean(value.name), {
  message: 'A name is required when saving as a new file'
}).refine((value) => value.mode !== 'newVersion' || Boolean(value.baseFileId), {
  message: 'newVersion requires a base file'
})
export type SaveArrangedThreeMf = z.infer<typeof saveArrangedThreeMfSchema>

export const createSlicingJobSchema = z.object({
  sourceFileId: z.string().trim().min(1),
  /**
   * Slice an archived version of the source file instead of the current
   * content. Must belong to `sourceFileId`; outputs still land beside the
   * parent file.
   */
  sourceVersionId: z.string().trim().min(1).optional(),
  slicerTargetId: z.string().trim().min(1).optional(),
  target: slicingTargetSchema,
  outputFileName: z.string().trim().min(1).max(255).optional(),
  outputFolderId: z.string().trim().min(1).nullable().optional(),
  hiddenOutput: z.boolean().optional(),
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
   * Edited plate arrangement from the interactive 3D editor. When present, the source 3MF's
   * build items and `model_settings.config` plates/instances are rewritten to match before
   * slicing, so moved/rotated/scaled/added/removed models and multi-plate layout changes are
   * honored. Mutually layered with `selectedObjectIds`/`plate` (the edit is authoritative when set).
   */
  sceneEdit: sceneEditSchema.optional()
})
export type CreateSlicingJob = z.infer<typeof createSlicingJobSchema>

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

export const slicingCapabilitiesSchema = z.object({
  configured: z.boolean(),
  healthy: z.boolean(),
  slicerName: z.string().nullable(),
  defaultTargetId: z.string().trim().min(1).nullable(),
  targets: z.array(slicingTargetDescriptorSchema),
  maxConcurrentJobs: z.number().int().positive(),
  maxQueuedJobs: z.number().int().nonnegative(),
  targetModes: z.array(slicingTargetModeSchema)
})
export type SlicingCapabilities = z.infer<typeof slicingCapabilitiesSchema>

/**
 * Wire contract for a single resolved profile file sent to the standalone
 * slicer with a slice request. The API produces these (resolved against the
 * tenant's profiles) and the slicer materialises them as CLI `--load-*` args.
 */
export const sliceProfileFileSchema = z.object({
  id: z.string().trim().min(1),
  source: z.enum(['builtin', 'custom']),
  kind: slicingProfileKindSchema,
  name: z.string().trim().min(1),
  content: z.string().optional()
})
export type SliceProfileFile = z.infer<typeof sliceProfileFileSchema>

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
  profileFiles: z.array(sliceProfileFileSchema).optional()
})
export type SliceEnvelope = z.infer<typeof sliceEnvelopeSchema>
