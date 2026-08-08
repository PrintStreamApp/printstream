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
  filterPermissionsForWorkspaceContext,
  type Permission
} from '@printstream/shared'
import { rootPrisma, type AnyPrismaClient } from './prisma.js'
import { clientOrigins } from './client-origins.js'
import { forbidden, unauthorized } from './http-error.js'
import type { RequestAuthContext } from './auth-context.js'
import { getCurrentWorkspace, type RequestWorkspaceSummary } from './workspace-context.js'
import { isSupportAccessAllowed, readSupportAccessPermissions } from './support-access.js'
import { listDisabledWorkspaceIds } from './workspace-availability.js'
import { readAuthSessionMaxAgeSeconds } from './auth-policy.js'

export const AUTH_SESSION_COOKIE_NAME = 'printstream_auth'
export const RECENT_AUTH_MAX_AGE_MS = 10 * 60_000
const DEFAULT_AUTH_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24
const SERVICE_ACCOUNT_LAST_USED_UPDATE_INTERVAL_MS = 5 * 60 * 1000

interface SessionUserMembership {
  group: {
    workspaceId: string | null
    permissions: string[]
  }
}

interface SessionWorkspaceRecord {
  id: string
  slug: string
  name: string
  disabled?: boolean
}

interface SessionUserRecord {
  id: string
  isPlatformUser: boolean
  workspaceMemberships: Array<{
    loginDisabled: boolean
    workspace: SessionWorkspaceRecord
  }>
  memberships: SessionUserMembership[]
  /** Shared-table group memberships where workspaceId = null. Used for platform permission resolution. */
  platformMemberships?: SessionUserMembership[]
}

interface SessionServiceAccountMembership {
  group: {
    permissions: string[]
  }
}

interface SessionServiceAccountRecord {
  id: string
  workspaceId: string
  workspace: SessionWorkspaceRecord
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
  const requestWorkspace = getCurrentWorkspace()

