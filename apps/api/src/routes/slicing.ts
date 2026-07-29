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
  isDirectPrintableFileName,
  isProjectSlicingPresetId,
  JOBS_DELETE_PERMISSION,
  JOBS_VIEW_PERMISSION,
  LIBRARY_UPLOAD_PERMISSION,
  extractProjectFilamentConfig,
  extractProjectProcessConfig,
  LIBRARY_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION,
  filamentSlotValuesCarryTo,
  printFromLibrarySchema,
  resolveFilamentConfigRequestSchema,
  resolveMachineConfigRequestSchema,
  resolveProcessConfigRequestSchema,
  SETTINGS_MANAGE_PERMISSION,
  uploadSlicingPresetSchema,
  type CreateSlicingJob,
  type ProcessConfig,
  type ProjectFilamentConfig,
  type ProjectProcessConfig,
  type ResolveFilamentConfigResponse,
  type ResolveProcessConfigResponse,
  type SlicingCapabilities
} from '@printstream/shared'
import { annotateRequestAuditLog, skipRequestAuditLog } from '../lib/audit-logs.js'
import { clientSessions } from '../lib/client-sessions.js'
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
import { broadcastLibraryChanged, broadcastPrintDispatchChanged, broadcastSlicingPresetsChanged } from '../lib/ws-resource-events.js'
import { createCustomSlicingPresets, deleteCustomSlicingPreset, listCustomSlicingPresets, resolveSlicingPresetFiles } from '../lib/slicing-presets.js'

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

