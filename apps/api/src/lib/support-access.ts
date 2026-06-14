/**
 * Workspace support-access policy helpers.
 *
 * Workspace admins can allow ordinary support users into their workspace and
 * choose the workspace actions those users may perform. Platform users with
 * the bypass permission skip that workspace policy and receive full workspace
 * authority while helping.
 */
import {
  AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION,
  filterPermissionsForTenantContext,
  permissionSchema,
  permissionValues,
  type Permission
} from '@printstream/shared'
import { rootPrisma } from './prisma.js'
import { filterEnabledTenants } from './tenant-availability.js'
import { scopeSettingKeyForTenant } from './tenant-settings.js'

export const SUPPORT_ACCESS_ENABLED_SETTING_KEY = 'auth:supportAccessEnabled'
export const SUPPORT_ACCESS_PERMISSIONS_SETTING_KEY = 'auth:supportAccessPermissions'

const allWorkspacePermissions = filterPermissionsForTenantContext([...permissionValues])

export function hasSupportAccessBypass(permissions: readonly Permission[]): boolean {
  return permissions.includes(AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION)
}

export function listAllWorkspaceSupportPermissions(): Permission[] {
  return [...allWorkspacePermissions]
}

export async function listSupportAccessibleWorkspaces(input: {
  bypassSupportAccess: boolean
  authEnabled?: boolean
  tenantId?: string | null
}): Promise<Array<{
  id: string
  slug: string
  name: string
  description?: string | null
}>> {
  const tenants = await rootPrisma.tenant.findMany({
    where: input.tenantId ? { id: input.tenantId } : undefined,
    select: {
      id: true,
      slug: true,
      name: true,
      description: true
    }
  })
  const enabledTenants = await filterEnabledTenants({ tenants })

  if (enabledTenants.length === 0 || input.bypassSupportAccess || input.authEnabled === false) {
    return enabledTenants
  }

  const disabledKeys = enabledTenants.map((tenant) => scopeSettingKeyForTenant(tenant.id, SUPPORT_ACCESS_ENABLED_SETTING_KEY))
  const disabledRows = await rootPrisma.setting.findMany({
    where: {
      key: { in: disabledKeys },
      value: 'false'
    },
    select: { key: true }
  })
  const disabledKeySet = new Set(disabledRows.map((row) => row.key))

  return enabledTenants.filter((tenant) => !disabledKeySet.has(scopeSettingKeyForTenant(tenant.id, SUPPORT_ACCESS_ENABLED_SETTING_KEY)))
}

export async function isSupportAccessAllowed(input: {
  tenantId: string
  bypassSupportAccess: boolean
  authEnabled?: boolean
}): Promise<boolean> {
  const tenants = await listSupportAccessibleWorkspaces(input)
  return tenants.length > 0
}

export async function readSupportAccessPermissions(input: {
  tenantId: string
  bypassSupportAccess: boolean
}): Promise<Permission[]> {
  if (input.bypassSupportAccess) {
    return listAllWorkspaceSupportPermissions()
  }

  const row = await rootPrisma.setting.findUnique({
    where: {
      key: scopeSettingKeyForTenant(input.tenantId, SUPPORT_ACCESS_PERMISSIONS_SETTING_KEY)
    },
    select: { value: true }
  })

  if (!row) {
    return listAllWorkspaceSupportPermissions()
  }

  return parseSupportAccessPermissions(row.value)
}

export function serializeSupportAccessPermissions(permissions: readonly Permission[]): string {
  return JSON.stringify(filterPermissionsForTenantContext([...permissions]))
}

function parseSupportAccessPermissions(value: string): Permission[] {
  try {
    const parsed = JSON.parse(value) as unknown
    const permissions = permissionSchema.array().parse(parsed)
    return filterPermissionsForTenantContext(permissions)
  } catch {
    return listAllWorkspaceSupportPermissions()
  }
}