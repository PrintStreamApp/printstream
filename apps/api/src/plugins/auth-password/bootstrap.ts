/**
 * First-run password-auth bootstrap route.
 *
 * Stays reachable while the provider is still in setup mode so a fresh install
 * can create its initial admin account before route-level auth enforcement
 * becomes active. Unlike the cloud email-code provider this needs no email
 * infrastructure: the admin chooses a password during setup and is signed in
 * immediately.
 */
import {
  bootstrapPasswordAdminRequestSchema,
  bootstrapPasswordAdminResponseSchema,
  type PasswordAuthStatus
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { createUserSession, setAuthSessionCookie } from '../../lib/auth-session.js'
import { readAuthSessionMaxAgeSeconds } from '../../lib/auth-policy.js'
import { readScopedAuthProviderEnabled, writeScopedAuthProviderSetupComplete } from '../../lib/auth-provider-state.js'
import {
  PLATFORM_ADMIN_GROUP_KEY,
  ensureBuiltInAuthGroups,
  ensureBuiltInPlatformAuthGroups
} from '../../lib/default-auth-groups.js'
import { badRequest, conflict } from '../../lib/http-error.js'
import { isUniqueConstraintError } from '../../lib/prisma-errors.js'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { clearTenantContextCookie, getCurrentTenant, setTenantContextCookie } from '../../lib/tenant-context.js'
import type { ApiPluginContext } from '../../plugin/types.js'
import { hashPassword } from './password-hash.js'

interface AuthPasswordBootstrapServices {
  buildStatus(prisma: AnyPrismaClient): Promise<PasswordAuthStatus>
  hashPassword(plain: string): Promise<string>
}

export function registerAuthPasswordBootstrapRoutes(
  context: ApiPluginContext,
  overrides: Partial<AuthPasswordBootstrapServices> = {}
): void {
  const services: AuthPasswordBootstrapServices = {
    buildStatus: async () => {
      throw new Error('buildStatus service missing')
    },
    hashPassword,
    ...overrides
  }

  context.router.post('/bootstrap/admin', async (request, response) => {
    if (!(await readScopedAuthProviderEnabled(context.settings))) {
      throw conflict('Password sign-in is not enabled in this workspace.')
    }

    const parsed = bootstrapPasswordAdminRequestSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid password bootstrap payload.')

    const status = await services.buildStatus(context.prisma)
    if (status.counts.users > 0) {
      throw conflict('The initial admin account has already been created.')
    }

    const email = parsed.data.email.trim().toLowerCase()
    const displayName = parsed.data.displayName?.trim() || null
    const tenant = getCurrentTenant()
    // Hash before opening the transaction — argon2id is intentionally slow and
    // should not hold a database transaction open.
    const passwordHash = await services.hashPassword(parsed.data.password)
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

        await tx.authPasswordCredential.create({
          data: {
            userId: user.id,
            passwordHash
          }
        })

        return {
          user,
          group: bootstrapGroup
        }
      })
      createdUserId = created.user.id

      await writeScopedAuthProviderSetupComplete(context.settings, true)

      // Sign the new admin in immediately. A session failure must not fail the
      // bootstrap — the admin can simply sign in with the password they just set.
      let authenticated = false
      try {
        const session = await createUserSession(context.prisma, created.user.id, {
          request,
          maxAgeSeconds: await readAuthSessionMaxAgeSeconds(context.prisma)
        })
        setAuthSessionCookie(response, session.secret, session.expiresAt)
        if (tenant) {
          setTenantContextCookie(response, tenant.id)
        } else {
          clearTenantContextCookie(response)
        }
        authenticated = true
      } catch (sessionError) {
        context.logger.error('Created the initial password admin but failed to start a session.', {
          userId: created.user.id,
          error: sessionError instanceof Error ? sessionError.message : String(sessionError)
        })
      }

      const nextStatus = await services.buildStatus(context.prisma)

      annotateRequestAuditLog(request, {
        action: 'bootstrap-password-admin',
        resource: 'auth user',
        summary: 'Created the initial password admin account.',
        metadata: {
          userId: created.user.id,
          email: created.user.email,
          tenantId: tenant?.id ?? null
        }
      })

      response.status(201).json(bootstrapPasswordAdminResponseSchema.parse({
        user: {
          id: created.user.id,
          email: created.user.email,
          displayName: created.user.displayName,
          createdAt: created.user.createdAt.toISOString()
        },
        group: created.group,
        authenticated,
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
      await tx.authPasswordCredential.deleteMany({ where: { userId } })
      await tx.authUserGroupMembership.deleteMany({ where: { userId } })
      await tx.authTenantMembership.deleteMany({ where: { userId } })
      await tx.authUser.delete({ where: { id: userId } })
    })
  } catch (rollbackError) {
    context.logger.error('Failed to roll back initial password admin bootstrap after an error.', {
      userId,
      error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
    })
  }
}
