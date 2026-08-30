/**
 * 3D editor support API.
 *
 * Backs the interactive plate editor's foreign-geometry import and persistence:
 * - stage an STL/STEP/3MF from an upload or an existing library file (parsed/tessellated/extracted
 *   to a mesh held transiently and referenced by `importId` in a `SceneEdit`; 3MF is geometry-only:
 *   see `lib/three-mf-mesh-extract.ts`),
 * - stream a staged import back as binary STL for rendering,
 * - bake an edited arrangement (base project or a new one, plus imports) into a 3MF and persist it
 *   as a new library file or a new version of the base, or stream the bake back as a download
 *   without persisting anything (`/export-3mf`).
 *
 * Slicing the unsaved arrangement goes through the existing slicing route; this module owns import
 * staging and saving only. Route handlers stay thin: mesh parsing lives in `lib/mesh-import.ts`,
 * staging in `lib/import-store.ts`, and 3MF assembly in `lib/three-mf.ts`.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import {
  LIBRARY_DOWNLOAD_PERMISSION,
  DEFAULT_FILAMENT_COLOR,
  DEFAULT_FILAMENT_PRESET_NAME,
  LIBRARY_UPLOAD_PERMISSION,
  exportArrangedThreeMfSchema,
  saveArrangedThreeMfSchema,
  importNormalizationSchema,
  stageImportFromLibrarySchema,
  type ExportArrangedThreeMf,
  type StagedImport
} from '@printstream/shared'
import { z } from 'zod'
import { annotateRequestAuditLog, skipRequestAuditLog } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { resolveLibraryFileToLocalPath } from '../lib/bridge-library-files.js'
import { persistFilamentSettingOverrides } from '../lib/save-filament-overrides.js'
import { applyMachineOverridesToProject, applyMachinePresetChange, healSavedProjectMachineTopology, projectHasCompleteMachine, retargetSavedProjectMachine } from '../lib/save-retarget.js'
import { badRequest, HttpError, notFound } from '../lib/http-error.js'
import { getStagedImport, resolveSceneEditImports, stageImport } from '../lib/import-store.js'
import { discardHiddenSlicedOutput, persistLibraryFileFromLocalPath } from '../lib/library-files.js'
import { detectImportFormat, meshToBinaryStl, parseImportedMesh, type ImportedMesh } from '../lib/mesh-import.js'
import { extractThreeMfImportMesh } from '../lib/three-mf-mesh-extract.js'
import { prisma } from '../lib/prisma.js'
import { requireRequestWorkspaceId, requireRouteParam, sendModelBuffer, singleUploadWithLimit } from '../lib/request-helpers.js'
import { buildEditedThreeMf, createObjectCustomizedThreeMf, embedPlateThumbnails, rekeyReplacedObjectOverrides } from '../lib/three-mf.js'

const MAX_IMPORT_UPLOAD_BYTES = 256 * 1024 * 1024

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_UPLOAD_BYTES }
})

export const editorRouter = Router()

/** The 3MF extractor reads through the ZIP by path, so an uploaded buffer takes a temp-file hop. */
async function extractThreeMfMeshFromBuffer(buffer: Buffer): Promise<ImportedMesh> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'printstream-editor-import-'))
  const filePath = path.join(workDir, 'import.3mf')
  try {
    await writeFile(filePath, buffer)
    return await extractThreeMfImportMesh(filePath)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

/** Wrap multer so payload-too-large surfaces as a clean 413. */
function uploadImportFile(field: string) {
  return singleUploadWithLimit({
    upload,
    field,
    maxBytes: MAX_IMPORT_UPLOAD_BYTES,
    onLimitExceeded: (maxBytes) =>
      new HttpError(413, `Imported file exceeds ${Math.floor(maxBytes / (1024 * 1024))} MB limit`),
    onOtherError: (error) => (error instanceof Error ? error : undefined)
  })
}

editorRouter.post(
  '/imports',
  requireRequestPermission(LIBRARY_UPLOAD_PERMISSION),
  uploadImportFile('file'),
  async (request, response) => {
    const workspaceId = requireRequestWorkspaceId(request)
    const file = request.file
    if (!file) throw badRequest('No file uploaded')
    const format = detectImportFormat(file.originalname)
    if (!format) {
      throw badRequest('Only STL, STEP, and 3MF files can be imported from your device')
    }
    const mesh = format === '3mf'
      ? await extractThreeMfMeshFromBuffer(file.buffer)
      : await parseImportedMesh(file.buffer, format)
    const name = path.parse(file.originalname).name || 'Imported model'
    // A multipart field, so it arrives as text beside the file. Defaulting rather than rejecting a
    // request that omits it: `object` is the common case, and the CLIENT type already makes the
    // choice mandatory (`ImportNormalization`), so an omission here means a hand-made request.
    const normalize = importNormalizationSchema.catch('object').parse(request.body?.normalize)
    const staged = stageImport({ workspaceId, name, format, mesh, normalize })
    // Deliberately unaudited: staging is TRANSIENT and high-frequency. The mesh goes to an in-memory
    // LRU with a 2h TTL and nothing durable is created; one editor session stages an import per
    // added model, per cut half, per split shell, per carried helper volume and per primitive. What
    // actually materialises is audited where it lands, on `/save` (which records the object copy and
    // repaired-mesh counts). An entry here would be noise that buries those.
    skipRequestAuditLog(request)
    response.status(201).json({ import: staged satisfies StagedImport })
  }
)

editorRouter.post(
  '/imports/from-library',
  requireRequestPermission(LIBRARY_UPLOAD_PERMISSION),
  async (request, response) => {
    const workspaceId = requireRequestWorkspaceId(request)
    const parsed = stageImportFromLibrarySchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid import request')

    const libraryFile = await prisma.libraryFile.findFirst({
      where: { id: parsed.data.libraryFileId, workspaceId },
      select: { id: true, name: true, ownerBridgeId: true, storedPath: true }
    })
    if (!libraryFile) throw notFound('Library file not found')
    const format = detectImportFormat(libraryFile.name)
    if (!format) {
      throw badRequest('Only STL, STEP, and 3MF library files can be added this way')
    }

    const localPath = await resolveLibraryFileToLocalPath(libraryFile)
    const mesh = format === '3mf'
      ? await extractThreeMfImportMesh(localPath, parsed.data.objectId != null ? { objectId: parsed.data.objectId } : undefined)
      : await parseImportedMesh(await readFile(localPath), format)
    const name = path.parse(libraryFile.name).name || 'Imported model'
    const staged = stageImport({ workspaceId, name, format, mesh, normalize: parsed.data.normalize })
    // Transient and high-frequency, exactly as for the upload route above: audited where the
    // geometry is persisted, not where it is staged.
    skipRequestAuditLog(request)
    response.status(201).json({ import: staged satisfies StagedImport })
  }
)

editorRouter.get(
  '/imports/:importId/mesh',
  requireRequestPermission(LIBRARY_UPLOAD_PERMISSION),
  async (request, response) => {
    const workspaceId = requireRequestWorkspaceId(request)
    const importId = requireRouteParam(request.params.importId, 'Import id')
    const record = getStagedImport(importId, workspaceId)
    if (!record) throw notFound('Imported model not found or expired')
    // `?part=N` streams the Nth named solid of a multi-solid import; without it (or for a
    // single-solid import) the merged mesh is returned.
    const partParam = request.query.part
    const parts = record.mesh.parts
    let mesh = record.mesh
    if (typeof partParam === 'string' && parts && parts.length > 1) {
      const index = Number.parseInt(partParam, 10)
      if (!Number.isInteger(index) || index < 0 || index >= parts.length) throw badRequest('Invalid import part')
      mesh = parts[index]!.mesh
    }
    // `meshToBinaryStl` is shared code and returns a Uint8Array; the response helper takes a
    // Buffer. Buffer.from over the same memory, no copy.
    const stl = Buffer.from(meshToBinaryStl(mesh).buffer)
    response.setHeader('Cache-Control', 'private, max-age=300')
    await sendModelBuffer(request, response, stl, 'model/stl')
  }
)

/** Name the failing field so a malformed save/export is actionable (full issues go to the log). */
function parseArrangedBody<T>(schema: { safeParse: (body: unknown) => z.SafeParseReturnType<unknown, T> }, body: unknown, what: string): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? ` (at ${issue.path.join('.')})` : ''
    console.warn(`[editor] ${what} validation failed:`, JSON.stringify(parsed.error.issues))
    throw badRequest(`Invalid ${what} request: ${issue?.message ?? 'validation failed'}${where}`)
  }
  return parsed.data
}

