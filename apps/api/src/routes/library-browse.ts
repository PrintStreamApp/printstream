/**
 * Flat and bridge-aware library browse routes.
 *
 * Both listings apply visibility, workspace, favorite, sort, and recency-cap policy before
 * returning DTOs. The parent registers this family before all file-id routes.
 */
import type { LibraryFile as LibraryFileModel, Prisma } from '@prisma/client'
import type { Router } from 'express'
import {
  libraryBrowseResponseSchema,
  LIBRARY_VIEW_PERMISSION,
  librarySortKeySchema,
  librarySortDirectionSchema,
  type LibrarySortKey,
  type LibrarySortDirection,
  type LibraryFile as LibraryFileDto
} from '@printstream/shared'
import { requireRequestPermission } from '../lib/authorization.js'
import { bridgeSessionManager } from '../lib/bridge-session-manager.js'
import { notFound } from '../lib/http-error.js'
import { getFavoritedFileIds, resolveFavoriteOwnerKey } from '../lib/library-favorites.js'
import { libraryTagWhere, parseLibraryTagIds } from '../lib/library-tag-filters.js'
import { visibleLibraryFilesWhere } from '../lib/library-visibility.js'
import { prisma } from '../lib/prisma.js'
import { parseBridgeQuery, toFolderDto } from './library-folders.js'

/**
 * Per-listing file cap for the browse/flat library endpoints. A single folder (or
 * an all-folders search) returns at most this many file rows; past it the response
 * sets `truncated` so the UI can prompt the user to narrow rather than the server
 * silently dropping rows or one request ballooning memory/JSON in a large
 * multi-workspace process. Folders are never capped (they are few). We fetch
 * LIMIT + 1 to detect overflow without a second COUNT query. Mirrors the bounded
 * bridge SD-card listing pattern (`limit`/`truncated`).
 */
export const LIBRARY_BROWSE_FILE_LIMIT = 1000

/**
 * Apply the per-listing file cap. Given the LIMIT + 1 rows fetched to probe for
 * overflow, return at most `limit` rows plus the `truncated` flag and the applied
 * `fileLimit` (null when not truncated, so the payload only advertises a cap when
 * one was actually hit). Pure so the overflow rule is unit-testable.
 */
export function capLibraryFileRows<T>(
  rows: readonly T[],
  limit: number
): { rows: T[]; truncated: boolean; fileLimit: number | null } {
  const truncated = rows.length > limit
  return {
    rows: truncated ? rows.slice(0, limit) : [...rows],
    truncated,
    fileLimit: truncated ? limit : null
  }
}

/** Max distinct ids honoured by the flat listing's resolve-by-id mode (`?ids=`). */
const LIBRARY_FILE_IDS_QUERY_LIMIT = 1000

/**
 * Parse the flat listing's optional `ids` query into a de-duplicated, bounded id
 * list. Returns `null` when no `ids` param was supplied (normal capped listing),
 * or the id array (possibly empty) when it was, so an explicit `?ids=` with no
 * ids resolves to "no files" rather than falling through to the full library.
 */
export function parseLibraryFileIdsQuery(value: unknown): string[] | null {
  if (typeof value !== 'string') return null
  const ids = [...new Set(value.split(',').map((id) => id.trim()).filter(Boolean))]
  return ids.slice(0, LIBRARY_FILE_IDS_QUERY_LIMIT)
}

