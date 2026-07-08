/**
 * Standalone slicer runtime.
 *
 * This process is intentionally separate from the API and bridge. The API
 * handles tenants, permissions, queueing, and library persistence; this
 * service owns multi-version slicer CLI execution.
 */
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import http from 'node:http'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import {
  createSlicingJobSchema,
  extractProfileMetadata,
  isDirectPrintableFileName,
  sliceEnvelopeSchema,
  stringValue,
  type SliceProfileFile,
  type SlicingMaterialUsage,
  type SlicingMetadata,
  type SlicingOutputLine,
  type SlicingProfileKind
} from '@printstream/shared'
import yauzl, { type Entry } from 'yauzl'
import yazl from 'yazl'
import { env } from './env.js'
import { terminateSlicerChild } from './terminate-child.js'
import { outputSignalsSliceComplete } from './slice-progress.js'
import { appendCappedTail, appendOutput, appendStructuredOutput } from './slice-output.js'
import { openZip, readZipEntryBuffer, readZipEntryText } from './zip-io.js'
import { backfillPlateThumbnails, mergeAllPlateOutputs, readPlateIdsFromModelSettings, shouldUseAllPlateMergeFallback } from './all-plate-fallback.js'
import { selectCliProfileFiles } from './cli-profile-selection.js'
import { assertSupportedEmbeddedMachineSwitch, shouldUseEstimateModeMachineSwitch } from './machine-switch-guard.js'
import { buildSkipObjectsArgs, deriveSkipObjectIdentifyIds } from './skip-objects.js'
import { bedSizeFromPrintableArea, buildObjectPlateIndex, recenterBuildItemsXml } from './recenter-plates.js'
import { formatSlicePresetIncompatibilityError } from './slice-error.js'
import { ensureEmbeddedProjectSettings } from './project-settings-fallback.js'
import { mergeInheritedMachineProfile, repairEstimateModeProjectSettings } from './machine-switch-repair.js'
import { applyManualFilamentMapToModelSettings, buildManualNozzleAssignment, buildSlicedArtifactMetadata, rewriteProjectSettingsMetadata, rewriteSliceInfoMetadata, type SlicedArtifactMetadata } from './output-metadata.js'
import { resolveCustomProfileConfig } from './custom-profile-resolve.js'
import { sanitizeProfileFileName } from './profile-file-name.js'
import { sanitizeBuiltinSlicerProfileJson } from './profile-json.js'
import { isVisibleBambuStudioProfile } from './profile-visibility.js'
import { getPublicSlicerTargets, getSlicerTargetRegistry, resolveSlicerTarget, type RuntimeSlicerTarget } from './slicer-targets.js'

const FALLBACK_MANUAL_MACHINE_PROFILE_ID = '__printstream-fallback-manual-machine__'
const MAX_OUTPUT_LINES_HEADER_BYTES = 8 * 1024

const app = express()
app.use(express.json({ limit: '4mb' }))

const activeSliceOutput = new Map<string, SlicingOutputLine[]>()
const cliSupportedFlagsCache = new Map<string, Set<string>>()

app.use((request, response, next) => {
  if (!env.SLICER_SERVICE_TOKEN) {
    next()
    return
  }
  const expected = `Bearer ${env.SLICER_SERVICE_TOKEN}`
  if (request.header('authorization') !== expected) {
    response.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
})

app.get('/health', async (_request, response) => {
  const registry = await getSlicerTargetRegistry()
  const defaultTarget = resolveSlicerTarget(registry)
  response.json({
    name: defaultTarget?.label ?? 'PrintStream slicer',
    configured: registry.targets.length > 0,
    defaultTargetId: registry.defaultTargetId,
    targets: getPublicSlicerTargets(registry)
  })
})

app.get('/profiles', async (request, response) => {
  const registry = await getSlicerTargetRegistry()
  const targetId = typeof request.query.targetId === 'string' ? request.query.targetId : null
  const target = resolveSlicerTarget(registry, targetId)
  if (!target) {
    response.status(400).json({ error: targetId ? 'Unknown slicer target' : 'No slicer targets are configured' })
    return
  }
  response.json({ profiles: await listBuiltinProfiles(target.profileDir) })
})

const resolveProcessConfigSchema = z.object({
  source: z.enum(['builtin', 'custom']),
  /** Profile kind to resolve. Defaults to 'process' for backward compatibility. */
  kind: z.enum(['machine', 'process', 'filament']).optional(),
  name: z.string().trim().min(1),
  content: z.string().optional()
})

/**
 * Resolves a process profile to its fully-merged config map (following the
 * `inherits` chain for builtin presets, or merging a custom diff onto its
 * system base). The web process-settings editor uses this as the base values
 * the user edits against.
 */
app.post('/profiles/resolve', async (request, response) => {
  const registry = await getSlicerTargetRegistry()
  const targetId = typeof request.query.targetId === 'string' ? request.query.targetId : null
  const target = resolveSlicerTarget(registry, targetId)
  if (!target) {
    response.status(400).json({ error: targetId ? 'Unknown slicer target' : 'No slicer targets are configured' })
    return
  }
  const parsed = resolveProcessConfigSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid resolve payload' })
    return
  }
  const kind = parsed.data.kind ?? 'process'
  try {
    let record: Record<string, unknown>
    if (parsed.data.source === 'builtin') {
      const builtinContent = await readFile(
        path.join(target.profileDir, `${kind}_full`, `${sanitizeProfileFileName(parsed.data.name)}.json`),
        'utf8'
      )
      record = await resolveCustomProfileConfig(builtinContent, kind, target.profileDir)
    } else {
      if (!parsed.data.content) {
        response.status(400).json({ error: `Custom ${kind} profile is missing content` })
        return
      }
      record = await resolveCustomProfileConfig(parsed.data.content, kind, target.profileDir)
    }
    response.json({ config: record })
  } catch (error) {
    response.status(404).json({ error: (error as Error).message || `${kind} profile not found` })
  }
})


app.get('/jobs/:id', (request, response) => {
  const output = activeSliceOutput.get(request.params.id)
  if (!output) {
    response.status(404).json({ error: 'Slice job not found' })
    return
  }
  response.json({ output })
})

