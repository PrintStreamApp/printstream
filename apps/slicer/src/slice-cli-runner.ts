/**
 * Execute one slice after the 3MF input is prepared.
 *
 * This module owns runtime profile materialization, the CLI invocation, and the multi-plate
 * fallback. The HTTP entrypoint owns request bounds, cancellation signals, and response streaming.
 * Prepared projects skip legacy profile and project-settings authoring by policy.
 */
import path from 'node:path'
import { type SlicingOutputLine, type SlicingPresetFile } from '@printstream/shared'
import { mergeAllPlateOutputs, readPlateIdsFromModelSettings, resolveAllPlateExecutionModel, shouldUseAllPlateMergeFallback } from './all-plate-fallback.js'
import { buildCliArgs, ensurePositionalInputArgument, insertArgsBeforePositionalInput, splitArgsTemplate, stripUnsupportedFlagArguments } from './cli-args.js'
import { executeCli } from './cli-process.js'
import { prepareProfileArgs } from './cli-profile-materialization.js'
import { selectCliProfileFiles, selectPreparedRuntimeProfileFiles, selectSettingsExportProfileFiles } from './cli-profile-selection.js'
import { env } from './env.js'
import { buildFilamentMapArgs } from './filament-map-args.js'
import { type FilamentSlotRequest } from './filament-slot-coverage.js'
import { type SlicedArtifactMetadata } from './output-metadata.js'
import { slicerInputPolicy } from './prepared-input-policy.js'
import { ensureEmbeddedProjectSettings } from './project-settings-fallback.js'
import { buildSkipObjectsArgs, deriveSkipObjectIdentifyIds } from './skip-objects.js'
import { appendStructuredOutput } from './slice-output.js'
import { normalizeCliOutput } from './slice-output-files.js'
import { type RuntimeSlicerTarget } from './slicer-targets.js'