/**
 * Resolve an explicit content base, the bytes the editor pinned at open, to something
 * `resolveLibraryFileToLocalPath` can read.
 *
 * Workspace-scoped like every other lookup here, but deliberately NOT scoped to the save target: the
 * whole point of the field is that the two can diverge (see `contentBase` in the shared schema).
 * A pinned base that no longer exists is a hard error rather than a silent fall back to the
 * target's current bytes, because falling back would quietly resume the save-onto-last-save
 * chaining this exists to stop.
 */
async function resolvePinnedContentBase(
  workspaceId: string,
  contentBase: { fileId: string; versionId?: string | null }
): Promise<{ ownerBridgeId: string | null; storedPath: string }> {
  if (contentBase.versionId) {
    const version = await prisma.libraryFileVersion.findFirst({
      where: { id: contentBase.versionId, workspaceId, libraryFileId: contentBase.fileId },
      select: { ownerBridgeId: true, storedPath: true }
    })
    if (!version) throw notFound('The version this project was opened from is no longer available')
    return version
  }
  const file = await prisma.libraryFile.findFirst({
    where: { id: contentBase.fileId, workspaceId },
    select: { ownerBridgeId: true, storedPath: true }
  })
  if (!file) throw notFound('The file this project was opened from is no longer available')
  return file
}

