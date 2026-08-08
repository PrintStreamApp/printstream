/**
 * Retargeting a 3MF project's `project_settings.config` to a different Bambu machine —
 * the "change the project's printer" operation, done by rewriting settings rather than
 * re-slicing. Pure functions (no I/O), shared by three callers: the API (the workspace editor's
 * save-as-a-different-printer flow), the browser (the public editor's save, which never uploads
 * the file), and the slicer (the estimate-mode cross-model switch's topology repair).
 *
 * {@link applyMachineRetargetToProjectSettings} is the whole operation in one call and is what the
 * two editor hosts share; the individual steps stay exported for the slicer's narrower repair.
 *
 * Update resilience: {@link retargetProjectSettingsToMachine} overwrites **every** key the
 * resolved machine profile defines (minus profile metadata), so when BambuStudio adds new
 * machine fields in a version bump they are carried over automatically — there is no
 * per-field allow-list to maintain here. The only BambuStudio-coupled logic is the
 * dependent-map derivation below (`repairEstimateModeProjectSettings`), which reconstructs
 * the runtime maps that depend on BOTH the machine topology and the project's filaments
 * (`filament_nozzle_map`, extruder variants, …). See docs/project-printer-retarget.md.
 */
import { processSettingsCatalog } from './process-settings.js'
import { PRINTER_PRESET_OPTIONS, PRINT_PRESET_OPTIONS } from './generated/preset-options.generated.js'
import { repairFlushVolumesMatrix } from './flush-volumes-matrix.js'
import { buildFilamentVariantRows } from './filament-variant-index.js'
import { rebindProjectFilamentPhysics, type FilamentSlotRebind } from './filament-rebind.js'
import { machineSettingsCatalog } from './machine-settings.js'
import { isPrintVariantOption } from './variant-options.js'

export type ProfileRecord = Record<string, unknown>

/** Profile-level metadata keys that are NOT slice settings and must not leak into project_settings. */
const NON_SETTING_PROFILE_KEYS = new Set([
  'name',
  'type',
  'from',
  'inherits',
  'include',
  'instantiation',
  'setting_id',
  'version',
  'is_custom_defined',
  'filament_id',
  // Profile compatibility *declarations* (which printers/prints a preset is for) — not settings.
  'compatible_printers',
  'compatible_printers_condition',
  'compatible_prints',
  'compatible_prints_condition'
])

const PROFILE_COPY_KEYS = [
  'change_filament_gcode',
  'default_nozzle_volume_type',
  'extruder_colour',
  'extruder_max_nozzle_count',
  'extruder_offset',
  'extruder_printable_height',
  'extruder_type',
  'extruder_variant_list',
  'machine_end_gcode',
  'machine_load_filament_time',
  'machine_start_gcode',
  'machine_unload_filament_time',
  'physical_extruder_map'
] as const

/**
 * Machine-conditional keys: dropped when the target machine's profile does not declare them, so a
 * retarget cannot leave a previous machine's capability flag behind.
 */
const PROFILE_DELETE_IF_MISSING_KEYS = [
  'enable_filament_dynamic_map',
  'filament_map_2'
] as const

/**
 * Per-FILAMENT keys the same rule used to drop wholesale, which is too blunt for them.
 *
 * `filament_extruder_compatibility` is in BambuStudio's own `s_Preset_filament_options`, has a
 * PrintConfig default, and BambuStudio writes it for every project (`["0","0","0"]`) whatever the
 * machine preset mentions — so its presence is not the machine's to decide, and deleting it left the
 * filament block one key short of the preset. BambuStudio reads that absence as a deviation and
 * mints a `(<project>.3mf)` copy rather than binding the user's preset.
 *
 * What the deletion was really protecting against is a value whose SHAPE no longer fits: an
 * estimate-mode export carries `['0']` for a project that now has two filaments, and no index
 * mapping can read that. So drop it only when it is mis-shaped, and keep a well-formed one.
 */
