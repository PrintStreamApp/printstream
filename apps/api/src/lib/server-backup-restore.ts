/**
 * Staged restore of a server backup (issue #78).
 *
 * A running app cannot safely drop and recreate its own database underneath
 * itself, so restore is TWO-PHASE:
 *
 *  1. `stageServerRestore` (from the route, app running): re-validate the
 *     snapshot, take a `pre-restore` safety backup so a mis-click is itself
 *     recoverable, write the restore marker, and exit with the service-restart
 *     code (the systemd/WinSW unit and Docker's `restart: unless-stopped`
 *     both bring the process back).
 *
 *  2. `applyStagedServerRestoreIfPending` (from `apps/api/src/server.ts`, on
 *     the next boot, after `DATABASE_URL` is settled but BEFORE Prisma or
 *     migrations touch the database): drop + recreate the database,
 *     `pg_restore` the dump, replace the persistent data tree from the
 *     snapshot, and hand back to the boot path, which then runs migrations
 *     forward — the established upgrade contract, and exactly the state a
 *     restored dump is in.
 *
 * Crash posture: the marker is renamed to a single-attempt name before any
 * destructive step, so a crash mid-restore can never loop the boot into
 * dropping the database again; it fails the boot loudly instead, and the
 * pre-restore safety backup is the way back. A marker that fails REvalidation
 * (backup deleted between staging and boot) aborts before touching anything.
 */
import path from 'node:path'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { Client } from 'pg'
import { SERVICE_RESTART_EXIT_CODE } from '@printstream/sea-runtime'
import { listMigrationFiles } from './apply-migrations.js'
import { env } from './env.js'
import {
  BACKUPS_DIR_UNSET_REASON,
  createServerBackup,
  readServerBackupManifest,
  restoreBlockedReason,
  serverBackupsDir,
  serverDataDir
} from './server-backup-store.js'
import { libpqCompatibleUrl, resolvePgTools, runPgTool } from './server-backup-tools.js'

const PENDING_MARKER = 'restore-pending.json'
const ATTEMPT_MARKER = 'restore-attempt.json'
const FAILED_MARKER = 'restore-failed.json'
/** Grace before exiting so the HTTP response reaches the caller first. */
const RESTART_EXIT_DELAY_MS = 500

/** Same allowlist as the snapshot side; restore replaces exactly what backup captures. */
const RESTORED_DIRS = ['library', 'plugins', 'job-history-snapshots', 'job-history-thumbnails', 'support-attachments']
const RESTORED_FILES = ['printer-zip-transport-hints.json', 'slicing-jobs-state.json', 'dispatched-print-sources.json', 'bridge-state.json']
/** Regenerable caches wiped on restore so nothing stale outlives the database they were derived against. */
const WIPED_CACHE_DIRS = ['cover-cache']

interface RestoreMarker {
  version: number
  backupName: string
  requestedAt: string
}

function markerPath(): string | null {
  const backupsDir = serverBackupsDir()
  return backupsDir ? path.join(backupsDir, PENDING_MARKER) : null
}

