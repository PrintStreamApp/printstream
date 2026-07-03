/**
 * Bridge crash detection across supervised restarts.
 *
 * The bridge runs under a supervisor that relaunches it on exit (systemd
 * `Restart=always`, WinSW, or Docker's restart policy). That makes crashes
 * invisible above the OS: the process dies, is restarted, and nothing tells the
 * user. This module gives the bridge a memory across restarts so it can report
 * "my previous run crashed" to the cloud, which the API turns into a log entry
 * and a user notification.
 *
 * Mechanism — a durable run-state marker file in the bridge's data directory:
 * - On every start the bridge writes `{ startedAt, cleanShutdown: false, … }`.
 * - On an *intentional* exit — SIGTERM/SIGINT from the supervisor, or a
 *   self-scheduled update restart — it flips `cleanShutdown` to true.
 * - On a *crash* (uncaughtException / unhandledRejection / hard kill) it does
 *   NOT. So the next start, reading a marker whose `cleanShutdown !== true`,
 *   knows the previous run crashed. The fatal handlers additionally record the
 *   error text so the report can carry a reason (hard kills — OOM/SIGKILL/native
 *   fault — leave none, which is itself signal).
 *
 * A rolling window of recent crash timestamps distinguishes a one-off crash from
 * a crash-loop with no server coordination: old entries age out, so the count
 * self-heals once the bridge stabilizes.
 *
 * This lives in CORE (not `private/sea`) so the Docker and standalone packagings
 * share one implementation; the marker path is injected by each entry point.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { BRIDGE_CRASH_WINDOW_SECONDS, type BridgeCrashReport } from '@printstream/shared'

/** Rolling window (ms) crash timestamps are retained for; mirrors the shared constant. */
const CRASH_WINDOW_MS = BRIDGE_CRASH_WINDOW_SECONDS * 1000
/** Upper bound on retained crash timestamps so a long crash-loop can't grow the file unbounded. */
const MAX_TRACKED_CRASHES = 50
/** Max length of a recorded crash reason (matches the shared schema's cap). */
const MAX_REASON_CHARS = 4000

/** Durable per-run marker persisted between bridge restarts. */
export interface BridgeRunState {
  /** ISO timestamp of when this run started. */
  startedAt: string
  /** Set true immediately before an intentional exit; absent/false ⇒ the run crashed. */
  cleanShutdown: boolean
  /** Error text captured by a fatal handler, or null (hard kill / not yet crashed). */
  lastReason: string | null
  /** ISO timestamps of recent crashes, pruned to the rolling window. */
  recentCrashes: string[]
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** Render an unknown thrown value into a bounded, human-readable reason string. */
export function formatCrashReason(error: unknown): string {
  if (error instanceof Error) {
    return truncate(error.stack ?? `${error.name}: ${error.message}`, MAX_REASON_CHARS)
  }
  if (typeof error === 'string') return truncate(error, MAX_REASON_CHARS)
  try {
    return truncate(JSON.stringify(error), MAX_REASON_CHARS)
  } catch {
    return 'Unknown error (unserializable)'
  }
}

/** Read the marker, tolerating a missing, corrupt, or legacy file (returns null). */
export function readRunState(markerPath: string): BridgeRunState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.startedAt !== 'string') return null
  return {
    startedAt: record.startedAt,
    cleanShutdown: record.cleanShutdown === true,
    lastReason: typeof record.lastReason === 'string' ? record.lastReason : null,
    recentCrashes: Array.isArray(record.recentCrashes)
      ? record.recentCrashes.filter((entry): entry is string => typeof entry === 'string')
      : []
  }
}

