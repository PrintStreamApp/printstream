/**
 * Optional email password reset for the `auth-password` provider.
 *
 * Requires a configured email transport (SMTP in self-hosted, Cloudflare in
 * cloud) via the core email-delivery registry; when none is configured the
 * feature simply reports unavailable and the provider keeps working without it.
 *
 * Flow: request emails a one-time code (SHA-256 hash + expiry stored on the
 * credential); verify checks the code, sets the new password, clears the token,
 * and signs the user in. Responses never reveal whether an account exists.
 */
import crypto from 'node:crypto'
import {
  passwordResetAvailabilitySchema,
  passwordResetRequestResponseSchema,
  passwordResetRequestSchema,
  passwordResetVerifyRequestSchema,
  passwordSignInResponseSchema
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { createUserSession, setAuthSessionCookie } from '../../lib/auth-session.js'
import { readAuthSessionMaxAgeSeconds } from '../../lib/auth-policy.js'
import { isEmailDeliveryConfigured, sendEmail } from '../../lib/email-delivery.js'
import { badRequest, unauthorized } from '../../lib/http-error.js'
import { clearTenantContextCookie, setTenantContextCookie } from '../../lib/tenant-context.js'
import type { ApiPluginContext } from '../../plugin/types.js'
import { hashPassword } from './password-hash.js'
import { resolvePostSignInTenantId } from './sign-in.js'

const RESET_CODE_TTL_MS = 15 * 60_000
const RESET_FAILED_MESSAGE = 'Reset code is invalid or expired.'

function hashResetCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('base64url')
}

export function registerAuthPasswordResetRoutes(context: ApiPluginContext): void {
  // Public: lets the sign-in UI show "Forgot password?" only when it can work.
  context.router.get('/password-reset', async (_request, response) => {
    response.json(passwordResetAvailabilitySchema.parse({ available: await isEmailDeliveryConfigured() }))
  })

  context.router.post('/password-reset/request', async (request, response) => {
    const parsed = passwordResetRequestSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid password reset payload.')

    annotateRequestAuditLog(request, {
      action: 'request-password-reset',
      resource: 'account password',
      summary: 'Requested a password reset code.',
      metadata: { tenantId: parsed.data.tenantId ?? null }
    })

    // Only act when email can actually deliver; respond generically regardless so
    // the caller cannot tell whether email is configured or the account exists.
    if (await isEmailDeliveryConfigured()) {
      const requestedEmail = parsed.data.email.trim()
      const user = await context.prisma.authUser.findFirst({
        where: { email: { equals: requestedEmail, mode: 'insensitive' } },
        select: {
          id: true,
          email: true,
          isPlatformUser: true,
          passwordCredential: { select: { userId: true } },
          tenantMemberships: {
            where: parsed.data.tenantId
              ? { tenantId: parsed.data.tenantId, loginDisabled: false }
              : { loginDisabled: false },
            select: { tenantId: true }
          }
        }
      })

      const eligible = user?.passwordCredential && (user.isPlatformUser || user.tenantMemberships.length > 0)
      if (user && eligible) {
        const code = crypto.randomBytes(9).toString('base64url')
        const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MS)
        await context.prisma.authPasswordCredential.update({
          where: { userId: user.id },
          data: { resetTokenHash: hashResetCode(code), resetTokenExpiresAt: expiresAt }
        })
        try {
          await sendEmail({
            to: user.email,
            subject: 'Reset your PrintStream password',
            text: buildResetText(code, expiresAt),
            html: buildResetHtml(code, expiresAt)
          })
        } catch (error) {
          context.logger.warn('failed to send password reset email', error)
        }
      }
    }

    response.json(passwordResetRequestResponseSchema.parse({ delivered: true }))
  })

  context.router.post('/password-reset/verify', async (request, response) => {
    const parsed = passwordResetVerifyRequestSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid password reset payload.')

    const requestedEmail = parsed.data.email.trim()
    const user = await context.prisma.authUser.findFirst({
      where: { email: { equals: requestedEmail, mode: 'insensitive' } },
      select: {
        id: true,
        isPlatformUser: true,
        passwordCredential: { select: { resetTokenHash: true, resetTokenExpiresAt: true } },
        tenantMemberships: {
          where: parsed.data.tenantId
            ? { tenantId: parsed.data.tenantId, loginDisabled: false }
            : { loginDisabled: false },
          select: { tenantId: true }
        }
      }
    })

    const credential = user?.passwordCredential
    const tokenValid = Boolean(
      credential?.resetTokenHash &&
      credential.resetTokenExpiresAt &&
      credential.resetTokenExpiresAt.getTime() > Date.now() &&
      crypto.timingSafeEqual(Buffer.from(credential.resetTokenHash), Buffer.from(hashResetCode(parsed.data.code)))
    )
    const eligible = user && (user.isPlatformUser || user.tenantMemberships.length > 0)
    if (!user || !eligible || !tokenValid) {
      throw unauthorized(RESET_FAILED_MESSAGE)
    }

    const passwordHash = await hashPassword(parsed.data.newPassword)
    await context.prisma.authPasswordCredential.update({
      where: { userId: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        lastChangedAt: new Date(),
        resetTokenHash: null,
        resetTokenExpiresAt: null
      }
    })

    annotateRequestAuditLog(request, {
      action: 'reset-password',
      resource: 'account password',
      summary: 'Reset the account password with an email code.',
      metadata: { userId: user.id }
    })

    const session = await createUserSession(context.prisma, user.id, {
      request,
      maxAgeSeconds: await readAuthSessionMaxAgeSeconds(context.prisma)
    })
    setAuthSessionCookie(response, session.secret, session.expiresAt)
    const nextTenantId = resolvePostSignInTenantId(user, parsed.data.tenantId)
    if (nextTenantId) {
      setTenantContextCookie(response, nextTenantId)
    } else {
      clearTenantContextCookie(response)
    }

    response.json(passwordSignInResponseSchema.parse({
      authenticated: true,
      actor: { type: 'user', userId: user.id },
      redirectTo: null
    }))
  })
}

function buildResetText(code: string, expiresAt: Date): string {
  return [
    'Use this code to reset your PrintStream password:',
    '',
    code,
    '',
    'Enter it on the password reset screen along with your new password.',
    `This code expires at ${expiresAt.toUTCString()}.`,
    'If you did not request a reset, you can ignore this email.'
  ].join('\n')
}

function buildResetHtml(code: string, expiresAt: Date): string {
  return [
    '<p>Use this code to reset your PrintStream password:</p>',
    `<p><strong style="font-size:1.5rem;letter-spacing:0.12em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(code)}</strong></p>`,
    '<p>Enter it on the password reset screen along with your new password.</p>',
    `<p>This code expires at ${escapeHtml(expiresAt.toUTCString())}.</p>`,
    '<p>If you did not request a reset, you can ignore this email.</p>'
  ].join('')
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