slicingRouter.get('/jobs', requireRequestPermission(JOBS_VIEW_PERMISSION), async (request, response) => {
  // Every job the workspace has ever sliced, and the Jobs view pages it CLIENT-side, so the body
  // grows with history and cannot simply be truncated without blinding that view. Sent through the
  // gzip sender for the same reason `/profiles` is: it is repetitive JSON (status lines and slice
  // targets dominate it), and a large one-shot `response.json()` is also what the Vite dev proxy
  // intermittently stalls on — the failure that first wedged the slice dialog.
  const jobs = slicingJobs.list(requireRequestTenantId(request))
  await sendModelBuffer(request, response, Buffer.from(JSON.stringify({ jobs }), 'utf8'), 'application/json')
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
  const customProfiles = await listCustomSlicingPresets(tenantId, builtinProfiles)
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
    // The preset the project names may itself derive from another; that second hop is what
    // separates "this project changed it" from "the preset it uses changed it".
    const parent = baseline ? await resolveParentProcessConfigByPresetName(tenantId, parsed.data.targetId ?? null, project.presetName) : null
    // Declared record carried in both branches — see the note on the filament twin below.
    const responseBody: ResolveProcessConfigResponse = baseline
      ? {
          config: project.config,
          baseConfig: baseline,
          parentConfig: parent ?? undefined,
          overriddenKeys: project.overriddenKeys,
          declaresOverrides: project.declaresOverrides
        }
      : {
          config: project.config,
          baseConfig: project.config,
          overriddenKeys: project.overriddenKeys,
          declaresOverrides: project.declaresOverrides,
          // No preset resolved: `baseConfig` is a stand-in copy, so a value diff is empty by
          // construction and only the declared record can say what changed. Say so explicitly —
          // the payload alone cannot be told apart from a project that changed nothing.
          baselineResolved: false
        }
    response.json(responseBody)
    return
  }
  const [profileFile] = await resolveSlicingPresetFiles(tenantId, [{ id: parsed.data.processProfileId, kind: 'process' }])
  if (!profileFile) throw notFound('Process profile not found')
  const config = await slicerClient.resolveProcessConfig(parsed.data.targetId ?? null, {
    source: profileFile.source,
    name: profileFile.name,
    content: profileFile.content
  })
  if (!config) throw notFound('Process profile could not be resolved')
  // An installed preset is what the caller's values are measured AGAINST, so it is the baseConfig —
  // nothing is "changed" until something changes it. Its own deviations from its parent ride in
  // `parentConfig` and are emphasis only. Baselining against the parent here is what made a custom
  // preset's saved settings read as project changes, offered with a reset button that would have
  // discarded them (fixed for filament first; same defect, same shape).
  const parentConfig = await resolveBaselineProcessConfig(tenantId, parsed.data.targetId ?? null, parentPresetNameOf(profileFile))
  const responseBody: ResolveProcessConfigResponse = {
    config,
    baseConfig: config,
    parentConfig: parentConfig ?? undefined,
    overriddenKeys: []
  }
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
    // The preset the slot names may itself derive from another; that second hop separates "this
    // project changed it" from "the preset it uses changed it".
    const parent = baseline ? await resolveParentFilamentConfigByPresetName(tenantId, parsed.data.targetId ?? null, project.presetName) : null
    // The declared record rides along even when the baseline resolves. It used to be dropped
    // (`overriddenKeys: []`) on the reasoning that a resolved preset makes the value diff
    // sufficient — which inverts BambuStudio, where the file's list is what says a setting was
    // changed and everything else is normalized back to the preset. Dropping it meant a slot the
    // file explicitly declares UNMODIFIED could still be reported as changed.
    const responseBody: ResolveFilamentConfigResponse = baseline
      ? {
          config: project.config,
          baseConfig: baseline,
          parentConfig: parent ?? undefined,
          overriddenKeys: project.overriddenKeys,
          declaresOverrides: project.declaresOverrides
        }
      : {
          config: project.config,
          baseConfig: project.config,
          overriddenKeys: project.overriddenKeys,
          declaresOverrides: project.declaresOverrides,
          // No preset resolved: `baseConfig` is a stand-in copy, so a value diff is empty by
          // construction and only the declared record can say what changed. Say so explicitly —
          // the payload alone cannot be told apart from a project that changed nothing.
          baselineResolved: false
        }
    response.json(responseBody)
    return
  }
  const [profileFile] = await resolveSlicingPresetFiles(tenantId, [{ id: parsed.data.filamentProfileId, kind: 'filament' }])
  if (!profileFile) throw notFound('Filament profile not found')
  const config = await slicerClient.resolveFilamentConfig(parsed.data.targetId ?? null, {
    source: profileFile.source,
    name: profileFile.name,
    content: profileFile.content
  })
  if (!config) throw notFound('Filament profile could not be resolved')
  // An installed preset is what the caller's values are measured AGAINST, so it is the baseConfig —
  // nothing is "changed" until something changes it. Its own deviations from its parent ride in
  // `parentConfig` and are emphasis only. Baselining against the parent here is what made a user
  // preset's saved settings (a raised bed temp) read as project changes, offered with a reset
  // button that would have discarded the preset's own values.
  const parentConfig = await resolveBaselineFilamentConfig(tenantId, parsed.data.targetId ?? null, parentPresetNameOf(profileFile))
  // ...but when the caller names a project SLOT, the values in force are the 3MF's, not the
  // preset's. A slot whose picker shows an installed preset can still carry baked drift (this is
  // how a project keeps a raised max volumetric speed while still naming the stock preset), and
  // comparing the preset against itself reported that drift as nothing at all. The project branch
  // above only runs for `project:` ids, so without this the drift is invisible for every other id.
  const slotConfig = parsed.data.sourceFileId && parsed.data.projectFilamentId != null
    ? await resolveProjectFilamentConfig(parsed.data.sourceFileId, parsed.data.projectFilamentId).catch(() => null)
    : null
  // ...but only while the slot still holds the same MATERIAL. Pointing a slot at a different
  // material must carry nothing over — PETG's 245C has no business following the slot to PLA Basic
  // — and the save path already drops those values for exactly this reason (`applyFilamentList`'s
  // slotMaterialChanged), so reporting them as this project's values described settings that were
  // about to be discarded. Mirrors BambuStudio's `Tab::select_preset`; see
  // `filamentSlotValuesCarryTo`.
  // An EMPTY slot config says nothing about the slot; overlaying it would blank the preset.
  const slotHasValues = slotConfig != null && Object.keys(slotConfig.config).length > 0
  const slotValues = slotHasValues && filamentSlotValuesCarryTo(slotConfig!.config, config) ? slotConfig!.config : null
  // What follows the slot onto a DIFFERENT preset. BambuStudio's `Tab::select_preset` carries the
  // dirty options and takes the new preset's value for everything else, so when the file declares
  // its changes we carry exactly those: a value the file never claimed to have changed is drift,
  // and dragging it onto a preset the user just chose both misreports it as a change and keeps a
  // number the vendor would have replaced. Without a declared record we cannot tell drift from a
  // real override, so the whole slot carries as before rather than risk discarding settings.
  const declaredCarry = slotValues && slotConfig?.declaresOverrides
    ? slotConfig.overriddenKeys.reduce<ProcessConfig>((picked, key) => {
        const value = slotValues[key]
        if (value !== undefined) picked[key] = value
        return picked
      }, {})
    : null
  const carried: ProcessConfig | null = declaredCarry ?? slotValues
  const responseBody: ResolveFilamentConfigResponse = {
    config: carried ? { ...config, ...carried } : config,
    baseConfig: config,
    parentConfig: parentConfig ?? undefined,
    // Only meaningful while the slot's values actually carried: a slot whose material changed had
    // them dropped, so its record describes settings that are no longer in force.
    overriddenKeys: slotValues ? slotConfig!.overriddenKeys : [],
    declaresOverrides: slotValues ? slotConfig!.declaresOverrides : undefined
  }
  response.json(responseBody)
})

