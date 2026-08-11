/**
 * Bridge backup coordinator: schedule, status, and single-flight runs.
 *
 * Owns the live `BridgeBackupStatus` the API mirrors (pushed over the session
 * as `bridge.backup.status`, same delivery as the debug-capture status) and the
 * interval scheduler. The snapshot mechanics live in `backup-store.ts`; the
 * session wiring lives in `runtime.ts`; the API counterparts are
 * `apps/api/src/lib/bridge-backup-status.ts` and `routes/bridges.ts`.
 *
 * Contract for callers:
 *   - `startBridgeBackup` only STARTS a run and returns the status snapshot —
 *     a first full backup can take minutes, far past any RPC timeout; the
 *     completed status is pushed through the change listener instead. A start
 *     while a run is active is a no-op returning the current status.
 *   - A failed backup never throws out of the scheduler and never wedges the
 *     bridge: it lands in `lastError`, is logged (visible in the web logs
 *     dialog), and the next scheduled run retries.
 *   - Backups are configured by env only (`BRIDGE_BACKUP_DIR` +
 *     `BRIDGE_BACKUP_INTERVAL_HOURS`); with no directory set the whole feature
 *     is off and the status reports unconfigured.
 */
import { unconfiguredBridgeBackupStatus, type BridgeBackupSnapshot, type BridgeBackupStatus } from '@printstream/shared'
import { env } from './env.js'
import {
  createBackupSnapshot,
  listBackupSnapshots,
  validateBackupDirectory
} from './backup-store.js'

/** How often the scheduler re-checks whether a backup is due (cheap: pure math). */
const SCHEDULE_CHECK_INTERVAL_MS = 15 * 60_000
/** Delay before the first due-check, letting registration and transports settle. */
const INITIAL_SCHEDULE_DELAY_MS = 2 * 60_000

interface BackupConfig {
  backupDir: string
  libraryDir: string
  stateFilePath: string
  intervalHours: number
  now: () => number
}

interface BackupRuntimeState {
  config: BackupConfig | null
  /** A misconfiguration detected at init (e.g. backup dir inside the library). */
  configError: string | null
  running: boolean
  lastBackupAt: string | null
  snapshotCount: number
  lastError: string | null
}

const state: BackupRuntimeState = {
  config: null,
  configError: null,
  running: false,
  lastBackupAt: null,
  snapshotCount: 0,
  lastError: null
}

let statusListener: ((status: BridgeBackupStatus) => void) | null = null
let scheduleTimer: ReturnType<typeof setInterval> | null = null
let initialTimer: ReturnType<typeof setTimeout> | null = null
let activeRun: Promise<void> | null = null

/**
 * Configures backups from env and starts the scheduler. Seeds `lastBackupAt`
 * from snapshots already on disk so a restarted bridge does not re-run a backup
 * it took an hour ago. Safe to call once per process; test overrides replace
 * the env-derived config.
 */
export async function initBridgeBackups(overrides?: Partial<BackupConfig>): Promise<void> {
  stopBridgeBackupScheduler()
  const backupDir = overrides?.backupDir ?? env.BRIDGE_BACKUP_DIR
  if (!backupDir) {
    state.config = null
    state.configError = null
    return
  }
  state.config = {
    backupDir,
    libraryDir: overrides?.libraryDir ?? env.BRIDGE_LIBRARY_DIR,
    stateFilePath: overrides?.stateFilePath ?? env.BRIDGE_STATE_FILE,
    intervalHours: overrides?.intervalHours ?? env.BRIDGE_BACKUP_INTERVAL_HOURS,
    now: overrides?.now ?? Date.now
  }
  state.configError = validateBackupDirectory(state.config.backupDir, state.config.libraryDir)
  if (state.configError) {
    console.error(`[bridge:backup] ${state.configError}`)
    return
  }

  try {
    const snapshots = await listBackupSnapshots(state.config.backupDir)
    state.snapshotCount = snapshots.length
    state.lastBackupAt = snapshots[0]?.createdAt ?? null
  } catch (error) {
    console.warn(`[bridge:backup] could not read existing backups: ${(error as Error).message}`)
  }

  if (state.config.intervalHours > 0) {
    initialTimer = setTimeout(() => { runIfDue() }, INITIAL_SCHEDULE_DELAY_MS)
    initialTimer.unref?.()
    scheduleTimer = setInterval(() => { runIfDue() }, SCHEDULE_CHECK_INTERVAL_MS)
    scheduleTimer.unref?.()
  }
}

