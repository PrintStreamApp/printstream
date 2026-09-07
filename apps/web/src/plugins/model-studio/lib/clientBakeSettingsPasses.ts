/**
 * The passes that rewrite `project_settings.config` AFTER the bake has written the archive.
 *
 * Split from `clientThreeMfBake.ts`, which owns the ZIP layer: these are a different concern that
 * happens to run on its output. Each mirrors a pass the api ran server-side while the workspace
 * editor's bake lived there (`routes/editor.ts`, `save-retarget.ts`, `save-filament-overrides.ts`),
 * and each takes its preset resolution as a THUNK, because resolution is the only part that differs
 * between the two hosts and the only part that is not free.
 *
 * {@link applyBakeSettingsPasses} owns the ORDER, which is load-bearing and belongs here rather than
 * with the caller: it is a property of the file being written, not of the host writing it. Which
 * passes are WANTED is a different question, answered by `editorBakePasses.ts`.
 *
 * Every pass is best-effort. A save that produced a file the user asked for must not fail because a
 * preset would not resolve; the alternative loses their work over a setting.
 */
import {
  THREE_MF_PROJECT_SETTINGS_ENTRY,
  THREE_MF_SLICE_INFO_ENTRY,
  applyNozzleAssignmentToProjectSettings
} from '@printstream/shared/three-mf'
import {
  H2_DUAL_NOZZLE_MODEL_KEYS,
  applyFilamentSlotOverrides,
  applyMachineRetargetToProjectSettings,
  applyMachineSettingOverrides,
  canonicalBambuModelKey,
  extractChangedFromSystemKeys,
  hasDualNozzleMachineShape,
  machinePresetSlotIndexFor,
  retargetProjectSettingsToMachine,
  stripSliceInfoPrinterModelId,
  type MachineRetargetPlan,
  type ProcessConfig,
  type ProfileRecord,
  type SceneEdit,
  firstProfileString
} from '@printstream/shared'

/**
 * Run every requested pass over the baked archive, in the api's order.
 *
 * The order is not arbitrary. FILAMENT overrides go first because the shared writer records every
 * key it writes in `different_settings_to_system`, and that record is what makes a later machine
 * rebind PRESERVE the user's edit instead of rebinding it away. The MACHINE step then rebuilds the
 * topology (extruder count, per-slot vectors, flush sizing) that every later write indexes by. The
 * machine OVERRIDES come last because they share a key space with the resolved preset, so applying
 * them earlier lets the preset overwrite the user's values, which looks exactly like the feature not
 * working. See `applyMachineRetargetToProjectSettings` for the canonical statement of it.
 *
 * The topology HEAL is the alternative to a retarget and never additional: a retarget has just
 * rebuilt the topology, so there is nothing left to heal.
 */
export async function applyBakeSettingsPasses(
  output: Record<string, Uint8Array>,
  edit: SceneEdit,
  passes: ClientBakeSettingsPasses
): Promise<void> {
  if (passes.filamentSettingOverrides) {
    await applyFilamentOverridesToEntries(output, passes.filamentSettingOverrides)
  }
  const retargeted = passes.machineRetarget
    ? await applyMachineRetargetToEntries(output, passes.machineRetarget)
    : false
  if (!retargeted && passes.machineTopologyHeal) {
    await healMachineTopologyInEntries(output, edit, passes.machineTopologyHeal)
  }
  if (passes.machineSettingOverrides) {
    await applyMachineOverridesToEntries(output, passes.machineSettingOverrides)
  }
}

export interface ClientBakeSettingsPasses {
  /**
   * "Save this project for a different printer". Resolved against the settings the bake wrote,
   * because the plan's filament rebind targets are picked from the filament list it just authored.
   */
  machineRetarget?: (projectSettings: ProfileRecord) => Promise<MachineRetargetPlan | null>
  /** The user's own printer-setting edits, applied last in the machine domain. */
  machineSettingOverrides?: MachineOverridesPass
  /** The material tune dialog's "Save in this 3MF" edits, applied FIRST. See the order note above. */
  filamentSettingOverrides?: FilamentOverridesPass
  /**
   * Re-author an H2-family project whose dual-nozzle machine data went missing, resolving the
   * machine the project itself names. Applied only when no retarget ran, which is the api's own
   * branching: a retarget has just rebuilt the topology, so there is nothing left to heal.
   */
  machineTopologyHeal?: (machineName: string) => Promise<ProfileRecord | null>
}

