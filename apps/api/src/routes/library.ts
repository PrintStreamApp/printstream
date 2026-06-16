/**
 * Library file CRUD. Stores uploads on disk under `LIBRARY_DIR` and
 * tracks metadata in Prisma. Streams files back on request so the
 * preview plugin (and future viewers) can fetch the raw bytes without
 * loading them into memory.
 */
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, copyFile, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import express, { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import multer from 'multer'
import { z } from 'zod'
import {
  libraryBrowseResponseSchema,
  deleteOperationResponseSchema,
  libraryFileVersionsResponseSchema,
  libraryRecycleBinResponseSchema,
  getPrinterPrintStartOptions,
  isDirectPrintableFileName,
  LIBRARY_DOWNLOAD_PERMISSION,
  LIBRARY_MANAGE_PERMISSION,
  LIBRARY_UPLOAD_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION,
  printerModelSchema,
  printFromLibrarySchema,
  startLibraryDeleteJobSchema,
  type LibraryFile,
  type LibraryFolder,
  type LibraryFileVersion as LibraryFileVersionDto,
  type LibraryThreeMfPreviewAsset as LibraryThreeMfPreviewAssetDto,
  type LibraryThreeMfScene as LibraryThreeMfSceneDto,
  type PrinterStatus,
  type ThreeMfIndex as LibraryThreeMfIndexDto
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import {
  copyBridgeLibraryFile,
  deleteLibraryFileBytes,
  inspectBridgeLibraryThreeMf,
  readBridgeLibraryThumbnail,
  resolveLibraryFileToLocalPath,
  storeBridgeLibraryFile
} from '../lib/bridge-library-files.js'
import { env } from '../lib/env.js'
import { requestHasDemoModeRestrictions } from '../lib/demo-mode.js'
import { prisma } from '../lib/prisma.js'
import { isUniqueConstraintError } from '../lib/prisma-errors.js'
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/http-error.js'
import { assertLibraryPrintCompatibilityForIndex } from '../lib/print-filament-compatibility.js'
import { printerManager } from '../lib/printer-manager.js'
import {
  buildProjectFilePrintCommand,
  getPrintSourceKind,
  getRemotePrintTarget,
  normalizePrintStartOptionsForPrinter,
  printDispatcher
} from '../lib/print-dispatcher.js'
import { readEntry, readPlateIndex, readPreviewAssets, readSceneManifest, type ThreeMfIndex as ParsedThreeMfIndex } from '../lib/three-mf.js'
import { meshToBinaryStl, tessellateStepMesh } from '../lib/mesh-import.js'
import { libraryDir } from '../lib/library-paths.js'
import { deleteLibraryFolderTree, ensureLibraryFolderPath, persistLibraryFileFromLocalPath } from '../lib/library-files.js'
import { resolveRequestActorAttribution } from '../lib/actor-attribution.js'
import { visibleLibraryFilesWhere } from '../lib/library-visibility.js'

function resolvePrinterFirstLayerInspectionDefault(
  model: LibraryFile['compatiblePrinterModels'][number],
  printerStatus: PrinterStatus | undefined
): boolean {
  const options = getPrinterPrintStartOptions(
    model,
    printerStatus
      ? {
          printOptions: printerStatus.printOptions,
          printStartOptions: printerStatus.printStartOptions
        }
      : null
  )
  if (!options.firstLayerInspection.supported) return false
  return options.firstLayerInspection.current ?? true
}
import { printGuards } from '../lib/print-guards.js'
import { bridgeSessionManager } from '../lib/bridge-session-manager.js'
import { broadcastLibraryChanged, broadcastPrintDispatchChanged } from '../lib/ws-resource-events.js'
import { enqueueLibraryPrint, enqueueLibraryPrintSource } from '../lib/library-printing.js'
import { deleteOperationDispatcher } from '../lib/delete-operation-dispatcher.js'
import { startTrackedPrintJob } from '../lib/print-job-recorder.js'
import { requireRequestPermission } from '../lib/authorization.js'
import {
  parsePlateIndexQuery,
  requestAbortSignal,
  requireRequestTenantId,
  requireRouteParam,
  singleUploadWithLimit
} from '../lib/request-helpers.js'

await mkdir(libraryDir, { recursive: true })
const libraryUploadSessionDir = path.join(libraryDir, '.uploads')
await mkdir(libraryUploadSessionDir, { recursive: true })

/**
 * Cap on individual library uploads. Sliced 3MFs from Bambu Studio for
 * dense multi-material prints can comfortably exceed 256 MB once the
 * embedded G-code is stored, so the default is 1 GB. Override with
 * `LIBRARY_MAX_UPLOAD_BYTES` if you really want to cap it lower.
 */
const MAX_UPLOAD_BYTES = (() => {
  return env.LIBRARY_MAX_UPLOAD_BYTES
})()
const CHUNK_UPLOAD_BYTES = 16 * 1024 * 1024
const DEMO_LIBRARY_UPLOAD_MAX_BYTES = 15 * 1024 * 1024
const DEMO_LIBRARY_UPLOAD_MESSAGE = 'In the public demo, uploads must be temporary files no larger than 15 MB.'
const DEMO_LIBRARY_MUTATION_MESSAGE = 'Curated demo library files are read-only in the public demo.'

const chunkUploadInitSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().min(1),
  folderId: z.string().nullable().optional(),
  bridgeId: z.string().nullable().optional(),
  hidden: z.boolean().optional(),
  /**
   * Folder chain (relative to `folderId`) the file should land in, for
   * folder-structure uploads. Missing folders are created at completion, so
   * uploading a picked/dropped directory replicates its tree in the library.
   */
  relativeFolderPath: z.array(z.string().trim().min(1).max(120)).max(32).optional()
})

interface LibraryUploadSession {
  id: string
  fileName: string
  sizeBytes: number
  receivedBytes: number
  phase: 'receiving' | 'transferring' | 'finalizing'
  bridgeReceivedBytes: number
  tenantId: string
  folderId: string | null
  bridgeId: string | null
  hidden: boolean
  /** Folder chain below `folderId` to create/resolve at completion (folder-structure uploads). */
  relativeFolderPath?: string[] | null
  createdAt: string
}

type LibraryUploadSessionResponse = Pick<LibraryUploadSession,
  'id' | 'fileName' | 'sizeBytes' | 'receivedBytes' | 'phase' | 'bridgeReceivedBytes'
>

type LibraryFileRow = {
  id: string
  tenantId: string
  name: string
  ownerBridgeId?: string | null
  sizeBytes: number
  uploadedAt: Date
  kind: string
  storedPath: string
  thumbnailPath: string | null
  folderId: string | null
  hidden: boolean
  currentVersionNumber: number
  snapshotKey: string | null
  deletedAt?: Date | null
  createdById?: string | null
  createdByName?: string | null
  restoredFromVersionNumber?: number | null
}

type LibraryFileVersionRow = {
  id: string
  libraryFileId: string
  tenantId: string
  name: string
  ownerBridgeId?: string | null
  sizeBytes: number
  uploadedAt: Date
  kind: string
  storedPath: string
  thumbnailPath: string | null
  folderId: string | null
  versionNumber: number
  createdById?: string | null
  createdByName?: string | null
  restoredFromVersionNumber?: number | null
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, libraryDir),
    filename: (_request, file, callback) => {
      const safe = file.originalname.replace(/[^\w.-]+/g, '_')
      callback(null, `${Date.now()}-${safe}`)
    }
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES }
})

/**
 * Wraps `upload.single('file')` so multer errors (most importantly the
 * `LIMIT_FILE_SIZE` overflow) surface as proper HTTP 4xx responses with
 * a readable message instead of a generic 500.
 */
function uploadSingle(field: string) {
  return singleUploadWithLimit({
    upload,
    field,
    maxBytes: MAX_UPLOAD_BYTES,
    onLimitExceeded: (maxBytes) =>
      new HttpError(413, `File exceeds ${Math.round(maxBytes / (1024 * 1024))} MB upload limit`),
    onMulterError: (error) => new HttpError(400, error.message)
  })
}

function uploadChunkBody(request: Request, response: Response, next: NextFunction): void {
  express.raw({ type: 'application/octet-stream', limit: CHUNK_UPLOAD_BYTES })(request, response, (error: unknown) => {
    if (isPayloadTooLargeError(error)) {
      const limitMb = Math.round(CHUNK_UPLOAD_BYTES / (1024 * 1024))
      next(new HttpError(413, `Chunk exceeds ${limitMb} MB upload chunk limit`))
      return
    }
    next(error)
  })
}

function isPayloadTooLargeError(error: unknown): boolean {
  return typeof error === 'object'
    && error != null
    && 'type' in error
    && (error as { type?: unknown }).type === 'entity.too.large'
}

function sessionPaths(uploadId: string): { dataPath: string; metaPath: string } {
  const safeId = uploadId.replace(/[^a-zA-Z0-9-]/g, '')
  return {
    dataPath: path.join(libraryUploadSessionDir, `${safeId}.part`),
    metaPath: path.join(libraryUploadSessionDir, `${safeId}.json`)
  }
}

async function readUploadSession(uploadId: string): Promise<LibraryUploadSession | null> {
  try {
    const { metaPath } = sessionPaths(uploadId)
    return JSON.parse(await readFile(metaPath, 'utf8')) as LibraryUploadSession
  } catch {
    return null
  }
}

async function writeUploadSession(session: LibraryUploadSession): Promise<void> {
  const { metaPath } = sessionPaths(session.id)
  await writeFile(metaPath, JSON.stringify(session), 'utf8')
}

async function deleteUploadSession(uploadId: string): Promise<void> {
  const { dataPath, metaPath } = sessionPaths(uploadId)
  await Promise.all([
    rm(dataPath, { force: true }).catch(() => undefined),
    rm(metaPath, { force: true }).catch(() => undefined)
  ])
}

