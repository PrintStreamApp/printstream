/**
 * Server-side slicing API.
 *
 * Routes validate tenant-owned source files and optional real-printer
 * targets, then hand orchestration to the API-side slicing queue. The
 * BambuStudio CLI itself runs in a separate slicer runtime/container.
 */
import { Router } from 'express'
import { z } from 'zod'
import {
  createSlicingJobSchema,
  filamentSettingsCatalog,
  isDirectPrintableFileName,
  isProjectSlicingPresetId,
  JOBS_DELETE_PERMISSION,
  JOBS_VIEW_PERMISSION,
  LIBRARY_UPLOAD_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION,
  printFromLibrarySchema,
  processSettingsCatalog,
  resolveFilamentConfigRequestSchema,
  resolveProcessConfigRequestSchema,
  SETTINGS_MANAGE_PERMISSION,
  uploadSlicingProfileSchema,
  type CreateSlicingJob,
  type ProcessConfig,
  type ResolveFilamentConfigResponse,
  type ResolveProcessConfigResponse,
  type SlicingCapabilities
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { persistHistoryThumbnailFromLibrary } from '../lib/job-history-thumbnail-source.js'
import { readPrintJobThumbnail } from '../lib/print-job-thumbnails.js'
import { badRequest, notFound } from '../lib/http-error.js'
import { prisma } from '../lib/prisma.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { requireRequestTenantId, requireRouteParam, sendModelBuffer } from '../lib/request-helpers.js'
import { env } from '../lib/env.js'
import { slicerClient } from '../lib/slicer-client.js'
import { slicingJobs } from '../lib/slicing-jobs.js'
import { resolveLibraryFileToLocalPath } from '../lib/bridge-library-files.js'
import { readEntry } from '../lib/three-mf.js'
import { enqueueLibraryPrint } from '../lib/library-printing.js'
import { discardHiddenSlicedOutput, unhideSlicedOutput } from '../lib/library-files.js'
import { broadcastLibraryChanged, broadcastPrintDispatchChanged, broadcastSlicingProfilesChanged } from '../lib/ws-resource-events.js'
import { createCustomSlicingProfiles, deleteCustomSlicingProfile, listCustomSlicingProfiles, resolveSlicingProfileFiles } from '../lib/slicing-profiles.js'

export const slicingRouter = Router()

slicingRouter.get('/capabilities', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (_request, response) => {
  const capabilities = await slicerClient.capabilities()
  response.json({
    configured: capabilities.configured,
    healthy: capabilities.healthy,
    slicerName: capabilities.slicerName,
    defaultTargetId: capabilities.defaultTargetId,
    targets: capabilities.targets,
    maxConcurrentJobs: env.SLICING_MAX_CONCURRENT_JOBS,
    maxQueuedJobs: env.SLICING_MAX_QUEUED_JOBS,
    targetModes: ['realPrinter', 'manualProfile']
  } satisfies SlicingCapabilities)
})

slicingRouter.get('/jobs', requireRequestPermission(JOBS_VIEW_PERMISSION), (request, response) => {
  response.json({ jobs: slicingJobs.list(requireRequestTenantId(request)) })
})

slicingRouter.get('/jobs/:id/thumbnail', requireRequestPermission(JOBS_VIEW_PERMISSION), async (request, response) => {
  const tenantId = requireRequestTenantId(request)
  const jobId = requireRouteParam(request.params.id, 'Slicing job id')
  const thumbnail = slicingJobs.getThumbnailInfo(tenantId, jobId)

  if (thumbnail.thumbnailPath) {
    const png = await readPrintJobThumbnail(thumbnail.thumbnailPath)
    if (png) {
      response.setHeader('Content-Type', 'image/png')
      response.setHeader('Cache-Control', 'private, max-age=300')
      response.send(png)
      return
    }
  }

  const storedPath = await persistHistoryThumbnailFromLibrary({
    jobId,
    preferredFileIds: [thumbnail.outputFileId, thumbnail.sourceFileId],
    plate: thumbnail.plate
  })
  if (!storedPath) throw notFound('Thumbnail missing')

  slicingJobs.setThumbnailPath(tenantId, jobId, storedPath)
  const png = await readPrintJobThumbnail(storedPath)
  if (!png) throw notFound('Thumbnail missing')
  response.setHeader('Content-Type', 'image/png')
  response.setHeader('Cache-Control', 'private, max-age=300')
  response.send(png)
})

slicingRouter.get('/profiles', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const tenantId = requireRequestTenantId(request)
  const targetId = typeof request.query.targetId === 'string' ? request.query.targetId : null
  const builtinProfiles = await slicerClient.profiles(targetId)
  const customProfiles = await listCustomSlicingProfiles(tenantId, builtinProfiles)
  // The full catalogue is thousands of profile summaries (multi-MB JSON) — the largest JSON
  // body the web app loads. Send it through the gzip/piped-chunk sender rather than a single
  // `response.json()` buffer: the one-shot write is what the Vite dev proxy intermittently
  // stalls on for large bodies (dropped tail → the dialog's fetch hangs forever), the same
  // failure sendModelBuffer already works around for model/mesh payloads.
  await sendModelBuffer(request, response, Buffer.from(JSON.stringify({ profiles: [...customProfiles, ...builtinProfiles] }), 'utf8'), 'application/json')
})

