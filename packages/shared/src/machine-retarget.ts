/**
 * Retargeting a 3MF project's `project_settings.config` to a different Bambu machine:
 * the "change the project's printer" operation, done by rewriting settings rather than
 * re-slicing. Pure functions (no I/O), shared by three callers: the API (the workspace editor's
 * save-as-a-different-printer flow), the browser (the public editor's save, which never uploads
 * the file), and the slicer (the estimate-mode cross-model switch's topology repair).
 *
 * {@link applyMachineRetargetToProjectSettings} is the whole operation in one call and is what the
 * two editor hosts share; the individual steps stay exported for the slicer's narrower repair.
 *
 * One exception to "no I/O": {@link resolveRetargetProcessFallback} needs the catalogue to decide
 * whether the project's process still fits the target, and it takes an injected resolver rather than
 * living in a host, because the rule it encodes is the one both hosts must not drift on.
 *
 * Update resilience: {@link retargetProjectSettingsToMachine} overwrites **every** key the
 * resolved machine profile defines (minus profile metadata), so when BambuStudio adds new
 * machine fields in a version bump they are carried over automatically, there is no
 * per-field allow-list to maintain here. The only BambuStudio-coupled logic is the
 * dependent-map derivation below (`repairEstimateModeProjectSettings`), which reconstructs
 * the runtime maps that depend on BOTH the machine topology and the project's filaments
 * (`filament_nozzle_map`, extruder variants, …). See docs/project-printer-retarget.md.
 */
import { canonicalBambuModelKey } from './bambu-model-keys.js'
import { processConfigValuesEqual, processSettingsCatalog } from './process-settings.js'
import { PRINTER_PRESET_OPTIONS, PRINT_PRESET_OPTIONS } from './generated/preset-options.generated.js'
import { repairFlushMultiplier, repairFlushVolumesMatrix } from './flush-volumes-matrix.js'
import { buildFilamentVariantRows } from './filament-variant-index.js'
import { rebindProjectFilamentPhysics, type FilamentSlotRebind } from './filament-rebind.js'
import { machineSettingsCatalog } from './machine-settings.js'
import {
  extractChangedFromSystemKeys,
  machinePresetSlotIndexFor,
  withChangedFromSystemSlot
} from './three-mf-project-config.js'
import { isPrintVariantOption } from './variant-options.js'
import { dropEngineHostileOverrides } from './settings-value-guard.js'

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
  // Profile compatibility *declarations* (which printers/prints a preset is for), not settings.
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
 * machine preset mentions, so its presence is not the machine's to decide, and deleting it left the
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
  target: {
    printerSettingsId: string
    printerModel: string
    /** System parent of a custom User preset; null/absent means the selected preset is system. */
    printerPresetInherits?: string | null
  }
): ProfileRecord {
  const next: ProfileRecord = { ...projectSettings }
  for (const [key, value] of Object.entries(machineProfile)) {
    if (NON_SETTING_PROFILE_KEYS.has(key)) continue
    // Only what BambuStudio itself considers part of a printer preset. A resolved profile also
    // carries LEGACY keys the vendor has since renamed or dropped (`extruder_clearance_radius` ->
    // `extruder_clearance_max_radius`, `z_lift_type`, `extruder_height_gap`,
    // `deretract_speed_extruder_change`), and copying them wholesale wrote four keys into every
    // retargeted project that neither the source file nor a BambuStudio save contains, one of them
    // a per-extruder array at the WRONG length (5 entries on a 2-extruder machine), which is the
    // shape that segfaults BambuStudio mid-slice when it indexes by extruder.
    if (!PRINTER_PRESET_OPTIONS.has(key)) continue
    next[key] = normalizeProfileValueForProject(key, cloneValue(value), projectSettings[key])
  }
  next.printer_settings_id = target.printerSettingsId
  next.printer_model = target.printerModel
  // Re-declare the project's printer-compatibility for the target. The source printer's
  // declarations (e.g. an A1 mini project's `print_compatible_printers: ["… @BBL A1M …"]`)
  // are NOT machine-profile settings, so the overwrite above leaves them untouched, and they
  // then surface as stale compatibility chips (an A1/A1 mini chip on an H2D project). BambuStudio
  // writes the target machine here, so we match it: set `print_compatible_printers` and, when the
  // project carries one, `compatible_printers` to the target machine preset.
  next.print_compatible_printers = [target.printerSettingsId]
  if (next.compatible_printers !== undefined) next.compatible_printers = [target.printerSettingsId]
  // The CLI resolves the project's SYSTEM printer from inherits_group's LAST slot, not from
  // printer_settings_id. A project saved with an inherited/custom machine preset keeps its old
  // parent there (e.g. "Bambu Lab P1P 0.4 nozzle"), and CLIs from 2.7.1 on validate every loaded
  // filament preset against that name, a stale slot fails the slice with "filament preset ... is
  // not compatible with printer <old machine>". Blank it so the rewritten printer_settings_id is
  // the system identity. A custom User preset is the exception: its installed system identity is
  // its parent, and blanking this slot makes the CLI search machine_full for the custom name.
  setInheritsGroupSlot(next, 'machine', target.printerPresetInherits ?? '')
  // `flush_volumes_matrix` is a PROJECT key, not a machine-profile one, so the overwrite above
  // leaves it at the SOURCE machine's extruder count while `nozzle_diameter` above just changed
  // that count. Retargeting a single-nozzle project onto a dual-nozzle printer therefore left one
  // block where two are required, and BambuStudio read the missing block out of bounds and
  // segfaulted mid-slice (see flush-volumes-matrix.ts). Re-derive it for the new topology.
  repairFlushSizingForTopology(next)
  return repairEstimateModeProjectSettings(next, machineProfile)
}

