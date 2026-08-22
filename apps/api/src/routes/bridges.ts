/**
 * Workspace bridge management routes.
 *
 * Owns the workspace-facing bridge surface: listing, connect/rename/delete, the
 * connection test/ping, system-log and debug-capture retrieval, crash-history
 * clearing, and update check/start — the bridge-side ones routed to the owning
 * bridge through `bridgeSessionManager`.
 */
import express from 'express'
import {
  SETTINGS_MANAGE_PERMISSION,
  bridgeListResponseSchema,
  bridgeResponseSchema,
  bridgePingParamsSchema,
  bridgePingResultSchema,
  bridgeSystemLogsParamsSchema,
  bridgeSystemLogsResultSchema,
  bridgeDebugCaptureStartParamsSchema,
  bridgeDebugCaptureStopParamsSchema,
  bridgeDebugCaptureReadParamsSchema,
  bridgeDebugCaptureReadResultSchema,
  bridgeDebugCaptureStatusResultSchema,
  bridgeBackupRunParamsSchema,
  bridgeBackupListParamsSchema,
  bridgeBackupListResponseSchema,
  bridgeBackupListResultSchema,
  bridgeBackupStatusResultSchema,
  bridgeTestResponseSchema,
  bridgeUpdateActionResponseSchema,
  bridgeUpdateActionResultSchema,
  bridgeStandaloneDownloadsResponseSchema,
  STANDALONE_BRIDGE_DEFAULT_SERVER_URL,
  bridgeUpdateInstallParamsSchema,
  connectBridgeRequestSchema,
  updateBridgeRequestSchema
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { getBridgeDebugCaptureStatus } from '../lib/bridge-debug-capture.js'
import { getBridgeBackupStatus, setBridgeBackupStatus } from '../lib/bridge-backup-status.js'
import { pairBridgeToWorkspace } from '../lib/bridge-pairing.js'
import { listBridgeStandaloneDownloads } from '../lib/bridge-standalone-downloads.js'
import { buildBridgeUpdateSummary, resolveBridgeAssetOrigin } from '../lib/bridge-update-policy.js'
import { syncBridgePrinterConfig } from '../lib/bridge-printer-config.js'
import { bridgeSessionManager } from '../lib/bridge-session-manager.js'
import { isSelfHostedDeployment } from '../lib/deployment-mode.js'
import { conflict, notFound } from '../lib/http-error.js'
import { printerManager } from '../lib/printer-manager.js'
import { toPrinterDto } from '../lib/printer-record.js'
import { prisma, rootPrisma } from '../lib/prisma.js'
import { readRequestOrigin, requireRequestWorkspaceId, requireRouteParam } from '../lib/request-helpers.js'
import { broadcastBridgesChanged, broadcastPrinterViewsChanged } from '../lib/ws-resource-events.js'

export const bridgesRouter = express.Router()

const BRIDGE_HEARTBEAT_INTERVAL_SECONDS = 15

/**
 * Returned by the bridge update actions on self-hosted deployments, where the
 * bridge ships inside the application bundle and updates only when the whole
 * bundle is updated. There is no independent bridge update to check or apply.
 */
const SELF_HOSTED_BUNDLE_UPDATE_MESSAGE =
  'This bridge is part of the PrintStream bundle and updates with the application. Update the whole deployment to update the bridge.'

bridgesRouter.use(requireRequestPermission(SETTINGS_MANAGE_PERMISSION))

/** Every column `toBridgeSummary` reads; keep the two in step. */
const BRIDGE_SUMMARY_SELECT = {
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
  lastCrashAt: true,
  lastCrashReason: true,
  recentCrashCount: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: {
      printers: true
    }
  }
} as const

bridgesRouter.get('/', async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  const bridges = await prisma.bridge.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    select: BRIDGE_SUMMARY_SELECT
  })

  response.json(bridgeListResponseSchema.parse({
    bridges: bridges.map((bridge) => toBridgeSummary(bridge))
  }))
})