const PROFILE_RESHAPE_IF_MISSING_KEYS = ['filament_extruder_compatibility'] as const

const NOZZLE_VOLUME_TYPE_INDEX: Record<string, string> = {
  standard: '0',
  'high flow': '1',
  'tpu high flow': '2'
}

/**
 * Retargets `projectSettings` to `machineProfile` (a fully-resolved machine preset, with its
 * `inherits`/`include` chain already merged). Overwrites every machine-owned key, sets the
 * printer identity, then re-derives the topology-dependent runtime maps. The project's layout
 * (`model_settings.config`/build items) and filament selection are untouched.
 */
export function retargetProjectSettingsToMachine(
  projectSettings: ProfileRecord,
  machineProfile: ProfileRecord,
  target: { printerSettingsId: string; printerModel: string }
): ProfileRecord {
  const next: ProfileRecord = { ...projectSettings }
  for (const [key, value] of Object.entries(machineProfile)) {
    if (NON_SETTING_PROFILE_KEYS.has(key)) continue
    // Only what BambuStudio itself considers part of a printer preset. A resolved profile also
    // carries LEGACY keys the vendor has since renamed or dropped (`extruder_clearance_radius` ->
    // `extruder_clearance_max_radius`, `z_lift_type`, `extruder_height_gap`,
    // `deretract_speed_extruder_change`), and copying them wholesale wrote four keys into every
    // retargeted project that neither the source file nor a BambuStudio save contains — one of them
    // a per-extruder array at the WRONG length (5 entries on a 2-extruder machine), which is the
    // shape that segfaults BambuStudio mid-slice when it indexes by extruder.
    if (!PRINTER_PRESET_OPTIONS.has(key)) continue
    next[key] = normalizeProfileValueForProject(key, cloneValue(value), projectSettings[key])
  }
  next.printer_settings_id = target.printerSettingsId
  next.printer_model = target.printerModel
  // Re-declare the project's printer-compatibility for the target. The source printer's
  // declarations (e.g. an A1 mini project's `print_compatible_printers: ["… @BBL A1M …"]`)
  // are NOT machine-profile settings, so the overwrite above leaves them untouched — and they
  // then surface as stale compatibility chips (an A1/A1 mini chip on an H2D project). BambuStudio
  // writes the target machine here, so we match it: set `print_compatible_printers` and, when the
  // project carries one, `compatible_printers` to the target machine preset.
  next.print_compatible_printers = [target.printerSettingsId]
  if (next.compatible_printers !== undefined) next.compatible_printers = [target.printerSettingsId]
  // The CLI resolves the project's SYSTEM printer from inherits_group's LAST slot, not from
  // printer_settings_id. A project saved with an inherited/custom machine preset keeps its old
  // parent there (e.g. "Bambu Lab P1P 0.4 nozzle"), and CLIs from 2.7.1 on validate every loaded
  // filament preset against that name — a stale slot fails the slice with "filament preset ... is
  // not compatible with printer <old machine>". Blank it so the rewritten printer_settings_id is
  // the system identity.
  clearInheritsGroupSlot(next, 'machine')
  // `flush_volumes_matrix` is a PROJECT key, not a machine-profile one, so the overwrite above
  // leaves it at the SOURCE machine's extruder count while `nozzle_diameter` above just changed
  // that count. Retargeting a single-nozzle project onto a dual-nozzle printer therefore left one
  // block where two are required, and BambuStudio read the missing block out of bounds and
  // segfaulted mid-slice (see flush-volumes-matrix.ts). Re-derive it for the new topology.
  const filamentCount = Array.isArray(next.filament_colour) ? next.filament_colour.length : 0
  const extruderCount = Array.isArray(next.nozzle_diameter) ? Math.max(next.nozzle_diameter.length, 1) : 1
  const repairedMatrix = repairFlushVolumesMatrix(
    Array.isArray(next.flush_volumes_matrix) ? next.flush_volumes_matrix : null,
    filamentCount,
    extruderCount
  )
  if (repairedMatrix) next.flush_volumes_matrix = repairedMatrix
  return repairEstimateModeProjectSettings(next, machineProfile)
}

