# Auth Architecture

The auth system uses a one-account model for human users and keeps platform
administration conceptually separate from workspace authorization while storing
both role types in the shared auth tables. Treat this document as the design
contract for future auth work: update it first when the intended model changes,
then use tests to prove the implementation still matches it.

## Data model

- `AuthUser` is the global identity row. It owns the email address, display name, platform-user flag, browser sessions, passkeys, and one-time email-code tokens.
- `AuthTenantMembership` is the tenant-scoped access row. It decides whether that user can enter a tenant workspace and whether sign-in is disabled for that tenant.
- `AuthGroup` and `AuthUserGroupMembership` grant permissions in both contexts. Tenant/workspace roles use a tenant-scoped `AuthGroup`; platform roles reuse the same tables with `AuthGroup.tenantId = null`.
- Platform roles still grant platform permissions only. They do not grant printer, library, job, or other workspace permissions.
- `AuthServiceAccount` stays tenant-scoped. Automation tokens are unchanged by this redesign.
- Email and display-name changes are self-service global account updates. Workspace or platform auth managers can create users, remove memberships, assign roles, disable workspace sign-in, send setup invites, revoke credentials, and delete stale users, but they must not directly mutate another human user's global email address or display name.

This split keeps identity global while leaving authorization tenant-local.

## Permission boundaries

Permissions are divided by the context in which they can be assigned and used:

- Platform permissions are for host-level administration: auth management, plugin management, global settings, tenant/workspace management, and support-access bypass.
- Workspace permissions are for work inside a workspace: printers, cameras, jobs, library, printer storage, print dispatch, workspace settings, workspace auth management, and support-access management.
- Platform roles must not include workspace permissions. A platform user entering a workspace receives effective workspace permissions from that workspace's support-access policy, not from platform role membership.
- Workspace roles must not expose platform-only permissions. Workspace users should not see platform permissions, tenant management, or support-access bypass as assignable actions.
- Auth-management permissions such as `auth.users.create`, `auth.roles.assign`, and `auth.passkeys.revoke` exist in both platform and workspace contexts. Their meaning is context-sensitive: in platform mode they act on platform users, roles, providers, and policy; in a workspace they act on that workspace's users, roles, service accounts, and support policy.

When adding a permission, decide whether it is platform-visible, workspace-visible,
or both before adding UI. Add shared filter coverage so route validation and role
editors cannot drift apart.

## Support access

Support access controls what platform users can do inside a workspace.

- New workspaces default to support access enabled.
- A missing support-access permission allowlist means all workspace-visible permissions are allowed. This avoids setup lockout while auth is being enabled.
- Disabling support access blocks platform users from entering that workspace unless one of their platform roles grants `auth.bypassSupportAccess`.
- `auth.bypassSupportAccess` is a platform permission. It can be assigned to platform roles and makes the user limitless at the workspace boundary: disabled support access and the workspace allowlist are ignored.
- `auth.manageSupportAccess` is a workspace permission. Workspace admins with this permission decide whether support users can enter and which workspace permissions non-bypass support users receive.
- The built-in platform Support role intentionally has no platform-management permissions. Support users are platform users who can help inside workspaces that allow support access, using that workspace's support-access permission policy.
- The built-in platform Manager role is a support lead role. It can create and manage lower platform users/roles and manage customer workspaces, but it does not bypass workspace support-access policy.
- The built-in tenant Manager role is the tenant-scoped auth operator. It combines day-to-day printer and library operations with tenant auth-management permissions for users, roles, passkeys, service accounts, and support-access policy, while leaving provider management and session policy to Admin.
- Support-access bypass is not platform Admin authority. In platform mode, equal-permission management is reserved for users with the full platform-visible permission set, not merely users with `auth.bypassSupportAccess`.
- Tenants/workspace users should see user-facing language such as "support access", "support users", and "workspace". They should not need to understand platform roles or tenant internals to operate their own access policy.

Implementation rule: support access policy is resolved once at auth-context/session
boundaries and then represented as ordinary effective permissions for downstream
routes. Routes should not duplicate support-access checks unless they are editing
the support policy itself.

Exception: personal delivery surfaces (e.g. browser push subscriptions) are scoped
by actual `AuthTenantMembership`, not by effective permissions. A platform user who
holds a workspace permission such as `settings.manage` only through support access
must not register for or receive that workspace's notifications. Code that fans out
per-user notifications must verify membership directly rather than relying on the
support-access permission grant.

## Sign-in flow

- Local auth email codes and passkeys now sign in the global `AuthUser`.
- OAuth/OIDC now matches or provisions the global `AuthUser` by verified email.
- If the signed-in user has exactly one enabled tenant membership, the API binds the request to that tenant automatically.
- If the signed-in user can access multiple tenants, the account stays signed in but tenant permissions remain empty until the client selects a tenant context.
- Platform users still support platform mode with no workspace selected.
- Auth bootstrap exposes two workspace lists: `memberTenants` for the user's own enabled tenant memberships and `availableTenants` for every workspace their current authority can enter from the platform tenant directory.
- For normal workspace users, `memberTenants` and `availableTenants` are the same enabled memberships.
- For platform users, `memberTenants` stays limited to their own tenant memberships, while `availableTenants` is the union of own tenant memberships, workspaces with support access allowed, and every enabled workspace when a platform role grants `auth.bypassSupportAccess`.

