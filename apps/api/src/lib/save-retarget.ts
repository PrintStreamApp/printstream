/**
 * "Save as a different printer" for the 3MF editor: done on our end by rewriting the
 * project's machine settings, NOT by re-slicing. After an arrangement is baked,
 * {@link buildEditedThreeMf} preserves the project's *embedded* machine, so saving an A1-mini
 * project after switching to H2D would otherwise keep A1 mini.
 *
 * Flow: resolve the target machine profile (full, via the slicer's profile resolver, a data
 * lookup, not slicing), overwrite the machine field set in `project_settings.config` and
 * re-derive the topology-dependent maps ({@link retargetProjectSettingsToMachine}), then REBIND
 * each filament slot's physics to its preset on the new machine (BambuStudio's machine-switch
 * alias re-selection, see {@link resolveFilamentSlotRebinds}; the user's material CHOICES,
 * family, colours, nozzle assignment: survive, and recorded overrides keep their values), then
 * write the result back into the 3MF. The layout (`model_settings.config`) is untouched. Works
 * for any Bambu machine the slicer has a profile for. See docs/project-printer-retarget.md.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  applyMachineRetargetToProjectSettings,
  canonicalBambuModelKey,
  extractChangedFromSystemKeys,
  machinePresetSlotIndexFor,
  H2_DUAL_NOZZLE_MODEL_KEYS,
  hasDualNozzleMachineShape,
  resolveRetargetProcessFallback,
  retargetProjectSettingsToMachine,
  selectFilamentRebindTargets,
  slicingPresetProvenance,
  stripSliceInfoPrinterModelId,
  type FilamentSlotRebind,
  type SceneEditFilament,
  applyMachineSettingOverrides,
  type SlicingManualProfileTarget,
  type SlicingPresetSummary
} from '@printstream/shared'
import { THREE_MF_SLICE_INFO_ENTRY as SLICE_INFO_ENTRY } from '@printstream/shared/three-mf'
import { conflict } from './http-error.js'
import { slicerClient } from './slicer-client.js'
import { listCustomSlicingPresets, resolveSlicingPresetFiles } from './slicing-presets.js'
import { readEntry, rewriteModelSettingsThreeMf, rewriteThreeMfEntries } from './three-mf-internal.js'
import { applyNozzleAssignmentToProjectSettings } from '@printstream/shared/three-mf'

const PROJECT_SETTINGS_ENTRY = 'Metadata/project_settings.config'

/**
 * Author a resolved machine's COMPLETE settings into a baked project 3MF; returns the new path.
 *
 * The companion to {@link retargetSavedProjectMachine} for callers that already hold the resolved
 * machine profile, notably the transient SLICE bake. PrintStream is the source of truth for the
 * 3MF: every project we emit must define its own machine, so the slicer never has to retarget it
 * and never depends on built-in profile fallbacks surviving. Without this an editor slice can hand
 * over a project that names `printer_model: H2D` while carrying none of H2D's extruder-indexed
 * dual-nozzle topology, and the CLI then either refuses it ("missing its dual-nozzle machine data")
 * or slices with no print volume: "no object fully inside the print volume", exit 206.
 *
 * Best-effort: returns null rather than throwing when the machine can't be resolved or the embedded
 * settings are unreadable, so an unexpected profile downgrades to the previous behaviour instead of
 * failing a slice that would otherwise work. Callers log the miss.
 */
