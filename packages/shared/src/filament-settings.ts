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
import {
  diffProcessConfig,
  processConfigValuesEqual,
  type ProcessConfig,
  type ProcessSettingOption,
  type ProcessSettingsCatalog
} from './process-settings.js'
import { filamentSettingsCatalog } from './generated/filament-settings.generated.js'
import { resolveDisplayFilamentType } from './slicing-preset-identity.js'

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
  /** Values shown/sliced: the profile's own config over preset/catalog fill (element-0 scalars). */
  effective: ProcessConfig
  /**
   * Reset target and the "changed HERE" diff source: the PRESET in use. Anything differing from it
   * belongs to this project/session, so this is what the badge counts and the dialog colours.
   */
  baseline: ProcessConfig
  /**
   * The preset's own parent. Differences between `baseline` and this belong to the PRESET, not to
   * the project — rendered as emphasis only, never badged, never caught by "changed only". Equal to
   * `baseline` when no parent resolved, which collapses the distinction rather than inventing one.
   */
  parentBaseline: ProcessConfig
  /** The 3MF's changed-from-system record for this slot (`different_settings_to_system`). */
  bakedKeys: string[]
  /** See {@link ResolveFilamentConfigResponse.declaresOverrides} — carried so the badge can apply it. */
  declaresOverrides: boolean
  /**
   * Whether a real PRESET resolved to diff against. False when the response carried no `baseConfig`
   * (the named preset is not installed), in which case {@link baseline} is just a copy of the
   * profile's own values and a value diff can only ever be empty — so the declared record is the
   * only evidence of a change there is. Consumers must branch on this rather than silently
   * reporting "nothing changed" for a project whose preset went missing.
   */
  baselineResolved: boolean
  /** Per-key original vector length (baseline's shape preferred, own config's as fallback). */
  shapes: Record<string, number>
  /**
   * The same three configs BEFORE the element-0 collapse. The dialog edits scalars (BambuStudio's
   * filament tab does too), but a value can differ on a LATER variant only — so every "is this
   * changed" question compares these through {@link filamentVariantValuesEqual}, not the scalars.
   */
  raw: { effective: ProcessConfig; baseline: ProcessConfig; parentBaseline: ProcessConfig }
}

export function prepareResolvedFilamentState(response: ResolveFilamentConfigResponse): ResolvedFilamentState {
  const rawBase = applyFilamentConfigDefaults(response.baseConfig ?? response.config)
  const shapes: Record<string, number> = {}
  for (const [key, value] of Object.entries(response.config)) shapes[key] = Array.isArray(value) ? value.length : 1
  for (const [key, value] of Object.entries(rawBase)) shapes[key] = Array.isArray(value) ? value.length : 1
  const preset = scalarizeFilamentConfig(rawBase)
  const own = scalarizeFilamentConfig(response.config)
  const effective = { ...preset, ...own }
  // Keys the preset doesn't define fall back to the own value as baseline, so a value the project
  // carries but the preset omits (often a blank) never reads as changed-against-nothing.
  const baseline = { ...effective, ...preset }
  const parentBaseline = response.parentConfig
    ? { ...baseline, ...scalarizeFilamentConfig(applyFilamentConfigDefaults(response.parentConfig)) }
    : baseline
  // Same overlay order, un-collapsed. Kept beside the scalars rather than replacing them: the dialog
  // and its reset write scalars, and only the comparisons need the variants.
  const rawEffective = { ...rawBase, ...response.config }
  const rawBaseline = { ...rawEffective, ...rawBase }
  const rawParentBaseline = response.parentConfig
    ? { ...rawBaseline, ...applyFilamentConfigDefaults(response.parentConfig) }
    : rawBaseline
  return {
    effective,
    baseline,
    parentBaseline,
    bakedKeys: response.overriddenKeys ?? [],
    declaresOverrides: response.declaresOverrides === true,
    baselineResolved: response.baselineResolved !== false,
    shapes,
    raw: { effective: rawEffective, baseline: rawBaseline, parentBaseline: rawParentBaseline }
  }
}

