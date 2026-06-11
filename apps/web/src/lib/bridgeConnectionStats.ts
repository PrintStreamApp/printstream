import type { BridgeConnectionStats } from '@printstream/shared'

/**
 * Returns the stable bridge connection stat labels shown in settings.
 */
export function buildBridgeConnectionStatItems(stats: BridgeConnectionStats): string[] {
  return [
    `Connection: ${stats.connected ? 'Connected' : 'Offline'}`,
    `Pending RPCs: ${stats.pendingRpcCount}`,
    `Camera watches: ${stats.activeCameraWatchCount}`,
    `Active transfers: ${stats.activePrinterFtpCount}`
  ]
}