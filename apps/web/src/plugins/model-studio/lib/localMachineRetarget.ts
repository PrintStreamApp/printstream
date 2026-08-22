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
import { listLocalSlicingPresets } from './localSlicingPresets'
import { flattenLocalPreset } from './localPresetInheritance'

interface ResolveMachineConfigResponse {
  config: ProfileRecord
  /** The resolved preset's own name, persisted as `printer_settings_id`. */
  name: string
}

/**
 * The three anonymous preset lookups this module needs, injected so the retarget's DECISIONS can be
 * exercised without a server — the same seam shape as `localFilamentResolver`'s `resolveBuiltin`.
 * {@link PUBLIC_RETARGET_RESOLVERS} is the real one and the default; nothing in the app passes
 * anything else.
 */
export interface LocalRetargetResolvers {
  machine(profileId: string, targetId: string | null): Promise<ResolveMachineConfigResponse>
  process(profileId: string, targetId: string | null): Promise<ResolveProcessConfigResponse>
  filament(profileId: string, targetId: string | null): Promise<ResolveFilamentConfigResponse>
}

/** The anonymous catalogue endpoints. Built-ins only — see the module header. */
export const PUBLIC_RETARGET_RESOLVERS: LocalRetargetResolvers = {
  machine: (machineProfileId, targetId) =>
    apiFetch<ResolveMachineConfigResponse>('/api/public/slicing/resolve-machine', {
      method: 'POST',
      body: { machineProfileId, targetId }
    }),
  process: (processProfileId, targetId) =>
    apiFetch<ResolveProcessConfigResponse>('/api/public/slicing/resolve-process', {
      method: 'POST',
      body: { processProfileId, targetId }
    }),
  filament: (filamentProfileId, targetId) =>
    apiFetch<ResolveFilamentConfigResponse>('/api/public/slicing/resolve-filament', {
      method: 'POST',
      body: { filamentProfileId, targetId }
    })
}

export interface LocalMachineRetargetInput {
  /** The editor's current target — the controller's `retargetTarget`. Null means nothing to do. */
  target: SlicingManualProfileTarget | null
  /**
   * Which slicer build to resolve the presets from. NULL — never `''` — while the targets query is
   * unsettled: the routes take a nullable `targetId` and fall back to the default build, but they
   * REJECT an empty string, which 400s the whole retarget and saves the project on its OLD printer
   * with only a console warning.
   */
  slicerTargetId: string | null
  /**
   * The project's settings as the bake will write them, used ONLY to pick filament rebind targets.
   * Null skips the rebind pass (the slots keep their values), which is what an unreadable or absent
   * `project_settings.config` means.
   */
  projectSettings: ProfileRecord | null
  /** The catalogue the rebind picks from — built-ins plus the user's browser-stored presets. */
  filamentPresets: readonly SlicingPresetSummary[]
  /** Defaults to the anonymous endpoints; overridden only by tests. */
  resolvers?: LocalRetargetResolvers
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
  const resolvers = input.resolvers ?? PUBLIC_RETARGET_RESOLVERS
  if (!target || slicingPresetProvenance(target.printerProfileId) !== 'builtin') return null

  let machine: ResolveMachineConfigResponse
  try {
    machine = await resolvers.machine(target.printerProfileId, input.slicerTargetId)
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
    processConfig: await resolveTargetProcessConfig(target, input.slicerTargetId, resolvers),
    processSettingOverrides: target.processSettingOverrides ?? {},
    filamentRebinds: null
  }
  return {
    ...plan,
    filamentRebinds: await resolveFilamentRebinds(input, plan, resolvers)
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
  slicerTargetId: string | null,
  resolvers: LocalRetargetResolvers
): Promise<ProfileRecord | null> {
  if (!target.processProfileId || slicingPresetProvenance(target.processProfileId) !== 'builtin') return null
  try {
    const body = await resolvers.process(target.processProfileId, slicerTargetId)
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
  plan: MachineRetargetPlan,
  resolvers: LocalRetargetResolvers
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
    // A preset the user uploaded into THIS BROWSER resolves from that store, not the builtin
    // endpoint. Without this it fell to `config: null`, and a null slot makes
    // `rebindProjectFilamentPhysics` DROP the key for every slot — so retargeting a project whose
    // third material is an uploaded preset deleted the physics the repair had just restored, and the
    // file reopened still flagged. That is the same blind spot fixed in `localFilamentResolver`.
    const stored = target ? listLocalSlicingPresets().find((preset) => preset.id === target.id && preset.kind === 'filament') : undefined
    if (stored) {
      // Flattened onto its parent, same as the resolver — a delta preset would otherwise rebind the
      // slot to a near-empty config, and `rebindProjectFilamentPhysics` drops every key no slot
      // defines, deleting the physics a repair had just restored.
      const flattened = await flattenLocalPreset(stored, [], async (builtinId) => {
        const body = await resolvers.filament(builtinId, input.slicerTargetId)
        return body.config ?? null
      })
      rebinds.push({ config: flattened.config, settingsId: null })
      continue
    }
    if (!target || !name) {
      rebinds.push({ config: null })
      continue
    }
    let config: ResolveFilamentConfigResponse['config'] | null = null
    try {
      const body = await resolvers.filament(target.id, input.slicerTargetId)
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
