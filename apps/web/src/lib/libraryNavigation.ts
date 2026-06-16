import type { LibraryFolder } from '@printstream/shared'
import { buildTenantWorkspacePath } from './workspaceRoute'

const LIBRARY_ROUTE = '/library'

export interface LibraryBreadcrumbCrumb {
  id: string | null
  name: string
  navigable: boolean
  dropTarget: 'none' | 'folder' | 'bridge-root'
}

export function buildLibraryBreadcrumb(
  folders: LibraryFolder[],
  folderId: string | null,
  bridgeId: string | null,
  bridgeName: string | null,
  options?: { showRoot?: boolean; rootNavigable?: boolean }
): LibraryBreadcrumbCrumb[] {
  const showRoot = options?.showRoot ?? true
  const rootNavigable = options?.rootNavigable ?? showRoot
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const path: LibraryBreadcrumbCrumb[] = []
  let current: string | null = folderId

  for (let depth = 0; depth < 64 && current; depth += 1) {
    const folder = byId.get(current)
    if (!folder) break
    path.unshift({
      id: folder.id,
      name: folder.name,
      navigable: true,
      dropTarget: 'folder'
    })
    current = folder.parentId
  }

  const crumbs: LibraryBreadcrumbCrumb[] = []
  if (showRoot) {
    crumbs.push({
      id: null,
      name: 'Root',
      navigable: rootNavigable,
      dropTarget: 'none'
    })
  }

  if (bridgeId && bridgeName) {
    crumbs.push({
      id: toBridgeFolderId(bridgeId),
      name: bridgeName,
      navigable: true,
      dropTarget: 'bridge-root'
    })
  }

  crumbs.push(...path)

  if (crumbs.length === 0) {
    return [{
      id: null,
      name: 'Root',
      navigable: rootNavigable,
      dropTarget: 'none'
    }]
  }

  return crumbs
}

export function toBridgeFolderId(bridgeId: string): string {
  return `bridge:${bridgeId}`
}

export function isBridgeFolderId(folderId: string): boolean {
  return folderId.startsWith('bridge:')
}

export function fromBridgeFolderId(folderId: string): string {
  return folderId.slice('bridge:'.length)
}

export function buildLibraryFolderRoute(tenantSlug: string, folderId: string | null, bridgeId: string | null): string {
  const path = folderId ? `${LIBRARY_ROUTE}/${encodeURIComponent(folderId)}` : LIBRARY_ROUTE
  const route = bridgeId ? `${path}?bridge=${encodeURIComponent(bridgeId)}` : path
  return buildTenantWorkspacePath(tenantSlug, route)
}