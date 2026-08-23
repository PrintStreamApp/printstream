/**
 * Seeded auth-local role presets.
 *
 * Viewer, Operator, and Manager act as editable starting points with
 * composable permission bundles instead of a strict ladder. Admin remains
 * fixed to the full permission set so there is always one canonical superuser
 * role available even if the editable defaults are customized.
 */
import {
  ACCOUNTS_CREATE_PERMISSION,
  ACCOUNTS_PEOPLE_MANAGE_PERMISSION,
  ACCOUNTS_VIEW_PERMISSION,
  LICENSES_ISSUE_PERMISSION,
  LICENSES_REVEAL_KEY_PERMISSION,
  LICENSES_REVOKE_PERMISSION,
  LICENSES_VIEW_PERMISSION,
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
  WORKSPACES_MANAGE_PERMISSION,
  PRINTERS_CLEAR_PLATE_PERMISSION,
  SETTINGS_MANAGE_PERMISSION,
  WORKSPACES_DISABLE_PERMISSION,
  filterPermissionsForWorkspaceContext,
  permissionValues,
  type Permission
} from '@printstream/shared'
import { badRequest } from './http-error.js'
import { getCurrentWorkspace } from './workspace-context.js'

interface BuiltInAuthGroupSeed {
  id?: string
  workspaceId?: string | null
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

/**
 * The least-privileged built-in workspace role: read-only visibility.
 *
 * Named because it is what a surface OUTSIDE the workspace grants when it adds
 * someone to one (the customer's People list). Granting nothing left them inside
 * with no permissions and no explanation; granting more than read-only from a
 * billing screen would let whoever pays hand out operational access without the
 * workspace's admin ever seeing it.
 */
export const WORKSPACE_VIEWER_GROUP_KEY = 'viewer'

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

const workspaceAuthManagementPermissions = [
  AUTH_ACCESS_VIEW_PERMISSION,
  AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION,
  ...authPasskeyManagementPermissions,
  ...authRoleManagementPermissions,
  ...authServiceAccountManagementPermissions,
  ...authUserManagementPermissions
] satisfies Permission[]

const workspaceViewerPermissions = [
  PRINTERS_VIEW_PERMISSION,
  CAMERA_VIEW_PERMISSION,
  JOBS_VIEW_PERMISSION
] satisfies Permission[]

const workspaceOperatorPermissions = [
  ...workspaceViewerPermissions,
  PRINTERS_CONTROL_PERMISSION,
  PRINTERS_CLEAR_PLATE_PERMISSION,
  PRINTER_STORAGE_VIEW_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION
] satisfies Permission[]

const workspaceManagerOperationsPermissions = [
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

/**
 * Operator authority over customer accounts and licences, split three ways.
 *
 * Read-only for Support so they can answer "what does this customer have"
 * without being able to change it; the write half sits with Manager, who
 * already provisions customer workspaces. Comping is deliberately NOT here,
 * it rides `billing.manage`, which only Admin holds, because a comp gives away
 * revenue indefinitely and the schema has no expiry on it.
 *
 * Revealing a key is separated from listing licences: the key is a credential,
 * so seeing that a licence exists and reading it are different acts.
 */
const platformAccountReadPermissions = [
  ACCOUNTS_VIEW_PERMISSION,
  LICENSES_VIEW_PERMISSION
] satisfies Permission[]

const platformAccountManagePermissions = [
  ...platformAccountReadPermissions,
  ACCOUNTS_CREATE_PERMISSION,
  ACCOUNTS_PEOPLE_MANAGE_PERMISSION,
  LICENSES_ISSUE_PERMISSION,
  LICENSES_REVEAL_KEY_PERMISSION,
  LICENSES_REVOKE_PERMISSION
] satisfies Permission[]

export const builtInPlatformAuthGroupSeeds: BuiltInAuthGroupSeed[] = [
  {
    id: 'platform-group-admin',
    workspaceId: null,
    key: PLATFORM_ADMIN_GROUP_KEY,
    name: 'Admin',
    description: 'Full platform access including billing, settings, plugins, workspaces, auth management, and support-access bypass.',
    permissions: [
      AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION,
      ...platformAuthAdminPermissions,
      ...platformAccountManagePermissions,
      BILLING_MANAGE_PERMISSION,
      PLUGINS_MANAGE_PERMISSION,
      SETTINGS_MANAGE_PERMISSION,
      WORKSPACES_DISABLE_PERMISSION,
      WORKSPACES_MANAGE_PERMISSION
    ],
    isEditable: false,
    isRemovable: false
  },
  {
    id: 'platform-group-manager',
    workspaceId: null,
    key: 'platform_manager',
    name: 'Manager',
    description: 'Lead support users, manage customer accounts, workspaces and licenses, without overriding workspace support-access policy or comping plans.',
    permissions: [
      ...platformAuthManagerPermissions,
      ...platformAccountManagePermissions,
      WORKSPACES_DISABLE_PERMISSION,
      WORKSPACES_MANAGE_PERMISSION
    ],
    isEditable: false,
    isRemovable: false
  },
  {
    id: 'platform-group-support',
    workspaceId: null,
    key: 'platform_support',
    name: 'Support',
    description: 'Help customers inside workspaces that allow support access, and look up what an account holds without changing it.',
    permissions: [...platformAccountReadPermissions],
    isEditable: false,
    isRemovable: false
  }
]

export const builtInAuthGroupSeeds: BuiltInAuthGroupSeed[] = [
  {
    key: 'admin',
    name: 'Admin',
    description: 'Full access to all current permissions.',
    permissions: filterPermissionsForWorkspaceContext(permissionValues.filter((permission) => permission !== WORKSPACES_MANAGE_PERMISSION)),
    isEditable: false,
    isRemovable: false
  },
  {
    key: 'technician',
    name: 'Manager',
    description: 'Coordinate day-to-day operations and workspace auth management, including print dispatch, plate clearing, printer management, storage downloads, library management, workspace access control, user management, and service accounts.',
    permissions: [
      ...workspaceAuthManagementPermissions,
      ...workspaceManagerOperationsPermissions
    ],
    isEditable: true,
    isRemovable: false
  },
  {
    key: 'operator',
    name: 'Operator',
    description: 'Run day-to-day print operations, including library browsing, print dispatch, plate clearing, and live printer control.',
    permissions: workspaceOperatorPermissions,
    isEditable: true,
    isRemovable: false
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only visibility into printers, camera feeds, and jobs.',
    permissions: workspaceViewerPermissions,
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

export async function ensureBuiltInAuthGroups(prisma: BuiltInAuthGroupClient, workspaceId = getCurrentWorkspace()?.id): Promise<void> {
  if (!workspaceId) {
    throw badRequest('Workspace context is required to initialize auth groups.')
  }

  for (const seed of builtInAuthGroupSeeds) {
    const existing = await prisma.authGroup.findUnique({
      where: {
        workspaceId_key: {
          workspaceId,
          key: seed.key
        }
      }
    })

    if (!existing) {
      await prisma.authGroup.create({
        data: {
          workspaceId,
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
        workspaceId: null,
        key: seed.key
      }
    })

    if (!existing) {
      await prisma.authGroup.create({
        data: {
          id: seed.id,
          workspaceId: null,
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