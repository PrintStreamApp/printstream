/**
 * Seeded auth-local role presets.
 *
 * Viewer, Operator, and Manager act as editable starting points with
 * composable permission bundles instead of a strict ladder. Admin remains
 * fixed to the full permission set so there is always one canonical superuser
 * role available even if the editable defaults are customized.
 */
import {
  AUTH_ACCESS_VIEW_PERMISSION,
  AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION,
  AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION,
  BILLING_MANAGE_PERMISSION,
  CAMERA_VIEW_PERMISSION,
  AUTH_PASSKEYS_EDIT_PERMISSION,
  AUTH_PASSKEYS_REVOKE_PERMISSION,
  AUTH_PASSKEYS_VIEW_PERMISSION,
  AUTH_PROVIDERS_MANAGE_PERMISSION,
  AUTH_ROLES_ASSIGN_PERMISSION,
  AUTH_ROLES_CREATE_PERMISSION,
  AUTH_ROLES_DELETE_PERMISSION,
  AUTH_ROLES_EDIT_PERMISSION,
  AUTH_ROLES_VIEW_PERMISSION,
  AUTH_SERVICE_ACCOUNTS_ASSIGN_ROLES_PERMISSION,
  AUTH_SERVICE_ACCOUNTS_CREATE_PERMISSION,
  AUTH_SERVICE_ACCOUNTS_EDIT_PERMISSION,
  AUTH_SERVICE_ACCOUNTS_REVOKE_PERMISSION,
  AUTH_SERVICE_ACCOUNTS_VIEW_PERMISSION,
  AUTH_SESSION_POLICY_MANAGE_PERMISSION,
  AUTH_USERS_ASSIGN_ROLES_PERMISSION,
  AUTH_USERS_CREATE_PERMISSION,
  AUTH_USERS_DELETE_PERMISSION,
  AUTH_USERS_DISABLE_SIGN_IN_PERMISSION,
  AUTH_USERS_EDIT_PERMISSION,
  AUTH_USERS_REVOKE_SESSIONS_PERMISSION,
  AUTH_USERS_VIEW_PERMISSION,
  AUTH_USERS_VIEW_SESSIONS_PERMISSION,
  JOBS_DELETE_PERMISSION,
  JOBS_VIEW_PERMISSION,
  LIBRARY_DOWNLOAD_PERMISSION,
  LIBRARY_MANAGE_PERMISSION,
  PLUGINS_MANAGE_PERMISSION,
  LIBRARY_UPLOAD_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  PRINTER_STORAGE_DOWNLOAD_PERMISSION,
  PRINTER_STORAGE_VIEW_PERMISSION,
  PRINTERS_MANAGE_PERMISSION,
  PRINTERS_CONTROL_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION,
  TENANTS_MANAGE_PERMISSION,
  PRINTERS_CLEAR_PLATE_PERMISSION,
  SETTINGS_MANAGE_PERMISSION,
  TENANTS_DISABLE_PERMISSION,
  filterPermissionsForTenantContext,
  permissionValues,
  type Permission
} from '@printstream/shared'
import { badRequest } from './http-error.js'
import { getCurrentTenant } from './tenant-context.js'

interface BuiltInAuthGroupSeed {
  id?: string
  tenantId?: string | null
  key: string
  name: string
  description: string
  permissions: Permission[]
  isEditable: boolean
  isRemovable: boolean
}

type PreviousBuiltInAuthGroupSnapshot = Pick<BuiltInAuthGroupSeed, 'name' | 'description' | 'permissions'>

export interface BuiltInAuthGroupClient {
  authGroup: {
    findUnique(args: unknown): Promise<{
      id: string
      key: string | null
      name: string
      description: string | null
      permissions: string[]
      isSystem: boolean
      isEditable: boolean
      isRemovable: boolean
    } | null>
    findFirst(args: unknown): Promise<{
      id: string
      key: string | null
      name: string
      description: string | null
      permissions: string[]
      isSystem: boolean
      isEditable: boolean
      isRemovable: boolean
    } | null>
    create(args: unknown): Promise<unknown>
    update(args: unknown): Promise<unknown>
  }
}

export const PLATFORM_ADMIN_GROUP_KEY = 'admin'

const authPasskeyManagementPermissions = [
  AUTH_PASSKEYS_EDIT_PERMISSION,
  AUTH_PASSKEYS_REVOKE_PERMISSION,
  AUTH_PASSKEYS_VIEW_PERMISSION
] satisfies Permission[]