bridgesRouter.get('/downloads', (request, response) => {
  const assetOrigin = resolveBridgeAssetOrigin(readRequestOrigin(request))
  const serverUrlOverride = standaloneBridgeServerUrlOverride(assetOrigin)
  const { downloads, unavailableReason } = listBridgeStandaloneDownloads({ assetOrigin, serverUrlOverride })
  response.json(bridgeStandaloneDownloadsResponseSchema.parse({
    downloads,
    unavailableReason,
    serverUrlOverride
  }))
})

/**
 * The `BRIDGE_SERVER_URL` a download from THIS origin has to be given, if any.
 *
 * The packaged executable carries one baked origin (the cloud) and cannot be
 * varied per download, so a binary fetched from anywhere else registers with
 * the cloud instead of the server that served it — silently, since it then
 * prints a connect URL for the wrong host. Returning the origin here is what
 * lets the download surface say so.
 *
 * Null when this server IS the baked default: telling a cloud customer to
 * configure the value it already has adds a step whose only possible outcome is
 * a typo. Null too when the origin cannot be resolved, because a guess here is
 * worse than the existing default — a wrong URL fails to connect at all,
 * whereas the default at least works for the common case.
 */
export function standaloneBridgeServerUrlOverride(assetOrigin: string | null): string | null {
  if (!assetOrigin) return null
  const normalize = (value: string): string => value.replace(/\/+$/, '').toLowerCase()
  return normalize(assetOrigin) === normalize(STANDALONE_BRIDGE_DEFAULT_SERVER_URL) ? null : assetOrigin
}

bridgesRouter.post('/connect', async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  const parsed = connectBridgeRequestSchema.parse(request.body)
  const existing = await rootPrisma.bridge.findUnique({
    where: { connectCode: parsed.connectCode },
    select: {
      id: true,
      workspaceId: true
    }
  })

  if (!existing) {
    throw notFound('Bridge connect code not found.')
  }
  if (existing.workspaceId) {
    throw conflict('Bridge has already been connected to a workspace.')
  }

  const { bridge, reattachedPrinterCount } = await pairBridgeToWorkspace({
    bridgeId: existing.id,
    workspaceId,
    name: parsed.name
  })

  // Never record the bridge connect code — it is a secret.
  annotateRequestAuditLog(request, {
    action: 'connect-bridge',
    resource: 'bridge',
    summary: `Connected bridge ${bridge.name} to this workspace.`,
    metadata: {
      bridgeId: bridge.id,
      bridgeName: bridge.name,
      reattachedPrinterCount
    }
  })

  response.status(201).json(bridgeResponseSchema.parse({
    bridge: {
      ...toBridgeSummary(bridge),
      printerCount: bridge._count.printers + reattachedPrinterCount
    }
  }))
})

bridgesRouter.patch('/:id', async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  const bridgeId = requireRouteParam(request.params.id, 'id')
  const parsed = updateBridgeRequestSchema.parse(request.body)
  const previous = await prisma.bridge.findFirst({
    where: { id: bridgeId, workspaceId },
    select: { name: true }
  })
  const bridge = await prisma.bridge.update({
    where: { id: bridgeId },
    data: { name: parsed.name },
    select: BRIDGE_SUMMARY_SELECT
  })

  annotateRequestAuditLog(request, {
    action: 'rename-bridge',
    resource: 'bridge',
    summary: previous && previous.name !== bridge.name
      ? `Renamed bridge ${previous.name} to ${bridge.name}.`
      : `Renamed bridge ${bridge.name}.`,
    metadata: {
      bridgeId: bridge.id,
      previousName: previous?.name ?? null,
      bridgeName: bridge.name
    }
  })

  broadcastBridgesChanged(workspaceId)
  response.json(bridgeResponseSchema.parse({ bridge: toBridgeSummary(bridge) }))
})

