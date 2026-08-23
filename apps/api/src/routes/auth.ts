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
  filterPermissionsForWorkspaceContext,
  permissionValues,
  selectWorkspaceContextRequestSchema,
  switchWorkspaceRequestSchema,
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { buildAuthBootstrapCapabilities } from '../lib/auth-capabilities.js'
import { authUsesExplicitPermissions } from '../lib/auth-context.js'
import { authProviderRegistry } from '../lib/auth-registry.js'
import { clearAuthSessionCookie, readRequestAuthSessionSecretHash, revokeRequestAuthSession } from '../lib/auth-session.js'
import { listCustomersForUser } from '../lib/billing-scope.js'
import { listWorkspaces } from '../lib/workspace-resolution.js'
import { badRequest, forbidden, notFound, unauthorized } from '../lib/http-error.js'
import { prisma } from '../lib/prisma.js'
import { rootPrisma } from '../lib/prisma.js'
import { hasSupportAccessBypass, isSupportAccessAllowed, listSupportAccessibleWorkspaces } from '../lib/support-access.js'
import { filterEnabledWorkspaces, isWorkspaceDisabled } from '../lib/workspace-availability.js'
import { clearWorkspaceContextCookie, setWorkspaceContextCookie, withWorkspaceRequestContext, type RequestWorkspaceSummary } from '../lib/workspace-context.js'
import { isPublicDemoWorkspace } from '../lib/public-demo-policy.js'
import { authManagementRouter } from './auth-management.js'
import { visibleWorkspacesWhere } from '../lib/workspace-visibility.js'

export const authRouter = Router()

authRouter.get('/bootstrap', async (request, response) => {
  const activeWorkspace = resolveEffectiveRequestWorkspace(request)
  const actor = await resolveBootstrapActor(request)
  const bootstrap = await authProviderRegistry.buildBootstrap({ demoMode: isPublicDemoWorkspace(activeWorkspace) })
  const memberWorkspaces = await resolveMemberWorkspaces(request)
  const customers = await listCustomersForUser(
    request.auth.actor.type === 'user' ? request.auth.actor.userId : null
  )
  const availableWorkspaces = await resolveAvailableWorkspaces(request)
  const platformAuthEnabled = activeWorkspace
    ? await withWorkspaceRequestContext(null, async () => await authProviderRegistry.hasEnabledProviders())
    : bootstrap.authEnabled
  const workspaceHasConnectedBridges = activeWorkspace
    ? (await prisma.bridge.count()) > 0
    : false

  // Anonymous visitors admitted to the public demo browse with an explicit
  // guest permission set, never a sign-in. Report no-auth/no-setup so the web
  // shell renders the demo workspace instead of gating it behind a login wall,
  // even when the demo workspace happens to resolve an enabled auth provider.
  const isPublicDemoGuest = request.auth.publicDemoGuest === true
  const authEnabled = isPublicDemoGuest ? false : bootstrap.authEnabled
  const setupRequired = isPublicDemoGuest ? false : bootstrap.setupRequired

  response.json({
    ...bootstrap,
    authEnabled,
    setupRequired,
    platformAuthEnabled,
    actor,
    workspace: serializeWorkspaceSummary(activeWorkspace),
    memberWorkspaces,
    availableWorkspaces,
    customers,
    workspaceHasConnectedBridges,
    // With auth disabled in this workspace's scope, route guards bypass
    // permission enforcement, so report the full workspace permission set as
    // server truth, otherwise the web shell hides navigation it may use.
    permissions: !authUsesExplicitPermissions(request.auth) && activeWorkspace
      ? filterPermissionsForWorkspaceContext(permissionValues)
      : request.auth.permissions,
    capabilities: buildAuthBootstrapCapabilities(request.auth, {
      setupRequired
    })
  })
})

authRouter.post('/switch-workspace', async (request, response) => {
  if (request.auth.actor.type !== 'user') {
    throw unauthorized('Sign in to switch workspaces.')
  }

  const parsed = switchWorkspaceRequestSchema.safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid workspace switch payload.')
  }

  annotateRequestAuditLog(request, {
    action: 'switch-workspace',
    resource: 'workspace',
    workspaceId: null,
    summary: parsed.data.workspaceId
      ? 'Switched into a different workspace.'
      : 'Returned to the platform workspace.',
    metadata: {
      sourceWorkspaceId: request.workspace?.id ?? null,
      targetWorkspaceId: parsed.data.workspaceId
    }
  })
  await selectWorkspaceContext(request, response, parsed.data.workspaceId)
})

