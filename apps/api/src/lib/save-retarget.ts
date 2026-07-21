/**
 * "Save as a different printer" for the 3MF editor — done on our end by rewriting the
 * project's machine settings, NOT by re-slicing. After an arrangement is baked,
 * {@link buildEditedThreeMf} preserves the project's *embedded* machine, so saving an A1-mini
 * project after switching to H2D would otherwise keep A1 mini.
 *
 * Flow: resolve the target machine profile (full, via the slicer's profile resolver — a data
 * lookup, not slicing), overwrite the machine field set in `project_settings.config` and
 * re-derive the topology-dependent maps ({@link retargetProjectSettingsToMachine}), then write
 * the result back into the 3MF. The layout (`model_settings.config`) and the user's filament
 * selection are untouched. Works for any Bambu machine the slicer has a profile for. See
 * docs/project-printer-retarget.md.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  applyProcessProfileToProjectSettings,
  canonicalBambuModelKey,
  H2_DUAL_NOZZLE_MODEL_KEYS,
  hasDualNozzleMachineShape,
  retargetProjectSettingsToMachine,
  type SceneEditFilament,
  type SlicingManualProfileTarget
} from '@printstream/shared'
import { conflict } from './http-error.js'
import { slicerClient } from './slicer-client.js'
import { resolveSlicingProfileFiles } from './slicing-profiles.js'
import { readEntry, rewriteModelSettingsThreeMf, rewriteThreeMfEntries } from './three-mf-internal.js'
import { applyNozzleAssignmentToProjectSettings } from './three-mf-scene-builder.js'

const PROJECT_SETTINGS_ENTRY = 'Metadata/project_settings.config'
const SLICE_INFO_ENTRY = 'Metadata/slice_info.config'

/**
 * Drops the stale `printer_model_id` metadata from a retargeted project's `slice_info.config`.
 * That entry describes the project's last slice on the SOURCE printer, so its `printer_model_id`
 * (e.g. `N1` → A1) otherwise lingers as a wrong compatibility chip on the H2D project. BambuStudio's
 * saved-but-not-sliced projects carry no `printer_model_id` either, so removing it matches BS and the
 * project reads as "needs a fresh slice for the new printer".
 */
function stripSliceInfoPrinterModelId(sliceInfoXml: string): string {
  return sliceInfoXml.replace(/[ \t]*<metadata\s+key="printer_model_id"\s+value="[^"]*"\s*\/>\s*\r?\n?/g, '')
}

/**
 * Author a resolved machine's COMPLETE settings into a baked project 3MF; returns the new path.
 *
 * The companion to {@link retargetSavedProjectMachine} for callers that already hold the resolved
 * machine profile — notably the transient SLICE bake. PrintStream is the source of truth for the
 * 3MF: every project we emit must define its own machine, so the slicer never has to retarget it
 * and never depends on built-in profile fallbacks surviving. Without this an editor slice can hand
 * over a project that names `printer_model: H2D` while carrying none of H2D's extruder-indexed
 * dual-nozzle topology, and the CLI then either refuses it ("missing its dual-nozzle machine data")
 * or slices with no print volume — "no object fully inside the print volume", exit 206.
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

  // A scaffold with no embedded settings authors from an empty object — the machine profile
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
 * Does the project already define `targetModel` COMPLETELY — the right machine, with the full
 * topology that machine needs?
 *
 * "Same printer" is not the same as "fully defined": a project can name `printer_model: H2D` while
 * carrying none of H2D's extruder-indexed dual-nozzle arrays, which is precisely the state that made
 * the CLI refuse it ("missing its dual-nozzle machine data") or slice with no print volume. Callers
 * use this to decide whether a same-model save still needs the machine authored in. Unreadable or
 * absent settings count as incomplete — the safe direction, since that is what a scaffold looks like.
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

export interface RetargetSavedProjectInput {
  tenantId: string
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
  const [machineFile] = await resolveSlicingProfileFiles(input.tenantId, [
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
  // project_settings rewrites) retargets from an empty object — the resolved machine and
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

  let retargeted = retargetProjectSettingsToMachine(projectSettings, machineConfig, {
    printerSettingsId: machineFile.name,
    printerModel: firstString(machineConfig.printer_model) ?? deriveModelFromMachineName(machineFile.name)
  })

  // Bring the process (print/quality) settings over to the target printer's process too, so the
  // saved project doesn't keep the source printer's process. Best-effort: a process that can't be
  // resolved (e.g. a project-embedded preset) must not block the machine retarget, which is what
  // makes the project openable/printable on the new machine.
  const processConfig = await resolveTargetProcessConfig(input)
  if (processConfig) {
    retargeted = applyProcessProfileToProjectSettings(retargeted, processConfig, input.retarget.processSettingOverrides ?? {})
  }

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
 * arrays — see MACHINE_DOMAIN_ARRAY_KEYS in three-mf-scene-builder). Re-authors the machine
 * from the project's own `printer_settings_id` (resolved as a builtin machine preset via the
 * slicer), then re-applies the edit's nozzle assignment — the retarget resets
 * `filament_nozzle_map` to the machine default, and with the topology restored the assignment
 * write works again (it no-ops without `physical_extruder_map`, which is exactly how the damage
 * also made the L/R choice silently stop saving).
 *
 * Returns the path to the healed 3MF, or null when the project doesn't need (or can't get) the
 * heal: settings absent/unreadable, not an H2-family machine, topology intact, or the machine
 * preset unresolvable (e.g. a custom preset name — the slicer's slice-time heal still covers
 * those). Never throws: a heal failure must not fail the save that triggered it — it logs and
 * the save proceeds with the un-healed bake (which still slices via the slicer-side heal).
 */
export async function healSavedProjectMachineTopology(input: {
  tenantId: string
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
async function resolveTargetProcessConfig(input: RetargetSavedProjectInput): Promise<Record<string, string | string[]> | null> {
  if (!input.retarget.processProfileId) return null
  // resolveSlicingProfileFiles skips project-embedded ("project:") presets, so those fall through
  // to null and the project keeps its embedded process — intended (a project preset has no separate
  // file to resolve, and cross-family targets hide project presets anyway).
  const [processFile] = await resolveSlicingProfileFiles(input.tenantId, [
    { id: input.retarget.processProfileId, kind: 'process' }
  ])
  if (!processFile) return null
  return slicerClient.resolveProcessConfig(input.slicerTargetId, {
    source: processFile.source,
    name: processFile.name,
    content: processFile.content
  })
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
