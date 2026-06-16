/**
 * Outbound bridge session server.
 *
 * Handles the long-lived WebSocket connections initiated by bridge
 * runtimes. Each session authenticates with the bridge runtime token,
 * then carries RPC traffic and status snapshots back to the API.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import {
  bridgeRuntimeInboundMessageSchema,
  type BridgeRuntimeInboundMessage
} from '@printstream/shared'
import { rootPrisma } from './prisma.js'
import { recoverBridgePrinterAssignments } from './bridge-assignment-recovery.js'
import { bridgeRuntimeTokenMatches } from './bridge-runtime-auth.js'
import { syncBridgePrinterConfig } from './bridge-printer-config.js'
import { bridgeSessionManager } from './bridge-session-manager.js'
import {
  clearBridgeDebugCaptureStatus,
  setBridgeDebugCaptureStatus
} from './bridge-debug-capture.js'
import { inactiveBridgeDebugCaptureStatus } from '@printstream/shared'
import { printerDiscovery } from './printer-discovery.js'
import { printerManager } from './printer-manager.js'
import { wsBroadcaster } from './ws-server.js'
import { broadcastBridgesChanged, broadcastPrinterViewsChanged } from './ws-resource-events.js'

const CONNECT_PATH = '/api/bridge-runtime/connect'
const HELLO_TIMEOUT_MS = 5_000
const BRIDGE_LAST_SEEN_UPDATE_INTERVAL_MS = 60_000

export interface AttachedBridgeSessionServer {
  close(): Promise<void>
}

export function attachBridgeSessionServer(server: HttpServer): AttachedBridgeSessionServer {
  const wss = new WebSocketServer({ noServer: true })
  let closed = false

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = request.url?.split('?')[0]
    if (url !== CONNECT_PATH) {
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws)
    })
  }

  server.on('upgrade', handleUpgrade)

  wss.on('connection', (socket) => {
    let authenticatedBridgeId: string | null = null
    let authenticatedConnection: Parameters<typeof bridgeSessionManager.registerConnection>[0] | null = null
    let lastHeartbeatPersistedAtMs = 0
    const helloTimer = setTimeout(() => {
      socket.close(4001, 'bridge hello timeout')
    }, HELLO_TIMEOUT_MS)
    const takeHeartbeatLastSeenAt = (): Date | null => {
      const now = Date.now()
      if (lastHeartbeatPersistedAtMs !== 0 && now - lastHeartbeatPersistedAtMs < BRIDGE_LAST_SEEN_UPDATE_INTERVAL_MS) {
        return null
      }
      lastHeartbeatPersistedAtMs = now
      return new Date(now)
    }

    socket.on('message', (data) => {
      const message = parseBridgeMessage(data)
      if (!message) return

      if (!authenticatedBridgeId) {
        if (message.type !== 'bridge.hello') {
          socket.close(4002, 'bridge hello required')
          return
        }

        void authenticateBridgeHello(socket, message).then((context) => {
          if (!context) return
          clearTimeout(helloTimer)
          lastHeartbeatPersistedAtMs = Date.now()
          authenticatedBridgeId = context.bridgeId
          authenticatedConnection = {
            bridgeId: context.bridgeId,
            tenantId: context.tenantId,
            send(outboundMessage) {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(outboundMessage))
              }
            },
            close(code, reason) {
              socket.close(code, reason)
            }
          }
          bridgeSessionManager.registerConnection(authenticatedConnection)
          socket.send(JSON.stringify({
            type: 'bridge.welcome',
            bridgeId: context.bridgeId,
            connected: context.tenantId != null,
            tenantId: context.tenantId,
            heartbeatIntervalSeconds: 15
          }))
          void recoverAndSyncBridgePrinters(context.bridgeId, context.tenantId)
        }).catch((error) => {
          console.warn('[bridge-session] hello handling failed', (error as Error).message)
          socket.close(4003, 'bridge authentication failed')
        })
        return
      }

      handleAuthenticatedMessage(
        authenticatedBridgeId,
        authenticatedConnection?.tenantId ?? null,
        message,
        takeHeartbeatLastSeenAt
      )
    })

    socket.on('close', () => {
      clearTimeout(helloTimer)
      if (authenticatedBridgeId) {
        const tenantId = authenticatedConnection?.tenantId ?? null
        const clearedPrinterIds = bridgeSessionManager.clearBridgePrinterFtpActivity(authenticatedBridgeId)
        clearBridgeDebugCaptureStatus(authenticatedBridgeId)
        if (tenantId) {
          for (const printerId of clearedPrinterIds) {
            wsBroadcaster.broadcast({ type: 'printer.ftps.active', printerId, active: false }, tenantId)
          }
          // A disconnected bridge can no longer be controlled or report capture
          // progress; clear the banner. It re-announces on reconnect.
          wsBroadcaster.broadcast(
            { type: 'bridge.debug.capture', bridgeId: authenticatedBridgeId, status: inactiveBridgeDebugCaptureStatus },
            tenantId
          )
          broadcastBridgesChanged(tenantId)
        }
        bridgeSessionManager.unregisterConnection(authenticatedBridgeId, authenticatedConnection ?? undefined)
        printerDiscovery.clearBridge(authenticatedBridgeId)
        printerManager.markBridgeDisconnected(authenticatedBridgeId)
      }
    })
  })

  return {
    async close(): Promise<void> {
      if (closed) return
      closed = true
      server.off('upgrade', handleUpgrade)
      for (const socket of wss.clients) {
        socket.terminate()
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve())
      })
    }
  }
}

function parseBridgeMessage(data: WebSocket.RawData): BridgeRuntimeInboundMessage | null {
  const text = typeof data === 'string' ? data : data.toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const result = bridgeRuntimeInboundMessageSchema.safeParse(parsed)
  return result.success ? result.data : null
}

async function authenticateBridgeHello(
  socket: WebSocket,
  message: Extract<BridgeRuntimeInboundMessage, { type: 'bridge.hello' }>
): Promise<{ bridgeId: string; tenantId: string | null } | null> {
  const bridge = await rootPrisma.bridge.findUnique({
    where: { id: message.bridgeId },
    select: {
      id: true,
      tenantId: true,
      version: true,
      releaseFingerprint: true,
      buildRevision: true,
      sourceFingerprint: true,
      protocolVersion: true,
      runnerAbiVersion: true,
      updateChannel: true,
      runtimeTokenHash: true
    }
  })

  if (!bridge || !bridgeRuntimeTokenMatches(message.runtimeToken, bridge.runtimeTokenHash)) {
    socket.close(4003, 'bridge authentication failed')
    return null
  }

  await rootPrisma.bridge.update({
    where: { id: bridge.id },
    data: {
      lastSeenAt: new Date(),
      ...(message.version ? { version: message.version } : {}),
      ...(message.releaseFingerprint ? { releaseFingerprint: message.releaseFingerprint } : {}),
      ...(message.buildRevision ? { buildRevision: message.buildRevision } : {}),
      // "Don't know" must not preserve a stale value: a bridge whose image
      // changed underneath it (rebuild while running an activated bundle)
      // would otherwise be pinned to the old image fingerprint forever.
      sourceFingerprint: message.sourceFingerprint ?? null,
      ...(message.protocolVersion != null ? { protocolVersion: message.protocolVersion } : {}),
      ...(message.runnerAbiVersion ? { runnerAbiVersion: message.runnerAbiVersion } : {}),
      updateStatus: null,
      latestAvailableVersion: null,
      lastUpdateCheckAt: new Date(),
      lastUpdateError: null
    }
  })
  if (bridge.tenantId) {
    broadcastBridgesChanged(bridge.tenantId)
  }

  return {
    bridgeId: bridge.id,
    tenantId: bridge.tenantId
  }
}

function handleAuthenticatedMessage(
  bridgeId: string,
  tenantId: string | null,
  message: BridgeRuntimeInboundMessage,
  takeHeartbeatLastSeenAt: () => Date | null
): void {
  switch (message.type) {
    case 'bridge.heartbeat': {
      const lastSeenAt = takeHeartbeatLastSeenAt()
      if (!lastSeenAt) return
      void rootPrisma.bridge.update({
        where: { id: bridgeId },
        data: { lastSeenAt }
      }).catch((error) => {
        console.warn(`[bridge-session] heartbeat lastSeenAt write failed for bridge ${bridgeId}`, (error as Error).message)
      })
      return
    }
    case 'bridge.rpc.success': {
      bridgeSessionManager.resolveRpcSuccess(message.id, message.result)
      return
    }
    case 'bridge.rpc.progress': {
      bridgeSessionManager.resolveRpcProgress(message.id, message.bytesSent, message.totalBytes ?? null)
      return
    }
    case 'bridge.rpc.error': {
      bridgeSessionManager.resolveRpcError(message.id, message.error)
      return
    }
    case 'bridge.camera.frame': {
      bridgeSessionManager.handleCameraFrame(bridgeId, message.printerId, message.jpegBase64)
      return
    }
    case 'bridge.printer.ftps.active': {
      const changed = bridgeSessionManager.setPrinterFtpActivity(bridgeId, message.printerId, message.active)
      if (changed && tenantId) {
        wsBroadcaster.broadcast({ type: 'printer.ftps.active', printerId: message.printerId, active: message.active }, tenantId)
      }
      return
    }
    case 'bridge.printer.report': {
      printerManager.ingestBridgeReport(message.printerId, message.report)
      return
    }
    case 'bridge.printer.discovered': {
      printerDiscovery.setBridgePrinters(bridgeId, message.printers)
      if (tenantId) {
        void recoverAndSyncBridgePrinters(bridgeId, tenantId)
      }
      return
    }
    case 'bridge.printer.offline': {
      printerManager.markBridgePrinterOffline(message.printerId)
      return
    }
    case 'bridge.printer.connection': {
      printerManager.ingestBridgeConnectionValidation(message.printerId, message.validation)
      return
    }
    case 'bridge.printer.status': {
      bridgeSessionManager.setPrinterStatus(bridgeId, message.printer)
      printerManager.ingestBridgeStatus(message.printer)
      return
    }
    case 'bridge.printer.removed': {
      bridgeSessionManager.removePrinterStatus(message.printerId)
      return
    }
    case 'bridge.debug.capture.status': {
      setBridgeDebugCaptureStatus(bridgeId, message.status)
      if (tenantId) {
        wsBroadcaster.broadcast({ type: 'bridge.debug.capture', bridgeId, status: message.status }, tenantId)
      }
      return
    }
    case 'bridge.hello': {
      return
    }
  }
}

async function recoverAndSyncBridgePrinters(bridgeId: string, tenantId: string | null): Promise<void> {
  const recoveredPrinters = tenantId
    ? await recoverBridgePrinterAssignments({ bridgeId, tenantId })
    : []
  await syncBridgePrinterConfig(bridgeId)
  if (tenantId && recoveredPrinters.length > 0) {
    broadcastPrinterViewsChanged(tenantId)
  }
}