/**
 * Re-derive `flush_volumes_matrix` and `flush_multiplier` for the record's CURRENT extruder count,
 * in place. Call after anything that can change `nozzle_diameter`'s length or the filament count.
 *
 * Extracted because two writers now change machine topology: the machine retarget above, and a
 * project's own machine overrides ({@link applyMachineSettingOverrides}). Neither failure is soft.
 * `flush_volumes_matrix` is a PROJECT key rather than a machine-profile one, so a topology change
 * leaves it sized for the OLD extruder count: BambuStudio then reads the missing block out of
 * bounds and segfaults mid-slice (exit 139, see flush-volumes-matrix.ts). And `flush_multiplier` is
 * the length the ENGINE validates the matrix against (`GCode.cpp` uses `flush_multiplier.size()` as
 * the heads count, not `nozzle_diameter`), so a stale one fails at "Generating G-code" with "Flush
 * volumes matrix do not match to the correct size!" (exit 156). `flush_multiplier_fast` is resized
 * only when the file carries it: genuine Bambu saves routinely omit it, and absence is safe.
 */
function repairFlushSizingForTopology(next: ProfileRecord): void {
  const filamentCount = Array.isArray(next.filament_colour) ? next.filament_colour.length : 0
  const extruderCount = Array.isArray(next.nozzle_diameter) ? Math.max(next.nozzle_diameter.length, 1) : 1
  const repairedMatrix = repairFlushVolumesMatrix(
    Array.isArray(next.flush_volumes_matrix) ? next.flush_volumes_matrix : null,
    filamentCount,
    extruderCount
  )
  if (repairedMatrix) next.flush_volumes_matrix = repairedMatrix
  const repairedMultiplier = repairFlushMultiplier(next.flush_multiplier, extruderCount)
  if (repairedMultiplier) next.flush_multiplier = repairedMultiplier
  if (next.flush_multiplier_fast !== undefined) {
    const repairedFast = repairFlushMultiplier(next.flush_multiplier_fast, extruderCount, '1.2')
    if (repairedFast) next.flush_multiplier_fast = repairedFast
  }
}

/**
 * Apply a project's OWN machine settings on top of its resolved machine preset: BambuStudio's
 * "modified printer preset", scoped to one project instead of the global preset bundle.
 *
 * The counterpart to {@link applyProcessProfileToProjectSettings} for the machine domain, and it
 * exists because a 3MF genuinely embeds its machine settings -- `project_settings.config` carries
 * the full machine block that {@link retargetProjectSettingsToMachine} writes, not merely the
 * printer's NAME. So "modified vs the preset, saved in the project" is representable for a printer
 * exactly as it is for a process, with no new file format.
 *
 * ORDER: must run AFTER the machine step, or the resolved preset overwrites the user's values --
 * they are the same keys, which is the whole point of an override.
 *
 * Engine-hostile values are dropped exactly as the process path drops them (an empty numeric makes
 * the engine silently abandon every key after it), and the flush sizing is re-derived because an
 * override may legitimately change `nozzle_diameter` and with it the extruder count.
 */