/**
 * Clear a bridge's recorded crash history (the `Bridge` crash summary that
 * `deriveBridgeCrashState` reads).
 *
 * Why this exists: the summary is self-healing — it ages out once the last
 * crash leaves the rolling window — but until then the crash-loop banner shows
 * on every workspace page. This is the escape hatch for an operator who has
 * already dealt with the cause and does not want to wait out the window. It
 * clears the record for the WHOLE workspace, which is why it is a server action
 * rather than a per-browser dismissal, and why the button says "clear" rather
 * than "dismiss".
 *
 * Deliberately does NOT reset the bridge's own rolling crash window (its
 * on-disk run-state marker — see `apps/bridge/src/crash-tracker.ts`): doing so
 * would need an RPC to a bridge that, in exactly this situation, is likely to
 * be down or restarting. So a bridge that crashes again inside its window
 * re-reports its full count and the alert returns — correct, because it is in
 * fact still crash-looping. Nothing is lost either way: every report also
 * writes an operational log entry, which this does not touch.
 *
 * `lastCrashNotifiedAt` is cleared too, so the next crash notifies immediately
 * instead of being swallowed by the notify cooldown (`bridge-crash-reports.ts`).
 */
bridgesRouter.delete('/:id/crash-history', async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  const bridgeId = requireRouteParam(request.params.id, 'id')
  const existing = await prisma.bridge.findFirst({
    where: { id: bridgeId, workspaceId },
    select: { id: true, name: true, lastCrashAt: true, recentCrashCount: true }
  })
  if (!existing) {
    throw notFound('Bridge not found.')
  }

  const bridge = await prisma.bridge.update({
    where: { id: existing.id },
    data: {
      lastCrashAt: null,
      lastCrashReason: null,
      recentCrashCount: 0,
      lastCrashNotifiedAt: null
    },
    select: BRIDGE_SUMMARY_SELECT
  })

  annotateRequestAuditLog(request, {
    action: 'clear-bridge-crash-history',
    resource: 'bridge',
    summary: `Cleared the recorded crash history for bridge ${existing.name}.`,
    metadata: {
      bridgeId: existing.id,
      bridgeName: existing.name,
      clearedCrashCount: existing.recentCrashCount,
      clearedLastCrashAt: existing.lastCrashAt?.toISOString() ?? null
    }
  })

  broadcastBridgesChanged(workspaceId)
  response.json(bridgeResponseSchema.parse({ bridge: toBridgeSummary(bridge) }))
})

bridgesRouter.post('/:id/test', async (request, response) => {
  requireRequestWorkspaceId(request)
  const bridgeId = requireRouteParam(request.params.id, 'id')
  const bridgeCount = await prisma.bridge.count({
    where: { id: bridgeId }
  })

  if (bridgeCount === 0) {
    throw notFound('Bridge not found.')
  }
  if (!bridgeSessionManager.isConnected(bridgeId)) {
    throw conflict('Bridge is not connected.')
  }

  const startedAt = Date.now()

  try {
    const result = bridgePingResultSchema.parse(await bridgeSessionManager.requestRpc(
      bridgeId,
      'bridge.ping',
      bridgePingParamsSchema.parse({ requestedAt: new Date().toISOString() }),
      { timeoutMs: 5_000 }
    ))

    response.json(bridgeTestResponseSchema.parse({
      respondedAt: result.respondedAt,
      responseTimeMs: Math.max(0, Date.now() - startedAt)
    }))
  } catch (error) {
    throw conflict(resolveBridgeTestErrorMessage(error))
  }
})

bridgesRouter.get('/:id/logs', async (request, response) => {
  requireRequestWorkspaceId(request)
  const bridgeId = requireRouteParam(request.params.id, 'id')
  const bridgeCount = await prisma.bridge.count({
    where: { id: bridgeId }
  })

  if (bridgeCount === 0) {
    throw notFound('Bridge not found.')
  }
  if (!bridgeSessionManager.isConnected(bridgeId)) {
    throw conflict('Bridge is not connected.')
  }

  const result = bridgeSystemLogsResultSchema.parse(await bridgeSessionManager.requestRpc(
    bridgeId,
    'system.logs',
    bridgeSystemLogsParamsSchema.parse({ limit: 1000 }),
    { timeoutMs: 10_000 }
  ))

  response.json(result)
})

