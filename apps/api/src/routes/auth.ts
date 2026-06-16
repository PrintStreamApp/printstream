/**
 * Public auth bootstrap routes.
 *
 * This endpoint lets the web client discover server-truth runtime auth and
 * policy state before protected queries start fanning out, and exposes the
 * minimal session lifecycle operations that are shared across auth providers.
 */
import { Router } from 'express'
import {
  authSessionListResponseSchema,
  filterPermissionsForTenantContext,
  permissionValues,
  selectTenantContextRequestSchema,
  switchTenantRequestSchema
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { buildAuthBootstrapCapabilities } from '../lib/auth-capabilities.js'
import { authUsesExplicitPermissions } from '../lib/auth-context.js'
import { authProviderRegistry } from '../lib/auth-registry.js'
import { clearAuthSessionCookie, readRequestAuthSessionSecretHash, revokeRequestAuthSession } from '../lib/auth-session.js'
import { listTenants } from '../lib/default-tenant.js'
import { badRequest, forbidden, notFound, unauthorized } from '../lib/http-error.js'
import { prisma } from '../lib/prisma.js'
import { rootPrisma } from '../lib/prisma.js'
import { hasSupportAccessBypass, isSupportAccessAllowed, listSupportAccessibleWorkspaces } from '../lib/support-access.js'
import { filterEnabledTenants, isTenantDisabled } from '../lib/tenant-availability.js'
import { clearTenantContextCookie, setTenantContextCookie, withTenantRequestContext } from '../lib/tenant-context.js'
import { isPublicDemoTenant } from '../lib/public-demo-policy.js'
import { authManagementRouter } from './auth-management.js'

export const authRouter = Router()

authRouter.get('/bootstrap', async (request, response) => {
  const activeTenant = resolveEffectiveRequestTenant(request)
  const actor = await resolveBootstrapActor(request)
  const bootstrap = await authProviderRegistry.buildBootstrap({ demoMode: isPublicDemoTenant(activeTenant) })
  const memberTenants = await resolveMemberTenants(request)
  const availableTenants = await resolveAvailableTenants(request)
  const platformAuthEnabled = activeTenant
    ? await withTenantRequestContext(null, async () => await authProviderRegistry.hasEnabledProviders())
    : bootstrap.authEnabled
  const tenantHasConnectedBridges = activeTenant
    ? (await prisma.bridge.count()) > 0
    : false

  // Anonymous visitors admitted to the public demo browse with an explicit
  // guest permission set, never a sign-in. Report no-auth/no-setup so the web
  // shell renders the demo workspace instead of gating it behind a login wall,
  // even when the demo tenant happens to resolve an enabled auth provider.
  const isPublicDemoGuest = request.auth.publicDemoGuest === true
  const authEnabled = isPublicDemoGuest ? false : bootstrap.authEnabled
  const setupRequired = isPublicDemoGuest ? false : bootstrap.setupRequired

  response.json({
    ...bootstrap,
    authEnabled,
    setupRequired,
    platformAuthEnabled,
    actor,
    tenant: activeTenant,
    memberTenants,
    availableTenants,
    tenantHasConnectedBridges,
    // With auth disabled in this workspace's scope, route guards bypass
    // permission enforcement, so report the full workspace permission set as
    // server truth — otherwise the web shell hides navigation it may use.
    permissions: !authUsesExplicitPermissions(request.auth) && activeTenant
      ? filterPermissionsForTenantContext(permissionValues)
      : request.auth.permissions,
    capabilities: buildAuthBootstrapCapabilities(request.auth, {
      setupRequired
    })
  })
})

authRouter.post('/switch-tenant', async (request, response) => {
  if (request.auth.actor.type !== 'user') {
    throw unauthorized('Sign in to switch tenants.')
  }

  const parsed = switchTenantRequestSchema.safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid tenant switch payload.')
  }

  annotateRequestAuditLog(request, {
    action: 'switch-tenant',
    resource: 'workspace',
    tenantId: null,
    summary: parsed.data.tenantId
      ? 'Switched into a different tenant workspace.'
      : 'Returned to the platform workspace.',
    metadata: {
      sourceTenantId: request.tenant?.id ?? null,
      targetTenantId: parsed.data.tenantId
    }
  })
  await selectTenantContext(request, response, parsed.data.tenantId)
})

authRouter.post('/tenant-context', async (request, response) => {
  const parsed = selectTenantContextRequestSchema.safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid tenant context payload.')
  }

  annotateRequestAuditLog(request, {
    action: 'switch-workspace',
    resource: 'workspace',
    tenantId: null,
    summary: parsed.data.tenantId
      ? 'Changed the active workspace context.'
      : 'Cleared the active workspace context.',
    metadata: {
      sourceTenantId: request.tenant?.id ?? null,
      targetTenantId: parsed.data.tenantId
    }
  })
  await selectTenantContext(request, response, parsed.data.tenantId)
})

