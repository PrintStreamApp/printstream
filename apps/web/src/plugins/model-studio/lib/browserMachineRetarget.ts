/**
 * "Save this project for a different printer", run in the BROWSER, for either host.
 *
 * The DECISIONS are not here: what a machine retarget rewrites lives in
 * `@printstream/shared/machine-retarget` (`applyMachineRetargetToProjectSettings`) and which preset
 * each filament slot rebinds to in `selectFilamentRebindTargets`, both of which the api's
 * `save-retarget.ts` runs for the workspace editor. This module only RESOLVES the inputs those
 * functions need, from what an anonymous browser can reach: `/api/public/slicing/resolve-machine`,
 * `-process`, and `-filament`, which serve BambuStudio's bundled presets out of the slicer image.
 *
 * That server hop is the one part that cannot move into the tab: the preset bodies are the
 * slicer's own data, not the user's file. Everything after it (the settings rewrite, the ZIP) runs
 * locally, so on the public host the project still never leaves the machine.
 *
 * WHICH presets a host can resolve is the only difference between the two, and it is carried by the
 * {@link RetargetResolvers} rather than hard-coded here. The anonymous endpoints serve BambuStudio's
 * bundled presets and refuse anything else, so the public host declines a retarget onto a custom
 * preset; the workspace endpoints resolve the workspace's own presets too, so it does not. Writing
 * that rule inline is what would keep this module public-only.
 *
 * Best-effort by design, matching the api: a plan that cannot be built returns null and the save
 * proceeds un-retargeted rather than failing, and an individual slot or the process preset failing
 * to resolve degrades that part only. The one hard requirement is the machine config, without it
 * there is nothing to retarget TO.
 *
 * Counterpart: `apps/api/src/lib/save-retarget.ts`, which ran this for the workspace host while its
 * bake was server-side.
 */
import {
  buildBuiltinSlicingPresetId,
  canonicalBambuModelKey,
  parseBuiltinSlicingPresetId,
  resolveRetargetProcessFallback,
  selectFilamentRebindTargets,
  processPresetFitsMachine,
  slicingPresetProvenance,
  type FilamentSlotRebind,
  type MachineRetargetPlan,
  type ProfileRecord,
  type ResolveFilamentConfigResponse,
  type ResolveProcessConfigResponse,
  type SlicingManualProfileTarget,
  type SlicingPresetSummary,
  firstProfileString
} from '@printstream/shared'
import { retargetProjectSettingsToMachine } from '@printstream/shared'
import { apiFetch } from '../../../lib/apiClient'
import { resolveWorkspaceMachineConfig } from '../../../components/workspaceMachineResolver'
import { resolveWorkspaceProcessConfig } from '../../../components/workspaceProcessResolver'
import { resolveWorkspaceFilamentConfig } from '../../../components/library/workspaceFilamentResolver'
import { listLocalSlicingPresets } from './localSlicingPresets'
import { flattenLocalPreset } from './localPresetInheritance'

interface ResolveMachineConfigResponse {
  config: ProfileRecord
  /** The resolved preset's own name, persisted as `printer_settings_id`. */
  name: string
}

/**
 * The three anonymous preset lookups this module needs, injected so the retarget's DECISIONS can be
 * exercised without a server, the same seam shape as `localFilamentResolver`'s `resolveBuiltin`.
 * {@link PUBLIC_RETARGET_RESOLVERS} is the real one and the default; nothing in the app passes
 * anything else.
 */
export interface RetargetResolvers {
  machine(profileId: string, targetId: string | null, options?: { signal?: AbortSignal }): Promise<ResolveMachineConfigResponse>
  process(profileId: string, targetId: string | null, options?: { signal?: AbortSignal }): Promise<ResolveProcessConfigResponse>
  filament(profileId: string, targetId: string | null, options?: { signal?: AbortSignal }): Promise<ResolveFilamentConfigResponse>
  /**
   * Whether these endpoints can resolve the named preset at all.
   *
   * Asked BEFORE resolving, because the alternative is authoring a partial machine from a failed
   * lookup, which is worse than leaving the project on the printer it already names.
   */
  canResolve(presetId: string): boolean
}

