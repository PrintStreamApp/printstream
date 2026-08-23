/**
 * Request-scoped workspace resolution for cloud-hosted deployments.
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
import { isWorkspaceDisabled } from './workspace-availability.js'
import { REQUEST_WORKSPACE_SELECT, toRequestWorkspaceSummary, type RequestWorkspaceSummary } from './workspace-summary.js'
import { visibleWorkspacesWhere } from './workspace-visibility.js'

// Re-exported so the many existing importers of this module keep working; the
// definitions live in `workspace-summary.ts` to stay out of this module's runtime
// cycle with `workspace-resolution.ts`.
export { REQUEST_WORKSPACE_SELECT, toRequestWorkspaceSummary, type RequestWorkspaceSummary }

interface WorkspaceRequestContext {
  workspace: RequestWorkspaceSummary | null
  requestedSlug: string | null
  platformRequest: boolean
}

// Both renamed with the code. The header is a per-request hint from our own web
// app, which deploys with this API. The cookie is per-browser workspace context:
// a browser holding the old one is not signed out, it simply lands on the
// workspace chooser once and re-picks.
const WORKSPACE_OVERRIDE_HEADER = 'x-printstream-workspace'
const WORKSPACE_CONTEXT_COOKIE_NAME = 'printstream_workspace_context'
const PLATFORM_WORKSPACE_CONTEXT_VALUE = 'platform'
const NO_WORKSPACE_CONTEXT_VALUE = 'none'
const workspaceContextStorage = new AsyncLocalStorage<WorkspaceRequestContext>()

export function installWorkspaceContext() {
  return async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      const context = await resolveWorkspaceRequestContext(request)
      request.workspace = context.workspace
      workspaceContextStorage.run(context, () => next())
    } catch (error) {
      next(error)
    }
  }
}

export function getWorkspaceRequestContext(): WorkspaceRequestContext {
  return workspaceContextStorage.getStore() ?? {
    workspace: null,
    requestedSlug: null,
    platformRequest: true
  }
}

export function hasWorkspaceRequestContext(): boolean {
  return workspaceContextStorage.getStore() != null
}

export function getCurrentWorkspace(): RequestWorkspaceSummary | null {
  return getWorkspaceRequestContext().workspace
}

export async function withWorkspaceRequestContext<T>(
  workspace: RequestWorkspaceSummary | null,
  callback: () => Promise<T>
): Promise<T> {
  return await workspaceContextStorage.run({
    workspace,
    requestedSlug: workspace?.slug ?? null,
    platformRequest: workspace == null
  }, callback)
}

export async function withResolvedWorkspaceRequestContext<T>(
  request: Pick<Request, 'headers'>,
  callback: () => Promise<T>
): Promise<T> {
  const context = await resolveWorkspaceRequestContext(request)
  return await workspaceContextStorage.run(context, callback)
}

export async function resolveEffectiveWorkspaceForAuth(
  auth: RequestAuthContext,
  requestWorkspace: RequestWorkspaceSummary | null,
  input: {
    requestWorkspaceAuthEnabled?: boolean
  } = {}
): Promise<RequestWorkspaceSummary | null> {
  if (auth.actor.type === 'anonymous') {
    return requestWorkspace
  }

  const actorWorkspace = readActorWorkspace(auth.actor)
  if (actorWorkspace) {
    return actorWorkspace
  }

  if (auth.actor.type === 'user' && auth.actor.isPlatformUser && requestWorkspace) {
    const bypassSupportAccess = hasSupportAccessBypass(auth.platformPermissions ?? auth.permissions)
    return await isSupportAccessAllowed({
      workspaceId: requestWorkspace.id,
      bypassSupportAccess,
      authEnabled: input.requestWorkspaceAuthEnabled
    }) ? requestWorkspace : null
  }

  return null
}

export function setWorkspaceContextCookie(response: Response, workspaceId: string | null): void {
  setCookieHeader(
    response,
    WORKSPACE_CONTEXT_COOKIE_NAME,
    workspaceId ?? PLATFORM_WORKSPACE_CONTEXT_VALUE,
    60 * 60 * 24 * 30
  )
}

export function clearWorkspaceContextCookie(response: Response): void {
  setCookieHeader(response, WORKSPACE_CONTEXT_COOKIE_NAME, '', 0)
}

async function resolveWorkspaceRequestContext(request: Pick<Request, 'headers'>): Promise<WorkspaceRequestContext> {
  const actorWorkspace = readActorWorkspace((request as Request).auth?.actor)
  if (actorWorkspace) {
    return {
      workspace: actorWorkspace,
      requestedSlug: actorWorkspace.slug,
      platformRequest: false
    }
  }

  const explicitSelection = readRequestedWorkspaceValue(request)
  if (explicitSelection === NO_WORKSPACE_CONTEXT_VALUE) {
    // "No workspace chosen" (the web's ambient pages, e.g. `/`). On a
    // wide-open install there is exactly one possible choice, so default into
    // it; an explicit platform selection below stays on the platform scope.
    const wideOpenContext = await resolveWideOpenRequestContext(request)
    if (wideOpenContext) {
      return wideOpenContext
    }

    return {
      workspace: null,
      requestedSlug: null,
      platformRequest: false
    }
  }
  if (explicitSelection === PLATFORM_WORKSPACE_CONTEXT_VALUE) {
    return {
      workspace: null,
      requestedSlug: null,
      platformRequest: true
    }
  }
  const explicitSlug = normalizeWorkspaceSlug(explicitSelection)
  if (explicitSlug) {
    // findFirst, not findUnique: a deleted workspace must resolve to nothing at
    // all. "Deleted" is not "disabled": disabled is an operator flag on a
    // workspace that still exists, whereas this one should behave as though it
    // never did, which is why it falls through to notFound rather than the
    // disabled branch below.
    const workspace = await prisma.workspace.findFirst({
      where: visibleWorkspacesWhere({ slug: explicitSlug }),
      select: REQUEST_WORKSPACE_SELECT
    })
    if (!workspace) {
      throw notFound('Workspace not found.')
    }
    if (await isWorkspaceDisabled({ workspaceId: workspace.id })) {
      return {
        workspace: null,
        requestedSlug: null,
        platformRequest: true
      }
    }

    return await resolveSupportWorkspaceRequestContext(request as Request, toRequestWorkspaceSummary(workspace))
  }

  const cookieSelection = await resolveWorkspaceContextCookieSelection(request as Request)
  if (cookieSelection) {
    return cookieSelection
  }

  const requestedSlug = normalizeWorkspaceSlug(readRequestedWorkspaceSlug(request))
  if (!requestedSlug) {
    // No explicit selection, cookie, or workspace host.
    const wideOpenContext = await resolveWideOpenRequestContext(request)
    if (wideOpenContext) {
      return wideOpenContext
    }

    return {
      workspace: null,
      requestedSlug: null,
      platformRequest: true
    }
  }

  const workspace = await prisma.workspace.findFirst({
    where: visibleWorkspacesWhere({ slug: requestedSlug }),
    select: REQUEST_WORKSPACE_SELECT
  })
  if (!workspace) {
    throw notFound('Workspace not found.')
  }
  if (await isWorkspaceDisabled({ workspaceId: workspace.id })) {
    return {
      workspace: null,
      requestedSlug: null,
      platformRequest: true
    }
  }

  return await resolveSupportWorkspaceRequestContext(request as Request, toRequestWorkspaceSummary(workspace))
}

async function resolveWorkspaceContextCookieSelection(request: Request): Promise<WorkspaceRequestContext | null> {
  const selection = readRequestCookie(request, WORKSPACE_CONTEXT_COOKIE_NAME)
  if (!selection) {
    return null
  }

  if (selection === PLATFORM_WORKSPACE_CONTEXT_VALUE) {
    return {
      workspace: null,
      requestedSlug: null,
      platformRequest: true
    }
  }

  const workspace = await prisma.workspace.findFirst({
    where: visibleWorkspacesWhere({ id: selection }),
    select: REQUEST_WORKSPACE_SELECT
  })
  if (!workspace) {
    return null
  }
  if (await isWorkspaceDisabled({ workspaceId: workspace.id })) {
    return null
  }

  return await resolveSupportWorkspaceRequestContext(request, toRequestWorkspaceSummary(workspace))
}

async function resolveSupportWorkspaceRequestContext(
  request: Request,
  workspace: RequestWorkspaceSummary
): Promise<WorkspaceRequestContext> {
  if (request.auth?.actor.type === 'user' && request.auth.actor.isPlatformUser) {
    const accessAllowed = await isSupportAccessAllowed({
      workspaceId: workspace.id,
      bypassSupportAccess: hasSupportAccessBypass(request.auth.platformPermissions ?? request.auth.permissions)
    })
    if (!accessAllowed) {
      return {
        workspace: null,
        requestedSlug: null,
        platformRequest: true
      }
    }
  }

  return {
    workspace,
    requestedSlug: workspace.slug,
    platformRequest: false
  }
}

function readRequestedWorkspaceSlug(request: Pick<Request, 'headers'>): string | null {
  const headerValue = readRequestedWorkspaceValue(request)
  if (headerValue && headerValue !== PLATFORM_WORKSPACE_CONTEXT_VALUE && headerValue !== NO_WORKSPACE_CONTEXT_VALUE) return headerValue

  const hostname = readHostName(request)
  if (hostname && env.WORKSPACE_DOMAIN_SUFFIX) {
    const normalizedHost = hostname.toLowerCase()
    const suffix = env.WORKSPACE_DOMAIN_SUFFIX.toLowerCase()
    if (normalizedHost !== suffix && normalizedHost.endsWith(`.${suffix}`)) {
      return normalizedHost.slice(0, -(suffix.length + 1))
    }
  }

  return null
}

function readRequestedWorkspaceValue(request: Pick<Request, 'headers'>): string | null {
  const headerValue = readHeaderValue(request, WORKSPACE_OVERRIDE_HEADER)
  if (headerValue) return headerValue

  const url = (request as Pick<Request, 'headers'> & { url?: string }).url
  if (!url) return null
  try {
    const parsed = new URL(url, 'http://printstream.local')
    const value = parsed.searchParams.get('workspace')?.trim()
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

function normalizeWorkspaceSlug(value: string | null): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized.length > 0 ? normalized : null
}

/**
 * Wide-open fallback: on an install with no auth provider enabled anywhere
 * (so nobody can be signed in), context-less requests default into the single
 * workspace so the web app lands inside it instead of a dead-end sign-in
 * wall. Requests carrying any sign-in credential are excluded, a session
 * implies auth is enabled in some scope, and the session's own workspace binding
 * must win. Dynamic import: workspace-resolution (transitively) imports this module.
 */
