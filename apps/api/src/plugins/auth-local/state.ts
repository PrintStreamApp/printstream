/**
 * Local auth plugin state helpers.
 *
 * The passkey + email-code plugin needs a stable setup summary before the web
 * UI exists: whether first-run setup is still required, and how much auth data
 * has already been provisioned.
 */
import {
  filterPermissionDefinitionsForPlatformContext,
  filterPermissionDefinitionsForTenantContext,
  filterPermissionsForPlatformContext,
  filterPermissionsForTenantContext,
  permissionDefinitions,
  permissionValues,
  type LocalAuthStatus
} from '@printstream/shared'
import { buildAuthManagementStatus } from '../../lib/auth-management-status.js'
import { createAnonymousAuthContext } from '../../lib/auth-context.js'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { getCurrentTenant } from '../../lib/tenant-context.js'

export async function buildLocalAuthStatus(
  prisma: AnyPrismaClient,
  input: { setupComplete?: boolean | null } = {}
): Promise<LocalAuthStatus> {
  const tenant = getCurrentTenant()
  const authContext = createAnonymousAuthContext({
    authEnabled: false,
    demoMode: false
  })

  const [managementStatus, passkeys] = await Promise.all([
    buildAuthManagementStatus(prisma, authContext),
    prisma.authPasskeyCredential.count({
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
  const setupComplete = input.setupComplete === true || passkeys > 0 || (input.setupComplete == null && hasUsers)

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
      passkeys
    }
  }
}