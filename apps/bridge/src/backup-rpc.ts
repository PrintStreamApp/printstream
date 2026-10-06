/**
 * Validated backup RPC commands for the long-lived bridge session.
 *
 * A manual backup returns its current status immediately; completion travels
 * through the separate `bridge.backup.status` push because it can outlive an RPC.
 */
import {
  bridgeBackupListParamsSchema,
  bridgeBackupListResultSchema,
  bridgeBackupRunParamsSchema,
  bridgeBackupStatusResultSchema
} from '@printstream/shared'
import { listBridgeBackupSnapshots, startBridgeBackup } from './backup-manager.js'

type BackupRpcResult = { handled: true; result: unknown } | { handled: false }

/** Return a schema-checked result, or leave a different method to the runtime. */
export async function handleBackupRpc(method: string, params: unknown): Promise<BackupRpcResult> {
  switch (method) {
    case 'bridge.backup.run': {
      bridgeBackupRunParamsSchema.parse(params)
      return { handled: true, result: bridgeBackupStatusResultSchema.parse(startBridgeBackup('manual')) }
    }
    case 'bridge.backup.list': {
      bridgeBackupListParamsSchema.parse(params)
      const snapshots = await listBridgeBackupSnapshots()
      return { handled: true, result: bridgeBackupListResultSchema.parse({ snapshots }) }
    }
    default:
      return { handled: false }
  }
}