export async function authorProjectMachineFromProfile(input: {
  arrangedPath: string
  fileName: string
  slicerTargetId: string | null | undefined
  machineFile: { source: 'builtin' | 'custom'; name: string; content?: string }
}): Promise<string | null> {
  const machineConfig = await slicerClient.resolveMachineConfig(input.slicerTargetId, {
    source: input.machineFile.source,
    name: input.machineFile.name,
    content: input.machineFile.content
  })
  if (!machineConfig) return null

  // A scaffold with no embedded settings authors from an empty object: the machine profile
  // supplies every field, exactly like BambuStudio picking a printer for a fresh project.
  const projectSettingsRaw = await readEntry(input.arrangedPath, PROJECT_SETTINGS_ENTRY).catch(() => null)
  let projectSettings: Record<string, unknown> = {}
  if (projectSettingsRaw && projectSettingsRaw.length > 0) {
    try {
      projectSettings = JSON.parse(projectSettingsRaw.toString('utf8')) as Record<string, unknown>
    } catch {
      return null
    }
  }

  const authored = retargetProjectSettingsToMachine(projectSettings, machineConfig, {
    printerSettingsId: input.machineFile.name,
    printerModel: firstString(machineConfig.printer_model) ?? deriveModelFromMachineName(input.machineFile.name)
  })

  const outDir = await mkdtemp(path.join(tmpdir(), 'printstream-authored-machine-'))
  const stagePath = path.join(outDir, 'stage-project-settings.3mf')
  const outPath = path.join(outDir, path.basename(input.fileName) || 'authored.3mf')
  const authoredJson = JSON.stringify(authored)
  await rewriteThreeMfEntries(
    input.arrangedPath,
    stagePath,
    { [PROJECT_SETTINGS_ENTRY]: () => authoredJson },
    [{ name: PROJECT_SETTINGS_ENTRY, content: authoredJson }]
  )
  await rewriteModelSettingsThreeMf(stagePath, outPath, stripSliceInfoPrinterModelId, SLICE_INFO_ENTRY)
  return outPath
}

/**
 * Does the project already define `targetModel` COMPLETELY: the right machine, with the full
 * topology that machine needs?
 *
 * "Same printer" is not the same as "fully defined": a project can name `printer_model: H2D` while
 * carrying none of H2D's extruder-indexed dual-nozzle arrays, which is precisely the state that made
 * the CLI refuse it ("missing its dual-nozzle machine data") or slice with no print volume. Callers
 * use this to decide whether a same-model save still needs the machine authored in. Unreadable or
 * absent settings count as incomplete: the safe direction, since that is what a scaffold looks like.
 */
export async function projectHasCompleteMachine(arrangedPath: string, targetModel: string | null): Promise<boolean> {
  const raw = await readEntry(arrangedPath, PROJECT_SETTINGS_ENTRY).catch(() => null)
  if (!raw || raw.length === 0) return false
  let settings: Record<string, unknown>
  try {
    settings = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
  } catch {
    return false
  }
  const model = canonicalBambuModelKey(firstString(settings.printer_model) ?? firstString(settings.printer_settings_id))
  if (!model) return false
  const target = canonicalBambuModelKey(targetModel)
  if (target && model !== target) return false
  // Only the H2 family carries a topology beyond the plain machine fields.
  return H2_DUAL_NOZZLE_MODEL_KEYS.has(model) ? hasDualNozzleMachineShape(settings) : true
}

/**
 * The machine preset a saved project currently names (`printer_settings_id`), or null when it
 * names none or its settings are unreadable.
 *
 * A preset NAME, not an id: that is what a 3MF records, and what
 * {@link retargetProjectSettingsToMachine} writes back.
 */
export async function readProjectMachinePresetName(arrangedPath: string): Promise<string | null> {
  const raw = await readEntry(arrangedPath, PROJECT_SETTINGS_ENTRY).catch(() => null)
  if (!raw || raw.length === 0) return null
  try {
    const settings = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    return firstString(settings.printer_settings_id) ?? null
  } catch {
    return null
  }
}

