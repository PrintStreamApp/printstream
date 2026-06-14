import { z } from 'zod'

export const permissionValues = [
  'auth.access.view',
  'auth.bypassSupportAccess',
  'auth.manageSupportAccess',
  'auth.passkeys.edit',
  'auth.passkeys.revoke',
  'auth.passkeys.view',
  'auth.providers.manage',
  'auth.roles.assign',
  'auth.roles.create',
  'auth.roles.delete',
  'auth.roles.edit',
  'auth.roles.view',
  'auth.serviceAccounts.assignRoles',
  'auth.serviceAccounts.create',
  'auth.serviceAccounts.edit',
  'auth.serviceAccounts.revoke',
  'auth.serviceAccounts.view',
  'auth.sessionPolicy.manage',
  'auth.users.assignRoles',
  // Retained for stored permission compatibility. It is no longer exposed or honored for managed-user email changes.
  'auth.users.changeEmail',
  'auth.users.create',
  'auth.users.delete',
  'auth.users.disableSignIn',
  'auth.users.edit',
  'auth.users.revokeSessions',
  'auth.users.view',
  'auth.users.viewSessions',
  'camera.view',
  'jobs.delete',
  'jobs.view',
  'library.download',
  'library.manage',
  'library.upload',
  'library.view',
  'plugins.manage',
  'printerStorage.download',
  'printerStorage.view',
  'printers.clearPlate',
  'printers.control',
  'printers.manage',
  'printers.view',
  'prints.dispatch',
  'settings.manage',
  'tenants.disable',
  'tenants.manage'
] as const

export const permissionSchema = z.enum(permissionValues)

export type Permission = z.infer<typeof permissionSchema>

export const permissionScopeValues = [
  'printerStorage.view.models',
  'printerStorage.view.timelapses',
  'prints.dispatch.printerStorage',
  'printers.control.calibrate',
  'printers.control.hmsClear',
  'printers.control.manualControls',
  'printers.control.refresh',
  'printers.manage.ams',
  'printers.manage.settings',
  'printers.manage.storageEdit',
  'printers.manage.storageUpload'
] as const

export type PermissionScope = Permission | (typeof permissionScopeValues)[number]

export const permissionDefinitionSchema = z.object({
  key: permissionSchema,
  label: z.string(),
  description: z.string()
})

export type PermissionDefinition = z.infer<typeof permissionDefinitionSchema>

