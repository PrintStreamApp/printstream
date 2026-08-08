/**
 * Request-scoped auth context.
 *
 * The auth plugin will later replace the default anonymous context with a
 * resolved user or service-account actor. For now this middleware establishes
 * a stable shape on every request so route guards and runtime policy checks can
 * be added incrementally without changing every handler signature.
 */
import { resolvePermissionScope, type Permission, type PermissionScope } from '@printstream/shared'
import type { NextFunction, Request, Response } from 'express'
import { authProviderRegistry } from './auth-registry.js'
import { prisma } from './prisma.js'
import { resolveRequestAuth } from './auth-session.js'
import { applyPublicDemoGuestAuth } from './public-demo-policy.js'
import type { RequestWorkspaceSummary } from './workspace-context.js'
import { getCurrentWorkspace, resolveEffectiveWorkspaceForAuth, withResolvedWorkspaceRequestContext, withWorkspaceRequestContext } from './workspace-context.js'

export interface AnonymousAuthActor {
  type: 'anonymous'
}

export interface UserAuthActor {
  type: 'user'
  userId: string
  isPlatformUser?: boolean
  workspace?: RequestWorkspaceSummary | null
}

export interface ServiceAccountAuthActor {
  type: 'service-account'
  serviceAccountId: string
  workspace?: RequestWorkspaceSummary | null
}

export type RequestAuthActor = AnonymousAuthActor | UserAuthActor | ServiceAccountAuthActor

export interface RequestRuntimePolicy {
  demoMode: boolean
}

export interface RequestAuthContext {
  authEnabled: boolean
  /** Anonymous visitor admitted to the reserved public demo workspace. */
  publicDemoGuest?: boolean
  actor: RequestAuthActor
  permissions: Permission[]
  platformPermissions?: Permission[]
  runtimePolicy: RequestRuntimePolicy
}

export function authUsesExplicitPermissions(auth: Pick<RequestAuthContext, 'authEnabled' | 'publicDemoGuest'>): boolean {
  return auth.authEnabled || auth.publicDemoGuest === true
}

export function createAnonymousAuthContext(input: { demoMode: boolean; authEnabled: boolean }): RequestAuthContext {
  return {
    authEnabled: input.authEnabled,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: {
      demoMode: input.demoMode
    }
  }
}

export function installAuthContext(input: { demoMode: boolean }) {
  return async (_request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      const anonymous = createAnonymousAuthContext({
        demoMode: input.demoMode,
        authEnabled: false
      })
      const resolvedAuth = await withResolvedWorkspaceRequestContext(_request, async () => {
        const auth = await resolveRequestAuth(prisma, _request, anonymous, _response)
        const requestWorkspace = getCurrentWorkspace()
        return {
          auth: applyPublicDemoGuestAuth(auth, requestWorkspace),
          requestWorkspace
        }
      })
      const requestWorkspaceAuthEnabled = resolvedAuth.requestWorkspace
        ? await withWorkspaceRequestContext(resolvedAuth.requestWorkspace, async () => await authProviderRegistry.hasEnabledProviders())
        : false
      const effectiveWorkspace = await resolveEffectiveWorkspaceForAuth(resolvedAuth.auth, resolvedAuth.requestWorkspace, {
        requestWorkspaceAuthEnabled
      })
      const authEnabled = await withWorkspaceRequestContext(effectiveWorkspace, async () => await authProviderRegistry.hasEnabledProviders())
      await withWorkspaceRequestContext(effectiveWorkspace, async () => {
        _request.workspace = effectiveWorkspace
        _request.auth = {
          ...resolvedAuth.auth,
          authEnabled
        }
        next()
      })
    } catch (error) {
      next(error)
    }
  }
}

export function requestHasPermission(request: Request, permission: PermissionScope): boolean {
  return request.auth.permissions.includes(resolvePermissionScope(permission))
}