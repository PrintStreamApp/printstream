/**
 * Extracts a 3MF project's embedded PROCESS and per-FILAMENT config from its flattened
 * `Metadata/project_settings.config` (a fully-merged JSON record). Pure, a parsed record in, a
 * structured result out, so both surfaces run it: the API's workspace resolve routes
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
   * Whether the file CARRIES a changed-from-system record for this slot at all, which makes
   * {@link overriddenKeys} authoritative, including when it is empty ("nothing was changed").
   *
   * Distinct from `overriddenKeys.length === 0`, and the distinction is the whole point: a 3MF
   * written before that record was maintained declares nothing, and its real overrides would be
   * indistinguishable from drift. Absent means "unknown, fall back to comparing values".
   */
  declaresOverrides: boolean
}

/**
 * Parses the process slot (index 0) of Bambu's `different_settings_to_system`, a `;`-separated list
 * of keys changed from the system preset, keeping only keys known to the process catalog.
 */
/**
 * Whether `different_settings_to_system` carries an entry for the PROCESS slot. An entry of `""`
 * is a positive declaration ("nothing changed") and returns true; a missing key or a non-string
 * entry returns false, meaning the writer recorded nothing and callers must not trust silence.
 */
export function declaresProcessOverrides(value: unknown): boolean {
  return typeof (Array.isArray(value) ? value[0] : value) === 'string'
}

/**
 * The arrays a project's filament count is read from: its IDENTITY arrays only. The numeric arrays
 * can be variant-expanded and, on an already-diseased file, stale-length.
 */
const FILAMENT_IDENTITY_ARRAYS = ['filament_settings_id', 'filament_colour', 'filament_type'] as const

/**
 * The slot count a project's filament arrays agree on, or 0 when it declares none.
 *
 * One definition, because five hand-rolled copies had already started to diverge (one read
 * `filament_settings_id` alone, another `filament_colour` alone).
 *
 * This is the count for VALUE arrays (variant blocks, per-slot physics), where the widest identity
 * array is the honest answer. It is NOT the count that indexes the parallel preset records: use
 * {@link machinePresetSlotIndexFor}, which counts what the engine counts.
 */
export function filamentSlotCount(record: Record<string, unknown>): number {
  return Math.max(0, ...FILAMENT_IDENTITY_ARRAYS.map((key) => (Array.isArray(record[key]) ? (record[key] as unknown[]).length : 0)))
}

/**
 * Where the MACHINE entry sits in this record's parallel preset arrays, or null when that cannot be
 * known. The one answer every reader and writer of those arrays must use.
 *
 * Counts `filament_colour` and nothing else, because that is what the engine counts:
 *
 *   // BBS: use filament_colour insteadof filament_settings_id, filament_settings_id sometimes is
 *   // not generated
 *   size_t num_filaments = filament_colour_option ? filament_colour_option->size() : 0;
 *   ...
 *   std::string printer_different_settings = different_values[num_filaments + 1];
 *                                             -- PresetBundle.cpp:3750-3751, 3885
 *
 * Taking the MAX across the identity arrays instead looks equivalent and is not. BambuStudio's own
 * comment says `filament_settings_id` "sometimes is not generated", so the arrays genuinely
 * disagree in the wild, and on such a file the max lands to the RIGHT of where the engine reads --
 * writing an override where nothing will ever look for it. That is the same vanished-on-reopen
 * failure this record exists to prevent, moved rather than fixed.
 *
 * Null means "cannot be located", which is NOT zero filaments. A record with no `filament_colour`
 * at all (a partial config, a fragment, a foreign file) states no count, and treating that as zero
 * files machine keys into filament slot 1's record -- which is what `rebindProjectFilamentPhysics`
 * reads to decide which of that slot's values survive a machine switch. A caller handed null must
 * do nothing rather than guess.
 */
export function machinePresetSlotIndexFor(record: Record<string, unknown>): number | null {
  const colours = record.filament_colour
  if (!Array.isArray(colours)) return null
  return machinePresetSlotIndex(colours.length)
}

/**
 * Where each preset kind sits in the two PARALLEL PRESET RECORDS, `different_settings_to_system`
 * and its twin `inherits_group`: `[process, ...one per filament, machine]`.
 *
 * The machine index is `filamentCount + 1`, taken from the FILAMENT COUNT and never from the
 * record's own length. That is what BambuStudio does, and the distinction is not academic: it
 * resizes both arrays to `filament_count + 2` INDEPENDENTLY of each other and then reads the
 * printer slot at `filament_count + 1` (`BambuStudio.cpp:3200-3215`,
 * `PresetBundle.cpp:1383,3885`). Deriving it from `inherits_group.length - 1` instead put machine
 * keys into a FILAMENT slot on any project whose two arrays disagree -- which the Repair stage
 * routinely produces, since it fixes `inherits_group` and deliberately leaves this record alone.
 *
 * Both arrays get the same rule from this one function because they went wrong the same way twice,
 * independently: the changed-from-system record lost a user's machine override, and
 * `clearInheritsGroupSlot` blanked a FILAMENT slot's parent (telling the CLI that filament IS a
 * system preset) while leaving the stale machine parent it meant to clear.
 */
export function machinePresetSlotIndex(filamentCount: number): number {
  return filamentCount + 1
}

/**
 * Read one slot's changed-from-system keys, filtered to a catalog. Slot-agnostic so the process,
 * filament and machine readers cannot drift apart on separator or trimming.
 */
