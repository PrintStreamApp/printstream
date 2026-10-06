/**
 * Standalone slicer runtime.
 *
 * This process is intentionally separate from the API and bridge. The API
 * handles workspaces, permissions, queueing, and library persistence; this
 * service owns multi-version slicer CLI execution.
 */
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import http from 'node:http'
import { createReadStream, createWriteStream } from 'node:fs'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import {
  buildBuiltinSlicingPresetId,
  extractProfileMetadata,
  sliceEnvelopeSchema,
  stringValue,
  type SlicingOutputLine,
  type SlicingPresetKind
} from '@printstream/shared'
import { env } from './env.js'
import { anyInstallStatus } from './engines/progress.js'
import { ensureEnginesInstalled } from './engines/ensure-engines.js'
import { appendStructuredOutput, buildOutputLinesHeader } from './slice-output.js'
import { buildPerMaterialFilamentOverrides } from './cli-profile-selection.js'
import { readBedModel } from './bed-model.js'
import { readFlushDatasets } from './flush-data.js'
import { runFlushCalibration } from './flush-calibration.js'
import { isRetractionCalibration } from './retraction-calibration.js'
import { buildSlicedArtifactMetadata } from './output-metadata.js'
import { resolveCustomProfileConfig } from './custom-profile-resolve.js'
import { sanitizeProfileFileName } from './profile-file-name.js'
import { readFramedSliceUpload, SliceUploadFrameError } from './slice-upload-frame.js'
import { isVisibleBambuStudioProfile } from './profile-visibility.js'
import { getPublicSlicerTargets, getSlicerTargetRegistry, resolveSlicerTarget } from './slicer-targets.js'
import { slicerInputPolicy } from './prepared-input-policy.js'
import { assertNoSlicerHostScripts, validateSlicerInputArchive } from './input-archive-security.js'
import { prepareEngineWritableDirectoryTree } from './engine-process-security.js'
import { getSupportedCliFlags } from './cli-process.js'
import { registerEngineRoutes } from './engine-routes.js'
import { buildDefaultOutputFileName, normalizeOutputFileName } from './slice-output-files.js'
import { prepareSlicedResult, SliceOutputLimitError } from './slice-result-preparation.js'
import { prepareInputThreeMf, shouldStripEmbeddedProfileRefs } from './slice-input-preparation.js'
import { runCli } from './slice-cli-runner.js'

const app = express()
app.use(express.json({ limit: '4mb' }))

const activeSliceOutput = new Map<string, SlicingOutputLine[]>()

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

registerEngineRoutes(app)