/**
 * Restore an H2-family project's dual-nozzle machine data, in place.
 *
 * Mirrors `healSavedProjectMachineTopology` in the api's `save-retarget.ts`. Declines quietly on
 * anything it cannot improve: settings absent or unreadable, not an H2-family machine, topology
 * already intact, or a machine name that will not resolve (a custom preset, which the slicer's own
 * slice-time heal still covers).
 *
 * The nozzle assignment is re-applied AFTER the heal because the re-author resets
 * `filament_nozzle_map` to the machine default, and the assignment write no-ops without
 * `physical_extruder_map`: the missing topology is exactly why the user's L/R choice had silently
 * stopped saving in the first place.
 *
 * Never throws. A failed heal must not fail the save that triggered it, and the un-healed file
 * still slices, through the slicer's own heal.
 */
async function healMachineTopologyInEntries(
  output: Record<string, Uint8Array>,
  edit: SceneEdit,
  resolveMachine: (machineName: string) => Promise<ProfileRecord | null>
): Promise<void> {
  try {
    const existing = output[THREE_MF_PROJECT_SETTINGS_ENTRY]
    if (!existing || existing.length === 0) return
    let projectSettings: ProfileRecord
    try {
      projectSettings = JSON.parse(new TextDecoder().decode(existing)) as ProfileRecord
    } catch {
      return
    }
    const model = canonicalBambuModelKey(
      firstProfileString(projectSettings.printer_model) ?? firstProfileString(projectSettings.printer_settings_id)
    )
    if (!model || !H2_DUAL_NOZZLE_MODEL_KEYS.has(model)) return
    if (hasDualNozzleMachineShape(projectSettings)) return

    const machineName = firstProfileString(projectSettings.printer_settings_id)
    if (!machineName) return
    const machineConfig = await resolveMachine(machineName)
    if (!machineConfig) return

    const healed = retargetProjectSettingsToMachine(projectSettings, machineConfig, {
      printerSettingsId: machineName,
      printerModel: firstProfileString(machineConfig.printer_model) ?? model
    })
    let healedJson = JSON.stringify(healed)
    if (edit.filaments && edit.filaments.length > 0) {
      healedJson = applyNozzleAssignmentToProjectSettings(healedJson, edit.filaments)
    }
    output[THREE_MF_PROJECT_SETTINGS_ENTRY] = new TextEncoder().encode(healedJson)
    console.warn(`[editor] healed missing ${model} dual-nozzle machine data (re-authored from ${machineName})`)
  } catch (error) {
    console.warn('[editor] dual-nozzle machine heal failed; saving un-healed:',
      error instanceof Error ? error.message : error)
  }
}

/**
 * Per-slot filament overrides, plus how to resolve what each slot's preset holds.
 *
 * `resolveSlotConfigs` answers one config per filament slot, aligned with `filament_settings_id`,
 * and null for a slot that cannot be resolved. They are needed only to fill NON-overridden slots
 * when a written key's column set has to be created from scratch, so a failed resolution degrades
 * to "only keys already present can be written" rather than failing the save.
 */
export interface FilamentOverridesPass {
  /** 1-based SAVED slot position to a sparse filament config, matching the save schema. */
  overrides: Record<string, ProcessConfig>
  resolveSlotConfigs: (projectSettings: ProfileRecord) => Promise<Array<ProcessConfig | null>>
}

/**
 * Apply the material tune dialog's per-slot overrides to the baked archive, in place.
 *
 * Mirrors `persistFilamentSettingOverrides` in the api's `save-filament-overrides.ts`, best-effort
 * for the same reason: the override still rides the slice request either way, so a save must never
 * fail because one could not be persisted into the file.
 */
async function applyFilamentOverridesToEntries(
  output: Record<string, Uint8Array>,
  pass: FilamentOverridesPass
): Promise<void> {
  const byPosition: Record<number, ProcessConfig> = {}
  for (const [key, value] of Object.entries(pass.overrides)) {
    const position = Number(key)
    if (Number.isInteger(position) && position >= 1 && value && Object.keys(value).length > 0) {
      byPosition[position] = value
    }
  }
  if (Object.keys(byPosition).length === 0) return

  const existing = output[THREE_MF_PROJECT_SETTINGS_ENTRY]
  if (!existing || existing.length === 0) return
  let record: ProfileRecord
  try {
    record = JSON.parse(new TextDecoder().decode(existing)) as ProfileRecord
  } catch {
    return
  }

  const slotConfigs = await pass.resolveSlotConfigs(record).catch((error: unknown) => {
    console.warn('[editor] could not resolve filament slot presets; only keys already present were written:',
      error instanceof Error ? error.message : error)
    return [] as Array<ProcessConfig | null>
  })
  const next = applyFilamentSlotOverrides(record, byPosition, slotConfigs)
  if (next === record) return
  output[THREE_MF_PROJECT_SETTINGS_ENTRY] = new TextEncoder().encode(JSON.stringify(next))
}

