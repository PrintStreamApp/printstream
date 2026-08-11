/**
 * On-disk backup snapshots of the bridge's user data (issue #61).
 *
 * Owns the snapshot FORMAT and the write/list/prune mechanics for
 * `BRIDGE_BACKUP_DIR` — a directory deliberately outside the bridge's own data
 * dir (its own bind mount in Docker), so wiping or recreating the app can never
 * take the only copy of the user's files with it. Scheduling, status, and RPC
 * wiring live in the counterpart `backup-manager.ts`.
 *
 * What a snapshot contains — exactly the set that makes a restored bridge whole
 * (the same two-item list the Docker→standalone migration copies):
 *   - `bridge-state.json`: the durable install identity. Restoring it is what
 *     re-binds a rebuilt bridge to its server record, printers, and library.
 *     It carries the runtime token, so the copy is written 0600 and the backup
 *     dir is created 0700.
 *   - every library file, EXCEPT `replica-*` (regenerable cross-bridge dispatch
 *     replicas — cache, re-fetched from the owning bridge on demand).
 *
 * Format: one directory per snapshot (`backup-<timestamp>/{manifest.json,
 * bridge-state.json, library/...}`), each independently complete and restorable
 * with plain `cp`. Library files are content-stable once fully written (stored
 * paths are minted per version and never rewritten), so unchanged files are
 * HARDLINKED to the previous snapshot's copy — a daily snapshot costs only the
 * delta, and pruning any snapshot never breaks another (link counts). Where
 * hardlinks are unavailable (exFAT USB drive, network share) every file is
 * copied instead.
 *
 * Invariants, following `apps/server/src/pre-update-backup.ts`:
 *   - Stage-then-rename: a snapshot is written as `<dir>.partial` and renamed
 *     into place, so a crash mid-copy can never leave a directory that LOOKS
 *     like a complete backup. `.partial` leftovers are swept by every prune.
 *   - A file modified within the quiesce window is skipped (not half-copied):
 *     chunked library uploads append in place at their final path, so a fresh
 *     mtime means "possibly still being written". It is picked up next run.
 *   - Retention is the shared smart ladder (`selectBackupsToPrune`), applied
 *     only after a successful snapshot — a failing backup must never eat the
 *     history it exists to provide.
 */
import path from 'node:path'
import {
  chmod,
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile
} from 'node:fs/promises'
import { selectBackupsToPrune, type BridgeBackupSnapshot } from '@printstream/shared'

/** Library files with an mtime newer than this are treated as still-in-flight. */
const DEFAULT_QUIESCE_MS = 60_000
/** Free space demanded beyond the planned copy bytes, so a backup cannot be what fills the disk. */
const FREE_SPACE_MARGIN_BYTES = 256 * 1024 * 1024
const SNAPSHOT_DIR_PREFIX = 'backup-'
const MANIFEST_VERSION = 1

interface ManifestFileEntry {
  sizeBytes: number
  mtimeMs: number
}

/** `manifest.json` inside a snapshot dir. `files` drives next run's hardlink reuse. */
interface BackupManifest {
  version: number
  createdAt: string
  trigger: 'scheduled' | 'manual'
  fileCount: number
  totalBytes: number
  copiedBytes: number
  linkedCount: number
  skippedInFlightCount: number
  stateFileIncluded: boolean
  durationMs: number
  files: Record<string, ManifestFileEntry>
}

export interface CreateBackupSnapshotOptions {
  backupDir: string
  libraryDir: string
  stateFilePath: string
  trigger: 'scheduled' | 'manual'
  now?: () => number
  quiesceMs?: number
}

export interface CreateBackupSnapshotResult {
  snapshot: BridgeBackupSnapshot
  prunedCount: number
}

/**
 * Refuses a backup dir that overlaps the library it protects: a backup inside
 * the data being backed up grows without bound and dies with the same disk.
 */
export function validateBackupDirectory(backupDir: string, libraryDir: string): string | null {
  const backup = path.resolve(backupDir)
  const library = path.resolve(libraryDir)
  if (backup === library || isInside(backup, library) || isInside(library, backup)) {
    return `Backup directory ${backup} overlaps the library directory ${library}; choose a directory outside the bridge's data.`
  }
  return null
}

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Takes one snapshot, then applies retention. Throws on any failure that left
 * no completed snapshot (the staging dir is cleaned up); a failure during the
 * post-snapshot prune is logged by the caller but the snapshot stands.
 */