export function applyMachineSettingOverrides(
  projectSettings: ProfileRecord,
  overrides: Record<string, string | string[]>,
  presetConfig?: ProfileRecord
): ProfileRecord {
  // The MACHINE catalog, not the default process one: the guard looks the key up to decide whether
  // it is numeric, so with the wrong catalog every machine key is unknown, reads as non-numeric,
  // and an empty value sails through. That is the exact shape the guard exists to stop -- the
  // engine accepts it and then either silently zeroes the setting or builds a ZERO-LENGTH
  // per-extruder vector whose `get_at` reads out of bounds in release builds.
  const kept = dropEngineHostileOverrides(overrides, machineSettingsCatalog)
  // Where the ENGINE reads the machine slot. Null means the project states no filament count, so the
  // slot cannot be located: writing anyway would file machine keys into filament slot 1's record.
  const machineIndex = machinePresetSlotIndexFor(projectSettings)
  if (machineIndex == null) return projectSettings
  // PERMISSIVE on the way in, deliberately. The slot is REPLACED below with the set assembled here,
  // so any key this fails to read is not merely invisible in the UI, it is deleted from
  // BambuStudio's own record by our save. Our machine catalog is scoped to what the settings dialog
  // exposes and omits real machine keys (`hotend_cooling_rate`, `nozzle_flush_dataset`,
  // `physical_extruder_map`, ...), so filtering by it here would quietly strip a Studio-authored
  // record down to the subset we happen to render. The catalog filter belongs on the DISPLAY side
  // (`readMachineSettingOverrides`), not on retention.
  const previouslyRecorded = extractChangedFromSystemKeys(
    projectSettings.different_settings_to_system,
    machineIndex,
    () => true
  )
  // Nothing to do only when the project ALSO records nothing. An empty map on a project that
  // carries overrides is a deliberate "reset them all", and returning early there is what made
  // clearing an override a silent no-op that the next open then undid.
  if (Object.keys(kept).length === 0 && previouslyRecorded.length === 0) return projectSettings

  const next: ProfileRecord = { ...projectSettings }
  for (const [key, value] of Object.entries(kept)) next[key] = cloneValue(value)
  // A key the user RESET goes back to the preset's value, not merely out of the record: the engine
  // reads the VALUE, so leaving it would keep slicing with an override the UI no longer shows.
  // Without a preset to restore from it is left alone rather than guessed at.
  // A key stays RECORDED unless its value can actually be put back. Un-recording one we cannot
  // restore would leave the file self-inconsistent: the UI would read it as no longer overridden
  // while the engine kept slicing with the overridden value.
  //
  // A key we cannot even DISPLAY is also kept recorded: the dialog never offered it, so the user
  // cannot have reset it, and dropping it would delete a Studio-authored entry nobody touched.
  const stillRecorded = new Set(Object.keys(kept))
  for (const key of previouslyRecorded) {
    if (key in kept) continue
    const option = machineSettingsCatalog.options[key]
    const presetValue = option === undefined ? undefined : presetConfig?.[key]
    if (presetValue === undefined) {
      stillRecorded.add(key)
      continue
    }
    // Through the project's own spelling, not the preset's. The two serialize the same value
    // differently (a point is `0.3x0.5` in a preset and `0.3,0.5` in a project, and a scalar can
    // arrive as a one-element vector), so assigning verbatim would leave the file carrying a form
    // BambuStudio never writes -- and would make our own reader report the key as changed again.
    next[key] = normalizeProfileValueForProject(key, presetValue, projectSettings[key])
  }
  next.different_settings_to_system = withChangedFromSystemSlot(
    next.different_settings_to_system,
    machineIndex,
    [...stillRecorded],
    machineIndex - 1
  )
  repairFlushSizingForTopology(next)
  return next
}

/**
 * Read back what {@link applyMachineSettingOverrides} wrote: the machine settings a project records
 * as CHANGED from its printer preset.
 *
 * Lives next to the writer deliberately. The two were a page apart in different workspaces, and a
 * disagreement between them is invisible in both: the save succeeds, the file is well-formed, and
 * the override is simply not there on the next open. They disagreed about the slot index for a
 * whole release. `machine-override-roundtrip.test.ts` drives this pair against each other rather
 * than asserting either alone.
 *
 * Reads BambuStudio's OWN record rather than diffing the embedded machine block against the
 * resolved preset. A value diff is unusable here, measured on a real project: it reported 44
 * "overrides" of which essentially none were user edits. `best_object_pos` is serialized `0.3,0.5`
 * in the project and `0.3x0.5` in the preset; every per-extruder and per-print-mode vector
 * (`machine_max_speed_*`, `retraction_*`, ...) differs only in LENGTH while every value matches;
 * and keys the preset simply does not define (`thumbnail_size`) read as changes. Badging that count
 * would be a confident lie, and applying it would write 44 values into the project as though the
 * user had chosen them.
 *
 * An ABSENT record answers `{}`: unknown is not the same as modified, and the quiet direction is
 * the one that cannot invent an override nobody made. A key the record NAMES but whose value the
 * preset has since caught up to is dropped for the same reason -- the record is BambuStudio's, and
 * it is not re-checked when a preset changes underneath it.
 */