export async function readPendingRestoreMarker(): Promise<RestoreMarker | null> {
  const marker = markerPath()
  if (!marker) return null
  try {
    const parsed = JSON.parse(await readFile(marker, 'utf8')) as RestoreMarker
    return parsed.version === 1 && typeof parsed.backupName === 'string' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Validates, takes the safety backup, stages the marker, and schedules the
 * process exit. Throws (with a user-facing message) on any refusal; when it
 * returns, the restart is already scheduled.
 */
export async function stageServerRestore(backupName: string): Promise<string> {
  const backupsDir = serverBackupsDir()
  if (!backupsDir) throw new Error(BACKUPS_DIR_UNSET_REASON)
  const manifest = await readServerBackupManifest(backupName)
  if (!manifest) throw new Error('Backup not found.')
  const blocked = restoreBlockedReason(
    manifest,
    new Set(listMigrationFiles().map((migration) => migration.name)),
    null
  )
  if (blocked) throw new Error(blocked)
  if (await readPendingRestoreMarker()) throw new Error('A restore is already staged; the app is about to restart.')

  // The safety backup is not optional: restoring over the only copy of the
  // current state turns a mis-click into data loss. Its failure fails the
  // staging — "no backup" and "about to destroy the database" must not meet.
  await createServerBackup('pre-restore')

  const marker: RestoreMarker = { version: 1, backupName, requestedAt: new Date().toISOString() }
  await mkdir(backupsDir, { recursive: true, mode: 0o700 })
  await writeFile(path.join(backupsDir, PENDING_MARKER), JSON.stringify(marker, null, 2) + '\n', 'utf8')

  console.warn(`[server-restore] restore of ${backupName} staged; restarting to apply it.`)
  setTimeout(() => process.exit(SERVICE_RESTART_EXIT_CODE), RESTART_EXIT_DELAY_MS).unref()
  return 'Restore staged. The app is restarting to apply it; this can take a few minutes.'
}

export interface AppliedRestore {
  backupName: string
  databaseUrl: string
}

/**
 * Boot-time half. Returns null on the ordinary boot (no marker). On a staged
 * restore it either completes fully or THROWS — a half-restored database must
 * fail the boot loudly, never serve traffic. The caller (`server.ts`) runs
 * migrations forward after a successful apply.
 */
export async function applyStagedServerRestoreIfPending(): Promise<AppliedRestore | null> {
  const marker = await readPendingRestoreMarker()
  const backupsDir = serverBackupsDir()
  if (!marker || !backupsDir) return null

  // Single attempt: a crash below must not re-drop the database on every boot.
  await rename(path.join(backupsDir, PENDING_MARKER), path.join(backupsDir, ATTEMPT_MARKER))

  const manifest = await readServerBackupManifest(marker.backupName)
  const blocked = manifest
    ? restoreBlockedReason(manifest, new Set(listMigrationFiles().map((migration) => migration.name)), null)
    : 'the backup no longer exists'
  if (!manifest || blocked) {
    // Nothing destructive has happened; abort the restore and boot normally.
    console.error(`[server-restore] staged restore of ${marker.backupName} aborted: ${blocked}.`)
    await rename(path.join(backupsDir, ATTEMPT_MARKER), path.join(backupsDir, FAILED_MARKER)).catch(() => undefined)
    return null
  }
  const tools = await resolvePgTools()
  if (!tools.available) {
    console.error(`[server-restore] staged restore aborted: ${tools.unavailableReason}`)
    await rename(path.join(backupsDir, ATTEMPT_MARKER), path.join(backupsDir, FAILED_MARKER)).catch(() => undefined)
    return null
  }

  console.warn(`[server-restore] applying staged restore of ${marker.backupName} (requested ${marker.requestedAt}).`)
  const snapshotDir = path.join(backupsDir, marker.backupName)

  await recreateDatabase(env.DATABASE_URL)
  // --no-owner/--no-privileges/--no-comments: a whole-DB dump restored into a
  // fresh database under a single app role has no owners/ACLs/extension
  // comments worth replaying, and those are exactly the statements that fail
  // under a non-superuser account.
  await runPgTool(tools.pgRestore, [
    '--dbname', libpqCompatibleUrl(env.DATABASE_URL),
    '--no-owner', '--no-privileges', '--no-comments',
    '--exit-on-error',
    path.join(snapshotDir, 'db.dump')
  ])

  const dataDir = serverDataDir()
  for (const dir of [...RESTORED_DIRS, ...WIPED_CACHE_DIRS]) {
    await rm(path.join(dataDir, dir), { recursive: true, force: true })
  }
  for (const file of RESTORED_FILES) {
    await rm(path.join(dataDir, file), { force: true })
  }
  for (const item of [...RESTORED_DIRS, ...RESTORED_FILES]) {
    const source = path.join(snapshotDir, 'data', item)
    try {
      await cp(source, path.join(dataDir, item), { recursive: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }

  await rm(path.join(backupsDir, ATTEMPT_MARKER), { force: true }).catch(() => undefined)
  await rm(path.join(backupsDir, FAILED_MARKER), { force: true }).catch(() => undefined)
  console.warn(`[server-restore] restore of ${marker.backupName} applied; continuing boot with migrations.`)
  return { backupName: marker.backupName, databaseUrl: env.DATABASE_URL }
}

/**
 * Drops and recreates the application database via the `postgres` maintenance
 * database on the same server. WITH (FORCE) severs any lingering connections
 * (the Docker entrypoint's migration bootstrap already ran against the doomed
 * database on this boot).
 */
async function recreateDatabase(rawDatabaseUrl: string): Promise<void> {
  const databaseUrl = libpqCompatibleUrl(rawDatabaseUrl)
  const url = new URL(databaseUrl)
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres'
  if (databaseName === 'postgres') {
    throw new Error('Refusing to drop the postgres maintenance database; DATABASE_URL must name the application database.')
  }
  const adminUrl = new URL(databaseUrl)
  adminUrl.pathname = '/postgres'
  const client = new Client({ connectionString: adminUrl.toString() })
  await client.connect()
  try {
    const quoted = `"${databaseName.replaceAll('"', '""')}"`
    await client.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`)
    await client.query(`CREATE DATABASE ${quoted}`)
  } finally {
    await client.end().catch(() => undefined)
  }
}