function toUploadSessionResponse(session: LibraryUploadSession): LibraryUploadSessionResponse {
  return {
    id: session.id,
    fileName: session.fileName,
    sizeBytes: session.sizeBytes,
    receivedBytes: session.receivedBytes,
    phase: session.phase,
    bridgeReceivedBytes: session.bridgeReceivedBytes
  }
}

async function createLibraryFileFromUpload(input: {
  request: Request
  sourcePath: string
  fileName: string
  sizeBytes: number
  folderId: string | null
  bridgeId: string | null
  hidden: boolean
  onBridgeProgress?: (transferredBytes: number) => Promise<void> | void
  onBridgeComplete?: () => Promise<void> | void
}) {
  const tenantId = requireRequestTenantId(input.request)
  return await persistLibraryFileFromLocalPath({
    tenantId,
    sourcePath: input.sourcePath,
    fileName: input.fileName,
    sizeBytes: input.sizeBytes,
    folderId: input.folderId,
    bridgeId: input.bridgeId,
    hidden: input.hidden,
    request: input.request,
    auditAction: 'upload',
    missingBridgeMessage: 'Select a bridge before uploading to the library',
    onBridgeProgress: input.onBridgeProgress,
    onBridgeComplete: input.onBridgeComplete
  })
}

export const libraryRouter = Router()

libraryRouter.get('/', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const folderId = parseFolderQuery(request.query.folderId)
  const tenantId = request.tenant?.id ?? null
  // Hidden files (transient one-off prints) are intentionally excluded
  // from the library UI. They’re still reachable by id for re-dispatch.
  const where: Record<string, unknown> = visibleLibraryFilesWhere({ ownerBridgeId: { not: null } })
  if (tenantId) where.tenantId = tenantId
  if (folderId !== undefined) where.folderId = folderId
  const rows = await prisma.libraryFile.findMany({
    where,
    orderBy: { uploadedAt: 'desc' }
  })
  response.json({ files: await Promise.all(rows.map((row) => toDto(row))) })
})

/**
 * Bridge-aware library browse contract.
 *
 * This starts as a non-breaking flat view that mirrors the current
 * library root/subfolder behavior. Later phases can switch `mode`
 * and populate synthetic bridge entries without changing callers.
 */
libraryRouter.get('/browse', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const folderId = parseFolderQuery(request.query.folderId) ?? null
  const bridgeId = parseBridgeQuery(request.query.bridgeId)
  const tenantId = request.tenant?.id ?? null
  const bridges = (await prisma.bridge.findMany({
    where: tenantId ? { tenantId } : undefined,
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true }
  })).map((bridge) => ({
    ...bridge,
    connected: bridgeSessionManager.isConnected(bridge.id)
  }))

  const requestedFolder = folderId
    ? await prisma.libraryFolder.findFirst({
        where: {
          id: folderId,
          ...(tenantId ? { tenantId } : {})
        },
        select: { ownerBridgeId: true }
      })
    : null

  if (folderId && !requestedFolder?.ownerBridgeId) {
    throw notFound('Folder not found')
  }

  if (bridgeId == null && folderId == null && bridges.length !== 1) {
    response.json(libraryBrowseResponseSchema.parse({
      mode: 'bridge-root',
      readOnly: true,
      activeBridgeId: null,
      bridgeEntries: bridges,
      folders: [],
      files: []
    }))
    return
  }

  const activeBridgeId = bridgeId ?? requestedFolder?.ownerBridgeId ?? bridges[0]?.id ?? null
  if (!activeBridgeId) throw notFound('Bridge not found')

  const activeBridge = bridges.find((bridge) => bridge.id === activeBridgeId)
  if (!activeBridge) throw notFound('Bridge not found')

  const [fileRows, folderRows] = await Promise.all([
    prisma.libraryFile.findMany({
      where: visibleLibraryFilesWhere({
        folderId,
        ownerBridgeId: activeBridgeId,
        ...(tenantId ? { tenantId } : {})
      }),
      orderBy: { uploadedAt: 'desc' }
    }),
    prisma.libraryFolder.findMany({
      where: {
        parentId: folderId,
        ownerBridgeId: activeBridgeId,
        ...(tenantId ? { tenantId } : {})
      },
      orderBy: { name: 'asc' }
    })
  ])

  response.json(libraryBrowseResponseSchema.parse({
    mode: 'bridge-subtree',
    readOnly: false,
    activeBridgeId,
    bridgeEntries: bridges,
    folders: folderRows.map(toFolderDto),
    files: await Promise.all(fileRows.map((row) => toDto(row)))
  }))
})

/** List all folders. The web client builds the tree client-side from `parentId`. */
libraryRouter.get('/folders', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const bridgeId = parseBridgeQuery(request.query.bridgeId)
  const tenantId = request.tenant?.id ?? null
  const where: Record<string, unknown> = bridgeId ? { ownerBridgeId: bridgeId } : { ownerBridgeId: { not: null } }
  if (tenantId) where.tenantId = tenantId
  const rows = await prisma.libraryFolder.findMany({
    where,
    orderBy: { name: 'asc' }
  })
  response.json({ folders: rows.map(toFolderDto) })
})

const createFolderSchema = z.object({
  name: z.string().trim().min(1).max(120),
  bridgeId: z.string().trim().min(1).optional(),
  parentId: z.string().nullable().optional()
})

libraryRouter.post('/folders', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
  const parsed = createFolderSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid folder payload')
  const tenantId = requireRequestTenantId(request)
  const parentId = parsed.data.parentId ?? null
  let ownerBridgeId: string | null = parsed.data.bridgeId ?? null
  if (parentId) {
    const parent = await prisma.libraryFolder.findUnique({ where: { id: parentId } })
    if (!parent?.ownerBridgeId) throw notFound('Parent folder not found')
    ownerBridgeId = parent.ownerBridgeId
  }
  if (!ownerBridgeId) throw badRequest('Select a bridge before creating a folder')
  try {
    const created = await prisma.libraryFolder.create({
      data: { tenantId, ownerBridgeId, name: parsed.data.name, parentId }
    })
    annotateRequestAuditLog(request, {
      action: 'create-folder',
      resource: 'library folder',
      summary: `Created library folder ${created.name}.`,
      metadata: {
        folderId: created.id,
        folderName: created.name,
        parentId: created.parentId
      }
    })
    broadcastLibraryChanged()
    response.status(201).json({ folder: toFolderDto(created) })
  } catch (error) {
    if (isUniqueConstraintError(error)) throw conflict('A folder with that name already exists here')
    throw error
  }
})

const updateFolderSchema = z
  .object({
    bridgeId: z.string().trim().min(1).nullable().optional(),
    name: z.string().trim().min(1).max(120).optional(),
    parentId: z.string().nullable().optional()
  })
  .refine((data) => data.name !== undefined || data.parentId !== undefined || data.bridgeId !== undefined, {
    message: 'Provide name, parentId, or bridgeId'
  })

/** Rename and/or move a folder. Moving into a descendant is rejected. */
libraryRouter.patch('/folders/:id', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
  const folderId = requireRouteParam(request.params.id, 'Folder id')
  const parsed = updateFolderSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid folder payload')
  const folder = await prisma.libraryFolder.findUnique({ where: { id: folderId } })
  if (!folder?.ownerBridgeId) throw notFound('Folder not found')

  const data: { name?: string; parentId?: string | null; ownerBridgeId?: string | null } = {}
  if (parsed.data.name !== undefined) data.name = parsed.data.name
  if (parsed.data.parentId !== undefined) {
    const newParentId = parsed.data.parentId
    if (newParentId === folder.id) throw badRequest('A folder cannot be its own parent')
    if (newParentId) {
      const parent = await prisma.libraryFolder.findUnique({ where: { id: newParentId } })
      if (!parent?.ownerBridgeId) throw notFound('Parent folder not found')
      if (parent.ownerBridgeId !== folder.ownerBridgeId) {
        throw badRequest('Folders cannot be moved across bridge roots')
      }
      if (await isDescendant(newParentId, folder.id)) {
        throw badRequest('Cannot move a folder into one of its descendants')
      }
    }
    data.parentId = newParentId
  }
  if (parsed.data.bridgeId !== undefined) {
    const nextBridgeId = parsed.data.bridgeId ?? null
    if (!nextBridgeId) throw badRequest('Select a bridge before moving a folder')
    if (nextBridgeId !== folder.ownerBridgeId) {
      throw badRequest('Folders cannot be moved across bridge roots')
    }
    data.ownerBridgeId = nextBridgeId
  }

  try {
    const updated = await prisma.libraryFolder.update({ where: { id: folder.id }, data })
    const renamed = parsed.data.name !== undefined && updated.name !== folder.name
    const moved = parsed.data.parentId !== undefined
    annotateRequestAuditLog(request, {
      action: renamed && moved ? 'move-rename-folder' : moved ? 'move-folder' : 'rename-folder',
      resource: 'library folder',
      summary: renamed && moved
        ? `Renamed and moved library folder ${folder.name}.`
        : moved
          ? `Moved library folder ${updated.name}.`
          : `Renamed library folder ${folder.name} to ${updated.name}.`,
      metadata: {
        folderId: folder.id,
        previousName: folder.name,
        folderName: updated.name,
        previousParentId: folder.parentId,
        parentId: updated.parentId
      }
    })
    broadcastLibraryChanged()
    response.json({ folder: toFolderDto(updated) })
  } catch (error) {
    if (isUniqueConstraintError(error)) throw conflict('A folder with that name already exists here')
    throw error
  }
})

/**
 * Delete a folder. Refuses when it has contents unless `?recursive=true`, in
 * which case the whole subtree — descendant folders, files, and version
 * history — is removed (the client confirms with the user first).
 */
