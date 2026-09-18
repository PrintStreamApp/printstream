/**
 * Native notification audience policy for Windows polling and Android delivery.
 * Auth-disabled self-hosted scopes admit device enrollment, never personal or platform events.
 * Recheck providers at delivery time so enabling authentication stops anonymous delivery.
 */
import type { Request } from 'express'
import { anonymousNotificationAccount, nativeNotificationAccount } from '@printstream/shared'
import type { ApiPluginContext } from '../plugin/types.js'
import { authProviderRegistry } from './auth-registry.js'
import { isSelfHostedDeployment } from './deployment-mode.js'
import { isPublicDemoWorkspace } from './public-demo-policy.js'
import { unauthorized } from './http-error.js'
import { REQUEST_WORKSPACE_SELECT, withWorkspaceRequestContext } from './workspace-context.js'
import { visibleWorkspacesWhere } from './workspace-visibility.js'
import { isWorkspaceDisabled } from './workspace-availability.js'

/** Derive the caller's consent identity from authoritative auth state, never a supplied account header. */
export function requestNativeNotificationAccount(request: Request): string {
  const account = nativeNotificationAccount({
    actor: request.auth.actor,
    authEnabled: request.auth.authEnabled,
    workspace: request.workspace,
    runtimePolicy: { selfHosted: isSelfHostedDeployment(), demoMode: request.auth.runtimePolicy?.demoMode }
  })
  if (!account) {
    throw unauthorized('Sign in to enable app notifications.')
  }

  return account
}

/** Live eligibility is shared by enrollment and fan-out. Platform support access never substitutes for membership. */
export async function mayReceiveNativeNotifications(context: ApiPluginContext, account: string, scope: string | null): Promise<boolean> {
  if (account.startsWith('anonymous:')) {
    if (!scope || account !== anonymousNotificationAccount(scope) || !isSelfHostedDeployment()) {
      return false
    }

    const workspace = await context.prisma.workspace.findFirst({
      where: visibleWorkspacesWhere({ id: scope }),
      select: REQUEST_WORKSPACE_SELECT
    })
    if (!workspace || isPublicDemoWorkspace(workspace)) {
      return false
    }

    if (await isWorkspaceDisabled({ workspaceId: scope, prismaClient: context.prisma })) {
      return false
    }

    // Providers read workspace settings, so background delivery needs the same context as a request.
    return withWorkspaceRequestContext(workspace, async () => !await authProviderRegistry.hasEnabledProviders())
  }

  if (scope) {
    return Boolean(await context.prisma.authWorkspaceMembership.findFirst({
      where: { userId: account, workspaceId: scope, loginDisabled: false }, select: { userId: true }
    }))
  }

  return Boolean(await context.prisma.authUser.findFirst({
    where: { id: account, isPlatformUser: true }, select: { id: true }
  }))
}
