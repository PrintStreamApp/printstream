import type { LibraryFolder } from '@printstream/shared'
import { buildWorkspacePath } from './workspaceRoute'

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

export function buildLibraryFolderRoute(workspaceSlug: string, folderId: string | null, bridgeId: string | null): string {
  const path = folderId ? `${LIBRARY_ROUTE}/${encodeURIComponent(folderId)}` : LIBRARY_ROUTE
  const route = bridgeId ? `${path}?bridge=${encodeURIComponent(bridgeId)}` : path
  return buildWorkspacePath(workspaceSlug, route)
}

/**
 * Route that opens the library on a file AND asks it to start the slice flow for it.
 *
 * The handoff for surfaces that produce a file but do not own the slice/print dialog
 * stack, today the remote-import view, whose "Import and print" lands an unsliced
 * project. `LibraryView` consumes `slice`/`sliceFlow` once and strips them, so this is
 * a one-shot instruction rather than sticky state: sharing or refreshing the resulting
 * URL will not reopen the dialog.
 *
 * `flow: 'print'` is the prepare-print path (slice, then send to a printer); 'library'
 * just opens the slice settings.
 */
export function buildLibrarySliceHandoffRoute(input: {
  workspaceSlug: string
  fileId: string
  folderId: string | null
  bridgeId: string | null
  flow?: 'library' | 'print'
}): string {
  const base = input.folderId ? `${LIBRARY_ROUTE}/${encodeURIComponent(input.folderId)}` : LIBRARY_ROUTE
  const params = new URLSearchParams()
  if (input.bridgeId) params.set('bridge', input.bridgeId)
  params.set('slice', input.fileId)
  if (input.flow === 'print') params.set('sliceFlow', 'print')
  return buildWorkspacePath(input.workspaceSlug, `${base}?${params.toString()}`)
}

/** Static path segment for the "Favorite Files" view (its own route, so it is bookmarkable + in history). */
export const LIBRARY_FAVORITES_SEGMENT = 'favorites'

/** Route for the favorites view, a flat, cross-folder list of the user's starred files. */
export function buildLibraryFavoritesRoute(workspaceSlug: string, bridgeId: string | null): string {
  const path = `${LIBRARY_ROUTE}/${LIBRARY_FAVORITES_SEGMENT}`
  const route = bridgeId ? `${path}?bridge=${encodeURIComponent(bridgeId)}` : path
  return buildWorkspacePath(workspaceSlug, route)
}

/** Whether a pathname is the favorites view route (`.../library/favorites`). */
export function isLibraryFavoritesPath(pathname: string): boolean {
  return new RegExp(`${LIBRARY_ROUTE}/${LIBRARY_FAVORITES_SEGMENT}/?$`).test(pathname)
}