/**
 * Debug traffic capture. Start/stop a bounded recording of the bridge↔printer
 * transport on the bridge, then download the buffered frames as newline-delimited
 * JSON. The capture lives on the bridge (see `apps/bridge/src/debug-capture.ts`);
 * these routes are thin RPC pass-throughs. The whole router is gated on
 * `SETTINGS_MANAGE_PERMISSION`, so no extra auth is needed here.
 */
async function requireConnectedWorkspaceBridge(request: express.Request): Promise<{ id: string; name: string }> {
  const workspaceId = requireRequestWorkspaceId(request)
  const bridgeId = requireRouteParam(request.params.id, 'id')
  const bridge = await prisma.bridge.findFirst({
    where: { id: bridgeId, workspaceId },
    select: { id: true, name: true }
  })
  if (!bridge) {
    throw notFound('Bridge not found.')
  }
  if (!bridgeSessionManager.isConnected(bridge.id)) {
    throw conflict('Bridge is not connected.')
  }
  return bridge
}

bridgesRouter.post('/:id/debug-capture/start', async (request, response) => {
  const bridge = await requireConnectedWorkspaceBridge(request)
  const params = bridgeDebugCaptureStartParamsSchema.parse(request.body ?? {})
  const result = bridgeDebugCaptureStatusResultSchema.parse(await bridgeSessionManager.requestRpc(
    bridge.id,
    'debug.capture.start',
    params,
    { timeoutMs: 10_000 }
  ))
  annotateRequestAuditLog(request, {
    action: 'start-bridge-debug-capture',
    resource: 'bridge',
    summary: `Started debug traffic capture on bridge ${bridge.name}.`,
    metadata: { bridgeId: bridge.id, bridgeName: bridge.name }
  })
  response.json(result)
})

bridgesRouter.post('/:id/debug-capture/stop', async (request, response) => {
  const bridge = await requireConnectedWorkspaceBridge(request)
  const result = bridgeDebugCaptureStatusResultSchema.parse(await bridgeSessionManager.requestRpc(
    bridge.id,
    'debug.capture.stop',
    bridgeDebugCaptureStopParamsSchema.parse({}),
    { timeoutMs: 10_000 }
  ))
  annotateRequestAuditLog(request, {
    action: 'stop-bridge-debug-capture',
    resource: 'bridge',
    summary: `Stopped debug traffic capture on bridge ${bridge.name}.`,
    metadata: { bridgeId: bridge.id, bridgeName: bridge.name }
  })
  response.json(result)
})

bridgesRouter.get('/:id/debug-capture/download', async (request, response) => {
  const bridge = await requireConnectedWorkspaceBridge(request)
  const capture = bridgeDebugCaptureReadResultSchema.parse(await bridgeSessionManager.requestRpc(
    bridge.id,
    'debug.capture.read',
    bridgeDebugCaptureReadParamsSchema.parse({}),
    { timeoutMs: 30_000 }
  ))

  const header = {
    kind: 'capture-meta',
    bridgeId: bridge.id,
    bridgeName: bridge.name,
    startedAt: capture.startedAt,
    stoppedAt: capture.stoppedAt,
    frameCount: capture.frames.length,
    droppedFrames: capture.droppedFrames,
    truncated: capture.truncated,
    exportedAt: new Date().toISOString()
  }
  const lines = [header, ...capture.frames].map((entry) => JSON.stringify(entry))

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeName = bridge.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'bridge'
  response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  response.setHeader('Content-Disposition', `attachment; filename="traffic-${safeName}-${stamp}.jsonl"`)
  response.send(`${lines.join('\n')}\n`)
})

/**
 * On-disk bridge backups. The bridge owns the snapshots and the schedule (see
 * `apps/bridge/src/backup-manager.ts`); these routes are thin RPC pass-throughs
 * like the debug-capture trio. `run` only STARTS a backup — completion arrives
 * as a pushed `bridge.backup.status` message broadcast over the `bridge.backup`
 * WS event.
 */