libraryRouter.delete('/folders/:id', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
  const folderId = requireRouteParam(request.params.id, 'Folder id')
  const recursive = request.query.recursive === 'true'
  const folder = await prisma.libraryFolder.findUnique({
    where: { id: folderId },
    include: { _count: { select: { files: true, children: true } } }
  })
  if (!folder) throw notFound('Folder not found')
  if (!recursive && (folder._count.files > 0 || folder._count.children > 0)) {
    throw conflict('Folder is not empty')
  }
  const { deletedFiles } = await deleteLibraryFolderTree(folder.id, {
    assertFileDeletable: (row) => assertDemoLibraryFileMutationAllowed(request, row)
  })
  annotateRequestAuditLog(request, {
    action: 'delete',
    resource: 'library folder',
    summary: deletedFiles > 0
      ? `Deleted library folder ${folder.name} and moved ${deletedFiles} file${deletedFiles === 1 ? '' : 's'} inside it to the recycle bin.`
      : `Deleted library folder ${folder.name}.`,
    metadata: { folderId: folder.id, folderName: folder.name, recursive, deletedFiles }
  })
  response.status(204).end()
})

// ---- Recycle bin ------------------------------------------------------------
// Soft-deleted files keep their bytes + version history and stay restorable
// until restored, individually hard-deleted, or aged out by the cleanup task
// (LIBRARY_RECYCLE_RETENTION_DAYS). These routes must register before the
// `/:id` param routes so `/recycle-bin` is not swallowed as a file id.

const recycleFilesSchema = z.object({ fileIds: z.array(z.string().min(1)).min(1).max(500) })

/** List the recycle bin, newest deletions first. */
libraryRouter.get('/recycle-bin', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
  const tenantId = request.tenant?.id ?? null
  const rows = await prisma.libraryFile.findMany({
    where: { deletedAt: { not: null }, hidden: false, ...(tenantId ? { tenantId } : {}) },
    orderBy: { deletedAt: 'desc' }
  }) as Array<LibraryFileRow & { deletedAt: Date }>
  response.json(libraryRecycleBinResponseSchema.parse({
    files: await Promise.all(rows.map(async (row) => ({
      ...(await toDto(row)),
      deletedAt: row.deletedAt.toISOString()
    })))
  }))
})

/** Move files to the recycle bin (soft delete). */
libraryRouter.post('/recycle-bin/files', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
  const parsed = recycleFilesSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid recycle payload')
  const tenantId = requireRequestTenantId(request)
  const rows = await prisma.libraryFile.findMany({
    where: { id: { in: parsed.data.fileIds }, tenantId },
    select: { id: true, name: true, hidden: true, deletedAt: true }
  })
  if (rows.length !== parsed.data.fileIds.length) throw notFound('One or more files were not found')
  for (const row of rows) assertDemoLibraryFileMutationAllowed(request, row)
  const targetIds = rows.filter((row) => !row.hidden && !row.deletedAt).map((row) => row.id)
  if (targetIds.length > 0) {
    await prisma.libraryFile.updateMany({ where: { id: { in: targetIds } }, data: { deletedAt: new Date() } })
  }
  annotateRequestAuditLog(request, {
    action: 'recycle',
    resource: 'library file',
    summary: targetIds.length === 1
      ? `Moved library file ${rows[0]?.name ?? ''} to the recycle bin.`
      : `Moved ${targetIds.length} library files to the recycle bin.`,
    metadata: { fileIds: targetIds }
  })
  broadcastLibraryChanged()
  response.json({ recycled: targetIds.length })
})

/** Restore recycled files back into the library (their folder if it still exists, else the root). */
libraryRouter.post('/recycle-bin/restore', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
  const parsed = recycleFilesSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid restore payload')
  const tenantId = requireRequestTenantId(request)
  const rows = await prisma.libraryFile.findMany({
    where: { id: { in: parsed.data.fileIds }, tenantId, deletedAt: { not: null } },
    select: { id: true, name: true }
  })
  if (rows.length === 0) throw notFound('No recycled files to restore')
  await prisma.libraryFile.updateMany({
    where: { id: { in: rows.map((row) => row.id) } },
    data: { deletedAt: null }
  })
  annotateRequestAuditLog(request, {
    action: 'restore',
    resource: 'library file',
    summary: rows.length === 1
      ? `Restored library file ${rows[0]?.name ?? ''} from the recycle bin.`
      : `Restored ${rows.length} library files from the recycle bin.`,
    metadata: { fileIds: rows.map((row) => row.id) }
  })
  broadcastLibraryChanged()
  response.json({ restored: rows.length })
})

/** Permanently delete everything in the recycle bin via a queued delete job. */
libraryRouter.delete('/recycle-bin', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
  const tenantId = requireRequestTenantId(request)
  const rows = await prisma.libraryFile.findMany({
    where: { tenantId, deletedAt: { not: null } },
    select: { id: true, name: true, hidden: true }
  })
  if (rows.length === 0) throw conflict('The recycle bin is already empty')
  for (const row of rows) assertDemoLibraryFileMutationAllowed(request, row)
  const job = await deleteOperationDispatcher.enqueueLibraryDelete(rows.map((row) => row.id))
  annotateRequestAuditLog(request, {
    action: 'delete',
    resource: 'library file',
    summary: `Emptied the recycle bin (${rows.length} file${rows.length === 1 ? '' : 's'}).`,
    metadata: { deleteOperationId: job.id, fileIds: rows.map((row) => row.id), itemCount: rows.length }
  })
  response.status(202).json(deleteOperationResponseSchema.parse({ job }))
})

libraryRouter.post(
  '/',
  requireRequestPermission(LIBRARY_UPLOAD_PERMISSION),
  uploadSingle('file'),
  async (request, response) => {
  if (!request.file) {
    response.status(400).json({ error: 'No file uploaded' })
    return
  }
  const folderId = parseFolderField(request.body?.folderId)
  const bridgeId = parseFolderField(request.body?.bridgeId)
  // "Print from local file" uploads pass `hidden=true` so the file is
  // stored on disk (and remains re-printable by id) but stays out of the
  // library listing. The cleanup task in `library-cleanup.ts` prunes
  // these after their retention window.
  const hidden = resolveLibraryUploadHidden(request, parseBooleanField(request.body?.hidden), request.file.size)
  try {
    const { file: created, unchanged } = await createLibraryFileFromUpload({
      request,
      sourcePath: request.file.path,
      fileName: request.file.originalname,
      sizeBytes: request.file.size,
      folderId,
      bridgeId,
      hidden
    })
    response.status(201).json({ file: await toDto(created), unchanged })
  } finally {
    await unlink(request.file.path).catch(() => undefined)
  }
})

libraryRouter.post('/uploads', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), async (request, response) => {
  const parsed = chunkUploadInitSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid upload payload')
  if (parsed.data.sizeBytes > MAX_UPLOAD_BYTES) {
    const limitMb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))
    throw new HttpError(413, `File exceeds ${limitMb} MB upload limit`)
  }
  const hidden = resolveLibraryUploadHidden(request, parsed.data.hidden ?? false, parsed.data.sizeBytes)
  const tenantId = requireRequestTenantId(request)
  const uploadId = randomUUID()
  const session: LibraryUploadSession = {
    id: uploadId,
    fileName: parsed.data.fileName,
    sizeBytes: parsed.data.sizeBytes,
    receivedBytes: 0,
    phase: 'receiving',
    bridgeReceivedBytes: 0,
    tenantId,
    folderId: parsed.data.folderId ?? null,
    bridgeId: parsed.data.bridgeId ?? null,
    hidden,
    relativeFolderPath: parsed.data.relativeFolderPath ?? null,
    createdAt: new Date().toISOString()
  }
  await writeUploadSession(session)
  response.status(201).json({ uploadId, chunkSizeBytes: CHUNK_UPLOAD_BYTES, uploadedBytes: 0 })
})

libraryRouter.get('/uploads/:uploadId', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), async (request, response) => {
  const uploadId = requireRouteParam(request.params.uploadId, 'Upload id')
  const session = await readUploadSession(uploadId)
  if (!session) throw notFound('Upload session not found')
  const tenantId = requireRequestTenantId(request)
  if (session.tenantId !== tenantId) throw notFound('Upload session not found')
  response.json({ upload: toUploadSessionResponse(session) })
})

libraryRouter.post(
  '/uploads/:uploadId/chunks',
  requireRequestPermission(LIBRARY_UPLOAD_PERMISSION),
  uploadChunkBody,
  async (request, response) => {
    const uploadId = requireRouteParam(request.params.uploadId, 'Upload id')
    const session = await readUploadSession(uploadId)
    if (!session) throw notFound('Upload session not found')
    const tenantId = requireRequestTenantId(request)
    if (session.tenantId !== tenantId) throw notFound('Upload session not found')
    const chunk = Buffer.isBuffer(request.body) ? request.body : null
    if (!chunk || chunk.byteLength === 0) throw badRequest('Upload chunk is empty')
    if (chunk.byteLength > CHUNK_UPLOAD_BYTES) throw badRequest('Upload chunk is too large')
    const offsetHeader = request.header('X-Upload-Offset')
    const offset = offsetHeader == null ? session.receivedBytes : Number(offsetHeader)
    if (!Number.isSafeInteger(offset) || offset !== session.receivedBytes) {
      throw conflict(`Upload offset mismatch. Resume at byte ${session.receivedBytes}.`)
    }
    if (session.receivedBytes + chunk.byteLength > session.sizeBytes) {
      throw badRequest('Upload chunk exceeds declared file size')
    }
    const { dataPath } = sessionPaths(uploadId)
    await appendFile(dataPath, chunk)
    session.receivedBytes += chunk.byteLength
    await writeUploadSession(session)
    response.json({ uploadedBytes: session.receivedBytes, complete: session.receivedBytes === session.sizeBytes })
  }
)

