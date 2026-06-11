/**
 * Tenant-scoped public demo access policy.
 *
 * A public demo tenant is not a normal auth-disabled tenant. Anonymous visitors
 * get an explicit read-mostly permission set so route authorization keeps using
 * permissions instead of falling through the auth-disabled tenant bypass.
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
  PUBLIC_DEMO_TENANT_SLUG,
  type Permission
} from '@printstream/shared'
import type { RequestAuthContext } from './auth-context.js'
import type { RequestTenantSummary } from './tenant-context.js'

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

export function isPublicDemoTenant(tenant: RequestTenantSummary | null): boolean {
  return tenant?.slug === PUBLIC_DEMO_TENANT_SLUG
}

export function applyPublicDemoGuestAuth(
  auth: RequestAuthContext,
  tenant: RequestTenantSummary | null
): RequestAuthContext {
  if (auth.actor.type !== 'anonymous' || !isPublicDemoTenant(tenant)) {
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
