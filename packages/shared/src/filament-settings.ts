/**
 * Bambu-faithful FILAMENT (material) settings contracts and logic.
 *
 * Owns the typed filament settings catalog (generated from BambuStudio's
 * `TabFilament::build()` layout + `PrintConfig.cpp` metadata) consumed by the material "tune"
 * dialog (the settings icon next to the trashbin in the slice/editor material list). The dialog
 * mirrors the process settings dialog — tabs, search, per-key reset — so this module deliberately
 * REUSES the process module's catalog-agnostic surface (`ProcessSettingOption`, `ProcessConfig`,
 * `diffProcessConfig`, `processConfigValuesEqual`, `processSettingOverridesSchema`) rather than
 * cloning it; only the catalog data, the default-fill (catalog-scoped), and the resolve contract
 * are filament-specific.
 *
 * Config values use BambuStudio's serialized form: scalars are strings and vector options are
 * arrays of those strings. In a FILAMENT preset the per-filament options are 1-length vectors
 * (BambuStudio edits extruder index 0); overrides carry only the keys the user changed.
 *
 * Counterparts: the API `/api/slicing/profiles/resolve-filament` route resolves a filament
 * profile's base config; the slicer applies the resulting `filamentSettingOverrides` on top of the
 * loaded filament profile at slice time (apps/slicer materializeProfileFile).
 */
import { z } from 'zod'
import { diffProcessConfig, processConfigValuesEqual, type ProcessConfig, type ProcessSettingsCatalog } from './process-settings.js'
import { filamentSettingsCatalog } from './generated/filament-settings.generated.js'

export { filamentSettingsCatalog }

/**
 * A filament settings option / config value / sparse-override map are structurally identical to the
 * process equivalents (same serialized-string model), so we alias the process types rather than
 * redeclare them. Consumers should prefer these filament-named aliases for intent.
 */
export type {
  ProcessSettingOption as FilamentSettingOption,
  ProcessSettingType as FilamentSettingType,
  ProcessSettingMode as FilamentSettingMode,
  ProcessSettingLine as FilamentSettingLine,
  ProcessSettingGroup as FilamentSettingGroup,
  ProcessSettingPage as FilamentSettingPage,
  ProcessSettingsCatalog as FilamentSettingsCatalog,
  ProcessConfig as FilamentConfig,
  ProcessConfigValue as FilamentConfigValue,
  ProcessSettingOverrides as FilamentSettingOverrides
} from './process-settings.js'

// Value-equality and bool serialization are catalog-independent — reuse verbatim. Callers pass the
// option (from `filamentSettingsCatalog.options[key]`) so percent/float values that differ only in
// serialized form don't read as changed; see `processConfigValuesEqual`.
export {
  processConfigValuesEqual as filamentConfigValuesEqual,
  serializeProcessBool as serializeFilamentBool
} from './process-settings.js'

/**
 * {@link diffProcessConfig} bound to the FILAMENT catalog, so each key's value-equality uses the
 * filament option's type. Same contract otherwise: the sparse map of keys whose value changed.
 */
export function diffFilamentConfig(base: ProcessConfig, edited: ProcessConfig): FilamentSettingOverridesMap {
  return diffProcessConfig(base, edited, filamentSettingsCatalog)
}

/**
 * Every recognized filament-setting key (the catalog's options). Use as an ALLOWLIST when reading
 * per-filament overrides out of a 3MF or a request, so identity/placement keys are never mistaken
 * for filament settings.
 */
export const FILAMENT_SETTING_KEYS: ReadonlySet<string> = new Set(Object.keys(filamentSettingsCatalog.options))

/** True when `key` is a recognized filament setting. */
export function isFilamentSettingKey(key: string): boolean {
  return FILAMENT_SETTING_KEYS.has(key)
}

/**
 * Keys that say WHICH material a slot holds, not how it is tuned. They are excluded from the
 * "changed vs preset" math: a saved project always records them (the writer keeps them as the
 * slot's identity — see FILAMENT_IDENTITY_KEYS in the API's scene builder), and they routinely
 * disagree with the preset for reasons the user never chose. Bambu's "Support For PLA/PETG"
 * preset, for instance, declares `filament_type: PLA` while the material is selected as PLA-S,
 * so counting it reported a permanent phantom change on a filament nobody had edited.
 */
const FILAMENT_IDENTITY_SETTING_KEYS: ReadonlySet<string> = new Set([
  'filament_type',
  'filament_colour',
  'filament_settings_id',
  'filament_ids',
  'filament_nozzle_map',
  'filament_notes'
])

/** True when `key` identifies the material rather than tuning it. */
export function isFilamentIdentitySettingKey(key: string): boolean {
  return FILAMENT_IDENTITY_SETTING_KEYS.has(key)
}

/**
 * Collapse every per-filament array to its element-0 scalar — the value BambuStudio's filament tab
 * edits (`get_option(key, 0)`). A filament preset resolved for a multi-extruder-variant machine
 * serializes each per-filament setting as an N-element vector (e.g. `["0","0"]`), while a project's
 * per-slot config is a single scalar. The material dialog normalizes both through this so a value
 * that is equal apart from its array LENGTH doesn't falsely read as "modified" (and resetting it
 * changes nothing visible). Non-array values pass through unchanged.
 */
export function scalarizeFilamentConfig(config: ProcessConfig): ProcessConfig {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, Array.isArray(value) ? (typeof value[0] === 'string' ? value[0] : '') : value])
  )
}

/** Sparse map of changed filament keys carried with a slice request or saved preset. */
export const filamentSettingOverridesSchema = z.record(
  z.string().min(1),
  z.union([z.string(), z.array(z.string())])
)
export type FilamentSettingOverridesMap = z.infer<typeof filamentSettingOverridesSchema>

