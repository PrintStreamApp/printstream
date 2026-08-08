/**
 * WebSocket invalidation helpers for effective-auth changes.
 */
import { getCurrentWorkspace } from './workspace-context.js'
import { wsBroadcaster } from './ws-server.js'

export function broadcastAuthChangedForUsers(userIds: readonly string[], workspaceId?: string | null): void {
  if (userIds.length === 0) return
  const currentWorkspaceId = workspaceId !== undefined ? workspaceId : getCurrentWorkspace()?.id
  wsBroadcaster.notifyAuthChanged({
    userIds,
    ...(currentWorkspaceId !== undefined ? { workspaceId: currentWorkspaceId } : {})
  })
}

export function broadcastAuthChangedForWorkspace(workspaceId: string | null | undefined = getCurrentWorkspace()?.id ?? null): void {
  wsBroadcaster.notifyAuthChanged({ workspaceId })
}
