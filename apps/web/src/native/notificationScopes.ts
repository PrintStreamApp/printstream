/** Personal notification destinations for one authenticated origin, never support-only workspaces. */
import { nativeNotificationAccount, type AuthBootstrap } from '@printstream/shared'

export interface NotificationScope {
  id: string
  name: string
  bootstrap: AuthBootstrap
}

/** Explicit scope headers let enrollment cover memberships without changing the active workspace. */
export function notificationScopes(bootstrap: AuthBootstrap | undefined): NotificationScope[] {
  if (!bootstrap || !nativeNotificationAccount(bootstrap)) return []
  if (bootstrap.actor.type === 'anonymous' && bootstrap.workspace) {
    return [{ id: bootstrap.workspace.id, name: bootstrap.workspace.name, bootstrap }]
  }
  const scopes: NotificationScope[] = bootstrap.memberWorkspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    bootstrap: { ...bootstrap, workspace }
  }))
  if (bootstrap.actor.isPlatformUser && !bootstrap.runtimePolicy.selfHosted) {
    scopes.push({ id: 'platform', name: 'Administration', bootstrap: { ...bootstrap, workspace: null } })
  }
  return scopes
}

/** Route changes do not create a second offer; changed memberships do get a fresh choice. */
export function notificationSelectionKey(bootstrap: AuthBootstrap | undefined): string | null {
  const scopes = notificationScopes(bootstrap)
  if (!scopes.length) return null
  return `printstream.mobile-notifications.v2:${encodeURIComponent(nativeNotificationAccount(bootstrap)!)}:${scopes.map(({ id }) => encodeURIComponent(id)).sort().join(',')}`
}
