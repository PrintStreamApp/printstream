/**
 * Request-scoped tenant resolution for cloud-hosted deployments.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { NextFunction, Request, Response } from 'express'
import { readRequestAuthSessionSecretHash, readRequestCookie, setCookieHeader } from './auth-session.js'
import { prisma } from './prisma.js'
import { env } from './env.js'
import { isSelfHostedDeployment } from './deployment-mode.js'
import { notFound } from './http-error.js'
import type { RequestAuthActor, RequestAuthContext } from './auth-context.js'
import { hasSupportAccessBypass, isSupportAccessAllowed } from './support-access.js'
import { isTenantDisabled } from './tenant-availability.js'

export interface RequestTenantSummary {
  id: string
  slug: string
  name: string
}

interface TenantRequestContext {
  tenant: RequestTenantSummary | null
  requestedSlug: string | null
  platformRequest: boolean
}

const TENANT_OVERRIDE_HEADER = 'x-printstream-tenant'
const TENANT_CONTEXT_COOKIE_NAME = 'printstream_tenant_context'
const PLATFORM_TENANT_CONTEXT_VALUE = 'platform'
const NO_TENANT_CONTEXT_VALUE = 'none'
const tenantContextStorage = new AsyncLocalStorage<TenantRequestContext>()

export function installTenantContext() {
  return async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      const context = await resolveTenantRequestContext(request)
      request.tenant = context.tenant
      tenantContextStorage.run(context, () => next())
    } catch (error) {
      next(error)
    }
  }
}

export function getTenantRequestContext(): TenantRequestContext {
  return tenantContextStorage.getStore() ?? {
    tenant: null,
    requestedSlug: null,
    platformRequest: true
  }
}

export function hasTenantRequestContext(): boolean {
  return tenantContextStorage.getStore() != null
}

export function getCurrentTenant(): RequestTenantSummary | null {
  return getTenantRequestContext().tenant
}

export async function withTenantRequestContext<T>(
  tenant: RequestTenantSummary | null,
  callback: () => Promise<T>
): Promise<T> {
  return await tenantContextStorage.run({
    tenant,
    requestedSlug: tenant?.slug ?? null,
    platformRequest: tenant == null
  }, callback)
}

export async function withResolvedTenantRequestContext<T>(
  request: Pick<Request, 'headers'>,
  callback: () => Promise<T>
): Promise<T> {
  const context = await resolveTenantRequestContext(request)
  return await tenantContextStorage.run(context, callback)
}

export async function resolveEffectiveTenantForAuth(
  auth: RequestAuthContext,
  requestTenant: RequestTenantSummary | null,
  input: {
    requestTenantAuthEnabled?: boolean
  } = {}
): Promise<RequestTenantSummary | null> {
  if (auth.actor.type === 'anonymous') {
    return requestTenant
  }

  const actorTenant = readActorTenant(auth.actor)
  if (actorTenant) {
    return actorTenant
  }

  if (auth.actor.type === 'user' && auth.actor.isPlatformUser && requestTenant) {
    const bypassSupportAccess = hasSupportAccessBypass(auth.platformPermissions ?? auth.permissions)
    return await isSupportAccessAllowed({
      tenantId: requestTenant.id,
      bypassSupportAccess,
      authEnabled: input.requestTenantAuthEnabled
    }) ? requestTenant : null
  }

  return null
}

export function setTenantContextCookie(response: Response, tenantId: string | null): void {
  setCookieHeader(
    response,
    TENANT_CONTEXT_COOKIE_NAME,
    tenantId ?? PLATFORM_TENANT_CONTEXT_VALUE,
    60 * 60 * 24 * 30
  )
}

export function clearTenantContextCookie(response: Response): void {
  setCookieHeader(response, TENANT_CONTEXT_COOKIE_NAME, '', 0)
}

async function resolveTenantRequestContext(request: Pick<Request, 'headers'>): Promise<TenantRequestContext> {
  const actorTenant = readActorTenant((request as Request).auth?.actor)
  if (actorTenant) {
    return {
      tenant: actorTenant,
      requestedSlug: actorTenant.slug,
      platformRequest: false
    }
  }

  const explicitSelection = readRequestedTenantValue(request)
  if (explicitSelection === NO_TENANT_CONTEXT_VALUE) {
    // "No workspace chosen" (the web's ambient pages, e.g. `/`). On a
    // wide-open install there is exactly one possible choice, so default into
    // it; an explicit platform selection below stays on the platform scope.
    const wideOpenContext = await resolveWideOpenRequestContext(request)
    if (wideOpenContext) {
      return wideOpenContext
    }

    return {
      tenant: null,
      requestedSlug: null,
      platformRequest: false
    }
  }
  if (explicitSelection === PLATFORM_TENANT_CONTEXT_VALUE) {
    return {
      tenant: null,
      requestedSlug: null,
      platformRequest: true
    }
  }
  const explicitSlug = normalizeTenantSlug(explicitSelection)
  if (explicitSlug) {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: explicitSlug },
      select: {
        id: true,
        slug: true,
        name: true
      }
    })
    if (!tenant) {
      throw notFound('Tenant not found.')
    }
    if (await isTenantDisabled({ tenantId: tenant.id })) {
      return {
        tenant: null,
        requestedSlug: null,
        platformRequest: true
      }
    }

    return await resolveSupportTenantRequestContext(request as Request, tenant)
  }

  const cookieSelection = await resolveTenantContextCookieSelection(request as Request)
  if (cookieSelection) {
    return cookieSelection
  }

  const requestedSlug = normalizeTenantSlug(readRequestedTenantSlug(request))
  if (!requestedSlug) {
    // No explicit selection, cookie, or tenant host.
    const wideOpenContext = await resolveWideOpenRequestContext(request)
    if (wideOpenContext) {
      return wideOpenContext
    }

    return {
      tenant: null,
      requestedSlug: null,
      platformRequest: true
    }
  }

  const tenant = await prisma.tenant.findUnique({
    where: { slug: requestedSlug },
    select: {
      id: true,
      slug: true,
      name: true
    }
  })
  if (!tenant) {
    throw notFound('Tenant not found.')
  }
  if (await isTenantDisabled({ tenantId: tenant.id })) {
    return {
      tenant: null,
      requestedSlug: null,
      platformRequest: true
    }
  }

  return await resolveSupportTenantRequestContext(request as Request, tenant)
}

async function resolveTenantContextCookieSelection(request: Request): Promise<TenantRequestContext | null> {
  const selection = readRequestCookie(request, TENANT_CONTEXT_COOKIE_NAME)
  if (!selection) {
    return null
  }

  if (selection === PLATFORM_TENANT_CONTEXT_VALUE) {
    return {
      tenant: null,
      requestedSlug: null,
      platformRequest: true
    }
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: selection },
    select: {
      id: true,
      slug: true,
      name: true
    }
  })
  if (!tenant) {
    return null
  }
  if (await isTenantDisabled({ tenantId: tenant.id })) {
    return null
  }

  return await resolveSupportTenantRequestContext(request, tenant)
}

async function resolveSupportTenantRequestContext(
  request: Request,
  tenant: RequestTenantSummary
): Promise<TenantRequestContext> {
  if (request.auth?.actor.type === 'user' && request.auth.actor.isPlatformUser) {
    const accessAllowed = await isSupportAccessAllowed({
      tenantId: tenant.id,
      bypassSupportAccess: hasSupportAccessBypass(request.auth.platformPermissions ?? request.auth.permissions)
    })
    if (!accessAllowed) {
      return {
        tenant: null,
        requestedSlug: null,
        platformRequest: true
      }
    }
  }

  return {
    tenant,
    requestedSlug: tenant.slug,
    platformRequest: false
  }
}

function readRequestedTenantSlug(request: Pick<Request, 'headers'>): string | null {
  const headerValue = readRequestedTenantValue(request)
  if (headerValue && headerValue !== PLATFORM_TENANT_CONTEXT_VALUE && headerValue !== NO_TENANT_CONTEXT_VALUE) return headerValue

  const hostname = readHostName(request)
  if (hostname && env.TENANT_DOMAIN_SUFFIX) {
    const normalizedHost = hostname.toLowerCase()
    const suffix = env.TENANT_DOMAIN_SUFFIX.toLowerCase()
    if (normalizedHost !== suffix && normalizedHost.endsWith(`.${suffix}`)) {
      return normalizedHost.slice(0, -(suffix.length + 1))
    }
  }

  return null
}

function readRequestedTenantValue(request: Pick<Request, 'headers'>): string | null {
  const headerValue = readHeaderValue(request, TENANT_OVERRIDE_HEADER)
  if (headerValue) return headerValue

  const url = (request as Pick<Request, 'headers'> & { url?: string }).url
  if (!url) return null
  try {
    const parsed = new URL(url, 'http://printstream.local')
    const value = parsed.searchParams.get('tenant')?.trim()
    return value && value.length > 0 ? value : null
  } catch {
    return null
  }
}

function readHeaderValue(request: Pick<Request, 'headers'>, name: string): string | null {
  const raw = request.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function readHostName(request: Pick<Request, 'headers'>): string | null {
  const raw = request.headers.host
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  return trimmed ? trimmed.replace(/:\d+$/, '') : null
}

function normalizeTenantSlug(value: string | null): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized.length > 0 ? normalized : null
}

/**
 * Wide-open fallback: on an install with no auth provider enabled anywhere
 * (so nobody can be signed in), context-less requests default into the single
 * workspace so the web app lands inside it instead of a dead-end sign-in
 * wall. Requests carrying any sign-in credential are excluded — a session
 * implies auth is enabled in some scope, and the session's own tenant binding
 * must win. Dynamic import: default-tenant (transitively) imports this module.
 */