/**
 * Author the chosen machine preset into a project that already names the right MODEL but a
 * DIFFERENT preset. Returns the new path, or null when there is nothing to do.
 *
 * The gap this closes: {@link projectHasCompleteMachine} answers a question about the MODEL, so a
 * save that changed only the preset (an H2D variant, a nozzle size, a user's own tuned machine)
 * looked "already complete" and the retarget was skipped. The editor still marked the project
 * dirty and Save still lit up, so the user's pick was accepted by the UI and silently dropped by
 * the save: the file kept its old `printer_settings_id`.
 *
 * Deliberately the MACHINE-ONLY authoring, not {@link retargetSavedProjectMachine}: the full
 * retarget also re-resolves the process preset and rebinds every filament slot, which is exactly
 * what the skip was protecting against ("re-running the retarget would overwrite the user's
 * process settings"). Both concerns are satisfied by authoring the machine and leaving process and
 * filaments untouched, which is all a same-model preset switch means.
 *
 * Best-effort like its delegate: a machine that cannot be resolved returns null and the save
 * proceeds unchanged, rather than failing a save the user would otherwise get.
 */
export async function applyMachinePresetChange(input: {
  workspaceId: string
  arrangedPath: string
  fileName: string
  slicerTargetId: string | null | undefined
  retarget: SlicingManualProfileTarget
}): Promise<string | null> {
  // `resolveSlicingPresetFiles` THROWS (404) for an id the workspace no longer holds -- a custom
  // preset deleted in another tab, say. This branch used to be an unconditional no-op, so letting
  // that escape would turn a stale id into a failed save and lose the user's arrangement. A machine
  // we cannot resolve means "author nothing", exactly as a missing file does.
  let machineFile: Awaited<ReturnType<typeof resolveSlicingPresetFiles>>[number] | undefined
  try {
    ;[machineFile] = await resolveSlicingPresetFiles(input.workspaceId, [
      { id: input.retarget.printerProfileId, kind: 'machine' }
    ])
  } catch (error) {
    console.warn(`[save-retarget] ${input.fileName}: chosen printer preset could not be resolved; keeping the project's machine`,
      error instanceof Error ? error.message : error)
    return null
  }
  if (!machineFile) return null
  return applyResolvedMachinePreset({
    arrangedPath: input.arrangedPath,
    fileName: input.fileName,
    slicerTargetId: input.slicerTargetId,
    machineFile,
    chosenByUser: input.retarget.printerProfileChosen === true,
    targetNozzleDiameters: input.retarget.nozzleDiameters ?? []
  })
}

/**
 * Write a project's OWN machine overrides into its `project_settings.config`; returns the new path,
 * or null when there is nothing to apply.
 *
 * Runs as the LAST machine-domain pass of a save, after whichever branch authored the machine
 * (a cross-model retarget, a same-model preset change, or the topology heal). That ordering is the
 * point: overrides and the resolved preset write the SAME keys, so applying them earlier would let
 * the preset overwrite the user's values, which is the failure that looks like the feature simply
 * not working.
 *
 * Best-effort on unreadable settings (returns null) for the same reason as its neighbours: a save
 * the user would otherwise get should not fail on an unexpected project.
 */
