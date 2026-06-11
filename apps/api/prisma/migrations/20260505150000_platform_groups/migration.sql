-- AlterTable: Make AuthGroup.tenantId nullable to support platform-level groups
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'AuthGroup'
      AND column_name = 'tenantId'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "AuthGroup" ALTER COLUMN "tenantId" DROP NOT NULL;
  END IF;
END $$;

-- Rename isSuperAdmin to isPlatformUser
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'AuthUser'
      AND column_name = 'isSuperAdmin'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'AuthUser'
      AND column_name = 'isPlatformUser'
  ) THEN
    ALTER TABLE "AuthUser" RENAME COLUMN "isSuperAdmin" TO "isPlatformUser";
  END IF;
END $$;

-- Seed platform groups. Keep these SQL bundles aligned with
-- apps/api/src/lib/default-auth-groups.ts.
WITH permission_bundles AS (
  SELECT
    ARRAY[
      'auth.passkeys.edit',
      'auth.passkeys.revoke',
      'auth.passkeys.view'
    ]::text[] AS auth_passkey_management_permissions,
    ARRAY[
      'auth.roles.assign',
      'auth.roles.create',
      'auth.roles.delete',
      'auth.roles.edit',
      'auth.roles.view'
    ]::text[] AS auth_role_management_permissions,
    ARRAY[
      'auth.serviceAccounts.assignRoles',
      'auth.serviceAccounts.create',
      'auth.serviceAccounts.edit',
      'auth.serviceAccounts.revoke',
      'auth.serviceAccounts.view'
    ]::text[] AS auth_service_account_management_permissions,
    ARRAY[
      'auth.users.assignRoles',
      'auth.users.changeEmail',
      'auth.users.create',
      'auth.users.delete',
      'auth.users.disableSignIn',
      'auth.users.edit',
      'auth.users.revokeSessions',
      'auth.users.view',
      'auth.users.viewSessions'
    ]::text[] AS auth_user_management_permissions
),
seed_rows AS (
  SELECT
    'platform-group-admin'::text AS id,
    NULL::text AS "tenantId",
    'admin'::text AS key,
    'Admin'::text AS name,
    'Full platform access including settings, plugins, tenants, auth management, and support-access bypass.'::text AS description,
    ARRAY['auth.bypassSupportAccess', 'auth.access.view']::text[]
      || auth_passkey_management_permissions
      || ARRAY['auth.providers.manage']::text[]
      || auth_role_management_permissions
      || auth_service_account_management_permissions
      || ARRAY['auth.sessionPolicy.manage']::text[]
      || auth_user_management_permissions
      || ARRAY['plugins.manage', 'settings.manage', 'tenants.manage']::text[] AS permissions,
    true AS "isSystem",
    false AS "isEditable",
    false AS "isRemovable",
    NOW() AS "createdAt",
    NOW() AS "updatedAt"
  FROM permission_bundles

  UNION ALL

  SELECT
    'platform-group-manager'::text AS id,
    NULL::text AS "tenantId",
    'platform_manager'::text AS key,
    'Manager'::text AS name,
    'Lead support users and manage customer workspaces without overriding workspace support-access policy.'::text AS description,
    ARRAY['auth.access.view']::text[]
      || auth_passkey_management_permissions
      || auth_role_management_permissions
      || auth_user_management_permissions
      || ARRAY['tenants.manage']::text[] AS permissions,
    true AS "isSystem",
    false AS "isEditable",
    false AS "isRemovable",
    NOW() AS "createdAt",
    NOW() AS "updatedAt"
  FROM permission_bundles

  UNION ALL

  SELECT
    'platform-group-support'::text AS id,
    NULL::text AS "tenantId",
    'platform_support'::text AS key,
    'Support'::text AS name,
    'Help customers inside workspaces that allow support access, using the workspace support-access policy.'::text AS description,
    ARRAY[]::text[] AS permissions,
    true AS "isSystem",
    false AS "isEditable",
    false AS "isRemovable",
    NOW() AS "createdAt",
    NOW() AS "updatedAt"
)
UPDATE "AuthGroup" AS existing
SET
  "tenantId" = seed_rows."tenantId",
  "key" = seed_rows.key,
  "name" = seed_rows.name,
  "description" = seed_rows.description,
  "permissions" = seed_rows.permissions,
  "isSystem" = seed_rows."isSystem",
  "isEditable" = seed_rows."isEditable",
  "isRemovable" = seed_rows."isRemovable",
  "updatedAt" = NOW()
FROM seed_rows
WHERE existing.id = seed_rows.id
   OR (existing."tenantId" IS NULL AND existing.key = seed_rows.key);