async function resolveWideOpenRequestContext(request: Pick<Request, 'headers'>): Promise<TenantRequestContext | null> {
  // Flows that resolve auth before tenant context (e.g. websocket upgrades)
  // already know the actor; anyone signed in is never wide-open traffic.
  const resolvedActor = (request as Request).auth?.actor
  if (resolvedActor && resolvedActor.type !== 'anonymous') {
    return null
  }

  if (readHeaderValue(request, 'authorization')) {
    return null
  }

  // A session cookie only disqualifies the request when it resolves to a
  // live session — stale cookies left behind by older deployments on the
  // same domain must not dead-end a wide-open install.
  const secretHash = readRequestAuthSessionSecretHash(request as Request)
  if (secretHash) {
    const session = await prisma.authSession.findUnique({
      where: { secretHash },
      select: { revokedAt: true, expiresAt: true }
    })
    if (session && !session.revokedAt && session.expiresAt.getTime() > Date.now()) {
      return null
    }
  }

  const { resolveWideOpenDefaultTenant, resolveSoleTenant } = await import('./default-tenant.js')
  const wideOpenTenant = await resolveWideOpenDefaultTenant()
  if (wideOpenTenant) {
    return {
      tenant: wideOpenTenant,
      requestedSlug: wideOpenTenant.slug,
      platformRequest: false
    }
  }

  // Self-hosted (OSS) is a single-workspace deployment with no separate platform
  // sign-in. Once the workspace enables auth it is no longer "wide open", but an
  // anonymous, context-less request (e.g. the `/auth` screen after sign-out)
  // still needs to land in the sole workspace so its sign-in provider is shown —
  // otherwise the platform scope has no enabled provider and the screen is empty.
  if (isSelfHostedDeployment()) {
    const soleTenant = await resolveSoleTenant()
    if (soleTenant) {
      return {
        tenant: soleTenant,
        requestedSlug: soleTenant.slug,
        platformRequest: false
      }
    }
  }

  return null
}

function readActorTenant(actor: RequestAuthActor | undefined): RequestTenantSummary | null {
  if (!actor || actor.type === 'anonymous') {
    return null
  }

  return actor.tenant ?? null
}