/**
 * The 3D build-plate mesh for a printer model, proxied from the slicer's bundled BambuStudio
 * resources (the browser cannot reach the slicer directly). Optional editor decoration: a
 * printer with no bundled bed answers 404 and the editor keeps its millimetre grid.
 */
slicingRouter.get('/bed-model', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const printerModel = typeof request.query.printerModel === 'string' ? request.query.printerModel.trim() : ''
  if (!printerModel) throw badRequest('printerModel is required')
  const targetId = typeof request.query.targetId === 'string' ? request.query.targetId : null
  const bytes = await slicerClient.bedModel(targetId, printerModel)
  if (!bytes) throw notFound('No bed model for this printer')
  // Immutable per slicer image; let the browser keep it for the session.
  response.setHeader('Cache-Control', 'private, max-age=86400')
  await sendModelBuffer(request, response, bytes, 'model/stl')
})

slicingRouter.post('/profiles/resolve-process', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const parsed = resolveProcessConfigRequestSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid resolve request')
  const tenantId = requireRequestTenantId(request)
  if (isProjectSlicingPresetId(parsed.data.processProfileId)) {
    const project = await resolveProjectProcessConfig(parsed.data.sourceFileId ?? null)
    // Baseline = the resolved parent profile (reset target + diff source). When it resolves, the
    // value-diff against it yields only the project's own overrides. When it doesn't (parent not
    // installed here), fall back to the effective config + the 3MF's changed-from-system keys.
    const baseline = await resolveBaselineProcessConfig(tenantId, parsed.data.targetId ?? null, project.presetName)
    const responseBody: ResolveProcessConfigResponse = baseline
      ? { config: project.config, baseConfig: baseline, overriddenKeys: [] }
      : { config: project.config, baseConfig: project.config, overriddenKeys: project.overriddenKeys }
    response.json(responseBody)
    return
  }
  const [profileFile] = await resolveSlicingProfileFiles(tenantId, [{ id: parsed.data.processProfileId, kind: 'process' }])
  if (!profileFile) throw notFound('Process profile not found')
  const config = await slicerClient.resolveProcessConfig(parsed.data.targetId ?? null, {
    source: profileFile.source,
    name: profileFile.name,
    content: profileFile.content
  })
  if (!config) throw notFound('Process profile could not be resolved')
  // An installed/builtin preset has no baked overrides: both baselines are the resolved preset.
  const responseBody: ResolveProcessConfigResponse = { config, baseConfig: config, overriddenKeys: [] }
  response.json(responseBody)
})

