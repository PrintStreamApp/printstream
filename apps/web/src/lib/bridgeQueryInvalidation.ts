import type { QueryClient } from '@tanstack/react-query'
import type { BridgeDebugCaptureStatus, BridgeListResponse } from '@printstream/shared'

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
 * Patch a bridge's debug-capture status into the cached bridge lists in place,
 * so the capture banner and settings reflect live `bridge.debug.capture` WS
 * events (including the frame counter) without an HTTP refetch.
 */
export function applyBridgeDebugCaptureStatus(
  queryClient: Pick<QueryClient, 'setQueryData'>,
  bridgeId: string,
  status: BridgeDebugCaptureStatus
): void {
  for (const key of BRIDGE_LIST_QUERY_KEYS) {
    queryClient.setQueryData<BridgeListResponse>(key, (existing) => {
      if (!existing) return existing
      let changed = false
      const bridges = existing.bridges.map((bridge) => {
        if (bridge.id !== bridgeId) return bridge
        changed = true
        return { ...bridge, debugCapture: status }
      })
      return changed ? { ...existing, bridges } : existing
    })
  }
}