const authRoleManagementPermissions = [
  AUTH_ROLES_ASSIGN_PERMISSION,
  AUTH_ROLES_CREATE_PERMISSION,
  AUTH_ROLES_DELETE_PERMISSION,
  AUTH_ROLES_EDIT_PERMISSION,
  AUTH_ROLES_VIEW_PERMISSION
] satisfies Permission[]

const authServiceAccountManagementPermissions = [
  AUTH_SERVICE_ACCOUNTS_ASSIGN_ROLES_PERMISSION,
  AUTH_SERVICE_ACCOUNTS_CREATE_PERMISSION,
  AUTH_SERVICE_ACCOUNTS_EDIT_PERMISSION,
  AUTH_SERVICE_ACCOUNTS_REVOKE_PERMISSION,
  AUTH_SERVICE_ACCOUNTS_VIEW_PERMISSION
] satisfies Permission[]

const authUserManagementPermissions = [
  AUTH_USERS_ASSIGN_ROLES_PERMISSION,
  AUTH_USERS_CREATE_PERMISSION,
  AUTH_USERS_DELETE_PERMISSION,
  AUTH_USERS_DISABLE_SIGN_IN_PERMISSION,
  AUTH_USERS_EDIT_PERMISSION,
  AUTH_USERS_REVOKE_SESSIONS_PERMISSION,
  AUTH_USERS_VIEW_PERMISSION,
  AUTH_USERS_VIEW_SESSIONS_PERMISSION
] satisfies Permission[]

const platformAuthAdminPermissions = [
  AUTH_ACCESS_VIEW_PERMISSION,
  ...authPasskeyManagementPermissions,
  AUTH_PROVIDERS_MANAGE_PERMISSION,
  ...authRoleManagementPermissions,
  ...authServiceAccountManagementPermissions,
  AUTH_SESSION_POLICY_MANAGE_PERMISSION,
  ...authUserManagementPermissions
] satisfies Permission[]

const platformAuthManagerPermissions = [
  AUTH_ACCESS_VIEW_PERMISSION,
  ...authPasskeyManagementPermissions,
  ...authRoleManagementPermissions,
  ...authUserManagementPermissions
] satisfies Permission[]

const tenantAuthManagementPermissions = [
  AUTH_ACCESS_VIEW_PERMISSION,
  AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION,
  ...authPasskeyManagementPermissions,
  ...authRoleManagementPermissions,
  ...authServiceAccountManagementPermissions,
  ...authUserManagementPermissions
] satisfies Permission[]

const tenantViewerPermissions = [
  PRINTERS_VIEW_PERMISSION,
  CAMERA_VIEW_PERMISSION,
  JOBS_VIEW_PERMISSION
] satisfies Permission[]

const tenantOperatorPermissions = [
  ...tenantViewerPermissions,
  PRINTERS_CONTROL_PERMISSION,
  PRINTERS_CLEAR_PLATE_PERMISSION,
  PRINTER_STORAGE_VIEW_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION
] satisfies Permission[]

const tenantManagerOperationsPermissions = [
  PRINTERS_VIEW_PERMISSION,
  CAMERA_VIEW_PERMISSION,
  JOBS_DELETE_PERMISSION,
  JOBS_VIEW_PERMISSION,
  PRINTERS_CONTROL_PERMISSION,
  PRINTERS_CLEAR_PLATE_PERMISSION,
  PRINTERS_MANAGE_PERMISSION,
  PRINTER_STORAGE_VIEW_PERMISSION,
  PRINTER_STORAGE_DOWNLOAD_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  LIBRARY_DOWNLOAD_PERMISSION,
  LIBRARY_UPLOAD_PERMISSION,
  LIBRARY_MANAGE_PERMISSION,
  PRINTS_DISPATCH_PERMISSION
] satisfies Permission[]