/**
 * Keys the PRESET overrides relative to its own parent — emphasis only.
 *
 * Deliberately not part of {@link resolvedFilamentModifiedKeys}: BambuStudio keeps the two as
 * separate queries (`current_dirty_options` vs `current_different_from_parent_options`) and only
 * the former drives its modified marker. Counting these was what made a user preset's own settings
 * look like changes the project had made.
 */
export function resolvedFilamentPresetOverrideKeys(state: ResolvedFilamentState): string[] {
  const keys: string[] = []
  for (const key of Object.keys(state.baseline)) {
    if (!FILAMENT_SETTING_KEYS.has(key) || isFilamentIdentitySettingKey(key)) continue
    if (!filamentVariantValuesEqual(state.raw.parentBaseline[key], state.raw.baseline[key], filamentSettingsCatalog.options[key])) {
      keys.push(key)
    }
  }
  return keys
}

/**
 * Catalog keys whose FINAL sliced value (effective config + the given session overrides) differs
 * from the external preset — the count a fresh dialog would flag, and the number the slice
 * dialog's pre-open badge shows. Note the healing property: overrides that push a drifted value
 * BACK to the preset value reduce this count (a fully reset material reads 0 even though heal
 * overrides ride the slice request).
 */
/**
 * Value equality that can see PAST the first extruder variant.
 *
 * A filament value is stored per variant (`["25","40"]` = 25 on the first extruder, 40 on the
 * second), and everything else here works on element 0 because that is what the dialog edits. That
 * collapse also hid real drift: a project carrying `["25","25"]` under a preset saying
 * `["25","40"]` matched on element 0 and reported nothing, while slicing the second extruder at a
 * value the preset never asked for.
 *
 * A SCALAR still means "this value, for every variant" — which is why the collapse existed at all
 * (a preset resolves to `["270","270"]` where the project stores `"270"`, and length-sensitive
 * equality flagged every such key). So a scalar equals a vector when it equals EVERY element, and
 * two vectors compare element-wise. Differing lengths with neither side scalar cannot be aligned,
 * so they are treated as different rather than guessed at.
 */
export function filamentVariantValuesEqual(
  left: ProcessConfig[string] | undefined,
  right: ProcessConfig[string] | undefined,
  option: ProcessSettingOption | undefined
): boolean {
  const leftValues = Array.isArray(left) ? left : [left]
  const rightValues = Array.isArray(right) ? right : [right]
  if (leftValues.length === 0 || rightValues.length === 0) return processConfigValuesEqual(left, right, option)
  const length = Math.max(leftValues.length, rightValues.length)
  if (leftValues.length !== rightValues.length && leftValues.length !== 1 && rightValues.length !== 1) return false
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftValues.length === 1 ? leftValues[0] : leftValues[index]
    const rightValue = rightValues.length === 1 ? rightValues[0] : rightValues[index]
    if (!processConfigValuesEqual(leftValue, rightValue, option)) return false
  }
  return true
}

/**
 * Whether a project slot's baked values still describe the material a slot is being pointed at.
 *
 * A 3MF bakes each slot's tuning into `project_settings.config`, and those values keep applying when
 * the user picks a different preset for that slot — which is right while the MATERIAL is the same
 * (this is how a project keeps a raised flow ratio on stock PETG) and wrong the moment it is not:
 * PETG's 245C nozzle temperature has no business following the slot to PLA Basic.
 *
 * Mirrors BambuStudio's `Tab::select_preset` (Tab.cpp): selecting a filament preset whose
 * `filament_type` differs from the edited one sets `no_transfer = true`, so nothing carries; the
 * transfer option exists only on the PRINT (process) tab, and a printer switch never transfers.
 * Types are compared DERIVED ({@link resolveDisplayFilamentType}), so a support filament counts as
 * its own material rather than as its base polymer.
 *
 * Returns true when either side has no type to compare — absence is not proof of a mismatch, and
 * discarding a project's real values on a guess is the worse failure.
 */