export async function applyMachineOverridesToProject(input: {
  workspaceId: string
  arrangedPath: string
  fileName: string
  slicerTargetId: string | null | undefined
  /** The save's machine target, used only to resolve the preset a RESET restores values from. */
  retarget: SlicingManualProfileTarget | undefined
  machineSettingOverrides: Record<string, string | string[]>
}): Promise<string | null> {
  const raw = await readEntry(input.arrangedPath, PROJECT_SETTINGS_ENTRY).catch(() => null)
  if (!raw || raw.length === 0) {
    // Only worth saying when the user actually asked for something; an empty map here is the
    // ordinary "no printer overrides on a project that has none" case.
    if (Object.keys(input.machineSettingOverrides).length > 0) {
      console.warn(`[save-retarget] ${input.fileName}: no embedded project settings; machine overrides were not applied`)
    }
    return null
  }
  let projectSettings: Record<string, unknown>
  try {
    projectSettings = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
  } catch (error) {
    console.warn(`[save-retarget] ${input.fileName}: embedded project settings are unreadable; machine overrides were not applied`,
      error instanceof Error ? error.message : error)
    return null
  }

  // Nothing asked for and nothing recorded means nothing to do, and answering that FIRST is what
  // keeps an ordinary save cheap: the web sends this map on every save now (empty included, since
  // empty is how a reset is expressed), and resolving the preset is a DB read plus a slicer HTTP
  // round-trip that the machine branch above has usually just performed with the same arguments.
  // Resolved lazily below, only once there is real work.
  const machineIndex = machinePresetSlotIndexFor(projectSettings)
  const recordsNothing = machineIndex == null || extractChangedFromSystemKeys(
    projectSettings.different_settings_to_system, machineIndex, () => true
  ).length === 0
  if (Object.keys(input.machineSettingOverrides).length === 0 && recordsNothing) return null

  // The preset is what a RESET restores to: dropping a key from the record without putting its
  // value back would leave the engine slicing with an override the UI no longer shows.
  const presetConfig = await resolveMachinePresetConfigForOverrides(input).catch((error: unknown) => {
    console.warn(`[save-retarget] ${input.fileName}: could not resolve the machine preset; reset overrides stay recorded`,
      error instanceof Error ? error.message : error)
    return null
  })

  const overridden = applyMachineSettingOverrides(projectSettings, input.machineSettingOverrides, presetConfig ?? undefined)
  // Unchanged means nothing to write: the project records no overrides and none were asked for.
  if (overridden === projectSettings) return null

  const outDir = await mkdtemp(path.join(tmpdir(), 'printstream-machine-overrides-'))
  const outPath = path.join(outDir, path.basename(input.fileName) || 'machine-overridden.3mf')
  const overriddenJson = JSON.stringify(overridden)
  await rewriteThreeMfEntries(
    input.arrangedPath,
    outPath,
    { [PROJECT_SETTINGS_ENTRY]: () => overriddenJson },
    [{ name: PROJECT_SETTINGS_ENTRY, content: overriddenJson }]
  )
  return outPath
}

/** The resolved machine preset behind a save's target, or null when it cannot be resolved. */
async function resolveMachinePresetConfigForOverrides(input: {
  workspaceId: string
  slicerTargetId: string | null | undefined
  retarget: SlicingManualProfileTarget | undefined
}): Promise<Record<string, string | string[]> | null> {
  if (!input.retarget) return null
  const [machineFile] = await resolveSlicingPresetFiles(input.workspaceId, [
    { id: input.retarget.printerProfileId, kind: 'machine' }
  ])
  if (!machineFile) return null
  return await slicerClient.resolveMachineConfig(input.slicerTargetId, {
    source: machineFile.source,
    name: machineFile.name,
    content: machineFile.content
  })
}

/**
 * {@link applyMachinePresetChange} once the preset has been resolved to a file. Split out so the
 * decision and the authoring can be exercised without a workspace preset store behind them.
 */
export async function applyResolvedMachinePreset(input: {
  arrangedPath: string
  fileName: string
  slicerTargetId: string | null | undefined
  machineFile: { source: 'builtin' | 'custom'; name: string; content?: string }
  /** The user PICKED this preset (`SlicingManualProfileTarget.printerProfileChosen`). */
  chosenByUser: boolean
  /** The nozzle diameters the save targets, so a nozzle switch still re-authors the machine. */
  targetNozzleDiameters: readonly number[]
}): Promise<string | null> {
  // Compared by NAME because that is the identity a 3MF carries; the request names the preset by
  // id. Equal means the project already IS on this preset, so there is nothing to author.
  const current = await readProjectMachinePresetName(input.arrangedPath)
  if (current && current === input.machineFile.name) return null

  // A DIFFERENT name is not by itself a reason to rewrite. The client always sends a resolved
  // `printerProfileId`, and for a project whose preset this workspace does not hold that resolution
  // is a FALLBACK to the first catalogue profile matching the model -- so treating "differs" as
  // "the user switched" re-authored every such project onto a stock preset on an ordinary save,
  // discarding its start G-code, accelerations and limits. Rewrite only when the user actually
  // picked, or when the embedded machine genuinely no longer describes the target.
  if (!input.chosenByUser && await projectMatchesTargetNozzles(input.arrangedPath, input.targetNozzleDiameters)) {
    return null
  }

  const authored = await authorProjectMachineFromProfile({
    arrangedPath: input.arrangedPath,
    fileName: input.fileName,
    slicerTargetId: input.slicerTargetId,
    machineFile: input.machineFile
  })
  if (!authored) {
    // Its own doc says callers log the miss, and every sibling does. Silence here would discard the
    // user's deliberate preset switch while reporting a successful save -- the very bug this
    // branch exists to fix.
    console.warn(`[save-retarget] ${input.fileName}: could not resolve ${input.machineFile.name}; the project keeps its previous machine`)
  }
  return authored
}