export function readMachineSettingOverrides(
  projectSettings: ProfileRecord,
  presetConfig: Record<string, string | string[]>
): Record<string, string | string[]> {
  const machineIndex = machinePresetSlotIndexFor(projectSettings)
  if (machineIndex == null) return {}
  // Catalog-filtered HERE and not in the writer: this answer drives a dialog, so a key the dialog
  // cannot render has nothing to show. The writer must stay permissive, or saving would delete the
  // very entries this hides.
  const recordedKeys = extractChangedFromSystemKeys(
    projectSettings.different_settings_to_system,
    machineIndex,
    (key) => machineSettingsCatalog.options[key] !== undefined
  )
  const overrides: Record<string, string | string[]> = {}
  for (const key of recordedKeys) {
    const projectValue = projectSettings[key]
    if (typeof projectValue !== 'string' && !Array.isArray(projectValue)) continue
    const value = projectValue as string | string[]
    if (processConfigValuesEqual(presetConfig[key], value, machineSettingsCatalog.options[key])) continue
    overrides[key] = value
  }
  return overrides
}


/**
 * Blanks one slot of Bambu's `inherits_group`: slot 0 names the process preset's parent and the
 * MACHINE slot the printer preset's (the filament slots sit in between). An empty slot means "this
 * preset IS a system preset", making the CLI derive the system identity from the corresponding
 * `*_settings_id` the retarget just wrote.
 *
 * The machine slot comes from the project's FILAMENT COUNT, never from the array's own length,
 * because here the record carries that count independently and it is what the engine indexes by.
 * The two answers differ only on a mis-sized array, and there `length - 1` is wrong both ways: on a
 * LONG one it blanked junk past the slot the engine reads, leaving the stale parent this exists to
 * clear; on a SHORT one it blanked a FILAMENT slot, telling the CLI that filament was a system
 * preset.
 *
 * Two cases write nothing, both because a wrong slot is worse than a stale one. A record that does
 * not DECLARE its filament arrays cannot place the machine slot at all -- a count of zero there
 * means "unknown", not "no filaments" -- and a slot past the end of the array is a parent the engine
 * cannot see either, so there is nothing to clear; resizing is the Repair stage's job, not something
 * an ordinary retarget does behind the user's back. The process slot is index 0 in every case, which
 * no count arithmetic can get wrong.
 */
export function clearInheritsGroupSlot(record: ProfileRecord, slot: 'process' | 'machine'): void {
  setInheritsGroupSlot(record, slot, '')
}

/** Write one known-position `inherits_group` slot without reshaping a malformed parallel record. */
function setInheritsGroupSlot(record: ProfileRecord, slot: 'process' | 'machine', value: string): void {
  if (!Array.isArray(record.inherits_group) || record.inherits_group.length === 0) return
  const machineIndex = machinePresetSlotIndexFor(record)
  if (slot === 'machine' && machineIndex == null) return
  const index = slot === 'process' ? 0 : machineIndex!
  if (index >= record.inherits_group.length) return
  const inheritsGroup = [...record.inherits_group as string[]]
  inheritsGroup[index] = value
  record.inherits_group = inheritsGroup
}

/**
 * Brings a project's **process** (print/quality) settings over to the target printer's process
 * preset: the companion to {@link retargetProjectSettingsToMachine}. Overwrites every process-owned
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
  // Guarded here too, not just in the bake. This is the path a slice takes when its process preset
  // RESOLVES, i.e. the ordinary one, so without it a save dropped an engine-hostile override while
  // the slice of the same session state still wrote it, and the two files disagreed.
  for (const [key, value] of Object.entries(dropEngineHostileOverrides(overrides))) {
    next[key] = cloneValue(value)
  }
  return next
}

/**
 * Everything a machine retarget needs, already RESOLVED. Assembling this is where the two editor
 * hosts differ, the api resolves through the slicer plus the workspace's preset files, the browser
 * through `/api/public/slicing/resolve-*`, and applying it is where they must not.
 */
