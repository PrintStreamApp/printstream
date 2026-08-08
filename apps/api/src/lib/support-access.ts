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
  filterPermissionsForWorkspaceContext,
  permissionSchema,
  permissionValues,
  type Permission
} from '@printstream/shared'
import { rootPrisma } from './prisma.js'
import { filterEnabledWorkspaces } from './workspace-availability.js'
import { scopeSettingKeyForWorkspace } from './workspace-settings.js'
import { visibleWorkspacesWhere } from './workspace-visibility.js'

export const SUPPORT_ACCESS_ENABLED_SETTING_KEY = 'auth:supportAccessEnabled'
export const SUPPORT_ACCESS_PERMISSIONS_SETTING_KEY = 'auth:supportAccessPermissions'

const allWorkspacePermissions = filterPermissionsForWorkspaceContext([...permissionValues])

export function hasSupportAccessBypass(permissions: readonly Permission[]): boolean {
  return permissions.includes(AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION)
}

export function listAllWorkspaceSupportPermissions(): Permission[] {
  return [...allWorkspacePermissions]
}

export async function listSupportAccessibleWorkspaces(input: {
  bypassSupportAccess: boolean
  authEnabled?: boolean
  workspaceId?: string | null
}): Promise<Array<{
  id: string
  slug: string
  name: string
  description?: string | null
}>> {
  const workspaces = await rootPrisma.workspace.findMany({
    where: visibleWorkspacesWhere(input.workspaceId ? { id: input.workspaceId } : {}),
    select: {
      id: true,
      slug: true,
      name: true,
      description: true
    }
  })
  const enabledWorkspaces = await filterEnabledWorkspaces({ workspaces })

  if (enabledWorkspaces.length === 0 || input.bypassSupportAccess || input.authEnabled === false) {
    return enabledWorkspaces
  }

  const disabledKeys = enabledWorkspaces.map((workspace) => scopeSettingKeyForWorkspace(workspace.id, SUPPORT_ACCESS_ENABLED_SETTING_KEY))
  const disabledRows = await rootPrisma.setting.findMany({
    where: {
      key: { in: disabledKeys },
      value: 'false'
    },
    select: { key: true }
  })
  const disabledKeySet = new Set(disabledRows.map((row) => row.key))

  return enabledWorkspaces.filter((workspace) => !disabledKeySet.has(scopeSettingKeyForWorkspace(workspace.id, SUPPORT_ACCESS_ENABLED_SETTING_KEY)))
}

export async function isSupportAccessAllowed(input: {
  workspaceId: string
  bypassSupportAccess: boolean
  authEnabled?: boolean
}): Promise<boolean> {
  const workspaces = await listSupportAccessibleWorkspaces(input)
  return workspaces.length > 0
}

export async function readSupportAccessPermissions(input: {
  workspaceId: string
  bypassSupportAccess: boolean
}): Promise<Permission[]> {
  if (input.bypassSupportAccess) {
    return listAllWorkspaceSupportPermissions()
  }

  const row = await rootPrisma.setting.findUnique({
    where: {
      key: scopeSettingKeyForWorkspace(input.workspaceId, SUPPORT_ACCESS_PERMISSIONS_SETTING_KEY)
    },
    select: { value: true }
  })

  if (!row) {
    return listAllWorkspaceSupportPermissions()
  }

  return parseSupportAccessPermissions(row.value)
}

export function serializeSupportAccessPermissions(permissions: readonly Permission[]): string {
  return JSON.stringify(filterPermissionsForWorkspaceContext([...permissions]))
}

function parseSupportAccessPermissions(value: string): Permission[] {
  try {
    const parsed = JSON.parse(value) as unknown
    const permissions = permissionSchema.array().parse(parsed)
    return filterPermissionsForWorkspaceContext(permissions)
  } catch {
    return listAllWorkspaceSupportPermissions()
  }
}