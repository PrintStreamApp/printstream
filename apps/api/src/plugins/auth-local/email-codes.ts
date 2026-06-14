/**
 * Local-auth one-time email-code issuance and verification routes.
 */
import {
  emailCodeRequestRequestSchema,
  emailCodeRequestResponseSchema,
  emailCodeVerifyRequestSchema,
  emailCodeVerifyResponseSchema
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { createUserSession, setAuthSessionCookie } from '../../lib/auth-session.js'
import { readAuthSessionMaxAgeSeconds } from '../../lib/auth-policy.js'
import { readScopedAuthProviderEnabled, writeScopedAuthProviderSetupComplete } from '../../lib/auth-provider-state.js'
import { env } from '../../lib/env.js'
import { badRequest, conflict, unauthorized } from '../../lib/http-error.js'
import { isUniqueConstraintError } from '../../lib/prisma-errors.js'
import type { ApiPluginContext } from '../../plugin/types.js'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { readRequestLocale, readRequestTimeZone } from '../../lib/request-helpers.js'
import { clearTenantContextCookie, getCurrentTenant, setTenantContextCookie } from '../../lib/tenant-context.js'
import { createEmailCodeDelivery, type EmailCodeDeliveryResult } from './email-code-delivery.js'
import { createEmailAuthCode, hashEmailAuthCode, issueEmailCodeForUser, normalizeEmailAuthAddress } from './email-code-issuer.js'

type AuthLocalEmailCodeServices = {
  now(): Date
  createCode(): string
  deliverEmailCode(input: {
    email: string
    code: string
    expiresAt: Date
    demoMode: boolean
    timeZone?: string | null
    locale?: string | null
  }): Promise<EmailCodeDeliveryResult>
}

export function registerAuthLocalEmailCodeRoutes(
  context: ApiPluginContext,
  overrides: Partial<AuthLocalEmailCodeServices> = {}
): void {
  const services: AuthLocalEmailCodeServices = {
    now: () => new Date(),
    createCode: createEmailAuthCode,
    deliverEmailCode: createEmailCodeDelivery(context.logger),
    ...overrides
  }

  context.router.post('/email-codes/request', async (request, response) => {
    if (!(await readScopedAuthProviderEnabled(context.settings))) {
      throw unauthorized('Local Auth is not enabled in this workspace.')
    }

    const parsed = emailCodeRequestRequestSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid email-code request payload.')
    const requestedEmail = parsed.data.email.trim()

    annotateRequestAuditLog(request, {
      action: 'request-email-code',
      resource: 'auth email code',
      summary: 'Requested a one-time email sign-in code.',
      metadata: {
        tenantId: parsed.data.tenantId ?? null
      }
    })

    const existingUser = await context.prisma.authUser.findFirst({
      where: {
        email: {
          equals: requestedEmail,
          mode: 'insensitive'
        }
      },
      select: {
        id: true,
        email: true,
        isPlatformUser: true,
        tenantMemberships: {
          where: parsed.data.tenantId
            ? {
                tenantId: parsed.data.tenantId,
                loginDisabled: false
              }
            : {
                loginDisabled: false
              },
          select: {
            tenantId: true,
            tenant: {
              select: {
                id: true,
                slug: true,
                name: true
              }
            }
          }
        }
      }
    })

    const user = existingUser && (existingUser.isPlatformUser || existingUser.tenantMemberships.length > 0)
      ? {
          id: existingUser.id,
          email: existingUser.email,
          loginDisabled: false,
          existingIdentity: true
        }
      : await findPendingInitialAdminForSetup(context.prisma, parsed.data.tenantId, requestedEmail)

    if (!user || user.loginDisabled) {
      const expiresAt = new Date(services.now().getTime() + env.AUTH_LOCAL_EMAIL_CODE_TTL_MINUTES * 60_000)
      response.json(emailCodeRequestResponseSchema.parse({
        delivered: true,
        requiresTenantSelection: false,
        tenants: [],
        expiresAt: expiresAt.toISOString(),
        previewCode: null
      }))
      return
    }

    const invite = await issueEmailCodeForUser({
      prisma: context.prisma,
      userId: user.id,
      email: user.existingIdentity ? user.email : requestedEmail,
      redirectTo: parsed.data.redirectTo ?? null,
      demoMode: request.auth.runtimePolicy.demoMode,
      timeZone: parsed.data.timeZone ?? readRequestTimeZone(request),
      locale: readRequestLocale(request),
      services
    })

    response.json(emailCodeRequestResponseSchema.parse(invite))
  })

  context.router.post('/email-codes/verify', async (request, response) => {
    if (!(await readScopedAuthProviderEnabled(context.settings))) {
      throw unauthorized('Local Auth is not enabled in this workspace.')
    }

    const parsed = emailCodeVerifyRequestSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid email-code verify payload.')

    annotateRequestAuditLog(request, {
      action: 'authenticate-email-code',
      resource: 'session',
      summary: 'Attempted to sign in with a one-time email code.',
      metadata: {
        tenantId: parsed.data.tenantId ?? null
      }
    })

    const now = services.now()
    const normalizedEmail = normalizeEmailAuthAddress(parsed.data.email)
    const token = await context.prisma.authEmailCodeToken.findFirst({
      where: {
        email: normalizedEmail,
        consumedAt: null,
        expiresAt: {
          gt: now
        }
      },
      orderBy: {
        createdAt: 'desc'
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            isPlatformUser: true,
            tenantMemberships: {
              where: parsed.data.tenantId
                ? {
                    tenantId: parsed.data.tenantId,
                    loginDisabled: false
                  }
                : {
                    loginDisabled: false
                  },
              select: {
                tenantId: true
              }
            }
          }
        }
      }
    })

    if (!token || token.tokenHash !== hashEmailAuthCode(parsed.data.code) || !token.user) {
      throw unauthorized('Email code is invalid or expired.')
    }

    if (!token.user.isPlatformUser && token.user.tenantMemberships.length === 0) {
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

    if (normalizeEmailAuthAddress(token.user.email) !== token.email) {
      try {
        await context.prisma.authUser.update({
          where: { id: token.user.id },
          data: { email: token.email }
        })
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw conflict('An auth user with that email already exists.')
        }
        throw error
      }
    }

    await writeScopedAuthProviderSetupComplete(context.settings, true)

    const session = await createUserSession(context.prisma, token.user.id, {
      request,
      maxAgeSeconds: await readAuthSessionMaxAgeSeconds(context.prisma)
    })
    setAuthSessionCookie(response, session.secret, session.expiresAt)
    const nextTenantId = resolvePostSignInTenantId(token.user, parsed.data.tenantId)
    if (nextTenantId) {
      setTenantContextCookie(response, nextTenantId)
    } else {
      clearTenantContextCookie(response)
    }

    response.json(emailCodeVerifyResponseSchema.parse({
      authenticated: true,
      actor: {
        type: 'user',
        userId: token.user.id
      },
      redirectTo: token.redirectTo ?? null
    }))
  })
}