export const AUTH_ACCESS_VIEW_PERMISSION: Permission = 'auth.access.view'
export const AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION: Permission = 'auth.bypassSupportAccess'
export const AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION: Permission = 'auth.manageSupportAccess'
export const AUTH_PASSKEYS_EDIT_PERMISSION: Permission = 'auth.passkeys.edit'
export const AUTH_PASSKEYS_REVOKE_PERMISSION: Permission = 'auth.passkeys.revoke'
export const AUTH_PASSKEYS_VIEW_PERMISSION: Permission = 'auth.passkeys.view'
export const AUTH_PROVIDERS_MANAGE_PERMISSION: Permission = 'auth.providers.manage'
export const AUTH_ROLES_ASSIGN_PERMISSION: Permission = 'auth.roles.assign'
export const AUTH_ROLES_CREATE_PERMISSION: Permission = 'auth.roles.create'
export const AUTH_ROLES_DELETE_PERMISSION: Permission = 'auth.roles.delete'
export const AUTH_ROLES_EDIT_PERMISSION: Permission = 'auth.roles.edit'
export const AUTH_ROLES_VIEW_PERMISSION: Permission = 'auth.roles.view'
export const AUTH_SERVICE_ACCOUNTS_ASSIGN_ROLES_PERMISSION: Permission = 'auth.serviceAccounts.assignRoles'
export const AUTH_SERVICE_ACCOUNTS_CREATE_PERMISSION: Permission = 'auth.serviceAccounts.create'
export const AUTH_SERVICE_ACCOUNTS_EDIT_PERMISSION: Permission = 'auth.serviceAccounts.edit'
export const AUTH_SERVICE_ACCOUNTS_REVOKE_PERMISSION: Permission = 'auth.serviceAccounts.revoke'
export const AUTH_SERVICE_ACCOUNTS_VIEW_PERMISSION: Permission = 'auth.serviceAccounts.view'
export const AUTH_SESSION_POLICY_MANAGE_PERMISSION: Permission = 'auth.sessionPolicy.manage'
export const AUTH_USERS_ASSIGN_ROLES_PERMISSION: Permission = 'auth.users.assignRoles'
export const AUTH_USERS_CHANGE_EMAIL_PERMISSION: Permission = 'auth.users.changeEmail'
export const AUTH_USERS_CREATE_PERMISSION: Permission = 'auth.users.create'
export const AUTH_USERS_DELETE_PERMISSION: Permission = 'auth.users.delete'
export const AUTH_USERS_DISABLE_SIGN_IN_PERMISSION: Permission = 'auth.users.disableSignIn'
export const AUTH_USERS_EDIT_PERMISSION: Permission = 'auth.users.edit'
export const AUTH_USERS_REVOKE_SESSIONS_PERMISSION: Permission = 'auth.users.revokeSessions'
export const AUTH_USERS_VIEW_PERMISSION: Permission = 'auth.users.view'
export const AUTH_USERS_VIEW_SESSIONS_PERMISSION: Permission = 'auth.users.viewSessions'
export const CAMERA_VIEW_PERMISSION: Permission = 'camera.view'
export const JOBS_DELETE_PERMISSION: Permission = 'jobs.delete'
export const JOBS_VIEW_PERMISSION: Permission = 'jobs.view'
export const LIBRARY_DOWNLOAD_PERMISSION: Permission = 'library.download'
export const LIBRARY_MANAGE_PERMISSION: Permission = 'library.manage'
export const LIBRARY_UPLOAD_PERMISSION: Permission = 'library.upload'
export const LIBRARY_VIEW_PERMISSION: Permission = 'library.view'
export const PLUGINS_MANAGE_PERMISSION: Permission = 'plugins.manage'
export const PRINTER_STORAGE_DOWNLOAD_PERMISSION: Permission = 'printerStorage.download'
export const PRINTER_STORAGE_VIEW_PERMISSION: Permission = 'printerStorage.view'
export const PRINTERS_CLEAR_PLATE_PERMISSION: Permission = 'printers.clearPlate'
export const PRINTERS_CONTROL_PERMISSION: Permission = 'printers.control'
export const PRINTERS_MANAGE_PERMISSION: Permission = 'printers.manage'
export const PRINTERS_VIEW_PERMISSION: Permission = 'printers.view'
export const PRINTS_DISPATCH_PERMISSION: Permission = 'prints.dispatch'
export const SETTINGS_MANAGE_PERMISSION: Permission = 'settings.manage'
export const TENANTS_DISABLE_PERMISSION: Permission = 'tenants.disable'
export const TENANTS_MANAGE_PERMISSION: Permission = 'tenants.manage'

const tenantHiddenPermissions = new Set<Permission>([
  AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION,
  PLUGINS_MANAGE_PERMISSION,
  TENANTS_DISABLE_PERMISSION,
  TENANTS_MANAGE_PERMISSION
])

const platformVisiblePermissions = new Set<Permission>([
  AUTH_ACCESS_VIEW_PERMISSION,
  AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION,
  PLUGINS_MANAGE_PERMISSION,
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
  SETTINGS_MANAGE_PERMISSION,
  TENANTS_DISABLE_PERMISSION,
  TENANTS_MANAGE_PERMISSION
])

export function isPermissionVisibleInTenantContext(permission: Permission): boolean {
  return !tenantHiddenPermissions.has(permission)
}

export function filterPermissionsForTenantContext(permissions: readonly Permission[]): Permission[] {
  return permissions.filter(isPermissionVisibleInTenantContext)
}

export function filterPermissionDefinitionsForTenantContext(
  definitions: readonly PermissionDefinition[]
): PermissionDefinition[] {
  return definitions.filter((definition) => isPermissionVisibleInTenantContext(definition.key))
}

export function isPermissionVisibleInPlatformContext(permission: Permission): boolean {
  return platformVisiblePermissions.has(permission)
}

export function filterPermissionsForPlatformContext(permissions: readonly Permission[]): Permission[] {
  return permissions.filter(isPermissionVisibleInPlatformContext)
}

export function filterPermissionDefinitionsForPlatformContext(
  definitions: readonly PermissionDefinition[]
): PermissionDefinition[] {
  return definitions.filter((definition) => isPermissionVisibleInPlatformContext(definition.key))
}

