/**
 * API-side mirror of each bridge's debug-capture status.
 *
 * The bridge owns the capture (start/stop/buffer) and reports its status over
 * the session as `bridge.debug.capture.status`; this in-memory map is the API's
 * cached view, used to populate `GET /bridges` (so the banner and settings
 * hydrate on load) and to answer "is anything recording" without a round-trip.
 * Live changes are also broadcast over the `bridge.debug.capture` WS event.
 *
 * Status is ephemeral: it is dropped when the bridge disconnects and re-learned
 * when the bridge re-announces on reconnect, so nothing here needs persisting.
 */
import type { BridgeDebugCaptureStatus } from '@printstream/shared'
import { inactiveBridgeDebugCaptureStatus } from '@printstream/shared'

const statuses = new Map<string, BridgeDebugCaptureStatus>()

export function setBridgeDebugCaptureStatus(bridgeId: string, status: BridgeDebugCaptureStatus): void {
  statuses.set(bridgeId, status)
}

export function getBridgeDebugCaptureStatus(bridgeId: string): BridgeDebugCaptureStatus {
  return statuses.get(bridgeId) ?? inactiveBridgeDebugCaptureStatus
}

export function clearBridgeDebugCaptureStatus(bridgeId: string): void {
  statuses.delete(bridgeId)
}