bridgesRouter.get('/:id/backups', async (request, response) => {
  const bridge = await requireConnectedWorkspaceBridge(request)
  const result = bridgeBackupListResultSchema.parse(await bridgeSessionManager.requestRpc(
    bridge.id,
    'bridge.backup.list',
    bridgeBackupListParamsSchema.parse({}),
    { timeoutMs: 15_000 }
  ))
  response.json(bridgeBackupListResponseSchema.parse({
    status: getBridgeBackupStatus(bridge.id),
    snapshots: result.snapshots
  }))
})

bridgesRouter.post('/:id/backups/run', async (request, response) => {
  const bridge = await requireConnectedWorkspaceBridge(request)
  const status = bridgeBackupStatusResultSchema.parse(await bridgeSessionManager.requestRpc(
    bridge.id,
    'bridge.backup.run',
    bridgeBackupRunParamsSchema.parse({}),
    { timeoutMs: 15_000 }
  ))
  // Keep the mirror current immediately: the bridge's own status push races
  // this response, and the UI refetches the bridge list on mutation success.
  setBridgeBackupStatus(bridge.id, status)
  annotateRequestAuditLog(request, {
    action: 'run-bridge-backup',
    resource: 'bridge',
    summary: `Started a backup on bridge ${bridge.name}.`,
    metadata: { bridgeId: bridge.id, bridgeName: bridge.name }
  })
  response.json(status)
})

bridgesRouter.post('/:id/update/check', async (request, response) => {
  const bridge = await loadWorkspaceBridgeForUpdate(request)
  if (isSelfHostedDeployment()) {
    response.json(bridgeUpdateActionResponseSchema.parse({
      accepted: false,
      status: 'current',
      message: SELF_HOSTED_BUNDLE_UPDATE_MESSAGE
    }))
    return
  }
  const checkedAt = new Date()
  const update = buildBridgeUpdateSummary({
    ...bridge,
    lastUpdateCheckAt: checkedAt,
    lastUpdateError: null
  })

  await prisma.bridge.update({
    where: { id: bridge.id },
    data: {
      updateStatus: update.status,
      lastUpdateCheckAt: checkedAt,
      lastUpdateError: null
    }
  })

  response.json(bridgeUpdateActionResponseSchema.parse({
    accepted: false,
    status: update.status,
    message: update.status === 'current' ? 'Bridge is current.' : 'Bridge update status refreshed.'
  }))
})

bridgesRouter.post('/:id/update/start', async (request, response) => {
  const bridge = await loadWorkspaceBridgeForUpdate(request)
  if (isSelfHostedDeployment()) {
    response.json(bridgeUpdateActionResponseSchema.parse({
      accepted: false,
      status: 'current',
      message: SELF_HOSTED_BUNDLE_UPDATE_MESSAGE
    }))
    return
  }
  const update = buildBridgeUpdateSummary(bridge)
  if (update.status === 'imageUpdateRequired' || update.status === 'runnerUpdateRequired') {
    response.json(bridgeUpdateActionResponseSchema.parse({
      accepted: false,
      status: update.status,
      message: update.manualUpdateCommand
        ? `Manual bridge update required: ${update.manualUpdateCommand}`
        : 'Manual bridge update required.'
    }))
    return
  }

  if (!bridgeSessionManager.isConnected(bridge.id)) {
    throw conflict('Bridge is not connected.')
  }

  const result = bridgeUpdateActionResultSchema.parse(await bridgeSessionManager.requestRpc(
    bridge.id,
    'bridge.update.install',
    bridgeUpdateInstallParamsSchema.parse({ requestedAt: new Date().toISOString() }),
    { timeoutMs: 30_000 }
  ))

  await prisma.bridge.update({
    where: { id: bridge.id },
    data: {
      updateStatus: result.status,
      lastUpdateCheckAt: new Date(),
      lastUpdateError: result.accepted || result.status === 'current' ? null : result.message
    }
  })

  annotateRequestAuditLog(request, {
    action: 'start-bridge-update',
    resource: 'bridge',
    summary: `Started bridge update to ${bridge.latestAvailableVersion ?? 'the latest version'}.`,
    metadata: {
      bridgeId: bridge.id,
      currentVersion: bridge.version,
      targetVersion: bridge.latestAvailableVersion,
      accepted: result.accepted,
      status: result.status
    }
  })

  response.json(bridgeUpdateActionResponseSchema.parse(result))
})