export function extractChangedFromSystemKeys(
  value: unknown,
  slotIndex: number,
  isKnownKey: (key: string) => boolean
): string[] {
  // A bare string applies to the process slot, which is how some files spell a single-slot record.
  const entry = Array.isArray(value) ? value[slotIndex] : (slotIndex === 0 ? value : undefined)
  if (typeof entry !== 'string') return []
  return splitChangedFromSystemEntry(entry).filter(isKnownKey)
}

/**
 * Split one slot's entry into keys, tolerating BOTH separators.
 *
 * `;` is what BambuStudio writes and what we write back, but `,` appears in the wild and the reader
 * this replaced accepted it deliberately. Tolerance matters more now than it did then: the writer
 * REPLACES a slot with the keys it read, so an entry this fails to parse is not merely invisible in
 * the UI, it is erased from the file by the next save.
 */
function splitChangedFromSystemEntry(entry: string): string[] {
  return entry
    .split(/[;,]/)
    .map((key) => key.trim())
    .filter((key) => key.length > 0)
}

/**
 * Set one slot's changed-from-system keys, returning the whole record. PADS to `filamentCount + 2`
 * and NEVER truncates: shortening it destroys the other slots' records, and a filament slot's
 * record is what `rebindProjectFilamentPhysics` uses to decide which of its values are the user's
 * and must survive a machine switch.
 *
 * The keys REPLACE that slot rather than merging into it, because every caller passes the complete
 * set for its domain. Merging cannot express a removal, which is why an override the user reset
 * stayed recorded and came back on the next open.
 */
export function withChangedFromSystemSlot(
  value: unknown,
  slotIndex: number,
  keys: readonly string[],
  filamentCount: number
): string[] {
  return withParallelPresetSlot(value, slotIndex, [...new Set(keys)].join(';'), filamentCount)
}

/**
 * Set one slot of a parallel preset record to a literal entry, padding to `filamentCount + 2` and
 * never truncating. {@link withChangedFromSystemSlot} is the `;`-joined key-list form of this;
 * `inherits_group` holds a single parent NAME per slot, so it writes the entry directly.
 */
export function withParallelPresetSlot(
  value: unknown,
  slotIndex: number,
  entry: string,
  filamentCount: number
): string[] {
  const existing = Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item : '')) : []
  const record = existing.slice()
  while (record.length < Math.max(filamentCount + 2, slotIndex + 1)) record.push('')
  record[slotIndex] = entry
  return record
}

/**
 * Rebuild a parallel preset record for a NEW filament count, keeping the process entry and carrying
 * the machine entry across to its new index. `sourceSlotFor(i)` names the 0-based OLD filament slot
 * new slot `i` inherits from, or null to blank it.
 *
 * The one operation the single-slot setters cannot express, and the reason both remaining
 * hand-rolled writers existed. Its whole job is the two entries at the ENDS: a resize moves the
 * machine slot, so reading it from the source's own `length - 1` is only right while the source is
 * correctly sized -- and a mis-sized record is precisely the input this has to survive. Reads at
 * `oldFilamentCount + 1` instead, and answers `''` when the source is too short to hold it, which
 * is the honest value (the CLI reads an empty entry as "this preset IS a system preset").
 *
 * Returns null when there is nothing to rebuild, so a caller leaves an absent record absent rather
 * than inventing one.
 */
export function resizeParallelPresetRecord(
  value: unknown,
  options: { oldFilamentCount: number; newFilamentCount: number; sourceSlotFor: (newSlot: number) => number | null }
): string[] | null {
  if (!Array.isArray(value)) return null
  const previous = value.map((entry) => (typeof entry === 'string' ? entry : ''))
  const machineEntry = previous[machinePresetSlotIndex(options.oldFilamentCount)] ?? ''
  return [
    previous[0] ?? '',
    ...Array.from({ length: options.newFilamentCount }, (_unused, index) => {
      const source = options.sourceSlotFor(index)
      return source == null ? '' : previous[source + 1] ?? ''
    }),
    machineEntry
  ]
}

export function extractProcessOverriddenKeys(value: unknown): string[] {
  return extractChangedFromSystemKeys(value, 0, (key) => processSettingsCatalog.options[key] !== undefined)
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
  /** See {@link ProjectProcessConfig.declaresOverrides}: same contract, per filament slot. */
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
  // Slot 0 is the process slot, so a filament read never accepts the bare-string form.
  if (!Array.isArray(value)) return []
  return extractChangedFromSystemKeys(value, projectFilamentId, (key) => filamentSettingsCatalog.options[key] !== undefined)
}

/**
 * Extract a project-embedded FILAMENT's `{config, presetName, overriddenKeys}` from a parsed
 * `project_settings.config`, at the given 1-based filament slot. BambuStudio stores each per-filament
 * setting as a parallel array keyed by 0-based slot, so the slot's value is `array[projectFilamentId
 * - 1]`; a bare scalar (rare) applies to all slots. VARIANT EXPANSION (BambuStudio 2.x): on machines
 * with extruder variants the numeric settings are `filaments x variants` long: slot i owns the
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
  // Filament count from the IDENTITY arrays only: the numeric arrays can be variant-expanded, and
  // on already-diseased files (a pre-variant-aware save) even stale-length; identity is what the
  // save path rewrites authoritatively.
  const filamentCount = filamentSlotCount(record)
  // A slot the project does not have carries no project config: say so rather than reading past the
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
        // `[].every()` is vacuously true, an empty block means the array is shorter than the slot
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
