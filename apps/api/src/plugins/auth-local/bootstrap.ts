/**
 * First-run local-auth bootstrap routes.
 *
 * These routes stay available while the local auth provider is still in
 * setup mode so the installation can create its initial admin account before
 * route-level auth enforcement becomes active.
 */
import {
  bootstrapLocalAdminRequestSchema,
  bootstrapLocalAdminResponseSchema,
  type LocalAuthStatus
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { readScopedAuthProviderEnabled, writeScopedAuthProviderSetupComplete } from '../../lib/auth-provider-state.js'
import type { ApiPluginContext } from '../../plugin/types.js'
import { badRequest, conflict } from '../../lib/http-error.js'
import { isUniqueConstraintError } from '../../lib/prisma-errors.js'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { readRequestLocale, readRequestTimeZone } from '../../lib/request-helpers.js'
import { getCurrentTenant } from '../../lib/tenant-context.js'
import {
  PLATFORM_ADMIN_GROUP_KEY,
  ensureBuiltInAuthGroups,
  ensureBuiltInPlatformAuthGroups
} from '../../lib/default-auth-groups.js'
import { createEmailCodeDelivery } from './email-code-delivery.js'
import { createEmailAuthCode, issueEmailCodeForUser, type EmailCodeIssuerServices } from './email-code-issuer.js'

interface AuthLocalBootstrapServices extends EmailCodeIssuerServices {
  buildStatus(prisma: AnyPrismaClient): Promise<LocalAuthStatus>
  syncProviderStatus(status: LocalAuthStatus): void
}

export function registerAuthLocalBootstrapRoutes(
  context: ApiPluginContext,
  overrides: Partial<AuthLocalBootstrapServices> = {}
): void {
  const services: AuthLocalBootstrapServices = {
    now: () => new Date(),
    createCode: createEmailAuthCode,
    deliverEmailCode: createEmailCodeDelivery(context.logger),
    buildStatus: async () => {
      throw new Error('buildStatus service missing')
    },
    syncProviderStatus: () => {},
    ...overrides
  }

  context.router.post('/bootstrap/admin', async (request, response) => {
    if (!(await readScopedAuthProviderEnabled(context.settings))) {
      throw conflict('Local Auth is not enabled in this workspace.')
    }

    const parsed = bootstrapLocalAdminRequestSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid local auth bootstrap payload.')

    const status = await services.buildStatus(context.prisma)
    if (status.counts.users > 0) {
      throw conflict('The initial admin account has already been created.')
    }

    const email = parsed.data.email.trim().toLowerCase()
    const displayName = parsed.data.displayName?.trim() || null
    const tenant = getCurrentTenant()
    let createdUserId: string | null = null

    try {
      const created = await context.prisma.$transaction(async (tx) => {
        let bootstrapGroup: { id: string; key: string | null; name: string } | null = null

        if (tenant) {
          await ensureBuiltInAuthGroups(tx, tenant.id)
        } else {
          await ensureBuiltInPlatformAuthGroups(tx)
        }

        const user = await tx.authUser.create({
          data: {
            email,
            displayName,
            isPlatformUser: !tenant
          }
        })

        if (tenant) {
          await tx.authTenantMembership.create({
            data: {
              userId: user.id,
              tenantId: tenant.id
            }
          })

          const adminGroup = await tx.authGroup.findUnique({
            where: {
              tenantId_key: {
                tenantId: tenant.id,
                key: 'admin'
              }
            }
          })

          if (!adminGroup) {
            throw conflict('Tenant admin role is not available yet.')
          }

          await tx.authUserGroupMembership.create({
            data: {
              userId: user.id,
              groupId: adminGroup.id
            }
          })

          bootstrapGroup = {
            id: adminGroup.id,
            key: adminGroup.key,
            name: adminGroup.name
          }
        } else {
          const platformAdminGroup = await tx.authGroup.findFirst({
            where: {
              tenantId: null,
              key: PLATFORM_ADMIN_GROUP_KEY
            }
          })

          if (!platformAdminGroup) {
            throw conflict('Platform admin role is not available yet.')
          }

          await tx.authUserGroupMembership.create({
            data: {
              userId: user.id,
              groupId: platformAdminGroup.id
            }
          })

          bootstrapGroup = {
            id: platformAdminGroup.id,
            key: platformAdminGroup.key,
            name: platformAdminGroup.name
          }
        }

        return {
          user,
          group: bootstrapGroup
        }
      })
      createdUserId = created.user.id

      const invite = await issueEmailCodeForUser({
        prisma: context.prisma,
        userId: created.user.id,
        email: created.user.email,
        demoMode: request.auth.runtimePolicy.demoMode,
        timeZone: readRequestTimeZone(request),
        locale: readRequestLocale(request),
        services
      })

      await writeScopedAuthProviderSetupComplete(context.settings, false)
      const nextStatus = await services.buildStatus(context.prisma)
      services.syncProviderStatus(nextStatus)

      annotateRequestAuditLog(request, {
        action: 'bootstrap-local-admin',
        resource: 'auth user',
        summary: 'Created the initial local-auth admin account.',
        metadata: {
          userId: created.user.id,
          email: created.user.email,
          tenantId: tenant?.id ?? null
        }
      })
      response.status(201).json(bootstrapLocalAdminResponseSchema.parse({
        user: {
          id: created.user.id,
          email: created.user.email,
          displayName: created.user.displayName,
          createdAt: created.user.createdAt.toISOString()
        },
        group: created.group,
        invite,
        setupRequired: nextStatus.setupRequired
      }))
    } catch (error) {
      if (createdUserId) {
        await rollbackInitialAdminBootstrap(context, createdUserId)
      }
      if (isUniqueConstraintError(error)) {
        throw conflict('An auth user with that email already exists.')
      }
      throw error
    }
  })
}

async function rollbackInitialAdminBootstrap(context: ApiPluginContext, userId: string): Promise<void> {
  try {
    await context.prisma.$transaction(async (tx) => {
      await tx.authEmailCodeToken.deleteMany({ where: { userId } })
      await tx.authUserGroupMembership.deleteMany({ where: { userId } })
      await tx.authTenantMembership.deleteMany({ where: { userId } })
      await tx.authUser.delete({ where: { id: userId } })
    })
  } catch (rollbackError) {
    context.logger.error('Failed to roll back initial admin bootstrap after an error.', {
      userId,
      error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
    })
  }
}