/**
 * Does the project's embedded machine already carry the nozzle diameters this save targets?
 *
 * The companion question to {@link projectHasCompleteMachine}, which only compares the MODEL. A
 * nozzle switch (0.4 -> 0.6) keeps the model and changes the machine preset, so without this a
 * derived-target save could never re-author the machine and the saved project kept the old nozzle.
 * Unreadable settings answer false: author rather than assume.
 */
async function projectMatchesTargetNozzles(arrangedPath: string, targetNozzleDiameters: readonly number[]): Promise<boolean> {
  if (targetNozzleDiameters.length === 0) return true
  const raw = await readEntry(arrangedPath, PROJECT_SETTINGS_ENTRY).catch(() => null)
  if (!raw || raw.length === 0) return false
  try {
    const settings = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    const embedded = Array.isArray(settings.nozzle_diameter)
      ? (settings.nozzle_diameter as unknown[]).map((entry) => Number.parseFloat(String(entry))).filter((value) => Number.isFinite(value))
      : []
    if (embedded.length === 0) return false
    // Compared as SETS: the target lists the diameters in play, the project lists them per extruder,
    // so an H2D's [0.4, 0.4] must still match a target of [0.4].
    const wanted = new Set(targetNozzleDiameters)
    return embedded.every((value) => wanted.has(value)) && [...wanted].every((value) => embedded.includes(value))
  } catch {
    return false
  }
}

export interface RetargetSavedProjectInput {
  workspaceId: string
  /** Path to the freshly-baked arranged 3MF (still carries the project's embedded machine). */
  arrangedPath: string
  /** Final file name; also the retargeted-project file name. */
  fileName: string
  slicerTargetId: string | null | undefined
  retarget: SlicingManualProfileTarget
}

/**
 * Returns the path to a retargeted project 3MF. Throws an {@link HttpError} (409) with a
 * user-facing message when the target machine cannot be resolved or the project's embedded
 * settings are unreadable. A project with NO embedded settings retargets from scratch.
 */
