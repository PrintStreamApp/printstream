/**
 * WebSocket invalidation helpers for effective-auth changes.
 */
import { getCurrentTenant } from './tenant-context.js'
import { wsBroadcaster } from './ws-server.js'

export function broadcastAuthChangedForUsers(userIds: readonly string[], tenantId?: string | null): void {
  if (userIds.length === 0) return
  const currentTenantId = tenantId !== undefined ? tenantId : getCurrentTenant()?.id
  wsBroadcaster.notifyAuthChanged({
    userIds,
    ...(currentTenantId !== undefined ? { tenantId: currentTenantId } : {})
  })
}

export function broadcastAuthChangedForTenant(tenantId: string | null | undefined = getCurrentTenant()?.id ?? null): void {
  wsBroadcaster.notifyAuthChanged({ tenantId })
}
