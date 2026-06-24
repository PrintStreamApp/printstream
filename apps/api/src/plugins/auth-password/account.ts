/**
 * Self-service password routes for the signed-in account.
 *
 * - `GET /me/password` reports whether the account has a password and whether a
 *   change is required (set when an admin last set/reset it).
 * - `POST /me/password/change` re-verifies the current password (the proof of
 *   identity for this sensitive change) before storing the new one and clearing
 *   the must-change flag.
 */
import {
  accountPasswordStatusSchema,
  changeOwnPasswordRequestSchema
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { AUTHENTICATION_REQUIRED_MESSAGE } from '../../lib/authorization.js'
import { badRequest, unauthorized } from '../../lib/http-error.js'
import type { ApiPluginContext } from '../../plugin/types.js'
import { hashPassword, verifyPassword } from './password-hash.js'

export function registerAuthPasswordAccountRoutes(context: ApiPluginContext): void {
  context.router.get('/me/password', async (request, response) => {
    const userId = requireCurrentUserId(request)
    const credential = await context.prisma.authPasswordCredential.findUnique({
      where: { userId },
      select: {
        mustChangePassword: true,
        lastChangedAt: true
      }
    })

    response.json(accountPasswordStatusSchema.parse({
      hasPassword: credential != null,
      mustChangePassword: credential?.mustChangePassword ?? false,
      lastChangedAt: credential?.lastChangedAt.toISOString() ?? null
    }))
  })

  context.router.post('/me/password/change', async (request, response) => {
    const userId = requireCurrentUserId(request)
    const parsed = changeOwnPasswordRequestSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid password change payload.')

    const credential = await context.prisma.authPasswordCredential.findUnique({
      where: { userId },
      select: { passwordHash: true }
    })

    if (!credential || !(await verifyPassword(credential.passwordHash, parsed.data.currentPassword))) {
      throw unauthorized('Current password is incorrect.')
    }

    const passwordHash = await hashPassword(parsed.data.newPassword)
    await context.prisma.authPasswordCredential.update({
      where: { userId },
      data: {
        passwordHash,
        mustChangePassword: false,
        lastChangedAt: new Date()
      }
    })

    annotateRequestAuditLog(request, {
      action: 'change-password',
      resource: 'account password',
      summary: 'Changed the current account password.',
      metadata: {
        userId
      }
    })

    response.status(204).end()
  })
}

function requireCurrentUserId(request: import('express').Request): string {
  if (request.auth.actor.type !== 'user') {
    throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
  }
  return request.auth.actor.userId
}