app.post('/slice', async (request, response) => {
  const envelope = readSliceEnvelope(request)
  const parsed = sliceEnvelopeSchema.safeParse(envelope)
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid slice payload' })
    return
  }
  const registry = await getSlicerTargetRegistry()
  const slicerTarget = resolveSlicerTarget(registry, parsed.data.request.slicerTargetId ?? null)
  if (!slicerTarget) {
    response.status(503).json({ error: 'No slicer targets are configured' })
    return
  }

  const workDir = path.join(env.SLICER_WORK_DIR, parsed.data.jobId.replace(/[^a-zA-Z0-9_-]/g, '_') || randomUUID())
  const bambuHomeDir = path.join(env.SLICER_BAMBUSTUDIO_HOME_DIR, slicerTarget.id)
  const bambuConfigDir = path.join(bambuHomeDir, '.config')
  const bambuCacheDir = path.join(bambuHomeDir, '.cache')
  const bambuDataDir = path.join(env.SLICER_BAMBUSTUDIO_DATA_DIR, slicerTarget.id)
  const inputPath = path.join(workDir, 'input.3mf')
  const outputFileName = normalizeOutputFileName(parsed.data.request.outputFileName ?? buildDefaultOutputFileName(parsed.data.sourceFileName))
  const outputPath = path.join(workDir, outputFileName)
  const outputLines: SlicingOutputLine[] = []
  activeSliceOutput.set(parsed.data.jobId, outputLines)
  // Abort the CLI if the API client genuinely disconnects before we finish responding (a real
  // cancel frees the slot; the CLI would otherwise run to completion unwatched).
  //
  // This MUST listen on the response, not the request: `pipeline(request, …)` below destroys the
  // request stream when the upload completes normally, which emits 'close' on it *while the slice
  // is still running*. Listening on `request` therefore self-cancelled every slice (the handler
  // saw the request close with no response yet and killed the CLI). The response only emits
  // 'close' before `writableFinished` on an actual client disconnect.
  const cliAbort = new AbortController()
  // Register cleanup EAGERLY (before any await): on a genuine cancel/disconnect the response 'close'
  // fires while we're still slicing, so a cleanup listener added later (e.g. in `finally`) would be
  // installed after 'close' already emitted and never run — leaking the work dir + activeSliceOutput
  // on every cancel/timeout until the shared volume fills. One listener covers cancel, error, and
  // success: `writableFinished` is false only on a real client disconnect (so we abort the CLI then),
  // and cleanup always runs once the response closes for any reason.
  let workDirCleaned = false
  const cleanupWorkDir = () => {
    if (workDirCleaned) return
    workDirCleaned = true
    activeSliceOutput.delete(parsed.data.jobId)
    void rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
  response.on('close', () => {
    if (!response.writableFinished) cliAbort.abort()
    cleanupWorkDir()
  })
  try {
    appendStructuredOutput(outputLines, 'system', 'Receiving slicing input')
    await Promise.all([
      mkdir(workDir, { recursive: true }),
      mkdir(bambuConfigDir, { recursive: true }),
      mkdir(bambuCacheDir, { recursive: true }),
      mkdir(bambuDataDir, { recursive: true })
    ])
    const supportedFlags = await getSupportedCliFlags(slicerTarget, {
      bambuHomeDir,
      bambuConfigDir,
      bambuCacheDir,
      bambuDataDir
    })
    await pipeline(request, createWriteStream(inputPath))
    appendStructuredOutput(outputLines, 'system', 'Preparing slicing project')
    const preparedInput = await prepareInputThreeMf({
      inputPath,
      outputPath: path.join(workDir, 'input.materials.3mf'),
      request: parsed.data.request,
      profileFiles: parsed.data.profileFiles ?? [],
      stripEmbeddedProfileRefs: shouldStripEmbeddedProfileRefs(parsed.data.request),
      processSettingOverrides: parsed.data.request.target.processSettingOverrides ?? {},
      supportedFlags
    })
    const slicedArtifactMetadata = buildSlicedArtifactMetadata(parsed.data.request, parsed.data.profileFiles ?? [])
    appendStructuredOutput(outputLines, 'system', 'Launching slicer CLI')
    await runCli({
      slicerTarget,
      inputPath: preparedInput.inputPath,
      outputPath,
      outputFileName,
      outputLines,
      plate: parsed.data.request.plate,
      profileFiles: parsed.data.profileFiles ?? [],
      processSettingOverrides: parsed.data.request.target.processSettingOverrides ?? {},
      filamentSettingOverrides: parsed.data.request.target.filamentSettingOverrides ?? {},
      metadata: slicedArtifactMetadata,
      supportedFlags,
      rewroteProjectSettings: preparedInput.rewroteProjectSettings,
      useEstimateModeMachineSwitch: preparedInput.useEstimateModeMachineSwitch,
      machineSwitchProfileName: preparedInput.machineSwitchProfileName,
      bambuHomeDir,
      bambuConfigDir,
      bambuCacheDir,
      bambuDataDir,
      signal: cliAbort.signal
    })
    appendStructuredOutput(outputLines, 'system', 'Collecting sliced artifact')
    await normalizeCliOutput({
      outputPath,
      outputDir: workDir,
      outputFileName,
      metadata: slicedArtifactMetadata
    })
    // All-plate export of an editor-arranged project can omit the per-plate model thumbnails;
    // backfill any missing plate_N.png from the input so the library shows the model, not a
    // toolpath fallback / kind label. No-op for single-plate slices (they already have one).
    if (outputFileName.toLowerCase().endsWith('.3mf')) {
      await backfillPlateThumbnails(outputPath, inputPath)
    }
    if (outputFileName.toLowerCase().endsWith('.gcode')) {
      const extracted = await extractGcodeFromPackagedOutput(outputPath)
      if (!extracted) {
        throw new Error('Requested .gcode output, but slicer did not produce a plain gcode payload')
      }
    }
    const info = await stat(outputPath)
    if (!info.isFile() || info.size <= 0) throw new Error('Slicer did not produce an output file')
    if (!isDirectPrintableFileName(outputFileName)) throw new Error('Slicer output must be .gcode or .gcode.3mf')

    // Try to read metadata from JSON export
    const metadata = await tryReadSlicingMetadata(workDir, outputFileName)

    response.setHeader('Content-Type', 'application/octet-stream')
    response.setHeader('Content-Length', String(info.size))
    response.setHeader('X-PrintStream-Output-File-Name', encodeURIComponent(outputFileName))
    response.setHeader('X-PrintStream-Output-Lines', buildOutputLinesHeader(outputLines))
    if (metadata) {
      response.setHeader('X-PrintStream-Metadata', Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url'))
    }
    // `.pipe()` does not forward source errors, and an unhandled 'error' on the read stream would
    // throw and crash the whole slicer process (taking down every other in-flight slice). After the
    // headers are flushed we can't send a 500, so destroy the response to fail just this request.
    const outputStream = createReadStream(outputPath)
    outputStream.on('error', (error) => {
      console.error(`[slice ${parsed.data.jobId}] output stream error: ${(error as Error).message}`)
      response.destroy(error)
    })
    outputStream.pipe(response)
  } catch (error) {
    console.error(`[slice ${parsed.data.jobId}] failed: ${(error as Error).message}`)
    const tail = outputLines
      .filter((line) => line.stream === 'stderr' || line.stream === 'stdout')
      .slice(-10)
      .map((line) => line.text)
      .join('\n')
    if (tail) {
      console.error(`[slice ${parsed.data.jobId}] output tail:\n${tail}`)
    }
    response.status(500).json({
      error: (error as Error).message || 'Slicing failed',
      output: outputLines
    })
  } finally {
    // Work-dir + activeSliceOutput cleanup is registered eagerly on the response 'close' listener
    // above (it must precede any await so a mid-slice cancel still triggers it). Nothing to do here.
  }
})

function readSliceEnvelope(request: Request): unknown {
  const header = request.header('x-printstream-slice-request')
  if (!header) return null
  try {
    return JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

async function runCli(input: {
  slicerTarget: RuntimeSlicerTarget
  inputPath: string
  outputPath: string
  outputFileName: string
  outputLines: SlicingOutputLine[]
  plate: number
  profileFiles: SliceProfileFile[]
  processSettingOverrides: Record<string, string | string[]>
  filamentSettingOverrides: Record<string, string | string[]>
  metadata: SlicedArtifactMetadata | null
  supportedFlags: ReadonlySet<string>
  rewroteProjectSettings: boolean
  useEstimateModeMachineSwitch: boolean
  machineSwitchProfileName: string | null
  bambuHomeDir: string
  bambuConfigDir: string
  bambuCacheDir: string
  bambuDataDir: string
  /** Aborted when the API client cancels the slice; kills the CLI child so the slot frees. */
  signal?: AbortSignal
}): Promise<void> {
  const supportedFlags = input.supportedFlags
  const cliProfileFiles = selectCliProfileFiles(input.profileFiles, {
    rewroteProjectSettings: input.rewroteProjectSettings,
    useEstimateModeMachineSwitch: input.useEstimateModeMachineSwitch
  })
  const profileArgs = await prepareProfileArgs(cliProfileFiles, path.dirname(input.outputPath), input.slicerTarget.profileDir, input.processSettingOverrides, input.filamentSettingOverrides)
  if (shouldUseAllPlateMergeFallback({
    plate: input.plate,
    outputFileName: input.outputFileName,
    printerModel: input.metadata?.printerModel ?? null
  })) {
    const plateIds = await readPlateIdsFromModelSettings(input.inputPath)
    if (plateIds.length > 1) {
      await runMergedAllPlateFallback({
        ...input,
        plateIds,
        profileArgs
      })
      return
    }
  }
  if (input.useEstimateModeMachineSwitch) {
    if (!input.machineSwitchProfileName) {
      throw new Error('Machine-switch slicing requires a target machine profile name')
    }
    const machineSwitchProfileName = input.machineSwitchProfileName
    await runEstimateModeMachineSwitch({
      ...input,
      machineSwitchProfileName,
      profileArgs
    })
    return
  }

  const machineSwitchArgs = input.useEstimateModeMachineSwitch && supportedFlags.has('--estimate-mode')
    ? ['--estimate-mode']
    : []
  // A "from scratch" scaffold 3MF (calibration prints) carries the BBL marker but no embedded
  // project_settings.config, which segfaults the CLI's BBL-project loader. Synthesize one from the
  // slice's own profiles so it loads; a no-op for real projects that already embed it.
  const preparedInputPath = await ensureEmbeddedProjectSettings({
    inputPath: input.inputPath,
    cliPath: input.slicerTarget.cliPath,
    appDir: input.slicerTarget.appDir ?? null,
    profileArgs,
    workDir: path.dirname(input.outputPath),
    env: {
      ...process.env,
      HOME: input.bambuHomeDir,
      XDG_CONFIG_HOME: input.bambuConfigDir,
      XDG_CACHE_HOME: input.bambuCacheDir,
      XDG_DATA_HOME: input.bambuDataDir
    },
    log: (message) => appendStructuredOutput(input.outputLines, 'system', message),
    signal: input.signal
  })
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
  const inputArgIndex = templateArgs.indexOf(preparedInputPath)
  const args = inputArgIndex >= 0
    ? [...templateArgs.slice(0, inputArgIndex), ...machineSwitchArgs, ...profileArgs, ...skipObjectArgs, ...templateArgs.slice(inputArgIndex)]
    : [...templateArgs, ...machineSwitchArgs, ...profileArgs, ...skipObjectArgs]

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
  profileFiles: SliceProfileFile[]
  profileArgs: string[]
  metadata: SlicedArtifactMetadata | null
  supportedFlags: ReadonlySet<string>
  useEstimateModeMachineSwitch: boolean
  machineSwitchProfileName: string | null
  bambuHomeDir: string
  bambuConfigDir: string
  bambuCacheDir: string
  bambuDataDir: string
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
      machineSwitchArgs: [],
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

/**
 * Two-pass cross-model retarget for jobs that land on an H2-family multi-extruder
 * machine: `--estimate-mode` export, then `repairEstimateModeProjectSettings`, then
 * a clean `--slice` of the repaired 3MF. The split is mandatory — a single-pass
 * `--slice` (with or without `--estimate-mode`) segfaults on a cross-model switch
 * into H2. See docs/slicer-cross-model-machine-switch.md for the rationale and the
 * empirical crash matrix.
 */
interface MachineSwitchExportInput {
  slicerTarget: RuntimeSlicerTarget
  inputPath: string
  outputPath: string
  outputFileName: string
  outputLines: SlicingOutputLine[]
  plate: number
  profileFiles: SliceProfileFile[]
  profileArgs: string[]
  metadata: SlicedArtifactMetadata | null
  supportedFlags: ReadonlySet<string>
  machineSwitchProfileName: string
  bambuHomeDir: string
  bambuConfigDir: string
  bambuCacheDir: string
  bambuDataDir: string
  /** Client-cancel signal, forwarded to executeCli to kill the CLI child. */
  signal?: AbortSignal
}

async function runEstimateModeMachineSwitch(input: MachineSwitchExportInput): Promise<void> {
  // Two-pass cross-model switch: export+repair the project to the target machine, then slice it.
  const repairedOutputPath = await exportRepairedMachineSwitchProject(input)

  appendStructuredOutput(input.outputLines, 'system', 'Slicing normalized project')
  const sliceArgs = buildCliArgs({
    slicerTarget: input.slicerTarget,
    inputPath: repairedOutputPath,
    outputPath: input.outputPath,
    outputFileName: input.outputFileName,
    plate: input.plate,
    supportedFlags: input.supportedFlags,
    profileArgs: [],
    machineSwitchArgs: [],
    removedFlags: ['--export-json'],
    removedStandaloneFlags: [],
    bambuHomeDir: input.bambuHomeDir,
    bambuConfigDir: input.bambuConfigDir,
    bambuCacheDir: input.bambuCacheDir,
    bambuDataDir: input.bambuDataDir
  })
  await executeCli({
    slicerTarget: input.slicerTarget,
    args: sliceArgs,
    outputPath: input.outputPath,
    outputLines: input.outputLines,
    supportedFlags: input.supportedFlags,
    bambuHomeDir: input.bambuHomeDir,
    bambuConfigDir: input.bambuConfigDir,
    bambuCacheDir: input.bambuCacheDir,
    bambuDataDir: input.bambuDataDir,
    signal: input.signal
  })
}

/**
 * First half of the cross-model machine switch: run BambuStudio's `--estimate-mode`
 * export, then reconcile the multi-extruder topology it leaves inconsistent
 * ({@link repairEstimateModeProjectSettings}). Returns the path to a retargeted,
 * self-consistent **project** 3MF. Both slicing (which then slices it) and the
 * editor's "save as a different printer" flow (which returns it) build on this.
 */
async function exportRepairedMachineSwitchProject(input: MachineSwitchExportInput): Promise<string> {
  const workDir = path.dirname(input.outputPath)
  const estimateOutputPath = path.join(workDir, 'machine-switch-estimate.3mf')
  const repairedOutputPath = path.join(workDir, 'machine-switch-repaired.3mf')

  appendStructuredOutput(input.outputLines, 'system', 'Normalizing project with upstream machine-switch export')
  const estimateArgs = buildCliArgs({
    slicerTarget: input.slicerTarget,
    inputPath: input.inputPath,
    outputPath: estimateOutputPath,
    outputFileName: path.basename(estimateOutputPath),
    plate: input.plate,
    supportedFlags: input.supportedFlags,
    profileArgs: input.profileArgs,
    machineSwitchArgs: ['--estimate-mode'],
    removedFlags: ['--slice', '--export-json'],
    removedStandaloneFlags: ['--min-save'],
    bambuHomeDir: input.bambuHomeDir,
    bambuConfigDir: input.bambuConfigDir,
    bambuCacheDir: input.bambuCacheDir,
    bambuDataDir: input.bambuDataDir
  })
  await executeCli({
    slicerTarget: input.slicerTarget,
    args: estimateArgs,
    outputPath: estimateOutputPath,
    outputLines: input.outputLines,
    supportedFlags: input.supportedFlags,
    bambuHomeDir: input.bambuHomeDir,
    bambuConfigDir: input.bambuConfigDir,
    bambuCacheDir: input.bambuCacheDir,
    bambuDataDir: input.bambuDataDir,
    signal: input.signal
  })

  await rewriteThreeMfProjectSettings(estimateOutputPath, repairedOutputPath, async (settings) => {
    const mergedMachineProfile = await readMergedMachineProfile(input.slicerTarget.profileDir, input.machineSwitchProfileName)
    const repairedSettings = repairEstimateModeProjectSettings(settings, mergedMachineProfile)
    return input.metadata ? rewriteProjectSettingsMetadata(repairedSettings, input.metadata) : repairedSettings
  })
  const repairedInfo = await stat(repairedOutputPath)
  if (!repairedInfo.isFile() || repairedInfo.size <= 0) {
    throw new Error('Normalized machine-switch project is empty')
  }
  const repairedProjectSettings = await readThreeMfProjectSettings(repairedOutputPath)
  if (!repairedProjectSettings) {
    throw new Error('Normalized machine-switch project is missing project settings')
  }
  await readFile(repairedOutputPath)
  appendStructuredOutput(input.outputLines, 'system', `Normalized project size: ${repairedInfo.size} bytes`)
  await recenterRepairedProjectForLargerBed(repairedOutputPath, path.join(workDir, 'input.3mf'), input)
  return repairedOutputPath
}

/**
 * After the machine-switch repair, shift each plate's objects onto the (larger) target bed so a
 * multi-plate project's non-first plates don't fall outside their plate region (CLI exit 206 /
 * CLI_NO_SUITABLE_OBJECTS). The repaired project already targets the new machine but keeps the source
 * layout, because BambuStudio's CLI only re-centers on a switch it treats as "forced" (an
 * incompatible process), not the normal compatible-process switch this flow performs. We apply
 * BambuStudio's own `translate_models` shift ourselves (see {@link recenterBuildItemsXml}), reading
 * the source bed from the original upload and the target bed from the merged machine profile. A no-op
 * for a same/smaller target bed.
 */
async function recenterRepairedProjectForLargerBed(repairedPath: string, sourcePath: string, input: MachineSwitchExportInput): Promise<void> {
  const sourceSettings = await readThreeMfProjectSettings(sourcePath).catch(() => null)
  const sourceBed = sourceSettings ? bedSizeFromPrintableArea(sourceSettings.printable_area) : null
  const machineProfile = await readMergedMachineProfile(input.slicerTarget.profileDir, input.machineSwitchProfileName).catch(() => null)
  const targetBed = machineProfile ? bedSizeFromPrintableArea(machineProfile.printable_area) : null
  if (!sourceBed || !targetBed) return
  // Only onto a larger bed (source smaller in at least one dim, not smaller in either) — BambuStudio's
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
    undefined,
    (modelXml) => recenterBuildItemsXml(modelXml, objectPlateIndex, plateCount, sourceBed, targetBed)
  )
  await rename(recenteredPath, repairedPath)
  appendStructuredOutput(input.outputLines, 'system', `Re-centered objects onto ${targetBed.width}x${targetBed.depth} bed`)
}

async function getSupportedCliFlags(
  slicerTarget: RuntimeSlicerTarget,
  directories: {
    bambuHomeDir: string
    bambuConfigDir: string
    bambuCacheDir: string
    bambuDataDir: string
  }
): Promise<Set<string>> {
  const cached = cliSupportedFlagsCache.get(slicerTarget.id)
  if (cached) return cached

  const helpText = await new Promise<string>((resolve, reject) => {
    const child = spawn(slicerTarget.cliPath, ['--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SLICER_APPDIR: slicerTarget.appDir ?? process.env.SLICER_APPDIR,
        HOME: directories.bambuHomeDir,
        XDG_CONFIG_HOME: directories.bambuConfigDir,
        XDG_CACHE_HOME: directories.bambuCacheDir,
        XDG_DATA_HOME: directories.bambuDataDir
      }
    })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      const compatibilityError = formatRuntimeCompatibilityError(stderr || stdout)
      if (compatibilityError) {
        console.warn(`[slicer:getSupportedCliFlags] --help probe failed: ${compatibilityError}`)
        reject(new Error(compatibilityError))
        return
      }
      const helpError = stderr.trim() || stdout.trim() || `Slicer CLI help exited with code ${code ?? 'unknown'}`
      console.warn(`[slicer:getSupportedCliFlags] --help probe failed: ${helpError}`)
      reject(new Error(helpError))
    })
  })

  const flags = new Set((helpText.match(/--[a-z0-9-]+/gi) ?? []).map((entry) => entry.toLowerCase()))
  cliSupportedFlagsCache.set(slicerTarget.id, flags)
  return flags
}

