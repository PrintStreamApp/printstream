/**
 * Cookie-backed auth session helpers.
 *
 * Sessions are persisted in Prisma and surfaced into `request.auth` by the
 * auth-context middleware. The raw secret only lives in the cookie; the
 * database stores a one-way hash.
 */
import crypto from 'node:crypto'
import type { Request, Response } from 'express'
import {
  AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION,
  AUTH_RECENT_VERIFICATION_REQUIRED_MESSAGE,
  filterPermissionsForPlatformContext,
  filterPermissionsForTenantContext,
  type Permission
} from '@printstream/shared'
import { rootPrisma, type AnyPrismaClient } from './prisma.js'
import { env } from './env.js'
import { forbidden, unauthorized } from './http-error.js'
import type { RequestAuthContext } from './auth-context.js'
import { getCurrentTenant, type RequestTenantSummary } from './tenant-context.js'
import { isSupportAccessAllowed, readSupportAccessPermissions } from './support-access.js'
import { listDisabledTenantIds } from './tenant-availability.js'
import { readAuthSessionMaxAgeSeconds } from './auth-policy.js'

export const AUTH_SESSION_COOKIE_NAME = 'printstream_auth'
export const RECENT_AUTH_MAX_AGE_MS = 10 * 60_000
const DEFAULT_AUTH_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24
const SERVICE_ACCOUNT_LAST_USED_UPDATE_INTERVAL_MS = 5 * 60 * 1000

interface SessionUserMembership {
  group: {
    tenantId: string | null
    permissions: string[]
  }
}

interface SessionTenantRecord {
  id: string
  slug: string
  name: string
  disabled?: boolean
}

interface SessionUserRecord {
  id: string
  isPlatformUser: boolean
  tenantMemberships: Array<{
    loginDisabled: boolean
    tenant: SessionTenantRecord
  }>
  memberships: SessionUserMembership[]
  /** Shared-table group memberships where tenantId = null. Used for platform permission resolution. */
  platformMemberships?: SessionUserMembership[]
}

interface SessionServiceAccountMembership {
  group: {
    permissions: string[]
  }
}

interface SessionServiceAccountRecord {
  id: string
  tenantId: string
  tenant: SessionTenantRecord
  lastUsedAt?: Date | null
  revokedAt: Date | null
  memberships: SessionServiceAccountMembership[]
}

type SessionCreationContext = {
  request?: Request
  maxAgeSeconds?: number
}

type AuthSessionStore = Pick<AnyPrismaClient, 'authSession' | 'authServiceAccount' | 'authUserGroupMembership' | 'setting'>

const SESSION_LAST_SEEN_UPDATE_INTERVAL_MS = 5 * 60 * 1000

export async function createUserSession(
  prisma: AuthSessionStore,
  userId: string,
  context: SessionCreationContext = {}
): Promise<{ secret: string; expiresAt: Date }> {
  const secret = crypto.randomBytes(32).toString('base64url')
  const now = new Date()
  const maxAgeSeconds = context.maxAgeSeconds ?? DEFAULT_AUTH_SESSION_MAX_AGE_SECONDS
  const expiresAt = new Date(now.getTime() + maxAgeSeconds * 1000)
  await prisma.authSession.create({
    data: {
      secretHash: hashSessionSecret(secret),
      userId,
      expiresAt,
      lastSeenAt: now,
      userAgent: readSessionUserAgent(context.request)
    }
  })
  return { secret, expiresAt }
}

export function setAuthSessionCookie(response: Response, secret: string, expiresAt: Date): void {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
  setCookieHeader(response, AUTH_SESSION_COOKIE_NAME, secret, maxAge)
}

export function clearAuthSessionCookie(response: Response): void {
  setCookieHeader(response, AUTH_SESSION_COOKIE_NAME, '', 0)
}

export async function revokeRequestAuthSession(prisma: AuthSessionStore, request: Request): Promise<void> {
  const sessionSecret = readCookie(request.headers.cookie ?? '', AUTH_SESSION_COOKIE_NAME)
  if (!sessionSecret) return

  await prisma.authSession.updateMany({
    where: {
      secretHash: hashSessionSecret(sessionSecret),
      revokedAt: null
    },
    data: {
      revokedAt: new Date()
    }
  })
}

