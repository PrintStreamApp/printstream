/**
 * Derives the workspace the current page is in (from the URL) and turns it into
 * the `X-PrintStream-Tenant` request header that `apiClient` attaches to every
 * request, so the API scopes the response to the right workspace.
 *
 * The `'none'` sentinel is deliberate: in a browser with no workspace in the
 * path, `readWorkspaceContextHeader` returns `'none'` (sent as the header) rather
 * than null (header omitted), so the API is explicitly told "no workspace" and
 * does NOT fall back to an ambient tenant. Header omitted only outside a browser
 * (no window), where there is nothing to scope.
 */
import { isPlatformWorkspacePath, parseWorkspacePathname } from './workspaceRoute'

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