libraryRouter.delete('/uploads/:uploadId', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), async (request, response) => {
  const uploadId = requireRouteParam(request.params.uploadId, 'Upload id')
  const session = await readUploadSession(uploadId)
  if (session) {
    const tenantId = requireRequestTenantId(request)
    if (session.tenantId !== tenantId) throw notFound('Upload session not found')
  }
  await deleteUploadSession(uploadId)
  response.status(204).end()
})

libraryRouter.post('/uploads/:uploadId/complete', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), async (request, response) => {
  const uploadId = requireRouteParam(request.params.uploadId, 'Upload id')
  const session = await readUploadSession(uploadId)
  if (!session) throw notFound('Upload session not found')
  const tenantId = requireRequestTenantId(request)
  if (session.tenantId !== tenantId) throw notFound('Upload session not found')
  if (session.receivedBytes !== session.sizeBytes) {
    throw badRequest(`Upload is incomplete. Resume at byte ${session.receivedBytes}.`)
  }
  const { dataPath } = sessionPaths(uploadId)
  try {
    session.phase = 'transferring'
    session.bridgeReceivedBytes = 0
    await writeUploadSession(session)
    // Folder-structure uploads: materialize the file's folder chain now (hidden
    // uploads never join a folder, so skip the tree there).
    const folderId = !session.hidden && session.relativeFolderPath?.length
      ? await ensureLibraryFolderPath({
        tenantId,
        bridgeId: session.bridgeId,
        baseFolderId: session.folderId,
        segments: session.relativeFolderPath
      })
      : session.folderId
    const created = await createLibraryFileFromUpload({
      request,
      sourcePath: dataPath,
      fileName: session.fileName,
      sizeBytes: session.sizeBytes,
      folderId,
      bridgeId: session.bridgeId,
      hidden: session.hidden,
      onBridgeProgress: async (transferredBytes) => {
        session.bridgeReceivedBytes = transferredBytes
        await writeUploadSession(session)
      },
      onBridgeComplete: async () => {
        session.phase = 'finalizing'
        session.bridgeReceivedBytes = session.sizeBytes
        await writeUploadSession(session)
      }
    })
    response.status(201).json({ file: await toDto(created.file), unchanged: created.unchanged })
  } finally {
    await deleteUploadSession(uploadId)
  }
})

libraryRouter.get('/:id/versions', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const fileId = requireRouteParam(request.params.id, 'File id')
  const row = await prisma.libraryFile.findUnique({ where: { id: fileId } }) as LibraryFileRow | null
  if (!row) throw notFound('File not found')
  const historyRows = await prisma.libraryFileVersion.findMany({
    where: { libraryFileId: row.id },
    orderBy: { versionNumber: 'desc' }
  }) as LibraryFileVersionRow[]
  response.json(libraryFileVersionsResponseSchema.parse({
    currentFileId: row.id,
    versions: [
      await toVersionDto(row),
      ...await Promise.all(historyRows.map((version) => toVersionDto(version)))
    ]
  }))
})

libraryRouter.post('/versions/:versionId/restore', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
  const versionId = requireRouteParam(request.params.versionId, 'Version id')
  const version = await prisma.libraryFileVersion.findUnique({ where: { id: versionId } }) as LibraryFileVersionRow | null
  if (!version) throw notFound('Version not found')
  const current = await prisma.libraryFile.findUnique({ where: { id: version.libraryFileId } }) as LibraryFileRow | null
  if (!current?.ownerBridgeId) throw notFound('File not found')
  assertDemoLibraryFileMutationAllowed(request, current)

  const storedPath = buildLibraryStoredPath(current.name)
  await copyLibraryEntryBytes(version, {
    ownerBridgeId: current.ownerBridgeId,
    storedPath
  })

  const attribution = await resolveRequestActorAttribution(request)
  let restored
  try {
    restored = await prisma.$transaction(async (tx) => {
      await tx.libraryFileVersion.create({
        data: toLibraryFileVersionCreateInput(current)
      })
      return await tx.libraryFile.update({
        where: { id: current.id },
        data: {
          storedPath,
          sizeBytes: version.sizeBytes,
          kind: version.kind,
          thumbnailPath: version.thumbnailPath,
          uploadedAt: new Date(),
          currentVersionNumber: current.currentVersionNumber + 1,
          snapshotKey: null,
          // Provenance: the new current content is a copy of an archived
          // version, attributed to whoever performed the restore.
          restoredFromVersionNumber: version.versionNumber,
          createdById: attribution.createdById,
          createdByName: attribution.createdByName
        }
      })
    })
  } catch (error) {
    await deleteLibraryFileBytes({ ownerBridgeId: current.ownerBridgeId, storedPath }).catch(() => undefined)
    throw error
  }

  annotateRequestAuditLog(request, {
    action: 'restore-version',
    resource: 'library file',
    summary: `Restored library file ${current.name} from version ${version.versionNumber}.`,
    metadata: {
      fileId: current.id,
      fileName: current.name,
      versionId: version.id,
      restoredVersionNumber: version.versionNumber
    }
  })
  broadcastLibraryChanged()
  response.json({ file: await toDto(restored) })
})

libraryRouter.delete('/versions/:versionId', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
  const versionId = requireRouteParam(request.params.versionId, 'Version id')
  const version = await prisma.libraryFileVersion.findUnique({ where: { id: versionId } }) as LibraryFileVersionRow | null
  if (!version) throw notFound('Version not found')
  const current = await prisma.libraryFile.findUnique({ where: { id: version.libraryFileId } }) as LibraryFileRow | null
  if (!current) throw notFound('File not found')
  assertDemoLibraryFileMutationAllowed(request, current)

  await prisma.libraryFileVersion.delete({ where: { id: version.id } })

  // Each archived version keeps its own copy of the bytes, but guard against deleting bytes
  // still referenced by the current file or another version before removing them from storage.
  if (version.ownerBridgeId) {
    const sharedByCurrent = current.storedPath === version.storedPath && (current.ownerBridgeId ?? null) === version.ownerBridgeId
    const sharedByOtherVersion = await prisma.libraryFileVersion.count({
      where: { ownerBridgeId: version.ownerBridgeId, storedPath: version.storedPath }
    })
    if (!sharedByCurrent && sharedByOtherVersion === 0) {
      // The version row is already gone; a byte-cleanup failure only leaks storage, so don't fail
      // the request — but log it so the orphan is traceable.
      await deleteLibraryFileBytes({ ownerBridgeId: version.ownerBridgeId, storedPath: version.storedPath })
        .catch((error) => console.warn(`[library] failed to delete bytes for removed version ${version.id}: ${(error as Error).message}`))
    }
  }

  annotateRequestAuditLog(request, {
    action: 'delete-version',
    resource: 'library file',
    summary: `Deleted version ${version.versionNumber} of ${current.name}.`,
    metadata: { fileId: current.id, fileName: current.name, versionId: version.id, versionNumber: version.versionNumber }
  })
  broadcastLibraryChanged()
  response.status(204).end()
})

libraryRouter.get('/versions/:versionId/download', requireRequestPermission(LIBRARY_DOWNLOAD_PERMISSION), async (request, response) => {
  const versionId = requireRouteParam(request.params.versionId, 'Version id')
  const row = await prisma.libraryFileVersion.findUnique({ where: { id: versionId } }) as LibraryFileVersionRow | null
  if (!row) throw notFound('Version not found')
  annotateRequestAuditLog(request, {
    action: 'download-version',
    resource: 'library file',
    summary: `Downloaded version ${row.versionNumber} of ${row.name}.`,
    metadata: {
      versionId: row.id,
      fileId: row.libraryFileId,
      fileName: row.name,
      sizeBytes: row.sizeBytes
    }
  })
  return await sendLibraryFileDownload(response, row)
})

libraryRouter.get('/versions/:versionId/plates', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const versionId = requireRouteParam(request.params.versionId, 'Version id')
  const row = await prisma.libraryFileVersion.findUnique({ where: { id: versionId } }) as LibraryFileVersionRow | null
  if (!row) throw notFound('Version not found')
  await sendLibraryFilePlates(request, response, row)
})

libraryRouter.get('/versions/:versionId/thumbnail', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const versionId = requireRouteParam(request.params.versionId, 'Version id')
  const row = await prisma.libraryFileVersion.findUnique({ where: { id: versionId } }) as LibraryFileVersionRow | null
  if (!row) throw notFound('Version not found')
  await sendLibraryFileThumbnail(request, response, row)
})

libraryRouter.post('/versions/:versionId/print', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
  const versionId = requireRouteParam(request.params.versionId, 'Version id')
  const parsed = printFromLibrarySchema.omit({ fileId: true }).safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid print payload')
  }
  const version = await prisma.libraryFileVersion.findUnique({ where: { id: versionId } }) as LibraryFileVersionRow | null
  if (!version) throw notFound('Version not found')
  const job = await enqueueLibraryPrintSource({
    fileId: version.libraryFileId,
    ...parsed.data
  }, {
    fileId: version.libraryFileId,
    id: version.id,
    tenantId: version.tenantId,
    name: version.name,
    ownerBridgeId: version.ownerBridgeId,
    storedPath: version.storedPath,
    sizeBytes: version.sizeBytes,
    kind: version.kind,
    snapshotKey: null
  })
  annotateRequestAuditLog(request, {
    action: 'start-print-version',
    resource: 'print job',
    summary: `Queued print ${job.jobName} from version ${version.versionNumber} on ${job.printerName}.`,
    metadata: {
      jobId: job.id,
      printerId: job.printerId,
      printerName: job.printerName,
      fileId: version.libraryFileId,
      versionId: version.id,
      versionNumber: version.versionNumber,
      fileName: version.name,
      plate: job.plate
    }
  })
  broadcastPrintDispatchChanged(version.tenantId)
  response.status(202).json({ job })
})

