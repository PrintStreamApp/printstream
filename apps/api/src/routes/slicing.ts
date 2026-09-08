/**
 * Server-side slicing API.
 *
 * Routes validate workspace-owned source files and optional real-printer
 * targets, then hand orchestration to the API-side slicing queue. The
 * BambuStudio CLI itself runs in a separate slicer runtime/container.
 */
import { Router } from 'express'
import { z } from 'zod'
import {
  createSlicingJobSchema,
  filamentPresetChangedKeys,
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
  readMachineSettingOverrides,
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
import { slicerEngineListResponseSchema, type SlicerEngineListResponse } from '@printstream/shared'
import { badRequest, notFound } from '../lib/http-error.js'
import { resolvePinnedContentBase } from '../lib/library-content-base.js'
import { isSelfHostedDeployment } from '../lib/deployment-mode.js'
import { prisma } from '../lib/prisma.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { requireRequestWorkspaceId, requireRouteParam, sendModelBuffer } from '../lib/request-helpers.js'
import { filterVisibleEngines, readVisibleEngineIds, writeVisibleEngineIds } from '../lib/slicer-engine-visibility.js'
import { slicerEngineVisibilityUpdateSchema, type SlicerEngineVisibility } from '@printstream/shared'
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

slicingRouter.get('/capabilities', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const capabilities = await slicerClient.capabilities()
  // The workspace's own choice about which engines its users see. Applied HERE,
  // in the one place every slice surface reads its targets from, rather than in
  // each picker, a second list that forgot to filter is how a hidden engine
  // reappears in one dialog.
  const targets = filterVisibleEngines(
    capabilities.targets,
    await readVisibleEngineIds(requireRequestWorkspaceId(request))
  )
  // Never a default the workspace hid: every surface treats this as the
  // pre-selected target, so pointing it at something absent from the list beside
  // it renders a picker with nothing chosen.
  const defaultTargetId = capabilities.defaultTargetId != null
    && targets.some((target) => target.id === capabilities.defaultTargetId)
    ? capabilities.defaultTargetId
    : targets[0]?.id ?? null
  response.json({
    configured: capabilities.configured,
    healthy: capabilities.healthy,
    slicerName: capabilities.slicerName,
    defaultTargetId,
    targets,
    maxConcurrentJobs: env.SLICING_MAX_CONCURRENT_JOBS,
    maxQueuedJobs: env.SLICING_MAX_QUEUED_JOBS,
    targetModes: ['realPrinter', 'manualProfile'],
    engineInstall: capabilities.engineInstall
  } satisfies SlicingCapabilities)
})

/**
 * The slicer's engine manager.
 *
 * A thin proxy: the slicer OWNS its engines and these routes only carry the
 * request across the process boundary. The fan-out across configured instances,
 * and the rule that an engine counts as installed only when every instance has
 * it, live in `slicer-client.ts`: routing a slice to an instance missing the
 * engine is the failure this exists to prevent.
 *
 * Gated on settings-manage, not library-view: installing downloads gigabytes and
 * removing deletes them. Reading the list is gated the same way because it is
 * only ever read by the management surface.
 *
 * SELF-HOSTED ONLY, and that is a tenancy rule rather than a product one. The
 * slicer is shared by every workspace on a deployment, but these routes are
 * workspace-scoped, so on the cloud one workspace's admin could remove an
 * engine every other workspace slices with. The cloud bakes its engines into the
 * image and we manage them; a single-tenant install is the only place where
 * "the operator" and "every affected tenant" are the same person.
 */
function assertEngineManagementAvailable(): void {
  if (!isSelfHostedDeployment()) {
    throw notFound('Slicer engines are managed by whoever runs this server.')
  }
}

/**
 * Which engines this workspace shows its users, and setting that.
 *
 * Separate from `/engines`, which manages what is INSTALLED on the deployment
 * and is refused on the hosted plan. This is a workspace preference about
 * presentation, so it exists everywhere and never touches the slicer.
 */
slicingRouter.get('/engine-visibility', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  const capabilities = await slicerClient.capabilities()
  const visibleIds = await readVisibleEngineIds(workspaceId)
  const body: SlicerEngineVisibility = {
    // Every engine the deployment actually has, so the surface can offer the
    // full set rather than only the ones already chosen.
    available: capabilities.targets.map((target) => ({ id: target.id, label: target.label })),
    // Null means "all of them"; the surface shows everything ticked.
    visibleIds
  }
  response.json(body)
})

