const WORKSPACE_SELECTION_PATH = '/workspaces'
const WORKSPACE_SELECTION_PREFIX = `${WORKSPACE_SELECTION_PATH}/`
const PLATFORM_WORKSPACE_PATH = '/platform'
const PLATFORM_WORKSPACE_PREFIX = `${PLATFORM_WORKSPACE_PATH}/`

export interface ParsedWorkspacePath {
  workspaceSlug: string | null
  appPathname: string
}

export function buildWorkspaceSelectionPath(): string {
  return WORKSPACE_SELECTION_PATH
}

export function buildPlatformWorkspacePath(): string {
  return PLATFORM_WORKSPACE_PATH
}

export function buildWorkspacePath(workspaceSlug: string, path = '/'): string {
  const normalizedWorkspaceSlug = normalizeWorkspaceSlug(workspaceSlug)
  const { pathname, suffix } = splitRoute(path)
  const normalizedPathname = normalizeAppPathname(pathname)
  const scopedPathname = normalizedPathname === '/' ? '' : normalizedPathname
  return `${WORKSPACE_SELECTION_PATH}/${normalizedWorkspaceSlug}${scopedPathname}${suffix}`
}

export function parseWorkspacePathname(pathname: string): ParsedWorkspacePath {
  const normalizedPathname = normalizeAppPathname(pathname)
  if (!normalizedPathname.startsWith(WORKSPACE_SELECTION_PREFIX)) {
    return { workspaceSlug: null, appPathname: normalizedPathname }
  }

  const remainder = normalizedPathname.slice(WORKSPACE_SELECTION_PREFIX.length)
  if (!remainder) {
    return { workspaceSlug: null, appPathname: normalizedPathname }
  }

  const slashIndex = remainder.indexOf('/')
  const workspaceSlug = normalizeWorkspaceSlug(slashIndex === -1 ? remainder : remainder.slice(0, slashIndex))
  const appPathname = slashIndex === -1 ? '/' : normalizeAppPathname(remainder.slice(slashIndex))
  return { workspaceSlug, appPathname }
}

export function isWorkspaceCandidatePath(pathname: string): boolean {
  const { appPathname } = parseWorkspacePathname(pathname)

  if (appPathname === '/auth' || appPathname.startsWith('/auth/')) return false
  if (appPathname === WORKSPACE_SELECTION_PATH || appPathname.startsWith(`${WORKSPACE_SELECTION_PATH}/`)) return false
  if (appPathname === '/platform' || appPathname.startsWith('/platform/')) return false
  // The billing scope is its own thing, one level ABOVE the workspaces, so its
  // paths must never be re-scoped under a workspace slug.
  if (appPathname === '/billing' || appPathname.startsWith('/billing/')) return false

  return true
}

export function isPlatformWorkspacePath(pathname: string): boolean {
  const normalizedPathname = normalizeAppPathname(pathname)
  return normalizedPathname === PLATFORM_WORKSPACE_PATH || normalizedPathname.startsWith(PLATFORM_WORKSPACE_PREFIX)
}

function normalizeWorkspaceSlug(workspaceSlug: string): string {
  return workspaceSlug.trim().toLowerCase()
}

function normalizeAppPathname(pathname: string): string {
  if (!pathname) return '/'
  return pathname.startsWith('/') ? pathname : `/${pathname}`
}

function splitRoute(path: string): { pathname: string; suffix: string } {
  const match = /^(?<pathname>[^?#]*)(?<suffix>[?#].*)?$/u.exec(path)
  return {
    pathname: match?.groups?.pathname ?? path,
    suffix: match?.groups?.suffix ?? ''
  }
}

/** What the workspace chooser is called wherever it is offered. */
export const WORKSPACE_CHOOSER_LABEL = 'Switch workspace'

/**
 * The chooser page's own heading.
 *
 * A question keeps the heading natural above both cloud and administrative
 * workspaces.
 */
export const WORKSPACE_CHOOSER_TITLE = 'Where do you want to work?'
