---
applyTo: "apps/api/src/lib/auth*.ts,apps/api/src/lib/authorization.ts,apps/api/src/routes/auth*.ts,apps/api/src/plugins/auth-*/**,apps/web/src/components/Auth*.tsx,apps/web/src/plugins/auth-*/**,apps/web/src/lib/auth*.ts,apps/web/src/pages/SettingsView.tsx,apps/web/src/pages/PlatformView.tsx,packages/shared/src/auth*.ts,packages/shared/src/permissions.ts,packages/shared/src/tenants.ts"
description: "Automatically load the repo's auth architecture contract when working on auth identity, sessions, permissions, platform roles, tenant memberships, or support access."
---

# Auth Architecture Instructions

- Treat `docs/auth-architecture.md` as the human-readable source of truth for the rules below and keep this file aligned with it.
- Auth uses a one-account model: `AuthUser` is global identity, while `AuthTenantMembership` controls tenant/workspace access and tenant login-disabled state.
- Tenant/workspace authorization is tenant-local. `AuthGroup` rows with a tenant id grant workspace permissions; service accounts stay tenant-scoped.
- Platform authorization is conceptually separate but stored in the same auth tables. Platform roles use `AuthGroup` and `AuthUserGroupMembership` with `tenantId = null`, and those platform groups must not grant printer, library, job, dispatch, camera, or other workspace permissions.
- Workspace roles must not expose platform-only permissions such as tenant management or support-access bypass in API responses, role tables, or role editors.
- Auth-management permissions are granular and context-sensitive. Use specific permissions such as `auth.users.create`, `auth.users.edit`, `auth.users.delete`, `auth.users.assignRoles`, `auth.roles.create`, `auth.roles.edit`, `auth.roles.delete`, `auth.roles.assign`, `auth.passkeys.revoke`, `auth.users.revokeSessions`, and service-account equivalents instead of a broad auth-management permission.
- New workspaces default support access to enabled. A missing support-access permission allowlist means all workspace-visible permissions are allowed.
- Disabling support access blocks platform users from entering that workspace unless a platform role grants `auth.bypassSupportAccess`.
- `auth.bypassSupportAccess` is a platform permission; `auth.manageSupportAccess` is a workspace permission.
- Built-in platform Support has no platform-management permissions; support users help inside workspaces according to that workspace's support-access policy.
- Built-in platform Manager is a support lead role: it can manage lower platform support users/roles and manage customer workspaces, but it does not bypass workspace support-access policy.
- Built-in tenant Manager combines day-to-day printer and library operations with tenant-scoped auth management for users, roles, passkeys, service accounts, and support-access policy, while leaving provider management and session policy to Admin.
- Support-access bypass is not platform Admin authority. In platform mode, equal-permission management requires the full platform-visible permission set, not merely `auth.bypassSupportAccess`.
- Resolve support access at auth-context/session boundaries and represent the result as effective permissions for downstream routes. Do not duplicate support-access checks in unrelated routes.
- Personal delivery surfaces (e.g. browser push subscriptions) are scoped by actual `AuthTenantMembership`, not by effective permissions. A platform user holding a workspace permission only via support access must not register for or receive that workspace's notifications; verify membership directly when fanning out per-user notifications.
- Local auth and OAuth/OIDC sign in the global `AuthUser`; tenant context selection decides which workspace permissions are active.
- The reserved `demo` tenant may admit anonymous public demo guests with an explicit read-mostly tenant permission set. This must not use the auth-disabled tenant bypass, and it must not grant platform, auth-management, settings-management, plugin-management, printer-setup, library-mutation, or destructive permissions by default.
- Auth bootstrap exposes `memberTenants` for the actor's own enabled tenant memberships and `availableTenants` for every workspace they can enter from the platform tenant directory.
- For platform users, `memberTenants` must stay limited to direct memberships even when `availableTenants` includes support-access workspaces.
- For platform users, `availableTenants` is the union of direct memberships, support-access-allowed workspaces, and all enabled workspaces when `auth.bypassSupportAccess` is granted.
- Use `memberTenants` for workspace switchers, chooser defaults, and "my workspaces" rollups. Use `availableTenants` only for platform directory/support workflows that intentionally need access beyond direct memberships.
- Browser session duration is an idle timeout. Authenticated HTTP activity refreshes both stored session expiry and the auth cookie; recent-verification checks are separate and stay short-lived.
- Creating a tenant user creates or reuses a global `AuthUser`, then adds tenant membership and tenant-local group memberships.
- Removing a tenant user removes only that tenant membership and tenant-local group memberships. Delete the global user only after its final tenant membership is gone and it is not a platform user.
- Email and display-name changes are self-service global account updates. Auth managers must not directly mutate another human user's global email address or display name; create/delete users or send setup invites when an address needs correction.
- Auth-management permissions grant specific actions but do not bypass hierarchy. Managers can manage users, assign roles, and edit role permissions only when the target permissions are strictly lower than the manager's effective permissions in the active context.
- Equal-permission management is reserved for top-level authorities in the active context: platform Admin users with the full platform-visible permission set, platform users while acting in a workspace (they are external authorities, not peers), and workspace admin-equivalent users with all workspace-visible permissions.
- Apply the hierarchy rule equally to platform users, workspace users, custom roles, service accounts, login disablement, deletion, and managed session revocation.
- Auth changes should include regression tests for platform/workspace permission boundaries, public demo guest permissions, support-access policy, lockout prevention, tenant-context selection, and WebSocket/session invalidation.