async function executeCli(input: {
  slicerTarget: RuntimeSlicerTarget
  args: string[]
  outputPath: string
  outputLines: SlicingOutputLine[]
  supportedFlags: ReadonlySet<string>
  bambuHomeDir: string
  bambuConfigDir: string
  bambuCacheDir: string
  bambuDataDir: string
  /** Aborted on client cancel; kills the CLI child so the slicer slot frees. */
  signal?: AbortSignal
}): Promise<void> {
  let progressPipePath: string | null = null
  let progressPipeReader: ReturnType<typeof createReadStream> | null = null
  const args = [...input.args]
  // Liveness + completion tracking, shared by the CLI stdout/stderr streams and the
  // optional --pipe channel, and read by the stall/success guard in the Promise below.
  let lastOutputAt = Date.now()
  let sliceSucceeded = false
  const noteOutput = (text: string): void => {
    lastOutputAt = Date.now()
    if (!sliceSucceeded && outputSignalsSliceComplete(text)) sliceSucceeded = true
  }
  if (env.SLICER_ENABLE_PIPE_PROGRESS && input.supportedFlags.has('--pipe') && !args.includes('--pipe')) {
    try {
      progressPipePath = path.join(path.dirname(input.outputPath), `${input.slicerTarget.id}-${randomUUID()}.pipe`)
      await rm(progressPipePath, { force: true })
      await mkfifo(progressPipePath)
      progressPipeReader = createReadStream(progressPipePath, { encoding: 'utf8' })
      progressPipeReader.on('data', (chunk: string | Buffer) => {
        const text = String(chunk)
        appendOutput(input.outputLines, 'stdout', text)
        noteOutput(text)
      })
      progressPipeReader.on('error', (error) => {
        appendStructuredOutput(input.outputLines, 'system', `Progress pipe read failed: ${error.message}`)
      })
      args.push('--pipe', progressPipePath)
    } catch (error) {
      appendStructuredOutput(input.outputLines, 'system', `Failed to enable --pipe progress: ${String((error as Error)?.message ?? error)}`)
      if (progressPipePath) await rm(progressPipePath, { force: true }).catch(() => undefined)
      progressPipePath = null
      progressPipeReader = null
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let stderrCombined = ''
      let stdoutCombined = ''
      const child = spawn(input.slicerTarget.cliPath, args, {
        // `detached` makes the child its own process-group leader so termination can
        // signal the whole group — BambuStudio spawns helper processes under Xvfb
        // that a bare child.kill() would orphan.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SLICER_APPDIR: input.slicerTarget.appDir ?? process.env.SLICER_APPDIR,
          HOME: input.bambuHomeDir,
          XDG_CONFIG_HOME: input.bambuConfigDir,
          XDG_CACHE_HOME: input.bambuCacheDir,
          XDG_DATA_HOME: input.bambuDataDir
        }
      })
      // Reset the stall clock to the moment the CLI actually starts.
      lastOutputAt = Date.now()
      // Cancels the SIGTERM->SIGKILL escalation once the child actually exits.
      let cancelTermination: (() => void) | null = null
      let successGraceTimer: ReturnType<typeof setTimeout> | null = null
      const timeout = setTimeout(() => {
        console.warn(`[slicer:executeCli] timed out after ${env.SLICER_TIMEOUT_MS}ms; terminating CLI`)
        cancelTermination = terminateSlicerChild(child)
        reject(new Error('Slicer CLI timed out'))
      }, env.SLICER_TIMEOUT_MS)
      // Stall + completion guard (polled):
      //  - Once BambuStudio reports "All done, Success" the artifact is fully written; give
      //    the process a short grace to exit, then force it (qemu teardown can hang without
      //    ever firing 'close', leaving zombie Xvfb procs) and treat the slice as done.
      //  - Otherwise, if the CLI has produced no output for SLICER_STALL_TIMEOUT_MS it is
      //    wedged (commonly the emulated "Exporting 3mf" step at 97%); terminate and fail
      //    fast rather than waiting out the full SLICER_TIMEOUT_MS.
      const guard = setInterval(() => {
        if (sliceSucceeded) {
          if (!successGraceTimer) {
            successGraceTimer = setTimeout(() => {
              console.warn('[slicer:executeCli] CLI reported success but has not exited; terminating after grace')
              cancelTermination = terminateSlicerChild(child)
              resolve()
            }, env.SLICER_SUCCESS_EXIT_GRACE_MS)
            successGraceTimer.unref?.()
          }
          return
        }
        const idleMs = Date.now() - lastOutputAt
        if (idleMs >= env.SLICER_STALL_TIMEOUT_MS) {
          console.warn(`[slicer:executeCli] no CLI output for ${idleMs}ms; terminating (stalled)`)
          cancelTermination = terminateSlicerChild(child)
          reject(new Error('Slicer stopped responding (no progress). It may have stalled — try slicing again.'))
        }
      }, 5_000)
      guard.unref?.()
      const clearTimers = () => {
        clearTimeout(timeout)
        clearInterval(guard)
        if (successGraceTimer) clearTimeout(successGraceTimer)
      }
      // Client cancel: kill the CLI so it stops occupying a slicer slot (otherwise it runs to
      // completion and the next queued job waits on a zombie).
      const onAbort = () => {
        console.warn('[slicer:executeCli] client cancelled; terminating CLI')
        cancelTermination = terminateSlicerChild(child)
        clearTimers()
        reject(new Error('Slicing cancelled'))
      }
      if (input.signal) {
        if (input.signal.aborted) { onAbort(); return }
        input.signal.addEventListener('abort', onAbort, { once: true })
      }
      const cleanupAbort = () => {
        cancelTermination?.()
        input.signal?.removeEventListener('abort', onAbort)
      }

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdoutCombined = appendCappedTail(stdoutCombined, chunk)
        appendOutput(input.outputLines, 'stdout', chunk)
        noteOutput(chunk)
      })
      child.stderr.on('data', (chunk: string) => {
        stderrCombined = appendCappedTail(stderrCombined, chunk)
        appendOutput(input.outputLines, 'stderr', chunk)
        noteOutput(chunk)
      })
      child.on('error', (error) => {
        clearTimers()
        cleanupAbort()
        reject(error)
      })
      child.on('close', (code) => {
        clearTimers()
        cleanupAbort()
        // Trust BambuStudio's own success marker over a non-zero teardown exit under
        // emulation — the artifact is already fully written.
        if (sliceSucceeded || code === 0) resolve()
        else {
          const stderrTail = stderrCombined.trim().split(/\r?\n/u).filter(Boolean).slice(-5).join(' | ')
          console.warn(
            `[slicer:executeCli] CLI exited with code ${code ?? 'unknown'}${stderrTail ? ` (${stderrTail})` : ''}`
          )
          const compatibilityError = formatRuntimeCompatibilityError(stderrCombined)
          if (compatibilityError) {
            reject(new Error(compatibilityError))
            return
          }
          // BambuStudio reports preset/printer incompatibility on stdout and exits
          // non-zero (code 251); surface its reason instead of the opaque exit code.
          const presetError = formatSlicePresetIncompatibilityError(`${stdoutCombined}\n${stderrCombined}`)
          if (presetError) {
            reject(new Error(presetError))
            return
          }
          reject(new Error(`Slicer CLI exited with code ${code ?? 'unknown'}`))
        }
      })
    })
  } finally {
    progressPipeReader?.destroy()
    if (progressPipePath) {
      await rm(progressPipePath, { force: true }).catch(() => undefined)
    }
  }
}

