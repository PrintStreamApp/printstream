/**
 * Printer-storage thumbnails for models and timelapses.
 *
 * The route chooses a permission from the requested file kind before reading printer bytes.
 * Thumbnail reads are best-effort, honor request cancellation, and keep the same media response
 * headers and development diagnostics as the printer router previously served.
 */
import path from 'node:path'
import type { Router } from 'express'
import {
  PRINTER_STORAGE_VIEW_MODELS_SCOPE,
  PRINTER_STORAGE_VIEW_TIMELAPSES_SCOPE,
  type Printer
} from '@printstream/shared'
import { assertRequestPermission } from '../lib/authorization.js'
import { env } from '../lib/env.js'
import { notFound } from '../lib/http-error.js'
import { requireWorkspaceOwnedConnectedPrinter } from '../lib/printer-access.js'
import { downloadFileFromPrinter } from '../lib/printer-ftp.js'
import { readPrinterStorageThumbnail } from '../lib/printer-storage-3mf.js'
import { requestAbortSignal, requireRouteParam } from '../lib/request-helpers.js'
import { buildTimelapseThumbnailCandidates } from '../lib/timelapse-thumbnails.js'
import { normalizePrinterPath } from './printer-storage-policy.js'

async function readTimelapseThumbnail(
  printer: Printer,
  filePath: string,
  signal?: AbortSignal
): Promise<{ buffer: Buffer; mimeType: 'image/jpeg' | 'image/png' } | null> {
  const candidates = buildTimelapseThumbnailCandidates(filePath)
  const jpeg = await downloadFileFromPrinter(printer, candidates.jpg, undefined, { signal }).catch(() => null)
  if (jpeg) return { buffer: jpeg, mimeType: 'image/jpeg' }
  const png = await downloadFileFromPrinter(printer, candidates.png, undefined, { signal }).catch(() => null)
  if (png) return { buffer: png, mimeType: 'image/png' }
  return null
}

function logPrinterStorageThumbnailRequest(printer: Printer, details: {
  kind: 'model' | 'timelapse'
  filePath: string
  outcome: 'hit' | 'miss'
  mimeType?: string
}): void {
  if (env.NODE_ENV === 'production') return

  const parts = [
    `[storage-thumbnail:${printer.name}]`,
    `kind=${details.kind}`,
    `outcome=${details.outcome}`,
    `path=${details.filePath}`
  ]
  if (details.mimeType) parts.push(`mime=${details.mimeType}`)
  console.info(parts.join(' '))
}

/** Register the media preview endpoint at its existing printer-router position. */
export function registerPrinterStorageThumbnailRoute(router: Router): void {
  /** Best-effort preview image for a printer-stored model or timelapse file. */
  router.get('/:id/storage/thumbnail', async (request, response) => {
    const printer = await requireWorkspaceOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
    if (!printer) throw notFound('Printer not found or not connected')
    const filePath = normalizePrinterPath(request.query.path)
    const extension = path.extname(filePath).toLowerCase()
    assertRequestPermission(
      request,
      extension === '.mp4' ? PRINTER_STORAGE_VIEW_TIMELAPSES_SCOPE : PRINTER_STORAGE_VIEW_MODELS_SCOPE
    )
    const signal = requestAbortSignal(request, response)

    if (extension === '.3mf') {
      const png = await readPrinterStorageThumbnail(printer, filePath, { signal })
      logPrinterStorageThumbnailRequest(printer, {
        kind: 'model',
        filePath,
        outcome: png ? 'hit' : 'miss',
        mimeType: png ? 'image/png' : undefined
      })
      if (!png) throw notFound('Thumbnail unavailable')
      response.setHeader('Content-Type', 'image/png')
      response.setHeader('Cache-Control', 'private, max-age=300')
      response.send(png)
      return
    }

    if (extension === '.mp4') {
      const image = await readTimelapseThumbnail(printer, filePath, signal)
      logPrinterStorageThumbnailRequest(printer, {
        kind: 'timelapse',
        filePath,
        outcome: image ? 'hit' : 'miss',
        mimeType: image?.mimeType
      })
      if (!image) throw notFound('Thumbnail unavailable')
      response.setHeader('Content-Type', image.mimeType)
      response.setHeader('Cache-Control', 'private, max-age=300')
      response.send(image.buffer)
      return
    }

    throw notFound('Thumbnail unavailable')
  })
}