## Public demo guest access

A deployment may designate one tenant slug as a public demo tenant. Anonymous
requests for that tenant resolve to a public demo guest context with an explicit
read-mostly permission set. This is intentionally different from an
auth-disabled tenant: public demo guests still use permission enforcement, so
write routes remain blocked unless their permissions are granted deliberately.

The public demo guest policy is tenant-scoped. It must not grant platform
permissions, tenant-management permissions, auth-management permissions,
settings management, plugin management, printer setup, library mutation, or
other destructive actions by default.

Auth bootstrap may use the same runtime-policy shape as global demo mode so the
web app can render public-demo copy, but the API remains the enforcement
boundary. UI hiding should not be treated as the safety mechanism.

The active tenant is carried by the existing tenant-context selection flow. `installAuthContext()` now rebases `request.tenant` onto the authenticated effective tenant so downstream route code sees the checked tenant, not only the raw cookie or slug.

## Management semantics

- Creating a tenant user now creates or reuses one global `AuthUser`, then adds an `AuthTenantMembership` for the current tenant.
- Disabling login for a tenant user updates `AuthTenantMembership.loginDisabled`, not the global user.
- Removing a tenant user deletes only that tenant membership and tenant-local group memberships. The global `AuthUser` is only deleted after its final tenant membership is removed and it is not a platform user.
- Workspace lists available to signed-in workspace users come from enabled `AuthTenantMembership` rows instead of email matching across tenant-scoped users.
- Workspace switchers and chooser defaults use `memberTenants` so users only switch into workspaces where they have an enabled tenant account.
- Platform directory/support workflows may use `availableTenants` when they intentionally need access beyond the workspace switcher's direct memberships. UX or reporting that should stay scoped to a platform user's own workspaces must use `memberTenants`, not `availableTenants`.

## Session Policy

- Browser session duration is an idle timeout, not an absolute lifetime from sign-in.
- Authenticated HTTP activity refreshes the session expiry and auth cookie on a throttled cadence. WebSocket authentication can refresh server-side activity but cannot emit a replacement cookie.
- Recent-verification checks remain separate and use their own short window for sensitive actions.

## Management hierarchy

Auth-management permissions grant access to specific management actions, but they
do not make the actor limitless. User and role changes must also respect a strict
permission hierarchy in the active context:

- A platform or workspace auth manager can manage a target user only when every permission currently granted by the target's scoped roles is also present in the manager's effective permissions, and the target has fewer effective permissions than the manager.
- A manager can create, edit, or assign a role only when every permission in that role is also present in the manager's effective permissions, and the role's permissions are lower than the manager's own effective set.
- Equal-permission management is reserved for top-level authorities in the active context: platform Admin users with the full platform-visible permission set, platform users while acting in a workspace (they are external authorities, not peers), and workspace admin-equivalent users with all workspace-visible permissions.
- The same rule applies to initial user roles, later user role changes, service-account roles, login disablement, deletion, and managed session revocation.
- Custom roles use the same strict-lower rule as built-in roles. Do not introduce hard-coded role ranks unless the product model changes.

This keeps custom auth-management roles useful for limited delegation without
allowing those roles to edit or mint peers or users above themselves.

## Regression strategy

Auth changes should start by updating or adding tests that describe the desired
security boundary. Favor behavior tests over implementation tests:

- A platform role with only platform permissions cannot directly gain printer, job, or library permissions.
- A workspace role cannot be assigned platform-only permissions.
- A manager with auth-management permissions cannot edit users or assign roles whose permissions equal or exceed the manager's own effective permissions unless they are top-level authority for the active context.
- A non-bypass platform user can enter only support-enabled workspaces and receives only the workspace allowlist.
- A bypass platform user can enter support-disabled workspaces and receives all workspace-visible permissions.
- Disabling support access requires a recent user session and must leave at least one enabled workspace Admin.
- Browser, WebSocket, and tenant-context selection paths must resolve the same effective tenant and permissions.

When a bug appears in auth, add the failing case first or alongside the fix so
future refactors challenge this contract instead of preserving accidental behavior.

## Migration shape

The checked-in Prisma migration history is still rewrite-era and should be treated as a fresh-start baseline rather than deployed upgrade history.

The important current-state shape is:

1. Global `AuthUser` identities.
2. Tenant-scoped `AuthTenantMembership` access rows.
3. Shared `AuthGroup` / `AuthUserGroupMembership` tables, where `tenantId = null` represents platform roles and non-null `tenantId` represents workspace roles.

Because platform auth is still new and uncommitted, prefer keeping fresh databases and checked-in migrations aligned to the current design rather than preserving speculative upgrade steps for intermediate local-only shapes.