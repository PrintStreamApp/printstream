/**
 * Ingest of bridge-reported crashes.
 *
 * A bridge reports (over its session) when it detected on startup that its
 * previous run died without a clean shutdown — see the bridge crash-tracker.
 * This module records that report three ways:
 *  - a durable crash summary on the `Bridge` row (drives the web's health UI),
 *  - an operational log entry the owning tenant can see in the Logs view, and
 *  - a rate-limited user notification (fired via the `bridge.crashed` event so
 *    every delivery channel picks it up).
 *
 * Rate limiting is deliberate: a crash-loop produces one report per restart, so
 * without a cooldown a flapping bridge would spam the user. Every report is still
 * logged; only the notification is throttled. The throttle is durable
 * (`Bridge.lastCrashNotifiedAt`) so it survives an API restart.
 */
import { BRIDGE_CRASH_LOOP_THRESHOLD, type BridgeCrashReport } from '@printstream/shared'
import { rootPrisma } from './prisma.js'
import { printerEvents } from './printer-events.js'
import { pushSystemLog } from './logs.js'
import { broadcastBridgesChanged, broadcastLogsChanged } from './ws-resource-events.js'

/** Minimum gap between user-facing crash notifications for one bridge. */
const CRASH_NOTIFY_COOLDOWN_MS = 15 * 60 * 1000
/** Bound the reason persisted to the row / shown in the UI (full stack stays in bridge logs). */
const MAX_STORED_REASON_CHARS = 500

function firstLine(reason: string): string {
  const line = reason.split('\n', 1)[0]?.trim() ?? ''
  return line.length > MAX_STORED_REASON_CHARS ? `${line.slice(0, MAX_STORED_REASON_CHARS - 1)}…` : line
}

function parseTimestamp(value: string): Date {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms) : new Date()
}

function shouldNotify(lastNotifiedAt: Date | null, now: Date): boolean {
  if (!lastNotifiedAt) return true
  return now.getTime() - lastNotifiedAt.getTime() >= CRASH_NOTIFY_COOLDOWN_MS
}

/**
 * Record a crash report from a bridge session. `sessionTenantId` is the tenant
 * the session authenticated as (null for an unpaired bridge); it takes priority
 * over the stored row's tenant, which is used only as a fallback.
 */
export async function ingestBridgeCrashReport(input: {
  bridgeId: string
  sessionTenantId: string | null
  report: BridgeCrashReport
}): Promise<void> {
  const { bridgeId, sessionTenantId, report } = input
  const bridge = await rootPrisma.bridge.findUnique({
    where: { id: bridgeId },
    select: { name: true, tenantId: true, lastCrashNotifiedAt: true }
  })
  if (!bridge) {
    console.warn(`[bridge-crash] received a crash report for unknown bridge ${bridgeId}; ignoring`)
    return
  }

  const tenantId = sessionTenantId ?? bridge.tenantId ?? null
  const detectedAt = parseTimestamp(report.detectedAt)
  const reason = report.reason ? firstLine(report.reason) : null
  const looping = report.recentCrashCount >= BRIDGE_CRASH_LOOP_THRESHOLD
  const notify = tenantId != null && shouldNotify(bridge.lastCrashNotifiedAt, detectedAt)

  await rootPrisma.bridge.update({
    where: { id: bridgeId },
    data: {
      lastCrashAt: detectedAt,
      lastCrashReason: reason,
      recentCrashCount: report.recentCrashCount,
      ...(notify ? { lastCrashNotifiedAt: detectedAt } : {})
    }
  })

  const windowMinutes = Math.max(1, Math.round(report.windowSeconds / 60))
  const message = looping
    ? `Bridge "${bridge.name}" is crash-looping: ${report.recentCrashCount} crashes in the last ${windowMinutes}m${reason ? `. Last error: ${reason}` : ' (no reason captured — likely a hard kill)'}`
    : `Bridge "${bridge.name}" crashed and restarted${reason ? `: ${reason}` : ' (no reason captured — likely a hard kill)'}`
  pushSystemLog({ level: 'error', message, tenantId })
  broadcastLogsChanged(tenantId)
  broadcastBridgesChanged(tenantId)

  if (notify) {
    printerEvents.emit('bridge.crashed', {
      bridgeId,
      bridgeName: bridge.name,
      tenantId,
      recentCrashCount: report.recentCrashCount
    })
  }
}