/** The anonymous catalogue endpoints. Built-ins only: see the module header. */
export const PUBLIC_RETARGET_RESOLVERS: RetargetResolvers = {
  canResolve: (presetId) => slicingPresetProvenance(presetId) === 'builtin',
  machine: (machineProfileId, targetId, options) =>
    apiFetch<ResolveMachineConfigResponse>('/api/public/slicing/resolve-machine', {
      method: 'POST',
      body: { machineProfileId, targetId },
      ...(options?.signal ? { signal: options.signal } : {})
    }),
  process: (processProfileId, targetId, options) =>
    apiFetch<ResolveProcessConfigResponse>('/api/public/slicing/resolve-process', {
      method: 'POST',
      body: { processProfileId, targetId },
      ...(options?.signal ? { signal: options.signal } : {})
    }),
  filament: (filamentProfileId, targetId, options) =>
    apiFetch<ResolveFilamentConfigResponse>('/api/public/slicing/resolve-filament', {
      method: 'POST',
      body: { filamentProfileId, targetId },
      ...(options?.signal ? { signal: options.signal } : {})
    })
}

/**
 * The workspace catalogue endpoints, which resolve the workspace's own presets as well as the
 * built-ins. Same request shapes as the anonymous twins, and `resolve-machine` answers `name` for
 * the same reason: a custom preset's name cannot be derived from its id.
 *
 * A `project:` preset is refused here as it is there. It lives inside the 3MF being saved, so
 * "retarget onto it" is not a question with an answer. (`workspace` is what a `custom:` id parses
 * to; there is no `custom` provenance.)
 */
export const WORKSPACE_RETARGET_RESOLVERS: RetargetResolvers = {
  canResolve: (presetId) => {
    const provenance = slicingPresetProvenance(presetId)
    return provenance === 'builtin' || provenance === 'workspace'
  },
  // Through the OWNER module of each route rather than fetching here: three modules had each
  // declared their own response type, every one a valid supertype of the real one, so fields the
  // routes grew went missing with nothing to catch it (`workspaceResolvers.test.ts`).
  machine: (machineProfileId, targetId, options) => resolveWorkspaceMachineConfig({ machineProfileId, targetId }, options),
  // No `sourceFileId`: a retarget resolves the preset as it stands in the catalogue. Passing the
  // project would fold the file's own deltas into the config being retargeted ONTO, which is the
  // thing being replaced.
  process: (processProfileId, targetId, options) =>
    resolveWorkspaceProcessConfig({ processProfileId, targetId, sourceFileId: null }, options),
  filament: (filamentProfileId, targetId, options) =>
    resolveWorkspaceFilamentConfig({ filamentProfileId, targetId, sourceFileId: null, projectFilamentId: null }, options)
}

export interface MachineRetargetInput {
  /** The editor's current target: the controller's `retargetTarget`. Null means nothing to do. */
  target: SlicingManualProfileTarget | null
  /**
   * Which slicer build to resolve the presets from. NULL, never `''`, while the targets query is
   * unsettled: the routes take a nullable `targetId` and fall back to the default build, but they
   * REJECT an empty string, which 400s the whole retarget and saves the project on its OLD printer
   * with only a console warning.
   */
  slicerTargetId: string | null
  /**
   * The project's settings as the bake will write them. Two passes read it: the filament rebind
   * picks its targets from the slot list, and the process fallback reads the process preset's
   * lineage. Null skips both (the slots and the process keep their values), which is what an
   * unreadable or absent `project_settings.config` means.
   */
  projectSettings: ProfileRecord | null
  /** The catalogue the rebind picks from: built-ins plus the user's browser-stored presets. */
  filamentPresets: readonly SlicingPresetSummary[]
  /** Defaults to the anonymous endpoints; overridden only by tests. */
  resolvers?: RetargetResolvers
  /** Cancels all preset resolution started for this retarget. */
  signal?: AbortSignal
}