export interface MachineRetargetPlan {
  /** Fully-resolved machine preset for the TARGET printer. */
  machineConfig: ProfileRecord
  /** Machine preset name, persisted as `printer_settings_id`. */
  printerSettingsId: string
  /** System parent written into `inherits_group` when the selected machine is a custom preset. */
  printerPresetInherits?: string | null
  printerModel: string
  /**
   * Fully-resolved process preset for the target, when one could be resolved. Absent/null leaves
   * the project's embedded process alone: deliberate: an unresolvable process (e.g. a project
   * preset, which has no separate file) must not block the machine retarget, which is what makes
   * the project openable on the new printer at all.
   */
  processConfig?: ProfileRecord | null
  /** The session's process overrides, applied on top of `processConfig`. */
  processSettingOverrides?: Record<string, string | string[]>
  /** The project's own machine settings, applied over the resolved machine preset. */
  machineSettingOverrides?: Record<string, string | string[]>
  /**
   * Per-slot filament rebinds, index-aligned with the project's filament list. Absent/null keeps
   * every slot's current values: the rebind is an improvement pass, never a requirement.
   */
  filamentRebinds?: FilamentSlotRebind[] | null
}

/**
 * Apply a resolved {@link MachineRetargetPlan} to a project's parsed `project_settings.config`.
 *
 * The one definition of what "save this project for a different printer" DOES, shared so the two
 * hosts cannot drift: the api runs it over the 3MF it just baked, the browser over the 3MF it just
 * baked in the tab. Order matters and is fixed here: machine first (it re-derives the topology
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
 *    bare (`enable_long_retraction_when_cut`: `["2"]` vs `"2"`: `coInt` in BambuStudio, and absent
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
    printerModel: plan.printerModel,
    printerPresetInherits: plan.printerPresetInherits
  })
  if (plan.processConfig) {
    next = applyProcessProfileToProjectSettings(next, plan.processConfig, plan.processSettingOverrides ?? {})
  }
  if (plan.filamentRebinds && plan.filamentRebinds.length > 0) {
    next = rebindProjectFilamentPhysics(next, plan.filamentRebinds)
  }
  // The project's own machine values go on LAST in the machine domain, over the preset that just
  // wrote the same keys. The api applies these as its own post-bake pass instead; this carries them
  // for the browser host, whose only hook into a save is the retarget plan.
  //
  // NOT gated on the map being non-empty. An empty map means "reset every override", and the whole
  // point of the reset fix is that `{}` has to reach the applier, which owns the only correct
  // no-op test (nothing to write AND nothing recorded). A `length > 0` guard here reinstated the
  // original bug for the public editor, where resetting an override saved a file that still
  // carried it.
  if (plan.machineSettingOverrides) {
    next = applyMachineSettingOverrides(next, plan.machineSettingOverrides, plan.machineConfig)
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
 * slicer's machine-switch guard (heal-or-reject before slicing) and the API's save-side heal,
 * one definition so the two ends never disagree on what "intact" means.
 */
/**
 * Does a project already define `targetModel` COMPLETELY: the right machine, with the full topology
 * that machine needs?
 *
 * "Same printer" is not "fully defined": a project can name `printer_model: H2D` while carrying
 * none of H2D's extruder-indexed dual-nozzle arrays, which is the state that made the CLI refuse it
 * or slice with no print volume. Callers use it to decide whether a same-model save still needs the
 * machine authored in, so answering yes on an incomplete project silently skips the authoring.
 *
 * Unreadable or absent settings count as INCOMPLETE, which is the safe direction: that is what a
 * from-scratch scaffold looks like, and it needs the machine written.
 *
 * Shared because both hosts bake now and a save that re-authors an unchanged machine is not a
 * cosmetic difference: the full retarget rewrites the project's process values along with it.
 */
export function projectDefinesMachineCompletely(
  projectSettings: ProfileRecord | null,
  targetModel: string | null
): boolean {
  if (!projectSettings) return false
  const model = canonicalBambuModelKey(
    firstProfileString(projectSettings.printer_model) ?? firstProfileString(projectSettings.printer_settings_id)
  )
  if (!model) return false
  const target = canonicalBambuModelKey(targetModel)
  if (target && model !== target) return false
  // Only the H2 family carries a topology beyond the plain machine fields.
  return H2_DUAL_NOZZLE_MODEL_KEYS.has(model) ? hasDualNozzleMachineShape(projectSettings) : true
}

