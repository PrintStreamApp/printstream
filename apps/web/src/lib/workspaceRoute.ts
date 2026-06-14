const WORKSPACE_SELECTION_PATH = '/workspaces'
const WORKSPACE_SELECTION_PREFIX = `${WORKSPACE_SELECTION_PATH}/`
const PLATFORM_WORKSPACE_PATH = '/platform'
const PLATFORM_WORKSPACE_PREFIX = `${PLATFORM_WORKSPACE_PATH}/`

export interface ParsedWorkspacePath {
  tenantSlug: string | null
  appPathname: string
}

export function buildWorkspaceSelectionPath(): string {
  return WORKSPACE_SELECTION_PATH
}

export function buildPlatformWorkspacePath(): string {
  return PLATFORM_WORKSPACE_PATH
}

export function buildTenantWorkspacePath(tenantSlug: string, path = '/'): string {
  const normalizedTenantSlug = normalizeTenantSlug(tenantSlug)
  const { pathname, suffix } = splitRoute(path)
  const normalizedPathname = normalizeAppPathname(pathname)
  const scopedPathname = normalizedPathname === '/' ? '' : normalizedPathname
  return `${WORKSPACE_SELECTION_PATH}/${normalizedTenantSlug}${scopedPathname}${suffix}`
}

export function parseWorkspacePathname(pathname: string): ParsedWorkspacePath {
  const normalizedPathname = normalizeAppPathname(pathname)
  if (!normalizedPathname.startsWith(WORKSPACE_SELECTION_PREFIX)) {
    return { tenantSlug: null, appPathname: normalizedPathname }
  }

  const remainder = normalizedPathname.slice(WORKSPACE_SELECTION_PREFIX.length)
  if (!remainder) {
    return { tenantSlug: null, appPathname: normalizedPathname }
  }

  const slashIndex = remainder.indexOf('/')
  const tenantSlug = normalizeTenantSlug(slashIndex === -1 ? remainder : remainder.slice(0, slashIndex))
  const appPathname = slashIndex === -1 ? '/' : normalizeAppPathname(remainder.slice(slashIndex))
  return { tenantSlug, appPathname }
}

export function isTenantWorkspaceCandidatePath(pathname: string): boolean {
  const { appPathname } = parseWorkspacePathname(pathname)

  if (appPathname === '/auth' || appPathname.startsWith('/auth/')) return false
  if (appPathname === WORKSPACE_SELECTION_PATH || appPathname.startsWith(`${WORKSPACE_SELECTION_PATH}/`)) return false
  if (appPathname === '/platform' || appPathname.startsWith('/platform/')) return false

  return true
}

export function isPlatformWorkspacePath(pathname: string): boolean {
  const normalizedPathname = normalizeAppPathname(pathname)
  return normalizedPathname === PLATFORM_WORKSPACE_PATH || normalizedPathname.startsWith(PLATFORM_WORKSPACE_PREFIX)
}

function normalizeTenantSlug(tenantSlug: string): string {
  return tenantSlug.trim().toLowerCase()
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