export async function runCli(input: {
  slicerTarget: RuntimeSlicerTarget
  inputPath: string
  outputPath: string
  outputFileName: string
  outputLines: SlicingOutputLine[]
  plate: number
  profileFiles: SlicingPresetFile[]
  processSettingOverrides: Record<string, string | string[]>
  /** Project-local machine overrides, applied onto the MACHINE preset file for the same reason. */
  machineSettingOverrides: Record<string, string | string[]>
  filamentSettingOverrides: Record<string, string | string[]>
  /** Per-material "tune" overrides keyed by 1-based project filament SLOT (from the material dialog). */
  perMaterialFilamentOverrides: Record<number, Record<string, string | string[]>>
  /** The request's filament mappings, one per project slot; drives `--load-filaments` coverage. */
  filamentSlots: readonly FilamentSlotRequest[]
  metadata: SlicedArtifactMetadata | null
  supportedFlags: ReadonlySet<string>
  rewroteProjectSettings: boolean
  /** Manual dual-nozzle assignment to pin on the CLI; null when nozzle mode stays automatic. */
  manualFilamentMap: string[] | null
  /** The request's explicit "slice it anyway" for a project newer than this engine. */
  allowNewerProjectFile: boolean
  /** Whether the browser already authored the complete project handed to the engine. */
  inputPolicy: ReturnType<typeof slicerInputPolicy>
  /** API-resolved model used only for engine strategy, never project metadata authoring. */
  executionPrinterModel: string | null
  bambuHomeDir: string
  bambuConfigDir: string
  bambuCacheDir: string
  bambuDataDir: string
  jobKey: string
  jobTempDir: string
  maxOutputBytes: number
  /** Aborted when the API client cancels the slice; kills the CLI child so the slot frees. */
  signal?: AbortSignal
}): Promise<void> {
  const supportedFlags = input.supportedFlags
  const cliProfileFiles = input.inputPolicy.loadRequestProfiles
    ? selectCliProfileFiles(input.profileFiles, { rewroteProjectSettings: input.rewroteProjectSettings })
    : selectPreparedRuntimeProfileFiles(input.profileFiles)
  const profileArgs = input.inputPolicy.loadRequestProfiles || cliProfileFiles.length > 0
    ? await prepareProfileArgs({
        profileFiles: cliProfileFiles,
        workDir: path.dirname(input.outputPath),
        profileDir: input.slicerTarget.profileDir,
        inputPath: input.inputPath,
        filamentSlots: input.filamentSlots,
        processSettingOverrides: input.processSettingOverrides,
        machineSettingOverrides: input.machineSettingOverrides,
        filamentSettingOverrides: input.filamentSettingOverrides,
        perMaterialFilamentOverrides: input.perMaterialFilamentOverrides,
        includeFilamentProfiles: input.inputPolicy.loadRequestProfiles,
        log: (message) => appendStructuredOutput(input.outputLines, 'system', message)
      })
    : []
  // A "from scratch" scaffold 3MF (calibration prints, new-project saves) carries the BBL marker
  // but no, or only a partial, embedded project_settings.config, which segfaults the CLI's
  // BBL-project loader. Synthesize/complete it from the slice's own profiles so it loads; a no-op
  // for real projects that already embed a complete one. Runs before the all-plate branch so a
  // multi-plate scaffold's per-plate slices load too.
  //
  // The export gets its OWN arg set: it loads no 3MF, so unlike the slice it needs the machine
  // profile handed to it explicitly (see `selectSettingsExportProfileFiles`). Only re-materialized
  // when the slice's selection actually dropped something, and silently: the caller already
  // logged whatever `prepareProfileArgs` had to say about this same file set.
  const exportProfileFiles = input.inputPolicy.ensureEmbeddedProjectSettings
    ? selectSettingsExportProfileFiles(input.profileFiles)
    : []
  let exportProfileArgs: string[] = []
  if (input.inputPolicy.ensureEmbeddedProjectSettings) {
    exportProfileArgs = exportProfileFiles.length === cliProfileFiles.length
      ? profileArgs
      : await prepareProfileArgs({
        profileFiles: exportProfileFiles,
        workDir: path.dirname(input.outputPath),
        profileDir: input.slicerTarget.profileDir,
        inputPath: input.inputPath,
        filamentSlots: input.filamentSlots,
        processSettingOverrides: input.processSettingOverrides,
        machineSettingOverrides: input.machineSettingOverrides,
        filamentSettingOverrides: input.filamentSettingOverrides,
        perMaterialFilamentOverrides: input.perMaterialFilamentOverrides
      })
  }
  const preparedInputPath = input.inputPolicy.ensureEmbeddedProjectSettings
    ? await ensureEmbeddedProjectSettings({
        inputPath: input.inputPath,
        cliPath: input.slicerTarget.cliPath,
        appDir: input.slicerTarget.appDir ?? null,
        profileArgs: exportProfileArgs,
        profileDir: input.slicerTarget.profileDir,
        workDir: path.dirname(input.outputPath),
        env: {
          ...process.env,
          HOME: input.bambuHomeDir,
          XDG_CONFIG_HOME: input.bambuConfigDir,
          XDG_CACHE_HOME: input.bambuCacheDir,
          XDG_DATA_HOME: input.bambuDataDir
        },
        engineJobKey: input.jobKey,
        log: (message) => appendStructuredOutput(input.outputLines, 'system', message),
        signal: input.signal
      })
    : input.inputPath
  if (shouldUseAllPlateMergeFallback({
    plate: input.plate,
    outputFileName: input.outputFileName,
    printerModel: resolveAllPlateExecutionModel(
      input.executionPrinterModel,
      input.metadata?.printerModel ?? null
    )
  })) {
    const plateIds = await readPlateIdsFromModelSettings(preparedInputPath)
    if (plateIds.length > 1) {
      await runMergedAllPlateFallback({
        ...input,
        inputPath: preparedInputPath,
        plateIds,
        profileArgs
      })
      return
    }
  }
  const templateArgs = ensurePositionalInputArgument(
    stripUnsupportedFlagArguments(
      splitArgsTemplate(input.slicerTarget.cliArgsTemplate ?? env.SLICER_CLI_ARGS_TEMPLATE ?? '').map((value) => {
        return value
          .replaceAll('{input}', preparedInputPath)
          .replaceAll('{output}', input.outputPath)
          .replaceAll('{outputDir}', path.dirname(input.outputPath))
          .replaceAll('{outputFileName}', input.outputFileName)
          .replaceAll('{plate}', String(input.plate))
          .replaceAll('{plateZeroBased}', String(Math.max(0, input.plate - 1)))
          .replaceAll('{homeDir}', input.bambuHomeDir)
          .replaceAll('{configDir}', input.bambuConfigDir)
          .replaceAll('{cacheDir}', input.bambuCacheDir)
          .replaceAll('{dataDir}', input.bambuDataDir)
      }),
      supportedFlags,
      ['--export-json']
    ),
    preparedInputPath
  )
  // Per-object selection: objects the user deselected (print/slice dialog or editor Printable
  // toggle) arrive as build items marked printable="0". The CLI only honors that via --skip-objects
  // (by identify_id), so translate it here. Empty when nothing is excluded.
  const skipObjectArgs = buildSkipObjectsArgs(await deriveSkipObjectIdentifyIds(preparedInputPath))
  // Manual dual-nozzle assignment: only the CLI flag makes it take effect (filament-map-args.ts).
  const filamentMapArgs = buildFilamentMapArgs(input.manualFilamentMap)
  // The user was warned this project is newer than the engine and chose to slice anyway; without
  // the flag BambuStudio refuses to open it at all (exit 232). Never inferred, only ever set from
  // the request's explicit acknowledgement, because bypassing the vendor's version gate can let an
  // older engine silently misread newer settings.
  const allowNewerFileArgs = input.allowNewerProjectFile && supportedFlags.has('--allow-newer-file')
    ? ['--allow-newer-file']
    : []
  if (input.allowNewerProjectFile && allowNewerFileArgs.length === 0) {
    // The user accepted the override but this engine has no such flag, so the slice will still be
    // refused. Say so, or the failure looks like the acknowledgement was ignored at random.
    console.warn('[slicer] allowNewerProjectFile requested but this engine does not support --allow-newer-file; the project version refusal still applies')
  }
  const args = insertArgsBeforePositionalInput(templateArgs, preparedInputPath, [
    ...profileArgs,
    ...skipObjectArgs,
    ...filamentMapArgs,
    ...allowNewerFileArgs
  ])

  await executeCli({
    slicerTarget: input.slicerTarget,
    args,
    outputPath: input.outputPath,
    outputLines: input.outputLines,
    supportedFlags,
    bambuHomeDir: input.bambuHomeDir,
    bambuConfigDir: input.bambuConfigDir,
    bambuCacheDir: input.bambuCacheDir,
    bambuDataDir: input.bambuDataDir,
    jobKey: input.jobKey,
    jobTempDir: input.jobTempDir,
    maxOutputBytes: input.maxOutputBytes,
    signal: input.signal
  })
}