/**
 * Blanks one slot of Bambu's `different-settings` inheritance record:
 * `inherits_group[0]` names the process preset's parent and the LAST entry the machine
 * preset's parent (the filament slots sit in between). An empty slot means "this preset
 * IS a system preset", making the CLI derive the system identity from the corresponding
 * `*_settings_id` the retarget just wrote.
 */
function clearInheritsGroupSlot(record: ProfileRecord, slot: 'process' | 'machine'): void {
  if (!Array.isArray(record.inherits_group) || record.inherits_group.length === 0) return
  const inheritsGroup = [...record.inherits_group as string[]]
  inheritsGroup[slot === 'process' ? 0 : inheritsGroup.length - 1] = ''
  record.inherits_group = inheritsGroup
}

/**
 * Brings a project's **process** (print/quality) settings over to the target printer's process
 * preset — the companion to {@link retargetProjectSettingsToMachine}. Overwrites every process-owned
 * key from the resolved process profile, sets `print_settings_id`, then applies the user's per-slice
 * overrides on top. Process keys are disjoint from machine keys, so this composes after the machine
 * retarget without clobbering it. The project's filament selection and layout are untouched.
 */
export function applyProcessProfileToProjectSettings(
  projectSettings: ProfileRecord,
  processProfile: ProfileRecord,
  overrides: Record<string, string | string[]> = {}
): ProfileRecord {
  const next: ProfileRecord = { ...projectSettings }
  for (const [key, value] of Object.entries(processProfile)) {
    if (NON_SETTING_PROFILE_KEYS.has(key)) continue
    // Same allow-list rule as the machine retarget, for the same reason.
    if (!PRINT_PRESET_OPTIONS.has(key)) continue
    next[key] = cloneValue(value)
  }
  const name = typeof processProfile.name === 'string' ? processProfile.name.trim() : ''
  if (name) {
    next.print_settings_id = name
    // Same staleness as the machine slot: slot 0 names the process preset's inherited
    // parent, which would otherwise override the rewritten print_settings_id during the
    // CLI's compatibility checks.
    clearInheritsGroupSlot(next, 'process')
  }
  for (const [key, value] of Object.entries(overrides)) {
    next[key] = cloneValue(value)
  }
  return next
}

/**
 * Everything a machine retarget needs, already RESOLVED. Assembling this is where the two editor
 * hosts differ — the api resolves through the slicer plus the workspace's preset files, the browser
 * through `/api/public/slicing/resolve-*` — and applying it is where they must not.
 */
export interface MachineRetargetPlan {
  /** Fully-resolved machine preset for the TARGET printer. */
  machineConfig: ProfileRecord
  /** Machine preset name, persisted as `printer_settings_id`. */
  printerSettingsId: string
  printerModel: string
  /**
   * Fully-resolved process preset for the target, when one could be resolved. Absent/null leaves
   * the project's embedded process alone — deliberate: an unresolvable process (e.g. a project
   * preset, which has no separate file) must not block the machine retarget, which is what makes
   * the project openable on the new printer at all.
   */
  processConfig?: ProfileRecord | null
  /** The session's process overrides, applied on top of `processConfig`. */
  processSettingOverrides?: Record<string, string | string[]>
  /**
   * Per-slot filament rebinds, index-aligned with the project's filament list. Absent/null keeps
   * every slot's current values — the rebind is an improvement pass, never a requirement.
   */
  filamentRebinds?: FilamentSlotRebind[] | null
}

