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
import { applyProcessProfileToProjectSettings, retargetProjectSettingsToMachine, type SlicingManualProfileTarget } from '@printstream/shared'
import { conflict } from './http-error.js'
import { slicerClient } from './slicer-client.js'
import { resolveSlicingProfileFiles } from './slicing-profiles.js'
import { readEntry, rewriteModelSettingsThreeMf, rewriteThreeMfEntries } from './three-mf-internal.js'

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