/**
 * Does the project's embedded machine already carry the nozzle diameters a save targets?
 *
 * The companion question to {@link projectDefinesMachineCompletely}, which only compares the MODEL.
 * A nozzle switch (0.4 to 0.6) keeps the model and changes the machine preset, so without this a
 * save onto a derived target could never re-author the machine and the project kept the old nozzle.
 *
 * Compared as SETS: the target lists the diameters in play while the project lists them per
 * extruder, so an H2D's [0.4, 0.4] must still match a target of [0.4]. An empty target answers TRUE
 * (nothing was asked for), and unreadable settings answer FALSE: author rather than assume.
 */
export function projectMatchesNozzleDiameters(
  projectSettings: ProfileRecord | null,
  targetNozzleDiameters: readonly number[]
): boolean {
  if (targetNozzleDiameters.length === 0) return true
  if (!projectSettings) return false
  const embedded = Array.isArray(projectSettings.nozzle_diameter)
    ? (projectSettings.nozzle_diameter as unknown[])
      .map((entry) => Number.parseFloat(String(entry)))
      .filter((value) => Number.isFinite(value))
    : []
  if (embedded.length === 0) return false
  const wanted = new Set(targetNozzleDiameters)
  return embedded.every((value) => wanted.has(value)) && [...wanted].every((value) => embedded.includes(value))
}

/**
 * Does a resolved PROCESS preset declare that it fits the machine preset being authored?
 *
 * BambuStudio's own test, ported: compatibility is a literal `compatible_printers` NAME list, not a
 * model comparison and not a nozzle comparison (`Preset.cpp:805-809`). Every bundled Bambu process
 * preset carries the list, and it is nozzle-specific because the nozzle is part of a printer
 * preset's identity there: `0.20mm Standard @BBL A1` lists exactly `Bambu Lab A1 0.4 nozzle`.
 *
 * A preset that declares NOTHING fits everything, which is the same "absence of evidence is not a
 * mismatch" rule the rest of the compatibility code follows, and is what keeps a hand-written or
 * project-embedded preset from being refused for saying too little.
 *
 * Used as a WRITE guard rather than a picker: authoring a process preset the machine does not accept
 * bakes settings the engine will refuse or silently fall back from, into a file the user keeps.
 */
export function processPresetFitsMachine(
  processConfig: ProfileRecord | null | undefined,
  machinePresetName: string | null | undefined
): boolean {
  if (!processConfig || !machinePresetName) return true
  const declared = processConfig.compatible_printers
  const names = Array.isArray(declared)
    ? declared.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : typeof declared === 'string' && declared.trim() ? [declared] : []
  if (names.length === 0) return true
  return names.some((name) => name.trim() === machinePresetName.trim())
}

/**
 * The SYSTEM process preset a project's own process resolves to, i.e. the name whose
 * `compatible_printers` decides whether the project may slice on a given machine.
 *
 * Ported from `BambuStudio.cpp:2012-2017`: slot 0 of `inherits_group` when it is filled, else the
 * leaf's own `print_settings_id`, because an empty slot means "this preset IS a system preset".
 * Slot 0 needs no filament-count arithmetic; only the MACHINE slot moves (`machinePresetSlotIndexFor`).
 */
export function projectProcessSystemName(projectSettings: ProfileRecord): string | null {
  const group = Array.isArray(projectSettings.inherits_group) ? projectSettings.inherits_group : []
  return firstProfileString(group[0]) ?? firstProfileString(projectSettings.print_settings_id)
}

/** The process preset a machine preset nominates for projects that arrive without a usable one. */
export function machineDefaultProcessName(machineConfig: ProfileRecord): string | null {
  return firstProfileString(machineConfig.default_print_profile)
}

