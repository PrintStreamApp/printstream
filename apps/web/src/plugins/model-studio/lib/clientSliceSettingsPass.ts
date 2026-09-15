/**
 * Authors the exact slice target into a browser-baked project before it is staged.
 *
 * This is deliberately separate from the editor SAVE passes. A save preserves an unchanged
 * project's embedded process and machine values; a slice must instead make the staged project
 * describe the exact presets and overrides the engine is about to use. Preset resolution may
 * still call the API because the catalogue belongs to the selected slicer image, but all 3MF
 * mutation happens here in the tab.
 */
import {
  applyFilamentSlotOverrides,
  applyMachineSettingOverrides,
  applyProcessProfileToProjectSettings,
  canonicalCurrBedType,
  firstProfileString,
  parseBuiltinSlicingPresetId,
  rebindProjectFilamentPhysics,
  retargetProjectSettingsToMachine,
  slicingPresetProvenance,
  stripSliceInfoPrinterModelId,
  type ProcessConfig,
  type ProfileRecord,
  type SceneEdit,
  type SlicingTarget
} from '@printstream/shared'
import {
  applyGlobalProcessOverrides,
  applyManualFilamentMapToModelSettings,
  applyNozzleAssignmentToProjectSettings,
  buildManualNozzleAssignment,
  clearManualFilamentMapFromModelSettings,
  clearManualFilamentMapFromProjectSettings,
  stripSliceInfoNozzleGroupIds,
  THREE_MF_MODEL_SETTINGS_ENTRY,
  THREE_MF_PROJECT_SETTINGS_ENTRY,
  THREE_MF_SLICE_INFO_ENTRY
} from '@printstream/shared/three-mf'
import type { RetargetResolvers } from './browserMachineRetarget'

export interface ClientSliceSettingsPass {
  target: SlicingTarget
  slicerTargetId: string | null
  resolvers: RetargetResolvers
  signal?: AbortSignal
}

/** Apply a frozen slice target to an already-baked archive entry map. */
export async function applyClientSliceSettings(
  output: Record<string, Uint8Array>,
  edit: SceneEdit,
  pass: ClientSliceSettingsPass
): Promise<void> {
  pass.signal?.throwIfAborted()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const existing = output[THREE_MF_PROJECT_SETTINGS_ENTRY]
  let settings: ProfileRecord = {}
  if (existing?.length) {
    settings = JSON.parse(decoder.decode(existing)) as ProfileRecord
  }

  const machineProfileId = pass.target.printerProfileId
  if (!machineProfileId || !pass.resolvers.canResolve(machineProfileId)) {
    throw new Error('The selected printer preset could not be prepared for slicing.')
  }
  const machine = await pass.resolvers.machine(machineProfileId, pass.slicerTargetId, { signal: pass.signal })
  pass.signal?.throwIfAborted()
  settings = retargetProjectSettingsToMachine(settings, machine.config, {
    printerSettingsId: machine.name,
    printerModel: firstProfileString(machine.config.printer_model)
      ?? (pass.target.mode === 'manualProfile' ? pass.target.printerModel : machine.name),
    printerPresetInherits: slicingPresetProvenance(machineProfileId) === 'workspace'
      ? firstProfileString(machine.config.inherits)
      : null
  })

  const processProfileId = pass.target.processProfileId
  if (processProfileId && pass.resolvers.canResolve(processProfileId)) {
    const process = await pass.resolvers.process(processProfileId, pass.slicerTargetId, { signal: pass.signal })
    pass.signal?.throwIfAborted()
    settings = applyProcessProfileToProjectSettings(
      settings,
      process.config,
      pass.target.processSettingOverrides ?? {}
    )
  } else if (pass.target.processSettingOverrides) {
    settings = parseSettings(applyGlobalProcessOverrides(
      JSON.stringify(settings),
      pass.target.processSettingOverrides
    ))
  }

  settings = applyMachineSettingOverrides(
    settings,
    pass.target.machineSettingOverrides ?? {},
    machine.config
  )
  settings = await applyFilamentTarget(settings, edit, pass)

  const plateType = canonicalCurrBedType(pass.target.plateType ?? null)
  if (plateType) settings.curr_bed_type = plateType

  // The machine pass rebuilds topology after the ordinary scene bake wrote the material mapping.
  // Re-apply the final assignment now, against the target machine's physical-extruder map.
  const targetFilaments = filamentsWithTargetNozzles(edit, pass.target.filamentMappings ?? [])
  settings = parseSettings(applyNozzleAssignmentToProjectSettings(JSON.stringify(settings), targetFilaments))
  const manualNozzle = buildManualNozzleAssignment(settings, pass.target.filamentMappings ?? [])
  const modelSettings = output[THREE_MF_MODEL_SETTINGS_ENTRY]
  if (manualNozzle) {
    settings.filament_map_mode = manualNozzle.filament_map_mode
    settings.filament_map = manualNozzle.filament_map
    if (modelSettings?.length) {
      output[THREE_MF_MODEL_SETTINGS_ENTRY] = encoder.encode(
        applyManualFilamentMapToModelSettings(decoder.decode(modelSettings), manualNozzle.filament_map.join(' '))
      )
    }
  } else {
    // Retargeting from a dual-nozzle/manual project to automatic routing or a single-nozzle
    // machine must not carry the old assignment into the engine under the new target.
    settings = clearManualFilamentMapFromProjectSettings(settings)
    if (modelSettings?.length) {
      output[THREE_MF_MODEL_SETTINGS_ENTRY] = encoder.encode(
        clearManualFilamentMapFromModelSettings(decoder.decode(modelSettings))
      )
    }
  }
  output[THREE_MF_PROJECT_SETTINGS_ENTRY] = encoder.encode(JSON.stringify(settings))

  const sliceInfo = output[THREE_MF_SLICE_INFO_ENTRY]
  if (sliceInfo?.length) {
    output[THREE_MF_SLICE_INFO_ENTRY] = encoder.encode(stripSliceInfoPrinterModelId(
      stripSliceInfoNozzleGroupIds(decoder.decode(sliceInfo))
    ))
  }
}

