/**
 * Provider-specific auth-local account management routes.
 *
 * These endpoints keep the provider-owned credential flows separate from the
 * reusable core auth management surface. Local auth still owns passkey admin
 * operations, one-time email-code invites, and email-based address changes.
 */
import {
  AUTH_PASSKEYS_EDIT_PERMISSION,
  AUTH_PASSKEYS_REVOKE_PERMISSION,
  AUTH_PASSKEYS_VIEW_PERMISSION,
  AUTH_USERS_EDIT_PERMISSION,
  authUserInviteResponseSchema,
  authUserPasskeyListResponseSchema,
  authUserResponseSchema,
  requestCurrentAuthUserEmailChangeRequestSchema,
  requestCurrentAuthUserEmailChangeResponseSchema,
  updateAuthUserPasskeyRequestSchema,
  updateAuthUserPasskeyResponseSchema,
  verifyCurrentAuthUserEmailChangeRequestSchema,
  type LocalAuthStatus
} from '@printstream/shared'
import { z } from 'zod'
import type { ApiPluginContext } from '../../plugin/types.js'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import {
  buildCurrentAuthUserWhere,
  buildManageableAuthUserWhere,
  buildScopedAuthUserInclude,
  readScopedAuthUserLoginDisabled,
  toAuthUserDto,
  type ScopedAuthUserRow
} from '../../lib/auth-user-memberships.js'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { readRequestLocale, readRequestTimeZone, requireRouteParam } from '../../lib/request-helpers.js'
import { AUTHENTICATION_REQUIRED_MESSAGE, requireAuthenticatedCurrentUser, requireAuthenticatedRequestPermission } from '../../lib/authorization.js'
import { badRequest, conflict, notFound, unauthorized } from '../../lib/http-error.js'
import { isUniqueConstraintError } from '../../lib/prisma-errors.js'
import { createEmailCodeDelivery } from './email-code-delivery.js'
import { createEmailAuthCode, hashEmailAuthCode, issueEmailCodeForUser, type EmailCodeIssuerServices } from './email-code-issuer.js'

