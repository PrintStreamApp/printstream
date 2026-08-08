/**
 * Extracts a 3MF project's embedded PROCESS and per-FILAMENT config from its flattened
 * `Metadata/project_settings.config` (a fully-merged JSON record). Pure — a parsed record in, a
 * structured result out — so both surfaces run it: the API's workspace resolve routes
 * (`resolveProjectProcessConfig` / `resolveProjectFilamentConfig`) read the file server-side, and the
 * public 3MF editor runs it over the archive it unzipped in the browser (no server copy exists there).
 *
 * A project config is ALREADY fully merged, so unlike an installed preset it needs no slicer
 * round-trip. We keep only keys the relevant catalog knows about, and surface the preset name
 * (`print_settings_id` / `filament_settings_id[slot]`) and the keys Bambu marks changed-from-system
 * (`different_settings_to_system`) so the editor can show the baked overrides as modified/resettable
 * and resolve the baseline. Filament settings are per-slot parallel arrays, so the filament extractor
 * takes a 1-based slot index and reads that column.
 */
import { processSettingsCatalog, type ProcessConfig } from './process-settings.js'
import { filamentSettingsCatalog } from './filament-settings.js'
import { filamentKeyWidth, filamentVariantsPerSlot } from './variant-options.js'

export interface ProjectProcessConfig {
  /** Effective, already-merged process config embedded in the 3MF (catalog keys only). */
  config: ProcessConfig
  /** The project's process preset name (`print_settings_id`), used to resolve the baseline. */
  presetName: string | null
  /** Process keys the 3MF records as changed from system (`different_settings_to_system[0]`). */
  overriddenKeys: string[]
  /**
   * Whether the file CARRIES a changed-from-system record for this slot at all — which makes
   * {@link overriddenKeys} authoritative, including when it is empty ("nothing was changed").
   *
   * Distinct from `overriddenKeys.length === 0`, and the distinction is the whole point: a 3MF
   * written before that record was maintained declares nothing, and its real overrides would be
   * indistinguishable from drift. Absent means "unknown, fall back to comparing values".
   */
  declaresOverrides: boolean
}

/**
 * Parses the process slot (index 0) of Bambu's `different_settings_to_system` — a `;`-separated list
 * of keys changed from the system preset — keeping only keys known to the process catalog.
 */
/**
 * Whether `different_settings_to_system` carries an entry for the PROCESS slot. An entry of `""`
 * is a positive declaration ("nothing changed") and returns true; a missing key or a non-string
 * entry returns false, meaning the writer recorded nothing and callers must not trust silence.
 */
export function declaresProcessOverrides(value: unknown): boolean {
  return typeof (Array.isArray(value) ? value[0] : value) === 'string'
}

export function extractProcessOverriddenKeys(value: unknown): string[] {
  const first = Array.isArray(value) ? value[0] : value
  if (typeof first !== 'string') return []
  return first
    .split(';')
    .map((key) => key.trim())
    .filter((key) => key.length > 0 && processSettingsCatalog.options[key] !== undefined)
}

/**
 * Extract `{config, presetName, overriddenKeys}` from a parsed `project_settings.config` object.
 * Returns null when the input is not a JSON object (a malformed/missing entry), which callers treat
 * as "not resolvable".
 */
export function extractProjectProcessConfig(projectSettings: unknown): ProjectProcessConfig | null {
  if (!projectSettings || typeof projectSettings !== 'object' || Array.isArray(projectSettings)) return null
  const record = projectSettings as Record<string, unknown>
  const config: ProcessConfig = {}
  for (const key of Object.keys(processSettingsCatalog.options)) {
    const value = record[key]
    if (typeof value === 'string') {
      config[key] = value
    } else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      config[key] = value as string[]
    }
  }
  return {
    config,
    presetName: typeof record.print_settings_id === 'string' && record.print_settings_id.trim() ? record.print_settings_id.trim() : null,
    overriddenKeys: extractProcessOverriddenKeys(record.different_settings_to_system),
    declaresOverrides: declaresProcessOverrides(record.different_settings_to_system)
  }
}

export interface ProjectFilamentConfig {
  /** The one filament slot's effective, already-merged config (filament catalog keys only). */
  config: ProcessConfig
  /** That slot's parent preset name (`filament_settings_id[slot]`), used to resolve the baseline. */
  presetName: string | null
  /** Filament keys the 3MF records as changed from system for this slot. */
  overriddenKeys: string[]
  /** See {@link ProjectProcessConfig.declaresOverrides} — same contract, per filament slot. */
  declaresOverrides: boolean
}