/**
 * Bake an edited arrangement into a ready-to-persist/stream 3MF inside `workDir`:
 * base bytes + staged imports + per-object/global process overrides + plate thumbnails,
 * then an optional cross-machine retarget, the chosen machine preset, and last the project's own machine overrides. Shared by `/save` (persists the result) and
 * `/export-3mf` (streams it back without persisting). The caller owns `workDir` cleanup;
 * the retarget artifact's directory is returned via `extraCleanupDirs` for the same rm.
 */
async function bakeArrangedThreeMf(
  workspaceId: string,
  input: ExportArrangedThreeMf,
  workDir: string,
  fileName: string
): Promise<{ bakedPath: string; importCount: number; extraCleanupDirs: string[]; baseFile: { id: string; name: string; ownerBridgeId: string | null; folderId: string | null } | null; machineTopologyHealed: boolean; machinePresetReauthored: boolean; machineOverridesPersisted: boolean }> {
  const { baseFileId, baseVersionId, sceneEdit, retarget, slicerTargetId, objectProcessOverrides, processSettingOverrides, machineSettingOverrides, filamentSettingOverrides, objectExport } = input

  const baseFile = baseFileId
    ? await prisma.libraryFile.findFirst({
      where: { id: baseFileId, workspaceId },
      select: { id: true, name: true, ownerBridgeId: true, storedPath: true, folderId: true }
    })
    : null
  if (baseFileId && !baseFile) throw notFound('Base file not found')

  // Editing an archived version: build from THAT version's bytes. The save target is
  // unchanged (the parent file), so persisting archives the current content and the
  // edited result becomes a NEW version: the old version is never mutated.
  const baseVersion = baseVersionId
    ? await prisma.libraryFileVersion.findFirst({
      where: { id: baseVersionId, workspaceId, libraryFileId: baseFileId ?? undefined },
      select: { id: true, ownerBridgeId: true, storedPath: true }
    })
    : null
  if (baseVersionId && !baseVersion) throw notFound('Base version not found')

  // An explicit content base (the editor pinning the version it OPENED) is resolved WITHOUT
  // reference to the save target: see the schema doc. A saveAs continues the session against a
  // new file while still authoring from the original's bytes, so scoping this lookup to
  // `baseFileId` would reject exactly the case the field exists for.
  //
  // Skipped entirely under `ignoreBaseContent`, and that guard is load-bearing rather than an
  // optimisation: an editor-born session pins its new-project SCAFFOLD, which is a hidden row that
  // gets discarded on abandon and swept by `pruneHiddenLibraryFiles`. Resolving a pin whose bytes
  // are then thrown away turned "the scaffold is gone" into a hard 404 on every subsequent save,
  // a save that had no need of those bytes in the first place.
  const pinnedBase = input.contentBase && !input.ignoreBaseContent
    ? await resolvePinnedContentBase(workspaceId, input.contentBase)
    : null

  // `ignoreBaseContent` keeps the base file as the save TARGET (name/folder/bridge, resolved
  // above) but bakes from the editor state alone: see the schema doc: re-reading the previous
  // save's bytes strands one orphaned mesh object per solid per save for an import-backed
  // project, which is what forced the editor to re-mount on the saved file after every save.
  const baseSource = input.ignoreBaseContent ? null : (pinnedBase ?? baseVersion ?? baseFile)
  const basePath = baseSource ? await resolveLibraryFileToLocalPath(baseSource) : null
  const imports = resolveSceneEditImports(workspaceId, sceneEdit)

  const outputPath = path.join(workDir, 'arranged.3mf')
  const extraCleanupDirs: string[] = []
  const { replacedObjectIds, clonedObjectIds } = await buildEditedThreeMf(basePath, outputPath, sceneEdit, imports, {
    globalProcessOverrides: processSettingOverrides,
    objectExportMarker: objectExport === true
  })
  // Persist per-object PROCESS overrides into the saved 3MF (so they survive the save, not
  // just a slice). Overrides authored against a replaced/imported object are keyed by its
  // editor identity; re-key onto the baked object_id, then inject as model_settings metadata.
  let workingPath = outputPath
  if (objectProcessOverrides && Object.keys(objectProcessOverrides).length > 0) {
    // Both a replaced object and an independent COPY are addressed by an editor-side id the baked
    // file does not use; re-key through the same helper so neither needs a save first.
    const rekeyed = rekeyReplacedObjectOverrides(objectProcessOverrides, [...replacedObjectIds, ...clonedObjectIds])
    const customizedPath = path.join(workDir, 'customized.3mf')
    await createObjectCustomizedThreeMf(workingPath, customizedPath, 0, { objectProcessOverrides: rekeyed })
    workingPath = customizedPath
  }
  // Persist per-MATERIAL tune-dialog overrides ("Save in this 3MF") into project_settings:
  // values AND their different_settings_to_system record, which is what makes the retarget
  // below preserve them instead of rebinding them away as fossils. Must run BEFORE the retarget
  // for exactly that reason. Best-effort: null means nothing to write / could not write, and the
  // overrides still ride slice requests either way.
  if (filamentSettingOverrides && Object.keys(filamentSettingOverrides).length > 0) {
    const overriddenPath = await persistFilamentSettingOverrides({
      workspaceId,
      arrangedPath: workingPath,
      fileName,
      slicerTargetId,
      overrides: filamentSettingOverrides
    })
    if (overriddenPath) {
      workingPath = overriddenPath
      extraCleanupDirs.push(path.dirname(overriddenPath))
    }
  }
  // Embed the editor's freshly-rendered plate previews so the saved 3MF's thumbnail
  // reflects the current arrangement. buildEditedThreeMf otherwise preserves the base
  // file's old embedded PNGs, which would show a stale (pre-rearrange) layout.
  if (sceneEdit.plateThumbnails && sceneEdit.plateThumbnails.length > 0) {
    await embedPlateThumbnails(
      workingPath,
      sceneEdit.plateThumbnails.map((thumb) => ({ plateIndex: thumb.plateIndex, png: Buffer.from(thumb.png, 'base64') }))
    ).catch(() => undefined)
  }

  // "Save as a different printer": retarget the baked project to the chosen machine via the
  // slicer's machine switch, so the saved 3MF opens/slices for the new printer instead of
  // silently keeping the source machine. buildEditedThreeMf alone never switches the machine.
  let bakedPath = workingPath
  let machineTopologyHealed = false
  // Both are recorded in the save's audit entry: each rewrites the project's machine block, and
  // `retargetedTo` cannot distinguish them because the MODEL is unchanged in exactly these cases.
  let machinePresetReauthored = false
  let machineOverridesPersisted = false
  if (retarget && !(await projectHasCompleteMachine(workingPath, retarget.printerModel))) {
    // Either a genuine printer CHANGE, or the same printer on a project that never carried that
    // machine's full definition (e.g. one naming `printer_model: H2D` without H2D's dual-nozzle
    // topology). Both need the machine authored in, we are the source of truth for the 3MF, so a
    // saved project must define its own machine rather than leaning on slice-time fallbacks.
    bakedPath = await retargetSavedProjectMachine({
      workspaceId,
      arrangedPath: workingPath,
      fileName,
      slicerTargetId,
      retarget
    })
    extraCleanupDirs.push(path.dirname(bakedPath))
  } else if (retarget) {
    // Right MODEL and fully defined, but the chosen machine PRESET can still differ (an H2D
    // variant, a nozzle size, a user's own tuned machine). Authoring the machine only is what lets
    // this run at all: re-running the full retarget here would overwrite the user's process
    // settings, which is why this branch used to do nothing whatsoever, and why the user's preset
    // pick was accepted by the editor and then silently dropped by the save.
    const presetAppliedPath = await applyMachinePresetChange({
      workspaceId,
      arrangedPath: workingPath,
      fileName,
      slicerTargetId,
      retarget
    })
    if (presetAppliedPath) {
      bakedPath = presetAppliedPath
      extraCleanupDirs.push(path.dirname(presetAppliedPath))
      machinePresetReauthored = true
    }
  } else {
    // Same-model save: if the base project LOST its dual-nozzle machine block (a filament
    // rewrite once stripped the extruder-indexed machine arrays), re-author it from the
    // project's own machine preset so this save cannot produce an unsliceable project.
    //
    // This is AUTHORING, not repair, and the distinction is the one `repairs/index.ts` draws.
    // It runs on the file the bake just produced, in a temp dir, before anything is persisted;
    // it never touches a stored file. A stored project is only ever rewritten by a save the user
    // asked for, which is why there is no server-side repair route. (This comment used to say the
    // file "heals at rest", which describes the exact thing the contract forbids and is not what
    // happens here.) The save records `machineTopologyHealed` in its audit entry either way, so a
    // project whose machine block was re-authored says so.
    //
    // Best-effort: null means "not needed or not possible" and the save proceeds unchanged.
    const healedPath = await healSavedProjectMachineTopology({
      workspaceId,
      arrangedPath: workingPath,
      fileName,
      slicerTargetId,
      filaments: sceneEdit.filaments
    })
    if (healedPath) {
      bakedPath = healedPath
      extraCleanupDirs.push(path.dirname(healedPath))
      machineTopologyHealed = true
    }
  }
  // The project's OWN machine settings, last in the machine domain: overrides and the resolved
  // preset write the SAME keys, so any earlier position would let whichever branch above authored
  // the machine overwrite the user's values.
  // Runs for an EMPTY map too: that is how a reset-them-all reaches the file. The pass itself
  // returns null when the project records no overrides either, so an untouched printer is untouched.
  if (machineSettingOverrides) {
    const overriddenPath = await applyMachineOverridesToProject({
      workspaceId,
      arrangedPath: bakedPath,
      fileName,
      slicerTargetId,
      retarget,
      machineSettingOverrides
    })
    if (overriddenPath) {
      bakedPath = overriddenPath
      extraCleanupDirs.push(path.dirname(overriddenPath))
      machineOverridesPersisted = true
    }
  }

  return { bakedPath, importCount: imports.length, extraCleanupDirs, baseFile, machineTopologyHealed, machinePresetReauthored, machineOverridesPersisted }
}

