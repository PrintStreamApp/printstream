/**
 * Server backup coordinator: schedule, status, and single-flight runs.
 *
 * Owns the live `ServerBackupStatus` the routes and settings UI read. The
 * snapshot mechanics live in `server-backup-store.ts`; the staged restore in
 * `server-backup-restore.ts`; the web counterpart is the Backups settings
 * section (self-hosted Settings and, on cloud, Platform settings). Registered
 * from `index.ts` alongside the other interval sweeps (library cleanup et al.)
 * on every deployment: cloud installs schedule backups too, managed from the
 * platform workspace.
 *
 * Contract for callers:
 *   - `startServerBackup` only STARTS a run and returns the status snapshot
 *     (a full dump can take minutes); the UI polls the list endpoint while
 *     `running` is true.
 *   - A failed backup never wedges the app: it lands in `lastError`, logs, and,
 *     for SCHEDULED runs: emits the `server-backup-failed` platform
 *     notification so an install is not silently unprotected. Manual runs
 *     surface their failure to the user who clicked, so they do not notify.
 *   - The scheduler is a due-check (every 15 min against `lastBackupAt`), not
 *     a naive interval, so a restart never re-runs a backup taken an hour ago.
 */
import type { ServerBackupStatus } from '@printstream/shared'
import { env } from './env.js'
import { isSelfHostedDeployment } from './deployment-mode.js'
import { emitPlatformNotification } from './platform-notification-events.js'
import {
  BACKUPS_DIR_UNSET_REASON,
  createServerBackup,
  pruneServerBackups,
  readSnapshotManifests,
  serverBackupsDir,
  serverBackupMaxAgeDays,
  serverBackupUsage
} from './server-backup-store.js'
import { readPendingRestoreMarker } from './server-backup-restore.js'
import { resolvePgTools } from './server-backup-tools.js'

const SCHEDULE_CHECK_INTERVAL_MS = 15 * 60_000
/** Delay before the first due-check, letting boot-time work settle. */
const INITIAL_SCHEDULE_DELAY_MS = 5 * 60_000

interface ManagerState {
  running: boolean
  lastBackupAt: string | null
  lastError: string | null
}

const state: ManagerState = { running: false, lastBackupAt: null, lastError: null }

let scheduleTimer: ReturnType<typeof setInterval> | null = null
let initialTimer: ReturnType<typeof setTimeout> | null = null
let activeRun: Promise<void> | null = null
let warnedUnavailable = false

/**
 * Seeds `lastBackupAt` from snapshots already on disk and starts the
 * due-check timers. Cloud retention runs even when scheduled backups are disabled.
 */
export function startServerBackups(): void {
  if (scheduleTimer || initialTimer) return
  void seedLastBackupAt()
  if (env.BACKUP_INTERVAL_HOURS <= 0 && isSelfHostedDeployment()) return
  initialTimer = setTimeout(() => { void runIfDue() }, INITIAL_SCHEDULE_DELAY_MS)
  initialTimer.unref?.()
  scheduleTimer = setInterval(() => { void runIfDue() }, SCHEDULE_CHECK_INTERVAL_MS)
  scheduleTimer.unref?.()
}

export function stopServerBackups(): void {
  if (scheduleTimer) {
    clearInterval(scheduleTimer)
    scheduleTimer = null
  }
  if (initialTimer) {
    clearTimeout(initialTimer)
    initialTimer = null
  }
}

export async function getServerBackupStatus(): Promise<ServerBackupStatus> {
  const tools = await resolvePgTools()
  const usage = await serverBackupUsage()
  const restorePending = (await readPendingRestoreMarker()) !== null
  const directory = serverBackupsDir()
  return {
    available: tools.available && directory !== null,
    unavailableReason: directory === null
      ? BACKUPS_DIR_UNSET_REASON
      : tools.available
        ? null
        : tools.unavailableReason,
    directory,
    intervalHours: env.BACKUP_INTERVAL_HOURS,
    maxAgeDays: serverBackupMaxAgeDays(),
    running: state.running,
    snapshotCount: usage.snapshotCount,
    totalBytes: usage.totalBytes,
    freeBytes: usage.freeBytes,
    lastBackupAt: state.lastBackupAt,
    nextDueAt: nextDueAt(),
    lastError: state.lastError,
    restorePending
  }
}

