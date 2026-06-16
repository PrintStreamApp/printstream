/**
 * Periodic prune of transient and recycled library files.
 *
 * Files uploaded by the "Print from local file" flow on the Printers
 * page are persisted to disk so the user can re-dispatch them, but
 * they're flagged `hidden=true` and don't show up in the library UI.
 * Hidden snapshot files retained for print history reprints set a
 * `snapshotKey` and are excluded from this cleanup path.
 * Without cleanup these would accumulate forever, so we age them out
 * after `LIBRARY_TRANSIENT_RETENTION_DAYS` (default 7) of not being
 * touched. Two further passes handle: unreferenced sliced outputs
 * (origin='slice', never kept or snapshotted — swept after
 * `LIBRARY_UNREFERENCED_SLICE_RETENTION_HOURS`) and expired recycle-bin
 * entries (`LIBRARY_RECYCLE_RETENTION_DAYS`).
 *
 * Eligibility is based on `uploadedAt` rather than "last printed" — we
 * don't track print recency on the row, and the Bambu firmware keeps
 * its own copy on the SD card anyway, so the on-disk copy here is just
 * a convenience for re-issuing `project_file` from PrintStream.
 *
 * Cleanup runs once at startup (after a short delay so it doesn't
 * fight the boot sequence) and then on a fixed 24h interval.
 */
import { env } from './env.js'
import { PUBLIC_DEMO_TENANT_SLUG } from '@printstream/shared'
import { deleteLibraryFileBytes, pruneBridgeLibraryDerivedCache } from './bridge-library-files.js'
import { pruneCoverCache } from './cover-cache.js'
import { deletePrintJobThumbnail } from './print-job-thumbnails.js'
import { deletePrintJobSnapshot } from './print-job-snapshots.js'
import { rootPrisma } from './prisma.js'

const RETENTION_DAYS = env.LIBRARY_TRANSIENT_RETENTION_DAYS
const PRINT_JOB_THUMBNAIL_RETENTION_DAYS = env.PRINT_JOB_THUMBNAIL_RETENTION_DAYS

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const ONE_HOUR_MS = 60 * 60 * 1000
const DEMO_TRANSIENT_RETENTION_MS = 12 * ONE_HOUR_MS

let timer: NodeJS.Timeout | null = null
let startupTimer: NodeJS.Timeout | null = null

export async function pruneHiddenLibraryFiles(
  deps: { deleteLibraryFileBytes: typeof deleteLibraryFileBytes } = { deleteLibraryFileBytes }
): Promise<{ removed: number }> {
  const defaultRetentionMs = RETENTION_DAYS * ONE_DAY_MS
  const candidateCutoff = new Date(Date.now() - Math.min(defaultRetentionMs, DEMO_TRANSIENT_RETENTION_MS))
  const stale = await rootPrisma.libraryFile.findMany({
    where: { hidden: true, snapshotKey: null, uploadedAt: { lt: candidateCutoff } },
    select: {
      id: true,
      ownerBridgeId: true,
      storedPath: true,
      uploadedAt: true,
      tenant: {
        select: {
          slug: true
        }
      }
    }
  })
  let removed = 0
  for (const row of stale) {
    if (!isHiddenLibraryFileExpired(row, defaultRetentionMs)) continue
    await deps.deleteLibraryFileBytes(row).catch((err) => {
      console.warn(`[library-cleanup] failed to delete bytes for ${row.id}`, (err as Error).message)
    })
    await rootPrisma.libraryFile.delete({ where: { id: row.id } })
    removed += 1
  }
  if (removed > 0) {
    console.log(`[library-cleanup] pruned ${removed} hidden file${removed === 1 ? '' : 's'}`)
  }
  return { removed }
}

function isHiddenLibraryFileExpired(
  row: { uploadedAt: Date; tenant: { slug: string } | null },
  defaultRetentionMs: number
): boolean {
  const retentionMs = row.tenant?.slug === PUBLIC_DEMO_TENANT_SLUG
    ? DEMO_TRANSIENT_RETENTION_MS
    : defaultRetentionMs
  return row.uploadedAt.getTime() <= Date.now() - retentionMs
}