/**
 * The process preset a retarget must switch TO because the project's own was authored for another
 * machine, or null to leave the project's process alone.
 *
 * This is BambuStudio's machine-switch behaviour, ported. Studio never repoints a preset's lineage:
 * on a printer change `PresetBundle::update_compatible(Always)` recomputes every process preset's
 * compatibility, DESELECTS the current one when it no longer fits (`Preset.cpp:2999-3003`), and
 * selects another, seeded with the new printer's `default_print_profile`
 * (`PresetBundle.cpp:5741`, `PreferedPrintProfileMatch`). The user's preset survives untouched and
 * simply stops being offered. So this returns a REPLACEMENT, never an edited version of the old one.
 *
 * Why a retarget needs it at all: the machine rewrite re-declares `print_compatible_printers` for the
 * target, but the engine does not read that field for this decision. It reads the process's parent
 * (see {@link projectProcessSystemName}), which a machine-only retarget leaves naming the OLD model,
 * and then refuses the slice with exit 239. Before this, that produced a file that opened fine, drew
 * the right compatibility chips, and could not be sliced by the printer it claimed to be for.
 *
 * Three deliberate departures from Studio, all narrowing:
 *  - It runs only on a genuine MODEL change. Studio reselects on any printer-preset switch; a save
 *    is not a switch, and rewriting a project's process on an ordinary nozzle change would discard
 *    hand-tuned values with no UI signal. The picker owns that case.
 *  - Studio scans the whole catalogue and prefers a matching ALIAS, then a matching `layer_height`,
 *    over the machine default. We take the machine's declared default only. The alias is not
 *    recoverable (the generated `process_full/` profiles carry none), and a save is not the place to
 *    silently change layer height by a scan; the DIALOG's re-pick does own the layer-height
 *    preference (`useProcessProfileSelection`), and on any path through it the process is already
 *    compatible and this never fires.
 *  - Nothing happens unless BOTH lookups succeed and the replacement itself fits (and names itself:
 *    see below). An unresolvable parent is "unknown", not "wrong", and leaving the project's process
 *    is the pre-existing behaviour, so a lookup failure can never make a save worse than it was.
 *
 * The one function in this module that performs I/O, and it does it through an injected resolver for
 * the reason the rest is pure: the RULE has to be single-sourced across the api and browser hosts,
 * which reach the catalogue through completely different transports.
 */
export async function resolveRetargetProcessFallback(input: {
  projectSettings: ProfileRecord
  machineConfig: ProfileRecord
  /** The machine preset name being authored, which `compatible_printers` is matched against. */
  printerSettingsId: string
  /** Resolve a system process preset by NAME, with its `inherits` chain merged; null if unknown. */
  resolveSystemProcess: (name: string) => Promise<ProfileRecord | null>
  log?: (message: string) => void
}): Promise<ProfileRecord | null> {
  // Same MODEL: the machine block is being authored, the process is not. This mirrors the browser's
  // same-model branch (`sameModelPresetPlan`), which never reselects, and it matters because the api
  // reaches this function for a same-model save too, whenever the project's machine was defined
  // incompletely. Reselecting on a nozzle change would overwrite every process key the user tuned in
  // an earlier session, and the dialog has already re-picked by then: its lineage check applies the
  // ENGINE's exact `compatible_printers` rule, so a parent the target refuses is dropped from the
  // picker rather than being silently swapped here.
  const targetModel = canonicalBambuModelKey(firstProfileString(input.machineConfig.printer_model))
  const currentModel = canonicalBambuModelKey(firstProfileString(input.projectSettings.printer_model))
  if (targetModel && currentModel && targetModel === currentModel) return null

  const currentName = projectProcessSystemName(input.projectSettings)
  if (!currentName) return null
  const current = await input.resolveSystemProcess(currentName)
  // Unknown parent, or one that still accepts the target: nothing to switch away from.
  if (!current || processPresetFitsMachine(current, input.printerSettingsId)) return null

  const fallbackName = machineDefaultProcessName(input.machineConfig)
  const fallback = fallbackName ? await input.resolveSystemProcess(fallbackName) : null
  // The replacement must fit, and must NAME itself. `applyProcessProfileToProjectSettings` writes
  // `print_settings_id` and blanks `inherits_group[0]` only when the preset carries a name, and
  // blanking that slot is the whole point: a nameless config would copy its values over the project
  // and leave it pointing at the OLD printer's process, which the engine still refuses (exit 239)
  // while the user's settings have silently changed underneath them. Worse than doing nothing.
  if (!fallback || !firstProfileString(fallback.name) || !processPresetFitsMachine(fallback, input.printerSettingsId)) {
    input.log?.(`the project's process "${currentName}" does not fit ${input.printerSettingsId} and no compatible replacement resolved; keeping it`)
    return null
  }
  input.log?.(`the project's process "${currentName}" was authored for another printer; switching to "${fallbackName}" for ${input.printerSettingsId}`)
  return fallback
}

/** First non-empty string of a config value, which may be a scalar or a vector. */
/**
 * The first non-empty string of a scalar-or-vector config value.
 *
 * Exported because a config value is a scalar in one preset and a per-slot vector in the next, so
 * every reader of one needs this, and it had grown four byte-identical copies (here plus three in
 * the editor's bake modules). Trimmed, and an all-blank vector reads as absent.
 */
