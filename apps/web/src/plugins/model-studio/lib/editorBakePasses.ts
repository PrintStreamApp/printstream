/**
 * Turning a save REQUEST into the bake's options and its post-bake settings passes.
 *
 * One place, because both hosts bake in the browser now and the api used to run these passes for
 * the workspace one. They differ only in which presets they can RESOLVE, which arrives as
 * {@link RetargetResolvers}; everything about which passes run, and in what order, is the same
 * question on both and belongs here rather than in each target.
 *
 * The ORDER lives in `clientBakeSettingsPasses.ts`, deliberately: it is a property of the file being
 * written, not of the host writing it. This module only decides which passes are wanted.
 *
 * Counterpart: the api's `routes/editor.ts` bake, whose passes these mirror one for one.
 */
import { processSettingsForSave } from './clientProcessSettingsPass'
import { buildBuiltinSlicingPresetId, projectDefinesMachineCompletely, projectMatchesNozzleDiameters, slicingPresetProvenance,
  firstProfileString
} from '@printstream/shared'
import type { ExportArrangedThreeMf, MachineRetargetPlan, ProcessConfig, ProfileRecord, SaveArrangedThreeMf, SlicingPresetSummary } from '@printstream/shared'
import type { ThreeMfBakeOptions } from '@printstream/shared/three-mf'
import type { ClientBakeSettingsPasses } from './clientBakeSettingsPasses'
import { buildMachineRetargetPlan, resolveFilamentRebinds, type RetargetResolvers } from './browserMachineRetarget'

export interface EditorBakePassOptions {
  /** What this host can resolve. See `browserMachineRetarget.ts` for why it is injected. */
  resolvers: RetargetResolvers
  /**
   * The catalogue a filament rebind picks from.
   *
   * Async because it settles after open on the workspace host, and a save that reads it too early
   * sees an empty list: no slot finds a rebind target and the retargeted project silently keeps the
   * source machine's filament presets.
   */
  filamentPresets: (signal?: AbortSignal) => Promise<readonly SlicingPresetSummary[]>
  /** Cancels every browser-side lookup this pass starts. */
  signal?: AbortSignal
}

/** Best-effort preset resolution may degrade ordinary failures, but never cancellation. */
function rethrowCancellation(error: unknown, signal?: AbortSignal): void {
  signal?.throwIfAborted()
  if (error instanceof Error && error.name === 'AbortError') throw error
}

/** The bake options a save request implies. Pure: no resolution, no I/O. */
export function bakeOptionsFor(payload: SaveArrangedThreeMf | ExportArrangedThreeMf): ThreeMfBakeOptions {
  const objectOverrides = (payload as SaveArrangedThreeMf).objectProcessOverrides
  return {
    ...(payload.processSettingOverrides ? { globalProcessOverrides: payload.processSettingOverrides } : {}),
    ...(payload.objectExport ? { objectExportMarker: true } : {}),
    ...(objectOverrides ? { objectProcessOverrides: objectOverrides } : {})
  }
}

/**
 * The post-bake passes a save request asks for.
 *
 * A single-object EXPORT gets none of the machine ones: it is a copy of one object taken out of the
 * project, not the project being saved for a different printer, and the api's export path does not
 * retarget either. Its filament overrides still apply, since they describe the material the exported
 * object prints in.
 */
