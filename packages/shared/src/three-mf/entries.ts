/**
 * Canonical entry paths inside a Bambu 3MF archive.
 *
 * A 3MF is a ZIP with a fixed internal layout, and every surface that touches one needs the same
 * handful of paths: the api reader and bake, the bridge's index parse, `save-retarget`, and the
 * browser's client-side archive reader. Each of those had been spelling the strings itself,
 * `Metadata/slice_info.config` alone was declared in three places, so a typo or a Bambu layout
 * change would have to be chased across the tree.
 *
 * Two siblings live with the parser that owns their format rather than here, because their content
 * schema and their path travel together: `CUSTOM_GCODE_PER_LAYER_ENTRY` (`index-parser.ts`) and
 * `BRIM_EAR_POINTS_ENTRY` (`scene-parser.ts`).
 */

/** Root model document: the `<resources>`/`<build>` XML every 3MF has. */
export const THREE_MF_MODEL_ENTRY = '3D/3dmodel.model'

/**
 * Relationships for the root model, listing the split-out `/3D/Objects/*.model` sub-models.
 * Production-Extension projects have one; a flat 3MF does not (the writer creates it when it
 * splits an import into its own part file).
 */
export const THREE_MF_MODEL_RELS_ENTRY = '3D/_rels/3dmodel.model.rels'

/** Bambu's per-object/per-part settings sidecar (names, extruders, subtypes, plates). */
export const THREE_MF_MODEL_SETTINGS_ENTRY = 'Metadata/model_settings.config'

/** The project's full machine/process/filament configuration, as JSON. */
export const THREE_MF_PROJECT_SETTINGS_ENTRY = 'Metadata/project_settings.config'

/**
 * Record of a PREVIOUS slice (one `<filament>` per filament that slice used), not project state.
 * The writer drops it whenever it no longer describes the filament set being saved: carrying a
 * mismatched record forward makes BambuStudio read its per-plate nozzle grouping out of bounds.
 */
export const THREE_MF_SLICE_INFO_ENTRY = 'Metadata/slice_info.config'
