/** Optional live lineage must never prevent dispatching an already preserved print snapshot. */
import { rootPrisma } from './prisma.js'

/**
 * Retry only when a source was permanently deleted before the history write. The FK arbitrates
 * the deletion race; checking existence before writing alone would leave a check/write window.
 * Other foreign-key errors still fail normally, including a missing printable snapshot.
 */
export async function withOptionalPrintSource<T>(sourceId: string | null, write: (sourceId: string | null) => Promise<T>): Promise<T> {
  try {
    return await write(sourceId)
  } catch (error) {
    if (!sourceId || typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'P2003') throw error
    const source = await rootPrisma.libraryFile.findUnique({ where: { id: sourceId }, select: { id: true } })
    if (source) throw error
    return await write(null)
  }
}