/** Register the flat and bridge-aware listings at their original early route seam. */
export function registerLibraryBrowseRoutes(
  router: Router,
  toDto: (row: LibraryFileModel, options: { cacheOnly: boolean; favorite: boolean }) => Promise<LibraryFileDto>
): void {
  router.get('/', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    const folderId = parseFolderQuery(request.query.folderId)
    const workspaceId = request.workspace?.id ?? null
    const ownerKey = resolveFavoriteOwnerKey(request)
    const requestedIds = parseLibraryFileIdsQuery(request.query.ids)
    // Hidden files (transient one-off prints) are intentionally excluded
    // from the library UI. They’re still reachable by id for re-dispatch.
    const where: Record<string, unknown> = visibleLibraryFilesWhere({ ownerBridgeId: { not: null } })
    if (workspaceId) where.workspaceId = workspaceId
    if (folderId !== undefined) where.folderId = folderId

    // Resolve-by-id mode: callers that only need specific files (e.g. the orders
    // view resolving the files its templates/orders reference) pass `ids` and get
    // exactly those visible files back, unbounded by the recency cap. This avoids
    // loading the whole library just to look a handful of referenced rows up.
    if (requestedIds) {
      if (requestedIds.length === 0) {
        response.json({ files: [], truncated: false, fileLimit: null })
        return
      }
      where.id = { in: requestedIds }
      const rows = await prisma.libraryFile.findMany({ where, orderBy: { uploadedAt: 'desc' } })
      response.json({
        files: await toLibraryFileDtos(rows, ownerKey, toDto),
        truncated: false,
        fileLimit: null
      })
      return
    }

    const fetched = await prisma.libraryFile.findMany({
      where,
      orderBy: { uploadedAt: 'desc' },
      take: LIBRARY_BROWSE_FILE_LIMIT + 1
    })
    const capped = capLibraryFileRows(fetched, LIBRARY_BROWSE_FILE_LIMIT)
    response.json({
      files: await toLibraryFileDtos(capped.rows, ownerKey, toDto),
      truncated: capped.truncated,
      fileLimit: capped.fileLimit
    })
  })

  /**
   * Bridge-aware library browse contract.
   *
   * This starts as a non-breaking flat view that mirrors the current
   * library root/subfolder behavior. Later phases can switch `mode`
   * and populate synthetic bridge entries without changing callers.
   */
  router.get('/browse', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    const folderId = parseFolderQuery(request.query.folderId) ?? null
    const bridgeId = parseBridgeQuery(request.query.bridgeId)
    const workspaceId = request.workspace?.id ?? null
    const ownerKey = resolveFavoriteOwnerKey(request)
    // Sort + favorites filter are applied in the DB (before the recency cap) so the
    // top files / a user's favorites surface correctly even past LIBRARY_BROWSE_FILE_LIMIT.
    const sortKey = librarySortKeySchema.catch('date').parse(request.query.sort)
    const sortDir = librarySortDirectionSchema.catch('desc').parse(request.query.dir)
    const favoritesOnly = request.query.favoritesOnly === 'true' || request.query.favoritesOnly === '1'
    // Optional all-directories search: when present, match files/folders by name across the WHOLE
    // active bridge (ignoring folderId/parentId) instead of listing one folder. Drives the library
    // search box's "All folders" scope; absent => the normal single-folder listing.
    const search = typeof request.query.search === 'string' ? request.query.search.trim() : ''
    const tagIds = parseLibraryTagIds(request.query.tagIds)
    const searching = search.length > 0
    const nameContains = { contains: search, mode: 'insensitive' as const }
    const bridges = (await prisma.bridge.findMany({
      where: workspaceId ? { workspaceId } : undefined,
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true }
    })).map((bridge) => ({
      ...bridge,
      connected: bridgeSessionManager.isConnected(bridge.id)
    }))

    const requestedFolder = folderId
      ? await prisma.libraryFolder.findFirst({
          where: {
            id: folderId,
            ...(workspaceId ? { workspaceId } : {})
          },
          select: { ownerBridgeId: true }
        })
      : null

    if (folderId && !requestedFolder?.ownerBridgeId) {
      throw notFound('Folder not found')
    }

    if (bridgeId == null && folderId == null && bridges.length !== 1) {
      response.json(libraryBrowseResponseSchema.parse({
        mode: 'bridge-root',
        readOnly: true,
        activeBridgeId: null,
        bridgeEntries: bridges,
        folders: [],
        files: []
      }))
      return
    }

    const activeBridgeId = bridgeId ?? requestedFolder?.ownerBridgeId ?? bridges[0]?.id ?? null
    if (!activeBridgeId) throw notFound('Bridge not found')

    const activeBridge = bridges.find((bridge) => bridge.id === activeBridgeId)
    if (!activeBridge) throw notFound('Bridge not found')

    // Favorites-only and all-folders search are both flat, cross-folder views: they
    // ignore the current folder scope. Favorites-only additionally shows no folder
    // rows, just the user's starred files in one flat list across the bridge.
    const flatList = searching || favoritesOnly
    const [fileRows, folderRows] = await Promise.all([
      prisma.libraryFile.findMany({
        where: visibleLibraryFilesWhere({
          ...libraryTagWhere(workspaceId, search, tagIds),
          ...(flatList ? {} : { folderId }),
          ownerBridgeId: activeBridgeId,
          ...(workspaceId ? { workspaceId } : {}),
          ...(favoritesOnly ? { favorites: { some: { userId: ownerKey } } } : {})
        }),
        orderBy: buildLibraryFileOrderBy(sortKey, sortDir),
        take: LIBRARY_BROWSE_FILE_LIMIT + 1
      }),
      favoritesOnly
        ? Promise.resolve([] as Awaited<ReturnType<typeof prisma.libraryFolder.findMany>>)
        : prisma.libraryFolder.findMany({
            where: {
              ...(searching ? { name: nameContains } : { parentId: folderId }),
              ownerBridgeId: activeBridgeId,
              ...(workspaceId ? { workspaceId } : {})
            },
            orderBy: { name: 'asc' }
          })
    ])

    const capped = capLibraryFileRows(fileRows, LIBRARY_BROWSE_FILE_LIMIT)

    response.json(libraryBrowseResponseSchema.parse({
      mode: 'bridge-subtree',
      readOnly: false,
      activeBridgeId,
      bridgeEntries: bridges,
      folders: folderRows.map(toFolderDto),
      files: await toLibraryFileDtos(capped.rows, ownerKey, toDto),
      truncated: capped.truncated,
      fileLimit: capped.fileLimit
    }))
  })
}