function stripUnsupportedFlagArguments(args: string[], supportedFlags: ReadonlySet<string>, flagNames: string[]): string[] {
  const unsupportedFlags = new Set(flagNames.map((entry) => entry.toLowerCase()).filter((entry) => !supportedFlags.has(entry)))
  if (unsupportedFlags.size === 0) return args

  const filtered: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (typeof value !== 'string') continue
    if (unsupportedFlags.has(value.toLowerCase())) {
      index += 1
      continue
    }
    filtered.push(value)
  }
  return filtered
}

function stripFlagArguments(args: string[], flagNames: string[]): string[] {
  const removableFlags = new Set(flagNames.map((entry) => entry.toLowerCase()))
  if (removableFlags.size === 0) return args

  const filtered: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (typeof value !== 'string') continue
    if (removableFlags.has(value.toLowerCase())) {
      index += 1
      continue
    }
    filtered.push(value)
  }
  return filtered
}

function stripStandaloneFlags(args: string[], flagNames: string[]): string[] {
  const removableFlags = new Set(flagNames.map((entry) => entry.toLowerCase()))
  if (removableFlags.size === 0) return args
  return args.filter((value) => !removableFlags.has(value.toLowerCase()))
}

function ensurePositionalInputArgument(args: string[], inputPath: string): string[] {
  return args.includes(inputPath) ? args : [...args, inputPath]
}

