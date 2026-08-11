/**
 * Server backup snapshots (issue #78): the on-disk format and the
 * write/list/prune/delete mechanics for the install's built-in backups.
 * Scheduling/status live in `server-backup-manager.ts`; the staged restore in
 * `server-backup-restore.ts`; the shared wire shapes in
 * `@printstream/shared` (`server-backups.ts`).
 *
 * One snapshot = one directory, independently complete and operator-copyable:
 *
 *   server-backup-<timestamp>/
 *     manifest.json   - versions, migration set, per-file index
 *     db.dump         - pg_dump -Fc of the whole database (all workspaces,
 *                       auth, settings, every plugin's tables — schema-proof)
 *     data/           - the persistent data tree (allowlist below)
 *
 * The data tree is an ALLOWLIST, not "everything under ./data": the data dir
 * also holds regenerable caches, CI-published release artifacts, the backups
 * dir itself, and (native) the live Postgres cluster — dragging any of those
 * in makes backups huge, recursive, or unrestorable. Cache subtrees inside
 * the library dir (`_bridge-cache` etc.) are excluded for the same reason.
 *
 * Unchanged files hardlink to the previous snapshot's copy (library bytes are
 * content-stable once written), so a daily backup costs only the delta and
 * pruning any snapshot never breaks another. Invariants shared with the
 * bridge's backup store and `pre-update-backup.ts`: stage-then-rename so a
 * crash can never leave a directory that LOOKS complete; a quiesce window so
 * an in-flight upload is skipped rather than half-copied; retention (the
 * shared smart ladder, scheduled snapshots only — manual and pre-restore
 * snapshots are keep-until-deleted) runs only after a successful backup; the
 * dump is verified with `pg_restore --list` before the snapshot is declared
 * complete ("verify, don't trust").
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
import { Client } from 'pg'
import { selectBackupsToPrune, type ServerBackupSnapshot, type ServerBackupTrigger } from '@printstream/shared'
import { env } from './env.js'
import { getAppBuildInfo } from './app-build-info.js'
import { listMigrationFiles } from './apply-migrations.js'
import { libpqCompatibleUrl, resolvePgTools, runPgTool } from './server-backup-tools.js'

const SNAPSHOT_DIR_PREFIX = 'server-backup-'
const MANIFEST_VERSION = 1
/** Data files with an mtime newer than this are treated as still-in-flight. */
const QUIESCE_MS = 60_000
/** Free space demanded beyond the planned bytes, so a backup cannot fill the disk. */
const FREE_SPACE_MARGIN_BYTES = 512 * 1024 * 1024

/**
 * The persistent data tree, relative to the data dir (the parent of
 * `LIBRARY_DIR`). Everything else under the data dir is a cache, a release
 * artifact, the embedded DB cluster, or the backups themselves — see the
 * module header. `bridge-state.json` covers the native build's in-box bridge
 * identity, which lives in the same tree.
 */
const DATA_TREE_DIRS = [
  'library',
  'plugins',
  'job-history-snapshots',
  'job-history-thumbnails',
  'support-attachments'
] as const
const DATA_TREE_FILES = [
  'printer-zip-transport-hints.json',
  'slicing-jobs-state.json',
  'dispatched-print-sources.json',
  'bridge-state.json'
] as const
/** Regenerable cache subtrees that live INSIDE allowlisted dirs. */
const DATA_TREE_EXCLUDED_SUBDIRS = new Set([
  'library/_bridge-cache',
  'library/_bridge-derived-cache',
  'library/_mesh-thumbnail-cache'
])

interface ManifestFileEntry {
  sizeBytes: number
  mtimeMs: number
}

/** `manifest.json` inside a snapshot dir. `files` drives next run's hardlink reuse. */
export interface ServerBackupManifest {
  version: number
  kind: 'server-backup'
  createdAt: string
  trigger: ServerBackupTrigger
  appRevision: string | null
  postgresVersion: string | null
  /**
   * Migration names applied when the backup was taken (lexically ordered, the
   * Prisma convention). The restore guard refuses a backup whose set contains
   * a migration this install does not ship — that is a backup from a NEWER
   * app, and migrating it "forward" would be a downgrade.
   */
  appliedMigrations: string[]
  dbDumpBytes: number
  dataFileCount: number
  dataTotalBytes: number
  copiedBytes: number
  skippedInFlightCount: number
  durationMs: number
  files: Record<string, ManifestFileEntry>
}