async function resolveWideOpenRequestContext(request: Pick<Request, 'headers'>): Promise<WorkspaceRequestContext | null> {
  // Flows that resolve auth before workspace context (e.g. websocket upgrades)
  // already know the actor; anyone signed in is never wide-open traffic.
  const resolvedActor = (request as Request).auth?.actor
  if (resolvedActor && resolvedActor.type !== 'anonymous') {
    return null
  }

  if (readHeaderValue(request, 'authorization')) {
    return null
  }

  // A session cookie only disqualifies the request when it resolves to a
  // live session: stale cookies left behind by older deployments on the
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

  const { resolveWideOpenDefaultWorkspace, resolveSoleWorkspace } = await import('./workspace-resolution.js')
  const wideOpenWorkspace = await resolveWideOpenDefaultWorkspace()
  if (wideOpenWorkspace) {
    return {
      workspace: wideOpenWorkspace,
      requestedSlug: wideOpenWorkspace.slug,
      platformRequest: false
    }
  }

  // Self-hosted (OSS) is a single-workspace deployment with no separate platform
  // sign-in. Once the workspace enables auth it is no longer "wide open", but an
  // anonymous, context-less request (e.g. the `/auth` screen after sign-out)
  // still needs to land in the sole workspace so its sign-in provider is shown,
  // otherwise the platform scope has no enabled provider and the screen is empty.
  if (isSelfHostedDeployment()) {
    const soleWorkspace = await resolveSoleWorkspace()
    if (soleWorkspace) {
      return {
        workspace: soleWorkspace,
        requestedSlug: soleWorkspace.slug,
        platformRequest: false
      }
    }
  }

  return null
}

function readActorWorkspace(actor: RequestAuthActor | undefined): RequestWorkspaceSummary | null {
  if (!actor || actor.type === 'anonymous') {
    return null
  }

  return actor.workspace ?? null
}