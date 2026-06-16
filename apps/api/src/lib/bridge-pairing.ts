/**
 * Bridge pairing.
 *
 * Attaching a dormant bridge record to a workspace is the same sequence whether
 * it happens interactively (an operator enters a connect code, `bridges.ts`) or
 * automatically (a managed bridge presents its provisioning secret at
 * registration, `bridge-runtime.ts`): set the tenant, reclaim any printers and
 * library files orphaned by a previous detach, hand the live session its
 * workspace, and fan out the resource-changed events. Centralizing it here keeps
 * the two entry points from drifting.
 *
 * Safe to call before the bridge's WebSocket session exists (the managed
 * auto-pair path runs during the registration HTTP request): the session
 * handoff is guarded on an active connection and skipped when there is none —
 * the bridge then learns its workspace from the `bridge.welcome` the session
 * server sends once it connects.
 */
import { recoverBridgeLibraryAssignments, recoveredBridgeLibraryAssignmentCount } from './bridge-library-assignment-recovery.js'
import { recoverBridgePrinterAssignments } from './bridge-assignment-recovery.js'
import { syncBridgePrinterConfig } from './bridge-printer-config.js'
import { bridgeSessionManager } from './bridge-session-manager.js'
import { rootPrisma } from './prisma.js'
import { broadcastBridgesChanged, broadcastLibraryChanged, broadcastPrinterViewsChanged } from './ws-resource-events.js'

const BRIDGE_HEARTBEAT_INTERVAL_SECONDS = 15

/**
 * Bridge record fields the pairing update returns so the caller can render a
 * bridge summary without a second read. The `_count.printers` here is captured
 * before printer reattachment, so add `reattachedPrinterCount` when reporting a
 * total.
 */
const PAIRED_BRIDGE_SELECT = {
  id: true,
  name: true,
  version: true,
  releaseFingerprint: true,
  buildRevision: true,
  sourceFingerprint: true,
  protocolVersion: true,
  runnerAbiVersion: true,
  updateChannel: true,
  updateStatus: true,
  latestAvailableVersion: true,
  lastUpdateCheckAt: true,
  lastUpdateError: true,
  lastSeenAt: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: {
      printers: true
    }
  }
} as const

/**
 * Attaches the bridge to a workspace and performs every side effect that has to
 * accompany it. The caller is responsible for any pre-checks (connect-code
 * lookup, already-paired conflict, tenant resolution).
 */
export async function pairBridgeToTenant(options: {
  bridgeId: string
  tenantId: string
  name?: string
}) {
  const { bridgeId, tenantId, name } = options

  const bridge = await rootPrisma.bridge.update({
    where: { id: bridgeId },
    data: {
      tenantId,
      ...(name ? { name } : {})
    },
    select: PAIRED_BRIDGE_SELECT
  })

  const reattachedPrinters = await recoverBridgePrinterAssignments({ tenantId, bridgeId })
  const reassignedLibrary = await recoverBridgeLibraryAssignments({ tenantId, bridgeId })

  if (bridgeSessionManager.setTenantId(bridgeId, tenantId)) {
    bridgeSessionManager.sendMessage(bridgeId, {
      type: 'bridge.welcome',
      bridgeId,
      connected: true,
      tenantId,
      heartbeatIntervalSeconds: BRIDGE_HEARTBEAT_INTERVAL_SECONDS
    })
    await syncBridgePrinterConfig(bridgeId)
  }

  broadcastBridgesChanged(tenantId)
  if (recoveredBridgeLibraryAssignmentCount(reassignedLibrary) > 0) {
    broadcastLibraryChanged(tenantId)
  }
  if (reattachedPrinters.length > 0) {
    broadcastPrinterViewsChanged(tenantId)
  }

  return { bridge, reattachedPrinterCount: reattachedPrinters.length }
}
