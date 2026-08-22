import type { QueryClient } from '@tanstack/react-query'
import type { BridgeBackupStatus, BridgeDebugCaptureStatus, BridgeListResponse, BridgeSummary } from '@printstream/shared'

type QueryInvalidator = Pick<QueryClient, 'invalidateQueries'>

/** Both bridge-list query caches: the cross-page banner and the settings view. */
const BRIDGE_LIST_QUERY_KEYS = [['bridges'], ['settings-bridges']] as const

export async function invalidateBridgeQueries(queryClient: QueryInvalidator): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['auth-bootstrap'] }),
    queryClient.invalidateQueries({ queryKey: ['bridges'] }),
    queryClient.invalidateQueries({ queryKey: ['settings-bridges'] }),
    queryClient.invalidateQueries({ queryKey: ['library-browse'] })
  ])
}

/**
 * Patch one bridge's entry in both cached bridge lists in place, so live WS
 * status events update the UI without an HTTP refetch. Untouched bridges keep
 * their identity so React Query's structural sharing skips their re-renders.
 */
function patchBridgeInLists(
  queryClient: Pick<QueryClient, 'setQueryData'>,
  bridgeId: string,
  patch: (bridge: BridgeSummary) => BridgeSummary
): void {
  for (const key of BRIDGE_LIST_QUERY_KEYS) {
    queryClient.setQueryData<BridgeListResponse>(key, (existing) => {
      if (!existing) return existing
      let changed = false
      const bridges = existing.bridges.map((bridge) => {
        if (bridge.id !== bridgeId) return bridge
        changed = true
        return patch(bridge)
      })
      return changed ? { ...existing, bridges } : existing
    })
  }
}

/**
 * Reflect a live `bridge.debug.capture` WS event (including the frame counter)
 * into the capture banner and settings.
 */
export function applyBridgeDebugCaptureStatus(
  queryClient: Pick<QueryClient, 'setQueryData'>,
  bridgeId: string,
  status: BridgeDebugCaptureStatus
): void {
  patchBridgeInLists(queryClient, bridgeId, (bridge) => ({ ...bridge, debugCapture: status }))
}

/**
 * Reflect a live `bridge.backup` WS event (a backup starting, finishing, or
 * failing) into the bridge settings, where a backup can run for minutes.
 *
 * Also stales the snapshot LIST, because a finished backup adds a row to it and the
 * "View backups" dialog is exactly what someone has open while waiting: its chip went
 * running -> done while the table below never gained the new snapshot. That dialog
 * carries a manual Refresh button, which is the shape of a workaround for this.
 */
export function applyBridgeBackupStatus(
  queryClient: Pick<QueryClient, 'setQueryData' | 'invalidateQueries'>,
  bridgeId: string,
  status: BridgeBackupStatus
): void {
  patchBridgeInLists(queryClient, bridgeId, (bridge) => ({ ...bridge, backup: status }))
  if (!status.running) {
    void queryClient.invalidateQueries({ queryKey: ['bridge-backups', bridgeId] })
  }
}