/**
 * The scope key that namespaces per-workspace client preferences: localStorage
 * keys on the printers dashboard and the printer-views React Query cache key.
 * Derived from the auth bootstrap: the workspace ID (stable across renames,
 * unlike the slug), `platform` for the platform workspace, and `pending` while
 * the bootstrap is still resolving so a preference is never read or written
 * under a scope it does not belong to.
 */
import { useAuthBootstrapQuery } from './authQuery'

export interface WorkspacePreferenceScopeSource {
  workspace?: { id: string } | null
}

export function workspacePreferenceScopeKeyFromBootstrap(bootstrap: WorkspacePreferenceScopeSource | undefined): string {
  return bootstrap ? bootstrap.workspace?.id ?? 'platform' : 'pending'
}

export function useWorkspacePreferenceScopeKey(): string {
  return workspacePreferenceScopeKeyFromBootstrap(useAuthBootstrapQuery().data)
}
