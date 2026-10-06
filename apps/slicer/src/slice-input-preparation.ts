/**
 * Prepare one 3MF for the selected slicing policy.
 *
 * Browser-prepared projects are already authoritative and pass through byte-for-byte. Legacy
 * projects may need machine retargeting, embedded profile overrides, stale nozzle-group removal,
 * preview invalidation, and a larger-bed recenter before the CLI reads them. The entrypoint owns
 * request bounds, cancellation, and response framing; this module owns project authoring.
 */
import { readFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { isProjectSlicingPresetId, sliceEnvelopeSchema, type SlicingOutputLine, type SlicingPresetFile } from '@printstream/shared'
import { assertSupportedEmbeddedMachineSwitch, shouldRetargetEmbeddedMachine } from './machine-switch-guard.js'
import { mergeInheritedMachineProfile, retargetProjectSettingsToMachine } from './machine-switch-repair.js'
import { applyManualFilamentMapToModelSettings, buildManualNozzleAssignment, buildSlicedArtifactMetadata, isPlatePreviewEntry, metadataChangesFilamentColours, readAuthoredManualFilamentMap, rewriteProjectSettingsMetadata } from './output-metadata.js'
import { sanitizeProfileFileName } from './profile-file-name.js'
import { bedSizeFromPrintableArea, buildObjectPlateIndex, recenterBuildItemsXml } from './recenter-plates.js'
import { appendStructuredOutput } from './slice-output.js'
import { slicerInputPolicy } from './prepared-input-policy.js'
import { sliceInfoCarriesNozzleGroupIds, stripSliceInfoNozzleGroupIds } from './stale-slice-info.js'
import { readThreeMfProjectSettings } from './three-mf-project-settings.js'
import { rewriteThreeMfProjectSettings } from './three-mf-project-rewrite.js'
import { readZipEntryText } from './zip-io.js'
import { type RuntimeSlicerTarget } from './slicer-targets.js'

const FALLBACK_MANUAL_MACHINE_PROFILE_ID = '__printstream-fallback-manual-machine__'

/** Context for the post-retarget bed re-center: where the merged machine profile lives + the log sink. */
interface MachineSwitchRecenterInput {
  slicerTarget: RuntimeSlicerTarget
  machineSwitchProfileName: string
  outputLines: SlicingOutputLine[]
}

/**
 * After a machine retarget, shift each plate's objects onto the (larger) target bed so a
 * multi-plate project's non-first plates don't fall outside their plate region (CLI exit 206 /
 * CLI_NO_SUITABLE_OBJECTS). The retargeted project already targets the new machine but keeps the source
 * layout, because BambuStudio's CLI only re-centers on a switch it treats as "forced" (an
 * incompatible process), not the normal compatible-process switch this flow performs. We apply
 * BambuStudio's own `translate_models` shift ourselves (see {@link recenterBuildItemsXml}), reading
 * the source bed from the original upload and the target bed from the merged machine profile. A no-op
 * for a same/smaller target bed.
 */
async function recenterRepairedProjectForLargerBed(repairedPath: string, sourcePath: string, input: MachineSwitchRecenterInput): Promise<void> {
  const sourceSettings = await readThreeMfProjectSettings(sourcePath).catch(() => null)
  const sourceBed = sourceSettings ? bedSizeFromPrintableArea(sourceSettings.printable_area) : null
  const machineProfile = await readMergedMachineProfile(input.slicerTarget.profileDir, input.machineSwitchProfileName).catch(() => null)
  const targetBed = machineProfile ? bedSizeFromPrintableArea(machineProfile.printable_area) : null
  if (!sourceBed || !targetBed) return
  // Only onto a larger bed (source smaller in at least one dim, not smaller in either): BambuStudio's
  // `shrink_to_new_bed==1` centering. A smaller target is a different case (objects may not fit) we leave alone.
  const larger = targetBed.width > sourceBed.width || targetBed.depth > sourceBed.depth
  const notSmaller = targetBed.width >= sourceBed.width && targetBed.depth >= sourceBed.depth
  if (!larger || !notSmaller) return
  const settingsXml = await readZipEntryText(repairedPath, 'Metadata/model_settings.config').catch(() => '')
  const { objectPlateIndex, plateCount } = buildObjectPlateIndex(settingsXml)
  if (objectPlateIndex.size === 0) return
  const recenteredPath = `${repairedPath}.recenter`
  await rewriteThreeMfProjectSettings(
    repairedPath,
    recenteredPath,
    (settings) => settings,
    { model3dTransform: (modelXml) => recenterBuildItemsXml(modelXml, objectPlateIndex, plateCount, sourceBed, targetBed) }
  )
  await rename(recenteredPath, repairedPath)
  appendStructuredOutput(input.outputLines, 'system', `Re-centered objects onto ${targetBed.width}x${targetBed.depth} bed`)
}

export async function prepareInputThreeMf(input: {
  slicerTarget: RuntimeSlicerTarget
  inputPath: string
  outputPath: string
  request: z.infer<typeof sliceEnvelopeSchema>['request']
  profileFiles: SlicingPresetFile[]
  stripEmbeddedProfileRefs: boolean
  processSettingOverrides: Record<string, string | string[]>
  outputLines: SlicingOutputLine[]
}): Promise<{
  inputPath: string
  rewroteProjectSettings: boolean
  /** 1-based slicer extruder per filament when Manual nozzle mode is forced; null otherwise. */
  manualFilamentMap: string[] | null
}> {
  const projectSettings = await readThreeMfProjectSettings(input.inputPath)
  const inputPolicy = slicerInputPolicy(input.request)

  if (inputPolicy.projectSettingsAuthoritative) {
    if (!projectSettings) {
      throw new Error('The browser-prepared project has no readable embedded project settings.')
    }

    // BambuStudio takes a Manual-mode map from `--filament-map`, so carry the browser-authored map
    // into the CLI arguments without changing the project. The browser already wrote the matching
    // per-plate mode and removed previous-slice nozzle groups before staging these bytes.
    const manualFilamentMap = readAuthoredManualFilamentMap(projectSettings)
    return {
      inputPath: input.inputPath,
      rewroteProjectSettings: false,
      manualFilamentMap
    }
  }

  if (!('sourceFileId' in input.request)) {
    throw new Error('An unprepared public slicing request cannot be executed.')
  }

  const machineSwitchProfileName = input.profileFiles.find((profile) => profile.kind === 'machine')?.name ?? null
  assertSupportedEmbeddedMachineSwitch({
    request: input.request,
    profileFiles: input.profileFiles,
    projectSettings
  })
  // Cross-model slice: retarget the project's embedded machine OURSELVES, the same
  // native `retargetProjectSettingsToMachine` rewrite the editor's "save as a different
  // printer" uses, so PrintStream stays the source of truth for the 3MF's machine and
  // the CLI receives a project that already natively targets the requested printer. No
  // CLI `--estimate-mode` round-trip, no dependency on the slicer version's flags.
  const needsMachineSwitch = shouldRetargetEmbeddedMachine({
    request: input.request,
    profileFiles: input.profileFiles,
    projectSettings
  })
  if (needsMachineSwitch && !machineSwitchProfileName) {
    throw new Error('Slicing for a different printer requires an installed machine profile: pick one and slice again.')
  }
  const machineSwitchProfile = needsMachineSwitch && machineSwitchProfileName
    ? await readMergedMachineProfile(input.slicerTarget.profileDir, machineSwitchProfileName)
    : null

  // A project-embedded ("project:") process profile has no separate process
  // profile file, so its overrides must be merged into the 3MF's own
  // project_settings.config rather than a materialized preset.
  const applyEmbeddedProcessOverrides =
    isProjectSlicingPresetId(input.request.target.processProfileId) &&
    Object.keys(input.processSettingOverrides).length > 0

  const metadata = buildSlicedArtifactMetadata(input.request, input.profileFiles)

  // A previous slice's nozzle groups crash the CLI at load on every printer: see
  // `stale-slice-info.ts`. Worth a rewrite on its own, so it joins the gate below rather than
  // riding along only when something else already needed one.
  const sliceInfoXml = await readZipEntryText(input.inputPath, 'Metadata/slice_info.config').catch(() => '')
  const hasStaleNozzleGroups = sliceInfoCarriesNozzleGroupIds(sliceInfoXml)

  // Whether the project SETTINGS are being rewritten, which is a different question from whether a
  // new file is being written: a slice_info-only sanitize produces a copy whose settings are
  // untouched. The distinction is load-bearing: `rewroteProjectSettings` drops the machine profile
  // from `--load-settings` (`cli-profile-selection.ts`), correct only when the copy carries a
  // retargeted/identity-stamped machine of its own.
  const rewritesProjectSettings = Boolean(metadata) || Boolean(machineSwitchProfile)
    || input.stripEmbeddedProfileRefs || applyEmbeddedProcessOverrides

  if (!rewritesProjectSettings && !hasStaleNozzleGroups) {
    return {
      inputPath: input.inputPath,
      rewroteProjectSettings: false,
      manualFilamentMap: null
    }
  }
  // The slicer CLI reads `filament_map_mode` from model_settings.config (per plate),
  // not project_settings.config, so a manual nozzle choice must be forced there or the
  // CLI auto-assigns nozzles for flush and ignores the chosen Left/Right. The MAP that goes
  // with that mode is a separate matter: the CLI ignores it in both configs and only reads
  // `--filament-map`, so the assignment is also returned for the CLI args (see
  // `filament-map-args.ts`, without the flag the slice aborts on a garbage extruder id).
  // Build the per-plate Manual map from the same assignment we write into project_settings, against
  // the TARGET machine's extruder map when the project is being retargeted (the source's
  // single-nozzle map would otherwise suppress the assignment on a switch to dual-nozzle).
  const nozzleAssignmentSettings = projectSettings && machineSwitchProfile
    ? { ...projectSettings, physical_extruder_map: machineSwitchProfile.physical_extruder_map }
    : projectSettings
  const manualNozzle = metadata && nozzleAssignmentSettings
    ? buildManualNozzleAssignment(nozzleAssignmentSettings, metadata.filamentByProjectId)
    : null
  const modelSettingsTransform = manualNozzle
    ? (xml: string) => applyManualFilamentMapToModelSettings(xml, manualNozzle.filament_map.join(' '))
    : undefined
  // A colour change makes the source's embedded plate previews stale (they were rendered
  // with the OLD colours), and because the colours are rewritten into the project below,
  // the CLI's own filament_color_changed check can never notice. Drop the previews from
  // the prepared copy instead: a GL-capable runtime re-renders them into the sliced output
  // (see bambu-studio-cli.sh), and one that cannot render leaves them missing for
  // `backfillPlateThumbnails` to restore from the ORIGINAL input, today's behaviour.
  const stripStalePlatePreviews = Boolean(metadata && projectSettings && metadataChangesFilamentColours(projectSettings, metadata))
  const hasEmbeddedProjectSettings = await rewriteThreeMfProjectSettings(input.inputPath, input.outputPath, (settings) => {
    let rewrittenSettings = settings
    if (machineSwitchProfile && machineSwitchProfileName) {
      rewrittenSettings = retargetProjectSettingsToMachine(rewrittenSettings, machineSwitchProfile, {
        printerSettingsId: machineSwitchProfileName,
        printerModel: firstProfileString(machineSwitchProfile.printer_model) ?? deriveModelFromMachineName(machineSwitchProfileName)
      })
    }
    if (metadata) rewrittenSettings = rewriteProjectSettingsMetadata(rewrittenSettings, metadata)
    if (input.stripEmbeddedProfileRefs) rewrittenSettings = stripEmbeddedProfileRefs(rewrittenSettings)
    if (applyEmbeddedProcessOverrides) rewrittenSettings = mergeProcessOverridesIntoProjectSettings(rewrittenSettings, input.processSettingOverrides)
    return rewrittenSettings
  }, {
    modelSettingsTransform,
    sliceInfoTransform: hasStaleNozzleGroups ? stripSliceInfoNozzleGroupIds : undefined,
    omitEntry: stripStalePlatePreviews ? isPlatePreviewEntry : undefined
  })
  if (hasStaleNozzleGroups) {
    appendStructuredOutput(input.outputLines, 'system', 'Dropped a previous slice\'s nozzle groups from slice_info.config')
  }
  if (stripStalePlatePreviews) {
    appendStructuredOutput(input.outputLines, 'system', 'Filament colours changed; dropped the source\'s plate previews so fresh ones can be rendered')
  }
  if (!hasEmbeddedProjectSettings) {
    // No embedded settings means the Manual mode this assignment depends on was never written:
    // passing the map on the CLI would pin an assignment the plate never asked for. Keep the
    // rewritten copy anyway when it carries the stale-nozzle-group fix, which is what stands
    // between this file and a SIGSEGV at load.
    return {
      inputPath: hasStaleNozzleGroups ? input.outputPath : input.inputPath,
      rewroteProjectSettings: false,
      manualFilamentMap: null
    }
  }
  if (machineSwitchProfile && machineSwitchProfileName) {
    appendStructuredOutput(input.outputLines, 'system', `Retargeted project to ${machineSwitchProfileName}`)
    // The retarget preserves the source layout; shift plates onto a larger target bed
    // so multi-plate projects don't land outside their plate regions (CLI exit 206).
    await recenterRepairedProjectForLargerBed(input.outputPath, input.inputPath, {
      slicerTarget: input.slicerTarget,
      machineSwitchProfileName,
      outputLines: input.outputLines
    })
  }
  return {
    inputPath: input.outputPath,
    rewroteProjectSettings: rewritesProjectSettings,
    manualFilamentMap: manualNozzle?.filament_map ?? null
  }
}

/** First non-empty string from a BambuStudio profile value (string or string array). */
function firstProfileString(value: unknown): string | null {
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

export function shouldStripEmbeddedProfileRefs(request: z.infer<typeof sliceEnvelopeSchema>['request']): boolean {
  return request.target.mode === 'manualProfile' && request.target.printerProfileId === FALLBACK_MANUAL_MACHINE_PROFILE_ID
}

function stripEmbeddedProfileRefs(settings: Record<string, unknown>): Record<string, unknown> {
  const next = { ...settings }
  // Legacy workers can re-load incompatible machine_full presets from project ids.
  // Clearing these references lets CLI resolve neutral defaults instead.
  next.printer_settings_id = ''
  next.print_settings_id = ''
  next.print_compatible_printers = []
  return next
}

/**
 * Merges process-setting overrides into a 3MF's embedded project_settings.config.
 * Used for project-embedded process profiles, whose effective process config is
 * the project settings themselves (no separate preset file is loaded).
 */
function mergeProcessOverridesIntoProjectSettings(
  settings: Record<string, unknown>,
  overrides: Record<string, string | string[]>
): Record<string, unknown> {
  const next = { ...settings }
  for (const [key, value] of Object.entries(overrides)) next[key] = value
  return next
}

async function readMergedMachineProfile(profileDir: string, machineProfileName: string): Promise<Record<string, unknown>> {
  const records = new Map<string, Record<string, unknown>>()

  const readProfileRecord = async (profileName: string): Promise<void> => {
    if (records.has(profileName)) return
    const filePath = path.join(profileDir, 'machine_full', `${sanitizeProfileFileName(profileName)}.json`)
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
    records.set(profileName, parsed)
    const inherits = typeof parsed.inherits === 'string' && parsed.inherits.trim().length > 0 ? parsed.inherits.trim() : null
    if (inherits) {
      await readProfileRecord(inherits)
    }
    const includes = Array.isArray(parsed.include)
      ? parsed.include.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
    for (const includeName of includes) {
      await readProfileRecord(includeName)
    }
  }

  await readProfileRecord(machineProfileName)
  return mergeInheritedMachineProfile(machineProfileName, records)
}