editorRouter.post(
  '/save',
  requireRequestPermission(LIBRARY_UPLOAD_PERMISSION),
  async (request, response) => {
    const workspaceId = requireRequestWorkspaceId(request)
    const parsed = parseArrangedBody(saveArrangedThreeMfSchema, request.body, 'save')
    const { mode, baseFileId } = parsed

    const workDir = await mkdtemp(path.join(tmpdir(), 'printstream-editor-save-'))
    // Extra temp dirs to clean up (e.g. the retargeted artifact downloaded from the slicer).
    let extraCleanupDirs: string[] = []
    try {
      // The target name is needed before the bake (the retarget artifact is named after it),
      // but the newVersion branch needs the base file's name, resolved inside the bake, so
      // compute the saveAs form here and patch the newVersion form after.
      const saveAsName = parsed.name && !parsed.name.toLowerCase().endsWith('.3mf') ? `${parsed.name}.3mf` : parsed.name
      const baked = await bakeArrangedThreeMf(workspaceId, parsed, workDir, mode === 'newVersion' ? 'edited.3mf' : saveAsName!)
      extraCleanupDirs = baked.extraCleanupDirs

      const target = mode === 'newVersion'
        ? { name: baked.baseFile!.name, folderId: baked.baseFile!.folderId, bridgeId: baked.baseFile!.ownerBridgeId ?? null }
        : {
          name: saveAsName!,
          folderId: parsed.folderId ?? baked.baseFile?.folderId ?? null,
          bridgeId: parsed.bridgeId ?? baked.baseFile?.ownerBridgeId ?? null
        }
      const sizeBytes = (await stat(baked.bakedPath)).size

      const { file: created, archivedVersionId } = await persistLibraryFileFromLocalPath({
        workspaceId,
        sourcePath: baked.bakedPath,
        fileName: target.name,
        sizeBytes,
        folderId: target.folderId,
        bridgeId: target.bridgeId,
        hidden: false,
        request,
        auditAction: 'upload',
        missingBridgeMessage: 'Select a bridge before saving the edited model'
      })

      annotateRequestAuditLog(request, {
        action: 'upload',
        resource: 'library file',
        summary: `Saved edited 3MF ${created.name}.`,
        // Counts only, never the edit's contents. `objectCopyCount` and `repairedMeshCount` are
        // here because both MATERIALISE new or altered geometry in the saved file, so a support
        // question about an unexpected object or a changed mesh can be answered from the trail.
        metadata: { fileId: created.id, mode, baseFileId: baseFileId ?? null, bakedFromEditorStateOnly: parsed.ignoreBaseContent === true, importCount: baked.importCount, objectCopyCount: parsed.sceneEdit?.objectClones?.length ?? 0, repairedMeshCount: (parsed.sceneEdit?.repairedObjectIds?.length ?? 0) + (parsed.sceneEdit?.repairedImportIds?.length ?? 0), retargetedTo: parsed.retarget?.printerModel ?? null, machineTopologyHealed: baked.machineTopologyHealed, machinePresetReauthored: baked.machinePresetReauthored, machineOverridesPersisted: baked.machineOverridesPersisted, globalProcessOverridesPersisted: parsed.processSettingOverrides != null && Object.keys(parsed.processSettingOverrides).length > 0 }
      })
      // `archivedVersionId` is the content that was current until this save: i.e. the bytes this
      // save authored FROM. The editor pins it so its next save authors from the same original
      // instead of from this save's output (see `contentBase` in the shared schema). Null when the
      // save created a new file rather than a version, in which case the caller keeps its
      // existing pin: a saveAs must not re-base onto the file it just created.
      response.status(201).json({ file: { id: created.id, name: created.name }, archivedVersionId })
    } finally {
      await rm(workDir, { recursive: true, force: true })
      await Promise.all(extraCleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })))
    }
  }
)