slicingRouter.put('/engine-visibility', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
  const parsed = slicerEngineVisibilityUpdateSchema.safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid engine visibility payload.')
  }
  const workspaceId = requireRequestWorkspaceId(request)
  annotateRequestAuditLog(request, {
    action: 'slicing.engine-visibility.update',
    resource: 'workspace',
    summary: 'Changed which slicing engines this workspace shows',
    metadata: { workspaceId, visibleCount: parsed.data.visibleIds.length }
  })
  await writeVisibleEngineIds(workspaceId, parsed.data.visibleIds)
  response.status(204).end()
})

slicingRouter.get('/engines', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (_request, response) => {
  assertEngineManagementAvailable()
  const listing = await slicerClient.listEngines()
  // Null means "cannot tell": unconfigured, or an instance did not answer.
  // Reported as unavailable rather than empty, so the UI never invites a
  // reinstall of engines that are probably there.
  const body: SlicerEngineListResponse = slicerEngineListResponseSchema.parse(
    listing
      ? { available: true, ...listing }
      : { available: false, defaultTargetId: null, engines: [], platformSupported: false }
  )
  response.json(body)
})

slicingRouter.post('/engines/:id/install', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
  assertEngineManagementAvailable()
  const id = requireRouteParam(request.params.id, 'id')
  annotateRequestAuditLog(request, {
    action: 'slicer.engine.install',
    resource: `slicer-engine:${id}`,
    summary: `Installed slicer engine ${id}`,
    metadata: { engineId: id }
  })
  // 202: the slicer starts the download and answers immediately. Progress is
  // read back from GET /engines rather than held open on this request.
  await slicerClient.changeEngine(id, 'install')
  response.status(202).end()
})

slicingRouter.delete('/engines/:id', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
  assertEngineManagementAvailable()
  const id = requireRouteParam(request.params.id, 'id')
  annotateRequestAuditLog(request, {
    action: 'slicer.engine.remove',
    resource: `slicer-engine:${id}`,
    summary: `Removed slicer engine ${id}`,
    metadata: { engineId: id }
  })
  await slicerClient.changeEngine(id, 'remove')
  response.status(204).end()
})

slicingRouter.get('/jobs', requireRequestPermission(JOBS_VIEW_PERMISSION), async (request, response) => {
  // ACTIVE jobs plus a short just-finished window, the subset the polled consumers (the
  // slicing toast stack, the Jobs view's in-progress section; web counterpart
  // `hooks/useSlicingJobs.ts`) actually read, so this frequently-polled body stays bounded as
  // history grows. The full history is paged with filters by `GET /api/jobs/history`, and a
  // single job (any age) by `GET /jobs/:id`. Sent through the gzip sender for the same reason
  // `/profiles` is: repetitive JSON, and a one-shot `response.json()` is what the Vite dev proxy
  // used to stall on.
  const jobs = slicingJobs.listActive(requireRequestWorkspaceId(request))
  await sendModelBuffer(request, response, Buffer.from(JSON.stringify({ jobs }), 'utf8'), 'application/json')
})

slicingRouter.get('/jobs/:id/thumbnail', requireRequestPermission(JOBS_VIEW_PERMISSION), async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  const jobId = requireRouteParam(request.params.id, 'Slicing job id')
  const thumbnail = slicingJobs.getThumbnailInfo(workspaceId, jobId)

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

  slicingJobs.setThumbnailPath(workspaceId, jobId, storedPath)
  const png = await readPrintJobThumbnail(storedPath)
  if (!png) throw notFound('Thumbnail missing')
  response.setHeader('Content-Type', 'image/png')
  response.setHeader('Cache-Control', 'private, max-age=300')
  response.send(png)
})

slicingRouter.get('/profiles', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  const targetId = typeof request.query.targetId === 'string' ? request.query.targetId : null
  const builtinProfiles = await slicerClient.profiles(targetId)
  const customProfiles = await listCustomSlicingPresets(workspaceId, builtinProfiles)
  // The full catalogue is thousands of profile summaries (multi-MB JSON): the largest JSON
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

/**
 * BambuStudio's measured flush tables, proxied from the slicer's bundled resources for the
 * editor's flushing-volumes calculation (the browser cannot reach the slicer directly).
 *
 * Always 200, even with no slicer configured or an engine that ships no tables: the client then
 * calculates from colours alone, which is Studio's own fallback. A 404 here would read as a
 * failure and push the dialog into an error state over a supported condition.
 */
slicingRouter.get('/flush-data', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const targetId = typeof request.query.targetId === 'string' ? request.query.targetId : null
  const datasets = await slicerClient.flushDatasets(targetId)
  // Immutable per slicer image; let the browser keep it for the session.
  response.setHeader('Cache-Control', 'private, max-age=86400')
  response.json({ datasets })
})