function buildCliArgs(input: {
  slicerTarget: RuntimeSlicerTarget
  inputPath: string
  outputPath: string
  outputFileName: string
  plate: number
  supportedFlags: ReadonlySet<string>
  profileArgs: string[]
  machineSwitchArgs: string[]
  removedFlags: string[]
  removedStandaloneFlags: string[]
  bambuHomeDir: string
  bambuConfigDir: string
  bambuCacheDir: string
  bambuDataDir: string
}): string[] {
  const templateArgs = ensurePositionalInputArgument(
    stripFlagArguments(
      stripStandaloneFlags(
        stripUnsupportedFlagArguments(
          splitArgsTemplate(input.slicerTarget.cliArgsTemplate ?? env.SLICER_CLI_ARGS_TEMPLATE ?? '').map((value) => {
            return value
              .replaceAll('{input}', input.inputPath)
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
          input.supportedFlags,
          ['--export-json']
        ),
        input.removedStandaloneFlags
      ),
      input.removedFlags
    ),
    input.inputPath
  )

  const inputArgIndex = templateArgs.indexOf(input.inputPath)
  return inputArgIndex >= 0
    ? [...templateArgs.slice(0, inputArgIndex), ...input.machineSwitchArgs, ...input.profileArgs, ...templateArgs.slice(inputArgIndex)]
    : [...templateArgs, ...input.machineSwitchArgs, ...input.profileArgs]
}

async function mkfifo(pipePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('mkfifo', [pipePath], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`mkfifo exited with code ${code ?? 'unknown'}`))
    })
  })
}

interface BuiltinProfileSummary {
  id: string
  source: 'builtin'
  kind: SlicingProfileKind
  name: string
  filamentType?: string
  filamentVendor?: string
  printerModels?: string[]
  compatiblePrinters?: string[]
  compatiblePrints?: string[]
  nozzleDiameters?: number[]
  plateTypes?: string[]
  compatiblePrintersCondition?: string
  compatiblePrintsCondition?: string
  defaultProcessProfile?: string
  defaultFilamentProfiles?: string[]
  updatedAt: null
}

/**
 * Parsing every bundled preset (read + JSON.parse + resolve each one's `inherits` chain) is the
 * dominant cost of the `/profiles` endpoint — hundreds of files — and the editor calls it on every
 * open. The presets are static per slicer image, so cache the parsed catalogue per profile dir and
 * reuse it until the `*_full` dirs' mtimes change (a re-extract/upgrade). A cache miss is taken
 * whenever a dir can't be stat'd (mid-extraction) so a partial catalogue is never cached.
 */
const builtinProfilesCache = new Map<string, { signature: string; profiles: BuiltinProfileSummary[] }>()

async function listBuiltinProfiles(profileDir: string): Promise<BuiltinProfileSummary[]> {
  const kindDirs = (['machine', 'process', 'filament'] as const).map((kind) => path.join(profileDir, `${kind}_full`))
  let signature: string | null = ''
  for (const directory of kindDirs) {
    const mtimeMs = await stat(directory).then((info) => info.mtimeMs).catch(() => null)
    if (mtimeMs == null) { signature = null; break }
    signature += `${directory}:${mtimeMs};`
  }
  if (signature != null) {
    const cached = builtinProfilesCache.get(profileDir)
    if (cached && cached.signature === signature) return cached.profiles
  }

  const profiles: BuiltinProfileSummary[] = []
  for (const kind of ['machine', 'process', 'filament'] as const) {
    const directory = path.join(profileDir, `${kind}_full`)
    // A populated slicer image always has these dirs; a readdir failure here means the target's
    // preset dirs aren't ready yet (restart / mid-extraction) and we'd otherwise silently return a
    // partial, builtin-less catalogue. Log it so the condition is observable — the API/web treat a
    // builtin-less response as transient and retry (see `slicingProfilesResponseIsUsable`), but the
    // swallowed error left no trace of why the editor briefly saw a custom-only profile list.
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      console.warn(`listBuiltinProfiles: cannot read ${kind} presets at ${directory} — returning none for this kind:`, error instanceof Error ? error.message : error)
      return []
    })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
      const profile = await readDisplayProfile(path.join(directory, entry.name), kind, profileDir)
      if (!profile) continue
      const { name, metadata } = profile
      profiles.push({ id: buildBuiltinProfileId(kind, name), source: 'builtin', kind, name, ...metadata, updatedAt: null })
    }
  }
  profiles.sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name))
  if (signature != null) builtinProfilesCache.set(profileDir, { signature, profiles })
  return profiles
}

async function readDisplayProfile(filePath: string, kind: SlicingProfileKind, profileDir: string) {
  try {
    const content = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(content) as Record<string, unknown>
    const name = stringValue(parsed.name)
    if (!isVisibleBambuStudioProfile(kind, name, parsed)) return null
    // Resolve the `inherits` chain before reading metadata. Many shipped
    // presets (e.g. the Voron/Troodon/Klipper families) declare
    // `compatible_printers` only on an internal `fdm_*` base, so reading the
    // leaf JSON alone loses it and the web dialog would treat the profile as
    // compatible with every printer. Merging the base in mirrors how the CLI
    // and the custom-profile path resolve inheritance.
    const resolved = await resolveCustomProfileConfig(content, kind, profileDir)
    return { name, metadata: extractProfileMetadata(resolved) }
  } catch {
    return null
  }
}

async function prepareProfileArgs(
  profileFiles: SliceProfileFile[],
  workDir: string,
  profileDir: string,
  processSettingOverrides: Record<string, string | string[]> = {},
  filamentSettingOverrides: Record<string, string | string[]> = {}
): Promise<string[]> {
  const settingsPaths: string[] = []
  const filamentPaths: string[] = []
  const customDir = path.join(workDir, 'profiles')

  for (const profile of profileFiles) {
    const overrides = profile.kind === 'process'
      ? processSettingOverrides
      : profile.kind === 'filament'
        ? filamentSettingOverrides
        : undefined
    const profilePath = await materializeProfileFile(profile, customDir, profileDir, overrides)
    if (profile.kind === 'filament') filamentPaths.push(profilePath)
    else settingsPaths.push(profilePath)
  }

  const args: string[] = []
  if (settingsPaths.length > 0) args.push('--load-settings', settingsPaths.join(';'))
  if (filamentPaths.length > 0) args.push('--load-filaments', filamentPaths.join(';'))
  return args
}

async function materializeProfileFile(
  profile: SliceProfileFile,
  outputDir: string,
  profileDir: string,
  overrides?: Record<string, string | string[]>
): Promise<string> {
  await mkdir(outputDir, { recursive: true })
  const profilePath = path.join(outputDir, `${sanitizeProfileFileName(profile.id)}.json`)

  if (profile.source === 'builtin') {
    const builtinContent = await readFile(
      path.join(profileDir, `${profile.kind}_full`, `${sanitizeProfileFileName(profile.name)}.json`),
      'utf8'
    )
    const sanitized = sanitizeBuiltinSlicerProfileJson(builtinContent)
    if (overrides && Object.keys(overrides).length > 0) {
      await writeFile(profilePath, applyProcessSettingOverrides(sanitized, overrides))
      return profilePath
    }
    await writeFile(profilePath, sanitized)
    return profilePath
  }

  if (!profile.content) {
    throw new Error(`Custom ${profile.kind} profile ${profile.name} is missing content`)
  }

  // Custom (User) presets are sparse diffs and the BambuStudio CLI does not
  // resolve a process/machine profile's `inherits` chain on --load-settings, so
  // merge the diff onto its system base (restoring compatible_printers and the
  // inherited defaults) before handing it to the CLI.
  const merged = await resolveCustomProfileConfig(profile.content, profile.kind, profileDir)
  if (overrides && Object.keys(overrides).length > 0) {
    for (const [key, value] of Object.entries(overrides)) merged[key] = value
  }
  await writeFile(profilePath, `${JSON.stringify(merged, null, 2)}\n`)
  return profilePath
}

/**
 * Applies process-setting overrides onto a serialized process profile JSON
 * string, preserving the rest of the document. Override values are written
 * verbatim (BambuStudio serialized strings / string arrays).
 */
