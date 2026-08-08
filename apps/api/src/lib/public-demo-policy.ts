/**
 * Workspace-scoped public demo access policy.
 *
 * A public demo workspace is not a normal auth-disabled workspace. Anonymous visitors
 * get an explicit read-mostly permission set so route authorization keeps using
 * permissions instead of falling through the auth-disabled workspace bypass.
 */
import {
  AUTH_ACCESS_VIEW_PERMISSION,
  AUTH_ROLES_VIEW_PERMISSION,
  CAMERA_VIEW_PERMISSION,
  JOBS_VIEW_PERMISSION,
  LIBRARY_DOWNLOAD_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  PRINTER_STORAGE_DOWNLOAD_PERMISSION,
  PRINTER_STORAGE_VIEW_PERMISSION,
  PUBLIC_DEMO_WORKSPACE_SLUG,
  type Permission
} from '@printstream/shared'
import type { RequestAuthContext } from './auth-context.js'
import type { RequestWorkspaceSummary } from './workspace-context.js'

export const PUBLIC_DEMO_GUEST_PERMISSIONS: readonly Permission[] = [
  AUTH_ACCESS_VIEW_PERMISSION,
  AUTH_ROLES_VIEW_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  PRINTER_STORAGE_VIEW_PERMISSION,
  PRINTER_STORAGE_DOWNLOAD_PERMISSION,
  CAMERA_VIEW_PERMISSION,
  JOBS_VIEW_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  LIBRARY_DOWNLOAD_PERMISSION
]

export function isPublicDemoWorkspace(workspace: RequestWorkspaceSummary | null): boolean {
  return workspace?.slug === PUBLIC_DEMO_WORKSPACE_SLUG
}

export function applyPublicDemoGuestAuth(
  auth: RequestAuthContext,
  workspace: RequestWorkspaceSummary | null
): RequestAuthContext {
  if (auth.actor.type !== 'anonymous' || !isPublicDemoWorkspace(workspace)) {
    return auth
  }

  return {
    ...auth,
    publicDemoGuest: true,
    permissions: [...PUBLIC_DEMO_GUEST_PERMISSIONS],
    runtimePolicy: {
      ...auth.runtimePolicy,
      demoMode: true
    }
  }
}