/**
 * Parses one FILAMENT slot of Bambu's `different_settings_to_system`. Layout (PresetBundle.cpp):
 * `[0]` = process, `[1..n]` = filament slot 1..n, `[n+1]` = machine; each entry is a `;`-separated
 * key list. So slot `projectFilamentId` (1-based) sits at array index `projectFilamentId`. Kept to
 * the filament catalog. The changed-keys FALLBACK when the named parent preset is not installed.
 */
/** Per-slot counterpart of {@link declaresProcessOverrides}. */
export function declaresFilamentOverrides(value: unknown, projectFilamentId: number): boolean {
  return Array.isArray(value) && typeof value[projectFilamentId] === 'string'
}

export function extractFilamentOverriddenKeys(value: unknown, projectFilamentId: number): string[] {
  const entry = Array.isArray(value) ? value[projectFilamentId] : undefined
  if (typeof entry !== 'string') return []
  return entry
    .split(';')
    .map((key) => key.trim())
    .filter((key) => key.length > 0 && filamentSettingsCatalog.options[key] !== undefined)
}

/**
 * Extract a project-embedded FILAMENT's `{config, presetName, overriddenKeys}` from a parsed
 * `project_settings.config`, at the given 1-based filament slot. BambuStudio stores each per-filament
 * setting as a parallel array keyed by 0-based slot, so the slot's value is `array[projectFilamentId
 * - 1]`; a bare scalar (rare) applies to all slots. VARIANT EXPANSION (BambuStudio 2.x): on machines
 * with extruder variants the numeric settings are `filaments x variants` long — slot i owns the
 * V-wide block at i*V (V read from `filament_extruder_variant` over the identity-array filament
 * count). Such a slot's value is kept as that VECTOR, matching the per-variant shape an installed
 * preset resolves to on the same machine, so downstream scalarize/shape handling treats both sides
 * alike. Returns null on a malformed record or a slot < 1. Pure counterpart of the API's
 * `resolveProjectFilamentConfig` (which reads the file, then calls this).
 */
export function extractProjectFilamentConfig(projectSettings: unknown, projectFilamentId: number): ProjectFilamentConfig | null {
  if (!projectSettings || typeof projectSettings !== 'object' || Array.isArray(projectSettings)) return null
  if (!Number.isInteger(projectFilamentId) || projectFilamentId < 1) return null
  const record = projectSettings as Record<string, unknown>
  const slot = projectFilamentId - 1
  // Filament count from the IDENTITY arrays only — the numeric arrays can be variant-expanded, and
  // on already-diseased files (a pre-variant-aware save) even stale-length; identity is what the
  // save path rewrites authoritatively.
  const filamentCount = Math.max(
    Array.isArray(record.filament_settings_id) ? record.filament_settings_id.length : 0,
    Array.isArray(record.filament_colour) ? record.filament_colour.length : 0,
    Array.isArray(record.filament_type) ? record.filament_type.length : 0
  )
  // A slot the project does not have carries no project config — say so rather than reading past the
  // end. The variant branch below slices, and an out-of-range slice is `[]` whose `.every()` is
  // vacuously true, so every variant-expanded key was written as an empty array and then read as a
  // change against the preset (a 4th material on a 3-filament project reported 39 of them).
  if (filamentCount > 0 && slot >= filamentCount) return null
  // Variants the project declares; which KEYS are stored that wide is BambuStudio's per-option rule,
  // applied below. Reading a per-slot key as if it were variant-blocked returns another slot's value.
  const variantCount = filamentVariantsPerSlot(record, filamentCount)
  const config: ProcessConfig = {}
  for (const key of Object.keys(filamentSettingsCatalog.options)) {
    const value = record[key]
    if (Array.isArray(value)) {
      const width = filamentKeyWidth(key, variantCount)
      if (width > 1 && value.length === filamentCount * width) {
        const block = value.slice(slot * width, (slot + 1) * width)
        // `[].every()` is vacuously true — an empty block means the array is shorter than the slot
        // claims, which is absence, not an empty value.
        if (block.length > 0 && block.every((entry): entry is string => typeof entry === 'string')) config[key] = block
        continue
      }
      const entry = value[slot]
      if (typeof entry === 'string') config[key] = entry
    } else if (typeof value === 'string') {
      config[key] = value
    }
  }
  const settingsIds = record.filament_settings_id
  const presetName = Array.isArray(settingsIds) && typeof settingsIds[slot] === 'string' && (settingsIds[slot] as string).trim()
    ? (settingsIds[slot] as string).trim()
    : null
  return {
    config,
    presetName,
    overriddenKeys: extractFilamentOverriddenKeys(record.different_settings_to_system, projectFilamentId),
    declaresOverrides: declaresFilamentOverrides(record.different_settings_to_system, projectFilamentId)
  }
}
