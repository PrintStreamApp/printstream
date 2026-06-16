import type { AuthBootstrap } from '@printstream/shared'
import { countAccessibleWorkspaceChoices, listAccessibleTenantWorkspaces } from './workspaceAccess'
import { buildPlatformWorkspacePath, buildTenantWorkspacePath, buildWorkspaceSelectionPath, isPlatformWorkspacePath, parseWorkspacePathname } from './workspaceRoute'

/** Chooses the first stable route to land on after a successful browser sign-in. */
export function resolvePostAuthRedirectPath(bootstrap: AuthBootstrap, redirectPath?: string): string {
  const canUsePlatformWorkspace = bootstrap.actor.type === 'user' && Boolean(bootstrap.actor.isPlatformUser)
  const predictableTenantSlug = resolvePredictableTenantSlug(bootstrap, canUsePlatformWorkspace)
  const workspaceChoiceCount = bootstrap.tenant
    ? 0
    : countAccessibleWorkspaceChoices({
        tenants: bootstrap.memberTenants,
        includePlatform: canUsePlatformWorkspace
      })

  const explicitRedirect = resolveExplicitRedirectPath(redirectPath)
  if (explicitRedirect) {
    return explicitRedirect
  }

  if (workspaceChoiceCount > 1) {
    return buildWorkspaceSelectionPath()
  }

  if (predictableTenantSlug) {
    return buildTenantWorkspacePath(predictableTenantSlug, '/')
  }

  return canUsePlatformWorkspace ? buildPlatformWorkspacePath() : buildWorkspaceSelectionPath()
}

function resolvePredictableTenantSlug(bootstrap: AuthBootstrap, canUsePlatformWorkspace: boolean): string | null {
  if (bootstrap.tenant?.slug) {
    return bootstrap.tenant.slug
  }

  const tenantOptions = listAccessibleTenantWorkspaces(bootstrap.memberTenants)
  if (!canUsePlatformWorkspace && tenantOptions.length === 1) {
    return tenantOptions[0]?.slug ?? null
  }

  return null
}

function resolveExplicitRedirectPath(redirectPath: string | undefined): string | null {
  if (!redirectPath || redirectPath === '/' || redirectPath === '/auth') {
    return null
  }

  if (parseWorkspacePathname(redirectPath).tenantSlug) {
    return redirectPath
  }

  if (redirectPath === buildWorkspaceSelectionPath() || redirectPath.startsWith(`${buildWorkspaceSelectionPath()}/`)) {
    return redirectPath
  }

  if (isPlatformWorkspacePath(redirectPath)) {
    return redirectPath
  }

  return null
}