function filamentsWithTargetNozzles(
  edit: SceneEdit,
  mappings: SlicingTarget['filamentMappings']
): NonNullable<SceneEdit['filaments']> {
  const filaments = (edit.filaments ?? []).map((filament) => ({ ...filament }))
  for (const mapping of mappings ?? []) {
    const match = mapping.toolheadId?.match(/^nozzle-(\d+)$/)
    const nozzleId = Number.parseInt(match?.[1] ?? '', 10)
    const index = mapping.projectFilamentId - 1
    if (index < 0 || !Number.isInteger(nozzleId) || !filaments[index]) continue
    filaments[index] = { ...filaments[index]!, nozzleId }
  }
  return filaments
}

async function applyFilamentTarget(
  settings: ProfileRecord,
  edit: SceneEdit,
  pass: ClientSliceSettingsPass
): Promise<ProfileRecord> {
  const mappings = pass.target.filamentMappings ?? []
  if (mappings.length === 0) return settings

  const slotCount = Math.max(...mappings.map((mapping) => mapping.projectFilamentId))
  const configs: Array<ProcessConfig | null> = new Array(slotCount).fill(null)
  const rebinds: Array<{ config: ProcessConfig | null; settingsId?: string | null }> = new Array(slotCount)
    .fill(null)
    .map(() => ({ config: null }))
  const slotOverrides: Record<number, ProcessConfig> = {}

  await Promise.all(mappings.map(async (mapping) => {
    const index = mapping.projectFilamentId - 1
    if (index < 0) return
    const profileId = mapping.profileId
    if (profileId && pass.resolvers.canResolve(profileId)) {
      const resolved = await pass.resolvers.filament(profileId, pass.slicerTargetId, { signal: pass.signal })
      pass.signal?.throwIfAborted()
      const config = resolved.config as ProcessConfig
      const settingsId = firstProfileString(config.name)
        ?? firstProfileString(config.filament_settings_id)
        ?? parseBuiltinSlicingPresetId(profileId)?.name
        ?? edit.filaments?.[index]?.settingsId
        ?? null
      configs[index] = config
      rebinds[index] = { config, settingsId }
    }
    const merged: ProcessConfig = {
      ...(pass.target.filamentSettingOverrides ?? {}),
      ...(mapping.settingOverrides ?? {})
    }
    if (Object.keys(merged).length > 0) slotOverrides[mapping.projectFilamentId] = merged
  }))
  pass.signal?.throwIfAborted()

  let next = settings
  if (rebinds.some((rebind) => rebind.config !== null)) {
    next = rebindProjectFilamentPhysics(next, rebinds)
  }
  if (Object.keys(slotOverrides).length > 0) {
    next = applyFilamentSlotOverrides(next, slotOverrides, configs)
  }
  return next
}

function parseSettings(json: string): ProfileRecord {
  return JSON.parse(json) as ProfileRecord
}