/** Plate-specific mesh scene metadata for previewing an archived version. */
libraryRouter.get('/versions/:versionId/scene', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const versionId = requireRouteParam(request.params.versionId, 'Version id')
  const row = await prisma.libraryFileVersion.findUnique({ where: { id: versionId } }) as LibraryFileVersionRow | null
  if (!row) throw notFound('Version not found')
  await sendLibraryFileScene(request, response, row)
})

/** Raw internal 3MF model entry bytes for the archived-version previewer. */
libraryRouter.get('/versions/:versionId/scene-entry', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const versionId = requireRouteParam(request.params.versionId, 'Version id')
  const row = await prisma.libraryFileVersion.findUnique({ where: { id: versionId } }) as LibraryFileVersionRow | null
  if (!row) throw notFound('Version not found')
  // Sub-model entries (Bambu part files) OR the root model entry — objects created by
  // the editor (cut halves, split shells, primitives) carry their mesh inline there.
  const entryPath = z.string().trim().regex(/^3D\/(?:Objects\/[^/]+\.model|3dmodel\.model)$/i).parse(request.query.path)
  if (sendNotModifiedIfLibraryFileFresh(request, response, row, `scene-entry:${entryPath}`)) return

  let onDisk: string
  try {
    onDisk = await resolveLibraryFilePath(row)
  } catch {
    throw notFound('File missing on disk')
  }

  const signal = requestAbortSignal(request, response)
  try {
    const buffer = await readEntry(onDisk, entryPath, signal, 256 * 1024 * 1024)
    response.setHeader('Content-Type', 'application/xml; charset=utf-8')
    response.send(buffer)
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    throw notFound('Scene model entry missing')
  }
})

/** Selected plate G-code extracted from an archived sliced version. */
libraryRouter.get('/versions/:versionId/plate-gcode', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const versionId = requireRouteParam(request.params.versionId, 'Version id')
  const row = await prisma.libraryFileVersion.findUnique({ where: { id: versionId } }) as LibraryFileVersionRow | null
  if (!row) throw notFound('Version not found')
  await sendLibraryFilePlateGcode(request, response, row)
})

libraryRouter.get('/:id/download', requireRequestPermission(LIBRARY_DOWNLOAD_PERMISSION), async (request, response) => {
  const fileId = requireRouteParam(request.params.id, 'File id')
  const row = await prisma.libraryFile.findUnique({ where: { id: fileId } }) as LibraryFileRow | null
  if (!row) throw notFound('File not found')
  annotateRequestAuditLog(request, {
    action: 'download',
    resource: 'library file',
    summary: `Downloaded library file ${row.name}.`,
    metadata: {
      fileId: row.id,
      fileName: row.name,
      sizeBytes: row.sizeBytes
    }
  })
  await sendLibraryFileDownload(response, row)
})

/** Plate index for a 3MF: list of plates with filament metadata + project filaments. */
libraryRouter.get('/:id/plates', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const fileId = requireRouteParam(request.params.id, 'File id')
  const row = await prisma.libraryFile.findUnique({ where: { id: fileId } }) as LibraryFileRow | null
  if (!row) throw notFound('File not found')
  await sendLibraryFilePlates(request, response, row)
})

/** Selected plate G-code extracted from a 3MF-backed library file. Defaults to plate 1. */
libraryRouter.get('/:id/plate-gcode', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const fileId = requireRouteParam(request.params.id, 'File id')
  const row = await prisma.libraryFile.findUnique({ where: { id: fileId } }) as LibraryFileRow | null
  if (!row) throw notFound('File not found')
  await sendLibraryFilePlateGcode(request, response, row)
})

/** Embedded STL/STEP preview source for a non-G-code 3MF-backed library file. */
libraryRouter.get('/:id/preview-asset', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const fileId = requireRouteParam(request.params.id, 'File id')
  const row = await prisma.libraryFile.findUnique({ where: { id: fileId } }) as LibraryFileRow | null
  if (!row) throw notFound('File not found')
  if (sendNotModifiedIfLibraryFileFresh(request, response, row, 'preview-asset')) return
  const asset = await resolveLibraryFilePreviewAsset(request, response, row)
  if (!asset) return
  response.json(asset satisfies LibraryThreeMfPreviewAssetDto)
})

/** Plate-specific mesh scene metadata for non-G-code 3MF previews. */
libraryRouter.get('/:id/scene', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const fileId = requireRouteParam(request.params.id, 'File id')
  const row = await prisma.libraryFile.findUnique({ where: { id: fileId } }) as LibraryFileRow | null
  if (!row) throw notFound('File not found')
  await sendLibraryFileScene(request, response, row)
})

/** Raw internal 3MF model entry bytes used by the plated mesh previewer. */
libraryRouter.get('/:id/scene-entry', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const fileId = requireRouteParam(request.params.id, 'File id')
  const row = await prisma.libraryFile.findUnique({ where: { id: fileId } }) as LibraryFileRow | null
  if (!row) throw notFound('File not found')
  // Sub-model entries (Bambu part files) OR the root model entry — objects created by
  // the editor (cut halves, split shells, primitives) carry their mesh inline there.
  const entryPath = z.string().trim().regex(/^3D\/(?:Objects\/[^/]+\.model|3dmodel\.model)$/i).parse(request.query.path)
  if (sendNotModifiedIfLibraryFileFresh(request, response, row, `scene-entry:${entryPath}`)) return

  let onDisk: string
  try {
    onDisk = await resolveLibraryFilePath(row)
  } catch {
    throw notFound('File missing on disk')
  }

  const signal = requestAbortSignal(request, response)
  try {
    const buffer = await readEntry(onDisk, entryPath, signal, 256 * 1024 * 1024)
    response.setHeader('Content-Type', 'application/xml; charset=utf-8')
    response.send(buffer)
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    throw notFound('Scene model entry missing')
  }
})

/** Raw bytes for a specific embedded STL/STEP preview source inside a 3MF. */
libraryRouter.get('/:id/preview-asset/content', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const fileId = requireRouteParam(request.params.id, 'File id')
  const row = await prisma.libraryFile.findUnique({ where: { id: fileId } }) as LibraryFileRow | null
  if (!row) throw notFound('File not found')
  const entryPath = z.string().trim().min(1).parse(request.query.entry)
  if (sendNotModifiedIfLibraryFileFresh(request, response, row, `preview-asset-content:${entryPath}`)) return
  const asset = await resolveLibraryFilePreviewAsset(request, response, row)
  if (!asset) return
  if (asset.entryPath !== entryPath) throw notFound('Embedded preview source missing')

  const signal = requestAbortSignal(request, response)
  let onDisk: string
  try {
    onDisk = await resolveLibraryFilePath(row)
  } catch {
    throw notFound('File missing on disk')
  }

  try {
    const buffer = await readEntry(onDisk, asset.entryPath, signal, 256 * 1024 * 1024)
    response.setHeader('Content-Type', asset.kind === 'stl' ? 'model/stl' : 'application/octet-stream')
    response.send(buffer)
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    throw notFound('Embedded preview source missing')
  }
})

/** Thumbnail PNG for a single plate. Defaults to plate 1 when omitted. */
libraryRouter.get('/:id/thumbnail', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const fileId = requireRouteParam(request.params.id, 'File id')
  const row = await prisma.libraryFile.findUnique({ where: { id: fileId } }) as LibraryFileRow | null
  if (!row) throw notFound('File not found')
  await sendLibraryFileThumbnail(request, response, row)
})

/**
 * Binary STL bytes for a library model file, scoped to viewers (not downloaders) and
 * without an audit-log entry, so the web client can render a 3D preview/thumbnail for
 * files that carry no embedded image. STL is shipped verbatim; STEP is tessellated to
 * STL server-side (BambuStudio-matched quality — the bridge ships no 3D renderer and the
 * browser can't read STEP), then shipped for client-side rendering by the model-studio
 * plugin. 3MF/gcode keep using `/thumbnail`.
 */
libraryRouter.get('/:id/mesh', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const fileId = requireRouteParam(request.params.id, 'File id')
  const row = await prisma.libraryFile.findUnique({ where: { id: fileId } }) as LibraryFileRow | null
  if (!row) throw notFound('File not found')
  if (row.kind !== 'stl' && row.kind !== 'step') throw notFound('No mesh available')
  if (sendNotModifiedIfLibraryFileFresh(request, response, row, 'mesh')) return
  const signal = requestAbortSignal(request, response)
  let onDisk: string
  try {
    onDisk = await resolveLibraryFilePath(row)
  } catch {
    throw notFound('File missing on disk')
  }
  try {
    const buffer = await readFile(onDisk)
    if (signal.aborted) return
    // STEP carries no triangle mesh — tessellate it to STL once per cache window (the ETag
    // 304 above short-circuits warm clients before this point). STL ships verbatim.
    const stl = row.kind === 'step' ? meshToBinaryStl(await tessellateStepMesh(buffer)) : buffer
    if (signal.aborted) return
    response.setHeader('Content-Type', 'model/stl')
    response.setHeader('Cache-Control', 'private, max-age=300')
    response.send(stl)
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    // A malformed STEP fails here rather than (like STL) only on a missing file, so surface the
    // cause: the client just sees a 404 and falls back to the kind label. id only, no secrets.
    if (row.kind === 'step') {
      console.warn(`Failed to tessellate STEP library file ${row.id} for preview:`, error instanceof Error ? error.message : error)
    }
    throw notFound('Mesh missing')
  }
})

/** Resolve a single library file's metadata by id. */
libraryRouter.get('/:id', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
  const fileId = requireRouteParam(request.params.id, 'File id')
  const row = await prisma.libraryFile.findUnique({ where: { id: fileId } }) as LibraryFileRow | null
  if (!row) throw notFound('File not found')
  response.json({ file: await toDto(row) })
})