export function filamentSlotValuesCarryTo(slotConfig: ProcessConfig, presetConfig: ProcessConfig): boolean {
  const slotType = rawFilamentTypeOf(slotConfig)
  const presetType = rawFilamentTypeOf(presetConfig)
  if (!slotType || !presetType) return true
  return slotType.toUpperCase() === presetType.toUpperCase()
}

/**
 * The RAW `filament_type` of a config — what BambuStudio's transfer decision reads.
 *
 * Deliberately not the DERIVED display type. `Tab::select_preset` compares
 * `config.option("filament_type")->values[0]` on both presets and sets `no_transfer` only when those
 * differ; the derived type (which folds in `filament_is_support`, so "Bambu PLA Basic" reads PLA and
 * "Bambu Support for PLA" reads PLA-S) belongs to DISPLAY and filtering. Using it here made us
 * discard a user's tuned values on a switch BambuStudio would have carried them through.
 */
function rawFilamentTypeOf(config: ProcessConfig): string | undefined {
  const value = config.filament_type
  const entry = Array.isArray(value) ? value[0] : value
  return typeof entry === 'string' && entry.trim() ? entry.trim() : undefined
}

/** Derived filament type of a config, reading either the scalar or per-slot/variant array form. */
function displayFilamentTypeOf(config: ProcessConfig): string | undefined {
  const first = (value: ProcessConfig[string] | undefined): string | undefined => {
    const entry = Array.isArray(value) ? value[0] : value
    return typeof entry === 'string' && entry.trim() ? entry.trim() : undefined
  }
  const rawIds = config.filament_ids
  return resolveDisplayFilamentType({
    filamentType: first(config.filament_type) ?? null,
    filamentIds: Array.isArray(rawIds) ? rawIds : typeof rawIds === 'string' && rawIds ? [rawIds] : null,
    filamentIsSupport: first(config.filament_is_support) === '1'
  })
}

/**
 * {@link diffFilamentConfig} in per-variant space: the sparse map of keys whose value differs from
 * `base` once LATER extruder variants are compared too. Used by the material dialog to emit its
 * overrides, so a drift the dialog flags (project `["25","25"]` under a preset `["25","40"]`) also
 * has a reset that emits something — the element-0 diff emitted nothing there, leaving a reset
 * button that visibly did nothing.
 */
export function diffFilamentVariantConfig(base: ProcessConfig, edited: ProcessConfig): FilamentSettingOverridesMap {
  const overrides: FilamentSettingOverridesMap = {}
  for (const [key, value] of Object.entries(edited)) {
    if (!filamentVariantValuesEqual(base[key], value, filamentSettingsCatalog.options[key])) overrides[key] = value
  }
  return overrides
}

export function resolvedFilamentModifiedKeys(state: ResolvedFilamentState, overrides: ProcessConfig = {}): string[] {
  // An override is whatever the dialog emitted for that key (a scalar, which broadcasts to every
  // variant at apply time); untouched keys keep their per-variant shape.
  const finalConfig = { ...state.raw.effective, ...overrides }
  const declared = new Set(state.bakedKeys)
  // No preset resolved, so there is no value to diff against: the file's own record is the only
  // evidence a setting was changed, and it is taken at its word.
  if (!state.baselineResolved) {
    return [...declared].filter((key) => FILAMENT_SETTING_KEYS.has(key) && !isFilamentIdentitySettingKey(key))
  }
  const keys: string[] = []
  for (const key of Object.keys(finalConfig)) {
    if (!FILAMENT_SETTING_KEYS.has(key) || isFilamentIdentitySettingKey(key)) continue
    const option = filamentSettingsCatalog.options[key]
    // BambuStudio's own modified marker is a VALUE diff against the selected preset
    // (`PresetCollection::dirty_options`); the declared record decides which of the file's values
    // survive loading, not what counts as changed. Flagging a declared key whose value equals the
    // preset is what put three un-resettable "changes" on every material of a stock project.
    if (filamentVariantValuesEqual(state.raw.baseline[key], finalConfig[key], option)) continue
    // With a record present, an UNDECLARED difference is drift BambuStudio normalizes away at load
    // — not this project's change. A key the user edited this session always counts.
    if (state.declaresOverrides
      && !declared.has(key)
      && filamentVariantValuesEqual(state.raw.effective[key], finalConfig[key], option)) continue
    keys.push(key)
  }
  return keys
}

