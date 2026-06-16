/**
 * Hook that subscribes to a printer's camera feed over the shared
 * WebSocket. Calls `onFrame` with each decoded JPEG `ImageBitmap`,
 * suitable for painting onto a canvas without flicker.
 *
 * On mount it sends `camera.subscribe`; on unmount `camera.unsubscribe`.
 * No additional HTTP connections are opened.
 */
import { useEffect, useRef } from 'react'
import { wsClient } from '../lib/wsClient'
import { markLiveCameraStreamActive, markLiveCameraStreamInactive } from './useLiveCameraState'

const PRINTER_ID_LENGTH = 36

export function useCameraStream(
  printerId: string,
  onFrame: (bitmap: ImageBitmap) => void,
  enabled = true
): void {
  const onFrameRef = useRef(onFrame)

  useEffect(() => {
    onFrameRef.current = onFrame
  }, [onFrame])

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let decodeInFlight = false
    let pendingJpeg: ArrayBuffer | null = null

    const decodeLatestFrame = () => {
      if (cancelled || decodeInFlight || !pendingJpeg) return

      const jpeg = pendingJpeg
      pendingJpeg = null
      decodeInFlight = true

      const blob = new Blob([jpeg], { type: 'image/jpeg' })
      createImageBitmap(blob).then((bitmap) => {
        if (cancelled) {
          bitmap.close()
          return
        }
        onFrameRef.current(bitmap)
      }).catch(() => {
        // Bad frame — ignore
      }).finally(() => {
        decodeInFlight = false
        if (pendingJpeg) queueMicrotask(decodeLatestFrame)
      })
    }

    const subscribe = () => {
      wsClient.send(JSON.stringify({ type: 'camera.subscribe', printerId }))
    }

    markLiveCameraStreamActive(printerId)
    subscribe()
    const removeOpenListener = wsClient.onOpen(subscribe)

    const removeListener = wsClient.onBinary((buffer) => {
      if (cancelled) return
      if (buffer.byteLength <= PRINTER_ID_LENGTH) return
      const idBytes = new Uint8Array(buffer, 0, PRINTER_ID_LENGTH)
      const id = String.fromCharCode(...idBytes).trimEnd()
      if (id !== printerId) return

      pendingJpeg = buffer.slice(PRINTER_ID_LENGTH)
      decodeLatestFrame()
    })

    return () => {
      cancelled = true
      removeOpenListener()
      removeListener()
      markLiveCameraStreamInactive(printerId)
      wsClient.send(JSON.stringify({ type: 'camera.unsubscribe', printerId }))
    }
  }, [enabled, printerId])
}