export async function resolveRequestAuthFromSession(
  prisma: AuthSessionStore,
  request: Request,
  anonymous: RequestAuthContext,
  response?: Response
): Promise<RequestAuthContext> {
  const sessionSecret = readCookie(request.headers.cookie ?? '', AUTH_SESSION_COOKIE_NAME)
  if (!sessionSecret) return anonymous
  const requestTenant = getCurrentTenant()

  const session = await prisma.authSession.findUnique({
    where: { secretHash: hashSessionSecret(sessionSecret) },
    include: {
      user: {
        select: {
          id: true,
          isPlatformUser: true,
          tenantMemberships: {
            select: {
              loginDisabled: true,
              tenant: {
                select: {
                  id: true,
                  slug: true,
                  name: true
                }
              }
            }
          },
          memberships: {
            select: {
              group: {
                select: {
                  tenantId: true,
                  permissions: true
                }
              }
            }
          }
        }
      },
      serviceAccount: {
        select: {
          id: true,
          tenantId: true,
          tenant: {
            select: {
              id: true,
              slug: true,
              name: true
            }
          },
          revokedAt: true,
          memberships: {
            select: {
              group: {
                select: {
                  permissions: true
                }
              }
            }
          }
        }
      }
    }
  })

  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
    return anonymous
  }

  await refreshUserSessionActivity(prisma, session, sessionSecret, response)

  const disabledTenantIds = await listDisabledTenantIds({
    tenantIds: [
      ...(session.user?.tenantMemberships.map((membership) => membership.tenant.id) ?? []),
      ...(session.serviceAccount?.tenantId ? [session.serviceAccount.tenantId] : [])
    ]
  })

  if (session.user) {
    const user = {
      ...session.user,
      tenantMemberships: session.user.tenantMemberships.map((membership) => ({
        ...membership,
        tenant: {
          ...membership.tenant,
          disabled: disabledTenantIds.has(membership.tenant.id)
        }
      }))
    }
    // Platform users keep their platform roles even while operating inside a tenant workspace.
    if (user.isPlatformUser) {
      const platformMemberships = await prisma.authUserGroupMembership.findMany({
        where: {
          userId: user.id,
          group: { tenantId: null }
        },
        select: {
          group: { select: { tenantId: true, permissions: true } }
        }
      })
      return await buildUserAuthContext({ ...user, platformMemberships }, anonymous, requestTenant)
    }
    return await buildUserAuthContext(user, anonymous, requestTenant)
  }

  if (session.serviceAccount) {
    return buildServiceAccountAuthContext({
      ...session.serviceAccount,
      tenant: {
        ...session.serviceAccount.tenant,
        disabled: disabledTenantIds.has(session.serviceAccount.tenant.id)
      }
    }, anonymous)
  }

  return anonymous
}

export async function resolveRequestAuth(
  prisma: AuthSessionStore,
  request: Request,
  anonymous: RequestAuthContext,
  response?: Response
): Promise<RequestAuthContext> {
  const bearerToken = readRequestBearerToken(request)
  if (bearerToken) {
    // Service-account tokens establish tenant identity themselves, so their
    // lookup cannot depend on an already-selected tenant-scoped Prisma context.
    const serviceAccountContext = await resolveRequestAuthFromServiceAccountToken(
      rootPrisma as unknown as AuthSessionStore,
      bearerToken,
      request,
      anonymous
    )
    if (serviceAccountContext.actor.type !== 'anonymous') {
      return serviceAccountContext
    }
  }

  return resolveRequestAuthFromSession(prisma, request, anonymous, response)
}

