import type { AuthBootstrap } from '@printstream/shared'
import { countAccessibleWorkspaceChoices, listAccessibleWorkspaces } from './workspaceAccess'
import { buildPlatformWorkspacePath, buildWorkspacePath, buildWorkspaceSelectionPath, isPlatformWorkspacePath, parseWorkspacePathname } from './workspaceRoute'

/** Chooses the first stable route to land on after a successful browser sign-in. */
export function resolvePostAuthRedirectPath(bootstrap: AuthBootstrap, redirectPath?: string): string {
  const canUsePlatformWorkspace = bootstrap.actor.type === 'user' && Boolean(bootstrap.actor.isPlatformUser)
  const predictableWorkspaceSlug = resolvePredictableWorkspaceSlug(bootstrap, canUsePlatformWorkspace)
  const workspaceChoiceCount = bootstrap.workspace
    ? 0
    : countAccessibleWorkspaceChoices({
        workspaces: bootstrap.memberWorkspaces,
        includePlatform: canUsePlatformWorkspace
      })

  const explicitRedirect = resolveExplicitRedirectPath(redirectPath)
  if (explicitRedirect) {
    return explicitRedirect
  }

  if (workspaceChoiceCount > 1) {
    return buildWorkspaceSelectionPath()
  }

  if (predictableWorkspaceSlug) {
    return buildWorkspacePath(predictableWorkspaceSlug, '/')
  }

  return canUsePlatformWorkspace ? buildPlatformWorkspacePath() : buildWorkspaceSelectionPath()
}

function resolvePredictableWorkspaceSlug(bootstrap: AuthBootstrap, canUsePlatformWorkspace: boolean): string | null {
  if (bootstrap.workspace?.slug) {
    return bootstrap.workspace.slug
  }

  const workspaceOptions = listAccessibleWorkspaces(bootstrap.memberWorkspaces)
  if (!canUsePlatformWorkspace && workspaceOptions.length === 1) {
    return workspaceOptions[0]?.slug ?? null
  }

  return null
}

function resolveExplicitRedirectPath(redirectPath: string | undefined): string | null {
  if (!redirectPath || redirectPath === '/' || redirectPath === '/auth') {
    return null
  }

  if (parseWorkspacePathname(redirectPath).workspaceSlug) {
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