libraryRouter.delete('/:id', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
  const fileId = requireRouteParam(request.params.id, 'File id')
  const row = await prisma.libraryFile.findUnique({
    where: { id: fileId },
    include: {
      versions: {
        select: {
          ownerBridgeId: true,
          storedPath: true
        }
      }
    }
  })
  if (!row?.ownerBridgeId) throw notFound('File not found')
  assertDemoLibraryFileMutationAllowed(request, row)
  annotateRequestAuditLog(request, {
    action: 'delete',
    resource: 'library file',
    summary: `Deleted library file ${row.name}.`,
    metadata: {
      fileId: row.id,
      fileName: row.name
    }
  })
  await prisma.libraryFile.delete({ where: { id: row.id } })
  await deleteLibraryFileBytes(row).catch(() => undefined)
  await Promise.all(row.versions.map(async (version) => {
    await deleteLibraryFileBytes(version).catch(() => undefined)
  }))
  if (!row.hidden) broadcastLibraryChanged()
  response.status(204).end()
})

libraryRouter.post('/delete-jobs', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
  const parsed = startLibraryDeleteJobSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid delete payload')
  const rows = await prisma.libraryFile.findMany({
    where: { id: { in: parsed.data.fileIds } },
    select: { hidden: true }
  })
  for (const row of rows) {
    assertDemoLibraryFileMutationAllowed(request, row)
  }
  const job = await deleteOperationDispatcher.enqueueLibraryDelete(parsed.data.fileIds)
  annotateRequestAuditLog(request, {
    action: 'delete',
    resource: 'library file',
    summary: job.totalItems === 1
      ? `Queued delete of library file ${job.summaryLabel}.`
      : `Queued delete of ${job.totalItems} library files.`,
    metadata: {
      deleteOperationId: job.id,
      fileIds: parsed.data.fileIds,
      itemCount: job.totalItems,
      summaryLabel: job.summaryLabel
    }
  })
  response.status(202).json(deleteOperationResponseSchema.parse({ job }))
})

const updateFileSchema = z
  .object({
    bridgeId: z.string().trim().min(1).nullable().optional(),
    name: z.string().trim().min(1).max(255).optional(),
    folderId: z.string().nullable().optional()
  })
  .refine((data) => data.name !== undefined || data.folderId !== undefined || data.bridgeId !== undefined, {
    message: 'Provide name, folderId, or bridgeId'
  })

/** Rename and/or move a library file between folders. */
libraryRouter.patch('/:id', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
  const fileId = requireRouteParam(request.params.id, 'File id')
  const parsed = updateFileSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid file payload')
  const row = await prisma.libraryFile.findUnique({ where: { id: fileId } })
  if (!row?.ownerBridgeId) throw notFound('File not found')
  assertDemoLibraryFileMutationAllowed(request, row)

  const data: { name?: string; folderId?: string | null; ownerBridgeId?: string | null } = {}
  if (parsed.data.name !== undefined) data.name = parsed.data.name
  if (parsed.data.folderId !== undefined) {
    if (parsed.data.folderId) {
      const parent = await prisma.libraryFolder.findUnique({ where: { id: parsed.data.folderId } })
      if (!parent?.ownerBridgeId) throw notFound('Folder not found')
      data.ownerBridgeId = parent.ownerBridgeId
    } else {
      const targetBridgeId = parsed.data.bridgeId ?? row.ownerBridgeId
      if (!targetBridgeId) throw badRequest('Select a bridge before moving a library file')
      data.ownerBridgeId = targetBridgeId
    }
    data.folderId = parsed.data.folderId
  }
  if (parsed.data.bridgeId !== undefined && parsed.data.folderId == null) {
    const targetBridgeId = parsed.data.bridgeId ?? null
    if (!targetBridgeId) throw badRequest('Select a bridge before moving a library file')
    data.ownerBridgeId = targetBridgeId
  }

  const updated = await prisma.libraryFile.update({ where: { id: row.id }, data })
  annotateRequestAuditLog(request, {
    action: parsed.data.folderId !== undefined && parsed.data.name !== undefined
      ? 'move-rename'
      : parsed.data.folderId !== undefined
        ? 'move'
        : 'rename',
    resource: 'library file',
    summary: parsed.data.folderId !== undefined && parsed.data.name !== undefined
      ? `Renamed and moved library file ${row.name}.`
      : parsed.data.folderId !== undefined
        ? `Moved library file ${row.name}.`
        : `Renamed library file ${row.name} to ${updated.name}.`,
    metadata: {
      fileId: row.id,
      previousName: row.name,
      fileName: updated.name,
      previousFolderId: row.folderId,
      folderId: updated.folderId
    }
  })
  if (!row.hidden) broadcastLibraryChanged()
  response.json({ file: await toDto(updated) })
})

/**
 * Enqueue a library file for printing. The HTTP request returns as soon
 * as the dispatcher accepts the job; the API process performs the slow
 * FTPS upload and MQTT start command in the background.
 */
libraryRouter.post('/:id/print', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
  const tenantId = requireRequestTenantId(request)
  const fileId = requireRouteParam(request.params.id, 'File id')
  const parsed = printFromLibrarySchema.omit({ fileId: true }).safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid print payload')
  }
  const job = await enqueueLibraryPrint({
    fileId,
    ...parsed.data
  }, tenantId)
  annotateRequestAuditLog(request, {
    action: 'start-print',
    resource: 'print job',
    summary: `Queued print ${job.jobName} on ${job.printerName}.`,
    metadata: {
      jobId: job.id,
      printerId: job.printerId,
      printerName: job.printerName,
      fileId: job.fileId,
      fileName: job.fileName,
      plate: job.plate
    }
  })
  broadcastPrintDispatchChanged(tenantId)
  response.status(202).json({ job })
})

/**
 * Re-print: re-issue a `project_file` for the most recently uploaded
 * file. Bambu firmware accepts this without re-uploading because the
 * file remains on the SD card after the previous print.
 */
libraryRouter.post('/:id/reprint', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
  const fileId = requireRouteParam(request.params.id, 'File id')
  const parsed = printFromLibrarySchema.omit({ fileId: true }).pick({
    printerId: true,
    useAms: true,
    bedLevel: true,
    vibrationCompensation: true,
    flowCalibration: true,
    firstLayerInspection: true,
    timelapse: true,
    filamentDynamicsCalibration: true,
    nozzleOffsetCalibration: true,
    allowIncompatibleFilament: true,
    allowPlateTypeMismatch: true,
    currentPlateType: true,
    currentNozzleDiameters: true,
    plate: true,
    amsMapping: true
  }).safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid re-print payload')
  }
  const file = await prisma.libraryFile.findUnique({ where: { id: fileId } })
  if (!file) throw notFound('File not found')
  const printer = printerManager.getPrinter(parsed.data.printerId)
  if (!printer) throw notFound('Printer not found or not connected')

  if (!isDirectPrintableFileName(file.name)) {
    throw badRequest('Only .gcode or .gcode.3mf files can be printed directly')
  }
  const blocked = printGuards.evaluate({ printerId: printer.id, source: 'reprint' })
  if (blocked) throw conflict(blocked.reason ?? 'Print blocked by a plugin')
  printDispatcher.assertNoActiveDispatchForPrinter(printer.id)

  const sourceKind = getPrintSourceKind(file.name)
  let index: ParsedThreeMfIndex | null = null
  if (sourceKind === '3mf') {
    try {
      index = await readLibraryThreeMfIndex(file)
    } catch {
      throw notFound('File missing on bridge')
    }

    assertLibraryPrintCompatibilityForIndex(index, {
      plate: parsed.data.plate,
      printerModel: printer.model,
      printerStatus: printerManager.getStatus(printer.id),
      amsMapping: parsed.data.amsMapping,
      allowIncompatibleFilament: parsed.data.allowIncompatibleFilament,
      allowPlateTypeMismatch: parsed.data.allowPlateTypeMismatch,
      currentPlateType: parsed.data.currentPlateType,
      currentNozzleDiameters: parsed.data.currentNozzleDiameters
    })
  }

  const printerStatus = printerManager.getStatus(printer.id)
  const firstLayerInspectionProvided =
    typeof request.body === 'object'
    && request.body != null
    && Object.prototype.hasOwnProperty.call(request.body, 'firstLayerInspection')
  const normalizedOptions = normalizePrintStartOptionsForPrinter(
    printer.model,
    {
      ...parsed.data,
      firstLayerInspection: firstLayerInspectionProvided
        ? parsed.data.firstLayerInspection
        : resolvePrinterFirstLayerInspectionDefault(printer.model, printerStatus)
    },
    printerStatus
  )
  const plateName = resolveRequestedPlateName(file.name, index, parsed.data.plate)
  const target = getRemotePrintTarget(file.name, getPrintSourceKind(file.name), parsed.data.plate, plateName, {
    isMultiPlate: index ? index.plates.length > 1 : true
  })
  const submissionId = String((Date.now() % 2_147_483_647) || 1)
  const printPayload = buildProjectFilePrintCommand({
    remoteName: target.remoteName,
    param: target.param,
    subtaskName: target.subtaskName,
    submissionId,
    bedLevel: normalizedOptions.bedLevel,
    flowCalibration: normalizedOptions.flowCalibration,
    vibrationCompensation: normalizedOptions.vibrationCompensation,
    firstLayerInspection: normalizedOptions.firstLayerInspection,
    filamentDynamicsCalibration: normalizedOptions.filamentDynamicsCalibration,
    nozzleOffsetCalibration: normalizedOptions.nozzleOffsetCalibration,
    timelapse: normalizedOptions.timelapse,
    useAms: parsed.data.useAms,
    amsMapping: parsed.data.amsMapping
  })
  const trackedJobId = await startTrackedPrintJob({
    printerId: printer.id,
    jobName: target.subtaskName,
    fileName: file.name,
    metadata: {
      jobKind: 'file',
      jobId: null,
      printerFilePath: `/${target.remoteName}`,
      fileId: file.id,
      fileName: file.name,
      fileSizeBytes: file.sizeBytes,
      sourceKind: getPrintSourceKind(file.name),
      plate: parsed.data.plate,
      useAms: parsed.data.useAms,
      bedLevel: normalizedOptions.bedLevel !== 'off',
      amsMapping: parsed.data.amsMapping ?? null,
      calibrationOption: null
    },
    publish: () => printerManager.publishCommand(printer.id, { print: printPayload })
  })
  if (!trackedJobId) throw badRequest('Printer is not connected — command was not delivered')
  annotateRequestAuditLog(request, {
    action: 'reprint-print',
    resource: 'print job',
    summary: `Started reprint of ${file.name} on ${printer.name}.`,
    metadata: {
      printerId: printer.id,
      printerName: printer.name,
      fileId: file.id,
      fileName: file.name,
      plate: parsed.data.plate,
      jobId: trackedJobId
    }
  })
  response.status(202).end()
})