/**
 * BambuStudio's own computed flush matrix, so the editor can verify our port against the engine
 * that will actually slice. Diagnostic only: `{ calibration: null }` when it cannot be probed.
 */
slicingRouter.get('/flush-calibration', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const targetId = typeof request.query.targetId === 'string' ? request.query.targetId : null
  const calibration = await slicerClient.flushCalibration(targetId)
  response.setHeader('Cache-Control', 'private, max-age=86400')
  response.json({ calibration })
})

slicingRouter.post('/profiles/resolve-process', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const parsed = resolveProcessConfigRequestSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid resolve request')
  const workspaceId = requireRequestWorkspaceId(request)
  if (isProjectSlicingPresetId(parsed.data.processProfileId)) {
    const project = await resolveProjectProcessConfig(parsed.data.sourceFileId ?? null)
    // Baseline = the resolved parent profile (reset target + diff source). When it resolves, the
    // value-diff against it yields only the project's own overrides. When it doesn't (parent not
    // installed here), fall back to the effective config + the 3MF's changed-from-system keys.
    const baseline = await resolveBaselineProcessConfig(workspaceId, parsed.data.targetId ?? null, project.presetName)
    // The preset the project names may itself derive from another; that second hop is what
    // separates "this project changed it" from "the preset it uses changed it".
    const parent = baseline ? await resolveParentProcessConfigByPresetName(workspaceId, parsed.data.targetId ?? null, project.presetName) : null
    // Declared record carried in both branches: see the note on the filament twin below.
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
          // construction and only the declared record can say what changed. Say so explicitly:
          // the payload alone cannot be told apart from a project that changed nothing.
          baselineResolved: false,
          // Same fact, in the form the DIALOG renders: the markers are the file's own record rather
          // than a comparison. The workspace hits this whenever a project names a preset that was
          // since renamed or deleted, and stayed silent about it while the anonymous host explained
          // itself, the same file, two different amounts of honesty.
          baselineOrigin: { kind: 'declared' }
        }
    response.json(responseBody)
    return
  }
  const [profileFile] = await resolveSlicingPresetFiles(workspaceId, [{ id: parsed.data.processProfileId, kind: 'process' }])
  if (!profileFile) throw notFound('Process profile not found')
  const config = await slicerClient.resolveProcessConfig(parsed.data.targetId ?? null, {
    source: profileFile.source,
    name: profileFile.name,
    content: profileFile.content
  })
  if (!config) throw notFound('Process profile could not be resolved')
  // An installed preset is what the caller's values are measured AGAINST, so it is the baseConfig,
  // nothing is "changed" until something changes it. Its own deviations from its parent ride in
  // `parentConfig` and are emphasis only. Baselining against the parent here is what made a custom
  // preset's saved settings read as project changes, offered with a reset button that would have
  // discarded them (fixed for filament first; same defect, same shape).
  const parentConfig = await resolveBaselineProcessConfig(workspaceId, parsed.data.targetId ?? null, parentPresetNameOf(profileFile))
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
  const workspaceId = requireRequestWorkspaceId(request)
  if (isProjectSlicingPresetId(parsed.data.filamentProfileId)) {
    // A project-embedded filament: its config lives in the source 3MF's project_settings.config at
    // the given slot column (projectFilamentId, 1-based). Same contract as resolve-process:
    // "modified" means the embedded config differs from the preset outside the project, so the
    // baseline is the resolved parent preset (value-diff source + reset target). Only when that
    // parent is not installed here does the slot's `different_settings_to_system` record stand in
    // as the changed-keys signal.
    const project = await resolveProjectFilamentConfig(parsed.data.sourceFileId ?? null, parsed.data.projectFilamentId ?? null)
    const baseline = await resolveBaselineFilamentConfig(workspaceId, parsed.data.targetId ?? null, project.presetName)
    // The preset the slot names may itself derive from another; that second hop separates "this
    // project changed it" from "the preset it uses changed it".
    const parent = baseline ? await resolveParentFilamentConfigByPresetName(workspaceId, parsed.data.targetId ?? null, project.presetName) : null
    // The declared record rides along even when the baseline resolves. It used to be dropped
    // (`overriddenKeys: []`) on the reasoning that a resolved preset makes the value diff
    // sufficient, which inverts BambuStudio, where the file's list is what says a setting was
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
          // construction and only the declared record can say what changed. Say so explicitly:
          // the payload alone cannot be told apart from a project that changed nothing.
          baselineResolved: false,
          // Same fact, in the form the DIALOG renders: the markers are the file's own record rather
          // than a comparison. The workspace hits this whenever a project names a preset that was
          // since renamed or deleted, and stayed silent about it while the anonymous host explained
          // itself, the same file, two different amounts of honesty.
          baselineOrigin: { kind: 'declared' }
        }
    response.json(responseBody)
    return
  }
  const [profileFile] = await resolveSlicingPresetFiles(workspaceId, [{ id: parsed.data.filamentProfileId, kind: 'filament' }])
  if (!profileFile) throw notFound('Filament profile not found')
  const config = await slicerClient.resolveFilamentConfig(parsed.data.targetId ?? null, {
    source: profileFile.source,
    name: profileFile.name,
    content: profileFile.content
  })
  if (!config) throw notFound('Filament profile could not be resolved')
  // An installed preset is what the caller's values are measured AGAINST, so it is the baseConfig,
  // nothing is "changed" until something changes it. Its own deviations from its parent ride in
  // `parentConfig` and are emphasis only. Baselining against the parent here is what made a user
  // preset's saved settings (a raised bed temp) read as project changes, offered with a reset
  // button that would have discarded the preset's own values.
  const parentName = parentPresetNameOf(profileFile)
  const parentConfig = await resolveBaselineFilamentConfig(workspaceId, parsed.data.targetId ?? null, parentName)
  // ...but when the caller names a project SLOT, the values in force are the 3MF's, not the
  // preset's. A slot whose picker shows an installed preset can still carry baked drift (this is
  // how a project keeps a raised max volumetric speed while still naming the stock preset), and
  // comparing the preset against itself reported that drift as nothing at all. The project branch
  // above only runs for `project:` ids, so without this the drift is invisible for every other id.
  const slotConfig = parsed.data.sourceFileId && parsed.data.projectFilamentId != null
    ? await resolveProjectFilamentConfig(parsed.data.sourceFileId, parsed.data.projectFilamentId).catch(() => null)
    : null
  // ...but only while the slot still holds the same MATERIAL. Pointing a slot at a different
  // material must carry nothing over: PETG's 245C has no business following the slot to PLA Basic,
  // and the save path already drops those values for exactly this reason (`applyFilamentList`'s
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
    // What a SAVE needs to bind this slot: the system preset's name (null when the preset IS
    // system, which BambuStudio normalizes by another route) plus the slot's declared changes.
    // Measured against the SYSTEM preset in the chain, the parent for a user preset, the preset
    // itself when it IS system, because that is what `different_settings_to_system` names, and the
    // subject is the SLOT (preset plus whatever the project carried), not the preset alone.
    presetInherits: parentName ?? null,
    presetChangedKeys: filamentPresetChangedKeys(carried ? { ...config, ...carried } : config, parentConfig ?? config),
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
  const workspaceId = requireRequestWorkspaceId(request)
  // No project branch, unlike resolve-filament/-process: a machine preset is always an INSTALLED
  // one, because a 3MF names its printer preset rather than embedding a preset of its own. (It does
  // embed the machine's VALUES in project_settings.config -- that is what a project-local machine
  // override diffs against -- but there is no project-scoped preset here to resolve.)
  const [profileFile] = await resolveSlicingPresetFiles(workspaceId, [{ id: parsed.data.machineProfileId, kind: 'machine' }])
  if (!profileFile) throw notFound('Printer profile not found')
  const config = await slicerClient.resolveMachineConfig(parsed.data.targetId ?? null, {
    source: profileFile.source,
    name: profileFile.name,
    content: profileFile.content
  })
  if (!config) throw notFound('Printer profile could not be resolved')
  const parentName = parentPresetNameOf(profileFile)
  const parentConfig = parentName ? await slicerClient.resolveMachineConfig(parsed.data.targetId ?? null, { source: 'builtin', name: parentName }) : null
  // What THIS project changed relative to the preset, so the dialog opens on the values the file
  // actually carries and the next Apply does not silently drop them. Best-effort: a project we
  // cannot read is answered as "no project deltas" rather than failing the dialog.
  const projectOverrides = parsed.data.sourceFileId
    ? await resolveProjectMachineOverrides(parsed.data.sourceFileId, config, parsed.data.sourceFileUploadedAt ?? null).catch((error: unknown) => {
      // NULL, not `{}`. The dialog stays usable either way, but the two answers mean different
      // things downstream: `{}` states that the project overrides nothing, which licenses the next
      // save to CLEAR the record, while null says we never found out. Answering `{}` for a bridge
      // that was briefly offline made an ordinary save erase the user's printer overrides.
      console.warn(`[slicing] could not read project machine overrides for ${parsed.data.sourceFileId}`,
        error instanceof Error ? error.message : error)
      return null
    })
    : {}
  // `name` matches the public twin's shape. It is the preset's own name, which a retarget persists
  // as `printer_settings_id`, and the browser cannot derive it for a CUSTOM preset from the id
  // alone. Answering it here is what lets one browser-side retarget serve both hosts.
  response.json({ config, name: profileFile.name, baseConfig: parentConfig ?? config, overriddenKeys: [], projectOverrides })
})

