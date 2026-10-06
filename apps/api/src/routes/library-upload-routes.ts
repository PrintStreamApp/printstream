/**
 * HTTP registration for ordinary and resumable library uploads.
 *
 * Registers static `/uploads` paths before file-id routes. Chunk appends, cancellation, and
 * completion share a per-session mutex; completed receipts let clients reconcile timed-out saves.
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, unlink } from 'node:fs/promises'
import express, { type Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { LIBRARY_UPLOAD_PERMISSION } from '@printstream/shared'
import { skipRequestAuditLog } from '../lib/audit-logs.js'
import { requestHasDemoModeRestrictions } from '../lib/demo-mode.js'
import { env } from '../lib/env.js'
import { badRequest, conflict, HttpError, notFound } from '../lib/http-error.js'
import { libraryDir } from '../lib/library-paths.js'
import { prisma } from '../lib/prisma.js'
import {
  uploadChunkMutex,
  readUploadSession,
  writeUploadSession,
  deleteUploadSession,
  pruneExpiredUploadSessions,
  sessionPaths,
  toUploadSessionResponse,
  type LibraryUploadSession
} from '../lib/library-upload-sessions.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { requireRequestWorkspaceId, requireRouteParam, singleUploadWithLimit } from '../lib/request-helpers.js'
import { chunkUploadCompleteSchema, completeLibraryUpload, completionFromDurableReceipt, createLibraryFileFromUpload } from './library-upload-completion.js'

/**
 * Cap on individual library uploads. Sliced 3MFs from Bambu Studio for
 * dense multi-material prints can comfortably exceed 256 MB once the
 * embedded G-code is stored, so the default is 1 GB. Override with
 * `LIBRARY_MAX_UPLOAD_BYTES` if you really want to cap it lower.
 */
const MAX_UPLOAD_BYTES = env.LIBRARY_MAX_UPLOAD_BYTES
const CHUNK_UPLOAD_BYTES = 16 * 1024 * 1024

const DEMO_LIBRARY_UPLOAD_MAX_BYTES = 15 * 1024 * 1024
const DEMO_LIBRARY_UPLOAD_MESSAGE = 'In the public demo, uploads must be temporary files no larger than 15 MB.'

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