async function runMergedAllPlateFallback(input: {
  slicerTarget: RuntimeSlicerTarget
  inputPath: string
  outputPath: string
  outputFileName: string
  outputLines: SlicingOutputLine[]
  plate: number
  plateIds: number[]
  profileFiles: SlicingPresetFile[]
  profileArgs: string[]
  metadata: SlicedArtifactMetadata | null
  supportedFlags: ReadonlySet<string>
  /** Manual dual-nozzle assignment to pin on the CLI; null when nozzle mode stays automatic. */
  manualFilamentMap: string[] | null
  bambuHomeDir: string
  bambuConfigDir: string
  bambuCacheDir: string
  bambuDataDir: string
  jobKey: string
  jobTempDir: string
  maxOutputBytes: number
  /** Client-cancel signal, forwarded to executeCli to kill the CLI child. */
  signal?: AbortSignal
}): Promise<void> {
  const workDir = path.dirname(input.outputPath)
  const plateOutputs: Array<{ plate: number; filePath: string }> = []

  appendStructuredOutput(input.outputLines, 'system', 'Slicing each plate separately for combined export')
  for (const plateId of input.plateIds) {
    const plateOutputFileName = buildMergedPlateOutputFileName(input.outputFileName, plateId)
    const plateOutputPath = path.join(workDir, plateOutputFileName)
    appendStructuredOutput(input.outputLines, 'system', `Slicing plate ${plateId} of ${input.plateIds.length}`)
    const args = buildCliArgs({
      slicerTarget: input.slicerTarget,
      inputPath: input.inputPath,
      outputPath: plateOutputPath,
      outputFileName: plateOutputFileName,
      plate: plateId,
      supportedFlags: input.supportedFlags,
      profileArgs: input.profileArgs,
      manualFilamentMap: input.manualFilamentMap,
      removedFlags: ['--export-json'],
      removedStandaloneFlags: [],
      bambuHomeDir: input.bambuHomeDir,
      bambuConfigDir: input.bambuConfigDir,
      bambuCacheDir: input.bambuCacheDir,
      bambuDataDir: input.bambuDataDir
    })
    await executeCli({
      slicerTarget: input.slicerTarget,
      args,
      outputPath: plateOutputPath,
      outputLines: input.outputLines,
      supportedFlags: input.supportedFlags,
      bambuHomeDir: input.bambuHomeDir,
      bambuConfigDir: input.bambuConfigDir,
      bambuCacheDir: input.bambuCacheDir,
      bambuDataDir: input.bambuDataDir,
      jobKey: input.jobKey,
      jobTempDir: input.jobTempDir,
      maxOutputBytes: input.maxOutputBytes,
      signal: input.signal
    })
    await normalizeCliOutput({
      outputPath: plateOutputPath,
      outputDir: workDir,
      outputFileName: plateOutputFileName,
      metadata: input.metadata
    })
    plateOutputs.push({ plate: plateId, filePath: plateOutputPath })
  }

  appendStructuredOutput(input.outputLines, 'system', 'Combining per-plate exports into a single project artifact')
  await mergeAllPlateOutputs({
    outputPath: input.outputPath,
    plateOutputs
  })
}

function buildMergedPlateOutputFileName(outputFileName: string, plate: number): string {
  const dotIndex = outputFileName.indexOf('.')
  if (dotIndex < 0) return `${outputFileName}-plate-${plate}`
  return `${outputFileName.slice(0, dotIndex)}-plate-${plate}${outputFileName.slice(dotIndex)}`
}