function resolveRequestedPlateName(fileName: string, index: ParsedThreeMfIndex | null, plate: number): string | null {
  if (getPrintSourceKind(fileName) !== '3mf') return null
  return index?.plates.find((entry) => entry.index === plate)?.name?.trim() || null
}

async function resolveLibraryFilePath(row: {
  ownerBridgeId?: string | null
  storedPath: string
}): Promise<string> {
  return await resolveLibraryFileToLocalPath(row)
}

async function copyLibraryEntryBytes(
  source: { ownerBridgeId?: string | null; storedPath: string },
  target: { ownerBridgeId?: string | null; storedPath: string }
): Promise<void> {
  if (source.ownerBridgeId && target.ownerBridgeId && source.ownerBridgeId === target.ownerBridgeId) {
    await copyBridgeLibraryFile({
      ownerBridgeId: source.ownerBridgeId,
      sourceStoredPath: source.storedPath,
      targetStoredPath: target.storedPath
    })
    return
  }

  const sourcePath = await resolveLibraryFilePath(source)
  if (target.ownerBridgeId) {
    await storeBridgeLibraryFile(target.ownerBridgeId, target.storedPath, sourcePath)
    return
  }

  await copyFile(sourcePath, path.join(libraryDir, target.storedPath))
}

async function readLibraryThreeMfIndex(
  row: {
    ownerBridgeId?: string | null
    storedPath: string
  },
  signal?: AbortSignal
): Promise<ParsedThreeMfIndex> {
  if (row.ownerBridgeId) {
    return await inspectBridgeLibraryThreeMf(row, signal)
  }
  const onDisk = await resolveLibraryFilePath(row)
  return await readPlateIndex(onDisk, signal)
}

async function toDto(row: {
  id: string
  name: string
  ownerBridgeId?: string | null
  sizeBytes: number
  uploadedAt: Date
  kind: string
  storedPath: string
  thumbnailPath: string | null
  folderId: string | null
  createdByName?: string | null
  restoredFromVersionNumber?: number | null
}): Promise<LibraryFile> {
  let compatiblePrinterModels: LibraryFile['compatiblePrinterModels'] = []
  let plateTypeChips: LibraryFile['plateTypeChips'] = []
  let nozzleSizeChips: LibraryFile['nozzleSizeChips'] = []
  let projectFilamentChips: LibraryFile['projectFilamentChips'] = []
  let plateCount = 0
  if (row.kind === '3mf' || row.kind === 'gcode') {
    try {
      const index = await readLibraryThreeMfIndex(row)
      compatiblePrinterModels = index.compatiblePrinterModels
      plateTypeChips = collectPlateTypeChips(index)
      nozzleSizeChips = collectNozzleSizeChips(index)
      projectFilamentChips = collectProjectFilamentChips(index)
      plateCount = index.plates.length
    } catch {
      compatiblePrinterModels = []
      plateTypeChips = []
      nozzleSizeChips = []
      projectFilamentChips = []
      plateCount = 0
    }
  }
  return {
    id: row.id,
    name: row.name,
    sizeBytes: row.sizeBytes,
    uploadedAt: row.uploadedAt.toISOString(),
    kind: row.kind as LibraryFile['kind'],
    thumbnailPath: row.thumbnailPath,
    folderId: row.folderId,
    compatiblePrinterModels,
    plateTypeChips,
    nozzleSizeChips,
    projectFilamentChips,
    plateCount,
    createdByName: row.createdByName ?? null,
    restoredFromVersionNumber: row.restoredFromVersionNumber ?? null
  }
}

async function toVersionDto(row: LibraryFileRow | LibraryFileVersionRow): Promise<LibraryFileVersionDto> {
  const dto = await toDto({
    id: row.id,
    name: row.name,
    ownerBridgeId: row.ownerBridgeId,
    sizeBytes: row.sizeBytes,
    uploadedAt: row.uploadedAt,
    kind: row.kind,
    storedPath: row.storedPath,
    thumbnailPath: row.thumbnailPath,
    folderId: row.folderId,
    createdByName: row.createdByName ?? null,
    restoredFromVersionNumber: row.restoredFromVersionNumber ?? null
  })
  return {
    ...dto,
    libraryFileId: 'libraryFileId' in row ? row.libraryFileId : row.id,
    versionId: 'libraryFileId' in row ? row.id : null,
    versionNumber: 'versionNumber' in row ? row.versionNumber : row.currentVersionNumber,
    isCurrent: !('libraryFileId' in row)
  }
}

function buildLibraryStoredPath(fileName: string): string {
  const safe = fileName.replace(/[^\w.-]+/g, '_')
  return `${Date.now()}-${safe}`
}

function toLibraryFileVersionCreateInput(row: LibraryFileRow) {
  return {
    tenantId: row.tenantId,
    libraryFileId: row.id,
    ownerBridgeId: row.ownerBridgeId,
    folderId: row.folderId,
    name: row.name,
    storedPath: row.storedPath,
    sizeBytes: row.sizeBytes,
    kind: row.kind,
    thumbnailPath: row.thumbnailPath,
    uploadedAt: row.uploadedAt,
    versionNumber: row.currentVersionNumber,
    createdById: row.createdById ?? null,
    createdByName: row.createdByName ?? null,
    restoredFromVersionNumber: row.restoredFromVersionNumber ?? null
  }
}

async function sendLibraryFileDownload(
  response: Response,
  row: { name: string; ownerBridgeId?: string | null; storedPath: string }
): Promise<void> {
  let onDisk: string
  try {
    onDisk = await resolveLibraryFilePath(row)
  } catch {
    throw notFound('File missing on disk')
  }
  response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.name)}"`)
  createReadStream(onDisk).pipe(response)
}

function sendNotModifiedIfLibraryFileFresh(
  request: Request,
  response: Response,
  row: { ownerBridgeId?: string | null; storedPath: string; sizeBytes: number; uploadedAt: Date },
  variant: string
): boolean {
  const etag = buildLibraryFileEtag(row, variant)
  response.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate, s-maxage=0')
  response.setHeader('ETag', etag)
  response.vary('Cookie')
  response.vary('X-PrintStream-Tenant')
  if (!requestFreshnessMatches(request, etag)) return false
  response.status(304).end()
  return true
}

/**
 * Scene ETag version. The library-file ETag is keyed on the file's bytes, so when
 * the scene parser starts emitting new fields (e.g. exclude-zone labels, prime
 * tower) the ETag for an unchanged file would otherwise stay the same and clients
 * would keep a stale cached `/scene` body via 304. Bump this on scene-shape changes.
 */
const SCENE_ETAG_VERSION = 'scene-v9'

function buildLibraryFileEtag(
  row: { ownerBridgeId?: string | null; storedPath: string; sizeBytes: number; uploadedAt: Date },
  variant: string
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      row.ownerBridgeId ?? '',
      row.storedPath,
      row.sizeBytes,
      row.uploadedAt.toISOString(),
      variant
    ]))
    .digest('base64url')
  return `"${digest}"`
}

function requestFreshnessMatches(request: Request, etag: string): boolean {
  const header = request.headers['if-none-match']
  if (header == null) return false
  const values = Array.isArray(header) ? header : header.split(',')
  return values.some((value) => value.trim() === '*' || value.trim() === etag)
}

async function sendLibraryFilePlates(
  request: Request,
  response: Response,
  row: { kind: string; ownerBridgeId?: string | null; storedPath: string; sizeBytes: number; uploadedAt: Date }
): Promise<void> {
  if (sendNotModifiedIfLibraryFileFresh(request, response, row, 'plates')) return
  if (row.kind !== '3mf' && row.kind !== 'gcode') {
    response.json({ plates: [], projectFilaments: [], compatiblePrinterModels: [], printerProfileName: null, processProfileName: null } satisfies LibraryThreeMfIndexDto)
    return
  }
  const signal = requestAbortSignal(request, response)
  try {
    const index = await readLibraryThreeMfIndex(row, signal)
    response.json({
      plates: index.plates.map((plate) => ({
        index: plate.index,
        name: plate.name,
        hasThumbnail: plate.thumbnailFile != null,
        plateType: plate.plateType,
        nozzleSizes: plate.nozzleSizes,
        filaments: plate.filaments,
        objects: plate.objects,
        prediction: plate.prediction ?? null,
        weight: plate.weight ?? null
      })),
      projectFilaments: index.projectFilaments,
      compatiblePrinterModels: index.compatiblePrinterModels,
      printerProfileName: index.printerProfileName,
      processProfileName: index.processProfileName
    } satisfies LibraryThreeMfIndexDto)
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    response.json({ plates: [], projectFilaments: [], compatiblePrinterModels: [], printerProfileName: null, processProfileName: null } satisfies LibraryThreeMfIndexDto)
  }
}

