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
import path from 'node:path'
import { readdir, rm, stat } from 'node:fs/promises'
import { env } from './env.js'
import { PUBLIC_DEMO_TENANT_SLUG } from '@printstream/shared'
import { deleteLibraryFileBytes, pruneBridgeLibraryDerivedCache } from './bridge-library-files.js'
import { pruneMeshThumbnailCache } from './mesh-thumbnail-cache.js'
import { bridgeSessionManager } from './bridge-session-manager.js'
import { libraryDir } from './library-paths.js'
import { pruneCoverCache } from './cover-cache.js'
import { pruneAuditLogs } from './audit-logs.js'
import { deletePrintJobThumbnail } from './print-job-thumbnails.js'
import { deletePrintJobSnapshot } from './print-job-snapshots.js'
import { rootPrisma } from './prisma.js'

const RETENTION_DAYS = env.LIBRARY_TRANSIENT_RETENTION_DAYS
const PRINT_JOB_THUMBNAIL_RETENTION_DAYS = env.PRINT_JOB_THUMBNAIL_RETENTION_DAYS

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const ONE_HOUR_MS = 60 * 60 * 1000
const DEMO_TRANSIENT_RETENTION_MS = 12 * ONE_HOUR_MS
/** Reap anonymous bridge registrations that never connected after this long. */
const DORMANT_BRIDGE_RETENTION_MS = 7 * ONE_DAY_MS
// An upload session untouched for this long is treated as abandoned. Keyed off
// the session file's mtime (rewritten on every chunk), so this is inactivity,
// not wall-clock age — a multi-hour large upload over a slow link is safe.
const UPLOAD_SESSION_RETENTION_MS = 24 * ONE_HOUR_MS

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
  deps: {
    deleteLibraryFileBytes: typeof deleteLibraryFileBytes
    isBridgeConnected?: (bridgeId: string) => boolean
  } = { deleteLibraryFileBytes }
): Promise<{ removed: number }> {
  const isBridgeConnected = deps.isBridgeConnected ?? ((bridgeId: string) => bridgeSessionManager.isConnected(bridgeId))
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
  let deferredOffline = 0
  for (const row of stale) {
    // Delete the bytes BEFORE the DB row (matching the other prune passes), and
    // skip the entry entirely when its owning bridge is offline: bridge-owned
    // bytes can only be removed while that bridge is connected, and deleting the
    // row first (the old order) would orphan the bytes permanently with no row
    // left to retry. Leaving the row lets a later run delete it once the bridge
    // is back. Local files (no ownerBridgeId) are always eligible.
    const bridgeIds = [row.ownerBridgeId, ...row.versions.map((version) => version.ownerBridgeId)]
      .filter((id): id is string => id != null)
    if (bridgeIds.some((id) => !isBridgeConnected(id))) {
      deferredOffline += 1
      continue
    }
    await deps.deleteLibraryFileBytes(row).catch((err) => {
      console.warn(`[library-cleanup] failed to delete bytes for ${row.id}`, (err as Error).message)
    })
    for (const version of row.versions) {
      await deps.deleteLibraryFileBytes(version).catch((err) => {
        console.warn(`[library-cleanup] failed to delete bytes for ${row.id} (version)`, (err as Error).message)
      })
    }
    await rootPrisma.libraryFile.delete({ where: { id: row.id } })
    removed += 1
  }
  if (removed > 0) {
    console.log(`[library-cleanup] emptied ${removed} expired recycle bin file${removed === 1 ? '' : 's'}`)
  }
  if (deferredOffline > 0) {
    console.log(`[library-cleanup] deferred ${deferredOffline} expired recycle bin file${deferredOffline === 1 ? '' : 's'} (owning bridge offline)`)
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
    // Belt-and-suspenders: never prune a slice output a print-queue item still points at. The add-to-queue
    // path un-hides the output (so `hidden: true` shouldn't match a queued one), but this guards against
    // any path that leaves a queue-referenced output hidden — losing it would break dispatch.
    where: { hidden: true, snapshotKey: null, origin: 'slice', uploadedAt: { lt: cutoff }, queueItems: { none: {} } },
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

/**
 * Reap abandoned chunked-upload sessions. The chunked-upload flow
 * (`POST /api/library/uploads` + `/chunks`) stages bytes into
 * `<libraryDir>/.uploads/<id>.part` alongside a `<id>.json` session file, and
 * only deletes them when the client calls `/complete` or `DELETE /uploads/:id`.
 * A closed tab or dropped connection between chunks leaves both files behind,
 * each up to LIBRARY_MAX_UPLOAD_BYTES — unbounded disk growth on a busy install
 * (the same volume the embedded Postgres and bridge use). Expiry is keyed off
 * the session file's mtime, which the route rewrites on every received chunk, so
 * a slow-but-still-active upload is never reaped mid-flight.
 */
export async function pruneAbandonedUploadSessions(): Promise<{ removed: number }> {
  const uploadDir = path.join(libraryDir, '.uploads')
  const cutoff = Date.now() - UPLOAD_SESSION_RETENTION_MS
  let entries: string[]
  try {
    entries = await readdir(uploadDir)
  } catch {
    return { removed: 0 } // .uploads not created yet (no chunked upload has run).
  }
  let removed = 0
  for (const entry of entries) {
    if (!entry.endsWith('.part') && !entry.endsWith('.json')) continue
    const fullPath = path.join(uploadDir, entry)
    let mtimeMs: number
    try {
      mtimeMs = (await stat(fullPath)).mtimeMs
    } catch {
      continue // raced with a concurrent delete; skip.
    }
    if (mtimeMs > cutoff) continue
    await rm(fullPath, { force: true }).catch(() => undefined)
    if (entry.endsWith('.part')) removed += 1
  }
  if (removed > 0) {
    console.log(`[library-cleanup] reaped ${removed} abandoned upload session${removed === 1 ? '' : 's'}`)
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

/**
 * Hard-delete dormant bridge registrations that were created but never connected.
 * POST /api/bridge-runtime/register is unauthenticated (it backs the connect-code
 * pairing flow), so an anonymous/empty call persists a Bridge row with
 * tenantId=null and a fresh unique connect code; without a reaper these
 * accumulate (table + connectCode-uniqueness bloat). A bridge that actually
 * connects sets lastSeenAt on its first heartbeat, so this only reaps rows that
 * registered and went nowhere past the retention window. A legitimate-but-
 * unpaired bridge re-registers automatically on its next reconnect if reaped.
 */
export async function pruneDormantBridges(): Promise<{ removed: number }> {
  const cutoff = new Date(Date.now() - DORMANT_BRIDGE_RETENTION_MS)
  const result = await rootPrisma.bridge.deleteMany({
    where: { tenantId: null, lastSeenAt: null, createdAt: { lt: cutoff } }
  })
  if (result.count > 0) {
    console.log(`[library-cleanup] pruned ${result.count} dormant bridge registration${result.count === 1 ? '' : 's'}`)
  }
  return { removed: result.count }
}

export async function runArtifactMaintenance(): Promise<void> {
  // Several prunes run purely for their side effects; we only bind the few whose
  // counts we log below (positional holes skip the rest).
  const [, , , , , , coverCache, bridgeDerivedCache, meshThumbnails, auditLogs] = await Promise.all([
    pruneHiddenLibraryFiles(),
    pruneUnreferencedSlicedOutputs(),
    pruneRecycledLibraryFiles(),
    pruneAbandonedUploadSessions(),
    prunePrintJobThumbnails(),
    prunePrintJobSnapshots(),
    pruneCoverCache(),
    pruneBridgeLibraryDerivedCache(),
    pruneMeshThumbnailCache(),
    pruneAuditLogs(),
    pruneDormantBridges()
  ])

  if (meshThumbnails.removedFiles > 0) {
    console.log(`[library-cleanup] pruned ${meshThumbnails.removedFiles} mesh thumbnail${meshThumbnails.removedFiles === 1 ? '' : 's'}`)
  }

  if (auditLogs.removed > 0) {
    console.log(`[library-cleanup] pruned ${auditLogs.removed} expired audit-log row${auditLogs.removed === 1 ? '' : 's'}`)
  }

  const removedCoverArtifacts = coverCache.removedCoverFiles
  if (removedCoverArtifacts > 0) {
    console.log(`[library-cleanup] pruned ${removedCoverArtifacts} cover cache artifact${removedCoverArtifacts === 1 ? '' : 's'}`)
  }
  const removedBridgeDerivedArtifacts = bridgeDerivedCache.removedFiles + bridgeDerivedCache.removedDirs
  if (removedBridgeDerivedArtifacts > 0) {
    console.log(`[library-cleanup] pruned ${removedBridgeDerivedArtifacts} bridge derived cache artifact${removedBridgeDerivedArtifacts === 1 ? '' : 's'}`)
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
