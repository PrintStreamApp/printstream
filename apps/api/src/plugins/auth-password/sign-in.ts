/**
 * Password sign-in route for the `auth-password` provider.
 *
 * Verifies an email/password pair, mints a browser session, and resolves the
 * post-sign-in tenant. Failures are deliberately indistinguishable (one generic
 * 401 for unknown email, missing credential, and wrong password) and a dummy
 * verify runs on the no-credential path so response timing does not leak whether
 * an account exists.
 */
import {
  passwordSignInRequestSchema,
  passwordSignInResponseSchema
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { createUserSession, setAuthSessionCookie } from '../../lib/auth-session.js'
import { readAuthSessionMaxAgeSeconds } from '../../lib/auth-policy.js'
import { readScopedAuthProviderEnabled, writeScopedAuthProviderSetupComplete } from '../../lib/auth-provider-state.js'
import { badRequest, unauthorized } from '../../lib/http-error.js'
import type { ApiPluginContext } from '../../plugin/types.js'
import { clearTenantContextCookie, setTenantContextCookie } from '../../lib/tenant-context.js'
import { hashPassword, needsRehash, verifyPassword } from './password-hash.js'

const SIGN_IN_FAILED_MESSAGE = 'Email or password is incorrect.'

// Spent on the no-credential path so timing does not reveal account existence.
const DUMMY_PASSWORD = 'auth-password-timing-equalizer'
let dummyHashPromise: Promise<string> | undefined
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(DUMMY_PASSWORD)
  return dummyHashPromise
}

export function registerAuthPasswordSignInRoutes(context: ApiPluginContext): void {
  context.router.post('/sign-in', async (request, response) => {
    if (!(await readScopedAuthProviderEnabled(context.settings))) {
      throw unauthorized('Password sign-in is not enabled in this workspace.')
    }

    const parsed = passwordSignInRequestSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid sign-in payload.')

    annotateRequestAuditLog(request, {
      action: 'authenticate-password',
      resource: 'session',
      summary: 'Attempted to sign in with a password.',
      metadata: {
        tenantId: parsed.data.tenantId ?? null
      }
    })

    const requestedEmail = parsed.data.email.trim()
    const user = await context.prisma.authUser.findFirst({
      where: {
        email: {
          equals: requestedEmail,
          mode: 'insensitive'
        }
      },
      select: {
        id: true,
        isPlatformUser: true,
        passwordCredential: {
          select: {
            passwordHash: true
          }
        },
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
    })

    const credentialHash = user?.passwordCredential?.passwordHash ?? null
    // Always run a verify (real or dummy) before branching, to flatten timing.
    const passwordValid = await verifyPassword(credentialHash ?? (await getDummyHash()), parsed.data.password)
    const eligible = !!user && (user.isPlatformUser || user.tenantMemberships.length > 0)

    if (!user || !credentialHash || !eligible || !passwordValid) {
      throw unauthorized(SIGN_IN_FAILED_MESSAGE)
    }

    if (await needsRehash(credentialHash)) {
      try {
        const upgraded = await hashPassword(parsed.data.password)
        await context.prisma.authPasswordCredential.update({
          where: { userId: user.id },
          data: { passwordHash: upgraded }
        })
      } catch (rehashError) {
        context.logger.warn('Failed to upgrade a password hash on sign-in.', {
          userId: user.id,
          error: rehashError instanceof Error ? rehashError.message : String(rehashError)
        })
      }
    }

    await writeScopedAuthProviderSetupComplete(context.settings, true)

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
      actor: {
        type: 'user',
        userId: user.id
      },
      redirectTo: parsed.data.redirectTo ?? null
    }))
  })
}

export function resolvePostSignInTenantId(
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