/**
 * Find a pending initial admin during setup (no passkey registered yet).
 *
 * Security: only returns a match if the requested email matches the
 * admin's registered email (case-insensitive). This prevents an
 * attacker from requesting a code for a different address (e.g. a
 * Gmail +alias) and hijacking the initial platform account during setup.
 */
async function findPendingInitialAdminForSetup(prisma: AnyPrismaClient, tenantId?: string, requestedEmail?: string): Promise<{
  id: string
  email: string
  loginDisabled: boolean
  existingIdentity: false
} | null> {
  const currentTenant = getCurrentTenant()
  const scopedTenantId = tenantId ?? currentTenant?.id ?? null
  const users = await prisma.authUser.findMany({
    where: scopedTenantId
      ? {
        tenantMemberships: {
          some: {
            tenantId: scopedTenantId,
            loginDisabled: false
          }
        }
      }
      : {
        isPlatformUser: true
      },
    orderBy: {
      createdAt: 'asc'
    },
    take: 2,
    select: {
      id: true,
      email: true
    }
  })

  if (users.length !== 1) {
    return null
  }

  const [user] = users
  if (!user) {
    return null
  }

  // Only allow the pending-admin flow if the requested email matches the
  // admin's registered email. Without this check, an attacker could
  // request a code for a different address and hijack the account.
  if (requestedEmail && normalizeEmailAuthAddress(requestedEmail) !== normalizeEmailAuthAddress(user.email)) {
    return null
  }

  const passkeyCount = await prisma.authPasskeyCredential.count({
    where: {
      userId: user.id
    }
  })

  return passkeyCount === 0
    ? {
        id: user.id,
        email: user.email,
        loginDisabled: false,
        existingIdentity: false
      }
    : null
}

function resolvePostSignInTenantId(
  user: {
    isPlatformUser: boolean
    tenantMemberships: Array<{ tenantId: string }>
  },
  requestedTenantId?: string
): string | null {
  if (requestedTenantId && user.tenantMemberships.some((membership) => membership.tenantId === requestedTenantId)) {
    return requestedTenantId
  }

  if (!user.isPlatformUser && user.tenantMemberships.length === 1) {
    return user.tenantMemberships[0]?.tenantId ?? null
  }

  return null
}