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
import type { ProcessConfig, ProcessSettingsCatalog } from './process-settings.js'
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

// The diff + value-equality + bool serialization are catalog-independent — reuse verbatim.
export {
  diffProcessConfig as diffFilamentConfig,
  processConfigValuesEqual as filamentConfigValuesEqual,
  serializeProcessBool as serializeFilamentBool
} from './process-settings.js'

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
 * Response for `/profiles/resolve-filament`.
 * - `config`: the profile's effective values (for a `project:` filament, the 3MF's embedded slot
 *   column).
 * - `overriddenKeys`: for a `project:` filament, the slot's `different_settings_to_system` record —
 *   the 3MF's OWN in-project changes. This is the only "modified" signal the material dialog
 *   highlights; it must not value-diff `config` against `baseConfig`, which would also flag
 *   inherited drift the user never touched (legacy files can differ from their parent preset on
 *   dozens of untouched keys). Empty for installed presets.
 * - `baseConfig`: the named parent preset when installed (else `config`) — the RESET target for the
 *   overridden keys only.
 */
export interface ResolveFilamentConfigResponse {
  config: ProcessConfig
  baseConfig: ProcessConfig
  overriddenKeys: string[]
}