async function sendLibraryFileThumbnail(
  request: Request,
  response: Response,
  row: { kind: string; ownerBridgeId?: string | null; storedPath: string; sizeBytes: number; uploadedAt: Date }
): Promise<void> {
  if (row.kind !== '3mf' && row.kind !== 'gcode') throw notFound('No thumbnail available')
  const signal = requestAbortSignal(request, response)
  const plateIndex = parsePlateIndexQuery(request.query.plate)
  if (sendNotModifiedIfLibraryFileFresh(request, response, row, `thumbnail:${plateIndex}`)) return
  if (row.ownerBridgeId) {
    const buffer = await readBridgeLibraryThumbnail(row, plateIndex, signal)
    if (!buffer) throw notFound('Thumbnail missing')
    response.setHeader('Content-Type', 'image/png')
    response.send(buffer)
    return
  }

  let entryPath: string | null = null
  let onDisk: string
  try {
    onDisk = await resolveLibraryFilePath(row)
  } catch {
    throw notFound('File missing on disk')
  }
  try {
    const index = await readPlateIndex(onDisk, signal)
    const plate = index.plates.find((entry) => entry.index === plateIndex) ?? index.plates[0]
    entryPath = plate?.thumbnailFile ?? `Metadata/plate_${plateIndex}.png`
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    entryPath = `Metadata/plate_${plateIndex}.png`
  }
  try {
    const buffer = await readEntry(onDisk, entryPath, signal)
    response.setHeader('Content-Type', 'image/png')
    response.send(buffer)
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    throw notFound('Thumbnail missing')
  }
}

async function sendLibraryFileScene(
  request: Request,
  response: Response,
  row: { kind: string; ownerBridgeId?: string | null; storedPath: string; sizeBytes: number; uploadedAt: Date }
): Promise<void> {
  // gcode.3mf still embeds the model (3D/3dmodel.model), so it has a plated mesh scene
  // too — used for the client-rendered thumbnail fallback when no plate PNG is embedded.
  if (row.kind !== '3mf' && row.kind !== 'gcode') throw notFound('No plated 3D scene available')
  const plateIndex = parsePlateIndexQuery(request.query.plate)
  // Optional target-printer override: show the selected printer's bed + unprintable
  // zones rather than the file's embedded machine. Part of the ETag so switching
  // printers in the slice dialog re-fetches a fresh bed.
  const overrideModel = printerModelSchema.safeParse(request.query.printerModel).data ?? null
  if (sendNotModifiedIfLibraryFileFresh(request, response, row, `${SCENE_ETAG_VERSION}:${plateIndex}:${overrideModel ?? ''}`)) return

  let onDisk: string
  try {
    onDisk = await resolveLibraryFilePath(row)
  } catch {
    throw notFound('File missing on disk')
  }

  const signal = requestAbortSignal(request, response)
  try {
    const scene = await readSceneManifest(onDisk, plateIndex, signal, overrideModel)
    response.json(scene satisfies LibraryThreeMfSceneDto)
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    throw notFound(error instanceof Error && error.message ? error.message : 'No plated 3D scene available')
  }
}

async function sendLibraryFilePlateGcode(
  request: Request,
  response: Response,
  row: { kind: string; ownerBridgeId?: string | null; storedPath: string; sizeBytes: number; uploadedAt: Date }
): Promise<void> {
  if (row.kind !== '3mf' && row.kind !== 'gcode') throw notFound('No plate preview available')
  const signal = requestAbortSignal(request, response)
  const plateIndex = parsePlateIndexQuery(request.query.plate)
  if (sendNotModifiedIfLibraryFileFresh(request, response, row, `plate-gcode:${plateIndex}`)) return

  let onDisk: string
  try {
    onDisk = await resolveLibraryFilePath(row)
  } catch {
    throw notFound('File missing on disk')
  }

  let entryPath: string | null = null
  try {
    const index = await readPlateIndex(onDisk, signal)
    const plate = index.plates.find((entry) => entry.index === plateIndex) ?? index.plates[0]
    entryPath = plate?.gcodeFile ?? `Metadata/plate_${plateIndex}.gcode`
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    entryPath = `Metadata/plate_${plateIndex}.gcode`
  }

  try {
    const buffer = await readEntry(onDisk, entryPath, signal, 256 * 1024 * 1024)
    response.setHeader('Content-Type', 'text/plain; charset=utf-8')
    response.send(buffer)
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    throw notFound('Plate G-code missing')
  }
}

async function resolveLibraryFilePreviewAsset(
  request: Request,
  response: Response,
  row: { kind: string; ownerBridgeId?: string | null; storedPath: string }
): Promise<LibraryThreeMfPreviewAssetDto | null> {
  if (row.kind !== '3mf') throw notFound('No embedded preview source available')
  const signal = requestAbortSignal(request, response)

  let onDisk: string
  try {
    onDisk = await resolveLibraryFilePath(row)
  } catch {
    throw notFound('File missing on disk')
  }

  let assets: LibraryThreeMfPreviewAssetDto[]
  try {
    assets = await readPreviewAssets(onDisk, signal)
  } catch (error) {
    if ((error as Error).name === 'AbortError') return null
    throw notFound('Unable to inspect embedded preview sources')
  }

  if (assets.length === 0) throw notFound('No embedded STL or STEP preview source found')
  if (assets.length > 1) {
    throw conflict('This 3MF contains multiple embedded STL or STEP sources, and source selection is not available yet')
  }
  return assets[0] ?? null
}

function collectPlateTypeChips(index: {
  plates: Array<{ plateType: string | null }>
}): LibraryFile['plateTypeChips'] {
  const seen = new Set<string>()
  const ordered: LibraryFile['plateTypeChips'] = []
  for (const plate of index.plates) {
    const label = plate.plateType?.trim() ?? ''
    if (!label || seen.has(label)) continue
    seen.add(label)
    ordered.push(label)
  }
  return ordered
}

function collectNozzleSizeChips(index: {
  plates: Array<{ nozzleSizes: string[] }>
}): LibraryFile['nozzleSizeChips'] {
  const seen = new Set<string>()
  const ordered: LibraryFile['nozzleSizeChips'] = []
  for (const plate of index.plates) {
    for (const size of plate.nozzleSizes) {
      const label = `${size} mm`
      if (seen.has(label)) continue
      seen.add(label)
      ordered.push(label)
    }
  }
  return ordered
}

function collectProjectFilamentChips(index: {
  plates: Array<{ filaments: Array<{ id: number; filamentType: string | null; filamentName: string | null; color: string | null }> }>
  projectFilaments: Array<{ id: number; filamentType: string | null; filamentName: string | null; color: string | null }>
}): LibraryFile['projectFilamentChips'] {
  const seen = new Set<string>()
  const ordered: LibraryFile['projectFilamentChips'] = []
  const projectFilamentsById = new Map(index.projectFilaments.map((filament) => [filament.id, filament]))

  for (const plate of index.plates) {
    for (const filament of plate.filaments) {
      const projectFilament = projectFilamentsById.get(filament.id)
      const label = normalizeProjectFilamentLabel(
        projectFilament?.filamentName
        ?? filament.filamentName
        ?? projectFilament?.filamentType
        ?? filament.filamentType
        ?? ''
      )
      const color = normalizeProjectFilamentColor(projectFilament?.color ?? filament.color ?? null)
      const key = `${label}::${color ?? ''}`
      if (!label || seen.has(key)) continue
      seen.add(key)
      ordered.push({ label, color })
    }
  }

  return ordered
}

function normalizeProjectFilamentLabel(value: string): string {
  return value
    .trim()
    .replace(/\s*\([^)]*\.(?:3mf|gcode(?:\.3mf)?)\)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeProjectFilamentColor(value: string | null): string | null {
  if (!value) return null
  const normalized = value.trim().toUpperCase()
  return /^#[0-9A-F]{6}$/.test(normalized) ? normalized : null
}

function toFolderDto(row: { id: string; name: string; parentId: string | null }): LibraryFolder {
  return { id: row.id, name: row.name, parentId: row.parentId }
}

/**
 * Parse the `folderId` query string. Returns `undefined` to mean "no
 * filter" (show every folder), `null` for top-level files, or the id
 * string itself.
 */
function parseFolderQuery(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return undefined
  if (value === '' || value === 'null' || value === 'root') return null
  return value
}

function parseBridgeQuery(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function parseFolderField(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return null
  if (value === '' || value === 'null' || value === 'root') return null
  return value
}

/** Coerce a multipart form field to a boolean. Defaults to false. */
function parseBooleanField(value: unknown): boolean {
  if (value === true) return true
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes'
}

function resolveLibraryUploadHidden(request: Request, hidden: boolean, sizeBytes: number): boolean {
  if (!requestHasDemoModeRestrictions(request)) return hidden
  if (sizeBytes > DEMO_LIBRARY_UPLOAD_MAX_BYTES) {
    throw new HttpError(413, DEMO_LIBRARY_UPLOAD_MESSAGE)
  }
  return true
}

function assertDemoLibraryFileMutationAllowed(request: Request, row: { hidden: boolean }): void {
  if (requestHasDemoModeRestrictions(request) && !row.hidden) {
    throw forbidden(DEMO_LIBRARY_MUTATION_MESSAGE)
  }
}

async function isDescendant(candidateId: string, ancestorId: string): Promise<boolean> {
  let current: string | null = candidateId
  // Bounded walk — folder trees are tiny and parentId chains terminate at null.
  for (let depth = 0; depth < 64 && current; depth++) {
    if (current === ancestorId) return true
    const parent: { parentId: string | null } | null = await prisma.libraryFolder.findUnique({
      where: { id: current },
      select: { parentId: true }
    })
    if (!parent) return false
    current = parent.parentId
  }
  return false
}