authRouter.post('/logout', async (request, response) => {
  annotateRequestAuditLog(request, {
    action: 'logout',
    resource: 'session',
    summary: 'Signed out of the current session.'
  })
  await revokeRequestAuthSession(prisma, request)
  clearAuthSessionCookie(response)
  clearTenantContextCookie(response)
  response.status(204).end()
})

authRouter.use(authManagementRouter)

authRouter.get('/sessions', async (request, response) => {
  const userId = requireCurrentUserId(request)
  const currentSessionSecretHash = readRequestAuthSessionSecretHash(request)
  const sessions = await prisma.authSession.findMany({
    where: {
      userId,
      revokedAt: null,
      expiresAt: {
        gt: new Date()
      }
    },
    orderBy: [
      { createdAt: 'desc' }
    ]
  })

  response.json(authSessionListResponseSchema.parse({
    sessions: sessions.map((session) => ({
      id: session.id,
      current: currentSessionSecretHash != null && session.secretHash === currentSessionSecretHash,
      userAgent: session.userAgent ?? null,
      createdAt: session.createdAt.toISOString(),
      lastSeenAt: session.lastSeenAt?.toISOString() ?? null,
      expiresAt: session.expiresAt.toISOString()
    }))
  }))
})

authRouter.post('/sessions/:sessionId/revoke', async (request, response) => {
  const userId = requireCurrentUserId(request)
  const currentSessionSecretHash = readRequestAuthSessionSecretHash(request)
  const { sessionId } = request.params

  const session = await prisma.authSession.findFirst({
    where: {
      id: sessionId,
      userId,
      revokedAt: null,
      expiresAt: {
        gt: new Date()
      }
    }
  })

  if (!session) {
    throw forbidden('Session not found or no longer active.')
  }

  if (currentSessionSecretHash != null && session.secretHash === currentSessionSecretHash) {
    throw forbidden('Use sign out to revoke the current browser session.')
  }

  annotateRequestAuditLog(request, {
    action: 'revoke-session',
    resource: 'session',
    summary: 'Revoked another active browser session.',
    metadata: {
      sessionId: session.id
    }
  })
  await prisma.authSession.updateMany({
    where: {
      id: session.id,
      revokedAt: null
    },
    data: {
      revokedAt: new Date()
    }
  })
  response.status(204).end()
})

function requireCurrentUserId(request: Parameters<typeof authRouter.get>[0] extends never ? never : import('express').Request): string {
  if (request.auth.actor.type === 'anonymous') {
    throw unauthorized('Sign in to manage sessions.')
  }

  if (request.auth.actor.type !== 'user') {
    throw forbidden('Only signed-in users can manage browser sessions.')
  }

  return request.auth.actor.userId
}

async function resolveBootstrapActor(request: import('express').Request) {
  if (request.auth.actor.type !== 'user') {
    return {
      ...request.auth.actor,
      isPlatformUser: false
    }
  }

  const user = await prisma.authUser.findUnique({
    where: { id: request.auth.actor.userId },
    select: {
      email: true,
      displayName: true
    }
  })

  return {
    ...request.auth.actor,
    email: user?.email,
    displayName: user?.displayName ?? null,
    isPlatformUser: request.auth.actor.isPlatformUser ?? false
  }
}

async function resolveAvailableTenants(request: import('express').Request) {
  if (request.auth.actor.type === 'user' && request.auth.actor.isPlatformUser) {
    const [memberTenants, supportAccessibleTenants] = await Promise.all([
      resolveMemberTenants(request),
      withTenantWorkspaceUsage(await listSupportAccessibleWorkspaces({
        bypassSupportAccess: hasSupportAccessBypass(request.auth.platformPermissions ?? request.auth.permissions)
      }))
    ])
    return mergeTenantWorkspaceLists(memberTenants, supportAccessibleTenants)
  }

  if (request.auth.actor.type !== 'user') {
    return []
  }

  if (!request.auth.authEnabled) {
    return await withTenantWorkspaceUsage(await filterEnabledTenants({ tenants: await listTenants(prisma) }))
  }

  const memberships = await rootPrisma.authTenantMembership.findMany({
    where: {
      userId: request.auth.actor.userId,
      loginDisabled: false
    },
    select: {
      tenant: {
        select: {
          id: true,
          slug: true,
          name: true,
          description: true
        }
      }
    }
  })

  return await withTenantWorkspaceUsage(
    (await filterEnabledTenants({ tenants: memberships.map((membership) => membership.tenant) }))
      .sort((left, right) => left.name.localeCompare(right.name))
  )
}