/**
 * Request body for resolving a MACHINE (printer) profile's config for the printer-settings dialog.
 *
 * Simpler than its filament/process siblings on purpose: a machine preset is never embedded in a
 * 3MF the way a filament or process preset is, so there is no project slot to read from and no
 * baseline-vs-embedded distinction — the resolved preset IS the baseline.
 */
export const resolveMachineConfigRequestSchema = z.object({
  machineProfileId: z.string().trim().min(1),
  targetId: z.string().trim().min(1).nullable().optional()
})
export type ResolveMachineConfigRequest = z.infer<typeof resolveMachineConfigRequestSchema>

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
  /** The values in force: a project slot's embedded config, or an installed preset's own. */
  config: ProcessConfig
  /**
   * What `config` is measured against — the PRESET in use. A difference here is a change carried by
   * this project (or this editing session), which is what gets badged and coloured.
   */
  baseConfig: ProcessConfig
  /**
   * What `baseConfig` is measured against — the preset's PARENT. A difference here is an override
   * the preset itself carries, which BambuStudio deliberately does NOT call modified
   * (`Tab.cpp update_changed_ui`: differs-from-system but equals-saved renders in the default
   * colour, not the modified one). Omitted when the parent cannot be resolved, or when the preset
   * has none — then nothing is attributed to the preset and everything reads against `baseConfig`.
   */
  parentConfig?: ProcessConfig
  /**
   * The name of the preset {@link parentConfig} came from — the preset's `inherits`.
   *
   * Not a display field. A saved project must name it in `inherits_group` or BambuStudio will not
   * bind the slot to a USER preset at all; see `filament-preset-binding.ts` for the vendor rule.
   * Null for a system preset (which needs none) and absent when the parent did not resolve.
   */
  presetInherits?: string | null
  /**
   * Keys where the preset differs from {@link parentConfig} — the `different_settings_to_system`
   * entry a saved project must carry alongside {@link presetInherits}. The pair is one fact: with a
   * parent named, an UNDER-declared key is normalized back to the parent's value on open, so an
   * inaccurate list breaks binding just as an absent parent does.
   */
  presetChangedKeys?: string[]
  overriddenKeys: string[]
  /**
   * Whether the 3MF carried a changed-from-system record for this slot at all, which makes
   * `overriddenKeys` AUTHORITATIVE — including when empty. Mirrors BambuStudio, which applies the
   * file's declared list rather than diffing configs (`update_non_diff_values_to_base_config`): a
   * key that differs from the preset but is not declared is drift the vendor normalizes away, not
   * a user change. Absent/false means the writer recorded nothing and the value diff is all we
   * have — which is why this is not just `overriddenKeys.length === 0`.
   */
  declaresOverrides?: boolean
  /**
   * Whether {@link baseConfig} is a REAL preset resolved for this slot, rather than a copy of
   * `config` standing in because the named preset is not installed here.
   *
   * The distinction cannot be recovered from the payload — a project that changed nothing and a
   * project whose preset went missing both send `baseConfig` deep-equal to `config` — and
   * conflating them is what put three un-resettable "changes" on every material of a stock project.
   * When true, a value diff is meaningful and is the modified marker (BambuStudio's
   * `dirty_options`). When false there is nothing to diff against, so {@link overriddenKeys} is the
   * only evidence of a change and is taken at its word. Absent means true, so a producer that
   * always resolves needs no change.
   */
  baselineResolved?: boolean
}
