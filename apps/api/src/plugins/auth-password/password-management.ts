/**
 * Admin password management for the `auth-password` provider.
 *
 * Since this provider ships no email channel, an admin sets or resets a managed
 * user's password directly and shares it out of band; `mustChangePassword` is
 * set so the user is prompted to choose their own on next sign-in. Both routes
 * are gated by `auth.users.edit` and the per-target manageability check, so a
 * delegated manager can only touch users strictly below them.
 */
import {
  AUTH_USERS_EDIT_PERMISSION,
  adminSetPasswordRequestSchema
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import {
  assertCanManageScopedAuthUser,
  buildManageableAuthUserWhere,
  buildScopedAuthUserInclude
} from '../../lib/auth-user-memberships.js'
import { requireAuthenticatedRequestPermission } from '../../lib/authorization.js'
import { badRequest, notFound } from '../../lib/http-error.js'
import { requireRouteParam } from '../../lib/request-helpers.js'
import type { ApiPluginContext } from '../../plugin/types.js'
import { hashPassword } from './password-hash.js'

export function registerAuthPasswordManagementRoutes(context: ApiPluginContext): void {
  context.router.post('/users/:userId/password', requireAuthenticatedRequestPermission(AUTH_USERS_EDIT_PERMISSION), async (request, response) => {
    const userId = requireRouteParam(request.params.userId, 'userId')
    const parsed = adminSetPasswordRequestSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid set-password payload.')

    const user = await context.prisma.authUser.findFirst({
      where: buildManageableAuthUserWhere(userId),
      include: buildScopedAuthUserInclude()
    })
    if (!user) throw notFound('Auth user not found.')
    assertCanManageScopedAuthUser(request.auth, user)

    const passwordHash = await hashPassword(parsed.data.password)
    await context.prisma.authPasswordCredential.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        passwordHash,
        mustChangePassword: true
      },
      update: {
        passwordHash,
        mustChangePassword: true,
        lastChangedAt: new Date()
      }
    })

    annotateRequestAuditLog(request, {
      action: 'set-managed-password',
      resource: 'account password',
      summary: `Set a password for ${user.email}.`,
      metadata: {
        userId: user.id,
        email: user.email
      }
    })

    response.status(204).end()
  })

  context.router.delete('/users/:userId/password', requireAuthenticatedRequestPermission(AUTH_USERS_EDIT_PERMISSION), async (request, response) => {
    const userId = requireRouteParam(request.params.userId, 'userId')
    const user = await context.prisma.authUser.findFirst({
      where: buildManageableAuthUserWhere(userId),
      include: buildScopedAuthUserInclude()
    })
    if (!user) throw notFound('Auth user not found.')
    assertCanManageScopedAuthUser(request.auth, user)

    await context.prisma.authPasswordCredential.deleteMany({ where: { userId: user.id } })

    annotateRequestAuditLog(request, {
      action: 'remove-managed-password',
      resource: 'account password',
      summary: `Removed the password for ${user.email}.`,
      metadata: {
        userId: user.id,
        email: user.email
      }
    })

    response.status(204).end()
  })
}