function applyProcessSettingOverrides(profileJson: string, overrides: Record<string, string | string[]>): string {
  const parsed = JSON.parse(profileJson) as Record<string, unknown>
  for (const [key, value] of Object.entries(overrides)) parsed[key] = value
  return `${JSON.stringify(parsed, null, 2)}\n`
}

async function prepareInputThreeMf(input: {
  inputPath: string
  outputPath: string
  request: z.infer<typeof createSlicingJobSchema>
  profileFiles: SliceProfileFile[]
  stripEmbeddedProfileRefs: boolean
  processSettingOverrides: Record<string, string | string[]>
  supportedFlags: ReadonlySet<string>
}): Promise<{
  inputPath: string
  rewroteProjectSettings: boolean
  useEstimateModeMachineSwitch: boolean
  machineSwitchProfileName: string | null
}> {
  const projectSettings = await readThreeMfProjectSettings(input.inputPath)
  const machineSwitchProfileName = input.profileFiles.find((profile) => profile.kind === 'machine')?.name ?? null
  const useEstimateModeMachineSwitch = shouldUseEstimateModeMachineSwitch({
    request: input.request,
    profileFiles: input.profileFiles,
    projectSettings,
    supportedFlags: input.supportedFlags
  })
  assertSupportedEmbeddedMachineSwitch({
    request: input.request,
    profileFiles: input.profileFiles,
    projectSettings,
    supportedFlags: input.supportedFlags
  })

  // A project-embedded ("project:") process profile has no separate process
  // profile file, so its overrides must be merged into the 3MF's own
  // project_settings.config rather than a materialized preset.
  const applyEmbeddedProcessOverrides =
    (input.request.target.processProfileId ?? '').startsWith('project:') &&
    Object.keys(input.processSettingOverrides).length > 0

  const metadata = buildSlicedArtifactMetadata(input.request, input.profileFiles)
  if (useEstimateModeMachineSwitch) {
    return {
      inputPath: input.inputPath,
      rewroteProjectSettings: false,
      useEstimateModeMachineSwitch,
      machineSwitchProfileName
    }
  }

  if (!metadata && !input.stripEmbeddedProfileRefs && !applyEmbeddedProcessOverrides) {
    return {
      inputPath: input.inputPath,
      rewroteProjectSettings: false,
      useEstimateModeMachineSwitch,
      machineSwitchProfileName
    }
  }
  // The slicer CLI reads `filament_map_mode` from model_settings.config (per plate),
  // not project_settings.config — so a manual nozzle choice must be forced there or the
  // CLI auto-assigns nozzles for flush and ignores the chosen Left/Right. Build the
  // per-plate Manual map from the same assignment we write into project_settings.
  const manualNozzle = metadata && projectSettings ? buildManualNozzleAssignment(projectSettings, metadata) : null
  const modelSettingsTransform = manualNozzle
    ? (xml: string) => applyManualFilamentMapToModelSettings(xml, manualNozzle.filament_map.join(' '))
    : undefined
  const hasEmbeddedProjectSettings = await rewriteThreeMfProjectSettings(input.inputPath, input.outputPath, (settings) => {
    let rewrittenSettings = metadata ? rewriteProjectSettingsMetadata(settings, metadata) : settings
    if (input.stripEmbeddedProfileRefs) rewrittenSettings = stripEmbeddedProfileRefs(rewrittenSettings)
    if (applyEmbeddedProcessOverrides) rewrittenSettings = mergeProcessOverridesIntoProjectSettings(rewrittenSettings, input.processSettingOverrides)
    return rewrittenSettings
  }, modelSettingsTransform)
  if (!hasEmbeddedProjectSettings) {
    return {
      inputPath: input.inputPath,
      rewroteProjectSettings: false,
      useEstimateModeMachineSwitch,
      machineSwitchProfileName
    }
  }
  return {
    inputPath: input.outputPath,
    rewroteProjectSettings: true,
    useEstimateModeMachineSwitch,
    machineSwitchProfileName
  }
}

function shouldStripEmbeddedProfileRefs(request: z.infer<typeof createSlicingJobSchema>): boolean {
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

async function rewriteThreeMfProjectSettings(
  inputPath: string,
  outputPath: string,
  transform: (settings: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
  modelSettingsTransform?: (modelSettingsXml: string) => string,
  model3dTransform?: (modelXml: string) => string
): Promise<boolean> {
  const sourceZip = await openZip(inputPath)
  const outputZip = new yazl.ZipFile()
  const output = createWriteStream(outputPath)
  outputZip.outputStream.pipe(output)

  return await new Promise<boolean>((resolve, reject) => {
    let settled = false
    let hasEmbeddedProjectSettings = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      sourceZip.close()
      if (error) {
        output.destroy()
        reject(error)
      } else {
        resolve(hasEmbeddedProjectSettings)
      }
    }

    outputZip.outputStream.on('error', finish)
    output.on('error', finish)
    output.on('close', () => finish())
    sourceZip.on('error', finish)
    sourceZip.on('end', () => outputZip.end())
    sourceZip.on('entry', (entry: Entry) => {
      if (/\/$/.test(entry.fileName)) {
        outputZip.addEmptyDirectory(entry.fileName, { mtime: entry.getLastModDate() })
        sourceZip.readEntry()
        return
      }
      if (entry.fileName === 'Metadata/project_settings.config') {
        hasEmbeddedProjectSettings = true
        readZipEntryBuffer(sourceZip, entry).then(
          async (buffer) => {
            outputZip.addBuffer(
              Buffer.from(JSON.stringify(await transform(parseProjectSettings(buffer)), null, 2), 'utf8'),
              entry.fileName,
              { mtime: entry.getLastModDate() }
            )
            sourceZip.readEntry()
          },
          (error) => finish(error as Error)
        )
        return
      }
      if (modelSettingsTransform && entry.fileName === 'Metadata/model_settings.config') {
        readZipEntryBuffer(sourceZip, entry).then(
          (buffer) => {
            outputZip.addBuffer(
              Buffer.from(modelSettingsTransform(buffer.toString('utf8')), 'utf8'),
              entry.fileName,
              { mtime: entry.getLastModDate() }
            )
            sourceZip.readEntry()
          },
          (error) => finish(error as Error)
        )
        return
      }
      if (model3dTransform && entry.fileName === '3D/3dmodel.model') {
        readZipEntryBuffer(sourceZip, entry).then(
          (buffer) => {
            outputZip.addBuffer(
              Buffer.from(model3dTransform(buffer.toString('utf8')), 'utf8'),
              entry.fileName,
              { mtime: entry.getLastModDate() }
            )
            sourceZip.readEntry()
          },
          (error) => finish(error as Error)
        )
        return
      }
      readZipEntryBuffer(sourceZip, entry).then(
        (buffer) => {
          outputZip.addBuffer(buffer, entry.fileName, { mtime: entry.getLastModDate() })
          sourceZip.readEntry()
        },
        (error) => finish(error as Error)
      )
    })
    sourceZip.readEntry()
  })
}

function parseProjectSettings(buffer: Buffer): Record<string, unknown> {
  const parsed = JSON.parse(buffer.toString('utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('3MF project_settings.config must be a JSON object')
  return parsed as Record<string, unknown>
}

async function readThreeMfProjectSettings(inputPath: string): Promise<Record<string, unknown> | null> {
  const sourceZip = await openZip(inputPath)
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (value: Record<string, unknown> | null, error?: Error) => {
      if (settled) return
      settled = true
      sourceZip.close()
      if (error) reject(error)
      else resolve(value)
    }

    sourceZip.on('error', (error) => finish(null, error as Error))
    sourceZip.on('end', () => finish(null))
    sourceZip.on('entry', (entry: Entry) => {
      if (entry.fileName !== 'Metadata/project_settings.config') {
        sourceZip.readEntry()
        return
      }
      readZipEntryBuffer(sourceZip, entry).then(
        (buffer) => finish(parseProjectSettings(buffer)),
        (error) => finish(null, error as Error)
      )
    })
    sourceZip.readEntry()
  })
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

function buildBuiltinProfileId(kind: SlicingProfileKind, name: string): string {
  return `builtin:${kind}:${Buffer.from(name, 'utf8').toString('base64url')}`
}

async function normalizeCliOutput(input: {
  outputPath: string
  outputDir: string
  outputFileName: string
  metadata: SlicedArtifactMetadata | null
}): Promise<void> {
  let outputReady = await isRegularFile(input.outputPath)
  if (!outputReady) {
    const entries = await readdir(input.outputDir, { withFileTypes: true })
    const candidates = entries
      .filter((entry) => entry.isFile() && isDirectPrintableFileName(entry.name))
      .map((entry) => path.join(input.outputDir, entry.name))
      .filter((candidate) => candidate !== input.outputPath)
    if (candidates.length !== 1) return
    await rename(candidates[0] as string, input.outputPath)
    outputReady = true
  }
  if (!outputReady) return
  if (input.outputFileName.toLowerCase().endsWith('.3mf') && input.metadata) {
    await rewritePackagedOutputMetadata(input.outputPath, input.metadata)
  }
}

async function rewritePackagedOutputMetadata(filePath: string, metadata: SlicedArtifactMetadata): Promise<void> {
  const inputBuffer = await readFile(filePath)
  if (inputBuffer.length < 4 || inputBuffer[0] !== 0x50 || inputBuffer[1] !== 0x4b) return

  const tempPath = `${filePath}.normalized`
  await rm(tempPath, { force: true })

  const sourceZip = await openZip(filePath)
  const outputZip = new yazl.ZipFile()
  const output = createWriteStream(tempPath)
  outputZip.outputStream.pipe(output)

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      sourceZip.close()
      if (error) {
        output.destroy()
        reject(error)
      } else {
        resolve()
      }
    }

    outputZip.outputStream.on('error', finish)
    output.on('error', finish)
    output.on('finish', () => finish())
    sourceZip.on('error', finish)
    sourceZip.on('end', () => outputZip.end())
    sourceZip.on('entry', (entry: Entry) => {
      if (/\/$/.test(entry.fileName)) {
        outputZip.addEmptyDirectory(entry.fileName, { mtime: entry.getLastModDate() })
        sourceZip.readEntry()
        return
      }
      if (entry.fileName === 'Metadata/project_settings.config') {
        readZipEntryBuffer(sourceZip, entry).then(
          (buffer) => {
            outputZip.addBuffer(
              Buffer.from(JSON.stringify(rewriteProjectSettingsMetadata(parseProjectSettings(buffer), metadata), null, 2), 'utf8'),
              entry.fileName,
              { mtime: entry.getLastModDate() }
            )
            sourceZip.readEntry()
          },
          (error) => finish(error as Error)
        )
        return
      }
      if (entry.fileName === 'Metadata/slice_info.config') {
        readZipEntryBuffer(sourceZip, entry).then(
          (buffer) => {
            outputZip.addBuffer(
              Buffer.from(rewriteSliceInfoMetadata(buffer.toString('utf8'), metadata), 'utf8'),
              entry.fileName,
              { mtime: entry.getLastModDate() }
            )
            sourceZip.readEntry()
          },
          (error) => finish(error as Error)
        )
        return
      }
      sourceZip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          finish(error ?? new Error(`Failed to read ${entry.fileName}`))
          return
        }
        stream.on('error', finish)
        stream.on('end', () => sourceZip.readEntry())
        outputZip.addReadStream(stream, entry.fileName, { mtime: entry.getLastModDate() })
      })
    })
    sourceZip.readEntry()
  })

  await rename(tempPath, filePath)
}