/** Starts a backup unless one is running; returns the live status either way. */
export async function startServerBackup(trigger: 'scheduled' | 'manual'): Promise<ServerBackupStatus> {
  if (state.running) return await getServerBackupStatus()
  const backupsDir = serverBackupsDir()
  if (!backupsDir) throw new Error(BACKUPS_DIR_UNSET_REASON)
  const tools = await resolvePgTools()
  if (!tools.available) throw new Error(tools.unavailableReason)
  state.running = true
  state.lastError = null
  console.log(`[server-backup] ${trigger} backup started into ${backupsDir}`)
  activeRun = (async () => {
    try {
      const { snapshot, prunedCount } = await createServerBackup(trigger)
      state.lastBackupAt = snapshot.createdAt
      console.log(
        `[server-backup] backup complete: ${snapshot.dataFileCount} files + ${snapshot.dbDumpBytes} byte dump` +
        `${prunedCount > 0 ? `, ${prunedCount} old snapshot(s) pruned` : ''}`
      )
    } catch (error) {
      state.lastError = (error as Error).message || 'Backup failed.'
      console.error(`[server-backup] backup failed: ${state.lastError}`)
      if (trigger === 'scheduled') {
        await emitPlatformNotification(
          'server-backup-failed',
          { reason: state.lastError },
          // The section lives in workspace Settings on self-hosted installs
          // and in Platform settings on cloud.
          { level: 'error', url: isSelfHostedDeployment() ? '/settings/backups' : '/platform/settings/backups' }
        )
      }
    } finally {
      state.running = false
      activeRun = null
    }
  })()
  return await getServerBackupStatus()
}

/** Test hook: resolves once the in-flight run (if any) has finished. */
export async function waitForServerBackupIdle(): Promise<void> {
  while (activeRun) {
    await activeRun
  }
}

async function seedLastBackupAt(): Promise<void> {
  const backupsDir = serverBackupsDir()
  if (!backupsDir) return
  try {
    const manifests = await readSnapshotManifests(backupsDir)
    state.lastBackupAt = manifests[0]?.manifest.createdAt ?? null
  } catch (error) {
    console.warn(`[server-backup] could not read existing backups: ${(error as Error).message}`)
  }
}

function nextDueAt(): string | null {
  if (env.BACKUP_INTERVAL_HOURS <= 0) return null
  const nowMs = Date.now()
  if (!state.lastBackupAt) return new Date(nowMs).toISOString()
  const dueMs = Date.parse(state.lastBackupAt) + env.BACKUP_INTERVAL_HOURS * 3_600_000
  return new Date(Math.max(dueMs, nowMs)).toISOString()
}

async function runIfDue(): Promise<void> {
  if (state.running || !serverBackupsDir()) return
  if (!isSelfHostedDeployment()) {
    try {
      // A pending restore owns its source snapshot until restart applies it.
      if (await readPendingRestoreMarker()) {
        console.warn('[server-backup] Pending restore is blocking cloud retention; complete the restore promptly.')
        return
      }
      const count = await pruneServerBackups(serverBackupsDir()!, Date.now(), serverBackupMaxAgeDays(), false)
      if (count > 0) console.log(`[server-backup] cloud retention removed ${count} expired snapshots`)
    } catch (error) {
      console.error(`[server-backup] cloud retention failed: ${(error as Error).message}`)
    }
  }
  if (env.BACKUP_INTERVAL_HOURS <= 0) return
  const dueMs = state.lastBackupAt
    ? Date.parse(state.lastBackupAt) + env.BACKUP_INTERVAL_HOURS * 3_600_000
    : 0
  if (Date.now() < dueMs) return
  const tools = await resolvePgTools()
  if (!tools.available) {
    // Say it once per process, not every 15 minutes.
    if (!warnedUnavailable) {
      warnedUnavailable = true
      console.warn(`[server-backup] scheduled backups skipped: ${tools.unavailableReason}`)
    }
    return
  }
  await startServerBackup('scheduled').catch((error) => {
    console.error(`[server-backup] scheduled run failed to start: ${(error as Error).message}`)
  })
}
