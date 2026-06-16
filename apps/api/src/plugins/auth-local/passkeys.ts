/**
 * Local-auth passkey registration and authentication routes.
 *
 * Registration is only available to the currently authenticated setup user.
 * Authentication uses discoverable credentials so the user can sign in with a
 * single passkey gesture once setup is complete.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type GenerateAuthenticationOptionsOpts,
  type GenerateRegistrationOptionsOpts,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse
} from '@simplewebauthn/server'
import {
  authUserPasskeyListResponseSchema,
  passkeyAuthenticationBeginResponseSchema,
  passkeyAuthenticationFinishRequestSchema,
  passkeyAuthenticationFinishResponseSchema,
  passkeyRegistrationBeginResponseSchema,
  passkeyRegistrationFinishRequestSchema,
  passkeyRegistrationFinishResponseSchema,
  updateAuthUserPasskeyRequestSchema,
  updateAuthUserPasskeyResponseSchema,
  type LocalAuthStatus
} from '@printstream/shared'
import type { Request, Response } from 'express'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { requireRouteParam } from '../../lib/request-helpers.js'
import { env } from '../../lib/env.js'
import { readScopedAuthProviderEnabled } from '../../lib/auth-provider-state.js'
import { badRequest, notFound, unauthorized } from '../../lib/http-error.js'
import { AUTHENTICATION_REQUIRED_MESSAGE } from '../../lib/authorization.js'
import { readAuthSessionMaxAgeSeconds } from '../../lib/auth-policy.js'
import { readScopedAuthUserLoginDisabled } from '../../lib/auth-user-memberships.js'
import {
  createUserSession,
  readRequestCookie,
  requireRecentUserSession,
  setAuthSessionCookie,
  setCookieHeader
} from '../../lib/auth-session.js'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { clearTenantContextCookie, getCurrentTenant, setTenantContextCookie } from '../../lib/tenant-context.js'
import type { ApiPluginContext } from '../../plugin/types.js'

const AUTH_CHALLENGE_COOKIE_NAME = 'printstream_auth_challenge'
const AUTH_CHALLENGE_MAX_AGE_SECONDS = 60 * 10

type PasskeyRegistrationOptions = Awaited<ReturnType<typeof generateRegistrationOptions>>
type PasskeyAuthenticationOptions = Awaited<ReturnType<typeof generateAuthenticationOptions>>
type AuthUserPasskeyRow = {
  id: string
  nickname: string | null
  aaguid: string | null
  transports: string[] | null
  backedUp: boolean
  lastUsedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type AuthLocalPasskeyServices = {
  buildStatus(prisma: AnyPrismaClient): Promise<LocalAuthStatus>
  syncProviderStatus(status: LocalAuthStatus): void
  beginRegistration(options: GenerateRegistrationOptionsOpts): Promise<PasskeyRegistrationOptions>
  finishRegistration(input: Parameters<typeof verifyRegistrationResponse>[0]): Promise<VerifiedRegistrationResponse>
  beginAuthentication(options: GenerateAuthenticationOptionsOpts): Promise<PasskeyAuthenticationOptions>
  finishAuthentication(input: Parameters<typeof verifyAuthenticationResponse>[0]): Promise<VerifiedAuthenticationResponse>
}

const defaultServices: AuthLocalPasskeyServices = {
  buildStatus: async () => {
    throw new Error('buildStatus service missing')
  },
  syncProviderStatus: () => {},
  beginRegistration: async (options) => generateRegistrationOptions(options),
  finishRegistration: async (input) => verifyRegistrationResponse(input),
  beginAuthentication: async (options) => generateAuthenticationOptions(options),
  finishAuthentication: async (input) => verifyAuthenticationResponse(input)
}

export function registerAuthLocalPasskeyRoutes(
  context: ApiPluginContext,
  overrides: Partial<AuthLocalPasskeyServices>
): void {
  const services: AuthLocalPasskeyServices = { ...defaultServices, ...overrides }

  context.router.get('/passkeys', async (request, response) => {
    const user = await requireCurrentUser(context.prisma, request)
    const passkeys = await context.prisma.authPasskeyCredential.findMany({
      where: { userId: user.id },
      orderBy: [
        { lastUsedAt: 'desc' },
        { createdAt: 'desc' }
      ]
    })

    response.json(authUserPasskeyListResponseSchema.parse({
      passkeys: passkeys.map(toAuthUserPasskeyDto)
    }))
  })

  context.router.post('/passkeys/:passkeyId/revoke', async (request, response) => {
    const user = await requireCurrentUser(context.prisma, request)
    await requireRecentUserSession(context.prisma, request, user.id)
    const passkeyId = requireRouteParam(request.params.passkeyId, 'passkeyId')
    const passkey = await context.prisma.authPasskeyCredential.findFirst({
      where: {
        id: passkeyId,
        userId: user.id
      }
    })

    if (!passkey) {
      throw notFound('Passkey not found.')
    }

    await context.prisma.authPasskeyCredential.delete({ where: { id: passkeyId } })
    const nextStatus = await services.buildStatus(context.prisma)
    services.syncProviderStatus(nextStatus)

    annotateRequestAuditLog(request, {
      action: 'revoke-passkey',
      resource: 'passkey',
      summary: 'Revoked a passkey from the current account.',
      metadata: {
        userId: user.id,
        passkeyId: passkey.id
      }
    })
    response.status(204).end()
  })

  context.router.patch('/passkeys/:passkeyId', async (request, response) => {
    const user = await requireCurrentUser(context.prisma, request)
    const passkeyId = requireRouteParam(request.params.passkeyId, 'passkeyId')
    const parsed = updateAuthUserPasskeyRequestSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid passkey update payload.')

    const passkey = await context.prisma.authPasskeyCredential.findFirst({
      where: {
        id: passkeyId,
        userId: user.id
      }
    })

    if (!passkey) {
      throw notFound('Passkey not found.')
    }

    const updated = await context.prisma.authPasskeyCredential.update({
      where: { id: passkeyId },
      data: {
        nickname: parsed.data.nickname
      }
    })

    annotateRequestAuditLog(request, {
      action: 'rename-passkey',
      resource: 'passkey',
      summary: 'Updated a passkey nickname on the current account.',
      metadata: {
        userId: user.id,
        passkeyId: updated.id
      }
    })

    response.json(updateAuthUserPasskeyResponseSchema.parse({
      passkey: toAuthUserPasskeyDto(updated)
    }))
  })

  context.router.post('/passkeys/register/options', async (request, response) => {
    if (!(await readScopedAuthProviderEnabled(context.settings))) {
      throw unauthorized('Local Auth is not enabled in this workspace.')
    }

    const user = await requireCurrentUser(context.prisma, request)
    await requireRecentUserSession(context.prisma, request, user.id)
    const rp = getRelyingParty()
    const options = await services.beginRegistration({
      rpName: 'PrintStream',
      rpID: rp.id,
      userName: user.email,
      userDisplayName: user.displayName ?? user.email,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'preferred'
      },
      excludeCredentials: user.passkeys.map((passkey) => ({
        id: passkey.credentialId,
        transports: passkey.transports as AuthenticatorTransport[]
      }))
    })

    setChallengeCookie(response, `registration:${options.challenge}`)
    response.json(passkeyRegistrationBeginResponseSchema.parse({ options }))
  })

  context.router.post('/passkeys/register/verify', async (request, response) => {
    if (!(await readScopedAuthProviderEnabled(context.settings))) {
      throw unauthorized('Local Auth is not enabled in this workspace.')
    }

    const user = await requireCurrentUser(context.prisma, request)
    await requireRecentUserSession(context.prisma, request, user.id)
    const parsed = passkeyRegistrationFinishRequestSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid passkey registration payload.')

    const challenge = requireChallenge(request, 'registration')
    const rp = getRelyingParty()
    const verified = await services.finishRegistration({
      response: parsed.data.response as Parameters<typeof verifyRegistrationResponse>[0]['response'],
      expectedChallenge: challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.id,
      requireUserVerification: false
    })
    if (!verified.verified || !verified.registrationInfo) {
      throw badRequest('Passkey registration could not be verified.')
    }

    await context.prisma.authPasskeyCredential.create({
      data: {
        userId: user.id,
        credentialId: verified.registrationInfo.credential.id,
        publicKey: Buffer.from(verified.registrationInfo.credential.publicKey),
        transports: normalizeTransports(parsed.data.response),
        counter: verified.registrationInfo.credential.counter,
        aaguid: verified.registrationInfo.aaguid,
        backedUp: verified.registrationInfo.credentialBackedUp,
        nickname: parsed.data.nickname ?? null,
        lastUsedAt: null
      }
    })

    clearChallengeCookie(response)
    const nextStatus = await services.buildStatus(context.prisma)
    services.syncProviderStatus(nextStatus)
    const latest = await context.prisma.authPasskeyCredential.findUniqueOrThrow({
      where: { credentialId: verified.registrationInfo.credential.id }
    })

    annotateRequestAuditLog(request, {
      action: 'register-passkey',
      resource: 'passkey',
      summary: 'Registered a new passkey for the current account.',
      metadata: {
        userId: user.id,
        passkeyId: latest.id
      }
    })
    response.status(201).json(passkeyRegistrationFinishResponseSchema.parse({
      credential: {
        id: latest.id,
        nickname: latest.nickname,
        createdAt: latest.createdAt.toISOString()
      },
      setupRequired: nextStatus.setupRequired
    }))
  })

  context.router.post('/passkeys/authenticate/options', async (_request, response) => {
    if (!(await readScopedAuthProviderEnabled(context.settings))) {
      throw unauthorized('Local Auth is not enabled in this workspace.')
    }

    const rp = getRelyingParty()
    const options = await services.beginAuthentication({
      rpID: rp.id,
      userVerification: 'preferred'
    })

    setChallengeCookie(response, `authentication:${options.challenge}`)
    response.json(passkeyAuthenticationBeginResponseSchema.parse({ options }))
  })

  context.router.post('/passkeys/authenticate/verify', async (request, response) => {
    if (!(await readScopedAuthProviderEnabled(context.settings))) {
      throw unauthorized('Local Auth is not enabled in this workspace.')
    }

    const parsed = passkeyAuthenticationFinishRequestSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid passkey authentication payload.')

    annotateRequestAuditLog(request, {
      action: 'authenticate-passkey',
      resource: 'session',
      summary: 'Attempted to sign in with a passkey.'
    })

    const credentialId = readCredentialId(parsed.data.response)
    const storedCredential = await context.prisma.authPasskeyCredential.findUnique({
      where: { credentialId },
      include: {
        user: {
          select: {
            id: true,
            isPlatformUser: true,
            tenantMemberships: {
              where: getCurrentTenant()?.id
                ? {
                    tenantId: getCurrentTenant()!.id
                  }
                : {
                    loginDisabled: false
                  },
              select: {
                tenantId: true,
                loginDisabled: true
              }
            }
          }
        }
      }
    })

    if (!storedCredential || !storedCredential.user) {
      throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
    }

    if (!storedCredential.user.isPlatformUser && storedCredential.user.tenantMemberships.every((membership) => membership.loginDisabled)) {
      throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
    }

    const challenge = requireChallenge(request, 'authentication')
    const rp = getRelyingParty()
    const verified = await services.finishAuthentication({
      response: parsed.data.response as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
      expectedChallenge: challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.id,
      credential: {
        id: storedCredential.credentialId,
        publicKey: new Uint8Array(storedCredential.publicKey),
        counter: storedCredential.counter,
        transports: storedCredential.transports as AuthenticatorTransport[]
      },
      requireUserVerification: false
    })
    if (!verified.verified || !verified.authenticationInfo) {
      throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
    }

    await context.prisma.authPasskeyCredential.update({
      where: { id: storedCredential.id },
      data: {
        counter: verified.authenticationInfo.newCounter,
        backedUp: verified.authenticationInfo.credentialBackedUp,
        lastUsedAt: new Date()
      }
    })

    const session = await createUserSession(context.prisma, storedCredential.user.id, {
      request,
      maxAgeSeconds: await readAuthSessionMaxAgeSeconds(context.prisma)
    })
    setAuthSessionCookie(response, session.secret, session.expiresAt)
    const nextTenantId = resolvePostSignInTenantId(storedCredential.user)
    if (nextTenantId) {
      setTenantContextCookie(response, nextTenantId)
    } else {
      clearTenantContextCookie(response)
    }
    clearChallengeCookie(response)

    response.json(passkeyAuthenticationFinishResponseSchema.parse({
      authenticated: true,
      actor: {
        type: 'user',
        userId: storedCredential.user.id
      }
    }))
  })
}

async function requireCurrentUser(prisma: AnyPrismaClient, request: Request) {
  if (request.auth.actor.type !== 'user') {
    throw unauthorized('Sign in with the setup session before registering a passkey.')
  }

  const user = await prisma.authUser.findUnique({
    where: { id: request.auth.actor.userId },
    include: {
      tenantMemberships: getCurrentTenant()?.id
        ? {
            where: {
              tenantId: getCurrentTenant()!.id
            },
            select: {
              loginDisabled: true
            }
          }
        : false,
      passkeys: {
        select: {
          credentialId: true,
          transports: true
        }
      }
    }
  })
  if (!user || readScopedAuthUserLoginDisabled(user)) {
    throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
  }
  return user
}

function resolvePostSignInTenantId(user: {
  isPlatformUser: boolean
  tenantMemberships: Array<{ tenantId: string; loginDisabled: boolean }>
}): string | null {
  const currentTenantId = getCurrentTenant()?.id ?? null
  if (currentTenantId && user.tenantMemberships.some((membership) => membership.tenantId === currentTenantId && !membership.loginDisabled)) {
    return currentTenantId
  }

  const enabledMemberships = user.tenantMemberships.filter((membership) => !membership.loginDisabled)
  if (!user.isPlatformUser && enabledMemberships.length === 1) {
    return enabledMemberships[0]?.tenantId ?? null
  }

  return null
}

function getRelyingParty(): { id: string; origins: string[] } {
  const origins = env.CLIENT_ORIGIN
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const first = origins[0]
  if (!first) throw new Error('CLIENT_ORIGIN must include at least one origin for passkeys.')
  return {
    id: new URL(first).hostname,
    origins
  }
}

function setChallengeCookie(response: Response, value: string): void {
  setCookieHeader(response, AUTH_CHALLENGE_COOKIE_NAME, value, AUTH_CHALLENGE_MAX_AGE_SECONDS)
}

function clearChallengeCookie(response: Response): void {
  setCookieHeader(response, AUTH_CHALLENGE_COOKIE_NAME, '', 0)
}

function toAuthUserPasskeyDto(row: AuthUserPasskeyRow) {
  return {
    id: row.id,
    nickname: row.nickname,
    aaguid: row.aaguid,
    transports: normalizeStoredTransports(row.transports),
    backedUp: row.backedUp,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

function normalizeStoredTransports(transports: string[] | null | undefined): string[] {
  return Array.isArray(transports) ? transports.filter((value): value is string => typeof value === 'string') : []
}

function requireChallenge(request: Request, purpose: 'registration' | 'authentication'): string {
  const value = readRequestCookie(request, AUTH_CHALLENGE_COOKIE_NAME)
  if (!value) throw badRequest('Passkey challenge missing. Start the flow again.')
  const [actualPurpose, challenge] = value.split(':', 2)
  if (actualPurpose !== purpose || !challenge) {
    throw badRequest('Passkey challenge missing. Start the flow again.')
  }
  return challenge
}

function readCredentialId(payload: unknown): string {
  if (typeof payload !== 'object' || payload == null) throw badRequest('Passkey response is missing a credential id.')
  const value = 'id' in payload ? payload.id : undefined
  if (typeof value !== 'string' || value.length === 0) throw badRequest('Passkey response is missing a credential id.')
  return value
}

function normalizeTransports(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload == null) return []
  const response = 'response' in payload ? payload.response : undefined
  if (typeof response !== 'object' || response == null || !('transports' in response)) return []
  const transports = response.transports
  return Array.isArray(transports) ? transports.filter((value): value is string => typeof value === 'string') : []
}