export function bakePassesFor(
  payload: SaveArrangedThreeMf | ExportArrangedThreeMf,
  options: EditorBakePassOptions
): ClientBakeSettingsPasses {
  const save = payload as SaveArrangedThreeMf
  // `|| null`, never `?? null`: an empty string is REJECTED by the resolve routes, so a save made
  // before the slicer-targets query settles would 400 and drop the printer switch silently. Null
  // means "the default build", which is what an unresolved target should mean.
  const slicerTargetId = save.slicerTargetId || null
  const passes: ClientBakeSettingsPasses = {}

  if (save.filamentSettingOverrides && Object.keys(save.filamentSettingOverrides).length > 0) {
    passes.filamentSettingOverrides = {
      overrides: save.filamentSettingOverrides as Record<string, ProcessConfig>,
      resolveSlotConfigs: (projectSettings) => resolveSlotConfigs(projectSettings, slicerTargetId, options)
    }
  }

  if (payload.objectExport) return passes

  if (save.retarget) {
    const retarget = save.retarget
    if (retarget.processProfileId && slicingPresetProvenance(retarget.processProfileId) !== 'project') {
      passes.processSettings = processSettingsForSave(retarget, slicerTargetId, options)
    }
    passes.machineRetarget = async (projectSettings) => {
      // GATED on completeness, which is the api's own branch. A retarget target is materialized on
      // essentially every save (the dialog fills it whenever a printer and process are selected), so
      // running the FULL retarget unconditionally re-authors the machine block and overwrites the
      // project's process values on a save that changed no printer. "Same printer" is not "fully
      // defined", which is why the test is completeness rather than model equality: a project naming
      // H2D without H2D's dual-nozzle arrays still needs authoring.
      //
      // Complete already means this is at most a same-model PRESET change (an H2D variant, a nozzle
      // size, a user's own tuned machine), which authors the machine and nothing else.
      if (projectDefinesMachineCompletely(projectSettings, retarget.printerModel ?? null)) {
        const plan = await sameModelPresetPlan(projectSettings, retarget, slicerTargetId, options)
        return plan && passes.processSettings ? { ...plan, processConfig: null } : plan
      }
      const plan = await buildMachineRetargetPlan({
        target: retarget,
        slicerTargetId,
        projectSettings,
        filamentPresets: await options.filamentPresets(options.signal),
        resolvers: options.resolvers,
        ...(options.signal ? { signal: options.signal } : {})
      })
      // The final process pass is the sole author when the selected process can be materialized.
      return plan && passes.processSettings ? { ...plan, processConfig: null } : plan
    }
    return passes
  }

  // Only where no retarget will run: the heal is the alternative to one, never additional.
  //
  // The project names its machine by NAME (`printer_settings_id`), while the resolvers take an ID,
  // so the name is encoded into a builtin one first. Passing the bare name resolved nothing:
  // `slicingPresetProvenance` returns null for any unprefixed string, so `canResolve` was false for
  // every project and the heal never ran at all. The api resolved by name directly
  // (`slicerClient.resolveMachineConfig(..., { source: 'builtin', name })`), which is the same
  // lookup this id encodes. A CUSTOM machine has no builtin id and stays unhealed here, exactly as
  // it did on the api; the slicer's own slice-time heal still covers it.
  passes.machineTopologyHeal = async (machineName) => {
    const presetId = buildBuiltinSlicingPresetId('machine', machineName)
    if (!options.resolvers.canResolve(presetId)) return null
    const resolved = await options.resolvers.machine(
      presetId,
      slicerTargetId,
      options.signal ? { signal: options.signal } : undefined
    )
    return resolved.config
  }
  return passes
}

/**
 * The plan for a project that already defines the target MODEL completely, and so is at most
 * changing which PRESET of it the project names.
 *
 * Machine only, deliberately. The full retarget also re-resolves the process preset and rebinds
 * every filament slot, which is exactly what the completeness gate protects against: it would
 * overwrite the user's process settings on a save that switched nothing but a nozzle size. A plan
 * with no `processConfig` and no `filamentRebinds` writes the machine and leaves both alone, which
 * is all a same-model preset switch means.
 *
 * Two reasons to author nothing, and the second is not obvious. The project already naming this
 * preset is the easy one. The other is that a DIFFERENT name is not by itself evidence the user
 * switched: the client always sends a resolved `printerProfileId`, and for a project whose preset
 * this workspace does not hold that resolution FELL BACK to the first catalogue profile matching
 * the model. Treating "differs" as "switched" re-authored every such project onto a stock preset on
 * an ordinary save, discarding its start G-code, accelerations and limits. So rewrite only when the
 * user actually picked, or when the embedded machine genuinely no longer describes the target.
 *
 * Best-effort: a preset that will not resolve authors nothing and the save proceeds, rather than
 * failing a save the user would otherwise have got.
 */