export const PRINTER_STORAGE_VIEW_MODELS_SCOPE = 'printerStorage.view.models' as const
export const PRINTER_STORAGE_VIEW_TIMELAPSES_SCOPE = 'printerStorage.view.timelapses' as const
export const PRINTS_DISPATCH_PRINTER_STORAGE_SCOPE = 'prints.dispatch.printerStorage' as const
export const PRINTERS_CONTROL_CALIBRATE_SCOPE = 'printers.control.calibrate' as const
export const PRINTERS_CONTROL_HMS_CLEAR_SCOPE = 'printers.control.hmsClear' as const
export const PRINTERS_CONTROL_MANUAL_CONTROLS_SCOPE = 'printers.control.manualControls' as const
export const PRINTERS_CONTROL_REFRESH_SCOPE = 'printers.control.refresh' as const
export const PRINTERS_MANAGE_AMS_SCOPE = 'printers.manage.ams' as const
export const PRINTERS_MANAGE_SETTINGS_SCOPE = 'printers.manage.settings' as const
export const PRINTERS_MANAGE_STORAGE_EDIT_SCOPE = 'printers.manage.storageEdit' as const
export const PRINTERS_MANAGE_STORAGE_UPLOAD_SCOPE = 'printers.manage.storageUpload' as const

const permissionScopeFallbacks = new Map<(typeof permissionScopeValues)[number], Permission>([
  [PRINTER_STORAGE_VIEW_MODELS_SCOPE, PRINTER_STORAGE_VIEW_PERMISSION],
  [PRINTER_STORAGE_VIEW_TIMELAPSES_SCOPE, PRINTER_STORAGE_VIEW_PERMISSION],
  [PRINTS_DISPATCH_PRINTER_STORAGE_SCOPE, PRINTS_DISPATCH_PERMISSION],
  [PRINTERS_CONTROL_CALIBRATE_SCOPE, PRINTERS_CONTROL_PERMISSION],
  [PRINTERS_CONTROL_HMS_CLEAR_SCOPE, PRINTERS_CONTROL_PERMISSION],
  [PRINTERS_CONTROL_MANUAL_CONTROLS_SCOPE, PRINTERS_CONTROL_PERMISSION],
  [PRINTERS_CONTROL_REFRESH_SCOPE, PRINTERS_CONTROL_PERMISSION],
  [PRINTERS_MANAGE_AMS_SCOPE, PRINTERS_MANAGE_PERMISSION],
  [PRINTERS_MANAGE_SETTINGS_SCOPE, PRINTERS_MANAGE_PERMISSION],
  [PRINTERS_MANAGE_STORAGE_EDIT_SCOPE, PRINTERS_MANAGE_PERMISSION],
  [PRINTERS_MANAGE_STORAGE_UPLOAD_SCOPE, PRINTERS_MANAGE_PERMISSION]
])

export function resolvePermissionScope(permission: PermissionScope): Permission {
  return permissionScopeFallbacks.get(permission as (typeof permissionScopeValues)[number]) ?? permission as Permission
}

/**
 * Maps each permission to the set of permissions it requires to be useful.
 * Only direct (immediate) prerequisites are listed; transitive closure is computed by `resolveImpliedPermissions`.
 */