slicingRouter.post('/profiles/resolve-filament', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const parsed = resolveFilamentConfigRequestSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid resolve request')
  const tenantId = requireRequestTenantId(request)
  if (isProjectSlicingPresetId(parsed.data.filamentProfileId)) {
    // A project-embedded filament: its config lives in the source 3MF's project_settings.config at
    // the given slot column (projectFilamentId, 1-based). Same contract as resolve-process:
    // "modified" means the embedded config differs from the preset outside the project, so the
    // baseline is the resolved parent preset (value-diff source + reset target). Only when that
    // parent is not installed here does the slot's `different_settings_to_system` record stand in
    // as the changed-keys signal.
    const project = await resolveProjectFilamentConfig(parsed.data.sourceFileId ?? null, parsed.data.projectFilamentId ?? null)
    const baseline = await resolveBaselineFilamentConfig(tenantId, parsed.data.targetId ?? null, project.presetName)
    const responseBody: ResolveFilamentConfigResponse = baseline
      ? { config: project.config, baseConfig: baseline, overriddenKeys: [] }
      : { config: project.config, baseConfig: project.config, overriddenKeys: project.overriddenKeys }
    response.json(responseBody)
    return
  }
  const [profileFile] = await resolveSlicingProfileFiles(tenantId, [{ id: parsed.data.filamentProfileId, kind: 'filament' }])
  if (!profileFile) throw notFound('Filament profile not found')
  const config = await slicerClient.resolveFilamentConfig(parsed.data.targetId ?? null, {
    source: profileFile.source,
    name: profileFile.name,
    content: profileFile.content
  })
  if (!config) throw notFound('Filament profile could not be resolved')
  const responseBody: ResolveFilamentConfigResponse = { config, baseConfig: config, overriddenKeys: [] }
  response.json(responseBody)
})

slicingRouter.post('/profiles', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
  const parsed = uploadSlicingProfileSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid slicing profile payload')
  const tenantId = requireRequestTenantId(request)
  const { profiles, replaced, conflicts } = await createCustomSlicingProfiles(tenantId, parsed.data)
  if (conflicts.length > 0) {
    // 409: the upload was not stored; the client can re-send with `overwrite: true` after confirming.
    response.status(409).json({ error: `Replacing existing preset${conflicts.length > 1 ? 's' : ''}: ${conflicts.join(', ')}`, conflicts })
    return
  }
  const profile = profiles[0]
  if (!profile) throw badRequest('Uploaded profile file did not contain any slicing presets')
  annotateRequestAuditLog(request, {
    action: 'create-slicing-profile',
    resource: 'slicing profile',
    summary: profiles.length === 1 ? `Uploaded slicing profile ${profile.name}.` : `Uploaded ${profiles.length} slicing profiles.`,
    metadata: { profileCount: profiles.length, profileId: profile.id, profileName: profile.name, profileKind: profile.kind, replacedCount: replaced.length }
  })
  broadcastSlicingProfilesChanged(tenantId)
  response.status(201).json({ profile, replaced })
})

slicingRouter.delete('/profiles/:id', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
  const tenantId = requireRequestTenantId(request)
  const profileId = requireRouteParam(request.params.id, 'Slicing profile id')
  await deleteCustomSlicingProfile(tenantId, profileId)
  annotateRequestAuditLog(request, {
    action: 'delete-slicing-profile',
    resource: 'slicing profile',
    summary: 'Deleted a slicing profile.',
    metadata: { profileId }
  })
  broadcastSlicingProfilesChanged(tenantId)
  response.status(204).end()
})

slicingRouter.get('/jobs/:id', requireRequestPermission(JOBS_VIEW_PERMISSION), (request, response) => {
  response.json({ job: slicingJobs.get(requireRequestTenantId(request), requireRouteParam(request.params.id, 'Slicing job id')) })
})