/**
 * Bake an edited arrangement and stream the 3MF back as a download: the download
 * counterpart of a saveAs ("Download 3MF project"): nothing is persisted server-side,
 * so there is no library row to clean up and no visible residue. Gated on the library
 * DOWNLOAD permission to match the editor's other export-download items (the web hides
 * the item without it); the bake itself only reads the base file and staged imports.
 * Counterpart: `handleExportObjectAs3mfDownload` in the web's `useEditorSave.ts`.
 */
editorRouter.post(
  '/export-3mf',
  requireRequestPermission(LIBRARY_DOWNLOAD_PERMISSION),
  async (request, response) => {
    const workspaceId = requireRequestWorkspaceId(request)
    const parsed = parseArrangedBody(exportArrangedThreeMfSchema, request.body, 'export')
    const fileName = parsed.name && !parsed.name.toLowerCase().endsWith('.3mf') ? `${parsed.name}.3mf` : (parsed.name ?? 'export.3mf')

    const workDir = await mkdtemp(path.join(tmpdir(), 'printstream-editor-export-'))
    let extraCleanupDirs: string[] = []
    try {
      const baked = await bakeArrangedThreeMf(workspaceId, parsed, workDir, fileName)
      extraCleanupDirs = baked.extraCleanupDirs
      const bytes = await readFile(baked.bakedPath)

      annotateRequestAuditLog(request, {
        action: 'export-3mf',
        resource: 'library file',
        summary: `Exported edited 3MF ${fileName} for download.`,
        metadata: { baseFileId: parsed.baseFileId ?? null, fileName, importCount: baked.importCount, retargetedTo: parsed.retarget?.printerModel ?? null, machineTopologyHealed: baked.machineTopologyHealed, sizeBytes: bytes.length }
      })
      await sendModelBuffer(request, response, bytes, 'model/3mf')
    } finally {
      await rm(workDir, { recursive: true, force: true })
      await Promise.all(extraCleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })))
    }
  }
)

const newProjectSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  bridgeId: z.string().trim().min(1).nullable().optional(),
  folderId: z.string().trim().min(1).nullable().optional()
})

/**
 * Create a brand-new project: a hidden, empty 3MF "scaffold" that backs the editor so
 * a new project gets the SAME full editor (settings/materials/slice) as an existing file
 * without a file-less code path. It stays out of the library (hidden): the user's real
 * file is created when they Save; the scaffold is discarded on close (see /scaffold/:id/discard).
 */
editorRouter.post('/new-project', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  const parsed = newProjectSchema.safeParse(request.body ?? {})
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid new project request')
  const rawName = parsed.data.name?.trim() || 'Untitled'
  const fileName = rawName.toLowerCase().endsWith('.3mf') ? rawName : `${rawName}.3mf`

  const workDir = await mkdtemp(path.join(tmpdir(), 'printstream-editor-new-'))
  const outputPath = path.join(workDir, 'new.3mf')
  try {
    // Seed one guaranteed-present filament so a from-scratch project opens WITH a material rather
    // than an empty, unsliceable slot list. Generic PLA (white) resolves for every machine; the
    // user can change it in the slice settings. Without this the scaffold's project_settings has no
    // filament arrays and the editor shows zero materials.
    await buildEditedThreeMf(
      null,
      outputPath,
      { plates: [{ index: 1 }], instances: [], filaments: [{ color: DEFAULT_FILAMENT_COLOR, type: 'PLA', settingsId: DEFAULT_FILAMENT_PRESET_NAME }] },
      []
    )
    const sizeBytes = (await stat(outputPath)).size
    const { file: created } = await persistLibraryFileFromLocalPath({
      workspaceId,
      sourcePath: outputPath,
      fileName,
      sizeBytes,
      folderId: parsed.data.folderId ?? null,
      bridgeId: parsed.data.bridgeId ?? null,
      hidden: true,
      origin: 'scaffold',
      missingBridgeMessage: 'Select a bridge before creating a project'
    })
    annotateRequestAuditLog(request, {
      action: 'create-editor-project',
      resource: 'library file',
      summary: `Created new editor project ${created.name}.`,
      metadata: {
        fileId: created.id,
        fileName: created.name
      }
    })
    response.status(201).json({ file: { id: created.id, name: created.name } })
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
})

/** Discard a new-project scaffold the user abandoned (only deletes while still hidden). */
editorRouter.post('/scaffold/:id/discard', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  const fileId = requireRouteParam(request.params.id, 'File id')
  const row = await prisma.libraryFile.findFirst({ where: { id: fileId, workspaceId }, select: { id: true, name: true } })
  if (!row) throw notFound('Project not found')
  const discarded = await discardHiddenSlicedOutput(fileId)
  // Destructive (POST verb): an abandoned new-project scaffold is deleted.
  annotateRequestAuditLog(request, {
    action: 'discard-editor-project',
    resource: 'library file',
    summary: `Discarded the new editor project scaffold ${row.name}.`,
    metadata: {
      fileId: row.id,
      fileName: row.name,
      discarded
    }
  })
  response.json({ discarded })
})