/**
 * Hard-delete recycle-bin entries whose retention window has expired
 * (LIBRARY_RECYCLE_RETENTION_DAYS, default 30). Removes the row, its version
 * history (cascade), and the bytes for the current content and every version.
 */
export async function pruneRecycledLibraryFiles(
  deps: { deleteLibraryFileBytes: typeof deleteLibraryFileBytes } = { deleteLibraryFileBytes }
): Promise<{ removed: number }> {
  const cutoff = new Date(Date.now() - env.LIBRARY_RECYCLE_RETENTION_DAYS * ONE_DAY_MS)
  const stale = await rootPrisma.libraryFile.findMany({
    where: { deletedAt: { lt: cutoff } },
    select: {
      id: true,
      ownerBridgeId: true,
      storedPath: true,
      versions: { select: { ownerBridgeId: true, storedPath: true } }
    }
  })
  let removed = 0
  for (const row of stale) {
    await rootPrisma.libraryFile.delete({ where: { id: row.id } })
    await deps.deleteLibraryFileBytes(row).catch((err) => {
      console.warn(`[library-cleanup] failed to delete bytes for ${row.id}`, (err as Error).message)
    })
    for (const version of row.versions) {
      await deps.deleteLibraryFileBytes(version).catch((err) => {
        console.warn(`[library-cleanup] failed to delete bytes for ${row.id} (version)`, (err as Error).message)
      })
    }
    removed += 1
  }
  if (removed > 0) {
    console.log(`[library-cleanup] emptied ${removed} expired recycle bin file${removed === 1 ? '' : 's'}`)
  }
  return { removed }
}

/**
 * Delete unreferenced sliced outputs — hidden gcode artifacts produced by
 * "slice without saving" / slice-then-print runs that were never kept
 * (un-hidden) and never snapshotted for print history. The dialogs discard
 * these on close, but a closed browser or crashed tab leaks them; this pass
 * sweeps the leak after LIBRARY_UNREFERENCED_SLICE_RETENTION_HOURS (default
 * 24) — much sooner than the general transient retention. Only rows tagged
 * origin='slice' qualify, so transient uploads and editor scaffolds keep
 * their longer window.
 */
export async function pruneUnreferencedSlicedOutputs(
  deps: { deleteLibraryFileBytes: typeof deleteLibraryFileBytes } = { deleteLibraryFileBytes }
): Promise<{ removed: number }> {
  const cutoff = new Date(Date.now() - env.LIBRARY_UNREFERENCED_SLICE_RETENTION_HOURS * ONE_HOUR_MS)
  const stale = await rootPrisma.libraryFile.findMany({
    where: { hidden: true, snapshotKey: null, origin: 'slice', uploadedAt: { lt: cutoff } },
    select: { id: true, ownerBridgeId: true, storedPath: true }
  })
  let removed = 0
  for (const row of stale) {
    await deps.deleteLibraryFileBytes(row).catch((err) => {
      console.warn(`[library-cleanup] failed to delete bytes for ${row.id}`, (err as Error).message)
    })
    await rootPrisma.libraryFile.delete({ where: { id: row.id } })
    removed += 1
  }
  if (removed > 0) {
    console.log(`[library-cleanup] pruned ${removed} unreferenced sliced output${removed === 1 ? '' : 's'}`)
  }
  return { removed }
}

export async function prunePrintJobThumbnails(): Promise<{ removed: number }> {
  const cutoff = new Date(Date.now() - PRINT_JOB_THUMBNAIL_RETENTION_DAYS * ONE_DAY_MS)
  const stale = await rootPrisma.printJob.findMany({
    where: {
      thumbnailPath: { not: null },
      finishedAt: { lt: cutoff }
    },
    select: { id: true, thumbnailPath: true }
  })

  let removed = 0
  for (const row of stale) {
    if (!row.thumbnailPath) continue
    await deletePrintJobThumbnail(row.thumbnailPath)
    await rootPrisma.printJob.update({
      where: { id: row.id },
      data: { thumbnailPath: null }
    })
    removed += 1
  }

  if (removed > 0) {
    console.log(`[library-cleanup] pruned ${removed} print job thumbnail${removed === 1 ? '' : 's'}`)
  }
  return { removed }
}