authRouter.post('/workspace-context', async (request, response) => {
  const parsed = selectWorkspaceContextRequestSchema.safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid workspace context payload.')
  }

  annotateRequestAuditLog(request, {
    action: 'switch-workspace',
    resource: 'workspace',
    workspaceId: null,
    summary: parsed.data.workspaceId
      ? 'Changed the active workspace context.'
      : 'Cleared the active workspace context.',
    metadata: {
      sourceWorkspaceId: request.workspace?.id ?? null,
      targetWorkspaceId: parsed.data.workspaceId
    }
  })
  await selectWorkspaceContext(request, response, parsed.data.workspaceId)
})

authRouter.post('/logout', async (request, response) => {
  annotateRequestAuditLog(request, {
    action: 'logout',
    resource: 'session',
    summary: 'Signed out of the current session.'
  })
  await revokeRequestAuthSession(prisma, request)
  clearAuthSessionCookie(response)
  clearWorkspaceContextCookie(response)
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

/**
 * The workspaces a user belongs to and may sign into.
 *
 * One implementation because there were two identical copies, and a soft-deleted
 * workspace leaked through BOTH of them: the visibility audit fixed the lists
 * that query `workspace` directly and missed the pair that reach it through a
 * membership. A deleted workspace kept appearing in the chooser, which is worse
 * than not deleting it: it is listed, enterable, and gone from everywhere else.
 *
 * `loginDisabled` and `deletedAt` are different refusals and both belong here,
 * one is "this person may not sign in", the other is "this workspace is on its
 * way out".
 */
export async function loadMembershipWorkspaces(userId: string) {
  const memberships = await rootPrisma.authWorkspaceMembership.findMany({
    where: {
      userId,
      loginDisabled: false,
      workspace: visibleWorkspacesWhere({})
    },
    select: {
      workspace: {
        select: {
          id: true,
          slug: true,
          name: true,
          description: true
        }
      }
    }
  })
  return memberships
}

async function resolveAvailableWorkspaces(request: import('express').Request) {
  if (request.auth.actor.type === 'user' && request.auth.actor.isPlatformUser) {
    const [memberWorkspaces, supportAccessibleWorkspaces] = await Promise.all([
      resolveMemberWorkspaces(request),
      withWorkspaceUsage(await listSupportAccessibleWorkspaces({
        bypassSupportAccess: hasSupportAccessBypass(request.auth.platformPermissions ?? request.auth.permissions)
      }))
    ])
    return mergeWorkspaceLists(memberWorkspaces, supportAccessibleWorkspaces)
  }

  if (request.auth.actor.type !== 'user') {
    return []
  }

  if (!request.auth.authEnabled) {
    return await withWorkspaceUsage(await filterEnabledWorkspaces({ workspaces: await listWorkspaces(prisma) }))
  }

  const memberships = await loadMembershipWorkspaces(request.auth.actor.userId)

  return await withWorkspaceUsage(
    (await filterEnabledWorkspaces({ workspaces: memberships.map((membership) => membership.workspace) }))
      .sort((left, right) => left.name.localeCompare(right.name))
  )
}

async function resolveMemberWorkspaces(request: import('express').Request) {
  if (
    request.auth.actor.type !== 'user'
    || (!request.auth.authEnabled && !request.auth.actor.isPlatformUser)
  ) {
    return []
  }

  const memberships = await loadMembershipWorkspaces(request.auth.actor.userId)

  return await withWorkspaceUsage(
    (await filterEnabledWorkspaces({ workspaces: memberships.map((membership) => membership.workspace) }))
      .sort((left, right) => left.name.localeCompare(right.name))
  )
}

async function withWorkspaceUsage<TWorkspace extends {
  id: string
  slug: string
  name: string
  description?: string | null
}>(workspaces: readonly TWorkspace[]): Promise<Array<TWorkspace & { userCount: number; printerCount: number }>> {
  if (workspaces.length === 0) return []

  const usageRows = await rootPrisma.workspace.findMany({
    where: visibleWorkspacesWhere({
      id: { in: workspaces.map((workspace) => workspace.id) }
    }),
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
  const usageByWorkspaceId = new Map(usageRows.map((workspace) => [
    workspace.id,
    {
      userCount: workspace._count.authMemberships,
      printerCount: workspace._count.printers
    }
  ] as const))

  return workspaces.map((workspace) => ({
    ...workspace,
    userCount: usageByWorkspaceId.get(workspace.id)?.userCount ?? 0,
    printerCount: usageByWorkspaceId.get(workspace.id)?.printerCount ?? 0
  }))
}

/** The active workspace as bootstrap reports it. Null passes straight through. */
function serializeWorkspaceSummary(workspace: RequestWorkspaceSummary | null) {
  return workspace
    ? { id: workspace.id, slug: workspace.slug, name: workspace.name }
    : null
}

function mergeWorkspaceLists<TWorkspace extends { id: string; slug: string; name: string }>(
  ...groups: ReadonlyArray<ReadonlyArray<TWorkspace>>
): TWorkspace[] {
  const workspacesById = new Map<string, TWorkspace>()
  for (const group of groups) {
    for (const workspace of group) {
      workspacesById.set(workspace.id, workspace)
    }
  }

  return [...workspacesById.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function resolveEffectiveRequestWorkspace(request: import('express').Request) {
  if (request.auth.actor.type === 'user' || request.auth.actor.type === 'service-account') {
    return request.auth.actor.workspace ?? request.workspace ?? null
  }

  return request.workspace ?? null
}

async function selectWorkspaceContext(
  request: import('express').Request,
  response: import('express').Response,
  workspaceId: string | null
) {
  if (request.auth.actor.type !== 'user') {
    throw unauthorized('Sign in to change workspace context.')
  }

  if (!request.auth.authEnabled) {
    if (workspaceId == null) {
      setWorkspaceContextCookie(response, null)
      response.status(204).end()
      return
    }

    const workspace = await prisma.workspace.findFirst({
      where: visibleWorkspacesWhere({ id: workspaceId }),
      select: { id: true }
    })
    if (!workspace) {
      throw notFound('Workspace not found.')
    }
    if (await isWorkspaceDisabled({ workspaceId })) {
      throw forbidden('This workspace is disabled.')
    }

    setWorkspaceContextCookie(response, workspace.id)
    response.status(204).end()
    return
  }

  if (workspaceId == null) {
    setWorkspaceContextCookie(response, null)
    response.status(204).end()
    return
  }

  if (request.auth.actor.isPlatformUser) {
    if (await isWorkspaceDisabled({ workspaceId })) {
      throw forbidden('This workspace is disabled.')
    }

    const workspace = await rootPrisma.workspace.findMany({
      where: visibleWorkspacesWhere({ id: workspaceId }),
      select: { id: true }
    })
    if (workspace.length === 0) {
      throw notFound('Workspace not found.')
    }

    const memberships = await rootPrisma.authWorkspaceMembership.findMany({
      where: {
        userId: request.auth.actor.userId,
        workspaceId,
        loginDisabled: false
      },
      select: { workspaceId: true },
      take: 1
    })
    const supportAccessAllowed = await isSupportAccessAllowed({
      workspaceId,
      bypassSupportAccess: hasSupportAccessBypass(request.auth.platformPermissions ?? request.auth.permissions)
    })
    if (memberships.length === 0 && !supportAccessAllowed) {
      throw forbidden('You do not have access to this workspace.')
    }

    setWorkspaceContextCookie(response, workspaceId)
    response.status(204).end()
    return
  }

  const membership = await prisma.authWorkspaceMembership.findFirst({
    where: {
      userId: request.auth.actor.userId,
      workspaceId,
      loginDisabled: false
    },
    select: {
      workspaceId: true
    }
  })

  if (!membership || await isWorkspaceDisabled({ workspaceId })) {
    throw forbidden('You do not have access to this workspace.')
  }

  setWorkspaceContextCookie(response, workspaceId)
  response.status(204).end()
}