/**
 * 3D editor support API.
 *
 * Backs the interactive plate editor's foreign-geometry import and persistence:
 * - stage an STL/STEP/3MF from an upload or an existing library file (parsed/tessellated/extracted
 *   to a mesh held transiently and referenced by `importId` in a `SceneEdit`; 3MF is geometry-only —
 *   see `lib/three-mf-mesh-extract.ts`),
 * - stream a staged import back as binary STL for rendering,
 * - bake an edited arrangement (base project or a new one, plus imports) into a 3MF and persist it
 *   as a new library file or a new version of the base — or stream the bake back as a download
 *   without persisting anything (`/export-3mf`).
 *
 * Slicing the unsaved arrangement goes through the existing slicing route; this module owns import
 * staging and saving only. Route handlers stay thin — mesh parsing lives in `lib/mesh-import.ts`,
 * staging in `lib/import-store.ts`, and 3MF assembly in `lib/three-mf.ts`.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import {
  LIBRARY_DOWNLOAD_PERMISSION,
  LIBRARY_UPLOAD_PERMISSION,
  exportArrangedThreeMfSchema,
  saveArrangedThreeMfSchema,
  stageImportFromLibrarySchema,
  type ExportArrangedThreeMf,
  type StagedImport
} from '@printstream/shared'
import { z } from 'zod'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { resolveLibraryFileToLocalPath } from '../lib/bridge-library-files.js'
import { healSavedProjectMachineTopology, retargetSavedProjectMachine } from '../lib/save-retarget.js'
import { badRequest, HttpError, notFound } from '../lib/http-error.js'
import { getStagedImport, resolveSceneEditImports, stageImport } from '../lib/import-store.js'
import { discardHiddenSlicedOutput, persistLibraryFileFromLocalPath } from '../lib/library-files.js'
import { detectImportFormat, meshToBinaryStl, parseImportedMesh, type ImportedMesh } from '../lib/mesh-import.js'
import { extractThreeMfImportMesh } from '../lib/three-mf-mesh-extract.js'
import { prisma } from '../lib/prisma.js'
import { requireRequestTenantId, requireRouteParam, sendModelBuffer, singleUploadWithLimit } from '../lib/request-helpers.js'
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
    const tenantId = requireRequestTenantId(request)
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
    const staged = stageImport({ tenantId, name, format, mesh })
    response.status(201).json({ import: staged satisfies StagedImport })
  }
)

editorRouter.post(
  '/imports/from-library',
  requireRequestPermission(LIBRARY_UPLOAD_PERMISSION),
  async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const parsed = stageImportFromLibrarySchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid import request')

    const libraryFile = await prisma.libraryFile.findFirst({
      where: { id: parsed.data.libraryFileId, tenantId },
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
    const staged = stageImport({ tenantId, name, format, mesh })
    response.status(201).json({ import: staged satisfies StagedImport })
  }
)

editorRouter.get(
  '/imports/:importId/mesh',
  requireRequestPermission(LIBRARY_UPLOAD_PERMISSION),
  async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const importId = requireRouteParam(request.params.importId, 'Import id')
    const record = getStagedImport(importId, tenantId)
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
    const stl = meshToBinaryStl(mesh)
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
 * Bake an edited arrangement into a ready-to-persist/stream 3MF inside `workDir`:
 * base bytes + staged imports + per-object/global process overrides + plate thumbnails,
 * then an optional cross-machine retarget. Shared by `/save` (persists the result) and
 * `/export-3mf` (streams it back without persisting). The caller owns `workDir` cleanup;
 * the retarget artifact's directory is returned via `extraCleanupDirs` for the same rm.
 */
