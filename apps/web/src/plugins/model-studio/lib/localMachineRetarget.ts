/**
 * "Save this project for a different printer", for the host with no server behind it.
 *
 * The DECISIONS are not here: what a machine retarget rewrites lives in
 * `@printstream/shared/machine-retarget` (`applyMachineRetargetToProjectSettings`) and which preset
 * each filament slot rebinds to in `selectFilamentRebindTargets`, both of which the api's
 * `save-retarget.ts` runs for the workspace editor. This module only RESOLVES the inputs those
 * functions need, from what an anonymous browser can reach: `/api/public/slicing/resolve-machine`,
 * `-process`, and `-filament`, which serve BambuStudio's bundled presets out of the slicer image.
 *
 * That server hop is the one part that cannot move into the tab — the preset bodies are the
 * slicer's own data, not the user's file. Everything after it (the settings rewrite, the ZIP) runs
 * locally, so the project still never leaves the machine.
 *
 * Best-effort by design, matching the api: a plan that cannot be built returns null and the save
 * proceeds un-retargeted rather than failing, and an individual slot or the process preset failing
 * to resolve degrades that part only. The one hard requirement is the machine config — without it
 * there is nothing to retarget TO.
 *
 * Counterpart: `apps/api/src/lib/save-retarget.ts` (the workspace host).
 */
import {
  canonicalBambuModelKey,
  parseBuiltinSlicingPresetId,
  selectFilamentRebindTargets,
  slicingPresetProvenance,
  type FilamentSlotRebind,
  type MachineRetargetPlan,
  type ProfileRecord,
  type ResolveFilamentConfigResponse,
  type ResolveProcessConfigResponse,
  type SlicingManualProfileTarget,
  type SlicingPresetSummary
} from '@printstream/shared'
import { retargetProjectSettingsToMachine } from '@printstream/shared'
import { apiFetch } from '../../../lib/apiClient'

interface ResolveMachineConfigResponse {
  config: ProfileRecord
  /** The resolved preset's own name, persisted as `printer_settings_id`. */
  name: string
}

export interface LocalMachineRetargetInput {
  /** The editor's current target — the controller's `retargetTarget`. Null means nothing to do. */
  target: SlicingManualProfileTarget | null
  slicerTargetId: string
  /**
   * The project's settings as the bake will write them, used ONLY to pick filament rebind targets.
   * Null skips the rebind pass (the slots keep their values), which is what an unreadable or absent
   * `project_settings.config` means.
   */
  projectSettings: ProfileRecord | null
  /** The catalogue the rebind picks from — built-ins plus the user's browser-stored presets. */
  filamentPresets: readonly SlicingPresetSummary[]
}

/**
 * Resolve everything a retarget needs, or null when this save should not retarget at all.
 *
 * Null is returned for a target with no built-in machine preset behind it: a project preset or a
 * workspace custom cannot be resolved anonymously, and authoring a partial machine is worse than
 * leaving the project on its embedded one.
 */
export async function buildLocalMachineRetargetPlan(input: LocalMachineRetargetInput): Promise<MachineRetargetPlan | null> {
  const { target } = input
  if (!target || slicingPresetProvenance(target.printerProfileId) !== 'builtin') return null

  let machine: ResolveMachineConfigResponse
  try {
    machine = await apiFetch<ResolveMachineConfigResponse>('/api/public/slicing/resolve-machine', {
      method: 'POST',
      body: { machineProfileId: target.printerProfileId, targetId: input.slicerTargetId }
    })
  } catch (error) {
    // The one failure the user can SEE the consequence of: the save proceeds and silently keeps the
    // project's embedded printer, so leave a trace of why the switch did not stick.
    console.warn('[editor] could not resolve the target printer preset; saving without the machine retarget:',
      error instanceof Error ? error.message : error)
    return null
  }
  const printerModel = firstString(machine.config.printer_model) ?? deriveModelFromMachineName(machine.name)

  const plan: MachineRetargetPlan = {
    machineConfig: machine.config,
    printerSettingsId: machine.name,
    printerModel,
    processConfig: await resolveTargetProcessConfig(target, input.slicerTargetId),
    processSettingOverrides: target.processSettingOverrides ?? {},
    filamentRebinds: null
  }
  return {
    ...plan,
    filamentRebinds: await resolveFilamentRebinds(input, plan)
  }
}