/**
 * Apply a resolved {@link MachineRetargetPlan} to a project's parsed `project_settings.config`.
 *
 * The one definition of what "save this project for a different printer" DOES, shared so the two
 * hosts cannot drift: the api runs it over the 3MF it just baked, the browser over the 3MF it just
 * baked in the tab. Order matters and is fixed here — machine first (it re-derives the topology
 * maps every later step indexes by), then the process preset (process keys are disjoint from
 * machine keys, so it composes without clobbering), then the filament rebind (which reads the
 * retargeted variant layout).
 */
/**
 * A machine PRESET and a PROJECT spell the same value differently, so a wholesale copy has to
 * translate rather than transcribe.
 *
 * Two differences, both seen on a real H2D save:
 *  - a POINT is `"0.3x0.5"` in the preset and `"0.3,0.5"` in the project (`best_object_pos`)
 *  - a SCALAR option can arrive from the preset as a one-element vector, where the project stores it
 *    bare (`enable_long_retraction_when_cut`: `["2"]` vs `"2"` — `coInt` in BambuStudio, and absent
 *    from our machine catalogue because it is `comDevelop`, so the project's own shape is the only
 *    guide we have)
 *
 * Copying either verbatim leaves the project holding a value BambuStudio did not write. Both were
 * measured against BambuStudio's own file, which is the authority here.
 */
function normalizeProfileValueForProject(
  key: string,
  value: ProfileRecord[string],
  existing: ProfileRecord[string] | undefined
): ProfileRecord[string] {
  // A point the preset spells with `x`. Only ever applied to catalogue-known point options, so a
  // string that merely contains an `x` (a gcode snippet, a name) is never touched.
  if (machineSettingsCatalog.options[key]?.type === 'point' && typeof value === 'string' && value.includes('x')) {
    return value.replace(/x/g, ',')
  }
  // The preset wrapped a scalar the project keeps bare. Narrow on purpose: only a ONE-element array,
  // and only where the project already holds a plain string, so a machine that genuinely gains
  // extruders still widens the key.
  if (Array.isArray(value) && value.length === 1 && typeof existing === 'string') {
    return value[0] as ProfileRecord[string]
  }
  return value
}

export function applyMachineRetargetToProjectSettings(
  projectSettings: ProfileRecord,
  plan: MachineRetargetPlan
): ProfileRecord {
  let next = retargetProjectSettingsToMachine(projectSettings, plan.machineConfig, {
    printerSettingsId: plan.printerSettingsId,
    printerModel: plan.printerModel
  })
  if (plan.processConfig) {
    next = applyProcessProfileToProjectSettings(next, plan.processConfig, plan.processSettingOverrides ?? {})
  }
  if (plan.filamentRebinds && plan.filamentRebinds.length > 0) {
    next = rebindProjectFilamentPhysics(next, plan.filamentRebinds)
  }
  return next
}

/**
 * Drops the stale `printer_model_id` metadata from a retargeted project's `slice_info.config`.
 *
 * That entry describes the project's last slice on the SOURCE printer, so its `printer_model_id`
 * (e.g. `N1` -> A1) otherwise lingers as a wrong compatibility chip on the retargeted project.
 * BambuStudio's saved-but-not-sliced projects carry no `printer_model_id` either, so removing it
 * matches BS and the project reads as "needs a fresh slice for the new printer". A no-op when the
 * entry has none.
 */
export function stripSliceInfoPrinterModelId(sliceInfoXml: string): string {
  return sliceInfoXml.replace(/[ \t]*<metadata\s+key="printer_model_id"\s+value="[^"]*"\s*\/>\s*\r?\n?/g, '')
}

/** Bambu models whose machine block must carry the dual-nozzle (two-extruder) topology. */
export const H2_DUAL_NOZZLE_MODEL_KEYS: ReadonlySet<string> = new Set(['H2D', 'H2DPRO', 'H2C'])

/**
 * Whether a project's embedded settings carry the H2-family dual-nozzle machine shape the
 * BambuStudio CLI needs (its extruder-variant resolution crashes without it). Consumed by the
 * slicer's machine-switch guard (heal-or-reject before slicing) and the API's save-side heal —
 * one definition so the two ends never disagree on what "intact" means.
 */