async function sameModelPresetPlan(
  projectSettings: ProfileRecord,
  retarget: NonNullable<SaveArrangedThreeMf['retarget']>,
  slicerTargetId: string | null,
  options: EditorBakePassOptions
): Promise<MachineRetargetPlan | null> {
  if (!options.resolvers.canResolve(retarget.printerProfileId)) return null
  let resolved: { config: ProfileRecord; name: string }
  try {
    resolved = await options.resolvers.machine(
      retarget.printerProfileId,
      slicerTargetId,
      options.signal ? { signal: options.signal } : undefined
    )
  } catch (error) {
    rethrowCancellation(error, options.signal)
    console.warn('[editor] chosen printer preset could not be resolved; keeping the project\'s machine:',
      error instanceof Error ? error.message : error)
    return null
  }

  // Compared by NAME because that is the identity a 3MF carries; the request names the preset by id.
  const current = typeof projectSettings.printer_settings_id === 'string'
    ? projectSettings.printer_settings_id.trim()
    : null
  if (current && current === resolved.name) return null
  if (retarget.printerProfileChosen !== true
    && projectMatchesNozzleDiameters(projectSettings, retarget.nozzleDiameters ?? [])) {
    return null
  }

  const plan: MachineRetargetPlan = {
    machineConfig: resolved.config,
    printerSettingsId: resolved.name,
    printerPresetInherits: slicingPresetProvenance(retarget.printerProfileId) === 'workspace'
      ? firstProfileString(resolved.config.inherits)
      : null,
    // The model the resolved preset itself reports, falling back to what the save targeted: the
    // preset is the authority on which machine it describes.
    printerModel: firstProfileString(resolved.config.printer_model) ?? retarget.printerModel ?? '',
    processConfig: null
  }

  // Slots ARE rebound, even though the model has not changed. A filament preset declares the machine
  // PRESETS it fits, not the model, and the nozzle is part of a preset's identity: "Bambu PLA Basic
  // @BBL A1 0.2 nozzle" lists only the 0.2 machine. Leaving a slot alone across a nozzle change
  // therefore leaves it on a preset that is incompatible with the machine now being authored.
  // BambuStudio re-picks every slot on ANY printer-preset switch for exactly this reason, matching
  // by alias, and a nozzle change is such a switch there (the nozzle is the printer VARIANT).
  const filamentRebinds = await resolveFilamentRebinds(
    {
      target: retarget,
      slicerTargetId,
      projectSettings,
      filamentPresets: await options.filamentPresets(options.signal),
      resolvers: options.resolvers,
      ...(options.signal ? { signal: options.signal } : {})
    },
    plan,
    options.resolvers
  )
  return { ...plan, filamentRebinds }
}

/**
 * What each filament slot's preset holds, aligned with `filament_settings_id`.
 *
 * Needed only to fill NON-overridden slots when a written key's column set has to be created from
 * scratch, so an unresolvable slot contributes null and the pass degrades to "only keys already
 * present can be written" rather than failing. Resolved against the slot's own named preset: this
 * pass never switches the project's machine.
 */
async function resolveSlotConfigs(
  projectSettings: ProfileRecord,
  slicerTargetId: string | null,
  options: EditorBakePassOptions
): Promise<Array<ProcessConfig | null>> {
  const names = Array.isArray(projectSettings.filament_settings_id) ? projectSettings.filament_settings_id : []
  const catalogue = await options.filamentPresets(options.signal)
  const configs: Array<ProcessConfig | null> = []
  for (const name of names) {
    const preset = typeof name === 'string'
      ? catalogue.find((entry) => entry.kind === 'filament' && entry.name === name)
      : undefined
    if (!preset || !options.resolvers.canResolve(preset.id)) {
      configs.push(null)
      continue
    }
    try {
      const body = await options.resolvers.filament(
        preset.id,
        slicerTargetId,
        options.signal ? { signal: options.signal } : undefined
      )
      configs.push((body.config ?? null) as ProcessConfig | null)
    } catch (error) {
      rethrowCancellation(error, options.signal)
      // Per-slot best effort, exactly as the retarget's rebind is: one slot that will not resolve
      // must not cost the others their columns.
      configs.push(null)
    }
  }
  return configs
}