async function extractGcodeFromPackagedOutput(filePath: string): Promise<boolean> {
  if (!await isRegularFile(filePath)) return false
  const inputBuffer = await readFile(filePath)
  if (inputBuffer.length < 4 || inputBuffer[0] !== 0x50 || inputBuffer[1] !== 0x4b) {
    // Not a zip payload; likely already plain gcode.
    return true
  }

  const tempPath = `${filePath}.plain-gcode`
  await rm(tempPath, { force: true })

  const extracted = await extractFirstGcodeEntry(filePath, tempPath)
  if (!extracted) {
    await rm(tempPath, { force: true })
    return false
  }

  await rename(tempPath, filePath)
  return true
}

async function extractFirstGcodeEntry(zipPath: string, outputPath: string): Promise<boolean> {
  return await new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error('Failed to open packaged slicer output'))
        return
      }

      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        zipFile.close()
        resolve(value)
      }
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        zipFile.close()
        reject(err)
      }

      zipFile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipFile.readEntry()
          return
        }
        if (!entry.fileName.toLowerCase().endsWith('.gcode')) {
          zipFile.readEntry()
          return
        }

        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error('Failed to read gcode entry from packaged slicer output'))
            return
          }
          const writer = createWriteStream(outputPath)
          stream.on('error', (err) => fail(err as Error))
          writer.on('error', (err) => fail(err as Error))
          writer.on('finish', () => finish(true))
          stream.pipe(writer)
        })
      })

      zipFile.once('end', () => finish(false))
      zipFile.once('error', (zipError) => fail(zipError as Error))
      zipFile.readEntry()
    })
  })
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

function buildOutputLinesHeader(outputLines: SlicingOutputLine[]): string {
  const latestSystemLines = outputLines.filter((line) => line.stream === 'system').slice(-20)
  const fallbackLines = outputLines.slice(-8)
  const candidateLines = latestSystemLines.length > 0 ? latestSystemLines : fallbackLines
  const compactLines = candidateLines.map((line) => ({
    stream: line.stream,
    text: line.text.slice(0, 240),
    createdAt: line.createdAt
  }))

  let selected = compactLines.slice()
  let encoded = encodeOutputLines(selected)
  while (selected.length > 1 && Buffer.byteLength(encoded, 'utf8') > MAX_OUTPUT_LINES_HEADER_BYTES) {
    selected = selected.slice(Math.ceil(selected.length / 2))
    encoded = encodeOutputLines(selected)
  }

  return encoded
}

function encodeOutputLines(lines: Array<Pick<SlicingOutputLine, 'stream' | 'text' | 'createdAt'>>): string {
  return Buffer.from(JSON.stringify(lines), 'utf8').toString('base64url')
}

function formatRuntimeCompatibilityError(stderrText: string): string | null {
  if (!stderrText || !/GLIBCXX_|GLIBC_/i.test(stderrText) || !/version `[^']+' not found/i.test(stderrText)) {
    return null
  }
  const missingVersions = Array.from(new Set(
    stderrText
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = line.match(/version `([^']+)' not found/i)
        return match?.[1] ? [match[1]] : []
      })
  ))
  const missingSummary = missingVersions.length > 0
    ? ` (${missingVersions.join(', ')})`
    : ''
  return `The selected slicer binary is incompatible with this host runtime${missingSummary}. Choose another slicer target or install a build compiled for this OS image.`
}