/**
 * The user's machine overrides, plus how to resolve the preset a RESET restores from.
 *
 * `resolvePreset` is a thunk rather than a value because resolving costs a round trip and the common
 * save needs none: an empty override map over a project that records none is the ordinary case, and
 * it is answered before anything is fetched.
 */
export interface MachineOverridesPass {
  overrides: Record<string, string | string[]>
  resolvePreset: () => Promise<ProfileRecord | null>
}

/**
 * Apply the user's machine-setting overrides to the baked archive, in place.
 *
 * Mirrors `applyMachineOverridesToProject` in the api's `save-retarget.ts`, including its cheap
 * answer: nothing asked for and nothing recorded means nothing to do, decided BEFORE the preset is
 * resolved. The editor sends this map on every save, empty included, because empty is how a reset is
 * expressed, so resolving eagerly would put a round trip on saves that need none.
 *
 * The preset is what a reset restores TO: dropping a key from the record without putting its value
 * back leaves the engine slicing with an override the UI no longer shows.
 */
async function applyMachineOverridesToEntries(
  output: Record<string, Uint8Array>,
  pass: MachineOverridesPass
): Promise<void> {
  const existing = output[THREE_MF_PROJECT_SETTINGS_ENTRY]
  if (!existing || existing.length === 0) {
    if (Object.keys(pass.overrides).length > 0) {
      console.warn('[editor] no embedded project settings; machine overrides were not applied')
    }
    return
  }
  let projectSettings: ProfileRecord
  try {
    projectSettings = JSON.parse(new TextDecoder().decode(existing)) as ProfileRecord
  } catch (error) {
    console.warn('[editor] project settings are unreadable; machine overrides were not applied:',
      error instanceof Error ? error.message : error)
    return
  }

  const machineIndex = machinePresetSlotIndexFor(projectSettings)
  const recordsNothing = machineIndex == null || extractChangedFromSystemKeys(
    projectSettings.different_settings_to_system, machineIndex, () => true
  ).length === 0
  if (Object.keys(pass.overrides).length === 0 && recordsNothing) return

  const presetConfig = await pass.resolvePreset().catch((error: unknown) => {
    console.warn('[editor] could not resolve the machine preset; reset overrides stay recorded:',
      error instanceof Error ? error.message : error)
    return null
  })
  const overridden = applyMachineSettingOverrides(projectSettings, pass.overrides, presetConfig ?? undefined)
  // Unchanged means nothing to write: the project records no overrides and none were asked for.
  if (overridden === projectSettings) return
  output[THREE_MF_PROJECT_SETTINGS_ENTRY] = new TextEncoder().encode(JSON.stringify(overridden))
}

/**
 * Rewrite the baked archive's settings entries for the target machine, in place.
 *
 * A project with no `project_settings.config` (a from-scratch scaffold) is retargeted from an empty
 * object, exactly as the api does: the resolved machine supplies every field, the way BambuStudio
 * picking a printer for a fresh project does. Unreadable settings abort the retarget rather than
 * being replaced: losing the printer switch is recoverable, dropping settings the user's only copy
 * of the file still carries is not.
 */
async function applyMachineRetargetToEntries(
  output: Record<string, Uint8Array>,
  resolvePlan: (projectSettings: ProfileRecord) => Promise<MachineRetargetPlan | null>
): Promise<boolean> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const existing = output[THREE_MF_PROJECT_SETTINGS_ENTRY]
  let projectSettings: ProfileRecord = {}
  if (existing && existing.length > 0) {
    try {
      projectSettings = JSON.parse(decoder.decode(existing)) as ProfileRecord
    } catch (error) {
      // Abort the retarget rather than replacing settings we could not read: see the doc above.
      console.warn('[editor] project settings could not be parsed; saving without the machine retarget:',
        error instanceof Error ? error.message : error)
      return false
    }
  }
  const plan = await resolvePlan(projectSettings)
  if (!plan) return false
  output[THREE_MF_PROJECT_SETTINGS_ENTRY] = encoder.encode(
    JSON.stringify(applyMachineRetargetToProjectSettings(projectSettings, plan))
  )
  const sliceInfo = output[THREE_MF_SLICE_INFO_ENTRY]
  if (sliceInfo && sliceInfo.length > 0) {
    output[THREE_MF_SLICE_INFO_ENTRY] = encoder.encode(stripSliceInfoPrinterModelId(decoder.decode(sliceInfo)))
  }
  return true
}