slicingRouter.post('/jobs', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), async (request, response) => {
  const parsed = createSlicingJobSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid slicing payload')

  const tenantId = requireRequestTenantId(request)
  const sourceFile = await prisma.libraryFile.findUnique({
    where: { id: parsed.data.sourceFileId },
    select: { id: true, name: true, kind: true, ownerBridgeId: true, storedPath: true }
  })
  if (!sourceFile) throw notFound('Source file not found')

  // Slicing an archived version reads that version's bytes while the job
  // stays attributed to the parent file (outputs land beside it as usual).
  let sourceEntry: { name: string; ownerBridgeId: string | null; storedPath: string } = sourceFile
  if (parsed.data.sourceVersionId) {
    const version = await prisma.libraryFileVersion.findUnique({
      where: { id: parsed.data.sourceVersionId },
      select: { libraryFileId: true, name: true, ownerBridgeId: true, storedPath: true }
    })
    if (!version || version.libraryFileId !== sourceFile.id) throw notFound('Source version not found')
    sourceEntry = version
  }
  if (isDirectPrintableFileName(sourceEntry.name) || !sourceEntry.name.toLowerCase().endsWith('.3mf')) {
    throw badRequest('Only unsliced .3mf files can be sliced')
  }

  if (parsed.data.target.mode === 'realPrinter') {
    const printer = await prisma.printer.findUnique({
      where: { id: parsed.data.target.printerId },
      select: { id: true }
    })
    if (!printer) throw notFound('Target printer not found')
  }

  const profileFiles = await resolveSlicingProfileFiles(tenantId, collectRequestedProfileIds(parsed.data))

  const job = slicingJobs.enqueue({
    tenantId,
    tenant: request.tenant ?? { id: tenantId, slug: tenantId, name: tenantId },
    sourceFileId: sourceFile.id,
    sourceFileName: sourceEntry.name,
    sourcePath: await resolveLibraryFileToLocalPath(sourceEntry),
    targetBridgeId: sourceEntry.ownerBridgeId,
    request: parsed.data,
    profileFiles
  })
  annotateRequestAuditLog(request, {
    action: 'slice',
    resource: 'library file',
    summary: `Queued slicing for ${sourceEntry.name}.`,
    metadata: {
      slicingJobId: job.id,
      fileId: sourceFile.id,
      fileName: sourceEntry.name,
      sourceVersionId: parsed.data.sourceVersionId ?? null,
      slicerTargetId: parsed.data.slicerTargetId ?? null,
      targetMode: parsed.data.target.mode,
      printerId: parsed.data.target.mode === 'realPrinter' ? parsed.data.target.printerId : null,
      plate: parsed.data.plate,
      // The user consciously bypassed BambuStudio's newer-project refusal for this slice. Worth
      // recording: it is a deliberate override of a vendor safety gate, and it is the first thing
      // to check if the resulting G-code turns out wrong.
      allowNewerProjectFile: parsed.data.allowNewerProjectFile === true
    }
  })
  response.status(202).json({ job })
})

function collectRequestedProfileIds(input: CreateSlicingJob): Array<{ id: string | null | undefined; kind: 'machine' | 'process' | 'filament' }> {
  return [
    { id: input.target.printerProfileId, kind: 'machine' },
    { id: input.target.processProfileId, kind: 'process' },
    ...(input.target.filamentMappings ?? []).map((mapping) => ({ id: mapping.profileId, kind: 'filament' as const }))
  ]
}

const PROJECT_SETTINGS_ENTRY_PATH = 'Metadata/project_settings.config'

interface ProjectProcessConfig {
  /** Effective, already-merged process config embedded in the 3MF. */
  config: ProcessConfig
  /** The project's process preset name (`print_settings_id`), used to resolve the baseline. */
  presetName: string | null
  /** Process keys the 3MF records as changed from system (`different_settings_to_system[0]`). */
  overriddenKeys: string[]
}

/**
 * Resolves the editor base config for a project-embedded process profile by
 * reading the source 3MF's flattened `project_settings.config`. Unlike installed
 * presets, the project config is already fully merged, so it needs no slicer
 * round-trip; we keep only keys the process catalog knows about. Also surfaces the
 * preset name and the keys Bambu marks as changed-from-system so the editor can show
 * the baked overrides as modified/resettable.
 */
