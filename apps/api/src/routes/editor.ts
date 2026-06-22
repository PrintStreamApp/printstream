/**
 * 3D editor support API.
 *
 * Backs the interactive plate editor's foreign-geometry import and persistence:
 * - stage an STL/STEP from an upload or an existing library file (parsed/tessellated to a mesh held
 *   transiently and referenced by `importId` in a `SceneEdit`),
 * - stream a staged import back as binary STL for rendering,
 * - bake an edited arrangement (base project or a new one, plus imports) into a 3MF and persist it
 *   as a new library file or a new version of the base.
 *
 * Slicing the unsaved arrangement goes through the existing slicing route; this module owns import
 * staging and saving only. Route handlers stay thin — mesh parsing lives in `lib/mesh-import.ts`,
 * staging in `lib/import-store.ts`, and 3MF assembly in `lib/three-mf.ts`.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import {
  LIBRARY_UPLOAD_PERMISSION,
  saveArrangedThreeMfSchema,
  stageImportFromLibrarySchema,
  type StagedImport
} from '@printstream/shared'
import { z } from 'zod'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { resolveLibraryFileToLocalPath } from '../lib/bridge-library-files.js'
import { retargetSavedProjectMachine } from '../lib/save-retarget.js'
import { badRequest, HttpError, notFound } from '../lib/http-error.js'
import { getStagedImport, resolveSceneEditImports, stageImport } from '../lib/import-store.js'
import { discardHiddenSlicedOutput, persistLibraryFileFromLocalPath } from '../lib/library-files.js'
import { detectImportFormat, meshToBinaryStl, parseImportedMesh } from '../lib/mesh-import.js'
import { prisma } from '../lib/prisma.js'
import { requireRequestTenantId, requireRouteParam, sendModelBuffer, singleUploadWithLimit } from '../lib/request-helpers.js'
import { buildEditedThreeMf, createObjectCustomizedThreeMf, embedPlateThumbnails, rekeyReplacedObjectOverrides } from '../lib/three-mf.js'

const MAX_IMPORT_UPLOAD_BYTES = 256 * 1024 * 1024

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_UPLOAD_BYTES }
})

export const editorRouter = Router()

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
    if (!format || format === '3mf') {
      throw badRequest('Only STL and STEP files can be imported from your device')
    }
    const mesh = await parseImportedMesh(file.buffer, format)
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
    if (format !== 'stl' && format !== 'step') {
      throw badRequest('Only STL and STEP library files can be added this way')
    }

    const localPath = await resolveLibraryFileToLocalPath(libraryFile)
    const mesh = await parseImportedMesh(await readFile(localPath), format)
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

editorRouter.post(
  '/save',
  requireRequestPermission(LIBRARY_UPLOAD_PERMISSION),
  async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const parsed = saveArrangedThreeMfSchema.safeParse(request.body)
    if (!parsed.success) {
      // A bare "Invalid" tells the user nothing; name the failing field so a malformed save is
      // actionable (and log the full issue list against the requestId for deeper debugging).
      const issue = parsed.error.issues[0]
      const where = issue?.path.length ? ` (at ${issue.path.join('.')})` : ''
      console.warn('[editor] save validation failed:', JSON.stringify(parsed.error.issues))
      throw badRequest(`Invalid save request: ${issue?.message ?? 'validation failed'}${where}`)
    }
    const { baseFileId, baseVersionId, mode, sceneEdit, retarget, slicerTargetId, objectProcessOverrides } = parsed.data

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

    const workDir = await mkdtemp(path.join(tmpdir(), 'printstream-editor-save-'))
    const outputPath = path.join(workDir, 'arranged.3mf')
    // Extra temp dirs to clean up (e.g. the retargeted artifact downloaded from the slicer).
    const extraCleanupDirs: string[] = []
    try {
      const { replacedObjectIds } = await buildEditedThreeMf(basePath, outputPath, sceneEdit, imports)
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

      const target = mode === 'newVersion'
        ? { name: baseFile!.name, folderId: baseFile!.folderId, bridgeId: baseFile!.ownerBridgeId ?? null }
        : {
          name: parsed.data.name!.toLowerCase().endsWith('.3mf') ? parsed.data.name! : `${parsed.data.name!}.3mf`,
          folderId: parsed.data.folderId ?? baseFile?.folderId ?? null,
          bridgeId: parsed.data.bridgeId ?? baseFile?.ownerBridgeId ?? null
        }

      // "Save as a different printer": retarget the baked project to the chosen machine via the
      // slicer's machine switch, so the saved 3MF opens/slices for the new printer instead of
      // silently keeping the source machine. buildEditedThreeMf alone never switches the machine.
      let persistSourcePath = workingPath
      if (retarget) {
        persistSourcePath = await retargetSavedProjectMachine({
          tenantId,
          arrangedPath: workingPath,
          fileName: target.name,
          slicerTargetId,
          retarget
        })
        extraCleanupDirs.push(path.dirname(persistSourcePath))
      }
      const sizeBytes = (await stat(persistSourcePath)).size

      const { file: created } = await persistLibraryFileFromLocalPath({
        tenantId,
        sourcePath: persistSourcePath,
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
        metadata: { fileId: created.id, mode, baseFileId: baseFileId ?? null, importCount: imports.length, retargetedTo: retarget?.printerModel ?? null }
      })
      response.status(201).json({ file: { id: created.id, name: created.name } })
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