async function buildUserAuthContext(
  user: SessionUserRecord,
  anonymous: RequestAuthContext,
  requestTenant: RequestTenantSummary | null
): Promise<RequestAuthContext> {
  const tenantMemberships = user.tenantMemberships ?? []
  const enabledTenantMemberships = tenantMemberships.filter((membership) => !membership.loginDisabled && !membership.tenant.disabled)
  const activeTenantMembership = requestTenant
    ? tenantMemberships.find((membership) => membership.tenant.id === requestTenant.id) ?? null
    : (!user.isPlatformUser && enabledTenantMemberships.length === 1 ? enabledTenantMemberships[0] ?? null : null)
  const hasEnabledTenantAccess = enabledTenantMemberships.length > 0

  if (!user.isPlatformUser && !hasEnabledTenantAccess) {
    return anonymous
  }

  const activeTenant = activeTenantMembership && !activeTenantMembership.loginDisabled && !activeTenantMembership.tenant.disabled
    ? activeTenantMembership.tenant
    : null
  const activeTenantMemberships = activeTenant
    ? user.memberships.filter((membership) => membership.group.tenantId === activeTenant.id)
    : []
  const platformPermissions = user.isPlatformUser
    ? collectPermissions(
        user.platformMemberships && user.platformMemberships.length > 0
          ? user.platformMemberships
          : user.memberships,
        false
      )
    : []
  const platformBypassesSupportAccess = platformPermissions.includes(AUTH_BYPASS_SUPPORT_ACCESS_PERMISSION)
  const platformUserSupportAccessAllowed = user.isPlatformUser && requestTenant
    ? await isSupportAccessAllowed({ tenantId: requestTenant.id, bypassSupportAccess: platformBypassesSupportAccess })
    : false
  const platformUserTenantPermissions = user.isPlatformUser && requestTenant && platformUserSupportAccessAllowed
    ? await readSupportAccessPermissions({ tenantId: requestTenant.id, bypassSupportAccess: platformBypassesSupportAccess })
    : []

  return {
    ...anonymous,
    actor: {
      type: 'user',
      userId: user.id,
      isPlatformUser: user.isPlatformUser,
      tenant: toTenantSummary(activeTenant)
    },
    ...(user.isPlatformUser ? { platformPermissions } : {}),
    permissions: user.isPlatformUser
      ? (requestTenant && platformUserSupportAccessAllowed ? platformUserTenantPermissions : platformPermissions)
      : activeTenant
        ? collectPermissions(activeTenantMemberships, true)
        : []
  }
}

function buildServiceAccountAuthContext(serviceAccount: SessionServiceAccountRecord, anonymous: RequestAuthContext): RequestAuthContext {
  if (serviceAccount.revokedAt || !serviceAccount.tenantId || !serviceAccount.tenant || serviceAccount.tenant.disabled) return anonymous
  return {
    ...anonymous,
    actor: {
      type: 'service-account',
      serviceAccountId: serviceAccount.id,
      tenant: toTenantSummary(serviceAccount.tenant)
    },
    permissions: collectPermissions(serviceAccount.memberships, true)
  }
}

function collectPermissions(
  memberships: Array<{ group: { permissions: string[] } }>,
  tenantScoped: boolean
): Permission[] {
  return readAvailablePermissions(
    Array.from(new Set(memberships.flatMap((membership) => membership.group.permissions))) as Permission[],
    tenantScoped
  )
}

function readAvailablePermissions(permissions: readonly Permission[], tenantScoped: boolean): Permission[] {
  return tenantScoped ? filterPermissionsForTenantContext([...permissions]) : filterPermissionsForPlatformContext([...permissions])
}

async function resolveRequestAuthFromServiceAccountToken(
  prisma: AuthSessionStore,
  token: string,
  request: Request,
  anonymous: RequestAuthContext
): Promise<RequestAuthContext> {
  const serviceAccount = await prisma.authServiceAccount.findUnique({
    where: { tokenHash: hashServiceAccountToken(token) },
    select: {
      id: true,
      tenantId: true,
      tenant: {
        select: {
          id: true,
          slug: true,
          name: true
        }
      },
      lastUsedAt: true,
      revokedAt: true,
      memberships: {
        select: {
          group: {
            select: {
              permissions: true
            }
          }
        }
      }
    }
  })

  if (!serviceAccount || serviceAccount.revokedAt) {
    return anonymous
  }

  await refreshServiceAccountLastUsed(prisma, serviceAccount)
  return buildServiceAccountAuthContext(serviceAccount, anonymous)
}

function toTenantSummary(tenant: SessionTenantRecord | null): RequestTenantSummary | null {
  if (!tenant) {
    return null
  }

  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name
  }
}

function readCookie(header: string, name: string): string | null {
  for (const segment of header.split(';')) {
    const [rawName, ...rawValueParts] = segment.trim().split('=')
    if (rawName !== name) continue
    const rawValue = rawValueParts.join('=')
    if (!rawValue) return null
    try {
      return decodeURIComponent(rawValue)
    } catch {
      return rawValue
    }
  }
  return null
}

