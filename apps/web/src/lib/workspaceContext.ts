import { isPlatformWorkspacePath, parseWorkspacePathname } from './workspaceRoute'

const WORKSPACE_CONTEXT_KEY = 'bambu.workspaceContext'
const PLATFORM_CONTEXT_VALUE = 'platform'
const NO_WORKSPACE_CONTEXT_VALUE = 'none'

export type WorkspaceContextHint =
  | { type: 'platform' }
  | { type: 'tenant'; slug: string }

export function readWorkspaceContextHint(): WorkspaceContextHint | null {
  if (typeof window === 'undefined') return null
  const routeTenantSlug = parseWorkspacePathname(window.location.pathname).tenantSlug
  if (routeTenantSlug) return { type: 'tenant', slug: routeTenantSlug }
  if (isPlatformWorkspacePath(window.location.pathname)) return { type: 'platform' }
  return null
}

export function readWorkspaceContextHeader(): string | null {
  if (typeof window !== 'undefined' && !readWorkspaceContextHint()) return NO_WORKSPACE_CONTEXT_VALUE
  const hint = readWorkspaceContextHint()
  if (!hint) return null
  return hint.type === 'platform' ? PLATFORM_CONTEXT_VALUE : hint.slug
}

export function writePlatformWorkspaceContext(): void {
  if (typeof window === 'undefined') return
  window.sessionStorage.setItem(WORKSPACE_CONTEXT_KEY, PLATFORM_CONTEXT_VALUE)
}

export function writeTenantWorkspaceContext(slug: string): void {
  if (typeof window === 'undefined') return
  const normalized = slug.trim().toLowerCase()
  if (!normalized) return
  window.sessionStorage.setItem(WORKSPACE_CONTEXT_KEY, normalized)
}

export function clearWorkspaceContextHint(): void {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(WORKSPACE_CONTEXT_KEY)
}