export async function retargetSavedProjectMachine(input: RetargetSavedProjectInput): Promise<string> {
  const [machineFile] = await resolveSlicingPresetFiles(input.workspaceId, [
    { id: input.retarget.printerProfileId, kind: 'machine' }
  ])
  if (!machineFile) {
    throw conflict('Choose an installed printer profile before saving for a different printer.')
  }

  const machineConfig = await slicerClient.resolveMachineConfig(input.slicerTargetId, {
    source: machineFile.source,
    name: machineFile.name,
    content: machineFile.content
  })
  if (!machineConfig) {
    throw conflict(`Could not load the ${formatModel(input.retarget.printerModel)} machine profile to retarget this project.`)
  }

  // A project with no embedded settings (a new-project scaffold whose save carried no
  // project_settings rewrites) retargets from an empty object: the resolved machine and
  // process profiles supply every field, exactly like BambuStudio picking a printer for a
  // fresh project.
  const projectSettingsRaw = await readEntry(input.arrangedPath, PROJECT_SETTINGS_ENTRY).catch(() => null)
  let projectSettings: Record<string, unknown> = {}
  if (projectSettingsRaw && projectSettingsRaw.length > 0) {
    try {
      projectSettings = JSON.parse(projectSettingsRaw.toString('utf8')) as Record<string, unknown>
    } catch {
      throw conflict('This project’s embedded printer settings could not be read.')
    }
  }

  const printerModel = firstString(machineConfig.printer_model) ?? deriveModelFromMachineName(machineFile.name)
  // The machine step alone, so the rebind selection can read the RETARGETED filament layout (its
  // variant widths and slot names come from the new machine, not the old one). The full apply
  // below re-runs it: cheap, pure, and it keeps the shared composition the single definition of
  // the operation's ORDER rather than open-coding half of it here.
  const machineRetargeted = retargetProjectSettingsToMachine(projectSettings, machineConfig, {
    printerSettingsId: machineFile.name,
    printerModel
  })

  // Bring the process (print/quality) settings over to the target printer's process too, so the
  // saved project doesn't keep the source printer's process. Best-effort: a process that can't be
  // resolved (e.g. a project-embedded preset) must not block the machine retarget, which is what
  // makes the project openable/printable on the new machine.
  const chosenProcessConfig = await resolveTargetProcessConfig(input)
  // With no process chosen, keeping the project's own is right only while that process still fits
  // the machine being authored. When it does not, BambuStudio would have reselected on the printer
  // switch, so reselect here (the rule, and why it is not a lineage rewrite, is in the shared
  // module). Best-effort like everything else on this path: an unresolvable lineage or replacement
  // leaves the project's process exactly as before.
  const processConfig = chosenProcessConfig ?? await resolveRetargetProcessFallback({
    projectSettings,
    machineConfig,
    printerSettingsId: machineFile.name,
    resolveSystemProcess: (name) => resolveBuiltinProcessConfigByName(input.slicerTargetId, name),
    log: (message) => console.warn(`[editor-save] ${message}`)
  })

  // Rebind each filament slot's PHYSICS to its preset on the NEW machine: BambuStudio's
  // machine-switch semantics (`PresetBundle::update_compatible` re-selects filament presets by
  // ALIAS, so values become the new variant's; only recorded user overrides survive). Without
  // this the old machine's numeric columns ride along as fossils that read as phantom "changed
  // vs preset" markers forever (X1C's `pre_start_fan_time` 0 vs H2D's stock 2). Best-effort per
  // slot: an unresolvable slot keeps its current values rather than blocking the save.
  const filamentRebinds = await resolveFilamentSlotRebinds({
    workspaceId: input.workspaceId,
    slicerTargetId: input.slicerTargetId,
    record: machineRetargeted,
    targetModel: printerModel,
    nozzleHint: machineFile.name
  })

  const retargeted = applyMachineRetargetToProjectSettings(projectSettings, {
    machineConfig,
    printerSettingsId: machineFile.name,
    printerModel,
    processConfig,
    processSettingOverrides: input.retarget.processSettingOverrides ?? {},
    filamentRebinds
  })

  const outDir = await mkdtemp(path.join(tmpdir(), 'printstream-retarget-'))
  const stagePath = path.join(outDir, 'stage-project-settings.3mf')
  const outPath = path.join(outDir, path.basename(input.fileName) || 'retargeted.3mf')
  // Two passes: upsert the machine/process project_settings (appended when the settings-less
  // source has no entry to transform), then clear the source printer's stale slice_info
  // `printer_model_id` (a no-op when absent) so the chips read as the target model only.
  const retargetedJson = JSON.stringify(retargeted)
  await rewriteThreeMfEntries(
    input.arrangedPath,
    stagePath,
    { [PROJECT_SETTINGS_ENTRY]: () => retargetedJson },
    [{ name: PROJECT_SETTINGS_ENTRY, content: retargetedJson }]
  )
  await rewriteModelSettingsThreeMf(stagePath, outPath, stripSliceInfoPrinterModelId, SLICE_INFO_ENTRY)
  return outPath
}