app.get('/health', async (_request, response) => {
  const registry = await getSlicerTargetRegistry()
  const defaultTarget = resolveSlicerTarget(registry)
  // The in-flight install rides on HEALTH, not just the admin-only engines
  // route: a fresh container has no engine, and the person who notices is
  // whoever tried to slice, who cannot read the engines route at all.
  const installing = anyInstallStatus()
  response.json({
    name: defaultTarget?.label ?? 'PrintStream slicer',
    configured: registry.targets.length > 0,
    defaultTargetId: registry.defaultTargetId,
    targets: getPublicSlicerTargets(registry),
    engineInstall: installing
      ? { state: installing.state, label: installing.label, fraction: installing.fraction }
      : null
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

/**
 * The 3D build-plate mesh for a printer model, from the bundled BambuStudio resources.
 * Optional decoration for the editor's bed view, a miss answers 404 so the client falls
 * back to the plain millimetre grid rather than showing an error.
 */
app.get('/bed-model', async (request, response) => {
  const registry = await getSlicerTargetRegistry()
  const targetId = typeof request.query.targetId === 'string' ? request.query.targetId : null
  const target = resolveSlicerTarget(registry, targetId)
  if (!target) {
    response.status(400).json({ error: targetId ? 'Unknown slicer target' : 'No slicer targets are configured' })
    return
  }
  const printerModel = typeof request.query.printerModel === 'string' ? request.query.printerModel : ''
  const bed = await readBedModel(target.appDir ?? null, printerModel)
  if (!bed) {
    response.status(404).json({ error: 'No bed model for this printer' })
    return
  }
  response.setHeader('Content-Type', 'model/stl')
  response.setHeader('X-PrintStream-Bed-Model', bed.fileName)
  response.send(bed.bytes)
})

/**
 * BambuStudio's measured flush tables, for the editor's flushing-volumes calculation.
 *
 * An engine with no tables answers `{}` rather than 404: the calculator falls back to Studio's
 * colour formula, so "no tables" is a degraded-but-correct state the client handles, not an error.
 */
app.get('/flush-data', async (request, response) => {
  const registry = await getSlicerTargetRegistry()
  const targetId = typeof request.query.targetId === 'string' ? request.query.targetId : null
  const target = resolveSlicerTarget(registry, targetId)
  if (!target) {
    response.status(400).json({ error: targetId ? 'Unknown slicer target' : 'No slicer targets are configured' })
    return
  }
  response.json({ datasets: await readFlushDatasets(target.appDir ?? null) })
})

/**
 * Ask the engine to compute a flush matrix, so the API/web can check our port against it.
 *
 * Diagnostic only: see `flush-calibration.ts`. Answers `{ calibration: null }` rather than an
 * error whenever the engine cannot be probed (no usable preset triple, a timeout, an old engine):
 * a missing self-check must never look like a broken feature.
 *
 * The preset triple comes from a machine profile's OWN declared defaults, so this works on any
 * image without a hardcoded model list.
 */
app.get('/flush-calibration', async (request, response) => {
  const registry = await getSlicerTargetRegistry()
  const targetId = typeof request.query.targetId === 'string' ? request.query.targetId : null
  const target = resolveSlicerTarget(registry, targetId)
  if (!target) {
    response.status(400).json({ error: targetId ? 'Unknown slicer target' : 'No slicer targets are configured' })
    return
  }
  const profiles = await resolveFlushCalibrationProfiles(target.profileDir)
  if (!profiles) {
    response.json({ calibration: null })
    return
  }
  const calibration = await runFlushCalibration({
    cliPath: target.cliPath,
    appDir: target.appDir ?? null,
    profileDir: target.profileDir,
    profiles,
    workDir: env.SLICER_WORK_DIR,
    env: process.env
  })
  response.json({ calibration })
})

/**
 * A machine/process/filament triple to probe with, taken from a machine profile's own
 * `defaultProcessProfile`/`defaultFilamentProfiles` so no printer model is hardcoded here. Null
 * when no machine in this image declares both.
 */
async function resolveFlushCalibrationProfiles(
  profileDir: string
): Promise<{ machine: string; process: string; filament: string } | null> {
  const profiles = await listBuiltinProfiles(profileDir)
  const byName = new Set(profiles.map((profile) => `${profile.kind}:${profile.name}`))
  for (const machine of profiles.filter((profile) => profile.kind === 'machine')) {
    const processName = machine.defaultProcessProfile
    const filamentName = machine.defaultFilamentProfiles?.[0]
    if (!processName || !filamentName) continue
    // The declared defaults can name a preset the flattened catalogue does not carry; skip rather
    // than hand the CLI a path that does not exist.
    if (!byName.has(`process:${processName}`) || !byName.has(`filament:${filamentName}`)) continue
    return { machine: machine.name, process: processName, filament: filamentName }
  }
  return null
}

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
  const declaredBodyLengthValue = Number(request.header('content-length'))
  const declaredBodyLength = Number.isFinite(declaredBodyLengthValue) && declaredBodyLengthValue >= 0
    ? declaredBodyLengthValue
    : null
  let envelope: unknown
  let source: Readable = request
  let declaredSourceLength = declaredBodyLength
  try {
    const legacyEnvelope = readSliceEnvelope(request)
    if (legacyEnvelope !== null) {
      envelope = legacyEnvelope
    } else {
      const upload = await readFramedSliceUpload(request, declaredBodyLength)
      envelope = upload.envelope
      source = upload.source
      declaredSourceLength = upload.declaredSourceLength
    }
  } catch (error) {
    console.warn('[slice] rejected upload frame:', error instanceof Error ? error.message : error)
    response.status(error instanceof SliceUploadFrameError ? 400 : 500).json({
      error: error instanceof Error ? error.message : 'Invalid slice upload'
    })
    return
  }
  const parsed = sliceEnvelopeSchema.safeParse(envelope)
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid slice payload' })
    return
  }
  if (declaredSourceLength !== null && declaredSourceLength > env.SLICER_MAX_INPUT_BYTES) {
    response.status(413).json({ error: 'Slice input exceeds the configured size limit.' })
    return
  }
  const registry = await getSlicerTargetRegistry()
  const slicerTarget = resolveSlicerTarget(registry, parsed.data.request.slicerTargetId ?? null)
  if (!slicerTarget) {
    response.status(503).json({ error: 'No slicer targets are configured' })
    return
  }

  const safeJobId = parsed.data.jobId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'slice'
  // A retry gets a new unguessable tree. Never reopen a directory a previously compromised native
  // process could have populated with symlinks or deliberately inaccessible descendants.
  const workDir = path.join(env.SLICER_WORK_DIR, `${safeJobId}-${randomUUID()}`)
  // Every hostile project gets a fresh application home. No settings, caches, or plugin state can
  // flow from one user's native-engine invocation into the next one.
  const bambuHomeDir = path.join(workDir, 'runtime-home')
  const bambuConfigDir = path.join(bambuHomeDir, '.config')
  const bambuCacheDir = path.join(bambuHomeDir, '.cache')
  const bambuDataDir = path.join(bambuHomeDir, '.local', 'share')
  const jobTempDir = path.join(workDir, 'tmp')
  const inputPath = path.join(workDir, 'input.3mf')
  const requestedOutputName = 'outputFileName' in parsed.data.request ? parsed.data.request.outputFileName : undefined
  const outputFileName = normalizeOutputFileName(requestedOutputName ?? buildDefaultOutputFileName(parsed.data.sourceFileName))
  const outputPath = path.join(workDir, outputFileName)
  const maxOutputBytes = Math.min(parsed.data.maxOutputBytes ?? env.SLICER_MAX_OUTPUT_BYTES, env.SLICER_MAX_OUTPUT_BYTES)
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
  // installed after 'close' already emitted and never run: leaking the work dir + activeSliceOutput
  // on every cancel/timeout until the shared volume fills. One listener covers cancel, error, and
  // success: `writableFinished` is false only on a real client disconnect (so we abort the CLI then),
  // and cleanup always runs once the response closes for any reason.
  let workDirCleaned = false
  const cleanupWorkDir = () => {
    if (workDirCleaned) return
    workDirCleaned = true
    activeSliceOutput.delete(parsed.data.jobId)
    if (env.SLICER_KEEP_WORK_DIR) {
      console.warn(`[slicer] SLICER_KEEP_WORK_DIR is set: retaining ${workDir}`)
      return
    }
    void rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
  response.on('close', () => {
    if (!response.writableFinished) cliAbort.abort()
    cleanupWorkDir()
  })
  try {
    appendStructuredOutput(outputLines, 'system', 'Receiving the project')
    await prepareEngineWritableDirectoryTree(workDir, [
      bambuHomeDir,
      bambuConfigDir,
      bambuCacheDir,
      bambuDataDir,
      jobTempDir
    ], parsed.data.jobId)
    const supportedFlags = await getSupportedCliFlags(slicerTarget, {
      jobKey: parsed.data.jobId,
      bambuHomeDir,
      bambuConfigDir,
      bambuCacheDir,
      bambuDataDir
    })
    let receivedBytes = 0
    const inputLimit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.byteLength
        if (receivedBytes > env.SLICER_MAX_INPUT_BYTES) {
          callback(new SliceInputLimitError())
          return
        }
        callback(null, chunk)
      }
    })
    await pipeline(source, inputLimit, createWriteStream(inputPath))
    await validateSlicerInputArchive(inputPath, {
      maxEntries: env.SLICER_MAX_ARCHIVE_ENTRIES,
      maxInflatedBytes: env.SLICER_MAX_INFLATED_BYTES
    })
    await assertNoSlicerHostScripts(inputPath)
    const retractionCalibration = await isRetractionCalibration(inputPath)
    const inputPolicy = slicerInputPolicy(parsed.data.request)
    appendStructuredOutput(
      outputLines,
      'system',
      inputPolicy.projectSettingsAuthoritative ? 'Starting the slicing engine' : 'Applying slice settings to the project'
    )
    const preparedInput = await prepareInputThreeMf({
      slicerTarget,
      inputPath,
      outputPath: path.join(workDir, 'input.materials.3mf'),
      request: parsed.data.request,
      profileFiles: parsed.data.profileFiles ?? [],
      stripEmbeddedProfileRefs: shouldStripEmbeddedProfileRefs(parsed.data.request),
      processSettingOverrides: parsed.data.request.target.processSettingOverrides ?? {},
      outputLines
    })
    // A browser-prepared project is already the complete record of what this slice means. Do not
    // restamp the packaged result from request metadata after the engine has consumed that record.
    const slicedArtifactMetadata = inputPolicy.rewriteRequestMetadata && 'sourceFileId' in parsed.data.request
      ? buildSlicedArtifactMetadata(parsed.data.request, parsed.data.profileFiles ?? [])
      : null
    appendStructuredOutput(outputLines, 'system', 'Starting the slicer')
    await runCli({
      slicerTarget,
      inputPath: preparedInput.inputPath,
      outputPath,
      outputFileName,
      outputLines,
      plate: parsed.data.request.plate,
      profileFiles: parsed.data.profileFiles ?? [],
      processSettingOverrides: parsed.data.request.target.processSettingOverrides ?? {},
      machineSettingOverrides: parsed.data.request.target.machineSettingOverrides ?? {},
      filamentSettingOverrides: parsed.data.request.target.filamentSettingOverrides ?? {},
      perMaterialFilamentOverrides: buildPerMaterialFilamentOverrides(parsed.data.request.target.filamentMappings ?? []),
      filamentSlots: parsed.data.request.target.filamentMappings ?? [],
      metadata: slicedArtifactMetadata,
      supportedFlags,
      rewroteProjectSettings: preparedInput.rewroteProjectSettings,
      manualFilamentMap: preparedInput.manualFilamentMap,
      allowNewerProjectFile: parsed.data.request.allowNewerProjectFile === true,
      inputPolicy,
      executionPrinterModel: parsed.data.executionHints?.printerModel ?? null,
      bambuHomeDir,
      bambuConfigDir,
      bambuCacheDir,
      bambuDataDir,
      jobKey: parsed.data.jobId,
      jobTempDir,
      maxOutputBytes,
      signal: cliAbort.signal
    })
    appendStructuredOutput(outputLines, 'system', 'Collecting the sliced file')
    const result = await prepareSlicedResult({
      outputPath,
      outputDir: workDir,
      outputFileName,
      originalInputPath: inputPath,
      retractionCalibration,
      metadata: slicedArtifactMetadata,
      maxOutputBytes
    })

    response.setHeader('Content-Type', 'application/octet-stream')
    response.setHeader('Content-Length', String(result.size))
    response.setHeader('X-PrintStream-Output-File-Name', encodeURIComponent(outputFileName))
    response.setHeader('X-PrintStream-Output-Lines', buildOutputLinesHeader(outputLines))
    if (result.metadata) {
      response.setHeader('X-PrintStream-Metadata', Buffer.from(JSON.stringify(result.metadata), 'utf8').toString('base64url'))
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
    response.status(error instanceof SliceInputLimitError || error instanceof SliceOutputLimitError ? 413 : 500).json({
      error: (error as Error).message || 'Slicing failed',
      output: outputLines
    })
  } finally {
    // Work-dir + activeSliceOutput cleanup is registered eagerly on the response 'close' listener
    // above (it must precede any await so a mid-slice cancel still triggers it). Nothing to do here.
  }
})