export function hasDualNozzleMachineShape(projectSettings: ProfileRecord): boolean {
  return stringArray(projectSettings.physical_extruder_map).length >= 2
    && stringArray(projectSettings.extruder_nozzle_stats).length >= 2
    && stringArray(projectSettings.extruder_max_nozzle_count).length >= 2
    && stringArray(projectSettings.default_nozzle_volume_type).length >= 2
}

export function mergeInheritedMachineProfile(profileName: string, profileRecords: ReadonlyMap<string, ProfileRecord>): ProfileRecord {
  const profile = profileRecords.get(profileName)
  if (!profile) {
    throw new Error(`Missing machine profile ${profileName}`)
  }

  const inherits = typeof profile.inherits === 'string' && profile.inherits.trim().length > 0
    ? profile.inherits.trim()
    : null

  const merged = inherits
    ? {
      ...mergeInheritedMachineProfile(inherits, profileRecords),
      ...profile
    }
    : { ...profile }

  for (const includeName of stringArray(profile.include)) {
    const includeProfile = mergeInheritedMachineProfile(includeName, profileRecords)
    mergeMissingProfileFields(merged, includeProfile)
  }

  return merged
}

export function repairEstimateModeProjectSettings(settings: ProfileRecord, machineProfile: ProfileRecord): ProfileRecord {
  const next: ProfileRecord = { ...settings }

  for (const key of PROFILE_COPY_KEYS) {
    const value = cloneValue(machineProfile[key])
    if (value !== undefined) next[key] = value
  }

  const volumeTypes = stringArray(next.default_nozzle_volume_type)
  const maxNozzleCounts = stringArray(next.extruder_max_nozzle_count)
  const physicalExtruderMap = stringArray(next.physical_extruder_map)
  const derivedPrinterVariants = buildPrinterExtruderVariants(stringArray(next.extruder_variant_list))
  const printerExtruderVariants = derivedPrinterVariants.length > 0
    ? derivedPrinterVariants
    : stringArray(next.printer_extruder_variant)

  if (derivedPrinterVariants.length > 0) {
    next.printer_extruder_variant = derivedPrinterVariants
    next.printer_extruder_id = buildPrinterExtruderIds(stringArray(next.extruder_variant_list))
  }

  retargetProcessExtruderVariants(next, printerExtruderVariants, stringArray(next.printer_extruder_id))

  if (printerExtruderVariants.length > 0) {
    // Built TOGETHER: BambuStudio rejects the whole project ("Invalid configuration file") unless
    // `filament_self_index` has exactly one entry per `filament_extruder_variant` row. Producing
    // them from separate passes is what let them drift — see `buildFilamentVariantLayout`.
    const layout = buildFilamentVariantRows(printerExtruderVariants, stringArray(next.filament_type))
    next.filament_extruder_variant = layout.variants
    next.filament_self_index = layout.selfIndex
  }

  // `filament_nozzle_map` is indexed by FILAMENT (one entry per project filament, valued with the
  // runtime nozzle id), NOT by extruder — assigning `physical_extruder_map` (one entry per extruder)
  // produced a map of the wrong LENGTH whenever the project's filament count differed from the new
  // machine's extruder count. BambuStudio then reads a filament's extruder past the end of that
  // vector, which is the documented "can not be printed on extruder <garbage>" abort / mid-slice
  // SIGSEGV. Rebuild it per filament: keep a slot's existing nozzle when the NEW machine still has
  // it, else fall back to the machine's primary — so a dual -> single-nozzle switch collapses every
  // slot onto the one extruder instead of leaving a dangling left-nozzle reference.
  const filamentCount = Math.max(
    stringArray(next.filament_type).length,
    stringArray(next.filament_settings_id).length,
    stringArray(next.filament_colour).length
  )
  if (filamentCount > 0) {
    const previousNozzleMap = stringArray(next.filament_nozzle_map)
    // A machine with no `physical_extruder_map` is single-extruder: every filament prints on nozzle 0.
    const validNozzleIds = new Set(physicalExtruderMap)
    // Nozzle 0 exists on every machine, so an UNASSIGNED slot defaults there rather than to
    // whichever id happens to head `physical_extruder_map` (the H2D's is `["1","0"]`, i.e. the LEFT
    // nozzle — an arbitrary place to put a filament the project never assigned).
    const fallbackNozzleId = validNozzleIds.has('0') ? '0' : physicalExtruderMap[0] ?? '0'
    next.filament_nozzle_map = Array.from({ length: filamentCount }, (_unused, index) => {
      const existing = previousNozzleMap[index]
      return existing != null && validNozzleIds.has(existing) ? existing : fallbackNozzleId
    })
  }

  // Per FILAMENT, like `filament_nozzle_map` above — NOT per extruder. `volumeTypes` is the
  // machine's `default_nozzle_volume_type`, one entry per extruder, so mapping it directly wrote a
  // 2-entry map for a 3-filament project. Same defect `filament_nozzle_map` carried, same
  // consequence: BambuStudio reads a filament's entry past the end of the vector. Each filament
  // takes the volume type of the nozzle it is assigned to.
  if (volumeTypes.length > 0 && filamentCount > 0) {
    const nozzleMap = stringArray(next.filament_nozzle_map)
    next.filament_volume_map = Array.from({ length: filamentCount }, (_unused, index) => {
      // `physical_extruder_map` maps extruder POSITION -> nozzle id, so invert it to find the
      // extruder this filament's nozzle belongs to. An unmapped nozzle falls back to extruder 0.
      const extruderIndex = Math.max(physicalExtruderMap.indexOf(nozzleMap[index] ?? '0'), 0)
      return mapNozzleVolumeTypeToIndex(volumeTypes[Math.min(extruderIndex, volumeTypes.length - 1)] ?? 'Standard')
    })
  }

  // Only REBUILT when the existing value cannot describe the new machine — i.e. it is missing or has
  // the wrong number of extruders. `extruder_max_nozzle_count` is not the same quantity: a real H2D
  // project carries `["Standard#2","Standard#1"]` beside `extruder_max_nozzle_count: ["1","1"]`, so
  // deriving from it flattened the project's own correct value to `["Standard#1","Standard#1"]` on
  // every retarget. Preserve what the file holds rather than compute something we cannot derive.
  const existingNozzleStats = stringArray(next.extruder_nozzle_stats)
  if (volumeTypes.length > 0 && maxNozzleCounts.length > 0 && existingNozzleStats.length !== maxNozzleCounts.length) {
    next.extruder_nozzle_stats = maxNozzleCounts.map((count, index) => {
      const volumeType = volumeTypes[Math.min(index, volumeTypes.length - 1)] ?? 'Standard'
      return `${volumeType}#${count}`
    })
  }

  if (physicalExtruderMap.length > 1) {
    next.extruder_ams_count = buildExtruderAmsCount(stringArray(next.extruder_ams_count), physicalExtruderMap.length)
  }

  for (const key of PROFILE_DELETE_IF_MISSING_KEYS) {
    if (machineProfile[key] === undefined) {
      delete next[key]
    }
  }
  const retargetFilamentCount = Math.max(
    stringArray(next.filament_type).length,
    stringArray(next.filament_settings_id).length,
    stringArray(next.filament_colour).length
  )
  for (const key of PROFILE_RESHAPE_IF_MISSING_KEYS) {
    if (machineProfile[key] !== undefined) continue
    const value = next[key]
    if (Array.isArray(value) && retargetFilamentCount > 0 && value.length !== retargetFilamentCount) delete next[key]
  }

  return next
}