export const builtInPlatformAuthGroupSeeds: BuiltInAuthGroupSeed[] = [
  {
    id: 'platform-group-admin',
    tenantId: null,
    key: PLATFORM_ADMIN_GROUP_KEY,
    name: 'Admin',
    description: 'Full platform access including billing, settings, plugins, tenants, auth management, and support-access bypass.',
    permissions: [
      AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION,
      ...platformAuthAdminPermissions,
      BILLING_MANAGE_PERMISSION,
      PLUGINS_MANAGE_PERMISSION,
      SETTINGS_MANAGE_PERMISSION,
      TENANTS_DISABLE_PERMISSION,
      TENANTS_MANAGE_PERMISSION
    ],
    isEditable: false,
    isRemovable: false
  },
  {
    id: 'platform-group-manager',
    tenantId: null,
    key: 'platform_manager',
    name: 'Manager',
    description: 'Lead support users and manage customer workspaces without overriding workspace support-access policy.',
    permissions: [...platformAuthManagerPermissions, TENANTS_DISABLE_PERMISSION, TENANTS_MANAGE_PERMISSION],
    isEditable: false,
    isRemovable: false
  },
  {
    id: 'platform-group-support',
    tenantId: null,
    key: 'platform_support',
    name: 'Support',
    description: 'Help customers inside workspaces that allow support access, using the workspace support-access policy.',
    permissions: [],
    isEditable: false,
    isRemovable: false
  }
]

export const builtInAuthGroupSeeds: BuiltInAuthGroupSeed[] = [
  {
    key: 'admin',
    name: 'Admin',
    description: 'Full access to all current permissions.',
    permissions: filterPermissionsForTenantContext(permissionValues.filter((permission) => permission !== TENANTS_MANAGE_PERMISSION)),
    isEditable: false,
    isRemovable: false
  },
  {
    key: 'technician',
    name: 'Manager',
    description: 'Coordinate day-to-day operations and tenant auth management, including print dispatch, plate clearing, printer management, storage downloads, library management, workspace access control, user management, and service accounts.',
    permissions: [
      ...tenantAuthManagementPermissions,
      ...tenantManagerOperationsPermissions
    ],
    isEditable: true,
    isRemovable: false
  },
  {
    key: 'operator',
    name: 'Operator',
    description: 'Run day-to-day print operations, including library browsing, print dispatch, plate clearing, and live printer control.',
    permissions: tenantOperatorPermissions,
    isEditable: true,
    isRemovable: false
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only visibility into printers, camera feeds, and jobs.',
    permissions: tenantViewerPermissions,
    isEditable: true,
    isRemovable: false
  }
]

// Previous built-in snapshots are kept only so unchanged seeded roles can
// receive bounded upgrades when their shipped defaults evolve.
const previousBuiltInAuthGroupSnapshots: Partial<Record<string, PreviousBuiltInAuthGroupSnapshot[]>> = {
  viewer: [{
    name: 'Viewer',
    description: 'Read-only visibility into printers, camera feeds, and jobs.',
    permissions: [PRINTERS_VIEW_PERMISSION, CAMERA_VIEW_PERMISSION, JOBS_VIEW_PERMISSION]
  }],
  operator: [{
    name: 'Operator',
    description: 'Viewer access plus library browsing, print dispatch, and read-only printer storage browsing.',
    permissions: [
      PRINTERS_VIEW_PERMISSION,
      CAMERA_VIEW_PERMISSION,
      JOBS_VIEW_PERMISSION,
      PRINTERS_CLEAR_PLATE_PERMISSION,
      PRINTER_STORAGE_VIEW_PERMISSION,
      LIBRARY_VIEW_PERMISSION,
      PRINTS_DISPATCH_PERMISSION
    ]
  }],
  technician: [
    {
      name: 'Technician',
      description: 'Maintain printers and shared files, including printer configuration, storage downloads, and library management.',
      permissions: [
        PRINTERS_VIEW_PERMISSION,
        CAMERA_VIEW_PERMISSION,
        JOBS_VIEW_PERMISSION,
        PRINTERS_CONTROL_PERMISSION,
        PRINTERS_MANAGE_PERMISSION,
        PRINTER_STORAGE_VIEW_PERMISSION,
        PRINTER_STORAGE_DOWNLOAD_PERMISSION,
        LIBRARY_VIEW_PERMISSION,
        LIBRARY_DOWNLOAD_PERMISSION,
        LIBRARY_UPLOAD_PERMISSION,
        LIBRARY_MANAGE_PERMISSION,
      ]
    },
    {
      name: 'Manager',
      description: 'Coordinate day-to-day operations, including print dispatch, plate clearing, printer management, storage downloads, and library management.',
      permissions: [
        PRINTERS_VIEW_PERMISSION,
        CAMERA_VIEW_PERMISSION,
        JOBS_VIEW_PERMISSION,
        PRINTERS_CONTROL_PERMISSION,
        PRINTERS_CLEAR_PLATE_PERMISSION,
        PRINTERS_MANAGE_PERMISSION,
        PRINTER_STORAGE_VIEW_PERMISSION,
        PRINTER_STORAGE_DOWNLOAD_PERMISSION,
        LIBRARY_VIEW_PERMISSION,
        LIBRARY_DOWNLOAD_PERMISSION,
        LIBRARY_UPLOAD_PERMISSION,
        LIBRARY_MANAGE_PERMISSION,
        PRINTS_DISPATCH_PERMISSION,
      ]
    }
  ]
}

