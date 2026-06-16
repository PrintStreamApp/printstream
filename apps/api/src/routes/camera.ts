/**
 * Camera proxy.
 *
 * Bambu chamber cameras use two transport families: P1/A1-series models
 * expose a proprietary TLS JPEG stream on port 6000, while X/X2/H-series
 * models expose RTSP(S) that we proxy through ffmpeg. The browser cannot
 * speak either transport directly, so the API exposes:
 *
 *   - GET /:id/snapshot  → single JPEG
 *   - GET /:id/stream    → multipart/x-mixed-replace MJPEG, suitable for
 *                          dropping straight into an `<img>` tag.
 *
 */
import { Router } from 'express'
import { CAMERA_VIEW_PERMISSION } from '@printstream/shared'
import { requireRequestPermission } from '../lib/authorization.js'
import { prisma } from '../lib/prisma.js'
import { badRequest, notFound } from '../lib/http-error.js'
import { supportsChamberCamera } from '../lib/camera.js'
import { getSharedCameraSnapshot } from '../lib/camera-snapshot-cache.js'
import { cameraStreamHub } from '../lib/camera-stream-hub.js'
import type { Printer } from '@printstream/shared'
import { toPrinterDto } from '../lib/printer-record.js'

export const cameraRouter = Router()

const MJPEG_BOUNDARY = 'bambu-frame'
cameraRouter.use(requireRequestPermission(CAMERA_VIEW_PERMISSION))

cameraRouter.get('/:printerId/snapshot', async (request, response) => {
  const printer = await loadPrinterRecord(request.params.printerId)
  if (!supportsChamberCamera(printer.model)) {
    throw badRequest(`Camera not supported for model ${printer.model}`)
  }
  try {
    const frame = await getSharedCameraSnapshot(printer)
    response.setHeader('Content-Type', 'image/jpeg')
    // Allow short browser cache so reusing the same `?t=` URL (e.g.
    // when a dialog opens) hits cache instead of refetching from the
    // printer over TLS — that round-trip caused a visible black gap.
    // The client already cache-busts via the `t` query param every 5s.
    response.setHeader('Cache-Control', 'private, max-age=10')
    response.send(frame)
  } catch (error) {
    response.status(502).json({ error: (error as Error).message })
  }
})

cameraRouter.get('/:printerId/stream', async (request, response) => {
  const printer = await loadPrinterRecord(request.params.printerId)
  if (!supportsChamberCamera(printer.model)) {
    throw badRequest(`Camera not supported for model ${printer.model}`)
  }

  response.setHeader('Content-Type', `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`)
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Pragma', 'no-cache')
  response.setHeader('Connection', 'close')

  let waitingForDrain = false
  const unsubscribe = cameraStreamHub.subscribe(printer.id, (frame) => {
    if (response.writableEnded || waitingForDrain) return

    const header = Buffer.from(
      `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
      'utf8'
    )
    const chunk = Buffer.concat([header, frame, Buffer.from('\r\n', 'utf8')])
    const ok = response.write(chunk)
    if (!ok) {
      waitingForDrain = true
      response.once('drain', () => {
        waitingForDrain = false
      })
    }
  })

  request.on('close', () => {
    unsubscribe()
    if (!response.writableEnded) response.end()
  })
})

async function loadPrinterRecord(id: string): Promise<Printer> {
  const row = await prisma.printer.findUnique({ where: { id } })
  if (!row) throw notFound('Printer not found')
  return toPrinterDto(row)
}