WITH permission_bundles AS (
  SELECT
    ARRAY[
      'auth.passkeys.edit',
      'auth.passkeys.revoke',
      'auth.passkeys.view'
    ]::text[] AS auth_passkey_management_permissions,
    ARRAY[
      'auth.roles.assign',
      'auth.roles.create',
      'auth.roles.delete',
      'auth.roles.edit',
      'auth.roles.view'
    ]::text[] AS auth_role_management_permissions,
    ARRAY[
      'auth.serviceAccounts.assignRoles',
      'auth.serviceAccounts.create',
      'auth.serviceAccounts.edit',
      'auth.serviceAccounts.revoke',
      'auth.serviceAccounts.view'
    ]::text[] AS auth_service_account_management_permissions,
    ARRAY[
      'auth.users.assignRoles',
      'auth.users.changeEmail',
      'auth.users.create',
      'auth.users.delete',
      'auth.users.disableSignIn',
      'auth.users.edit',
      'auth.users.revokeSessions',
      'auth.users.view',
      'auth.users.viewSessions'
    ]::text[] AS auth_user_management_permissions
),
seed_rows AS (
  SELECT
    'platform-group-admin'::text AS id,
    NULL::text AS "tenantId",
    'admin'::text AS key,
    'Admin'::text AS name,
    'Full platform access including settings, plugins, tenants, auth management, and support-access bypass.'::text AS description,
    ARRAY['auth.bypassSupportAccess', 'auth.access.view']::text[]
      || auth_passkey_management_permissions
      || ARRAY['auth.providers.manage']::text[]
      || auth_role_management_permissions
      || auth_service_account_management_permissions
      || ARRAY['auth.sessionPolicy.manage']::text[]
      || auth_user_management_permissions
      || ARRAY['plugins.manage', 'settings.manage', 'tenants.manage']::text[] AS permissions,
    true AS "isSystem",
    false AS "isEditable",
    false AS "isRemovable",
    NOW() AS "createdAt",
    NOW() AS "updatedAt"
  FROM permission_bundles

  UNION ALL

  SELECT
    'platform-group-manager'::text AS id,
    NULL::text AS "tenantId",
    'platform_manager'::text AS key,
    'Manager'::text AS name,
    'Lead support users and manage customer workspaces without overriding workspace support-access policy.'::text AS description,
    ARRAY['auth.access.view']::text[]
      || auth_passkey_management_permissions
      || auth_role_management_permissions
      || auth_user_management_permissions
      || ARRAY['tenants.manage']::text[] AS permissions,
    true AS "isSystem",
    false AS "isEditable",
    false AS "isRemovable",
    NOW() AS "createdAt",
    NOW() AS "updatedAt"
  FROM permission_bundles

  UNION ALL

  SELECT
    'platform-group-support'::text AS id,
    NULL::text AS "tenantId",
    'platform_support'::text AS key,
    'Support'::text AS name,
    'Help customers inside workspaces that allow support access, using the workspace support-access policy.'::text AS description,
    ARRAY[]::text[] AS permissions,
    true AS "isSystem",
    false AS "isEditable",
    false AS "isRemovable",
    NOW() AS "createdAt",
    NOW() AS "updatedAt"
)
INSERT INTO "AuthGroup" ("id", "tenantId", "key", "name", "description", "permissions", "isSystem", "isEditable", "isRemovable", "createdAt", "updatedAt")
SELECT
  id,
  "tenantId",
  key,
  name,
  description,
  permissions,
  "isSystem",
  "isEditable",
  "isRemovable",
  "createdAt",
  "updatedAt"
FROM seed_rows
WHERE NOT EXISTS (
  SELECT 1
  FROM "AuthGroup" AS existing
  WHERE existing.id = seed_rows.id
     OR (existing."tenantId" IS NULL AND existing.key = seed_rows.key)
);

-- Assign existing platform users to the Admin platform group
WITH admin_group AS (
  SELECT id
  FROM "AuthGroup"
  WHERE "tenantId" IS NULL
    AND (id = 'platform-group-admin' OR key = 'admin')
  ORDER BY CASE WHEN id = 'platform-group-admin' THEN 0 ELSE 1 END, "createdAt"
  LIMIT 1
)
INSERT INTO "AuthUserGroupMembership" ("userId", "groupId", "createdAt")
SELECT "AuthUser"."id", admin_group.id, NOW()
FROM "AuthUser"
CROSS JOIN admin_group
WHERE "isPlatformUser" = true
ON CONFLICT DO NOTHING;