export async function ensureBuiltInAuthGroups(prisma: BuiltInAuthGroupClient, tenantId = getCurrentTenant()?.id): Promise<void> {
  if (!tenantId) {
    throw badRequest('Tenant context is required to initialize auth groups.')
  }

  for (const seed of builtInAuthGroupSeeds) {
    const existing = await prisma.authGroup.findUnique({
      where: {
        tenantId_key: {
          tenantId,
          key: seed.key
        }
      }
    })

    if (!existing) {
      await prisma.authGroup.create({
        data: {
          tenantId,
          key: seed.key,
          name: seed.name,
          description: seed.description,
          permissions: seed.permissions,
          isSystem: true,
          isEditable: seed.isEditable,
          isRemovable: seed.isRemovable
        }
      })
      continue
    }

    if (seed.key === 'admin') {
      await prisma.authGroup.update({
        where: { id: existing.id },
        data: {
          name: seed.name,
          description: seed.description,
          permissions: seed.permissions,
          isSystem: true,
          isEditable: false,
          isRemovable: false
        }
      })
      continue
    }

    if (shouldUpgradePreviousBuiltInAuthGroup(existing, seed)) {
      await prisma.authGroup.update({
        where: { id: existing.id },
        data: {
          name: seed.name,
          description: seed.description,
          permissions: seed.permissions,
          isSystem: true,
          isEditable: seed.isEditable,
          isRemovable: seed.isRemovable
        }
      })
      continue
    }

    if (!existing.isSystem || existing.isRemovable !== seed.isRemovable || existing.isEditable !== seed.isEditable) {
      await prisma.authGroup.update({
        where: { id: existing.id },
        data: {
          isSystem: true,
          isEditable: seed.isEditable,
          isRemovable: seed.isRemovable
        }
      })
    }
  }
}

export async function ensureBuiltInPlatformAuthGroups(prisma: BuiltInAuthGroupClient): Promise<void> {
  for (const seed of builtInPlatformAuthGroupSeeds) {
    const existing = await prisma.authGroup.findFirst({
      where: {
        tenantId: null,
        key: seed.key
      }
    })

    if (!existing) {
      await prisma.authGroup.create({
        data: {
          id: seed.id,
          tenantId: null,
          key: seed.key,
          name: seed.name,
          description: seed.description,
          permissions: seed.permissions,
          isSystem: true,
          isEditable: seed.isEditable,
          isRemovable: seed.isRemovable
        }
      })
      continue
    }

    await prisma.authGroup.update({
      where: { id: existing.id },
      data: {
        name: seed.name,
        description: seed.description,
        permissions: seed.permissions,
        isSystem: true,
        isEditable: seed.isEditable,
        isRemovable: seed.isRemovable
      }
    })
  }
}

function shouldUpgradePreviousBuiltInAuthGroup(
  existing: {
    key: string | null
    name: string
    description: string | null
    permissions: string[]
    isSystem: boolean
    isEditable: boolean
    isRemovable: boolean
  },
  seed: BuiltInAuthGroupSeed
): boolean {
  const previousSnapshots = existing.key ? previousBuiltInAuthGroupSnapshots[existing.key] : undefined
  if (!previousSnapshots || previousSnapshots.length === 0) return false

  return previousSnapshots.some((previous) => (
    existing.isSystem
      && existing.isEditable === seed.isEditable
      && existing.isRemovable === seed.isRemovable
      && existing.name === previous.name
      && existing.description === previous.description
      && hasSamePermissions(existing.permissions, previous.permissions)
  ))
}

function hasSamePermissions(left: string[], right: Permission[]): boolean {
  return left.length === right.length && left.every((permission, index) => permission === right[index])
}