/** Best-effort retargeting degrades ordinary lookup failures, but never cancellation. */
function rethrowCancellation(error: unknown, signal?: AbortSignal): void {
  signal?.throwIfAborted()
  if (error instanceof Error && error.name === 'AbortError') throw error
}

/**
 * Resolve everything a retarget needs, or null when this save should not retarget at all.
 *
 * Null is returned for a target with no built-in machine preset behind it: a project preset or a
 * workspace custom cannot be resolved anonymously, and authoring a partial machine is worse than
 * leaving the project on its embedded one.
 */
export async function buildMachineRetargetPlan(input: MachineRetargetInput): Promise<MachineRetargetPlan | null> {
  input.signal?.throwIfAborted()
  const { target } = input
  const resolvers = input.resolvers ?? PUBLIC_RETARGET_RESOLVERS
  if (!target || !resolvers.canResolve(target.printerProfileId)) return null

  let machine: ResolveMachineConfigResponse
  try {
    machine = await resolvers.machine(
      target.printerProfileId,
      input.slicerTargetId,
      input.signal ? { signal: input.signal } : undefined
    )
  } catch (error) {
    rethrowCancellation(error, input.signal)
    // The one failure the user can SEE the consequence of: the save proceeds and silently keeps the
    // project's embedded printer, so leave a trace of why the switch did not stick.
    console.warn('[editor] could not resolve the target printer preset; saving without the machine retarget:',
      error instanceof Error ? error.message : error)
    return null
  }
  const printerModel = firstProfileString(machine.config.printer_model) ?? deriveModelFromMachineName(machine.name)

  const chosenProcess = await resolveTargetProcessConfig(
    target,
    input.slicerTargetId,
    resolvers,
    machine.name,
    input.signal
  )
  const plan: MachineRetargetPlan = {
    machineConfig: machine.config,
    printerSettingsId: machine.name,
    printerModel,
    // Nothing chosen leaves the project's OWN process, which is right only while that process still
    // fits the machine being authored. When it does not, this is where BambuStudio would have
    // reselected, so it is where we do.
    processConfig: chosenProcess ?? await resolveProcessFallbackForMachine(input, resolvers, machine),
    processSettingOverrides: target.processSettingOverrides ?? {},
    machineSettingOverrides: target.machineSettingOverrides ?? {},
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
  resolvers: RetargetResolvers,
  machinePresetName: string,
  signal?: AbortSignal
): Promise<ProfileRecord | null> {
  if (!target.processProfileId || !resolvers.canResolve(target.processProfileId)) return null
  try {
    const body = await resolvers.process(
      target.processProfileId,
      slicerTargetId,
      signal ? { signal } : undefined
    )
    // A process the target machine does not accept is not authored: the retarget's job is to make
    // the project openable on the new printer, and writing settings that machine refuses does the
    // opposite. Null leaves the project's embedded process, which is this function's own contract.
    if (!processPresetFitsMachine(body.config ?? null, machinePresetName)) {
      console.warn(`[editor] the chosen process preset does not fit ${machinePresetName}; keeping the project's`)
      return null
    }
    return body.config
  } catch (error) {
    rethrowCancellation(error, signal)
    // Best-effort by contract: the project keeps its embedded process rather than blocking the
    // machine retarget, which is the part that makes it openable on the new printer.
    console.warn('[editor] could not resolve the target process preset; keeping the project\'s own:',
      error instanceof Error ? error.message : error)
    return null
  }
}

/**
 * The process preset to write when the save chose none and the project's own was authored for a
 * different machine: BambuStudio's printer-switch reselect, whose rule lives in
 * {@link resolveRetargetProcessFallback}.
 *
 * Only reached with no process chosen, which is exactly the case the retarget used to leave broken:
 * a `project:` preset resolves to nothing here, so the machine was rewritten while the project kept
 * a process the new printer refuses, and the file could not be sliced by the printer it named.
 */
async function resolveProcessFallbackForMachine(
  input: MachineRetargetInput,
  resolvers: RetargetResolvers,
  machine: ResolveMachineConfigResponse
): Promise<ProfileRecord | null> {
  if (!input.projectSettings) return null
  return resolveRetargetProcessFallback({
    projectSettings: input.projectSettings,
    machineConfig: machine.config,
    printerSettingsId: machine.name,
    resolveSystemProcess: (name) => resolveBuiltinProcessByName(name, input.slicerTargetId, resolvers, input.signal),
    log: (message) => console.warn(`[editor] ${message}`)
  })
}

/**
 * A BUILT-IN process preset by name, or null.
 *
 * Deliberately silent on a miss: `inherits_group[0]` can name a preset this catalogue has never
 * heard of (a preset from the user's own BambuStudio install, or one from a newer engine), and that
 * is an ordinary answer rather than a failure. The DECISION that consumes it logs both of its
 * outcomes, so the retarget stays observable without a warning per lookup.
 */
async function resolveBuiltinProcessByName(
  name: string,
  slicerTargetId: string | null,
  resolvers: RetargetResolvers,
  signal?: AbortSignal
): Promise<ProfileRecord | null> {
  const presetId = buildBuiltinSlicingPresetId('process', name)
  if (!resolvers.canResolve(presetId)) return null
  try {
    return (await resolvers.process(presetId, slicerTargetId, signal ? { signal } : undefined)).config ?? null
  } catch (error) {
    rethrowCancellation(error, signal)
    return null
  }
}

/**
 * Where each filament slot lands on the machine this plan authors.
 *
 * Exported because a SAME-MODEL preset change needs it too. BambuStudio re-picks every slot on any
 * printer-preset switch, and a nozzle change IS one there (the nozzle is the printer VARIANT, so
 * "A1 0.2 nozzle" and "A1 0.4 nozzle" are different presets). Its compatibility test is a literal
 * `compatible_printers` name list, and a 0.2-nozzle filament preset lists only the 0.2 machine, so
 * leaving the slot alone across a nozzle change leaves it on a preset Studio itself calls
 * incompatible (`PresetBundle.cpp:5769-5777`, alias match at `:5719-5721`).
 *
 * The slot list is read from the MACHINE-retargeted settings, not the project's current ones: the
 * retarget rebuilds the filament variant layout for the new machine, and picking against the old
 * one is what would mis-column the result.
 *
 * BOTH kinds of target resolve to a config. A built-in comes back flattened from the host's
 * resolver; a browser-stored preset is an unflattened BambuStudio document, which
 * `flattenLocalPreset` resolves by walking its `inherits` chain and asking the host only for the
 * built-in ancestors. That path supplies a config with NO `settingsId`, because the slot keeps the
 * name it already has, which is why {@link rebindProjectFilamentPhysics} writes `filament_type`
 * only for a slot it also renames.
 */
export async function resolveFilamentRebinds(
  input: MachineRetargetInput,
  plan: MachineRetargetPlan,
  resolvers: RetargetResolvers
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
    // `rebindProjectFilamentPhysics` DROP the key for every slot, so retargeting a project whose
    // third material is an uploaded preset deleted the physics the repair had just restored, and the
    // file reopened still flagged. That is the same blind spot fixed in `localFilamentResolver`.
    const stored = target ? listLocalSlicingPresets().find((preset) => preset.id === target.id && preset.kind === 'filament') : undefined
    if (stored) {
      // Flattened onto its parent, same as the resolver, a delta preset would otherwise rebind the
      // slot to a near-empty config, and `rebindProjectFilamentPhysics` drops every key no slot
      // defines, deleting the physics a repair had just restored.
      const flattened = await flattenLocalPreset(stored, [], async (builtinId) => {
        const body = await resolvers.filament(
          builtinId,
          input.slicerTargetId,
          input.signal ? { signal: input.signal } : undefined
        )
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
      const body = await resolvers.filament(
        target.id,
        input.slicerTargetId,
        input.signal ? { signal: input.signal } : undefined
      )
      config = body.config
    } catch (error) {
      rethrowCancellation(error, input.signal)
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

/** Fallback printer_model from a machine preset name, dropping its nozzle-size suffix. */
function deriveModelFromMachineName(name: string): string {
  return name.replace(/\s+\d+(?:\.\d+)?\s*nozzle.*$/i, '').trim() || name
}