slicingRouter.post('/profiles/resolve-machine', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const parsed = resolveMachineConfigRequestSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid resolve request')
  const tenantId = requireRequestTenantId(request)
  // No project branch, unlike resolve-filament/-process: a 3MF embeds its filament and process
  // settings but names its printer, so a machine preset is always an installed one.
  const [profileFile] = await resolveSlicingPresetFiles(tenantId, [{ id: parsed.data.machineProfileId, kind: 'machine' }])
  if (!profileFile) throw notFound('Printer profile not found')
  const config = await slicerClient.resolveMachineConfig(parsed.data.targetId ?? null, {
    source: profileFile.source,
    name: profileFile.name,
    content: profileFile.content
  })
  if (!config) throw notFound('Printer profile could not be resolved')
  const parentName = parentPresetNameOf(profileFile)
  const parentConfig = parentName ? await slicerClient.resolveMachineConfig(parsed.data.targetId ?? null, { source: 'builtin', name: parentName }) : null
  response.json({ config, baseConfig: parentConfig ?? config, overriddenKeys: [] })
})

slicingRouter.post('/profiles', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
  const parsed = uploadSlicingPresetSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid slicing profile payload')
  const tenantId = requireRequestTenantId(request)
  const { profiles, replaced, conflicts } = await createCustomSlicingPresets(tenantId, parsed.data)
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
  broadcastSlicingPresetsChanged(tenantId)
  response.status(201).json({ profile, replaced })
})

