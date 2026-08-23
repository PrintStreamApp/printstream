/**
 * API-side mirror of each bridge's on-disk backup status.
 *
 * The bridge owns the backups (scheduler + snapshots on its own disk, see
 * `apps/bridge/src/backup-manager.ts`) and reports status over the session as
 * `bridge.backup.status`; this in-memory map is the API's cached view, used to
 * populate `GET /bridges` and broadcast live over the `bridge.backup` WS event,
 * the same shape as the debug-capture mirror.
 *
 * Status is ephemeral: dropped when the bridge disconnects and re-learned when
 * the bridge re-announces on reconnect, so nothing here needs persisting. A
 * bridge that never reports (pre-backup build, or backups unconfigured) reads
 * as unconfigured.
 */
import type { BridgeBackupStatus } from '@printstream/shared'
import { unconfiguredBridgeBackupStatus } from '@printstream/shared'

const statuses = new Map<string, BridgeBackupStatus>()

export function setBridgeBackupStatus(bridgeId: string, status: BridgeBackupStatus): void {
  statuses.set(bridgeId, status)
}

export function getBridgeBackupStatus(bridgeId: string): BridgeBackupStatus {
  return statuses.get(bridgeId) ?? unconfiguredBridgeBackupStatus
}

export function clearBridgeBackupStatus(bridgeId: string): void {
  statuses.delete(bridgeId)
}