export function stopBridgeBackupScheduler(): void {
  if (scheduleTimer) {
    clearInterval(scheduleTimer)
    scheduleTimer = null
  }
  if (initialTimer) {
    clearTimeout(initialTimer)
    initialTimer = null
  }
}

export function getBridgeBackupStatus(): BridgeBackupStatus {
  if (!state.config) return { ...unconfiguredBridgeBackupStatus }
  return {
    configured: true,
    directory: state.config.backupDir,
    intervalHours: state.config.intervalHours,
    running: state.running,
    snapshotCount: state.snapshotCount,
    lastBackupAt: state.lastBackupAt,
    nextDueAt: nextDueAt(state.config),
    lastError: state.configError ?? state.lastError
  }
}

/**
 * Single listener, per-connection like the capture notifier: `runtime.ts` sets
 * it while a session socket is open and clears it with `null` on close.
 */
export function onBridgeBackupStatusChange(listener: ((status: BridgeBackupStatus) => void) | null): void {
  statusListener = listener
}

/** Starts a backup unless one is running or the config refuses; returns the live status. */
export function startBridgeBackup(trigger: 'scheduled' | 'manual'): BridgeBackupStatus {
  const config = state.config
  if (!config || state.configError || state.running) return getBridgeBackupStatus()
  state.running = true
  state.lastError = null
  notifyStatusChange()
  console.log(`[bridge:backup] ${trigger} backup started into ${config.backupDir}`)
  activeRun = (async () => {
    try {
      const { snapshot, prunedCount } = await createBackupSnapshot({
        backupDir: config.backupDir,
        libraryDir: config.libraryDir,
        stateFilePath: config.stateFilePath,
        trigger,
        now: config.now
      })
      state.lastBackupAt = snapshot.createdAt
      state.snapshotCount = Math.max(0, state.snapshotCount + 1 - prunedCount)
      console.log(
        `[bridge:backup] backup complete: ${snapshot.fileCount} files, ` +
        `${snapshot.copiedBytes} bytes copied${prunedCount > 0 ? `, ${prunedCount} old snapshot(s) pruned` : ''}`
      )
    } catch (error) {
      state.lastError = (error as Error).message || 'Backup failed.'
      console.error(`[bridge:backup] backup failed: ${state.lastError}`)
    } finally {
      state.running = false
      activeRun = null
      notifyStatusChange()
    }
  })()
  return getBridgeBackupStatus()
}

/** Snapshots currently on disk, newest first. Throws when backups are unconfigured. */
export async function listBridgeBackupSnapshots(): Promise<BridgeBackupSnapshot[]> {
  if (!state.config) throw new Error('Bridge backups are not configured (set BRIDGE_BACKUP_DIR).')
  const snapshots = await listBackupSnapshots(state.config.backupDir)
  state.snapshotCount = snapshots.length
  state.lastBackupAt = snapshots[0]?.createdAt ?? state.lastBackupAt
  return snapshots
}

/** Test hook: resolves once the in-flight run (if any) has finished. */
export async function waitForBridgeBackupIdle(): Promise<void> {
  while (activeRun) {
    await activeRun
  }
}

function nextDueAt(config: BackupConfig): string | null {
  if (config.intervalHours <= 0) return null
  const nowMs = config.now()
  if (!state.lastBackupAt) return new Date(nowMs).toISOString()
  const dueMs = Date.parse(state.lastBackupAt) + config.intervalHours * 3_600_000
  return new Date(Math.max(dueMs, nowMs)).toISOString()
}

function runIfDue(): void {
  const config = state.config
  if (!config || state.configError || state.running || config.intervalHours <= 0) return
  const dueMs = state.lastBackupAt
    ? Date.parse(state.lastBackupAt) + config.intervalHours * 3_600_000
    : 0
  if (config.now() >= dueMs) {
    startBridgeBackup('scheduled')
  }
}

function notifyStatusChange(): void {
  statusListener?.(getBridgeBackupStatus())
}
