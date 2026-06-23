/**
 * Per-user library "favorites" (stars).
 *
 * Favorites are personal — each user stars their own files; they are not shared
 * across the workspace. A favorite is a `LibraryFileFavorite` row keyed by
 * `(userId, libraryFileId)`. The "user key" is the authenticated user id, or a
 * fixed sentinel for no-auth/self-host installs where the actor is anonymous, so
 * that single local user gets a stable favorites set (and the unique constraint
 * stays sound — Postgres would otherwise allow duplicate NULL-user rows).
 */
import type { Request } from 'express'
import { prisma } from './prisma.js'

/** Owner key used for requests without an authenticated user (single local user). */
export const ANONYMOUS_FAVORITE_OWNER_KEY = '@local'

/** Resolve the favorites owner key for the current request's actor. */
export function resolveFavoriteOwnerKey(request: Request): string {
  const actor = request.auth?.actor
  if (actor?.type === 'user') return actor.userId
  if (actor?.type === 'service-account') return `svc:${actor.serviceAccountId}`
  return ANONYMOUS_FAVORITE_OWNER_KEY
}

/**
 * Which of `fileIds` the given owner has favorited. One query; returns a Set for
 * O(1) lookup while mapping a listing's rows to DTOs.
 */
export async function getFavoritedFileIds(ownerKey: string, fileIds: string[]): Promise<Set<string>> {
  if (fileIds.length === 0) return new Set<string>()
  const rows = await prisma.libraryFileFavorite.findMany({
    where: { userId: ownerKey, libraryFileId: { in: fileIds } },
    select: { libraryFileId: true }
  })
  return new Set(rows.map((row) => row.libraryFileId))
}