export async function prunePrintJobSnapshots(): Promise<{ removed: number }> {
  const cutoff = new Date(Date.now() - PRINT_JOB_THUMBNAIL_RETENTION_DAYS * ONE_DAY_MS)
  const stale = await rootPrisma.printJob.findMany({
    where: {
      snapshotPath: { not: null },
      finishedAt: { lt: cutoff }
    },
    select: { id: true, snapshotPath: true }
  })

  let removed = 0
  for (const row of stale) {
    if (!row.snapshotPath) continue
    await deletePrintJobSnapshot(row.snapshotPath)
    await rootPrisma.printJob.update({
      where: { id: row.id },
      data: { snapshotPath: null }
    })
    removed += 1
  }

  if (removed > 0) {
    console.log(`[library-cleanup] pruned ${removed} print job snapshot${removed === 1 ? '' : 's'}`)
  }
  return { removed }
}

export async function runArtifactMaintenance(): Promise<void> {
  const [hiddenFiles, slicedOutputs, recycledFiles, jobThumbnails, jobSnapshots, coverCache, bridgeDerivedCache] = await Promise.all([
    pruneHiddenLibraryFiles(),
    pruneUnreferencedSlicedOutputs(),
    pruneRecycledLibraryFiles(),
    prunePrintJobThumbnails(),
    prunePrintJobSnapshots(),
    pruneCoverCache(),
    pruneBridgeLibraryDerivedCache()
  ])

  const removedCoverArtifacts = coverCache.removedCoverFiles
  if (removedCoverArtifacts > 0) {
    console.log(`[library-cleanup] pruned ${removedCoverArtifacts} cover cache artifact${removedCoverArtifacts === 1 ? '' : 's'}`)
  }
  const removedBridgeDerivedArtifacts = bridgeDerivedCache.removedFiles + bridgeDerivedCache.removedDirs
  if (removedBridgeDerivedArtifacts > 0) {
    console.log(`[library-cleanup] pruned ${removedBridgeDerivedArtifacts} bridge derived cache artifact${removedBridgeDerivedArtifacts === 1 ? '' : 's'}`)
  }

  if (
    hiddenFiles.removed === 0
    && slicedOutputs.removed === 0
    && recycledFiles.removed === 0
    && jobThumbnails.removed === 0
    && jobSnapshots.removed === 0
    && coverCache.removedCoverFiles === 0
    && coverCache.removedMemoryEntries === 0
    && coverCache.removedNegativeEntries === 0
    && bridgeDerivedCache.removedFiles === 0
    && bridgeDerivedCache.removedDirs === 0
  ) {
    return
  }
}

export function startLibraryCleanup(): void {
  if (timer || startupTimer) return
  // Small delay so the first run doesn't pile on top of plugin startup.
  startupTimer = setTimeout(() => {
    startupTimer = null
    void runArtifactMaintenance().catch((error) => {
      console.error('[library-cleanup] initial prune failed', error)
    })
  }, 30_000)
  if (typeof startupTimer.unref === 'function') startupTimer.unref()
  timer = setInterval(() => {
    void runArtifactMaintenance().catch((error) => {
      console.error('[library-cleanup] scheduled prune failed', error)
    })
  }, ONE_DAY_MS)
  // Don't keep the process alive solely for this timer.
  if (typeof timer.unref === 'function') timer.unref()
}

export function stopLibraryCleanup(): void {
  if (startupTimer) {
    clearTimeout(startupTimer)
    startupTimer = null
  }
  if (!timer) return
  clearInterval(timer)
  timer = null
}