const permissionImplications = new Map<Permission, readonly Permission[]>([
  // Auth - Passkeys
  [AUTH_PASSKEYS_VIEW_PERMISSION, [AUTH_USERS_VIEW_PERMISSION]],
  [AUTH_PASSKEYS_EDIT_PERMISSION, [AUTH_PASSKEYS_VIEW_PERMISSION]],
  [AUTH_PASSKEYS_REVOKE_PERMISSION, [AUTH_PASSKEYS_VIEW_PERMISSION]],
  // Auth - Roles
  [AUTH_ROLES_CREATE_PERMISSION, [AUTH_ROLES_VIEW_PERMISSION]],
  [AUTH_ROLES_EDIT_PERMISSION, [AUTH_ROLES_VIEW_PERMISSION]],
  [AUTH_ROLES_DELETE_PERMISSION, [AUTH_ROLES_VIEW_PERMISSION]],
  [AUTH_ROLES_ASSIGN_PERMISSION, [AUTH_ROLES_VIEW_PERMISSION, AUTH_USERS_VIEW_PERMISSION]],
  // Auth - Users
  [AUTH_USERS_VIEW_PERMISSION, [AUTH_ACCESS_VIEW_PERMISSION]],
  [AUTH_USERS_CREATE_PERMISSION, [AUTH_USERS_VIEW_PERMISSION]],
  [AUTH_USERS_EDIT_PERMISSION, [AUTH_USERS_VIEW_PERMISSION]],
  [AUTH_USERS_DELETE_PERMISSION, [AUTH_USERS_VIEW_PERMISSION]],
  [AUTH_USERS_ASSIGN_ROLES_PERMISSION, [AUTH_USERS_VIEW_PERMISSION, AUTH_ROLES_VIEW_PERMISSION]],
  [AUTH_USERS_DISABLE_SIGN_IN_PERMISSION, [AUTH_USERS_VIEW_PERMISSION]],
  [AUTH_USERS_VIEW_SESSIONS_PERMISSION, [AUTH_USERS_VIEW_PERMISSION]],
  [AUTH_USERS_REVOKE_SESSIONS_PERMISSION, [AUTH_USERS_VIEW_SESSIONS_PERMISSION]],
  // Auth - Service Accounts
  [AUTH_SERVICE_ACCOUNTS_VIEW_PERMISSION, [AUTH_ACCESS_VIEW_PERMISSION]],
  [AUTH_SERVICE_ACCOUNTS_CREATE_PERMISSION, [AUTH_SERVICE_ACCOUNTS_VIEW_PERMISSION]],
  [AUTH_SERVICE_ACCOUNTS_EDIT_PERMISSION, [AUTH_SERVICE_ACCOUNTS_VIEW_PERMISSION]],
  [AUTH_SERVICE_ACCOUNTS_REVOKE_PERMISSION, [AUTH_SERVICE_ACCOUNTS_VIEW_PERMISSION]],
  [AUTH_SERVICE_ACCOUNTS_ASSIGN_ROLES_PERMISSION, [AUTH_SERVICE_ACCOUNTS_VIEW_PERMISSION, AUTH_ROLES_VIEW_PERMISSION]],
  // Auth - Other
  [AUTH_ROLES_VIEW_PERMISSION, [AUTH_ACCESS_VIEW_PERMISSION]],
  [AUTH_PROVIDERS_MANAGE_PERMISSION, [AUTH_ACCESS_VIEW_PERMISSION]],
  [AUTH_SESSION_POLICY_MANAGE_PERMISSION, [AUTH_ACCESS_VIEW_PERMISSION]],
  [AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION, [AUTH_ACCESS_VIEW_PERMISSION]],
  [TENANTS_DISABLE_PERMISSION, [TENANTS_MANAGE_PERMISSION]],
  // Library
  [LIBRARY_UPLOAD_PERMISSION, [LIBRARY_VIEW_PERMISSION]],
  [LIBRARY_DOWNLOAD_PERMISSION, [LIBRARY_VIEW_PERMISSION]],
  [LIBRARY_MANAGE_PERMISSION, [LIBRARY_VIEW_PERMISSION]],
  // Jobs
  [JOBS_DELETE_PERMISSION, [JOBS_VIEW_PERMISSION]],
  // Printers
  [PRINTERS_CONTROL_PERMISSION, [PRINTERS_VIEW_PERMISSION]],
  [PRINTERS_MANAGE_PERMISSION, [PRINTERS_VIEW_PERMISSION]],
  [PRINTERS_CLEAR_PLATE_PERMISSION, [PRINTERS_VIEW_PERMISSION, PRINTERS_CONTROL_PERMISSION]],
  [CAMERA_VIEW_PERMISSION, [PRINTERS_VIEW_PERMISSION]],
  // Printer Storage
  [PRINTER_STORAGE_VIEW_PERMISSION, [PRINTERS_VIEW_PERMISSION]],
  [PRINTER_STORAGE_DOWNLOAD_PERMISSION, [PRINTER_STORAGE_VIEW_PERMISSION]],
  // Prints
  [PRINTS_DISPATCH_PERMISSION, [PRINTERS_VIEW_PERMISSION, LIBRARY_VIEW_PERMISSION]]
])

/**
 * Given a set of selected permissions, returns all additional permissions that are
 * implied as prerequisites (transitive closure). Does not include the input permissions.
 */