async function resolveProjectProcessConfig(sourceFileId: string | null): Promise<ProjectProcessConfig> {
  if (!sourceFileId) throw badRequest('Source file is required to resolve a project process profile')
  const sourceFile = await prisma.libraryFile.findUnique({
    where: { id: sourceFileId },
    select: { id: true, name: true, ownerBridgeId: true, storedPath: true }
  })
  if (!sourceFile) throw notFound('Source file not found')
  const localPath = await resolveLibraryFileToLocalPath(sourceFile)
  let buffer: Buffer
  try {
    buffer = await readEntry(localPath, PROJECT_SETTINGS_ENTRY_PATH)
  } catch {
    throw notFound('Process profile could not be resolved')
  }
  let raw: unknown
  try {
    raw = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw notFound('Process profile could not be resolved')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw notFound('Process profile could not be resolved')
  }
  const record = raw as Record<string, unknown>
  const config: ProcessConfig = {}
  for (const key of Object.keys(processSettingsCatalog.options)) {
    const value = record[key]
    if (typeof value === 'string') {
      config[key] = value
    } else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      config[key] = value as string[]
    }
  }
  return {
    config,
    presetName: typeof record.print_settings_id === 'string' && record.print_settings_id.trim() ? record.print_settings_id.trim() : null,
    overriddenKeys: extractProcessOverriddenKeys(record.different_settings_to_system)
  }
}

/**
 * Parses the process slot (index 0) of Bambu's `different_settings_to_system` — a `;`-separated
 * list of keys changed from the system preset — keeping only keys known to the process catalog.
 */
function extractProcessOverriddenKeys(value: unknown): string[] {
  const first = Array.isArray(value) ? value[0] : value
  if (typeof first !== 'string') return []
  return first
    .split(';')
    .map((key) => key.trim())
    .filter((key) => key.length > 0 && processSettingsCatalog.options[key] !== undefined)
}

/**
 * Resolves the baseline a project's process config should be diffed/reset against: the **named
 * parent profile** (`print_settings_id`) as it exists in this workspace's slicer profiles (custom
 * preferred over builtin, mirroring the profile list). Returns its fully-resolved config, or null
 * when that profile is not installed here — in which case the editor falls back to the 3MF's
 * `different_settings_to_system` signal (which is relative to the system preset, not the parent).
 *
 * Resolving the exact parent (e.g. "0.20mm Standard @BBL H2D - Ryan") is what lets the editor show
 * only the project's own overrides, instead of also flagging the parent profile's customizations.
 */
async function resolveBaselineProcessConfig(tenantId: string, targetId: string | null, presetName: string | null): Promise<ProcessConfig | null> {
  if (!presetName) return null
  const builtinProfiles = await slicerClient.profiles(targetId)
  const customProfiles = await listCustomSlicingProfiles(tenantId, builtinProfiles)
  const match = [...customProfiles, ...builtinProfiles].find(
    (profile) => profile.kind === 'process' && profile.name === presetName
  )
  if (!match) return null
  const [file] = await resolveSlicingProfileFiles(tenantId, [{ id: match.id, kind: 'process' }])
  if (!file) return null
  return await slicerClient.resolveProcessConfig(targetId, { source: file.source, name: file.name, content: file.content })
}

interface ProjectFilamentConfig {
  config: ProcessConfig
  presetName: string | null
  overriddenKeys: string[]
}

/**
 * Resolves the material-dialog base config for a project-embedded FILAMENT (a `project:filament:`
 * profile) by reading the source 3MF's `project_settings.config` at the filament's SLOT column.
 * BambuStudio stores each per-filament setting as a parallel array keyed by 0-based slot; we take
 * `array[projectFilamentId - 1]` as that slot's scalar and keep only keys the filament catalog
 * knows. `filament_settings_id[slot]` names the parent preset (for the resettable baseline).
 */
