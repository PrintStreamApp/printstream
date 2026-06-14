/**
 * Auth capability helpers for bootstrap and management UI payloads.
 *
 * These helpers keep the server-truth mapping from raw granted permissions to
 * user-facing view/edit capabilities in one place so the web app does not need
 * to reverse-engineer authorization rules from broad section visibility.
 */
import {
  AUTH_ACCESS_VIEW_PERMISSION,
  AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION,
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
  PLUGINS_MANAGE_PERMISSION,
  SETTINGS_MANAGE_PERMISSION,
  TENANTS_MANAGE_PERMISSION,
  filterPermissionsForPlatformContext,
  filterPermissionsForTenantContext,
  permissionValues,
  type AuthBootstrapCapabilities,
  type AuthManagementCapabilities,
  type Permission
} from '@printstream/shared'
import type { RequestAuthContext } from './auth-context.js'
import { authUsesExplicitPermissions } from './auth-context.js'
import { getCurrentTenant } from './tenant-context.js'

type AuthCapabilityContext = Pick<RequestAuthContext, 'authEnabled' | 'publicDemoGuest' | 'actor' | 'permissions' | 'platformPermissions'>

export function buildAuthBootstrapCapabilities(
  auth: AuthCapabilityContext,
  input: { setupRequired: boolean }
): AuthBootstrapCapabilities {
  return {
    canViewAuth: input.setupRequired || hasEffectivePermission(auth, AUTH_ACCESS_VIEW_PERMISSION),
    canManageAuthProviders: input.setupRequired || hasEffectivePermission(auth, AUTH_PROVIDERS_MANAGE_PERMISSION),
    canManageSettings: hasEffectivePermission(auth, SETTINGS_MANAGE_PERMISSION),
    canManageSupportAccess: hasEffectivePermission(auth, AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION),
    canManageTenants: hasEffectivePermission(auth, TENANTS_MANAGE_PERMISSION),
    canManagePlugins: hasEffectivePermission(auth, PLUGINS_MANAGE_PERMISSION),
    canViewLogs: hasEffectivePermission(auth, SETTINGS_MANAGE_PERMISSION)
  }
}

export function buildAuthManagementCapabilities(auth: AuthCapabilityContext): AuthManagementCapabilities {
  const canAssignRolePermissions = hasEffectivePermission(auth, AUTH_ROLES_ASSIGN_PERMISSION)

  return {
    canViewUsers: hasEffectivePermission(auth, AUTH_USERS_VIEW_PERMISSION),
    canCreateUsers: hasEffectivePermission(auth, AUTH_USERS_CREATE_PERMISSION),
    canEditUsers: hasEffectivePermission(auth, AUTH_USERS_EDIT_PERMISSION),
    canChangeUserEmail: false,
    canDisableUserSignIn: hasEffectivePermission(auth, AUTH_USERS_DISABLE_SIGN_IN_PERMISSION),
    canDeleteUsers: hasEffectivePermission(auth, AUTH_USERS_DELETE_PERMISSION),
    canAssignUserRoles: hasEffectivePermission(auth, AUTH_USERS_ASSIGN_ROLES_PERMISSION) && canAssignRolePermissions,
    canViewUserSessions: hasEffectivePermission(auth, AUTH_USERS_VIEW_SESSIONS_PERMISSION),
    canRevokeUserSessions: hasEffectivePermission(auth, AUTH_USERS_REVOKE_SESSIONS_PERMISSION),
    canViewUserPasskeys: hasEffectivePermission(auth, AUTH_PASSKEYS_VIEW_PERMISSION),
    canEditUserPasskeys: hasEffectivePermission(auth, AUTH_PASSKEYS_EDIT_PERMISSION),
    canRevokeUserPasskeys: hasEffectivePermission(auth, AUTH_PASSKEYS_REVOKE_PERMISSION),
    canViewRoles: hasEffectivePermission(auth, AUTH_ROLES_VIEW_PERMISSION),
    canCreateRoles: hasEffectivePermission(auth, AUTH_ROLES_CREATE_PERMISSION) && canAssignRolePermissions,
    canEditRoles: hasEffectivePermission(auth, AUTH_ROLES_EDIT_PERMISSION),
    canDeleteRoles: hasEffectivePermission(auth, AUTH_ROLES_DELETE_PERMISSION),
    canAssignRolePermissions,
    canViewServiceAccounts: hasEffectivePermission(auth, AUTH_SERVICE_ACCOUNTS_VIEW_PERMISSION),
    canCreateServiceAccounts: hasEffectivePermission(auth, AUTH_SERVICE_ACCOUNTS_CREATE_PERMISSION),
    canEditServiceAccounts: hasEffectivePermission(auth, AUTH_SERVICE_ACCOUNTS_EDIT_PERMISSION),
    canRevokeServiceAccounts: hasEffectivePermission(auth, AUTH_SERVICE_ACCOUNTS_REVOKE_PERMISSION),
    canAssignServiceAccountRoles: hasEffectivePermission(auth, AUTH_SERVICE_ACCOUNTS_ASSIGN_ROLES_PERMISSION) && canAssignRolePermissions,
    canManageSessionPolicy: hasEffectivePermission(auth, AUTH_SESSION_POLICY_MANAGE_PERMISSION),
    canManageSupportAccess: hasEffectivePermission(auth, AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION)
  }
}

export function readAssignablePermissions(auth: AuthCapabilityContext): Permission[] {
  const visiblePermissions = getCurrentTenant()
    ? filterPermissionsForTenantContext(permissionValues)
    : filterPermissionsForPlatformContext(permissionValues)

  if (!authUsesExplicitPermissions(auth)) {
    return visiblePermissions
  }

  const actorPermissions = new Set(auth.permissions)
  return visiblePermissions.filter((permission) => actorPermissions.has(permission))
}

export function permissionsAreManageableByActor(
  auth: AuthCapabilityContext,
  permissions: readonly string[]
): boolean {
  if (!authUsesExplicitPermissions(auth)) {
    return true
  }

  const actorPermissions = new Set<string>(auth.permissions)
  const targetPermissions = new Set(permissions)
  if (!permissions.every((permission) => actorPermissions.has(permission))) {
    return false
  }

  if (targetPermissions.size < actorPermissions.size) {
    return true
  }

  return actorCanManageEqualPermissionSet(auth)
}

function actorCanManageEqualPermissionSet(auth: AuthCapabilityContext): boolean {
  const tenant = getCurrentTenant()
  if (!tenant) {
    const platformVisiblePermissions = filterPermissionsForPlatformContext(permissionValues)
    const actorPermissions = new Set(auth.platformPermissions ?? auth.permissions)
    return platformVisiblePermissions.every((permission) => actorPermissions.has(permission))
  }

  // Platform users in tenant context are external authorities, not peers.
  // The tenant opted in to their access, so the equal-permission gate does not apply.
  if (auth.actor.type === 'user' && auth.actor.isPlatformUser) {
    return true
  }

  const tenantVisiblePermissions = filterPermissionsForTenantContext(permissionValues)
  const actorPermissions = new Set(auth.permissions)
  return tenantVisiblePermissions.every((permission) => actorPermissions.has(permission))
}

function hasEffectivePermission(auth: AuthCapabilityContext, permission: Permission): boolean {
  if (authUsesExplicitPermissions(auth)) {
    return auth.permissions.includes(permission)
  }

  if (getCurrentTenant()) {
    return true
  }

  return auth.permissions.includes(permission)
}