/** Register upload paths while preserving their position before file-id routes. */
export function registerLibraryUploadRoutes(
  router: Router,
  toDto: typeof import('./library-dto.js').toDto,
  assertDemoLibraryFileMutationAllowed: (request: Request, row: { hidden: boolean }) => void
): void {
  router.post('/', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), uploadSingle('file'), async (request, response) => {
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
      response.status(201).json({ file: await toDto(created, { persistDerived: true }), unchanged })
    } finally {
      await unlink(request.file.path).catch(() => undefined)
    }
  })

  router.post('/uploads', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), async (request, response) => {
    // Beginning a resumable transfer is protocol bookkeeping. The durable file/snapshot mutation is
    // annotated by the completion route, so recording both would bury that useful entry in noise.
    skipRequestAuditLog(request)
    await pruneExpiredUploadSessions()
    const parsed = chunkUploadInitSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid upload payload')
    if (parsed.data.sizeBytes > MAX_UPLOAD_BYTES) {
      const limitMb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))
      throw new HttpError(413, `File exceeds ${limitMb} MB upload limit`)
    }
    const hidden = resolveLibraryUploadHidden(request, parsed.data.hidden ?? false, parsed.data.sizeBytes)
    const workspaceId = requireRequestWorkspaceId(request)
    const uploadId = randomUUID()
    const session: LibraryUploadSession = {
      id: uploadId,
      fileName: parsed.data.fileName,
      sizeBytes: parsed.data.sizeBytes,
      receivedBytes: 0,
      phase: 'receiving',
      bridgeReceivedBytes: 0,
      workspaceId,
      folderId: parsed.data.folderId ?? null,
      bridgeId: parsed.data.bridgeId ?? null,
      hidden,
      relativeFolderPath: parsed.data.relativeFolderPath ?? null,
      createdAt: new Date().toISOString()
    }
    await writeUploadSession(session)
    response.status(201).json({ uploadId, chunkSizeBytes: CHUNK_UPLOAD_BYTES, uploadedBytes: 0 })
  })

  router.get('/uploads/:uploadId', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), async (request, response) => {
    const uploadId = requireRouteParam(request.params.uploadId, 'Upload id')
    const workspaceId = requireRequestWorkspaceId(request)
    const session = await readUploadSession(uploadId)
    if (!session) {
      const receipt = await prisma.libraryUploadCompletion.findFirst({ where: { id: uploadId, workspaceId } })
      if (receipt?.status !== 'completed') throw notFound('Upload session not found')
      response.json({
        upload: {
          phase: 'completed',
          sizeBytes: 0,
          receivedBytes: 0,
          bridgeReceivedBytes: 0,
          completion: await completionFromDurableReceipt(receipt, toDto)
        }
      })
      return
    }
    if (session.workspaceId !== workspaceId) throw notFound('Upload session not found')
    if (!session.completion && session.phase !== 'receiving') {
      const receipt = await prisma.libraryUploadCompletion.findFirst({ where: { id: uploadId, workspaceId } })
      if (receipt?.status === 'completed') {
        session.completion = await completionFromDurableReceipt(receipt, toDto)
        session.phase = 'completed'
        session.completedAt = new Date().toISOString()
        await writeUploadSession(session)
      }
    }
    response.json({ upload: toUploadSessionResponse(session) })
  })

  router.post(
    '/uploads/:uploadId/chunks',
    requireRequestPermission(LIBRARY_UPLOAD_PERMISSION),
    uploadChunkBody,
    async (request, response) => {
      // One audit row per 4 MB chunk (and retry) would bury the durable completion entry.
      skipRequestAuditLog(request)
      const uploadId = requireRouteParam(request.params.uploadId, 'Upload id')
      const workspaceId = requireRequestWorkspaceId(request)
      const chunk = Buffer.isBuffer(request.body) ? request.body : null
      if (!chunk || chunk.byteLength === 0) throw badRequest('Upload chunk is empty')
      if (chunk.byteLength > CHUNK_UPLOAD_BYTES) throw badRequest('Upload chunk is too large')
      const offsetHeader = request.header('X-Upload-Offset')
      // The read offset-check append write-back is one critical section per
      // upload; run it under the per-uploadId mutex so concurrent chunks for the
      // same session can't race.
      const result = await uploadChunkMutex.run(uploadId, async () => {
        const session = await readUploadSession(uploadId)
        if (!session) throw notFound('Upload session not found')
        if (session.workspaceId !== workspaceId) throw notFound('Upload session not found')
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
        return { uploadedBytes: session.receivedBytes, complete: session.receivedBytes === session.sizeBytes }
      })
      response.json(result)
    }
  )

  router.delete('/uploads/:uploadId', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), async (request, response) => {
    // Discarding an uncommitted transfer is routine transport cleanup, not a library mutation.
    skipRequestAuditLog(request)
    const uploadId = requireRouteParam(request.params.uploadId, 'Upload id')
    const workspaceId = requireRequestWorkspaceId(request)
    await uploadChunkMutex.run(uploadId, async () => {
      const session = await readUploadSession(uploadId)
      if (session) {
        if (session.workspaceId !== workspaceId) throw notFound('Upload session not found')
        if (session.phase !== 'receiving') {
          throw conflict('Upload completion has started and can no longer be cancelled')
        }
      }
      await deleteUploadSession(uploadId)
    })
    response.status(204).end()
  })

  /**
   * Finish a chunked upload and decide what the bytes become (see `chunkUploadCompleteSchema`).
   *
   * Responses share `file.id`/`file.name` so a caller that only needs the id does not branch:
   * a persisted upload answers with the full `LibraryFile` DTO plus `unchanged` and
   * `archivedVersionId` (matching `POST /api/editor/save`, whose `archivedVersionId` the editor
   * pins as its next save's content base), while a staged snapshot answers with `snapshot: true`
   * and the id alone, because a hidden row has no listing DTO worth deriving.
   */
  router.post('/uploads/:uploadId/complete', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), async (request, response) => {
    const uploadId = requireRouteParam(request.params.uploadId, 'Upload id')
    const parsedBody = chunkUploadCompleteSchema.safeParse(request.body ?? {})
    if (!parsedBody.success) throw badRequest(parsedBody.error.issues[0]?.message ?? 'Invalid upload completion payload')
    const workspaceId = requireRequestWorkspaceId(request)
    const completion = await uploadChunkMutex.run(uploadId, async () => {
      const completionDigest = createHash('sha256').update(JSON.stringify(parsedBody.data)).digest('hex')
      const receipt = await prisma.libraryUploadCompletion.findFirst({ where: { id: uploadId, workspaceId } })
      if (receipt && receipt.intentDigest !== completionDigest) {
        throw conflict('Upload completion was already requested with different options')
      }
      if (receipt?.status === 'completed') {
        // A timed-out client is replaying an already-recorded result. The original request owns the
        // durable file/snapshot annotation; this request mutates nothing and needs no baseline row.
        skipRequestAuditLog(request)
        return await completionFromDurableReceipt(receipt, toDto)
      }
      const session = await readUploadSession(uploadId)
      if (!session || session.workspaceId !== workspaceId) throw notFound('Upload session not found')
      if (session.completion) {
        if (session.completionDigest !== completionDigest) {
          throw conflict('Upload completion was already requested with different options')
        }
        // Same replay case as a durable receipt above, served from the retained session cache.
        skipRequestAuditLog(request)
        return session.completion
      }
      if (session.completionDigest && session.completionDigest !== completionDigest) {
        throw conflict('Upload completion is already running with different options')
      }
      return await completeLibraryUpload({ request, workspaceId, session, completionDigest, payload: parsedBody.data, toDto, assertDemoLibraryFileMutationAllowed })
    })
    response.status(completion.statusCode).json(completion.body)
  })


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