async function resolveProjectFilamentConfig(sourceFileId: string | null, projectFilamentId: number | null): Promise<ProjectFilamentConfig> {
  if (!sourceFileId) throw badRequest('Source file is required to resolve a project filament profile')
  if (!projectFilamentId || projectFilamentId < 1) throw badRequest('A filament slot is required to resolve a project filament profile')
  const slot = projectFilamentId - 1
  const sourceFile = await prisma.libraryFile.findUnique({
    where: { id: sourceFileId },
    select: { id: true, name: true, ownerBridgeId: true, storedPath: true }
  })
  if (!sourceFile) throw notFound('Source file not found')
  const localPath = await resolveLibraryFileToLocalPath(sourceFile)
  let raw: unknown
  try {
    raw = JSON.parse((await readEntry(localPath, PROJECT_SETTINGS_ENTRY_PATH)).toString('utf8'))
  } catch {
    throw notFound('Filament profile could not be resolved')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw notFound('Filament profile could not be resolved')
  const record = raw as Record<string, unknown>
  const config: ProcessConfig = {}
  for (const key of Object.keys(filamentSettingsCatalog.options)) {
    const value = record[key]
    // A filament setting is the slot column of a parallel array; a bare scalar (rare) applies to all.
    if (Array.isArray(value)) {
      const entry = value[slot]
      if (typeof entry === 'string') config[key] = entry
    } else if (typeof value === 'string') {
      config[key] = value
    }
  }
  const settingsIds = record.filament_settings_id
  const presetName = Array.isArray(settingsIds) && typeof settingsIds[slot] === 'string' && settingsIds[slot].trim()
    ? settingsIds[slot].trim()
    : null
  return { config, presetName, overriddenKeys: extractFilamentOverriddenKeys(record.different_settings_to_system, projectFilamentId) }
}

/**
 * Parses one FILAMENT slot of Bambu's `different_settings_to_system` — the 3MF's own record of
 * which keys the project changed from its system presets. Layout (PresetBundle.cpp):
 * `[0]` = process, `[1..n]` = filament slot 1..n, `[n+1]` = machine; each entry is a `;`-separated
 * key list. Keys are filtered to the filament catalog. Used as the changed-keys FALLBACK when the
 * named parent preset is not installed here (mirroring `extractProcessOverriddenKeys`); when the
 * parent resolves, "modified" is the value-diff against it — the record alone would HIDE genuine
 * embedded deviations (e.g. legacy files whose pre-fix save baked another material's physics under
 * this preset's name), which do shape a project-preset slice.
 */
function extractFilamentOverriddenKeys(value: unknown, projectFilamentId: number): string[] {
  const entry = Array.isArray(value) ? value[projectFilamentId] : undefined
  if (typeof entry !== 'string') return []
  return entry
    .split(';')
    .map((key) => key.trim())
    .filter((key) => key.length > 0 && filamentSettingsCatalog.options[key] !== undefined)
}

/** Baseline a project filament resets/diffs against: the named parent filament preset when installed here. */
async function resolveBaselineFilamentConfig(tenantId: string, targetId: string | null, presetName: string | null): Promise<ProcessConfig | null> {
  if (!presetName) return null
  const builtinProfiles = await slicerClient.profiles(targetId)
  const customProfiles = await listCustomSlicingProfiles(tenantId, builtinProfiles)
  const match = [...customProfiles, ...builtinProfiles].find(
    (profile) => profile.kind === 'filament' && profile.name === presetName
  )
  if (!match) return null
  const [file] = await resolveSlicingProfileFiles(tenantId, [{ id: match.id, kind: 'filament' }])
  if (!file) return null
  return await slicerClient.resolveFilamentConfig(targetId, { source: file.source, name: file.name, content: file.content })
}

slicingRouter.post('/jobs/:id/cancel', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), (request, response) => {
  const job = slicingJobs.cancel(requireRequestTenantId(request), requireRouteParam(request.params.id, 'Slicing job id'))
  annotateRequestAuditLog(request, {
    action: 'cancel-slicing',
    resource: 'slicing job',
    summary: `Cancelled slicing for ${job.sourceFileName}.`,
    metadata: {
      slicingJobId: job.id,
      fileId: job.sourceFileId,
      fileName: job.sourceFileName
    }
  })
  response.json({ job })
})

slicingRouter.delete('/jobs/:id', requireRequestPermission(JOBS_DELETE_PERMISSION), async (request, response) => {
  const job = await slicingJobs.delete(requireRequestTenantId(request), requireRouteParam(request.params.id, 'Slicing job id'))
  annotateRequestAuditLog(request, {
    action: 'delete-slicing-job',
    resource: 'slicing job',
    summary: `Deleted slicing history for ${job.outputFileName ?? job.sourceFileName}.`,
    metadata: {
      slicingJobId: job.id,
      fileId: job.sourceFileId,
      fileName: job.outputFileName ?? job.sourceFileName,
      status: job.status
    }
  })
  response.status(204).end()
})