async function bakeArrangedThreeMf(
  tenantId: string,
  input: ExportArrangedThreeMf,
  workDir: string,
  fileName: string
): Promise<{ bakedPath: string; importCount: number; extraCleanupDirs: string[]; baseFile: { id: string; name: string; ownerBridgeId: string | null; folderId: string | null } | null; machineTopologyHealed: boolean }> {
  const { baseFileId, baseVersionId, sceneEdit, retarget, slicerTargetId, objectProcessOverrides, processSettingOverrides, objectExport } = input

  const baseFile = baseFileId
    ? await prisma.libraryFile.findFirst({
      where: { id: baseFileId, tenantId },
      select: { id: true, name: true, ownerBridgeId: true, storedPath: true, folderId: true }
    })
    : null
  if (baseFileId && !baseFile) throw notFound('Base file not found')

  // Editing an archived version: build from THAT version's bytes. The save target is
  // unchanged (the parent file), so persisting archives the current content and the
  // edited result becomes a NEW version — the old version is never mutated.
  const baseVersion = baseVersionId
    ? await prisma.libraryFileVersion.findFirst({
      where: { id: baseVersionId, tenantId, libraryFileId: baseFileId ?? undefined },
      select: { id: true, ownerBridgeId: true, storedPath: true }
    })
    : null
  if (baseVersionId && !baseVersion) throw notFound('Base version not found')

  const baseSource = baseVersion ?? baseFile
  const basePath = baseSource ? await resolveLibraryFileToLocalPath(baseSource) : null
  const imports = resolveSceneEditImports(tenantId, sceneEdit)

  const outputPath = path.join(workDir, 'arranged.3mf')
  const extraCleanupDirs: string[] = []
  const { replacedObjectIds } = await buildEditedThreeMf(basePath, outputPath, sceneEdit, imports, {
    globalProcessOverrides: processSettingOverrides,
    objectExportMarker: objectExport === true
  })
  // Persist per-object PROCESS overrides into the saved 3MF (so they survive the save, not
  // just a slice). Overrides authored against a replaced/imported object are keyed by its
  // editor identity; re-key onto the baked object_id, then inject as model_settings metadata.
  let workingPath = outputPath
  if (objectProcessOverrides && Object.keys(objectProcessOverrides).length > 0) {
    const rekeyed = rekeyReplacedObjectOverrides(objectProcessOverrides, replacedObjectIds)
    const customizedPath = path.join(workDir, 'customized.3mf')
    await createObjectCustomizedThreeMf(workingPath, customizedPath, 0, { objectProcessOverrides: rekeyed })
    workingPath = customizedPath
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
  if (retarget) {
    bakedPath = await retargetSavedProjectMachine({
      tenantId,
      arrangedPath: workingPath,
      fileName,
      slicerTargetId,
      retarget
    })
    extraCleanupDirs.push(path.dirname(bakedPath))
  } else {
    // Same-model save: if the base project LOST its dual-nozzle machine block (a filament
    // rewrite once stripped the extruder-indexed machine arrays), re-author it from the
    // project's own machine preset so the file heals at rest instead of staying unsliceable.
    // Best-effort — null means "not needed or not possible" and the save proceeds unchanged.
    const healedPath = await healSavedProjectMachineTopology({
      tenantId,
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
  return { bakedPath, importCount: imports.length, extraCleanupDirs, baseFile, machineTopologyHealed }
}

editorRouter.post(
  '/save',
  requireRequestPermission(LIBRARY_UPLOAD_PERMISSION),
  async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const parsed = parseArrangedBody(saveArrangedThreeMfSchema, request.body, 'save')
    const { mode, baseFileId } = parsed

    const workDir = await mkdtemp(path.join(tmpdir(), 'printstream-editor-save-'))
    // Extra temp dirs to clean up (e.g. the retargeted artifact downloaded from the slicer).
    let extraCleanupDirs: string[] = []
    try {
      // The target name is needed before the bake (the retarget artifact is named after it),
      // but the newVersion branch needs the base file's name — resolved inside the bake — so
      // compute the saveAs form here and patch the newVersion form after.
      const saveAsName = parsed.name && !parsed.name.toLowerCase().endsWith('.3mf') ? `${parsed.name}.3mf` : parsed.name
      const baked = await bakeArrangedThreeMf(tenantId, parsed, workDir, mode === 'newVersion' ? 'edited.3mf' : saveAsName!)
      extraCleanupDirs = baked.extraCleanupDirs

      const target = mode === 'newVersion'
        ? { name: baked.baseFile!.name, folderId: baked.baseFile!.folderId, bridgeId: baked.baseFile!.ownerBridgeId ?? null }
        : {
          name: saveAsName!,
          folderId: parsed.folderId ?? baked.baseFile?.folderId ?? null,
          bridgeId: parsed.bridgeId ?? baked.baseFile?.ownerBridgeId ?? null
        }
      const sizeBytes = (await stat(baked.bakedPath)).size

      const { file: created } = await persistLibraryFileFromLocalPath({
        tenantId,
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
        metadata: { fileId: created.id, mode, baseFileId: baseFileId ?? null, importCount: baked.importCount, retargetedTo: parsed.retarget?.printerModel ?? null, machineTopologyHealed: baked.machineTopologyHealed, globalProcessOverridesPersisted: parsed.processSettingOverrides != null && Object.keys(parsed.processSettingOverrides).length > 0 }
      })
      response.status(201).json({ file: { id: created.id, name: created.name } })
    } finally {
      await rm(workDir, { recursive: true, force: true })
      await Promise.all(extraCleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })))
    }
  }
)

/**
 * Bake an edited arrangement and stream the 3MF back as a download — the download
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
    const tenantId = requireRequestTenantId(request)
    const parsed = parseArrangedBody(exportArrangedThreeMfSchema, request.body, 'export')
    const fileName = parsed.name && !parsed.name.toLowerCase().endsWith('.3mf') ? `${parsed.name}.3mf` : (parsed.name ?? 'export.3mf')

    const workDir = await mkdtemp(path.join(tmpdir(), 'printstream-editor-export-'))
    let extraCleanupDirs: string[] = []
    try {
      const baked = await bakeArrangedThreeMf(tenantId, parsed, workDir, fileName)
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
 * without a file-less code path. It stays out of the library (hidden) — the user's real
 * file is created when they Save; the scaffold is discarded on close (see /scaffold/:id/discard).
 */
editorRouter.post('/new-project', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), async (request, response) => {
  const tenantId = requireRequestTenantId(request)
  const parsed = newProjectSchema.safeParse(request.body ?? {})
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid new project request')
  const rawName = parsed.data.name?.trim() || 'Untitled'
  const fileName = rawName.toLowerCase().endsWith('.3mf') ? rawName : `${rawName}.3mf`

  const workDir = await mkdtemp(path.join(tmpdir(), 'printstream-editor-new-'))
  const outputPath = path.join(workDir, 'new.3mf')
  try {
    await buildEditedThreeMf(null, outputPath, { plates: [{ index: 1 }], instances: [] }, [])
    const sizeBytes = (await stat(outputPath)).size
    const { file: created } = await persistLibraryFileFromLocalPath({
      tenantId,
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
  const tenantId = requireRequestTenantId(request)
  const fileId = requireRouteParam(request.params.id, 'File id')
  const row = await prisma.libraryFile.findFirst({ where: { id: fileId, tenantId }, select: { id: true, name: true } })
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