/** Atomically persist the marker (temp + rename) so a crash mid-write can't corrupt it. */
export function writeRunState(markerPath: string, state: BridgeRunState): void {
  mkdirSync(path.dirname(markerPath), { recursive: true })
  const tempPath = `${markerPath}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tempPath, markerPath)
}

/**
 * Pure startup transition: given the previous marker (or null) and the current
 * time, produce the fresh marker to persist and any crash report to flush.
 * Exposed for unit testing; {@link initCrashTracker} wires it to the filesystem.
 */
export function computeStartupTransition(
  previous: BridgeRunState | null,
  nowMs: number
): { next: BridgeRunState; pendingReport: BridgeCrashReport | null } {
  const nowIso = new Date(nowMs).toISOString()
  const recentCrashes = (previous?.recentCrashes ?? []).filter((timestamp) => {
    const ms = Date.parse(timestamp)
    return Number.isFinite(ms) && nowMs - ms <= CRASH_WINDOW_MS
  })

  const crashed = previous != null && previous.cleanShutdown !== true
  let pendingReport: BridgeCrashReport | null = null
  if (crashed) {
    recentCrashes.push(nowIso)
    while (recentCrashes.length > MAX_TRACKED_CRASHES) recentCrashes.shift()
    pendingReport = {
      reason: previous.lastReason,
      crashedRunStartedAt: previous.startedAt,
      detectedAt: nowIso,
      recentCrashCount: recentCrashes.length,
      windowSeconds: BRIDGE_CRASH_WINDOW_SECONDS
    }
  }

  return {
    next: { startedAt: nowIso, cleanShutdown: false, lastReason: null, recentCrashes },
    pendingReport
  }
}

/**
 * Read the previous marker, detect a crash, and write a fresh "running" marker.
 * Returns a crash report to flush to the workspace on the next connect, or null.
 */
export function initCrashTracker(markerPath: string, nowMs: number = Date.now()): BridgeCrashReport | null {
  const previous = readRunState(markerPath)
  const { next, pendingReport } = computeStartupTransition(previous, nowMs)
  try {
    writeRunState(markerPath, next)
  } catch {
    // If we cannot persist the marker, crash detection is degraded but the
    // bridge must still run; a later successful write recovers it.
  }
  return pendingReport
}

/** Record a crash reason on the current marker (called from a fatal handler; synchronous). */
export function recordFatalReason(markerPath: string, reason: string): void {
  const current = readRunState(markerPath) ?? {
    startedAt: new Date().toISOString(),
    cleanShutdown: false,
    lastReason: null,
    recentCrashes: []
  }
  writeRunState(markerPath, { ...current, cleanShutdown: false, lastReason: reason })
}

/** Mark the current run as a clean shutdown so the next start does not count it as a crash. */
export function markCleanShutdown(markerPath: string): void {
  const current = readRunState(markerPath)
  if (!current) return
  if (current.cleanShutdown) return
  writeRunState(markerPath, { ...current, cleanShutdown: true })
}

/**
 * Install process-level crash + clean-shutdown handlers.
 *
 * uncaughtException/unhandledRejection record the reason then exit(1) so the
 * supervisor restarts the bridge (continuing after an arbitrary fatal error
 * risks corrupted state — the point is to *report* it, not soldier on). SIGTERM
 * /SIGINT mark a clean shutdown then exit(0) so a supervisor stop or a deploy is
 * never mistaken for a crash. Idempotent: safe to call once per process.
 */
let handlersInstalled = false

export function installBridgeCrashHandlers(options: {
  markerPath: string
  logger?: Pick<Console, 'error'>
}): void {
  if (handlersInstalled) return
  handlersInstalled = true
  const logger = options.logger ?? console
  const onFatal = (label: string) => (error: unknown): void => {
    const reason = formatCrashReason(error)
    logger.error(`[fatal] ${label}: ${reason}`)
    try {
      recordFatalReason(options.markerPath, reason)
    } catch {
      // Dying regardless; a missing reason still leaves a detectable crash.
    }
    process.exit(1)
  }
  process.on('uncaughtException', onFatal('uncaughtException'))
  process.on('unhandledRejection', onFatal('unhandledRejection'))

  const onSignal = (): void => {
    try {
      markCleanShutdown(options.markerPath)
    } catch {
      // Best effort; a clean stop that fails to mark only risks one spurious report.
    }
    process.exit(0)
  }
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
}