function splitArgsTemplate(value: string): string[] {
  const matches = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  return matches.map((entry) => entry.replace(/^['"]|['"]$/g, ''))
}

function buildDefaultOutputFileName(sourceFileName: string): string {
  return sourceFileName.replace(/\.3mf$/i, '.gcode.3mf')
}

function normalizeOutputFileName(fileName: string): string {
  // Spaces, brackets, and most ASCII punctuation are valid in the output file name
  // (BambuStudio itself exports names like "Mount (landscape).gcode.3mf"); the name is
  // passed to the slicer CLI as a single argv token (spawn is invoked without a shell,
  // and the args template is tokenized before {outputFileName} is substituted). Strip
  // only path separators, FAT-reserved characters, and non-printable/non-ASCII — the
  // same set as the API's normalizeOutputFileName and sanitizeRemoteName; this name is
  // reported back and REPLACES the caller's requested output name, so anything stripped
  // here disfigures the library file name (e.g. "(ABS)" used to become "_ABS_").
  const safe = fileName.replace(/[\\/<>:"|?*]/g, '_').replace(/[^\x20-\x7e]+/g, '_')
  return isDirectPrintableFileName(safe) ? safe : `${safe.replace(/\.3mf$/i, '')}.gcode.3mf`
}

// The slicer PRODUCES these by mutation; the API parses them back with the
// shared `slicingMetadataSchema`. Reuse the shared inferred types so the
// producer and the schema cannot drift. `SlicingMetadata` is optional at the
// schema level (the field may be absent on a job), so strip the `| undefined`
// for the concrete object this builds.
type SlicingMetadataFields = NonNullable<SlicingMetadata>

async function tryReadSlicingMetadata(workDir: string, outputFileName: string): Promise<SlicingMetadataFields | null> {
  // BambuStudio's --export-json output name isn't guaranteed to match the gcode base
  // name, so try the expected name first and then any other *.json the slice dropped in
  // the work dir, returning the first that carries recognizable slice estimate fields.
  const outputBaseName = outputFileName.replace(/\.[^.]+$/, '')
  const candidates = [`${outputBaseName}.json`]
  try {
    for (const entry of await readdir(workDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.json') && !candidates.includes(entry.name)) {
        candidates.push(entry.name)
      }
    }
  } catch { /* work dir unreadable — fall back to the expected name only */ }
  for (const candidate of candidates) {
    const parsed = await readSlicingMetadataFile(path.join(workDir, candidate))
    if (parsed) return parsed
  }
  return null
}

async function readSlicingMetadataFile(jsonPath: string): Promise<SlicingMetadataFields | null> {
  try {
    const content = await readFile(jsonPath, 'utf8')
    const data = JSON.parse(content)

    // Map common BambuStudio JSON fields to our metadata schema
    const metadata: SlicingMetadataFields = {}

    // BambuStudio's actual CLI output (result.json): per-plate `total_predication`
    // (print time, seconds) and `filaments[].total_used_g` (weight, incl. flush). Sum
    // across sliced plates so a single-plate or all-plate slice both report totals.
    if (Array.isArray(data.sliced_plates) && data.sliced_plates.length > 0) {
      let timeSeconds = 0
      let prepareSeconds = 0
      let weightGrams = 0
      // Aggregate per-material usage across plates, keyed by filament id so the same
      // material on multiple plates sums into one row. Length is reported in metres in
      // result.json (`total_used_m`); convert to mm to match estimatedFilamentLengthMm.
      const byMaterial = new Map<number, SlicingMaterialUsage>()
      for (const plate of data.sliced_plates) {
        if (plate && typeof plate.total_predication === 'number') timeSeconds += plate.total_predication
        if (plate && typeof plate.prepare_time === 'number') prepareSeconds += plate.prepare_time
        if (plate && Array.isArray(plate.filaments)) {
          for (const filament of plate.filaments) {
            if (!filament || typeof filament !== 'object') continue
            const usedG = typeof filament.total_used_g === 'number' ? filament.total_used_g : null
            if (usedG != null) weightGrams += usedG
            const idRaw = filament.id ?? filament.filament_id
            const id = typeof idRaw === 'number' ? idRaw : Number.parseInt(String(idRaw ?? ''), 10)
            if (!Number.isInteger(id)) continue
            const usedM = typeof filament.total_used_m === 'number' ? filament.total_used_m
              : typeof filament.used_m === 'number' ? filament.used_m : null
            const existing = byMaterial.get(id) ?? { id, type: null, color: null, weightGrams: 0, lengthMm: 0 }
            if (typeof filament.type === 'string' && !existing.type) existing.type = filament.type
            if (typeof filament.color === 'string' && !existing.color) existing.color = filament.color
            if (usedG != null) existing.weightGrams = (existing.weightGrams ?? 0) + usedG
            if (usedM != null) existing.lengthMm = (existing.lengthMm ?? 0) + usedM * 1000
            byMaterial.set(id, existing)
          }
        }
      }
      if (timeSeconds > 0) metadata.estimatedPrintTimeSeconds = Math.round(timeSeconds)
      // Per-plate prepare_time, falling back to the top-level field (result.json reports
      // both shapes depending on slice mode).
      if (prepareSeconds <= 0 && typeof data.prepare_time === 'number') prepareSeconds = data.prepare_time
      if (prepareSeconds > 0) metadata.estimatedPrepareTimeSeconds = Math.round(prepareSeconds)
      if (weightGrams > 0) metadata.estimatedFilamentWeightGrams = weightGrams
      if (byMaterial.size > 0) {
        metadata.materials = [...byMaterial.values()].sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
      }
    }

    // Print time in seconds (fallback shapes from other slicer JSON formats)
    if (metadata.estimatedPrintTimeSeconds == null && typeof data.time_cost === 'number') {
      metadata.estimatedPrintTimeSeconds = data.time_cost
    } else if (metadata.estimatedPrintTimeSeconds == null && typeof data.time_cost_str === 'string') {
      // Parse time string like "2h 30m 45s"
      const timeStr = data.time_cost_str
      let totalSeconds = 0
      const hoursMatch = timeStr.match(/(\d+)\s*h/)
      const minsMatch = timeStr.match(/(\d+)\s*m/)
      const secsMatch = timeStr.match(/(\d+)\s*s/)
      if (hoursMatch) totalSeconds += parseInt(hoursMatch[1]) * 3600
      if (minsMatch) totalSeconds += parseInt(minsMatch[1]) * 60
      if (secsMatch) totalSeconds += parseInt(secsMatch[1])
      if (totalSeconds > 0) {
        metadata.estimatedPrintTimeSeconds = totalSeconds
      }
    }

    // Filament length in mm (fallback)
    if (metadata.estimatedFilamentLengthMm == null && typeof data.length === 'number') {
      metadata.estimatedFilamentLengthMm = data.length
    }

    // Filament weight in grams (fallback)
    if (metadata.estimatedFilamentWeightGrams == null && typeof data.weight === 'number') {
      metadata.estimatedFilamentWeightGrams = data.weight
    }

    // Filament cost (fallback)
    if (metadata.estimatedFilamentCost == null && typeof data.money_cost === 'number') {
      metadata.estimatedFilamentCost = data.money_cost
    } else if (metadata.estimatedFilamentCost == null && typeof data.money_cost_str === 'string') {
      // Parse cost string like "$1.50" or "£2.00"
      const costMatch = data.money_cost_str.match(/[\d.]+/)
      if (costMatch) {
        metadata.estimatedFilamentCost = parseFloat(costMatch[0])
      }
    }

    return Object.keys(metadata).length > 0 ? metadata : null
  } catch {
    // Silently ignore metadata read errors - slicing succeeded, just no metadata
    return null
  }
}

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error)
  response.status(500).json({ error: 'Internal server error' })
})

// The slice request envelope (sceneEdit + the selected printer/filament/process profile
// files) travels as the base64 `X-PrintStream-Slice-Request` header, which can reach
// hundreds of KB when several materials are mapped. Node's default 16KB header cap rejects
// that with HTTP 431, so raise the limit for this internal API→slicer call.
const SLICE_MAX_HEADER_BYTES = 2 * 1024 * 1024

/**
 * Remove leftover per-job scratch dirs under SLICER_WORK_DIR at startup. Each slice
 * normally rm's its own work dir when the response closes, but a slicer crash/restart
 * mid-slice orphans the dir — over time those fill the (shared) work volume. At boot no
 * slice is in flight, so every job dir is an orphan and safe to delete. The persistent
 * BambuStudio home/data dirs (which live under the work dir in the default layout) are
 * preserved.
 */
async function sweepStaleWorkDirs(): Promise<void> {
  const workDir = path.resolve(env.SLICER_WORK_DIR)
  const keep = new Set<string>()
  for (const persistentDir of [env.SLICER_BAMBUSTUDIO_HOME_DIR, env.SLICER_BAMBUSTUDIO_DATA_DIR]) {
    const resolved = path.resolve(persistentDir)
    if (path.dirname(resolved) === workDir) keep.add(path.basename(resolved))
  }
  let entries: string[]
  try {
    entries = await readdir(workDir)
  } catch {
    return // work dir not created yet
  }
  let removed = 0
  for (const entry of entries) {
    if (keep.has(entry)) continue
    await rm(path.join(workDir, entry), { recursive: true, force: true }).catch(() => undefined)
    removed += 1
  }
  if (removed > 0) console.log(`[slicer] swept ${removed} stale work dir${removed === 1 ? '' : 's'} at startup`)
}

/**
 * Prewarm the builtin-profile catalogue for every target at startup. Building it cold
 * means reading + parsing thousands of preset JSONs (and their `inherits` chains), which
 * otherwise lands on the FIRST `/profiles` request after a (re)start — the "Loading slicer
 * data…" wait in the web dialog. The mtime-signature cache in `listBuiltinProfiles` keeps
 * every later request cheap; this just moves the cold build off the request path.
 */
async function prewarmBuiltinProfiles(): Promise<void> {
  try {
    const registry = await getSlicerTargetRegistry()
    for (const target of registry.targets) {
      const startedAt = Date.now()
      const profiles = await listBuiltinProfiles(target.profileDir)
      console.log(`[slicer] prewarmed ${profiles.length} builtin profiles for ${target.id} in ${Date.now() - startedAt}ms`)
    }
  } catch (error) {
    // Best-effort: a failed prewarm just means the first request pays the cold build.
    console.warn('[slicer] builtin profile prewarm failed:', error instanceof Error ? error.message : error)
  }
}

void sweepStaleWorkDirs()
void prewarmBuiltinProfiles()
http.createServer({ maxHeaderSize: SLICE_MAX_HEADER_BYTES }, app).listen(env.SLICER_PORT, () => {
  console.log(`PrintStream slicer listening on ${env.SLICER_PORT}`)
  if (!env.SLICER_SERVICE_TOKEN) {
    // The slicer spawns native CLI binaries on uploaded input. With no token it
    // accepts any caller, so it MUST stay on a private/loopback-only network
    // (the default compose keeps it on an internal network). Warn loudly so an
    // operator who widens the bind doesn't unknowingly expose an unauthenticated
    // code-execution service — set SLICER_SERVICE_TOKEN to require auth.
    console.warn('[slicer] SLICER_SERVICE_TOKEN is not set: running WITHOUT authentication. Keep this service on a private/loopback-only network, or set SLICER_SERVICE_TOKEN to require a bearer token.')
  }
})