async function resolveMemberTenants(request: import('express').Request) {
  if (
    request.auth.actor.type !== 'user'
    || (!request.auth.authEnabled && !request.auth.actor.isPlatformUser)
  ) {
    return []
  }

  const memberships = await rootPrisma.authTenantMembership.findMany({
    where: {
      userId: request.auth.actor.userId,
      loginDisabled: false
    },
    select: {
      tenant: {
        select: {
          id: true,
          slug: true,
          name: true,
          description: true
        }
      }
    }
  })

  return await withTenantWorkspaceUsage(
    (await filterEnabledTenants({ tenants: memberships.map((membership) => membership.tenant) }))
      .sort((left, right) => left.name.localeCompare(right.name))
  )
}

async function withTenantWorkspaceUsage<TTenant extends {
  id: string
  slug: string
  name: string
  description?: string | null
}>(tenants: readonly TTenant[]): Promise<Array<TTenant & { userCount: number; printerCount: number }>> {
  if (tenants.length === 0) return []

  const usageRows = await rootPrisma.tenant.findMany({
    where: {
      id: { in: tenants.map((tenant) => tenant.id) }
    },
    select: {
      id: true,
      _count: {
        select: {
          authMemberships: true,
          printers: true
        }
      }
    }
  })
  const usageByTenantId = new Map(usageRows.map((tenant) => [
    tenant.id,
    {
      userCount: tenant._count.authMemberships,
      printerCount: tenant._count.printers
    }
  ] as const))

  return tenants.map((tenant) => ({
    ...tenant,
    userCount: usageByTenantId.get(tenant.id)?.userCount ?? 0,
    printerCount: usageByTenantId.get(tenant.id)?.printerCount ?? 0
  }))
}

function mergeTenantWorkspaceLists<TTenant extends { id: string; slug: string; name: string }>(
  ...groups: ReadonlyArray<ReadonlyArray<TTenant>>
): TTenant[] {
  const tenantsById = new Map<string, TTenant>()
  for (const group of groups) {
    for (const tenant of group) {
      tenantsById.set(tenant.id, tenant)
    }
  }

  return [...tenantsById.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function resolveEffectiveRequestTenant(request: import('express').Request) {
  if (request.auth.actor.type === 'user' || request.auth.actor.type === 'service-account') {
    return request.auth.actor.tenant ?? request.tenant ?? null
  }

  return request.tenant ?? null
}

async function selectTenantContext(
  request: import('express').Request,
  response: import('express').Response,
  tenantId: string | null
) {
  if (request.auth.actor.type !== 'user') {
    throw unauthorized('Sign in to change workspace context.')
  }

  if (!request.auth.authEnabled) {
    if (tenantId == null) {
      setTenantContextCookie(response, null)
      response.status(204).end()
      return
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true }
    })
    if (!tenant) {
      throw notFound('Tenant not found.')
    }
    if (await isTenantDisabled({ tenantId })) {
      throw forbidden('This workspace is disabled.')
    }

    setTenantContextCookie(response, tenant.id)
    response.status(204).end()
    return
  }

  if (tenantId == null) {
    setTenantContextCookie(response, null)
    response.status(204).end()
    return
  }

  if (request.auth.actor.isPlatformUser) {
    if (await isTenantDisabled({ tenantId })) {
      throw forbidden('This workspace is disabled.')
    }

    const tenant = await rootPrisma.tenant.findMany({
      where: { id: tenantId },
      select: { id: true }
    })
    if (tenant.length === 0) {
      throw notFound('Tenant not found.')
    }

    const memberships = await rootPrisma.authTenantMembership.findMany({
      where: {
        userId: request.auth.actor.userId,
        tenantId,
        loginDisabled: false
      },
      select: { tenantId: true },
      take: 1
    })
    const supportAccessAllowed = await isSupportAccessAllowed({
      tenantId,
      bypassSupportAccess: hasSupportAccessBypass(request.auth.platformPermissions ?? request.auth.permissions)
    })
    if (memberships.length === 0 && !supportAccessAllowed) {
      throw forbidden('You do not have access to this workspace.')
    }

    setTenantContextCookie(response, tenantId)
    response.status(204).end()
    return
  }

  const membership = await prisma.authTenantMembership.findFirst({
    where: {
      userId: request.auth.actor.userId,
      tenantId,
      loginDisabled: false
    },
    select: {
      tenantId: true
    }
  })

  if (!membership || await isTenantDisabled({ tenantId })) {
    throw forbidden('You do not have access to this workspace.')
  }

  setTenantContextCookie(response, tenantId)
  response.status(204).end()
}