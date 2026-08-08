/**
 * Shared auth-management status helpers.
 *
 * Core auth settings need a provider-agnostic summary of counts, permission
 * definitions, and browser-session policy. Provider plugins can build on top of
 * this when they need additional setup-specific data.
 */
import {
  authManagementStatusSchema,
  filterPermissionDefinitionsForPlatformContext,
  filterPermissionDefinitionsForWorkspaceContext,
  permissionDefinitions,
  type AuthManagementStatus
} from '@printstream/shared'
import type { RequestAuthContext } from './auth-context.js'
import { buildAuthManagementCapabilities, readAssignablePermissions } from './auth-capabilities.js'
import { readAuthSessionDuration } from './auth-policy.js'
import type { AnyPrismaClient } from './prisma.js'
import { getCurrentWorkspace } from './workspace-context.js'

export async function buildAuthManagementStatus(prisma: AnyPrismaClient, auth: RequestAuthContext): Promise<AuthManagementStatus> {
  const workspace = getCurrentWorkspace()
  const [users, groups, serviceAccounts, sessionDuration] = await Promise.all([
    workspace
      ? prisma.authWorkspaceMembership.count({
          where: {
            workspaceId: workspace.id
          }
        })
      : prisma.authUser.count({
          where: {
            isPlatformUser: true
          }
        }),
    prisma.authGroup.count({ where: { workspaceId: workspace?.id ?? null } }),
    workspace ? prisma.authServiceAccount.count({ where: { workspaceId: workspace.id } }) : Promise.resolve(0),
    readAuthSessionDuration(prisma)
  ])

  return authManagementStatusSchema.parse({
    sessionDuration,
    permissionDefinitions: workspace
      ? filterPermissionDefinitionsForWorkspaceContext(permissionDefinitions)
      : filterPermissionDefinitionsForPlatformContext(permissionDefinitions),
    assignablePermissions: readAssignablePermissions(auth),
    capabilities: buildAuthManagementCapabilities(auth),
    counts: {
      users,
      groups,
      serviceAccounts
    }
  })
}