/**
 * Map a listing's rows to DTOs, marking which the given user has favorited. Resolves
 * the user's favorite set in a single query (rather than per-row) to avoid N+1.
 */
async function toLibraryFileDtos(
  rows: LibraryFileModel[],
  ownerKey: string,
  toDto: (row: LibraryFileModel, options: { cacheOnly: boolean; favorite: boolean }) => Promise<LibraryFileDto>
): Promise<LibraryFileDto[]> {
  const favorites = await getFavoritedFileIds(ownerKey, rows.map((row) => row.id))
  return Promise.all(rows.map((row) => toDto(row, { cacheOnly: true, favorite: favorites.has(row.id) })))
}

/**
 * Translate a library sort key/direction into a Prisma `orderBy`. `mostPrinted` /
 * `lastPrinted` sort on the denormalized rollup columns so the order is applied
 * server-side before the recency cap. Nulls (never-printed files) sort last.
 */
export function buildLibraryFileOrderBy(
  sortKey: LibrarySortKey,
  sortDir: LibrarySortDirection
): Prisma.LibraryFileOrderByWithRelationInput {
  switch (sortKey) {
    case 'name':
      return { name: sortDir }
    case 'size':
      return { sizeBytes: sortDir }
    case 'mostPrinted':
      return { printCount: sortDir }
    case 'lastPrinted':
      return { lastPrintedAt: { sort: sortDir, nulls: 'last' } }
    case 'date':
    default:
      return { uploadedAt: sortDir }
  }
}

function parseFolderQuery(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return undefined
  if (value === '' || value === 'null' || value === 'root') return null
  return value
}