slicingRouter.delete('/profiles/:id', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
  const tenantId = requireRequestTenantId(request)
  const profileId = requireRouteParam(request.params.id, 'Slicing profile id')
  await deleteCustomSlicingPreset(tenantId, profileId)
  annotateRequestAuditLog(request, {
    action: 'delete-slicing-profile',
    resource: 'slicing profile',
    summary: 'Deleted a slicing profile.',
    metadata: { profileId }
  })
  broadcastSlicingPresetsChanged(tenantId)
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

  const profileFiles = await resolveSlicingPresetFiles(tenantId, collectRequestedProfileIds(parsed.data))

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

/**
 * Resolves the editor base config for a project-embedded process profile by reading the source 3MF's
 * flattened `project_settings.config`. The parse itself is the shared, browser-safe
 * `extractProjectProcessConfig` (the public editor runs it over its in-tab archive); this only adds
 * the server-side file read.
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
  const project = extractProjectProcessConfig(raw)
  if (!project) throw notFound('Process profile could not be resolved')
  return project
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
  const customProfiles = await listCustomSlicingPresets(tenantId, builtinProfiles)
  const match = [...customProfiles, ...builtinProfiles].find(
    (profile) => profile.kind === 'process' && profile.name === presetName
  )
  if (!match) return null
  const [file] = await resolveSlicingPresetFiles(tenantId, [{ id: match.id, kind: 'process' }])
  if (!file) return null
  return await slicerClient.resolveProcessConfig(targetId, { source: file.source, name: file.name, content: file.content })
}

/**
 * Resolves the material-dialog base config for a project-embedded FILAMENT (a `project:filament:`
 * profile) by reading the source 3MF's `project_settings.config` at the filament's SLOT column. The
 * parse is the shared, browser-safe `extractProjectFilamentConfig` (the public editor runs it over
 * its in-tab archive); this only adds the server-side file read.
 */
async function resolveProjectFilamentConfig(sourceFileId: string | null, projectFilamentId: number | null): Promise<ProjectFilamentConfig> {
  if (!sourceFileId) throw badRequest('Source file is required to resolve a project filament profile')
  if (!projectFilamentId || projectFilamentId < 1) throw badRequest('A filament slot is required to resolve a project filament profile')
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
  const project = extractProjectFilamentConfig(raw, projectFilamentId)
  if (!project) throw notFound('Filament profile could not be resolved')
  return project
}

/** Baseline a project filament resets/diffs against: the named parent filament preset when installed here. */

/**
 * The preset a CUSTOM profile derives from, or null for a built-in / a preset that declares none.
 *
 * Read from the stored JSON's `inherits` — the same field `listCustomSlicingPresets` merges
 * metadata along. Used to give a preset editor a baseline of its PARENT, so the dialog's "modified"
 * markers show what this preset actually overrides rather than diffing it against itself.
 */
function parentPresetNameOf(profileFile: { source: 'builtin' | 'custom'; content?: string }): string | null {
  if (profileFile.source !== 'custom' || !profileFile.content) return null
  try {
    const record = JSON.parse(profileFile.content) as Record<string, unknown>
    const inherits = typeof record.inherits === 'string' ? record.inherits.trim() : ''
    return inherits.length > 0 ? inherits : null
  } catch {
    return null
  }
}

/** The installed filament preset carrying `presetName`, custom before builtin. */
/** The parent config of the PROCESS preset with this name — the second hop for a project preset. */
async function resolveParentProcessConfigByPresetName(tenantId: string, targetId: string | null, presetName: string | null): Promise<ProcessConfig | null> {
  if (!presetName) return null
  const builtinProfiles = await slicerClient.profiles(targetId)
  const customProfiles = await listCustomSlicingPresets(tenantId, builtinProfiles)
  const match = [...customProfiles, ...builtinProfiles].find(
    (profile) => profile.kind === 'process' && profile.name === presetName
  )
  if (!match) return null
  const [file] = await resolveSlicingPresetFiles(tenantId, [{ id: match.id, kind: 'process' }])
  if (!file) return null
  return await resolveBaselineProcessConfig(tenantId, targetId, parentPresetNameOf(file))
}

async function findFilamentProfileFileByName(tenantId: string, targetId: string | null, presetName: string | null) {
  if (!presetName) return null
  const builtinProfiles = await slicerClient.profiles(targetId)
  const customProfiles = await listCustomSlicingPresets(tenantId, builtinProfiles)
  const match = [...customProfiles, ...builtinProfiles].find(
    (profile) => profile.kind === 'filament' && profile.name === presetName
  )
  if (!match) return null
  const [file] = await resolveSlicingPresetFiles(tenantId, [{ id: match.id, kind: 'filament' }])
  return file ?? null
}

async function resolveBaselineFilamentConfig(tenantId: string, targetId: string | null, presetName: string | null): Promise<ProcessConfig | null> {
  const file = await findFilamentProfileFileByName(tenantId, targetId, presetName)
  if (!file) return null
  return await slicerClient.resolveFilamentConfig(targetId, { source: file.source, name: file.name, content: file.content })
}

/**
 * The config of the preset that `presetName` itself derives from, or null when it derives from
 * nothing (every builtin, and any custom preset without an `inherits`). Lets a project slot
 * separate its own changes from the ones its preset already carried.
 */
async function resolveParentFilamentConfigByPresetName(tenantId: string, targetId: string | null, presetName: string | null): Promise<ProcessConfig | null> {
  const file = await findFilamentProfileFileByName(tenantId, targetId, presetName)
  if (!file) return null
  return await resolveBaselineFilamentConfig(tenantId, targetId, parentPresetNameOf(file))
}

/**
 * "My tab is going away" — sent by `pagehide` as a beacon, so a close or a RELOAD reaps the tab's
 * running slices at once instead of after the socket grace.
 *
 * A slice started from the editor is persisted hidden from the library and its toast offers no
 * action, so once the user is out of the editor the artifact is unreachable: finishing it only
 * holds a slicer the next job wants. Beacons cannot be awaited or retried by the sender, so this
 * stays best-effort — the grace in `client-sessions` is still the backstop.
 *
 * The `client` id is not an authentication signal (any caller can send any value), so this is
 * permission-gated like the cancel it stands in for, and can only ever reap work that id created.
 */
slicingRouter.post('/jobs/leaving', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), (request, response) => {
  const parsed = z.object({ client: z.string().trim().min(1).max(200) }).safeParse(request.body)
  if (!parsed.success) throw badRequest('A client id is required')
  clientSessions.leaving(parsed.data.client)
  // High-frequency and carries no user-visible change of its own; the cancels it triggers are
  // audited by the slicing job log.
  skipRequestAuditLog(request)
  response.status(202).end()
})

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
