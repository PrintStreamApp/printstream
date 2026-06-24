/**
 * Password auth plugin state helpers.
 *
 * Builds the setup summary the web UI needs before any session exists: whether
 * first-run setup is still required, how much auth data is provisioned, and the
 * password policy to surface in the setup/change forms.
 */
import {
  PASSWORD_POLICY,
  filterPermissionDefinitionsForPlatformContext,
  filterPermissionDefinitionsForTenantContext,
  filterPermissionsForPlatformContext,
  filterPermissionsForTenantContext,
  permissionDefinitions,
  permissionValues,
  type PasswordAuthStatus
} from '@printstream/shared'
import { buildAuthManagementStatus } from '../../lib/auth-management-status.js'
import { createAnonymousAuthContext } from '../../lib/auth-context.js'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { getCurrentTenant } from '../../lib/tenant-context.js'

export async function buildPasswordAuthStatus(
  prisma: AnyPrismaClient,
  input: { setupComplete?: boolean | null } = {}
): Promise<PasswordAuthStatus> {
  const tenant = getCurrentTenant()
  const authContext = createAnonymousAuthContext({
    authEnabled: false,
    demoMode: false
  })

  const [managementStatus, passwordCredentials] = await Promise.all([
    buildAuthManagementStatus(prisma, authContext),
    prisma.authPasswordCredential.count({
      where: {
        user: tenant
          ? {
              tenantMemberships: {
                some: {
                  tenantId: tenant.id
                }
              }
            }
          : {
              isPlatformUser: true
            }
      }
    })
  ])

  const hasUsers = managementStatus.counts.users > 0
  const setupComplete = input.setupComplete === true || passwordCredentials > 0 || (input.setupComplete == null && hasUsers)

  const initialAdminEmail = managementStatus.counts.users === 1 && !setupComplete
    ? (await prisma.authUser.findFirst({
      where: tenant
        ? {
            tenantMemberships: {
              some: {
                tenantId: tenant.id
              }
            }
          }
        : {
            isPlatformUser: true
          },
      orderBy: {
        createdAt: 'asc'
      },
      select: {
        email: true
      }
    }))?.email ?? null
    : null

  return {
    setupRequired: !hasUsers || !setupComplete,
    sessionDuration: managementStatus.sessionDuration,
    permissions: tenant
      ? filterPermissionsForTenantContext([...permissionValues])
      : filterPermissionsForPlatformContext([...permissionValues]),
    permissionDefinitions: tenant
      ? filterPermissionDefinitionsForTenantContext(permissionDefinitions)
      : filterPermissionDefinitionsForPlatformContext(permissionDefinitions),
    initialAdminEmail,
    counts: {
      users: managementStatus.counts.users,
      groups: managementStatus.counts.groups,
      serviceAccounts: managementStatus.counts.serviceAccounts,
      passwordCredentials
    },
    policy: PASSWORD_POLICY
  }
}