export function resolveImpliedPermissions(selected: readonly Permission[]): Permission[] {
  const result = new Set<Permission>()
  const queue = [...selected]
  const visited = new Set<Permission>(selected)

  while (queue.length > 0) {
    const current = queue.pop()!
    const implications = permissionImplications.get(current)
    if (!implications) continue
    for (const implied of implications) {
      if (!visited.has(implied)) {
        visited.add(implied)
        result.add(implied)
        queue.push(implied)
      }
    }
  }

  return [...result]
}

/**
 * Returns the direct prerequisite permissions for a single permission.
 * Returns an empty array if none are defined.
 */
export function getPermissionPrerequisites(permission: Permission): readonly Permission[] {
  return permissionImplications.get(permission) ?? []
}

/**
 * Returns all permissions that directly require the given permission as a prerequisite.
 * Useful for UI to show what depends on a permission being granted.
 */
export function getPermissionDependents(permission: Permission): Permission[] {
  const dependents: Permission[] = []
  for (const [child, parents] of permissionImplications) {
    if (parents.includes(permission)) {
      dependents.push(child)
    }
  }
  return dependents
}

export const permissionDefinitions: PermissionDefinition[] = [
  {
    key: AUTH_ACCESS_VIEW_PERMISSION,
    label: 'View Access Management',
    description: 'View auth management status, users, roles, service accounts, and access controls.'
  },
  {
    key: AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION,
    label: 'Bypass Support Access Policy',
    description: 'Enter workspaces for support even when workspace support access is disabled.'
  },
  {
    key: AUTH_PROVIDERS_MANAGE_PERMISSION,
    label: 'Manage Auth Providers',
    description: 'Enable, disable, and configure sign-in providers.'
  },
  {
    key: AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION,
    label: 'Manage Support Access',
    description: 'Choose whether support users can enter this workspace and what they can do while helping.'
  },
  {
    key: AUTH_PASSKEYS_VIEW_PERMISSION,
    label: 'View User Passkeys',
    description: 'View registered passkeys for managed users.'
  },
  {
    key: AUTH_PASSKEYS_EDIT_PERMISSION,
    label: 'Edit User Passkeys',
    description: 'Rename passkeys registered to managed users.'
  },
  {
    key: AUTH_PASSKEYS_REVOKE_PERMISSION,
    label: 'Revoke User Passkeys',
    description: 'Disable passkeys registered to managed users.'
  },
  {
    key: AUTH_ROLES_VIEW_PERMISSION,
    label: 'View Roles',
    description: 'View roles and their assigned permissions.'
  },
  {
    key: AUTH_ROLES_CREATE_PERMISSION,
    label: 'Create Roles',
    description: 'Create custom roles in the active context.'
  },
  {
    key: AUTH_ROLES_EDIT_PERMISSION,
    label: 'Edit Roles',
    description: 'Rename roles and change their permission sets.'
  },
  {
    key: AUTH_ROLES_DELETE_PERMISSION,
    label: 'Delete Roles',
    description: 'Delete removable custom roles.'
  },
  {
    key: AUTH_ROLES_ASSIGN_PERMISSION,
    label: 'Assign Roles',
    description: 'Assign roles to users or automation tokens.'
  },
  {
    key: AUTH_USERS_VIEW_PERMISSION,
    label: 'View Users',
    description: 'View users and their role assignments.'
  },
  {
    key: AUTH_USERS_CREATE_PERMISSION,
    label: 'Create Users',
    description: 'Create users or add existing accounts to the active context.'
  },
  {
    key: AUTH_USERS_EDIT_PERMISSION,
    label: 'Edit Users',
    description: 'Send setup and recovery actions for managed users.'
  },
  {
    key: AUTH_USERS_ASSIGN_ROLES_PERMISSION,
    label: 'Assign User Roles',
    description: 'Change role assignments for managed users.'
  },
  {
    key: AUTH_USERS_DISABLE_SIGN_IN_PERMISSION,
    label: 'Disable User Sign-In',
    description: 'Enable or disable sign-in for managed users in the active context.'
  },
  {
    key: AUTH_USERS_DELETE_PERMISSION,
    label: 'Delete Users',
    description: 'Remove users from the active context.'
  },
  {
    key: AUTH_USERS_VIEW_SESSIONS_PERMISSION,
    label: 'View User Sessions',
    description: 'View active browser sessions for managed users.'
  },
  {
    key: AUTH_USERS_REVOKE_SESSIONS_PERMISSION,
    label: 'Revoke User Sessions',
    description: 'Revoke active browser sessions for managed users.'
  },
  {
    key: AUTH_SERVICE_ACCOUNTS_VIEW_PERMISSION,
    label: 'View Service Accounts',
    description: 'View automation tokens and their role assignments.'
  },
  {
    key: AUTH_SERVICE_ACCOUNTS_CREATE_PERMISSION,
    label: 'Create Service Accounts',
    description: 'Create automation tokens in the active workspace.'
  },
  {
    key: AUTH_SERVICE_ACCOUNTS_EDIT_PERMISSION,
    label: 'Edit Service Accounts',
    description: 'Rename automation tokens.'
  },
  {
    key: AUTH_SERVICE_ACCOUNTS_ASSIGN_ROLES_PERMISSION,
    label: 'Assign Service Account Roles',
    description: 'Change role assignments for automation tokens.'
  },
  {
    key: AUTH_SERVICE_ACCOUNTS_REVOKE_PERMISSION,
    label: 'Revoke Service Accounts',
    description: 'Revoke automation tokens.'
  },
  {
    key: AUTH_SESSION_POLICY_MANAGE_PERMISSION,
    label: 'Manage Session Policy',
    description: 'View and change browser session duration policy.'
  },
  {
    key: CAMERA_VIEW_PERMISSION,
    label: 'View Cameras',
    description: 'View printer camera streams and snapshots.'
  },
  {
    key: JOBS_DELETE_PERMISSION,
    label: 'Delete Job History',
    description: 'Delete finished jobs from print history.'
  },
  {
    key: JOBS_VIEW_PERMISSION,
    label: 'View Jobs',
    description: 'View job history, progress, and job details.'
  },
  {
    key: LIBRARY_DOWNLOAD_PERMISSION,
    label: 'Download Library Files',
    description: 'Download library files and raw print assets.'
  },
  {
    key: LIBRARY_MANAGE_PERMISSION,
    label: 'Manage Library',
    description: 'Rename, move, and delete library files and folders.'
  },
  {
    key: LIBRARY_UPLOAD_PERMISSION,
    label: 'Upload Library Files',
    description: 'Upload new files into the shared print library.'
  },
  {
    key: LIBRARY_VIEW_PERMISSION,
    label: 'View Library',
    description: 'Browse library metadata, listings, and non-raw file details.'
  },
  {
    key: PLUGINS_MANAGE_PERMISSION,
    label: 'Manage Plugins',
    description: 'Install, configure, enable, disable, and remove plugins.'
  },
  {
    key: PRINTER_STORAGE_DOWNLOAD_PERMISSION,
    label: 'Download Printer Storage Files',
    description: 'Download raw files directly from printer storage.'
  },
  {
    key: PRINTER_STORAGE_VIEW_PERMISSION,
    label: 'Browse Printer Storage',
    description: 'Browse SD card and printer storage listings and metadata.'
  },
  {
    key: PRINTERS_CLEAR_PLATE_PERMISSION,
    label: 'Clear Printer Plates',
    description: 'Confirm that a printer build plate has been cleared so the next job can start.'
  },
  {
    key: PRINTERS_CONTROL_PERMISSION,
    label: 'Control Printers',
    description: 'Send printer commands and interact with live printers.'
  },
  {
    key: PRINTERS_MANAGE_PERMISSION,
    label: 'Manage Printers',
    description: 'Add, edit, reorder, and remove printer records.'
  },
  {
    key: PRINTERS_VIEW_PERMISSION,
    label: 'View Printers',
    description: 'View printer status, health, and current activity.'
  },
  {
    key: PRINTS_DISPATCH_PERMISSION,
    label: 'Dispatch Prints',
    description: 'Start prints from library files or printer-hosted files.'
  },
  {
    key: SETTINGS_MANAGE_PERMISSION,
    label: 'Manage Settings',
    description: 'Change global application settings and administrative configuration.'
  },
  {
    key: TENANTS_DISABLE_PERMISSION,
    label: 'Disable Tenants',
    description: 'Disable or re-enable tenant workspaces so they cannot be entered until restored.'
  },
  {
    key: TENANTS_MANAGE_PERMISSION,
    label: 'Manage Tenants',
    description: 'Create, update, and administer tenant workspaces and their cloud-hosted routing.'
  }
]