/**
 * Best-effort save-side heal for an H2-family project whose embedded settings LOST their
 * dual-nozzle machine block (a filament rewrite once deleted the extruder-indexed machine
 * arrays: see MACHINE_DOMAIN_ARRAY_KEYS in three-mf-scene-builder). Re-authors the machine
 * from the project's own `printer_settings_id` (resolved as a builtin machine preset via the
 * slicer), then re-applies the edit's nozzle assignment: the retarget resets
 * `filament_nozzle_map` to the machine default, and with the topology restored the assignment
 * write works again (it no-ops without `physical_extruder_map`, which is exactly how the damage
 * also made the L/R choice silently stop saving).
 *
 * Returns the path to the healed 3MF, or null when the project doesn't need (or can't get) the
 * heal: settings absent/unreadable, not an H2-family machine, topology intact, or the machine
 * preset unresolvable (e.g. a custom preset name: the slicer's slice-time heal still covers
 * those). Never throws: a heal failure must not fail the save that triggered it, it logs and
 * the save proceeds with the un-healed bake (which still slices via the slicer-side heal).
 */
export async function healSavedProjectMachineTopology(input: {
  workspaceId: string
  arrangedPath: string
  fileName: string
  slicerTargetId: string | null | undefined
  /** The edit's filament list, used to re-apply the per-slot nozzle assignment after the heal. */
  filaments: SceneEditFilament[] | null | undefined
}): Promise<string | null> {
  try {
    const projectSettingsRaw = await readEntry(input.arrangedPath, PROJECT_SETTINGS_ENTRY).catch(() => null)
    if (!projectSettingsRaw || projectSettingsRaw.length === 0) return null
    let projectSettings: Record<string, unknown>
    try {
      projectSettings = JSON.parse(projectSettingsRaw.toString('utf8')) as Record<string, unknown>
    } catch {
      return null
    }
    const model = canonicalBambuModelKey(firstString(projectSettings.printer_model) ?? firstString(projectSettings.printer_settings_id))
    if (!model || !H2_DUAL_NOZZLE_MODEL_KEYS.has(model)) return null
    if (hasDualNozzleMachineShape(projectSettings)) return null

    const machineName = firstString(projectSettings.printer_settings_id)
    if (!machineName) return null
    const machineConfig = await slicerClient.resolveMachineConfig(input.slicerTargetId ?? null, {
      source: 'builtin',
      name: machineName
    })
    if (!machineConfig) return null

    let healed = retargetProjectSettingsToMachine(projectSettings, machineConfig, {
      printerSettingsId: machineName,
      printerModel: firstString(machineConfig.printer_model) ?? deriveModelFromMachineName(machineName)
    })
    let healedJson = JSON.stringify(healed)
    if (input.filaments && input.filaments.length > 0) {
      healedJson = applyNozzleAssignmentToProjectSettings(healedJson, input.filaments)
      healed = JSON.parse(healedJson) as Record<string, unknown>
    }

    const outDir = await mkdtemp(path.join(tmpdir(), 'printstream-heal-'))
    const outPath = path.join(outDir, path.basename(input.fileName) || 'healed.3mf')
    await rewriteThreeMfEntries(
      input.arrangedPath,
      outPath,
      { [PROJECT_SETTINGS_ENTRY]: () => healedJson },
      [{ name: PROJECT_SETTINGS_ENTRY, content: healedJson }]
    )
    console.warn(`[editor-save] healed missing ${model} dual-nozzle machine data in ${input.fileName} (re-authored from ${machineName})`)
    return outPath
  } catch (error) {
    console.warn(`[editor-save] dual-nozzle machine heal failed for ${input.fileName}; saving un-healed:`, error instanceof Error ? error.message : error)
    return null
  }
}

/** Resolve the target process profile's full config, or null when there's none / it can't be resolved. */
/**
 * Resolve where each filament slot rebinds on the target machine, mirroring BambuStudio's
 * alias re-selection: the slot's exact preset when it is compatible with the new machine,
 * else the same FAMILY's variant for that machine (preferring the retargeted machine's nozzle),
 * else no rebind (the slot keeps its values). Custom presets outrank builtins of the same name,
 * matching the profile list. Returns null when nothing would change, or on any catalogue
 * failure: the rebind is an improvement pass and must never block the save.
 *
 * Also reused (with the project's OWN machine as the "target") by the tune-override persistence
 * pass in `save-filament-overrides.ts`, which needs the same per-slot resolved preset configs to
 * fill non-overridden slots' columns.
 */