export function readRequestCookie(request: Request, name: string): string | null {
  return readCookie(request.headers.cookie ?? '', name)
}

export function readRequestBearerToken(request: Pick<Request, 'headers'>): string | null {
  const value = request.headers.authorization
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed.toLowerCase().startsWith('bearer ')) {
    return null
  }

  const token = trimmed.slice(7).trim()
  return token.length > 0 ? token : null
}

export function readRequestAuthSessionSecretHash(request: Request): string | null {
  const secret = readRequestCookie(request, AUTH_SESSION_COOKIE_NAME)
  if (!secret) {
    return null
  }
  return hashSessionSecret(secret)
}

export async function requireRecentUserSession(
  prisma: AuthSessionStore,
  request: Request,
  userId: string,
  maxAgeMs = RECENT_AUTH_MAX_AGE_MS
): Promise<void> {
  const secretHash = readRequestAuthSessionSecretHash(request)
  if (!secretHash) {
    throw unauthorized(AUTH_RECENT_VERIFICATION_REQUIRED_MESSAGE)
  }

  const session = await prisma.authSession.findUnique({
    where: { secretHash },
    select: {
      userId: true,
      createdAt: true,
      expiresAt: true,
      revokedAt: true
    }
  })

  if (!session || session.userId !== userId || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
    throw unauthorized(AUTH_RECENT_VERIFICATION_REQUIRED_MESSAGE)
  }

  if (Date.now() - session.createdAt.getTime() > maxAgeMs) {
    throw forbidden(AUTH_RECENT_VERIFICATION_REQUIRED_MESSAGE)
  }
}

function readSessionUserAgent(request?: Request): string | null {
  const value = request?.headers['user-agent']
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed.slice(0, 512) : null
}

async function refreshUserSessionActivity(
  prisma: AuthSessionStore,
  session: { id: string; lastSeenAt: Date | null },
  sessionSecret: string,
  response?: Response
): Promise<void> {
  if (session.lastSeenAt && Date.now() - session.lastSeenAt.getTime() < SESSION_LAST_SEEN_UPDATE_INTERVAL_MS) {
    return
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + (await readAuthSessionMaxAgeSeconds(prisma)) * 1000)
  await prisma.authSession.updateMany({
    where: {
      id: session.id,
      revokedAt: null
    },
    data: {
      expiresAt,
      lastSeenAt: now
    }
  })
  if (response && !response.headersSent) {
    setAuthSessionCookie(response, sessionSecret, expiresAt)
  }
}

async function refreshServiceAccountLastUsed(
  prisma: AuthSessionStore,
  serviceAccount: { id: string; lastUsedAt?: Date | null; revokedAt: Date | null }
): Promise<void> {
  if (serviceAccount.lastUsedAt && Date.now() - serviceAccount.lastUsedAt.getTime() < SERVICE_ACCOUNT_LAST_USED_UPDATE_INTERVAL_MS) {
    return
  }

  await prisma.authServiceAccount.updateMany({
    where: {
      id: serviceAccount.id,
      revokedAt: null
    },
    data: {
      lastUsedAt: new Date()
    }
  })
}

export function setCookieHeader(response: Response, name: string, value: string, maxAgeSeconds: number): void {
  const cookie = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
  ]

  if (shouldUseSecureCookies(response)) {
    cookie.push('Secure')
  }

  response.append('Set-Cookie', cookie.join('; '))
}

function hashSessionSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('base64url')
}

export function hashServiceAccountToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('base64url')
}

function shouldUseSecureCookies(response: Response): boolean {
  const request = response.req as Pick<Request, 'secure' | 'headers'> | undefined
  if (request) {
    if (request.secure) {
      return true
    }

    const forwardedProtoHeader = request.headers['x-forwarded-proto']
    const forwardedProto = Array.isArray(forwardedProtoHeader)
      ? forwardedProtoHeader[0]
      : forwardedProtoHeader?.split(',')[0]
    if (forwardedProto?.trim().toLowerCase() === 'https') {
      return true
    }

    return false
  }

  return env.CLIENT_ORIGIN
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .some((value) => {
      try {
        return new URL(value).protocol === 'https:'
      } catch {
        return false
      }
    })
}