slicingRouter.post('/jobs/:id/print', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
  const tenantId = requireRequestTenantId(request)
  const parsed = printFromLibrarySchema.omit({ fileId: true }).safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid print payload')
  const slicingJob = slicingJobs.get(tenantId, requireRouteParam(request.params.id, 'Slicing job id'))
  if (slicingJob.status !== 'ready' || !slicingJob.outputFileId) {
    throw badRequest('Slicing job is not ready to print')
  }
  const dispatchJob = await enqueueLibraryPrint({
    fileId: slicingJob.outputFileId,
    ...parsed.data
  }, tenantId)
  annotateRequestAuditLog(request, {
    action: 'start-print',
    resource: 'print job',
    summary: `Queued print ${dispatchJob.jobName} on ${dispatchJob.printerName}.`,
    metadata: {
      slicingJobId: slicingJob.id,
      jobId: dispatchJob.id,
      printerId: dispatchJob.printerId,
      printerName: dispatchJob.printerName,
      fileId: dispatchJob.fileId,
      fileName: dispatchJob.fileName,
      plate: dispatchJob.plate
    }
  })
  broadcastPrintDispatchChanged(tenantId)
  response.status(202).json({ job: dispatchJob })
})

// Persist a "slice without saving" output into the library (un-hide the hidden gcode),
// optionally moving it to a chosen folder and/or renaming it.
const saveSlicedOutputSchema = z.object({
  outputFolderId: z.string().trim().min(1).nullable().optional(),
  outputFileName: z.string().trim().min(1).max(200).optional()
})
slicingRouter.post('/jobs/:id/save', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), async (request, response) => {
  const tenantId = requireRequestTenantId(request)
  const slicingJob = slicingJobs.get(tenantId, requireRouteParam(request.params.id, 'Slicing job id'))
  if (slicingJob.status !== 'ready' || !slicingJob.outputFileId) {
    throw badRequest('Slicing job is not ready to save')
  }
  const parsed = saveSlicedOutputSchema.safeParse(request.body ?? {})
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid save request')
  const file = await unhideSlicedOutput(slicingJob.outputFileId, {
    // Only move when the client explicitly chose a destination (string folder or null
    // root); omitting it leaves the output where the slice placed it.
    ...(parsed.data.outputFolderId !== undefined ? { folderId: parsed.data.outputFolderId } : {}),
    name: parsed.data.outputFileName
  })
  // Saving over an existing file folds the output into that row; repoint the
  // job so "Print" after saving dispatches the surviving file.
  slicingJobs.setOutputFile(tenantId, slicingJob.id, file)
  annotateRequestAuditLog(request, {
    action: 'save-sliced-output',
    resource: 'library file',
    summary: file.replacedExisting
      ? `Saved sliced file ${file.name} to the library, replacing the existing file.`
      : `Saved sliced file ${file.name} to the library.`,
    metadata: { slicingJobId: slicingJob.id, fileId: file.id, fileName: file.name, replacedExisting: file.replacedExisting }
  })
  broadcastLibraryChanged(tenantId)
  response.status(200).json({ file })
})

// Discard a "slice without saving" output the user didn't keep (closed the results
// without saving or printing). Removes the still-hidden gcode and the slice job record.
slicingRouter.post('/jobs/:id/discard', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), async (request, response) => {
  const tenantId = requireRequestTenantId(request)
  const slicingJob = slicingJobs.get(tenantId, requireRouteParam(request.params.id, 'Slicing job id'))
  const discarded = slicingJob.outputFileId ? await discardHiddenSlicedOutput(slicingJob.outputFileId) : false
  // Drop the now-empty job record too; ignore if it is still slicing (cancel handles that).
  await slicingJobs.delete(tenantId, slicingJob.id).catch(() => undefined)
  if (discarded) broadcastLibraryChanged(tenantId)
  // Destructive (POST verb): the unsaved sliced output and the job record are removed.
  annotateRequestAuditLog(request, {
    action: 'discard-sliced-output',
    resource: 'slicing job',
    summary: `Discarded the unsaved sliced output for ${slicingJob.sourceFileName}.`,
    metadata: {
      slicingJobId: slicingJob.id,
      fileId: slicingJob.sourceFileId,
      fileName: slicingJob.sourceFileName,
      discardedOutput: discarded
    }
  })
  response.status(204).end()
})