function mapNozzleVolumeTypeToIndex(value: string): string {
  return NOZZLE_VOLUME_TYPE_INDEX[value.trim().toLowerCase()] ?? '0'
}

function buildExtruderAmsCount(existingValues: string[], extruderCount: number): string[] {
  if (existingValues.length === extruderCount) {
    return existingValues.map((value) => value.endsWith('|4#0') ? `${value.slice(0, -4)}|4#1` : value || '1#0|4#1')
  }
  return Array.from({ length: extruderCount }, () => '1#0|4#1')
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : typeof value === 'string' && value.trim().length > 0
      ? [value.trim()]
      : []
}


/**
 * Re-shape the PROCESS side's per-extruder-variant columns to the target machine's variant list.
 *
 * BambuStudio 2.x stores many process values as one column per (extruder, variant) pair —
 * `print_extruder_variant` names the columns and `print_extruder_id` says which extruder each
 * belongs to, and every variant-aware process key (speeds, accelerations, flow ratios, …) carries
 * the same width. A machine retarget rewrote the MACHINE's variant topology but left those process
 * columns at the SOURCE machine's width, so an H2D project (5 columns) retargeted onto a
 * single-variant A1 mini kept 5 — a process topology the new machine cannot index. That mismatch
 * segfaults the engine mid-load (CLI exit 139), reproduced with the real CLI on a real project.
 *
 * The filament side has the identical rule (`FILAMENT_OPTIONS_WITH_VARIANT`); this is its process
 * twin, and both read their key set from `variant-options.ts` rather than inferring it from lengths. Columns are matched BY VARIANT NAME so a shared variant keeps its own tuned
 * values, falling back to the first column for a variant the source never had. Only keys the
 * process catalog knows are touched — an unrelated array that merely shares the column count
 * (`head_wrap_detect_zone`, `printable_area`) must never be re-indexed.
 */