slicingRouter.post('/profiles', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
  const parsed = uploadSlicingPresetSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid slicing profile payload')
  const workspaceId = requireRequestWorkspaceId(request)
  const { profiles, replaced, conflicts } = await createCustomSlicingPresets(workspaceId, parsed.data)
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
  broadcastSlicingPresetsChanged(workspaceId)
  response.status(201).json({ profile, replaced })
})

slicingRouter.delete('/profiles/:id', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  const profileId = requireRouteParam(request.params.id, 'Slicing profile id')
  await deleteCustomSlicingPreset(workspaceId, profileId)
  annotateRequestAuditLog(request, {
    action: 'delete-slicing-profile',
    resource: 'slicing profile',
    summary: 'Deleted a slicing profile.',
    metadata: { profileId }
  })
  broadcastSlicingPresetsChanged(workspaceId)
  response.status(204).end()
})

slicingRouter.get('/jobs/:id', requireRequestPermission(JOBS_VIEW_PERMISSION), (request, response) => {
  response.json({ job: slicingJobs.get(requireRequestWorkspaceId(request), requireRouteParam(request.params.id, 'Slicing job id')) })
})

slicingRouter.post('/jobs', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), async (request, response) => {
  const parsed = createSlicingJobSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid slicing payload')

  const workspaceId = requireRequestWorkspaceId(request)
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

  // Which BYTES to bake from, as opposed to which file this job is ABOUT. An editor slice pins the
  // version its `sceneEdit` was composed against and keeps sending it, exactly as an editor save
  // does; resolving the file's current content instead re-applies an edit an earlier save already
  // baked in. See `contentBase` in the shared schema for what that corrupted.
  const contentEntry = parsed.data.contentBase
    ? await resolvePinnedContentBase(workspaceId, parsed.data.contentBase)
    : sourceEntry

  if (parsed.data.target.mode === 'realPrinter') {
    const printer = await prisma.printer.findUnique({
      where: { id: parsed.data.target.printerId },
      select: { id: true }
    })
    if (!printer) throw notFound('Target printer not found')
  }

  const sourcePath = await resolveLibraryFileToLocalPath(contentEntry)
  const requestedFiles = await resolveSlicingPresetFiles(workspaceId, collectRequestedProfileIds(parsed.data))
  const profileFiles = [
    ...requestedFiles,
    ...await resolveProjectFilamentPresetFiles(workspaceId, sourcePath, requestedFiles)
  ]

  const job = slicingJobs.enqueue({
    workspaceId,
    workspace: request.workspace ?? { id: workspaceId, slug: workspaceId, name: workspaceId },
    sourceFileId: sourceFile.id,
    sourceFileName: sourceEntry.name,
    sourcePath,
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
      // WHICH BYTES were sliced, as opposed to which file the job is about. Worth a durable record
      // for the same reason `allowNewerProjectFile` is: when a slice produces wrong G-code, the
      // base the edit was applied to is the first thing to check, and it is otherwise unrecoverable
      // once the editor session is gone.
      contentBaseFileId: parsed.data.contentBase?.fileId ?? null,
      contentBaseVersionId: parsed.data.contentBase?.versionId ?? null,
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
 * The workspace filament presets a project NAMES, resolved to files so the slicer can bind each
 * slot to the preset it actually uses.
 *
 * A slice request only names the presets the USER picked, so a slot left on the project's own
 * material sent no file at all. The slicer can find a BUILTIN of that name in its bundled
 * catalogue, but a workspace preset exists only here, and what it did instead was substitute a
 * stand-in: every project built on a custom filament preset sliced with Generic PLA's physics and
 * came back stamped Generic PLA. BambuStudio has no such gap because user and system presets share
 * one collection and a project's slot is looked up across both by name
 * (`PresetCollection::load_external_preset` -> `find_preset_internal`), so this sends the workspace
 * half of that collection and `buildFilamentSlotCoverage` does the lookup.
 *
 * Best-effort by design: an unreadable project, or a name matching nothing, simply contributes no
 * file, exactly as before. It must never fail a slice that would otherwise have run.
 */
async function resolveProjectFilamentPresetFiles(
  workspaceId: string,
  sourcePath: string,
  alreadyResolved: Awaited<ReturnType<typeof resolveSlicingPresetFiles>>
): Promise<Awaited<ReturnType<typeof resolveSlicingPresetFiles>>> {
  try {
    const buffer = await readEntry(sourcePath, PROJECT_SETTINGS_ENTRY_PATH)
    const parsed: unknown = JSON.parse(buffer.toString('utf8'))
    const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    const names = Array.isArray(record?.filament_settings_id) ? record.filament_settings_id : []
    // The names the request already covers, so a preset the user explicitly picked is not sent
    // twice under two ids (the slicer indexes supplied files by name, and a duplicate would make
    // which one wins depend on map order).
    const covered = new Set(
      alreadyResolved.filter((file) => file.kind === 'filament').map((file) => file.name)
    )
    const wanted = new Set<string>()
    for (const name of names) {
      if (typeof name === 'string' && name.trim() && !covered.has(name.trim())) wanted.add(name.trim())
    }
    if (wanted.size === 0) return []

    const custom = await listCustomSlicingPresets(workspaceId)
    const ids = custom
      .filter((preset) => preset.kind === 'filament' && wanted.has(preset.name))
      .map((preset) => ({ id: preset.id, kind: 'filament' as const }))
    if (ids.length === 0) return []
    return await resolveSlicingPresetFiles(workspaceId, ids)
  } catch (error) {
    // Worth a line: the symptom otherwise is a slice that quietly used different filament values
    // than the project asked for, which is exactly the failure this function exists to end.
    console.warn('[slicing] could not resolve the workspace presets this project names', (error as Error).message)
    return []
  }
}

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
 * The machine settings a project records as CHANGED from its printer preset.
 *
 * The machine half of {@link resolveProjectProcessConfig}, and the reason a project-local machine
 * override survives a reload: without it the editor's override map starts empty on every open, the
 * "changed vs preset" badge reads zero for a file that carries deltas, and the settings dialog
 * opens on the bare preset so the next Apply emits a diff that DROPS them.
 *
 * This is the I/O around it: which VERSION's bytes to read. The reading itself is
 * `readMachineSettingOverrides`, which lives beside the writer that produced the record, because
 * the two disagreeing is invisible from either side.
 */
async function resolveProjectMachineOverrides(
  sourceFileId: string,
  presetConfig: Record<string, string | string[]>,
  uploadedAt: string | null
): Promise<Record<string, string | string[]> | null> {
  const sourceFile = await prisma.libraryFile.findUnique({
    where: { id: sourceFileId },
    select: { id: true, name: true, ownerBridgeId: true, storedPath: true, uploadedAt: true }
  })
  // Unknown, not "none": a caller that cannot find the row has learned nothing about the file, and
  // answering `{}` would license the next save to clear the record.
  if (!sourceFile) return null
  // A HISTORY version carries the head file's id and its own `uploadedAt`, so answering from the
  // head's bytes would show one version's overrides while the user is looking at another.
  let readFrom = sourceFile
  if (uploadedAt && sourceFile.uploadedAt.toISOString() !== uploadedAt) {
    const version = await prisma.libraryFileVersion.findFirst({
      where: { libraryFileId: sourceFileId, uploadedAt: new Date(uploadedAt) },
      select: { name: true, ownerBridgeId: true, storedPath: true }
    })
    // Unknown version: say so rather than answer from the wrong bytes, and rather than say "none".
    if (!version) return null
    readFrom = { ...sourceFile, ...version }
  }
  const localPath = await resolveLibraryFileToLocalPath(readFrom)
  const buffer = await readEntry(localPath, PROJECT_SETTINGS_ENTRY_PATH)
  const raw = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>
  return readMachineSettingOverrides(raw, presetConfig)
}

/**
 * Resolves the baseline a project's process config should be diffed/reset against: the **named
 * parent profile** (`print_settings_id`) as it exists in this workspace's slicer profiles (custom
 * preferred over builtin, mirroring the profile list). Returns its fully-resolved config, or null
 * when that profile is not installed here, in which case the editor falls back to the 3MF's
 * `different_settings_to_system` signal (which is relative to the system preset, not the parent).
 *
 * Resolving the exact parent (e.g. "0.20mm Standard @BBL H2D - Ryan") is what lets the editor show
 * only the project's own overrides, instead of also flagging the parent profile's customizations.
 */
async function resolveBaselineProcessConfig(workspaceId: string, targetId: string | null, presetName: string | null): Promise<ProcessConfig | null> {
  if (!presetName) return null
  const builtinProfiles = await slicerClient.profiles(targetId)
  const customProfiles = await listCustomSlicingPresets(workspaceId, builtinProfiles)
  const match = [...customProfiles, ...builtinProfiles].find(
    (profile) => profile.kind === 'process' && profile.name === presetName
  )
  if (!match) return null
  const [file] = await resolveSlicingPresetFiles(workspaceId, [{ id: match.id, kind: 'process' }])
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
 * Read from the stored JSON's `inherits`, the same field `listCustomSlicingPresets` merges
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
/** The parent config of the PROCESS preset with this name: the second hop for a project preset. */
async function resolveParentProcessConfigByPresetName(workspaceId: string, targetId: string | null, presetName: string | null): Promise<ProcessConfig | null> {
  if (!presetName) return null
  const builtinProfiles = await slicerClient.profiles(targetId)
  const customProfiles = await listCustomSlicingPresets(workspaceId, builtinProfiles)
  const match = [...customProfiles, ...builtinProfiles].find(
    (profile) => profile.kind === 'process' && profile.name === presetName
  )
  if (!match) return null
  const [file] = await resolveSlicingPresetFiles(workspaceId, [{ id: match.id, kind: 'process' }])
  if (!file) return null
  return await resolveBaselineProcessConfig(workspaceId, targetId, parentPresetNameOf(file))
}

async function findFilamentProfileFileByName(workspaceId: string, targetId: string | null, presetName: string | null) {
  if (!presetName) return null
  const builtinProfiles = await slicerClient.profiles(targetId)
  const customProfiles = await listCustomSlicingPresets(workspaceId, builtinProfiles)
  const match = [...customProfiles, ...builtinProfiles].find(
    (profile) => profile.kind === 'filament' && profile.name === presetName
  )
  if (!match) return null
  const [file] = await resolveSlicingPresetFiles(workspaceId, [{ id: match.id, kind: 'filament' }])
  return file ?? null
}

async function resolveBaselineFilamentConfig(workspaceId: string, targetId: string | null, presetName: string | null): Promise<ProcessConfig | null> {
  const file = await findFilamentProfileFileByName(workspaceId, targetId, presetName)
  if (!file) return null
  return await slicerClient.resolveFilamentConfig(targetId, { source: file.source, name: file.name, content: file.content })
}

/**
 * The config of the preset that `presetName` itself derives from, or null when it derives from
 * nothing (every builtin, and any custom preset without an `inherits`). Lets a project slot
 * separate its own changes from the ones its preset already carried.
 */
async function resolveParentFilamentConfigByPresetName(workspaceId: string, targetId: string | null, presetName: string | null): Promise<ProcessConfig | null> {
  const file = await findFilamentProfileFileByName(workspaceId, targetId, presetName)
  if (!file) return null
  return await resolveBaselineFilamentConfig(workspaceId, targetId, parentPresetNameOf(file))
}

/**
 * "My tab is going away": sent by `pagehide` as a beacon, so a close or a RELOAD reaps the tab's
 * running slices at once instead of after the socket grace.
 *
 * A slice started from the editor is persisted hidden from the library and its toast offers no
 * action, so once the user is out of the editor the artifact is unreachable: finishing it only
 * holds a slicer the next job wants. Beacons cannot be awaited or retried by the sender, so this
 * stays best-effort: the grace in `client-sessions` is still the backstop.
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
  const job = slicingJobs.cancel(requireRequestWorkspaceId(request), requireRouteParam(request.params.id, 'Slicing job id'))
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

/**
 * Run a failed slice again, unchanged, keeping the job id so the surface that showed the failure
 * follows the new attempt (see `slicingJobs.retry`).
 *
 * Gated on LIBRARY_UPLOAD like `POST /jobs`, because it costs the same slicer slot as a new slice
 * and produces the same artifact. `ownerClientId` re-homes the job onto the tab that asked, and is
 * optional so a non-browser caller leaves it unowned rather than inheriting the original tab's id.
 */
slicingRouter.post('/jobs/:id/retry', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), (request, response) => {
  const parsed = z.object({ ownerClientId: z.string().trim().min(1).max(128).optional() }).safeParse(request.body ?? {})
  if (!parsed.success) throw badRequest('Invalid retry request')
  const job = slicingJobs.retry(
    requireRequestWorkspaceId(request),
    requireRouteParam(request.params.id, 'Slicing job id'),
    parsed.data.ownerClientId ?? null
  )
  annotateRequestAuditLog(request, {
    action: 'retry-slicing',
    resource: 'slicing job',
    summary: `Retried slicing for ${job.sourceFileName}.`,
    metadata: {
      slicingJobId: job.id,
      fileId: job.sourceFileId,
      fileName: job.sourceFileName
    }
  })
  response.json({ job })
})

slicingRouter.delete('/jobs/:id', requireRequestPermission(JOBS_DELETE_PERMISSION), async (request, response) => {
  const job = await slicingJobs.delete(requireRequestWorkspaceId(request), requireRouteParam(request.params.id, 'Slicing job id'))
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
  const workspaceId = requireRequestWorkspaceId(request)
  const parsed = printFromLibrarySchema.omit({ fileId: true }).safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid print payload')
  const slicingJob = slicingJobs.get(workspaceId, requireRouteParam(request.params.id, 'Slicing job id'))
  if (slicingJob.status !== 'ready' || !slicingJob.outputFileId) {
    throw badRequest('Slicing job is not ready to print')
  }
  const dispatchJob = await enqueueLibraryPrint({
    fileId: slicingJob.outputFileId,
    ...parsed.data
  }, workspaceId)
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
  broadcastPrintDispatchChanged(workspaceId)
  response.status(202).json({ job: dispatchJob })
})

// Persist a "slice without saving" output into the library (un-hide the hidden gcode),
// optionally moving it to a chosen folder and/or renaming it.
const saveSlicedOutputSchema = z.object({
  outputFolderId: z.string().trim().min(1).nullable().optional(),
  outputFileName: z.string().trim().min(1).max(200).optional()
})
slicingRouter.post('/jobs/:id/save', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  const slicingJob = slicingJobs.get(workspaceId, requireRouteParam(request.params.id, 'Slicing job id'))
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
  slicingJobs.setOutputFile(workspaceId, slicingJob.id, file)
  annotateRequestAuditLog(request, {
    action: 'save-sliced-output',
    resource: 'library file',
    summary: file.replacedExisting
      ? `Saved sliced file ${file.name} to the library, replacing the existing file.`
      : `Saved sliced file ${file.name} to the library.`,
    metadata: { slicingJobId: slicingJob.id, fileId: file.id, fileName: file.name, replacedExisting: file.replacedExisting }
  })
  broadcastLibraryChanged(workspaceId)
  response.status(200).json({ file })
})

// Discard a "slice without saving" output the user didn't keep (closed the results
// without saving or printing). Removes the still-hidden gcode and the slice job record.
slicingRouter.post('/jobs/:id/discard', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  const slicingJob = slicingJobs.get(workspaceId, requireRouteParam(request.params.id, 'Slicing job id'))
  const discarded = slicingJob.outputFileId ? await discardHiddenSlicedOutput(slicingJob.outputFileId) : false
  // Drop the now-empty job record too; ignore if it is still slicing (cancel handles that).
  await slicingJobs.delete(workspaceId, slicingJob.id).catch(() => undefined)
  if (discarded) broadcastLibraryChanged(workspaceId)
  // Destructive (POST verb): the unsaved sliced output and the job record are removed.
  annotateRequestAuditLog(request, {
    action: 'discard-sliced-output',
    resource: 'slicing job',
    // Names both artifacts because this now removes two: the unsaved G-code AND the project that
    // was preserved for re-slicing it (nothing else references it once the output is gone).
    summary: `Discarded the unsaved sliced output and its preserved project for ${slicingJob.sourceFileName}.`,
    metadata: {
      slicingJobId: slicingJob.id,
      fileId: slicingJob.sourceFileId,
      fileName: slicingJob.sourceFileName,
      discardedOutput: discarded
    }
  })
  response.status(204).end()
})