export function firstProfileString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string' && entry.trim())
    return typeof first === 'string' ? first.trim() : null
  }
  return null
}

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
    // them from separate passes is what let them drift: see `buildFilamentVariantLayout`.
    const layout = buildFilamentVariantRows(printerExtruderVariants, stringArray(next.filament_type))
    next.filament_extruder_variant = layout.variants
    next.filament_self_index = layout.selfIndex
  }

  // `filament_nozzle_map` is indexed by FILAMENT (one entry per project filament, valued with the
  // runtime nozzle id), NOT by extruder, assigning `physical_extruder_map` (one entry per extruder)
  // produced a map of the wrong LENGTH whenever the project's filament count differed from the new
  // machine's extruder count. BambuStudio then reads a filament's extruder past the end of that
  // vector, which is the documented "can not be printed on extruder <garbage>" abort / mid-slice
  // SIGSEGV. Rebuild it per filament: keep a slot's existing nozzle when the NEW machine still has
  // it, else fall back to the machine's primary, so a dual -> single-nozzle switch collapses every
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
    // nozzle, an arbitrary place to put a filament the project never assigned).
    const fallbackNozzleId = validNozzleIds.has('0') ? '0' : physicalExtruderMap[0] ?? '0'
    next.filament_nozzle_map = Array.from({ length: filamentCount }, (_unused, index) => {
      const existing = previousNozzleMap[index]
      return existing != null && validNozzleIds.has(existing) ? existing : fallbackNozzleId
    })
  }

  // Per FILAMENT, like `filament_nozzle_map` above, NOT per extruder. `volumeTypes` is the
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

  // Only REBUILT when the existing value cannot describe the new machine: i.e. it is missing or has
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
 * BambuStudio 2.x stores many process values as one column per (extruder, variant) pair:
 * `print_extruder_variant` names the columns and `print_extruder_id` says which extruder each
 * belongs to, and every variant-aware process key (speeds, accelerations, flow ratios, …) carries
 * the same width. A machine retarget rewrote the MACHINE's variant topology but left those process
 * columns at the SOURCE machine's width, so an H2D project (5 columns) retargeted onto a
 * single-variant A1 mini kept 5, a process topology the new machine cannot index. That mismatch
 * segfaults the engine mid-load (CLI exit 139), reproduced with the real CLI on a real project.
 *
 * The filament side has the identical rule (`FILAMENT_OPTIONS_WITH_VARIANT`); this is its process
 * twin, and both read their key set from `variant-options.ts` rather than inferring it from lengths. Columns are matched BY VARIANT NAME so a shared variant keeps its own tuned
 * values, falling back to the first column for a variant the source never had. Only keys the
 * process catalog knows are touched, an unrelated array that merely shares the column count
 * (`head_wrap_detect_zone`, `printable_area`) must never be re-indexed.
 */
function retargetProcessExtruderVariants(
  next: Record<string, unknown>,
  machineVariants: string[],
  machineExtruderIds: string[]
): void {
  const sourceVariants = stringArray(next.print_extruder_variant)
  if (sourceVariants.length === 0 || machineVariants.length === 0) return
  // `print_extruder_variant` and `print_extruder_id` are a PAIR and the engine treats a broken one
  // as no topology at all: `ensure_variant_and_get_len` erases BOTH when either is missing
  // (`Preset.cpp:225-228`) and falls back to the default length, which is how an H2D project comes
  // back single-extruder, and `BambuStudio.cpp:3085-3090` abandons its whole remap when the two
  // lengths disagree. We can only write the pair when the target machine gave us matching ids:
  // `printer_extruder_id` is rebuilt only when the machine declares `extruder_variant_list`, so
  // without it the ids here are the SOURCE machine's and describe a topology that no longer exists.
  // Leaving the process columns at the source width is the lesser evil, and the existing width
  // checks still flag it, whereas writing a variant list with no matching ids destroys the tuning
  // for certain.
  if (machineExtruderIds.length !== machineVariants.length) return
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
    // length convicts any ordinary process array that happens to be as long as the variant list,
    // likeliest on a 2-column machine, where plenty of unrelated pairs are that length, and
    // re-indexing one silently rewrites values the user set. The filament side had the same flaw
    // and it corrupted real projects; see `variant-options.ts`.
    if (!isPrintVariantOption(key)) continue
    if (processSettingsCatalog.options[key] === undefined) continue
    next[key] = columnForVariant.map((column) => value[column])
  }
  // Written TOGETHER, never one without the other. The length equality was established above.
  next.print_extruder_variant = machineVariants
  next.print_extruder_id = machineExtruderIds
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