export async function createBackupSnapshot(options: CreateBackupSnapshotOptions): Promise<CreateBackupSnapshotResult> {
  const now = options.now ?? Date.now
  const quiesceMs = options.quiesceMs ?? DEFAULT_QUIESCE_MS
  const startedAtMs = now()
  const invalid = validateBackupDirectory(options.backupDir, options.libraryDir)
  if (invalid) throw new Error(invalid)

  await mkdir(options.backupDir, { recursive: true, mode: 0o700 })

  const createdAt = new Date(startedAtMs).toISOString()
  const targetDir = path.join(options.backupDir, snapshotDirName(createdAt))
  const stagingDir = `${targetDir}.partial`

  const candidates = await scanLibraryFiles(options.libraryDir)
  const previous = await newestSnapshotManifest(options.backupDir)

  // Plan link-vs-copy up front so the free-space check reflects real cost.
  let plannedCopyBytes = 0
  const plan = candidates.map((candidate) => {
    const previousEntry = previous?.manifest.files[candidate.name]
    const linkable = previousEntry !== undefined
      && previousEntry.sizeBytes === candidate.sizeBytes
      && previousEntry.mtimeMs === candidate.mtimeMs
    if (!linkable) plannedCopyBytes += candidate.sizeBytes
    return { ...candidate, linkable }
  })
  await assertFreeSpace(options.backupDir, plannedCopyBytes + FREE_SPACE_MARGIN_BYTES)

  await rm(stagingDir, { recursive: true, force: true })
  const summaryCounters = { copiedBytes: 0, linkedCount: 0, skippedInFlightCount: 0 }
  try {
    await mkdir(path.join(stagingDir, 'library'), { recursive: true, mode: 0o700 })

    // The identity file is the highest-value ~200 bytes in the product; its
    // copy carries the runtime token, so it keeps credential-grade permissions.
    let stateFileIncluded = false
    try {
      const stagedStateFile = path.join(stagingDir, 'bridge-state.json')
      await copyFile(options.stateFilePath, stagedStateFile)
      await chmod(stagedStateFile, 0o600)
      summaryCounters.copiedBytes += (await stat(stagedStateFile)).size
      stateFileIncluded = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // First run before registration: no identity yet, nothing to protect.
    }

    const files: Record<string, ManifestFileEntry> = {}
    let totalBytes = 0
    for (const entry of plan) {
      if (now() - entry.mtimeMs < quiesceMs) {
        summaryCounters.skippedInFlightCount += 1
        continue
      }
      const destination = path.join(stagingDir, 'library', entry.name)
      const copied = await placeLibraryFile({
        source: path.join(options.libraryDir, entry.name),
        previousCopy: entry.linkable && previous ? path.join(previous.dir, 'library', entry.name) : null,
        destination
      })
      if (copied === 'missing') {
        // Deleted between scan and copy: the server no longer references it.
        summaryCounters.skippedInFlightCount += 1
        continue
      }
      if (copied === 'linked') summaryCounters.linkedCount += 1
      else summaryCounters.copiedBytes += entry.sizeBytes
      files[entry.name] = { sizeBytes: entry.sizeBytes, mtimeMs: entry.mtimeMs }
      totalBytes += entry.sizeBytes
    }

    const manifest: BackupManifest = {
      version: MANIFEST_VERSION,
      createdAt,
      trigger: options.trigger,
      fileCount: Object.keys(files).length,
      totalBytes,
      copiedBytes: summaryCounters.copiedBytes,
      linkedCount: summaryCounters.linkedCount,
      skippedInFlightCount: summaryCounters.skippedInFlightCount,
      stateFileIncluded,
      durationMs: Math.max(0, now() - startedAtMs),
      files
    }
    await writeFile(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    await rename(stagingDir, targetDir)

    const prunedCount = await pruneBackupSnapshots(options.backupDir, now())
    return { snapshot: toSnapshotSummary(path.basename(targetDir), manifest), prunedCount }
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/** Completed snapshots in the backup dir, newest first. Unreadable ones are skipped. */
export async function listBackupSnapshots(backupDir: string): Promise<BridgeBackupSnapshot[]> {
  const manifests = await readSnapshotManifests(backupDir)
  return manifests.map(({ name, manifest }) => toSnapshotSummary(name, manifest))
}

/**
 * Applies the shared retention ladder and sweeps `.partial` leftovers. Returns
 * how many snapshots were removed. Prune failures cost only disk, so each
 * removal is independent and best-effort.
 */
export async function pruneBackupSnapshots(backupDir: string, nowMs: number): Promise<number> {
  const manifests = await readSnapshotManifests(backupDir)
  const byTime = new Map(manifests.map((entry) => [Date.parse(entry.manifest.createdAt), entry.name]))
  const pruneTimes = selectBackupsToPrune([...byTime.keys()], nowMs)
  let pruned = 0
  for (const timeMs of pruneTimes) {
    const name = byTime.get(timeMs)
    if (!name) continue
    try {
      await rm(path.join(backupDir, name), { recursive: true, force: true })
      pruned += 1
    } catch (error) {
      console.warn(`[bridge:backup] failed to prune snapshot ${name}: ${(error as Error).message}`)
    }
  }
  let entries: string[] = []
  try {
    entries = await readdir(backupDir)
  } catch {
    return pruned
  }
  // Half-finished staging dirs from a crashed run are never valid backups.
  for (const name of entries.filter((entry) => entry.endsWith('.partial'))) {
    await rm(path.join(backupDir, name), { recursive: true, force: true }).catch(() => undefined)
  }
  return pruned
}

function snapshotDirName(createdAt: string): string {
  return `${SNAPSHOT_DIR_PREFIX}${createdAt.replace(/[:.]/g, '-')}`
}

function toSnapshotSummary(name: string, manifest: BackupManifest): BridgeBackupSnapshot {
  return {
    name,
    createdAt: manifest.createdAt,
    trigger: manifest.trigger,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    copiedBytes: manifest.copiedBytes,
    skippedInFlightCount: manifest.skippedInFlightCount,
    durationMs: manifest.durationMs
  }
}

async function scanLibraryFiles(libraryDir: string): Promise<Array<{ name: string; sizeBytes: number; mtimeMs: number }>> {
  let names: Array<{ name: string; isFile: () => boolean }>
  try {
    names = await readdir(libraryDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files: Array<{ name: string; sizeBytes: number; mtimeMs: number }> = []
  for (const entry of names) {
    if (!entry.isFile()) continue
    // `replica-*` files are cross-bridge dispatch replicas: cache, re-fetched
    // from the file's owning bridge — see the API's bridge-library-files.ts.
    if (entry.name.startsWith('replica-')) continue
    try {
      const info = await stat(path.join(libraryDir, entry.name))
      files.push({ name: entry.name, sizeBytes: info.size, mtimeMs: info.mtimeMs })
    } catch {
      // Deleted mid-scan; it no longer needs backing up.
    }
  }
  return files
}

async function readSnapshotManifests(backupDir: string): Promise<Array<{ name: string; dir: string; manifest: BackupManifest }>> {
  let entries: string[]
  try {
    entries = await readdir(backupDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const manifests: Array<{ name: string; dir: string; manifest: BackupManifest }> = []
  for (const name of entries) {
    if (!name.startsWith(SNAPSHOT_DIR_PREFIX) || name.endsWith('.partial')) continue
    const dir = path.join(backupDir, name)
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as BackupManifest
      if (parsed.version !== MANIFEST_VERSION || typeof parsed.createdAt !== 'string') continue
      manifests.push({ name, dir, manifest: parsed })
    } catch {
      // No readable manifest: not a completed snapshot (or foreign junk); leave it alone.
    }
  }
  manifests.sort((a, b) => Date.parse(b.manifest.createdAt) - Date.parse(a.manifest.createdAt))
  return manifests
}

async function newestSnapshotManifest(backupDir: string): Promise<{ dir: string; manifest: BackupManifest } | null> {
  const manifests = await readSnapshotManifests(backupDir)
  return manifests[0] ?? null
}

type PlaceOutcome = 'linked' | 'copied' | 'missing'

/**
 * Hardlink from the previous snapshot when the file is provably unchanged,
 * otherwise copy from the library. Falls back to copying when the filesystem
 * refuses links; reports `missing` when the source vanished mid-backup.
 */
async function placeLibraryFile(input: { source: string; previousCopy: string | null; destination: string }): Promise<PlaceOutcome> {
  if (input.previousCopy) {
    try {
      await link(input.previousCopy, input.destination)
      return 'linked'
    } catch {
      // Previous copy gone or links unsupported here — fall through to a copy.
    }
  }
  try {
    await copyFile(input.source, input.destination)
    return 'copied'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

/** Best-effort: platforms without statfs simply skip the check. */
async function assertFreeSpace(directory: string, requiredBytes: number): Promise<void> {
  let freeBytes: number
  try {
    const stats = await statfs(directory)
    freeBytes = stats.bavail * stats.bsize
  } catch {
    return
  }
  if (freeBytes < requiredBytes) {
    throw new Error(
      `Not enough free space in the backup directory: ${formatGiB(freeBytes)} free, ` +
      `about ${formatGiB(requiredBytes)} needed. Free up space or point BRIDGE_BACKUP_DIR at a larger disk.`
    )
  }
}

function formatGiB(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`
}