  const session = await prisma.authSession.findUnique({
    where: { secretHash: hashSessionSecret(sessionSecret) },
    include: {
      user: {
        select: {
          id: true,
          isPlatformUser: true,
          workspaceMemberships: {
            select: {
              loginDisabled: true,
              workspace: {
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
                  workspaceId: true,
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
          workspaceId: true,
          workspace: {
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

  const disabledWorkspaceIds = await listDisabledWorkspaceIds({
    workspaceIds: [
      ...(session.user?.workspaceMemberships.map((membership) => membership.workspace.id) ?? []),
      ...(session.serviceAccount?.workspaceId ? [session.serviceAccount.workspaceId] : [])
    ]
  })

  if (session.user) {
    const user = {
      ...session.user,
      workspaceMemberships: session.user.workspaceMemberships.map((membership) => ({
        ...membership,
        workspace: {
          ...membership.workspace,
          disabled: disabledWorkspaceIds.has(membership.workspace.id)
        }
      }))
    }
    // Platform users keep their platform roles even while operating inside a workspace.
    if (user.isPlatformUser) {
      const platformMemberships = await prisma.authUserGroupMembership.findMany({
        where: {
          userId: user.id,
          group: { workspaceId: null }
        },
        select: {
          group: { select: { workspaceId: true, permissions: true } }
        }
      })
      return await buildUserAuthContext({ ...user, platformMemberships }, anonymous, requestWorkspace)
    }
    return await buildUserAuthContext(user, anonymous, requestWorkspace)
  }

  if (session.serviceAccount) {
    return buildServiceAccountAuthContext({
      ...session.serviceAccount,
      workspace: {
        ...session.serviceAccount.workspace,
        disabled: disabledWorkspaceIds.has(session.serviceAccount.workspace.id)
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
    // Service-account tokens establish workspace identity themselves, so their
    // lookup cannot depend on an already-selected workspace-scoped Prisma context.
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
  requestWorkspace: RequestWorkspaceSummary | null
): Promise<RequestAuthContext> {
  const workspaceMemberships = user.workspaceMemberships ?? []
  const enabledWorkspaceMemberships = workspaceMemberships.filter((membership) => !membership.loginDisabled && !membership.workspace.disabled)
  const activeWorkspaceMembership = requestWorkspace
    ? workspaceMemberships.find((membership) => membership.workspace.id === requestWorkspace.id) ?? null
    : (!user.isPlatformUser && enabledWorkspaceMemberships.length === 1 ? enabledWorkspaceMemberships[0] ?? null : null)
  const hasEnabledWorkspaceAccess = enabledWorkspaceMemberships.length > 0

  // Locked out, as distinct from having nowhere to be. A user whose every
  // membership is login-disabled or whose every workspace is disabled has been
  // deliberately shut out, and their session must read as signed-out.
  //
  // Belonging to NO workspace is not that: registering for a self-hosted licence
  // creates an account and no workspace, and the billing scope is a real place
  // for that person to be. Reading them as anonymous made their own sign-in
  // dead-end -- the cookie was set and every request came back unauthenticated.
  // They arrive with no permissions, because permissions are workspace-scoped
  // and there is no workspace; the account surfaces authorise on billing
  // membership instead (`billing-scope-access.ts`).
  if (!user.isPlatformUser && workspaceMemberships.length > 0 && !hasEnabledWorkspaceAccess) {
    return anonymous
  }

  const activeWorkspace = activeWorkspaceMembership && !activeWorkspaceMembership.loginDisabled && !activeWorkspaceMembership.workspace.disabled
    ? activeWorkspaceMembership.workspace
    : null
  const activeWorkspaceMemberships = activeWorkspace
    ? user.memberships.filter((membership) => membership.group.workspaceId === activeWorkspace.id)
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
  const platformUserSupportAccessAllowed = user.isPlatformUser && requestWorkspace
    ? await isSupportAccessAllowed({ workspaceId: requestWorkspace.id, bypassSupportAccess: platformBypassesSupportAccess })
    : false
  const platformUserWorkspacePermissions = user.isPlatformUser && requestWorkspace && platformUserSupportAccessAllowed
    ? await readSupportAccessPermissions({ workspaceId: requestWorkspace.id, bypassSupportAccess: platformBypassesSupportAccess })
    : []

  return {
    ...anonymous,
    actor: {
      type: 'user',
      userId: user.id,
      isPlatformUser: user.isPlatformUser,
      workspace: toWorkspaceSummary(activeWorkspace)
    },
    ...(user.isPlatformUser ? { platformPermissions } : {}),
    permissions: user.isPlatformUser
      ? (requestWorkspace && platformUserSupportAccessAllowed ? platformUserWorkspacePermissions : platformPermissions)
      : activeWorkspace
        ? collectPermissions(activeWorkspaceMemberships, true)
        : []
  }
}

function buildServiceAccountAuthContext(serviceAccount: SessionServiceAccountRecord, anonymous: RequestAuthContext): RequestAuthContext {
  if (serviceAccount.revokedAt || !serviceAccount.workspaceId || !serviceAccount.workspace || serviceAccount.workspace.disabled) return anonymous
  return {
    ...anonymous,
    actor: {
      type: 'service-account',
      serviceAccountId: serviceAccount.id,
      workspace: toWorkspaceSummary(serviceAccount.workspace)
    },
    permissions: collectPermissions(serviceAccount.memberships, true)
  }
}

function collectPermissions(
  memberships: Array<{ group: { permissions: string[] } }>,
  workspaceScoped: boolean
): Permission[] {
  return readAvailablePermissions(
    Array.from(new Set(memberships.flatMap((membership) => membership.group.permissions))) as Permission[],
    workspaceScoped
  )
}

function readAvailablePermissions(permissions: readonly Permission[], workspaceScoped: boolean): Permission[] {
  return workspaceScoped ? filterPermissionsForWorkspaceContext([...permissions]) : filterPermissionsForPlatformContext([...permissions])
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
      workspaceId: true,
      workspace: {
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

function toWorkspaceSummary(workspace: SessionWorkspaceRecord | null): RequestWorkspaceSummary | null {
  if (!workspace) {
    return null
  }

  return {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name
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

  return clientOrigins().some((value) => {
      try {
        return new URL(value).protocol === 'https:'
      } catch {
        return false
      }
    })
}