/**
 * Overlays a resolved filament preset config on top of every catalog option's PrintConfig default,
 * returning the full effective config BambuStudio would display. Preset values always win; only
 * keys the preset leaves unset are filled from `option.default`. Mirrors
 * `applyProcessConfigDefaults` but scoped to the filament catalog, so the material dialog shows
 * real values instead of blanks for un-inherited keys.
 */
export function applyFilamentConfigDefaults(config: ProcessConfig): ProcessConfig {
  const result: ProcessConfig = { ...config }
  const catalog: ProcessSettingsCatalog = filamentSettingsCatalog
  for (const [key, option] of Object.entries(catalog.options)) {
    if (result[key] !== undefined) continue
    if (option.default !== undefined) result[key] = option.default
  }
  return result
}

/**
 * Normalized view of a `resolve-filament` response: the scalarized effective/baseline configs the
 * material dialog edits against, the fallback changed-keys record, and each key's original
 * per-variant vector shape (for broadcasting an edited scalar back at apply time). Owned here so
 * the dialog and the pre-open "changed values" badge derive from ONE implementation and can never
 * disagree about what counts as modified.
 */
export interface ResolvedFilamentState {
  /** Values shown/sliced: the profile's own config over parent/catalog fill (element-0 scalars). */
  effective: ProcessConfig
  /** Reset/diff baseline: the parent preset where it defines a key, the own value elsewhere. */
  baseline: ProcessConfig
  /** Fallback changed-keys record (`different_settings_to_system`) when the parent didn't resolve. */
  bakedKeys: string[]
  /** Per-key original vector length (baseline's shape preferred, own config's as fallback). */
  shapes: Record<string, number>
}

export function prepareResolvedFilamentState(response: ResolveFilamentConfigResponse): ResolvedFilamentState {
  const rawBase = applyFilamentConfigDefaults(response.baseConfig ?? response.config)
  const shapes: Record<string, number> = {}
  for (const [key, value] of Object.entries(response.config)) shapes[key] = Array.isArray(value) ? value.length : 1
  for (const [key, value] of Object.entries(rawBase)) shapes[key] = Array.isArray(value) ? value.length : 1
  const parent = scalarizeFilamentConfig(rawBase)
  const own = scalarizeFilamentConfig(response.config)
  const effective = { ...parent, ...own }
  // Keys the parent doesn't define fall back to the own value as baseline, so a value the project
  // carries but the preset omits (often a blank) never reads as changed-against-nothing.
  const baseline = { ...effective, ...parent }
  return { effective, baseline, bakedKeys: response.overriddenKeys ?? [], shapes }
}

/**
 * Catalog keys whose FINAL sliced value (effective config + the given session overrides) differs
 * from the external preset — the count a fresh dialog would flag, and the number the slice
 * dialog's pre-open badge shows. Note the healing property: overrides that push a drifted value
 * BACK to the preset value reduce this count (a fully reset material reads 0 even though heal
 * overrides ride the slice request).
 */
export function resolvedFilamentModifiedKeys(state: ResolvedFilamentState, overrides: ProcessConfig = {}): string[] {
  const finalConfig = { ...state.effective, ...scalarizeFilamentConfig(overrides) }
  const keys = new Set<string>()
  for (const key of Object.keys(finalConfig)) {
    if (!FILAMENT_SETTING_KEYS.has(key) || isFilamentIdentitySettingKey(key)) continue
    if (!processConfigValuesEqual(state.baseline[key], finalConfig[key], filamentSettingsCatalog.options[key])) keys.add(key)
  }
  // Record-marked keys stay flagged while untouched relative to the embedded config (parent
  // baseline unresolved), mirroring the dialog's bakedKeys condition.
  for (const key of state.bakedKeys) {
    if (!FILAMENT_SETTING_KEYS.has(key) || isFilamentIdentitySettingKey(key)) continue
    if (processConfigValuesEqual(finalConfig[key], state.effective[key], filamentSettingsCatalog.options[key])) keys.add(key)
  }
  return [...keys]
}

/** Request body for resolving a filament profile's base config for the material dialog. */
export const resolveFilamentConfigRequestSchema = z.object({
  filamentProfileId: z.string().trim().min(1),
  targetId: z.string().trim().min(1).nullable().optional(),
  /**
   * Library file id of the source 3MF. Required when `filamentProfileId` is a project-embedded
   * (`project:`) filament, whose base config lives in the project's
   * `Metadata/project_settings.config` (at that filament's slot) rather than an installed preset.
   */
  sourceFileId: z.string().trim().min(1).nullable().optional(),
  /**
   * 1-based filament slot index within the source 3MF for a `project:` filament — selects which
   * per-filament column of the embedded arrays to read. Ignored for installed/custom presets.
   */
  projectFilamentId: z.number().int().positive().nullable().optional()
})
export type ResolveFilamentConfigRequest = z.infer<typeof resolveFilamentConfigRequestSchema>

/**
 * Response for `/profiles/resolve-filament` — same contract as `/profiles/resolve-process`.
 * - `config`: the profile's effective values (for a `project:` filament, the 3MF's embedded slot
 *   column) — the base the slicer merges further overrides onto.
 * - `baseConfig`: the preset baseline to reset toward and value-diff against ("modified" = the
 *   value differs from the preset OUTSIDE the project). Equal to `config` for installed presets;
 *   the resolved parent preset for a project filament when resolvable.
 * - `overriddenKeys`: fallback changed-keys signal (the slot's `different_settings_to_system`
 *   record), populated only when the parent preset could not be resolved.
 */
export interface ResolveFilamentConfigResponse {
  config: ProcessConfig
  baseConfig: ProcessConfig
  overriddenKeys: string[]
}
