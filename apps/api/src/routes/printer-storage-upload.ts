/**
 * Direct uploads to printer storage.
 *
 * This route owns its bounded multipart middleware and temporary-file cleanup. The parent registers
 * it in the original position; workspace ownership, demo policy, audit annotation, and storage
 * invalidation remain part of the same request path.
 */
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Router } from 'express'
import multer from 'multer'
import { PRINTERS_MANAGE_STORAGE_UPLOAD_SCOPE } from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { assertPrinterMutationsAllowed } from '../lib/demo-mode.js'
import { env } from '../lib/env.js'
import { badRequest } from '../lib/http-error.js'
import { requireWorkspaceOwnedConnectedPrinter } from '../lib/printer-access.js'
import { uploadFileToPrinterPath } from '../lib/printer-ftp.js'
import { clearPrinterStorageThreeMfInspectionCache } from '../lib/printer-storage-3mf.js'
import { singleUploadWithLimit } from '../lib/request-helpers.js'
import { broadcastPrinterStorageChanged } from '../lib/ws-resource-events.js'
import { normalizePrinterPath } from './printer-storage-policy.js'

const MAX_PRINTER_STORAGE_UPLOAD_BYTES = env.LIBRARY_MAX_UPLOAD_BYTES
const printerStorageUpload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, tmpdir()),
    filename: (_request, file, callback) => {
      const safe = file.originalname.replace(/[^\w.-]+/g, '_') || 'upload.bin'
      callback(null, `${Date.now()}-${safe}`)
    }
  }),
  limits: { fileSize: MAX_PRINTER_STORAGE_UPLOAD_BYTES }
})

function uploadSinglePrinterStorageFile(field: string) {
  return singleUploadWithLimit({
    upload: printerStorageUpload,
    field,
    maxBytes: MAX_PRINTER_STORAGE_UPLOAD_BYTES,
    onLimitExceeded: (maxBytes) =>
      badRequest(`File exceeds ${Math.round(maxBytes / (1024 * 1024))} MB upload limit`),
    onMulterError: (error) => badRequest(error.message)
  })
}

function sanitizePrinterStorageUploadFileName(raw: string): string {
  const safe = path.posix.basename(raw.replace(/\\/g, '/')).replace(/[^\w.-]+/g, '_')
  if (!safe || safe === '.' || safe === '..') throw badRequest('Invalid filename')
  return safe
}

/** Register the bounded direct-upload route at its original printer-router position. */
export function registerPrinterStorageUploadRoute(router: Router): void {
  /** Upload a file directly into an existing printer-storage directory. */
  router.post(
    '/:id/storage/upload',
    requireRequestPermission(PRINTERS_MANAGE_STORAGE_UPLOAD_SCOPE),
    uploadSinglePrinterStorageFile('file'),
    async (request, response) => {
      assertPrinterMutationsAllowed(request)
      const printerId = typeof request.params.id === 'string' ? request.params.id : request.params.id?.[0]
      if (!printerId) throw badRequest('Printer id is required')
      const printer = await requireWorkspaceOwnedConnectedPrinter(printerId)
      if (!request.file) throw badRequest('File is required')

      const dirPath = normalizePrinterPath(request.query.path)
      const fileName = sanitizePrinterStorageUploadFileName(request.file.originalname)
      const remotePath = dirPath === '/' ? `/${fileName}` : `${dirPath}/${fileName}`

      try {
        const uploadedPath = await uploadFileToPrinterPath(printer, request.file.path, remotePath)
        annotateRequestAuditLog(request, {
          action: 'upload',
          resource: 'printer storage file',
          summary: `Uploaded ${path.basename(uploadedPath)} to printer storage on ${printer.name}.`,
          metadata: {
            printerId: printer.id,
            printerName: printer.name,
            path: uploadedPath,
            fileName: path.basename(uploadedPath),
            sizeBytes: request.file.size
          }
        })
        clearPrinterStorageThreeMfInspectionCache(printer.id)
        broadcastPrinterStorageChanged(printer.id)
        response.status(201).json({ path: uploadedPath })
      } catch (error) {
        throw badRequest((error as Error).message || 'Failed to upload file')
      } finally {
        await unlink(request.file.path).catch(() => undefined)
      }
  })
}