class SliceInputLimitError extends Error {
  constructor() {
    super('Slice input exceeds the configured size limit.')
  }
}

function readSliceEnvelope(request: Request): unknown {
  const header = request.header('x-printstream-slice-request')
  if (!header) return null
  try {
    return JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

interface BuiltinProfileSummary {
  id: string
  source: 'builtin'
  kind: SlicingPresetKind
  name: string
  filamentType?: string
  filamentVendor?: string
  printerModels?: string[]
  compatiblePrinters?: string[]
  compatiblePrints?: string[]
  nozzleDiameters?: number[]
  minLayerHeight?: number
  maxLayerHeight?: number
  plateTypes?: string[]
  compatiblePrintersCondition?: string
  compatiblePrintsCondition?: string
  defaultProcessProfile?: string
  defaultFilamentProfiles?: string[]
  updatedAt: null
}

/**
 * Parsing every bundled preset (read + JSON.parse + resolve each one's `inherits` chain) is the
 * dominant cost of the `/profiles` endpoint, hundreds of files, and the editor calls it on every
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
    // partial, builtin-less catalogue. Log it so the condition is observable: the API/web treat a
    // builtin-less response as transient and retry (see `slicingPresetsResponseIsUsable`), but the
    // swallowed error left no trace of why the editor briefly saw a custom-only profile list.
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      console.warn(`listBuiltinProfiles: cannot read ${kind} presets at ${directory}: returning none for this kind:`, error instanceof Error ? error.message : error)
      return []
    })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
      const profile = await readDisplayProfile(path.join(directory, entry.name), kind, profileDir)
      if (!profile) continue
      const { name, metadata } = profile
      profiles.push({ id: buildBuiltinSlicingPresetId(kind, name), source: 'builtin', kind, name, ...metadata, updatedAt: null })
    }
  }
  profiles.sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name))
  if (signature != null) builtinProfilesCache.set(profileDir, { signature, profiles })
  return profiles
}

async function readDisplayProfile(filePath: string, kind: SlicingPresetKind, profileDir: string) {
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

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error)
  response.status(500).json({ error: 'Internal server error' })
})

// Rolling upgrades may pair this worker with an older API that still carries the envelope in the
// `X-PrintStream-Slice-Request` header. Keep the compatibility ceiling until that protocol is
// retired; current clients use the framed request body instead.
const SLICE_MAX_HEADER_BYTES = 2 * 1024 * 1024

/**
 * Remove leftover per-job scratch dirs under SLICER_WORK_DIR at startup. Each slice
 * normally rm's its own work dir when the response closes, but a slicer crash/restart
 * mid-slice orphans the dir: over time those fill the bounded work filesystem. At boot no
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
 * otherwise lands on the FIRST `/profiles` request after a (re)start: the "Loading slicer
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

/** A running slicer server: the port it actually bound, and how to stop it. */
export interface SlicerServerHandle {
  /** The bound port. Resolved, not requested: `port: 0` picks a free one. */
  port: number
  close(): Promise<void>
}

/**
 * Start the slicer HTTP server.
 *
 * Exported as a function rather than run on import so the same service can be
 * hosted two ways: as its own container (`main.ts`, what the image runs) and
 * **in-process inside the native self-hosted app**, which has no sidecar to run
 * and starts this on loopback beside its in-box bridge. Both get identical
 * behaviour because it is one server, not two implementations.
 *
 * @param options.port overrides `SLICER_PORT`. Pass 0 to bind a free port and
 * read it back from the handle: what an in-process host wants, since it then
 * points `SLICER_SERVICE_URL` at itself and never has to reserve a fixed one.
 * @param options.background sweeps stale work dirs and prewarms the builtin
 * profile cache. On by default; a caller that starts several servers in one
 * process would otherwise duplicate the work.
 */
export function startSlicerServer(options: {
  port?: number
  background?: boolean
} = {}): Promise<SlicerServerHandle> {
  if (env.SLICER_REQUIRE_AUTH && !env.SLICER_SERVICE_TOKEN) {
    return Promise.reject(new Error('SLICER_SERVICE_TOKEN is required when SLICER_REQUIRE_AUTH is enabled'))
  }
  if (options.background ?? true) {
    void sweepStaleWorkDirs()
    void prewarmBuiltinProfiles()
    // After the sweep: the container ships no engines, so whatever this host is
    // configured to have gets fetched here. Never awaited: see the module.
    void ensureEnginesInstalled(env.SLICER_PRELOAD_ENGINES)
  }
  const requestedPort = options.port ?? env.SLICER_PORT
  const server = http.createServer({ maxHeaderSize: SLICE_MAX_HEADER_BYTES }, app)
  return new Promise<SlicerServerHandle>((resolve, reject) => {
    server.once('error', reject)
    server.listen(requestedPort, () => {
      server.removeListener('error', reject)
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : requestedPort
      console.log(`PrintStream slicer listening on ${port}`)
      if (!env.SLICER_SERVICE_TOKEN) {
        // The slicer spawns native CLI binaries on uploaded input. With no token it
        // accepts any caller, so it MUST stay on a private/loopback-only network
        // (the default compose keeps it on an internal network). Warn loudly so an
        // operator who widens the bind doesn't unknowingly expose an unauthenticated
        // code-execution service: set SLICER_SERVICE_TOKEN to require auth.
        console.warn('[slicer] SLICER_SERVICE_TOKEN is not set: running WITHOUT authentication. Keep this service on a private/loopback-only network, or set SLICER_SERVICE_TOKEN to require a bearer token.')
      }
      resolve({
        port,
        close: () => new Promise<void>((done, fail) => {
          server.close((error) => (error ? fail(error) : done()))
        })
      })
    })
  })
}