type AuthUserPasskeyRow = {
  id: string
  nickname: string | null
  aaguid: string | null
  transports: string[]
  backedUp: boolean
  lastUsedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const authUserInviteRequestSchema = z.object({
  inviteUrl: z.string().trim().url().max(2048).nullable().optional()
})

export type AuthLocalProviderManagementServices = EmailCodeIssuerServices & {
  buildStatus(prisma: AnyPrismaClient): Promise<LocalAuthStatus>
  syncProviderStatus(status: LocalAuthStatus): void
}

export function registerAuthLocalProviderManagementRoutes(
  context: ApiPluginContext,
  overrides: Partial<AuthLocalProviderManagementServices> = {}
): void {
  const services: AuthLocalProviderManagementServices = {
    now: () => new Date(),
    createCode: createEmailAuthCode,
    deliverEmailCode: createEmailCodeDelivery(context.logger),
    buildStatus: async () => {
      throw new Error('buildStatus service missing')
    },
    syncProviderStatus: () => {},
    ...overrides
  }

  context.router.post('/me/email-change/request', requireAuthenticatedCurrentUser(), async (request, response) => {
    const parsed = requestCurrentAuthUserEmailChangeRequestSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid email change request payload.')

    const existing = await requireCurrentAuthUser(context.prisma, request)
    const nextEmail = parsed.data.email.trim().toLowerCase()

    if (nextEmail === existing.email) {
      throw conflict('Enter a different email address to change this account email.')
    }

    const conflictingUser = await context.prisma.authUser.findFirst({
      where: {
        email: {
          equals: nextEmail,
          mode: 'insensitive'
        },
        id: {
          not: existing.id
        }
      },
      select: {
        id: true
      }
    })

    if (conflictingUser) {
      throw conflict('An auth user with that email already exists.')
    }

    const verification = await issueEmailCodeForUser({
      prisma: context.prisma,
      userId: existing.id,
      email: nextEmail,
      demoMode: request.auth.runtimePolicy.demoMode,
      timeZone: parsed.data.timeZone ?? readRequestTimeZone(request),
      locale: readRequestLocale(request),
      services
    })

    annotateRequestAuditLog(request, {
      action: 'request-email-change',
      resource: 'account email',
      summary: 'Requested an email change verification code.',
      metadata: {
        userId: existing.id
      }
    })

    response.json(requestCurrentAuthUserEmailChangeResponseSchema.parse(verification))
  })

  context.router.post('/me/email-change/verify', requireAuthenticatedCurrentUser(), async (request, response) => {
    const parsed = verifyCurrentAuthUserEmailChangeRequestSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid email change verify payload.')

    const existing = await requireCurrentAuthUser(context.prisma, request)
    const nextEmail = parsed.data.email.trim().toLowerCase()

    if (nextEmail === existing.email) {
      throw conflict('Enter a different email address to change this account email.')
    }

    const now = services.now()
    const token = await context.prisma.authEmailCodeToken.findFirst({
      where: {
        userId: existing.id,
        email: nextEmail,
        consumedAt: null,
        expiresAt: {
          gt: now
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    })

    if (!token || token.tokenHash !== hashEmailAuthCode(parsed.data.code)) {
      throw unauthorized('Email code is invalid or expired.')
    }

    const consumed = await context.prisma.authEmailCodeToken.updateMany({
      where: {
        id: token.id,
        consumedAt: null
      },
      data: {
        consumedAt: now
      }
    })

    if (consumed.count !== 1) {
      throw unauthorized('Email code is invalid or expired.')
    }

    try {
      await context.prisma.authUser.update({
        where: { id: existing.id },
        data: {
          email: nextEmail,
          displayName: parsed.data.displayName?.trim() || null
        }
      })
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw conflict('An auth user with that email already exists.')
      }
      throw error
    }

    const updated = await context.prisma.authUser.findFirst({
      where: buildCurrentAuthUserWhere(existing.id),
      include: buildScopedAuthUserInclude()
    })
    if (!updated) throw notFound('Auth user not found.')

    annotateRequestAuditLog(request, {
      action: 'verify-email-change',
      resource: 'account email',
      summary: 'Changed the current account email address.',
      metadata: {
        userId: updated.id,
        email: updated.email
      }
    })

    response.json(authUserResponseSchema.parse({
      user: toAuthUserDto(updated)
    }))
  })

  context.router.post('/users/:userId/invite', requireAuthenticatedRequestPermission(AUTH_USERS_EDIT_PERMISSION), async (request, response) => {
    const userId = requireRouteParam(request.params.userId, 'userId')
    const parsed = authUserInviteRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid auth user invite payload.')
    const user = await context.prisma.authUser.findFirst({
      where: buildManageableAuthUserWhere(userId),
      include: buildScopedAuthUserInclude()
    })
    if (!user) throw notFound('Auth user not found.')
    if (readScopedAuthUserLoginDisabled(user)) {
      throw conflict('Disabled users cannot receive a sign-in invite.')
    }

    const invite = await issueEmailCodeForUser({
      prisma: context.prisma,
      userId: user.id,
      email: user.email,
      redirectTo: '/account',
      inviteUrl: parsed.data.inviteUrl ?? null,
      demoMode: request.auth.runtimePolicy.demoMode,
      timeZone: readRequestTimeZone(request),
      locale: readRequestLocale(request),
      services
    })

    annotateRequestAuditLog(request, {
      action: 'send-auth-user-invite',
      resource: 'auth user',
      summary: `Sent a sign-in invite to ${user.email}.`,
      metadata: {
        userId: user.id,
        email: user.email
      }
    })

    response.json(authUserInviteResponseSchema.parse({ invite }))
  })

  context.router.get('/users/:userId/passkeys', requireAuthenticatedRequestPermission(AUTH_PASSKEYS_VIEW_PERMISSION), async (request, response) => {
    const userId = requireRouteParam(request.params.userId, 'userId')
    const user = await context.prisma.authUser.findFirst({ where: buildManageableAuthUserWhere(userId) })
    if (!user) throw notFound('Auth user not found.')

    const passkeys = await context.prisma.authPasskeyCredential.findMany({
      where: { userId },
      orderBy: [
        { lastUsedAt: 'desc' },
        { createdAt: 'desc' }
      ]
    })

    response.json(authUserPasskeyListResponseSchema.parse({
      passkeys: passkeys.map(toAuthUserPasskeyDto)
    }))
  })

  context.router.patch('/users/:userId/passkeys/:passkeyId', requireAuthenticatedRequestPermission(AUTH_PASSKEYS_EDIT_PERMISSION), async (request, response) => {
    const userId = requireRouteParam(request.params.userId, 'userId')
    const passkeyId = requireRouteParam(request.params.passkeyId, 'passkeyId')
    const parsed = updateAuthUserPasskeyRequestSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid passkey update payload.')

    const user = await context.prisma.authUser.findFirst({ where: buildManageableAuthUserWhere(userId) })
    if (!user) throw notFound('Auth user not found.')

    const passkey = await context.prisma.authPasskeyCredential.findFirst({
      where: {
        id: passkeyId,
        userId
      }
    })
    if (!passkey) throw notFound('Passkey not found.')

    const updated = await context.prisma.authPasskeyCredential.update({
      where: { id: passkeyId },
      data: {
        nickname: parsed.data.nickname
      }
    })

    annotateRequestAuditLog(request, {
      action: 'rename-managed-passkey',
      resource: 'passkey',
      summary: `Updated a managed passkey for ${user.email}.`,
      metadata: {
        userId: user.id,
        passkeyId: updated.id
      }
    })

    response.json(updateAuthUserPasskeyResponseSchema.parse({
      passkey: toAuthUserPasskeyDto(updated)
    }))
  })

  context.router.post('/users/:userId/passkeys/:passkeyId/revoke', requireAuthenticatedRequestPermission(AUTH_PASSKEYS_REVOKE_PERMISSION), async (request, response) => {
    const userId = requireRouteParam(request.params.userId, 'userId')
    const passkeyId = requireRouteParam(request.params.passkeyId, 'passkeyId')
    const user = await context.prisma.authUser.findFirst({ where: buildManageableAuthUserWhere(userId) })
    if (!user) throw notFound('Auth user not found.')

    const passkey = await context.prisma.authPasskeyCredential.findFirst({
      where: {
        id: passkeyId,
        userId
      }
    })
    if (!passkey) throw notFound('Passkey not found.')

    await context.prisma.authPasskeyCredential.delete({ where: { id: passkeyId } })
    const nextStatus = await services.buildStatus(context.prisma)
    services.syncProviderStatus(nextStatus)

    annotateRequestAuditLog(request, {
      action: 'revoke-managed-passkey',
      resource: 'passkey',
      summary: `Revoked a managed passkey for ${user.email}.`,
      metadata: {
        userId: user.id,
        passkeyId: passkey.id
      }
    })
    response.status(204).send()
  })
}

async function requireCurrentAuthUser(prisma: AnyPrismaClient, request: import('express').Request): Promise<ScopedAuthUserRow> {
  if (request.auth.actor.type !== 'user') {
    throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
  }

  const user = await prisma.authUser.findFirst({
    where: buildCurrentAuthUserWhere(request.auth.actor.userId),
    include: buildScopedAuthUserInclude()
  })
  if (!user || readScopedAuthUserLoginDisabled(user)) {
    throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
  }
  return user
}

function toAuthUserPasskeyDto(row: AuthUserPasskeyRow) {
  return {
    id: row.id,
    nickname: row.nickname,
    aaguid: row.aaguid,
    transports: row.transports,
    backedUp: row.backedUp,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}