export async function resolveFilamentSlotRebinds(input: {
  workspaceId: string
  slicerTargetId: string | null | undefined
  record: Record<string, unknown>
  targetModel: string
  /** The retargeted machine preset name; its nozzle token breaks family-variant ties. */
  nozzleHint: string
}): Promise<FilamentSlotRebind[] | null> {
  const targetModelKey = canonicalBambuModelKey(input.targetModel)
  if (!targetModelKey) return null
  let candidates: SlicingPresetSummary[]
  try {
    const builtins = await slicerClient.profiles(input.slicerTargetId)
    const customs = await listCustomSlicingPresets(input.workspaceId, builtins)
    // Customs first: they outrank a builtin of the same name, matching the profile list.
    candidates = [...customs, ...builtins].filter((profile) => profile.kind === 'filament')
  } catch {
    return null
  }
  // The MATCHING is shared with the public editor's save: see `selectFilamentRebindTargets`.
  // Only the config resolution below is host-specific.
  const selections = selectFilamentRebindTargets({
    filamentSettingsIds: input.record.filament_settings_id,
    candidates,
    targetModelKey,
    nozzleHint: input.nozzleHint
  })
  if (!selections) return null

  const rebinds: FilamentSlotRebind[] = []
  for (const { slotName, target } of selections) {
    if (!target) {
      rebinds.push({ config: null })
      continue
    }
    let config: Record<string, string | string[]> | null = null
    try {
      // Workspace custom presets resolve through their stored file (a diff over a system base);
      // builtins resolve by name from the slicer's own catalogue.
      if (slicingPresetProvenance(target.id) === 'workspace') {
        const [file] = await resolveSlicingPresetFiles(input.workspaceId, [{ id: target.id, kind: 'filament' }])
        config = file ? await slicerClient.resolveFilamentConfig(input.slicerTargetId, { source: file.source, name: file.name, content: file.content }) : null
      } else {
        config = await slicerClient.resolveFilamentConfig(input.slicerTargetId, { source: 'builtin', name: target.name })
      }
    } catch {
      config = null
    }
    rebinds.push({ config, settingsId: config && target.name !== slotName ? target.name : null })
  }
  return rebinds.some((rebind) => rebind.config != null || rebind.settingsId != null) ? rebinds : null
}

async function resolveTargetProcessConfig(input: RetargetSavedProjectInput): Promise<Record<string, string | string[]> | null> {
  if (!input.retarget.processProfileId) return null
  // resolveSlicingPresetFiles skips project-embedded ("project:") presets, so those fall through
  // to null and the project keeps its embedded process, intended (a project preset has no separate
  // file to resolve, and cross-family targets hide project presets anyway).
  const [processFile] = await resolveSlicingPresetFiles(input.workspaceId, [
    { id: input.retarget.processProfileId, kind: 'process' }
  ])
  if (!processFile) return null
  return slicerClient.resolveProcessConfig(input.slicerTargetId, {
    source: processFile.source,
    name: processFile.name,
    content: processFile.content
  })
}

/**
 * A BUILT-IN process preset by name, for the retarget's reselect.
 *
 * Silent on a miss, matching the browser twin: `inherits_group[0]` can name a preset the slicer
 * image has never carried (one from the user's own BambuStudio, or from a newer engine), and that
 * is an ordinary answer. `resolveRetargetProcessFallback` logs both of ITS outcomes, so the
 * decision stays observable without a warning per lookup.
 */
async function resolveBuiltinProcessConfigByName(
  slicerTargetId: string | null | undefined,
  name: string
): Promise<Record<string, string | string[]> | null> {
  try {
    return await slicerClient.resolveProcessConfig(slicerTargetId, { source: 'builtin', name })
  } catch {
    return null
  }
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

function formatModel(value: string): string {
  return value === 'unknown' ? 'selected' : value
}