function retargetProcessExtruderVariants(
  next: Record<string, unknown>,
  machineVariants: string[],
  machineExtruderIds: string[]
): void {
  const sourceVariants = stringArray(next.print_extruder_variant)
  if (sourceVariants.length === 0 || machineVariants.length === 0) return
  const unchanged = sourceVariants.length === machineVariants.length
    && sourceVariants.every((variant, index) => variant === machineVariants[index])
  if (unchanged) return
  const columnForVariant = machineVariants.map((variant) => {
    const exact = sourceVariants.indexOf(variant)
    return exact >= 0 ? exact : 0
  })
  for (const [key, value] of Object.entries(next)) {
    if (!Array.isArray(value) || value.length !== sourceVariants.length) continue
    // BambuStudio's OPTION rule decides this, not the length. Catalog membership plus a matching
    // length convicts any ordinary process array that happens to be as long as the variant list —
    // likeliest on a 2-column machine, where plenty of unrelated pairs are that length — and
    // re-indexing one silently rewrites values the user set. The filament side had the same flaw
    // and it corrupted real projects; see `variant-options.ts`.
    if (!isPrintVariantOption(key)) continue
    if (processSettingsCatalog.options[key] === undefined) continue
    next[key] = columnForVariant.map((column) => value[column])
  }
  next.print_extruder_variant = machineVariants
  if (machineExtruderIds.length > 0) next.print_extruder_id = machineExtruderIds
}

function buildPrinterExtruderVariants(variantList: string[]): string[] {
  return variantList.flatMap((value) => value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0))
}

function buildPrinterExtruderIds(variantList: string[]): string[] {
  return variantList.flatMap((value, index) => {
    const variants = value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    return Array.from({ length: variants.length }, () => String(index + 1))
  })
}

function mergeMissingProfileFields(target: ProfileRecord, source: ProfileRecord): void {
  for (const [key, value] of Object.entries(source)) {
    if (!hasMeaningfulProfileValue(target[key]) && hasMeaningfulProfileValue(value)) {
      target[key] = cloneValue(value)
    }
  }
}

function hasMeaningfulProfileValue(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return [...value]
  return value
}
