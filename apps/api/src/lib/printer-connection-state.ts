/**
 * Helpers for deciding whether the runtime MQTT client still represents a
 * live printer control connection.
 *
 * After some printer power-cycle failures mqtt.js can keep a client object in a
 * "connected" state briefly even though the manager has already marked the
 * printer offline. Control paths should trust the normalized printer status in
 * that case and recycle the client instead of continuing to publish into a
 * stale socket.
 */
import type { PrinterStatus } from '@printstream/shared'

export function hasLivePrinterControlConnection(
  status: Pick<PrinterStatus, 'online'> | undefined,
  clientConnected: boolean
): boolean {
  return clientConnected && status?.online === true
}