bridgesRouter.delete('/:id', async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  const bridgeId = requireRouteParam(request.params.id, 'id')
  const bridge = await rootPrisma.bridge.findUnique({
    where: { id: bridgeId },
    select: {
      id: true,
      name: true,
      workspaceId: true
    }
  })

  if (!bridge || bridge.workspaceId !== workspaceId) {
    throw notFound('Bridge not found.')
  }

  annotateRequestAuditLog(request, {
    action: 'remove-bridge',
    resource: 'bridge',
    summary: `Removed bridge ${bridge.name} from this workspace.`,
    metadata: {
      bridgeId: bridge.id,
      bridgeName: bridge.name
    }
  })

  const attachedPrinters = await prisma.printer.findMany({
    where: { bridgeId },
    orderBy: { position: 'asc' }
  })

  await rootPrisma.$transaction(async (transaction) => {
    await transaction.printer.updateMany({
      where: {
        workspaceId,
        bridgeId
      },
      data: { bridgeId: null }
    })
    await transaction.bridge.update({
      where: { id: bridgeId },
      data: { workspaceId: null }
    })
  })

  for (const printer of attachedPrinters) {
    printerManager.update(toPrinterDto({ ...printer, bridgeId: null }), workspaceId, null)
  }

  if (bridgeSessionManager.setWorkspaceId(bridgeId, null)) {
    bridgeSessionManager.sendMessage(bridgeId, {
      type: 'bridge.welcome',
      bridgeId,
      connected: false,
      workspaceId: null,
      heartbeatIntervalSeconds: BRIDGE_HEARTBEAT_INTERVAL_SECONDS
    })
  }

  await syncBridgePrinterConfig(bridgeId)
  broadcastBridgesChanged(workspaceId)
  broadcastPrinterViewsChanged(workspaceId)
  response.status(204).end()
})

function toBridgeSummary(bridge: {
  id: string
  name: string
  version: string | null
  releaseFingerprint: string | null
  buildRevision: string | null
  sourceFingerprint: string | null
  protocolVersion: number | null
  runnerAbiVersion: string | null
  updateChannel: string | null
  updateStatus: string | null
  latestAvailableVersion: string | null
  lastUpdateCheckAt: Date | null
  lastUpdateError: string | null
  lastSeenAt: Date | null
  lastCrashAt?: Date | null
  lastCrashReason?: string | null
  recentCrashCount?: number
  createdAt: Date
  updatedAt: Date
  _count: {
    printers: number
  }
}) {
  return {
    id: bridge.id,
    name: bridge.name,
    printerCount: bridge._count.printers,
    lastSeenAt: bridge.lastSeenAt?.toISOString() ?? null,
    createdAt: bridge.createdAt.toISOString(),
    updatedAt: bridge.updatedAt.toISOString(),
    connectionStats: bridgeSessionManager.getConnectionStats(bridge.id),
    update: buildBridgeUpdateSummary(bridge),
    debugCapture: getBridgeDebugCaptureStatus(bridge.id),
    backup: getBridgeBackupStatus(bridge.id),
    crash: {
      lastCrashAt: bridge.lastCrashAt?.toISOString() ?? null,
      recentCrashCount: bridge.recentCrashCount ?? 0,
      lastReason: bridge.lastCrashReason ?? null
    }
  }
}

function resolveBridgeTestErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Bridge test failed.'
  }
  if (error.message.includes('timed out')) {
    return 'Bridge test timed out.'
  }
  if (error.message.includes('disconnected')) {
    return 'Bridge disconnected during the test.'
  }
  return `Bridge test failed: ${error.message}`
}

async function loadWorkspaceBridgeForUpdate(request: express.Request) {
  requireRequestWorkspaceId(request)
  const bridgeId = requireRouteParam(request.params.id, 'id')
  const bridge = await prisma.bridge.findUnique({
    where: { id: bridgeId },
    select: {
      id: true,
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
      lastUpdateError: true
    }
  })
  if (!bridge) {
    throw notFound('Bridge not found.')
  }
  return bridge
}