/**
 * Null when `BACKUPS_DIR` is unset: backups are off, and every caller treats
 * that as "unavailable, with a reason" rather than inventing a location — a
 * default inside the container filesystem would write backups that die with
 * the container.
 */
export function serverBackupsDir(): string | null {
  return env.BACKUPS_DIR ? path.resolve(env.BACKUPS_DIR) : null
}

export const BACKUPS_DIR_UNSET_REASON =
  'Backups are not configured: set BACKUPS_DIR to a directory outside the app\'s own storage (the compose example mounts ./backups) and restart.'

export function serverDataDir(): string {
  return path.dirname(path.resolve(env.LIBRARY_DIR))
}

export interface CreateServerBackupResult {
  snapshot: Omit<ServerBackupSnapshot, 'restoreBlockedReason'>
  prunedCount: number
}

/**
 * Takes one full backup, then applies retention. Throws on any failure that
 * left no completed snapshot (the staging dir is cleaned up).
 */
export async function createServerBackup(trigger: ServerBackupTrigger, now: () => number = Date.now): Promise<CreateServerBackupResult> {
  const tools = await resolvePgTools()
  if (!tools.available) throw new Error(tools.unavailableReason)

  const backupsDir = serverBackupsDir()
  if (!backupsDir) throw new Error(BACKUPS_DIR_UNSET_REASON)
  const dataDir = serverDataDir()
  const invalid = validateServerBackupsDir(backupsDir, dataDir)
  if (invalid) throw new Error(invalid)
  await mkdir(backupsDir, { recursive: true, mode: 0o700 })

  const startedAtMs = now()
  const createdAt = new Date(startedAtMs).toISOString()
  const targetDir = path.join(backupsDir, `${SNAPSHOT_DIR_PREFIX}${createdAt.replace(/[:.]/g, '-')}`)
  const stagingDir = `${targetDir}.partial`

  const database = await readDatabaseInfo()
  // The dump must be restorable into THIS server: a newer pg_dump writes
  // newer-version SET statements the server refuses on restore (seen live:
  // pg_dump 17's `SET transaction_timeout` failing into Postgres 16). Equal
  // majors is the one combination that round-trips, so refuse anything else
  // up front rather than minting backups that cannot restore.
  const toolMajor = postgresMajor(tools.version)
  const serverMajor = postgresMajor(database.serverVersion)
  if (toolMajor !== null && serverMajor !== null && toolMajor !== serverMajor) {
    throw new Error(
      `pg_dump is version ${toolMajor} but the database server is version ${serverMajor}; ` +
      `install matching client tools (postgresql-client-${serverMajor}) or point PG_DUMP_PATH/PG_RESTORE_PATH at them.`
    )
  }
  const candidates = await scanDataTree(dataDir)
  const previous = (await readSnapshotManifests(backupsDir))[0] ?? null

  let plannedCopyBytes = 0
  const plan = candidates.map((candidate) => {
    const previousEntry = previous?.manifest.files[candidate.relPath]
    const linkable = previousEntry !== undefined
      && previousEntry.sizeBytes === candidate.sizeBytes
      && previousEntry.mtimeMs === candidate.mtimeMs
    if (!linkable) plannedCopyBytes += candidate.sizeBytes
    return { ...candidate, linkable }
  })
  // The -Fc dump compresses, so the live database size is a safe upper bound.
  await assertFreeSpace(backupsDir, plannedCopyBytes + database.sizeBytes + FREE_SPACE_MARGIN_BYTES)

  await rm(stagingDir, { recursive: true, force: true })
  try {
    await mkdir(path.join(stagingDir, 'data'), { recursive: true, mode: 0o700 })

    const dumpPath = path.join(stagingDir, 'db.dump')
    await runPgTool(tools.pgDump, ['--format=custom', '--file', dumpPath, '--dbname', libpqCompatibleUrl(env.DATABASE_URL)])
    // Verify, don't trust: a dump that pg_restore cannot read is not a backup.
    await runPgTool(tools.pgRestore, ['--list', dumpPath])
    await chmod(dumpPath, 0o600)
    const dbDumpBytes = (await stat(dumpPath)).size

    const files: Record<string, ManifestFileEntry> = {}
    let dataTotalBytes = 0
    let copiedBytes = 0
    let skippedInFlightCount = 0
    for (const entry of plan) {
      if (now() - entry.mtimeMs < QUIESCE_MS) {
        skippedInFlightCount += 1
        continue
      }
      const destination = path.join(stagingDir, 'data', entry.relPath)
      await mkdir(path.dirname(destination), { recursive: true })
      const outcome = await placeFile({
        source: path.join(dataDir, entry.relPath),
        previousCopy: entry.linkable && previous ? path.join(previous.dir, 'data', entry.relPath) : null,
        destination
      })
      if (outcome === 'missing') {
        // Deleted between scan and copy: it no longer needs backing up.
        skippedInFlightCount += 1
        continue
      }
      if (outcome === 'copied') copiedBytes += entry.sizeBytes
      files[entry.relPath] = { sizeBytes: entry.sizeBytes, mtimeMs: entry.mtimeMs }
      dataTotalBytes += entry.sizeBytes
    }

    const manifest: ServerBackupManifest = {
      version: MANIFEST_VERSION,
      kind: 'server-backup',
      createdAt,
      trigger,
      appRevision: getAppBuildInfo().revision,
      postgresVersion: database.serverVersion,
      appliedMigrations: database.appliedMigrations,
      dbDumpBytes,
      dataFileCount: Object.keys(files).length,
      dataTotalBytes,
      copiedBytes: copiedBytes + dbDumpBytes,
      skippedInFlightCount,
      durationMs: Math.max(0, now() - startedAtMs),
      files
    }
    await writeFile(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    await rename(stagingDir, targetDir)

    const prunedCount = await pruneServerBackups(backupsDir, now())
    return { snapshot: toSnapshotSummary(path.basename(targetDir), manifest), prunedCount }
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Completed snapshots, newest first, each carrying this install's verdict on
 * restorability (see `restoreBlockedReason` in the shared contract).
 */
export async function listServerBackups(): Promise<ServerBackupSnapshot[]> {
  const backupsDir = serverBackupsDir()
  if (!backupsDir) return []
  const manifests = await readSnapshotManifests(backupsDir)
  const installedMigrations = new Set(listMigrationFiles().map((migration) => migration.name))
  const database = await readDatabaseInfo().catch(() => null)
  return manifests.map(({ name, manifest }) => ({
    ...toSnapshotSummary(name, manifest),
    restoreBlockedReason: restoreBlockedReason(manifest, installedMigrations, database?.serverVersion ?? null)
  }))
}

export async function deleteServerBackup(name: string): Promise<void> {
  const backupsDir = serverBackupsDir()
  if (!backupsDir) throw new Error(BACKUPS_DIR_UNSET_REASON)
  const manifests = await readSnapshotManifests(backupsDir)
  const found = manifests.find((entry) => entry.name === name)
  if (!found) throw new Error('Backup not found.')
  await rm(found.dir, { recursive: true, force: true })
}

export async function readServerBackupManifest(name: string): Promise<ServerBackupManifest | null> {
  const backupsDir = serverBackupsDir()
  if (!backupsDir) return null
  const manifests = await readSnapshotManifests(backupsDir)
  return manifests.find((entry) => entry.name === name)?.manifest ?? null
}

/**
 * Why THIS install must refuse to restore a snapshot, or null when it may.
 * Mirrors the boot-time apply's own checks so the UI and the marker validation
 * cannot disagree with what the boot would do.
 */
export function restoreBlockedReason(
  manifest: ServerBackupManifest,
  installedMigrationNames: ReadonlySet<string>,
  currentPostgresVersion: string | null
): string | null {
  const unknown = manifest.appliedMigrations.filter((migrationName) => !installedMigrationNames.has(migrationName))
  if (unknown.length > 0) {
    return 'This backup was taken by a newer version of the app; update the app before restoring it.'
  }
  const backupMajor = postgresMajor(manifest.postgresVersion)
  const currentMajor = postgresMajor(currentPostgresVersion)
  if (backupMajor !== null && currentMajor !== null && backupMajor > currentMajor) {
    return `This backup came from PostgreSQL ${backupMajor}, newer than this install's PostgreSQL ${currentMajor}.`
  }
  return null
}

/**
 * Applies the shared retention ladder to SCHEDULED snapshots (manual and
 * pre-restore ones are keep-until-deleted) and sweeps `.partial` leftovers.
 */
export async function pruneServerBackups(backupsDir: string, nowMs: number): Promise<number> {
  const manifests = await readSnapshotManifests(backupsDir)
  const scheduled = manifests.filter((entry) => entry.manifest.trigger === 'scheduled')
  const byTime = new Map(scheduled.map((entry) => [Date.parse(entry.manifest.createdAt), entry]))
  let pruned = 0
  for (const timeMs of selectBackupsToPrune([...byTime.keys()], nowMs)) {
    const entry = byTime.get(timeMs)
    if (!entry) continue
    try {
      await rm(entry.dir, { recursive: true, force: true })
      pruned += 1
    } catch (error) {
      console.warn(`[server-backup] failed to prune snapshot ${entry.name}: ${(error as Error).message}`)
    }
  }
  let entries: string[] = []
  try {
    entries = await readdir(backupsDir)
  } catch {
    return pruned
  }
  // Half-finished staging dirs from a crashed run are never valid backups.
  for (const name of entries.filter((entry) => entry.startsWith(SNAPSHOT_DIR_PREFIX) && entry.endsWith('.partial'))) {
    await rm(path.join(backupsDir, name), { recursive: true, force: true }).catch(() => undefined)
  }
  return pruned
}

/** Logical bytes across all snapshots plus free space on the backup disk. */
export async function serverBackupUsage(): Promise<{ snapshotCount: number; totalBytes: number; freeBytes: number | null }> {
  const backupsDir = serverBackupsDir()
  if (!backupsDir) return { snapshotCount: 0, totalBytes: 0, freeBytes: null }
  const manifests = await readSnapshotManifests(backupsDir)
  const totalBytes = manifests.reduce((sum, entry) => sum + entry.manifest.dataTotalBytes + entry.manifest.dbDumpBytes, 0)
  let freeBytes: number | null = null
  try {
    const stats = await statfs(backupsDir)
    freeBytes = stats.bavail * stats.bsize
  } catch {
    // Backups dir absent or platform without statfs: no free-space figure.
  }
  return { snapshotCount: manifests.length, totalBytes, freeBytes }
}

/** Refuses a backups dir nested inside a tree the backup itself copies. */
export function validateServerBackupsDir(backupsDir: string, dataDir: string): string | null {
  for (const root of DATA_TREE_DIRS) {
    const rootPath = path.join(dataDir, root)
    if (backupsDir === rootPath || isInside(backupsDir, rootPath)) {
      return `Backups directory ${backupsDir} is inside ${rootPath}, which backups snapshot; choose a directory outside the data tree.`
    }
  }
  return null
}

function postgresMajor(version: string | null): number | null {
  const major = Number.parseInt(version ?? '', 10)
  return Number.isFinite(major) && major > 0 ? major : null
}

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function toSnapshotSummary(name: string, manifest: ServerBackupManifest): Omit<ServerBackupSnapshot, 'restoreBlockedReason'> {
  return {
    name,
    createdAt: manifest.createdAt,
    trigger: manifest.trigger,
    appRevision: manifest.appRevision,
    postgresVersion: manifest.postgresVersion,
    dbDumpBytes: manifest.dbDumpBytes,
    dataFileCount: manifest.dataFileCount,
    dataTotalBytes: manifest.dataTotalBytes,
    copiedBytes: manifest.copiedBytes,
    durationMs: manifest.durationMs
  }
}

export async function readSnapshotManifests(backupsDir: string): Promise<Array<{ name: string; dir: string; manifest: ServerBackupManifest }>> {
  let entries: string[]
  try {
    entries = await readdir(backupsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const manifests: Array<{ name: string; dir: string; manifest: ServerBackupManifest }> = []
  for (const name of entries) {
    if (!name.startsWith(SNAPSHOT_DIR_PREFIX) || name.endsWith('.partial')) continue
    const dir = path.join(backupsDir, name)
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as ServerBackupManifest
      if (parsed.version !== MANIFEST_VERSION || parsed.kind !== 'server-backup') continue
      manifests.push({ name, dir, manifest: parsed })
    } catch {
      // No readable manifest: not a completed snapshot; leave it alone.
    }
  }
  manifests.sort((a, b) => Date.parse(b.manifest.createdAt) - Date.parse(a.manifest.createdAt))
  return manifests
}

/** Recursively lists the allowlisted persistent tree. RelPaths use `/` on every OS. */
async function scanDataTree(dataDir: string): Promise<Array<{ relPath: string; sizeBytes: number; mtimeMs: number }>> {
  const files: Array<{ relPath: string; sizeBytes: number; mtimeMs: number }> = []
  for (const file of DATA_TREE_FILES) {
    try {
      const info = await stat(path.join(dataDir, file))
      if (info.isFile()) files.push({ relPath: file, sizeBytes: info.size, mtimeMs: info.mtimeMs })
    } catch {
      // Absent state file: nothing to back up.
    }
  }
  for (const dir of DATA_TREE_DIRS) {
    await walk(path.join(dataDir, dir), dir, files)
  }
  return files
}

async function walk(absDir: string, relDir: string, out: Array<{ relPath: string; sizeBytes: number; mtimeMs: number }>): Promise<void> {
  let entries
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const relPath = `${relDir}/${entry.name}`
    if (entry.isDirectory()) {
      if (DATA_TREE_EXCLUDED_SUBDIRS.has(relPath)) continue
      await walk(path.join(absDir, entry.name), relPath, out)
      continue
    }
    if (!entry.isFile()) continue
    try {
      const info = await stat(path.join(absDir, entry.name))
      out.push({ relPath, sizeBytes: info.size, mtimeMs: info.mtimeMs })
    } catch {
      // Deleted mid-scan; it no longer needs backing up.
    }
  }
}

type PlaceOutcome = 'linked' | 'copied' | 'missing'

async function placeFile(input: { source: string; previousCopy: string | null; destination: string }): Promise<PlaceOutcome> {
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

interface DatabaseInfo {
  serverVersion: string
  sizeBytes: number
  appliedMigrations: string[]
}

/**
 * Version, size, and applied-migration set of the live database, read over a
 * short-lived plain `pg` connection (the backup path must not depend on
 * Prisma being healthy — restore is the tool you reach for when things are
 * broken).
 */
async function readDatabaseInfo(): Promise<DatabaseInfo> {
  const client = new Client({ connectionString: env.DATABASE_URL })
  await client.connect()
  try {
    const version = await client.query<{ server_version: string }>('SHOW server_version')
    const size = await client.query<{ size: string }>('SELECT pg_database_size(current_database()) AS size')
    let appliedMigrations: string[] = []
    try {
      const rows = await client.query<{ migration_name: string }>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name'
      )
      appliedMigrations = rows.rows.map((row) => row.migration_name)
    } catch {
      // Fresh database without a migrations table yet.
    }
    return {
      serverVersion: version.rows[0]?.server_version ?? 'unknown',
      sizeBytes: Number(size.rows[0]?.size ?? 0),
      appliedMigrations
    }
  } finally {
    await client.end().catch(() => undefined)
  }
}

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
      `Not enough free space in the backups directory: ${formatGiB(freeBytes)} free, ` +
      `about ${formatGiB(requiredBytes)} needed. Free up space or point BACKUPS_DIR at a larger disk.`
    )
  }
}

function formatGiB(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`
}