/**
 * The target printer's process preset, or null to keep the project's embedded one.
 *
 * Mirrors the api's rule exactly: a PROJECT preset has no separate file to resolve (its values are
 * already in the 3MF) and a workspace custom does not exist here, so both fall through to null and
 * the machine retarget proceeds without them.
 */
async function resolveTargetProcessConfig(
  target: SlicingManualProfileTarget,
  slicerTargetId: string
): Promise<ProfileRecord | null> {
  if (!target.processProfileId || slicingPresetProvenance(target.processProfileId) !== 'builtin') return null
  try {
    const body = await apiFetch<ResolveProcessConfigResponse>('/api/public/slicing/resolve-process', {
      method: 'POST',
      body: { processProfileId: target.processProfileId, targetId: slicerTargetId }
    })
    return body.config
  } catch (error) {
    // Best-effort by contract: the project keeps its embedded process rather than blocking the
    // machine retarget, which is the part that makes it openable on the new printer.
    console.warn('[editor] could not resolve the target process preset; keeping the project\'s own:',
      error instanceof Error ? error.message : error)
    return null
  }
}

/**
 * Where each filament slot lands on the new machine, with each chosen preset's config resolved.
 *
 * The slot list is read from the MACHINE-retargeted settings, not the project's current ones: the
 * retarget rebuilds the filament variant layout for the new machine, and picking against the old
 * one is what would mis-column the result. Only built-in targets resolve — a browser-stored preset
 * is an unflattened BambuStudio document, and flattening it needs the slicer.
 */
async function resolveFilamentRebinds(
  input: LocalMachineRetargetInput,
  plan: MachineRetargetPlan
): Promise<FilamentSlotRebind[] | null> {
  if (!input.projectSettings) return null
  const targetModelKey = canonicalBambuModelKey(plan.printerModel)
  if (!targetModelKey) return null
  const machineRetargeted = retargetProjectSettingsToMachine(input.projectSettings, plan.machineConfig, {
    printerSettingsId: plan.printerSettingsId,
    printerModel: plan.printerModel
  })
  const selections = selectFilamentRebindTargets({
    filamentSettingsIds: machineRetargeted.filament_settings_id,
    candidates: input.filamentPresets.filter((preset) => preset.kind === 'filament'),
    targetModelKey,
    nozzleHint: plan.printerSettingsId
  })
  if (!selections) return null

  const rebinds: FilamentSlotRebind[] = []
  for (const { slotName, target } of selections) {
    const name = target && slicingPresetProvenance(target.id) === 'builtin'
      ? parseBuiltinSlicingPresetId(target.id)?.name ?? null
      : null
    if (!target || !name) {
      rebinds.push({ config: null })
      continue
    }
    let config: ResolveFilamentConfigResponse['config'] | null = null
    try {
      const body = await apiFetch<ResolveFilamentConfigResponse>('/api/public/slicing/resolve-filament', {
        method: 'POST',
        body: { filamentProfileId: target.id, targetId: input.slicerTargetId }
      })
      config = body.config
    } catch (error) {
      // Per-slot best effort: an unresolvable slot keeps its current values. Warned rather than
      // silent because a slot that fails to rebind leaves the OLD machine's numbers behind.
      console.warn(`[editor] could not resolve the rebind preset for filament slot "${slotName}":`,
        error instanceof Error ? error.message : error)
      config = null
    }
    rebinds.push({ config, settingsId: config && target.name !== slotName ? target.name : null })
  }
  return rebinds.some((rebind) => rebind.config != null || rebind.settingsId != null) ? rebinds : null
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string' && entry.trim())
    return typeof first === 'string' ? first.trim() : null
  }
  return null
}

/** Fallback printer_model from a machine preset name, dropping its nozzle-size suffix. */
function deriveModelFromMachineName(name: string): string {
  return name.replace(/\s+\d+(?:\.\d+)?\s*nozzle.*$/i, '').trim() || name
}
